#!/usr/bin/env bash
# admin-name-authority.test.sh — machine-wide readers consume the same exact-
# session classifier as team/attach/courier. In particular, admin refresh may
# trim only GONE: OFFLINE retains native resume provenance and UNKNOWN never
# authorizes mutation.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
export HOME="$WORK/home" TAP_INDEX_HOME="$WORK/index" PATH="$FAKE_BIN:$PATH"
mkdir -p "$HOME" "$TAP_INDEX_HOME" "$WORK/unrelated"

# The dispatcher must not reconcile a caller-local stale registry before an
# admin read, nor before a documented dry run. Both commands are explicitly
# non-mutating; admin is machine-wide and therefore must not use this cwd's
# acting-team bookkeeping at all.
LOCAL_BUS="$WORK/unrelated/.tap/bus"
mkdir -p "$LOCAL_BUS"
cat > "$LOCAL_BUS/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "Local"},
  "seats": {
    "local": {"status": "active", "delivery": "pane", "session": "Local/local", "pane": "Local/local:0.0", "pane_id": "%1", "harness": "codex", "server_epoch": "srv:100:1"}
  }
}
JSON
cp "$LOCAL_BUS/registry.json" "$WORK/local-registry.before"

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; shift || true
case "$cmd" in
  list-sessions)
    # Race hook: admin refresh has already copied the row it classified. A
    # concurrent register replaces the same handle under the registry lock.
    if [ -n "${REREGISTER_PATH:-}" ] && [ ! -e "${REREGISTER_PATH}.race-injected" ]; then
      : > "${REREGISTER_PATH}.race-injected"
      python3 - "$REREGISTER_PATH" <<'PY'
import fcntl, json, os, sys, tempfile
registry = sys.argv[1]
with open(registry + ".lock", "w") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    reg = json.load(open(registry))
    reg["seats"]["gone"] = {
        "status": "active", "delivery": "pane", "session": "Authority/live",
        "pane": "Authority/live:0.0", "pane_id": "%11", "harness": "codex",
        "server_epoch": "srv:900:100", "registered_at": "fresh-registration",
    }
    directory = os.path.dirname(registry) or "."
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tap.")
    with os.fdopen(fd, "w") as fh:
        json.dump(reg, fh, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, registry)
PY
    fi
    printf 'Authority/live\t900:100\n'
    printf 'Authority/shell\t900:100\n'
    printf 'Authority/rebound\t900:100\n'
    ;;
  has-session)
    target=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -t) target="${2#=}"; shift 2 ;; *) shift ;; esac
    done
    case "$target" in Authority/live|Authority/shell|Authority/rebound) exit 0 ;; *) exit 1 ;; esac
    ;;
  list-panes)
    target=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -t) target="${2#=}"; shift 2 ;; *) shift ;; esac
    done
    case "$target" in
      Authority/live)    printf 'Authority/live\tAuthority/live:0.0\t%%11\tcodex\t111\t900:100\t0\n' ;;
      Authority/shell)   printf 'Authority/shell\tAuthority/shell:0.0\t%%12\tzsh\t112\t900:100\t0\n' ;;
      Authority/rebound) printf 'Authority/rebound\tAuthority/rebound:0.0\t%%13\tcodex\t113\t900:100\t0\n' ;;
      *) exit 1 ;;
    esac
    ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="${2#=}"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    case "$fmt" in
      *pane_id*)
        case "$target" in
          %11|Authority/live:0.0) echo %11 ;;
          %12|Authority/shell:0.0) echo %12 ;;
          %13|Authority/rebound:0.0) echo %13 ;;
          %99|%77|Authority/stale:0.0) echo "" ;;
          *) echo "" ;;
        esac ;;
      *pane_in_mode*) echo 0 ;;
      *pane_current_command*)
        case "$target" in %12|Authority/shell:0.0) echo zsh ;; *) echo codex ;; esac ;;
      *window_activity*) echo 0 ;;
      *pane_current_path*) echo /nonexistent ;;
      *pid*start_time*) echo 900:100 ;;
      *) echo "" ;;
    esac
    ;;
  capture-pane) printf 'transcript line\n› \n' ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

TEAM_ROOT="$WORK/Authority"
BUS="$TEAM_ROOT/.tap/bus"
mkdir -p "$BUS/payloads" "$BUS/receipts"
cat > "$BUS/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "Authority"},
  "seats": {
    "active": {"status": "active", "delivery": "pane", "session": "Authority/live", "pane": "Authority/live:0.0", "pane_id": "%11", "harness": "codex", "server_epoch": "srv:900:100"},
    "gone": {"status": "active", "delivery": "pane", "session": "Authority/gone", "pane": "Authority/gone:0.0", "pane_id": "%11", "harness": "codex", "server_epoch": "srv:900:100"},
    "gone_id_only": {"status": "active", "delivery": "pane", "session": "Authority/gone-id-only", "pane_id": "%11", "harness": "codex", "server_epoch": "srv:900:100"},
    "stale": {"status": "active", "delivery": "pane", "session": "Authority/stale", "pane": "Authority/stale:0.0", "pane_id": "%77", "harness": "codex", "server_epoch": "srv:100:1", "native_session_id": "native-stale"},
    "shell": {"status": "active", "delivery": "pane", "session": "Authority/shell", "pane": "Authority/shell:0.0", "pane_id": "%12", "harness": "codex", "server_epoch": "srv:900:100", "native_session_id": "native-shell"},
    "rebound": {"status": "active", "delivery": "pane", "session": "Authority/rebound", "pane": "Authority/rebound:0.0", "pane_id": "%99", "harness": "codex", "server_epoch": "srv:900:100", "native_session_id": "native-rebound"}
  }
}
JSON
cat > "$BUS/payloads/admin-name-shell.md" <<'PAYLOAD'
---
id: admin-name-shell
from: operator
to: shell
kind: discuss
reply: expected
---
test
PAYLOAD
# Born live (F1): Authority is enrolled in the machine index.
cat > "$TAP_INDEX_HOME/global-registry.json" <<JSON
{"schema":"0.20","teams":{"Authority":{"root":"$(cd "$TEAM_ROOT" && pwd -P)","registry_location":"$(cd "$BUS" && pwd -P)/registry.json","state":"registered"}}}
JSON

set +e
(cd "$WORK/unrelated" && env -u TAP_HOME "$TAP" admin dashboard --json >/dev/null)
admin_rc=$?
set -e
[ "$admin_rc" -eq 0 ] || { echo "admin-name-authority: dashboard failed unexpectedly (rc=$admin_rc)" >&2; exit 1; }
cmp -s "$WORK/local-registry.before" "$LOCAL_BUS/registry.json" || {
  echo "admin-name-authority: dashboard reconciled the caller-local registry" >&2; exit 1; }

(cd "$WORK/unrelated" && env -u TAP_HOME "$TAP" team refresh --dry-run >/dev/null)
cmp -s "$WORK/local-registry.before" "$LOCAL_BUS/registry.json" || {
  echo "admin-name-authority: exact --dry-run reconciled the caller-local registry" >&2; exit 1; }
echo "admin-name-authority: admin and exact dry-run skip caller-local reconciliation: ok"

# Dashboard must not treat a positively exited harness as a live idle agent;
# otherwise an inbound payload creates a false attention incident.
set +e
dashboard="$(cd "$WORK/unrelated" && "$TAP" admin dashboard --json)"
dashboard_rc=$?
set -e
python3 -c '
import json, sys
d = json.loads(sys.argv[1])
assert not any(a["team"] == "Authority" and a["handle"] == "shell" for a in d["attention"]), d
assert [(a["team"], a["handle"]) for a in d["attention"]] == [("Authority", "gone"), ("Authority", "gone_id_only")], d
assert next(t for t in d["teams"] if t["name"] == "Authority")["classification"] == "active", d
' "$dashboard"
# Attention rows are reported state: the dashboard exits 0 (CLI-EXIT-0); the JSON above carries them.
[ "$dashboard_rc" -eq 0 ] || { echo "admin-name-authority: dashboard reports attention rows with exit 0 (rc=$dashboard_rc)" >&2; exit 1; }
echo "admin-name-authority: dashboard consumes harness-aware classifier: ok"

refresh="$(cd "$WORK/unrelated" && "$TAP" admin refresh --json)"
python3 -c '
import json, sys
d = json.loads(sys.argv[1])
trimmed = {(x["team"], x["handle"]): x["reason"] for x in d["trimmed"]}
assert trimmed == {
    ("Authority", "gone"): "session_absent",
    ("Authority", "gone_id_only"): "session_absent",
}, d
' "$refresh"
python3 - "$BUS/registry.json" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1]))["seats"]
assert "gone" not in rows, rows
assert "gone_id_only" not in rows, rows
for handle in ("active", "stale", "shell", "rebound"):
    assert handle in rows, (handle, rows)
assert rows["stale"]["native_session_id"] == "native-stale", rows["stale"]
assert rows["shell"]["native_session_id"] == "native-shell", rows["shell"]
assert rows["rebound"]["native_session_id"] == "native-rebound", rows["rebound"]
PY
echo "admin-name-authority: refresh trims only GONE and preserves OFFLINE/UNKNOWN recovery rows: ok"

# A stale GONE decision must not authorize deletion of a live row that a
# concurrent register published under the same handle after observation.
python3 - "$BUS/registry.json" <<'PY'
import json, sys
path = sys.argv[1]
registry = json.load(open(path))
registry["seats"]["gone"] = {
    "status": "active", "delivery": "pane", "session": "Authority/gone",
    "pane": "Authority/gone:0.0", "pane_id": "%11", "harness": "codex",
    "server_epoch": "srv:900:100", "registered_at": "stale-registration",
}
with open(path, "w") as fh:
    json.dump(registry, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY
race_refresh="$(cd "$WORK/unrelated" && REREGISTER_PATH="$BUS/registry.json" "$TAP" admin refresh --json)"
python3 - "$BUS/registry.json" "$race_refresh" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1]))["seats"]
trimmed = {(item["team"], item["handle"]) for item in json.loads(sys.argv[2])["trimmed"]}
assert ("Authority", "gone") not in trimmed, trimmed
assert rows["gone"]["registered_at"] == "fresh-registration", rows
assert rows["gone"]["session"] == "Authority/live", rows
PY
echo "admin-name-authority: re-registered handle survives stale GONE decision: ok"
