---
date: 2026-08-09
source_run: tap-i2nu.
  The evidence behind the rules was a flipped hash guard, a scoped eval, and a boundary a solo
  apply would have shipped wrong. The mechanics below follow this repo's `/tap:discuss` ledger
  (`skills/discuss/scripts/ledger.sh`).
contract: convergence-loop/draft
packet_extensions: []
---

# Convergence loop — two decorrelated seats converge on a drained ledger

DRAFT — surfaced as draft in any shelf selection until ratified to /v1 after at least one live rep
in this repo. `packet_extensions` is deliberately empty: the loop rides TAP payloads between two
seats, not lead packets; schema promotion is a /v1 question decided from the live-rep record.

Transport is **not restated here**. `/tap` owns poll-first, settle-what-you-handle,
end-the-turn-and-let-the-courier-wake-you, and `tap outstanding` before rest. This routine is
only the convergence logic layered on top: what makes two seats' agreement mean something.

## Goals

Run a bounded, decorrelated loop between two seats — over a plan, a review, or one bounded
question — until a **driver-owned issue ledger drains**. Two seats from different model
families catch what one cannot; that counterpoint is the entire value, and without it you are
talking to a mirror.

Use it when the artifact is contested, the stakes reward a second lens, and you want the
disagreement itself on the durable record rather than silently resolved inside one seat's
head.

## The convergence definition (MUST — the invariant the routine exists to hold)

**Convergence is the ledger draining. It is never both seats sounding satisfied.**

Every finding, objection, and open question enters the ledger as an item. The loop converges
when every item is dispositioned — resolved, rejected with a recorded reason, deferred, or
escalated — and no proposal from the peer is still unfolded. A peer saying "looks good" is a
*propose-close*, not convergence; the LEADER reading the thread and feeling aligned is not
convergence either.

The reason this is an invariant and not a preference: mutual satisfaction is the one
convergence signal that gets cheaper the longer two agents talk. A drained ledger costs the
same on round one and round eight.

## Driver and peer — the propose → fold asymmetry (MUST)

The loop is **asymmetric on purpose**. Shared state — the ledger, the round counter, the
convergence check — is **driver-owned and single-writer**.

- **The DRIVER is the seat the LEADER appoints** to own this loop's ledger. (The retired
  original derived the role from whoever opened the thread; here it is an appointment, like
  any other lane — the wheel, not the baton.) The driver records findings, folds the peer's
  proposals, dispositions items, and runs the convergence check.
- **The PEER proposes and waits.** Its only influence on shared state is a proposal payload:
  the disposition it wants — accept, reject-with-reason, resolve, defer, escalate — sent as
  its own message, after which it ends the turn. It never writes the ledger.
- **The DRIVER folds** each proposal through the same disposition guard its own entries pass.
  Every disagreement therefore lands in a durable payload before it lands in the ledger, and
  no two writers race the same record.

**Why the asymmetry rather than a symmetric ledger:** a driver that silently applies a
reviewer's findings on its own judgment has thrown away the decorrelation it paid for. The
fold boundary is where the second lens actually enters the record — and it is also where the
anti-sycophancy check below can fire, because a folded reversal passes the same gate as a
first-hand one.

**Provenance rides the proposal.** A folded proposal keeps its payload's sender and payload id.
That header is load-bearing, not bookkeeping: the fold's idempotency bookmark is the payload id,
and the guard below resolves cited evidence against the thread's message index. A bare or torn
payload is reported malformed and not folded — and a malformed message file on the evidence path
fails loud with its path rather than generically.

## Anti-sycophancy (MUST — the one rule with no knob)

**An `evidence_bearing` item that was rejected with reason may be reversed to accepted only by
citing evidence that is new since the rejection.** Not a better-argued restatement of the same
evidence, and not a citation that was already on the table when the item was rejected.

The mechanism is the `/tap:discuss` ledger's `transition` guard (`skills/discuss/SKILL.md`; the
proposal-fold contract is
[`discuss-proposal-turns-tap-frnh6.md`](../../../tap/protocol/coordination/discuss-proposal-turns-tap-frnh6.md)):

1. The accept must carry an `evidence_ref`, and that ref must not already appear as evidence on
   any event up to and including the most recent rejection.
2. The ref must resolve to a real message in the thread's message index — arbitrary strings are
   not evidence — and that message's `at` must be strictly newer than the rejection's `at`.
3. The write stamps the evidence message's id and `at` onto the accept event
   (`evidence_msg_id` / `evidence_msg_at`). Read-time replay rechecks the stamp against the
   event stream, so a forged or hand-edited ledger line fails loud instead of becoming truth.

**A `rejected_with_reason → accepted` transition without qualifying evidence fails loud**, for
the driver's own ops and for folded peer proposals alike: the fold path enters through the same
`transition`.

```bash
ledger.sh transition "$tid" "$item" accepted "$evref" "evidence resolves the rejection" --by "$driver"
```

`--source-msg-id` is the fold's crash-idempotency bookmark: `fold.sh` passes each folded op's
originating payload id so an interrupted re-fold skips ops it already applied. A driver's own
direct op carries none.

**Exempt classes.** Classify each item `evidence_bearing`, `assertion_only`, or `judgment` when
it enters. **`judgment` and `assertion_only` items are exempt** — conceding to a better argument
on a naming call or a structural preference is the point of talking to a peer. Only
`evidence_bearing` claims are guarded, because there "I'm now persuaded" with no new fact on the
ledger is indistinguishable from deference. Do not reclassify an inconvenient item to reach the
exemption. Keep the **evidence separate from the rationale** — the citation is what the guard
reads, the reasoning is what a human reads.

The check fires at the **fold boundary**, so a peer-proposed reversal is validated against the
durable ledger and the bus payload, not against the driver's recollection of either.

**What this proves, precisely** (worth stating because the guard is easy to over-sell): it
proves the cited message is in the thread and carries an `at` later than the rejection. Ordering
is by message timestamp, not by a ledger sequence, and nothing stops a reversing proposal from
citing a message the peer sent for the purpose. A courier-assigned monotonic arrival sequence
would be needed for anything stronger; that property is not claimed here. The guard's value is
that the reversal has to point at something on the record, which a human can then read.

Seats may change their minds freely. What the loop refuses is a *reversal with nothing new
behind it*, because that is the exact shape agreement takes when one seat is deferring to the
other rather than being convinced by it.

## The driver sends the terminal (MUST)

The driver — and only the driver — sends the loop's terminal message: `converged` naming the
specific artifact version it covers, or a decision packet when the loop stops short. A driver
that converges and stays quiet leaves the peer polling a drained thread with no signal to
stop, which reads to a human as an unresponsive seat. That false-unresponsive failure is the
one this routine's ancestor was built to kill; do not reintroduce it.

A `converged` terminal attests that two seats aligned on **a named version** of the artifact.
It is not a freeze, not execution permission, and never a substitute for a human decision —
it is a cited synthesis, subordinate to the evidence it cites. Editing the artifact afterward
is allowed; the terminal simply does not cover the edit.

## Bounded authority — the stop-list

Inside the loop the seats may converge on findings and apply agreed edits. They may **not**
settle any of these on their own authority:

| Class | Why it stops |
|---|---|
| Schema / data-model change | Changes stored facts, not just code — riskier tier, human call |
| Migration | Same, plus it runs against real data |
| Weakening or deleting an assertion, test, or tripwire | Converts a red signal into a green one; two agreeing seats is exactly the wrong quorum |
| Merge | Lands the work; the merge gate is a separate, independently executed pass |
| **Self-mutation of a routing-bearing or shared surface** | A loop editing the surface that routes work — a skill, a charter, a dispatch table, a shared contract — is changing the rules it is being judged by, and every seat downstream inherits the edit silently |
| Scope escalation beyond the brief | The brief is the LEADER's, not the loop's |

Any of these → stop the loop and emit a **decision packet** for the human. Emit the proposed
diff alongside it; never self-apply. This is a prose stop-condition the seats enforce, not a
machine that refuses them — which is why it is listed here in one place a driver can hold in
its head, rather than scattered through the run shape.

## The decision packet — the escalation artifact

The decision packet is what the loop emits when it **cannot** converge on its own authority:
the round bound was reached with items still open, or the stop-list above fired. It is never
a silent give-up.

> **Naming note:** this is unrelated to the `packet` of `references/packet-schema.md` (the
> /tap:lead invocation surface). This one is an outbound artifact addressed to a human; that one
> is an inbound invocation addressed to the LEADER.

Shape:

```
DECISION PACKET — <thread/loop ref> (round <n>/<bound>)

Question: <the single decision the human must make>

Why it's escalated: <round bound reached
                   | bounded-authority wall: schema / migration / assertion / merge / scope
                   | self-mutation of a routing-bearing or shared surface>

Options:
  A. <option> — <decorrelated take: driver's view AND peer's view; where they agree, where they differ>
       evidence: <payload ids / file:line / ledger item ids>
  B. <option> — <take>
       evidence: <...>

Recommendation: <the joint lean, or "split — A (driver) vs B (peer)">

Blocked pending the human's call:
  - <item id>: <what cannot proceed until this is decided>

Open ledger (undispositioned): <the driver's item list>
```

Rules:

- **One question per packet.** Entangled decisions get several packets. A packet asking two
  questions gets one answer and loses the other.
- **The decorrelated take is the value** — show where driver and peer *differ*, not a merged
  mush that reads like consensus. **A split recommendation is a legitimate output**, often the
  most useful one: it tells the human exactly what they are being asked to break.
- **Evidence, not assertion.** Every option cites item ids, payload ids, or `file:line`. An
  option with no citation is a preference wearing an option's clothes.
- **The blocked list is mandatory** — naming what stalls until the answer arrives is how the
  human prices the delay.
- The packet is a cited synthesis: authoritative for "here is what the two seats found and
  where they landed", subordinate to the human's call. The answer comes back as a ledger
  disposition and closes the escalated items.

## Run shape (SHOULD)

1. **Appoint the driver** and name the artifact, the mode, and a round bound. Eight rounds has
   been the working default; resolve a concrete number before a heavy run.
2. **Seed the ledger** — the driver enters the open questions or findings as items, each with
   its evidence class and citation.
3. **Exchange.** Each cycle: the peer reads, reasons, and sends its dispositions as proposals,
   then ends the turn. The driver folds them, disposes its own items, and replies. Transport
   discipline is `/tap`'s, unchanged.
4. **Check convergence** — the driver, each cycle, over **both** planes: is the ledger
   drained, AND is every received proposal folded? Not one or the other.
5. **Terminate.** Drained → send `converged` naming the artifact version. Bound reached with
   items open → send a decision packet. Stop-list fired → send a decision packet immediately,
   without finishing the round.

## Adaptation knobs

| Knob | Default | Notes |
|---|---|---|
| `mode` | `review` | `plan` (items = open questions/objections), `review` (items = findings), `decide` (items = options; output is always a decision packet) |
| `round_bound` | 8 | Reaching it produces a decision packet, never a quiet stop |
| `pivot` | correctness → polish | In `review`: stay on correctness while any evidence-bearing correctness item is open; pivot to polish only once they drain. Gate the pivot on the open-item count, not on feel |
| `freshness` | full pass on round 1 | A fix round may be a focused re-check naming the selected items |

## Mechanization status

Be precise about the boundary, because "it's all prose" and "it's all enforced" are both wrong,
and each mistake is dangerous in its own direction.

**Live in this repo** — the `/tap:discuss` scripts under `skills/discuss/scripts/`: `ledger.sh`,
`fold.sh`, `is-converged.sh`, and `round-count.sh`, covered by
`skills/discuss/scripts/smoke/convergence-ledger.test.sh`. Thread state lives under
`${COLLAB_DIR:-${TAP_HOME:-$HOME/.tap}/collab}/threads/<thread_id>/`.

- The **driver gate**. `metadata.json` declares `opened_by`; every mutator gates at
  `assert_driver` before touching disk, and `is-converged.sh` exits 3 for a non-driver. The
  LEADER appoints the driver, and the driver opens the thread, so `opened_by` records the
  appointment.
- The **anti-sycophancy guard** above, including its read-time replay.
- **Proposal folding** and the **convergence check** over both planes (drained ledger and no
  unfolded proposal), plus the round counter.

This routine used to prescribe a separate, sequence-anchored TAP ledger under
`skills/tap/scripts/ledger/`. It never recorded a live event and was removed; `/tap:discuss` is
the single ledger home.

For transport, follow `skills/tap/SKILL.md`: `tap read <id>` settles notes;
`tap reply <id> -f <answer-file>` answers asks. This supersedes the inline-message
examples in the `/tap:discuss` contract. Seats still own the
judgment in proposals and dispositions and send the terminal convergence or
decision packet.

## Boundaries (MUST NOT)

- No symmetric ledger. Two writers on shared convergence state is the race this shape exists
  to remove.
- No convergence declared from a peer's "looks good", the driver's own read, or a quiet
  thread. Only a drained ledger with every proposal folded.
- No reversal of a rejected `evidence_bearing` item except by citing in-thread evidence newer
  than the rejection and not already on the table, and no quietly reclassifying an
  inconvenient item as `judgment` to reach the exemption.
- No stop-list class settled inside the loop, however confident both seats are. Two agreeing
  agents is not a higher authority than one.
- No silent give-up: the loop ends in a terminal or a decision packet, never in silence.
