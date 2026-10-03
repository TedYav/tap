#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tap-agent-state-mutants.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# A mutant's nonzero exit is evidence only after these same copied inputs pass.
CONTROL="$WORK/control"
mkdir -p "$CONTROL/runtime/bun/src" "$CONTROL/runtime/bun/test"
cp "$ROOT/runtime/bun/src/agent-state.ts" "$ROOT/runtime/bun/src/terminal-text.ts" "$ROOT/runtime/bun/src/opencode-composer.ts" "$CONTROL/runtime/bun/src/"
cp "$ROOT/runtime/bun/test/agent-state.test.ts" "$CONTROL/runtime/bun/test/agent-state.test.ts"
cp -R "$ROOT/runtime/bun/test/fixtures" "$CONTROL/runtime/bun/test/fixtures"
mkdir -p "$CONTROL/skills/tap/scripts/smoke/fixtures"
for fixture in opencode-splash pane-state submit-verify; do
  cp -R "$ROOT/skills/tap/scripts/smoke/fixtures/$fixture" \
    "$CONTROL/skills/tap/scripts/smoke/fixtures/$fixture"
done
control_rc=0
(cd "$CONTROL/runtime/bun" && "$ROOT/runtime/bun/test/run.sh" test/agent-state.test.ts) \
  >"$WORK/control.out" 2>&1 || control_rc=$?
if [ "$control_rc" -ne 0 ]; then
  echo "agent-state-mutants: unmodified control failed" >&2
  cat "$WORK/control.out" >&2
  exit 1
fi
echo "agent-state-mutants: unmodified control passed"

run_mutant() {
  local name="$1" before="$2" after="$3" rc=0
  local tree="$WORK/$name" out="$WORK/$name.out"
  cp -R "$CONTROL" "$tree"
  BEFORE="$before" AFTER="$after" python3 -B - "$tree/runtime/bun/src/agent-state.ts" <<'PY'
import os, pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
before, after = os.environ["BEFORE"], os.environ["AFTER"]
if text.count(before) != 1:
    raise SystemExit(f"mutation anchor count={text.count(before)} for {before!r}")
path.write_text(text.replace(before, after))
PY
  (cd "$tree/runtime/bun" && "$ROOT/runtime/bun/test/run.sh" test/agent-state.test.ts) >"$out" 2>&1 || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "agent-state-mutants: $name SURVIVED" >&2
    cat "$out" >&2
    exit 1
  fi
  echo "agent-state-mutants: $name proven RED"
}

run_mutant priority-inversion \
  'rule.priority > matched.priority' \
  'rule.priority < matched.priority'
run_mutant whole-screen-region \
  'return bottomNonEmptyLines(screen, region.count);' \
  'return screen;'
run_mutant disabled-not-gate \
  'if ((gate.not ?? []).some((nested) => gateMatches(nested, text))) return false;' \
  'if (false && (gate.not ?? []).some((nested) => gateMatches(nested, text))) return false;'
run_mutant disabled-any-gate \
  'if ((gate.any?.length ?? 0) > 0 && !gate.any!.some((nested) => gateMatches(nested, text))) {' \
  'if (false && (gate.any?.length ?? 0) > 0 && !gate.any!.some((nested) => gateMatches(nested, text))) {'
run_mutant idle-fallback \
  'return { agentState: "unknown", reason: "no_matching_rule" };' \
  'return { agentState: "idle", reason: "no_matching_rule" };'

echo "agent-state-mutants: ok"
