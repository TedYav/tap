# The dispatch and the report contract

Adapted from obra/superpowers `subagent-driven-development` (MIT) and EveryInc/compound-engineering
`ce-work` (MIT). What a builder is handed, and what it owes back.

## Constructing the dispatch

Five parts, and nothing else:

1. **One line** on where this unit sits in the project.
2. **The brief**, introduced as: *read this first — it is your requirements, with the exact
   values to use verbatim.* A subagent in your own checkout takes it as a path. A TAP seat takes it
   as content in the message body: a path into your workspace is one its checkout does not have.
3. **Interfaces and decisions from earlier units** that the brief cannot know — signatures agreed,
   names settled, a parked finding in the area this unit touches (point at the ledger line).
4. **Your resolution of any ambiguity** you noticed in the brief. You read it; the builder should not
   have to re-derive your reading.
5. **Where the report goes and the report contract** below: a report-file path for a subagent; for
   a TAP seat, the report comes back as content in its reply.

Exact values live in the brief, never in the dispatch prose. Two values in two places drift, and the
one the builder uses is the one you did not update.

**Do not paste accumulated history.** "State after units 1–3" summaries balloon a dispatch into
mostly-history and buy nothing the brief and the interface notes do not already carry.

**The builder does not spawn its own reviewer.** Every reviewer a builder spawns duplicates the review
the unit is about to get anyway — a whole extra seat per unit. A builder-spawned review is a thing to
flag, not evidence of rigor.

**When you spawn the builder, pin its model explicitly.** An omitted model inherits the dispatching
session's. A partner seat already has its model; this applies to subagents you dispatch.

## The report contract

The builder writes the long report to the report file and returns a status summary of **under 15
lines**:

- **Status** — one of `DONE` / `DONE_WITH_CONCERNS` / `BLOCKED` / `NEEDS_CONTEXT`.
- **Commits** — short SHA plus subject, one per line.
- **Tests** — one line: what was run, and the result.
- **Concerns** — anything the driver should know before the review.
- **Report path** — from a subagent sharing the checkout. A TAP seat in its own checkout puts the
  full report after the summary in the same body file instead; those lines are outside the limit.
  The file stays in the builder's workspace as its own memory; the other seat cannot open that path.

The report file carries the detail: what was built and why, the commands run with their output, and —
when the unit called for TDD — the evidence fields:

- **RED**: the command run, the relevant failing output *before* the implementation, and why that
  failure was the expected one.
- **GREEN**: the command run and the relevant passing output after.

That RED observation exists nowhere else. The tree cannot reconstruct it, so a report that omits it
leaves the unit's verification permanently incomplete — mark it unverified rather than write down an
observation nobody made.

**The report file is the persistent memory.** If the builder is replaced mid-unit — a swap, a
restart, a fresh seat one tier up — the replacement is handed the brief, the report, and the
open findings, as paths it can open or as content. Nothing depends on the previous builder's recollection.

## Answering a builder's escalation

`NEEDS_CONTEXT` is yours to answer — you hold the plan the brief cannot carry. `BLOCKED` means read
the report and decide: re-scope, rule, or escalate if it is one of the four stop classes.
`DONE_WITH_CONCERNS` reviews as normal, and the concern travels to the reviewer as a lead — it is the
builder telling you where to look, which is worth more to the review than to you. Never ignore
an escalation, and never send the same model back at the same task unchanged.

Tell builders plainly that stopping is allowed: *it is always fine to say this is too hard for me.*
The alternative is a builder that guesses confidently, which costs a fix loop to discover.

**Pick the verification approach before changing behavior, and record which one** — an existing
failing test, a corrected expectation verified failing first, an over-mocked test strengthened
narrowly and then verified to fail *for the right reason*, a new focused test, or a recorded no-test
exception with its replacement verification. Working proof-first means the test and the implementation
are not the same step: the order is what produces the observation.
