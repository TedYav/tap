# Your first TAP team

Launch Claude and Codex with TAP, ask one to talk to the other,
and see the actual answer. This walkthrough assumes both CLIs are installed and
signed in. TAP supplies communication; the harnesses supply models and accounts.

## 1. Install once

Start the installing agent in the folder you want as your first project (it
keeps the TAP clone elsewhere) and point it at
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

It then asks `Trust current directory in installed harnesses Y/n`, listing the
directory and supported installed harnesses (Codex, Antigravity, Claude and Cursor).
Enter grants each harness's normal folder trust, including any project settings
and hooks that it ties to folder trust. Separate approval dialogs remain untouched.
No leaves trust unchanged; some harnesses may need manual trust before use here.
`tap init --yes` also accepts this question; add `--no-trust-folders` to skip it.
Automatic onboarding and setup do not grant folder trust.

## 3. Launch both harnesses

Run these from your project terminal, one at a time:

```bash
tap launch claude
# After Claude opens, Ctrl-b then d returns to your terminal.
tap launch codex
```

The examples use **Ctrl-b** as the tmux prefix (your prefix, if you remapped it).

TAP starts and registers each seat. A launch from a foreground terminal opens
that agent. From an agent or without a terminal, launch leaves it running in
the background; visit it from your terminal with `tap attach claude` or
`tap attach codex`. `tap team` lists the seat names.

Launch uses your saved permission choice, or auto mode by default.
[Choose bypass mode](#choose-bypass-mode) before launching if you prefer it.
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
| Type a teammate's name from a picker | **Ctrl-b**, then **Ctrl-g**, after `tap keybinding install` |
| Scroll through output | **Ctrl-b**, then **[**; arrows or Page Up |
| Leave scroll mode | **q** |

Incoming mail may wait while the receiver works or has a draft; a red flash
warns that TAP is about to use the input box. In auto mode, TAP waits for an
empty composer. See the
[first-team sheet (web guide)](https://tedyav.github.io/tap/cheatsheet-first-team.html)
for delivery and draft recovery.

## When Codex asks to review hooks

Codex may pause at **Hooks need review** before it can answer. Detach from the
asking pane and run `tap attach <seat>` for the Codex seat, using the seat name
from `tap team`. TAP reports the blocking screen; its courier does not press keys to dismiss it
or grant trust.

Choose **Review hooks** and inspect the commands. TAP installs its SessionStart
command, `hooks/tap-codex-session-start.sh`, and its shell-body guard,
`hooks/tap-shell-body-guard.ts`, from your permanent TAP clone. Check that the
paths for both commands point to that clone, then review and trust each TAP hook
individually. This is the safe choice: **Trust all and continue** can also trust
unrelated hooks. If another entry appears or either path points elsewhere, stop
and check it before granting trust. Hook commands
can run outside Codex's sandbox after you trust them.

The captured Codex 0.156.1 screen offers **Trust all and continue** and
**Continue without trusting (hooks won't run)**; **Esc** skips the screen.
Labels can change between Codex versions. Trusting enables the hooks. Declining
or skipping leaves TAP's shell-body guard and SessionStart hooks inactive in
that seat until you trust them through Codex's hook review. Installation does
not pre-trust them, and TAP's courier never answers a trust or permission
dialog. An installing agent trusts these two hooks only when you approved that
in its automatic-test list, and never chooses **Trust all**.

After your choice, detach and return to the asking pane. Ask it to check the
original question's status. A dismissed menu or a ready roster is still not the
answer.

## After the first answer

Give one agent a real task and ask another to review the change. The
[collaboration sheet (web guide)](https://tedyav.github.io/tap/cheatsheet-collaboration.html) shows ways to divide work.
You can use ordinary language; the agents handle TAP's commands.

To see where TAP can go from here, and why two strong agents are often enough,
read [the five levels of TAP](TAP-LEVELS.md).

Use `tap presets` for saved recipes and `tap team` for who is seated.
Launch another model your account supports directly:

```sh
tap launch claude model-reviewer --model fable --effort high
```

`tap help launch` lists legal effort levels. OpenCode and Cursor accept model
only, without `--effort`. Service-mode and environment qualifications stay
attached to each launch choice; they are not universal model capabilities.

Presets save a combination you use often. Once you know which settings work
with your account, `/tap:config-wizard` can save them. The interactive
`tap setup --machine` wizard also offers starter presets; detecting a CLI does
not verify model access. Shell shortcuts and notifier customization can wait
until now; see [Easy Mode](EASY-MODE.md#after-the-first-answer) and
[notification setup](AGENT-SETUP.md#human-notification-setup).

The wizard asks how messages should reach you while you type in an agent's
prompt. **Interrupt** is the default; it delivers faster when the harness's
permission mode allows delivery into text already typed. In auto mode, TAP
waits for an empty composer. Interrupt may clear your draft. TAP saves only
text it can capture; paste-back is conditional. Use `tap draft` to recover it.
Pasted content or images may be missing. Type `WAIT` in caps to hold deliveries
for two minutes when you need more time. **Wait** leaves your typing alone but
holds messages until the agent's input is empty.

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

After a reboot or a tmux restart, bring back the seats that were running with:

```bash
tap team up --last
```

It previews the most recent group of seats and asks before resuming them;
seats you stopped on purpose stay stopped. `tap launch <harness> <seat>` for a
name that is already running offers a menu instead of a second copy: press
**r** to attach to it.

## Bring an existing conversation into a named seat

Use the same harness and project directory as the old conversation, and launch
the seat with the picker flag; for example, a Claude Code seat named `writer`:

```bash
tap launch claude writer --resume
```

The seat opens the harness's own conversation picker for this directory. Pick
the old conversation; TAP binds it as the seat's identity when the harness's
SessionStart runs (Codex: once its hooks are trusted). `tap whoami` then
reports `writer`, and a later `tap session resume writer` reopens that
conversation. If nothing binds, run `tap in` from the seat (the shell shortcut
`!tap in` is cheaper than the skill form); it binds the same way.

`--resume=<id>` resumes a known conversation id directly instead of opening the
picker. Claude Code and Codex have pickers; other harnesses refuse the flag:
launch them fresh, run their own resume inside, then `tap in`. A seat launched
without the flag that resumes a different conversation inside the app is
quarantined until `tap in <seat> --accept-observed-identity`; prefer the flag.

The conversation comes from the harness; the seat's name comes from TAP. Stop
if `tap whoami` reports a different name, and have the agent resolve the
mismatch before sending it work. The tmux session label may still show the
launcher's original name after a resume; `tap whoami` reports the current TAP
handle.

## Choose bypass mode

Seats that TAP launches use each harness's own permission checks (auto) unless
you choose otherwise. Bypass lets the agent run commands and edit files without
asking, with your own permissions. To choose it, set the harness's permissions
to `bypass`; the next launch picks it up:

```bash
tap config set harness.cursor.permissions bypass
```

A bypass flag left in that harness's `params` refuses an auto launch until the
key says `bypass` or the flag is removed. What auto means per harness, with the
flags in
[`launcher/permissions.ts`](../runtime/bun/src/launcher/permissions.ts):

- **Claude**: `--permission-mode auto`. Its classifier approves routine actions
  and asks you about the rest.
- **Codex**: `--approve-for-me`, automatic review, which can approve a tool
  without asking you. Codex's file sandbox stays on. Its default sandbox blocks
  the tmux socket, so a seat could not send or read. TAP therefore also turns on
  Codex's network proxy with no allowed domains, allows only your tmux socket
  through it, and lets the sandbox write TAP's index folder (`~/.tap`, or
  `TAP_INDEX_HOME`) and the receipt folders of team buses enrolled when the seat
  launches. Missing or symlinked receipt folders refuse launch; other cross-team writes,
  such as parked-mail recovery, still need approved sandbox escalation. A later
  enrollment may need escalation or a seat relaunch. Other network destinations stay blocked for commands the
  sandbox runs; Codex's own model traffic is not affected. This composes with your
  own Codex config: TAP's settings are what it guarantees.
- **Cursor**: `--auto-review`. Safe calls run; the rest wait for you.
- **Antigravity**: has no automatic approval mode, so auto stops the seat on
  every permission request until you answer it in the attached session.
- **OpenCode and Hermes**: TAP does not set their permissions. Use OpenCode's
  `permission` setting and Hermes's `approvals.mode`.

Claude, Codex and Antigravity also ask you to trust each new project folder the
first time a seat starts there. TAP treats that dialog like any other prompt;
it never answers it for you.

A seat waiting on one of these prompts is blocked, as TAP's
[prompt detector](../runtime/bun/src/agent-state.ts) reads it. `tap team` shows
its state as `blocked`; `tap team doctor` explains why and names the
`tap attach <team>/<seat>` command, and `tap admin dashboard` lists
blocked seats first under attention
([`admin.ts`](../runtime/bun/src/verbs/admin.ts)). A blocked seat is not idle, so
`tap team --stalled` never lists it
([`roster-stalled.ts`](../runtime/bun/src/roster-stalled.ts)), and `tap watch`
does not probe it by default ([`watch-evaluator.ts`](../runtime/bun/src/watch-evaluator.ts)).

TAP never types into the prompt, urgent messages included: the
[courier](../runtime/bun/src/courier.ts) holds delivery while the dialog is up.
Attach, answer the prompt yourself, then detach with **Ctrl-b**, then **d**. The
waiting messages then go through.

## TAP and tmux

TAP is developed and tested on macOS; CI runs on macOS. Linux support is best
effort: an Ubuntu 24.04 container smoke reached Claude Code and Codex sign-in,
but did not test an authenticated exchange. The optional keybinding and tmux
defaults installers require tmux 3.2 or newer. Linux desktop notifications and
`wl-copy`/`xclip` integration have not been exercised end to end. `notify-send`
needs a desktop notification service and session; it cannot show notifications
in a headless SSH session.

On Linux hosts managed by systemd, whether SSH-launched seats survive logout
also depends on the host's logout policy. Detach, log out, reconnect and run
`tmux ls` once before relying on unattended seats. `loginctl enable-linger "$USER"`
keeps your user service manager running after logout (administrator approval may
be required), but it does not protect tmux inside a login session when
`KillUserProcesses=yes`. See [systemd's tmux logout guidance](https://www.freedesktop.org/software/systemd/man/latest/logind.conf.html#KillUserProcesses=)
for running it outside that session scope. Linger is irrelevant on hosts without
systemd; this path was not tested in the Linux container smoke.

TAP runs every seat inside tmux. First-run setup can install two optional tmux
integrations (never on a plain sync; both removable, and neither edits your
own lines):

- The lookup key: `prefix C-g` opens the teammate picker — `tap keybinding install`.
- Managed tmux defaults so tmux behaves like a bare terminal — `tap tmux-defaults install`.

The defaults are one TAP-owned file, `~/.config/tap/tmux-defaults.conf`, plus
one marked `source-file` line in your `~/.tmux.conf`, inserted before your own
settings — so anything you set yourself always wins. What they do: true color
(`tmux-256color` with RGB/Tc), mouse on, 10 lines of scrollback per wheel notch
in both copy modes, middle click leaves copy mode, focus reporting on, 10,000
lines of history, and a working clipboard: `pbcopy` on macOS, `wl-copy` or
`xclip` on Linux, OSC 52 fallback over SSH — chosen at install time. TAP sets
no escape-time and no extended-keys. If you have no tmux config yet, the same file also
holds a calm status bar (team/session, windows by name, the time); with a config of your
own you get it only through `tap tmux-defaults install --status-bar`, and
`--no-status-bar` leaves it out either way. `tap tmux-defaults status --json` reports
what is installed and what the running server shows; `--dry-run` prints the
exact lines first; `tap tmux-defaults remove` deletes the file and the marked
line (options already loaded stay until tmux restarts).

**Shift+Enter.** Inside tmux, some terminals' Shift+Enter submits instead of
typing a newline. Any one of these fixes it:

- Run Claude Code's `/terminal-setup`; it maps the key for your terminal.
- Map Shift+Enter in your terminal app to send a plain newline.
- Press **Ctrl+J** for a newline; it works everywhere.
- Advanced: `set -g extended-keys always` plus
  `set -as terminal-features 'xterm*:extkeys'` forwards composer keys such as
  Shift+Enter into tmux — but every pane receives the encoded keys whether it
  understands them or not, so older TUI programs can misbehave.

**Scrollback.** Let tmux own scrollback inside tmux and give it the wheel: in
iTerm2 leave mouse reporting on and set *Scrollback in Alternate Screen* to 0,
so the wheel scrolls tmux instead of a second, competing buffer. tmux before
3.5 waits 500 ms after Esc; recent tmux already uses 10 ms — if Esc feels slow
on an old tmux, set `set -sg escape-time 10` yourself. (tmux-resurrect is a
popular add-on for surviving restarts; TAP does not install it.)

**Copy reaches only the tmux buffer.** If selecting text says "copied N chars
to tmux buffer · paste with prefix + ]" and nothing lands on the system
clipboard, a stale `SSH_CONNECTION` in the session environment is the usual
cause: tmux copies it in the first time you attach over SSH, and Claude Code
then skips its local clipboard path. The managed defaults prevent this; for a
session that already has it, run
`tmux set-environment -t <session> -r SSH_CONNECTION` and restart the seats —
a process's environment is fixed at launch. In iTerm2, OSC 52 delivery also
needs *Applications in terminal may access clipboard* enabled in the profile.

## If something stops you

| Symptom | Next step |
|---|---|
| `brew` or `bash` resolves to the wrong installation | Follow [AGENT-SETUP prerequisites](AGENT-SETUP.md#requirements-for-both-routes), then check versions in a new terminal. |
| `tap: command not found` | Use the installer's printed bin directory; default: `export PATH="$HOME/.local/bin:$PATH"`. |
| Missing machine config or unknown preset | Bare-harness launches need no config; presets are optional. Follow [Easy Mode](EASY-MODE.md#2-save-simple-machine-settings) to record permission choices. |
| Enrollment refused | Read the exact refusal. Outside Git, init asks before enrolling; a linked worktree enrolls with `tap init` in that worktree. |
| Scripted setup or a missing signpost | `tap init --yes` initializes without questions; `tap setup --repo` repairs a missing signpost. |
| Codex rejects `--approve-for-me` or `--no-daemon` when launching | Update Codex to a build that lists both in `codex --help`, then launch again. TAP gives every local Codex seat its own process with `--no-daemon`, so seats do not share one background server. A launch you point at a remote server with `-- --remote <ADDR>` omits it, because Codex rejects the pair and a remote seat's tools run on that server. |
| Codex says `Hooks need review` | Visit that seat and follow [hook review](#when-codex-asks-to-review-hooks); trust is your decision. |
| A seat is parked on a permission or sign-in prompt | Attach to it and answer the prompt yourself. When it is ready, ask the sender agent to check whether the original question was answered. |
| The sender reports delivery, but no answer appears | Visit the receiving agent and inspect what it is doing. Avoid resending the same task until you know whether it already started. |
| `tap team` shows a seat as `error` | Its last turn failed (an API error, usage limit or provider capacity) but its input box still works. `tap team doctor --only seat-state` names the reason and a `tap nudge` or `tap attach` command; once the limit clears, nudge it to continue. |
| You signed in to another account or changed an environment variable, and running seats still use the old one | Restart them in place with their conversations: `tap session relaunch --harness claude --nudge` (or `codex`). `--nudge` tells every seat that was not idle to continue its work; add `--dry-run` to preview. |
| A Claude seat went into agent view (left arrow, `/bg`) and stopped answering | New Claude seats start with `CLAUDE_CODE_DISABLE_AGENT_VIEW=1`, so this affects seats launched before that default. Recovery is `claude stop <short-id>` from another shell, then `tmux respawn-pane` in the seat's own pane with its original directory, arguments and environment plus `--resume <new-session-id>`. The exact, ordered procedure is on the [harness page](../skills/tap/protocol/harness/README.md#claude-agent-view-prevention-and-recovery); prepare the whole command before stopping the worker. |

To update TAP later, run `./install.sh --sync` from your TAP clone.
If it refuses because the clone has local changes, resolve those changes and
rerun it; a refused sync is an incomplete update. A clone carrying your own
committed customizations updates with `git fetch origin`,
`git rebase origin/main` and `./install.sh` instead; the `extend` skill
(`tap help skill extend`) covers customizing TAP.
