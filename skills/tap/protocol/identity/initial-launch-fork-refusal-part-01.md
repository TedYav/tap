# Initial-launch fork refusal — source part 1 of 2

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0145 start=919665 end=928281 sha256=925181466a75c25172b59b03c90dffc47febcd46474dd8c24be8ed249be8b0ce fragment=1/2 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Initial-launch fork refusal

The shared native launch owner preserves the legacy entry points' initial placeholder respawn retry: once after one second, only for the exact nonzero ENXIO fork-refusal diagnostic, with the same observed server/session/window/pane identity and pane pid -1. The retry checks that identity and pid atomically in tmux and omits `-k`. A started child, readiness timeout, missing observation, or identity change never earns a retry. Terminal respawn failure performs owned cleanup and token-bound registry rollback, and prints residue, scoped recovery and measured load/pty census. Unavailable observations remain unknown.

The decision table's full reasoning is preserved in the internal launcher-respawn-retry artifact. The narrow native new-launch entry retains its existing bounded waits and no-retry behavior. Generic tmux operations and live-harness clear are outside this retry rule. The shared native launch transaction that now backs these entry points is documented in [part 2](initial-launch-fork-refusal-part-02.md#shared-launch-transaction).

### Native readers (U3)

The native CLI lets pending stdout/stderr writes finish before exiting. Pipe
backpressure must not truncate JSON or JSONL; a stream write failure exits
nonzero. Normal verb statuses remain unchanged.

The native `read`, `show`, and `outstanding` handlers preserve the current
verb outputs and receipt rules. None of the three has a Bash door
(`~/.tap/bash-verbs` is no longer read). The shared
payload resolver, read
adoption/clearing predicate, forwarding receipt publication and forced-read
audit, and outstanding live spool
diagnostics retain their existing helper implementations. `read` owns
`--team`, `path=` selectors (including the enrolled-foreign parked pointer),
qualified ids, digest member dispatch and its usage refusals natively, exactly
as `show` does. Verbose diagnostic events describe the executing
runtime; stdout, return status and write sets remain equivalent in both modes.
Ordinary native `read --force` retains its recorded full output. `show` writes nothing; `outstanding` retains malformed-payload quarantine.

Both outstanding entry points share one Bun scan and renderer. The native
handler owns argument validation, `--team` bus anchoring, the reset fence and
the observable-pane unanchored refusal directly; no Bash door remains.
On a machine whose flip marker is live, the unanchored pane arm resolves
enrollment through the generation- and session-bound, uniqueness-checking
lookup: a stale prior-generation row never selects or suggests a team in the
executable remedy (typed evidence may still name claimant rows), and contested
claimants or unreadable or missing acting registries refuse rather than suggest
one. With no marker there is no enrollment to consult: the arm refuses
`unanchored_bus` (next `tap init`) and never reads `teams.json`; an invalid
marker answers the generic refusal. Each call joins
one regular-file receipt snapshot with payloads and resolves the sender registry
once. Custom ids remain visible: filtering reads the envelope sender rather than
assuming an id prefix. Existing quarantine and selected-row queue diagnostics
retain their owners. No archive or persistent index is created.

An interrupted or failed scan is not an empty result. Callers that impose a
timeout must inspect its exit status; only a completed exit 0 carries a
result, and only its empty listing reports no outstanding sends.

Reader age calculations accept `TAP_SPOOL_NOW` in epoch seconds on both runtimes,
with an explicit age-helper argument taking precedence. This pins display and
stale-filter comparisons; it does not change receipt timestamps.

### Queued payload inspection (tap-skgvg)

`tap show` resolves legacy `spool/<id>.md` payloads through the shared resolver
on both dispatchers, including exact ids, unique suffixes, and explicit paths.
Canonical payloads and digest indexes retain precedence over queued copies of
the same id; spool wins over archive and quarantine copies. Cross-bus ambiguity
and local exact-id preference still apply. The inspector prints the envelope, body, receipts, and the spool metadata's
`reason`, `policy`, `waiter_lifetime`, `deadline_epoch`, and `attempts`; absent
fields are unknown and unavailable metadata is named. These stored fields are diagnostic. Inspection creates no state. Recipient
`read` keeps its existing residency selection and settlement rules.

### Debug capture

`tap debug on` collects courier attempts and submit-failure frames across teams. `tap debug trace <seconds>` adds raw tmux logs for a bounded, uncapped window; otherwise they stay off.
`tap debug` is read-only status; `off` stops and retains evidence.
There are no capture levels.

`on` reports ready once the recorder publishes post-baseline status. It fails
only if the recorder exits or records an error first.
Recording continues until `tap debug off`. At budget, rotate oldest segments and artifact copies; keep receipts and recovery records.
`retain_mb`: newest-first, always newest. Never pruned: enabled capture, `debug/recovery/` id, non-capture (no `session.json`), recovery post-mortem. Between passes, budget may overshoot a pass; recording continues if artifacts alone exceed it.
Ignore saved `lifetime_hours`; `--lifetime-hours` is a non-mutating tombstone.

While enabled, Bash spool redelivery and digest submissions retain the existing
`.attempts` summary shape, including detailed verifier diagnostics and digest
member IDs. Failure frames preserve an already-observed input, never a fresh
post-failure capture presented as the original observation. First failure wins;
raw contents stay in private artifacts. Native delivery
uses the same artifact format and its existing attempt evidence (the legacy
submit path records a summary when diagnostics are enabled).

The Bash frame adapter passes its already-resolved bus to the journal writer.
Enabled internal journal writes require an explicit `TAP_HOME` bus directory;
missing or empty values refuse without falling back to the operator state root.
Journal-write errors print a diagnostic and return nonzero to their caller.
Diagnostics are best-effort and cannot change delivery return codes, receipt
meaning, retry authority or pane effects. Attempted, submitted, verified and
recipient-processed remain separate claims.

New courier diagnostic summaries use `<id>.debug.attempts`, preserving the existing
summary shape without entering delivery retry authority. Existing canonical
`.attempts` records are collected unchanged. Trace shutdown retains ownership and
reports `stopping` until native logging is confirmed closed; it never reports a
failed stop as completed or repeats a pending toggle signal.


**Accepted harness queue (tap-bdhec):** Ordinary sentinels have a distinct queued outcome when one frame shows the complete expected wire outside the input band, an observable empty composer, and an active harness turn. Where frames carry busy (OpenCode), it also needs a busy earliest read; an idle one receipts `injected`. The Bun classifier owns this; Cursor follow-ups and Claude queued rows add no rules. An observed queue never authorizes another Enter. Exact controls keep existing behavior.

The sender receives `status=queued`, `delivery=harness-queue`, `turn=unconfirmed`, and the canonical path. The courier records `.harness-queued` and phase `verify-result` with `result=queued`, retires automatic injection/retry custody, and emits no delivery-unconfirmed notice or nudge suggestion. This is acceptance into the harness queue, not recipient processing or TAP spool custody. It does not advance the window-cooldown clock. Bash adapters return 7 for this ordinary-wire outcome.

A subsequent authorized read materializes `.sent` from the `.read` receipt (ask) or `.done` with `via=read` (note), as `via=harness-queue-read` with `read_by` and `read_at`. Forced or retired first observations establish nothing; the authorized successor read's own evidence completes `.sent` instead; see [part 3](initial-launch-fork-refusal-part-03.md). Existing `.sent` stays; queue acceptance never creates `.read`/`.done`. The `.sent` turn stays `unconfirmed`; read provenance is never a fabricated turn-boundary token. Recovery leases arbitrate new pane effects, not this completion; a queued payload is not a replay candidate.

### Submission phase evidence (tap-4w0xy)

Ordinary sentinel submission records positive phase facts in
`receipts/<id>.submit-phases.jsonl`, independently of optional debug capture.
Each submit call has its own attempt id. Rows contain the phase, timestamp,
recipient, Enter ordinal and attempted-key count; no composer text or message body.
Digest submission records the digest id, not invented per-member effects.

- `injected-text-confirmed`: the existing reader observed the exact owned sentinel.
- `Enter-intent`: the next key was intended. This is written before final authorization;
  a later guard may still refuse it.
- `completion-Enter-intent`: the bounded final courier key; no retype or new delivery attempt.
- `Enter-sent`: the key command returned success. Harness consumption is unconfirmed.
- `verify-result`: the verifier completed, with its result and attempted Enter count.

A recorded recovery refusal before the key call retains `Enter-intent` and its
ordinal, but does not increment `enter_count` or write `Enter-sent`. Actual key
command failures remain possible effects and count as attempted; a nonzero exit
alone never proves zero effects. Recovery events explicitly carry `effect=none`
or `effect=possible`. The internal recovery adapter uses exit 125 plus the
wrapper's no-effect signal only for positively recorded pre-key refusals; actual
command failures keep the possible-effect path. Historical rows predating this
correction may count an intended Enter despite a recovery pre-key refusal; use
the corresponding recovery event to interpret those rows.

Recovery identity checks retain bounded diagnostics: outcome, subprocess status,
signal, error code, elapsed milliseconds, and up to 1,024 sanitized stderr
characters (with a truncation flag). Timeout stays at ten seconds and is recorded
as timeout; argv, environment and stdout are not included. Authorization is
unchanged. These facts explain a particular check outcome, not an earlier
delivery attempt whose evidence is missing.

Rows are flushed to disk. Recording failures warn without changing submission behavior.
Missing or torn rows remain unknown; a crash between a key and its receipt cannot prove
that Enter was withheld or dropped. Only a completed verifier result with zero issued
Enters establishes a zero-Enter call. Rows from different attempt ids cannot be combined
into one successful sequence. None of this evidence authorizes another attempt.

Send, show and outstanding share the current explanation. JSON `status` remains the stable
machine disposition: `pending` on send exit 5 and `queued` for parked sends.
Injection detail is additive in `phase: injected-enter-unconfirmed` and
`queue_explanation`; it does not replace the disposition consumed by reply. Confirmed injection with an
unresolved verifier result says `injected; Enter unconfirmed (possible effect)` and names
`tap nudge <seat>` only if the sentinel is still staged. It does not claim delivery or
present a cooldown, window or next-probe schedule. This status remains visible after
spool metadata is removed. Show retains any recorded spool metadata as forensic history;
success or settlement supersedes an older unresolved phase. `.attempted` alone remains
possible-effect evidence and does not establish confirmed injection. Unattempted parks
retain their normal scheduling explanation.

Automatic recovery of staged input is deferred pending a failing specimen with these
phase records. This change adds no automatic nudge, re-probe or retry.
