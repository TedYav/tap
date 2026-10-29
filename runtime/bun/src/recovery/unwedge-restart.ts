import { accessSync, constants, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Notices } from "../launcher/catalog-notices";
import { discardReceipts, launchInvocation } from "../launcher/invocation";
import { seatStoreEnv } from "../launcher/resume-identity";
import type { LaunchRecord } from "../launcher/transaction";
import type { Invocation } from "../launcher/types";
import { launchWorkdir } from "../launcher/workdir";
import { readBoundTranscript } from "../readiness-stall";
import { loadCurrentRegistry, seatMap, type Seat } from "../registry";
import { tmuxReadOnly } from "../tmux";
import { defaultProc, observeProcessStore } from "../session-store";
import { assertUniqueHarnessSessionIdentity } from "../launcher/identity-owner";
import { findRecordByKey } from "../launcher/resume";
import { cloneRecord, registryState } from "../launcher/resume-prelude";
import { launchHandle, launchTransaction, recordFromRow, RestartResumeFailure, withLaunchSignals } from "../launcher/transaction";
import type { SeatSnapshot } from "../verbs/doctor-seat";
import type { UnwedgeReservation } from "./unwedge-observe";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function directories(path: string): string[] {
  try { return readdirSync(path, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => join(path, d.name)); } catch { return []; }
}
function storeRoot(harness: string, env: NodeJS.ProcessEnv): string {
  const value = (harness === "codex" ? env.CODEX_HOME : env.CLAUDE_CONFIG_DIR) || join(env.HOME || "", harness === "codex" ? ".codex" : ".claude");
  if (!isAbsolute(value)) throw new Error("exact restart requires an absolute child store root");
  return value;
}
function exactArtifact(record: LaunchRecord, id: string, env: NodeJS.ProcessEnv): string {
  const root = storeRoot(record.harness, env);
  const dirs = record.harness === "claude" ? directories(join(root, "projects"))
    : directories(join(root, "sessions")).flatMap(directories).flatMap(directories);
  const candidates: string[] = [];
  for (const dir of dirs) {
    let files: string[]; try { files = readdirSync(dir); } catch { continue; }
    for (const file of files) {
      if (record.harness === "claude" ? file !== `${id}.jsonl` : !file.startsWith("rollout-") || !file.endsWith(`-${id}.jsonl`)) continue;
      const path = join(dir, file);
      if (readBoundTranscript(record.harness, { harness_session_id: id, transcript_path: path }, env)) candidates.push(realpathSync(path));
    }
  }
  const unique = [...new Set(candidates)];
  if (unique.length !== 1) throw new Error("exact native conversation artifact is missing, unreadable or ambiguous in the child store");
  if (record.transcript_path) {
    if (!readBoundTranscript(record.harness, { harness_session_id: id, transcript_path: record.transcript_path }, env)
      || realpathSync(record.transcript_path) !== unique[0]) throw new Error("recorded transcript and exact native artifact disagree");
  }
  return unique[0]!;
}
export interface ExactRestartPlan { invocation: Invocation; transcript: string; workdir: string; env: NodeJS.ProcessEnv }
/** No fallback identity, picker, cwd-wide artifact, or ambient store alias. */
export function prepareExactRestart(record: LaunchRecord, id: string, env = process.env): ExactRestartPlan {
  if (!UUID.test(id) || record.harness_session_id !== id || !["codex", "claude"].includes(record.harness)) throw new Error("exact native resume identity is missing or split");
  let workdir: string;
  try { workdir = realpathSync(launchWorkdir(record)); if (!statSync(workdir).isDirectory()) throw new Error(); }
  catch { throw new Error("recorded launch workdir is unavailable"); }
  const child = seatStoreEnv(record, env);
  if (!child) throw new Error("the child store environment could not be resolved");
  const transcript = exactArtifact(record, id, child);
  const invocation = launchInvocation("resume", structuredClone(record), new Notices(() => {}), { env, resume: id, notify: false, receipts: discardReceipts });
  const effective = { ...child, ...invocation.env }; for (const key of invocation.unset_env ?? []) delete effective[key];
  const executable = effective.PATH ? Bun.which(invocation.argv[0]!, { PATH: effective.PATH }) : null;
  if (!executable) throw new Error("recorded harness executable is unavailable");
  try { accessSync(executable, constants.X_OK); if (!statSync(executable).isFile()) throw new Error(); }
  catch { throw new Error("recorded harness executable is unavailable"); }
  invocation.argv[0] = executable;
  return { invocation, transcript, workdir, env: child };
}


export type RestartGuard = (reservation?: UnwedgeReservation) => string;
/** This check also protects unregistered co-tenants; a session stop owns only one pane. */
export function soleRestartPane(snapshot: SeatSnapshot, env = process.env): void {
  const b = snapshot.binding;
  if (env.TMUX_PANE === b.paneId) throw new Error("restart would stop the calling pane");
  const panes = tmuxReadOnly(["list-panes", "-s", "-t", `=${b.session}`, "-F", "#{pane_id}"], env);
  if (panes.code !== 0 || panes.rateLimited || panes.stdout.trim() !== b.paneId) throw new Error("restart requires the diagnosed pane to be the session's sole pane; use in-place relaunch for a shared session");
}
function boundRecord(snapshot: SeatSnapshot): LaunchRecord {
  const state = registryState(snapshot.root), b = snapshot.binding;
  const record = findRecordByKey(state.sessions, snapshot.root, b.handle);
  if (!record || record.name !== b.session || record.harness !== b.harness || launchHandle(record) !== b.handle
    || record.harness_session_id !== b.nativeSessionId) throw new Error("the stored launch record does not identify the diagnosed conversation");
  assertUniqueHarnessSessionIdentity(state.sessions, record, "tap unwedge restart");
  return cloneRecord(record);
}
const signature = (plan: ExactRestartPlan) => JSON.stringify([plan.invocation, plan.transcript, plan.workdir, plan.env]);

/** Exact-native restart through the existing transaction; never retries or chooses another conversation. */
export async function restartUnwedge(snapshot: SeatSnapshot, guard: RestartGuard, recoveryId: string,
  beforeEffect: () => void, scriptsDir?: string, env = process.env): Promise<{ code: number; detail: string }> {
  const b = snapshot.binding, record = boundRecord(snapshot), prepared = prepareExactRestart(record, b.nativeSessionId, env);
  const fingerprint = signature(prepared);
  const verify = async (original?: Record<string, unknown>, token?: string) => {
    soleRestartPane(snapshot, env);
    const current = seatMap(loadCurrentRegistry(b.registry))[b.handle];
    const fresh = original ? current && recordFromRow(b.handle, current, { name: b.team, worktree_root: snapshot.root }, snapshot.root) : boundRecord(snapshot);
    if (!fresh || signature(prepareExactRestart(fresh, b.nativeSessionId, env)) !== fingerprint) throw new Error("the launch recipe, child store, artifact or executable changed before restart");
    const reason = guard(original && token ? { original: original as Seat, token } : undefined);
    if (reason) throw new Error(reason);
  };
  await verify();
  beforeEffect();
  try {
    const restarted = await withLaunchSignals(signal => launchTransaction({ kind: "restart", record, incumbent_live: true,
      root: snapshot.root, preflight_done: true, json: true, script_dir: scriptsDir, terminal: { stderr_tty: false },
      exact_restart: { id: b.nativeSessionId, invocation: prepared.invocation, verify } }, env, signal, new Notices(() => {})));
    if (restarted.code !== 0) return { code: 5, detail: "restart transaction did not complete; inspect its retained evidence" };
    const proof = verifyRestartedConversation(snapshot, prepared, record.launch_id || "", env);
    const backup = restarted.backup.status === "backed-up" ? `; backup=${restarted.backup.path}` : "";
    return { code: proof.code, detail: `${proof.detail}; launch=${record.launch_id}; recovery=${recoveryId}${backup}` };
  } catch (error) {
    if (error instanceof RestartResumeFailure) return { code: 5, detail: `old session stopped; native resume failed; receipt=${error.receipt.stored_record_path}; ${error.message}` };
    throw error;
  }
}


export interface RestartProofIO {
  row(): Seat | undefined;
  pid(pane: string): string;
  native(pid: string): ReturnType<typeof observeProcessStore>;
  transcript(path: string): boolean;
}
export function verifyRestartedConversation(snapshot: SeatSnapshot, prepared: ExactRestartPlan, launchId: string, env = process.env,
  io: RestartProofIO = {
    row: () => seatMap(loadCurrentRegistry(snapshot.binding.registry))[snapshot.binding.handle],
    pid: pane => { const r = tmuxReadOnly(["display-message", "-p", "-t", pane, "#{pane_pid}"], env); return r.code === 0 && !r.rateLimited ? r.stdout.trim() : ""; },
    native: pid => observeProcessStore(defaultProc, snapshot.binding.harness, prepared.workdir, prepared.env.HOME || "", pid, prepared.env),
    transcript: path => !!readBoundTranscript(snapshot.binding.harness, { harness_session_id: snapshot.binding.nativeSessionId, transcript_path: path }, prepared.env),
  }): { code: number; detail: string } {
  const b = snapshot.binding, pending = (detail: string) => ({ code: 5, detail: `native resume started; ${detail}` });
  const row = io.row();
  if (!row || !launchId || row.launch_witness !== launchId || row.instance !== b.instance || row.harness !== b.harness
    || row.harness_session_id !== b.nativeSessionId || row.status !== "active" || typeof row.pane_id !== "string") return pending("current seat identity verification pending");
  const pid = io.pid(row.pane_id);
  if (!/^\d+$/.test(pid)) return pending("process identity verification pending");
  const native = io.native(pid);
  if (!native.identity) return pending(`conversation verification pending (${native.refusal})`);
  if (native.identity.harness_session_id !== b.nativeSessionId) return pending("conversation disagrees with preflight; inspect the replacement seat; no retry attempted");
  if (!io.transcript(native.identity.store_path)) return pending("process-bound transcript verification pending");
  const after = io.row();
  if (!after || ["pane_id", "instance", "harness", "harness_session_id", "launch_witness", "status"].some(key => after[key] !== row[key])
    || io.pid(row.pane_id) !== pid) return pending("replacement identity changed during verification");
  return { code: 0, detail: "exact native resume started; conversation verified; work unverified" };
}
