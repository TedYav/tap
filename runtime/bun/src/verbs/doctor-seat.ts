import { closeSync, constants, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";

import { requireActingRegistry, resolveContext, TapError, type ResolvedContext } from "../context";
import { envelopeField } from "../envelope";
import { validId, validToken } from "../ids";
import { humanLine } from "../native-error";
import { harnessEvidence, stallBoundSeconds, type HarnessEvidence } from "../readiness-stall";
import { loadCurrentRegistry, seatMap, type Seat } from "../registry";
import { observedRows, withAgentStates } from "../roster-observation";
import { observe, type RegistryRow } from "../team-observe";
import { ServerUnresponsive, tmuxReadOnly } from "../tmux";
import { readInputProtection, protectionDetail } from "../input-protection";
import type { UnwedgeBinding } from "../recovery/unwedge-policy";

export type SeatVerdict = "healthy" | "thinking" | "busy-unproven" | "parked-on-dialog" | "severed" | "gone" | "unverified-but-processing" | "unknown";
export interface SeatEvidence { source: string; fact: string; value: unknown }
export interface SeatDiagnosis {
  ok: boolean;
  scope: "seat";
  handle: string;
  verdict: SeatVerdict | null;
  evidence: SeatEvidence[];
  not_checked: string[];
  sampled_at: string;
  action: string;
}
export interface SeatSnapshot { binding: UnwedgeBinding; seat: Seat; busHome: string; root: string }
export interface SeatCheck { report: SeatDiagnosis; code: number; snapshot?: SeatSnapshot }

const text = (value: unknown): string => typeof value === "string" ? value : "";
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Diagnostics must not block on FIFOs or read an unbounded payload. */
function regularText(path: string, limit = 1024 * 1024): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > limit) return null;
    const buf = Buffer.alloc(st.size);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, n));
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

function receipt(home: string, id: string, suffix: string): Record<string, unknown> | null {
  try {
    const raw = regularText(join(home, "receipts", `${id}.${suffix}`), 65536);
    const value: unknown = raw === null ? null : JSON.parse(raw);
    return object(value) && value.id === id ? value : null;
  } catch { return null; }
}

/** A later genuine read/settlement is stronger than the courier's failed verification.
 * Current recipient binding and receipt actor are required; forced reads are not progress. */
function processedAfterUnverified(home: string, team: string, handle: string, seat: Seat, now: number,
  unchecked: string[]): SeatEvidence | null {
  const instance = text(seat.instance);
  if (!instance) { unchecked.push("delivery evidence: recipient instance unavailable"); return null; }
  let names: string[];
  try { names = readdirSync(join(home, "receipts")); }
  catch { unchecked.push("delivery evidence: receipts unreadable"); return null; }
  let newest: { at: number; evidence: SeatEvidence } | null = null;
  for (const name of names) {
    if (!name.endsWith(".unconfirmed")) continue;
    const id = name.slice(0, -".unconfirmed".length);
    if (!validId(id)) continue;
    const failed = receipt(home, id, "unconfirmed");
    if (!failed) { unchecked.push(`delivery evidence: unreadable unconfirmed receipt ${id}`); continue; }
    if (failed.status !== "unconfirmed" || failed.effect !== "possible") continue;
    const raw = regularText(join(home, "payloads", `${id}.md`));
    if (raw === null) { unchecked.push(`delivery evidence: payload unavailable for ${id}`); continue; }
    if (envelopeField(raw, "to") !== handle || envelopeField(raw, "recipient_instance") !== instance) continue;
    const toTeam = envelopeField(raw, "to_team");
    if (toTeam && toTeam !== team) continue;
    if (receipt(home, id, "sent") || receipt(home, id, "cancelled")) continue;
    const failedAt = Date.parse(text(failed.at)) / 1000;
    if (!Number.isFinite(failedAt) || failedAt > now) continue;
    for (const suffix of ["done", "read"]) {
      const seen = receipt(home, id, suffix);
      if (!seen || seen.by !== handle || String(seen.forced) === "true" || seen.reason === "instance_retired") continue;
      // Ask reads do not stamp an instance. Their canonical envelope binds
      // the recipient above; a genuine read must also name this actor/pane.
      // The receipt's optional epoch is a work epoch, not a tmux generation.
      const current = typeof seen.instance === "string" ? seen.instance === instance
        : suffix === "read" && seen.identity === "pane" && seen.pane === seat.pane_id;
      const at = Date.parse(text(seen.at)) / 1000;
      if (!current || !Number.isFinite(at) || at < failedAt || at > now) continue;
      if (!newest || at > newest.at) newest = { at, evidence: { source: "receipts", fact: "observed_after_unverified",
        value: { id, unverified_at: failed.at, observed_at: seen.at, via: suffix, instance } } };
    }
  }
  return newest?.evidence ?? null;
}

function currentSeat(registry: string, handle: string): Seat {
  // Unlike loadRegistry's missing-file fallback, diagnosis needs a readable authority.
  if (regularText(registry, 16 * 1024 * 1024) === null) throw new TapError(1, "registry_invalid", "tap doctor", "the acting registry is unreadable");
  let row: Seat | undefined;
  try { row = seatMap(loadCurrentRegistry(registry))[handle]; }
  catch (error) {
    if (error instanceof TapError || (error as { tapErrorClass?: string }).tapErrorClass) throw error;
    throw new TapError(1, "registry_invalid", "tap doctor", "the acting registry could not be read");
  }
  if (!object(row)) throw new TapError(1, "unregistered", "tap team", `no registered seat '${handle}'`);
  return row;
}

/** Read the acting registry and the roster's observation pipeline. No repair, locks or bus creation. */
export function checkSeat(handle: string, scriptsDir: string, context?: ResolvedContext): SeatCheck {
  if (!validToken(handle)) throw new TapError(1, "usage_error", "tap help doctor", `invalid handle '${handle}'`);
  const ctx = context ?? resolveContext(process.cwd(), process.env, { paneFallback: false, readOnly: true });
  requireActingRegistry(ctx, 4);
  const seat = currentSeat(ctx.registryPath, handle);
  const report: SeatDiagnosis = { ok: false, scope: "seat", handle, verdict: null, evidence: [], not_checked: [],
    sampled_at: new Date().toISOString(), action: `tap peek ${handle}` };
  let snapshot: SeatSnapshot | undefined;
  const add = (source: string, fact: string, value: unknown) => report.evidence.push({ source, fact, value });
  const finish = (verdict: SeatVerdict | null, code: number, action = report.action): SeatCheck => {
    report.verdict = verdict; report.ok = code === 0; report.action = action;
    return { report, code, ...(snapshot && verdict !== null && { snapshot }) };
  };
  add("registry", "status", seat.status ?? "active");
  if ((seat.delivery ?? "pane") !== "pane") {
    report.not_checked.push("pane health: poll delivery has no pane instrument");
    return finish(null, 1, `tap team`);
  }
  const row = { ...seat, team: ctx.team, handle, status: seat.status ?? "active", delivery: "pane" } as RegistryRow;
  try {
    const socket = tmuxReadOnly(["display-message", "-p", "#{socket_path}"]);
    const socketPath = socket.code === 0 && socket.stdout.trim().startsWith("/") ? socket.stdout.trim() : "";
    if (seat.server_socket && (!socketPath || socketPath !== seat.server_socket)) {
      report.not_checked.push("pane health: server socket unobservable or different from registration");
      return finish(null, 1, "tap team");
    }
    let observationError = "";
    const observed = observe([row], scriptsDir, false, message => { observationError += message; });
    const lifecycle = observedRows([row], observed.rows, observed.serverEpoch, {}, socketPath)[0]!;
    add("lifecycle", "status", lifecycle.status);
    add("lifecycle", "reason", lifecycle.statusReason);
    const unchanged = (): boolean => JSON.stringify(currentSeat(ctx.registryPath, handle)) === JSON.stringify(seat);
    if (observed.code !== 0 || lifecycle.status === "unknown") {
      report.not_checked.push(`lifecycle: ${lifecycle.statusReason || humanLine(observationError) || "observation failed"}`);
      return finish(null, 1, "tap team");
    }
    if (lifecycle.status === "gone" && ["session_absent", "pane_absent"].includes(lifecycle.statusReason)) {
      if (!unchanged()) { report.not_checked.push("seat binding changed during observation"); return finish(null, 1); }
      return finish("gone", 2, `tap session resume ${handle}`);
    }
    if (lifecycle.status !== "active" || !lifecycle.observedPaneId) {
      report.not_checked.push(`pane health: ${lifecycle.status}/${lifecycle.statusReason}`);
      return finish(null, 1, "tap team");
    }
    add("lifecycle", "pane_id", lifecycle.observedPaneId);
    add("lifecycle", "server_epoch", lifecycle.observedServerEpoch);
    const before = harnessEvidence(lifecycle.harness, seat, process.env, true);
    const sampled = withAgentStates([lifecycle], { team: ctx.team, now: Date.now() / 1000, computeJobs: () => {
      // `compute queue` can initialize/migrate its database even on a read.
      report.not_checked.push("compute queue: read-only observation unavailable");
      return [];
    } })[0]!;
    const after = harnessEvidence(lifecycle.harness, seat, process.env, true);
    // Re-resolve by name after the capture; a stable numeric pane id alone is not identity.
    const second = observe([row], scriptsDir, false, () => {});
    const latest = observedRows([row], second.rows, second.serverEpoch, {}, socketPath)[0]!;
    if (!unchanged() || second.code !== 0 || latest.status !== "active"
      || latest.observedPaneId !== lifecycle.observedPaneId || latest.observedServerEpoch !== lifecycle.observedServerEpoch) {
      report.not_checked.push("seat binding changed or became unobservable during observation");
      return finish(null, 1);
    }
    const firstPid = observed.panePids?.get(lifecycle.observedPaneId), lastPid = second.panePids?.get(latest.observedPaneId);
    if (firstPid && firstPid === lastPid && /^\d+$/.test(firstPid) && socketPath) {
      snapshot = { binding: { team: ctx.team, handle, registry: ctx.registryPath, pane: lifecycle.pane,
        paneId: lifecycle.observedPaneId, session: text(seat.session), instance: text(seat.instance), harness: lifecycle.harness,
        processPid: firstPid, serverSocket: socketPath, serverEpoch: lifecycle.observedServerEpoch, nativeSessionId: text(seat.harness_session_id) },
        seat: { ...seat }, busHome: ctx.bus.home, root: ctx.root };
    }
    add("pane", "agent_state", sampled.agentState);
    try {
      const protection = readInputProtection(lifecycle.observedPaneId, lifecycle.observedServerEpoch);
      if ((protection?.stopUntil ?? 0) > Date.now()) add("delivery", "operator_hold", protectionDetail(protection!));
    } catch { report.not_checked.push("operator hold: input protection unreadable"); }
    add("pane", "rule", sampled.agentStateReason);
    if (["capture_failed", "lifecycle_unreadable", "no_pane", "unrecognized_harness"].includes(sampled.agentStateReason)) {
      report.not_checked.push(`pane health: ${sampled.agentStateReason}`);
      return finish(null, 1);
    }
    const now = Date.now() / 1000;
    const valid = (ev: HarnessEvidence | null): ev is HarnessEvidence => ev !== null && Number.isFinite(ev.lastActivity) && ev.lastActivity >= 0 && ev.lastActivity <= now;
    const progress = valid(before) && valid(after) && after.lastActivity > before.lastActivity;
    let age: number | null = null;
    if (valid(after)) {
      age = Math.max(0, Math.floor(now - after.lastActivity));
      add("harness", "last_activity_at", new Date(after.lastActivity * 1000).toISOString());
      add("harness", "instrument", lifecycle.harness.startsWith("opencode") ? "session_message" : "session_transcript");
      add("harness", "last_activity_age_seconds", age);
      add("harness", "turn_ended", after.ended);
      add("harness", "progress_during_observation", progress);
    } else report.not_checked.push("harness progress: no readable session-bound instrument");
    if (sampled.turnStartedAt != null) add("pane", "turn_elapsed_seconds", Math.max(0, Math.floor(now - sampled.turnStartedAt)));
    if (sampled.waitingOn?.length) add("roster", "waiting_on", sampled.waitingOn);
    if (sampled.contextUsedPercent != null) add("pane", "context_used_percent", sampled.contextUsedPercent);
    report.not_checked.push("wedge discriminator: no proven interval signature");
    const state = sampled.agentState;
    if (state === "blocked") {
      const action = sampled.agentStateReason === "codex-update-available" ? `attach to ${handle} and choose Skip`
        : sampled.agentStateReason === "shell_mode" ? `attach to ${handle} and leave OpenCode shell mode`
        : sampled.agentStateReason === "sign_in" ? `attach to ${handle} and sign in to the harness`
        : `tap attach ${handle}`;
      return finish("parked-on-dialog", 2, action);
    }
    if (state === "error") return finish("severed", 2, `tap peek ${handle}`);
    if (state !== "idle" && state !== "working" && state !== "waiting") return finish("unknown", 2);
    const processed = processedAfterUnverified(ctx.bus.home, ctx.team, handle, seat, now, report.not_checked);
    if (processed) { report.evidence.push(processed); return finish("unverified-but-processing", 0, "do not interrupt; inspect the delivery receipts"); }
    if (state === "waiting" || progress) return finish("thinking", 0, "allow the current work to continue");
    if (state === "working" || (valid(after) && !after.ended)) {
      const bound = stallBoundSeconds(process.env);
      add("readiness", "borrowed_attention_bound_seconds", bound);
      return finish("busy-unproven", age !== null && age >= bound ? 2 : 0,
        "inspect progress; silence does not authorize interruption");
    }
    return finish("healthy", 0, "none");
  } catch (error) {
    if (!(error instanceof ServerUnresponsive) && !(error instanceof TapError)) throw error;
    report.not_checked.push(`observation failed: ${humanLine(error.message)}`);
    return finish(null, 1, "tap team");
  }
}

export function cmdSeatDoctor(handle: string, json: boolean, scriptsDir: string): number {
  const { report, code } = checkSeat(handle, scriptsDir);
  if (json) console.log(JSON.stringify(report));
  else {
    console.log(`${handle}: ${report.verdict ?? "not checked"}`);
    for (const entry of report.evidence) console.log(`  ${entry.source}.${entry.fact}: ${humanLine(typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value))}`);
    for (const missing of report.not_checked) console.log(`  not checked: ${humanLine(missing)}`);
    if (report.action !== "none") console.log(`  next: ${humanLine(report.action)}`);
  }
  return code;
}
