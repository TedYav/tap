# attach-next-fixture.sh — shared mock tmux + registry for attach --next tests.
# Sourced by smoke/attach-next.test.sh and regress/attach-next-matrix.test.sh.
# Not a test body: smoke-all does not execute this file.
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
TEAM_ROOT="$WORK/repo"
export TAP_HOME="$TEAM_ROOT/.tap/bus"
export TAP_INDEX_HOME="$WORK/index" TAP_SESSION_MANIFEST="$WORK/sessions.json"
export PATH="$FAKE_BIN:$PATH"
export TAP_SERVER_EPOCH="900:100"
export TAP_BOOT_ID="boot:2"
export TAP_JSON=1
export FAKE_EVENTS="$WORK/tmux-events"
export FAKE_SESSIONS="$WORK/sessions"
export FAKE_PANES="$WORK/panes"
export FAKE_CALLER_PANE="%12"
export FAKE_CALLER_TTY="ttys001"
export FAKE_RACE=""
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$FAKE_BIN" "$WORK/index"
git -C "$TEAM_ROOT" init -q
# Born live (F1): team demo is enrolled at its bus registry.
printf '{"schema":"0.20","teams":{"demo":{"root":"%s","registry_location":"%s","state":"registered"}}}\n' \
  "$(cd "$TEAM_ROOT" && pwd -P)" "$(cd "$TAP_HOME" && pwd -P)/registry.json" > "$TAP_INDEX_HOME/global-registry.json"
: > "$FAKE_EVENTS"

fail() { echo "attach-next: $1" >&2; shift; [ "$#" -eq 0 ] || printf '%s\n' "$@" >&2; exit 1; }
error_class() {
  python3 -c 'import json,sys; print(json.loads(sys.argv[1])["error_class"])' "$1"
}
logged() { grep -E "$1" "$FAKE_EVENTS" >/dev/null 2>&1; }

write_sessions() {
  cat > "$FAKE_SESSIONS" <<'EOF'
demo/alpha	1:1	0
demo/bravo	1:1	1
demo/charlie	1:1	0
EOF
}

write_panes() {
  cat > "$FAKE_PANES" <<'EOF'
demo/alpha	demo/alpha:0.0	%11	claude	111	1:1	0
demo/bravo	demo/bravo:0.0	%12	claude	112	1:1	0
demo/charlie	demo/charlie:0.0	%13	claude	113	1:1	0
EOF
}

write_registry() {
  cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": { "name": "demo" },
  "seats": {
    "alpha":    { "pane": "demo/alpha:0.0",   "pane_id": "%11", "harness": "claude", "status": "active", "session": "demo/alpha",   "server_epoch": "900:100", "boot_id": "boot:2" },
    "bravo":    { "pane": "demo/bravo:0.0",   "pane_id": "%12", "harness": "claude", "status": "active", "session": "demo/bravo",   "server_epoch": "900:100", "boot_id": "boot:2" },
    "charlie":  { "pane": "demo/charlie:0.0", "pane_id": "%13", "harness": "claude", "status": "active", "session": "demo/charlie", "server_epoch": "900:100", "boot_id": "boot:2" },
    "delta":    { "delivery": "poll", "harness": "daemon", "status": "active", "unattended": true },
    "echo":     { "pane": "demo/echo:0.0", "pane_id": "%99", "harness": "claude", "status": "active", "session": "demo/echo", "server_epoch": "900:100", "boot_id": "boot:2" },
    "foxtrot":  { "pane": "demo/foxtrot:0.0", "pane_id": "%14", "harness": "claude", "status": "suspended", "status_reason": "server_restarted", "session": "demo/foxtrot" },
    "golf":     { "harness": "claude", "status": "active", "server_epoch": "900:100", "boot_id": "boot:2" }
  }
}
JSON
}

write_sessions
write_panes
write_registry

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_EVENTS"
if [ -n "${FAKE_RACE:-}" ] && [ "${1:-}" = list-sessions ] && [[ "$*" == *session_attached* ]]; then
  count_file="$FAKE_EVENTS.batch-count"
  count="$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))"
  printf '%s\n' "$count" >"$count_file"
  if [ "$count" -gt 1 ]; then
    grep -v '^demo/alpha' "$FAKE_SESSIONS" >"$FAKE_SESSIONS.tmp" || true
    mv "$FAKE_SESSIONS.tmp" "$FAKE_SESSIONS"
    grep -v '^demo/alpha' "$FAKE_PANES" >"$FAKE_PANES.tmp" || true
    mv "$FAKE_PANES.tmp" "$FAKE_PANES"
  fi
fi
case "${1:-}" in
  list-sessions)
    if [[ "$*" == *session_attached* ]]; then
      cat "$FAKE_SESSIONS"
    else
      awk -F '\t' '{print $1 "\t" $2}' "$FAKE_SESSIONS"
    fi ;;
  list-panes)
    fmt=""; target=""; all=0
    shift
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -a) all=1; shift ;;
        -s) shift ;;
        -t) target="${2#=}"; shift 2 ;;
        -F) fmt="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    if [[ "$fmt" == *pane_tty* && "$fmt" != *pane_current_command* ]]; then
      case "${FAKE_CALLER_PANE:-}" in
        %11) printf '%s\t/dev/%s\n' '%11' "$FAKE_CALLER_TTY" ;;
        %12) printf '%s\t/dev/%s\n' '%12' "$FAKE_CALLER_TTY" ;;
        %13) printf '%s\t/dev/%s\n' '%13' "$FAKE_CALLER_TTY" ;;
        none) printf '%s\t/dev/ttys999\n' '%99' ;;
        *) printf '%s\t/dev/%s\n' '%12' "$FAKE_CALLER_TTY" ;;
      esac
      exit 0
    fi
    if [ "$all" = 1 ]; then
      cat "$FAKE_PANES"
    else
      awk -F '\t' -v t="$target" '$1==t {print}' "$FAKE_PANES"
    fi ;;
  display-message)
    shift; target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -p) shift ;;
        -t) target="${2#=}"; shift 2 ;;
        *) fmt="$1"; shift ;;
      esac
    done
    case "$fmt" in
      *pane_tty*session_name*)
        case "$target" in
          %11) printf '%s\t/dev/%s\tdemo/alpha\t1:1\n' '%11' "$FAKE_CALLER_TTY" ;;
          %12) printf '%s\t/dev/%s\tdemo/bravo\t1:1\n' '%12' "$FAKE_CALLER_TTY" ;;
          %13) printf '%s\t/dev/%s\tdemo/charlie\t1:1\n' '%13' "$FAKE_CALLER_TTY" ;;
          *) exit 1 ;;
        esac ;;
      *pane_id*pane_tty*)
        printf '%s\t/dev/%s\n' "$target" "$FAKE_CALLER_TTY" ;;
      *session_name*)
        case "$target" in
          %11) echo demo/alpha ;;
          %12) echo demo/bravo ;;
          %13) echo demo/charlie ;;
          *) echo "" ;;
        esac ;;
      *pane_id*)
        awk -F '\t' -v t="$target" '$2==t || $3==t {print $3}' "$FAKE_PANES" ;;
      *) echo "" ;;
    esac ;;
  list-clients)
    printf '/dev/%s\n' "$FAKE_CALLER_TTY" ;;
  has-session)
    shift; target=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -t) target="${2#=}"; shift 2 ;; *) shift ;; esac
    done
    awk -F '\t' -v t="$target" '$1==t {found=1} END {exit found?0:1}' "$FAKE_SESSIONS" ;;
  switch-client|attach-session|select-window) exit 0 ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

cat > "$FAKE_BIN/ps" <<'FAKEPS'
#!/usr/bin/env bash
case " $* " in
  *" -Ao "*|*" -A "*|*" -o pid"*) exec /bin/ps "$@" ;;
esac
pid=""
while [ "$#" -gt 0 ]; do
  case "$1" in -p) pid="$2"; shift 2 ;; *) shift ;; esac
done
case "${FAKE_PS_MODE:-real}" in
  unobservable) printf '%s %s\n' "1" "?" ;;
  tty) printf '%s %s\n' "1" "${FAKE_CALLER_TTY:-ttys001}" ;;
  *) exec /bin/ps -p "$pid" -o ppid= -o tty= 2>/dev/null || true ;;
esac
FAKEPS
chmod +x "$FAKE_BIN/ps"

run_next() {
  : > "$FAKE_EVENTS"
  rm -f "$FAKE_EVENTS.batch-count"
  set +e
  env -u TMUX -u TMUX_PANE "$@" "$TAP" attach --next >"$WORK/out" 2>"$WORK/err"
  rc=$?
  set -e
}

run_next_inside() {
  local pane="$1"
  : > "$FAKE_EVENTS"
  rm -f "$FAKE_EVENTS.batch-count"
  set +e
  env TMUX="/tmp/tap-next.sock,1,0" TMUX_PANE="$pane" FAKE_PS_MODE=tty TAP_JSON=1 \
    "$TAP" attach --next >"$WORK/out" 2>"$WORK/err"
  rc=$?
  set -e
}

write_sole() {
  local handle="$1" body="$2"
  cat > "$TAP_HOME/registry.json" <<JSON
{"schema": "0.20", "team":{"name":"demo"},"seats":{"$handle":$body}}
JSON
}

assert_selector_empty() {
  local name="$1"
  run_next
  [ "$rc" = 1 ] || fail "$name: expected selector empty, got $rc" "$(cat "$WORK/out"; cat "$WORK/err")"
  [ "$(error_class "$(cat "$WORK/out")")" = not_attachable ] \
    || fail "$name: expected not_attachable, not hop-then-refuse" "$(cat "$WORK/out")"
  grep -F 'no unattached active seat on this team to hop to' "$WORK/out" >/dev/null \
    || fail "$name: expected selector-level empty detail" "$(cat "$WORK/out")"
  grep -E 'poll-mode|registered poll' "$WORK/out" "$WORK/err" >/dev/null \
    && fail "$name: positional poll refusal must not leak through the selector" "$(cat "$WORK/out"; cat "$WORK/err")"
  grep -E 'session resume|session launch|resume it first' "$WORK/out" "$WORK/err" >/dev/null \
    && fail "$name: selector empty must not name launch/resume" "$(cat "$WORK/out"; cat "$WORK/err")"
  logged 'attach-session|switch-client' \
    && fail "$name: selector empty must not mutate tmux" "$(cat "$FAKE_EVENTS")"
  echo "attach-next: sole-candidate $name is selector-empty: ok"
}
