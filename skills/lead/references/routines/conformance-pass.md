---
date: 2026-07-21
source_run: tap-vynt. Adapted from the review gates in github.com/dsifry/metaswarm.
  Four live conformance passes were authored from their durable records,
  plus an adversarial pass that failed and whose findings this revision encodes.
contract: conformance-pass/draft
packet_extensions: []
---

# Conformance pass — adversarial verification against a ratified contract

DRAFT — surfaced as draft until ratified to /v1 after at least one live rep. The first rep is
the first gate dispatched after this example exists; in-flight gates keep their shape.
`packet_extensions` is deliberately empty: requests ride TAP payloads, not lead packets;
schema promotion is a /v1 question, decided from the live-rep record.

## Goals

Adversarial, evidence-cited verification that a deliverable (PR at a pushed SHA, doc,
routine) conforms to its **ratified contract** — the durable record that licensed it —
returning a verdict before the merge gate. The service is **peer-addressable**: any seat may
request it directly; the reviewer verifies the authorization chain from the referenced
records, never from who relayed the request. [evidence: restricted tracker tap-vynt, four live pass records]

**Scope cut (named):** this draft covers the **adversarial execution-conformance gate**
only — verifying a built deliverable against its ratified contract. The full
collaborative-design / adversarial-plan / adversarial-execution mode taxonomy
encodes at /v1 promotion, not before.

The contract has two halves: the **dispatch carries the work order + lens card; the gate
record is the return.** [evidence: tap-vynt]

## A. Dispatch half — work order + lens card (MUST, requester-side)

A conformance request names, in its payload body:

- **Durable source refs** — the ratifying text MUST live in a durable record: a bead, a PR
  comment, or a committed artifact, cited alongside the PR + pushed SHA under review.
  Machine-local bus payload IDs are **supplementary provenance only** — bus retention
  expires, and a fresh peer must be able to replay the authorization chain from the durable
  record alone. When no durable record carries the ratifying text, the pass opens with
  ESCALATE.
- **DoD items** — enumerated, independently checkable claims to verify. Each item is
  verifiable without interpreting intent; ambiguity in an item is the requester's defect, and
  the reviewer surfaces it rather than guessing. [evidence: review gates in github.com/dsifry/metaswarm]
- **Lane scope** — the declared file scope of the deliverable, as an **audit field**: the
  reviewer checks `git diff --name-only` against it, path for path. Scope is never permission
  for parallel writers, because file lists do not isolate the git index, generated files, or
  gate evidence. Worktrees and the Writer Token remain the concurrency boundary.
- **Lens card** — the service terms for this pass:
  `function` (what completeness this pass owns) · `lens` (the bounded question) ·
  `authority` (what the reviewer may decide alone; what it must escalate) · `inputs`
  (the refs above) · `return` (the gate record below, and where it lands — usually
  `tap reply`) · `continuity` (freshness class, see below) · `checkpoint` (any planned
  pause/report point, or `none` for a single-pass request) · `exit` (settlement condition
  plus writer-token/lease disposition — explicit `N/A` when a read-only pass acquired none).
  [evidence: finding #6]

## B. Return half — the gate record (MUST, reviewer-side)

- **Verdict is PASS, FAIL, or ESCALATE — never "mostly pass."** One top-level verdict token,
  no composites: item-level statuses live in the item rows, and any open escalation makes the
  top-level verdict ESCALATE — a deliverable cannot advance while a ruling is pending.
  [evidence: finding #1 — the debut catch was this contract's own worked example]
- **A cited contract violation is FAIL regardless of size** ("close enough" is FAIL).
  **Uncertainty is a question or an ESCALATE, never a verdict** — doubt does not convert to
  BLOCKING. [evidence: convergence boundary 5]
- **Evidence or silence.** Every claim, PASS or FAIL, **per item**, cites its ground:
  `file:line`, or command + verbatim output. An aggregate verdict sentence is not evidence.
  Claims on the invalid-evidence list are **void — unsayable, not downgraded to warnings**:
  a claim the change is sound with no location cited; a claim that tests cover the item
  without naming one; a statement of confidence with nothing cited to check; a resemblance
  to some other code, which is not evidence. [evidence: review gates in
  github.com/dsifry/metaswarm; finding #2]
- **FAIL states expected-vs-found**, both cited: what the contract says, what the artifact
  does, where.
- **Fix-OR-rebut:** the author may answer any finding by fixing it or by **rebutting it with
  evidence** — a cited rebuttal is a legitimate move, not non-compliance. The reviewer judges
  the rebuttal on its evidence. [evidence: restricted tracker tap-vynt, adversarial pass record]
- **Freshness class is declared in the record:** a **focused reverify** receives the selected
  finding and verifies the fix (expected-vs-found resolved, cited); a **fresh whole-result
  pass** starts with prior conclusions quarantined. Blanket reviewer amnesia is rejected —
  independence belongs to initial discovery and the final whole-diff gate. [evidence:
  convergence boundary 4; restricted tracker tap-vynt, narrow re-check records]
- **Attempt history:** attempt number and refs to prior failure records ride the record.
  Budgets are **surfaced bounds, not magic numbers**: an exhausted bound reports incomplete
  coverage and escalates; it never silently passes. [evidence: convergence boundary 5;
  prose gates skipped under completion pressure]
- **Next legal moves:** PASS → the deliverable proceeds to its next declared gate; FAIL →
  fix-or-rebut, then focused reverify; ESCALATE / exhausted budget → the LEADER or the human,
  with the failure history attached. FAIL never transitions directly to success.

## Evidence-contract composition (single home)

This contract is the **verdict-side** home of the evidence doctrine: it disciplines the
reviewer's claims. The **producer-side** home is the "evidence stays honest" objective of
`skills/lead/references/choreography-best-practices.md`, routed from the charter
(`skills/lead/SKILL.md`, which carries the reverse pointer here). One pointer each way;
neither home restates the other's rules. [evidence: single-home doctrine; finding #7]

## Run shape (SHOULD) — the service loop

1. Request arrives as a TAP payload (any seat may send it).
2. Reviewer verifies the authorization chain from the cited durable records (bead, PR
   comment, committed artifact) — not from the requester's say-so; supplementary payload IDs
   corroborate but never substitute.
3. Reviewer runs the checks against the DoD items from its own checkout of the pushed SHA
   (read-only ground: never checkout inside another lane's worktree).
4. Gate record returns via `tap reply` (answers + settles in one).
5. Fix-or-rebut iterations run as focused reverifies; the merge gate and lead read follow the
   verdict per the normal ladder.

## Adaptation knobs

| Knob | Default | Notes |
| --- | --- | --- |
| `freshness` | fresh whole-result for pass 1; focused reverify for fix rounds | declared in every record |
| `budget` | surfaced per dispatch (no universal cap) | exhaustion reports + escalates |
| `depth` | all DoD items | a narrowed re-check names the selected findings |

BONUS: cite seat-calibration context when the deliverable's author has a known
evidence-drift pattern (verbatim-quote mitigations).

## Worked example (the one Standing Brief example)

This is a template adapted from one historical pass. Its adjudicated cuts live in
restricted tracker **tap-qxft**; the review thread and exact revisions are not in the
public copy. `RECORD_ID`, `NUMBER`, `PUSHED_SHA`, and `MERGED_SHA` are placeholders;
the record below also uses `CONTRACT_DOC`, `ROUTINE_DOC`, and `<name>` as generic
path-and-contract stand-ins to be filled the same way.
A live gate must fill them with reachable durable records and exact revisions before
the item-level claims can be replayed. Expired bus identifiers are not the authorization chain.

**Dispatch (A):**
> **Durable refs (example shape):** bead `RECORD_ID`; `PR #NUMBER at PUSHED_SHA`.
> **DoD items:** (1) canonical ingest contract fields/headings present; (2) durable-evidence,
> bus-only-capsule, privacy, and proposals-not-doctrine clauses present; (3) temp-rename +
> archive-ignore mechanics; (4) installer link, no clobber; (5) compounding-close exact
> two-class exit, on-disk floor, recursion guard, and **conditional destinations**; (6)
> exactly three staffing doctrine sentences; (7) no writer/parser/validator/**helper** beyond
> installer materialization.
> **Lane scope (exact changed paths, audited against the diff):** install.sh ·
> skills/lead/SKILL.md · skills/lead/references/ingest/README.md ·
> skills/lead/references/orchestration-best-practices.md ·
> skills/lead/references/routines/compounding-close.md ·
> skills/lead/scripts/smoke/lead-structure.test.sh ·
> skills/tap/scripts/smoke/bin-tap-cwd-independent.test.sh ·
> skills/tap/scripts/smoke/caveat-generated-surfaces.test.sh ·
> skills/tap/scripts/smoke/identity-injection.test.sh ·
> skills/tap/scripts/smoke/install-primary-guard.test.sh ·
> skills/tap/scripts/smoke/session-id-capture.test.sh
> **Lens card:** function: conformance of the reviewed PR to its ratified contract · lens: does the
> diff at the pushed SHA satisfy each adjudicated item verbatim-or-better · authority: may
> verdict per item, must escalate contract-vs-convention conflicts · inputs: durable refs
> above · return: gate record via `tap reply` · continuity: fresh whole-result ·
> checkpoint: none — single-pass service request · exit: reply settles; lease disposition:
> N/A — read-only pass, no writer token acquired.

**Gate record (B):**
> **Verdict: ESCALATE.** Attempt 1, fresh whole-result. All seven DoD items pass at item
> level; F1 requires a LEADER convention ruling, and an open escalation caps the top-level
> verdict — the deliverable does not advance until ruled.
> 1. Contract fields/headings — pass: each required frontmatter field and heading cited at
>    its `CONTRACT_DOC:LINE` (fields quoted from the frontmatter block, headings quoted
>    verbatim).
> 2. Required clauses present — pass: each clause anchored at its own `CONTRACT_DOC:LINE`.
> … (one row per remaining DoD item, each pass citing `file:line`, or command + verbatim
> output — an aggregate verdict sentence is not evidence)
> 7. No production-executable surface beyond the declared materialization — pass:
>    `git show MERGED_SHA --name-only --format=` → exactly the paths declared in Lane scope,
>    fixture-executed and diffed against that list on every run.
> **F1 (drives the ESCALATE):** Expected: `contract: <name>/draft` at birth, per the
> frontmatter-stamp convention. Found: `contract: <name>/v1` at `ROUTINE_DOC:LINE` of the
> reviewed SHA. Next legal move: LEADER ruling or the one-line stamp fix. After the fix
> lands, a focused reverify re-checks F1 (expected-vs-found resolved, cited) and flips the
> top-level verdict to PASS.

## Boundaries (MUST NOT)

- No "when in doubt, BLOCKING" — doubt asks, evidence verdicts.
- No composite verdicts — escalation status lives in the record, not in the verdict token.
- No universal retry cap; bounds are surfaced and their exhaustion is loud.
- Lane scope never licenses concurrent writes to one tree.
- This contract adds no verdict classes and relaxes no existing gate; it shapes the request
  and the record. Register/envelope changes escalate to the LEADER. [evidence: tap-vynt
  authority terms]
