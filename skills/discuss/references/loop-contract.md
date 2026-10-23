# /tap:discuss loop contract (convergence mechanics, TAP-native)

Loaded just-in-time by the `/tap:discuss` orchestrator. The loop is **deterministic**: agents decide content (is this finding valid? my counter?), but every control-flow decision (pending? converged? escalate?) is a mechanical check against ledger/proposal/round state — never an LLM vibe. A status change without explicit agreement visible in the thread is a protocol error.

Transport is TAP (`tap send`/`reply`/`read`/`poll`/`outstanding`/`nudge`); the driver-only ledger/convergence helpers live under `skills/discuss/scripts/` and each requires the driver's `--by <handle>` (a live pane's `tap whoami` handle). The handle is the only identity the ledger keys on; TAP separately stamps a per-row `instance` on payloads and filters settlement by `(handle, instance)`, so a restarted driver keeps its thread role but not its predecessor's unsettled mail (see SKILL.md Prerequisites).

## Round 0 — blind seed, then candidates

The first driver payload is an ask with the thread, mode, round cap, question,
sources and relevant on-disk state. It requests each peer's own gap list or
position; with several peers, the same body goes to each. It contains no driver
candidates or review findings, including in a linked briefing file. The review
target itself remains available as evidence. Each peer sends one
`tap reply <seed-id> -f <position.md>` with its independent view.

Only after every reply lands (or the driver records a coverage decision for a peer
that has not answered, SKILL.md § n peers) does the driver send the second ask,
containing its candidates, triage questions and, with several peers, every
position. Each peer answers that ask with one proposal turn. If candidates were
already exposed to a peer, record that limit instead of claiming a blind pass. These two seed payloads span different turns because the second depends on
the peer's reply; they comply with `/tap`'s batching floor. No round-counter
change is needed: seed at round 0 and increment after each proposal/response cycle.

## Critical path — read this first

**The one rule: poll the inbox before you speak or rest; never rest while you owe a reply or a terminal.** TAP replaces active-wait watchers with a courier: after you send, you END THE TURN and the courier re-invokes your pane when the reply arrives. So there is no listener to arm and no sleep to schedule — the discipline is entirely "poll before you speak, drain before you rest." The checklist makes you not _want_ the bad transition; the ledger sink _refuses_ a non-driver write outright. Both exist because soft guidance alone has failed in practice.

### MUST — invariants (skipping one IS a known failure mode)

- **Poll first, every entry.** On any pane wake or fresh turn, run `tap poll <me>` BEFORE saying anything about your inbox or going idle. Never narrate inbox state you have not just polled this turn.
- **Settle what you handle.** After acting on an inbound payload, `tap reply <id> -f <file>` answers an ask and settles it in one; `tap read <id>` settles a note. An unsettled inbound is unfinished work, not a read receipt.
- **Re-poll at the rest boundary.** Immediately BEFORE ending a turn to rest, re-run `tap poll <me>` for unhandled mail; if you are the driver, also fold any unprocessed proposal file (`fold.sh`). Work can arrive mid-turn, so poll-first-at-entry is not enough. If anything appears, handle it and do not rest (fail closed).
- **After a reply-expecting send, END THE TURN.** `tap send`/`tap reply`, then stop — the courier wakes your pane on the peer's reply. NEVER poll-sleep, busy-wait, or loop on `tap poll` inside one turn. Ending the turn IS how you wait; the golden rule ("after you send, END YOUR TURN") is the whole wait contract.
- **Drain before you rest.** Before any rest, run `tap outstanding <me>`. An entry you owe (an unanswered inbound, an unsent terminal, an unfolded proposal) is work. An entry a peer owes you (your ask awaiting its reply) is what the courier wakes you for: note it and end the turn. Do not go dormant with work you owe.
- **Driver: fold before a ledger-dependent reply or terminal.** Fold the round's pending proposals, in one invocation, through the ledger guard before any reply/`converged`/`decision_packet` whose content depends on ledger state — otherwise the anti-sycophancy check never runs on a peer's reversal and the terminal reports a stale ledger. A `CONFLICT` you have not adjudicated and disposed keeps the thread open.
- **Driver sends the terminal.** If you opened the thread, you send the `converged`/`decision_packet` to every peer — never leave a peer to time out (L8). Convergence is `is-converged.sh` exit 0, not a peer saying "looks good."
- **Silence is not death.** On a quiet pane, do NOT declare the peer dead. `tap nudge <peer>` once to re-submit a stuck sentinel, then re-poll on the next wake. Escalate to the human only after repeated quiet cycles — and keep polling.

### SHOULD — strong defaults (skip only with a stated reason)

- Surface to the human after ~2 quiet cycles (a `tap nudge` that draws no reply, twice) — but keep polling on each wake; escalation _adds_ a human alert, it never means "stop listening."
- Prefer `tap reply <id>` over a bare `tap send` when you are answering an inbound — it settles the payload for you, so you cannot leave a dangling unsettled inbound.

### BONUS — nice, not load-bearing

- A short status line to the human when you rest ("converged thread `t`, peer has the terminal"); adaptive cadence tuning of how eagerly you nudge.

### Tempting thought → what to actually do

| Tempting thought | What to actually do |
| --- | --- |
| "I sent my message, my turn is over." | Sending ≠ done. For a reply-expecting send, ending the turn IS the wait — but run `tap outstanding <me>` first, and rest only when every remaining entry is one a peer owes you, not one you owe. |
| "Nothing's probably arrived yet." | Run `tap poll <me>`. Never narrate an inbox you have not just polled this turn. |
| "I'll poll in a loop until it replies." | Never poll-sleep. `tap send`/`reply`, then END THE TURN — the courier re-invokes your pane on the reply. |
| "I'll rest and re-check next turn." | Re-poll at the rest boundary; driver also folds any unprocessed proposal. If anything is pending, handle it and do not rest. |
| "The peer said 'done,' so we're done." | Only `is-converged.sh` exit 0 plus a sent terminal is done. A peer's "done" is a propose-close, not convergence. |
| "It's quiet, so the peer is dead." | `tap nudge <peer>` once, then keep polling; surface to the human after repeated quiet cycles. Silence is not death. |
| DRIVER-DORMANCY: "I folded the proposals and sent my turn — I can rest." | Driver: run `tap outstanding <me>` and re-poll first. An entry you owe means you still owe the terminal or supervision. A driver that sends then rests without this check is surfaced, not silently dormant — that dormancy is the exact hole this row closes. |

## Handles, thread, role (role is derived, not symmetric)

- `me` = your handle (`tap whoami`, e.g. `claude` / `codex`). `peer` = each other participant; with several, the driver lists them in `metadata.json` `peers` (SKILL.md § n peers).
- `thread` = the `thread_id` for this collaboration. The **driver opens it** by writing `threads/<t>/metadata.json` with `{"opened_by": "<me>"}` (plus the `messages/` and `proposals/` subdirs). That `opened_by` handle IS the driver identity every sink checks. The peer **adopts and echoes** that thread_id on every message; it never mints a parallel id.
- `role` is **derived from `opened_by`**: the **driver** is whoever opened the thread and owns its shared state; the other agent is a **peer**. This is asymmetric, not symmetric — see below.

## The driver/peer asymmetry (the load-bearing structure)

Shared thread-state — the **ledger**, the **round counter**, and the **convergence check** — is **driver-owned and single-writer**. The sink rejects a non-driver:

- **Driver** writes the ledger (`ledger.sh add|transition|list`), folds proposals (`fold.sh`), bumps the round (`round-count.sh --increment`), and runs convergence (`is-converged.sh`). All require the driver's `--by <handle>`, which must equal the thread's `opened_by`.
- **Peer** does **not** call `ledger.sh`, `is-converged.sh`, or `round-count.sh --increment` — each rejects a non-driver at the sink (`is-converged.sh` exits **3 = ERROR**, not a silent OPEN). The peer's ONLY influence on shared state is to **propose**: write all of the turn's ledger ops and reasoning to one file, then use `tap reply <driver-ask-id> --expect-reply --kind proposal -f <turn.md>`. With no inbound ask, use `tap send <driver> --ask --kind proposal -f <turn.md>`. Continue independent useful work, then yield for the response. Use `-f`, never `-m` — a `rationale` field is free prose that routinely quotes command names, and the composing shell evaluates backticks and `$(…)` inside `-m` before `tap` sees the argument. The driver folds the proposal through the same ledger guard.

A peer that needs to know convergence reads the driver's terminal `converged`/`decision_packet` message, never the gated check. (If a peer-visible read-only convergence view is ever genuinely needed, that is a new seam to design — do not build a speculative one.)

## Pending detection (state-based, not a blind timer)

1. `tap poll <me>` — anything unsettled is **immediate work**. Handle it, then settle (`tap reply` for an ask, `tap read` for a note).
2. After a reply that expects an answer → END THE TURN. The courier wakes you on the peer's reply; that is the entire wait.
3. Otherwise (nothing pending, nothing expected, no unsettled send per `tap outstanding <me>`) → rest: the pane goes idle and is re-invoked on the next inbound.

## The disposition step (driver-gated propose → fold)

The peer's Markdown body names the thread and explains its position, with exactly
one fenced `json` object containing a non-empty `ops` array. The raw object form
also works. Each array element is an `add` or `transition` object; see
`SKILL.md` § One proposal payload per turn for the full example and fields:

```json
{"ops":[
  {"op":"transition","item_id":"F1","new_status":"accepted","rationale":"source confirms it"},
  {"op":"add","item_id":"F2","status":"proposed","evidence_class":"judgment","evidence":"source.md:12","rationale":"new question"}
]}
```

All declared fields are strings; `add` requires `item_id` and `evidence_class`
(`status` defaults to `proposed`), and `transition` requires `item_id` and
`new_status`. The ledger retains its status/class and reversal-evidence guards.
Legacy raw single-op JSON objects keep working under their existing payload ID.
Multiple `json` blocks and empty batches are refused. A turn with no operations
uses an ordinary reply rather than an empty proposal.

The proposal is one ask for the whole turn. When it answers a driver ask, use
`tap reply <id> --expect-reply --kind proposal -f <turn.md>` to settle that inbound
and request one response. Otherwise use `tap send <driver> --ask --kind proposal
-f <turn.md>`. The driver replies once with the per-op fold receipt plus its
substantive response or terminal. A continuing response uses `--expect-reply`;
a terminal does not. There is no second acknowledgement or one-receipt-per-op loop.

The driver saves the complete canonical payload under
`threads/<tid>/proposals/<id>.md`, keeping its frontmatter. `fold.sh <tid>
<proposal-file>… --by <driver>` verifies the copy's body, from, kind and from_team against the
canonical `path`, then derives time from the matching courier `.placed` receipt's
high-resolution mtime. Neither a supplied `at` nor a chosen payload ID proves
freshness. A damaged copy is repaired by recopying the canonical bytes.

The fold applies ops **in array order** through the same ledger guard, stopping
the payload at the first malformed or rejected op. Each successful op stamps
`<payload-id>#<zero-based-index>` as its ledger `source_msg_id` and its bookmark in
`processed_payload_ids`. `#` cannot occur in a TAP payload ID. Evidence still names
the original message, never an op bookmark, and a batch cannot cite itself as new
reversal evidence. A whole-payload bookmark is written only once every op applied.
The fold receipt names each applied, rejected, malformed or skipped op; an
unattempted tail remains pending and the fold exits nonzero.

When `peers` is declared the fold also preflights the batch. Two senders moving
one item to different statuses in one invocation, or a payload contradicting an
event folded after the payload was placed, is a `CONFLICT`: none of those ops applies, each is reported with the other senders'
positions, and they stay pending; like a rejected op, a conflict stops its payload's
ordered tail. The driver adjudicates with its own transition citing both op keys,
runs `dispose.sh <tid> <payload>#<i> --reason <text> --by <driver>` for each
conflicted op, and re-folds so the tails resume. The reason lands in
`threads/<tid>/dispositions.ndjson` before the op's bookmark, and `fold.sh` and
`is-converged.sh` read both, so a crash between the two writes still recovers.
`dispose.sh` disposes only an op a fold has refused (fold records each rejected or
conflicted op in `threads/<tid>/refusals.ndjson` before reporting it), holds the
saved copy to fold's provenance bar (body, from, kind and from_team equal to the
canonical payload, with its placed receipt), refuses a blank reason, and every
reader validates each record (this thread, this driver, the op's payload, a reason;
disagreeing records for one op fail loud). Disposing closes processing of one op, never the
finding behind it; a duplicate add whose content already landed under another
sender's id is disposed the same way, and its tail resumes on re-fold. When `peers`
is declared, an `add` must use the sender's `<alias>-` prefix and a sender outside
the map cannot add. A thread without `peers` keeps free-form ids and
last-writer-wins, exactly as before: every n-party rule is switched on by `peers`.

This is ordered partial application, not a rollback transaction. Re-folding uses
both the validated ledger source stamps and the bookmark file, so a crash after
append but before saving the file does not duplicate an op. A state-dependent
rejection can resume when its prerequisite is satisfied. A malformed canonical
body remains a failure to repair or escalate; do not delete or mark it complete.
`is-converged.sh` checks these same per-op markers: a closed ledger with an
unapplied tail is still open, and an unreadable proposal is an error.

## Escalation (quiet ≠ dead)

On a quiet pane, do NOT declare the peer dead:

- `tap nudge <peer>` re-submits a sentinel already stuck in the peer's input box — the first recovery move, not a general wake. Then re-poll on your next wake.
- After ~2 quiet nudge cycles, surface to the human ("peer `codex` unresponsive on thread `t` for N cycles") — but keep polling. Surfacing _adds_ a human alert; it never means stop listening.
- The only thing that ends the loop is a **sealed convergence** — the driver's terminal sent and the ledger drained (`is-converged.sh` exit 0), or a `decision_packet` at the round cap. A quiet window is never a shutdown.

## Termination (deterministic; driver-only)

Each cycle the **driver** bumps the round (`round-count.sh <tid> --increment --by <me>`), then runs `is-converged.sh <tid> <round-cap> --by <me>`:

- exit 0 (converged: ledger drained AND no unprocessed proposal) → account for participation (SKILL.md § n peers), then send the terminal `converged` naming the artifact version to every peer (a reply to each open ask, a note otherwise), then stop.
- exit 2 (cap reached, items still open) → assemble a `decision_packet` (see `decision-packet.md`) and send it to every peer; stop. Never silently give up.
- exit 1 (open) → continue: fold any pending proposals, reply with your turn, END THE TURN, loop on the next wake.
- exit 3 (ERROR) → a non-driver tried to enumerate convergence, or thread state is unreadable — an unreadable ledger, or an unapplied proposal that cannot be parsed. Fail loud, never treat as OPEN: an unreadable proposal is a teammate's disposition that has not been recorded, and converging over it discards their dissent. Repair it and re-fold at the same path and id; if it cannot be repaired, ask the sender to re-send, and if neither is possible escalate it as a `human_decision`. **Deleting the file is not a disposition** — it is the same content loss the bookmark-on-failure defect caused, spelled differently, and it leaves no record that a proposal existed.

`is-converged.sh` defaults `round-cap` to 8 when the argument is omitted; pass an explicit cap (`--round-cap N` at the skill boundary) to tune it. Resolve a concrete cap before heavy use.

## Always send the terminal message (L8)

The **driver** converges and MUST send the terminal `converged`/`decision_packet`. Otherwise a peer keeps polling a drained thread with no signal to stop — the exact "30-min, moving on" false-unresponsive failure this convergence engine exists to kill.
