# Recover

**You own getting the work moving again, by the cheapest move the evidence supports.**

**Use when** something expected did not happen: a dependency was missed, a send never became a turn, a seat went silent, or the plan's premise broke.

**Not when** nothing is armed to wake you (`cover-liveness`), or a seat is merely quiet while visibly working: a working seat answers once with status, then works.

## Look before you act

Read-only, in this order: what the lane changed (a commit, a push, a PR head, a check run, a receipt); the thing it depends on; delivery state (`tap outstanding <you>`, `tap show <id>`); the pane (`tap peek <seat>`). A status ask restarts an idle seat and interrupts a working one, so look first. Silence, an unchanged head or a process list alone never proves a stall.

## Moves, by cause

- **A parked or spooled send that never became a turn.** `tap resend <id>` re-rings the same message while it is unread; `tap nudge <seat>` submits a sentinel sitting unsubmitted in the composer. Neither types over a human draft: the owner of that pane clears it. `/tap`'s delivery guidance owns the rest. If the work cannot wait, retire the original before its scope goes to anyone else: `tap cancel <id> --spooled` while it is still parked, and confirm the cancellation. If it was delivered first, inspect that seat's work and transfer custody before you dispatch a replacement. *Worked:* `tap outstanding` shows the order read. For a cancellation, `tap cancel` reported success and `tap show <id>` shows the `.cancelled` receipt; absence from `tap outstanding` proves nothing, because settled sends leave it too.
- **An order that was read but is unanswered.** The seat is working or waiting. Check its work; ask once only if the evidence leaves it unclear.
- **A seat waiting on something that already happened.** Tell it, with the evidence. *Worked:* its next side effect.
- **A stuck seat.** Nudge it, split its lane, or seat a replacement carrying consolidated scope: the original brief, every directive since, and the prior seat's report and branch. Liveness outranks custody; "scope-locked and unstarted" is not in progress.
- **A failed attempt.** Retry by cause: a smaller scope after a context limit, the same order after a dropped connection, a different model after a tool error. After two retries, replan around the unit.
- **A base moved under a lane.** The driver owns the update; `../references/base-motion.md` has the recipe.
- **A broken premise.** Stop applying the plan to that work, hold what depends on it, and return the decision to the plan's owner with the evidence and a recommendation. Keep the rest moving.

## When it fails

- The same send spools again: capture what `tap show` and `tap peek` print before any further repair, and give the defect to whoever owns the transport.
- A late result arrives from a replaced seat: check it against the current state and hand anything unique to the seat that now holds the role.

## Exit evidence

A new side effect on the lane, or an accountable owner for the decision that blocks it. Record what failed and what you changed.
