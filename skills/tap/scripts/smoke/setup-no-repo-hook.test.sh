#!/usr/bin/env bash
# setup-no-repo-hook.test.sh — tap-hj72: the merge gate owns the recurrence.
#
# tap setup --yes must not plant a repo-level TAP advisory. That is the shape
# the tap-pkoq ruling retired, and the installer that recreated it lived in
# setup. The fuller fixture (strip, keep-me, charter) stays in
# regress/init-idempotent.test.sh, which never gates.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TAP_INDEX_HOME="$WORK/index"
export TAP_CLAUDE_HOME="$WORK/empty-claude"

run_setup() {
  local repo="$1"
  (cd "$repo" && env -u TAP_HOME "$TAP" setup --yes >/dev/null)
}

# Existing settings file: setup --yes must not plant tap-advisory.sh.
PLANTED="$WORK/planted"
mkdir -p "$PLANTED/.claude"
git -C "$PLANTED" init -q
cat > "$PLANTED/.claude/settings.json" <<'JSON'
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo keep-me"
          }
        ]
      }
    ]
  }
}
JSON
run_setup "$PLANTED"
python3 -B - "$PLANTED/.claude/settings.json" <<'PY'
import json, sys
settings = json.load(open(sys.argv[1]))
commands = []
for entry in settings.get("hooks", {}).get("SessionStart", []) or []:
    for hook in entry.get("hooks", []) or []:
        commands.append(hook.get("command") or "")
if any("tap-advisory.sh" in cmd for cmd in commands):
    raise SystemExit("setup-no-repo-hook: setup --yes planted tap-advisory.sh")
PY
echo "setup-no-repo-hook: (1) setup --yes does not plant a repo-level TAP advisory: ok"

# Absent file stays absent — planting would create it.
ABSENT="$WORK/absent"
mkdir -p "$ABSENT"
git -C "$ABSENT" init -q
run_setup "$ABSENT"
[ ! -e "$ABSENT/.claude/settings.json" ] \
  || { echo "setup-no-repo-hook: setup --yes created absent .claude/settings.json" >&2; exit 1; }
echo "setup-no-repo-hook: (2) absent .claude/settings.json stays absent: ok"

echo "setup-no-repo-hook: ok"
