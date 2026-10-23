/** Explicit plugin context is read-only; it never supplies implicit caller identity. */
import { openCodeAPI, readOpenCodeAncestry, readOpenCodeService } from "./opencode-service";
import { openCodeServerAncestor, sameOpenCodeService, type SharedObservationIO } from "./opencode-shared";
import { verifySharedRootSeat, type SharedPane, type VerifiedSharedSeat } from "./opencode-shared-seat";
import { observeIdentityPane } from "./context";

export function resolveSharedContext(sessionId: string, directory: string, env: NodeJS.ProcessEnv = process.env,
  io?: SharedObservationIO, observe?: (target: string, env: NodeJS.ProcessEnv, socket: string) => SharedPane | null): VerifiedSharedSeat {
  const refuse = (reason: string): VerifiedSharedSeat => ({ kind: "refused", reason });
  if (!/^ses_[A-Za-z0-9]+$/.test(sessionId)) return refuse("session_missing");
  let rows: ReturnType<typeof readOpenCodeAncestry>;
  const native: SharedObservationIO = io ?? { processes: () => rows = readOpenCodeAncestry(env),
    service: () => readOpenCodeService(env, rows), api: openCodeAPI };
  const observedProcesses = native.processes();
  if (!observedProcesses) return refuse("process_unobservable");
  const before = new Map([...observedProcesses].map(([pid, row]) => [pid, { ...row }]));
  const boundary = openCodeServerAncestor(before, process.pid);
  if (boundary.kind !== "server" || boundary.private) return refuse("not_shared_service");
  const observed = native.service();
  if (!observed || observed.pid !== boundary.service.pid || observed.start !== boundary.service.start) return refuse("service_unverified");
  const service = { ...observed };
  try {
    const session = native.api(service, `/api/session/${sessionId}`)?.data;
    if (session?.id !== sessionId || session.parentID || session.location?.directory !== directory) return refuse("session_unverified");
    const binding = verifySharedRootSeat({ rootSessionId: sessionId, service }, env, observe ?? ((target, pinned, socket) => {
      const pane = observeIdentityPane(target, pinned, socket, true);
      return pane.status === "ok" ? pane : null;
    }));
    if (binding.kind === "refused") return binding;
    const after = native.processes(), current = native.service();
    if (!after || !current || !sameOpenCodeService(service, current)) return refuse("service_generation");
    let pid = process.pid;
    for (let depth = 0; depth < 64; depth++) {
      const old = before.get(pid), fresh = after.get(pid);
      if (!old || !fresh || old.start !== fresh.start || old.ppid !== fresh.ppid) return refuse("process_generation");
      if (pid === service.pid) return binding;
      pid = old.ppid;
    }
    return refuse("process_generation");
  } catch { return refuse("api_unavailable"); }
}
