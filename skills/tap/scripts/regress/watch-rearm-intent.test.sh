#!/usr/bin/env bash
# tap-o4ae: fixture env must stay in this process. Refuse `source` so an
# interactive shell cannot inherit top-level exports. Must run BEFORE any
# `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# watch-rearm-intent.test.sh — tap-0nzm: a same-goal re-arm compares the CALLER'S
# WHOLE INTENT, not done_when alone.
#
# The defect this pins: `tap watch on` accepts eight caller-settable settings and
# gated idempotence on ONE of them, so a re-arm carrying different settings
# returned 0, printed "already armed", and discarded them. The severe case is
# `--evaluator none` — the only way a caller says "stop reading my pane
# transcripts" — which reported success while the evaluator stayed armed and
# consented.
#
# FIXTURE NOTE, load-bearing (tap-0nzm, third instance of this pattern in one
# night): watch-arm-lease.test.sh re-arms with IDENTICAL settings and asserts the
# episode survives. That is correct behaviour and it passes, and it is
# structurally incapable of observing a dropped setting because the fixture
# varies nothing. Every case below that must detect a drop VARIES the setting
# away from what is stored; cases (c) and (d) hold it fixed on purpose, to prove
# the fix does not over-refuse.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAPSH="$ROOT/bin/tap"
LIB="$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TAP_INDEX_HOME="$WORK/index"
export TAP_WATCH_NO_SPAWN=1

# tap-calo: `watch off` takes its actor from the calling pane (never --by), and the already-armed
# door picks bare `off` vs `--force` from the same pane. Cases (e) and (f) vary the CALLER, so the
# fake answers the calling-pane observation for $FAKE_CALLER_PANE (%0 lead, %1 worker); unset = a
# pane-less caller, which is what the between-case resets below are.
FAKE_BIN="$WORK/bin"; mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/ps" <<'PS'
#!/usr/bin/env bash
case "$*" in
  *ppid*tty*) [ -n "${FAKE_CALLER_PANE:-}" ] && printf '1 faketty\n' || printf '1 ??\n' ;;
  *) exec /bin/ps "$@" ;;
esac
PS
chmod +x "$FAKE_BIN/ps"
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
target=""; args=("$@"); i=0
while [ "$i" -lt "${#args[@]}" ]; do [ "${args[$i]}" = -t ] && target="${args[$((i+1))]:-}"; i=$((i+1)); done
fmt="${!#}"
case "${1:-}" in
  list-panes)
    case "$fmt" in *pane_tty*) [ -n "${FAKE_CALLER_PANE:-}" ] && printf '%s\t/dev/faketty\n' "$FAKE_CALLER_PANE" ;; esac
    exit 0 ;;
  display-message)
    case "$fmt" in
      *pane_id*pane_tty*session_name*) printf '%s\t/dev/faketty\trepo\t4242:100\n' "${target:-$FAKE_CALLER_PANE}" ;;
      *pane_id*session_name*) printf '%s\trepo\t4242:100\n' "${target:-$FAKE_CALLER_PANE}" ;;
      *pid*start_time*) printf '4242:100\n' ;;
      *) printf '\n' ;;
    esac
    exit 0 ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket"

BUS="$WORK/repo/.tap/bus"; mkdir -p "$BUS/payloads" "$BUS/receipts"
cat > "$BUS/registry.json" <<JSON
{"schema": "0.20",  "team": { "name": "repo", "worktree_root": "$WORK/repo" },
  "seats": { "lead": { "pane": "repo/lead:0.0", "pane_id": "%0", "server_epoch": "srv:4242:100", "harness": "claude",
                        "status": "active", "delivery": "pane",
                        "registered_from_worktree": "$WORK/repo" } } }
JSON
# Born live (F2a): native verbs refuse an absent machine marker, so enroll the team.
mkdir -p "$TAP_INDEX_HOME"
printf '{"schema":"0.20","teams":{"repo":{"root":"%s","registry_location":"%s","state":"registered"}}}\n' \
  "$(mkdir -p "$WORK/repo" && cd "$WORK/repo" && pwd -P)" "$(cd "$BUS" && pwd -P)/registry.json" > "$TAP_INDEX_HOME/global-registry.json"

GOAL="suite green; proof: run smokes; bound 2h"
field () { TAP_HOME="$BUS" bash -c ". '$LIB'; tap_bun_call watch field watch-lease.ts \"\$TAP_HOME/watch/arm.json\" field \"$1\"" 2>/dev/null; }
# Every armed value below is deliberately NOT the flag's default (threshold
# defaults to 1500, evaluator to codex). A fixture holding the defaults cannot
# tell "compared the caller's explicit intent" from "compared the defaulted
# value" — both agree with the stored record — so case (c) would pass for the
# wrong reason. `codex` in arm_codex is unavoidable, since the revocation case
# needs an evaluator armed; the threshold carries the discrimination there.
arm_codex () {
  TAP_HOME="$BUS" bash "$TAPSH" watch off --force >/dev/null 2>&1 || true
  TAP_HOME="$BUS" bash "$TAPSH" watch on --by lead -m "$GOAL" \
    --evaluator codex --threshold 900 --no-spawn >/dev/null 2>&1
}
# For (c): BOTH settings differ from their defaults, so any comparison that
# reaches for a default instead of the caller's intent refuses and reds the case.
arm_nondefault () {
  TAP_HOME="$BUS" bash "$TAPSH" watch off --force >/dev/null 2>&1 || true
  TAP_HOME="$BUS" bash "$TAPSH" watch on --by lead -m "$GOAL" \
    --evaluator none --threshold 900 --no-spawn >/dev/null 2>&1
}
fail () { echo "watch-rearm-intent: $1" >&2; exit 1; }
# tap-calo: `watch off` takes its actor from the calling pane, never --by, and this fixture has no pane.
# Between cases the lease is simply reset with the loud escape (--force), which is the same on either side.

# --- (a) THE P1: a consent revocation must not report success ------------------
# --evaluator none against a codex-armed watch. The caller is asking to stop
# transcript reading; today this returns 0 and leaves codex armed.
arm_codex
[ "$(field evaluator)" = "codex" ] || fail "(a) fixture did not arm codex"
if out="$(TAP_HOME="$BUS" bash "$TAPSH" watch on --by lead -m "$GOAL" --evaluator none --no-spawn 2>&1)"; then
  fail "(a) --evaluator none on a codex-armed watch returned 0; a consent revocation reported success. said: $out"
fi
[ "$(field evaluator)" = "codex" ] \
  || fail "(a) refusal must leave the stored evaluator alone, found '$(field evaluator)'"
case "$out" in
  *"evaluator"*) ;;
  *) fail "(a) refusal does not name the setting that differs: $out" ;;
esac
echo "watch-rearm-intent: (a) --evaluator none refuses rather than reporting a revocation that did not happen: ok"

# --- (b) any other explicitly-passed setting that differs also refuses ---------
arm_codex
if out="$(TAP_HOME="$BUS" bash "$TAPSH" watch on --by lead -m "$GOAL" --threshold 60 --no-spawn 2>&1)"; then
  fail "(b) a differing --threshold returned 0 and discarded the value. said: $out"
fi
[ "$(field threshold_seconds)" = "900" ] \
  || fail "(b) refusal must leave the stored threshold alone, found '$(field threshold_seconds)'"
echo "watch-rearm-intent: (b) a differing explicitly-passed --threshold refuses: ok"

# --- (c) BAR 1: an OMITTED flag is not a request to change anything ------------
# Bare same-goal re-arm. Nothing was asked for, so nothing may be refused and
# nothing may be clobbered — including the non-default threshold set above.
arm_nondefault
[ "$(field evaluator)" = "none" ] && [ "$(field threshold_seconds)" = "900" ] \
  || fail "(c) fixture must store NON-default values or the case cannot discriminate"
out="$(TAP_HOME="$BUS" bash "$TAPSH" watch on --by lead -m "$GOAL" --no-spawn 2>&1)" \
  || fail "(c) a bare same-goal re-arm must stay a no-op success, got a refusal: $out"
[ "$(field evaluator)" = "none" ] || fail "(c) bare re-arm clobbered the evaluator with its default"
[ "$(field threshold_seconds)" = "900" ] || fail "(c) bare re-arm clobbered the threshold with its default"
case "$out" in
  *"already armed"*) ;;
  *) fail "(c) bare re-arm should report already armed: $out" ;;
esac
echo "watch-rearm-intent: (c) an omitted flag is not a request to change anything: ok"

# --- (d) explicitly SAME settings stay idempotent ------------------------------
arm_codex
armed_at_before="$(field armed_at)"
out="$(TAP_HOME="$BUS" bash "$TAPSH" watch on --by lead -m "$GOAL" \
        --evaluator codex --threshold 900 --no-spawn 2>&1)" \
  || fail "(d) re-arm with identical settings must stay a no-op success: $out"
[ "$(field armed_at)" = "$armed_at_before" ] \
  || fail "(d) identical re-arm reset the episode; it must leave the live episode untouched"
echo "watch-rearm-intent: (d) identical explicit settings remain idempotent: ok"

# --- (e) BAR 3: the door TAP names must open, and onto the right room ----------
# Emission is not runnability. The command under test is specifically the one in
# the refusal's `next:` field -- that is what TAP tells the caller to run.
#
# An earlier version of this case searched the WHOLE refusal for "--rearm" and
# "watch off" and passed while `next:` named a command that does not exist: the
# needles were still present in the explanatory detail. It validated the prose,
# not the door. Anchor on `next:` and RUN it.
arm_codex
hatch_out="$(FAKE_CALLER_PANE=%0 TAP_HOME="$BUS" bash "$TAPSH" watch on --by lead -m "$GOAL" --evaluator none --no-spawn 2>&1 || true)"
case "$hatch_out" in
  *"next: "*) ;;
  *) fail "(e) refusal carries no next: remediation: $hatch_out" ;;
esac
hatch_next="${hatch_out##*next: }"
hatch_next="${hatch_next%%$'\n'*}"

# The primary door: everything before the trailing "# or ..." alternative.
primary="${hatch_next%%#*}"
primary="$(printf '%s' "$primary" | sed 's/[[:space:]]*$//')"
case "$primary" in
  "tap "*) ;;
  *) fail "(e) next: does not name a runnable tap command: '$primary'" ;;
esac
arm_codex
# shellcheck disable=SC2086 -- deliberate word-splitting: run exactly what TAP printed
FAKE_CALLER_PANE=%0 TAP_HOME="$BUS" bash "$TAPSH" ${primary#tap } >/dev/null 2>&1 \
  || fail "(e) TAP's own next: remediation is not runnable: '$primary'"
# ...and it must land the caller where they were headed: after the door, the
# revocation they originally asked for succeeds.
TAP_HOME="$BUS" bash "$TAPSH" watch on --by lead -m "$GOAL" --evaluator none --no-spawn >/dev/null 2>&1 \
  || fail "(e) the door opened but the revocation still fails afterwards: '$primary'"
[ "$(field evaluator)" = "none" ] \
  || fail "(e) door ran and revocation returned 0, but the evaluator is still '$(field evaluator)'"
echo "watch-rearm-intent: (e) TAP's next: door runs and leads to the revocation: ok"

# The alternative the message offers must work too.
case "$hatch_next" in
  *"--rearm"*)
    arm_codex
    TAP_HOME="$BUS" bash "$TAPSH" watch on --by lead -m "$GOAL" --evaluator none --rearm --no-spawn >/dev/null 2>&1 \
      || fail "(e) the offered --rearm alternative is rejected"
    [ "$(field evaluator)" = "none" ] \
      || fail "(e) --rearm ran but did not apply the revocation"
    echo "watch-rearm-intent: (e) the offered --rearm alternative runs and applies the revocation: ok"
    ;;
  *) fail "(e) next: offers no --rearm alternative: '$hatch_next'" ;;
esac

# --- (f) the door must open FOR THE CALLER STANDING AT IT ---------------------
# Found by gemini reviewing the first version of this fix, which built the remedy
# from the CALLER's handle: a peer hitting the refusal on a lead-armed watch was
# told to run `tap watch off --by <peer>`, which refuses them. The door was
# emitted, and runnable — but only by the fixture's caller, who happened to BE
# the armer. Case (e) varies the command NAME; it cannot see this, because the
# defect lives on an axis (a) through (e) hold constant: WHO IS CALLING.
#
# The fixture therefore varies the caller, and the assertion is not "a door was
# named" but "this caller can open the door TAP handed THEM".
cat > "$BUS/registry.json" <<JSON
{"schema": "0.20",  "team": { "name": "repo", "worktree_root": "$WORK/repo" },
  "seats": { "lead":   { "pane": "repo/lead:0.0",   "pane_id": "%0", "server_epoch": "srv:4242:100", "harness": "claude",
                          "status": "active", "delivery": "pane", "registered_from_worktree": "$WORK/repo" },
              "worker": { "pane": "repo/worker:0.0", "pane_id": "%1", "server_epoch": "srv:4242:100", "harness": "claude",
                          "status": "active", "delivery": "pane", "registered_from_worktree": "$WORK/repo" } } }
JSON
TAP_HOME="$BUS" bash "$TAPSH" watch off --force >/dev/null 2>&1 || true
TAP_HOME="$BUS" bash "$TAPSH" watch on --by lead -m "$GOAL" --evaluator codex --no-spawn >/dev/null 2>&1
[ "$(field armed_by)" = "lead" ] || fail "(f) fixture must be armed by a DIFFERENT seat than the caller"

peer_out="$(FAKE_CALLER_PANE=%1 TAP_HOME="$BUS" bash "$TAPSH" watch on --by worker -m "$GOAL" --evaluator none --no-spawn 2>&1 || true)"
case "$peer_out" in *"next: "*) ;; *) fail "(f) peer refusal carries no next:: $peer_out" ;; esac
peer_next="${peer_out##*next: }"; peer_next="${peer_next%%$'\n'*}"
peer_door="${peer_next%%#*}"; peer_door="$(printf '%s' "$peer_door" | sed 's/[[:space:]]*$//')"
case "$peer_door" in "tap "*) ;; *) fail "(f) peer's next: is not a runnable tap command: '$peer_door'" ;; esac
# shellcheck disable=SC2086 -- deliberate word-splitting: run exactly what TAP printed
FAKE_CALLER_PANE=%1 TAP_HOME="$BUS" bash "$TAPSH" ${peer_door#tap } >/dev/null 2>&1 \
  || fail "(f) TAP handed the peer a door the peer cannot open: '$peer_door'"
echo "watch-rearm-intent: (f) a non-armer caller is handed a door that caller can open: ok"

# ...and the peer is NOT handed --rearm, which skips the gate entirely and
# re-arms under the caller's handle. Offering it would hand a peer the takeover
# the refusal exists to prevent.
case "$peer_next" in
  *"--rearm"*) fail "(f) peer remedy offers --rearm, the silent-takeover bypass: '$peer_next'" ;;
esac
echo "watch-rearm-intent: (f) the peer remedy does not offer the --rearm takeover: ok"

# --- (g) tap-pqf2: --rearm is not a takeover ----------------------------------
# --rearm skips the gate in (a)-(f) entirely, so without an authority check the
# refusal above protects nothing: a peer simply re-arms under their own handle
# and supervision is off. DISARMING someone else's watch already required
# --force and notified them; RE-ARMING it out from under them required nothing.
#
# The remedy here is "re-run with --force" rather than a standalone command,
# so the door test is: take the caller's OWN command, append --force, and
# confirm it works. That is the same standard as (e)/(f) -- run what TAP told
# the caller to do -- adapted to a remedy that adds a flag.
rearm_fixture () {
  TAP_HOME="$BUS" bash "$TAPSH" watch off --force >/dev/null 2>&1 || true
  TAP_HOME="$BUS" bash "$TAPSH" watch on --by lead -m "$GOAL" --evaluator codex --no-spawn >/dev/null 2>&1
  [ "$(field armed_by)" = "lead" ] || fail "(g) fixture must be armed by lead"
}
rearm_fixture
if g_out="$(TAP_HOME="$BUS" bash "$TAPSH" watch on --by worker -m "$GOAL" --evaluator none --rearm --no-spawn 2>&1)"; then
  fail "(g) a peer re-armed another seat's watch with no authority check: armed_by=$(field armed_by) evaluator=$(field evaluator)"
fi
[ "$(field armed_by)" = "lead" ]    || fail "(g) refused re-arm still changed armed_by to '$(field armed_by)'"
[ "$(field evaluator)" = "codex" ]  || fail "(g) refused re-arm still stripped supervision"
case "$g_out" in *"--force"*) ;; *) fail "(g) refusal does not name --force: $g_out" ;; esac
echo "watch-rearm-intent: (g) a peer cannot silently re-arm another seat's watch: ok"

# the named remedy: the same command plus --force
rearm_fixture
TAP_HOME="$BUS" bash "$TAPSH" watch on --by worker -m "$GOAL" --evaluator none --rearm --force --no-spawn >/dev/null 2>&1 \
  || fail "(g) the named --force remedy is rejected for the peer"
[ "$(field evaluator)" = "none" ] \
  || fail "(g) --force ran but did not apply the peer's settings"
echo "watch-rearm-intent: (g) the named --force remedy runs and applies the change: ok"

# and the armer's own --rearm is untouched: the gate must not cost the common case
rearm_fixture
python3 - "$BUS/watch/arm.json" <<'PY'
import json,sys
p=sys.argv[1];d=json.load(open(p));d['livelock_samples']='{"seat":{"at":1,"hash":"old","timer":5000,"fired":1}}';d['livelock_alerts']='{"seat:ask":1}';open(p,'w').write(json.dumps(d))
PY
TAP_HOME="$BUS" bash "$TAPSH" watch on --by lead -m "$GOAL" --evaluator none --rearm --no-spawn >/dev/null 2>&1 \
  || fail "(g) the ARMER's own --rearm was refused; the gate must only bind non-armers"
[ "$(field evaluator)" = "none" ] || fail "(g) armer's --rearm did not apply"
[ "$(field livelock_samples)" = '{}' ] || fail "(g) rearm retained old livelock progress samples"
[ "$(field livelock_alerts)" = '{}' ] || fail "(g) rearm retained old livelock alerts"
echo "watch-rearm-intent: (g) the armer's own --rearm needs no --force and resets livelock evidence: ok"

echo "PASS watch-rearm-intent"
