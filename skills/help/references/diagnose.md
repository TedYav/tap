# Something's weird: symptom-led diagnosis

The person describes what looks wrong; you find out why and explain it in plain words. The checks
below change nothing about their setup, their tmux server or their seats. A fix does, so name the
exact command and its effect, and run it only after a yes to that fix.

Capture evidence before anything else: `tap doctor` and `tap whoami` only read. Most other `tap`
commands, `tap team`, `tap outstanding`, `tap peek` and `tap spool` included, may run TAP's routine
bus upkeep, the same upkeep every running seat triggers: it expires parked mail past its deadline
and archives old settled mail. That is ordinary TAP behavior rather than a fix, but it can retire
the parked mail you are diagnosing, so read `tap doctor` first. Their own config wins:
when their tmux.conf or terminal setting differs from TAP's, report the difference and leave it.

Agents never invoke `/tap:help`; it is user-only. TAP's installer flow and any agent helping a
person can still use these checks: `tap help skill help` prints the path of the help SKILL.md, and
this file sits beside it at `references/diagnose.md`. Read it by path.

## Route from the symptom

Start with the row that matches their words, run its checks, and stop when one explains the
symptom. Run the TAP baseline when nothing matches or the first route comes up clean.

| What they say | Checks |
|---|---|
| Messages don't arrive, a seat ignores mail, "who am I" | TAP baseline, then known seat states |
| A seat is stuck, frozen, or shows a dialog | Known seat states |
| Copying text does nothing, or says "copied to tmux buffer" | Clipboard, stale SSH session, then the select-to-copy check |
| Shift+Enter submits instead of adding a line | tmux version, then the Shift+Enter check |
| Colors look washed out or wrong | Truecolor |
| Scrolling scrolls the wrong thing, or history is short | Mouse and history, then the wheel check |
| The harness misses focus changes, or redraws oddly on return | Focus events |
| Something about tmux generally feels off | TAP's tmux defaults |

## TAP baseline

- `tap doctor` — bus integrity, seat health and parked mail. Its `spool` and `stuck_spool`
  findings are messages waiting because a pane could not take them yet. Exit 0 means the bus is
  intact; named seat warnings can still need attention. Explain each finding in one line.
- `tap whoami` — the handle this pane is registered under. No handle means the pane is not on TAP.
- `tap team` — every seat with its state. A seat marked offline or stale here explains silence.
  `tap team doctor` checks whether each active seat's binding matches its live pane.
- `tap outstanding` lists what this seat sent that is still unsettled. Avoid `tap poll` here: it
  quarantines malformed mail it finds, so it is a change, not a look.
- Hooks: TAP binds a pane through the harness's SessionStart hook. A Claude or Codex seat that
  never registered on start, while `tap in` works, points at hooks. Codex asks the person to trust
  hooks once per changed hook set; a declined or pending review leaves that seat unbound. Trust is
  the person's decision; the getting-started guide's hook review section walks through it.

## tmux

- `tmux -V` — the version. tmux older than 3.2 lacks extended keys and some terminal features.
- **TAP's tmux defaults.** Run `tap tmux-defaults status --json`. `"installed": false` means TAP's
  defaults are not installed; offer them through the installer's defaults step, and use the plain
  probes below. Otherwise it lists `options` (what TAP sets on this platform) and `live.values`
  (what the running server shows). A live value that differs is not an error: their own tmux.conf may override it,
  or the server has not restarted since the install. Say that, in those words. `status_bar` says whether TAP's optional status-bar section is in the file; a status bar
  the human did not ask for is theirs to remove with `tap tmux-defaults install --no-status-bar`. A `live.server`
  other than `up` means the running values could not be read, which says nothing about the
  defaults. Any other exit, or output that is not JSON, means the check itself failed; report
  that rather than "not installed". Only when this TAP has no `tmux-defaults` verb at all
  (`tap help tmux-defaults` reports no help for it) use the plain probes.
- Plain probes, one `tmux show -gv <option>` each: `default-terminal`, `terminal-features`,
  `terminal-overrides`, `mouse`, `focus-events`, `history-limit`, `set-clipboard`,
  `update-environment`.
- **Truecolor.** Inside tmux, `echo $TERM` should be `tmux-256color` or `screen-256color`, and
  `tmux info | grep -E 'RGB|Tc'` should show the capability present. Claude Code inside tmux also
  needs `CLAUDE_CODE_TMUX_TRUECOLOR=1` in the seat's environment; check with
  `tmux show-environment -g CLAUDE_CODE_TMUX_TRUECOLOR` and `echo $CLAUDE_CODE_TMUX_TRUECOLOR`.
  The terminal itself must support truecolor too (`echo $COLORTERM` outside tmux shows
  `truecolor` on most that do).
- **Focus events.** `focus-events` should be `on`; Claude Code and Codex use focus reporting.
- **Mouse and history.** `mouse` on lets the wheel and clicks reach panes. `history-limit` at the
  tmux default of 2000 cuts long agent output short; TAP's defaults raise it.
- **Stale SSH session.** `tmux show-environment SSH_CONNECTION` and `echo $SSH_CONNECTION` in an
  affected pane. A value while the person is sitting at this machine is stale: one SSH attach
  copied it into the tmux session, and every pane started since inherits it. Claude Code then
  treats the session as remote and copies into the tmux buffer instead of the system clipboard
  ("copied N chars to tmux buffer"). The fix, with consent: drop `SSH_CONNECTION` from tmux's
  `update-environment` (TAP's defaults do this), clear it from existing sessions with
  `tmux set-environment -t <session> -r SSH_CONNECTION`, then restart the affected seats; a
  running process keeps the environment it started with.
- **Clipboard path.** On macOS, `command -v pbcopy`. `set-clipboard` `off` means tmux copies
  through an explicit command such as pbcopy; `on` means OSC 52, which the terminal must allow
  (in iTerm2: Settings > General > Selection > "Applications in terminal may access clipboard").
  Over SSH, OSC 52 is the path that reaches the person's own clipboard.

## Interactive checks the person performs

Ask them to try one thing and tell you what happened. These cannot be observed from a shell.

- **Shift+Enter.** In the harness's input box, type a word, press Shift+Enter, type another word.
  A new line means it works. If it submitted instead: in Claude Code, `/terminal-setup` installs the
  terminal key mapping where supported; Ctrl+J inserts a newline in most harnesses meanwhile; some
  terminals need a key map that sends Shift+Enter as its own sequence. Under tmux, the terminal's
  mapping is the first fix. tmux's `extended-keys on` is not enough for Claude Code: tmux forwards
  the Shift+Enter sequence only to programs that ask for it, and Claude Code does not ask. The
  tmux route that works is `extended-keys always` with `terminal-features 'xterm*:extkeys'` (tmux
  3.2 or newer). Its cost: every pane then receives those key sequences, and older programs may
  print garbage or misread keys. It is not one of TAP's defaults; offer it as a change to their
  own tmux.conf, with that cost stated, after a yes.
- **Select to copy.** Ask them to drag-select a few words in a harness pane, then paste into
  another app. In Claude Code fullscreen the app owns the mouse and copies itself, so a failure
  there points at the stale SSH session or pbcopy. In a shell pane, tmux copy mode owns the drag,
  so a failure points at `set-clipboard` and the copy binding. Option+drag in iTerm2 bypasses
  both and uses the terminal's own selection.
- **Wheel.** Ask them to scroll up in a shell pane. tmux history scrolling means `mouse` is on. The
  terminal's own scrollback moving instead (showing an earlier screen, not the pane's history)
  means tmux is not receiving the wheel. In a harness running fullscreen, the harness scrolls its
  own transcript; that is expected.

## Known seat states

- **Usage-limit dialog.** A Claude seat stopped on its usage-limit dialog. `tap peek <seat>` shows
  the dialog without touching the pane. `tap nudge <seat>` is the fix, and it can do more than
  close the dialog: it presses Esc on that dialog, then continues down its ladder, so it may also
  press Enter on a TAP message stuck in the input box, or interrupt the seat and send a wake line.
  Run `tap nudge <seat> --dry-run` first, tell the person every step it reports, and run it only
  after a yes to all of them. Any other dialog, approval or sign-in prompt is the person's to
  answer: they attach, answer, and detach with Ctrl-b then d.
- **Seat offline while its crews still run.** `tap team` shows the seat offline but its crew seats
  live: the seat's harness exited, and the crew windows keep its tmux session open. Relaunch it
  through `tap launch` or `tap session`. If the relaunch offers to bring the seat back into that
  session with the crews kept, that is the fix. If it offers resume and then refuses with "not
  live", this TAP cannot revive the seat in place: start the harness in a new window of that
  session with its own resume, and run `tap in` there.
- **Not registered after a native resume.** After `/resume` or a harness restart inside an
  existing pane, `tap whoami` names nothing or the wrong seat. The fix is `tap in` typed in that
  pane; it is safe to repeat. In a seat `tap launch` started, `tap in` may then warn that the observed
  session id `did not match launcher expectation`: the handle is bound, but a later
  `tap session resume` would not reopen the resumed conversation. Only for that warning, and after
  a yes, `tap in <seat> --accept-observed-identity` keeps it; its `accepting observed <id>` line
  must name the conversation the person picked.

## Reporting

End with what you found, in this shape: the cause in one sentence, the evidence that shows it,
and the one fix you recommend with what it changes. When the checks come up clean, say so and ask
for the exact moment the symptom appears; an unexplained symptom is worth a note to the TAP
maintainers with the command output, not a guess.
