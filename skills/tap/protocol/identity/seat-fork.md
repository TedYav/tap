# Seat fork (`tap session fork`) (v0.23)

`tap session fork <seat> [<new-name>] [--dry-run] [--json]` starts a NEW seat on the
source's team, in its own tmux session, carrying the source seat's conversation
through the harness's native fork. It is the one-command form of "launch an empty
seat, `/resume` the source conversation, then `/fork` it".

## Source

- The source is a seat on the caller's team: a bare handle, or `<team>/<handle>`
  naming that same team. Another team refuses `fork_other_team`.
- The source is read only. The fork sends no keystroke to its pane, never writes
  its registry row and never stops its process.
- The source needs an exact native conversation id — the id `tap session relaunch`
  would resume. Without one, fork refuses `no_exact_resume_identity` (exit 2)
  rather than start a different conversation. A Claude id counts only when its
  transcript exists.
- Only claude and codex have a supported CLI fork. OpenCode 2 has no TUI
  fork flag and refuses `fork_unsupported` (tap-ki7uw); start a fresh seat.
  cursor and agy refuse
  `fork_unsupported` before any effect, naming the in-session `/fork`; hermes
  refuses the same way.

## The fork

| Harness | Native argv |
|---|---|
| claude | `claude --resume <source-id> --fork-session --session-id <minted-id>` |
| codex | `codex fork <source-id>` |

- The fork inherits the source's recipe as launch and resume persist it: preset,
  model, harness passthrough, env overrides and unsets, harness tail, launch
  tuning, permissions, working root and launch workdir. It never takes the
  source's conversation-id history; a `[k]` replacement keeps the displaced
  seat's history, as launch does.
- Before any effect, a missing tmux or harness CLI refuses `missing_prerequisite`
  as launch does, and the source row is re-read after the chooser: a source whose
  harness, id, session or instance changed refuses `fork_source_changed`.
- It registers under its own handle with its own native id. The launch
  transaction reserves it as kind `new` with capture mode `launcher_new`: Claude's
  minted id is the expected id, and codex reports the id their fork
  created. The source id is carried only as `fork_source_session_id` on the
  in-memory record and is never stored on a row, so the fork cannot claim or
  quarantine the source's identity (`duplicate_identity_owner`).

## Naming and collisions

- `<new-name>` defaults to `<seat>-fork` and must be a handle token
  (`[A-Za-z0-9][A-Za-z0-9._-]*`). A name that is the source's handle, or whose
  session is the source's session (a crew seat shares its lead's), refuses
  `fork_target_is_source`: launch's `[k]` would stop the source. The chooser's
  answer is re-checked against the source's session before any effect.
- A taken name reaches launch's collision chooser on a terminal: `[n]` another
  name, `[f]` fork that seat instead, `[k]` kill and replace that other seat,
  `[r]` resume that seat instead of forking. Without a terminal, or under `--json`, it refuses `fork_name_taken`
  (exit 2) with a fork-shaped recovery. `tap launch ... --json` never opens the chooser,
  even on a terminal: a collision refuses `session_exists` (or `session_record_exists`
  for a retained row) as the one JSON object on stdout, with nothing on stderr.

- Launch's collision chooser lists `[f]` in every menu. A roster seat on a
  forkable harness with a saved-chat reference and no stored conversation-selecting
  flag offers `[f]` immediately. Its native conversation is validated after the
  keypress, before asking for a name; a missing chat refuses without launching.
  Known row-only refusals are greyed with the reason (not a TAP seat, harness cannot fork,
  uses `<flag>`, no saved chat to fork; each at most 21 characters so the row
  fits 50 columns), or
  shows `(unavailable: <reason>)` without colour, and pressing it re-shows the
  menu. Enabled, it asks for the name and runs `tap session fork <seat> <name>`,
  so this page's refusals still apply. The menu's source (row identity and
  resolved conversation) is fixed before the name prompt; a source that differs
  when the fork plans refuses `fork_source_changed` rather than forking another
  conversation.
- The chooser's `[n]` and `[f]` ask for the name. The default is `<seat>-` plus
  a grey suffix: the next free number for `[n]`, `fork` for `[f]`. Enter
  accepts it, typing replaces the suffix, and Backspace edits into the prefix.
  An invalid, numeric, reserved, harness-named or taken name re-asks with the
  reason. Esc quits with nothing changed, as does Ctrl-Z: the prompt restores the
  terminal and cancels rather than suspend with echo off; Ctrl-C interrupts. Without colour (NO_COLOR,
  TERM=dumb, no TERM) the prompt is a plain cooked line with the default in
  brackets: Enter alone takes the default, anything typed is the complete name,
  and Ctrl-C, Ctrl-Z or Ctrl-D quits (a line containing Esc quits once Enter is pressed).
  `--new` and automatic suffixing never ask. A name that is not exactly the
  seat's numbered sibling launches as a seat of its own.

## Output

- `--dry-run` resolves the source, identity, name and recipe and prints the
  transaction's preview; `--json` prints the plan with the composed argv. No
  reservation, tmux or registry effect occurs.
- A real fork prints a receipt naming source, fork and session, then attaches as
  launch does. `--json` prints one object
  `{ok, source, handle, session, harness, fork_of, harness_session_id}` (the id
  read from the bound row, so codex reports their fork's id) and does
  not attach. Refusals use the structured error line; exit 2 for refusals.
