#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# effect-guard-observes-fresh.test.sh — tap-lae7 / sol P1 2026-08-06.
#
# Point-of-effect identity guards must observe live tmux state on EVERY call.
# The spool deliverer exports a process-scoped observation reuse channel
# (TAP_OBS_PROCESS_MEMO) for its whole retry loop; if the N=1 observation
# honors it, the guard deliberately adjacent to the injection consumes a
# result recorded before the pane changed hands, and a recycled pane receives
# effects intended for its prior occupant. The reuse key is built from
# REGISTRY-ROW fields while the value encodes LIVE state — so any world change
# under an unchanged row is exactly a stale hit.
#
# WHAT EACH CASE PROVES
#   A  Under the deliverer's exact env shape (TAP_OBS_PROCESS_MEMO=$$), two
#      guard reads in one process straddling a pane-id change must DISAGREE:
#      first 'match', second 'address_rebound', and submitIdentityGuard
#      must refuse (rc 6) with zero injection side effects.
#   B  Fixture self-check: without the reuse channel the same flip yields the
#      same match -> address_rebound sequence — proving the fixture can detect
#      recycling at all, so A's verdict is about the channel, not the fixture.
#   C  Removal pin: with TAP_OBS_PROCESS_MEMO set, no reuse file may appear in
#      TMPDIR — the channel is GONE, not merely skipped by the two guards this
#      test names. Reintroducing any cross-call observation reuse must come
#      back through this test.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
LIB="$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket"
export TMPDIR="$WORK/tmp"; mkdir -p "$TMPDIR"

# Stateful fake tmux: the pane id at address T/seat:0.0 comes from a file, so
# the test can recycle the pane mid-process. Injection side effects (send-keys)
# are logged so refusal can be asserted as ZERO effects, not just an rc.
PANE_ID_FILE="$WORK/pane-id"; printf '%%11' > "$PANE_ID_FILE"
EFFECT_LOG="$WORK/effects.log"; : > "$EFFECT_LOG"
cat > "$FAKE_BIN/tmux" <<TMUX
#!/usr/bin/env bash
set -euo pipefail
PANE_ID_FILE="$PANE_ID_FILE"
EFFECT_LOG="$EFFECT_LOG"
TMUX
cat >> "$FAKE_BIN/tmux" <<'TMUX'
pid="$(cat "$PANE_ID_FILE")"
cmd="${1:-}"; shift || true
case "$cmd" in
  send-keys|paste-buffer|load-buffer)
    printf '%s\n' "$cmd $*" >> "$EFFECT_LOG"
    exit 0 ;;
  list-sessions)
    printf 'T/seat\t4242:99\t1\n'
    exit 0 ;;
  list-panes)
    printf 'T/seat\tT/seat:0.0\t%s\tcodex\t111\t4242:99\t0\n' "$pid"
    exit 0 ;;
  display-message) ;;
  *) exit 0 ;;
esac
target=""; fmt=""
while [ "$#" -gt 0 ]; do
  case "$1" in -p) shift ;; -t) target="$2"; shift 2 ;; *) fmt="$1"; shift ;; esac
done
if [ -z "$target" ]; then
  case "$fmt" in *pid*start_time*) printf '4242:99\n' ;; *) printf '\n' ;; esac
  exit 0
fi
case "$target" in
  "$pid"|"T/seat:0.0") ;;
  *) printf '\n'; exit 0 ;;
esac
out="$fmt"
out="${out//'#{pane_id}'/$pid}"
out="${out//'#{session_name}'/T/seat}"
out="${out//'#{pid}:#{start_time}'/4242:99}"
printf '%s\n' "$out"
TMUX
chmod +x "$FAKE_BIN/tmux"

cat > "$FAKE_BIN/ps" <<'PS'
#!/usr/bin/env bash
printf ' 111 111 111 codex codex\n'
PS
chmod +x "$FAKE_BIN/ps"

REG="$WORK/registry.json"
printf '{"schema": "0.20", "team":{"name":"T","worktree_root":"/tmp/T"},"seats":{"seat":{"status":"active","delivery":"pane","pane":"T/seat:0.0","pane_id":"%%11","server_epoch":"srv:4242:99","harness":"codex"}}}\n' > "$REG"

# One process, two guard reads straddling a recycle — the deliverer's shape.
# After the second read, invoke the native identity guard and log a fixture
# effect only for its authorized verdict. The native courier's effect wiring
# is exercised separately by its submit tests.
# Emits: first state, second state, guard rc, reuse-file count.
run_sequence() { # $1 = "memo" | "plain"   $2 = "flip" | "noflip"
  local mode="$1" flip="$2"
  env PANE_ID_FILE="$PANE_ID_FILE" REG="$REG" LIB="$LIB" FIXTURE="$ROOT/skills/tap/scripts/smoke/spool-readiness-fixture.sh" MODE="$mode" FLIP="$flip" bash <<'SEQ'
set -u
. "$LIB" >/dev/null 2>&1
. "$FIXTURE" >/dev/null 2>&1
[ "$MODE" = memo ] && export TAP_OBS_PROCESS_MEMO=$$
printf '%%11' > "$PANE_ID_FILE"
first="$(bound_pane_identity_fixture "$REG" seat "T/seat:0.0" "%11")"
[ "$FLIP" = flip ] && printf '%%12' > "$PANE_ID_FILE"
second="$(bound_pane_identity_fixture "$REG" seat "T/seat:0.0" "%11")"
guard_rc=6
verdict="$(tap_bun_call submit-identity seat pane-identity.ts guard 0 "$REG" seat "T/seat:0.0" "%11" "" "")"
if [ "${verdict%%$'\x1f'*}" = authorized ]; then
  guard_rc=0
  tmux send-keys -t "T/seat:0.0" -l "guarded-effect"
fi
reuse_files="$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'tap-obs-memo-*' 2>/dev/null | wc -l | tr -d ' ')"
printf '%s|%s|%s|%s\n' "$first" "$second" "$guard_rc" "$reuse_files"
SEQ
}

fails=0

# ── B first: fixture self-check without the reuse channel ────────────────────
IFS='|' read -r b_first b_second b_rc b_files <<< "$(run_sequence plain flip)"
if [ "$b_first" = match ] && [ "$b_second" = address_rebound ] && [ "$b_rc" = 6 ]; then
  echo "effect-guard-observes-fresh: ok [B] fixture detects recycle without the reuse channel (match -> address_rebound, guard rc 6)"
else
  echo "effect-guard-observes-fresh: FAIL [B] fixture cannot detect recycling (first='$b_first' second='$b_second' rc='$b_rc') — case A proves nothing until this is fixed" >&2
  fails=$((fails + 1))
fi

# ── A: the deliverer's env shape must not blind the guard ────────────────────
IFS='|' read -r a_first a_second a_rc a_files <<< "$(run_sequence memo flip)"
if [ "$a_first" = match ] && [ "$a_second" = address_rebound ] && [ "$a_rc" = 6 ]; then
  echo "effect-guard-observes-fresh: ok [A] guard observes fresh under TAP_OBS_PROCESS_MEMO (match -> address_rebound, guard rc 6)"
else
  echo "effect-guard-observes-fresh: FAIL [A] under the deliverer's TAP_OBS_PROCESS_MEMO shape the second read returned '$a_second' (rc '$a_rc') for a RECYCLED pane — the point-of-effect guard consumed a pre-recycle observation and would authorize injection into the new occupant" >&2
  fails=$((fails + 1))
fi

# ── zero injection side effects in both sequences ────────────────────────────
if [ -s "$EFFECT_LOG" ]; then
  echo "effect-guard-observes-fresh: FAIL refused guard still produced pane effects:" >&2
  cat "$EFFECT_LOG" >&2
  fails=$((fails + 1))
else
  echo "effect-guard-observes-fresh: ok [A/B] zero send-keys/paste effects across both sequences"
fi

# ── D. positive control: an unchanged binding DOES inject, and the log sees it
# Proves the effect sensor records — without this, the zero-effects assertion
# above would also pass on a fixture that simply cannot log.
IFS='|' read -r d_first d_second d_rc d_files <<< "$(run_sequence plain noflip)"
if [ "$d_first" = match ] && [ "$d_second" = match ] && [ "$d_rc" = 0 ] && [ -s "$EFFECT_LOG" ]; then
  echo "effect-guard-observes-fresh: ok [D] unchanged binding passes the guard and the effect log records the injection"
else
  echo "effect-guard-observes-fresh: FAIL [D] positive control broke (first='$d_first' second='$d_second' rc='$d_rc' log_nonempty=$([ -s "$EFFECT_LOG" ] && echo yes || echo no)) — either the guard over-closed or the effect sensor cannot record, which would make the zero-effects assertion vacuous" >&2
  fails=$((fails + 1))
fi

# ── C: the reuse channel is removed, not bypassed ────────────────────────────
if [ "${a_files:-0}" = 0 ]; then
  echo "effect-guard-observes-fresh: ok [C] no observation-reuse file appears in TMPDIR under TAP_OBS_PROCESS_MEMO"
else
  echo "effect-guard-observes-fresh: FAIL [C] $a_files observation-reuse file(s) in TMPDIR — the channel still exists; every consumer of tap_seat_observed_record can be served a pre-recycle result" >&2
  fails=$((fails + 1))
fi

[ "$fails" -eq 0 ] || { echo "effect-guard-observes-fresh: FAILED ($fails)" >&2; exit 1; }
echo "effect-guard-observes-fresh: PASS"
