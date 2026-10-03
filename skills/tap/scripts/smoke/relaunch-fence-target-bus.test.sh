#!/usr/bin/env bash
# tap-o4ae: fixture env must stay in this process.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# relaunch-fence-target-bus.test.sh (tap-834qn) — a relaunch fences the TARGET
# team's bus, and a cross-team send/drain consults THAT bus.
#
# WHY THIS FILE IS NOT A COPY OF courier-clear-fence.test.sh. That file (tap-36kb)
# already owns the content-vs-lock matrix — live parks, drain holds, urgent
# refuses, dead+fresh parks (the falsifying arm), dead+stale delivers — and
# `tap clear` and `tap session relaunch` enter the SAME
# replace_harness_in_pane / clear_fence.try_acquire transaction. Re-running those
# five arms under a "relaunch" label would be a file that cannot fail for a new
# reason. The class that CAN fail for a new reason is target-bus selection: a
# cross-team relaunch must fence B while a caller in A consults B's fence. Review
# round 2 of tap-834qn found exactly that defect in the post-acquire recheck,
# which had resolved the caller's ambient bus.
#
# Which assertion a mutation must redden:
#   fence placed on A instead of B   → arm 1 (marker present under B, absent under A)
#   send consults caller's own bus   → arm 2 (A->B must park reason=clearing)
#   drain re-derives the caller bus  → arm 3 (A's drain must HOLD while B is live)
#   ambient-bus placement anywhere   → arm 4 (A's own same-named seat still delivers)
#   urgent routed to the wrong bus   → arm 5 (recipient_clearing, no spool/canonical)
#   expiry read on the wrong bus     → arm 6 (fail-open + parked item releases)
#   fence never released             → arm 6 (marker gone after harness readiness)
#
# The initial marker is NEVER hand-shaped: arm 1 runs the real
# `tap session relaunch` and uses the marker it materializes as the barrier for
# arms 2-5. Only arm 6's EXPIRED fence is fixture-written, after the real one has
# been released.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

export TAP_SPOOL_DISABLE_OPPORTUNISTIC=1 TAP_SPOOL_DISABLE_DELIVERER=1
export TAP_TUI_SETTLE_SCALE=0.1
unset TAP_CLEAR_ID

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
LIB="$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
# WORKSPACE OWNERSHIP IS THE WHOLE CLEANUP DESIGN NOW. Under the runner the
# workspace is minted inside TAP_SUITE_SANDBOX when one exists, purely so that
# residue stays local if a run is killed before the trap fires. That is a
# tidiness preference and NOT a claim that anyone else removes it: this test
# removes its own workspace in every mode. What must never ship is a bare mktemp
# whose result is thrown away — measured: TMPDIR is not redirected under
# smoke-all, so an abandoned tree lands outside the sandbox, nothing reaps it,
# and it leaks once per suite run while every run still passes.
# ONE PATH, MINTED BY US, REMOVED BY US, IN EVERY MODE. Earlier shapes tried to
# decide whether somebody else would reap the workspace — first from
# "TAP_SUITE_SANDBOX is set", then from its basename. Both were labels standing in
# for authority, and both were shown green over a directory nobody reaps. A child
# cannot observe a parent reaper at all, so the question has no answer from in
# here and the right move is to stop asking it: this test removes exactly the one
# path it created, always, including inside the runner's sandbox.
#
# That is not the hazard the earlier rounds were about. The class that kept
# reappearing was DECIDING whether to delete from a probe that could be wrong or
# unanswerable. There is no decision here — no predicate, no lsof, no recursion,
# no ownership label. Minting inside the runner's sandbox when one exists is a
# tidiness preference, not a safety claim: it keeps residue local when a run is
# killed before the trap fires.
if [ -n "${TAP_SUITE_SANDBOX:-}" ] && [ -d "${TAP_SUITE_SANDBOX}" ]; then
  W="$(mktemp -d "$TAP_SUITE_SANDBOX/relaunch-fence.XXXXXX")"
else
  W="$(mktemp -d)"
fi

remove_workspace() { # <path> -> 0 ONLY when the path is actually gone
  # Outcome-bearing on purpose. `rm -rf` can fail, and it can also exit 0 having
  # removed only part of a tree, so the answer is the path's absence rather than
  # rm's status.
  [ -n "${1:-}" ] || return 0
  rm -rf "$1" 2>/dev/null
  [ ! -e "$1" ]
}

cleanup() {
  # Preserve the run's real status: `return` from an EXIT trap does not set it,
  # only an explicit `exit` does.
  local status=$?
  set +e
  # Stop only the pid we recorded, and reap it — signalling is not reaping.
  if [ -n "${RL_PID:-}" ]; then
    kill "$RL_PID" 2>/dev/null
    wait "$RL_PID" 2>/dev/null
  fi
  # Exactly the one path this test created. Unconditional: there is nothing to
  # decide, so there is nothing to get wrong.
  local removed=0
  remove_workspace "${W:-}" || removed=1
  # An already-failing run keeps its own status — cleanup never launders a red
  # into a green, nor into a different red.
  [ "$status" -eq 0 ] || exit "$status"
  # But a green body must NOT report green over a workspace still on disk.
  if [ "$removed" -ne 0 ]; then
    echo "relaunch-fence: cleanup could not remove its workspace $W — failing the run rather than reporting green" >&2
    exit 1
  fi
  exit 0
}
trap cleanup EXIT

A="$W/teamA"; B="$W/teamB"
ABUS="$A/.tap/bus"; BBUS="$B/.tap/bus"
mkdir -p "$ABUS/payloads" "$ABUS/receipts" "$ABUS/spool" "$ABUS/clear-fence" \
         "$BBUS/payloads" "$BBUS/receipts" "$BBUS/spool" "$BBUS/clear-fence" \
         "$W/index" "$W/bin" "$W/faketmux"
for d in "$A" "$B"; do git -C "$d" init -q; done

# The relaunch caller is provably OUTSIDE tmux, which is what the suite runner
# already guarantees by scrubbing TMUX. Inside tmux with an unresolvable caller
# pane the self-relaunch guard refuses — correctly — and this fixture would be
# testing that guard instead of the fence.
unset TMUX TMUX_PANE
export TAP_INDEX_HOME="$W/index" TAP_BOOT_ID="boot:424242"
export PATH="$W/bin:$PATH"
export FAKE_TMUX_STATE="$W/faketmux"

cat > "$W/index/global-registry.json" <<JSON
{"schema":"0.20","migrated":{"at":"2026-08-28T00:00:00Z","backups":{}},
 "teams":{
   "teamA":{"state":"registered","root":"$A","registry_location":"$A/.tap/team-registry.json"},
   "teamB":{"state":"registered","root":"$B","registry_location":"$B/.tap/team-registry.json"}}}
JSON

write_registry() { # <root> <team> <pane_id> [clear_nonce]
  python3 -B - "$1" "$2" "$3" "${4:-}" <<'PY'
import json, os, sys
root, team, pane_id, nonce = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
row = {
    "pane": f"{team}/seat:0.0", "pane_id": pane_id, "session": f"{team}/seat",
    "server_epoch": "srv:900:100", "harness": "codex", "status": "active",
    "delivery": "pane", "cwd": root, "instance": f"inst-{team}",
    # The caller is not a second owner of the target conversation.
    "harness_session_id": "bbbb1111-2222-3333-4444-555566667777" if team == "teamA" else "aaaa1111-2222-3333-4444-555566667777",
}
if nonce:
    row["clear_nonce"] = nonce
path = os.path.join(root, ".tap", "team-registry.json")
json.dump({"schema": "0.20", "team": {"name": team}, "seats": {"seat": row}}, open(path, "w"))
PY
}
write_registry "$A" teamA "%2001"
write_registry "$B" teamB "%1001"

cat > "$W/bin/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
# One pane identity per team, derived from whatever spelling the caller used.
pane_key() {
  case "${1:-}" in
    *2001*|*teamA*) echo A ;;
    *1001*|*teamB*) echo B ;;
    *)              echo U ;;
  esac
}
cmd="${1:-}"; shift || true
case "$cmd" in
  list-sessions)
    # -F "#{session_name}\t#{pid}:#{start_time}\t#{session_attached}"
    printf 'teamA/seat\t900:100\t1\nteamB/seat\t900:100\t1\n' ;;
  list-panes)
    # -F "#{session_name}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_id}
    #     \t#{pane_current_command}\t#{pane_pid}\t#{pid}:#{start_time}"
    # Honors -t "=<session>" scoping; -a and bare both list everything.
    scope=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -t) scope="${2:-}"; shift 2 ;; *) shift ;; esac
    done
    scope="${scope#=}"
    case "$scope" in
      teamA/seat) printf 'teamA/seat\tteamA/seat:0.0\t%%2001\tcodex\t2147483646\t900:100\t0\n' ;;
      teamB/seat) printf 'teamB/seat\tteamB/seat:0.0\t%%1001\tcodex\t2147483646\t900:100\t0\n' ;;
      *)
        printf 'teamA/seat\tteamA/seat:0.0\t%%2001\tcodex\t2147483646\t900:100\t0\n'
        printf 'teamB/seat\tteamB/seat:0.0\t%%1001\tcodex\t2147483646\t900:100\t0\n' ;;
    esac ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="${2:-}"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    pid="%1001"; sess="teamB/seat"
    case "$target" in *2001*|*teamA*) pid="%2001"; sess="teamA/seat" ;; esac
    key="$(pane_key "$target")"
    observed_cmd="codex"
    process_pid="2147483646"
    if [ -f "$FAKE_TMUX_STATE/respawned.$key" ]; then
      process_pid="2147483647"
    fi
    if [ "${TAP_TEST_HOLD_READY:-}" = "1" ] && \
       [ -f "$FAKE_TMUX_STATE/respawned.$key" ] && \
       [ ! -f "$FAKE_TMUX_STATE/ready.$key" ]; then
      observed_cmd="zsh"
    fi
    case "$fmt" in
      *session_name*window_index*) printf '%s:0.0\t%s\t%s\t900:100\t0\t%s\t/tmp\n' "$sess" "$pid" "$observed_cmd" "$process_pid" ;;
      # Native observer probes: server identity, then the four-field pane record
      # (%1001/%2001, teamA/seat|teamB/seat, srv:900:100 — matching the registries).
      *pane_id*session_name*pane_pid*pane_current_command*)
                              printf '%s\t%s\t2147483646\t%s\t0\n' "$pid" "$sess" "$observed_cmd" ;;
      '#{pid}:#{start_time}') echo '900:100' ;;
      *pane_id*)              echo "$pid" ;;
      *pane_pid*)             echo "2147483646" ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "$observed_cmd" ;;
      *)                      echo "" ;;
    esac ;;
  respawn-pane)
    tgt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -t) tgt="${2:-}"; shift 2 ;; *) shift ;; esac
    done
    touch "$FAKE_TMUX_STATE/respawned.$(pane_key "$tgt")"
    exit 0 ;;
  set-option|clear-history|kill-pane) exit 0 ;;
  send-keys)
    # TARGET-KEYED, and that is the point. A single global input file cannot say
    # WHICH same-named pane received a sentinel, so a delivery misrouted to the
    # caller's own pane would satisfy every other assertion in this file. Input
    # and submission state are per-pane, and Enter records the submission so an
    # arm can name the pane that got it.
    tgt=""
    if [ "${1:-}" = "-t" ]; then tgt="${2:-}"; shift 2; fi
    key="$(pane_key "$tgt")"
    if [ "${1:-}" = "-X" ]; then exit 0; fi
    if [ "${1:-}" = "-l" ]; then
      shift; [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" > "$FAKE_TMUX_STATE/input.$key"
      exit 0
    fi
    if [ "${1:-}" = "Enter" ]; then
      if [ -f "$FAKE_TMUX_STATE/input.$key" ]; then
        cat "$FAKE_TMUX_STATE/input.$key" >> "$FAKE_TMUX_STATE/submitted.$key"
        printf '\n' >> "$FAKE_TMUX_STATE/submitted.$key"
        rm -f "$FAKE_TMUX_STATE/input.$key"
      fi
      exit 0
    fi
    exit 0 ;;
  capture-pane)
    tgt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -t) tgt="${2:-}"; shift 2 ;; *) shift ;; esac
    done
    key="$(pane_key "$tgt")"
    if [ -f "$FAKE_TMUX_STATE/input.$key" ]; then
      printf '\u203a %s\n' "$(cat "$FAKE_TMUX_STATE/input.$key")"
    else
      printf '\u203a \n'
    fi ;;
esac
EOF
chmod +x "$W/bin/tmux"
printf '#!/usr/bin/env bash\nexit 0\n' > "$W/bin/codex"; chmod +x "$W/bin/codex"

fence_of() { echo "$1/clear-fence/seat.json"; }

# ---------------------------------------------------------------- arm 1
# The REAL acquire path. Not hand-shaped: the marker this produces is the
# synchronization barrier every arm below depends on.
cd "$A"
export TAP_HOME="$ABUS"
# The Python argparse door was retired; production routes `tap session
# relaunch` in the router to the native relaunch.ts, so drive that.
TAP_TEST_HOLD_READY=1 "$TAP" session relaunch teamB/seat --json >"$W/rl.out" 2>"$W/rl.err" &
RL_PID=$!
# try_acquire OPENS the marker before it truncates, writes, flushes and fsyncs,
# so breaking on pathname existence can race the JSON parse below. Wait for
# parseable, nonce-bearing content instead — and give up promptly if the child
# died, rather than spinning out the whole window on a process that is gone.
BARRIER_OK=0
for _ in $(seq 1 120); do
  if python3 -c '
import json,sys
try:
    d=json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
sys.exit(0 if d.get("nonce") else 1)
' "$(fence_of "$BBUS")" 2>/dev/null; then BARRIER_OK=1; break; fi
  kill -0 "$RL_PID" 2>/dev/null || { echo "relaunch-fence: (1) the relaunch child exited before publishing a marker" >&2; cat "$W/rl.out" "$W/rl.err" >&2; exit 1; }
  sleep 0.25
done
[ "$BARRIER_OK" = "1" ] || { echo "relaunch-fence: (1) no parseable marker on the TARGET bus" >&2; cat "$W/rl.err" >&2; exit 1; }

[ -e "$(fence_of "$BBUS")" ] || { echo "relaunch-fence: (1) no marker on the TARGET bus" >&2; cat "$W/rl.err" >&2; exit 1; }
[ ! -e "$(fence_of "$ABUS")" ] || { echo "relaunch-fence: (1) marker leaked onto the CALLER's bus — ambient-bus placement" >&2; exit 1; }
python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
assert d["handle"]=="seat", d
assert d["harness"]=="codex", d
assert float(d["ceiling_seconds"])>0, d
' "$(fence_of "$BBUS")" || { echo "relaunch-fence: (1) marker fields wrong" >&2; exit 1; }
echo "relaunch-fence: (1) real relaunch fences the TARGET bus, not the caller's: ok"

# ---------------------------------------------------------------- arm 2
# A's send consults B's fence. Wording matters: this is the SENDER in A reading
# the fence that lives on B's bus, not "B's courier" owning the park.
rc=0
"$TAP" send teamB/seat --ask -m "during relaunch" --from seat --id x-live --json \
  >"$W/live.out" 2>"$W/live.err" || rc="$?"
[ "$rc" = "0" ] || { echo "relaunch-fence: (2) cross-team send should queue, got $rc" >&2; cat "$W/live.out" "$W/live.err" >&2; exit 1; }
python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
assert d["status"]=="queued" and d.get("reason")=="clearing", d
' "$W/live.out" || { echo "relaunch-fence: (2) A->B must park reason=clearing while B is fenced" >&2; cat "$W/live.out" >&2; exit 1; }
[ -f "$ABUS/spool/x-live.md" ] || { echo "relaunch-fence: (2) spool belongs to the SENDER's bus (A)" >&2; ls -R "$ABUS/spool" "$BBUS/spool" >&2; exit 1; }
grep -q "teamB" "$ABUS/spool/x-live.md" || { echo "relaunch-fence: (2) spooled item must record the target team" >&2; cat "$ABUS/spool/x-live.md" >&2; exit 1; }
echo "relaunch-fence: (2) A->B parks on B's fence, spooled on A with the target recorded: ok"

# ---------------------------------------------------------------- arm 3
# THE UNIQUE CROSS-TEAM DISCRIMINATOR. Park-at-send is a no-op if the next drain
# re-derives the caller's own bus and injects into a pane that is mid-respawn.
drain_rc=0
bash -c 'set -euo pipefail; . "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once' _ "$LIB" \
  >/dev/null 2>"$W/drain-live.err" || drain_rc=$?
[ "$drain_rc" = "0" ] || { echo "relaunch-fence: (3) drain exited $drain_rc; a suppressed error would make this arm pass for the wrong reason" >&2; cat "$W/drain-live.err" >&2; exit 1; }
[ -f "$ABUS/spool/x-live.md" ] || {
  echo "relaunch-fence: (3) A's drain injected while B's fence was live — it read the wrong bus" >&2
  cat "$W/drain-live.err" >&2; exit 1; }
# Cross-team canonicals are SENDER-owned, so the load-bearing negative is under
# A. The B-path check stays as defense in depth, but on its own it was vacuous:
# nothing would have written it whether or not the fence held.
[ ! -f "$ABUS/payloads/x-live.md" ] || { echo "relaunch-fence: (3) drain promoted the canonical on A during a live fence" >&2; exit 1; }
[ ! -f "$BBUS/payloads/x-live.md" ] || { echo "relaunch-fence: (3) drain promoted canonical on B during a live fence" >&2; exit 1; }
echo "relaunch-fence: (3) A's drain HOLDS while B's fence is live: ok"

# ---------------------------------------------------------------- arm 5
# Run every assertion that requires B's live production fence before arm 4's
# unrelated A->A delivery. The fence intentionally fails open after its finite
# family ceiling; under suite load, spending that budget on arm 4 made this arm
# test expiry instead of urgent routing.
rc=0
"$TAP" send teamB/seat -m "urgent during relaunch" --from seat --id x-urgent --urgent --json \
  >"$W/urgent.out" 2>/dev/null || rc="$?"
[ "$rc" = "1" ] || { echo "relaunch-fence: (5) urgent should exit 1, got $rc" >&2; cat "$W/urgent.out" >&2; exit 1; }
python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
assert d["ok"] is False and d["error_class"]=="recipient_clearing", d
' "$W/urgent.out" || { echo "relaunch-fence: (5) need error_class=recipient_clearing from the TARGET's fence" >&2; cat "$W/urgent.out" >&2; exit 1; }
# Again: the meaningful negatives are on the SENDER's bus.
[ ! -e "$ABUS/spool/x-urgent.md" ] || { echo "relaunch-fence: (5) urgent must not spool on A" >&2; exit 1; }
[ ! -e "$ABUS/spool/x-urgent.meta.json" ] || { echo "relaunch-fence: (5) urgent must not leave spool metadata on A" >&2; exit 1; }
[ ! -e "$ABUS/payloads/x-urgent.md" ] || { echo "relaunch-fence: (5) urgent must not leave a canonical on A" >&2; exit 1; }
[ ! -e "$BBUS/payloads/x-urgent.md" ] || { echo "relaunch-fence: (5) urgent must not leave canonical on B" >&2; exit 1; }
echo "relaunch-fence: (5) urgent A->B refuses recipient_clearing: ok"

# ---------------------------------------------------------------- arm 4
# Falsifies ambient-bus placement from the other side: A's own same-named seat is
# not fenced, so it must still deliver. If the fence had been placed on A, this
# would park and the bug would be invisible to arms 1-3 alone.
rc=0
"$TAP" send seat --ask -m "unrelated" --from seat --id x-own --json \
  >"$W/own.out" 2>"$W/own.err" || rc="$?"
[ "$rc" = "0" ] || { echo "relaunch-fence: (4) A->A send failed, got $rc" >&2; cat "$W/own.out" "$W/own.err" >&2; exit 1; }
python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
assert d.get("status")=="injected" or d.get("delivery")=="pane", d
assert d.get("reason")!="clearing", d
' "$W/own.out" || { echo "relaunch-fence: (4) A's OWN seat must not be fenced by a relaunch of B's" >&2; cat "$W/own.out" >&2; exit 1; }
grep -qE "\\[\\[TAP v[0-9.]+ (ask|note) ([A-Za-z0-9][A-Za-z0-9._-]*/)?x-own( |:|\\]\\])" "$FAKE_TMUX_STATE/submitted.A" 2>/dev/null || {
  echo "relaunch-fence: (4) x-own was not submitted to A's pane (%2001)" >&2; ls -l "$FAKE_TMUX_STATE" >&2; exit 1; }
! grep -qE "\\[\\[TAP v[0-9.]+ (ask|note) ([A-Za-z0-9][A-Za-z0-9._-]*/)?x-own( |:|\\]\\])" "$FAKE_TMUX_STATE/submitted.B" 2>/dev/null || {
  echo "relaunch-fence: (4) x-own leaked into B's pane" >&2; exit 1; }
echo "relaunch-fence: (4) A's own same-named seat is unaffected, and its sentinel landed on A: ok"

# ---------------------------------------------------------------- arm 6
# Make the intended harness observable and require the real relaunch to RELEASE
# the marker it placed on B. Relaunch preserves the existing registration and
# must not wait for a fresh nonce answer merely to prove that seat still exists.
# A fence that is taken correctly but never released would park B's mail forever.
NONCE="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["nonce"])' "$(fence_of "$BBUS")")"
# THE FIXTURE MUST NOT REPAIR PRODUCTION'S OWN STAMP. `expected_clear_nonce` is
# written by stamp_expected_clear_nonce against the TARGET root — it is one of
# the things this arm exists to certify. Writing it here would let a missing or
# wrong-root stamp still verify. So: assert production already wrote it on B and
# NOT on A. Unlike tap clear, this test deliberately supplies no `clear_nonce`.
python3 -B - "$B" "$A" "$NONCE" <<'PY'
import json, os, sys
b_root, a_root, nonce = sys.argv[1], sys.argv[2], sys.argv[3]
def row_of(root):
    return json.load(open(os.path.join(root, ".tap", "team-registry.json")))["seats"]["seat"]
b = row_of(b_root)
if b.get("expected_clear_nonce") != nonce:
    sys.exit(f"target root carries expected_clear_nonce={b.get('expected_clear_nonce')!r}, want {nonce!r} — production did not stamp the TARGET")
a = row_of(a_root)
if a.get("expected_clear_nonce") is not None:
    sys.exit(f"caller root was stamped too ({a.get('expected_clear_nonce')!r}) — the stamp went to the wrong root")
PY
[ "$?" = "0" ] || { echo "relaunch-fence: (6) expected_clear_nonce stamp is wrong; see above" >&2; exit 1; }
touch "$FAKE_TMUX_STATE/ready.B"
wait "$RL_PID"; RL_RC=$?; RL_PID=""
[ "$RL_RC" = "0" ] || { echo "relaunch-fence: (6) relaunch should exit 0 once codex is observable, got $RL_RC" >&2; cat "$W/rl.out" "$W/rl.err" >&2; exit 1; }
python3 -c '
import json,sys
d=json.loads(open(sys.argv[1]).read().strip().splitlines()[-1])
r=d["results"]
assert d["ok"] is True and len(r)==1, d
assert (r[0]["team"],r[0]["handle"],r[0]["code"],r[0]["status"])==("teamB","seat",0,"resumed"), r[0]
' "$W/rl.out" || { echo "relaunch-fence: (6) missing the resumed result row for teamB/seat" >&2; cat "$W/rl.out" >&2; exit 1; }
python3 -B - "$B" <<'PY'
import json, os, sys
row = json.load(open(os.path.join(sys.argv[1], ".tap", "team-registry.json")))["seats"]["seat"]
assert "clear_nonce" not in row, row
assert "expected_clear_nonce" not in row, row
PY
# RELEASE TRUNCATES; IT DOES NOT UNLINK, and asserting absence here would be
# asserting a defect. clear_fence.HeldFence.release says why: unlinking would let
# a second clearer create a new inode and acquire while this fd still holds the
# old one. So the guarantee is "no longer a live claim", which is what the courier
# reads — not "no file".
[ -s "$(fence_of "$BBUS")" ] && {
  echo "relaunch-fence: (6) the marker still carries a live claim — B's mail would park forever" >&2
  cat "$(fence_of "$BBUS")" >&2; exit 1; }
echo "relaunch-fence: (6) observable harness readiness releases the TARGET claim without a registration ACK: ok"

# ---------------------------------------------------------------- arm 7
# Expiry polarity, on the bus that actually holds the fence. FIXTURE-WRITTEN and
# labelled as such: the real marker above has been released, so this is the only
# way to reach the stale branch without sleeping out a 45s ceiling. Arms 1-6 all
# ran against the real one.
python3 -B - "$BBUS" <<'PY'
import json, os, sys, time
bus = sys.argv[1]
path = os.path.join(bus, "clear-fence", "seat.json")
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump({
    "nonce": "stale-fixture-nonce", "since": "2099-01-01T00:00:00Z",
    "since_epoch": time.time() - 1000, "pid": 2147483646,
    "handle": "seat", "harness": "codex", "ceiling_seconds": 45.0,
}, open(path, "w"))
PY
rc=0
"$TAP" send teamB/seat --ask -m "after expiry" --from seat --urgent --id x-stale --json \
  >"$W/stale.out" 2>"$W/stale.err" || rc="$?"
[ "$rc" = "0" ] || { echo "relaunch-fence: (7) stale cross-team send should deliver, got $rc" >&2; cat "$W/stale.out" "$W/stale.err" >&2; exit 1; }
python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
assert d.get("status")=="injected" or d.get("delivery")=="pane", d
' "$W/stale.out" || { echo "relaunch-fence: (7) an expired TARGET fence must fail OPEN" >&2; cat "$W/stale.out" >&2; exit 1; }
grep -q "expired; delivering anyway" "$W/stale.err" || {
  echo "relaunch-fence: (7) fail-open must announce itself once" >&2; cat "$W/stale.err" >&2; exit 1; }

# ...and the item parked in arm 2 must now drain. Holding during live AND
# releasing after expiry: either alone can pass for the wrong reason.
drain_rc=0
bash -c 'set -euo pipefail; . "$1"; . "${1%/smoke/runtime-helpers.sh}/smoke/spool-engine-fixture.sh"; spool_drain_fixture_once' _ "$LIB" \
  >/dev/null 2>"$W/drain-expired.err" || drain_rc=$?
# rc MUST be 0. A native redelivery rc 5 removes spool body and meta while
# leaving the sender canonical submit-unverified, so "the spool file is gone" is
# satisfied by a FAILED redelivery. Disappearance is not delivery.
[ "$drain_rc" = "0" ] || { echo "relaunch-fence: (7) drain exited $drain_rc — spool removal without delivery" >&2; cat "$W/drain-expired.err" >&2; exit 1; }
[ ! -f "$ABUS/spool/x-live.md" ] || {
  echo "relaunch-fence: (7) the item parked in arm 2 never drained after B's fence expired" >&2
  cat "$W/drain-expired.err" >&2; exit 1; }
[ ! -f "$ABUS/spool/x-live.meta.json" ] || { echo "relaunch-fence: (7) spool metadata survived the drain" >&2; exit 1; }
# Positive witness, on the sender's bus where a cross-team canonical lives, and
# it must still name the TARGET team.
[ -f "$ABUS/payloads/x-live.md" ] || { echo "relaunch-fence: (7) no canonical after the drain — delivery was inferred from disappearance" >&2; ls -R "$ABUS" >&2; exit 1; }
grep -q "teamB" "$ABUS/payloads/x-live.md" || { echo "relaunch-fence: (7) the delivered canonical does not name the target team" >&2; cat "$ABUS/payloads/x-live.md" >&2; exit 1; }
# THE SUBMISSION WITNESS. The envelope naming teamB was already true while the
# item sat parked, so it cannot distinguish "delivered to B's pane" from
# "delivered to the caller's identically-named pane". Only the target-keyed
# submission record can.
grep -qE "\\[\\[TAP v[0-9.]+ (ask|note) ([A-Za-z0-9][A-Za-z0-9._-]*/)?x-live( |:|\\]\\])" "$FAKE_TMUX_STATE/submitted.B" 2>/dev/null || {
  echo "relaunch-fence: (7) the x-live sentinel was never submitted to B's pane (%1001)" >&2
  ls -l "$FAKE_TMUX_STATE" >&2; exit 1; }
! grep -qE "\\[\\[TAP v[0-9.]+ (ask|note) ([A-Za-z0-9][A-Za-z0-9._-]*/)?x-live( |:|\\]\\])" "$FAKE_TMUX_STATE/submitted.A" 2>/dev/null || {
  echo "relaunch-fence: (7) the x-live sentinel reached A's pane (%2001) — misrouted to the caller's same-named seat" >&2
  cat "$FAKE_TMUX_STATE/submitted.A" >&2; exit 1; }
echo "relaunch-fence: (7) an expired TARGET fence fails open and releases the parked item: ok"

# ---------------------------------------------------------------- arm 8
# The protected tree survives everything above. This is the one deletion-safety
# assertion that remains, and it is about what THIS process did: the child cannot
# observe post-exit reaping, so an assertion about the runner cleaning up would be
# unverifiable from here.
[ -d "$W" ] || { echo "relaunch-fence: (8) the workspace was removed during the run" >&2; exit 1; }
[ -d "$BBUS" ] && [ -d "$ABUS" ] || { echo "relaunch-fence: (8) a team bus was removed during the run" >&2; exit 1; }
echo "relaunch-fence: (8) the workspace and both team buses survive the run: ok"

# ---------------------------------------------------------------- arm 9
# WHERE THE WORKSPACE LIVES, AND THAT WE REMOVE IT. This test owns its workspace
# in every mode; the sandbox only decides WHERE it is minted, never who removes
# it. The shape that must never ship is a bare mktemp whose result is thrown
# away — measured: TMPDIR is not redirected under smoke-all, so such a tree lands
# outside the sandbox, nothing reaps it, and it leaks once per suite run while
# every run still passes.

# EXACTLY ONE ALLOCATION PER MODE, AND NOTHING BEFORE THEM. An earlier version
# kept its original bare `W="$(mktemp -d)"` above the allocation block, which then
# overwrote W — so every run allocated two workspaces and abandoned the first.
# Neither the trap nor any check above could see it: they only ever observe the
# surviving W. Counting the assignments is what catches a reintroduced
# pre-allocation, because the leak is invisible from inside the variable it leaks
# past.
alloc_count="$(grep -c '^[[:space:]]*W="\$(mktemp' "$SELF" || true)"
[ "$alloc_count" = "2" ] || {
  echo "relaunch-fence: (9) expected exactly 2 workspace allocations (one per mode), found $alloc_count — an abandoned pre-allocation leaks past every check in this file" >&2
  grep -n '^[[:space:]]*W="\$(mktemp' "$SELF" >&2; exit 1; }

# The workspace is removed by THIS test, whatever directory it was minted in. No
# label, no attribution, no reaper assumed — so a stale or foreign sandbox that
# merely looks like the runner's cannot leave a workspace behind.
trap -p EXIT | grep -q cleanup || { echo "relaunch-fence: (9) no exact-path cleanup trap is registered — the workspace would leak" >&2; exit 1; }
if [ -n "${TAP_SUITE_SANDBOX:-}" ] && [ -d "${TAP_SUITE_SANDBOX}" ]; then
  case "$W" in
    "$TAP_SUITE_SANDBOX"/*) : ;;
    *) echo "relaunch-fence: (9) a sandbox exists but the workspace was minted outside it ($W)" >&2; exit 1 ;;
  esac
  echo "relaunch-fence: (9) workspace minted inside the sandbox and owned by this test: ok"
else
  echo "relaunch-fence: (9) workspace minted in the temp root and owned by this test: ok"
fi

# ---------------------------------------------------------------- arm 10
# REMOVAL MUST BE OUTCOME-BEARING. The trap used to save the body status, ignore
# rm's result and exit with the saved status, so a green body over a workspace
# still on disk exited 0.
#
# The control forces that inside the ALREADY-OWNED W, with a subshell-local `rm`
# and no filesystem lock. An earlier version minted a second temp root and made a
# file immutable; an interruption between the lock and its release stranded a tree
# the trap did not own — recreating the exact residue class this correction
# exists to close. Nothing here creates a root, so there is no window.
CTRL="$W/removal-control"

# Polarity A: rm fails and leaves the path. remove_workspace must say so.
mkdir -p "$CTRL"
( rm() { return 1; }; remove_workspace "$CTRL" ) && {
  echo "relaunch-fence: (10) a failed removal reported success" >&2; exit 1; }
[ -d "$CTRL" ] || { echo "relaunch-fence: (10) the control path vanished; polarity A proved nothing" >&2; exit 1; }

# Polarity B: rm reports SUCCESS but removes nothing. This is the one that proves
# the check reads the path's absence rather than rm's status — the status-only
# form passes here and the absence form does not.
( rm() { return 0; }; remove_workspace "$CTRL" ) && {
  echo "relaunch-fence: (10) rm exited 0 without removing and that was accepted — the check is reading status, not absence" >&2; exit 1; }
[ -d "$CTRL" ] || { echo "relaunch-fence: (10) the control path vanished; polarity B proved nothing" >&2; exit 1; }

# Polarity C: the real remover still removes, so the arm cannot pass by making
# every removal fail.
remove_workspace "$CTRL" || { echo "relaunch-fence: (10) a removable path was reported unremovable" >&2; exit 1; }
[ ! -e "$CTRL" ] || { echo "relaunch-fence: (10) remove_workspace returned success without removing" >&2; exit 1; }
echo "relaunch-fence: (10) failed removal and lying-success removal both report failure; a real one removes: ok"

echo "relaunch-fence-target-bus: ok"
