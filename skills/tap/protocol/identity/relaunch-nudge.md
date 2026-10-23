# Relaunch with a continuation prompt

`tap session relaunch --nudge` resumes the work a seat was doing before replacement.
Bare `--nudge` carries the ordinary continuation; `--nudge=<text>` adds context.
The attached form preserves the positional seat: `relaunch --nudge fable` targets
fable. Context uses the same validator as `tap nudge --message`: one line, at most
200 UTF-8 bytes, no sentinel brackets and no word starting with `@` or `/`.
An empty attached value refuses. `-m` and `--nudge` cannot be combined.

Before any replacement, relaunch takes one activity observation per selected
seat through the same pipeline as `tap team`. Every state except positive
`idle` requests continuation: `working`, `waiting`, `blocked`, `error`, `booting`,
`overprint` and `unknown`. The snapshot retains the roster's label and reason;
relaunch has no separate wedge detector. Compute activity is attributed to the
actual team, handle and pane, including when different teams share a handle.

`--nudge` does not change which seats are replaced or refused. Crews still
relaunch fresh and skip the prompt with `crew_fresh`. Hermes still relaunches
and skips it with `hermes_unsupported`, because it has no resume-prompt channel.
Plain `-m` retains its existing refusals for crews and Hermes.

Continuation follows the existing `-m` transport. Native argv channels carry the
standard nudge doorbell, with the validated context if present. OpenCode uses
its existing after-rebind, settle-only TAP bus payload: plain continue/check-poll
text plus context, without nesting a doorbell in the body. No new delivery or
recovery mechanism is introduced.

Dry-run and JSON results include `pre_relaunch.agent_state` and
`pre_relaunch.agent_state_reason`. `nudge.planned` records the prompt choice;
`nudge.reason` explains a non-idle prompt or a skip, and `nudge.transport` is
`argv`, `bus_note` or null. A plan does not prove that a replacement succeeded
or that the harness processed the prompt. Text identifies planned prompts and
skips. Without `--nudge`, relaunch keeps its existing output and does not capture
activity state.

```sh
tap session relaunch --harness codex --nudge
tap session relaunch fable --nudge='continue the current review' --dry-run
tap session relaunch --harness opencode --team='*' --nudge --json
```
