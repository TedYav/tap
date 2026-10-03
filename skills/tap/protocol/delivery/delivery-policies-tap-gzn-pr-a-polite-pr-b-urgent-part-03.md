# Delivery policies (tap-gzn PR-A: polite; PR-B: urgent) — source part 3 of 5

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0091 start=605309 end=613546 sha256=73ba682c305f323a8c4b09ff6907e640db63295b63e1a983d4f13226293a7242 fragment=3/5 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
A deadline escalation of a **readiness-gate park** (`deadline_source=readiness-gate`) now has a DEFAULT addressee — the sender, who
is the one party able to act on a failed send (re-send, reroute, drop) on every fleet shape. The
watcher's human alert still fires in addition when the drain runs inside the watcher (the watcher
states that fact at its drain call, `TAP_SPOOL_HUMAN_ALERT=watcher`; the alert itself is composed
and published by the drain's native deadline transaction, `runtime/bun/src/spool-deadline.ts`, over
the same notify-human door the watcher uses); two addressees are fine, zero was the defect. The
notice is authored by the courier through its own origination path (`tap send --from courier` is
refused on purpose, and that refusal stands), carries the payload's canonical path, and is
`reply=settle-only` — **terminal-informational**, minting no obligation, because there is no courier
to settle with.

**Readiness-gate parks only, and the scope is the point.** The selector is
`deadline_source=readiness-gate`, a marker minted by the branch that assigns the default deadline —
i.e. by the code that decides a park belongs to this mechanism at all. Every other park keeps its
historical arc verbatim: `escalated_at` is still set, the watcher's human alert still fires, and the entry
**stays parked for human disposition**. That covers `safety_gate` above all, and also every park
carrying a deadline from somewhere else — a polite park's `timeout + 60`, an explicit grace window.

**Why the selector is a minted marker and not a class.** The first version of this scope said
`reason_class = busy`, which OVER-SELECTS: the reason classifier (`reasonClass`, `runtime/bun/src/spool-publication.ts`) maps copy-mode to `safety_gate`
and delivery-window reasons to `window`; other retryable reasons map to `busy`, so polite and pending-input parks remain `busy` too. A polite park
carries its own pre-existing deadline, so under that selector it reached this mechanism and had its
waiter lifetime changed by a fix that never meant to touch it. `reason = no-input-prompt` would be
narrower and still a proxy — a classification maintained elsewhere, which the next reason string
added to that family would silently re-widen. A marker minted at the point of decision cannot drift,
because the predicate and the decision are the same line of code.

This preserves the standing invariant stated above: *a `safety_gate` entry is never
deadline-clobberable and escalates safely instead.* A safety-gate park is deferred precisely because
a HUMAN must clear the pane, so discarding its retry state on a sender wake would leave nothing to
deliver at the moment they finally do — a held entry silently becoming a dropped one, in the one
class where holding is the property. A readiness-gate park is the opposite case: nobody is coming, so
a bounded tail and a woken sender are the correct end.

The sender wake and the terminal step are scoped **together**, never separately: the notice names the
CANONICAL path, which exists only because terminalization promotes it, so a notice sent without one
would hand the sender a pointer to a file that is not there.

The two resolutions (readiness-gate parks):

- **Terminal on a CONFIRMED wake.** If the notice is injected *and submit-verified*, the entry
  terminalizes: its payload is first PROMOTED to canonical (while parked, the spool file is the ONLY
  copy — removing it without promoting would delete the very message the notice points at), then the
  retry state is discarded and a `spool_terminal_delivery_failed` event is recorded. No zombie park
  survives a discharged obligation.
- **Held when the wake could NOT land.** An unverified or undeliverable notice leaves the entry
  escalated-and-parked exactly as before. The disposition obligation has not transferred if the
  sender was not actually reached — an attempt is not an effect.

**No drain-excluded state may sit forever unreported (tap-6vwz).** An entry whose park reason excludes
it from BOTH drain paths — Phase A never groups it into a digest, and Phase B's terminal-reason branch
`continue`s ahead of the escalation site — previously never delivered, never escalated, and never aged
out. Such an entry now ages out past `deadline_epoch + TAP_SPOOL_UNROUTED_GRACE` (default 1800s) — or past `first_spooled_epoch + TAP_SPOOL_UNROUTED_GRACE` when the entry carries **no** deadline, which is the oldest shape there is and the one both 35-day specimens have; an entry with neither clock is left alone rather than notified on a guess to a
**third disposition, `unrouted`**, distinct from both existing ones because both of those assert an
observation this one cannot make: `failed` means the courier tried and the attempt failed; `unconfirmed`
means it tried and cannot tell; **`unrouted` means it never attempted at all.** The notice says so and
explicitly declines to characterize the recipient, who may be perfectly reachable — the specimen that
revealed this had its recipient answering other mail the same hour, so a `delivery-failed` notice would
have sent the sender to debug a working transport. The escape route is evaluated where the entry's STATE
is READ rather than at any writer of the mark, because the mark has four writers and a per-writer fix is
one bug per writer nobody enumerated; it is keyed on reaching that branch rather than on any reason
string, so a future terminal condition inherits it by construction. It obeys the same promote-before-
discard invariant as the readiness-gate resolution above, and records a `spool_terminal_unrouted` event
— **not** `spool_terminal_delivery_failed`, which would assert in the log the very failure the notice
beside it declines to claim.

**A settled entry reconciles rather than sitting (tap-6vwz).** Every `tap_is_done` check in the drain
sits BELOW a `continue`, so an entry that reached the escalated gate or the terminal-reason branch was
skipped before anything could reap it — and stayed spooled after its own settlement, indefinitely. Both
states now reap a settled entry (promoting first, `spool_terminal_settled`) before those gates are
reached. This is deliberately general rather than scoped to the excluded class: an entry carrying a
`.done`/`.cancelled` receipt has nothing left to wait for, whatever parked it. An escalated entry that
is still UNSETTLED is untouched and stays parked for human disposition, exactly as tap-zeng requires.

**The unroutable mark preserves the reason it displaces (tap-6vwz).** `reason`/`reason_class` were
overwritten in place, so the values naming WHY an entry was marked were destroyed by the marking, and
`registry-events` had no action for the transition at all — leaving one live specimen whose origin is
unrecoverable from either the entry or the log. The mark now keeps `original_reason` (the FIRST
displaced value, so a chain of marks cannot erase the origin) plus a bounded `reason_history`, and emits
`spool_marked_unroutable` on a real transition only — a re-mark is a no-op and must not spam the log,
since the drain re-marks on every pass.

**The wake is ONE-SHOT — it is never retried.** The drain skips any entry carrying `escalated_at`,
which is set before the wake is attempted, so no later tick re-attempts it. A wake that fails leaves
the entry held **permanently** until something outside the drain acts. Two consequences the next
designer will otherwise have to rediscover: the sender's pane must already be able to accept an
injection at the moment the deadline fires — waiting longer cannot rescue a wake, because nothing
will try again — and any test of this path must assert the CONDITIONAL (terminal **iff** the wake was
confirmed) rather than either branch, since which branch occurs depends on a pane state the caller
does not control.

The same addressing applies to the OTHER exit from stop-retrying: a redelivery that returns
submit-unverified (rc 5) already removes the entry and halts automatic retry. That decision is
unchanged and correct; it now reaches the sender too, instead of being recorded only to
`registry-events` and rendered only by `tap outstanding` — a pull surface behind a doctrine that
tells senders never to poll.

