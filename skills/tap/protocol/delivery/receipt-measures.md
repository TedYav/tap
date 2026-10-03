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

## Initial evidence and report

The September 24 census joined 26,920 placed IDs and 25,321 sent IDs across 58
indexed buses. There were **1,692 placed IDs without sent** and **93 sent IDs
without placed**. The earlier 1,596 aggregate subtraction was not a count of
unrecovered messages.

September 23 00:00 UTC is the reporting baseline: the last completed UTC day
before that census, not causal proof a fix removed misses. Exact unrecovered delivery misses are
unknown: missing historical bodies and receipts cannot establish whether the
recipient once saw the message. The 99.9% target is not a retrospective claim.
