# Set up TAP for a human

You are setting up TAP for a human on this machine. Install a verified release
archive or use a permanent clone, configure the chosen harnesses, and verify an
actual reply before reporting success. Start in the folder where the human wants
to work. Inside Git, TAP enrolls the repository root. Outside Git, it enrolls
the starting folder. Keep the TAP clone outside the project. This is the
installation runbook; the [configuration wizard](../skills/config-wizard/SKILL.md)
owns the configuration step below.

TAP is beta software; expect bugs. Tell the human before you start. Direct bug reports and
feature requests to [GitHub Issues](https://github.com/TedYav/tap/issues), with ted@tedyav.com
as a fallback if they cannot use Issues.

A human who wants another agent to start this install copies the prompt from the
[landing page](https://tedyav.github.io/tap/#agent-install); this runbook is what that agent follows.

## Boundaries

- Never run `install.sh` from a disposable worktree. Keep the permanent clone;
  installed links point into it.
- Never edit a shell startup file yourself. Let machine setup write its managed block after consent.
  If persistent PATH setup is still needed, show the human the exact line and
  ask them to add it.
- On any refusal, stop and show the exact message. Do not work around it by
  deleting files, replacing config, changing permissions or bypassing a check.
- Use `install.sh --sync` only for a requested update or to finish this requested
  clone installation when the installer reports `STALE`. Run it from the permanent
  clone. Archive installs use the release bootstrap for upgrades; they refuse `--sync`.
- Do not answer preference questions for the human. Do not install optional
  plugins, replace existing config or launch agents on assumed choices. An
  explicit yes to the named list in step 3 is not an assumed choice.
- Preview before you apply. Show which harnesses the installer will change.
  The pasted prompt covers Claude Code and Codex. If the install would wire
  or update another CLI, wait for the human’s OK before installing.
  Preview machine configuration and any shell integration together and wait
  for a yes before applying them.
  Put anything the human must read in a message of its own that ends your turn;
  a question dialog can hide text above it in the same turn. Configuration
  preferences each need a separate question and answer, with the recommended
  option first. Group independent questions in structured dialogs up to the
  harness's question limit, splitting the rest into later dialogs. Without a
  structured dialog, ask one question per turn. The terminal wizard is the human
  answering for themselves: it applies their answers when it finishes, after
  showing any startup-file change and asking
  before it replaces an existing config.

## 1. Choose the install source and check requirements

Record the absolute starting directory with `pwd -P` and keep it as
`project_dir` for the conversation. Run `tap init` and the launches from
that directory so the conversation picker finds the right chat. Step 3 uses
the init preview to locate the team registry. Run the installer from its
permanent directory in a separate shell.

Downloadable releases are not published yet. Use the archive route only when the
human supplies a release archive, its trusted SHA-256, and the bootstrap from the
same release. Otherwise use the clone route below.

### Release archive

Follow the [release artifact guide](RELEASE-ARTIFACTS.md#check-the-archive) to
select the archive for this machine. Keep its path in `TAP_ARCHIVE` and its
trusted digest in `TAP_SHA256`; do not fetch an untrusted checksum alongside an
untrusted archive and call that provenance. Run the bootstrap in step 2 after
checking the requirements and harnesses below.

The default installation uses this stable path:

```bash
tap_root="$HOME/.local/share/tap/current"
```

For a custom `--prefix`, use its `current` path throughout. An archive bundles
Bun and has `tap-release.json` instead of Git history. Do not clone TAP, install
a separate Bun, or run Git ancestry checks to verify this route.

### Permanent clone

If you came from the web setup instructions, use the permanent clone already
verified there. Otherwise check that Git is installed as described under
Requirements below. Use the human’s TAP address if supplied. For a new
destination outside the project, the default clone command is:

```bash
git clone https://github.com/TedYav/tap.git ~/tap
```

If cloning fails, stop and show the human the error; do not substitute another URL.

For an existing destination, confirm it is the primary checkout as described
below. Before fetching, check that `git remote get-url origin` there identifies
the repository the human requested. Leave an unrelated directory alone and ask
where to put the clone. In the verified checkout, run `git fetch origin main`.
Check that `git branch --show-current` prints `main`, and that both
`git status --porcelain` and `git log origin/main..HEAD` print nothing.
Update it with `git merge --ff-only origin/main`, which stops on divergence. Anything else, show the human and ask; never move or delete
their clone on your own.

For the remaining examples the permanent clone is `~/tap`. Substitute its actual
path throughout. Check that it is the primary checkout, not a linked worktree:

```bash
git -C ~/tap rev-parse --show-toplevel
git -C ~/tap rev-parse --git-dir --git-common-dir
tap_root="$HOME/tap"
```

A linked worktree has a separate git directory under the common repository’s
`worktrees/` directory. Stop if the clone is a worktree or its role is uncertain.

### Requirements for both routes

Check installed requirements:

```bash
git --version
bash --version
jq --version
tmux -V
tar --version
command -v lsof
```

Both routes require Git, Bash 5+, jq, tmux, tar and lsof. Archives also require gzip and
`shasum` or `sha256sum`; URL installation needs curl. Check those tools with
`command -v` before taking the archive route. Clone installs additionally require
Bun 1.4.0+; check `bun --version` for that route. Python is not required.

Explain, then ask. Your first message tells the human in one line what TAP is,
that it is beta software and where bugs go, what is present, what is missing,
and which harness CLIs you found. For each missing requirement give one line on
what it does for TAP, the exact command, and who runs it. Say what tmux is
whether or not it is installed: tmux runs each agent in its own named window the
human can visit, and TAP needs it. You run the version checks and, after a yes,
the package installs. The human runs every step that needs a TTY or `sudo`
(installing Homebrew, `brew shellenv`, harness sign-in): give them the exact
command to copy and the reason it needs them. End that message with one
question, "Install these now?", and wait; when nothing is missing there is no
question. After each human step, re-run the checks, and run `hash -r` (or open a
new terminal) so `env bash` finds Bash 5 rather than the old one it cached.
macOS's bundled Bash is too old.

Install missing requirements before running `./install.sh --report`. The report
needs those tools too; without them it prints install commands and exits 127.

When tmux was missing and the human has no tmux configuration (no
`~/.tmux.conf`, no `~/.config/tmux/tmux.conf`), add one sentence to that same
message: after TAP is installed you will offer TAP's recommended tmux settings
(true color, mouse, scrollback, clipboard, and a status bar) and show them the lines first. In
step 2, after the configuration receipt, show the `tap tmux-defaults install
--dry-run` output in a message of its own, and install after a yes. Someone
with an existing tmux configuration gets the offer in step 4 instead.

On macOS with Homebrew, the install commands are:

```bash
brew install git bash jq tmux
```

For the clone route, also install Bun:

```bash
brew install oven-sh/bun/bun
```

Homebrew may print unrelated caveats about Xcode Command Line Tools or suggest
`sudo rm -rf` cleanup commands. If the package install succeeded, explain that
these are harmless for TAP setup; do not run the suggested cleanup commands.
If the install failed, report the failure instead.

If Homebrew is missing, the human installs it (it needs a TTY and `sudo`):

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

They then follow its printed Next steps. If `brew` is not on PATH, use the full path:
`eval "$(/opt/homebrew/bin/brew shellenv)"` on Apple Silicon, or
`eval "$(/usr/local/bin/brew shellenv)"` on Intel. Have the human add Homebrew's
printed shell setup to their startup file; do not edit that file yourself.
Then repeat the checks above.

On Linux, install the packages with the distribution's manager (with `sudo`, so
the human runs it):

```bash
sudo apt install git bash jq tmux tar lsof     # Debian, Ubuntu
sudo dnf install git bash jq tmux tar lsof     # Fedora
sudo pacman -S git bash jq tmux tar lsof       # Arch
```

TAP uses `lsof` to identify harness sessions and check tmux client terminals.
macOS includes it; on Linux, install it with the packages above.

For the clone route, install Bun from its official installer, which provides
1.4+ where distribution packages lag:

```bash
curl -fsSL https://bun.sh/install | bash  # then hash -r or a new terminal
```

Have the human install and sign in to Claude Code and Codex before the launch
check ([Claude Code setup](https://docs.claude.com/en/docs/claude-code/setup),
[Codex CLI](https://github.com/openai/codex)). Start each CLI directly once to
finish sign-in. TAP does not supply accounts. On Ubuntu 24.04, the distribution’s
Node 18 is below [Claude Code’s npm requirement of Node 22+](https://code.claude.com/docs/en/setup#install-with-npm);
use Node 22+ from nodejs.org or NodeSource before installing harnesses with npm.
Claude Code’s native installer does not need Node.

## 2. Install and configure

For a clone, after the requirements are installed, preview harness wiring:

```bash
"${tap_root:?set tap_root to the verified installation path}/install.sh" --report
```

The installer links into the permanent clone or the archive's stable `current`
path. It also wires TAP's hooks and plugins into each supported harness home
(`~/.claude`, `~/.codex`, `~/.cursor`, `~/.config/opencode`, the Gemini home)
only when that harness's command is on PATH or its hooks file already exists.
A bare home directory with neither is left untouched, and a missing directory
is skipped. The report writes nothing and names, per harness, one of *will wire*,
*already wired*, *present, not wired* (with the
reason) or *absent*. Show the report in its own message. Name the CLIs whose
hooks or plugins the installer can add or refresh, including eligible CLIs
marked *already wired*. If the list includes anything besides Claude Code and
Codex, wait for the human’s OK for that list. If they decline an extra CLI,
leave the install pending. When the list is approved or contains only the
requested pair, install the clone:

```bash
"${tap_root:?set tap_root to the verified installation path}/install.sh"
```

For a supplied archive, check the same eligibility conditions and show the
harness list before running the bootstrap, which invokes the installer. Wait for
the same approval for extra CLIs. From the download directory, use the archive
and trusted digest selected in step 1:

```bash
/bin/bash tap-bootstrap.sh --archive "$TAP_ARCHIVE" --sha256 "$TAP_SHA256"
```

A harness they install later is wired by one more `./install.sh --sync`.
A first interactive install without a machine config opens `tap setup --machine`.
A non-TTY agent runner
skips the wizard and prints a next step; the wizard itself requires a TTY.
Use `tap setup --machine --answers <file>` from a non-TTY runner. Do not pipe
default answers into the wizard or treat the skipped wizard as an error.

If the terminal wizard opens, relay each prompt and wait for the human's
answer; it asks the same questions as the walkthrough below. Preset selection
defaults to **skip**. Claude, Codex, Cursor and Antigravity keep their existing
permission choice; a new choice needs an explicit answer, and the wizard's own
default is **auto**. Recommend **auto**, and name **bypass** as the alternative
with its consequence in one sentence: bypass lets the agent run commands and
edit files without asking, with the human's own permissions; auto keeps the
harness's approval checks. Before the human picks, say: Claude auto may pause
on the first TAP message; run `tap init` in the project, then check the attached
Claude session and approve any permission prompt. With auto the first Codex reply
may need one retry with sandbox escalation, which the test in step 3 handles,
and Antigravity auto
stops the seat on every permission request. Fresh Codex configs keep Ponytail
off until requested. Ponytail is an optional third-party plugin that makes the
agent favor the simplest solution; off has no effect when it is not installed.

The wizard preserves existing presets, comments and unrelated settings. An
accepted config update keeps a backup; declining it writes an inactive candidate
for review. Malformed or retired configs must be repaired or migrated first.

Follow the installer's printed PATH instructions. With the default bin directory:

```bash
export PATH="$HOME/.local/bin:$PATH"
tap help
```

This export affects the current shell only. Show the human the line to add to
their shell startup file for future terminals; do not edit it yourself. The
setup writer can write its own managed shell block when the human accepts its
shell-integration question or explicitly selects `shellIntegration` in answers. Without new presets, the
block provides PATH setup and Zsh completion; with presets it also adds one alias per selected preset. It adds
the `export PATH` line only when the install bin directory is not already on
the wizard's PATH; if it was, the block carries no PATH line, so confirm the new
terminal finds `tap`.

### Walk the human through configuration

When a non-TTY runner skipped the wizard, or settings remain, read
`skills/config-wizard/SKILL.md` under `tap_root` and follow its
[walkthrough](../skills/config-wizard/SKILL.md#walkthrough). It owns every
knob and the answers format; this runbook fixes their order. Follow its batching
rule: group independent preference questions up to the harness's structured-dialog
limit, each with its own answer and recommended option first; split the rest into
later dialogs. Otherwise ask one question per turn. Wait for an answer before
asking a question that depends on it. Retain choices already accepted in the
terminal wizard:

1. **Find the harnesses.** Check for the six supported executables and tell the
   human which you found: `claude`, `codex`, `cursor-agent`, `agy`
   (Antigravity), `opencode` and `hermes`. Anything else is unsupported today;
   OpenCode requires **2.x**: check `opencode --version` and upgrade 1.x before
   continuing. TAP launches it with a private server (`--standalone`); hand-started
   TAP seats need that flag too.
   Invite them to request another harness at <https://github.com/TedYav/tap/issues>, or
   to have an agent add it later with `tap help skill extend`.
2. **Ask how they want to launch.** Presets for the common models of each
   harness they use, one preset to try the idea, or bare harnesses with
   configuration later. All three are fine first choices; bare is the shortest
   route to a first reply. OpenCode has no common-model preset: ask which
   models they like.
3. **Ask about effort**, if they chose Claude or Codex presets: the vendor's
   default effort, or a pinned level. The presets arrive with basic calibration
   and role notes, including a pronoun for each model's seat, that they can
   edit later.
4. **Ask each permission choice.** Recommend auto, the default, and name
   bypass as the alternative with its one-sentence consequence (above); ask
   once before enabling bypass unless already authorized. A harness with no
   saved choice launches with auto. Before the Claude choice, explain that auto
   may pause on the first TAP message: run `tap init` in the project, then check
   the attached Claude session and approve any permission prompt. Codex auto
   keeps Codex's file sandbox and its automatic approval review, not a human
   approval dialog, and TAP turns on Codex's
   network proxy with no allowed domains so seats can reach the tmux socket
   (other destinations stay blocked for commands the sandbox runs). Relay review refusals exactly.
   Cursor and Antigravity take the same auto/bypass choice; Antigravity has no
   automatic approval mode, so auto stops the seat on every permission request,
   which the wizard explains; say so when Antigravity is chosen.
5. **Ask the two new-user questions:** whether TAP asks before setting up a team
   in a new project, and whether arriving messages interrupt a draft or wait. The draft
   choice applies in bypass mode, in OpenCode and Hermes seats, and in panes
   joined by hand with `tap in`. In auto mode, Claude Code, Codex, Cursor and
   Antigravity seats always wait for an empty input box.
6. **Offer shell aliases last**, when they chose presets: typing `opus`,
   `fable`, `sol` or `astra` instead of `tap launch opus`. Detect their shell
   first. The writer supports Bash and Zsh.
7. **Preview, then apply.** Put every answer in one answers object and run it
   with `--dry-run`. Send the preview as a message of its own: a summary in the
   human's words (harnesses, presets, effort, permission per harness, the two
   new-user answers, aliases), then the startup file and the managed block
   exactly as the dry run prints it, verbatim. The dry run shows a starter's
   calibration notes as one line per preset; `--verbose` lists every key. End
   that turn with "Reply yes to apply, or tell me what to change." Apply the
   identical object only after a yes, then report the config path, the backup
   path, and that aliases work in a new terminal.

Defer third-party plugins, optional flat-host skills and the notifier to a later run unless the
human raises them; offer the notifier once after the first observed answer.
Never accept an optional offer on the human's behalf. A candidate config is
inactive until explicitly adopted.

[Easy Mode](EASY-MODE.md) is the same step for the bare choice, with a
zero-preset answers example.

## 3. Verify the command and first reply

```bash
tap help
```

Check the installed link with `ls -l` at the path the installer printed. It must
point into the installation selected in step 1. Record the absolute path of
that installed command for the human to use after leaving this chat.

For an **archive**, record the bootstrap's archive digest and installed-version
line, then inspect the marker at the installed path:

```bash
cat "$tap_root/tap-release.json"
```

Record its version, source commit, platform and bundled Bun version. Confirm that
the version matches the successful bootstrap receipt. After `tap init` below,
run `tap doctor --json` from that project and compare its `release` finding with
the marker. An archive has no `origin/main`; Git ancestry is not its verification.
For a requested upgrade, use the new archive and trusted digest through the bootstrap.

For a **clone**, record `git -C "$tap_root" rev-parse HEAD` and the installer's
live/`STALE`/`CANNOT-CHECK` ancestry line verbatim. If it reports `STALE`, finish
the requested installation by running `./install.sh --sync` from the permanent
clone. Record the new ancestry line. A refusal stops setup; `STALE` or
`CANNOT-CHECK` is not a verified live installation. Report success only after
`origin/main` is confirmed as an ancestor of the executing HEAD for this route.

From the recorded starting folder, run `tap init --yes --dry-run --json`.
Check that it succeeded. Record the returned `team.root` as `team_root`,
including for the by-hand path. The `changes` list shows the exact paths TAP
would write. The `folder_trust_grants` list shows the harnesses, configuration
paths and settings for trust in the starting folder. Use those values in the
question below. If they choose a different folder, preview again from there.

> Ready to test TAP. I can test automatically, which means I will:
>
> - set up the team at `<team_root>` from our starting folder `<project_dir>`. The preview lists `<paths and actions, or “no file changes”>`. It requests `<harness, path and setting for each folder-trust grant, or “no folder trust”>`.
> - ask you to reopen this conversation inside TAP so I can message the test seat directly.
> - launch the other harness as a seat named `partner` in the background: Codex if I am Claude Code, Claude if I am Codex;
> - review the two TAP hooks wherever Codex asks and trust each one only if its path points into `<verified TAP installation>`. Codex applies this choice machine-wide.
> - send `partner` one question and show you its reply verbatim; leave both seats running.
>
> Or I can walk you through the same steps by hand in your terminal, one at a time. Automatic, or by hand?

Under auto permissions add one line before the question: "Codex seats run TAP
commands inside Codex's sandbox, which TAP lets write its index folder and the
receipt folders of enrolled team buses; a refusal naming 'identity unobservable' calls
for retrying the exact command once with sandbox escalation, which automatic
review evaluates. That is expected, not a stale registration."

**Automatic**, in this order. From the same starting folder used for the
approved preview, run `tap init --yes`. Check its receipt before launching.
Relaunch yourself inside TAP as described below. Launch the other harness
as a seat named `partner`, from the project, with the bare harness form so the
handle is exactly `partner`: `tap launch codex partner` when you are Claude
Code, `tap launch claude partner` when you are Codex. Codex's hook review
appears on whichever seat is Codex.
When the partner is Codex, watch its pane: on **Hooks need review** choose
**Review hooks**, confirm the two commands are `hooks/tap-codex-session-start.sh`
and `hooks/tap-shell-body-guard.ts` under the permanent clone, and trust each one
individually, never **Trust all**; any other entry, or a path elsewhere, stops
the test, and you show the human the screen. When you are Codex, the review
appears in your own relaunched seat before the conversation picker: include that
in the relaunch steps, naming the two hooks, since their yes already covers it.
Then ask the partner a question with `tap send partner --ask -f <file>`, wait
for its reply, and show the answer text verbatim. If the human chose another
folder as the project, or your harness has no resume, say so and run the
exchange with two fresh seats instead, reading the asking seat's pane for the
reply. If a Codex seat reports the refusal named above and does not retry on
its own, nudge it with that same sentence; never suggest re-registering.

**By hand**: narrate [the first-team walkthrough](GETTING-STARTED.md) one step
per turn (`tap init`, `tap launch claude`, **Ctrl-b** then **d**, `tap launch
codex`, the trust screens, the question, the reply), waiting after each. Offer
the relaunch below; it is optional on this path. Success on either path is the
other pane's actual answer shown in the asking pane; a roster entry, queued
receipt or sentinel is not. Use fresh, agreed seat names if conversations
already exist; never replace one.

Outside the approved list, the human finishes any sign-in, trust or permission
prompt in the pane that shows it; `tap attach <seat>` visits a seat by its
roster name. TAP's courier never answers a trust or permission dialog; the
[hook-review page](GETTING-STARTED.md#when-codex-asks-to-review-hooks) shows
the human what to expect. Inspect the receiving pane before resending if no
answer returns. Leave the seats available unless the human asks to stop them.

A seat's model shows `?` in `tap team` until its SessionStart hook has run;
trusting hooks after startup delays that display.

For configuration questions, use `tap config path` and
`tap config get sentinel.preview`. Change a preference only when requested:
`tap config set sentinel.preview true` (or `false`) takes effect on the next
delivery. Enabled previews derive from the first non-empty body line, bounded
by `preview_chars` (default 120 UTF-8 bytes); `--preview` overrides that text.
Previews never replace reading the payload.

### Relaunch yourself inside TAP

The installation should end with the human working inside TAP, and this
conversation comes along when it runs in Claude Code or Codex. This runbook
documents the steps for those two harnesses only; from any other harness, run
the round trip above with two fresh seats.

The conversation picker lists chats from the directory where the seat starts.
Return to the original starting folder even when the team root is above it.
If the human wants to work in a different folder, use two fresh seats there.

1. Before the human exits you, tell them your harness, your conversation's id
   (`echo $CLAUDE_CODE_SESSION_ID` in Claude Code, `echo $CODEX_THREAD_ID` in
   Codex) and this conversation's first message to find it in the picker. Write
   the id down in your reply; the check below compares against it. If the
   variable is empty, say so: the relaunch still works, but nothing can later
   confirm which conversation TAP recorded.
2. Before `/exit`, tell the human: "This chat will disappear, then return inside
   tmux. A status bar at the bottom is expected." Give them this plain script
   in one message. Substitute the absolute installed command path verified
   above, quoted for the human’s shell, and the actual harness, first message
   and conversation id. Include the attach instruction if their terminal is
   already in tmux.

   > 1. Type `/exit`.
   > 2. In the same folder, run `"<absolute tap path>" launch <harness> installer --resume`.
   >    If you are already in tmux, the seat starts in the background. Run
   >    `"<absolute tap path>" attach installer` to open it.
   > 3. In the picker, select this conversation, matching its
   >    first message and id: `<first message>` — `<id>`.
   > 4. Say "I'm back" to the agent.

   The absolute path works in the shell that returns after `/exit`, even
   before it loads new PATH settings or aliases. For Claude and Codex,
   `tap launch --resume` opens the native picker without creating a conversation.
   For Codex, include the two-hook review instructions above: it may appear
   before the picker, and SessionStart binds the choice once hooks are trusted.

   If you resume by hand instead of through `tap launch --resume`, avoid
   `codex resume --last` from an already-started seat: that seat's empty
   conversation may be the newest one. Select the recorded conversation instead.
3. Back in this conversation, run `tap whoami`. The handle must be the seat's
   name, `installer`. TAP bound the picked conversation when the harness's
   SessionStart ran; if `tap whoami` cannot resolve the seat, run `tap in` once
   (the human can type `!tap in`), which binds the same way. No
   `--accept-observed-identity` is needed on this path: a picker launch expects
   no other conversation.
4. Verify the binding before telling the human that a later
   `tap session resume installer` reopens this conversation:

   ```bash
   jq -r '.seats["installer"].harness_session_id // empty' "$team_root/.tap/team-registry.json"
   ```

   It must equal the id you recorded before exiting. If it is empty or
   different, or you had no id, report adoption as unverified: messaging works,
   but a later TAP resume may open another conversation. Never supply a
   guessed id.

On the automatic path you then launch `partner` yourself, as step 3 says; on
the by-hand path the human launches the other harness as a fresh seat. Either
way this conversation asks it a question, and the fresh seat's actual reply,
shown here, is the round trip. Two adopted conversations do not prove a fresh
launch.

## 4. Check the terminal from inside TAP

Run these checks only from inside a TAP seat: this conversation after the
relaunch, or one of the fresh seats. They read; any fix waits for a yes.

`/tap:help` is the human's command; agents never invoke it. Run
`tap help skill help`, which prints the path of the help skill's `SKILL.md`, and
read `references/diagnose.md` beside it. Follow its tmux section and its
interactive checks: truecolor, mouse wheel scrolling, Shift+Enter, and
select-to-copy. Ask the human to try each interactive check and tell you what
happened.

The one setup change you offer is TAP's managed tmux defaults, unless step 2
already installed them. Show `tap tmux-defaults status --json`; if they are not installed, show the human
`tap tmux-defaults install --dry-run` and install only after a yes. The dry run includes the status bar
only for someone with no tmux config; `--status-bar` or `--no-status-bar` changes that, and the shipped
lines are the source of truth: show what the dry run prints, never a bar copied from elsewhere. Never edit
the human's shell startup files, terminal preferences or own tmux.conf lines,
and do not run `/terminal-setup` for them. When a check still fails, report it
and point to [TAP and tmux](GETTING-STARTED.md#tap-and-tmux), which lists the
Shift+Enter and scrollback options the human may apply themselves.

## 5. Report to the human

Report:

- Install type and path, installed command path, and source commit. For a clone,
  include the installer's ancestry line verbatim; for an archive, include its
  trusted digest, successful bootstrap receipt and matching release marker/doctor result.
- Active config path, permission choices, and the presets and aliases the human
  chose, if any. Name any inactive candidate config separately.
- Whether `tap help`, project initialization and the observed
  round trip passed, and whether this conversation was relaunched inside TAP,
  with its accepted conversation id when the identity step ran.
- Each terminal check's result, any change the human accepted, and any check
  still failing.
- Any refusal or unfinished step, with its exact message.
- The verified sender and recipient seat names, and the next command:
  `tap attach <verified-sender-seat>`, substituting the actual sender’s name.

Point them to the [cheat sheets](CHEATSHEET.md). If verification is
incomplete, say so rather than calling the installation ready.

End by telling the human that the configuration is not final: the configuration
skill repeats this walkthrough and changes any choice. Claude and Codex name it
`tap:config-wizard`; flat hosts name it `tap-config-wizard`. In any agent session,
run `tap help skill config-wizard` and follow the returned file, so the human
never needs to edit the config file by hand.

Finish with this short recap, in plain words, as the last thing you tell the human
after the verified round trip:

1. **Add a seat.** Show exactly one launch form from their actual setup: a selected
   alias, such as `<alias> <name>`, or one installed bare harness command, such as
   `tap launch <harness> <name>`. Never show both.
2. **Put the team to work.** Ask agents on the same team to talk, review or split work.
3. **Retire a teammate.** `tap out <name> --kill` removes the seat and stops its
   session; plain `tap out <name>` leaves the session running. (For crew seats, either
   form affects only the pane.) To replace a seat that keeps its name, launch it again
   and choose kill (`k`) when prompted.
4. **If something looks off,** start `/tap:help` (`tap-help` on flat-skill hosts) and
   describe what you see.

## Human notification setup

After the first observed answer, offer the notifier choice once, unless the
human already supplied it. Keep the system default or record a command they use.
Run `tap doctor` in the enrolled project to inspect the selected notifier. This check sends nothing. The default uses `osascript` on
macOS or `notify-send` on Linux. macOS needs notification permission for the
terminal app; Linux needs a desktop notification service/session. A headless
machine may need an external command.

For an accepted external service, pass its notifier and literal command together
through the shared writer. Preview this JSON with `--dry-run` before applying;
replace `my-notifier` with the chosen executable and flags:

```bash
tap setup --machine --answers - <<'JSON'
{
  "notifications": {
    "notifier": "command",
    "command": ["my-notifier", "--title", "{title}", "--urgency", "{urgency}", "--", "{body}"]
  },
  "write": "apply"
}
JSON
```

Use the chosen tool's flags and executable path. Arguments are literal; there is
no shell evaluation. Whole-token placeholders supply the title, the first-line
question with its seat/session label, and `routine` or `urgent`. Deeper lines of
an escalation body stay local. To return to the default, set
`notifications.notifier` to `system` in an answers patch. A valid saved command
can be retained by omitting `command`. Setup sends no notification. Timeout
changes are advanced settings outside the answers contract; use the configuration
skill's backed-up targeted edit procedure for those.

`TAP_NOTIFY_USER_BIN` is an explicit emergency/test override using the legacy
`notify-user` argument contract. It takes precedence over config; the isolated
test runners pin it to a nonexistent path. Normal setup belongs in the config.
`TAP_NOTIFY_TIMEOUT_SECONDS` overrides the configured deadline.

Ask the human before sending a test alert. Exit 0 means the notifier accepted
the alert, not that the human received or read it. A timeout leaves delivery
unknown; TAP does not retry or switch transports. `tap help escalate` documents
all error classes and repair steps.
