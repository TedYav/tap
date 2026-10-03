# TAP machine ingest contract

`~/.tap/ingest/` is the machine-wide inbox for distilled run learnings that may matter across
repositories. A drop is a proposal for later human or LEADER judgment, not doctrine and not user
authority. Repository compounding conventions still run first; this surface supplements them.

## One file per drop

Use this filename shape:

`YYYYMMDDTHHMMSSZ-<team>-<seat>-<slug>-<short-id>.md`

The timestamp is UTC. Keep `team`, `seat`, and `slug` filesystem-safe; use a short random or
run-derived id to avoid collisions. Writers do not share a ledger or lock: write the complete drop
to a temp file in this directory, then rename it to its final unique name. Create the directory with
`mkdir -p` when needed; the rename must stay within the directory so it is atomic.

Readers ignore `README.md`, dot-prefixed or temporary files, and everything under `archive/`. A
human may move a distilled or obsolete drop into `archive/`; archiving does not promote its claims.

## Required scalar frontmatter

Every drop starts with these scalar fields:

```md
---
created_at: 2026-07-19T11:12:00Z
team: tap
repo: example/tap
source_run: tap-qxft
author: ponytail
summary: Cross-repo learning must retain a durable evidence anchor.
tags: staffing, handoff, evidence
---
```

- `created_at` is an RFC 3339 UTC timestamp.
- `team` and `author` identify who distilled the observation.
- `repo` is the repository the learning came from, or `global` when it is genuinely cross-repo.
- `source_run` is the stable run, bead, or on-disk scribe-record identifier.
- `summary` is one bounded sentence suitable for frontmatter-only staffing scans.
- `tags` is a comma-separated scalar, never a YAML list.

## Required body

```md
## Observation

What the run taught, stated without private source material.

## Evidence

- Durable anchor: PR, commit, bead, or versioned repository artifact.
- Supplementary TAP payload: team and payload id, when useful.

## Applicability

Where the observation applies and where it does not.

## Suggested promotion

An optional calibration, repository-compound, or routine-candidate destination; otherwise explain
why no promotion is warranted.
```

## Evidence durability

Every drop names its `source_run` and at least one durable anchor: an immutable commit or PR, a bead,
or a versioned repository artifact. A TAP payload id or path may supplement that anchor but cannot be
the only evidence because buses reset. When the bus holds the only detailed observation, include the
minimum verbatim capsule needed to preserve the relevant result, while still pointing at a durable
anchor for the run.

## Privacy boundary

Do not place secrets, credentials, personal data, customer data, or repo-private payload bodies on this
machine-wide surface. Generalize the mechanism and point to the restricted durable evidence instead.
If the observation cannot be useful without exposing protected material, do not create the drop.

## Promotion boundary

Raw drops are proposals, not doctrine. A LEADER or human opens relevant bodies and chooses whether a
learning merits a dated seat-calibration append, the repository's own compounding path, or the
routine-authoring gate. Merely landing or archiving a drop promotes nothing.
