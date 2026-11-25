# Staffing — the six axes, in full

Loaded when the form is not obvious from the four defaults in the `staff-the-run` play
(`../plays/staff-the-run.md`), which carries the four forms, their defaults, and the visibility floor.
This file carries the axis table that resolves a case the defaults do not, the exceptions behind each
axis, and the delegation, writer-token and spending detail behind that play.

## The narrowing rule

Each axis **narrows the candidate set rather than naming a winner** — read every axis the work
touches and stop when exactly one form is left. An axis that excludes nothing has simply not bound
yet; two forms still standing means there is an axis you have not asked. An empty set is never a
missing form, it is a mis-asked question: one pass plus "must survive a restart" mis-reads the
lifetime, and one pass plus landing commits is the procedure telling you this is an across-waves
DRIVER.

| Axis | The question | What it excludes |
|---|---|---|
| **Lifetime** | One pass, or a role held across waves? | One pass excludes the launcher-managed seat, keeping subagent, burst engine, and crew. Across waves excludes all three of those. |
| **Cardinality** | One worker, or a parallel fan-out of schema'd workers inside one lane? | One worker excludes the burst engine. A fan-out excludes the bare subagent, leaving a burst engine its lane's seat drives. Binds only while both are still standing — which is exactly when nothing else separates them. |
| **Write surface** | Read-only, isolated scratch, or commits landing in a lane? | Landing commits excludes every non-DRIVER form — subagent, burst engine, and crew alike — leaving a DRIVER holding that worktree's writer token. Read-only or `isolation: worktree` scratch excludes nothing by itself. |
| **Addressability** | Must teammates reach it by name, or its output arrive as bus traffic? | Yes excludes subagent and burst engine, neither of which carries a Seat handle. No — a returned artifact is enough — excludes the crew: a bus address nothing uses is a pane and a registry row for nothing. |
| **Attention** | Must you be able to type into it or consult it *while it works* — does it need an interactive surface of its own? | Yes excludes subagent and burst engine: you can read their progress, but there is nothing to address mid-flight. No excludes nothing by itself. Wanting to *watch* is not this axis — every staffed form is watchable under the floor. |
| **Restartability** | Must it survive a restart under the same handle? | Yes excludes every form but the launcher-managed seat: a crew's life is its pane, and a subagent or burst worker has no handle to restart under. No excludes nothing by itself. |

**Write surface does not compete with lifetime; it splits the seat.** Lifetime decides whether you
need a long-lived seat at all — write surface then decides *which kind*: a seat that lands commits is
a DRIVER holding its worktree's writer token, a seat that only reviews or advises is a consult seat
holding none. Reading the two as rivals is what flattens a standing consult seat and a feature lane
into one undifferentiated "team seat".

## API-rate seats and the DRIVER form

A metered seat — one billed per token or per credit rather than through a subscription harness — is
eligible for consult and review forms only; assigning it the DRIVER form (or any open-ended
implementation loop) requires the human to name the build explicitly. Two rationales, either
sufficient on its own — reasons the rule exists, not authorization paths; authorization has exactly
the three checkable shapes enumerated in § "The spending envelope" below
(direct instruction naming seat and build, named assignment in the mission brief, or
a standing repo instruction — never the seat's own inference).

**Economics.** Implementation is an open-ended token loop; review is bounded. A metered seat can
exhaust its balance mid-lane, and the stop arrives at the worst moment by construction: the loop
that exhausts the seat is the unfinished work it holds, so recovery costs a live reassignment on top of
the spend. In one observed case, four commits landed before the balance ran dry on the
fifth. Later wakes returned insufficient-balance refusals, and another seat completed the
lane while the unavailable seat's queue still held an unsettled payload.

**Calibration.** Metered seats accumulate their evidence in review registers — a strong charter, a
clean audit, a textbook alert — and none of that is evidence of a build register; the failure
surfaces barely overlap. An idle metered seat is not thereby qualified: in the case above, a
busy calibrated seat absorbed the remaining work in twenty minutes, which is the measure of
what the metered assignment had been buying.

## Parallel writes into one tree

**Optimistic and permitted**, and how to scope and schedule them is the
lane's judgment, not the LEADER's to prescribe. Weigh the occasional recoverable collision against a
per-run isolation tax; don't bottleneck a lane for exclusivity its work does not need. A path scope is
a coordination record, never the isolation boundary.

**What that model accepts, stated so you can recognise it:** seven parallel in-session subagents on
declared-disjoint files in one worktree once collided three ways — tool-driven rebuild storms that
reset a verifying teammate to step one, a pre-commit stash/pop that swallowed every sibling's
in-flight work, and one agent running `git stash`, reverting the whole tree mid-work. **None was a
file-overlap collision**; all three were tree-global operations (`git` state, the index, broad tool
globs) that no path scope partitions. Announce those before running them, and treat any of them as the
signal to suspect thrashing.

**On suspected thrashing, the LEADER coordinates** — serialize, re-scope, or split lanes into separate
trees for the duration. A lane that suspects thrashing escalates immediately rather than working
around it quietly; silent workarounds are what turn a recoverable collision into an investigation.
Writer Tokens and explicit TAP ownership agreements remain available as the declaration and
negotiation mechanism — techniques a lane may reach for, not a gate it must pass.

## Model tier

Before staffing or briefing, read `tap calibrate`.

Use the mission's explicit model assignments and AGENTS.md's current staffing directive. Record harness, exact model@effort and relevant service/context/environment qualifications in the plan. Use `tap presets` for saved recipes and `tap team` for who is seated. Saved recipes do not verify account access. Launch a supported combination directly with `tap launch <harness> [name] --model <id> --effort <level>`; OpenCode and Cursor accept model only. Preserve explicit user assignments across launches and resumes.

A bigger window needs no `-big` preset row. Claude: `tap launch opus <name> --env CLAUDE_CODE_AUTO_COMPACT_WINDOW=700000` sets the auto-compaction window (the env replaces the preset's value); it is capped by the model's own context window and does not raise it. Codex sets the context window and its compaction limit: `tap launch astra <name> -- -c model_context_window=700000 -c model_auto_compact_token_limit=600000` — the two keys move together; they are appended after the preset's own values, and whether Codex honors the later duplicate `-c` is unverified, so confirm the effective window in the launched seat before relying on it. The same `--env` / `--` tail works on `tap session relaunch <name>` for a durable seat; a crew seat refuses overrides on relaunch. Per-harness knob names and spellings: `skills/tap/config/harness-knobs.toml`.

## Where the rest lives

Per-form boundaries are tabulated in the `staff-the-run` play; what each form owes once staffed is
`/tap`'s staffing floor; lane custody is `/tap:drive`.

## Delegation detail

Bare/poll registrations are transport-only. Default complex writers to separate DRIVER worktrees;
only the Writer Token section below permits unrelated DRIVERS to share. Never parallel subagents or
crews: disjoint files and no-stash rules are not isolation.

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
  blank spawn hasn't absorbed the team's beliefs. Subagents run a 5-minute cache TTL even on
  subscription, so batch fan-outs concurrently; and each worktree builds its own cache prefix, so
  disposable per-task trees pay a cold start every time.
- **Plan-time delegation contract** — for plan-driven runs you design, the discipline lives in the
  plan (prose judgment decays under load; plan text doesn't argue back): every Delegation row names
  `Executor · Tier / spend reason · Subagent fan-out · Return artifact · Lead gate`, and lead-tier
  lanes are proposed to and confirmed by the user at planning time. A plan that already names who
  builds and who reviews is not reopened to fit this table.
- **Staffing memory:** at staffing, read each active candidate's `Route` plus its
  latest two dated observations from `~/.tap/seat-calibration.md`.
  Inspect frontmatter for at most five newest non-archived drops in `~/.tap/ingest/` that match the
  current repo or the `staffing`, `handoff`, or `gate` tags, opening bodies only when relevant.
  Missing or malformed material warns visibly but does not block staffing; the LEADER owns the judgment.
- **Visibility floor** (authority boundary): every agent stands where the
  operator can find it — subagents inside your harness, crews as a window of the operator's tmux
  session, launcher seats in their own `<team>/<handle>` session — never an anonymous tmux session.
  `/tap` owns the full statement and the pane-less-infrastructure exemption.

**Research dispatches** are a gated task class: `routines/research-pass.md` owns the pass (brief
scaffold, claim-level verifier, calibration recipe) and the evidence. LEADER floors above it: the
three-line brief boilerplate on every research dispatch; **no consumer acts on unverified research**
— the family/effort routing table is hypotheses (tap-2nuf), no MUST cites it; eval before benching and
a one-instruction retrial before calibrating a seat down; tier preflight from rollout stamps;
**panel meta-pass your own syntheses** (the review ladder applies to doctrine: review a synthesis as
you review code); human spend gates on preregistered runs.

## Writer token

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

## The spending envelope

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

The LEADER holds a target review budget and dispatches paid reviews on any seat's request or own
judgment, with no per-instance approval. Asking before every dispatch under-uses the budget; having
no bound over-uses it. The envelope is the middle: judgment moves freely inside it. Per-bot economics
matter: rate-limited-free bots (CodeRabbit class) have a *concurrency* envelope — stagger
dispatches, never burst, and otherwise use them liberally; metered bots have a spend envelope. Quota conversations happen at kickoff.
The hard edges stay with the owner: the envelope's size is the owner's, and seats never self-launch.
Spend routes through the LEADER because budget-holding is what makes the LEADER's judgment
accountable.
