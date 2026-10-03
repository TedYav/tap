#!/usr/bin/env bash
# tap-in-three-cases.test.sh — U3 R4 primitives (flip-gated): list-history,
# history-independent bare rejoin, and pre-flip dormancy. Pane register path uses fake tmux.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# shellcheck source=helpers.sh
. "$ROOT/skills/tap/scripts/smoke/helpers.sh"

WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
export TAP_INDEX_HOME="$WORK/index"
export TAP_HOME="$WORK/repo/.tap/bus"
export PATH="$FAKE_BIN:$PATH"
export TMUX="/fake/tmux/socket"
export FAKE_TMUX_STATE="$WORK/fake"
export FAKE_TMUX_PATH="$WORK/repo"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$WORK/fake" "$TAP_INDEX_HOME" "$WORK/repo/.tap/team-history"

fail() { echo "tap-in-three-cases: $*" >&2; exit 1; }

git init -q "$WORK/repo"
git -C "$WORK/repo" config user.email t@example.invalid
git -C "$WORK/repo" config user.name t
touch "$WORK/repo/r"; git -C "$WORK/repo" add r; git -C "$WORK/repo" commit -q -m i

cat > "$FAKE_BIN/tmux" <<'TMUX'
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
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%%901\trepo\t1\tclaude\t0\n' ;;
      *pane_id*) echo "%901" ;;
      *pane_current_command*) echo "claude" ;;
      *pane_current_path*) echo "${FAKE_TMUX_PATH:-}" ;;
      *session_name*window_index*pane_index*) echo "repo:0.0" ;;
      *pane_pid*) echo "1" ;;
      *pid*start_time*) echo "1:1" ;;
      *) echo "" ;;
    esac ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

# Flip marker + empty current registry + one tombstone for 'sol'.
cat > "$TAP_HOME/registry.json" <<JSON
{ "schema": "0.20", "team": { "name": "repo", "worktree_root": "$WORK/repo", "schema_version": "1" }, "seats": {} }
JSON
python3 - "$TAP_INDEX_HOME/global-registry.json" "$WORK/repo" <<'PY'
import json, os, sys, time
gpath, root = sys.argv[1:3]
os.makedirs(os.path.dirname(gpath), exist_ok=True)
json.dump({
  "schema": "0.20",
  "migrated": {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "backups": {}},
  "teams": {"repo": {
    "root": root,
    "registry_location": root + "/.tap/bus/registry.json",
    "state": "registered",
  }},
}, open(gpath, "w"), indent=2)
open(gpath, "a").write("\n")
PY
python3 - "$WORK/repo/.tap/team-history" <<'PY'
import json, os, sys, time
hist = sys.argv[1]
os.makedirs(hist, exist_ok=True)
row = {
  "handle": "sol",
  "instance": "sol|olddead",
  "retired_by": "evt-out-1",
  "retired_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
  "row": {"status": "active", "instance": "sol|olddead", "pane": "x", "pane_id": "%999"},
}
json.dump(row, open(os.path.join(hist, "sol.evt-out-1.ts.json"), "w"), indent=2)
open(os.path.join(hist, "sol.evt-out-1.ts.json"), "a").write("\n")
PY

# (1) --list-history --json
list_json="$(cd "$WORK/repo" && env -u TAP_HOME "$TAP" in sol --list-history --json)"
printf '%s' "$list_json" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert len(d)==1 and d[0]["instance"]=="sol|olddead", d'
echo "tap-in-three-cases: (1) list-history --json: ok"

# (2) A tombstone is provenance, not current authority. With no acting row,
# bare in starts a fresh current seat instead of requiring a history decision.
( cd "$WORK/repo" && env -u TAP_HOME "$TAP" in sol --pane fake:0.0 --override-worktree >"$WORK/fresh.out" 2>&1 ) \
  || { cat "$WORK/fresh.out"; fail "historical bare in should start fresh"; }
inst="$(python3 - "$TAP_HOME/registry.json" <<'PY'
import json, sys
print((json.load(open(sys.argv[1])).get("seats") or {}).get("sol", {}).get("instance") or "")
PY
)"
[ -n "$inst" ] || fail "fresh seat missing instance"
[ "$inst" != "sol|olddead" ] || fail "fresh must mint a NEW instance, got $inst"
echo "tap-in-three-cases: (2) historical bare in mints new instance: ok"

# (3) pre-flip list-history is empty JSON (dormant)
rm -f "$TAP_INDEX_HOME/global-registry.json"
empty="$(cd "$WORK/repo" && env -u TAP_HOME "$TAP" in sol --list-history --json)"
[ "$empty" = "[]" ] || fail "pre-flip list-history --json must be []"
echo "tap-in-three-cases: (3) pre-flip list-history dormant: ok"

echo "tap-in-three-cases: ok"
