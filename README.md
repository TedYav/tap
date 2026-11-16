# TAP

**Coding agents from different vendors message each other on your machine, in tmux panes you can watch.**
Claude Code asks Codex for a review, Codex answers, and each keeps running under your own login in a
terminal you can attach to, read and take over.

TAP works by typing into terminals: agents on your machine inject keystrokes into each other's tmux
panes. If that does not fit your [threat model](SECURITY.md), don't use it.

It is for people who run more than one agent CLI and want them to work together across vendors. If
you use a single vendor, its built-in team feature may be all you need; see
[when another tool fits](docs/TAP-LEVELS.md#when-another-tool-fits).

How it works: TAP writes each message to a file in your project (under `.tap/bus`) and types one
short line, such as `[[TAP v0.23 ask <id>]]`, into the recipient's pane. That agent runs
`tap read <id>` to get the message and `tap reply` to answer. Everything is plain files on one
machine; TAP opens no network port of its own and has no telemetry. The security page lists
[what TAP stores and how to delete it](SECURITY.md#what-tap-stores-and-how-to-delete-it).

TAP is duct tape, not fiber optic, **but it works!** Modern agents don't need much to
coordinate: a way to reach one another, a clear task, and a few shared rules. TAP supplies the
messages and wakes; the agents bring the judgment.

## Before you install

- **By default it waits for an empty input box.** A *seat* is an agent session TAP launched under
  a name. Claude Code, Codex, Cursor and Antigravity seats launch in *auto* mode: TAP delivers a
  message only when the input box is empty, and an urgent message cannot interrupt the agent.
  For Claude Code, Codex and Cursor, auto is the CLI's own automatic-approval mode, so the agent
  can run routine actions without asking you; Antigravity asks every time.
  [What auto means per CLI](docs/GETTING-STARTED.md#choose-bypass-mode).
- **Bypass mode is opt-in and grants the agents your permissions.** It also lets TAP deliver into a
  box you are typing in: after a 30-second grace it saves your draft, clears the box and delivers.
  OpenCode and Hermes seats, and panes you join by hand with `tap in`, are delivered to this way
  too. [Mail while you type](docs/GETTING-STARTED.md#mail-while-you-type) covers the controls.
- **Prompts stay yours.** Message delivery waits while a sign-in, folder-trust or permission prompt
  is on screen; it does not answer one.
- **Beta: expect bugs.** Linux support is best effort
  ([platform notes](#platforms-and-versions)). Report bugs and requests at
  [GitHub Issues](https://github.com/TedYav/tap/issues), or email ted@tedyav.com if you cannot use
  Issues. Include `tap --version`.

## Install

You need Git, Bash 5+, Bun 1.4+, jq, tmux, tar and lsof, plus at least one
[supported agent CLI](#supported-agent-clis), installed and signed in.

```bash
git clone https://github.com/TedYav/tap.git ~/tap
cd ~/tap
./install.sh --report   # preview which agent CLIs the installer would wire
./install.sh
```

Keep the clone: the `tap` command is a link into it, and the hooks the installer adds to your
agent CLIs point into it too. On a first run in a terminal the installer asks setup questions, including two
optional tmux integrations (a keybinding and tmux defaults); answer `n` to skip either. If your
shell then cannot find `tap`, run the `export PATH=...` line the installer printed.

Prefer to have an agent install it? Paste the prompt from the
[landing page](https://tedyav.github.io/tap/#agent-install) into any agent you run; it follows the
[setup guide](https://tedyav.github.io/tap/setup.md) and the runbook in
[docs/AGENT-SETUP.md](docs/AGENT-SETUP.md).

## Get your first reply

1. **Initialize your project:**

   ```bash
   cd /path/to/your/project
   tap init
   ```

   In a Git repository this creates `.tap/`, adds `.tap/` to `.gitignore` if
   it is not already ignored, and enrolls the project in TAP's index under
   `~/.tap/`. In a terminal it asks before adding a short, delimited TAP section
   to `AGENTS.md`; `--no-instructions` skips that file. It then offers to mark
   the folder trusted in your installed agent CLIs: answer `n`, or pass
   `--no-trust-folders`, to skip that. `tap init --dry-run` previews the paths
   without writing, and every run lists what it changed. Outside Git it asks
   before initializing.

2. **Launch two seats.** Each seat runs in its own tmux session:

   ```bash
   tap launch claude
   # After Claude opens, Ctrl-b then d returns to your terminal.
   tap launch codex
   ```

   Only have one of them? Launch it twice, giving the second seat a name:
   `tap launch claude`, then `tap launch claude reviewer`.

   From a foreground terminal, launch opens the agent. Launched by an agent or without a
   terminal, the seat starts in the background; visit it with `tap attach claude`.
   Already inside tmux? Launch leaves the seat running in the background;
   `tap attach claude` switches your tmux client to it, and your prefix
   then **L** switches back to the session you came from.

   Finish any sign-in, folder-trust or
   [hook-review prompt](docs/GETTING-STARTED.md#when-codex-asks-to-review-hooks)
   yourself. Launch uses your saved permission choice, or auto mode by
   default; [choose bypass mode](docs/GETTING-STARTED.md#choose-bypass-mode)
   before launching if you prefer it.

3. **Ask one to talk to the other.** Type this into either agent:

   > Run tap team to see the roster, then ask the other agent: should our
   > first tiny project start with a README or a test? One sentence of
   > reasoning. Show me its actual reply.

   Approve the `tap` command if the agent asks. Done means the **answer text in the pane where
   you asked**. A roster entry or a delivery receipt is not an answer.

[Your first TAP team](docs/GETTING-STARTED.md) is the full walkthrough, with prompts, recovery and
returning to seats. [The five levels of TAP](docs/TAP-LEVELS.md) shows what you can do with two
agents and when a larger team helps.

## Day to day

| What you want | Command or keys |
|---|---|
| Visit a seat | `tap attach <seat>` |
| See who needs attention | `tap team` from your project |
| Leave an agent running | **Ctrl-b**, then **d** (your tmux prefix, if you remapped it) |
| Scroll in a terminal | **Ctrl-b**, then **[**; **q** to leave scroll mode |
| Type a teammate's name from a picker | **Ctrl-b**, then **Ctrl-g** (once `tap keybinding install` has run) |
| See every team's seats on this machine | `tap teams --seats` |
| Stop the team's sessions, keeping the roster | `tap team down` |
| Bring the team back | `tap team up`, or `tap team up --last` after a reboot |

`tap team` shows each seat's state (working, idle, blocked or error), its
context use and, for Claude, an estimate of when its prompt cache expires.
A **blocked** seat is waiting on a prompt: visit it with `tap attach <seat>` and
answer the prompt yourself. Then return to the pane where you asked and have it
check the original question before sending it again. An **error** seat's last turn
failed (an API error or a usage limit) but its input box still works.
`tap team doctor` explains each blocked or error seat and names the command that helps it.

After the first reply, give a real task: "Make this change, have the other agent
check it, and show me what you agreed to fix." Plain language is enough; the agents
run the TAP commands. The [cheat sheets](docs/CHEATSHEET.md) collect the commands, the
[collaboration sheet (web guide)](https://tedyav.github.io/tap/cheatsheet-collaboration.html) covers
dividing work among agents, and the [skills guide](docs/SKILLS.md) covers the skills for larger teams.

## Supported agent CLIs

TAP calls an agent CLI a *harness*. It supports six and refuses any other program at launch and
at delivery; adding one means changing TAP's source.

| Harness | `tap launch` name | Notes |
|---|---|---|
| Claude Code | `claude` | Most complete: TAP plugin, `--resume` picker, conversation fork |
| Codex | `codex` | Most complete, as for Claude Code |
| OpenCode | `opencode` | Requires OpenCode 2.x; TAP turns its [session tabs](docs/attach-launch-reference.md#opencode-session-tabs) off by default |
| Cursor | `cursor` | Runs the `cursor-agent` CLI; `--model` only, no `--effort` |
| Antigravity | `agy` | Auto mode stops on every permission request until you answer |
| Hermes | `hermes` | The least tested of the six |

Google's `gemini` CLI is not one of the six. `tap help launch` lists the tuning each harness
accepts, and `tap presets` lists saved launch recipes.

## Update and uninstall

Update from your clone:

```bash
cd ~/tap && ./install.sh --sync
```

Uninstall with TAP's own command **before** you delete the clone:

```bash
tap uninstall --dry-run   # preview what would be removed
tap uninstall
```

`tap uninstall` removes the install artifacts TAP recorded, including the TAP plugin it registered
with Claude Code and Codex, then says when the clone is safe to delete. Agent sessions keep running;
unrelated plugins and anything you edited stay.
If you delete `~/tap` first, the uninstaller goes with it and the hooks in your agent CLIs point
at files that no longer exist.

Uninstall keeps your message history unless you pass `--history delete`;
[what TAP stores and how to delete it](SECURITY.md#what-tap-stores-and-how-to-delete-it) has the detail.

## Make it yours

TAP is deliberately small: a folder of message files, a courier that types the wake line into
tmux panes, and a launcher. Because the install is a Git clone, there is no bundle to patch. Want
a launch default or a command of your own? Ask your agent to change TAP and commit the change, or
fork the repository and run your own version. The `extend` skill (`tap help skill extend`) gives
your agent the map: settings first, then the source, plus how to keep your changes across
updates. The repository also ships TAP's development docs (`docs/ARCHITECTURE.md`,
`docs/PHILOSOPHY.md`, `CONCEPTS.md` and `docs/solutions/`), so your agent can get up to speed
before it changes anything.

## How messages arrive

The receiving agent reads the message and decides what to do; TAP's delivery receipt does not
prove the agent processed it. Delivery is best effort and at-least-once in intent: a message can
fail visibly and can arrive twice. It is never a guarantee.

[Push, not poll](docs/PHILOSOPHY.md#push-not-poll): after sending, an agent keeps
doing useful work that does not depend on the reply. When it needs the answer,
it yields and lets the reply wake its pane. This avoids repeated model turns
spent checking for mail; it does not make coordination token-free. The
[command reference](skills/tap/QUICK-REFERENCE.md) lists the messaging commands agents use, and the
[protocol guide](skills/tap/protocol/README.md) documents delivery, drafts,
identity checks and reply obligations.

## Platforms and versions

TAP is developed and tested on macOS, where the full test suite runs. The public
repository's CI runs a smaller set on Ubuntu: fast smoke tests, a typecheck and
an install smoke. Linux support is best effort. An Ubuntu 24.04 container smoke
reached Claude Code and Codex sign-in, but an authenticated exchange on Linux has
not been tested. The optional tmux keybinding and defaults installers require
tmux 3.2 or newer.

Versions read `0.<protocol>.<release>`: installs that share the middle number speak the same
wire protocol and can work on one team, and the last number counts releases within it.
[CHANGELOG.md](CHANGELOG.md) has release notes. Release archives that bundle Bun are a future
option; the [release artifact guide](docs/RELEASE-ARTIFACTS.md) has the procedure.

## Stability

TAP is beta and makes no compatibility guarantee yet. The protocol version is the middle number
of the release, the one printed in every wake line (`[[TAP v0.23 ...]]`).

- **Intended to hold within 0.23.x:** the wake-line format, and the everyday commands that
  `tap help` lists under "Start here" and "Communicate" (`launch`, `attach`, `team`, `send`,
  `assign`, `read`, `reply`, `ask`, `escalate`).
- **Experimental; may change or be removed in any release:** `tap watch`, `tap goalie`,
  `tap calibrate`, the recovery commands (`unwedge`, `operate`, `detective`), crews, and the
  team-leading skills (`tap:lead`, `tap:conduct`, `tap:drive`, `tap:pair`, `tap:discuss`).
- **Internal; no promise:** the names and formats of files under `.tap/` and `~/.tap/`, the
  wording of human-readable output, and the pages under `skills/tap/protocol/`.
- **Upgrades:** TAP never converts an old team registry. When a release changes that format,
  `tap` refuses the old file with the error `old_store` and names the next step.
- **Renames:** a renamed command keeps a stub that refuses and names its replacement; `tap help`
  lists the current ones.

## Contributing

When changing TAP itself, read `AGENTS.md` in the source checkout for the current
test, review and delivery rules. Installing TAP does not require running the development suites.

Features we have scoped but are holding until users ask for them, such as tunable security
levels, are listed in [community features](docs/COMMUNITY-FEATURES.md). Open an issue or add a 👍
to vote.
