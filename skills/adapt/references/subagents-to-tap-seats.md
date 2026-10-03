# Run a skill’s subagents as TAP seats

Human invocation:

> adapt /<skill> for TAP: run its subagents as seats

Use this mapping when a skill delegates to subagents but the work should run
through an addressable TAP team. Read the source skill in full. Apply
[the decision rules](../SKILL.md#who-decides), then emit the composed plan,
cuts, preserved invariants and executor routing before execution. The mapping
changes who performs the work; it does not waive a human decision or an
external review or evidence requirement.

| Source skill expects | TAP mapping |
|---|---|
| A subagent role | A named seat with that role, inputs and expected result |
| An ephemeral read-only reviewer or consultant | A crew seat in the operator’s current tmux session |
| An implementer or long-lived worker | A launcher-managed seat with a durable handoff |
| Shared progress or result state | The lane ledger, with links to returned artifacts |
| Parallel results collected by a controller | A barrier followed by one synthesizer seat |

Reuse suitable existing seats. An ephemeral writer still needs driver custody
or an isolated scratch subagent that returns an artifact; a crew is not a writer.
Name the work directory, shared resources, completion evidence and handoff in
each assignment. A sent request or courier receipt is not the returned result.

For a research fan-out, assign one bounded question to each read-only crew,
collect their sources and findings, and have the synthesizer reconcile them.
Preserve the source skill’s verification requirements. For writes, settle
shared-state custody before fan-out as described below.

## Worked examples — choreographing a skill across TAP seats

A skill whose examples contradict its rules teaches the examples. Read the safeguards above — emission of the audit record, whose-MUST precedence, shared-state before writer fan-out, writer custody — before adding another picture.

These are the IKEA picture. Each is a short before → after. Each after-plan — its cuts, preserved invariants, and routing — is emitted to the lane ledger, the PR body, or the strategy round log. Copying the table is not the operation; emitting that record is.

### `/tap:adapt /subagent-driven-development <plan>`

| SDD step | TAP seat |
|---|---|
| implementer subagent per task | the lane's driver |
| task-reviewer subagent | the partner at the pairing dial |
| final whole-branch review | the standing gate seat |
| `progress.md` | the lane ledger |

The driver executes the provided plan; `/tap:pair` is the collaboration mechanism; the repo ladder is the whole-diff gate. Do not spawn SDD's fresh subagents inside a TAP lane that already has those seats.

### `/tap:adapt /ce-work <plan>`

| ce-work step | TAP seat |
|---|---|
| engine selection and the cross-model controller | the TAP lane itself |
| the parallel-safety check | the leader's lane split |
| the `ce-code-review` completion receipt | the repo's review ladder |
| the shipping tail | `/tap:drive` closeout |

ce-work is a conductor compiled to text. TAP already has a live leader and conductor; steal the per-unit evidence fields, not the worker controller.

### A linear loop or burst skill → N seats

Before fanning writers out, check shared state. Calling units "independent" is not a glob of disjoint files: generated artifacts, the index, shared fixtures, and tree-global git state cross-cut any path claim, and a semantic collision between disjoint files is reported CLEAN. If overlap cannot be shown safe, isolate worktrees or serialize. The sanctioned primitive is a **Named-Resource Lease** (`CONCEPTS.md`), negotiated explicitly with its owner through TAP — decide deliberately and say so; a lane idling for exclusivity it does not need is a real cost.

Then fan each write-bearing unit to a launcher-managed driver lane, or to a subagent whose scratch write returns an artifact to the owning lane. Crews are for read-only and judgment work, not writer custody. Hold a **barrier** until every unit returns. One synthesizer seat merges the results — the same shape `/tap:lead`'s panels already use. The source skill's "loop in one context" is the thing being cut; the barrier-plus-synthesizer is the replacement.
