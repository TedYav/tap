#!/usr/bin/env bash
# help-forks-zero.test.sh — tap-v8o8: `tap help` resolves no repo or team state.
#
# WHY A FORK COUNT AND NOT A WALL-CLOCK CEILING. The win this test guards is
# ~950ms -> ~30ms on a registered seat's bus, and the obvious guard is a ms
# ceiling. A ceiling measured inside the parallel suite is a different number
# than the one anyone benchmarked (this box sat at load ~10 while the work was
# done), so the guard would red on a busy machine, and this repo DELETES a
# flaking test rather than re-parking it — the regression guard would erase
# itself. Fork count is what actually regresses when someone adds a state read
# to the dispatch preamble, and it is identical on an idle box and a hammered
# one.
#
# INSTRUMENT LIMITS, stated so a later reader does not over-trust a green. The
# shim intercepts `git` resolved through PATH; a call by absolute
# path is invisible to it. Every such call site in the TAP scripts is bare
# today, which is what makes the counts complete; a future absolute-path call
# would need the shim taught about it. And these captures are never ttys, so an
# advisory gated on `[ -t 1 ]` would not appear in them — production is not
# tty-gated, and a pty fixture would cost more than that hypothetical is worth
# (review). Both limits are the same shape: the counter sees one
# route, and a claim of "zero" is only as wide as the route it watched.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "help-forks-zero: $*" >&2; exit 1; }

# --- the environment where the preamble has real work to do -------------------
# An empty sandbox is the WRONG fixture here: with no bus and no flip marker the
# preamble bails early on its own, so a broken help path would still look cheap.
# Give it a live v0.20 marker, an enrolled team, and an inbound payload old
# enough to trip the overdue advisory — every condition that made a real seat's
# `tap help` cost 20 forks.
export TAP_INDEX_HOME="$WORK/index"
export TAP_HOME="$WORK/team/.tap/bus"
mkdir -p "$TAP_INDEX_HOME" "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$WORK/team/.tap"
cat > "$TAP_INDEX_HOME/global-registry.json" <<EOF
{"schema": "0.20", "teams": {"team": {"root": "$WORK/team", "registry_location": "$WORK/team/.tap/team-registry.json"}}}
EOF
cat > "$WORK/team/.tap/team-registry.json" <<'EOF'
{"schema": "0.20", "team": {"name": "team"}, "seats": {"seat": {"handle": "seat", "harness": "claude", "delivery": "poll", "status": "active"}}}
EOF
OVERDUE="$TAP_HOME/payloads/seat-19700101T000000Z-aaaaaaaaaaaa.md"
cat > "$OVERDUE" <<EOF
---
id: seat-19700101T000000Z-aaaaaaaaaaaa
from: other
to: seat
kind: discuss
path: $OVERDUE
reply: settle-only
---
an inbound payload old enough to be overdue
EOF
# TAP_SELF names the seat the advisory speaks to. Without it the caller resolves
# to nobody in a pane-less sandbox and the advisory returns before doing any
# work — which would make this fixture describe a condition it does not create.
export TAP_SELF=seat

# --- the python3 counter is retired (follow-up) --------------------------
# scripts/tap.sh now enters through bin/tap, so help is served by the native
# router before onboarding and no verb reaches the Bash preamble through this
# door. Native python starts do not resolve python3 through PATH, so the PATH
# shim can no longer be calibrated by any control verb; a zero from it would
# prove nothing. The git counter below still calibrates on this door and
# carries the zero-cost guard for every help spelling.

# Team up's resume moved onto the native Bun entry, so an ordinary team up
# no longer starts python3 and a fork count cannot tell it from help. The witness
# is the route itself: ordinary `team up --dry-run` reaches session resume (in this
# unenrolled fixture, its refusal), and no help spelling ever prints that.
ordinary_up="$(bash "$TAP" team up --dry-run 2>&1 || true)"
case "$ordinary_up" in
  *"tap session resume"*) ;;
  *) fail "'tap team up --dry-run' never reached session resume; the nested help route swallowed ordinary team up: $ordinary_up" ;;
esac
for spelling in help --help -h; do
  case "$(bash "$TAP" team up "$spelling" 2>&1 || true)" in
    *"tap session resume"*) fail "'tap team up $spelling' reached session resume; the witness no longer separates help from ordinary team up" ;;
  esac
done
# --- and it still prints the help ---------------------------------------------
# A help path that produced nothing would also make zero forks. Pin the output
# so the cheap answer is still the right answer.
out="$(bash "$TAP" help 2>/dev/null)"
case "$out" in
  *"TAP Agent Protocol"*) ;;
  *) fail "'tap help' printed no overview" ;;
esac
for spelling in "-h" "--help"; do
  out="$(bash "$TAP" "$spelling" 2>/dev/null)"
  case "$out" in
    *"TAP Agent Protocol"*) ;;
    *) fail "'tap $spelling' printed no overview" ;;
  esac
done
for args in "help send" "send help"; do
  # shellcheck disable=SC2086
  out="$(bash "$TAP" $args 2>/dev/null)"
  case "$out" in
    *"tap send"*) ;;
    *) fail "'tap $args' printed no verb help" ;;
  esac
done
for args in "help ask" "ask help"; do
  # shellcheck disable=SC2086
  out="$(bash "$TAP" $args 2>/dev/null)"
  case "$out" in
    *"tap ask"*) ;;
    *) fail "'tap $args' started its renderer but printed no ask help" ;;
  esac
done

# `team up` owns selectors that `session resume` deliberately does not. Pin both
# sides: the alias's help must describe its own grammar even when the selected
# team cannot be enrolled, while the underlying verb keeps its argparse page.
for spelling in help --help -h; do
  rc=0
  out="$(TAP_TEAM_SELECT=definitely-not-enrolled bash "$TAP" team up "$spelling" 2>/dev/null)" || rc=$?
  [ "$rc" = 0 ] || fail "'tap team up $spelling' exited $rc instead of printing help"
  for required in \
    "tap team up" "--dry-run" "--json" "--only <h,...>" "--except <h,...>" \
    "comma-separated bare team-local handles" "cannot be combined"; do
    case "$out" in
      *"$required"*) ;;
      *) fail "'tap team up $spelling' omitted '$required'" ;;
    esac
  done
  case "$out" in
    *"tap session resume <handle|session|harness>"*)
      fail "'tap team up $spelling' fell through to session resume help" ;;
  esac
done
resume_help="$(bash "$TAP" session resume --help 2>/dev/null)"
case "$resume_help" in
  *"tap session resume <handle|session|harness>"*) ;;
  *) fail "'tap session resume --help' lost its argparse page" ;;
esac
for selector in --only --except; do
  case "$resume_help" in
    *"$selector"*) fail "'tap session resume --help' unexpectedly grew $selector" ;;
  esac
done
# Every spelling now pins BOTH that it lived (exit status) and that it said
# something (output). Exit-status-only would still pass for a path that returned
# 0 and printed nothing, which is the other way a cheap answer can be wrong.
echo "help-forks-zero: every spelling still prints its text: ok"

# --- the advisory, which a fork count alone cannot see ------------------------
# CONTRACT §Recipient pending-age warning exempts help from the advisory, and a
# shell-only advisory — one that printed the warning without starting an
# interpreter — would violate that while every count above stayed 0. So assert
# the stderr directly.
#
# POSITIVE CONTROL FIRST, for the same reason the fork counter has one: "help's
# stderr is empty" is satisfied trivially by a fixture where NOTHING would ever
# warn. This fixture's first draft was exactly that — its payload was missing
# `path:`, so the envelope was invalid, the advisory skipped it, and the arm
# proved nothing. A state-touching verb must be seen warning here before any
# silence below means anything.
ADVISORY_SIGNATURE="unsettled inbound"
control_err="$(bash "$TAP" outstanding seat 2>&1 1>/dev/null || true)"
case "$control_err" in
  *"$ADVISORY_SIGNATURE"*) ;;
  *) fail "control failed: a state-touching verb printed no overdue advisory in this fixture (stderr: ${control_err:-<empty>}) — the help-stderr assertions below would pass for a fixture that can never warn" ;;
esac
echo "help-forks-zero: the fixture DOES produce an overdue advisory on a working verb: ok"

for args in "help" "-h" "--help" "help send" "send help" "help ask" "ask help" \
  "team up help" "team up --help" "team up -h"; do
  # shellcheck disable=SC2086
  err="$(bash "$TAP" $args 2>&1 1>/dev/null || true)"
  [ -z "$err" ] \
    || fail "'tap $args' wrote to stderr: $err — help is exempt from the advisory (CONTRACT §Recipient pending-age warning), and a shell-only warning would be invisible to the fork count"
  # STDOUT TOO, on the same signature. Checking only stderr left one door open:
  # an advisory printed to STDOUT starts no interpreter, leaves stderr empty, and
  # slips past the content checks above because those are substring matches that
  # extra text cannot break. Every arm would report green while help carried the
  # forbidden warning (review, mechanically reproduced at 37859ce2). The
  # signature is the positive control's own wording, so this arm and the control
  # cannot drift apart.
  # shellcheck disable=SC2086
  outp="$(bash "$TAP" $args 2>/dev/null || true)"
  case "$outp" in
    *"$ADVISORY_SIGNATURE"*)
      fail "'tap $args' printed the overdue advisory on STDOUT — help is exempt from it wherever it is written, and stdout is the stream a stderr-only check cannot see" ;;
  esac
done
echo "help-forks-zero: no help spelling emits the advisory, on either stream: ok"

# --- source-time work, which a python counter cannot see ----------------------
# Sourcing lib.sh starts no interpreter, so every arm above stayed green while
# help still parsed 8587 lines, probed TAP_HOME, and — with TAP_HOME unset —
# ran `git rev-parse --show-toplevel` to find the repo root (review). A
# state read through a different tool is still a state read, and CONTRACT
# §Recipient pending-age warning says help performs none.
#
# THE FIXTURE ABOVE CANNOT CATCH THIS, which is the point of doing it here with
# its own environment: this file EXPORTS TAP_HOME, and lib.sh skips the git call
# whenever TAP_HOME is already set. An arm inheriting that export would pass on
# code that runs git and on code that does not, proving nothing. So this one
# unsets TAP_HOME and runs from inside the repo, where the git probe is exactly
# what the old code did.
GITSHIM="$WORK/gitshim"
mkdir -p "$GITSHIM"
REAL_GIT="$(command -v git)"
[ -n "$REAL_GIT" ] || fail "no git on PATH to shim"
export TAP_GIT_REAL="$REAL_GIT"
cat > "$GITSHIM/git" <<'SH'
#!/usr/bin/env bash
if [ -n "${TAP_GIT_LOG:-}" ]; then printf '%s\n' "$*" >> "$TAP_GIT_LOG"; fi
exec "$TAP_GIT_REAL" "$@"
SH
chmod +x "$GITSHIM/git"

# The exit status is asserted, not discarded: a help path that exited
# non-zero would also run git zero times. The `control` label is
# exempt because whoami legitimately refuses in this sandbox.
git_execs_for() {
  local label="$1" rc=0
  local log="$WORK/git.$$.$1"; shift
  : > "$log"
  (
    cd "$ROOT" || exit 1
    TAP_GIT_LOG="$log" PATH="$GITSHIM:$PATH" \
      env -u TAP_HOME bash "$ROOT/scripts/tap.sh" "$@" >/dev/null 2>&1
  ) || rc=$?
  if [ "$label" != control ] && [ "$rc" -ne 0 ]; then
    fail "'tap $*' exited $rc under the git counter; a help path that refused makes its zero git count meaningless"
  fi
  wc -l < "$log" | tr -d ' '
}

# Control again: a verb that resolves the bus MUST be seen running git here, or
# a zero below means the shim is not on the path rather than that help is cheap.
git_control="$(git_execs_for control whoami)"
[ "$git_control" -ge 1 ] \
  || fail "control failed: the git shim counted $git_control execs for 'tap whoami' with TAP_HOME unset — it is not intercepting, so the zeros below prove nothing"
for spelling in "help" "-h" "--help"; do
  n="$(git_execs_for "git${spelling}" "$spelling")"
  [ "$n" = 0 ] \
    || fail "'tap $spelling' ran git $n time(s) resolving the repo root; help must be routed before lib.sh is sourced so it resolves no bus at all (tap-v8o8)"
done
for args in "help send" "send help" "help ask" "ask help"; do
  # shellcheck disable=SC2086
  n="$(git_execs_for "git${args// /}" $args)"
  [ "$n" = 0 ] || fail "'tap $args' ran git $n time(s); expected 0"
done
for spelling in help --help -h; do
  n="$(git_execs_for "gitteamup${spelling}" team up "$spelling")"
  [ "$n" = 0 ] \
    || fail "'tap team up $spelling' ran git $n time(s); nested help must resolve no repo or team state"
done
echo "help-forks-zero: help resolves no repo root ($git_control git execs for the control, 0 for help): ok"

echo "help-forks-zero: all checks passed"
