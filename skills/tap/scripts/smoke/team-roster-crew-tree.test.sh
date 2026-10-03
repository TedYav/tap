#!/usr/bin/env bash
# team-roster-crew-tree.test.sh — tap-zcqhj: indent crew seats under their parent seat
# with ASCII |-- and `-- indicators instead of inline alphabetical rows.
set -euo pipefail
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
if [ -f "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh" ]; then
  . "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
else
  . "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"
fi

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/bin/tap"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "team-roster-crew-tree: $*" >&2; exit 1; }

export TAP_INDEX_HOME="$WORK/index"
export NO_COLOR=1
mkdir -p "$TAP_INDEX_HOME" "$WORK/demo/.tap/bus"
# Roster-only controls use a configured repo; onboarding tests cover missing instructions.
cp "$ROOT/skills/tap/templates/repo-charter.md" "$WORK/demo/AGENTS.md"

cat >"$TAP_INDEX_HOME/global-registry.json" <<JSON
{"migrated":"t","schema":"0.20","teams":{
 "demo":{"enrolled_at":"t","registry_location":"$WORK/demo/.tap/team-registry.json","root":"$WORK/demo","state":"registered"}
}}
JSON

# Arm 1: Normal parent with crew children sorted by window index
cat >"$WORK/demo/.tap/team-registry.json" <<'JSON'
{"schema":"0.20","team":{"name":"demo","created_at":"t","created_by":"t","repo_root":"/tmp"},
 "seats":{
   "conductor":{"status":"active","delivery":"poll","harness":"codex","session":"demo/cond","pane":"demo/cond:0.0","registered_at":"t"},
   "leader":{"status":"active","delivery":"poll","harness":"claude","session":"demo/lead","pane":"demo/lead:0.0","registered_at":"t"},
   "z-child":{"status":"active","delivery":"poll","harness":"codex","crew":true,"session":"demo/lead","pane":"demo/lead:1.0","registered_at":"t"},
   "a-child":{"status":"active","delivery":"poll","harness":"codex","crew":true,"session":"demo/lead","pane":"demo/lead:2.0","registered_at":"t"}
 }}
JSON

export TAP_HOME="$WORK/demo/.tap/bus"
cd "$WORK/demo"

out="$("$TAP" team 2>&1)" || fail "tap team failed: $out"
grep -q "^tap team: demo" <<<"$out" || fail "missing header in output: $out"
grep -q "conductor" <<<"$out" || fail "missing conductor: $out"
grep -q "leader" <<<"$out" || fail "missing leader: $out"
grep -q "|-- z-child" <<<"$out" || fail "z-child not indented with |--: $out"
grep -q "\`-- a-child" <<<"$out" || fail "a-child not indented with \`--: $out"

# Verify that z-child (window 1.0) appears BEFORE a-child (window 2.0)
z_line="$(grep -n "|-- z-child" <<<"$out" | cut -d: -f1)"
a_line="$(grep -n "\`-- a-child" <<<"$out" | cut -d: -f1)"
[ "$z_line" -lt "$a_line" ] || fail "window 1 (z-child) must appear before window 2 (a-child): $out"

# Arm 2: Invariants for --names, --json, --all (status 0, clean stdout, silent stderr)
names_err="$("$TAP" team --names 2>&1 >"$WORK/names_stdout.txt")" || fail "tap team --names failed: $names_err"
[ -z "$names_err" ] || fail "--names must emit NO stderr; got: $names_err"
names_out="$(cat "$WORK/names_stdout.txt")"
grep -q "^z-child$" <<<"$names_out" || fail "--names must emit bare handles: $names_out"
grep -qF "|--" <<<"$names_out" && fail "--names must not contain tree prefixes: $names_out"

json_err="$("$TAP" team --json 2>&1 >"$WORK/json_stdout.txt")" || fail "tap team --json failed: $json_err"
[ -z "$json_err" ] || fail "--json must emit NO stderr; got: $json_err"
json_out="$(cat "$WORK/json_stdout.txt")"
grep -q '"crew":true' <<<"$json_out" || fail "--json missing crew field: $json_out"
grep -qF "|--" <<<"$json_out" && fail "--json must not contain tree prefixes: $json_out"

all_err="$("$TAP" team --all 2>&1 >"$WORK/all_stdout.txt")" || fail "tap team --all failed: $all_err"
[ -z "$all_err" ] || fail "--all must emit NO stderr; got: $all_err"
all_out="$(cat "$WORK/all_stdout.txt")"
grep -q "CREW" <<<"$all_out" || fail "--all missing CREW column: $all_out"
grep -qF "|--" <<<"$all_out" && fail "--all must not contain tree prefixes: $all_out"

# Arm 3: Rootless crew emits at most ONE warning to stderr naming tap-zhx82 and renders flat
cat >"$WORK/demo/.tap/team-registry.json" <<'JSON'
{"schema":"0.20","team":{"name":"demo","created_at":"t","created_by":"t","repo_root":"/tmp"},
 "seats":{
   "orphan1":{"status":"active","delivery":"poll","harness":"codex","crew":true,"session":"demo/ghost1","pane":"demo/ghost1:1.0","registered_at":"t"},
   "orphan2":{"status":"active","delivery":"poll","harness":"codex","crew":true,"session":"demo/ghost2","pane":"demo/ghost2:1.0","registered_at":"t"}
 }}
JSON

rootless_err="$("$TAP" team 2>&1 >"$WORK/stdout.txt")" || fail "tap team failed on rootless: $rootless_err"
rootless_out="$(cat "$WORK/stdout.txt")"
grep -q "tap-zhx82" <<<"$rootless_err" || fail "rootless crew must emit warning naming tap-zhx82: $rootless_err"
[ "$(grep -c "tap-zhx82" <<<"$rootless_err")" -eq 1 ] || fail "must emit at most ONE tap-zhx82 warning line: $rootless_err"
grep -q "^orphan1 " <<<"$rootless_out" || fail "rootless crew orphan1 must render flat: $rootless_out"
grep -q "^orphan2 " <<<"$rootless_out" || fail "rootless crew orphan2 must render flat: $rootless_out"
grep -qF "|--" <<<"$rootless_out" && fail "rootless crew must not have tree prefix: $rootless_out"

# Arm 4: Multiple parents in session emits at most ONE warning naming tap-7ph7f and nests under first
cat >"$WORK/demo/.tap/team-registry.json" <<'JSON'
{"schema":"0.20","team":{"name":"demo","created_at":"t","created_by":"t","repo_root":"/tmp"},
 "seats":{
   "alpha":{"status":"active","delivery":"poll","harness":"codex","session":"demo/shared1","pane":"demo/shared1:0.0","registered_at":"t"},
   "beta":{"status":"active","delivery":"poll","harness":"codex","session":"demo/shared1","pane":"demo/shared1:1.0","registered_at":"t"},
   "child1":{"status":"active","delivery":"poll","harness":"codex","crew":true,"session":"demo/shared1","pane":"demo/shared1:2.0","registered_at":"t"},
   "gamma":{"status":"active","delivery":"poll","harness":"codex","session":"demo/shared2","pane":"demo/shared2:0.0","registered_at":"t"},
   "delta":{"status":"active","delivery":"poll","harness":"codex","session":"demo/shared2","pane":"demo/shared2:1.0","registered_at":"t"},
   "child2":{"status":"active","delivery":"poll","harness":"codex","crew":true,"session":"demo/shared2","pane":"demo/shared2:2.0","registered_at":"t"}
 }}
JSON

multi_err="$("$TAP" team 2>&1 >"$WORK/stdout.txt")" || fail "tap team failed on multi-parent: $multi_err"
multi_out="$(cat "$WORK/stdout.txt")"
grep -q "tap-7ph7f" <<<"$multi_err" || fail "multiple parents must emit warning naming tap-7ph7f: $multi_err"
[ "$(grep -c "tap-7ph7f" <<<"$multi_err")" -eq 1 ] || fail "must emit at most ONE tap-7ph7f warning line: $multi_err"
grep -q "\`-- child1" <<<"$multi_out" || fail "child1 must nest under alpha: $multi_out"
grep -q "\`-- child2" <<<"$multi_out" || fail "child2 must nest under gamma: $multi_out"

echo "team-roster-crew-tree: ok"
