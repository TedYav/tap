#!/usr/bin/env bash
# H1 tap-gmj0i U5/U6: a full `tap team shutdown` de-enrolls the stopped team's
# machine-index entry (exact capture + authority-bound rollback), and the verb
# accepts one positional <team> so an outside operator can name the target.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tap-shutdown-index.XXXXXX")"
FAKE_BIN="$(mktemp -d "${TMPDIR:-/tmp}/tap-shutdown-index-bin.XXXXXX")"
KILL_LOG="$(mktemp "${TMPDIR:-/tmp}/tap-shutdown-index-kill.XXXXXX")"
TROOT="$WORK/demo-root"
TAP_HOME="$TROOT/.tap/bus"
IDX="$WORK/index"
ACTING="$TROOT/.tap/team-registry.json"
OUTSIDE="$WORK/outside-cwd"
cleanup() {
  rm -rf "${WORK:?}"
  rm -rf "${FAKE_BIN:?}"
  rm -f "${KILL_LOG:?}"
}
trap cleanup EXIT
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$OUTSIDE" "$IDX"
export TAP_HOME TAP_INDEX_HOME="$IDX" KILL_LOG PATH="$FAKE_BIN:$PATH"

# Mock tmux: two live panes (%101 claude / %103 codex); kill-session records its
# target and can be told to REFUSE the self session via KILL_MODE=refuse (the
# self-last kill-failed path under the clear policy).
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; shift || true
pane_id_for() {
  case "$1" in
    "demo/claude:0.0") printf '%%101' ;;
    "demo/codex:0.0")  printf '%%103' ;;
    "%"*) printf '%s' "$1" ;;
    *) printf '%%%s' "$1" ;;
  esac
}
session_for() {
  case "$1" in
    # The engine targets sessions with tmux's exact-match `=` prefix.
    "=demo/claude"|"demo/claude"|"%101"|"demo/claude:0.0") printf 'demo/claude' ;;
    "=demo/codex"|"demo/codex"|"%103"|"demo/codex:0.0")   printf 'demo/codex' ;;
    *) printf '%s' "${1%%:*}" ;;
  esac
}
case "$cmd" in
  kill-session)
    target=""
    while [ "$#" -gt 0 ]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
    resolved="$(session_for "$target")"
    if [ "$resolved" = "demo/claude" ] && [ "${KILL_MODE:-allow}" = "refuse" ]; then
      exit 1
    fi
    printf '%s\n' "$resolved" >> "${KILL_LOG}"
    exit 0 ;;
  has-session)
    target=""
    while [ "$#" -gt 0 ]; do case "$1" in -t) target="$2"; shift 2 ;; *) shift ;; esac; done
    resolved="$(session_for "$target")"
    if grep -qxF "$resolved" "${KILL_LOG}" 2>/dev/null; then exit 1; fi
    exit 0 ;;
  list-panes)
    target=""; all=0
    while [ "$#" -gt 0 ]; do case "$1" in -a) all=1; shift ;; -t) target="$2"; shift 2 ;; -F) shift 2 ;; *) shift ;; esac; done
    if [ "$all" = 1 ]; then printf '%%101\t/dev/faketty\n'; exit 0; fi
    case "${target#=}" in
      demo/claude) printf '%s\n' '%101' ;;
      demo/codex)  printf '%s\n' '%103' ;;
    esac
    exit 0 ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="$2"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    if [ -z "$target" ]; then
      # Real tmux with no -t asks the CALLER'S client; outside a tmux session
      # (TMUX unset) there is none and the query fails. Fabricating an answer
      # made the engine "detect" a caller seat that does not exist and run a
      # self-last kill in an outside-session case.
      if [ -z "${TMUX:-}" ]; then
        exit 1
      fi
      case "$fmt" in
        *pid*start_time*) echo "900:100" ;;
        *window_index*) echo "demo/claude:0.0" ;;
        *session_name*) echo "demo/claude" ;;
        *) echo "" ;;
      esac
      exit 0
    fi
    case "$fmt" in
      *pane_id*pane_tty*session_name*)
        resolved="$(pane_id_for "$target")"
        [ -n "$resolved" ] || { echo ""; exit 0; }
        tty=""; [ "$resolved" = "%101" ] && tty="/dev/faketty"
        printf '%s\t%s\t%s\t%s\n' "$resolved" "$tty" "$(session_for "$resolved")" "900:100" ;;
      *pane_id*session_name*)
        resolved="$(pane_id_for "$target")"
        printf '%s\t%s' "$resolved" "$(session_for "$resolved")"
        [[ "$fmt" == *pid*start_time* ]] && printf '\t%s' "900:100"
        printf '\n' ;;
      *pane_id*pane_tty*)
        resolved="$(pane_id_for "$target")"
        [ -n "$resolved" ] || { echo ""; exit 0; }
        tty=""; [ "$resolved" = "%101" ] && tty="/dev/faketty"
        printf '%s\t%s\n' "$resolved" "$tty" ;;
      *pane_id*)
        pane_id_for "$target"; printf '\n' ;;
      *session_name*)
        session_for "$target" ;;
      *) echo "" ;;
    esac
    exit 0 ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
cat > "$FAKE_BIN/ps" <<'PS'
#!/usr/bin/env bash
printf '1 faketty\n'
PS
chmod +x "$FAKE_BIN/ps"

# Live-marker machine index: the team is enrolled under key `alias-x` whose root
# basename is demo-root (alias≠basename is the acceptance control), with a
# non-default registry_location and extra fields the capture must preserve.
seed_index_to() {
  mkdir -p "$1"
  cat > "$1/global-registry.json" <<JSON
{
  "migrated": "t",
  "schema": "0.20",
  "teams": {
    "alias-x": {
      "crew_only": false,
      "enrolled_at": "2026-09-20T00:00:00Z",
      "note": "u5-witness",
      "registry_location": "$ACTING",
      "root": "$TROOT",
      "state": "registered"
    }
  }
}
JSON
}

seed_index() {
  seed_index_to "$IDX"
}

seed_acting() {
  cat > "$ACTING" <<JSON
{
  "schema": "0.20",
  "team": {"name": "demo", "worktree_root": "$TROOT"},
  "seats": {
    "claude": {"status": "active", "delivery": "pane", "pane": "demo/claude:0.0", "pane_id": "%101", "harness": "claude", "server_epoch": "srv:900:100", "session": "demo/claude"},
    "codex":  {"status": "active", "delivery": "pane", "pane": "demo/codex:0.0",  "pane_id": "%103", "harness": "codex",  "server_epoch": "srv:900:100", "session": "demo/codex"}
  }
}
JSON
}

seed_acting_empty() {
  cat > "$ACTING" <<JSON
{
  "schema": "0.20",
  "team": {"name": "demo", "worktree_root": "$TROOT"},
  "seats": {}
}
JSON
}

index_keys() {
  python3 -B - "$IDX/global-registry.json" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1]))
except Exception:
    print("UNREADABLE"); raise SystemExit(0)
teams = data.get("teams")
print("\n".join(sorted(teams)) if isinstance(teams, dict) else "")
PY
}

assert_no_index_artifact() {
  local leftovers
  leftovers="$(ls "$TAP_HOME/recovery" 2>/dev/null | grep '^team-shutdown-index\.' || true)"
  [ -z "$leftovers" ] || { echo "($1) index capture artifact left behind: $leftovers" >&2; exit 1; }
}

# --- (1) outside the team session: shutdown removes registry + index entry -----
seed_index
seed_acting
: > "$KILL_LOG"
unset TMUX
shut_rc=0
( cd "$TROOT" && "$TAP" team shutdown --yes </dev/null >/dev/null 2>&1 ) || shut_rc=$?
[ "$shut_rc" = 0 ] || { echo "(1) shutdown rc=$shut_rc (wanted 0)" >&2; exit 1; }
[ ! -e "$ACTING" ] || { echo "(1) acting registry survived shutdown" >&2; exit 1; }
[ "$(index_keys)" = "" ] || { echo "(1) CAUSAL U5 RED: machine index still lists: $(index_keys)" >&2; exit 1; }
rows="$("$TAP" teams --all 2>/dev/null || true)"
grep -q "^alias-x" <<<"$rows" && { echo "(1) tap teams --all still lists alias-x" >&2; exit 1; }
assert_no_index_artifact "(1)"
echo "team-shutdown-index: (1) outside-session shutdown de-enrolls alias-x: ok"

# --- (3) self-last, kill succeeds: index entry gone ----------------------------
# U5 requirements only: the acting registry is gone, the index entry is gone,
# and the self kill was attempted. This mock's kill-session RETURNING proves
# only the survivor path (the real engine replaces the process on success), so
# this case makes NO claim about capture-artifact disposal — the populated
# path deliberately retains the capture through the kill boundary for
# rollback (committed U5 plan); only survivor-path refusals (case 4) may
# assert artifact state.
seed_index
seed_acting
: > "$KILL_LOG"
export TMUX="/tmp/fake,0,0"
KILL_MODE=allow shut_rc=0
"$TAP" team shutdown --yes </dev/null >/dev/null 2>&1 || shut_rc=$?
[ "$shut_rc" = 0 ] || { echo "(3) shutdown rc=$shut_rc (wanted 0)" >&2; exit 1; }
[ ! -e "$ACTING" ] || { echo "(3) acting registry survived" >&2; exit 1; }
[ "$(index_keys)" = "" ] || { echo "(3) machine index still lists: $(index_keys)" >&2; exit 1; }
grep -qx "demo/claude" "$KILL_LOG" || { echo "(3) self session not killed" >&2; exit 1; }
echo "team-shutdown-index: (3) self-last successful shutdown de-enrolls: ok"

# --- (4) self-last, kill refuses: rows restored AND index entry restored --------
seed_index
seed_acting
: > "$KILL_LOG"
cp "$IDX/global-registry.json" "$WORK/index.before"
refuse_rc=0
KILL_MODE=refuse "$TAP" team shutdown --yes </dev/null >/dev/null 2>&1 || refuse_rc=$?
[ "$refuse_rc" != 0 ] || { echo "(4) kill-refused shutdown exited 0" >&2; exit 1; }
[ -e "$ACTING" ] || { echo "(4) acting registry not restored after refused kill" >&2; exit 1; }
python3 -B - "$ACTING" <<'PY'
import json, sys
seats = json.load(open(sys.argv[1])).get("seats") or {}
assert "claude" in seats, f"caller row not restored: {sorted(seats)}"
PY
[ "$(index_keys)" = "alias-x" ] || { echo "(4) CAUSAL U5 RED: index entry not restored (keys: $(index_keys))" >&2; exit 1; }
cmp -s "$WORK/index.before" "$IDX/global-registry.json" \
  || { echo "(4) restored entry differs from the captured original" >&2; exit 1; }
python3 -B - "$IDX/global-registry.json" <<'PY'
import json, sys
teams = json.load(open(sys.argv[1])).get("teams") or {}
assert "x-root" not in teams, f"basename key invented: {sorted(teams)}"
ent = teams["alias-x"]
assert ent["registry_location"].endswith("/.tap/team-registry.json"), ent
assert ent["note"] == "u5-witness" and ent["crew_only"] is False, ent
PY
assert_no_index_artifact "(4)"
echo "team-shutdown-index: (4) refused self-kill restores the exact alias-x entry: ok"

# --- (5) genuinely retained row keeps registry file AND enrollment --------------
seed_index
seed_acting
: > "$KILL_LOG"
keep_rc=0
"$TAP" team shutdown --yes --keep-self </dev/null >/dev/null 2>&1 || keep_rc=$?
[ "$keep_rc" = 0 ] || { echo "(5) keep-self shutdown rc=$keep_rc" >&2; exit 1; }
[ -e "$ACTING" ] || { echo "(5) retained-row registry file was deleted" >&2; exit 1; }
[ "$(index_keys)" = "alias-x" ] || { echo "(5) enrollment lost despite a retained row (keys: $(index_keys))" >&2; exit 1; }
echo "team-shutdown-index: (5) retained row keeps registry and enrollment: ok"

# --- (5b) selection with a retained row keeps registry file AND enrollment -----
seed_index
seed_acting
: > "$KILL_LOG"
unset TMUX
only_rc=0
( cd "$TROOT" && "$TAP" team shutdown --yes --only codex </dev/null >/dev/null 2>&1 ) || only_rc=$?
[ "$only_rc" = 0 ] || { echo "(5b) --only codex shutdown rc=$only_rc" >&2; exit 1; }
grep -qx "=demo/codex" "$KILL_LOG" || grep -qx "demo/codex" "$KILL_LOG" || { echo "(5b) codex was not killed" >&2; exit 1; }
[ -e "$ACTING" ] || { echo "(5b) registry file deleted despite a selection-retained row" >&2; exit 1; }
python3 -B - "$ACTING" <<'PY'
import json, sys
seats = json.load(open(sys.argv[1])).get("seats") or {}
assert "claude" in seats, f"selection-retained row lost: {sorted(seats)}"
assert "codex" not in seats, f"selected row kept: {sorted(seats)}"
PY
[ "$(index_keys)" = "alias-x" ] || { echo "(5b) enrollment lost despite a retained row (keys: $(index_keys))" >&2; exit 1; }
assert_no_index_artifact "(5b)"
echo "team-shutdown-index: (5b) selection-retained row keeps registry and enrollment: ok"

# --- (5c) selection covering the whole roster retains nothing: de-enroll runs ---
seed_index
seed_acting
: > "$KILL_LOG"
unset TMUX
only_rc=0
( cd "$TROOT" && "$TAP" team shutdown --yes --only codex,claude </dev/null >/dev/null 2>&1 ) || only_rc=$?
[ "$only_rc" = 0 ] || { echo "(5c) --only codex,claude shutdown rc=$only_rc" >&2; exit 1; }
[ ! -e "$ACTING" ] || { echo "(5c) registry survived a zero-retained selection" >&2; exit 1; }
[ "$(index_keys)" = "" ] || { echo "(5c) index kept: $(index_keys)" >&2; exit 1; }
assert_no_index_artifact "(5c)"
echo "team-shutdown-index: (5c) zero-retained selection de-enrolls: ok"

# --- (5d) zero-row arm on a live index: entry removed AND artifact disposed ------
seed_index
seed_acting_empty
: > "$KILL_LOG"
unset TMUX
zero_rc=0
( cd "$TROOT" && "$TAP" team shutdown --yes </dev/null >/dev/null 2>&1 ) || zero_rc=$?
[ "$zero_rc" = 0 ] || { echo "(5d) zero-row shutdown rc=$zero_rc" >&2; exit 1; }
[ "$(index_keys)" = "" ] || { echo "(5d) zero-row arm left the index: $(index_keys)" >&2; exit 1; }
[ ! -e "$ACTING" ] || { echo "(5d) zero-row arm kept the blank registry" >&2; exit 1; }
assert_no_index_artifact "(5d)"
echo "team-shutdown-index: (5d) zero-row arm de-enrolls and disposes the artifact: ok"

# --- (6) dry-run: nothing changes -----------------------------------------------
seed_index
seed_acting
: > "$KILL_LOG"
export TMUX="/tmp/fake,0,0"
cp "$IDX/global-registry.json" "$WORK/index.before"
cp "$ACTING" "$WORK/acting.before"
( cd "$TROOT" && "$TAP" team shutdown --dry-run </dev/null >/dev/null 2>&1 )
cmp -s "$WORK/index.before" "$IDX/global-registry.json" || { echo "(6) dry-run mutated the index" >&2; exit 1; }
cmp -s "$WORK/acting.before" "$ACTING" || { echo "(6) dry-run mutated the registry" >&2; exit 1; }
[ -s "$KILL_LOG" ] && { echo "(6) dry-run killed a session" >&2; exit 1; }
assert_no_index_artifact "(6)"
unset TMUX
echo "team-shutdown-index: (6) dry-run leaves index and registry untouched: ok"

# The de-enroll primitive sections (7) and (7b) exercised lib.sh
# tap_index_deenroll_team directly; the helper is deleted (B7c: its last
# production callers, verbs/admin.ts refresh and retire, now call index-home.ts
# deenrollTeam and deenrollTeamWithCapture). The plain contract (unknown team 2,
# former root returned, key removed) lives in admin-deenroll.test.ts; the
# capture triplet is a typed required input, so a partial set cannot be spelled.

# --- (2) U6: named target from outside the team cwd ------------------------------
seed_index
seed_acting
: > "$KILL_LOG"
unset TMUX
named_rc=0
named_err="$(mktemp "${TMPDIR:-/tmp}/tap-shutdown-index-named.XXXXXX")"
( cd "$OUTSIDE" && "$TAP" team shutdown alias-x --yes </dev/null >/dev/null 2>"$named_err" ) || named_rc=$?
if [ "$named_rc" != 0 ]; then
  echo "(2) CAUSAL U6 RED: named shutdown rc=$named_rc from outside cwd; stderr:" >&2
  cat "$named_err" >&2
  exit 1
fi
rm -f "${named_err:?}"
[ ! -e "$ACTING" ] || { echo "(2) named shutdown left the acting registry" >&2; exit 1; }
[ "$(index_keys)" = "" ] || { echo "(2) named shutdown left index keys: $(index_keys)" >&2; exit 1; }
assert_no_index_artifact "(2)"
echo "team-shutdown-index: (2) named shutdown from outside cwd de-enrolls: ok"

# --- (2b) genuinely unpinned operator: named shutdown outside any team ----------
# The REAL unpinned operator shape: no TAP_HOME, TAP_BUS_RULE,
# TAP_TEAM_SELECT, TMUX — and crucially no TAP_INDEX_HOME either; the machine
# index lives at $HOME/.tap (the runner's private HOME is this test's own
# sandbox). With the fixture's exported TAP_INDEX_HOME the pre-dispatch
# classifier can anchor through it and the control would not fire. The
# local-command classifier must NOT claim this verb locally
# (missingLocalTeam refuses unanchored_bus/tap-init before the named override
# ever runs); tap-team.sh's U6 block stays the refusal authority.
HOME_INDEX="${HOME:?}/.tap"
mkdir -p "$HOME_INDEX"
seed_index_to "$HOME_INDEX"
seed_acting
: > "$KILL_LOG"
unpinned_rc=0
unpinned_err="$(mktemp "${TMPDIR:-/tmp}/tap-shutdown-index-unpinned.XXXXXX")"
( cd "$OUTSIDE" && env -u TAP_HOME -u TAP_BUS_RULE -u TAP_TEAM_SELECT -u TMUX -u TAP_INDEX_HOME \
    "$TAP" team shutdown alias-x --yes </dev/null >/dev/null 2>"$unpinned_err" ) || unpinned_rc=$?
if [ "$unpinned_rc" != 0 ]; then
  echo "(2b) CAUSAL ADDENDUM RED: unpinned named shutdown rc=$unpinned_rc; stderr:" >&2
  cat "$unpinned_err" >&2
  exit 1
fi
rm -f "${unpinned_err:?}"
[ ! -e "$ACTING" ] || { echo "(2b) unpinned named shutdown left the acting registry" >&2; exit 1; }
[ "$(index_keys)" = "" ] || { echo "(2b) unpinned named shutdown left index keys: $(index_keys)" >&2; exit 1; }
rm -f "${HOME_INDEX:?}/global-registry.json"
rm -f "${HOME_INDEX:?}/global-registry.json.lock"
echo "team-shutdown-index: (2b) unpinned named shutdown from outside works: ok"

# --- (11) U6: unknown team is refused with unknown_team and zero effects ---------
# The selector's class for a --team the machine index does not enroll
# (structured-failures table); not_found stays the class for an unknown seat.
seed_index
seed_acting
: > "$KILL_LOG"
unk_rc=0
unk_err="$(mktemp "${TMPDIR:-/tmp}/tap-shutdown-index-unk.XXXXXX")"
( cd "$OUTSIDE" && "$TAP" team shutdown no-such-team --yes --json </dev/null ) >"$unk_err" 2>/dev/null || unk_rc=$?
[ "$unk_rc" != 0 ] || { echo "(11) unknown team shutdown exited 0" >&2; exit 1; }
grep -q '"error_class":"unknown_team"' "$unk_err" || { echo "(11) refusal was not unknown_team: $(cat "$unk_err")" >&2; exit 1; }
[ "$(index_keys)" = "alias-x" ] || { echo "(11) unknown-team refusal mutated the index" >&2; exit 1; }
[ -s "$KILL_LOG" ] && { echo "(11) unknown-team refusal killed sessions" >&2; exit 1; }
rm -f "${unk_err:?}"
echo "team-shutdown-index: (11) unknown team refused unknown_team, zero effects: ok"

# --- (11b) the TAP_HOME-pinned path refuses an unknown team with the same class ---
seed_index
seed_acting
: > "$KILL_LOG"
punk_rc=0
punk_err="$(mktemp "${TMPDIR:-/tmp}/tap-shutdown-index-punk.XXXXXX")"
( cd "$OUTSIDE" && env TAP_HOME="$TAP_HOME" TAP_BUS_RULE=env "$TAP" team shutdown no-such-team --yes --json </dev/null ) >"$punk_err" 2>/dev/null || punk_rc=$?
[ "$punk_rc" != 0 ] || { echo "(11b) pinned unknown team shutdown exited 0" >&2; exit 1; }
grep -q '"error_class":"unknown_team"' "$punk_err" || { echo "(11b) pinned refusal was not unknown_team: $(cat "$punk_err")" >&2; exit 1; }
[ "$(index_keys)" = "alias-x" ] || { echo "(11b) pinned unknown-team refusal mutated the index" >&2; exit 1; }
[ -s "$KILL_LOG" ] && { echo "(11b) pinned unknown-team refusal killed sessions" >&2; exit 1; }
rm -f "${punk_err:?}"
echo "team-shutdown-index: (11b) pinned unknown team refused unknown_team, zero effects: ok"

# --- (12) U6: a second positional is a usage_error, zero effects ------------------
seed_index
seed_acting
: > "$KILL_LOG"
extra_rc=0
extra_err="$(mktemp "${TMPDIR:-/tmp}/tap-shutdown-index-extra.XXXXXX")"
( cd "$OUTSIDE" && "$TAP" team shutdown alias-x extra --yes --json </dev/null ) >"$extra_err" 2>/dev/null || extra_rc=$?
[ "$extra_rc" != 0 ] || { echo "(12) second positional accepted" >&2; exit 1; }
grep -q "usage_error" "$extra_err" || { echo "(12) refusal was not usage_error: $(cat "$extra_err")" >&2; exit 1; }
[ "$(index_keys)" = "alias-x" ] || { echo "(12) extra-positional refusal mutated the index" >&2; exit 1; }
[ -s "$KILL_LOG" ] && { echo "(12) extra-positional refusal killed sessions" >&2; exit 1; }
rm -f "${extra_err:?}"
echo "team-shutdown-index: (12) second positional refused usage_error: ok"

# --- (13) U6: -h stays option-shaped (never read as a team name) ------------------
seed_index
seed_acting
: > "$KILL_LOG"
h_rc=0
h_err="$(mktemp "${TMPDIR:-/tmp}/tap-shutdown-index-h.XXXXXX")"
# Help is served natively: -h prints the tap team page and exits 0.
h_out="$(mktemp "${TMPDIR:-/tmp}/tap-shutdown-index-hout.XXXXXX")"
( cd "$OUTSIDE" && "$TAP" team shutdown -h </dev/null ) >"$h_out" 2>"$h_err" || h_rc=$?
[ "$h_rc" = 0 ] || { echo "(13) -h exited $h_rc: $(cat "$h_err")" >&2; exit 1; }
grep -q "tap team shutdown" "$h_out" || { echo "(13) -h did not print the tap team help" >&2; exit 1; }
# The help page itself names error classes; a team-name refusal shows on stderr.
grep -qE "not_found|unknown_team" "$h_err" && { echo "(13) -h was treated as a team name" >&2; exit 1; }
[ "$(index_keys)" = "alias-x" ] || { echo "(13) -h mutated the index" >&2; exit 1; }
[ -s "$KILL_LOG" ] && { echo "(13) -h killed sessions" >&2; exit 1; }
rm -f "${h_err:?}"
rm -f "${h_out:?}"
echo "team-shutdown-index: (13) -h stays an option: ok"

# --- (14) corrupt marker: syntax is checked first, then the invalid-flip gate ----
# The stop door parses all syntax before any discovery, so a malformed
# call names its own usage error even over a corrupt marker, while a well-formed
# named call is refused invalid_flip before any team resolution.
seed_index
printf '{ this is definitely not json\n' > "$IDX/global-registry.json"
inv_rc=0
inv_err="$(mktemp "${TMPDIR:-/tmp}/tap-shutdown-index-inv.XXXXXX")"
( cd "$OUTSIDE" && "$TAP" team shutdown alias-x --yes --json </dev/null ) >"$inv_err" 2>/dev/null || inv_rc=$?
[ "$inv_rc" != 0 ] || { echo "(14) corrupt-marker shutdown exited 0" >&2; exit 1; }
grep -q "invalid_flip" "$inv_err" || { echo "(14) wanted invalid_flip for a well-formed named call: $(cat "$inv_err")" >&2; exit 1; }
syn_rc=0
syn_err="$(mktemp "${TMPDIR:-/tmp}/tap-shutdown-index-syn.XXXXXX")"
( cd "$OUTSIDE" && "$TAP" team shutdown alias-x extra --yes --json </dev/null ) >"$syn_err" 2>/dev/null || syn_rc=$?
[ "$syn_rc" != 0 ] || { echo "(14) corrupt-marker malformed shutdown exited 0" >&2; exit 1; }
grep -q "usage_error" "$syn_err" || { echo "(14) wanted syntax refusal before the invalid-flip gate: $(cat "$syn_err")" >&2; exit 1; }
[ -s "$KILL_LOG" ] && { echo "(14) corrupt-marker refusals killed sessions" >&2; exit 1; }
rm -f "${inv_err:?}"
rm -f "${syn_err:?}"
echo "team-shutdown-index: (14) well-formed call hits invalid_flip; malformed call hits syntax first: ok"

# --- (15) U6: conflicting TAP_TEAM_SELECT refuses with zero effects ---------------
seed_index
seed_acting
: > "$KILL_LOG"
conf_rc=0
conf_err="$(mktemp "${TMPDIR:-/tmp}/tap-shutdown-index-conf.XXXXXX")"
( cd "$OUTSIDE" && TAP_TEAM_SELECT=other-team "$TAP" team shutdown alias-x --yes </dev/null ) 2>"$conf_err" || conf_rc=$?
[ "$conf_rc" != 0 ] || { echo "(15) conflicting TAP_TEAM_SELECT accepted" >&2; exit 1; }
[ "$(index_keys)" = "alias-x" ] || { echo "(15) conflicting-select refusal mutated the index" >&2; exit 1; }
rm -f "${conf_err:?}"
echo "team-shutdown-index: (15) conflicting TAP_TEAM_SELECT refuses: ok"

# --- (16) U6: equal TAP_TEAM_SELECT succeeds --------------------------------------
seed_index
seed_acting
: > "$KILL_LOG"
eq_rc=0
( cd "$OUTSIDE" && TAP_TEAM_SELECT=alias-x "$TAP" team shutdown alias-x --yes </dev/null >/dev/null 2>&1 ) || eq_rc=$?
[ "$eq_rc" = 0 ] || { echo "(16) equal TAP_TEAM_SELECT rc=$eq_rc" >&2; exit 1; }
[ ! -e "$ACTING" ] || { echo "(16) equal-select shutdown left the registry" >&2; exit 1; }
[ "$(index_keys)" = "" ] || { echo "(16) equal-select shutdown left index: $(index_keys)" >&2; exit 1; }
echo "team-shutdown-index: (16) equal TAP_TEAM_SELECT succeeds: ok"

# --- (17) U6: explicit TAP_HOME pin naming another bus refuses, zero effects ------
seed_index
seed_acting
: > "$KILL_LOG"
OTHER="$WORK/other-root/.tap/bus"
mkdir -p "$OTHER/payloads" "$OTHER/receipts"
pin_rc=0
pin_err="$(mktemp "${TMPDIR:-/tmp}/tap-shutdown-index-pin.XXXXXX")"
( cd "$OUTSIDE" && env TAP_HOME="$OTHER" TAP_BUS_RULE=env "$TAP" team shutdown alias-x --yes </dev/null ) 2>"$pin_err" || pin_rc=$?
[ "$pin_rc" != 0 ] || { echo "(17) conflicting TAP_HOME pin accepted" >&2; exit 1; }
[ "$(index_keys)" = "alias-x" ] || { echo "(17) pin refusal mutated the index" >&2; exit 1; }
[ -s "$KILL_LOG" ] && { echo "(17) pin refusal killed sessions" >&2; exit 1; }
rm -f "${pin_err:?}"
echo "team-shutdown-index: (17) conflicting TAP_HOME pin refuses, zero effects: ok"

# --- (18) U6: explicit TAP_HOME pin naming the team bus succeeds -------------------
seed_index
seed_acting
: > "$KILL_LOG"
agree_rc=0
( cd "$OUTSIDE" && env TAP_HOME="$TAP_HOME" TAP_BUS_RULE=env "$TAP" team shutdown alias-x --yes </dev/null >/dev/null 2>&1 ) || agree_rc=$?
[ "$agree_rc" = 0 ] || { echo "(18) agreeing TAP_HOME pin rc=$agree_rc" >&2; exit 1; }
[ ! -e "$ACTING" ] || { echo "(18) agreeing-pin shutdown left the registry" >&2; exit 1; }
[ "$(index_keys)" = "" ] || { echo "(18) agreeing-pin shutdown left index: $(index_keys)" >&2; exit 1; }
echo "team-shutdown-index: (18) agreeing TAP_HOME pin succeeds: ok"

echo "team-shutdown-index: ok"
