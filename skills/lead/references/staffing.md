# Staffing — the six axes, in full

Loaded when the form is not obvious from the four defaults in the charter. The charter carries the
interface: four forms, the narrowing rule, the defaults, and the visibility floor. This file carries
the axis table that resolves a case the defaults do not, and the exceptions behind each axis.

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
the three checkable shapes enumerated in `choreography-best-practices.md` § "money stays where the
owner put it" (direct instruction naming seat and build, named assignment in the mission brief, or
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

Use the mission's explicit model assignments and AGENTS.md's current staffing directive. Record harness, exact model@effort and relevant service/context/environment qualifications in the plan. Consult `tap models` for personal calibration or qualified reference guidance and `tap team calibration` for reachable seats. Reference guidance does not verify account access; saved presets are optional recipes. Launch a supported combination directly with `tap launch <harness> [name] --model <id> --effort <level>`; OpenCode and Cursor accept model only. Preserve explicit user assignments across launches and resumes.

A bigger window needs no `-big` preset row. Claude: `tap launch opus <name> --env CLAUDE_CODE_AUTO_COMPACT_WINDOW=700000` sets the auto-compaction window (the env replaces the preset's value); it is capped by the model's own context window and does not raise it. Codex sets the context window and its compaction limit: `tap launch astra <name> -- -c model_context_window=700000 -c model_auto_compact_token_limit=600000` — the two keys move together; they are appended after the preset's own values, and whether Codex honors the later duplicate `-c` is unverified, so confirm the effective window in the launched seat before relying on it. The same `--env` / `--` tail works on `tap session relaunch <name>` for a durable seat; a crew seat refuses overrides on relaunch. Per-harness knob names and spellings: `skills/tap/config/harness-knobs.toml`.

## Where the rest lives

Per-form boundaries and lifecycles are tabulated in `choreography-best-practices.md` (*Staffing and
dispatch*); what each form owes once staffed is `/tap`'s staffing floor; lane custody is
`/tap:drive`.
