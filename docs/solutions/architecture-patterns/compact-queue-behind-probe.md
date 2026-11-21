---
title: A post-compaction wake waits for proof, not for a quiet pane
date: 2026-07-26
updated: 2026-09-26
category: docs/solutions/architecture-patterns
module: runtime/bun/src/self-compact.ts
problem_type: architecture
component: compaction_lifecycle
severity: high
tags:
  - compaction
  - probe-not-mock
applies_when:
  - "Changing how an explicit compact submits or wakes"
  - "A harness update may change whether a queued line survives compaction"
  - "A test is about to claim that a ping survives a compaction"
---

# A post-compaction wake waits for proof, not for a quiet pane

An explicit `/compact` consumes the turn that submitted it. With nothing
inbound, nothing starts the next turn, and the session stops without an error.
A compaction the harness starts because context filled is different: in the one
observed case, Claude Code with a turn in flight, it resumed on its own. The
between-turns case has not been observed. Filling a session until that happens
does not test the explicit path.

## Two rails, so order is not arrival

In Claude Code, a queued plain message is handed over at a tool-call boundary. A queued slash
command waits until the turn ends. Submitted in the same turn, they are not
two items in one queue. If the turn keeps making tool calls, the plain message
can be answered before `/compact` runs, in the context the wake was meant to
follow. A probe on an idle pane, with no tool call after the inject, never
sees that. The arm that matches production is a turn that keeps calling tools,
and the compaction marker has to appear before the answer.

## What the worker waits for

`runtime/bun/src/self-compact.ts` runs one detached worker. The resume is
withheld until a fresh compaction record exists. Missing, late, or unreadable
proof sends nothing, and the handoff stays for a manual resume.

Waiting for the pane to look idle and then injecting is a different check.
Compaction can look idle for a moment, and a ping sent then is consumed.
A second poller that shares the window before submit can inject ahead of the
staged command and replace it.

## What a test may claim

`skills/self/scripts/regress/compact-wake.test.sh` may claim that the
worker is armed, that the handoff exists before any pane input, and that a
failed arm is loud. It may not claim that the ping survives a compaction. A
stand-in that asserts survival is replaying an assumption about the harness.
Survival is a live check on a disposable pane, outside the repo, and it has
to be run again after a harness update. Acceptance of the send does not prove
the seat read it.

## Re-running the probe

Use a disposable pane only, never a live seat. Keep its working directory
outside any enrolled checkout, so a session-start hook cannot register the
throwaway.

After the context holds real work, send the compact command and then a one-line
reply request, with no wait between them.

Keep calling tools during that turn, and send both lines while it is still doing so.

The compaction marker has to appear before the answer.

Before trusting a pass, look for Claude's queued-input line, "Press up to
edit queued messages", and for Codex's "• Context compacted" line.

Claude still needs the tool-calling turn. Codex, when compaction is very short, only shows order.

Do not submit an empty handoff file. A missing file fails in the open. An
empty file would remain and say no work was in flight.
