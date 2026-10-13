# Appendix: the `agy` native driver and the `agy-ls` descriptor (tap-ssie — default-off) — source part 3 of 3

> Retired 2026-09-20: the native AGY and Claude delivery adapters were removed.
> All supported delivery uses tmux. Remove an old `driver` key or set it to
> `tmux`; parsed `agy`/`ccnative` preferences refuse before delivery.
> The existing Python 3.10 parserless path uses tmux with an advisory;
> `TAP_DRIVER_FORCE_TMUX=1` still overrides preferences.
> Harness launching and conversation identity remain supported. Registration
> temporarily retains the AGY start-token helper and `agy_ls` descriptor until
> its native cutover. The source below is historical, not an activation guide.

<!-- tap-source id=source-0144 start=917878 end=919665 sha256=bae7b55efd2a400d5375dfdc511be82276c91f4ae4f330a9e54d7cef150cf8e2 fragment=3/3 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
The successor-mode resend custody (withdrawal, `.resent` publication, a prepared
`archive/<newId>.resend.md` and one delegated send) retired on 2026-10-12. Native
`resend` validates arguments, context and actor, then takes shared reset custody
and the id's obligation lock. Under them it checks sender authority and recipient
state, records a suppressed or requested retry in `receipts/<id>.retries.jsonl`,
and parks the canonical as a retry row. It releases both locks before starting
the waiter, so the drain can take the obligation lock, recheck observation and
admit the retry under its own license; see the
[explicit same-ID retry](../delivery/reliability.md#explicit-same-id-retry).
Refusals exit 1: one `ok: false` JSON object on stdout with `--json`, otherwise
one `tap resend: ` stderr line.

Crash and refusal edges. A request recorded but never parked or attempted
resumes under its own uuid on the next resend. A parked row whose own attempt
is spent can never ring again: a retry row after a kill or refusal past
admission, or an original park after its possible effect. The drain (retry rows)
or the next resend moves the canonical back to `payloads/`, removes the row, and
mints fresh; a spent retry also records outcome `unknown`. The row goes only once
a regular canonical holds the body; a failed move keeps row and body and refuses
(`retire_held`). A staged-idle hold or a pending reprobe still runs on its spent
attempt and coalesces. Resend also refuses `recipient_changed` when the handle now
names a different instance than the envelope's `recipient_instance` (the drain
rechecks it and retires such a row as suppressed, with no effect), and
`id_too_long` when the license filename cannot fit. It suppresses an archived
message without writing an active receipt. A park that fails after publishing
its row reports the retry queued, never refused, and starts its waiter. In `tap
outstanding`, a later retry recorded as confirmed supersedes an earlier
`retry_submit_unverified`. The license records its admission: `admitted_at`, the bound
`target`, `pane`, `pane_id` and `instance`, and the checked `prior_state`. An
unverified retry logs `retry_submit_unverified`, never the original's
`redelivery_submit_unverified`; `tap outstanding` reports both as stopped.

| Verb | Runtime boundary |
| --- | --- |
| `resend` | Native on every public form; parks a same-ID retry row for the existing drain. |
| `withdraw` | Native on every form; the verb has no Bash door. |
| `nudge` | Native (`cmdNudge`); the recorded submit boundary runs the courier's `submitStagedLocked` in-process, each Enter through the recovery effect owner. |
