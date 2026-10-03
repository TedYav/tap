#!/usr/bin/env bash
# delivery-window-config.test.sh — tap-7r3fn.20 U1+2. How long a window is:
# built-ins, the [delivery] table, per-seat overrides and their precedence, the
# TAP_AUTOSETTLE_HOLD_SECONDS seam, and every way a config can be wrong.
#
# The through-line: a window is a RATE LIMIT, so nothing here may refuse a send.
# An absent config, malformed TOML, a negative value, a boolean, a string — each
# degrades to the built-in; only an ABSENT RUNTIME refuses, and loudly. The one thing that would
# be worse than a wrong rate limit is no delivery, and these arms pin that.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

# shellcheck source=skills/tap/scripts/smoke/helpers.sh
. "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
# Pin acting-team authority: the root is enrolled as team "tap" and its bus is
# canonical, so the acting team never depends on the checkout's name.
export TAP_INDEX_HOME="$WORK/index"
export TAP_HOME="$WORK/team/.tap/bus"
tap_smoke_enroll_current "$WORK/team" "$TAP_HOME" tap
# tap_driver_config_path reads XDG_CONFIG_HOME and REFUSES a relative one, so the
# sandbox has to be absolute or every arm below would silently take the built-in
# for the wrong reason.
export XDG_CONFIG_HOME="$WORK/config"
CFG="$XDG_CONFIG_HOME/tap/config.toml"
mkdir -p "$(dirname "$CFG")"
# shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
. "$ROOT/skills/tap/scripts/smoke/native-authority-fixture.sh"
# The shell window adapter is gone; this is its argv to the native owner
# (runtime/bun/test/support/delivery-window-cli.ts), acting team resolved the same way.
window_seconds() { # <policy> [<team>] [<handle>] [<reply>]
  local acting team="${2:-}"
  acting="$(spool_team_fixture 2>/dev/null || true)"
  [ -n "$team" ] || team="$acting"
  tap_bun_call digest-window "${3:-window}" ../test/support/delivery-window-cli.ts "${1:-standard}" "$team" "${3:-}" "${4:-expected}" "$acting"
}

fail() { echo "delivery-window-config: FAIL — $*" >&2; exit 1; }
ok()   { echo "  ok   $*"; }
want() { # <expected> <policy> [<team>] [<handle>] -- description is $5
  local exp="$1" got
  got="$(TAP_AUTOSETTLE_HOLD_SECONDS= window_seconds "$2" "${3:-}" "${4:-}" 2>/dev/null)"
  [ "$got" = "$exp" ] || fail "${5:-window} — got '$got', expected '$exp'"
}

# --- 1. no config at all: the built-ins ---------------------------------------
rm -f "$CFG"
want 10 now  "" "" "no config, now"
want 10 standard "" "" "no config, standard rides the short window"
want 10 urgent   "" "" "no config, urgent rides the short window"
want 10 autosettle "" "" "no config, autosettle rides the short window"
want 60 polite "" "" "no config, polite"
ok "with no config: now/standard/urgent/autosettle 10s, polite 60s"

# Numeric strings already pass the shared digit validator; normalize them too.
printf '[delivery]\nnow_window_seconds = "0008"\npolite_window_seconds = "0009"\n' > "$CFG"
want 8 now "" "" "numeric config string is decimal"
want 9 polite "" "" "polite numeric config string is decimal"

# --- 2. the [delivery] table sets the fleet default ---------------------------
cat > "$CFG" <<'TOML'
[delivery]
now_window_seconds = 7
polite_window_seconds = 900
TOML
want 7   now    "" "" "table now"
want 900 polite "" "" "table polite"
ok "[delivery] sets the fleet default for both windows"

# --- 3. a per-seat override beats the table ----------------------------------
cat > "$CFG" <<'TOML'
[delivery]
now_window_seconds = 7
polite_window_seconds = 900

[delivery.overrides."tap/focused"]
now_window_seconds = 45
TOML
want 45  now    tap focused "qualified override"
want 900 polite tap focused "a seat overriding one key keeps the table's other"
want 7   now    tap someone-else "an override does not leak to another seat"
ok "a team-qualified override beats the table, per key, per seat"

# --- 4. a bare handle is acting-team shorthand; qualified wins ----------------
cat > "$CFG" <<'TOML'
[delivery]
now_window_seconds = 7

[delivery.overrides."focused"]
now_window_seconds = 30

[delivery.overrides."tap/focused"]
now_window_seconds = 45
TOML
want 45 now tap   focused "qualified beats bare when both exist"
want 45 now ""    focused "implicit acting team resolves its qualified override before bare"
# THE BARE KEY MAY ONLY ANSWER FOR THE ACTING TEAM (tap in this fixture),
# so an explicitly different team gets the table rather than the shorthand. Sol's R1 finding: handles are team-scoped and collide across teams
# by design, so a bare `"focused"` answering for other/focused as well as
# tap/focused would silently window a seat the operator never named. This arm
# asserted the leak before that review.
want 7  now other focused "a different team does NOT inherit the bare shorthand"
ok "bare handle is shorthand for the acting team only; the qualified key wins where both are written"

# --- 4b. the bare key answers when the send's team IS the acting team --------
# The other half, and the one that keeps the shorthand useful: with no team on
# the send, the acting team is resolved first; with no qualified override,
# lookup falls through to its bare shorthand, as an ordinary same-team park does.
cat > "$CFG" <<'TOML'
[delivery]
now_window_seconds = 7

[delivery.overrides."focused"]
now_window_seconds = 30
TOML
want 30 now "" focused "an unqualified send reaches the bare shorthand"
want 7  now other focused "a foreign team still gets the table"
ok "the shorthand answers an unqualified send and no other"

# --- 5. TAP_AUTOSETTLE_HOLD_SECONDS overrides the SHORT window only ----------
cat > "$CFG" <<'TOML'
[delivery]
now_window_seconds = 7
polite_window_seconds = 900
TOML
got="$(TAP_AUTOSETTLE_HOLD_SECONDS=99999 window_seconds now "" "")"
[ "$got" = 99999 ] || fail "the seam did not override the short window (got '$got')"
got="$(TAP_AUTOSETTLE_HOLD_SECONDS=0 window_seconds standard "" "")"
[ "$got" = 0 ] || fail "0 is a legal window and must survive the seam (got '$got')"
for digits in 08 0008 000; do
  got="$(TAP_AUTOSETTLE_HOLD_SECONDS="$digits" window_seconds standard "" "")"
  expected=8; [ "$digits" = 000 ] && expected=0
  [ "$got" = "$expected" ] || fail "digit-only $digits must resolve as canonical decimal $expected (got '$got')"
done
got="$(TAP_AUTOSETTLE_HOLD_SECONDS=99999 window_seconds polite "" "")"
[ "$got" = 900 ] || fail "the seam leaked into the polite window (got '$got'); it names one class"
got="$(TAP_AUTOSETTLE_HOLD_SECONDS=nonsense window_seconds now "" "")"
[ "$got" = 7 ] || fail "a non-numeric seam value should fall through to config (got '$got')"
ok "TAP_AUTOSETTLE_HOLD_SECONDS overrides the short window, never polite; 0 is legal"

# --- 6. every wrong config degrades to the built-in, and none of them refuse --
degrades() { # <toml> <description>
  printf '%s\n' "$1" > "$CFG"
  local got rc=0
  got="$(TAP_AUTOSETTLE_HOLD_SECONDS= window_seconds now "" "" 2>/dev/null)" || rc=$?
  [ "$rc" = 0 ] || fail "$2 — the reader exited $rc; a window may never refuse a send"
  [ "$got" = 10 ] || fail "$2 — got '$got', expected the built-in 10"
}
degrades 'this is not toml {{{'                              "malformed TOML"
degrades '[delivery]
now_window_seconds = -5'                                      "a negative window"
degrades '[delivery]
now_window_seconds = true'                                    "a boolean (bool is an int in Python)"
degrades '[delivery]
now_window_seconds = "soon"'                                  "a string"
degrades '[delivery]
now_window_seconds = 1.5'                                     "a float"
degrades '[delivery]
polite_window_seconds = 30'                                   "the other key only"
degrades '[roles]
driver = "someone"'                                           "a config with no [delivery] table"
degrades '[delivery]
overrides = "not a table"'                                    "overrides that is not a table"
ok "malformed, negative, boolean, string, float, absent, wrong-shape: all degrade to 10, none refuse"

# --- 7. an unreadable config degrades rather than refusing -------------------
printf '[delivery]\nnow_window_seconds = 7\n' > "$CFG"
chmod 000 "$CFG"
rc=0
got="$(TAP_AUTOSETTLE_HOLD_SECONDS= window_seconds now "" "" 2>/dev/null)" || rc=$?
chmod 644 "$CFG"
[ "$rc" = 0 ] || fail "an unreadable config exited $rc; it must degrade"
[ "$got" = 10 ] || fail "an unreadable config gave '$got', expected the built-in 10"
ok "an unreadable config degrades to the built-in"

# --- 8. a checkout's own ./tap/config.toml may not choose a window -----------
# THE ARM HAS TO PUT A REAL FILE THERE. A first version merely set
# XDG_CONFIG_HOME=relative and asserted the built-in — which passes whether or
# not the refusal exists, because nothing is at that path either way. The hazard
# tap_driver_config_path's absolute-home rule guards is a repository that CARRIES
# `tap/config.toml`, making the window a function of the courier's cwd; so the
# arm builds exactly that and stands in it.
rm -f "$CFG"
PLANT="$WORK/checkout"
mkdir -p "$PLANT/tap"
printf '[delivery]\nnow_window_seconds = 999\n' > "$PLANT/tap/config.toml"
rc=0
got="$(cd "$PLANT" && XDG_CONFIG_HOME=. TAP_AUTOSETTLE_HOLD_SECONDS= window_seconds now "" "" 2>/dev/null)" || rc=$?
[ "$rc" = 0 ] || fail "a relative XDG_CONFIG_HOME exited $rc; it must degrade, never refuse"
[ "$got" = 999 ] && fail "a checkout's own ./tap/config.toml chose the window (999) for a send that merely ran from that directory"
[ "$got" = 10 ] || fail "a relative XDG_CONFIG_HOME gave '$got', expected the built-in 10"
ok "a checkout's own ./tap/config.toml cannot choose the window; the relative home degrades"

# --- 9. a missing runtime is loud, never a silent built-in ---------------------
# The reader is native (runtime/bun/src/digest-window.ts) and Bun always parses
# TOML, so the old "python without tomllib → degrade to the built-in and advise"
# branch no longer exists. The infrastructure failure that CAN still happen is
# the runtime itself being absent, and rule 19 (tap-qa6e2) says an adapter must
# not turn that into a predicate answer: the native window call returns
# nonzero with `runtime_missing` and prints NO window. A caller that read "10"
# here would be delivering on a rate limit nobody computed.
(
  SHIM="$WORK/nobun"; mkdir -p "$SHIM"
  # A PATH with every real directory except the ones holding `bun`.
  NOBUN_PATH="$(printf '%s' "$PATH" | tr ':' '\n' | while IFS= read -r d; do [ -x "$d/bun" ] || printf '%s:' "$d"; done)"
  printf '[delivery]\nnow_window_seconds = 7\n' > "$CFG"
  rc=0; got="$(PATH="$SHIM:${NOBUN_PATH%:}" TAP_SMOKE_BUN=bun TAP_AUTOSETTLE_HOLD_SECONDS= window_seconds now "" "" 2>"$WORK/nobun.err")" || rc=$?
  [ "$rc" != 0 ] || fail "with no bun on PATH the adapter exited 0 — an adapter that answers for a missing runtime is deciding"
  [ -z "$got" ] || fail "with no bun on PATH the adapter printed '$got' — a window nobody computed"
  grep -q 'runtime_missing' "$WORK/nobun.err" || fail "with no bun on PATH the refusal did not name runtime_missing: $(cat "$WORK/nobun.err")"
  # And with the runtime present the same config is read, so the arm above
  # reddened for the right reason.
  got="$(TAP_AUTOSETTLE_HOLD_SECONDS= window_seconds now "" "")"
  [ "$got" = 7 ] || fail "with bun present the config window read '$got', expected 7"
) || exit 1
ok "a missing bun runtime refuses loudly (runtime_missing, no window printed); with bun present the config is read"

echo "delivery-window-config: ok"
