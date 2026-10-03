#!/usr/bin/env bash
# tap-de02 — `tap team attach` plans ordered tab viewers for unattached seats,
# snapshots every live seat, and never crosses into session lifecycle behavior.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
CONTRACT="$ROOT/skills/tap/protocol/delivery/cli-surface-the-whole-thing-part-09.md"
WORK="$(mktemp -d)"
FAKE_BIN="$(mktemp -d)"
TEAM_ROOT="$WORK/demo"
export TAP_HOME="$TEAM_ROOT/.tap/bus"
export PATH="$FAKE_BIN:$PATH"
export LIVE_SESSIONS="$WORK/live-sessions"
export TMUX_LOG="$WORK/tmux.log"
export OSASCRIPT_LOG="$WORK/osascript.log"
export OSASCRIPT_INPUT="$WORK/osascript-input"
export OSASCRIPT_TARGETS="$WORK/osascript-targets"
export VIEWER_READER="$WORK/viewer-reader.py"
export TEAM_ROOT FAKE_BIN
export TAP_TMUX_SOCKET_PATH="$WORK/selected.sock"
# Decode commands rather than pinning obsolete AppleScript variable names and
# quoting. CLI part-09 requires shell startup, team cwd and one exact socket.
cat > "$VIEWER_READER" <<'VIEWER_PY'
import json, os, re, shlex, sys
text = open(sys.argv[1]).read() if len(sys.argv) > 1 else sys.stdin.read()
titles = {int(n): json.loads(value) for n, value in re.findall(r'set name of p(\d+) to (".*")', text)}
commands = re.findall(r'tell p(\d+) to write text (".*")', text)
assert commands, text
for i, (n, encoded) in enumerate(commands, 1):
    assert int(n) == i, commands
    outer = shlex.split(json.loads(encoded))
    assert outer[:2] == ['/bin/sh', '-c'] and len(outer) == 3, outer
    inner = shlex.split(outer[2])
    assert inner[:4] == ['unset', 'TMUX', 'TMUX_PANE;', 'cd'], inner
    assert inner[4] == os.environ['TEAM_ROOT'], inner
    assert inner[5:12] == ['&&', 'exec', os.environ['FAKE_BIN'] + '/tmux', '-S', os.path.realpath(os.environ['TAP_TMUX_SOCKET_PATH']), 'attach-session', '-t'], inner
    assert len(inner) == 13 and inner[12] == '=demo/' + titles[i], inner
    print(inner[12])
startups = re.findall(r'with default profile command (".*")\)', text)
assert len(startups) == len(commands), startups
for encoded in startups:
    outer = shlex.split(json.loads(encoded))
    assert outer[:2] == ['/bin/sh', '-c'] and len(outer) == 3, outer
    inner = shlex.split(outer[2])
    assert inner[:7] == ['unset', 'TMUX', 'TMUX_PANE;', 'cd', os.environ['TEAM_ROOT'], '&&', 'exec'], inner
    assert inner[-1] == '-l' and 'attach-session' not in inner, inner
VIEWER_PY
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT

mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$WORK/elsewhere"
printf '%s\n' demo/a demo/b demo/c demo/d demo/e demo/f demo/g >"$LIVE_SESSIONS"

${TAP_PYTHON:-python3} -B - "$TAP_HOME/registry.json" "$TEAM_ROOT" <<'PY'
import json
import sys

registry, cwd = sys.argv[1:]
rows = {}
for handle in "abcdefg":
    rows[handle] = {
        "status": "active",
        "delivery": "pane",
        "session": f"demo/{handle}",
        "harness": "codex",
        "registered_from_worktree": cwd,
        "base": "demo",
        "tag": handle,
        "index": 1,
    }
rows.update({
    "h": {
        "status": "active",
        "delivery": "pane",
        "session": "demo/h",
        "harness": "opencode",
        "registered_from_worktree": cwd,
        "base": "demo",
        "tag": "h",
        "index": 1,
        "harness_session_id": "native-h",
    },
    "i": {
        "status": "active",
        "delivery": "pane",
        "session": "demo/i",
        "harness": "cursor",
        "registered_from_worktree": cwd,
        "base": "demo",
        "tag": "i",
        "index": 1,
    },
})
with open(registry, "w", encoding="utf-8") as fh:
    json.dump({"schema": "0.20", "team": {"name": "demo", "worktree_root": cwd}, "seats": rows}, fh)
    fh.write("\n")
PY
# Born live (F2a): the session scope resolves through an enrolled team.
printf '{"schema":"0.20","teams":{"demo":{"root":"%s","registry_location":"%s","state":"registered"}}}\n' \
  "$(cd "$TEAM_ROOT" && pwd -P)" "$(cd "$TAP_HOME" && pwd -P)/registry.json" > "${TAP_INDEX_HOME:?}/global-registry.json"

cat >"$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
while [[ "${1:-}" == -S || "${1:-}" == -L ]]; do shift 2; done
cmd="${1:-}"
shift || true
{
  printf '%s' "$cmd"
  for arg in "$@"; do printf ' %s' "$arg"; done
  printf '\n'
} >>"$TMUX_LOG"

case "$cmd" in
  list-sessions)
    cat "$LIVE_SESSIONS"
    ;;
  list-clients)
    target=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -t) target="${2:-}"; shift 2 ;;
        -F) shift 2 ;;
        *) shift ;;
      esac
    done
    [ "${FAIL_CLIENT_TARGET:-}" != "$target" ] || exit 1
    [ "$target" != "=demo/b" ] || printf '%s\n' /dev/ttys010
    if [ -e "$OSASCRIPT_INPUT" ] \
      && grep -Fxq "$target" "$OSASCRIPT_TARGETS" \
      && [ "${NO_NEW_CLIENT_TARGET:-}" != "$target" ]; then
      if [ "${DELAY_NEW_CLIENT_TARGET:-}" = "$target" ]; then
        probe_count="$(grep -Fxc "list-clients -t $target -F #{client_tty}" "$TMUX_LOG" || true)"
        [ "$probe_count" -ge 3 ] || exit 0
      fi
      printf '/dev/tap-%s\n' "${target#=demo/}"
    fi
    ;;
  list-panes)
    # The session catalog asks which sessions still hold a live pane: one live
    # pane per fixture session.
    while IFS= read -r session; do printf '%s\t0\n' "$session"; done <"$LIVE_SESSIONS"
    ;;
  *)
    exit 0
    ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

cat >"$FAKE_BIN/osascript" <<'OSASCRIPT'
#!/usr/bin/env bash
set -euo pipefail
{
  printf 'osascript'
  for arg in "$@"; do printf ' %s' "$arg"; done
  printf '\n'
} >>"$OSASCRIPT_LOG"

case "${1:-}" in
  -e)
    [ "${ITERM_CAPABLE:-1}" = 1 ] || exit 1
    printf '%s\n' com.googlecode.iterm2
    ;;
  -)
    cat >"$OSASCRIPT_INPUT"
    python3 "$VIEWER_READER" "$OSASCRIPT_INPUT" > "$OSASCRIPT_TARGETS"
    exit "${OSASCRIPT_EXEC_RC:-0}"
    ;;
  *)
    exit 1
    ;;
esac
OSASCRIPT
chmod +x "$FAKE_BIN/osascript"

reset_logs() {
  : >"$TMUX_LOG"
  : >"$OSASCRIPT_LOG"
  rm -f "${OSASCRIPT_INPUT:?}" "${OSASCRIPT_TARGETS:?}"
}

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  [[ "$haystack" == *"$needle"* ]] || {
    echo "team-attach: missing $label: $needle" >&2
    printf '%s\n' "$haystack" >&2
    exit 1
  }
}

# (0) Session scope follows the explicit bus team, not an unrelated shell cwd.
reset_logs
rc=0
scoped="$(cd "$WORK/elsewhere" && "$TAP" team attach --dry-run 2>&1)" || rc=$?
[ "$rc" = 0 ] || {
  echo "team-attach: bus-root dry-run exited $rc" >&2
  printf '%s\n' "$scoped" >&2
  cat "$TMUX_LOG" >&2
  exit 1
}
assert_contains "$scoped" "plan for team 'demo' (6 new viewer(s))" "bus-root session scope"
scoped_targets="$(printf '%s\n' "$scoped" | python3 "$VIEWER_READER")"
[ "$scoped_targets" = "$(printf '=demo/%s\n' a c d e f g)" ] || { echo 'team-attach: wrong ordered viewer targets' >&2; exit 1; }
[[ "$scoped" != *"cd '$WORK/elsewhere'"* ]] || {
  echo "team-attach: bus-root plan used the caller cwd instead of the team worktree" >&2
  printf '%s\n' "$scoped" >&2
  exit 1
}
[[ "$scoped" != *"tmux attach -t '=demo/b'"* ]] || {
  echo "team-attach: bus-root plan included already-attached demo/b" >&2
  printf '%s\n' "$scoped" >&2
  exit 1
}
echo "team-attach: (0) explicit TAP_HOME anchors session scope outside the team cwd: ok"

# (1) Capable iTerm path: six unattached live sessions produce one ordered tab
# each, while the attached seat's immutable pre-image is disclosed and skipped.
reset_logs
export ITERM_CAPABLE=1
rc=0
out="$(cd "$TEAM_ROOT" && TERM_PROGRAM=tmux "$TAP" team attach 2>&1)" || rc=$?
[ "$rc" = 0 ] || {
  echo "team-attach: capable path exited $rc" >&2
  printf '%s\n' "$out" >&2
  exit 1
}
[ -s "$OSASCRIPT_INPUT" ] || {
  echo "team-attach: capable path did not execute generated AppleScript" >&2
  exit 1
}
if ! grep -Fq 'split vertically' "$OSASCRIPT_INPUT" \
  && ! grep -Fq 'split horizontally' "$OSASCRIPT_INPUT"; then
  echo "team-attach: default pane layout must split the window into viewer sessions" >&2
  cat "$OSASCRIPT_INPUT" >&2
  exit 1
fi
# Viewer commands preserve order, title, team cwd and socket. The shared Bun
# planner uses p1..pN and login-shell startup; fixed sleeps are not its contract.
[ "$(cat "$OSASCRIPT_TARGETS")" = "$(printf '=demo/%s\n' a c d e f g)" ] || {
  echo 'team-attach: ordered viewer targets drifted' >&2; exit 1
}
for handle in a c d e f g; do
  grep -Fqx "list-clients -t =demo/$handle -F #{client_tty}" "$TMUX_LOG" || {
    echo "team-attach: missing exact client probe for demo/$handle" >&2
    cat "$TMUX_LOG" >&2
    exit 1
  }
done

grep -Fxq "=demo/b" "$OSASCRIPT_TARGETS" && {
  echo "team-attach: already-attached demo/b must not receive another viewer" >&2
  cat "$OSASCRIPT_INPUT" >&2
  exit 1
}
grep -Eq '^  set name of p[0-9]+ to "b"$' "$OSASCRIPT_INPUT" && {
  echo "team-attach: skipped demo/b must not receive a tab title" >&2
  cat "$OSASCRIPT_INPUT" >&2
  exit 1
}
[ "$(grep -Fc 'list-clients -t =demo/b -F #{client_tty}' "$TMUX_LOG")" = 1 ] || {
  echo "team-attach: skipped demo/b should only receive its immutable pre-image probe" >&2
  cat "$TMUX_LOG" >&2
  exit 1
}
assert_contains "$out" "skipped because already attached: b (/dev/ttys010)" "pre-existing client receipt"
assert_contains "$out" "h (resume tier exact" "exact unavailable tier"
assert_contains "$out" "i (resume tier fresh" "fresh unavailable tier"
assert_contains "$out" "verified 6 new iTerm viewer(s) for team 'demo'" "verified viewer receipt"
[[ "$out" != *"opened 6 iTerm viewer"* ]] || {
  echo "team-attach: capable path printed an unverified opened-count" >&2
  printf '%s\n' "$out" >&2
  exit 1
}
grep -Eq 'team up|session (resume|restart)|session launch' "$OSASCRIPT_INPUT" && {
  echo "team-attach: generated viewer script crossed into lifecycle behavior" >&2
  cat "$OSASCRIPT_INPUT" >&2
  exit 1
}
echo "team-attach: (1) ordered tab planner, exact pre-image, and partial receipt: ok"

# (1a) Re-running after the first attach observes every live session as already
# attached and does not send another command or execute another AppleScript.
automation_runs="$(grep -Fxc 'osascript -' "$OSASCRIPT_LOG")"
rc=0
repeat="$(cd "$TEAM_ROOT" && "$TAP" team attach 2>&1)" || rc=$?
[ "$rc" = 0 ] || {
  echo "team-attach: idempotent rerun exited $rc" >&2
  printf '%s\n' "$repeat" >&2
  exit 1
}
[ "$(grep -Fxc 'osascript -' "$OSASCRIPT_LOG")" = "$automation_runs" ] || {
  echo "team-attach: idempotent rerun executed another AppleScript" >&2
  cat "$OSASCRIPT_LOG" >&2
  exit 1
}
[[ "$repeat" != *"tmux attach -t"* ]] || {
  echo "team-attach: idempotent rerun printed an attach command" >&2
  printf '%s\n' "$repeat" >&2
  exit 1
}
assert_contains "$repeat" "all 7 live seat(s) were already attached" "idempotent rerun receipt"
assert_contains "$repeat" "skipped because already attached: a (/dev/tap-a), b (/dev/ttys010)" "idempotent skipped receipt"
echo "team-attach: (1a) repeated attach opens no duplicate viewers: ok"

# (1b) AppleScript success is not attachment proof. Every planned session must
# gain a client relative to the immutable pre-image or the named seat stays loud.
reset_logs
export NO_NEW_CLIENT_TARGET='=demo/c'
rc=0
unverified="$(cd "$TEAM_ROOT" && "$TAP" team attach 2>&1)" || rc=$?
unset NO_NEW_CLIENT_TARGET
[ "$rc" = 1 ] || {
  echo "team-attach: missing-client verification exited $rc, want 1" >&2
  printf '%s\n' "$unverified" >&2
  exit 1
}
assert_contains "$unverified" "no new tmux client observed after 25 bounded probe(s) for: c" "named verification failure"
assert_contains "$unverified" "tmux attach -t '=demo/c'" "verification-failure manual command"
assert_contains "$unverified" "skipped because already attached: b (/dev/ttys010)" "verification-failure pre-image"
assert_contains "$unverified" "h (resume tier exact" "verification-failure exact disclosure"
assert_contains "$unverified" "i (resume tier fresh" "verification-failure fresh disclosure"
[[ "$unverified" != *"verified 6 new iTerm viewer"* ]] || {
  echo "team-attach: missing-client path printed a false verified count" >&2
  printf '%s\n' "$unverified" >&2
  exit 1
}
[ "$(grep -Fc 'list-clients -t =demo/c -F #{client_tty}' "$TMUX_LOG")" = 26 ] || {
  echo "team-attach: demo/c should have one pre-image and 25 bounded post-open probes" >&2
  cat "$TMUX_LOG" >&2
  exit 1
}
echo "team-attach: (1b) post-open proof names every seat without a new client: ok"

# (1c) Structural simulation only: the fake client becomes visible on a later
# probe, pinning early success and retry shape. A real iTerm run proves the race.
reset_logs
export DELAY_NEW_CLIENT_TARGET='=demo/c'
rc=0
delayed="$(cd "$TEAM_ROOT" && "$TAP" team attach 2>&1)" || rc=$?
unset DELAY_NEW_CLIENT_TARGET
[ "$rc" = 0 ] || {
  echo "team-attach: delayed client registration exited $rc, want 0" >&2
  printf '%s\n' "$delayed" >&2
  exit 1
}
assert_contains "$delayed" "verified 6 new iTerm viewer(s) for team 'demo'" "delayed-client verified receipt"
[ "$(grep -Fc 'list-clients -t =demo/c -F #{client_tty}' "$TMUX_LOG")" = 3 ] || {
  echo "team-attach: delayed demo/c client should stop after its first successful re-probe" >&2
  cat "$TMUX_LOG" >&2
  exit 1
}
echo "team-attach: (1c) delayed client registration is observed before failure: ok"

# (2) A machine without drivable iTerm gets copyable commands, not a false error.
reset_logs
export ITERM_CAPABLE=0
rc=0
fallback="$(cd "$TEAM_ROOT" && TERM_PROGRAM=tmux "$TAP" team attach 2>&1)" || rc=$?
[ "$rc" = 0 ] || {
  echo "team-attach: capability fallback exited $rc" >&2
  printf '%s\n' "$fallback" >&2
  exit 1
}
assert_contains "$fallback" "tmux attach -t '=demo/a'" "fallback attach command"
assert_contains "$fallback" "skipped because already attached: b (/dev/ttys010)" "fallback pre-image"
[ ! -e "$OSASCRIPT_INPUT" ] || {
  echo "team-attach: failed capability probe still executed AppleScript" >&2
  cat "$OSASCRIPT_LOG" >&2
  exit 1
}
grep -Fq 'osascript -e id of application "iTerm"' "$OSASCRIPT_LOG" || {
  echo "team-attach: missing iTerm capability probe" >&2
  cat "$OSASCRIPT_LOG" >&2
  exit 1
}
grep -Fqx 'osascript -' "$OSASCRIPT_LOG" && {
  echo "team-attach: capability fallback invoked osascript stdin" >&2
  cat "$OSASCRIPT_LOG" >&2
  exit 1
}
echo "team-attach: (2) unavailable iTerm degrades to commands: ok"

# (2b) A capability-success/execution-failure never prints a false opened
# receipt; it returns the same copyable manual commands.
reset_logs
export ITERM_CAPABLE=1 OSASCRIPT_EXEC_RC=1
rc=0
failed_open="$(cd "$TEAM_ROOT" && "$TAP" team attach 2>&1)" || rc=$?
unset OSASCRIPT_EXEC_RC
[ "$rc" = 1 ] || {
  echo "team-attach: failed iTerm execution exited $rc, want 1" >&2
  printf '%s\n' "$failed_open" >&2
  exit 1
}
assert_contains "$failed_open" "iTerm automation failed" "execution-failure detail"
assert_contains "$failed_open" "tmux attach -t '=demo/a'" "execution-failure manual command"
assert_contains "$failed_open" "skipped because already attached: b (/dev/ttys010)" "execution-failure pre-image"
assert_contains "$failed_open" "h (resume tier exact" "execution-failure exact disclosure"
assert_contains "$failed_open" "i (resume tier fresh" "execution-failure fresh disclosure"
[[ "$failed_open" != *"opened 6 iTerm viewer"* ]] || {
  echo "team-attach: failed iTerm execution printed a false opened receipt" >&2
  printf '%s\n' "$failed_open" >&2
  exit 1
}
echo "team-attach: (2b) iTerm execution failure is loud and never claims opened: ok"

# (3) Dry-run previews the artifact but names its proof boundary.
reset_logs
export ITERM_CAPABLE=1
rc=0
dry="$(cd "$TEAM_ROOT" && TERM_PROGRAM=Cursor "$TAP" team attach --dry-run 2>&1)" || rc=$?
[ "$rc" = 0 ] || {
  echo "team-attach: dry-run exited $rc" >&2
  printf '%s\n' "$dry" >&2
  exit 1
}
assert_contains "$dry" 'tell application "iTerm2"' "dry-run AppleScript"
assert_contains "$dry" "dry-run cannot prove attachment" "dry-run evidence boundary"
[ ! -e "$OSASCRIPT_INPUT" ] || {
  echo "team-attach: dry-run executed AppleScript" >&2
  exit 1
}
echo "team-attach: (3) dry-run previews without claiming attachment: ok"

# (4) Any unobservable exact client probe aborts before terminal automation.
reset_logs
export FAIL_CLIENT_TARGET='=demo/c'
rc=0
blocked="$(cd "$TEAM_ROOT" && "$TAP" team attach 2>&1)" || rc=$?
unset FAIL_CLIENT_TARGET
[ "$rc" = 1 ] || {
  echo "team-attach: failed client probe exited $rc, want 1" >&2
  printf '%s\n' "$blocked" >&2
  exit 1
}
assert_contains "$blocked" "demo/c" "unobservable session name"
assert_contains "$blocked" "no iTerm window was opened" "abort-before-automation detail"
assert_contains "$blocked" "skipped because already attached: b (/dev/ttys010)" "pre-image-failure partial client snapshot"
assert_contains "$blocked" "h (resume tier exact" "pre-image-failure exact disclosure"
assert_contains "$blocked" "i (resume tier fresh" "pre-image-failure fresh disclosure"
[ ! -e "$OSASCRIPT_INPUT" ] || {
  echo "team-attach: failed client probe opened terminal automation" >&2
  exit 1
}
[ ! -s "$OSASCRIPT_LOG" ] || {
  echo "team-attach: failed client probe reached osascript" >&2
  cat "$OSASCRIPT_LOG" >&2
  exit 1
}
echo "team-attach: (4) unobservable pre-image aborts before automation: ok"

# (5) Zero live sessions open nothing and fail after disclosing every known seat.
reset_logs
: >"$LIVE_SESSIONS"
rc=0
none="$(cd "$TEAM_ROOT" && "$TAP" team attach 2>&1)" || rc=$?
[ "$rc" = 1 ] || {
  echo "team-attach: zero-live exited $rc, want 1" >&2
  printf '%s\n' "$none" >&2
  exit 1
}
assert_contains "$none" "h (resume tier exact" "zero-live exact disclosure"
assert_contains "$none" "i (resume tier fresh" "zero-live fresh disclosure"
[ ! -e "$OSASCRIPT_INPUT" ] || {
  echo "team-attach: zero-live opened AppleScript" >&2
  exit 1
}
echo "team-attach: (5) zero live reports all unavailable and opens nothing: ok"

# (6) One live plus unavailable rows is partial success: attach one, disclose all.
reset_logs
printf '%s\n' demo/a >"$LIVE_SESSIONS"
export ITERM_CAPABLE=1
rc=0
partial="$(cd "$TEAM_ROOT" && "$TAP" team attach 2>&1)" || rc=$?
[ "$rc" = 0 ] || {
  echo "team-attach: partial attach exited $rc" >&2
  printf '%s\n' "$partial" >&2
  exit 1
}
[ "$(grep -Fxc "=demo/a" "$OSASCRIPT_TARGETS")" = 1 ] || {
  echo "team-attach: partial case did not attach its one live seat" >&2
  cat "$OSASCRIPT_INPUT" >&2
  exit 1
}
assert_contains "$partial" "h (resume tier exact; next: cd $TEAM_ROOT && tap session resume h)" "partial exact disclosure"
assert_contains "$partial" "i (resume tier fresh; next: cd $TEAM_ROOT && tap session resume i)" "partial fresh disclosure"
echo "team-attach: (6) partial availability attaches all live seats and exits zero: ok"

# (6b) --except (tap-nt4c): spared seats never reach the viewer plan, and the
# receipt names them rather than dropping them. Refusal arms assert error_class
# AND detail — pre-flag code refuses --except as a usage_error too, so only the
# named handle plus the roster discriminates the two.
reset_logs
printf '%s\n' demo/a demo/c demo/d >"$LIVE_SESSIONS"
err_class() { python3 -c 'import json,sys; print(json.loads(sys.argv[1])["error_class"])' "$1"; }
rc=0
spared="$(cd "$TEAM_ROOT" && "$TAP" team attach --dry-run --except c 2>&1)" || rc=$?
[ "$rc" = 0 ] || {
  echo "team-attach: --except dry-run exited $rc" >&2
  printf '%s\n' "$spared" >&2
  exit 1
}
assert_contains "$spared" "plan for team 'demo' (2 new viewer(s))" "--except narrows the plan"
assert_contains "$spared" "tmux attach -t '=demo/a'" "--except keeps unnamed live seats"
assert_contains "$spared" "spared by --except: c (live)" "--except disclosure"
[[ "$spared" != *"tmux attach -t '=demo/c'"* ]] || {
  echo "team-attach: --except c still planned a viewer for demo/c" >&2
  printf '%s\n' "$spared" >&2
  exit 1
}
echo "team-attach: (6b) --except drops the named seat from the plan and discloses it: ok"

# (6c) Sparing every live seat is a legal no-op — exit 0 with the explicit line,
# NOT the "no live seats" failure, which would blame the team for the operator's
# own instruction. Unavailable seats stay disclosed.
reset_logs
printf '%s\n' demo/a demo/c demo/d >"$LIVE_SESSIONS"
rc=0
allspared="$(cd "$TEAM_ROOT" && "$TAP" team attach --except a,c,d 2>&1)" || rc=$?
[ "$rc" = 0 ] || {
  echo "team-attach: all-spared exited $rc, want 0" >&2
  printf '%s\n' "$allspared" >&2
  exit 1
}
assert_contains "$allspared" "no seats matched after exclusions" "all-spared no-op line"
assert_contains "$allspared" "h (resume tier exact" "all-spared keeps unavailable disclosure"
[ ! -e "$OSASCRIPT_INPUT" ] || {
  echo "team-attach: all-spared executed AppleScript" >&2
  exit 1
}
echo "team-attach: (6c) every live seat spared = exit 0 with the explicit line: ok"

# (6d) An unknown handle fails loud naming the handle and the roster; no window.
reset_logs
printf '%s\n' demo/a demo/c demo/d >"$LIVE_SESSIONS"
rc=0
badx="$(cd "$TEAM_ROOT" && TAP_JSON=1 "$TAP" team attach --except nosuch 2>&1)" || rc=$?
[ "$rc" = 1 ] || {
  echo "team-attach: unknown --except handle exited $rc, want 1" >&2
  printf '%s\n' "$badx" >&2
  exit 1
}
[ "$(err_class "$badx")" = not_found ] || {
  echo "team-attach: unknown --except handle needs error_class=not_found" >&2
  printf '%s\n' "$badx" >&2
  exit 1
}
assert_contains "$badx" "nosuch" "unknown --except handle named"
assert_contains "$badx" "roster:" "unknown --except refusal names the roster"
[ ! -e "$OSASCRIPT_INPUT" ] || {
  echo "team-attach: a refused --except opened a window" >&2
  exit 1
}
rc=0
qual="$(cd "$TEAM_ROOT" && TAP_JSON=1 "$TAP" team attach --except demo/a 2>&1)" || rc=$?
[ "$rc" = 1 ] || { echo "team-attach: team-qualified --except exited $rc, want 1" >&2; exit 1; }
[ "$(err_class "$qual")" = usage_error ] || {
  echo "team-attach: team-qualified --except needs error_class=usage_error" >&2
  printf '%s\n' "$qual" >&2
  exit 1
}
echo "team-attach: (6d) unknown handle refuses with not_found; team-qualified is a usage error: ok"
printf '%s\n' demo/a >"$LIVE_SESSIONS"

# (7) Runtime help teaches the scope and evidence boundary; unknown flags refuse.
help="$("$TAP" help team attach)"
assert_contains "$help" "tap team attach [<team>] [--all] [--tabs] [--dry-run]" "team attach grammar"
assert_contains "$help" "handle-labeled" "labelled-viewer help (layout-neutral token)"
assert_contains "$help" "Already-attached" "attach default scope help"
assert_contains "$help" "unless --all opens additional" "attach explicit additional-viewer scope"
assert_contains "$help" "previews the plan but cannot prove" "dry-run help boundary"

contract="$(cat "$CONTRACT")"
assert_contains "$contract" "tap team attach [<team>] [--all] [--tabs] [--dry-run]" "contract team attach grammar"
assert_contains "$contract" "all live seats are already attached exits 0 without opening a window" "contract idempotent outcome"
assert_contains "$contract" "counted automated success requires a new post-open client TTY" "contract client-delta proof"

rc=0
bad="$("$TAP" team attach --bogus 2>&1)" || rc=$?
[ "$rc" = 1 ] || {
  echo "team-attach: unknown flag exited $rc, want 1" >&2
  printf '%s\n' "$bad" >&2
  exit 1
}
assert_contains "$bad" "unexpected argument '--bogus'" "unknown-flag detail"
assert_contains "$bad" "next: tap help team" "unknown-flag recovery"
echo "team-attach: (7) dispatch, help, and argument refusal: ok"

echo "team-attach: ok"
