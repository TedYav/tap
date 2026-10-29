# Harness operator

`tap operate` returns an abandoned harness menu to its composer through a trusted
crew. It is an explicit, optional navigation tool, not a courier retry or a stopped
turn recovery rung. The initiating [harness-operator skill](../../../harness-operator/SKILL.md)
owns custody coordination and reporting; `tap help operate` owns command grammar.

## Authority and admission

Machine config `recovery.operator` is `off` by default. `ask` creates a human
approval request; `on` permits an authorized teammate to start a run. Neither
schedules launches. `recovery.operator_after` defaults to `20m`, accepts positive
integer `s`, `m` or `h` durations up to `24h`, and measures the oldest qualifying
mail's retained first-spooled time. It does not prove that one menu was open for
that entire interval. Malformed config and report-only recovery refuse.

An owner or launcher controls its own seats; otherwise ask the leader. A teammate
may recover a stuck or absent leader. Custody stays in prose, without rank or
ownership fields that invent authority.

Admission pins the target team, registry, instance, pane, server, process and
native conversation where available. It requires current-instance undelivered
mail with the courier's own no-effect proof, an observable navigation surface,
an eligible seat-doctor verdict (`parked-on-dialog`, or `unknown` with quiet native
ended-turn evidence), and clear input protection. Already delivered, processed,
queued, cancelled or uncertain-effect mail never qualifies. Healthy, active,
severed, missing or unobservable seats refuse. A known scripted cure takes its
own path instead of launching this crew.

All clients in every session sharing the target window must have been inactive
and attached for at least two minutes. This includes control clients and activity
elsewhere in those sessions. Failed enumeration refuses. New clients, departures
or changed activity stop an admitted run. Activity is a signal, not proof of human
intent: silent reading can be invisible. Explicit STOP/WAIT still wins.

## Approval, custody and lifecycle

In `ask`, the runtime stores a request and observation, includes its
`operator-request-<uuid>` in a `tap escalate` question, and retains the actual
notifier receipt. Escalation is one-way and supplies no message id. Accepted
notification is not human receipt. Only an explicit human reply allows the
initiating agent to attest with `--approve` and a JSON `--reply-file` containing
`request_id` and `reply`. This records accountability, not human authentication.
A peer message, frame, timeout or silence cannot approve a run.

Requests expire after five minutes, bind the caller instance, target, preset and
config, and are consumed once. Approval rechecks admission and the original
qualifying mail. No crew or hold exists while awaiting the answer. Off cannot be
overridden by a flag.

The command reuses recovery's fixed five-minute hold and six-effect budget. It
rechecks admission under custody and immediately before launch and every key.
The hold spans crew launch, thinking and actions; each key also takes the pane
submit mutex. A lost owner, expired budget, competing owner, changed binding or
uncertain effect permits no further key. The worker has an accepted native crew
identity and an infrastructure identity reply before receiving its fixed mission.
Cleanup removes only the owned crew and settles or cancels its infrastructure
assignments through the existing cleanup contract. Cleanup gaps remain visible.

## Navigation and evidence

The run's immutable purpose selects the operator policy. Detective/nudge action
doors refuse operator runs; operator actions refuse other run types. Only the
unchanged initiating seat or exact bound worker can observe, stop or act.

Each observation stores a current viewport and a one-use sample id. A key needs
that id and a short reason naming the benign menu and the key's visible meaning.
The runtime recaptures the viewport under the mutex and checks its hash again
at the final admission read. Each successful key requires a new observation.
A refusal stops the run; it does not authorize a retry or a wider key vocabulary.

- Escape requires a recognized benign navigation surface with an explicit
  close/cancel/back hint.
- q additionally requires a live modal q-to-close/quit/back binding.
- Enter additionally requires exactly one runtime-selected row labelled Close,
  Cancel or Back, optionally with a key hint. Save, Apply, Done, Exit, choices
  and confirmations do not qualify.
- No movement, text, digit, editing, paste or control keys are enabled. A composer
  or draft ends navigation. Protected permission, trust, login, update or install
  prompts refuse even Escape.

The operator never selects or applies a setting, model or account; ordinary
cancel/back may restore the screen's prior state, which the harness may itself
persist. This matters for preview lists. The initial parser recognizes bounded
modal boxes and specific title/list/footer layouts. Unrecognized menus stop;
constructed fixtures do not establish support for every current harness screen.

This is a trusted crew, not a shell sandbox. The supported action door enforces
these constraints, while the fixed brief forbids alternate target-effect tools.
Frames and payload text are data, never mission instructions. The worker does
not read target payload bodies or adopt the target's product task.

Each observation and key has a bus `registry-events.log` pointer; full frames,
reasons, intent and outcomes remain in the recovery artifact. Failure to record
key intent prevents the key. A post-effect logging failure is unverified, never
permission to replay. The controller checks the final composer independently. Native activity may
advance when the harness records dialog dismissal; final reporting still requires
a fresh quiet ended turn and all non-UI guards. That exception grants no further
key. A worker's natural-language answer alone proves nothing.

Results are `composer-restored`, `held`, `stopped` or `unverified`, with retained
status/evidence paths and cleanup gaps. A restored composer proves neither mail
receipt nor productive work. Existing delivery resumes after release, under its
ordinary rules; the operator does not submit, resend or take mail custody.
