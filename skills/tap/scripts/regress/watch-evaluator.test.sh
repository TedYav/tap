#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# watch-evaluator.test.sh — U7: evaluator containment + notice-on-done.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAPSH="$ROOT/bin/tap"
LIB="$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
# Redirect the machine index home: tap-watch.sh now invokes tap-escalate.sh
# best-effort on NOTIFY (CONTRACT.md §Escalation). Escalate no longer consults
# any target config: as of v0.21 it invokes the NOTIFIER directly, so what keeps
# a smoke off a real person's phone is sandbox-pins.sh's TAP_NOTIFY_USER_BIN
# default (a nonexistent path -> fail loud), NOT this redirect. The redirect
# stays because the machine index is operator state a smoke must never touch.
export TAP_INDEX_HOME="$WORK/index"

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
cmd="$1"; shift
case "$cmd" in
  # CONTRACT §Session-name authority: notice delivery is authorized by one
  # exact-name/generation snapshot plus designated-pane and harness evidence.
  list-sessions) printf 'sess\t4242:100\n' ;;
  list-panes) printf 'sess\tsess:0.0\t%%101\tcodex\t4242\t4242:100\t0\n' ;;
  display-message)
    fmt="${@: -1}"
    if [ "$fmt" = '#{pid}:#{start_time}' ]; then echo "4242:100"; exit 0; fi
    case "$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*)
        t=""; p=""; for a in "$@"; do [ "$p" = -t ] && t="${a#=}"; p="$a"; done
        case "$t" in sess:0.0|%101|sess) printf '%%101\tsess\t4242\tcodex\t0\n' ;; *) printf '\t\t\t\t0\n' ;; esac ;;
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*pane_tty*session_name*) printf '%%101\t/dev/faketty\tsess\t4242:100\n' ;;
      *pane_id*session_name*) printf '%%101\tsess\t4242:100\n' ;;
      *session_name*) echo "sess" ;;
      *pane_id*) echo "%101" ;;
      *pane_pid*) echo "4242" ;;
      *pane_in_mode*) echo "0" ;;
      *pane_current_command*) echo "codex" ;;
      *pane_current_path*) echo "${FAKE_WORKTREE:?}" ;;
      *window_activity*) echo "${FAKE_WINDOW_ACTIVITY:-100}" ;;
      *) echo "" ;;
    esac ;;
  capture-pane)
    if [ -f "$state/input" ]; then printf '❯ %s\n' "$(cat "$state/input")"; else printf '❯ \n'; fi ;;
  send-keys)
    [ "${1:-}" = "-t" ] && shift 2
    case "${1:-}" in
      -l) shift; [ "${1:-}" = "--" ] && shift; printf '%s' "${1:-}" > "$state/input"; exit 0 ;;
      C-u|Enter) rm -f "$state/input"; exit 0 ;;
    esac ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
cat > "$FAKE_BIN/ps" <<'PS'
#!/usr/bin/env bash
printf ' 4242 1 codex codex --dangerously-bypass-approvals\n'
PS
chmod +x "$FAKE_BIN/ps"
cat > "$FAKE_BIN/codex" <<'CODEX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_CODEX_STATE:?}"; mkdir -p "$state"
n=1
[ -f "$state/count" ] && n=$(( "$(cat "$state/count")" + 1 ))
printf '%s' "$n" > "$state/count"
printf '%s\n' "$*" >> "$state/args"
cat > "$state/prompt.$n.md"
case "${FAKE_CODEX_MODE:-json}" in
  json) cat "${FAKE_VERDICT_FILE:?}" ;;
  malformed) printf 'not json\n' ;;
  # a model that never answers: the evaluator's deadline (TAP_WATCH_EVALUATOR_TIMEOUT)
  # must end it (`exec`, so the killed process is the one holding the pipe)
  hang) exec sleep 30 ;;
  # invalid UTF-8 on either stream: the retired python decoded both strictly and raised
  badutf8_stdout) printf '{"verdict":"done","evidence":[{"clause":"x","citation":"git:abc"}],"action":"disarm","reason":"\377"}' ;;
  badutf8_stderr) cat "${FAKE_VERDICT_FILE:?}"; printf '\377\n' >&2 ;;
  # the model dies of a signal that is NOT the deadline's: its partial streams are
  # published and its status is the signal's (python's sys.exit(-signum)), never 124
  selfkill) printf 'partial'; printf 'problem' >&2; kill -9 $$ ;;
esac
CODEX
chmod +x "$FAKE_BIN/codex"
export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket" FAKE_TMUX_STATE="$WORK/tmux" FAKE_CODEX_STATE="$WORK/codex" FAKE_WORKTREE="$WORK/repo"
# Mock pane path — settle sleeps prove nothing here.
export TAP_TUI_SETTLE_SCALE=0.1

BUS="$WORK/repo/.tap/bus"; mkdir -p "$BUS/payloads" "$BUS/receipts" "$WORK/repo"
cat > "$BUS/registry.json" <<JSON
{"schema": "0.20",  "team": { "name": "t", "worktree_root": "$WORK/repo" },
  "seats": { "lead": { "pane": "sess:0.0", "pane_id": "%101", "session": "sess", "server_epoch": "srv:4242:100", "harness": "codex", "status": "active", "registered_from_worktree": "$WORK/repo" } } }
JSON
# Born live (F2a): native verbs refuse an absent machine marker, so enroll the team.
mkdir -p "$TAP_INDEX_HOME"
printf '{"schema":"0.20","teams":{"t":{"root":"%s","registry_location":"%s","state":"registered"}}}\n' \
  "$(mkdir -p "$WORK/repo" && cd "$WORK/repo" && pwd -P)" "$(cd "$BUS" && pwd -P)/registry.json" > "$TAP_INDEX_HOME/global-registry.json"

field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],""))' "$BUS/watch/arm.json" "$1"; }
# tap_watch_set (Bash) is gone (the watch sidecar/tick moved to
# Bun); set lease fields directly through the native owner (watch-lease.ts).
setf() { TAP_HOME="$BUS" bash -c '. "$1"; shift; tap_bun_call watch set watch-lease.ts "$TAP_HOME/watch/arm.json" set "$@"' sh "$LIB" "$@" >/dev/null 2>&1; }
count_codex() { [ -f "$FAKE_CODEX_STATE/count" ] && cat "$FAKE_CODEX_STATE/count" || printf '0'; }
notice_payload() { grep -l '^kind: notice$' "$BUS"/payloads/*.md 2>/dev/null | head -1 || true; }
write_verdict() { printf '%s\n' "$1" > "$WORK/verdict.json"; export FAKE_VERDICT_FILE="$WORK/verdict.json" FAKE_CODEX_MODE=json; }
arm_eval() {
  local evaluator="${1:-codex}"
  export FAKE_CODEX_MODE=json
  rm -rf "$BUS/watch" "$BUS/payloads" "$BUS/receipts" "$FAKE_CODEX_STATE" "$FAKE_TMUX_STATE"
  mkdir -p "$BUS/payloads" "$BUS/receipts" "$FAKE_CODEX_STATE" "$FAKE_TMUX_STATE"
  TAP_HOME="$BUS" bash "$TAPSH" watch on --by lead -m "all smokes green; proof: git:abc123; bound 2h" \
    --evaluator "$evaluator" --threshold 1500 --chain '["ghost"]' --terminal ghost --no-spawn >/dev/null 2>&1
  A="$(field armed_at)"
}
tick_eval() {
  TAP_HOME="$BUS" TAP_WATCH_NOW="$((A + ${1:-2000}))" TAP_WATCH_EVALUATOR_TIMEOUT="${2:-3}" bash "$TAPSH" watch tick >/dev/null 2>"$WORK/tick.err" || {
    echo "watch-evaluator: tick failed" >&2; cat "$WORK/tick.err" >&2; exit 1
  }
}

# (1) AE9: unsettled work gates the evaluator before any model command.
write_verdict '{"verdict":"done","evidence":[{"clause":"all smokes","citation":"git:abc123"}],"action":"disarm"}'
arm_eval codex
printf -- '---\nid: work-1\nfrom: peer\nto: lead\nkind: discuss\n---\nwork owed\n' > "$BUS/payloads/work-1.md"
tick_eval 2000
[ "$(count_codex)" = "0" ] || { echo "watch-evaluator: (1/AE9) codex ran despite unsettled work" >&2; exit 1; }
[ "$(field evaluator_calls)" = "0" ] || { echo "watch-evaluator: (1/AE9) budget changed despite pre-check" >&2; exit 1; }
echo "watch-evaluator: (1/AE9) deterministic pre-check avoids model call: ok"

# (2) done + observable evidence disarms only after a durable kind=notice to the armer.
write_verdict '{"verdict":"done","evidence":[{"clause":"all smokes green","citation":"git:abc123"}],"action":"disarm","reason":"done"}'
arm_eval codex
tick_eval 2000
[ ! -f "$BUS/watch/arm.json" ] || { echo "watch-evaluator: (2/AE6) done verdict did not disarm" >&2; exit 1; }
notice="$(notice_payload)"
[ -n "$notice" ] || { echo "watch-evaluator: (2/AE6) done verdict did not send notice" >&2; exit 1; }
grep -q '^from: watcher$' "$notice" && grep -q '^to: lead$' "$notice" && grep -q '^reply: settle-only$' "$notice" \
  || { echo "watch-evaluator: (2/AE6) notice envelope wrong" >&2; sed -n '1,10p' "$notice" >&2; exit 1; }
grep -q 'git:abc123' "$notice" || { echo "watch-evaluator: (2/AE6) notice body missing evidence" >&2; exit 1; }
grep -q '^exec --output-schema .* --sandbox read-only --ask-for-approval never$' "$FAKE_CODEX_STATE/args" \
  || { echo "watch-evaluator: (2) codex args did not use the headless schema form" >&2; cat "$FAKE_CODEX_STATE/args" >&2; exit 1; }
ls "$BUS"/watch/evaluator-prompts/*.md >/dev/null 2>&1 || { echo "watch-evaluator: (2/R13) prompt log was not written before invocation" >&2; exit 1; }
# tap-kju: the evaluation ran (notice + disarm above), and its verdict files were discarded.
! compgen -G "$BUS/watch/evaluator-*.json" >/dev/null || { echo "watch-evaluator: (2/kju) done verdict left verdict files behind" >&2; ls "$BUS/watch" >&2; exit 1; }
echo "watch-evaluator: (2/AE6,R13) done verdict -> notice + disarm + prompt log: ok"

# (3) tap doctor reports/prunes watch prompt logs and leaves bus payloads alone.
before_payloads="$(find "$BUS/payloads" -type f | wc -l | tr -d ' ')"
out="$(TAP_HOME="$BUS" bash "$TAPSH" doctor)"
[[ "$out" == *'watch-log'* ]] || { echo "watch-evaluator: (3/R13) doctor did not report watch logs" >&2; echo "$out" >&2; exit 1; }
TAP_HOME="$BUS" bash "$TAPSH" doctor --prune-watch-logs >/dev/null
after_payloads="$(find "$BUS/payloads" -type f | wc -l | tr -d ' ')"
[ "$after_payloads" = "$before_payloads" ] || { echo "watch-evaluator: (3/R13) prune removed payloads" >&2; exit 1; }
! ls "$BUS"/watch/evaluator-prompts/*.md >/dev/null 2>&1 || { echo "watch-evaluator: (3/R13) prune left watch logs behind" >&2; exit 1; }
echo "watch-evaluator: (3/R13) doctor reports and prunes watch logs only: ok"

# (4) AE5 containment matrix: bad or insufficient verdicts never disarm or notice.
printf '#!/bin/sh\necho never\n' > "$WORK/noexec"; chmod 644 "$WORK/noexec"   # present, not executable: the spawn fails (EACCES)
for case_name in malformed timeout missing_binary unexecutable_binary badutf8_stdout badutf8_stderr selfkill disarm_without_done done_without_evidence transcript_citation; do
  arm_eval codex
  case "$case_name" in
    malformed) export FAKE_CODEX_MODE=malformed ;;
    timeout) write_verdict '{"verdict":"not_done","reason":"late"}'; export FAKE_CODEX_MODE=hang ;;   # tick_eval passes the 1 s deadline
    # Point the evaluator at a guaranteed-nonexistent binary via the arm record (bypassing
    # `watch on`'s codex|claude|none validation). Depending on a host PATH miss for `claude`
    # would turn into a live external call wherever a real claude is installed.
    missing_binary) setf evaluator __tap_absent_evaluator__; write_verdict '{"verdict":"done","evidence":[{"clause":"x","citation":"git:abc"}],"action":"disarm"}' ;;
    unexecutable_binary) setf evaluator "$WORK/noexec"; write_verdict '{"verdict":"done","evidence":[{"clause":"x","citation":"git:abc"}],"action":"disarm"}' ;;
    badutf8_stdout) export FAKE_CODEX_MODE=badutf8_stdout ;;
    badutf8_stderr) write_verdict '{"verdict":"done","evidence":[{"clause":"x","citation":"git:abc"}],"action":"disarm"}'; export FAKE_CODEX_MODE=badutf8_stderr ;;
    selfkill) export FAKE_CODEX_MODE=selfkill ;;
    disarm_without_done) write_verdict '{"verdict":"not_done","reason":"still running","evidence":[{"clause":"x","citation":"git:abc"}],"action":"disarm"}' ;;
    done_without_evidence) write_verdict '{"verdict":"done","evidence":[],"action":"disarm"}' ;;
    transcript_citation) write_verdict '{"verdict":"done","evidence":[{"clause":"all smokes","citation":"transcript: user said done"}],"action":"disarm"}' ;;
  esac
  tick_eval 2000 1
  [ -f "$BUS/watch/arm.json" ] || { echo "watch-evaluator: (4/AE5) $case_name disarmed unexpectedly" >&2; exit 1; }
  [ -z "$(notice_payload)" ] || { echo "watch-evaluator: (4/AE5) $case_name sent a notice unexpectedly" >&2; exit 1; }
  # A spawn that fails before the model runs (absent or unexecutable binary) left no
  # verdict files in the incumbent (python raised before its open() lines); neither
  # does the port (a review finding).
  # ... and so does a model whose output failed strict UTF-8 decoding on either stream
  # (review finding): no raw verdict is published, so nothing downstream can act on it.
  case "$case_name" in missing_binary|unexecutable_binary|badutf8_stdout|badutf8_stderr)
    ! ls "$BUS"/watch/evaluator-*.json >/dev/null 2>&1 || { echo "watch-evaluator: (4/AE5) $case_name left verdict files behind" >&2; ls "$BUS"/watch >&2; exit 1; } ;;
  esac
  # A signal death that is not the deadline's publishes the partial streams (the incumbent
  # wrote both files and exited 247 = 256-9); the timeout case, by contrast, leaves none.
  if [ "$case_name" = selfkill ]; then
    raw="$(ls "$BUS"/watch/evaluator-*-0.json 2>/dev/null | head -1 || true)"
    [ -n "$raw" ] && [ "$(cat "$raw")" = partial ] && [ "$(cat "$raw.stderr")" = problem ] \
      || { echo "watch-evaluator: (4/AE5) selfkill did not publish the model's partial streams" >&2; ls "$BUS"/watch >&2; exit 1; }
  fi
  if [ "$case_name" = timeout ]; then
    ! ls "$BUS"/watch/evaluator-*-0.json >/dev/null 2>&1 || { echo "watch-evaluator: (4/AE5) timeout left verdict files behind" >&2; ls "$BUS"/watch >&2; exit 1; }
  fi
  # Timeout-specific: a completed evaluator would normalize reason=late into
  # not_done_reason; injected TimeoutExpired must not.
  if [ "$case_name" = timeout ]; then
    [ "$(field not_done_reason)" != "late" ] \
      || { echo "watch-evaluator: (4/AE5) timeout arm applied a completed verdict (not_done_reason=late) — did not hit TimeoutExpired" >&2; exit 1; }
  fi
done
echo "watch-evaluator: (4/AE5) malformed/timeout/missing/unexecutable/bad-utf8/selfkill/disarm-without-done/weak-done contained: ok"

# (4b) T22: the claude evaluator is accepted-but-unbuilt -> `watch on --evaluator claude`
# is refused (no accepted-but-unimplemented straddle), naming codex/none as the recovery.
cl_err="$(TAP_HOME="$BUS" bash "$TAPSH" watch on --by lead -m "x" --evaluator claude --no-spawn 2>&1 1>/dev/null)" && {
  echo "watch-evaluator: (4b/T22) --evaluator claude should be refused" >&2; exit 1; }
grep -qi "codex" <<<"$cl_err" || { echo "watch-evaluator: (4b/T22) claude refusal does not name codex/none recovery: $cl_err" >&2; exit 1; }
echo "watch-evaluator: (4b/T22) unimplemented claude evaluator refused: ok"

# (5) not_done reason is carried into the next probe body as the nudge.
write_verdict '{"verdict":"not_done","reason":"suite still running","evidence":[{"clause":"all smokes","citation":"git:abc123"}],"action":"advance"}'
arm_eval codex
tick_eval 2000
[ "$(field not_done_reason)" = "suite still running" ] || { echo "watch-evaluator: (5) not_done reason was not recorded" >&2; exit 1; }
setf chain_overrides '["lead"]' terminal_seat lead current_rung 0 last_probe_at 0
TAP_HOME="$BUS" TAP_WATCH_NOW="$((A + 2001))" bash "$TAPSH" watch tick >/dev/null 2>&1
probe="$(grep -l '^kind: probe$' "$BUS"/payloads/*.md 2>/dev/null | head -1 || true)"
[ -n "$probe" ] || { echo "watch-evaluator: (5) follow-up probe was not sent" >&2; exit 1; }
grep -q 'suite still running' "$probe" || { echo "watch-evaluator: (5) follow-up probe did not carry not_done reason" >&2; exit 1; }
echo "watch-evaluator: (5) not_done reason appears in next probe body: ok"

# (6) blocked routes to sticky human notify; none disables the evaluator; third call is refused.
write_verdict '{"verdict":"blocked","reason":"approval waiting","evidence":[{"clause":"approval","citation":"bus:approval"}],"action":"notify human"}'
arm_eval codex
tick_eval 2000
[ -f "$BUS/watch/notify.json" ] || { echo "watch-evaluator: (6) blocked verdict did not notify" >&2; exit 1; }
echo "watch-evaluator: (6) blocked verdict routes to notify: ok"

arm_eval none
tick_eval 2000
[ "$(count_codex)" = "0" ] || { echo "watch-evaluator: (6) evaluator=none invoked codex" >&2; exit 1; }
echo "watch-evaluator: (6) evaluator=none skips model: ok"

write_verdict '{"verdict":"not_done","reason":"still running","evidence":[{"clause":"x","citation":"git:abc"}],"action":"advance"}'
arm_eval codex
tick_eval 2000
tick_eval 2001
tick_eval 2002
[ "$(count_codex)" = "2" ] || { echo "watch-evaluator: (6/R13) expected two evaluator calls max, got $(count_codex)" >&2; exit 1; }
[ "$(field evaluator_calls)" = "2" ] || { echo "watch-evaluator: (6/R13) budget field should stop at 2" >&2; exit 1; }
echo "watch-evaluator: (6/R13) evaluator budget caps at two calls per episode: ok"

echo "watch-evaluator: ok"
