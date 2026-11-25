# Run a settled plan with a team

**You own the plan's momentum, not its design.** The plan already names who builds, who reviews and what done means; you keep it moving until that is true.

**Use when** you are at a tick on such a plan, handing a landing or another mechanical loop to a cheaper seat, or a caller named this play.

**Not when** staffing or the gate is still open (`staff-the-run`, `shape-the-mission`), or the plan's premise has broken: stop applying the plan to that work and return the decision to its owner (`recover`). This play never reopens staffing or the gate.

## Kickoff

- One tracked work order per unit: its goal, its slice of the plan by path, its reviewer, the evidence that proves it done, and what to send back. If you cannot name the evidence, the unit is not scoped yet. *Worked:* `tap outstanding` shows each order read.
- Write the tick below into a file you name in your wake prompt (the plan's choreography may say where), so a compacted or replacement lead resumes from it. *Worked:* the file exists and the wake prompt names it.
- If the run may outlive your context, `../references/routines/shipping-pipeline.md` § Durable run-state applies: one state file, intent written before each outside effect, resume from state.

## The tick

In order, on every wake and whenever a reply lands. About 25 minutes between wakes is a workable start while seats work.

1. `tap poll`, and settle what each payload asks.
2. For each handoff the run now depends on, check recipient or work evidence. If processing is unconfirmed, inspect its dependency, delivery and pane before choosing a recovery.
3. For each lane, find what changed since the last tick: a commit, a push, a PR head, a check run, a receipt. A seat's prose is a claim to check against those.
4. For each waiting seat, ask whether the thing it waits on has already happened. Look at the job, the check or the review yourself and tell the seat. A seat can wait for hours on a job that passed.
5. A lane with no side effects and no working state is not yet stuck: inspect its dependency and delivery. Once it is stuck, `recover` in this same tick.
6. A seat that owns its queue claims its next ready item when it finishes one. Give an idle seat work only when that work is unowned or its owner has handed it over.
7. A decision only the plan's owner can make is escalated once, with a recommendation; the rest keeps moving.
8. Re-arm your wake only while work is in flight.

## Handing a landing to a cheaper seat

The order names the repository's entry skill for the whole landing, the one a person would invoke, and not a tool inside its chain. It quotes the owner's grant and its limit, states the stop rule (on a refusal: stop, write nothing unasked, report), and says what to send back. It adds nothing else: a sentence that retypes a step or predicts what a tool will do is where orders lose steps. This play grants nothing; without the owner's grant the seat prepares and stops.

## When it fails

- A unit comes back without the evidence its order named: ask once, then record the gap. A gap is not a pass.
- A landing is refused: read the refusal against the order. A missing preparation step means the order named an inner tool.
- A premise of the plan is false: `recover`.

## Exit evidence

The result is verified against the plan's named artifact, evidence and gate owner, by a non-author where independence is required; for an authorized landing, the head and the forge's state are confirmed. Report what was delivered against the plan, then go to `close-the-run`.
