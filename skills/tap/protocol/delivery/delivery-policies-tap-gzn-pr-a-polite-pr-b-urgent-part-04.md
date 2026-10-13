# Delivery policies (tap-gzn PR-A: polite; PR-B: urgent) — source part 4 of 5

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0092 start=613546 end=618652 sha256=47132678dc684d19e51854b66271bfd5cb5d0e6feb1efa313de2db96e3abd707 fragment=4/5 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
**The direct `tap send` path's own submit-unverified exit (rc 5) durably records the same shape
(tap-xity):** `registry-events` gains `action=send_submit_unverified` (actor is the sender, mirroring
`urgent_interrupt`'s same-process shape, not the redelivery event's `courier` actor) alongside the
existing `redelivery_submit_unverified`. `tap outstanding` renders it as a `send_unverified`
condition, worded like `redelivery_stopped`'s — reports the SUBMIT going unconfirmed, never claims
non-delivery, since the canonical payload stays on the bus and the peer may already have it — with
remedy `tap show <id>`. The `.placed`-without-`.sent` ladder likewise says delivery is not confirmed and names inspection, then a same-ID `tap resend <id>` if it is still unread. What
the durable event adds over the ladder: the ladder is derived from receipt residue at read time (it
says nothing about what actually happened and vanishes if the receipts change), while the event is a
durable record of the submit-unverified moment itself; a prominent `CONDITION` line rather than a
bracketed row suffix; and a `--json` surface for supervisors. Before this, a direct send's
submit-unverified exit left only a terminal-only print at the sender's own pane at the instant it
happened, with no durable trace and no CONDITION-level surface in `tap outstanding`.

Consequence for readers of escalated state (`tap doctor`'s `escalated: yes/no`, watch's episode
dedup): a *persisting* escalated entry means either that the entry is not a readiness-gate park —
safety-gate and polite-deadline parks still await human disposition, unchanged — or, for a
readiness-gate entry, that
**the sender could not be reached**. What it no longer means on its own is merely that a deadline
passed.

**Grace deadline after a pre-effect refusal (tap-2m079):** Authorized grace-expiry backup/clear/submit remains unchanged. If a standard grace-window park's deadline probe refuses delivery while the recipient is present (for example, a live clear fence), and no possible-attempt marker exists, it stays eligible for later probes under the existing waiter lease and positive cadence. A marker is rechecked under the entry claim before solo or digest delivery. Marker presence, including empty or torn evidence, forbids this recovery; historical possible-effect residue is never retried merely because its probe history looks pre-effect.

**Grace deadline after a possible attempt (tap-2d6h2):** A grace-window entry
with an `.attempted` marker cannot enter another recipient injection or digest.
At its deadline, including recovery of an already-escalated entry, the courier
publishes one deterministic delivery-unconfirmed notice to the sender's inbox
and records `<id>.unconfirmed` with its `notice_id`. The notice remains readable
when the sender has no pane; its optional pane wake is attempted at most once.
Neither the receipt nor notice publication proves recipient or sender processing.
The original canonical and spool bytes remain available, with the spool entry
excluded from automatic delivery. This terminal transport record is neither
`.cancelled` nor `.done`: the original obligation remains outstanding until the
recipient settles it or the sender explicitly cancels it (an ask read alone
records observation and remains open). `cancel --spooled` accepts retained
unconfirmed custody and records `unconfirmed_withdrawn`, without asserting
non-delivery. Repeated drains preserve
the notice identity and do not repeat its possible pane effect.

**Terminal solo redelivery after a possible attempt (tap-67y3s):** A solo spool
redelivery that ends submit-unverified (rc 5) or rate-refused with attempt evidence
(rc 124) receives the same honest disposition, whether the drain or the spool engine
worker ran it. The redelivery removes the spool entry and stops automatic retry as
before. It then publishes the same deterministic `<id>-delivery-unconfirmed` notice
and records `<id>.unconfirmed` (`status: unconfirmed`, `effect: possible`,
`notice_id`) with `reason: redelivery_submit_unverified` (rc 5) or
`reason: redelivery_rate_limited` (rc 124), plus one
`spool_terminal_delivery_unconfirmed` event. Rc 124 is labeled `possible` because
the `.attempted` marker it requires is the possible-effect marker: an earlier draft
clear or interrupt may precede the refused paste. A rate refusal without that marker
is pre-effect and reparks as rc 1 with no disposition. The receipt is written only
when the notice is published; a notice whose optional sender-pane wake fails after
publication still counts as published. A failed or suppressed notice is never
retried. When the spool entry's removal is refused (reset custody or a held metadata
lock), the retained entry is terminal only if the repark license refuses it (mark plus
`.attempted`). A pre-effect rc 5 with no attempt evidence, such as a failed draft
backup, stays licensed: recovery re-parks it and it gets no disposition. A terminal
retained entry has its notice published, but the receipt is
left to the orphan sweep, which archives the retained metadata and records
`reason: orphaned_spool`. A receipt beside the sidecar would stop that sweep. A
staged-idle hold that is held, whose hold decision was refused by a busy metadata
lock, or whose post-submit custody was refused, may still be re-adopted, so it is
not terminal and receives no disposition. The
drain no longer adds a second notice under a freshly minted id, so one failure
produces exactly one notice. The `.unconfirmed` readers key on the file's
existence: `tap show`, the queue explanation and `tap outstanding` surface it as
unconfirmed custody, and input protection stops counting it as pending.

At enqueue, the default sender receipt names the park's `reason_class/reason`
in plain language and reports the next scheduled probe, grace deadline and
possible-attempt disposition. `show` and `outstanding` use the same explanation.
An occupied composer may contain queued input or a human draft; the explanation
does not infer a running turn from occupancy alone. Waiters update the recorded
next probe before sleeping. A past scheduled time is labeled unconfirmed, not
presented as a future delivery promise; no probe time guarantees delivery.


**Drain budget vs escalated mail (tap-zeng):** `attempts` increments only when a drain actually tries redelivery (`ready`, or busy past `deadline_epoch`). Busy probes alone leave `attempts=0` by design. Entries that already carry `escalated_at` **and could not be handed to their sender** stay parked for human disposition but **do not** consume `TAP_SPOOL_DRAIN_CAP` and **do not** enter a courier digest — otherwise an oldest-first cap of already-escalated mail starves younger ready mail (the younger mail stays at `attempts` 0 behind the escalated front). The watcher's own queued probe likewise does not consume the per-pass cap, and the capped walk stays open for it until it is past; an unparseable cap still ends Phase B before any entry (tap-oir29).

The watcher's per-tick use of that shared drain (`processSpool` in `watch-tick-run.ts`, which runs `spool-engine.ts watch`) also redelivers ANY spooled entry regardless of origin (an ordinary default-policy no-input-prompt defer redelivers here too, it just never timeout-degrades — see below), so U14/U15 close the loop tap-pec opened. Every tick, unconditionally, independent of episode/silence state (a parked send is a per-entry fact, never a whole-team one):


**Prompt wake after a draft clears (tap-3229c).** During an unexpired
`pending-input` park with no possible-attempt receipt, the existing waiter
observes the shared readiness draft reader at 250 ms intervals within its
current cadence/deadline bound. Two consecutive bare-composer observations of
the same pane binding wake the scoped drain early, including while the harness
is working. A draft, unreadable frame or changed binding resets the pair. A
possible attempt or removed payload stops this observation. No new process or
queue owns injection: the ordinary drain still rechecks all delivery authority
and input guards. Other park reasons keep their existing cadence, and a full
scheduled probe remains the fallback when no clear pair is observed.
