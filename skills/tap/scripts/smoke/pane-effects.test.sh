#!/usr/bin/env bash
# tap-vpk6: pane flashes must end with no pane-level style residue, serialize
# across team buses, and keep their repair token whenever cleanup is unverified.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
LIB="$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
WORK="$(mktemp -d)"
SOCK="tap-vpk6-$$"
REAL_TMUX="$(command -v tmux)"
PIDS=""

cleanup() {
  touch "$WORK/release-A" "$WORK/release-B" 2>/dev/null || true
  for pid in $PIDS; do kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; done
  "$REAL_TMUX" -L "$SOCK" kill-server 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT
fail() { echo "pane-effects: $*" >&2; exit 1; }

export REAL_TMUX SOCK WORK
# The pane effect runs natively (spool-park-report.ts), so the seam is the `tmux`
# BINARY on PATH — a shell function would reach only this shell. The shim pins the
# fixture's private server, carries the serialization barrier (FLASH_ROLE: the first
# set-option — the flash's pane-scoped tint — blocks until released), and can make
# identity reads fail after a budget
# (TMUX_SHIM_OBSERVE_BUDGET: PANE-record reads — the display-message whose format asks
# for the pane's pid/command — beyond it exit 1; server-identity probes are never
# counted, since the runner re-probes them on a 100 ms cache and counting them would
# make the budget timing-dependent — the "identity turned unknown" shape the token and
# repair arms need).
mkdir -p "$WORK/bin"
cat > "$WORK/bin/tmux" <<'SHIM'
#!/usr/bin/env bash
if [ "${1:-}" = display-message ] && [ -n "${TMUX_SHIM_OBSERVE_BUDGET:-}" ]; then
  case "${@: -1}" in *pane_pid*|*pane_current_command*)
    n=$(( $(cat "$WORK/observe.count" 2>/dev/null || echo 0) + 1 )); printf '%s' "$n" > "$WORK/observe.count"
    [ "$n" -le "$TMUX_SHIM_OBSERVE_BUDGET" ] || exit 1 ;;
  esac
fi
if [ "${1:-}" = set-option ] && [ -n "${FLASH_ROLE:-}" ] \
   && [ ! -f "$WORK/$FLASH_ROLE.once" ]; then
  touch "$WORK/$FLASH_ROLE.once" "$WORK/$FLASH_ROLE.reached"
  # Held until the harness releases the role; the cap only bounds a failed harness (the
  # native set-option call itself times out at 10 s), so it is generous for a loaded runner.
  for _ in $(seq 1 400); do
    [ -f "$WORK/release-$FLASH_ROLE" ] && break
    sleep 0.02
  done
  [ -f "$WORK/release-$FLASH_ROLE" ] || exit 99
fi
exec "$REAL_TMUX" -L "$SOCK" "$@"
SHIM
chmod +x "$WORK/bin/tmux"
export PATH="$WORK/bin:$PATH"

tmux new-session -d -s probe
PANE="$(tmux display-message -p -t probe:0.0 '#{pane_id}')"
export PANE

export TAP_HOME="$WORK/bus-main"
export TAP_LOCK_DIR="$WORK/locks"
export TAP_PANE_SUBMIT_LOCK_TIMEOUT=5
mkdir -p "$TAP_HOME" "$TAP_LOCK_DIR"
# shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
. "$LIB"
. "${LIB%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"

pane_option() { tmux show-options -p -t "$PANE" "$1" 2>/dev/null || return 1; }
clear_fixture_style() {
  tmux set-option -p -u -t "$PANE" window-style 2>/dev/null || true
  tmux set-option -p -u -t "$PANE" window-active-style 2>/dev/null || true
}
seed_style() {
  clear_fixture_style
  tmux select-pane -t "$PANE" -P 'bg=colour22'
  [ -n "$(pane_option window-style)" ] || fail "fixture did not seed window-style"
  [ -n "$(pane_option window-active-style)" ] || fail "fixture did not seed window-active-style"
}
write_token() { # <bus> <owner> [<server-epoch>]
  local bus="$1" owner="$2" epoch="${3:-}" path
  [ -n "$epoch" ] || epoch="$(tap_server_epoch_now)"
  path="$bus/pane-effects/$PANE.json"
  mkdir -p "$(dirname "$path")"
  python3 -B - "$path" "$owner" "$PANE" "$epoch" <<'PY'
import json, sys
path, owner, pane, epoch = sys.argv[1:]
with open(path, "w", encoding="utf-8") as fh:
    json.dump({"v": 2, "owner_id": owner, "pane": pane, "pane_id": pane,
               "server_epoch": epoch, "applied_style": "bg=colour22"}, fh,
              sort_keys=True)
    fh.write("\n")
PY
}

case_clean() {
  seed_style
  tap_bun_call spool-park-report clean-1 spool-park-report.ts flash "$TAP_HOME" "$PANE" "$PANE" clean-1 'bg=green' 1
  [ -z "$(pane_option window-style)" ] \
    || fail "clean: window-style residue remained: $(pane_option window-style)"
  [ -z "$(pane_option window-active-style)" ] \
    || fail "clean: window-active-style residue remained: $(pane_option window-active-style)"
  [ ! -e "$TAP_HOME/pane-effects/$PANE.json" ] \
    || fail "clean: verified cleanup left its repair token"
  echo "pane-effects: ok [clean] verified flash cleanup unsets both pane options"
}

case_token() (
  seed_style
  # Two writes: the pane-record reads for the address and for the first write succeed
  # and apply the style; the next turns unknown (budget 2 pane records; identity probes
  # are not counted). Cleanup must retain the token rather than clearing on an
  # unverified identity — and the GREEN style the flash applied stays (the seeded
  # colour22 alone would make the retention assertion vacuous).
  rm -f "$WORK/observe.count"
  TMUX_SHIM_OBSERVE_BUDGET=2 tap_bun_call spool-park-report token-1 spool-park-report.ts flash "$TAP_HOME" "$PANE" "$PANE" token-1 'bg=green' 2
  [ "$(pane_option window-style)" = 'window-style bg=green' ] \
    || fail "token: the first write did not apply bg=green before the identity turned unknown: $(pane_option window-style)"
  [ -e "$TAP_HOME/pane-effects/$PANE.json" ] \
    || fail "token: unknown restore identity destroyed the only repair token"
  [ -n "$(pane_option window-style)" ] \
    || fail "token: fixture never observed the applied style; retention assertion is vacuous"
  echo "pane-effects: ok [token] unknown restore identity retains the token"
)

wait_for_file() { # <path> <label>
  local path="$1" label="$2"
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 \
           21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 \
           41 42 43 44 45 46 47 48 49 50; do
    [ -f "$path" ] && return 0
    sleep 0.02
  done
  fail "$label"
}

case_serial() {
  clear_fixture_style
  bus_a="$WORK/bus-A"; bus_b="$WORK/bus-B"
  mkdir -p "$bus_a" "$bus_b"
  runner="$WORK/run-flash.sh"
  printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' \
    'export TAP_HOME="$1" FLASH_ROLE="$2"' \
    '. "$LIB"' \
    'touch "$WORK/$FLASH_ROLE.started"' \
    'tap_bun_call spool-park-report "$FLASH_ROLE" spool-park-report.ts flash "$TAP_HOME" "$PANE" "$PANE" "$FLASH_ROLE" "bg=green" 1' > "$runner"
  chmod +x "$runner"
  export LIB

  bash "$runner" "$bus_a" A & a_pid=$!; PIDS="$PIDS $a_pid"
  wait_for_file "$WORK/A.reached" "serial: process A never reached the real pane effect"
  [ -e "$bus_a/pane-effects/$PANE.json" ] \
    || fail "serial: fixture did not observe A's live effect token"

  bash "$runner" "$bus_b" B & b_pid=$!; PIDS="$PIDS $b_pid"
  wait_for_file "$WORK/B.started" "serial: process B never started"
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25; do
    [ -f "$WORK/B.reached" ] && break
    sleep 0.02
  done
  [ ! -e "$bus_b/pane-effects/$PANE.json" ] \
    || fail "serial: a second team bus minted a concurrent token for the same pane"
  [ ! -f "$WORK/B.reached" ] \
    || fail "serial: B reached the pane while A still owned the machine-global pane lock"

  touch "$WORK/release-A"
  wait "$a_pid"; PIDS="${PIDS/ $a_pid/}"
  wait_for_file "$WORK/B.reached" "serial: B did not proceed after A released the lock"
  [ -e "$bus_b/pane-effects/$PANE.json" ] \
    || fail "serial: B reached the effect without publishing its repair token"
  touch "$WORK/release-B"
  wait "$b_pid"; PIDS="${PIDS/ $b_pid/}"

  [ -z "$(pane_option window-style)$(pane_option window-active-style)" ] \
    || fail "serial: serialized flashes left pane-style residue"
  [ ! -e "$bus_a/pane-effects/$PANE.json" ] && [ ! -e "$bus_b/pane-effects/$PANE.json" ] \
    || fail "serial: verified cleanup left a token"
  echo "pane-effects: ok [serial] distinct buses share one pane-effect owner"
}

case_repair() {
  seed_style
  write_token "$TAP_HOME" repair-ok
  spool_engine_fixture repair
  [ -z "$(pane_option window-style)$(pane_option window-active-style)" ] \
    || fail "repair: confirmed orphan cleanup left pane-style residue"
  [ ! -e "$TAP_HOME/pane-effects/$PANE.json" ] \
    || fail "repair: confirmed cleanup retained its token"

  seed_style
  write_token "$TAP_HOME" repair-stale 'srv:stale:1'
  spool_engine_fixture repair
  [ ! -e "$TAP_HOME/pane-effects/$PANE.json" ] \
    || fail "repair: a token from a dead server generation was retained"
  [ "$(pane_option window-style)" = 'window-style bg=colour22' ] \
    || fail "repair: stale token modified the recycled pane's style"

  seed_style
  write_token "$TAP_HOME" repair-unknown
  # Identity unknown at the tmux boundary: every pane-record read fails, so the native
  # clear cannot verify; the server generation still reads the same, so the token is
  # neither cleared nor dropped — the token stays, the pane too.
  rm -f "$WORK/observe.count"
  TMUX_SHIM_OBSERVE_BUDGET=0 spool_engine_fixture repair
  [ -e "$TAP_HOME/pane-effects/$PANE.json" ] \
    || fail "repair: unknown identity destroyed the repair token"
  [ -n "$(pane_option window-style)" ] \
    || fail "repair: unknown identity modified the pane instead of failing closed"
  echo "pane-effects: ok [repair] repair removes only a verified-clean token"
}

case "${1:-all}" in
  clean) case_clean ;;
  token) case_token ;;
  serial) case_serial ;;
  repair) case_repair ;;
  all) case_clean; case_token; case_serial; case_repair ;;
  *) fail "usage: $0 [clean|token|serial|repair]" ;;
esac

echo "pane-effects: PASS"
