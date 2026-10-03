# Choreography best practices — objectives, and the tools that serve them

This is the doctrine reference `/tap:lead` recommends before the first dispatch. It is a
toolbox, not a rulebook: each section names an **objective** a run must achieve, why it matters,
and the tools that serve it. Pick what the strategy needs. Two registers
stay hard everywhere — **evidence contracts** (honesty of what a gate cites) and **authority
boundaries** (other people's money and rules) — because their failures are silent, unrecoverable,
or self-assessed; everything else here bends toward the build. Where a boundary can be a machine
instead of a sentence — a push guard that refuses with a message beats a paragraph asking nicely —
prefer the machine, and file a bead to mechanize any prose rule you re-read as law. Use AGENTS.md’s autonomy and typed-escalation rule when adapting these tools. Keep concrete safety
and evidence requirements; routine process changes are yours to make and report. The LEADER is also a seat — follow
`/tap`'s all-seat rules too.

## Objective: the run survives its own quiet stretches

**Choreography deadlock** is every seat sitting armed and idle, each waiting for a wake no one will
send — and any run can land there the moment the LEADER yields with nothing armed to wake it (two
teams deadlocked exactly this way).

**What binds is COVERAGE, not who provides it.** Something has to notice a silent board and produce a
wake; which seat carries it is a judgment. The recommended default is a **three-part hybrid**: **push primary**; **`tap watch`** as the mechanical liveness leg — the deadlock and
activity detector; and an **infrequent leader loop** (30–45 min) emitting minimal tokens when idle.
`tap goalie` adds optional judgment above the watcher. A quiet-activity signal invites inspection;
it does not prove a stall. A working seat replies once with status, then continues. Notes and per-head
reports suffice; repeated messages or head changes are not required.

**Every other part of the shape reaches the leader by bus send**, so if the courier or the pane
broke, nothing arrives:
a scheduled wake is the only coverage that does not depend on delivery working.
**Warmth is the bonus, not the reason** — the tick is already owed for liveness, and the TTL makes
it nearly free, not justified.

**The cost model is smaller than the folklore.** In one telemetry sample, wake ticks were
~0.7% of main-lane traffic at ~100% cache hit, while ~97% of consumption is cache reads from ordinary
work — context size × calls per turn is the real lever. "Expensive" heartbeats were expensive because
they did real work on wake: **judge a loop by its *working* ticks**, not its no-op median. What
costs: turns, context residue, staleness, and the cache cliff (~99.5% hit at 45–60 min, ~4.6% past
60). So **set cadence from the latency the run needs** — 30–45 min sits inside the window; past an
hour a wake is a pure latency instrument. Cache killers: compaction first (pair one with an immediate
wake), then model, effort and fast-mode switches. Subagents run a 5-minute TTL even on
subscription, so batch fan-outs concurrently. And **each worktree builds its own cache prefix**, so
disposable per-task trees pay a cold start every time. The tools:

- **A delegated sentinel**, the hybrid's checking leg — checking belongs off the leader's seat:
  `tap watch`, a crew or cheap team seat. How its report arrives depends on which one it is: `tap watch` sends `kind=probe`/`notice`, and those kinds bypass the autosettle hold by kind, so its traffic arrives promptly with no flag of its own. A crew or team seat has no such carve-out — it reports with `tap send --wake`, which keeps the report OWED by the leader instead of letting the courier settle it for them. That is a settlement choice, not a timing one: since ruling 51 `--wake` is inert on the delivery axis, so a staffed sentinel's report still rides the leader's delivery window (10s from their last verified delivery by default — short, but not zero). A report that must land regardless of that window needs `--delivery interrupt`, which cancels the leader's turn; for ordinary sentinel traffic the window is the right price.
- **`/tap:self goal`** — a done-when the evaluator enforces at turn end: persistence, not a scheduled
  wake, and exit 6 on opencode. Never a time-boundary done-when: a cannot-be-satisfied-yet predicate
  busy-loops the pane and **starves push delivery** — the pane never idles for the courier
  (observed incident).
- **`/tap:self loop` on the leader's own seat** — first-class in the default at 30–45 min with minimal
  idle output — **Claude Code only**: it exits 6 on Codex and opencode (`skills/self/SKILL.md`).
  The supported substitute is a **scheduler-driven poll seat**: register one
  (`tap in cron-watch --delivery poll --team <team> --unattended`), then have cron or launchd run
  `tap send <leader> --from cron-watch --team <team> --wake -f <path>` (or `-f - <<'EOF'`) on cadence,
  with `scheduled liveness wake` as the body
  (`skills/tap/USAGE.md`) — body, `--from`, `--team`, and `--wake` are each required. **`--wake` is
  load-bearing here, not decoration:** an unattended sender stamps `reply=settle-only` with no flag
  at all, and an eligible settle-only send is PRE-SETTLED inside a courier digest doorbell
  ([courier deferred auto-settlement](../../tap/protocol/messages/reply-expectation-v0-3-part-02.md#courier-deferred-auto-settlement-tap-31it)) — so without it the courier discharges the tick on
  the leader's behalf and it arrives as one line of a digest nobody owes anything for, which is not
  a liveness wake. `--wake` keeps it individually delivered and still owed. What `--wake` does NOT
  do any more is make it arrive sooner: it rides the leader's delivery window like any other send. Its residual: the wake
  rides the courier, restoring the schedule but not delivery-independence, so `tap watch`'s
  machine-level escalation (no relay seat; `supervision.md`) is the last rung. With neither armed, say the liveness floor is unmet and ask for direction, never
  improvising a timer. A loop *beyond* the shape — frequent ticks, investigative work back on the
  leader's seat — still earns a word.
- **A named stop condition and a named disarm owner on anything armed** — neither mechanism
  self-terminates. Every `/tap:self loop` interval fires the prompt and `/tap:self` never cancels one:
  stopping is the user's (Esc) or the harness's call. `tap watch` is the same shape — `done_when` is
  consulted only at chain exhaustion, `evaluator: none` never judges, and the lease lives until
  someone runs `tap watch off`. A stop condition is a commitment its named owner keeps.
  The staleness incident was a loop outliving its referent.
- **A staffed sentinel needs its own turn source, named in its brief.** A crew or team seat wakes on
  delivery like any pane, so an all-idle board leaves the sentinel asleep beside the run it watches;
  `tap watch` alone carries a timer.
- **On each wake, whoever holds it:** poll+settle → in-flight blocked-on-me → `bd ready`
  re-enumeration → runway vs boundary → act, or one line pricing the idleness you're choosing. An
  empty board with runway remaining is a trigger to re-enumerate, never evidence of completion.
- **Durable run-state** when a run outlives your context: a phase file it re-enters from,
  `blocked_from` on human blocks, resume-from-state not argv (`routines/shipping-pipeline.md`).
- **Sub-leads inherit the coverage, not the mechanism**: every appointment brief says what wakes that
  lane if it goes quiet. A seat with no answer is one dropped reply from deadlock.

## Objective: the work lands in the right hands

Four staffing forms, four defaults; `staffing.md` carries the six axes when these don't settle it.

| Form | Use | Boundary and lifecycle |
|---|---|---|
| **Subagent** | Sequential/read-only fan-out or isolated scratch writes. | No TAP identity. Shared-tree writes serialize; isolated writes return artifacts for lane-owner landing. |
| **Crew** | Bus-identified judgment/review/consult. | Read-only, never a parallel writer; pane-only in the driver's tmux session; no native resume. |
| **Launcher-managed team seat** | Resumable long-lived lane driver. | `tap session launch`; own branch/worktree and token. Durable handoff is continuity truth. |
| **Burst engine** | Ephemeral, parallel, schema'd-artifact work inside one lane. | `routines/dynamic-workflows.md`; never holds a writer token. |

Bare/poll registrations are transport-only. Default complex writers to separate DRIVER worktrees;
only Writer Token doctrine below permits unrelated DRIVERS to share. Never parallel subagents or
crews: disjoint files and no-stash rules are not isolation.

- Route each lane to the cheapest live teammate; the LEADER keeps judgment and final-gate work —
  except where the charter has transferred the whole-diff gate to a non-author
  (a LEADER who authored any delivered hunk never gates its own run). The live roster lives in
  AGENTS.md / the standing brief, not here.
- Lead-tier subagents are exceptional: explicit `model` pin + one-line reason, **re-verified on
  every resume**. A **user-named tier is a hard requirement, passed on every launch** — an
  inherited `model: inherit` default once billed a whole review roster at lead rates; the pin, not good
  intentions, is the guard.
- Teammates spawn subagents at their **own tier** for fan-out or fresh context; they consult the
  LEADER at judgment forks, and the LEADER treats consult taps as priority interrupts.
- **Agent-dispatch blocks are role assignments, not tool mandates** — forwarding to a teammate as a
  work order *satisfies* a skill. Typed seat names resolve same-worktree only; cross-worktree
  orders inline the prompt.
- **Why subagents still exist:** fresh-context decorrelation and schema-forced returns are real — a
  blank spawn hasn't absorbed the team's beliefs.
- **Plan-time delegation contract** — for plan-driven runs, the discipline lives in the plan
  (prose judgment decays under load; plan text doesn't argue back): every Delegation row names
  `Executor · Tier / spend reason · Subagent fan-out · Return artifact · Lead gate`, and lead-tier
  lanes are proposed to and confirmed by the user at planning time. A lane missing those fields is
  a stop-and-amend before spawning.
- **Staffing memory:** at staffing, read each active candidate's `Route` plus its
  latest two dated observations from `~/.tap/seat-calibration.md`.
  Inspect frontmatter for at most five newest non-archived drops in `~/.tap/ingest/` that match the
  current repo or the `staffing`, `handoff`, or `gate` tags, opening bodies only when relevant.
  Missing or malformed material warns visibly but does not block staffing; the LEADER owns the judgment.
- **Visibility floor** (authority boundary): every agent stands where the
  operator can find it — subagents inside your harness, crews as a window of the operator's tmux
  session, launcher seats in their own `<team>/<handle>` session — never an anonymous tmux session.
  `/tap` owns the full statement and the pane-less-infrastructure exemption.

## Objective: evidence stays honest

The register that is hard at every tier, including the LEADER's: suite counts from the pushed SHA,
verbatim result lines, independently executed gates, red citations. Not because your judgment is
weak, but because under completion pressure self-assessment drifts toward the claim — measured, not
hypothesized, across seats and harnesses in one night, frontier included. You are not the
exception; you are the data.

### Writer-token operational consequences

A **Writer Token** names the single seat allowed to write a scope for a stretch of work; a
**Named-Resource Lease** does the same for one named resource a worktree cannot isolate — an artifact or a path. Both are
coordination records that make authorship a lookup — neither is a safety boundary. `/tap:drive` owns the
lane-holder custody actions.

**Technique: the passable writer token.** When multiple seats write one worktree, the team has had
consistent success assigning a single writer token per worktree, passed explicitly in a tap message.
One writer at a time turns "who changed this?" from an investigation into a lookup.

**The story that earned it** (tap-tlw): path-scoped claims looked sufficient — disjoint files. They
collided anyway, invisibly, on *generated files* their tools regenerated across any glob boundary.
Worse: the lanes were under evidence-grade gates, and any concurrent commit poisoned the whole-tree
evidence — *"did the eval pass because of, or despite, it?"* The token protects
**invariants-under-verification, not files** — checkable in one command (`git status` clean + HEAD
pinned).

**Your judgment, LEADER:** two DRIVERS on genuinely unrelated scopes? Skipping the token is a
legitimate call — cheap parallelism for the price of watching for collisions:
- *Failure signature:* unexplained diffs in files you didn't touch; a gate result you can't
  attribute to your own change.
- *Recovery moves:* git makes clobbers reversible — roll back, split into worktrees, or mint a
  named-resource lease. Stage slow work outside the tree and the strict token costs ~nothing.
- **Keep a mutable checkout stable while a check reads it.** Concurrent writes can invalidate
  its evidence across file boundaries. A CI run or review of a pinned commit uses a separate
  view, so local authoring can continue; cite the source identity the check actually read.

**The one-line hard kernel:** generated files cross glob boundaries silently — when in doubt, worktree.

**Tools:** explicit TAP ownership handoffs; `git worktree add/lock`; named-resource lease
(CONCEPTS). Catalog, not sequence.

The every-dispatch *consequences*:

- **Stage the slow work outside the tree.** Commit the finished output — freeze windows shrink to
  ~zero.
- **Named-resource escape hatch.** When two lanes need one shared resource, mint a deliberate
  named-resource lease per resource — definition in CONCEPTS.
- **Contention revisit trigger.** Writer windows exceeding ~30–45 min while another lane holds
  commit-ready work, more than a couple times a week → **move the hot lane to its own branch** (a
  branch is a path-scoped token whose verifier is the merge).

### Research dispatches

A gated task class: `routines/research-pass.md` owns the pass (brief scaffold, claim-level
verifier, calibration recipe) and the evidence. LEADER floors above it: the three-line brief
boilerplate on every research dispatch; **no consumer acts on unverified research** — the
family/effort routing table is hypotheses (tap-2nuf), no MUST cites it; eval before benching and
a one-instruction retrial before calibrating a seat down; tier preflight from rollout stamps;
**panel meta-pass your own syntheses** (the review ladder applies to doctrine: review a synthesis as you review code); human
spend gates on preregistered runs.

## Objective: money stays where the owner put it

The roster is a budget, not just a contact list. **No cheap lane? Ask the user to staff one and name
the saving** — a planning-time decision, not a mid-run scramble.

**Metered builds are owner-cleared, in one of three checkable shapes:** a direct instruction naming
the seat and the build ("have Kimi build this"), a named build assignment in the mission brief, or a
standing instruction in the repo — never the seat's own inference from being idle, capable, or
cheap that day, and never the LEADER's promotion on its own judgment. The why: an implementation
loop can exhaust a metered balance mid-lane and strand a wheel nobody else holds, while a review
that dies mid-pass is merely re-runnable. Routing around a down driver selects among *eligible*
seats — a stalled lane waits, splits, or escalates for an explicit metered assignment before it
lands on a metered seat.

### The spending envelope

The LEADER holds a target review budget and dispatches paid reviews on any seat's request or own
judgment, with no per-instance approval. Asking before every dispatch under-uses the budget; having
no bound over-uses it. The envelope is the middle: judgment moves freely inside it. Per-bot economics
matter: rate-limited-free bots (CodeRabbit class) have a *concurrency* envelope — stagger
dispatches, never burst, and otherwise use them liberally; metered bots have a spend envelope. Quota conversations happen at kickoff.
The hard edges stay with the owner: the envelope's size is the owner's, and seats never self-launch.
Spend routes through the LEADER because budget-holding is what makes the LEADER's judgment
accountable.

## Objective: coordination stays cheap

Teammates use AGENTS.md’s typed escalation classes. Drivers resolve routine implementation,
base updates and in-scope conflicts, then report evidence. The LEADER escalates to the human on a genuinely
human decision (`tap escalate -f <path>`, or `-f - <<'EOF'`). Under an armed watch, an exhausted probe chain escalates
machine-level — see `supervision.md`.

**The escalation valve, for your own hard edges:** when a boundary — the review budget, a
code-scope rule, a design requirement — is blocking the best version of the task, don't violate it
and don't quietly build the worse version either. The owner is reachable mid-run through the
escalation seat: send the constraint by name, the better path it blocks, the cost of staying
compliant, and your recommendation — then keep working everything the block doesn't touch. The
failure this kills is the wrap-up confession: "X would have been better, but the rules said no X."

When a seat's context quality threatens the run, load `/tap:context` before choosing leave-alone,
compact, clear, or restart. The LEADER compacts its own pane through `/tap:self`; remote context
commands use the allowlisted `tap command` transport. For harness rewind/resume recovery, follow
`/tap`'s all-seat liveness floor.

## Supervision: who holds the sentinel

Decide at kickoff who checks and what wakes you, not whether the run is attended.
`references/supervision.md` owns the recipes.

## Topic references (on-demand)

- `base-motion.md` — driver-owned rebases, retargets and evidence when a base moves.
- `supervision.md` — sentinel choice and recipes, `done_when` authoring, drift-peek mechanics.
- `routine-authoring.md` — the save-loop's authoring-gate detail.
