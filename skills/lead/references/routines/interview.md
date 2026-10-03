---
contract: interview/v1
packet_extensions: [domain_slots]
---

# Routine: interview

Use this routine when a mission lacks a decision needed to proceed. A bounded bead with a usable spec starts directly; it does not pass through an interview merely because fields could be filled. Resolve facts from the repo and prior decisions first, and ask only for gaps that change the work. The coverage rules below apply when this routine is selected for an actual unresolved brief.

## Goals

- Fill every mandatory coverage slot with enough specificity for the next stage to act.
- Ask only questions whose answers can change the brief, using gap-lens probing rather than a fixed
  checklist.
- Preserve where every elicited claim came from so downstream stages can distinguish facts from bets.

## Inputs and coverage

Inputs are the raw mission, known-context references (files and prior decisions), the generic slots,
and any packet-supplied `domain_slots`.

Generic slots are mandatory by default:

- goal
- constraints
- evaluation criteria
- wanted artifacts
- budget / deadline
- ratified-vs-open decisions

Each `domain_slots` entry names a `slot` and declares `mandatory: bool` (`true` or `false`). A
mandatory domain slot joins the dispatch-blocking floor; an advisory slot may remain unfilled
without blocking.

## Invariants (MUST)

- **Mandatory means blocking.** Downstream dispatch BLOCKS while any mandatory generic or domain
  slot is unfilled. A depth limit, timeout policy, or pushback never silently waives the gate.
- **Explicit invitation overrides timeout policy:** when the human explicitly asked to be asked, never proceed-on-timeout — restate questions in plain text and end the turn. No packet value can disable this invariant.
- **Claims stay auditable.** Tag each elicited claim `user-stated`, `inferred-confirmed`, or
  `assumption-documented`; never promote an agent inference to a user fact. The three tags
  carry admission rules that make them checkable — see *Provenance rules* below.
- **Every probe closes visibly.** Its gap is answered, recorded as an explicit assumption, or listed
  in the unfilled-slot report. Nothing asked is silently dropped.
- **Do not lead the witness.** Probe the detected gap without suggesting an answer or naming a
  solution shape the human did not introduce. Verify codebase absence claims before treating them as
  product facts.

## Provenance rules (MUST)

The three tags are worthless if any of them can be applied on the tagger's own say-so. Each
one has an admission rule, and the slot table below is what makes the rule checkable.
[absorbed from a retired briefing skill, which used the same three tags over Every's
Fable 5 Operating Pack templates]

- **`user-stated`** — they typed it. Nothing else qualifies.
- **`inferred-confirmed` takes both halves.** The **source artifact is named** (which file,
  which prior decision, which repo fact the inference came from — in the Source cell, not in
  your head), **and** the value was **shown to the user** — in the question batch or in the
  slot table — **without correction**. Either half alone is not confirmation.
- **An inference the user never saw stays `assumption-documented`**, however confident you
  are and however obvious the repo makes it. Silence about a value nobody was shown is not
  assent; it is absence of an opportunity to object.
- **No slot is silently blank.** When the user is unavailable, open slots become documented
  assumptions **stated in the output**. A blank cell is indistinguishable from a forgotten
  one, which is exactly why the downstream stage cannot price it.

**Emit the slot table as evidence before drafting anything downstream:**

| Slot | Value (abridged) | Source |
| --- | --- | --- |
| done criteria | "every endpoint migrated, full suite green" | user |
| sources | `skills/lead/references/` | inferred from repo layout — confirmed |
| deadline | none | assumption (documented) |

The table is the move, not a formality: it converts "I tracked provenance carefully" — a claim
about your own diligence, which nobody can check — into a per-row artifact a reader can
audit, and it puts every inferred value in front of the user in time for them to correct it.

## Gap-lens practice

Read the current brief, find the highest-value unresolved mandatory gap, and ask the smallest question
that can close it. Prefer a concrete recent instance over a hypothetical; challenge undefined terms;
surface load-bearing assumptions; use forced trade-offs only when evaluation weights are genuinely
unclear. Ask dependent questions one at a time, then recap and confirm the resulting claim before
recording it. Stop probing when every mandatory slot is filled; do not keep asking for ceremony.

## Adaptation knobs

This list is the normative packet vocabulary for an `interview` stage:

- `probing` — probing strategy; default `gap-lens` (detected gaps only, never a fixed list).
- `depth_bound` — maximum rounds/questions for the current interview. Reaching it produces an
  unfilled-slot report; it does not clear a mandatory slot.
- `provenance_tags` — provenance policy; default `on`, using exactly `user-stated`,
  `inferred-confirmed`, and `assumption-documented`. The knob governs whether tagging runs, not
  what a tag may be applied to: the admission rules above hold wherever tagging is on.
- `timeout_policy` — behavior when no explicit invitation to ask exists. It cannot override the
  explicit-invitation MUST above.

## Output and composition gate

Return the filled brief (slot values plus per-claim provenance tags) and an unfilled-slot report. The
filled brief is the routine's named artifact handoff. The next stage may consume it only when the
unfilled-slot report contains no mandatory slot; advisory gaps remain visible but non-blocking.

## Technique — the one-shot leading interview

When a proposed packet needs an interview, keep exactly one leading interview stage. It runs once;
completion is run-state, never a packet edit. Re-enter full validation and routing with the filled
brief, skipping the completed stage for dispatch. The failure signature is a duplicate interview
(classically after a compaction, when run-state was lost but the packet still lists the stage) or a
mutated packet; recover by restoring the original packet and using run-state to record completion.
