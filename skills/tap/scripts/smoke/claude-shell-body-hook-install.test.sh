#!/usr/bin/env bash
# claude-shell-body-hook-install.test.sh — tap-liero production wiring
# A scratch install must place the shell-body guard in Claude's real user-level
# settings builder. hooks/hooks.json alone is inert when TAP is not a plugin.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

# pwd -P: install.sh resolves its repo the same way, and the guard command it
# writes into settings carries that physical path. A checkout reached through
# a symlink (a $TMPDIR candidate on macOS is /var -> /private/var) makes the
# logical and physical roots differ; every path equality below is physical.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

CLAUDE_HOME="$WORK/claude"
mkdir -p "$CLAUDE_HOME"
cat >"$CLAUDE_HOME/settings.json" <<'JSON'
{
  "theme": "dark",
  "hooks": {
    "PreToolUse": [
      {"matcher": "Read", "hooks": [{"type": "command", "command": "/other/read-hook"}]}
    ],
    "SessionStart": [
      {"hooks": [{"type": "command", "command": "/other/session-hook"}]}
    ]
  }
}
JSON

python3 - "$CLAUDE_HOME/settings.json" "$ROOT" <<'PY'
import json
import pathlib
import sys

path, root = map(pathlib.Path, sys.argv[1:])
settings = json.loads(path.read_text())
guard = str(root / "hooks/tap-shell-body-guard.py")
settings["hooks"]["PreToolUse"].append(
    {"matcher": "Bash", "hooks": [{"type": "prompt", "command": guard}]}
)
path.write_text(json.dumps(settings, indent=2) + "\n")
PY

run_install() {
  PATH="$WORK/bin:$PATH" TAP_INSTALL_BIN="$WORK/bin" \
  TAP_CLAUDE_HOME="$CLAUDE_HOME" \
  TAP_CODEX_HOME="$WORK/no-codex" \
  TAP_HERMES_HOME="$WORK/no-hermes" \
  TAP_CURSOR_HOME="$WORK/no-cursor" \
  TAP_OPENCODE_HOME="$WORK/no-opencode" \
  TAP_GEMINI_HOME="$WORK/no-gemini" \
  TAP_CURSOR_AGENT_HOME="$WORK/no-cursor-agent" \
  TAP_AGENTS_HOME="$WORK/no-agents" \
  TAP_INDEX_HOME="$WORK/tap-index" \
  TAP_INSTALL_HOOK=1 \
    bash "$ROOT/install.sh" >"$WORK/install.out"
}

run_install

python3 - "$CLAUDE_HOME/settings.json" "$ROOT" <<'PY'
import json
import pathlib
import sys

path, root = sys.argv[1:]
settings = json.loads(pathlib.Path(path).read_text())
assert settings.get("theme") == "dark", "install rewrote unrelated Claude settings"

hooks = settings.get("hooks", {})
pre = hooks.get("PreToolUse", [])
guard = str(pathlib.Path(root) / "hooks/tap-shell-body-guard.ts")
old_guard = str(pathlib.Path(root) / "hooks/tap-shell-body-guard.py")
guard_entries = [
    entry
    for entry in pre
    if entry.get("matcher") == "Bash"
    and any(h.get("type") == "command" and h.get("command") == guard for h in entry.get("hooks", []))
]
assert len(guard_entries) == 1, f"PreToolUse Bash guard registrations: {guard_entries!r}"
assert any(entry.get("matcher") == "Read" for entry in pre), "install removed another PreToolUse hook"
assert any(
    h.get("type") == "prompt" and h.get("command") == old_guard
    for entry in pre
    for h in entry.get("hooks", [])
), "install removed the same-path non-command hook"

session = hooks.get("SessionStart", [])
commands = [h.get("command") for entry in session for h in entry.get("hooks", [])]
assert "/other/session-hook" in commands, "install removed another SessionStart hook"
assert str(pathlib.Path(root) / "hooks/tap-advisory.sh") in commands, "SessionStart advisory missing"
PY

# tap-1dmsq: the plugin manifest and the install builder are two distribution
# paths for one hook set. Compare them in both directions so a hook cannot ship
# wired into only one. PLUGIN_ONLY waives a hook that is deliberately plugin-only;
# name why beside the entry.
python3 - "$CLAUDE_HOME/settings.json" "$ROOT" <<'PY'
import json
import pathlib
import sys

path, root = sys.argv[1], pathlib.Path(sys.argv[2])
PLUGIN_ONLY: set = set()

def pairs(hooks, prefix, strict):
    # strict: every hook must parse as a TAP hook; an unparsed manifest entry
    # would otherwise drop out of both sets and let the comparison pass.
    out, unparsed = set(), []
    for event, entries in hooks.items():
        for entry in entries:
            for h in entry.get("hooks", []):
                # Both valid quotings, "${ROOT}"/hooks/x and "${ROOT}/hooks/x", normalize alike.
                command = h.get("command", "").replace('"', "") if strict else h.get("command", "")
                script = command[len(prefix):]
                if h.get("type") == "command" and command.startswith(prefix) and "/" not in script and " " not in script:
                    out.add((event, entry.get("matcher"), script))
                elif strict:
                    unparsed.append((event, h))
    assert not unparsed, f"hooks.json entries this control cannot classify: {unparsed}"
    return out

manifest = pairs(json.loads((root / "hooks/hooks.json").read_text())["hooks"],
                 "${CLAUDE_PLUGIN_ROOT}/hooks/", strict=True)
installed = pairs(json.loads(pathlib.Path(path).read_text())["hooks"], f"{root}/hooks/", strict=False)
assert manifest, "hooks/hooks.json yielded no TAP hooks; the parser no longer matches its shape"
missing = manifest - PLUGIN_ONLY - installed
assert not missing, f"hooks.json hooks absent from install: {sorted(missing)}"
extra = installed - manifest
assert not extra, f"install hooks absent from hooks.json: {sorted(extra)}"
PY

cp "$CLAUDE_HOME/settings.json" "$WORK/settings.before-second-install.json"
run_install
cmp -s "$WORK/settings.before-second-install.json" "$CLAUDE_HOME/settings.json" \
  || { echo "claude-shell-body-hook-install: second install changed settings.json" >&2; exit 1; }

guard="$ROOT/hooks/tap-shell-body-guard.ts"
denial="$(printf '%s\n' '{"tool_name":"Bash","tool_input":{"command":"tap send peer -m \"literal `date`\""}}' | "$guard")"
python3 - "$denial" <<'PY'
import json
import sys

result = json.loads(sys.argv[1])
decision = result.get("hookSpecificOutput", {})
assert decision.get("hookEventName") == "PreToolUse"
assert decision.get("permissionDecision") == "deny"
PY

echo "claude-shell-body-hook-install: scratch settings wire one live PreToolUse guard: ok"
