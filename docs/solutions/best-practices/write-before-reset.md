---
title: "Write-before-reset — the one mechanized rail on the irreversible edge"
date: 2026-08-06
category: best-practices
module: TAP context hygiene (tap-context, lead/drive skills)
problem_type: best_practice
component: development_workflow
severity: high
applies_when:
  - "before any clear or restart of a seat — the reset discards the conversation"
  - "deciding whether a context-hygiene rule should be a mandate or advice"
  - "choosing compact versus clear for a seat at a workstream boundary"
  - "dispatching a subagent and deciding what shape its return should take"
  - "a seat is about to go idle for a known stretch"
symptoms:
  - "a cleared seat's working state existed only in the conversation and is unrecoverable"
  - "a handoff lived in session-only storage and died with the session it was meant to survive"
  - "a driver absorbed a full subagent transcript and now carries an ephemeral worker's context permanently"
  - "a reviewer seat resumed across a stream boundary and gated with stale beliefs"
tags:
  - context-hygiene
  - write-before-reset
  - handoff-artifact
  - compact-return-floor
  - irreversibility-keying
related_components:
  - documentation
  - skills
---

# Write a durable handoff before discarding a conversation

## Context

The disease this doctrine targets is **discrete boundary events invalidating cross-seat
premises**: a seat clears, restarts, forks, or compacts, and some other seat's assumption
about what it still holds quietly expires. A continuous-degradation framing ("context rot")
has no measurements behind it here, so unevidenced percentage thresholds and a reflexive
clear are refused.

What is kept is the hygiene half, stated here as doctrine under one governing rule.

## The governing rule: inform seats, mandate only irreversible edges

Context-hygiene rules come in two tiers, keyed on irreversibility — the same keying used
for confirmation gates:

- **Recoverable actions stay promptless and advisory.** A compact can be re-derived around;
  a sensor reading can be ignored; a heuristic can be bent by judgment. Advice, stated
  once, is enough.
- **The unrecoverable edge gets the rail.** A clear or restart discards the conversation.
  Nothing downstream can reconstruct what was never written. That is the one irreversible
  edge in context hygiene, and it carries the doctrine's only mandate.

The keying is what keeps the doctrine small: exactly one mechanical rule, and everything
else is information a seat weighs.

## The rail: a durable handoff artifact BEFORE the reset

**A state-discarding reset (clear, restart) requires a durable handoff artifact first.**

- **Location: the repo or the bus — never session-only storage.** A scratchpad does not
  survive the boundary event the artifact protects against; a handoff that dies with the
  session is not a handoff.
- **Contents: a bounded continuation capsule** — the standing assignment, current state,
  next actions, and pointers to primary artifacts. Bounded means pointers to the record,
  not a copy of it: TAP already carries its living state in commits, beads, PR bodies, and
  payloads, and a second maintained history becomes a stale competing truth (the consult's
  unanimous refusal of GSD's STATE-file and chained-summary items).
- **Existence is checkable, so the rail can be mechanical.** An artifact is a payload id,
  a bead comment, or a repo path — all enumerable. The reset path (`tap-context`'s decision
  ladder, `tap command clear`) is where the check belongs: presence of the artifact is a
  precondition, not a habit. This is what makes the rule a rail rather than a liturgy.

The tap-context skill already refuses a clear when the standing assignment is not
recoverable, and tells you to write it down first. This page extends that to the seat's
working state.

## The role-based reset heuristic (information, not mandate)

Which reset a seat should prefer keys on what the seat is *for*:

- **Reviewer seats clear at a stream boundary.** A resumed seat carries the previous
  stream's beliefs into the next one.
- **Driver seats compact.** The judgment accumulated in the lane is what a clear throws
  away, and rebuilding it from the record is the cost of every clear.
- **Compact before a planned idle.** A seat left idle pays to re-read its whole context
  on the next wake. A seat in the middle of useful work is left alone. Token count by
  itself is not a reason to interrupt it.

This heuristic stays advisory. A sensor can inform the choice. It does not perform the
reset.

## The compact-return floor (subagents return receipts, not transcripts)

A subagent's deliverable goes to **a file**; its return message is **receipt + key findings
+ pointer**, never the transcript.

Reading the whole file into the dispatching conversation defeats the point. Keep the
return to the path and the findings.

## The siblings (named, not absorbed)

- **A boundary notice.** One bus line when a seat compacts, clears, restarts, or forks,
  so other seats can see the event. The artifact keeps the state. The notice shows that
  the event happened.
- **A context sensor.** It reports how much context is in use and does not itself reset
  the seat. It answers whether there is room to finish the work and write the handoff.

## When to apply

Before a clear or a restart. Before a planned idle. When sending work to another
conversation, ask for a path and the findings. Judgment may change the default.
The rail may not be overridden.

## Evidence

- Write the handoff artifact before any clear or restart.
- Recoverable actions stay advisory. A clear or restart does not.
- A sensor and a boundary notice do not replace the artifact.
- `skills/tap-context/SKILL.md` already gates the narrow case. This page generalizes it.

## Related

- `../architecture-patterns/ephemeral-ladder-ask-crew-seat-driver-first.md` — the
  seat's durability is what this rail protects.
- `CONCEPTS.md` — Handoff Artifact, and Run Context Capsule when a Run exists.
