#!/usr/bin/env bash
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo 'codex-hook-fence: run this file; do not source it' >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/codex" "$WORK/home"
export HOME="$WORK/home" TAP_INDEX_HOME="$WORK/index"
run_install() {
  PATH="$WORK/bin:$PATH" TAP_INSTALL_BIN="$WORK/bin" TAP_CODEX_HOME="$WORK/codex" \
  TAP_CLAUDE_HOME="$WORK/absent-claude" TAP_CURSOR_HOME="$WORK/absent-cursor" \
  TAP_HERMES_HOME="$WORK/absent-hermes" TAP_OPENCODE_HOME="$WORK/absent-opencode" \
  TAP_GEMINI_HOME="$WORK/absent-gemini" TAP_CURSOR_AGENT_HOME="$WORK/absent-agent" \
  TAP_AGENTS_HOME="$WORK/agents" TAP_INSTALL_HOOK=1 \
    bash "$ROOT/install.sh" >"$WORK/install.log" 2>&1
}
cat > "$WORK/codex/config.toml" <<'TOML'
model = "foreign"
[features]
hooks = true
[hooks]
# claude-mem:begin
[[hooks.SessionStart]]
matcher = "startup"
[[hooks.SessionStart.hooks]]
type = "command"
command = "/foreign/claude-mem-capture"
# claude-mem:end
# tap-managed:begin Codex SessionStart
[[hooks.SessionStart]]
matcher = "startup|resume|clear|compact"
[[hooks.SessionStart.hooks]]
type = "command"
command = "/old/hooks/tap-codex-session-start.sh"
[[hooks.PreToolUse]]
matcher = "^Bash$"
[[hooks.PreToolUse.hooks]]
type = "command"
command = "/old/hooks/tap-shell-body-guard.py"
timeout = 5
statusMessage = "Checking tmux server target"
# tap-managed:end Codex SessionStart
[hooks.state]
[hooks.state."foreign"]
trusted_hash = "sha256:foreign"
[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "/foreign/stop"
TOML
cp "$WORK/codex/config.toml" "$WORK/original"
run_install || { cat "$WORK/install.log"; exit 1; }
python3 - "$WORK/original" "$WORK/codex/config.toml" <<'PY'
import hashlib, pathlib, sys
before, after = [pathlib.Path(p).read_bytes() for p in sys.argv[1:]]
begin=b'# tap-managed:begin Codex SessionStart'; end=b'# tap-managed:end Codex SessionStart'
def outside(raw):
    a=raw.index(begin); b=raw.index(end)+len(end)
    return raw[:a], raw[b:]
assert [hashlib.sha256(x).hexdigest() for x in outside(before)] == [hashlib.sha256(x).hexdigest() for x in outside(after)]
assert after.count(b'tap-codex-session-start.sh') == 1
# S1 transition: the old .py guard fence migrates to the Bun .ts hook in place.
assert after.count(b'tap-shell-body-guard.ts') == 1
assert b'tap-shell-body-guard.py' not in after
assert after.count(b'/foreign/claude-mem-capture') == 1
PY
cp "$WORK/codex/config.toml" "$WORK/once"
run_install || { cat "$WORK/install.log"; exit 1; }
cmp "$WORK/once" "$WORK/codex/config.toml"
# Reconciliation must respect an explicitly disabled feature outside its fence.
python3 - "$WORK/once" "$WORK/codex/config.toml" <<'PYFIX'
from pathlib import Path
import sys
Path(sys.argv[2]).write_bytes(Path(sys.argv[1]).read_bytes().replace(b'hooks = true', b'hooks = false'))
PYFIX
cp "$WORK/codex/config.toml" "$WORK/feature-disabled"
run_install || { cat "$WORK/install.log"; exit 1; }
cmp "$WORK/feature-disabled" "$WORK/codex/config.toml"
# Codex appends new tables inside the fence while TAP's end marker is the last
# line (toml_edit renders them before trailing comments). Whole tables that
# trail TAP's lines move below the marker: the marker moves, no other byte does.
# Anything else inside the fence refuses before writing. Features are turned
# off so a pre-validation feature edit is also caught by the no-write check.
for kind in state foreign extends unknown malformed; do
  python3 - "$WORK/once" "$WORK/codex/config.toml" "$kind" "$WORK/expected" <<'PY'
import pathlib, sys
raw=pathlib.Path(sys.argv[1]).read_bytes().replace(b'hooks = true', b'hooks = false')
end=b'# tap-managed:end Codex SessionStart\n'
kind=sys.argv[3]
if kind == 'malformed':
    raw=raw.replace(end, end[:-1]+b' broken\n')
elif kind == 'unknown':
    raw=raw.replace(end, b'# foreign annotation\n'+end)
elif kind == 'extends':
    raw=raw.replace(end, b'[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "/foreign/extra"\n'+end)
else:
    start=raw.index(b'[hooks.state]\n' if kind == 'state' else b'[[hooks.Stop]]\n')
    stop=raw.index(b'[[hooks.Stop]]\n', start) if kind == 'state' else len(raw)
    extra=raw[start:stop]
    raw=(raw[:start]+raw[stop:]).replace(end, extra+end)
    # Expected: the same file with only the end-marker line moved up.
    pathlib.Path(sys.argv[4]).write_bytes(raw.replace(extra+end, end+extra))
import tomllib
tomllib.loads(raw.decode())  # the state/foreign/extends cases are valid TOML, not duplicate-table artifacts
pathlib.Path(sys.argv[2]).write_bytes(raw)
PY
  cp "$WORK/codex/config.toml" "$WORK/before"
  rc=0; run_install || rc=$?
  case "$kind" in
    state|foreign)
      [ "$rc" = 0 ] || { cat "$WORK/install.log"; echo "codex-hook-fence: $kind refused"; exit 1; }
      cmp "$WORK/expected" "$WORK/codex/config.toml" || { echo "codex-hook-fence: $kind moved more than the end marker"; exit 1; }
      grep -q 'moved the TAP end marker' "$WORK/install.log" || { cat "$WORK/install.log"; exit 1; }
      run_install || { cat "$WORK/install.log"; exit 1; }
      cmp "$WORK/expected" "$WORK/codex/config.toml" || { echo "codex-hook-fence: $kind second run not idempotent"; exit 1; }
      ;;
    *)
      [ "$rc" != 0 ] || { echo "codex-hook-fence: $kind was silently replaced"; exit 1; }
      cmp "$WORK/before" "$WORK/codex/config.toml" || { echo 'refusal wrote config'; exit 1; }
      grep -q 'cause: .*(line' "$WORK/install.log" || { cat "$WORK/install.log"; echo "codex-hook-fence: $kind refusal names no line"; exit 1; }
      ;;
  esac
done
echo 'codex-hook-fence: outside bytes preserved; trailing Codex tables leave the fence; invalid fence refuses before writing; idempotent'

# First install (no marker) still enables hooks, even at an EOF-only table header.
printf '[features]' > "$WORK/codex/config.toml"
run_install || { cat "$WORK/install.log"; exit 1; }
python3 - "$WORK/codex/config.toml" <<'PYFIX'
import sys, tomllib
with open(sys.argv[1], 'rb') as stream: config=tomllib.load(stream)
assert config['features']['hooks'] is True
assert len(config['hooks']['SessionStart']) == len(config['hooks']['PreToolUse']) == 1
PYFIX
