# Shape the mission

**You own the question above the build: what lifecycle does this goal deserve?** A one-line work order or a five-phase program; who drives, who reviews, and why them.

**Use when** there is no settled plan and you decide how much structure the goal gets, or the caller supplied a packet.

**Not when** a plan already names builders, reviewers and done: that is `settled-plan`, and this play is not a reason to redesign it. A supplied packet is the exception: validate it here first, then return a valid settled plan to `settled-plan` unchanged.

## Moves

- **Think first, then compare.** Sketch your own strategy for this mission before reading any recipe; prior art anchors as easily as it informs. Match ceremony to ambiguity: a bounded item with a spec starts directly, and a plan goes out before writing for new roles, new subsystems and one-way doors.
- **Write down what a successor needs:** the goal, the material approach, staffing, evidence, the decisions actually made, the plays the run will use, and what covers liveness. Use a durable strategy document only when the run will outlive its context; a one-line task needs no second planning artifact. Update it at round boundaries, as small changes.
- **Ask for your license once, as forks:** what you decide alone, what you escalate and keep moving on, what stops the run, and whether the run pivots or stops when a lane fails. Record the grants; do not infer them from tone.
- **Consult what the repository learned.** Resolve [slots.md](../slots.md) before finalizing the strategy, and record `Learnings consulted: <path> -> <constraint | sequencing choice | rejected approach>` or `none relevant to <theme>`.
- **Keep the gates when you adapt.** Record a material adaptation, including a `mode:agent` proposal where `/tap:adapt` requires one. If a conflict would weaken a required review or evidence gate, raise that decision with a concrete alternative and keep independent work moving. Spending stays bounded (`staff-the-run`). Where a boundary can be a machine instead of a sentence, prefer the machine.
- **Re-choreograph at every stage boundary.** A strategy is a proposal, not an obligation to run every stage: given what you now know, choose the next move.
- **A packet** follows `../references/packet-schema.md`: unknown root keys and unknown knobs fail loud, before anything else. The final gate is never delegated into a packet: a gate that reads only the packet inherits its assumptions. `--yolo` is accepted for compatibility and changes nothing.

## The shelf, for comparison after your own sketch

- `../references/strategies/` holds roles and how each plays. `conductor-collaboration.md` is the first; a run activates one by naming it in its strategy.
- `../references/routines/` holds steps a role runs: `general-choreography.md` (plan-document missions), `interview.md` (ambiguous preconditions), `dynamic-workflows.md` (parallel schema'd work), `debate.md`, `design-adjudication.md`, `research-pass.md`, `conformance-pass.md`, `compounding-close.md`, `convergence-loop.md`, and `shipping-pipeline.md` (the long build run, as a menu).
- Research is gated: no consumer acts on unverified research. `research-pass.md` owns the brief and the claim-level check.
- `../references/routine-authoring.md` applies when a strategy that worked should join the shelf, written from the run's record on disk and landed by review.
- `/tap:drive` and `/tap:pair` sit beside the shelf: a solo lane runs under the first, and a pair loads both.

## When it fails

- The strategy grows past the goal: cut stages until each one buys evidence you need.
- A stage's premise breaks mid-run: come back here and choose again from what you now know.

## Exit evidence

A successor can pick up the strategy, see how the owner resolved each open decision, and find the first work order you sent.
