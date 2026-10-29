# `tap unwedge`: one explicit recovery action

`tap unwedge <handle>` diagnoses one local registered seat and records the observation without dispatching anything. An acting invocation takes exactly one requested rung: message, nudge, Continue, or exact native restart. It never climbs automatically or reports queued mail, accepted keys, or a started harness as resumed work. `tap help unwedge` owns the CLI and JSON fields.

## Custody

A launcher or crew owner controls its own seats; otherwise ask the leader. If the leader is stuck or absent, a teammate may diagnose it and follow this ladder. Custody is a collaboration rule, not a rank or owner check in code. Current operator holds and every target/evidence check still apply.

## Admission and attempts

Acting recovery initially supports only stopped Claude `api_error` and Codex `model_capacity`, with a readable session-bound instrument proving that the turn ended. Healthy, working, unknown, gone and permission/dialog states authorize no interrupt or restart. STOP, WAIT, draft grace, queued follow-ups and unreadable composers refuse. A report-only recovery policy dispatches nothing.

The snapshot binds the acting registry/team/handle, instance, server socket/epoch, pane address/ID, process PID and native conversation. The same target and required evidence are rechecked before publication, each key and restart teardown. Productive assistant/tool output, other input, changed identity and uncorrelated transcript changes close the current chain. Its own submitted stimulus followed by the same supported stop can establish that a rung was tried without claiming useful progress.

Each invocation writes an audit in the existing recovery store when its target can be bound. The outer record has `hold=false`, so it cannot park its own mail or contend with the nudge actuator. It records the cause, target, transcript position, stimulus, predecessor, outcome and payload/actuator reference. The bus event log records the invocation too. Missing target authority or audit-write failure refuses acting recovery; output states when no durable record was written.

A successor needs `--after <recovery-id>` naming the completed immediately preceding rung for the same target and incident. It claims that predecessor atomically before dispatch. A crash retains the claim as unknown; owner death cannot reopen it. Only a proven pre-effect refusal releases its own claim. Intent is durably marked possible before handing control to an actuator; a later refusal may therefore remain uncertain rather than erase possible effects.

After a completed stimulus, the next action is ineligible for at least two minutes. The command returns `next_eligible_at` instead of waiting. Time alone does not establish failure: the stopped cause must persist and the transcript must show no productive or unknown progress.

## Rungs

1. **Message:** publish one fixed observation note through ordinary send with the captured recipient instance and a publication guard. A registered sending seat is required. The note grants no new task or permission. Publication and recipient processing remain separate outcomes.
2. **Nudge:** use the existing recorded nudge actuator with interrupt disabled. No draft clearing, copy-mode cancellation or generic recovery detour is added.
3. **Continue:** use the same actuator with the existing safe Escape recipe and one cause-naming message to continue the existing task. Recheck before typing and Enter; any uncertainty stops the operation.
4. **Restart:** use the existing restart transaction with a pinned exact native ID and invocation. Require that conversation's readable artifact in the child's configured store, a valid recorded workdir and an available executable. Repeat the checks under teardown custody. The shared crew guard applies, and any additional pane or the caller's own pane refuses session-wide restart. There is no picker, latest/fresh fallback, model switch or automatic retry. A post-stop failure retains the transaction's backup/failure receipt. After startup, verify this launch's stable pane/process and process-bound native conversation; missing proof is verification pending, and a different ID is a verification failure.

## Exact staged completion

The nudge rung has one exception to the observation floor: an unverified or published message whose exact canonical sentinel is still the sole composer content may receive one Enter immediately. The target must be unchanged and positively at rest, with no session activity, draft, queue, dialog or hold. This completes the selected message; it never retypes or resends it. If the sentinel disappears, the invocation refuses instead of falling through to another action. Its record retains the message's original cause and stimulus.

An uncertain nudge, Continue, staged Enter or restart never satisfies a lower rung. Inspect that outcome before further control. A caller may explicitly start a new message incident after a fresh supported diagnosis, but it does not erase earlier uncertainty. Same-ID delivery retry remains the separate `tap resend` door.

## Receipts

`completed` means publication or a verified actuator outcome; it does not mean the task resumed. `refused_pre_effect` proves no effect. `uncertain_effect` retains possible effects and exits 5. Report-only attention exits 2, ordinary success 0, and effect-free refusal/cannot-check 1. Human and JSON output name the same outcome, observation deadline and next action.
