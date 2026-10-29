# Changelog

Release notes are curated when a release is prepared. A protocol bump adds the
next `0.<protocol>.0` release heading in the same change.

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
