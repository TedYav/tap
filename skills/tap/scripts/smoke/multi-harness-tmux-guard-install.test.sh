#!/usr/bin/env bash
# tap-6qxht: a scratch install wires the same tmux guard into each supported
# shell pre-execution surface without disturbing unrelated user hooks.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

# pwd -P: install.sh resolves its repo physically; the guard commands it wires
# into each harness config carry that path. A symlinked checkout (a $TMPDIR
# candidate on macOS is /var -> /private/var) makes logical differ, so every
# path equality below must use the physical root.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)"
BUN="${TAP_SMOKE_BUN:-$(command -v bun 2>/dev/null || true)}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ -n "$BUN" ] && [ -x "$BUN" ] || {
  echo "multi-harness-tmux-guard-install: Bun executable unavailable" >&2
  exit 1
}

CLAUDE_HOME="$WORK/claude"
CODEX_HOME="$WORK/codex"
CURSOR_HOME="$WORK/cursor"
OPENCODE_HOME="$WORK/opencode"
GEMINI_HOME="$WORK/gemini"
mkdir -p \
  "$CLAUDE_HOME" "$CODEX_HOME" "$CURSOR_HOME" \
  "$OPENCODE_HOME/plugins" "$GEMINI_HOME/config" \
  "$WORK/hermes" "$WORK/cursor-agent" "$WORK/agents"

cat >"$CLAUDE_HOME/settings.json" <<'JSON'
{"theme":"dark","hooks":{"PreToolUse":[{"matcher":"Read","hooks":[{"type":"command","command":"/foreign/read"}]}]}}
JSON
cat >"$CODEX_HOME/config.toml" <<'TOML'
model = "foreign"

[features]
hooks = true

[hooks]
[[hooks.SessionStart]]
matcher = "startup"

[[hooks.SessionStart.hooks]]
type = "command"
command = "/foreign/codex-session"

# tap-managed:begin Codex SessionStart
[[hooks.SessionStart]]
matcher = "startup|resume"

[[hooks.SessionStart.hooks]]
type = "command"
command = "/old/tap-codex-session-start.sh"

# tap-managed:end Codex SessionStart
[hooks.state]
[hooks.state."foreign:session_start:0:0"]
trusted_hash = "sha256:foreign"
TOML
cat >"$CURSOR_HOME/hooks.json" <<'JSON'
{"version":1,"hooks":{"beforeShellExecution":[{"command":"/foreign/cursor-shell"},{"command":"/old/tap-shell-body-guard.py"}]}}
JSON
cat >"$GEMINI_HOME/config/hooks.json" <<'JSON'
{"claude-mem":{"Stop":[{"type":"command","command":"/foreign/agy-stop"}]},"tap-tmux-kill-server":{"PreToolUse":[{"matcher":"run_command","hooks":[{"type":"command","command":"/old/tap-shell-body-guard.py"}]}]}}
JSON
printf '%s\n' foreign >"$OPENCODE_HOME/plugins/foreign.ts"

run_install() {
  PATH="$WORK/bin:$PATH" TAP_INSTALL_BIN="$WORK/bin" \
  TAP_CLAUDE_HOME="$CLAUDE_HOME" \
  TAP_CODEX_HOME="$CODEX_HOME" \
  TAP_HERMES_HOME="$WORK/hermes" \
  TAP_CURSOR_HOME="$CURSOR_HOME" \
  TAP_OPENCODE_HOME="$OPENCODE_HOME" \
  TAP_GEMINI_HOME="$GEMINI_HOME" \
  TAP_CURSOR_AGENT_HOME="$WORK/cursor-agent" \
  TAP_AGENTS_HOME="$WORK/agents" \
  TAP_INDEX_HOME="$WORK/index" \
  TAP_INSTALL_HOOK=1 \
    bash "$ROOT/install.sh" >"$WORK/install.out"
}

run_install

python3 -B - "$ROOT" "$CLAUDE_HOME" "$CODEX_HOME" "$CURSOR_HOME" "$GEMINI_HOME" <<'PY'
import json
from pathlib import Path
import sys

root, claude_home, codex_home, cursor_home, gemini_home = map(Path, sys.argv[1:])
guard = str(root / "hooks/tap-shell-body-guard.ts")

claude = json.loads((claude_home / "settings.json").read_text())
claude_pre = claude["hooks"]["PreToolUse"]
assert sum(
    entry.get("matcher") == "Bash"
    and any(h.get("command") == guard for h in entry.get("hooks", []))
    for entry in claude_pre
) == 1, claude_pre
assert any(entry.get("matcher") == "Read" for entry in claude_pre), claude_pre

codex = (codex_home / "config.toml").read_text()
assert 'model = "foreign"' in codex, codex
assert 'command = "/foreign/codex-session"' in codex, codex
assert codex.count("[[hooks.PreToolUse]]") == 1, codex
assert codex.count(guard) == 1, codex
assert "hooks = true" in codex, codex
assert '[hooks.state."foreign:session_start:0:0"]' in codex, codex
assert 'trusted_hash = "sha256:foreign"' in codex, codex
assert "/old/tap-codex-session-start.sh" not in codex, codex

cursor = json.loads((cursor_home / "hooks.json").read_text())
cursor_pre = cursor["hooks"]["beforeShellExecution"]
assert any(entry.get("command") == "/foreign/cursor-shell" for entry in cursor_pre), cursor_pre
tap_cursor = [entry for entry in cursor_pre if entry.get("command") == guard]
assert tap_cursor == [{"command": guard}], tap_cursor

agy = json.loads((gemini_home / "config/hooks.json").read_text())
assert "claude-mem" in agy, agy
tap_agy = agy["tap-tmux-kill-server"]["PreToolUse"]
assert tap_agy == [{
    "matcher": "run_command",
    "hooks": [{"type": "command", "command": guard, "timeout": 5}],
}], tap_agy
PY

test -f "$OPENCODE_HOME/plugins/foreign.ts"
cmp -s "$ROOT/hooks/tap-opencode-tmux-guard.ts" \
  "$OPENCODE_HOME/plugins/tap-opencode-tmux-guard.ts"
# The guard ships as a generated absolute-path shim under the extensionless
# plugin name — the one the current tmux-guard plugin spawns. The pre-E4 .py
# twin is retired: a fresh install writes no second name.
cat >"$WORK/want-guard-shim" <<EOF
#!/usr/bin/env bash
exec bun "$ROOT/hooks/tap-shell-body-guard.ts" "\$@"
EOF
cmp -s "$WORK/want-guard-shim" "$OPENCODE_HOME/plugins/tap-shell-body-guard"
test -x "$OPENCODE_HOME/plugins/tap-shell-body-guard"
test ! -e "$OPENCODE_HOME/plugins/tap-shell-body-guard.py"
OPENCODE_PLUGIN="$OPENCODE_HOME/plugins/tap-opencode-tmux-guard.ts" "$BUN" -e '
const plugin = await import(process.env.OPENCODE_PLUGIN)
for (const [name, factory] of Object.entries(plugin)) {
  if (typeof factory !== "function") continue
  const hooks = await factory({})
  if (!hooks || typeof hooks !== "object") throw new Error(`${name} is not a plugin factory`)
}'

for path in \
  "$CLAUDE_HOME/settings.json" \
  "$CODEX_HOME/config.toml" \
  "$CURSOR_HOME/hooks.json" \
  "$GEMINI_HOME/config/hooks.json"; do
  cp "$path" "$path.before-second-install"
done
agy_mtime_before="$(python3 -c 'import os,sys; print(os.stat(sys.argv[1]).st_mtime_ns)' "$GEMINI_HOME/config/hooks.json")"
run_install
for path in \
  "$CLAUDE_HOME/settings.json" \
  "$CODEX_HOME/config.toml" \
  "$CURSOR_HOME/hooks.json" \
  "$GEMINI_HOME/config/hooks.json"; do
  cmp -s "$path.before-second-install" "$path" || {
    echo "multi-harness-tmux-guard-install: second install changed $path" >&2
    exit 1
  }
done
agy_mtime_after="$(python3 -c 'import os,sys; print(os.stat(sys.argv[1]).st_mtime_ns)' "$GEMINI_HOME/config/hooks.json")"
[ "$agy_mtime_before" = "$agy_mtime_after" ] || {
  echo "multi-harness-tmux-guard-install: second install rewrote identical Antigravity hooks" >&2
  exit 1
}

echo "multi-harness-tmux-guard-install: one shared guard is wired idempotently: ok"
