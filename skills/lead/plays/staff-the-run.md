# Staff the run

**You own who does each piece of work, and the price of every handoff you create.**

**Use when** ownership is open, a layer or retry needs a fresh seat, or a second stream needs its own sub-lead. Also when a metered seat or two writers in one tree are in play.

**Not when** the plan already names the seat and it is alive: send the order. Lane custody once a seat is driving is `/tap:drive`.

## Before you fan out

Answer four lines in the brief or strategy, or mark one `n/a: <reason>`:

- **Blocking first steps:** what must finish before anything parallel starts.
- **Independent workstreams:** disjoint files, services or layers; each becomes a lane.
- **Shared mutable state:** split the target before serializing on it; serialize only for a named invariant.
- **Smallest safe decomposition:** fewer lanes than you could run. If one seat is best, say why.

For many near-identical cheap units, take one through brief, build, review and delivery before starting the rest: a flaw in the brief then costs one lane.

## Pick the form

| Form | Use | Boundary |
|---|---|---|
| Subagent | Read-only fan-out or isolated scratch inside your own turn. | No TAP identity; returns an artifact its lane owner lands. |
| Crew | A consult or review that may need follow-up. | Read-only, in your tmux session; never a parallel writer. |
| Team seat | A lane held across waves. | Its own branch, worktree and writer token; its handoff on disk is its continuity. |
| Burst engine | Parallel schema'd work inside one lane. | `../references/routines/dynamic-workflows.md`; never holds a writer token. |

Route each lane to the cheapest live seat that can do it, and keep judgment for yourself. Every agent stands where the operator can find it. `../references/staffing.md` has the six axes, model pins, and the delegation, writer-token and spending rules in full.

## Moves

- **A fresh seat for a new unit, layer or retry,** carrying consolidated scope: the original brief, every directive since, and the prior seat's report and branch. A chain of follow-ups silently drops directives. State that is costly to move (uncommitted changes, a running process, a review mid-read) favours keeping the seat. A role outlives its seat. *Worked:* the order is read and the first side effect appears.
- **A sub-lead for a second stream.** Launch it as a full seat so it can crew its own reviewers; a crew cannot create crews. Its charter names the mission, what it decides alone, what returns to you, and what wakes its lane. It takes the `leader` role for its own stream after checking who already leads, and it sends rollups, not raw reports.
- **A metered seat** reviews or consults. Building on one needs the owner's clearance in a checkable shape: an instruction naming the seat and the build, a named assignment in the brief, or a standing instruction in the repository. It is never the seat's inference or your promotion: a build loop can exhaust a balance mid-lane and strand work nobody else holds.
- **Paid reviews** go through you, inside the envelope the owner set at kickoff; seats never launch their own. Stagger rate-limited bots.
- **Two writers in one tree.** Prefer separate worktrees. Unrelated scopes may share a tree at your judgment, for the price of watching for collisions; keep the checkout still while a check reads it. When scopes or tree-wide operations can interfere, serialize with one writer token passed explicitly: generated files cross path boundaries silently, and a concurrent commit poisons evidence read from the whole tree. `/tap:drive` owns the custody moves.

## When it fails

- Unexplained diffs in files you did not touch, or a result you cannot attribute: suspect two writers and split into worktrees.
- A seat exhausts its balance mid-lane: reassign with consolidated scope. The queue it held is still owed.
- No cheap seat exists: ask the owner to staff one and name the saving, at planning time.

## Exit evidence

Every unit has one accountable seat, a return condition, and something that will notice if the return never arrives.
