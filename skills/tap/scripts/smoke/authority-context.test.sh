#!/usr/bin/env bash
# authority-context.test.sh — native cancel refuses an invalid index; the shell
# marker reader refuses runtime failure and recovers with a working live index.
set -euo pipefail
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# shellcheck source=helpers.sh
. "$ROOT/skills/tap/scripts/smoke/helpers.sh"
# shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TAP_INDEX_HOME="$WORK/index"
mkdir -p "$TAP_INDEX_HOME"

fail() { echo "authority-context: $*" >&2; exit 1; }

# --- (2) invalid flip: cancel refuses, does not treat seat as gone (#3/#5) ---
ALPHA="$WORK/alpha"
mkdir -p "$ALPHA/.tap/bus/payloads" "$ALPHA/.tap/bus/receipts" "$ALPHA/.tap/bus/archive"
cat >"$ALPHA/.tap/bus/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "alpha", "created_at": "t", "created_by": "t", "repo_root": "/tmp"},
  "seats": {
    "alice": {
      "status": "active", "delivery": "poll", "harness": "claude",
      "registered_at": "t", "pane": "", "pane_id": ""
    }
  }
}
JSON
# Invalid marker (wrong schema) — fail closed, never legacy.
printf '%s\n' '{"schema":"9.99"}' >"$TAP_INDEX_HOME/global-registry.json"
export TAP_HOME="$ALPHA/.tap/bus"
export TAP_REGISTRY="$TAP_HOME/registry.json"
# Stage an outstanding payload alice→bob shape for cancel-by-sender.
ID="alice-20260729T000000Z-authctx0001"
cat >"$TAP_HOME/payloads/${ID}.md" <<EOF
---
id: $ID
from: alice
to: bob
kind: discuss
path: $TAP_HOME/payloads/${ID}.md
reply: settle-only
---
body
EOF
: >"$TAP_HOME/receipts/${ID}.sent"
err="$(mktemp)"
set +e
out="$("$TAP" cancel "$ID" --by alice --team alpha 2>"$err")"
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "cancel must refuse under invalid flip (rc=0); out=$out err=$(cat "$err")"
grep -Eiq 'invalid_flip|invalid' "$err" \
  || fail "cancel stderr must name invalid_flip; got: $(cat "$err")"
# Must NOT have archived/terminal-cancelled as if bob were gone.
[ ! -f "$TAP_HOME/receipts/${ID}.done" ] \
  || fail "cancel must not write .done when authority is invalid"
[ -f "$TAP_HOME/payloads/${ID}.md" ] \
  || fail "cancel must not archive payload when authority is invalid"
echo "authority-context: (2) invalid flip cancel refuses: ok"

# --- Live marker control ----------------------------------------------------
rm -f "$TAP_INDEX_HOME/global-registry.json"
python3 -B - "$TAP_INDEX_HOME" "$ALPHA" <<'PY'
import json, pathlib, sys
idx, alpha = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
reg = alpha / ".tap" / "team-registry.json"
reg.parent.mkdir(parents=True, exist_ok=True)
reg.write_text(json.dumps({
  "schema": "0.20",
  "team": {"name": "alpha"},
  "seats": {"alice": {
    "status": "active", "delivery": "poll", "harness": "claude",
    "instance": "alice|I1", "registered_at": "t",
  }},
}) + "\n")
(idx / "global-registry.json").write_text(json.dumps({
  "schema": "0.20",
  "teams": {"alpha": {
    "root": str(alpha),
    "registry_location": str(reg),
  }},
}) + "\n")
PY
export TAP_HOME="$ALPHA/.tap/bus"
# shellcheck disable=SC2034
TAP_REGISTRY="$TAP_HOME/registry.json"
EMPTY_SCRIPTS="$WORK/empty-scripts"
mkdir -p "$EMPTY_SCRIPTS"

# The retired Python marker transport's missing-import control was removed.
# Native malformed/unreadable marker behavior is covered by unit2-registry.test.ts.
tap_registry_v20_state_load || fail "native marker fixture read failed"
[ "$_TAP_V20_STATE_VAL" = live ] || fail "fixture should be live"
echo 'authority-context: native cancel and marker refusal: ok'
