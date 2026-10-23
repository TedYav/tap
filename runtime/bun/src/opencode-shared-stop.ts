import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { localOpenCodeURL, sameOpenCodeService, type OpenCodeProcess, type OpenCodeService } from "./opencode-shared";
import type { Seat } from "./registry";
import { openCodeAPI, readOpenCodeAncestry, readOpenCodeService } from "./opencode-service";
import { atomicWrite } from "./fsatomic";
import { loadGlobalRegistry } from "./index-home";
import { observeCallerIdentity, TapError, type CallingPaneObservation } from "./context";
import { physicalSocketPath } from "./tmux";
export interface SharedStopIO {
  process(pid: number): { kind: "live"; row: OpenCodeProcess } | { kind: "gone" | "unobservable" };
  service(env: NodeJS.ProcessEnv): OpenCodeService | null;
  api(service: OpenCodeService, path: string, method?: string): any;
  now(): number;
  sleep(ms: number): void;
}
function sharedStopBinding(row: Seat): { session: string; stored: OpenCodeService } {
  const session = row.harness_session_id;
  const raw = row.opencode_service instanceof Map ? Object.fromEntries(row.opencode_service) : row.opencode_service;
  const stored = raw && typeof raw === "object" ? { ...raw as OpenCodeService,
    pid: Number((raw as OpenCodeService).pid), start: Number((raw as OpenCodeService).start) } : undefined;
  if (typeof session !== "string" || !/^ses_[A-Za-z0-9]+$/.test(session) || !stored || typeof stored.id !== "string" || !stored.id ||
    !Number.isSafeInteger(stored.pid) || stored.pid <= 1 || !Number.isSafeInteger(stored.start) || stored.start <= 0 ||
    typeof stored.file !== "string" || !isAbsolute(stored.file) || !stored.file.endsWith("/opencode/service.json") || !localOpenCodeURL(stored.url))
    throw new TapError(1, "opencode_shared_binding_invalid", "inspect the stored OpenCode service binding", "shared stop requires a recorded native session and service generation");
  return { session, stored };
}
/** Retain uncertain native work without granting permission to kill its pane. */
export function retainUnquiescedSharedSession(row: Seat, root: string, handle: string, reason: string) {
  const { session, stored } = sharedStopBinding(row), receipt = receiptPath(root, session);
  mkdirSync(dirname(receipt), { recursive: true });
  const { password: _password, ...service } = stored;
  atomicWrite(receipt, JSON.stringify({ session_id: session, handle, service, at: new Date().toISOString(),
    root, workdir: typeof row.launch_workdir === "string" ? row.launch_workdir : root, reason,
    remedy: sharedStopAction(handle) }) + "\n");
  return { session, service };
}
const sharedStopAction = (handle: string) => `wait for the session to become idle or restart the OpenCode service at a safe interruption point, then run tap down ${handle}; to stop only its pane now: tap down ${handle} --skip-quiesce`;
export function quiesceSharedSession(row: Seat, root: string, handle: string,
  options: { env?: NodeJS.ProcessEnv; skip?: boolean } = {}, io: SharedStopIO = nativeIO): { quiesced: boolean } {
  if (row.harness !== "opencode" || row.opencode_server_mode !== "shared") {
    if (options.skip) throw new TapError(1, "usage_error", "tap help down", "--skip-quiesce applies only to a shared OpenCode seat");
    return { quiesced: true };
  }
  const { session, stored } = sharedStopBinding(row);
  const receipt = receiptPath(root, session), env = { ...options.env ?? process.env, XDG_STATE_HOME: dirname(dirname(stored.file)) };
  const deadline = io.now() + 8000;
  const expired = () => { if (io.now() >= deadline) throw new Error("native session remained active after interruption"); };
  try {
    const process = io.process(stored.pid);
    if (process.kind === "gone" || (process.kind === "live" && process.row.start !== stored.start)) {
      clearReceipt(receipt); return { quiesced: true };
    }
    if (process.kind !== "live") throw new Error("old service process is unobservable");
    const observed = io.service(env);
    if (!observed || !sameOpenCodeService(stored, observed)) throw new Error("the old service generation cannot be contacted");
    const service = { ...observed };
    const api = (path: string, method = "GET") => { expired(); return io.api(service, path, method); };
    const info = api(`/api/session/${session}`)?.data;
    const directory = info?.location?.directory;
    if (info?.id !== session || info.parentID || typeof directory !== "string" || !isAbsolute(directory)) throw new Error("native root session could not be verified");
    const tree = (): Set<string> => {
      const found = new Set<string>([session]), queue = [session];
      for (let i = 0; i < queue.length; i++) {
        if (queue.length > 128) throw new Error("native session tree exceeds the stop bound");
        const parent = queue[i]!; let cursor = ""; const cursors = new Set<string>();
        do {
          const query = cursor ? new URLSearchParams({ cursor, limit: "100" }) : new URLSearchParams({ parentID: parent, directory, limit: "100" });
          const page = api(`/api/session?${query}`);
          if (!Array.isArray(page?.data) || !page.cursor || typeof page.cursor !== "object") throw new Error("native child census is unreadable");
          for (const child of page.data) {
            if (!/^ses_[A-Za-z0-9]+$/.test(child?.id ?? "") || child.parentID !== parent || child.location?.directory !== directory || found.has(child.id))
              throw new Error("native child census is inconsistent");
            found.add(child.id); queue.push(child.id);
          }
          cursor = page.cursor.next ?? "";
          if (typeof cursor !== "string" || cursor.length > 8192 || cursors.has(cursor) || cursors.size >= 16) throw new Error("native child pagination is inconsistent");
          if (cursor) cursors.add(cursor);
        } while (cursor);
      }
      return found;
    };
    for (;;) {
      const owned = tree();
      for (const id of owned) api(`/api/session/${id}/interrupt?resume=false`, "POST");
      const query = new URLSearchParams({ "location[directory]": directory });
      const shells = api(`/api/shell?${query}`);
      if (!Array.isArray(shells?.data) || shells.location?.directory !== directory) throw new Error("native shell census is unreadable");
      const running = shells.data.filter((shell: any) => owned.has(shell?.metadata?.sessionID));
      for (const shell of running) {
        if (typeof shell.id !== "string" || !shell.id || shell.id.length > 256) throw new Error("native shell has no usable id");
        api(`/api/shell/${encodeURIComponent(shell.id)}?${query}`, "DELETE");
      }
      const active = api("/api/session/active")?.data;
      if (!active || typeof active !== "object" || Array.isArray(active)) throw new Error("native active-session census is unreadable");
      const currentTree = tree();
      if (running.length === 0 && [...currentTree].every(id => owned.has(id) && !Object.hasOwn(active, id))) {
        const current = io.service(env), live = io.process(stored.pid);
        if (!current || !sameOpenCodeService(service, current) || live.kind !== "live" || live.row.start !== stored.start) throw new Error("service changed while confirming quiescence");
        clearReceipt(receipt); return { quiesced: true };
      }
      expired(); io.sleep(50);
    }
  } catch (error) {
    const detail = `could not quiesce shared OpenCode seat '${handle}': ${error instanceof Error ? error.message : String(error)}; interrupts and background-shell removal may already have been applied to ${session}`;
    const action = sharedStopAction(handle);
    if (!options.skip) throw new TapError(1, "opencode_shared_unquiesced", action, detail);
    retainUnquiescedSharedSession(row, root, handle, detail);
    return { quiesced: false };
  }
}
export function refuseSharedSelfStop(entries: Array<[string, Seat]>, verb: string, teamWide = false,
  env: NodeJS.ProcessEnv = process.env, observed?: CallingPaneObservation): void {
  const shared = entries.filter(([, row]) => row.harness === "opencode" && row.opencode_server_mode === "shared");
  if (!shared.length) return;
  const caller = observed ?? observeCallerIdentity(env);
  if (caller.state === "unobservable" && caller.shared)
    throw new TapError(1, "shared_caller_unobservable", `run ${verb} from another pane`, "the shared caller could not be verified before stopping a seat");
  if (caller.state !== "inside") return;
  const own = shared.find(([, row]) => row.pane_id === caller.paneId && row.session === caller.session && row.server_epoch === caller.serverEpoch &&
    (!caller.selectedSocket || physicalSocketPath({ ...env, TAP_TMUX_SOCKET_PATH: String(row.server_socket) }) === caller.selectedSocket));
  if (own) throw new TapError(1, "opencode_shared_self_stop", teamWide ? `run ${verb} --except ${own[0]}, or run it from another pane` : `run ${verb} ${own[0]} from another pane`,
    "a shared OpenCode seat cannot stop itself while its shell tool is running; nothing was changed");
}
export function assertSharedStopCleared(root: string, row: Seat): void {
  const hold = sharedStopHold(root, row.harness_session_id);
  if (hold) throw new TapError(1, "opencode_shared_unquiesced", "run tap down <seat> again after the session is idle or its service is restarted", hold);
}
const receiptPath = (root: string, session: string) => join(root, ".tap/opencode-unquiesced", `${session}.json`);
function clearReceipt(path: string): void { try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
export function sharedStopHold(root: string, sessionId: unknown): string {
  return typeof sessionId === "string" && /^ses_[A-Za-z0-9]+$/.test(sessionId) && existsSync(receiptPath(root, sessionId))
    ? `shared OpenCode session ${sessionId} is recorded as unquiesced; run tap down <seat> again after it is idle or its service has been restarted` : "";
}
export function sharedWorktreeHold(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };
  const roots = new Set([root]), index = loadGlobalRegistry(env.TAP_INDEX_HOME);
  if (index.marker === "live" && index.doc?.teams && typeof index.doc.teams === "object")
    for (const entry of Object.values(index.doc.teams as Record<string, any>)) if (typeof entry?.root === "string") roots.add(entry.root);
  for (const owner of roots) {
    const dir = join(owner, ".tap/opencode-unquiesced"); let files: string[];
    try { files = readdirSync(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; return `unreadable shared OpenCode stop receipts at ${dir}`; }
    for (const file of files) {
      try {
        const receipt = JSON.parse(readFileSync(join(dir, file), "utf8"));
        if (typeof receipt.workdir !== "string" || typeof receipt.session_id !== "string") throw new Error();
        if (real(owner) === real(root) || real(receipt.workdir) === real(root)) return `shared OpenCode session ${receipt.session_id} has not been quiesced; recheck it with tap down ${receipt.handle}`;
      } catch { return `unreadable shared OpenCode stop receipt ${join(dir, file)}`; }
    }
  }
  return "";
}
const nativeIO: SharedStopIO = {
  process: pid => {
    const row = readOpenCodeAncestry(process.env, pid)?.get(pid);
    if (row) return { kind: "live", row };
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return { kind: "gone" }; }
    return { kind: "unobservable" };
  }, service: env => readOpenCodeService(env), api: (service, path, method) => openCodeAPI(service, path, method), now: Date.now,
  sleep: ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
};
