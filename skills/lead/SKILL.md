---
name: lead
role: choreographer
description: "When leading a team of agents over TAP: keep a settled plan moving, staff or delegate work, or design a run's strategy."
argument-hint: '[mode:agent] [plan-path]'
allowed-tools: 'Bash, Read, Grep, Glob, Edit, Write'
---

# /tap:lead — leading a team

Start here; open a play only when its situation is yours.

**Do you need a team?** One agent with one reviewer needs none of this: use `/tap:pair`. A new seat must earn its handoff cost in capacity, independence or judgment.

**Consulting is not leading.** Reading this for reference, or a `mode:agent` call, takes no role. For a live run you lead, check `tap team` for who already leads, take the `leader` role (`tap role <your-handle> leader`) and return it at close. The same work needs one leader.

## What you hold

The objective, the brief, who drives what, disputes drivers cannot settle, and an independent final gate: someone who wrote none of the result reads all of it against contracts, code and the plan's done conditions, never against the plan's assumptions or a packet. If you wrote a hunk, that is not you. A gate the plan names stands. Drivers settle shared seams with each other and report the result; every seat has voice.

The owner decides and gets your own read of the evidence, including where it diverges: one recommendation, its counter-case, what would flip it. After a ruling, execute fully. A question a probe can answer is yours: run it.

**What does not flex:** other people's money and rules, `main`, the spending envelope, and honest evidence. When one blocks the better path, tell the owner the constraint, what it blocks, the cost of complying and your recommendation, and keep working.

## Keep it moving

A down, wedged or self-pacing seat never parks the work: nudge, split its lane, substitute or reassign. Hand out work as tracked orders (`tap assign <seat> -f <path>`) with the whole scope.

A TAP send, reply, or settlement is never by itself a conductor-loop boundary: advance whatever does not depend on the answer.

**Before you yield with seats or outside jobs still active,** confirm an effective wake covers the next quiet interval, and name who stops it. The default is push primary, a cheap delegated sentinel carrying the investigative checking, and one infrequent leader wake as the backstop for delivery itself failing. With a few seats and a warm cache, your own scheduled wake can be all of it. `/tap:self loop` is Claude Code only; on another harness, if no effective wake is currently verified, open `cover-liveness` to choose or arm one.

**At close,** account for what this run owns and hand back what it borrowed: finish or hand over unfinished work and custody; keep wake coverage while any return still needs supervision; once outstanding obligations are settled or have an accountable owner with coverage, disarm the run's wakes, release its seats, then reclaim eligible worktrees.

**`mode:agent`:** a skill writing a plan calls this to compose its choreography. The call only reads and returns text: no role, launch, send or armed wake, and no question to the user. Open `compose`.

<SUBAGENT-STOP>Not a `mode:agent` call, and dispatched as a subagent or executing a work order that gives you no workstream to lead? This skill is not for you: take no leader role; do the task.</SUBAGENT-STOP>

## Plays

Each is `plays/<name>.md`.

- **`settled-plan`**: the plan names builders, reviewers and done; you are at a tick, handing a landing to a cheaper seat, or a caller named it.
- **`cover-liveness`**: you need to establish, verify or repair coverage for the next quiet interval.
- **`recover`**: a dependency was missed, a send never became a turn, a seat went silent, or a premise broke.
- **`staff-the-run`**: ownership is open, a layer or retry needs a fresh seat, a second stream needs a sub-lead, or spend or a shared tree needs checking.
- **`close-the-run`**: the run is ending and seats, wakes, obligations or worktrees remain.
- **`shape-the-mission`**: there is no settled plan, or the caller supplied a packet.
- **`compose`**: you were called in `mode:agent`.

Owned elsewhere:

- Routine status exceeds your attention: `references/strategies/conductor-collaboration.md` (your side); the conductor loads `/tap:conduct`.
- A contested choice: `/tap:discuss`. Review over moving code: `/tap:choreography`. A short review seat: `/tap:crew`; one question: `/tap:ask`.
- Your context runs short or the baton passes: `/tap:context`, `/tap:self`. Carry obligations, the owner's words and holds, the next decision, and what is armed.
