#!/usr/bin/env bash
# D5: public — refresh-self-exit-translation.test.sh:66-79: exercises behavior through the public CLI surface only
# tap-o4ae: fixture env must stay in this process — refuse `source`.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# refresh-self-exit-translation.test.sh — tap-8w0p.
#
# THE SELF TWIN of refresh-exit-translation.test.sh, and it exists because the
# tap-utpn exit-surface fix was applied to the PEER arm only. `tap refresh` owns
# its exit surface on both arms or on neither:
#
#   /tap-self clear 3 = the pane is gone (nothing happened)
#   tap refresh 3 = the preflight spool scan was unstable (nothing changed; retry)
#
#   /tap-self clear 7 = the clear was SUBMITTED but its recovery wake did NOT land
#   tap refresh 7 = the clear COMPLETED and the RETIREMENT was refused
#
#   /tap-self clear 8 = the clear was submitted and its wake queued; the context
#                   reset is UNVERIFIED and cannot be observed from that process
#
# refresh translates them to 9 (submitted, reset unverifiable), 10 (submitted,
# wake missing) and 1 (pane gone — nothing happened). Not 8: refresh 8 is the
# PEER arm's "process replaced, rebind unconfirmed", a different next step.
#
# Opposite next steps behind the same numbers, on the path a seat runs on ITSELF
# — where no operator is watching a receipt at all. The 8 case is the one this
# bead is named for: a self clear can never witness its own effect (the script is
# dead before a slash command executes at turn end), so it must never hand
# `tap refresh --fresh` the rc-0 machine authorization to retire and mint an
# instance on the strength of a submission.
#
# Same technique as the peer twin, adapted for the native route (tap-diagnostics-u3b):
# bin/tap refresh resolves BOTH engine paths from the REAL scripts directory, so
# copied-tree stubs are unreachable. The interposer is instead a fixture-local
# `bun` earlier on PATH whose preload stubs both native engines: the self clear
# and, since R7b, the in-process peer clear (cmdClearNative). No production
# code learns it is under test.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
# shellcheck source=sandbox-pins.sh
. "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILED=0
REAL_BUN="$(command -v bun)"
mkdir -p "$WORK/bin"

# --- the engine interposer ----------------------------------------------------
# Records that it ran, so an assertion cannot pass because refusal happened
# earlier and the self arm was never reached at all. The peer arm is stubbed to
# exit 0 AND log, so a self target that wrongly reaches the peer engine is
# VISIBLE (the old fixture achieved this with two separate stubs in a copy).
# Interpose the native module, not the deleted shell clear body. Public refresh
# still performs its real caller/registry/obligation checks in this fixture.
cat > "$WORK/bin/bun" <<SHIM
#!/bin/bash
exec "$REAL_BUN" --preload "$WORK/self-stub.ts" "\$@"
SHIM
chmod +x "$WORK/bin/bun"
stub_self() {
  cat > "$WORK/self-stub.ts" <<STUB
import { mock } from "bun:test";
import { appendFileSync } from "node:fs";
import { TapError } from "$ROOT/runtime/bun/src/context.ts";
// Keep every real export: tap self and the compact worker import this module too.
import * as real from "$ROOT/runtime/bun/src/self-rebrief.ts";
mock.module("$ROOT/runtime/bun/src/self-rebrief.ts", () => ({
  ...real,
  armSelfRecovery(options) {
    appendFileSync("$WORK/self-engine.log", "ran " + options.verb + "\n");
    console.error("stub native self clear: exiting $1");
    if ($1 === 6) throw new TapError(6, "reset_witness_unsupported", "supervised reset", "no native witness");
    return $1;
  },
}));
import * as replace from "$ROOT/runtime/bun/src/launcher/replace.ts";
mock.module("$ROOT/runtime/bun/src/launcher/replace.ts", () => ({
  ...replace,
  async cmdClearNative() { appendFileSync("$WORK/peer-engine.log", "peer engine ran\n"); return 0; },
}));
STUB
}
stub_self 8

# --- a tmux (and ps) that answer just enough for self-identity resolution -----
# `tap refresh` takes its self arm only when the CALLING PANE resolves to the
# named handle, so the fixture must own that resolution. Two shims, because
# `tap_calling_pane_id` walks the process ancestry for a controlling tty and then
# requires the tty->pane binding to be RE-ASSERTED from one display-message
# (tap-bzyz): `ps` supplies the tty, `tmux` must agree about which pane owns it.
# Deliberately not the full-fidelity fake tmux the pane fixtures carry (renumber,
# send-keys, band state) — no pane input happens here; the engine is a stub.
PANE_ID='%54321'
PANE_TTY='/dev/faketty'
cat > "$WORK/bin/ps" <<'PSSHIM'
#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" ppid= "* && " $* " == *" tty= "* ]]; then
  printf '1 faketty\n'
  exit 0
fi
exit 1
PSSHIM
chmod +x "$WORK/bin/ps"
build_tmux() { # <server-epoch answer for the calling-pane identity record>
  # ${1-...} not ${1:-...}: an EMPTY epoch answer is the unverifiable fixture.
  local epoch="${1-900:100}"
  cat > "$WORK/bin/tmux" <<TMUX
#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:?}"; shift
args=("\$@")
fmt="\${args[\${#args[@]}-1]:-}"
case "\$cmd" in
  list-sessions)
    if [[ "\$*" == *start_time* ]]; then printf 'selfx\t900:100\n'; else printf 'selfx\n'; fi ;;
  has-session) exit 0 ;;
  list-panes)
    case "\$fmt" in
      *pane_tty*) printf '%s\t%s\n' "$PANE_ID" "$PANE_TTY" ;;
      *) printf 'selfx\t%s\t%s\tclaude\t4242\t900:100\t0\n' 'selfx:0.0' "$PANE_ID" ;;
    esac ;;
  display-message)
    case "\$fmt" in
      # Four-field calling observe (pane_id+pane_tty+session_name+generation).
      # *pane_id*pane_tty* also matches that string; first match must not
      # return two fields (tap-316wj).
      *pane_id*pane_tty*session_name*) printf '%s\t%s\tselfx\t%s\n' "$PANE_ID" "$PANE_TTY" "$epoch" ;;
      *pane_id*pane_tty*) printf '%s\t%s\n' "$PANE_ID" "$PANE_TTY" ;;
      *pane_id*session_name*start_time*) printf '%s\tselfx\t%s\n' "$PANE_ID" "$epoch" ;;
      *pid*start_time*) printf '900:100\n' ;;
      *pane_id*session_name*) printf '%s\tselfx\n' "$PANE_ID" ;;
      *pane_id*) printf '%s\n' "$PANE_ID" ;;
      *pane_current_command*) printf 'claude\n' ;;
      *session_name*) printf 'selfx\n' ;;
      *window_index*|*pane_index*) printf '0\n' ;;
      *) printf '\n' ;;
    esac ;;
  *) exit 0 ;;
esac
TMUX
  chmod +x "$WORK/bin/tmux"
}
build_tmux 900:100

# --- the world: one enrolled team, one active seat on THIS pane ---------------
BUS_ROOT="$WORK/repo"
BUS="$BUS_ROOT/.tap/bus"
INDEX="$WORK/index"
mkdir -p "$BUS/payloads" "$BUS/receipts" "$INDEX"
git -C "$BUS_ROOT" init -q
python3 -B - "$INDEX" "$BUS_ROOT" "$PANE_ID" <<'PY'
import json, os, sys
index, root, pane_id = sys.argv[1:4]
registry = os.path.join(root, ".tap", "team-registry.json")
with open(os.path.join(index, "global-registry.json"), "w") as fh:
    json.dump({"schema": "0.20", "teams": {"selfx": {
        "enrolled_at": "2026-08-15T00:00:00Z", "registry_location": registry,
        "root": root, "state": "registered"}}}, fh)
seat = {"base": "selfx", "delivery": "pane", "status": "active", "harness": "claude",
        "session": "selfx", "pane": "selfx:0.0", "pane_id": pane_id,
        "server_epoch": "srv:900:100", "index": 1, "registered_from_worktree": root, "instance": "solo|deadbeefdeadbeef"}
with open(registry, "w") as fh:
    json.dump({"schema": "0.20", "team": {"name": "selfx", "worktree_root": root},
               "seats": {"solo": seat}}, fh)
with open(os.path.join(root, ".tap", "bus", "registry.json"), "w") as fh:
    json.dump({"schema": "0.20", "team": {"name": "selfx", "worktree_root": root},
               "seats": {"solo": seat}}, fh)
PY

run_refresh() { # <engine exit code> [<extra refresh arg>...] ; echoes "<rc>|<stderr>"
  local code="$1"; shift
  stub_self "$code"
  rm -f "$WORK/self-engine.log" "$WORK/peer-engine.log"
  local rc=0 err="$WORK/refresh.err"
  ( cd "$BUS_ROOT" && env PATH="$WORK/bin:$PATH" TMUX="/tmp/fake,1,0" TMUX_PANE="$PANE_ID" \
      TAP_INDEX_HOME="$INDEX" TAP_HOME="$BUS" \
      bash "$ROOT/bin/tap" refresh solo "$@" >/dev/null 2>"$err" ) || rc=$?
  printf '%s|%s' "$rc" "$(tr '\n' ' ' < "$err")"
}

# The stub logs its argv, so this asserts the delegated VERB, not merely that
# something ran. Existence alone left the mapping clear->compact green
# (partner review, exact-head review): a fixture that cannot see the verb it is
# testing is not covering the delegation, only the plumbing around it.
delegated_clear_once() {
  [ -f "$WORK/self-engine.log" ] || return 1
  [ "$(grep -c '^ran clear$' "$WORK/self-engine.log")" = "1" ] || return 1
  [ "$(wc -l < "$WORK/self-engine.log" | tr -d ' ')" = "1" ] || return 1
}
tombstones() { ls "$BUS_ROOT/.tap/team-history" 2>/dev/null | wc -l | tr -d ' '; }

check() { # <label> <actual> <expected>
  if [ "$2" = "$3" ]; then
    printf 'refresh-self-exit-translation: %s -> %s: ok\n' "$1" "$2"
  else
    printf 'refresh-self-exit-translation: %s expected [%s] got [%s]\n' "$1" "$3" "$2" >&2
    FAILED=1
  fi
}
refute_unchanged() { # <label> <stderr>
  if printf '%s' "$2" | grep -q -i "UNCHANGED"; then
    printf 'refresh-self-exit-translation: %s wrongly reported the seat UNCHANGED\n' "$1" >&2
    printf '  %s\n' "$2" >&2
    FAILED=1
  else
    printf 'refresh-self-exit-translation: %s does not claim the seat is unchanged: ok\n' "$1"
  fi
}

# --- (0) the control: the self arm is actually the arm under test -------------
RESULT="$(run_refresh 8)"
if delegated_clear_once; then
  echo "refresh-self-exit-translation: (0) a self target delegates exactly one 'clear' to the SELF engine: ok"
else
  echo "refresh-self-exit-translation: (0) the self engine did not receive exactly one 'clear' — this fixture is not exercising the self arm (log: $(cat "$WORK/self-engine.log" 2>/dev/null || echo '<none>'))" >&2
  printf '  %s\n' "${RESULT#*|}" >&2
  FAILED=1
fi
if [ -f "$WORK/peer-engine.log" ]; then
  echo "refresh-self-exit-translation: (0) a self target ran the PEER engine" >&2
  FAILED=1
fi

# --- (1) engine 8: submitted, effect UNVERIFIED ------------------------------
# The bead's own state. It must not be reported as a failure that left the seat
# untouched (the clear IS queued), and it must not be reported as success.
check "(1) engine 8 maps to exactly 9" "${RESULT%%|*}" "9"
refute_unchanged "(1) engine 8" "${RESULT#*|}"
# AND it must not smuggle the claim back as prose. The first draft of this
# message said "if the seat comes back and answers, it cleared" — false, and the
# defect this PR is about, one sentence after naming it: an answer proves the
# WAKE was consumed, and an uncleared seat answers identically (the bead's own
# specimen did exactly that). A receipt that disclaims in the exit code and
# re-asserts in the prose has disclaimed nothing.
# Matches the CLAIM shape ("...it cleared", "proves it cleared", "confirms the
# reset"), not the disclaimer shape ("proves only that the wake was consumed").
# A pattern broad enough to hit both would have to be satisfied by silence, and
# a receipt that says nothing is not what is wanted here.
if printf '%s' "${RESULT#*|}" | grep -q -Ei "(, ?| then )it cleared|proves (it|the seat) cleared|proves the (context )?reset|confirms the (clear|reset)"; then
  echo "refresh-self-exit-translation: (1) engine 8 offers a false proof-of-reset in prose" >&2
  printf '  %s\n' "${RESULT#*|}" >&2
  FAILED=1
else
  echo "refresh-self-exit-translation: (1) engine 8 offers no false proof-of-reset: ok"
fi
# Passing the code through while saying NOTHING is the `exec` shape, not a fix:
# the operator gets a bare nonzero for a state whose next step is specific.
if printf '%s' "${RESULT#*|}" | grep -q -i "tap refresh:"; then
  echo "refresh-self-exit-translation: (1) engine 8 explains the state in refresh's own voice: ok"
else
  echo "refresh-self-exit-translation: (1) engine 8 produced no refresh-level explanation (bare passthrough)" >&2
  printf '  %s\n' "${RESULT#*|}" >&2
  FAILED=1
fi

# --- (2) engine 8 under --fresh must NOT retire ------------------------------
# THE MACHINE-AUTHORIZATION CASE. Phase C — retire the instance, mint a new one,
# notify senders — is reached only on a clear that returned 0. A self clear
# cannot witness its own effect, so it must never return the code that
# authorizes a SECOND destructive act on the strength of a submission.
RESULT="$(run_refresh 8 --fresh)"
check "(2) --fresh engine 8 maps to exactly 9" "${RESULT%%|*}" "9"
check "(2) --fresh engine 8 retires nothing" "$(tombstones)" "0"
refute_unchanged "(2) --fresh engine 8" "${RESULT#*|}"
# tap-pfkz: the "nothing was retired" sentence is true of this run and
# misleading about the world — a self refresh can NEVER retire its instance, so
# an operator who reads it as a per-run miss re-runs it forever. The receipt
# states the structural limit and names the one route that works: a peer runs
# `tap refresh <handle> --fresh` once the pending recovery completes.
FRESH_ERR="${RESULT#*|}"
if printf '%s' "$FRESH_ERR" | grep -q -i "can never retire\|cannot retire" \
    && printf '%s' "$FRESH_ERR" | grep -q -i "re-running will not"; then
  echo "refresh-self-exit-translation: (2) --fresh engine 8 states the self path cannot retire, so re-running will not help: ok"
else
  echo "refresh-self-exit-translation: (2) --fresh engine 8 does not state the structural limit" >&2
  printf '  %s\n' "$FRESH_ERR" >&2
  FAILED=1
fi
if printf '%s' "$FRESH_ERR" | grep -q -i "ask a peer to run 'tap refresh solo --fresh'"; then
  echo "refresh-self-exit-translation: (2) --fresh engine 8 names the peer route: ok"
else
  echo "refresh-self-exit-translation: (2) --fresh engine 8 does not name the peer route" >&2
  printf '  %s\n' "$FRESH_ERR" >&2
  FAILED=1
fi
# The plain self refresh asked for no retirement, so it carries no such advice.
PLAIN_ERR="$(run_refresh 8)"
if printf '%s' "${PLAIN_ERR#*|}" | grep -q -i "peer"; then
  echo "refresh-self-exit-translation: (2) a plain self refresh was handed the --fresh peer advice" >&2
  FAILED=1
else
  echo "refresh-self-exit-translation: (2) a plain self refresh carries no --fresh peer advice: ok"
fi

# --- (3) engine 7: submitted, wake did NOT land ------------------------------
# tap self's 7 is NOT a destructive half that succeeded — that is compact's 7, and
# the clear path inherited the phrase from its sibling (tap-8w0p). Here the clear
# is SUBMITTED, executes at turn end, and NOTHING will wake the seat afterwards.
# Reporting UNCHANGED is still wrong for the same reason: a clear is queued at
# that pane, and it sends the operator away from the one repair that works.
RESULT="$(run_refresh 7)"
refute_unchanged "(3) engine 7" "${RESULT#*|}"
# EXACT, not merely non-colliding. An exclusion list is satisfied by a mapping to
# 0 — which passed every other assertion here, no-tombstone included, while
# reporting a queued clear as a completed refresh (partner review, exact-head
# review). That is this PR's own defect surviving inside this PR's own fixture.
check "(3) engine 7 maps to exactly 10" "${RESULT%%|*}" "10"
# The SELF-SIDE exit-7 surfaces must not assert the destructive half either.
# rc 9's prose was swept in an earlier round and this arm was left out, because I
# was reading 7 as a failure path and looking only at the success path — which is
# how the claim survived in the sibling arm five reviews running (tap-8w0p).
# Scoped to the self path on purpose: the PEER engine's 7 really did replace the
# process, and that claim is true and must survive.
if printf '%s' "${RESULT#*|}" | grep -q -Ei "destructive half (succeeded|happened)|the (context|seat) (is|was) (gone|cleared)"; then
  echo "refresh-self-exit-translation: (3) engine 7 asserts a destructive half that has not happened yet" >&2
  printf '  %s\n' "${RESULT#*|}" >&2
  FAILED=1
else
  echo "refresh-self-exit-translation: (3) engine 7 claims no unwitnessed destructive half: ok"
fi
# The repair must name the SPELLING that works. "send it any message" was true
# before tap-gyc91 and is false after it: a plain send is settle-only and parks
# for the digest, so an operator following the old advice waits out the hold with
# the seat still stopped. The old substring stayed green through that flip, which
# is why this asserts --wake rather than the sentence around it.
if printf '%s' "${RESULT#*|}" | grep -q -i -- "--wake"; then
  echo "refresh-self-exit-translation: (3) engine 7 names the missing wake and the --wake repair: ok"
else
  echo "refresh-self-exit-translation: (3) engine 7 did not tell the operator the wake is missing" >&2
  printf '  %s\n' "${RESULT#*|}" >&2
  FAILED=1
fi

# --- (4) engine 7 under --fresh must NOT retire ------------------------------
RESULT="$(run_refresh 7 --fresh)"
check "(4) --fresh engine 7 maps to exactly 10" "${RESULT%%|*}" "10"
check "(4) --fresh engine 7 retires nothing" "$(tombstones)" "0"
refute_unchanged "(4) --fresh engine 7" "${RESULT#*|}"

# --- (5) engine 3: the pane is gone ------------------------------------------
# Nothing happened, and refresh's own 3 tells the operator the spool scan was
# unstable and to RETRY — advice that sends them back at a pane that is gone.
RESULT="$(run_refresh 3)"
check "(5) engine 3 maps to exactly 1" "$(run_refresh 3 | cut -d'|' -f1)" "1"

# --- (5a) the --fresh route is a SECOND call site and gets its own arms --------
# tap-utpn's whole lesson is that a translation with two sites and one arm is a
# translation with one site. Every state therefore gets a --fresh result AND a
# no-retirement assertion, and the delegated verb is re-proven on this route
# rather than inherited from the plain one (a reviewer's testing gap): the two
# sites resolve the engine independently, so one could delegate `compact` while
# the other delegates `clear` and only a route-local check would see it.
RESULT="$(run_refresh 3 --fresh)"
check "(5a) --fresh engine 3 maps to exactly 1" "${RESULT%%|*}" "1"
check "(5a) --fresh engine 3 retires nothing" "$(tombstones)" "0"
if delegated_clear_once; then
  echo "refresh-self-exit-translation: (5a) the --fresh route delegates exactly one 'clear' too: ok"
else
  echo "refresh-self-exit-translation: (5a) the --fresh route did not delegate exactly one 'clear' (log: $(cat "$WORK/self-engine.log" 2>/dev/null || echo '<none>'))" >&2
  FAILED=1
fi

# --- (5b) engine 6: DEGRADED, nothing submitted ------------------------------
# tap self exits 6 when the harness has no known clear command — it refuses rather
# than guessing a spelling, so NOTHING was submitted. refresh's own 6 means
# "refreshed, but a sender notice failed": a COMPLETED refresh with a partial
# tail. Passing 6 through preserves the number and inverts the meaning, which is
# this PR's defect one code over.
RESULT="$(run_refresh 6)"
check "(5b) engine 6 maps to exactly 1, not refresh's own 6" "${RESULT%%|*}" "1"
if printf '%s' "${RESULT#*|}" | grep -q -i "NOT cleared\|nothing was submitted"; then
  echo "refresh-self-exit-translation: (5b) engine 6 says nothing was submitted: ok"
else
  echo "refresh-self-exit-translation: (5b) engine 6 did not tell the operator nothing happened" >&2
  printf '  %s\n' "${RESULT#*|}" >&2
  FAILED=1
fi
check "(5b) --fresh engine 6 maps to exactly 1" "$(run_refresh 6 --fresh | cut -d'|' -f1)" "1"
check "(5b) --fresh engine 6 retires nothing" "$(tombstones)" "0"
# --- (6) codes track NEXT STEPS, not engine states ---------------------------
# The rule is not "every engine code gets its own number" — 3 (pane gone) and 6
# (no clear command for this harness) share code 1 deliberately, because they
# share a next step: nothing happened, and re-running is not the repair. What
# must never merge is two states whose repairs DIFFER. So this asserts the three
# distinct repairs get three distinct codes, and that the two nothing-happened
# states agree.
c8="$(run_refresh 8 | cut -d'|' -f1)"      # wait for the seat to come back
c7="$(run_refresh 7 | cut -d'|' -f1)"      # send it a message; do NOT re-run
c3="$(run_refresh 3 | cut -d'|' -f1)"      # nothing happened
c6="$(run_refresh 6 | cut -d'|' -f1)"      # nothing happened
if [ "$c8" != "$c7" ] && [ "$c8" != "$c3" ] && [ "$c7" != "$c3" ]; then
  echo "refresh-self-exit-translation: (6) the three distinct repairs get three distinct codes: ok"
else
  echo "refresh-self-exit-translation: (6) two states with different repairs share a code (8->$c8 7->$c7 3->$c3)" >&2
  FAILED=1
fi
check "(6) both nothing-happened states share one code" "$c6" "$c3"

# --- (7) an UNVERIFIABLE calling pane refuses as generation_unverifiable ------
# A pane whose server generation cannot be observed confers NO identity. The
# refusal must carry the incumbent wait-and-retry remedy — never "tap register",
# which from an unverifiable pane is exactly the action the identity fence
# exists to prevent. And no engine may run: nothing was authorized.
build_tmux ''
rm -f "${WORK:?}/self-engine.log" "${WORK:?}/peer-engine.log"
rc=0; uv_err="$WORK/uv.err"
( cd "$BUS_ROOT" && env -u TAP_SELF PATH="$WORK/bin:$PATH" TMUX="/tmp/fake,1,0" TMUX_PANE="$PANE_ID" \
    TAP_INDEX_HOME="$INDEX" TAP_HOME="$BUS" \
    bash "$ROOT/bin/tap" refresh >/dev/null 2>"$uv_err" ) || rc=$?
build_tmux 900:100
check "(7) unverifiable pane maps to exactly 1" "$rc" "1"
if [ -f "$WORK/self-engine.log" ] || [ -f "$WORK/peer-engine.log" ]; then
  echo "refresh-self-exit-translation: (7) an engine ran despite the unverifiable-identity refusal" >&2
  FAILED=1
else
  echo "refresh-self-exit-translation: (7) no engine ran on an unverifiable identity: ok"
fi
if printf '%s' "$(cat "$uv_err")" | grep -q "wait for tmux to answer" \
    && ! printf '%s' "$(cat "$uv_err")" | grep -q "tap register"; then
  echo "refresh-self-exit-translation: (7) unverifiable pane gets the wait remedy, not register: ok"
else
  echo "refresh-self-exit-translation: (7) unverifiable-pane refusal lacks the wait remedy: $(cat "$uv_err")" >&2
  FAILED=1
fi

# The real shared arm (without the preload stub) refuses bare self refresh,
# including --fresh, before a reset request or instance retirement can be written.
for fresh in no yes; do
  extra=(); [ "$fresh" != yes ] || extra=(--fresh)
  before_registry="$(shasum -a 256 "$BUS_ROOT/.tap/team-registry.json")"
  rc=0
  ( cd "$BUS_ROOT" && env PATH="$WORK/bin:$PATH" TMUX="/tmp/fake,1,0" TMUX_PANE="$PANE_ID" \
      TAP_INDEX_HOME="$INDEX" TAP_HOME="$BUS" \
      "$REAL_BUN" "$ROOT/runtime/bun/main.ts" refresh solo ${extra[@]+"${extra[@]}"} >/dev/null 2>"$WORK/real-self.err" ) || rc=$?
  check "(8) real self refresh fresh=$fresh requires a brief" "$rc" "1"
  grep -qF '/tap:self rebrief' "$WORK/real-self.err" || FAILED=1
  [ "$(shasum -a 256 "$BUS_ROOT/.tap/team-registry.json")" = "$before_registry" ] || FAILED=1
  [ ! -d "$BUS/handoff" ] || FAILED=1
done

[ "$FAILED" = 0 ] || exit 1
echo "refresh-self-exit-translation: ok"
