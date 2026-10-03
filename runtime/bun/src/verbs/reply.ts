// `tap reply <id> (-m "text" | -f <file>) [--by me]`
//
// One verb that ANSWERS and SETTLES. The ORDER is the contract: the outbound must
// be durable before the inbound is settled, so a crash between the two leaves an
// unsettled obligation (visible in poll, recoverable) rather than a settled one
// with no answer (silent, unrecoverable).
//
// The receipt records reply EVIDENCE derived from the outbound file ON THE BUS —
// never from this process's in-memory message variable. A receipt quoting what we
// MEANT to send is not evidence about what we sent.

import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { TapError, resolveContext, type Context } from "../context";
import { envelopeBodyBytes, envelopeField, validateEnvelope } from "../envelope";
import { mintId, validId } from "../ids";
import { acquireObligationLock, type PaneLock } from "../panelock";
import { forwardingRoute } from "../forwarding";
import { loadRegistry, seatMap, type RegistryDoc } from "../registry";
import { bindRemoteTeam } from "../remote-target";
import { cmdSendOutcome, type SendDisposition } from "./send";
import { assertRecipientAuthority, assertUnsettled, resolveActor, settleLocked } from "./done";
import { acquireResetMutationLock, assertResetUnfenced, interactiveResetCustodyWaiting, markResetGenerationReused, POST_PLACEMENT_CUSTODY_WAIT_MS } from "../reset";
import { resolveReplyReference } from "../payload-view";
import { loadGlobalRegistry, markerSelectedIndex, resolveTeamFromDoc } from "../index-home";
import { Bus } from "../bus";
import { applyTeamOverride } from "../team-override";
import { isOldStoreRefusal } from "../register-authority";

export function cmdReply(argv: string[], scriptsDir: string, agentFamilies: ReadonlySet<string>): number {
  let ref = "";
  let message: string | null = null;
  let bodyFile = "";
  let messagePreview: string | null = null;
  let actor = "";
  let kind = "";
  // D1 obligation modes on reply: `--expect-reply` flips the outbound to
  // reply=expected; `--progress` is HARD settle-only and leaves the inbound
  // open (a partial answer). Bash's parser has no `--json` for reply at all —
  // it is `unknown_option` there, and here, with the same bytes.
  let expectReply = false;
  let progress = false;
  // D4b: `--delivery` is FORWARDED, NOT VALIDATED HERE (tap-reply.sh:56-62):
  // send owns the class enum and its conflict matrix, and a second validator
  // on this surface is the drift the incumbent already paid for once. U4: the
  // forwarded value is native end to end — `--delivery interrupt` reaches the
  // courier's interrupt sequence through the composed send.
  let delivery = "";
  let absPayload = "";
  let team = "";
  // send-reply-r2 checkpoint A (U1): the caller's outbound `--reply-to` (where
  // the ANSWER's replies land) and `--pane` (an explicit relay override) are
  // forwarded to the composed send's argv, which owns the addressing —
  // tap-reply.sh:49-51 parses them and :307/:335 forward them.
  let outReplyTo = "";
  let outReplyToSet = false;
  let paneOverride = "";
  // A positional payload file is the third body source (tap-reply.sh:53),
  // exactly one of {-m, -f, <payload-file>}.
  let payloadFile: string | null = null;
  // `--allow-unattended` only skips reply's own unattended refusal below
  // (tap-reply.sh:224 ALLOW_UNATTENDED); nothing about it reaches send.
  let allowUnattended = false;
  // D4c: the epoch stamped into the settle receipt, in the incumbent's
  // precedence (tap-reply.sh:37/:48/:231): `--epoch` > ambient TAP_EPOCH > the
  // inbound's own `epoch:`. TAP never interprets the value — it records what
  // it is told (CONTRACT §Settlement) — so the seal predicate downstream can
  // reject a stale-epoch ack.
  let epoch = process.env.TAP_EPOCH ?? "";
  // A missing operand is a usage_error on every value option. An empty one is
  // accepted only for `-m` and `--preview`, as Bash's `${2?}` did; the rest
  // were `${2:?}` and refuse it (tap-reply.sh:49-71).
  const operand = (i: number, name: string, emptyOk = false): string => {
    const v = argv[i + 1];
    if (v === undefined || (v === "" && !emptyOk)) throw new TapError(1, "usage_error", "tap help reply", `${name} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "-m": case "--message": message = operand(i++, "-m", true); break;
      case "-f": case "--body-file": bodyFile = operand(i++, "--body-file"); break;
      case "--delivery": delivery = operand(i++, a); break;
      case "--allow-unattended": allowUnattended = true; break;
      case "--epoch": epoch = operand(i++, a); break;
      case "--preview": messagePreview = operand(i++, a, true); break;
      case "--from": throw new TapError(1, "unknown_option", "tap reply <id> --by <me> -f <body-file>", "reply uses --by for the responding addressee; --from belongs to send");
      case "--by": actor = operand(i++, a); break;
      case "--kind": kind = operand(i++, a); break;
      // D4d: `--payload <abs>` names the inbound on ANOTHER bus (the sentinel's
      // path= field) and `--team <name>` is the pane-less bus anchor
      // (tap_apply_team_override, tap-reply.sh:72).
      case "--payload": absPayload = operand(i++, a); break;
      case "--team": team = operand(i++, a); break;
      case "--reply-to": outReplyTo = operand(i++, a); outReplyToSet = true; break;
      case "--pane": paneOverride = operand(i++, a); break;
      case "--expect-reply": expectReply = true; break;
      case "--progress": progress = true; break;
      default:
        if (a.startsWith("--")) throw new TapError(1, "unknown_option", "tap help reply", `unknown option '${a}'`);
        if (!ref) ref = a;
        else if (payloadFile === null) payloadFile = a;
        else throw new TapError(1, "usage_error", "tap help reply", `unexpected arg '${a}'`);
    }
  }
  // EXACTLY ONE body source. Accepting both and silently preferring one sends a
  // message the caller did not choose and settles the obligation, so the mistake
  // is unrecoverable — the reference refuses and leaves the obligation open.
  // The incumbent's order (tap-reply.sh:76, :87-93): a MISSING reference gets
  // the usage line; with a reference present, the body-count refusal is the
  // `pass exactly one message source…` sentence alone.
  const bodySources = [message !== null, !!bodyFile, payloadFile !== null].filter(Boolean).length;
  if (!ref) {
    throw new TapError(1, "usage_error", "tap help reply; AGENTS.md TAP card (Ask/Note/Digest)",
      `usage: tap reply <id|path> (-m "text" | -f <body-file> | <payload-file>) [--progress] [--payload <abs-path>] [--by <me>] [--kind <k>] [--expect-reply] [--epoch <n>] [--team <name>] [--allow-unattended] [--delivery interrupt|now|polite]`);
  }
  if (bodySources !== 1) {
    throw new TapError(1, "usage_error", "tap help reply; AGENTS.md TAP card (Ask/Note/Digest)",
      `pass exactly one message source: -m "text", -f <body-file>, or a positional <payload-file>`);
  }
  // The pane-less bus anchor first, as the incumbent applies it (tap-reply.sh:72)
  // before anything reads the bus. A caller-pinned TAP_HOME keeps precedence
  // over `--team` on both doors (lib.sh:6483's `TAP_BUS_RULE=env` return; the
  // override's own early return). Otherwise the selection is the EXPLICIT
  // team, for this verb and for the send it composes: the override's TAP_HOME
  // alone does not move a native selection — under a live marker the
  // selector's cwd enrollment walk wins over TAP_HOME (selectFromWalk) — and
  // a cwd inside ANOTHER enrolled team's root is exactly what `--team` exists
  // to bypass for a pane-less caller (the incumbent is TAP_HOME-first there;
  // reply-selected-registry.test.sh, tap-mxf95).
  const explicitTeam = team && !process.env.TAP_HOME ? team : "";
  applyTeamOverride(team, { requireExistingBus: true });
  const ctx = replyContext(explicitTeam);
  // D4d: the reference resolves through the ONE resolver both doors share —
  // the incumbent calls this same function through `tap_bun_call
  // reply-reference` (tap-reply.sh:88) — so `<id>`, `<team>/<id>`, `<12hex>`,
  // `path=<file>`, an existing path and `--payload <abs>` name the same file
  // on both doors, on the local bus or on an enrolled team's. A digest, parked
  // or archived residency is its `not_obligation`; a bad id its `usage_error`;
  // a marker the loader calls invalid resolves with no index (as resolveView
  // does), so a foreign reference is then `not_found` on both doors.
  const index = markerSelectedIndex(process.env.TAP_INDEX_HOME);
  const view = resolveReplyReference(ref, ctx.bus.home, index.marker === "live" ? index.path : "", absPayload);
  const typedRef = ref;
  ref = view.id;
  const inboundPath = view.path;
  // The incumbent's foreign predicate (tap-reply.sh:159): an explicit --payload,
  // or a resolved path that is not this bus's own canonical for the id. A
  // foreign inbound's `.done` lives on ITS bus (the sender's), and every
  // settlement-side read runs against that bus.
  const foreign = !!absPayload || inboundPath !== ctx.bus.payloadPath(ref);
  const inboundBus = foreign ? dirname(dirname(inboundPath)) : ctx.bus.home;
  if (!validId(ref)) throw new TapError(1, "usage_error", "tap help reply", `invalid id '${ref}'`);
  // The incumbent's structural bus-shape guard (tap-done.sh F2B-2): a foreign
  // payload's parent directory must be named exactly `payloads`, so the bus
  // derived two levels up is a real bus and never a path shaped to look like
  // one. The incumbent judges it in `tap done` AFTER the answer is delivered
  // (delivered, then unsettled); the native door refuses BEFORE any outbound —
  // a deviation in its favour.
  if (foreign && basename(dirname(inboundPath)) !== "payloads") {
    throw new TapError(1, "usage_error", "tap help reply; AGENTS.md TAP card (Ask/Note/Digest)",
      `--payload must be inside a 'payloads/' directory (parent is '${basename(dirname(inboundPath))}', expected 'payloads')`);
  }
  let inboundPreview: string;
  try {
    inboundPreview = readFileSync(inboundPath, "utf8");
  } catch {
    throw new TapError(1, "not_found", "tap poll; tap teams; ask the sender for the payload id or path", `inbound payload '${ref}' is no longer available`);
  }
  // send-reply-r2 checkpoint A (U1): a team-qualified STORED reply_to no
  // longer delegates. The redirect below resolves deliverability through the
  // machine index (the incumbent's tap_seat_deliverable over bind + row),
  // so the route, its cross-team stamps and its refusals are native.
  // A foreign SENDER (`from_team`) is native (D4): the return address is
  // `<from_team>/<from>` and send binds the sender's team through the machine
  // index exactly as `tap send <team>/<handle>` does (D2); for a FOREIGN
  // inbound (D4d) the incumbent binds that team through
  // `tap_authority_context` first and passes the acting registry as
  // `--remote-registry` — the same index entry the native send reads — after
  // the refusal ported in replyLocked.

  // Reset custody on EVERY bus this reply mutates: the local bus (the outbound)
  // and, for a foreign inbound, the sender's bus (the `.done`). The incumbent
  // guards only `$TAP_HOME` (tap-reply.sh:75; tap-done.sh:54 likewise for
  // `--payload`) and settles a fenced foreign bus anyway — an incumbent gap the
  // native door does not copy (partner review, D4d; measured and ratified in
  // CONTRACT). The sidecars are taken in sorted path order so two replies in
  // opposite directions never wait on each other.
  //
  // Custody is held only across the settle, never across the composed send
  // (tap-0p7hx), which takes its own custody for its placement: the resend
  // shape. The obligation lock is what keeps a reply to one outbound, and it
  // stays held throughout; a reset between the outbound and the settle leaves
  // the inbound unsettled and says so.
  const custodyHomes = foreign && inboundBus !== ctx.bus.home ? [ctx.bus.home, inboundBus].sort() : [ctx.bus.home];
  for (const home of custodyHomes) assertResetUnfenced(home, "tap reply");

  const lock = acquireObligationLock(ref);
  if (!lock) {
    throw new TapError(1, "obligation_busy", `retry tap reply ${ref}`,
      `another process is replying to or settling '${ref}'; refusing to emit a second outbound`);
  }
  try {
    return replyLocked(ref, message, bodyFile, actor, kind, scriptsDir, agentFamilies, messagePreview, { expectReply, progress, delivery, allowUnattended, epoch, inboundPath, inboundBus, foreign, explicitTeam, typedRef, outReplyTo, outReplyToSet, paneOverride, payloadFile, custodyHomes });
  } finally {
    lock.release();
  }
}

/** The caller's selection: the explicit `--team` when one anchors the bus, else the cwd walk. */
function replyContext(explicitTeam: string): Context {
  return resolveContext(process.cwd(), process.env, explicitTeam ? { explicitTeam } : undefined);
}

function replyLocked(ref: string, message: string | null, bodyFile: string, actor: string, kind: string, scriptsDir: string, agentFamilies: ReadonlySet<string>, messagePreview: string | null, mode: { expectReply: boolean; progress: boolean; delivery: string; allowUnattended: boolean; epoch: string; inboundPath: string; inboundBus: string; foreign: boolean; explicitTeam: string; typedRef: string; outReplyTo: string; outReplyToSet: boolean; paneOverride: string; payloadFile: string | null; custodyHomes: string[] }): number {
  const ctx = replyContext(mode.explicitTeam);
  // The caller's outbound-addressing selections, threaded from the parse.
  const { outReplyTo, outReplyToSet, paneOverride, payloadFile } = mode;
  assertResetUnfenced(ctx.bus.home, "tap reply");
  ctx.bus.ensureDirs();
  // The settlement side of a FOREIGN inbound — its `.done`, the already-settled
  // check, the open-obligation count — is the payload's own bus (tap-reply.sh:159-163,
  // done.ts's settleAtCanonical shape); `team` and `registryPath` stay the
  // actor's, so authority is judged on the local registry.
  const inboundCtx: Context = mode.foreign ? { ...ctx, bus: new Bus(mode.inboundBus) } : ctx;
  if (mode.foreign) assertResetUnfenced(mode.inboundBus, "tap reply");

  // Read the inbound BEFORE composing anything: the reply's recipient comes from
  // it, and refusing early means a bad ref never leaves a stray outbound behind.
  let inbound: string;
  try {
    inbound = readFileSync(mode.inboundPath, "utf8");
  } catch {
    throw new TapError(1, "not_found", "tap poll; tap teams; ask the sender for the payload id or path", `inbound payload '${ref}' is no longer available`);
  }
  if (!validateEnvelope(inbound).ok) {
    throw new TapError(1, "usage_error", "tap help reply", `inbound payload '${ref}' has an invalid envelope`);
  }
  // The actor: --by > TAP_SELF > the pane's handle. When no pane can say who
  // is calling, PREFILL the exact --by from the inbound's addressee — never
  // adopt it (tap-g3o6, tap-reply.sh:109-122): the caller re-runs with --by so
  // the identity in the durable receipt is their own explicit claim. The
  // reference is echoed as typed, so the line is copyable from a manual relay.
  let me: string;
  try {
    me = resolveActor(ctx, actor);
  } catch (error) {
    const suggest = error instanceof TapError && error.errorClass === "no_actor" ? envelopeField(inbound, "to") || "" : "";
    if (!suggest) throw error;
    throw new TapError(1, "no_actor", `tap reply ${mode.typedRef} --by ${suggest} -f <file>`,
      `could not derive your handle from this pane; '${ref}' is addressed to '${suggest}' — re-run with --by ${suggest} if that is you (only the addressee replies)`);
  }
  // Only the addressed TEAM's seat replies (tap-reply.sh:130-134): a foreign
  // inbound addressed to another team is refused with the canonical path in
  // hand. An empty to_team is local (tap_target_team_is_local).
  const inboundToTeam = envelopeField(inbound, "to_team") || "";
  if (inboundToTeam && inboundToTeam !== ctx.team) {
    throw new TapError(1, "not_addressee", `tap reply ${mode.inboundPath} -f <file>`,
      `'${ref}' is addressed to '${inboundToTeam}/${envelopeField(inbound, "to") || ""}', not '${ctx.team}/${me}' — reply from the addressed team's seat using the canonical payload path`);
  }
  // Bash's order: the inbound's reply expectation is judged before the
  // already-settled check. `--progress` needs an open, reply=expected inbound
  // (CONTRACT § reply): a settle-only note has nothing to report progress on,
  // and `--progress --expect-reply` are two opposite claims about one outbound.
  const inboundReply = envelopeField(inbound, "reply") || "expected";
  if (inboundReply === "settle-only" && mode.progress) {
    throw new TapError(1, "sender_contract", `tap read ${ref}`, `--progress requires a reply=expected inbound; '${ref}' is reply=settle-only — a note settles when you read it`);
  }
  if (inboundReply === "settle-only") {
    process.stderr.write(
      `tap reply: warning: '${ref}' is reply=settle-only; sender did not want a reply. Reply only to report a problem; never to acknowledge.\n`,
    );
  }
  if (mode.progress && mode.expectReply) {
    throw new TapError(1, "progress_settle_only", `tap reply ${ref} --progress -f <file>`, "--progress is hard reply=settle-only; remove --expect-reply");
  }
  // Eligibility is checked under the obligation lock BEFORE the outbound side
  // effect, then settleLocked rechecks it after send and before receipt write.
  // tap-31it R9: via=courier-auto is courier settlement of a digest doorbell —
  // a problem-report reply still sends outbound and does not write a second .done.
  const courierAutoSettled = receiptVia(inboundCtx.bus.donePath(ref)) === "courier-auto";
  if (!courierAutoSettled) {
    // The incumbent's already_settled names `tap send` as the next step
    // (tap-reply.sh:181 — the answer goes out as a fresh send); the shared
    // detail sentence is the same computation on the payload's bus.
    try { assertUnsettled(inboundCtx, ref, me); }
    catch (error) {
      if (error instanceof TapError && error.errorClass === "already_settled") throw new TapError(1, "already_settled", "tap send", error.detail);
      throw error;
    }
  }
  const registry = loadRegistry(ctx.registryPath);
  // The adoption grant is the incumbent's (tap_addressee_grant_check reaches
  // the shared addressee-grant module, which grants a live successor its
  // retired fork's mail): a reply as the successor settles with
  // `adopted_from` = the fork, on the local and the foreign route alike (D4d).
  const adoptedFrom = assertRecipientAuthority(inboundCtx, ref, inbound, me, "reply", { registry, allowAdoptionGrant: true }) || envelopeField(inbound, "to_adopted_from") || "";
  const seats = seatMap(registry);
  const routed = resolveReplyRoute(inbound, registry, ctx.team);
  const target = routed.target;
  if (!target) {
    throw new TapError(1, "usage_error", "tap help reply", `payload '${ref}' has no 'from' to reply to`);
  }
  const fromHandle = envelopeField(inbound, "from") || "";
  // The unattended refusal reads the LOCAL registry, so it applies only to a
  // local original sender: the incumbent skips it for a foreign sender
  // (tap-reply.sh:232 `[ -z "$FROM_TEAM" ]`) — a local seat that happens to
  // share the foreign handle says nothing about the seat this reply reaches.
  if (
    !routed.viaReplyTo
    && !envelopeField(inbound, "from_team")
    && inboundReply !== "settle-only"
    && !mode.allowUnattended
    && fromHandle
    && ownSeat(seats, fromHandle)?.unattended === true
  ) {
    throw new TapError(
      1,
      "unattended_sender",
      `tap read ${ref} or tap reply ${ref} --allow-unattended -f <file>`,
      `'${fromHandle}' is unattended; inbound replies are refused by default unless reporting a problem`,
    );
  }

  // Foreign return route (tap-reply.sh:255-283, post-flip): the sender team's
  // ACTING registry is bound through the index by `tap_authority_context`
  // before the send, and an unreachable one is refused HERE with reply's own
  // sentence — never a fall-back to the retired bus mirror. The native send
  // then binds the same index entry (D2), which is what the incumbent hands it
  // as `--remote-registry`.
  if (mode.foreign && !routed.viaReplyTo && envelopeField(inbound, "from_team")) {
    refuseUnreachableSenderTeam(envelopeField(inbound, "from_team") || "");
  }

  // MINT THE ID UP FRONT AND CARRY IT, rather than discovering "the new file"
  // afterwards.
  //
  // The scan-for-what-appeared approach is a global directory diff, so it
  // attributes whatever else arrived during the send — a concurrent peer's
  // canonical wins the sorted scan just as easily as ours. The observed failure
  // is not cosmetic: the inbound was settled with an ALIEN id, that stranger's
  // preview, and that stranger's SHA, while the real reply sat separately
  // durable. The receipt attested somebody else's message.
  //
  // Carrying the minted id makes the evidence file identifiable rather than
  // inferred, which no amount of scan-narrowing can achieve.
  const outId = mintId(me);
  let outcome;
  try {
    outcome = cmdSendOutcome([
      target,
      ...(payloadFile !== null ? [payloadFile] : message !== null ? ["-m", message] : ["-f", bodyFile]),
      ...(messagePreview !== null ? ["--preview", messagePreview] : []),
      "--from", me,
      "--id", outId,
      // Bash's mapping: progress → --fyi; a plain reply → --fyi; --expect-reply → --expect-reply.
      mode.expectReply && !mode.progress ? "--expect-reply" : "--fyi",
      ...(kind ? ["--kind", kind] : []),
      ...(mode.delivery ? ["--delivery", mode.delivery] : []),
      // send-reply-r2 checkpoint A (U1): the caller's outbound `--reply-to`
      // and `--pane` ride the composed send's argv, which owns the addressing
      // (tap-reply.sh:307, :335). The explicit --reply-to beats the send's
      // no-auto-reply-to default, exactly as it does on the incumbent.
      ...(outReplyToSet ? ["--reply-to", outReplyTo] : []),
      ...(paneOverride ? ["--pane", paneOverride] : []),
    ], scriptsDir, agentFamilies, { inReplyTo: ref, noAutoReplyTo: true, quiet: true,
      // The composed send selects the same bus this reply did: the incumbent
      // exports the override's TAP_HOME to its `tap send` child (lib.sh:6504-6511).
      explicitTeam: mode.explicitTeam || undefined,
      recipientInstance: routed.instance, historicalRecipient: !routed.viaReplyTo, adoptedFrom: adoptedFrom || undefined,
      expectedSenderInstance: adoptedFrom ? String(seats[me]?.instance ?? "") : undefined,
      // Point of effect: the same authority predicate again, under send's held
      // registry lock, before placement — a revoked adoption (or forwarding)
      // between the read above and the effect refuses with nothing placed.
      reauthorize: (locked) => { assertRecipientAuthority(inboundCtx, ref, inbound, me, "reply", { registry: locked, allowAdoptionGrant: true }); },
      // Departed-sender record (tap-4lrwv): a sender who has left the team —
      // no registry row, no forwarding successor — gets the answer as a
      // durable, terminal record instead of a refusal, and the ask settles.
      // Same-team only (a foreign sender's registry is another team's to
      // read), and never for --progress, which settles nothing and so would
      // strand a cancelled record beside an open ask.
      departedSender: !mode.progress && !envelopeField(inbound, "from_team"),
    });
  } catch (error) {
    // A refused outbound (exit 1 / 3) is the incumbent's two stderr lines and
    // send's exit (tap-reply.sh:492-503): it consumes send's JSON error object
    // and renders the problem and the recovery from it, never a second
    // error_class line. Every non-TapError passes through.
    if (!(error instanceof TapError)) throw error;
    if (error.detail && error.action) {
      process.stderr.write(`tap reply: outbound to ${target} failed because ${error.detail}; next: ${error.action}\n`);
    }
    // "Nothing durable" is CHECKED, not assumed: a
    // post-placement refusal — D2's render refusal when the machine index
    // turns invalid after the canonical is placed (send.ts senderIndexEvidence)
    // — exits 1 and leaves the canonical as a tracked obligation. The
    // incumbent's line invites a re-run there, which would mint a second
    // outbound beside the first (no retry after a possible effect:
    // skills/tap/protocol/delivery/reliability.md);
    // the native door names the outbound that remains instead.
    const remains = outboundResidency(ctx, outId);
    if (remains) {
      process.stderr.write(`tap reply: '${ref}' left unsettled — the outbound ${outId} to ${target} is placed on the bus (${remains}) and was not delivered; do not re-run 'tap reply', which would mint a second outbound; next: tap outstanding ${me}\n`);
    } else {
      process.stderr.write(`tap reply: '${ref}' left unsettled — the outbound to ${target} did not become durable; re-run 'tap reply' after fixing the send above\n`);
    }
    return error.code;
  }
  const rc = outcome.rc;
  // The departed-sender record (tap-4lrwv): the outbound was placed, archived
  // and terminal-cancelled by send instead of delivered.
  const departedRecord = outcome.disposition === "recorded-departed";

  // Evidence is derived only after send reports a DURABLE outcome: 0 (injected)
  // or 5 (submit-unverified, canonical still on the bus). Anything else means no
  // outbound exists and the inbound must stay unsettled.
  if (rc !== 0 && rc !== 5) return rc;
  if (mode.progress) {
    // A progress outbound settles nothing: the inbound stays open. Receipts are
    // Bash's, by verbosity and by fate.
    const queued = receiptQueued(outcome.disposition);
    if (rc === 5) {
      process.stderr.write(`tap reply: progress for ${ref} is on the bus but delivery to ${target} could not be confirmed; ${ref} remains outstanding; next: tap outstanding ${me}\n`);
      return 5;
    }
    if (process.env.TAP_VERBOSE !== "1") process.stdout.write(`tap reply: progress ${ref} (open)\n`);
    else if (queued) process.stdout.write(`tap reply: queued progress to ${target}; ${ref} remains outstanding\n`);
    else process.stdout.write(`tap reply: sent progress to ${target}; ${ref} remains outstanding; submitted to pane; recipient seat-side processing unverified\n`);
    return rc;
  }
  // Settle custody on every bus this settle mutates, sorted so two replies in
  // opposite directions never wait on each other.
  const resetLocks: PaneLock[] = [];
  const releaseCustody = () => { for (const held of resetLocks.reverse()) held.release(); };
  try {
    // tap-7t3ag: an interactive replier auto-waits a busy sidecar (stderr
    // progress names the holder); non-interactive callers keep the bound.
    for (const home of mode.custodyHomes) resetLocks.push(acquireResetMutationLock(home, "tap reply", POST_PLACEMENT_CUSTODY_WAIT_MS, "shared", interactiveResetCustodyWaiting("tap reply")));
  } catch (error) {
    releaseCustody();
    if (!(error instanceof TapError) || (error.errorClass !== "team_reset_fenced" && error.errorClass !== "reset_custody_busy")) throw error;
    process.stderr.write(`tap reply: '${ref}' left unsettled — ${outboundFate(outcome.disposition)} as ${outId} to ${target}, but the settle could not take reset custody (${error.errorClass}: ${error.detail}); do not re-run 'tap reply', which would mint a second outbound; next: ${error.errorClass === "team_reset_fenced" ? error.action : `tap outstanding ${me}`}\n`);
    return error.code;
  }
  try {
  const outboundRaw = departedRecord ? resolveDepartedEvidence(ctx, outId, ref) : resolveOutboundEvidence(ctx, outId, ref);
  // Hash the body BYTES as Bash's `shasum` over the file does; only the human
  // preview is decoded (a byte-invalid reply body hashed byte-for-byte).
  const bodyBytes = envelopeBodyBytes(outboundRaw) ?? Buffer.alloc(0);
  const body = bodyBytes.toString("utf8");
  const fate = outboundFate(outcome.disposition);
  if (courierAutoSettled) {
    process.stdout.write(
      rc === 0 && process.env.TAP_VERBOSE !== "1" ? `tap reply: ${receiptQueued(outcome.disposition) ? "queued" : "ok"} ${ref}\n` : `tap reply: ${fate}; ${ref} was already settled by the courier (via: courier-auto) when its digest landed\n`,
    );
    return rc;
  }
  // The incumbent's precedence: an explicit or ambient epoch, else the
  // inbound's own (tap-reply.sh:231 — "the seal predicate depends on the
  // recipient's epoch travelling into the .done").
  const epoch = mode.epoch || envelopeField(inbound, "epoch") || "";
  try {
    settleLocked(inboundCtx, ref, me, {
      via: "reply",
      replyId: outId,
      replySha256: createHash("sha256").update(bodyBytes).digest("hex"),
      replyPreview: preview(body),
    // The settle re-runs the authority gate after the outbound (the pre-send
    // check above cannot be trusted across the effect); it grants adoption on
    // the same terms, or a granted send would end in a refused settle.
    }, { epoch: epoch || undefined, allowAdoptionGrant: true });
  } catch (error) {
    if (!(error instanceof TapError)) throw error;
    // The outbound already exists. The settler's own advice can name the
    // retired `tap done` or a re-reply that would mint a second outbound, so
    // point at the records instead; class, exit and other actions stay.
    const action = /\btap (?:help )?(?:done|reply)\b/.test(error.action) ? `tap show ${outId}` : error.action;
    throw new TapError(error.code, error.errorClass, action,
      `${error.detail}; '${ref}' left unsettled — ${fate} as ${outId} to ${target}; do not re-run 'tap reply', which would mint a second outbound`,
      error.verbLabel);
  }
  // The receipt is a mutation of the bus it landed on: mark that bus's reset
  // generation reused by `done` (tap-done.sh:312 for the local receipt, :309
  // `tap_reset_generation_touch_bus "$_ext_bus_home"` for a foreign one) so a
  // restore can never replay over a real settlement — under the custody
  // taken above, before it is released. Locally the
  // outbound's placement already marked the bus `send`; the first mutation
  // stands.
  markResetGenerationReused(inboundCtx.bus.home, "done");

  process.stdout.write(
    departedRecord ? `tap reply: recorded ${ref}; sender '${target}' has left the team — not delivered, will not be read; inbound settled\n`
      : rc === 0 && process.env.TAP_VERBOSE !== "1" ? `tap reply: ${receiptQueued(outcome.disposition) ? "queued" : "ok"} ${ref}\n` : `tap reply: ${fate}; inbound ${ref} settled\n`,
  );
  return rc;
  } finally {
    releaseCustody();
  }
}

/**
 * `tap_authority_context <from_team>` under a live marker (lib.sh:5382-5420) as
 * tap-reply.sh:257-283 consumes it for a foreign inbound: the sender team
 * resolves through the index to an acting registry that is a regular file, or
 * the reply is refused with the incumbent's class and sentence. This is the
 * SECOND index sample of a reply (the resolver took the first), so the marker
 * can have turned between them: a marker the loader
 * calls invalid — unreadable or the wrong schema; the native loader knows only
 * live / invalid / absent, so the incumbent's `marker_unreadable` catch-all
 * has no native class — is `invalid_flip` with the incumbent's sentence; an
 * absent marker (deleted between samples) cannot bind the team and never falls
 * back to the retired bus mirror on this door (the incumbent's pre-flip branch
 * is the legacy door, which the router keeps on Bash), so it is
 * `unreachable_team`. Exported for its own control row.
 */
export function refuseUnreachableSenderTeam(fromTeam: string): void {
  const index = loadGlobalRegistry(process.env.TAP_INDEX_HOME);
  if (index.marker === "invalid") {
    throw new TapError(1, "invalid_flip", "tap doctor", "registry flip marker is present but invalid — refusing foreign reply that would bind the retired bus mirror");
  }
  const r = index.marker === "live" && index.doc ? resolveTeamFromDoc(index.doc as Record<string, unknown>, fromTeam) : null;
  if (!r || r.status !== "ok" || !r.registryLocation) {
    throw new TapError(1, "unreachable_team", "tap doctor",
      `sender team '${fromTeam}' acting registry unreachable (unreachable) — enroll or repair; will not fall back to the retired bus mirror`);
  }
  let regular = false;
  try { regular = statSync(r.registryLocation).isFile(); } catch { regular = false; }
  if (!regular) {
    throw new TapError(1, "unreachable_team", "tap doctor",
      `sender team '${fromTeam}' acting registry missing after resolve — will not fall back to the retired bus mirror`);
  }
}

/** Where a refused outbound still lives, if anywhere: its canonical or its spool
 * entry (the two residencies resolveOutboundEvidence reads). A regular file is
 * the predicate — there is no incumbent operator to port (Bash never looks); a
 * stat that throws is "absent". */
function outboundResidency(ctx: Context, id: string): "canonical" | "spool" | "" {
  const regular = (path: string): boolean => { try { return statSync(path).isFile(); } catch { return false; } };
  if (regular(ctx.bus.payloadPath(id))) return "canonical";
  if (regular(join(ctx.bus.home, "spool", `${id}.md`))) return "spool";
  return "";
}

/** Snapshot only this outbound's two legal residencies, as tap-done.sh does.
 * Open descriptors retain bytes across spool-to-canonical rename. Bounded retries
 * cover movement between the two opens; corrupt or non-regular evidence refuses.
 */
export function resolveOutboundEvidence(ctx: Context, id: string, inboundId: string): Buffer {
  const canon = ctx.bus.payloadPath(id);
  const spool = join(ctx.bus.home, "spool", `${id}.md`);
  const metaPath = join(ctx.bus.home, "spool", `${id}.meta.json`);
  const refuse = (detail: string): never => { throw new TapError(1, "reply_correlation", "tap doctor", detail); };
  const regular = (path: string): Buffer => {
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    } catch (error) {
      if (["ELOOP", "EMLINK"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        refuse(`reply evidence is not a regular courier-owned bus entry: ${path}`);
      }
      throw error;
    }
    try {
      if (!fstatSync(fd).isFile()) refuse(`reply evidence is not a regular courier-owned bus entry: ${path}`);
      return readFileSync(fd);
    } finally { closeSync(fd); }
  };
  let raw: Buffer | undefined;
  let target: string | undefined;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      try { raw = regular(canon); break; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        const bytes = regular(spool);
        const metaBytes = regular(metaPath);
        let meta: Record<string, unknown>;
        try { meta = JSON.parse(metaBytes.toString("utf8")); } catch { return refuse(`queued reply has invalid courier metadata: ${metaPath}`); }
        if (!meta || meta.id !== id || typeof meta.target !== "string" || !meta.target
            || meta.team !== ctx.team || !Number.isInteger(meta.first_spooled_epoch)) {
          refuse(`queued reply has invalid courier metadata: ${metaPath}`);
        }
        target = meta.target as string;
        raw = bytes;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } catch (error) {
      if (error instanceof TapError) throw error;
      // Other transient open/read failures get the same bounded retry as Bash.
    }
    if (attempt < 5) Bun.sleepSync(10);
  }
  if (raw === undefined) return refuse(`reply payload not found after durable courier transition: ${canon}`);
  // The envelope is text; the body stays bytes for the hash (partner review, D1 F2).
  const text = raw.toString("utf8");
  if (!validateEnvelope(text).ok) refuse(`reply payload has an invalid envelope: ${canon}`);
  if (envelopeField(text, "id") !== id) refuse(`reply payload envelope id does not match filename '${id}'`);
  if (envelopeField(text, "path") !== canon) refuse(`reply payload path does not match canonical destination '${canon}'`);
  if (target !== undefined && envelopeField(text, "to") !== target) refuse(`queued reply target does not match courier metadata: ${metaPath}`);
  if (envelopeField(text, "in_reply_to") !== inboundId) {
    refuse(`reply payload in_reply_to does not match inbound '${inboundId}'; inbound left unsettled`);
  }
  return raw;
}

/** The departed-sender record's evidence (tap-4lrwv): the outbound send placed
 * and then archived under cancel's convention. The envelope's path= field
 * still names the canonical it was placed at — the archive move is the
 * terminal record's shape — so id and in_reply_to are what must match. */
export function resolveDepartedEvidence(ctx: Context, id: string, inboundId: string): Buffer {
  const archived = join(ctx.bus.home, "archive", `${id}.cancelled.md`);
  const refuse = (detail: string): never => { throw new TapError(1, "reply_correlation", "tap doctor", detail); };
  let raw: Buffer;
  try {
    raw = readFileSync(archived);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") refuse(`departed-sender record not found: ${archived}`);
    throw error;
  }
  const text = raw.toString("utf8");
  if (!validateEnvelope(text).ok) refuse(`departed-sender record has an invalid envelope: ${archived}`);
  if (envelopeField(text, "id") !== id) refuse(`departed-sender record envelope id does not match filename '${id}'`);
  if (envelopeField(text, "in_reply_to") !== inboundId) {
    refuse(`departed-sender record in_reply_to does not match inbound '${inboundId}'; inbound left unsettled`);
  }
  return raw;
}

function resolveReplyRoute(inbound: string, registry: RegistryDoc, localTeam: string): { target: string; viaReplyTo: boolean; instance?: string } {
  const seats = seatMap(registry);
  const from = envelopeField(inbound, "from") || "";
  const fromTeam = envelopeField(inbound, "from_team") || "";
  const fromAddr = fromTeam ? `${fromTeam}/${from}` : from;
  const replyTo = envelopeField(inbound, "reply_to") || "";
  const original = () => {
    const instance = envelopeField(inbound, "sender_instance") || "";
    // Validate the historical route before calling it undeliverable. Send repeats
    // resolution under its registry lock, using the ORIGINAL principal. A
    // foreign sender's route lives on ITS team's registry, which send binds
    // through the index (D2): the local registry's rows for a same-named
    // handle are another seat's history and say nothing about this route.
    if (!fromTeam) forwardingRoute(registry, from, instance, true);
    return { target: fromAddr, instance, viaReplyTo: false };
  };
  if (!replyTo) return original();
  if (/[/:]/.test(replyTo)) {
    // send-reply-r2 checkpoint A (U1): the team-qualified redirect now takes
    // the incumbent's deliverability port (tap-reply.sh:220-230 over
    // tap_seat_deliverable): the named seat must exist and be deliverable on
    // ITS team through the machine index — a poll member qualifies, as the
    // reply_to bar always did. Anything else falls back to the original
    // sender with the same warning.
    if (qualifiedReplyToDeliverable(replyTo)) return { target: replyTo, viaReplyTo: true };
  } else if (!fromTeam || fromTeam === localTeam) {
    // A bare reply_to names a seat on the SENDER's team. On a foreign inbound the
    // local registry's same-named row is another seat, so the bare arm is skipped
    // and the ordinary warning plus original-sender fallback below applies (tap-bgxp).
    // New sends stamp a team-qualified reply_to; only pre-upgrade payloads are bare.
    try {
      const route = forwardingRoute(registry, replyTo);
      if (deliverableLocal(seats, route.target)) return { target: replyTo, viaReplyTo: true };
    } catch { /* documented fallback to the original sender */ }
  }
  const id = envelopeField(inbound, "id") || "";
  process.stderr.write(
    `tap reply: warning: reply_to '${replyTo}' on '${id}' is no longer deliverable (unknown team, unknown handle, or not an active pane/poll seat) — falling back to the original sender '${fromAddr}'\n`,
  );
  return original();
}

/**
 * The qualified arm of tap_seat_deliverable (send-reply-r2 checkpoint A, U1):
 * bind the team through the machine index and read the seat row on ITS
 * registry — active, not launching, and a poll member or pane-backed. A poll
 * member qualifies here, unlike the cross-worktree relay's row (a relay
 * injects; a reply_to address only routes).
 */
function qualifiedReplyToDeliverable(replyTo: string): boolean {
  const address = replyTo.includes(":") && !replyTo.includes("/") ? replyTo.replace(":", "/") : replyTo;
  const slash = address.indexOf("/");
  if (slash === -1) return false;
  const team = address.slice(0, slash);
  const handle = address.slice(slash + 1);
  let registryPath: string;
  try {
    registryPath = bindRemoteTeam(team, handle, process.env.TAP_INDEX_HOME).registryPath;
  } catch (error) {
    // An old-format registry refuses the reply; it never reroutes it to the original sender.
    if (isOldStoreRefusal(error)) throw error;
    return false;
  }
  try {
    const doc = loadRegistry(registryPath);
    // The incumbent's deliverability port applies the forwarding route before
    // the row check (lib.sh:7345), as native send's deliverableRow already
    // does: a qualified address naming a retired source routes to the edge's
    // destination instead of falsely falling back to the original sender.
    return deliverableLocal(seatMap(doc), forwardingRoute(doc, handle).target);
  } catch {
    return false;
  }
}

function deliverableLocal(seats: Record<string, unknown>, handle: string): boolean {
  const seat = ownSeat(seats, handle);
  if (!seat || String(seat.status ?? "active") !== "active") return false;
  // `tap_seat_deliverable` rejects a `launching` status_reason outright
  // (lib.sh:7337-7343); a launching row is not a deliverable target yet.
  if (String(seat.status_reason ?? "") === "launching") return false;
  const delivery = String(seat.delivery ?? "pane");
  // tap-zk1w: a pane row with no generation stamp cannot receive (send refuses it).
  return delivery === "poll" || (!!String(seat.pane ?? "") && !!String(seat.server_epoch ?? ""));
}

function ownSeat(seats: Record<string, unknown>, handle: string): Record<string, unknown> | null {
  if (!Object.hasOwn(seats, handle)) return null;
  const row = seats[handle];
  return typeof row === "object" && row !== null && !Array.isArray(row)
    ? row as Record<string, unknown>
    : null;
}

function receiptVia(donePath: string): string {
  try {
    return String((JSON.parse(readFileSync(donePath, "utf8")) as Record<string, unknown>).via ?? "");
  } catch {
    return "";
  }
}

/**
 * Bash's `SEND_STATUS = queued` (tap-reply.sh parse_send_result): the spool,
 * the poll queue AND the harness queue — every accepted outbound that touched
 * no pane. The receipt says "queued" for all three and "ok" / "sent … submitted
 * to pane" only for a real pane submission (AGENTS.md: report what the courier
 * observed). The native door used to count only poll and spool, so a
 * harness-queued reply was reported as a pane effect that never happened.
 */
export function receiptQueued(disposition: SendDisposition): boolean {
  return disposition === "queued-poll" || disposition === "queued-spool" || disposition === "queued-harness";
}

function outboundFate(disposition: SendDisposition): string {
  switch (disposition) {
    case "delivered":
      return "outbound delivered to pane (recipient processing unconfirmed)";
    case "queued-harness":
      return "outbound accepted in harness queue (recipient processing unconfirmed)";
    case "queued-spool":
      return "outbound queued in spool";
    case "queued-poll":
      return "outbound queued for poll";
    case "unverified":
      return "outbound submit unverified (canonical remains on the bus)";
    case "placed":
      return "outbound placed on the bus but not delivered";
    case "recorded-departed":
      return "outbound recorded for a departed sender (not delivered)";
  }
}

/**
 * The receipt stores a PREVIEW, never the whole body: non-printables become
 * spaces, whitespace collapses, and it is capped at 160 characters. A receipt is
 * a pointer to evidence, not a second copy of the message.
 */
function preview(body: string): string {
  const cleaned = Array.from(body)
    .map((ch) => (ch.codePointAt(0)! < 0x20 || ch.codePointAt(0)! === 0x7f ? " " : ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 160);
}
