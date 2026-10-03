---
name: adapt
description: "When combining skills, adapting one to TAP seats, or using mode:agent, recompose it and emit the proposal as the audit record."
argument-hint: '[mode:agent] [--creative] <goal>; skills: <skill menu>  |  modernize <skill-path>'
---

# Adapt — the license to recompose

`/tap:adapt` is the **license** for the calling agent to recompose another skill — cut, reorder, reroute — not a ceremony for obtaining a go. It turns a goal plus a menu of skills into **one run-plan proposal**: the composed steps, the cuts, the invariants preserved, the executor routing. Per-run verbal overrides ("run finalize-plan, but skip the goal print and route the browser step to a subagent") become a written, reviewable record instead of an invisible in-the-moment decision.

**When you don't need this skill.** Tuning that stays inside a skill's own license — exercising a `[SHOULD]`/`[BONUS]` judgment point, picking among options a skill already offers, adapting a technique whose failure you can name and recover — is just running the skill well; no proposal owed. `/tap:adapt` earns its keep at *material* recomposition: combining skills, cutting steps, rerouting executors, choreographing a subagent or linear skill across TAP seats.

## Who decides

**Default (interactive).** Adaptation is proposed, never silent. `[SHOULD]`/`[BONUS]` cuts are licensed: name the tag and the failure the cut accepts, and the run's single go ratifies them. MUST and untagged steps can bend too, but only the owner bends them: the proposal raises each as an explicit question, a blanket go never covers one, and an unanswered question keeps the step. Present the proposal and stop. Execution starts on the explicit go. Starting the run from an `/tap:adapt` turn is this mode's primary failure.

**`mode:agent`** — the calling agent holds the decision, and in this mode it makes every cut itself **including the source skill's MUST steps**. Otherwise `mode:agent` is useless: a MUST written by a skill author for a literal harness is a technique, not a law. The license covers those techniques; it does not cover the author recording *someone else's* requirement. A source-skill requirement for a named human's assent, or for a gate or evidence contract owed to someone outside the lane, is an authority boundary and not a cuttable technique, regardless of being written as a MUST. The proposal is still **emitted** — to the lane ledger, the PR body, or the strategy round log — as the audit record a reviewer can read, never as a prompt. Do not present it and wait.

**The one remaining stop:** an authority boundary — a constraint owned by repo policy, a named human, or an external system. The examples (repo rules, money, `main`'s protection) illustrate; they do not exhaust. Name that owner or source in the proposal. Unknown ownership defaults to preserve-and-escalate. An authority boundary no skill author licensed and no agent may waive. That escalates, and the agent keeps working what does not depend on it.

Under a standing trust grant (`--yolo`-class "I trust you, go ahead") the interactive once-over converts to surface-and-proceed: emit the proposal as the audit record and start. That grant does not waive a human authority boundary.

## The proposal

Load every named skill in full, then emit:

1. **The composed run-plan** — the ordered steps that will actually run, each with its origin skill.
2. **Cuts** — two classes. *Licensed cuts* cite a `[SHOULD]`/`[BONUS]` tag and name the failure they accept. *Questioned cuts* target MUST/untagged steps. In interactive mode each questioned cut needs the owner's named answer. In `mode:agent` the calling agent decides them, including MUST, and records the cut in this list so a reviewer can still veto after the fact.
3. **Invariants preserved verbatim** — every MUST/untagged step the proposal does not cut, quoted rather than paraphrased.
4. **Executor routing** — who runs each step, at the cheapest viable tier per lane; frontier intelligence stays on the judgment gates. See `/tap:drive` for the economics.

Keep it to one artifact: the value is a proposal a reviewer can veto by name, not a wall of reasoning.

## Route subagents to seats

When adapting subagent roles to a TAP team, read [Subagents to TAP seats](references/subagents-to-tap-seats.md) for the mapping, shared-state boundaries and worked SDD/ce-work examples. Human invocation: “adapt /<skill> for TAP: run its subagents as seats”.

## Modernize mode (`modernize <skill-path>`)

The same license pointed at a skill artifact instead of a run: take a skill written for an older, more literal harness — step choreography, defensive repetition, sub-decisions prescribed that a frontier driver makes better in the moment — and propose its frontier-native rewrite: tools + prior art + license, a menu rather than a recipe. Sort every instruction into three registers before cutting anything:

- **Techniques** — adaptable prior art. Compress freely into intent + failure signature + recovery move; the rewrite trusts the driver to improvise the middle.
- **Evidence contracts** — verbatim result lines, independently executed gates, red citations. Rewrite the prose, never the obligation — proposing to drop the obligation itself is a questioned cut in interactive mode, and a recorded cut in `mode:agent`.
- **Authority boundaries** — a constraint owned by repo policy, a named human, or an external system, riding inside the skill. Name the owner or source in the proposal; unknown ownership defaults to preserve-and-escalate. A source-skill requirement for a named human's assent, or for a gate or evidence contract owed to someone outside the lane, is this register — not a cuttable technique — regardless of being written as a MUST. Whose requirement the MUST records, not how it is tagged, is the test. Carried through verbatim; changing one is a conversation with its owner, not an edit. This register is the human stop even under `mode:agent`. The `mode:agent` license still covers techniques the skill author wrote for a literal harness.

The trap this mode exists to guard: a literal-harness step that reads as pedantry but is actually a fence around a real incident. When you cannot name the failure a step prevents, ask or keep it — never cut on style alone. The deliverable is the proposed rewrite plus a cut list in the same two-class shape; in interactive mode the original stays untouched until the go; in `mode:agent` the calling agent applies the rewrite and emits the proposal as the audit record.

## Creative mode (`--creative`)

Licenses experiments found in no base skill — novel compositions, new collaboration shapes (a tournament of two peers, a self-review loop) — each flagged as an experiment in the run-plan, so the reviewer sees which parts are proven machinery and which are a bet. Additive by default: an experiment that would remove an evidence contract, or reorder a MUST gate across the boundary it guards (a verify moved after the push it exists to gate is waived in effect without being "removed"), is a MUST-tier cut — raise it as a questioned cut in interactive mode, record it in `mode:agent`; it never rides the experiment flag alone. `/glhf` and TAP both began as exactly this kind of flagged experiment; the mode exists so the next one can too.
