import { basename } from "node:path";
import { realpathSync } from "node:fs";
import { sameOpenCodeService, type OpenCodeProcess, type OpenCodeService } from "../opencode-shared";
import { openCodeAPI, readOpenCodeProcesses, readOpenCodeService } from "../opencode-service";
import { INHERITED_IDENTITY_ENV } from "../session-store";
import { physicalSocketPath } from "../tmux";
import { childBusEnv } from "../panelock";
import { observeIdentityPane } from "../context";
import { seatHarnessEnv } from "./resume-identity";
import { launchWorkdir } from "./workdir";
import { LauncherError } from "./types";
import type { PaneFacts } from "./readiness";
import type { SessionRecord } from "./types";
export interface SharedActivationIO {
  processes(): Map<number, OpenCodeProcess> | null;
  service(env: NodeJS.ProcessEnv): OpenCodeService | null;
  api(service: OpenCodeService, path: string, method?: string, body?: unknown): any;
}
/** Called by the two existing activation writers while they hold row custody. */
export function activateSharedRow(row: Record<string, unknown>, record: SessionRecord, facts: PaneFacts,
  env: NodeJS.ProcessEnv, binding: { root: string; bus: string; socket: string }, io?: SharedActivationIO): void {
  prepareSharedActivation(record, facts, env, binding, io);
  const pane = observeIdentityPane(facts.pane, env, binding.socket);
  if (pane.status !== "ok" || pane.paneId !== facts.pane_id || pane.session !== record.name || pane.serverEpoch !== facts.server_epoch)
    throw new LauncherError("pane identity changed during shared activation", "opencode_shared_activation_failed", "inspect the pane and relaunch from another pane");
  const { password: _password, ...service } = record.opencode_service!;
  Object.assign(row, { status: "active", status_reason: "", delivery: "pane", harness: "opencode",
    harness_session_id: record.harness_session_id, opencode_server_mode: "shared", opencode_service: service,
    session: record.name, pane: facts.pane, pane_id: facts.pane_id, server_epoch: facts.server_epoch,
    server_socket: physicalSocketPath({ ...env, TAP_TMUX_SOCKET_PATH: binding.socket }), pane_current_command: facts.command });
}
export function prepareSharedActivation(record: SessionRecord, facts: PaneFacts, env: NodeJS.ProcessEnv,
  binding: { root: string; bus: string; socket: string }, io: SharedActivationIO = {
    processes: () => readOpenCodeProcesses(env), service: readOpenCodeService, api: openCodeAPI,
  }): void {
  const refuse = (detail: string): never => { throw new LauncherError(detail, "opencode_shared_activation_failed", "inspect the OpenCode TUI and service, then relaunch the seat", detail); };
  const seatEnv = seatHarnessEnv(record, env);
  if (!seatEnv || !record.harness_session_id || !record.opencode_service || facts.dead) refuse("shared seat has no verifiable prepared session");
  const current = io.service(seatEnv!);
  if (!current || !sameOpenCodeService(current, record.opencode_service!)) refuse("shared service changed before activation");
  const service = { ...current! }, snapshot = io.processes();
  if (!snapshot) refuse("TUI process ancestry is unavailable");
  const rows = new Map([...snapshot!].map(([pid, row]) => [pid, { ...row }]));
  const candidates = [...rows.values()].filter(row => {
    if (!/^(?:opencode|opencode-v2)$/.test(basename(row.command))) return false;
    const args = row.args.split(/\s+/);
    if (args.includes("serve") || args.some(arg => ["--standalone", "--server"].includes(arg.split("=", 1)[0]!))) return false;
    const idAt = args.findIndex(arg => arg === "--session" || arg === "-s");
    const session = idAt < 0 ? args.find(arg => arg.startsWith("--session="))?.slice(10) : args[idAt + 1];
    if (session !== record.harness_session_id) return false;
    let pid = row.pid;
    for (let depth = 0; depth < 64; depth++) {
      if (pid === facts.pane_pid) return true;
      const ancestor = rows.get(pid);
      if (!ancestor || ancestor.ppid <= 1 || ancestor.ppid === pid) return false;
      pid = ancestor.ppid;
    }
    return false;
  });
  if (candidates.length !== 1) refuse("the recorded pane does not contain exactly one TUI for the prepared native session");
  const session = io.api(service, `/api/session/${record.harness_session_id}`)?.data;
  if (session?.id !== record.harness_session_id || session.parentID || session.location?.directory !== realpathSync(launchWorkdir(record)))
    refuse("prepared native session identity or directory changed");
  const variables = childBusEnv(binding.bus, seatEnv!);
  for (const key of [...INHERITED_IDENTITY_ENV, "CLAUDE_JOB_DIR", "TAP_STATELESS", "TAP_TMUX_SOCKET", "TAP_REGISTRY"]) delete variables[key];
  const socket = physicalSocketPath({ ...env, TAP_TMUX_SOCKET_PATH: binding.socket });
  Object.assign(variables, { TMUX: `${socket},${facts.server_epoch.split(":")[1]},0`, TMUX_PANE: facts.pane_id,
    TAP_TMUX_SOCKET_PATH: socket, TAP_LAUNCH_ROOT: binding.root });
  io.api(service, `/api/session/${record.harness_session_id}/environment`, "PUT", {
    variables: Object.fromEntries(Object.entries(variables).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
  });
  const after = io.processes(), finalService = io.service(seatEnv!);
  if (!after || !finalService || !sameOpenCodeService(service, finalService)) refuse("shared service changed during activation");
  let pid = candidates[0]!.pid;
  for (let depth = 0; depth < 64; depth++) {
    const before = rows.get(pid), fresh = after!.get(pid);
    if (!before || !fresh || before.start !== fresh.start || before.ppid !== fresh.ppid) refuse("TUI process changed during activation");
    if (pid === facts.pane_pid) return;
    pid = before!.ppid;
  }
  refuse("TUI ancestry exceeded its observation bound");
}
