---
title: Open the source before you grade the answer
date: 2026-07-23
category: best-practices
module: research checks
problem_type: best_practice
tags: ["research-quality", "answer-key", "grading"]
applies_when:
  - "designing a timed research check that has to separate runners"
  - "building an answer key for a live research task"
  - "deciding whether a wrong answer is fixed by one standing instruction"
---

# Open the source before you grade the answer

## Context

A timed research check separates runners only when each question can be graded
from a source you opened, not from whatever the strongest runner answered. An
untimed run by a strong model is the control: it shows whether the key measures
the runners or repeats that model.

Questions everyone gets right do not separate anyone. A useful question makes
the easy path a confident wrong answer.

## How to run one

### Three question shapes

**Something that does not exist.** Ask about a plausible thing that was never
released, and say that NOT FOUND is an allowed answer. Inventing the thing
anyway is the signal. A refusal that quotes the page showing what does exist
outranks a bare NOT FOUND.

**A field that answers a different question.** A stamp named `updated` is not
`published_at`. Asking for a publish date baits a reader into quoting the
wrong field from a page that looks more official. A more official-looking page
is not the answer to the question you asked.

**The item on top is not the newest.** A page can pin an older featured item
above a newer one. "Most recent" means newest by date, not whatever is drawn
at the top.

### Checking the answers

- Every answer needs a source URL and a verbatim quote of at most 25 words.
  A missing quote can happen for more than one reason. The text may not be on
  the page, it may have changed, or the page may not have been fetched, among
  others. A page that could not be fetched does not make the answer false.
- Build the key from the source you opened. Do not copy it from the
  highest-scoring runner. Prefer the API or the raw file over scraped HTML.
- Time the run from the recorded send and reply stamps.

### One instruction before you bench anyone

If a runner cites sources but returns a stale "latest", add one line to the
brief: verify recency against a live authoritative source; a stale answer scores
zero. If that line removes the failure, the gap is the brief. A runner that
invents facts is a different problem.

One observed change is not proof by itself. Run a randomized comparison on the
same frozen questions, with and without the line. Try one instruction before
you bench the runner.

Put these three lines in the brief:

1. Verify recency against a live authoritative source. A stale answer scores zero.
2. An `updated` stamp is not `published_at`. For dates, use the API field or
   the raw release file.
3. A second reader checks the result before anyone acts on it.

### A trap counts only when it is armed

The fields or the order have to actually differ that day. If `updated` matches
the publish time, or the featured item really is the newest, that question did
not test the trap. Do not treat a pass on an unarmed trap as a result.

## Why this matters

If the key is copied from the strongest runner, every runner who avoided that
runner's mistake is scored wrong, and the mistake is scored right. A key taken
from the source is what makes the check a measurement.

## Measured checks behind the research pass

These historical comparisons informed the research-pass routine. They describe
observed failure modes, not a certification of a model or tier. The source reports
are not published; the aggregate observations and their limits are recorded here.

| Ref | Observation | What it supports |
| --- | --- | --- |
| R1 | Claim-level checking found citation-integrity failures in three of four fluent, well-cited reports. | The producer cannot verify its own report by presentation alone. |
| R2 | One researcher scored 12/12 on timed lookups and 12/15 on deep research. | Reliability does not transfer across task classes. |
| R3 | Reports written in 54–61 seconds looked as polished as one written in about four minutes. | Reopening sources, rather than appearance, separates report integrity. |
| R4 | With an explicit audit warning, all nine checked claims in one report were supported. | A declared source check is a measurable brief condition. |
| R5 | One standing brief line preceded a score change from 7/12 to 10/12. There was no randomized control. | Try the brief fix before benching a runner; the observed lift does not prove causation. |
| R6 | A claim audit verified 23/23 items in one deep-research report and 4/11 in another. | Per-item verdicts can reveal a gap that report polish hides. |
| R7 | The one deep-research cell observed clean was terra at MAX effort, `n=1`. | Preserve the observed result while requiring replication before routing on it. |
| R8 | A frontier baseline failed two of three trap classes. | Build answer keys from opened primary sources, not from the top-ranked runner. |

## When to apply

- When you need questions that separate runners. Ordinary lookups will not.
- When you build a key for a live research task. Anchor it to the source.
- When a runner is failing and you are deciding whether to bench it. Try one
  instruction first.

## Examples

**A thing that does not exist.** "What is tmux 4.0's release date and its two
headline features? If it does not exist, answer NOT FOUND." The tags page shows
3.7b, not 4.0. The right answer quotes that page. Inventing 4.0 features is
the miss the question is built to catch.

## Related

- [/new reverts a codex seat's reasoning effort to its profile default](../integration-issues/new-command-reverts-codex-effort-to-profile-default.md) — the seat-reset footgun that silently invalidated a matched-tier eval run.
