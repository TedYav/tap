/** Read native service evidence. Discovery here never starts or changes a service. */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { bunBinary } from "./courier-argv";
import { runtimeModule } from "./scripts-dir";
import { libprocIdentity } from "./proc-row";
import { OpenCodeWitnessCache, localOpenCodeURL, type OpenCodeProcess, type OpenCodeService } from "./opencode-shared";
import { ownBunFlags } from "./own-bun";

export function parseOpenCodeProcesses(text: string): Map<number, OpenCodeProcess> | null {
  const rows = new Map<number, OpenCodeProcess>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) return null;
    const pid = Number(match[1]), start = Date.parse(`${match[3]} UTC`);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(start) || rows.has(pid)) return null;
    rows.set(pid, { pid, ppid: Number(match[2]), start, command: match[4]!, args: match[5]! });
  }
  return rows.size ? rows : null;
}

export function readOpenCodeProcesses(env: NodeJS.ProcessEnv = process.env): Map<number, OpenCodeProcess> | null {
  if (process.platform === "linux") {
    try {
      const rows = new Map<number, OpenCodeProcess>();
      for (const name of readdirSync("/proc")) if (/^\d+$/.test(name)) {
        const row = linuxProcess(Number(name));
        if (row) rows.set(row.pid, row);
      }
      return rows;
    } catch { return null; }
  }
  // macOS truncates comm to 15 characters (often '/opt/homebrew/Ce').
  // ucomm supplies the executable name; args remains the separate full argv.
  const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,lstart=,ucomm=,args=", "-ww"], {
    env: { ...env, TZ: "UTC", LC_ALL: "C" }, encoding: "utf8", timeout: 2000, maxBuffer: 16 * 1024 * 1024,
  });
  return result.status === 0 ? parseOpenCodeProcesses(result.stdout) : null;
}

/** Kernel ancestry keeps ordinary macOS callers off the full process scan and
 * works where the existing Codex sandbox cannot spawn ps. Only an OpenCode
 * ancestor needs argv to distinguish its TUI from its server. */
export function parseLinuxProcess(stat: string, command: string, cmdline: string, bootSeconds: number, ticks: number): OpenCodeProcess | null {
  const close = stat.lastIndexOf(")"), pid = Number(stat.slice(0, stat.indexOf(" ")));
  const fields = stat.slice(close + 1).trim().split(/\s+/), ppid = Number(fields[1]), started = Number(fields[19]);
  if (close < 0 || !Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0 ||
    !Number.isSafeInteger(started) || started < 0 || !Number.isFinite(bootSeconds) || ticks <= 0 || !Number.isFinite(ticks)) return null;
  return { pid, ppid, command: command.trim(), args: cmdline.replaceAll("\0", " ").trim(),
    start: Math.floor(bootSeconds + started / ticks) * 1000 };
}

function linuxProcess(pid: number): OpenCodeProcess | null {
  try {
    const boot = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]);
    // Linux exposes USER_HZ as AT_CLKTCK (17), including on musl/BusyBox.
    const aux = readFileSync("/proc/self/auxv"), word = ["x64", "arm64"].includes(process.arch) ? 8 : 4;
    let ticks = 0;
    for (let i = 0; i + word * 2 <= aux.length; i += word * 2) {
      const key = word === 8 ? Number(aux.readBigUInt64LE(i)) : aux.readUInt32LE(i);
      if (key === 17) { ticks = word === 8 ? Number(aux.readBigUInt64LE(i + word)) : aux.readUInt32LE(i + word); break; }
    }
    return parseLinuxProcess(readFileSync(`/proc/${pid}/stat`, "utf8"), readFileSync(`/proc/${pid}/comm`, "utf8"),
      readFileSync(`/proc/${pid}/cmdline`, "utf8"), boot, ticks);
  } catch { return null; }
}

function psProcess(pid: number, env: NodeJS.ProcessEnv): OpenCodeProcess | null {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-ww", "-o", "pid=,ppid=,lstart=,ucomm=,args="], {
    encoding: "utf8", env: { ...env, TZ: "UTC", LC_ALL: "C" }, timeout: 2000,
  });
  return result.status === 0 ? parseOpenCodeProcesses(result.stdout)?.get(pid) ?? null : null;
}

export function readOpenCodeAncestry(env: NodeJS.ProcessEnv = process.env, caller = process.pid,
  kernel: typeof libprocIdentity = libprocIdentity): Map<number, OpenCodeProcess> | null {
  const rows = new Map<number, OpenCodeProcess>();
  let pid = caller;
  for (let depth = 0; depth < 64; depth++) {
    const row = process.platform === "linux" ? linuxProcess(pid) : kernel(pid) ?? psProcess(pid, env);
    if (!row || rows.has(pid)) return null;
    let args = "args" in row ? row.args as string : row.command;
    if (!("args" in row) && /^(?:opencode|opencode-v2)$/.test(row.command)) {
      const result = spawnSync("/bin/ps", ["-p", String(pid), "-ww", "-o", "args="], { encoding: "utf8", env, timeout: 2000 });
      if (result.status !== 0 || !result.stdout.trim()) return null;
      args = result.stdout.trim();
    }
    rows.set(pid, { ...row, args });
    if (row.ppid <= 1) return rows;
    pid = row.ppid;
  }
  return null;
}

export function openCodeServicePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), "opencode", "service.json");
}

export function readOpenCodeService(env: NodeJS.ProcessEnv = process.env,
  rows?: Map<number, OpenCodeProcess> | null): OpenCodeService | null {
  const file = openCodeServicePath(env);
  try {
    // Do not block on a FIFO or trust a registration writable by another user.
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 64 * 1024 || (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())) return null;
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!Number.isSafeInteger(data.pid) || data.pid <= 0) return null;
    const processRow = (rows === undefined ? readOpenCodeAncestry(env, data.pid) : rows)?.get(data.pid);
    if (!processRow || !Number.isSafeInteger(data.pid) || typeof data.id !== "string" || !data.id ||
      typeof data.version !== "string" || !/^2\./.test(data.version) || typeof data.url !== "string" || !localOpenCodeURL(data.url) ||
      !/^(?:opencode|opencode-v2)(?:\.exe)?$/.test(basename(processRow.command))) return null;
    const argv = processRow.args.trim().split(/\s+/);
    if (!argv.includes("serve") || !argv.includes("--service") || argv.includes("--stdio")) return null;
    if (data.password !== undefined && typeof data.password !== "string") return null;
    return { id: data.id, pid: data.pid, start: processRow.start, version: data.version, url: data.url, file,
      ...(data.password ? { password: data.password } : {}) };
  } catch { return null; }
}

/** The synchronous identity seam uses a bounded Bun child for native fetch.
 * Credentials travel on stdin, never in argv, logs or an opencode auto-start command. */
export function openCodeAPI(service: OpenCodeService, path: string, method = "GET", body?: unknown): any {
  if (!localOpenCodeURL(service.url) || !path.startsWith("/api/") || path.startsWith("//")) throw new Error("invalid OpenCode endpoint");
  const result = spawnSync(bunBinary(), [...ownBunFlags(bunBinary()), runtimeModule("src/opencode-service.ts"), "--request"], {
    input: JSON.stringify({ url: service.url, password: service.password, path, method, body }),
    encoding: "utf8", timeout: 3000, maxBuffer: 4 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error("OpenCode service request failed");
  return JSON.parse(result.stdout);
}

const witnessCache = new OpenCodeWitnessCache();
export function nativeOpenCodeCaller(env: NodeJS.ProcessEnv = process.env, pid = process.pid) {
  let rows: Map<number, OpenCodeProcess> | null = null;
  return witnessCache.read(env, pid, {
    processes: () => rows = readOpenCodeAncestry(env, pid),
    service: () => readOpenCodeService(env, rows),
    api: openCodeAPI,
  });
}

if (import.meta.main && process.argv[2] === "--request") {
  try {
    const request = JSON.parse(await Bun.stdin.text());
    if (!localOpenCodeURL(request.url) || typeof request.path !== "string" || !request.path.startsWith("/api/")) throw new Error();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (request.password) headers.authorization = "Basic " + Buffer.from(`opencode:${request.password}`).toString("base64");
    const response = await fetch(new URL(request.path, request.url), { method: request.method, headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      redirect: "error", signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error();
    const text = await response.text();
    if (text.length > 4 * 1024 * 1024) throw new Error();
    process.stdout.write(text || "null");
  } catch { process.exitCode = 1; }
}
