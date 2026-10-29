// Seat observation: ONE snapshot, one classifier, two doors.
//
// Port of `skills/tap/scripts/tap_observe_seats.py` (tap-lae7). The semantics
// twin lib.sh's `tap_seat_observed_record` / `tap_harness_evidence` /
// `tap_process_harness_observation` — cost changes, meaning does not.
//
// WHY THE SNAPSHOT IS TAKEN ONCE AND PASSED IN, rather than gathered per seat.
// This is not a performance note; it is the defect the module exists to
// prevent, recorded at `verbs/refresh.ts:656`: each gather takes a fresh
// tmux/process picture, so a per-seat loop runs the pane-set reconciliation
// against a different world each time and can answer differently for the same
// seat. The live specimen — Bash kept a seat as `unknown:pane_set_unobservable`
// where a per-row version removed it as `session_absent`, deleting a live
// registration on a snapshot artifact. Both doors below therefore take a
// `Snapshot`, and only the callers gather.
//
// THE POLARITY THAT MATTERS: a probe that could not run is UNKNOWN, never GONE.
// `unknown` keeps the row; treating an unobservable probe as death is what
// removes live seats. Every `null`/`unobservable` path below is that rule.

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { invocationMemoActive, onInvocationMemoScope } from "./invocation-memo";
import { REGISTRY_MAX_BUFFER } from "./spawn";
import { PY_SPACE } from "./events";

export const US = "\x1f";

/** Matches lib.sh TAP_HARNESS_FAMILIES; production callers pass the canonical
 * list so a newly listed family cannot drift between the roster and N=1. */
export const DEFAULT_AGENT_FAMILIES = ["claude", "codex", "opencode", "cursor", "hermes", "agy"] as const;
export const SHELLS = ["bash", "zsh", "sh", "fish", "dash", "ksh", "tcsh"] as const;
export const DENYLIST: readonly string[] = [
  ...SHELLS,
  "less", "more", "man", "vi", "vim", "view", "nvim", "nano", "emacs",
  "ssh", "cat", "pager", "git",
];

// PYTHON'S WHITESPACE, NOT JAVASCRIPT'S, EVERYWHERE BELOW. JS `\s` includes
// U+FEFF and Python's does not, so a `\s` here splits inside a `ps` field on a
// BOM and shifts comm and command into strings the incumbent never produced —
// and the family that comes out of them is an authorization input. Measured:
// Python `"1 2 3 no\ufeffde /usr/bin/x".split(None, 4)` keeps `no\ufeffde` whole.
// This is the third instance of one class in this file (tap-lrm64); the other
// two were the quoted-backslash tokenizer and the digit predicate, and the
// reason this one survived their fix is that fixing found instances makes the
// class feel handled.
const PY_WS = new RegExp(PY_SPACE, "u");
const PY_WS_RUN = new RegExp(`${PY_SPACE}+`, "gu");
const PY_WS_LEAD = new RegExp(`^${PY_SPACE}+`, "u");
// `String.trim()` is the same trap one level up: it strips U+FEFF too, because
// JS trims ECMAScript WhiteSpace. The ORACLE RUN against the deleted Python
// caught this one where hand-reasoning had not — a `ps` row led by a BOM was
// refused by the incumbent (`unknown / harness_unobservable`, because
// `"\ufeff123".strip()` keeps the BOM and fails isdigit) and ATTESTED ALIVE by
// the port, which trimmed the BOM away and read a clean pid. Looser than the
// incumbent, on the authorization path. That is why the fix is measured against
// the program rather than against my reading of it.
// THREE PRIMITIVES, THREE CLASSES. The reviewer's W1/W2: collapsing
// them into one was my own over-correction, and the commit that did it claimed
// "one spelling of Python whitespace in the tree" as if that were the goal.
// Measured with the incumbent's tooling rather than assumed:
//
//   shlex.whitespace  = ' \t\r\n'   NARROW -- NBSP and thin space stay INSIDE
//                                     a word
//   str.split()       = the wide class below, which is also what shlex's OWN
//                       malformed-quote fallback uses
//   str.splitlines()  = LF CR VT FF FS GS RS NEL LS PS, CRLF counted once --
//                       but NOT US, NOT NBSP, NOT BOM
//
// So `node node\u00a0codex` is ONE unquoted word to shlex and must not attest
// `codex`, while `node 'node\u00a0codex` (unbalanced quote) takes the wide
// fallback and correctly does. Two rules, deliberately, not one.
const SHLEX_WS = /[ \t\r\n]/;

/**
 * `os.path.basename`, which is NOT `path.basename` (astra W4).
 *
 * Python returns everything after the last separator, so a TRAILING SLASH gives
 * the empty string: `basename("/tmp/codex/") == ""`. Node walks back past it and
 * answers `"codex"`, which turned a directory argument into a family name the
 * incumbent never recognised and attested a harness on it. Measured:
 *   /tmp/codex/  -> ""      /tmp/codex//  -> ""      codex/  -> ""
 *   /tmp/codex   -> "codex" codex         -> "codex" /       -> ""
 * Used at every observer caller, because fixing one site would leave the same
 * primitive mismatch in its siblings.
 */
function pyBasename(text: string): string {
  return text.slice(text.lastIndexOf("/") + 1);
}

/** `str.splitlines()`: the boundaries above, CRLF counted once. */
function pySplitlines(text: string): string[] {
  return text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/u);
}

const pyStrip = (text: string): string => text.replace(PY_WS_LEAD, "").replace(new RegExp(`${PY_SPACE}+$`, "u"), "");

export function agentFamilies(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const raw = pyStrip(env.TAP_OBS_HARNESS_FAMILIES ?? "");
  // Python's bare `str.split()` on whitespace, not a single-space split.
  return raw ? raw.split(PY_WS_RUN) : [...DEFAULT_AGENT_FAMILIES];
}

/**
 * Twin of `tap_harness_family`. CASE-SENSITIVE, which it was not until
 * tap-fqd3e: both this function and `classifyHarness` lowercased, while the
 * Bash incumbent is a `case "$name" in "$fam"|"$fam"-*)` that does not. A
 * command reporting `CLAUDE` therefore read `agent` here and `unsupported`
 * there — deliverable versus refused, at `harnessEvidence` the difference
 * between `alive` and `exited` for the same pane.
 *
 * The incumbent for this surface is the Bash reader, so the port preserves its
 * case-sensitivity rather than inheriting the newer implementation's
 * permissiveness as the definition. Whether `pane_current_command` can actually
 * report a capitalized name is NOT established — tmux reports the process's own
 * command — and no reachability claim is made here. If a measurement ever shows
 * production depended on the permissive reading, that is its own decision with
 * its own evidence.
 */
export function harnessFamily(cmd: string, families: readonly string[]): string {
  const name = pyBasename(cmd || "");
  for (const fam of families) if (name === fam || name.startsWith(`${fam}-`)) return fam;
  return name;
}

/** Twin of `tap_classify_harness`, which re-normalizes then matches literally. */
export function classifyHarness(family: string, families: readonly string[]): "denylist" | "agent" | "unsupported" {
  const name = family || "";
  if (DENYLIST.includes(name)) return "denylist";
  if (families.includes(name)) return "agent";
  return "unsupported";
}

/**
 * Shared fallback base for implicit handle derivation (tap-2al3d): when the
 * tmux session name cannot yield a handle (a bare numeric `tmux` session, an
 * unusable remainder), the pane's positively observed harness family becomes
 * the base handle. Any family that is not an agent — a shell, a denylisted
 * command, anything unclassifiable — yields "" so the caller keeps its
 * fail-closed refusal. Derivation inputs never include the crew
 * expected-harness override; callers pass an observed pane family only.
 */
export function harnessFallbackHandle(family: string, families: readonly string[]): string {
  return classifyHarness(family, families) === "agent" ? family : "";
}

export function isPaneId(value: string): boolean {
  if (!value.startsWith("%")) return false;
  const rest = value.slice(1);
  // Python `str.isdigit()`: every decimal (Nd), plus the other-number
  // characters that carry a DIGIT value — superscripts, subscripts, circled
  // digits. Not fractions: `'½'.isdigit()` is False.
  //
  // The previous test asked whether the NFKD expansion CONTAINED an ASCII
  // digit, which `½` satisfies because it expands to `1⁄2`. That let a pane id
  // of `%½` read as well-formed, so malformed pane evidence resolved to
  // `active` instead of poisoning the pane set (astra, F3). A digit-valued
  // character expands to exactly ONE ASCII digit; a fraction expands to three.
  return rest.length > 0 && [...rest].every(ch =>
    /\p{Nd}/u.test(ch) || (/\p{No}/u.test(ch) && /^\d$/.test(ch.normalize("NFKD"))));
}

/** Twin of tap_server_epoch_from_raw. `pin` is TAP_SERVER_EPOCH when set. */
export function serverEpochFromRaw(raw: string, pin: string | null): string | null {
  if (pin !== null) return pin || null;
  if (!raw || [...raw].some(ch => !"0123456789:".includes(ch))) return null;
  if (raw.startsWith(":") || raw.endsWith(":")) return null;
  if ((raw.match(/:/g) ?? []).length !== 1) return null;
  return `srv:${raw}`;
}

/** Boolean boot relation (the retired Bash tap_boot_ids_match was the three-valued one; see tmux.ts bootIdsMatch). */
export function bootIdsMatch(
  row: string, current: string, legacy: string,
  tapBootIdSet: boolean, tapBootIdLegacySet: boolean,
): boolean {
  if (!row || !current) return false;
  if (row === current) return true;
  if (tapBootIdSet && !tapBootIdLegacySet) return false;
  if (!row.startsWith("boot:") || !isAsciiDigits(row.slice(5))) return false;
  if (!legacy.startsWith("boot:") || !isAsciiDigits(legacy.slice(5))) return false;
  return Math.abs(Number(row.slice(5)) - Number(legacy.slice(5))) <= 5;
}

function isAsciiDigits(text: string): boolean {
  return text.length > 0 && /^\d+$/.test(text);
}

/** Twin of tap_pending_reservation_expired (`sessionsOk` false == tmux failed). */
export function pendingReservationExpired(
  session: string, registeredAt: string, sessionsOk: boolean,
  sessionNames: ReadonlySet<string>, nowTs: number,
): boolean {
  if (!session || !registeredAt) return false;
  if (!sessionsOk) return false;
  if (sessionNames.has(session)) return false;
  const reserved = parseUtcStamp(registeredAt);
  if (reserved === null) return false;
  return nowTs - reserved >= 60;
}

/** `%Y-%m-%dT%H:%M:%SZ` exactly — Python strptime rejects anything else. */
function parseUtcStamp(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as number[];
  const ms = Date.UTC(y!, mo! - 1, d!, h!, mi!, s!);
  if (Number.isNaN(ms)) return null;
  // Date.UTC rolls over out-of-range components; strptime refuses them.
  const back = new Date(ms);
  // THE YEAR IS CHECKED FIRST because it is the one component Date.UTC does not
  // merely roll over: it REMAPS years 0-99 into 1900-1999. `0000-09-15T07:00:00Z`
  // silently became 1900 and read as an expired reservation, where Python's
  // strptime rejects year zero outright (astra, F4). Every other component only
  // needed the rollover check; this one needed to exist at all.
  if (back.getUTCFullYear() !== y!) return null;
  if (back.getUTCMonth() !== mo! - 1 || back.getUTCDate() !== d! ||
      back.getUTCHours() !== h! || back.getUTCMinutes() !== mi! || back.getUTCSeconds() !== s!) return null;
  return Math.floor(ms / 1000);
}

export function classifyCommCommand(comm: string, command: string, families: readonly string[]): string {
  const words = [comm, ...shlexSplit(command)];
  for (const word of words) {
    const low = pyBasename(word).toLowerCase();
    for (const family of families) if (low === family || low.startsWith(`${family}-`)) return family;
  }
  for (const word of words) {
    for (const segment of word.replaceAll("\\", "/").split("/")) {
      const low = segment.toLowerCase();
      for (const family of families) if (low.startsWith(`${family}-`)) return family;
    }
  }
  return "";
}

/**
 * Holder classification for the caller-pane climb (held-terminal.md,
 * condition 4): only the EXECUTABLE may name the family. `classifyCommCommand`
 * above scans every command word, which is right for a pane's own harness
 * (where the question is "which harness runs here") and wrong for an identity
 * proof: `script -q /dev/null claude` and `xterm -e codex exec` both carry a
 * harness name as a later argv word while being a terminal relay, not a
 * harness. Candidates are therefore `comm`, `argv[0]`, and -- only when
 * `argv[0]` is a supported script runtime (node, bun, deno, python) -- its
 * script entrypoint, which is `argv[1]` and ONLY `argv[1]` (Claude Code
 * installed through npm runs as `node .../claude-code/cli.js`). A runtime
 * option may take a separate value (`node --require /tmp/claude.js
 * relay.js`), and guessing which options do is how a preload value became an
 * entrypoint (review, P1 round 4), so an option-led runtime command line is
 * not admitted at all; the real harness shims pass the script first. A
 * candidate names a
 * family by its basename (an entrypoint's `.js`/`.mjs`/`.cjs`/`.py`/`.ts`
 * suffix stripped), by a `<family>-` prefix on that basename, or by a
 * `<family>-` path segment. Nothing after the entrypoint counts, and
 * FAMILIES is the caller's fixed set. Claude's version-named native
 * executable is NOT admitted here: `nativeClaudeCommand` proves only that a
 * file of that name is executable under `$HOME`, which the judged process
 * controls (review, P1 round 5), and Claude's tool children carry no
 * terminal, so the walk reaches the claude process on the pane tty without
 * this arm.
 */
const HOLDER_RUNTIMES = /^(node|bun|deno|python)[0-9.]*$/;
export function classifyHolderCommand(comm: string, command: string, families: readonly string[]): string {
  const words = shlexSplit(command);
  const argv0 = words[0] ?? "";
  const candidates = [comm, argv0];
  if (HOLDER_RUNTIMES.test(pyBasename(argv0).toLowerCase())) {
    const entry = words[1] ?? "";
    if (entry !== "" && !entry.startsWith("-")) candidates.push(entry);
  }
  for (const word of candidates) {
    const base = pyBasename(word);
    const low = base.toLowerCase().replace(/\.(js|mjs|cjs|py|ts)$/, "");
    for (const family of families) if (low === family || low.startsWith(`${family}-`)) return family;
  }
  for (const word of candidates) {
    for (const segment of word.replaceAll("\\", "/").split("/")) {
      const low = segment.toLowerCase();
      for (const family of families) if (low.startsWith(`${family}-`)) return family;
    }
  }
  return "";
}

/**
 * `shlex.split` enough for a ps command line, with Python's fallback: an
 * unbalanced quote raises ValueError there and the caller splits on
 * whitespace instead, so an unparseable command still yields words.
 */
function shlexSplit(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (quote === '"' && ch === "\\" && i + 1 >= command.length) {
        return command.split(PY_WS_RUN).filter(Boolean); // unfinished escape (astra W3)
      }
      if (quote === '"' && ch === "\\" && i + 1 < command.length) {
        // Python's shlex escapes inside double quotes ONLY before the escape
        // character and the quote character (`escapedquotes = '"'`); before an
        // ordinary letter the backslash is KEPT. Dropping it unconditionally
        // let `node "co\\dex"` tokenize to `codex` and authorize a harness on
        // a process spelling that never named one — and the family match is an
        // authorization input, not a display string (astra, F2).
        const next = command[i + 1]!;
        if (next === '"' || next === "\\") { current += command[++i]!; continue; }
        current += ch;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    // An UNFINISHED escape -- a backslash as the final character -- raises
    // ValueError in Python ("No escaped character"), so the incumbent falls back
    // to the whole-command `str.split()` and the still-quoted token matches no
    // family. Accepting the backslash literally kept the partial tokenization
    // and let an already-unquoted `codex` attest (astra W3). An ESCAPED
    // backslash is fine and must stay fine: `node \\\\` tokenizes normally.
    if (ch === "\\" && i + 1 >= command.length) return command.split(PY_WS_RUN).filter(Boolean);
    if (ch === "\\") { current += command[++i]!; started = true; continue; }
    // shlex's OWN whitespace, not Python's string whitespace: splitting here on
    // NBSP turns one non-family word into a family name and broadens
    // attestation (astra W1).
    if (SHLEX_WS.test(ch)) {
      if (started || current) { words.push(current); current = ""; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote !== null) return command.split(PY_WS_RUN).filter(Boolean); // ValueError path
  if (started || current) words.push(current);
  return words;
}

export type PsRow = readonly [pgid: string, tpgid: string, comm: string, command: string];
export type PsTable = ReadonlyMap<string, PsRow>;

export function parsePsTable(text: string): Map<string, PsRow> {
  const rows = new Map<string, PsRow>();
  // `splitlines()`, not `split("\n")`: a NEL inside a `ps` row is a ROW BOUNDARY
  // to the incumbent, so splitting on LF alone MERGES two rows and the second
  // row's tokens become the first root's command -- reading `active / codex`
  // where the incumbent read `offline / harness_exited`. Fixing the word split
  // alone does not repair this (astra W2).
  for (const line of pySplitlines(text)) {
    // Python str.split(None, 4): strip, then split on whitespace runs.
    const parts = splitMax(pyStrip(line), 4);
    if (parts.length >= 4 && parts.slice(0, 3).every(v => isAsciiDigits(v.replace(/^-+/, "")))) {
      rows.set(parts[0]!, [parts[1]!, parts[2]!, parts[3]!, parts[4] ?? ""]);
    }
  }
  return rows;
}

/** Python's `split(None, maxsplit)`: the remainder keeps its internal spacing. */
function splitMax(text: string, maxsplit: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (out.length < maxsplit) {
    const trimmed = rest.replace(PY_WS_LEAD, "");
    if (!trimmed) return out;
    const m = PY_WS.exec(trimmed);
    if (!m) { out.push(trimmed); return out; }
    out.push(trimmed.slice(0, m.index));
    rest = trimmed.slice(m.index);
  }
  const tail = rest.replace(PY_WS_LEAD, "");
  if (tail) out.push(tail);
  return out;
}

/**
 * Twin of tap_process_harness_observation. Returns (observed|unobservable, family).
 *
 * For a shell root, the kernel-designated terminal foreground process-GROUP
 * leader may supply the family. This is deliberately not a descendant walk: a
 * background agent has a different process group and stays invisible.
 */
export function observeProcessHarness(
  root: string, psRows: PsTable | null, psOk: boolean, families: readonly string[],
): { state: "observed" | "unobservable"; family: string; pid?: string } {
  if (!psOk || psRows === null) return { state: "unobservable", family: "" };
  const row = psRows.get(root);
  if (row === undefined) return { state: "unobservable", family: "" };
  let family = classifyCommCommand(row[2], row[3], families);
  if (family) return { state: "observed", family, pid: root };
  const rootName = pyBasename(row[2]).toLowerCase().replace(/^-+/, "");
  if ((SHELLS as readonly string[]).includes(rootName)) {
    const foreground = row[1];
    const leader = psRows.get(foreground);
    if (foreground !== "" && foreground !== "0" && foreground !== "-1" && leader !== undefined && leader[0] === foreground) {
      family = classifyCommCommand(leader[2], leader[3], families);
      if (family) return { state: "observed", family, pid: foreground };
    }
  }
  return { state: "observed", family: "" };
}

export type HarnessState = "alive" | "exited" | "mismatch" | "unattested" | "unobservable";

/** Claude's native executable is named by version, which tmux reports without its path. */
export function nativeClaudeCommand(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(command)) return false;
  try {
    const binary = statSync(join(env.HOME || homedir(), ".local/share/claude/versions", command));
    return binary.isFile() && (binary.mode & 0o111) !== 0;
  } catch { return false; }
}

export type SessionStartAncestry =
  | { state: "seat" }
  | { state: "nested"; pid: string; family: string }
  | { state: "unobservable"; reason: string };

/** SessionStart owns the pane harness, not another harness it started. Use
 * the shared executable classifier, never argv words such as the hook's
 * trailing `claude`. A version-named Claude counts only toward refusal here;
 * its HOME-relative evidence must never grant identity in the holder proof.
 * The pane boundary prevents counting the harness that launched a tmux server.
 */
export function observeSessionStartAncestry(
  panePid: string, caller: number, table: PsTable | null,
  parent: (pid: number) => string, env: NodeJS.ProcessEnv = process.env,
): SessionStartAncestry {
  const unknown = (reason: string): SessionStartAncestry => ({ state: "unobservable", reason });
  if (!table || !/^[1-9][0-9]*$/.test(panePid)) return unknown("pane process or process table unavailable");
  let pid = String(caller);
  let previous = "";
  let child: { pid: string; family: string; words: string[] } | undefined;
  const visited = new Set<string>();
  for (let steps = 0; steps < 64; steps++) {
    if (visited.has(pid)) return unknown("process ancestry cycle");
    visited.add(pid);
    const row = table.get(pid);
    if (!row) return unknown(`process ${pid} unavailable`);
    const words = shlexSplit(row[3]);
    // The hook itself is an adapter, even if its installation path names a harness.
    if (pid !== String(caller)) {
      const family = classifyHolderCommand(row[2], row[3], DEFAULT_AGENT_FAMILIES)
        || ([row[2], words[0] ?? ""].some(word => nativeClaudeCommand(pyBasename(word), env)) ? "claude" : "");
      if (family) {
        if (child) {
          // npm's codex shim directly forwards argv to the native executable.
          // Two native harnesses, different families, or a shell/tool between
          // them are nested. A shim starting a different invocation is too.
          const forwarding = child.pid === previous && child.family === family
            && HOLDER_RUNTIMES.test(pyBasename(words[0] ?? ""))
            && classifyHolderCommand("", row[3], DEFAULT_AGENT_FAMILIES) === family
            && !HOLDER_RUNTIMES.test(pyBasename(child.words[0] ?? ""))
            && JSON.stringify(words.slice(2)) === JSON.stringify(child.words.slice(1));
          if (!forwarding) return { state: "nested", pid: child.pid, family: child.family };
        }
        child = { pid, family, words };
      }
    }
    if (pid === panePid) return { state: "seat" };
    const next = parent(Number(pid));
    if (!/^[1-9][0-9]*$/.test(next) || Number(next) <= 1) return unknown("process ancestry ended before pane");
    previous = pid;
    pid = next;
  }
  return unknown("process ancestry exceeded 64 steps");
}

/**
 * Observation can CONFIRM an attested expectation but never mint one: an empty
 * expected family is a repairable write-boundary omission, not a matches-any
 * wildcard and not a positive mismatch.
 */
export function harnessEvidence(
  expectedHarness: string, command: string, panePid: string,
  psRows: PsTable | null, psOk: boolean, families: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { state: HarnessState; family: string } {
  const expected = harnessFamily(expectedHarness, families);
  if (!expected) return { state: "unattested", family: "" };
  const observed = families.includes("claude") && nativeClaudeCommand(command, env) ? "claude" : harnessFamily(command, families);
  const klass = classifyHarness(observed, families);
  if (klass === "agent") return observed === expected ? { state: "alive", family: observed } : { state: "mismatch", family: observed };
  if (klass === "denylist") return { state: "exited", family: observed };
  if (!panePid) return { state: "unobservable", family: "" };
  const { state, family } = observeProcessHarness(panePid, psRows, psOk, families);
  if (state !== "observed") return { state: "unobservable", family: "" };
  if (family) return family === expected ? { state: "alive", family } : { state: "mismatch", family };
  return { state: "exited", family: observed };
}

export interface SessionInfo { epoch: string; attached: string }
export type SessionsMode = "ok" | "unobservable" | "empty";

export function parseSessions(
  text: string, rc: number, epochPin: string | null,
): { mode: SessionsMode; sharedEpoch: string; sessions: Map<string, SessionInfo> } {
  const nothing = { mode: "unobservable" as const, sharedEpoch: "", sessions: new Map<string, SessionInfo>() };
  if (rc !== 0) return nothing;
  const sessions = new Map<string, SessionInfo>();
  let epoch = "";
  let seen = false;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 2 || parts.length > 3) return nothing;
    const [session, rawEpoch] = parts as [string, string];
    const attached = parts[2] ?? "";
    if (!session || !rawEpoch) return nothing;
    const parsed = serverEpochFromRaw(rawEpoch, epochPin);
    if (!parsed) return nothing;
    // Two sessions reporting different epochs means the snapshot spans two
    // servers; there is no single truth to classify against.
    if (epoch && epoch !== parsed) return nothing;
    epoch = parsed;
    seen = true;
    sessions.set(session, { epoch: parsed, attached });
  }
  if (!seen) return { mode: "empty", sharedEpoch: "", sessions: new Map() };
  return { mode: "ok", sharedEpoch: epoch, sessions };
}

export interface PaneRecord {
  session: string; address: string; pane_id: string;
  command: string; pane_pid: string; epoch: string; dead: boolean;
}
/** A malformed row poisons its session's pane set rather than being skipped. */
interface BadRecord { _bad: "1" }
type PaneEntry = PaneRecord | BadRecord;

export function parsePanes(
  text: string, rc: number, epochPin: string | null,
): { mode: "ok" | "unobservable"; bySession: Map<string, PaneEntry[]> } {
  if (rc !== 0) return { mode: "unobservable", bySession: new Map() };
  const bySession = new Map<string, PaneEntry[]>();
  const mark = (session: string): void => {
    // A truncated or malformed row is EVIDENCE that the pane set for its
    // session is unreadable. Silently skipping it would let a scoped guard
    // proceed on the surviving subset — which is how a live seat gets judged
    // against a partial world (sol P2, P2 #2).
    const list = bySession.get(session) ?? [];
    list.push({ _bad: "1" });
    bySession.set(session, list);
  };
  for (const line of text.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length !== 7) {
      // A blank session name records under the "" sentinel key: invisible to
      // unscoped by-name lookups, poison for a scoped snapshot.
      mark(parts[0] ?? "");
      continue;
    }
    const [session, address, paneId, command, panePid, rawEpoch, dead] = parts as [string, string, string, string, string, string, string];
    if (!session) { mark(""); continue; }
    if (!address || !isPaneId(paneId) || (!command && dead !== "1") || (dead !== "0" && dead !== "1")) { mark(session); continue; }
    if (!isAsciiDigits(panePid) && !(dead === "1" && panePid === "")) { mark(session); continue; }
    const parsed = serverEpochFromRaw(rawEpoch, epochPin);
    if (!parsed) { mark(session); continue; }
    const list = bySession.get(session) ?? [];
    list.push({ session, address, pane_id: paneId, command, pane_pid: panePid, epoch: parsed, dead: dead === "1" });
    bySession.set(session, list);
  }
  return { mode: "ok", bySession };
}

/** Pane records for `wanted`, or null when the set is unobservable. */
export function sessionPanesFor(
  bySession: ReadonlyMap<string, PaneEntry[]>, panesMode: string,
  wanted: string, expectedEpoch: string,
): PaneRecord[] | null {
  if (panesMode !== "ok") return null;
  const rows = bySession.get(wanted);
  if (!rows || rows.length === 0) return null;
  const out: PaneRecord[] = [];
  for (const row of rows) {
    if ("_bad" in row) return null;
    if (expectedEpoch && row.epoch !== expectedEpoch) return null;
    out.push(row);
  }
  return out.length ? out : null;
}

export interface ObservePayload {
  rows?: RowInput[];
  sessions_text?: string; panes_text?: string; ps_text?: string;
  sessions_rc?: number; panes_rc?: number; ps_rc?: number;
  now_boot?: string; legacy_boot?: string; now_ts?: number;
  tap_boot_id_set?: boolean; tap_boot_id_legacy_set?: boolean;
  session_scope?: string;
  /** Absent => parse raw epochs. Present (even "") => the pin wins. */
  server_epoch_pin?: string;
}

export interface Snapshot {
  sessionScope: string;
  sessionsMode: SessionsMode;
  sharedEpoch: string;
  sessions: ReadonlyMap<string, SessionInfo>;
  panesMode: "ok" | "unobservable";
  panesBySession: ReadonlyMap<string, PaneEntry[]>;
  psOk: boolean;
  psRows: PsTable | null;
  nowBoot: string;
  legacyBoot: string;
  tapBootIdSet: boolean;
  tapBootIdLegacySet: boolean;
  nowTs: number;
  families: readonly string[];
}

export function buildSnapshot(payload: ObservePayload, env: NodeJS.ProcessEnv = process.env): Snapshot {
  const pin = "server_epoch_pin" in payload ? (payload.server_epoch_pin || "") : null;
  const sessions = parseSessions(payload.sessions_text ?? "", Number(payload.sessions_rc ?? 1), pin);
  const panes = parsePanes(payload.panes_text ?? "", Number(payload.panes_rc ?? 1), pin);
  let panesMode = panes.mode;
  // A session-scoped snapshot promises every pane row belongs to that session.
  // ANY other key — a foreign session, or the "" sentinel for rows that failed
  // to name one — means the scoping invariant is broken (unscoped query,
  // misrouted fixture, truncated capture). Fail closed rather than drop the
  // stranger and judge seats on the subset. The unscoped roster batch
  // legitimately holds many sessions, so this is scope-conditional.
  const scope = payload.session_scope ?? "";
  if (scope && panesMode === "ok" && [...panes.bySession.keys()].some(name => name !== scope)) {
    panesMode = "unobservable";
  }
  const psOk = Number(payload.ps_rc ?? 1) === 0;
  return {
    sessionScope: scope,
    sessionsMode: sessions.mode,
    sharedEpoch: sessions.sharedEpoch,
    sessions: sessions.sessions,
    panesMode,
    panesBySession: panes.bySession,
    psOk,
    psRows: psOk ? parsePsTable(payload.ps_text ?? "") : null,
    nowBoot: payload.now_boot ?? "",
    legacyBoot: payload.legacy_boot ?? "",
    tapBootIdSet: Boolean(payload.tap_boot_id_set),
    tapBootIdLegacySet: Boolean(payload.tap_boot_id_legacy_set),
    nowTs: Number(payload.now_ts ?? 0),
    families: agentFamilies(env),
  };
}

export interface RowInput {
  key?: string; status?: string; delivery?: string; pane?: string; pane_id?: string;
  session?: string; registered_at?: string; row_epoch?: string; row_boot?: string;
  harness?: string; status_reason?: string;
}

/** `state\x1freason\x1fpane\x1fpane_id\x1fharness\x1fattached`. */
export function classifyRow(row: RowInput, snap: Snapshot, env: NodeJS.ProcessEnv = process.env): string {
  const status = row.status || "active";
  const delivery = row.delivery || "pane";
  const pane = row.pane || "";
  const paneId = row.pane_id || "";
  let session = row.session || "";
  const registeredAt = row.registered_at || "";
  const rowEpoch = row.row_epoch || "";
  const rowBoot = row.row_boot || "";
  const expectedHarness = row.harness || "";
  const storedReason = row.status_reason || "";
  const recovering = status === "suspended" && storedReason === "server_restarted" && !pane && !paneId;

  const sessionNames = new Set(snap.sessions.keys());
  let attached = "";
  const record = (...fields: string[]): string => fields.join(US);
  // A seat mid-recovery reports its recovery, not the probe's failure reason.
  const failed = (state: string, reason: string): string =>
    recovering ? record("offline", "server_restarted", "", "", "", "") : record(state, reason, "", "", "", "");

  const absenceConflict = (): string => {
    let elsewhere = false;
    for (const [name, entries] of snap.panesBySession) for (const entry of entries) {
      if ("_bad" in entry) return "pane_set_poisoned";
      if (paneId && name !== session && entry.pane_id === paneId) elsewhere = true;
    }
    return elsewhere ? "pane_session_conflict" : "";
  };

  if (status === "pending" && pendingReservationExpired(
    session, registeredAt,
    snap.sessionsMode === "ok" || snap.sessionsMode === "empty",
    sessionNames, snap.nowTs,
  )) return record("expired", "reservation_expired", "", "", "", "");

  if (delivery === "poll") return record(status, "stored_status", "", "", "", "");

  // A human-marked incapable seat stands on its own: the mark outranks every
  // recovery resolution, so even a perfectly healthy pane reads back
  // present-but-incapable with no live evidence attached.
  if (status === "suspended" && storedReason === "incapable") return record("suspended", "incapable", "", "", "", "");

  if (status !== "active" && !recovering) {
    if (status === "suspended" && storedReason === "server_restarted") return record("offline", "server_restarted", "", "", "", "");
    return record(status, "stored_status", "", "", "", "");
  }

  if (!pane && !paneId && !recovering) return record("unknown", "designated_pane_missing", "", "", "", "");

  if (rowBoot) {
    if (!snap.nowBoot) return failed("unknown", "boot_id_unobservable");
    if (!bootIdsMatch(rowBoot, snap.nowBoot, snap.legacyBoot, snap.tapBootIdSet, snap.tapBootIdLegacySet)) {
      return failed("offline", "boot_id_stale");
    }
  }

  if (!session && pane.includes(":")) session = pane.split(":", 1)[0]!;
  if (!session) return failed("unknown", "session_name_missing");
  if (snap.sessionsMode === "unobservable") return failed("unknown", "session_unobservable");

  const info = snap.sessions.get(session);
  let observedEpoch: string;
  if (snap.sessionsMode === "empty" || info === undefined) {
    // observed_absent — the epoch may still be known from other sessions.
    observedEpoch = snap.sharedEpoch || "";
    if (rowEpoch) {
      if (!observedEpoch) return failed("unknown", "server_epoch_unobservable");
      if (rowEpoch !== observedEpoch) return failed("offline", "server_epoch_stale");
    }
    const conflict = absenceConflict();
    if (conflict) return failed("unknown", conflict);
    return failed("gone", "session_absent");
  }
  observedEpoch = info.epoch;
  attached = info.attached || "";
  if (rowEpoch) {
    if (!observedEpoch) return failed("unknown", "server_epoch_unobservable");
    if (rowEpoch !== observedEpoch) return failed("offline", "server_epoch_stale");
  }

  const panes = sessionPanesFor(snap.panesBySession, snap.panesMode, session, observedEpoch);
  if (panes === null) return failed("unknown", "pane_set_unobservable");

  let selectedAddress = "", selectedId = "", selectedCommand = "", selectedPid = "";
  let selectedDead = false;
  if (recovering) {
    if (panes.length !== 1) return failed("unknown", "designated_pane_missing");
    ({ address: selectedAddress, pane_id: selectedId, command: selectedCommand, pane_pid: selectedPid, dead: selectedDead } = panes[0]!);
  } else {
    let addressId = "";
    for (const prec of panes) {
      if (pane && prec.address === pane) {
        addressId = prec.pane_id;
        if (!paneId) {
          selectedAddress = prec.address; selectedId = prec.pane_id;
          selectedCommand = prec.command; selectedPid = prec.pane_pid; selectedDead = prec.dead;
        }
      }
      if (paneId && prec.pane_id === paneId) {
        selectedAddress = prec.address; selectedId = prec.pane_id;
        selectedCommand = prec.command; selectedPid = prec.pane_pid; selectedDead = prec.dead;
      }
    }
    if (paneId) {
      // The recorded address now names a DIFFERENT pane: the window moved
      // under the seat. Not death, and not this pane — refuse to resolve.
      if (addressId && addressId !== paneId) return record("unknown", "address_rebound", "", "", "", "");
      if (!selectedId) {
        const conflict = absenceConflict();
        if (conflict) return failed("unknown", conflict);
        // A scoped scan cannot rule out this pane having moved to another session.
        return !snap.sessionScope && rowEpoch && isPaneId(paneId) && storedReason !== "launching"
          ? record("gone", "pane_absent", "", "", "", "")
          : record("unknown", "designated_pane_missing", "", "", "", "");
      }
    } else if (!addressId) return record("unknown", "designated_pane_missing", "", "", "", "");
  }

  // remain-on-exit preserves the command and physical identity. It cannot
  // attest a running harness, even when that cached command names an agent.
  if (selectedDead) return recovering ? failed("offline", "server_restarted")
    : record("offline", "pane_dead", selectedAddress, selectedId, "", attached);

  const { state: harnessState, family: observedHarness } = harnessEvidence(
    expectedHarness, selectedCommand, selectedPid, snap.psRows, snap.psOk, snap.families, env,
  );
  if (harnessState === "alive") {
    if (recovering) return record("unbound", "server_restarted", selectedAddress, selectedId, observedHarness, attached);
    return record("active", "", selectedAddress, selectedId, observedHarness, attached);
  }
  if (recovering) return failed("offline", "server_restarted");
  if (harnessState === "exited") return record("offline", "harness_exited", selectedAddress, selectedId, observedHarness, attached);
  if (harnessState === "mismatch") return record("unknown", "harness_mismatch", selectedAddress, selectedId, observedHarness, attached);
  if (harnessState === "unattested") return record("unknown", "harness_unattested", selectedAddress, selectedId, "", attached);
  return record("unknown", "harness_unobservable", selectedAddress, selectedId, "", attached);
}

/** Door 1: the whole roster from ONE snapshot. */
/**
 * The classification engine as a value, so a caller can drive a failing one.
 *
 * This exists because the port removed the only injection point the verb tests
 * had. Classification used to be a child process, and a fixture made it fail
 * by shadowing that interpreter on PATH. In-process there is no child to shadow, and
 * the alternative — an environment variable that makes production refuse — would
 * be a live defect vector shipped so a test could reach it. A parameter is
 * reachable from a test and from nowhere else.
 */
export type ObserveEngine = (payload: ObservePayload) => string[];

export function observeRows(payload: ObservePayload, env: NodeJS.ProcessEnv = process.env): string[] {
  const snap = buildSnapshot(payload, env);
  return (payload.rows ?? []).map(row => {
    const key = row.key || "";
    const record = classifyRow(row, snap, env);
    return key !== "" ? `${key}${US}${record}` : record;
  });
}

/** Door 2: one pid, for `tap_process_harness_observation`. */
export function observeHarnessPidFromTable(
  pid: string, psRows: PsTable | null, psOk: boolean, families: readonly string[],
): string {
  const { state, family } = observeProcessHarness(pid, psRows, psOk, families);
  return `${state}${US}${family}`;
}

/**
 * The one `ps` spelling. Three callers used to write this argv out themselves —
 * this module's `--harness-pid` door, `courier.ts`'s pid observation, and
 * `verbs/team.ts`'s roster gather — which is the duplication a shared
 * observation module exists to remove.
 *
 * A table that could not be read is `ok: false` with a null table, never an
 * empty-but-fine table. "ps did not answer" and "the pid is not in the table"
 * are different facts, and only the second one is an observation; collapsing
 * them is how an unobservable probe becomes a death certificate.
 */
export const PS_ARGV = ["-Ao", "pid=,pgid=,tpgid=,comm=,command="] as const;

/**
 * The one `ps` INVOCATION -- argv and buffer together, because the buffer is
 * part of the contract and splitting them is how the two drifted apart.
 *
 * `maxBuffer` is explicit and registry-sized. Bun's default is roughly 1 MiB,
 * and a busy host's full process table exceeds it: `spawnSync` then returns
 * `status=null`/ENOBUFS, `readProcessTable` reports the whole table
 * unobservable, and a live seat whose shallow command needs process inspection
 * is REFUSED -- machine load disabling delivery. The deleted Python captured
 * this output with no such ceiling, so a default-sized buffer is a regression
 * this port would have introduced, not an inherited limit.
 *
 * `timeoutMs` is optional: the roster can wait for a slow box, but the
 * point-of-effect identity guard holds recovery's pane mutex, and a synchronous
 * spawn is bounded only on the spawn itself.
 */
export function spawnProcessTable(env: NodeJS.ProcessEnv = process.env, timeoutMs?: number) {
  return spawnSync("ps", [...PS_ARGV], {
    encoding: "utf8", env, maxBuffer: REGISTRY_MAX_BUFFER,
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs, killSignal: "SIGKILL" as const }),
  });
}

export function readProcessTable(
  env: NodeJS.ProcessEnv = process.env,
): { table: PsTable | null; ok: boolean; error?: string } {
  try {
    const r = spawnProcessTable(env);
    if (r.status !== 0) {
      const error = (r.stderr?.trim() || r.error?.message || "").replace(/\s+/g, " ").slice(0, 500);
      return { table: null, ok: false, ...(error ? { error } : {}) };
    }
    return { table: parsePsTable(r.stdout ?? ""), ok: true };
  } catch (error) {
    return { table: null, ok: false, error: String(error).replace(/\s+/g, " ").slice(0, 500) };
  }
}

/**
 * The per-invocation memo over `readProcessTable`: one `ps -Ao` per CLI
 * process, shared by every harness-CLASSIFICATION site. Chooser snapshots and
 * other freshness-bound readers keep calling `readProcessTable` directly; a
 * classification site milliseconds later in the same invocation reads the same
 * family either way, so the memo trades one redundant scan for a stable answer.
 * A failed read is memoized as `ok: false` — the failure is itself the
 * observation, and re-scanning would only re-fail.
 */
let processTableMemo: { table: PsTable | null; ok: boolean } | null = null;
onInvocationMemoScope(() => { processTableMemo = null; });
export function readProcessTableMemoized(
  env: NodeJS.ProcessEnv = process.env,
): { table: PsTable | null; ok: boolean } {
  // Scoped and opt-in: only a `withInvocationMemo` scope (the register verb's
  // own body) may reuse a table. Anyone else — a long-lived process re-asking
  // after a restart — gets a fresh read, exactly as before the collapse.
  if (invocationMemoActive() && processTableMemo) return processTableMemo;
  const read = readProcessTable(env);
  if (invocationMemoActive()) processTableMemo = read;
  return read;
}

/**
 * CLI doors: `--boot-ids-match`, `--bound-pane`, `--harness-pid` and
 * `--gather-from-env`.
 *
 * A `--from-env` spelling used to take rows on stdin plus the snapshot as
 * TAP_OBS_* temp-file paths, the Python argv preserved. Its one caller was the
 * team-unbound-state fixture (`team-unbound-state.test.sh:39`); when that
 * fixture moved in-process it began driving a test-support builder
 * (`runtime/bun/test/support/observe-env-fixture.ts`) + `observeRows`
 * directly, and the spelling went with it, rather than surviving as a door
 * whose stated reason no longer existed. The bare payload-on-stdin classifier
 * spelling that used to answer unknown argv is deleted with it: a census taken at the removal
 * found no caller edge left for it either, and an unknown door now
 * refuses with exit 2 instead of silently classifying nothing.
 *
 * THE ENVIRONMENT IS READ HERE, in the process each door runs in or spawns,
 * exactly as the Python read it in the process Bash spawned. That is
 * deliberate: slice 1 shipped a defect where an in-process native caller
 * silently lost a configured `TAP_REGISTRY_EVENT_LIMIT`, because the Bash
 * adapter's env had reached the old writer only by virtue of being a child
 * process and an in-process call has no such inheritance moment. Every knob
 * these doors honor is resolved from the env they run with, never defaulted
 * at a call site.
 */
if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  if (argv[0] === "--boot-ids-match") {
    // The one symbol lib.sh's inline registry_sender_facts program imported from
    // the Python engine. It is NOT tmux.ts bootIdsMatch: that one is
    // three-valued (match/differ/unknown) and rejects equal-but-malformed
    // stamps before comparing, deliberately. This door is the BOOLEAN observation
    // predicate the sender-facts program has always used, so routing it to the
    // three-valued one would silently tighten a different contract (partner review
    // named this seam before the port began).
    //
    // The verdict is the TOKEN, never the exit status. This door used to answer
    // in its status, and a module that fails to LOAD exits 1 -- the same 1 a
    // computed "differ" uses -- so the one caller could not tell a stale boot
    // from a runtime that never ran, and reported a valid sender as
    // unregistered (tap-qa6e2). The process that failed is the one that would
    // have had to report the failure, so it cannot reserve a status for itself;
    // a token cannot be printed by a process that did not run. Anything else --
    // a non-zero status, empty output, an unknown word -- is the third state,
    // and the caller names it unobservable instead of guessing which of the two
    // answers it was: an empty or failed answer must never license the action
    // a real "no" would (the same shape `tap_slice_order_shaped` used in lib.sh).
    const [row, current, legacy, bootSet, legacySet] = argv.slice(1);
    const matched = bootIdsMatch(row ?? "", current ?? "", legacy ?? "", bootSet === "1", legacySet === "1");
    console.log(matched ? "boot-ids:match" : "boot-ids:differ");
    process.exit(0);
  }
  if (argv[0] === "--bound-pane") {
    if (argv.length !== 6) process.exit(2);
    const { boundPaneIdentityState } = await import("./observe-gather");
    process.stdout.write(boundPaneIdentityState(argv[2]!, argv[3]!, argv[4]!, argv[5]!, process.env, argv[1] === "0"));
  } else if (argv[0] === "--harness-pid") {
    // A failed ps or a vanished root prints "unobservable<US>" — the Python
    // swallowed its own errors here and the Bash caller discards stderr.
    const { table, ok } = readProcessTable();
    console.log(observeHarnessPidFromTable(argv[1] ?? "", table, ok, agentFamilies()));
  } else if (argv[0] === "--gather-from-env") {
    // The snapshot is collected HERE. The retired Bash caller had already run
    // tmux and `ps` into temp files for the deleted `--from-env` door, and
    // this door kept that adapter thin; it outlives the spelling it served.
    // The gather module is imported dynamically so that library consumers of
    // `observe.ts` — the classifier — do not pull in `tmux.ts` and its
    // process-spawning machinery.
    const stdin = await Bun.stdin.text();
    const { gatherRowsFromEnv } = await import("./observe-gather");
    for (const line of gatherRowsFromEnv(JSON.parse(stdin) as RowInput[])) console.log(line);
  } else {
    // No hidden classifier door. The payload-on-stdin spelling that used to
    // live here had no caller edges left when the Bash door went (census
    // quoted in the removal), so an unknown door refuses rather than silently
    // reading and classifying nothing.
    process.stderr.write("observe.ts: unknown door\n");
    process.exit(2);
  }
}
