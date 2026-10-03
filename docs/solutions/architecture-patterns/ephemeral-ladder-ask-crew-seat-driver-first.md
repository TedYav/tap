---
title: "The ephemeral ladder — ask, crew, seat — taught driver-first"
date: 2026-08-06
category: architecture-patterns
module: TAP staffing / skills (drive, using-tap, lead)
problem_type: architecture_pattern
component: development_workflow
severity: medium
applies_when:
  - "a driver mid-lane wants a one-off opinion or short consult from another model family"
  - "choosing among a stateless one-shot question, an ephemeral conversational pane, and a durable restartable seat"
  - "deciding which skill surface teaches which part of the staffing story"
  - "writing help text or doctrine for an ephemeral-invocation command"
symptoms:
  - "a driver escalates a thirty-second question through the leader, or goes without a second lens entirely"
  - "crew and ask are documented only in leader-side staffing prose that drivers never load"
  - "a command's help text re-teaches the whole staffing doctrine instead of its own contract"
tags:
  - staffing
  - ephemeral-agents
  - driver-first
  - ask-crew-seat
  - doctrine-placement
  - tap-rjdi
  - staffing
related_components:
  - documentation
  - skills
---

# Ask, crew, and seat: which rung to reach for

## Context

TAP staffs ephemeral help in graduated forms. `skills/using-tap/SKILL.md` names the four
staffed forms (subagent, burst engine, crew, launcher-managed seat). The **ask** is a
fifth, lighter one: a stateless one-shot cross-harness invocation (`tap ask`).
Graduated forms need a teaching that says which rung to reach for, and who reaches.

Teach the ladder **driver-first**. Drivers are the likeliest users of asks and crews.
The leader coordinates durable teammates and may use every rung. A driver who wants a
second lens mid-lane reaches for ask or crew directly.

This doc is the doctrine: the rungs, the selection rule, the role mapping, and where each
part is taught. It owns **when** each rung applies; `tap ask --help` owns **how** to invoke
the bottom rung (the seam is stated below).

## The rungs

| Rung | Shape | Identity and lifecycle | Reach for it when |
| --- | --- | --- | --- |
| **ASK** | Stateless one-shot invocation, any harness | No registration, no bus address, no lifecycle; each invocation starts fresh | One bounded question whose answer closes the matter |
| **CREW** | Stateful ephemeral pane in the caller's tmux session | Full bus identity — sends, receives, settles; its working life ends with that pane | The matter needs follow-up: conversation, judgment, review, consult |
| **SEAT** | Launcher-managed teammate | Stable handle across restarts; durable, restartable address; continuity truth is a durable on-disk handoff, not conversation memory | The matter is a lane, needs a restartable address, or needs operator attention |

Subagents and burst engines are the same-harness sibling axis, not rungs: they answer with
the spawning seat's own model inside its own harness. The ladder is about reaching *other*
models and seats with graduated commitment.

## The selection rule

**Reach for the lowest rung that answers the need.** The escalation tests are mechanical:

- **A follow-up question outgrows ask.** If the answer opens a conversation, the question
  was crew-shaped. Escalating is cheap and reads as the rule working, not as an ask failing.
- **A lane or a restartable address outgrows crew.** If the work must survive a pane, hold a
  writer token, or stay addressable across restarts, it was seat-shaped.
- Cost asymmetry backs the rule: an ask that turns out insufficient costs one cheap call;
  a seat staffed for a question an ask would have closed costs a launch, a registration, and
  a lifecycle.

## The role mapping (the point of the doctrine)

**Drivers are the primary users of ask and crew** — one-off heterogeneous opinions and short
consults mid-lane, without escalating through the leader. The driver's judgment stays in the
lane; what it borrows is a second lens.

**The leader primarily coordinates durable teammates**, and may also use crews and asks as
needed. Nothing here removes the leader's staffing authority over seats; what changes is
that the lower two rungs are taught where drivers will find them.

The canonical sentence for every surface that carries this mapping:

> Drivers are the primary users of ask and crew — one-off heterogeneous opinions and short
> consults mid-lane, without escalating through the leader; the leader primarily coordinates
> durable teammates and may use all rungs.

## The honest constraint

Harness CLIs are stateless by design here: an ask cannot continue a conversation.
Conversation is the crew rung's job. That is deliberate, not a gap on a roadmap — a
stateful ask would be a crew wearing a lighter name, and the ladder's value is that the
rungs do not blur. Any doc or help text that apologizes for ask's statelessness should be
rewritten to point up a rung instead.

## The seam with `tap ask`

The command's help owns the executable contract. This doc owns the why:

- **The command's help owns the executable contract:** grammar, harness names, flags,
  timeout and default behavior, the output/exit contract, absent-CLI refusal, and the
  guarantee:
  *"Stateless: each invocation starts fresh; no TAP registration, bus, pane, or lifecycle
  state is created."* — plus **one** test-shaped escalation sentence, final form:
  *"If the work needs a follow-up conversation, use tap crew add; if it needs a durable
  restartable address, use tap session launch."*
- **The doctrine owns the why and the placement** (this doc, and the surfaces named below):
  rung selection, the role mapping, the honest constraint.
- Help does not duplicate the ladder, and carries no doc-path pointers — paths in help text
  rot; the escalation sentence naming `tap crew add` and `tap session launch` is the
  actionable pointer. The doctrine cites the command; the command stays self-contained.

## Placement — which surface teaches what

The skill-surface edits are follow-on implementation, not this doc
(`/drive`, `/using-tap`, `/lead`, and `AGENTS.md`):

- **`/drive` gets the primary how-and-when text** — the rungs, the selection rule, the
  escalation tests. The driver is the audience; this is the inversion the doctrine exists
  to make.
- **`/using-tap` gets the floor mechanics** — visibility (every form stays operator-visible),
  identity (what a crew is and is not), dismissal.
- **`/lead`'s staffing section gains the role-mapping sentence and points down** — one
  sentence, then defer to `/drive` for the teaching.
- **`AGENTS.md`'s staffing paragraph gains one line** — the same mapping, compressed.
- **`CONCEPTS.md` carries the vocabulary** — *Ask* and *Ephemeral Ladder* entries, added
  alongside this doc.

## When to apply

- Mid-lane, before escalating a bounded question to the leader: ask first.
- Before staffing a crew for something one answer would close: ask first.
- Before launching a seat for work that ends with the conversation: crew instead.
- When writing or reviewing help text for an ephemeral-invocation command: keep the
  contract in the help, the doctrine in the docs, one escalation sentence between them.

## When not to apply

- A lane, a writer token, or a restartable address is the seat rung.
- Crews are never parallel writers. The ladder does not soften that floor.

## Evidence

- The doctrine: drivers are the primary users of ask and crew; the leader coordinates
  durable teammates and may use every rung.
- `tap ask` is the stateless one-shot cross-harness invocation, the bottom rung.
- The seam: help owns the executable contract and one escalation sentence; this doc owns
  why and where it is taught.
- The placement being corrected: leader-side staffing text named every form, while the
  driver surface named only burst engines.

## Related

- `CONCEPTS.md` — *Crew*, *Seat*, *Burst Engine*, *LEADER / DRIVER / EXECUTOR*, and the new
  *Ask* / *Ephemeral Ladder* entries.
- `skills/using-tap/SKILL.md` — the staffing floor (forms, visibility, what a crew may
  never do).
- `skills/lead/references/routines/dynamic-workflows.md` — burst engines, the same-harness
  sibling axis.
- `../best-practices/write-before-reset.md` — write the handoff before a clear or restart.
  A seat's durability promise is why the seat rung is the top one.
