// `tap team attach [team]` — open viewers onto a team's live tmux sessions.
// Existing viewers are skipped unless --all requests additional clients.
//
// Shape, in order: options → selection gates → team root → session catalog
// snapshot → partition (live / unavailable / spared) → one client snapshot per
// live session → layout → the
// AppleScript plan → the four exits (empty plan, nothing new, dry-run, open)
// → a bounded proof that a NEW tmux client appeared for every planned seat.
//
// Reads the registry and asks tmux; never writes either. The only effect is
// osascript, and a successful osascript exit alone is not taken as proof: the
// verify loop looks for a client tty that was not in the pre-open snapshot.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { TapError, resolveContext, type ResolvedContext } from "../context";
import { loadRegistry, seatMap } from "../registry";
import { REGISTRY_MAX_BUFFER } from "../spawn";
import { pythonStrip } from "../clear-fence";
import { physicalSocketPath, tmuxReadOnly } from "../tmux";
import { PartitionRefusal, partitionSnapshot, type Partitioned } from "../launcher/attach-partition";
import { renderRefusals, renderRefusalsAsync } from "../error-line";
import { seatIsRelaunchable } from "../launcher/complete";
import { shellQuote } from "../shell-quote";
import { shlexQuote } from "../launcher/invocation";
import { itermViewerScript } from "../iterm-viewer";
import {
  crewSelectGate, lenientSeats, noSelection, parseSelection, registryRoster, rosterGate, selectConflictGate,
  selectFlag, selectOperand, selectSummary, selectTyped, type Selection,
} from "./selection";
import { assertBoundSeats, chooseSeatCohort, chooseTeam, confirmAction, discoveryTerminalAvailable, parentSeatSnapshot, revalidateTeam, requireDiscoveryTerminal, type BoundCohort, type BoundTeam } from "./discovery";
import { pick } from "../fzf";
import { tapScriptsDir, artifactBun, runtimeModule } from "../scripts-dir";

const VERB = "team attach";
const LABEL = `tap ${VERB}`;

function fail(klass: string, action: string, detail: string): never {
  throw new TapError(1, klass, action, detail, LABEL);
}

function receipt(text: string, stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`${LABEL}: ${text}\n`);
}

interface Options {
  dryRun: boolean;
  tabs: boolean;
  all: boolean;
  team?: string;
  exceptRaw?: string;
  onlyRaw?: string;
  pending?: "--only" | "--except";
  yes: boolean;
}

function parseArgs(argv: string[]): Options {
  let dryRun = false;
  let tabs = false;
  let all = false;
  let team: string | undefined;
  let exceptRaw: string | undefined;
  let onlyRaw: string | undefined;
  let pending: "--only" | "--except" | undefined;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--dry-run": dryRun = true; break;
      case "--tabs": tabs = true; break;
      case "--all": all = true; break;
      case "--yes": yes = true; break;
      case "--except":
        if (onlyRaw !== undefined || pending === "--only") selectConflictGate(VERB);
        if (exceptRaw !== undefined || pending) fail("usage_error", "tap help team attach", "--except was given more than once");
        if (i + 1 >= argv.length || argv[i + 1]!.startsWith("-")) pending = "--except";
        else exceptRaw = argv[++i]!;
        break;
      case "--only":
        if (exceptRaw !== undefined || pending === "--except") selectConflictGate(VERB);
        if (onlyRaw !== undefined || pending) fail("usage_error", "tap help team attach", "--only was given more than once");
        if (i + 1 >= argv.length || argv[i + 1]!.startsWith("-")) pending = "--only";
        else onlyRaw = argv[++i]!;
        break;
      default:
        if (!arg.startsWith("-") && team === undefined && !pending) { team = arg; break; }
        fail("usage_error", "tap help team", `unexpected argument '${arg}'`);
    }
  }
  // The gates run AFTER the whole argv is parsed, as the incumbent's did: a
  // usage error in a later token wins over a roster refusal from an earlier
  // one, and both flags together is checked before either value is parsed.
  return { dryRun, tabs, all, team, exceptRaw, onlyRaw, pending, yes };
}

/**
 * --except / --only (tap-nt4c, tap-sttl): parse + roster-gate before any
 * session snapshot, through the same shared path detach/down/up use. The
 * positive --only set travels to the planner, which applies it against the
 * snapshot it is about to act on — precomputing a complement here would freeze
 * an answer from an earlier registry read (partner review P1).
 */
function gateSelection(ctx: ResolvedContext, exceptRaw: string | undefined, onlyRaw: string | undefined): Selection {
  if (exceptRaw !== undefined && onlyRaw !== undefined) selectConflictGate(VERB);
  if (exceptRaw !== undefined) {
    const selection = parseSelection(VERB, exceptRaw, "--except");
    rosterGate(VERB, selection, registryRoster(ctx.registryPath));
    crewSelectGate(VERB, selection, ctx.registryPath);
    return selection;
  }
  if (onlyRaw !== undefined) {
    const selection = parseSelection(VERB, onlyRaw, "--only");
    rosterGate(VERB, selection, registryRoster(ctx.registryPath));
    crewSelectGate(VERB, selection, ctx.registryPath);
    return selection;
  }
  return noSelection();
}

/**
 * The worktree the team's sessions were launched from — the registry's own
 * `team.worktree_root` when it says, else derived from the bus path the way
 * the incumbent did (`<root>/.tap/bus`, else the git
 * toplevel or cwd). The LOGICAL path is kept, not a realpath: it is handed to
 * `launcher.py list --cwd` and spelled into the AppleScript's `cd`, and the
 * incumbent spelled it exactly as the registry/bus had it.
 */
function teamRoot(ctx: ResolvedContext): string {
  let root = "";
  try {
    const doc = loadRegistry(ctx.registryPath);
    const team = doc.team;
    if (typeof team === "object" && team !== null && !Array.isArray(team)) {
      const raw = (team as Record<string, unknown>).worktree_root;
      // Python's `.strip()`, not JS `trim()`: the two disagree at both ends of
      // the whitespace set (U+FEFF is trimmed by JS and kept by Python; U+0085
      // and U+001C are kept by JS and stripped by Python), and a root that ends
      // in one of them selects a DIFFERENT DIRECTORY, not a different message
      // (partner review F1).
      if (typeof raw === "string") root = pythonStrip(raw);
    }
  } catch {
    // An unreadable registry is what the incumbent's `2>/dev/null || true`
    // swallowed: the bus-derived fallback answers instead.
  }
  if (root) return root;
  const home = ctx.bus.home;
  if (home.endsWith("/.tap/bus")) root = home.slice(0, -"/.tap/bus".length);
  else {
    const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", env: process.env });
    root = top.status === 0 ? top.stdout.replace(/\n$/, "") : process.cwd();
  }
  return root || "/";
}

/**
 * Under --json the list refuses on STDOUT with `{"ok": false, "error_class", "action", "detail"}` and leaves stderr
 * empty, so the refusal text is read from the envelope and spelled as the prose line the incumbent printed on stderr:
 * `tap session: <detail>`, plus `; next: <action>` for the classes whose detail does not already carry its own next
 * step (the `session_error` action is only the envelope's help pointer). Null when stdout is not an envelope.
 */
function refusalLine(stdout: string): string | null {
  let doc: unknown;
  try { doc = JSON.parse(stdout); } catch { return null; }
  if (typeof doc !== "object" || doc === null || (doc as { ok?: unknown }).ok !== false) return null;
  const { error_class: errorClass, action, detail } = doc as { error_class?: unknown; action?: unknown; detail?: unknown };
  if (typeof errorClass !== "string" || typeof detail !== "string") return null;
  return `tap session: ${detail}${errorClass !== "session_error" && typeof action === "string" && action ? `; next: ${action}` : ""}`;
}

/** `bun src/launcher/list.ts --json --cwd <root>`: the native producer's catalog — the python `list` subcommand was deleted with the S1 list port, and this bridge now consumes the same bytes the router serves. */
function catalogSnapshot(root: string, env: NodeJS.ProcessEnv): Uint8Array {
  const result = spawnSync(artifactBun() ?? "bun", [runtimeModule("src/launcher/list.ts"), "--json", "--cwd", root], {
    env, maxBuffer: REGISTRY_MAX_BUFFER,
  });
  if (result.status !== 0) {
    // `$(cat "$sessions_err")` dropped the trailing newlines; tap_error_line
    // then flattened the embedded ones to spaces. The router's renderer does
    // not flatten, so the same two steps happen here to keep both doors
    // printing the incumbent's line.
    let detail = refusalLine(result.stdout?.toString("utf8") ?? "") ?? (result.stderr?.toString("utf8") ?? "").replace(/\n+$/, "");
    if (!detail) detail = "could not read the current team session catalog";
    fail("session_list_unavailable", "tap session list --json", detail.replace(/[\r\n]/g, " "));
  }
  return result.stdout ?? new Uint8Array();
}

interface ClientRow {
  session: string;
  handle: string;
  /** Comma-joined client ttys viewing the session at snapshot time. */
  clients: string;
}

function listClientTtys(session: string, env: NodeJS.ProcessEnv): string[] | null {
  const run = tmuxReadOnly(["list-clients", "-t", `=${session}`, "-F", "#{client_tty}"], env);
  if (run.code !== 0) return null;
  return run.stdout.split("\n").filter(line => line.length > 0);
}

export interface Disclosures {
  clientRows: ClientRow[];
  rows: Partitioned;
  selection: Selection;
  /** The acting registry's path: the mark reader's only input. */
  registryPath: string;
  includeAttached?: boolean;
  /**
   * The team root (tap-26r3): the unavailable disclosure's resume command is
   * anchored to it so the command works from any cwd.
   */
  root: string;
}

function printAttachCommands(planned: readonly ClientRow[], stream: NodeJS.WriteStream, socket: string | undefined, onlyHandles?: readonly string[]): void {
  for (const row of planned) {
    if (onlyHandles && !onlyHandles.includes(row.handle)) continue;
    stream.write(`  tmux${socket ? ` -S ${shellQuote(socket)}` : ""} attach -t '=${row.session}'\n`);
  }
}

export function printDisclosures(d: Disclosures, stream: NodeJS.WriteStream): void {
  const already = d.includeAttached ? "" : d.clientRows.filter(row => row.clients).map(row => `${row.handle} (${row.clients})`).join(", ");
  const spared = d.rows.excluded.map(row => `${row.handle} (${row.third})`).join(", ");
  // An incapable mark is the operator's statement, not a revive candidate:
  // advertising `tap session resume` for it would promise an action the
  // invariant forbids. Rows the acting registry carries as the exact
  // suspended/incapable pair get their own disclosure line pointing at
  // re-registration instead; every other unavailable row keeps the
  // incumbent's resume-tier line byte for byte. lenientSeats is the
  // incumbent's own softness: an unreadable registry reads as no marks, so
  // this stays a pure disclosure and never invents state.
  const incapable = new Set<string>();
  for (const [handle, row] of Object.entries(lenientSeats(d.registryPath))) {
    if (row.status === "suspended" && row.status_reason === "incapable") incapable.add(handle);
  }
  const suspended = d.rows.unavailable.filter(row => incapable.has(row.handle))
    .map(row => `${row.handle} is suspended (incapable); re-register from its pane: run 'tap in' there, or 'tap register ${row.handle} --pane <tmux-target>'`).join(", ");
  const unavailable = d.rows.unavailable
    .filter(row => !incapable.has(row.handle))
      // Mirrors transaction.ts RestartResumeFailure's resume string: anchored
      // to the team root, the command works from an unrelated cwd.
      .map(row => `${row.handle} (resume tier ${row.third}; next: cd ${shlexQuote(d.root)} && tap session resume ${shlexQuote(row.handle)})`).join(", ");
  receipt(`skipped because already attached: ${already || "none"}`, stream);
  if (suspended) receipt(`incapable: ${suspended}`, stream);
  receipt(`unavailable: ${unavailable || "none"}`, stream);
  if (spared) {
    receipt(`spared by ${selectFlag(d.selection)}${selectOperand(d.selection, spared)}`, stream);
  } else if (selectFlag(d.selection) === "--only") {
    // Whole-roster --only spares nobody, and a receipt gated on a nonempty
    // spared list would then leave no trace of the selector at all — making a
    // whole-team attach indistinguishable from an unselected one
    // (partner review P2; stop had this fix, these three did not).
    receipt(`--only ${selectTyped(d.selection)} matched every seat — none spared`, stream);
  }
}

interface Verification {
  verified: number;
  unverified: string[];
  postUnobservable: string[];
}

/** One new, distinct client per planned row, including rows sharing a session. */
function verifyNewClients(planned: readonly ClientRow[], env: NodeJS.ProcessEnv): Verification {
  const out: Verification = { verified: 0, unverified: [], postUnobservable: [] };
  const groups = new Map<string, ClientRow[]>();
  for (const row of planned) {
    const group = groups.get(row.session) ?? [];
    group.push(row);
    groups.set(row.session, group);
  }
  for (const [session, group] of groups) {
    const after = listClientTtys(session, env);
    if (after === null) {
      out.unverified.push(...group.map(row => row.handle));
      out.postUnobservable.push(...group.map(row => row.handle));
      continue;
    }
    const before = new Set(group.flatMap(row => row.clients.split(",")));
    const gained = new Set(after.filter(tty => !before.has(tty))).size;
    out.verified += Math.min(gained, group.length);
    out.unverified.push(...group.slice(gained).map(row => row.handle));
  }
  return out;
}

/** A viewer plan uses one server throughout catalog, probes and attachment. */
function viewerEnv(ctx: ResolvedContext, selection: Selection): NodeJS.ProcessEnv {
  const sockets = new Set<string>();
  for (const [handle, row] of Object.entries(seatMap(loadRegistry(ctx.registryPath)))) {
    if (!seatIsRelaunchable(row) || !row.session) continue;
    if (selection.except.includes(handle) || (selection.only.length && !selection.only.includes(handle))) continue;
    const recorded = typeof row.server_socket === "string" ? row.server_socket : "";
    sockets.add(physicalSocketPath(recorded ? { ...process.env, TAP_TMUX_SOCKET_PATH: recorded } : process.env));
  }
  if (sockets.size > 1) {
    fail("mixed_tmux_namespaces", "use --only or --except to select seats on one tmux socket",
      "selected seats span multiple tmux sockets; no iTerm window was opened");
  }
  const socket = sockets.values().next().value;
  return socket ? { ...process.env, TAP_TMUX_SOCKET_PATH: socket } : process.env;
}

const VERIFY_ATTEMPT_LIMIT = 25;
const VERIFY_INTERVAL_MS = 200;

function iTermAutomationAvailable(): boolean {
  const which = spawnSync("osascript", ["-e", 'id of application "iTerm"'], { stdio: ["ignore", "ignore", "ignore"], env: process.env });
  return which.status === 0;
}

export function cmdTeamAttach(argv: string[], scriptsDir: string): number | Promise<number> {
  let parsed: Options;
  try { parsed = parseArgs(argv); }
  catch (error) { return renderRefusals(LABEL, () => { throw error; }); }
  let exact: ResolvedContext | undefined;
  let missing = false;
  try { exact = resolveContext(process.cwd(), process.env, parsed.team ? { explicitTeam: parsed.team, readOnly: true } : { readOnly: true }); }
  catch (error) {
    if (error instanceof TapError && ((error.errorClass === "unknown_team" && discoveryTerminalAvailable())
      || (!parsed.team && error.errorClass === "unanchored_bus"))) missing = true;
    else return renderRefusals(LABEL, () => { throw error; });
  }
  if (!parsed.pending && !missing) return renderRefusals(LABEL, () => teamAttach(argv, scriptsDir));
  return renderRefusalsAsync(LABEL, async () => {
    requireDiscoveryTerminal(VERB, `tap team attach <team> [--only <h,...> | --except <h,...>]`);
    let team: BoundTeam;
    if (exact) team = { team: exact.team, root: exact.root, registryPath: exact.registryPath, context: exact };
    else {
      const picked = await chooseTeam(VERB, parsed.team, pick);
      if (picked.kind === "cancelled") { receipt("cancelled"); return 0; }
      if (picked.kind === "interrupted") return 130;
      team = picked.value;
    }
    let bound: BoundCohort;
    if (parsed.pending) {
      const picked = await chooseSeatCohort(VERB, team, parsed.pending, pick);
      if (picked.kind === "cancelled") { receipt("cancelled"); return 0; }
      if (picked.kind === "interrupted") return 130;
      bound = picked.value;
    } else {
      const selection = gateSelection(team.context, parsed.exceptRaw, parsed.onlyRaw);
      const chosen = parentSeatSnapshot(team).filter(row => selection.mode === "--only" ? selection.only.includes(row.handle)
        : selection.mode === "--except" ? !selection.except.includes(row.handle) : true);
      bound = { team, seats: new Map(chosen.map(row => [row.handle, row])),
        selection: { mode: "--only", only: chosen.map(row => row.handle), except: [] }, original: selection };
    }
    if (!bound.seats.size) { receipt("no seats selected"); return 0; }
    const flags = [...(parsed.tabs ? ["--tabs"] : []), ...(parsed.all ? ["--all"] : [])];
    const selected = [team.team, ...flags, "--only", [...bound.seats.keys()].join(",")];
    revalidateTeam(team);
    const preview = teamAttach([...selected, "--dry-run"], scriptsDir, bound);
    if (preview !== 0 || parsed.dryRun) return preview;
    if (!parsed.yes && !(await confirmAction())) { receipt("cancelled"); return 0; }
    revalidateTeam(team);
    return teamAttach(selected, scriptsDir, bound);
  });
}

/** team up's exit code stands unless the attach itself failed; a failed attach wins even over an attention state. */
export function upWithAttachCode(upCode: number, attachCode: number): number {
  return attachCode !== 0 ? attachCode : upCode;
}

/**
 * `tap team up --attach` (PR 2): attach exactly the seats the run brought up,
 * through the one viewer — teamAttach's plan, iTerm path, no-iTerm fallback
 * and new-client verification, unchanged. Dry-run never opens anything: the
 * preview prints the viewer count, the handles and the AppleScript that a
 * real run would hand osascript. The exit code is the attach's own; the verb
 * decides how it combines with team up's.
 */
export function attachCameUp(cameUp: { handle: string; session: string }[], options: { scriptsDir: string; team?: string; tabs: boolean; dryRun: boolean }): number {
  if (!cameUp.length) { process.stdout.write(`tap team up: --attach: no seats ${options.dryRun ? "would come up" : "came up"}; nothing to attach\n`); return 0; }
  if (options.dryRun) {
    const ctx = attachContext(options.team);
    const root = teamRoot(ctx);
    // The resume launches on the caller's socket and stamps it only in a real
    // run, so the stored rows' sockets would be stale here: preview the socket
    // the seats will actually come up on.
    const socket = physicalSocketPath(process.env);
    // The live plan orders viewers by session name (partitionSnapshot); the
    // preview must show the same panes in the same order.
    const planned = [...cameUp].sort((a, b) => (a.session < b.session ? -1 : a.session > b.session ? 1 : 0));
    process.stdout.write(`tap team up: --attach would open ${planned.length} viewer(s): ${planned.map(row => row.handle).join(", ")}\n`);
    process.stdout.write(`${LABEL}: generated AppleScript:\n${itermViewerScript(planned, root, socket, options.tabs)}\n`);
    return 0;
  }
  const argv = ["--only", cameUp.map(row => row.handle).join(","), ...(options.tabs ? ["--tabs"] : []), ...(options.team ? [options.team] : [])];
  return renderRefusals(LABEL, () => teamAttach(argv, options.scriptsDir));
}

function teamAttach(argv: string[], scriptsDir: string, bound?: BoundCohort): number {
  const { dryRun, tabs, all, team: requestedTeam, exceptRaw, onlyRaw } = parseArgs(argv);

  const ctx = attachContext(requestedTeam);
  if (bound) assertBoundSeats(bound, seatMap(loadRegistry(ctx.registryPath)));
  ctx.bus.ensureDirs();
  const team = ctx.team;
  if (!team) fail("registry_invalid", "tap register", "current team name is unavailable");

  const selection = gateSelection(ctx, exceptRaw, onlyRaw);

  const root = teamRoot(ctx);
  const env = viewerEnv(ctx, selection);
  const socket = physicalSocketPath(env);
  const manualSocket = socket === physicalSocketPath(process.env) ? undefined : socket;
  const snapshot = catalogSnapshot(root, env);

  let rows: Partitioned;
  try {
    rows = partitionSnapshot(snapshot, team, new Set(selection.except), new Set(selection.only));
  } catch (error) {
    // The planner's own sentence is the diagnostic, spelled as its CLI entry
    // spelled it (a refusal by its message, anything else by `String(error)`,
    // which keeps the `TypeError:` prefix); the exit class is the contract the
    // incumbent mapped every nonzero to.
    process.stderr.write(`${error instanceof PartitionRefusal ? error.message : String(error)}\n`);
    fail("session_list_invalid", "tap session list --json", "the current session snapshot could not be planned");
  }

  const clientRows: ClientRow[] = [];
  const planned: ClientRow[] = [];
  const disclosures: Disclosures = { clientRows, rows, selection, registryPath: ctx.registryPath, includeAttached: all, root };
  for (const row of rows.live) {
    const ttys = listClientTtys(row.name, env);
    if (ttys === null) {
      printDisclosures(disclosures, process.stderr);
      fail("session_unobservable", "retry tap team attach after tmux is observable",
        `could not snapshot existing viewers for '${row.name}'; no iTerm window was opened`);
    }
    const clientRow = { session: row.name, handle: row.handle, clients: ttys.join(",") };
    clientRows.push(clientRow);
    if (all || !clientRow.clients) planned.push(clientRow);
  }

  const liveCount = clientRows.length;
  const plannedCount = planned.length;
  const excludedLive = rows.excluded.filter(row => row.third === "live").length;

  const script = plannedCount > 0
    ? itermViewerScript(
        planned.map(row => ({ session: row.session, handle: row.handle })),
        root, socket, tabs)
    : "";

  if (liveCount === 0) {
    // Design call 4: when the exclusions are what emptied the live set, that
    // is a legal no-op (exit 0) with a line that names the set — not the "no
    // live seats" failure, which would blame the team for the operator's own
    // instruction. The gate is a spared LIVE seat: a team that had none to
    // begin with still fails.
    if (excludedLive > 0) {
      receipt(`no seats matched after ${selectSummary(selection)}`);
      printDisclosures(disclosures, process.stdout);
      return 0;
    }
    receipt(`no live seats for team '${team}'; no iTerm window was opened`);
    printDisclosures(disclosures, process.stdout);
    return 1;
  }

  if (plannedCount === 0) {
    receipt(`no new viewers needed for team '${team}'; all ${liveCount} live seat(s) were already attached`);
    printDisclosures(disclosures, process.stdout);
    return 0;
  }

  if (dryRun) {
    receipt(`plan for team '${team}' (${plannedCount} new viewer(s))`);
    printAttachCommands(planned, process.stdout, manualSocket);
    process.stdout.write(`${LABEL}: generated AppleScript:\n`);
    process.stdout.write(script);
    receipt("dry-run cannot prove attachment; no iTerm window was opened");
    printDisclosures(disclosures, process.stdout);
    return 0;
  }

  if (iTermAutomationAvailable()) {
    if (bound) assertBoundSeats(bound, seatMap(loadRegistry(ctx.registryPath)));
    const run = spawnSync("osascript", ["-"], { input: script, stdio: ["pipe", "ignore", "inherit"], env: process.env });
    if (run.status !== 0) {
      process.stderr.write(`${LABEL}: iTerm automation failed; attach manually:\n`);
      printAttachCommands(planned, process.stderr, manualSocket);
      printDisclosures(disclosures, process.stderr);
      fail("automation_failed", "run the printed tmux attach commands", "iTerm did not accept the generated viewer plan");
    }
    let attempt = 1;
    let verification = verifyNewClients(planned, env);
    while (verification.unverified.length > 0 && attempt < VERIFY_ATTEMPT_LIMIT) {
      Bun.sleepSync(VERIFY_INTERVAL_MS);
      attempt++;
      verification = verifyNewClients(planned, env);
    }
    if (verification.unverified.length > 0) {
      receipt(`no new tmux client observed after ${attempt} bounded probe(s) for: ${verification.unverified.join(", ")}`, process.stderr);
      if (verification.postUnobservable.length > 0) {
        receipt(`post-open client probe unavailable for: ${verification.postUnobservable.join(", ")}`, process.stderr);
      }
      process.stderr.write(`${LABEL}: attachment proof incomplete; attach manually:\n`);
      printAttachCommands(planned, process.stderr, manualSocket, verification.unverified);
      printDisclosures(disclosures, process.stderr);
      fail("attachment_unverified", "run the printed tmux attach commands", "a new tmux client was not observed for every planned seat");
    }
    receipt(`verified ${verification.verified} new iTerm viewer(s) for team '${team}'`);
  } else {
    receipt("iTerm automation unavailable; run these attach commands");
    printAttachCommands(planned, process.stdout, manualSocket);
    receipt(`printed ${plannedCount} attach command(s) for team '${team}'`);
  }

  printDisclosures(disclosures, process.stdout);
  return 0;
}

/**
 * The bus and acting registry, through the shared selector. The incumbent's
 * `tap_ensure_dirs` + `tap_spool_team_name` + best-effort rebind reached the
 * same three facts (bus home, team name, acting registry path) by three
 * different roads; the selector answers all three at once.
 */
function attachContext(team?: string): ResolvedContext {
  try {
    return resolveContext(process.cwd(), process.env, { explicitTeam: team });
  } catch (error) {
    if (error instanceof TapError) throw new TapError(error.code, error.errorClass, error.action, error.detail, LABEL);
    throw error;
  }
}

if (import.meta.main) {
  const scriptsDir = tapScriptsDir();
  Promise.resolve(cmdTeamAttach(process.argv.slice(2), scriptsDir)).then(code => { process.exitCode = code; });
}
