// Sender-side withdrawal of a DELIVERED obligation the sender has superseded.
//
// This is deliberately NOT `tap resend`'s withdrawal half, despite sharing its
// name. Resend withdraws only under affirmative proof that NO delivery attempt
// occurred, because resend re-delivers and a second attempt after a possible
// first one is the duplicate-wake class (no-retry-after-possible-effect).
// Withdraw exists for the opposite case: the recipient HAS the payload, the
// sender has superseded it, and the ask would otherwise age in `tap outstanding`
// indistinguishable from a real unanswered one while the recipient's queue holds
// a dead head (tap-owanr; rule 43's head-move cancellation has no verb without
// this one, because `tap cancel` refuses a live addressee by design).
//
// So: resend's AUTHORITY checks and its obligation lock carry over; its
// preconditions and its archive move do not. Withdraw never delivers, never
// touches the spool, and never moves the payload.
import { mkdirSync, openSync, closeSync, fsyncSync, linkSync, unlinkSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { callerObservationReason, observeCallingPane, resolveSelf, TapError } from "../context";
import { applyTeamOverride } from "../team-override";
import { resolveSelection } from "../team-selection";
import { envelopeField, validateEnvelope } from "../envelope";
import { ensureAscii, jsonObj, writeAllSync } from "../fsatomic";
import { utcStamp, validId, validToken } from "../ids";
import { acquireObligationLock } from "../panelock";
// Rule 38: presence is a REGULAR-FILE question. `statSync().isFile()`, with a
// throwing stat answering false, is the predicate bus.ts already shares.
import { isFile } from "../watch-lease";
import { unverifiedCanonical } from "../delivery-custody";
import { acquireResetMutationLock, markResetGenerationReused } from "../reset";

// The payload STAYS in payloads/. Archiving it is what `tap cancel` does, and
// for a DELIVERED id that is the bug rather than the fix: lib.sh:3111-3112
// already records that a `.cancelled` whose payload moved to archive leaves the
// recipient's delivered doorbell pointing at a path cancel removed. Keeping the
// payload resident is also what keeps the two Bash readers that could otherwise
// have forced a new receipt suffix correct unchanged — lib.sh:3076-3082 drops a
// digest row on payload RESIDENCY (`[ -f "$(tap_payload_path ...)" ]`), not on
// the receipt, and lib.sh:1764's `.cancelled` name strip is archive-gated.
function writeReceiptOnce(path: string, fields: Record<string, string | undefined>, id: string): boolean {
  // COMPLETE BYTES FIRST, then an exclusive link — `read.ts`'s firstObservation
  // shape, and the reason for it is the whole point: `.cancelled` is an
  // AUTHORITATIVE TERMINAL NAME. `tap_is_done`, poll, outstanding, the drain,
  // read and reply all treat a regular file there as terminal, so opening the
  // final path with `wx` and writing in place means an interruption, a short
  // write or an fsync failure publishes an EMPTY tombstone: the obligation
  // reads as settled with no provenance, and the retry refuses as already
  // settled. Staging in a temp makes every failure leave the final path ABSENT.
  const temp = join(dirname(path), `.tap.${process.pid}.${crypto.randomUUID()}`);
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      // COUNT THE BYTES. Staging + fsync + an exclusive link protects against a
      // THROWN error, and establishes nothing about a short write: `writeSync`
      // reports a partial count by RETURNING it, so ignoring the result let a
      // truncated receipt reach the authoritative name at exit 0 — measured as
      // a `.cancelled` containing exactly `{"id":"s`.
      // Invalid JSON at a terminal name is worse than no receipt:
      // every reader still calls the obligation settled, and the withdrawal's
      // reason and successor are gone.
      writeAllSync(fd, Buffer.from(jsonObj(fields) + "\n", "utf8"));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(temp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST" && isFile(path)) return false;
    throw new TapError(1, "receipt_unwritable", `check permissions on ${dirname(path)}`,
      `could not write the withdrawal receipt for '${id}' — refusing to report a withdrawal that left no record`);
  } finally {
    try { unlinkSync(temp); } catch { /* A failed create leaves no temporary. */ }
  }
}

export function cmdWithdraw(argv: string[]): number {
  let id = "", reason = "", supersededBy = "", team = "", json = false;
  let actor = process.env.TAP_SELF ?? "";
  try {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!;
      if (arg === "-m" || arg === "--message" || arg === "--reason") {
        const value = argv[++i];
        if (value === undefined) throw new TapError(1, "usage_error", "tap help withdraw", `${arg} needs a reason`);
        reason = value;
      } else if (arg === "--superseded-by") {
        const value = argv[++i];
        if (value === undefined) throw new TapError(1, "usage_error", "tap help withdraw", "--superseded-by needs an id");
        supersededBy = value;
      } else if (arg === "--team") {
        // A pane-less sender anchors its bus the same way it does on `cancel`
        // and `resend`; without this the documented `--by <me> --team <t>` form
        // was `unknown_option`, and from an unrelated cwd withdrawal either
        // selected the wrong bus or refused unanchored (partner review, G1-F4).
        const value = argv[++i];
        if (value === undefined) throw new TapError(1, "usage_error", "tap help withdraw", "--team needs a name");
        team = value;
      } else if (arg === "--by") {
        const value = argv[++i];
        if (value === undefined) throw new TapError(1, "usage_error", "tap help withdraw", "--by needs a handle");
        actor = value;
      } else if (arg === "--json") json = true;
      else if (arg.startsWith("--")) throw new TapError(1, "unknown_option", "tap help withdraw", `unknown option '${arg}'`);
      else if (!id) id = arg;
      else throw new TapError(1, "usage_error", "tap help withdraw", `unexpected arg '${arg}'`);
    }
    if (!id) {
      throw new TapError(1, "usage_error", "tap help withdraw",
        "usage: tap withdraw <id> [-m <reason>] [--superseded-by <id>] [--by <me>] [--team <name>] [--json]");
    }
    if (!validId(id)) throw new TapError(1, "usage_error", "tap help withdraw", "expected a local payload id");
    if (supersededBy && !validId(supersededBy)) {
      throw new TapError(1, "usage_error", "tap help withdraw", `--superseded-by '${supersededBy}' is not a payload id`);
    }
    // Read the caller's pin BEFORE the override sets TAP_HOME itself, then use
    // the one selection helper: caller pin > --team > cwd walk.
    const callerPin = process.env.TAP_HOME ?? "";
    applyTeamOverride(team);
    const ctx = resolveSelection(callerPin, team);
    if (!actor) {
      const seen = observeCallingPane();
      if (seen.state !== "inside") {
        // The next step names --by, and the detail carries why the pane could
        // not be observed (whoami's pattern) instead of one fixed reason.
        throw new TapError(1, "no_actor", `tap withdraw ${id} --by <handle>   OR   tap register   (join this team)`,
          `only the original sender withdraws (caller pane observation: ${callerObservationReason(seen)})`);
      }
      actor = resolveSelf(ctx, { status: "ok", paneId: seen.paneId, session: seen.session, serverEpoch: seen.serverEpoch }, 1).handle;
    }
    if (!validToken(actor)) {
      throw new TapError(1, "usage_error", "tap help withdraw", `actor '${actor}' is not a valid token (^[A-Za-z0-9][A-Za-z0-9._-]*$)`);
    }

    const path = ctx.bus.payloadPath(id);
    if (!isFile(path)) {
      // Residency, not absence, is what decides the remedy. An UNDELIVERED send
      // still in the spool is `tap cancel --spooled`'s job: it owns the courier
      // claim and the queue custody, and duplicating that here would be the
      // parallel engine rule 1 forbids.
      if (isFile(join(ctx.bus.home, "spool", `${id}.md`))) {
        throw new TapError(1, "not_delivered", `tap cancel ${id} --spooled --by ${actor}`,
          `'${id}' is still SPOOLED — it was never placed in the recipient's inbox, so there is no delivered obligation to withdraw; cancel owns undelivered mail`);
      }
      throw new TapError(1, "not_found", `tap show ${id}`,
        `no payload '${id}' in this bus's payloads/ — withdraw acts on a delivered payload that is still resident`);
    }
    const raw = readFileSync(path, "utf8");
    if (!validateEnvelope(raw).ok) {
      throw new TapError(1, "usage_error", `tap show ${id}`, `payload '${id}' has an invalid envelope — inspect it with tap show`);
    }
    const field = (key: string) => envelopeField(raw, key) ?? "";
    if (field("id") !== id) {
      throw new TapError(1, "usage_error", `tap show ${id}`,
        `payload '${id}' carries envelope id '${field("id")}' — the envelope does not name the file it lives in`);
    }
    // AUTHORITY IS HANDLE+TEAM, NOT INSTANCE — a ratified deviation from
    // resend.py:80-83, which refuses a stale `sender_instance`. Resend needs the
    // current instance because it re-sends UNDER that identity. Withdraw only
    // retracts, and rule 30's refresh (a manual `/clear` + `tap in`) makes a
    // predecessor instance routine: binding withdrawal to the instance would
    // refuse exactly the reloaded seat holding its predecessor's aging asks.
    if (field("from") !== actor) {
      throw new TapError(1, "not_sender", `tap show ${id}`,
        `only the original sender withdraws '${id}' — it was sent by '${field("from") || "<unknown>"}', not by '${actor}'`);
    }
    const fromTeam = field("from_team");
    if (fromTeam && fromTeam !== ctx.team) {
      throw new TapError(1, "not_sender", `tap show ${id}`,
        `'${id}' was sent from team '${fromTeam}', not from '${ctx.team}'`);
    }
    if (unverifiedCanonical(ctx.bus.home, id)) {
      throw new TapError(1, "not_delivered", `tap cancel ${id} --spooled --by ${actor}`,
        `'${id}' has unverified delivery and is still under spool custody; cancel owns withdrawal before recipient observation`);
    }
    if (supersededBy === id) {
      throw new TapError(1, "usage_error", "tap help withdraw", `'${id}' cannot supersede itself`);
    }

    // RESET MUTATION CUSTODY, not a point-in-time fence check. A bare
    // `assertResetUnfenced` leaves the standard cut race: reset acquires its
    // sidecar after the check, snapshots and cuts the still-open obligation,
    // and this withdrawal then publishes `.cancelled` into the fresh blank bus
    // — so restoring the checkpoint RESURRECTS work whose sender was told it
    // was withdrawn. Every other mutating verb (send, reply, out, seat up/down,
    // launch) holds this lock; withdraw was the outlier (partner review, G1-F1).
    const resetLock = acquireResetMutationLock(ctx.bus.home, "tap withdraw", undefined, "shared");
    try {
    const lock = acquireObligationLock(id);
    if (!lock) throw new TapError(1, "obligation_busy", `tap outstanding ${actor}`, `another process is acting on '${id}'`);
    try {
      const donePath = ctx.bus.donePath(id);
      if (isFile(donePath)) {
        // The recipient answered. Withdrawing now would overwrite a real
        // settlement's provenance with the sender's retraction.
        throw new TapError(1, "already_settled", `tap show ${id}`,
          `'${id}' was already settled by its recipient; there is no open obligation to withdraw`);
      }
      const cancelPath = ctx.bus.cancelPath(id);
      if (isFile(cancelPath)) {
        let via = "cancelled";
        try { via = String(JSON.parse(readFileSync(cancelPath, "utf8")).via ?? "cancelled"); } catch { /* an unreadable receipt is still terminal */ }
        throw new TapError(1, "already_settled", `tap show ${id}`,
          `'${id}' is already terminal (via: ${via}); withdrawal is not repeatable`);
      }
      try { mkdirSync(dirname(cancelPath), { recursive: true }); }
      catch { throw new TapError(1, "receipt_unwritable", `check permissions on ${dirname(cancelPath)}`, `could not create the receipts directory for '${id}'`); }
      // `status: cancelled` keeps every existing reader of a `.cancelled`
      // receipt correct; `via: withdrawn` is what distinguishes the sender's
      // retraction of DELIVERED mail from cancel's clearing of mail whose
      // addressee is gone. Provenance never claims the recipient settled.
      const written = writeReceiptOnce(cancelPath, {
        id,
        status: "cancelled",
        via: "withdrawn",
        by: actor,
        at: utcStamp(),
        reason: reason || undefined,
        superseded_by: supersededBy || undefined,
      }, id);
      if (!written) {
        throw new TapError(1, "already_settled", `tap show ${id}`, `'${id}' became terminal while this withdrawal was acquiring its lock`);
      }
      // Only after the complete receipt is durable — a generation marked reused
      // for a receipt that never landed is a lie about what this bus has seen.
      markResetGenerationReused(ctx.bus.home, "withdraw");
      // No spool touch and no pane effect, for every class including the
      // interrupt class. That is mechanical rather than promised: `.cancelled`
      // makes tap_is_done true, and the drain's resurrection guard is
      // `tap_is_done "$id" && continue` (lib.sh:3721), while
      // redelivery-eligibility already classifies a cancelled-after-attempt id
      // as `redelivery_skipped ... effect=none` (lib.sh:2668).
      const to = field("to"), toTeam = field("to_team");
      const target = toTeam ? `${toTeam}/${to}` : to;
      if (json) {
        process.stdout.write(ensureAscii(JSON.stringify({
          ok: true, id, status: "cancelled", via: "withdrawn", by: actor, to: target,
          ...(reason ? { reason } : {}), ...(supersededBy ? { superseded_by: supersededBy } : {}),
        })) + "\n");
      } else {
        process.stdout.write(`tap withdraw: ${id} withdrawn (to=${target})${reason ? ` — ${reason}` : ""}\n`);
        if (supersededBy) process.stdout.write(`  superseded by: ${supersededBy}\n`);
        process.stdout.write(`  the obligation is off your outstanding list; ${to || "the recipient"} sees the tombstone on tap read ${id}\n`);
      }
      return 0;
    } finally { lock.release(); }
    } finally { resetLock.release(); }
  } catch (error) {
    if (!json || !(error instanceof TapError)) throw error;
    process.stdout.write(`${ensureAscii(JSON.stringify({ ok: false, error_class: error.errorClass, action: error.action, detail: error.detail }))}\n`);
    return error.code;
  }
}
