---
name: discuss
description: "When co-reviewing finished plans, reviews, or decisions, bound adversarial convergence in a driver-owned issue ledger."
argument-hint: '[plan|review|decide] [--thread ID] [--round-cap N] [CONTEXT...]'
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, Skill
---

# /tap:discuss — the TAP-native convergence engine

> The bracketed cross-reference codes (`KD*`/`F*`/`L*`) are provenance footnotes from this skill's original design work in another repo; the prose here is self-contained and does not depend on them. They are kept because they make the dogfood receipts traceable for anyone who goes looking, not because the documents are reachable from this one.

`/tap:discuss` runs a bounded, adversarial loop between a driver and one or more peer CLI agents over `/tap` until they converge — measured by a **durable issue ledger draining**, not by the agents sounding satisfied (L7). Transport is the dumb TAP bus (`tap send`/`reply`/`poll`/`done`/`outstanding`); this skill is the convergence loop on top of it, plus a driver-owned ledger that makes agreement mean something. TAP moves messages and wakes panes; it decides nothing about convergence — that logic lives here (KD6).

**Why it exists:** independent models can catch errors a single model misses. In practice, joint review has corrected a hash guard, narrowed an evaluation, and resolved an existing-system boundary that individual application would have shipped incorrectly (L13). The benefit comes from peers reaching their own judgments before comparing them.

## Prerequisites

You and each peer are registered TAP seats (`tap in` — see `/tap`). `tap whoami` is your handle; you pass it as `--by` to every ledger mutator, and TAP derives `--from` from your registered pane. The handle is the only identity **this skill** carries — thread roles, ledger writes, and `--by` are all keyed on it alone.

TAP itself carries more, and the difference matters here. Under v0.20 a registry row also holds an opaque `instance` (one row lifetime), and sends stamp `recipient_instance`/`sender_instance` on the payload; settlement and `tap outstanding` filter on `(handle, instance)` when those stamps are present. So a **fresh same-handle seat begins with an empty obligation set** — it cannot settle mail addressed to its predecessor.

Two corrections to the assumptions this skill arrived with:

- **A team is not a worktree.** Seats on one team routinely occupy different worktrees, which is why thread state is rooted outside any checkout (see State home). A cross-team peer is addressable as `<team>/<handle>`.
- **The handle names a seat, not an instance.** A seat survives a clear, a restart, and a compaction, and comes back with the same handle and none of the conversation context. So the thread's `opened_by` keeps identifying the right *address* across a driver restart, and the restarted driver is still the driver — but the agent at that address may not remember the loop, and per the instance stamping above it also cannot settle the mail its predecessor was holding. Durable state is the ledger, not the driver's recollection: a returning driver reads the thread rather than resuming from memory, and re-asks the peer for anything that was in flight rather than assuming a pending reply will still land.

## State home

Thread state lives under `$COLLAB_DIR` (env override, must be absolute) → default `${TAP_HOME:-$HOME/.tap}/collab`. **That `collab` is deliberate and is not a leftover:** the skill was renamed to `/tap:discuss` as a routing change, while the state home, `COLLAB_DIR`, and the ledger scripts' internal names kept their spelling — renaming those is a state migration reaching every open thread on every bus. Do not "fix" it here without migrating `ledger/lib.sh` and the `tap team reset` component row with it. Everything below — the ledger, round counter, folded proposals — resolves under `$COLLAB_DIR/threads/<thread_id>/`.

The root is **outside any checkout on purpose**. A driver and peer routinely sit in different worktrees, and a repo-relative root would give them different state — the peer could not read the thread it was invited to. Rooting at TAP's home means one root per machine regardless of worktree, and it puts thread state where the bus already lives. It is also out of reach of `git clean`.

## Roles — driver and peers (derived, not symmetric)

Role is **derived from who opened the thread**: the **driver** is the handle recorded in `threads/<id>/metadata.json` `opened_by`; every other agent on the thread is a **peer**. The loop is **asymmetric**: shared thread-state (the ledger, the round counter, convergence) is **driver-owned, single-writer**. The driver folds, drains, and checks convergence; **peers propose and wait**. A peer cannot write or even enumerate the ledger — `ledger.sh`/`is-converged.sh`/`round-count.sh --increment` reject a non-driver at the sink (`is-converged.sh` exits 3). The peer's only influence on shared state is a proposal payload the driver folds. Only the seed and these gated mutators differ; the poll/act/reply rhythm is shared.

**Open the thread (driver, once):** establish the thread by writing its metadata — this is what makes you the driver.

```bash
tid="<thread-id>"                       # e.g. discuss-2026-07-08-plan
me="$(tap whoami)"
d="${COLLAB_DIR:-${TAP_HOME:-$HOME/.tap}/collab}/threads/$tid"
mkdir -p "$d/messages" "$d/proposals"
printf '{"opened_by": "%s"}\n' "$me" > "$d/metadata.json"
```

Every ledger/convergence sink reads `opened_by` and rejects a writer whose handle does not match. A peer never mints a thread id — it adopts and echoes the driver's `<thread-id>` on every message. With more than one peer, also write `peers` into the metadata (next section).

## n peers — an ad hoc mini team

One thread, one driver, any number of peers. The initiator opens the thread and is its driver for the thread's life; there is no driver transfer, and a different ledger owner means a new thread. A team leader who joins as a peer carries peer weight only: leader authority covers charter changes and one-way doors, raised outside the ledger, never an item's disposition. Everything here is additive and switched on by `peers`; a thread with one peer and no `peers` field behaves exactly as before.

- **Declare the participants.** At open, write `peers` into `metadata.json`: a map of handle to a hyphen-free alias, the driver included, e.g. `{"opened_by":"lead","peers":{"lead":"lead","astra-nparty":"astra","argon-nparty":"argon"}}`. Every `add` on the thread then uses `<alias>-N` (`astra-1`, `lead-clean`); `fold.sh` refuses an add under another alias or from a sender outside the map, so ids cannot collide. Map a late joiner before folding its payload. One claim per add: a bundled item cannot be half accepted. The seed may give each peer one optional lens line (what to look at first); a peer may counter it, and it never limits what a peer may raise. Identity limit: the fold verifies the bare `from` handle only (a cross-team payload also carries a courier-stamped `from_team`, which this contract does not key on), so do not seat two peers that share one bare handle on one thread.
- **Seed every peer blind, reveal once.** Send the same round-0 ask to each peer. Reveal your candidates and every position together, only after each peer has answered or you have recorded a coverage decision for one that has not (below). A late reply is accepted and labeled not blind; a peer who had already seen your candidates is recorded in `threads/<tid>/exposure.md`, and its position counts, but not as a blind pass. Peers do not read each other's positions or the thread directory before the reveal; the files cannot enforce that, so say it in the seed.
- **One round, one fold.** A round is one driver turn, the replies it requested, and the driver's fold and synthesis. Increment the counter once per round, never per peer or payload, so the cap means the same at any n. Collect the round's proposals and fold them in one `fold.sh` invocation; the fold applies them in courier placed order.
- **Contest, then adjudicate.** When senders move one item to different statuses in one fold, or a late payload contradicts an event it could not have seen, `fold.sh` reports a `CONFLICT` and applies none of those ops; the item keeps its status. Like any unapplied op, a conflict stops that payload's ordered tail, because a later op may rest on its premise. Decide on substance, not count: write your own transition with a rationale citing both op keys, run `dispose.sh <tid> <payload>#<i> --reason <text> --by <me>` for each conflicted op (it disposes only an op a fold has refused), then re-fold so the tails resume and the thread can converge. Same-status transitions from several peers all apply, so each seat's agreement stays on the record. A peer does not accept its own finding; it may withdraw or defer one it raised, and the clean-result record's add and close travel as one batch by design. Self-acceptance never supplies another seat's agreement. Omitting an item from a payload is abstention, not assent.
- **Account for participation.** Before any reveal, fold receipt, terminal or decision packet, account for every peer you asked: answered, or a recorded coverage decision (lens handed to another peer, scope narrowed, or the gap carried into the terminal as missing coverage). Recover with the existing moves (`tap nudge` once, re-poll on wake); no timer, no polling, and silence is never consent. When you record a coverage decision for an unanswered ask, withdraw that ask (`tap withdraw <id> -m <reason>`) so it leaves `tap outstanding` and a late reply cannot land in a thread you have closed; otherwise keep the thread open. `is-converged.sh` reads the ledger and saved proposals only; coverage is your check, and the terminal names it.
- **One terminal per peer.** Send the same terminal to every peer: `tap reply` to each open proposal ask, a note where none is open, naming the artifact version, coverage, absent peers and preserved dissent. `tap outstanding` shows one obligation per peer until each settles; acknowledgements never count toward the cap. A decision packet lists positions by handle, unmerged.

## Modes

Load `references/modes.md` for the mode-specific ledger rules. In brief:

- **plan** — co-author/converge a plan or design. Findings = open questions and objections; converge when every one is dispositioned.
- **review** — adversarial review of an artifact. Findings enter the ledger as `proposed`; the loop **auto-pivots correctness → polish** once correctness items drain.
- **decide** — resolve a bounded question; returns a `decision_packet` (load `references/decision-packet.md`).

## Seed without exposing the driver's candidates

Open with two driver payloads separated by each peer's independent reply:

1. Send an **ask** containing the thread, mode, round cap, question, source pointers
   and relevant on-disk state. Ask for the peer's own gap list or position. Keep the
   driver's candidate answers and findings out of this payload and its linked brief.
   Each peer reads the evidence and sends **one `tap reply` with its own view**.
2. Only after every reply lands, send an **ask** containing the driver's candidates
   and the questions to triage (with several peers, every position too). Each peer
   now compares the positions and returns one proposal turn using the schema below.

For a review, the target artifact is shared evidence; the driver's review findings
stay private until step 2. If a peer has already seen the candidates, disclose
that exposure and do not claim a blind initial pass. Seeding is round 0; the driver
increments the existing counter after each subsequent proposal/response cycle.

## One proposal payload per turn

Follow `/tap`'s batching floor. Put the thread and your reasoning in Markdown,
then all of the turn's ledger operations in **one fenced `json` object with a
non-empty `ops` array**. For example:

````markdown
thread: discuss-example

## Position
The source supports F1; F2 needs a separate decision.

```json
{"ops":[
  {"op":"transition","item_id":"F1","new_status":"accepted","rationale":"source confirms the finding"},
  {"op":"add","item_id":"F2","status":"proposed","evidence_class":"judgment","evidence":"source.md:12","rationale":"new question"}
]}
```
````

`add` requires `item_id` and `evidence_class`; `status` defaults to `proposed`. On a
thread that declares `peers`, an `add` id starts with your alias and a hyphen (`astra-3`).
`transition` requires `item_id` and `new_status`. Evidence and rationale fields
are strings; the ledger still validates statuses, classes and reversal evidence.
The raw JSON form `{"ops":[...]}` and legacy raw single-op objects also work.
Multiple `json` blocks and empty batches are refused. With no ledger operations,
send an ordinary reply explaining your position; do not send an empty proposal.

Reply to the current driver ask with
`tap reply <id> --expect-reply --kind proposal -f <turn.md>`: this settles that ask
and creates exactly one obligation for the driver. If there is no inbound ask,
use `tap send <driver> --ask --kind proposal -f <turn.md>`. The driver folds the
batch, then replies **once** with the per-op fold receipt and its next turn (or
terminal). Use `--expect-reply` only when that next turn needs an answer; send no
separate acknowledgement or per-op receipt.

## The loop (deterministic — agents reason, control flow is mechanical)

Load `references/loop-contract.md` for the full mechanics (poll-first discipline, the courier-wake rest boundary, escalation, and the driver/peer asymmetry). The driver-only ledger/convergence helpers live under `skills/discuss/scripts/`; each requires the driver's `--by <handle>`. The shape:

1. **Poll.** `tap poll <me>` — any unsettled inbound is immediate work. Handle it, then settle: `tap reply <id> -f <file>` answers an ask **and** settles it in one command; `tap read <id>` settles a note.
2. **Act** — reason about the content (is this finding valid? my counter?). This is the agent's job, not the transport's.
3. **Disposition — driver-gated:**
   - **Driver:** seed or disposition the ledger with `ledger.sh add|transition|list
     <tid> … --by <me>`. Only the driver writes shared thread state; repo-file custody
     remains governed by `/tap`.

     Save each complete proposal under `threads/<tid>/proposals/<id>.md`, retaining
     TAP's frontmatter. Its `path` must still identify the canonical payload; body,
     `from`, `kind` and `from_team` must match. `fold.sh <tid> <proposal-file>… --by <me>` derives
     time from the canonical courier `.placed` receipt's high-resolution mtime.
     Caller-supplied `at` and chosen IDs do not prove freshness. Repair a damaged
     copy by recopying the canonical bytes.

     The fold applies ops in order through the ledger guard and stops a payload at
     the first failure. Successful ops receive `<payload-id>#<zero-based-index>`
     ledger/bookmark entries; only a complete batch gets a whole-payload bookmark.
     Re-fold recovers the applied prefix from either record. Failed ops and their
     unattempted tail stay pending; successful prefix operations are not rolled back.
     A `CONFLICT` op stays pending until you adjudicate and dispose it (§ n peers).
     See `references/loop-contract.md` for replay, repair and receipt details.
   - **Peer:** you do **not** write the ledger. Send one proposal turn with all dispositions and reasoning using the schema above. The driver folds it. Continue independent useful work, then yield for the response.

     **Use `-f`, never `-m`, for a ledger op.** The composing shell evaluates backticks and `$(…)` inside a quoted `-m` argument before `tap` ever sees it, and a `rationale` field is free prose that routinely quotes command names — so `-m` turns a teammate's finding into live execution on your box. This repo has been bitten by that class more than once. A file body is data.
4. **Converged? — driver-only:** `is-converged.sh <tid> <round-cap> --by <me>` — a deterministic check over BOTH planes (drained ledger AND no unprocessed proposal file), never an LLM vibe. Exit 0 = converged → send the terminal `converged` to every peer. Exit 2 = cap reached → send the `decision_packet` to every peer. Exit 1 = keep looping. Exit 3 = thread state is unreadable, or a non-driver tried to enumerate convergence (a protocol error — only the driver reads it). Unreadable includes an unapplied proposal that cannot be parsed: since tap-yegvg only an APPLIED payload is bookmarked, a malformed proposal stays pending and blocks convergence rather than being silently dropped. Repair it and re-fold, or escalate; deleting it is not a disposition. Before you rest, also run `tap outstanding <me>` — an unsettled send means you still owe the terminal or supervision (see loop-contract).
5. **Reply once for the turn** — the peer's proposal reply already answers the inbound; do not send another. The driver uses `tap reply <id> -f <turn.md>` for its combined fold receipt and response, with `--expect-reply` if discussion continues. The TAP courier wakes your pane on the next reply; continue independent useful work, then yield without poll-sleep. The driver bumps the round each cycle: `round-count.sh <tid> --increment --by <me>`.
6. **Always send the terminal message** (L8) — the driver converges and MUST send the terminal `converged`/`decision_packet` to every peer, so no peer times out into a false "unresponsive".

## Co-triage via propose → fold (KD4/L13)

When any reviewer (a skill, an expert agent, or a peer) surfaces findings, the driver does **not** silently apply them on its own judgment. The decorrelated counterpoint is the point, and it runs through the **immutable TAP transcript**: each **peer proposes** all of its turn's dispositions (accept / reject_with_reason / resolve / defer / human_decision) in one `--kind proposal` payload; the **driver folds** it (`fold.sh`) through the ledger guard, which applies or rejects it. Every disagreement therefore passes through a durable payload, not a two-writer race on the ledger. Solo triage with no proposal misses the decorrelated counterpoint — that is the failure this shape exists to prevent.

## The anti-sycophancy guard (F2 — mechanism, not metric)

`ledger.sh transition` **fails loud** if an `evidence_bearing` item goes `rejected_with_reason → accepted` without an `evidence_ref` newer than the rejection — and the guard is **replayed at read time** over the event stream, so a forged ledger line cannot bypass it (the write-time check stamps the evidence message's id+timestamp onto the accept event; the replay validates that immutable stamp). Because the fold path enters through this same `transition`, a peer-proposed reversal is checked when the driver folds it, against the durable payload. Agents may change their minds, but the control plane requires _visible new evidence_ for a reversal — so agreement cannot be sycophancy. Judgment/taste items are exempt (conceding to a better argument is the point — F5).

## Bounded authority (KD4)

Inside the loop the agents may converge on findings and apply agreed edits — but they may **not** force a schema change, a migration, an assertion/tripwire change, or a merge. Any of those → stop the loop and escalate a `decision_packet` for `human_decision`. This is a **prose stop-condition**, enforced by the agents — there is no deterministic gate behind it, and you should not read one into the confident wording above. Rebuilding it as a real sink is tracked as `tap-qakv`; until that lands, treat every one-way-door action (schema/migration/merge/assertion-weakening) as human-only: emit a proposed diff and a `decision_packet`, never self-apply.

## Convergence artifact

A `converged` terminal attests the agents aligned on a _specific version_ of the artifact — named in the terminal message body — ready for human review. It is not a freeze and not execution permission: it is a _cited synthesis_, subordinate to the primary evidence it cites and never a substitute for a `human_decision`.

## Verify

`bash scripts/smoke-all.sh --only skills/discuss/scripts/smoke/convergence-ledger.test.sh` — the single-writer + proposal-fold + convergence gate (driver gating, the fail-loud anti-sycophancy invariant and its read-time replay, the F5 judgment exemption, and `is-converged.sh`'s drained-ledger/no-pending-proposal/round-cap/non-driver exit codes; and the n-peer arms: aliased ids, the duplicate-add wedge and its `dispose.sh` recovery, cross-sender conflicts within and across fold invocations, and order independence), all runnable without a live TAP session via `COLLAB_DIR` and explicit `--by`. `verify:full` is inert for shell.
