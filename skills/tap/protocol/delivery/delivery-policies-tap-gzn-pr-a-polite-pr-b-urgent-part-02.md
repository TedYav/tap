# Delivery policies (tap-gzn PR-A: polite; PR-B: urgent) — source part 2 of 5

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0090 start=596409 end=605309 sha256=3848287b1ad0021c3cf0d2c8c32b6c3f9eeb3c08abf4a23c1c17a954005e30da fragment=2/5 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
**now (default) — inject when its window is due and the input band is empty.** That path returns `0/injected, delivery=pane`. A real pending draft instead parks with `policy=standard`, `deadline_epoch=first_spooled_epoch+60`, one best-effort green arrival cue, and `0/queued, delivery=spool`; an early-clear shared drain sends immediately, while the deadline rechecks the live band and then uses the shipped backup/clear/submit verifier. At T-10 a drain may show a best-effort red cue; no cue state is persisted.

**polite — park under the polite policy, then use the same 60-second final grace.** `tap send --polite [--polite-timeout <seconds>]` parks immediately after the denylist/pane-validity safety gate, without touching the pane (no copy-mode cancellation, no input clear — tap-lek8), even on a legacy bus. Its default timeout is 600s and its final `deadline_epoch` is `first_spooled_epoch + timeout_seconds + 60`; ordinary busy delivery may clobber only at that 660-second horizon. `reason_class=safety_gate` is never deadline-clobberable and escalates safely instead. Delivery does not depend on a watcher: the shared drain and detached deliverer own correctness (that deliverer is bounded by its park's deadline for every class except a held live entry — see §Placed-but-undelivered). Green is not replayed.

**A parked entry owns its scheduled retry.** A window/cooldown park starts a
detached deliverer in its own process session, with inherited lock descriptors
closed, before returning acceptance. Caller process-group cleanup must not end
that waiter. Window delivery does not require `tap watch` supervision or a
reminders-only tick: the waiter retries through the shared drain at the window
boundary and keeps the existing readiness and no-duplicate-effect guards.

`tap poll` and `tap outstanding` label an active park `stale-park` when its recorded
`next_probe_epoch` is more than 30 seconds overdue. This is a delivery alarm:
retry progress is not observed, rather than an assertion that a recipient attempt
occurred. It does not authorize replay or pane effects. Existing injected,
unconfirmed, and escalated dispositions take precedence over the stale schedule.

**`--wake` is not a fourth delivery class.** It remains an accepted note spelling. All new notes are recipient-settled, and the flag changes neither arrival nor the order-shaped-note guard.

**interrupt — explicitly permit preemption, then inject.** `tap send --delivery interrupt` (exact alias: `--urgent`) runs the SAME safety gate as every other policy first (pane-validity, denylist/unsupported-harness terminal refusal, copy-mode auto-exit-or-queue), plus — for agy — the permission-modal refusal, which is evaluated BEFORE urgent's keystroke rather than with the rest of the band pre-check. Urgent interrupts a TURN; it never defeats pane safety, and the agy ordering is what keeps that true now that agy has a keystroke: the modal refusal lives in the band pre-check, which runs AFTER the interrupt, so a modal that `Escape` might dismiss would be gone before the classifier could see it (tap-92v3r). A stuck copy-mode safety gate becomes `reason_class=safety_gate`, so it can only escalate at timeout; denylisted/unsupported targets terminal-refuse. When either later redelivers, the shared drain uses a plain, non-interrupting injection because the harness is no longer mid-turn. Once the gate passes, the courier sends the harness's own abort keystroke (the native interrupt sequence in `runtime/bun/src/tmux.ts` — same per-family harness-profile pattern as the queue prefix) BEFORE constructing/injecting the sentinel, with Cursor’s input semantics corrected by field observation:

| harness  | interrupt keystroke | notes |
| --- | --- | --- |
| claude / codex | `Escape` ×1 | queues mid-turn natively; injection mechanics after the interrupt are identical to default — the interrupt is what makes the message land NOW instead of merely queuing behind the current turn |
| agy | `Escape` ×1 | same as the row above (tap-92v3r; the keystroke was verified by hand on a live seat, 2026-09-03). agy had no row until then, which was invisible because the pre-tap-92v3r readiness gate refused a generating agy pane outright — urgent deferred, so nothing asked. It carries one extra refusal, evaluated before the keystroke: a recognized permission modal defers at rc 4 with zero pane effects |
| cursor | `Ctrl+C` ×1 | then inject + `Enter`; unconditional, no queue/footer inspection. Queue is FIFO; `Esc` cancels/drops queued messages and is never used for Cursor delivery or recovery. Plain delivery injects + `Enter`, waits about 0.25 s, then `Enter` again. |
| opencode | `Escape` ×2 | one `tmux send-keys` call with two `Escape` key names |
| hermes | (none) | its bare, un-prefixed inject already IS the interrupt (the exact inverse of its default `/queue ` behavior) — urgent forces the queue prefix OFF for hermes specifically, never sends an escape |
| any other harness | — | structurally unreachable: `tap_classify_harness` already terminal-refuses `unsupported`/`denylist` panes before urgent-specific code runs, for every policy, so the interrupt sequence is only ever requested for one of the rows above |

Interrupt keys go through `tmux send-keys`, followed by the existing settle and paste/verify path. Before any interrupt key, TAP attempts a snapshot of visible human draft text through the shared input-backup writer. The later clear reuses that snapshot when the text still matches; changed input gets a separate snapshot. A backup failure is disclosed and does not prevent the interrupt key. The existing clear and restore checks still govern later composer effects. When the interrupt's `Escape` empties the composer, the owner notice still fires from the pre-key backup on the interrupt path itself (tap-u7ra7; see the clobber page's owner-notice clause). A draft backup cannot restore a cancelled turn or tool call.

**Interrupt disclosure (tap-f3br).** The courier writes `interrupt-intent` before abort input and `interrupt-sent` only after tmux accepts it. These additive rows use the existing `receipts/<id>.submit-phases.jsonl` owner and archive path. Each records the attempt, recipient, pane, harness, method, keys, `tmux_confirmed`, `cancellation: unknown`, and any pre-key draft backup or backup error. Intent-write failure withholds the abort input; failure to record acceptance afterward preserves possible-effect evidence and never permits retry. Hermes records the pair around its first bare Enter, since it has no separate interrupt key. A modal refusal or auto-permission downgrade emits no interrupt row.

Sender stderr warns at intent and reports the returned fact after the courier returns. The send owner writes `urgent_interrupt` from that fact under its existing reset custody; it no longer logs a requested interrupt before the courier's safety gates. `tap read` displays the disruption warning before the body, and `tap show` exposes it for inspection, including after an unconfirmed submission. The warning opens with TAP's attribution (tap-1i81h): the message may have interrupted the recipient, the user did not, and another agent's automated interruption needed its attention. Claude renders an interrupted tool call as the user's stop order, so TAP stamps this from the recorded interrupt evidence rather than leaving it to the sender; the payload bytes stay the sender's. Intent alone means input acceptance is unconfirmed. A sent row means tmux accepted the input, never that the harness cancelled or completed a particular tool. TAP cannot name the cancelled work; the recipient must inspect in-flight work and any paused persistent goal before continuing. Automatic goal resume is separate work (`tap-czsmr`).

The envelope retains courier-authored `urgency: urgent` as explicit interrupt provenance. The v0.23 sentinel uses the bare `urgent` tag independently of `escalate`; an explicit interrupting escalation carries both. The direct interrupt send also carries `agent-interrupt` after `urgent`, so the attribution is visible before the recipient reads; redelivery re-renders from the envelope without it. Spool delivery always passes `urgent=0`. Interrupt phases cannot authorize a zero-Enter re-probe, and the existing resend exclusions remain unchanged.

**Foreign stuck sentinel (tap-rdy9n).** Urgent never clears a TAP sentinel from the composer, so one already visible there parks the send (`reason=no-input-prompt`, exit 0) BEFORE the interrupt keystroke: an interrupt that cannot lead to delivery is not sent. When that sentinel is addressed to a different `<team>/<handle>`, the stderr line and the queued JSON receipt's `detail` name its recipient and id, since a sentinel for another seat suggests a stale or rebound pane.

Spool payloads remain durable while delivery is pending. The watcher runs one native spool pass per tick (`processSpool` in `watch-tick-run.ts`, which runs `spool-engine.ts watch`); a detached deliverer starts after a real park, bounded by that park's deadline except for a held live entry (§Placed-but-undelivered). Those owners share the stored-pane readiness, claim, retry and escalation path. Registration does not drain inline. If the detached owner stops and watch is off, automatic delivery is not guaranteed; the recipient can discover parked mail with `tap poll <me>` and process it with `tap read <id>`. Observation verbs (`tap team` and its subcommands, `tap crew list`, `tap outstanding`) never drain. `tap send`, `tap reply`, and reply's private settlement primitive also never run a synchronous drain. `TAP_SPOOL_DISABLE_DELIVERER` retains its separate meaning. Every drain redelivery is plain (`urgent=0`): an urgent envelope retains its informational marker but never replays an interrupt.

**Redelivery and settlement (tap-6fd0x).** Per-id redelivery holds the exact-id obligation lock from eligibility through submission and disposition, using the same lock as recipient read and cancellation. The drain acquires the obligation lock before the spool claim, matching read and cancellation, and releases both on every attempt exit. A queue claim alone does not protect the payload after promotion to its canonical path. If settlement or cancellation wins before redelivery acquires the lock, the courier skips the attempt and records `redelivery_skipped` with `effect=none` and one of these reasons:

| Terminal receipt | No prior transport evidence | Prior `.attempted`, `.sent`, or `.harness-queued` evidence |
|---|---|---|
| `.done` | `settled-before-delivery` | `settled-after-delivery-attempt` |
| `.cancelled` | `cancelled-before-delivery` | `cancelled-after-delivery-attempt` |

The skip describes the current attempt. It neither withdraws an already injected or harness-queued sentinel nor rewrites recipient settlement. Detached waiters close the inherited obligation descriptor (fd 8) at spawn, so a re-park cannot keep the parent transaction's lock alive after that parent exits.

**Escalated state resolves in one of two ways (v0.21, tap-13c8).** Escalation used to be a single
terminal-ish state — marked, skipped by the drain, awaiting human disposition — and it notified only
`tap_spool_on_escalate`, a hook defined solely in the watcher (then `tap-watch.sh`). On any fleet not running the
watcher, escalation reached **nobody**: a correct decision with no addressee.

