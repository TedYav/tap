---
date: 2026-07-22
source_run: two design lanes ratified in one round (tap-ix63, tap-p6el; charter tap-0l0c)
contract: design-adjudication/draft
packet_extensions: []
---

# Design adjudication — adversarial design-first lane, no implementation authority

DRAFT — surfaced as draft in any shelf selection until ratified to /v1. `packet_extensions` is deliberately empty: dispatches ride TAP work-order payloads, not lead packets. Schema promotion is a /v1 question, decided from further live repetitions.

## Goals

Separate design from implementation for risky or contract-touching work. An adversarial designer who will not implement argues a shape under a named evidence standard. The leader adjudicates. Rulings land durably before anyone is staffed to build. The format earned routine status from lanes that ratified in one round and granted no implementation authority.

**Why the separations hold:**

- **Designer is not the implementer.** Adversarial pressure works when the designer does not own the build. Dispatches open as no-implementation lanes.
- **Ratification is not staffing.** A shape can be ratified while implementation stays unstaffed. Authority to build is granted later, as its own decision.
- **The bead is not the working doc.** Rulings append to the bead so the decisions survive temporary-file cleanup. The working doc is ephemeral until it rides the implementation pull request. The bead, not the doc, is the durable decision home.

## Dispatch half — the design work order (MUST, leader-side)

The dispatch payload names:

- **The problem, and the banked seed when one exists.** When a seed is already on the bead, the designer starts from it.
- **Grounding** (SHOULD when the design targets moving code): the named model state to design against, so the draft is not aimed at a tree that has already moved.
- **The coverage list.** The specific questions the draft must argue, including interactions with named prior lessons and contracts, failure modes, and the contract delta. Alternatives are argued on the page, not merely chosen. For example: N payloads and one sentinel, or N sentinels and one submit.
- **The evidence standard.** Flag every construction that only works because some quantity is small or rare today, as a named assumption for this domain (for a courier spool: SMALL-SPOOL). This self-pressure is mandatory. The designer grades their own scaling assumptions, which is where self-assessment drifts.
- **Deliverable location.** A design section appended to the bead, or `tmp/design/<bead>-<slug>.md` when it outgrows a bead note.
- **The authority line, explicit.** No implementation authority. The leader reads and adjudicates before anyone implements.

## Draft contract — what the designer returns (MUST sections)

Ratified drafts share this shape. It is the return contract:

1. **Status header.** Design-first, no implementation authority, author, seed and grounding, and the named evidence standard.
2. **Problem and non-goals.**
3. **Shape recommendation with the argument.** Alternatives compared on the page, not a bare conclusion.
4. **Semantics and interaction sections** against the named grounding and prior lessons.
5. **Failure modes, pressure-tested** and numbered.
6. **The assumption table.** An explicit list of what only works because some quantity is small or rare: assumption, what breaks it, and the design response.
7. **Contract delta, as draft prose.** Stamp coordination is explicitly deferred so the draft does not collide with in-flight claims.
8. **Smokes for the eventual pull request.** Not this lane.
9. **Open calls for adjudication.** Numbered, each with the design's lean.
10. **Self-adversarial summary.** The highest-risk classes if the shape is implemented carelessly. This section becomes the implementation review checklist.

## Adjudication half — the leader's return (MUST)

- **Verdict on the shape.** Ratified, possibly as drafted, or revise. One round is the aim. Multi-round mechanics stay unspecified until a live lane needs them.
- **Numbered rulings answering each open call**, each with its rationale. Name the doctrine that carries a decision when one does.
- **Riders.** Constraints the adjudicator notices beyond the asked calls.
- **A ruling that names the human gets a veto window** flagged in the leader's wrap. A two-way-door ruling carries a named revisit trigger: the concrete live case that would reopen it.
- **Residuals out of scope are filed as beads, never left as folklore.** The adjudicator files the follow-up.
- **Disposition block, explicit.** Rulings and riders append to the bead, so decisions survive temporary-file cleanup. The full doc rides the future implementation pull request. Implementation staffing status is stated. Contract stamp coordination is stated. The authority line is restated: no implementation authority is granted yet.

## Run shape (SHOULD)

1. The leader banks or receives an adversarial seed on the bead and dispatches the design work order to a non-implementing adversarial seat.
2. The designer drafts to the return contract and appends it to the bead, or grows `tmp/design/<bead>-<slug>.md`.
3. The leader reads and adjudicates. Rulings and riders append to the bead, and the doc mirrors them.
4. Residual beads are filed. Human-naming rulings are surfaced for veto in the wrap.
5. Implementation is staffed later, as its own decision. The self-adversarial summary becomes the implementation review checklist, and the doc rides that pull request.

## Adaptation knobs

| Knob | Default | Notes |
| --- | --- | --- |
| `designer` | an adversarial, non-implementing seat | Non-implementing is the invariant. Which seat is the knob. |
| `deliverable` | bead note; `tmp/design/<bead>-<slug>.md` on outgrowth | Use the file when a bead note is too small. |
| `assumption_flag` | named per domain | The flag names this domain's scaling assumption. |
| `coverage` | per dispatch | The argued-questions list is the work order's core. |

When the designer's evidence standard shows, record a calibration datum on the seat ledger.

## Boundaries (MUST NOT)

- **No implementation authority rides this routine**, not at dispatch and not at ratification. Staffing the build is a separate, later decision.
- **Rulings never live only in temporary files or conversation.** The bead append is the durable home. A ratification whose rulings are not on the bead is not landed.
- **The assumption-flag mandate is not waivable by draft quality.** A clean-looking shape with no named scaling assumptions has not met the evidence standard.
