#!/usr/bin/env bash
# tap-gjwtw: the installer wires a harness home only when its command is on PATH
# or its hooks file already exists. A bare home directory is reported and left
# untouched; installing the harness later and rerunning the installer (which is
# what --sync re-execs) wires it. --report states the same answer read-only.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK:?}"' EXIT
fail() { echo "install-harness-wiring: $*" >&2; exit 1; }

# A PATH that carries every tool the installer needs but none of the harness
# commands, whatever the developer machine has installed.
mkdir -p "$WORK/path" "$WORK/stub" "$WORK/bin"
for d in /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do
  [ -d "$d" ] || continue
  for f in "$d"/*; do
    n="${f##*/}"
    case "$n" in claude|codex|cursor-agent|agy|opencode|hermes) continue ;; esac
    [ -e "$WORK/path/$n" ] || ln -s "$f" "$WORK/path/$n" 2>/dev/null || true
  done
done
BUN="${TAP_SMOKE_BUN:-$(command -v bun 2>/dev/null || true)}"
[ -n "$BUN" ] && [ -x "$BUN" ] || fail "Bun executable unavailable"
ln -sf "$BUN" "$WORK/path/bun"

CLAUDE_HOME="$WORK/claude"; CODEX_HOME="$WORK/codex"; CURSOR_HOME="$WORK/cursor"
OPENCODE_HOME="$WORK/opencode"; GEMINI_HOME="$WORK/gemini"
HERMES_HOME="$WORK/hermes"; CURSOR_AGENT_HOME="$WORK/cursor-agent"
mkdir -p "$CLAUDE_HOME" "$CODEX_HOME" "$CURSOR_HOME" "$OPENCODE_HOME" "$GEMINI_HOME" "$HERMES_HOME" "$CURSOR_AGENT_HOME"

run_install() { # run_install <out-file> [install.sh args...]
  local out="$1"; shift
  PATH="$WORK/bin:$WORK/stub:$WORK/path" TAP_INSTALL_BIN="$WORK/bin" \
  TAP_CLAUDE_HOME="$CLAUDE_HOME" TAP_CODEX_HOME="$CODEX_HOME" TAP_HERMES_HOME="$HERMES_HOME" \
  TAP_CURSOR_HOME="$CURSOR_HOME" TAP_OPENCODE_HOME="$OPENCODE_HOME" TAP_GEMINI_HOME="$GEMINI_HOME" \
  TAP_CURSOR_AGENT_HOME="$CURSOR_AGENT_HOME" TAP_AGENTS_HOME="$WORK/agents" TAP_INDEX_HOME="$WORK/index" \
  TAP_INSTALL_HOOK="${HOOK:-1}" \
    bash "$ROOT/install.sh" "$@" >"$out" 2>&1 || { cat "$out" >&2; fail "install.sh $* exited nonzero"; }
}
# Everything under the homes, symlinks and directories included, not just regular files.
files_in() { find "$@" -mindepth 1 2>/dev/null | LC_ALL=C sort; }
want_line() { # want_line <file> <fixed text>
  grep -qF -- "$2" "$1" || { cat "$1" >&2; fail "missing report line: $2"; }
}

# 1. Bare homes, no commands, no hooks files: reported, nothing written.
run_install "$WORK/report1.out" --report
want_line "$WORK/report1.out" "Claude: present, not wired: claude not installed"
want_line "$WORK/report1.out" "Codex: present, not wired: codex not installed"
want_line "$WORK/report1.out" "Cursor hooks: present, not wired: cursor-agent not installed; install it, then run ./install.sh --sync"
want_line "$WORK/report1.out" "OpenCode: present, not wired: opencode not installed"
want_line "$WORK/report1.out" "Antigravity: present, not wired: agy not installed"
want_line "$WORK/report1.out" "Hermes: present, not wired: hermes not installed"
[ -z "$(files_in "$CLAUDE_HOME" "$CODEX_HOME" "$CURSOR_HOME" "$OPENCODE_HOME" "$GEMINI_HOME" "$HERMES_HOME" "$CURSOR_AGENT_HOME")" ] \
  || fail "--report wrote into a harness home"
[ ! -e "$WORK/index" ] || fail "--report created the index home"

run_install "$WORK/install1.out"
want_line "$WORK/install1.out" "Cursor hooks: present, not wired"
left="$(files_in "$CLAUDE_HOME" "$CODEX_HOME" "$CURSOR_HOME" "$OPENCODE_HOME" "$GEMINI_HOME" "$HERMES_HOME" "$CURSOR_AGENT_HOME")"
[ -z "$left" ] || fail "install wrote into bare, unwired harness homes: $left"
[ ! -e "$CURSOR_HOME/hooks.json" ] || fail "created ~/.cursor/hooks.json for a Cursor without cursor-agent"
[ -L "$WORK/bin/tap" ] || fail "the tap command was not linked"

# 2. A missing home is absent, not an error.
mv "$HERMES_HOME" "$WORK/hermes-moved"
run_install "$WORK/report2.out" --report
want_line "$WORK/report2.out" "Hermes: absent ($HERMES_HOME does not exist)"
mv "$WORK/hermes-moved" "$HERMES_HOME"

# 3. Installing the harness later and rerunning wires it (what --sync re-execs).
printf '#!/bin/sh\nexit 0\n' >"$WORK/stub/cursor-agent"; chmod +x "$WORK/stub/cursor-agent"
run_install "$WORK/report3.out" --report
want_line "$WORK/report3.out" "Cursor hooks: will wire (cursor-agent is on PATH)"
HOOK=0 run_install "$WORK/report3-nohook.out" --report
want_line "$WORK/report3-nohook.out" "Cursor hooks: will wire (cursor-agent is on PATH); hook wiring skipped (TAP_INSTALL_HOOK=0)"
want_line "$WORK/report3.out" "Claude: present, not wired"
run_install "$WORK/install3.out"
grep -q 'tap-cursor-session-start' "$CURSOR_HOME/hooks.json" || fail "cursor hooks were not wired after cursor-agent appeared"
[ -z "$(files_in "$CLAUDE_HOME" "$CODEX_HOME" "$OPENCODE_HOME" "$GEMINI_HOME")" ] || fail "an unrelated bare home was written"
run_install "$WORK/report3b.out" --report
want_line "$WORK/report3b.out" "Cursor hooks: already wired"

# 4. An existing hooks file wires its harness with no command on PATH, and
# foreign entries survive.
rm -f "${WORK:?}/stub/cursor-agent"
printf '%s\n' '{"theme":"dark"}' >"$CLAUDE_HOME/settings.json"
mkdir -p "$GEMINI_HOME/config"
printf '%s\n' '{"claude-mem":{"Stop":[{"type":"command","command":"/foreign/agy-stop"}]}}' >"$GEMINI_HOME/config/hooks.json"
run_install "$WORK/report4.out" --report
want_line "$WORK/report4.out" "Claude: will wire (its hooks file exists)"
want_line "$WORK/report4.out" "Antigravity: will wire (its hooks file exists)"
want_line "$WORK/report4.out" "Codex: present, not wired"
# TAP_INSTALL_HOOK=0 skips hook wiring but not skills or the native plugin: the report says
# so per family, and the run leaves settings.json without TAP's hook.
HOOK=0 run_install "$WORK/report4-nohook.out" --report
want_line "$WORK/report4-nohook.out" "Claude: will wire (its hooks file exists); hook wiring skipped (TAP_INSTALL_HOOK=0); skills and native plugin still managed"
want_line "$WORK/report4-nohook.out" "Antigravity: will wire (its hooks file exists); hook wiring skipped (TAP_INSTALL_HOOK=0); skill links still managed"
HOOK=0 run_install "$WORK/install4-nohook.out"
! grep -q 'tap-advisory.sh' "$CLAUDE_HOME/settings.json" || fail "TAP_INSTALL_HOOK=0 still wired Claude's hook"
! grep -q 'tap-shell-body-guard' "$GEMINI_HOME/config/hooks.json" || fail "TAP_INSTALL_HOOK=0 still wired Antigravity's hook"
run_install "$WORK/install4.out"
grep -q 'tap-advisory.sh' "$CLAUDE_HOME/settings.json" || fail "claude hooks were not wired from an existing settings.json"
grep -q '"theme"' "$CLAUDE_HOME/settings.json" || fail "claude settings.json lost a foreign key"
grep -q '/foreign/agy-stop' "$GEMINI_HOME/config/hooks.json" || fail "a foreign Antigravity hook was lost"
[ -z "$(files_in "$CODEX_HOME")" ] || fail "Codex was written without its command or hooks file"

# 5. --report is read-only and refuses to combine with another mode.
snapshot() { find "$WORK" -path "$WORK/path" -prune -o -name '*.out' -prune -o -print | LC_ALL=C sort | cksum; }
before="$(snapshot)"
run_install "$WORK/report5.out" --report
[ "$before" = "$(snapshot)" ] || fail "--report changed the tree"
if PATH="$WORK/path" bash "$ROOT/install.sh" --report --sync >"$WORK/combo.out" 2>&1; then fail "--report --sync was accepted"; fi
grep -qF -- "--report is read-only" "$WORK/combo.out" || fail "--report --sync refusal did not say why"

# 6. --report leaves an empty home empty, the runtime's own startup cache
# included. Cache redirects are cleared for this run so an inherited pin cannot
# hide a write.
EMPTY_HOME="$WORK/empty-home"
mkdir "$EMPTY_HOME"
HOME="$EMPTY_HOME" PATH="$WORK/bin:$WORK/stub:$WORK/path" TAP_INSTALL_BIN="$WORK/bin" \
TAP_CLAUDE_HOME="$CLAUDE_HOME" TAP_CODEX_HOME="$CODEX_HOME" TAP_HERMES_HOME="$HERMES_HOME" \
TAP_CURSOR_HOME="$CURSOR_HOME" TAP_OPENCODE_HOME="$OPENCODE_HOME" TAP_GEMINI_HOME="$GEMINI_HOME" \
TAP_CURSOR_AGENT_HOME="$CURSOR_AGENT_HOME" TAP_AGENTS_HOME="$WORK/agents" TAP_INDEX_HOME="$WORK/index" \
  env -u BUN_RUNTIME_TRANSPILER_CACHE_PATH -u XDG_CACHE_HOME \
  bash "$ROOT/install.sh" --report >"$WORK/report6.out" 2>&1 || { cat "$WORK/report6.out" >&2; fail "install.sh --report exited nonzero with an empty home"; }
want_line "$WORK/report6.out" "install: harnesses:"
wrote="$(files_in "$EMPTY_HOME")"
[ -z "$wrote" ] || fail "--report wrote into an empty home: $wrote"

# 7. The report is the consent preview: beyond the harness lines it names every
# other thing a real run does or asks, quotes the two tmux questions exactly as
# the prompts print them, and ends on how to keep and how to remove TAP.
want_line "$WORK/report6.out" "install: a real run also does this (the report itself writes nothing):"
want_line "$WORK/report6.out" "tap command: links $WORK/bin/tap -> $ROOT/bin/tap"
want_line "$WORK/report6.out" "PATH: $WORK/bin is already on PATH; nothing to change"
want_line "$WORK/report6.out" "zsh completion: links $WORK/share/zsh/site-functions/_tap -> $ROOT/completions/_tap"
want_line "$WORK/report6.out" "TAP state: creates $WORK/index with install-manifest.json"
want_line "$WORK/report6.out" "fzf: installs TAP's own pinned fzf under $WORK/index/tools/fzf; the first install downloads it from github.com/junegunn/fzf"
want_line "$WORK/report6.out" "Codex also gets one marked TAP section in its AGENTS.md"
if [ -d "$WORK/agents" ]; then
  want_line "$WORK/report6.out" "shared skills: links TAP's skills into $WORK/agents"
else
  want_line "$WORK/report6.out" "shared skills: $WORK/agents does not exist, so no shared skill links are made"
fi
want_line "$WORK/report6.out" "without a terminal it asks nothing, edits no shell or tmux file"
want_line "$WORK/report6.out" "tmux question 1 (default yes): \"Install the TAP agent lookup keybinding (prefix C-g)?\""
want_line "$WORK/report6.out" "tmux question 2 (default yes): \"Install TAP tmux defaults (truecolor, mouse, scrolling, clipboard; plus a status bar if you have no tmux config yet)?\""
want_line "$WORK/report6.out" "undo: tap keybinding remove"
want_line "$WORK/report6.out" "undo: tap tmux-defaults remove"
want_line "$WORK/report6.out" "install: keep this clone ($ROOT): the tap command, hooks and uninstaller run from it. To remove TAP: tap uninstall --dry-run, then tap uninstall; delete the clone only after its last line says it is safe to delete."
# The prompts print the same question variables the report quotes.
grep -qF 'printf '"'"'%s [Y/n] '"'"' "$TMUX_KEYBINDING_QUESTION"' "$ROOT/install.sh" || fail "the keybinding prompt no longer prints the string the report quotes"
grep -qF 'printf '"'"'%s [Y/n] '"'"' "$TMUX_DEFAULTS_QUESTION"' "$ROOT/install.sh" || fail "the tmux-defaults prompt no longer prints the string the report quotes"
# The shell line follows the caller's shell, and PATH off the bin dir is said so.
SHELL=/bin/zsh HOME="$EMPTY_HOME" PATH="$WORK/stub:$WORK/path" TAP_INSTALL_BIN="$WORK/bin" \
TAP_CLAUDE_HOME="$CLAUDE_HOME" TAP_CODEX_HOME="$CODEX_HOME" TAP_HERMES_HOME="$HERMES_HOME" \
TAP_CURSOR_HOME="$CURSOR_HOME" TAP_OPENCODE_HOME="$OPENCODE_HOME" TAP_GEMINI_HOME="$GEMINI_HOME" \
TAP_CURSOR_AGENT_HOME="$CURSOR_AGENT_HOME" TAP_AGENTS_HOME="$WORK/agents" TAP_INDEX_HOME="$WORK/index" \
  bash "$ROOT/install.sh" --report >"$WORK/report7.out" 2>&1 || { cat "$WORK/report7.out" >&2; fail "install.sh --report exited nonzero under zsh"; }
want_line "$WORK/report7.out" "PATH: $WORK/bin is not on PATH; the installer prints the export line to add and edits no shell file itself"
want_line "$WORK/report7.out" "shell integration (asked by setup, default yes): adds one marked TAP block to $EMPTY_HOME/.zshrc"
SHELL=/bin/bash run_install "$WORK/report7-bash.out" --report
want_line "$WORK/report7-bash.out" "/.bashrc with PATH if missing, the tap_launch helper and an alias per chosen preset"
SHELL=/usr/bin/fish run_install "$WORK/report7-fish.out" --report
want_line "$WORK/report7-fish.out" "shell integration: not offered for fish (Bash and Zsh only); no shell startup file is edited"

# 8. Every finished install ends on the same keep-and-remove line; --help carries
# the removal steps; --uninstall points at the real uninstaller and writes nothing.
run_install "$WORK/install8.out"
want_line "$WORK/install8.out" "install: keep this clone ($ROOT): the tap command, hooks and uninstaller run from it. To remove TAP: tap uninstall --dry-run, then tap uninstall; delete the clone only after its last line says it is safe to delete."
bash "$ROOT/install.sh" --help >"$WORK/help.out" 2>&1 || fail "--help exited nonzero"
want_line "$WORK/help.out" "Keep this clone."
want_line "$WORK/help.out" "tap uninstall --dry-run   # preview what would be removed"
want_line "$WORK/help.out" "Delete this clone only after tap uninstall's last line says it is safe to"
want_line "$WORK/help.out" "keep the clone: TAP still runs from it."
! grep -qF "then delete this clone" "$WORK/help.out" || fail "--help still tells people to delete the clone unconditionally"
before="$(snapshot)"
if PATH="$WORK/path" bash "$ROOT/install.sh" --uninstall >"$WORK/uninstall.out" 2>&1; then fail "--uninstall exited 0"; fi
want_line "$WORK/uninstall.out" "Run: tap uninstall --dry-run (preview), then tap uninstall. Delete this clone only after tap uninstall's last line says it is safe to delete"
[ "$before" = "$(snapshot)" ] || fail "--uninstall changed the tree"

# 9. Another program named tap earlier on PATH is called out once, with the fix;
# without one there is no warning.
! grep -qF "another 'tap' comes first on PATH" "$WORK/install8.out" || fail "warned about another tap when TAP's own is first on PATH"
printf '#!/bin/sh\nexit 0\n' >"$WORK/stub/tap"; chmod +x "$WORK/stub/tap"
PATH="$WORK/stub:$WORK/bin:$WORK/path" TAP_INSTALL_BIN="$WORK/bin" \
TAP_CLAUDE_HOME="$CLAUDE_HOME" TAP_CODEX_HOME="$CODEX_HOME" TAP_HERMES_HOME="$HERMES_HOME" \
TAP_CURSOR_HOME="$CURSOR_HOME" TAP_OPENCODE_HOME="$OPENCODE_HOME" TAP_GEMINI_HOME="$GEMINI_HOME" \
TAP_CURSOR_AGENT_HOME="$CURSOR_AGENT_HOME" TAP_AGENTS_HOME="$WORK/agents" TAP_INDEX_HOME="$WORK/index" \
  bash "$ROOT/install.sh" >"$WORK/install9.out" 2>&1 || { cat "$WORK/install9.out" >&2; fail "install.sh exited nonzero with another tap on PATH"; }
want_line "$WORK/install9.out" "install: WARNING: another 'tap' comes first on PATH: $WORK/stub/tap. Typing tap runs that one, not this install ($WORK/bin/tap)."
want_line "$WORK/install9.out" "install: fix: put TAP first by adding this line to your shell startup file, then open a new terminal: export PATH="
[ "$(grep -cF "another 'tap' comes first on PATH" "$WORK/install9.out")" = 1 ] || fail "the other-tap warning was not printed exactly once"
rm -f "${WORK:?}/stub/tap"
# A second link to this same install earlier on PATH is not another tap.
ln -s "$WORK/bin/tap" "$WORK/stub/tap"
PATH="$WORK/stub:$WORK/bin:$WORK/path" TAP_INSTALL_BIN="$WORK/bin" \
TAP_CLAUDE_HOME="$CLAUDE_HOME" TAP_CODEX_HOME="$CODEX_HOME" TAP_HERMES_HOME="$HERMES_HOME" \
TAP_CURSOR_HOME="$CURSOR_HOME" TAP_OPENCODE_HOME="$OPENCODE_HOME" TAP_GEMINI_HOME="$GEMINI_HOME" \
TAP_CURSOR_AGENT_HOME="$CURSOR_AGENT_HOME" TAP_AGENTS_HOME="$WORK/agents" TAP_INDEX_HOME="$WORK/index" \
  bash "$ROOT/install.sh" >"$WORK/install9b.out" 2>&1 || { cat "$WORK/install9b.out" >&2; fail "install.sh exited nonzero with a second link to itself on PATH"; }
! grep -qF "another 'tap' comes first on PATH" "$WORK/install9b.out" || fail "a second link to the same install was reported as another tap"
rm -f "${WORK:?}/stub/tap"

# 10. The installer's own Bun steps run in the caller's directory. A project's
# bunfig.toml preload must not run inside them, for the report or a full install.
HOSTILE="$WORK/project"
mkdir "$HOSTILE"
# The name is passed as an argument so this file holds no relative path to a
# file the repository does not track; the bunfig.toml bytes are unchanged.
printf 'preload = ["./%s"]\n' preload.ts >"$HOSTILE/bunfig.toml"
printf 'require("node:fs").appendFileSync(process.env.TAP_TEST_PRELOAD_MARKER, "ran\\n");\n' >"$HOSTILE/preload.ts"
export TAP_TEST_PRELOAD_MARKER="$WORK/preload-marker"
( cd "$HOSTILE" && run_install "$WORK/report10.out" --report )
[ ! -e "$WORK/preload-marker" ] || fail "--report ran the working directory's bunfig.toml preload"
( cd "$HOSTILE" && run_install "$WORK/install10.out" )
[ ! -e "$WORK/preload-marker" ] || fail "install ran the working directory's bunfig.toml preload"
unset TAP_TEST_PRELOAD_MARKER

# 11. Claude's PermissionRequest observer follows the installed Claude Code's
# version in both directions, on every run. Claude Code added the event in
# 2.0.45, and an older Claude stops each start on a settings warning for a hook
# event it does not know, so the entry must not outlive a downgrade.
claude_stub() { printf '#!/bin/sh\necho "%s"\n' "$1" >"$WORK/stub/claude"; chmod +x "$WORK/stub/claude"; }
observer_wired() { grep -q 'tap-claude-permission.sh' "$CLAUDE_HOME/settings.json"; }
# Step 4 wired Claude from its hooks file with no claude command: no version to read.
want_line "$WORK/report4.out" "permission-request observer not wired: could not read a version from 'claude --version'"
want_line "$WORK/install4.out" "install: note: permission-request observer not wired: could not read a version from 'claude --version'; ./install.sh --sync adds it once the version reads 2.0.45 or newer"
! observer_wired || fail "the observer was wired for a Claude whose version could not be read"
# A foreign PermissionRequest hook must survive every step below.
jq '.hooks.PermissionRequest = [{"hooks": [{"type": "command", "command": "/foreign/permission-status"}]}]' \
  "$CLAUDE_HOME/settings.json" >"$WORK/settings-with-foreign.json"
cp "$WORK/settings-with-foreign.json" "$CLAUDE_HOME/settings.json"
foreign_kept() { grep -q '/foreign/permission-status' "$CLAUDE_HOME/settings.json" || fail "$1 lost a foreign PermissionRequest hook"; }

claude_stub "2.1.323 (Claude Code)"
run_install "$WORK/report11.out" --report
want_line "$WORK/report11.out" "permission-request observer wired for Claude Code 2.1.323"
! observer_wired || fail "--report wired the observer"
HOOK=0 run_install "$WORK/install11-nohook.out"
! observer_wired || fail "TAP_INSTALL_HOOK=0 wired the observer"
run_install "$WORK/install11.out"
observer_wired || fail "the observer was not wired for Claude Code 2.1.323"
want_line "$WORK/install11.out" "install: wired PermissionRequest observer into $CLAUDE_HOME/settings.json"
run_install "$WORK/install11-again.out"
[ "$(grep -o 'tap-claude-permission.sh' "$CLAUDE_HOME/settings.json" | wc -l | tr -d ' ')" = 1 ] || fail "a second run duplicated the observer"
foreign_kept "wiring the observer"

# The floor itself stays wired; one patch below it is removed, even with hook wiring switched off.
claude_stub "2.0.45 (Claude Code)"
run_install "$WORK/install11-floor.out"
observer_wired || fail "the observer was removed at the floor version 2.0.45"
claude_stub "2.0.44 (Claude Code)"
run_install "$WORK/report11-old.out" --report
want_line "$WORK/report11-old.out" "permission-request observer not wired: Claude Code 2.0.44 is older than 2.0.45"
observer_wired || fail "--report removed the observer"
HOOK=0 run_install "$WORK/install11-old.out"
! observer_wired || fail "a Claude Code below 2.0.45 kept the observer wired"
want_line "$WORK/install11-old.out" "install: removed PermissionRequest observer from $CLAUDE_HOME/settings.json"
grep -q 'tap-advisory.sh' "$CLAUDE_HOME/settings.json" || fail "removing the observer took the SessionStart hook with it"
grep -q '"theme"' "$CLAUDE_HOME/settings.json" || fail "removing the observer lost a foreign key"
foreign_kept "removing the observer"
run_install "$WORK/install11-old-note.out"
want_line "$WORK/install11-old-note.out" "install: note: permission-request observer not wired: Claude Code 2.0.44 is older than 2.0.45, which added the PermissionRequest hook; after updating Claude Code, ./install.sh --sync adds it"

# Upgrading wires it again; a version that stops being readable removes it.
claude_stub "2.1.323 (Claude Code)"
run_install "$WORK/install11-up.out"
observer_wired || fail "the observer was not wired again after the upgrade"
claude_stub "development build"
run_install "$WORK/install11-unreadable.out"
! observer_wired || fail "an unreadable Claude Code version kept the observer wired"
foreign_kept "an unreadable version"

echo "install-harness-wiring: ok"
