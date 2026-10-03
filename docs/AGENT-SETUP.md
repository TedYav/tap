# Set up TAP for a human

You are setting up TAP for a human on this machine. Install a verified release
archive or use a permanent clone, configure the chosen harnesses, and verify an
actual reply before reporting success. Start your agent session outside the clone: its contributor
instructions apply to changing TAP, not this installation. This is the
installation runbook; the [configuration wizard](../skills/config-wizard/SKILL.md)
owns the configuration step below.

TAP is a pre-release beta, not yet a public open-source release, and bugs are expected. Tell the
human so before you start, and tell them to send bug reports and feature requests to ted@tedyav.com.

If a human asked another agent to install TAP for them, that agent starts
outside the TAP clone with this prompt:

```text
Help me install TAP and get Claude Code and Codex talking. Follow
https://github.com/TedYav/tap/blob/main/docs/PUBLIC-AGENT-BOOTSTRAP.md:
clone over HTTPS into a directory I will keep, then follow docs/AGENT-SETUP.md
in that clone. TAP is a pre-release preview. If cloning fails with a permission error, stop and tell me to ask the maintainer for access.
I will handle account sign-in. Preserve my existing config and shell files,
and ask before enabling permission bypass. Finish when one agent shows me the
other's actual reply. Name any startup prompt that needs me.
```

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
  plugins, replace existing config or launch agents on assumed choices.
- Preview before you apply. Every configuration change you make for the human
  is shown to them as a dry run first and applied only after they say yes. The
  terminal wizard is the human answering for themselves: it applies their
  answers when it finishes, after showing any startup-file change and asking
  before it replaces an existing config.

## 1. Choose the install source and check requirements

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

If the human already cloned TAP, use that path. Otherwise clone it. If cloning fails with a permission error, stop and tell the human to ask the maintainer for access:

```bash
git clone https://github.com/TedYav/tap.git ~/tap
```

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
```

Both routes require Git, Bash 5+, jq, tmux and tar. Archives also require gzip and
`shasum` or `sha256sum`; URL installation needs curl. Check those tools with
`command -v` before taking the archive route. Clone installs additionally require
Bun 1.4.0+; check `bun --version` for that route. Python is not required. If a command is missing or
outdated, show the failure and follow the steps below. You run the version checks
and, after asking, the package installs. The human runs every step that needs a
TTY or `sudo` (installing Homebrew, `brew shellenv`, harness sign-in): give them
the exact command to copy and the reason it needs them. After each human step,
re-run the checks, and run `hash -r` (or open a new terminal) so `env bash` finds
Bash 5 rather than the old one it cached. macOS's bundled Bash is too old.

On macOS with Homebrew, the install commands are:

```bash
brew install git bash jq tmux
```

For the clone route, also install Bun:

```bash
brew install oven-sh/bun/bun
```

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
sudo apt install git bash jq tmux tar     # Debian, Ubuntu
sudo dnf install git bash jq tmux tar     # Fedora
sudo pacman -S git bash jq tmux tar       # Arch
```

For the clone route, install Bun from its official installer, which provides
1.4+ where distribution packages lag:

```bash
curl -fsSL https://bun.sh/install | bash  # then hash -r or a new terminal
```

Have the human install and sign in to Claude Code and Codex before the launch
check ([Claude Code setup](https://docs.claude.com/en/docs/claude-code/setup),
[Codex CLI](https://github.com/openai/codex)). Start each CLI directly once to
finish sign-in. TAP does not supply accounts.

## 2. Install and configure

Before installing either source, tell the human which supported harness homes
already exist, as described below. For an archive, run its bootstrap from the
download directory, with the archive path and trusted digest selected in step 1:

```bash
/bin/bash tap-bootstrap.sh --archive "$TAP_ARCHIVE" --sha256 "$TAP_SHA256"
```

For a clone:

```bash
cd "$tap_root"
./install.sh
```

The installer links into the permanent clone or the archive's stable `current`
path. It also wires TAP's hooks and
plugins into every supported harness whose home directory already exists
(`~/.claude`, `~/.codex`, `~/.cursor` with `hooks.json`, `~/.config/opencode`
with `plugins/`, and the Gemini home): a directory that exists but is unused is
still wired, and a missing one is skipped. Tell the human
which of these you found before running it, so nothing is a surprise. A first interactive install
without a machine config opens `tap setup --machine`. A non-TTY agent runner
skips the wizard and prints a next step; the wizard itself requires a TTY.
Use `tap setup --machine --answers <file>` from a non-TTY runner. Do not pipe
default answers into the wizard or treat the skipped wizard as an error.

If the terminal wizard opens, relay each prompt and wait for the human's
answer; it asks the same questions as the walkthrough below. Preset selection
defaults to **skip**. Claude, Codex, Cursor and Antigravity keep their existing
permission choice; a new choice defaults to **auto**. Selecting bypass for a new config requires an
explicit answer. Fresh Codex configs keep Ponytail off until requested.

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
knob and the answers format; this runbook only fixes the order. Ask one
question at a time and retain choices already accepted in the terminal wizard:

1. **Find the harnesses.** Check for the six supported executables and tell the
   human which you found: `claude`, `codex`, `cursor-agent`, `agy`
   (Antigravity), `opencode` and `hermes`. Anything else is unsupported today;
   invite them to request it at <https://github.com/TedYav/tap/issues>.
2. **Ask how they want to launch.** Presets for the common models of each
   harness they use, one preset to try the idea, or bare harnesses with
   configuration later. All three are fine first choices; bare is the shortest
   route to a first reply. OpenCode has no common-model preset: ask which
   models they like.
3. **Ask about effort**, if they chose Claude or Codex presets: the vendor's
   default effort, or a pinned level. The presets arrive with basic calibration
   and role notes they can edit later.
4. **Ask each permission choice.** Ask once before enabling bypass unless
   already authorized. Codex auto keeps Codex's file sandbox and its automatic
   approval review, not a human approval dialog, and TAP turns on Codex's
   network proxy with no allowed domains so seats can reach the tmux socket
   (other destinations stay blocked for commands the sandbox runs). Relay review refusals exactly.
   Cursor and Antigravity take the same auto/bypass choice; Antigravity auto
   stops the seat on every permission request, which the wizard explains.
5. **Ask the two new-user questions:** whether TAP asks before setting up a team
   in a new project, and whether arriving messages interrupt a draft or wait.
6. **Offer shell aliases last**, when they chose presets: typing `opus`,
   `fable`, `sol` or `astra` instead of `tap launch opus`. Detect their shell
   first. The writer supports Bash and Zsh.
7. **Preview, then apply.** Put every answer in one answers object, run it with
   `--dry-run`, and show the human the output, including the startup file and
   each alias line it would add. Apply the identical object only after a yes.

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

Check the installed link with `ls -l ~/.local/bin/tap` (substitute the printed
bin directory). It must point into the installation selected in step 1.

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

Ask which project to use. Follow [the first-team walkthrough](GETTING-STARTED.md):
the human runs `tap init`, then `tap launch claude` and `tap launch codex`,
and asks one agent to talk to the other. Launch opens each seat from a
foreground terminal; detach with **Ctrl-b**, then **d** between launches. Success is the other pane's
actual answer shown in the asking pane; a roster entry, queued receipt or
sentinel is not. The walkthrough owns enrollment. Use fresh, agreed seat names if conversations
already exist; never replace one.

Have the human finish any sign-in, trust or permission prompt in the pane that
shows it; `tap attach <seat>` visits a seat by its roster name. For Codex's
**Hooks need review** screen, use the [hook-review handoff](GETTING-STARTED.md#when-codex-asks-to-review-hooks):
the human reviews the expected TAP commands and trusts only the hooks they
intend to trust; TAP never pre-trusts hooks and must not choose trust for the
human. Inspect the receiving pane before resending if no answer returns. Leave
the seats available unless the human asks to stop them.

For configuration questions, use `tap config path` and
`tap config get sentinel.preview`. Change a preference only when requested:
`tap config set sentinel.preview true` (or `false`) takes effect on the next
delivery. Enabled previews derive from the first non-empty body line, bounded
by `preview_chars` (default 120 UTF-8 bytes); `--preview` overrides that text.
Previews never replace reading the payload.

## 4. Report to the human

Report:

- Install type and path, installed command path, and source commit. For a clone,
  include the installer's ancestry line verbatim; for an archive, include its
  trusted digest, successful bootstrap receipt and matching release marker/doctor result.
- Active config path, permission choices, and the presets and aliases the human
  chose, if any. Name any inactive candidate config separately.
- Whether `tap help`, project initialization and the observed
  round trip passed.
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
