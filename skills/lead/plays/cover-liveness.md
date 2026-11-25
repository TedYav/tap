# Cover liveness

**You own the answer to "what wakes me if nothing arrives?"** for the whole of the next quiet interval.

**Use when** you need to establish, verify or repair that coverage: seats or outside jobs will keep working while you are idle, a wake has fired or expired, or you cannot say what is armed.

**Not when** an effective wake is already verified for the interval. A seat that went quiet is `recover`.

The failure is silent: every seat armed and idle, each waiting for a wake no one will send. What binds is the coverage, not which seat provides it.

## Moves

- **Name what the wake depends on.** A harness or operating-system timer fires whether or not delivery works. A scheduled TAP send still needs the courier and your pane, so it restores the schedule and does not cover delivery failing. Every other signal reaches you by bus send; keep one wake that does not. *Worked:* you can state the mechanism and what it depends on.
- **Pick a shape.**
  - *Your own scheduled wake* fits a few seats and a warm prompt cache. Each wake is a read-only look and re-arms only while work is in flight, so the chain ends when the board clears. A one-shot needs a named owner to renew it; one that already fired covers nothing.
  - *The three-part hybrid* fits many lanes, an expensive or nearly full lead context, or a run that must outlive your session. **push primary**; **`tap watch`** as the mechanical liveness leg, the deadlock and activity detector; and an infrequent leader loop (30–45 min) with minimal output when idle. **A delegated sentinel**, the hybrid's checking leg, keeps investigative checking off your seat: `tap watch`, a crew or a cheap team seat. `tap goalie` adds optional judgment above the watcher.
- **Arm it on your harness.** `/tap:self loop` runs on **Claude Code only**; elsewhere use the harness's own scheduler or the scheduler-driven poll seat in `../references/supervision.md`, which also holds the `tap watch` and `done_when` recipes. With nothing armed, say the liveness floor is unmet and ask for direction; do not improvise a timer.
- **Verify it.** *Worked:* the armed state is visible (`tap watch status`, the scheduler's listing), and a watcher has fired once on purpose. A shell watcher with an unquoted URL once sat armed and unable to fire.
- **Name the stop.** Nothing here ends by itself: every loop interval fires its prompt and `/tap:self` never cancels one, and `tap watch` holds its lease until `tap watch off`. Record the stop condition and who disarms. A staffed sentinel also needs its own turn source, named in its brief: on an all-idle board it sleeps beside the run it watches. A sub-lead inherits the coverage, not the mechanism: its brief says what wakes that lane.

## What a look checks, and what it costs

Judge progress by side effects: a commit, a push, a PR head, a check run, a receipt. Silence is not a stall while a seat is visibly working; a quiet signal invites inspection and proves nothing. An empty board with runway left is a reason to look for the next work, never evidence of completion.

Wakes are cheap; working ticks are not. In one sample, wake ticks were about 0.7% of traffic, and about 97% of consumption was cache reads from ordinary work. Set cadence from the latency the run needs. A one-hour prompt cache stays warm at 30–45 minutes (about 99.5% hit, against about 4.6% past an hour); on a five-minute cache every wake re-reads the whole context, and a delegated sentinel wins. Compaction and model or effort switches empty the cache, so pair a compaction with an immediate wake.

## When it fails

- You woke and nothing was armed: say so, re-arm, and check what the gap hid.
- The mechanism is unsupported on this harness (exit 6), or a watcher never fires when tested: pick another from the recipes. Never record cover you could not arm.

## Exit evidence

A verified wake for the next interval, with its dependency, its stop condition and its disarm owner written where a successor will find them.
