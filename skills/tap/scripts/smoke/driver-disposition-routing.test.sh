#!/usr/bin/env bash
# D5: fixture-door — driver-disposition-routing.test.sh:47-49,124+: the module references here only build or seed fixture state; every assertion is on the surrounding shell behavior, none on the module's own
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
# This fixture exports TMUX (it points the courier at a fake tmux), which is
# exactly what smoke-source-guard-inventory.test.sh sweeps for.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# driver-disposition-routing.test.sh — the courier's driver-preference refusal
# routing, driven end to end (TAP 1.0, tap-49kp6; review gate).
#
# tmux is the only wired driver. The native-driver disposition arms this file
# once carried are retired with the plugin framework; what remains pins that an
# unusable or unwired configured driver refuses with `driver_unavailable` before
# any parking exit, that a legal configuration still parks, and that the
# configuration without a home refuses structurally.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

BUS="$WORK/repo/.tap/bus"; mkdir -p "$BUS/payloads" "$BUS/receipts" "$WORK/repo"
# tap-7r3fn.20: every arm below sends to the SAME seat, and each delivery opens
# that seat's window — so from the second send on, the courier would park inside
# the window instead of reaching the driver disposition each arm exists to test.
# This file is about WHICH DOOR a send goes through and what it does with the
# return code, never about when mail arrives; delivery-window-drain owns that.
# Clearing the clock states that premise instead of inheriting it.
# tap-7r3fn.20: this suite is about DISPOSITION ROUTING, not delivery windows,
# and it sends repeatedly to one seat — so every send after the first would park
# in that seat's window instead of reaching the routing under test. A window of
# zero is the seam that turns it off (ruling 24 keeps this variable overriding
# the short window), and it says so without knowing where the clock is stored:
# an earlier version cleared `$BUS/delivery` by hand, which put this fixture's
# correctness at the mercy of a storage layout it has no reason to know.
export TAP_AUTOSETTLE_HOLD_SECONDS=0
# This fixture asserts durable parking, not background delivery. Do not let
# detached waiters outlive the temporary tree and its fake tmux.
export TAP_SPOOL_DISABLE_DELIVERER=1
export TAP_HOME="$BUS"
XDG_CONFIG_HOME="$WORK/config"; export XDG_CONFIG_HOME
mkdir -p "$XDG_CONFIG_HOME/tap"
# THE COURIER RUNS FROM A COPY OF THE TREE, so no arm reaches the live checkout.
TREE="$WORK/tree"; mkdir -p "$TREE"
cp -R "$ROOT/scripts" "$TREE/scripts"
mkdir -p "$TREE/skills"; cp -R "$ROOT/skills/tap" "$TREE/skills/tap"
mkdir -p "$TREE/runtime/bun"; cp -R "$ROOT/runtime/bun/src" "$TREE/runtime/bun/src"
# fzf-tool.ts imports ../../../vendor/fzf/manifest.json relative to the copied src.
mkdir -p "$TREE/vendor/fzf"; cp "$ROOT/vendor/fzf/manifest.json" "$TREE/vendor/fzf/manifest.json"
# scripts/tap.sh enters through bin/tap and the Bun router, so the copy
# carries both; the router's Bash fallback resolves to the copy's tap.sh.
cp -R "$ROOT/bin" "$TREE/bin"; cp "$ROOT/runtime/bun/main.ts" "$TREE/runtime/bun/main.ts"
# The courier under test is the COPY.
TAP="$TREE/scripts/tap.sh"


fail() { echo "driver-disposition-routing: $*" >&2; exit 1; }

cat > "$BUS/registry.json" <<JSON
{ "schema": "0.20", "team": { "name": "t", "worktree_root": "$WORK/repo" },
  "seats": {
    "lead":   { "pane": "sess:0.0", "pane_id": "%1001", "session": "sess", "server_epoch": "srv:4242:100", "harness": "codex", "status": "active", "registered_from_worktree": "$WORK/repo" },
    "sender": { "pane": "sess:0.1", "pane_id": "%1002", "session": "sess", "server_epoch": "srv:4242:100", "harness": "codex", "status": "active", "registered_from_worktree": "$WORK/repo" }
  } }
JSON

# Minimal fake tmux: enough for the courier's identity and pane checks to pass,
# so the run reaches the delivery hop. The DRIVER decides the outcome here, not
# the pane — that is the whole point of the seam under test.
FAKE_BIN="$WORK/bin"; mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/tmux" <<'ENDTMUX'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; shift || true
case "$cmd" in
  list-sessions) printf 'sess\t4242:100\n' ;;
  list-panes)
    printf 'sess\tsess:0.0\t%%1001\tcodex\t4242\t4242:100\t0\n'
    printf 'sess\tsess:0.1\t%%1002\tcodex\t4242\t4242:100\t0\n' ;;
  display-message)
    fmt=""; target=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -p) shift ;;
        -t) target="${2:-}"; shift 2 ;;
        *)  fmt="$1"; shift ;;
      esac
    done
    # Substitute every #{field} the caller asks for, so the native door's
    # compound identity formats read as consistently as the Bash courier's
    # single-field ones; an unknown field reads empty.
    case "$target" in *0.0|%1001) pid_='%1001' ;; *) pid_='%1002' ;; esac
    out="$fmt"
    out="${out//'#{pane_id}'/$pid_}"
    out="${out//'#{session_name}'/sess}"
    out="${out//'#{pid}'/4242}"
    out="${out//'#{start_time}'/100}"
    out="${out//'#{pane_pid}'/4242}"
    out="${out//'#{pane_dead}'/0}"
    out="${out//'#{pane_in_mode}'/${TAP_FAKE_IN_MODE:-0}}"
    out="${out//'#{pane_current_command}'/codex}"
    out="${out//'#{pane_dead}'/0}"
    printf '%s\n' "$out" | sed 's/#{[^}]*}//g' ;;
  capture-pane) printf '› \n' ;;
  send-keys) : ;;
esac
ENDTMUX
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket"

body="$WORK/body.md"
printf 'hello\n' > "$body"

# --- (h) an unresolvable driver refuses loudly --------------------------------
# tmux is the only wired driver, so any other configured value must refuse with
# the structured class rather than silently delivering through tmux.
cat > "$XDG_CONFIG_HOME/tap/config.toml" <<'ENDCFG'
[harness.codex]
driver = "nosuchdriveratall"
ENDCFG
rc=0
"$TAP" send lead --ask -f "$body" --from sender --id disp-4 --json >"$WORK/out4" 2>"$WORK/err4" || rc="$?"
[ "$rc" = "1" ] || fail "(h) an unresolvable driver did not refuse; rc=$rc"
grep -q 'driver_unavailable' "$WORK/out4" "$WORK/err4" \
  || fail "(h) an unresolvable driver did not name its class: $(cat "$WORK/out4" "$WORK/err4")"
echo "driver-disposition-routing: (h) an unresolvable driver still refuses loudly: ok"

# --- (pol) a parking exit cannot smuggle an unwired driver past the refusal ---
# Review finding. Every parking exit -- --polite, the clearing fence, the
# pending-input grace, auto-settle -- returns BEFORE the delivery hop, which is
# where driver resolution used to live. A seat configured with an unwired driver
# therefore QUEUED SUCCESSFULLY, and the drain path does not go through the
# dispatcher at all, so the message later left through tmux with the loud
# refusal never emitted. The refusal has to precede parking, not delivery.
cat > "$XDG_CONFIG_HOME/tap/config.toml" <<'ENDCFG'
[harness.codex]
driver = "nosuchdoor"
ENDCFG
printf 'hello\n' > "$WORK/pol-body.md"
# EVERY pre-dispatch parking exit, not just --polite. sol-ponytail raised this to
# P1 after an API-contract review corroborated it: copy-mode, pending-input,
# clearing, polite and auto-settle can ALL return queued success for an unwired
# driver and then redeliver through tmux. An arm covering one of them would have
# left the class open while looking like it closed it.
pol_case() { # <label> <extra-send-arg> <env-prefix-var> <env-prefix-val>
  local label="$1" arg="$2" evar="$3" eval_="$4" rc=0
  rm -f "$BUS/spool/pol-$label.md" "$BUS/spool/pol-$label.meta.json"
  if [ -n "$evar" ]; then
    env "$evar=$eval_" "$TAP" send lead --ask -f "$WORK/pol-body.md" --from sender \
      --id "pol-$label" $arg --json >"$WORK/pol-out" 2>"$WORK/pol-err" || rc="$?"
  else
    "$TAP" send lead --ask -f "$WORK/pol-body.md" --from sender \
      --id "pol-$label" $arg --json >"$WORK/pol-out" 2>"$WORK/pol-err" || rc="$?"
  fi
  [ "$rc" != 0 ] || \
    fail "(pol-$label) an unwired driver SUCCEEDED through a parking exit; the message is queued and will drain through tmux, which is the silent wrong-door delivery this preference exists to prevent"
  [ ! -f "$BUS/spool/pol-$label.md" ] && [ ! -f "$BUS/spool/pol-$label.meta.json" ] || \
    fail "(pol-$label) the message was PARKED despite an unusable driver; a refusal after parking is not a refusal
  spool: $(ls -A "$BUS/spool" 2>/dev/null | tr '\n' ' ')"
  # ASSERT THE EXACT MACHINE CONTRACT, not the presence of the word "driver".
  # The first version grepped for the word and passed against a NEW error class
  # invented at this call site (`driver_unresolvable`), which would have made the
  # same bad preference return different contracts depending on whether the send
  # happened to park -- a programmatic caller would have needed to know about the
  # parking exits to handle one error (review finding). A grep for prose
  # cannot see a contract change; only the class can.
  grep -q '"error_class":"driver_unavailable"' "$WORK/pol-out" || \
    fail "(pol-$label) refusal did not carry error_class=driver_unavailable, the same class the delivery hop returns
  stdout: $(cat "$WORK/pol-out")
  stderr: $(cat "$WORK/pol-err")"
  return 0
}
pol_case polite   --polite      ""                 ""
pol_case urgent   --urgent      ""                 ""
pol_case copymode ""            TAP_FAKE_IN_MODE   1
pol_case plain    ""            ""                 ""
echo "driver-disposition-routing: (pol) every pre-dispatch parking exit refuses an unwired driver instead of parking it: ok"

# MIRROR: --polite with a USABLE configuration still parks. Bounds the fix so it
# cannot turn every polite send into a refusal.
cat > "$XDG_CONFIG_HOME/tap/config.toml" <<'ENDCFG'
[harness.codex]
driver = "tmux"
ENDCFG
_pol2_rc=0
"$TAP" send lead --ask -f "$WORK/pol-body.md" --from sender --id pol-2 --polite --json \
  >"$WORK/pol2-out" 2>"$WORK/pol2-err" || _pol2_rc="$?"
[ "$_pol2_rc" = 0 ] || \
  fail "(pol-mirror) --polite with a legal driver was refused (rc=$_pol2_rc): $(cat "$WORK/pol2-out" "$WORK/pol2-err")"
[ -f "$BUS/spool/pol-2.md" ] || \
  fail "(pol-mirror) --polite with a legal driver did not park the message"
echo "driver-disposition-routing: (pol-mirror) --polite still parks a legal send: ok"
rm -f "$WORK/pol"*
rm -f "$BUS/spool/pol-2.md" "$BUS/spool/pol-2.meta.json"


# The (adv) arms that pinned the Bash courier's parserless-config advisory (a
# python3 without tomllib) are retired: scripts/tap.sh now enters the native
# router, which reads config.toml in Bun, so no parser can be missing.


# --- (nohome) no config location refuses structurally, before placement -------
# THIS ARM PINS EXISTING BEHAVIOR. It is not a fix for a defect, and an earlier
# version of this header said it was -- claiming that
# `${XDG_CONFIG_HOME:-$HOME/.config}` aborts under `set -u` after canonical
# placement, leaving no structured refusal and an orphan canonical. Both halves
# were disproved, by sol-ponytail's real-path probe and by this arm PASSING
# against unmodified code, and both reviewers caught the header still telling the
# disproved story after the code site had been corrected.
#
# What actually happens: the nounset error fires INSIDE the config-path command
# substitution, so it fails the substitution rather than killing the courier. The
# nonzero is caught by tap_driver_for_harness, the PANE_CMD preflight maps it to
# exit 1 with error_class=driver_unavailable, and all of that precedes
# tap_send_place_canonical -- so there is no orphan to leave.
#
# The bound this arm therefore holds, against a future refactor that moves
# placement earlier or stops catching the substitution failure: a structured
# refusal, and no canonical. Driven through the real courier because both
# properties are the courier's, not the resolver's.
printf 'hello\n' > "$WORK/nh-body.md"   # own body: an earlier arm removes $WORK/pol*
_nh_before="$(find "$BUS/payloads" -maxdepth 1 -name 'nohome-1*' 2>/dev/null | wc -l | tr -d ' ')"
_nh_rc=0
env -u HOME -u XDG_CONFIG_HOME "$TAP" send lead --ask -f "$WORK/nh-body.md" --from sender \
  --id nohome-1 --json >"$WORK/nh-out" 2>"$WORK/nh-err" || _nh_rc="$?"
[ "$_nh_rc" != 0 ] || fail "(nohome) a send with no config location SUCCEEDED"
grep -q '"error_class":"driver_unavailable"' "$WORK/nh-out" || \
  fail "(nohome) refused without error_class=driver_unavailable
  rc: $_nh_rc
  stdout: $(cat "$WORK/nh-out")
  stderr: $(cat "$WORK/nh-err")"
_nh_after="$(find "$BUS/payloads" -maxdepth 1 -name 'nohome-1*' 2>/dev/null | wc -l | tr -d ' ')"
[ "$_nh_after" = "$_nh_before" ] || \
  fail "(nohome) the refusal left an orphan canonical behind ($_nh_before -> $_nh_after)"
echo "driver-disposition-routing: (nohome) no config location refuses with the structured class and no orphan: ok"

echo "driver-disposition-routing: ok"
