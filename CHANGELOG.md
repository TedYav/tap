# Changelog

Release notes are curated when a release is prepared. A protocol bump adds the
next `0.<protocol>.0` release heading in the same change.

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
