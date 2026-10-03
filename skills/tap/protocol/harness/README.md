# Harness drivers and appendices

Normative TAP v0.23 protocol pages. Open only the page needed for the current question.

- [Appendix: the `ccnative` native driver (tap-lcdm — EXPERIMENTAL, default-off) — source part 1 of 2](./appendix-the-ccnative-native-driver-tap-lcdm-experimental-default-off-part-01.md) — source bytes 889754–898317
- [Appendix: the `ccnative` native driver (tap-lcdm — EXPERIMENTAL, default-off) — source part 2 of 2](./appendix-the-ccnative-native-driver-tap-lcdm-experimental-default-off-part-02.md) — source bytes 898317–900325
- [Appendix: the `agy` native driver and the `agy-ls` descriptor (tap-ssie — default-off) — source part 1 of 3](./appendix-the-agy-native-driver-and-the-agy-ls-descriptor-tap-ssie-defaul-part-01.md) — source bytes 900325–909044
- [Appendix: the `agy` native driver and the `agy-ls` descriptor (tap-ssie — default-off) — source part 2 of 3](./appendix-the-agy-native-driver-and-the-agy-ls-descriptor-tap-ssie-defaul-part-02.md) — source bytes 909044–917878
- [Appendix: the `agy` native driver and the `agy-ls` descriptor (tap-ssie — default-off) — source part 3 of 3](./appendix-the-agy-native-driver-and-the-agy-ls-descriptor-tap-ssie-defaul-part-03.md) — source bytes 917878–919665

## Claude agent view: prevention and recovery

Claude Code's agent view (left arrow on an empty prompt, or `/bg`) moves a
session into a background worker. The pane's `claude` stops running the turn,
pane-bound verbs refuse, and the roster goes stale.

**Prevention.** The launcher gives every Claude seat
`CLAUDE_CODE_DISABLE_AGENT_VIEW=1` (`applyLaunchEnv` in
`runtime/bun/src/launcher/plan.ts`, the claude-defaults tier). Any value the
launching shell, `[harness.claude.env]` policy or the seat's own env declares
wins; non-Claude harnesses never receive it. TAP does not set
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` and does not write Claude user settings.

Behavior evidence is a one-off probe, not a suite test: Claude Code 2.1.288 with
the variable set completed a background Bash command (`BG_OK`) and a background
general-purpose subagent (`SUBAGENT_OK`), while left-arrow agent view and `/bg`
were unavailable. The probe ran with real `~/.claude` auth, so it is not
reproducible in an isolated suite. The launcher tests pin the environment the
child receives; they do not prove Claude's runtime behavior.

**Recovery for a seat already moved.** After the move the pane shows agent
view with no shell prompt, and Ctrl+C twice closes the pane. Run these from
another shell, or ask the backgrounded agent to print the values. Prepare the
whole relaunch command before stopping anything; if any part is unknown, stop
here and ask the seat's operator, because `claude stop` ends the worker.

1. Identify the target pane and session. Bare `tap whoami` is caller-local: from
   another shell it names that shell's own seat, so never take the pane from it.
   Read the target handle's `pane` from `tap team roster <team> --json`, then
   confirm it is the stranded seat before anything destructive:
   `tmux display-message -p -t <pane> '#{pane_id} #{pane_current_command}'`
   should show that seat's `claude`; its `pane_id` is `<pane-id>` below. The new session id is
   `$CLAUDE_CODE_SESSION_ID` in the backgrounded agent's shell; its first 8
   characters are the short id.
2. Recover the launch recipe, not just its display text:
   - Working directory: the seat's own, which in a linked worktree is not the
     team root. `tmux display-message -p -t <pane-id> '#{pane_current_path}'`.
   - Arguments: `ps -o command= -p "$(tmux display-message -p -t <pane-id> '#{pane_pid}')"`
     is a diagnostic cross-check. It flattens quoting, so a multiword argument
     loses its boundary; rebuild the argv from the seat's launch settings and
     quote it for the shell.
   - Environment: every variable the launch set, such as a custom
     `CLAUDE_CONFIG_DIR` (a missing one can hide the saved conversation),
     `[harness.claude.env]` policy and the seat's own env. Pass each with
     `tmux respawn-pane -e 'NAME=value'`, and keep
     `CLAUDE_CODE_DISABLE_AGENT_VIEW=1` so the seat cannot repeat the move.
   - Shell-quote the working directory, every `-e` assignment and the whole
     command string: a path or value with spaces or metacharacters is split or
     expanded by your shell before tmux sees it, after the old pane is gone.
3. Remove every old session selector from the arguments: `--session-id`,
   `--resume`/`-r` with its operand, `--continue`/`-c` and `--fork-session`.
   A fork launch carries `--resume <source> --fork-session --session-id <new>`,
   and leaving `--fork-session` would mint another id instead of resuming. Keep
   unrelated tuning, permission and name arguments, and add exactly one
   `--resume <new-session-id>`.
4. Settle background work first. Background shell commands, subagents and
   workflows the session started carry over to its next process and keep
   running, so one still editing or testing the checkout can race the resumed
   seat. Ask the backgrounded agent to list them and let them finish or stop
   them before you continue. Only running monitors, and shell commands a
   subagent started, end with the process.
5. Stop the worker under the seat's own config directory; never let your
   shell choose it. A custom `CLAUDE_CONFIG_DIR` runs a separate supervisor with
   its own sessions, and your shell may export a different one. Pin the
   target's namespace explicitly, for stop, listing and relaunch alike:
   - Custom: `CLAUDE_CONFIG_DIR='<seat-config-dir>'` on each command.
   - Default `~/.claude`: `env -u CLAUDE_CONFIG_DIR` on each command, so an
     exported variable in your shell cannot redirect it.

   `<pin> claude stop <short-id>`, then list including stopped sessions,
   `<pin> claude agents --json --all`, select the exact session and confirm it
   is stopped. The default listing shows active sessions only, so absence from
   it proves nothing. A worker still live plus a relaunched seat is two writers
   on one conversation; do not respawn until the stopped state is confirmed.
6. Relaunch in the same pane:
   `tmux respawn-pane -k -t <pane-id> -c '<seat-working-dir>' -e 'CLAUDE_CODE_DISABLE_AGENT_VIEW=1' [-e 'NAME=value' ...] '<claude command>'`
   where `<claude command>` is `<pin> claude <seat arguments> --resume <new-session-id>`
   with each argument shell-quoted inside the string. For a default-config seat
   the pin is `env -u CLAUDE_CONFIG_DIR`, because the tmux server's own
   environment may carry another value; for a custom one it is the
   `-e 'CLAUDE_CONFIG_DIR=...'` assignment already listed in step 2.

Relaunch only in the seat's registered pane. SessionStart there arrives as a
matched update: TAP accepts the changed session id and the row heals with no
further step. That is the tested path. A relaunch in a different live pane is
quarantined as an unattested identity change, and no single flag clears it.

Do not recover with `tap team up --only <handle>` yet: it resumes the registered
pre-move session id and drops every turn after the move.
