#!/usr/bin/env bash
# team-roster-named.test.sh — tap-fg4un / Ruling 11:
# `tap team roster [<team>]` renders a named enrolled team's roster view.
# Unreachable team refuses with live_unreachable (Ruling 11), never offline.
set -euo pipefail
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/bin/tap"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "team-roster-named: $*" >&2; exit 1; }

export TAP_INDEX_HOME="$WORK/index"
mkdir -p "$TAP_INDEX_HOME" \
         "$WORK/local/.tap/bus/payloads" \
         "$WORK/foreign/.tap" \
         "$WORK/decoy/.tap"

cat >"$TAP_INDEX_HOME/global-registry.json" <<JSON
{"migrated":"t","schema":"0.20","teams":{
 "local":{"enrolled_at":"t","registry_location":"$WORK/local/.tap/team-registry.json","root":"$WORK/local","state":"registered"},
 "foreign":{"enrolled_at":"t","registry_location":"$WORK/foreign/.tap/team-registry.json","root":"$WORK/foreign","state":"registered"},
 "decoy":{"enrolled_at":"t","registry_location":"$WORK/decoy/.tap/team-registry.json","root":"$WORK/decoy","state":"registered"},
 "ghost":{"enrolled_at":"t","registry_location":"$WORK/missing-root/.tap/team-registry.json","root":"$WORK/missing-root","state":"registered"}
}}
JSON

cat >"$WORK/local/.tap/team-registry.json" <<'JSON'
{"schema":"0.20","team":{"name":"local","worktree_root":"/tmp"},
 "seats":{"local-lead":{"status":"active","delivery":"poll","harness":"claude","pane":"","pane_id":""}}}
JSON

cat >"$WORK/foreign/.tap/team-registry.json" <<'JSON'
{"schema":"0.20","team":{"name":"foreign","worktree_root":"/tmp"},
 "seats":{"foreign-lead":{"status":"active","delivery":"poll","harness":"codex","pane":"","pane_id":""}}}
JSON

cat >"$WORK/decoy/.tap/team-registry.json" <<'JSON'
{"schema":"0.20","team":{"name":"DECOY_NAME","worktree_root":"/tmp"},
 "seats":{"decoy-lead":{"status":"active","delivery":"poll","harness":"codex","pane":"","pane_id":""}}}
JSON

cd "$WORK/local"

# 1. Bare `tap team` and `tap team roster` match and render local team
# Consume the once-per-install project advisory before comparing roster aliases.
# --no-cache: the roster cache key includes the socket spelling, which changes once
# tmux creates its directory, so one alias could print "cached observation" and the other not.
"$TAP" team >/dev/null 2>&1 || fail "initial roster read failed"
bare="$("$TAP" team --no-cache 2>&1)" || fail "bare 'tap team' failed: $bare"
roster="$("$TAP" team roster --no-cache 2>&1)" || fail "'tap team roster' failed: $roster"
[ "$bare" = "$roster" ] || fail "'tap team roster' must byte-match bare 'tap team'"
grep -q "local-lead" <<<"$bare" || fail "'local-lead' missing from bare output"
! grep -q "foreign-lead" <<<"$bare" || fail "'foreign-lead' leaked into local roster"

# 2. Named team renders foreign team with dot and stays read-only
named="$("$TAP" team roster foreign 2>&1)" || fail "'tap team roster foreign' failed: $named"
grep -q "foreign-lead" <<<"$named" || fail "'foreign-lead' missing from named roster output"
! grep -q "local-lead" <<<"$named" || fail "'local-lead' leaked into foreign roster output"
grep -q "tap team: foreign" <<<"$named" || fail "header must name foreign team"
grep -q "●" <<<"$named" || fail "'●' dot missing from named roster output"
[ ! -d "$WORK/foreign/.tap/bus" ] || fail "foreign bus directory was created on named roster read"

# 3. Named team with --json
json_out="$("$TAP" team roster foreign --json)" || fail "'tap team roster foreign --json' failed"
grep -q '"team":"foreign"' <<<"$json_out" || fail "json must carry foreign team"
grep -q '"handle":"foreign-lead"' <<<"$json_out" || fail "json must carry foreign seat"

# 4. Decoy team acting file does not override authoritative enrolled key
decoy_out="$("$TAP" team roster decoy 2>&1)" || fail "'tap team roster decoy' failed"
grep -q "tap team: decoy" <<<"$decoy_out" || fail "decoy header must use enrolled name"
! grep -q "DECOY_NAME" <<<"$decoy_out" || fail "decoy internal name must not leak into human header"
decoy_json="$("$TAP" team roster decoy --json)" || fail "'tap team roster decoy --json' failed"
grep -q '"team":"decoy"' <<<"$decoy_json" || fail "decoy json must use enrolled name"
! grep -q "DECOY_NAME" <<<"$decoy_json" || fail "decoy internal name must not leak into json team"

# 5. Unknown team refuses with non-zero exit, stdout empty, stderr has error
unknown_code=0
unknown_out="$("$TAP" team roster unknown-team 2>"$WORK/unknown.err")" || unknown_code=$?
[ "$unknown_code" -ne 0 ] || fail "unknown team unexpectedly succeeded"
[ -z "$unknown_out" ] || fail "unknown team stdout must be empty; got: $unknown_out"
grep -q "is not enrolled in the machine index" "$WORK/unknown.err" || fail "unknown team stderr missing index enrollment message"

# 6. Unreachable team refuses with live_unreachable (Ruling 11), stdout empty, names team and recorded root
ghost_code=0
ghost_out="$("$TAP" team roster ghost 2>"$WORK/ghost.err")" || ghost_code=$?
[ "$ghost_code" -ne 0 ] || fail "unreachable team unexpectedly succeeded"
[ -z "$ghost_out" ] || fail "unreachable team stdout must be empty; got: $ghost_out"
grep -q "acting registry for team 'ghost' (root '$WORK/missing-root') is unreachable" "$WORK/ghost.err" || fail "unreachable team stderr missing team and recorded root"
grep -q "next: tap doctor" "$WORK/ghost.err" || fail "unreachable team stderr missing next: tap doctor"

# 7. Unreachable team --json emits selector error object on stdout, stderr empty
ghost_json_code=0
ghost_json_out="$("$TAP" team roster ghost --json 2>"$WORK/ghost-json.err")" || ghost_json_code=$?
[ "$ghost_json_code" -ne 0 ] || fail "unreachable team --json unexpectedly succeeded"
[ -z "$(cat "$WORK/ghost-json.err")" ] || fail "unreachable team --json stderr must be empty"
grep -q '"error_class":"live_unreachable"' <<<"$ghost_json_out" || fail "json error missing live_unreachable"
grep -q '"action":"tap doctor"' <<<"$ghost_json_out" || fail "json error missing tap doctor"

echo "team-roster-named: ok"
