---
name: crew
description: "For a consult, review, or discussion needing follow-up but no durable lane, manage a short-lived TAP crew seat in this tmux session."
argument-hint: 'add <preset|harness> [name] [--model <m>] [--env KEY=VALUE] [--unset-env KEY] [--cwd <path>] [-- harness-args] | list | shutdown [<crew>|--owner <handle>]'
allowed-tools: 'Bash'
role: maker
---

# /tap:crew — ephemeral consult in this session

```bash
tap crew add <model-bearing-preset> [name] [--env KEY=VALUE] [--unset-env KEY] [--cwd <path>] [-- harness-args]
tap crew add <harness> [name] --model <model> [--env KEY=VALUE] [--unset-env KEY] [--cwd <path>] [-- harness-args]
tap crew list
tap crew shutdown <crew>              # one crew seat
tap crew shutdown [--owner <handle>]  # an owner's whole crew; bare = your own
tap crew relaunch <crew>              # fresh process in the same pane; no resume
```

Run `tap crew add` from the driver's tmux session (it refuses when the caller pane is not observable). It opens a new window in **this** session — the operator's, not an unnamed one — pre-registers the pane as crew, and starts the harness. The member has a full bus identity (send, receive, settle) and its working life ends with that pane. Crews are not parallel writers: they share the tree, so a stretch that needs exclusive edits is `/tap:drive`, not a crew.

Before the first work dispatch, identity-gate the new member as `/tap` requires: ask it through a `reply=expected` message to run `tap whoami`, and dispatch only when the returned handle matches the one you addressed.

Do not export `TAP_REGISTER_SUPPRESS_IDENTITY_CAPTURE` — `tap crew add` already sets it in its own register child. Exporting it in this pane would skip harness-session capture on your next `tap in`.

`--cwd` may sit outside this worktree; TAP records that override itself.

`tap crew list` renders only CREW rows. `tap crew shutdown <crew>` is the one-command dismissal: the same local obligation gate as `tap out`, then the registry row and the recorded crew pane together (`remove <crew>` is its alias). `tap crew shutdown` with no argument stops your own crew; `--owner <handle>` or `<team>/<handle>` names another owner. It stops only that recorded pane, never a sibling split, another tmux server's pane, or a session's last pane. Plain `tap out <handle>` removes only the row and prints the `tmux kill-window` follow-up; `tap out <handle> --kill` is refused for crew because it is session-scoped. There is no `crew up`/`down`: crew rows exist only while live.

`--preset <name>` takes tuning from the catalog (`tap presets` lists it); crew keeps the handle, window, and cwd. A preset owns its model, so combining it with `--model` refuses, as does a preset whose harness disagrees with the POSITIONAL harness. `--env`, `--unset-env` and `--` still apply, as with `tap session launch`: `tap crew add astra reviewer --env CODEX_LOG=debug -- --search` keeps the preset and adds one variable and one harness flag. They persist in the crew recipe, so `tap crew relaunch` keeps them; `tap session relaunch <crew> --env ...` adds more. A crew seat always starts a fresh conversation, so conversation selectors (`--resume`, `--continue`, `--conversation`, Codex `resume`/`fork`) refuse. The preset goes in the FIRST position (`tap crew add opus reviewer` runs preset `opus`); a compatibility harness is only checked when you name one explicitly alongside it, as in `tap crew add codex --preset opus`, which refuses because `opus` is a claude preset. `--harness` is retired and refuses `retired_flag` naming the positional form, so it cannot reach the mismatch check at all.

## Crew, ask, subagent, or team seat

| Need | Reach for |
|---|---|
| One bounded question, no follow-up | `/tap:ask` — stateless, no pane or bus row |
| Consult, review, or discussion that may need follow-up | `tap crew add` — a short-lived seat in this session |
| Private scratch work inside your own turn | a harness subagent |
| A lane with its own worktree and lifetime | a team seat (`/tap:drive`, `/tap:lead`) |

"Use a crew" means fresh crew seats for this workstream, not dispatch to existing team seats: a busy team seat is mid-context, and your ask mixes into its work. A crew seat starts clean and leaves when the workstream closes.

## Brief the member

A crew seat with no brief is phantom staff. The first dispatch states:

- **Role** — what it is (adversarial reviewer, second opinion), and what it is not.
- **Worktree** — where to read; crews share the tree, so say whether it may edit (usually not).
- **Constraints** — scope, files, and anything off-limits.
- **Reply expectation** — how it answers (`tap reply`), in what shape, by when.
- **Escalation path** — who it tells when blocked or when it finds something outside the brief.

Assign the brief to the named crew seat with a tracked reply (`tap assign <crew-handle> -f <path>`); a recipient-less `tap send -f` is an untracked note. When the workstream closes, `tap crew shutdown <crew>` dismisses only that seat; a bare shutdown stops every crew you own. Cost-aware routing across these forms is tracked in tap-9aho.

Flags and exit codes: `tap help crew`.
