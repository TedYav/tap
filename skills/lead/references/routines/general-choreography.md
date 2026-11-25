---
contract: general-choreography/v1
packet_extensions: []
---

# Routine: general-choreography

The plan-doc chart: take a plan, instrument it, divide it among agents. Reach for this routine
when a mission is a plan doc or a defined step sequence, composing named skills as stages.

**Goal.** Turn a plan into a conducted run: one plan doc that IS the orchestration, waves that
alternate writers, gates that prove review, and a fence that stops relitigation.

## Invariants (MUST)

- **The plan document IS the orchestration.** Peers read one plan doc first; everything they need
  lives in it. The LEADER defaults to implementing nothing before the final gate: a leader-authored fix is legitimate when the
  moment calls for it, and any delivered hunk the LEADER authored moves the whole-diff gate to a
  seat that authored none of the delivered diff.
- **One writer per wave; the OTHER EXECUTOR reviews.** Every gate row names its adversarial focus, so
  reviews are targeted, not vibes.
- **Ratified-decisions fence.** Settled decisions are marked "human-ratified — do not relitigate";
  disputes escalate to the LEADER with evidence, never a mid-wave redesign.
- **File findings forward, never retro-edit a landed unit's spec mid-run** — an executor may be
  working against the old text; an amendment that arrives after its unit landed becomes a follow-up.

## The recipe

- **Instrument the plan:** a Delegation section (roster: handles + roles) then a wave table —
  `| Wave | Writer | Work | Gate (reviewer, focus) |`; a **gate checkbox log** (ticked boxes prove
  review happened, not just implementation); the ratified-decisions fence.
- **Standing briefs, then run dark:** one brief payload per EXECUTOR at kickoff (role, lanes, protocol,
  narrow escalation) so later work orders are one-liners. The lane DRIVER is the dispatcher — it holds
  the plan as its charter, passes the writer token, requests gate reviews, and receives completion
  taps itself. The LEADER is tapped at enumerated checkpoints only, plus a scope change, an incident, an unresolved dispute, a human decision, or a one-way door.
- **Disposition findings:** fix in-scope defects, file unrelated work, and escalate a scope change or unresolved judgment. A `--yolo` flag is not needed for ordinary progress. Review changed bytes; unchanged reviewed bytes carry.
- **The final whole-diff gate** reads source contracts and the integrated diff independently of the plan’s assumptions. A non-author owns it; the leader ensures it is staffed. Inspect the final-head CI receipt and any relevant focused or live proof.

## Rough-todo entry (SHOULD)

Invoked with a rough todo rather than a finished plan, this routine empowers who-does-what judgment
— draft the delegation shape, surface material decisions, and refine it per wave. Do not lock a full wave
table prematurely: early waves teach you the later ones (every wave close is a re-choreography
point, per the `shape-the-mission` play).

## Adaptation knobs

- `assignment_logic` — design-adjacent / heavy-context units → the strongest EXECUTOR (usually the lane
  DRIVER); mechanical, well-leased units → the other. Give EXECUTORS the units their own reviews shaped.
- `checkpoints` — which gates/events tap the LEADER (default: the riskiest gate + all-waves-settle).
- `wave_depth` — wave count and writer-alternation depth.
