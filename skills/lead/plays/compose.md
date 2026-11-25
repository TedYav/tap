# Compose choreography for a caller (`mode:agent`)

**You own a block of text another skill will paste into its plan, and nothing else.**

**Use when** a skill writing a plan called `/tap:lead mode:agent <plan-path>`. The call is valid from a subagent; the core's subagent stop does not apply to it.

**Not when** you hold the baton for a live run: that is the core and the other plays. This call takes no role and launches, sends, schedules and arms nothing. It asks the user nothing; the caller's own plan review is the owner's veto point.

## Moves

- **Read the plan at the given path** and take what it settled as given: staffing, reviewers, the gate, limits and holds. Do not redesign them. *Worked:* each settled item appears unchanged in your answer, or not at all.
- **Return a conflict; do not adopt it.** If a settled choice breaks a rule the plan does not own (the author named as its own independent gate, a metered seat building without the owner's clearance), keep the rest, leave that decision open, and return the conflict as a question for the caller's review. If a fact needed to check a governing rule is missing (for example whether a named builder is metered or cleared), return that question to the caller; do not assume. Use either one-line answer below only after every such question and conflict is resolved.
- **Decide whether a team is needed.** One builder with one reviewer needs none: answer "no team needed". More seats than that, reviewers included, is a team. If the plan's choreography is already complete, answer "existing choreography covers execution". Both are complete answers.
- **Fill only what is open,** under four labels the caller can check and a lead can find. Keep all four; under a label the plan already settled, quote what it settled.
  - **Plays:** the plays the build will use, by name, starting with `settled-plan`.
  - **Liveness:** what covers the quiet intervals and who stops it. This is a proposal that the executing lead verifies on its own harness; if the harness is unknown, give the choice for each. The core's liveness paragraph is enough to write it; open `cover-liveness` only when the shape is not obvious.
  - **Lead decides alone:** what the lead may decide without the owner, and whether the run pivots or stops when a lane fails.
  - **Close:** the conditions under which the run ends, and what is released.
- **Add staffing or gate ownership only if the plan left them open,** using `staff-the-run`. Keep a named gate, including a split review, when it satisfies the governing review rules. If those rules require one reader of the whole result and the plan provides only scoped reviewers, keep their assignments and return the missing whole-result review as a question for the caller. A supplied packet is `shape-the-mission`.
- **Return an owner-only decision as a question** for the caller's review: spending, `main`, a one-way door. Do not decide it.

## When it fails

- The plan and this skill differ on an ordinary choice: the plan's stands. Say where they differ. A conflict with an independent gate or a spending limit is returned, never adopted.
- You cannot tell what the plan settled: name the unclear item and return the rest.

## Exit evidence

One block under the four labels, or one of the two complete answers, and no change anywhere.
