// Always-on recording ([debug] always_on): the per-command arm check.
//
// main.ts runs this for a public command that found no live recorder. With
// always_on off (the default) it costs two stats and one tiny read. It never
// locks, signals or inspects a process, never writes to the command's stdout
// or stderr, and never throws. Only a machine that opted in and has no live
// recorder pays more: one O_EXCL create per command, and at most one detached
// `tap debug on` per minute.
//
// Arming takes no lock of its own. The window claim (arm.attempt.<minute>)
// limits a burst, such as the first commands after a reboot, to one child per
// minute. The only lock is the debug control lock inside that child: a child
// that loses a race finds a live recorder there and exits 0 without doing
// anything. Two children close together (across a minute boundary) are
// therefore harmless by design, and no command ever waits on another.
//
// Every file this path opens is opened non-blocking and must be a regular file:
// a FIFO planted at the cache or arm.log would otherwise block the command in
// open or read, where no catch can reach it. A non-regular cache is a miss; a
// non-regular arm.log means no log.
import { closeSync, constants, fstatSync, ftruncateSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { configDirectory, debugConfig, type DebugConfig } from "./config-file";
import { bunBinary } from "./courier-argv";
import { atomicWrite } from "./fsatomic";
import { runtimeModule } from "./scripts-dir";
import armCommands from "./debug-arm-commands.txt" with { type: "text" };
import { ownBunArgv } from "./own-bun";

/** One arm child per window, at most. */
export const ARM_WINDOW_MS = 60_000;
/** arm.log restarts past this size; a machine with no tmux server logs one failed arm per minute. */
export const ARM_LOG_MAX_BYTES = 1 << 20;
/** Marks the arm child and everything it starts; none of them arm. */
export const ARM_CHILD = "TAP_DEBUG_ALWAYS_ON_CHILD";
/** TAP state roots a test or probe pins. With any of them set while the config
 * directory is the real user's, state is sandboxed but config is the operator's:
 * arming would start a recorder in the sandbox because the operator turned
 * always_on on. Arming needs the config sandboxed too, or no state pin at all. */
export const STATE_PINS = ["TAP_INDEX_HOME", "TAP_HOME", "TAP_SESSION_MANIFEST", "TAP_LOCK_DIR", "TAP_VERSION_SEEN_PATH", "OPENCODE_DB_PATH"];
const CLAIM = /^arm\.attempt\.(\d+)$/;
/** One command allowlist, also read by bin/tap before Bun starts. */
const ARM_COMMANDS = new Set(armCommands.trim().split("\n"));

export const debugHome = (env: NodeJS.ProcessEnv) => join(env.TAP_INDEX_HOME || join(homedir(), ".tap"), "debug");

/** Arming starts `tap debug on`, which runs the tap-events recorder. A configured
 * tmux source is the installer's LaunchAgent and never proves that recorder
 * live, so always_on without tap-events arms nothing. */
export const armsTapEvents = (config: DebugConfig) => config.always_on === true && config.capture.includes("tap-events");

/** Append one line to arm.log, restarting it past ARM_LOG_MAX_BYTES. Returns the open
 * descriptor for a child's output, or null when arm.log cannot be a regular file we write. */
function openArmLog(home: string, line: string): number | null {
  let fd: number;
  try { fd = openSync(join(home, "arm.log"), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NONBLOCK, 0o600); }
  catch { return null; }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) { closeSync(fd); return null; }
    if (info.size > ARM_LOG_MAX_BYTES) ftruncateSync(fd, 0);
    writeSync(fd, `${new Date().toISOString()} ${line}\n`);
    return fd;
  } catch { closeSync(fd); return null; }
}

/** The cache's bytes, or null when it is absent, unreadable or not a regular file. */
function readCache(path: string): string | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK); } catch { return null; }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(128);
    return buffer.toString("utf8", 0, readSync(fd, buffer, 0, buffer.length, 0));
  } catch { return null; }
  finally { closeSync(fd); }
}

/** Whether the config the reader opens is the real user's: its directory resolves to
 * <passwd home>/.config, or its config.toml is the same file (dev and ino) as
 * <passwd home>/.config/tap/config.toml, which catches a symlinked tap directory and a
 * symlinked or hardlinked config.toml at any depth. The real home comes from the passwd
 * entry, never $HOME, which a sandbox rewrites. */
export function readsRealConfig(env: NodeJS.ProcessEnv, passwdHome: () => string = () => userInfo().homedir): boolean {
  const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
  let directory: string;
  try { directory = configDirectory(env); } catch { return true; }
  const home = passwdHome();
  if (real(dirname(directory)) === real(join(home, ".config"))) return true;
  try {
    const mine = statSync(join(directory, "config.toml")), theirs = statSync(join(home, ".config", "tap", "config.toml"));
    return mine.dev === theirs.dev && mine.ino === theirs.ino;
  } catch { return false; }
}

/**
 * The arm bit (armsTapEvents). config.toml is parsed only after it changes: the answer is
 * cached in always-on.cache as `<mtimeMs> <size> <ino> <0|1>` for the file it
 * was read from. A missing config is off and writes nothing. A config the
 * reader refuses is off, cached, and named once in arm.log; typed refusals are
 * shown by `tap debug config` and `tap debug on`, never on a user's command.
 */
export function alwaysOnCached(env: NodeJS.ProcessEnv, home = debugHome(env)): boolean {
  let config: string;
  try { config = join(configDirectory(env), "config.toml"); } catch { return false; }
  let stat: ReturnType<typeof statSync>;
  try { stat = statSync(config); } catch { return false; }
  const key = `${stat.mtimeMs} ${stat.size} ${stat.ino}`, cache = join(home, "always-on.cache");
  // A torn, foreign or non-regular cache reads as a miss; the write below replaces it.
  const cached = readCache(cache);
  if (cached === `${key} 0\n` || cached === `${key} 1\n`) return cached.endsWith("1\n");
  let on = false, refusal: string | null = null;
  try { on = armsTapEvents(debugConfig(env)); }
  catch (error) { refusal = error instanceof Error ? error.message : String(error); }
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    atomicWrite(cache, `${key} ${on ? 1 : 0}\n`);
    if (refusal !== null) { const log = openArmLog(home, `always_on read as off: ${refusal.replace(/\s+/g, " ")}`); if (log !== null) closeSync(log); }
  } catch { /* the next command reads the config again */ }
  return on;
}

/** Start one detached `tap debug on`; its output goes to arm.log, or nowhere when arm.log is unusable. */
function startArmChild(home: string, window: number, env: NodeJS.ProcessEnv): void {
  const log = openArmLog(home, `arm window=${window} pid=${process.pid}`);
  try {
    // cwd is the debug home, so a long-lived recorder never holds a worktree directory.
    Bun.spawn([...ownBunArgv(bunBinary()), runtimeModule("src/debug.ts"), "on"], { cwd: home, stdio: ["ignore", log ?? "ignore", log ?? "ignore"], detached: true,
      env: { ...env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", [ARM_CHILD]: "1" } }).unref();
  } finally { if (log !== null) closeSync(log); }
}

/** Only explicit effectful commands may arm after successful dispatch. */
export function mayArm(args: string[]): boolean {
  const words = args.filter(arg => arg !== "-v" && arg !== "--verbose");
  const [verb, sub] = words;
  if (!verb || args.some(arg => ["help", "-h", "--help", "--dry-run", "--list-history"].includes(arg))) return false;
  // Reminder operands name recipients; only list and missing/flag-led targets are observational.
  if (verb === "remind" && (!sub || sub === "list" || sub.startsWith("-"))) return false;
  if (verb === "operate" && args.includes("--observe")) return false;
  if (verb === "calibrate" && !args.includes("-f")) return false;
  if (verb === "role") {
    let operands = 0;
    for (let i = 1; i < words.length; i++) {
      if (words[i] === "--team") { i++; continue; }
      if (!words[i]!.startsWith("-")) operands++;
    }
    if (operands < 2 && !args.includes("--unset")) return false;
  }
  return ARM_COMMANDS.has(verb) || ARM_COMMANDS.has(`${verb} ${sub}`);
}

/**
 * Arm a recorder when always_on is set and none is live. `args` is the public
 * argv. main.ts calls this only after successful dispatch, with no live recorder,
 * and applies the journal exemptions for stateless children and launch help.
 */
export function armAlwaysOn(args: string[], env: NodeJS.ProcessEnv = process.env, start = startArmChild, passwdHome?: () => string): void {
  try {
    if (env[ARM_CHILD] === "1") return;
    if (!mayArm(args)) return;
    // userInfo() is consulted only when a pin is set, so an ordinary command never pays for it.
    // The guard stops accidental contamination (a test or probe inheriting the operator's config).
    // It does not stop someone who controls the sandbox and swaps a link between this check and the
    // read: that person can run tap debug on directly, so it is outside the threat model.
    if (STATE_PINS.some(name => env[name]) && readsRealConfig(env, passwdHome)) return;
    const home = debugHome(env);
    if (!alwaysOnCached(env, home)) return;
    const window = Math.floor(Date.now() / ARM_WINDOW_MS);
    let claim: number;
    // The first command in this window wins; every other one returns here. O_EXCL
    // fails on any existing name, a FIFO included, so the claim never blocks.
    try { claim = openSync(join(home, `arm.attempt.${window}`), "wx", 0o600); } catch { return; }
    try { writeSync(claim, `${process.pid}\n`); } finally { closeSync(claim); }
    start(home, window, env);
  } catch { /* arming never changes the command */ }
}

/** The arm child drops claims from earlier windows; the current one stays claimed. */
export function pruneArmClaims(home: string, now = Date.now()): void {
  const window = Math.floor(now / ARM_WINDOW_MS);
  let names: string[];
  try { names = readdirSync(home); } catch { return; }
  for (const name of names) {
    const match = CLAIM.exec(name);
    if (match && Number(match[1]) < window) { try { unlinkSync(join(home, name)); } catch { /* already gone */ } }
  }
}

/** Preserve caller argv and pins before handlers derive their own environment. */
export function deferAlwaysOn(args: string[], env: NodeJS.ProcessEnv, arm: (args: string[], env: NodeJS.ProcessEnv) => void = armAlwaysOn): () => void {
  const publicArgs = [...args], publicEnv = { ...env };
  return () => arm(publicArgs, publicEnv);
}
