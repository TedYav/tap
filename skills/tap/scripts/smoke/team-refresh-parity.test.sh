#!/usr/bin/env bash
# D5: source-read — team-refresh-parity.test.sh:1028-1033: grep-reads module source for invariants; no module behavior is exec'd or asserted
# team-refresh-parity.test.sh — `tap team refresh` bash/native parity comparator.
#
# WHAT THIS FILE IS, AND WHY IT LANDS BEFORE THE NATIVE VERB (tap-nyvty unit 2).
#
# The port's whole claim is that a native `tap team refresh` is indistinguishable
# from the bash one across the OBSERVABLE SURFACE: stdout, stderr, exit status,
# the registry's bytes, and the registry's file MODE. This file is the instrument
# that decides that claim, and it exists first because an instrument built after
# the thing it measures gets shaped — unconsciously — to agree with it.
#
# THE TRAP THIS FILE IS BUILT AROUND. Until unit 3 lands, `refresh` is still in
# main.ts's BASH_OWNED set, so the "native" candidate ROUTES TO BASH. A naive
# parity test would then compare bash against bash, pass every arm, and report a
# green parity suite for a port that does not exist. That is the success-shaped
# signal for work not done, and it is the single most likely way this lane ships
# a lie. Two mechanisms prevent it:
#
#   1. The candidate's routing is OBSERVED (TAP_BUN_ROUTE_TRACE), not assumed. If
#      the candidate resolves to bash, section (4) FAILS. It reported VACUOUS
#      while the router still owned the verb, and that spelling became wrong the
#      moment `refresh` left BASH_OWNED: put it back and the old branch greeted
#      the regression as success. A guard that says "nothing to measure" is
#      honest only while there is genuinely nothing to measure (review).
#   2. The comparator is proven against MUTANTS regardless — stubs that are the
#      bash reference with exactly one perturbation. Each must be CAUGHT. That is
#      what makes an arm's green mean something: not "the two agreed" but "this
#      arm can tell a wrong implementation from a right one."
#
# A mutant is "bash, except wrong in one place" on purpose. It proves the
# SCENARIO SET reaches the condition — a comparator with no fenced-bus scenario
# cannot catch a fenced-bus mutant however good its diffing is.
#
# Audit table this implements: tmp/lane-teamrefresh/unit1-audit.md (unit 1,
# approved by a reviewer at BASE fd0a3c9b). Arm numbers below cite its §11.
#
# WHAT THIS FILE DOES NOT COVER, stated so nobody reads its green as wider than
# it is. Two audit conditions have no scenario and no mutant here:
#
#   W7  — the ABA case: every candidate's fingerprint moved under the lock, so
#         nothing is removed and the registry is left untouched
# R9 — a report that fails AFTER the trim commits — was on this list for one
# round, with a measurement showing the obvious injection unreachable. It came
# off: section (3c) reaches the window through a payload the report cannot
# read — invalid UTF-8 in its frontmatter — which the in-process report hits
# after the trim commits. Both entries
# that have left this list left it because someone built the injection rather
# than because the reasoning was wrong, which is worth remembering the next time
# something is parked here.
#
# It is reachable only by injecting a race into a subprocess this fixture does
# not control, and a half-built arm would be worse than none: it would read as
# coverage. It is named here instead of implied.
#
# C14 — the classifier spawn itself failing — WAS on this list, on the same
# grounds. It came off because the injection turned out to be cheap: a `python3`
# on PATH that fails only for `tap_observe_seats.py` and execs the real
# interpreter for everything else. The scenarios it enables (`pollfail`, `pollfail_j`) caught a
# live divergence the moment it existed, which is the usual fate of a condition
# parked as unreachable — see the scenario for what it found.
#
# A THIRD GAP, AND IT IS STRUCTURAL RATHER THAN MERELY UNBUILT. This file's whole
# method is comparison against the incumbent, so it is blind by construction to
# any behaviour the incumbent CANNOT PRODUCE. One native-only refusal class is
# therefore outside the reach of COMPARISON at any scenario count:
#
#   registry_lock_busy  — bash blocks on the registry lock indefinitely; the
#                         native runtime refuses rather than write from an
#                         unserialized snapshot
#
# (Two other names once sat on this list, `roster_unrunnable` and
# `trim_unrunnable`; both followed their python children out of existence when
# the M3 port moved the reader and the trim in-process — a class with no child
# left has no injection target. See the retired (3d) for the disposition.)
#
# Parity-by-comparison defines away everything the incumbent structurally cannot
# do, which is exactly where a port's new surface lives. So the remaining one is
# asserted DIRECTLY in this file instead — `registry_lock_busy` in (3) — against
# a fixture the comparator built and proven against its own mutant. The method
# is what is blind, not the file; reading this list as an uncovered list is what
# left the last two resting on prose for several rounds (partner review).
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
INCUMBENT="$ROOT/bin/tap"
RUNTIME="$ROOT/runtime/bun"
BUN="${TAP_SMOKE_BUN:-$(command -v bun 2>/dev/null || true)}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tap-refresh-parity.XXXXXX")"
WORK="$(cd -P "$WORK" && pwd)"

fail() { echo "team-refresh-parity: $1" >&2; exit 1; }
cleanup() { case "$WORK" in /tmp/*|/private/tmp/*|/var/folders/*) rm -rf "$WORK" ;; esac; }
trap cleanup EXIT

[ -n "$BUN" ] && [ -x "$BUN" ] || fail "Bun executable unavailable"

FAKE_BIN="$WORK/bin"
STUBS="$WORK/stubs"
mkdir -p "$FAKE_BIN" "$STUBS"

# --- the tmux the fixtures observe -------------------------------------------
# Three modes, and the difference between the last two is load-bearing (audit
# H3 vs H4): a RECOGNIZED no-server answer is positive proof of an empty
# namespace and licenses a trim, while an OPAQUE failure is not deletion
# authority and must keep the row. A mock that returns the same empty output for
# both makes the two indistinguishable and would green a native implementation
# that deletes rows it has no evidence against.
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -uo pipefail
# STRIP THE SOCKET PIN FIRST. Both runtimes pin a server, but they spell the
# call differently: bash reaches tmux bare (the pin rides the environment),
# while the native runtime turns TAP_TMUX_SOCKET into an explicit `-L <name>`
# prefix (tmux.ts's socket seam). A mock that dispatches on "$1" without
# stripping it therefore answers bash correctly and answers native with
# NOTHING — a fixture more generous to the incumbent than to the candidate,
# which manufactures a divergence that does not exist in production. The same
# strip is in runtime/bun/test/team.test.ts's mock for the same reason.
while [ "${1:-}" = -L ] || [ "${1:-}" = -S ]; do shift 2; done
if [ -n "${FAKE_TMUX_NO_SERVER:-}" ]; then
  echo "no server running on /fake/socket" >&2
  exit 1
fi
if [ -n "${FAKE_TMUX_OPAQUE:-}" ]; then
  echo "permission denied opening the tmux socket" >&2
  exit 1
fi
case "${1:-}" in
  list-sessions)
    for name in demo/live demo/zombie; do
      if [[ "$*" == *start_time* ]]; then printf '%s\t900:100\n' "$name"
      else printf '%s\n' "$name"; fi
    done
    exit 0 ;;
  list-panes)
    shift; target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -t) target="${2#=}"; shift 2 ;;
        -F) fmt="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    case "$target" in
      *dead*) exit 0 ;;
      *) case "$fmt" in
           *pane_id*) printf 'demo/live\tdemo/live:0.0\t%%11\tcodex\t123\t1:1\t0\n' ;;
           *) printf '\n' ;;
         esac ;;
    esac
    exit 0 ;;
  display-message) printf '\n'; exit 0 ;;
esac
exit 0
TMUX
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH"

# --- fixtures ----------------------------------------------------------------
seed_rows() {
  cat > "$1/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "live": {"status": "active", "delivery": "pane", "session": "demo/live", "pane": "demo/live:0.0", "pane_id": "%11", "harness": "codex"},
    "dead": {"status": "active", "delivery": "pane", "session": "demo/dead", "pane": "demo/dead:0.0", "pane_id": "%12", "harness": "codex"},
    "pollbot": {"status": "active", "delivery": "poll", "harness": "daemon"}
  }
}
JSON
}
seed_hard() {
  cat > "$1/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "suspended-live": {"status": "suspended", "status_reason": "server_restarted", "delivery": "pane", "session": "demo/zombie", "harness": "codex"},
    "offline-dead": {"status": "offline", "status_reason": "harness_exited", "delivery": "pane", "session": "demo/offline-dead", "harness": "cursor"},
    "poll-parked": {"status": "suspended", "status_reason": "server_restarted", "delivery": "poll", "harness": "daemon"}
  }
}
JSON
}
# TAP_WATCH_NOW is pinned to 1787900000 by `capture`, so these timestamps place
# each row deterministically against the 60s reservation window:
#   1970-01-01 ... : long expired
#   now - 10s      : inside the grace window
# "live" means the reserved session is one the fake tmux lists.
seed_pending() {
  cat > "$1/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "pending-live": {"status": "pending", "delivery": "pane", "session": "demo/live", "pane": "demo/live:0.0", "registered_at": "1970-01-01T00:00:00Z", "harness": "codex"},
    "pending-expired": {"status": "pending", "delivery": "pane", "session": "demo/gone", "pane": "demo/gone:0.0", "registered_at": "1970-01-01T00:00:00Z", "harness": "codex"},
    "launching-expired": {"status": "active", "status_reason": "launching", "launch_id": "L1", "delivery": "pane", "session": "demo/gone2", "pane": "demo/gone2:0.0", "registered_at": "1970-01-01T00:00:00Z", "harness": "claude"}
  }
}
JSON
}
seed_grace() {
  # registered_at = TAP_WATCH_NOW - 10s, session absent -> inside the 60s grace.
  python3 - "$1/registry.json" <<'PY'
import datetime, json, sys
stamp = datetime.datetime.fromtimestamp(1787900000 - 10, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
doc = {"schema": "0.20", "team": {"name": "demo"}, "seats": {
    "pending-grace": {"status": "pending", "delivery": "pane", "session": "demo/gone",
                      "pane": "demo/gone:0.0", "registered_at": stamp, "harness": "codex"}}}
open(sys.argv[1], "w").write(json.dumps(doc, indent=2, sort_keys=True) + "\n")
PY
}
# A LARGE but entirely VALID registry. The reader's output -- not the file --
# is what a spawn buffer bounds, and at ~4000 seats it is ~2.8MB, comfortably
# past bun's 1MB default. Before the maxBuffer fix this produced ENOBUFS, a null
# status, and a `registry_invalid` refusal for a registry bash reads without
# complaint (measured end-to-end, the cleanup reviewer's refresh.ts:256).
#
# Sized past the old limit ON PURPOSE. A first attempt used 1200 seats, produced
# 680KB, stayed under the ceiling, and would have passed with or without the
# fix -- a scenario that cannot reach the defect is not coverage of it.
seed_bigreg() {
  python3 - "$1/registry.json" <<'BIGREG'
import json, sys
seats = {
    f"seat-{i:05d}": {
        "status": "active", "delivery": "poll", "harness": "daemon",
        "session": f"demo/seat-{i:05d}", "note": "x" * 400,
    }
    for i in range(4000)
}
json.dump({"schema": "0.20", "team": {"name": "demo"}, "seats": seats}, open(sys.argv[1], "w"))
BIGREG
}
# A registry whose HANDLE, SESSION and PANE all carry a non-ASCII code point.
# The incumbent renders --json through python's json.dumps, whose ensure_ascii
# default emits `caf\u00e9`; a native renderer calling JSON.stringify directly
# emits the raw UTF-8 bytes. Measured before the fix: bash produced zero bytes
# >= 0x80 and native produced them, for the same registry -- runtime selection
# changing the receipt's bytes, which is the one thing this verb may not do.
#
# Non-ASCII rides USER-CONTROLLED strings, so this is reachable by naming a
# session, not by any rare state. No other scenario carries a byte over 0x7F,
# which is exactly why 21 scenarios and 11 mutants were all silent on it.
seed_nonascii() {
  cat > "$1/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"demo"},"seats":{
  "café-live":{"status":"active","delivery":"pane","harness":"codex","session":"demo/live","pane":"demo/live:0.0","pane_id":"%11"},
  "café-dead":{"status":"active","delivery":"pane","harness":"claude","session":"demo/köln","pane":"demo/köln:0.0","pane_id":"%12"},
  "café-poll":{"status":"active","delivery":"poll","harness":"daemon","session":"demo/café","pane":"demo/café:0.0"}
}}
JSON
}
seed_unreadable() { printf 'not json at all\n' > "$1/registry.json"; }
seed_empty()      { printf '{"schema": "0.20", "team":{"name":"demo"},"seats":{}}\n' > "$1/registry.json"; }
seed_scalar()     { printf '{"schema": "0.20", "team":{"name":"demo"},"seats":{"scalar":"i-am-a-string"}}\n' > "$1/registry.json"; }
# A LIVE v0.20 flip marker enrolling this root, whose acting registry_location
# does not exist. The bus itself is seeded and non-empty, so a "nothing to
# refresh" receipt cannot be blamed on an empty bus -- the seat below is exactly
# what the operator would expect a refresh to have looked at.
seed_unreachable() {
  local idx="$WORK/index.unreach.$$"
  rm -rf "$idx"; mkdir -p "$idx"
  cat > "$idx/global-registry.json" <<JSON
{"schema":"0.20","teams":{"demo":{"root":"$WORK","registry_location":"$WORK/no-such-dir/team-registry.json","state":"registered"}}}
JSON
  cat > "$1/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"demo"},"seats":{"ghost":{"status":"active","delivery":"pane","harness":"claude","session":"demo/ghost","pane":"demo/ghost:0.0","pane_id":"%99"}}}
JSON
  SCEN_INDEX_HOME="$idx"; export SCEN_INDEX_HOME
}

# The same enrollment, except the acting registry EXISTS and is a DIRECTORY.
# `existsSync` is true for it and `[ -f ]` is not, so a guard written with the
# first spelling lets it through to the reader and reports `registry_invalid` /
# `repair_registry` where the incumbent refuses `registry_unreachable` /
# `tap doctor` — different class, different remedy, and under --json a parseable
# object from one runtime against an empty stdout from the other. A directory is
# exactly "a registry nobody managed to read", which is the conflation this port
# spent four commits removing one layer down.
seed_unreach_dir() {
  local idx="$WORK/index.unreachdir.$$"
  rm -rf "$idx"; mkdir -p "$idx" "$WORK/dirreg.$$"
  cat > "$idx/global-registry.json" <<JSON
{"schema":"0.20","teams":{"demo":{"root":"$WORK","registry_location":"$WORK/dirreg.$$","state":"registered"}}}
JSON
  cat > "$1/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"demo"},"seats":{"ghost":{"status":"active","delivery":"pane","harness":"claude","session":"demo/ghost","pane":"demo/ghost:0.0","pane_id":"%99"}}}
JSON
  SCEN_INDEX_HOME="$idx"; export SCEN_INDEX_HOME
}
# A shim that fails ONLY the batch classifier and execs the real binary for
# everything else. It used to shadow `python3` and match `tap_observe_seats.py`;
# the classifier is `observe.ts` now, so it shadows `bun` and matches that.
#
# WHAT THIS SHIM CAN AND CANNOT REACH AFTER THE CUTOVER, stated because a
# parity fixture that silently stops reaching one side is worse than none. No
# door spawns `bun observe.ts` anymore (the payload door's last caller edges
# went with the Bash door, and a later change deleted the bare-stdin tail), so the
# shim is an ABSENCE instrument: `assert_no_classifier_attempt` below licenses
# its claims from the shim's log, and the positive control fires the shim
# synthetically to prove an empty log means "never attempted", not "never
# recorded". `bin/tap` resolves `bun` through this same shim for `main.ts`,
# which does not match and execs the real binary, so the native runtime starts
# and runs normally.
#
# That is not a handicap this fixture chose; it is the seam the port removed,
# and it is why the scenario below asserts a DIFFERENT property than it used to.
CLS_BIN="$WORK/bin-clsfail"
mkdir -p "$CLS_BIN"
REAL_BUN="$(command -v bun)"
CLS_LOG="$WORK/clsfail.log"; export CLS_LOG
cat > "$CLS_BIN/bun" <<SHIM
#!/usr/bin/env bash
for a in "\$@"; do
  case "\$a" in */observe.ts)
    printf '%s\n' "\$*" >> "\$CLS_LOG"
    echo "CLASSIFIER-PARTIAL-STDOUT"
    echo "classifier: injected failure" >&2
    exit 9 ;;
  esac
done
exec "$REAL_BUN" "\$@"
SHIM
chmod +x "$CLS_BIN/bun"

# POSITIVE CONTROL FOR THE ZERO BELOW. `assert_no_classifier_attempt` licenses a
# claim from an empty log, and an empty log is exactly what a shim that cannot
# run also produces. So make it fire once, on purpose, and confirm both halves:
# the nonzero exit the scenario would see, and the log line the check reads.
: > "$CLS_LOG"
if "$CLS_BIN/bun" /somewhere/observe.ts --from-env >/dev/null 2>&1; then
  fail "classifier shim did not refuse an observe.ts invocation; every 'no classifier was attempted' claim below would be vacuous"
fi
[ -s "$CLS_LOG" ] || fail "classifier shim ran but wrote no log line; the instrument cannot distinguish 'never attempted' from 'never recorded'"
: > "$CLS_LOG"

# Reads the instrument above. The property is the one the C14 fix established:
# on a poll-only roster every row is bucketed before any observation is needed,
# so NEITHER door may attempt a classifier at all.
assert_no_classifier_attempt() { # <label>
  [ -s "$CLS_LOG" ] || return 0
  echo "team-refresh-parity: $1 attempted a classifier on a poll-only roster:" >&2
  sed 's/^/    /' "$CLS_LOG" >&2
  fail "$1: a roster where no row can reach an observation must not spawn the classifier"
}

# A POLL-ONLY roster, with the classifier rigged to fail. Every row is bucketed
# by the poll branch, so no row consults an observation at all -- and the
# incumbent's poll, pending and hard branches all precede
# `tap_seat_observed_record`, so bash never spawns the classifier here and a
# failure it never triggers cannot reach its receipt.
seed_pollfail() {
  cat > "$1/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"demo"},"seats":{
 "poll-a":{"status":"active","delivery":"poll","harness":"daemon","session":"demo/a"},
 "poll-b":{"status":"active","delivery":"poll","harness":"daemon","session":"demo/b"}}}
JSON
  SCEN_PATH="$CLS_BIN:$PATH"; export SCEN_PATH
}
seed_missing()    { rm -f "$1/registry.json"; }
seed_fence() {
  seed_rows "$1"
  cat > "$1/reset.fence.json" <<'FENCE'
{"token":"parity-fence","started":"2026-08-28T06:00:00Z","boot_id":"parity","owner_start":"1","op":"team-reset","pid":999999}
FENCE
}

# A fresh bus per capture: a scenario must never observe another's leftovers.
new_bus() {
  local home="$WORK/bus.$1"
  rm -rf "$home"
  mkdir -p "$home/payloads" "$home/receipts"
  printf '%s' "$home"
}

# --- the observable surface, captured whole -----------------------------------
# Six facts per run, plus an opt-in seventh. The registry's MODE is one of them
# because the port's reason for existing (tap-vltws) is that a native writer
# could land 0644 where bash lands 0600 — a difference no stdout comparison can
# see. The registry EVENT LOG is another: an observable the comparator does not
# read is an observable the port is not held to.
# Python exposes nanosecond timestamps and permission bits on both Linux and
# macOS. A failed read must abort even when capture is called inside a condition.
registry_stat() { # <stamp|mode> <path>
  python3 -B - "$1" "$2" <<'PY_STAT' || fail "registry stat failed: $2"
import os, stat, sys
value = os.stat(sys.argv[2])
fields = {"stamp": f"{value.st_mtime_ns}:{value.st_size}",
          "mode": format(stat.S_IMODE(value.st_mode), "o")}
print(fields[sys.argv[1]])
PY_STAT
}

capture() {
  local out="$1" home="$2"; shift 2
  local rc=0
  # Fingerprint the registry BEFORE the command, in this same run. Comparing a
  # raw mtime across two runs measures when each bus was SEEDED, not whether the
  # command wrote — which silently turned three text-only mutants into "caught"
  # on an unrelated field.
  # Nanosecond mtime distinguishes a dry-run that writes from one that is inert.
  # A second-granularity stamp can miss a write that
  # finishes well inside the same second as the seed — so the coarse stamp showed
  # "unchanged" for a registry that had just been rewritten, and the mutant that
  # makes --dry-run write survived. Fractional resolution is what makes the
  # inertness claim able to fail. (The size is kept: a rewrite that changes
  # length is caught even if a clock were somehow coarse.)
  local before="absent" after
  if [ -f "$home/registry.json" ]; then
    before="$(registry_stat stamp "$home/registry.json")" || fail "cannot fingerprint registry before capture"
  fi
  # EVERY per-invocation input is pinned, not just the clock. TAP_SERVER_EPOCH
  # and TAP_BOOT_ID are unused today only because the fake tmux's
  # display-message prints nothing; the moment that stub returns a real
  # `#{pid}:#{start_time}`, pid varies per invocation and every mutant is
  # "caught" on a field its mutation never touched — the run-variant class
  # again, pre-empted rather than rediscovered (grok, round 2).
  ( cd "$WORK" && env HOME="$WORK/fakehome" TAP_HOME="$home" \
      TAP_INDEX_HOME="${SCEN_INDEX_HOME:-$TAP_INDEX_HOME}" \
      PATH="${SCEN_PATH:-$PATH}" \
      TAP_TMUX_SOCKET="tap-parity-$$" TAP_WATCH_NOW=1787900000 \
      TAP_SERVER_EPOCH="srv:900:100" TAP_BOOT_ID="bootuuid:00000000-0000-4000-8000-000000000000" \
      TAP_TEAM="demo" \
      FAKE_TMUX_NO_SERVER="${FAKE_TMUX_NO_SERVER:-}" FAKE_TMUX_OPAQUE="${FAKE_TMUX_OPAQUE:-}" \
      "$@" ) >"$out.out.raw" 2>"$out.err.raw" || rc=$?
  printf '%s\n' "$rc" > "$out.rc"
  # NORMALIZE THE BUS PATH out of both streams. Each run gets its own bus dir
  # ("bus.ref.fence" vs "bus.mut.drywrite.fence"), and any message naming a path
  # inside it — the fence refusal names reset.fence.json — would otherwise differ
  # for EVERY mutant regardless of what it mutated. That is the same defect as a
  # raw timestamp: a field that always differs reports every mutant as caught
  # while the arm that should catch it does nothing. Third instance in this file
  # (ts=, mtime, now this), so: any captured value that varies per RUN rather
  # than per BEHAVIOR gets normalized before comparison.
  # BOTH SPELLINGS of the bus root. WORK is `cd -P`'d, so $home is the resolved
  # form (/private/tmp/... on macOS) — but a writer that prints the unresolved
  # /tmp symlink form would slip past a single-form replacement and revive the
  # fence-path instance, greening every mutant on `err` (grok, round 2).
  local home_alias="$home"
  case "$home" in
    /private/*) home_alias="${home#/private}" ;;
    /tmp/*)     home_alias="/private$home" ;;
  esac
  sed -e "s#${home//#/\\#}#<bus>#g" -e "s#${home_alias//#/\\#}#<bus>#g" \
    "$out.out.raw" > "$out.out"
  sed -e "s#${home//#/\\#}#<bus>#g" -e "s#${home_alias//#/\\#}#<bus>#g" \
    "$out.err.raw" > "$out.err"
  rm -f "$out.out.raw" "$out.err.raw"
  if [ -f "$home/registry.json" ]; then
    cat "$home/registry.json" > "$out.reg"
    registry_stat mode "$home/registry.json" > "$out.mode"
    # `unchanged` / `written` — a claim about THIS run, so it is comparable
    # across runs while a bare timestamp is not.
    after="$(registry_stat stamp "$home/registry.json")" || fail "cannot fingerprint registry after capture"
    if [ "$after" = "$before" ]; then
      printf 'unchanged\n' > "$out.inert"
    else
      printf 'written\n' > "$out.inert"
    fi
  else
    : > "$out.reg"; printf 'absent\n' > "$out.mode"; printf 'absent\n' > "$out.inert"
  fi
  # The registry event log is a SIXTH observable, not a special case. It was
  # asserted out-of-band at first, which meant section (4) — which compares only
  # these facts — could not see it: a native verb that skipped the append would
  # have matched on rc/out/err/reg/mode and greened. An observable the
  # comparator does not read is an observable the port is not held to.
  if [ -f "$home/registry-events.log" ]; then
    # NORMALIZE the wall-clock stamp. The line is `ts=<now> actor=... handle=...`,
    # so two runs a second apart differ on ts alone — which would make every
    # mutant "caught" for a reason unrelated to its mutation, and would fail
    # section (4) on nothing but timing skew. A comparator that always differs
    # proves as little as one that never does. Everything the W14 claim is
    # actually about (actor, action, handle, pane, team) stays byte-exact.
    sed 's/^ts=[^ ]*/ts=<normalized>/' "$home/registry-events.log" > "$out.events"
  else
    printf 'absent\n' > "$out.events"
  fi
}

# Compare every captured fact. `check_inert` is opt-in: it is meaningful only for
# the dry-run arm, where the claim is that NOTHING was written.
# `$5` = dump content on a difference. OFF in the mutant sweep, where a
# difference is the EXPECTED outcome: dumping the compared bytes there put the
# verb's own `{"trimmed":[],"skipped":[],"kept":[]}` and `skipped 'pollbot'`
# into the log of a fully-passing run, and smoke-all correctly failed the file
# for emitting skip-shaped output with no SMOKE-SKIP declaration. That detector
# is protecting a real property — a silently skipped test is a green that proves
# nothing — so the emission is what changes, not the rule.
#
# The field list survives either way, and it is the load-bearing half: "caught
# on `inert`" versus "caught on `mtime`" is what revealed that three mutants
# were being caught by a timing artifact rather than by their own mutation.
compare() {
  local ref="$1" cand="$2" label="$3" check_inert="${4:-0}" dump="${5:-1}"
  local facts="rc out err reg mode events"
  [ "$check_inert" = 1 ] && facts="$facts inert"
  local fact bad=""
  for fact in $facts; do
    cmp -s "$ref.$fact" "$cand.$fact" || bad="$bad $fact"
  done
  [ -z "$bad" ] && return 0
  printf '%s: differs on:%s\n' "$label" "$bad" >&2
  if [ "$dump" = 1 ]; then
    for fact in $bad; do
      printf '  --- %s (reference) ---\n' "$fact" >&2; sed -n '1,12p' "$ref.$fact" >&2
      printf '  --- %s (candidate) ---\n' "$fact" >&2; sed -n '1,12p' "$cand.$fact" >&2
    done
  fi
  return 1
}

# --- the scenario set ---------------------------------------------------------
# Each entry: name, seeder, tmux mode, argv. Together they must reach every
# condition the mutants below perturb — that is what the mutants prove.
run_scenarios() {  # <runner-fn> <prefix>
  local runner="$1" pfx="$2" home
  local -a names=()

  scenario() { # <name> <seeder> <tmuxmode> <args...>
    local name="$1" seeder="$2" tmode="$3"; shift 3
    home="$(new_bus "$pfx.$name")"
    # A seeder may point this run at its own v0.20 index by exporting
    # SCEN_INDEX_HOME; it is cleared first so one scenario's index never leaks
    # into the next, which would silently re-answer every scenario after it.
    unset SCEN_INDEX_HOME SCEN_PATH
    "$seeder" "$home"
    FAKE_TMUX_NO_SERVER=""; FAKE_TMUX_OPAQUE=""
    case "$tmode" in
      noserver) FAKE_TMUX_NO_SERVER=1 ;;
      opaque)   FAKE_TMUX_OPAQUE=1 ;;
    esac
    export FAKE_TMUX_NO_SERVER FAKE_TMUX_OPAQUE
    "$runner" "$WORK/$pfx.$name" "$home" "$@"
    names+=("$name")
  }

  # trim path: removes dead, keeps live, skips poll, appends the event  (arms 1,2,3,11)
  scenario trim        seed_rows       normal   team refresh
  scenario trim_json   seed_rows       normal   team refresh --json
  # dry-run must be INERT: registry bytes and file identity unchanged   (arm 5)
  scenario dryrun      seed_rows       normal   team refresh --dry-run
  # --hard, and the H3/H4 pair that a conflating implementation fails   (arm 7)
  scenario hard        seed_hard       normal   team refresh --hard
  scenario hard_nosrv  seed_hard       noserver team refresh --hard
  scenario hard_opaque seed_hard       opaque   team refresh --hard
  # refusals: the doubled prefix, and the JSON envelope's STREAM        (arms 6a,6b)
  scenario unreadable  seed_unreadable normal   team refresh
  scenario unread_json seed_unreadable normal   team refresh --json
  # the fence precedes arg parsing — error, stream and ORDER            (arms 6,6c)
  scenario fence       seed_fence      normal   team refresh
  scenario fence_json  seed_fence      normal   team refresh --json
  scenario fence_bogus seed_fence      normal   team refresh --bogus
  # argv refusals, and the leading-flag dispatcher binding              (arm 6d)
  scenario badopt      seed_rows       normal   team refresh --bogus
  scenario badarg      seed_rows       normal   team refresh stray
  scenario leadflag    seed_rows       normal   team --json refresh
  # pending reservations: expired (trims), still-live (keeps), in-grace (keeps
  # with the "expires in ~Ns" narration). These reach C6/C7/C8, which had NO
  # seeder at all in round 1 — the arms were named in the audit and unreachable
  # in the fixture, so section (4) could not have caught a wrong expiry clock.
  scenario pending     seed_pending    normal   team refresh
  scenario pending_j   seed_pending    normal   team refresh --json
  scenario grace       seed_grace      normal   team refresh
  # a large VALID registry: the reader's output crosses the default spawn buffer,
  # and a null status there must not be read as a corrupt registry
  scenario bigreg      seed_bigreg     normal   team refresh --json
  # non-ASCII in handle/session/pane: the --json receipt must be ASCII-escaped in
  # BOTH runtimes. Human mode too, which must NOT be escaped -- so the pair also
  # pins that the fix did not over-apply and start escaping prose.
  scenario nonascii    seed_nonascii   normal   team refresh
  scenario nonasc_json seed_nonascii   normal   team refresh --json
  # A LIMIT ON THE FOUR SCENARIOS BELOW, measured and stated because they agree
  # for DIFFERENT REASONS on the two sides.
  #
  # This fixture's buses are `$WORK/bus.<name>` — deliberately not a
  # `<root>/.tap/bus`, so each scenario is isolated. The native runtime derives
  # the team root from that path and matches the enrollment; **bash does not**,
  # and in this shape it answers `registry_unreachable` for EVERY enrolled
  # location, including a perfectly valid regular file:
  #
  #   registry_location   bash            native
  #   a valid file        unreachable(1)  skipped 'linked'(0)   <- they DISAGREE
  #   a symlink to one    unreachable(1)  skipped 'linked'(0)   <- they DISAGREE
  #   a directory         unreachable(1)  unreachable(1)
  #   absent              unreachable(1)  unreachable(1)
  #
  # So on the bash side these arms exercise root-derivation, not the guard. They
  # still pin the NATIVE behaviour against a fixed expectation, and mutant
  # `unreachok` still reds — but "both runtimes refuse" here is weaker than it
  # reads. Re-minting the buses as `$WORK/root.<name>/.tap/bus` makes all four
  # rows agree correctly (measured), and is the fix; it changes every scenario's
  # bus path, so it is not being folded into a fix round for an unrelated
  # finding.
  #
  # The guard itself IS verified against bash — by direct probe, in a realistic
  # bus shape, on all four inputs above, twice independently. What is weaker than
  # claimed is the regression pin, not the fix.
  #
  # An acting registry that is ENROLLED AND ABSENT. Distinct from `missing`,
  # where no flip marker claims one: here a live v0.20 marker names a
  # registry_location that does not exist, and reading nothing there is not the
  # same as there being nothing to read. Measured before the fix: bash refused
  # registry_unreachable / exit 1 while native rendered "nothing to refresh" /
  # exit 0 -- a success receipt for a reconciliation that never reached a
  # registry. Both forms, because the refusal is raised before flags are parsed
  # and so must stay human-form on stderr even under --json.
  scenario unreach     seed_unreachable normal  team refresh
  scenario unreach_j   seed_unreachable normal  team refresh --json
  # ...and the same registry PRESENT but not a file. Both forms, because the
  # divergence measured here was partly about the STREAM: native emitted a
  # parseable --json object where the incumbent emitted nothing on stdout.
  scenario unreachdir   seed_unreach_dir normal  team refresh
  scenario unreachdir_j seed_unreach_dir normal  team refresh --json
  # C14, formerly parked as unreachable: the classifier spawn itself failing, on
  # a roster where NO row can reach an observation. Taking the snapshot eagerly
  # meant a failure with no bearing on any row's verdict still reached the
  # receipt -- measured, before the fix:
  #
  #   bash    {"trimmed":[],"skipped":[...poll-mode...],"kept":[]}   exit 0
  #   native  CLASSIFIER-PARTIAL-STDOUT\n{...the same JSON...}       exit 0
  #
  # i.e. an unparseable --json receipt at exit 0. The discrimination here was
  # proven by running the PRE-FIX and POST-FIX production code, not by a mutant:
  # the before/after above is the arm's own falsification.
  #
  # WHAT IT ASSERTS NOW, and the exact limit of that — the reviewer
  # corrected an overstatement here and the correction is the important part.
  # The native door classifies in-process, so an eager snapshot can no longer
  # pollute a receipt with a child's stdout; that divergence is unreachable and
  # this scenario cannot re-find it.
  #
  # The shim sees ONE thing: an `observe.ts` CHILD. So the zero below means
  # "the BASH door attempted no classifier child on a poll-only roster". It is
  # NOT evidence that the native door skipped its in-process engine call —
  # nothing on PATH can observe an in-process call, and citing it that way would
  # claim coverage this instrument cannot produce. Native eager-gather on a
  # poll-only roster is UNPINNED here and no defect is implied; it is an
  # evidence gap, named rather than papered over.
  #
  # The positive control below proves the shim can count that child, which is
  # what makes the zero mean anything at all.
  scenario pollfail    seed_pollfail   normal   team refresh
  scenario pollfail_j  seed_pollfail   normal   team refresh --json
  # zero-row paths
  scenario missing     seed_missing    normal   team refresh
  scenario emptymap    seed_empty      normal   team refresh
  scenario scalarrow   seed_scalar     normal   team refresh
  unset -f scenario
  printf '%s\n' "${names[@]}"
}

INERT_SCENARIOS=" dryrun "   # the only arm whose claim is "nothing was written"

run_reference() { capture "$1" "$2" bash "$INCUMBENT" "${@:3}"; }
mkdir -p "$WORK/fakehome"

SCENARIOS="$(run_scenarios run_reference ref)"
echo "team-refresh-parity: (1) reference surface captured for $(echo "$SCENARIOS" | wc -l | tr -d ' ') scenarios: ok"

# =============================================================================
# (2) THE COMPARATOR IS PROVEN AGAINST MUTANTS.
#
# Each mutant runs the real bash verb and then perturbs exactly one observable.
# Every one MUST be caught. A mutant that survives does not mean the mutant is
# benign — it means no scenario reaches the condition it breaks, and the arm
# claiming to cover that condition is decorative.
# =============================================================================
mutant() { # <name> <perturbation-shell>
  local name="$1" body="$2"
  { printf '#!/usr/bin/env bash\nset -uo pipefail\nINCUMBENT=%q\nrc=0\n' "$INCUMBENT"
    printf 'out="$(bash "$INCUMBENT" "$@" 2>"$TAP_HOME/.mut.err")" || rc=$?\n'
    printf 'err="$(cat "$TAP_HOME/.mut.err")"; rm -f "$TAP_HOME/.mut.err"\n'
    printf '%s\n' "$body"
    printf 'printf "%%s" "$out"; [ -n "$out" ] && printf "\\n"\n'
    printf 'printf "%%s" "$err" >&2; [ -n "$err" ] && printf "\\n" >&2\n'
    printf 'exit "$rc"\n'
  } > "$STUBS/$name"
  chmod +x "$STUBS/$name"
}

# M1  mode: the brief's demanded arm — a writer that lands 0644 (tap-vltws).
mutant mode0644   '[ -f "$TAP_HOME/registry.json" ] && chmod 0644 "$TAP_HOME/registry.json"'
# M2  content: a dropped row (grok's demanded arm). Mode-only fixtures are blind to it.
mutant droprow    'python3 -c "
import json,sys,os
p=os.environ[\"TAP_HOME\"]+\"/registry.json\"
if os.path.exists(p):
    d=json.load(open(p)); m=d.get(\"seats\") or d.get(\"agents\") or {}
    m.pop(\"live\",None)
    open(p,\"w\").write(json.dumps(d,indent=2,sort_keys=True)+chr(10))"'
# M3  the trim never fires: classification reported, registry untouched (audit §7 arm 3).
mutant nopop      'python3 -c "
import json,sys,os
p=os.environ[\"TAP_HOME\"]+\"/registry.json\"
if os.path.exists(p):
    d=json.load(open(p)); m=d.get(\"seats\") or d.get(\"agents\")
    if isinstance(m,dict) and \"dead\" not in m:
        m[\"dead\"]={\"status\":\"active\",\"delivery\":\"pane\",\"session\":\"demo/dead\",\"pane\":\"demo/dead:0.0\",\"pane_id\":\"%12\",\"harness\":\"codex\"}
        open(p,\"w\").write(json.dumps(d,indent=2,sort_keys=True)+chr(10))"'
# M4  --dry-run writes. Caught only by the within-run inertness claim on that arm.
mutant drywrite   'case " $* " in *" --dry-run "*) [ -f "$TAP_HOME/registry.json" ] && touch "$TAP_HOME/registry.json" ;; esac'
# M5  the doubled refusal prefix emitted once — rc=1 greens this mistake.
mutant prefixonce 'err="${err/tap team refresh: tap team refresh: /tap team refresh: }"'
# M6  the JSON refusal envelope moved to stderr — human-mode fixtures green it.
mutant jsonstderr 'case " $* " in *" --json "*) if [ "$rc" != 0 ] && [ -n "$out" ]; then err="$out$err"; out=""; fi ;; esac'
# M7  --json honored on the fence refusal, which bash never does (want_json is
#     still 0 when the fence fires, because E3 precedes arg parsing).
mutant fencejson  'case " $* " in *" --json "*) case "$err" in *mid-reset*) out="{\"ok\":false,\"error_class\":\"team_reset_fenced\"}"; err="" ;; esac ;; esac'
# M8  argv parsed before the fence: a fenced bus + bogus flag reports the FLAG.
mutant argvfirst  'case " $* " in *" --bogus "*) case "$err" in *mid-reset*) err="tap team refresh: unknown option '"'"'--bogus'"'"'; next: tap help team refresh" ;; esac ;; esac'
# M9  a flags-anywhere argv scan invents `tap team --json refresh`, a form bash refuses.
mutant leadflag   'case "$*" in "team --json refresh") rc=0; err=""; out="{\"trimmed\":[],\"skipped\":[],\"kept\":[]}" ;; esac'
# M10 H3/H4 conflated: an opaque tmux failure treated as empty-namespace proof,
#     so parked rows are deleted on no evidence.
mutant hardconflate 'if [ -n "${FAKE_TMUX_OPAQUE:-}" ]; then python3 -c "
import json,os
p=os.environ[\"TAP_HOME\"]+\"/registry.json\"
if os.path.exists(p):
    d=json.load(open(p)); m=d.get(\"seats\") or d.get(\"agents\") or {}
    for h in (\"offline-dead\",\"suspended-live\",\"poll-parked\"): m.pop(h,None)
    open(p,\"w\").write(json.dumps(d,indent=2,sort_keys=True)+chr(10))"; fi'
# M11 the registry event is never appended (audit W14).
mutant noevent    'rm -f "$TAP_HOME/registry-events.log"'
# M12 non-ASCII: undo the incumbent's ensure_ascii escaping, which is byte-for-byte
#     what the native renderer produced before it was wrapped. Only the --json
#     scenarios carry \u sequences at all, so this mutant is precisely aimed at
#     nonasc_json; human mode holds raw UTF-8 in both runtimes and is untouched.
mutant rawutf8    'out="${out//\\u00e9/é}"; out="${out//\\u00f6/ö}"'
# M13 unreachable acting registry: replace the refusal with the SUCCESS RECEIPT
#     the native verb rendered before the second half of the guard existed --
#     exit 0 and an empty result, in whichever mode the run is using. If this
#     mutant survives, the unreach scenarios are decorative and a refresh that
#     never reached a registry can once again report that it reconciled one.
mutant unreachok  'case "$err" in *"acting registry unreachable"*)
    rc=0; err=""
    case " $* " in
      *" --json "*) out="{\"trimmed\":[],\"skipped\":[],\"kept\":[]}" ;;
      *)            out="tap team refresh: nothing to refresh" ;;
    esac ;;
  esac'

# DERIVED FROM WHAT WAS DEFINED, never re-typed. This was a hand-maintained list,
# and the first two mutants added after it was written were defined, chmod +x'd,
# and never run -- `mutant` is the only writer into $STUBS, so a name missing from
# the list is not a survivor and not a failure: it is silence. The suite stayed
# green and its wall time did not move, which is what a check that runs nothing
# looks like from the outside.
#
# Deriving the list makes the omission impossible rather than merely unlikely: a
# defined mutant is in $STUBS, and everything in $STUBS runs.
MUTANTS="$(cd "$STUBS" && printf '%s ' *)"
[ -n "${MUTANTS// /}" ] || fail "no mutant stubs were defined — the comparator would be proven against nothing, and section (2) would print a green receipt for zero work"

survivors=""
for m in $MUTANTS; do
  run_mutant() { capture "$1" "$2" bash "$STUBS/$m" "${@:3}"; }
  run_scenarios run_mutant "mut.$m" >/dev/null
  caught=0
  for s in $SCENARIOS; do
    mt=0; case "$INERT_SCENARIOS" in *" $s "*) mt=1 ;; esac
    compare "$WORK/ref.$s" "$WORK/mut.$m.$s" "mutant/$m scenario/$s" "$mt" 0 >/dev/null || { caught=1; break; }
  done
  [ "$caught" = 1 ] || survivors="$survivors $m"
  unset -f run_mutant
done

if [ -n "$survivors" ]; then
  fail "comparator is decorative for:$survivors — each is a real defect no scenario reaches,
  so the arm that claims to cover it cannot fail. Add the scenario; do not delete the mutant."
fi
echo "team-refresh-parity: (2) comparator proven RED against $(echo $MUTANTS | wc -w | tr -d ' ') mutants (mode, content, no-trim, dry-run write, prefix, JSON stream, fence JSON, argv order, leading flag, hard conflation, event log, non-ASCII escaping, unreachable-registry success receipt) — the set is DERIVED from the defined stubs, so a mutant cannot be defined and left unrun: ok"

# =============================================================================
# (3) THE LOCK, AS A TWO-WRITER PROBE — not an assertion that a lock object exists.
#
# `acquireRegistryLock` returning non-null proves a file was opened, not that
# anything was EXCLUDED. The claim worth making is that the trim serializes
# against a concurrent writer, and the only honest way to make it is a probe
# that can come back negative.
#
# THE FIRST VERSION OF THIS SECTION COULD NOT FAIL, and the control below is
# what said so. It wrote a "racer" row and THEN ran the trim — sequential, no
# concurrency, so the row survived whether or not any lock existed. The negative
# control (same probe, racer not holding the lock) also came back "survived",
# which is precisely the signature of an instrument measuring nothing.
#
# Interleaving a write into the trim's read-modify-write window would be a real
# race and therefore a flaky test. So the question is asked directly instead:
# DOES THE TRIM WAIT FOR THE LOCK? A holder takes the flock and keeps it. If the
# trim acquires the lock it blocks — bash flocks with no timeout — and runs into
# a wall-clock bound. If it never takes the lock it finishes immediately. Both
# outcomes are deterministic, and the no-holder control proves the bound is the
# lock rather than general slowness.
# =============================================================================
HOLDER_PID=""
release_holder() {
  [ -n "$HOLDER_PID" ] || return 0
  # Stop the pid we recorded, never a pattern (no-pattern-kills).
  kill "$HOLDER_PID" 2>/dev/null || true
  wait "$HOLDER_PID" 2>/dev/null || true
  HOLDER_PID=""
}
trap 'release_holder; cleanup' EXIT

cat > "$WORK/holder.py" <<'PY'
import fcntl, os, signal, sys, time
# Hold an exclusive flock on the registry sidecar and announce that we have it,
# so the caller never starts timing before the lock is actually held.
lock = open(sys.argv[1] + ".lock", "w")
fcntl.flock(lock, fcntl.LOCK_EX)
with open(sys.argv[2], "w") as fh:
    fh.write("held\n")
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
time.sleep(120)
PY

# The deadline is python's, not timeout(1)'s. `timeout` is GNU coreutils and is
# NOT on a stock macOS PATH — this file is glob-discovered by smoke-all, so on a
# clean PATH every invocation would exit 127 without ever running the trim, the
# control would still print "completed", and the arm would decide nothing while
# looking like it passed. A missing tool must not be able to green a probe.
cat > "$WORK/deadline.py" <<'PY'
import os, signal, subprocess, sys
# argv: <deadline> <out-file> <err-file> <cmd...>
# The child's streams are KEPT, not discarded. Discarding them is what let this
# probe accept any non-writing outcome as a lock refusal: with no stderr there
# was nothing to distinguish "refused with registry_lock_busy" from "hung until
# the deadline killed it", and both leave the registry unwritten.
deadline = float(sys.argv[1])
out_path, err_path = sys.argv[2], sys.argv[3]
with open(out_path, "w") as ofh, open(err_path, "w") as efh:
    proc = subprocess.Popen(sys.argv[4:], stdout=ofh, stderr=efh,
                            start_new_session=True)
    try:
        rc = proc.wait(timeout=deadline)
    except subprocess.TimeoutExpired:
        # Stop the process group we created — recorded pid, never a pattern.
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
        print("blocked")
        raise SystemExit(0)
print("refused" if rc != 0 else "completed")
PY

# Returns: blocked | completed
trim_under_holder() { # <hold: 1|0>
  local hold="$1" home ready
  home="$(new_bus "lock.$hold")"
  seed_rows "$home"
  ready="$home/.held"
  if [ "$hold" = 1 ]; then
    python3 "$WORK/holder.py" "$home/registry.json" "$ready" &
    HOLDER_PID=$!
    local waited=0
    while [ ! -f "$ready" ]; do
      sleep 0.1; waited=$((waited + 1))
      [ "$waited" -lt 100 ] || fail "(3) the lock holder never acquired the flock"
    done
  fi
  local verdict before after
  before="$(registry_stat stamp "$home/registry.json")" || fail "cannot fingerprint registry before trim"
  verdict="$( cd "$WORK" && env HOME="$WORK/fakehome" TAP_HOME="$home" \
      TAP_TMUX_SOCKET="tap-parity-$$" TAP_WATCH_NOW=1787900000 \
      TAP_SERVER_EPOCH="srv:900:100" TAP_BOOT_ID="bootuuid:00000000-0000-4000-8000-000000000000" \
      TAP_TEAM="demo" \
      python3 "$WORK/deadline.py" 10 "$home/.subj.out" "$home/.subj.err" \
        "${LOCK_RUNNER[@]}" team refresh --json )"
  after="$(registry_stat stamp "$home/registry.json")" || fail "cannot fingerprint registry after trim"
  release_holder
  # THE OBSERVABLE IS THE REGISTRY, NOT THE CLOCK. Two implementations satisfy
  # the same invariant differently: bash blocks on the flock indefinitely, while
  # the native runtime's helper times out and refuses `registry_lock_busy`
  # (audit W4). Scoring only "hit the deadline / did not" marked that correct
  # refusal identical to writing straight through an unheld lock — a probe
  # written against the incumbent's behaviour and then pointed at a candidate
  # whose contract deliberately differs.
  if [ "$before" = "$after" ]; then
    printf 'not-written:%s\n' "$verdict"
  else
    printf 'written:%s\n' "$verdict"
  fi
}

# THE PROBE FOLLOWS THE CANDIDATE. Audit W3/W4 are claims about the PORT, so
# running the incumbent here would leave a native verb that never calls
# acquireRegistryLock greening this arm forever after unit 4 flips. Branch on
# the same observed routing section (4) uses: bash only while refresh is still
# Bash-owned, bun the moment it is not.
LOCK_TRACE="$WORK/lock-route.trace"
: > "$LOCK_TRACE"
( cd "$WORK" && env HOME="$WORK/fakehome" TAP_HOME="$(new_bus lockroute)" \
    TAP_BUN_ROUTE_TRACE="$LOCK_TRACE" TAP_TMUX_SOCKET="tap-parity-$$" \
    "$BUN" "$RUNTIME/main.ts" team refresh --dry-run ) >/dev/null 2>&1 || true
if grep -q '^native refresh$\|^native team$' "$LOCK_TRACE" 2>/dev/null; then
  LOCK_RUNNER=("$BUN" "$RUNTIME/main.ts")
  LOCK_SUBJECT="native"
else
  LOCK_RUNNER=(bash "$INCUMBENT")
  LOCK_SUBJECT="bash (refresh still Bash-owned)"
fi

# CONTROL FIRST, and it is a positive control: with the lock free the trim must
# actually WRITE. Without it, a subject that never trims anything (a broken
# runner, an empty candidate set, a verb that exits early) would satisfy the
# held-arm's "did not write" for reasons having nothing to do with the lock, and
# the whole section would pass while measuring nothing.
control="$(trim_under_holder 0)"
case "$control" in
  written:*) ;;
  *) fail "(3) control failed: with the registry lock FREE the trim did not write ($control). A 'did not write' result under a holder would then prove nothing. Subject: $LOCK_SUBJECT" ;;
esac

held="$(trim_under_holder 1)"
# DERIVED IN THE PARENT, not exported from the function: `trim_under_holder` runs
# inside a command substitution, so a variable it assigns dies with the subshell
# and reading it here is an unbound-variable failure under `set -u`. The bus name
# is deterministic (`new_bus "lock.<hold>"`), so the path is recomputable.
held_err="$WORK/bus.lock.1/.subj.err"
held_out="$WORK/bus.lock.1/.subj.out"
# THE FIXTURE MUST NOT BE ABLE TO BLAME THE SUBJECT. The two paths above are
# recomputed by convention from `new_bus "lock.<hold>"`. If that naming ever
# changes, the files are simply absent, `grep -q` fails on nothing, and the arm
# reds with "did not name registry_lock_busy" — a correct-LOOKING failure whose
# cause is the fixture and whose message points at the port
# (cleanup review). Checking existence first makes that
# misattribution impossible; an unbound variable at least announced itself, and
# this replacement must not be quieter than what it replaced.
for f in "$held_out" "$held_err"; do
  [ -f "$f" ] || fail "(3) the fixture could not find the subject's captured stream at '$f' — \`new_bus\`'s naming and this recomputed path have diverged. This is a FIXTURE fault; nothing here says anything about the lock."
done
case "$held" in
  written:*) fail "(3) the trim WROTE THE REGISTRY while another writer held its lock ($held) — a concurrent registration can be clobbered. This is the arm the audit's W3/W4 rows depend on. Subject: $LOCK_SUBJECT" ;;
esac

# NOT-WRITING IS NOT ENOUGH, and accepting it was a false green in this arm.
#
# `not-written:*` admits `blocked` — a subject that HUNG until the 10s deadline
# killed its process group. That leaves the registry unwritten for a reason that
# has nothing to do with honouring a lock, and it is indistinguishable from the
# real behaviour unless the arm says which outcome it expects
# (partner review). The two subjects have DIFFERENT correct outcomes here
# and the arm now demands the one belonging to the subject it is actually
# running:
#
#   bash    blocks on the flock indefinitely      -> not-written:blocked
#   native  refuses `registry_lock_busy` (W4)     -> not-written:refused, and the
#           refusal must NAME the class, so that a crash, a usage error, or any
#           other nonzero exit cannot stand in for a lock refusal
case "$LOCK_SUBJECT" in
  native*)
    [ "$held" = "not-written:refused" ] || fail "(3) native did not REFUSE under a held lock — got '$held'. \`blocked\` means it hung until the deadline killed it, which leaves the registry unwritten for a reason unrelated to the lock; \`completed\` means it exited 0 without writing. The native contract is a registry_lock_busy refusal. stderr:
$(cat "$held_err" 2>/dev/null)"
      # THE CLASS, NOT THE PROSE. `registry_lock_busy` is the error_class, and it
    # appears literally only in the --json envelope on STDOUT; the human line
    # says "is busy; refusing to trim from an incoherent snapshot". Asserting the
    # human sentence would pin wording that is free to change, so the arm runs
    # --json and reads the machine field — which is also the thing CONTRACT.md
    # actually specifies. (Measured: the first working version of this check
    # grepped stderr in human mode and failed against a correct refusal.)
    grep -q '"error_class":"registry_lock_busy"' "$held_out" 2>/dev/null || fail "(3) native refused under a held lock but its --json envelope did not carry error_class=registry_lock_busy — any nonzero exit would satisfy 'refused' alone. stdout:
$(cat "$held_out" 2>/dev/null)
stderr:
$(cat "$held_err" 2>/dev/null)" ;;
  *)
    [ "$held" = "not-written:blocked" ] || fail "(3) bash did not BLOCK under a held lock — got '$held'. The incumbent's contract is to wait on the flock indefinitely; a refusal here would be the native behaviour appearing in the wrong subject." ;;
esac

echo "team-refresh-parity: (3) registry lock proven by a two-writer probe against $LOCK_SUBJECT: the trim writes when the lock is free (${control%%:*}), and under a holder it produces the outcome THIS subject's contract requires (${held#not-written:}) rather than merely failing to write — a hung-and-killed run no longer satisfies the held arm: ok"

# =============================================================================
# (3d) RETIRED: THE UNRUNNABLE CLASSES FOLLOWED THEIR CHILDREN.
#
# This section once asserted, directly (comparison cannot reach a behaviour the
# incumbent CANNOT PRODUCE), that a registry reader or writer child which could
# not run refused under its OWN class — `roster_unrunnable` /
# `trim_unrunnable`, action `retry the refresh` — instead of conflating into
# `registry_invalid` / `repair_registry` and sending an operator to repair a
# file nobody managed to read. That conflation shipped once (ENOBUFS on a valid
# registry past the old 1MB buffer produced a registry_invalid refusal with the
# roster never read; another cleanup reviewer), which is why the classes existed.
#
# The M3 port then removed both children: the compare-and-trim moved in-process
# under the registry lock, and the roster reader followed, so neither class has
# an injection target left — there is no child that can fail to run. The arms
# followed their classes (writer first, then reader), as this file did at C14
# when the observed child left. What the arms guarded is pinned elsewhere: the
# trim's contract by the native tests in runtime/bun/test/team.test.ts and by
# this file's trim scenarios, which still byte-compare every rewrite the verb
# makes; the lock refusal by (3). The reader's registry_invalid wording is now
# native, and its diagnostic prose is the one seam U2 consciously widened —
# normalized at the (4) comparison below.
# =============================================================================

# =============================================================================
# (3b) THE STRAND WARNING STILL FIRES, AND THE SCRATCH MECHANISM IS GONE.
#
# This section used to pin two properties of the retired reporter's scratch
# staging: that pre-placed symlinks at its predictable paths were not FOLLOWED,
# and that no predictable path could be CONSTRUCTED. The M3 port moved the
# report in-process, so the staging is gone entirely — no scratch directory, no
# fixed-name children, nothing for a symlink to sit in front of. The behavioral
# claim that survives is the LIVE one: a trimmed handle with unsettled inbound
# mail still produces the strand WARNING on stderr, on both doors, so a silent
# deletion of the report cannot pass. The structural claim inverts with the
# mechanism: (3b-static) now asserts the retired staging's tokens appear
# NOWHERE in refresh.ts — absence, not construction — which reds on a literal
# revert of the port.
#
# The old constructibility grep existed because the scratch pattern came back
# once already in this file's own history: applyTrim was fixed and
# reportStranded, 120 lines away, kept the pattern until two reviewers found it
# independently. applyTrim's staging retired with the trim port; the report's
# retires here; the pin follows the mechanism out.
# =============================================================================
# STRUCTURAL PIN: the retired reporter's scratch mechanism is ABSENT.
#
# reportStranded once staged its input as `mkdtempSync(join(tmpdir(),
# 'tap-refresh-strand.'))` with fixed-name children inside. None of those
# tokens has a reason to exist in refresh.ts anymore, and each is exactly what
# a literal revert reintroduces.
refresh_src="$ROOT/runtime/bun/src/verbs/refresh.ts"
[ -f "$refresh_src" ] || fail "(3b-static) cannot find refresh.ts at $refresh_src"
for scratch_token in mkdtempSync 'tap-refresh-strand' 'tmpdir()'; do
  if grep -q "$scratch_token" "$refresh_src"; then
    grep -n "$scratch_token" "$refresh_src" >&2
    fail "(3b-static) refresh.ts still names '$scratch_token' — the retired stranded-mail reporter staged its work in a mkdtemp scratch directory under tmpdir(), and the in-process report must construct none of it. A future change that legitimately needs a scratch directory must re-aim this pin with the same honesty."
  fi
done
echo "team-refresh-parity: (3b-static) the retired reporter's scratch mechanism (mkdtempSync / tmpdir() / tap-refresh-strand) appears nowhere in refresh.ts — absence, not construction: ok"

# Each door gets its own freshly seeded bus: a refresh that trims 'dead'
# rewrites the registry, so a second run against the same bus would find
# nothing to trim and nothing to strand — the control would measure the
# first run's aftermath, not the reporter.
strand_seed() {
  local home="$1"
  seed_rows "$home"
  # A trimmed handle needs unsettled inbound for the strand report to have anything
  # to say: 'dead' is the row the fixture's tmux reports as gone.
  mkdir -p "$home/payloads" "$home/receipts"
  cat > "$home/payloads/strandprobe-1.md" <<'PAY'
---
id: strandprobe-1
from: someone
to: dead
kind: discuss
reply: expected
---
body
PAY
}
strand_home="$(new_bus strandlive)"
strand_seed "$strand_home"
strand_native_home="$(new_bus strandlive-native)"
strand_seed "$strand_native_home"

FAKE_TMUX_NO_SERVER="" FAKE_TMUX_OPAQUE=""
export FAKE_TMUX_NO_SERVER FAKE_TMUX_OPAQUE
capture "$WORK/strandlive" "$strand_home" bash "$INCUMBENT" team refresh
# Both doors must warn: the sentence is parity surface (ruling 33/34, LIVE).
# The reference door is EXPLICITLY the bash incumbent — LOCK_RUNNER is Bun at a
# native-routed head, and a "both doors" pair that runs native twice proves
# nothing. (Section (4) does not carry it — no scenario in the set seeds
# payloads.)
capture "$WORK/strandlive-native" "$strand_native_home" "$BUN" "$RUNTIME/main.ts" team refresh

grep -q "strands 1 unsettled payload" "$WORK/strandlive.err" \
  || fail "(3b) the bash door's strand report did not fire, so the live control measures nothing. stderr was:
$(cat "$WORK/strandlive.err")"
grep -q "strands 1 unsettled payload" "$WORK/strandlive-native.err" \
  || fail "(3b) the native door's strand report did not fire — the in-process report is the only reporter left, so this is a live regression. stderr was:
$(cat "$WORK/strandlive-native.err")"
# And the sentences must be BYTE-IDENTICAL, not merely present: extract each
# door's warning line and compare them, with a diff on failure showing what moved.
grep -F "WARNING: trimming 'dead' strands 1 unsettled payload" "$WORK/strandlive.err" > "$WORK/strandlive.line" \
  || fail "(3b) the bash door's warning line could not be extracted. stderr was:
$(cat "$WORK/strandlive.err")"
grep -F "WARNING: trimming 'dead' strands 1 unsettled payload" "$WORK/strandlive-native.err" > "$WORK/strandlive-native.line" \
  || fail "(3b) the native door's warning line could not be extracted. stderr was:
$(cat "$WORK/strandlive-native.err")"
if ! cmp -s "$WORK/strandlive.line" "$WORK/strandlive-native.line"; then
  diff "$WORK/strandlive.line" "$WORK/strandlive-native.line" >&2 || true
  fail "(3b) the two doors' strand warnings are not byte-identical — see the diff above"
fi
echo "team-refresh-parity: (3b) the strand warning still fires for a trimmed handle with unsettled mail, byte-identical across the explicit bash incumbent and the native door (live control); (3b-static) pins the retired staging's absence: ok"

# =============================================================================
# (3c) A REPORT FAILURE AFTER A COMMITTED TRIM MUST NOT OVERTURN THE COMMAND.
#
# `reportStranded` runs AFTER `applyTrim` has rewritten the registry, so
# everything it does is best-effort by construction: what a failure costs the
# operator is the LIST of what the trim stranded, never the trim. Its staging
# and its cleanup each sat outside a catch at different points, so a failure in
# either escaped as an unhandled throw with the registry already rewritten — a
# completed operation reported as a crash.
#
# REACHING THAT WINDOW TOOK TWO TRIES, and the failed one is why this comment is
# long. The obvious injection — pointing TMPDIR at a nonexistent path — breaks
# `applyTrim`'s OWN mkdtemp first, before anything commits: exit 1, registry
# untouched, both rows intact. Measured. The second injection was a selective
# python3 shim that chmod 000'ed the report's scratch directory after the child
# ran — the partner reviewer's fixture, the only externally reachable moment of
# the staging-and-cleanup design. That child retired with the M3 port.
#
# The window is still reachable, one level up: the in-process report READS its
# inputs, and a payload whose bytes are invalid UTF-8 makes the strict
# frontmatter decoder throw exactly where the old python child crashed (its
# open().read() was strict too). The trim has already committed by then; the
# command must still exit 0, still have trimmed, and still WARN — announcing
# the degraded report, never leaking a stack trace.
if [ "$LOCK_SUBJECT" = native ]; then
  rf_home="$(new_bus rfpoison)"
  seed_rows "$rf_home"
  mkdir -p "$rf_home/payloads" "$rf_home/receipts"
  # printf '\377' writes the lone byte 0xFF — invalid in UTF-8 — so the strict
  # frontmatter decode throws mid-report, after the trim committed.
  { printf -- '---\n'
    printf '\377\n'
    printf 'id: rfpoison-1\nfrom: someone\nto: dead\nkind: discuss\nreply: expected\n---\nbody\n'
  } > "$rf_home/payloads/rfpoison-1.md"

  rf_out="$WORK/rfpoison.out"; rf_err="$WORK/rfpoison.err"
  FAKE_TMUX_NO_SERVER="" FAKE_TMUX_OPAQUE=""
  export FAKE_TMUX_NO_SERVER FAKE_TMUX_OPAQUE
  # `|| rf_rc=$?`, NOT a bare command followed by `$?`. This file runs under
  # `set -e`, and a bare subshell is not exempt from it — on the exact RED this
  # arm exists to prove, bun exits nonzero and the SHELL EXITS THERE: the
  # assertions and their diagnostics never run (partner review).
  rf_rc=0
  ( cd "$WORK" && env HOME="$WORK/fakehome" TAP_HOME="$rf_home" \
      TAP_TMUX_SOCKET="tap-parity-$$" TAP_WATCH_NOW=1787900000 \
      TAP_SERVER_EPOCH="srv:900:100" TAP_BOOT_ID="bootuuid:00000000-0000-4000-8000-000000000000" \
      TAP_TEAM="demo" \
      "$BUN" "$RUNTIME/main.ts" team refresh ) >"$rf_out" 2>"$rf_err" || rf_rc=$?

  [ "$rf_rc" = 0 ] || fail "(3c) a report failure after a COMMITTED trim exited $rf_rc — a best-effort report turned a completed operation into a failure. stderr:
$(head -c 900 "$rf_err")"
  grep -q "removed 'dead'" "$rf_out" \
    || fail "(3c) the trim receipt is missing, so the run never reached the post-commit window this arm is about. stdout:
$(head -c 600 "$rf_out")"
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); r=d.get("agents") or d.get("seats") or {}; sys.exit(0 if "dead" not in r else 1)' "$rf_home/registry.json" \
    || fail "(3c) the trimmed row is still in the registry — the trim did not commit, so exit 0 says nothing about the report's boundary"
  grep -q "the stranded-mail report did not complete — trimmed rows may have unsettled payloads this run did not name (exit 1)" "$rf_err" \
    || fail "(3c) the report failure was SILENT or its reason text drifted: the degraded warning must carry the reporter's stable '(exit 1)' shape in both runtimes. stderr:
$(head -c 900 "$rf_err")"
  grep -qE "^ *at .*refresh\.ts:[0-9]+" "$rf_err" \
    && fail "(3c) a raw stack trace reached stderr — the failure escaped its boundary rather than being reported. stderr:
$(head -c 900 "$rf_err")"
  echo "team-refresh-parity: (3c) a report that cannot read its input (invalid-UTF-8 frontmatter) after a COMMITTED trim keeps the trim, exits 0, and WARNS with no stack trace — the window the retired scratch-sabotage shim used to reach, reached through the report's own strict decoder: ok"
else
  echo "team-refresh-parity: (3c) SKIPPED — the candidate routes to bash; this arm is about the port's error boundary"
fi

# =============================================================================
# (4) IS THE CANDIDATE ACTUALLY NATIVE? Observed, and now REQUIRED.
#
# `refresh` has left BASH_OWNED, so the candidate must route natively. If it does
# not, the parity arms would compare bash against bash — a green suite for a port
# that is not routed — so this branch FAILS rather than reporting VACUOUS.
#
# The vacuous branch was correct while the router still owned the verb and is
# wrong now: put `refresh` back in BASH_OWNED and the old spelling greeted that
# regression as success (review). A guard that reports "nothing to measure"
# is only honest while there is genuinely nothing to measure.
# =============================================================================
TRACE="$WORK/route.trace"
: > "$TRACE"
( cd "$WORK" && env HOME="$WORK/fakehome" TAP_HOME="$(new_bus route)" \
    TAP_BUN_ROUTE_TRACE="$TRACE" TAP_TMUX_SOCKET="tap-parity-$$" \
    "$BUN" "$RUNTIME/main.ts" team refresh --dry-run ) >/dev/null 2>&1 || true

if grep -q '^native refresh$\|^native team$' "$TRACE" 2>/dev/null; then
  run_candidate() { capture "$1" "$2" "$BUN" "$RUNTIME/main.ts" "${@:3}"; }
  run_scenarios run_candidate cand >/dev/null
  # THE ONE NORMALIZED SEAM. The roster read moved in-process, and the
  # registry_invalid detail carries the parser's diagnostic prose — python's
  # exception text on the bash side, a native sentence on the native side. That
  # prose is the narrow change the port consciously made, so the comparison
  # collapses ONLY the parenthesized diagnostic, IDENTICALLY on both sides, and
  # only for the two scenarios whose refusals carry it. The human refusal's
  # `; next: <action>` suffix and the JSON envelope's close — carrying its ok,
  # error_class and action fields, with detail LAST — stay byte-compared, so an
  # action or class regression still diverges; the falsifier below proves it.
  for s in unreadable unread_json; do
    for f in out err; do
      for side in ref cand; do
        sed -e 's/registry unreadable (.*; next: /registry unreadable (<diagnostic>); next: /' \
            -e 's/registry unreadable (.*"}/registry unreadable (<diagnostic>)"}/' \
          "$WORK/$side.$s.$f" > "$WORK/$side.$s.$f.norm" \
          && mv "$WORK/$side.$s.$f.norm" "$WORK/$side.$s.$f"
      done
    done
  done
  # Post-normalization falsifier: poison ONE stream of an otherwise identical
  # capture pair with a DIFFERENT action and require the comparator to REJECT
  # it. If normalization ever again swallowed the suffix, the first check fails
  # instead — there would be no action bytes left to protect.
  fz_stream="$WORK/ref.unreadable.err"
  grep -q 'registry unreadable (<diagnostic>); next: repair registry' "$fz_stream" \
    || fz_stream="$WORK/ref.unreadable.out"
  grep -q 'registry unreadable (<diagnostic>); next: repair registry' "$fz_stream" \
    || fail "(4) normalization consumed the human refusal's '; next:' action suffix — the seam is wider than the diagnostic prose"
  fz_ext="${fz_stream##*.}"
  for ext in rc out err reg mode events; do
    cp "$WORK/ref.unreadable.$ext" "$WORK/fz_ref.$ext"
    cp "$WORK/ref.unreadable.$ext" "$WORK/fz_cand.$ext"
  done
  sed -e 's/; next: repair registry/; next: a different action/' \
    "$WORK/fz_ref.$fz_ext" > "$WORK/fz_cand.$fz_ext"
  grep -q '; next: a different action' "$WORK/fz_cand.$fz_ext" \
    || fail "(4) the falsifier never poisoned the action — it measured nothing"
  fz_rejected=0
  compare "$WORK/fz_ref" "$WORK/fz_cand" "parity falsifier/refusal action" 0 0 \
    >/dev/null 2>&1 || fz_rejected=1
  [ "$fz_rejected" = 1 ] \
    || fail "(4) the comparator ACCEPTED a changed refusal action after normalization — the seam masks action regressions"
  echo "team-refresh-parity: (4) falsifier: a normalized refusal whose ACTION changed is rejected by the compared bytes: ok"
  for s in $SCENARIOS; do
    mt=0; case "$INERT_SCENARIOS" in *" $s "*) mt=1 ;; esac
    compare "$WORK/ref.$s" "$WORK/cand.$s" "parity scenario/$s" "$mt" \
      || fail "(4) native refresh diverges from bash on scenario '$s'"
  done
  echo "team-refresh-parity: (4) native candidate matches bash on every scenario (stdout, stderr, exit, registry bytes, registry mode, registry event log; only the refusal-diagnostic PROSE on the two unreadable refusals normalized — action suffix and envelope fields byte-exact, proven by the falsifier): ok"
  # Only the pollfail scenarios put the shim on PATH, so an entry here can have
  # come from nowhere else. Checked after BOTH runners have run.
  assert_no_classifier_attempt "(4) bash and native on pollfail"
  echo "team-refresh-parity: (4) neither door attempted a classifier on the poll-only roster: ok"
else
  fail "(4) the candidate routed to BASH, not native — \`refresh\` is back in main.ts's BASH_OWNED set (or the router trace did not record it). Every parity arm would then compare bash against bash and pass while measuring nothing."
fi
