// `--except` / `--only` for the team-scoped session verbs (attach, detach,
// down, up, stop). Port of lib.sh's `tap_except_*` / `tap_only_*` /
// `tap_select_*` / `tap_crew_select_gate` family (tap-nt4c, tap-sttl).
//
// All lifecycle callers now share this native parser and predicate.
// Team up passes the positive set to launcher for its candidate census.
//
// THE COMPLEMENT IS NEVER PRECOMPUTED. Resolving "roster minus only-set" at
// parse time froze an answer derived from ONE registry read, while every verb
// re-reads the registry (or a session snapshot) later to build its plan. A seat
// that registered in that window was absent from the frozen complement, so it
// was not spared — and under --only, a seat the operator never named being
// ACTED ON is the whole failure the flag exists to prevent.
// So the set stays POSITIVE and `spared()` is asked per row,
// against whatever snapshot the verb is actually acting on.
//
// `mode`/`typed` exist for RECEIPTS ONLY — never for behavior. The typed set is
// what an operator recognizes; the EFFECTIVE spared set is accumulated during
// planning, which is the only place it can honestly be known.

import { TapError } from "../context";
import { loadRegistry, seatMap, type Seat } from "../registry";
import { validToken } from "../ids";

export type SelectMode = "" | "--except" | "--only";

export interface Selection {
  /** The flag the operator typed; "" when no selection flag was given. */
  mode: SelectMode;
  /** Handles named by --except, in typed order, deduped (design call 5). */
  except: string[];
  /** Handles named by --only, in typed order, deduped. */
  only: string[];
}

export function noSelection(): Selection {
  return { mode: "", except: [], only: [] };
}

function fail(verb: string, klass: string, action: string, detail: string): never {
  throw new TapError(1, klass, action, detail, `tap ${verb}`);
}

/**
 * Parse the comma list. `verb` is the bare verb ("team attach") for help/usage
 * text; the error line's own label carries the "tap " prefix.
 *
 * The flag word is a PARAMETER because --only reuses this tokenizer verbatim.
 * Hardcoding "--except" would refuse an --only typo by naming a flag the
 * operator never typed — correct about the fault and wrong about where to fix
 * it.
 */
export function parseSelection(verb: string, raw: string, flag: "--except" | "--only" = "--except"): Selection {
  const usage = `tap ${verb} ${flag} <handle>[,<handle>...]`;
  // What the handles DO differs by flag, so the guidance half of each refusal
  // does too. Deriving this from the flag string would produce "name a handle
  // to only".
  const what = flag === "--only" ? "act on" : "spare";
  // Design call 3: an empty value is a usage error, never "exclude nothing".
  if (!raw) fail(verb, "usage_error", usage, `${flag} was given an empty value; name at least one handle to ${what}`);
  const handles: string[] = [];
  // Trailing sentinel comma so the LAST token goes through the same emptiness
  // check as the middle ones ("a," and "a,,b" are both usage errors).
  let rest = `${raw},`;
  while (rest.length > 0) {
    const comma = rest.indexOf(",");
    const tok = rest.slice(0, comma);
    rest = rest.slice(comma + 1);
    if (!tok) fail(verb, "usage_error", usage, `${flag} '${raw}' has an empty handle between commas`);
    // Design call 7: these verbs are team-scoped, so a qualified target is a
    // usage error rather than a silently-unmatched handle.
    if (tok.includes("/") || tok.includes(":")) {
      fail(verb, "usage_error", usage, `${flag} takes bare handles from THIS team; '${tok}' is team-qualified`);
    }
    if (!validToken(tok)) fail(verb, "usage_error", usage, `${flag} handle '${tok}' fails charset ^[A-Za-z0-9][A-Za-z0-9._-]*$`);
    if (handles.includes(tok)) fail(verb, "usage_error", usage, `${flag} repeats handle '${tok}'`);
    handles.push(tok);
  }
  return flag === "--only"
    ? { mode: "--only", except: [], only: handles }
    : { mode: "--except", except: handles, only: [] };
}

export interface OptionalSelectionScan {
  /** The selector is present and needs interactive choices when value is absent. */
  pending?: "--only" | "--except";
  selection: Selection;
  /** Original argv without the selector and its supplied value. */
  rest: string[];
}

/**
 * Shared preparse for human team verbs. A selector consumes an ordinary next
 * token, even when it resembles a team name; only another option or argv end
 * requests a picker. Validate the whole selector grammar before any UI.
 */
export function scanOptionalSelection(verb: string, argv: readonly string[]): OptionalSelectionScan {
  let mode: "--only" | "--except" | undefined;
  let selection = noSelection();
  let pending: "--only" | "--except" | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg !== "--only" && arg !== "--except") {
      if (pending && !arg.startsWith("-")) {
        fail(verb, "usage_error", `tap ${verb} [<team>] ${pending}`,
          `team target must precede an omitted ${pending} value; '${arg}' appears after the selector`);
      }
      rest.push(arg); continue;
    }
    if (mode) {
      if (mode !== arg) selectConflictGate(verb);
      fail(verb, "usage_error", `tap ${verb} [--only <handles> | --except <handles>]`, `${arg} was given more than once`);
    }
    mode = arg;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("-")) {
      pending = arg;
      continue;
    }
    selection = parseSelection(verb, next, arg);
    i++;
  }
  return { pending, selection, rest };
}

/** Refuse --only and --except together: they are complements, never composable. */
export function selectConflictGate(verb: string): never {
  fail(verb, "usage_error", `tap ${verb} [--only <handles> | --except <handles>]`,
    `tap ${verb} takes --only or --except, never both: they are complements, so naming both states the selection twice and the two statements can disagree`);
}

/** The typed handles of whichever flag was given. */
export function selectedHandles(selection: Selection): string[] {
  return selection.mode === "--only" ? selection.only : selection.except;
}

/**
 * Design call 2: fail loud, naming BOTH the handle that matched nothing and
 * the live roster it was matched against. A typo that silently stops the one
 * seat the operator meant to spare is the whole reason this flag is not
 * best-effort.
 *
 * `error_class=not_found` is the repo's ONE spelling for "no seat answers to
 * that name" (tap attach <unknown>, tap team detach --handle <unknown>).
 */
export function rosterGate(verb: string, selection: Selection, roster: readonly string[]): void {
  const flag = selection.mode || "--except";
  const named = selectedHandles(selection);
  if (named.length === 0) return;
  const known = new Set(roster);
  const unknown = named.filter(h => !known.has(h));
  if (unknown.length === 0) return;
  fail(verb, "not_found", "tap team",
    `tap ${verb} ${flag} names no seat on this team: ${unknown.join(", ")}; roster: ${roster.length ? roster.join(", ") : "(none)"}`);
}

/** Python's `sorted()` over str: code-point order, not UTF-16 unit order. */
export function codePointCompare(a: string, b: string): number {
  const ai = a[Symbol.iterator](), bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next(), y = bi.next();
    if (x.done && y.done) return 0;
    if (x.done) return -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0)!, cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

/**
 * The registry's seat rows, read the way the incumbent's Python did: a missing,
 * unparseable or non-object file is an EMPTY map, not a refusal. Every caller
 * of this is a gate that then refuses on the empty answer ("roster: (none)",
 * no crew rows to match), so the softness is fail-closed at the caller.
 */
export function lenientSeats(registryPath: string | undefined): Record<string, Seat> {
  if (!registryPath) return {};
  let doc;
  try {
    doc = loadRegistry(registryPath);
  } catch {
    return {};
  }
  return seatMap(doc);
}

/**
 * The roster every selection handle is matched against: the acting registry's
 * own seat keys, sorted. ONE definition for every verb, so `--except fable`
 * means the same thing whichever verb reads it. Empty when the registry is
 * absent or unreadable — the gate then refuses with "roster: (none)", which is
 * the honest answer rather than a silent pass.
 */
export function registryRoster(registryPath: string | undefined): string[] {
  const seats = lenientSeats(registryPath);
  return Object.keys(seats)
    .filter(handle => handle.length > 0 && isRow(seats[handle]))
    .sort(codePointCompare);
}

function isRow(value: unknown): value is Seat {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Crew rows are not sparable units for session verbs. A crew handle in --only
 * is a usage error (use tap crew remove); in --except it is also a usage error
 * (sparing crew is not meaningful because crew dies with its parent).
 */
export function crewSelectGate(verb: string, selection: Selection, registryPath: string | undefined): void {
  const named = selectedHandles(selection);
  if (named.length === 0) return;
  const seats = lenientSeats(registryPath);
  const handles = Object.keys(seats).sort(codePointCompare);
  const selected = new Set(named);
  for (const handle of handles) {
    const ent = seats[handle];
    if (!isRow(ent) || ent.crew !== true) continue;
    if (!selected.has(handle)) continue;
    const session = str(ent.session);
    let parent = "";
    for (const h2 of handles) {
      const e2 = seats[h2];
      if (isRow(e2) && !e2.crew && str(e2.session) === session) { parent = h2; break; }
    }
    let action = `tap crew remove ${handle}`;
    if (parent) action = `${action} (parent: ${parent})`;
    fail(verb, "usage_error", action,
      `tap ${verb}: '${handle}' is crew, not an independent seat; use tap crew remove to dismiss it`);
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * THE selection predicate: is this seat spared? Every verb asks this per row,
 * at plan time, so the answer reflects the rows the verb is about to act on.
 *   --except -> spared when NAMED
 *   --only   -> spared when NOT named
 */
export function spared(handle: string, selection: Selection): boolean {
  if (selection.mode === "--only") return !selection.only.includes(handle);
  return selection.except.includes(handle);
}

/** "Was a selection flag given at all?" — the mode-aware form. */
export function selectAny(selection: Selection): boolean {
  return selection.except.length > 0 || selection.only.length > 0;
}

/** The flag the operator actually typed, for message text; --except by default. */
export function selectFlag(selection: Selection): string {
  return selection.mode || "--except";
}

/** The list the operator actually typed, "a, b". */
export function selectTyped(selection: Selection): string {
  return selectedHandles(selection).join(", ");
}

/**
 * Receipt tail. Each form carries its OWN leading separator, so the caller
 * concatenates with no space of its own. A caller that computed its own spared
 * list (attach, which can only spare seats present in the snapshot) passes it.
 */
export function selectOperand(selection: Selection, computed?: string): string {
  if (selection.mode === "--only") return ` ${selectTyped(selection)} — every other seat`;
  return `: ${computed ?? selection.except.join(", ")}`;
}

/** The selector alone: "--except" or "--only kimi,grok". */
export function selectLabel(selection: Selection): string {
  return selection.mode === "--only" ? `--only ${selectTyped(selection)}` : "--except";
}

/** The "no seats matched after ..." clause, which has a different cause per flag. */
export function selectSummary(selection: Selection): string {
  if (selection.mode === "--only") return `selection (--only: ${selectTyped(selection)})`;
  return `exclusions (excluded: ${selection.except.join(", ")})`;
}

/** The newline-terminated blob the incumbent handed its planners. */
export function selectionBlob(handles: readonly string[]): string {
  return handles.map(h => `${h}\n`).join("");
}
