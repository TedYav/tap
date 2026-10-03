---
title: Read a finished change with more than one method
date: 2026-07-10
category: best-practices
module: review
problem_type: best_practice
component: development_workflow
severity: high
applies_when:
  - "a change already looks done and more than one reader will look at it"
  - "a test can show the advertised path only by breaking a production rule"
  - "a value will be used later, and the check that accepts it is weaker than that later use"
  - "the same value can be typed on this call or read from earlier stored state"
  - "a fix changed behavior and the descriptions of that behavior may still say the old thing"
related_components:
  - tooling
tags:
  - review
  - validation
---

# Read a finished change with more than one method

## Context

A change that already passes its own tests can still be wrong in ways one reader
misses. Readers who look for different things, on the same diff, catch different
bugs. Run them again after the fix. The fix changes the diff, and the
descriptions of the old behavior often stay behind.

## How to run the panel

### 1. Different methods, then again on the fix

One reader checking that the change matches the request, one trying to break it,
and one reading the written contract will not find the same bugs. A second pass
on the fixed diff is part of the review. The same reader twice mostly repeats
the first pass.

### 2. A test that breaks a rule to show the happy path

Fixtures and stand-ins are fine. The smell is a test that can reach the
advertised path only by making a call the contract forbids. That is the design
saying it does not support the use case. Change the contract or the design, and
make the test use the path that is now allowed.

### 3. Check a later use at the bar that use enforces

If a handle, id, or path will be consumed later, the check that accepts it now
has to enforce the same predicate the later use enforces. "It exists" is weaker
than "it can be delivered to." Re-check at the later moment. The target can
stop being usable in between.

`runtime/bun/src/verbs/send.ts` treats a stored reply target as deliverable only
when that seat is active, not still launching, and either polls or names a pane.
That check does not ask whether the pane is still running. A pending or
suspended seat is not enough.

### 4. Fail loud for a typed value, and continue when stored state goes stale

The same field can arrive two ways. A value typed on this call that fails the
check is a mistake: refuse it. A value the system stored earlier, which later
fails the same check, must not stop every future call. Warn, omit it, and
continue.

`runtime/bun/src/verbs/send.ts` does that for a registered reply target that is
no longer deliverable: it warns and sends without the field.

### 5. Re-read every description in the same pass as the code

When behavior changes, search the help text, the contract, and the comments that
describe it, and check each one against the new code before the pass ends. A
prose fix can still look ambiguous. A test that asserts the corrected claim
settles it.

A reply must not copy the replier's own registered reply target onto the
outbound. `runtime/bun/src/verbs/reply.ts` composes that send with the auto-stamp
turned off.

## Why this matters

The bugs that survive a green suite are the ones that match the author's model
of the change. A reader trying to break it, and a reader taking the written
contract literally, are looking at a different surface. Checking the docs in a
later pass is how the old sentence survives the new code.

## When to apply

- On a change to a contract or a wire format, including one that already looks
  done. Read the fix again, not only the first diff.
- When a check accepts something that will be used later. Use the later use's
  predicate, and check again at that later moment.
- When one field is both typed and stored. Refuse the bad typed value. Omit the
  stale stored one and continue.
- When the happy-path test breaks a production rule. Fix the design.
- When behavior changes. Re-read every description of it in that same pass.

## Related

- `docs/PHILOSOPHY.md` — heterogeneity.
- `skills/tap/scripts/CONTRACT.md` — the envelope and reply routing.
