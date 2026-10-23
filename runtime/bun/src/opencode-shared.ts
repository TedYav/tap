/** Native process evidence for OpenCode's experimental shared service. */
import { basename } from "node:path";
export interface OpenCodeProcess { pid: number; ppid: number; start: number; command: string; args: string }
export interface OpenCodeService { id: string; pid: number; start: number; url: string; version: string; file: string; password?: string }
export interface SharedObservationIO {
  processes(): Map<number, OpenCodeProcess> | null;
  service(): OpenCodeService | null;
  api(service: OpenCodeService, path: string): any;
}
export type OpenCodeCaller = { kind: "none" } | { kind: "refused"; reason: string } | {
  kind: "verified"; sessionId: string; rootSessionId: string; shellPid: number; shellStart: number;
  directory: string; service: OpenCodeService;
};

/** One CLI invocation may ask identity several times. Cache only the native
 * shell/session relation, briefly; callers still reread registry and pane. */
export class OpenCodeWitnessCache {
  private cached?: { result: Extract<OpenCodeCaller, { kind: "verified" }>; rows: Map<number, OpenCodeProcess>; pid: number; expires: number };
  read(env: NodeJS.ProcessEnv, pid: number, io: SharedObservationIO, now = Date.now()): OpenCodeCaller {
    let rows = io.processes();
    const cached = this.cached;
    if (cached && cached.pid === pid && now < cached.expires && env.OPENCODE_SESSION_ID === cached.result.sessionId && rows) {
      const service = io.service();
      if (service && sameOpenCodeService(service, cached.result.service)) {
        let current = pid;
        for (let depth = 0; depth < 64; depth++) {
          const before = cached.rows.get(current), after = rows.get(current);
          if (!before || !after || before.start !== after.start || before.ppid !== after.ppid) break;
          if (current === service.pid) return structuredClone(cached.result);
          current = after.ppid;
        }
      }
    }
    this.cached = undefined;
    let first = true;
    const result = attestOpenCodeCaller(env, pid, { ...io, processes: () => {
      if (first) { first = false; return rows; }
      return rows = io.processes();
    } });
    if (result.kind === "verified" && rows) this.cached = { result: structuredClone(result), pid, expires: now + 250,
      rows: new Map([...rows].map(([key, row]) => [key, { ...row }])) };
    return result;
  }
}
export function attestOpenCodeCaller(env: NodeJS.ProcessEnv, pid: number, io: SharedObservationIO): OpenCodeCaller {
  const refuse = (reason: string): OpenCodeCaller => ({ kind: "refused", reason });
  const observed = io.processes();
  if (!observed) return refuse("process_unobservable");
  // Freeze the first observation: later probes must not mutate our witness.
  const before = new Map([...observed].map(([key, row]) => [key, { ...row }]));
  const boundary = openCodeServerAncestor(before, pid);
  if (boundary.kind === "none") return { kind: "none" };
  if (boundary.kind === "unobservable") return refuse("process_unobservable");
  if (boundary.private) return { kind: "none" };
  if (!boundary.service.args.split(/\s+/).includes("--service")) return refuse("service_unverified");
  const candidate = io.service();
  if (!candidate || candidate.pid !== boundary.service.pid || candidate.start !== boundary.service.start ||
    !candidate.id || !/^2\./.test(candidate.version) || !localOpenCodeURL(candidate.url)) return refuse("service_unverified");
  const service = { ...candidate };
  const sessionId = env.OPENCODE_SESSION_ID ?? "";
  if (!/^ses_[A-Za-z0-9]+$/.test(sessionId)) return refuse("session_missing");
  const child = before.get(boundary.child);
  if (!child) return refuse("not_shell");
  try {
    const session = io.api(service, `/api/session/${sessionId}`)?.data;
    const directory = session?.location?.directory;
    if (session?.id !== sessionId || typeof directory !== "string" || !directory.startsWith("/")) return refuse("session_unverified");
    const response = io.api(service, "/api/shell?" + new URLSearchParams({ "location[directory]": directory }));
    if (!Array.isArray(response?.data) || response.location?.directory !== directory) return refuse("shell_unverified");
    const matching = response.data.filter((row: any) => row?.pid === child.pid);
    if (matching.length !== 1 || matching[0].status !== "running") return refuse("not_shell");
    const shell = matching[0], started = shell.time?.started;
    if (!Number.isSafeInteger(started) || child.start < started - 1000 || child.start > started + 2000) return refuse("shell_generation");
    if (shell.metadata?.sessionID !== sessionId) return refuse("session_mismatch");
    let root = session;
    const visited = new Set<string>([sessionId]);
    for (let depth = 0; root.parentID; depth++) {
      if (depth >= 32 || !/^ses_[A-Za-z0-9]+$/.test(root.parentID) || visited.has(root.parentID)) return refuse("session_ancestry");
      const parent = root.parentID;
      visited.add(parent);
      root = io.api(service, `/api/session/${parent}`)?.data;
      if (root?.id !== parent || root.location?.directory !== directory) return refuse("session_ancestry");
    }
    const after = io.processes(), currentService = io.service();
    if (!after || !currentService || !sameOpenCodeService(service, currentService)) return refuse("service_generation");
    let current = pid;
    for (let hops = 0; hops < 64; hops++) {
      const old = before.get(current), fresh = after.get(current);
      if (!old || !fresh || old.ppid !== fresh.ppid || old.start !== fresh.start) return refuse("process_generation");
      if (current === service.pid) {
        const { password: _password, ...fingerprint } = service;
        return { kind: "verified", sessionId, rootSessionId: root.id, directory,
          shellPid: child.pid, shellStart: child.start, service: fingerprint };
      }
      current = old.ppid;
    }
    return refuse("process_generation");
  } catch { return refuse("api_unavailable"); }
}

export function localOpenCodeURL(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
  } catch { return false; }
}

export function sameOpenCodeService(a: OpenCodeService, b: OpenCodeService): boolean {
  return a.id === b.id && a.pid === b.pid && a.start === b.start && a.url === b.url && a.file === b.file && a.version === b.version;
}

/** Every server ends the physical tty walk except a private child of its TUI. */
export function openCodeServerAncestor(rows: Map<number, OpenCodeProcess>, caller: number):
  { kind: "server"; service: OpenCodeProcess; child: number; private: boolean } | { kind: "none" } | { kind: "unobservable" } {
  let pid = caller, child = caller;
  const executable = (row: OpenCodeProcess | undefined) => !!row && /^(?:opencode|opencode-v2)(?:\.exe)?$/.test(basename(row.command));
  for (let hops = 0; hops < 64; hops++) {
    const row = rows.get(pid);
    if (!row) return { kind: "unobservable" };
    const argv = row.args.trim().split(/\s+/);
    if (executable(row) && argv.includes("serve")) {
      const parent = rows.get(row.ppid), parentArgv = parent?.args.trim().split(/\s+/) ?? [];
      const privateServer = argv.includes("--stdio") && !argv.includes("--service") && executable(parent) &&
        !parentArgv.includes("serve") && !parentArgv.some(arg => arg === "--server" || arg.startsWith("--server="));
      return { kind: "server", service: row, child, private: privateServer };
    }
    if (row.ppid <= 1) return { kind: "none" };
    if (row.ppid === pid) return { kind: "unobservable" };
    child = pid; pid = row.ppid;
  }
  return { kind: "unobservable" };
}
