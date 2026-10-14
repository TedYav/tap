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

echo "install-harness-wiring: ok"
