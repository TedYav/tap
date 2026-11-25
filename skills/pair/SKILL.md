---
name: pair
description: "When one seat builds live and another reviews each range independently, coordinate one writer and reviewer. The driver builds by default, or plans and reviews while its partner builds."
argument-hint: '[partner-handle] [plan-path] [who builds]'
allowed-tools: 'Bash, Read, Grep, Glob, Edit, Write, Skill'
# Either seat may hold the writer token, so the grant covers writing. What scopes
# it is the token contract in the body — not this list. Removing Edit/Write would
# disarm the builder and encode a read-only partner this contract does not have.
---

# Pair — two seats, one writer

> **Provenance.** This skill owns the verdict and re-review contracts, adapted from obra/superpowers
> `subagent-driven-development` (MIT). The defects behind each rule are collected in
> `docs/solutions/best-practices/what-a-pairing-partner-catches.md`.

Two seats on one piece of work: a **builder** who writes each unit, and a **reviewer** who challenges
it, verifies it, and can send it back. On a finding neither outranks the other: evidence decides.
Either may hold the pen — one at a time.

Over code the builder executes the plan and the reviewer reviews each unit. Over a research pass, an
analysis, or a document, a unit is whatever the builder publishes and the reviewer can independently
recompute.

## Who drives

The **driver** is the seat that received the request to pair and invites the other, its **partner**.
It owns the plan, the unit order, the rounds and the closeout. Which of the two roles it takes is
settled at the start:

- **The driver builds (the default).** The driver executes the plan and its partner reviews each
  unit.
- **The driver reviews.** The driver plans, hands each unit to its partner to build, reviews what
  comes back, and sends edit requests until the unit holds. Use it when the request says so ("you
  drive, your partner implements"): typically a stronger planning seat paired with a cheaper or
  faster builder.

**The driver's opening message names both roles.** A partner told only "pair with X" cannot tell
which side it holds, so the invitation says who builds and who reviews. When the partner builds, the
same message grants it the writer token and carries the first unit's brief; the partner loads the
builder's contract and starts on that grant. A driver that builds starts as before.

A driver that reviews also owns the builder's inputs. It writes each unit's brief, sizes the unit to
the builder it has, and answers the builder's escalations. When a builder cannot converge, re-scope
the unit, take the pen under the token rule below, or ask for a different builder; do not send the
same seat back at the same task unchanged.

Every rule below is keyed to builder and reviewer, so it reads the same whichever seat drives.

## What each seat loads

Both seats run `tap help skill tap` and read the returned file for the all-seat
transport floor, which is not waivable. The reviewer loads this
skill's review contract: run `tap help skill pair`, then open
`references/review-contract.md` next to the returned canonical SKILL.md. The builder
opens `references/builder-brief.md` there for the report contract — commands and output, RED/GREEN
observations, status, durable report file — that the review consumes. A driver that reviews opens
both: the same file says how to construct the dispatch it sends its builder. Resolve these siblings
from the canonical file, not a native-plugin or flat-host discovery wrapper. The partner does not
load the driver's loop: those mechanics are not the partner's to carry.

**If the question is *what should we do* rather than *is this right*, use `tap help skill discuss`:** a driver and
its peers converging until a ledger drains. Pairing sustains production, and its deliverable is the
artifact rather than the agreement.

## One writer

**One seat writes the pair’s work product at a time.** Pass custody explicitly when the partner takes the pen. Review an immutable range to keep the verdict attributable; CI’s separate checkout does not freeze authoring.

Which seat is not fixed. The builder holds the token while it builds: a driver that builds starts
with it, and a driver that reviews grants it in its opening message. Custody follows the passable writer token described by
`tap help skill drive`, and the TAP message that
passes it is the record. Bounce-with-proposal is the cheap default; take the token when applying a fix
beats describing it.

**Review obligation follows the token inversely: whoever did not write a diff reviews it.** Otherwise
passing the token is how a change reaches the tree unreviewed.

**A read-only review of a range needs no checkout.** `git show BASE:path`, `git show HEAD:path`, and
`git diff BASE..HEAD` read the shared object store, so a reviewer that only reads needs no worktree of
its own.

**A review that recomputes — tests, type-check, mutants, generators — runs in a checkout the writer is
not moving.** Tests, generators, formatters, and builds touch files, and git's index and status are
worktree-global — a reviewer recomputing in the builder's tree is a second writer by another name. The
normal shape is a detached, locked review worktree at the range head (`git worktree add --detach
--lock --reason 'pair review in progress' <path> <HEAD-sha>`) — a tree on some other branch tests
different bytes and can confirm or reject a unit it never saw. If the pair genuinely shares one
checkout, the all-seat skill owns announcement and serialization.

**The review worktree installs its own dependencies.** Install what the check needs inside the review
worktree with the repository's own install. Use the local package cache when available, and let the
normal install fetch anything missing; from a warm cache it usually takes seconds. Never symlink or
hardlink the writer's dependency directories into it: a package-manager command run there, `exec`
included, can rewrite files through the links, leaving the writer's tools pointing at a tree about to
be deleted, or running the wrong tree's code under a test.

**The reviewer reaps that worktree in its closeout, after the last verdict.** Run
`git worktree unlock <path>`, then `tap worktree check <path>` and act on the verdict. `reclaim` licenses
`git worktree remove <path>` — the checkout only, never branch deletion. `keep`, `hold`, or `refuse`
leaves the tree in place: report the check line instead of overriding it. Quote the check line, path,
and head in the closeout. A review tree left behind without that report is a finding against the
reviewer: every abandoned tree is one more entry the next `git worktree list` reader has to rule out,
and a stale tree that gets reused reviews the wrong bytes.

## The rounds

**Start from the spec.** A bounded unit needs no plan read-back handshake. Send a plan first for a new role, subsystem or one-way door under AGENTS.md; resolve only decisions the unit depends on before writing it.

**A review is triggered by a named range, never by a message arriving.** Over code: `BASE..HEAD` as
commit SHAs, from a BASE recorded before the unit. Otherwise: a durable artifact path plus a content
hash the reviewer can recompute. Both give the same property — the two seats can prove they hold the
same bytes. "Almost done" is not a trigger.

**A review request carries:** unit; `BASE..HEAD` or path+hash; review or re-review; the unit brief;
the builder's report; the review package; on a re-review, the prior findings or the payload id holding
them; and `reply=expected`.

**The brief, report, and package travel as content, not as paths.** Each lives in one seat's
gitignored workspace, which is not in the other seat's checkout and does not survive that tree
being rebased or reaped — so send them as body-files, or send the range and let the reviewer regenerate
the package. A path into a gitignored workspace (today `.tap-execute/`) is a reference to something only one seat can read, and the
review record needs to be re-readable by whoever comes next. These travel in the message body — a review package is a range, commits, a stat, and
a diff, so sending it alone hands over the diff and withholds the contract. `review-contract.md` owns
the verdict format.

**Pin each unit for review.** The builder may build independent work while the reviewer reviews a committed range. Track each unit’s base and findings, and integrate dependent changes after the relevant findings are resolved. Honor an explicit one-unit-in-flight assignment when one was given.

**A finding names the concrete failure and proposes the correction**, with the reviewer's own anchor
numbers where it computed any. A finding phrased as a question hands the work back and costs a round.

## Verification

**Recompute load-bearing claims — and audit their definitions.** Derive the number yourself rather
than reading the sentence that describes it; then check each headline claim's *operationalization*
against the code that computes it. A perfectly reproducible number can be wrong: re-running the
instrument confirms it forever, and only reading the instrument against the claim catches it.
Load-bearing is decidable — everything with a script, plus every number the summary leads with.

**Inspect the CI receipt and recompute load-bearing claims.** The merge gate runs in CI at the final head. Use isolated focused probes where needed; a second local full is not independent review. Missing commands or output are missing evidence and warrant a finding.

## Disagreement, and the cap

- A spec miss, Critical, or Important standing NOT ADDRESSED **holds the unit open**. No stated
  reasoning closes it; closure comes from ADDRESSED, withdrawal by the reviewer who raised it, or the
  cap exit below.
- Non-blocking taste — ordering, naming, a judgement call missing no spec line — is the driver's. A
  driver that builds **proceeds under a stated assumption on the record**: *proceeding on X; one word
  and I unwind it.* A driver that reviews may request the change, and the request spends a round like
  any other.
- **The pair loop caps at three rounds** — a round here is a real send and reply, not a subagent
  dispatch. **Three is the cap whenever the reviewer is a seat in the pair**; five stands only where the
  reviewer is a dispatched subagent, which is the
  cheap, stateless, and context-free case that pays for two extra rounds. At the cap, an unresolved blocking spec or design dispute goes to the leader, or to whoever asked for the pair, as a design
  question; a *new* blocker arriving at the cap stops for replanning instead, because it is a
  convergence problem and not a disagreement anyone is having.

## What the pair's reviewer is not

**Not the approver.** By the end it carries every unit's context, which makes it the best-informed
seat and not an independent one. A driver that planned and reviewed every unit is less independent
still. The whole-diff gate goes to a seat that authored and reviewed none of it, at the exact head,
through the repo's PR ladder.

**At end of plan, re-aim it at the seams.** Every unit has been reviewed; the interfaces between them
have not. That pass is the reviewer's last job, and it is not an approval.

## Composition

Use `tap help skill drive` for writer-token custody and plan execution,
`tap help skill tap` for both seats' transport floor, and `tap help skill discuss`
for the discussion shape. A second *writer* is not a bigger pair: use
`tap help skill lead` for conducting two lanes.
