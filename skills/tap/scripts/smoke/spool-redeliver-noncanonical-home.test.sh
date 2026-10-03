#!/usr/bin/env bash
# spool-redeliver-noncanonical-home.test.sh — tap-ncd4: TAP_HOME sandboxes the
# SPOOL, never the pane/pane_id/target_registry ARGUMENTS. A probe that
# sandboxes TAP_HOME but calls a pane-effect function with real, stored
# specimen args still resolves and injects into a live pane, rc=0, no
# warning — the live incident reached `tap/gemini:0.0` exactly this way.
#
# THE SIGNAL (revised after decorrelated review broke the first cut — see the
# authorizedHome comment in spool-drain.ts for the full account): not a
# TAP_HOME path-SHAPE check (CONTRACT.md explicitly supports an arbitrary,
# non-canonically-shaped custom TAP_HOME as a real production layout, and a
# shape check is trivially spoofed by naming a sandbox `.../.tap/bus`). A
# DURABLE MARKER instead — `.tap-bus-authority`, written by `Bus.ensureDirs`,
# which every real bus passes through before its first write. A production
# bus is stamped for free; a bare probe directory nobody ever ran `tap`
# against is not.
#
# THE PLACEMENT (also revised): not only inside `_tap_spool_native redeliver`. P1
# review found `tap_spool_drain_once` probes panes before ever reaching
# redeliver, and Phase C's digest door (`_tap_spool_native digest`) delivered
# straight past a redeliver-only guard. Checked at three sites: drain entry,
# redeliver, and digest inject — defense at the boundary AND at the sites.
#
# Fixture PAIR (fable's ruling, pinned) plus a third arm for the digest door
# P1 finding: RED — an unauthorized TAP_HOME plus real-shaped pane arguments
# must REFUSE, before any tmux call at all. GREEN — an authorized TAP_HOME
# delivering to a REAL cross-team-qualified target registry must still
# DELIVER, and a team MISMATCH against that same authorized TAP_HOME must
# still refuse (proves the team check, not just the marker check, is live).
# DIGEST — the same authorized/unauthorized split, driven through the real
# `tap_spool_drain_once` entry point with two plain-eligible entries, so the
# digest door is covered by the same instrument as the per-id path.
#
# Every RED/refusal row carries its own red-on-known-bad control (override
# set by hand) proving the SAME fixture reaches the pane/digest when the
# guard is bypassed — a refusal that could never have fired anyway proves
# nothing (sol-ponytail P2, both original rows were this shape).

# tap-7r3fn.20: this fixture is about the noncanonical-home GUARD; an earlier arm
# delivers to `recipient`, which opens that seat's delivery window, and the digest
# arm's entries then park in the future and never reach Phase A — the known-bad
# arm reported exactly that and was right.
# A window of zero is the seam that turns it off (ruling 24 keeps this variable
# overriding the short window), and it says so without knowing where the clock
# is stored — unlike deleting the clock directory by hand.
export TAP_AUTOSETTLE_HOLD_SECONDS=0

if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

# Mock-tmux smoke: real submit-verify sleeps against a synchronous fake would
# pay production-scale delays for nothing observable (same knob as
# courier-digest.test.sh / payload-atomicity.test.sh; default 1 in production).
export TAP_TUI_SETTLE_SCALE=0.1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
LIB="$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "spool-redeliver-noncanonical-home: $1" >&2; exit 1; }

FAKE_BIN="$WORK/bin"; mkdir -p "$FAKE_BIN"
# Same pattern as courier-digest.test.sh / payload-atomicity.test.sh: a
# minimal tmux double that supports a full submit-verify round trip, and
# LOGS EVERY SUBCOMMAND'S FULL ARGV (not just "was tmux touched at all") —
# sol-ponytail's P2 found the previous cut's `called` marker fires on any
# identity probe (display-message/list-panes), long before an actual
# send-keys/Enter injection, which made the known-bad control pass without
# ever proving injection happened.
cat > "$FAKE_BIN/tmux" <<'ENDTMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"
mkdir -p "$state"
printf '%s\n' "$*" >> "$state/argv.log"
while [ "${1:-}" = -L ] || [ "${1:-}" = -S ]; do shift 2; done
cmd="${1:-}"; shift || true
case "$cmd" in
  list-sessions) printf 'sess\t4242:100\n' ;;
  list-panes)
    while [ "$#" -gt 0 ]; do
      case "$1" in -s) shift ;; -t) shift 2 ;; -F) shift 2 ;; *) shift ;; esac
    done
    printf 'sess\tsess:0.0\t%%701\tcodex\t5701\t4242:100\t0\n'
    ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="${2:-}"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    case "$fmt" in
      $'#{pane_id}\t#{session_name}\t#{pane_pid}\t#{pane_current_command}\t#{pane_dead}') printf '%%701\tsess\t5701\tcodex\t0\n' ;;
      '#{pid}:#{start_time}') echo '4242:100' ;;
      '#{pane_width}') echo 120 ;;
      *pane_id*)              echo "%701" ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "codex" ;;
      *)                      echo "" ;;
    esac ;;
  capture-pane)
    if [ -f "$state/input" ]; then printf '› %s\n' "$(cat "$state/input")"
    else printf '› \n'; fi
    printf '\n  gpt-6-astra medium · Context 99%% left\n' ;;
  send-keys)
    printf '%s\n' "$*" >> "$state/send-keys.log"
    if [ "${1:-}" = "-t" ]; then shift 2; fi
    if [ "${1:-}" = "-l" ]; then
      shift; [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" >"$state/input"; exit 0
    fi
    [ "${1:-}" = "C-u" ] && rm -f "$state/input" || true
    [ "${1:-}" = "Enter" ] && rm -f "$state/input" || true ;;
esac
ENDTMUX
chmod +x "$FAKE_BIN/tmux"

mk_registry() { # <path> <team> <handle>
  cat >"$1" <<JSON
{"schema": "0.20", "team":{"name":"$2"},"seats":{"$3":{"session":"sess","pane":"sess:0.0","pane_id":"%701","status":"active","harness":"codex","server_epoch":"srv:4242:100","boot_id":"boot:1"}}}
JSON
}

plant() { # <bus> <id> <handle>
  mkdir -p "$1/spool" "$1/payloads" "$1/receipts"
  cat >"$1/spool/$2.md" <<EOF
---
id: $2
from: sender
to: $3
kind: discuss
path: $1/spool/$2.md
reply: settle-only
---
body $2
EOF
}

# Proves actual keystroke injection happened, not merely "tmux was touched":
# a literal-text push AND a bare Enter, both logged with their real argv.
assert_real_injection() { # <send-keys.log path> <context>
  grep -q -- '-l' "$1" 2>/dev/null || fail "$2: no literal text was ever pushed (send-keys -l never logged) — this is not a real injection"
  grep -qE '(^| )Enter$' "$1" 2>/dev/null || fail "$2: Enter was never sent — the sentinel was staged but never submitted"
}

export TAP_SERVER_EPOCH="srv:4242:100" TAP_BOOT_ID="boot:1"

# ============================================================================
# ARM 1 — _tap_spool_native redeliver, direct call
# ============================================================================

# ---- (RED) an UNAUTHORIZED TAP_HOME + real-shaped pane args refuses, before any tmux call at all ----
RED_HOME="$WORK/red-sandbox"          # never bootstrapped — no Bus.ensureDirs
mkdir -p "$RED_HOME/spool" "$RED_HOME/payloads"
plant "$RED_HOME" red1 recipient
REDREG="$WORK/red-registry.json"
mk_registry "$REDREG" liveteam recipient
RED_TMUX_STATE="$WORK/red-tmux"

red_rc=0
TAP_HOME="$RED_HOME" PATH="$FAKE_BIN:$PATH" FAKE_TMUX_STATE="$RED_TMUX_STATE" TMUX="/fake/socket" \
  bash -c '. "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_engine_fixture redeliver red1 recipient sess:0.0 %701 "" "$2"' _ "$LIB" "$REDREG" \
  >"$WORK/red.out" 2>"$WORK/red.err" || red_rc=$?

[ "$red_rc" = 1 ] || fail "(RED) unauthorized TAP_HOME did not refuse: rc=$red_rc, stderr=$(cat "$WORK/red.err")"
grep -q 'tap-ncd4' "$WORK/red.err" || fail "(RED) refusal did not name tap-ncd4: $(cat "$WORK/red.err")"
[ -f "$RED_HOME/spool/red1.md" ] || fail "(RED) refusal moved the spool payload — it must refuse BEFORE any mv"
[ ! -e "$RED_TMUX_STATE/argv.log" ] || fail "(RED) refusal still called tmux ($(cat "$RED_TMUX_STATE/argv.log" 2>/dev/null)) — must refuse before ANY pane touch"
echo "spool-redeliver-noncanonical-home: (RED) unauthorized TAP_HOME + real pane args refuses before any tmux call: ok"

# ---- RED-ON-KNOWN-BAD: same fixture, override set by hand, must reach a REAL injection ----
unpatched_rc=0
BYPASS_TMUX_STATE="$WORK/red-tmux-bypass"
TAP_HOME="$RED_HOME" PATH="$FAKE_BIN:$PATH" FAKE_TMUX_STATE="$BYPASS_TMUX_STATE" TMUX="/fake/socket" \
  TAP_SPOOL_PANE_EFFECTS_UNSTAMPED_HOME_OK=1 \
  bash -c '. "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_engine_fixture redeliver red1 recipient sess:0.0 %701 "" "$2"' _ "$LIB" "$REDREG" \
  >"$WORK/bypass.out" 2>"$WORK/bypass.err" || unpatched_rc=$?
[ "$unpatched_rc" = 0 ] || fail "RED-ON-KNOWN-BAD: the override did not reach a clean delivery (rc=$unpatched_rc, $(cat "$WORK/bypass.err"))"
assert_real_injection "$BYPASS_TMUX_STATE/send-keys.log" "RED-ON-KNOWN-BAD"
[ ! -f "$RED_HOME/spool/red1.md" ] || fail "RED-ON-KNOWN-BAD: the override delivered but the entry is still in the spool"
echo "spool-redeliver-noncanonical-home: (red-on-known-bad) the same fixture reaches a REAL injection without the guard — the RED refusal above is real: ok"

# ============================================================================
# ARM 2 — _tap_spool_native redeliver, AUTHORIZED home, real cross-team qualification
# ============================================================================

# ---- (GREEN) an AUTHORIZED TAP_HOME delivering to a real cross-team-QUALIFIED registry still delivers ----
GREEN_HOME="$WORK/green-repo/.tap/bus"
mkdir -p "$GREEN_HOME/spool" "$GREEN_HOME/payloads"
plant "$GREEN_HOME" green1 recipient
# The target registry legitimately lives OUTSIDE the sender's own TAP_HOME
# tree and names a DIFFERENT team — the structural shape of a real cross-team
# relay target, not a same-tree sibling — and to_team is the REAL team name,
# not empty, so tap_registry_matches_team actually reads and compares it.
GREENREG="$WORK/other-team-registry.json"
mk_registry "$GREENREG" otherteam recipient
GREEN_TMUX_STATE="$WORK/green-tmux"

# Authorize through the production Bus.ensureDirs owner, not the override.
"${TAP_SMOKE_BUN:-bun}" "$ROOT/runtime/bun/test/support/authority-cli.ts" ensure "$GREEN_HOME"
[ -f "$GREEN_HOME/.tap-bus-authority" ] || fail "(GREEN) setup: Bus.ensureDirs did not stamp the authority marker"

green_rc=0
TAP_HOME="$GREEN_HOME" PATH="$FAKE_BIN:$PATH" FAKE_TMUX_STATE="$GREEN_TMUX_STATE" TMUX="/fake/socket" \
  bash -c '. "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_engine_fixture redeliver green1 recipient sess:0.0 %701 otherteam "$2"' _ "$LIB" "$GREENREG" \
  >"$WORK/green.out" 2>"$WORK/green.err" || green_rc=$?

[ "$green_rc" = 0 ] || fail "(GREEN) authorized TAP_HOME + qualified cross-team target failed to deliver: rc=$green_rc, stdout=$(cat "$WORK/green.out") stderr=$(cat "$WORK/green.err")"
assert_real_injection "$GREEN_TMUX_STATE/send-keys.log" "(GREEN)"
[ ! -f "$GREEN_HOME/spool/green1.md" ] && [ ! -f "$GREEN_HOME/spool/green1.meta.json" ] \
  || fail "(GREEN) the entry is still parked after a reported success"
echo "spool-redeliver-noncanonical-home: (GREEN) authorized TAP_HOME delivers to a real cross-team-qualified target: ok"

# ---- (GREEN-NEGATIVE) same authorized TAP_HOME, MISMATCHED to_team refuses — proves the team check is load-bearing, not the marker alone ----
plant "$GREEN_HOME" green2 recipient
neg_rc=0
NEG_TMUX_STATE="$WORK/green-negative-tmux"
TAP_HOME="$GREEN_HOME" PATH="$FAKE_BIN:$PATH" FAKE_TMUX_STATE="$NEG_TMUX_STATE" TMUX="/fake/socket" \
  bash -c '. "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_engine_fixture redeliver green2 recipient sess:0.0 %701 wrongteam "$2"' _ "$LIB" "$GREENREG" \
  >"$WORK/neg.out" 2>"$WORK/neg.err" || neg_rc=$?
[ "$neg_rc" = 1 ] || fail "(GREEN-NEGATIVE) a team MISMATCH against an authorized home unexpectedly delivered: rc=$neg_rc"
[ ! -e "$NEG_TMUX_STATE/argv.log" ] || fail "(GREEN-NEGATIVE) team mismatch still called tmux — team validation ran after a pane touch"
echo "spool-redeliver-noncanonical-home: (GREEN-negative) an authorized TAP_HOME still refuses a team MISMATCH — the team check is real, not bypassed by authorization: ok"

# ============================================================================
# ARM 3 — the DIGEST DOOR, driven through the real tap_spool_drain_once entry
# point with the native placement and spool park fixtures (courier-digest.test.sh's
# own proven plumbing) — sol-ponytail's P1: a
# redeliver-only guard left this door open, demonstrated by changing only
# courier-digest.test.sh's bus to a non-canonical path and observing a
# digest still deliver.
# ============================================================================

DIGEST_TMUX_STATE="$WORK/digest-tmux"
mk_digest_spool() { # <bus> <registry> <id> <from> <reply>
  local bus="$1" reg="$2" id="$3" from="$4" reply="$5" src canon
  src="$WORK/digest-src-$id.md"
  printf '%s\n' '---' '---' "body of $id from $from" >"$src"
  TAP_HOME="$bus" bash -c '
    . "$1"
    . "${1%/smoke/runtime-helpers.sh}/smoke/spool-park-fixture.sh"
    . "${1%/smoke/runtime-helpers.sh}/smoke/canonical-place-fixture.sh"
    canon="${TAP_PAYLOADS}/$3.md"
    canonical_place_fixture "$2" "$3" "$4" recipient discuss "$canon" 0 "$5" digestteam digestteam >/dev/null 2>&1
    spool_park_fixture "$3" "$canon" recipient digestteam no-input-prompt busy 600 sess:0.0 %701 "" standard "" "$6" >/dev/null
    rm -f "$canon"
  ' _ "$LIB" "$src" "$id" "$from" "$reply" "$reg"
}

# ---- (DIGEST-RED) an UNAUTHORIZED bus refuses at the drain's own front door — before Phase A, before the digest door ----
DIGEST_RED_HOME="$WORK/digest-red-sandbox"     # never bootstrapped
mkdir -p "$DIGEST_RED_HOME/spool" "$DIGEST_RED_HOME/payloads" "$DIGEST_RED_HOME/receipts"
DIGESTREG="$WORK/digest-registry.json"
mk_registry "$DIGESTREG" digestteam recipient
mk_digest_spool "$DIGEST_RED_HOME" "$DIGESTREG" dg-a alice expected
mk_digest_spool "$DIGEST_RED_HOME" "$DIGESTREG" dg-b bob expected

digest_red_rc=0
TAP_HOME="$DIGEST_RED_HOME" PATH="$FAKE_BIN:$PATH" FAKE_TMUX_STATE="$DIGEST_TMUX_STATE" TMUX="/fake/socket" \
  TAP_SPOOL_DISABLE_DELIVERER=1 \
  bash -c '. "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once' _ "$LIB" \
  >"$WORK/digest-red.out" 2>"$WORK/digest-red.err" || digest_red_rc=$?

[ "$digest_red_rc" = 1 ] || fail "(DIGEST-RED) unauthorized bus did not refuse at drain entry: rc=$digest_red_rc, stderr=$(cat "$WORK/digest-red.err")"
grep -q 'tap-ncd4' "$WORK/digest-red.err" || fail "(DIGEST-RED) refusal did not name tap-ncd4: $(cat "$WORK/digest-red.err")"
[ -f "$DIGEST_RED_HOME/spool/dg-a.md" ] && [ -f "$DIGEST_RED_HOME/spool/dg-b.md" ] \
  || fail "(DIGEST-RED) refusal moved a spool payload — it must refuse before Phase A"
[ -z "$(find "$DIGEST_RED_HOME/spool/digests" -maxdepth 1 -name '*.json' 2>/dev/null)" ] \
  || fail "(DIGEST-RED) refusal still built a digest index"
[ ! -e "$DIGEST_TMUX_STATE/argv.log" ] || fail "(DIGEST-RED) refusal still called tmux ($(cat "$DIGEST_TMUX_STATE/argv.log" 2>/dev/null))"
echo "spool-redeliver-noncanonical-home: (DIGEST-RED) unauthorized bus refuses at the drain's own front door, before Phase A or the digest door: ok"

# ---- DIGEST RED-ON-KNOWN-BAD: same fixture, override set, must actually build and deliver a digest ----
DIGEST_BYPASS_TMUX_STATE="$WORK/digest-bypass-tmux"
digest_unpatched_rc=0
TAP_HOME="$DIGEST_RED_HOME" PATH="$FAKE_BIN:$PATH" FAKE_TMUX_STATE="$DIGEST_BYPASS_TMUX_STATE" TMUX="/fake/socket" \
  TAP_SPOOL_DISABLE_DELIVERER=1 \
  TAP_SPOOL_PANE_EFFECTS_UNSTAMPED_HOME_OK=1 \
  bash -c '. "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once' _ "$LIB" \
  >"$WORK/digest-bypass.out" 2>"$WORK/digest-bypass.err" || digest_unpatched_rc=$?
[ "$digest_unpatched_rc" = 0 ] || fail "DIGEST RED-ON-KNOWN-BAD: the override did not reach a clean drain (rc=$digest_unpatched_rc, $(cat "$WORK/digest-bypass.err"))"
grep -qcE '\[\[TAP v[0-9.]+ (ask|note) [^ ]+( [a-z]+)* digest' "$DIGEST_BYPASS_TMUX_STATE/send-keys.log" >/dev/null 2>&1 \
  || fail "DIGEST RED-ON-KNOWN-BAD: no kind=digest sentinel was ever staged — the fixture cannot demonstrate the guard is doing anything"
assert_real_injection "$DIGEST_BYPASS_TMUX_STATE/send-keys.log" "DIGEST RED-ON-KNOWN-BAD"
[ ! -f "$DIGEST_RED_HOME/spool/dg-a.md" ] && [ ! -f "$DIGEST_RED_HOME/spool/dg-b.md" ] \
  || fail "DIGEST RED-ON-KNOWN-BAD: the override delivered but entries are still in the spool"
echo "spool-redeliver-noncanonical-home: (digest-red-on-known-bad) the same fixture WOULD have built and delivered a real digest without the guard — the DIGEST-RED refusal above is real: ok"

# ============================================================================
# ARM 4 — _tap_spool_native digest, DIRECT call (sol-ponytail P2, mutation-
# proved): ARM 3 above always goes through tap_spool_drain_once, which stops
# at the DRAIN-ENTRY guard before _tap_spool_native digest is ever reached —
# deleting only the guard INSIDE _tap_spool_native digest left both this file
# (at the time) and courier-digest.test.sh green. This arm calls the digest
# helper directly, so its own guard is independently pinned rather than
# shadowed by the drain-entry check.
# ============================================================================

DIGEST_DIRECT_HOME="$WORK/digest-direct-sandbox"     # never bootstrapped
mkdir -p "$DIGEST_DIRECT_HOME/spool" "$DIGEST_DIRECT_HOME/payloads" "$DIGEST_DIRECT_HOME/receipts"
mk_digest_spool "$DIGEST_DIRECT_HOME" "$DIGESTREG" dg-c alice expected
mk_digest_spool "$DIGEST_DIRECT_HOME" "$DIGESTREG" dg-d bob expected
DIGEST_DIRECT_TMUX_STATE="$WORK/digest-direct-tmux"

digest_direct_rc=0
TAP_HOME="$DIGEST_DIRECT_HOME" PATH="$FAKE_BIN:$PATH" FAKE_TMUX_STATE="$DIGEST_DIRECT_TMUX_STATE" TMUX="/fake/socket" \
  bash -c '. "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_engine_fixture digest "$2" digestteam recipient sess:0.0 %701 dg-c dg-d' _ "$LIB" "$DIGESTREG" \
  >"$WORK/digest-direct.out" 2>"$WORK/digest-direct.err" || digest_direct_rc=$?

[ "$digest_direct_rc" = 1 ] || fail "(DIGEST-DIRECT-RED) unauthorized bus did not refuse a direct spool_engine_fixture digest call: rc=$digest_direct_rc, stderr=$(cat "$WORK/digest-direct.err")"
grep -q 'tap-ncd4' "$WORK/digest-direct.err" || fail "(DIGEST-DIRECT-RED) refusal did not name tap-ncd4: $(cat "$WORK/digest-direct.err")"
[ -f "$DIGEST_DIRECT_HOME/spool/dg-c.md" ] && [ -f "$DIGEST_DIRECT_HOME/spool/dg-d.md" ] \
  || fail "(DIGEST-DIRECT-RED) refusal claimed or moved a spool payload"
[ -z "$(find "$DIGEST_DIRECT_HOME/spool/digests" -maxdepth 1 -name '*.json' 2>/dev/null)" ] \
  || fail "(DIGEST-DIRECT-RED) refusal still built a digest index"
[ ! -e "$DIGEST_DIRECT_TMUX_STATE/argv.log" ] || fail "(DIGEST-DIRECT-RED) refusal still called tmux ($(cat "$DIGEST_DIRECT_TMUX_STATE/argv.log" 2>/dev/null))"
echo "spool-redeliver-noncanonical-home: (DIGEST-DIRECT-RED) a direct spool_engine_fixture digest call refuses on its own guard, independent of drain entry: ok"

digest_direct_bypass_rc=0
DIGEST_DIRECT_BYPASS_TMUX_STATE="$WORK/digest-direct-bypass-tmux"
TAP_HOME="$DIGEST_DIRECT_HOME" PATH="$FAKE_BIN:$PATH" FAKE_TMUX_STATE="$DIGEST_DIRECT_BYPASS_TMUX_STATE" TMUX="/fake/socket" \
  TAP_SPOOL_PANE_EFFECTS_UNSTAMPED_HOME_OK=1 \
  bash -c '. "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_engine_fixture digest "$2" digestteam recipient sess:0.0 %701 dg-c dg-d' _ "$LIB" "$DIGESTREG" \
  >"$WORK/digest-direct-bypass.out" 2>"$WORK/digest-direct-bypass.err" || digest_direct_bypass_rc=$?
[ "$digest_direct_bypass_rc" = 0 ] || fail "DIGEST-DIRECT RED-ON-KNOWN-BAD: the override did not reach a clean digest inject (rc=$digest_direct_bypass_rc, $(cat "$WORK/digest-direct-bypass.err"))"
grep -qcE '\[\[TAP v[0-9.]+ (ask|note) [^ ]+( [a-z]+)* digest' "$DIGEST_DIRECT_BYPASS_TMUX_STATE/send-keys.log" >/dev/null 2>&1 \
  || fail "DIGEST-DIRECT RED-ON-KNOWN-BAD: no kind=digest sentinel was ever staged"
assert_real_injection "$DIGEST_DIRECT_BYPASS_TMUX_STATE/send-keys.log" "DIGEST-DIRECT RED-ON-KNOWN-BAD"
[ ! -f "$DIGEST_DIRECT_HOME/spool/dg-c.md" ] && [ ! -f "$DIGEST_DIRECT_HOME/spool/dg-d.md" ] \
  || fail "DIGEST-DIRECT RED-ON-KNOWN-BAD: the override delivered but entries are still in the spool"
echo "spool-redeliver-noncanonical-home: (digest-direct-red-on-known-bad) the same fixture reaches a REAL digest delivery without the guard — the DIGEST-DIRECT-RED refusal above is real: ok"

# ============================================================================
# ARM 5 — Bus.ensureDirs fails LOUDLY when it cannot write the marker (sol
# P1): a bus root that is itself unwritable but whose children were
# pre-provisioned writable must not report bootstrap success while leaving
# the marker unwritten — that strands every future send on this bus with a
# park that succeeds now and a redeliver that refuses forever.
# ============================================================================

UNWRITABLE_HOME="$WORK/unwritable-root/.tap/bus"
mkdir -p "$UNWRITABLE_HOME/payloads" "$UNWRITABLE_HOME/receipts" "$UNWRITABLE_HOME/spool" "$UNWRITABLE_HOME/tmp"
chmod 777 "$UNWRITABLE_HOME/payloads" "$UNWRITABLE_HOME/receipts" "$UNWRITABLE_HOME/spool" "$UNWRITABLE_HOME/tmp"
chmod 555 "$UNWRITABLE_HOME"     # children writable; the ROOT itself is not
unwritable_rc=0
"${TAP_SMOKE_BUN:-bun}" "$ROOT/runtime/bun/test/support/authority-cli.ts" ensure "$UNWRITABLE_HOME" \
  >"$WORK/unwritable.out" 2>"$WORK/unwritable.err" || unwritable_rc=$?
chmod 755 "$UNWRITABLE_HOME" 2>/dev/null || true   # restore before cleanup

if [ "$(id -u)" = "0" ]; then
  echo "spool-redeliver-noncanonical-home: (ARM 5) skipped — running as root, permission denial does not apply"
else
  [ "$unwritable_rc" != 0 ] || fail "(ARM 5) Bus.ensureDirs reported success while its marker write silently failed: stdout=$(cat "$WORK/unwritable.out")"
  [ ! -f "$UNWRITABLE_HOME/.tap-bus-authority" ] || fail "(ARM 5) setup: the marker write should not have been possible on an unwritable root"
  grep -q 'bus_authority_unwritable\|could not write' "$WORK/unwritable.err" \
    || fail "(ARM 5) failure did not name the unwritable marker: $(cat "$WORK/unwritable.err")"
  echo "spool-redeliver-noncanonical-home: (ARM 5) Bus.ensureDirs fails loudly when the bus root cannot accept the authority marker, rather than reporting silent success: ok"
fi

echo "PASS spool-redeliver-noncanonical-home"
