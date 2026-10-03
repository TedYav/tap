#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# socket-unreachable-no-suspend.test.sh — tap-o4ae: unreachable tmux must
# NOT false-suspend a registry seat. A dead socket is not a dead pane.
# Fail-closed: missing binary, connect errors, AND any nonempty probe stderr
# all refuse the pane_gone write. Empty stderr is not reachability evidence.
# Registry protocol part-08: observation failure never proves absence or exit.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/helpers.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TAP_HOME="$WORK/bus" TAP_INDEX_HOME="$WORK/index"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$TAP_HOME/spool"
# Register only through an enrolled current-format team (the old-store door).
TEAM_ROOT="$WORK/demo"; mkdir -p "$TEAM_ROOT"; TEAM_ROOT="$(cd "$TEAM_ROOT" && pwd -P)"
git -C "$TEAM_ROOT" init -q
tap_smoke_enroll_current "$TEAM_ROOT" "$TAP_HOME" demo
cd "$TEAM_ROOT"

seed_alice() {
  (
    "$TAP" register bob --delivery poll >/dev/null
  )
  python3 -B - "$TAP_HOME/registry.json" <<'PY'
import json, sys
path = sys.argv[1]
reg = json.load(open(path))
reg.setdefault("seats", {})["alice"] = {
    "status": "active",
    "delivery": "pane",
    "pane": "demo/alice:0.0",
    "pane_id": "%901",
    # Arm (5)'s positive control reports this server generation (123:456), so the
    # row is stamped with it and absence is proven on the same server.
    "server_epoch": "srv:123:456",
    "harness": "codex",
}
with open(path, "w") as fh:
    json.dump(reg, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY
}

assert_refused_no_suspend() {
  local label="$1" rc="$2" out="$3"
  python3 -B - "$TAP_HOME/registry.json" "$rc" "$out" "$label" <<'PY'
import json, sys, re
agents = json.load(open(sys.argv[1]))["seats"]
rc = int(sys.argv[2])
out = sys.argv[3]
label = sys.argv[4]
alice = agents["alice"]
assert alice.get("status") == "active", (label, "false-suspended", alice)
assert not alice.get("status_reason"), (label, alice)
assert rc == 1, (label, rc, out)
assert re.search(r'tmux_unreachable', out), (label, out)
print(f"socket-unreachable-no-suspend: {label} refuses pane_gone write: ok")
PY
}

# --- (1) Exact leak shape: synthetic socket, real tmux binary. ----------
# Socket must live inside TMUX_TMPDIR (suite sandbox) so the isolation guard
# does not classify a path outside the sandbox as tmux-escape.
seed_alice
before="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["seats"]["alice"]["status"])' "$TAP_HOME/registry.json")"
[ "$before" = active ] || { echo "socket-unreachable: fixture alice not active" >&2; exit 1; }
DEAD_SOCK="${TMUX_TMPDIR:-$WORK}/dead.sock"
mkdir -p "$(dirname "$DEAD_SOCK")"
rm -f "$DEAD_SOCK"

set +e
out="$(
  TMUX="$DEAD_SOCK" "$TAP" send alice -m "o4ae probe" --from bob --json 2>&1
)"
rc=$?
set -e
assert_refused_no_suspend "TMUX=sandbox-dead-socket" "$rc" "$out"

# --- (2) Missing tmux binary: shadow tmux, leave PATH unchanged. -------------
python3 -B - "$TAP_HOME/registry.json" <<'PY'
import json, sys
path = sys.argv[1]
reg = json.load(open(path))
reg["seats"]["alice"]["status"] = "active"
reg["seats"]["alice"].pop("status_reason", None)
with open(path, "w") as fh:
    json.dump(reg, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY
# Native tmux calls spawn a binary; a Bash-exported function never reaches them.
FAKE_BIN="$WORK/fake-bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
printf '%s\n' 'tmux: command not found' >&2
exit 127
TMUX
chmod +x "$FAKE_BIN/tmux"
set +e
out="$(PATH="$FAKE_BIN:$PATH" "$TAP" send alice -m "missing tmux" --from bob --json 2>&1)"
rc=$?
set -e
assert_refused_no_suspend "missing-tmux" "$rc" "$out"

# --- (3) Arbitrary nonempty probe stderr (not a known connect literal). ------
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
# Fail every display-message with a custom nonempty stderr — must still refuse.
if [ "${1:-}" = "display-message" ]; then
  echo "weird backend glitch: protocol v99" >&2
  exit 1
fi
exit 1
TMUX
chmod +x "$FAKE_BIN/tmux"
python3 -B - "$TAP_HOME/registry.json" <<'PY'
import json, sys
path = sys.argv[1]
reg = json.load(open(path))
reg["seats"]["alice"]["status"] = "active"
reg["seats"]["alice"].pop("status_reason", None)
with open(path, "w") as fh:
    json.dump(reg, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY
set +e
out="$(
  PATH="$FAKE_BIN:$PATH" TMUX=/fake/socket \
    "$TAP" send alice -m "arbitrary err" --from bob --json 2>&1
)"
rc=$?
set -e
assert_refused_no_suspend "arbitrary-nonempty-stderr" "$rc" "$out"

# --- (4) Empty-stderr server failure remains unobservable, never pane_gone.
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
# Implements -t probes; no-target display-message fails silently (empty stderr).
# No server identity was observed, so this cannot prove a dead target.
cmd="${1:-}"; shift || true
case "$cmd" in
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -p) shift ;;
        -t) target="${2:-}"; shift 2 ;;
        *)  fmt="$1"; shift ;;
      esac
    done
    if [ -z "$target" ]; then
      exit 1   # empty stderr still supplies no server identity
    fi
    case "$fmt" in
      *pane_id*) exit 1 ;;  # dead target
      *) echo ""; exit 0 ;;
    esac ;;
  *) exit 1 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
python3 -B - "$TAP_HOME/registry.json" <<'PY'
import json, sys
path = sys.argv[1]
reg = json.load(open(path))
reg["seats"]["alice"]["status"] = "active"
reg["seats"]["alice"].pop("status_reason", None)
with open(path, "w") as fh:
    json.dump(reg, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY
set +e
out="$(
  PATH="$FAKE_BIN:$PATH" TMUX=/fake/socket \
    "$TAP" send alice -m "dead pane mock" --from bob --json 2>&1
)"
rc=$?
set -e
assert_refused_no_suspend "empty-stderr-server-failure" "$rc" "$out"

# --- (5) Positive control: readable current server plus positively absent pane.
# Registry protocol part-08/11 retain pane_gone suspension. Only the mock
# reachability exception is retired. Empty successful pane expansion is absence.
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
case "$*" in
  *'#{pid}:#{start_time}'*) printf '123:456\n' ;;
  *'#{pane_id}'*) printf '\t\t\t\t\n' ;;
  *) exit 1 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
set +e
out="$(PATH="$FAKE_BIN:$PATH" "$TAP" send alice -m "known dead pane" --from bob --json 2>&1)"
rc=$?
set -e
python3 -B - "$TAP_HOME/registry.json" "$rc" "$out" <<'PY'
import json, sys
alice = json.load(open(sys.argv[1]))["seats"]["alice"]
assert alice.get("status") == "suspended", alice
assert alice.get("status_reason") == "pane_gone", alice
assert int(sys.argv[2]) == 3, (sys.argv[2], sys.argv[3])
assert 'pane_gone' in sys.argv[3], sys.argv[3]
print("socket-unreachable-no-suspend: observed dead pane still suspends: ok")
PY

# Sourcing this file must refuse (isolation hygiene).
set +e
# tap-52ys: derive this file's own path rather than naming its directory. The
# hardcoded skills/tap/scripts/smoke/... path broke the moment the file moved to
# regress/ — a self-referential test must not encode which bucket it lives in.
source_out="$(bash -c 'source "$1"' _ "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")" 2>&1)"
source_rc=$?
set -e
[ "$source_rc" -ne 0 ] || { echo "socket-unreachable: sourced smoke should refuse" >&2; exit 1; }
[[ "$source_out" == *"do not source"* ]] \
  || { echo "socket-unreachable: source refusal missing (got: $source_out)" >&2; exit 1; }

echo "socket-unreachable-no-suspend: ok"
