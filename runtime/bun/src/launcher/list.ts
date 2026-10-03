import { launchWorkdir } from "./workdir";
// `tap session list` — the native session snapshot behind `tap session [list]`.
// Port of session/launcher.py cmd_list and its list-only helpers (render_table,
// completion_names, recency_key, machine_registry_session_state), deleted in the
// same PR; the shared read path reuses the live twins (registry resolution via
// index-home, the relaunch predicate via complete.ts, revive tiers via
// resume-identity, root resolution via bushome, the tmux seam via tmux.ts, and
// team.ts's table renderer). The rubric is BYTE fidelity: JSON compact +
// ensure_ascii in the incumbent's insertion order, the fixed 9-column table with
// width pressure on cwd only, refusals as `tap session: <msg>` (rc 2) or, under
// TAP_JSON=1, the session_error envelope on stdout. One deliberate drift: the
// header row carries no tty styled() wrapper — plain bytes on every door.
//
// Further ruled deviations (ceiling-400 brief, BIN B): a BOM-prefixed acting
// registry is ACCEPTED (the decoder strips U+FEFF); parse faults keep the JS
// SyntaxError message instead of CPython prose; NaN/Infinity literals refuse;
// and ordering is native UTF-16, which differs from Python only for astral-vs-
// private-use names — no consumer branches on any of the three.
import { readFileSync } from "node:fs";
import { ensureAscii } from "../fsatomic";
import { isRegularFile, loadGlobalRegistry } from "../index-home";
import { errorJson as rawErrorJson, humanLine } from "../native-error";
import { ServerUnresponsive, tmuxReadOnly } from "../tmux";
import { HARNESSES } from "./catalog";
import { actingRegistryPath, NoMachineIndex, isDict, nonEmpty, pathIsUnder, payloadRecords, realOrSelf, rootForCwd, sessionHandle, SessionStateError as ListRefusal, type Row, type SessionRecord as ListRecord } from "./records";
import { classifySession } from "./observation";
import { recordHasResumeArtifact, seatReviveTier } from "./resume-identity";
import { LauncherError } from "./types";
import { lookupHelp } from "../help";
import { teamRegistryRefusal } from "../register-authority";
import { table } from "../verbs/team";

/** The envelope with CR/LF in action and detail folded to spaces, so one refusal is one JSON line even when it echoes
 * operator text (an operand with an embedded newline): the shape `tap_error_line` and team attach use. */
const errorJson = (errorClass: string, action: string, detail: string): string => rawErrorJson(errorClass, humanLine(action), humanLine(detail));

const TMUX_REFUSAL = "tmux session-name snapshot is unobservable; refusing to treat the session namespace as empty";
const TMUX_CLASSIFY_DEADLINE_MS = 5000;
const TMUX_NO_SERVER = [/^no server running on .+$/, /^error connecting to .+ \(No such file or directory\)$/];

function tmuxSessionSnapshot(): { names: Set<string>; liveNames: Set<string> } {
  let run;
  try {
    run = tmuxReadOnly(["list-panes", "-a", "-F", "#{session_name}\t#{pane_dead}"]);
  } catch (error) {
    // The shared seam's one known transport failure (client deadline / fork
    // failure) is the same unobservable namespace as a crashed tmux; anything
    // else is a programming error and propagates.
    if (error instanceof ServerUnresponsive) throw new ListRefusal(TMUX_REFUSAL);
    throw error;
  }
  const names = new Set<string>(), liveNames = new Set<string>();
  if (run.code === 0) {
    for (const line of run.stdout.split("\n").filter(line => line.length > 0)) {
      const fields = line.split("\t");
      if (fields.length !== 2 || !fields[0] || !["0", "1"].includes(fields[1]!)) throw new ListRefusal(TMUX_REFUSAL);
      names.add(fields[0]);
      if (fields[1] === "0") liveNames.add(fields[0]);
    }
    return { names, liveNames };
  }
  const stderr = run.stderr.trim();
  if (TMUX_NO_SERVER.some((pattern) => pattern.test(stderr))) return { names, liveNames };
  // A missing tmux binary lands here too: empty stderr is not a no-server
  // answer, and an unobservable namespace must not read as empty.
  throw new ListRefusal(TMUX_REFUSAL);
}

function readRegistryDoc(path: string): Row {
  let doc: unknown;
  try {
    doc = JSON.parse(readRegistryText(path));
  } catch (error) {
    throw new ListRefusal(`acting registry unreadable: ${(error as Error).message}; next: tap doctor`);
  }
  if (!isDict(doc)) throw new ListRefusal("acting registry root is not an object; next: tap doctor");
  refuseOldStore(path, doc);
  return doc;
}

/** An old-format registry is a typed refusal, never a list without its seats. */
function refuseOldStore(path: string, doc: Row): void {
  const refusal = teamRegistryRefusal(path, doc);
  if (refusal) throw new LauncherError(refusal.detail, refusal.errorClass, refusal.action, refusal.detail);
}

/** Strict-UTF-8 read whose decoder strips a leading BOM (TextDecoder's default
 *  polarity): a BOM-prefixed acting registry is accepted, the ruled deviation
 *  from the incumbent's plain-utf8 decoder (BIN B, ceiling-400 brief). Parse
 *  faults keep the JS SyntaxError message — no parser-prose compatibility. */
function readRegistryText(path: string): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
}

/** load_state_doc twin: a MISSING team registry is an empty walk, not an error;
 *  a present-but-broken one throws raw for the walk's caller to label with the
 *  team name. */
function loadTeamDoc(path: string): Row | null {
  if (!isRegularFile(path)) return null;
  const doc = JSON.parse(readRegistryText(path));
  if (!isDict(doc)) throw new Error(`registry state doc is not an object: ${path}`);
  return doc;
}

function cwdStateRecords(cwd: string): ListRecord[] {
  const root = rootForCwd(cwd);
  const path = actingRegistryPath(root);
  return path ? payloadRecords(readRegistryDoc(path), root) : [];
}

function machineStateRecords(cwd: string): ListRecord[] {
  const snapshot = loadGlobalRegistry();
  if (snapshot.marker === "invalid") throw new ListRefusal("global registry is invalid; next: tap doctor");
  if (snapshot.marker === "absent") throw new NoMachineIndex();
  const teams = snapshot.doc!.teams;
  if (!isDict(teams)) return [];
  const records: ListRecord[] = [];
  for (const [teamName, enrollment] of Object.entries(teams)) {
    if (!isDict(enrollment) || String(enrollment.state ?? "registered") === "historical") continue;
    const root = enrollment.root;
    const location = enrollment.registry_location;
    if (!nonEmpty(root) || !nonEmpty(location)) continue;
    let payload: Row | null;
    try {
      payload = loadTeamDoc(location);
    } catch (error) {
      throw new ListRefusal(`acting registry for team '${teamName}' is unreadable: ${(error as Error).message}; next: tap doctor`);
    }
    if (payload) refuseOldStore(location, payload);
    if (payload) records.push(...payloadRecords(payload, root));
  }
  return records;
}

/** One list row's computed cells: the single source for the table and --json. */
interface ListRow { record: ListRecord; live: boolean; revive: string; cwd: string }

/** The list's tmux reads are bounded; the classifier's own are not, so a client that stalls after the
 * snapshot is the same unobservable namespace as one that stalled during it. */
async function classifyBounded(name: string): Promise<string> {
  const deadline = AbortSignal.timeout(TMUX_CLASSIFY_DEADLINE_MS);
  try {
    const verdict = await classifySession(name, process.env, deadline);
    // A cancelled child reads as a nonzero tmux exit, which the classifier answers "unknown"; that is an
    // expired deadline, not an observation, so it must not reach the attachable predicate.
    deadline.throwIfAborted();
    return verdict;
  } catch {
    throw new ListRefusal(TMUX_REFUSAL);
  }
}

/**
 * The revive word for one row. A cursor row with a stored chat id is the only
 * one that needs evidence: it reads "stale" when resume's artifact probe finds
 * no conversation store and nothing is attachable (a present tmux session that
 * is not a shell, resume's own predicate). Every other row, and every cursor
 * row the probe or a pane vouches for, keeps the raw-id tier.
 */
async function reviveFor(record: ListRecord, present: boolean): Promise<string> {
  const storedId = record.harnessSessionId;
  if (record.harness !== "cursor" || !storedId) return seatReviveTier(record.harness, storedId, true, false);
  const probe = { name: record.name, harness: record.harness, cwd: record.cwd, base: record.base, harness_session_id: storedId,
    ...(record.launch_workdir === undefined ? {} : { launch_workdir: record.launch_workdir }),
    harness_env: record.harnessEnv ?? {}, harness_unset_env: record.harnessUnsetEnv ?? [] };
  const resumable = recordHasResumeArtifact(probe, process.env);
  // Classify only when the verdict could change: an artifact-less row whose session is present.
  const attachable = !resumable && present && !["shell", "attached-shell"].includes(await classifyBounded(record.name));
  return seatReviveTier(record.harness, storedId, resumable, attachable);
}

async function listRows(records: ListRecord[], names: Set<string>, liveNames: Set<string>): Promise<ListRow[]> {
  const rows: ListRow[] = [];
  for (const record of records) {
    rows.push({ record, live: liveNames.has(record.name), revive: await reviveFor(record, names.has(record.name)), cwd: launchWorkdir(record) });
  }
  return rows;
}

function sessionListJson(rows: ListRow[], machine: boolean): string {
  const sessions = rows.map(({ record, live, revive, cwd }) => {
    const row: Row = {
      name: record.name, harness: record.harness, cwd,
      live, seated: true, restorable: true,
      revive,
      model: record.model, tag: record.tag, handle: sessionHandle(record),
      last_seen: record.lastSeen, last_launched: record.lastLaunched,
    };
    if (record.preset) row.preset = record.preset;
    return row;
  });
  return ensureAscii(JSON.stringify({ ok: true, sessions, count: sessions.length, scope: machine ? "machine" : "cwd" }));
}

const HEADERS = ["name", "harness", "live", "seated", "revive", "model", "preset", "last seen", "cwd"];

/** completion_names: cwd-matching rows first, then name, then unseen tmux. */
function completionNames(records: ListRecord[], harness: string | null, cwd: string, tmux: Set<string>): string[] {
  const cwdReal = realOrSelf(cwd);
  const under = (record: ListRecord) => (realOrSelf(record.cwd) === cwdReal ? 0 : 1);
  const names = records
    .filter((record) => !harness || record.harness === harness)
    .sort((a, b) => under(a) - under(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((record) => record.name);
  const seen = new Set(names);
  for (const name of [...tmux].sort()) {
    if (!seen.has(name)) {
      names.push(name);
      seen.add(name);
    }
  }
  return names;
}

interface ListArgs {
  harness: string | null; cwd: string; all: boolean; live: boolean;
  machine: boolean; json: boolean; namesOnly: boolean; includeTmux: boolean;
}

const FLAGS = { "--all": "all", "--live": "live", "--machine": "machine", "--json": "json", "--names-only": "namesOnly", "--include-tmux": "includeTmux" } as const;
const USAGE = "usage: tap session list [--harness HARNESS] [--cwd CWD] [--all] [--live] [--machine] [--json] [--names-only] [--include-tmux]\n";

/** `-h`/`--help` asked for the usage; not a refusal, so it is its own signal. */
class ListHelp extends Error {}

/** A parser refusal: `unknown_option` for a flag the command does not have, `usage_error` for a bad operand
 * (the classes `tap health` and `tap read` use). Text mode prints the usage line; JSON mode the envelope. */
class ListUsage extends Error {
  constructor(readonly errorClass: "unknown_option" | "usage_error", readonly detail: string) { super(detail); }
}

/** argparse's rule: a token starting with "-" is an option, so it cannot be a split option's operand and
 * an unknown one is a usage error. The option NAME (the text before the first "=") is checked against every
 * known option first (`-h`, `--help`, the flags, `--harness`, `--cwd`); a known name is an option whatever
 * follows the "=". Only an otherwise-unknown dash token is exempt when it is a bare "-", a negative number,
 * or holds a space. */
const isKnownListOption = (token: string): boolean => {
  const name = token.split("=", 1)[0]!;
  return name === "-h" || name === "--help" || name === "--harness" || name === "--cwd" || Object.hasOwn(FLAGS, name);
};
const isListOption = (token: string): boolean =>
  isKnownListOption(token)
  || (token.startsWith("-") && token !== "-" && !/^-\d+$|^-\d*\.\d+$/.test(token) && !token.includes(" "));

function parseListArgs(argv: string[]): ListArgs {
  const args: ListArgs = { harness: null, cwd: process.cwd(), all: false, live: false, machine: false, json: false, namesOnly: false, includeTmux: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") throw new ListHelp();
    const valued = arg.match(/^--(harness|cwd)(?:=(.*))?$/);
    if (valued) {
      // An inline value keeps its literal text (`--cwd=-x`); a split operand that is itself an option is missing.
      if (valued[2] === undefined && isListOption(argv[i + 1] ?? "")) throw new ListUsage("usage_error", `--${valued[1]} needs a value`);
      const value = valued[2] ?? argv[++i];
      if (value === undefined) throw new ListUsage("usage_error", `--${valued[1]} needs a value`);
      if (valued[1] === "cwd") args.cwd = value;
      else {
        if (!HARNESSES.includes(value)) throw new ListUsage("usage_error", `--harness '${value}' is not a supported harness`);
        args.harness = value;
      }
      continue;
    }
    // Own keys only: `constructor` or `__proto__` must not resolve to an inherited property.
    // An option-shaped token is an unknown option; a bare operand is an unexpected argument.
    if (!Object.hasOwn(FLAGS, arg)) throw arg.startsWith("-") ? new ListUsage("unknown_option", `unknown option '${arg}'`) : new ListUsage("usage_error", `unexpected argument '${arg}'`);
    const flag = FLAGS[arg as keyof typeof FLAGS];
    args[flag] = true;
  }
  return args;
}

function recencyLess(a: ListRecord, b: ListRecord): number {
  const key = (record: ListRecord) => record.lastSeen ?? record.lastLaunched ?? "";
  const first = key(a), second = key(b);
  // One order for every view: (recency, name) descending, stable for ties.
  return first < second ? 1 : first > second ? -1 : a.name < b.name ? 1 : a.name > b.name ? -1 : 0;
}

async function renderList(args: ListArgs): Promise<number> {
  const records = args.machine ? machineStateRecords(args.cwd) : cwdStateRecords(args.cwd);
  // One all-window inventory distinguishes retained sessions from running ones.
  const { names, liveNames } = tmuxSessionSnapshot();
  if (args.namesOnly && args.includeTmux) {
    const completions = completionNames(records, args.harness, args.cwd, names);
    if (completions.length) process.stdout.write(`${completions.join("\n")}\n`);
    return 0;
  }
  // The incumbent re-probes git per record for in_scope; the cwd is constant,
  // so the root is computed once — same answer, fewer children.
  const scopeRoot = args.machine ? null : rootForCwd(args.cwd);
  const filtered = records.filter((record) =>
    (!args.harness || record.harness === args.harness)
    && (!scopeRoot || pathIsUnder(record.cwd, scopeRoot))
    && (!args.live || liveNames.has(record.name)));
  filtered.sort(recencyLess);
  if (args.json) {
    process.stdout.write(`${sessionListJson(await listRows(filtered, names, liveNames), args.machine)}\n`);
    return 0;
  }
  if (filtered.length === 0) {
    if (!args.namesOnly) process.stdout.write("tap session: no sessions\n");
    return 0;
  }
  if (args.namesOnly) {
    process.stdout.write(`${filtered.map((record) => record.name).join("\n")}\n`);
    return 0;
  }
  process.stdout.write(table(HEADERS, (await listRows(filtered, names, liveNames)).map(({ record, live, revive, cwd }) => [
    record.name,
    record.harness,
    live ? "yes" : "no",
    "yes",
    revive,
    record.model ?? "-",
    record.preset?.name ?? "-",
    record.lastSeen ?? "-",
    cwd,
  ])));
  return 0;
}

export async function cmdSessionList(argv: string[]): Promise<number> {
  let args: ListArgs;
  try {
    args = parseListArgs(argv);
  } catch (error) {
    // Help is answered before any registry or tmux access, as argparse's subparser did.
    // The canonical page (help.ts), so `tap help session list` and `tap session list --help` are one text.
    if (error instanceof ListHelp) { process.stdout.write(lookupHelp(["session", "list"]).stdout); return 0; }
    // The parser failed before it could set args.json, so JSON intent is read from argv (any `--json` token) or TAP_JSON.
    if (error instanceof ListUsage && (process.env.TAP_JSON === "1" || argv.includes("--json"))) {
      process.stdout.write(errorJson(error.errorClass, "tap help session list", `${error.detail}; ${USAGE.trim()}`));
    } else process.stderr.write(USAGE);
    return 2;
  }
  // --json alone selects the envelope, as TAP_JSON=1 does.
  const json = args.json || process.env.TAP_JSON === "1";
  try {
    return await renderList(args);
  } catch (error) {
    if (error instanceof LauncherError && error.errorClass === "old_store") {
      if (json) process.stdout.write(errorJson("old_store", error.action ?? "", error.detail ?? error.message));
      else process.stderr.write(`tap session: ${error.detail ?? error.message}; next: ${error.action ?? ""}\n`);
      return 1;
    }
    if (!(error instanceof ListRefusal)) throw error;
    if (error instanceof NoMachineIndex) {
      if (json) process.stdout.write(errorJson(error.errorClass, error.action, error.detail));
      else process.stderr.write(`tap session: ${error.message}\n`);
      return 2;
    }
    if (json) process.stdout.write(errorJson("session_error", "tap help session", error.message));
    else process.stderr.write(`tap session: ${error.message}\n`);
    return 2;
  }
}

if (import.meta.main) process.exitCode = await cmdSessionList(process.argv.slice(2));
