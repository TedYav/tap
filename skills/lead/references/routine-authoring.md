# Routine authoring — the save-loop's authoring gate

The charter's save-loop points here for the authoring detail. A liked setlist becomes a reusable
routine through this gate. **Landing is always through the normal branch+PR ladder** — never a direct
write into a live checkout's `references/routines/`, because directory symlinks make the file live for
every seat the instant it exists.

## Author from the record on disk, never memory

Author the routine from the run's **scribe-log / setlist record on disk**, not conversational memory —
a routine written from memory launders unverified belief into a reusable contract. This is the same
reflection-substrate discipline a debate's scribe log serves.

## Shape: goals + invariants + adaptation-knobs

- **Goals** — what the routine achieves.
- **Invariants (MUST)** — properties that cannot be knobbed away (e.g. an elicitation gate's timeout
  MUST). Relaxing a *default* must be named in the surfaced setlist (the named-deviation discipline).
- **Adaptation knobs** — the enumerable, normative vocabulary `packet-schema.md` validates packets
  against; this is the routine's declared `knobs` section.
- Tag each element **MUST / SHOULD / BONUS**, and carry **evidence tags** (which run, which incident
  taught it) so a reader can trace every rule to its grounding.

## Gates: placement and clearer (MUST)

*Harvested 2026-09-02 from an unmerged PR branch (head `d5caa94ba`). Taken as ADDITIONS only:
that branch predates this file's QC-recipe and terminal-path sections, so its diff against `main`
reads as deleting them. Nothing below removes or edits existing guidance.*

**Two senses of "placement" now live in this file, and they are unrelated.** This section places a
**gate** within a routine's run; `## Placement (mechanical)` below places a **draft file** on
disk. Neither constrains the other.

A routine's gates are **edges, not steps** — each one belongs to a stage transition, and each declares two things the authoring gate validates.

**1. Placement derives from what a NO invalidates (MUST).**

Gates drift late because placement follows the wrong cost. The cheap-to-*run* moment and the cheap-to-*absorb-a-NO* moment sit at opposite ends of a run. Author from the second:

> For each gate, name the work a NO throws away. Place the gate immediately before that work starts.

|Gate asks|A NO invalidates|Belongs at|
|---|---|---|
|Should this exist?|everything|brainstorm entry|
|Is this the right design?|the implementation|plan exit|
|Is this over-built?|the abstraction|plan exit|
|Is this correct?|the code|review|
|Does the title read well?|the title|pre-merge — correct as-is|

Declaring `invalidates` makes placement a derivation rather than a taste argument: a gate whose `invalidates` names work that has already happened is mechanically mis-placed, no judgment call required.

**Corollary (SHOULD): early gates must be nearly free.** An expensive early gate gets skipped under deadline, which silently converts it back into a late gate — the failure this rule exists to prevent, re-entering through the back door. A one-sentence question ("what present requirement makes this variability necessary?") can live at the front; a subagent fleet cannot. Late gates may be expensive.

[evidence: 2026-08-08 — a scope check proposed just before squash, after the branch was built and verified, when rejecting the work would discard the full implementation and the gate no longer offered a practical decision.]

**2. Every gate declares its clearer (MUST).**

Autonomy and gating are in tension: a gate the acting seat can clear itself is decoration. So each gate names who clears it:

- `self` — mechanical and verifiable (verify green, lint clean, schema validates). Safe to clear autonomously; no second seat needed.
- `peer` — a decorrelated seat answers. Scope, over-build, adversarial conformance.
- `human` — scope changes, design forks, and anything that discards information irrecoverably.

This is not a new authority tier. It generalizes the charter's existing `MUST implement nothing before the final gate` from one gate to all of them, and composes with the register system rather than adding to it.

The pre-squash miss was not only late — it was **self-held**. The seat asking "should we have built this" was the seat that built it. Same question, different instrument, depending on who holds it: early + peer-held is a check; late + self-held is a ritual.

[evidence: same run. Related prior art: `design-adjudication.md`'s designer-never-implements rule is this principle applied to one stage; `conformance-pass.md`'s peer-addressable service is the `peer` clearer's transport.]

**3. The fake-gate test (MUST, authoring-time).**

> If no possible verdict changes the next step, delete the gate.

Applied at authoring time, this is what keeps the gate vocabulary from bloating as routines accumulate. It independently catches the pre-squash case above: at that seam, neither verdict changed what happened next.

**4. Blocking discipline (MUST).**

A gate at a **phase exit blocks**; every other gate runs alongside and interrupts only on a finding.

Non-blocking phase-exit is exactly the pre-squash miss: the finding arrives after the phase it was meant to gate, when its answer no longer changes anything. Blocking is affordable precisely because placement rule (1) already put phase-exit gates early, where they are cheap — 3–5 per routine.

This names a pattern the charter already has rather than introducing one: `/tap:lead`'s setlist veto and amendment re-arm *are* blocking phase-exit gates, and the scribe log and narration already ride alongside.

**Sequencing corollary (SHOULD):** an owed item never waits behind an optional one — two correctly-placed gates can still sequence wrongly when must-ship work queues behind a discretionary decision to save a batch. Batching economics do not outrank owed work.

[evidence: 2026-08-09 — two must-ship fixes waited three heartbeats behind an optional scope decision while the related review threads continued to block the PR.]

## Knob vocabulary

Two keys on the existing stage vocabulary. No new file type, no parallel artifact:

- `invalidates` — the work a NO throws away. Placement derives from this and is never declared separately.
- `clearer` — `self` | `peer` | `human`.

Blocking is derived, not declared: a gate at a phase exit blocks; everything else rides alongside.

[source_run: merged 2026-08-08 as e8e284567]

## Frontmatter stamp

The gate stamps: `date`, `source_run` (evidence pointer to the originating run), `contract:
<name>/draft`, and the declared `packet_extensions`. A `draft` template is surfaced **as draft** in
any shelf selection until it is ratified to `/v1` through a PR. Selecting it follows `/tap:lead`’s
plan and decision boundaries; draft status adds no routine permission step.

## Delegating the draft — the QC recipe

The economics are the reason: a cheap seat fills a template well, and the expensive attention
belongs on routing, the contract, and the check. But a delegated draft is only as good as the
verification, and the verification has one hard rule. [absorbed from a retired briefing skill]

**Hand the maker a written contract, not a vibe.** The dispatch carries the template or shape
verbatim, the filled slot table, any localization rules the target repo imposes, and these
terms: mint a run id; write the finished artifact to a named path and return that path; every
slot replaced; no meta-commentary inside the artifact; concrete enough that a **fresh session
with no other context** could execute it.

**Verify FROM THE SAVED ARTIFACT, never from the maker's message.** Read the file. The message
is a report about the file, and a report is exactly what a confused maker produces most
confidently. Two checks, both cited:

- **Placeholder sweep.** Grep the saved file for the slot shape (`\[[a-z_]+\]`), then **drop
  any match immediately followed by `(`** — that is markdown link text like `[docs](path)`,
  not an unfilled slot — and report the remaining count. Skipping the exclusion produces a
  false red on every well-linked draft, which trains the checker to wave the check through.
- **Rule-by-rule quoting.** For each localization or adaptation rule, **quote the draft line
  that satisfies it**, or state **N/A with a one-line reason**. A rule with neither a quote nor
  a reason has not been checked, whatever the summary says.

**A failing draft goes back to the maker with the specific defect — never hand-patched
silently.** Patching it yourself spends the attention you delegated to save, and it destroys
the only signal you had about whether the contract was clear enough to reuse.

## Terminal-path discipline

Not every path through an authoring or briefing routine ends in the same place, and the
difference is who has to say go. [same source]

- **A read-only path may run on identification.** A pass that only inspects and reports costs
  a human round-trip to authorize and cannot damage anything — run it and return the result.
- **Every mutating path blocks on an explicit go.** Writing, executing, or landing waits for
  the human to say so. Default to handing back when they have not said; when they choose
  execute-now, name the tradeoff — a fresh session starts clean, this one carries the
  interview exhaust into execution.
- **A terminal redirect stops cold.** When the right answer is "this repo already has a native
  mechanism for that", point at it and **stop** — no partial slot-filling, no draft file, no
  "while I'm here". A half-run beside the real mechanism is worse than no run: it produces a
  second artifact that looks authoritative and is not.

## Slot design and localization rules (borrowed shape)

Two structural moves from Every's **Fable 5 Operating Pack** are worth carrying into any template a routine hands to a maker:

- **Every slot declares `ask` or `infer`.** The template itself says which slots the repo and
  session can answer (paths, gates, existing constraints, current context) and which need the
  human (the problem, what good looks like, the definition of done, deadlines, checkpoints).
  That one hint per slot is what keeps a delegated fill from interviewing the human about
  facts sitting in the repo — and from inferring the judgment calls that were never yours.
- **The library carries its own localization rules, at the top.** A template pack written
  elsewhere names other repos' pipelines, tools, and boundaries. Putting the substitutions in
  one numbered block at the head of the library — applied by the maker, verified line-by-line
  by the checker — beats scattering local caveats through every template in it, and it gives
  the QC pass above something enumerable to quote against.

## Placement (mechanical)

A draft that names a product, schema, or business entity → the **domain repo**; otherwise →
`references/routines/` (machine-shared). Two agents must reach the same destination for the same
draft.
