import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { TapError, resolveContext } from "../context";
import { repoRoot, resolveBus } from "../bushome";
import { debugAttention } from "../debug-capture";
import { injectionFaultOrRefuse } from "./injection-fault";
import { ensureAscii } from "../fsatomic";
import { envelopeField } from "../envelope";
import { registryEventsPath } from "../events";
import { dispatcherLiveness, pidAlive } from "../watch-sidecar";
import { armPath, notifyPath } from "../watch-notice";
import { readRegistry, observe, observedRows, table, withAgentStates, type RegistryRow } from "./team";
import { tmuxReadOnly } from "../tmux";
import { OldStoreError, teamRegistryFileRefusal } from "../register-authority";
import { Bus } from "../bus";
import { DEAD_LETTER_SWEEP, deadLetter, deadLetterScope } from "../dead-letters";

// Restart evidence is exactly these classifier reasons (plan decision 2, NOTE
// m0019/m0031): the tmux/server command path itself says the server this
// registry was written against is gone. Live-server per-pane gaps
// (pane_set_unobservable) and missing designated panes are NOT restart
// evidence and stay quiet.
const RESTART_REASONS = new Set([
  "server_restarted",
  "server_epoch_stale",
  "boot_id_stale",
  "session_unobservable",
  "server_epoch_unobservable",
]);

const POLL_STATE = "poll-mode (liveness unknown)";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// Python bool() over a JSON-decoded value: null/false/""/0 and empty
// containers are falsy; the STRING "0" is truthy (mirrors the incumbent).
function truthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === "") return false;
  if (typeof value === "number" && value === 0) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  if (typeof value === "object" && Object.keys(value).length === 0) return false;
  return true;
}

function humanAction(action: string): string {
  const flat = action.replace(/[\r\n]/g, " ");
  return /[ /]/.test(flat) ? flat : flat.replace(/_/g, " ");
}

interface PayloadEntry {
  id: string;
  name: string;
  path: string;
  mtime: number;
  raw: string;
  kind: string;
  from: string;
  to: string;
  fromTeam: string;
  toTeam: string;
  age: number;
}

function nowSeconds(): number {
  const pinned = process.env.TAP_WATCH_NOW;
  if (pinned !== undefined && /^[0-9]+$/.test(pinned)) return Number(pinned);
  return Math.floor(Date.now() / 1000);
}

// Python rendered ages as truncated ints clamped at zero; mirror that.
function ageSeconds(now: number, mtimeMs: number): number {
  return Math.max(0, Math.trunc(now - mtimeMs / 1000));
}

function listBusFiles(dir: string, suffix: string, now: number): { name: string; path: string; mtime: number }[] {
  let entries: { name: string; isFile: boolean }[] = [];
  try {
    // Regular files only (incumbent glob + os.path.isfile): a directory named
    // like a payload is not traffic.
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && !d.name.startsWith(".") && !d.name.startsWith("_") && d.name.endsWith(suffix))
      .map((d) => ({ name: d.name, isFile: true }));
  } catch {
    return [];   // No bus yet is a healthy shape, not a failure — and never create it.
  }
  const files: { name: string; path: string; mtime: number }[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    try {
      files.push({ name: entry.name, path, mtime: statSync(path).mtimeMs });
    } catch {
      // Vanished between readdir and stat: it cannot be unsettled traffic.
    }
  }
  // Name-ascending first, then a stable newest-first pass: equal mtimes keep
  // the name order, matching the incumbent's sorted() tiebreak.
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  files.sort((a, b) => b.mtime - a.mtime);
  return files;
}

function readPayloads(busHome: string, now: number): PayloadEntry[] {
  const out: PayloadEntry[] = [];
  for (const file of listBusFiles(join(busHome, "payloads"), ".md", now)) {
    let raw = "";
    // An unreadable canonical payload STAYS in the census with empty parsed
    // fields (the incumbent frontmatter() fallback): it still exists, so it
    // can still be an unsettled obligation — dropping it would let an
    // unhealthy bus read healthy.
    try {
      raw = readFileSync(file.path, "utf8");
    } catch {
      raw = "";
    }
    out.push({
      // The canonical FILENAME stem is the payload identity (incumbent
      // `base[:-3]`): settled receipts are matched by filename, so a
      // frontmatter id that disagrees must not flip settlement.
      id: file.name.replace(/\.md$/, ""),
      name: file.name,
      path: file.path,
      mtime: file.mtime,
      raw,
      kind: envelopeField(raw, "kind") ?? "",
      from: envelopeField(raw, "from") ?? "",
      to: envelopeField(raw, "to") ?? "",
      fromTeam: envelopeField(raw, "from_team") ?? "",
      toTeam: envelopeField(raw, "to_team") ?? "",
      age: ageSeconds(now, file.mtime),
    });
  }
  return out;
}

function newestReceiptAge(busHome: string, now: number): number | null {
  const files = listBusFiles(join(busHome, "receipts"), ".done", now);
  return files.length ? ageSeconds(now, files[0]!.mtime) : null;
}

function readJsonFile(path: string): { ok: true; value: unknown } | { ok: false; detail: string } | { ok: false; missing: true } {
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Missing and unreadable collapse to "absent" for arm/notify: a file that
    // cannot be opened holds no armed watcher and no sticky notice.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, missing: true };
    return { ok: false, detail };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

interface WatchRecord {
  armed: boolean;
  armed_by?: unknown;
  done_when?: unknown;
  threshold_seconds?: unknown;
  current_rung?: unknown;
  heartbeat_at?: unknown;
  watcher_pid?: unknown;
  watcher_command?: unknown;
  watcher_alive?: boolean;
  paused?: boolean;
  paused_by?: unknown;
  paused_at?: unknown;
  paused_until?: unknown;
  pause_reason?: unknown;
  condition?: string;
  error?: string;
}

function watchSignal(busHome: string): { watch: WatchRecord; attention: string | null } {
  const read = readJsonFile(armPath(busHome));
  // Disarmed renders EXACTLY the incumbent's two-key object — the optional
  // armed-shape fields stay off the wire when nothing is armed.
  if (read.ok === false && "missing" in read) return { watch: { armed: false }, attention: null };
  if (read.ok === false) {
    return {
      watch: {
        armed: true, armed_by: "", done_when: "", threshold_seconds: "", current_rung: "",
        heartbeat_at: "", watcher_pid: "", watcher_command: "", watcher_alive: false, paused: false,
        paused_by: "", paused_at: "", paused_until: "", pause_reason: "",
        condition: "watch-state-unreadable",
        error: `invalid watch state: ${read.detail}`,
      },
      attention: "watch-state-unreadable",
    };
  }
  const value = read.value;
  const arm = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const watcherPid = arm.watcher_pid === undefined || arm.watcher_pid === null ? "" : String(arm.watcher_pid);
  const watcherCommand = str(arm.watcher_command);
  const watcherAlive = pidAlive(watcherPid, watcherCommand);
  // Python truthiness mirror: `bool(w.get("pause_reason") or w.get("paused_by")
  // or w.get("paused_until") not in (None, "", 0, "0"))`. A `paused` key in the
  // arm file is never consulted — pause evidence lives in the fields.
  const paused = truthy(arm.pause_reason) || truthy(arm.paused_by)
    || !(arm.paused_until === undefined || arm.paused_until === null || arm.paused_until === "" || arm.paused_until === 0 || arm.paused_until === "0");
  // A dead watcher draws attention UNCONDITIONALLY (incumbent `if not alive:`)
  // — pausing silences nobody; the paused block still renders below. The parse
  // error branch above already overrides with watch-state-unreadable. A live pid
  // whose heartbeat went stale (or never came) is the same verdict `tap watch
  // status` reports as dead: health is the check verb that exits non-zero for it.
  const stalled = watcherAlive && dispatcherLiveness(value, Number(process.env.TAP_WATCH_NOW || Math.floor(Date.now() / 1000))).state === "dead";
  const dead = !watcherAlive || stalled ? "armed-but-watcher-dead" : undefined;
  return {
    watch: {
      armed: true,
      armed_by: arm.armed_by ?? "",
      done_when: arm.done_when ?? "",
      threshold_seconds: arm.threshold_seconds ?? "",
      current_rung: arm.current_rung ?? "",
      heartbeat_at: arm.heartbeat_at ?? "",
      watcher_pid: arm.watcher_pid ?? "",
      watcher_command: watcherCommand,
      watcher_alive: watcherAlive,
      paused,
      paused_by: arm.paused_by ?? "",
      paused_at: arm.paused_at ?? "",
      paused_until: arm.paused_until ?? "",
      pause_reason: arm.pause_reason ?? "",
      ...(dead ? { condition: dead } : {}),
    },
    attention: dead ?? null,
  };
}

function notifySignal(busHome: string): { notify: Record<string, unknown> | null; attention: Record<string, unknown> | null } {
  const read = readJsonFile(notifyPath(busHome));
  if (read.ok === false && "missing" in read) return { notify: null, attention: null };
  if (read.ok === false) {
    const reason = `invalid notify state: ${read.detail}`;
    return { notify: { type: "sticky-notify", reason }, attention: { type: "sticky-notify", reason } };
  }
  // A non-object root (null, array, string) is still state on disk — fail
  // loud on the same invalid-state path as a parse error rather than
  // rendering the bus as if no notify file existed. Same shape: no `at` key.
  if (!isRecord(read.value)) {
    const reason = `invalid notify state: ${JSON.stringify(read.value)} is not a JSON object`;
    return { notify: { type: "sticky-notify", reason }, attention: { type: "sticky-notify", reason } };
  }
  const n = read.value;
  // Acknowledgement is a STRING compare (incumbent `str(n.get('acked','0'))
  // != '1'`): only the exact "1" clears, and numeric 1 stringifies to it.
  if (String(n.acked ?? "0") === "1") return { notify: null, attention: null };
  // The at key is ALWAYS present once parsed (incumbent `n.get('at','')`),
  // even when the file carries no at field.
  const at = str(n.at);
  const reason = str(n.reason);
  const sticky: Record<string, unknown> = { type: "sticky-notify", at, reason };
  return { notify: sticky, attention: sticky };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectHealthScope(): { busHome: string; busRule: string; registryPath: string; team: string } {
  try {
    const ctx = resolveContext(process.cwd(), process.env, { readOnly: true });
    return { busHome: ctx.selection?.busHome ?? "", busRule: ctx.busRule, registryPath: ctx.registryPath, team: ctx.team };
  } catch (error) {
    if (error instanceof TapError && error.errorClass === "cwd_unreachable") {
      // Health is evidence: a deleted cwd is reported, never rendered as a
      // JSON receipt, on either output route.
      process.stderr.write(`tap health: ${error.detail}; next: ${humanAction(error.action)}\n`);
      throw new HealthExit(error.code);
    }
    if (error instanceof TapError && error.errorClass === "unanchored_bus") {
      // ONE fail-soft class, pinned by the busless differential: an unenrolled
      // cwd has no acting registry, and health reports exactly that (an empty
      // roster, `registry_present:false`) instead of refusing. The fallback
      // resolves the cwd-derived/default bus and deliberately ignores TAP_HOME
      // — a valid TAP_HOME never reaches this branch (it wins in selection),
      // so this is no second precedence rule, and every other selector
      // refusal propagates and main.ts renders it.
      const { home, rule } = resolveBus(repoRoot(process.cwd()), { ...process.env, TAP_HOME: undefined });
      return { busHome: home, busRule: rule, registryPath: join(home, "registry.json"), team: "" };
    }
    // Native selector precedence and structured native errors govern: every
    // other refusal propagates and main.ts renders it.
    throw error;
  }
}

class HealthExit extends Error {
  constructor(readonly code: number) {
    super("health: exit");
    this.name = "HealthExit";
  }
}

export function cmdHealth(argv: string[], scriptsDir: string): number {
  let json = false;
  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
      process.env.TAP_JSON = "1";
    } else if (arg.startsWith("--")) {
      throw new TapError(1, "unknown_option", "tap help health", `unknown option '${arg}'`);
    } else {
      throw new TapError(1, "usage_error", "tap help health", `unexpected arg '${arg}'`);
    }
  }
  void json;

  let scope: ReturnType<typeof selectHealthScope>;
  try {
    scope = selectHealthScope();
  } catch (error) {
    if (error instanceof HealthExit) return error.code;
    throw error;
  }

  const registryPresent = existsSync(scope.registryPath);
  let rows: RegistryRow[] = [];
  if (registryPresent) {
    // readRegistry is the only decoder; on refusal we unpack its error envelope
    // for the parser line, then refuse with health's own class and action.
    // The fail-soft fallback bus never passed selection: an old format refuses by name (main.ts renders it).
    const oldStore = teamRegistryFileRefusal(scope.registryPath);
    if (oldStore) throw new OldStoreError(oldStore.action, oldStore.detail);
    const read = readRegistry(scope.registryPath, true, false);
    if (!read.ok || !read.rows) {
      let detail = "";
      if (read.rawOutput) {
        try {
          const parsed: unknown = JSON.parse(read.rawOutput);
          if (isRecord(parsed) && typeof parsed.error === "string") detail = parsed.error;
        } catch {
          detail = "";
        }
      }
      if (detail) process.stderr.write(`${detail}\n`);
      // Action stays underscore-form: errorJson emits it verbatim (the
      // incumbent JSON shape), and main.ts's humanAction spaces single tokens.
      throw new TapError(1, "registry_invalid", "repair_registry", "registry is invalid JSON");
    }
    rows = read.rows;
  }

  // ONE registry/tmux/process snapshot, classified by the shared engine. A
  // classifier failure is a stderr diagnostic and an empty census — never a
  // half-roster, and never text on stdout.
  const census = observe(rows, scriptsDir);
  const observations = census.code === 0 ? census.rows : new Map<string, string[]>();
  // Socket-namespace fence (team roster's rule): a row pinned to another
  // server's socket cannot be judged by THIS server's census. The probe costs
  // one tmux call, so it runs only when some row actually carries a socket pin,
  // and its verdict is trusted only when it SUCCEEDS and names an absolute
  // socket path — the same validity gate the roster applies.
  const probe = rows.some((row) => str(row.server_socket) !== "")
    ? tmuxReadOnly(["display-message", "-p", "#{socket_path}"])
    : null;
  const callerSocket = probe?.code === 0 && probe.stdout.trim().startsWith("/") ? probe.stdout.trim() : "";
  const orows = withAgentStates(observedRows(rows, observations, census.serverEpoch, {}, callerSocket), { team: scope.team });

  const now = nowSeconds();
  const payloads = readPayloads(scope.busHome, now);
  // Terminal is every receipt the bus treats as terminal: `.done`, and the
  // `.cancelled` that withdraw and dead-letter disposal leave beside a
  // resident payload (tap-s1dqn).
  const bus = new Bus(scope.busHome);
  const settled = (id: string) => bus.isDone(id);
  const lastPayloadAge = payloads.length ? payloads[0]!.age : null;
  const lastReceiptAge = newestReceiptAge(scope.busHome, now);

  // Incumbent order: unsettled payloads enumerate LEXICALLY by filename.
  // Newest-mtime order stays with last-activity and supervision, which answer
  // "what happened lately"; this list answers "what is owed", and the caller
  // reading it alphabetically must not depend on write timestamps.
  const open = payloads
    .filter((p) => !settled(p.id))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // Dead letters — mail the registry positively shows nobody can settle — are
  // counted apart and raise no attention; anything the classifier cannot prove
  // dead (no registry, partial registry, foreign team) stays actionable.
  const deadScope = registryPresent ? deadLetterScope(bus, scope.registryPath, scope.team) : null;
  const unsettled = open.filter((p) => !deadLetter(p.id, p.raw, deadScope));
  const deadLetterCount = open.length - unsettled.length;

  // Restart attention (plan decision 2): pane-backed seats exist, none of them
  // observed active, and at least one carries restart evidence. A row a prior
  // dispatcher already PARKED (persisted server_restarted, panes cleared) was
  // pane-backed when the reboot hit — its persisted status_reason IS the
  // evidence, so cleared pane fields do not unseat it. Reboot outranks stale
  // notify, so this item leads the list. The verdict reads the FENCED rows
  // (foreign-namespace seats read offline, never active) rather than raw
  // classifier output — and a fenced row is OUT of the local restart population
  // entirely, persisted status_reason included: its restart story belongs to
  // another server's namespace, not to a reboot of the caller's.
  const byHandle = new Map(orows.map((row) => [row.handle, row]));
  const wasPaneBacked = (row: RegistryRow) =>
    str(row.delivery) !== "poll"
    && (str(row.pane) !== "" || str(row.pane_id) !== "" || str(row.status_reason) === "server_restarted");
  const paneBacked = rows.filter((row) =>
    wasPaneBacked(row) && byHandle.get(str(row.handle))?.statusReason !== "foreign_namespace");
  const noneActive = !paneBacked.some((row) => byHandle.get(str(row.handle))?.status === "active");
  const restartEvidence = paneBacked.some((row) => {
    const orow = byHandle.get(str(row.handle));
    return RESTART_REASONS.has(orow?.statusReason ?? "") || str(row.status_reason) === "server_restarted";
  });

  const attention: Record<string, unknown>[] = [];
  if (paneBacked.length > 0 && noneActive && restartEvidence) attention.push({ type: "server-restart" });

  const notify = notifySignal(scope.busHome);
  if (notify.attention) attention.push(notify.attention);

  const unsettledJson: Record<string, unknown>[] = [];
  for (const p of unsettled) {
    attention.push({ type: "unsettled-payload", id: p.id, age_seconds: p.age });
    unsettledJson.push({
      id: p.id,
      path: p.path,
      age_seconds: p.age,
      from: p.from,
      to: p.to,
      kind: p.kind,
      ...(p.fromTeam ? { from_team: p.fromTeam } : {}),
      ...(p.toTeam ? { to_team: p.toTeam } : {}),
    });
  }

  const watch = watchSignal(scope.busHome);
  if (watch.attention) attention.push({ type: watch.attention });

  // Machine-wide flight journal: recording the operator enabled that is no longer running.
  const debug = debugAttention();
  if (debug) attention.push(debug);

  // Delivery refuses an invalid injection.behavior with no pane effect; name it here.
  const injectionFault = injectionFaultOrRefuse(process.env);
  if (injectionFault) attention.push({ type: "injection-behavior-invalid", detail: injectionFault });

  const supervision = payloads
    .filter((p) => p.kind === "probe" || p.kind === "notice" || p.kind === "progress")
    .slice(0, 5)
    .map((p) => ({ id: p.id, kind: p.kind, age_seconds: p.age }));

  let events: string[] = [];
  try {
    events = readFileSync(registryEventsPath(scope.busHome), "utf8").split("\n").filter((line) => line.length > 0).slice(-10);
  } catch {
    events = [];
  }

  // The recorded column is the REGISTRY's status — what the caller found on
  // disk — never the classifier's verdict; the census lives in `state`.
  const recorded = new Map(rows.map((row) => [str(row.handle), str(row.status)]));
  const roster = orows
    .slice()
    .sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0))
    .map((row) => ({
      handle: row.handle,
      status: recorded.get(row.handle) ?? "",
      pane: row.delivery === "poll" ? "" : row.pane,
      harness: row.harness,
      state: row.delivery === "poll" ? POLL_STATE : row.agentState,
      delivery: row.delivery,
    }));

  const status = attention.length > 0 ? "attention" : "healthy";
  const report: Record<string, unknown> = {
    ok: true,
    status,
    bus: scope.busHome,
    bus_rule: scope.busRule,
    registry_present: registryPresent,
    last_payload_age_seconds: lastPayloadAge,
    last_receipt_age_seconds: lastReceiptAge,
    attention,
    unsettled: unsettledJson,
    // Present only when nonzero, like debug: a bus with none keeps the incumbent shape.
    ...(deadLetterCount > 0 ? { dead_letters: { count: deadLetterCount, action: DEAD_LETTER_SWEEP } } : {}),
    roster,
    watch: watch.watch,
    notify: notify.notify,
    supervision,
    events,
    ...(debug ? { debug } : {}),
  };

  if (process.env.TAP_JSON === "1") {
    process.stdout.write(`${ensureAscii(JSON.stringify(report))}\n`);
  } else {
    process.stdout.write(renderHuman(report));
  }
  return attention.length > 0 ? 2 : 0;
}

function renderHuman(report: Record<string, unknown>): string {
  // Mirrors style.sh tap_style_init's stdout policy in order: NO_COLOR wins;
  // an empty or dumb TERM is rejected BEFORE force is considered; a nonzero
  // CLICOLOR_FORCE then bypasses only the TTY check; otherwise a TTY is
  // required. Bash returns before calling tput once styling is already off, so
  // the probes run only inside the styleable branch — ordinary piped health
  // output never pays five subprocesses. There the gate is the incumbent's
  // all-token probe: every capability must exit 0 AND return a nonempty token,
  // and dim/sgr0 style with the tokens tput actually printed.
  const forced = (process.env.CLICOLOR_FORCE ?? "0") !== "0";
  const term = process.env.TERM ?? "";
  const styleable = process.env.NO_COLOR === undefined
    && term !== "" && term !== "dumb"
    && (forced || process.stdout.isTTY);
  const cap = (args: string[]) => spawnSync("tput", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const caps = styleable
    ? [["setaf", "1"], ["setaf", "3"], ["bold"], ["dim"], ["sgr0"]].map(cap)
    : [];
  const usable = caps.length === 5 && caps.every((c) => c.status === 0 && (c.stdout ?? "") !== "");
  const dim = usable ? caps[3]!.stdout! : "";
  const reset = usable ? caps[4]!.stdout! : "";
  const style = styleable && usable;
  const secondary = (text: string) => (style ? `${dim}${text}${reset}` : text);
  const dash = (value: unknown) => {
    const s = value === undefined || value === null ? "" : String(value);
    return s === "" ? "-" : s;
  };
  const lines: string[] = [];
  const section = (header: string) => {
    if (lines.length > 0) lines.push("");
    lines.push(secondary(header));
  };

  // The human header says "ok", the machine field says "healthy" — the
  // incumbent's vocabulary, pinned by the busless differential fixture.
  lines.push(`tap health: ${report.status === "healthy" ? "ok" : report.status}`);

  section("bus");
  lines.push(`  path: ${report.bus}`);
  lines.push(`  rule: ${report.bus_rule}`);

  if (report.notify !== null && isRecord(report.notify)) {
    section("notify");
    // The at line ALWAYS renders (incumbent prints `at or '-'`), including
    // for the parse-error shape whose JSON omits the key.
    lines.push(`  type: ${dash(report.notify.type)}`);
    lines.push(`  at: ${dash(typeof report.notify.at === "string" ? report.notify.at : "")}`);
    lines.push(`  reason: ${dash(report.notify.reason)}`);
  }

  if (report.registry_present === false) {
    section("registry");
    lines.push("  no registry (run: tap register)");
  }

  section("watch");
  const watch = report.watch as WatchRecord;
  if (watch.armed !== true) {
    lines.push("  disarmed");
  } else {
    lines.push(`  armed by: ${dash(watch.armed_by)}`);
    lines.push(`  done when: ${dash(watch.done_when)}`);
    lines.push(`  threshold: ${dash(watch.threshold_seconds)}`);
    lines.push(`  rung: ${dash(watch.current_rung)}`);
    lines.push(`  heartbeat at: ${dash(watch.heartbeat_at)}`);
    lines.push(`  watcher pid: ${dash(watch.watcher_pid)}`);
    lines.push(`  watcher alive: ${watch.watcher_alive ? "yes" : "no"}`);
    if (watch.condition) lines.push(`  condition: ${watch.condition}`);
    if (watch.paused === true) {
      lines.push("  paused: yes");
      lines.push(`  paused by: ${dash(watch.paused_by)}`);
      lines.push(`  paused until: ${dash(watch.paused_until)}`);
      lines.push(`  pause reason: ${dash(watch.pause_reason)}`);
    }
    if (watch.error) lines.push(`  error: ${watch.error}`);
  }

  if (isRecord(report.debug)) {
    section("debug capture");
    const debug = report.debug;
    lines.push(debug.type === "debug-stopped"
      ? `  stopped: ${debug.reason === "storage_limit" ? "reached the storage budget with nothing left to rotate out" : dash(debug.reason)} at ${dash(debug.at)}; tap debug on starts a new capture`
      : "  enabled but not responding; inspect tap debug status");
    lines.push(`  capture: ${dash(debug.capture_id)}`);
  }

  const invalidInjection = (report.attention as Record<string, unknown>[]).find((item) => item.type === "injection-behavior-invalid");
  if (invalidInjection) {
    section("injection");
    lines.push(`  delivery is refused until config.toml is fixed: ${invalidInjection.detail}`);
  }

  section("last activity");
  lines.push(`  payload: ${report.last_payload_age_seconds === null ? "none" : `${report.last_payload_age_seconds}s`}`);
  lines.push(`  receipt: ${report.last_receipt_age_seconds === null ? "none" : `${report.last_receipt_age_seconds}s`}`);

  if ((report.unsettled as unknown[]).length > 0) {
    section("unsettled payloads");
    lines.push(table(
      ["id", "age", "from", "to", "kind", "path"],
      (report.unsettled as Record<string, unknown>[]).map((u) => [
        `${u.id}.md`,
        `${u.age_seconds}s`,
        u.from_team ? `${u.from_team}/${u.from}` : String(u.from),
        u.to_team ? `${u.to_team}/${u.to}` : String(u.to),
        String(u.kind),
        String(u.path),
      ]),
    ).split("\n").filter((line) => line.length > 0).map((line) => `  ${line}`).join("\n"));
  }

  const dead = report.dead_letters as { count: number; action: string } | undefined;
  if (dead) {
    section("dead letters");
    lines.push(`  ${dead.count} unsettled to retired seats (no attention); clean up: ${dead.action}`);
  }

  if ((report.roster as unknown[]).length > 0) {
    section("roster");
    for (const seat of report.roster as Record<string, unknown>[]) {
      lines.push(`  ${seat.handle}  recorded: ${dash(seat.status)}  harness: ${dash(seat.harness)}  pane: ${dash(seat.pane)}  state: ${dash(seat.state)}`);
    }
  }

  if ((report.supervision as unknown[]).length > 0) {
    section("supervision traffic");
    for (const item of report.supervision as Record<string, unknown>[]) {
      lines.push(`  ${item.id}  kind: ${item.kind}  age: ${item.age_seconds}s`);
    }
  }

  if ((report.events as unknown[]).length > 0) {
    section("registry events");
    for (const line of report.events as string[]) lines.push(`  ${line}`);
  }

  return `${lines.join("\n")}\n`;
}
