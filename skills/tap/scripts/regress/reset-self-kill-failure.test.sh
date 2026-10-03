#!/usr/bin/env bash
# D5: fixture-door — :203 copies the src tree and :206 mutates the stop.ts copy to break the self-kill prepare; every assertion runs the public `tap team down --yes --json` (kill-requested / pending_self_kill / kill-failed), owned natively by team-stop-tx.test.ts (kill-requested, kill-failed) + team-stop-plan.test.ts (pending_self_kill).
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# reset-self-kill-failure.test.sh — review finding: self-kill failure reporting.
# team down WITHOUT --keep-self: self-kill prepare emits kill-requested +
# pending_self_kill (never stopped); survivor after failed kill emits
# kill-failed. Mutation: claim stopped at prepare → red.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"

fail() { echo "reset-self-kill: $*" >&2; exit 1; }

TAP_HOME="$(mktemp -d)"
FAKE_BIN="$(mktemp -d)"
KILL_LOG="$(mktemp)"
UNKILLABLE="$(mktemp)"
trap 'rm -rf "$TAP_HOME" "$FAKE_BIN"; rm -f "$KILL_LOG" "$UNKILLABLE"' EXIT
export TAP_HOME KILL_LOG UNKILLABLE PATH="$FAKE_BIN:$PATH"
export TMUX="/tmp/fake,0,0"
export FAKE_EPOCH_RAW="900:100"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$TAP_HOME/tmp"

cat > "$FAKE_BIN/ps" <<'PS'
#!/usr/bin/env bash
printf '1 /dev/faketty\n'
PS
chmod +x "$FAKE_BIN/ps"

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; shift || true
resolve_session() {
  local target="$1"
  case "$target" in =*) target="${target#=}" ;; esac
  printf '%s' "$target"
}
pane_id_for() {
  case "$1" in
    "demo/claude:0.0"|"%101") printf '%%101' ;;
    "demo/codex:0.0"|"%103") printf '%%103' ;;
    *) printf '' ;;
  esac
}
tty_for() { case "$1" in "%101"|"demo/claude:0.0") printf '/dev/faketty' ;; *) return 1 ;; esac; }
case "$cmd" in
  kill-session)
    target=""
    while [ "$#" -gt 0 ]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
    resolved="$(resolve_session "$target")"
    printf '%s\n' "$resolved" >> "${KILL_LOG}"
    # Both sessions refuse to die — proves self-kill failure path (not keep-self).
    printf '%s\n' "$resolved" >> "${UNKILLABLE}"
    exit 0 ;;
  has-session)
    target=""
    while [ "$#" -gt 0 ]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
    resolved="$(resolve_session "$target")"
    if [ -f "${UNKILLABLE:-}" ] && grep -qxF "$resolved" "$UNKILLABLE" 2>/dev/null; then
      exit 0
    fi
    if [ -f "${KILL_LOG:-}" ] && grep -qxF "$resolved" "$KILL_LOG" 2>/dev/null; then
      exit 1
    fi
    exit 0 ;;
  list-panes)
    target=""; all=0
    while [ "$#" -gt 0 ]; do case "$1" in -a) all=1; shift ;; -t) target="$2"; shift 2 ;; -F) shift 2 ;; *) shift ;; esac; done
    [ "$all" = 1 ] && { printf '%%101\t%s\n' "$(tty_for %101)"; exit 0; }
    case "${target#=}" in
      demo/claude) printf '%s\n' '%101' '%102' ;;
      demo/codex)  printf '%s\n' '%103' ;;
      demo/sonnet) printf '%s\n' '%104' ;;
      *) printf '%%p1\n' ;;
    esac
    exit 0 ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="$2"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    if [ -z "$target" ]; then
      case "$fmt" in
        *pid*start_time*) echo "${FAKE_EPOCH_RAW:-900:100}" ;;
        *window_index*) echo "demo/claude:0.0" ;;
        *session_name*) echo "demo/claude" ;;
        *) echo "" ;;
      esac
      exit 0
    fi
    case "$fmt" in
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*pane_tty*session_name*)
        resolved="$(pane_id_for "$target")"
        [ -n "$resolved" ] || { echo ""; exit 0; }
        sess=""; case "$resolved" in "%101") sess=demo/claude ;; "%103") sess=demo/codex ;; esac
        printf '%s\t%s\t%s\t%s\n' "$resolved" "$(tty_for "$resolved")" "$sess" "${FAKE_EPOCH_RAW:-900:100}" ;;
      *pane_id*pane_tty*)
        resolved="$(pane_id_for "$target")"
        [ -n "$resolved" ] || { echo ""; exit 0; }
        printf '%s\t%s\n' "$resolved" "$(tty_for "$resolved")" ;;
      # tap_pane_observe: pane_id + session_name + pid:start_time — must precede
      # bare *pane_id* or resolve_self_handle sees generation_unverifiable and
      # events get handle=? (opus 084125: handle=claude must bind).
      *pane_id*session_name*)
        resolved="$(pane_id_for "$target")"
        [ -n "$resolved" ] || { echo ""; exit 0; }
        sess=""; case "$resolved" in "%101") sess=demo/claude ;; "%103") sess=demo/codex ;; esac
        printf '%s\t%s\t%s\n' "$resolved" "$sess" "${FAKE_EPOCH_RAW:-900:100}" ;;
      *pane_id*) pane_id_for "$target"; printf '\n' ;;
      *session_name*)
        case "$target" in
          "%101") echo "demo/claude" ;;
          "%103") echo "demo/codex" ;;
          *) echo "${target%%:*}" ;;
        esac ;;
      *pid*start_time*) echo "${FAKE_EPOCH_RAW:-900:100}" ;;
      *) echo "" ;;
    esac
    exit 0 ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "claude": {"status": "active", "delivery": "pane", "pane": "demo/claude:0.0", "pane_id": "%101", "harness": "claude", "server_epoch": "srv:900:100", "session": "demo/claude"},
    "codex":  {"status": "active", "delivery": "pane", "pane": "demo/codex:0.0",  "pane_id": "%103", "harness": "codex",  "server_epoch": "srv:900:100", "session": "demo/codex"}
  }
}
JSON

: > "$KILL_LOG"
: > "$UNKILLABLE"
ERR="$(mktemp "$TAP_HOME/err.XXXXXX")"
# No --keep-self: must cross the self-kill boundary (team-down case 8 never does).
set +e
js="$("$TAP" team down --yes --json </dev/null 2>"$ERR")"
rc=$?
set -e

# May be two JSON lines: prepare receipt + kill-failed correction.
python3 -B -c '
import json, sys
raw = sys.argv[1]
lines = [ln for ln in raw.splitlines() if ln.strip().startswith("{")]
assert lines, ("no json", raw)
first = json.loads(lines[0])
assert first.get("pending_self_kill") == "demo/claude", first
assert "demo/claude" not in (first.get("stopped_sessions") or []), first
assert "demo/claude" not in (first.get("killed_sessions") or []), first
# Correction line (survivor) clears pending and lists refusal.
#
# UNCONDITIONAL, and required to exist. Guarding these on `len(lines) > 1` meant
# deleting the correction emission entirely left the fixture GREEN — the assert
# simply stopped running, which is the failure it was written to catch.
# This fixture drives a DETERMINISTIC survivor, so exactly two
# records is the contract: the pre-boundary receipt and its correction.
assert len(lines) == 2, ("expected exactly 2 json records (receipt + correction), got %d" % len(lines), raw)
last = json.loads(lines[-1])
assert last.get("pending_self_kill") in (None, ""), last
assert "demo/claude" in (last.get("refused_sessions") or []), last
' "$js" || { echo "$js" >&2; cat "$ERR" >&2; fail "JSON shape wrong for self-kill failure"; }

events="$(cat "$TAP_HOME/registry-events.log" 2>/dev/null || true)"
# opus 084125: require handle=claude — bare action=kill-requested subsumes and never binds.
grep -Eq 'action=kill-requested.*handle=claude' <<<"$events" \
  || { echo "$events" >&2; fail "missing durable kill-requested for claude"; }
grep -Eq 'action=kill-failed' <<<"$events" \
  || { echo "$events" >&2; fail "missing durable kill-failed after survivor"; }
grep -Eq 'action=killed-self' <<<"$events" \
  && { echo "$events" >&2; fail "must not write killed-self on prepare"; }
grep -qx "demo/claude" "$KILL_LOG" || fail "self session never received kill-session"
# opus 084125: drop js/demo/claude disjunct — already proved at pending_self_kill.
# --json emits the survivor warning on stderr (text "partially down (self kill
# failed)" is the non-json arm); either form is a loud failure path.
[[ "$(cat "$ERR")" == *"own session"*"still live after kill"* \
   || "$(cat "$ERR")" == *"self kill failed"* \
   || "$(cat "$ERR")" == *"partially down"* ]] \
  || { cat "$ERR" >&2; fail "failure path must be loud"; }

# Mutation: put self into stopped_list at prepare → first JSON claims stopped (red polarity).
MUT="$(mktemp -d)"
mkdir -p "$MUT/scripts" "$MUT/skills/tap/scripts"
cp -a "$ROOT/scripts/tap.sh" "$MUT/scripts/tap.sh"
# scripts/tap.sh now execs bin/tap — copy it the same way scripts/runtime are copied.
cp -a "$ROOT/bin" "$MUT/bin"
cp -a "$ROOT/skills/tap/scripts/." "$MUT/skills/tap/scripts/"
# The dispatcher now loads Bun onboarding before its leaf command.
mkdir -p "$MUT/runtime/bun"
cp -a "$ROOT/runtime/bun/src" "$MUT/runtime/bun/src"
# bin/tap dispatches to runtime/bun/main.ts — copy it too.
cp -a "$ROOT/runtime/bun/main.ts" "$MUT/runtime/bun/main.ts"
# fzf-tool.ts statically imports vendor/fzf/manifest.json relative to the repo root.
mkdir -p "$MUT/vendor/fzf"
cp -a "$ROOT/vendor/fzf/manifest.json" "$MUT/vendor/fzf/manifest.json"
python3 -B - "$MUT/runtime/bun/src/team/stop.ts" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
text = p.read_text()
# team down uses registry_policy=suspend — mutate THAT prepare arm (the
# eight-space-indent one inside the suspend branch).
# Reintroduce freeze-3 lie: claim stopped + killed-self at prepare.
old = (
    "        pendingSelfKill = engine.selfSession;\n"
    '        event("kill-requested", engine.selfHandle, engine.selfSession);'
)
new = (
    "        pendingSelfKill = engine.selfSession;\n"
    "        engine.stopped.push(engine.selfSession);\n"
    '        event("killed-self", engine.selfHandle, engine.selfSession);'
)
if old not in text:
    raise SystemExit("mutation target missing for suspend prepare arm")
p.write_text(text.replace(old, new, 1))
PY

cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "claude": {"status": "active", "delivery": "pane", "pane": "demo/claude:0.0", "pane_id": "%101", "harness": "claude", "server_epoch": "srv:900:100", "session": "demo/claude"},
    "codex":  {"status": "active", "delivery": "pane", "pane": "demo/codex:0.0",  "pane_id": "%103", "harness": "codex",  "server_epoch": "srv:900:100", "session": "demo/codex"}
  }
}
JSON
: > "$KILL_LOG"; : > "$UNKILLABLE"
rm -f "$TAP_HOME/registry-events.log"
set +e
mjs="$(cd "$MUT" && TAP_HOME="$TAP_HOME" TMUX="$TMUX" FAKE_EPOCH_RAW="$FAKE_EPOCH_RAW" \
  KILL_LOG="$KILL_LOG" UNKILLABLE="$UNKILLABLE" PATH="$PATH" \
  bash scripts/tap.sh team down --yes --json </dev/null 2>/dev/null)"
set -e
python3 -B -c '
import json, sys
raw = sys.argv[1]
lines = [ln for ln in raw.splitlines() if ln.strip().startswith("{")]
assert lines, raw
first = json.loads(lines[0])
# MUTATION MUST GREEN the old lie: self appears stopped at prepare.
assert "demo/claude" in (first.get("stopped_sessions") or []), ("mutation did not reintroduce stopped claim", first)
' "$mjs" || { echo "$mjs" >&2; fail "MUTATION DID NOT GREEN — stopped_list insert should claim self stopped"; }
echo "reset-self-kill: mutation (claim stopped at prepare) greens the old lie: ok"

echo "reset-self-kill-failure: ok"
