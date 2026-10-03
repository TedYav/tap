---
date: 2026-07-23
source_run: tap-zwn9
contract: research-pass/draft
packet_extensions: []
---

# Research pass — verified evidence-gathering with a claim-level gate

DRAFT — surfaced as draft in any shelf selection until ratified to /v1. The dispatch
and verifier halves earned their MUSTs from three rounds of field use. The routing
appendix did not: it remains working hypotheses awaiting bead tap-2nuf, and its
separate register cannot bind a dispatch.

## Goals

Turn "go research X" into a verified evidence packet a consumer can safely act on: a
briefed researcher produces citation-carrying material; an independent verifier audits
every claim against the live sources BEFORE any consumer acts; a calibration recipe makes
new research seats measurable instead of vibes-rated.

Evidence tags R1–R8 refer to the [public measurement summary](../../../../docs/solutions/best-practices/timed-seat-eval-trap-methodology.md#measured-checks-behind-the-research-pass).

**Why the separations hold:**
- **Producer ≠ verifier** — three of four fluent, well-cited reports in one evaluation
  had citation-integrity failures that only claim-level checking revealed. [evidence: R1]
- **Verified once ≠ trusted forever** — reliability is per (tier, task-class): one
  researcher scored 12/12 at timed lookups but 12/15 at deep research. [evidence: R2]
- **Report polish ≠ report integrity** — reports written in 54–61 seconds looked as
  polished as one written in four minutes; reopening sources separated them. [evidence: R3]

## Dispatch half — the research brief (MUST)

The brief names:

- **Work-alone and live-web mandates, a stated timebox, and a one-reply deliverable.**
- **Deliverable structure:** lettered content sections (adapted to the topic), a numbered
  SOURCES section — URL / title / publisher-author / date / source type / a one-line
  credibility label distinguishing empirical vs vendor claim vs anecdote — and a GAPS
  section ("what you looked for and could not find or could not verify").
- **The citation scaffold, verbatim in force:** every content item cites at least one
  numbered source AND carries a verbatim supporting quote of 25 words or fewer, COPIED
  not reworded; items without a quote are treated as unverified.
- **The audit warning, stated in the brief itself:** citations WILL be independently
  opened, and a source that does not say what you claim scores NEGATIVE, not zero; an
  honest gap beats a padded item. This is measurement, not intimidation: in one
  evaluation with this warning, all nine checked claims survived source checking. [evidence: R4]
- **The standing boilerplate, three lines:** (1) verify recency against a live
  authoritative source — a stale answer scores zero even if well-cited; (2) a feed/page
  updated stamp is not published_at — for dates, prefer the API field or raw release
  file; (3) below-clean-tier handoffs route through a verifier pass before a consumer
  acts. [method: docs/solutions/best-practices/timed-seat-eval-trap-methodology.md]
- **Tier preflight when tiers matter** (matched comparisons, budget-sensitive dispatch):
  verify DECLARED = OBSERVED effort from the harness rollout transcript stamp — the
  launcher records model, never effort, and in-pane resets silently revert it. [method:
  docs/solutions/integration-issues/new-command-reverts-codex-effort-to-profile-default.md]

## Verifier half — the claim-level audit (MUST)

- **An independent seat, never the producer,** working from the cited sources alone —
  never from the producer's recall or the dispatcher's summary.
- **Per-item verdicts from the closed vocabulary:** VERIFIED | QUOTE-NOT-FOUND |
  QUOTE-ALTERED | CLAIM-NOT-SUPPORTED | SOURCE-UNREACHABLE | METADATA-WRONG — worst
  applicable wins, and every non-VERIFIED verdict carries one evidence line stating what
  was found instead.
- **Three checks per item:** quote verbatim in the source (whitespace/punctuation
  normalization only — reworded is not verbatim); claim supported by the surrounding
  context, not by string presence (a verbatim quote can be cherry-picked to support a
  claim the source does not make); source metadata accurate, including the
  empirical-vs-vendor-vs-anecdote label.
- **Unverifiable-not-false discipline:** an unreachable source gets one retry, then is
  flagged unverifiable — never counted false. Self-correction on new evidence is the
  verifier quality bar: a verifier that reverses its own 404 ruling on a fresh
  fetch says so plainly.
- **A totals line and a scoped fabrication verdict.** The precision standard on record:
  "the sentences were not invented, but their citations were" — separating fake text
  from fake attribution, which are different remediations.
- **Harm-ranked triage of failures:** CLAIM-NOT-SUPPORTED > invented attribution >
  paraphrase-as-quote > epistemic mislabel > byline slip. The first poisons implementers;
  the last is cosmetic.
- **The gate condition:** below an empirically-clean (tier, task-class) pair, this audit
  is mandatory before any consumer acts on the material. Exemption requires evidence for
  THAT pair, and is revocable on any regression. Single-family verification carries a
  monoculture risk — a SHOULD until calibrated: use a second-family verifier for
  disputed reachability or entailment calls.

## Calibration half — evaluating a research seat (SHOULD, when routing rides on it)

- **Trap-class question design:** nonexistence (with the sanctioned NOT-FOUND escape;
  refusal WITH positive evidence outranks a bare NOT FOUND), field-identity (an
  authoritative-looking field answering a different question), sort-order (visual top vs
  newest-by-date). Check which traps are LIVE the day the key is built, and never credit
  trap-survival that was never tested. [evidence: timed-seat-eval-trap-methodology.md]
- **The key comes from verified primary sources, never from the top-ranked runner.**
- **Timing by payload-id timestamps**, dispatch → reply — never eyeballed wall-time.
- **The single-instruction-fix test before benching:** a seat whose failure class dies to
  one standing brief line is under-briefed, not broken. A measured lift after a brief
  change is evidence, not proof of causation. [evidence: R5]

## Run shape (SHOULD)

1. Dispatcher sends the brief (dispatch half), with tier preflight if tiers matter.
2. Researcher returns ONE reply; dispatcher settles it.
3. Below the clean tier, dispatcher sends the verifier the report payload path(s) and the
   audit order (verifier half); verifier returns the per-item table.
4. The consumer acts only on VERIFIED material; failures triage by harm rank; disputed
   verdicts go fix-or-rebut between producer and verifier, dispatcher adjudicating.
5. A calibration datum lands on the seat ledger per engagement; distinct learnings go to
   compounding; verdicts and rulings that change routing land on beads, not in chat.

## Routing appendix — HYPOTHESES, not contract

**Register warning (the one MUST in this section): nothing below binds a dispatch, and no
MUST above may cite this appendix.** Status: working hypotheses + temporary safety
default, downgraded on 2026-07-23 after cross-family panel review. The preregistered
test is bead tap-2nuf (frozen packets, fixed item counts, dual-family verification).
Promotion to contract happens only through that replication, via PR — never by
accumulated habit.

Current hypotheses, each awaiting replication:
- GPT-family speed tiers may fail on attribution (real text, wrong source), while
  Gemini-family speed tiers may fail on claim support (the source does not make the claim).
- GPT-family effort may buy breadth and recency; Gemini-family effort may buy integrity.
- The only cell observed clean on deep research: terra at MAX effort, `n=1`. [evidence: R7]
- Revisit on tap-2nuf results in either direction. An attribution slip on terra at
  MAX effort or a fixed-N gemini-HIGH claim-support failure reopens the corresponding
  line immediately.

## Adaptation knobs

| Knob | Default | Notes |
| --- | --- | --- |
| `researcher` | any seat | the routing appendix informs the pick, never binds it |
| `verifier` | an independent verifier seat | never-the-producer is the invariant; the seat is the knob; second family on disputed calls |
| `brief_sections` | lettered, topic-adapted | scaffold + boilerplate are the invariant; section names are the knob |
| `timebox` | ~10 min deep research; per-question for lookups | stated in the brief either way |
| `audit_scope` | every claim below the clean tier | sampled audit is permissible only above it |

BONUS: a calibration-ledger datum per engagement; a compounding run per distinct learning.

## Evidence patterns

- A claim-level audit distinguished a fully supported report from a weakly supported
  one; polish did not reveal that gap. [evidence: R6]
- A verifier records when new evidence corrects an earlier source-reachability verdict.
- A routing hypothesis stays provisional until replication supports promotion; a
  downgrade within hours of a prior merge keeps the knowledge base aligned with evidence.
- A brief change can improve results without proving it caused the whole improvement.

## Boundaries (MUST NOT)

- The verifier is never the producer, and never verifies from anyone's recall — the cited
  sources alone are ground.
- The routing appendix never binds a dispatch, and promotion of any hypothesis to
  contract rides a tap-2nuf-class replication PR — never accumulated habit.
- No consumer acts on below-clean-tier research ahead of the verdict — fluency is not
  evidence.
- An eval answer key is never built from a runner's output, whatever that runner's rank.
  [method: docs/solutions/best-practices/timed-seat-eval-trap-methodology.md — a
  frontier baseline failed two trap classes; evidence: R8]
