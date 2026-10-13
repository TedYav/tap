// The drain's DEADLINE dispositions (lane A, slice A2 — the drain's per-item
// transactions that need no pane submit): the three Phase B branches of
// `tap_spool_drain_once` that end or hold an entry at (or past) its deadline, ported
// whole with the helper bodies they were the only remaining callers of —
// `tap_spool_dispose_grace`, `tap_spool_mark_escalated`, `tap_spool_terminalize`,
// `tap_write_delivery_failed_receipt`, `tap_spool_notify_sender_on_escalate`,
// `tap_spool_grace_attempted`, `tap_spool_recipient_is_present`. Their Bash bodies are
// gone; the adapters that remain in lib.sh carry verdicts and facts only.
//
// The attempt transaction is now orchestrated by spool-drain.ts and
// spool-drain-effects.ts. Its locked capture/submit and immediate custody step
// run in the same native worker; this module keeps the
// existing deadline and sender-notice decisions.
//
// LOCK ORDER. Every transaction here takes the entry's spool CLAIM (`.claim`, the
// drain lease over moving an entry) and nothing else on the recipient's side: no
// obligation lock, no pane lock. A deadline disposition never touches the recipient's
// pane, so it never contends with a submit for it. The one pane effect — the sender
// notice — takes the SENDER's pane lock inside `submitNotice` (courier.ts), after the
// claim is held. The claim is released in `finally`; a thrown error inside the
// transaction still releases it and surfaces as `slice_failed` through the adapter.
//
// Every DECIDED outcome answers at exit 0 with a verdict word (the adapters' own
// rule since A1b): a held claim, a not-due entry and a declined escalation are
// routine, and the incumbent said nothing about them. A nonzero exit is a slice
// failure — an unreadable row, a missing spool directory, a thrown error.
//
// Python-fidelity notes ride the functions they apply to. Timestamps: the incumbent
// used the WALL clock (`date -u`) for receipt/meta stamps and `$now` only for
// due-ness; `ctx.now` is the latter, `ctx.wall` the former, so a pinned drain clock
// does not pin receipt stamps that the incumbent never pinned either.

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync, openSync, closeSync, fsyncSync, linkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { Bus } from "./bus";
import { archivedPayload } from "./bus-archive-index";
import { canonicalPlaceLocked } from "./courier";
import { envelopeField } from "./envelope";
import { appendRegistryEventOrWarn } from "./events";
import { atomicWrite, jsonObj, lockNameFits, receiptBytes } from "./fsatomic";
import { COURIER_IDENTITY, HELP_HANDLE, USER_IDENTITY, WATCH_IDENTITY, mintId, validId } from "./ids";
import { classifyNotice, FEEDBACK_DRAFT_HELD, STUCK_READINESS_HELD, hasRecipientRead, noticeBody, KIND_DELIVERY_FAILED } from "./notice";
import { submitNotice } from "./notice-submit";
import { acquirePathLock } from "./panelock";
import { RESET_HELD_LOCK_WAIT_MS, withResetCustody, withResetCustodyAsync, type CustodyRefusal } from "./reset";
import { loadCurrentRegistry, loadRegistry, seatMap } from "./registry";
import { teamRegistryFileRefusal } from "./register-authority";
import { pendingReprobe } from "./submit-phase";
import { graceCanReprobe } from "./spool-grace";
import { claimAcquire, claimRelease, metaField, metaPath, payloadPath, removeEntryAsync } from "./spool-sidecar";
import { markLegacyNoBinding } from "./spool-state";
import { METADATA_LOCK_TIMEOUT_MS, isDict, metaBytes, parseJsonPreserving, pyReadUtf8, pyStrip, pyTruthy } from "./spool-publication";
import { pyStr } from "./digest-window";
import { AGENT_FAMILIES } from "./harness-families";
import { notifyHuman } from "./watch-notice";
import { currentAttemptMarker } from "./retry";

// --- inputs -------------------------------------------------------------------------

/** The Phase B row, in `tap_spool_list`'s listing order — the SNAPSHOT the loop read,
 *  not a re-read: a field another drain changed mid-loop is the incumbent's race too. */
export interface DeadlineRow {
  id: string;
  target: string;
  reason: string;
  reasonClass: string;
  timeoutSeconds: string;
  firstEpoch: string;
  pane: string;
  paneId: string;
  toTeam: string;
  targetRegistry: string;
  policy: string;
  deadlineEpoch: string;
  escalatedAt: string;
  deadlineSource: string;
  holdUntilEpoch: string;
}

export const ROW_FIELDS = [
  "id", "target", "reason", "reasonClass", "timeoutSeconds", "firstEpoch", "pane", "paneId",
  "toTeam", "targetRegistry", "policy", "deadlineEpoch", "escalatedAt", "deadlineSource", "holdUntilEpoch",
] as const satisfies readonly (keyof DeadlineRow)[];

/**
 * Whether a HUMAN alert is available, and with what facts. Only a drain running
 * inside the watcher's tick has a human to alert — the incumbent learned that from
 * a callback the watcher defined (`tap_spool_on_escalate`), the port from a fact the
 * watcher states (`TAP_SPOOL_HUMAN_ALERT=watcher`, a local at its one drain call).
 * The tick keeps its arm snapshot in shell locals the native process cannot read,
 * so it hands the two values the callback read over as data.
 *
 * The callback also had a non-tick branch that re-read the arm record; it was
 * unreachable — `_watch_process_spool` has one call site, inside `tap_watch_tick`
 * after `TAP_WATCH_TICK_ACTIVE=1` (tap-watch.sh) — and is not ported (named, not a
 * behavior change; the architect, A2 consult).
 */
export type HumanAlert =
  | { mode: "none" }
  | { mode: "tick"; queuedProbeId: string; probeTimeout: string };

export interface DeadlineContext {
  /** `$TAP_HOME`. */
  home: string;
  /** `$TAP_SPOOL`. */
  spoolDir: string;
  /** `$TAP_REGISTRY_EVENTS`. */
  eventLog: string;
  /** `tap_spool_team_name` — the event `team` and the sentinel bus. */
  team: string;
  /** `${TAP_VERB:-tap}` — the warning prefix on a failed event append. */
  verbLabel: string;
  /** `tap_acting_registry "$(tap_spool_team_name)"`, or "" when unresolvable. */
  actingRegistry: string;
  /** `$DIR` / `_TAP_SCRIPT_DIR` — `verbs/escalate.ts` lives there. */
  scriptsDir: string;
  alert: HumanAlert;
  /** The drain's `$now` (`TAP_SPOOL_NOW` or the wall clock at drain start). */
  now: number;
  /** `TAP_SPOOL_UNROUTED_GRACE`. */
  unroutedGrace: number;
  wall?: () => Date;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Test seam: the sender-notice submit (`submitNotice`'s own seam is the pane). */
  submit?: typeof submitNotice;
  /** Test seam: the human alert publisher. */
  notifyHuman?: typeof notifyHuman;
}

function wallNow(ctx: DeadlineContext): Date { return (ctx.wall ?? (() => new Date()))(); }
function envOf(ctx: DeadlineContext): NodeJS.ProcessEnv { return ctx.env ?? process.env; }
function bus(ctx: DeadlineContext): Bus { return new Bus(ctx.home); }
function isFile(path: string): boolean { try { return statSync(path).isFile(); } catch { return false; } }
function exists(path: string): boolean { try { lstatSync(path); return true; } catch { return false; } }
/** `date -u +%Y-%m-%dT%H:%M:%SZ`. */
function isoSeconds(now: Date): string { return now.toISOString().replace(/\.\d{3}Z$/, "Z"); }

// --- the helper bodies, ported --------------------------------------------------------

/** `tap_is_done`: a `.done` or `.cancelled` receipt exists (regular file). */
export function isDone(ctx: DeadlineContext, id: string): boolean {
  const b = bus(ctx);
  return isFile(b.donePath(id)) || isFile(b.cancelPath(id));
}

/**
 * `tap_spool_grace_attempted <id>`: a possible-effect marker exists (presence is
 * conservative — a dangling symlink counts) AND the entry's waiter is the grace window.
 * This remains the generic possible-effect predicate used by digest admission;
 * narrower per-id recovery authority must not make an entry batchable.
 */
export function graceAttempted(ctx: DeadlineContext, id: string): boolean {
  return exists(currentAttemptMarker(ctx.home, ctx.spoolDir, id))
    && metaField(ctx.spoolDir, id, "waiter_lifetime") === "grace-window";
}

/**
 * `tap_spool_recipient_is_present <ready>`: names the TERMINAL states, not the live
 * ones — `gone` and `unsafe` are the only classifications `tap_spool_pane_ready`
 * emits before the bound-identity check passes, so everything else is a live seat.
 * A denylist of terminal states fails toward holding, which is the direction to be
 * wrong in for a rule whose subject is "do not claim a live seat is unreachable".
 */
export function recipientIsPresent(ready: string): boolean {
  return ready !== "gone" && ready !== "unsafe";
}

/**
 * `tap_spool_mark_escalated <id> [<key>]`: true iff THIS call wrote `<key>` first.
 * `escalated_at` is the courier disposition; `human_escalated_at` records that the
 * watcher accepted a human alert — a different fact with a different owner, one
 * writer for both so the lock and the read-modify-replace stay in one place.
 *
 * The incumbent locked `<meta>.lock` with an UNBOUNDED `flock`; this one is bounded
 * by `METADATA_LOCK_TIMEOUT_MS` like every other native metadata writer (A1b), and a
 * timeout is a refusal (`false`), which is what the incumbent's `except: exit 1`
 * turned every failure into. The file it writes has NO trailing newline: this site's
 * `json.dump` had no `write("\n")` after it, same as the attempts bump.
 */
export function markEscalated(ctx: DeadlineContext, id: string, key: "escalated_at" | "human_escalated_at" = "escalated_at"): boolean {
  const path = metaPath(ctx.spoolDir, id);
  if (!lockNameFits(`${path}.lock`)) return false;
  const lock = acquirePathLock(`${path}.lock`, METADATA_LOCK_TIMEOUT_MS, envOf(ctx));
  if (!lock) return false;
  try {
    const meta = parseJsonPreserving(pyReadUtf8(path));
    if (!isDict(meta)) return false;
    // Python `if meta.get(key): exit 1` — any truthy value refuses.
    if (pyTruthy(meta[key])) return false;
    meta[key] = isoSeconds(wallNow(ctx));
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, metaBytes(meta as Record<string, never>).replace(/\n$/, ""));
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  } finally {
    lock.release();
  }
}

export type DrainStage = "terminalize" | "retire" | "notice";
/**
 * One durable drain effect under reset custody (tap-g191v). Team reset copies
 * payloads/ and spool/ separately; a body moved or minted between those copies
 * is in neither archive. A fenced or busy effect is not performed: the body
 * stays where it is, and the refusal is a preserved registry event.
 */
export async function underDrainCustody<T>(ctx: DeadlineContext, stage: DrainStage, id: string, body: () => Promise<T> | T,
  waitMs?: number): Promise<{ ok: true; value: T } | { ok: false }> {
  const result = await withResetCustodyAsync(ctx.home, `courier ${stage}`, async () => body(), waitMs);
  if (result.ok) return result;
  effectLeftInPlace(ctx, stage, id, result.refusal);
  return { ok: false };
}

export function effectLeftInPlace(ctx: DeadlineContext, stage: DrainStage, id: string, refusal: CustodyRefusal): void {
  const why = refusal === "team_reset_fenced" ? "fenced" : "busy";
  appendRegistryEventOrWarn(ctx.verbLabel, { log: ctx.eventLog, actor: "courier", action: "spool_effect_fenced", handle: "", pane: "",
    team: ctx.team, detail: `id=${id} stage=${stage} reason=${why}`, env: envOf(ctx) });
  process.stderr.write(`tap: spool effect for '${id}' left in place at ${stage} — reset custody ${why}\n`);
}

/**
 * `tap_spool_terminalize <id> <handle> <pane> <reason> [<action>]`: remove the retry
 * state, keep the payload. PROMOTE BEFORE DISCARDING — while an entry is parked the
 * spool file is the ONLY copy of the message, so removing the entry without promoting
 * first would delete the very payload the failure notice just handed the sender a
 * path to. The ACTION is a parameter because the event is a claim: a park that was
 * never attempted must not be logged as a delivery failure.
 */
export async function terminalize(ctx: DeadlineContext, id: string, handle: string, pane: string, reason = "delivery_failed", action = "spool_terminal_delivery_failed",
  opts: TerminalizeOptions = {}): Promise<boolean> {
  const result = await underDrainCustody(ctx, "terminalize", id, () => terminalizeHeld(ctx, id, handle, pane, reason, action, opts));
  return result.ok && result.value;
}

/** True when a canonical copy exists whose bytes differ from the spool body: promotion would discard the only original. */
export function canonicalConflicts(ctx: DeadlineContext, id: string): boolean {
  const spoolPayload = payloadPath(ctx.spoolDir, id), canon = bus(ctx).payloadPath(id);
  if (!isFile(spoolPayload) || !existsSync(canon)) return false;
  try { return !readFileSync(canon).equals(readFileSync(spoolPayload)); } catch { return true; }
}

/** Opt-in guards, checked first under the promotion's reset custody; no default caller sets them. */
export interface TerminalizeOptions {
  /** Hold when a canonical copy exists whose bytes differ from the spool body. */
  requireSameCanonical?: boolean;
  /** Hold unless the caller's decision still stands. */
  precondition?: () => boolean;
}

async function terminalizeHeld(ctx: DeadlineContext, id: string, handle: string, pane: string, reason: string, action: string,
  opts: TerminalizeOptions = {}): Promise<boolean> {
  const spoolPayload = payloadPath(ctx.spoolDir, id);
  const canon = bus(ctx).payloadPath(id);
  // A caller that opts in holds rather than treat a different canonical as its promotion.
  if (opts.requireSameCanonical && canonicalConflicts(ctx, id)) return false;
  if (opts.precondition && !opts.precondition()) return false;
  // The operator (tap-gridx) has no seat to notify or settle for, so every
  // unsettled terminal path writes its `.cancelled` receipt, or `tap outstanding
  // user` would list the payload for good. It is written FIRST and must exist
  // before the retry state goes: a failed write keeps the entry for the next
  // pass. Mail from a legacy pre-reservation seat named `user` is not operator
  // mail and keeps the ordinary path; an unreadable registry cannot tell the
  // two apart, so it holds. The writer is idempotent and never overrides `.done`.
  if (reason !== "settled") {
    let sender = "";
    try { sender = envelopeField(pyReadUtf8(isFile(spoolPayload) ? spoolPayload : canon), "from") ?? ""; } catch { /* unreadable: no operator evidence */ }
    if (sender === USER_IDENTITY) {
      const seat = registryPresence(ctx, "", USER_IDENTITY);
      if (seat.state === "unobservable") return false;
      if (seat.state === "absent" && !writeDeliveryFailedReceipt(ctx, id, handle, reason)) return false;
    }
  }
  if (isFile(spoolPayload)) {
    try { mkdirSync(dirname(canon), { recursive: true }); } catch { /* `|| true` */ }
    if (!isFile(canon)) {
      // `mv -f … || cp -f … || return 1`: a rename, else a copy that leaves the
      // spool file for `removeEntry` to unlink.
      try { renameSync(spoolPayload, canon); }
      catch { try { copyFileSync(spoolPayload, canon); } catch { return false; } }
    }
  }
  if (!isFile(canon)) return false;
  appendRegistryEventOrWarn(ctx.verbLabel, {
    log: ctx.eventLog, actor: "courier", action, handle, pane, team: ctx.team,
    detail: `id=${id} reason=${reason}`, env: envOf(ctx),
  });
  // `tap_spool_remove` owns retry-state cleanup (payload + meta + `.reown`, archived
  // under the meta lock). Its charset guard `die`d in Bash; here an invalid id can
  // only arrive through a row the listing minted, so it is a thrown slice failure.
  if (!validId(id)) throw new Error(`spool_remove: id '${id}' fails charset`);
  // Bounded under reset (tap-12ys6). By now the payload is promoted and the event
  // written, so the entry is terminal and the caller's receipt or sender notice must
  // still run: a refused removal is reported, not thrown. What it leaves is swept
  // later: an orphaned sidecar by the drain's reapStaleSidecars, a copied spool body
  // when the row settles and reconcileSettled terminalizes it again.
  try { await removeEntryAsync(ctx.spoolDir, id, ctx.signal, envOf(ctx), RESET_HELD_LOCK_WAIT_MS); }
  catch (failure) {
    ctx.signal?.throwIfAborted();
    process.stderr.write(`tap: slice_failed id=${id} slice=spool-remove: ${String(failure)}\n`);
  }
  return true;
}

/**
 * `tap_write_delivery_failed_receipt <id> <target> [<reason>]`: a `.cancelled` receipt
 * (`source: courier_expiry`), never a `.done` — the seat never saw the body. Without
 * it the entry is unclearable by construction: terminalize promotes the payload and
 * drops the spool state, so `tap outstanding` lists it forever.
 */
export function writeDeliveryFailedReceipt(ctx: DeadlineContext, id: string, target: string, reason = "delivery_failed"): boolean {
  if (!validId(id)) return false;
  const b = bus(ctx);
  const path = b.cancelPath(id);
  // Bash `[ -e ]`: a terminal receipt EXISTS only if the link resolves — a dangling
  // `.cancelled`/`.done` is no receipt, and the sender would stay outstanding for
  // ever behind it. (The lstat-based `exists` is for possible-effect markers, whose
  // mere presence is the evidence.)
  if (existsSync(path)) return true;
  if (existsSync(b.donePath(id))) return true;
  try { mkdirSync(dirname(path), { recursive: true }); } catch { return false; }
  try {
    atomicWrite(path, receiptBytes({
      id, status: "cancelled", at: isoSeconds(wallNow(ctx)), by: COURIER_IDENTITY, via: "cancelled",
      reason, target, source: "courier_expiry",
    }));
    return true;
  } catch { return false; }
}


/**
 * `tap_atomic_write_new`: exclusive create via a hard link from a fsynced temp file.
 * `false` iff the destination already exists (the incumbent's exit 1); any other
 * failure throws (its exit 2).
 */
function atomicWriteNew(dest: string, contents: string | Buffer): boolean {
  const dir = dirname(dest) || ".";
  const tmp = join(dir, `.new.${process.pid.toString(36)}${Math.random().toString(36).slice(2, 10)}`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(tmp, dest); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    return true;
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

// --- the sender notice ------------------------------------------------------------------

export type NoticeOutcome = "park-expired" | "shell-mode" | "feedback-draft" | "stuck-readiness" | "failed" | "possible" | "unconfirmed" | "unrouted" | "lock-park";

export interface NotifyInput {
  id: string;
  target: string;
  detail: string;
  targetRegistry: string;
  outcome: NoticeOutcome;
  /** The grace disposition's deterministic notice id; publication is durable custody, not a confirmed wake. */
  durableId?: string;
  /** Maintenance publishes an inbox notice without touching any pane. Requires a durable id. */
  publishOnly?: boolean;
  /** Digest members (space-separated ids) — the notice represents them all. */
  digestMembers?: string;
  /** Address the notice to this seat instead of the payload's sender (a supervising leader). */
  addressee?: string;
}

/** `tap_registry_pane_binding <registry> <handle>`, Python-tolerant: any unreadable file is `{}`. */
function paneBinding(registryPath: string, handle: string): { status: string; pane: string; paneId: string; delivery: string } | null {
  let data: unknown = {};
  // `json.load(open(path))`: strict UTF-8 — an undecodable byte anywhere is an unreadable file.
  try { data = JSON.parse(pyReadUtf8(registryPath)); } catch { data = {}; }
  // An old-format registry binds no pane: the notice stays poll-visible, and the refusal is logged.
  const oldStore = teamRegistryFileRefusal(registryPath);
  if (oldStore) {
    process.stderr.write(`tap spool-deadline: ${oldStore.errorClass}: ${oldStore.detail}; next: ${oldStore.action}\n`);
    return null;
  }
  const doc = isDict(data) ? data : {};
  const seats = isDict(doc.seats) ? doc.seats : {};
  const ent = seats[handle];
  if (!isDict(ent)) return null;
  // Python `str(x or "")`: every falsy value — None, False, 0, 0.0, "", [], {} — reads as "";
  // a truthy non-string reads as Python's `str()` of it (`['active']`, `True`), which no
  // status/delivery predicate accepts — a container never coerces into an active seat.
  const s = (v: unknown, dflt = ""): string => (pyTruthy(v) ? pyStr(v) : dflt);
  // Python `str(x or "")` with `.get("status", "active")`: an absent key defaults,
  // a present falsy one reads "".
  const field = (key: string, dflt: string): string => (Object.hasOwn(ent, key) ? s(ent[key]) : dflt);
  return { status: field("status", "active"), pane: s(ent.pane), paneId: s(ent.pane_id), delivery: field("delivery", "pane") };
}


/** Does the file contain `line` as a whole line (`grep -Fqx`)? */
function hasWholeLine(path: string, line: string): boolean {
  try { return readFileSync(path, "utf8").split("\n").includes(line); } catch { return false; }
}

/**
 * `tap_spool_notify_sender_on_escalate`: true iff the sender was already settled, or
 * was woken AND that wake was CONFIRMED delivered (a durable notice: iff published).
 * The sender is the one party who can act on a failed send on every fleet shape, so
 * the sender is the default addressee; the watcher's human alert is the second one.
 *
 * Returns false — deliberately — when the wake could not be confirmed. The caller
 * uses that to decide terminal-vs-held, so an unverified wake must not read as
 * success (this lane exists because a receipt asserted an attempt rather than an
 * effect).
 */
export function notifySenderOnEscalate(ctx: DeadlineContext, input: NotifyInput): boolean {
  const { id, target, detail, targetRegistry, durableId = "" } = input;
  if (input.publishOnly && !durableId) return false;
  const b = bus(ctx);
  // NAME THE CANONICAL PATH, not wherever the bytes sit right now: terminalize
  // promotes the entry right after a confirmed wake, so a notice naming the spool
  // path would hand the sender a pointer to a file about to move (tap-0z9l).
  const canon = b.payloadPath(id);
  const src = isFile(canon) ? canon : payloadPath(ctx.spoolDir, id);
  if (!isFile(src)) return false;
  let raw: string;
  try { raw = readFileSync(src, "utf8"); } catch { return false; }
  const kind = envelopeField(raw, "kind") ?? "";
  // SELF-RECURSION GUARD, scoped narrowly to failure notices only.
  if (kind === KIND_DELIVERY_FAILED) return false;
  const sender = input.addressee || (envelopeField(raw, "from") ?? "");
  if (!sender || sender === target) return false;
  // Resolve the SENDER's pane on the sender's own registry — the acting registry of
  // the bus being drained — falling back to the bound (recipient-team) registry only
  // when that cannot be resolved, which keeps same-team behavior byte-identical.
  const senderRegistry = ctx.actingRegistry && isFile(ctx.actingRegistry) ? ctx.actingRegistry : targetRegistry;
  if (!senderRegistry) return false;
  const row = paneBinding(senderRegistry, sender);
  // The operator (tap-gridx) has no seat that could read or settle a notice, so a
  // durable notice addressed to `user` would stay open for good: record the
  // outcome as an event instead. Only a confirmed absence of a `user` seat row
  // counts (a legacy seat keeps its notice); an unreadable registry refuses.
  if (sender === USER_IDENTITY) {
    const seat = registryPresence(ctx, targetRegistry, USER_IDENTITY);
    if (seat.state === "unobservable") return false;
    if (seat.state === "absent") { recordOperatorNotice(ctx, id, target, input.outcome); return true; }
  }
  if (!row && !durableId) return false;
  const status = row?.status ?? "", pane = row?.pane ?? "", paneId = row?.paneId ?? "", delivery = row?.delivery ?? "";
  let nid: string;
  if (!durableId) {
    if (status !== "active") return false;
    if (delivery === "poll") return false;
    if (!pane || !paneId) return false;
    nid = mintId(COURIER_IDENTITY, wallNow(ctx));
  } else {
    // The grace disposition owns this deterministic notice under the original
    // entry's claim.
    nid = durableId;
    if (!validId(nid)) return false;
  }
  const ncanon = b.payloadPath(nid);
  const digest = !!input.digestMembers;
  let knownNotice = ncanon;
  if (durableId && !existsSync(ncanon)) {
    const withdrawn = join(ctx.home,"archive",`${nid}.cancelled.md`);
    try { knownNotice = isFile(withdrawn) ? withdrawn : archivedPayload(ctx.home,nid); }
    catch { return false; }
  }
  if (durableId && knownNotice && existsSync(knownNotice)) {  // `[ -e ]`: a dangling canonical is absent
    const nraw = (() => { try { return readFileSync(knownNotice, "utf8"); } catch { return ""; } })();
    if (envelopeField(nraw, "from") !== COURIER_IDENTITY) return false;
    if (envelopeField(nraw, "to") !== sender) return false;
    if (envelopeField(nraw, "kind") !== KIND_DELIVERY_FAILED) return false;
    if (input.outcome === "park-expired") return hasWholeLine(knownNotice, `PARK EXPIRED: ${id} to ${target} reached its retention limit.`);
    if (input.outcome === "feedback-draft") return hasWholeLine(knownNotice, FEEDBACK_DRAFT_HELD(id, target));
    if (input.outcome === "stuck-readiness") return hasWholeLine(knownNotice, STUCK_READINESS_HELD(id, target));
    if (input.outcome === "shell-mode") return hasWholeLine(knownNotice, `DELIVERY HELD: ${id} to ${target} is blocked by OpenCode shell mode.`);
    if (input.outcome === "lock-park") return hasWholeLine(knownNotice, `DELIVERY QUEUED: ${id} to ${target} is waiting for the pane submit lock.`);
    if (input.outcome === "unrouted") return hasWholeLine(knownNotice, `NOT DELIVERED: ${id} to ${target} was never attempted.`);
    if (digest) return hasWholeLine(knownNotice, `Digest notice: ${nid}`);
    return hasWholeLine(knownNotice, `DELIVERY UNCONFIRMED: ${id} to ${target} may or may not have reached them.`);
  }
  // The notice decision: suppressed only when EVERY represented member has settled,
  // verified delivery, or an authorized read (a representative cannot hide siblings).
  const members = (input.digestMembers || id).split(" ").filter(Boolean);
  const terminal = members.every(member => deliveryEvidence(b, member));
  const mode = classifyNotice(input.outcome, terminal);
  if (mode === "skip") return true;
  // An empty frontmatter fence: the stamp refuses a source with no opening fence and
  // writes the real envelope fields itself. WHAT the mode says is notice.ts's.
  const body = `---\n---\n${noticeBody(digest && mode === "unconfirmed" ? "unconfirmed-digest" : mode, id, target, canon, detail, nid)}`;
  // Courier authorship through the SANCTIONED path (the way the courier's digests
  // are minted): reply=settle-only keeps the notice terminal-informational.
  // Custody is taken here, never inside canonicalPlaceLocked: send/reply call
  // that already holding it, and a nested acquire would block on itself.
  let placed: ReturnType<typeof withResetCustody<void>>;
  try {
    placed = withResetCustody(ctx.home, "courier notice", () => canonicalPlaceLocked(b, body,
      { id: nid, from: COURIER_IDENTITY, to: sender, kind: KIND_DELIVERY_FAILED, path: ncanon, reply: "settle-only" }));
  } catch { return false; }
  if (!placed.ok) { effectLeftInPlace(ctx, "notice", nid, placed.refusal); return false; }
  if (input.publishOnly) return true;
  if (durableId) {
    // A later drain never repeats this notice's possible pane effect. Poll/read still
    // exposes the published notice when no pane is available.
    if (!(status === "active" && delivery !== "poll" && pane && paneId)) return true;
  }
  const senderRow = seatMap(loadRegistryLoose(senderRegistry))[sender];
  if (!senderRow) return false;
  const submit = ctx.submit ?? submitNotice;
  let result: ReturnType<typeof submitNotice>;
  try {
    result = submit({
      bus: b, id: nid, pane,
      bound: { paneId, handle: sender, instance: String(senderRow.instance ?? ""), bootId: String(senderRow.boot_id ?? ""),
        serverEpoch: String(senderRow.server_epoch ?? ""), harness: String(senderRow.harness ?? "") },
      authority: { registryPath: senderRegistry, recipient: sender, busHome: ctx.home, agentFamilies: AGENT_FAMILIES,
        scriptsDir: ctx.scriptsDir },
    });
  } catch { return false; }
  // Durable callers own publication, not a confirmed wake.
  if (durableId) return true;
  return result.status === "injected" || result.status === "harness_queued";
}

/** `loadRegistry` refuses numerics JS cannot hold; the notice-submit adapter read
 *  the same file through it, so a refusal there was already a failed notice. */
function loadRegistryLoose(path: string): ReturnType<typeof loadRegistry> {
  try { return loadRegistry(path); } catch { return {}; }
}

// --- the unconfirmed disposition --------------------------------------------------------

export interface UnconfirmedInput {
  id: string;
  target: string;
  pane: string;
  registry: string;
  /** Why the courier stopped: `grace_deadline`, `redelivery_submit_unverified`, `redelivery_rate_limited`. */
  reason: string;
  /** What was observed of the sentinel: `none` only when the courier proved it never reached the pane. */
  effect: "possible" | "none";
  detail: string;
  events?: readonly string[];
  /** False when the caller could not retire its spool entry: the orphan sweep stamps it instead. */
  receipt?: boolean;
}

/**
 * The honesty stamp every terminal possible-attempt disposition shares (tap-67y3s):
 * publish the deterministic `<id>-delivery-unconfirmed` sender notice, then write the
 * `.unconfirmed` receipt naming it and its events once. The receipt is written only
 * when the notice actually published, so it never names a notice that does not exist.
 * `suppressed`: a late settlement or delivery (or operator mail) published no notice.
 * The caller owns custody, escalation and retry; this step never re-parks or retries.
 * With `receipt: false` it publishes the notice and its events only: a receipt beside a
 * retained metadata sidecar would stop the orphan sweep from ever archiving it.
 */
export function publishUnconfirmed(ctx: DeadlineContext, input: UnconfirmedInput): "published" | "suppressed" | "failed" {
  const { id, target, pane, registry, reason, effect, detail, events = ["spool_terminal_delivery_unconfirmed"], receipt: stamp = true } = input;
  const b = bus(ctx);
  const notice = `${id}-delivery-unconfirmed`, receipt = join(b.receiptsDir, `${id}.unconfirmed`);
  const notify = () => notifySenderOnEscalate(ctx, { id, target, targetRegistry: registry, outcome: "unconfirmed", durableId: notice, detail });
  // The notifier reports false when its optional pane wake fails AFTER publishing. A
  // second call re-validates the published notice as ours (no pane effect) so the
  // stamp is not lost; a foreign file at that path still refuses.
  if (!notify() && !(isFile(b.payloadPath(notice)) && notify())) return "failed";
  // A late settlement/delivery can suppress publication inside the notifier. Only a
  // published notice can be named by the disposition receipt/events.
  if (!isFile(b.payloadPath(notice))) return "suppressed";
  if (exists(receipt)) return isFile(receipt) ? "published" : "failed";
  if (stamp) {
    const bytes = `${jsonObj({ id, status: "unconfirmed", effect, notice_id: notice,
      at: isoSeconds(wallNow(ctx)), by: COURIER_IDENTITY, reason, target })}\n`;
    try { if (!atomicWriteNew(receipt, bytes)) return "failed"; } catch { return "failed"; }
  }
  for (const action of events) {
    appendRegistryEventOrWarn(ctx.verbLabel, {
      log: ctx.eventLog, actor: "courier", action, handle: target, pane, team: ctx.team,
      detail: `id=${id} notice_id=${notice}`, env: envOf(ctx),
    });
  }
  return "published";
}

// --- the grace disposition ---------------------------------------------------------------

/**
 * `tap_spool_dispose_grace <id> <target> <pane> <registry>` — caller holds the claim.
 * A refused grace park that already carries a possible-effect marker: publish the
 * deterministic unconfirmed notice, keep the spool copy until explicit settlement
 * (custody on a partial write; `cancel --spooled` stays available), write the
 * `.unconfirmed` receipt and its two events once, mark escalated, and alert the
 * human ONCE — the marker for that is written only AFTER the alert succeeds, because
 * marking first would turn a failed alert into permanent silence.
 */
export function disposeGrace(ctx: DeadlineContext, id: string, target: string, pane: string, registry: string): boolean {
  if (isDone(ctx, id)) return true;
  const b = bus(ctx);
  const canon = b.payloadPath(id);
  const spoolPayload = payloadPath(ctx.spoolDir, id);
  if (!isFile(canon)) {
    let bytes: Buffer;
    try { bytes = readFileSync(spoolPayload); } catch { return false; }
    try { if (!atomicWriteNew(canon, bytes)) return false; } catch { return false; }
  }
  try {
    if (!readFileSync(canon).equals(readFileSync(spoolPayload))) return false;
  } catch { return false; }
  // (The incumbent exported TAP_SUBMIT_PRESERVE_DRAFT=1 around this call. The notice
  // submit has been native since notice-submit.ts and never read it, so the variable
  // reached nothing; it is dropped rather than carried as a no-op.)
  // Operator mail (tap-gridx) has no seat to read a notice: record the outcome
  // as an event, then escalate and alert exactly as a published notice does, so
  // the entry reaches operator retirement. An unreadable registry holds.
  let operator = false;
  if (envelopeField(readFileSync(canon, "utf8"), "from") === USER_IDENTITY) {
    const seat = registryPresence(ctx, registry, USER_IDENTITY);
    if (seat.state === "unobservable") return false;
    operator = seat.state === "absent";
  }
  if (operator) {
    // The same delivery evidence that suppresses a seat's notice ends here too:
    // a delivered or read operator note must never escalate toward cancellation.
    if (classifyNotice("unconfirmed", deliveryEvidence(b, id)) === "skip") return true;
    recordOperatorNotice(ctx, id, target, "unconfirmed");
  } else {
    const published = publishUnconfirmed(ctx, { id, target, pane, registry, reason: "grace_deadline", effect: "possible",
      detail: "grace deadline reached after a possible attempt; automatic recipient retry stopped",
      events: ["redelivery_submit_unverified", "spool_terminal_delivery_unconfirmed"] });
    if (published === "failed") return false;
    if (published === "suppressed") return true;
  }
  markEscalated(ctx, id);
  if (ctx.alert.mode !== "none" && metaField(ctx.spoolDir, id, "human_escalated_at") === "") {
    if (alertHuman(ctx, id, target, "reason=grace_deadline delivery=unconfirmed") !== 0) return false;
    if (!markEscalated(ctx, id, "human_escalated_at")) return false;
  }
  return true;
}

/**
 * The watcher's human alert (formerly its `tap_spool_on_escalate` callback), composed
 * the way that callback composed it — the queued watch probe's own id names the probe
 * timeout; anything else is a spool entry at its deadline — and published through the
 * same door (`notifyHuman`, watch-notice.ts).
 */
export function alertHuman(ctx: DeadlineContext, id: string, target: string, detail: string): number {
  if (ctx.alert.mode !== "tick") return 0;
  const queuedProbeId = ctx.alert.queuedProbeId;
  const probeTimeout = ctx.alert.probeTimeout || "?";
  const reason = queuedProbeId && id === queuedProbeId
    ? `watch probe ${id} for '${target}' remained queued past its ${probeTimeout}s delivery deadline (${detail}) — needs a human`
    : `spool entry ${id} for '${target}' reached its delivery deadline (${detail}) — needs a human`;
  const publish = ctx.notifyHuman ?? notifyHuman;
  // `watch-notice.ts notify-human` stamps `TAP_WATCH_NOW` when set, else the wall clock.
  const now = envOf(ctx).TAP_WATCH_NOW || String(Math.floor(wallNow(ctx).getTime() / 1000));
  return publish({ bus: ctx.home, scripts: ctx.scriptsDir, reason, kind: "spool", now, env: envOf(ctx) });
}

// --- the transactions ---------------------------------------------------------------------

export type DeadlineVerdict =
  | "not-due"             // no deadline, or `now` before it — the caller's ordinary path continues
  | "claim-held"          // another drain holds the entry; nothing done
  | "held-present"        // readiness-gate/window park whose recipient is demonstrably there: silent hold
  | "grace-disposed"      // a grace park with a possible attempt: disposition ran (its own failure is an event)
  | "reprobe-unreadable"  // the grace reprobe question could not be answered (metadata unreadable)
  | "reprobe-eligible"    // a refused pre-effect grace park keeps its waiter (never the watcher's queued probe)
  | "escalate-declined"   // settled, gone, or already marked between the gate and the claim
  | "alert-pending"       // the watcher probe's alert did not publish: left unmarked for the next tick
  | "escalated"           // marked; the sender was NOT confirmed woken (or the class owes no wake): entry stays escalated-and-held
  | "terminalized";       // marked, sender confirmed woken, retry state removed

function due(ctx: DeadlineContext, deadlineEpoch: string): boolean {
  // `[ -n "$deadline_epoch" ] && [ "$now" -ge "$deadline_epoch" ]`: Bash integer
  // comparison; a non-integer deadline made `[` fail (non-zero) — not due.
  if (!/^-?\d+$/.test(deadlineEpoch)) return false;
  return BigInt(Math.trunc(ctx.now)) >= BigInt(deadlineEpoch);
}

function entryFiles(ctx: DeadlineContext, id: string): boolean {
  return isFile(payloadPath(ctx.spoolDir, id)) && isFile(metaPath(ctx.spoolDir, id));
}

/**
 * Phase B's escalation branch: the entry reached its deadline WITHOUT delivering
 * this tick. Under the claim (escalation is an effect too — a losing contender must
 * not notify while a winning claimant is still submitting the same entry):
 *
 *  1. HOLD a placed payload to a seat that is demonstrably there (tap-92v3r): a
 *     readiness-gate or window park whose recipient is present stays parked and
 *     the ordinary retry keeps working it. Silently — there is no honest notice
 *     to send while the entry is unpromoted.
 *  2. A grace park with a possible attempt is disposed (never retried).
 *  3. A refused, pre-effect grace park keeps its waiter while the recipient is
 *     ready or busy — a deadline is not evidence that it cannot deliver. The
 *     watcher's own queued probe is the exception to holds 1 and 3: its probe_timeout
 *     is a bounded alert obligation, so it falls through to the alert and the mark.
 *  4. Otherwise RE-CHECK SETTLEMENT INSIDE THE CRITICAL SECTION (P5), mark
 *     escalated, alert the human when the watcher is present, and — for the two
 *     classes whose deadline this lane MINTED (readiness-gate, autosettle-hold) —
 *     wake the sender; ONLY a confirmed wake terminalizes (promote + drop retry
 *     state), and an autosettle-hold park also gets its `.cancelled` receipt so the
 *     sender's queue can clear.
 */
export async function disposeAtDeadline(ctx: DeadlineContext, row: DeadlineRow, ready: string): Promise<DeadlineVerdict> {
  if (!due(ctx, row.deadlineEpoch)) return "not-due";
  const claim = claimAcquire(ctx.spoolDir, row.id, false, envOf(ctx));
  if (claim.status !== "acquired") return "claim-held";
  try {
    // The watcher's own queued probe is bounded by probe_timeout: once this tick's safe
    // redelivery did not land, no hold below keeps it — it escalates with its one sticky alert.
    const watcherProbe = ctx.alert.mode === "tick" && ctx.alert.queuedProbeId !== "" && row.id === ctx.alert.queuedProbeId;
    if (!watcherProbe && (row.deadlineSource === "readiness-gate" || row.reasonClass === "window") && recipientIsPresent(ready)) return "held-present";
    // Keep the bounded owner alive if a modal or redraw temporarily prevents the
    // exact submit-in-place. This per-id authority never reaches digest admission.
    if (!watcherProbe && pendingReprobe(ctx.home, row.id) && recipientIsPresent(ready)) return "reprobe-eligible";
    if (graceAttempted(ctx, row.id)) {
      if (!disposeGrace(ctx, row.id, row.target, row.pane, row.targetRegistry)) {
        appendRegistryEventOrWarn(ctx.verbLabel, {
          log: ctx.eventLog, actor: "courier", action: "grace_disposition_incomplete", handle: row.target, pane: row.pane,
          team: ctx.team, detail: `id=${row.id}`, env: envOf(ctx),
        });
      }
      return "grace-disposed";
    }
    // `spool-grace.ts reprobe`: an unreadable/invalid sidecar was a nonzero exit,
    // and the incumbent released and moved on.
    let meta: unknown;
    try { meta = JSON.parse(readFileSync(metaPath(ctx.spoolDir, row.id), "utf8")); } catch { return "reprobe-unreadable"; }
    if (!isDict(meta)) return "reprobe-unreadable";
    // `spool-grace.ts`: `possible = True` unless lstat says ENOENT — an unreadable
    // marker is conservatively a possible effect.
    let possible = true;
    try { lstatSync(currentAttemptMarker(ctx.home, ctx.spoolDir, row.id)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") possible = false; }
    if (!watcherProbe && graceCanReprobe(meta, possible) && (ready === "ready" || ready === "busy" || ready.startsWith("busy:"))) return "reprobe-eligible";
    if (isDone(ctx, row.id) || !entryFiles(ctx, row.id)) return "escalate-declined";
    if (watcherProbe) {
      // Alert BEFORE the mark: escalated rows leave the drain, so a failed publication
      // must leave the probe unmarked for the next tick. Under the claim, an absent
      // mark is the per-entry dedup.
      if (metaField(ctx.spoolDir, row.id, "escalated_at") !== "") return "escalate-declined";
      if (alertHuman(ctx, row.id, row.target, `reason=${row.reason} ready=${ready}`) !== 0) return "alert-pending";
      if (!markEscalated(ctx, row.id)) return "escalate-declined";
    } else {
      if (!markEscalated(ctx, row.id)) return "escalate-declined";
      // The watcher's hook still fires when defined — TWO addressees are fine; ZERO
      // was the defect (tap-13c8). Its result was never read at this site.
      if (ctx.alert.mode !== "none") alertHuman(ctx, row.id, row.target, `reason=${row.reason} ready=${ready}`);
    }
    if (row.deadlineSource !== "readiness-gate" && row.deadlineSource !== "autosettle-hold") return "escalated";
    if (!notifySenderOnEscalate(ctx, { id: row.id, target: row.target, detail: `reason=${row.reason} ready=${ready}`,
      targetRegistry: row.targetRegistry, outcome: "failed" })) return "escalated";
    await terminalize(ctx, row.id, row.target, row.pane, "deadline_reached");
    ctx.signal?.throwIfAborted();
    // KNOWN GAP, TRACKED (tap-i6vj): promotion and this receipt do not share an outcome.
    if (row.deadlineSource === "autosettle-hold") writeDeliveryFailedReceipt(ctx, row.id, row.target, "deadline_reached");
    return "terminalized";
  } finally {
    claimRelease(ctx.spoolDir, row.id, claim.token);
  }
}

/** Absence requires a current same-team document, never a failed pane lookup. */
function senderPresence(ctx: DeadlineContext, row: DeadlineRow, sender: string):
  { state: "absent" | "present" } | { state: "unobservable"; reason: string } {
  return registryPresence(ctx, row.targetRegistry, sender);
}

/**
 * Settled, verified delivery, or an authorized read: the evidence that suppresses a
 * sender notice. `[ -f ]`, as `tap_is_done` asks (lib.sh:1779) and as `isDone`
 * already answers: a DIRECTORY at `receipts/<member>.done` is not a settlement, and
 * reading it as one suppressed a notice for a message nobody settled (rule 38).
 */
function deliveryEvidence(b: Bus, member: string): boolean {
  return isFile(join(b.receiptsDir, `${member}.done`)) || isFile(join(b.receiptsDir, `${member}.sent`))
    || hasRecipientRead(b.receiptsDir, member);
}

function recordOperatorNotice(ctx: DeadlineContext, id: string, target: string, outcome: string): void {
  appendRegistryEventOrWarn(ctx.verbLabel, { log: ctx.eventLog, actor: "courier", action: "spool_notice_operator_recorded",
    handle: USER_IDENTITY, pane: "", team: ctx.team, detail: `id=${id} target=${target} outcome=${outcome}`, env: envOf(ctx) });
}

/** Whether `handle` has a seat row on the acting registry (else `fallback`). */
export function registryPresence(ctx: DeadlineContext, fallback: string, handle: string):
  { state: "absent" | "present" } | { state: "unobservable"; reason: string } {
  const registry = isFile(ctx.actingRegistry) ? ctx.actingRegistry : fallback;
  try {
    if (!isFile(registry)) throw new Error("registry unavailable");
    const doc = loadCurrentRegistry(registry);
    if (!ctx.team || !isDict(doc.team) || typeof doc.team.name !== "string" || pyStrip(doc.team.name) !== ctx.team)
      throw new Error("registry team mismatch");
    if (!isDict(doc.seats)) throw new Error("registry seats unavailable");
    return { state: Object.hasOwn(doc.seats, handle) ? "present" : "absent" };
  } catch (error) { return { state: "unobservable", reason: String(error) }; }
}

/** Recover escalated custody without a pane effect when its sender has left. */
export async function disposeSenderGone(ctx: DeadlineContext, row: DeadlineRow): Promise<boolean> {
  if (!row.escalatedAt) return false;
  const claim = claimAcquire(ctx.spoolDir, row.id, false, envOf(ctx));
  if (claim.status !== "acquired") return false;
  try {
    if (isDone(ctx, row.id) || !entryFiles(ctx, row.id)) return false;
    const meta = JSON.parse(pyReadUtf8(metaPath(ctx.spoolDir, row.id)));
    if (!isDict(meta) || typeof meta.escalated_at !== "string") return false;
    const escalated = Date.parse(meta.escalated_at) / 1000;
    if (!Number.isFinite(escalated) || ctx.now < escalated + ctx.unroutedGrace) return false;
    const sender = envelopeField(pyReadUtf8(payloadPath(ctx.spoolDir, row.id)), "from");
    const env = envOf(ctx);
    // The operator (tap-gridx) has no seat row to prove it left and no seat to
    // notify, so its escalated note never becomes deliverable by waiting. Past
    // the same grace it retires outright; terminalize writes the `.cancelled`
    // receipt that clears `tap outstanding user`. A legacy seat named `user`
    // still has its row: its mail takes the ordinary sender-presence path below.
    if (sender === USER_IDENTITY && senderPresence(ctx, row, sender).state === "absent") {
      return await terminalize(ctx, row.id, row.target, row.pane, "operator_undeliverable", "spool_terminal_operator_undeliverable");
    }
    // Never-registrable identities cannot prove departure by a missing seat row.
    if (!sender || [COURIER_IDENTITY, WATCH_IDENTITY, HELP_HANDLE, env.TAP_WATCH_IDENTITY].includes(sender)
      || (env.TAP_RESERVED_HANDLES ?? "").split(/\s+/).includes(sender)) return false;
    // Observe under the spool claim, without a registry lock across reset custody.
    // A returning sender can still find the preserved canonical body.
    const presence = senderPresence(ctx, row, sender);
    if (presence.state === "unobservable") {
      appendRegistryEventOrWarn(ctx.verbLabel, { log: ctx.eventLog, actor: "courier",
        action: "spool_sender_unobservable", handle: sender, pane: "", team: ctx.team,
        detail: `id=${row.id} reason=${presence.reason}`, env: envOf(ctx) });
    }
    if (presence.state !== "absent") return false;
    if (!await terminalize(ctx, row.id, row.target, row.pane, "sender_gone", "spool_terminal_sender_gone")) return false;
    if (meta.deadline_source === "autosettle-hold") writeDeliveryFailedReceipt(ctx, row.id, row.target, "sender_gone");
    return true;
  } finally { claimRelease(ctx.spoolDir, row.id, claim.token); }
}

export type GraceDueVerdict =
  | "not-grace"        // no possible-effect grace marker: the caller's ordinary path continues
  | "grace-waiting"    // marked, and left for a later tick: not yet due, or another drain holds the claim
  | "grace-disposed";  // disposition ran under the claim (its own failure is an event)

/**
 * Phase B's pre-gate: recover old escalated grace entries before the general
 * exclusion. Neither phase may retry a possible effect while notice publication is
 * incomplete, so a marked grace entry leaves the loop here whether or not it is due.
 */
export function disposeGraceDue(ctx: DeadlineContext, row: DeadlineRow): GraceDueVerdict {
  // The ordinary loop owns this exact per-id submit-in-place recovery. Keeping
  // it out of the generic grace pre-gate does not make it digest-eligible:
  // Phase A still sees graceAttempted() above and excludes it.
  if (pendingReprobe(ctx.home, row.id)) return "not-grace";
  if (!graceAttempted(ctx, row.id)) return "not-grace";
  if (!due(ctx, row.deadlineEpoch)) return "grace-waiting";
  const claim = claimAcquire(ctx.spoolDir, row.id, false, envOf(ctx));
  if (claim.status !== "acquired") return "grace-waiting";
  try {
    if (!disposeGrace(ctx, row.id, row.target, row.pane, row.targetRegistry)) {
      appendRegistryEventOrWarn(ctx.verbLabel, {
        log: ctx.eventLog, actor: "courier", action: "grace_disposition_incomplete", handle: row.target, pane: row.pane,
        team: ctx.team, detail: `id=${row.id}`, env: envOf(ctx),
      });
    }
    return "grace-disposed";
  } finally {
    claimRelease(ctx.spoolDir, row.id, claim.token);
  }
}

export type UnroutedVerdict =
  | "routable"            // the entry has a binding the drain can route: the caller's ordinary path continues
  | "settled"             // excluded AND settled: reconciled (promoted or removed)
  | "unrouted-waiting"    // marked unroutable; not yet aged out, or the age is unobservable
  | "unrouted-escalated"; // aged out: marked, promoted as `unrouted`, sender told no attempt was made

/**
 * `tap_registry_matches_team <registry> <expected>`: an empty expectation is unqualified.
 * The incumbent: `((json.load(open(f)).get("team") or {}).get("name") or "").strip()` —
 * strict UTF-8 (an undecodable byte is an unreadable registry: no match); a falsy name
 * is ""; a truthy NON-string name has no `.strip()` and raised: no match; the strip is
 * Python's whitespace set (NEL stripped, a BOM kept), not JavaScript's.
 */
export function registryMatchesTeam(registryPath: string, expectedTeam: string): boolean {
  if (!expectedTeam) return true;
  if (!isFile(registryPath)) return false;
  try {
    const doc = JSON.parse(pyReadUtf8(registryPath));
    const team = isDict(doc) && isDict(doc.team) ? doc.team.name : undefined;
    if (!pyTruthy(team)) return "" === expectedTeam;
    if (typeof team !== "string") return false;
    return pyStrip(team) === expectedTeam;
  } catch { return false; }
}

/**
 * Phase B's escape route for an entry excluded from every delivery path (tap-6vwz):
 * a legacy mark, a missing binding field, or a registry that no longer names the
 * bound team. Read at the STATE, not keyed to the reason string, so the next terminal
 * condition inherits the route by construction. RECONCILE BEFORE DISPOSING: a sunk
 * entry can still be settled by any route. Then mark unroutable (fail-closed, keeps
 * the predecessor reason), and once it has aged past `TAP_SPOOL_UNROUTED_GRACE` from
 * its deadline — or, with no deadline (the oldest shape there is), from its park —
 * promote it as `unrouted` and tell the sender no attempt was ever made, never that
 * delivery failed.
 */
export async function disposeUnrouted(ctx: DeadlineContext, row: DeadlineRow): Promise<UnroutedVerdict> {
  const excluded = row.reason === "legacy_meta_no_binding" || !row.targetRegistry || !row.paneId || !row.pane
    || !registryMatchesTeam(row.targetRegistry, row.toTeam);
  if (!excluded) return "routable";
  if (isDone(ctx, row.id)) {
    await reconcileSettled(ctx, row);
    return "settled";
  }
  markLegacyNoBinding(ctx.spoolDir, row.id, ctx.eventLog, ctx.team, ctx.verbLabel, wallNow(ctx), envOf(ctx));
  const from = row.deadlineEpoch || row.firstEpoch;
  // `[ "$now" -ge "$(( from + grace ))" ]`: Bash arithmetic on the field. A
  // non-integer `from` made `$(( ))` an error (the drain kept going, un-escalated).
  // Publication deliberately preserves a whole-number JSON float as `.0`; accept
  // that integer value so an upgraded legacy sidecar cannot strand forever.
  const integerFrom = /^-?\d+$/.test(from) ? from : /^-?\d+\.0+$/.test(from) ? from.slice(0, from.indexOf(".")) : "";
  if (!integerFrom) return "unrouted-waiting";
  const aged = BigInt(Math.trunc(ctx.now)) >= BigInt(integerFrom) + BigInt(Math.trunc(ctx.unroutedGrace));
  if (!aged || row.escalatedAt || isDone(ctx, row.id)) return "unrouted-waiting";
  const claim = claimAcquire(ctx.spoolDir, row.id, false, envOf(ctx));
  if (claim.status !== "acquired") return "unrouted-waiting";
  try {
    // Re-read under the claim: an id settled or delivered in the window between the
    // gate above and here must not be told it went nowhere.
    if (isDone(ctx, row.id) || !isFile(metaPath(ctx.spoolDir, row.id)) || !markEscalated(ctx, row.id)) return "unrouted-waiting";
    // PROMOTE AND NOTIFY ARE ONE ACT (tap-0z9l): the notice names the canonical path,
    // which exists only because terminalize promotes it first.
    if (!await terminalize(ctx, row.id, row.target, row.pane, "unrouted", "spool_terminal_unrouted")) return "unrouted-waiting";
    ctx.signal?.throwIfAborted();
    notifySenderOnEscalate(ctx, { id: row.id, target: row.target, targetRegistry: row.targetRegistry, outcome: "unrouted",
      detail: `excluded from every delivery path by reason='${row.reason}'; no delivery was ever attempted` });
    return "unrouted-escalated";
  } finally {
    claimRelease(ctx.spoolDir, row.id, claim.token);
  }
}

/**
 * The settled reconcile Phase B runs at three sites: a settled entry is terminal, and
 * `tap_spool_remove` is the raw retry-state cleaner that deletes the sole copy, so
 * promote first; a promotion failure must not strand the row (`|| tap_spool_remove`).
 */
export async function reconcileSettled(ctx: DeadlineContext, row: DeadlineRow): Promise<void> {
  if (!await terminalize(ctx, row.id, row.target, row.pane, "settled", "spool_terminal_settled")) {
    if (!validId(row.id)) throw new Error(`spool_remove: id '${row.id}' fails charset`);
    await removeEntryAsync(ctx.spoolDir, row.id, ctx.signal, envOf(ctx));
  }
}

// --- CLI (the adapters' door) ---------------------------------------------------------------
//
// Common prefix, all facts the Bash caller already held:
//   <home> <spool> <event-log> <team> <verb-label> <acting-registry> <scripts-dir>
//   <alert-mode none|tick> <queued-probe-id> <probe-timeout> <now> <unrouted-grace>
// then the verb and its arguments:
//   at-deadline <ready> <15 row fields>     → DeadlineVerdict
//   grace-due <15 row fields>               → GraceDueVerdict
//   unrouted <15 row fields>                → UnroutedVerdict
//   reconcile-settled <15 row fields>       → ok
//   terminalize <id> <handle> <pane> <reason> <action>   → ok | failed
//   notify <id> <target> <detail> <registry> <outcome> [<durable-id> [<digest-members>]] → woken | unwoken
//   grace-attempted <id>                    → yes | no
//   recipient-present <ready>               → present | absent
// Every verdict above is a decided outcome at exit 0; nonzero is a slice failure.

const PREFIX_ARGS = 12;

function parseRow(fields: string[]): DeadlineRow {
  if (fields.length !== ROW_FIELDS.length) throw new Error(`expected ${ROW_FIELDS.length} row fields, got ${fields.length}`);
  const row = {} as Record<keyof DeadlineRow, string>;
  ROW_FIELDS.forEach((key, index) => { row[key] = fields[index]!; });
  return row;
}

function parseContext(argv: string[]): DeadlineContext {
  const [home, spoolDir, eventLog, team, verbLabel, actingRegistry, scriptsDir, alertMode, queuedProbeId, probeTimeout, nowRaw, graceRaw] = argv;
  if (!home || !spoolDir || !eventLog || verbLabel === undefined || scriptsDir === undefined || nowRaw === undefined || graceRaw === undefined) {
    throw new Error("home, spool, event log, team, verb label, acting registry, scripts dir, alert, now and unrouted grace required");
  }
  let alert: HumanAlert;
  switch (alertMode) {
    case "none": alert = { mode: "none" }; break;
    case "tick": alert = { mode: "tick", queuedProbeId: queuedProbeId ?? "", probeTimeout: probeTimeout ?? "" }; break;
    default: throw new Error(`alert mode must be none|tick, got '${alertMode}'`);
  }
  if (!/^-?\d+$/.test(nowRaw)) throw new Error(`now must be an integer epoch, got '${nowRaw}'`);
  if (!/^-?\d+$/.test(graceRaw)) throw new Error(`unrouted grace must be an integer, got '${graceRaw}'`);
  return { home, spoolDir, eventLog, team: team ?? "", verbLabel, actingRegistry: actingRegistry ?? "", scriptsDir, alert,
    now: Number(nowRaw), unroutedGrace: Number(graceRaw) };
}

export async function main(argv: string[], signal?: AbortSignal): Promise<number> {
  const ctx = parseContext(argv.slice(0, PREFIX_ARGS));
  ctx.signal = signal;
  const [verb, ...rest] = argv.slice(PREFIX_ARGS);
  switch (verb) {
    case "at-deadline": {
      const [ready, ...fields] = rest;
      if (ready === undefined) throw new Error("at-deadline needs <ready> and the row");
      console.log(await disposeAtDeadline(ctx, parseRow(fields), ready));
      return 0;
    }
    case "grace-due":
      console.log(disposeGraceDue(ctx, parseRow(rest)));
      return 0;
    case "unrouted":
      console.log(await disposeUnrouted(ctx, parseRow(rest)));
      return 0;
    case "reconcile-settled":
      await reconcileSettled(ctx, parseRow(rest));
      console.log("ok");
      return 0;
    case "terminalize": {
      const [id, handle, pane, reason, action] = rest;
      if (!id) throw new Error("terminalize needs <id>");
      console.log(await terminalize(ctx, id, handle ?? "", pane ?? "", reason || "delivery_failed", action || "spool_terminal_delivery_failed") ? "ok" : "failed");
      return 0;
    }
    case "notify": {
      const [id, target, detail, registry, outcome, durableId, digestMembers] = rest;
      if (!id || outcome === undefined) throw new Error("notify needs <id> <target> <detail> <registry> <outcome>");
      if (!["failed", "possible", "unconfirmed", "unrouted", "lock-park"].includes(outcome)) throw new Error(`unknown notice outcome: ${outcome}`);
      const woken = notifySenderOnEscalate(ctx, { id, target: target ?? "", detail: detail ?? "", targetRegistry: registry ?? "",
        outcome: outcome as NoticeOutcome, durableId: durableId || undefined, digestMembers: digestMembers || undefined });
      console.log(woken ? "woken" : "unwoken");
      return 0;
    }
    case "grace-attempted": {
      const [id] = rest;
      if (!id) throw new Error("grace-attempted needs <id>");
      console.log(graceAttempted(ctx, id) ? "yes" : "no");
      return 0;
    }
    case "recipient-present": {
      const [ready] = rest;
      console.log(recipientIsPresent(ready ?? "") ? "present" : "absent");
      return 0;
    }
    default:
      throw new Error(`usage: spool-deadline.ts <context…> <at-deadline|grace-due|unrouted|reconcile-settled|terminalize|notify|grace-attempted|recipient-present> …`);
  }
}

if (import.meta.main) {
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") { process.stderr.write("tap spool-deadline: stdout EPIPE\n"); process.exit(1); }
    throw error;
  });
  const controller = new AbortController();
  let stopped = 0;
  const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(signal => {
    const stop = () => { if (!controller.signal.aborted) { stopped = signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143; controller.abort(); } };
    process.on(signal, stop); return [signal, stop] as const;
  });
  try {
    process.exitCode = await main(Bun.argv.slice(2), controller.signal);
  } catch (error) {
    if (!stopped) console.error(String(error instanceof Error ? error.message : error));
    process.exitCode = stopped || 2;
  } finally {
    for (const [signal, stop] of handlers) process.off(signal, stop);
  }
}
