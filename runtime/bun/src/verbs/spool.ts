// Native spool inspection and sender cancellation. The dormant owner and its
// startup conversion are retired; these verbs never start delivery.
//
// Bus context follows `tap poll`'s discipline exactly: an env-named bus
// (TAP_HOME) passes, a cwd-derived bus WITH an acting registry passes — the
// normal current-team context — and only an unanchored cwd bus refuses
// (pre-freeze anchor 1).
//
// Reader contract: `list` and `status` emit ONE JSON object per line over the
// SAME unsettled-live denominator (anchor 4), so the crash window after a
// durable `.cancelled` but before intent removal reports zero backlog
// everywhere. `status` reads `spool/owner.json` DIAGNOSTICALLY and never
// touches `spool/owner.lock`, never spawns, never probes a pane (KTD10 /
// ledger S3 round 2).
//
// `cancel <id>` is the SENDER's withdrawal (anchor 2): the actor is resolved
// through the shared path `--by` > `TAP_SELF` > calling pane, and must be
// eligible against the canonical payload's
// own envelope (`from`, `sender_instance`) — impersonation refuses, and a
// missing or unreadable canonical refuses fail-closed because no eligibility
// evidence exists. Reset mutation custody is taken after syntax/actor
// prevalidation and held through `.cancelled` + intent removal; `ensureDirs`
// runs only under that lock so a fence cannot archive the bus after a
// directory bootstrap. The obligation lock follows reset custody, matching
// reply; native send takes obligation first and reset after pane observe.
// The receipt carries incumbent provenance (anchor 3) and `.done`
// is never written for bytes the recipient never received.

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { TapError, requireActingRegistry, resolveContext, type Context } from "../context";
import { envelopeField, validateEnvelope } from "../envelope";
import { atomicWrite } from "../fsatomic";
import { utcStamp, validId, validToken } from "../ids";
import { lockRoot, acquireObligationLock } from "../panelock";
import { currentInstance } from "../registry";
import { acquireResetMutationLock, assertResetUnfenced, markResetGenerationReused } from "../reset";
import { isLegacyBashPair, isMalformedExactSlot, listLegacyBashPairIds, listMalformedReport, unsettledLiveIntents } from "../spool";
import { resolveActor } from "./done";
import type { CourierIntent } from "../courier-contract";
import { appendRegistryEventOrWarn, registryEventsPath } from "../events";

function usage(): never {
  throw new TapError(1, "usage_error", "tap help spool", "usage: tap spool list --json [--from <handle>] | status --json | cancel <id> [--by <handle>] [--json]");
}

/**
 * Anchor 4: the ONE denominator every reader uses. A live intent that has a
 * `.done` or a durable `.cancelled` is not backlog — even if its intent file
 * still sits in the spool (the crash window between the receipt write and the
 * intent removal must not re-inflate any reader).
 */
/**
 * The owner pid is READ diagnostically from `spool/owner.json` (KTD1, written
 * by the U6 owner). `alive === null` means no owner record exists — the dark
 * engine's steady state — which is reported as absent, not dead. This never
 * opens `owner.lock` (a read that probed the lock could eat a concurrent
 * writer's spawn — ledger S3 round 2) and never spawns (KTD10).
 */
function ownerDiagnostic(spoolDir: string): { pid: number | null; alive: boolean | null } {
  try {
    const owner = JSON.parse(readFileSync(join(spoolDir, "owner.json"), "utf8")) as { pid?: unknown };
    if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid)) return { pid: null, alive: null };
    try {
      process.kill(owner.pid, 0);
      return { pid: owner.pid, alive: true };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // EPERM names a live-but-unsignallable pid (the fence liveness rule);
      // only ESRCH is proof of death. Anything else is unobservable,
      // not dead.
      if (code === "EPERM") return { pid: owner.pid, alive: true };
      if (code === "ESRCH") return { pid: owner.pid, alive: false };
      return { pid: owner.pid, alive: null };
    }
  } catch {
    return { pid: null, alive: null };
  }
}

/**
 * ONE best-effort event line in the incumbent format (frozen brief v3):
 * `tap_registry_event_append <actor> <action> <handle> <pane> [detail]`, now
 * through the runtime's own writer rather than a shell-out to lib.sh. Failure
 * warns once and neither rolls back nor retries.
 */
function appendQuarantineEvent(busHome: string, team: string, actor: string, id: string): void {
  appendRegistryEventOrWarn("tap spool", {
    log: registryEventsPath(busHome),
    actor, action: "spool_quarantined_malformed", handle: id, pane: "", team,
    detail: "malformed spool intent quarantined by sender cancellation",
  });
}

function emit(row: unknown): void {
  process.stdout.write(`${JSON.stringify(row)}\n`);
}

/**
 * Anchor 2, corrected: EXACT sender authorization, mirroring `done`'s
 * recipient-instance gate with sender polarity. The actor must BE the
 * envelope's `from`. When the canonical stamps `sender_instance`, the actor's
 * CURRENT registry instance must equal that full `handle|generation` string
 * exactly — a fresh seat at the same handle is a different instance and
 * cannot withdraw predecessor-bound mail. Authority is only ever read from a
 * VALID envelope whose own `id` IS the requested id — a malformed canonical,
 * or one minted for a different id, is not evidence of anything and refuses:
 * an unreadable or self-inconsistent record cannot authorize a withdrawal.
 */
function requireSenderEligibility(ctx: Context, actor: string, id: string, canonicalPath: string): { target: string; to_team: string } {
  let raw: string;
  try {
    raw = readFileSync(canonicalPath, "utf8");
  } catch {
    throw new TapError(1, "not_found", "tap spool list", `canonical payload '${canonicalPath}' is unreadable; sender eligibility cannot be established, refusing to cancel`);
  }
  const check = validateEnvelope(raw);
  if (!check.ok) {
    throw new TapError(1, "not_found", "tap spool list", `canonical payload '${canonicalPath}' has an invalid envelope; sender eligibility cannot be established, refusing to cancel`);
  }
  // Canonical-derived provenance (U3.3): the malformed-intent path cannot
  // read to/to_team from the intent, and the live path may as well take them
  // from the same validated authority.
  const canonicalTarget = envelopeField(raw, "to") ?? "";
  const canonicalTeam = envelopeField(raw, "to_team") ?? "";
  if ((envelopeField(raw, "id") ?? "") !== id) {
    throw new TapError(1, "not_found", "tap spool list", `canonical payload names id '${envelopeField(raw, "id")}', not '${id}'; a mismatched canonical cannot authorize this withdrawal`);
  }
  const from = envelopeField(raw, "from") ?? "";
  if (actor !== from) {
    throw new TapError(1, "not_authorized", "tap help spool", `actor '${actor}' is not the sender of this payload (from='${from}'); cancellation is sender-authorized`);
  }
  const boundInstance = envelopeField(raw, "sender_instance");
  if (boundInstance) {
    const mine = currentInstance(ctx.registryPath, actor);
    if (!mine || mine !== boundInstance) {
      throw new TapError(1, "not_authorized", "tap help spool",
        !mine
          ? `this payload is bound to sender instance '${boundInstance}', but the current '${actor}' instance cannot be resolved — an unverified seat cannot withdraw predecessor-bound mail`
          : `this payload is bound to sender instance '${boundInstance}', not the current '${actor}' instance — a fresh seat at this handle cannot withdraw predecessor-bound mail`);
    }
  }
  return { target: canonicalTarget, to_team: canonicalTeam };
}

/** Scratch-only mutation barrier; production callers never enter it. */
function cancelScratchBarrier(stage: string, id: string): void {
  const base = process.env.TAP_OBLIGATION_TEST_BARRIER;
  if (!base || !process.env.TAP_SCRATCH_ONLY || process.env.TAP_OBLIGATION_TEST_ID !== id) return;
  if ((process.env.TAP_OBLIGATION_TEST_STAGE ?? "") !== stage) return;
  writeFileSync(`${base}.${stage}.${process.pid}.reached`, "1\n");
  const release = `${base}.${stage}.release`;
  const deadline = Date.now() + 60_000;
  while (!existsSync(release)) {
    if (Date.now() >= deadline) throw new Error(`cancel ${stage} test barrier timed out`);
    Bun.sleepSync(5);
  }
}

export function cmdSpool(argv: string[], scriptsDir = ""): number {
  const sub = argv[0] ?? "";
  const ctx = resolveContext();
  if (ctx.busRule !== "env") requireActingRegistry(ctx, 1);
  assertResetUnfenced(ctx.bus.home, "tap spool");
  const spoolDir = join(ctx.bus.home, "spool");
  const LEGACY_BASH_DETAIL = "Shared spool parks; use tap cancel --spooled";

  if (sub === "list") {
    ctx.bus.ensureDirs();
    let from = "";
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i]!;
      if (a === "--from") {
        const value = argv[i + 1];
        if (!value) throw new TapError(1, "usage_error", "tap help spool", "--from requires a handle");
        from = value;
        i++;
      } else if (a === "--json") {
        // JSONL is the only planned form; the flag names it for callers and
        // its absence is not license to emit prose a machine would mis-parse.
        continue;
      } else {
        throw new TapError(1, "unknown_option", "tap help spool", `unknown option '${a}'`);
      }
    }
    for (const intent of unsettledLiveIntents(spoolDir, ctx.bus.receiptsDir)) {
      if (from && intent.from !== from) continue;
      emit(intent);
    }
    // Malformed-mail rows carry their own discriminator class — they never
    // pose as CourierIntents — and the scan is report-only (no rename, no
    // lock, no mutation: names+bytes are pinned by control). A --from filter
    // excludes them: an undecodable intent attributes to no sender.
    for (const row of listMalformedReport(spoolDir, ctx.bus.payloadsDir)) {
      if (from) continue;
      emit(row);
    }
    const legacyCount = listLegacyBashPairIds(spoolDir).length;
    if (legacyCount > 0) {
      emit({ class: "legacy_bash_parks", count: legacyCount, detail: LEGACY_BASH_DETAIL });
    }
    return 0;
  }

  if (sub === "status") {
    ctx.bus.ensureDirs();
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i]!;
      if (a !== "--json") throw new TapError(1, "unknown_option", "tap help spool", `unknown option '${a}'`);
    }
    const live = unsettledLiveIntents(spoolDir, ctx.bus.receiptsDir);
    const malformed = listMalformedReport(spoolDir, ctx.bus.payloadsDir);
    const owner = ownerDiagnostic(spoolDir);
    const legacyCount = listLegacyBashPairIds(spoolDir).length;
    emit({
      intents: live.length,
      malformed_count: malformed.length,
      malformed_intents: malformed,
      legacy_bash_parks: legacyCount,
      legacy_bash_parks_note: LEGACY_BASH_DETAIL,
      owner_pid: owner.pid,
      owner_alive: owner.alive,
      owner_note:
        owner.alive === false
          ? "owner: DEAD — inspect queued payloads with tap spool list --json; no public owner restart command is available"
          : owner.alive === null
            ? owner.pid === null
              ? "owner: no record (owner.json absent, unreadable, or without a pid)"
              : `owner: pid ${owner.pid} liveness unobservable`
            : "owner: alive",
    });
    return 0;
  }

  if (sub === "cancel") {
    let id = "";
    let by = "";
    let json = false;
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i]!;
      if (a === "--by") {
        const value = argv[i + 1];
        if (!value) throw new TapError(1, "usage_error", "tap help spool", "--by requires a handle");
        by = value;
        i++;
      } else if (a === "--json") {
        json = true;
      } else if (a.startsWith("--")) {
        // An unknown option is NEVER the id, whatever position it lands in.
        throw new TapError(1, "unknown_option", "tap help spool", `unknown option '${a}'`);
      } else if (!id) {
        id = a;
      } else {
        throw new TapError(1, "usage_error", "tap help spool", `unexpected argument '${a}'`);
      }
    }
    if (!id) usage();
    // PRE-EFFECT VALIDATION, before the obligation lock and any file effect:
    // a malformed id or actor token refuses here, so garbage can never mint
    // lock artifacts or reach the residency checks.
    if (!validId(id)) {
      throw new TapError(1, "usage_error", "tap help spool", `'${id}' is not a valid payload id`);
    }
    // The SHARED actor path (done.ts resolveActor): --by > TAP_SELF >
    // callingPane + resolveSelf — an ordinary interactive cancel with neither
    // flag nor env still resolves its calling pane (anchor 2, corrected).
    const actor = resolveActor(ctx, by);
    if (!actor) {
      throw new TapError(1, "usage_error", "tap help spool", "cancellation requires a sender actor: pass --by <handle>, run with TAP_SELF set, or run from a registered pane");
    }
    if (!validToken(actor)) {
      throw new TapError(1, "usage_error", "tap help spool", `actor '${actor}' is not a valid handle token`);
    }
    // Live bash parks are not native intents. Pair presence alone is the
    // refusal: native residency/terminal checks begin only under the
    // obligation lock, and if both representations ever coexist the bash
    // door still owns delivery. Refuse BEFORE that lock so cancel cannot
    // take custody of bash-drain state.
    if (isLegacyBashPair(spoolDir, id)) {
      throw new TapError(1, "legacy_bash_park", `tap cancel ${id} --spooled --by ${actor}${ctx.team ? ` --team ${ctx.team}` : ""}`, "Bash park — use tap cancel --spooled");
    }
    // Pre-custody crossing: after syntax/actor (and the bash-pair door),
    // before directory bootstrap, obligation, eligibility, or mutation.
    cancelScratchBarrier("cancel-pre-reset-custody", id);
    const lock = acquireObligationLock(id);
    if (!lock) throw new TapError(1, "lock_park", "retry shortly", `another holder owns the obligation lock for '${id}'`);
    try {
      const resetLock = acquireResetMutationLock(ctx.bus.home, "tap spool cancel", undefined, "shared");
      try {
      ctx.bus.ensureDirs();
      // DISTINCT refusals for distinct terminal states — Bus.isDone folds
      // `.cancelled` into done-ness and would erase the difference, but a
      // caller retrying a withdrawal needs "already cancelled", not
      // "already settled".
      if (existsSync(ctx.bus.donePath(id))) {
        throw new TapError(1, "already_settled", "tap outstanding", `'${id}' is already settled (.done exists); a settled send cannot be withdrawn`);
      }
      if (existsSync(ctx.bus.cancelPath(id))) {
        throw new TapError(1, "already_cancelled", "tap outstanding", `'${id}' is already cancelled (.cancelled exists)`);
      }
      const intent = unsettledLiveIntents(spoolDir, ctx.bus.receiptsDir).find((row) => row.id === id);
      const malformedSlot = !intent && isMalformedExactSlot(spoolDir, ctx.bus.payloadsDir, id);
      if (!intent && !malformedSlot) {
        throw new TapError(1, "not_found", "tap spool list", `no live spool intent for '${id}'`);
      }
      // The quarantine destination refuses BEFORE any mutation (frozen
      // order): existing evidence is never overwritten, and the cancel fails
      // without touching either file.
      if (malformedSlot && existsSync(join(spoolDir, `${id}.json.malformed`))) {
        throw new TapError(1, "already_cancelled", "tap spool list", `'${id}.json.malformed' already exists; quarantined evidence is never overwritten`);
      }
      // Canonical sender authorization (unchanged gate) also supplies the
      // MALFORMED path's provenance: an undecodable intent has no to/to_team
      // of its own, so the validated, id-matching canonical is the only
      // authority. The LIVE path keeps the decoded intent's own fields — a
      // same-team canonical may legally omit to_team, and the intent (both
      // stamped at send) is the receipt's authority for where mail was bound.
      const canonicalProvenance = requireSenderEligibility(ctx, actor, id, ctx.bus.payloadPath(id));
      const receipt = {
        v: 1 as const,
        id,
        status: "cancelled" as const,
        via: "cancelled" as const,
        source: "spool" as const,
        by: actor,
        reason: malformedSlot ? ("malformed" as const) : ("spooled_withdrawn" as const),
        target: malformedSlot ? canonicalProvenance.target : intent!.to,
        to_team: malformedSlot ? canonicalProvenance.to_team : intent!.to_team,
        at: utcStamp(),
      };
      if (malformedSlot) {
        // Byte-preserving same-directory rename (atomic on one filesystem):
        // the quarantine IS the evidence. A rename failure writes no receipt
        // and no event — the slot is untouched and the failure is loud.
        renameSync(join(spoolDir, `${id}.json`), join(spoolDir, `${id}.json.malformed`));
      }
      // Receipt failure (unwritable receipts dir) leaves the byte-preserved
      // quarantine visible and fails loud, with no event — the safe order.
      atomicWrite(ctx.bus.cancelPath(id), `${JSON.stringify(receipt)}\n`);
      if (!malformedSlot) {
        // Drop the intent AFTER the receipt is durable: the crash window
        // leaves a cancelled id with a live intent, which the shared
        // denominator already excludes everywhere (anchor 4).
        rmSync(join(spoolDir, `${id}.json`), { force: true });
      }
      if (malformedSlot) {
        appendQuarantineEvent(ctx.bus.home, ctx.team, actor, id);
      }
      // Only now, with the mutation durable, does the bus record reuse.
      markResetGenerationReused(ctx.bus.home, `spool-cancel:${id}`);
      cancelScratchBarrier("cancel-held-window", id);
      if (json) emit(receipt);
      return 0;
      } finally {
        resetLock.release();
      }
    } finally {
      lock.release();
    }
  }

  usage();
}
