// Claude Code's PermissionRequest hook, observe only. Claude runs it when it is
// about to ask a human to approve a tool call or answer a question. For a
// registered TAP seat this records what the seat is waiting on, so the roster
// can say so without reading the screen. It never decides: it prints nothing,
// and the terminal prompt behaves exactly as it does without TAP.
//
// The hook is installed user-level, so it runs in every Claude session on the
// machine. A session that is not a registered seat's bound session writes nothing.
import { boundGitRootProbes } from "./git-root";
import { observeCallingPane, type CallingPaneObservation } from "./context";
import { teamRegistryRefusal } from "./register-authority";
import { claudeRoot, enrolledSessionRoots, registryDoc, resolveLaunchEvidence, resolveSessionAuthority, walkUpSessionRoot } from "./session-start";
import {
  claudeSessionsDir, findClaudeSessionFile, permissionSummary, permissionToolName, writePermissionRequest,
  type PermissionRequestRecord,
} from "./permission-request";

const INPUT_MAX_BYTES = 4 * 1024 * 1024;
const GIT_PROBE_TIMEOUT_MS = 3000;
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export interface PermissionHookEffects {
  observe?: () => CallingPaneObservation;
  sessionFile?: (sessionId: string) => string;
  write?: (bus: string, handle: string, record: PermissionRequestRecord) => boolean;
  now?: () => number;
}

/** Returns the handle recorded for, or "" when this session is not a seat's bound session. */
export function recordPermissionRequest(input: string, env: NodeJS.ProcessEnv = process.env, effects: PermissionHookEffects = {}): string {
  if (env.TAP_STATELESS === "1") return "";
  const data: unknown = JSON.parse(input);
  if (!object(data) || data.hook_event_name !== "PermissionRequest") return "";
  const sessionId = typeof data.session_id === "string" ? data.session_id : "";
  const tool = permissionToolName(data.tool_name);
  if (!UUID_RE.test(sessionId) || !tool) return "";

  const seen = (effects.observe ?? (() => observeCallingPane(env, true, true)))();
  if (seen.state !== "inside") return "";
  // This hook fires long after launch, so the working directory need not name
  // the seat's team: a crew or worktree seat runs outside the team root. The
  // likely roots come first, then every enrolled team. A root is only a place
  // to look; the row below is the proof.
  const launch = resolveLaunchEvidence(env, () => seen);
  const roots = [launch?.root ?? "", claudeRoot(env), walkUpSessionRoot(env.CLAUDE_PROJECT_DIR || process.cwd(), env.TAP_INDEX_HOME),
    ...enrolledSessionRoots(env.TAP_INDEX_HOME)].filter((root, index, all) => root !== "" && all.indexOf(root) === index);
  const matches: Array<{ bus: string; handle: string }> = [];
  const read = new Set<string>();
  for (const root of roots) {
    const authority = launch && root === launch.root ? launch.authority : resolveSessionAuthority(root, env.TAP_INDEX_HOME);
    if (!authority || read.has(authority.registry)) continue;
    read.add(authority.registry);
    const doc = registryDoc(authority.registry);
    if (!doc || teamRegistryRefusal(authority.registry, doc) || !object(doc.seats)) continue;
    // The pane alone is not identity: a headless child started from a seat
    // inherits its pane. Only the seat's own bound session records.
    const seats = Object.entries(doc.seats).filter(([, row]) => object(row)
      && (row.status ?? "active") === "active" && typeof row.harness === "string" && /^claude(?:-|$)/.test(row.harness)
      && row.pane_id === seen.paneId && row.server_epoch === seen.serverEpoch
      && row.harness_session_id === sessionId);
    for (const [name] of seats) matches.push({ bus: authority.bus, handle: name });
  }
  // One session is one seat. Rows that both claim it, in one registry or in two, name no one:
  // every registry is read before any is believed, so the order of the roots decides nothing.
  if (matches.length !== 1) return "";
  const { bus, handle } = matches[0]!;

  // Without a session file that reports a status no reader could vouch for the record.
  const sessionFile = (effects.sessionFile ?? (id => findClaudeSessionFile(id, claudeSessionsDir(env))))(sessionId);
  if (!sessionFile) return "";
  const record: PermissionRequestRecord = {
    v: 1, harness: "claude", at: (effects.now ?? Date.now)(), session: sessionId,
    pane_id: seen.paneId, server_epoch: seen.serverEpoch, tool,
    summary: permissionSummary(tool, data.tool_input),
    permission_mode: typeof data.permission_mode === "string" ? data.permission_mode.slice(0, 40) : "",
    session_file: sessionFile,
  };
  return (effects.write ?? writePermissionRequest)(bus, handle, record) ? handle : "";
}

/** The whole payload, bounded in time and size. A tool input can carry a file body. */
async function readInput(timeoutMs = 2000): Promise<string> {
  if (process.stdin.isTTY) return "";
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return "";
      const chunk = await Promise.race([reader.read(), Bun.sleep(remaining).then(() => null)]);
      if (!chunk) return "";
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > INPUT_MAX_BYTES) return "";
      chunks.push(chunk.value);
    }
  } catch { return ""; }
  return Buffer.concat(chunks).toString("utf8");
}

if (import.meta.main) {
  try {
    boundGitRootProbes(GIT_PROBE_TIMEOUT_MS);
    const input = await readInput();
    if (input) recordPermissionRequest(input);
  } catch { /* Observing must never fail or delay the permission prompt. */ }
  // No stdout, ever: any JSON here could be read as a decision.
  process.exit(0);
}
