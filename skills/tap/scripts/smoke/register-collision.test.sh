#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# register-collision.test.sh — three fixes to tap register/unregister:
#   (1) bare `register` auto-derives the handle from the tmux session name
#       (skips bare-numeric defaults like "174").
#   (2) registering a handle already active on a DIFFERENT LIVE pane is refused
#       (exit 3) unless --force; a dead/stale pane is silently reclaimed.
#   (3) `tap unregister [<name>]` removes the entry (idempotent).
# Plus the seat-dedup cases (5e-5i): one PANE owns one handle, and a relaunched
# seat reclaims the DEAD prior handle it held in its own session (tap-e9h) — while
# a LIVE distinct pane in the same session is always kept (tap-2cr crew), and a
# dead handle in ANOTHER session is never released.
# Pure fake-tmux: pane_id for `-t <target>` is "%<target>"; a target listed in
# FAKE_DEAD_PANES exits 1 (pane gone). Session name comes from FAKE_SESSION.
set -euo pipefail

# Mock-tmux smoke: the courier's real-TUI settle sleeps verify nothing against
# a synchronous mock — scale them down (smoke-speed PR2; default 1 in production).
export TAP_TUI_SETTLE_SCALE=0.1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# shellcheck source=helpers.sh
. "$ROOT/skills/tap/scripts/smoke/helpers.sh"
# shellcheck source=sandbox-pins.sh
# tap-ea3z walk: pin machine-resolved state (session manifest, opencode db,
# version-seen) for directly invoked bodies — defense-in-depth; enrollment
# itself is unindexable-by-design for custom TAP_HOME (see the PR's framing).
. "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"
TAP_HOME="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$TAP_HOME" "$FAKE_BIN"' EXIT
export TAP_HOME PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket"
export TAP_BOOT_ID="boot:424242"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"

cat > "$FAKE_BIN/ps" <<'ENDPS'
#!/usr/bin/env bash
printf '1 faketty\n'
ENDPS
chmod +x "$FAKE_BIN/ps"

cat > "$FAKE_BIN/tmux" <<'ENDTMUX'
#!/usr/bin/env bash
set -euo pipefail
caller_target="${FAKE_SESSION:-alpha}:0.0"
# Pane ids follow the real tmux grammar (%<digits>): '%' + first cksum field
# of the target (see the MAPPING RULE below) — a malformed pane id is a native
# refusal, not a world.
caller_pane_id="%$(printf '%s' "$caller_target" | cksum | cut -d' ' -f1)"
STATE="${FAKE_TMUX_STATE:-$TAP_HOME/fake-tmux}"
mkdir -p "$STATE"
[ -e "$STATE/panes" ] || : > "$STATE/panes"
grep -qxF "$caller_target" "$STATE/panes" 2>/dev/null || printf '%s\n' "$caller_target" >> "$STATE/panes"
# tap-bzyz: one TTY source per pane; both tmux queries derive from it.
tty_for() {
  [ -n "$1" ] || return 1
  if [ "$1" = "$caller_target" ] || [ "$1" = "$caller_pane_id" ]; then
    printf '/dev/faketty'
  else
    printf '/dev/faketty-%s' "$(printf '%s' "$1" | cksum | cut -d' ' -f1)"
  fi
}
sess_for() { local s="${1#%}"; printf '%s' "${s%%:*}"; }
addr_for() { printf '%s' "${1#%}"; }
id_for() {
  local pair
  for pair in ${FAKE_PANE_REMAP:-}; do
    case "$pair" in "$1="*) printf '%s' "${pair#*=}"; return ;; esac
  done
  case "$1" in %*) printf '%s' "$1" ;; *) printf '%%%s' "$(printf '%s' "$1" | cksum | cut -d' ' -f1)" ;; esac
}
pane_alive() {
  local t="$1"
  [ "$t" = "$caller_target" ] && return 0
  case " ${FAKE_DEAD_PANES:-} " in *" $t "*) return 1 ;; esac
  return 0
}
[ "${1:-}" = "list-panes" ] && {
  shift || true
  fmt=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -p) shift ;;
      -a) shift ;;
      -t) shift 2 ;;
      -F) fmt="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  case "$fmt" in
    # observeCallingPane inventory: pane_id + tty for the caller.
    *pane_tty*) printf '%s\t%s\n' "$caller_pane_id" "$(tty_for "$caller_target")" ;;
    # Chooser world: 6-field records for every live pane the fixture has seen.
    *)
      printf '%s\t%s\t%s\t%s\t%s\t%s\t0\n' "$(sess_for "$caller_target")" "$(addr_for "$caller_target")" "$caller_pane_id" "${FAKE_HARNESS:-codex}" 4242 "${FAKE_EPOCH_RAW-4242:100}"
      while IFS= read -r t; do
        [ -n "$t" ] || continue
        case "$t" in %*) continue ;; esac
        [ "$t" = "$caller_target" ] && continue
        pane_alive "$t" || continue
        printf '%s\t%s\t%s\t%s\t%s\t%s\t0\n' "$(sess_for "$t")" "$(addr_for "$t")" "$(id_for "$t")" "${FAKE_HARNESS:-codex}" 4242 "${FAKE_EPOCH_RAW-4242:100}"
      done < "$STATE/panes"
      ;;
  esac
  exit 0
}
[ "${1:-}" = "list-sessions" ] && {
  if [ -n "${FAKE_LIST_SESSIONS_FAIL:-}" ]; then
    echo "session snapshot unavailable" >&2
    exit 1
  fi
  for session in ${FAKE_LIVE_SESSIONS:-}; do printf '%s\t%s\t1\n' "$session" "${FAKE_EPOCH_RAW-4242:100}"; done
  exit 0
}
[ "${1:-}" = "display-message" ] || exit 0
shift
target=""; fmt=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p) shift ;;
    -t) target="$2"; shift 2 ;;
    *)  fmt="$1"; shift ;;
  esac
done
# A dead pane fails every query the way real classic tmux does: nonzero WITH
# the can't-find reply on stderr (the error IS the server answering "not
# there" — a silent exit 1 would read as a failed probe, which is correctly
# UNOBSERVABLE, not absence). Only meaningful when a -t target is given.
if [ -n "$target" ]; then
  case " ${FAKE_DEAD_PANES:-} " in *" $target "*) echo "can't find pane: $target" >&2; exit 1 ;; esac
fi
# FAKE_MALFORMED_TARGET: probes of exactly this target answer rc 0 with the
# FAKE_MALFORMED_OUTPUT literal — a garbled record frame (sol r4). Scoped to
# one target so the rest of the registration (own-pane probes) stays normal.
if [ -n "${FAKE_MALFORMED_TARGET:-}" ] && [ "$target" = "$FAKE_MALFORMED_TARGET" ]; then
  printf '%s\n' "${FAKE_MALFORMED_OUTPUT-}"
  exit 0
fi
# Learned world: every observed target joins the chooser inventory (dead panes
# stay out via the pane_alive filter in list-panes).
if [ -n "$target" ]; then
  grep -qxF "$target" "$STATE/panes" 2>/dev/null || printf '%s\n' "$target" >> "$STATE/panes"
fi
# A target is either "session:window.pane" or a pane-id "%sess:win.pane". pane_id is
# the target with a single leading '%'; session is the part before the first ':' with
# any leading '%' stripped — so querying by pane-id or by session target resolves the
# SAME session (as real tmux does). A colon-less target is its own single-pane session.
# FAKE_PANE_REMAP: space-separated "target=%id" pairs — lets a fixture stage a
# RECYCLED address honestly (the address resolves to a DIFFERENT pane id than
# the one that died there), which the default derivation cannot express when
# the address is unchanged.
# MAPPING RULE (id provenance, spot-checkable without executing): the pane id
# for a non-%-target T is '%' + the first field of `cksum` over T — stable
# decimal digits per target, satisfying the real tmux pane-id grammar
# (%<digits>). A %-prefixed target is already a pane id (only ever one this
# derivation minted) and resolves to itself, as real tmux does. The smoke's
# fake_pid() helper mirrors this rule for assertions.
tpid()  {
  id_for "$target"
}
# Real tmux resolves a pane-id query to the pane's REAL session name, not the
# id digits: invert the deterministic id mapping back to its origin target and
# read the session from that.
origin_for() {
  local id="$1" t i
  [ "$id" = "$caller_pane_id" ] && { printf '%s' "$caller_target"; return 0; }
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    case "$t" in
      %*) [ "$t" = "$id" ] && { printf '%s' "$t"; return 0; } ;;
      *)
        i="%$(printf '%s' "$t" | cksum | cut -d' ' -f1)"
        [ "$i" = "$id" ] && { printf '%s' "$t"; return 0; }
        ;;
    esac
  done < "$STATE/panes"
  return 1
}
tsess() {
  local o s
  case "$target" in
    %*) o="$(origin_for "$target" 2>/dev/null || printf '%s' "$target")"; s="${o#%}" ;;
    *)  s="${target#%}" ;;
  esac
  printf '%s' "${s%%:*}"
}
case "$fmt" in
  # Bun's combined nine-field caller record — precedes the pane globs.
  *pane_id*pane_tty*session_name*socket_path*pane_current_path*)
    if [ -n "$target" ]; then printf '%s\t%s\t%s\t%s\t%s\t4242\t%s\t%s\t%s\n' "$(tpid)" "$(tty_for "$target")" "$(tsess)" "${FAKE_EPOCH_RAW-4242:100}" "$(tsess):0.0" "${FAKE_HARNESS:-codex}" "$(python3 -B -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "${TMUX%%,*}")" "${FAKE_TMUX_PATH:-$PWD}";
    else printf '%s\t%s\t%s\t%s\t%s\t4242\t%s\t%s\t%s\n' "$caller_pane_id" "$(tty_for "$caller_target")" "${FAKE_SESSION:-alpha}" "${FAKE_EPOCH_RAW-4242:100}" "$caller_target" "${FAKE_HARNESS:-codex}" "$(python3 -B -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "${TMUX%%,*}")" "${FAKE_TMUX_PATH:-$PWD}"; fi ;;
  # Bun's combined eight-field pane record.
  *pane_id*session_name*pane_pid*pane_current_command*socket_path*)
    if [ -n "$target" ]; then printf '%s\t%s\t4242\t%s\t0\t%s\t%s\t%s\n' "$(tpid)" "$(tsess)" "${FAKE_HARNESS:-codex}" "$(tsess):0.0" "$(python3 -B -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "${TMUX%%,*}")" "${FAKE_TMUX_PATH:-$PWD}";
    else printf '%s\t%s\t4242\t%s\t0\t%s\t%s\t%s\n' "$caller_pane_id" "${FAKE_SESSION:-alpha}" "${FAKE_HARNESS:-codex}" "$caller_target" "$(python3 -B -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "${TMUX%%,*}")" "${FAKE_TMUX_PATH:-$PWD}"; fi ;;
  # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
  *pane_id*pane_tty*session_name*) if [ -n "$target" ]; then printf '%s\t%s\t%s\t%s\n' "$(tpid)" "$(tty_for "$target")" "$(tsess)" "${FAKE_EPOCH_RAW-4242:100}"; else printf '%s\t%s\t%s\t%s\n' "$caller_pane_id" "$(tty_for "$caller_target")" "${FAKE_SESSION:-alpha}" "${FAKE_EPOCH_RAW-4242:100}"; fi ;;
  *pane_id*session_name*start_time*)
    if [ -n "$target" ]; then printf '%s\t%s\t%s\n' "$(tpid)" "$(tsess)" "${FAKE_EPOCH_RAW-4242:100}"; else printf '%s\t%s\t%s\n' "$caller_pane_id" "${FAKE_SESSION:-alpha}" "${FAKE_EPOCH_RAW-4242:100}"; fi ;;
  # Observe-pane probe (tmux.ts observePaneResult): exactly five fields.
  *pane_id*session_name*pane_pid*pane_current_command*)
    if [ -n "$target" ]; then printf '%s\t%s\t4242\t%s\t0\n' "$(tpid)" "$(tsess)" "${FAKE_HARNESS:-codex}"; else printf '%s\t%s\t4242\t%s\t0\n' "$caller_pane_id" "${FAKE_SESSION:-alpha}" "${FAKE_HARNESS:-codex}"; fi ;;
  *pane_id*session_name*)  # combined "pane_id<TAB>session_name" (collision probe)
    if [ -n "$target" ]; then printf '%s\t%s\n' "$(tpid)" "$(tsess)"; else printf '%s\t%s\n' "$caller_pane_id" "${FAKE_SESSION:-alpha}"; fi ;;
  *pane_id*pane_tty*)
    if [ -n "$target" ]; then printf '%s\t%s\n' "$(tpid)" "$(tty_for "$target")"; else echo ""; fi ;;
  *window_index*)         echo "${FAKE_SESSION:-alpha}:0.0" ;;   # combined self target
  *session_name*)         if [ -n "$target" ]; then tsess; echo; else echo "${FAKE_SESSION:-alpha}"; fi ;;
  *pane_id*)              if [ -n "$target" ]; then tpid; echo; else printf '%s\n' "$caller_pane_id"; fi ;;
  # Server identity + socket fingerprint probes (untargeted; must come after
  # the pane_id arms — the four-field fmt embeds pid:start_time).
  *pid*start_time*)       printf '%s\n' "${FAKE_EPOCH_RAW-4242:100}" ;;
  *socket_path*)          python3 -B -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "${TMUX%%,*}" ;;
  *pane_pid*)             echo "4242" ;;
  *pane_current_command*) echo "${FAKE_HARNESS:-codex}" ;;
  *pane_current_path*)    echo "${FAKE_TMUX_PATH:-$PWD}" ;;
  *) echo "" ;;
esac
ENDTMUX
chmod +x "$FAKE_BIN/tmux"
# Mirror of the fake's tpid MAPPING RULE for assertions: pane id for target T
# is '%' + first cksum field of T.
fake_pid() { printf '%%%s' "$(printf '%s' "$1" | cksum | cut -d' ' -f1)"; }
REAL_PYTHON="$(command -v python3)"
cat > "$FAKE_BIN/python3" <<ENDPY
#!/usr/bin/env bash
set -euo pipefail
if [ -n "\${FAKE_PYTHON_WAIT_ARG:-}" ]; then
  for arg in "\$@"; do
    if [ "\$arg" = "\$FAKE_PYTHON_WAIT_ARG" ]; then
      : > "\${FAKE_PYTHON_READY:?}"
      _wait_deadline=\$((SECONDS + 300))
      while [ ! -e "\${FAKE_PYTHON_RELEASE:?}" ]; do
        [ "\$SECONDS" -lt "\$_wait_deadline" ] || exit 98
        sleep 0.05
      done
      break
    fi
  done
fi
exec "$REAL_PYTHON" "\$@"
ENDPY
chmod +x "$FAKE_BIN/python3"
export FAKE_TMUX_PATH="$ROOT"

field() { python3 -B - "$TAP_HOME/registry.json" "$1" "$2" <<'PY'
import json, sys
try: reg = json.load(open(sys.argv[1]))
except Exception: print(""); sys.exit(0)
print(((reg.get("seats") or reg.get("agents") or {}).get(sys.argv[2]) or {}).get(sys.argv[3], ""))
PY
}
has_agent() { python3 -B - "$TAP_HOME/registry.json" "$1" <<'PY'
import json, sys
try: reg = json.load(open(sys.argv[1]))
except Exception: sys.exit(1)
sys.exit(0 if sys.argv[2] in (reg.get("seats") or reg.get("agents") or {}) else 1)
PY
}

team_name() { python3 -B - "$TAP_HOME/registry.json" <<'PY'
import json, sys
try: reg = json.load(open(sys.argv[1]))
except Exception: print(""); sys.exit(0)
print((reg.get("team") or {}).get("name", ""))
PY
}
# The team is the worktree; derivation strips the worktree-basename prefix.
TEAM="$(basename "$(git -C "$ROOT" rev-parse --show-toplevel)")"
FIXTURE_ROOT="$TAP_HOME/worktree/$TEAM"
mkdir -p "$FIXTURE_ROOT"
git -C "$FIXTURE_ROOT" init -q
export FAKE_TMUX_PATH="$FIXTURE_ROOT"
tap_smoke_enroll_current "$FIXTURE_ROOT" "$TAP_HOME"
cd "$FIXTURE_ROOT"

# ── 1. bare register derives a SHORT, team-local handle from the session name ──
FAKE_SESSION="${TEAM}-claude-0" tap_smoke_quiet "$TAP" register
has_agent "claude" || { echo "collision: bare register did not derive short handle 'claude'" >&2; exit 1; }
has_agent "${TEAM}-claude-0" && { echo "collision: handle should be short 'claude', not the full session name" >&2; exit 1; }
[ "$(team_name)" = "$TEAM" ] || { echo "collision: team.name not recorded (got '$(team_name)', want '$TEAM')" >&2; exit 1; }
[ "$(field claude boot_id)" = "$TAP_BOOT_ID" ] || { echo "collision: active register did not stamp the observed machine boot" >&2; exit 1; }
echo "collision: 1/5 — bare register -> short team-local handle 'claude', team.name recorded: ok"

# ── 2. bare-numeric session name is NOT usable → fail with guidance ───────────
# tap-zty8 exemption: expected numeric-session-name refusal.
# tap-2al3d: a numeric session falls back to the pane's observed harness
# family, and this fake tmux reports a harness (codex) unless FAKE_HARNESS says
# otherwise, so the refusal is asserted for a shell pane; the harness-family
# derivation is pinned in bare-tmux-registration.test.ts.
if FAKE_SESSION="174" FAKE_HARNESS="zsh" "$TAP" register >/dev/null 2>&1; then
  echo "collision: numeric session name should not derive a handle" >&2; exit 1
fi
echo "collision: 2/5 — bare-numeric session name on a shell pane rejected (needs explicit name): ok"

# ── 3. collision: same handle on a DIFFERENT LIVE pane → auto-suffix ──────────
"$TAP" unregister claude >/dev/null 2>&1   # clear the handle derived in test 1 for a clean slate
tap_smoke_quiet "$TAP" register claude --pane paneA
[ "$(field claude pane_id)" = "$(fake_pid paneA)" ] || { echo "collision: claude not on %paneA" >&2; exit 1; }
# paneA is alive → registering claude on paneB must SUCCEED as 'claude-2', leaving claude untouched.
_w3="$("$TAP" register claude --pane paneB 2>&1 >/dev/null)" || { echo "collision: auto-suffix register failed" >&2; exit 1; }
# The live-pane wording must still fire where it is TRUE, or the tag that
# distinguishes it from a poll incumbent is unwired and the generic default
# quietly covers this case (tap-hgzj).
case "$_w3" in
  *"held by a live pane"*) : ;;
  *) echo "collision: a genuine live-pane collision no longer says so: $_w3" >&2; exit 1 ;;
esac
[ "$(field claude pane_id)" = "$(fake_pid paneA)" ] || { echo "collision: original claude was clobbered" >&2; exit 1; }
[ "$(field claude-2 pane_id)" = "$(fake_pid paneB)" ] || { echo "collision: newcomer not registered as claude-2 (got '$(field claude-2 pane_id)')" >&2; exit 1; }
echo "collision: 3/5 — live-handle collision auto-suffixes to claude-2, original intact: ok"

# ── 3b. --force reclaims the EXACT handle; a true corpse reclaims with no suffix ──
tap_smoke_quiet "$TAP" register claude --pane paneC --force
[ "$(field claude pane_id)" = "$(fake_pid paneC)" ] || { echo "collision: --force did not reclaim exact handle" >&2; exit 1; }
# claude now on %paneC. A corpse is identity AND address both gone (tap-bau): mark
# the pane_id and the recorded address dead; registering claude on paneD then
# reclaims 'claude' with no suffix.
FAKE_DEAD_PANES="$(fake_pid paneC) paneC" tap_smoke_quiet "$TAP" register claude --pane paneD || { echo "collision: dead-pane reclaim failed" >&2; exit 1; }
[ "$(field claude pane_id)" = "$(fake_pid paneD)" ] || { echo "collision: dead reclaim should keep short 'claude' on %paneD (got '$(field claude pane_id)')" >&2; exit 1; }
echo "collision: 4/5 — --force reclaims exact handle; dead identity+address reclaims with no suffix: ok"

# ── 4. unregister removes the entry; idempotent second call ──────────────────
"$TAP" unregister claude >/dev/null 2>&1
has_agent claude && { echo "collision: unregister did not remove claude" >&2; exit 1; }
out="$("$TAP" unregister claude 2>&1)"; grep -qi "not registered\|nothing to remove" <<<"$out" || { echo "collision: unregister not idempotent (got: $out)" >&2; exit 1; }
echo "collision: 5/5 — unregister removes entry, idempotent when absent: ok"

# ── tap-52ys: arms 5b-6b removed (ratified 2026-08-14) ────────────────────────
# This file was 25 arms and 99 `tap` invocations — ~60s of its 102s was process
# startup, not testing. The five arms above are handle-collision itself: derive,
# suffix on a live collision, reclaim by force, reclaim a dead identity, and
# unregister. What was cut was 20 permutations of WHICH session/pane shape the
# incumbent had (5d1-5d8, 5e-5j) plus the concurrent-register races (6, 6b).
#
# The cut's coverage debt has since been partly repaid: arms 6b A-D below pin
# the four chooser directions the collision ladder must distinguish — a
# recycled address answered by a different live pane (A), a dead pane
# restarting inside its recorded live session (B), a dead pane whose recorded
# session is still live elsewhere (C, Amendment 13), and an unobservable
# snapshot failing closed (D). Still intentionally omitted: the broader
# removed permutation/concurrency matrix (5d1-5d8, 5e-5j, races 6/6b). The
# narrower identity witnesses survive in the gate — caller-pane-tty-binding
# (caller TTY -> pane binding), communication-identity arm 3 (stored vs live
# pane mismatch fails closed), and effect-guard-observes-fresh (re-read at the
# point of effect) — but they are not a substitute for the incumbent-shape
# matrix, and the concurrent-register arms were a flake magnet besides (grok's
# call).

# ── 6. a POLL incumbent must not be described as a live pane (tap-hgzj) ──────
# The suffix warning existed and named --force; it also asserted the incumbent
# was "held by a live pane". For a poll row that is FALSE — a poll seat has no
# pane at all — and the seat that hit this on 2026-08-19 repeated the warning's
# model back verbatim ("-2 because the frozen pane held the handle") while the
# real incumbent was a pane-less mailbox holding the address every other seat
# was writing to. A remedy that misdescribes the situation teaches a wrong
# model of what just happened, which is worse than silence: the reader stops
# looking.
tap_smoke_quiet "$TAP" register pollster --delivery poll
warn="$(FAKE_SESSION="${TEAM}-pollster-0" "$TAP" register 2>&1 >/dev/null || true)"
has_agent "pollster-2" || { echo "collision: derived register did not suffix past the poll incumbent" >&2; exit 1; }
[ "$(field pollster delivery)" = poll ] || { echo "collision: poll incumbent was clobbered" >&2; exit 1; }
case "$warn" in
  *"live pane"*) echo "collision: poll incumbent described as a live pane: $warn" >&2; exit 1 ;;
esac
case "$warn" in
  *poll*) : ;;
  *) echo "collision: warning does not say the incumbent is a poll seat: $warn" >&2; exit 1 ;;
esac
case "$warn" in
  *"tap in pollster"*|*--force*) : ;;
  *) echo "collision: warning names no way to reclaim the address: $warn" >&2; exit 1 ;;
esac
echo "collision: 6/6 — a poll incumbent is named as one, with a cure that reclaims the address: ok"

# ── 6b. tap-vujp: a recycled address is named honestly; the three chooser
# directions are pinned ────────────────────────────────────────────────────────
# A stages the recycle honestly (FAKE_PANE_REMAP: the address now resolves to a
# DIFFERENT live pane id than the one that died there): the suffix warning must
# describe the address, not claim a live pane holds the handle. B pins the
# dead-pane same-session reclaim (the `tap clear` restart fallback, tap-eb9h),
# C pins Amendment 13's different-live-session suffix, D pins the
# unobservable-snapshot fail-closed. Mock knobs only; no new fixture.

# A: recycled address, newcomer elsewhere → suffix with the honest warning.
# Arm 3 left claude-2 holding paneB; free it so the newcomer's pane is clear.
"$TAP" unregister claude-2 >/dev/null 2>&1 || true
tap_smoke_quiet "$TAP" register h1 --pane paneA
_wA="$(FAKE_DEAD_PANES="$(fake_pid paneA)" FAKE_PANE_REMAP="paneA=%777" "$TAP" register h1 --pane paneB 2>&1 >/dev/null)" || { echo "collision: recycled-address register failed" >&2; exit 1; }
has_agent h1-2 || { echo "collision: recycled address did not suffix to h1-2" >&2; exit 1; }
[ "$(field h1-2 pane_id)" = "$(fake_pid paneB)" ] || { echo "collision: h1-2 not on %paneB (got '$(field h1-2 pane_id)')" >&2; exit 1; }
[ "$(field h1 pane_id)" = "$(fake_pid paneA)" ] || { echo "collision: incumbent h1 was clobbered" >&2; exit 1; }
case "$_wA" in
  *"DIFFERENT live pane"*) : ;;
  *) echo "collision: recycled-address warning does not name the different live pane: $_wA" >&2; exit 1 ;;
esac
case "$_wA" in
  *"next: tap team"*) : ;;
  *) echo "collision: recycled-address warning does not send the reader to the roster first: $_wA" >&2; exit 1 ;;
esac
case "$_wA" in
  *"held by a live pane"*) echo "collision: a recycled address is still described as a live pane: $_wA" >&2; exit 1 ;;
esac
echo "collision: 6b/A — recycled address suffixes with the honest warning: ok"

# B: dead pane restarting in the SAME recorded live session reclaims the base
# handle — no suffix, no warning.
tap_smoke_quiet "$TAP" register h2 --pane s1:0.0
_wB="$(FAKE_DEAD_PANES="$(fake_pid s1:0.0) s1:0.0" FAKE_LIVE_SESSIONS="s1" "$TAP" register h2 --pane s1:1.0 2>&1 >/dev/null)" || { echo "collision: same-session dead-pane reclaim failed" >&2; exit 1; }
[ "$(field h2 pane_id)" = "$(fake_pid s1:1.0)" ] || { echo "collision: same-session reclaim did not move h2 to s1:1.0 (got '$(field h2 pane_id)')" >&2; exit 1; }
has_agent h2-2 && { echo "collision: same-session reclaim suffixed instead of reclaiming" >&2; exit 1; }
case "$_wB" in
  *"warning:"*) echo "collision: same-session reclaim printed a suffix warning: $_wB" >&2; exit 1 ;;
esac
echo "collision: 6b/B — dead pane in the same live session reclaims the base silently: ok"

# C: dead pane, recorded session still live but DIFFERENT → Amendment 13 keeps
# the suffix boundary and names the still-live recorded session.
tap_smoke_quiet "$TAP" register h3 --pane s2:0.0
_wC="$(FAKE_DEAD_PANES="$(fake_pid s2:0.0) s2:0.0" FAKE_LIVE_SESSIONS="s2 s3" "$TAP" register h3 --pane s3:0.0 2>&1 >/dev/null)" || { echo "collision: different-live-session register failed" >&2; exit 1; }
has_agent h3-2 || { echo "collision: different-live-session did not suffix to h3-2" >&2; exit 1; }
case "$_wC" in
  *"recorded session is still live"*) : ;;
  *) echo "collision: different-live-session warning does not name the still-live session: $_wC" >&2; exit 1 ;;
esac
echo "collision: 6b/C — dead pane in a different live session keeps the Amendment 13 suffix: ok"

# D: unobservable session snapshot fails closed — the incumbent row is kept and
# the independently observed newcomer suffixes.
tap_smoke_quiet "$TAP" register h4 --pane s4:0.0
_wD="$(FAKE_LIST_SESSIONS_FAIL=1 "$TAP" register h4 --pane s5:0.0 2>&1 >/dev/null)" || { echo "collision: unobservable-snapshot register failed" >&2; exit 1; }
has_agent h4-2 || { echo "collision: unobservable snapshot did not suffix to h4-2" >&2; exit 1; }
case "$_wD" in
  *"could NOT be observed"*) : ;;
  *) echo "collision: unobservable-snapshot warning does not say so: $_wD" >&2; exit 1 ;;
esac
[ "$(field h4 pane_id)" = "$(fake_pid s4:0.0)" ] || { echo "collision: unobservable snapshot let the incumbent row change" >&2; exit 1; }
echo "collision: 6b/D — unobservable session snapshot fails closed, incumbent row untouched: ok"


# ── 7. an OCCUPIED pane never silently changes identity (tap-5jc6) ───────────
# The incident: with a driver's pane gone, a leader ran `tap in <driver>` from
# its OWN pane to recover the seat. The same-pane dedup below released the
# leader's live handle and printed `released stale <handle>; reason: same pane`
# — a success-shaped line for a destructive act. The leader then wore the
# driver's identity, and the independent final gate quietly became self-review.
# The recovery path is exactly where this fires, so a skimmable notice is not a
# tell. Rule: an EXPLICIT register whose pane already holds a DIFFERENT handle
# refuses and writes nothing; --force still rebinds, but says what it did.
"$TAP" unregister pollster >/dev/null 2>&1 || true
"$TAP" unregister pollster-2 >/dev/null 2>&1 || true
tap_smoke_quiet "$TAP" register driver --pane paneR
refusal="$("$TAP" register leader --pane paneR 2>&1 >/dev/null)" && {
  echo "collision: registering a second handle on an occupied pane was not refused" >&2; exit 1; }
has_agent leader && { echo "collision: refused register still wrote the new handle" >&2; exit 1; }
[ "$(field driver pane_id)" = "$(fake_pid paneR)" ] || { echo "collision: refused register released the pane's own handle" >&2; exit 1; }
# The class is the machine-readable half — assert it where machines read it.
refusal_json="$("$TAP" register leader --pane paneR --json 2>&1 >/dev/null || true)"
refusal_json="$refusal_json$("$TAP" register leader --pane paneR --json 2>/dev/null || true)"
case "$refusal_json" in
  *pane_occupied*) : ;;
  *) echo "collision: refusal is not classified pane_occupied: $refusal_json" >&2; exit 1 ;;
esac
case "$refusal" in
  *"'driver'"*) : ;;
  *) echo "collision: refusal does not name the handle this pane already holds: $refusal" >&2; exit 1 ;;
esac
# tap-87zz class: the remedy must be a command that can actually succeed for the
# caller who reads it. `tap out` always can — the refusal proves this pane holds
# a handle to drop.
case "$refusal" in
  *"tap out"*) : ;;
  *) echo "collision: refusal names no remedy that works for its reader: $refusal" >&2; exit 1 ;;
esac
echo "collision: 7/9 — explicit register on an occupied pane refuses, writes nothing, names a usable remedy: ok"

# ── 8. --force still rebinds, but the notice reads as what it is ─────────────
forced="$("$TAP" register leader --pane paneR --force 2>&1)" || {
  echo "collision: --force rebind failed" >&2; exit 1; }
has_agent driver && { echo "collision: --force rebind left the old handle registered" >&2; exit 1; }
[ "$(field leader pane_id)" = "$(fake_pid paneR)" ] || { echo "collision: --force did not bind the new handle to the pane" >&2; exit 1; }
case "$forced" in
  *"released stale driver"*) echo "collision: an identity rebind still reads as a stale-handle release: $forced" >&2; exit 1 ;;
esac
case "$forced" in
  *"identity"*"driver"*) : ;;
  *) echo "collision: --force rebind does not say whose identity this pane gave up: $forced" >&2; exit 1 ;;
esac
echo "collision: 8/9 — --force rebinds and names the identity it took off this pane: ok"

# ── 9. residue on our OWN pane is still swept (CONTRACT seat-dedup case (a)) ──
# A pane may carry a leftover row from a handle it used to hold (a claude-fable
# -> fable tag migration, a lingering codex-2). Re-registering the handle the
# pane ALREADY holds is idempotent, not a rebind, and must keep releasing that
# residue — the guard above keys on "no row for the requested name", never on
# "some other row exists".
python3 -B - "$TAP_HOME/registry.json" "$(fake_pid paneR)" <<'PY'
import json, sys
path, pid = sys.argv[1], sys.argv[2]
reg = json.load(open(path))
agents = reg.setdefault("seats", {})
residue = dict(agents["leader"])
residue["pane_id"] = pid
agents["leader-old"] = residue
json.dump(reg, open(path, "w"))
PY
tap_smoke_quiet "$TAP" register leader --pane paneR
has_agent leader-old && { echo "collision: same-pane residue was not released by an idempotent re-register" >&2; exit 1; }
[ "$(field leader pane_id)" = "$(fake_pid paneR)" ] || { echo "collision: idempotent re-register lost the pane's own handle" >&2; exit 1; }
echo "collision: 9/9 — re-registering the pane's own handle still sweeps its residue: ok"

echo "register-collision: ok"
