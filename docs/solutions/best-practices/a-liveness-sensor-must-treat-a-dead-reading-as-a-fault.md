---
title: "A liveness sensor must treat a dead reading as a fault"
date: 2026-09-22
category: best-practices
module: "Seat liveness monitoring and escalation routing"
problem_type: best_practice
component: observability
severity: critical
root_cause: missing_validation
resolution_type: workflow_improvement
applies_when:
  - "a monitor reports per-seat context usage against a threshold"
  - "a seat's pane wake path may fail while the message bus still accepts notes"
  - "the only escalation target for a monitor is the seat being monitored"
tags:
  - liveness
  - sensor-design
  - escalation
  - silent-delivery-failure
  - threshold-monitor
---

# A liveness sensor must treat a dead reading as a fault

## Context

A context monitor whose only test is "under threshold" can publish a dead context as healthy.
The bus accepts the note, the registry still shows the seat alive, and the context reading is
zero, so the heartbeat says `ok`. A registered seat reading zero context is a fault signal,
never a resting state.

## Guidance

A threshold monitor needs a floor as well as a ceiling. A reading of zero, a missing reading, or a
reading unchanged across consecutive samples must not be folded into the `ok` set on the strength of
passing the under-threshold test. Report it as `suspect` or `unknown`.

`suspect` is not yet a fault, and the difference matters because each of these readings has an
innocent cause. A freshly started, cleared, or compacted seat legitimately reports near-zero
context, and `runtime/bun/test/context-census.test.ts` fixes `0% (0) ctx` as a *valid* parse
distinct from the `null` an absent or ambiguous gauge yields. An idle seat legitimately reports the
same value on consecutive samples. Escalate only on corroboration: pair the suspect reading with a
second, differently shaped signal — no settled traffic since a named timestamp, a failed or
unconfirmed pane delivery, a pane capture showing no turn — matching the rule that a wedge requires
multiple signals to agree rather than one heuristic (`CONCEPTS.md`, Seat State). What the run got
wrong was not the absence of a fault verdict; it was publishing `ok` on the reading alone.

The corroborating observation is about the recipient, not the transport. **A delivery receipt is not
one of these signals:** in the exact shape this page describes, the bus accepts the note and the
pane wake path is dead, so the receipt confirms transport only. Settlement is the mechanical
liveness signal (`CONCEPTS.md`, Probe) — a settled reply, a new non-supervision bus message, or a
pane capture showing a started turn. Treating an accepted delivery as liveness reproduces the
false-healthy result this page exists to prevent.

Do not send the fault only to the address being read. That address cannot report
its own silence.

## Why This Matters

A sensor that characterizes a dead context as healthy is worse than no sensor: it converts silence
into positive reassurance. The bus accepting a note is evidence about the bus, not about the
recipient.

## When to Apply

- When a context, heartbeat, or capacity monitor treats "under the limit" as healthy.
- When a delivery receipt is the only evidence a recipient is alive.
- When an unchanged reading is about to be treated as an idle-but-healthy state.

## Examples

A heartbeat that folds a zero reading into `ok` because the reading is under the ceiling is the
bad case. The useful reading names the seat suspect and pairs the zero with a second signal, such
as no settled reply and a wake that never reached the pane.

A zero immediately after start, clear, or compaction is the expected reading. Call
it a fault only after a second signal agrees.

## Related

- [`A zero at the boundary describes the instrument`](a-zero-at-the-boundary-describes-the-instrument.md)
