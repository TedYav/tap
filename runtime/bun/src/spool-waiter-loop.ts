// Per-entry scheduling only. The native spool engine owns delivery decisions.
import { readFileSync, lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, requireResolvedBus, resolveBus } from "./bushome";
import { spoolTeamName } from "./context";
import { appendRegistryEventOrWarn } from "./events";
import { validId } from "./ids";
import { pythonInt } from "./pyint";
import { waiterScope } from "./slices/waiter-scope";
import { registryMatchesTeam } from "./spool-deadline";
import { heldSpoolClass } from "./spool-grace";
import { pyFloatString, pyReadUtf8, pyTruthy } from "./spool-publication";
import { reownClaim, reownRefresh, reownRelease } from "./spool-reown";
import { reparkStranded, retryRepark } from "./spool-repark";
import { metaPath, payloadPath } from "./spool-sidecar";
import { scheduleProbe } from "./spool-state";
import { pendingReprobe } from "./submit-phase";
import { atLeast, BUN_FLOOR } from "./watch-run";
import { spoolEngineCommand } from "./spool-engine";
import { seatMap, loadCurrentRegistry } from "./registry";
import { capturePane, tmuxReadOnly } from "./tmux";
import { acquirePaneLock } from "./panelock";
import { observePaneResult } from "./tmux";
import { paneState } from "./pane-state";
import { updateInputProtection, readInputProtection, protectionUntil, observeUntilDraftEnds } from "./input-protection";
import { emitWaitCue } from "./wait-cues";
import { envelopeField } from "./envelope";
import { observedBand } from "./spool-readiness";

type Meta = Record<string, unknown>;
function readMeta(path: string): Meta | null {
  try {
    const value = JSON.parse(pyReadUtf8(path));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}
function isFile(path: string): boolean { try { return statSync(path).isFile(); } catch { return false; } }
function number(value: unknown): number {
  const n = typeof value === "string" ? pyFloatString(value)
    : typeof value === "number" || typeof value === "boolean" ? Number(value) : null;
  if (n === null || !Number.isFinite(n)) throw new Error("invalid time");
  return n;
}

/** Present unknown lifetime values never inherit deadline_source ownership. */
export function waiterDeadline(meta: Meta | null): number {
  if (!meta) return 0;
  const owned = Object.hasOwn(meta, "waiter_lifetime")
    ? ["readiness-gate", "autosettle-hold", "grace-window", "window"].includes(meta.waiter_lifetime as string)
    : ["readiness-gate", "autosettle-hold"].includes(meta.deadline_source as string);
  if (!owned || !pyTruthy(meta.deadline_epoch)) return 0;
  try {
    const value = meta.deadline_epoch;
    return typeof value === "string" ? Number(pythonInt(value, true) ?? 0n) : Math.trunc(number(value));
  } catch { return 0; }
}

/** Cadence truncated to the next drain boundary; unreadable facts retain cadence. */
export function deliveryWait(delay: number, meta: Meta | null, now: number): number {
  try {
    if (!meta) return delay;
    const deadline = number(meta.deadline_epoch);
    const boundaries = [deadline];
    if (now < deadline - 10) boundaries.push(deadline - 10);
    if (meta.hold_until_epoch != null && number(meta.hold_until_epoch) > now) boundaries.push(number(meta.hold_until_epoch));
    if (meta.policy === "polite") {
      const degrade = number(meta.first_spooled_epoch) + number(meta.timeout_seconds);
      if (degrade > now) boundaries.push(degrade);
    }
    return Math.max(0, Math.min(delay, Math.min(...boundaries) - now));
  } catch { return delay; }
}

export async function runWaiter(input: {
  argv: string[]; scriptsDir: string; env?: NodeJS.ProcessEnv;
  refresh: (last: string, remaining: string[], token: string) => { status: number } | null;
  /** Read-only pane seam: null is not clear; a key names the observed binding. */
  draftProbe?: () => string | null;
}): Promise<number> {
  const env = { ...(input.env ?? process.env) };
  const [id, ...args] = input.argv;
  if (!id || !validId(id)) { process.stderr.write("tap spool waiter: valid id required\n"); return 2; }
  const home = requireResolvedBus(resolveBus(repoRoot(), env));
  env.TAP_HOME = home;
  const spool = join(home, "spool"), meta = metaPath(spool, id), payload = payloadPath(spool, id);
  let token = env.TAP_SPOOL_REOWN_TOKEN || "";
  const release = () => { if (token) reownRelease(spool, id, token, env); };
  let engine: Bun.Subprocess | undefined, stopping = false;
  let protectedPane = "", protectedEpoch = "";
  const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(signal => {
    const stop = () => {
      stopping = true;
      if (engine && engine.exitCode === null) {
        // Only this parent's live child group is stop authority. Include the shell's
        // foreground helpers; otherwise they can keep writing after the waiter exits.
        try { process.kill(-engine.pid, signal); } catch { /* raced child exit */ }
      } else { release(); process.exit(0); }
    };
    process.on(signal, stop);
    return [signal, stop] as const;
  });
  try {
    // Even an unsupported runtime or an entry gone before startup must release its inherited lease.
    if (!atLeast(Bun.version, BUN_FLOOR) || typeof process.execve !== "function") {
      process.stderr.write(`tap spool waiter: needs bun ${BUN_FLOOR} or newer (process.execve); this is ${Bun.version}\n`);
      return 1;
    }
    let resume = args[0] === "--resume-cadence";
    let last = resume ? args[1] ?? "" : "15";
    const remaining = resume ? args.slice(2) : (env.TAP_SPOOL_DELIVERER_DELAYS || "0.25 0.5 1 2 4 8 15").trim().split(/\s+/).filter(Boolean);
    for (const delay of [last, ...remaining]) {
      // Invalid cadence must fail instead of creating an immortal hot waiter.
      if (number(delay) < 0) throw new Error("negative cadence");
    }
    // Live: a parked body, or a repark the drain could not perform (tap-conft), whose
    // body waits in payloads/ for this waiter to move it back.
    const live = () => isFile(payload) || reparkStranded(spool, id);
    if (!live()) return 0;
    const binding = readMeta(meta);
    const fields = [binding?.target ?? "", binding?.target_registry ?? "", binding?.to_team ?? ""];
    const wellFormed = binding !== null && fields.every(v => typeof v === "string" && !/[\x00-\x1f\x7f]/.test(v));
    const [target, registry, team] = fields as string[];
    const scope = wellFormed ? waiterScope({ target: target!, targetRegistry: registry!, registryMatchesTeam: registryMatchesTeam(registry!, team!) }) : null;
    if (!scope?.ok) {
      const reason = scope?.refusal ?? "slice_failed";
      process.stderr.write(`tap: waiter_scope_refused id=${id} reason=${reason}\n`);
      appendRegistryEventOrWarn("tap", { log: join(home, "registry-events.log"), actor: "courier", action: "waiter_scope_refused",
        handle: id, pane: "", team: spoolTeamName(home, env.TAP_INDEX_HOME), detail: `reason=${reason}`, env });
      return 1;
    }
    const possibleAttempt = (): boolean => {
      try { lstatSync(join(home, "receipts", `${id}.attempted`)); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
    };
    const held = (): boolean => {
      const current = readMeta(meta);
      return current !== null && heldSpoolClass(current, possibleAttempt(), typeof current.id === "string" && !!current.id && pendingReprobe(home, current.id));
    };
    let protectionDeadline = 0;
    const draftProbe = input.draftProbe ?? (() => {
      const current = readMeta(meta);
      try {
        const row = seatMap(loadCurrentRegistry(scope.targetRegistry))[scope.target];
        const pane = row?.pane_id, harness = row?.harness;
        if (typeof pane !== "string" || !pane || typeof harness !== "string" || !harness ||
            (row?.status ?? "active") !== "active" || row.delivery === "poll") return null;
        const lock = acquirePaneLock(pane, 0, env);
        if (!lock) return null;
        try {
          const observed = observePaneResult(pane, env);
          if (observed.status !== "ok" || observed.observation.serverEpoch !== row.server_epoch) return null;
          const mode = tmuxReadOnly(["display-message", "-p", "-t", pane, "#{pane_in_mode}"], env).stdout.trim();
          if (mode !== "0" && mode !== "1") return null;
          const band = mode === "1" ? { state: "unobservable" as const, reason: "copy-mode" }
            : paneState(pane, harness, observed.observation.currentCommand);
          let raw = ""; try { raw = readFileSync(payload, "utf8"); } catch { /* disappearing mail */ }
          protectedPane = pane; protectedEpoch = observed.observation.serverEpoch;
          const state = updateInputProtection(observed.observation, band, { env, harness,
            urgent: envelopeField(raw, "urgency") === "urgent", sender: envelopeField(raw, "from") ?? "",
            message: raw ? { home, id, sender: envelopeField(raw, "from") ?? "" } : undefined });
          // The waiter's own poll carries the snooze cues: BLUE at the latch, then
          // GREEN/RED as the deadline nears — claimed once in the pane-shared record.
          if (state && state.snoozeUntil > Date.now()) emitWaitCue(pane, { pane, home, ownerId: id, env });
          protectionDeadline = state ? protectionUntil(state) : 0;
          if (state && protectionDeadline > Date.now()) return null;
          if (band.state !== "ready") return null;
          return JSON.stringify([row.instance, pane, row.server_epoch]);
        } finally { lock.release(); }
      } catch { return null; }
    });
    const helperNow = () => env.TAP_SPOOL_NOW && /^[0-9]+$/.test(env.TAP_SPOOL_NOW) ? Number(env.TAP_SPOOL_NOW) : Date.now() / 1000;
    if (held()) {
      if (token) { if (!reownRefresh(spool, id, token, helperNow(), env)) return 0; }
      else { token = reownClaim(spool, id, env.TAP_SPOOL_REOWN_LEASE_SECONDS || "20", helperNow(), env) || ""; if (!token) return 0; }
    }
    // Retry only the move back, bounded, holding no lock across a pause. Never a submit.
    const recoverRepark = async (): Promise<number | null> => {
      let outcome = "";
      for (const pause of (env.TAP_SPOOL_REPARK_DELAYS || "1 2 4 8 15 30 30 30").trim().split(/\s+/)) {
        await Bun.sleep(number(pause) * 1000);
        if (stopping) return 0;
        if (token && !reownRefresh(spool, id, token, helperNow(), env)) return 0;
        outcome = retryRepark(home, id, env, 1000);
        if (outcome !== "busy") break;
      }
      if (outcome === "reparked") return null;
      if (outcome !== "settled") {
        process.stderr.write(`tap: spool repark for '${id}' not retried further — ${outcome}; body stays in payloads/\n`);
        appendRegistryEventOrWarn("tap", { log: join(home, "registry-events.log"), actor: "courier", action: "spool_repark_abandoned",
          handle: scope.target, pane: "", team: spoolTeamName(home, env.TAP_INDEX_HOME), detail: `id=${id} reason=${outcome}`, env });
      }
      return 0;
    };
    while (live()) {
      if (!isFile(payload)) {
        const exit = await recoverRepark();
        if (exit !== null) return exit;
        continue;
      }
      const delayText = resume ? last : remaining.shift() ?? last;
      last = delayText;
      const delay = number(delayText);
      if (!input.draftProbe && !possibleAttempt()) draftProbe();
      const parkedMeta = readMeta(meta);
      const wait = resume ? 0 : deliveryWait(delay, protectionDeadline > 0
        ? { ...parkedMeta, deadline_epoch: protectionDeadline / 1000 } : parkedMeta, Date.now() / 1000);
      resume = false;
      try { scheduleProbe(spool, id, String(wait), helperNow(), env); } catch { /* best effort, as before */ }
      if (wait > 0) {
        const parked = readMeta(meta);
        if (parked?.reason === "pending-input" && (waiterDeadline(parked) > helperNow() || protectionDeadline > Date.now()) && !possibleAttempt()) {
          const until = Date.now() + wait * 1000;
          let previous: string | null = null;
          while (Date.now() < until) {
            if (stopping || !live() || possibleAttempt()) return 0;
            if (readMeta(meta)?.reason !== "pending-input") {
              await Bun.sleep(Math.max(0, until - Date.now()));
              break;
            }
            const sampledAt = Date.now();
            const clear = draftProbe();
            if (protectionDeadline > 0 && Date.now() >= protectionDeadline) break;
            if (clear !== null && clear === previous) break;
            previous = clear;
            await Bun.sleep(Math.max(0, Math.min(sampledAt + 250, until) - Date.now()));
          }
        } else await Bun.sleep(wait * 1000);
      }
      if (stopping || !live()) return 0;
      if (!isFile(payload)) continue;
      const refreshed = input.refresh(last, remaining, token);
      if (refreshed) return refreshed.status;
      if (held() && token && !reownRefresh(spool, id, token, helperNow(), env)) return 0;
      const started = Math.floor(Date.now() / 1000);
      // Exactly one native drain per tick. The same scoped slice and child-group
      // cancellation boundary survive; capture and submit/custody stay retained.
      engine = Bun.spawn(spoolEngineCommand(input.scriptsDir, "drain", "", "", scope.target, scope.targetRegistry),
      { env, detached: true, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      const rc = await engine.exited;
      engine = undefined;
      if (stopping) return 0;
      // A repark this drain (or a sibling's scoped drain) could not perform: recovered at the loop's top.
      if (reparkStranded(spool, id)) continue;
      if (rc === 1) return 1;
      if (!isFile(payload)) return rc === 5 ? 5 : 0;
      const current = readMeta(meta);
      if (current && pyTruthy(current.escalated_at)) return 0;
      const deadline = protectionDeadline > 0 ? protectionDeadline / 1000 : waiterDeadline(current);
      if (deadline !== 0 && Math.floor(Date.now() / 1000) >= deadline && protectionDeadline <= Date.now()) {
        // A drain that crossed expiry still owes one post-expiry tick. Reuse this cadence
        // value, refresh again, and let that tick be the final boundary observation.
        if (started < deadline) { resume = true; continue; }
        await Bun.sleep(delay * 1000);
      }
      if (deadline === 0 && remaining.length === 0) return 0;
    }
    return 0;
  } finally {
    for (const [signal, stop] of handlers) process.off(signal, stop);
    release();
    if (!stopping && !isFile(payload) && protectedPane && protectedEpoch) {
      try { await observeUntilDraftEnds(protectedPane, protectedEpoch, env); }
      catch { /* Observation cannot change a completed delivery result. */ }
    }
  }
}
