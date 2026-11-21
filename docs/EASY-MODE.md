# Easy Mode: help two agents talk

This is the bare-harness path through the configuration step of
[AGENT-SETUP](AGENT-SETUP.md), the installation runbook: no presets, model and
effort chosen inside each harness. A human who wants presets or shell aliases
now takes the [configuration wizard](../skills/config-wizard/SKILL.md#walkthrough)
instead; this path can add them on any later run. Use Claude Code and Codex for
the first exchange.
If the human uses another installed pair, the harness-specific limits below
still apply. TAP supplies communication, not models or accounts.

Read [the harness knob library](../skills/tap/config/harness-knobs.toml) for
flags and support limits. Check the installed CLI's help before applying a knob:
versions and account access differ.

## 1. Enter from the installation runbook

Complete [AGENT-SETUP steps 1–2](AGENT-SETUP.md#1-choose-the-install-source-and-check-requirements)
first. Create no presets. In a terminal, choose **skip** for every preset
selection; the wizard then asks permissions and optional shell integration,
without an effort question. Keep the choices the human accepts there. Optional
plugin offers default to No and can wait until after the first answer.

A non-TTY runner skips the wizard. Use `tap setup --machine --answers <file>`
below. Confirm the pair, each permission choice, the two new-user preferences
in step 2 and whether the human wants PATH integration. Skip choices they
have already made. On this path presets, effort, plugins and slash-skill aliases wait. Do not import
the reference catalog or replace an existing config.

## 2. Save simple machine settings

The answers command shares the interactive wizard's validator and config writer.
It preserves existing comments, unrelated keys and presets, backs up applied
changes, and refuses malformed or retired configs. Omitted JSON fields preserve
state and cause no new effects. Do not infer a permission choice from an omission.

Detect installed executables: `claude`, `codex`, `opencode`, `agy`,
`cursor-agent` (TAP calls this harness `cursor`), and `hermes`. Another
harness is unsupported today; it can be requested at
<https://github.com/TedYav/tap/issues>, or added by your own agent with the
`extend` skill (`tap help skill extend`).
Before asking, explain auto, the default, and the bypass flag for this harness
from the list below. In particular, Codex automatic review can approve a tool
without asking the human; choosing auto does not mean approving every command.
Confirm the pair, then ask once per selected harness, retaining any answer already given during this
walkthrough:

> Which permission mode for this harness: auto or bypass?
> Recommended for this walkthrough: auto, the default. It keeps the harness's
> approval checks. The alternative, bypass, lets the agent run commands and
> edit files without asking, with your own permissions. This changes future
> TAP launches and can be changed later; it does not undo actions an agent has
> already taken.

Explain the flag's actual effect from the knob library. A recommendation or an
unanswered default is not consent. Apply the recorded answer:

- **Claude and Codex:** set `harness.<name>.permissions` to `auto` or `bypass`
  as answered. The launcher owns the corresponding flags; do not duplicate them
  in `params`: a bypass flag left in `params` refuses a launch whose mode is
  auto. Codex auto mode uses automatic review, not a human approval dialog, and
  its first reply may need one retry with sandbox escalation.
- **OpenCode and Hermes:** set `harness.opencode.params.auto` or
  `harness.hermes.params.yolo` to `true` when accepted and `false` when declined,
  clearing any previously saved bypass choice through the backed-up edit
  procedure. Inspect the CLI's own permission settings before claiming that
  prompts are enabled; removing TAP's bypass flag leaves those settings in force.
- **Cursor and Antigravity:** set `harness.<name>.permissions` to `auto` or
  `bypass` as answered, exactly as for Claude and Codex. Cursor auto uses its
  automatic review (`--auto-review`): safe tool calls run and the rest wait for
  the human in the attached session. Antigravity has no automatic-approval mode,
  so auto launches without `--dangerously-skip-permissions` and the seat stops on
  **every** permission request until someone answers it. Tell the human that
  before they choose. In a new folder, Claude, Codex and Antigravity auto seats
  first ask the human to trust it. TAP shows a seat waiting on either prompt as
  blocked. Choosing auto alone does not turn on a sandbox; each
  harness's own settings stay in force.

The wizard also asks the two questions every new user should answer once.
Ask them in the human's own words and record the answers the same way:

- **First use in a new project** (`onboarding.init`, `ask` by default):
  `ask` has TAP offer to set up a team the first time it is used in a project;
  `auto` lets any TAP command enroll a git project (never the home directory)
  without asking.
- **Messages that arrive while typing** (`injection.behavior`, `clobber` by
  default): `clobber` interrupts for the fastest deliveries. It may clear a
  draft to deliver and keeps the text TAP can capture; pasting it back is
  conditional, and when it does not happen `tap draft` recovers it (OpenCode
  drafts always need that, and pasted content or images may not be captured).
  Typing `WAIT` in caps holds deliveries for two minutes. `wait` parks arrivals
  until the input is empty.

Write the choices to one answers file. This example assumes the human chose
auto for both CLIs, approval before enrolling another project, and delivery
when the input box is empty. It adds no presets, plugins or shell integration.
Substitute their actual choices, then preview the file:

```bash
answers_file="$(mktemp)"
cat > "$answers_file" <<'JSON'
{
  "harnesses": {
    "claude": {"presets": "skip", "permissions": "auto"},
    "codex": {"presets": "skip", "permissions": "auto"}
  },
  "onboarding": {"init": "ask"},
  "injection": {"behavior": "wait"},
  "write": "apply"
}
JSON
tap setup --machine --answers "$answers_file" --dry-run
```

Show the preview in its own message and wait for the person to say yes.
If they change a choice, update the file and preview it again. After approval,
apply the identical file:

```bash
tap setup --machine --answers "$answers_file"
```

`--answers -` reads the same JSON from stdin. `--dry-run` validates the same
choices and shows the intended TOML-key diff and effects without changing files
or running plugins. An empty object reports no changes; it does not complete
onboarding. Successful `--json` output contains `exit_code` and `notes`. Answers
failures exit 1 and return `{ok:false,error_class,action,detail}` on stdout with
empty stderr; `setup_partial` means effects were retained before failure. Without
`--answers`, the existing terminal-attention exit remains 2.

Include `"shellIntegration": true` only when the human accepts managed PATH and
completion setup. It uses the existing Bash/Zsh shell block; no preset aliases
are added without selected presets. Leave it out otherwise. For a reviewable inactive
config, use `"write": "candidate"`; replacing an existing candidate additionally
requires `"replaceCandidate": true`. Shell integration cannot accompany candidate mode. Requested
plugins are independent effects, so omit them during candidate review.

Claude and Codex use the complete TAP plugin, with names such as `tap:lead` and
`tap:config-wizard`. Other hosts start with seven skills: `tap`, `tap-in`, `tap-send`,
`tap-escalate`, `tap-config-wizard`, `tap-help`, and `tap-extend`. For those flat skill catalogs,
`"fullKit": true` with `"write": "apply"` adds the remaining prefixed skills.
`"fullKit": false` removes only unchanged TAP-owned optional links and wrappers;
foreign links, user directories and edited wrappers survive. Omission leaves
the policy alone. Candidate and dry-run choices leave live installation unchanged.
The native plugin always carries all public skills. A disabled plugin stays disabled;
Codex refreshes its cached copy on the next install after you enable it.

Keep any existing model or effort policy and explain it before changing it.
With no policy pinning those values, choose them inside the harness; another
agent can learn this seat's capability from its role or by asking, not from a
bare-harness config. A saved choice is not proof of a running seat's current
model after an in-harness change. Settings outside the answers contract, such as
OpenCode/Hermes bypass parameters or custom model tuning, still use the
[backed-up targeted edit procedure](../skills/config-wizard/SKILL.md#edit-procedure).

`tap launch claude` selects the **harness**. Choose model and effort inside it.
`tap presets` lists nothing on a fresh minimal config until the human creates a
preset through the configuration skill (`tap help skill config-wizard` resolves
its instructions on every host); a returning user's existing presets remain listed.
Names such as `claude` are reserved for harnesses and cannot name usable presets,
even with `--preset`. A saved choice later needs a distinct name such as
`claude-review`.

## 3. Return to the first exchange

Return to [AGENT-SETUP step 3](AGENT-SETUP.md#3-verify-the-command-and-first-reply)
to verify the installation. Follow the
[first-team walkthrough](GETTING-STARTED.md#3-launch-both-harnesses):
the human runs `tap init`, then `tap launch claude` and `tap launch codex`,
and asks one to talk to the other. Launch opens each seat from a foreground
terminal; detach with **Ctrl-b**, then **d** between launches, and use
`tap attach <seat>` to visit it again. Do not substitute a scripted transport exchange for
that task.

Codex may stop at **Hooks need review**, independently of the permission choice
above. Follow the [human hook-review handoff](GETTING-STARTED.md#when-codex-asks-to-review-hooks).
Installing TAP or choosing bypass does not pre-trust hooks; the human decides
which hooks to trust.

## After the first answer

Offer the [notifier choice](AGENT-SETUP.md#human-notification-setup) once after
the first observed answer, retaining any preference already supplied.

Use `tap presets` for saved recipes and `tap team` for who is seated. A bare
`tap launch <harness> [name] --model <id> --effort <level>` launches a model your account supports without a preset.
Use `tap help launch` for legal effort levels; Cursor accepts model only, and
OpenCode's `--effort` selects a model variant. Keep service/context/environment qualifications attached to the launch choice.

Presets save a combination you use often. The configuration skill can save a model and
effort the human already knows they can use. A preset name must differ from a
harness name; for example, `claude-review`.

For shell shortcuts to a preset, resolve `tap help skill config-wizard` and follow
its instructions. The skill previews and writes
managed aliases after the human agrees. For a bare harness, show the proposed
functions and let the human add them to their chosen rc file. Do not edit shell
startup files yourself. For example:

```sh
claude-tap() { tap launch claude "$@"; }
codex-tap() { tap launch codex "$@"; }
```

Keep existing definitions unless the human asks to replace them. The machine
wizard can write its own managed shell block after the human accepts its
shell-integration question, including after skip-all. Without new presets it
adds PATH setup and Zsh completion; it adds preset aliases when presets were
selected. Declining shell integration leaves the shell unchanged.
