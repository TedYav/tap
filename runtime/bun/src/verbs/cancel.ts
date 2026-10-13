// Sender-side cancellation of dead obligations (tap-pe56).
//
// `tap cancel <id> [--by <me>] [--team <name>] [--spooled] [--json]`
//
// When the target seat cannot settle the mail — the seat is GONE from its
// registry, suspended, or the send is still parked in the spool and the sender
// withdraws it with --spooled — the sender archives the payload and writes a
// `.cancelled` receipt DISTINCT from `.done` (provenance never claims the
// recipient settled: via is always "cancelled"). Refuses while the addressee
// is active/launching with the delivered payload in hand.
//
// Custody order is load-bearing: obligation lock, then the no-steal spool
// claim, both held across the residency observation, the archive rename, the
// spool-entry removal, and the receipt. The archive rename happens BEFORE
// `removeEntry` — for a spooled entry the payload IS the spool body, so the
// order is what keeps the only copy alive (tap-92v3r U2d).
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, join } from "node:path";
import { callingPane, resolveSelf, TapError } from "../context";
import { applyTeamOverride } from "../team-override";
import { resolveSelection } from "../team-selection";
import { resolveTeamMarkerAware } from "../index-home";
import { envelopeField } from "../envelope";
import { jsonObj } from "../fsatomic";
import { writeCancelledReceipt } from "../cancelled-receipt";
import { validId, validToken } from "../ids";
import { acquireObligationLock } from "../panelock";
import { type ClaimToken, claimAcquire, claimRelease, metaPath, payloadPath, removeEntry } from "../spool-sidecar";
import { isFile } from "../watch-lease";
import { assertResetUnfenced } from "../reset";
import { instanceClearingRemedy, NO_CLEARING_PATH, historyDirForBus } from "../addressee-grant";
import { currentInstance, loadCurrentRegistry, seatMap } from "../registry";
import { OldStoreError } from "../register-authority";
import { unverifiedCanonical, unverifiedCanonicalMessage } from "../delivery-custody";
import { BUSY_SKIPS, deadLetterScope, deadLetterTargets, disposeDeadLetters } from "../dead-letters";
import { assertSelectionCurrent } from "../selector";

// Security boundary (tap-fcd3): an ABSENT registry at a RESOLVED location is
// evidence the team is gone and the obligation can never settle, so it cancels.
// An unreadable or unresolved one is unknown, never an answer, and refuses.
function classifySeat(registryPath: string, handle: string): string {
  let seats: Record<string, unknown>;
  try { seats = seatMap(loadCurrentRegistry(registryPath)); }
  catch (error) {
    // An old format is never "gone": it refuses by name before any cancel verdict.
    if (error instanceof OldStoreError) throw new TapError(1, "old_store", error.action, error.detail);
    return "unreadable";
  }
  // OWN-property check: a bracket read on seatMap's plain object inherits constructor/toString and mistakes a prototype member for a seat row.
  if (!Object.hasOwn(seats, handle) || seats[handle] == null) return "gone"; // absent from the consulted registry — gone, not active
  const row = seats[handle] as Record<string, unknown>;
  const status = typeof row.status === "string" && row.status ? row.status : "active";
  return status === "active" && row.status_reason === "launching" ? "launching" : status;
}

// The canceller a regular `.cancelled` receipt for `id` records, or "" unless the path is a
// readable cancellation receipt naming this id (status "cancelled") and a `by` token.
function cancelledBy(path: string, id: string): string {
  if (!isFile(path)) return "";
  try {
    const rec = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) return "";
    const { id: recId, status, by } = rec as Record<string, unknown>;
    return recId === id && status === "cancelled" && typeof by === "string" ? by : "";
  } catch { return ""; }
}

// Termination signals that must not orphan the spool claim. The Bash version's EXIT trap covered them;
// a JavaScript `finally` does not run when the default disposition kills the process.
const CLAIM_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

// Async for one reason: a signal callback is a macrotask and cannot run while this verb's synchronous body
// spins. The single yield below, before the first mutation, is where a pending signal is observed.
export async function cmdCancel(argv: string[], scriptsDir: string): Promise<number> {
  if (argv.includes("--dead-letters")) return cmdCancelDeadLetters(argv);
  let id = "", actor = process.env.TAP_SELF ?? "", team = "", spooled = false, json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--by" || arg === "--team") {
      const value = argv[++i];
      if (value === undefined || value === "") throw new TapError(1, "usage_error", "tap help cancel", `${arg} needs a value`);
      if (arg === "--by") actor = value; else team = value;
    } else if (arg === "--json") { json = true; process.env.TAP_JSON = "1"; }
    else if (arg === "--spooled") spooled = true;
    else if (arg.startsWith("--")) throw new TapError(1, "unknown_option", "tap help cancel", `unknown option '${arg}'`);
    else if (!id) id = arg;
    else throw new TapError(1, "usage_error", "tap help cancel", `unexpected arg '${arg}'`);
  }
  if (!id) throw new TapError(1, "usage_error", "tap help cancel", "usage: tap cancel <id> [--by <me>] [--team <name>] [--spooled] [--json]");
  if (!validId(id)) throw new TapError(1, "usage_error", "tap help cancel", `invalid id '${id}'`);

  const callerPin = process.env.TAP_HOME ?? "";
  applyTeamOverride(team);
  const ctx = resolveSelection(callerPin, team);
  // Actor: --by > TAP_SELF > pane-derived handle. The pane fallback fails SOFT
  // (the incumbent swallowed resolve errors into empty), so an unobservable
  // pane is the plain no_actor refusal, not a generation verdict.
  if (!actor) {
    const pane = callingPane();
    if (pane?.status === "ok") actor = resolveSelf(ctx, pane, 1).handle;
  }
  if (!actor) throw new TapError(1, "no_actor", "pass --by <handle> (or run 'tap register' to join this team)", "cancel requires an actor");
  if (!validToken(actor)) throw new TapError(1, "usage_error", "tap help cancel", `actor '${actor}' is not a valid token`);

  assertResetUnfenced(ctx.bus.home, "tap cancel");
  ctx.bus.ensureDirs();
  const spoolDir = join(ctx.bus.home, "spool");
  const lock = acquireObligationLock(id, 5000);
  if (!lock) throw new TapError(1, "obligation_busy", `retry tap cancel ${id}`, `another process is acting on '${id}'; refusing to cancel without exclusive eligibility`);
  let claimToken: ClaimToken | null = null;
  // A signal that lands from the claim attempt on is recorded, never acted on mid-flight: the `finally`
  // releases the lock and OUR claim (token-matched), then the status is 128 + the signal number.
  let signalled = 0;
  const onSignal = new Map<NodeJS.Signals, () => void>(CLAIM_SIGNALS.map(name => [name, () => { signalled ||= osConstants.signals[name]; }]));
  try {
    mkdirSync(spoolDir, { recursive: true });
    // Listening BEFORE the claim exists: a signal between its creation and a later install would hit the
    // default disposition and orphan it. A refusal or error removes them in the finally.
    for (const [name, handler] of onSignal) process.on(name, handler);
    const claim = claimAcquire(spoolDir, id, true);
    if (claim.status === "held") {
      throw new TapError(1, "spool_busy", `retry tap cancel ${id}`, `spool entry '${id}' is claimed; leaving its payload and receipts unchanged`);
    }
    claimToken = claim.token;
    // Already-settled/already-cancelled FIRST: a cancelled id's payload was
    // archived, so the residency not_found would otherwise fire instead.
    // Every EXISTING path is terminal (a squatter on the receipt name included).
    if (existsSync(ctx.bus.donePath(id))) throw new TapError(1, "already_settled", "tap outstanding", `'${id}' is already settled (.done exists)`);
    // Cancelling a cancelled id is idempotent: the sender's goal already holds (CLI-EXIT-0).
    // That evidence is a regular, well-formed receipt for this id recording THIS actor as its
    // canceller (the payload is archived, so the receipt is the sender proof left); any other
    // existing path, a malformed receipt, or another actor's receipt still refuses before any effect.
    if (existsSync(ctx.bus.cancelPath(id))) {
      if (cancelledBy(ctx.bus.cancelPath(id), id) !== actor) throw new TapError(1, "already_cancelled", "tap outstanding", `'${id}' is already cancelled (.cancelled exists)`);
      process.stdout.write(json ? jsonObj({ status: "already_cancelled", id }) + "\n" : `tap cancel: ${id} is already cancelled; nothing to do\n`);
      return 0;
    }

    // Payload-first, spool-second: a spooled dead obligation is the exact
    // motivating case — the send parked and the target later vanished.
    let payload = ctx.bus.payloadPath(id), source = "payloads";
    const spoolBody = payloadPath(spoolDir, id);
    if (!isFile(payload)) {
      if (!isFile(spoolBody)) throw new TapError(1, "not_found", `tap show ${ctx.team ? `${ctx.team}/` : ""}${id}`, `no local payload '${id}' to cancel (not in payloads/ or spool/)`);
      payload = spoolBody;
      source = "spool";
    }
    // An unconfirmed transport disposition retains both copies for recovery.
    // Its canonical copy is not proof of delivery; explicit withdrawal is valid.
    let unconfirmedCustody = unverifiedCanonical(ctx.bus.home, id);
    if (spooled && isFile(join(ctx.bus.receiptsDir, `${id}.unconfirmed`)) && isFile(spoolBody) && isFile(metaPath(spoolDir, id))) {
      unconfirmedCustody = true;
      source = "spool";
    }

    // Content uncertainty is not an answer: one structured refusal, payload
    // unmoved (never a raw throw — the --json caller gets its envelope).
    let raw: string;
    try { raw = readFileSync(payload, "utf8"); }
    catch { throw new TapError(1, "payload_unreadable", "tap doctor", `payload '${id}' exists at '${payload}' but could not be read; refusing cancel — an unreadable payload is unknown, not settled, and stays in place`); }
    const field = (key: string) => envelopeField(raw, key) ?? "";
    const envFrom = field("from");
    if (!envFrom) throw new TapError(1, "usage_error", "tap help cancel", `payload '${id}' has no 'from' field`);
    const remedyInput = { adoptionRegistryPath: ctx.registryPath, marker: ctx.marker, historyDir: historyDirForBus(ctx.bus.home) };
    if (envFrom !== actor) {
      // Ask the question the NEXT gate will ask, before recommending a command
      // that has to pass it (tap-ye2n). A third party gets the diagnosis, never
      // the sender's remedy as a command.
      const probe = instanceClearingRemedy(remedyInput, envFrom, field("sender_instance"));
      if (probe.kind !== "unknown") {
        throw new TapError(1, "not_sender", "tap team",
          `'${id}' was sent by '${envFrom}', not '${actor}' — only the sender may cancel, and '${envFrom}' cannot cancel it as it stands either: ${probe.detail}`);
      }
      throw new TapError(1, "not_sender", `tap cancel ${id} --by ${envFrom}`, `'${id}' was sent by '${envFrom}', not '${actor}' — only the sender may cancel`);
    }
    if (ctx.marker === "live") {
      const sinst = field("sender_instance");
      if (sinst) {
        if (!ctx.registryPath) throw new TapError(1, "registry_unreachable", "tap doctor", `acting registry unreachable — cannot verify sender instance for '${id}'`);
        const mySinst = currentInstance(ctx.registryPath, actor);
        // Never re-suggest `tap cancel <id> --by <sender>` here: the caller just
        // ran exactly that and landed on this refusal.
        if (mySinst !== sinst) {
          const remedy = instanceClearingRemedy(remedyInput, actor, sinst);
          const why = `'${id}' is bound to sender instance '${sinst}', not the current '${actor}' instance '${mySinst || "<none>"}'`;
          if (remedy.kind === "command") {
            throw new TapError(1, "not_sender", remedy.next, `${why} — retrying 'tap cancel ${id} --by ${envFrom}' fails identically; ${remedy.detail}`);
          }
          throw new TapError(1, "not_sender", remedy.next || NO_CLEARING_PATH, `${why}${remedy.detail ? ` — ${remedy.detail}` : ""}`);
        }
      }
    }

    const envTo = field("to");
    if (!envTo) throw new TapError(1, "usage_error", "tap help cancel", `payload '${id}' has no 'to' field`);
    const envToTeam = field("to_team");
    // --spooled asserts UNDELIVERED residency of the residency this run
    // resolved, before any registry lookup: it must never apply to a CANONICAL
    // payload, where it would blanket-bypass the seat_active refusal for
    // delivered mail (tap-cm00).
    if (spooled && source !== "spool" && !unconfirmedCustody) {
      const recover = field("reply") === "settle-only"
        ? `tap read ${id} --by ${envTo || "<addressee>"}`
        : `tap reply ${id} -f <file>  (the addressee answers it)`;
      throw new TapError(1, "not_spooled", recover,
        `--spooled withdraws an UNDELIVERED send, but '${id}' is a delivered payload in payloads/ — the addressee has it and can settle it normally`);
    }

    // Seats-first status: gone only after a successfully loaded registry proves
    // absence; invalid/unreadable/unresolved refuse — never authorize cancel.
    let targetStatus = "", registryChecked = "", statusRegistry = "";
    if (envToTeam && envToTeam !== ctx.team) {
      const resolved = resolveTeamMarkerAware(envToTeam, process.env.TAP_INDEX_HOME);
      if (resolved.marker === "invalid") {
        throw new TapError(1, "invalid_flip", "tap doctor", "registry flip marker is present but invalid — refusing cancel that would treat the recipient as gone");
      }
      // ctx came through the selector, so the marker is live here (F2b).
      const location = resolved.registryLocation;
      if (location && !existsSync(location)) {
        // Provable absence only: we resolved WHERE the registry should be and
        // nothing is there. Bind no registry, so absence can never become a
        // back door to the forbidden sibling rescue.
        targetStatus = "gone";
        registryChecked = `foreign_team_registry (${envToTeam}): absent at ${location}`;
      } else if (location) {
        registryChecked = `acting_registry (team '${envToTeam}')`;
        statusRegistry = location;
        // Before any soft load: a DIRECTORY or FIFO at the authority path is
        // uncertainty, not absence — and readFileSync on a FIFO blocks forever.
        // Local to cancel's authority read; refuses from metadata, never opens.
        let regular = false;
        try { regular = statSync(location).isFile(); } catch { regular = false; }
        if (!regular) {
          throw new TapError(1, "registry_error", `repair or remove '${location}'`, `recipient registry '${location}' is not a regular file; refusing cancel — an ABSENT registry is treated as gone and cancels, but an unreadable one is unknown, not an answer`);
        }
        targetStatus = classifySeat(location, envTo);
        if (targetStatus === "unreadable") {
          throw new TapError(1, "registry_error", `repair or remove '${location}'`,
            `recipient registry '${location}' is unreadable; refusing cancel — an ABSENT registry is treated as gone and cancels, but an unreadable one is unknown, not an answer`);
        }
      } else {
        throw new TapError(1, "unreachable_team", `re-enroll team '${envToTeam}', or repair its registry`, `cannot observe team '${envToTeam}' registry (${resolved.status}); refusing cancel — an ABSENT registry is treated as gone and cancels, but an unreadable one is unknown, not an answer`);
      }
    } else {
      registryChecked = "bound_team_registry";
      statusRegistry = ctx.registryPath;
      targetStatus = classifySeat(ctx.registryPath, envTo);
      if (targetStatus === "unreadable") {
        throw new TapError(1, "registry_error", "tap doctor", `local registry '${statusRegistry}' is unreadable; refusing cancel`);
      }
    }

    // A stamped payload stays bound even without a flip marker. Active refusals
    // apply only when the CURRENT recipient instance matches the envelope
    // stamp: a fresh same-handle seat cannot settle predecessor-bound mail, so
    // refusing cancel would strand the matching sender instance with no
    // clearing path.
    let recipientMatches = true;
    if (source !== "spool" && statusRegistry) {
      const rinst = field("recipient_instance");
      if (rinst) {
        const cur = currentInstance(statusRegistry, envTo);
        if (cur && cur !== rinst) recipientMatches = false;
      }
    }

    // A live addressee can settle only mail it HAS. Undelivered (spooled) mail
    // is withdrawable by its sender via --spooled; delivered mail is not.
    let withdrawn = false;
    if ((targetStatus === "active" || targetStatus === "launching") && recipientMatches) {
      if (source === "spool" || unconfirmedCustody) {
        if (spooled) withdrawn = true;
        else if (unconfirmedCustody) throw new TapError(1, "spooled_needs_flag", `tap cancel ${id} --by ${actor} --spooled`, unverifiedCanonicalMessage(id));
        else throw new TapError(1, "spooled_needs_flag", `tap cancel ${id} --by ${actor} --spooled`,
          `'${id}' is PARKED in the spool and has never reached '${envTo}', so '${envTo}' cannot settle it (settlement resolves ids against payloads/). Withdraw it with --spooled, or leave it parked to deliver when that pane frees up`);
      } else if (targetStatus === "active") {
        const activeNext = field("reply") === "settle-only"
          ? `tap read ${id} --by ${envTo}`
          : `tap reply ${id} -f <file>  (${envTo} answers it)`;
        throw new TapError(1, "seat_active",
          `tap withdraw ${id} -m '<why it is superseded>'   (or let them settle it: ${activeNext})`,
          `'${envTo}' is still an active registered seat — cancel is for sends whose addressee is GONE. If the send still stands, they settle it normally (tap read for a note, tap reply for an ask); if you have SUPERSEDED it, withdraw it: that stops it aging on your outstanding list and leaves them a tombstone instead of a dead head`);
      } else {
        throw new TapError(1, "seat_launching", "wait for the launch to finish", `'${envTo}' is still launching — cancel is for sends whose addressee is GONE`);
      }
    }
    cancelScratchBarrier("cancel-after-eligibility", id);
    // The last point before any mutation. setImmediate runs after the poll phase that delivers a pending
    // signal (a bare microtask yield would not); once past it, the archive and receipt complete as a unit
    // and a later signal only changes the final status.
    await new Promise<void>(resolve => setImmediate(resolve));
    if (signalled) return 128 + signalled;

    // ARCHIVE, then remove: the archive renames the spool body's inode first,
    // so the removal finds nothing and the withdrawn body survives. Above the
    // rename it would destroy the only copy; a bare meta unlink would also sit
    // outside the entry's meta lock — `removeEntry` holds that lock across all
    // three sidecars (courier-busy-hold 13d pins the archived bytes).
    const archiveDir = join(ctx.bus.home, "archive");
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = join(archiveDir, `${id}.cancelled.md`);
    if (isFile(payload)) renameSync(payload, archivePath);
    cancelScratchBarrier("cancel-after-archive", id);
    if (source === "spool" || unconfirmedCustody) removeEntry(spoolDir, id);

    // Two facts share this receipt and the ledger must tell them apart.
    const reason = unconfirmedCustody ? "unconfirmed_withdrawn" : withdrawn ? "spooled_withdrawn" : !recipientMatches ? "instance_retired" : "seat_unresolvable";
    writeCancelledReceipt(ctx.bus, {
      id, by: actor, reason, target: envTo, target_status: targetStatus, registry_checked: registryChecked, source,
    });

    if (json) {
      process.stdout.write(jsonObj({ status: "cancelled", id, via: "cancelled", reason, target: envTo, target_status: targetStatus, by: actor, source }) + "\n");
    } else if (unconfirmedCustody) {
      process.stdout.write(`tap cancel: cancelled ${id} (sender withdrew an unconfirmed delivery; prior recipient effect remains unknown)\n`);
    } else if (withdrawn) {
      process.stdout.write(`tap cancel: cancelled ${id} (withdrew an undelivered send to '${envTo}', which is ${targetStatus}; source: ${source})\n`);
    } else {
      process.stdout.write(`tap cancel: cancelled ${id} (target '${envTo}' is ${targetStatus}; source: ${source})\n`);
    }
    // The transaction is committed. Yield once more so a signal that landed during it is delivered, and report
    // it: the work stands (a retry would say already_cancelled), the status says we were interrupted.
    await new Promise<void>(resolve => setImmediate(resolve));
    return signalled ? 128 + signalled : 0;
  } finally {
    lock.release();
    if (claimToken !== null) { try { claimRelease(spoolDir, id, claimToken); } catch { /* the claim is best-effort custody, never a verdict */ } }
    for (const [name, handler] of onSignal) process.off(name, handler);
  }
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

/** `tap cancel --dead-letters [--dry-run] [--team <name>] [--json]` (tap-s1dqn):
 * the operator sweep for canonical mail whose addressee the registry positively
 * shows is gone. Unlike a single-id cancel it is not sender-authority: it acts
 * only where no seat can ever settle the mail, writes the existing `.cancelled`
 * receipt, and leaves every payload resident. --dry-run resolves the same
 * targets through the same classifier and writes nothing. */
function cmdCancelDeadLetters(argv: string[]): number {
  let team = "", dryRun = false, json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dead-letters") continue;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--json") { json = true; process.env.TAP_JSON = "1"; }
    else if (arg === "--team") {
      const value = argv[++i];
      if (value === undefined || value === "") throw new TapError(1, "usage_error", "tap help cancel", "--team needs a value");
      team = value;
    } else throw new TapError(1, "usage_error", "tap help cancel",
      `'${arg}' does not combine with --dead-letters; usage: tap cancel --dead-letters [--dry-run] [--team <name>] [--json]`);
  }
  const callerPin = process.env.TAP_HOME ?? "";
  applyTeamOverride(team);
  const ctx = resolveSelection(callerPin, team);
  // The fence refuses a preview exactly as it refuses the run it previews.
  assertResetUnfenced(ctx.bus.home, "tap cancel");
  const scope = deadLetterScope(ctx.bus, ctx.registryPath, ctx.team);
  if (!scope) {
    throw new TapError(1, "registry_error", "tap doctor",
      `registry '${ctx.registryPath}' is absent, unreadable, incomplete or names a team other than '${ctx.team}'; no seat can be proven gone, so nothing is a dead letter`);
  }
  let targets: ReturnType<typeof deadLetterTargets>;
  try { targets = deadLetterTargets(scope); }
  catch (error) { throw new TapError(1, "payloads_unreadable", "tap doctor", (error as Error).message); }
  const rows = targets.map((t) => ({ id: t.id, from: t.from, to: t.to, ...(t.toTeam ? { to_team: t.toTeam } : {}), kind: t.kind, class: t.class }));
  const byClass: Record<string, number> = {};
  for (const r of rows) byClass[r.class] = (byClass[r.class] ?? 0) + 1;
  const classLine = Object.keys(byClass).sort().map((k) => `${k} ${byClass[k]}`).join(", ");
  const addressee = (r: (typeof rows)[number]) => (r.to_team ? `${r.to_team}/${r.to}` : r.to);
  if (dryRun) {
    if (json) process.stdout.write(JSON.stringify({ ok: true, dry_run: true, team: scope.team, count: rows.length, by_class: byClass, targets: rows }) + "\n");
    else {
      process.stdout.write(`tap cancel --dead-letters: ${rows.length} dead letter${rows.length === 1 ? "" : "s"} on team '${scope.team}' (dry run; nothing written)\n`);
      if (classLine) process.stdout.write(`  by class: ${classLine}\n`);
      for (const r of rows) process.stdout.write(`  ${r.id}  ${r.from} -> ${addressee(r)}  ${r.kind}  ${r.class}\n`);
      if (rows.length) process.stdout.write("  next: tap cancel --dead-letters\n");
    }
    return 0;
  }
  const selection = ctx.selection;
  const { disposed, skipped, failed } = disposeDeadLetters(scope, targets, "tap cancel --dead-letters",
    selection ? (lock) => assertSelectionCurrent(selection, lock, process.env.TAP_INDEX_HOME) : undefined);
  // One success bit for both representations: benign skips (already terminal,
  // recipient no longer gone, registry moved) succeed; busy skips and a stopped batch do not.
  const ok = failed.length === 0 && !skipped.some((s) => BUSY_SKIPS.has(s.reason));
  if (json) process.stdout.write(JSON.stringify({ ok, dry_run: false, team: scope.team, count: rows.length, by_class: byClass, disposed, skipped, failed }) + "\n");
  else {
    process.stdout.write(`tap cancel --dead-letters: withdrew ${disposed.length} of ${rows.length} dead letter${rows.length === 1 ? "" : "s"} on team '${scope.team}' (payloads kept; receipts/<id>.cancelled reason=seat_unresolvable, or instance_retired for a retired instance)\n`);
    for (const s of skipped) process.stdout.write(`  kept ${s.id}: ${s.reason}\n`);
    for (const f of failed) process.stdout.write(`  stopped at ${f.id}: ${f.reason}; receipts above landed; re-run the dry run before retrying\n`);
  }
  return ok ? 0 : 1;
}
