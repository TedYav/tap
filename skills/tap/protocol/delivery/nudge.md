# `tap nudge`: recovery, interrupt and fan-out

Normative page for `tap nudge` (tap-voys3, tap-s1k5j, tap-pkh9c, tap-gridx). `tap help nudge`
carries the usage, one example per form and the outcome table; this page carries the rest.
The grammar lines in [CLI surface part 10](./cli-surface-the-whole-thing-part-10.md) and
[part 11](./cli-surface-the-whole-thing-part-11.md) point here.

```text
tap nudge <to> | --to <to> [--pane <tmux-target>] [--aggressiveness report-only|cautious|aggressive]
tap nudge --interrupt <to> | --to <to> [--from <seat>] [--reason <text> | -m <text> | -f <file>]
tap nudge --harness <family> [--team <team>|'*'] [--from <seat>] [--interrupt] [--reason <text> | -m <text> | -f <file>] [--dry-run] [--yes]
```

## Target and sender

`<to>` is `peer` or `team/peer`. `--to` is the named spelling of the positional; both together
refuse (`usage_error`). Every flag is accepted before or after the target, and routing signals
count only in flag position: `-m --interrupt` is a body, not the interrupt form.

The interrupt and fan-out forms send a note, so they have a sender. Precedence, resolved and
validated once before any key or send:

1. `--from <seat|team/seat>`. A `team/seat` sender selects its own team's acting bus, so a
   caller outside every enrolled checkout still resolves. A `TAP_HOME` pin is honoured exactly:
   a sender on another team refuses (`usage_error`) rather than redirecting the pin.
2. `TAP_SELF`.
3. The seat registered for the calling pane. A pane that is a seat on another enrolled team
   refuses with `--from <team>/<seat>`; a stale, contested or unobservable pane identity
   refuses rather than falling through.
4. The operator, below.

A derived sender must be an active seat on its team (`unregistered_sender`); a poll seat is an
active sender, since settle-only mail needs no pane to answer from. The interrupt form refuses
the sender's own seat as its target (`not_a_target`); fan-out skips it.

The stuck-sentinel form types nothing new and sends no note, so it has no sender: `--from`
refuses with `recovery sends no note; --from applies to --interrupt and --harness`. Its recovery
run records only the invoking `TMUX_PANE`.

### The operator (`user`)

When no seat can be derived and both stdin and stderr are terminals, nudge asks on stderr:

```text
No TAP seat in this terminal. Send this nudge as you (the operator)? [Y/n]
```

Enter, `y` or `yes` sends from the reserved non-seat identity `user`, so the recipient sees that
a person sent it. Any other answer, or EOF, refuses with `cancelled` and sends nothing (exit 1).
Without a terminal the sender is unknown: `unregistered_sender`, recovery `pass --from
<seat|team/seat>, or run from an interactive terminal to send as the operator`. `--dry-run` at a
terminal previews `sender: user (operator; would prompt)` and asks nothing, but refuses whatever the
real run would refuse, a legacy `user` seat included. After the last answer, and before each fan-out send for any sender, nudge re-resolves the bus and
refuses `team_moved` if the team was reset, retired or moved while the person decided. The interrupt form asks only after every target refusal has passed; fan-out asks after it has
printed its targets, and not at all when there are none, so a person never consents to a nudge
that cannot go out.

There is deliberately no flag and no `--yes` for this path, an exception to the CLI rule that a
prompt has a scriptable alternative. The prompt is a consent guard, not proof of a person: an
agent's tool shell has no terminal, so it cannot answer and never becomes `user` by accident,
but anything that drives a terminal can answer it. A script names a seat with `--from`.

`user` is reserved: `tap register`, the launchers, `tap restore` and `tap admin rebuild-registry` refuse it as a handle, `tap
send --from user` and `tap send user` refuse (`reserved_handle`), and only nudge's in-process
operator authority may stamp it. A team that still has a seat named `user` from before the
reservation, on the sender's team or any target's, refuses operator nudges (`reserved_handle`)
before the prompt, until that seat re-registers under another handle. Its notes are settle-only, so no reply is owed and none can be
addressed back. A parked note from `user` is never retired as `sender_gone`: a missing seat row
cannot prove the operator left. Past the escalation grace (and only while no seat named `user` exists; a legacy seat's mail keeps the ordinary path) it retires as
`operator_undeliverable` with a `.cancelled` receipt, so it never strands `tap outstanding user`. If an operator note is undeliverable, the delivery-failed notice
has no seat to reach and is recorded as an event (`spool_notice_operator_recorded`), never a payload addressed to `user`.

When the caller's directory anchors no bus, an operator note to a `team/peer` target rides that
team's bus as a local send.

## Stuck-sentinel recovery

Re-submits a stuck, unsubmitted sentinel in a peer's input box; a safe no-op when none is
visible. The visible sentinel's recipient must agree with `<to>`; TAP re-authorizes the exact
session, designated pane and harness before copy-mode cancellation and before every Enter, and
never retypes the wire. Cross-team recovery names `team/peer`; `--pane` alone supplies no team
identity. A poll member refuses (`poll_mode_member`).

The shared `[recovery] aggressiveness` in the launcher's `config.toml` applies, and
`--aggressiveness` overrides it; with no setting the mode is `aggressive`. The run reports
`aggressiveness=<mode> source=<source>`. `report-only` captures the pane without keys or a
recovery hold; `cautious` and `aggressive` share nudge's complete-visible-sentinel ceiling.
Broader UI repair belongs to `tap detective`.

If an OpenCode seat's input band is unobservable (a terminal overprint, or a stuck
`input_band_absent` boot), nudge first runs the input-free repaint (window resize and restore,
never a keystroke), re-reads, and prints the before and after band state. A healed pane with no
stuck sentinel exits 0; exit 8 reports a band still stuck after the repaint.

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

Exit codes: 0 re-submitted, queued in the harness, a park requeued or held, or nothing stuck;
3 the pane is gone; 5 the submit is unverified; 8 the OpenCode band is still unreadable after
its repaint; 1 any refusal.

## Interrupt

The caller selects one registered, active, pane-backed seat. The courier's U4 interrupt for the
seat's family clears its pane (claude, codex, agy: Escape; opencode: Escape Escape; cursor: C-c;
hermes: no key, the note's own submission is the interrupt), then the note is submitted as an
urgent settle-only note carrying recovery-interrupt authority, so an auto-permission seat is
interrupted instead of parked. A human decision on screen is never interrupted.
Target refusals (`seat_launching`, `identity_unverified`, `poll_mode_member`, a suspended or
offline row) come before the sender is resolved, so the operator is never asked to authorize a
note to a seat that would refuse it.

The note body is `Nudge: continue what you were working on.`, or with `--reason "<text>"`,
`Nudge: <text>. Continue what you were working on.` `-m`/`-f` replace the whole body; `-f -`
reads stdin; `--reason` with `-m`/`-f` refuses. `--pane` is not available; suspended, offline
and poll members refuse. One explicit target needs no confirmation.

Outcome lines branch on the interrupt fact first:

| Outcome | Exit |
|---|---|
| `interrupted (delivered)` | 0 |
| `interrupted; note queued (<disposition>)` | 0 |
| `interrupted; note UNVERIFIED (possible effect; do not re-nudge)` | 5 |
| `UNVERIFIED (possible effect; ...)` with no keys fallen | 5 |
| `delivered (no interrupt keys sent)` / `<disposition> (no interrupt keys sent)` | 0 |
| refusal or `failed` | 1 |

A hermes target reports `interrupted; note queued (queued-harness)`: its no-prompt submit cannot
verify consumption, so it never claims delivery. Exit 5 is a possible effect; never re-nudge it.

## Fan-out

Wakes every live seat of one harness family, for example after a usage limit resets. `--team`
defaults to the sender's team; `'*'` is every enrolled team. Seats are the ones `tap team` reports
active; poll, offline, suspended and gone seats and the sender are skipped and listed, and a team
whose registry cannot be read is reported and fails the run. Each target gets one ordinary
settle-only note (`tap send --fyi`), so receipts, spool and occupancy rules apply unchanged.
Default body: `Automated nudge from <sender>: your usage limit may have reset. Check your queue
(tap poll) and continue your assigned work.`; `-m`/`-f` replace it (`-f -` is read once for every
seat).

Each seat's `instance` is pinned at selection and its harness, delivery mode and active status
are rechecked just before its send (`target_changed`). More than one target, or `'*'`, needs a y/N
confirmation at a terminal or `--yes` without one (`confirmation_required`). `--dry-run` resolves
the sender and previews the same targets, skips and unreadable teams, and sends nothing.

With `--interrupt`, each target takes the interrupt form above; the dry-run previews the family's
own interrupt keys and the exact note. Exit 0 when every target was delivered or queued; 5 when
any delivery was unverified (check `tap outstanding <sender>`; do not re-run); otherwise 1.
