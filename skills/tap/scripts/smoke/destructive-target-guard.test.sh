#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# destructive-target-guard.test.sh — tap-24f fix wave, shell half.
#
# tmux pane ids are unique only within ONE server lifetime, so after a keeper
# rebirth a stored id resolves on the new server to a live but UNRELATED pane.
# Every SESSION-TERMINATING path therefore derives its target through one
# verifier (native lifecycle-target.ts destructiveSessionTarget) instead of
# dereferencing a stored id directly.
#
# RATIFIED SEMANTICS (2026-07-25 ruling),
# pinned case by case below. Three-way:
#   PROVEN   — row stamp equals the observable current epoch: legacy id-anchored
#              derivation, noncanonical session names included.
#   STALE    — stamp names a PRIOR epoch: ids are void.
#   UNPROVEN — no stamp, or the current epoch is unobservable: ids are void.
# For a void id the ONLY remaining authorization is the exact-name fallback,
# and all three conditions must hold: the row still carries a stable pane_id;
# its stored session EXACTLY equals the canonical name the CALLER derived from
# the current team plus the target handle; and that name is live.
#
# Covered here: `tap team shutdown`'s per-seat resolution,
# and `tap out --kill`. The admin rebuild laundering gate lives in
# admin-rebuild-registry.test.sh; the delivery-binding route in command-mode.test.sh.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
TAP_HOME="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
KILL_LOG="$TAP_HOME/killed.log"
trap 'rm -rf "$TAP_HOME" "$FAKE_BIN"' EXIT
export TAP_HOME PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket" KILL_LOG
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"
: > "$KILL_LOG"

cat > "$FAKE_BIN/ps" <<'ENDPS'
#!/usr/bin/env bash
printf '1 faketty\n'
ENDPS
chmod +x "$FAKE_BIN/ps"

# Fake tmux driven by two env tables so each case states its own world:
#   FAKE_PANES        "%id=session" pairs — a pane id listed here is ALIVE and
#                     reports that session; anything else is gone. The ids are
#                     numeric because that is the real tmux grammar ('%' plus
#                     decimal digits) the destructive verifier requires:
#                     %11 the lead, %22 a proven seat, %33 a recycled id,
#                     %44 a pane that no longer exists.
#   FAKE_LIVE_SESSIONS space-separated session names for has-session/list-sessions.
#   FAKE_EPOCH_RAW    the "<pid>:<start_time>" the server reports (empty = the
#                     epoch is unobservable, which makes every row UNPROVEN).
# kill-session appends its exact target to $KILL_LOG so a wrong target is loud.
#
# TRANSITION SUPPORT (the pre-action re-check cases). Authorization and the
# action it authorizes are separated in time, and a tmux server can be reborn
# in that window. A case declares the world it wants AFTERWARDS in the *_AFTER
# tables and names a $FAKE_FLIP_FILE; every invocation that sees that path
# exist serves the after-world instead. Two ways to trip it:
#   FAKE_FLIP_ON_LIST_PANES=1 — this fake creates the file itself when the
#     shutdown plan counts panes, which is strictly after every seat is
#     authorized and strictly before the first kill.
#   FAKE_FLIP_FILE=<registry>.lock — nothing here creates it; the locked
#     unregister transaction does, so the world changes at the exact moment
#     that transaction takes the lock.
#
# A SECOND BOUNDARY, EARLIER (tap-usix). One flip is enough while a command's
# epoch observations are interchangeable. They are not: `tap out --kill` observes
# the server generation THREE times, and the FIRST observation — the one that
# decides the authority label — happens before the target is ever derived. To
# reach that window a case needs a boundary earlier than the lock, so:
#   FAKE_EPOCH_PRE_AUTH  the epoch served until the narration ladder asks a pane
#     for its #{window_id}. That query is the last thing the ladder does before
#     the destructive verifier makes its own observation, which makes it a stable
#     PHASE marker — unlike counting observations, it does not shift when an
#     unrelated seat in the fixture adds a probe. "-" means the observation FAILS
#     (an unobservable epoch is an ordinary tmux outcome, not a broken fixture).
#     Requires FAKE_EPOCH_PHASE_FILE, a scratch path this fake creates itself.
# FAKE_CALL_LOG, when set, records every tmux invocation so a case can assert
# WHICH code path ran rather than only what it produced — the two arms of the
# locked re-check are distinguishable only by the probes they issue.
cat > "$FAKE_BIN/tmux" <<'ENDTMUX'
#!/usr/bin/env bash
set -euo pipefail
[ -z "${FAKE_CALL_LOG-}" ] || printf '%s\n' "$*" >> "$FAKE_CALL_LOG"
# The ladder's #{window_id} query ends the pre-authorization phase.
if [ -n "${FAKE_EPOCH_PHASE_FILE-}" ] && [[ "$*" == *window_id* ]]; then
  : > "$FAKE_EPOCH_PHASE_FILE"
fi
if [ -n "${FAKE_FLIP_FILE-}" ] && [ -e "$FAKE_FLIP_FILE" ]; then
  [ -z "${FAKE_EPOCH_RAW_AFTER+set}" ]     || FAKE_EPOCH_RAW="$FAKE_EPOCH_RAW_AFTER"
  [ -z "${FAKE_LIVE_SESSIONS_AFTER+set}" ] || FAKE_LIVE_SESSIONS="$FAKE_LIVE_SESSIONS_AFTER"
  [ -z "${FAKE_PANES_AFTER+set}" ]         || FAKE_PANES="$FAKE_PANES_AFTER"
fi
pane_session() {
  local pair
  for pair in ${FAKE_PANES:-}; do
    case "$pair" in "$1="*) printf '%s' "${pair#*=}"; return 0 ;; esac
  done
  return 1
}
session_live() {
  local s
  for s in ${FAKE_LIVE_SESSIONS:-}; do [ "$s" = "$1" ] && return 0; done
  return 1
}
session_id() { printf '$'; printf '%s' "$1" | cksum | cut -d ' ' -f 1; }
self_pane_id() { printf '%s' "${FAKE_SELF_PANE_ID:-%99}"; }
# tap-bzyz: one TTY source per pane; both tmux queries derive from it.
tty_for() {
  [ "$1" = "$(self_pane_id)" ] || return 1
  printf '/dev/faketty'
}
cmd="${1:-}"; shift || true
case "$cmd" in
  has-session)
    target=""
    while [ "$#" -gt 0 ]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
    session_live "${target#=}" || { echo "can't find session" >&2; exit 1; }
    exit 0 ;;
  list-sessions)
    for s in ${FAKE_LIVE_SESSIONS:-}; do printf '%s\n' "$s"; done
    exit 0 ;;
  kill-session)
    target=""
    while [ "$#" -gt 0 ]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
    printf '%s\n' "${target#=}" >> "$KILL_LOG"
    session_live "${target#=}" || exit 1
    exit 0 ;;
  list-panes)
    all=0; target=""; fmt=""
    while [ "$#" -gt 0 ]; do case "$1" in -a) all=1; shift ;; -t) target="$2"; shift 2 ;; -F) fmt="$2"; shift 2 ;; *) shift ;; esac; done
    # Hard removal observes one five-field snapshot of every live pane,
    # before and after its guarded stop. A session this fake stopped is gone.
    if [ "$all" = 1 ] && [[ "$fmt" == *session_id* ]]; then
      for pair in ${FAKE_PANES:-}; do
        id="${pair%%=*}"; sess="${pair#*=}"
        session_live "$sess" || continue
        grep -qxF -- "$sess" "$KILL_LOG" 2>/dev/null && continue
        printf '%s\t%s\t%s\t@1\t%s\n' "$id" "$sess" "$(session_id "$sess")" "${FAKE_EPOCH_RAW-}"
      done
      exit 0
    fi
    if [ "$all" = 1 ]; then printf '%s\t%s\n' "$(self_pane_id)" "$(tty_for "$(self_pane_id)")"; exit 0; fi
    # The shutdown plan counts panes for every session it is about to kill:
    # after authorization, before the first kill. That is the window.
    if [ "${FAKE_FLIP_ON_LIST_PANES-0}" = 1 ] && [ -n "${FAKE_FLIP_FILE-}" ]; then
      : > "$FAKE_FLIP_FILE"
    fi
    session_live "${target#=}" || exit 1
    # Name-first re-derive: emit pane ids that belong to this session.
    want="${target#=}"; found=0
    for pair in ${FAKE_PANES:-}; do
      id="${pair%%=*}"; sess="${pair#*=}"
      if [ "$sess" = "$want" ]; then printf '%s\n' "$id"; found=1; fi
    done
    # Live session with no listed panes still needs a non-empty count for the
    # shutdown planner's pane tally (pre-authorization world); keep a stub.
    [ "$found" = 1 ] || printf '%%p1\n'
    exit 0 ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="$2"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    if [ -z "$target" ]; then
      case "$fmt" in
        *pid*start_time*) if [ -n "${FAKE_EPOCH_PRE_AUTH-}" ] \
                             && [ ! -e "${FAKE_EPOCH_PHASE_FILE:?}" ]; then
                            [ "$FAKE_EPOCH_PRE_AUTH" = "-" ] && exit 1
                            printf '%s\n' "$FAKE_EPOCH_PRE_AUTH"
                            exit 0
                          fi
                          [ -n "${FAKE_EPOCH_RAW-unset}" ] || exit 1
                          printf '%s\n' "${FAKE_EPOCH_RAW:-900:100}" ;;
        *socket_path*)    echo "/fake/socket" ;;
        *window_index*)   printf '%s:0.0\n' "${FAKE_SELF_SESSION:-demo/lead}" ;;
        *session_name*)   printf '%s\n' "${FAKE_SELF_SESSION:-demo/lead}" ;;
        # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
        *pane_id*pane_tty*session_name*) printf '%s\t/dev/faketty\t%s\t%s\n' "${FAKE_SELF_PANE_ID:-%99}" "${FAKE_SELF_SESSION:-demo/lead}" "${FAKE_EPOCH_RAW:-900:100}" ;;
        *pane_id*)        printf '%s\n' "${FAKE_SELF_PANE_ID:-%99}" ;;
        *) echo "" ;;
      esac
      exit 0
    fi
    sess="$(pane_session "$target")" || { echo "can't find pane: $target" >&2; exit 1; }
    case "$fmt" in
      *pane_id*pane_tty*session_name*)
        epoch="${FAKE_EPOCH_RAW-900:100}"
        if [ -n "${FAKE_EPOCH_PRE_AUTH-}" ] \
            && [ ! -e "${FAKE_EPOCH_PHASE_FILE:?}" ]; then
          [ "$FAKE_EPOCH_PRE_AUTH" = "-" ] && epoch="" || epoch="$FAKE_EPOCH_PRE_AUTH"
        fi
        printf '%s\t%s\t%s\t%s\n' "$target" "$(tty_for "$target")" "$sess" "$epoch" ;;
      *pane_id*session_name*)
        printf '%s\t%s' "$target" "$sess"
        if [[ "$fmt" == *pid*start_time* ]]; then
          epoch="${FAKE_EPOCH_RAW-900:100}"
          if [ -n "${FAKE_EPOCH_PRE_AUTH-}" ] \
              && [ ! -e "${FAKE_EPOCH_PHASE_FILE:?}" ]; then
            [ "$FAKE_EPOCH_PRE_AUTH" = "-" ] && epoch="" || epoch="$FAKE_EPOCH_PRE_AUTH"
          fi
          printf '\t%s' "$epoch"
        fi
        printf '\n' ;;
      *pane_id*pane_tty*)     printf '%s\t%s\n' "$target" "$(tty_for "$target")" ;;
      *session_name*window_index*|*window_index*) printf '%s:0.0\n' "$sess" ;;
      *session_name*)         printf '%s\n' "$sess" ;;
      *pane_id*)              printf '%s\n' "$target" ;;
      *window_id*)            printf '@1\n' ;;
      *pane_current_command*) printf 'codex\n' ;;
      *pane_current_path*)    printf '%s\n' "${FAKE_TMUX_PATH:-$PWD}" ;;
      *pane_pid*)             printf '4242\n' ;;
      *) echo "" ;;
    esac
    exit 0 ;;
  if-shell)
    # stopExactPane: kill the session only while the pane still lives in it.
    target=""; kill_cmd=""
    while [ "$#" -gt 0 ]; do case "$1" in -F) shift ;; -t) target="$2"; shift 2 ;; *) break ;; esac; done
    kill_cmd="${2-}"
    sess="$(pane_session "$target")" || { echo "can't find pane: $target" >&2; exit 1; }
    [[ "$kill_cmd" == *"'$(session_id "$sess")'"* ]] || { echo "tap lifecycle: stop identity changed"; exit 0; }
    printf '%s\n' "$sess" >> "$KILL_LOG"
    exit 0 ;;
  *) exit 0 ;;
esac
ENDTMUX
chmod +x "$FAKE_BIN/tmux"

EPOCH="srv:900:100"
# One world for the whole file: lead pane, roamer pane, a foreign session the
# recycled id lands on (E2), a bystander for blast-radius, and an ambient.
export FAKE_EPOCH_RAW="900:100"
export FAKE_SELF_PANE_ID="%11" FAKE_SELF_SESSION="demo/lead"
export FAKE_PANES="%11=demo/lead %22=demo/proven-elsewhere %33=demo/roamer %44=demo/bystander %55=demo/seat %66=demo/foreign"
export FAKE_LIVE_SESSIONS="demo/lead demo/roamer demo/bystander demo/proven-elsewhere demo/seat demo/foreign keeper"

# ── 1. the verifier's ratified matrix ─────────────────────────────────────────
# The shell twin (lib.sh tap_destructive_session_target) is retired; every
# session-terminating verb decides through lifecycle-target.ts
# destructiveSessionTarget, whose matrix (pane_live_elsewhere / session_name_gone /
# pane_identity_missing / server_epoch_unproven) is pinned in
# runtime/bun/test/lifecycle-target.test.ts. Sections 2-9 drive the real verbs.

# ── 2. tap team shutdown resolves every seat through the verifier ────────────
write_registry() { cat > "$TAP_HOME/registry.json"; }
killed_names() { sort -u "$KILL_LOG" | tr '\n' ' '; }

write_registry <<JSON
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "lead":    {"status": "active", "delivery": "pane", "pane": "demo/lead:0.0", "pane_id": "%11",
                "session": "demo/lead", "server_epoch": "$EPOCH", "harness": "claude"},
    "foreign": {"status": "active", "delivery": "pane", "pane": "demo/foreign:0.0", "pane_id": "%22",
                "session": "demo/foreign", "server_epoch": "$EPOCH", "harness": "codex"},
    "roamer":  {"status": "active", "delivery": "pane", "pane": "demo/roamer:0.0", "pane_id": "%33",
                "session": "demo/roamer", "server_epoch": "$EPOCH", "harness": "codex"},
    "ghost":   {"status": "active", "delivery": "pane", "pane": "demo/ghost:0.0", "pane_id": "%44",
                "harness": "codex"}
  }
}
JSON
: > "$KILL_LOG"
plan="$("$TAP" team shutdown --dry-run 2>&1)"
# Name-keyed aligned seat: epoch-proven, pane member of expected → kill plan.
grep -q "kill session demo/roamer" <<<"$plan" || {
  echo "shutdown: aligned roamer missing from the plan" >&2; echo "$plan" >&2; exit 1; }
# E2: canonical session live (has %55) but stored id %22 alive on proven-elsewhere.
grep -q "foreign (pane_live_elsewhere)" <<<"$plan" || {
  echo "shutdown: E2 foreign-pane seat should refuse with pane_live_elsewhere" >&2; echo "$plan" >&2; exit 1; }
# UNPROVEN seat with NO provenance whose recycled id resolves onto a bystander.
grep -q "ghost (server_epoch_unproven)" <<<"$plan" || {
  echo "shutdown: no-provenance ghost should refuse with server_epoch_unproven" >&2; echo "$plan" >&2; exit 1; }
grep -q "kill session demo/bystander" <<<"$plan" && {
  echo "shutdown: BLAST RADIUS — a recycled id put a bystander's session in the kill plan" >&2; echo "$plan" >&2; exit 1; }
grep -q "kill session demo/proven-elsewhere" <<<"$plan" && {
  echo "shutdown: BLAST RADIUS — E2 foreign session appeared in the kill plan" >&2; echo "$plan" >&2; exit 1; }
[ -s "$KILL_LOG" ] && { echo "shutdown: dry-run killed something" >&2; exit 1; }
echo "destructive-target: 2/9 — team shutdown plans aligned seats, refuses E2/unprovable: ok"

# ── 3. …and the real teardown kills exactly that set ─────────────────────────
: > "$KILL_LOG"
"$TAP" team shutdown --yes </dev/null >/dev/null 2>&1 || true
grep -qx "demo/roamer" "$KILL_LOG" || {
  echo "shutdown: aligned seat not killed (log: $(killed_names))" >&2; exit 1; }
grep -qx "demo/proven-elsewhere" "$KILL_LOG" && {
  echo "shutdown: BLAST RADIUS — killed E2 foreign session (log: $(killed_names))" >&2; exit 1; }
grep -qx "demo/bystander" "$KILL_LOG" && {
  echo "shutdown: BLAST RADIUS — killed a bystander resolved from a recycled id" >&2; exit 1; }
echo "destructive-target: 3/9 — teardown never terminates a session it cannot prove: ok"

# ── 4. tap out --kill refuses an unprovable row ──────────────────────────────
# The row's id resolves (onto the bystander) and it carries no canonical name,
# so nothing authorizes a kill. Pre-guard this resolved and killed demo/bystander.
write_registry <<JSON
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "lead":  {"status": "active", "delivery": "pane", "pane": "demo/lead:0.0", "pane_id": "%11",
              "session": "demo/lead", "server_epoch": "$EPOCH", "harness": "claude"},
    "ghost": {"status": "active", "delivery": "pane", "pane": "demo/ghost:0.0", "pane_id": "%44",
              "harness": "codex"}
  }
}
JSON
: > "$KILL_LOG"
rc=0; out="$("$TAP" out ghost --kill 2>&1)" || rc=$?
[ "$rc" != 0 ] || { echo "out --kill: an unprovable row must refuse (got: $out)" >&2; exit 1; }
# Hard removal refuses a row without this seat's canonical session first.
grep -q "requires this seat's exact durable session" <<<"$out" || { echo "out --kill: wrong refusal (got: $out)" >&2; exit 1; }
[ -s "$KILL_LOG" ] && { echo "out --kill: BLAST RADIUS — killed $(killed_names)" >&2; exit 1; }
python3 -B - "$TAP_HOME/registry.json" <<'PY'
import json, sys
agents = json.load(open(sys.argv[1])).get("seats") or {}
if "ghost" not in agents:
    raise SystemExit("out --kill: refusal must leave the row in place")
PY
echo "destructive-target: 4/9 — tap out --kill refuses an unprovable row: ok"

# ── 5. …and still terminates a seat its canonical name vouches for ───────────
write_registry <<JSON
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "lead":   {"status": "active", "delivery": "pane", "pane": "demo/lead:0.0", "pane_id": "%11",
               "session": "demo/lead", "server_epoch": "$EPOCH", "harness": "claude"},
    "roamer": {"status": "active", "delivery": "pane", "pane": "demo/roamer:0.0", "pane_id": "%33",
               "session": "demo/roamer", "server_epoch": "$EPOCH", "harness": "codex"}
  }
}
JSON
: > "$KILL_LOG"
rc=0; out="$("$TAP" out roamer --kill 2>&1)" || rc=$?
[ "$rc" = 0 ] || { echo "out --kill: a name-keyed aligned seat must still be killable (got: $out)" >&2; exit 1; }
grep -qx "demo/roamer" "$KILL_LOG" || {
  echo "out --kill: expected demo/roamer to be killed, log has $(killed_names)" >&2; exit 1; }
grep -qx "demo/bystander" "$KILL_LOG" && {
  echo "out --kill: BLAST RADIUS — killed the bystander the recycled id resolves to" >&2; exit 1; }
echo "destructive-target: 5/9 — tap out --kill terminates a name-keyed aligned seat: ok"

# ── 6. tap team shutdown re-verifies each teammate target before acting ──────
# Authorization happens while the plan is BUILT. The kills happen later — after
# the preview prints, and interactively after a human answers a prompt — so a
# server rebirth can land in between and leave a cached decision pointing at a
# stranger. Every target is therefore re-derived through the same verifier
# immediately before its kill, and must refuse what no longer holds WITHOUT
# refusing what still does.
FLIP="$TAP_HOME/flip"
rm -f "$FLIP"
write_registry <<JSON
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "lead":   {"status": "active", "delivery": "pane", "pane": "demo/lead:0.0", "pane_id": "%11",
               "session": "demo/lead", "server_epoch": "$EPOCH", "harness": "claude"},
    "roamer": {"status": "active", "delivery": "pane", "pane": "demo/roamer:0.0", "pane_id": "%33",
               "session": "demo/roamer", "server_epoch": "$EPOCH", "harness": "codex"}
  }
}
JSON
: > "$KILL_LOG"
# After the plan prints: demo/roamer stops being live (name gone → re-auth
# refuses). demo/lead stays live — operator name-keyed authorize still lands despite
# an epoch flip, so self must still be stopped. The flip also changes the epoch
# so any id-arm lock re-check that still demands triple-epoch equality refuses
# mid-flight strangers; lead's stop is re-authorized by name+live.
FAKE_FLIP_FILE="$FLIP" FAKE_FLIP_ON_LIST_PANES=1 \
  FAKE_EPOCH_RAW_AFTER="901:101" \
  FAKE_LIVE_SESSIONS_AFTER="demo/lead demo/bystander demo/proven-elsewhere keeper" \
  "$TAP" team shutdown --yes </dev/null >/dev/null 2>&1 || true
grep -qx "demo/roamer" "$KILL_LOG" && {
  echo "shutdown: STALE AUTHORIZATION — killed a target whose session was gone by then" >&2
  echo "killed: $(killed_names)" >&2; exit 1; }
grep -qx "demo/proven-elsewhere" "$KILL_LOG" && {
  echo "shutdown: BLAST RADIUS — killed foreign session after rebirth" >&2
  echo "killed: $(killed_names)" >&2; exit 1; }
grep -qx "demo/lead" "$KILL_LOG" || {
  echo "shutdown: OVER-REFUSED — still-live self session must still be stopped (killed: $(killed_names))" >&2
  exit 1; }
echo "destructive-target: 6/9 — team shutdown re-verifies teammate targets immediately before killing: ok"

# ── 7. …and the SELF session, which is killed LAST and so waits longest ──────
rm -f "$FLIP"
write_registry <<JSON
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "lead": {"status": "active", "delivery": "pane", "pane": "demo/lead:0.0", "pane_id": "%11",
             "session": "demo/lead", "server_epoch": "$EPOCH", "harness": "claude"}
  }
}
JSON
: > "$KILL_LOG"
plan="$(FAKE_FLIP_FILE="$FLIP" FAKE_FLIP_ON_LIST_PANES=1 \
  FAKE_EPOCH_RAW_AFTER="901:101" \
  FAKE_LIVE_SESSIONS_AFTER="demo/bystander keeper" \
  "$TAP" team shutdown --yes </dev/null 2>&1 || true)"
grep -q "SELF" <<<"$plan" || {
  echo "shutdown: fixture did not exercise the self arm at all" >&2; echo "$plan" >&2; exit 1; }
[ -s "$KILL_LOG" ] && {
  echo "shutdown: STALE AUTHORIZATION — killed the self session after its name stopped being live" >&2
  echo "killed: $(killed_names)" >&2; exit 1; }
echo "destructive-target: 7/9 — team shutdown re-verifies the self target before killing it: ok"

# ── 8. tap out --kill re-observes the epoch UNDER the registry lock ──────────
# The shell authorizes with an epoch it observed earlier and hands that snapshot
# to the locked transaction. If the server is reborn in between, the row's own
# facts stay mutually consistent — the recycled id resolves, and to the same
# session name — so pane-id and session re-checks both pass while the id now
# points at a stranger. The transaction must therefore observe the epoch itself,
# under the lock, and refuse unless the row stamp, the authorizing epoch and the
# current one are all the same generation.
rm -f "$TAP_HOME/registry.json.lock"
write_registry <<JSON
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "lead":   {"status": "active", "delivery": "pane", "pane": "demo/lead:0.0", "pane_id": "%11",
               "session": "demo/lead", "server_epoch": "$EPOCH", "harness": "claude"},
    "roamer": {"status": "active", "delivery": "pane", "pane": "demo/roamer:0.0", "pane_id": "%33",
               "session": "demo/roamer", "server_epoch": "$EPOCH", "harness": "codex"}
  }
}
JSON
: > "$KILL_LOG"
rc=0
out="$(FAKE_FLIP_FILE="$TAP_HOME/registry.json.lock" FAKE_EPOCH_RAW_AFTER="901:101" \
  "$TAP" out roamer --kill 2>&1)" || rc=$?
[ "$rc" != 0 ] || {
  echo "out --kill: a rebirth between authorization and the lock must refuse (got: $out)" >&2; exit 1; }
# Hard removal observes only under the lock, so a rebirth reads as a generation mismatch.
grep -q "stored server generation differs" <<<"$out" || {
  echo "out --kill: wrong refusal for a mid-flight rebirth (got: $out)" >&2; exit 1; }
[ -s "$KILL_LOG" ] && {
  echo "out --kill: STALE AUTHORIZATION — killed $(killed_names) using an epoch observed before the lock" >&2
  exit 1; }
python3 -B - "$TAP_HOME/registry.json" <<'PY'
import json, sys
agents = json.load(open(sys.argv[1])).get("seats") or {}
if "roamer" not in agents:
    raise SystemExit("out --kill: a refused kill must roll the row back, not remove it")
PY
echo "destructive-target: 8/9 — tap out --kill re-observes the epoch under the lock: ok"

# ── 9. E2 command path + unbroken-generation control (Amendment 3/9) ──────────
# Same-epoch row whose stored pane id is alive on a FOREIGN session must refuse
# at authorize — never kill the foreign name. A name-keyed aligned seat with one
# unbroken generation must still authorize (proves we did not refuse everything).
rm -f "$TAP_HOME/registry.json.lock"
write_registry <<JSON
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "lead":    {"status": "active", "delivery": "pane", "pane": "demo/lead:0.0", "pane_id": "%11",
                "session": "demo/lead", "server_epoch": "$EPOCH", "harness": "claude"},
    "foreign": {"status": "active", "delivery": "pane", "pane": "demo/foreign:0.0", "pane_id": "%22",
                "session": "demo/foreign", "server_epoch": "$EPOCH", "harness": "codex"}
  }
}
JSON
: > "$KILL_LOG"
rc=0
out="$("$TAP" out foreign --kill 2>&1)" || rc=$?
[ "$rc" != 0 ] || {
  echo "out --kill: E2 foreign-pane row must refuse (got: $out)" >&2; exit 1; }
grep -q "pane_live_elsewhere" <<<"$out" || {
  echo "out --kill: wrong E2 refusal (got: $out)" >&2; exit 1; }
grep -qx -- "demo/proven-elsewhere" "$KILL_LOG" && {
  echo "out --kill: BLAST RADIUS — E2 killed the foreign session" >&2; exit 1; }
grep -qx -- "demo/foreign" "$KILL_LOG" && {
  echo "out --kill: BLAST RADIUS — E2 killed the expected name despite pane mismatch" >&2; exit 1; }
python3 -B - "$TAP_HOME/registry.json" <<'PY'
import json, sys
agents = json.load(open(sys.argv[1])).get("seats") or {}
if "foreign" not in agents:
    raise SystemExit("out --kill: a refused E2 kill must leave the row in place")
PY

write_registry <<JSON
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "lead":   {"status": "active", "delivery": "pane", "pane": "demo/lead:0.0", "pane_id": "%11",
               "session": "demo/lead", "server_epoch": "$EPOCH", "harness": "claude"},
    "roamer": {"status": "active", "delivery": "pane", "pane": "demo/roamer:0.0", "pane_id": "%33",
               "session": "demo/roamer", "server_epoch": "$EPOCH", "harness": "codex"}
  }
}
JSON
: > "$KILL_LOG"; rm -f "$TAP_HOME/registry.json.lock"
rc=0
out="$("$TAP" out roamer --kill 2>&1)" || rc=$?
[ "$rc" = 0 ] || {
  echo "out --kill: OVER-REFUSED — name-keyed aligned seat must still authorize (got: $out)" >&2; exit 1; }
grep -qx -- "demo/roamer" "$KILL_LOG" || {
  echo "out --kill: OVER-REFUSED — expected demo/roamer killed, log has $(killed_names)" >&2; exit 1; }
echo "destructive-target: 9/9 — E2 refuses foreign pane; aligned seat still kills: ok"

echo "destructive-target-guard: all green"
