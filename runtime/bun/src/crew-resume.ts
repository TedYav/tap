// Resume retained crew rows on exact native conversations, one crew at a time.
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { TapError, observeCallerIdentity, type ResolvedContext } from "./context";
import { parseTarget, seats, teamContext } from "./crew-lifecycle";
import { isCrew } from "./crew-ownership";
import { assertCrewOwnerLink, captureCrewProcess, captureParentHarnessLifetime, fenceCrewLifetime, validateCrewProcess, type CrewProcess } from "./crew-lifetime";
import { acquirePathLock, acquireRegistryLockAsync } from "./panelock";
import { acquireResetMutationLock, assertResetUnfenced, fenceTestBarrier } from "./reset";
import { loadCurrentRegistry, saveRegistry, seatMap } from "./registry";
import { validateLockedRegistryAuthority } from "./slices/registry-authority";
import { assertCrewResumeUnheld } from "./crew-resume-identity";
import { NATIVE_CONVERSATION_ID } from "./native-conversation";
import { crewRecipeInvocation } from "./launcher/crew-invocation";
import { checkCrewRegistry } from "./crew-registry";
import { captureNewCrewIdentity } from "./crew-capture";
import { launchTmux } from "./launcher/process";
import { ensureTmuxServer } from "./launcher/tmux-bootstrap";
import { LaunchInterrupted, withLaunchSignals } from "./launcher/transaction";
import { LauncherError } from "./launcher/types";
import { bootId, tmuxSessionNamespace } from "./tmux";
import { scratchOnlyGuard } from "./out-retire";
import { agentFamilies, observeProcessHarness, readProcessTable } from "./observe";
import { inWorkdir, stableSpawnCwd } from "./tmux-spawn-cwd";
import { restoreSessionPath } from "./launcher/session-path";

type Row = Record<string, unknown>;
const str = (value: unknown): string => typeof value === "string" ? value : "";
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Row)[key])])) : value;
const sameRow = (a: Row, b: Row): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function fail(kind: string, detail: string, action = "tap crew list"): never { throw new TapError(1, kind, action, detail); }
const captureAccepted = (row: Row, id: string): boolean => row.harness_session_id === id
  && (row.crew_identity_capture as Row | undefined)?.decision === "accepted"
  && (row.crew_identity_capture as Row).observed_harness_session_id === id;

export interface CrewResumeOptions { target?: string; owners: string[]; json: boolean; dryRun: boolean; replace: boolean }
export interface CrewResumeReceipt {
  handle: string; ok: boolean; outcome: "resumed" | "already_live" | "would_resume" | "refused" | "started_unverified" | "untouched";
  pane_id?: string; session?: string; harness_session_id?: string; error_class?: string; detail?: string; action?: string;
}

export function parseCrewResume(argv: string[], replace = false): CrewResumeOptions {
  const options: CrewResumeOptions = { owners: [], json: process.env.TAP_JSON === "1", dryRun: false, replace };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") options.json = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--owner" || arg.startsWith("--owner=")) {
      const owner = arg === "--owner" ? argv[++i] : arg.slice(8);
      if (!owner || owner.startsWith("-")) fail("usage_error", "--owner requires one handle or team/handle", "tap help crew");
      parseTarget(owner); options.owners.push(owner);
    } else if (arg.startsWith("-") || options.target) fail("usage_error", `unexpected argument '${arg}'`, "tap help crew");
    else { parseTarget(arg); options.target = arg; }
  }
  if (options.target ? options.owners.length > 0 : options.owners.length === 0) fail("usage_error", "name one crew or one or more --owner handles", "tap help crew");
  if (replace && options.owners.length) fail("usage_error", "relaunch --resume takes one crew", "tap help crew");
  return options;
}

async function locked<T>(ctx: ResolvedContext, signal: AbortSignal, fn: (doc: Row, all: Record<string, Row>) => Promise<T> | T): Promise<T> {
  const lock = await acquireRegistryLockAsync(ctx.registryPath, 1000, signal);
  if (!lock) fail("registry_lock_busy", "crew registry is busy; no further effect attempted");
  try {
    const authority = validateLockedRegistryAuthority(ctx.registryPath, ctx.root, process.env.TAP_INDEX_HOME);
    if (!authority.ok) fail("registry_changed", authority.message);
    assertResetUnfenced(ctx.bus.home, "tap crew resume");
    const doc = loadCurrentRegistry(ctx.registryPath), all = seatMap(doc);
    return await fn(doc, all);
  } finally { await lock.release(); }
}

function ownerFor(all: Record<string, Row>, row: Row, expected?: Row): Row {
  const owner = all[str(row.crew_owner)];
  if (!owner || isCrew(owner) || !str(owner.instance) || owner.instance !== row.crew_owner_instance
    || (expected && owner.instance !== expected.instance)) fail("crew_owner_unidentified", "crew has no matching retained owner instance",
      "remove the crew, then add its exact native conversation under the intended owner");
  return owner;
}

function activeHarness(proof: CrewProcess, row: Row): boolean {
  const table = readProcessTable();
  const actual = observeProcessHarness(proof.child.pid, table.table, table.ok, agentFamilies());
  return actual.state === "observed" && actual.family === row.harness;
}

const FORMAT = "#{pane_id}\t#{session_name}\t#{session_id}\t#{window_id}\t#{pane_pid}\t#{pid}:#{start_time}\t#{socket_path}\t#{session_name}:#{window_index}.#{pane_index}";
async function paneFields(pane: string, signal: AbortSignal): Promise<Row> {
  const result = await launchTmux(["display-message", "-p", "-t", pane, FORMAT], process.env, signal, true, 3000);
  const [id, session, sessionId, window, pid, epoch, socket, address, ...extra] = result.stdout.trimEnd().split("\t");
  if (result.code || extra.length || id !== pane || !session || !/^\$\d+$/.test(sessionId ?? "") || !/^@\d+$/.test(window ?? "")
    || !/^[1-9]\d*$/.test(pid ?? "") || !/^\d+:\d+$/.test(epoch ?? "") || !socket || !address) fail("crew_start_unverified", `cannot read the created crew pane ${pane}`);
  return { pane_id: pane, session, pane: address, server_epoch: `srv:${epoch}`, server_socket: socket, boot_id: bootId() };
}

function liveOwnerSession(ctx: ResolvedContext, row: Row, owner: Row): string {
  try { return captureParentHarnessLifetime(ctx, str(row.crew_owner)).session; }
  catch {
    // Only positive owner loss permits a separate vessel; unreadable evidence refuses.
    const proof = captureCrewProcess(ctx.team, str(row.crew_owner), { ...owner, crew: true });
    if (proof) {
      const table = readProcessTable(), actual = observeProcessHarness(proof.child.pid, table.table, table.ok, agentFamilies());
      if (actual.state === "unobservable" || actual.family) fail("crew_owner_unobservable", `owner '${str(row.crew_owner)}' has a live process whose harness identity cannot be matched`, `inspect ${str(row.crew_owner)} before resuming its crew`);
    }
    return "";
  }
}

async function placement(ctx: ResolvedContext, row: Row, owner: Row, signal: AbortSignal): Promise<{ session: string; create: boolean; ownerKey?: string }> {
  const live = liveOwnerSession(ctx, row, owner);
  if (live) return { session: live, create: false };
  const ownerKey = `${ctx.team}/${str(row.crew_owner)}/${str(owner.instance)}`;
  const session = `${ctx.team}/crew-${str(row.crew_owner)}-${createHash("sha256").update(ownerKey).digest("hex").slice(0, 10)}`;
  const namespace = tmuxSessionNamespace();
  if (!namespace.observable) fail("crew_vessel_unobservable", "cannot observe tmux sessions; no crew window created");
  if (!namespace.names.has(session)) return { session, create: true, ownerKey };
  const marker = await launchTmux(["show-options", "-v", "-t", session, "@tap_crew_owner"], process.env, signal, true, 3000);
  if (marker.code || marker.stdout.trim() !== ownerKey) fail("crew_vessel_collision", `session '${session}' is not the retained owner's crew vessel`);
  return { session, create: false, ownerKey };
}

async function createPane(ctx: ResolvedContext, handle: string, row: Row, owner: Row, cwd: string, signal: AbortSignal, effect: () => void): Promise<string> {
  const target = await placement(ctx, row, owner, signal);
  effect();
  const result = await launchTmux(target.create
    ? ["new-session", "-d", "-s", target.session, "-n", handle, "-c", stableSpawnCwd(process.env), "-P", "-F", "#{pane_id}", "sleep 600"]
    : ["new-window", "-d", "-t", `=${target.session}`, "-n", handle, "-c", stableSpawnCwd(process.env), "-P", "-F", "#{pane_id}", "sleep 600"], process.env, signal, true, 5000);
  if (result.code || !/^%\d+$/.test(result.stdout.trim())) fail("crew_start_unverified", `crew window creation failed or is unverified: ${result.stderr.trim()}; inspect before retrying`);
  if (target.create) {
    const marked = await launchTmux(["set-option", "-t", target.session, "@tap_crew_owner", target.ownerKey!], process.env, signal, true, 3000);
    if (marked.code) fail("crew_start_unverified", `created vessel '${target.session}' but its owner marker could not be set (${marked.stderr.trim() || marked.code}); inspect before retrying`);
    // Created in $HOME; best effort, make the crew's directory the vessel's default for windows opened by hand.
    const where = await launchTmux(["display-message", "-p", "-t", result.stdout.trim(), "#{session_id}\t#{socket_path}"], process.env, signal, true, 3000);
    const [sessionId = "", socket = ""] = where.stdout.trim().split("\t");
    if (!where.code && sessionId && socket) await restoreSessionPath(socket, sessionId, cwd, process.env, signal);
  }
  return result.stdout.trim();
}

async function resumeOne(ctx: ResolvedContext, handle: string, expected: Row, options: CrewResumeOptions, scripts: string,
  signal: AbortSignal): Promise<CrewResumeReceipt> {
  let pane = "", attempted = false;
  let operation: ReturnType<typeof acquirePathLock> = null;
  let reset: ReturnType<typeof acquireResetMutationLock> | undefined;
  try {
    operation = options.dryRun ? null : acquirePathLock(`${ctx.registryPath}.crew-${handle}.lock`, 0);
    if (!options.dryRun && !operation) fail("crew_resume_busy", "another operation owns this crew; nothing started");
    signal.throwIfAborted();
    const all = seats(ctx), row = all[handle];
    if (!row || !isCrew(row) || !sameRow(row, expected)) fail("crew_row_changed", `crew '${handle}' changed since selection`);
    const owner = ownerFor(all, row);
    const id = str(row.harness_session_id);
    if (!NATIVE_CONVERSATION_ID.test(id)) fail("no_exact_resume_identity", `crew '${handle}' has no saved exact native conversation id`);
    const token = randomUUID();
    const recipe = await crewRecipeInvocation(ctx.team, handle, { ...row, launch_id: token }, process.env, false, signal, id, ctx.root);
    checkCrewRegistry(recipe.cwd, ctx.registryPath, ctx.root);
    assertCrewResumeUnheld(str(row.harness), id, ctx.registryPath, handle);
    const live = captureCrewProcess(ctx.team, handle, row);
    const caller = observeCallerIdentity();
    if (options.replace && live && caller.state === "inside" && caller.paneId === live.crewPane) fail("usage_error", "a crew cannot replace its own process; run from another pane");
    if (live && !options.replace) {
      if (!captureAccepted(row, id) || !activeHarness(live, row)) fail("crew_live_unverified", `crew '${handle}' has a live pane without an accepted matching native conversation`, `inspect it; use tap crew relaunch ${ctx.team}/${handle} --resume only to replace it explicitly`);
      if (!options.dryRun) {
        reset = acquireResetMutationLock(ctx.bus.home, "crew resume", 1000, "shared");
        await locked(ctx, signal, (doc, now) => {
          if (!now[handle] || !sameRow(now[handle]!, row) || !validateCrewProcess(live)) fail("crew_row_changed", "crew changed before the live no-op");
          ownerFor(now, now[handle]!, owner); fenceCrewLifetime(ctx, handle, now[handle]);
          if (now[handle]!.status_reason === "launching") {
            now[handle]!.status_reason = ""; now[handle]!.launch_witness = now[handle]!.launch_id;
            delete now[handle]!.launch_id; saveRegistry(ctx.registryPath, doc);
          }
        });
      }
      return { handle, ok: true, outcome: "already_live", pane_id: live.crewPane, session: live.crewSession, harness_session_id: id };
    }
    if (options.dryRun) {
      if (!live) await placement(ctx, row, owner, signal);
      return { handle, ok: true, outcome: "would_resume", harness_session_id: id };
    }
    reset = acquireResetMutationLock(ctx.bus.home, "crew resume", 1000, "shared");
    await ensureTmuxServer(process.env, { signal });
    fenceTestBarrier("crew-resume-before-create");
    await Bun.sleep(1); signal.throwIfAborted();
    let launchedProof: CrewProcess | null = null;
    await locked(ctx, signal, async (doc, now) => {
      const current = now[handle];
      if (!current || !sameRow(current, row)) fail("crew_row_changed", "crew changed before resume; nothing started");
      const parent = ownerFor(now, current, owner);
      assertCrewResumeUnheld(str(row.harness), id, ctx.registryPath, handle);
      if (live && !validateCrewProcess(live)) fail("crew_row_changed", "live crew process changed before replacement");
      if (!live && captureCrewProcess(ctx.team, handle, current)) fail("crew_row_changed", "crew became live before resume");
      fenceCrewLifetime(ctx, handle, current);
      signal.throwIfAborted();
      pane = live?.crewPane ?? await createPane(ctx, handle, row, parent, recipe.cwd, signal, () => { attempted = true; });
      const fields = await paneFields(pane, signal);
      Object.assign(current, fields, { status: "active", status_reason: "launching", launch_id: token,
        identity_capture: { mode: "exact_resume", expected_harness_session_id: id },
        crew_identity_capture: { decision: "not_started", at: new Date().toISOString() } });
      delete current.identity_capture_result;
      delete current.expected_clear_nonce;
      delete current.launch_witness;
      delete current.exited_at;
      saveRegistry(ctx.registryPath, doc);
      attempted = true;
      const result = await launchTmux(["respawn-pane", "-k", "-t", pane, "-c", stableSpawnCwd(process.env), inWorkdir(recipe.cwd, `exec ${recipe.command}`)], process.env, signal, true, 5000);
      if (result.code) fail("crew_start_unverified", `resume process start is unverified (tmux exit ${result.code}); inspect pane ${pane}; do not retry blindly`);
      launchedProof = captureCrewProcess(ctx.team, handle, current);
      if (!launchedProof) fail("crew_start_unverified", `crew ${handle} stopped during startup`);
    });
    fenceTestBarrier("crew-resume-after-start");
    await Bun.sleep(1); signal.throwIfAborted();
    await captureNewCrewIdentity(ctx, scripts, handle, pane, str(row.instance), str(row.harness), signal, { root: ctx.root, token });
    await locked(ctx, signal, (doc, now) => {
      const current = now[handle];
      if (!current || current.instance !== row.instance || current.pane_id !== pane || current.launch_id !== token) fail("crew_row_changed", "crew binding changed during resume; no retry performed");
      ownerFor(now, current, owner);
      if (!launchedProof || !validateCrewProcess(launchedProof) || !activeHarness(launchedProof, current) || !captureAccepted(current, id)) {
        fail("crew_identity_unverified", `crew process started in ${pane}, but its exact native identity was not accepted; inspect before assigning or retrying`);
      }
      current.status = "active"; current.status_reason = ""; current.launch_witness = token; delete current.launch_id;
      saveRegistry(ctx.registryPath, doc);
    });
    return { handle, ok: true, outcome: "resumed", pane_id: pane, session: str(seats(ctx)[handle]?.session), harness_session_id: id };
  } catch (error) {
    const known = error instanceof TapError || error instanceof LauncherError ? error : null;
    return { handle, ok: false, outcome: attempted ? "started_unverified" : "refused", ...(pane ? { pane_id: pane } : {}),
      error_class: signal.aborted ? "crew_resume_interrupted" : known?.errorClass || "crew_resume_refused",
      detail: known?.detail || (error instanceof Error ? error.message : String(error)),
      action: attempted ? `inspect ${pane ? `pane ${pane}` : "tap crew list"}; no retry performed` : known?.action || "tap crew list" };
  } finally { reset?.release(); operation?.release(); }
}

export async function cmdCrewResume(argv: string[], scripts: string, replace = false): Promise<number> {
  const options = parseCrewResume(argv, replace), targets = [options.target ?? options.owners[0]!].map(parseTarget);
  const ctx = teamContext(targets[0]!.team), all = seats(ctx);
  const selected = new Set<string>();
  if (options.target) {
    const handle = targets[0]!.handle;
    if (!all[handle] || !isCrew(all[handle])) fail("not_found", `'${handle}' is not a retained crew`);
    selected.add(handle);
  } else for (const spec of options.owners) {
    const target = parseTarget(spec);
    if (target.team && target.team !== ctx.team) fail("team_mismatch", "all --owner selectors must name one team");
    if (!all[target.handle] || isCrew(all[target.handle])) fail("crew_owner_unidentified", `owner '${target.handle}' is not retained`);
    // Include stale links so each one produces an honest refusal instead of disappearing from the receipt.
    for (const [handle, row] of Object.entries(all)) if (isCrew(row) && row.crew_owner === target.handle) selected.add(handle);
  }
  scratchOnlyGuard(process.env, "crew resume would start a process on", ctx.bus.home, "tap crew");
  return withLaunchSignals(async signal => {
    const results: CrewResumeReceipt[] = [];
    for (const handle of [...selected].sort()) {
      if (signal.aborted) {
        results.push({ handle, ok: false, outcome: "untouched", detail: "interrupted before this crew was attempted" });
        if (!options.json) process.stdout.write(`tap crew resume: ${ctx.team}/${handle}: untouched after interruption\n`);
        continue;
      }
      const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(new Error("crew launch deadline exceeded (30 seconds)")), 30000);
      let result: CrewResumeReceipt;
      try { result = await resumeOne(ctx, handle, all[handle]!, options, scripts, AbortSignal.any([signal, deadline.signal])); }
      finally { clearTimeout(timer); }
      results.push(result);
      if (!options.json) process.stdout.write(`tap crew ${replace ? "relaunch --resume" : "resume"}: ${ctx.team}/${handle}: ${result.outcome}${result.pane_id ? ` in ${result.pane_id}` : ""}${result.detail ? ` — ${result.detail}; next: ${result.action}` : ""}\n`);
    }
    const ok = results.every(row => row.ok);
    if (options.json) process.stdout.write(JSON.stringify({ ok, team: ctx.team, results }) + "\n");
    else process.stdout.write(`tap crew resume: ${results.filter(row => row.ok).length}/${results.length} ready${signal.aborted ? "; interrupted; remaining crews untouched" : ""}\n`);
    return signal.aborted ? signal.reason instanceof LaunchInterrupted ? signal.reason.exitCode : 130 : ok ? 0 : 1;
  });
}
