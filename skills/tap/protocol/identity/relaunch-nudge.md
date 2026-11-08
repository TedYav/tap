# Relaunch with a continuation prompt

`tap session relaunch --nudge` resumes the work a seat was doing before replacement.
Bare `--nudge` carries the ordinary continuation; `--nudge=<text>` adds context.
The attached form preserves the positional seat: `relaunch --nudge fable` targets
fable. Context uses the same validator as `tap nudge --message`: one line, at most
105 UTF-8 bytes after the fixed interruption notice, no sentinel brackets and no word starting with `@` or `/`.
An empty attached value refuses. `-m`, `--nudge` and `--auto-nudge` are mutually exclusive.

Before any replacement, relaunch takes one activity observation per selected
seat through the same pipeline as `tap team`. Every state except positive
`idle` requests continuation: `working`, `waiting`, `blocked`, `error`, `booting`,
`overprint` and `unknown`. The snapshot retains the roster's label and reason;
relaunch has no separate wedge detector. Compute activity is attributed to the
actual team, handle and pane, including when different teams share a handle.

`--auto-nudge` uses the same snapshot but requests continuation only for
`working` or confirmed quota errors: state `error` with reason `usage_limit`
or `rate_limit`. All other states skip the prompt, including `unknown`,
`waiting`, unrelated errors and blocked quota dialogs. It does not infer
earlier work from recent activity. Bare `--auto-nudge` carries the ordinary continuation;
`--auto-nudge=<text>` uses the same attached context syntax and validator.

Include `--auto-nudge` in the relaunch that replaces a working seat. A later
relaunch checks its new state and skips continuation if it is now idle.
To wake an already-resumed idle seat, use `tap nudge <team/handle> --no-interrupt`.

Neither nudge option changes which seats are replaced or refused. Crews still
relaunch fresh and skip the prompt with `crew_fresh`. Hermes still relaunches
and skips it with `hermes_unsupported`, because it has no resume-prompt channel.
Plain `-m` retains its existing refusals for crews and Hermes.

Continuation follows the existing `-m` transport. Native argv channels carry the
standard nudge doorbell with the shared recovery notice and validated context. OpenCode uses
its existing after-rebind, settle-only TAP bus payload: plain continue/check-poll
text plus context, without nesting a doorbell in the body. No new delivery or
recovery mechanism is introduced.

Dry-run and JSON results include `pre_relaunch.agent_state` and
`pre_relaunch.agent_state_reason`. `nudge.planned` records the prompt choice;
`nudge.reason` is `non_idle` for the legacy policy, `working` or `quota_error` for an auto-nudge
prompt, and `idle` or `not_working` for an auto-nudge state skip. Crew and Hermes
retain their reasons above. `nudge.transport` is
`argv`, `bus_note` or null. A plan does not prove that a replacement succeeded
or that the harness processed the prompt. Text identifies planned prompts and
skips. Failed or ambiguous replacement never triggers a second injection or an
automatic retry. Without either nudge option, relaunch keeps its existing output
and does not capture activity state.

```sh
tap session relaunch --harness codex --nudge
tap session relaunch --harness codex --team='*' --auto-nudge='continue after the account switch'
tap session relaunch fable --nudge='continue the current review' --dry-run
tap session relaunch --harness opencode --team='*' --nudge --json
```
