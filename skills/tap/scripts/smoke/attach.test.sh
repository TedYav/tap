#!/usr/bin/env bash
# attach.test.sh — `tap attach <handle>` and the `tap team --names` list it reads.
#
# The load-bearing property is AGREEMENT (case 7): the roster and attach share
# one classifier, so `tap team --names --active` lists exactly the seats attach
# can reach. Two independently-hardcoded expectations would both pass while the
# two surfaces drifted apart, which is why case 7 compares them to each other
# instead of to a literal.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
TEAM_ROOT="$WORK/repo"
export TAP_HOME="$TEAM_ROOT/.tap/bus"
export TAP_INDEX_HOME="$WORK/index" TAP_SESSION_MANIFEST="$WORK/sessions.json"
mkdir -p "$TAP_INDEX_HOME" && printf '{"schema":"0.20","teams":{}}\n' > "$TAP_INDEX_HOME/global-registry.json"  # born live (F1)
export PATH="$FAKE_BIN:$PATH"
# Pin the server generation so the stale-row arm below is exercised by a KNOWN
# mismatch rather than by an unobservable epoch (which is a different branch).
export TAP_SERVER_EPOCH="900:100"
export TAP_BOOT_ID="boot:2"
export FAKE_EVENTS="$WORK/tmux-events"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$FAKE_BIN"
git -C "$TEAM_ROOT" init -q
: > "$FAKE_EVENTS"

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  list-sessions)
    if [[ "$*" == *'start_time'* ]]; then
      count_file="$FAKE_EVENTS.list-sessions-count"
      count="$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))"
      printf '%s\n' "$count" > "$count_file"
      if [ "$count" -gt 1 ]; then
        # The wrapper's known unresponsive signature (exit 124 + this stderr)
        # must map to the point-of-use refusal, not the transport class.
        if [ "${FAKE_ATTACH_RECHECK_SERVER_UNRESPONSIVE:-0}" = 1 ]; then
          echo 'fork failed: Device not configured' >&2
          exit 124
        fi
        if [ "${FAKE_ATTACH_RECHECK_UNOBSERVABLE:-0}" = 1 ]; then
          exit 1
        fi
      fi
      printf 'demo/live\t1:1\n'
      printf 'demo/driver\t1:1\n'
      printf 'demo/stale\t1:1\n'
      printf 'demo/rebooted\t1:1\n'
      printf 'demo/recycled\t1:1\n'
      printf 'demo/foreign\t1:1\n'
    else
      printf '%s\n' demo/live demo/driver demo/stale demo/rebooted demo/recycled demo/foreign
    fi ;;
  list-panes)
    shift; target=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -t) target="${2#=}"; shift 2 ;; *) shift ;; esac
    done
    case "$target" in
      demo/live)     printf 'demo/live\tdemo/live:0.0\t%%11\tclaude\t111\t1:1\t0\n' ;;
      demo/driver)   printf 'demo/driver\tdemo/driver:1.0\t%%12\tclaude\t112\t1:1\t0\ndemo/driver\tdemo/driver:2.0\t%%77\tclaude\t177\t1:1\t0\ndemo/driver\tdemo/driver:3.0\t%%78\tclaude\t178\t1:1\t0\n' ;;
      demo/stale)    printf 'demo/stale\tdemo/stale:0.0\t%%13\tclaude\t113\t1:1\t0\n' ;;
      demo/rebooted) printf 'demo/rebooted\tdemo/rebooted:0.0\t%%14\tclaude\t114\t1:1\t0\n' ;;
      demo/recycled) printf 'demo/recycled\tdemo/recycled:0.0\t%%15\tclaude\t115\t1:1\t0\n' ;;
      demo/foreign)  printf 'demo/foreign\tdemo/foreign:0.0\t%%99\tclaude\t199\t1:1\t0\n' ;;
      *) exit 1 ;;
    esac ;;
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
      *pane_id*)
        # Same signature as (8a), one read later: the pane-id recheck.
        if [ "${FAKE_ATTACH_PANE_ID_UNRESPONSIVE:-0}" = 1 ]; then
          echo 'fork failed: Device not configured' >&2
          exit 124
        fi
        case "$target" in
          "%11"|"demo/live:0.0") echo "%11" ;;
          "%12"|"demo/driver:1.0") echo "%12" ;;
          "%77"|"demo/driver:2.0") echo "%77" ;;
          "%78"|"demo/driver:3.0") echo "%78" ;;
          "%13"|"demo/stale:0.0") echo "%13" ;;
          "%14"|"demo/rebooted:0.0") echo "%14" ;;
          *) echo "" ;;
        esac ;;
      *) echo "" ;;
    esac ;;
  has-session)
    # The point-of-use re-verify (Amendment 2, Lane D) asks this for the exact
    # name it is about to attach; answer truthfully for the sessions this
    # fixture lists. OLD: "No session name vouches for anything in this
    # fixture", exit 1 unconditionally — that stub predates the re-verify and
    # would refuse every legitimate attach (fixture-update class (a), adjudicated
    # in the fixture inventory).
    shift; target=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -t) target="${2#=}"; shift 2 ;; *) shift ;; esac
    done
    case "$target" in
      demo/live|demo/driver|demo/stale|demo/rebooted|demo/recycled|demo/foreign) exit 0 ;;
      *) exit 1 ;;
    esac ;;
  select-window|select-pane)
    printf '%s\n' "$*" >> "$FAKE_EVENTS"
    # Model tmux's two window-name modes: a second '=' exact-pins the window,
    # while an unpinned component may resolve a unique prefix. The crew handle
    # "crew" is absent but uniquely prefixes the sibling window "crew-sol".
    # OLD: every select recorded and succeeded, so the cross-session-mutation
    # shape (select by stored %N) could never be caught here.
    shift; target=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -t) target="${2#=}"; shift 2 ;; *) shift ;; esac
    done
    case "$target" in
      demo/driver:crew-sol|demo/driver:crew|demo/driver:=crew-sol) exit 0 ;;
      *) exit 1 ;;
    esac ;;
  switch-client|attach-session)
    printf '%s\n' "$*" >> "$FAKE_EVENTS" ;;
  *) : ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": { "name": "demo" },
  "seats": {
    "live":     { "pane": "demo/live:0.0",   "pane_id": "%11", "harness": "claude", "status": "active", "session": "demo/live", "server_epoch": "900:100", "boot_id": "boot:2" },
    "crew":     { "pane": "demo/driver:3.0", "pane_id": "%78", "harness": "claude", "status": "active", "crew": true },
    "crew-sol": { "pane": "demo/driver:1.0", "pane_id": "%12", "harness": "claude", "status": "active", "crew": true },
    "crew-ghost": { "pane": "demo/driver:2.0", "pane_id": "%77", "harness": "claude", "status": "active", "crew": true },
    "gone":     { "pane": "demo/gone:0.0",   "pane_id": "%99", "harness": "claude", "status": "active", "session": "demo/gone" },
    "stale":    { "pane": "demo/stale:0.0",  "pane_id": "%13", "harness": "claude", "status": "active", "session": "demo/stale", "server_epoch": "800:50" },
    "rebooted": { "pane": "demo/rebooted:0.0", "pane_id": "%14", "harness": "claude", "status": "active", "session": "demo/rebooted", "server_epoch": "900:100", "boot_id": "boot:1" },
    "recycled": { "pane": "demo/recycled:0.0", "pane_id": "%99", "harness": "claude", "status": "active", "session": "demo/recycled", "server_epoch": "900:100", "boot_id": "boot:2" },
    "pollbot":  { "delivery": "poll", "harness": "daemon", "status": "active", "unattended": true }
  }
}
JSON
# Team "demo" is named by its registry, not the root basename: enroll it.
printf '{"schema":"0.20","teams":{"demo":{"root":"%s","registry_location":"%s/registry.json","state":"registered"}}}\n' "$(cd "$TEAM_ROOT" && pwd -P)" "$(cd "$TAP_HOME" && pwd -P)" > "$TAP_INDEX_HOME/global-registry.json"

fail() { echo "attach: $1" >&2; shift; [ "$#" -eq 0 ] || printf '%s\n' "$@" >&2; exit 1; }
error_class() { python3 -c 'import json,sys; print(json.loads(sys.argv[1])["error_class"])' "$1"; }


# ── tap-52ys: 8 of 10 arms removed (ratified 2026-08-14) ────────────────────
# grok's call: keep case (7) — THE INVARIANT, that the roster and attach cannot
# disagree about who is attachable — plus case (1), which builds the roster the
# invariant compares against. Everything else was tmux/GUI mechanics, and
# attach-interactive (the picker) was deleted outright in this same cut.
#
# grok's 3x brake applies here: if this pair still costs ~15s, the file leaves
# the gate rather than being shrunk a second time.
#
# Accepted gap, named: the unobservable-caller refusal, attach-session outside
# tmux, the crew-window family (4, 4b, 4c), the refusal doors (5), and the
# resume-offer polarities (6, 6b).

# --- (1) --names is roster-derived; --active narrows to attachable ------------
names="$("$TAP" team --names)"
[ "$names" = "$(printf 'crew\ncrew-ghost\ncrew-sol\ngone\nlive\npollbot\nrebooted\nrecycled\nstale')" ] \
  || fail "(1) --names should list every rostered handle, one per line" "$names"
active="$("$TAP" team --names --active)"
[ "$active" = "$(printf 'crew\ncrew-ghost\ncrew-sol\nlive')" ] \
  || fail "(1) --active should keep only attachable seats" "$active"
# The gone seat MUST stay in the bare list: that is what lets `ta gone` reach
# attach's resume offer at all (the two features only compose that way).
grep -qx gone <<<"$names" || fail "(1) gone seat must be listed without --active"
grep -qx gone <<<"$active" && fail "(1) gone seat must NOT survive --active"
grep -qx pollbot <<<"$active" && fail "(1) poll member is pane-less and must not be --active"
echo "attach: (1) --names lists the roster, --active narrows to attachable: ok"

# --- (7) THE INVARIANT: the roster and attach cannot disagree ----------------
# One fixture, one probe outcome, two surfaces compared to EACH OTHER. If the
# classifier ever forks in two, exactly one of these seats flips and this fails.
: > "$FAKE_EVENTS"
attachable="$("$TAP" team --names --active)"
checked=0
while read -r handle; do
  [ -n "$handle" ] || continue
  set +e
  env -u TMUX "$TAP" attach "$handle" </dev/null >"$WORK/inv.out" 2>&1; arc=$?
  set -e
  if grep -qx "$handle" <<<"$attachable"; then
    [ "$arc" = 0 ] || fail "(7) '$handle' is listed --active but attach refused it" "$(cat "$WORK/inv.out")"
  else
    [ "$arc" = 0 ] && fail "(7) attach reached '$handle', which --active does not list" "$(cat "$WORK/inv.out")"
  fi
  checked=$((checked + 1))
done <<<"$names"
[ "$checked" = 9 ] || fail "(7) expected 9 rostered seats checked, got $checked"
echo "attach: (7) every rostered seat's attachability matches tap team --names --active: ok"

# --- (8) R11 repair: a KNOWN read-transport failure keeps its point-of-use ---
# --- refusal (session_unobservable / pane_changed), both before any effect ---
# tmux_deadline.py's unresponsive signature is exit 124 with that stderr line;
# the Bun client must translate it exactly where the incumbent's `|| true` did.
set +e
: > "$FAKE_EVENTS.list-sessions-count"
out="$(env -u TMUX TAP_JSON=1 FAKE_ATTACH_RECHECK_SERVER_UNRESPONSIVE=1 "$TAP" attach live </dev/null 2>&1)"
grep -q session_unobservable <<<"$out" && grep -q "no client was moved" <<<"$out" \
  || fail "(8a) final list-sessions ServerUnresponsive must refuse session_unobservable, naming no client moved" "$out"
: > "$FAKE_EVENTS.list-sessions-count"
out="$(env -u TMUX TAP_JSON=1 FAKE_ATTACH_PANE_ID_UNRESPONSIVE=1 "$TAP" attach live </dev/null 2>&1)"
grep -q pane_changed <<<"$out" && grep -q "no client was moved" <<<"$out" \
  || fail "(8b) final pane-id ServerUnresponsive must refuse pane_changed, naming no client moved" "$out"
set -e
echo "attach: (8) ServerUnresponsive on the final reads keeps its point-of-use refusals: ok"

# --- (10) R11 repair: the parse loop owns -i at position 0 --------------------
# `attach -i <x>` must keep the incumbent mutual-exclusion bytes, not the
# picker's generic refusal for whatever followed the flag.
for probe in --next -i --interactive; do
  out="$(env -u TMUX TAP_JSON=1 "$TAP" attach -i "$probe" </dev/null 2>&1)" || true
  grep -q "mutually exclusive" <<<"$out" \
    || fail "(10) 'attach -i $probe' must keep the incumbent mutual-exclusion refusal" "$out"
done
echo "attach: (10) -i at position 0 parses as the incumbent loop: ok"

echo "attach: ok"
