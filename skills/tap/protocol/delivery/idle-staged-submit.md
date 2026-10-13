# Idle staged-submit (tap-9lqa7)

Part of [Delivery reliability](./reliability.md): the one licensed Enter that
completes an already-staged sentinel.

A submit ending unverified or stop-ambiguous may press Enter once on a sentinel
still staged in an idle composer, without retyping. A direct send exits 5
with a pending event and keeps its canonical `payloads/` body beside a
`staged-idle` spool copy. The waiter follows the copy; `cancel --spooled`,
read and reply settlement retire it. `stagedIdleSubmitEligible` requires an
unverified attempt, no recipient observation or settlement, and an unspent
idle-submit license. Without one visible
well-formed wire,
the drain returns unverified with no keys: no injection, clobber or tail
fallback. Another well-formed wire may get Enter (class, not identity), but
`identity_mismatch` refuses a different recipient. An AGY re-probe without
its evidenced wire leaves the canonical for manual recovery, never renewing
the hold.

Under the pane lock, Enter requires positive `idle` state, no modal or human
draft, and two identical whole-composer samples of exactly one sentinel across
a settle; concatenations refuse. A live Claude spinner is `working`, not idle
(tap-7txco). Human input wins; `tap nudge` owns follow-up.
The link-atomic `.idle-submit` receipt, minted after final authorization and
both samples, licenses one Enter per staged observation. A same-ID retry uses
`<id>.retry-<uuid>.idle-submit`, beside its own `.attempted` license. It requires
that retry's unverified injection and ignores only transport receipts proven
older than the retry's `admitted_at`: mtime for `.sent` and plain `.idle-submit`,
`at` for `.harness-queued`. A whole-second queue timestamp overlapping admission
has unknown order and refuses. A plain `.idle-submit` at or after admission
also spends the license, including an Enter from another row's idle arm.
Recipient state follows retry admission: forced or retired `.read` alone does
not prove observation; authoritative reads, `.done` and `.cancelled` end the hold.
Only a valid forced or retired read gets that exception; malformed or unreadable
observation receipts refuse. Missing or malformed admission evidence refuses. `.attempted` still
blocks injection; a spent license never refires. Enter adds no bytes, so it is
a completion key under the no-retry rule. Failed verification disposes the
entry. Only an established hold keeps its retry outcome pending; failure to
establish the hold records `unverified`. A spent idle license or recorded outcome
also ends retry repark recovery, so cleanup cannot turn success into failure.

The hold lasts `TAP_STAGED_IDLE_SUBMIT_WINDOW` seconds (default 1800), then
disposes; revisit if a specimen stays staged past 30 minutes. A Codex seat
behind its startup screen never reads idle until the screen clears.
