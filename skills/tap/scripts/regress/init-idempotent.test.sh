#!/usr/bin/env bash
# init-idempotent.test.sh - U7: `tap init` is script-safe/idempotent and `tap setup
# --yes` rewrites repo-local files without appending duplicates. It must NOT plant
# a repo-level TAP advisory (tap-hj72 / tap-pkoq).
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# shellcheck source=helpers.sh
. "$ROOT/skills/tap/scripts/smoke/helpers.sh"
# shellcheck source=sandbox-pins.sh
# tap-ea3z walk: this file pins TAP_INDEX_HOME alone; the unset-only defaults
# here add the other three machine paths (session manifest, opencode db,
# version-seen) for directly invoked bodies, preserving the scratch index above.
. "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TAP_INDEX_HOME="$WORK/index"   # machine index redirect: never touch real ~/.tap

# Born-live: a machine that has held no TAP state is live from its first
# enrollment, so the acting store is the canonical `.tap/team-registry.json` and
# the retired `.tap/bus/registry.json` is never written. This file named the
# retired path literally, which was invisible while every fresh index was
# pre-flip. Resolve the store the marker actually selected, at call time. The
# subject of every arm below is the TEAM BLOCK and its stability, not which file
# holds it; the bus dirs (payloads/receipts) are unaffected, only the registry
# moved.
acting_registry() { # <repo-root>
  if [ -f "$1/.tap/team-registry.json" ]; then
    printf '%s\n' "$1/.tap/team-registry.json"
  else
    printf '%s\n' "$1/.tap/bus/registry.json"
  fi
}

team_created_at() {
  python3 -B - "$1" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["team"]["created_at"])
PY
}

team_json() {
  python3 -B - "$1" <<'PY'
import json, sys
reg = json.load(open(sys.argv[1]))
print(json.dumps(reg["team"], sort_keys=True, separators=(",", ":")))
PY
}

assert_json_valid() {
  python3 -m json.tool "$1" >/dev/null
}

# 1. Fresh git repo: init creates the dotdir bus, self-gitignore, and stable team block.
REPO="$WORK/team-api"
mkdir -p "$REPO"
git -C "$REPO" init -q
out="$(cd "$REPO" && env -u TAP_HOME "$TAP" init 2>&1)" || {
  echo "init-idempotent: (1) tap init failed in fresh repo" >&2; echo "$out" >&2; exit 1; }
[ -d "$REPO/.tap/bus/payloads" ] && [ -d "$REPO/.tap/bus/receipts" ] \
  || { echo "init-idempotent: (1) .tap/bus dirs missing" >&2; exit 1; }
grep -qx 'bus/' "$REPO/.tap/.gitignore" \
  || { echo "init-idempotent: (1) .tap/.gitignore missing bus/"; cat "$REPO/.tap/.gitignore"; exit 1; }
CANON_REPO="$(cd "$REPO" && pwd -P)"
python3 -B - "$(acting_registry "$REPO")" "$CANON_REPO" <<'PY'
import json, sys
reg = json.load(open(sys.argv[1]))
team = reg.get("team") or {}
assert team["name"] == "team-api"
assert team["worktree_root"] == sys.argv[2]
assert team["schema_version"] == "1"
assert team["branch_at_bootstrap"]
assert team["created_at"]
# "seats" post-flip, "agents" pre-flip; the subject is an EMPTY roster either way.
assert (reg.get("seats") if "seats" in reg else reg.get("agents")) == {}
PY
first_created="$(team_created_at "$(acting_registry "$REPO")")"
out="$(cd "$REPO" && env -u TAP_HOME "$TAP" init 2>&1)" || {
  echo "init-idempotent: (1) second tap init failed" >&2; echo "$out" >&2; exit 1; }
second_created="$(team_created_at "$(acting_registry "$REPO")")"
[ "$first_created" = "$second_created" ] \
  || { echo "init-idempotent: (1) init changed team created_at" >&2; exit 1; }
echo "init-idempotent: 1/4 - init creates stable dotdir team state: ok"

# 2. register-first (offline) then init and init-first then register converge on the
# same team block bytes. Offline avoids tmux while still using register's bootstrap.
R1="$WORK/register-first"; R2="$WORK/init-first"
mkdir -p "$R1" "$R2"
git -C "$R1" init -q
git -C "$R2" init -q
(cd "$R1" && tap_smoke_quiet env -u TAP_HOME "$TAP" register codex --offline)
r1_before="$(team_json "$(acting_registry "$R1")")"
(cd "$R1" && env -u TAP_HOME "$TAP" init >/dev/null)
r1_after="$(team_json "$(acting_registry "$R1")")"
(cd "$R2" && env -u TAP_HOME "$TAP" init >/dev/null)
r2_before="$(team_json "$(acting_registry "$R2")")"
(cd "$R2" && tap_smoke_quiet env -u TAP_HOME "$TAP" register codex --offline)
r2_after="$(team_json "$(acting_registry "$R2")")"
[ "$r1_before" = "$r1_after" ] \
  || { echo "init-idempotent: (2) init changed register-created team block" >&2; exit 1; }
[ "$r2_before" = "$r2_after" ] \
  || { echo "init-idempotent: (2) register changed init-created team block" >&2; exit 1; }
t1="$r1_after"
t2="$r2_after"
case "$t1" in *'"name":"register-first"'*) ;; *) echo "init-idempotent: (2) first team name wrong: $t1" >&2; exit 1 ;; esac
case "$t2" in *'"name":"init-first"'*) ;; *) echo "init-idempotent: (2) second team name wrong: $t2" >&2; exit 1 ;; esac
python3 -B - "$(acting_registry "$R1")" "$(acting_registry "$R2")" <<'PY'
import json, sys
for path in sys.argv[1:]:
    reg = json.load(open(path))
    assert reg["team"]["schema_version"] == "1"
    assert "created_at" in reg["team"]
    assert "seats" in reg or "agents" in reg
PY
echo "init-idempotent: 2/4 - init/register team bootstrap converges: ok"

# 3. setup --yes does not plant a repo-level TAP advisory (tap-hj72 / tap-pkoq).
# Both directions: an existing settings file keeps keep-me and unrelated keys
# and must not gain tap-advisory.sh; an absent file stays absent.
SETUP="$WORK/setup"
mkdir -p "$SETUP/.claude"
git -C "$SETUP" init -q
cat > "$SETUP/AGENTS.md" <<'MD'
# Local Instructions

Keep this line.
MD
cat > "$SETUP/.claude/settings.json" <<'JSON'
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
  },
  "unrelated": true
}
JSON
export TAP_CLAUDE_HOME="$WORK/empty-claude"
(cd "$SETUP" && env -u TAP_HOME "$TAP" setup --yes >/dev/null)
(cd "$SETUP" && env -u TAP_HOME "$TAP" setup --yes >/dev/null)
[ "$(grep -c '<!-- TAP:BEGIN -->' "$SETUP/AGENTS.md")" = 1 ] \
  || { echo "init-idempotent: (3) AGENTS TAP section duplicated" >&2; cat "$SETUP/AGENTS.md" >&2; exit 1; }
grep -q 'Keep this line.' "$SETUP/AGENTS.md" \
  || { echo "init-idempotent: (3) AGENTS existing content lost" >&2; exit 1; }
[ -f "$SETUP/.tap/config" ] || { echo "init-idempotent: (3) .tap/config missing" >&2; exit 1; }
assert_json_valid "$SETUP/.claude/settings.json"
python3 -B - "$SETUP/.claude/settings.json" <<'PY'
import json, sys
settings = json.load(open(sys.argv[1]))
commands = []
for entry in settings.get("hooks", {}).get("SessionStart", []):
    for hook in entry.get("hooks", []):
        commands.append(hook.get("command", ""))
assert "echo keep-me" in commands
assert not any("tap-advisory.sh" in cmd for cmd in commands)
assert settings.get("unrelated") is True
PY

ABSENT="$WORK/setup-absent"
mkdir -p "$ABSENT"
git -C "$ABSENT" init -q
(cd "$ABSENT" && env -u TAP_HOME "$TAP" setup --yes >/dev/null)
[ ! -e "$ABSENT/.claude/settings.json" ] \
  || { echo "init-idempotent: (3) setup --yes created absent .claude/settings.json" >&2; exit 1; }
[ ! -d "$ABSENT/.claude" ] \
  || { echo "init-idempotent: (3) setup --yes created .claude/ for an absent settings file" >&2; exit 1; }

STRIP="$WORK/setup-strip"
mkdir -p "$STRIP/.claude"
git -C "$STRIP" init -q
cat > "$STRIP/.claude/settings.json" <<'JSON'
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo keep-me"
          },
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/hooks/tap-advisory.sh"
          }
        ]
      }
    ]
  },
  "unrelated": true
}
JSON
(cd "$STRIP" && env -u TAP_HOME "$TAP" setup --yes >/dev/null)
assert_json_valid "$STRIP/.claude/settings.json"
python3 -B - "$STRIP/.claude/settings.json" <<'PY'
import json, sys
settings = json.load(open(sys.argv[1]))
commands = []
for entry in settings.get("hooks", {}).get("SessionStart", []):
    for hook in entry.get("hooks", []):
        commands.append(hook.get("command", ""))
assert "echo keep-me" in commands
assert not any("tap-advisory.sh" in cmd for cmd in commands)
assert settings.get("unrelated") is True
PY
echo "init-idempotent: 3/4 - setup --yes does not plant a repo-level TAP advisory: ok"

# 4. Non-git directories initialize only on consent: refused without --yes
#    (nothing written), then anchored to pwd and enrolled with --yes.
NONGIT="$WORK/no-git"
mkdir -p "$NONGIT"
rc=0; out="$(cd "$NONGIT" && env -u TAP_HOME "$TAP" init </dev/null 2>&1)" || rc=$?
[ "$rc" = 1 ] || { echo "init-idempotent: (4) non-git init without --yes must refuse (rc=$rc)" >&2; echo "$out" >&2; exit 1; }
grep -q "next: run tap init --yes in " <<<"$out" \
  || { echo "init-idempotent: (4) refusal must name tap init --yes" >&2; echo "$out" >&2; exit 1; }
[ ! -e "$NONGIT/.tap" ] || { echo "init-idempotent: (4) refused non-git init wrote .tap" >&2; exit 1; }
out="$(cd "$NONGIT" && env -u TAP_HOME "$TAP" init --yes --no-trust-folders 2>&1)" || {
  echo "init-idempotent: (4) non-git init --yes failed" >&2; echo "$out" >&2; exit 1; }
grep -q "is not a git repository; initializing TAP here anyway" <<<"$out" \
  || { echo "init-idempotent: (4) missing non-git warning" >&2; echo "$out" >&2; exit 1; }
[ -d "$NONGIT/.tap/bus/payloads" ] || { echo "init-idempotent: (4) non-git bus missing" >&2; exit 1; }
[ -f "$NONGIT/.tap/team-registry.json" ] || { echo "init-idempotent: (4) non-git team registry missing" >&2; exit 1; }
echo "init-idempotent: 4/4 - non-git init needs consent, then anchors to pwd: ok"

echo "init-idempotent: ok"
