# Changelog

Release notes are curated when a release is prepared. A protocol bump adds the
next `0.<protocol>.0` release heading in the same change.

## 0.23.4 — 2026-11-17

### Added

- `tap team` shows the model and effort an OpenCode seat is actually using. TAP
  reads the provider, model and variant from the seat's latest completed
  response, the same record its context figure comes from, and
  `tap team --json` carries them as `observed_model` and `observed_effort`.
  The value follows the last finished response, so a change made in the
  OpenCode UI appears after the next reply. If the response omits a variant,
  `observed_effort` is null; a seat with no completed response still shows its
  launch settings.
- `/tap:lead` gains six working habits, adapted from the MIT-licensed pstack
  skill library: write a throughput check before fanning out, prefer a
  fresh seat for a newly delegated unit and carry its consolidated scope, own
  what a delegate produces, judge progress by its side effects rather than reports of it,
  give each verdict one of three values (verified, not verified or
  inconclusive), and classify a question before asking the person.

### Changed

- The `tap team` model column no longer marks a launch-setting fallback with
  `(launch)`. The column shows the observed model and effort when TAP has
  them and the launch settings otherwise; `tap team --json` still keeps the
  two apart (`observed_model` and `observed_effort` beside `model` and
  `effort`).
- The shipped Codex presets select GPT-6.2: all six Astra presets use
  `gpt-6.2-astra` and all four Sol presets use `gpt-6.2-sol`, including the
  two simple-setup starters. Their descriptions, the setup examples and the
  cheatsheet follow. A config you already have keeps the models it names.
- Gemini Carbon and Kimi K3.1 Pro show short names in the model column
  (`carbon4`, `kimi3.1pro`). An effort written into a Carbon model id, such as
  `gemini-4-carbon-high`, shows as the effort (`carbon4@high`).

## 0.23.3 — 2026-11-15

### Added

- `tap team` can show what a blocked Claude seat is waiting on. A Claude Code
  `PermissionRequest` hook records the tool and a short summary of an open
  approval or question, and `tap team --json` carries it as
  `permission_request`. The hook only observes: it never answers a prompt,
  stores no command line or file body, and does nothing outside a registered
  seat. The installer adds it for Claude Code 2.0.45 or newer and removes it
  when the version reads older; `./install.sh --report` says which applies.
- `injection.feedback_card` decides what delivery does when Claude's
  feedback-draft card hides the composer. `dismiss` (the default) sends one
  Escape and then reads the composer as usual; the draft stays queued in
  `/feedback`. `hold` sends no key and tells the sender the message is held.
- Bash completion: `source <(tap completion bash)`. It is generated from the
  same source as the zsh completion.
- `tap init --dry-run` previews every file it would write, and
  `--no-instructions` skips the project instruction edits. `tap init` now asks
  before it touches an existing instructions file or `.gitignore`, and prints a
  receipt of what it wrote.
- `./install.sh --report` previews everything an install would change, not
  only the harness wiring. The installer's closing message and `--help` say how
  to remove TAP.
- On Claude Code, `tap self compact`, `rebrief` and `clear` accept
  `--model NAME@LEVEL` (for example `opus@high`) as a short form of
  `--model NAME --effort LEVEL`.
- SECURITY.md lists what TAP stores on your machine and how to delete it, and
  the README has a Stability section and an install command on its first
  screen.

### Changed

- TAP-started Codex seats start with Codex's startup update check off by
  default, which avoids its "update available" menu. The launch can report a
  newer version from Codex's own cache. An explicit launch setting is kept,
  and your Codex configuration file is not changed.
- Mail to a Claude seat that shows the feedback-draft card is delivered when
  the composer is in view below the card. Before, the card held the seat until
  someone dismissed it.
- `tap <command> --help` and `-h` are answered before any effect: they write
  no journal entry and reach no bus. A positional `help` after `send` is a
  recipient, so use `tap send --help` or `tap help send`.
- Launches keep the login shell's tool selection first and add the caller's
  `PATH` after it as a fallback, without duplicates, so nested launches no
  longer grow `PATH`.
- `tap crew add` types a short reference into the new pane instead of the
  whole launch command. A long `PATH` could push that line past the terminal's
  input limit and the seat would not start.
- Text after `/tap:self compact` or `rebrief` is an instruction for the seat
  after the reset. The seat writes it into the handoff and does none of it
  before the reset; a resume model named in words is passed as `--model`.
- `tap launch gemini`, `antigravity` and `cursor-agent` refuse with the name of
  the harness to use instead.
- `tap in` at a shell prompt, `tap doctor` and a sender now say that a shell
  pane cannot receive messages and what to do next.
- `tap tmux-defaults install` lists every effect before it acts, and a config
  it cannot merge safely is left for you to reload by hand.
- Installer refusals name the cause and one fix for your machine. The Bash
  check tests the shell that is running the installer, and a tmux version it
  cannot read is reported as unknown, not as too old. It also warns when
  another program named `tap` comes first on `PATH`.
- `bin/tap` also looks for Bun in `$BUN_INSTALL/bin` and `~/.bun/bin`, and its
  install hint matches your platform.
- `tap --version` and `tap poll` start far fewer processes.
- Debug recording no longer starts on read-only commands, help or a dry run.
- Reading another team's roster by name no longer writes cache files into that
  team's project.
- Agent-facing help for a first exchange with a teammate is clearer, and
  `tap help advisory` no longer calls message content authorized work.
- The docs no longer promise things the code refuses, and the landing page
  says what TAP is and shows the install command in its first view.
- For contributors: the public repository's CI runs Bun tests on Linux, pins
  its actions by commit, and has issue and pull request templates. The Bun test
  runner uses one per-test timeout on every platform and the same terminal,
  locale and time zone as the release checks. The Pages workflow builds and
  deploys in separate jobs. An unused second delivery path was removed.

### Fixed

- A project you cloned could run its own code through TAP: Bun loaded that
  project's `bunfig.toml` preload scripts and `.env` when `tap`, a TAP hook or
  the installer ran in its directory. TAP now starts Bun with its own
  configuration and no environment file everywhere, including the processes it
  starts for itself and the compiled release build.
- `tap init` refuses TAP state that came with a checkout. A committed `.tap/`
  registry or bus could otherwise appear as a teammate's seats and mail.
- Composer text is no longer treated as a TAP message merely because it ends
  in `]]`, so a shell test or similar draft is not submitted with an arriving
  message. A scrolled message tail must match a message TAP recorded typing;
  that record lasts for the recovery hold window, 30 minutes by default.
- On Hermes, a truncated TAP message behind the `/queue` prefix is no longer
  cleared as a human draft during redelivery.
- A fresh Antigravity seat received mail late because its composer hint
  (`Auto mode: …`) was read as a draft. The hint is now recognized by how it is
  painted.
- With Bun missing from `PATH`, TAP's shell-command hook failed every shell
  command an agent ran. Hooks now step aside with one line naming TAP and
  survive a checkout that cannot load. The session-start hook's registration
  and Git-root probes have time limits.
- Redelivery checks a queued message's header before typing anything and
  refuses a malformed one.
- A launch prints the right window target when tmux `base-index` is not 0.
- Seat identity probes have timeouts.
- `./install.sh --report` no longer writes a Bun cache under your home
  directory.
- Linux: the tmux status tick, `tap doctor`'s server scan and the `tap draft`
  clipboard copy work.

## 0.23.2 — 2026-11-07

### Added

- `tap team history` lists a team's current and departed seats. `tap restore
  <handle>@N` (a bare handle restores its sole departure, or opens a terminal
  picker when there are several) returns a departed seat as a suspended row that keeps its conversation, ready for
  `tap session resume`. A live handle refuses and suggests `--as`.
- Every seat list accepts `--harness`, `--model` and `--state` filters
  (`tap team`, `tap teams`, `tap crew list`, `tap session list`, `tap admin ps`
  and the other roster views). `--state active` hides seats idle for ten minutes
  or more. `--active` is now `--online`; the old spelling still works and prints a
  one-line notice. Model columns show readable names such as `opus5.5@xhigh`.
- `tap teams --recent` and `tap team --recent` order teams and seats by last
  activity, with a LAST ACTIVE column. `-n <count>` keeps the first rows, like
  `head -n`. Filtered rosters list crews only when you ask for them.
- `tap team refresh --stale` lists offline seats unused for at least seven days
  and retires them after you confirm, so each can come back with `tap restore`.
  `--stale=14d` changes the age; `--include-idle` also includes long-idle seats
  that are still running. `--dry-run` only lists. Retiring without a terminal
  requires `--yes`.
- `tap out` opens a picker on a terminal when `--last` ties between seats or a
  name has no exact match but fuzzy-matches a seat, instead of refusing or doing nothing. Scripts and
  `--json` keep the previous behavior.
- `tap session relaunch` takes `--context <size>` (such as `850k` or `1M`) to set
  a seat's context window and `--ponytail <off|lite|full|ultra>`, in place of
  hand-written per-harness settings. It applies to Claude and Codex seats.
- `tap session relaunch --auto-nudge` sends a continuation prompt only to seats
  observed working, or stopped by a confirmed usage or rate limit, before the
  relaunch. Other selected seats still relaunch but receive no prompt.
- `tap role <seat> leader` marks a team leader. Leaders sort first in `tap team`
  and `tap attach`, and `tap team --json` carries the role. A role is a label,
  not a permission.
- `tap debug` can record on its own: set `always_on = true` under `[debug]` in
  `config.toml` and the next eligible `tap` command starts a recorder when none is live. Rotated
  and pruned history is now compressed into `~/.tap/debug/archive/` rather than
  deleted (cap with `tap debug config --archive-mb`). Tmux flight capture is an
  independent debug source that keeps working when Bun is unavailable.
- Roster commands accept `--no-state` to skip activity sampling when you only
  need who is registered.
- `tap draft` with no arguments copies and prints the newest team draft backup;
  `tap draft list` shows a short picker (`-n` sets the count).

### Changed

- TAP messages are presented as a colleague's request rather than something to
  refuse. A recipient can disagree openly, goes with the team leader's call, and
  escalates when stuck. The spoof guard stays.
- Harness-wide recovery (`tap nudge` and related commands) targets seats in
  error or blocked states by default and leaves healthy idle seats alone.
- TAP no longer rewrites a human's stop request into an order. Interruption
  notices say what happened and what to do next.
- Launches wait up to 60 seconds for a slow login shell to start the harness
  (`TAP_LAUNCH_START_TIMEOUT_SECONDS` changes it) instead of rolling back after
  5 seconds on a loaded machine.
- Several commands start faster and read less history: verbs load only the code
  they need, roster and archive reads are batched and cached, and
  `tap outstanding` reads only recent answers.
- The public installation guide now matches the beta release, and bugs are
  reported through GitHub Issues. Setup docs state the Linux prerequisites
  (tmux, `lsof`, Bun) and which platforms and tmux versions have been tested.

### Fixed

- TAP panes now start in `$HOME` and enter their working directory themselves, so
  a failed spawn can no longer leave the tmux server in a deleted worktree where
  every later launch fails. Seat sessions still use their worktree as tmux's
  default directory, so a new window or split opens there.
- On Linux, seats bind to their sessions again; the `lsof` request omitted the
  working-directory field that Linux does not volunteer. `lsof` is now a
  requirement and `install.sh` says how to install it.
- A Claude or Codex seat that is signed out, or sitting at a first-run menu, now
  reads `blocked` with reason `sign_in`: delivery holds, no key is sent, and
  `tap doctor <seat>` asks you to attach and sign in.
- A failed resume keeps its conversation on the next launch prompt, which no
  longer offers to start fresh over it.
- The name prompt stays open on Option-Delete and Command-Delete; they delete a
  word or clear the line.
- Archive checks use less memory when settling seats.
- Under launchd, the tmux flight recorder keeps tab separators in its output.
- When a launch started from a tool shell fails, the failed pane's output is
  kept so you can read why. The tmux reload command that `tap` prints now runs
  when its path contains spaces.

## 0.23.1 — 2026-10-28

### Added

- `tap doctor <handle>` diagnoses one teammate's health. It reports a verdict
  (healthy, thinking, parked on a dialog, severed, gone, or unknown) with the
  evidence behind it and what it did not check.
- `tap unwedge <handle>` recovers a seat whose turn stopped on an API error or a
  model-capacity error. Run bare (`--rung report`), it only diagnoses and
  previews eligibility. `--rung message|nudge|continue|restart` takes one
  explicit step per invocation (a note, a nudge, a continue, or a restart on the
  exact saved conversation). Acting rungs apply only to a stopped Claude API error or a
  Codex model-capacity error. It never climbs the ladder on its own and does not
  claim the work resumed.
- `tap operate <handle> --preset <name>` and the `tap:harness-operator` skill
  return a seat stuck on an abandoned Claude, Codex, or OpenCode menu to its
  composer. It is off by default: set `recovery.operator` to `ask` (a human
  approves each run) or `on` to enable it.
- Type `STOP` alone in a composer while mail is pending to hold all incoming mail
  for that pane, so you can open side views such as `/btw` without interruption.
  Wait for the blue flash and the expiry notice before switching views. Type
  `START` alone to release it. A hold expires after ten minutes.
- `tap crew add ... --assign <brief-file> [--reply-to <seat>]` creates a crew,
  checks its identity and model, and sends its first brief in one command.
- `tap crew resume <crew>` restores a crew on its saved conversation after it
  stops or tmux restarts. `tap crew resume --owner <handle>` restores all of an
  owner's crews. `tap crew relaunch <crew> --resume` replaces a running crew on
  the saved conversation.

### Changed

- `tap ask` now keeps its native conversation. When the harness reports it,
  `tap ask` prints a `tap crew add ... --resume` command that continues the
  answer as a crew seat. Pass `--ephemeral` to opt out on Claude and Codex.
- Crews you start now survive when their parent seat exits or relaunches, and
  keep their row and conversation after their pane stops. Stopped crews stay in `tap crew list`.
  `tap crew shutdown` can now stop a crew's last window.

### Fixed

- Codex startup and delivery no longer stall on the "update available" menu: TAP
  skips it once and continues when the composer is empty.
- Crews can be created again from an unenrolled linked worktree and after a tmux
  restart. A crew can shut down without waiting for others to read its outbound
  notes and replies; unanswered asks still block.
- A headless helper started inside a seat no longer rebinds its parent's session
  or receives its mail.

## 0.23.0 — 2026-10-23

### Added

- Numbered releases with a changelog, version tags, and GitHub release notes.
  Run `tap --version` when reporting a problem; development builds include
  their commit information.
- `tap team doctor` explains blocked and error states with suggested next steps.
- `tap session relaunch --nudge` requests continuation for non-idle seats after
  relaunch. Use `--nudge=<text>` to add short context. Idle seats, fresh crew
  sessions, and Hermes skip the continuation prompt.
- `tap self compact` and `tap self rebrief` accept `--model` and `--effort` on
  Claude Code, switching after the reset and before the resume note. If a switch
  cannot be verified, the note still arrives with a warning. Claude Code saves
  these choices as defaults for new sessions too.

### Changed

- Human-readable `tap teams` lists sort alphabetically. `tap teams --seats`
  separates teams and labels active and total seat counts more clearly.
- Refreshed newcomer guides and the website with current commands, skill names,
  and guidance on optional coordination features.

### Fixed

- Usable error prompts are distinguished from blocked dialogs, so messages can
  reach a composer that remains available.
