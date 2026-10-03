#!/usr/bin/env bash
# Fixture env (TMUX, PATH shims, HOME) must stay in this process. Refuse `source`.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# session-store-register.test.sh — tap-iee8 END-TO-END: a real `tap register` for an
# agy seat must write the session-store attribution the heredoc's session_store.derive()
# produces. This proves the integration hunk, not just the module (that's pytest).
# Two cases:
#   (+) ANTIGRAVITY_CONVERSATION_ID live in env -> its uuid lands in the EXISTING tier-1
#       harness_session_id (a VERIFIED in-pane capture, what the launcher's agy adoption
#       backfills from), plus the additive store_path/kind/trust fields.
#   (-) no env id -> harness_session_id stays EMPTY and trust!=env; identity is NEVER
#       inferred (fable rider r1) — a bare agy seat with no verified id falls through.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/helpers.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"; FAKE_HOME="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN" "$FAKE_HOME"' EXIT
export TAP_HOME="$WORK/bus"; mkdir -p "$TAP_HOME"
export TAP_INDEX_HOME="$WORK/index" HOME="$FAKE_HOME" PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket"
# The registered pane must sit inside the worktree (register's same-tree guard); use the
# repo root for that. HOME stays fake so the agy store path is hermetic + predictable.
export FAKE_ROOT="$ROOT"
# Registration now refuses a custom bus with no enrolled team (the old-store
# door); enroll the real repo root under this run's own machine index.
tap_smoke_enroll_current "$ROOT" "$TAP_HOME" agyteam

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; shift || true
case "$cmd" in
  list-panes)
    fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -F) fmt="$2"; shift 2 ;; -a|-s) shift ;; -t) shift 2 ;; *) shift ;; esac
    done
    case "$fmt" in
      *pane_current_command*pane_pid*) printf 'agyteam/agyseat\tagyteam/agyseat:0.0\t%%901\tagy\t4242\t123:456\t0\n' ;;
      *) printf '%%901\t/dev/faketty\n' ;;
    esac ;;
  list-sessions)
    fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -F) fmt="$2"; shift 2 ;; *) shift ;; esac
    done
    case "$fmt" in
      *pid*start_time*) printf 'agyteam/agyseat\t123:456\t0\n' ;;
      *) printf 'agyteam/agyseat\n' ;;
    esac ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="$2"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    case "$fmt" in
      '#{pid}:#{start_time}') printf '123:456\n' ;;
      *pane_id*session_name*pane_pid*pane_current_command*)
        case "$target" in
          %901|agyteam/agyseat|agyteam/agyseat:0.0) printf '%%901\tagyteam/agyseat\t4242\tagy\t0\n' ;;
          *) printf '\t\t\t\t\n' ;;
        esac ;;
      *pane_id*)                 printf '%%901\n' ;;
      *session_name*:*window_index*) printf 'agyteam/agyseat:0.0\n' ;;
      *session_name*)          printf 'agyteam/agyseat\n' ;;
      *pane_current_command*)  printf 'agy\n' ;;   # classifies to the agy harness family
      *pane_current_path*)     printf '%s\n' "${FAKE_ROOT:?}" ;;
      *pane_pid*)              printf '4242\n' ;;
      *pane_in_mode*)          printf '0\n' ;;
      *window_activity*)       printf '0\n' ;;
      *) printf '\n' ;;
    esac ;;
  capture-pane) printf '> \n' ;;
  send-keys) exit 0 ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

reset_registry() {  # empty enrolled acting registry — never delete it outright:
  # the enrolled row's registry_location must stay a readable file, or
  # register refuses with registry_unreachable ("refusing empty bootstrap wipe").
  printf '{"schema": "0.20", "team": {"name": "agyteam", "worktree_root": %s}, "seats": {}}\n' \
    "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$ROOT")" \
    > "$TAP_HOME/registry.json"
}

field() {  # <handle> <key> -> value (empty if absent)
  python3 -B - "$TAP_HOME/registry.json" "$1" "$2" <<'PY'
import json, sys
try:
    e = json.load(open(sys.argv[1]))["seats"][sys.argv[2]]
except Exception:
    print(""); raise SystemExit(0)
print(e.get(sys.argv[3], ""))
PY
}

# ── (+) env-volunteered id => tier-1 harness_session_id + additive attribution ──
reset_registry
CID="smoke-conv-abc123"
ANTIGRAVITY_CONVERSATION_ID="$CID" "$TAP" register agyseat --pane %901 >"$WORK/reg1.out" 2>&1 \
  || { echo "session-store-register: agy register (with env id) failed:" >&2; cat "$WORK/reg1.out" >&2; exit 1; }

[ "$(field agyseat harness)" = agy ] || { echo "session-store-register: seat did not classify as agy (got '$(field agyseat harness)')" >&2; exit 1; }
[ "$(field agyseat harness_session_id)" = "$CID" ] || {
  echo "session-store-register: ANTIGRAVITY_CONVERSATION_ID did not land in tier-1 harness_session_id (got '$(field agyseat harness_session_id)')" >&2; exit 1; }
[ "$(field agyseat session_attribution_trust)" = env ] || {
  echo "session-store-register: agy env capture not marked trust=env (got '$(field agyseat session_attribution_trust)')" >&2; exit 1; }
[ "$(field agyseat session_store_kind)" = file ] || { echo "session-store-register: agy store_kind != file" >&2; exit 1; }
case "$(field agyseat session_store_path)" in
  */.gemini/antigravity-cli/brain/$CID/.system_generated/logs/transcript.jsonl) : ;;
  *) echo "session-store-register: agy store_path not derived from the conversation id (got '$(field agyseat session_store_path)')" >&2; exit 1 ;;
esac
# A VERIFIED env id must NOT also appear in the inferred field (that field is r1-forbidden for identity).
[ -z "$(field agyseat derived_harness_session_id)" ] || {
  echo "session-store-register: a verified env id leaked into derived_harness_session_id (r1 violation)" >&2; exit 1; }
echo "session-store-register: (+) agy env id -> tier-1 harness_session_id + additive store fields: ok"

# A same-pane rebind adopts the new native id and records durable old/new detail.
# This is the explicit unattested-drift positive (case 5): the existing row has
# no competing owner and the default capture mode is unattested.
NEXT_CID="smoke-conv-def456"
ANTIGRAVITY_CONVERSATION_ID="$NEXT_CID" "$TAP" register agyseat --pane %901 --force >"$WORK/update.out" 2>&1 \
  || { echo "session-store-register: matched update failed" >&2; cat "$WORK/update.out" >&2; exit 1; }
[ "$(field agyseat harness_session_id)" = "$NEXT_CID" ] || { echo "session-store-register: matched update did not adopt new id" >&2; cat "$TAP_HOME/registry.json" >&2; cat "$WORK/update.out" >&2; exit 1; }
python3 -B - "$TAP_HOME/registry.json" <<'PY'
import json, sys
row = json.load(open(sys.argv[1]))["seats"]["agyseat"]
assert not any(k in row for k in ("quarantined_harness_session_id", "quarantined_transcript_path", "identity_quarantine_reason")), row
PY
grep -q 'UPDATED seat' "$WORK/update.out" || { echo "session-store-register: matched update lacked loud delta" >&2; exit 1; }
grep -q 'action=updated.*old_session=smoke-conv-abc123.*new_session=smoke-conv-def456' "$TAP_HOME/registry-events.log" \
  || { echo "session-store-register: matched update lacked durable old/new event" >&2; exit 1; }
echo "session-store-register: matched pane update adopts id and logs durable delta: ok"

# ── (-) no env id => identity is never inferred (fable rider r1) ──────────────
reset_registry
env -u ANTIGRAVITY_CONVERSATION_ID "$TAP" register agyseat --pane %901 >"$WORK/reg2.out" 2>&1 \
  || { echo "session-store-register: agy register (no env id) failed:" >&2; cat "$WORK/reg2.out" >&2; exit 1; }
[ "$(field agyseat harness)" = agy ] || { echo "session-store-register: seat did not classify as agy (no-id case)" >&2; exit 1; }
[ -z "$(field agyseat harness_session_id)" ] || {
  echo "session-store-register: harness_session_id was populated WITHOUT a verified env id (r1 violation: got '$(field agyseat harness_session_id)')" >&2; exit 1; }
[ "$(field agyseat session_attribution_trust)" != env ] || {
  echo "session-store-register: trust=env with no env id present (r1 violation)" >&2; exit 1; }
echo "session-store-register: (-) no env id -> no inferred identity, trust!=env (rider r1): ok"

echo "session-store-register: ALL OK"
