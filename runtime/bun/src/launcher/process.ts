import { spawn } from "node:child_process";
import { redact, verbose } from "../verbose";
import { startupCommandResult } from "../startup-trace";
import { operationDiagnostic } from "../lifecycle-diagnostics";

export type CommandResult = { code: number; stdout: string; stderr: string };
export class LaunchCommandError extends Error {
  constructor(readonly argv: string[], readonly result: CommandResult) {
    super(`command failed (exit ${result.code}): ${argv.join(" ")}`);
  }
}

/** No inherited terminal/control descriptors; cancellation waits for the owned group. */
export async function launchCommand(
  argv: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal; check?: boolean; timeoutMs?: number } = {},
): Promise<CommandResult> {
  options.signal?.throwIfAborted();
  const env = options.env ?? process.env;
  verbose("command", { argv, cwd: options.cwd ?? process.cwd() }, env);
  // The diagnostics writer omits argv and redacts any `*key*` field, as it did
  // for the Python launcher's capture, so neither is sent.
  operationDiagnostic("command", {
    cwd: options.cwd ?? process.cwd(),
    socket: env.TAP_TMUX_SOCKET_PATH || env.TAP_TMUX_SOCKET || env.TMUX || "default",
  }, env);
  const child = spawn(argv[0]!, argv.slice(1), {
    env, cwd: options.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "", failure: Error | undefined, timedOut = false;
  child.stdout.setEncoding("utf8").on("data", value => { stdout += value; });
  child.stderr.setEncoding("utf8").on("data", value => { stderr += value; });
  const exited = new Promise<number>(resolve => {
    child.once("error", error => { failure = error; resolve(127); });
    child.once("close", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)));
  });
  const pid = child.pid;
  const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
    if (!pid || pid < 2) return false;
    try { process.kill(-pid, signal); return true; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false;
      // Darwin returns EPERM for a group containing only unreaped zombies.
      // Keep observing until absence is proved; a live denial is never success.
      if (code === "EPERM") return true;
      throw error;
    }
  };
  let termination: Promise<void> | undefined;
  let terminationFailure: unknown;
  const terminate = async () => {
    if (!signalGroup("SIGTERM")) return;
    const grace = Date.now() + 500;
    while (signalGroup(0) && Date.now() < grace) await Bun.sleep(10);
    if (!signalGroup("SIGKILL")) return;
    const deadline = Date.now() + 2000;
    while (signalGroup(0) && Date.now() < deadline) await Bun.sleep(10);
    if (signalGroup(0)) throw new Error(`cannot terminate owned launch process group ${pid}; command custody is unconfirmed`);
  };
  const interrupt = () => {
    termination ??= terminate().catch(error => { terminationFailure = error; });
  };
  options.signal?.addEventListener("abort", interrupt, { once: true });
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; interrupt(); }, options.timeoutMs);
  try {
    const code = await exited;
    await termination;
    if (terminationFailure) throw terminationFailure;
    if (failure) {
      operationDiagnostic("command_error", { status: null, error: redact(String(failure), env), stderr: "" }, env);
      throw failure;
    }
    const result = { code: timedOut ? 124 : code, stdout, stderr };
    startupCommandResult(argv, result, env);
    verbose("command_exit", { status: code, stderr }, env);
    operationDiagnostic("command_exit", { status: result.code, stderr: redact(stderr, env) }, env);
    if (argv.includes("display-message") || argv.includes("capture-pane")) operationDiagnostic("pane_output", {}, env);
    // Returning effect evidence lets the transaction account for a stop that
    // completed concurrently with cancellation before beginning its unwind.
    if (options.check && result.code !== 0) throw new LaunchCommandError(argv, result);
    return result;
  } finally {
    options.signal?.removeEventListener("abort", interrupt);
    if (timer) clearTimeout(timer);
  }
}

export function launchTmux(args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal, nativeSocket = true, timeoutMs?: number): Promise<CommandResult> {
  let prefix: string[] = [];
  const childEnv = { ...env };
  if (nativeSocket && (env.TAP_TMUX_SOCKET_PATH || env.TAP_TMUX_SOCKET)) {
    prefix = env.TAP_TMUX_SOCKET_PATH ? ["-S", env.TAP_TMUX_SOCKET_PATH] : ["-L", env.TAP_TMUX_SOCKET!];
    delete childEnv.TMUX;
    delete childEnv.TMUX_PANE;
  }
  return launchCommand(["tmux", ...prefix, ...args], { env: childEnv, signal, timeoutMs });
}
