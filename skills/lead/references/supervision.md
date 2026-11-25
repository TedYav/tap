# Supervision — who holds the sentinel

**The question is no longer "attended or unattended" — it is "who checks, and what wakes the
leader".** Every multi-seat run needs coverage: something that notices a silent board and produces a
wake. The choice is which seat carries it, and attendance is one input to that choice rather than a
mode that decides it (2026-08-13).

The recommended default is a **three-part hybrid**: push primary; **`tap watch`** as the mechanical
liveness leg, which is what notices team-level deadlock and stall from observable state; and an
**infrequent leader loop** (30–45 min) emitting minimal tokens when idle. `tap goalie` is an optional
judgment rung that composes above the watcher — it judges a positively-idle seat's belief state and
fails closed to `tap watch` — never the liveness leg on its own. Investigative status-checking
delegates to a cheap sentinel — a crew seat, an inexpensive team seat, or the pane-less `tap watch`
sidecar. `tap watch`'s `probe`/`notice` kinds are carved out by kind — excluded from courier pre-settlement AND from the delivery window — so its traffic genuinely does arrive promptly with no flag. A staffed seat has no carve-out: it reports with a plain `tap send` note, which stays owed until the leader reads it and rides the leader's delivery window like any other send (`--delivery interrupt` is the only class that bypasses it; `--wake` is an accepted compatibility spelling of the same note). So the leader's turns are not spent
on *checking*; the one scheduled tick it does keep is deliberate, because every other part of the
shape reaches the leader by delivery and a scheduled wake is the only coverage that survives
delivery itself failing. The choice of shape and the cost model are in the `cover-liveness` play
(`../plays/cover-liveness.md`); this file holds the recipes, including the scheduler-driven
substitute a leader on Codex or opencode arms instead.

This file owns the recipes. Both remain available and they compose — `tap watch` is a liveness
sidecar and a crew sentinel can carry judgment the watcher cannot.

## Leader-carried supervision — no daemon (the lead's supervise step IS the watch)

Reasonable on a short attended run, or where the checking genuinely needs the leader's judgment on
every pass. **There is no separate watcher daemon** — the lead's own supervise step is the watch
(dumb, observable-state-only: no timers, leases, or liveness-inference). Cheap in seats (one
supervisor) and scalable (peers don't poll), and paid for in the leader's own turns, which is the
trade the default now declines:

- The lead sets itself a `/goal` for persistence via `/tap:self` (`tap self goal
  -- '<text>'`). SHOULD: prefer `/goal` over raw `tmux send-keys` — `/goal` is a harness concept
  `/tap:self` owns, not TAP's.
  Author it as a per-turn **caught-up predicate** (inbox empty, no PR awaiting your gate),
  never as the mission end-state (PRs merged, beads closed). The Stop-hook evaluator cannot tell a
  yield-awaiting-an-event from a premature stop, so a mission-completion goal bounces every event-driven
  yield, and `/tap:self` sets or strengthens a goal but cannot clear one. The caught-up predicate keeps
  the catch that matters here: a `reply=expected` answered by `tap send` and never settled.
- It sends work with `tap send --ask` — a work order owes a tracked reply — then continues cleared conductor work that does not depend on the
  response. A send is not a yield boundary. Between useful lead actions, inspect observable outstanding
  state once: `tap nudge <peer>` if a sentinel is stuck unsubmitted in the peer's box, or re-send with
  `tap send` if the peer is stopped with an empty box (any delivered send restarts a stopped peer). This is supervision, not waiting: yield only when the
  next useful action needs an inbound result; inspect again on wake. (The golden rule — never
  poll-sleep — lives in `/tap`.)
- **Peers do NOT busy-wait** — event-driven (courier-poked) or on-demand, drain-before-stop. The lead
  is an O(1) supervisor over O(N) peers; adding agents adds no pollers.
- **Single point of failure (stated, not hidden):** nothing supervises the supervisor — if the lead's
  pane dies, outstanding work sits with no `.done` until a human notices. Acceptable when attended; it
  is not a reliability guarantee a lone lead can make. (`tap nudge` only re-submits a stuck sentinel
  it can see in the peer's box; it does not wake a stopped peer — re-send to wake one. Any delivered send does that, and `--delivery interrupt` is what skips the recipient's delivery window.)

## Delegated sentinel — `tap watch`, a crew seat, or a cheap team seat

**The default shape**, and not only for unattended runs — an attended run gets the same benefit,
since the leader's turns cost the same whether or not a human is watching. A `tap watch` sidecar
caught a real wait-stall on an attended run and the recovery was one push send.

Choosing between them: `tap watch` is pane-less, carries a lease and timers, and answers "is anyone
stuck?" mechanically from observable state. A crew or cheap team seat can carry judgment the watcher
cannot — "is this lane building the right thing?" — at the cost of a seat. They compose; a run can
have both.

**A staffed sentinel needs its own turn source, and its brief has to name it.** A crew or team seat
wakes on delivery like any other pane, so a board where every pane is idle leaves the sentinel asleep
alongside the run it was watching — `tap watch` is the only option here that carries its own timer.
Name what wakes the sentinel and what stops it, in the same brief that says what it checks. The
hybrid's leader loop is the backstop for the case delivery itself is what broke.

**A sentinel can arm the watcher, with one qualification:** the terminal escalation rung defaults to
the *armer* and notices route to `armed_by`, so an ephemeral crew seat arming it orphans the lease
and aims escalations at a handle that may be gone. The sentinel passes `--terminal <leader>`, or the
leader arms it directly — consistent with the armer-identity note below.

Whatever holds it, the reporting path is the same shape: a settle-only report to the leader — `tap watch` gets promptness from its reserved `probe`/`notice` kinds, which are carved out of both pre-settlement and the delivery window; a staffed sentinel uses a plain `tap send` note, owed until read, which still rides that window — which starts
the leader's turn. That is the wake for everything a sentinel can catch — and it is why the leader's
own tick can be infrequent rather than absent. The one the hybrid keeps covers what no send can
report: delivery itself failing.

### The `tap watch` sidecar

A per-team pane-less loop carrying a lease and timers. Armed once at kickoff from a registered pane:

```bash
tap watch on -m "<done_when>" [--evaluator codex|none] [--threshold <secs>] [--by <me>]
```

That one command writes the arm record AND spawns the sidecar in its own tmux window — no separate
daemon to start. Defaults: threshold 1500s (silence → wedge-suspect), tick 60s, evaluator `codex` (a
non-`none` evaluator prints a pane-transcript-egress consent line at arm). The armer identity matters
— escalations are sent on the armer's behalf, so the human's answer wakes the armer's pane. Lifecycle:

- `tap watch status` / `tap health` — read the arm record; `tap health` warns on a dead watcher on an
  armed team. **Reboot residual:** the arm record survives a reboot but the watcher process does not,
  so an armed team is left unsupervised until re-armed — surfaced by `tap health`, not self-healed.
- `tap watch pause -m "<reason>" [--for <duration>]` — suppress silence probes during a known wait
  (default 4h); expiry notifies the armer.
- `tap watch resume` — start a fresh silence window; a non-armer pause/resume notifies the armer.
- `tap watch off` — disarm at close (only the armer by default; a non-armer needs `--force`, which
  disarms loudly and notifies the armer).
- `tap watch ack` — clear a sticky human-escalation NOTIFY after acting on it.
- Re-arming with a *different* `done_when` is refused; `tap watch on --rearm -m "<new>"` is the reset.

**Authoring a `done_when`.** The arm's `done_when` is the run's completion test, so make it checkable
from observable state, not self-report: (1) one measurable end state, (2) the command or artifact that
proves it, (3) the invariants that must not change, (4) a hard bound (time or iterations).

With an evaluator, the sidecar's `done_when`, that hard bound and `tap escalate` own mission completion in an unattended run; with `--evaluator none` the `done_when` is never consulted and the lease stays until `tap watch off`. Any `/goal` set alongside stays the caught-up predicate above, and "watcher alive" belongs to this sidecar, not to that predicate.

**Escalation path (machine-level, zero setup).** When the watcher exhausts its probe chain it runs
`tap escalate`, which reaches the human **directly** — it invokes the machine's notifier
(`notify-user`) with a one-line question labelled by the asking seat, rendering on the phone as
`❓ <question> — <team>/<handle>`. There is no target to configure and no gateway seat in the path:
the premise of escalating is that the human may be away, so the hop must not depend on another local
agent being alive to relay it. The label names the seat so the human can attach to that session and
answer in the asking pane. Escalating never parks the run — the escalating seat keeps working on
whatever does not depend on the answer.

## Drift-peek — the direction check, and where it can live

The watcher answers "is anyone *stuck*?"; the **drift-peek** answers "is everyone building the
*right thing*?" — judgment no script has. That judgment does not have to run on the leader's seat: a
crew sentinel briefed on what the run is trying to build can peek and report with a plain `tap send` note (owed until read; it rides the leader's window like any send), which
is the cheaper default for the same reason ticking is. Keep it on the leader's own seat when the
direction call genuinely needs the leader's context — and when you do, that is a leader-seat wake
like any other: worth its turns, and worth saying why.

Adaptive, not a fixed clock: estimate how long the current phase should take and schedule a wake
accordingly (30–60 min is the usual band, and inside the cache window with margin at the lower end);
an inbound tap clears the pending timer; every wake re-evaluates before re-arming. Give it a
stop condition, evaluated by the scheduler where the mechanism allows it, so the peek cannot outlive
the phase it was watching. On wake, review observable
state (bus, git, `tap peek`) for both liveness and direction, and tap a peer that has drifted
off-course. Neither the watcher nor the drift-peek busy-waits. During a watcher's bring-up the
drift-peek is also the independent backstop — it stays armed until the watcher has handled its first
real episode (a supervisor has no supervisor until proven).

## The leader loop, and its substitute where `/tap:self loop` does not run

The leader's own loop is `/tap:self loop` at 30–45 min with minimal idle output. It runs on Claude Code
only: it exits 6 on Codex and opencode (`skills/self/SKILL.md`). The supported substitute is a
**scheduler-driven poll seat**: register one
(`tap in cron-watch --delivery poll --team <team> --unattended`), then have cron or launchd run
`tap send <leader> --from cron-watch --team <team> --wake -f <path>` (or `-f - <<'EOF'`) on cadence,
with `scheduled liveness wake` as the body
(`skills/tap/USAGE.md`). The body, `--from` and `--team` are each required. `--wake` is an accepted
compatibility spelling and optional: every new note is already settled by its recipient, so the
tick stays owed until the leader reads it
([settlement rules](../../tap/protocol/messages/reply-expectation-v0-3-part-02.md#courier-deferred-auto-settlement-tap-31it)).
It does not arrive sooner: it rides the leader's delivery window like any other send. Its residual:
the wake still depends on the courier and the leader's pane, restoring the schedule but not
delivery-independence, so `tap watch`'s machine-level escalation (no relay seat; above) is the last rung. A loop *beyond* the shape —
frequent ticks, investigative work back on the leader's seat — still earns a word to the user.

**`/tap:self goal`** checks a completion condition at turn end. Use it to persist until work is
done. It cannot schedule a wake and exits 6 on opencode. Use a scheduled wake for a future time:
a goal that cannot succeed until then keeps starting new turns, so the pane never idles long
enough for the courier to deliver a push.

**On each wake, whoever holds it:** poll+settle → in-flight blocked-on-me → `bd ready`
re-enumeration → runway vs boundary → act, or one line pricing the idleness you're choosing.

## Monitor seats and goalie declarations

Assign **MONITOR** seats for recurring checks (nightwatch, goalie, context genie).
Their [protocol](../../tap/protocol/supervision/monitor.md) requires a sample heartbeat
each cycle and a `monitor heartbeat age` line in your tick, with missing, invalid
and stale readings explicit. Agree on cadence, recipient and stop condition in
the charter.

When `tap-goalie` watches the board ledger, declare its current objective as `OBJECTIVE: <text>` and
each armed trigger as `TRIGGER: <text> | due <time>`. Use an ISO-8601 timestamp for `<time>` — a date,
or a time with `Z`, an offset, or neither. A stamp with no offset is read as UTC (for example,
`2026-08-19`, `2026-08-19T13:00:00Z`, or `2026-08-19T13:00:00-07:00`); the wake surfaces declared
triggers when overdue.
Objectives end only by replacement or exception. A missing declaration remains visibly undeclared in
the wake; the role's standing default is to drain the ready queue or state the
exception.
