#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# identity-capture-reregistration.test.sh — tap-wolp.
#
# A SECOND registration of the same seat must not launder the first one's verdict.
# Every SessionStart registers the seat again (runtime/bun/src/session-start.ts
# runs a real `tap in`), so this is not a rare path — it is every resume, clear
# and compact, and twice per start wherever the advisory hook is installed at
# both the project and user level (tap-pkoq).
#
# The rule under test (fable's ruling, 2026-08-14): the discriminator is WHAT THE
# REGISTRATION OBSERVED, not verdict rank. A re-registration reporting the SAME
# harness_session_id carries zero new identity information — it may not weaken
# the verdict, pop quarantine keys, or adopt a previously refused id. A DIFFERENT
# observed id is genuine drift and follows drift rules.
#
# The four arms are a 2x2: prior harness_session_id {absent, stale} x observed id
# {matches the launcher expectation, drifts from it}. Both directions are pinned
# in one fixture on purpose: "pass 2 wrote nothing" is a predicate that a broken
# code path satisfies for free, so the accept arms have to show the verdict
# SURVIVING in the same run that shows the drift arms REFUSING.
set -euo pipefail

# tap-lcdm P1-3: THE PANE PID THE FIXTURE REPORTS MUST BE A LIVE ANCESTOR of the
# registering process, because the rebind now proves caller ancestry with
# `tap_pid_has_ancestor`, which walks `ps -o ppid= -p <pid>`.
#
# The first attempt reported `$PPID` from inside the tmux stub. That is a CORPSE:
# the call site is `p="$(tmux … '#{pane_pid}' 2>/dev/null || true)"`, and the
# `|| true` makes the substitution a COMPOUND command, so bash 3.2 forks a real
# subshell rather than exec-ing in place. `$PPID` is then that transient
# subshell, already exited before the walk starts, and the walk fails closed on an
# unreadable pid. No `ps` stub can rescue a dead pid — which is why narrowing the
# stub read as a dead end. (Diagnosed by the gate reviewer; measured on this box,
# bash 3.2.57: the same call WITHOUT `|| true` reports `$$`, because bash elides
# the fork for a simple command.)
#
# This file's own pid is a genuine ancestor: `register_once` runs
# `( … bash "$TAP" register opus )`, so the register shell descends from here, and
# this process is alive for the whole run. Nothing is faked — the caller really is
# under that process, which is exactly what the accept arms model.
FIXTURE_PID=$$
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# shellcheck source=sandbox-pins.sh
. "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"
WORK="$(mktemp -d)"
# THE FOREIGN CALLER'S PANE PID: live, readable, and NOT an ancestor of anything
# here. Live matters — a dead pid would make the walk fail closed, and the arm
# would then pass because the instrument broke rather than because the code
# refused. That distinction is the entire value of the negative arm.
sleep 300 &
FOREIGN_PID=$!
trap 'kill "$FOREIGN_PID" 2>/dev/null; rm -rf "$WORK"' EXIT

MOCKBIN="$WORK/bin"
mkdir -p "$MOCKBIN"
# EXACTLY ONE SHAPE DELEGATES: `ps -o ppid= -p <pid>`, the ancestry walk
# (`tap_pid_has_ancestor`, lib.sh:12010). Everything else keeps the fixed line.
#
# Three callers use `ps` on this path and they need OPPOSITE answers, which is why
# the discriminator is the exact argv rather than a family of them:
#
#   -o ppid= -p <pid>            ancestry walk       -> REAL, or the walk fails
#                                                       closed on a pid it cannot
#                                                       read and the rebind arms
#                                                       refuse for a fixture reason
#   -o ppid= -o tty= -p <pid>    tap_calling_pane_id -> STUB. It wants ppid=1 and
#                                                       tty=faketty so the caller
#                                                       pane is observable; the
#                                                       real tty is not a tmux pane
#                                                       and every arm collapses to
#                                                       "caller pane is not
#                                                       observable"
#   -Ao pid=,pgid=,…             pane observer       -> STUB, same reason
#
# So "delegate anything carrying -p" is too broad (it captures the tty walk) and
# "-o as a prefix" is too broad in the other direction (it swallows -Ao). Match the
# whole argv.
#
# `/bin/ps` by absolute path: this stub IS the `ps` on PATH, so a bare `ps` here is
# infinite recursion.
cat > "$MOCKBIN/ps" <<'PS'
#!/usr/bin/env bash
if [ "$#" = 3 ] && [ "$1" = "-o" ] && [ "$2" = "ppid=" ] && [ "$3" = "-p" ]; then
  exec /bin/ps "$@"
fi
if [ "$#" = 4 ] && [ "$1" = "-o" ] && [ "$2" = "ppid=" ] && [ "$3" = "-p" ]; then
  exec /bin/ps "$@"
fi
printf '1 faketty\n'
PS
# Quoted heredoc (tap-psif class): a PATH-shadowed stub must never use an
# unquoted one — a single backtick in prose becomes a live command.
cat > "$MOCKBIN/tmux" <<TMUX
#!/usr/bin/env bash
FIXTURE_PID="$FIXTURE_PID"
TMUX
cat >> "$MOCKBIN/tmux" <<'TMUX'
set -euo pipefail
PANE="%99999"
SESSION="wolp-opus-0"
[ "${1:-}" = list-panes ] && {
  if [[ "$*" == *pane_tty* ]]; then printf '%s\t/dev/faketty\n' "$PANE"
  else printf '%s\t%s:0.0\t%s\tclaude\t%s\t4242:100\t0\n' "$SESSION" "$SESSION" "$PANE" "$FIXTURE_PID"; fi
  exit 0
}
[ "${1:-}" = list-sessions ] && { printf '%s\t4242:100\t1\n' "$SESSION"; exit 0; }
[ "${1:-}" = display-message ] || exit 0
shift
fmt=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p) shift ;;
    -t) shift 2 ;;
    *) fmt="$1"; shift ;;
  esac
done
case "$fmt" in
  # Bun's combined nine-field caller record — precedes the pane globs.
  *pane_id*pane_tty*session_name*socket_path*pane_current_path*) printf '%s\t/dev/faketty\t%s\t4242:100\t%s:0.0\t%s\tclaude\t%s\t%s\n' "$PANE" "$SESSION" "$SESSION" "${FAKE_PANE_PID:-$FIXTURE_PID}" "${TMUX%%,*}" "${FAKE_TMUX_PATH:?}" ;;
  # Bun's combined eight-field pane record.
  *pane_id*session_name*pane_pid*pane_current_command*socket_path*) printf '%s\t%s\t%s\tclaude\t0\t%s:0.0\t%s\t%s\n' "$PANE" "$SESSION" "${FAKE_PANE_PID:-$FIXTURE_PID}" "$SESSION" "${TMUX%%,*}" "${FAKE_TMUX_PATH:?}" ;;
  *pane_id*session_name*pane_pid*pane_current_command*) printf '%s\t%s\t%s\tclaude\t0\n' "$PANE" "$SESSION" "${FAKE_PANE_PID:-$FIXTURE_PID}" ;;
  # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
  *pane_id*pane_tty*session_name*) printf '%s\t/dev/faketty\t%s\t4242:100\n' "$PANE" "$SESSION" ;;
  *pane_id*session_name*) printf '%s\t%s\t4242:100\n' "$PANE" "$SESSION" ;;
  *pane_id*pane_tty*) printf '%s\t/dev/faketty\n' "$PANE" ;;
  *window_index*) printf '%s:0.0\n' "$SESSION" ;;
  *session_name*) printf '%s\n' "$SESSION" ;;
  *pane_id*) printf '%s\n' "$PANE" ;;
  # tap-lcdm P1-3: the rebind now proves the CALLER runs under the pane it is
  # registering, via tap_pid_has_ancestor. The fixture must therefore answer
  # pane_pid with a pid that IS an ancestor of the registering process -- $PPID of
  # this stub is the register shell itself, which is exactly the honest answer for
  # "a seat registering its own pane".
  #
  # Returning our own pid here is not the fixture rigging the check: the check asks
  # "is the registering process inside this pane", and in the case these arms model
  # -- a seat's own SessionStart hook -- it genuinely is. The foreign-caller arm
  # below is what proves the check can still FAIL.
  *pane_pid*) printf '%s\n' "${FAKE_PANE_PID:-$FIXTURE_PID}" ;;
  *pane_current_command*) printf 'claude\n' ;;
  *pane_current_path*) printf '%s\n' "${FAKE_TMUX_PATH:?}" ;;
  *pid*start_time*) printf '4242:100\n' ;;
  *socket_path*) printf '%s\n' "${TMUX%%,*}" ;;
  *) printf '\n' ;;
esac
TMUX
chmod +x "$MOCKBIN/ps" "$MOCKBIN/tmux"

EXPECTED="expected-1111"
DRIFT="observed-2222"
STALE="stale-0000"
FAILED=0

# TAP_HOME ALONE DOES NOT ISOLATE THIS. Post-flip the acting registry is resolved
# through the machine index, so a fixture that redirects only the bus writes the
# OPERATOR'S live seat rows. That is not hypothetical: the first draft of this
# fixture cleared a live seat's pane binding four times and left a fabricated
# session id in its row. TAP_INDEX_HOME is the knob; the scratch root must also
# be a git worktree whose basename is the team name, or registration refuses with
# `refusing bus decoy` before it ever reaches the code under test.
seed_arm() { # <name> <prior_hsid|-> ; echoes the scratch root
  local name="$1" prior="$2"
  local root="$WORK/$name/wolp" index="$WORK/$name-index"
  mkdir -p "$root/.tap/bus/payloads" "$root/.tap/bus/receipts" "$index"
  git -C "$root" init -q
  python3 -B - "$index" "$root" "$prior" "$EXPECTED" <<'PY'
import json, os, sys
index, root, prior, expected = sys.argv[1:5]
registry = os.path.join(root, ".tap", "team-registry.json")
with open(os.path.join(index, "global-registry.json"), "w") as fh:
    json.dump({"migrated": {}, "schema": "0.20", "teams": {"wolp": {
        "enrolled_at": "2026-08-14T00:00:00Z", "registry_location": registry,
        "root": root, "state": "registered"}}}, fh)
seat = {"base": "wolp", "delivery": "pane", "status": "active", "harness": "claude",
        "session": "wolp-opus-0", "pane": "wolp-opus-0:0.0", "pane_id": "%99999",
        "index": 1, "registered_from_worktree": root,
        "identity_capture": {"mode": "launcher_new",
                             "expected_harness_session_id": expected}}
if prior != "-":
    seat["harness_session_id"] = prior
with open(registry, "w") as fh:
    json.dump({"schema": "0.20", "team": {"name": "wolp", "worktree_root": root},
               "seats": {"opus": seat}}, fh)
PY
  printf '%s' "$root"
}

register_once() { # <root> <index> <observed> [stderr_path]
  ( cd "$1" && env -u TAP_CLEAR_ID -u TMUX_PANE \
      PATH="$MOCKBIN:$PATH" TMUX="/tmp/fake-wolp,1,0" FAKE_TMUX_PATH="$1" \
      TAP_INDEX_HOME="$2" TAP_HOME="$1/.tap/bus" TAP_SKIP_VERSION_BRIEFING=1 \
      TAP_HARNESS_SESSION_ID="$3" \
      bash "$TAP" register opus >/dev/null 2>"${4:-/dev/null}" ) || true
}

# The relaunch row, as the launcher actually leaves it. `prepare` builds the
# reservation from same_seat_metadata, so the OLD accepted observation and the
# OLD id ride along; `identity_capture` is then set fresh with the new mint, and
# `strip_stale_bindings` pops pane coordinates only. Hand-forging a row the
# launcher never writes is how a probe of this state proves nothing, so this
# mirrors launcher.py's post-bind row in THE FIELDS REGISTRATION READS:
# harness_session_id, identity_capture_result, identity_capture, harness, pane,
# pane_id, session, status. Deliberately not field-complete — `status_reason`
# ("launching" on the live row until mark_launch_ready clears it) and the rest of
# the reservation are absent because no arm here reads them, and a field a test
# does not exercise is how a fixture starts drifting from what it claims to
# mirror. An arm that needs more of the row extends this with the need in hand.
seed_relaunch_row() { # <name> <old_id> <fresh_expectation> ; echoes the scratch root
  local name="$1" old_id="$2" expectation="$3"
  local root="$WORK/$name/wolp" index="$WORK/$name-index"
  mkdir -p "$root/.tap/bus/payloads" "$root/.tap/bus/receipts" "$index"
  git -C "$root" init -q
  python3 -B - "$index" "$root" "$old_id" "$expectation" <<'PY'
import json, os, sys
index, root, old_id, expectation = sys.argv[1:5]
registry = os.path.join(root, ".tap", "team-registry.json")
with open(os.path.join(index, "global-registry.json"), "w") as fh:
    json.dump({"migrated": {}, "schema": "0.20", "teams": {"wolp": {
        "enrolled_at": "2026-08-14T00:00:00Z", "registry_location": registry,
        "root": root, "state": "registered"}}}, fh)
seat = {"base": "wolp", "delivery": "pane", "status": "active", "harness": "claude",
        "session": "wolp-opus-0", "pane": "wolp-opus-0:0.0", "pane_id": "%99999",
        "index": 1, "registered_from_worktree": root, "launch_id": "launch-relaunch-1",
        "harness_session_id": old_id,
        "identity_capture_result": {"decision": "accepted", "mode": "launcher_new",
                                    "observed_harness_session_id": old_id},
        "identity_capture": {"mode": "launcher_new",
                             "expected_harness_session_id": expectation}}
with open(registry, "w") as fh:
    json.dump({"schema": "0.20", "team": {"name": "wolp", "worktree_root": root},
               "seats": {"opus": seat}}, fh)
PY
  printf '%s' "$root"
}

# One line per pass: decision|mode|harness_session_id|quarantined?
snapshot() { # <root>
  python3 -B - "$1/.tap/team-registry.json" <<'PY'
import json, sys
seat = json.load(open(sys.argv[1]))["seats"].get("opus", {})
capture = seat.get("identity_capture_result") or {}
quarantined = "yes" if seat.get("identity_quarantine_reason") else "no"
print("%s|%s|%s|%s" % (capture.get("decision", "-"), capture.get("mode", "-"),
                       seat.get("harness_session_id", "-"), quarantined))
PY
}

check() { # <arm> <pass> <actual> <expected>
  if [ "$3" = "$4" ]; then
    printf 'identity-capture-reregistration: %s %s -> %s: ok\n' "$1" "$2" "$3"
  else
    printf 'identity-capture-reregistration: %s %s expected [%s] got [%s]\n' \
      "$1" "$2" "$4" "$3" >&2
    FAILED=1
  fi
}

arm() { # <name> <prior_hsid|-> <observed> <expect_pass1> <expect_pass2>
  local name="$1" prior="$2" observed="$3" want1="$4" want2="$5" root
  root="$(seed_arm "$name" "$prior")"
  register_once "$root" "$WORK/$name-index" "$observed"
  check "$name" pass1 "$(snapshot "$root")" "$want1"
  register_once "$root" "$WORK/$name-index" "$observed"
  check "$name" pass2 "$(snapshot "$root")" "$want2"
}

# ── The accept direction: a verdict that was EARNED must survive a re-register ──
# Without the observation rule these two go accepted|unattested on pass 2 — the
# expectation has been consumed, so the second pass has nothing to validate and
# records the weakest mode as though it had checked. Nothing is unsafe about the
# id here; what is lost is the RECORD that a launcher attested it, which is the
# only thing an audit of "which seats were launcher-attested" can read.
arm launcher-attested "-" "$EXPECTED" \
  "accepted|launcher_new|$EXPECTED|no" \
  "accepted|launcher_new|$EXPECTED|no"

arm launcher-attested-over-stale "$STALE" "$EXPECTED" \
  "accepted|launcher_new|$EXPECTED|no" \
  "accepted|launcher_new|$EXPECTED|no"

# ── The refuse direction: a QUARANTINE must survive a re-register ──────────────
# This is the P1. Before the fix, pass 2 adopted the very id pass 1 refused and
# deleted the quarantine keys: the refusal survived exactly one registration, and
# the next SessionStart — 0.3s later where the advisory hook is double-installed
# — laundered it into an acceptance.
arm expectation-mismatch "-" "$DRIFT" \
  "quarantined|launcher_new|-|yes" \
  "quarantined|launcher_new|-|yes"

arm expectation-mismatch-over-stale "$STALE" "$DRIFT" \
  "quarantined|launcher_new|$STALE|yes" \
  "quarantined|launcher_new|$STALE|yes"

# ── Genuine drift still moves ─────────────────────────────────────────────────
# The rule keys on the OBSERVATION, not on verdict rank, and this arm is what
# makes that difference visible: a third registration reporting a DIFFERENT id is
# new information, so an accepted seat follows the ordinary unattested-drift
# path. A rank-based rule (never weaken a launcher_new verdict) would pin the
# seat to a session id it no longer has — which is why this arm is in the same
# file as the ones above rather than trusted to review.
DRIFT_ROOT="$(seed_arm native-resume-drift "-")"
register_once "$DRIFT_ROOT" "$WORK/native-resume-drift-index" "$EXPECTED"
check native-resume-drift pass1 "$(snapshot "$DRIFT_ROOT")" \
  "accepted|launcher_new|$EXPECTED|no"
DRIFT_ERR="$WORK/native-resume-drift.err"
register_once "$DRIFT_ROOT" "$WORK/native-resume-drift-index" "native-3333" "$DRIFT_ERR"
check native-resume-drift pass2 "$(snapshot "$DRIFT_ROOT")" \
  "accepted|unattested|native-3333|no"

# A refusal that the very next block accepts is worse than no refusal, and the
# row cannot show it: match_update writes the same accepted state either way, so
# the ONLY observable product of enforcing the outcome is what this drift accept
# says on stderr. Asserted in BOTH directions — that the accept announces itself,
# and that it does NOT announce a quarantine it did not perform.
if grep -q 'accepted drifted harness identity' "$DRIFT_ERR"; then
  echo "identity-capture-reregistration: drift accept announces itself: ok"
else
  echo "identity-capture-reregistration: drift accept was silent" >&2
  cat "$DRIFT_ERR" >&2
  FAILED=1
fi
if grep -q 'WARNING: quarantined' "$DRIFT_ERR"; then
  echo "identity-capture-reregistration: drift accept claimed a quarantine it did not perform" >&2
  cat "$DRIFT_ERR" >&2
  FAILED=1
else
  echo "identity-capture-reregistration: drift accept claims no quarantine: ok"
fi

# ── A THIRD id must not walk through a standing refusal ────────────────────────
# The pass-3 arm, and the only thing that can red if the expectation pop goes
# back to firing unconditionally: with the expectation consumed by the refusal,
# a LATER registration bearing a brand-new id finds nothing to check against,
# defaults to `unattested`, and adopts it outright. Two passes cannot catch that
# — pass 2 repeats the refused id, which the same-observation rule handles on its
# own — so the mutation stays green until a third id arrives.
THIRD_ROOT="$(seed_arm third-id-after-refusal "-")"
register_once "$THIRD_ROOT" "$WORK/third-id-after-refusal-index" "$DRIFT"
check third-id-after-refusal pass1 "$(snapshot "$THIRD_ROOT")" \
  "quarantined|launcher_new|-|yes"
register_once "$THIRD_ROOT" "$WORK/third-id-after-refusal-index" "third-4444"
check third-id-after-refusal pass2 "$(snapshot "$THIRD_ROOT")" \
  "quarantined|launcher_new|-|yes"

# ── A FRESH expectation outranks a stale accepted observation ─────────────────
# The relaunch case. The row carries an accepted observation of `old-aaaa` and a
# brand-new expectation of `new-bbbb`; the pane reports `old-aaaa`, because the
# harness auto-resumed the previous session or a stale TAP_HARNESS_SESSION_ID
# leaked in. Same observation, and it must still be refused: a pending question
# is new even when the observation is not. Without this the registry would record
# `launcher-attested accepted` for a relaunch that never took, and tap-register
# is the only enforcer of the expectation, so nothing downstream would notice.
RELAUNCH_ROOT="$(seed_relaunch_row relaunch-never-took old-aaaa new-bbbb)"
RELAUNCH_ERR="$WORK/relaunch-never-took.err"
register_once "$RELAUNCH_ROOT" "$WORK/relaunch-never-took-index" old-aaaa "$RELAUNCH_ERR"
# harness_session_id stays `old-aaaa`: the quarantine branch never adopts, and
# the row's existing id was legitimately earned by an earlier session — what is
# refused is the CLAIM that this relaunch produced it.
check relaunch-never-took refusal "$(snapshot "$RELAUNCH_ROOT")" \
  "quarantined|launcher_new|old-aaaa|yes"
if grep -q 'did not match launcher expectation new-bbbb' "$RELAUNCH_ERR"; then
  echo "identity-capture-reregistration: relaunch-never-took names the expectation: ok"
else
  echo "identity-capture-reregistration: relaunch-never-took refusal was silent" >&2
  cat "$RELAUNCH_ERR" >&2
  FAILED=1
fi

# ── The operator withdraws the standing refusal (tap-zqcd) ───────────────────
# The refusal above is correct and permanent: nothing retires it, because the
# asker — a launcher process — exited long before the registration was refused.
# `--accept-observed-identity` is that retirement as an operator act, and the
# arms below pin its SCOPE as much as its effect: it withdraws the launcher's
# QUESTION (one the operator can answer — "yes, that pane is my seat") and
# nothing else. A verb that cleared every quarantine reason would let an operator
# wave through the duplicate-owner refusal, which is a fact about another seat
# that no operator statement can change.
withdraw_identity() { # <root> <index> <observed> <stderr_path>
  ( cd "$1" && env -u TAP_CLEAR_ID -u TMUX_PANE \
      PATH="$MOCKBIN:$PATH" TMUX="/tmp/fake-wolp,1,0" FAKE_TMUX_PATH="$1" \
      TAP_INDEX_HOME="$2" TAP_HOME="$1/.tap/bus" TAP_SKIP_VERSION_BRIEFING=1 \
      TAP_HARNESS_SESSION_ID="$3" \
      bash "$TAP" register opus --accept-observed-identity >/dev/null 2>"$4" ) || true
}

WITHDRAW_ROOT="$(seed_relaunch_row operator-withdrawal old-aaaa new-bbbb)"
register_once "$WITHDRAW_ROOT" "$WORK/operator-withdrawal-index" old-aaaa "$WORK/operator-withdrawal.err"
check operator-withdrawal before "$(snapshot "$WITHDRAW_ROOT")" \
  "quarantined|launcher_new|old-aaaa|yes"

WITHDRAW_ERR="$WORK/operator-withdrawal-accept.err"
withdraw_identity "$WITHDRAW_ROOT" "$WORK/operator-withdrawal-index" old-aaaa "$WITHDRAW_ERR"
check operator-withdrawal after "$(snapshot "$WITHDRAW_ROOT")" \
  "accepted|operator_accepted|old-aaaa|no"

# The withdrawal announces itself and names BOTH ids. A silent one would be
# indistinguishable from the verb having done nothing, and this is the one place
# a human overrode a refusal — the least appropriate place for silence.
if grep -q 'retired the launcher identity expectation' "$WITHDRAW_ERR" \
  && grep -q 'new-bbbb' "$WITHDRAW_ERR" && grep -q 'old-aaaa' "$WITHDRAW_ERR"; then
  echo "identity-capture-reregistration: withdrawal names both ids: ok"
else
  echo "identity-capture-reregistration: withdrawal was silent or unnamed" >&2
  cat "$WITHDRAW_ERR" >&2
  FAILED=1
fi

# The withdrawal is RECORDED, not merely applied: a later reader must be able to
# tell an attested identity from one a human waved through.
retired_field() { # <root>
  python3 -B - "$1/.tap/team-registry.json" <<'RETIRED'
import json, sys
capture = json.load(open(sys.argv[1]))["seats"]["opus"].get("identity_capture_result") or {}
print(capture.get("retired_expectation", ""))
RETIRED
}
check operator-withdrawal record "$(retired_field "$WITHDRAW_ROOT")" "new-bbbb"

# SCOPE. The same flag must NOT wave through a duplicate-owner refusal: whether
# another seat owns this native id is not a question the operator was asked, and
# accepting it is how two seats end up answering as one.
DUP_ROOT="$(seed_arm withdrawal-scope "-")"
python3 -B - "$DUP_ROOT/.tap/team-registry.json" <<'DUPSEED'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
seats = data["seats"]
seats["opus"]["identity_capture"]["expected_harness_session_id"] = "expected-1111"
seats["fable"] = {"base": "wolp", "delivery": "pane", "status": "active",
                  "harness": "claude", "session": "wolp-fable-0",
                  "pane": "wolp-fable-0:0.0", "pane_id": "%99998", "index": 2,
                  "registered_from_worktree": seats["opus"]["registered_from_worktree"],
                  "harness_session_id": "shared-9999"}
json.dump(data, open(path, "w"))
DUPSEED
DUP_ERR="$WORK/withdrawal-scope.err"
withdraw_identity "$DUP_ROOT" "$WORK/withdrawal-scope-index" shared-9999 "$DUP_ERR"
if grep -q 'already belongs to expected seat' "$DUP_ERR"; then
  echo "identity-capture-reregistration: withdrawal does not wave through duplicate owner: ok"
else
  echo "identity-capture-reregistration: withdrawal waved through a duplicate-owner refusal" >&2
  cat "$DUP_ERR" >&2
  FAILED=1
fi

# ── The refusal is DISCOVERABLE (tap-zqcd) ────────────────────────────────────
# A retirement verb nobody can discover a need for is worse than no verb. Before
# this check the standing quarantine was invisible: tap-register writes it,
# SessionStart prints it once into a banner the operator scrolls past, and
# nothing else in the shipped scripts reads it — so a seat could re-quarantine on
# every start forever with no way to notice but reading the registry by hand.
#
# Asserted in BOTH directions in one fixture. "doctor said nothing" is satisfied
# by a doctor that cannot say anything, so the clean row has to stay quiet in the
# same run where the quarantined row speaks.
doctor_output() { # <root> <index>
  ( cd "$1" && env -u TAP_CLEAR_ID -u TMUX_PANE PATH="$MOCKBIN:$PATH" \
      TAP_INDEX_HOME="$2" TAP_HOME="$1/.tap/bus" \
      bash "$TAP" doctor 2>&1 ) || true
}

DOCTOR_ROOT="$(seed_relaunch_row doctor-visibility old-aaaa new-bbbb)"
register_once "$DOCTOR_ROOT" "$WORK/doctor-visibility-index" old-aaaa
check doctor-visibility quarantined "$(snapshot "$DOCTOR_ROOT")" \
  "quarantined|launcher_new|old-aaaa|yes"
DOCTOR_SAYS="$(doctor_output "$DOCTOR_ROOT" "$WORK/doctor-visibility-index")"

# Four things the message must carry, because each one is a separate way for the
# operator to be left stuck: WHICH seat, WHAT was expected, WHAT arrived, and the
# runnable verb. A warning that names the condition without the remedy sends them
# to the hammer.
for needle in "standing identity quarantine" "opus" "new-bbbb" "old-aaaa" \
  "tap register opus --accept-observed-identity"; do
  if printf '%s' "$DOCTOR_SAYS" | grep -qF "$needle"; then
    echo "identity-capture-reregistration: doctor names '$needle': ok"
  else
    echo "identity-capture-reregistration: doctor output omits '$needle'" >&2
    printf '%s\n' "$DOCTOR_SAYS" >&2
    FAILED=1
  fi
done

# The caution is the point of the message, not decoration: `tap out` + `tap in`
# genuinely clears the quarantine, by deleting the row and everything on it. An
# operator who reaches for that hammer has fixed the symptom and destroyed the
# record of why — so the warning that arrives first has to say so.
if printf '%s' "$DOCTOR_SAYS" | grep -qF "do NOT use tap out/tap in"; then
  echo "identity-capture-reregistration: doctor warns off the destructive path: ok"
else
  echo "identity-capture-reregistration: doctor did not warn off tap out/tap in" >&2
  FAILED=1
fi

# NEGATIVE DIRECTION, same fixture: once the operator withdraws the refusal, the
# check must go quiet. A doctor that warns forever teaches the operator to ignore
# it, which costs more than never having warned.
withdraw_identity "$DOCTOR_ROOT" "$WORK/doctor-visibility-index" old-aaaa \
  "$WORK/doctor-visibility-accept.err"
DOCTOR_AFTER="$(doctor_output "$DOCTOR_ROOT" "$WORK/doctor-visibility-index")"
if printf '%s' "$DOCTOR_AFTER" | grep -qF "standing identity quarantine"; then
  echo "identity-capture-reregistration: doctor still warns after the withdrawal" >&2
  printf '%s\n' "$DOCTOR_AFTER" >&2
  FAILED=1
else
  echo "identity-capture-reregistration: doctor goes quiet after the withdrawal: ok"
fi

# ── The flag's REFUSALS, which are the half a scope arm does not reach ────────
# The scope arm below proves duplicate-owner still refuses. These prove the
# RECORD around that refusal is honest, which is a separate property and the one
# that broke: deciding the retirement before the quarantine ladder meant stderr
# announced an acceptance one line before the refusal, stamped retired_expectation
# for a retirement that never took, and dropped expected_harness_session_id — so
# `tap doctor` then reported "(none recorded)" for an expectation still standing.
# Running the verb degraded the exact message the verb exists to answer.
BOTH_ROOT="$(seed_relaunch_row both-classes old-aaaa new-bbbb)"
python3 -B - "$BOTH_ROOT/.tap/team-registry.json" <<'BOTHSEED'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
seats = data["seats"]
# The observed id belongs to ANOTHER seat and also mismatches the expectation.
seats["fable"] = {"base": "wolp", "delivery": "pane", "status": "active",
                  "harness": "claude", "session": "wolp-fable-0",
                  "pane": "wolp-fable-0:0.0", "pane_id": "%99998", "index": 2,
                  "registered_from_worktree": seats["opus"]["registered_from_worktree"],
                  "harness_session_id": "shared-9999"}
json.dump(data, open(path, "w"))
BOTHSEED
BOTH_ERR="$WORK/both-classes.err"
withdraw_identity "$BOTH_ROOT" "$WORK/both-classes-index" shared-9999 "$BOTH_ERR"
if grep -q 'retired the launcher identity expectation' "$BOTH_ERR"; then
  echo "identity-capture-reregistration: a defeated retirement was still announced" >&2
  cat "$BOTH_ERR" >&2
  FAILED=1
else
  echo "identity-capture-reregistration: a defeated retirement is not announced: ok"
fi
if grep -q 'already belongs to expected seat' "$BOTH_ERR"; then
  echo "identity-capture-reregistration: both-classes row still refuses on ownership: ok"
else
  echo "identity-capture-reregistration: both-classes row lost its ownership refusal" >&2
  FAILED=1
fi
# The expectation must still be READABLE afterwards. This is the doctor's input:
# a dropped expected id turns a standing question into "(none recorded)".
both_expected() {
  python3 -B - "$BOTH_ROOT/.tap/team-registry.json" <<'BOTHREAD'
import json, sys
seat = json.load(open(sys.argv[1]))["seats"]["opus"]
capture = seat.get("identity_capture_result") or {}
print("%s|%s" % (capture.get("expected_harness_session_id", ""),
                 capture.get("retired_expectation", "")))
BOTHREAD
}
check both-classes record "$(both_expected)" "new-bbbb|"

# NO OBSERVED ID: the flag must change nothing. Without this guard it suppressed
# the refusal and wrote NO verdict at all — applied but not recorded, on the one
# path where the record is the whole product.
NOID_ROOT="$(seed_relaunch_row no-observed-id old-aaaa new-bbbb)"
NOID_ERR="$WORK/no-observed-id.err"
( cd "$NOID_ROOT" && env -u TAP_CLEAR_ID -u TMUX_PANE \
    PATH="$MOCKBIN:$PATH" TMUX="/tmp/fake-wolp,1,0" FAKE_TMUX_PATH="$NOID_ROOT" \
    TAP_INDEX_HOME="$WORK/no-observed-id-index" TAP_HOME="$NOID_ROOT/.tap/bus" \
    TAP_SKIP_VERSION_BRIEFING=1 TAP_TRANSCRIPT_PATH="$WORK/fake-transcript.jsonl" \
    bash "$TAP" register opus --accept-observed-identity >/dev/null 2>"$NOID_ERR" ) || true
if grep -q 'changed nothing' "$NOID_ERR"; then
  echo "identity-capture-reregistration: a flag that cannot apply says so: ok"
else
  echo "identity-capture-reregistration: the flag was silently ignored with no observed id" >&2
  cat "$NOID_ERR" >&2
  FAILED=1
fi
if grep -q 'retired the launcher identity expectation' "$NOID_ERR"; then
  echo "identity-capture-reregistration: an empty id was announced as accepted" >&2
  FAILED=1
else
  echo "identity-capture-reregistration: an empty id is not announced as accepted: ok"
fi

# ── The doctor's remedy is per CLASS, because the verb is ─────────────────────
# Four quarantine reasons, one withdrawable. Recommending the verb for the other
# three hands the operator a command that cannot work while the same message
# forbids the destructive path that would — a remedy that does not run in the
# failure state, inside the check built to prevent a discovery failure.
DUP_DOCTOR="$(doctor_output "$BOTH_ROOT" "$WORK/both-classes-index")"
if printf '%s' "$DUP_DOCTOR" | grep -qF -- "--accept-observed-identity will not clear it"; then
  echo "identity-capture-reregistration: doctor says the verb does not fix an ownership quarantine: ok"
else
  echo "identity-capture-reregistration: doctor did not scope its remedy by class" >&2
  printf '%s\n' "$DUP_DOCTOR" >&2
  FAILED=1
fi


# ── The OPERATOR verb on the DIFFERING-id branch (tap-o07f2) ─────────────────
# This arm exists because the operator-withdrawal arms above only ever exercise
# the branch where the observed id MATCHES the row's prior id. That is
# `same_observation`, so `match_update` is false and the retirement is recorded by
# the capture_result write. The differing-id case takes the OTHER path, where
# `match_update` rebuilds `identity_capture_result` from scratch -- and it was
# silently dropping `retired_expectation` on main, for the operator verb, since
# tap-zqcd shipped.
#
# Nobody saw it because the one arm exercising the verb took the easy branch. An
# arm that only ever runs one side of a branch is the same failure class as a
# suite whose controls agree with its positives: it reports on the harness, not
# the subject. The rebind arms below found it by accident, which is not a
# reproducible way to find things -- hence this arm, on the operator path, named.
OPDIFF_ROOT="$(seed_relaunch_row operator-withdrawal-differing-id old-aaaa new-bbbb)"
OPDIFF_ERR="$WORK/operator-withdrawal-differing-id.err"
withdraw_identity "$OPDIFF_ROOT" "$WORK/operator-withdrawal-differing-id-index" fresh-dddd "$OPDIFF_ERR"
check operator-withdrawal-differing-id after "$(snapshot "$OPDIFF_ROOT")" \
  "accepted|operator_accepted|fresh-dddd|no"
# The assertion that reds on the pre-existing defect. The line above passes with
# or without the fix -- the row is accepted either way -- so the ONLY observable
# of the lost record is this field.
check operator-withdrawal-differing-id record "$(retired_field "$OPDIFF_ROOT")" "new-bbbb"

# ── SELF-ATTESTED REBIND after /clear or /compact (tap-o07f2) ─────────────────
# The machine twin of the operator withdrawal above, and it belongs in THIS file
# because it is two more cells of the same table: the header already says this
# fixture covers "every resume, clear and compact", and the branch under test is
# the first one that tells those four apart.
#
# THE DEFECT, measured on this box 2026-08-23 before the fix existed: one seat's
# acting harness_session_id appeared in NONE of the 17 live Claude Code session
# rows, while `quarantined_harness_session_id` held the pane's actual session.
# `/clear` mints a new native id, the seat reports it truthfully on the next
# SessionStart, and the launcher expectation outranks it forever. TAP then routes
# native delivery against an id that does not exist -- ccnative refuses
# `session_id_split`, the attempt is recorded against ccnative with that reason,
# the payload spools, and the drain redelivers over tmux. The mail arrives; native
# never runs; nothing surfaces that to an operator (tap-eloxh). "Silently" was the
# earlier wording here and it overstated the defect -- the log is not silent, the
# operator is uninformed, and only one of those is a lost message.
#
# The controls are not decoration here. `startup` and `resume` MUST still refuse:
# an exact-resume that reports a different id is genuinely suspicious, because the
# launcher asked for a SPECIFIC conversation and got another one. A fix that
# adopts on all four sources would make every arm above this line unreachable, and
# only these controls can red on it.
rebind_register() { # <root> <index> <observed> <source> [stderr_path]
  ( cd "$1" && env -u TAP_CLEAR_ID -u TMUX_PANE \
      PATH="$MOCKBIN:$PATH" TMUX="/tmp/fake-wolp,1,0" FAKE_TMUX_PATH="$1" \
      TAP_INDEX_HOME="$2" TAP_HOME="$1/.tap/bus" TAP_SKIP_VERSION_BRIEFING=1 \
      TAP_HARNESS_SESSION_ID="$3" TAP_SESSION_SOURCE="$4" \
      bash "$TAP" register opus >/dev/null 2>"${5:-/dev/null}" ) || true
}

# The root is published in a NAMED variable rather than on stdout. An earlier
# draft echoed it, so `check`'s own output was captured into the path and the
# arm's verdict vanished from the log while a later read failed on a filename
# containing an `ok` line. A helper that prints a verdict cannot also return a
# value through stdout.
REBIND_ROOT=""
rebind_arm() { # <name> <source> <expected_snapshot> ; sets REBIND_ROOT
  local name="$1" source="$2" want="$3" err
  REBIND_ROOT="$(seed_relaunch_row "$name" old-aaaa new-bbbb)"
  err="$WORK/$name.err"
  rebind_register "$REBIND_ROOT" "$WORK/$name-index" cleared-cccc "$source" "$err"
  check "$name" "source=$source" "$(snapshot "$REBIND_ROOT")" "$want"
}

rebind_arm rebind-clear clear "accepted|self_attested_rebind|cleared-cccc|no"
REBIND_CLEAR_ROOT="$REBIND_ROOT"
rebind_arm rebind-compact compact "accepted|self_attested_rebind|cleared-cccc|no"

# THE CONTROLS. Same row, same reported id, same everything but the source.
rebind_arm rebind-control-startup startup "quarantined|launcher_new|old-aaaa|yes"
rebind_arm rebind-control-resume  resume  "quarantined|launcher_new|old-aaaa|yes"
# An absent source is the pre-fix world and every non-hook `tap in`: a bare
# `tap in` typed by hand must not be able to retire an expectation.
rebind_arm rebind-control-nosource "" "quarantined|launcher_new|old-aaaa|yes"
# THE ADMIT-SET CONTROL (panel review). The three controls above pin the
# REFUSE-set: they name sources that must not adopt. Nothing pinned the ADMIT-set,
# so a mutant WIDENING the condition to a fourth source -- `rewind`, `SessionStart`,
# any nonempty token -- reds nothing, because no arm ever supplied an un-admitted
# NONEMPTY source. The empty-source control does not cover it: empty fails the
# `session_source in (...)` test for a different reason than an unrecognized token
# does, and a mutant can break one while the other still holds.
#
# A nonsense token is deliberate rather than a plausible future source name: the
# arm must red when the SET is widened, not encode an opinion about which sources
# Claude Code might add. If a real fourth source is ever admitted, this arm reds
# and whoever admits it says so here.
rebind_arm rebind-control-unknown-source "not-a-real-source" "quarantined|launcher_new|old-aaaa|yes"

# ── THE FOREIGN CALLER (tap-lcdm P1-3) ───────────────────────────────────────
# The admitted sources above all model a seat registering ITS OWN pane. This arm
# is the other half: a caller that reports a legal `clear` and a legal new id, for
# a pane it does NOT run under. `--pane` makes that possible, which is why "believe
# a seat about itself" was the wrong description of this branch — it was never
# self-referential, and nothing proved the caller lived in the pane it named.
#
# FAKE_PANE_PID IS A LIVE PROCESS, deliberately. A dead pid would also produce a
# refusal — `tap_pid_has_ancestor` fails closed on a pid it cannot read — and the
# arm would pass because the INSTRUMENT broke rather than because the code
# refused. Those are different facts and only one of them is what this arm claims.
# `$FOREIGN_PID` is a live `sleep` started at the top of the file and reaped in the
# trap: readable by `ps`, and an ancestor of nothing here.
#
# So the pair is honest in both directions: the accept arms above prove the check
# passes for a caller genuinely inside the pane, and this proves it refuses for one
# that is not. Neither alone establishes the check works.
REBIND_FOREIGN_ROOT="$(seed_relaunch_row rebind-foreign-caller old-aaaa new-bbbb)"
REBIND_FOREIGN_ERR="$WORK/rebind-foreign-caller.err"
( cd "$REBIND_FOREIGN_ROOT" && env -u TAP_CLEAR_ID -u TMUX_PANE \
    PATH="$MOCKBIN:$PATH" TMUX="/tmp/fake-wolp,1,0" FAKE_TMUX_PATH="$REBIND_FOREIGN_ROOT" \
    FAKE_PANE_PID="$FOREIGN_PID" \
    TAP_INDEX_HOME="$WORK/rebind-foreign-caller-index" TAP_HOME="$REBIND_FOREIGN_ROOT/.tap/bus" \
    TAP_SKIP_VERSION_BRIEFING=1 \
    TAP_HARNESS_SESSION_ID=cleared-cccc TAP_SESSION_SOURCE=clear \
    bash "$TAP" register opus >/dev/null 2>"$REBIND_FOREIGN_ERR" ) || true
check rebind-foreign-caller refuses "$(snapshot "$REBIND_FOREIGN_ROOT")" \
  "quarantined|launcher_new|old-aaaa|yes"
if grep -q 'self-attested' "$REBIND_FOREIGN_ERR"; then
  echo "identity-capture-reregistration: a caller outside the pane retired its expectation" >&2
  cat "$REBIND_FOREIGN_ERR" >&2
  FAILED=1
else
  echo "identity-capture-reregistration: a caller outside the pane cannot rebind: ok"
fi
# The live-pid precondition, asserted rather than assumed. If the sleep has been
# reaped early the arm above is vacuous, and it would pass.
if kill -0 "$FOREIGN_PID" 2>/dev/null; then
  echo "identity-capture-reregistration: the foreign pid was live for its arm: ok"
else
  echo "identity-capture-reregistration: the foreign pid was DEAD — the refusal above proves nothing" >&2
  FAILED=1
fi

rebind_arm rebind-fork fork "accepted|self_attested_rebind|cleared-cccc|no"

# ── THE VENDOR PREMISE, PINNED (tap-o07f2) ───────────────────────────────────
# `fork` is in the admitted set on fable's argument that a fork ALWAYS mints a
# distinct new session id, so there is no wrong id for it to adopt. That is a
# claim about Claude Code's behavior, not about this repository, and a future
# release can change it without telling us.
#
# So the code does not rely on it: a rebind must present an id DIFFERENT from the
# one the row is already acting on. This arm is that guard.
#
# IT ENCODES A PREMISE RATHER THAN A REACHABLE PATH. Today the harness never
# produces a fork that reports the parent's id, so this arm exercises a case that
# cannot currently happen -- which is exactly why it is worth keeping. Delete it
# and the safety argument goes back to resting on a vendor behavior nobody is
# watching; keep it and the day the premise breaks, this is the line that says
# WHICH assumption broke rather than a mysterious adopted identity.
#
# Do not remove it as dead weight. It is a tripwire on someone else's code.
FORK_SAME_ROOT="$(seed_relaunch_row fork-reports-parent-id old-aaaa new-bbbb)"
FORK_SAME_ERR="$WORK/fork-reports-parent-id.err"
rebind_register "$FORK_SAME_ROOT" "$WORK/fork-reports-parent-id-index" old-aaaa fork "$FORK_SAME_ERR"
check fork-reports-parent-id refuses "$(snapshot "$FORK_SAME_ROOT")" \
  "quarantined|launcher_new|old-aaaa|yes"
if grep -q 'self-attested' "$FORK_SAME_ERR"; then
  echo "identity-capture-reregistration: a fork reporting the parent id was adopted" >&2
  cat "$FORK_SAME_ERR" >&2
  FAILED=1
else
  echo "identity-capture-reregistration: a fork reporting the parent id is not adopted: ok"
fi

# The rebind announces itself and names BOTH ids, for the same reason the operator
# withdrawal does: a silent retirement is indistinguishable from one that never
# happened, and this is a refusal being withdrawn with no human in the room --
# which makes the record MORE load-bearing than the operator path, not less.
REBIND_ERR="$WORK/rebind-clear.err"
if grep -q 'self-attested clear' "$REBIND_ERR" \
  && grep -q 'new-bbbb' "$REBIND_ERR" && grep -q 'cleared-cccc' "$REBIND_ERR"; then
  echo "identity-capture-reregistration: rebind names the source and both ids: ok"
else
  echo "identity-capture-reregistration: rebind was silent or unnamed" >&2
  cat "$REBIND_ERR" >&2
  FAILED=1
fi

# RECORDED, not merely applied -- and this is the arm that would red if the branch
# ever stamped `operator_accepted`. False provenance in the one record whose job
# is provenance is the failure mode named directly; `retired_expectation` is
# written the same way, so an auditor can still see WHICH expectation went.
check rebind-clear record "$(retired_field "$REBIND_CLEAR_ROOT")" "new-bbbb"

# ── SCOPE: the rebind must not reach a duplicate-owner refusal ────────────────
# Same boundary as the operator verb, for the same reason and it needs its own
# arm because it is a DIFFERENT mechanism reaching the same excluded class. A
# `/clear` retires a question the seat can answer about itself ("the id you
# expected is gone, here is my new one"); whether another seat already owns the
# reported id is a fact about a THIRD party that no self-attestation can settle.
# Two mechanisms, no overlap.
REBIND_DUP_ROOT="$(seed_relaunch_row rebind-duplicate-owner old-aaaa new-bbbb)"
python3 -B - "$REBIND_DUP_ROOT/.tap/team-registry.json" <<'REBINDDUP'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
seats = data["seats"]
seats["fable"] = {"base": "wolp", "delivery": "pane", "status": "active",
                  "harness": "claude", "session": "wolp-fable-0",
                  "pane": "wolp-fable-0:0.0", "pane_id": "%99998", "index": 2,
                  "registered_from_worktree": seats["opus"]["registered_from_worktree"],
                  "harness_session_id": "shared-9999"}
json.dump(data, open(path, "w"))
REBINDDUP
REBIND_DUP_ERR="$WORK/rebind-duplicate-owner.err"
rebind_register "$REBIND_DUP_ROOT" "$WORK/rebind-duplicate-owner-index" shared-9999 clear "$REBIND_DUP_ERR"
if grep -q 'already belongs to expected seat' "$REBIND_DUP_ERR"; then
  echo "identity-capture-reregistration: rebind does not wave through duplicate owner: ok"
else
  echo "identity-capture-reregistration: rebind waved through a duplicate-owner refusal" >&2
  cat "$REBIND_DUP_ERR" >&2
  FAILED=1
fi
if grep -q 'self-attested' "$REBIND_DUP_ERR"; then
  echo "identity-capture-reregistration: a defeated rebind was still announced" >&2
  cat "$REBIND_DUP_ERR" >&2
  FAILED=1
else
  echo "identity-capture-reregistration: a defeated rebind is not announced: ok"
fi

[ "$FAILED" = 0 ] || exit 1
echo "identity-capture-reregistration: ok"
