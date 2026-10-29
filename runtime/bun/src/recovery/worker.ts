import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedContext } from "../context";
import { loadRegistry, seatMap } from "../registry";
import { observePaneResult, tmuxReadOnly } from "../tmux";
import { resolveCatalog } from "../launcher/catalog";
import { mintId } from "../ids";
import { atomicWrite } from "../fsatomic";
import { canAct, readRun, releaseRun, runDirectory, updateRun, type RecoveryRun } from "./state";
import { cleanupIO, cleanupRecoveryCrew, prepareWorkerWorkspace, tapCommand, type OwnedCrew } from "./crew";
import { waitWorkerReply } from "./waiter";
export interface WorkerCycleIO<T> {
  launch(): Promise<{ crew?: OwnedCrew; error?: string }>;
  assign(crew: OwnedCrew, brief: string): Promise<string>;
  wait(crew: OwnedCrew, id: string): Promise<string>;
  inspect(): T | Promise<T>;
  cleanup(crew?: OwnedCrew): Promise<string[]>;
}
export async function runRecoveryWorker<T>(brief: string, io: WorkerCycleIO<T>): Promise<{ value?: T; error?: string; gaps: string[] }> {
  let crew: OwnedCrew | undefined, value: T | undefined, error: string | undefined;
  let gaps: string[] = [];
  try {
    const launched = await io.launch();
    crew = launched.crew;
    if (launched.error) throw new Error(launched.error);
    if (!crew) throw new Error("worker launch supplied no owned identity");
    const identity = await io.assign(crew, "Identity check only. Run tap whoami, then reply to this ask with exactly that handle, no Markdown. Do no recovery actions yet.");
    if (await io.wait(crew, identity) !== crew.handle) throw new Error("worker identity reply did not match its assigned handle");
    const job = await io.assign(crew, brief);
    await io.wait(crew, job);
    value = await io.inspect();
  } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
  finally {
    try { gaps = await io.cleanup(crew); }
    catch (failure) { gaps = [`worker cleanup: ${failure}`]; }
  }
  return { ...(value !== undefined ? { value } : {}), ...(error !== undefined ? { error } : {}), gaps };
}

export function captureOwnedCrew(ctx: ResolvedContext, handle: string, session: string): { crew: OwnedCrew; error?: string } {
  const row = seatMap(loadRegistry(ctx.registryPath))[handle];
  if (!row || row.crew !== true || row.session !== session || typeof row.pane_id !== "string") throw new Error("crew did not publish its expected bound identity");
  const obs = observePaneResult(row.pane_id);
  const window = tmuxReadOnly(["display-message", "-p", "-t", row.pane_id, "#{window_id}"]);
  if (obs.status !== "ok" || obs.observation.session !== session || !/^@\d+$/.test(window.stdout.trim())) throw new Error("created crew window identity cannot be verified");
  const crew: OwnedCrew = { handle, paneId: row.pane_id, windowId: window.stdout.trim(), session,
    serverEpoch: obs.observation.serverEpoch, instance: String(row.instance ?? ""), assignments: [] };
  const capture = row.crew_identity_capture as Record<string, unknown> | undefined;
  const accepted = capture?.decision === "accepted" && !!row.harness_session_id && capture.observed_harness_session_id === row.harness_session_id;
  return { crew, ...(!accepted ? { error: "created crew has no accepted native identity capture" } : {}) };
}
async function assignWorker(ctx: ResolvedContext, run: RecoveryRun, crew: OwnedCrew, text: string): Promise<string> {
  const id = mintId(run.caller!.actor), path = join(runDirectory(run.id), `${id}.charter.md`);
  writeFileSync(path, text, { mode: 0o600 });
  crew.assignments.push(id);
  updateRun(run.id, r => { r.worker = crew; });
  const result = await tapCommand(ctx, ["assign", crew.handle, "--id", id, "--from", run.caller!.actor, "-f", path], { timeoutMs: Math.max(1, run.deadline - Date.now()) });
  if (result.code !== 0 && result.code !== 5) throw new Error(`worker assignment failed: ${result.stderr || result.stdout}`);
  return id;
}

/** The same launch/identity/assignment/inspection/cleanup cycle serves both recovery roles. */
export async function withRecoveryWorker<T>(ctx: ResolvedContext, run: RecoveryRun, preset: string, brief: string,
  inspect: (run: RecoveryRun) => T | Promise<T>, boundary?: () => string,
  diagnostic: (message: string) => void = message => process.stderr.write(`${message}\n`)): Promise<{ value?: T; error?: string; gaps: string[] }> {
  const check = () => {
    if (!canAct(readRun(run.id))) throw new Error("recovery owner is no longer active");
    const refusal = boundary?.();
    if (refusal) throw new Error(refusal);
  };
  return runRecoveryWorker(brief, {
    launch: async () => {
      resolveCatalog(preset, undefined, process.env, diagnostic);
      check();
      const parent = observePaneResult(run.ownerPane);
      if (parent.status !== "ok") throw new Error("operator session is no longer observable");
      const name = `${run.purpose === "operator" ? "operator" : "detective"}-${run.id.slice(-8)}`;
      if (seatMap(loadRegistry(ctx.registryPath))[name]) throw new Error("worker name already exists; refusing adoption");
      const cwd = prepareWorkerWorkspace(ctx, run);
      atomicWrite(join(runDirectory(run.id), "worker-launch.json"), JSON.stringify({ requested: name, cwd, parent: parent.observation, state: "starting" }));
      const result = await tapCommand(ctx, ["crew", "add", preset, name, "--cwd", cwd],
        { timeoutMs: Math.max(1, run.deadline - Date.now()) });
      atomicWrite(join(runDirectory(run.id), "worker-launch.json"), JSON.stringify({ requested: name, cwd, parent: parent.observation, result }));
      let owned: ReturnType<typeof captureOwnedCrew>;
      try { owned = captureOwnedCrew(ctx, name, parent.observation.session); }
      catch (error) { return { error: `worker ${name} launch ownership unavailable; cleanup unverified: ${result.stderr || error}` }; }
      try { updateRun(run.id, current => { current.worker = owned.crew; }); }
      catch (error) { return { crew: owned.crew, error: `worker ownership record failed: ${error}` }; }
      return { crew: owned.crew, ...(owned.error ? { error: owned.error }
        : result.code !== 0 ? { error: `crew launch failed: ${result.stderr}` } : {}) };
    },
    assign: async (crew, body) => { check(); return assignWorker(ctx, readRun(run.id), crew, body); },
    wait: (crew, id) => waitWorkerReply(ctx, run.id, id, crew.handle, run.caller!.actor, run.deadline),
    inspect: () => inspect(readRun(run.id)),
    cleanup: async crew => {
      if (crew) return cleanupRecoveryCrew(crew, cleanupIO(readRun(run.id), crew, ctx, run.caller!.actor));
      try { releaseRun(run.id); return []; } catch (error) { return [`hold release: ${error}`]; }
    },
  });
}
