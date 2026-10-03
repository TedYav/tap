---
name: choreography
description: "When arranging parallel TAP reviews, edits, or supervision, coordinate readers and writers without clobbering work."
allowed-tools: 'Bash, Read, Grep, Glob'
---

# Choreography — coordinate evidence and wakes

TAP distributes a team's existing methods across seats. This skill governs how
they coordinate; the repository owns what a review or gate must prove. Follow
`/tap` for all-seat behavior and `/tap:lead` for supervision ownership.

## Give reviewers an exact, retrievable artifact

Mutation is the risk, not reviewer count. Five readers of a fixed artifact can
be safer than two readers of a changing checkout. Before requesting a citable
review, read [review isolation](references/review-isolation.md) and name:

- The exact source identity the verdict will cite.
- How that identity remains retrievable: a reachable commit/ref or preserved
  bytes. A bare SHA can be pruned; a PR number moves with its head.
- The isolated view: committed source, PR at the named head, private copy or
  temporary review worktree. The view may be disposable; the identity must last.
- Whether the author may keep writing elsewhere or on top of the pinned commit.

For example: “Review `abc1234`; I may keep committing on top; cite that SHA.”
Retain the named source. A private copy avoids reader/writer collisions; a
worktree does not isolate shared caches, ports, services or machine load.

For an informal look, label the view non-citable and use the cheapest useful
surface. For a verdict meant to be cited, a reviewer missing an exact artifact
asks for it rather than reviewing a moving tree. A pinned source frees the
author to continue independent work.

Re-coordinate when readers see changing bytes, tests couple through shared
tooling, or a verdict cannot identify its source. Preserve the evidence and
resolve the coordination problem; do not silently work around it.

## Add a watcher only for a coverage gap

Before arming or delegating a watcher, read [watchers and wakes](references/watchers.md).
The working repository's `AGENTS.md` owns local staffing and shutdown
policy. Existing healthy TAP push delivery does not need a second polling agent.
Its failure states may need coverage.

A watcher must satisfy both conditions:

1. It covers a failure or dependency that the existing wake path does not
   guarantee: queued/unavailable delivery, stalled external work, CI or another
   concrete gap. Check existing coverage before adding it.
2. It has a named termination condition and an owner who disarms it. Arming
   `tap watch` creates an armer-owned lease; it does not supply that lifetime
   automatically. An evaluator of `none` and exhausted escalation rungs do not
   prove completion or disarm the watcher.

`tap watch` is the team liveness sidecar (`tap watch status` reports its state).
`tap goalie` is the opt-in belief-state sidecar and can be a rung in watch's
escalation chain. They compose; two copies of the same sidecar for one team are
the redundancy to question. Neither detects every logical deadlock.

Prefer investigative monitoring on a cheap seat or pane-less infrastructure,
not the leader's expensive context. Report real events with `--ask` when an
answer is owed or `--wake` when the seat must settle a note. Both ride the
recipient's delivery window; only `--delivery interrupt` bypasses it. A plain
note can be pre-settled and batched, so it is unsuitable when the recipient
must act on that wake. `tap escalate` reaches the operator outside the bus
when the courier or target pane is wedged.

Repeated notifications that nobody acts on are a reason to revisit coverage.
Waiting loops also spend context without progress. Keep actual work obligations
tracked so the run cannot appear finished while its work has disappeared.
