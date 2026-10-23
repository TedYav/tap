import { inheritedActor } from "./context";
// Aged unsettled-inbound reducer and dispatcher advisory.
//
// Enumeration is the same current-team / current-recipient-instance filter as
// native `cmdPoll` (`verbs/poll.ts`). Age uses the id's embedded stamp against
// injected `nowEpoch` — never wall clock, never file mtime. This function is
// silent and read-only: no bus writes, and no stderr. Future-stamp warnings are
// returned to the dispatcher so it can render them without walking the bus a
// second time.
//
// Both dispatchers share poll's current-recipient-instance gate. A predecessor-
// bound obligation cannot be cleared by the current seat and must not produce
// a remedy telling that seat to poll it (tap-xxq4).

import { readFileSync } from "node:fs";

import { callingPane, resolveContext, resolveSelf, type Context } from "./context";
import { envelopeField, validateEnvelope } from "./envelope";
import { ageNowEpoch, idAgeSeconds } from "./ids";
import { currentInstance, loadRegistry, seatMap } from "./registry";

export interface OverdueInbound {
  count: number;
  oldestSec: number;
  warnings: string[];
}

/**
 * Count unsettled inbound for `handle` whose id-stamp age is >= `thresholdSec`.
 *
 * `oldestSec` is 0 when `count` is 0.
 */
export function overdueInbound(
  ctx: Context,
  handle: string,
  thresholdSec: number,
  nowEpoch: number,
): OverdueInbound {
  let count = 0;
  let oldestSec = 0;
  const warnings: string[] = [];
  let myInstance: string | undefined;
  for (const id of ctx.bus.canonicalIds()) {
    if (ctx.bus.isDone(id)) continue;
    let raw: string;
    try {
      raw = readFileSync(ctx.bus.payloadPath(id), "utf8");
    } catch {
      continue;
    }
    if (!validateEnvelope(raw).ok) continue;
    if (envelopeField(raw, "id") !== id) continue;
    if (envelopeField(raw, "to") !== handle) continue;
    const toTeam = envelopeField(raw, "to_team");
    if (toTeam && toTeam !== ctx.team) continue;
    const boundInstance = envelopeField(raw, "recipient_instance");
    if (boundInstance) {
      myInstance ??= currentInstance(ctx.registryPath, handle);
      if (!myInstance || myInstance !== boundInstance) continue;
    }
    const age = idAgeSeconds(id, nowEpoch, warning => warnings.push(warning));
    if (age === null || age < thresholdSec) continue;
    count += 1;
    if (age > oldestSec) oldestSec = age;
  }
  return { count, oldestSec, warnings };
}

const OVERDUE_THRESHOLD_SECONDS = 3600;

export function advisoryEligible(argv: string[], env: NodeJS.ProcessEnv): boolean {
  const verb = argv[0] ?? "";
  // The retired done tombstone answers without reading any bus, registry or pane.
  if (!verb || verb === "done" || verb === "help" || verb === "-h" || verb === "--help" || verb === "show" || verb === "provenance" || verb === "who") return false;
  if (verb === "session" && argv[1] === "complete") return false;
  if (verb === "completion") return false;
  return env.TAP_VERBOSE === "1" || verb === "poll" || verb === "outstanding";
}

function dischargeableHandle(registryPath: string, handle: string): boolean {
  try {
    const row = seatMap(loadRegistry(registryPath))[handle];
    if (!row || String(row.status ?? "active") !== "active" || row.status_reason === "launching") return false;
    return row.delivery === "poll" || typeof row.pane === "string" && row.pane.length > 0;
  } catch {
    return false;
  }
}

/** Best-effort pre-dispatch warning. It never changes the invoked verb's result. */
export function warnOverdueInbound(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  nowEpoch = ageNowEpoch(env),
): void {
  if (!advisoryEligible(argv, env)) return;
  try {
    const ctx = resolveContext(process.cwd(), env);
    let handle = "";
    const pane = callingPane(env);
    if (pane) {
      try { handle = resolveSelf(ctx, pane, 2, env).handle; }
      catch { /* TAP_SELF remains the incumbent's best-effort fallback. */ }
    }
    const inherited = handle ? "" : inheritedActor(env);
    if (!handle && inherited && dischargeableHandle(ctx.registryPath, inherited)) handle = inherited;
    if (!handle) return;

    const result = overdueInbound(ctx, handle, OVERDUE_THRESHOLD_SECONDS, nowEpoch);
    for (const warning of result.warnings) process.stderr.write(warning);
    if (result.count > 0) {
      process.stderr.write(
        `tap: warning: ${handle} has ${result.count} unsettled inbound aged >=${OVERDUE_THRESHOLD_SECONDS}s ` +
        `(oldest ${result.oldestSec}s); run 'tap poll ${handle}'\n`,
      );
    }
  } catch {
    // Advisory only: context and registry failures belong to the invoked verb.
  }
}
