// The acting team registry — `<team-root>/.tap/team-registry.json`.
//
// It is AUTHORITY, not observed liveness: the row decides membership and routing,
// while tmux probes decide whether its recorded pane is live now.
//
// Every byte written here is read by the incumbent bash tap during the oracle's
// interop arms, so the field set, the JSON formatting, and the resolution rules
// are matched to it rather than chosen.

import { readFileSync, statSync } from "node:fs";
import { enrolledTeams, loadGlobalRegistry } from "./index-home";
import { atomicWrite, ensureAscii } from "./fsatomic";
import { isFile } from "./watch-lease";
import { pyReadUtf8 } from "./spool-publication";
import { OldStoreError, teamRegistryRefusal } from "./register-authority";

export const SCHEMA = "0.20";

export type Seat = Record<string, unknown>;
export type RegistryDoc = Record<string, unknown>;

/**
 * Load a registry, REFUSING any numeric form JavaScript cannot represent
 * faithfully — checked against the RAW LEXEME, before JSON.parse collapses it.
 *
 * This is the only place the check can live. By the time a value reaches the
 * serializer the damage is done and undetectable:
 *
 *     raw 9007199254740993  -> JS 9007199254740992   (silently rounded)
 *     raw 1.0               -> JS 1                  (float-ness gone)
 *     raw -0                -> JS -0                 (indistinguishable from -0.0)
 *
 * python preserves all three. The first is VALUE LOSS, not byte drift: a
 * registry round-tripped through this implementation would come out holding a
 * different number, and nothing downstream could tell.
 *
 * So the declared value domain is enforced rather than announced: canonical safe
 * integers and nothing else. `-0` normalizes to `0`, matching python's own
 * load/dump. A decimal, an exponent, or an unsafe integer is REFUSED with the
 * lexeme in the message — an honest refusal beats a silent rounding, and TAP's
 * live schema contains no float in any seat row, so nothing legitimate is lost.
 */
export function loadRegistry(path: string): RegistryDoc {
  if (!isFile(path)) return {};
  // The 3-argument reviver (ES2025 "JSON source text access", live in bun 1.3.8)
  // is not in this TypeScript lib yet, so the callback is typed locally rather
  // than by loosening the whole file.
  type SourceReviver = (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown;
  const reviver: SourceReviver = function (key, value, context) {
    if (typeof value !== "number") return value;
    // `source` is the raw lexeme as written on disk. Without it the
    // distinctions above are already gone by the time we are called.
    const raw = context?.source;
    if (raw === undefined) return value;
    // The refusal names the FIELD and the value (leader ruling, 2026-09-16
    // 06:13Z): an operator reading it must be able to find the byte, not just
    // learn that one exists somewhere in the file.
    if (!/^-?(0|[1-9][0-9]*)$/.test(raw)) {
      throw new Error(
        `registry: number '${raw}' at field '${key}' is outside the supported value domain ` +
        `(canonical integers only) — JavaScript cannot round-trip it faithfully: ${path}`,
      );
    }
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `registry: integer '${raw}' at field '${key}' exceeds the safe-integer range and would be ` +
        `silently rounded to ${value}: ${path}`,
      );
    }
    // python loads/dumps raw `-0` as `0`; only the FLOAT `-0.0` keeps its sign,
    // and that form is refused above.
    return Object.is(value, -0) ? 0 : value;
  };
  const data: unknown = JSON.parse(pyReadUtf8(path), reviver as (k: string, v: unknown) => unknown);
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`registry state doc is not an object: ${path}`);
  }
  return data as RegistryDoc;
}

/** `loadRegistry` for a present team registry that must be current: an old format throws old_store. */
export function loadCurrentRegistry(path: string): RegistryDoc {
  const doc = loadRegistry(path);
  const refusal = isFile(path) ? teamRegistryRefusal(path, doc) : null;
  if (refusal) throw new OldStoreError(refusal.action, refusal.detail);
  return doc;
}

/**
 * Serialize exactly as python's `json.dump(..., indent=2, sort_keys=True)`, plus
 * the trailing newline. Unknown top-level sections round-trip untouched.
 *
 * WHY THIS IS HAND-ROLLED RATHER THAN JSON.stringify OVER A SORTED OBJECT — and
 * my first version WAS the latter, which is the instructive part:
 *
 *   1. INTEGER-LIKE KEYS. JavaScript objects enumerate array-index-like keys
 *      first, in NUMERIC order, no matter what order they were inserted. So
 *      building a sorted object and stringifying it emits {"2":…,"10":…} while
 *      python emits {"10":…,"2":…}. Sorting the keys does not help, because the
 *      object itself reorders them on the way out. A recursive "sorter" that
 *      hands its result to JSON.stringify is defeated by the host language after
 *      it has finished sorting. Emitting the string directly is the only way to
 *      control the order.
 *   2. NON-ASCII. python defaults to ensure_ascii=True. A handle or path holding
 *      a non-ASCII character serializes differently in the two implementations,
 *      and the registry is the widest interop surface there is.
 *
 * Neither shape appears in an ordinary seat row, which is exactly why they
 * survived: every test I wrote used ASCII handles and no numeric keys.
 */
export function saveRegistry(path: string, doc: RegistryDoc): void {
  atomicWrite(path, `${pyJson(supersedeForwardingAliases(doc), 0)}\n`);
}

/** A reused handle permanently retires its old new-address aliases, not custody. */
export function supersedeForwardingAliases(doc: RegistryDoc): RegistryDoc {
  if (!Array.isArray(doc.seat_forwardings)) return doc;
  const seats = seatMap(doc);
  for (const record of doc.seat_forwardings) {
    if (typeof record !== "object" || record === null || Array.isArray(record)) continue;
    if (typeof record.source === "string" && Object.hasOwn(seats, record.source)) {
      record.address_active = false;
      // Restoring the original incarnation returns its mail authority to that
      // row. Keep the edge as history, but never authorize two recipients.
      if (seats[record.source]?.instance === record.source_instance) record.custody_revoked = true;
    }
  }
  return doc;
}

/**
 * Python's `sorted()` compares strings by CODE POINT. JavaScript's default
 * `Array.sort` compares by UTF-16 CODE UNIT, and the two disagree for every
 * astral character: a surrogate pair starts at 0xD800, so it sorts BELOW the
 * private-use area (0xE000+) in JS and ABOVE it in python. Verified —
 * python emits U+E000 before U+10000; JS sort emits U+10000 first.
 *
 * `localeCompare` is not the fix either: it is locale-dependent by definition,
 * which is a different wrong answer that also varies by machine. Comparing
 * code-point arrays is the only spelling that matches.
 */
function byCodePoint(a: string, b: string): number {
  const ca = Array.from(a, (c) => c.codePointAt(0)!);
  const cb = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
    if (ca[i] !== cb[i]) return ca[i]! - cb[i]!;
  }
  return ca.length - cb.length;
}

/** python's json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=True). */
export function pyJson(v: unknown, depth: number): string {
  const pad = "  ".repeat(depth);
  const padIn = "  ".repeat(depth + 1);

  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return `[\n${v.map((x) => padIn + pyJson(x, depth + 1)).join(",\n")}\n${pad}]`;
  }
  if (typeof v === "object" && v !== null) {
    // Keys are collected and sorted HERE and emitted directly; they are never
    // put back into an object, which is where JS would reorder them.
    const keys = Object.keys(v as Record<string, unknown>).sort(byCodePoint);
    if (keys.length === 0) return "{}";
    const body = keys
      .map((k) => `${padIn}${pyStr(k)}: ${pyJson((v as Record<string, unknown>)[k], depth + 1)}`)
      .join(",\n");
    return `{\n${body}\n${pad}}`;
  }
  if (typeof v === "string") return pyStr(v);
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return pyNumber(v);
  // A bigint only ever arrives here from parsePreservingBigint's reviver (an
  // unknown-extension field JS numbers cannot hold safely) — an unmodified
  // passthrough value, not a value this file itself produces.
  if (typeof v === "bigint") return v.toString();
  // An unsupported value type is REFUSED rather than coerced. `String(v)` would
  // happily emit `undefined` or `[object Object]` into a registry the incumbent
  // then has to parse.
  throw new Error(`registry: unsupported value type '${typeof v}' — the registry value domain is string|number|boolean|null|object|array`);
}

/**
 * `JSON.parse` with a reviver that widens any integer lexeme JS cannot hold
 * safely into a `bigint`, instead of `loadRegistry`'s refusal — for bridging
 * an opaque unknown-extension value (tap-kwjba: an unrelated large integer
 * riding inside `seat_forwardings`) through a plain-object transform that
 * does not itself touch that field, without silently rounding it.
 */
export function parsePreservingBigint(text: string): unknown {
  type SourceReviver = (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown;
  const reviver: SourceReviver = function (key, value, context) {
    if (typeof value !== "number") return value;
    const raw = context?.source;
    if (raw === undefined || !/^-?(0|[1-9][0-9]*)$/.test(raw)) return value;
    return Number.isSafeInteger(value) ? value : BigInt(raw);
  };
  return JSON.parse(text, reviver as (k: string, v: unknown) => unknown);
}

/**
 * A JSON string literal with every non-ASCII character escaped, as python does.
 * Shares ONE ensureAscii with the receipt writer — the two had drifted into
 * separate implementations and only one of them handled surrogate pairs.
 */
/**
 * Emit a number in the SUPPORTED DOMAIN: canonical safe integers.
 *
 * The domain is enforced at LOAD (see loadRegistry), where the raw lexeme is
 * still visible. Enforcing it again here is not redundant — it covers values
 * this process constructs rather than reads, which never pass through the
 * loader at all.
 *
 * An earlier version emitted `-0.0` for negative zero. That was python-correct
 * for the FLOAT `-0.0` and python-WRONG for the integer `-0`, which python
 * loads and dumps as `0` — a fix for one case that created a divergence in the
 * neighbouring one. Negative zero now normalizes to `0`, and the float form is
 * refused at load rather than guessed at here.
 */
function pyNumber(n: number): string {
  if (!Number.isInteger(n) || !Number.isSafeInteger(n)) {
    throw new Error(
      `registry: ${n} is outside the supported value domain (canonical safe integers only)`,
    );
  }
  return String(Object.is(n, -0) ? 0 : n);
}

function pyStr(s: string): string {
  return ensureAscii(JSON.stringify(s));
}

/** The `seats` map. An old `agents` store never reaches here: every reader refuses it first (old_store). */
export function seatMap(doc: RegistryDoc): Record<string, Seat> {
  const m = doc.seats;
  return typeof m === "object" && m !== null && !Array.isArray(m) ? m as Record<string, Seat> : {};
}

/** Hidden per-handle row incarnation. NEVER a handle encoding — display uses the bare handle. */
export function mintInstanceId(handle: string): string {
  const hex = Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex");
  return `${handle}|${hex}`;
}

/** Mint an instance on a row if absent; the SAME id survives a rebind. */
export function ensureSeatInstance(seat: Seat, handle: string): string {
  const existing = seat.instance;
  if (typeof existing === "string" && existing) return existing;
  const minted = mintInstanceId(handle);
  seat.instance = minted;
  return minted;
}

export function currentInstance(registryPath: string, handle: string): string {
  let doc: RegistryDoc;
  try {
    doc = loadRegistry(registryPath);
  } catch {
    return "";
  }
  const inst = seatMap(doc)[handle]?.instance;
  return typeof inst === "string" ? inst : "";
}

function loadSeats(registryPath: string): Record<string, Seat> {
  try {
    return seatMap(loadRegistry(registryPath));
  } catch {
    return {};
  }
}

function isActiveSeat(seat: Seat | undefined): boolean {
  if (!seat || typeof seat !== "object" || Array.isArray(seat)) return false;
  return !Object.prototype.hasOwnProperty.call(seat, "status") || seat.status === "active";
}

/** Successor that adopted `handle` at reclaim, or "" if `handle` is itself live. */
export function adoptedInto(registryPath: string, handle: string): string {
  const seats = loadSeats(registryPath);
  if (isActiveSeat(seats[handle])) return "";
  for (const name of Object.keys(seats).sort()) {
    const grant = seats[name]?.adopted_handles;
    if (Array.isArray(grant) && grant.includes(handle)) return name;
  }
  return "";
}

/** Actor-scoped grant: prints `successor` when that row adopted `fork` [, matching instance]. */
export function adoptionGrant(
  registryPath: string,
  successor: string,
  fork: string,
  rinst = "",
): string {
  const ent = loadSeats(registryPath)[successor];
  if (!ent || typeof ent !== "object") return "";
  const grant = ent.adopted_handles;
  if (!Array.isArray(grant) || !grant.includes(fork)) return "";
  if (rinst) {
    const ainst = ent.adopted_instances;
    if (!ainst || typeof ainst !== "object" || Array.isArray(ainst)) return "";
    if ((ainst as Record<string, unknown>)[fork] !== rinst) return "";
  }
  return successor;
}

/** Retired instance recorded on the successor's grant for `fork`, or "". */
export function adoptedInstance(registryPath: string, fork: string): string {
  const seats = loadSeats(registryPath);
  for (const ent of Object.values(seats)) {
    const grant = ent?.adopted_handles;
    if (!Array.isArray(grant) || !grant.includes(fork)) continue;
    const ainst = ent.adopted_instances;
    if (!ainst || typeof ainst !== "object" || Array.isArray(ainst)) continue;
    const inst = (ainst as Record<string, unknown>)[fork];
    if (typeof inst === "string" && inst) return inst;
  }
  return "";
}

export interface SelfIdentity {
  handle: string;
  pane: string;
  paneId: string;
}

export interface HarnessSessionPane {
  handle: string;
  pane: string;
  paneId: string;
  session: string;
  serverEpoch: string;
  serverSocket: string;
  instance?: string;
}

/**
 * Resolve one active pane row from a harness-volunteered native session id.
 *
 * Native ids are not globally unique during resume/fork windows, so ambiguity
 * refuses rather than choosing by object order or recency. The caller must
 * still re-observe the returned pane and generation before using it as self.
 */
export function resolvePaneByHarnessSession(
  registryPath: string,
  harness: string,
  sessionId: string,
): HarnessSessionPane | null {
  if (!sessionId) return null;
  let doc: RegistryDoc;
  try { doc = loadRegistry(registryPath); }
  catch { return null; }
  const matches: Array<[string, Seat]> = [];
  const seats = seatMap(doc);
  for (const handle of Object.keys(seats).sort()) {
    const seat = seats[handle]!;
    if (!isActiveSeat(seat) || seat.status_reason === "launching" || seat.delivery === "poll") continue;
    if (seat.harness !== harness || seat.harness_session_id !== sessionId) continue;
    matches.push([handle, seat]);
  }
  if (matches.length !== 1) return null;
  const [handle, seat] = matches[0]!;
  const pane = typeof seat.pane === "string" ? seat.pane : "";
  const paneId = typeof seat.pane_id === "string" ? seat.pane_id : "";
  const session = typeof seat.session === "string" ? seat.session : "";
  const serverEpoch = typeof seat.server_epoch === "string" ? seat.server_epoch : "";
  const serverSocket = typeof seat.server_socket === "string" ? seat.server_socket : "";
  const instance = typeof seat.instance === "string" ? seat.instance : "";
  if (!pane || !paneId || !session || !serverEpoch) return null;
  return { handle, pane, paneId, session, serverEpoch, serverSocket, instance };
}

/** Resolve one named active Claude row; the caller owns how that name was attested. */
export function resolvePaneByRegisteredHandle(
  registryPath: string,
  harness: string,
  handle: string,
): HarnessSessionPane | null {
  if (!handle) return null;
  let seat: Seat | undefined;
  try { seat = seatMap(loadRegistry(registryPath))[handle]; }
  catch { return null; }
  if (!seat || !isActiveSeat(seat) || seat.status_reason === "launching" || seat.delivery === "poll" ||
      seat.harness !== harness) return null;
  const pane = typeof seat.pane === "string" ? seat.pane : "";
  const paneId = typeof seat.pane_id === "string" ? seat.pane_id : "";
  const session = typeof seat.session === "string" ? seat.session : "";
  const serverEpoch = typeof seat.server_epoch === "string" ? seat.server_epoch : "";
  const serverSocket = typeof seat.server_socket === "string" ? seat.server_socket : "";
  const instance = typeof seat.instance === "string" ? seat.instance : "";
  if (!pane || !paneId || !session || !serverEpoch) return null;
  return { handle, pane, paneId, session, serverEpoch, serverSocket, instance };
}

/**
 * NOTE ON WHAT IS DELIBERATELY ABSENT: `team`.
 *
 * This resolver does not return the acting file's `team.name`, because a SEAT
 * ROW cannot establish a team: the caller must get that from the context layer,
 * which knows which authority model is in force.
 *
 * READ THE NEXT PARAGRAPH BEFORE REUSING THIS REASONING. An earlier version of
 * this note said `team.name` is pre-authority content that must never decide
 * identity, full stop. That sentence is true on ONE path and it cost three
 * separate defects, because each time I applied it one boundary too far and the
 * note made the result look considered rather than accidental:
 *
 *   1. I used the bus root's BASENAME as the team pre-flip, so a temp directory
 *      name rendered where the team belonged. The incumbent reads `team.name`
 *      there deliberately.
 *   2. Correcting that to "authority pre-flip" was still too broad: a
 *      non-string `team.name` coerced to `[object Object]`, which then drove
 *      the poll header AND `to_team` receive/settlement filtering.
 *   3. The same coercion sat on `root` in the global registry, one message from
 *      where we had just fixed an unexecutable remedy — it would have rendered
 *      `cd [object Object]`.
 *
 * THE ACTUAL RULE, in full, ruled by the partner reviewer 2026-08-24:
 *
 *   - PRE-FLIP (marker absent), `team.name` IS authority — when it is a string.
 *     The bus anchor has already fixed which registry is acting, so the name
 *     cannot select or redirect it; in the legacy model that bus/registry pair
 *     is the whole local authority, and the name is what labels and filters its
 *     `to_team` traffic. A non-string value is MISSING DATA and the caller
 *     falls back to the physical root basename, which is what the incumbent
 *     does (python `.strip()` raises inside its caught block).
 *   - POST-FLIP (marker live), the rule REVERSES: the global root-to-enrollment
 *     key owns identity, and sibling `team.name` must never discover or rebind
 *     authority, because a decoy or relocated registry answers with its own
 *     claim about itself.
 *
 * Marker state plus type validation is the boundary. It is written here, at
 * full length, because the short version of it is what produced all three.
 */


/**
 * Resolve a live pane to its registered handle. Identity is OBSERVATIONAL: the
 * pane's id is matched against the registry rather than asserted by the caller,
 * so a seat auto-suffixed at registration learns its real handle instead of
 * impersonating the incumbent.
 *
 * A row stamped under a PRIOR server generation is skipped: pane ids are unique
 * only within one tmux server lifetime, so a retired row whose pane_id equals the
 * caller's live id is recycling coincidence, never identity. An UNSTAMPED row
 * is skipped too (tap-zk1w): a row that makes no generation claim binds its
 * pane id to no server lifetime, so pane agreement alone would let a recycled
 * id name a seat that never sent. Register refuses to write such a row, so the
 * remedy for a seat that hits this is `tap register`. The caller refuses
 * outright when the current generation is unobservable.
 *
 * Handles are visited in sorted order so two rows that could both match resolve
 * deterministically rather than by object insertion order.
 */
export function resolveHandleByPane(
  registryPath: string,
  paneId: string,
  pane: string,
  serverEpochNow: string,
  selectedHandle?: string,
  selectedInstance?: string,
): SelfIdentity | null {
  let doc: RegistryDoc;
  try {
    doc = loadRegistry(registryPath);
  } catch {
    return null;
  }
  const handles = selectedHandle ? [selectedHandle] : Object.keys(seatMap(doc)).sort();
  for (const handle of handles) {
    const seat = seatMap(doc)[handle]!;
    if (typeof seat !== "object" || seat === null) continue;
    if (String(seat.status ?? "active") !== "active") continue;
    if (selectedInstance && String(seat.instance ?? "") !== selectedInstance) continue;
    const rowEpoch = String(seat.server_epoch ?? "");
    if (!rowEpoch || rowEpoch !== serverEpochNow) continue;
    const rowPaneId = seat.pane_id;
    const matches = rowPaneId ? rowPaneId === paneId : seat.pane === pane;
    if (!matches) continue;
    return { handle, pane: String(seat.pane ?? pane), paneId };
  }
  return null;
}


/**
 * Which enrolled team root has this pane registered — the executable half of an
 * unanchored-cwd refusal.
 *
 * A refusal whose remedy this binary does not accept is worse than a terse one:
 * `--team` is not an option `whoami` or `done` takes, so an operator following
 * that advice lands in a SECOND error produced by the first error's remedy.
 * The incumbent answers this case with `cd <enrolled-root>`, which every verb
 * accepts, and it can only do so by looking the pane up ACROSS enrolled teams.
 *
 * It lives here, not in index-home, because reading a seat row is this module's
 * job — the first version of this function open-coded `doc.agents[...]` and
 * found nothing, because the schema's key is `seats`. Guessing a shape next to
 * the loader that already knows it is how you write a lookup that silently
 * returns null.
 */
export function enrolledSeatForPane(
  paneId: string,
  indexHome?: string,
): { team: string; root: string; handle: string } | null {
  for (const t of enrolledTeams(indexHome)) {
    let doc: RegistryDoc;
    try {
      doc = loadRegistry(t.registryLocation);
    } catch {
      continue;   // An unreadable acting file is not evidence about this pane.
    }
    const seats = seatMap(doc);
    for (const handle of Object.keys(seats).sort()) {
      const seat = seats[handle]!;
      if (typeof seat !== "object" || seat === null) continue;
      if (String(seat.status ?? "active") !== "active") continue;
      if (strField(seat.pane_id) === paneId) {
        return { team: t.team, root: t.root, handle };
      }
    }
  }
  return null;
}

/**
 * Authoritative enrolled-pane resolution for an OBSERVED live pane.
 *
 * `enrolledSeatForPane` answers "does any row name this pane id", which is the
 * right question for a mere presence check (onboarding) and the wrong one for
 * a refusal that hands the operator an executable remedy naming a team. The
 * retired Bash lookup (tap_index_find_pane_team, tap-3kwy) refused to answer
 * that weak form, and this port keeps its three guards, because a pane id is
 * EVIDENCE, not an identity:
 *
 * - GENERATION: a row stamped under a prior tmux server lifetime names a pane
 *   the current server may have given to someone else. Only a row whose
 *   `server_epoch` equals the observed generation can bind; an unstamped row
 *   binds nothing (the re-attestation door is `tap register`).
 * - SESSION CORROBORATION: the row's own `session` record must equal the one
 *   the single tmux observation reported. Crew seats share their driver's
 *   session, so the equality corroborates the co-tenant group, not a handle —
 *   the generation stamp is what makes it identity.
 * - UNIQUENESS FAILS CLOSED: >1 current claimants is a contest and is refused
 *   rather than picked from; a registered source that cannot be read leaves
 *   uniqueness unproven and is refused (the incumbent's `unknown` verdict),
 *   never silently skipped into a confident answer.
 * - A DATA-GONE SOURCE IS ITS OWN TEAM'S PROBLEM (tap-xbpuc): an acting file
 *   that is positively absent (ENOENT) was OBSERVED to hold zero rows, so it
 *   cannot hide a second claimant. It never vetoes another team's unique
 *   claimant; a pane whose canonical `team/handle` session names that team
 *   gets `stale_enrollment`. One removed worktree must not block identity for
 *   every pane on the machine.
 *
 * The caller supplies the pane id, session, and server generation FROM ONE
 * observation (see observeCallingPane), mirroring the incumbent's rule that a
 * split observation lets a server replacement land between the reads.
 */
/** Why a pane's identity is `unknown`: only the first is a tmux observation gap. */
export type UnknownCause = "tmux_unobserved" | "registry_unreadable" | "malformed_enrollment" | "malformed_root";
export type EnrolledPaneResolution =
  | { kind: "resolved"; team: string; root: string; handle: string; registryLocation?: string }
  | { kind: "contested"; evidence: string }
  | { kind: "unverified"; verdict: "unknown" | "stale_enrollment" | "no_such_pane"; evidence: string; cause?: UnknownCause }
  | { kind: "unclaimed"; evidence: string }
  | { kind: "no_authority"; evidence: string };

function describeEnrolledClaim(claim: { team: string; handle: string; session: string; epoch: string }): string {
  return `${claim.team}/${claim.handle} (session ${claim.session || "unrecorded"}, epoch ${claim.epoch || "UNSTAMPED"})`;
}

/** The registry's seats axis, or null when it is absent or malformed — a
 * structural defect reads as UNREADABLE, never as "no claims" (seat_axis None). */
function seatsAxis(doc: RegistryDoc): Record<string, Seat> | null {
  const m = doc.seats;
  return typeof m === "object" && m !== null && !Array.isArray(m) ? m as Record<string, Seat> : null;
}

/** Python truthiness for `or` chains: false, 0, "", [], {} are falsy. A
 * parsed Map (the ordered JSON form) is truthy exactly when it has entries —
 * `Object.keys` sees no Map entries and would call every parsed map falsy. */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/** The census and resolver must select the same claimed team population. */
export function isRegisteredTeamState(state: unknown): boolean {
  return (pyTruthy(state) ? state : "registered") === "registered";
}

/** Identity fields bind claims only as strings: the incumbent's Python
 * comparisons never coerce, so a list or object row value cannot become a
 * pane id by passing through String(). */
function strField(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function enrolledSeatForObservedPane(
  paneId: string,
  observedSession: string,
  observedEpoch: string,
  indexHome?: string,
  opts?: { team?: string },
): EnrolledPaneResolution {
  // One guarded read of the flip marker: the marker kind and the teams
  // document come from the same snapshot, so a rewrite cannot split "live"
  // from "this team" and a FIFO at the marker path is classified without
  // being opened. Absent (no enrolled team, F2b) and invalid both answer
  // non-resolving without reopening the file.
  const snapshot = loadGlobalRegistry(indexHome);
  if (snapshot.marker === "absent") return { kind: "no_authority", evidence: "no machine index is present" };
  if (snapshot.marker !== "live" || !snapshot.doc) {
    return { kind: "no_authority", evidence: "the machine index could not be read" };
  }
  const teamsValue: unknown = snapshot.doc.teams;
  // A live index that omits `teams` is an empty enrollment map (the
  // incumbent's `.get("teams") or {}`), not a missing authority — the walk
  // then finds no claimants and the typed miss stands. A malformed value
  // cannot survive the guarded live snapshot and gains no fallback here.
  const teams = teamsValue === undefined ? {} : teamsValue;
  if (typeof teams !== "object" || teams === null || Array.isArray(teams)) {
    return { kind: "no_authority", evidence: "the machine index lists no teams" };
  }

  const claims: Array<{ team: string; handle: string; epoch: string; session: string; loc: string }> = [];
  const unreadable: string[] = [];
  // Enrolled rows whose machine-index entry names no usable registry_location:
  // the defect is in the enrollment, not in any team registry file.
  const malformedEnrollment: string[] = [];
  const missing: string[] = [];
  for (const team of Object.keys(teams as Record<string, unknown>).sort()) {
    const ent = (teams as Record<string, unknown>)[team];
    // The incumbent skips any non-dictionary team row, including arrays: a
    // malformed entry is not an enrollment source at all, so it must degrade
    // to "no claim here", never to an unreadable source that would tip an
    // otherwise unique valid claim into "uniqueness unproven".
    if (typeof ent !== "object" || ent === null || Array.isArray(ent)) continue;
    const e = ent as Record<string, unknown>;
    // The incumbent's `or`-chain default: a falsy state ("", false, 0, [],
    // {}) reads as registered, while a truthy non-string never becomes
    // "registered" through string coercion.
    if (!isRegisteredTeamState(e.state)) continue;
    // Exact-team read scope (tap-7s1r U1): the pane-anchored context path
    // asks about ONE hinted team before any stat or read. The default
    // (unscoped) path is byte-identical to the incumbent. A scoped verdict
    // ignores other teams' unavailable registries — it is NOT proof of
    // global uniqueness; the caller answers uniqueness with the unscoped form.
    if (opts?.team !== undefined && team !== opts.team) continue;
    // A path field that is not a primitive string is a malformed source: the
    // incumbent's Python never coerces a list or object into a filesystem
    // path, so such a team must fail closed (unreachable authority), never
    // hand out a String()-built "path". A missing or empty field is the same
    // defect: no file was ever named, so none can be called unreadable.
    const loc = typeof e.registry_location === "string" ? e.registry_location : "";
    if (!loc) {
      malformedEnrollment.push(team);
      continue;
    }
    // An enrolled team whose acting authority cannot be read is UNREACHABLE,
    // never proven empty — including when the file is simply gone. This lookup
    // hands out an executable team remedy, so it sits on the fail-closed side.
    // Only true absence counts as missing (ENOENT, including a symlink whose
    // target is gone): a directory, FIFO, or otherwise uninspectable path is
    // unreadable, matching the incumbent classifier. statSync never opens the
    // target, so a FIFO here is inspected, not read.
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(loc);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        missing.push(team);
      } else {
        unreadable.push(team);
      }
      continue;
    }
    if (!st.isFile()) {
      unreadable.push(team);
      continue;
    }
    let doc: RegistryDoc;
    try {
      doc = loadRegistry(loc);
    } catch {
      unreadable.push(team);
      continue;
    }
    // A registry whose seats axis is absent or malformed is a structural
    // defect, not an empty seat map (the incumbent's seat_axis None verdict).
    // An old-format registry is not evidence about this pane: uniqueness stays unproven.
    if (teamRegistryRefusal(loc, doc)) {
      unreadable.push(`${team} (old_store)`);
      continue;
    }
    const axis = seatsAxis(doc);
    if (!axis) {
      unreadable.push(team);
      continue;
    }
    for (const handle of Object.keys(axis).sort()) {
      const raw: unknown = axis[handle];
      // The incumbent skips any non-dict seat row, so a malformed value must
      // degrade to "no claim from this row", never crash the resolver.
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
      const seat = raw as Record<string, unknown>;
      // Claim selection matches the incumbent exactly: pane_id, or the pane
      // name equal to or ending in "/<pane-id>". No status filter — the
      // incumbent never limited claims to "active" rows, and adding one here
      // would silently shrink the contested/uniqueness population.
      const pid = strField(seat.pane_id);
      const pname = strField(seat.pane);
      if (pid !== paneId && pname !== paneId && !pname.endsWith(`/${paneId}`)) continue;
      claims.push({
        team,
        handle,
        epoch: strField(seat.server_epoch),
        session: strField(seat.session),
        loc,
      });
    }
  }

  const describe = () => claims.map(describeEnrolledClaim).join("; ") || "no claimant rows";
  // An observation without a session name cannot bind the pane to any seat
  // row (the incumbent's no_such_pane), and one without a generation stamp
  // cannot prove currency (unknown). Both refuse before uniqueness is
  // decided, after the claim evidence is built.
  if (!observedSession) return { kind: "unverified", verdict: "no_such_pane", evidence: describe() };
  if (!observedEpoch) return { kind: "unverified", verdict: "unknown", cause: "tmux_unobserved", evidence: describe() };
  // CORROBORATION, not absence of objection: the row's stored session must
  // equal the one tmux reported, and only a row stamped with the observed
  // generation can bind a pane id to THIS server lifetime.
  const matched = claims.filter((c) => c.session && c.session === observedSession);
  const current = matched.filter((c) => c.epoch && c.epoch === observedEpoch);
  if (current.length > 1) {
    return {
      kind: "contested",
      evidence: `${current.length} claimants agree with this pane's session: ${current.map(describeEnrolledClaim).join("; ")}`,
    };
  }
  // Uniqueness is a claim over the REGISTERED population, so an unobservable
  // source leaves it unproven — silently skipping one cannot support it.
  // A real unreadable registry keeps its cause and hint even beside a
  // malformed enrollment (the evidence names both); the malformed enrollment
  // gets its own cause only when it is the sole unobservable source.
  if (unreadable.length > 0) {
    const alsoMalformed = malformedEnrollment.length > 0 ? `; malformed enrollment: ${malformedEnrollment.sort().join(", ")}` : "";
    return {
      kind: "unverified",
      verdict: "unknown",
      cause: "registry_unreadable",
      evidence: `registered team(s) ${unreadable.sort().join(", ")} could not be read, so single-claimant uniqueness is unproven${alsoMalformed}; readable rows naming it: ${describe()}`,
    };
  }
  if (malformedEnrollment.length > 0) {
    return {
      kind: "unverified",
      verdict: "unknown",
      cause: "malformed_enrollment",
      evidence: `malformed enrollment: machine-index row(s) ${malformedEnrollment.sort().join(", ")} name no usable registry_location, so single-claimant uniqueness is unproven; readable rows naming it: ${describe()}`,
    };
  }
  if (current.length === 1) {
    const c = current[0]!;
    // Same primitive-string rule as registry_location: a malformed root on
    // the otherwise winning claim makes the remedy unverifiable, so identity
    // fails closed (uniqueness unproven) instead of asserting the pane is
    // unclaimed — a `tap register` there invites a duplicate registration,
    // and a fabricated path must never become an executable `cd`.
    const rawRoot = ((teams as Record<string, unknown>)[c.team] as Record<string, unknown>).root;
    const root = typeof rawRoot === "string" ? rawRoot : "";
    if (!root) {
      return {
        kind: "unverified",
        verdict: "unknown",
        cause: "malformed_root",
        evidence: `winning claimant ${describeEnrolledClaim(c)} has a malformed team root, so single-claimant uniqueness is unproven`,
      };
    }
    // Modern (live-index) rows carry the exact acting registry path that
    // supplied them, so a caller can bind its selection to the same source;
    // the legacy arm omits it and keeps incumbent behavior.
    return { kind: "resolved", team: c.team, root, handle: c.handle, registryLocation: c.loc };
  }
  // No readable claimant. When the pane's canonical `team/handle` session names
  // a team whose acting file is gone, the stale enrollment is the answer and
  // its remedy is de-enrollment. The session only picks the refusal; it never
  // confers identity.
  const hinted = /^([^/]+)\/[^/]+$/.exec(observedSession)?.[1];
  if (hinted !== undefined && missing.includes(hinted)) {
    return {
      kind: "unverified",
      verdict: "stale_enrollment",
      evidence: `team '${hinted}' is enrolled but its acting registry file is gone (worktree removed while enrolled?); rows naming it: ${describe()}`,
    };
  }
  return {
    kind: "unclaimed",
    evidence: `it is live in session '${observedSession}' but no CURRENT-generation seat claims that session (an unstamped row cannot bind a pane id to this server lifetime); rows naming it: ${describe()}`,
  };
}
