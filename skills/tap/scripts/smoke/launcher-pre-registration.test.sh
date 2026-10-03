#!/usr/bin/env bash
# launcher-pre-registration.test.sh — launcher-owned membership is atomic and
# active/status_reason=launching is never a transport target.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"
. "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"

# These two membership guards moved out of test_launcher.py with native resume.
# Require both ports: a renamed test must not silently reduce this to one.
resume_output="$(NO_COLOR=1 bash "$ROOT/runtime/bun/test/run.sh" \
  "$ROOT/runtime/bun/test/launcher-resume.test.ts" \
  "$ROOT/runtime/bun/test/launcher-resume-records.test.ts" \
  --test-name-pattern '^(a recordless resume refuses create when the roster occupies the handle|an expired launch reservation does not occupy the handle; an unobservable tmux keeps it protected)$' 2>&1)" || {
  printf '%s\n' "$resume_output" >&2
  exit 1
}
printf '%s\n' "$resume_output"
printf '%s\n' "$resume_output" | grep -Eq '^[[:space:]]*2 pass$' || {
  echo 'launcher-pre-registration: expected both native resume membership tests to pass' >&2
  exit 1
}
bash "$ROOT/runtime/bun/test/run.sh" "$ROOT/runtime/bun/test/shared-launch-transaction.test.ts" \
  --test-name-pattern 'actual delayed|complete displaced|first harness|late zero'

TAP_HOME="$(mktemp -d)"
FAKE_BIN="$(mktemp -d)"
PAYLOAD="$(mktemp)"
trap 'rm -rf "$TAP_HOME" "$FAKE_BIN" "$PAYLOAD"' EXIT
export TAP_HOME
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"
cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "testteam"},
  "seats": {
    "sender": {"status": "active", "pane": "sender:0.0", "pane_id": "%1", "server_epoch": "srv:4242:100"},
    "scout": {
      "status": "active",
      "status_reason": "launching",
      "session": "testteam/scout",
      "pane": "testteam/scout:0.0",
      "pane_id": "%2",
      "launch_id": "launch-token",
      "cost_mode": "api",
      "include_policy": "on_request",
      "unattended": true,
      "custom_policy": "keep"
    }
  }
}
JSON
FIXTURE_ROOT="$TAP_HOME/testteam"
mkdir -p "$FIXTURE_ROOT"
git -C "$FIXTURE_ROOT" init -q
tap_smoke_enroll_current "$FIXTURE_ROOT" "$TAP_HOME"
cd "$FIXTURE_ROOT"
cat > "$PAYLOAD" <<'EOF'
---
from: sender
to: scout
kind: discuss
---

must not reach a half-started harness
EOF

rc=0
"$TAP" send scout "$PAYLOAD" --from sender --json >"$TAP_HOME/send.out" 2>/dev/null || rc="$?"
[ "$rc" = "1" ] || {
  echo "launcher-pre-registration: expected launching refusal rc=1, got $rc" >&2
  exit 1
}
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["ok"] is False and d["error_class"]=="seat_launching", d' "$TAP_HOME/send.out" || {
  echo "launcher-pre-registration: missing seat_launching refusal" >&2
  cat "$TAP_HOME/send.out" >&2
  exit 1
}
[ "$(find "$TAP_HOME/payloads" -type f | wc -l | tr -d ' ')" = "0" ] || {
  echo "launcher-pre-registration: launching refusal placed a canonical payload" >&2
  exit 1
}

# SessionStart's same-pane `tap in` is an ensure-bound fallback. It must not
# consume readiness or reset policy while the launcher still owns the token.
cat > "$FAKE_BIN/tmux" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"; shift || true
case "\$cmd" in
  display-message)
    target=""; fmt=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        -p) shift ;;
        -t) target="\$2"; shift 2 ;;
        *) fmt="\$1"; shift ;;
      esac
    done
    case "\$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%%2\\ttestteam/scout\\t4242\\tclaude\\t0\\n' ;;
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*pane_tty*session_name*) printf '%%2\\t/dev/faketty\\ttestteam/scout\\t4242:100\\n' ;;
      *pane_id*session_name*) printf '%%2\\ttestteam/scout\\n' ;;
      *pane_id*) printf '%%2\\n' ;;
      *pane_current_command*) printf 'claude\\n' ;;
      *pane_current_path*) printf '%s\\n' '$FIXTURE_ROOT' ;;
      *pid*start_time*) printf '4242:100\\n' ;;
      *socket_path*) printf '/fake/tmux\\n' ;;
      *session_name*window_index*pane_index*) printf 'testteam/scout:0.0\\n' ;;
      *) printf '\\n' ;;
    esac ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$FAKE_BIN/tmux"
PATH="$FAKE_BIN:$PATH" TMUX=/fake/tmux \
  bash "$ROOT/bin/tap" in scout --pane testteam/scout:0.0 --json >/dev/null
python3 -B - "$TAP_HOME/registry.json" <<'PY'
import json, sys
entry = json.load(open(sys.argv[1]))["seats"]["scout"]
assert entry["status"] == "active"
assert entry["status_reason"] == "launching"
assert entry["launch_id"] == "launch-token"
assert entry["cost_mode"] == "api"
assert entry["include_policy"] == "on_request"
assert entry["unattended"] is True
assert entry["custom_policy"] == "keep"
PY

echo "launcher-pre-registration: ok"
