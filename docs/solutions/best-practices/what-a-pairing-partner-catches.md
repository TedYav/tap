---
title: What a pairing partner catches
date: 2026-08-27
category: best-practices
module: skills/tap-pair
problem_type: best_practice
component: development_workflow
severity: high
applies_when:
  - "a second seat re-runs a count and is about to accept it because the number matched"
  - "a generated artifact is rebuilt after its first review"
  - "a search hit is about to stand in for a mechanism"
  - "a review is about to start from a message saying work is going well, or from a tree that still has later edits"
tags:
  - pairing
  - review
  - verification
---

# What a pairing partner catches

`/tap-pair` keeps its review rules to one line each. This note is why those
lines exist. The one-line habits themselves stay in
`skills/tap-pair/references/review-contract.md`, where every round uses them.

## Re-running a script does not audit the definition

The same script produces the same number, including when the number answers a
different question than the claim. A substring test counts every mention. A
starts-with test counts the events. Matching the first count only shows that
the script is stable.

## A rebuilt artifact can carry a number that no longer exists

A literal pasted into a generator survives the rebuild and still prints the
old figure. Every number in a generated artifact comes from a computed
variable. After a rebuild, check that no part is larger than the whole it
belongs to. That defect is not in the first draft, so the first review cannot
see it.

## How a round stays short

- Open with what a second run confirmed. A list of only the defects pushes the
  writer to change things that were already right.
- A blocking defect and a wrong label are different. Say which one it is.
- Each finding carries the correction. A question sends the work back for
  another round.
- The next round re-checks what changed, and the confirmations. It does not
  reopen the previous round.

## A reader of every range does not gate the whole diff

Looking across state, persistence, and display can find a defect that each
green suite missed. The context that lets that reader see those seams is the
same context that makes the reader not independent. That reader does not also
give the final approval. A reader who has not seen the ranges does.

## A search hit is not a built mechanism

A search for the fix's name also matches a file that names the fix without
containing it. A precise description of the fix tells the reader what to expect,
so they stop at the first artifact that matches. Trust that description less.
Write the check from the claim's wording, not from the artifact you expect
to find.

The same shape appears in a checker that only proves a line is non-blank, and
in a probe that proves what the code does and not what the write-up said.

## Review a named range

A message saying work is going well is not a review request. A tree that still holds the next
unit's edits is not the range under review. The named range is what a later
reader, including a successor after a restart, can reproduce.

## Keep the one-line rules where they are used

A rule that fits on one line and is read every round stays in the contract.
This note holds the argument. A pointer that says the rules moved, when the
target does not contain them, reads as coverage it does not have.
