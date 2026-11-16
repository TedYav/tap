#!/usr/bin/env bash
# shell-body-guard-upgrade.test.sh — S1 flip upgrade fixture.
# Old-install shapes (every harness still carrying the .py registration) run
# through the flipped installer: registrations are REPLACED with the Bun hook,
# never appended; foreign hooks and outside-fence bytes survive; a recorded
# pre-E4 .py twin is retired by the hash-matched cleanup while unrecorded
# files survive; the install manifest covers the new surfaces, records none
# of the foreign ones and no .py name anywhere; a second install is
# idempotent; the registered command denies live.
# Renamed from .pending by the S1 flip commit together with the install.sh
# wiring (the test is red until the installer flips).
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
BUN="${TAP_SMOKE_BUN:-$(command -v bun 2>/dev/null || true)}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ -n "$BUN" ] && [ -x "$BUN" ] || {
  echo "shell-body-guard-upgrade: Bun executable unavailable" >&2
  exit 1
}

git clone --quiet --shared "$ROOT" "$WORK/repo"
# The working-tree installer participates even before it is committed; the
# native scanner and fence module ship inside the clone.
cp "$ROOT/install.sh" "$WORK/repo/install.sh"
REPO="$(cd "$WORK/repo" && pwd -P)"

CLAUDE_HOME="$WORK/claude"
CODEX_HOME="$WORK/codex"
CURSOR_HOME="$WORK/cursor"
OPENCODE_HOME="$WORK/opencode"
GEMINI_HOME="$WORK/gemini"
mkdir -p "$CLAUDE_HOME" "$CODEX_HOME" "$CURSOR_HOME" "$OPENCODE_HOME/plugins" "$GEMINI_HOME/config" \
  "$WORK/hermes" "$WORK/cursor-agent" "$WORK/agents" "$WORK/bin" "$WORK/index"

OLD_GUARD="$ROOT/hooks/tap-shell-body-guard.py"
NEW_GUARD="$REPO/hooks/tap-shell-body-guard.ts"

# Mixed-generation Claude shape: the advisory is ALREADY wired (every real
# old install has it) plus a .ts registration (current install) AND an older
# .py one — the write must then depend only on the guard path, and migration
# must end with exactly one .ts guard entry, never both.
cat >"$CLAUDE_HOME/settings.json" <<JSON
{"theme":"dark","hooks":{
  "SessionStart":[{"hooks":[{"type":"command","command":"$REPO/hooks/tap-advisory.sh"}]}],
  "PreToolUse":[
    {"matcher":"Read","hooks":[{"type":"command","command":"/foreign/read"}]},
    {"matcher":"Bash","hooks":[{"type":"command","command":"$NEW_GUARD"}]},
    {"matcher":"Bash","hooks":[{"type":"command","command":"$OLD_GUARD"}]}
  ]
}}
JSON

cat >"$CODEX_HOME/config.toml" <<TOML
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
command = "$REPO/hooks/tap-codex-session-start.sh"

[[hooks.PreToolUse]]
matcher = "^Bash$"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "$OLD_GUARD"
timeout = 5
statusMessage = "Checking tmux server target"

# tap-managed:end Codex SessionStart
[hooks.state]
[hooks.state."foreign:session_start:0:0"]
trusted_hash = "sha256:foreign"
TOML

# Cursor: mixed-generation rows (a .ts row ahead of the legacy .py one) —
# rewrite/dedupe to exactly one .ts guard row in the first guard position.
cat >"$CURSOR_HOME/hooks.json" <<JSON
{"version":1,"hooks":{"beforeShellExecution":[
  {"command":"/foreign/cursor-shell"},
  {"command":"/older/tap-shell-body-guard.ts"},
  {"command":"$OLD_GUARD"}
]}}
JSON

cat >"$GEMINI_HOME/config/hooks.json" <<JSON
{"foreign-tool":{"PreToolUse":[{"matcher":"run_command","hooks":[{"type":"command","command":"/foreign/agy"}]}]},"tap-tmux-kill-server":{"PreToolUse":[{"matcher":"run_command","hooks":[{"type":"command","command":"$OLD_GUARD","timeout":5}]}]}}
JSON

# A recorded pre-E4 twin (the S2-era install wrote it AND pinned it) is
# retired by the hash-matched cleanup; an UNRECORDED old file survives.
cat >"$WORK/want-guard-shim" <<EOF
#!/usr/bin/env bash
exec bun "$NEW_GUARD" "\$@"
EOF
cp "$WORK/want-guard-shim" "$OPENCODE_HOME/plugins/tap-shell-body-guard.py"
TWIN_SHA="$(shasum -a 256 <"$WORK/want-guard-shim" | cut -d' ' -f1)"
printf 'OLD\n' >"$OPENCODE_HOME/plugins/tap-shell-body-guard.py.bak"
mkdir -p "$WORK/index"
cat >"$WORK/index/install-manifest.json" <<JSON
{"version":1,"entries":[{"kind":"file","path":"$OPENCODE_HOME/plugins/tap-shell-body-guard.py","sha256":"$TWIN_SHA"}]}
JSON
printf 'OLD-PLUGIN\n' >"$OPENCODE_HOME/plugins/tap-opencode-tmux-guard.ts"

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
    bash "$REPO/install.sh" >"$WORK/install-$1.out" 2>"$WORK/install-$1.err"
}

run_install 1
run_install 2

python3 - "$REPO" "$CLAUDE_HOME" "$CODEX_HOME" "$CURSOR_HOME" "$OPENCODE_HOME" "$GEMINI_HOME" "$WORK/index/install-manifest.json" <<'PY'
import json
import pathlib
import sys

repo_s, claude_s, codex_s, cursor_s, opencode_s, gemini_s, manifest_s = sys.argv[1:8]
repo = pathlib.Path(repo_s)
new_guard = str(repo / "hooks/tap-shell-body-guard.ts")
old_tail = "tap-shell-body-guard.py"

# Claude: replaced/deduped, never appended; foreign preserved.
settings = json.loads((pathlib.Path(claude_s) / "settings.json").read_text())
assert settings["theme"] == "dark"
pre = settings["hooks"]["PreToolUse"]
guards = [e for e in pre if e.get("matcher") == "Bash"]
assert len(guards) == 1, guards
assert guards[0]["hooks"] == [{"type": "command", "command": new_guard}], guards[0]
assert old_tail not in json.dumps(settings)
assert any(e.get("matcher") == "Read" for e in pre)

# Codex: fence rewritten old->new, single, foreign + state bytes untouched.
toml = (pathlib.Path(codex_s) / "config.toml").read_text()
assert toml.count("# tap-managed:begin Codex SessionStart") == 1
assert toml.count("# tap-managed:end Codex SessionStart") == 1
assert json.dumps(new_guard) in toml, "fence missing the Bun hook command"
assert old_tail not in toml
assert 'command = "/foreign/codex-session"' in toml
assert '[hooks.state."foreign:session_start:0:0"]' in toml
assert 'trusted_hash = "sha256:foreign"' in toml

# Cursor: replaced in place, foreign preserved, sessionStart wired.
cursor = json.loads((pathlib.Path(cursor_s) / "hooks.json").read_text())
bse = cursor["hooks"]["beforeShellExecution"]
assert len(bse) == 2, bse
assert bse[0] == {"command": "/foreign/cursor-shell"}, bse
assert bse[1] == {"command": new_guard}, bse
assert old_tail not in json.dumps(cursor)
assert any("tap-cursor-session-start.sh" in e["command"] for e in cursor["hooks"]["sessionStart"])

# Antigravity: managed key updated, foreign key preserved.
agy = json.loads((pathlib.Path(gemini_s) / "config/hooks.json").read_text())
assert agy["tap-tmux-kill-server"]["PreToolUse"][0]["hooks"][0]["command"] == new_guard
assert old_tail not in json.dumps(agy)
assert agy["foreign-tool"]["PreToolUse"][0]["hooks"][0]["command"] == "/foreign/agy"

# OpenCode: the extensionless plugin name is the generated absolute-path
# shim the current tmux-guard plugin spawns; a recorded pre-E4 .py twin is
# retired by the hash-matched cleanup, while unrecorded files survive.
plugins = pathlib.Path(opencode_s) / "plugins"
shim = (plugins / "tap-shell-body-guard").read_text()
bun_config = str(repo / "runtime/bun/tap-bunfig.toml")
assert shim == f'#!/usr/bin/env bash\nc="{bun_config}"; [ -f "$c" ] || c=/dev/null\nexec bun --config="$c" --no-env-file "{new_guard}" "$@"\n', shim
assert not (plugins / "tap-shell-body-guard.py").exists()
assert (plugins / "tap-shell-body-guard.py.bak").read_text() == "OLD\n"
assert (plugins / "tap-opencode-tmux-guard.ts").read_bytes() == (repo / "hooks/tap-opencode-tmux-guard.ts").read_bytes()

# Manifest: covers the new hook surfaces, records none of the foreign ones;
# the retired twin's entry is gone — no .py name appears anywhere in it.
manifest = json.loads(pathlib.Path(manifest_s).read_text())
entries = manifest["entries"]
recorded = json.dumps(entries)
assert new_guard in recorded
assert old_tail not in recorded, recorded
assert "/foreign/" not in recorded
commands = [e.get("value", {}).get("command") for e in entries if e.get("kind") == "hook"]
assert commands.count(new_guard) == 2, commands  # Claude settings + Cursor (Codex is a block, Antigravity a json-key)
print("shell-body-guard-upgrade: ok")
PY

# The registered command denies live through the flipped entry point...
OUT="$(printf '%s' '{"tool_name":"Bash","tool_input":{"command":"tmux kill-server"}}' | "$REPO/hooks/tap-shell-body-guard.ts")"
case "$OUT" in
  *BLOCKED*) : ;;
  *) echo "shell-body-guard-upgrade: registered hook did not deny: $OUT" >&2; exit 1 ;;
esac

# ...and the recorded pre-E4 twin was retired by the hash-matched cleanup.
grep -q 'retired stale recorded artifact .*tap-shell-body-guard\.py (hash matched)' "$WORK/install-1.err" \
  || { echo "shell-body-guard-upgrade: C2 retirement line missing from install stderr" >&2; exit 1; }

echo "shell-body-guard-upgrade: ok"
