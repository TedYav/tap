---
title: "A legacy-compatibility regression must supply an input the new rule would change"
date: 2026-10-22
category: best-practices
module: discuss skill helpers (fold.sh, convergence-ledger smoke)
problem_type: best_practice
component: testing_framework
severity: medium
applies_when:
  - "a change adds an opt-in mode and claims the default path behaves exactly as before"
  - "the new mode reorders, filters or re-keys inputs that the old path took as given"
  - "the legacy regression is built from the same fixture shape as the new-mode test"
  - "a compatibility claim is written into a contract, PR body or ledger item"
tags:
  - compatibility
  - legacy-mode
  - opt-in
  - regression-test
  - anti-placebo
  - fold
  - discuss
---

# A legacy-compatibility regression must supply an input the new rule would change

## Context

The discuss skill's fold helper gained an opt-in n-party mode (2026-10-22). When `metadata.json` declares a `peers` map, `fold.sh` applies a batch of proposal payloads in courier placement order and detects cross-sender conflicts; the contract promised that a thread without `peers` keeps its previous application order and id behavior (its fold receipts gained new summary fields, so the promise was about semantics, not bytes). An intermediate revision gated conflict detection on `peers` but left the placement-time sort unconditional. A legacy thread whose payloads were passed in an argument order different from their placement order therefore ended in a different final status than the previous helper produced, which applied the caller's argument order.

The legacy regression arm passed its payloads in the same order they had been placed. On that input, argument order and placement order are the same permutation, so "applies in argument order" and "applies in placement order" produce identical ledgers and the arm stayed green. In the repo's vocabulary (CONCEPTS.md) this is a Discrimination Claim that fails by value: both paths ran on an input under which the only divergence collapsed to the same result, which makes the arm a Placebo Arm of the second kind, one that reaches every line it names and still cannot fail. A reviewer found the unconditional sort by tracing the source, not by running anything. The fix gated the sort and added regressions whose inputs the two orderings resolve differently.

## Guidance

When a change claims "the default path behaves as before", the regression that supports the claim must feed the default path an input on which the new rule and the old behavior disagree, and the claim is only as wide as the behaviors such inputs cover: the paired arms here prove application order, not an untouched branch. Enumerate what the new rule does to its inputs (reorder, filter, re-key, dedupe, gate) and build the legacy fixture so that each of those operations would be observable if it ran: payloads out of placement order, an item the filter would drop, an id the re-keying would rename. Then assert the old outcome. If the fixture is built from the same happy-path shape as the new-mode test, it proves nothing about the switch; both rules agree on it.

Evaluate the claim per sub-behavior the change touches, not once for the feature. Here two of the n-party mode's behaviors were in play, conflict detection and placement-order application (the third, per-sender id prefixes, was gated from the start); the first was gated and tested, the second was neither, and one green arm labelled "legacy" covered both. Check each changed behavior against the existing legacy fixtures: reuse a fixture if the leaked rule would change its asserted result, otherwise strengthen it or add a case that distinguishes the old behavior from the new rule. A test whose chosen input produces the same observable result under both rules does not establish that the switch is respected, however old or new the fixture is.

Write the new-mode counterpart with the same inputs and the new assertion. The pair shows that the mode switch selects the expected application order for these inputs; the new-mode arm is the positive control that makes the sort observable. In `convergence-ledger.test.sh`, the `t-legacy-order` arm feeds one sender's two payloads in reverse placement order and asserts the last argument's status, and the `t-peer-order` arm feeds the same two payloads on a thread with `peers` and asserts the placed order.

Treat a compatibility claim like any other Discrimination Claim: the question to ask of the regression is "which input would make this fail if the rule leaked?", and if there is none, the arm is a placebo and the input, not the assertion, has to change.

## Why This Matters

A compatibility guarantee is usually the one line in a contract that other people stop checking. Here it covered every existing two-party discuss thread. A green regression that cannot distinguish the two behaviors is worse than no regression, because it converts a reviewer's doubt into a settled ledger item. The gap was caught only because one reviewer read the code path rather than the test name; the green arm had already been offered as evidence for the compatibility claim.

The failure is structural, not careless. The author of an opt-in mode naturally tests the new mode with inputs that exercise it and the legacy mode with inputs that exercise nothing, because the legacy path is "just what it was". That is exactly the input on which a leaked rule is invisible. Pairing the two arms on the same inputs with different expected outcomes is fine; what matters is that the input separates the outcomes.

## When to Apply

- An opt-in flag, mode, or declared field switches on new behavior and the old behavior is promised unchanged.
- The new behavior sorts, filters, dedupes, gates or re-keys inputs the old path consumed as given.
- A contract, ledger item or PR body states "n = 1 behaves as today" or words to that effect; say which behaviors the regressions actually pin.
- A review finding says the legacy test "cannot distinguish" the two behaviors.

## Examples

Before, in the first regression arm: two senders' payloads were written in placement order and passed to `fold.sh` in that same order. The assertion that the legacy thread was "last-writer-wins, exactly as before" held under both the old argument-order application and the new placement-order sort.

After, the arm that can refuse:

```bash
# abridged from convergence-ledger.test.sh (the t-legacy-order arm); one sender, two payloads:
# p1 placed first (accepted), p2 placed second (deferred)
bash "$FOLD" "$TID_LEGACY_ORDER" "$order_p2" "$order_p1" --by "$DRIVER"   # arguments in reverse placement order
expect_status "legacy argument order decides the final status, as before" "$TID_LEGACY_ORDER" x accepted
```

Under the leaked sort this ends `deferred`; under the base behavior, and the fixed helper, it ends `accepted`. The sibling n-party arm passes the same two payloads on a thread that declares `peers` and expects `deferred`.

## Related

- CONCEPTS.md: Discrimination Claim (the by-value failure this is an instance of), Placebo Arm (the second, reachable-but-unfalsifiable level), Positive Control.
- The general mechanism is the second level of an arm that cannot fail: both paths run, but the chosen input makes every divergence a no-op. The remedy there is a different input, never a rewritten assertion, and each "X not Y" claim owes its own falsifying input.
- The review-side counterpart: a clause such as "byte-identical when unset" is a claim to check per behavior the change touches, since it can be true of one half of a change and false of the other.
- `skills/discuss/scripts/fold.sh`: the `peers is not None` condition that now gates the placement sort and the conflict preflight (two blocks, one switch).
- `skills/discuss/scripts/smoke/convergence-ledger.test.sh`: arms `t-legacy-order` and `t-peer-order`.
