#!/usr/bin/env bash
# born-live-enroll.test.sh — first enrollment on a machine with NO legacy stores
# must write global-registry.json, not retired teams.json.
#
# WHY THIS IS NOT postflip-enroll.test.sh: that file SEEDS global-registry.json
# to make the flip live, then registers. This one seeds NOTHING. It is the same
# assertion under the one condition the seeded fixture can never reach — a
# machine that has never held TAP state at all.
#
# The defect: `flip_marker_state` returns "absent" solely because
# global-registry.json is missing, and "absent" is documented as "genuine
# pre-flip; legacy routing allowed". A brand-new machine is therefore born
# PRE-FLIP and its first enrollment writes a retired store. After that,
# `absent` is ambiguous: it means either "this machine predates the flip" or
# "this machine is new", and nothing downstream can tell those apart.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# shellcheck source=helpers.sh
. "$ROOT/skills/tap/scripts/smoke/helpers.sh"
tap_smoke_runtime

WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
export TAP_INDEX_HOME="$WORK/index"
export PATH="$FAKE_BIN:$PATH"
export TMUX="/fake/tmux/socket"
mkdir -p "$TAP_INDEX_HOME" "$FAKE_BIN"

pass=0; fail_n=0
ok()  { pass=$((pass+1));   printf '  ok   %s\n' "$1"; }
bad() { fail_n=$((fail_n+1)); printf '  FAIL %s\n' "$1"; }

cat >"$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; shift || true
case "$cmd" in
  display-message)
    fmt=""; _t=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) _t="$2"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    # Answer PER TARGET. Two panes exist in this fixture: %201 is alice and %202
    # is bob, and both are reported consistently by display-message and by
    # list-panes below. A recipient pane has to be observable for delivery, or
    # the send refuses and a route-only assertion passes on that refusal.
    case "${_t#=}" in
      # ONE server => ONE generation. Giving %202 its own epoch read as the
      # server restarting mid-registration and register correctly refused:
      # "generation moved while registering 'bob' (srv:901:202 -> srv:901:201)".
      %202|newbie/bob) _p="%202"; _tty="/dev/faketty2"; _sess="newbie/bob"; _ep="901:201" ;;
      *)    _p="%201"; _tty="/dev/faketty";  _sess="newbie/alice"; _ep="901:201" ;;
    esac
    case "$fmt" in
      *pane_id*pane_tty*session_name*) printf '%s\t%s\t%s\t%s\n' "${_p:-%201}" "${_tty:-/dev/faketty}" "${_sess:-newbie/alice}" "${_ep:-901:201}" ;;
      # The NATIVE delivery observation (tmux.ts:329) asks for four fields:
      # pane_id, session_name, pane_pid, pane_current_command. The generic
      # `*pid*` arm below also matches that string and answered three fields
      # with the wrong third, so the parse failed and a live pane read as GONE
      # -- while the send still traced `native send`. Specific arm first.
      *pane_id*session_name*pane_pid*pane_current_command*)
        printf '%s\t%s\t%s\t%s\t0\n' "${_p}" "${_sess}" "4242" "claude" ;;
      *pane_id*session_name*pid*start_time*|*pane_id*session_name*pid*)
        printf '%s\t%s\t%s\n' "${_p:-%201}" "${_sess:-newbie/alice}" "${_ep:-901:201}" ;;
      *pane_id*session_name*) printf '%s\t%s\n' "${_p:-%201}" "${_sess:-newbie/alice}" ;;
      *pane_id*) echo "${_p:-%201}" ;;
      *session_name*) echo "${_sess:-newbie/alice}" ;;
      *pid*start_time*) echo "901:201" ;;
      *pane_pid*) echo "4242" ;;
      *pane_in_mode*) echo "0" ;;
      *pane_current_command*) echo "claude" ;;
      *pane_current_path*) echo "${FAKE_TMUX_PATH:-/tmp}" ;;
      *socket_path*) echo "${TMUX%%,*}" ;;
      *) echo "" ;;
    esac ;;
  # MINIMAL TRUTHFUL list-panes (partner review's FIX-AND-SHIP). The fixture
  # already simulates tmux; this is the one observation it was missing, and
  # without it no pane is ever deliverable, so a pane recipient refuses and the
  # native route cannot be distinguished from a native refusal.
  list-panes)
    _t=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -t) _t="$2"; shift 2 ;; -F) fmt="$2"; shift 2 ;; -a|-s) shift ;; *) shift ;; esac
    done
    emit() { # <pane> <tty> <session> <epoch>
      local o="$fmt"
      o="${o//'#{pane_id}'/$1}"; o="${o//'#{pane_tty}'/$2}"
      o="${o//'#{session_name}'/$3}"; o="${o//'#{pid}:#{start_time}'/$4}"
      printf '%s\n' "$o"
    }
    case "${_t#=}" in
      "")   emit "%201" "/dev/faketty" "newbie/alice" "901:201"
            emit "%202" "/dev/faketty2" "newbie/bob" "901:201" ;;
      # Targets arrive either as a raw pane id or SESSION-QUALIFIED: delivery
      # resolves a recipient by its stored `pane` field, which is "newbie/bob".
      # Matching only %-ids made the recipient look nonexistent and the send
      # refused -- while still tracing `native send`.
      %201|newbie/alice) emit "%201" "/dev/faketty"  "newbie/alice" "901:201" ;;
      %202|newbie/bob)   emit "%202" "/dev/faketty2" "newbie/bob"   "901:201" ;;
      *)    exit 1 ;;
    esac ;;
  has-session) exit 0 ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

TEAM="$WORK/newbie"
mkdir -p "$TEAM/.tap/bus/payloads" "$TEAM/.tap/bus/receipts"
git -C "$TEAM" init -q
git -C "$TEAM" config user.email "tap@test"
git -C "$TEAM" config user.name "tap"
git -C "$TEAM" commit --allow-empty -qm init >/dev/null
FAKE_TMUX_PATH="$(cd "$TEAM" && pwd -P)"
export FAKE_TMUX_PATH
export TAP_HOME="$TEAM/.tap/bus"

# --- THE PRECONDITION, asserted rather than assumed -------------------------
# A fresh machine holds NEITHER store. If either exists the run measures
# something else entirely, so these are controls, not setup.
[ ! -f "$TAP_INDEX_HOME/global-registry.json" ] \
  && ok "control: the fixture machine has no global-registry.json" \
  || bad "control: fixture already has global-registry.json — this is not a fresh machine"
[ ! -f "$TAP_INDEX_HOME/teams.json" ] \
  && ok "control: the fixture machine has no legacy teams.json" \
  || bad "control: fixture already has teams.json — this is not a fresh machine"

# --- SHAPE 1: the PUBLIC first-entry flow, `tap init` ------------------------
# This is the flow the unit was specified against, and the one that exposes the
# authority question: `tap init` picks WHICH acting store to create from its own
# polarity fence, before enrollment ever runs. A born-live machine that leaves
# init on the pre-flip branch ends up with a LIVE marker whose registry_location
# names the RETIRED bus file -- which lib.sh:5792 says must never happen
# (review P1). Asserting only "registry_location is non-empty
# and exists" cannot see that: the retired bus file satisfies both.
(
  cd "$TEAM"
  unset TAP_HOME
  tap_smoke_quiet "$TAP" init
) && ok "public tap init on a fresh machine succeeds" \
  || bad "tap init (fresh machine) failed outright"

# --- what it wrote ----------------------------------------------------------
if [ -f "$TAP_INDEX_HOME/teams.json" ]; then
  bad "BORN PRE-FLIP: first enrollment created retired teams.json — 'absent' now means either 'predates the flip' or 'brand new', and nothing downstream can tell them apart"
else
  ok "no retired teams.json was created"
fi

if [ -f "$TAP_INDEX_HOME/global-registry.json" ]; then
  ok "global-registry.json exists after first enrollment"
  python3 -B - "$TAP_INDEX_HOME/global-registry.json" "$FAKE_TMUX_PATH" <<'PY'
import json, os, sys
gpath, root = sys.argv[1:3]
data = json.load(open(gpath))
assert data.get("schema") == "0.20", f"schema is {data.get('schema')!r}, not 0.20"
ent = (data.get("teams") or {}).get("newbie")
assert isinstance(ent, dict), f"team 'newbie' is not enrolled: {data}"
assert os.path.realpath(ent.get("root") or "") == os.path.realpath(root), ent
loc = ent.get("registry_location") or ""
assert loc, f"registry_location is empty: {ent}"
assert os.path.isfile(loc), f"registry_location does not exist: {loc}"
PY
  if [ $? -eq 0 ]; then
    ok "it carries schema 0.20 with the team enrolled and a reachable registry_location"
  else
    bad "global-registry.json exists but its content is wrong"
  fi

  # THE AUTHORITY ASSERTION. A live marker must name the CANONICAL acting store,
  # never the retired bus registry. Non-empty + exists is not enough -- the
  # retired file passes both.
  # realpath BOTH sides: on macOS /var is a symlink to /private/var, so the
  # stored path and the fixture path spell the same file differently. Comparing
  # the spellings fails on a correct result -- which is how the first run of
  # this assertion reported a defect that was not there.
  CANON="$(cd "$TEAM" && pwd -P)/.tap/team-registry.json"
  STORED="$(python3 -B -c '
import json,sys
d=json.load(open(sys.argv[1]))
import os
loc=(d.get("teams") or {}).get("newbie",{}).get("registry_location","")
print(os.path.realpath(loc) if loc else "")' "$TAP_INDEX_HOME/global-registry.json")"
  if [ "$STORED" = "$CANON" ]; then
    ok "registry_location names the canonical acting store"
  else
    bad "LIVE MARKER OVER A RETIRED STORE: registry_location is '$STORED', expected the canonical '$CANON' — lib.sh:5792 says post-flip must never enroll the retired bus file"
  fi
else
  bad "BORN PRE-FLIP: no global-registry.json after first enrollment on a machine that had no legacy store"
fi

# --- SHAPE 1b: the following public send routes NATIVE ------------------------
# Marker creation alone does not prove the authority transition; the point of
# born-live is that the next real call uses the v0.20 path. This is the half the
# first cut of the falsifier omitted (partner review).
TRACE="$WORK/route.trace"; _send_rc=0
# A seat must exist before anything can be sent to it: `tap init` creates the
# team, not a member. The first cut of this arm sent into an empty team, got a
# refusal, and reported an empty trace as though the ROUTE were wrong.
# A PANE seat, not --delivery poll: an ordinary send from a poll-delivery sender
# is Bash-owned by contract, so a poll seat could never produce a native route
# no matter how the marker landed.
_rc=0
(
  cd "$TEAM"
  unset TAP_HOME
  "$TAP" in bob --pane %202
) >"$WORK/bobreg.out" 2>&1 || _rc=$?
[ "$_rc" = 0 ] || bad "pane recipient bob did not register (rc $_rc): $(tr '\n' ' ' <"$WORK/bobreg.out" | head -c 260)"
_rc=0
(
  cd "$TEAM"
  unset TAP_HOME
  # --pane explicitly: the fake answers list-panes only for the two panes it
  # declares, and never maps a CALLER tty to one, so implicit discovery still
  # finds nothing and register correctly demands --pane. Without the rc
  # assertion above this registration was failing silently and the route arm
  # below was measuring a refusal (partner review, P1b).
  "$TAP" in alice --pane %201
) >"$WORK/panereg.out" 2>&1 || _rc=$?
[ "$_rc" = 0 ] && ok "pane seat registered (rc 0)" \
  || bad "pane registration returned $_rc: $(tr '\n' ' ' <"$WORK/panereg.out" | head -c 260)"
(
  cd "$TEAM"
  unset TAP_HOME
  export TAP_BUN_ROUTE_TRACE="$TRACE"
  # NOT tap_smoke_quiet here: it sends stdout to /dev/null and only surfaces
  # stderr on failure, so an outer capture sees nothing and an empty trace looks
  # like a routing result instead of a hidden refusal.
  # bin/tap, NOT scripts/tap.sh: the route trace is written by the BUN router,
  # and the Bash dispatcher never produces one. Probing through tap.sh reports an
  # empty trace for a send that in fact succeeded -- which is what it did here.
  # alice (pane) -> bob (PANE). bob is deliverable because the fake now answers
  # list-panes, which is what makes the native door reachable and therefore
  # assertable. Sending alice->alice earlier traced "native send" and then
  # returned rc 3, "pane does not exist" -- a native REFUSAL passing a
  # trace-only assertion, which is exactly the hole the partner reviewer named.
  "$ROOT/bin/tap" send bob --ask -m "born-live route probe" --from alice
) >"$WORK/send.out" 2>&1 || _send_rc=$?
# rc FIRST, then the route. Routing is recorded BEFORE the handler result, so a
# native REFUSAL also writes "native send" into the trace -- the trace alone
# cannot tell a delivered send from a refused one (partner review, P1b). That is
# not hypothetical here: an earlier alice->alice version of this arm traced
# "native send" and returned rc 3, "pane does not exist", and passed.
[ "$_send_rc" = 0 ] && ok "the following public send succeeded (rc 0)" \
  || bad "send returned $_send_rc: $(tr '\n' ' ' <"$WORK/send.out" | head -c 240)"
# EXACT route, not "a route". bob is a PANE recipient and is deliverable now
# that the fake answers list-panes, so this send must take the native door --
# which is the discriminator the Lane C handoff fixed for this unit. Accepting
# any recorded route would pass on `bash send`, and accepting the trace without
# rc would pass on a native REFUSAL (an earlier alice->alice arm did exactly
# that: traced `native send`, returned rc 3, "pane does not exist").
_route="$(tr -d ' \n' <"$TRACE" 2>/dev/null)"
if [ "$_route" = "nativesend" ]; then
  ok "the following public send takes the NATIVE door (route: $_route)"
else
  bad "expected exactly 'native send', got '$_route' — send said: $(tr '\n' ' ' <"$WORK/send.out" | head -c 200)"
fi

# --- SHAPE 2: fresh DIRECT `tap in` keeps the seat in canonical authority -----
# The other first-entry shape. Publishing the marker without folding would point
# authority at an empty canonical store and LOSE the seat that was just
# registered -- the partner reviewer's accept-when #2.
D2="$WORK/direct"; mkdir -p "$D2/index"
TEAM4="$WORK/directteam"; mkdir -p "$TEAM4/.tap/bus/payloads" "$TEAM4/.tap/bus/receipts"
git -C "$TEAM4" init -q; git -C "$TEAM4" config user.email t@t; git -C "$TEAM4" config user.name t
git -C "$TEAM4" commit --allow-empty -qm i >/dev/null
_rc=0
(
  cd "$TEAM4"
  unset TAP_HOME
  export TAP_INDEX_HOME="$D2/index"
  export FAKE_TMUX_PATH="$(cd "$TEAM4" && pwd -P)"
  tap_smoke_quiet "$TAP" in alice --delivery poll
) >/dev/null 2>&1 || _rc=$?
[ "$_rc" = 0 ] && ok "direct tap in returned rc 0" \
  || bad "direct tap in returned $_rc — the canonical-authority assertions below would be reading partial state"
D2_LOC="$(python3 -B -c '
import json,os,sys
try: d=json.load(open(sys.argv[1]))
except Exception: print(""); raise SystemExit
t=(d.get("teams") or {})
e=next(iter(t.values()),{}) if t else {}
loc=e.get("registry_location","")
print(os.path.realpath(loc) if loc else "")' "$D2/index/global-registry.json" 2>/dev/null)"
if [ -n "$D2_LOC" ] && [ "$D2_LOC" = "$(cd "$TEAM4" && pwd -P)/.tap/team-registry.json" ]; then
  ok "direct tap in: authority is the canonical acting store"
else
  bad "direct tap in: authority is '$D2_LOC', expected the canonical team-registry"
fi
if [ -n "$D2_LOC" ] && [ -f "$D2_LOC" ] && grep -q '"alice"' "$D2_LOC"; then
  ok "direct tap in: alice survives in canonical authority (the seat was folded, not lost)"
else
  bad "direct tap in: alice is NOT in the canonical acting registry — the marker moved authority without folding the seat"
fi

# --- CONTROL A: a SEEDED-LIVE machine is unchanged ---------------------------
# Born-live must not alter a machine that was already flipped. If this moves,
# the change is doing something wider than its name.
CTL="$WORK/ctl-live"; mkdir -p "$CTL/index"
python3 -B -c '
import json,sys,os,time
g=sys.argv[1]; os.makedirs(os.path.dirname(g),exist_ok=True)
json.dump({"schema":"0.20","migrated":{"at":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),"backups":{}},"teams":{}},open(g,"w"),indent=2)
' "$CTL/index/global-registry.json"
TEAM2="$WORK/seeded"; mkdir -p "$TEAM2/.tap/bus/payloads" "$TEAM2/.tap/bus/receipts"
git -C "$TEAM2" init -q; git -C "$TEAM2" config user.email t@t; git -C "$TEAM2" config user.name t
git -C "$TEAM2" commit --allow-empty -qm i >/dev/null
# Shell ASSIGNMENTS, not `env`: tap_smoke_quiet is a shell function and `env`
# can only exec a binary -- routing it through env exits 127 with no message.
_rc=0
(
  cd "$TEAM2"
  unset TAP_HOME
  export TAP_INDEX_HOME="$CTL/index"
  export FAKE_TMUX_PATH="$(cd "$TEAM2" && pwd -P)"
  tap_smoke_quiet "$TAP" init
) >/dev/null 2>&1 || _rc=$?
[ "$_rc" = 0 ] || bad "control A: its init returned $_rc — the control below would pass VACUOUSLY, having never reached either index"
[ ! -f "$CTL/index/teams.json" ] \
  && ok "control A: a seeded-live machine still writes no teams.json" \
  || bad "control A: born-live perturbed an already-flipped machine"

# --- CONTROL B: a GENUINE legacy machine stays pre-flip ----------------------
# The rule is "neither store present". A machine that really does hold a legacy
# teams.json is pre-flip and must STAY pre-flip -- born-live must not convert it.
CTL2="$WORK/ctl-legacy"; mkdir -p "$CTL2/index"
printf '%s\n' '{"teams":{}}' > "$CTL2/index/teams.json"
TEAM3="$WORK/legacy"; mkdir -p "$TEAM3/.tap/bus/payloads" "$TEAM3/.tap/bus/receipts"
git -C "$TEAM3" init -q; git -C "$TEAM3" config user.email t@t; git -C "$TEAM3" config user.name t
git -C "$TEAM3" commit --allow-empty -qm i >/dev/null
# Shell ASSIGNMENTS, not `env`: tap_smoke_quiet is a shell function and `env`
# can only exec a binary -- routing it through env exits 127 with no message.
# Ruling 2026-09-23 (F1): init on such a machine refuses with the single old_store
# error and writes nothing -- never a fresh setup on top of the old store.
_rc=0
(
  cd "$TEAM3"
  unset TAP_HOME
  export TAP_INDEX_HOME="$CTL2/index"
  export FAKE_TMUX_PATH="$(cd "$TEAM3" && pwd -P)"
  "$TAP" init
) >"$WORK/ctl-legacy.out" 2>&1 || _rc=$?
[ "$_rc" = 1 ] && grep -q 'teams.json is an old TAP registry format' "$WORK/ctl-legacy.out" \
  && ok "control B: init on a genuine legacy machine refuses old_store (rc 1)" \
  || bad "control B: init returned $_rc without the old_store refusal — the control below would pass VACUOUSLY: $(head -c 300 "$WORK/ctl-legacy.out")"
[ ! -f "$CTL2/index/global-registry.json" ] \
  && ok "control B: a genuine legacy machine is NOT converted to born-live" \
  || bad "control B: born-live flipped a real pre-flip machine — the rule fired on the wrong precondition"

# --- CONTROL C: a DIRECTORY at teams.json is not a legacy store (rule 38) ----
# The predicate asks "does a legacy STORE exist", and a store is a regular file.
# `exists` would count this directory and keep the machine pre-flip forever;
# `isfile` says no store, so born-live proceeds. Rule 38 asks reviewers to bring
# a directory at the tested path -- this brings it.
CTL3="$WORK/ctl-dir"; mkdir -p "$CTL3/index/teams.json"
TEAM5="$WORK/dirteam"; mkdir -p "$TEAM5/.tap/bus/payloads" "$TEAM5/.tap/bus/receipts"
git -C "$TEAM5" init -q; git -C "$TEAM5" config user.email t@t; git -C "$TEAM5" config user.name t
git -C "$TEAM5" commit --allow-empty -qm i >/dev/null
_rc=0
(
  cd "$TEAM5"
  unset TAP_HOME
  export TAP_INDEX_HOME="$CTL3/index"
  export FAKE_TMUX_PATH="$(cd "$TEAM5" && pwd -P)"
  tap_smoke_quiet "$TAP" init
) >/dev/null 2>&1 || _rc=$?
[ "$_rc" = 0 ] || bad "control C: its init returned $_rc — the control below would pass VACUOUSLY, having never reached either index"
[ -f "$CTL3/index/global-registry.json" ] \
  && ok "control C: a directory at teams.json is not a legacy store — born-live still fires" \
  || bad "control C: a directory at teams.json was treated as a legacy store (exists vs isfile — rule 38)"

# --- HOSTILE MARKER ENTRIES (rule 38 corpus / rule 19) ----------------------
# The partner reviewer's production probe: with a DIRECTORY at global-registry.json,
# `tap in` returned 0 and wrote the retired bus registry; with a
# SYMLINK-TO-DIRECTORY it replaced the symlink with the marker. Infrastructure
# failure became predicate-false and then a successful mutation.
#
# Each row asserts all three properties, because any one alone is satisfiable by
# the wrong behaviour: NONZERO status, NO retired-bus mutation, and the hostile
# entry PRESERVED (not silently replaced).
hostile_row() { # <label> <setup-fn>
  local label="$1" setup="$2" home team rc
  home="$WORK/hostile-$label"; team="$WORK/hostileteam-$label"
  mkdir -p "$home" "$team/.tap/bus/payloads" "$team/.tap/bus/receipts"
  git -C "$team" init -q; git -C "$team" config user.email t@t; git -C "$team" config user.name t
  git -C "$team" commit --allow-empty -qm i >/dev/null
  "$setup" "$home/global-registry.json"
  rc=0
  (
    cd "$team"
    unset TAP_HOME
    export TAP_INDEX_HOME="$home"
    export FAKE_TMUX_PATH="$(cd "$team" && pwd -P)"
    # --delivery poll, as the original production specimen used: this fixture
    # answers display-message but NOT list-panes, so an implicit pane shape
    # refuses on PANE DISCOVERY. All three rows would then pass while proving
    # nothing about the marker (partner review, P1b).
    # BOUNDED, because one of these hostile shapes can BLOCK rather than refuse.
    # A FIFO at the marker path is openable and never returns without a writer,
    # and this call routes through the native reader. Unbounded, a classifier
    # regression does not red this row -- it hangs the FILE, and a file that
    # hangs takes the whole gate's wall clock with it instead of reporting.
    # 30s is far above any legitimate refusal path here; it is a deadline, not
    # a performance assertion.
    timeout 30 "$TAP" in alice --delivery poll
  ) >"$WORK/hostile-$label.out" 2>&1 || rc=$?
  if [ "$rc" = 124 ]; then
    bad "hostile $label: tap in HUNG at the marker path (deadline kill) — a blocking read is not a refusal"
  elif [ "$rc" != 0 ]; then
    ok "hostile $label: tap in refuses (rc $rc)"
  else
    bad "hostile $label: tap in returned 0 — infrastructure failure became a successful registration (rule 19)"
  fi
  # AND it refuses for the MARKER, not for something incidental.
  if grep -qiE "global-registry|machine index|polarity|born.live|flip marker" "$WORK/hostile-$label.out"; then
    ok "hostile $label: the refusal names the marker, not an unrelated cause"
  else
    bad "hostile $label: refused for an unrelated reason — $(tr '\n' ' ' <"$WORK/hostile-$label.out" | head -c 200)"
  fi
  [ ! -s "$team/.tap/bus/registry.json" ] \
    && ok "hostile $label: no retired bus registry was written" \
    || bad "hostile $label: wrote the retired bus registry while the marker path was unusable"
}
mk_dir()      { mkdir -p "$1"; }
mk_symdir()   { mkdir -p "$1.target"; ln -s "$1.target" "$1"; }
mk_brokenln() { ln -s "$1.nonexistent" "$1"; }

hostile_row directory mk_dir
[ -d "$WORK/hostile-directory/global-registry.json" ] \
  && ok "hostile directory: the entry is preserved, not replaced" \
  || bad "hostile directory: the directory at the marker path was destroyed"

hostile_row symlink-to-directory mk_symdir
[ -L "$WORK/hostile-symlink-to-directory/global-registry.json" ] \
  && ok "hostile symlink-to-directory: the symlink is preserved, not replaced" \
  || bad "hostile symlink-to-directory: the symlink was replaced by the marker"

# FIFO at the marker path (review, live-probe hardening). A FIFO is not
# a regular file, so it is an INVALID marker, not an absent one. It earns its own
# row because it is the one hostile shape that could HANG a reader rather than
# refuse: the classifier's lexists-before-open ordering is what makes this row
# terminate, and a reordering that opened first would block on the FIFO forever.
mk_fifo()     { mkfifo "$1"; }

hostile_row fifo mk_fifo
[ -p "$WORK/hostile-fifo/global-registry.json" ] \
  && ok "hostile fifo: the FIFO is preserved, not replaced" \
  || bad "hostile fifo: the FIFO at the marker path was replaced or destroyed"

hostile_row broken-symlink mk_brokenln
[ -L "$WORK/hostile-broken-symlink/global-registry.json" ] \
  && ok "hostile broken-symlink: the symlink is preserved" \
  || bad "hostile broken-symlink: the symlink was replaced"


# --- SHAPE 4: a root the index CANNOT hold is NOT APPLICABLE, not flippable ---
#
# `tap_index_enroll_team` has always skipped a non-canonical TAP_HOME as
# unindexable by design, so such a team has no post-flip existence at all:
# tap_authority_context on `live` resolves only through the machine index.
# Born-live firing there manufactured a polarity the enroller then refused to
# record -- 53 fixtures on the born-live gate, every one of them a `mktemp -d`
# TAP_HOME. The contract's answer is not-applicable: no marker, no teams.json,
# the caller keeps its pre-flip world exactly as on main.
CUSTOM_HOME="$(mktemp -d "$WORK/custom-bus.XXXXXX")"
CUSTOM_IDX="$WORK/custom-index"; mkdir -p "$CUSTOM_IDX"
(
  cd "$TEAM"
  TAP_INDEX_HOME="$CUSTOM_IDX" TAP_HOME="$CUSTOM_HOME" \
    tap_smoke_quiet "$TAP" in carol --delivery poll
) >/dev/null 2>&1 || true
[ ! -e "$CUSTOM_IDX/global-registry.json" ] \
  && ok "custom TAP_HOME: not applicable — no flip marker published" \
  || bad "custom TAP_HOME: born-live published a marker for a root the enroller refuses to index"

# --- SHAPE 5: no TAP state is created OUTSIDE the pinned roots ---------------
#
# THE CONTROL THAT WOULD HAVE CAUGHT THE SPECIMEN. Six green controls, a
# falsifier and a clean `git status` all passed while a custom-TAP_HOME
# register wrote `<checkout>/.tap/bus/{payloads,receipts}` and
# `<checkout>/.tap/team-registry.json` into the repository under test, through
# the tap-nvtx bootstrap door on an ALREADY-LIVE machine. `git status` could
# not see it because `.gitignore` ignores `.tap`, so cleanliness checks that
# read git were structurally incapable of reporting it. This arm reads the
# filesystem instead, and it asserts about the real checkout ($ROOT) rather
# than the fixture -- the escape landed outside every sandbox root.
#
# Live marker + custom home is the exact shape: on a live machine the door is
# reachable regardless of which fence published the marker, so this arm still
# fails if born-live is removed entirely.
# WHAT THIS ASSERTS, and why not "the checkout has no .tap": absolute absence is
# order-dependent and fails on state ANY earlier run left behind -- the first cut
# of this arm reddened on debris from its own mutation run, which is a false
# positive, not a finding. The property that matters is that THIS register wrote
# nothing, so the arm stamps a reference file and asks for entries newer than it.
#
# LICENSING-ZERO: `find` over a missing directory prints nothing and a bare empty
# result would LICENSE the pass. The instrument must be able to refuse, so a find
# that fails is recorded as a distinct value and fails the arm, and the
# no-directory case is decided before find is asked anything.
ESCAPE_STAMP="$WORK/escape-stamp"; : >"$ESCAPE_STAMP"
LIVE_IDX="$WORK/live-index"; mkdir -p "$LIVE_IDX"
printf '{"schema":"0.20","teams":{}}\n' >"$LIVE_IDX/global-registry.json"
ESCAPE_HOME="$(mktemp -d "$WORK/escape-bus.XXXXXX")"
(
  cd "$ROOT"
  TAP_INDEX_HOME="$LIVE_IDX" TAP_HOME="$ESCAPE_HOME" \
    tap_smoke_quiet "$TAP" in dave --delivery poll
) >/dev/null 2>&1 || true
if [ -d "$ROOT/.tap" ]; then
  ESCAPED="$(find "$ROOT/.tap" -newer "$ESCAPE_STAMP" -print 2>/dev/null)" \
    || ESCAPED="__find_failed__"
else
  ESCAPED=""
fi
if [ "$ESCAPED" = "__find_failed__" ]; then
  bad "sandbox-escape control could not read $ROOT/.tap — the instrument failed, so this arm proves nothing"
elif [ -z "$ESCAPED" ]; then
  ok "custom TAP_HOME on a live machine wrote nothing into the checkout"
else
  bad "a custom-TAP_HOME register wrote TAP state into the repository checkout — the tap-nvtx bootstrap door escaped its sandbox: $(printf '%s' "$ESCAPED" | tr '\n' ' ' | head -c 200)"
fi


# --- SHAPE 6: a NON-GIT folder is indexable only on explicit init consent -----
#
# Ruling 2026-09-23 (F1): a non-git folder enrolls only through `tap init` or a
# first launch, after its owner consents (`--yes` for scripts). Without that
# consent, neither public door may publish index authority or write the folder:
# a TAP_HOME-only predicate would otherwise key machine-index authority on any
# folder basename (review P1). Both PUBLIC doors are exercised
# unconsented; the positive half proves the consented init enrolls the folder.
nongit_door() { # <label> <verb...>
  local label="$1"; shift
  local folder idx
  # PHYSICAL path, or this arm proves nothing. mktemp hands back /var/folders/...
  # while the predicate resolves canon_root with `pwd -P` to /private/var/... .
  # A logical fixture path therefore fails the TAP_HOME comparison BEFORE the
  # git check is ever consulted, and the arm goes green for a reason that has
  # nothing to do with the property under test — measured: the git-half mutant
  # SURVIVED this arm until the path was canonicalised here.
  folder="$(cd "$(mktemp -d "$WORK/nongit-$label.XXXXXX")" && pwd -P)"
  idx="$WORK/nongit-idx-$label"; mkdir -p "$idx"
  [ ! -d "$folder/.git" ] || { bad "nongit $label: fixture folder is a git repo — the control proves nothing"; return; }
  (
    cd "$folder"
    TAP_INDEX_HOME="$idx" tap_smoke_quiet "$TAP" "$@"
  ) >/dev/null 2>&1 || true
  [ ! -e "$idx/global-registry.json" ] \
    && ok "nongit $label: no flip marker published for a non-git folder" \
    || bad "nongit $label: a non-git folder published global-registry.json — index authority would key on a folder basename"
  [ ! -e "$idx/teams.json" ] \
    && ok "nongit $label: no legacy store written either" \
    || bad "nongit $label: a non-git folder wrote the retired teams.json"
}
nongit_door init in-it init
nongit_door register in erin --delivery poll

# The positive half: consent (`--yes`) initializes and enrolls the folder itself;
# without it, init refuses and writes nothing into the folder.
NONGIT_LOCAL="$(cd "$(mktemp -d "$WORK/nongit-local.XXXXXX")" && pwd -P)"
NONGIT_LOCAL_IDX="$WORK/nongit-idx-local"; mkdir -p "$NONGIT_LOCAL_IDX"
(
  cd "$NONGIT_LOCAL"
  TAP_INDEX_HOME="$NONGIT_LOCAL_IDX" tap_smoke_quiet "$TAP" init
) >/dev/null 2>&1 || true
[ ! -e "$NONGIT_LOCAL/.tap" ] \
  && ok "nongit init without consent: nothing written into the folder" \
  || bad "nongit init without consent wrote $NONGIT_LOCAL/.tap"
(
  cd "$NONGIT_LOCAL"
  TAP_INDEX_HOME="$NONGIT_LOCAL_IDX" tap_smoke_quiet "$TAP" init --yes --no-trust-folders
) >/dev/null 2>&1 || true
[ -d "$NONGIT_LOCAL/.tap/bus" ] && [ -f "$NONGIT_LOCAL/.tap/team-registry.json" ] \
  && ok "nongit init --yes: the folder gets its own bus and current team registry" \
  || bad "nongit init --yes: no local bus or team registry"
grep -q "\"root\": \"$NONGIT_LOCAL\"" "$NONGIT_LOCAL_IDX/global-registry.json" 2>/dev/null \
  && ok "nongit init --yes: the consented folder is enrolled at its own root" \
  || bad "nongit init --yes: the consented folder is not enrolled in the machine index"


# --- SHAPE 7: the NATIVE marker reader must terminate on a FIFO --------------
#
# The Bash FIFO row above proves python's flip_marker_state, which refuses on
# kind without opening. Its native twin (runtime/bun/src/index-home.ts) did
# existsSync + readFileSync: a FIFO EXISTS, and opening it for read blocks until
# a writer appears -- indefinitely, no timeout, no error. So the Bash row proved
# one classifier while the other kept the exact hang the row claims to prevent
# (partner review). This arm drives the NATIVE reader through the public bin/tap.
#
# IT ASSERTS TERMINATION, which is why it is shaped as a deadline rather than as
# an exit code: a hang has no exit status to compare. `timeout` returns 124 iff
# the deadline killed the process, so 124 is the ONLY failing value -- any other
# status means the reader reached a decision, which is the property under test.
# A refusal is a pass here; only "never came back" is a failure.
NATIVE_FIFO_IDX="$WORK/native-fifo-index"; mkdir -p "$NATIVE_FIFO_IDX"
mkfifo "$NATIVE_FIFO_IDX/global-registry.json"
if [ -x "$ROOT/bin/tap" ]; then
  _fifo_rc=0
  TAP_INDEX_HOME="$NATIVE_FIFO_IDX" timeout 15 "$ROOT/bin/tap" whoami >/dev/null 2>&1 || _fifo_rc=$?
  [ "$_fifo_rc" != 124 ] \
    && ok "native marker reader terminates on a FIFO (rc $_fifo_rc, not a deadline kill)" \
    || bad "native marker reader HUNG on a FIFO at the marker path — readFileSync blocked with no writer"
  unset _fifo_rc
else
  bad "native FIFO control could not run: $ROOT/bin/tap is not executable — the arm proves nothing"
fi

# --- SHAPE 8: already-live + non-git `tap init` writes no team state ---------
#
# `tap init` on an ALREADY-LIVE machine reaches the first-entry writer through
# live_unenrolled. Enrollment refusing afterwards is too late: the store would
# already be on disk, so a non-git folder must be refused before any write.
AL_IDX="$WORK/already-live-index"; mkdir -p "$AL_IDX"
printf '{"schema":"0.20","teams":{}}\n' >"$AL_IDX/global-registry.json"
AL_FOLDER="$(cd "$(mktemp -d "$WORK/already-live-nongit.XXXXXX")" && pwd -P)"
[ ! -d "$AL_FOLDER/.git" ] || bad "already-live nongit: fixture folder is a git repo — the control proves nothing"
(
  cd "$AL_FOLDER"
  TAP_INDEX_HOME="$AL_IDX" tap_smoke_quiet "$TAP" init
) >/dev/null 2>&1 || true
[ ! -e "$AL_FOLDER/.tap/team-registry.json" ] \
  && ok "already-live nongit init: no team-registry.json written into the folder" \
  || bad "already-live nongit init: the bootstrap helper wrote $AL_FOLDER/.tap/team-registry.json — gating the call sites missed the writer"
if grep -q '"teams": *{}' "$AL_IDX/global-registry.json" 2>/dev/null \
   || ! grep -q "$(basename "$AL_FOLDER")" "$AL_IDX/global-registry.json" 2>/dev/null; then
  ok "already-live nongit init: the folder was not enrolled in the machine index"
else
  bad "already-live nongit init: a non-git folder appears in global-registry.json"
fi


# --- tap-14zzv: both first-entry doors bootstrap the SAME team block -----------
# The born-live change made `tap register` a born-live first-entry door alongside `tap init`, and
# the two then disagreed about the document they bootstrap. Register reaches the
# canonical store AFTER registry_v20.empty_team_registry() has already written a
# two-field team block (name, worktree_root), so ensureTeamBlock (register.ts)'s
# full-block branch never ran and the store kept no schema_version, created_at or
# branch_at_bootstrap. The divergence lived in regress/ — the bucket that does not
# gate — so this arm brings the question into the gating one.
tb_store() { # <root> — the store the marker actually selected
  if [ -f "$1/.tap/team-registry.json" ]; then printf '%s\n' "$1/.tap/team-registry.json"
  else printf '%s\n' "$1/.tap/bus/registry.json"; fi
}
tb_missing() { # <acting-store> — names the fields a first-entry door owes
  python3 -B -c '
import json, sys
team = json.load(open(sys.argv[1])).get("team") or {}
print(",".join(k for k in ("branch_at_bootstrap", "created_at", "name", "schema_version", "worktree_root") if not team.get(k)))
' "$1"
}
tb_field() { # <acting-store> <key>
  python3 -B -c '
import json, sys
print((json.load(open(sys.argv[1])).get("team") or {}).get(sys.argv[2], ""))
' "$1" "$2"
}
tb_new_repo() { mkdir -p "$1" && git init -q "$1" && git -C "$1" config user.email t@example.invalid \
  && git -C "$1" config user.name t && touch "$1/r" && git -C "$1" add r && git -C "$1" commit -q -m i; }

TB_IDX="$WORK/tb-index"; mkdir -p "$TB_IDX"
TB_REG="$WORK/tb-register-first"; TB_INI="$WORK/tb-init-first"
tb_new_repo "$TB_REG"; tb_new_repo "$TB_INI"
( cd "$TB_REG" && unset TAP_HOME && TAP_INDEX_HOME="$TB_IDX" tap_smoke_quiet "$TAP" register tbseat --offline ) >/dev/null 2>&1 || true
( cd "$TB_INI" && unset TAP_HOME && TAP_INDEX_HOME="$TB_IDX" tap_smoke_quiet "$TAP" init ) >/dev/null 2>&1 || true

tb_ini_missing="$(tb_missing "$(tb_store "$TB_INI")" 2>/dev/null || echo READ-FAILED)"
tb_reg_missing="$(tb_missing "$(tb_store "$TB_REG")" 2>/dev/null || echo READ-FAILED)"
[ "$tb_ini_missing" = "" ] \
  && ok "the init door bootstraps a complete team block" \
  || bad "the init door left fields empty: $tb_ini_missing"
[ "$tb_reg_missing" = "" ] \
  && ok "the register door bootstraps a complete team block (tap-14zzv)" \
  || bad "REGISTER DOOR WRITES A THIN TEAM BLOCK: missing $tb_reg_missing — the two first-entry doors disagree about what they bootstrap"

# The corner the convergence arms above cannot see: every fixture repo so far has
# a resolvable branch, so both doors agreed on branch_at_bootstrap for the only
# input the arms supply. An UNBORN repo (git init, no commit) is where the first
# cut of this fix diverged — `rev-parse --abbrev-ref HEAD` prints "HEAD" and exits
# 128 there, while the incumbent `symbolic-ref --quiet --short HEAD` prints the
# branch. Asserting the two doors AGREE, rather than asserting a literal, is what
# keeps this arm true if the incumbent derivation itself ever changes.
TB_UNB_REG="$WORK/tb-unborn-register"; TB_UNB_INI="$WORK/tb-unborn-init"
mkdir -p "$TB_UNB_REG" "$TB_UNB_INI"
git init -q "$TB_UNB_REG"; git init -q "$TB_UNB_INI"   # no commit: HEAD is unborn
( cd "$TB_UNB_REG" && unset TAP_HOME && TAP_INDEX_HOME="$TB_IDX" tap_smoke_quiet "$TAP" register tbunborn --offline ) >/dev/null 2>&1 || true
( cd "$TB_UNB_INI" && unset TAP_HOME && TAP_INDEX_HOME="$TB_IDX" tap_smoke_quiet "$TAP" init ) >/dev/null 2>&1 || true
tb_unb_reg_branch="$(tb_field "$(tb_store "$TB_UNB_REG")" branch_at_bootstrap 2>/dev/null || echo READ-FAILED)"
tb_unb_ini_branch="$(tb_field "$(tb_store "$TB_UNB_INI")" branch_at_bootstrap 2>/dev/null || echo READ-FAILED)"
[ -n "$tb_unb_reg_branch" ] && [ -n "$tb_unb_ini_branch" ] && [ "$tb_unb_reg_branch" = "$tb_unb_ini_branch" ] \
  && ok "on an UNBORN repo both doors record the same branch_at_bootstrap ('$tb_unb_reg_branch')" \
  || bad "unborn-repo branch_at_bootstrap diverges: register='$tb_unb_reg_branch' init='$tb_unb_ini_branch' — a convergence fix that derives the value its own way converges presence while diverging value"

# The residue, pinned rather than left to be discovered. This fix is at the
# CREATION site, so it completes stores it brings into being. A store written thin
# by the pre-fix code is NOT retroactively completed: `tap init` on a repo whose
# canonical store already exists resolves live_unenrolled and enrolls it without
# reaching ensureTeamBlock (register.ts), the only place that composes a block for an
# EXISTING document. Asserting the residue keeps it a known boundary instead of an
# oversight someone re-discovers as a bug (tap-14zzv carries the scope note).
TB_THIN="$WORK/tb-thin"
tb_new_repo "$TB_THIN"
mkdir -p "$TB_THIN/.tap"
TB_THIN_CANON="$(cd "$TB_THIN" && pwd -P)"
cat > "$TB_THIN/.tap/team-registry.json" <<JSON
{ "schema": "0.20",
  "seats": {},
  "team": { "name": "tb-thin", "worktree_root": "$TB_THIN_CANON" } }
JSON
( cd "$TB_THIN" && unset TAP_HOME && TAP_INDEX_HOME="$TB_IDX" tap_smoke_quiet "$TAP" init ) >/dev/null 2>&1 || true
tb_thin_missing="$(tb_missing "$(tb_store "$TB_THIN")" 2>/dev/null || echo READ-FAILED)"
[ "$tb_thin_missing" = "branch_at_bootstrap,created_at,schema_version" ] \
  && ok "a store written thin BEFORE this fix stays thin (creation-site scope, pinned)" \
  || bad "the residue changed: expected branch_at_bootstrap,created_at,schema_version still missing, got '$tb_thin_missing' — if a later command now completes it, this arm and tap-14zzv's scope note are both stale"
tb_thin_name="$(tb_field "$(tb_store "$TB_THIN")" name 2>/dev/null || echo READ-FAILED)"
[ "$tb_thin_name" = "tb-thin" ] \
  && ok "a pre-existing store keeps the values its own door wrote" \
  || bad "an existing team value changed: name is '$tb_thin_name'"

# --- U1 CONVERGENCE (tap-q4fw5 / tap-moa6x): one helper owns first-entry ------
#
# Both public first-entry doors reach ONE native sequence (register-authority.ts
# bootstrapPostflipEnroll). Register first safety-preflights any existing bus
# registry; an unreadable one refuses before entering that sequence. Three
# permanent controls:
#
#   U1.1  fresh public `tap init` writes the schema-0.20 acting document, not
#         the legacy ['agents','team'] shape.
#   U1.2  register-first with a pre-existing bus row folds it in — `tap in bob`
#         must not strand seats only the init door used to pick up.
#   U1.3  an UNREADABLE target bus registry refuses BEFORE the sequence via the
#         bound-root resolver (slice_failed, action "tap register", detail
#         "bound-root resolver failed"); no acting store is created.

u1_new_repo() { # <path> — git repo with a canonical bus, no TAP state anywhere
  mkdir -p "$1/.tap/bus/payloads" "$1/.tap/bus/receipts"
  git -C "$1" init -q
  git -C "$1" config user.email t@example.invalid
  git -C "$1" config user.name t
  git -C "$1" commit --allow-empty -qm i >/dev/null
}
u1_seed_legacy_bus() { # <bus-registry-path> <team-name> <canon-root> <handle>
  python3 -B - "$1" "$2" "$3" "$4" <<'PY'
import json, sys
path, name, canon, handle = sys.argv[1:5]
# old-shape fixture: seeds a pre-v0.20 agents bus store for the U1 old-store door
doc = {"schema": "0.19",
       "team": {"name": name, "worktree_root": canon},
       "agents": {handle: {"delivery": "poll", "pane": "",
                           "instance": handle + "|0000000000000000"}}}
with open(path, "w") as fh:
    json.dump(doc, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY
}

# U1.1 — fresh public `tap init`: the acting document shape.
U1_IDX="$WORK/u1-init-index"; mkdir -p "$U1_IDX"
U1_TEAM="$WORK/u1initteam"; u1_new_repo "$U1_TEAM"
_rc=0
(
  cd "$U1_TEAM"
  unset TAP_HOME
  TAP_INDEX_HOME="$U1_IDX" tap_smoke_quiet "$TAP" init
) >/dev/null 2>&1 || _rc=$?
[ "$_rc" = 0 ] || bad "U1.1: tap init returned $_rc — the acting-store assertions below would read partial state"
U1_CANON="$(cd "$U1_TEAM" && pwd -P)"
if [ -f "$U1_TEAM/.tap/team-registry.json" ]; then
  if python3 -B - "$U1_TEAM/.tap/team-registry.json" "$(basename "$U1_CANON")" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
base = sys.argv[2]
assert doc.get("schema") == "0.20", f"schema is {doc.get('schema')!r}, not '0.20'"
assert isinstance(doc.get("seats"), dict), f"seats axis missing or not a map: {sorted(doc)}"
assert "agents" not in doc, f"legacy agents axis present: {sorted(doc)}"
team = doc.get("team") or {}
assert team.get("name") == base, f"team.name is {team.get('name')!r}, expected basename {base!r}"
for field in ("branch_at_bootstrap", "created_at", "schema_version"):
    assert team.get(field), f"team.{field} missing/empty"
PY
  then ok "U1.1: fresh tap init wrote the schema-0.20 acting document (seats map, no agents, complete team block)"
  else bad "U1.1: fresh tap init acting store is not the schema-0.20 shape (tap-q4fw5)"
  fi
else
  bad "U1.1: no acting team-registry.json after fresh tap init (tap-q4fw5)"
fi

# U1.2 — register refuses the retired store without folding or writing it.
U1_R_IDX="$WORK/u1-regfirst-index"; mkdir -p "$U1_R_IDX"
U1_R_TEAM="$WORK/u1regteam"; u1_new_repo "$U1_R_TEAM"
U1_R_CANON="$(cd "$U1_R_TEAM" && pwd -P)"
u1_seed_legacy_bus "$U1_R_TEAM/.tap/bus/registry.json" "$(basename "$U1_R_CANON")" "$U1_R_CANON" alice
cp "$U1_R_TEAM/.tap/bus/registry.json" "$WORK/u1-old-store.before"
_rc=0
(
  cd "$U1_R_TEAM"
  unset TAP_HOME
  TAP_INDEX_HOME="$U1_R_IDX" FAKE_TMUX_PATH="$U1_R_CANON" \
    "$TAP" in bob --delivery poll --json
) >"$WORK/u1-old-store.out" 2>&1 || _rc=$?
if [ "$_rc" = 1 ] && grep -q '"error_class":"old_store"' "$WORK/u1-old-store.out" \
  && cmp -s "$WORK/u1-old-store.before" "$U1_R_TEAM/.tap/bus/registry.json" \
  && [ ! -e "$U1_R_TEAM/.tap/team-registry.json" ] && [ ! -e "$U1_R_IDX/global-registry.json" ]; then
  ok "U1.2: register refuses old-store, preserves alice and creates no current authority"
else
  bad "U1.2: register must refuse the old store intact before any bootstrap"
fi

# U1.3 — an unreadable bus registry refuses BEFORE enrollment.
U1_B_IDX="$WORK/u1-badbus-index"; mkdir -p "$U1_B_IDX"
U1_B_TEAM="$WORK/u1badteam"; u1_new_repo "$U1_B_TEAM"
U1_B_CANON="$(cd "$U1_B_TEAM" && pwd -P)"
# old-shape fixture: truncated old-shape bytes; U1.3 asserts an unreadable bus refuses
printf '{ "agents": {' > "$U1_B_TEAM/.tap/bus/registry.json"   # truncated: unreadable
_rc=0
(
  cd "$U1_B_TEAM"
  unset TAP_HOME
  # JSON surface, because that is where the TYPED class is observable: plain
  # tap_error_line renders only "<verb>: <detail>; next: <action>" and never
  # the class name, so the plan's named class is assertable only through the
  # error-JSON. MEASURED: env TAP_JSON=1 does NOT reach this verb — register
  # hard-initializes TAP_JSON=0 and only the public --json flag sets it — so
  # the surface is switched with the flag, which is the public way to ask for
  # it. The fold reader's own stderr line stays plain text either way.
  TAP_INDEX_HOME="$U1_B_IDX" FAKE_TMUX_PATH="$U1_B_CANON" \
    timeout 30 "$TAP" in bob --delivery poll --json
) >"$WORK/u1-badbus.out" 2>&1 || _rc=$?
if [ "$_rc" = 124 ]; then
  bad "U1.3: tap in HUNG on the unreadable bus registry (deadline kill) — a blocking read is not a refusal"
elif [ "$_rc" != 0 ]; then
  ok "U1.3: tap in refuses on an unreadable bus registry (rc $_rc)"
else
  bad "U1.3: tap in returned 0 with an unreadable bus registry — the bound-root refusal never fired (tap-moa6x, fail-closed half)"
fi
_u1_b_out="$(cat "$WORK/u1-badbus.out" 2>/dev/null || true)"
# C5 refuses an old bus store before attempting to parse or migrate it.
case "$_u1_b_out" in
  *'"error_class":"old_store"'*) ok "U1.3: the refusal is error_class old_store (JSON surface)" ;;
  *) bad "U1.3: output does not carry error_class old_store — got: $(printf '%s' "$_u1_b_out" | tr '\n' ' ' | head -c 200)" ;;
esac
case "$_u1_b_out" in
  *'"action":"ask an agent to upgrade this file to the current format by hand'*) ok "U1.3: the refusal names its action (hand upgrade)" ;;
  *) bad "U1.3: output does not carry the hand-upgrade action — got: $(printf '%s' "$_u1_b_out" | tr '\n' ' ' | head -c 200)" ;;
esac
case "$_u1_b_out" in
  *"is an old TAP registry format"*) ok "U1.3: the detail names the bound-root resolver failure" ;;
  *) bad "U1.3: output does not carry 'is an old TAP registry format' — got: $(printf '%s' "$_u1_b_out" | tr '\n' ' ' | head -c 200)" ;;
esac
# Post-refusal state: the bound-root preflight runs before create, fold, or
# enrollment, so no acting store, enrollment entry, or bob seat may exist.
if python3 -B - "$U1_B_IDX/global-registry.json" "$U1_B_IDX/teams.json" "$U1_B_CANON" <<'PY'
import json, os, sys
gpath, tpath, canon = sys.argv[1:4]
base = os.path.basename(canon)
enrolled = []
for p in (gpath, tpath):
    if os.path.isfile(p):
        data = json.load(open(p))
        enrolled += list((data.get("teams") or {}).keys())
assert base not in enrolled, f"the team was enrolled despite the bound-root refusal: {enrolled}"
loc = os.path.join(canon, ".tap", "team-registry.json")
assert not os.path.exists(loc), f"acting store was created before the bound-root refusal: {loc}"
PY
then
  ok "U1.3: no acting store, enrollment entry, or bob seat after the bound-root refusal"
else
  bad "U1.3: post-refusal state is wrong — an acting store, enrollment entry, or seat leaked past the refusal"
fi

# --- review finding: a MALFORMED acting store refuses ---
#
# Live marker + unenrolled root + pre-existing malformed acting registry +
# absent bus registry: the public live_unenrolled door (`tap init`) must refuse
# and must NOT enroll the root. The former unconditional no-op on an existing
# file let any bytes at the acting path sail through fold/enrollment and become
# authority. Two malformed shapes are exercised: unparseable bytes, and a
# parseable legacy-shape document (no schema, agents axis). The malformed file
# is asserted byte-preserved — refuse, never clobber. A VALID pre-existing
# schema-0.20 store keeps enrolling unchanged (the tap-thin arms pin that side).
malformed_acting_row() { # <label> <shape:unparseable|legacy-shape>
  local label="$1" shape="$2" idx team canon
  idx="$WORK/u15-idx-$label"; mkdir -p "$idx"
  printf '{"schema":"0.20","teams":{}}\n' > "$idx/global-registry.json"
  team="$WORK/u15-team-$label"; u1_new_repo "$team"
  canon="$(cd "$team" && pwd -P)"
  case "$shape" in
    unparseable)  printf '{ not json at all' > "$team/.tap/team-registry.json" ;;
    # old-shape fixture: U1.5 legacy-shape acting row must refuse as old_store
    legacy-shape) printf '{ "team": { "name": "%s", "worktree_root": "%s" }, "agents": {} }\n' \
                    "$(basename "$canon")" "$canon" > "$team/.tap/team-registry.json" ;;
  esac
  cp "$team/.tap/team-registry.json" "$WORK/u15-copy-$label"
  _rc=0
  (
    cd "$team"
    unset TAP_HOME
    TAP_INDEX_HOME="$idx" tap_smoke_quiet "$TAP" init
  ) >/dev/null 2>&1 || _rc=$?
  [ "$_rc" != 0 ] \
    && ok "malformed acting ($shape): tap init refuses (rc $_rc)" \
    || bad "malformed acting ($shape): tap init returned 0 — a malformed store at the acting path was enrolled over as authority"
  if python3 -B - "$idx/global-registry.json" "$(basename "$canon")" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
base = sys.argv[2]
assert base not in (data.get("teams") or {}), f"{base} was enrolled: {data.get('teams')}"
PY
  then ok "malformed acting ($shape): the root was NOT enrolled"
  else bad "malformed acting ($shape): the root was enrolled in the machine index despite the malformed acting store"
  fi
  cmp -s "$team/.tap/team-registry.json" "$WORK/u15-copy-$label" \
    && ok "malformed acting ($shape): the malformed file is preserved, not clobbered" \
    || bad "malformed acting ($shape): the refusal path modified the malformed store"
}
malformed_acting_row unparseable unparseable
malformed_acting_row legacy legacy-shape

echo
printf 'born-live-enroll: %d passed, %d failed\n' "$pass" "$fail_n"
[ "$fail_n" -eq 0 ] || exit 1
