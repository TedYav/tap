# Monitor role

A **MONITOR** samples a declared subject on a regular cadence and writes a dated
reading every cycle, including when nothing needs action. Nightwatch, a goalie
seat and a context genie are variants. The leader checks the reading's age so a
silent monitor cannot pass for an all-clear.

This is a seat role. The `tap watch` supervision sidecar and `tap goalie` runtime
keep their existing contracts; their process heartbeats do not prove a monitor
seat sampled its subject. No registry field, daemon or timer is added by this
protocol.

## Charter

The leader and monitor agree on:

- subject, numeric readings, thresholds and authorized actions;
- cadence and actual wake mechanism, including job/reminder IDs;
- absolute heartbeat path, start time and first-reading deadline;
- reporting recipient, normally the conductor or leader;
- maximum sample age, recovery owner and stop condition.

Name a fault recipient outside the suspected failure. Routine findings can go
to the conductor or leader; if the leader or coach's own wake path is suspect,
escalate to the operator rather than relying on that seat to hear its own fault.

Use `<charter-root>/tmp/<handle>/heartbeat.log` by default. The leader must be
able to read that exact path. Keep it outside disposable checkouts or copy it
into the successor's custody before reclaiming its checkout. Existing logs
remain evidence; change the format only for new lines.

Choose a maximum age allowing for scheduling delay; the default is two cadence
intervals. The first-reading deadline defaults to start time plus that limit.
Before the deadline, a missing first reading is `starting`, never healthy.
Afterward it is `missing`. The leader's own tick interval adds to the time before
a stale sample is detected; choose both intervals for the subject's needs.

Cadence can come from completion reminders with bounded hang-check circle-backs.
Retain a variant's existing wake mechanism rather than adding a duplicate timer.
For event-driven variants, the charter names when coverage is active and which
event starts the next coverage interval. A `waiting` record names a verifiable
reminder or run ID; the leader checks that wake and still applies the active
sample-age limit. A waiting record without a verifiable wake is stale. When a
charter explicitly ends coverage until a new event (nightwatch caught up to main,
for example), record `closed` with the next activation event and report it to the
recipient. Only an authorized close suspends the age limit; an absent wake is not
an implicit pause.

## Each cycle

Sample first, then append one newline-terminated UTF-8 record in one write:

```text
2026-09-24T08:00:00Z #12 ok sampled=8 unknown=0 crossings=0 max_context_tokens=180000 threshold_tokens=250000
2026-09-24T08:25:00Z #13 error sampled=0 unknown=8 crossings=unknown reason=team-read-failed
```

The timestamp is the UTC completion time of this sample, not the wake's scheduled
time. Continue the cycle number from the log. Give metrics names and units; use
`unknown` for unavailable measurements and `error` for a failed sample. Partial
results name their missing coverage. Never copy old measurements under a fresh
timestamp or touch a file to manufacture a healthy heartbeat. A reader ignores
an incomplete trailing line. For sample age, scan backward to the latest complete
`ok`, `crossing` or `error` record; `waiting` and `closed` timestamps never refresh
sample age. Use the latest complete record's status for coverage state; scan
backward only to calculate sample age. A new sample after charter-authorized
reactivation starts the new active interval. Do not use a previous interval's
sample as the first sample after reactivation.

The five record statuses are `ok`, `crossing`, `error`, `waiting` and `closed`.
`waiting` and `closed` name their reason and wake/activation event; they are not
fresh samples. `starting` is a leader assessment before the first deadline, not
a logged sample. A fresh `error` proves a cycle ran, not that the subject is healthy.

Keep routine readings in the file. Send crossings, errors and changed findings
to the charter recipient in one TAP payload, naming the measurements, evidence
path and requested action or action taken. The charter can set a repeat/cooldown
rule for an unchanged finding. Use `tap assign` for delegated work and an ask
when an answer is needed; a heartbeat does not settle either obligation.

## Leader check and recovery

Every leader tick records a line such as:

```text
monitor heartbeat age: observer 8m / 50m; cycle=12 status=ok
```

Read the last complete sample's timestamp and status from the declared file,
not its mtime or the time of the last bus message. Report `starting`, `missing`,
`invalid`, `stale`, declared `waiting` or `closed` explicitly. Closed means no coverage by design;
report it without stale recovery. A future timestamp
is invalid; a fresh error still needs the reported sampling failure addressed.
An armed cron, a live pane and the watch sidecar's heartbeat are not samples.

When evidence is missing or stale, the leader checks the monitor and named wake
mechanism, then makes one bounded recovery attempt or reassigns coverage. If the
attempt fails, report that failure to the recovery owner and arrange a substitute;
do not repeat resets or leave the work silently uncovered. Staleness alone says
nothing about the health of the monitored subject.

Before clear/rebrief, preserve the charter and schedule inventory (mechanism,
ID, cadence, prompt, heartbeat path and recipient) in the handoff. After recovery,
inspect the actual scheduler and retain an existing matching job. Re-arm once
only after confirmed cancellation or an authoritative check covering the old
job's owning session proves it absent. An empty listing scoped to the resumed
session is ambiguous while cross-reset survival is unknown; it does not prove
the predecessor's job is gone. Report ambiguous ownership or presence to the
recovery owner instead of creating a duplicate. Take a fresh sample and observe
a scheduled fire before claiming periodic coverage restored. See
[/tap:self](../../../self/SKILL.md) for measured harness reset behavior. A handoff's
claim that a timer is armed is not proof.

At completion, cancel only the monitor's owned schedules, append a `closed`
record, report the stop and preserve the log for handoff. Team watch shutdown
still follows its own ownership rules.

## Variants and role configuration

- **Context genie:** counts sampled and unknown seats, context tokens and
  threshold crossings. Unknown telemetry must not look like zero usage. Zero or
  unchanged consecutive readings are suspect until corroborated, even when
  syntactically valid and below the upper threshold. Record `error` with the
  suspect count/reason while confidence is missing; do not label the seat faulty
  from that reading alone. A fresh/reset or idle seat can legitimately produce
  it. Corroborate with recipient evidence (settled traffic or a pane showing a
  started turn), not merely an accepted delivery receipt. See the
  [incident guidance](../../../../docs/solutions/best-practices/a-liveness-sensor-must-treat-a-dead-reading-as-a-fault.md).
- **Nightwatch:** records tested/current head, active gate count, run ID and
  known/new failure counts. Completion reminders and hang checks provide its
  active cadence. An unchanged main can close coverage until the next declared landing;
  do not dispatch duplicate gates to keep a heartbeat fresh.
- **Goalie seat:** records objectives/work inspected, overdue triggers and
  unresolved blockers. Its charter grants any recovery actions; the role name
  grants none. The `tap goalie` sidecar's own records remain distinct.

The shipped `[roles]` vocabulary includes `monitor`. Preset role recommendations
inform staffing but are optional: without installed presets, the leader assigns
available seats by judgment and calibration over time. A role is neither a fixed
model tier nor launch authority.

The old role name `watcher` is retired to avoid confusion with `tap watch`.
Catalog reading diagnoses and drops that description or hint, naming `monitor`
as the replacement; it neither aliases the name nor refuses an otherwise valid
preset. Update `[roles].watcher` and references in all preset role lists to
`monitor` together. This is an operator-authored config edit, not an automatic
migration or file rewrite. Historical records retain their original names.
