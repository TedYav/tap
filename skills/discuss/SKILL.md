---
name: discuss
description: "When co-reviewing finished plans, reviews, or decisions, bound adversarial convergence in a driver-owned issue ledger."
argument-hint: '[plan|review|decide] [--thread ID] [--round-cap N] [CONTEXT...]'
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, Skill
---

# /tap:discuss — the TAP-native convergence engine

> The bracketed cross-reference codes (`KD*`/`F*`/`L*`) are provenance footnotes from this skill's original design work in another repo; the prose here is self-contained and does not depend on them. They are kept because they make the dogfood receipts traceable for anyone who goes looking, not because the documents are reachable from this one.

`/tap:discuss` runs a bounded, adversarial loop between two CLI agents over `/tap` until they converge — measured by a **durable issue ledger draining**, not by both agents sounding satisfied (L7). Transport is the dumb TAP bus (`tap send`/`reply`/`poll`/`done`/`outstanding`); this skill is the convergence loop on top of it, plus a driver-owned ledger that makes agreement mean something. TAP moves messages and wakes panes; it decides nothing about convergence — that logic lives here (KD6).

**Why it exists:** two decorrelated fluent models catch what one cannot — the dogfood receipts show co-triage flipping a hash-guard, scoping an eval, and resolving a brownfield boundary that solo-apply would have shipped wrong (L13). That decorrelated counterpoint is the whole value; without it you are talking to a mirror.

## Prerequisites

You and your peer are each registered TAP seats (`tap in` — see `/tap`). `tap whoami` is your handle; you pass it as `--by` to every ledger mutator, and TAP derives `--from` from your registered pane. The handle is the only identity **this skill** carries — thread roles, ledger writes, and `--by` are all keyed on it alone.

TAP itself carries more, and the difference matters here. Under v0.20 a registry row also holds an opaque `instance` (one row lifetime), and sends stamp `recipient_instance`/`sender_instance` on the payload; settlement and `tap outstanding` filter on `(handle, instance)` when those stamps are present. So a **fresh same-handle seat begins with an empty obligation set** — it cannot settle mail addressed to its predecessor.

Two corrections to the assumptions this skill arrived with:

- **A team is not a worktree.** Seats on one team routinely occupy different worktrees, which is why thread state is rooted outside any checkout (see State home). A cross-team peer is addressable as `<team>/<handle>`.
- **The handle names a seat, not an instance.** A seat survives a clear, a restart, and a compaction, and comes back with the same handle and none of the conversation context. So the thread's `opened_by` keeps identifying the right *address* across a driver restart, and the restarted driver is still the driver — but the agent at that address may not remember the loop, and per the instance stamping above it also cannot settle the mail its predecessor was holding. Durable state is the ledger, not the driver's recollection: a returning driver reads the thread rather than resuming from memory, and re-asks the peer for anything that was in flight rather than assuming a pending reply will still land.

## State home

Thread state lives under `$COLLAB_DIR` (env override, must be absolute) → default `${TAP_HOME:-$HOME/.tap}/tap:collab`. **That `collab` is deliberate and is not a leftover:** the skill was renamed to `/tap:discuss` as a routing change, while the state home, `COLLAB_DIR`, and the ledger scripts' internal names kept their spelling — renaming those is a state migration reaching every open thread on every bus. Do not "fix" it here without migrating `ledger/lib.sh` and the `tap team reset` component row with it. Everything below — the ledger, round counter, folded proposals — resolves under `$COLLAB_DIR/threads/<thread_id>/`.

The root is **outside any checkout on purpose**. A driver and peer routinely sit in different worktrees, and a repo-relative root would give them different state — the peer could not read the thread it was invited to. Rooting at TAP's home means one root per machine regardless of worktree, and it puts thread state where the bus already lives. It is also out of reach of `git clean`.

## Roles — driver and peer (derived, not symmetric)

Role is **derived from who opened the thread**: the **driver** is the handle recorded in `threads/<id>/metadata.json` `opened_by`; the other agent is the **peer**. The loop is **asymmetric**: shared thread-state (the ledger, the round counter, convergence) is **driver-owned, single-writer**. The driver folds, drains, and checks convergence; the **peer proposes and waits**. A peer cannot write or even enumerate the ledger — `ledger.sh`/`is-converged.sh`/`round-count.sh --increment` reject a non-driver at the sink (`is-converged.sh` exits 3). The peer's only influence on shared state is a proposal payload the driver folds. Only the seed and these gated mutators differ; the poll/act/reply rhythm is shared.

**Open the thread (driver, once):** establish the thread by writing its metadata — this is what makes you the driver.

```bash
tid="<thread-id>"                       # e.g. discuss-2026-07-08-plan
me="$(tap whoami)"
d="${COLLAB_DIR:-${TAP_HOME:-$HOME/.tap}/collab}/threads/$tid"
mkdir -p "$d/messages" "$d/proposals"
printf '{"opened_by": "%s"}\n' "$me" > "$d/metadata.json"
```

Every ledger/convergence sink reads `opened_by` and rejects a writer whose handle does not match. The peer never mints a thread id — it adopts and echoes the driver's `<thread-id>` on every message.

## Modes

Load `references/modes.md` for the mode-specific ledger rules. In brief:

- **plan** — co-author/converge a plan or design. Findings = open questions and objections; converge when every one is dispositioned.
- **review** — adversarial review of an artifact. Findings enter the ledger as `proposed`; the loop **auto-pivots correctness → polish** once correctness items drain.
- **decide** — resolve a bounded question; returns a `decision_packet` (load `references/decision-packet.md`).

## Seed without exposing the driver's candidates

Open with two driver payloads separated by the peer's independent reply:

1. Send an **ask** containing the thread, mode, round cap, question, source pointers
   and relevant on-disk state. Ask for the peer's own gap list or position. Keep the
   driver's candidate answers and findings out of this payload and its linked brief.
   The peer reads the evidence and sends **one `tap reply` with its own view**.
2. Only after that reply lands, send an **ask** containing the driver's candidates
   and the questions to triage. The peer now compares both positions and returns
   one proposal turn using the schema below.

For a review, the target artifact is shared evidence; the driver's review findings
stay private until step 2. If the peer has already seen the candidates, disclose
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

`add` requires `item_id` and `evidence_class`; `status` defaults to `proposed`.
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
     `from` and `kind` must match. `fold.sh <tid> <proposal-file>… --by <me>` derives
     time from the canonical courier `.placed` receipt's high-resolution mtime.
     Caller-supplied `at` and chosen IDs do not prove freshness. Repair a damaged
     copy by recopying the canonical bytes.

     The fold applies ops in order through the ledger guard and stops a payload at
     the first failure. Successful ops receive `<payload-id>#<zero-based-index>`
     ledger/bookmark entries; only a complete batch gets a whole-payload bookmark.
     Re-fold recovers the applied prefix from either record. Failed ops and their
     unattempted tail stay pending; successful prefix operations are not rolled back.
     See `references/loop-contract.md` for replay, repair and receipt details.
   - **Peer:** you do **not** write the ledger. Send one proposal turn with all dispositions and reasoning using the schema above. The driver folds it. Continue independent useful work, then yield for the response.

     **Use `-f`, never `-m`, for a ledger op.** The composing shell evaluates backticks and `$(…)` inside a quoted `-m` argument before `tap` ever sees it, and a `rationale` field is free prose that routinely quotes command names — so `-m` turns a teammate's finding into live execution on your box. This repo has been bitten by that class more than once. A file body is data.
4. **Converged? — driver-only:** `is-converged.sh <tid> <round-cap> --by <me>` — a deterministic check over BOTH planes (drained ledger AND no unprocessed proposal file), never an LLM vibe. Exit 0 = converged → send terminal `converged`. Exit 2 = cap reached → send `decision_packet`. Exit 1 = keep looping. Exit 3 = thread state is unreadable, or a non-driver tried to enumerate convergence (a protocol error — only the driver reads it). Unreadable includes an unapplied proposal that cannot be parsed: since tap-yegvg only an APPLIED payload is bookmarked, a malformed proposal stays pending and blocks convergence rather than being silently dropped. Repair it and re-fold, or escalate; deleting it is not a disposition. Before you rest, also run `tap outstanding <me>` — an unsettled send means you still owe the terminal or supervision (see loop-contract).
5. **Reply once for the turn** — the peer's proposal reply already answers the inbound; do not send another. The driver uses `tap reply <id> -f <turn.md>` for its combined fold receipt and response, with `--expect-reply` if discussion continues. The TAP courier wakes your pane on the next reply; continue independent useful work, then yield without poll-sleep. The driver bumps the round each cycle: `round-count.sh <tid> --increment --by <me>`.
6. **Always send the terminal message** (L8) — the driver converges and MUST send the terminal `converged`/`decision_packet`, so the peer never times out into a false "unresponsive".

## Co-triage via propose → fold (KD4/L13)

When any reviewer (a skill, an expert agent, or the peer) surfaces findings, the driver does **not** silently apply them on its own judgment. The decorrelated counterpoint is the point, and it runs through the **immutable TAP transcript**: the **peer proposes** all of the turn's dispositions (accept / reject_with_reason / resolve / defer / human_decision) in one `--kind proposal` payload; the **driver folds** it (`fold.sh`) through the ledger guard, which applies or rejects it. Every disagreement therefore passes through a durable payload, not a two-writer race on the ledger. Solo triage with no proposal misses the decorrelated counterpoint — that is the failure this shape exists to prevent.

## The anti-sycophancy guard (F2 — mechanism, not metric)

`ledger.sh transition` **fails loud** if an `evidence_bearing` item goes `rejected_with_reason → accepted` without an `evidence_ref` newer than the rejection — and the guard is **replayed at read time** over the event stream, so a forged ledger line cannot bypass it (the write-time check stamps the evidence message's id+timestamp onto the accept event; the replay validates that immutable stamp). Because the fold path enters through this same `transition`, a peer-proposed reversal is checked when the driver folds it, against the durable payload. Agents may change their minds, but the control plane requires _visible new evidence_ for a reversal — so agreement cannot be sycophancy. Judgment/taste items are exempt (conceding to a better argument is the point — F5).

## Bounded authority (KD4)

Inside the loop the agents may converge on findings and apply agreed edits — but they may **not** force a schema change, a migration, an assertion/tripwire change, or a merge. Any of those → stop the loop and escalate a `decision_packet` for `human_decision`. This is a **prose stop-condition**, enforced by the agents — there is no deterministic gate behind it, and you should not read one into the confident wording above. Rebuilding it as a real sink is tracked as `tap-qakv`; until that lands, treat every one-way-door action (schema/migration/merge/assertion-weakening) as human-only: emit a proposed diff and a `decision_packet`, never self-apply.

## Convergence artifact

A `converged` terminal attests the agents aligned on a _specific version_ of the artifact — named in the terminal message body — ready for human review. It is not a freeze and not execution permission: it is a _cited synthesis_, subordinate to the primary evidence it cites and never a substitute for a `human_decision`.

## Verify

`bash scripts/smoke-all.sh --only skills/discuss/scripts/smoke/convergence-ledger.test.sh` — the single-writer + proposal-fold + convergence gate (driver gating, the fail-loud anti-sycophancy invariant and its read-time replay, the F5 judgment exemption, and `is-converged.sh`'s drained-ledger/no-pending-proposal/round-cap/non-driver exit codes), all runnable without a live TAP session via `COLLAB_DIR` and explicit `--by`. `verify:full` is inert for shell.
