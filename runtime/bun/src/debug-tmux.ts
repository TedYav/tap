// launchd owns scheduling; the Bash entry owns all capture and retention policy.
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { configDirectory, debugConfigFromTable, parseAdvancedSettings, readCatalog, refuse, type Table } from "./config-file";
import { LauncherError } from "./config-error";
import { atomicWrite } from "./fsatomic";
import { acquireNoFollowLock } from "./digest-window";
import { readManifestRecord, writeManifestAtomically, type ManifestEntry } from "./install-manifest";
import { tapRoot } from "./scripts-dir";

const LABEL = "local.tmux-flight";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
type Result = { code: number; stdout: string; stderr: string };
type Plist = { Label: string; ProgramArguments: string[]; StartInterval: number; Disabled?: boolean; RunAtLoad?: boolean;
  EnvironmentVariables?: Record<string, string>; StandardOutPath?: string; StandardErrorPath?: string; [key: string]: unknown };
type Snapshot = { directory: string; enabled: boolean; interval: number; socket: string; environment: Record<string, string>; wrapper: string };
type Owned = ManifestEntry & { tmux: Snapshot };
export interface TmuxControlIO {
  platform: string; root: string; now(): number; wait(): Promise<unknown>; which(name: string, env: NodeJS.ProcessEnv): string | null;
  run(argv: string[], env: NodeJS.ProcessEnv, timeout?: number): Promise<Result>;
  readPlist(path: string, env: NodeJS.ProcessEnv): Promise<Plist>;
  verifySample(directory: string, since: number, socket: string): Promise<void>;
  incidentProbe(bash: string, script: string, env: NodeJS.ProcessEnv): Promise<void>;
}
const paths = (env: NodeJS.ProcessEnv) => {
  if (!env.HOME || !isAbsolute(env.HOME)) refuse("debug_tmux_invalid", "HOME must be absolute");
  return { plist: join(env.HOME, "Library/LaunchAgents", LABEL + ".plist"),
    manifest: env.TAP_INSTALL_MANIFEST || join(env.TAP_INDEX_HOME || join(env.HOME, ".tap"), "install-manifest.json"),
    directory: env.TMUX_FLIGHT_DIR || join(env.HOME, "Library/Logs/tmux-flight") };
};
function regular(path: string): string | null {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`preserving non-regular path ${path}`);
  return readFileSync(path, "utf8");
}
function ownedEntry(env: NodeJS.ProcessEnv): Owned | undefined {
  const p = paths(env), manifest = readManifestRecord(p.manifest);
  const entry = manifest.entries.find(e => e.path === p.plist && e.kind === "file" && e.launchd_label === LABEL && e.tmux) as Owned | undefined;
  return entry && regular(p.plist) !== null && hash(readFileSync(p.plist)) === entry.sha256 ? entry : undefined;
}
function state(directory: string) {
  const raw = regular(join(directory, ".state"));
  if (!raw || !raw.endsWith("\n")) return null;
  const cells = raw.trimEnd().split("\t");
  if (cells.length !== 12 || cells[0] !== "v1" || !["true", "false", "null"].includes(cells[2]!)) return null;
  if (![1, 4, 5, 6, 7, 8, 9, 10].every(i => /^(0|[1-9][0-9]{0,11})$/.test(cells[i]!))) return null;
  if (cells[3] !== "null" && !/^(0|[1-9][0-9]{0,8})$/.test(cells[3]!)) return null;
  if (!/^-(L|S):[^\n\t]+$/.test(cells[11]!)) return null;
  return { time: Number(cells[1]), alive: cells[2] === "null" ? null : cells[2] === "true", incidents: Number(cells[8]),
    bytes: Number(cells[9]), overage: Number(cells[10]), maintenance: Number(cells[6]), socket: cells[11] };
}
export function tmuxSourceStatus(env = process.env) {
  try { return sourceStatus(env); }
  catch (error) { return { state: "unavailable", last_sample_at: null, alive: null, incident_count: null,
    incident_bytes: null, incident_over_budget_bytes: null, retention_sample_at: null, error: String(error) }; }
}
function sourceStatus(env: NodeJS.ProcessEnv) {
  const p = paths(env), owned = ownedEntry(env), sample = state(owned?.tmux.directory || p.directory);
  const matching = sample && (!owned || sample.socket === owned.tmux.socket) ? sample : null;
  const fresh = matching && Date.now() / 1000 - matching.time < Math.max(30, (owned?.tmux.interval ?? 5) * 3);
  return { state: !owned ? "unmanaged" : !owned.tmux.enabled ? "off" : fresh ? "recording" : "stale",
    last_sample_at: matching ? new Date(matching.time * 1000).toISOString() : null, alive: matching?.alive ?? null,
    incident_count: matching?.incidents ?? null, incident_bytes: matching?.bytes ?? null,
    incident_over_budget_bytes: matching?.overage ?? null,
    retention_sample_at: matching?.maintenance ? new Date(matching.maintenance * 1000).toISOString() : null };
}

export function tmuxControlIO(): TmuxControlIO {
  const io: TmuxControlIO = {
    platform: process.platform, root: tapRoot(), now: Date.now, wait: () => sleep(100),
    which: (name, env) => Bun.which(name, { PATH: env.PATH }),
    run: async (argv, env, timeout = 10000) => {
      const child = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr };
    },
    readPlist: async (path, env) => {
      const result = await io.run(["/usr/bin/plutil", "-convert", "json", "-o", "-", path], env);
      if (result.code) throw new Error("cannot read existing LaunchAgent: " + result.stderr.trim());
      return JSON.parse(result.stdout);
    },
    verifySample: async (directory, since, socket) => {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const sampled = state(directory), metadata = statSync(join(directory, ".state"), { throwIfNoEntry: false });
        if (sampled?.socket === socket && sampled.time >= Math.floor(since / 1000) && metadata && metadata.mtimeMs >= since) return;
        await sleep(100);
      }
      throw new Error("first sample missing");
    },
    incidentProbe: async (bash, script, env) => {
      const scratch = mkdtempSync(join(tmpdir(), "tap-tmux-install-"));
      try {
        const directory = join(scratch, "flight");
        const result = await io.run([bash, script, "incident", "-S", join(scratch, "unused.sock"), "migration verification"],
          { ...env, TMUX_FLIGHT_DIR: directory, TMUX_FLIGHT_LOG_DIR: join(directory, "server-logs") }, 30000);
        if (![0, 4].includes(result.code) || !readdirSync(directory).some(name => name.startsWith("incident-") && existsSync(join(directory, name, ".tap-owned"))))
          throw new Error("private incident probe failed");
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    },
  };
  return io;
}

const ENV_KEYS = new Set(["PATH", "HOME", "TMUX_TMPDIR", "TMUX_FLIGHT_DIR", "TMUX_FLIGHT_LOG_DIR", "TMUX_FLIGHT_RT_TIMEOUT_S",
  "TMUX_FLIGHT_INCIDENT_GAP_S", "TMUX_FLIGHT_INVENTORY_SECONDS", "TMUX_FLIGHT_LOG_CAP_BYTES", "TMUX_FLIGHT_LOG_TAIL_BYTES",
  "TMUX_FLIGHT_KEEP_DAYS", "TMUX_FLIGHT_VERBOSITY", "TMUX_FLIGHT_TIMEOUT_BIN", "TMUX_FLIGHT_ENTRY"]);
function snapshot(env: NodeJS.ProcessEnv, old: Plist | undefined, previous: Owned | undefined, enabled?: boolean) {
  const path = join(configDirectory(env), "config.toml");
  let doc: Table = {};
  try { doc = readCatalog(path).data; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const debug = debugConfigFromTable(doc.debug, path);
  const inherited = { ...(old?.EnvironmentVariables ?? previous?.tmux.environment ?? {}) };
  for (const [key, value] of Object.entries(inherited)) {
    if (!ENV_KEYS.has(key) || typeof value !== "string") throw new Error(`unsupported legacy environment override: ${key}`);
  }
  if (inherited.TMUX_FLIGHT_KEEP_DAYS && inherited.TMUX_FLIGHT_KEEP_DAYS !== "14") throw new Error("legacy retention override must be resolved before migration (TAP retains daily logs for 14 days)");
  if (inherited.TMUX_FLIGHT_VERBOSITY && inherited.TMUX_FLIGHT_VERBOSITY !== "-vv") throw new Error("legacy verbosity override must be resolved before migration (TAP uses -vv)");
  const advanced = { ...(doc.advanced as Table ?? {}) };
  const preserve = (key: string, value: unknown) => { if (value !== undefined && advanced[key] === undefined) advanced[key] = Number(value); };
  preserve("debug_tmux_sample_seconds", old?.StartInterval ?? previous?.tmux.interval);
  preserve("debug_tmux_inventory_seconds", inherited.TMUX_FLIGHT_INVENTORY_SECONDS);
  preserve("debug_tmux_timeout_seconds", inherited.TMUX_FLIGHT_RT_TIMEOUT_S);
  preserve("debug_tmux_incident_gap_seconds", inherited.TMUX_FLIGHT_INCIDENT_GAP_S);
  const tuning = parseAdvancedSettings({ ...doc, advanced }, path);
  const recorderHome = inherited.HOME || env.HOME!;
  const legacyDirectory = join(recorderHome, "Library/Logs/tmux-flight");
  const directory = inherited.TMUX_FLIGHT_DIR || (old ? legacyDirectory : paths(env).directory);
  const environment: Record<string, string> = { PATH: inherited.PATH || env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", ...inherited,
    HOME: recorderHome, TMUX_FLIGHT_DIR: directory, TMUX_FLIGHT_LOG_DIR: inherited.TMUX_FLIGHT_LOG_DIR || join(old ? legacyDirectory : directory, "server-logs"),
    TMUX_FLIGHT_INVENTORY_SECONDS: String(tuning.debug_tmux_inventory_seconds), TMUX_FLIGHT_RT_TIMEOUT_S: String(tuning.debug_tmux_timeout_seconds),
    TMUX_FLIGHT_INCIDENT_GAP_S: String(tuning.debug_tmux_incident_gap_seconds) };
  for (const key of ["TMUX_FLIGHT_DIR", "TMUX_FLIGHT_LOG_DIR", "HOME", "TMUX_TMPDIR"] as const) {
    const value = environment[key];
    if (value && (!isAbsolute(value) || /[\n\t]/.test(value))) throw new Error(`invalid legacy path: ${key}`);
  }
  for (const key of ["TMUX_FLIGHT_LOG_CAP_BYTES", "TMUX_FLIGHT_LOG_TAIL_BYTES"] as const) {
    const value = environment[key];
    if (value && (!/^[1-9][0-9]{0,11}$/.test(value))) throw new Error(`invalid legacy byte cap: ${key}`);
  }
  const wrapper = previous?.tmux.wrapper || join(dirname(paths(env).manifest), "bin/tmux-flight");
  return { directory, enabled: (enabled ?? debug.always_on) && debug.capture.includes("tmux"), interval: tuning.debug_tmux_sample_seconds,
    socket: previous?.tmux.socket || "-L:default", environment, wrapper };
}
function renderPlist(data: Snapshot, bash: string, script: string, old?: Plist): string {
  const env = Object.entries(data.environment).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join("");
  const args = [bash, script, "watch-once", data.socket.slice(0, 2), data.socket.slice(3)].map(v => `<string>${xml(v)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${LABEL}</string>\n<key>ProgramArguments</key><array>${args}</array>\n<key>StartInterval</key><integer>${data.interval}</integer>\n<key>RunAtLoad</key><${data.enabled}/>\n<key>Disabled</key><${!data.enabled}/>\n<key>EnvironmentVariables</key><dict>${env}</dict>\n<key>StandardOutPath</key><string>${xml(old?.StandardOutPath || join(data.directory, "launchd.out"))}</string>\n<key>StandardErrorPath</key><string>${xml(old?.StandardErrorPath || join(data.directory, "launchd.err"))}</string>\n</dict></plist>\n`;
}
function legacyScript(old: Plist): string {
  const args = old.ProgramArguments;
  if (old.Label !== LABEL || !Array.isArray(args) || args.length !== 3 || !["/bin/bash", "/opt/homebrew/bin/bash", "/usr/local/bin/bash"].includes(args[0]!) ||
      !isAbsolute(args[1]!) || !args[1]!.endsWith("/tmux-flight.sh") || args[2] !== "watch-once") throw new Error("unowned conflicting tmux LaunchAgent; preserved");
  const bytes = regular(args[1]!);
  if (!bytes?.includes("# tmux-flight") || !bytes.includes("cmd_watch_once()") || !bytes.includes("cmd_incident()")) throw new Error("unrecognized legacy recorder; preserved");
  for (const key of Object.keys(old)) if (!["Label", "ProgramArguments", "StartInterval", "RunAtLoad", "Disabled", "EnvironmentVariables", "StandardOutPath", "StandardErrorPath"].includes(key))
    throw new Error(`unsupported legacy plist setting: ${key}`);
  return args[1]!;
}

type Launch = (args: string[]) => Promise<Result>;
async function observeRegistration(launch: Launch, service: string, env: NodeJS.ProcessEnv, io: TmuxControlIO) {
  const current = await launch(["print", service]);
  const loaded = current.code === 0;
  if (!loaded && current.code !== 113 && !/Could not find service|not found/.test(current.stderr)) throw new Error("cannot observe existing launchd registration");
  const pid = /(?:^|\n)\s*pid\s*=\s*(\d+)/.exec(current.stdout)?.[1];
  let identity = pid ? await io.run(["ps", "-p", pid, "-o", "lstart=,command="], env) : null;
  // A one-shot may exit between launchctl print and ps. That is an observed exit.
  if (identity?.code === 1 && !identity.stderr) identity = null;
  if (identity && identity.code !== 0) throw new Error("cannot observe legacy invocation identity; registration preserved");
  return { loaded, pid, identity };
}
async function stopRegistration(registration: Awaited<ReturnType<typeof observeRegistration>>, launch: Launch, service: string,
  env: NodeJS.ProcessEnv, io: TmuxControlIO, stopped: () => void) {
  if (!registration.loaded) return;
  if ((await launch(["bootout", service])).code) throw new Error("cannot stop previous tmux registration");
  stopped();
  const { pid, identity } = registration, deadline = io.now() + 30000;
  while (pid && identity) {
    const observed = await io.run(["ps", "-p", pid, "-o", "lstart=,command="], env);
    if (observed.code === 1 && !observed.stderr || observed.code === 0 && observed.stdout !== identity.stdout) return;
    if (observed.code !== 0 || io.now() >= deadline) throw new Error("previous tmux invocation has not been observed exited");
    await io.wait();
  }
}

async function stopOwned(env: NodeJS.ProcessEnv, previous: Owned, io: TmuxControlIO) {
  const p = paths(env), service = `gui/${process.getuid!()}/${LABEL}`;
  const launch: Launch = args => io.run(["/bin/launchctl", ...args], env);
  const lock = acquireNoFollowLock(join(previous.tmux.directory, ".control.lock"), 2500);
  try {
    if (ownedEntry(env)?.sha256 !== previous.sha256) throw new Error("tmux installation changed while stopping; retry");
    const old = await io.readPlist(p.plist, env), registration = await observeRegistration(launch, service, env, io);
    if ((await launch(["disable", service])).code) throw new Error("cannot disable tmux automatic capture");
    await stopRegistration(registration, launch, service, env, io, () => {});
    // Shutdown reads installed metadata only: bad TOML or a broken Bun/Bash
    // dependency for the next capture must not keep the scheduler running.
    const next = { ...previous.tmux, enabled: false };
    const args = old.ProgramArguments;
    if (!Array.isArray(args) || args.length < 3) throw new Error("owned plist arguments are invalid");
    const rendered = renderPlist(next, args[0]!, args[1]!, old);
    atomicWrite(p.plist, rendered, 0o600);
    const manifest = readManifestRecord(p.manifest);
    manifest.entries = manifest.entries.map(entry => entry.path === p.plist ? { ...entry, sha256: hash(rendered), tmux: next } : entry);
    writeManifestAtomically(p.manifest, JSON.stringify(manifest, null, 2) + "\n");
    return tmuxSourceStatus(env);
  } finally { closeSync(lock); }
}

async function apply(env: NodeJS.ProcessEnv, io: TmuxControlIO, explicitMigration: boolean, enabled?: boolean, socket?: string) {
  if (io.platform !== "darwin") throw new Error("tmux automatic capture requires macOS launchd; the standalone tick remains available");
  const p = paths(env), previous = ownedEntry(env), before = regular(p.plist);
  if (before !== null && !previous && !explicitMigration) return { ...tmuxSourceStatus(env), enabled: false, backup: null, plist: p.plist };
  const old = before === null ? undefined : await io.readPlist(p.plist, env);
  const legacy = old && !previous ? legacyScript(old) : undefined;
  const domain = `gui/${process.getuid!()}`, service = `${domain}/${LABEL}`;
  const launch = (args: string[]) => io.run(["/bin/launchctl", ...args], env);
  const disabled = old ? await launch(["print-disabled", domain]) : null;
  if (disabled?.code) throw new Error("cannot observe launchd enablement; registration preserved");
  const override = /"local\.tmux-flight"\s*=>\s*(true|false)/.exec(disabled?.stdout ?? "")?.[1];
  const wasDisabled = override === undefined ? !!old?.Disabled : override === "true";
  const wantEnabled = enabled ?? (old ? !wasDisabled : undefined);
  const next: Snapshot = snapshot(env, old, previous, wantEnabled);
  if (socket !== undefined) {
    if (!isAbsolute(socket) || /[\n\t]/.test(socket)) throw new Error("tmux capture socket must be an absolute single-line path");
    next.socket = `-S:${socket}`;
  }
  if (legacy) next.wrapper = legacy;
  const runtimeEnv = { ...env, ...next.environment };
  const bash = io.which("bash", runtimeEnv), timeout = io.which("timeout", runtimeEnv) || io.which("gtimeout", runtimeEnv);
  if (!bash || !timeout || !isAbsolute(bash) || !isAbsolute(timeout)) throw new Error("Bash 5 and coreutils timeout are required");
  for (const command of ["tmux", "awk", "jq"]) if (!io.which(command, runtimeEnv)) throw new Error(`tmux capture dependency unavailable: ${command}`);
  const version = await io.run([bash, "-c", "printf '%s\\n' \"${BASH_VERSINFO[0]}\""], runtimeEnv);
  if (version.code || Number(version.stdout.trim()) < 5 || !/^\d+$/.test(version.stdout.trim())) throw new Error("Bash 5 is required");
  const script = join(io.root, "scripts/tap-debug-tmux-tick.sh");
  if ((await io.run([bash, "-n", script], runtimeEnv)).code) throw new Error("tmux recorder script validation failed");
  next.environment.TMUX_FLIGHT_TIMEOUT_BIN = timeout;
  next.environment.TMUX_FLIGHT_ENTRY = next.wrapper;
  const rendered = renderPlist(next, bash, script, old);
  const wrapper = `#!${bash}\n# TAP-owned router-free tmux recorder entry.\n` + Object.entries(next.environment).map(([k,v]) => `export ${k}=${quote(v)}\n`).join("") + `exec ${quote(bash)} ${quote(script)} "$@"\n`;
  const priorWrapper = regular(next.wrapper);
  const priorWrapperMode = lstatSync(next.wrapper, { throwIfNoEntry: false })?.mode;
  const priorPlistMode = lstatSync(p.plist, { throwIfNoEntry: false })?.mode;
  if (!legacy && priorWrapper !== null) {
    const entry = readManifestRecord(p.manifest).entries.find(e => e.path === next.wrapper && e.kind === "file");
    if (entry?.sha256 !== hash(priorWrapper)) throw new Error("unowned or edited tmux wrapper; preserved");
  }
  mkdirSync(next.directory, { recursive: true });
  const control = acquireNoFollowLock(join(next.directory, ".control.lock"), 2500);
  const backup = before === null ? undefined : join(next.directory, `migration-${io.now()}-${process.pid}`);
  let loaded = false, swapped = false, stopped = false, quiesced = false;
  try {
    if (regular(p.plist) !== before || regular(next.wrapper) !== priorWrapper) throw new Error("tmux installation changed while preparing; retry");
    if (explicitMigration) await io.incidentProbe(bash, script, { ...runtimeEnv, ...next.environment });
    const registration = await observeRegistration(launch, service, env, io);
    loaded = registration.loaded;
    if (loaded && before === null) throw new Error("unowned loaded tmux label without a plist; preserved");
    if (backup) { mkdirSync(backup); writeFileSync(join(backup, LABEL + ".plist"), before!); if (priorWrapper !== null) writeFileSync(join(backup, "tmux-flight.sh"), priorWrapper); }
    await stopRegistration(registration, launch, service, env, io, () => { stopped = true; });
    quiesced = true;
    // The shell owns stale-claim recovery. Status takes/releases the same claim
    // without sampling; the control layer never copies its recovery algorithm.
    await io.run([bash, script, "status", next.socket.slice(0,2), next.socket.slice(3)], { ...runtimeEnv, ...next.environment });
    const claim = join(next.directory, ".tick-lock"), deadline = io.now() + 30000;
    while (true) {
      try { mkdirSync(claim); break; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || io.now() >= deadline) throw new Error("tmux recorder exclusion is still held");
        await io.wait();
      }
    }
    try {
      writeFileSync(join(claim, "owner"), `${process.pid}\n`);
      mkdirSync(dirname(p.plist), { recursive: true }); mkdirSync(dirname(next.wrapper), { recursive: true });
      atomicWrite(p.plist, rendered, 0o600); swapped = true;
      atomicWrite(next.wrapper, wrapper, 0o700);
    } finally { rmSync(join(claim, "owner"), { force: true }); rmdirSync(claim); }
    const started = io.now();
    if ((await launch([next.enabled ? "enable" : "disable", service])).code) throw new Error("cannot apply tmux launchd enablement");
    if (next.enabled && (await launch(["bootstrap", domain, p.plist])).code) throw new Error("replacement tmux registration failed");
    const sampled = await io.run([bash, script, "sample", next.socket.slice(0,2), next.socket.slice(3)], { ...runtimeEnv, ...next.environment }, 30000);
    if (![0, 3, 4].includes(sampled.code)) throw new Error("first tmux sample failed");
    await io.verifySample(next.directory, started, next.socket);
    const manifest = readManifestRecord(p.manifest);
    manifest.repo ??= io.root;
    manifest.entries = manifest.entries.filter(e => e.path !== p.plist && e.path !== next.wrapper);
    manifest.entries.push({ kind: "file", path: p.plist, sha256: hash(rendered), launchd_label: LABEL, tmux: next },
      { kind: "file", path: next.wrapper, sha256: hash(wrapper) });
    mkdirSync(dirname(p.manifest), { recursive: true });
    writeManifestAtomically(p.manifest, JSON.stringify(manifest, null, 2) + "\n");
    return { ...tmuxSourceStatus(env), enabled: next.enabled, backup: backup ?? null, plist: p.plist };
  } catch (error) {
    if (!swapped && !stopped) throw error;
    const failures: string[] = [];
    if (stopped && !quiesced) failures.push("previous invocation exit is unconfirmed; old scheduler left stopped");
    if (swapped) {
      try {
        const active = await observeRegistration(launch, service, env, io);
        await stopRegistration(active, launch, service, env, io, () => {});
      } catch { failures.push("replacement exit is unconfirmed"); }
      if (regular(p.plist) !== rendered) failures.push("plist changed externally; preserved");
      else if (before === null) rmSync(p.plist); else atomicWrite(p.plist, before, (priorPlistMode ?? 0o600) & 0o777);
      if (regular(next.wrapper) === wrapper) { if (priorWrapper === null) rmSync(next.wrapper); else atomicWrite(next.wrapper, priorWrapper, (priorWrapperMode ?? 0o700) & 0o777); }
    }
    if ((await launch([wasDisabled ? "disable" : "enable", service])).code) failures.push("enablement restore failed");
    if (loaded && !failures.length && (await launch(["bootstrap", domain, p.plist])).code) failures.push("old registration reload failed");
    throw new Error(`${error instanceof Error ? error.message : error}; ${failures.length ? "rollback incomplete: " + failures.join("; ") : "previous registration restored"}; backup ${backup ?? "not needed"}`);
  } finally { closeSync(control); }
}

/** Only this explicit verb may adopt an existing legacy label or create a new one. */
async function control<T>(body: () => Promise<T>): Promise<T> {
  try { return await body(); }
  catch (error) {
    if (error instanceof LauncherError) throw error;
    refuse("debug_tmux_failed", error instanceof Error ? error.message : String(error), "tap debug status");
  }
}
export async function migrateTmux(env = process.env, io = tmuxControlIO()) { return control(() => apply(env, io, true)); }
/** An unmanaged label is reported, never silently adopted by on/off or install. */
export async function setTmuxEnabled(enabled: boolean, env = process.env, io = tmuxControlIO(), socket?: string) {
  return control(async () => {
    const previous = ownedEntry(env);
    if (!previous) return tmuxSourceStatus(env);
    return enabled ? apply(env, io, false, true, socket) : stopOwned(env, previous, io);
  });
}
