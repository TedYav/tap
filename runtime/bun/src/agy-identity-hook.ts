// agy's invocation hooks cover new and resumed conversations. SessionStart only
// runs for a new conversation. Native env/payload agreement is the identity
// source; workspace paths select enrollment, never a conversation candidate.
import { spawnSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { observeCallingPane, type CallingPaneObservation } from "./context";
import { childBusEnv } from "./panelock";
import { automaticBindAllowed, registryDoc, resolveLaunchEvidence, resolveSessionAuthority, walkUpSessionRoot } from "./session-start";
import { teamRegistryRefusal } from "./register-authority";
import { agyRootStatus } from "./agy-conversation";

const REPO = resolve(import.meta.dir, "../../..");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export interface AgyBindRequest {
  root: string;
  bus: string;
  sessionId: string;
  transcript: string;
  env: NodeJS.ProcessEnv;
}

function bind(request: AgyBindRequest): void {
  const result = spawnSync(join(REPO, "bin/tap"), ["in", "--harness-session-id", request.sessionId], {
    cwd: request.root, stdio: "ignore", timeout: 2500, killSignal: "SIGKILL",
    env: { ...childBusEnv(request.bus, request.env), TAP_REGISTER_LOCK_TIMEOUT: "0.2",
      TAP_SKIP_VERSION_BRIEFING: "1", TAP_HARNESS_SESSION_ID: request.sessionId,
      TAP_TRANSCRIPT_PATH: request.transcript, TAP_SESSION_SOURCE: "pre_invocation" },
  });
  if (result.status !== 0) {
    const reason = result.error ? "registration did not complete" : `registration exited ${result.status ?? result.signal}`;
    process.stderr.write(`tap agy identity: ${reason}; retrying on a later invocation hook\n`);
  }
}

export function captureAgyIdentity(input: string, env: NodeJS.ProcessEnv = process.env,
  effects: { observe?: () => CallingPaneObservation; bind?: (request: AgyBindRequest) => void } = {}): void {
  if (env.TAP_STATELESS === "1") return;
  const data: unknown = JSON.parse(input);
  if (!object(data)) return;
  const id = data.conversationId;
  if (typeof id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
    || env.ANTIGRAVITY_CONVERSATION_ID !== id) return;

  const seen = (effects.observe ?? (() => observeCallingPane(env, true, true)))();
  if (seen.state !== "inside") return;
  const launch = resolveLaunchEvidence(env, () => seen);
  const workspaces = Array.isArray(data.workspacePaths)
    ? data.workspacePaths.filter((path): path is string => typeof path === "string" && isAbsolute(path)) : [];
  const root = launch?.root ?? workspaces.map(path => walkUpSessionRoot(path, env.TAP_INDEX_HOME)).find(Boolean);
  // The hook cwd is the configuration directory. It never grants enrollment.
  if (!root) return;
  const authority = launch?.authority ?? resolveSessionAuthority(root, env.TAP_INDEX_HOME);
  if (!authority) return;
  const doc = registryDoc(authority.registry);
  if (!doc || teamRegistryRefusal(authority.registry, doc) || !object(doc.seats)) return;
  const rows = Object.values(doc.seats).filter(row => object(row)
    && row.status === "active" && row.pane_id === seen.paneId && row.server_epoch === seen.serverEpoch);
  let acceptedIdentity = false;
  if (rows.length === 1) {
    const row = rows[0]! as Record<string, unknown>;
    const result = row.identity_capture_result;
    // Even an equal id must answer a pending exact-resume expectation. Once
    // consumed, a later in-app /resume can use registration's existing rebind.
    acceptedIdentity = row.harness === "agy" && row.session === seen.session && row.harness_session_id === id
      && object(result) && result.decision === "accepted" && result.observed_harness_session_id === id;
    if (acceptedIdentity && !row.identity_capture && !row.launch_id && !row.expected_clear_nonce && !row.status_reason) return;
  }
  // Subagents fire the same native hook in the parent's pane. Only the exact
  // volunteered id's root record permits a bind; absent metadata waits for a later hook.
  if (!acceptedIdentity && agyRootStatus(id, env).kind !== "root") return;
  // A separately spawned headless process can have a root conversation too.
  // Accepted identities above remain a cheap no-op on subsequent invocations.
  if (!automaticBindAllowed(seen.panePid ?? "", env, { source: "agy_invocation", harness_session_id: id, pane_id: seen.paneId })) return;
  (effects.bind ?? bind)({ root, bus: authority.bus, sessionId: id,
    transcript: typeof data.transcriptPath === "string" ? data.transcriptPath : "", env });
}

if (import.meta.main) {
  try {
    const input = await Promise.race([Bun.stdin.text(), Bun.sleep(100).then(() => "")]);
    if (input.length <= 65536) captureAgyIdentity(input);
  } catch { /* Identity capture must not fail the model invocation. Retry on its next hook. */ }
  process.stdout.write("{}\n");
  process.exit(0);
}
