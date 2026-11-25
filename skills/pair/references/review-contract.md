# The review contract

Adapted from obra/superpowers `subagent-driven-development` (MIT): the reviewer template, the
re-review template, and the driver-side rules that keep a review worth asking for. In a pairing, the
reviewing seat holds the reviewer side of this contract: the partner by default, or the driver when
the driver reviews and its partner builds.

**Where this file lives.** Run `tap help skill pair` and open
`references/review-contract.md` next to the returned canonical SKILL.md. This
works for clone and archive installs on every host. Native-plugin and flat-host
discovery wrappers resolve that canonical file; their own directories do not
carry these references. In the source checkout, this file is
`skills/pair/references/review-contract.md`.

After a merge that changes this file, clone installs refresh through
`./install.sh --sync` from the primary checkout. Archive installs upgrade through
the release bootstrap. Editing harness discovery directories by hand is not an update.

## What the reviewer is handed

The brief, the review package, and the report: as paths when the reviewer shares your checkout, as
content when it is a TAP seat in its own. Not your framing of the diff, and not your
summary of what you think it does — summarising the change *to* a reviewer is the easiest way to get
back the review you already wrote.

Name the range in refs that outlive your worktree: unit number, BASE and HEAD as commit SHAs, and
whether this is a review or a re-review. A path into one seat's checkout is not durable across two
worktrees or a rebase, and a reviewer who cannot re-derive the range cannot re-check its own verdict.

**The package is the entry point, not a prison.** Its context lines carry most of what a review needs,
and crawling the repo by default spends a reviewer's context on orientation instead of judgement. But
a claim that crosses the diff — an unchanged consumer, a function only half shown, a caller whose
behavior this change quietly altered — is judged by reading the code, not by declining to. Read what
the claim needs, and say in the report what you opened and why. In the live run this contract is
reconstructed from, several real defects required unchanged-consumer traces that no amount of diff
context would have supplied.

**Recompute load-bearing claims and inspect the CI receipt.** Derive counts, denominators and hashes; read cited sources and run focused controls when they resolve a real uncertainty. AGENTS.md defines the exact-head CI full and differential PASS; no local full is owed. A hard-to-read receipt needs inspection, while a report with no command or output has supplied no evidence.

## The verdict

Two verdicts, both required; a report missing either is not a review. A builder's self-review never
replaces it.

```
### Spec Compliance
✅ / ❌ per requirement, with file:line. ⚠️ for anything that cannot be verified from this diff.

### Strengths

### Issues
#### Critical (Must Fix)
#### Important (Should Fix)
#### Minor (Nice to Have)

### Assessment
Unit quality: Approved | Needs fixes
```

**Severity, concretely.** *Important* means the unit cannot be trusted until it is fixed: incorrect or
fragile behavior, a missed requirement, or maintainability damage you would block a merge over —
duplicated logic blocks, swallowed errors, tests that assert nothing. "Coverage could be broader" and
polish are *Minor*.

**The ⚠️ class is the driver's, not the reviewer's.** A requirement that lives in unchanged code or
spans units is reported, not chased — the reviewer has the diff, you have the plan. These do not block
the rest of the review, and you must resolve each one yourself before marking the unit complete. A ⚠️
you confirm is a real gap is a failed spec review and enters the fix loop.

When a partner seat is holding this contract, the driver's ⚠️ dispositions go back to the partner
before the unit closes. The class is driver-owned because the driver holds the plan — but a driver who
wants the unit closed is the seat most likely to find every ⚠️ harmless, and a ⚠️ that maps onto a spec
line should not close without the partner's acknowledgement.

A driver that reviews holds both the diff and the plan. It resolves each ⚠️ inside the review instead
of reporting it, and no acknowledgement step remains. The resolution, or the evidence gap that is
still open, stays visible in the Spec Compliance section.

**A plan-mandated defect is still a finding.** If the plan or brief explicitly asks for something this
rubric calls a defect, report it as Important, labeled plan-mandated. The plan does not grade its own
work.

**Read the package before the report, and skip the rationale on the first pass.** The report is where
the builder explains why it did what it did; reading that first is how a reviewer arrives at the diff
already holding the builder's frame. Read the diff, form your own verdict, then read the report for
the evidence fields — the commands, the RED/GREEN observations, the test line.

**Do not trust the report.** Treat the builder's report as unverified claims about the code. Design
rationales are claims too: "left it per YAGNI", "kept it simple deliberately", or any other
justification is the builder grading itself. A stated rationale never downgrades a finding's severity.

**The report is the final message.** Begin with the spec-compliance verdict. Every line is a verdict, a
finding with file:line, or a check that was run — no preamble, no process narration, no closing
summary.

## What names a range when there is no diff

This contract is written for code, and a pairing over a research pass, an analysis, or a document is
the shape pairing was named to protect. It is also where the contract is thinnest — no diff, no suite
— so one invariant carries most of the weight: **every number in a generated artifact comes from a
computed source, never a pasted literal, and no subset may exceed its total.** Recompute validates the
numbers at their source while the artifact keeps stale ones; only this catches that. The trigger generalizes without weakening: over code it is
`BASE..HEAD` as commit SHAs; over anything else it is a **named artifact path plus a content hash** the
reviewer can recompute — the same property, that the reviewer and the builder are provably looking at the
same bytes. What never triggers a review, in either shape, is a message announcing that work is going
well.

## The re-review

Scoped to the fix diff, handed the previous findings and the same brief:

```
### Findings Under Verification
Per finding: ADDRESSED | NOT ADDRESSED, with file:line evidence.

### New Breakage in the Fix Diff

### Out-of-Scope Observations

### Round Verdict
```

**"Attempted" is not addressed** — the specific defect must no longer exist. New breakage is scoped to
the fix diff only. Out-of-scope observations go to the ledger and never extend the round.

## Driver-side: do not pre-judge

If the prompt you are writing contains *do not flag*, *don't treat X as a defect*, *at most Minor*, or
*the plan chose this* — stop. You are pre-judging, and the usual motive is sparing yourself a round.
Ask for the review you would want if somebody else had written the code.

The mirror of that rule: a finding you disagree with gets a `Ruling:` on the record, not a quietly
narrower next dispatch.

## Priors

Seven habits, one line each. Each has caught something real; the defects that paid for them are in
`docs/solutions/best-practices/what-a-pairing-partner-catches.md`.

- **The inventory question.** What does this diff, or this suite, never mention? Absence is the
  finding that reads as nothing.
- **The falsifier.** For a check that reports success, reading cannot distinguish a working one from
  one that cannot fail; only mutation can.
- **Read a count and its denominator, never a filtered list.** Ask what a broken instrument would have
  printed here; if the answer is *the same thing*, the check proves nothing.
- **A named artifact is not a built mechanism.** A search proves a token occurs, never that a
  mechanism exists; write the check from the claim's wording, not from the shape you expect. A
  precise commit message is the transmission medium that tells you when to stop — trust it less.
- **A truncating count.** A number that stops at a cap looks like a measurement.
- **The traded property.** A fix that trades one property for another is checked on the property it
  gave up, not the one it bought.
- **A quoted principle is not a verification.** Naming the rule the code follows is not evidence that
  it follows it.
- **Numbers carry their basis.** A figure that survives into a commit, a PR body, or a doc says how it
  was measured, or it is re-read later as something it never was.
