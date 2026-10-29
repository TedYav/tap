# Operator input controls: WAIT, STOP and START

Normative TAP v0.23 protocol. Draft backup and recovery remain owned by
[pending input](pending-input-standard-grace-then-the-clobber-pipeline-part-01.md).

## Draft grace and one WAIT snooze per draft

The pane flash is the arrival cue. There is no countdown/status-line banner while the human types: tmux clears transient messages on keystrokes, causing flicker. A persistent, non-focusing notice remains deferred (tap-jf2b8); TAP does not change the operator's border or status settings. Normal draft grace is30s; urgent draft grace is10s. Bare composers still receive immediately. A new urgent arrival can shorten an ordinary countdown to at most10s but cannot extend an earlier deadline or override an active snooze.

Uppercase `WAIT` anywhere in the observed input region latches one snooze for that draft. Normalized input comparison tolerates visual wrapping; transcript text is not the search surface. Incidental matches are accepted. The snooze ends after120s or on two positively bare, same-identity observations at least250ms apart. Unreadable output, a modal, queued input or a hidden attachment is not an empty composer. Deleting WAIT does not cancel the snooze. Repeated WAITs and new arrivals do not extend it. WAIT remains ordinary user text and reaches the harness if the user submits it.

The durable record is scoped to physical tmux server and pane generation. Its consumed marker survives expiry and restoration of the same draft. All courier effects, including interrupt and copy-mode cancellation, honor the active record. The existing waiter keeps one read-only pane observer until the draft is observed empty or its identity ends; it does not send input. A later message batch can get a fresh grace without renewing the same draft's consumed snooze. A submit-and-retype transition entirely between samples remains unobservable and conservatively retains the consumed marker.

The snooze itself is visible only through pane flashes; nothing takes keyboard focus and no banner is rendered. Latching the snooze flashes the pane background blue exactly once. Thirty seconds before the snooze deadline the background flashes green, and ten seconds before it flashes red; each milestone flashes at most once per snooze. The next due milestone is claimed in the pane-shared record before the flash, so whichever observer — send path, waiter draft probe, or spool drain — sees it first, the pane flashes once and parallel observers add nothing. While a snooze is active every arrival parks silently: ordinary and urgent parks suppress their usual green and red arrival cues so they cannot mask the milestones. Arrival cues outside an active snooze are unchanged. The snooze is per draft: once the snoozed draft releases and its record clears, a fresh WAIT latches a fresh snooze with its own blue.

Queue explanations and sender outstanding show the effective hold and expiry. Observers never sleep with the pane submit lock held.

## STOP and START: hold mail across TUI views

While incoming mail is pending and the courier is watching, a composer containing
only uppercase `STOP` (ignoring surrounding whitespace) holds all mail for that
pane, including urgent and later arrivals. Wait for the blue flash and attached-client
notice with the expiry before changing views. The hold survives an empty composer,
redraws and side views such as Claude's `/btw`. Typing STOP with no pending mail has
no effect.

A composer containing only uppercase `START` releases the hold. `STOPPED`,
`START HERE`, lowercase words and a visible tail that may hide earlier draft rows
do not match. STOP expires ten minutes after it was first observed; repeated words,
new mail and urgent mail do not renew it. Release and expiry return delivery to
its normal identity, modal, readiness and draft guards. The same STOP cannot rearm
until a confirmed empty composer ends that draft.
Deadline alerts resume with their normal window measured once from release or
expiry; the retained STOP marker does not suppress them indefinitely. A later
message batch receives its ordinary draft grace.

START flashes green and acknowledges the release through the same attached-client
notice path. The courier may back up exact START, recheck its identity and complete
composer, persist a separate one-use cleanup claim, then send one C-u. This adds no
payload bytes and never consumes the message's delivery-attempt license. It never
retries an unverified clear or restores START. If the clear cannot be verified,
mail remains queued until the operator clears the composer; other text is untouched
by this cleanup. No popup takes focus.

`tap outstanding`, `tap poll` and `tap doctor <seat>` show the STOP expiry. WAIT
retains its existing one-draft, two-minute snooze and releases on a stable empty
composer; STOP is the control for leaving and returning to the main view.
