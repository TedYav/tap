#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
cmd="$1"; shift
# Native submit targets immutable pane ids; resolve them to the same fake pane.
args=()
for arg in "$@"; do
  case "$arg" in %401) arg=sess:0.0 ;; %402) arg=sess:0.1 ;; %403) arg=sess:0.2 ;; esac
  args+=("$arg")
done
set -- "${args[@]}"
case "$cmd" in
  list-sessions) printf 'sess\t4242:100\n' ;;
  list-panes)
    printf 'sess\tsess:0.0\t%%401\t%s\t5001\t4242:100\t0\n' "${FAKE_TMUX_CMD:-codex}"
    printf 'sess\tsess:0.1\t%%402\tcodex\t5002\t4242:100\t0\n'
    printf 'sess\tsess:0.2\t%%403\tcodex\t5003\t4242:100\t0\n'
    ;;
  display-message)
    fmt="${@: -1}"
    # Pane identity is per-TARGET: a fixture that answers one id for every pane
    # cannot exercise a send BACK to the sender (identity_mismatch on every reply).
    target=""; argv=("$@")
    for ((i=0; i<${#argv[@]}; i++)); do [ "${argv[$i]}" = "-t" ] && target="${argv[$((i+1))]}"; done
    case "$target" in
      sess:0.1) pid="%402" ;;
      sess:0.2) pid="%403" ;;
      *)        pid="${FAKE_PANE_ID:-%401}" ;;
    esac
    case "$fmt" in
      # The Bash observer's 3-field fmt (tap_pane_observe: pane_id, session_name,
      # pid:start_time) also matches *pid*start_time*, so it must be answered
      # BEFORE the bare server-identity arm or the hard server-identity gate reads an
      # epoch as the pane id and defers every clobber as unobservable.
      *pane_id*session_name*start_time*) printf '%s\tsess\t4242:100\n' "$pid" ;;
      *pid*start_time*) echo "4242:100" ;;
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*session_name*pane_pid*pane_current_command*)
        if [ "$pid" = %401 ] && [ -f "$state/refuse_identity" ] && [ -f "$TAP_HOME/payloads/h7.md" ]; then
          : > "$state/identity-refused"
          exit 1
        fi
        printf '%s\tsess\t4242\t%s\t0\n' "$pid" "$([ "$pid" = "%402" ] && printf codex || printf '%s' "${FAKE_TMUX_CMD:-codex}")" ;;
      *pane_id*pane_tty*session_name*) printf '%s\t/dev/faketty\tsess\t4242:100\n' "$pid" ;;
      *pane_id*session_name*) printf '%s\tsess\t4242:100\n' "$pid" ;;
      *session_name*)         echo "sess" ;;
      *pane_id*)              echo "$pid" ;;
      *pane_pid*)             echo "4242" ;;
      *pane_in_mode*)         [ -f "$state/copy_mode" ] && echo "1" || echo "0" ;;
      *pane_current_command*) echo "${FAKE_TMUX_CMD:-codex}" ;;
      *pane_current_path*)    echo "${FAKE_WORKTREE:?}" ;;
      *window_activity*)      echo "100" ;;
      *)                      echo "" ;;
    esac ;;
  select-pane) echo "select-pane $*" >> "$state/send-keys.log" ;;
  capture-pane)
    # One line per readiness probe, i.e. one per drain — arm 9 counts these.
    [ -n "${FAKE_TMUX_PROBE_LOG:-}" ] && echo probe >> "$FAKE_TMUX_PROBE_LOG"
    # Busy AND the input band are per-PANE. A single shared input file is not a
    # fidelity detail: it makes one pane's stuck submit look like pending human
    # input on every OTHER pane, so a notice sent to a second seat refuses for a
    # reason no real tmux would produce.
    target=""
    while [ $# -gt 0 ]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
    key="${target//[:.\/]/_}"
    # A VERBATIM CAPTURE OVERRIDE, checked first. The synthetic band below is a codex
    # shape; the agy classes this file now covers are distinguished by pane GEOMETRY
    # (rules, band, what renders below it), which no synthetic line reproduces. Arms 17+
    # therefore feed real captured bytes through the same code path a live pane would.
    # Guarded on the file existing, so every earlier arm sees the shapes it always saw.
    if [ -n "$key" ] && [ -f "$state/capture.$key" ]; then cat "$state/capture.$key"; exit 0; fi
    if [ -f "$state/busy" ] || { [ -n "$key" ] && [ -f "$state/busy.$key" ]; }; then
      printf 'model is generating a response...\n'
    elif [ -f "$state/input.$key" ]; then printf '❯ %s\n' "$(cat "$state/input.$key")"
    else printf '❯ \n'; fi ;;
  send-keys)
    echo "$*" >> "$state/send-keys.log"
    key=""
    [ "${1:-}" = "-t" ] && { key="${2//[:.\/]/_}"; shift 2; }
    if [ "${1:-}" = "-X" ] && [ "${2:-}" = "cancel" ]; then
      # A copy-mode the courier cannot exit. Real: a pane scrolled by a human, or one
      # whose cancel loses a race. It is what keeps arm 6's pane in a live non-ready
      # state across the deadline instead of being tidied back to ready.
      [ -f "$state/copy_mode_stuck" ] && exit 1
      rm -f "${state:?}/copy_mode"
      exit 0
    fi
    case "${1:-}" in
      -l) shift; [ "${1:-}" = "--" ] && shift; printf '%s' "${1:-}" > "$state/input.$key"; exit 0 ;;
      C-u)
        rm -f "${state:?}/input.$key"
        exit 0 ;;
      Enter)
        # The transaction's own window, opened deliberately: this runs after the
        # digest revalidated its ids and before its post-submit bookkeeping, which
        # is the only place a racing cancel or a failing rewrite can be driven
        # DETERMINISTICALLY rather than hoped for.
        if [ -n "${FAKE_AT_DIGEST_SUBMIT:-}" ] \
           && grep -qE '\[\[TAP v[0-9.]+ (ask|note) [^ ]+( [a-z]+)* digest' "$state/input.$key" 2>/dev/null; then
          bash -c "$FAKE_AT_DIGEST_SUBMIT" || true
        fi
        # Arm (11): the digest doorbell submits but never verifies (rc 5).
        if [ "${FAKE_TMUX_STUCK_DIGEST_SUBMIT:-0}" = 1 ] \
           && grep -qE '\[\[TAP v[0-9.]+ (ask|note) [^ ]+( [a-z]+)* digest' "$state/input.$key" 2>/dev/null; then
          exit 0
        fi
        # Arm (15): ANY submit lands but never clears, so the id stays in the band and
        # tap_submit_verify returns submit-unverified. This drives the rc-5 path through
        # the production code rather than simulating its effects.
        [ -f "$state/stuck_submit" ] && exit 0
        rm -f "${state:?}/input.$key"
        exit 0
        ;;
    esac ;;
esac
