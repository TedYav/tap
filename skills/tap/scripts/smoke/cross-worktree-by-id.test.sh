#!/usr/bin/env bash
# D5: fixture-door — cross-worktree-by-id.test.sh:189-195: the module references here only build or seed fixture state; every assertion is on the surrounding shell behavior, none on the module's own
# cross-worktree-by-id.test.sh — tap-akt4: `tap reply/done <id>` resolves a
# cross-worktree payload by id across enrolled team buses on a LOCAL miss.
#
# Field bug: a cross-team sentinel's payload lives on the SENDER team's bus, but
# `tap reply <id>` / `tap read <id>` looked only at the local bus and failed with
# "inbound payload not found" — the --payload <abs-path> workaround fights the
# universal `tap reply <id>` reflex. Fix: on a local miss, scan every enrolled team
# bus (~/.tap/global-registry.json roots; filenames are globally unique) and settle there,
# keeping --payload as the explicit override.
#
# Fixture: two enrolled team roots (local "alpha" + foreign "beta"), each with its
# own .tap/bus, enrolled in a sandbox global-registry.json (TAP_INDEX_HOME). The obligation
# lives on beta's bus, addressed to an alpha seat; we settle it from alpha's bus
# with a bare id and assert the .done lands on BETA's bus (never alpha's).
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"
# shellcheck source=skills/tap/scripts/smoke/helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/helpers.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/bin/tap"
FIX="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$FIX" "$FAKE_BIN"' EXIT
export PATH="$FAKE_BIN:$PATH"
export TAP_SPOOL_DISABLE_DELIVERER=1 FAKE_TMUX_STATE="$FIX/fake-tmux"
mkdir -p "$FAKE_TMUX_STATE"

# Pane-backed relay fake, reused from the acting-registry reply control.
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
cmd="${1:-}"; shift || true
target=""
case "$cmd" in
  # CONTRACT §Session-name authority: the selected acting registry is authorized
  # only by a current exact-session/pane/generation/harness observation.
  list-sessions)
    printf 'alpha/worker\t123:456\nbeta/fable\t123:456\n' ;;
  list-panes)
    target=""; while [ "$#" -gt 0 ]; do case "$1" in -t) target="${2#=}"; shift 2 ;; *) shift ;; esac; done
    case "$target" in
      alpha/worker) printf 'alpha/worker\tworker-pane\t%%801\tcodex\t4242\t123:456\t0\n' ;;
      beta/fable) printf 'beta/fable\tfable-pane\t%%802\tcodex\t4242\t123:456\t0\n' ;;
    esac ;;
  display-message)
    fmt=""
    while [ "$#" -gt 0 ]; do case "$1" in -p) shift ;; -t) target="${2:-}"; shift 2 ;; *) fmt="$1"; shift ;; esac; done
    case "$fmt" in
      '#{pid}:#{start_time}') echo '123:456' ;;
      *pane_id*session_name*pane_pid*pane_current_command*)
        case "$target" in
          worker-pane|%801) printf '%%801\talpha/worker\t4242\tcodex\t0\n' ;;
          fable-pane|%802)  printf '%%802\tbeta/fable\t4242\tcodex\t0\n' ;;
          *)                printf '\t\t\t\t\n' ;;
        esac ;;
      *pane_id*)              case "$target" in worker-pane) echo '%801' ;; fable-pane) echo '%802' ;; *) echo '%899' ;; esac ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "codex" ;;
      *)                      echo "" ;;
    esac ;;
  capture-pane)
    if [ -f "$state/input" ]; then printf '› %s\n' "$(cat "$state/input")"; else printf '› \n'; fi ;;
  send-keys)
    if [ "${1:-}" = "-t" ]; then target="${2:-}"; shift 2; fi
    if [ "${1:-}" = "-l" ]; then shift; [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" > "$state/input"; printf '%s\n' "${1:-}" >> "$state/sent.log"; exit 0; fi
    if [ "${1:-}" = "Enter" ]; then rm -f "$state/input"; exit 0; fi ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

ALPHA="$FIX/alpha"; BETA="$FIX/beta"
mkdir -p "$ALPHA/.tap/bus/payloads" "$ALPHA/.tap/bus/receipts"
mkdir -p "$BETA/.tap/bus/payloads"  "$BETA/.tap/bus/receipts"
# alpha's bus declares its team so LOCAL_TEAM resolves to "alpha" (the addressee-team
# gate compares the payload's to_team against it) — a real alpha seat has this via its
# registry; the fixture supplies it directly.
cat > "$ALPHA/.tap/bus/registry.json" <<JSON
{"schema": "0.20", "team":{"name":"alpha"},"seats":{"worker":{"status":"active","delivery":"pane","session":"alpha/worker","pane":"worker-pane","pane_id":"%801","server_epoch":"srv:123:456","harness":"codex"}}}
JSON
# beta has a pane-backed return route; the fake records injection and consumes Enter.
cat > "$BETA/.tap/bus/registry.json" <<JSON
{"schema": "0.20", "team":{"name":"beta"},"seats":{"fable":{"status":"active","delivery":"pane","session":"beta/fable","pane":"fable-pane","pane_id":"%802","server_epoch":"srv:123:456","harness":"codex"}}}
JSON

# Sandbox machine index enrolling both team roots (never touch the real ~/.tap).
export TAP_INDEX_HOME="$FIX/index"
tap_smoke_enroll_current "$ALPHA" "$ALPHA/.tap/bus" alpha
tap_smoke_enroll_current "$BETA" "$BETA/.tap/bus" beta

# A cross-worktree obligation on BETA's bus, addressed to alpha's seat "worker".
plant() { # <id> <reply>
  local id="$1" reply="$2"
  { printf '%s\n' '---' "id: $id" 'from: fable' 'to: worker' 'kind: discuss' \
      "reply: $reply" "path: $BETA/.tap/bus/payloads/$id.md" \
      'from_team: beta' 'to_team: alpha' 'cross_worktree: true' '---' '' 'do the thing'; \
  } > "$BETA/.tap/bus/payloads/$id.md"
}

ID_DONE="fable-20260723T120000Z-aaaaaaaaaaaa"
ID_REPL="fable-20260723T120001Z-bbbbbbbbbbbb"
plant "$ID_DONE" settle-only
plant "$ID_REPL" expected

# (1) tap read <id> from ALPHA's bus (bare id, NO --payload) resolves across the
# enrolled buses and settles on BETA's bus.
TAP_HOME="$ALPHA/.tap/bus" "$TAP" read "$ID_DONE" --by worker >/dev/null 2>&1 \
  || { echo "cross-worktree-by-id: (1) tap read <id> did not resolve/settle cross-worktree" >&2; exit 1; }
[ -f "$BETA/.tap/bus/receipts/$ID_DONE.done" ] || { echo "cross-worktree-by-id: (1) .done not written on BETA (sender) bus" >&2; exit 1; }
[ ! -f "$ALPHA/.tap/bus/receipts/$ID_DONE.done" ] || { echo "cross-worktree-by-id: (1) .done wrongly written on ALPHA (local) bus" >&2; exit 1; }
python3 -B - "$BETA/.tap/bus/receipts/$ID_DONE.done" <<'PY' || { echo "cross-worktree-by-id: (1) receipt actor wrong" >&2; exit 1; }
import json, sys
assert json.load(open(sys.argv[1]))["by"] == "worker"
PY
echo "cross-worktree-by-id: (1) tap read <id> resolves by-id + settles on the sender bus, no --payload: ok"

# (2) Reading an ask leaves it open; reply must resolve the same qualified
# reference and settle only after a durable outbound exists on the local bus.
TAP_HOME="$ALPHA/.tap/bus" "$TAP" read "beta/$ID_REPL" --by worker >/dev/null
[ ! -f "$BETA/.tap/bus/receipts/$ID_REPL.done" ] || { echo "read settled ask" >&2; exit 1; }
set +e
REPL="$(TAP_HOME="$ALPHA/.tap/bus" "$TAP" reply "beta/$ID_REPL" --by worker -m "on it" 2>&1)"; REPL_RC=$?
set -e
[ "$REPL_RC" = 0 ] || { echo "qualified reply failed: $REPL" >&2; exit 1; }
[ -f "$BETA/.tap/bus/receipts/$ID_REPL.done" ] || { echo "reply did not settle sender bus" >&2; exit 1; }
[ ! -f "$ALPHA/.tap/bus/receipts/$ID_REPL.done" ] || { echo "reply settled wrong bus" >&2; exit 1; }
python3 -B - "$ALPHA/.tap/bus/payloads" "$ID_REPL" <<'PYCONTROL'
from pathlib import Path
import sys
rows = [p.read_text() for p in Path(sys.argv[1]).glob('*.md')]
assert any('in_reply_to: '+sys.argv[2] in row and 'on it' in row for row in rows), 'no durable answer'
PYCONTROL
# Bare-id reply after a qualified read uses the same sender-bus custody.
ID_BARE="fable-20260723T120002Z-dddddddddddd"
plant "$ID_BARE" expected
TAP_HOME="$ALPHA/.tap/bus" "$TAP" read "beta/$ID_BARE" --by worker >/dev/null
TAP_HOME="$ALPHA/.tap/bus" "$TAP" reply "$ID_BARE" --by worker -m "bare answer" >/dev/null
[ -f "$BETA/.tap/bus/receipts/$ID_BARE.done" ] || { echo "bare reply did not settle sender bus" >&2; exit 1; }
echo "cross-worktree-by-id: (2) qualified read then qualified/bare reply preserves durable-answer custody: ok"

# Qualified addresses and explicit foreign paths both override a local same-id file.
for form in qualified explicit; do
  ID_DUP="fable-20260723T120003Z-$form"
  plant "$ID_DUP" expected
  cp "$BETA/.tap/bus/payloads/$ID_DUP.md" "$ALPHA/.tap/bus/payloads/$ID_DUP.md"
  if [ "$form" = qualified ]; then
    args=("beta/$ID_DUP")
  else
    args=("$ID_DUP" --payload "$BETA/.tap/bus/payloads/$ID_DUP.md")
  fi
  TAP_HOME="$ALPHA/.tap/bus" "$TAP" reply "${args[@]}" --by worker -m "selected foreign" >/dev/null
  [ -f "$BETA/.tap/bus/receipts/$ID_DUP.done" ] || { echo "foreign selection not settled" >&2; exit 1; }
  [ ! -f "$ALPHA/.tap/bus/receipts/$ID_DUP.done" ] || { echo "local collision wrongly settled" >&2; exit 1; }
done
# Refusals must not create outbound mail or alter receipt custody.
refuse() {
  local want="$1"; shift
  local before after output rc=0
  before="$(find "$ALPHA/.tap/bus/payloads" "$BETA/.tap/bus/receipts" -type f | sort)"
  output="$(TAP_HOME="$ALPHA/.tap/bus" "$TAP" reply "$@" -m "must not send" 2>&1)" || rc=$?
  [ "$rc" != 0 ] && grep -qi -- "$want" <<< "$output" || { echo "wrong refusal: $output" >&2; exit 1; }
  after="$(find "$ALPHA/.tap/bus/payloads" "$BETA/.tap/bus/receipts" -type f | sort)"
  [ "$before" = "$after" ] || { echo "refusal mutated custody" >&2; exit 1; }
}
# Explicit paths cannot bypass the non-canonical residency refusal.
ID_PARKED="fable-20260723T120004Z-parked"
plant "$ID_PARKED" expected
mkdir -p "$BETA/.tap/bus/spool"
mv "$BETA/.tap/bus/payloads/$ID_PARKED.md" "$BETA/.tap/bus/spool/$ID_PARKED.md"
refuse 'resolves to spool' "$ID_PARKED" --payload "$BETA/.tap/bus/spool/$ID_PARKED.md" --by worker
refuse 'resolves to spool' "path=$BETA/.tap/bus/spool/$ID_PARKED.md" --by worker
refuse 'resolves to spool' "$BETA/.tap/bus/spool/$ID_PARKED.md" --by worker
[ -f "$BETA/.tap/bus/spool/$ID_PARKED.md" ] || { echo "refusal adopted parked payload" >&2; exit 1; }

# (4) tap-4b7ib: the canonical pointer a sentinel carries keeps working while the
# bytes sit parked under a REAL queue claim. The read waits through the bounded
# ceiling for the handoff, then settles exactly once on BETA's bus; a same-id
# decoy on the caller's bus must not redirect the receipt.
ID_HANDOFF="fable-20260723T120005Z-handoff"
plant "$ID_HANDOFF" settle-only
mkdir -p "$BETA/.tap/bus/spool"
mv "$BETA/.tap/bus/payloads/$ID_HANDOFF.md" "$BETA/.tap/bus/spool/$ID_HANDOFF.md"
printf '{"id":"%s","target":"worker","target_registry":"%s","to_team":"alpha","reason":"queued-input"}\n' \
  "$ID_HANDOFF" "$BETA/.tap/bus/registry.json" > "$BETA/.tap/bus/spool/$ID_HANDOFF.meta.json"
printf 'decoy bytes' > "$ALPHA/.tap/bus/payloads/$ID_HANDOFF.md"
SIDECAR="$ROOT/runtime/bun/src/spool-sidecar.ts"
HOLDING="$FIX/claim-holding"; RELEASE="$FIX/claim-release"
(
  until bun "$SIDECAR" claim "$BETA/.tap/bus/spool" "$ID_HANDOFF" no-steal >/dev/null 2>&1; do sleep 0.02; done
  touch "$HOLDING"
  until [ -e "$RELEASE" ]; do sleep 0.02; done
  bun "$SIDECAR" release "$BETA/.tap/bus/spool" "$ID_HANDOFF" >/dev/null 2>&1
) &
HOLDER=$!
for _ in $(seq 1 500); do [ -e "$HOLDING" ] && break; sleep 0.02; done
[ -e "$HOLDING" ] || { echo "cross-worktree-by-id: (4) holder never took the real claim" >&2; exit 1; }
TAP_HOME="$ALPHA/.tap/bus" "$TAP" read "path=$BETA/.tap/bus/payloads/$ID_HANDOFF.md" --by worker \
  >"$FIX/handoff.out" 2>"$FIX/handoff.err" &
READER=$!
sleep 2
if ! kill -0 "$READER" 2>/dev/null; then
  touch "$RELEASE"; wait "$HOLDER" 2>/dev/null || true
  echo "cross-worktree-by-id: (4) canonical read did not wait on a live claim:" >&2
  cat "$FIX/handoff.out" "$FIX/handoff.err" >&2
  exit 1
fi
[ ! -e "$BETA/.tap/bus/receipts/$ID_HANDOFF.done" ] || { echo "cross-worktree-by-id: (4) .done written while another claim held" >&2; exit 1; }
touch "$RELEASE"
CANON_RC=0; wait "$READER" || CANON_RC=$?
[ "$CANON_RC" = 0 ] || { echo "cross-worktree-by-id: (4) held-claim canonical read failed (rc=$CANON_RC):" >&2; cat "$FIX/handoff.out" "$FIX/handoff.err" >&2; exit 1; }
wait "$HOLDER" 2>/dev/null || true
[ -f "$BETA/.tap/bus/receipts/$ID_HANDOFF.done" ] || { echo "cross-worktree-by-id: (4) handoff read did not settle the sender bus" >&2; exit 1; }
[ ! -e "$ALPHA/.tap/bus/receipts/$ID_HANDOFF.done" ] || { echo "cross-worktree-by-id: (4) handoff receipt landed on the caller bus" >&2; exit 1; }
[ ! -e "$BETA/.tap/bus/spool/$ID_HANDOFF.md" ] || { echo "cross-worktree-by-id: (4) spool copy survived the handoff" >&2; exit 1; }
[ ! -e "$BETA/.tap/bus/spool/$ID_HANDOFF.claim" ] || { echo "cross-worktree-by-id: (4) claim leaked past settlement" >&2; exit 1; }
grep -q 'do the thing' "$BETA/.tap/bus/payloads/$ID_HANDOFF.md" || { echo "cross-worktree-by-id: (4) canonical bytes lost in the handoff" >&2; exit 1; }
grep -q 'decoy bytes' "$ALPHA/.tap/bus/payloads/$ID_HANDOFF.md" || { echo "cross-worktree-by-id: (4) same-id decoy mutated by the handoff read" >&2; exit 1; }
echo "cross-worktree-by-id: (4) canonical pointer waits out a real claim, settles once on the sender bus: ok"

refuse 'already settled' "beta/$ID_DONE" --by worker
refuse 'ask the sender' beta/unknown-id --by worker
# A BARE id that misses the local bus AND every enrolled bus must teach the concrete
# path recovery, not just "ask the sender" (CONTRACT.md: the miss-everywhere refusal
# "then teaches --payload <abs-path-from-sentinel-path-field>", the authoritative
# override for an UN-ENROLLED peer -- the one case the by-id scan cannot reach).
# Only regress/ asserted this, so a later port dropped it and the gate stayed green; this arm
# is the gating control for the teaching, on the bare-id input that actually reaches it.
#
# Assert the WHOLE command shape, not just the --payload substring. `tap reply` refuses
# with a usage error unless a positional <id|path> AND a message source are present
# (tap-reply.sh:67), so a remedy naming only the flag sends the reader into a second
# refusal. The substring form of this arm passed against exactly that broken advice.
refuse 'tap reply <id> --payload <abs-path-from-sentinel> -f' fable-20260723T129999Z-cccccccccccc --by worker
refuse 'ask the sender' "$ID_DUP" --payload "$FIX/missing.md" --by worker
refuse 'does not match' mismatched-id --payload "$BETA/.tap/bus/payloads/$ID_DUP.md" --by worker
refuse 'uses --by' "$ID_BARE" --from worker
refuse 'uses --by' "beta/$ID_BARE" --from worker

# (3) a genuinely-unknown id (on no enrolled bus) still fails — with guidance naming
# BOTH the local bus and the enrolled buses (never a silent success).
set +e
MISS="$(TAP_HOME="$ALPHA/.tap/bus" "$TAP" read "fable-20260723T129999Z-cccccccccccc" --by worker 2>&1)"; MISS_RC=$?
set -e
[ "$MISS_RC" != 0 ] || { echo "cross-worktree-by-id: (3) unknown id should fail, not settle" >&2; exit 1; }
grep -qiE "enrolled team bus|no local payload|not found" <<<"$MISS" || { echo "cross-worktree-by-id: (3) miss error should name local + enrolled buses" >&2; echo "$MISS" >&2; exit 1; }
echo "cross-worktree-by-id: (3) unknown id fails with local+enrolled guidance: ok"

echo "cross-worktree-by-id: ok"
