#!/usr/bin/env bash
# team-refresh-name-authority.test.sh — reconciliation preserves recovery rows.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
TAP_HOME="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$TAP_HOME" "$FAKE_BIN"' EXIT
export TAP_HOME PATH="$FAKE_BIN:$PATH" TAP_SESSION_MANIFEST="$TAP_HOME/sessions.json"
export TAP_SERVER_EPOCH="srv:900:100" TAP_BOOT_ID="boot:2"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"

cat >"$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
if [ -n "${FAKE_TMUX_DOWN:-}" ]; then
  echo "no server running on /fake/socket" >&2
  exit 1
fi
case "${1:-}" in
  list-sessions)
    # Race hook: refresh has already copied the registry row before it asks
    # tmux for liveness. Publish the same handle under the registry lock, as a
    # concurrent register would, and make the replacement plainly live.
    if [ -n "${REREGISTER_PATH:-}" ] && [ ! -e "${REREGISTER_PATH}.race-injected" ]; then
      : > "${REREGISTER_PATH}.race-injected"
      python3 - "$REREGISTER_PATH" <<'PY'
import fcntl, json, os, sys, tempfile
registry = sys.argv[1]
with open(registry + ".lock", "w") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    reg = json.load(open(registry))
    reg["seats"]["gone"] = {
        "status": "active", "delivery": "pane", "session": "demo/live",
        "pane": "demo/live:0.0", "pane_id": "%11", "harness": "codex",
        "server_socket": "/fake/socket", "server_epoch": "srv:900:100", "boot_id": "boot:2",
        "registered_at": "fresh-registration",
    }
    directory = os.path.dirname(registry) or "."
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tap.")
    with os.fdopen(fd, "w") as fh:
        json.dump(reg, fh, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, registry)
PY
    fi
    if [[ "$*" == *'start_time'* ]]; then
      printf 'demo/live\t900:100\n'
      printf 'demo/rebooted\t900:100\n'
      printf 'demo/shell\t900:100\n'
      printf 'demo/rebound\t900:100\n'
    else
      printf '%s\n' demo/live demo/rebooted demo/shell demo/rebound
    fi
    ;;
  list-panes)
    shift; target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -t) target="${2#=}"; shift 2 ;;
        -F) fmt="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    if [[ "$fmt" == *'server_started'* || "$fmt" == *'start_time'* ]]; then
      case "$target" in
        demo/live)     printf 'demo/live\tdemo/live:0.0\t%%11\tcodex\t111\t900:100\t0\n' ;;
        demo/rebooted) printf 'demo/rebooted\tdemo/rebooted:0.0\t%%12\tcodex\t112\t900:100\t0\n' ;;
        demo/shell)    printf 'demo/shell\tdemo/shell:0.0\t%%13\tzsh\t113\t900:100\t0\n' ;;
        demo/rebound)  printf 'demo/rebound\tdemo/rebound:0.0\t%%99\tcodex\t199\t900:100\t0\n' ;;
        *) exit 1 ;;
      esac
    fi
    ;;
  display-message)
    shift; target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="${2#=}"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    case "$fmt" in
      *socket_path*) echo "/fake/socket" ;;
      *pane_id*)
        case "$target" in
          %11|demo/live:0.0) echo %11 ;;
          %12|demo/rebooted:0.0) echo %12 ;;
          %13|demo/shell:0.0) echo %13 ;;
          %14) echo "" ;;
          demo/rebound:0.0) echo %99 ;;
          *) echo "" ;;
        esac ;;
      *) echo "" ;;
    esac ;;
  *) : ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

cat >"$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "live": {"status": "active", "delivery": "pane", "session": "demo/live", "pane": "demo/live:0.0", "pane_id": "%11", "harness": "codex", "server_socket": "/fake/socket", "server_epoch": "srv:900:100", "boot_id": "boot:2"},
    "gone": {"status": "active", "delivery": "pane", "session": "demo/gone", "pane": "demo/gone:0.0", "pane_id": "%10", "harness": "codex", "server_socket": "/fake/socket", "server_epoch": "srv:900:100", "boot_id": "boot:2"},
    "rebooted": {"status": "active", "delivery": "pane", "session": "demo/rebooted", "pane": "demo/rebooted:0.0", "pane_id": "%12", "harness": "codex", "server_socket": "/fake/socket", "server_epoch": "srv:900:100", "boot_id": "boot:1"},
    "shell": {"status": "active", "delivery": "pane", "session": "demo/shell", "pane": "demo/shell:0.0", "pane_id": "%13", "harness": "codex", "server_socket": "/fake/socket", "server_epoch": "srv:900:100", "boot_id": "boot:2"},
    "rebound": {"status": "active", "delivery": "pane", "session": "demo/rebound", "pane": "demo/rebound:0.0", "pane_id": "%14", "harness": "codex", "server_socket": "/fake/socket", "server_epoch": "srv:900:100", "boot_id": "boot:2"}
  }
}
JSON

out="$($TAP team refresh --json)"
python3 -c '
import json, sys
d=json.loads(sys.argv[1])
assert [(x["handle"], x["reason"]) for x in d["trimmed"]] == [("gone", "session_absent")], d
kept={x["handle"]:x["reason"] for x in d["kept"]}
assert kept == {
  "live": "active",
  "rebooted": "offline:boot_id_stale",
  "shell": "offline:harness_exited",
  "rebound": "unknown:address_rebound",
}, d
' "$out"
python3 - "$TAP_HOME/registry.json" <<'PY'
import json, sys
agents=json.load(open(sys.argv[1]))["seats"]
assert "gone" not in agents, agents
assert set(agents) == {"live", "rebooted", "shell", "rebound"}, agents
# No dispatch-time rewrite (registry-unit-1-part-08): the reader judges the
# stale boot stamp, and the stored row stays an active, resumable member.
rebooted = agents["rebooted"]
assert rebooted.get("status") == "active", rebooted
assert rebooted.get("session") == "demo/rebooted", rebooted
PY
echo "team-refresh-name-authority: gone trims; offline and unknown remain recoverable: ok"

before="$(cat "$TAP_HOME/registry.json")"
out="$(FAKE_TMUX_DOWN=1 "$ROOT/bin/tap" team refresh --json)"
[ "$before" = "$(cat "$TAP_HOME/registry.json")" ] || {
  echo "team-refresh-name-authority: unobservable refresh mutated the registry" >&2; exit 1;
}
python3 -c '
import json, sys
d=json.loads(sys.argv[1])
assert d["trimmed"] == [], d
reasons={x["handle"]:x["reason"] for x in d["kept"]}
assert reasons == {h: "socket_unobservable" for h in ("live", "rebooted", "shell", "rebound")}, d
'  "$out"
echo "team-refresh-name-authority: unobservable snapshot trims and mutates nothing: ok"

# A GONE verdict belongs to the row we observed, not merely its handle. A
# concurrent register may replace that handle after the unlocked observation;
# refresh must leave the replacement live row untouched and unreported.
python3 - "$TAP_HOME/registry.json" <<'PY'
import json, sys
path = sys.argv[1]
registry = json.load(open(path))
registry["seats"]["gone"] = {
    "status": "active", "delivery": "pane", "session": "demo/gone",
    "pane": "demo/gone:0.0", "pane_id": "%10", "harness": "codex",
    "server_socket": "/fake/socket", "server_epoch": "srv:900:100", "boot_id": "boot:2",
    "registered_at": "stale-registration",
}
with open(path, "w") as fh:
    json.dump(registry, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY
race_out="$(REREGISTER_PATH="$TAP_HOME/registry.json" "$TAP" team refresh --json)"
python3 - "$TAP_HOME/registry.json" "$race_out" <<'PY'
import json, sys
agents = json.load(open(sys.argv[1]))["seats"]
trimmed = {item["handle"] for item in json.loads(sys.argv[2])["trimmed"]}
assert "gone" not in trimmed, trimmed
assert agents["gone"]["registered_at"] == "fresh-registration", agents
assert agents["gone"]["session"] == "demo/live", agents
PY
echo "team-refresh-name-authority: re-registered handle survives stale GONE decision: ok"
echo "team-refresh-name-authority: ok"
