#!/usr/bin/env bash
# Public-door arms for `tap watch on`'s context controls: arm persistence and
# the explicit-intent refusals. The detector's wiring arms -- the registry
# file, payload files on disk, the live lease record, the gauge and
# inbox-clear programs, the clear-command authority, and the native notice
# sender -- moved to runtime/bun/test/watch-context-pressure.test.ts, which
# enters the same main(argv, env) door in-process that the tick's seam uses
# (watch-tick-run.ts imports the detector; no production caller shells out to
# watch-detectors.ts since the Bash bridge was retired). The detector RULES
# are certified by the frozen-capture replay (runtime/bun/test/
# watch-detectors.test.ts).
if [ "${BASH_SOURCE[0]}" != "$0" ]; then echo 'run this test; do not source it' >&2; return 1; fi
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
export TAP_INDEX_HOME="$work/index"
mkdir -p "$TAP_INDEX_HOME"
printf '{"schema":"0.20","teams":{}}\n' > "$TAP_INDEX_HOME/global-registry.json"  # born live (F1)

# Exercise arm persistence and the existing explicit-intent refusal through CLI.
arm_bus="$work/arm/.tap/bus"; mkdir -p "$arm_bus/payloads" "$arm_bus/receipts"
printf '{"schema": "0.20", "team":{"name":"arm","worktree_root":"%s/arm"},"seats":{}}\n' "$work" > "$arm_bus/registry.json"
arm() { TAP_HOME="$arm_bus" command bash "$ROOT/bin/tap" watch on --by lead -m 'context controls complete' --evaluator none --no-spawn "$@"; }
arm --context-threshold 55 --context-exempt driver,leader > "$work/arm.log"
python3 - "$arm_bus/watch/arm.json" <<'PY'
import json,sys
row=json.load(open(sys.argv[1]))
assert int(row['context_threshold_percent']) == 55
assert row['context_exempt']=='driver,leader'
PY
arm >/dev/null
if arm --context-threshold 40 > "$work/refusal" 2>&1; then echo 'changed arm intent accepted' >&2; exit 1; fi
grep -q context_threshold_percent "$work/refusal"
if arm --context-threshold 101 > "$work/refusal" 2>&1; then exit 1; fi
printf 'watch-context-pressure: public arm persistence and refusal passed\n'
