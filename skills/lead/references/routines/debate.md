---
contract: debate/v1
packet_extensions: [templates, order_templates, domain_phases, gates, post_processors, deliberation_content]
---

# Routine: debate

First-principles multi-proposal design debate under **anti-anchor** mechanics — the chart to reach for when a
mission names a design debate. Its job is to defeat *sycophantic alignment* (fast little tweaks around
an anchor) by making disagreement **legitimate, expected, and cheap**: a named adversarial lens, real
sign-off authority, and an explicit argue-back invitation (spec §3.6). Generic beyond any one domain;
a domain skill **invokes** /tap:lead with a domain packet — brief/rubric/packet
templates, domain phases, gates, post-processors — and never forks this routine. Source spine: the
originating design-debate run's retro and scribe log.

**Composition contract.** The routine consumes a **solution-free brief** (from an `interview` stage or
hand-authored) and produces a **decision packet**, a **scribe log**, and a **flip-tally**. The
orchestrator conducts the schedule; it never authors the content peers debate (content-free moderator).

## Goals

- Surface genuinely independent design proposals, then converge only through adversarial pressure and
  evidence — never through agents sounding satisfied.
- Make every position change **observable and grounded**: what moved it, what evidence, whose attack.
- Emit a human-ratifiable packet whose integrity (independence, citations, anonymized scoring) is
  auditable after the fact.

## Invariants (MUST)

- **Anchor-stripped brief, gated.** The brief carries the design QUESTION, constraints, and evaluation
  criteria — **never the LEADER's preferred answer or any proposer's draft.** The anchor *is* the
  sycophancy vector. Fix-wave briefs may carry rulings; a design brief must not. Enforced
  by a **brief-ratification gate before any proposer dispatch**: a solution-language scan (no
  proposed-architecture / preferred-solution section — the interview must not leak a sketch into
  constraints) plus a recorded chair attestation `anchor_stripped: true`; the orchestrator will not
  dispatch phase 2 until it passes.
- **Family diversity is binding-time enforced.** `families_min` (default **2**) is validated against
  the *resolved* roster — ≥2 model families among proposers and ≥2 among reviewers. A packet may raise
  it, never set it below 2. *(A comment can be dropped silently; an invariant cannot.)*
- **Blind generation.** N proposers commit GUT proposals independently with **research banned**; the
  orchestrator withholds every proposal until all land (the mechanical enforcement a human moderator
  forgets under load).
- **Falsifiable commitments (bounce gate).** Every proposal MUST state its **costs**, its **failure
  modes**, and **what evidence would change the author's mind** — critique needs handles, not vibes.
  An `every-deliverable-landing` gate on proposal landing structurally checks all three handles are
  present and non-empty and **bounces** any proposal missing one; the orchestrator never advances on a
  vibes proposal.
- **Context quarantine + mandatory attestation.** Every order carries a forbidden-path list (subagents
  inherit it); every deliverable ships an attestation listing every file read. Attestation is
  **mandatory whenever quarantine is on** (default).
- **Quarantined seats ban memory tooling by name; attestation carries the negative list.** Every
  quarantined-seat order bans memory/observation/transcript/prior-session tool use by name — the
  forbidden-tool list joins the order's forbidden-path list, and subagents inherit both. The mandatory
  attestation gains a **negative list**: the seat attests it used none of those tools, or discloses
  exactly which it used — and a disclosed self-chosen use bounces the deliverable, because it breaks
  the ban. It also discloses any exposure it observed that it did not choose, such as prior-session
  context a hook injected; only that involuntary exposure earns scoped discounting. A launcher-side
  check of hook state the harness genuinely exposes (config/env) is a SHOULD — defense-in-depth, never
  the load-bearing guarantee, because a seat cannot prove hidden harness/hook state from inside.
  **Evidence bound:** the negative list covers the seat's own tool use only. It cannot show that no
  hook supplied context — "used no memory tool" stays true when a hook injects context automatically.
- **Anonymized circulation, with a defined lifetime.** Proposals/amendments/critiques circulate with
  label maps (scribe-secret), attestations stripped, identity-tell sweeps, and latin-square reading
  orders; artifacts are re-anonymized per phase. **Masking ends at sign-off circulation** — opinions
  are attributed and verbatim in the packet; anonymized scoring is the last masked phase. Therefore
  `deliberation_window` re-dispatches are **post-unmask by construction**; only pre-sign-off gate-fix
  bounces stay masked and require **fresh circulation copies**.
  **The `anonymization` knob may tune the kit (label-map style, reading orders) but CANNOT disable
  pre-sign-off masking** — full anonymization through the scoring phase is a hard MUST, not a relaxable
  default; identity-visible circulation reopens model-hierarchy deference sycophancy.
- **Gate fixes settle before the next phase's circulation copies are cut.** A default (relaxation must
  be named in the surfaced setlist).
- **Evidence-line-mandatory scoring, orchestrator-only aggregation.** Bare numbers bounce; every score
  cites an evidence line; only the orchestrator aggregates, reporting **medians beside weighted means**.
  A default (relaxation named in setlist).
- **Critique-grounded REWRITE synthesis — never merge.** The synthesizer rewrites from the winning
  proposal, tracing every deviation and recording adopt/decline-with-reason harvests. A naive merge is
  the worst topology (the "Frankenstein effect"). **The synthesis gate is mechanical:** after N
  proposals, an empty rival-graft list AND an empty attack-changed-outcome list **fails the gate** —
  the synthesizer must show grafts or attack-driven changes, or carry an explicit `no-grafts:
  <justification>` the sign-off round must address. (A solution-free brief has no anchor artifact to
  diff, so the *provenance emptiness* is the checkable smell — not an "unchanged anchor".)
- **Anti-sycophancy guard is a mechanism, not a metric (prior art: an earlier review ledger) — and it is WIRED
  into the schedule.** The routine keeps a durable, **file-backed issue ledger** (an append-only event
  stream the orchestrator greps — not prose compliance); proposals, attacks, and evidence fold into it
  at the **amend (phase 4)** and **sign-off (phase 8)** boundaries. An evidence-bearing item cannot move
  rejected→accepted without an evidence reference **newer than the rejection**; the guard **replays at
  read time over the event stream at every evidence-bearing status transition**, so a forged line cannot
  bypass it. **Judgment/taste items are exempt** — conceding to a better argument is the point. This is
  the N-proposer generalization of that prior ledger loop; the routine owns a
  minimal file-backed stream, and the two-seat ledger with the same guard is `/tap:discuss`'s
  `skills/discuss/scripts/ledger.sh`. (Distinct from `deliberation_content`'s
  domain-supplied "third-party ledger", which is chair content, not this guard.)
- **Pre-registration.** Probes and secret label-maps are scribe-logged **before outcomes are known**;
  the log is what makes the run an experiment, not an anecdote. Every pre-registered validation also states:
  `Fails-if: <command + expected red>`
  `Contains: git merge-base --is-ancestor <fix> <head>`
- **Content-free moderator.** The orchestrator relays, runs schema/liveness gates, and quotes the brief
  verbatim when a proposer misreads — **law-quoting, never opining**: it re-states the brief's question
  and constraints verbatim, never a preferred solution.

## The phase machine

Ordered phases; each closes on a mechanical phase-boundary gate (grep/wc/ref-verify structural checks
by the orchestrator, content judgment left to peers). The orchestrator drives as **orchestrator**
(READ-DO-PROVE for its own steps; delegated DO-CONFIRM at each collection).

1. **Solution-free brief** — the anchor-stripped design question + constraints + evaluation criteria +
   the rubric. **Phase-1→2 gate (mechanical, blocks dispatch):** the brief-ratification check runs a
   solution-language scan and records the chair's `anchor_stripped: true` attestation; no proposer is
   dispatched until it passes.
2. **Independent GUT proposals (research banned)** — N family-diverse proposers, quarantined, withheld
   until all land. **Per-seat pre-brief ban, landing-gate checked (mechanical, not prose):** the
   launch order carries the forbidden-tool ban by name, and the seat's landing gate checks the
   attestation's negative list and observed-exposure disclosure are present — bouncing the
   deliverable when either is missing or the list names a self-chosen banned tool — alongside the
   existing costs/failure-modes/evidence handles.
   The gate checks that the disclosure exists, not that no hook injected context (see the evidence
   bound above). Then each proposal
   states its **costs, failure modes, and what evidence would change the author's mind** — bounced at
   its landing gate if any handle is empty.
3. **Verified research + cross-pollination** — at the named `post-gut-pre-circulation` boundary, run
   any inserted domain phase and pass its gates before cutting circulation copies. The default path
   then circulates proposals anonymized and allows research under a **verify-before-adopt** rule with
   anchor-quoted, machine-verified citations (`ref verify` gate). A domain packet may insert
   independent research here and require every memo to freeze before any rival option circulates.
4. **Amended proposals** — each author revises, and **every changed or held position names the argument
   that moved it** (a response record: conformity vs genuine-updating, decomposed). Amendments **fold
   into the issue ledger**; the anti-sycophancy guard replays here (no rejected→accepted without
   evidence newer than the rejection).
5. **Adversarial cross-round** — each proposer is assigned to **ATTACK** a specific rival (lens named —
   "shipped and failed, write the incident report" premortem framing) and to **STEELMAN** one it did
   not author. Role by definition, not disposition.
6. **Anonymized rubric scoring** — evidence-line-mandatory, orchestrator-only aggregation, medians
   beside means. This is the **last masked phase**.
7. **Critique-grounded synthesis by the top-scored author** — rewrite (never merge) with a
   traceability table; synthesis-with-provenance names which rival ideas were grafted and which attacks
   changed the outcome. The **synthesis-provenance gate is mechanical:** empty graft-list AND empty
   attack-changed-outcome list fails the gate, unless an explicit `no-grafts: <justification>` is carried.
8. **Sign-off / dissent round on the synthesis + author's response** — masking **ends here**; opinions
   are attributed and verbatim. Sign-off **folds into the ledger** (guard replays at read time), and any
   `no-grafts` justification from phase 7 must be addressed here. (A post-synthesis defect caught by an
   independent sign-off reader is exactly the counterweight "top-scorer synthesizes" lacks on its own.)
9. **(Optional) comparison vs a baseline** by a context-keeper (convergence = validation, divergence =
   classified findings), then **human decision over the packet.**

## Adaptation knobs

The normative packet vocabulary for a `debate` stage (validated per `packet-schema.md`):

- `proposers` — N; the resolved roster MUST satisfy `families_min`.
- `families_min` — minimum distinct model families in the resolved roster; **default 2, raise-only** (a
  packet may raise it, never set it below 2). Enforced at binding time against the resolved roster.
- `research_policy` — per-phase (e.g. `{gut: banned, amend: verified-only}`).
- `cross_pollination_rounds` — count of amend/attack rounds.
- `anonymization` — default **on**; tunes the **kit only** (label-map style, tell sweeps, latin-square
  reading orders) and **cannot disable pre-sign-off masking** (the MUST above — not an off-switch).
- `scoring` — method; the evidence-line-mandatory + orchestrator-only-aggregation **default** stands
  unless relaxation is named in the surfaced setlist.
- `synthesis` — assignment rule (default: top scorer rewrites, critique-grounded).
- `deliberation_window` — `{keep_warm: bool, max_redispatch_rounds: N, redispatch_scope:
  amendment|hardening|either}` (seam below).
- `phase_gate_tolerances` — per-boundary gate strictness.

**Four run-proven defaults** (knob-able, but relaxing one MUST be named in the surfaced setlist — the
named-deviation discipline): gate-fixes-settle-before-copies-cut · memory-tool ban + negative attestation under quarantine ·
attestation-mandatory-with-quarantine · evidence-line-mandatory-scoring + orchestrator-only-aggregation.

## Primitives that ride inside the routine

Reference material, not separate contracts (no new `tap` CLI verb):

- **Work-order grammar** — self-contained orders (survive seat resets); an exact deliverable schema
  **including output formats downstream tools parse** (specify citation layout — don't assume; two
  round-trips were lost to format drift); a one-line signal contract (`<PHASE> READY <path>` /
  `BLOCKED: <reason>` / `FIXED`).
- **Mechanical phase-boundary gates** — structural checks by the orchestrator; content judgment to
  peers.
- **Anonymization kit** — label maps (scribe-secret), attestation stripping, identity-tell sweeps,
  latin-square reading orders, per-phase re-anonymization.
- **The idle stack** — harness goal (mission persistence + escalation policy + artifact-based
  done_when) + **absolute-path** file-watch monitor (armed at dispatch time, always — the goal alone
  churns evaluator wakes; timeout doubles as stall alarm; TaskStop the zombie watcher the moment its
  push-signal sibling fires) + TAP push sentinels.
- **Scribe-log discipline** — decisions-with-rationale, anomalies, and costs at phase boundaries;
  payload-id references, never content copies; pre-registration as above. This log is the reflection
  substrate the unified save-loop consumes (spec §0).
- **Quarantine mechanics** — forbidden-path lists in every order (subagents inherit); the
  forbidden-tool ban (memory/observation/transcript/prior-session) joining those lists; mandatory
  attestation with a negative tool list; launcher-side config/env checks are a SHOULD, never the
  load-bearing guarantee.
- **Incident tolerances** — all state in files + repo-side logs (bus payloads are expendable); know the
  per-harness stuck-seat recovery recipes; re-register seats idempotently after registry loss.

## Domain plug-in points (`packet_extensions`)

The domain supplies content; the routine runs the mechanical schedule around it. Root keys validate
against BASE ∪ these (per `packet-schema.md`):

- `templates` — brief / rubric / packet template reference paths. **Path bindings resolve from the
  DOMAIN skill's directory, never /tap:lead's repo.**
- `order_templates` — verbatim work-order lines the routine folds into seat orders.
- `domain_phases` — `{phase, at: <named boundary>, when: <slot-presence condition>, contract: <domain
  ref path>}`; may insert at ANY named gate boundary, including `post-gut-pre-circulation` and post-sign-off (e.g. comparison-vs-
  baseline when a baseline slot is filled). The `contract:` pointer is a plain path, **no version
  semantics.**
- `gates` — two anchor kinds, both blessed: **phase-boundary** gates (once per boundary) and
  **landing-event** gates keyed on `every-deliverable-landing` (fires on ANY quarantined-phase
  deliverable landing — proposal, amendment, scores, synthesis, opinion). Entries take args, e.g.
  `{at: every-deliverable-landing, check: quarantine-attestation-present}` or `{at: amend-landing,
  check: ref-verify-clean, format: flat-citation-list}`. Enforce PASS-before-advance.
- `post_processors` — artifact transforms with no fan-out: `{after: <gate>, before: <boundary>, run:
  <domain ref>, contract: <domain ref path>}` (e.g. a house-style pass after the synthesis gate, before
  sign-off circulation). Seats sign off on the post-processed artifact. *(A post-processor is not a
  `domain_phases` entry — a phase is choreographed with seats/dispatch/gates; a transform has no
  fan-out; conflating them is the handles-both-shapes smell — v0.2.)*
- `deliberation_content` — everything the chair deliberates (amendment tally, third-party ledger,
  hardening-round criteria, when to spend a re-dispatch): a domain-supplied reference. Fails loud with
  no `debate` stage in the setlist.

## Seam ruling — seats that stay registered (`deliberation_window`)

Split by *conduct the schedule, never the content*:

- **The routine owns the MECHANISM:** the `deliberation_window` knob — seats staying registered past
  sign-off with a bounded re-dispatch budget (seat-lifecycle choreography, generic beyond any domain).
  It interacts with routine-owned machinery (idle stack, quarantine, and the anonymization lifetime —
  re-dispatch during deliberation is post-unmask by construction, so the routine states when labels
  unmask).
- **The domain owns the CONTENT:** what the chair deliberates, arriving as `deliberation_content`.

## Outputs

- **Decision packet** — proposals + attacks/steelmen + anonymized scores + synthesis-with-provenance +
  sign-offs/dissents + author responses. (A domain may render it — e.g. an HTML packet — via a
  `post_processor`.)
- **Scribe log** — pre-registration + per-phase record; the save-loop's reflection substrate.
- **Flip-tally** — position changes per seat, so **calibration is observable rather than remembered**:
  a seat earns design-panel weight by flipping or reshaping with evidence; a stretch of contrarian
  nitpicks or reflexive agreement downweights it (standing rule, generalized — spec §3.6).
