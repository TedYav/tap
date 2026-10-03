# Queued-delivery completion after a forced or retired first observation (tap-9uc12)

> Amendment to the queued-completion rule (tap-bdhec) in
> [part 1](initial-launch-fork-refusal-part-01.md). Part 1 stays the owner of
> the base rule; this page owns the forced-or-retired successor case.

A subsequent authorized read materializes `.sent` from the actual `.read`
receipt (ask) or `.done` with `via=read` (note), using
`via=harness-queue-read`, `read_by`, and `read_at`. When that first observation
is a forced read or a retired-instance settlement, its receipt bytes stay
immutable as the audit record and never establish recipient processing.

The authorized successor read — grant-validated, non-forced, non-retired —
supplies its own read evidence (`by`, `at`) to `completeHarnessQueued`, and
only that evidence materializes `.sent`, naming the successor as `read_by`.
Successor evidence is scoped to the live canonical payload after a forced or
retired first observation: cancelled, withdrawn, archived and history
inspections carry none and mint no record. Forced reads and retired-instance
note cleanup never complete `.sent` and never erase queued transport
reporting. Completion never publishes fresh `.sent` or mints authorized-read
carry over a `.cancelled` receipt or the terminal `archive/<id>.cancelled.md`
tombstone — terminal even if a crash lost the receipt — while an existing
`.sent` is preserved; queue acceptance never creates `.read` or `.done`.

When the `.harness-queued` receipt does not exist yet — the sender records it
after the pane effect, through the post-effect recording paths in deliver and
send — completion is impossible at read time. The authorized successor read
then mints `receipts/<id>.authorized-read` (`id`, `by`, `at`, `via=read`,
`turn=unconfirmed`) beside the untouched first observation, and only when that
first observation is forced or retired; an authorized read with an
authoritative first receipt mints no record. The late recorder consults that
record as the only receipt fallback beyond an authoritative first observation,
so a queue recorded after the read still completes with the successor's
provenance. The record archives alongside its id's other receipts. A queue
recorded in the window between the read's completion check and its evidence
publication is completed by the read's reconciliation after it persists the
record. A forced
read alone mints nothing, and a forced digest read gains no completion
authority from a later digest reread: the digest aggregate keeps
receipt-derived evidence only.
