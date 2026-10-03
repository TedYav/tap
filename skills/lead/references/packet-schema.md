# Packet schema — the /tap:lead invocation surface

A **packet** is how a caller invokes `/tap:lead`: a proposed **setlist** plus per-stage
parameterization. Domain skills *invoke* /tap:lead with a packet — they never
fork it. The leader may amend the setlist under `/tap:lead`’s autonomy and plan-before-writing rules;
only an actual typed decision or explicit user-requested hold blocks dispatch.

This file is the **single home** for the packet vocabulary that the charter's *Fail-loud on
contract drift* rule validates against. It defines nothing behavioral the charter does not already
name; it enumerates the vocabulary so validation is mechanical, not eyeballed.

## BASE keys (charter-owned)

Every packet's root keys are drawn from these three plus the extensions of the routines its setlist
names (below). BASE keys:

| Key | Meaning |
|---|---|
| `mission` | one-paragraph ask, verbatim from the human where possible |
| `setlist` | ordered/parallel stages (typed below); the LEADER's amendable proposal |
| `artifact_contract` | what the final artifact must contain (schema or template ref) |

**No version machinery.** There is no `contracts` pin map: /tap:lead and its consumers evolve as **two
independent axes** — a consumer never ships a version pin. Each routine's frontmatter
`contract: <name>/v1` is an informational **edition stamp** only — it carries no comparison
semantics and exists so a knob rename can be communicated via an old→new map on the land ping.
Fail-loud catches *shape* drift (unknown routine, unknown key/knob); *version* drift is handled
out-of-band by SHOULD-tier preflight adaptation, never a fail-closed pin.

## Stage typing — exactly-one-of

Each `setlist` stage carries **exactly one** discriminator. Only a `routine:` stage carries
`knobs` (validated below); a `skill:` stage carries the skill's native arguments and a `work_order:`
stage its order fields — pass-through to their owning target, never /lead-validated:

| Discriminator | Stage is… |
|---|---|
| `routine: <name>` | a `references/routines/<name>.md` chart |
| `skill: <name>` | an existing skill invocation (e.g. a planning or plan-finalization skill) |
| `work_order: <ref>` | a delegated work order to a teammate/lane |

Zero discriminators or more than one on a stage → **fail-loud**. A planning skill is a `skill:`, never a
misspelled `routine:` — the unknown-routine rule (below) applies only to `routine:` stages.

**Artifact handoffs.** A setlist is **ordered/parallel** — not strictly linear; parallel siblings do
not consume each other. Each stage produces one **named** output artifact, and handoffs run **per
dependency edge**: each downstream stage consumes the named output(s) of its prerequisite stage(s),
and the terminal output conforms to `artifact_contract`. The handoff is a *named artifact*, not a
packet key — a `routine:` stage's output is that routine's declared Output (interview → the filled
brief), a `skill:` stage's output is that skill's known deliverable, a `work_order:` stage's output
is the return artifact the order names. The lead states these handoffs when it surfaces the strategy's
phases as plain prose (the charter's strategy section, element 1); the packet YAML carries no
handoff key and needs none (the v0.2 Appendix A packet has none and still hands interview's brief
to debate).

**Stage completion is run-state.** A completed leading stage **stays in the packet** — completion is
a dispatch fact, not a packet edit — so the packet's vocabulary derivation (root keys and
`packet_extensions`) stays stable across re-validation; only routing/dispatch advance past it. This generalizes beyond interview: any completed leading stage, including a completed debate stage, follows it.

## Per-routine `packet_extensions` (two-tier vocabulary)

Root keys validate against **BASE ∪ the `packet_extensions` of the routines the setlist actually
names** — not a global union. Each routine declares its extensions in its own frontmatter. Known
extensions:

| Routine | `packet_extensions` |
|---|---|
| `interview` | `domain_slots` |
| `debate` | `templates`, `order_templates`, `domain_phases`, `gates`, `post_processors`, `deliberation_content` |

An extension key present with no routine that declares it — `deliberation_content` when no `debate`
stage is in the setlist — is **as fail-loud as a typo'd key**. This is what keeps a stray key from
silently doing nothing.

## Per-stage knob scoping

A stage's `knobs` validate against **that stage's routine's declared knobs vocabulary only**. A knob
valid under `debate` (`proposers`, `anonymization`, …) is *unknown* under an `interview` stage.
Never nearest-match; never silently drop a knob — a dropped knob is artifact drift wearing success.

This per-stage validation applies to **`routine:` stages only** — /tap:lead owns the routine knob
vocabulary. A `skill:` stage carries the skill's own arguments and a `work_order:` stage carries the
order's own fields; /tap:lead passes these through and does **not** validate them against a routine
vocabulary — the skill or the work-order owns that schema and fails loud on its own bad input.
/tap:lead validates exactly what it owns.

## Validation order (mechanical summary)

1. Each stage: **exactly one** discriminator — else fail-loud.
2. Each `routine:` resolves to a **known routine** — else fail-loud (name it, list available
   routines).
3. Root keys ⊆ **BASE ∪ extensions(routines named in setlist)** — else fail-loud (name the key).
4. Each **`routine:`** stage's knobs ⊆ **that routine's knobs vocabulary** — else fail-loud (name
   the knob). `skill:` / `work_order:` params are pass-through to their owning target — not validated
   here.

No nearest-match substitution and no silent knob-dropping at any step.

## Example packets (verdict-labeled)

These are the normative fixtures. A cold panel seat executes this verdict table; the structural
smoke asserts the examples and their labels are present. **No validator ships in this PR** — the
schema/validator is deferred scope; these examples plus the charter's prose are the contract.

### 1 · VALID (green) — interview-only

The only runnable-valid shape in this PR (the sole routine that lands here is `interview`):

```yaml
mission: <one-paragraph ask, verbatim from the human where possible>
setlist:
  - routine: interview
    knobs:
      probing: gap-lens
      provenance_tags: on
      timeout_policy: repo-explicit-invitation-gate
artifact_contract: <schema or template ref for the filled brief>
domain_slots:
  - {slot: <domain-mandatory-slot>, mandatory: true}
  - {slot: <domain-advisory-slot>, mandatory: false}
```

**Verdict: VALID.** One stage, one discriminator; `interview` is known; root keys ⊆ base ∪
interview's `domain_slots`; knobs ⊆ interview vocabulary. Runnable this PR.

### 2 · VALID — interview → debate

The reference consumer's canonical main path, at **full source cardinality** — every slot,
gate-anchor kind (landing-event AND phase-boundary), and nested knob field preserved; only domain
nouns are abstracted to placeholders (this library carries none). Now that `debate.md` ships (tap-zgo),
this setlist resolves:

```yaml
mission: <chair's design ask, verbatim>
setlist:
  - routine: interview
    knobs: {probing: gap-lens, provenance_tags: on, timeout_policy: repo-explicit-invitation-gate}
  - routine: debate
    knobs:
      proposers: 4
      families_min: 2                # default 2, raise-only
      research_policy: {gut: banned, amend: verified-only}
      anonymization: on
      scoring: {evidence_lines: mandatory, aggregation: orchestrator-only, medians: reported}
      synthesis: top-scorer-rewrites-critique-grounded
      deliberation_window: {keep_warm: true, max_redispatch_rounds: 1, redispatch_scope: either}
artifact_contract: <normative artifact template ref>   # MUST
templates: {brief: <domain brief ref>, rubric: <domain rubric ref>}   # resolve from the DOMAIN skill dir
order_templates: [<verbatim work-order line folded into seat orders>]
domain_slots:
  - {slot: <domain-mandatory-slot-1>, mandatory: true}
  - {slot: <domain-mandatory-slot-2>, mandatory: true}
  - {slot: <domain-advisory-slot>, mandatory: false}    # defaults to a domain-supplied ref
  - {slot: <domain-baseline-slot>, mandatory: false}    # presence inserts the comparison phase
  - {slot: <domain-nongoal-slot>, mandatory: false}
domain_phases:
  - {phase: <independent-research-phase>, at: post-gut-pre-circulation, when: always, contract: <domain-phase ref>}
  - {phase: <domain-comparison-phase>, at: post-sign-off, when: baseline-present, contract: <domain-phase ref>}
gates:
  - {at: every-deliverable-landing, check: <attestation-check>}          # landing-event gate (any deliverable)
  - {at: amend-landing, check: <ref-verify>, format: flat-citation-list} # landing-event gate (amendments)
  - {at: pre-scoring, check: <brief-conformance-check>}                  # phase-boundary gate
post_processors:
  - {after: synthesis-gate, before: sign-off-circulation, run: <house-style-pass>, contract: <post-processor ref>}
deliberation_content: <deliberation-support ref>
```

**Verdict: VALID.** Both routines are known; each stage's knobs ⊆ its routine's vocabulary; root keys
⊆ base ∪ interview's `domain_slots` ∪ debate's extensions (`templates`, `order_templates`,
`domain_phases`, `gates`, `post_processors`, `deliberation_content`). The interview stage hands its
filled brief to debate. This is the reference consumer's canonical interview→debate main path — with `debate.md`
shipped (tap-zgo), the provisional unknown-routine window is **closed**.

### 3 · FAIL-LOUD — unknown root key

```yaml
mission: <ask>
setlist:
  - routine: interview
    knobs: {probing: gap-lens}
notes: "run this fast"        # <- unknown root key
```

**Verdict: FAIL-LOUD.** `notes` is absent from BASE ∪ interview's extensions. No nearest-match —
stop and name `notes`.

### 4 · FAIL-LOUD — unknown knob

```yaml
mission: <ask>
setlist:
  - routine: interview
    knobs:
      probing: gap-lens
      proposers: 4            # <- debate knob, unknown under an interview stage
```

**Verdict: FAIL-LOUD.** `proposers` is a `debate` knob; under an `interview` stage it is unknown.
Per-stage knobs validate against that routine's vocabulary only. Stop and name it — dropping it
silently would be artifact drift.
