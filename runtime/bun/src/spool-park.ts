// The park TRANSACTION: what `tap_spool_park_placed` did between taking the
// entry's claim and releasing it (lane A, batch 2, slice A1b, unit U1). A
// placed canonical payload becomes a spool pair (payload + metadata) under
// the `.claim` the drain also needs, and the canonical copy is retired under
// that same claim — a post-publication file check alone races the drain's
// move back to canonical and can erase a message already delivered (.82).
//
// What stays in Bash, by design and not by inertia: the choreography AFTER
// the transaction — the pane cue (B's `tap_pane_effect_flash`), the deliverer
// spawn (A3's `tap_spool_spawn_deliverer`), the backlog condition and the
// receipts — moves with the deliverer loop (A3), which owns those seams.
// Every decided outcome here is a VERDICT at exit 0 (`ok`, `spool_busy`,
// `spool_publish_failed`), the shape `claimAcquire`'s adapter already reads;
// exit 1 is reserved for the runtime boundary (`slice_failed`).
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

import { deliveryClockRead } from "./delivery-clock";
import { deliveryWindowSeconds } from "./digest-window";
import { envelopeField } from "./envelope";
import { markResetGenerationReused } from "./reset";
import { PublishError, publishPair } from "./spool-publication";
import { type ClaimToken, claimAcquire, claimRelease, metaField, metaPath } from "./spool-sidecar";

export interface ParkInput {
  spoolDir: string;
  /** `$TAP_HOME`: the reset-generation record lives beside the spool. */
  home: string;
  id: string;
  canonical: string;
  target: string;
  /** `tap_spool_team_name`: the acting team, resolved by the caller (empty fails closed there). */
  acting: string;
  reason: string;
  timeoutSeconds: string;
  pane: string;
  paneId: string;
  toTeam: string;
  targetRegistry: string;
  policy: string;
  graceSeconds: string;
  cueStyle: string;
  cueRedAt: string;
  /** A direct submit-unverified hold keeps its canonical for the rc 5 contract. */
  retainCanonical?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  lockTimeoutMs?: number;
}

export interface Parked { payload: string; meta: string; deadlineEpoch: string }
/** Test seams only: `afterPublish` runs once the pair is on disk, before it is verified. */
export interface ParkHooks { afterPublish?(payload: string, meta: string): void }

/**
 * Test-only process interruption between publication and the canonical unlink
 * (the interval `spool-publication-binding.test.sh` drains in — tap-7r3fn.82),
 * the shape `verbs/out.ts` and `verbs/done.ts` use: a path base under
 * TAP_SCRATCH_ONLY, `.ready` written here, `.continue` awaited.
 */
function parkBarrier(): void {
  const path = process.env.TAP_PARK_TEST_BARRIER;
  if (!path || !process.env.TAP_SCRATCH_ONLY) return;
  writeFileSync(`${path}.ready`, "canonical-unlink");
  const deadline = Date.now() + 20000;
  while (!existsSync(`${path}.continue`) && Date.now() < deadline) Bun.sleepSync(10);
  if (!existsSync(`${path}.continue`)) throw new Error("park scratch barrier timed out");
}

/** A decided refusal: the claim is already released; the canonical payload is retained. */
export class ParkRefusal extends Error {
  constructor(public readonly klass: "spool_busy" | "spool_publish_failed", detail: string) { super(detail); }
}

function isRegularFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/**
 * `tap_spool_park_placed`'s transaction, in the incumbent's order and with its
 * messages: create the spool; take the claim (`held` is `spool_busy`); publish
 * the pair (window and last-delivered resolved the way `tap_spool_add` resolved
 * them — the envelope's `reply`, the recipient's window through the digest
 * config, the delivery clock's last verified epoch); refuse an incomplete
 * pair; mark the reset generation reused; read the deadline; retire the
 * canonical copy; release the claim. Every refusal releases the claim first.
 */
export function parkPlaced(input: ParkInput, hooks?: ParkHooks): Parked {
  if (input.retainCanonical && input.reason !== "staged-idle") {
    throw new ParkRefusal("spool_publish_failed", "only a staged-idle hold may retain the canonical payload");
  }
  const env = input.env ?? process.env;
  try { mkdirSync(input.spoolDir, { recursive: true }); }
  catch { throw new ParkRefusal("spool_publish_failed", "cannot create spool; canonical payload retained"); }
  const claim = claimAcquire(input.spoolDir, input.id, false, env);
  if (claim.status !== "acquired") {
    throw new ParkRefusal("spool_busy", "spool entry is claimed; canonical payload retained");
  }
  const fail = (detail: string): never => {
    claimRelease(input.spoolDir, input.id, claim.token);
    throw new ParkRefusal("spool_publish_failed", detail);
  };
  try {
    return underClaim(input, env, fail, claim.token, hooks);
  } catch (error) {
    // A decided refusal already released. Anything else is the runtime boundary
    // (`slice_failed`, exit 1): release rather than leave a claim to go stale —
    // the incumbent, under `set -e`, left it (a declared delta).
    if (!(error instanceof ParkRefusal)) claimRelease(input.spoolDir, input.id, claim.token);
    throw error;
  }
}

function underClaim(input: ParkInput, env: NodeJS.ProcessEnv, fail: (detail: string) => never, token: ClaimToken, hooks?: ParkHooks): Parked {
  let payload: string;
  try {
    // `tap_envelope_field "$CANON" reply`, empty when absent; the window reader defaulted "" to "expected".
    let reply = "";
    try { reply = envelopeField(readFileSync(input.canonical, "utf8"), "reply") ?? ""; } catch { reply = ""; }
    const policy = input.policy || "standard";
    const team = input.toTeam || input.acting;
    const windowSeconds = deliveryWindowSeconds(policy, team, input.target, reply || "expected", input.acting, env);
    // `tap_delivery_clock_read` discarded every failure into "" (due now).
    let lastDelivered = "";
    try { lastDelivered = deliveryClockRead(input.targetRegistry, input.target); } catch { lastDelivered = ""; }
    payload = publishPair({
      spoolDir: input.spoolDir, id: input.id, canonical: input.canonical, target: input.target, team: input.acting,
      reason: input.reason, reasonClass: "", timeoutSeconds: input.timeoutSeconds, pane: input.pane, paneId: input.paneId,
      toTeam: input.toTeam, policy, graceSeconds: input.graceSeconds, targetRegistry: input.targetRegistry,
      windowSeconds, lastDelivered, cueStyle: input.cueStyle, cueRedAt: input.cueRedAt,
      env, now: input.now, lockTimeoutMs: input.lockTimeoutMs,
    });
    hooks?.afterPublish?.(payload, metaPath(input.spoolDir, input.id));
  } catch (error) {
    if (error instanceof ParkRefusal) throw error;
    // The publication module printed its own `tap: …` line when it ran as a process; in-process, print the same line.
    process.stderr.write(`tap: ${error instanceof PublishError ? error.message : String(error)}\n`);
    return fail("spool publication failed; canonical payload retained");
  }
  const meta = metaPath(input.spoolDir, input.id);
  if (!isRegularFile(payload) || !isRegularFile(meta)) return fail("spool publication is incomplete; canonical payload retained");
  markResetGenerationReused(input.home, "spool");
  const deadlineEpoch = metaField(input.spoolDir, input.id, "deadline_epoch");
  parkBarrier();
  // An ordinary pre-effect park transfers custody to spool. A direct send
  // whose submit is unverified keeps the canonical visible to poll/doctor;
  // only its staged-idle spool copy may later license one Enter, never a paste.
  if (!input.retainCanonical) {
    try { rmSync(input.canonical, { force: true }); }
    catch { return fail("spool published but canonical cleanup failed"); }
  }
  claimRelease(input.spoolDir, input.id, token);
  return { payload, meta, deadlineEpoch };
}

// --- CLI ------------------------------------------------------------------
//   park <spool> <home> <id> <canonical> <target> <acting> <reason> <timeout> <pane> <pane_id> <to_team> <registry> <policy> <grace> <cue_style> <cue_red_at>
// stdout, one verdict per run at exit 0:
//   ok\n<payload>\n<meta>\n<deadline_epoch>\n
//   spool_busy\n<detail>\n            spool_publish_failed\n<detail>\n
export function main(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  const [verb, ...rest] = argv;
  if (verb !== "park" || rest.length !== 16) {
    process.stderr.write("spool-park: expected park with 16 positional facts\n");
    return 2;
  }
  const at = (i: number): string => rest[i] ?? "";
  try {
    const parked = parkPlaced({
      spoolDir: at(0), home: at(1), id: at(2), canonical: at(3), target: at(4), acting: at(5), reason: at(6), timeoutSeconds: at(7),
      pane: at(8), paneId: at(9), toTeam: at(10), targetRegistry: at(11), policy: at(12), graceSeconds: at(13), cueStyle: at(14), cueRedAt: at(15), env,
    });
    process.stdout.write(`ok\n${parked.payload}\n${parked.meta}\n${parked.deadlineEpoch}\n`);
    return 0;
  } catch (error) {
    if (error instanceof ParkRefusal) { process.stdout.write(`${error.klass}\n${error.message}\n`); return 0; }
    process.stderr.write(`tap: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

// Let the rows drain: a forced exit cuts a pending pipe write at 64 KiB (the
// drain rule: 250 pairs through a slow pipe = 122 rows, exit 0,
// and both drain projections skip the torn tail without a failed status). A
// reader that went away surfaces on the stream after `main` returns: exit 1, one line.
if (import.meta.main) {
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    process.stderr.write(`tap spool-park: stdout ${error.code ?? error.message}\n`);
    process.exitCode = 1;
  });
  process.exitCode = main(Bun.argv.slice(2));
}
