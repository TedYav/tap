#!/usr/bin/env bash
# D5: fixture-door — :242,:254 seat-state.ts execs warm read caches as fixture state; assertions are on watch rung identity, and seat-state behavior is owned by runtime/bun/test/seat-state.test.ts
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# watch-rung-identity.test.sh — the escalation rung is selected by seat IDENTITY, not by a
# positional index into a chain that is rebuilt live every tick. Covers the review-round
# bounds plus the tap-cqn override-eligibility fix:
#   (1) a probed seat that LEAVES the chain mid-episode does not cause the next stopped seat
#       to be skipped (the reviewer-reported scenario, verbatim);
#   (2) all eligible seats probed -> the human;
#   (3) an episode reset clears the probed set;
#   (4a-4c) an override constrains ORDER among probe-worthy seats, never ELIGIBILITY:
#       a working seat named in an override is skipped (4a), the same seat once stopped is
#       probed (4b), and an unclassifiable/unknown seat is also skipped (4c) — tap-cqn;
#   (4d) queued-probe ownership keys to the target SEAT, not a slot;
#   (5) the human rung honors probe_timeout for the last seat before escalating.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

# Mock-tmux smoke: the courier's real-TUI settle sleeps verify nothing against
# a synchronous mock — scale them down (smoke-speed PR2; default 1 in production).
export TAP_TUI_SETTLE_SCALE=0.1
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAPSH="$ROOT/bin/tap"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
# Redirect the machine index home: tap-watch.sh now invokes tap-escalate.sh
# best-effort on NOTIFY (CONTRACT.md §Escalation). Escalate no longer consults
# any target config: as of v0.21 it invokes the NOTIFIER directly, so what keeps
# a smoke off a real person's phone is sandbox-pins.sh's TAP_NOTIFY_USER_BIN
# default (a nonexistent path -> fail loud), NOT this redirect. The redirect
# stays because the machine index is operator state a smoke must never touch.
export TAP_INDEX_HOME="$WORK/index"
mkdir -p "$TAP_INDEX_HOME"
printf '{"schema":"0.20","teams":{}}\n' > "$TAP_INDEX_HOME/global-registry.json"  # born live (F1)

# tmux mock: per-pane state dir. idle -> "❯ " (idle-at-prompt, injectable); busy -> a
# no-prompt band (drops out of the live chain AND makes a send defer). send-keys injects into
# the pane's input so submit-verify passes (delivery).
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"
cmd="$1"; shift
target=""
# find -t <target> anywhere
_a=("$@")
for ((i=0; i<${#_a[@]}; i++)); do [ "${_a[$i]}" = "-t" ] && target="${_a[$((i+1))]:-}"; done
pane_address_for() {
  case "${1#=}" in
    alpha|%11) printf alpha ;;
    beta|%12) printf beta ;;
    gamma|%13) printf gamma ;;
    *) return 1 ;;
  esac
}
pane_id_for() {
  case "$(pane_address_for "$1")" in
    alpha) printf '%%11' ;;
    beta) printf '%%12' ;;
    gamma) printf '%%13' ;;
  esac
}
address="$(pane_address_for "$target" || true)"
pdir="$state/${address:-none}"; mkdir -p "$pdir"
case "$cmd" in
  # CONTRACT §Session-name authority: enumerate the exact session generation
  # and each designated pane/harness rather than synthesizing a binding.
  list-sessions)
    printf 'sess\t4242:100\n' ;;
  list-panes)
    printf 'sess\talpha\t%%11\tcodex\t4242\t4242:100\t0\n'
    printf 'sess\tbeta\t%%12\tcodex\t4242\t4242:100\t0\n'
    printf 'sess\tgamma\t%%13\tcodex\t4242\t4242:100\t0\n' ;;
  display-message)
    fmt="${@: -1}"
    if [ "$fmt" = '#{pid}:#{start_time}' ]; then echo "4242:100"; exit 0; fi
    case "$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*)
        pid4="$(pane_id_for "$target" || true)"
        if [ -n "$pid4" ]; then printf '%s\tsess\t4242\tcodex\t0\n' "$pid4"; else printf '\t\t\t\t0\n'; fi ;;
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*pane_tty*session_name*) printf '%s\t/dev/faketty\tsess\t4242:100\n' "$(pane_id_for "$target")" ;;
      *pane_id*session_name*) printf '%s\tsess\t4242:100\n' "$(pane_id_for "$target")" ;;
      *session_name*) echo "sess" ;;
      *pane_id*) pane_id_for "$target" ;;
      *pane_pid*) echo "4242" ;;
      *pane_in_mode*) echo "0" ;;
      *pane_current_command*) echo "codex" ;;
      *pane_current_path*) echo "${FAKE_WORKTREE:?}" ;;
      *window_activity*) cat "$pdir/wa" 2>/dev/null || echo "100" ;;
      *) echo "" ;;
    esac ;;
  capture-pane)
    if [ -f "$pdir/busy" ]; then printf 'still working on it\n'
    elif [ -f "$pdir/input" ]; then printf '❯ %s\n' "$(cat "$pdir/input")"
    else printf '❯ \n'; fi ;;
  send-keys)
    # -t <target> -l -- <text>  |  -t <target> C-u|Enter
    shift $(( ${#_a[@]} > 0 ? 0 : 0 )) 2>/dev/null || true
    a=("$@")
    for ((i=0; i<${#a[@]}; i++)); do
      case "${a[$i]}" in
        -l) printf '%s' "${a[$((i+2))]:-${a[$((i+1))]:-}}" > "$pdir/input"; exit 0 ;;
        C-u|Enter) : > "$pdir/input"; exit 0 ;;
      esac
    done ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
printf '#!/usr/bin/env bash\nprintf " 4242 1 codex codex\\n"\n' > "$FAKE_BIN/ps"; chmod +x "$FAKE_BIN/ps"
export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket" FAKE_TMUX_STATE="$WORK/tmux" FAKE_WORKTREE="$WORK/repo"
BUS="$WORK/repo/.tap/bus"; mkdir -p "$BUS/payloads" "$BUS/receipts" "$WORK/repo"; export TAP_HOME="$BUS"
cat > "$BUS/registry.json" <<JSON
{"schema": "0.20",  "team": { "name": "t", "worktree_root": "$WORK/repo" },
  "seats": {
    "alpha": { "pane": "alpha", "pane_id": "%11", "session": "sess", "server_epoch": "srv:4242:100", "harness": "codex", "status": "active", "registered_from_worktree": "$WORK/repo" },
    "beta":  { "pane": "beta",  "pane_id": "%12", "session": "sess", "server_epoch": "srv:4242:100", "harness": "codex", "status": "active", "registered_from_worktree": "$WORK/repo" }
  } }
JSON
mkdir -p "$FAKE_TMUX_STATE/alpha" "$FAKE_TMUX_STATE/beta"
field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],""))' "$BUS/watch/arm.json" "$1"; }
# tap_watch_set (Bash) is gone (the watch sidecar/tick moved to
# Bun); set lease fields directly through the native owner (watch-lease.ts).
setf()  { bash -c '. "$1"; shift; tap_bun_call watch set watch-lease.ts "$TAP_HOME/watch/arm.json" set "$@"' sh "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh" "$@" >/dev/null 2>&1; }
probed(){ field probed_seats; }
probe_to(){ grep -l "^to: $1$" "$BUS"/payloads/watcher-*.md 2>/dev/null | head -1 || true; }
notify_present(){ [ -f "$BUS/watch/notify.json" ] && [ "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("acked","0"))' "$BUS/watch/notify.json")" != 1 ]; }
arm(){ bash "$TAPSH" watch on --rearm --by alpha -m "done; proof; bound" --evaluator none --threshold 1500 --probe-timeout 1500 --terminal ghost "$@" --no-spawn >/dev/null 2>&1; A="$(field armed_at)"; }

# ---- (1) a probed seat that LEAVES the chain does not skip the next stopped seat ---------
# alpha (more recent) + beta both idle -> live chain [alpha, beta]. Probe alpha; alpha then
# starts working (drops out of the idle chain); the next tick must still probe BETA, not the
# human. Under a positional index (advance to slot 2 of the now-shorter [beta] chain) beta
# would be skipped straight to the human.
printf '200\n' > "$FAKE_TMUX_STATE/alpha/wa"; printf '100\n' > "$FAKE_TMUX_STATE/beta/wa"   # alpha more recent
: > "$FAKE_TMUX_STATE/alpha/x"; rm -f "$FAKE_TMUX_STATE/alpha/busy" "$FAKE_TMUX_STATE/beta/busy"
arm
TAP_WATCH_NOW="$((A + 2000))" bash "$TAPSH" watch tick >/dev/null 2>&1                 # probe alpha
[ -n "$(probe_to alpha)" ] || { echo "watch-rung: (1) first probe did not target alpha" >&2; exit 1; }
probed_seats="$(probed)"
[[ "$probed_seats" == *'alpha'* ]] || { echo "watch-rung: (1) alpha not recorded in probed_seats: $probed_seats" >&2; exit 1; }
: > "$FAKE_TMUX_STATE/alpha/busy"                                                     # alpha starts working -> leaves chain
TAP_WATCH_NOW="$((A + 3500))" bash "$TAPSH" watch tick >/dev/null 2>&1                # probe_timeout: clear the wait
TAP_WATCH_NOW="$((A + 3600))" bash "$TAPSH" watch tick >/dev/null 2>&1                # next tick -> must probe beta
[ -n "$(probe_to beta)" ] || { echo "watch-rung: (1) BETA was skipped after alpha left the chain (positional-index bug)" >&2; ls "$BUS"/payloads/ >&2; exit 1; }
echo "watch-rung: (1) a seat leaving the chain does not skip the next stopped seat: ok"

# ---- (2) all eligible seats probed -> the human ------------------------------------------
rm -f "$FAKE_TMUX_STATE/alpha/busy" "$FAKE_TMUX_STATE/beta/busy"
arm --chain '["alpha","beta"]'
TAP_WATCH_NOW="$((A + 2000))" bash "$TAPSH" watch tick >/dev/null 2>&1                # episode starts
setf probed_seats '["alpha","beta"]' last_probe_at 0                                 # now both are probed
rm -f "$BUS/watch/notify.json"
TAP_WATCH_NOW="$((A + 2001))" bash "$TAPSH" watch tick >/dev/null 2>&1
notify_present || { echo "watch-rung: (2) all-probed did not escalate to the human" >&2; exit 1; }
echo "watch-rung: (2) all eligible seats probed -> human NOTIFY: ok"

# ---- (3) an episode reset clears the probed set ------------------------------------------
arm --chain '["alpha","beta"]'
TAP_WATCH_NOW="$((A + 2000))" bash "$TAPSH" watch tick >/dev/null 2>&1                # episode starts, alpha probed
setf probed_seats '["alpha","beta"]'
printf -- '---\nid: work-x\nfrom: alpha\nto: peer\nkind: discuss\n---\nreal work\n' > "$BUS/payloads/work-x.md"
python3 -c 'import os,sys; os.utime(sys.argv[1], (int(sys.argv[2]), int(sys.argv[2])))' "$BUS/payloads/work-x.md" "$((A + 2500))"
TAP_WATCH_NOW="$((A + 2600))" bash "$TAPSH" watch tick >/dev/null 2>&1                # resumption -> episode reset
[ "$(probed)" = "[]" ] || { echo "watch-rung: (3) episode reset did not clear probed_seats (got $(probed))" >&2; exit 1; }
rm -f "$BUS/payloads/work-x.md"
echo "watch-rung: (3) episode reset clears the probed set: ok"

# ---- (4) an override constrains ORDER, never ELIGIBILITY (tap-cqn, codex deep review) ----
# Per the ruling: probe-worthy = positive stopped-or-stuck evidence (idle-at-prompt,
# blocked-on-approval, rate-limited-error, wedged); excluded = working (positively NOT
# stuck) and unknown (no evidence either way). A chain override forcing a seat into the
# list must NOT bypass this filter — a WORKING seat named in an override is skipped,
# exactly like a working seat in the live-computed default chain (test (1)). Only once
# that same seat is actually stopped does it become probable again.
# Stale watcher-*.md from earlier tests would otherwise satisfy probe_to's positive
# match unconditionally; clear the payload dir so a probe_to result reflects THIS tick.
rm -f "$BUS/watch/notify.json" "$BUS"/payloads/watcher-*.md
arm --chain '["alpha","beta"]'
# A static "busy" pane with no recent window_activity classifies as wedged (a cached,
# unchanging hash), NOT working — wedged is legitimately probe-worthy per the ruling.
# To exercise the actual exclusion (working), alpha needs POSITIVE working evidence: a
# recent window_activity (the same signal tap_seat_state's WORKING SHORTCUTS branch
# reads), well within the default stale_after window.
: > "$FAKE_TMUX_STATE/alpha/busy"; rm -f "$FAKE_TMUX_STATE/alpha/x" "$FAKE_TMUX_STATE/beta/busy"
printf '%s\n' "$((A + 1990))" > "$FAKE_TMUX_STATE/alpha/wa"
TAP_WATCH_NOW="$((A + 2000))" bash "$TAPSH" watch tick >/dev/null 2>&1
[ -z "$(probe_to alpha)" ] || { echo "watch-rung: (4a) override probed a WORKING seat (alpha) — eligibility bypassed" >&2; exit 1; }
[ -n "$(probe_to beta)" ] || { echo "watch-rung: (4a) override skipped the next eligible seat (beta) after alpha was filtered" >&2; exit 1; }
echo "watch-rung: (4a) override + working seat -> skipped (next eligible override seat probed instead): ok"

rm -f "$BUS/watch/notify.json" "$BUS"/payloads/watcher-*.md
arm --chain '["alpha","beta"]'
rm -f "$FAKE_TMUX_STATE/alpha/busy" "$FAKE_TMUX_STATE/beta/busy" "$FAKE_TMUX_STATE/alpha/wa"   # alpha now stopped, stale window_activity too
TAP_WATCH_NOW="$((A + 2000))" bash "$TAPSH" watch tick >/dev/null 2>&1
[ -n "$(probe_to alpha)" ] || { echo "watch-rung: (4b) same seat, now stopped, was not probed via the override" >&2; exit 1; }
echo "watch-rung: (4b) override + same seat now stopped -> probed: ok"

# ---- (4c) an UNKNOWN seat (no positive evidence either way) is also skipped ---------------
# Per the ruling: unknown has no evidence either way — "missing evidence never reads as
# active" (the seat-state ladder's own rule) applies equally here; probing an
# unclassifiable pane is noise. The seat-state ladder (seat-state.ts) reads "unknown" the
# FIRST time it sees ambiguous no-prompt/no-activity content for a handle (no cached hash
# to compare against yet — a second identical read would read "wedged" instead); a fresh
# handle ("gamma") with a no-prompt pane and no window_activity hits exactly that case.
rm -f "$BUS/watch/notify.json" "$BUS"/payloads/watcher-*.md
rm -rf "$BUS/seat-state"   # no stale cached hash for gamma (this handle is new)
python3 -c '
import json
p = "'"$BUS"'/registry.json"
d = json.load(open(p))
d["seats"]["gamma"] = {"pane": "gamma", "pane_id": "%13", "session": "sess", "server_epoch": "srv:4242:100", "harness": "codex", "status": "active", "registered_from_worktree": "'"$WORK"'/repo"}
json.dump(d, open(p, "w"))
'
mkdir -p "$FAKE_TMUX_STATE/gamma"; : > "$FAKE_TMUX_STATE/gamma/busy"; rm -f "$FAKE_TMUX_STATE/gamma/wa"
arm --chain '["gamma","beta"]'
rm -f "$FAKE_TMUX_STATE/beta/busy"
TAP_WATCH_NOW="$((A + 2000))" bash "$TAPSH" watch tick >/dev/null 2>&1
[ -z "$(probe_to gamma)" ] || { echo "watch-rung: (4c) override probed an UNKNOWN seat (gamma) — eligibility bypassed" >&2; exit 1; }
[ -n "$(probe_to beta)" ] || { echo "watch-rung: (4c) override skipped the next eligible seat (beta) after gamma was filtered" >&2; exit 1; }
python3 -c '
import json
p = "'"$BUS"'/registry.json"
d = json.load(open(p))
del d["seats"]["gamma"]
json.dump(d, open(p, "w"))
'
echo "watch-rung: (4c) override + unknown seat -> skipped (no positive stopped-or-stuck evidence): ok"

# ---- (4d) queued-probe ownership keys to the SEAT, not a slot -----------------------------
# v0.7 retired the rc4 consecutive-defer ladder. A no-prompt send is accepted into spool
# once and the exact id + seat own the rung until courier exit. Re-arming for a different
# busy target must replace both fields rather than carrying alpha's identity into beta.
arm --chain '["alpha","beta"]'
: > "$FAKE_TMUX_STATE/alpha/busy"; rm -f "$FAKE_TMUX_STATE/alpha/x" "$FAKE_TMUX_STATE/alpha/wa" "$FAKE_TMUX_STATE/beta/busy"
(cd "$WORK/repo" && TAP_WATCH_NOW="$((A + 2000))" bun "$ROOT/runtime/bun/src/seat-state.ts" alpha) >/dev/null 2>&1   # warm the cache: wedged from the 2nd read on
TAP_WATCH_NOW="$((A + 2000))" bash "$TAPSH" watch tick >/dev/null 2>&1                # probe alpha -> queued
[ "$(field queued_probe_seat)" = "alpha" ] || { echo "watch-rung: (4d) queued probe not keyed to alpha (got $(field queued_probe_seat))" >&2; exit 1; }
alpha_queued="$(field queued_probe_id)"
[ -n "$alpha_queued" ] && [ -f "$BUS/spool/$alpha_queued.md" ] \
  || { echo "watch-rung: (4d) alpha queued probe lacks its exact spool entry" >&2; exit 1; }

rm -f "$BUS/spool/$alpha_queued.md" "$BUS/spool/$alpha_queued.meta.json" "$BUS/spool/$alpha_queued.claim"
rm -rf "$BUS/seat-state"
rm -f "$FAKE_TMUX_STATE/alpha/busy"; : > "$FAKE_TMUX_STATE/alpha/x"
: > "$FAKE_TMUX_STATE/beta/busy"
arm --chain '["beta"]'
(cd "$WORK/repo" && TAP_WATCH_NOW="$((A + 2000))" bun "$ROOT/runtime/bun/src/seat-state.ts" beta) >/dev/null 2>&1    # warm beta's cache too (probe-worthy from the 2nd read on)
TAP_WATCH_NOW="$((A + 2000))" bash "$TAPSH" watch tick >/dev/null 2>&1
[ "$(field queued_probe_seat)" = "beta" ] || { echo "watch-rung: (4d) queued ownership did not follow to beta (got $(field queued_probe_seat))" >&2; exit 1; }
beta_queued="$(field queued_probe_id)"
[ -n "$beta_queued" ] && [ "$beta_queued" != "$alpha_queued" ] && [ -f "$BUS/spool/$beta_queued.md" ] \
  || { echo "watch-rung: (4d) beta did not receive a fresh exact queued id" >&2; exit 1; }
echo "watch-rung: (4d) queued-probe ownership follows the seat, not the slot: ok"

# ---- (5) the human is a RUNG: honor probe_timeout for the last seat before escalating ----
# After the last eligible seat is probed, an immediate tick must NOT wake the human — the
# last seat gets its full probe_timeout window (R9: advance on probe_timeout, never tick
# cadence). Only once that window elapses does the human NOTIFY fire.
rm -f "$FAKE_TMUX_STATE/alpha/busy" "$FAKE_TMUX_STATE/beta/busy" "$BUS/watch/notify.json" \
  "$BUS/spool/$beta_queued.md" "$BUS/spool/$beta_queued.meta.json" "$BUS/spool/$beta_queued.claim"
arm --chain '["alpha","beta"]'
TAP_WATCH_NOW="$((A + 2000))" bash "$TAPSH" watch tick >/dev/null 2>&1                # episode starts, alpha probed
setf probed_seats '["alpha","beta"]' last_probe_at "$((A + 2000))"                    # both probed; last probe at A+2000
TAP_WATCH_NOW="$((A + 2001))" bash "$TAPSH" watch tick >/dev/null 2>&1                # within probe_timeout(1500) -> WAIT
[ ! -f "$BUS/watch/notify.json" ] || { echo "watch-rung: (5) human NOTIFY fired before the last seat's probe window elapsed" >&2; exit 1; }
TAP_WATCH_NOW="$((A + 2000 + 1500))" bash "$TAPSH" watch tick >/dev/null 2>&1         # probe_timeout elapsed -> NOTIFY
notify_present || { echo "watch-rung: (5) human NOTIFY did not fire after the last seat's probe window elapsed" >&2; exit 1; }
echo "watch-rung: (5) the human rung honors probe_timeout for the last seat: ok"

echo "watch-rung-identity: ok"
