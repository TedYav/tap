#!/usr/bin/env bash
# lifecycle-acting-registry.test.sh — tap-vpwp: tap in / tap out see seats-first
# team-registry.json through the acting registry (not the bus decoy).
#
# Dual-axis fixture (same shape as registry-acting-readers):
#   resolve — stored registry_location = team-registry.json
#   map     — seats ONLY on that file; bus registry.json is agents-only WRONG
#
# Cases:
#   (1) tap out sees the seats-only handle (must not report "not registered")
#   (2) tap in --delivery poll rebinds an existing seats-only handle in place
#   (3) half-migration bait: ambient bus still wrong after (1)/(2)
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
. "$ROOT/skills/tap/scripts/smoke/native-authority-fixture.sh"

WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
export TAP_INDEX_HOME="$WORK/index"
export PATH="$FAKE_BIN:$PATH"
export TMUX="/fake/tmux/socket"
mkdir -p "$TAP_INDEX_HOME" "$FAKE_BIN"

fail() { echo "lifecycle-acting-registry: $*" >&2; exit 1; }

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
    # Combined observe format must win before bare *pane_id* (tap_pane_observe).
    case "$fmt" in
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*pane_tty*session_name*) printf '%s\t/dev/faketty\t%s\t%s\n' "%101" "alpha/alice" "900:200" ;;
      *pane_id*session_name*pid*start_time*|*pane_id*session_name*pid*)
        printf '%s\t%s\t%s\n' "%101" "alpha/alice" "900:200" ;;
      *pane_id*session_name*) printf '%s\t%s\n' "%101" "alpha/alice" ;;
      *pane_id*) echo "%101" ;;
      *session_name*) echo "alpha/alice" ;;
      *pid*start_time*) echo "900:200" ;;
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

TEAM="$WORK/alpha"
mkdir -p "$TEAM/.tap/bus/payloads" "$TEAM/.tap/bus/receipts" "$TEAM/.tap/team-history"
# Physical path — macOS /var → /private/var; register compares pane cwd to worktree.
FAKE_TMUX_PATH="$(cd "$TEAM" && pwd -P)"
export FAKE_TMUX_PATH

# Decoy ambient bus — agents-only, WRONG (alice absent / different instance).
cat >"$TEAM/.tap/bus/registry.json" <<JSON
{
  "schema": "0.20", "team": { "name": "alpha", "worktree_root": "$TEAM" },
  "seats": {
    "decoy": {
      "status": "active", "delivery": "poll", "harness": "claude",
      "instance": "decoy|WRONG"
    }
  }
}
JSON

# Canonical post-flip store — seats ONLY.
cat >"$TEAM/.tap/team-registry.json" <<JSON
{
  "schema": "0.20",
  "team": { "name": "alpha", "worktree_root": "$TEAM" },
  "seats": {
    "alice": {
      "status": "active", "delivery": "poll", "harness": "claude",
      "instance": "alice|REAL",
      "server_epoch": "srv:900:200"
    }
  }
}
JSON

python3 - "$TAP_INDEX_HOME/global-registry.json" "$TEAM" <<'PY'
import json, os, sys, time
gpath, root = sys.argv[1:3]
os.makedirs(os.path.dirname(gpath), exist_ok=True)
json.dump({
  "schema": "0.20",
  "migrated": {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "backups": {}},
  "teams": {
    "alpha": {
      "root": root,
      "registry_location": root + "/.tap/team-registry.json",
      "state": "registered",
    },
  },
}, open(gpath, "w"), indent=2)
open(gpath, "a").write("\n")
PY

export TAP_HOME="$TEAM/.tap/bus"
tap_registry_v20_live || fail "flip should be live"
[ "$(acting_registry_fixture alpha)" = "$TEAM/.tap/team-registry.json" ] \
  || fail "acting registry must be team-registry (got: $(acting_registry_fixture alpha || true))"


# ── tap-52ys: 3 of 6 arms removed (ratified 2026-08-14) ─────────────────────
# The class is a lifecycle verb reading a BUS DECOY instead of the acting
# registry (tap-vpwp). Three arms hold it: tap out sees the seats-only store,
# tap in rebinds into it, and whoami/self-resolve rebinds past a retired bus
# registry.json.
#
# Accepted gap, named: the half-migration decoy bait (3) and the two custom
# pane-bound handle paths (4, 5).

# --- (1) tap out sees seats-only alice ---------------------------------------
# unregister has no --team; cwd + index enrollment resolve the acting registry.
rc=0
out="$(cd "$TEAM" && env -u TAP_HOME TAP_INDEX_HOME="$TAP_INDEX_HOME" \
  "$TAP" out alice 2>&1)" || rc=$?
# poll seats: out without --kill should remove the seat (or at least SEE it).
# The pre-fix defect reported "not registered" against the bus decoy.
grep -qi 'not registered' <<<"$out" \
  && fail "(1) tap out must see seats-only alice, not report not registered (out=$out)"
case "$rc" in
  0) ;;
  *) fail "(1) tap out alice should succeed (rc=$rc out=$out)" ;;
esac
python3 - "$TEAM/.tap/team-registry.json" <<'PY'
import json, sys
reg = json.load(open(sys.argv[1]))
seats = reg.get("seats") or {}
if "alice" in seats:
    raise SystemExit("lifecycle-acting-registry: (1) alice still in team-registry seats after tap out")
if "agents" in reg:
    raise SystemExit(f"lifecycle-acting-registry: (1) tap out wrote an agents axis: {sorted(reg)}")
PY
# Bus decoy must still be untouched (resolve-axis proof).
python3 - "$TEAM/.tap/bus/registry.json" <<'PY'
import json, sys
reg = json.load(open(sys.argv[1]))
agents = reg.get("seats") or {}
if "decoy" not in agents:
    raise SystemExit("lifecycle-acting-registry: (1) bus decoy was mutated")
if "alice" in agents:
    raise SystemExit("lifecycle-acting-registry: (1) alice written into bus decoy")
PY
echo "lifecycle-acting-registry: (1) tap out sees seats-only alice: ok"


# --- (2) tap in poll rebinds into seats-only store ---------------------------
# Re-seed alice for the in path.
python3 - "$TEAM/.tap/team-registry.json" <<'PY'
import json, sys
path = sys.argv[1]
reg = json.load(open(path))
reg.setdefault("seats", {})["alice"] = {
    "status": "active", "delivery": "poll", "harness": "claude",
    "instance": "alice|REAL", "server_epoch": "srv:900:200",
}
json.dump(reg, open(path, "w"), indent=2)
open(path, "a").write("\n")
PY

rc=0
out="$(cd "$TEAM" && env -u TAP_HOME TAP_INDEX_HOME="$TAP_INDEX_HOME" \
  "$TAP" in alice --delivery poll --team alpha --unattended 2>&1)" || rc=$?
case "$rc" in
  0) ;;
  *) fail "(2) tap in alice poll should succeed (rc=$rc out=$out)" ;;
esac
python3 - "$TEAM/.tap/team-registry.json" <<'PY'
import json, sys
reg = json.load(open(sys.argv[1]))
seats = reg.get("seats") or {}
alice = seats.get("alice")
if not isinstance(alice, dict):
    raise SystemExit("lifecycle-acting-registry: (2) alice missing from seats after tap in")
if alice.get("delivery") != "poll":
    raise SystemExit(f"lifecycle-acting-registry: (2) delivery={alice.get('delivery')!r}")
if alice.get("status") != "active":
    raise SystemExit(f"lifecycle-acting-registry: (2) status={alice.get('status')!r}")
# Instance must survive rebind (case 1) when flip-live minting is on.
if alice.get("instance") != "alice|REAL":
    raise SystemExit(f"lifecycle-acting-registry: (2) instance mutated: {alice.get('instance')!r}")
PY
python3 - "$TEAM/.tap/bus/registry.json" <<'PY'
import json, sys
reg = json.load(open(sys.argv[1]))
agents = reg.get("seats") or {}
if "alice" in agents:
    raise SystemExit("lifecycle-acting-registry: (2) tap in wrote alice into bus decoy")
if "decoy" not in agents:
    raise SystemExit("lifecycle-acting-registry: (2) bus decoy lost decoy row")
PY
echo "lifecycle-acting-registry: (2) tap in rebinds seats-only alice: ok"


# --- (6) whoami / self-resolve rebinds past a retired bus registry.json ------
# Codex P1 @ lib.sh:3550 — early `[ -f "$TAP_REGISTRY" ]` must not short-circuit
# before acting-registry rebind. Re-seed alice-2 on the fake pane (%101 /
# srv:900:200), remove the bus decoy file, and require whoami to still resolve.
python3 - "$TEAM/.tap/team-registry.json" <<'PY'
import json, sys
path = sys.argv[1]
reg = json.load(open(path))
reg.setdefault("seats", {})["alice-2"] = {
    "status": "active",
    "delivery": "pane",
    "pane": "alpha/alice:0.0",
    "pane_id": "%101",
    "session": "alpha/alice",
    "harness": "claude",
    "instance": "alice-2|WHOAMI",
    "server_epoch": "srv:900:200",
}
json.dump(reg, open(path, "w"), indent=2, sort_keys=True)
open(path, "a").write("\n")
PY
rm -f "$TEAM/.tap/bus/registry.json"
whoami_out="$(cd "$TEAM" && env -u TAP_HOME TAP_INDEX_HOME="$TAP_INDEX_HOME" \
  "$TAP" whoami --pane "%101" 2>&1)" || {
  echo "lifecycle-acting-registry: (6) whoami failed with bus registry absent: $whoami_out" >&2
  exit 1
}
# tap-52ys: this assertion was TRUNCATED by the original shrink — the slice cut
# mid-statement, leaving `[ ... ] \` with its `|| fail` continuation gone. The
# arm ran, produced output, and could never fail. Caught by
# cut-banner-accounting.test.sh, which noticed the banner claimed 3 kept arms
# while the file printed 2.
[ "$whoami_out" = "alice-2" ] \
  || fail "(6) whoami must resolve alice-2 via acting registry (got: $whoami_out)"
echo "lifecycle-acting-registry: (6) whoami rebinds past retired bus registry: ok"

echo "lifecycle-acting-registry: ok"
