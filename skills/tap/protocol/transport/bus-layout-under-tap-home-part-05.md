# Bus layout (under `TAP_HOME`) — source part 5 of 5

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0025 start=152188 end=158555 sha256=c173128086650f943c0a12b8f8f36c222161ffb8665298c6ee755f23e393fbb0 fragment=5/5 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
**Every recovery effect is post-mortem-able through `tap debug`.** One Bun path
records nudge's inner copy-mode/Enter effects and detective key sequences. Before
the effect it persists the full ANSI frame and available history (`-e -J -S -`),
intended action, and policy decision reason. After a bounded settle it records the
frame again and the observed pane state: `pane_dead`, current command, window
count, pane/process IDs, and registered instance. The captured process and
registered binding must still match before another effect. An intent file survives interruption
before the result event. JSONL events identify the recovery, seat, mode, action,
reason, before/after paths, outcome (`verified`, `unverified`, `harness-exited`,
`refused`), and operator summary. Unknown state is not reported as a live or dead
process. Positive harness-exit/instance-loss evidence produces an INCIDENT and
stops; an absent read receipt during a healthy long turn does not.

Pre-capture failure refuses that effect. After-effect capture failure retains an
unverified record and cannot authorize replay. Artifacts are retained under the
machine debug directory after crew cleanup, even when the optional flight journal
is off. `tap debug recovery [recovery-id|payload-id] [--json]` exposes both recovery
to payload and payload to recovery links; the existing active collector includes
recovery artifacts. The worker receives a current-viewport view from the same
capture path; full history is preserved for post-mortems rather than loaded as
its conversation. Cautious and report-only use the same recording machinery.

A worker's natural-language completion is not a verifier. Staged submission proof
requires a fresh attempt-correlated verified phase result and the recorded frames.
Submission phases may carry `recovery_id`; nudge records those phases on the bound
payload's bus. It deliberately creates no new `.sent` writer. Untouched pending
messages resume through the ordinary courier and its existing outcome/receipt
writer. A prior `.sent` alone is insufficient. A newly observed, non-forced target read (`.read` for an ask or `.done`
with `via=read` for a note) is stronger evidence and is labelled as a read, with task completion still
unconfirmed; this also covers a harness-queued message read before the observer
sees its queued state. Final phase/receipt evidence is snapshotted into the
recovery artifacts so a debug bundle does not depend on a later live bus. Harness-queued work remains queued,
with processing unconfirmed and no replay, nudge, or alarm. After recovery, a
queued receipt must be new or changed from the baseline; an old queued sibling
cannot certify recovery of another pending message. A prior possible effect
without a current complete staged sentinel permits observation/escalation only.

Cleanup releases or expires the recovery hold independently of crew cleanup.
An unanswered canonical worker assignment cannot be bypassed with a fabricated
reply or `.done`: stop only the exact owned worker window, establish its gone
state, cancel that infrastructure assignment through existing cancellation, then
remove the crew. A changed worker identity or another pane in that window refuses
a collateral stop and reports the cleanup gap. Detective escalations use the
surviving initiating actor as sender and name the failed target in the question. Notification metadata distinguishes
attempted, delivered and unconfirmed; a failed attempt is retained and reported
without being relabelled as successful or retried blindly. One terminal escalation attempt
and one initiating-team status report describe unresolved recovery. The target
pane is never stopped for worker cleanup.


### Settled history archive (tap-7r3fn.26)

`tap bus archive [--older-than 7d] [--dry-run]` is explicit maintenance on the
selected team's bus. The minimum age is one day. Only old settled canonical
payloads and their protocol receipts are eligible; unsettled/fresh/malformed
entries, spool entries, and IDs or paths referenced by open work on this bus stay
active. Receipt ownership uses the longest known ID prefix, so `a` cannot take
`a.b`'s receipts. Lock/control files remain active. Human `tap team` reports only
maintenance failures needing inspection. Settled files awaiting archival never
trigger a volume warning; JSON and name-only output stay unchanged.

Ordinary commands that initialize or use bus directories schedule a cheap check
at command exit, after releasing custody. The check stats `maintenance.ok` and,
when its last successful run is at least 24 hours old, detaches one maintenance
worker. A bus with no success stamp uses its bootstrap marker's age and gets a
day before its first run. Watcher ticks use the same trigger. Neither path scans
payloads or drains mail in the foreground. `show`, doctor and static help retain
their observation-only behavior.

`maintenance.lock` admits one worker; `archive.lock` also excludes a concurrent
manual archive job. The worker reconciles settled parks, expires parks under the
[72-hour retention rule](../delivery/reliability.md#park-retention-tap-nzjvi),
reaps inert sidecars and archives eligible history older than seven days. It
performs no pane input. Only a complete pass advances `maintenance.ok`.
`maintenance.json` records a running attempt before the scan and its final
outcome. When success is overdue, foreground admission also reads this small
record: running or failed attempts back off for an hour before another worker
is spawned, without advancing the success stamp. Contention and reset fences
retry without a nag.
Evidence conflicts or unsafe archival state produce one inspection pointer in
human `tap team`. An inactive team resumes maintenance on its next ordinary
command or watcher tick.

History lives in `archive/YYYY-MM/{payloads,receipts}/`, bucketed by settlement
month. `archive/index.ndjson` is append-only, one record per ID:
`{id, month, settled_at, payload_sha256, receipts:[...]}`. Malformed or interrupted rows are skipped with one stderr notice naming the index
and `tap bus archive`; a rerun appends complete rows for eligible active files after
verifying the copies. Valid rows remain readable. Canonical placement still refuses
a malformed index, preventing reuse of IDs hidden by damaged rows. Prefix-shaped
interrupted JSON fragments (no closing `}` and starting with `{"id":` or a prefix
of it) are ignored without a notice or publication refusal in both readers.
Payload and receipt bytes are copied and verified before the index is flushed;
only then are unchanged active files removed. Different existing bytes refuse
cleanup. Indexed partial cleanup resumes idempotently; history is never deleted.

The archive job's own lock serializes jobs and covers the open-reference scan.
Each copy/index/cut also holds the id's obligation lock and shared reset custody,
so an active reader defers that id and reset cannot split its evidence transfer.
There is no shared canonical-publication guard: eligibility requires settlement
older than at least one day, IDs retain their identity, and both placement engines
consult the archive index to reject duplicate IDs. Reference scanning protects
open work observed during the job; later references still resolve indexed history.
Changed active file fingerprints refuse cleanup rather than overwriting evidence.

Exact IDs, team-qualified IDs, unique short suffixes and old canonical pointers
remain readable through `tap read` and `tap show`. Lookup consults the index, never
recursively globs monthly buckets. Active residency wins an interrupted cutover.
Original bus/actor authority stays separate from archived receipt location; an
archived read never recreates an obligation. Existing cancelled archives and reset
bundles keep their previous layouts. Malformed index records, unsafe paths and
missing indexed evidence refuse lookup; incomplete JSON append fragments alone
are ignored. The index is also consulted when refusing duplicate placement.
