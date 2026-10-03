---
date: 2026-07-19
source_run: tap-qxft
contract: compounding-close/draft
packet_extensions: []
---

# Routine: compounding-close

**Goal.** Plate what a non-trivial run actually learned without garnishing the close with empty
artifacts. The run leaves one durable learning and an honest account of unresolved work.

## Selection (SHOULD)

Select this routine when a run produced reusable learning or when the mission names compounding as
an exit condition. Do not add it to a mechanical one-line change merely to manufacture ceremony.

## Invariants (MUST)

- Author from the on-disk run record, scribe log, or setlist record, never conversational memory.
- Obey the repository's existing compounding convention first. Machine ingest supplements it; it
  never replaces it.
- Before claiming the selected run closed, atomically land one drop that satisfies
  `../ingest/README.md`, including a durable evidence anchor and the privacy boundary.
- Verify every cited promotion artifact and open-work bead exists at the named revision or path.

## Exit contract (MUST)

Report exactly two classes:

- **Learning:** one required `~/.tap/ingest/<drop>.md` reference. Add promotion references only for
  promotions actually made; omit destinations that did not fire.
- **Open work:** exact bead references, or `none — <reason>` when no unresolved work remains.

The ingest drop captures the learning once. Promotion references point to derived artifacts rather
than restating it.

## Judgment destinations (SHOULD)

These are destinations, not mandatory disposition rows:

- **Calibration append:** when evidence changes a seat-routing or mitigation prior, add a dated
  observation under that seat in `~/.tap/seat-calibration.md`.
- **Repository compound:** when the learning meets the repository's own bar, run its established
  solution, documentation, or retrospective path.
- **Routine candidate:** when improvised choreography is repeatable, take the on-disk record through
  `../routine-authoring.md` and its normal branch-and-PR gate.

Open beads only for real unresolved work. Empty calibration, repository, and routine rows are not
evidence and do not belong in the close.

## Recipe

1. Read the on-disk record and identify the smallest reusable observation.
2. Choose only the promotion destinations the evidence earns.
3. Write one complete ingest drop to a temp file inside `~/.tap/ingest/`, then rename it to the final
   unique filename from the ingest contract.
4. Verify the drop and every cited reference on disk; report the two exit classes.

## Recursion guard

Closing compounding-close does not recursively require another compounding-close. Record failures
found during this close in the current drop and, when unresolved, in the open-work bead references.
