# Your first TAP team

Launch Claude and Codex with TAP, ask one to talk to the other,
and see the actual answer. This walkthrough assumes both CLIs are installed and
signed in. TAP supplies communication; the harnesses supply models and accounts.

## 1. Install once

Start the installing agent outside the TAP clone and point it at
[AGENT-SETUP](AGENT-SETUP.md). That runbook holds a paste-ready installation
prompt and covers the permanent clone, prerequisites, permission choices and
installation checks. It creates no presets. Return here after those steps.

Your TAP clone holds the installed software; your project holds the agents'
work. Keep the clone where it is.

## 2. Initialize your project

In a plain terminal, change to your existing project directory and run:

```bash
cd /path/to/your/project
tap init
```

Use your actual project path. Inside a Git repository `tap init` creates `.tap/`
without asking. Outside Git it asks whether to initialize the directory anyway. In an
interactive terminal it asks before creating a missing `AGENTS.md` with TAP's
project instructions; without a terminal, or with `--json`, it writes that file
without asking. Enrollment creates
`.tap/bus` and a team named after the directory; in Git it also ignores
`.tap/`.

## 3. Launch both harnesses

Run these from your project terminal, one at a time:

```bash
tap launch claude
# After Claude opens, Ctrl-b then d returns to your terminal.
tap launch codex
```

TAP starts and registers each seat. A launch from a foreground terminal opens
that agent. From an agent or without a terminal, launch leaves it running in
the background; visit it from your terminal with `tap attach claude` or
`tap attach codex`. `tap team` lists the seat names.

Launch uses your saved permission choice, or bypass mode by default.
[Choose auto mode](#run-without-bypass-mode) before launching if you prefer it.
First starts can ask for trust, one seat at a time:

- **Claude** shows its folder-trust prompt in a new directory. Trust the folder
  only if you intend to give the agent access to it.
- **Codex** may show **Hooks need review**; follow
  [the hook-review guidance below](#when-codex-asks-to-review-hooks).
- **Commands** may need your approval under your selected permission mode.
  Answer in the seat that asks.

If a seat needs attention, `tap team` names it. Use `tap attach <seat>` to
visit it and finish the prompt yourself.

## 4. Ask for the first exchange

Type into either pane, in plain language:

> Run tap team to see the roster, then ask the other agent: should our first
> tiny project start with a README or a test? One sentence of reasoning.
> Show me its actual reply.

Done means the asking pane shows the other agent's actual answer text; a
roster entry, accepted send, queued receipt or sentinel alone proves nothing.

If a seat parks on a prompt, detach (**Ctrl-b**, then **d**), visit it with
`tap attach <seat>` — the seat names are the roster's — finish the prompt, and
return. If no answer arrives, inspect the receiving seat before resending.

If a message arrives while you are typing, type WAIT (in capitals) to hold
deliveries for two minutes.

A **tmux session** keeps an agent running when you detach. Each TAP **seat**
has a name you can address; the **team** is the group working in this project.

| What you want | Keys or command |
|---|---|
| Visit a seat | `tap attach <seat>`, using a name from `tap team` |
| Leave it running and return to your terminal | **Ctrl-b**, then **d** |
| See the roster | `tap team` from the project directory |
| Scroll through output | **Ctrl-b**, then **[**; arrows or Page Up |
| Leave scroll mode | **q** |

Incoming mail may wait while the receiver works or has a draft; a red flash
warns that TAP is about to use the input box. In auto mode, TAP waits for an
empty composer. See the
[first-team sheet](cheatsheet-first-team.html) for delivery and draft recovery.

## When Codex asks to review hooks

Codex may pause at **Hooks need review** before it can answer. Detach from the
asking pane and run `tap attach <seat>` for the Codex seat, using the seat name
from `tap team`. TAP reports the blocking screen; its courier does not press keys to dismiss it
or grant trust.

Choose **Review hooks** and inspect the commands. TAP installs its SessionStart
command, `hooks/tap-codex-session-start.sh`, and its shell-body guard,
`hooks/tap-shell-body-guard.ts`, from your permanent TAP clone. Check that the
paths point to that clone, and trust only hooks you intend to trust. Hook commands
can run outside Codex's sandbox after you trust them.

The captured Codex 0.156.1 screen offers **Trust all and continue** and
**Continue without trusting (hooks won't run)**; **Esc** skips the screen.
Labels can change between Codex versions. Trusting enables the hooks. Declining
or skipping leaves TAP's shell-body guard and SessionStart hooks inactive in
that seat until you trust them through Codex's hook review. Installation does
not pre-trust them, and the agent must not choose trust on your behalf.

After your choice, detach and return to the asking pane. Ask it to check the
original question's status. A dismissed menu or a ready roster is still not the
answer.

## After the first answer

Give one agent a real task and ask another to review the change. The
[collaboration sheet](cheatsheet-collaboration.html) shows ways to divide work.
You can use ordinary language; the agents handle TAP's commands.

To see where TAP can go from here, and why two strong agents are often enough,
read [the five levels of TAP](cheatsheet-level-1.html)
([Markdown guide](TAP-LEVELS.md)).

For another model, start with `tap models`. Personal calibration wins when
present; otherwise guidance is labeled **reference; access unverified**. Inspect
one model with `tap models fable`, then launch a supported choice directly:

```sh
tap launch claude model-reviewer --model fable --effort high
```

`tap help launch` lists legal effort levels. OpenCode and Cursor accept model
only, without `--effort`. Service-mode and environment qualifications stay
attached to each reference variant; they are not universal model capabilities.

Presets save a combination you use often. Once you know which settings work
with your account, `/tap:config-wizard` can save them. The interactive
`tap setup --machine` wizard also offers starter presets; detecting a CLI does
not verify model access. Shell shortcuts and notifier customization can wait
until now; see [Easy Mode](EASY-MODE.md#after-the-first-answer) and
[notification setup](AGENT-SETUP.md#human-notification-setup).

## Configure message previews

```bash
tap config path
tap config get sentinel.preview
tap config set sentinel.preview true
```

With previews enabled, TAP adds the first non-empty body line to the sentinel,
up to `preview_chars` (120 UTF-8 bytes by default, cut at a word boundary).
An explicit `--preview` overrides that derived text. The preview is a hint;
receiving agents still read the full payload. Turn it off with
`tap config set sentinel.preview false`. Changes apply on the next delivery;
the file setting is `[sentinel] preview = true` or `false`.

## Stop and return later

To step away while the agents keep working, detach (**Ctrl-b** then **d**),
then return with:

```bash
tap attach claude
```

When the agents have finished their current work, run this from the same
project directory:

```bash
tap team down
```

This stops the team's sessions while preserving the roster. Run `tap team up`
to resume them, then `tap attach <seat>` to visit each agent. Check its context
before giving it more work.

## Bring an existing conversation into a named seat

Use the same harness and project directory as the old conversation. First launch
a new seat with the name you want; for example, a Claude Code seat named `writer`:

```bash
tap session launch claude writer
tap attach writer
```

Inside the agent CLI, run its own `/resume` command and select the old
conversation. Then, in that resumed conversation, ask the agent to run `tap in`
(in Claude Code, the `/tap:in` command does the same). Ask the agent
to run `tap whoami` and confirm it is `writer`. The conversation comes from the
harness; the seat's name comes from TAP. Stop if the reported name differs, and
have the agent resolve the mismatch before sending it work. The tmux session label
may still show the launcher’s original name after resume; `tap whoami` reports
the current TAP handle.

## Run without bypass mode

Seats that TAP launches use each harness's bypass flag unless you choose
otherwise. To use the harness's permission checks instead of TAP's bypass flag,
set its permissions to `auto`; the next launch picks it up:

```bash
tap config set harness.cursor.permissions auto
```

The flags per harness live in
[`launcher/permissions.ts`](../runtime/bun/src/launcher/permissions.ts):

- **Claude**: `--permission-mode auto`. Its classifier approves routine actions
  and asks you about the rest.
- **Codex**: `--approve-for-me`, automatic review, which can approve a tool
  without asking you.
- **Cursor**: `--auto-review`. Safe calls run; the rest wait for you.
- **Antigravity**: has no automatic mode, so it asks about every tool call.
- **OpenCode and Hermes**: TAP does not set their permissions. Use OpenCode's
  `permission` setting and Hermes's `approvals.mode`.

Claude, Codex and Antigravity also ask you to trust each new project folder the
first time a seat starts there. TAP treats that dialog like any other prompt;
it never answers it for you.

A seat waiting on one of these prompts is blocked, as TAP's
[prompt detector](../runtime/bun/src/agent-state.ts) reads it. `tap team` shows
`● needs you: tap attach <team>/<seat>`
([`team.ts`](../runtime/bun/src/verbs/team.ts)), and `tap admin dashboard` lists
blocked seats first under attention
([`admin.ts`](../runtime/bun/src/verbs/admin.ts)). A blocked seat is not idle, so
`tap team --stalled` never lists it
([`roster-stalled.ts`](../runtime/bun/src/roster-stalled.ts)), and `tap watch`
does not probe it by default ([`watch-evaluator.ts`](../runtime/bun/src/watch-evaluator.ts)).

TAP never types into the prompt, urgent messages included: the
[courier](../runtime/bun/src/courier.ts) holds delivery while the dialog is up.
Attach, answer the prompt yourself, then detach with **Ctrl-b**, then **d**. The
waiting messages then go through.

## If something stops you

| Symptom | Next step |
|---|---|
| `brew` or `bash` resolves to the wrong installation | Follow [AGENT-SETUP prerequisites](AGENT-SETUP.md#requirements-for-both-routes), then check versions in a new terminal. |
| `tap: command not found` | Use the installer's printed bin directory; default: `export PATH="$HOME/.local/bin:$PATH"`. |
| Missing machine config or unknown preset | Bare-harness launches need no config; presets are optional. Follow [Easy Mode](EASY-MODE.md#2-save-simple-machine-settings) to record permission choices. |
| Enrollment refused | Read the exact refusal. Outside Git, init asks before enrolling; a linked worktree enrolls with `tap init` in that worktree. |
| Scripted setup or a missing signpost | `tap init --yes` initializes without questions; `tap setup --repo` repairs a missing signpost. |
| Codex rejects `--approve-for-me` when launching in auto mode | Update Codex to a build that lists `--approve-for-me` in `codex --help`, then launch again. |
| Codex says `Hooks need review` | Visit that seat and follow [hook review](#when-codex-asks-to-review-hooks); trust is your decision. |
| A seat is parked on a permission or sign-in prompt | Attach to it and answer the prompt yourself. When it is ready, ask the sender agent to check whether the original question was answered. |
| The sender reports delivery, but no answer appears | Visit the receiving agent and inspect what it is doing. Avoid resending the same task until you know whether it already started. |

To update TAP later, run `./install.sh --sync` from your TAP clone.
If it refuses because the clone has local changes, resolve those changes and
rerun it; a refused sync is an incomplete update.
