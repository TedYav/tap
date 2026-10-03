---
contract: dynamic-workflows/v1
packet_extensions: []
---

# Routine: dynamic-workflows

The burst chart: use a harness-native workflow engine for ephemeral, parallel work whose return is a
schema'd artifact. The engine is a power tool for the seat that owns the work; TAP remains the
observable, interruptible coordination layer between seats.

## Goal and placement

Turn one clear, bounded assignment into parallel or repeated passes with one predeclared return
schema. Use this routine only when the work is ephemeral, benefits from fan-out, and does not need a
persistent role.

**Placement rule.** If work needs mid-task consultation, a persistent role, or Lane writes, it
belongs to a teammate instead. Review panels, verify swarms, research sweeps, and mechanical
migrations that return a schema'd artifact are workflow-shaped. Workflow agents are one brain fanned
out; when model-family diversity is the point, use TAP teammates (or the debate routine), not this
routine.

## Engine availability and named fallback

Before launch, verify that the owning seat has a callable harness-native workflow engine. If it does,
run the declared number of passes through that engine. If it does not, use the **sequential-tally
fallback**: run the same assignment as `N` independent sequential passes, returning the SAME tally schema as the engine path. The fallback changes scheduling only — never the work order, coverage claim,
or artifact contract.

The later workflow runner is a separate supervision-layer sidecar that may mechanize DAG progress.
This routine is usable without that runner and defines no TAP CLI verb.

## Work order and tally convention

The work order names its tally schema before any pass launches. Both the engine path and the
sequential-tally fallback return that exact schema. Whatever field names the caller chooses, the
schema must expose:

- passes requested and completed;
- artifacts/results landed and failures or judgment forks hit;
- verification performed;
- coverage boundaries, sampling, skipped surfaces, and any budget cap.

A missing or malformed tally is a failed return, not prose for the gate to interpret. The owning seat
parses the tally, lands accepted artifacts, and remains accountable for its normal gate.

## Invariants (MUST)

- **No workflow agent holds a Writer Token, and mutating passes still use isolated worktrees** — a
  named exemption from the 2026-07-28 optimistic-concurrency ruling, not an oversight. That ruling
  permits shared-tree parallel writes because a lane that suspects thrashing can escalate to the
  leader over TAP. **Workflow agents have no bus channel**, so they cannot report thrashing, be
  serialized mid-run, or negotiate a scope — the escape hatch the ruling depends on does not exist
  for them. The owning seat reviews and lands each result under its own token.
- **Keep launches and landings visible.** Announce the launch, and land every return artifact on the
  Bus or in the repo so the record survives the engine's mid-flight opacity.
- **Do not turn the engine into a team bus.** Cross-seat consultation, durable roles, heterogeneous
  review, and lane ownership stay on TAP.
- **Never silently degrade.** An unavailable engine selects the named fallback; a bounded run names
  its bound and incomplete coverage in the tally.

## Engine disciplines

Apply these even when the sequential fallback is active:

1. **Schema'd tallies.** The gate parses a declared return shape instead of interpreting narrative.
2. **Pipeline, don't barrier.** Let independent items flow; wait-for-all only when the next step needs
   cross-item context such as deduplication, comparison, or early exit.
3. **Loop until dry.** Review until a pass finds nothing new, not for an unexplained fixed count.
4. **No silent caps.** Sampling, top-N limits, skipped surfaces, and exhausted budgets appear in the
   tally.

## Adaptation knobs

This list is the normative packet vocabulary for a `dynamic-workflows` stage:

- `passes` — positive pass count `N`; concurrent through the engine, sequential through the fallback.
- `tally_schema` — required return schema or schema reference, identical on both execution paths.
- `dependency_mode` — default `pipeline`; `barrier` requires a named cross-item dependency.
- `loop_policy` — default `until-dry`; a fixed bound must be explicit and reported in the tally.
- `token_budget` — optional total/per-pass budget; exhaustion is reported as bounded coverage.
