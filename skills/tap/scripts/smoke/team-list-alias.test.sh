#!/usr/bin/env bash
# team-list-alias.test.sh — tap-2e9s: `tap team
# list` enumerates teams — an alias for `tap teams`, with a pointer line back
# to the roster view — and `tap team roster` is the self-describing spelling
# of bare `tap team`. Before this fix `tap team list` was identical to bare
# `tap team` (own roster), which is why an agent asserting "tap/fable-mentor
# does not exist" trusted it and reported the wrong thing (bead sighting).
set -euo pipefail
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "team-list-alias: $*" >&2; exit 1; }

# --- fixture: TWO enrolled teams, each with one active poll-delivery seat --
# Two teams (not one) is the point: a fixture with only "demo" could not tell
# "list of teams" apart from "this team's roster" — both would print one row.
export TAP_INDEX_HOME="$WORK/index"
mkdir -p "$TAP_INDEX_HOME" \
         "$WORK/demo/.tap/bus/payloads" "$WORK/demo/.tap/bus/receipts" \
         "$WORK/second/.tap/bus/payloads" "$WORK/second/.tap/bus/receipts" \
         "$WORK/elsewhere"

cat >"$TAP_INDEX_HOME/global-registry.json" <<JSON
{"migrated":"t","schema":"0.20","teams":{
 "demo":{"enrolled_at":"t","registry_location":"$WORK/demo/.tap/team-registry.json","root":"$WORK/demo","state":"registered"},
 "second":{"enrolled_at":"t","registry_location":"$WORK/second/.tap/team-registry.json","root":"$WORK/second","state":"registered"},
 "ghost":{"enrolled_at":"t","registry_location":"$WORK/ghost/.tap/team-registry.json","root":"$WORK/ghost","state":"registered"}
}}
JSON

cat >"$WORK/demo/.tap/team-registry.json" <<'JSON'
{"schema":"0.20","team":{"name":"demo","created_at":"t","created_by":"t","repo_root":"/tmp"},
 "seats":{"alpha":{"status":"active","delivery":"poll","harness":"claude","registered_at":"t","pane":"","pane_id":""}}}
JSON

cat >"$WORK/second/.tap/team-registry.json" <<'JSON'
{"schema":"0.20","team":{"name":"second","created_at":"t","created_by":"t","repo_root":"/tmp"},
 "seats":{"beta":{"status":"active","delivery":"poll","harness":"claude","registered_at":"t","pane":"","pane_id":""}}}
JSON

export TAP_HOME="$WORK/demo/.tap/bus"
cd "$WORK/demo"

# --- roster meaning: `tap team roster` == bare `tap team`, byte-identical --
# Consume the once-per-install project advisory before comparing roster aliases.
"$TAP" team >/dev/null 2>&1 || fail "initial roster read failed"
bare="$("$TAP" team 2>&1)" || fail "bare 'tap team' failed: $bare"
roster="$("$TAP" team roster 2>&1)" || fail "'tap team roster' failed: $roster"
[ "$bare" = "$roster" ] || fail "'tap team roster' must byte-match bare 'tap team'; bare=<<<$bare>>> roster=<<<$roster>>>"
grep -q "alpha" <<<"$bare" || fail "roster fixture sanity: seat 'alpha' missing from bare 'tap team':\n$bare"
echo "team-list-alias: 'tap team roster' == bare 'tap team': ok"

# --- list meaning: `tap team list` enumerates BOTH teams, not just this one,
# and is exactly `tap teams`' output plus the ruled pointer line — the
# RESOLVED literal value, not merely "a pointer exists somewhere" -----------
list_out="$("$TAP" team list 2>&1)" || fail "'tap team list' failed: $list_out"
teams_out="$("$TAP" teams 2>&1)" || fail "'tap teams' failed: $teams_out"
expected="$teams_out"$'\n'"to see seats on this team: tap team (or tap team roster)"
[ "$list_out" = "$expected" ] || fail "'tap team list' must equal 'tap teams' output plus the ruled pointer line, verbatim; got:\n<<<$list_out>>>\nexpected:\n<<<$expected>>>"
grep -q "^demo " <<<"$list_out" || fail "'tap team list' does not enumerate this team ('demo'); got:\n$list_out"
grep -q "^second " <<<"$list_out" || fail "'tap team list' does not enumerate the OTHER team ('second') — it is a roster, not a list of teams: $list_out"
grep -q "^ghost " <<<"$list_out" || fail "authority-warning team 'ghost' must remain visible: $list_out"
grep -q '0/0' <<<"$teams_out" || fail "authority-warning team must render a zero-seat row instead of crashing: $teams_out"
grep -Eq '^TEAM +SEATS +STATUS$' <<<"$teams_out" || fail "default 'tap teams' must lead with the three-column summary: $teams_out"
! grep -q 'ATTACHED\|WARN\|WORKDIR' <<<"$teams_out" || fail "default 'tap teams' leaked diagnostic columns: $teams_out"
details_out="$($TAP teams --details 2>&1)" || fail "'tap teams --details' failed: $details_out"
grep -Eq '^TEAM +SEATS +ATTACHED +WARN +WORKDIR$' <<<"$details_out" || fail "'--details' must restore diagnostic columns: $details_out"
all_out="$($TAP teams --all 2>&1)" || fail "'tap teams --all' failed: $all_out"
grep -Eq '^TEAM +SEATS +STATUS$' <<<"$all_out" || fail "'--all' must keep the default three-column shape: $all_out"

# Status-dot controls live with the native owner in routing.test.ts.
echo "team-list-alias: 'tap team list' enumerates the machine (both teams) plus the ruled pointer line, verbatim: ok"

# --- machine-wide discovery must not require THIS cwd to have an acting
# registry (review): `tap team list` shares `tap teams`'
# contract of working from ANY cwd via the enrollment index, not "this
# team"'s roster's contract. Proven from a directory enrolled nowhere, where
# a normal `tap team` call is confirmed to refuse first — otherwise this arm
# would not be testing what it claims. This is also the ONLY exercise of the
# named-delegate form (dropped the redundant in-team-cwd copy): the
# delegation branch execs before any cwd-dependent rebind either way, so an
# unenrolled cwd is strictly the harder case and subsumes the easier one —
# fewer top-level `tap` invocations for the same coverage (review, wall-
# time economics in review). --------------------------------------
cd "$WORK/elsewhere"
elsewhere_bare_rc=0
env -u TAP_HOME "$TAP" team >/dev/null 2>&1 || elsewhere_bare_rc=$?
[ "$elsewhere_bare_rc" != 0 ] || fail "fixture sanity: bare 'tap team' unexpectedly succeeded from an unenrolled cwd; this arm would not be testing what it claims"

elsewhere_list="$(env -u TAP_HOME "$TAP" team list 2>&1)" || fail "'tap team list' must work from ANY cwd (same contract as 'tap teams') — it failed from an unenrolled directory instead: $elsewhere_list"
grep -q "^demo " <<<"$elsewhere_list" || fail "'tap team list' from an unenrolled cwd did not enumerate 'demo': $elsewhere_list"
grep -q "^second " <<<"$elsewhere_list" || fail "'tap team list' from an unenrolled cwd did not enumerate 'second': $elsewhere_list"

elsewhere_named="$(env -u TAP_HOME "$TAP" team list second 2>&1)" || fail "'tap team list second' must work from ANY cwd too: $elsewhere_named"
grep -q "beta" <<<"$elsewhere_named" || fail "'tap team list second' from an unenrolled cwd did not delegate to second's roster: $elsewhere_named"
grep -qF "to see seats on this team" <<<"$elsewhere_named" \
  && fail "'tap team list second' is already a roster view; it must not also carry the machine-wide pointer: $elsewhere_named"
cd "$WORK/demo"
echo "team-list-alias: 'tap team list' (bare and named) works from a cwd with no acting registry, and the named form carries no pointer line: ok"

echo "team-list-alias: ok"
