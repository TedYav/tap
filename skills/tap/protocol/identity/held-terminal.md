# Held terminal: the caller pane through a harness-held tool terminal (v0.23)

Normative. Owns the one climb the caller-pane observer may take past a
controlling terminal that no pane on the server owns. The walk itself (first
observable controlling TTY, live-pane inventory, targeted record) is owned by
[registry part 9](registry-unit-1-part-09.md#implicit-caller-identity); this
page adds nothing to a caller whose first terminal is a pane.

## Why

Antigravity's `run_command` runs each shell command on a fresh pty while the
`agy` process itself stays on the pane TTY. The caller's first controlling
terminal is therefore a throwaway no pane owns, and the seat is one terminal
boundary up. The harness does not export its conversation id into that
environment, so the session-id arm cannot stand in.

## The climb and its four conditions

When no live pane owns the caller's first controlling terminal, the walk
continues through the run of ancestors on that terminal and admits a pane only
when every condition holds. Each refusal keeps the positive `outside` verdict
with the byte-identical sentence ("observed caller terminal is not owned by a
pane on this tmux server") and reports the refused climb as diagnostics (`climb`
on the observation; `whoami` appends it).

1. **Holder.** The direct parent of the terminal's topmost process is the
   holder, and it carries a different controlling terminal. A parent with no
   controlling terminal (an emulator launched from a tool child), a second
   foreign terminal (an emulator under the tool's own pty), or a chain that
   ends on the terminal refuses.
2. **One live pane.** The holder's terminal maps to exactly one live pane in
   the SAME `list-panes` inventory the walk already read (dead panes excluded,
   one inventory per walk). A terminal two live panes report refuses.
3. **Under `pane_pid`.** The holder is that pane's `pane_pid` or descends
   from it, by the shared fail-closed ancestry walk (`ps -o ppid= -o tty=`
   with the libproc fallback; an unreadable row refuses). A session leader
   that acquired a pane TTY by opening the device is not under `pane_pid`.
4. **A harness holder.** The holder's EXECUTABLE names a harness family:
   its process-table `comm` or `argv[0]` (basename, a `<family>-` prefix or
   a `<family>-` path segment; Claude's version-named native executable is
   not admitted, because its only proof is a file under `$HOME`, which the
   judged process controls, and Claude's tool children carry no terminal
   so the walk never needs this arm for it),
   or, when `argv[0]` is a supported runtime (`node`, `bun`, `deno`,
   `python`), its script entrypoint, which is `argv[1]` and only `argv[1]`
   (Claude Code from npm runs as `node .../claude-code/cli.js`). A runtime
   option may take a separate value, and the parse never guesses which do,
   so an option-led runtime line (`node --require /tmp/claude.js relay.js`)
   admits nothing. No later argv word counts, so `script -q /dev/null
   claude` and `xterm -e codex exec` refuse. The family set is the
   FIXED canonical one (`claude`, `codex`, `opencode`, `cursor`, `hermes`,
   `agy`), never the ambient `TAP_OBS_HARNESS_FAMILIES` override: that
   variable is caller-controlled, and an identity proof may not take its
   admission set from the process it is judging. An emulator launched from
   the pane shell inherits the pane TTY into its own process and passes
   conditions 2 and 3; it is not a harness and refuses here, as do `script`,
   a shell wrapper, a nested multiplexer server, `login` and `sshd`.

The pane then goes through the unchanged targeted record and checks: pane-id
grammar first, the same pane id and TTY as the inventory row, a non-empty
session, a usable server generation, four fields (nine in the extended caller
record). A rate-limited `pane_pid` read is `unverifiable`, never outside: tmux
could not answer, and a seat may well exist. A walk that never saw a terminal
stays `unobservable`.

## What the boundary rule defends

A process that descends from a pane's harness yet lives in another terminal
(an emulator window spawned from the pane, a nested foreground multiplexer, a
`script` session, a login or ssh server, a session leader that opened a pane
TTY by path) may not borrow that pane's seat: it would send as that handle,
settle its mail, and pass the self-clear and shutdown guards. Conditions 1, 3
and 4 refuse each of those shapes.

Consequently a harness started inside the pane harness's own tool terminal
(`agy` running `claude` in `run_command`, or Claude's Bash tool running `codex
exec`) resolves to the pane's seat, exactly as a same-TTY nested harness does
today: the seat is the pane, and the nested harness is one of its tools.

## No environment input

No environment variable takes part in the climb. `TMUX_PANE`, harness session
ids and `TAP_LAUNCH_ID` are inherited by every descendant, so none of them can
tell a relayed tool terminal from an escaped one, and the family set is fixed
(condition 4). Evidence is process ancestry, the server's own pane inventory
and record, and the process table.

## Consumers

Every consumer of the caller-pane observer sees one change for a harness-held
caller: `outside` becomes `inside` with the pane's verified record (`whoami`,
`read`, `reply`, `send`, `withdraw`, `outstanding`, `peek`, `poll`, `resend`,
`attach`, `register`/`tap in`, SessionStart, self and compact, crew spawn,
team shutdown and clear guards). `attach`'s outside arm no longer runs
`attach-session` inside a tool pty; the session-id arm stays as it is for
Claude's desktop-backed tool, whose ancestry ends at launchd on a non-pane TTY.
No refusal class or exit code changes. Verbs that refuse without an observable
caller name their own `--by` spelling and the observed reason.
