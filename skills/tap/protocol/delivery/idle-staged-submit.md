# Idle staged-submit (tap-9lqa7)

Part of [Delivery reliability](./reliability.md): the one licensed Enter that
completes an already-staged sentinel.

A submit ending unverified or stop-ambiguous may press Enter once on a sentinel
still staged in an idle composer, without retyping. A direct send exits 5
with a pending event and keeps its canonical `payloads/` body beside a
`staged-idle` spool copy. The waiter follows the copy; `cancel --spooled`,
read and reply settlement retire it. `stagedIdleSubmitEligible` requires an
unverified attempt, no settlement or prior `.idle-submit`. Without one visible
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
both samples, licenses one Enter per staged observation. `.attempted` still
blocks injection; a spent license never refires. Enter adds no bytes, so it is
a completion key under the no-retry rule. Failed verification disposes the
entry.

The hold lasts `TAP_STAGED_IDLE_SUBMIT_WINDOW` seconds (default 1800), then
disposes; revisit if a specimen stays staged past 30 minutes. A Codex seat
behind its startup screen never reads idle until the screen clears.
