import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, constants, existsSync, mkdirSync, openSync, realpathSync, renameSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { ensureAscii } from "./fsatomic";
import { acquireNoFollowLock } from "./remind-lock";
import { artifactBun, runtimeModule } from "./scripts-dir";
import { ownBunFlags } from "./own-bun";

const CAP = 300 * 1024, MAX_LINE = 4096;
// A one-shot writer runs inside its caller's 200 ms budget and never waits;
// an operation's shared writer is off the caller's path and can.
let lockWaitMs = 0;
const SECRET = /key|token|secret|password|passwd|credential|authorization/i;
const OMIT = new Set(["prompt", "initial_prompt", "argv", "shell_command", "harness_env", "passthrough"]);
const ROW_KEYS = ["status", "status_reason", "delivery", "session", "harness", "harness_session_id",
  "transcript_path", "registered_from_worktree", "instance", "pane", "pane_id", "boot_id", "server_epoch"];
type Fields = Record<string, unknown>;
type Context = { fields: Fields; active: boolean };
/** One writer child per operation, opened by its first event; null once closed or unavailable. */
type Stream = { child: ChildProcess; sent: number; broken: boolean; exited: Promise<void> };
type Operation = { fields: Fields; scriptsDir?: string; stream?: Stream | null; diagnostics?: boolean; parent?: Operation };
// Bun's pipe reports every write flushed, so the bound is on what an operation
// hands over: a wedged writer costs at most this much parent memory.
const STREAM_CAP = 1024 * 1024, DRAIN_MS = 500;
/** What a packet's log destination is resolved from (`logPath`). */
const PLACE_KEYS = ["TAP_INDEX_HOME", "HOME"] as const;
const operations = new AsyncLocalStorage<Operation>();
/** A scope writes through its root operation: one stream per operation, opened and closed by the parent only. */
function rootOperation(operation: Operation): Operation {
  let node = operation;
  while (node.parent) node = node.parent;
  return node;
}
export function withStartupTrace<T>(work: () => T, fields = { operation_id: randomUUID(), phase: "dispatch" } as Fields, scriptsDir?: string): T {
  const operation: Operation = { fields, scriptsDir };
  let result: T;
  try { result = operations.run(operation, work); }
  catch (error) { void closeStream(operation); throw error; }
  if (result instanceof Promise) return result.finally(() => closeStream(operation)) as T;
  void closeStream(operation);
  return result;
}

/**
 * A child fields scope of the current operation: concurrent seats emit through
 * the same trace stream while their launch fields stay isolated from sibling
 * seats and from the parent's cohort-level events. The root operation alone
 * opens and closes the stream.
 */
export function withStartupTraceScope<T>(work: () => T, seed: Fields = {}): T {
  const parent = operations.getStore();
  if (!parent) return work();
  return operations.run({ fields: { ...parent.fields, ...seed }, scriptsDir: parent.scriptsDir, diagnostics: parent.diagnostics, parent }, work);
}

function writer(env: NodeJS.ProcessEnv, scriptsDir?: string): [string, string[]] | null {
  // Without a scripts dir the writer re-runs this very module (a test's stubbed copy included);
  // only the compiled router, whose own path is virtual, takes the shipped one.
  const self = import.meta.path.startsWith("/$bunfs/") ? runtimeModule("src/startup-trace.ts") : resolve(import.meta.dir, "startup-trace.ts");
  const worker = scriptsDir ? resolve(scriptsDir, "../../../runtime/bun/src/startup-trace.ts") : self;
  const bun = artifactBun() ?? (scriptsDir ? env.TAP_SMOKE_BUN || Bun.which("bun", { PATH: env.PATH }) : process.execPath);
  return bun ? [bun, [...ownBunFlags(bun), worker]] : null;
}

/** Keep filesystem work in a killable child, including when imported by a launcher. */
function writeNative(op: string, args: Fields, env: NodeJS.ProcessEnv = process.env, context?: Context): void {
  // The writer stamps rows when it drains them; evidence needs the caller's
  // clock at emission, so every packet carries it alongside the op.
  const packet = { ...args, emitted_at: new Date().toISOString().replace("Z", "000+00:00") };
  const operation = operations.getStore();
  if (operation) return writeStream(rootOperation(operation), op, packet, env, context);
  try {
    const command = writer(env);
    if (!command) return;
    spawnSync(command[0], command[1], {
      input: JSON.stringify({ op, args: packet, context: context ? JSON.stringify(context) : null }), cwd: env.HOME,
      env: { ...env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      stdio: ["pipe", "ignore", "ignore"], timeout: 200, killSignal: "SIGKILL",
    });
  } catch { /* Evidence must never change the operation result. */ }
}

/**
 * Inside an operation, events share one writer child instead of paying a Bun
 * start each. The child runs in its own process group, so a terminal interrupt
 * that ends the launch cannot also drop its launch_failure evidence.
 */
function writeStream(operation: Operation, op: string, args: Fields, env: NodeJS.ProcessEnv, context?: Context): void {
  try {
    if (operation.stream === undefined) {
      operation.stream = null;
      const command = writer(process.env, operation.scriptsDir);
      if (!command) return;
      const child = spawn(command[0], [...command[1], "--stream"], {
        cwd: process.env.HOME, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
        stdio: ["pipe", "ignore", "ignore"], detached: true,
      });
      const stream: Stream = { child, sent: 0, broken: false,
        exited: new Promise(done => { child.once("exit", () => done()); child.once("error", () => done()); }) };
      child.on("error", () => { stream.broken = true; });
      child.stdin!.on("error", () => { stream.broken = true; });
      child.unref();
      operation.stream = stream;
    }
    const stream = operation.stream;
    if (!stream || stream.broken) return;
    // A one-shot writer ran with the caller's env as it stood at the call:
    // its secret values and its log root. The shared child started earlier,
    // so each packet carries both.
    const secrets = Object.entries(env).filter(([key, value]) => value && SECRET.test(key)).map(([, value]) => value);
    const place = Object.fromEntries(PLACE_KEYS.map(key => [key, env[key] ?? null]));
    const line = JSON.stringify({ op, args, context: context ? JSON.stringify(context) : null, secrets, place }) + "\n";
    if (stream.sent + line.length > STREAM_CAP) return;
    stream.sent += line.length;
    stream.child.stdin!.write(line);
  } catch { /* Evidence must never change the operation result. */ }
}

/** EOF lets the child finish its queue; one that outlives the drain budget is killed. */
async function closeStream(operation: Operation): Promise<void> {
  const stream = operation.stream;
  operation.stream = null;
  if (!stream) return;
  try {
    stream.child.stdin!.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([stream.exited, new Promise<void>(done => { timer = setTimeout(done, DRAIN_MS); })]);
    clearTimeout(timer);
    if (stream.child.exitCode === null && stream.child.signalCode === null && stream.child.pid) process.kill(-stream.child.pid, "SIGKILL");
  } catch { /* Evidence must never change the operation result. */ }
}

export function startupTrace(event: string, fields: Fields = {}, rotate = false): void {
  try {
    const context = operations.getStore()?.fields;
    if (context) {
      if (event === "launch_start") Object.assign(context, fields);
      if (event === "create_session" || event === "respawn_pane") Object.assign(context, fields, { phase: event });
    }
    writeNative("emit", { event, rotate, fields: { ...context, ...fields } });
  } catch { /* Even caller field serialization is best effort. */ }
}

export function startupTransition(registry: string, handle: string, before: unknown, after: unknown, relaunchable: boolean): void {
  writeNative("transition", { registry, handle, before, after, relaunchable, context: operations.getStore()?.fields });
}

export function startupCommandResult(argv: string[], result: { code: number; stderr: string }, env: NodeJS.ProcessEnv): void {
  const context = operations.getStore()?.fields;
  if (context && basename(argv[0] ?? "") === "tmux") writeNative("command_result", {
    argv, result: { returncode: result.code, stderr: result.stderr },
  }, env, { fields: context, active: true });
}

/** Record whether the current operation is diagnosed; false outside an operation. */
export function setOperationDiagnostics(on: boolean): boolean {
  const operation = operations.getStore();
  if (!operation) return false;
  return operation.diagnostics = on;
}

export function operationDiagnostics(): boolean {
  return operations.getStore()?.diagnostics === true;
}

/** Diagnostic enablement and pane-output filtering remain with their caller. */
export function startupDiagnostic(event: string, fields: Fields, env: NodeJS.ProcessEnv): void {
  writeNative("diagnostic", { record: { event, ...fields }, rotate: true }, env);
}

function record(value: unknown): Fields {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
}

let callerSecrets: string[] = [];

function clean(value: unknown): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const [key, secret] of Object.entries(process.env)) {
      if (SECRET.test(key) && secret) text = text.split(secret).join("<redacted>");
    }
    for (const secret of callerSecrets) text = text.split(secret).join("<redacted>");
    text = text.replace(/(\b\S*(?:key|token|secret|password)\S*\s*[=:]\s*)\S+/gi, "$1<redacted>");
    return Array.from(text).slice(0, 600).join("");
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(clean);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !OMIT.has(key))
      .map(([key, item]) => [key, SECRET.test(key) ? "<redacted>" : clean(item)]));
  }
  return value;
}

function logPath(): string {
  // Read per packet: a shared writer serves callers with their own HOME.
  return join(process.env.TAP_INDEX_HOME || join(process.env.HOME || homedir(), ".tap"), "logs", "startup.jsonl");
}

function append(path: string, entry: Fields, rotate = false, cap = CAP, rotations = 1): boolean {
  try {
    const data = Buffer.from(ensureAscii(JSON.stringify(clean(entry))).replace(/\x7f/g, "\\u007f") + "\n");
    if (data.length >= MAX_LINE) return false;
    // Establish private directories BEFORE the shared lock helper can create them.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const held = acquireNoFollowLock(path + ".lock", lockWaitMs);
    if (!held) return false;
    try {
      const size = existsSync(path) ? statSync(path).size : 0;
      if (size + data.length > cap) {
        if (!rotate) return false;
        for (let index = rotations - 1; index > 0; index--) {
          if (existsSync(path + `.${index}`)) renameSync(path + `.${index}`, path + `.${index + 1}`);
        }
        renameSync(path, path + ".1");
      }
      const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
      try { return writeSync(fd, data) === data.length; }
      finally { closeSync(fd); }
    } finally { held.release(); }
  } catch { return false; }
}

function stamp(): Fields {
  return { schema: 1, timestamp: new Date().toISOString().replace("Z", "000+00:00"), pid: process.pid };
}

function emit(context: Context | null, event: string, fields: Fields = {}, rotate = false, emittedAt?: string): boolean {
  return append(logPath(), { ...stamp(), ...(emittedAt !== undefined ? { emitted_at: emittedAt } : {}), ...context?.fields, event, ...fields }, rotate);
}

function snapshot(row: unknown): unknown {
  return row !== null && typeof row === "object" && !Array.isArray(row)
    ? clean(Object.fromEntries(ROW_KEYS.filter(key => key in row).map(key => [key, (row as Fields)[key]]))) : null;
}

function socketPath(): string {
  const env = process.env;
  const path = resolve(env.TAP_TMUX_SOCKET_PATH || (!env.TAP_TMUX_SOCKET && env.TMUX ? env.TMUX.split(",")[0]!
    : join(env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid!()}`, env.TAP_TMUX_SOCKET ?? "default")));
  // os.path.realpath also resolves existing parents of an absent socket.
  let prefix = path;
  const tail: string[] = [];
  for (;;) {
    try { return join(realpathSync(prefix), ...tail); } catch { /* absent tail */ }
    if (dirname(prefix) === prefix) return path;
    tail.unshift(basename(prefix));
    prefix = dirname(prefix);
  }
}

function activate(context: Context | null, emittedAt?: string): void {
  if (context && !context.active) {
    context.active = true;
    emit(context, "launch_start", { socket: socketPath() }, true, emittedAt);
  }
}

/** Python carries this capsule unchanged; all lifecycle decisions live here. */
function dispatch(op: string, args: Fields, context: Context | null): { context: Context | null; value: unknown } {
  // A packet carries its caller's emission clock; a bare one (the legacy
  // capsule protocol) falls back to handling time, which matches `timestamp`.
  const emittedAt = typeof args.emitted_at === "string" && args.emitted_at
    ? args.emitted_at : new Date().toISOString().replace("Z", "000+00:00");
  let value: unknown = null;
  switch (op) {
    case "begin":
      context = { fields: { operation_id: randomUUID().replaceAll("-", ""), verb: args.verb, cwd: args.cwd,
        phase: "dispatch", boot_id: args.boot_id, target: args.target }, active: false };
      activate(context, emittedAt);
      break;
    case "finish":
      if (context?.active) emit(context, args.code === 0 ? "launch_complete" : "launch_failure", { exit_code: args.code }, false, emittedAt);
      context = null;
      break;
    case "emit":
      if (typeof args.event !== "string") throw new Error("missing event");
      value = emit(context, args.event, record(args.fields), args.rotate === true, emittedAt);
      break;
    case "command_result": {
      const argv = args.argv;
      if (!context?.active || !Array.isArray(argv) || !argv.length || basename(String(argv[0])) !== "tmux") break;
      const result = record(args.error ?? args.result);
      const code = result.returncode ?? null;
      const command = ["new-session", "new-window", "respawn-pane", "kill-session", "kill-pane", "start-server"].find(cmd => argv.includes(cmd));
      if (code === 0 && command === undefined) break;
      emit(context, "tmux_result", { command: command ?? "observation_or_guard", exit_code: code,
        error: args.error ? result.error_class : null, stderr: result.stderr || "" }, false, emittedAt);
      break;
    }
    case "transition": {
      if (typeof args.registry !== "string" || typeof args.handle !== "string" || !("before" in args) || !("after" in args) || typeof args.relaunchable !== "boolean") throw new Error("invalid transition");
      const fields = { handle: args.handle, before: snapshot(args.before), after: snapshot(args.after), relaunchable: args.relaunchable };
      const extra = record(args.context);
      const { pid, ...journalStamp } = stamp();
      append(join(dirname(String(args.registry)), "registry-events.jsonl"), {
        ...journalStamp, emitted_at: emittedAt, event: "launch_rollback", ...fields, ...context?.fields, ...extra,
      }, false, Infinity);
      emit(context, "launch_rollback", { ...fields, ...extra }, false, emittedAt);
      break;
    }
    case "diagnostic":
      if (typeof record(args.record).event !== "string") throw new Error("missing diagnostic event");
      value = append(join(dirname(logPath()), "launch-debug.jsonl"), { ...stamp(), emitted_at: emittedAt, ...record(args.record) }, args.rotate === true, 5 * 1024 * 1024, 3);
      break;
    default: throw new Error("unknown trace operation");
  }
  return { context, value };
}

function packetContext(raw: unknown): Context | null {
  const context: Context | null = raw == null ? null : JSON.parse(String(raw));
  if (context !== null && (typeof context !== "object" || Array.isArray(context) || typeof context.active !== "boolean" || !context.fields || Array.isArray(context.fields) || typeof context.fields !== "object")) throw new Error("invalid context");
  return context;
}

/** An operation's shared writer: one packet per line until EOF; a bad packet costs only itself. */
async function serveStream(): Promise<void> {
  lockWaitMs = 100;
  const decoder = new TextDecoder();
  let pending = "";
  const own = Object.fromEntries(PLACE_KEYS.map(key => [key, process.env[key]]));
  const settle = (place: Record<string, unknown>) => {
    for (const key of PLACE_KEYS) {
      const value = place[key];
      if (typeof value === "string") process.env[key] = value; else delete process.env[key];
    }
  };
  const handle = (line: string) => {
    try {
      const packet = JSON.parse(line);
      callerSecrets = Array.isArray(packet.secrets) ? packet.secrets.filter((value: unknown) => typeof value === "string" && value) : [];
      if (packet.place !== undefined) settle(record(packet.place));
      dispatch(packet.op, record(packet.args), packetContext(packet.context));
    } catch { /* The caller quietly omits failed evidence. */ }
    finally { callerSecrets = []; settle(own); }
  };
  for await (const chunk of Bun.stdin.stream()) {
    pending += decoder.decode(chunk, { stream: true });
    for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
      handle(pending.slice(0, end));
      pending = pending.slice(end + 1);
    }
  }
}

if (import.meta.main && process.argv[2] === "--stream") {
  await serveStream().catch(() => { process.exitCode = 1; });
} else if (import.meta.main) {
  try {
    const packet = JSON.parse(await Bun.stdin.text());
    const context = packetContext(packet.context);
    const result = dispatch(packet.op, record(packet.args), context);
    process.stdout.write(JSON.stringify({ context: result.context === null ? null : JSON.stringify(result.context), value: result.value }));
  } catch { process.exitCode = 1; /* The caller quietly omits failed evidence. */ }
}
