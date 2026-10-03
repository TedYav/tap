// On-demand, socket-scoped tmux startup. Never replaces an existing server.
// In-process for launch, resume and the shared transaction: the former
// The incumbent's bootstrap child cost 0.17-0.47 s per launch (launch-ts row 1).
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { acquirePathLockAsync } from "../panelock";
import { startupTrace } from "../startup-trace";
import { physicalSocketPath } from "../tmux";
import { launchCommand, type CommandResult } from "./process";

export type BootstrapOptions = { signal?: AbortSignal; warn?: (line: string) => void };

const SCRUBBED_KEYS = new Set(["TMUX", "TMUX_PANE", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"]);
const SCRUBBED_PREFIXES = ["CLAUDE", "CODEX", "GEMINI", "ANTHROPIC_", "TAP_"];
const DEFAULT_DAEMON_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin";

/** The one line every caller renders for a failed bootstrap. */
export function tmuxBootstrapFailure(error: unknown): string {
  return `tmux bootstrap failed: ${error instanceof Error ? error.message : String(error)}; next: tap doctor`;
}

/** `[tmux] bootstrap` in config.toml; an absent or unreadable config means enabled. */
export function tmuxBootstrapEnabled(env: NodeJS.ProcessEnv, warn: (line: string) => void = () => {}): boolean {
  if (!env.XDG_CONFIG_HOME && env.HOME === undefined) throw new Error("HOME is unset");
  const config = join(env.XDG_CONFIG_HOME || join(env.HOME!, ".config"), "tap/config.toml");
  if (!existsSync(config)) return true;
  let table: unknown;
  try {
    table = (Bun.TOML.parse(readFileSync(config, "utf8")) as Record<string, unknown>).tmux ?? {};
  } catch {
    warn(`tap config: could not read ${config}; defaulting tmux bootstrap to enabled`);
    return true;
  }
  const value = table !== null && typeof table === "object" && !Array.isArray(table)
    ? (table as Record<string, unknown>).bootstrap ?? true : undefined;
  if (typeof value !== "boolean") throw new Error("tmux.bootstrap must be true or false");
  return value;
}

/** A server started from a seat must not inherit that seat's identity, credentials or git binding. */
export async function daemonEnvironment(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<NodeJS.ProcessEnv> {
  const child: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (SCRUBBED_PREFIXES.some(prefix => key.startsWith(prefix)) || SCRUBBED_KEYS.has(key) || /KEY|TOKEN|SECRET|PASSWORD/i.test(key)) continue;
    child[key] = value;
  }
  let path = "";
  if (process.platform === "darwin") {
    try {
      const result = await launchCommand(["/bin/launchctl", "getenv", "PATH"], { env, signal, timeoutMs: 1000 });
      if (result.code === 0) path = result.stdout.trim();
    } catch (error) {
      signal?.throwIfAborted();
      void error; // An unavailable launchd PATH falls back to the fixed default.
    }
  }
  child.PATH = path || DEFAULT_DAEMON_PATH;
  if (!child.TERM || child.TERM === "dumb") child.TERM = "xterm-256color";
  child.PWD = env.HOME;
  return child;
}

function timedOut(result: CommandResult, argv: string[], seconds: number): void {
  if (result.code === 124) throw new Error(`Command ${JSON.stringify(argv)} timed out after ${seconds} seconds`);
}

/** Start the socket's server when it is absent; true only when this call started it. */
export async function ensureTmuxServer(env: NodeJS.ProcessEnv = process.env, options: BootstrapOptions = {}): Promise<boolean> {
  const { signal, warn } = options;
  if (!tmuxBootstrapEnabled(env, warn)) return false;
  const executable = Bun.which("tmux", { PATH: env.PATH ?? "" });
  if (!executable) throw new Error("tmux was not found on PATH; install tmux and check tmux -V");
  const socket = physicalSocketPath(env);
  const probe = async (): Promise<string | null> => {
    const argv = [executable, "-N", "-S", socket, "display-message", "-p", "#{pid}"];
    const result = await launchCommand(argv, { env, signal, timeoutMs: 2000 });
    timedOut(result, argv, 2);
    const pid = result.stdout.trim();
    if (result.code === 0 && /^\d+$/.test(pid)) return pid;
    if (/no server running|No such file or directory/.test(result.stderr)) return null;
    throw new Error(`tmux server is unobservable: ${result.stderr.trim() || `exit ${result.code}, no server identity`}`);
  };
  if (await probe()) return false;
  const root = env.TAP_INDEX_HOME || join(env.HOME ?? "", ".tap");
  const lockPath = join(root, "locks", `tmux-bootstrap-${createHash("sha256").update(socket).digest("hex")}.lock`);
  mkdirSync(join(root, "locks"), { recursive: true });
  const lock = await acquirePathLockAsync(lockPath, 3000, signal, env);
  if (!lock) throw new Error("tmux bootstrap lock timed out");
  try {
    if (await probe()) return false;
    const home = env.HOME ?? "";
    let homeIsDir = false;
    try { homeIsDir = isAbsolute(home) && statSync(home).isDirectory(); } catch { /* reported below */ }
    if (!homeIsDir) throw new Error("HOME must name an existing absolute directory");
    mkdirSync(join(socket, ".."), { recursive: true, mode: 0o700 });
    const argv = [executable, "-S", socket, "start-server", ";", "set-option", "-s", "exit-empty", "off"];
    const result = await launchCommand(argv, { env: await daemonEnvironment(env, signal), cwd: home, signal, timeoutMs: 5000 });
    timedOut(result, argv, 5);
    const unsupported = result.stderr.includes("unknown option: exit-empty");
    if (result.code !== 0 && !unsupported) {
      startupTrace("tmux_bootstrap", { socket, cwd: home, exit_code: result.code, stderr: result.stderr });
      throw new Error(result.stderr.trim() || "tmux start-server failed");
    }
    const readyDeadline = performance.now() + 2000;
    let pid = await probe();
    while (!pid && performance.now() < readyDeadline) {
      await Bun.sleep(25);
      pid = await probe();
    }
    if (!pid) throw new Error("tmux server did not remain available after startup");
    startupTrace("tmux_bootstrap", { socket, cwd: home, server_pid: pid, exit_empty: unsupported ? "unsupported" : "off", exit_code: 0 });
    return true;
  } finally {
    await lock.release();
  }
}
