---
title: "Tune a noisy LLM classifier by rewording its prompt on a labeled dev set"
date: 2026-09-27
last_updated: 2026-09-27
category: best-practices
module: "semantic classifier for a public copy"
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - "an LLM classifier blocks far more items than a reviewer can read"
  - "the proposed fixes are moving a threshold or model-reading every hit"
  - "a deny list is being seeded from local names"
tags:
  - classifier
  - calibration
  - prompt-tuning
  - dev-set
  - triage
---

# Tune a noisy LLM classifier by rewording its prompt on a labeled dev set

## Context

A semantic classifier scores prose units before a public copy ships. In one export, an earlier prompt raised about 1,300 blocking refusals. The obvious levers were both poor. Relaxing the cutoff to clear more units can reduce recall without improving the question the model answers. Reading every hit with a second model costs more than it saves, and its judgments go unmeasured.

## Guidance

1. **Build a small labeled dev set from real refusals.** About 115 units, weighted toward false positives: a seeded, stratified sample of 50 that two models labeled independently (49/50 agreement, kappa 0.79), plus 65 additions carrying one labeler's labels, of which a blind spot check of 25 agreed on 19/25.
2. **Reword the question, not the threshold.** The revised wording asks for one deciding sign: a specific private detail. It adds an explicit false list: templates, field lists, example logs with made-up values, headings, and change notes that name no one.
3. **Refit thresholds only after the wording settles.** The selected operating point set the four per-category green thresholds to 0.15, 0.25, 0.44 and 0.18 (two of them raised), left the red thresholds unchanged, and moved the veto to 0.6. Refusals fell to 234. Rewording alone raised the clean dev-set passages cleared from 12/92 to 26/92; refitting the thresholds on the new wording raised it to 66/92. A random audit of 15 cleared units found 15/15 clean.
4. **Report recall and the accepted tradeoff.** This export relied on deterministic identity, vocabulary, secret and archive checks for the hard risks, so the classifier's recall targets were reported rather than enforced. Fresh validation caught 118/120 frozen examples and 34/40 original positives; none of its six misses was in a shipped file. A validation rescore of an earlier run at the same cutoffs missed a passage in one shipped file, although the candidate run still flagged that passage.
5. **Triage the residual lightly.** A reviewer disposed 125 generic escalates as publish-as-is, one digest at a time, in about 20 minutes. Rewrite only units that name something specific. Boundary: a dated or measured specimen that names no person, seat, run, host, PR or company is publish-as-is, unless its content is itself a private run narrative or ruling, which the reader deliberately keeps flagged.

**Counter-lesson: a deny list built from local names needs a public-identifier filter.** A deny list seeded from local names that were built from public model and preset names caused about 1,950 false refusals.

**Evidence limits:** the development-set gain is in-sample. The frozen set also informed threshold selection, so these checks are regression coverage, not an untouched holdout. Counts from a stratified sample are sample counts, not a population rate.

## When to apply

Use this when a classifier's refusals exceed reading capacity and most look generic. Make recall informational only where independent deterministic checks carry the hard risk and an occasional miss is accepted. This advises a tuning procedure only. It adds no merge gate.

## Specimen: preview shared classifier inputs and check meaning when rewording prose

Two changes to a classifier and adjacent prose shared one shape: state that other contributors measured against changed without a dry run or a meaning-drift check before the change became authoritative.

**The vocabulary seed.** Deny vocabulary seeded from local names became shared state that the classifier measured every unit against, with no gated dry run first. Because those names were built from public model and preset names, the seed produced about 1,950 false refusals. Preview any vocabulary or prompt-pack change with a gated dry run before it becomes state that others measure against.

**The prose rewording.** Separately, rewording articles against a word and byte budget optimized the scorer—fewer words, under budget—without checking whether the rewrite kept the same meaning. Several rewrites drifted: one dropped an evidence limit and the subject it qualified; another broadened a contract by loosening “status message.” An automated reviewer caught three such drifts before the human reviewing partner.

**The fix for a rewording band: grep the citers, then classify each changed sentence.** For every rewrite, grep the public documents that cite the file being reworded; that search caught a pointer whose meaning had drifted. Then read each changed sentence against its original and classify it as narrower, broader or the same. A sentence classified narrower or broader is a meaning change and needs the same review a contract change gets, even though the diff looks like a pure trim.

Both misses are the same class: changing shared measured-against state, or optimizing a scorer's wording, without a dry run or a meaning-drift check first. The vocabulary case needed a preview before the seed became live; the rewording case needed the citer-grep-plus-narrower/broader/same check on every changed sentence, not just a word or byte count.
