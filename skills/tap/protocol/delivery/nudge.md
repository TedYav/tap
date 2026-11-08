# `tap nudge`: the unstick ladder and fan-out

Normative page for `tap nudge` (tap-voys3, tap-s1k5j, tap-gridx, tap-xe42x). `tap help nudge`
carries usage, examples and exits; [CLI surface](./cli-surface-the-whole-thing-part-10.md) points here.

```text
tap nudge <to> | --to <to> [--message <text>] [--no-interrupt] [--dry-run]
tap nudge [<to>] --pane <tmux-target> [--dry-run]
tap nudge --harness <family> ...   # fan-out: see nudge-fanout.md
```

Superseded 2026-10-05 (tap-xe42x): the `--interrupt` form and its urgent note, the operator
`[Y/n]` prompt, the `--from` sender, `--reason`, `-m`/`-f` and `--aggressiveness`. Each retired
flag now refuses with `retired_option`, names its replacement and sends nothing.

For diagnosis-gated recovery with recorded lower-rung evidence, use [`tap unwedge`](./unwedge.md). Its selected nudge/Continue actions reuse this actuator with additional evidence guards.

## The ladder

One pass, top to bottom. Each rung presses at most one recorded key action. After any key may
have landed, every later stop exits 5 (`possible effect; do not re-nudge`), never retrying; only a
refusal before the first key exits 1. No rung sends
`C-c` on any harness: on an idle composer it can exit the harness.

Every key is one `recoveryEffect` in a recovery run under `TAP_INDEX_HOME/debug/recovery`
(`tap debug recovery <id>`), the one evidence store: the frame before, the intent, the gate
re-read at the key boundary, the target re-proof and the outcome. The run opens at the ladder's
first key (`createRun` with no payloads and no hold) and records the actor (below); a nudge that
only submits a staged sentinel keeps rung 2's own run, as before.

**Rung 1, a known blocker.** Capture the frame before any key. Exactly one row is allowlisted:
Claude's weekly usage-limit dialog (`claude-weekly-usage-limit`), matched on its bounded bottom
region (the `You've hit your weekly limit` line above `What do you want to do?`, exactly the
three captured options in order, `1. Stop and wait for limit to reset`, `2. Wait here, then
continue automatically at …` and `3. Switch to usage credits`, and the closing
`Enter to confirm · Esc to cancel` row). The
license is the match itself, re-proved inside the effect's gate on two fresh, byte-identical
samples taken at the key boundary; it licenses exactly one Escape, never Enter, a digit or an
option (option 3 spends money; 1 and 2 park the seat). Only a positively observed dismissal
continues: the pane is read again, and a still-showing, unreadable or newly blocked frame stops
at exit 5.

Any other dialog, an approval prompt, and Codex's hook-trust question get no key: nudge reports
`blocker_held` and the run ends, rungs 2 and 3 included.

The dialog could not be staged on demand. Its recognizer is pinned to a real 2.1.282 capture
(`runtime/bun/test/fixtures/usage-limit-modal/`); a manual Esc restoring the composer
is provenance for the key, not evidence that a hidden draft survives it.

**Rung 2, a staged sentinel.** A complete sentinel alone in the composer gets exactly one Enter.
The wire (ask, note or id-less doorbell) must be the composer's only text, read before the key,
so the Enter never sends a human draft along; a composer TAP cannot bound holds instead. This
rule is nudge's own: `tap send` delivery keeps its existing staged-submit proof. It applies
for every family (no four-Enter ladder), and the run ends. A Hermes wire staged bare or behind
`/queue ` gets the Enter only, never retyping. With nothing staged, the copy-mode park recovery
below runs.

**Rung 3, the doorbell.** Only for a registered seat's own bound pane, and only when the
composer reads `ready` through the full pane-state classification (`observePaneKind`: band,
height and copy mode) at every key boundary. A draft, queued follow-ups, partial TAP text or an
unreadable composer hold the nudge (`nudge_held`) with no key: nudge never types over a draft.

1. Interrupt (default): claude, codex, agy: Escape; opencode: Escape Escape. Then the composer
   must still read `ready`, or the run stops at exit 5 with nothing typed (an Escape that flushed
   queued input, for example).
2. Type the doorbell: one `send-keys -l` under the recovery effect's one literal-text license.
   It admits only the action `nudge type` whose text is byte-for-byte a rendered nudge wire
   (Hermes: optionally behind its `/queue ` prefix), and refuses typing when the frame classifies
   as blocked or unknown.
3. One Enter, verified by the wire leaving the composer (`nudgeExpected` binds the exact wire).

Cursor has no non-exiting interrupt key. After the doorbell's Enter it waits
`CURSOR_INTERRUPT_SETTLE_MS` (5000 ms), presses Enter, waits `CURSOR_INTERRUPT_GAP_MS` (200 ms) and
presses Enter again, each a recorded `cursor message-interrupt Enter` gated on a `ready`
composer. The submission and the two Enters are one effect for the no-retry ceiling.

Hermes has no interrupt key either: by default the bare doorbell's submission is its interrupt.

`--no-interrupt` skips only the interrupt: no key; Cursor skips its two Enters; Hermes types
`/queue <wire>` so the doorbell waits behind the current turn.

## The doorbell wire

```text
[[TAP v0.23 nudge]]
[[TAP v0.23 nudge message="<text>"]]
```

It names no payload, sender or recipient, owes no reply and grants no task: it asks the seat to
continue what it was doing and check `tap poll`. There is nothing to `tap read`. CLI nudges, relaunch continuation and unwedge continuation produce it. The message value is a JSON string literal, so quotes and backslashes
round-trip. Producers include a recovery notice by default: resume prior work and check `tap poll`;
if TAP interrupted the seat, that was not a user stop. A user's or message's explicit stop
remains binding. `--message` appends custom context after this fixed notice, with 105 UTF-8
bytes available; the composed decoded message remains bounded to 200 bytes. The renderer
and parser remain literal and preserve legacy bare wires. `--message` refuses, naming `tap send`: a newline or other control character,
`[[` or `]]`, a word starting with `@` or `/` (the composer's picker eats the Enter; the
inline-body rule `sentinelBodyInlineable`), or more than 200 UTF-8 bytes of the decoded text. It
never strips or rewrites custom text. The payload parser refuses an id-less nudge (`a nudge doorbell
names no payload id`), so no reader treats it as a payload.

## Target, `--pane` and the actor

`<to>` is `peer` or `team/peer`; `--to` is the named spelling; both together refuse. Nudging
your own seat refuses (`not_a_target`). A poll member refuses (`poll_mode_member`).

`--pane` repairs a pane no registered seat matches: rungs 1 and 2 only, and the output says
delivery was skipped because `--pane` overrides the registered seat. With `--message` or
`--no-interrupt` it refuses. Rung 3 only ever targets a registered seat's own pane.

The recovery run records who nudged as its `caller.actor`: the seat bound to the calling pane
(its verified active binding), else `user` at an interactive terminal with no seat binding,
else `unknown`. `TAP_SELF` is not consulted. The actor is audit evidence, never a sender or a
license: no rung refuses because the caller cannot be proven, and the doorbell carries none. `user` stays reserved and unclaimable (`tap register`, the launchers,
`tap restore`, `tap admin rebuild-registry` and `tap send --from user`/`tap send user` refuse
it). Operator notes already on a bus from before this change keep their delivery and
`operator_undeliverable` retirement rules.

## Dry run and machine policy

`--dry-run` reads the pane and prints each rung's would-be action; it presses nothing and opens
no hold. `[recovery] aggressiveness = "report-only"` in the launcher's `config.toml` makes every
nudge a dry run; `cautious` and `aggressive` both act. The run reports
`aggressiveness=<mode> source=<config|default>` on stderr. Broader UI repair belongs to
`tap detective`. A detective worker's own nudge (inside its `TAP_RECOVERY_RUN`) is rung 2 only,
under that run's mode.

## Stuck-sentinel identity and copy-mode recovery

The visible sentinel's recipient must agree with `<to>`; TAP re-authorizes the exact session,
designated pane and harness before copy-mode cancellation and before the Enter, and never
retypes the wire. Cross-team recovery names `team/peer`; `--pane` alone supplies no team
identity.

If an OpenCode seat's input band is unobservable (a terminal overprint, or a stuck
`input_band_absent` boot), nudge first runs the input-free repaint (window resize and restore,
never a keystroke), re-reads, and prints the before and after band state. A healed pane with no
stuck sentinel continues down the ladder; exit 8 reports a band still stuck after the repaint.

With no stuck sentinel, nudge also recovers a stale copy-mode park (tap-w85su). A copy-mode
refusal parks as `safety_gate`. Past its busy deadline the entry is escalated, and the drain
never retries an escalated row. Nudge requeues such a park for `<to>` on the caller's bus, scoped
to the target's registry, only if all of these hold:

- the pane reads out of copy mode;
- the entry records zero attempts behind a pre-attempt fence;
- no attempt, delivery, read, settlement or resend evidence exists;
- the payload and the entry name the target's own team and registry (a cross-team park
  recovers from the source bus);
- the seat's row, re-read at the write, is still active on the recorded pane with the payload's
  `recipient_instance`, and the live pane passes the courier's bound-identity guard.

The checks are made under the obligation lock, a no-steal claim, reset custody and the metadata
lock. Anything unreadable holds the park. Requeue is custody, not delivery: it clears the
escalation and hands the entry to the ordinary deliverer, whose own gates decide the pane effect.
The line reports `requeued copy-mode park <id>` or `held: <why>`, then `tap show <id>` for the
outcome. A park whose copy-mode cancel may have taken effect (`.attempted`) is never requeued.

If the pane is still in copy mode, nudge first leaves it once, when nobody can be scrolling it
(tap-zvuc9). This recovery authority needs no sentinel. It requires all of:

- a park that passes every requeue leg above except the mode read;
- `pane_in_mode=1` with `pane_mode=copy-mode`;
- no tmux client on any session showing the pane (grouped sessions and linked windows
  included), read from the client list and the session's attached count. Both reads must
  succeed, parse, and agree.

Otherwise the cancel is skipped and the park holds with the cause, e.g. `held: pane is still in
copy mode (a tmux client (/dev/ttys004) is viewing it; ...)`.

The cancel is one `send-keys -X cancel` in its own one-effect recovery run (`tap debug recovery
<id>`: payloads, frames, intent, events). After the intent is persisted, the key boundary
re-reads the park license, the clients and the mode; any change sends no key. `-X cancel` adds
no bytes, so it is not a delivery, and it never writes the payload's `.attempted`, which would
bar the requeue. The target is re-proved after those reads. A fresh read out of copy mode,
under the effect's mutex between two target proofs, records `verified` and prints `left copy mode on
<pane-id> (...; recovery=<id>)`; otherwise `copy-mode cancel refused|unverified: <why>`. The
unchanged requeue then re-reads the mode under custody, so a cancel that did not take holds.

Exit codes: 0 dismissed and continued, re-submitted, delivered, queued in the harness, a park
requeued or held, or nothing to do; 1 held or refused with nothing sent; 3 the pane is gone; 5 a
possible effect (an unverified key, submit or Enter); 8 the OpenCode band is still unreadable
after its repaint.

## Fan-out

`tap nudge --harness <family>` runs this ladder on error/blocked seats of one family by default. Selection,
skips, `--recently-working`, `--all`, compatibility `--active-within`, confirmation and exits live on [the fan-out page](./nudge-fanout.md).
