import { recipientInstance, settlingInstance, unresolvedRecipient } from "../recipient-instance";
// `tap done <id> [--by me]` — write the authoritative settlement receipt.
//
// Settlement is RECIPIENT-GATED: the actor must be the payload's addressee, so a
// confused agent cannot settle a peer's obligation. A refused settle writes NO
// receipt — that is what makes the refusal safe to retry.
//
// Replay is a HARD ERROR rather than an idempotent success: a stale id must never
// look like a successful settle while newer obligations sit untouched.
//
// Phase 1 keeps this handler unreachable from the shipped router. tap-4kzeu owns
// the remaining actor/receipt re-verification required before native done may
// leave the code-owned Bash floor. Cross-worktree unique-by-id is in this file.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { TapError, callingPane, resolveContext, resolveSelf } from "../context";
import { envelopeField, validateEnvelope } from "../envelope";
import { atomicWrite, jsonObj } from "../fsatomic";
import { utcStamp, validId, validToken } from "../ids";
import { resolvePayloadById, isRegularFile } from "../index-home";
import { Bus } from "../bus";
import { forwardingGrant } from "../forwarding";
import { historyDirForBus, instanceClearingRemedy } from "../addressee-grant";
import { loadRegistry, adoptedInto, adoptedInstance, adoptionGrant, type RegistryDoc } from "../registry";
import { acquireObligationLock, acquireRegistryLock } from "../panelock";
import { retainedStagedIdleCopy } from "../delivery-custody";
import { type ClaimToken, claimAcquire, claimRelease, retireRetainedStagedCopyUnderClaim } from "../spool-sidecar";
import { assertResetUnfenced, markResetGenerationReused } from "../reset";
import { applyTeamOverride } from "../team-override";
import type { Context } from "../context";

export interface DoneEvidence {
  via: "done" | "reply";
  replyId?: string;
  replySha256?: string;
  replyPreview?: string;
}

export function settle(
  ctx: Context,
  id: string,
  actor: string,
  evidence: DoneEvidence = { via: "done" },
  opts?: { allowAdoptionGrant?: boolean; epoch?: string },
): void {
  const lock = acquireObligationLock(id);
  if (!lock) {
    throw new TapError(1, "obligation_busy", `retry tap done ${id}`,
      `another process is settling '${id}'; refusing to proceed without exclusive eligibility`);
  }
  try {
    settleLocked(ctx, id, actor, evidence, opts);
  } finally {
    lock.release();
  }
}

function requireSettlingActor(actor: string): void {
  if (!actor) {
    throw new TapError(1, "no_actor", "only the addressee settles",
      "actor could not be resolved; pass --by <me>");
  }
  if (!validToken(actor)) {
    throw new TapError(1, "usage_error", "tap help done",
      `actor '${actor}' is not a valid token (^[A-Za-z0-9][A-Za-z0-9._-]*$)`);
  }
}

/** Caller must hold this id's obligation lock across every preceding effect. */
export function settleLocked(
  ctx: Context,
  id: string,
  actor: string,
  evidence: DoneEvidence = { via: "done" },
  opts?: { allowAdoptionGrant?: boolean; epoch?: string },
): void {
  const donePath = ctx.bus.donePath(id);

  // Checked BEFORE the payload is read, so the guard survives payload GC.
  assertUnsettled(ctx, id, actor);
  obligationTestBarrier("done-after-eligibility", id);

  requireSettlingActor(actor);

  const path = ctx.bus.payloadPath(id);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new TapError(1, "no_local_payload", `tap done ${id} --payload <abs-path-from-sentinel-path-field>`,
      `no payload '${id}' on the local bus or any enrolled team bus; a cross-worktree sentinel settles via --payload <abs> (its path= field), not blind`);
  }
  if (!validateEnvelope(raw).ok) throw new TapError(1, "usage_error", "tap help done", `payload '${id}' has invalid envelope`);
  if (envelopeField(raw, "id") !== id) {
    throw new TapError(1, "usage_error", "tap help done", `payload '${id}' envelope id does not match filename`);
  }
  const recipient = envelopeField(raw, "to") || "";
  let forwarded = Boolean(envelopeField(raw, "original_recipient_instance"));
  if (!forwarded && recipient !== actor) {
    try { forwarded = Boolean(forwardingGrant(loadRegistry(ctx.registryPath), actor, recipient, envelopeField(raw, "recipient_instance") || "")); }
    catch { /* The ordinary authority check below owns unreadable-registry refusals. */ }
  }
  const spoolDir = join(ctx.bus.home, "spool");
  let stagedClaim: ClaimToken | null = null;
  let registryLock: ReturnType<typeof acquireRegistryLock> = null;
  try {
    // Take the spool claim before the registry lock. A direct rc-5 canonical
    // can still have an Enter-only spool copy; settlement must retire it
    // before .done or the drain's isDone skip would strand the copy forever.
    if (retainedStagedIdleCopy(ctx.bus.home, id)) {
      const claim = claimAcquire(spoolDir, id, true);
      if (claim.status === "held") throw new TapError(1, "spool_busy", `retry tap done ${id}`, `staged-idle copy '${id}' is claimed; settlement remains open`);
      stagedClaim = claim.token;
    }
    registryLock = forwarded ? acquireRegistryLock(ctx.registryPath) : null;
    if (forwarded && !registryLock) throw new TapError(1, "registry_lock_busy", "retry settlement", "recipient registry changed or is busy; no settlement written");
    const grantFrom = assertRecipientAuthority(ctx, id, raw, actor, "done", opts);

    if (stagedClaim !== null) {
      try {
        if (!retireRetainedStagedCopyUnderClaim(ctx.bus.home, id)) throw new Error("staged-idle custody changed");
      } catch { throw new TapError(1, "spool_busy", `retry tap done ${id}`, `staged-idle copy '${id}' could not be retired; settlement remains open`); }
    }

    const fields: Record<string, string | undefined> = {
      id, status: "done", at: utcStamp(), by: actor, via: evidence.via,
    };
    if (opts?.epoch) fields.epoch = opts.epoch;
    fields.instance = settlingInstance(ctx.registryPath, actor);
    const adoptedFrom = grantFrom || envelopeField(raw, "to_adopted_from");
    if (adoptedFrom) fields.adopted_from = adoptedFrom;
    if (evidence.via === "reply") {
      fields.reply_id = evidence.replyId;
      fields.reply_sha256 = evidence.replySha256;
      fields.reply_preview = evidence.replyPreview;
    }
    atomicWrite(donePath, `${jsonObj(fields)}\n`);
  } finally {
    registryLock?.release();
    if (stagedClaim !== null) { try { claimRelease(spoolDir, id, stagedClaim); } catch { /* the claim is best-effort custody */ } }
  }
}

/** Recipient/team/instance authorization, reusable before and after reply effects. */
export function assertRecipientAuthority(
  ctx: Context & { marker?: "absent" | "live" },
  id: string,
  raw: string,
  actor: string,
  caller: "done" | "reply" = "done",
  opts?: { allowAdoptionGrant?: boolean; registry?: RegistryDoc },
): string {
  const to = envelopeField(raw, "to");
  if (!to) throw new TapError(1, "usage_error", "tap help done", `payload '${id}' has no 'to' field`);
  const toTeam = envelopeField(raw, "to_team");
  if (toTeam && toTeam !== ctx.team) {
    const action = caller === "reply"
      ? `tap reply ${id} --by ${to}`
      : `tap done ${id} --by ${to} --payload ${ctx.bus.payloadPath(id)}`;
    throw new TapError(1, "not_addressee", action,
      `'${id}' is addressed to '${toTeam}/${to}', not '${ctx.team}/${actor}'`);
  }
  const boundInstance = envelopeField(raw, "recipient_instance");
  let grantFrom = "";
  if (to !== actor) {
    try { grantFrom = forwardingGrant(opts?.registry ?? loadRegistry(ctx.registryPath), actor, to, boundInstance || ""); }
    catch { /* Unreadable registry supplies no grant; retain the existing refusal below. */ }
  }
  // A reply the seat settles under its own handle still honors an adoption
  // grant: mail bound to the adopted predecessor's instance is the seat's to
  // settle when the grant names that fork (mirrors addresseeGrant's local
  // to===actor branch).
  if (to === actor && !grantFrom && opts?.allowAdoptionGrant && boundInstance) {
    const fork = envelopeField(raw, "to_adopted_from");
    if (fork && adoptionGrant(ctx.registryPath, actor, fork, boundInstance) === actor) grantFrom = fork;
  }
  if (to !== actor && !grantFrom) {
    // The next step names the caller's own verb (a reply refusal never sends
    // the actor to `tap done`): the incumbent's addressee grant answers with
    // the verb that asked (D4d — native reply now takes the adoption branch).
    const action = caller === "reply" ? `tap reply ${id} --by ${to}` : `tap done --by ${to}`;
    if (opts?.allowAdoptionGrant) {
      if (boundInstance) {
        if (adoptionGrant(ctx.registryPath, actor, to, boundInstance) === actor) {
          grantFrom = to;
        } else if (adoptionGrant(ctx.registryPath, actor, to) === actor) {
          const pred = adoptedInstance(ctx.registryPath, to);
          throw new TapError(1, "not_addressee", action,
            `'${id}' is bound to recipient instance '${boundInstance}', not the adopted '${to}' instance '${pred}'`);
        } else {
          throw new TapError(1, "not_addressee", action,
            `'${id}' is addressed to '${to}', not '${actor}'`);
        }
      } else if (adoptionGrant(ctx.registryPath, actor, to) === actor) {
        grantFrom = to;
      } else {
        throw new TapError(1, "not_addressee", action,
          `'${id}' is addressed to '${to}', not '${actor}'`);
      }
    } else {
      throw new TapError(1, "not_addressee", action, `'${id}' is addressed to '${to}', not '${actor}'`);
    }
  }

  // Instance binding: a FRESH seat at the same handle is not the seat the mail
  // was addressed to, and the clearing move belongs to the SENDER. The grant
  // path already matched recipient_instance against the adopted predecessor.
  if (boundInstance && !grantFrom) {
    const binding = recipientInstance(ctx.registryPath, actor, boundInstance);
    if (binding.state === "unresolved") {
      const refusal = unresolvedRecipient(actor, ctx.team);
      throw new TapError(1, "instance_unresolved", refusal.action, refusal.detail);
    }
    const mine = binding.current;
    if (binding.state !== "match") {
      const sender = envelopeField(raw, "from");
      let action = `the sender clears this: tap cancel ${id}${sender ? ` --by ${sender}` : ""}`;
      let detail = !mine
        ? `'${id}' is bound to recipient instance '${boundInstance}', but the current '${actor}' instance cannot be resolved — an unverified seat cannot settle predecessor-bound mail`
        : `'${id}' is bound to recipient instance '${boundInstance}', not the current '${actor}' instance — a fresh seat at this handle cannot settle predecessor-bound mail`;
      if (caller === "reply") {
        // The incumbent's mismatch answer names the adopted fork and the
        // clearing move (D4d), so a reply never dead-ends on stale bindings.
        const fork = envelopeField(raw, "to_adopted_from");
        if (fork && adoptionGrant(ctx.registryPath, actor, fork) === actor) {
          detail = `'${id}' is bound to recipient instance '${boundInstance}', not the adopted '${fork}' instance '${adoptedInstance(ctx.registryPath, fork)}'`;
        }
        const remedy = instanceClearingRemedy(
          // Reply callers resolve a live marker; plain Context (done, some
          // test-constructed contexts) defaults to absent, which disables the
          // binding remedy rather than inventing one.
          { adoptionRegistryPath: ctx.registryPath, marker: ctx.marker ?? "absent", historyDir: historyDirForBus(ctx.bus.home) },
          actor, boundInstance,
        );
        if (remedy.kind === "command") {
          action += `; or clear the binding: ${remedy.next}`;
          if (remedy.detail) detail += `; ${remedy.detail}`;
        }
      }
      throw new TapError(1, "not_addressee", action, detail);
    }
  }
  return grantFrom;
}

/** Scratch-only mutation barrier; production callers never enter it. */
function obligationTestBarrier(stage: string, id: string): void {
  const base = process.env.TAP_OBLIGATION_TEST_BARRIER;
  if (!base || !process.env.TAP_SCRATCH_ONLY || process.env.TAP_OBLIGATION_TEST_ID !== id) return;
  writeFileSync(`${base}.${stage}.${process.pid}.reached`, "1\n");
  const release = `${base}.${stage}.release`;
  const deadline = Date.now() + 60_000;
  while (!existsSync(release)) {
    if (Date.now() >= deadline) throw new Error(`obligation test barrier timed out at ${stage}`);
    Bun.sleepSync(5);
  }
}

/** The cheap first eligibility check; callers re-run the full gate before writing. */
export function assertUnsettled(ctx: Context, id: string, actor: string): void {
  const donePath = ctx.bus.donePath(id);
  if (ctx.bus.isDone(id)) {
    // A sender WITHDRAWAL is terminal like any other settlement, but answering
    // it is a different mistake from answering something already answered: the
    // recipient is holding a head the sender has retracted, and what they need
    // is the successor, not the news that someone else got there first. Only
    // `via: withdrawn` takes this branch; an ordinary cancellation keeps the
    // sentence it has always had.
    const withdrawal = readWithdrawal(ctx.bus.cancelPath(id));
    if (withdrawal && !isRegularFile(donePath)) {
      throw new TapError(1, "withdrawn",
        withdrawal.supersededBy ? `tap read ${withdrawal.supersededBy}` : `tap show ${id}`,
        `'${id}' was withdrawn by its sender at ${withdrawal.at} — superseded: ${withdrawal.reason || "no reason given"}` +
        (withdrawal.supersededBy ? `; answer '${withdrawal.supersededBy}' instead` : "; the sender named no successor") +
        `. Nothing is owed on '${id}'.`);
    }
    const at = readAt(donePath);
    const open = ctx.bus.canonicalIds().filter((o) => !ctx.bus.isDone(o) && addressedTo(ctx, o, actor));
    throw new TapError(1, "already_settled", "handle the open obligation(s) listed",
      `id ${id} already settled at ${at}; you have ${open.length} open: ${open.length ? open.join(" ") : "none"}`);
  }
}

/** The withdrawal facts a `.cancelled` receipt carries, or null when it is not one. */
function readWithdrawal(cancelPath: string): { at: string; reason: string; supersededBy: string } | null {
  if (!isRegularFile(cancelPath)) return null;
  try {
    const rec = JSON.parse(readFileSync(cancelPath, "utf8")) as Record<string, unknown>;
    if (rec.via !== "withdrawn") return null;
    return {
      at: typeof rec.at === "string" ? rec.at : "unknown",
      reason: typeof rec.reason === "string" ? rec.reason : "",
      supersededBy: typeof rec.superseded_by === "string" ? rec.superseded_by : "",
    };
  } catch { return null; }
}

function readAt(donePath: string): string {
  try {
    return String((JSON.parse(readFileSync(donePath, "utf8")) as Record<string, unknown>).at ?? "unknown");
  } catch {
    return "unknown";
  }
}

function addressedTo(ctx: Context, id: string, actor: string): boolean {
  try {
    return envelopeField(readFileSync(ctx.bus.payloadPath(id), "utf8"), "to") === actor;
  } catch {
    return false;
  }
}

export function resolveActor(ctx: Context, explicit: string): string {
  if (explicit) return explicit;
  if (process.env.TAP_SELF) return process.env.TAP_SELF;
  const pane = callingPane();
  if (pane?.status === "ok") return resolveSelf(ctx, pane, 1).handle;
  if (pane?.status === "unverifiable") {
    throw new TapError(1, "generation_unverifiable",
      "wait for tmux to answer and retry, or pass --by <handle>",
      "refusing settlement because the tmux server generation is unavailable and the caller identity cannot be verified");
  }
  // Unanchored cwd exits 1 here, not 2 — measured against the incumbent, not
  // reasoned from the class. I first picked 2 by analogy with whoami and the
  // differential arm caught it.
  throw new TapError(1, "no_actor",
    "pass --by <handle> (or run 'tap register' to join this team)",
    "only the addressee settles (caller pane observation: tmux pane inventory is unavailable)");
}

export function cmdDone(argv: string[]): number {
  let id = "";
  let actor = "";
  let absPayload = "";
  let epoch = process.env.TAP_EPOCH ?? "";
  let team = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--by") actor = requireFlagValue(a, argv, ++i);
    else if (a === "--payload") absPayload = requireFlagValue(a, argv, ++i);
    else if (a === "--epoch") epoch = requireFlagValue(a, argv, ++i);
    else if (a === "--team") team = requireFlagValue(a, argv, ++i);
    else if (a.startsWith("--")) throw new TapError(1, "unknown_option", "tap help done", `unknown option '${a}'`);
    else if (!id) id = a;
    else throw new TapError(1, "usage_error", "tap help done", `unexpected arg '${a}'`);
  }
  if (!id) throw new TapError(1, "usage_error", "tap help done", "usage: tap done <id> [--by <me>]");
  if (!validId(id)) throw new TapError(1, "usage_error", "tap help done", `invalid id '${id}'`);

  applyTeamOverride(team, { requireExistingBus: true });
  const ctx = resolveContext();
  assertResetUnfenced(ctx.bus.home, "tap done");
  ctx.bus.ensureDirs();
  const resolvedActor = resolveActor(ctx, actor);
  if (resolvedActor) {
    const successor = adoptedInto(ctx.registryPath, resolvedActor);
    if (successor) {
      throw new TapError(1, "handle_adopted", `tap done ${id} --by ${successor}`,
        `'${resolvedActor}' was a forked handle adopted into '${successor}' at reclaim and is no longer a settler — settle as the successor: tap done ${id} --by ${successor}`);
    }
  }

  if (!absPayload && !isRegularFile(ctx.bus.payloadPath(id))) {
    const hit = resolvePayloadById(id, process.env.TAP_INDEX_HOME);
    if (hit.kind === "many") {
      process.stderr.write(`id resolves to multiple enrolled team buses:\n  ${hit.paths.join("\n  ")}\n`);
      throw new TapError(1, "ambiguous_payload", `tap done ${id} --payload <abs-path>`,
        `id '${id}' resolves to more than one enrolled team bus — disambiguate with --payload <abs-path>`);
    }
    if (hit.kind === "one") absPayload = hit.path;
    else {
      if (existsSync(ctx.bus.donePath(id))) assertUnsettled(ctx, id, resolvedActor);
      requireSettlingActor(resolvedActor);
      throw new TapError(1, "no_local_payload", `tap done ${id} --payload <abs-path-from-sentinel-path-field>`,
        `no payload '${id}' on the local bus or any enrolled team bus; a cross-worktree sentinel settles via --payload <abs> (its path= field), not blind`);
    }
  }

  const settleOpts = { epoch: epoch || undefined };
  const receiptHome = absPayload
    ? settleAtCanonical(ctx, id, resolvedActor, absPayload, settleOpts)
    : ctx.bus.home;
  if (!absPayload) settle(ctx, id, resolvedActor, { via: "done" }, settleOpts);
  markResetGenerationReused(receiptHome, "done");
  process.stdout.write(`tap done: settled ${id}\n`);
  return 0;
}

function requireFlagValue(flag: string, argv: string[], i: number): string {
  const value = argv[i];
  if (value === undefined || value === "") {
    throw new TapError(1, "usage_error", "tap help done", `${flag} needs a value`);
  }
  return value;
}

/** Pane-less bus anchor. No-op when TAP_HOME is already env (rule=env wins). */


/** Validated sender-bus settle; `--payload` and unique by-id share this path. */
function settleAtCanonical(
  ctx: Context,
  id: string,
  actor: string,
  absPayload: string,
  opts?: { allowAdoptionGrant?: boolean; epoch?: string },
): string {
  if (!absPayload.startsWith("/")) {
    throw new TapError(1, "usage_error", "tap help done", `--payload must be an absolute path (got: ${absPayload})`);
  }
  const name = basename(absPayload);
  if (name !== `${id}.md`) {
    throw new TapError(1, "usage_error", "tap help done",
      `--payload filename '${name}' does not match id '${id}' (expected ${id}.md)`);
  }
  if (basename(dirname(absPayload)) !== "payloads") {
    throw new TapError(1, "usage_error", "tap help done",
      `--payload must be inside a 'payloads/' directory (parent is '${basename(dirname(absPayload))}', expected 'payloads')`);
  }
  if (!isRegularFile(absPayload)) {
    throw new TapError(1, "not_found", "tap help done", `--payload path not found: ${absPayload}`);
  }
  const foreignHome = dirname(dirname(absPayload));
  settle({ ...ctx, bus: new Bus(foreignHome) }, id, actor, { via: "done" }, { allowAdoptionGrant: true, ...opts });
  return foreignHome;
}
