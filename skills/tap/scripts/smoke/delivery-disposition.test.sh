#!/usr/bin/env bash
# Public send controls reuse the existing pane/registry fixture, not policy mocks.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
python3 - "$ROOT" "$WORK/probe.sh" <<'PY'
from pathlib import Path
import shlex, sys
root=Path(sys.argv[1]); source=(root/'skills/tap/scripts/smoke/courier-digest.test.sh').read_text()
source=source.split('# ---- (0) identity drift',1)[0]
source=source.replace('ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"', 'ROOT='+shlex.quote(str(root)))
source=source.replace('. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"', '. '+shlex.quote(str(root/'skills/tap/scripts/smoke/sandbox-pins.sh')))
source=source.replace('. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/helpers.sh"', '. '+shlex.quote(str(root/'skills/tap/scripts/smoke/helpers.sh')))
source=source.replace('  set-option) case "$*" in *" -u "*) : ;; *) echo "$*" >> "$state/tint.log" ;; esac ;;', '  set-option) case "$*" in *" -u "*) : ;; *) echo "$*" >> "$state/tint.log"; echo "STYLE $*" >> "$state/send-keys.log" ;; esac ;;')
source=source.replace('  capture-pane)\n', '  capture-pane)\n    if [ -f "$state/frame" ]; then cat "$state/frame"; exit 0; fi\n')
Path(sys.argv[2]).write_text(source+r'''
failures=0
# One scalar out of an entry's meta, straight from the native sidecar reader.
meta_field() { tap_bun_call spool-sidecar "$1" spool-sidecar.ts field "$TAP_SPOOL" "$1" "$2" 2>/dev/null || printf ''; }
printf 'bounded probe body\n' > "$WORK/probe-body.md"
check() { if ! "$@"; then printf 'FAIL: %s: %s\n' "$scenario" "$*"; failures=$((failures+1)); fi; }
for scenario in bare draft urgent urgent-bare queued; do
  reset_bus
  # A reset bus leaves no pane protection history; a lingering record from a
  # previous scenario would hold this one on the real clock. Rather
  # than deleting the prior scenario's input-protection state (an `rm` that
  # would sit inside this loop, inside a script written and run in the same
  # invocation — the shape AGENTS.md's rm rule forbids regardless of how the
  # delete is spelled), give each scenario its own TAP_INDEX_HOME so there is
  # never anything to delete: the whole $WORK tree, including every
  # scenario's index dir, is reaped by the one literal top-level
  # `trap 'rm -rf "$WORK"' EXIT` already at the top of this file.
  TAP_INDEX_HOME="$WORK/index-$scenario"; export TAP_INDEX_HOME
  mkdir -p "$TAP_INDEX_HOME"
  printf '{"schema":"0.20","teams":{}}\n' > "$TAP_INDEX_HOME/global-registry.json"
  : > "$WORK/tmux/tint.log"
  rm -f "$WORK/tmux/input" "$WORK/tmux/frame"
  case "$scenario" in draft|urgent) printf 'human draft to preserve' > "$WORK/tmux/input" ;; esac
  if [ "$scenario" = queued ]; then printf '↳ queued followup\n❯ \n shift + ← edit last queued message\n' > "$WORK/tmux/frame"; fi
  flags=(); case "$scenario" in urgent|urgent-bare) flags=(--urgent) ;; esac
  bash "$TAPSH" send peer --from alice --id "$scenario" "${flags[@]}" -m 'bounded fixture notice' > "$WORK/send-$scenario.log" 2>&1
  check test ! -e "$BUS/receipts/$scenario.done"
  if [ "$scenario" = bare ] || [ "$scenario" = urgent-bare ]; then
    check test -f "$BUS/receipts/$scenario.sent"
    check test ! -e "$BUS/spool/$scenario.md"
    check test ! -s "$WORK/tmux/tint.log"
  elif [ "$scenario" = urgent ]; then
    # Input protection: urgent mail gives a draft a visible 10 s red countdown and parks,
    # instead of the old immediate Escape interrupt; delivery happens when the
    # deadline forces. The forced class — delivery with a retained backup — is
    # pinned by courier-busy-hold (4), which runs the same clobber pipeline
    # against an expired draft record.
    check test -f "$BUS/spool/$scenario.md"
    check test "$(meta_field "$scenario" reason)" = pending-input
    _uf="$(meta_field "$scenario" first_spooled_epoch)"; _ud="$(meta_field "$scenario" deadline_epoch)"
    check test "$((_ud - _uf))" = 10
    check grep -q 'bg=red' "$WORK/tmux/tint.log"
    check test "$(cat "$WORK/tmux/input")" = 'human draft to preserve'
  elif [ "$scenario" = queued ]; then
    check test "$(meta_field "$scenario" reason)" = queued-input
    check test ! -s "$WORK/tmux/tint.log"
    cp "$WORK/tmux/send-keys.log" "$WORK/keys-before"
    deadline="$(meta_field "$scenario" deadline_epoch)"
    spool_drain_fixture_once "$((deadline+1))" 8 peer "$REG"
    check cmp "$WORK/keys-before" "$WORK/tmux/send-keys.log"
    check test ! -s "$WORK/tmux/tint.log"
    rm -f "$WORK/tmux/frame"
    spool_drain_fixture_once "$((deadline+2))" 8 peer "$REG"
    check test -f "$BUS/receipts/$scenario.sent"
  else
    check test -f "$BUS/spool/$scenario.md"
    check test "$(meta_field "$scenario" reason)" = pending-input
    first="$(meta_field "$scenario" first_spooled_epoch)"
    deadline="$(meta_field "$scenario" deadline_epoch)"
    check test "$((deadline-first))" = 30
    check grep -q 'bg=green' "$WORK/tmux/tint.log"
    : > "$WORK/tmux/tint.log"
    spool_drain_fixture_once "$((first+19))" 8 peer "$REG"
    check test ! -s "$WORK/tmux/tint.log"
    spool_drain_fixture_once "$((first+20))" 8 peer "$REG"
    check grep -q 'bg=red' "$WORK/tmux/tint.log"
    check test ! -e "$BUS/receipts/$scenario.sent"
    check test "$(cat "$WORK/tmux/input")" = 'human draft to preserve'
  fi
done

# A watcher probe carries its configured probe_timeout on EVERY park path
# (CONTRACT.md, Probe acceptance state machine: "including visible pending
# input"). Each path supplies its own grace -- the disposition's constant for a
# draft, zero for a staged band, none at all for the clearing fence -- so this
# checks the shared parking boundary rather than one caller.
park_grace() { # <id> -> deadline - first_spooled
  local _f _d
  _f="$(meta_field "$1" first_spooled_epoch)"; _d="$(meta_field "$1" deadline_epoch)"
  [ -n "$_f" ] && [ -n "$_d" ] || { printf 'missing(first=%s deadline=%s)' "$_f" "$_d"; return 0; }
  printf '%s' "$((_d - _f))"
}
write_live_fence() { # <handle>
  python3 -B - "$BUS" "$1" <<'FENCE'
import json, os, sys, time
bus, handle = sys.argv[1], sys.argv[2]
path = os.path.join(bus, "clear-fence", handle + ".json")
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump({"nonce": "fence-nonce", "since": "2099-01-01T00:00:00Z", "since_epoch": time.time(),
           "pid": 2147483646, "handle": handle, "harness": "codex", "ceiling_seconds": 45},
          open(path, "w"))
FENCE
}
for scenario in probe-draft probe-staged probe-fence ordinary-draft ambient-draft; do
  reset_bus
  # Same per-scenario index isolation as above: probe-draft's record must not
  # hold probe-staged's send on the real clock.
  TAP_INDEX_HOME="$WORK/index-$scenario"; export TAP_INDEX_HOME
  mkdir -p "$TAP_INDEX_HOME"
  printf '{"schema":"0.20","teams":{}}\n' > "$TAP_INDEX_HOME/global-registry.json"
  : > "$WORK/tmux/tint.log"
  rm -f "$WORK/tmux/input" "$WORK/tmux/frame"; rm -rf "$BUS/clear-fence"
  case "$scenario" in
    probe-staged) printf '↳ queued followup\n❯ \n shift + ← edit last queued message\n' > "$WORK/tmux/frame" ;;
    probe-fence)  write_live_fence peer ;;
    *)            printf 'human draft to preserve' > "$WORK/tmux/input" ;;
  esac
  case "$scenario" in
    ordinary-draft) TAP_SEND_GRACE_SECONDS=17 bash "$TAPSH" send peer --from alice --id "$scenario" \
                      -m 'bounded fixture notice' > "$WORK/send-$scenario.log" 2>&1 ;;
    ambient-draft)  SUPERVISOR_GRACE_SECONDS=7 bash "$TAPSH" send peer --from alice --id "$scenario" \
                      -m 'bounded fixture notice' > "$WORK/send-$scenario.log" 2>&1 ;;
    *)              TAP_SELF=watcher TAP_SEND_GRACE_SECONDS=17 bash "$TAPSH" send peer "$WORK/probe-body.md" \
                      --from watcher --kind probe --fyi --id "$scenario" > "$WORK/send-$scenario.log" 2>&1 ;;
  esac
  check test -f "$BUS/spool/$scenario.md"
  case "$scenario" in
    probe-draft)    check test "$(meta_field "$scenario" reason)" = pending-input
                    check test "$(park_grace "$scenario")" = 17 ;;
    probe-staged)   check test "$(meta_field "$scenario" reason)" = queued-input
                    check test "$(park_grace "$scenario")" = 17 ;;
    probe-fence)    check test "$(meta_field "$scenario" reason)" = clearing
                    check test "$(park_grace "$scenario")" = 17 ;;
    # The public knob is copied into the grace only for a watcher --fyi probe:
    # an ordinary sender keeps the generic draft window.
    ordinary-draft) check test "$(meta_field "$scenario" reason)" = pending-input
                    check test "$(park_grace "$scenario")" = 30 ;;
    # And SUPERVISOR_GRACE_SECONDS is tap-send.sh's own local, never a knob a
    # caller can set: an ambient value must not reach the park.
    ambient-draft)  check test "$(meta_field "$scenario" reason)" = pending-input
                    check test "$(park_grace "$scenario")" = 30 ;;
  esac
done
rm -rf "$BUS/clear-fence"
# The Bash send body's disposition-validator arm (optimized-invalid-action) is
# gone with that body (cut sprint E); native send validates in-process.
[ "$failures" = 0 ]
''')
PY
bash "$WORK/probe.sh"
