# Pending input: standard grace, then the clobber pipeline — source part 2 of 2

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0108 start=719648 end=721780 sha256=dafdb22f080c8aab6fe837f1ba22351f9546951d0c9234eb3b5ded333e45956d fragment=2/2 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
Styled placeholder/completion text is render noise, not input: SGR-2 spans and Hermes's calibrated SGR-3-plus-`38;5;136` hint are treated as an empty box — no backup, no clear. Hermes hint wording is not an authority: two live seats drew different text with the same attribute pair, while a paired real typed-input capture was plain after SGR 39. Both Hermes attributes are required together; italic-only or muted-colour-only text remains real input. A known paste-collapse chip remains real input even when fully dim (Cursor Agent 2026.07.09's live `capture-pane -e` shape), so it still takes the backup/C-u path. Undimmed text is real input even when it looks placeholder-shaped. One deliberate exception: Cursor Agent's unpainted idle band whose entire prompt row is exactly the known whole-band chrome (`Add a follow-up` or `Plan, search, build anything`, optionally suffixed ` ctrl+c to stop`) classifies as an empty box by exact whole-band equality alone, without any dim-paint attribute. Hermes placeholder recognition remains based on its calibrated attribute pair, never on wording.

The remaining injection-safety outcomes split cleanly. No visible input prompt or copy-mode that cannot be cancelled is a retryable `0/queued, delivery=spool` acceptance on the Bash route; the native route also parks through the shared spool engine and never cancels copy-mode. A dead pane is exit 3. Denylisted or unsupported pane commands are terminal exit-1 refusals with no artifacts. A harness with a safe queue prefix is the narrow exception to the no-visible-input-prompt queue: Hermes receives `/queue ` plus the sentinel, and Hermes queues that line behind the current turn. OpenCode keeps its band-based path, while a known pre-inject paste-collapse chip is backed up and cleared so it cannot be mistaken for the courier's own paste; its band reads are chrome-normalized (see the box-anchor note below), so footer/overlay chrome never registers as pending input.

Backups live in the resolved bus's `input-backups/*.md`. They are local, gitignored, written with restrictive permissions, and sensitive by content. `tap doctor` reports paths and metadata only. `tap draft` lists retained drafts across the current team, newest first, with owner seat, time, preview and unique backup ID. Interactive selection prints and copies complete original text; Enter or `q` cancels. Noninteractive bare invocation and `--list` show the index without clipboard effects. An explicit backup ID selects that backup; a payload ID must be unambiguous. An incomplete snapshot warns before printing its visible text, leaves the clipboard unchanged, and returns2. Complete listing/copy succeeds with0. Operators can deliberately remove reviewed backups with `tap doctor --prune-input-backups`.


Machine configuration selects draft handling with `[injection] behavior = "clobber"`
(the default) or `"wait"`. `"warn"` is the earlier spelling of `"wait"` and reads the same.
`tap config set injection.behavior wait` changes the next delivery attempt. Unknown
values refuse delivery without clearing input.

In `clobber` mode, notes and asks honor the 30-second draft grace (explicit interrupts:10s), with the shared one-snooze WAIT protection described in part1. Notes keep
`draft_deadline_epoch` separate from their sender-escalation deadline. Only due
members enter a digest; fresh notes neither postpone older notes nor ride along
early. A batch admitted against an empty composer still preserves a draft that
appears before submission. In `wait` mode, warnings remain visible and input stays
intact; queued traffic delivers when the composer clears, with existing sender
escalation retained. Auto-permission seats retain their empty-composer boundary.

## Whole-draft capture and put-back (tap-ipex2)

A clobber first blinks the pane red twice (300 ms on, 200 ms off) while it holds the
pane submit lock, so the first clear key comes about a second after the first red frame.
The urgent interrupt cue blinks the same way before its interrupt key. These are the only
cues that dwell under the lock. Arrival, countdown and WAIT cues tint under the lock and
clear about 400 ms later with the lock released. The pane-effect token still admits one
effect at a time. A cue clears only its own token. A token older than five seconds, whose
owner never cleared it, no longer blocks later cues, and the clobber blink takes over any
cue token.

Claude's composer shows only its last rows (half the pane height less five, at least
three, on Claude Code 2.1.286). Its backup
is written before the first clear key as the visible rows, marked `capture_status:
incomplete` with `uncaptured_content: scrolled-rows`. Each C-u then removes one row from
the bottom, the viewport follows the cursor, and the row above the old top comes into view.
The clear loop reads every frame. A frame must be exactly one key away from the one
before: the bottom row shortened, or removed whole with the rest unchanged, and at most one
row revealed on top. Exactly one alignment may hold. The keys also tell the boundaries
apart. C-u on a typed line leaves an empty cursor row, and the next BSpace crosses a typed
newline. C-u that removes a row outright removed a soft-wrap continuation, and the next
BSpace names the join: the row unchanged means a wrap space, one character shorter means a
split token. Every soft-joined line must pass the same width-bounded wrap proof as a
scrolled `/compact`. When the composer empties with every step proven, the door
rewrites the backup it just published, in place, with the whole draft as logical lines,
and drops the incomplete mark. No other write drops it. A broken chain, an unexpected frame,
residue or a crash leaves the incomplete snapshot.

After a verified delivery, a complete backup is pasted back one line at a time. After each
line, the visible rows must be the tail of what was pasted: each logical line laid out by
the wrap proof, a typed newline forcing a row break, and the top visible row allowed to be
a partial cut. Exactly one parse may hold. An incomplete backup is never put back
automatically: the pane shows the incomplete notice and `tap draft` holds the text.

## Blank input: one rule (tap-lx4z0)

One blanking rule decides what counts as typed input everywhere: text that is only
whitespace in JavaScript's trim set, so a stray byte-order mark or no-break space counts
as blank. A band of only blanks classifies ready and spool readiness admits it, on every
harness. A complete backup whose body is only blanks is never typed back: the sender sees
`tap: input backup holds only whitespace; nothing to restore` and the owner gets no draft
notice. An incomplete backup keeps the incomplete notice and its file even when its
visible rows are blank, because rows above the viewport may hold text. Real drafts keep
every byte, surrounding blanks included.

## Readiness reads the whole composer (tap-uwp2r)

Claude, Cursor and Hermes readiness reads the prompt row first, but a draft can sit on
a continuation row under an empty prompt row. A prompt row that is blank under the rule
therefore defers to the whole composer, read by the same classifier delivery uses, so
readiness and delivery agree on what is a draft and the draft grace applies. Only the
escaped capture may show that draft: the plain capture has lost the dim styling that
marks an idle placeholder as chrome. A prompt row of only whitespace still admits the
pane only when both the escaped and plain captures classify ready. Codex, OpenCode and
agy already read their whole composer.

A Claude draft that ends in newlines can scroll its text out of the viewport, leaving
every visible row blank, and Claude draws no scroll indicator (tap-zo67f). A blank box
exactly at its height cap therefore classifies as a draft marked `scrolled`, and
readiness holds it for the draft grace. Delivery never clears it, even under
`deliver-anyway`, and an urgent send withholds its interrupt: each clear key reveals a
row the clear chain cannot tell apart from the blank ones, so the keys would erase
hidden lines that neither the composer nor a backup keeps. The message reparks until
the human submits or clears the draft. The cap comes from the pane's real
`#{pane_height}`, never a capture's line count; without that height the verdict is
unchanged, and a rate-limited height read holds. A whitespace-only draft that fills the cap also holds;
a held delivery is recoverable, and typing over a hidden draft is not.

## Draft grace and one WAIT snooze per draft

The pane flash is the arrival cue. There is no countdown/status-line banner while the human types: tmux clears transient messages on keystrokes, causing flicker. A persistent, non-focusing notice remains deferred (tap-jf2b8); TAP does not change the operator's border or status settings. Normal draft grace is30s; urgent draft grace is10s. Bare composers still receive immediately. A new urgent arrival can shorten an ordinary countdown to at most10s but cannot extend an earlier deadline or override an active snooze.

Uppercase `WAIT` anywhere in the observed input region latches one snooze for that draft. Normalized input comparison tolerates visual wrapping; transcript text is not the search surface. Incidental matches are accepted. The snooze ends after120s or on two positively bare, same-identity observations at least250ms apart. Unreadable output, a modal, queued input or a hidden attachment is not an empty composer. Deleting WAIT does not cancel the snooze. Repeated WAITs and new arrivals do not extend it. WAIT remains ordinary user text and reaches the harness if the user submits it.

The durable record is scoped to physical tmux server and pane generation. Its consumed marker survives expiry and restoration of the same draft. All courier effects, including interrupt and copy-mode cancellation, honor the active record. The existing waiter keeps one read-only pane observer until the draft is observed empty or its identity ends; it does not send input. A later message batch can get a fresh grace without renewing the same draft's consumed snooze. A submit-and-retype transition entirely between samples remains unobservable and conservatively retains the consumed marker.

The snooze itself is visible only through pane flashes; nothing takes keyboard focus and no banner is rendered. Latching the snooze flashes the pane background blue exactly once. Thirty seconds before the snooze deadline the background flashes green, and ten seconds before it flashes red; each milestone flashes at most once per snooze. The next due milestone is claimed in the pane-shared record before the flash, so whichever observer — send path, waiter draft probe, or spool drain — sees it first, the pane flashes once and parallel observers add nothing. While a snooze is active every arrival parks silently: ordinary and urgent parks suppress their usual green and red arrival cues so they cannot mask the milestones. Arrival cues outside an active snooze are unchanged. The snooze is per draft: once the snoozed draft releases and its record clears, a fresh WAIT latches a fresh snooze with its own blue.

Queue explanations and sender outstanding show the effective hold and expiry. Observers never sleep with the pane submit lock held.
