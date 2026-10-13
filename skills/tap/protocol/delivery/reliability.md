# Delivery reliability

TAP delivery is **at-least-once, best effort**, measured in nines. Its service
target is **99.9% recipient-observed messages**, measured from receipts as
defined in [Delivery receipt measures](./receipt-measures.md). The target is not
proof that an agent processed the instructions; best effort promises neither
eventual execution nor exactly-once effects.

## Persistence, doorbells and recovery

A successful send leaves the message on disk before returning. If placement
fails, send fails visibly. Atomic placement is a process-level persistence
contract; it does not promise survival of storage failure or power loss.

The sentinel is a best-effort doorbell, and it may ring twice: a repeat carries
the same id and is not a failure. A possible effect does not license arbitrary
replay. The courier never starts another injection attempt on its own after a
possible effect; the one blessed re-entry is the sender's
[explicit same-ID retry](#explicit-same-id-retry). Pre-effect refusal or parking
is not an injection; ordinary deferred delivery may proceed only under its
existing identity, custody and no-effect rules. Courier-automatic retry is
deferred until measured unobserved mail or repeated manual recovery shows its
value. The no-retry rule still holds for non-idempotent control and mutation effects.

The forward **no-silent-misses requirement** is recoverability: unconfirmed mail
stays pollable and unfinished work stays visible to a responsible sender,
recipient or supervisor. An `.unconfirmed` receipt, an aging `tap outstanding`
entry or a visible pending retry can expose the work. Explicit cancellation
records a disposition; it is not recipient observation.

A loud pre-placement refusal alone is insufficient if it leaves neither a
pending item nor a scheduled retry. That gap is open: a review request and its
escalation can both refuse with `reset_custody_busy` and leave no `.placed`
receipt (one stall: ~50 min), invisible to both ratios in
[Delivery receipt measures](./receipt-measures.md).
Refusals are now countable but not yet recoverable. A send refused before
placement, or withdrawn after placing (`--no-spool`, manual-relay park,
clear-fence or pane refusal), appends one tab-separated line to
`send-refusals.log` under `$TAP_INDEX_HOME` (default `~/.tap`): UTC time,
sender, recipient, team, error id, phase (`pre` or `withdrawn`; a five-field
legacy row is `pre`); `-` is an unresolved field; no body. Count per night, generations included: `cut -c1-10 send-refusals.log* | sort | uniq -c`. Best effort and silent;
at 1 MiB it rotates to a dated generation, keeping two (3 MiB). A refused
ask still leaves no pending item (revisit if a seat loses a refusal). A
withdrawn send may keep its `.placed`: count `withdrawn` as its own series.

The killed-mid-attempt window is closed the same way (tap-c9vlf, September 24,
2026). The drain marks `repark_pending` write-ahead, before it moves a parked
body to `payloads/`, so a kill between that move and the disposition strands a
licensed entry — mark, no attempt evidence — that the waiter or the next armed
watch tick moves back and delivers, rather than an unmarked body the orphan
sweep retires as unconfirmed. The mark licenses a repark only without attempt
evidence: mark plus `.attempted` is a possible effect, surfaced as unconfirmed,
never moved back and never silently retired. Nothing in the window may end as an
unconfirmed retirement of a message that provably had no effect.

The mark itself never strands an entry. A busy metadata lock, a failed metadata
read, or a failed write refuses the move and reports
`spool_repark_unmarked reason=busy`; nothing was attempted, the body stays
parked, and the next drain retries it. Absent metadata is created minimal under
the same lock, so the write-ahead still holds. Metadata that was read but does
not decode or parse is evidence and is never rewritten: the body delivers
without the mark, losing kill-window protection for that one entry, and reports
`spool_repark_unmarked reason=unparseable` rather than refusing forever.

**Courier drain effects under reset custody (tap-g191v).** Team reset copies `payloads/`, then `receipts/`, then `spool/` as separate components, so a body moved or minted between two copies would reach neither archive. Each durable drain effect holds reset custody with its fence rechecked: the canonical move before submit, the shared native `.attempted` mint (including the Bash door), each post-submit receipt/removal or repark, the digest canonicalize, terminalization, retirement (canonical link, `.cancelled` and removal as one span) and courier notice placement, taken at the notice callers and never inside `canonicalPlaceLocked`. Readiness, identity probes, copy-mode exit and submit stay outside custody. Obligation/claim/pane locks may enclose reset. Reset precedes metadata/clock/event locks, taken one at a time with `RESET_HELD_LOCK_WAIT_MS` (one second); never acquire reset while holding one. Reset holders do no pane I/O, spawn, day-long metadata wait or coordination-lock wait, without an exception for cancel. The other holders follow the same bound (tap-12ys6): retirement and terminalization remove under it, and retirement takes its notice obligation before reset; a terminalization whose removal refuses still reports terminal and leaves the sidecar to the drain's stale-sidecar reap. A send park holds reset only for its transaction and failed-park fallback, and a pane-effect cue only for each token write. A fenced or busy effect is not performed and never replayed: the body stays where it is and a preserved `spool_effect_fenced id=… stage=… reason=fenced|busy` registry event records it. The one retried move is a **busy repark** (tap-conft). It restores the park after a no-effect refusal and is not a delivery effect. Left in place, it strands a parked entry: the body stays in `payloads/`, the metadata still names a due probe, and the waiter, which runs while the spool body exists, has ended. The mark licenses only while no attempt evidence or receipt exists: one predicate gating every move and surfacing (retry, watch tick, reap, unverified-canonical verdict). A marked entry stays live for its waiter. The waiter retries that move alone, bounded by `TAP_SPOOL_REPARK_DELAYS` (default `1 2 4 8 15 30 30 30`), no lock across a pause. Each retry takes the id's obligation lock first (every mover holds it across its attempt — the race guard), then reset custody, then the metadata lock, moves the body back before clearing the mark — a kill between leaves an inert stale mark, not the clear-first miss. Evidence, a receipt, or a gone body consumes the mark without a move — withdrawn, possible-effect mail is never re-parked. If the waiter died, the next armed tick re-drives licensed strands via the same retry, listing `spool/`, not the cleanup cursor (tap-kip6q): zero waits, busy skips a tick, delivering that pass. After a landed repark the waiter re-probes on its cadence; an exhausted bound logs `spool_repark_abandoned id=… reason=…` and leaves the body canonical. A drain also stops its pass on seeing the fence. Behavior change: `acquireResetFence` waits at most ten seconds for the sidecar, so `tap team reset` refuses `reset_custody_busy` before any stop or checkpoint instead of hanging. Send, drain and spool cancel take their obligation lock before shared reset admission. No admission is upgraded. Contention waits use jittered backoff within the existing deadline; they never retry a possible delivery effect.

## Explicit same-ID retry

`tap resend <id>` re-rings the same canonical message: same id, body and
obligation; no successor, withdrawal or age reset. It is allowed after any prior
attempt, including exit 5 (still nonzero; its recovery names resend, never a
fresh send), until the recipient observes the message by the
[recipient-observed rule](./receipt-measures.md).

Under shared reset custody and the id's obligation lock, resend checks sender
authority and recipient state. Cancelled, settled or observed mail is a recorded,
suppressed no-op (exit 0); a read, unanswered ask needs a follow-up, not a retry.
A runnable retry or park coalesces (exit 0), a spent one retires `unknown`;
a poll-only recipient refuses
`recipient_unbound`. Otherwise resend records the request and re-parks the
canonical as a retry row.

Retry rows ring solo, never in digests. Under the obligation
lock it rechecks observation and retires an observed row without a pane effect.
It admits one attempt under the retry's own one-shot license,
`receipts/<id>.retry-<uuid>.attempted`, with ordinary admission, identity, reset,
pane and draft protections. The original `<id>.attempted` is never cleared or
reused; no-effect proofs count every retry marker. The wire adds a bare `retry`
tag, which grants no authority. An urgent or escalation original re-rings as
ordinary delivery: no interrupt key, no `urgent` or `agent-interrupt` tag.

Staged retries use their own [idle Enter](./idle-staged-submit.md).

Each invocation grants at most one new attempt; there is no loop or scheduler.
`receipts/<id>.retries.jsonl` records requests, suppressions and outcomes
([retry measures](./receipt-measures.md#retry-measures)). JSON
`delivery_semantics: at-least-once` now describes this contract. The fresh-id
successor mode (`resend_of`, `.resent`) is retired; old receipts stay readable.

## Park retention (tap-nzjvi)

Parked custody expires after 72 hours from `first_spooled_epoch`. Missing,
malformed or future park clocks use the parked body's mtime. Expiry applies to
held and escalated entries, including entries whose sender is still registered.
The drain checks expiry before readiness, digest planning or submission. A
cleanup refusal leaves the expired entry in custody and excludes it from
automatic delivery.

Expiry preserves the body in `payloads/`, preserves metadata under
`archive/<id>.meta.json`, and leaves all attempt evidence intact. It records
`.cancelled` with `reason=park_expired`, `source=courier_expiry`: withdrawal does
not attest receipt or processing and does not rule out an earlier delivery
effect. `.unconfirmed` alone remains an open obligation. Expiry grants no resend
authority. Existing `.done` and `.cancelled` receipts survive unchanged. A
confirmed delivery or authorized read retires only duplicate parked custody,
preserving the recipient's open obligation.

Each present sender receives one durable `delivery-failed` inbox notice per
expired payload. A pass publishes at most eight new notices; remaining expired
entries await cleanup and stay excluded from delivery. Confirmed sender absence
records an event without creating unreadable mail. An unobservable sender
registry holds custody and surfaces for inspection. Maintenance does no pane
input, including notice submission. Courier
notices do not create notices of their own; self-addressed mail has no separate
sender notice, and operator mail retains its existing event notice. A notice
already in history remains the same notice after archival.

Cleanup takes the obligation lock, a non-stealing spool claim, shared reset
custody and the metadata lock, in that order. It rechecks the body and clock
under custody. Conflicting canonical or archived metadata bytes, malformed
envelopes and unsafe paths retain the original for inspection. Locks and reset
fences defer cleanup. Settled parked copies use the same preservation path
without creating a new receipt or notice.

An active drain checks each pass. The detached daily bus-maintenance worker also
checks expired parks, so an unarmed watcher does not strand them. Scheduling
requires an ordinary bus command or watcher tick; inactive machines perform no
cleanup. The [history maintenance contract](../transport/bus-layout-under-tap-home-part-05.md#settled-history-archive-tap-7r3fn26)
owns cadence, archival and operator warnings. `tap show <id>` keeps finding an
expired escalation's body and receipts after they move into monthly history.

## Related pages

- [Delivery receipt measures](./receipt-measures.md): nightly joins, denominators and the initial evidence report.
- [Idle staged-submit](./idle-staged-submit.md): the one licensed Enter on a staged sentinel (tap-9lqa7).
