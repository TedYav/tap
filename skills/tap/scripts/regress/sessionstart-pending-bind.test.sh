#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# sessionstart-pending-bind.test.sh - tap-35m PART 1 smoke: the SessionStart
# hook's `tap in` call transitions a launcher-pre-reserved status=pending seat
# to status=active on source=resume|clear, and does NOT bind on source=startup.
#
# Contract restated 2026-09-17 (tap-emtyf): since the born-live change the
# launcher pre-reserves the pending seat in the POST-FLIP team registry
# <root>/.tap/team-registry.json under the "seats" axis, and the hook binds it
# there. The pre-born-live fixture seeded <TAP_HOME>/registry.json under "agents";
# on a born-live machine that store is retired and never read, so seeding it
# asserted a store production no longer consults.
#
# The hook code was shipped in tap-rvm; this smoke proves the pendingtoactive
# transition via the real registry path (the existing advisory-hook-source.test.sh
# uses a fake tap and proves the CALL, not the TRANSITION).
#
# Run: bash skills/tap/scripts/regress/sessionstart-pending-bind.test.sh
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
HOOK="$ROOT/hooks/tap-advisory.sh"
TAPSH="$ROOT/bin/tap"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT

pass=0
fail=0
ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }

# The bind child is `bash tap.sh in`, which dispatches natively via `exec bun`.
# The hook PATH below is deliberately narrow, so the bun directory travels with
# it explicitly — without it the bind fails for want of the runtime, not on its
# own grounds.
BUN_BIN_DIR="$(dirname "$(command -v bun)")"

echo "tap-35m/sessionstart-pending-bind test  (pending to active via real hook path)"

[ -f "$HOOK" ] || { echo "FAIL: $HOOK not found" >&2; exit 1; }

# Fake tmux (minimal - the hook only needs pane_id + session_name for the bind)
cat > "$FAKE_BIN/ps" <<'PS'
#!/usr/bin/env bash
printf '1 faketty\n'
PS
chmod +x "$FAKE_BIN/ps"
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; shift || true
pane_id_for() { printf '%%1'; }
# tap-bzyz: one TTY source per pane; both tmux queries derive from it.
tty_for() {
  case "$1" in "%1"|"repo/ponytail:0.0") printf '/dev/faketty' ;; *) return 1 ;; esac
}
case "$cmd" in
  list-panes)
    if [[ "$*" == *pane_tty* ]]; then printf '%s\t%s\n' "$(pane_id_for)" "$(tty_for %1)"
    else printf 'repo/ponytail\trepo/ponytail:0.0\t%%1\tcodex\t4242\t1:1\t0\n'; fi ;;
  list-sessions) printf 'repo/ponytail\t1:1\t1\n' ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="${2:-}"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    case "$fmt" in
      '#{pid}:#{start_time}') printf '1:1\n'; exit 0 ;;
      '#{socket_path}') printf '/fake/socket\n'; exit 0 ;;
    esac
    if [ -z "$target" ]; then echo "repo/ponytail:0.0"; exit 0; fi
    # pane_alive queries with '#{pane_id}\t#{session_name}' -- return both
    case "$fmt" in
      # Nine-field combined identity record (85c2e9b46): it also matches the five-field glob below, so it goes first.
      *pane_id*pane_tty*session_name*start_time*window_index*pane_pid*pane_current_command*socket_path*pane_current_path*)
        printf '%s\t%s\t%s\t1:1\trepo/ponytail:0.0\t4242\tcodex\t/fake/socket\t%s\n' "$(pane_id_for)" "$(tty_for "${target:-%1}")" "repo/ponytail" "${TAP_TEST_REPO:-/tmp/test}" ;;
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%%1\trepo/ponytail\t4242\tcodex\t0\n' ;;
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*pane_tty*session_name*) printf '%s\t%s\t%s\t1:1\n' "$(pane_id_for)" "$(tty_for "${target:-%1}")" "repo/ponytail" ;;
      *pane_id*session_name*) printf '%s\t%s' "%1" "repo/ponytail"; [[ "$fmt" == *pid*start_time* ]] && printf '\t1:1'; printf '\n' ;;
      *session_name*) echo "repo/ponytail" ;;
      *pane_id*pane_tty*)     printf '%s\t%s\n' "$(pane_id_for)" "$(tty_for "${target:-%1}")" ;;
      *pane_id*)              pane_id_for; printf '\n' ;;
      *pane_pid*)             echo "4242" ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "codex" ;;
      *pane_current_path*)    echo "${TAP_TEST_REPO:-/tmp/test}" ;;
      *window_activity*)      echo "100" ;;
      *) echo "" ;;
    esac ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH"
export TMUX="/tmp/fake-tmux,1,0"

# Set up a real TAP bus with a registry containing a pending seat
# The team name MUST match the worktree basename so tap_derive_handle can strip
# the team prefix from the session name (tap/<handle> -> <handle>).
REPO="$WORK/repo"
BUS="$REPO/.tap/bus"
TEAM="repo"  # matches the basename of $REPO
mkdir -p "$REPO"
export TAP_HOME="$BUS"

# Initialize the fixture as a git repo so tap-register.sh's worktree root resolution works
git init -q "$REPO"
git -C "$REPO" config user.email "test@example.invalid"
git -C "$REPO" config user.name "Test"
echo "fixture" > "$REPO/README.md"
git -C "$REPO" add -A && git -C "$REPO" commit -qm "fixture base"

# Real born-live bootstrap: `tap init` creates the post-flip
# team registry, enrolls the team in the machine's global registry, and stamps
# the bus. On this shape a SessionStart adapter resolves the repo as a session
# root through the global-registry enrollment (session-start.ts resolveSessionAuthority's
# flip-live branch) — a bare hand-written team-registry.json with no enrollment
# is NOT a session root, and a pre-flip bus/registry.json is the retired world
# this file no longer tests.
( cd "$REPO" && env -u TAP_HOME PATH="$FAKE_BIN:$PATH" bash "$TAPSH" init >/dev/null )

# Put a tap shim in FAKE_BIN that calls the real tap.sh from the fixture repo's cwd.
# Quoted heredoc (tap-psif class): unquoted PATH-shadowed stubs become fork bombs
# the moment a comment gains a prose backtick.
TAP_SH="$ROOT/bin/tap"
export _TAP_SHIM_REPO="$REPO" _TAP_SHIM_TAP="$TAP_SH"
cat > "$FAKE_BIN/tap" <<'TAPSHIM'
#!/usr/bin/env bash
cd "${_TAP_SHIM_REPO:?}"
exec bash "${_TAP_SHIM_TAP:?}" "$@"
TAPSHIM
chmod +x "$FAKE_BIN/tap"

# U3 (tap-voics) fail-closed arm interception: the hook's tap_cmd invokes
# `bash <repo>/scripts/tap.sh in` (PATH bash), and tap.sh dispatches `in` via
# `exec bun .../main.ts register` behind `tap.sh in` — so a fake `bash` sees
# bind worker. Pure delegation unless the arm exports _U3_CORRUPT_MARKER, in
# the register door, in which case a SUCCESSFUL register run corrupts the flip marker before
# the hook's fresh re-resolution (same mechanism ratified in crew-add).
# _U3_FORCE_BIND_FAILURE is the review-requested arm: the real child succeeds
# (authority moved) but the wrapper reports failure — the partially-mutating
# failed bind the post-attempt refresh exists for.
export _U3_REAL_BASH="$(command -v bash)"
cat > "$FAKE_BIN/bash" <<'FAKEBASH'
#!/bin/bash
case "${1:-}" in
  # The SessionStart entry runs <repo>/bin/tap, whose env-bash shebang lands here.
  */tap.sh|*/bin/tap)
    "${_U3_REAL_BASH:?}" "$@"; rc=$?
    if [ "$rc" -eq 0 ] && [ -n "${_U3_CORRUPT_MARKER:-}" ]; then
      printf 'corrupted-by-sessionstart-pending-bind\n' >> "${_U3_CORRUPT_MARKER:?}"
    fi
    if [ "$rc" -eq 0 ] && [ -n "${_U3_FORCE_BIND_FAILURE:-}" ]; then
      exit 1
    fi
    exit "$rc" ;;
  *) exec "${_U3_REAL_BASH:?}" "$@" ;;
esac
FAKEBASH
chmod +x "$FAKE_BIN/bash"

# The hook's tap_cmd checks: command -v tap (in PATH), then $ROOT/bin/tap, then $ROOT/scripts/tap.sh.
# We put a tap shim in FAKE_BIN (already in PATH) that calls the real tap.sh with all its scripts dir.

# Write the POST-FLIP team registry with a launcher-pre-reserved PENDING seat.
# The session name is <team>/<handle> so tap_derive_handle strips the prefix.
# Since born-live this store — not <TAP_HOME>/registry.json — is what
# the hook's `tap in` bind path reads and writes.
cat > "$REPO/.tap/team-registry.json" <<JSON
{
  "schema": "0.20",
  "team": { "name": "$TEAM", "worktree_root": "$REPO" },
  "seats": {
    "ponytail": {
      "handle": "ponytail",
      "pane": "repo/ponytail:0.0",
      "pane_id": "%1",
      "harness": "codex",
      "status": "pending",
      "status_reason": "",
      "session": "repo/ponytail",
      "delivery": "pane",
      "registered_from_worktree": "$REPO"
    }
  }
}
JSON

# Helper: invoke the hook with a given source
run_hook_repo() {
  local repo="$1" bus="$2" source="$3"
  printf '{"hook_event_name":"SessionStart","source":"%s","cwd":"%s"}' "$source" "$repo" \
    | env \
      PATH="$FAKE_BIN:${BUN_BIN_DIR:?}:/usr/bin:/bin" \
      HOME="$WORK" \
      CLAUDE_PROJECT_DIR="$repo" \
      TMUX="/tmp/fake-tmux,1,0" \
      TAP_HOME="$bus" \
      TAP_TEST_REPO="$repo" \
      bash "$HOOK"
}
run_hook() { run_hook_repo "$REPO" "$BUS" "$1"; }

# Helper: read the seat status from the post-flip team registry
seat_status() {
  python3 -B "$WORK/seat_status.py" "$REPO/.tap/team-registry.json"
}

# Write the seat status helper script
cat > "$WORK/seat_status.py" <<'PYEOF'
import json, sys
reg = json.load(open(sys.argv[1]))
# The post-flip contract: the seat lives under "seats". Fall back to "agents"
# would let a writer regression restore the retired axis and stay green here.
ent = reg["seats"].get("ponytail", {})
print(ent.get("status", ""))
print(ent.get("status_reason", ""))
PYEOF

# -- (a) source=resume: pending seat transitions to active --
echo "-- (a) source=resume: pending to active --"
OUT_A="$(run_hook "resume" 2>/dev/null || true)"
STATUS="$(seat_status | head -1)"
REASON="$(seat_status | tail -1)"
if [ "$STATUS" = "active" ] && [ -z "$REASON" ] \
   && printf '%s' "$OUT_A" | grep -qF 'TAP: registered as ponytail on team repo.' \
   && ! printf '%s' "$OUT_A" | grep -qF 'this seat is not registered'; then
  ok "resume: pending seat active + registered advisory (not-registered absent)"
else
  bad "resume: seat=$STATUS reason=$REASON out=${OUT_A:0:160}"
fi

# Reset to pending for the clear test
cat > "$WORK/reset_pending.py" <<'PYEOF'
import json, sys
reg = json.load(open(sys.argv[1]))
# Same contract as seat_status: "seats" directly — no retired-axis fallback.
reg["seats"]["ponytail"]["status"] = "pending"
reg["seats"]["ponytail"]["status_reason"] = ""
json.dump(reg, open(sys.argv[1], "w"))
PYEOF
python3 -B "$WORK/reset_pending.py" "$REPO/.tap/team-registry.json"

# -- (b) source=clear: pending seat transitions to active --
echo "-- (b) source=clear: pending to active --"
OUT_B="$(run_hook "clear" 2>/dev/null || true)"
STATUS="$(seat_status | head -1)"
REASON="$(seat_status | tail -1)"
if [ "$STATUS" = "active" ] && [ -z "$REASON" ] \
   && printf '%s' "$OUT_B" | grep -qF 'TAP: registered as ponytail on team repo.' \
   && ! printf '%s' "$OUT_B" | grep -qF 'this seat is not registered'; then
  ok "clear: pending seat active + registered advisory (not-registered absent)"
else
  bad "clear: seat=$STATUS reason=$REASON out=${OUT_B:0:160}"
fi

# Reset to pending for the startup control
python3 -B "$WORK/reset_pending.py" "$REPO/.tap/team-registry.json"

# -- (c) source=startup: pending seat stays pending (NO auto-bind) --
echo "-- (c) source=startup: pending stays pending (no auto-bind) --"
run_hook "startup" >/dev/null 2>&1 || true
STATUS="$(seat_status | head -1)"
if [ "$STATUS" = "pending" ]; then
  ok "startup: pending seat stays pending (no auto-bind - the ephemeral-agent boundary)"
else
  bad "startup: seat changed to $STATUS (should stay pending - startup is advisory-only)"
fi

# -- (d) source=compact: pending seat stays pending (advisory-only) --
echo "-- (d) source=compact: pending stays pending (advisory-only) --"
run_hook "compact" >/dev/null 2>&1 || true
STATUS="$(seat_status | head -1)"
if [ "$STATUS" = "pending" ]; then
  ok "compact: pending seat stays pending (advisory-only)"
else
  bad "compact: seat changed to $STATUS (should stay pending)"
fi

# -- (e) U3 (tap-voics) marker-absent specimen: the pre-existing bus
# agents.ponytail pending row is a PRE-V0.20 store. Since born-live an absent
# marker has no enrolled root, so SessionStart finds no session root at all:
# no bind attempt, no fold, no enroll, no team registry, and no TAP context.
# Old bus state authorizes nothing — the fail-closed property, now enforced
# at root discovery. The empty-output assertion cannot pass vacuously: cases
# (a)-(d), (f) and (g) run this same hook helper and must print context. --
echo "-- (e) marker-absent specimen: pre-v0.20 bus store is not a session root --"
SPEC_INDEX="$WORK/u3-specimen-index"
SPEC="$WORK/specimen/repo"   # basename must be "repo": the fake tmux session
                             # name is repo/ponytail, so derive_handle strips
                             # the matching team prefix
mkdir -p "$SPEC_INDEX" "$SPEC"
git init -q "$SPEC"
git -C "$SPEC" config user.email "test@example.invalid"
git -C "$SPEC" config user.name "Test"
echo "fixture" > "$SPEC/README.md"
git -C "$SPEC" add -A && git -C "$SPEC" commit -qm "specimen base"
mkdir -p "$SPEC/.tap/bus"
# old-shape fixture: (e) pins the old-store door refusing a markerless pre-v0.20 bus store
cat > "$SPEC/.tap/bus/registry.json" <<JSON
{
  "team": { "name": "repo", "worktree_root": "$SPEC" },
  "agents": {
    "ponytail": {
      "handle": "ponytail",
      "pane": "repo/ponytail:0.0",
      "pane_id": "%1",
      "harness": "codex",
      "status": "pending",
      "status_reason": "",
      "session": "repo/ponytail",
      "delivery": "pane",
      "registered_from_worktree": "$SPEC"
    }
  }
}
JSON
spec_seat_status() { python3 -B "$WORK/seat_status.py" "$SPEC/.tap/team-registry.json"; }
U3_SAVED_INDEX="${TAP_INDEX_HOME:-}"
TAP_INDEX_HOME="$SPEC_INDEX"; export TAP_INDEX_HOME
OUT_E="$(run_hook_repo "$SPEC" "$SPEC/.tap/bus" "resume" 2>/dev/null || true)"
TAP_INDEX_HOME="$U3_SAVED_INDEX"; export TAP_INDEX_HOME
SPEC_STATUS=""
[ -f "$SPEC/.tap/team-registry.json" ] && SPEC_STATUS="$(spec_seat_status | head -1)"
if [ ! -e "$SPEC/.tap/team-registry.json" ] && [ -z "$SPEC_STATUS" ] \
   && [ ! -e "$SPEC_INDEX/global-registry.json" ] \
   && [ -z "$OUT_E" ]; then
  ok "specimen: old store is no session root; no write, no marker, no TAP context"
else
  bad "specimen: seat=$SPEC_STATUS marker=$([ -e "$SPEC_INDEX/global-registry.json" ] && echo present || echo absent) out=${OUT_E:0:200}"
fi

# -- (f) U3 (tap-voics) fail-closed: the bind succeeds, then corrupts the flip
# marker before the hook's refresh. The fresh resolution must refuse and the
# hook must print NOTHING: old bus state authorizes neither advisory. --
echo "-- (f) fail-closed: successful bind then corrupt marker, stdout empty --"
python3 -B "$WORK/reset_pending.py" "$REPO/.tap/team-registry.json"
U3_MARKER="${TAP_INDEX_HOME:?}/global-registry.json"
cp "$U3_MARKER" "$WORK/u3-marker.bak"
export _U3_CORRUPT_MARKER="$U3_MARKER"
OUT_F="$(run_hook "resume" 2>/dev/null || true)"
unset _U3_CORRUPT_MARKER
F_STATUS="$(seat_status | head -1)"
cp "$WORK/u3-marker.bak" "$U3_MARKER"
if [ -z "$OUT_F" ] && [ "$F_STATUS" = "active" ]; then
  ok "fail-closed: bind succeeded (row active), corrupt marker silences both advisories"
else
  bad "fail-closed: seat=$F_STATUS out=${OUT_F:0:200}"
fi

# -- (g) review finding: a partially-mutating FAILED bind.
# The real register child succeeds — acting row active, team enrolled — but the
# wrapper forces `tap in` nonzero. The hook must re-resolve AFTER the attempted
# bind regardless of its outcome: the registered advisory follows the moved
# authority even on a failed bind. Fresh born-live specimen, own index: the
# pre-v0.20 fold shape (e) used to carry this pin, and that world is retired by
# the old-store door, so the specimen bootstraps live BEFORE the bind — the only
# world where a bind can still mutate and then report failure. --
echo "-- (g) failed bind that still moved authority: advisory follows acting row --"
G_SAVED_INDEX="${TAP_INDEX_HOME:-}"
G_INDEX="$WORK/u3-specimen-index-g"
SPEC_G="$WORK/specimen-g/repo"   # basename must be "repo" (derive_handle, as in (e))
mkdir -p "$G_INDEX" "$SPEC_G"
git init -q "$SPEC_G"
git -C "$SPEC_G" config user.email "test@example.invalid"
git -C "$SPEC_G" config user.name "Test"
echo "fixture" > "$SPEC_G/README.md"
git -C "$SPEC_G" add -A && git -C "$SPEC_G" commit -qm "specimen g base"
# Born-live bootstrap into the specimen's own index, then the same pending-row
# seed the main world uses (pane repo/ponytail:0.0, id %1, session repo/ponytail).
( cd "$SPEC_G" && env -u TAP_HOME TAP_INDEX_HOME="$G_INDEX" \
    PATH="$FAKE_BIN:${BUN_BIN_DIR:?}:$PATH" bash "$TAPSH" init >/dev/null )
cat > "$SPEC_G/.tap/team-registry.json" <<JSON
{
  "schema": "0.20",
  "team": { "name": "repo", "worktree_root": "$SPEC_G" },
  "seats": {
    "ponytail": {
      "handle": "ponytail",
      "pane": "repo/ponytail:0.0",
      "pane_id": "%1",
      "harness": "codex",
      "status": "pending",
      "status_reason": "",
      "session": "repo/ponytail",
      "delivery": "pane",
      "registered_from_worktree": "$SPEC_G"
    }
  }
}
JSON
spec_g_seat_status() { python3 -B "$WORK/seat_status.py" "$SPEC_G/.tap/team-registry.json"; }
TAP_INDEX_HOME="$G_INDEX"; export TAP_INDEX_HOME
export _U3_FORCE_BIND_FAILURE=1
OUT_G="$(run_hook_repo "$SPEC_G" "$SPEC_G/.tap/bus" "resume" 2>/dev/null || true)"
unset _U3_FORCE_BIND_FAILURE
TAP_INDEX_HOME="$G_SAVED_INDEX"; export TAP_INDEX_HOME
G_STATUS="$(spec_g_seat_status | head -1)"
if [ "$G_STATUS" = "active" ] \
   && printf '%s' "$OUT_G" | grep -qF 'TAP: registered as ponytail on team repo.' \
   && ! printf '%s' "$OUT_G" | grep -qF 'this seat is not registered'; then
  ok "failed bind: acting row active + registered advisory follows moved authority"
else
  bad "failed-bind: seat=$G_STATUS out=${OUT_G:0:200}"
fi

echo "tap-35m/sessionstart-pending-bind test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
