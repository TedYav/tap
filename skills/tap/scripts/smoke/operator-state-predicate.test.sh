#!/usr/bin/env bash
# operator-state-predicate.test.sh — tap-dsbpf.1 lock-arm attribution.
#
# Sources the production predicate (suite-name-receipt lesson): a reimplemented
# copy would stay green while the runner's arm drifted. Synthetic operator-state
# only — no suite slot, no live wave. The production pane-key sanitizer's
# charset table lives in runtime/bun/test/unit3-lock.test.ts; every arm here
# exercises the runner's own predicate and census, not a Bun module.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
SMOKE_ALL="$ROOT/scripts/smoke-all.sh"
PY="${TAP_PYTHON:-python3}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tap-operator-state-predicate.XXXXXX")"
# Helper sessions (P/P2 wave children, the KEEP-foreign sleeper) register their
# sid in a FILE, never a shell array: run_mutant runs the live controls in a
# subshell, and a mutant that fails before its stop_session would otherwise leak
# sessions the parent EXIT trap never learned about (verdict-670-89a93c5f:
# m-alpha leaked P, m-beta leaked KEEP-foreign, ~120s each). The sweep kills
# recorded sids only — never a name or pattern.
WAVE_SIDS="$WORK/wave-sids"
: >"$WAVE_SIDS"
trap '
  if [ "${BASH_SUBSHELL:-0}" -eq 0 ]; then
    sweep_wave_sessions
    rm -rf "$WORK"
  fi
' EXIT
fail() { echo "operator-state-predicate: $1" >&2; exit 1; }

# K5: pin deletion/redirect/global/team arms; peer marker and Bun staging releases
# (tap-c7whh) and input-protection releases (tap-cc7iu) are covered separately
# in operator-held-release.test.sh.
K5_ARM_SHA="e8bac1b9c888d389765c1abe721440f3dead1fc40cbee31bd767ed9b86814ca8"
SPECIMEN_LOCK="obligation-opus-courier-startup-20260901T160603Z-f1267d729d93.lock"
ART_LOCK="obligation-art-20260901T160603Z-aaaaaaaaaaaa.lock"
PASS=0
EXPECT=0

expect() { # <got> <want> <label>
  EXPECT=$((EXPECT + 1))
  if [ "$1" = "$2" ]; then
    PASS=$((PASS + 1))
    return 0
  fi
  fail "$3 — got $(printf %q "$1") want $(printf %q "$2")"
}

expect_contains() { # <haystack> <needle> <label>
  EXPECT=$((EXPECT + 1))
  if [[ "$1" == *"$2"* ]]; then
    PASS=$((PASS + 1))
    return 0
  fi
  fail "$3 — missing $(printf %q "$2") in: $1"
}

expect_absent() { # <haystack> <needle> <label>
  EXPECT=$((EXPECT + 1))
  if [[ "$1" != *"$2"* ]]; then
    PASS=$((PASS + 1))
    return 0
  fi
  fail "$3 — unexpectedly present $(printf %q "$2") in: $1"
}

k5_arm_sha() { # <smoke-all-path>
  "$PY" -B - "$1" <<'PY'
from pathlib import Path
import hashlib, re, sys
text = Path(sys.argv[1]).read_text(encoding="utf-8")
match = re.search(r"smoke_operator_state_predicate\(\) \{.*?<<'PY'\n(.*)\nPY\n\}", text, re.S)
if not match:
    raise SystemExit("predicate python block not found")
py = match.group(1)
start = py.index("    is_redirected = any(")
lock = py.find('\n    if path.name.endswith(".lock")')
if lock < 0:
    raise SystemExit("lock arm not found")
region = py[start:lock + 1]
print(hashlib.sha256(region.encode()).hexdigest())
PY
}

new_probe() {
  PROBE="$(mktemp -d "$WORK/probe.XXXXXX")"
  mkdir -p "$PROBE/oproot/locks" "$PROBE/runroot"
  : >"$PROBE/pids"
  : >"$PROBE/handles"
  : >"$PROBE/redirected"
  : >"$PROBE/panes"
  : >"$PROBE/roots"
  : >"$PROBE/peer"
  printf '%s\n' '{}' >"$PROBE/before.json"
}

put_file() { # <rel> <contents>
  local rel="$1" dir
  dir="$(dirname "$PROBE/oproot/$rel")"
  mkdir -p "$dir"
  printf '%s' "$2" >"$PROBE/oproot/$rel"
}

snapshot_after() {
  (
    . "$SMOKE_ALL" >/dev/null 2>&1
    smoke_operator_state_snapshot "$PROBE/oproot" "$PROBE/after.json"
  )
}

run_pred() {
  local tmp rcfile
  tmp="$(mktemp "$WORK/out.XXXXXX")"
  rcfile="$(mktemp "$WORK/rc.XXXXXX")"
  (
    set +e
    # shellcheck disable=SC1090
    . "$SMOKE_ALL" >/dev/null 2>&1
    smoke_operator_state_predicate \
      "$PROBE/before.json" "$PROBE/after.json" "$PROBE/oproot" "$PROBE/runroot" \
      "$PROBE/pids" "$PROBE/handles" "$PROBE/redirected" "$PROBE/panes" "$PROBE/roots" \
      "$PROBE/peer" "${PRED_SESSIONS:-$PROBE/pids}" >"$tmp" 2>&1
    echo "$?" >"$rcfile"
  )
  PRED_OUT="$(cat "$tmp")"
  PRED_RC="$(cat "$rcfile")"
}

run_census() {
  (
    set +e
    # shellcheck disable=SC1090
    . "$SMOKE_ALL" >/dev/null 2>&1
    smoke_wave_pid_census "$PROBE/pids"
  )
}

wait_file() { # <path>
  local path="$1" i
  for i in $(seq 1 50); do
    [ -s "$path" ] && return 0
    sleep 0.1
  done
  return 1
}

start_wave_child() { # <script>
  : >"$PROBE/child.pid"
  (
    # shellcheck disable=SC1090
    . "$SMOKE_ALL" >/dev/null 2>&1
    export SMOKE_WAVE_PIDS="$PROBE/pids"
    export P_OPROOT="$PROBE/oproot"
    export P_CHILD_PID_FILE="$PROBE/child.pid"
    export TAP_PYTHON="$PY"
    smoke_wave_session_exec "$1"
  ) &
}

recorded_pid() { # <pid>
  grep -qx "$1" "$PROBE/pids" && echo yes || echo no
}

register_sid() { # <sid> — append-only; survives run_mutant's subshell.
  [ -n "$1" ] || return 0
  printf '%s\n' "$1" >>"$WAVE_SIDS"
}

live_registered_sids() { # prints live pids whose session id is a registered sid
  [ -s "$WAVE_SIDS" ] || return 0
  "$PY" -B - "$WAVE_SIDS" <<'PY'
import os, subprocess, sys
sids = set()
for line in open(sys.argv[1], encoding="utf-8"):
    raw = line.strip()
    if raw.isdigit():
        sids.add(int(raw))
live = []
for field in subprocess.check_output(["ps", "-axo", "pid="], text=True).split():
    try:
        pid = int(field)
        if os.getsid(pid) in sids:
            live.append(str(pid))
    except (ValueError, ProcessLookupError, PermissionError, OSError):
        continue
print(" ".join(live))
PY
}

sweep_wave_sessions() { # TERM every registered session group, then bounded KILL.
  local sid i
  [ -s "$WAVE_SIDS" ] || return 0
  for sid in $(sort -u "$WAVE_SIDS"); do
    kill -TERM -- "-$sid" 2>/dev/null || kill -TERM "$sid" 2>/dev/null || true
  done
  for i in $(seq 1 30); do
    [ -n "$(live_registered_sids)" ] || return 0
    sleep 0.1
  done
  for sid in $(sort -u "$WAVE_SIDS"); do
    kill -KILL -- "-$sid" 2>/dev/null || kill -KILL "$sid" 2>/dev/null || true
  done
}

registry_state() { # nonempty|empty — the registry is reset after every successful census
  [ -s "$WAVE_SIDS" ] && echo nonempty || echo empty
}

assert_no_wave_sessions() { # <label> — the "no leaked helper processes" arm
  expect "$(live_registered_sids)" "" "$1 live registered-session pids"
  # Confirmed dead: reset so no later sweep signals a number a reused pid may now own.
  : >"$WAVE_SIDS"
}

stop_session() { # <sid> [extra pids] — per-control; trap is backstop only.
  local sid="$1" pid
  shift || true
  if [ -n "$sid" ]; then
    kill -TERM -- "-$sid" 2>/dev/null || kill -TERM "$sid" 2>/dev/null || true
  fi
  for pid in "$@"; do
    [ -n "$pid" ] || continue
    kill -TERM "$pid" 2>/dev/null || true
  done
  for pid in "$sid" "$@"; do
    [ -n "$pid" ] || continue
    wait "$pid" 2>/dev/null || true
  done
}

P_HELD_SCRIPT="$WORK/p-held.sh"
cat >"$P_HELD_SCRIPT" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
"${TAP_PYTHON:-python3}" -B - <<'PY' &
import os, pathlib, time
root = pathlib.Path(os.environ["P_OPROOT"])
(root / "locks").mkdir(parents=True, exist_ok=True)
pid = os.getpid()
(root / "locks" / ("p-child.lock.held.%s.r1" % pid)).write_text("", encoding="utf-8")
pathlib.Path(os.environ["P_CHILD_PID_FILE"]).write_text("%s\n" % pid, encoding="utf-8")
time.sleep(120)
PY
wait
EOS
chmod +x "$P_HELD_SCRIPT"

P_LATE_SCRIPT="$WORK/p-late.sh"
cat >"$P_LATE_SCRIPT" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
"${TAP_PYTHON:-python3}" -B - <<'PY_LATE'
import os, pathlib, time
pidfile = pathlib.Path(os.environ["P_CHILD_PID_FILE"])
pidfile.with_suffix(".ready").write_text("ready")
while not pidfile.with_suffix(".fork").exists():
    time.sleep(.02)
if os.environ["P_LATE_ESCAPE"] == "escape":
    os.setsid()
pid = os.fork()
if not pid:
    pid = os.getpid()
    root = pathlib.Path(os.environ["P_OPROOT"])
    (root / "locks").mkdir(parents=True, exist_ok=True)
    (root / "locks" / f"late.lock.held.{pid}.r1").write_text("")
    pidfile.write_text(str(pid))
    time.sleep(120)
elif os.environ["P_LATE_ESCAPE"] == "reused":
    os.waitpid(pid, 0)
# Other workers finish while their late child remains in the session.
PY_LATE
EOS
chmod +x "$P_LATE_SCRIPT"

P2_JSON_SCRIPT="$WORK/p2-json.sh"
cat >"$P2_JSON_SCRIPT" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
"${TAP_PYTHON:-python3}" -B - <<'PY' &
import os, pathlib, time
root = pathlib.Path(os.environ["P_OPROOT"])
(root / "locks").mkdir(parents=True, exist_ok=True)
pid = os.getpid()
(root / "locks" / "p2.lease.json.lock").write_text('{"pid": %d}\n' % pid, encoding="utf-8")
pathlib.Path(os.environ["P_CHILD_PID_FILE"]).write_text("%s\n" % pid, encoding="utf-8")
time.sleep(120)
PY
wait
EOS
chmod +x "$P2_JSON_SCRIPT"

start_foreign_sleeper() { # sets $foreign: a live pid in its own session, registered for the sweep
  "$PY" -B - "$PROBE/foreign.pid" <<'PY' &
import os, sys, time, pathlib
os.setsid()
pathlib.Path(sys.argv[1]).write_text("%s\n" % os.getpid(), encoding="utf-8")
time.sleep(120)
PY
  wait_file "$PROBE/foreign.pid" || fail "foreign sleeper pid file missing"
  foreign="$(tr -d '[:space:]' <"$PROBE/foreign.pid")"
  register_sid "$foreign"
}

run_live_controls() {
  local hit partner_hit art_hit run_root_resolved

  # K1 — exact reported-incident filename + wave pid 267 is an external addition, not ours.
  new_probe
  printf '%s\n' "267" >"$PROBE/pids"
  put_file "locks/$SPECIMEN_LOCK" ""
  snapshot_after
  run_pred
  expect "$PRED_RC" "0" "K1 rc"
  expect "$PRED_OUT" "operator-state semantic: no attributable violation" "K1 stdout"

  # K2 — Bun lockf marker {path}.held.{pid}.{rand} is a PID violation.
  new_probe
  printf '%s\n' "267" >"$PROBE/pids"
  put_file "locks/${SPECIMEN_LOCK}.held.267.r1" ""
  snapshot_after
  run_pred
  expect "$PRED_RC" "1" "K2 rc"
  expect_contains "$PRED_OUT" "lock wave pid: 267 locks/${SPECIMEN_LOCK}.held.267.r1" "K2 pid line"

  # K3 — JSON/text: 12670 is not 267; exact 267 is.
  new_probe
  printf '%s\n' "267" >"$PROBE/pids"
  put_file "locks/k3-other.lock" '{"pid": 12670}'
  snapshot_after
  run_pred
  expect "$PRED_RC" "0" "K3a JSON 12670 rc"
  expect "$PRED_OUT" "operator-state semantic: no attributable violation" "K3a JSON 12670 stdout"

  new_probe
  printf '%s\n' "267" >"$PROBE/pids"
  put_file "locks/k3-text.lock" "pid 12670 leftover"
  snapshot_after
  run_pred
  expect "$PRED_RC" "0" "K3b text 12670 rc"

  new_probe
  printf '%s\n' "267" >"$PROBE/pids"
  put_file "locks/k3-hit.lock" '{"pid": 267}'
  snapshot_after
  run_pred
  expect "$PRED_RC" "1" "K3c JSON 267 rc"
  expect_contains "$PRED_OUT" "lock wave pid: 267 locks/k3-hit.lock" "K3c JSON 267 line"

  new_probe
  printf '%s\n' "267" >"$PROBE/pids"
  put_file "locks/k3-hit-text.lock" "pid=267"$'\n'
  snapshot_after
  run_pred
  expect "$PRED_RC" "1" "K3d text 267 rc"
  expect_contains "$PRED_OUT" "lock wave pid: 267 locks/k3-hit-text.lock" "K3d text 267 line"

  # K4 — handle art inside partner is not a sender; exact obligation-art is.
  new_probe
  printf '%s\n' "art" >"$PROBE/handles"
  put_file "locks/$SPECIMEN_LOCK" ""
  put_file "locks/$ART_LOCK" ""
  snapshot_after
  run_pred
  expect "$PRED_RC" "1" "K4 rc"
  partner_hit="lock wave handle: art locks/$SPECIMEN_LOCK"
  art_hit="lock wave handle: art locks/$ART_LOCK"
  expect_absent "$PRED_OUT" "$partner_hit" "K4 partner filename"
  expect_contains "$PRED_OUT" "$art_hit" "K4 exact art sender"

  # K5 — deletion / redirect / global-registry / team-registry still fire.
  expect "$(k5_arm_sha "$SMOKE_ALL")" "$K5_ARM_SHA" "K5 arm bytes"

  new_probe
  printf '%s\n' '{"locks/protected.lease.json": "aaa"}' >"$PROBE/before.json"
  printf '%s\n' '{}' >"$PROBE/after.json"
  run_pred
  expect "$PRED_RC" "1" "K5 deletion rc"
  expect_contains "$PRED_OUT" "protected operator state deleted: locks/protected.lease.json" "K5 deletion line"

  new_probe
  printf '%s\n' "bus/payloads/x.md" >"$PROBE/redirected"
  put_file "bus/payloads/x.md" "hello"
  snapshot_after
  run_pred
  expect "$PRED_RC" "1" "K5 redirect rc"
  expect_contains "$PRED_OUT" "redirected-path: bus/payloads/x.md" "K5 redirect line"

  new_probe
  run_root_resolved="$("$PY" -B -c "import pathlib,sys; print(pathlib.Path(sys.argv[1]).resolve())" "$PROBE/runroot")"
  put_file "global-registry.json" "{\"teams\": {\"t\": {\"root\": $(
    "$PY" -B -c "import json,sys; print(json.dumps(sys.argv[1]))" "$run_root_resolved"
  ), \"registry_location\": $(
    "$PY" -B -c "import json,sys; print(json.dumps(sys.argv[1]))" "$PROBE/runroot"
  )}}}"
  snapshot_after
  run_pred
  expect "$PRED_RC" "1" "K5 global-registry rc"
  expect_contains "$PRED_OUT" "global-registry wave-root: t $run_root_resolved" "K5 global-registry line"

  new_probe
  printf '%s\n' "wavehandle" >"$PROBE/handles"
  put_file "locks/team-registry.json" '{"seats": {"wavehandle": {}}}'
  snapshot_after
  run_pred
  expect "$PRED_RC" "1" "K5 team-registry rc"
  expect_contains "$PRED_OUT" "team-registry wave handle: wavehandle locks/team-registry.json" "K5 team-registry line"

  # An unrelated registration must not blame unchanged historical rows.
  new_probe
  put_file "global-registry.json" '{"teams":{"old":{"root":"/missing-historical-root"}}}'
  snapshot_after
  cp "$PROBE/after.json" "$PROBE/before.json"
  put_file "global-registry.json" "{\"teams\":{\"old\":{\"root\":\"/missing-historical-root\"},\"operator\":{\"root\":\"$PROBE/oproot\",\"registry_location\":\"$PROBE/oproot/global-registry.json\"}}}"
  snapshot_after
  run_pred
  expect "$PRED_RC" 0 "unchanged dangling global row is not attributed"
  put_file "global-registry.json" '{"teams":{"old":{"root":"/changed-missing-root"}}}'
  snapshot_after
  run_pred
  expect "$PRED_RC" 1 "changed dangling global row still fails"
  expect_contains "$PRED_OUT" 'global-registry non-seat root: old' "changed global row witness"

  new_probe
  printf '%s\n' wavehandle >"$PROBE/handles"
  put_file "team-registry.json" '{"seats":{"wavehandle":{"pane":"old"}}}'
  snapshot_after
  cp "$PROBE/after.json" "$PROBE/before.json"
  put_file "team-registry.json" '{"seats":{"wavehandle":{"pane":"old"},"operator":{"pane":"new"}}}'
  snapshot_after
  run_pred
  expect "$PRED_RC" 0 "unchanged team row is not attributed"
  put_file "team-registry.json" '{"seats":{"wavehandle":{"pane":"changed"}}}'
  snapshot_after
  run_pred
  expect "$PRED_RC" 1 "changed team row remains attributable"
  expect_contains "$PRED_OUT" 'team-registry wave handle: wavehandle' "changed team row witness"
  put_file "team-registry.json" '{"seats":[]}'
  snapshot_after
  run_pred
  expect "$PRED_RC" 1 "malformed changed team registry fails"

  printf '{"seats":{"bad":"\377"}}' >"$PROBE/oproot/team-registry.json"
  snapshot_after
  run_pred
  expect "$PRED_RC" 1 "invalid UTF-8 registry fails"
  expect_contains "$PRED_OUT" 'operator-state unreadable:' "invalid UTF-8 diagnostic"

  cp "$PROBE/after.json" "$PROBE/before.json"
  printf '{"seats":{"bad":"\376"}}' >"$PROBE/oproot/team-registry.json"
  snapshot_after
  run_pred
  expect "$PRED_RC" 1 "different invalid UTF-8 bodies remain a changed file"
  expect_contains "$PRED_OUT" 'operator-state unreadable:' "changed invalid UTF-8 diagnostic"

  new_probe
  run_root_resolved="$("$PY" -B -c "import pathlib,sys; print(pathlib.Path(sys.argv[1]).resolve())" "$PROBE/runroot")"
  put_file "team-registry.json" "{\"team\":{\"worktree_root\":\"$run_root_resolved\"},\"seats\":{}}"
  snapshot_after
  run_pred
  expect "$PRED_RC" 1 "new team metadata root is attributable with no seats"
  expect_contains "$PRED_OUT" 'team-registry wave-root:' "metadata root witness"
  cp "$PROBE/after.json" "$PROBE/before.json"
  put_file "team-registry.json" "{\"team\":{\"worktree_root\":\"$run_root_resolved\"},\"seats\":{\"operator\":{}}}"
  snapshot_after
  run_pred
  expect "$PRED_RC" 0 "unchanged metadata root is not blamed for a new seat"

  # K6 — real wave pane + %id; pane-key match notes, rc 0. No handle match.
  new_probe
  printf '%s\n' "demo/driver:0.0" "%81" >"$PROBE/panes"
  put_file "locks/pane-submit-demo_driver_0.0.lock" ""
  put_file "locks/pane-submit-_81.lock" ""
  snapshot_after
  run_pred
  expect "$PRED_RC" "0" "K6 rc"
  expect_contains "$PRED_OUT" "operator-state semantic: no attributable violation" "K6 success"
  expect_contains "$PRED_OUT" "note lock pane-key match (server identity not recorded in lock artifacts; pane targets recycle across servers): demo/driver:0.0 locks/pane-submit-demo_driver_0.0.lock" "K6 session pane"
  expect_contains "$PRED_OUT" "note lock pane-key match (server identity not recorded in lock artifacts; pane targets recycle across servers): %81 locks/pane-submit-_81.lock" "K6 percent pane"
  expect_absent "$PRED_OUT" "lock wave pane:" "K6 no pane violation"

  # KEEP — reviewer scenario: tap/rebound:0.0 lock, empty pids/handles/roots, no held marker.
  new_probe
  printf '%s\n' "tap/rebound:0.0" >"$PROBE/panes"
  put_file "locks/pane-submit-tap_rebound_0.0.lock" ""
  snapshot_after
  run_pred
  expect "$PRED_RC" "0" "KEEP rc"
  expect_contains "$PRED_OUT" "operator-state semantic: no attributable violation" "KEEP success"
  expect_contains "$PRED_OUT" "note lock pane-key match (server identity not recorded in lock artifacts; pane targets recycle across servers): tap/rebound:0.0 locks/pane-submit-tap_rebound_0.0.lock" "KEEP note"
  expect_absent "$PRED_OUT" "lock wave pane:" "KEEP no pane violation"

  # K7 — foreign pane index and prefix are not wave panes.
  new_probe
  printf '%s\n' "demo/driver:0.0" "%81" >"$PROBE/panes"
  put_file "locks/pane-submit-demo_driver_0.1.lock" ""
  put_file "locks/pane-submit-demo_drivers_0.0.lock" ""
  snapshot_after
  run_pred
  expect "$PRED_RC" "0" "K7 rc"
  expect "$PRED_OUT" "operator-state semantic: no attributable violation" "K7 stdout"

  # K8 — structural held pid 267 vs 1267.
  new_probe
  printf '%s\n' "267" >"$PROBE/pids"
  printf '%s\n' "demo/driver:0.0" >"$PROBE/panes"
  put_file "locks/pane-submit-demo_driver_0.0.lock.held.267.k3x9" ""
  snapshot_after
  run_pred
  expect "$PRED_RC" "1" "K8a rc"
  expect_contains "$PRED_OUT" "lock wave pid: 267 locks/pane-submit-demo_driver_0.0.lock.held.267.k3x9" "K8a held 267"
  expect_absent "$PRED_OUT" "lock wave pane:" "K8a pane note is not the red"

  new_probe
  printf '%s\n' "1267" >"$PROBE/pids"
  printf '%s\n' "demo/driver:0.0" >"$PROBE/panes"
  put_file "locks/pane-submit-demo_driver_0.0.lock.held.267.k3x9" ""
  snapshot_after
  run_pred
  expect "$PRED_RC" "0" "K8b rc (pane key notes; held pid is not wave)"
  expect_absent "$PRED_OUT" "lock wave pid: 1267 " "K8b pid 1267 silent"
  expect_contains "$PRED_OUT" "operator-state semantic: no attributable violation" "K8b success"
  expect_contains "$PRED_OUT" "note lock pane-key match (server identity not recorded in lock artifacts; pane targets recycle across servers): demo/driver:0.0 locks/pane-submit-demo_driver_0.0.lock.held.267.k3x9" "K8b pane-key note"
  expect_absent "$PRED_OUT" "lock wave pane:" "K8b no pane violation"

  new_probe
  printf '%s\n' "267" >"$PROBE/pids"
  put_file "locks/pane-submit-demo_driver_0.0.lock.held.1267.k3x9" ""
  snapshot_after
  run_pred
  expect "$PRED_RC" "0" "K8c held 1267 vs pid 267 rc"
  expect "$PRED_OUT" "operator-state semantic: no attributable violation" "K8c stdout"

  # K9 — sanitizer-equality recovers the raw pane inside the note, not a red.
  new_probe
  printf '%s\n' "demo/driver:0.0" >"$PROBE/panes"
  put_file "locks/pane-submit-demo_driver_0.0.lock" ""
  snapshot_after
  run_pred
  expect "$PRED_RC" "0" "K9 rc"
  expect_contains "$PRED_OUT" "operator-state semantic: no attributable violation" "K9 success"
  expect_contains "$PRED_OUT" "note lock pane-key match (server identity not recorded in lock artifacts; pane targets recycle across servers): demo/driver:0.0 locks/pane-submit-demo_driver_0.0.lock" "K9 note polarity"
  expect_absent "$PRED_OUT" "lock wave pane:" "K9 no pane violation"
  k9_foreign="$("$PY" -B -c 'import re; print(re.sub(r"[^A-Za-z0-9_.-]", "_", "demo:driver/0.0"))')"
  expect "$k9_foreign" "demo_driver_0.0" "K9 foreign raw sanitizes to the same key"

  # Production notice keys are not canonical minted ids; their shape cannot
  # distinguish an escaped fixture from concurrent courier traffic.
  for notice in alice-20260901T160603Z-aaaaaaaaaaaa-delivery-unconfirmed courier-20260901T160603Z-bbbbbbbbbbbb-alice-delivery-unconfirmed; do
    new_probe
    printf '%s\n' alice >"$PROBE/handles"
    printf '%s\n' 267 >"$PROBE/pids"
    put_file "locks/obligation-$notice.lock" ""
    snapshot_after
    run_pred
    expect "$PRED_RC" "0" "notice key alone is not a wave witness"
    expect_absent "$PRED_OUT" "lock wave handle:" "notice has no inferred sender"
    expect_absent "$PRED_OUT" "lock wave pid:" "notice has no pid witness"
    put_file "locks/obligation-$notice.lock.held.267.r1" ""
    snapshot_after
    run_pred
    expect "$PRED_RC" "1" "notice held by a wave pid still fails"
    expect_contains "$PRED_OUT" "lock wave pid: 267" "notice holder witness"
  done

  # K11a — shapeless custom id (s1) is non-minted, not a handle.
  new_probe
  printf '%s\n' "art" >"$PROBE/handles"
  printf '%s\n' "267" >"$PROBE/pids"
  put_file "locks/obligation-s1.lock" ""
  snapshot_after
  run_pred
  expect "$PRED_RC" "0" "K11a rc"
  expect_contains "$PRED_OUT" "note lock non-minted obligation id (no wave witness from key): s1 locks/obligation-s1.lock" "K11a non-minted"

  # K11b — panel alice-stamp-fresh001 is non-minted; held suffix still attributes pid.
  # alice is in the census so a custom-key prefix inference would be visible.
  new_probe
  printf '%s\n' "art" "alice" >"$PROBE/handles"
  printf '%s\n' "267" >"$PROBE/pids"
  put_file "locks/obligation-alice-20260901T160603Z-fresh001.lock" ""
  snapshot_after
  run_pred
  expect "$PRED_RC" "0" "K11b rc"
  expect_contains "$PRED_OUT" "note lock non-minted obligation id (no wave witness from key): alice-20260901T160603Z-fresh001 locks/obligation-alice-20260901T160603Z-fresh001.lock" "K11b non-minted"
  expect_absent "$PRED_OUT" "lock wave handle: alice " "K11b no sender inference"

  new_probe
  printf '%s\n' "art" "alice" >"$PROBE/handles"
  printf '%s\n' "267" >"$PROBE/pids"
  put_file "locks/obligation-alice-20260901T160603Z-fresh001.lock.held.267.r1" ""
  snapshot_after
  run_pred
  expect "$PRED_RC" "1" "K11b-held rc"
  expect_contains "$PRED_OUT" "note lock non-minted obligation id (no wave witness from key): alice-20260901T160603Z-fresh001 locks/obligation-alice-20260901T160603Z-fresh001.lock.held.267.r1" "K11b-held non-minted"
  expect_contains "$PRED_OUT" "lock wave pid: 267 locks/obligation-alice-20260901T160603Z-fresh001.lock.held.267.r1" "K11b-held pid"

  # K11c — t1, no stamp.
  new_probe
  printf '%s\n' "art" >"$PROBE/handles"
  printf '%s\n' "267" >"$PROBE/pids"
  put_file "locks/obligation-t1.lock" ""
  snapshot_after
  run_pred
  expect "$PRED_RC" "0" "K11c rc"
  expect_contains "$PRED_OUT" "note lock non-minted obligation id (no wave witness from key): t1 locks/obligation-t1.lock" "K11c non-minted"

  # K11-inverse-1 — minted non-wave sender is concurrent operator traffic.
  new_probe
  printf '%s\n' "art" >"$PROBE/handles"
  printf '%s\n' "267" >"$PROBE/pids"
  put_file "locks/obligation-alice-20260901T160603Z-aaaaaaaaaaaa.lock" ""
  snapshot_after
  run_pred
  expect "$PRED_RC" "0" "K11-inverse-1 rc"
  expect "$PRED_OUT" "operator-state semantic: no attributable violation" "K11-inverse-1 stdout"

  # K11-inverse-2 — minted art is handle-only; K4 fixture byte-preserved.
  new_probe
  printf '%s\n' "art" >"$PROBE/handles"
  put_file "locks/$ART_LOCK" ""
  snapshot_after
  run_pred
  expect "$PRED_RC" "1" "K11-inverse-2 rc"
  expect_contains "$PRED_OUT" "lock wave handle: art locks/$ART_LOCK" "K11-inverse-2 handle"
  expect_absent "$PRED_OUT" "note lock non-minted obligation id (no wave witness from key): " "K11-inverse-2 not non-minted"

  # K12 — acquireRegistryLock/acquirePathLock held markers parse pid structurally.
  new_probe
  printf '%s\n' "267" >"$PROBE/pids"
  put_file "locks/registry.json.lock.held.267.r1" ""
  snapshot_after
  run_pred
  expect "$PRED_RC" "1" "K12a registry held rc"
  expect_contains "$PRED_OUT" "lock wave pid: 267 locks/registry.json.lock.held.267.r1" "K12a registry held pid"

  new_probe
  printf '%s\n' "267" >"$PROBE/pids"
  put_file "locks/reset.fence.json.lock.held.267.r1" ""
  snapshot_after
  run_pred
  expect "$PRED_RC" "1" "K12b path held rc"
  expect_contains "$PRED_OUT" "lock wave pid: 267 locks/reset.fence.json.lock.held.267.r1" "K12b path held pid"

  new_probe
  printf '%s\n' "1267" >"$PROBE/pids"
  put_file "locks/registry.json.lock.held.267.r1" ""
  snapshot_after
  run_pred
  expect "$PRED_RC" "0" "K12c held 267 vs pid 1267 rc"
  expect "$PRED_OUT" "operator-state semantic: no attributable violation" "K12c stdout"

  new_probe
  printf '%s\n' "267" >"$PROBE/pids"
  put_file "locks/registry.json.lock" ""
  snapshot_after
  run_pred
  expect "$PRED_RC" "0" "K12d unheld registry lock rc"
  expect "$PRED_OUT" "operator-state semantic: no attributable violation" "K12d stdout"

  # P — wave-session child held marker is attributed after census.
  new_probe
  start_wave_child "$P_HELD_SCRIPT"
  wait_file "$PROBE/child.pid" || fail "P child pid file missing"
  child="$(tr -d '[:space:]' <"$PROBE/child.pid")"
  sid="$(head -n 1 "$PROBE/pids")"
  register_sid "$sid"
  snapshot_after
  run_census
  expect "$(recorded_pid "$child")" "yes" "P census recorded child pid"
  run_pred
  expect "$PRED_RC" "1" "P rc"
  expect_contains "$PRED_OUT" "lock wave pid: $child locks/p-child.lock.held.$child.r1" "P child held"
  stop_session "$sid" "$child"

  # A new holder forks only after the census. Keep the original session ids:
  # a censused descendant starting a new session must not become a wave root.
  for mode in stay escape reused; do
    new_probe
    P_LATE_ESCAPE="$mode" start_wave_child "$P_LATE_SCRIPT"
    wave_launcher=$!
    wait_file "$PROBE/child.ready" || fail "late fork barrier missing"
    sid="$(head -n 1 "$PROBE/pids")"
    register_sid "$sid"
    cp "$PROBE/pids" "$PROBE/sessions"
    run_census
    : >"$PROBE/child.fork"
    wait_file "$PROBE/child.pid" || fail "late child pid missing"
    child="$(cat "$PROBE/child.pid")"
    # Production attribution runs after all worker leaders have returned.
    [ "$mode" = reused ] || wait "$wave_launcher"
    child_sid="$("$PY" -B -c 'import os,sys; print(os.getsid(int(sys.argv[1])))' "$child")"
    register_sid "$child_sid"
    expect "$(recorded_pid "$child")" no "late child absent from original census"
    snapshot_after
    PRED_SESSIONS="$PROBE/sessions" run_pred
    if [ "$mode" = stay ]; then
      expect "$PRED_RC" 1 "late holder in recorded session is attributed"
      expect_contains "$PRED_OUT" "lock wave pid: $child" "late holder witness"
    else
      expect "$PRED_RC" 0 "$mode session supplies no new wave authority"
    fi
    stop_session "$child_sid" "$child"
    [ "$child_sid" = "$sid" ] || stop_session "$sid"
  done

  # P2 — same class of child pid inside changed lease JSON (content loop).
  new_probe
  start_wave_child "$P2_JSON_SCRIPT"
  wait_file "$PROBE/child.pid" || fail "P2 child pid file missing"
  child="$(tr -d '[:space:]' <"$PROBE/child.pid")"
  sid="$(head -n 1 "$PROBE/pids")"
  register_sid "$sid"
  snapshot_after
  run_census
  expect "$(recorded_pid "$child")" "yes" "P2 census recorded child pid"
  run_pred
  expect "$PRED_RC" "1" "P2 rc"
  expect_contains "$PRED_OUT" "lock wave pid: $child locks/p2.lease.json.lock" "P2 child json"
  stop_session "$sid" "$child"

  # KEEP-foreign — live pid in a foreign session is not a wave actor.
  new_probe
  start_foreign_sleeper
  put_file "locks/foreign.lock.held.$foreign.r1" ""
  snapshot_after
  run_census
  expect "$(recorded_pid "$foreign")" "no" "KEEP-foreign census skipped foreign sid"
  run_pred
  expect "$PRED_RC" "0" "KEEP-foreign rc"
  expect "$PRED_OUT" "operator-state semantic: no attributable violation" "KEEP-foreign stdout"
  stop_session "$foreign"

  # KEEP-dead — marker naming a dead pid is unattributable.
  new_probe
  dead=""
  for cand in 999999 999998 999997; do
    if ! ps -p "$cand" >/dev/null 2>&1; then
      dead="$cand"
      break
    fi
  done
  [ -n "$dead" ] || fail "KEEP-dead: no unused sentinel pid"
  put_file "locks/dead.lock.held.$dead.r1" ""
  snapshot_after
  run_census
  expect "$(recorded_pid "$dead")" "no" "KEEP-dead census skipped dead pid"
  run_pred
  expect "$PRED_RC" "0" "KEEP-dead rc"
  expect "$PRED_OUT" "operator-state semantic: no attributable violation" "KEEP-dead stdout"
}

mutate_copy() { # <path> <before> <after> — the anchor must occur exactly once (applied-mutant check)
  BEFORE="$2" AFTER="$3" "$PY" -B - "$1" <<'PY'
import os, pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
before, after = os.environ["BEFORE"], os.environ["AFTER"]
if text.count(before) != 1:
    raise SystemExit(f"mutation anchor count={text.count(before)} for {before!r}")
path.write_text(text.replace(before, after), encoding="utf-8")
PY
}

run_mutant() {
  local name="$1" before="$2" after="$3" tree out rc=0
  tree="$WORK/mutant-$name"
  mkdir -p "$tree/scripts"
  cp "$ROOT/scripts/smoke-all.sh" "$tree/scripts/smoke-all.sh"
  mutate_copy "$tree/scripts/smoke-all.sh" "$before" "$after"
  out="$WORK/mutant-$name.out"
  set +e
  (
    SMOKE_ALL="$tree/scripts/smoke-all.sh"
    run_live_controls
  ) >"$out" 2>&1
  rc=$?
  set -e
  sweep_wave_sessions
  assert_no_wave_sessions "mutant $name"
  if [ "$rc" -eq 0 ]; then
    echo "operator-state-predicate: mutant $name SURVIVED" >&2
    cat "$out" >&2
    exit 1
  fi
  echo "operator-state-predicate: mutant $name proven RED"
}

# A census mutant is proven RED only when its effect reaches the predicate: the
# arm asserts the INVERTED census result, then runs the predicate and asserts the
# INVERTED outcome (silence for a dropped census, a foreign attribution for a
# dropped sid filter), then stops its own helper. A body that cannot show the
# wrong outcome end-to-end is reported as not RED. Registered sids survive the
# subshell (file registry), so the sweep and the census arm still run afterwards.
m_alpha_arm() { # census dropped: content PID is never recorded, so its attribution stays silent
  local child sid
  new_probe
  start_wave_child "$P2_JSON_SCRIPT"
  wait_file "$PROBE/child.pid" || fail "M-alpha child pid file missing"
  child="$(tr -d '[:space:]' <"$PROBE/child.pid")"
  sid="$(head -n 1 "$PROBE/pids")"
  register_sid "$sid"
  snapshot_after
  run_census
  expect "$(recorded_pid "$child")" "no" "M-alpha census left the child unrecorded"
  run_pred
  expect "$PRED_RC" "0" "M-alpha predicate silent rc"
  expect "$PRED_OUT" "operator-state semantic: no attributable violation" "M-alpha predicate silent stdout"
  stop_session "$sid" "$child"
}

m_beta_arm() { # sid filter dropped: the foreign sleeper is recorded and the predicate blames it
  local foreign
  new_probe
  start_foreign_sleeper
  put_file "locks/foreign.lock.held.$foreign.r1" ""
  snapshot_after
  run_census
  expect "$(recorded_pid "$foreign")" "yes" "M-beta census recorded the foreign pid"
  run_pred
  expect "$PRED_RC" "1" "M-beta predicate red rc"
  expect_contains "$PRED_OUT" "lock wave pid: $foreign locks/foreign.lock.held.$foreign.r1" "M-beta foreign attributed"
  stop_session "$foreign"
}

run_mutant_census() { # <name> <before> <after> <arm-fn>
  local name="$1" before="$2" after="$3" arm="$4" tree out rc=0
  tree="$WORK/mutant-$name"
  mkdir -p "$tree/scripts"
  cp "$ROOT/scripts/smoke-all.sh" "$tree/scripts/smoke-all.sh"
  mutate_copy "$tree/scripts/smoke-all.sh" "$before" "$after"
  out="$WORK/mutant-$name.out"
  set +e
  (
    SMOKE_ALL="$tree/scripts/smoke-all.sh"
    "$arm"
  ) >"$out" 2>&1
  rc=$?
  set -e
  sweep_wave_sessions
  assert_no_wave_sessions "mutant $name"
  if [ "$rc" -ne 0 ]; then
    echo "operator-state-predicate: mutant $name NOT RED — named predicate outcome not reached" >&2
    cat "$out" >&2
    exit 1
  fi
  echo "operator-state-predicate: mutant $name proven RED (named predicate outcome reached)"
}

# Unmodified scratch must stay green so a copy error cannot mint fake REDs.
BASE="$WORK/base"
mkdir -p "$BASE/scripts"
cp "$SMOKE_ALL" "$BASE/scripts/smoke-all.sh"
(
  SMOKE_ALL="$BASE/scripts/smoke-all.sh"
  run_live_controls
) || {
  echo "operator-state-predicate: unmodified scratch failed (not a mutant)" >&2
  exit 1
}
echo "operator-state-predicate: scratch baseline green"

PASS=0
EXPECT=0
run_live_controls
expect "$(registry_state)" "nonempty" "live controls registered helper sids"

run_mutant pid-text-substring \
  'pid_in_text(text, pid)' \
  'pid in text'
expect "$(registry_state)" "empty" "registry reset after first mutant census"
run_mutant handle-name-substring \
  'sender == handle' \
  'handle in path.name'
run_mutant m5-pane-handle-boundary \
  'PANE_LOCK_NAME.fullmatch(path.name)' \
  'None'
run_mutant m6-pane-key-prefix \
  'sanitize_key(pane) == key' \
  'key.startswith(sanitize_key(pane).rsplit(".", 1)[0])'
run_mutant m7-held-regex-loosen \
  'LOCK_HELD_SUFFIX = r"\.held\.(\d+)\.([0-9a-z]{1,8})"' \
  'LOCK_HELD_SUFFIX = r"\.held\.(.+)"'
run_mutant m11-minted-hex-loosen \
  '([0-9a-f]{12})' \
  '([A-Za-z0-9]+)'
run_mutant m12-attribute-all-obligation \
  'if not minted_m:' \
  'if True:'
run_mutant m13-drop-held-from-family \
  'rf"^obligation-(.+)\.lock(?:{LOCK_HELD_SUFFIX})?$"' \
  'r"^obligation-(.+)\.lock$"'
run_mutant m14-generic-held-drop \
  'generic_held_m = None if pane_m or obl_m else GENERIC_HELD.fullmatch(path.name)' \
  'generic_held_m = None'
run_mutant k11b-infer-sender \
  'notes.append(f"note lock non-minted obligation id (no wave witness from key): {key} {rel}")' \
  'notes.append(f"note lock non-minted obligation id (no wave witness from key): {key} {rel}")
                for handle in sorted(handles):
                    if key == handle or key.startswith(handle + "-"):
                        violations.append(f"lock wave handle: {handle} {rel}")'
run_mutant m-a-restore-pane-violation \
  'notes.append(f"note lock pane-key match (server identity not recorded in lock artifacts; pane targets recycle across servers): {pane} {rel}")' \
  'violations.append(f"lock wave pane: {pane} {rel}")'
run_mutant m-b-drop-pane-note \
  'notes.append(f"note lock pane-key match (server identity not recorded in lock artifacts; pane targets recycle across servers): {pane} {rel}")' \
  'pass'
run_mutant_census m-alpha-drop-census \
  'if os.getsid(pid) in sids:' \
  'if False:' \
  m_alpha_arm
run_mutant_census m-beta-drop-sid-filter \
  'if os.getsid(pid) in sids:' \
  'if True:' \
  m_beta_arm

run_mutant m-restore-custom-attribution \
  'notes.append(f"note lock non-minted obligation id (no wave witness from key): {key} {rel}")' \
  'violations.append(f"lock non-minted obligation id: {key} {rel}")'

run_mutant m-late-holder-snapshot-only \
  'return str(sid) in sessions' \
  'return False'

run_mutant m-descendant-is-not-session-authority \
  'return str(sid) in sessions' \
  'return str(sid) in pids'

run_mutant m-reused-session-leader \
  'return False  # live leader supplies no new wave evidence' \
  'return str(sid) in sessions'

sweep_wave_sessions
assert_no_wave_sessions "post-mutants"
echo "operator-state-predicate: $PASS pass / 0 fail / $EXPECT expect() — live controls green; 19 mutants proven RED; helper sessions swept"