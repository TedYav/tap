// Restart ends the stored session, then resumes its recipe through the shared transaction.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveContext } from "../context";
import { enrolledTeamNameForRoot } from "../index-home";
import { jsonDumpBytes } from "../spool-publication";
import { frontmatterFields } from "../payload-fields";
import { fenceTestBarrier } from "../reset";
import { seatState } from "../seat-state";
import { startupTrace, withStartupTrace } from "../startup-trace";
import { Notices } from "./catalog-notices";
import { HARNESSES } from "./catalog";
import { seatIsRelaunchable } from "./complete";
import { currentBootId } from "./generation";
import { assertUniqueHarnessSessionIdentity } from "./identity-owner";
import { discardReceipts, launchInvocation, shlexQuote } from "./invocation";
import { entrySession, hasSession } from "./observation";
import { callerTty } from "./prompt";
import { pathIsUnder, realOrSelf, rootForCwd } from "./records";
import { timestamp } from "./repair";
import { findRecordByKey, requireMember } from "./resume";
import { idlessFreshWarning, recordHasResumeArtifact } from "./resume-identity";
import { cloneRecord, err, out, Refusal, refuseIfFlipAuthority, refuseIfResetFenced, registryState, render, SCRIPTS, type RegistryState } from "./resume-prelude";
import { launchHandle, launchTransaction, RestartResumeFailure, withLaunchSignals, type LaunchRecord } from "./transaction";
import { LauncherError } from "./types";

export interface RestartOptions { key: string; force: boolean; dryRun: boolean; json: boolean }
export interface RestartDeps {
  live(name: string): Promise<boolean>;
  state(handle: string, cwd: string): string;
  run(record: LaunchRecord, live: boolean): Promise<number>;
}
const busyStates = new Set(["working", "blocked-on-approval", "rate-limited-error", "alert", "unknown"]);

export async function sessionSeatStates(record: LaunchRecord, state: RegistryState, read: RestartDeps["state"]): Promise<Map<string, string>> {
  const handles: string[] = [];
  for (const [handle, row] of state.entries) {
    if ((row.status ?? "active") === "active" && await entrySession(row, process.env) === record.name) handles.push(handle);
  }
  if (!handles.length) handles.push(launchHandle(record));
  return new Map(handles.map(handle => [handle, read(handle, record.cwd)]));
}

/** Best-effort pending-mail hint; it has no delivery or settlement effects. */
function inboxDigest(record: LaunchRecord): void {
  try {
    const root = rootForCwd(record.cwd), ctx = resolveContext(root, process.env, { readOnly: true });
    const enrolled = enrolledTeamNameForRoot(root), team = enrolled.status === "ok" ? enrolled.name : "";
    const handle = launchHandle(record), ids: string[] = [];
    for (const file of readdirSync(join(ctx.bus.home, "payloads")).sort()) {
      if (!file.endsWith(".md") || file.startsWith("_")) continue;
      const id = file.slice(0, -3);
      if (existsSync(join(ctx.bus.home, "receipts", `${id}.done`))) continue;
      const fields = frontmatterFields(readFileSync(join(ctx.bus.home, "payloads", file), "utf8"));
      if (fields.to !== handle || (fields.to_team?.trim() && fields.to_team.trim() !== team)) continue;
      ids.push(fields.id || id);
    }
    if (ids.length) err(`tap session inbox: ${ids.length} pending for ${handle}: ${ids.slice(0, 3).join(", ")}${ids.length > 3 ? ` +${ids.length - 3}` : ""}; next: tap poll ${handle}`);
  } catch { /* Advisory only, after a successful restart. */ }
}

export async function restartSession(options: RestartOptions, cwd: string, deps: RestartDeps, notices = new Notices()): Promise<number> {
  refuseIfResetFenced(cwd, "session restart");
  fenceTestBarrier("after-entry-guard");
  refuseIfFlipAuthority(cwd, "tap session restart");
  const state = registryState(cwd), record = findRecordByKey(state.sessions, cwd, options.key);
  if (!record) {
    // A harness-family key (claude, codex, ...) names several sessions, not none:
    // list them so the caller can pick one (documented session_ambiguous class).
    const root = rootForCwd(cwd);
    const matches = HARNESSES.includes(options.key) ? state.sessions.filter(r => r.harness === options.key && pathIsUnder(r.cwd, root)).map(r => r.name).sort() : [];
    if (matches.length > 1) {
      const action = `tap session list --harness ${options.key}`;
      throw new LauncherError(`restart key is ambiguous: ${options.key}`, "session_ambiguous", action, `${options.key} matches: ${matches.join(", ")}`);
    }
    throw new Refusal(`restart key not found or ambiguous: ${options.key}; use an exact handle or session`);
  }
  requireMember(cwd, record);
  const live = await deps.live(record.name);
  if (live && !options.force) {
    const busy = [...await sessionSeatStates(record, state, deps.state)].filter(([, value]) => busyStates.has(value)).sort(([a], [b]) => a.localeCompare(b));
    if (busy.length) {
      let action = `tap session restart ${shlexQuote(options.key)} --force`;
      const capped = busy.filter(([handle, value]) => value === "rate-limited-error" && seatIsRelaunchable(state.entries.get(handle))).map(([handle]) => handle);
      const team = enrolledTeamNameForRoot(rootForCwd(record.cwd));
      if (capped.length && team.status === "ok") action = capped.map(handle => `tap session relaunch ${shlexQuote(`${team.name}/${handle}`)}`).join(" ; ")
        + `   # per seat, in place, keeps the conversation (or: ${action})`;
      const detail = `session ${record.name} has busy seats: ${busy.map(([handle, value]) => `${handle}=${value}`).join(", ")}`;
      throw new LauncherError(detail, "session_busy", action, detail);
    }
  }
  const launched = { ...record, last_launched: timestamp() };
  assertUniqueHarnessSessionIdentity(state.sessions, launched, "tap session restart");
  // tap-we6b rework: a cursor id whose store never persisted is not resumable
  // (same gate as `tap session resume`) — restart must refuse, not silently
  // mint a fresh conversation under the stored identity.
  if (launched.harness === "cursor" && launched.harness_session_id && !recordHasResumeArtifact(launched, process.env)) {
    throw new LauncherError(`restart refused — ${launched.name} (cursor) has stored chat id ${launched.harness_session_id} but no persisted conversation store`,
      "no_exact_resume_identity", `tap session launch cursor ${launchHandle(launched)} --fresh`,
      `stored chat id ${launched.harness_session_id} has no cursor store.db under this worktree; the conversation never persisted, so restart refuses rather than silently start a different one`);
  }
  launchInvocation("resume", launched, notices, { notify: false, receipts: discardReceipts });
  requireMember(cwd, launched);
  const freshWarning = idlessFreshWarning(launched);
  if (freshWarning) err(freshWarning);
  const code = await deps.run(launched, live);
  if (code === 0 && !options.dryRun && !options.json) { inboxDigest(launched); out(`tap session restart: restarted ${launched.name}`); }
  return code;
}

export function renderRestartFailure(error: RestartResumeFailure, json: boolean): number {
  if (json) out(jsonDumpBytes(error.receipt, { item: ",", key: ":" }, true));
  else err(`tap session restart: ${error.message}; stored record: ${error.receipt.stored_record_path}; next: ${error.receipt.action}`);
  return 1;
}

export async function cmdSessionRestart(options: RestartOptions, scriptDir = SCRIPTS): Promise<number> {
  const notices = new Notices(); notices.suppress(options.json);
  const cwd = realOrSelf(process.cwd());
  return withStartupTrace(async () => {
    let code = 1;
    if (!options.dryRun) startupTrace("launch_start", { verb: "restart", cwd, target: options.key, boot_id: currentBootId() }, true);
    try {
      code = await restartSession(options, cwd, {
        live: name => hasSession(name, process.env),
        state: (handle, dir) => {
          try { const ctx = resolveContext(dir, process.env, { readOnly: true });
            return seatState(handle, { registry: ctx.registryPath, home: ctx.bus.home, env: { ...process.env, TAP_SEAT_STATE_READONLY: "1" } });
          } catch { return "unknown"; }
        },
        run: (record, live) => withLaunchSignals(async signal => (await launchTransaction({ kind: "restart", record: cloneRecord(record),
          incumbent_live: live, preflight_done: true, dry_run: options.dryRun, json: options.json, script_dir: scriptDir,
          output_path: callerTty(), terminal: { stderr_tty: !!process.stderr.isTTY } }, process.env, signal, notices)).code),
      }, notices);
    } catch (error) { code = error instanceof RestartResumeFailure ? renderRestartFailure(error, options.json) : render(error, options.json); }
    finally { if (!options.dryRun) startupTrace(code === 0 ? "launch_complete" : "launch_failure", { exit_code: code }); }
    return code;
  }, undefined, scriptDir);
}
