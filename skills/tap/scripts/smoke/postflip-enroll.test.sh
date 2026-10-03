#!/usr/bin/env bash
# postflip-enroll.test.sh — tap-nvtx: first post-flip tap-in enrolls into
# global-registry.json (registry_location stamped) and must NOT recreate
# retired teams.json.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# shellcheck source=helpers.sh
. "$ROOT/skills/tap/scripts/smoke/helpers.sh"
# shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"

WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
export TAP_INDEX_HOME="$WORK/index"
export PATH="$FAKE_BIN:$PATH"
export TMUX="/fake/tmux/socket"
mkdir -p "$TAP_INDEX_HOME" "$FAKE_BIN"

fail() { echo "postflip-enroll: $*" >&2; exit 1; }

cat >"$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; shift || true
case "$cmd" in
  display-message)
    fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    case "$fmt" in
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*pane_tty*session_name*) printf '%s\t/dev/faketty\t%s\t%s\n' "%201" "newbie/alice" "901:201" ;;
      *pane_id*session_name*pid*start_time*|*pane_id*session_name*pid*)
        printf '%s\t%s\t%s\n' "%201" "newbie/alice" "901:201" ;;
      *pane_id*session_name*) printf '%s\t%s\n' "%201" "newbie/alice" ;;
      *pane_id*) echo "%201" ;;
      *session_name*) echo "newbie/alice" ;;
      *pid*start_time*) echo "901:201" ;;
      *pane_pid*) echo "4242" ;;
      *pane_in_mode*) echo "0" ;;
      *pane_current_command*) echo "claude" ;;
      *pane_current_path*) echo "${FAKE_TMUX_PATH:-/tmp}" ;;
      *) echo "" ;;
    esac ;;
  has-session) exit 0 ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

TEAM="$WORK/newbie"
mkdir -p "$TEAM/.tap/bus/payloads" "$TEAM/.tap/bus/receipts"
# Register resolves the bus from a git worktree root — seed a minimal repo.
git -C "$TEAM" init -q
git -C "$TEAM" config user.email "tap@test"
git -C "$TEAM" config user.name "tap"
git -C "$TEAM" commit --allow-empty -qm init >/dev/null
FAKE_TMUX_PATH="$(cd "$TEAM" && pwd -P)"
export FAKE_TMUX_PATH
export TAP_HOME="$TEAM/.tap/bus"

# Flip live with EMPTY teams map — the enroll hole.
python3 -B - "$TAP_INDEX_HOME/global-registry.json" <<'PY'
import json, os, sys, time
gpath = sys.argv[1]
os.makedirs(os.path.dirname(gpath), exist_ok=True)
json.dump({
  "schema": "0.20",
  "migrated": {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "backups": {}},
  "teams": {},
}, open(gpath, "w"), indent=2)
open(gpath, "a").write("\n")
PY

tap_registry_v20_live || fail "fixture flip should be live"
[ ! -f "$TAP_INDEX_HOME/teams.json" ] || fail "fixture must not start with teams.json"

# First post-flip register from INSIDE the worktree (no --team): the enroll
# hole is exactly "new worktree not yet in global-registry".
(
  cd "$TEAM"
  unset TAP_HOME
  tap_smoke_quiet "$TAP" in alice --delivery poll
) || fail "tap in alice (from worktree) failed"

[ ! -f "$TAP_INDEX_HOME/teams.json" ] \
  || fail "post-flip enroll must NOT recreate retired teams.json"

python3 -B - "$TAP_INDEX_HOME/global-registry.json" "$FAKE_TMUX_PATH" <<'PY'
import json, os, sys
gpath, root = sys.argv[1:3]
data = json.load(open(gpath))
assert data.get("schema") == "0.20", data
ent = (data.get("teams") or {}).get("newbie")
assert isinstance(ent, dict), data
assert os.path.realpath(ent.get("root") or "") == os.path.realpath(root), ent
loc = ent.get("registry_location") or ""
assert loc, ent
assert os.path.isfile(loc), loc
assert ent.get("state", "registered") == "registered", ent
print("ok", loc)
PY

echo "postflip-enroll: first post-flip tap-in enrolls global-registry, no teams.json: ok"

# --- tap-28lj / sol 092241: alias != worktree basename + unreachable location ---
# Enrolled team name differs from basename($WORKTREE). Basename-only lookup
# would report missing and allow empty bootstrap wipe; rebind-team lookup must
# see unreachable and refuse.
ALIAS_ROOT="$WORK/workdir-basename"
mkdir -p "$ALIAS_ROOT/.tap/bus/payloads" "$ALIAS_ROOT/.tap/bus/receipts"
git -C "$ALIAS_ROOT" init -q
git -C "$ALIAS_ROOT" config user.email "tap@test"
git -C "$ALIAS_ROOT" config user.name "tap"
git -C "$ALIAS_ROOT" commit --allow-empty -qm init >/dev/null
ALIAS_PHYS="$(cd "$ALIAS_ROOT" && pwd -P)"
MISSING_LOC="$WORK/vanished/team-registry.json"
python3 -B - "$TAP_INDEX_HOME/global-registry.json" "$ALIAS_PHYS" "$MISSING_LOC" <<'PY'
import json, os, sys, time
gpath, root, loc = sys.argv[1:4]
data = json.load(open(gpath))
data["teams"]["alias-team"] = {
    "root": root,
    "registry_location": loc,
    "state": "registered",
}
json.dump(data, open(gpath, "w"), indent=2)
open(gpath, "a").write("\n")
PY
# Ensure the location is truly missing
[ ! -e "$MISSING_LOC" ] || fail "fixture: vanished location must not exist"

rc=0
out="$(
  cd "$ALIAS_ROOT"
  unset TAP_HOME
  "$TAP" in scout --team alias-team --delivery poll 2>&1
)" || rc=$?
[ "$rc" -ne 0 ] || fail "alias!=basename unreachable must refuse bootstrap (rc=0): $out"
grep -q 'refusing empty bootstrap wipe' <<<"$out" \
  || fail "alias!=basename unreachable must name empty-bootstrap refuse: $out"
# Must not have invented a seats doc at the canonical acting path as a wipe
[ ! -f "$ALIAS_ROOT/.tap/team-registry.json" ] \
  || fail "alias!=basename unreachable must not create empty team-registry.json"
echo "postflip-enroll: alias!=basename unreachable refuses empty bootstrap: ok"

echo "postflip-enroll: ok"
