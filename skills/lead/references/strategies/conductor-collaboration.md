# Strategy reference — conductor collaboration

A **strategy reference** is a reusable choreography: the roles a run staffs and how each role plays.
It is not a routine (a routine is steps a role runs; see `../routines/`) and it is not **the strategy**
(the per-run document written at kickoff per `/tap:lead` §2). A strategy reference is
**active** when the per-run doc names it under "Active strategy references" — never because the leader
remembers it. Word discipline matters here: a reader who cannot tell which of the three objects is meant
re-derives the routine under load, which is the failure this shelf exists to prevent.

Use this reference when a run has more lanes than a leader can field payload-by-payload and the owner
has staffed a conductor (`/tap:conduct`). Both patterns below occurred in a single run, within four
hours of each other; liveness coverage and sender addressing both matter.

## The two poles this strategy sits between

**Absent.** A leader can report a healthy board when the check only asks whether someone is working,
even while every driver is at its prompt and one lane has gone five hours without dispatch.

**Omnipresent.** The leader then received about forty-five routine payloads in two hours — read-backs,
receipts, and role confirmations — because orders had gone out under the leader's name. The address on
the envelope bypasses the conductor's triage layer, regardless of which seat performs the work.

The strategy is a small set of role invariants that keep the leader between those poles, with the
addressing and the coverage done by mechanism rather than by memory.

## Role defaults

Leaders design the mission and decide typed escalations; conductors coordinate the round-loop; drivers finish their lanes. Adjust routine role placement when it helps the goal, using AGENTS.md’s staffing and autonomy rules. Authorship still excludes a seat from its own independent gate.

## Roles and how each plays

### Leader

- **Holds strategy, vision, and planning.** Writes the per-run strategy doc, rules the typed classes,
  adjudicates. **Does not act on routine content.** A routine payload that lands on the leader is read
  only far enough to classify it, then handled as its own envelope requires — settle a settle-only
  note, answer a `reply=expected` one with a pointer rather than a ruling — and its substance goes to
  the conductor as a **new** message carrying the body or a path to it. The sentinel itself is never
  forwarded (TAP refuses that, and a forwarded sentinel settles nothing).
- **Owns the hopper.** One leader-owned Markdown file in the run directory (`tmp/<run>/hopper.md`),
  one row per lane: pair, current item, next items in preference order (finish this ladder → the lane's
  own parked P1 → a salvage or drain PR → a domain P1 → P2 or the wire), bead id, branch-from, tier. A
  row is planned enough to hand off when it carries the goal, relevant controls, material risks, and tier — the
  leader's planning, done once per row, never re-derived by the driver. The hopper is planning state,
  not transport state: no verb, no schema, no generated index (revisit if a second run needs the same
  parser).
- **Addresses orders so answers land on the conductor.** Every leader-authored order carries
  `tap send <seat> --ask --reply-to <conductor> -f <body>`; `tap reply` from the driver or partner then
  lands on the conductor by construction ([reply routing](../../../tap/protocol/messages/reply-expectation-v0-3-part-03.md#reply-routing-reply_to-tap-ywb-v05); the flag works for attended seats).
  The leader keeps authoring under the leader's own name — that is planning — and a wedged conductor
  delays answers, never dispatch. A body line saying "answer to the conductor" is a human hint, not the
  mechanism: it failed for its own author on 2026-09-03 because the recipient reads the body after the
  obligation has already landed on the wrong seat.
  The flag is the leader's, not the conductor's: an order the conductor sends carries no `--reply-to`,
  because replies to a sender already land on the sender, and `--reply-to <yourself>` is refused.
- **Runs the tick.** A `/tap:self loop` (30–45 minutes) whose prompt names the active strategy reference
  and the per-run doc and re-reads both each fire. The tick is the upper bound on staleness; the
  conductor is the lower bound. A `/tap:self goal` is the wrong tool for supervision — it re-fires on every
  stop and pulls the checking back onto the leader's seat.
- **Decides typed escalations.** `/tap:conduct` uses AGENTS.md’s SCOPE, INCIDENT, ADJUDICATION/human_decision and one-way-door classes. Routine staffing and base moves stay with the responsible seat; a queue that needs a new goal or an outage that defeats available staffing needs the leader’s decision.

### Conductor

- **Batches milestones and routes typed decisions.** Coordinate reviews and ready work; the driver owns squash and primary sync when AGENTS.md’s merge-ready conditions hold.
- **Refills ready lanes.** Dispatch the next scoped item when its driver completes. A working seat’s silence is not an idle lane. Ask the leader for a new objective when the queue is wrong or exhausted.
- **Tracks CI receipts.** Each PR runs its CI full independently at the candidate head. No local suite slot, process census or grant is needed.
- **Records merge conditions on the PR.** A blocking condition must be visible beside the diff. `FIX-AND-SHIP` comes from the assigned reviewer, and its non-author acceptance check still applies. Computed byte identity carries reviews; the final head gets its own CI receipt.
- **Digests carry per-lane state.** Name the bead or PR, current work or actual dependency, and new evidence. Avoid repeated status requests to a seat that already reported it is working.

### Drivers and partners

- Drivers use `/tap:drive`; live pairs also use `/tap:pair`. Route ordinary reports to the conductor and resolve peer questions directly. A typed decision can reach the leader without a second permission step.

## The tick (the one procedure)

The only fragile step is the leader's tick, because it fails silently. It is numbered so a fresh
instance can run it after a compaction without re-deriving it.

1. Poll every payload addressed to the leader and settle each one as its `reply=` field requires.
   Answer only typed classes on their merits. For the rest, send the conductor a **new** message with
   the body or a pointer to it — never the sentinel — and settle the original.
2. Read the conductor’s latest digest and the assigned work. Classify BUILDING from a current task or review in flight, WAITING from a named dependency, and IDLE from completed work with no assignment. A quiet bus or unchanged head alone does not establish any of those states. Inspect a pane only to resolve a concrete uncertainty.
3. Read each active monitor's last complete sample and record `monitor heartbeat age: <handle> <age> / <limit>`, with its cycle and status. Name starting, missing, invalid, stale or declared waiting/closed explicitly. Follow the [monitor protocol](../../../tap/protocol/supervision/monitor.md) for recovery; a quiet bus or an armed scheduler is not a sample.
4. Refill an IDLE lane from its ready queue; decide a new objective when that queue is exhausted.
5. Send one note for changed assignments or decisions. If nothing changed, one line suffices.

## Persistence across context loss

The active strategy is a **named thing the run carries, not a memory**. The datum is the per-run
strategy doc's "Active strategy references" field; the loop prompt names that doc and re-reads it every
fire. That survived a leader compaction on 2026-09-03 with the handoff carrying nothing extra. Two
stronger mechanisms are parked with revisit triggers in the thread ledger: a seat-registry strategy
field printed by the SessionStart hook (trigger: an active strategy is lost across a compaction or
restart despite the loop prompt), and a conditional per-turn hook that fires only when routine payloads
pile up on the leader (trigger: the forty-five-payload episode recurs with `--reply-to` in use). An
unconditional per-turn injection is the class TAP already removed (tap-hx4r).

## What this reference deliberately does not add

A second conductor (measured worse). A leader-side sentinel that reads every payload.
Lanes in the protocol (ruled against). A `tap census` verb or a `tap hopper` verb until a
second leader needs the same output. Harness recovery steps (a typed-but-unsubmitted sentinel on
one harness, for instance) — those are courier defects with beads, not strategy content.

## Activating it

In the per-run strategy doc, under the planned-adaptations section: `Active strategy references:
conductor-collaboration`. In the conductor's charter (`/tap:conduct` `references/charter-template.md`):
the optional "Active strategy references" field naming the same file, so the two seats read one text.
In the leader's loop prompt: the reference's path and the per-run doc's path.
