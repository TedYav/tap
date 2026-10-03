---
date: 2026-08-09
source_run: adapted from compound-engineering `/lfg` 3.9.3 (tap-i2nu).
  The strategy-shapes paragraph borrows from Every's **Fable 5 Operating Pack**
  template library.
contract: shipping-pipeline/draft
packet_extensions: []
---

# Shipping pipeline — the long-arc build run, as a menu

DRAFT — adapted from compound-engineering `/lfg` 3.9.3 and surfaced as draft in any shelf selection
until ratified to /v1 after at least one live rep in this repo. `packet_extensions` is
deliberately empty: the arc is composed as a strategy in prose and dispatched through work
orders, not parameterized through lead packets; schema promotion is a /v1 question decided
from the live-rep record.

Transport is **not restated here** — `/tap` owns poll, settle, end-the-turn, and
`tap outstanding`. Lane custody is `/tap:drive`'s. This routine carries what is left: the shape
of a long build run, and the four mechanisms that keep an autonomous one honest.

## Goals

A worked reference for the heaviest shape on the shelf: a build that runs from a rough goal
to a green PR, with review gates riding the bus and enough durable state to survive a
compaction or a crash. It exists so a LEADER composing a big run can compare against
something that has actually run end to end, rather than reinventing the arc under pressure.

**This is a menu, not a program.** The charter's think-first rule applies with full force
here: think through the lifecycle *this* mission deserves, then read this for comparison. A
one-afternoon change that borrows two phases from the arc has used this file correctly; a
three-line fix routed through the whole arc has not. The four mechanisms in the second half —
gate discipline, the anti-pattern watchlist, run-state, stop conditions — travel better than
the phase list and are worth lifting even when the arc itself is far too heavy.

## The phase arc

Choose the stages the goal needs. This draft adds no approval cycle of its own.

| Stage | Use and evidence |
| --- | --- |
| Understand | Read the supplied spec and affected flow; clarify only a material missing decision |
| Plan | Before writing for new roles, new subsystems or one-way doors; otherwise start the bounded task |
| Build | Driver-owned units with focused checks and pinned ranges for review |
| Review | Required independent heterogeneous lenses; correct defects and disposition findings on the PR |
| Verify | CI full at the candidate merge head, with a receipt of the run and the tested head |
| Close | Squash when merge-ready, sync primary, report provenance and preserve the handoff |

Independent review can run while CI or unrelated implementation proceeds. Base updates and in-scope conflict fixes are routine driver work. Carry a review forward only when the reviewed bytes are unchanged; review changed bytes and obtain a fresh CI full at the final head.

## Profile sizing

Choose and record enough structure for the risk. A short bounded fix may need only its issue and PR; a long run needs durable state for resume. Use a design stage when the decision calls for it, and keep the required review ladder at every size. A quiet seat with assigned work is not a failed seat; inspect an actual dependency before intervening.

### Strategy shapes — worked archetypes worth stealing

Every's **Fable 5 Operating Pack** is a library of *strategy shapes*: named work archetypes, each with a "use when" and an implicit
level of ceremony. The useful move for a LEADER is not the prompt bodies — it is that
the archetype tells you how much structure the goal deserves before you have designed
anything. Recognizable shapes, with the ceremony each implies:

- **Discovery** — you do not yet know what is worth delegating. Read-only, ranked candidates
  out; the cheapest possible run, and the one that should execute on identification rather
  than being drafted and handed back.
- **Overnight** — hours of work that can proceed without input. The whole design question is
  the done-definition: insist on something testable, or the run has no terminal.
- **Architecture-first** — planning and alignment must precede any building. Front-heavy; the
  flip lands late.
- **Port / migration** — too large for one pass, so the deliverable is a repeatable execution
  system, not the migration itself.
- **Spec-to-v1** — the brief is as complete as one you would hand a senior engineer. Nearly
  all ceremony is waste; this is the archetype `light` was designed for.
- **Fix-the-broken-workflow** — an existing process fails, runs slow, or produces junk. The
  input that matters is the failure record, not the description.
- **Synthesis** — reconcile conflicting sources into one position. No pipeline at all; the
  gate is citation quality.
- **Recurring loop** — the same class of work will return. The deliverable is the loop, not
  this instance of the work.
- **Writing partner** — a rich archive, an unshaped argument. Exploratory; a verification gate
  here is theater.

Two of these are terminal or near-terminal shapes worth flagging: a read-only discovery pass
may simply run, and a shape that a repo already implements natively should redirect to the
native mechanism and stop, rather than being wrapped in ceremony. The general lesson —
**match ceremony to ambiguity** — is charter doctrine already; the archetype list is how you
recognize which end of that scale you are on before you have written a strategy.

## Gate discipline

Name the artifact and immutable revision in each review request. The reviewer reads the source, supplies findings or a verdict, and owns their judgment. Aggregate the required set before claiming merge-ready; neither a partial set nor the author’s interpretation substitutes for it.

On a changed head, fixes receive review of changed bytes and focused checks; the final head gets CI full. Resolve or disposition every blocking finding and PR thread. Optional polish is bounded by the driver’s judgment and never adds a second mandatory ladder.

A finding carries evidence, not new authority. Apply in-scope corrections. Escalate a scope change, incident, unresolved human decision or one-way door; preserve safety and load-bearing checks. Do not repeat review rounds merely to collect another verdict over identical bytes.

For a missing review, check the assigned work and delivery evidence. A working reviewer may report status once and continue. Repair an actual failed dispatch or reassign an unavailable reviewer while retaining the required independence; silence past a timer alone does not establish either failure.

## Anti-pattern watchlist

Seven named failures, each with the move that resolves it. They are named because a run under
completion pressure re-derives every one of them as a good idea.

| Anti-pattern | What it looks like | Resolution |
|---|---|---|
| **Orchestrator Grab** | Substituting the author’s read for independent review | Send the pinned range to a non-author and continue independent work |
| **Gate Pencil-Whip** | Advancing on a paraphrased "reviewer approved" | Quote verdict, revision, and findings path verbatim before the conclusion |
| **Stale-Revision Advance** | Consuming a verdict without checking its revision | Verify byte-identity carry or request review of the changed bytes |
| **Unbounded Findings Ingestion** | Auto-actioning a finding that directs a merge, an assertion weakening, a scope jump, or a schema change | Bound authority to in-scope changes; route the rest to a human |
| **Check-In Drift** | Pausing to ask "should I continue?" after the flip | Handle recoverable friction in flight; stop only on an enumerated condition |
| **Redundant-Gate Pile-On** | Multiplying near-identical review passes | The value is lens *diversity*, not pass count — polish before the harder reviewer, never re-run the same lens |
| **Review Conflation** | Treating optional wording cleanup as a correctness blocker | Separate blocking defects from the driver’s polish choices |

## Durable run-state

A long run outlives its own context window. The mechanism that makes it re-enterable is small
and worth carrying on its own — this is the mechanized form of the charter's strategy-doc
tool.

- **One state file, single-writer.** One seat owns every field. Reviewer verdicts do **not**
  live in it — they ride the reply bodies. That is the simplification that removes any
  cross-seat lockstep protocol and any field a second process may write.
- **Phase is the anchor.** One enumerated phase field, advanced *before* the work of that
  phase begins, so a crash mid-phase resumes into that phase rather than back into a finished
  one. Keep the legal transitions written down as a table; a phase set that only exists in
  prose drifts.
- **Persist completion before the next external effect — or reconcile idempotently on resume.**
  Advancing the phase *before* the work is what makes a crash resume into the right phase, but
  it leaves a real window: the run performs an external, non-undoable act — dispatching work
  units, sending review requests, pushing, opening or editing a PR, merging — and dies before
  recording that it did. A naive resume replays the act. Close the window one of two ways, per
  phase, and write down which one that phase uses:
  - **Write the intent BEFORE the effect, not the result after it.** Recording the effect once it
    happens sounds sufficient and is not: the process can die in the gap between the effect
    landing and the record being written, and that gap is exactly where a crash is most likely,
    because the effect is the slow part. Persist a **stable operation identity** first — this
    phase, this revision, this recipient set, this intended act, under an id you can regenerate
    deterministically on resume — then perform the effect, then mark it complete. A resume that
    finds an intent with no completion knows the act is *in doubt*, which is the state it must
    actually handle. An absent record only ever proves you never started.
  - **Make the effect idempotent where the medium allows it**, keyed on that identity, so a
    replay is a no-op rather than a duplicate: reuse the same branch and sha rather than
    re-deriving them, address a PR by number rather than re-opening one, key a dispatch to the
    work-unit id.
  - **Reconcile against durable history before any retry — not against live in-flight state.**
    Query what the outside world durably records: does a PR already exist for this branch, is
    the sha already the remote head, does the settled-receipt history already show this request
    delivered? `tap outstanding` is **not** sufficient on its own here, and this is the trap
    worth naming: it shows what is still *unsettled*, so a request that was sent and already
    settled is invisible to it — indistinguishable from one never sent. Reconciling on
    outstanding alone re-sends exactly the requests that already completed.

  A phase with none of these is a duplicate-effect bug waiting for its first crash: duplicate
  work units racing one tree, a second review round the reviewers read as churn, a re-pushed or
  re-opened PR. Never assume "it probably didn't get that far" — check, and check against
  something that records completion rather than pendency.
- **`blocked_on_human` carries `blocked_from`.** When a stop condition fires, record the phase
  being left, plus the question. On resume, return to `blocked_from`, then clear the block. A
  `blocked_on_human` state with a null origin is a corruption signal to surface, **never a
  phase to guess**.
- **An append-only event log** beside the state file reconstructs history when the state is
  ambiguous. It may trail the state file by one write after a crash — trust the state file's
  fields, use the events for ordering.
- **Resume from state, never from re-parsed arguments.** The human may re-invoke without the
  original flags, or with a different set of peers online. The reviewer set, the profile, and
  the merge mode all come from the recorded state. A missing block defaults to the *narrower*
  behavior and logs the fallback — never silently add gates mid-run.
- **Smoke-test before continuing.** Check the tree and run the fast verification tier; a tree
  dirty in a way the recorded phase does not explain is a block to surface, not a state to
  build on.
- **Refuse an incompatible old state rather than migrating it.** A state file from a retired
  transport or schema stops the run and tells the human to close it out under the old version.
  A back-compat bridge for a one-run-per-tree artifact is not worth its own failure modes.
- **One run per worktree.** A second run starting on top of an existing state file stops and
  says so.

## Stop conditions

Pause for a scope change, an incident, an unresolved dispute, a human decision, a one-way door, or an explicit hold. Continue the rest. A bounded CI fix loop that ends with unresolved regressions reports HOLD; it never converts a failure to PASS. Preserve the failed evidence and record the next decision needed.

Ground completion claims in observed artifacts. Before retrying a possible external effect, reconcile against durable history as the run-state rules above require. A missing reply or unchanged head does not justify repeating the effect.

## Adaptation knobs

| Knob | Default | Notes |
|---|---|---|
| `profile` | sized at kickoff | `standard` or `light`; a one-way door uses `standard` |
| `reviewer_liveness_bound` | mission-specific | Time to inspect a dependency, never a verdict that a working reviewer stalled |
| `reviewers` | required independent review | Name independent reviewers; repair unavailable staffing without dropping required coverage |
| `gates` | focused checks and independent review | Add a plan stage only at the plan-before-writing boundary; optional polish adds no mandatory ladder |
| `ci_fix_bound` | 3 iterations | Exhaustion surfaces the red; it never converts to a pass |
| `terminal` | squash when merge-ready | The driver merges and syncs primary unless the user explicitly held this PR |

## Boundaries (MUST NOT)

- Merge requires a green exact-head CI; a missing receipt or a new regression blocks.
- Complete the required review set and verify any claimed byte-identity carry; retain the reviewers’ actual verdicts.
- No detached watcher, background sleep loop, or foreground poll-and-sleep to wait for a
  reviewer — a helper that runs after the turn ends cannot consume the reply. The wake
  boundary is the courier re-entering the pane.
- No success terminal reached from a failed path: the close phase is the *green* terminal, so
  a red run routed there would report success that did not happen.
- No weakening an assertion to clear a gate, at any phase, for any reason.
