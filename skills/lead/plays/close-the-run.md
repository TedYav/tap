# Close the run

**You own leaving nothing behind: no unfinished work, no live wake, no open obligation, no stranded seat or tree.**

**Use when** the work is delivered or the run is ending, and seats, wakes, obligations and worktrees remain.

**Not when** results are still coming in and need supervision: keep your wake and stay in the run. Close only what this run owns, and hand back what it borrowed.

## Moves, in this order

The order protects work: a wake disarmed early leaves a late return unsupervised, and a tree removed under a live seat is refused or strands it.

1. **Verify the result** against the plan's named artifact, evidence and gate owner; for an authorized landing, confirm the head and the forge's state yourself. A verdict is verified, not verified or inconclusive. Inconclusive is not a pass, and neither is a check that ran on the wrong surface or commit. For checks on code, cite the tested commit, the counts and the verbatim result, including the failing assertion when the verdict rests on a red check. For other artifacts, cite their version and the evidence their gate requires. Rely on gates the author did not run: under completion pressure, self-assessment drifts toward the claim at every tier.
2. **Account for every seat** you staffed: done, replaced, or absorbed into another seat's scope.
3. **Each closing seat finishes or hands over** its unfinished work and custody, answers what it owes, and settles its own mail. Settling a message is not finishing the task. A successor's acknowledgement transfers the work, not an ask addressed to the closing seat. *Worked:* the seat's own `tap poll` is empty, so every ask addressed to it is answered, or its remaining mail is named for forwarding in step 6. Its `tap outstanding` shows no ask still awaiting a result: each one is collected, or has a verified return route to the successor, before ordinary removal, because a reply to a departed seat is recorded and never delivered. Outbound notes need not hold the seat.
4. **Follow up** with the sender of any ask still unresolved. Keep wake coverage until every return is settled or has an accountable owner with coverage.
5. **Stop the wakes this run armed,** once nothing depends on them: your own scheduled wakes and loops, and `tap watch off` only for a watch this run owns, confirmed with `tap watch status`. Leave a borrowed team watch with its continuing owner.
6. **Release the seats** this run owns, by name: `tap crew shutdown <crew>` for a crew, `tap down <seat>` then `tap out <seat>` for a team seat. Plain removal cancels the seat's unsettled inbound, so an open ask from any sender disappears unanswered: use it only on an empty inbox, and otherwise hand the mail to a successor on the same team with `tap out <seat> --forward-to <successor>`. A crew dismissal can refuse while obligations are visible; go back to step 3.
7. **Reclaim worktrees** only after their seats are gone: `tap worktree check <path>`, then `git worktree remove <path>` on a reclaim verdict. `/tap:drive` owns the detail.
8. **Return the `leader` role** (`tap role <your-handle> --unset`) and close tracking items.
9. **Report** in your own words from evidence you read: what was delivered against the goal, each gap and dropout beside the results, what was dropped and why, and the decisions waiting on the owner. Quote a delegate only as a claim you checked.

## When it fails

- A crew dismissal refuses on open obligations: the crew seat settles them. You cannot read another seat's mail for it.
- A worktree check says keep: the tree holds unmerged or uncommitted work. Find its owner; do not force it.
- A wake outlives the run and wakes someone into a finished board: find it and stop it.

## Exit evidence

No seat, wake, obligation or tree of this run is unaccounted for, and the owner has the report.
