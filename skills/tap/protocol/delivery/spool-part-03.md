# Spool — source part 3 of 3

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0096 start=643187 end=651209 sha256=ef23fa5605ba3d068cb342a4465a1571f6d1068540a875a0d0b8908cd32c6168 fragment=3/3 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
**Index.** A courier-owned JSON file under `spool/digests/<digest-id>.json`: `v`, `digest_id`, `kind`, `from`, `to`, `to_team`, `count`, an `instructions` string (the non-collapse contract, inline for the reading agent), `injected_at_epoch` (stamped after the verified submit), and `items[]` — each `{id, from, kind, reply, path}` with the payload's **canonical** `path`, in claim-time order (`first_spooled_epoch`, then id). An item with an existing `.done` additionally carries `settled: true` and `reply: none`, and the instructions name **no settle verb** for it — no settlement is owed (`tap read` renders the settled item; `tap reply` stays available to report a problem), so a settle verb would teach a needless step. Its route tokens are always team-qualified: a same-team park stores no `to_team`, and the courier resolves the draining bus's own team rather than emitting a bare `/courier` half. Only the courier writes indexes, under the spool claim; reads never write one. An agent-written file under `spool/digests/` is not trusted without courier claim linkage.

**Carve-outs (pre-claim).** `urgency=urgent` and `kind=escalate` entries are excluded from digest claims and flush on the per-sentinel path, **before** the digest inject in the same drain tick, so these entries retain their solo delivery path and never fold into a batch. Spool delivery never repeats an interrupt; content kind alone grants no interrupt permission.

**An expired hold records a terminal state.** When an auto-settle park reaches its delivery deadline and the sender's `delivery-failed` wake is confirmed, the courier terminalizes it (promoting the body into `payloads/`, where the notice points) **and writes `receipts/<id>.cancelled`** with `via: cancelled`, `reason: deadline_reached`, `by: <courier>`, `source: courier_expiry`. `.cancelled` rather than `.done` because the seat never saw the body and `.done` means received; a receipt at all because terminalizing without one leaves the id listed by `tap outstanding` forever and clearable by nothing — note reads and replies require recipient authority, `tap cancel` refuses a live recipient, and `--spooled` refuses a canonical payload. The courier must not announce that it stopped trying and leave the sender unable to act on it. (Readiness-gate parks reach the same statement and are unchanged here; that is tracked separately.)

**Departed sender after escalation.** An escalated entry may terminalize after
`TAP_SPOOL_UNROUTED_GRACE` seconds from a parseable `escalated_at` when its sender
handle is absent from a successfully loaded current same-team registry. Reserved
identities (`watcher`, `courier`, `help`, the configured watch identity and reserved
handle list) are never evidence of a departed seat: their absence holds custody,
including after escalation grace. Use the
acting registry when it is a regular file; otherwise only a proven same-team
bound registry may supply that evidence. Any present handle, including suspended,
poll-only, launching or malformed rows, holds custody. Unobservable registry state
also holds custody and records the reason. Under the spool claim, recheck settlement,
metadata and sender absence immediately before promoting the body and retiring retry
state with `reason=sender_gone`, `action=spool_terminal_sender_gone`. No sender notice
or recipient effect occurs; existing submission evidence survives. Auto-settle holds
also receive the existing `.cancelled` receipt with `reason: sender_gone`. Registry
registration can race this observation; a returning sender can find the preserved
canonical body. Present senders with an unconfirmed wake retain the existing policy.
The operator `user` (a `tap nudge` sent from a person's terminal) is not a seat and
has none to notify, so waiting can never make its escalated note deliverable: past
the same grace it retires with `reason=operator_undeliverable`,
`action=spool_terminal_operator_undeliverable` and a `.cancelled` receipt with that
reason, which clears `tap outstanding user`. Every other unsettled terminal path for operator mail
writes the same receipt first; if it cannot, or the registry cannot be read, the entry stays for the
next pass. Mail from a legacy seat named `user` (its row still present) is not operator mail and keeps
the ordinary sender-presence path.

The [72-hour park-retention rule](reliability.md#park-retention-tap-nzjvi)
also retires aged custody when the sender remains present, preserving body and
effect evidence and recording withdrawal rather than recipient settlement.

**Only recipient actions create new settlement receipts.** Courier delivery and restart recovery never synthesize `.done`. Existing receipts are preserved. A digest row may say `settled: true` only when that item's actual `.done` exists; legacy policy alone is not settlement evidence.

**Settled is not terminal, and a withdrawal is neither.** The post-delivery step publishes `settled: true` only for ids whose own `.done` receipt exists — never from a terminality test, which a `.cancelled` receipt also satisfies. Member obligation locks exclude `tap cancel --spooled` through post-submit bookkeeping. A missing canonical body is still dropped from the index: **no row may point at a file that is gone**. An absent receipt is never published as a settlement, and a failure to rewrite the index is reported on stderr and to `registry-events` rather than discarded — the doorbell has landed and the recipient is holding pre-delivery instructions, which is recoverable but must not be silent.

**Submit-unverified (verify 5) and the auto-settle class.** The batch is canonicalized and automatic retry stops, as for any digest — but **no `courier-auto` receipt is written**, because nothing attests the seat received it. That leaves the item unsettled with its spool metadata gone, so the delivery deadline can no longer fire: for this class the courier therefore wakes the **sender** at that moment, naming the canonical path. Nobody is left uninformed and no clock is left to expire.

Two things must then stop claiming more than the courier knows, because **verify 5 means attempted, not confirmed** — the doorbell may well have landed. The index retains ordinary per-item obligations, so a recipient who did get the doorbell reads the bodies and settles them normally instead of being told to settle nothing while nothing is settled. And the sender's notice says **DELIVERY UNCONFIRMED**, not failed: same `kind=delivery-failed` wire class (it is the existing class for "nothing further happens automatically", and no new kind ships here), but the body tells the sender the courier cannot observe whether the wake landed, and that a re-send may be a duplicate rather than a repair.

For eligible legacy held members, an unverified digest emits one durable sender notice per (digest, sender on the acting bus), listing every affected member id and canonical path. The existing publisher uses one representative member to resolve the sender registry. Publication precedes its single bounded pane attempt; re-entry preserves the first notice and never repeats a possible wake. An unavailable sender pane leaves the notice readable. Ordinary member eligibility and original receipts are unchanged.

Sender-notice pane wakes use the active native submit verifier with the sender's registry and bound identity. Before preflight, the notifier exclusively creates and persists a conservative begin in `payloads/<notice-id>.attempts`. Existing evidence, including empty or torn evidence, refuses another wake. Every returned submit status is recorded in the outcome detail; after begin, the attempt envelope stays `effect=possible` even for a preflight refusal. This records uncertainty without asserting that a pane effect occurred. A crash during preflight may therefore suppress an unattempted wake. Only verified submission writes `<notice-id>.sent`, with `turn=unconfirmed`; diagnostic debug settings do not control the attempt record. Ordinary callers return failure for an unverified wake. Durable notice callers return publication success, which is not a confirmed pane wake. No notice retry or notice-of-notice is created.


**Transaction (P0).** Before claims, the courier takes every member obligation lock nonblocking in sorted id order; contention releases the acquired locks and refuses the batch. It holds them through the pane effect, canonicalization and member index bookkeeping, then releases them before sender notices. Readers retain their 5-second obligation wait and may refuse `obligation_busy` during a submit; they never settle concurrently with it, including when canonical and spool copies coexist. Claim is a **snapshot**: the courier CAS-claims each entry (the per-id `.claim` sidecars), so two drainers never double-flush; late arrivals after the claim wait for the next flush. The courier writes the index, then re-authorizes the exact registry-bound session/pane/harness and **submits the digest sentinel with the spool copies still in place**. Identity is checked again before every submit effect. After verified submission (0), submit-unverified possible effect (5), or timeout (124), it moves every claimed payload spool→canonical in one post-attempt step — a crash therefore never half-canonicalizes a subset without a doorbell. A pre-effect refusal discards the index, releases the claims, and leaves the entries redeliverable; submit-unverified retains the index and stops automatic retry. Oversized claims **split into successive digests** in claim order — never truncate, never silent-drop; a lone remainder falls back to the per-sentinel path.

**Retention.** The index is GC'd only after every listed item is terminal (`.done` or `.cancelled`) and the minimum retention window has elapsed (`TAP_DIGEST_RETAIN_SECONDS`, default 24h). Verified indexes use `injected_at_epoch`; historical `courier-auto` receipt timestamps remain a fallback for old indexes, otherwise index mtime supplies the minimum window — except that an index whose items carry `settled: true` with no delivery witness at all is retained rather than aged out, because settlement without a witness is not evidence the pointer was ever delivered. One implementation decides this (`runtime/bun/src/digest-index.ts`), for the courier's drain and the native owner alike. Publication time protects a possibly staged pointer and does not attest injection. Envelope `.read` records observation and does not replace item settlement or shorten retention. A digest remains a pointer list, not inbox authority: `tap poll` still enforces each item's `to_team`. One `registry-events` line (`action=digest(n=…)`) is appended per inject.


**Orphan canonical/metadata recovery (tap-43l9n).** A missing spool body does not
prove delivery. The stale-sidecar reaper holds nonblocking obligation, reset and
metadata custody and rechecks the orphan state before mutation. If canonical
custody is unverified, it preserves the exact metadata at `archive/<id>.meta.json`
and in an `.unconfirmed` receipt (`effect: possible`, `reason: orphaned_spool`)
before removing the active metadata. Publication failure or conflicting archived
evidence keeps the active metadata. An existing unconfirmed receipt is never
overwritten; its active metadata is retained for explicit settlement. The body
stays canonical, all submission evidence stays intact, and no recipient attempt
is scheduled. Marked pending reparks keep their existing recovery path; positive
sent/read/settled or harness-queue receipts permit ordinary sidecar retirement.
The archived metadata remains available to the existing explicit resend proof
rule; recovery grants no resend authority and changes none of its checks.
