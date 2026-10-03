// `tap team attach`'s planner: partition a team's session snapshot into
// live / unavailable / spared rows. Port of session/attach_partition.py,
// deleted in the same PR.
//
// It is a pure function of a snapshot plus two selection sets. It writes only
// to the three output paths its caller allocated and named, and it APPENDS —
// the caller may already have written to them. It touches no registry, no bus,
// no index and no tmux.
//
// The planner was extracted out of a heredoc inside tap-team-attach.sh (tap-sttl)
// because in there it could only be reached by a full attach run: the
// malformed-handle refusal and the selection rule were undrivable, and a
// reviewer's mutation of either survived every suite. Keeping it a separately
// callable unit is the whole reason those behaviors have arms at all.

import { appendFileSync, readFileSync } from "node:fs";

import { sanitizeComponent } from "./naming";

type Row = Record<string, unknown>;

/** Python truthiness: `""`, `0`, `false`, `null`, `undefined`, `[]` and `{}` are all falsy. */
function pythonFalsy(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.length === 0;
  if (typeof value === "number") return value === 0;
  if (typeof value === "boolean") return !value;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/**
 * `tap_seat_spared`'s rule, asked against THIS snapshot.
 *
 * `--only` arrives as a POSITIVE set and is resolved here rather than as a
 * complement precomputed in Bash: the snapshot is what attach is about to act
 * on, so a seat that registered after the earlier registry read still lands on
 * the correct side. Precomputing froze an answer that could already be stale.
 */
export function spared(handle: string, excepted: Set<string>, only: Set<string>): boolean {
  if (only.size) return !only.has(handle);
  return excepted.has(handle);
}

export class PartitionRefusal extends Error {}

/**
 * The row's canonical handle, or refuse.
 *
 * Two different failures are prevented here.
 *
 * Re-deriving the handle by stripping `<team>/` off the session NAME is wrong
 * for a noncanonical session (registry handle `grok` living in
 * `demo/legacy-scout` derives as `legacy-scout`) and for any index>1 seat.
 * Selection sets are keyed on registry handles, so a mis-derived handle matched
 * nothing and the seat was planned despite being spared — under `--except` a
 * seat the operator asked to skip, under `--only` one they never named.
 *
 * And the check is a string test, not a coercion: `String(raw ?? "")` turns
 * `7`, `[]` or `{}` into a nonempty pseudo-handle that sails past the guard and
 * then matches no selection entry — so the fail-closed branch would never fire
 * on exactly the malformed input it exists for.
 *
 * There is deliberately NO fallback to the old derivation: silently reverting
 * to it is the failure being fixed, and the snapshot comes from the same
 * launcher in the same invocation, so no version window exists.
 */
export function canonicalHandle(row: Row, name: string): string {
  const raw = row.handle;
  if (typeof raw === "string" && raw.length > 0) return raw;
  throw new PartitionRefusal(
    `tap team attach: session row ${pyRepr(name)} carries no usable canonical ` +
    `handle (got ${pyRepr(raw)}); refusing rather than re-deriving one from ` +
    "the session name",
  );
}

/**
 * The incumbent interpolated these two values with Python's `!r`, and that
 * message is the one operators see — ten of the frozen cases assert it
 * byte-exact, so this is contract rather than decoration. Only the shapes a
 * JSON row can hold are reachable: a string, a number, a bool, null, a list or
 * an object.
 *
 * The string branch is the part with teeth. Python picks the quote (single,
 * unless the value contains a single quote and no double quote), doubles
 * backslashes, escapes the chosen quote, and renders control bytes as `\n`,
 * `\r`, `\t` or `\xNN`. A handle carrying an ESC sequence is exactly the
 * input where a naive repr writes raw control bytes into an operator's
 * terminal (partner review). Printable non-ASCII stays as itself, as Python 3
 * does.
 */
function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return pyReprString(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  return `{${Object.entries(value as object).map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`).join(", ")}}`;
}

const CONTROL_ESCAPES: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };

/**
 * Python's `str.isprintable()`: false for the C categories (Cc, Cf, Cs, Co,
 * Cn) and for separators other than a plain space.
 *
 * An ASCII-range test is not this. U+009B is a C1 control, U+00A0 a
 * non-breaking space and U+00AD a soft hyphen — all above 0x7f, all escaped by
 * the incumbent, and all printed RAW by a `< 0x20 || === 0x7f` predicate, which
 * leaves the control-output problem open for exactly the characters an ASCII
 * check cannot see (partner review). `\p{C}` covers the C categories,
 * including unassigned code points, and `\p{Z}` the separators.
 */
const NON_PRINTABLE = /\p{C}|\p{Z}/u;

function pythonPrintable(ch: string): boolean {
  return ch === " " || !NON_PRINTABLE.test(ch);
}

/** Python widens the escape to the code point: `\xNN`, `\uNNNN`, then `\UNNNNNNNN`. */
function escapeCodePoint(code: number): string {
  if (code < 0x100) return `\\x${code.toString(16).padStart(2, "0")}`;
  if (code < 0x10000) return `\\u${code.toString(16).padStart(4, "0")}`;
  return `\\U${code.toString(16).padStart(8, "0")}`;
}

function pyReprString(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of value) {
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${ch}`;
    else if (CONTROL_ESCAPES[ch]) out += CONTROL_ESCAPES[ch];
    else out += pythonPrintable(ch) ? ch : escapeCodePoint(ch.codePointAt(0)!);
  }
  return `${quote}${out}${quote}`;
}

/**
 * The `revive` column. Every Python-falsy value becomes `-`.
 *
 * A non-falsy NON-string is unreachable from production — `launcher.py`'s
 * `revive_tier()` returns only `-`, `exact`, `picker`, `latest` or `fresh`, and
 * `cmd_list` is what fills the snapshot — so the incumbent's Python `repr` of a
 * list or dict is a spelling nobody depends on. This renders those as JSON
 * instead of reproducing `repr`, which is the one deliberate divergence in this
 * port; every other recorded outcome is exact.
 */
function reviveColumn(value: unknown): string {
  if (pythonFalsy(value)) return "-";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function selectionSet(blob: string): Set<string> {
  return new Set(blob.split("\n").filter(Boolean));
}

export interface PartitionPaths {
  snapshotPath: string;
  team: string;
  livePath: string;
  unavailablePath: string;
  excludedPath: string;
  exceptBlob: string;
  onlyBlob: string;
}

/** One planned row: the session name, its canonical handle, and the third column. */
export interface PlannedRow {
  name: string;
  handle: string;
  /** `revive` tier for live/unavailable rows; `live`/`unavailable` for spared rows. */
  third: string;
}

export interface Partitioned {
  live: PlannedRow[];
  unavailable: PlannedRow[];
  excluded: PlannedRow[];
}

/**
 * The file-writing contract the Bash caller used: three caller-allocated
 * paths, APPENDED to, one row at a time — so a refusal on a later row leaves
 * the earlier rows written, exactly as the incumbent's streaming `print` did
 * (the frozen oracle's `handle_bad_after_good` pins that). Kept as the CLI's
 * shape and as the oracle's subject; the native `tap team attach` collects the
 * same stream through `partitionSnapshot` instead.
 */
export function partition(args: PartitionPaths): void {
  const bytes = readFileSync(args.snapshotPath);
  const paths = { live: args.livePath, unavailable: args.unavailablePath, excluded: args.excludedPath };
  for (const { kind, row } of partitionRows(bytes, args.team, selectionSet(args.exceptBlob), selectionSet(args.onlyBlob))) {
    appendFileSync(paths[kind], `${[row.name, row.handle, row.third].join("\x1f")}\n`);
  }
}

/** The whole plan at once; a refusal mid-stream is the caller's refusal. */
export function partitionSnapshot(bytes: Uint8Array, team: string, excepted: Set<string>, only: Set<string>): Partitioned {
  const out: Partitioned = { live: [], unavailable: [], excluded: [] };
  for (const { kind, row } of partitionRows(bytes, team, excepted, only)) out[kind].push(row);
  return out;
}

/**
 * The planner as a pure function of the snapshot BYTES plus two selection
 * sets, yielding rows in the order the file contract wrote them: sorted by
 * session name, each row landing in exactly one of the three lists.
 */
export function* partitionRows(bytes: Uint8Array, team: string, excepted: Set<string>, only: Set<string>): Generator<{ kind: keyof Partitioned; row: PlannedRow }> {
  // STRICT decode, not a lenient read. The incumbent opened the snapshot in
  // text mode, so an invalid byte raised UnicodeDecodeError and the caller
  // refused; `readFileSync(path, "utf8")` substitutes U+FFFD instead and plans
  // the row (partner review). `ignoreBOM: true` means do NOT strip a leading
  // BOM, which keeps Python's behaviour: the BOM reaches JSON.parse and the
  // parse fails, where a stripping decoder would silently succeed.
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const parsed: unknown = JSON.parse(text);
  // The incumbent reached the rows through `data.get("sessions", [])`, so a
  // document that is not an object raised AttributeError and the caller
  // refused. A list, a number and a bare null all take that path -- each is a
  // reachable shape from a `launcher.py list --json` that failed strangely or a
  // truncated write, and reading any of them as an empty plan would attach
  // nothing while reporting success.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const kind = parsed === null ? "NoneType" : Array.isArray(parsed) ? "list" : typeof parsed;
    throw new TypeError(`'${kind}' object has no attribute 'get'`);
  }
  const data = parsed as Row;

  // The team NAME and the team's tmux session BASE are not the same string
  // (tap-rxmgp). tmux reads `.` as the session:window.pane separator, so the
  // launcher names every session `sanitizeComponent(<team>)/<handle>` —
  // `demo.alpha.107-Renewal` becomes `demo-alpha-107-Renewal/`.
  // Matching the RAW name meant that on a dotted team EVERY row failed this
  // filter: nine live seats partitioned into an empty live set, `tap team
  // attach` answered "no live seats", and `--only` reported "matched every
  // seat — none spared" because the set it was selecting over was empty.
  //
  // The prefix is computed by the same function that NAMED the session, which
  // is the claim that survives a future change to the naming rule. The weaker
  // claim — "sanitizeComponent is the identity for a team name tmux accepts" —
  // is FALSE and is not what this rests on: `my--team` becomes `my-team`,
  // `-team` and `team-` become `team`, `a b` becomes `a-b`, and every one of
  // those is a legal tmux session name.
  const prefix = `${sanitizeComponent(team)}/`;
  const sessions = (data as { sessions?: unknown }).sessions;
  const rows: Array<{ name: string; row: Row }> = [];
  // A non-iterable `sessions` raises, exactly as the incumbent's `for` did: a
  // snapshot that is not a snapshot must reach the caller's refusal, not read
  // as an empty plan.
  for (const candidate of iterate(sessions)) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const row = candidate as Row;
    // A NON-STRING name is skipped, which is what the incumbent did — but NOT
    // by the same route, and the difference is a live defect rather than a
    // nicety. Python coerced with `str()`, so `["demo/a"]` became
    // `"['demo/a']"` and failed the prefix; JS `String()` makes it `"demo/a"`,
    // which PASSES and plans a row Python never planned (partner review). No
    // Python spelling of a non-string can start with a team prefix — a list
    // opens with `[`, an object with `{`, and numbers/bools/None carry no
    // slash — so skipping them outright is identical in effect and does not
    // route a value through a coercion whose two languages disagree.
    if (typeof row.name !== "string") continue;
    const name = row.name;
    if (!name.startsWith(prefix)) continue;
    rows.push({ name, row });
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const { name, row } of rows) {
    const handle = canonicalHandle(row, name);
    const revive = reviveColumn(row.revive);
    // An IDENTITY check, not truthiness: `live: 1` and `live: "yes"` are both
    // unavailable, as `row.get("live") is True` made them.
    const live = row.live === true;
    // tap-nt4c: a spared seat leaves the plan HERE, before any viewer is
    // planned or any client probed — and it is recorded, never dropped, so
    // the receipt can name it. Whether it was live matters: only a spared
    // LIVE seat can be the reason the plan came out empty.
    if (spared(handle, excepted, only)) {
      yield { kind: "excluded", row: { name, handle, third: live ? "live" : "unavailable" } };
      continue;
    }
    yield { kind: live ? "live" : "unavailable", row: { name, handle, third: revive } };
  }
}

/** Python's `for row in data.get("sessions", [])`: absent is empty, non-iterable raises. */
function iterate(sessions: unknown): Iterable<unknown> {
  if (sessions === undefined) return [];
  if (Array.isArray(sessions)) return sessions;
  // A string iterates its characters and a dict its keys — both then fail the
  // is-a-dict row test and are skipped, which is why those snapshots plan
  // nothing rather than refusing.
  if (typeof sessions === "string") return sessions;
  if (typeof sessions === "object" && sessions !== null) return Object.keys(sessions);
  throw new TypeError(`'${sessions === null ? "NoneType" : typeof sessions}' object is not iterable`);
}

if (import.meta.main) {
  const [snapshotPath, team, livePath, unavailablePath, excludedPath, exceptBlob, onlyBlob] = process.argv.slice(2);
  if (snapshotPath === undefined || team === undefined || livePath === undefined
      || unavailablePath === undefined || excludedPath === undefined
      || exceptBlob === undefined || onlyBlob === undefined) {
    process.stderr.write("usage: attach-partition.ts <snapshot.json> <team> <live> <unavailable> <excluded> <except_blob> <only_blob>\n");
    process.exitCode = 2;
  } else {
    try {
      partition({ snapshotPath, team, livePath, unavailablePath, excludedPath, exceptBlob, onlyBlob });
    } catch (error) {
      // The caller maps ANY nonzero to `session_list_invalid`, so the exit
      // status is the contract and the message is the diagnostic. A refusal the
      // planner authors prints its own sentence; a malformed snapshot prints
      // what went wrong rather than a stack the operator cannot act on.
      process.stderr.write(`${error instanceof PartitionRefusal ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
