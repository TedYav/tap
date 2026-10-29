---
name: crew
description: "For a consult, review, or discussion needing follow-up but no durable lane, manage a short-lived TAP crew seat in this tmux session."
argument-hint: 'add <preset|harness> [name] [--model <m>] [--assign <brief-file> [--reply-to <seat>]] [--env KEY=VALUE] [--unset-env KEY] [--cwd <path>] [-- harness-args] | list | shutdown [<crew>|--owner <handle>]'
allowed-tools: 'Bash'
role: maker
---

# /tap:crew — a continuing consult

```bash
tap crew add <model-bearing-preset> [name] [--env KEY=VALUE] [--unset-env KEY] [--cwd <path>] [-- harness-args]
tap crew add <harness> [name] --model <model> [--env KEY=VALUE] [--unset-env KEY] [--cwd <path>] [-- harness-args]
tap crew add <model-bearing-preset> <name> --assign <brief-file> [--reply-to <seat>]
tap crew add <model-bearing-preset> <name> --resume <native-id> --cwd <original-cwd>
tap crew list
tap crew resume <crew>                # exact saved conversation
tap crew resume --owner <handle>      # one receipt per retained crew
tap crew shutdown <crew>              # one crew seat
tap crew shutdown [--owner <handle>]  # an owner's whole crew; bare = your own
tap crew relaunch <crew>              # fresh process in the same pane
tap crew relaunch <crew> --resume     # replace it on the saved conversation
```

Run `tap crew add` from the driver's tmux session (it refuses when the caller pane is not observable). It opens a new window in **this** session — the operator's, not an unnamed one — pre-registers the pane as crew, and starts the harness. The member has a full bus identity (send, receive, settle) and retains its row and conversation when that pane stops. Natural parent exit or relaunch leaves it running. Crews are not parallel writers: they share the tree, so a stretch that needs exclusive edits is `/tap:drive`, not a crew.

Before first dispatch, the creating command checks the requested handle and
preset/model against the row and verifies `crew_identity_capture.decision=accepted`.
`--assign <brief-file>` performs this gate after creation's bounded registration
wait, then sends the brief unchanged with a tracked reply. Include `tap whoami`
and the expected handle in the first-receipt instructions; on mismatch, the crew
stops and replies MISMATCH. A separate identity-only exchange is optional for
sensitive briefs. This is your pre-dispatch step, never a retroactive hold on a
working seat or authority to message another owner's crew.

`--reply-to <handle|team/handle>` with `--assign` routes the answer to its durable
consumer. If verification or assignment fails after launch, the crew remains
started and the receipt names that partial outcome. Inspect it before retrying
`tap assign`; do not rerun `crew add` to recover an assignment.

Do not export `TAP_REGISTER_SUPPRESS_IDENTITY_CAPTURE` — `tap crew add` already sets it in its own register child. Exporting it in this pane would skip harness-session capture on your next `tap in`.

`--cwd` may sit outside this worktree; TAP records that override itself.

To continue a `tap ask` answer, use its printed `crew add --resume` command with
the same cwd and preset or model. Adoption checks the exact native artifact in
the launch child's store and refuses an id already held by another seat before
creating a window. It records an exact SessionStart expectation; a different
observed id is quarantined. A missing conversation never falls back to a fresh
one. Hermes has no native SessionStart hook, so its capture may remain unavailable;
the normal pre-dispatch verification still applies.

Use `crew resume` after a crew stops or tmux restarts. It reuses the recorded
native conversation and owner instance, never a latest-session or fresh fallback.
A live matching crew is a no-op. Live owners keep crews in their session;
offline retained owners get one dedicated session. Repeated `--owner` selects
several owners in one team. Bulk runs sequentially, continues after a refusal,
and reports untouched crews after Ctrl-C. Inspect any `started_unverified`
result before assigning work or retrying. Plain `out <parent>` removes the
owner authority; a new seat with that handle cannot adopt its crews.

`tap crew list` renders only CREW rows. `tap crew shutdown <crew>` is the one-command dismissal: the same local obligation gate as `tap out`, then the registry row and the recorded crew pane together (`remove <crew>` is its alias). `tap crew shutdown` with no argument stops your own crew; `--owner <handle>` or `<team>/<handle>` names another owner. It stops only that recorded pane, never a sibling split, another tmux server's pane, or an unverified process. A crew's own last window may be stopped. `tap out <crew>` uses the same dismissal gate and recorded-pane scope, including its hard spelling. Outbound settle-only notes and replies do not block; their payloads remain readable after retirement, subject to the transport expiry rules. Stopped crews remain listed, including after `refresh --hard`. `crew up`, `down` and `rearm` are retired spellings.

`--preset <name>` takes tuning from the catalog (`tap presets` lists it); crew keeps the handle, window, and cwd. A preset owns its model, so combining it with `--model` refuses, as does a preset whose harness disagrees with the POSITIONAL harness. `--env`, `--unset-env` and `--` still apply, as with `tap session launch`: `tap crew add astra reviewer --env CODEX_LOG=debug -- --search` keeps the preset and adds one variable and one harness flag. They persist in the crew recipe, so `tap crew relaunch` keeps them; `tap session relaunch <crew> --env ...` adds more. A crew starts fresh unless `crew add --resume <native-id>` selects its conversation. Conversation selectors in the harness tail (`--resume`, `--continue`, `--conversation`, Codex `resume`/`fork`) refuse, except that fresh OpenCode strips them; exact adoption also refuses selectors in the preset or policy. The preset goes in the FIRST position (`tap crew add opus reviewer` runs preset `opus`); a compatibility harness is only checked when you name one explicitly alongside it, as in `tap crew add codex --preset opus`, which refuses because `opus` is a claude preset. `--harness` is retired and refuses `retired_flag` naming the positional form, so it cannot reach the mismatch check at all.

## Crew, ask, subagent, or team seat

| Need | Reach for |
|---|---|
| One bounded question, no follow-up | `/tap:ask` — stateless, no pane or bus row |
| Consult, review, or discussion that may need follow-up | `tap crew add` — a continuing seat, initially in this session |
| Private scratch work inside your own turn | a harness subagent |
| A lane with its own worktree and lifetime | a team seat (`/tap:drive`, `/tap:lead`) |

"Use a crew" means new crew seats for this workstream, not dispatch to existing team seats: a busy team seat is mid-context, and your ask mixes into its work. A fresh crew starts clean; an explicit `--resume` continues its selected native conversation. Dismiss it when the workstream closes.

## Brief the member

A crew seat with no brief is phantom staff. The first dispatch states:

- **Role** — what it is (adversarial reviewer, second opinion), and what it is not.
- **Worktree** — where to read; crews share the tree, so say whether it may edit (usually not).
- **Constraints** — scope, files, and anything off-limits.
- **Reply expectation** — how it answers (`tap reply`), in what shape, by when.
- **Escalation path** — who it tells when blocked or when it finds something outside the brief.

Assign the brief to the named crew seat with a tracked reply (`tap assign <crew-handle> -f <path>`); a recipient-less `tap send -f` is an untracked note. When the workstream closes, `tap crew shutdown <crew>` dismisses only that seat; a bare shutdown stops every crew you own. Cost-aware routing across these forms is tracked in tap-9aho.

Flags and exit codes: `tap help crew`.
