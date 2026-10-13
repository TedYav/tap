# Delivery receipt measures

The recipient-observed target and the receipt joins that measure it. The target,
persistence contract and refusal log live in [Delivery reliability](./reliability.md).

## Nightly receipt measures

Join by **bus and message ID**, not by subtracting suffix totals. A receipt must
parse and name the same ID. Use the `.placed.at` UTC calendar date as the cohort
and publish the observation time. A night in progress is partial; later receipts
can change an earlier cohort. There is no latency deadline in this target yet.

| Measure | Numerator | Denominator | Target |
|---|---|---|---|
| Recipient-observed | Non-forced `.read`, or `.done` via `read`, `reply` or manual `done`, with a named actor; exclude retired-instance observations | Valid placed IDs without explicit `.cancelled` | 99.9% |
| Sent OR observed | Valid `.sent` or the recipient-observed evidence above | Same non-cancelled placed IDs | None |
| Confirmed submission coverage | Valid `.sent` with `delivery=pane`, excluding `via=harness-queue-read` | Valid placed IDs, excluding explicit `delivery=poll` | None |

Count each message once. Courier-auto settlement, forced reads and
retired-instance cleanup never earn recipient-observed credit. A `.sent` receipt
alone proves neither observation nor processing. Always show cancellation counts
beside the recipient-observed denominator; cancellations can include failed
transport and must not disappear inside a high percentage.

A later read of queued input creates `.sent` with `delivery=harness-queue` and
`via=harness-queue-read` in `completeHarnessQueued()`. Report this read-derived
evidence separately: it earns observation credit under the first metric, never
pane-submission credit. The recipient may have found the message by polling.

A digest doorbell accepted into the harness queue records `.harness-queued` for
the digest id as well as each member; the digest has no payload, so the receipt
carries the doorbell's route (`kind=digest`). An authorized `tap read` of the
digest completes it by the same rule.

Explicit poll delivery has no doorbell, so it is excluded only from submission
coverage. Other or mode-less legacy `.sent` records are reported as unknown for that
measure, not credited as confirmed pane submission. Sent IDs without placement
are reported separately. Parking, queued-but-unconfirmed input and later reads
remain in the submission denominator; they are not a confirmed doorbell.

Submission coverage is **not first-try success or latency**. Deferred redelivery
also writes `.sent`, often without an attempt ordinal or timestamp. Those
measures remain unknown without a separate join to attempt timing. Refusals
before placement sit outside every placed denominator; use the refusal log described in
[Delivery reliability](./reliability.md).

Revisit the design after any completed night below 99.9% recipient-observed,
any unaccounted missing pollable message, or any refusal-induced silent stall.
Preserve the evidence and investigate.

## Retry measures

An explicit same-ID retry ([reliability](./reliability.md#explicit-same-id-retry))
writes one record stream per message, `receipts/<id>.retries.jsonl`. One retry
UUID names the request, its license `<id>.retry-<uuid>.attempted`, its
`submit-phases.jsonl` attempt and its outcome. Join by bus and canonical ID in the
original `.placed` cohort. `tap debug stats` reads these records without debug
capture and carries no payload bodies or frames.
The separate `<id>.retry-<uuid>.idle-submit` licenses only a completion Enter;
it is possible-effect evidence, never another ring. Both idle-submit forms
archive with their canonical ID.

| Measure | Definition |
|---|---|
| Extra ring | Each admitted retry license: a new possible-effect doorbell for an already-attempted ID |
| Known-redundant | Extra rings whose observation evidence predates the retry effect; a lower bound, shown with numerator, denominator and unknowns |
| Suppressed | Requests or retry rows retired because the message was already observed, settled or cancelled; no pane effect |
| First observation after retry | Recipient-observed evidence first appearing after a retry effect; not proof the retry rescued it |

The report also shows initial unverified submissions (a direct send's or the
spool drain's first ring; a lower bound from the bounded event tail), retry
outcomes, still-unobserved age buckets and recipient-observed coverage. It reads
`archive/<month>/receipts/` beside active receipts, so a cohort survives
`tap bus archive`. Missing history is unavailable, not zero: a bus without an
event log and a torn or unreadable retry history are listed as such. An outcome
missing after a crash is unknown, not completed: a retry UUID without an outcome
is pending or queued while a spool row carries it, else unknown when its license
was spent, consumed when a read or cancel took the row first, and interrupted
otherwise. A placement dated after the report time is skipped and counted. Refusals before placement and withdrawn
sends come from the refusal log by UTC date, beside the denominator and never in
it; an absent log is unavailable, and a night older than the oldest surviving
rotated line is marked possibly incomplete.

Retries never inflate placements, denominators or nines: each message still
counts once. A retry writes `.sent` only when none exists, so submission coverage
stays per message, not per ring. An `.unconfirmed` written by a retry does not
reclassify the initial submission; the retry's own outcome lives in its record.

**Tuning trigger.** Investigate when extra rings exceed 1% over a rolling cohort
of 1,000 distinct original pane messages. A loop concentrated on one ID, or any
repeat interruption, is investigated at once. An admission that ignored
observation evidence it already held is a correctness finding even once; an
ordinary receipt race is not. The 1% is a provisional heuristic; revisit it after
a baseline.

## Initial evidence and report

The September 24 census joined 26,920 placed IDs and 25,321 sent IDs across 58
indexed buses. There were **1,692 placed IDs without sent** and **93 sent IDs
without placed**. The earlier 1,596 aggregate subtraction was not a count of
unrecovered messages.

September 23 00:00 UTC is the reporting baseline: the last completed UTC day
before that census, not causal proof a fix removed misses. Exact unrecovered delivery misses are
unknown: missing historical bodies and receipts cannot establish whether the
recipient once saw the message. The 99.9% target is not a retrospective claim.
