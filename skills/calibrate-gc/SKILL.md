---
name: calibrate-gc
description: "When a frontier seat is asked to consolidate calibration observations, or tap calibrate suggests GC for old rows or a large store."
argument-hint: '[reason or evidence pointers]'
allowed-tools: Bash, Read, Grep, Glob, Edit, Write
---

# Calibration consolidation

Make the observation store easier to read without losing the conditions, authors
or evidence that make each observation useful. This is model judgment by a frontier
seat (for example fable-xhigh), on request or when the age/size footer suggests it.
If this seat is not qualified for that work, hand the request to the leader for a
frontier seat. The helper handles custody, not deduplication or truth.

Installed names are `/tap:calibrate-gc` in the TAP plugin and `/tap-calibrate-gc`
on flat hosts. `tap help skill tap-calibrate-gc` resolves the same canonical file.
This skill has no automatic, scheduled or launch-time consumer.

## Establish the evidence

Check `tap config get calibration.enabled`; a disabled store is a stop, not a
request to change configuration. Read the whole active file at
`$HOME/.tap/calibration/observations.jsonl`, the current machine roster and presets,
launch records covering the last 90 days, and the refs needed for disputed notes.
Use `tap teams --all` and `tap team roster <team> --json` for each team,
`tap presets --json`, and `tap session list --machine --json` as entrypoints.
The launch listing covers retained enrolled-team records, not a guaranteed history:
inspect underlying records and their dates where needed. Missing or unreadable
history is unknown, not proof a route disappeared.

Report a partial sweep when required inputs are unavailable, naming the gaps and
leaving every unsupported disposition untouched. An unreadable or incompletely
read active file prevents any rewrite. Missing launch coverage prevents retirement;
a missing dispute ref keeps the disputed rows. Work from the whole file rather
than the rendered or candidate-filtered `tap calibrate --json` view.

## One backed-up rewrite

Resolve the canonical skill directory, then use the bundled mechanical helper:

```bash
gc_skill="$(tap help skill calibrate-gc)"
gc_dir="$(dirname "$gc_skill")"
gc_backup="$(bun "$gc_dir/scripts/store.ts" backup)"
```

Check that backup succeeded before proceeding. It validates and copies the exact
active bytes under the append lock into
`$HOME/.tap/calibration/archive/observations-<UTC>.jsonl`, exclusively, then flushes
the file and directory. Read that entire backup as the pinned input. If it differs
from the input you considered, revise the dispositions against this copy.

Prepare a candidate UTF-8 JSONL file and a short Markdown report in the current
seat's scratch directory. Keep the existing row shape and literal route IDs.
Account for every input row by ID: untouched, merged, conditioned, or retired,
with source refs and the reason for changes. Give rows in/out and the counts and
IDs in each disposition group; identify source contributors to each surviving ID.
Count each input row once in those groups, so counts reconcile. Use physical
positions when identical IDs repeat; IDs are not unique row keys. Preserve untouched
rows and their order; place a consolidated row at its earliest contributor's slot.

```bash
bun "$gc_dir/scripts/store.ts" replace "$gc_backup" "$gc_candidate" "$gc_report"
```

Here `gc_candidate` and `gc_report` are the complete files you just prepared. The
helper checks opt-in again, validates candidate bytes, takes the same
`observations.jsonl.lock` as appends, compares active bytes with the backup, and
replaces the active file by a flushed same-directory rename. It saves the report
beside the backup as `observations-<UTC>.report.md` and prints the disposition.
A changed-input refusal means a new backup, reread and rebuilt candidate; preserve
the earlier attempt and any newly appended rows. A backup-only or `Status: prepared`
report is an incomplete attempt. On an I/O failure after replacement, inspect the
active SHA256 and saved report before retrying: `Status: replaced` and the helper's
success receipt identify completion. Finish with one short before/after report.
The archive is evidence preserved by each run and is outside this skill's GC scope.

## Consolidation judgment

Prefer a few useful, qualified observations over a verdict about a model. The cost
of over-merging is erased context; the cost of retaining a disputed pair is only
reading space. Keep separate rows when the evidence cannot support a synthesis.

- Merge duplicates only for the exact same route and compatible effort/conditions.
  Keep the earliest contributor's ID in input order (IDs are hashes, not sortable
  dates), the newest contributing `at`, and joined source refs. Consolidation does
  not date evidence to today. For synthesized wording, `by` is the frontier writer's
  registered `team/handle`; retain original authors and relevant dates in the joined
  refs or note. An unchanged row keeps its author and bytes.
- Different-condition contradictions become a conditioned observation: "fails when
  X, works when Y," with both evidence paths. Keep effort distinctions explicit;
  retain separate rows if collapsing them would imply an unsupported generalization.
- For the same conditions, stronger refs decide: direct artifacts, PRs or substantiated
  multi-run evidence over a bare session assertion; then newer observation date for
  comparable evidence. A newer secondhand opinion does not erase an older observed
  result. Preserve its status as a claim when it contributes to the synthesis.
  If support remains unresolved, retain both and say so.
- Retire a route only with substantiated absence from the roster, current presets,
  and the last 90 days of launch records. Roster absence alone does not establish
  retirement. A successor model name does not inherit its predecessor's observations.

The writable scope is the active observation file and this run's archive/report.
Cross-version transfers, invented evidence and unexplained deletion fail that
contract. Configuration and `models.toml` stay with their owners; this skill does
not edit them or turn an observation into a routing rule. Candidate promotions may
be printed for a human PR, clearly separate from the store rewrite.

## Worked examples (illustrative, not seed data)

**Duplicate pair.** Same `codex/example-model` route and effort, same bounded-task
observation: `a1b2c3d4` (July 1, example/alpha, artifact A) followed by `b2c3d4e5`
(October 1, example/beta, artifact B). With matching conditions, consolidate into
`a1b2c3d4`, `at` October 1, refs A+B including the source authors, and the frontier
writer's `by` for the synthesis. Report: 2 in, 1 out; merged 2 input IDs into
`a1b2c3d4`; conditioned 0, retired 0, untouched 0. The exact pair remains in the
backup; no new date or cross-route inference is introduced.

**Same-condition contradiction (illustrative).** Suppose `c3d4e5f6` records a September 1 observed failure
under an explicit wait helper, supported by a PR artifact. `d4e5f6a7` is an
October 1 secondhand success claim for the same route, effort and conditions,
supported only by a session. The newer claim does not defeat the artifact. A
supported synthesis retains the observed failure and its September date in the
note, qualifies the October statement as secondhand, and advises the artifact's
bounded workaround rather than blanket avoidance. Keep ID `c3d4e5f6`, join both
refs/authors, and use October 1 as the newest contributing `at`, not the run date.
Report: 2 in, 1 out; merged the two IDs with stronger-ref resolution, conditioned 0,
retired 0, untouched 0. If the PR cannot be read, leave both untouched and report
a partial sweep instead of inventing the resolution.
