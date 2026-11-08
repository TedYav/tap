#!/usr/bin/env bash
# D5: fixture-door — bun-router.test.sh:223-224: team-roster-json.ts is executed there only as a legacy reference oracle, its output byte-compared against the compiled `$BIN crew list`; the public CLI binary is the actual subject under test throughout the file
# bun-router.test.sh — compile and exercise the mixed Bun/Bash entry point.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
. "$ROOT/scripts/serial-trigger.sh"
tap_serial_triggers "runtime/bun/" "bin/" "scripts/" "skills/tap/" ".github/workflows/"
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

RUNTIME="$ROOT/runtime/bun"
INCUMBENT="$ROOT/bin/tap"
BUN="${TAP_SMOKE_BUN:-$(command -v bun 2>/dev/null || true)}"
WORK="$(mktemp -d)"
BIN="$RUNTIME/tap-smoke.$$"

fail() { echo "bun-router: $1" >&2; exit 1; }
cleanup() {
  if [ -d "$WORK" ]; then
    set +e
    local lsof_bin
    lsof_bin="$(command -v lsof 2>/dev/null || printf '%s' /usr/sbin/lsof)"
    "$lsof_bin" +D "$WORK" >/dev/null 2>&1
    local lsof_rc=$?
    set -e
    if [ "$lsof_rc" -ne 1 ]; then
      echo "bun-router: refusing to remove scratch without an unowned lsof result: $WORK" >&2
      return 1
    fi
  fi
  rm -rf "$WORK"
  [ ! -e "$BIN" ] || rm -f "$BIN"
}
trap cleanup EXIT

[ -n "$BUN" ] && [ -x "$BUN" ] || fail "Bun executable unavailable"
command -v tmux >/dev/null 2>&1 || fail "tmux unavailable for router checks"
[ ! -e "$BIN" ] || fail "refusing to overwrite existing smoke binary: $BIN"

capture() {
  local prefix="$1"
  shift
  set +e
  "$@" >"$prefix.out" 2>"$prefix.err"
  printf '%s\n' "$?" >"$prefix.rc"
  set -e
}

assert_same() {
  local expected="$1" actual="$2" label="$3"
  cmp "$expected.rc" "$actual.rc" || fail "$label exit status differs"
  cmp "$expected.out" "$actual.out" || fail "$label stdout differs"
  cmp "$expected.err" "$actual.err" || fail "$label stderr differs"
}


(
  cd "$RUNTIME"
  # tap-qofur, ruled 2026-08-27 (option c + riders): the typecheck runs in the
  # gate WHEN THE TOOLCHAIN IS PRESENT, and declares a visible skip naming the
  # covering context when it is not — never a silent absence. `tsc` is a
  # devDependency (runtime/bun/bun.lock) and node_modules never travels to
  # checkouts or worktrees, so a clean checkout skips; a provisioned one
  # (bun install --frozen-lockfile) typechecks here. The skip is honest only
  # because the bun-typecheck CI job is a required context (see PR body:
  # main carries no machine branch-protection — the requirement is process-
  # enforced and stated in AGENTS.md where the gate is defined).
  if [ -x "$RUNTIME/node_modules/.bin/tsc" ]; then
    "$BUN" run typecheck
  else
    echo "SMOKE-SKIP: bun-router typecheck — runtime/bun/node_modules absent (bun install --frozen-lockfile provisions it); covered by the bun-typecheck CI context"
  fi
  # The full Bun suite lives in bun-suite.test.sh; keep these quick controls
  # with compilation and CLI parity so selection does not drop them.
  "$RUNTIME/test/agent-state-mutants.test.sh"
  "$BUN" build --compile main.ts --outfile "$BIN"
)
[ -x "$BIN" ] || fail "compiled router is not executable"
echo "bun-router: (1) conditional typecheck (declared skip when unprovisioned), mutation controls, self-contained compile: ok"

mkdir -p "$WORK/userhome" "$WORK/index"
# Every install is born live (F1): an absent machine index refuses as
# unanchored_bus, so the smoke runs under an empty live index.
printf '{"schema":"0.20","teams":{}}\n' > "$WORK/index/global-registry.json"
cp "$WORK/index/global-registry.json" "$WORK/index-seed.json"
TRACE="$WORK/routes.trace"
BASE_ENV=(env -u TMUX -u TMUX_PANE -u TAP_SELF HOME="$WORK/userhome" TAP_INDEX_HOME="$WORK/index" TAP_TMUX_SOCKET="tapbun-smoke-$$")

# Compiled watch callers must use installed companion paths and a real Bun.
# A tick's exit 0 alone is weak: spool failures are advisory, so also require the
# actual native spool pass to reconcile the old tint snapshot.
mkdir -p "$WORK/watch-bus/watch" "$WORK/watch-bus/spool" "$WORK/watch-bus/payloads" "$WORK/watch-bus/receipts"
printf '{"schema": "0.20", "team":{"name":"fixture"},"seats":{}}\n' > "$WORK/watch-bus/registry.json"
: > "$WORK/watch-bus/.tap-bus-authority"
printf '{"armed_at":1000,"armed_by":"lead","threshold_seconds":9999999999,"tick_interval_seconds":1,"tinted_panes":["tap-test-never-live"]}\n' > "$WORK/watch-bus/watch/arm.json"
capture "$WORK/watch-tick-compiled" "${BASE_ENV[@]}" TAP_HOME="$WORK/watch-bus" "$BIN" watch tick
[ "$(cat "$WORK/watch-tick-compiled.rc")" = 0 ] || fail "compiled watch tick failed"
python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["tinted_panes"] == []' "$WORK/watch-bus/watch/arm.json" \
  || fail "compiled watch tick did not reach the native spool pass"
rm -f "${WORK:?}/watch-bus/watch/arm.json"
capture "$WORK/watch-run-compiled" "${BASE_ENV[@]}" TAP_HOME="$WORK/watch-bus" "$BIN" watch run
[ "$(cat "$WORK/watch-run-compiled.rc")" = 0 ] || { cat "$WORK/watch-run-compiled.err" >&2; fail "compiled watch run did not reach its unarmed native entry"; }


capture "$WORK/help-ref" "${BASE_ENV[@]}" bash "$INCUMBENT" help
capture "$WORK/help-new" "${BASE_ENV[@]}" TAP_BUN_ROUTE_TRACE="$TRACE" "$BIN" help
assert_same "$WORK/help-ref" "$WORK/help-new" "delegated help"

capture "$WORK/who-ref" "${BASE_ENV[@]}" bash "$INCUMBENT" whoami --pane bun-router-no-such-pane
capture "$WORK/who-new" "${BASE_ENV[@]}" TAP_BUN_ROUTE_TRACE="$TRACE" "$BIN" whoami --pane bun-router-no-such-pane
assert_same "$WORK/who-ref" "$WORK/who-new" "native whoami"

# Compiled setup must find the shipped charter through the scripts root, not
# through the bundled module's import.meta.dir. Repo-only setup creates no bus.
mkdir -p "$WORK/setup"
( cd "$WORK/setup" && capture "$WORK/setup-new" "${BASE_ENV[@]}" TAP_BUN_ROUTE_TRACE="$TRACE" "$BIN" setup --repo )
[ "$(cat "$WORK/setup-new.rc")" = 0 ] || fail "compiled setup --repo failed"
cmp "$ROOT/skills/tap/templates/repo-charter.md" "$WORK/setup/AGENTS.md" || fail "compiled setup used the wrong charter"
( cd "$WORK/setup" && capture "$WORK/setup-check-ref" "${BASE_ENV[@]}" bash "$INCUMBENT" setup --repo --check )
( cd "$WORK/setup" && capture "$WORK/setup-check-new" "${BASE_ENV[@]}" TAP_BUN_ROUTE_TRACE="$TRACE" "$BIN" setup --repo --check )
assert_same "$WORK/setup-check-ref" "$WORK/setup-check-new" "compiled setup check"
[ "$(cat "$WORK/setup-check-new.rc")" = 0 ] || fail "compiled setup check did not report current"
[ ! -e "$WORK/setup/.tap" ] || fail "repo-only setup initialized a bus"

# Compiled skill lookup finds the checkout's skills through the same scripts
# root, not through the bundle's import.meta.path.
capture "$WORK/skill-compiled" "${BASE_ENV[@]}" "$BIN" help skill tap
[ "$(cat "$WORK/skill-compiled.rc")" = 0 ] || { cat "$WORK/skill-compiled.err" >&2; fail "compiled help skill failed"; }
[ "$(cat "$WORK/skill-compiled.out")" = "$(cd -P "$ROOT" && pwd)/skills/tap/SKILL.md" ] \
  || fail "compiled help skill did not resolve the checkout's skill: $(cat "$WORK/skill-compiled.out")"

# A local verb with no bus in reach. The onboarding preflight refuses BEFORE
# dispatch (runtime/bun/src/onboarding.ts, called from main.ts ahead of route()
# and from tap.sh ahead of lib.sh), so BOTH runtimes answer here and neither
# reaches the router — this form contributes no trace line, and the seated case
# below is what keeps compiled native `team` dispatch covered. Run it from a
# scratch cwd so "consent was refused and nothing was created" is observable
# instead of entangled with the shared checkout.
mkdir -p "$WORK/nobus"
( cd "$WORK/nobus" && capture "$WORK/team-ref" "${BASE_ENV[@]}" bash "$INCUMBENT" team --json )
( cd "$WORK/nobus" && capture "$WORK/team-new" "${BASE_ENV[@]}" TAP_BUN_ROUTE_TRACE="$TRACE" "$BIN" team --json )
assert_same "$WORK/team-ref" "$WORK/team-new" "busless team --json refusal"
[ "$(cat "$WORK/team-new.rc")" = 1 ] || fail "busless team --json did not exit 1"
python3 - "$WORK/team-new.out" <<'REFUSAL' || fail "busless team --json is not exactly one unanchored_bus refusal naming tap init"
import json, sys

lines = [line for line in open(sys.argv[1]).read().splitlines() if line.strip()]
if len(lines) != 1:
    raise SystemExit(f"expected exactly one JSON line on stdout, got {len(lines)}")
doc = json.loads(lines[0])
if doc.get("ok") is not False:
    raise SystemExit(f"refusal is not ok:false: {doc.get('ok')!r}")
if doc.get("error_class") != "unanchored_bus":
    raise SystemExit(f"error_class is {doc.get('error_class')!r}")
if doc.get("action") != "tap init":
    raise SystemExit(f"action is {doc.get('action')!r}")
REFUSAL
# Default-NO consent means the refusal creates nothing: no dot-directory beside
# the caller, no bus under HOME, no machine-index enrollment.
for created in "$WORK/nobus/.tap" "$WORK/userhome/.tap"; do
  [ ! -e "$created" ] || fail "busless team --json refusal created bus state: $created"
done
cmp -s "$WORK/index-seed.json" "$WORK/index/global-registry.json" || fail "busless team --json refusal changed the machine index"

mkdir -p "$WORK/roster/.tap/bus/payloads" "$WORK/roster/.tap/bus/receipts"
# Enroll the seated bus as team roster: under the live index, attach reads the
# team's stored registry_location.
printf '{"schema":"0.20","teams":{"roster":{"root":"%s","registry_location":"%s"}}}\n' \
  "$WORK/roster" "$WORK/roster/.tap/bus/registry.json" > "$WORK/index/global-registry.json"
cat >"$WORK/roster/.tap/bus/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"roster"},"seats":{"pollbot":{"status":"active","delivery":"poll","harness":"daemon","unattended":true,"preset":{"name":"ghost"}}}}
JSON
capture "$WORK/team-seated-ref" "${BASE_ENV[@]}" TAP_HOME="$WORK/roster/.tap/bus" bash "$INCUMBENT" team --json
capture "$WORK/team-seated-new" "${BASE_ENV[@]}" TAP_HOME="$WORK/roster/.tap/bus" TAP_BUN_ROUTE_TRACE="$TRACE" "$BIN" team --json
# These are independent observations; compare the contract apart from their wall clocks.
python3 - "$WORK/team-seated-ref.out" "$WORK/team-seated-new.out" <<'OBSERVATION_CLOCK'
import json, re, sys
for path in sys.argv[1:]:
    with open(path) as stream:
        doc = json.load(stream)
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", doc.pop("observed_at"))
    with open(path, "w") as stream:
        json.dump(doc, stream, separators=(",", ":"), ensure_ascii=True)
        stream.write("\n")
OBSERVATION_CLOCK
assert_same "$WORK/team-seated-ref" "$WORK/team-seated-new" "compiled native team observation"
grep -q '"handle":"pollbot"' "$WORK/team-seated-new.out" || fail "compiled native team did not observe the seated roster"
grep -q '"agent_state":"unknown","agent_state_reason":"no_pane"' "$WORK/team-seated-new.out" || fail "compiled native team did not classify the pane-less roster row"
grep -q '"preset_catalog_unavailable":true' "$WORK/team-seated-new.out" || fail "compiled native team did not resolve the preset display helper"

# Bare `nudge` on both doors: the same usage refusal with no pane effect, and
# the seated bus keeps the onboarding preflight out of the answer.
capture "$WORK/nudge-ref" "${BASE_ENV[@]}" TAP_HOME="$WORK/roster/.tap/bus" bash "$INCUMBENT" nudge
capture "$WORK/nudge-new" "${BASE_ENV[@]}" TAP_HOME="$WORK/roster/.tap/bus" TAP_BUN_ROUTE_TRACE="$TRACE" "$BIN" nudge
assert_same "$WORK/nudge-ref" "$WORK/nudge-new" "native nudge"

# Bare `worktree` on both doors (R12 U1): the same native usage refusal with no
# git effect — the Bash door reaches the handler through tap.sh's arm.
capture "$WORK/worktree-ref" "${BASE_ENV[@]}" TAP_HOME="$WORK/roster/.tap/bus" bash "$INCUMBENT" worktree
capture "$WORK/worktree-new" "${BASE_ENV[@]}" TAP_HOME="$WORK/roster/.tap/bus" TAP_BUN_ROUTE_TRACE="$TRACE" "$BIN" worktree
assert_same "$WORK/worktree-ref" "$WORK/worktree-new" "native worktree"

# `attach <ghost>` on both doors: the same not_found refusal before any pane
# effect. The enrolled roster makes the local-team read and the row lookup
# deterministic without tmux.
capture "$WORK/attach-ref" "${BASE_ENV[@]}" TAP_HOME="$WORK/roster/.tap/bus" bash "$INCUMBENT" attach ghost
capture "$WORK/attach-new" "${BASE_ENV[@]}" TAP_HOME="$WORK/roster/.tap/bus" TAP_BUN_ROUTE_TRACE="$TRACE" "$BIN" attach ghost
assert_same "$WORK/attach-ref" "$WORK/attach-new" "native attach"
grep -F "no seat 'ghost' on team 'roster'" "$WORK/attach-new.err" >/dev/null || { cat "$WORK/attach-new.err" >&2; fail "native attach did not answer the roster not_found refusal"; }

# `crew list` on both doors: the same empty-crew roster answer with no pane
# effect, and both must dispatch natively. The seated row is a poll seat, so
# the crew-only filter empties the roster.
capture "$WORK/crew-list-ref" "${BASE_ENV[@]}" TAP_HOME="$WORK/roster/.tap/bus" TAP_BUN_ROUTE_TRACE="$TRACE" bash "$INCUMBENT" crew list
capture "$WORK/crew-list-new" "${BASE_ENV[@]}" TAP_HOME="$WORK/roster/.tap/bus" TAP_BUN_ROUTE_TRACE="$TRACE" "$BIN" crew list
assert_same "$WORK/crew-list-ref" "$WORK/crew-list-new" "native crew list"
grep -F "no crew registered" "$WORK/crew-list-new.out" >/dev/null || fail "native crew list did not answer the empty crew roster"

# `crew add --harness codex` on both doors: the same pre-effect retired-flag
# refusal — no window, no registration, no launcher call.
capture "$WORK/crew-ref-ref" "${BASE_ENV[@]}" TAP_HOME="$WORK/roster/.tap/bus" TAP_BUN_ROUTE_TRACE="$TRACE" bash "$INCUMBENT" crew add --harness codex
capture "$WORK/crew-ref-new" "${BASE_ENV[@]}" TAP_HOME="$WORK/roster/.tap/bus" TAP_BUN_ROUTE_TRACE="$TRACE" "$BIN" crew add --harness codex
assert_same "$WORK/crew-ref-ref" "$WORK/crew-ref-new" "native crew add retired flag"
grep -F -- "--harness is retired" "$WORK/crew-ref-new.err" >/dev/null || fail "native crew add did not answer the retired --harness refusal"

# The direct native roster and compiled crew entrance share crew filtering.
mkdir -p "$WORK/crew-bus"
cat >"$WORK/crew-bus/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"roster"},"seats":{"worker":{"crew":true,"status":"active","harness":"codex","pane":"","pane_id":""},"pollbot":{"status":"active","delivery":"poll","harness":"daemon"}}}
JSON
capture "$WORK/crew-roster-ref" "${BASE_ENV[@]}" TAP_HOME="$WORK/crew-bus" TAP_TEAM_CREW_ONLY=1 TAP_TEAM_LIST_VERB='crew list' bun "$ROOT/runtime/bun/src/team-roster-json.ts"
capture "$WORK/crew-roster-new" "${BASE_ENV[@]}" TAP_HOME="$WORK/crew-bus" "$BIN" crew list
assert_same "$WORK/crew-roster-ref" "$WORK/crew-roster-new" "crew list native layout"
grep -F worker "$WORK/crew-roster-new.out" >/dev/null || fail "crew roster lost its crew row"
if grep -F pollbot "$WORK/crew-roster-new.out" >/dev/null; then fail "crew roster leaked a durable row"; fi

# Compiled TAP must invoke the surviving Bun resolver, including its parser.
capture "$WORK/crew-resolver-ref" "${BASE_ENV[@]}" TAP_HOME="$WORK/roster/.tap/bus" TAP_JSON=1 bash "$INCUMBENT" crew add -x
capture "$WORK/crew-resolver-new" "${BASE_ENV[@]}" TAP_HOME="$WORK/roster/.tap/bus" TAP_JSON=1 "$BIN" crew add -x
assert_same "$WORK/crew-resolver-ref" "$WORK/crew-resolver-new" "compiled crew resolver"
grep -F '"error_class":"session_error"' "$WORK/crew-resolver-new.out" >/dev/null || fail "compiled crew resolver lost its argv refusal"

ln -s "$BIN" "$WORK/tap"
[ "$(PATH="$WORK:$PATH" command -v tap)" = "$WORK/tap" ] || fail "lane-local PATH did not select compiled router"
# Twelve dispatches, not thirteen: the busless `team --json` above is answered by
# the onboarding preflight ahead of route(), and trace() only records what
# route() dispatches. Its own assertions above stand in for the line it does
# not write.
printf 'native help\nnative whoami\nnative setup\nnative setup\nnative team\nnative nudge\nnative worktree\nnative attach\nnative crew\nnative crew\nnative crew\nnative crew\n' >"$WORK/expected.trace"
cmp "$WORK/expected.trace" "$TRACE" || fail "compiled router trace was missing, duplicated, or misrouted"
echo "bun-router: (2) compiled native/fallback routes preserve status and legacy fields; native JSON adds agent state: ok"
echo "bun-router: ok"
