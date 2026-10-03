#!/usr/bin/env bash
# D5: path-reference — skills/tap/scripts/smoke/bun-runner-discovery.test.sh:18: the src reference is fixture-tree scaffolding — :18 creates runtime/bun/src inside the fixture repo and :21-28 writes intended.test.ts into it, then asserts the runner discovers and runs it from odd cwds; the src path names fixture content the runner must traverse, not a production module, and the run.sh invocations own the runner behavior
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
WORK="$(mktemp -d /tmp/tap-bd.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

fail() {
  echo "bun-runner-discovery: $*" >&2
  sed 's/^/  | /' "$WORK/run.log" >&2
  exit 1
}

# Use the real runner and Bun in a tiny checkout-shaped fixture. An ignored
# scratch test must not become suite coverage just because the caller is at root.
fixture="$WORK/repo"
mkdir -p "$fixture/runtime/bun/test/nested" "$fixture/runtime/bun/src" "$fixture/scripts" "$fixture/tmp/seat" "$WORK/elsewhere"
cp "$ROOT/runtime/bun/test/run.sh" "$fixture/runtime/bun/test/run.sh"
cp "$ROOT/scripts/ignored-state-tripwire.py" "$fixture/scripts/ignored-state-tripwire.py"
printf 'tmp/\n' > "$fixture/.gitignore"
for location in test/nested src; do
  cat > "$fixture/runtime/bun/$location/intended.test.ts" <<'TEST'
import { test } from "bun:test";
import { appendFileSync } from "node:fs";
test("intended suite test", () => appendFileSync(process.env.BUN_RUNNER_DISCOVERY_LOG!, "suite\n"));
TEST
done
cat > "$fixture/tmp/seat/probe.test.ts" <<'TEST'
import { test } from "bun:test";
import { appendFileSync } from "node:fs";
test("explicit scratch probe", () => {
  if (process.env.BUN_RUNNER_ALLOW_PROBE !== "1") throw new Error("scratch probe discovered by default");
  appendFileSync(process.env.BUN_RUNNER_DISCOVERY_LOG!, "probe\n");
});
TEST
# An archived copy of a real test under a scratch seat dir (tap-pxc8d): a repo-relative
# path argument must not select it.
mkdir -p "$fixture/tmp/seat/runtime/bun/test/nested"
sed 's/"suite\\n"/"planted\\n"/' "$fixture/runtime/bun/test/nested/intended.test.ts" > "$fixture/tmp/seat/runtime/bun/test/nested/intended.test.ts"
grep -q planted "$fixture/tmp/seat/runtime/bun/test/nested/intended.test.ts" || fail "(pxc8d) could not plant the archived copy"
export BUN_RUNNER_DISCOVERY_LOG="$WORK/observed"
for caller in "$fixture" "$fixture/runtime/bun" "$WORK/elsewhere"; do
  : > "$BUN_RUNNER_DISCOVERY_LOG"
  (cd "$caller" && bash "$fixture/runtime/bun/test/run.sh") > "$WORK/run.log" 2>&1 || fail "(1) ${caller##*/}: default suite command failed"
  [ "$(cat "$BUN_RUNNER_DISCOVERY_LOG")" = "$(printf 'suite\nsuite')" ] || fail "(2) ${caller##*/}: intended suite coverage differs"
  ! grep -q 'tmp/seat' "$WORK/run.log" || fail "(3) ${caller##*/}: default discovery included scratch"
done
echo 'bun-runner-discovery: defaults include nested test and src coverage, exclude scratch from every cwd: ok'

: > "$BUN_RUNNER_DISCOVERY_LOG"
(cd "$fixture" && BUN_RUNNER_ALLOW_PROBE=1 bash "$fixture/runtime/bun/test/run.sh" ./tmp/seat/probe.test.ts --test-name-pattern 'explicit scratch probe') > "$WORK/run.log" 2>&1 || fail '(4) repo: explicit probe command failed'
[ "$(cat "$BUN_RUNNER_DISCOVERY_LOG")" = probe ] || fail '(5) repo: explicit probe selection differs'
echo 'bun-runner-discovery: explicit relative probe and test filter remain focused: ok'

# tap-pxc8d: a repo-relative path names ONE file, not a substring filter that also selects
# the archived copy; a name that is not on disk still filters as before.
: > "$BUN_RUNNER_DISCOVERY_LOG"
(cd "$fixture" && bash "$fixture/runtime/bun/test/run.sh" runtime/bun/test/nested/intended.test.ts) > "$WORK/run.log" 2>&1 || fail '(8) repo-relative path command failed'
[ "$(cat "$BUN_RUNNER_DISCOVERY_LOG")" = suite ] || fail "(9) a repo-relative path selected more than its own file: $(tr '\n' ' ' < "$BUN_RUNNER_DISCOVERY_LOG")"
: > "$BUN_RUNNER_DISCOVERY_LOG"
(cd "$fixture" && bash "$fixture/runtime/bun/test/run.sh" nested/intended.test.ts) > "$WORK/run.log" 2>&1 || fail '(10) name-filter command failed'
grep -qx suite "$BUN_RUNNER_DISCOVERY_LOG" || fail "(11) a non-path name filter no longer selects by substring"
# Bun's grammar is `[flags] [<patterns>]`: a path AFTER an option is still a pattern. With
# a leading non-path filter (`src/intended`) the relative path after the option is the one
# the runner must make exact.
: > "$BUN_RUNNER_DISCOVERY_LOG"
(cd "$fixture" && bash "$fixture/runtime/bun/test/run.sh" src/intended --timeout=5000 runtime/bun/test/nested/intended.test.ts) > "$WORK/run.log" 2>&1 || fail '(8b) path-after-option command failed'
grep -qx suite "$BUN_RUNNER_DISCOVERY_LOG" || fail "(9b) the path after an option selected nothing"
! grep -qx planted "$BUN_RUNNER_DISCOVERY_LOG" || fail "(9c) a path after an option selected the archived copy too"
# A path-shaped VALUE of a value-taking option is not a pattern and stays as typed: from
# runtime/bun, `-t test` names the tests matching "test", and `test` also exists as a
# directory. The intended test running is the positive witness (a rewritten value would
# match no test name, so nothing would run).
: > "$BUN_RUNNER_DISCOVERY_LOG"
(cd "$fixture/runtime/bun" && bash "$fixture/runtime/bun/test/run.sh" test/nested/intended.test.ts -t test) > "$WORK/run.log" 2>&1 || fail '(8c) option-value command failed'
[ "$(cat "$BUN_RUNNER_DISCOVERY_LOG")" = suite ] || fail "(9d) an option value that exists on disk was rewritten: intended test did not run exactly once ($(tr '\n' ' ' < "$BUN_RUNNER_DISCOVERY_LOG"))"
# `--parallel` (like `--changed`, which needs a git checkout the fixture is not) takes an
# optional value in the same token only, so bare it does NOT consume the next argument: the
# relative path after it is a pattern and must be made exact like any other.
for bare in --parallel; do
  : > "$BUN_RUNNER_DISCOVERY_LOG"
  (cd "$fixture" && bash "$fixture/runtime/bun/test/run.sh" src/intended "$bare" runtime/bun/test/nested/intended.test.ts) > "$WORK/run.log" 2>&1 || fail "(8d) $bare: bare flag then path command failed"
  grep -qx suite "$BUN_RUNNER_DISCOVERY_LOG" || fail "(9e) $bare: the path after the bare flag selected nothing"
  ! grep -qx planted "$BUN_RUNNER_DISCOVERY_LOG" || fail "(9f) $bare: the path after the bare flag was left a substring pattern and selected the archived copy"
done
echo 'bun-runner-discovery: repo-relative paths are exact; non-path filters still select by substring: ok'

# tap-ied3q: a caller's FORCE_COLOR must not colorize Bun's result rows, which the CI
# gate and smoke-all parse as plain text.
(cd "$fixture" && FORCE_COLOR=1 bash "$fixture/runtime/bun/test/run.sh" runtime/bun/test/nested/intended.test.ts) > "$WORK/run.log" 2>&1 || fail '(12) FORCE_COLOR command failed'
[ "$(grep -c "$(printf '\033')" "$WORK/run.log")" = 0 ] || fail "(13) FORCE_COLOR reached Bun: the runner output carries ANSI escapes"
echo 'bun-runner-discovery: a caller FORCE_COLOR is scrubbed from the runner: ok'

# A timeout or name flag alone must not restore caller-wide discovery. Require
# the selector first instead of maintaining a second parser for Bun's options.
for option in --timeout=20000 --only --help; do
  : > "$BUN_RUNNER_DISCOVERY_LOG"
  rc=0
  (cd "$fixture" && bash "$fixture/runtime/bun/test/run.sh" "$option") > "$WORK/run.log" 2>&1 || rc=$?
  [ "$rc" = 64 ] && [ ! -s "$BUN_RUNNER_DISCOVERY_LOG" ] || fail "(6) $option: option-first call did not refuse before discovery"
  grep -q 'explicit test path/filter before Bun options' "$WORK/run.log" || fail "(7) $option: refusal omitted selector guidance"
done
echo 'bun-runner-discovery: option-first calls refuse before discovering any tests: ok'

# tap-u6do6: the runner names the files Bun executed, and an empty selection is an
# error, not a pass. The names come from the test entries Bun opens, not from the arguments.
ran_line() { grep '^run.sh: ran ' "$WORK/run.log" || true; }

rc=0
(cd "$fixture" && bash "$fixture/runtime/bun/test/run.sh" runtime/bun/test/nested/no-such-file.test.ts) > "$WORK/run.log" 2>&1 || rc=$?
[ "$rc" != 0 ] || fail '(14) a nonexistent file argument exited 0'
grep -q '^run.sh: no test files ran' "$WORK/run.log" || fail '(15) a nonexistent file argument omitted the named error'
[ -z "$(ran_line)" ] || fail '(15b) a zero-file run also printed a ran-files summary'

(cd "$fixture" && bash "$fixture/runtime/bun/test/run.sh" runtime/bun/test/nested/intended.test.ts) > "$WORK/run.log" 2>&1 || fail '(16) single-file run failed'
[ "$(ran_line)" = 'run.sh: ran 1 file: runtime/bun/test/nested/intended.test.ts' ] || fail "(17) single-file summary differs: $(ran_line)"

# A filter that matches two files names both, and only those.
mkdir -p "$fixture/runtime/bun/test/pair"
for twin in a b; do
  printf 'import { test } from "bun:test";\ntest("pair %s", () => {});\n' "$twin" > "$fixture/runtime/bun/test/pair/pair-$twin.test.ts"
done
(cd "$fixture" && bash "$fixture/runtime/bun/test/run.sh" pair-) > "$WORK/run.log" 2>&1 || fail '(18) two-file filter run failed'
[ "$(ran_line | sed 's/^run.sh: ran 2 files: //' | tr ' ' '\n' | LC_ALL=C sort | tr '\n' ' ')" = 'runtime/bun/test/pair/pair-a.test.ts runtime/bun/test/pair/pair-b.test.ts ' ] \
  || fail "(19) two-file filter summary differs: $(ran_line)"
rm -rf "${fixture:?}/runtime/bun/test/pair"

# Bun's own failure and exit status survive, and the failing run still names its files.
mkdir -p "$fixture/runtime/bun/test/failing"
cat > "$fixture/runtime/bun/test/failing/red.test.ts" <<'TEST'
import { test } from "bun:test";
test("deliberate failure", () => { throw new Error("deliberate"); });
TEST
rc=0
(cd "$fixture" && bash "$fixture/runtime/bun/test/run.sh" runtime/bun/test/failing/red.test.ts) > "$WORK/run.log" 2>&1 || rc=$?
[ "$rc" != 0 ] || fail '(20) a failing test file exited 0'
grep -q 'deliberate' "$WORK/run.log" || fail "(21) Bun's failure output was lost"
[ "$(ran_line)" = 'run.sh: ran 1 file: runtime/bun/test/failing/red.test.ts' ] || fail "(22) failing-run summary differs: $(ran_line)"
rm -rf "${fixture:?}/runtime/bun/test/failing"
echo 'bun-runner-discovery: the runner names the files Bun ran; an empty selection exits nonzero with a named error: ok'

# Files Bun opens but that record no testcase are still files it ran: an empty file and a
# module-load error. The load error keeps Bun's failing status.
printf 'export const x = 1;\n' > "$fixture/runtime/bun/test/empty.test.ts"
(cd "$fixture" && bash "$fixture/runtime/bun/test/run.sh" runtime/bun/test/empty.test.ts) > "$WORK/run.log" 2>&1 || true
[ "$(ran_line)" = 'run.sh: ran 1 file: runtime/bun/test/empty.test.ts' ] || fail "(23) an empty test file was not named: $(ran_line)"
printf 'throw new Error("load error witness");\n' > "$fixture/runtime/bun/test/loaderror.test.ts"
rc=0
(cd "$fixture" && bash "$fixture/runtime/bun/test/run.sh" runtime/bun/test/loaderror.test.ts) > "$WORK/run.log" 2>&1 || rc=$?
[ "$rc" != 0 ] || fail '(24) a module-load error exited 0'
grep -q 'load error witness' "$WORK/run.log" || fail "(25) Bun's load-error output was lost"
[ "$(ran_line)" = 'run.sh: ran 1 file: runtime/bun/test/loaderror.test.ts' ] || fail "(26) a load-error file was not named: $(ran_line)"
printf 'export const = ;\n' > "$fixture/runtime/bun/test/syntax.test.ts"
(cd "$fixture" && bash "$fixture/runtime/bun/test/run.sh" runtime/bun/test/syntax.test.ts) > "$WORK/run.log" 2>&1 || true
[ "$(ran_line)" = 'run.sh: ran 1 file: runtime/bun/test/syntax.test.ts' ] || fail "(27) a syntax-error file was not named: $(ran_line)"
# Bun runs `*_test_*` names too, and a module a test imports is not a second entry even
# when its own name looks like a test: the receipt follows Bun's entries, not a name rule.
printf 'import { test } from "bun:test";\ntest("gamma", () => {});\n' > "$fixture/runtime/bun/test/gamma_test_more.ts"
printf 'export const value = 1;\n' > "$fixture/runtime/bun/test/helper.test.ts"
# The fixture's relative specifiers are spelled with $dot so the publish closure scan does not
# read them as this smoke's own module references.
dot=.
printf 'import { test, expect } from "bun:test";\nimport { value } from "%s/helper.test";\ntest("main", () => expect(value).toBe(1));\n' "$dot" > "$fixture/runtime/bun/test/main.test.ts"
(cd "$fixture" && bash "$fixture/runtime/bun/test/run.sh" runtime/bun/test/gamma_test_more.ts runtime/bun/test/main.test.ts) > "$WORK/run.log" 2>&1 || fail '(30) entry-vs-import run failed'
[ "$(ran_line | sed 's/^run.sh: ran 2 files: //' | tr ' ' '\n' | LC_ALL=C sort | tr '\n' ' ')" = 'runtime/bun/test/gamma_test_more.ts runtime/bun/test/main.test.ts ' ] \
  || fail "(31) an underscore-named entry was missed or an imported module counted: $(ran_line)"
# A caller's --preload onLoad transform must still apply: the disk source throws, the
# transformed source passes.
printf 'throw new Error("untransformed source was executed");\n' > "$fixture/runtime/bun/test/custom.test.ts"
cat > "$fixture/custom-preload.ts" <<'PRELOAD'
import { plugin } from "bun";
plugin({ name: "custom", setup(build) {
  build.onLoad({ filter: /custom[.]test[.]ts$/ }, () => ({ loader: "ts", contents: 'import { test } from "bun:test"; test("custom loader applied", () => {});' }));
}});
PRELOAD
(cd "$fixture" && bash "$fixture/runtime/bun/test/run.sh" runtime/bun/test/custom.test.ts --preload "$fixture/custom-preload.ts") > "$WORK/run.log" 2>&1 || fail '(32) a caller preload transform no longer applies'
grep -q 'custom loader applied' "$WORK/run.log" || fail '(33) the caller transform was bypassed'
[ "$(ran_line)" = 'run.sh: ran 1 file: runtime/bun/test/custom.test.ts' ] || fail "(34) caller-preload summary differs: $(ran_line)"
rm -f "${fixture:?}/runtime/bun/test/gamma_test_more.ts" "${fixture:?}/runtime/bun/test/helper.test.ts" "${fixture:?}/runtime/bun/test/main.test.ts" "${fixture:?}/runtime/bun/test/custom.test.ts" "${fixture:?}/custom-preload.ts"
# Preloads are not test files, whether the caller's --preload or a bunfig [test] preload.
printf 'export {};\n' > "$fixture/noop-preload.ts"
printf 'import { test } from "bun:test";\ntest("lone", () => {});\n' > "$fixture/runtime/bun/test/lone.test.ts"
(cd "$fixture" && bash "$fixture/runtime/bun/test/run.sh" runtime/bun/test/lone.test.ts --preload "$fixture/noop-preload.ts") > "$WORK/run.log" 2>&1 || fail '(35) caller-preload run failed'
[ "$(ran_line)" = 'run.sh: ran 1 file: runtime/bun/test/lone.test.ts' ] || fail "(36) a caller preload was counted as a test file: $(ran_line)"
printf '[test]\npreload = ["%s/noop-preload.ts"]\n' "$dot" > "$fixture/bunfig.toml"
(cd "$fixture" && bash "$fixture/runtime/bun/test/run.sh" runtime/bun/test/lone.test.ts) > "$WORK/run.log" 2>&1 || fail '(37) bunfig-preload run failed'
[ "$(ran_line)" = 'run.sh: ran 1 file: runtime/bun/test/lone.test.ts' ] || fail "(38) a bunfig preload was counted as a test file: $(ran_line)"
rm -f "${fixture:?}/bunfig.toml" "${fixture:?}/noop-preload.ts" "${fixture:?}/runtime/bun/test/lone.test.ts"
# Bun also recognizes the underscore spellings of the test suffix.
printf 'import { test } from "bun:test";\ntest("underscore", () => {});\n' > "$fixture/runtime/bun/test/under_test.ts"
(cd "$fixture" && bash "$fixture/runtime/bun/test/run.sh" runtime/bun/test/under_test.ts) > "$WORK/run.log" 2>&1 || fail '(28) underscore-suffix run failed'
[ "$(ran_line)" = 'run.sh: ran 1 file: runtime/bun/test/under_test.ts' ] || fail "(29) an underscore-suffix file was not named: $(ran_line)"
rm -f "${fixture:?}/runtime/bun/test/under_test.ts" "${fixture:?}/runtime/bun/test/empty.test.ts" "${fixture:?}/runtime/bun/test/loaderror.test.ts" "${fixture:?}/runtime/bun/test/syntax.test.ts"
echo 'bun-runner-discovery: files Bun opens without a testcase are still named, and a load error keeps its status: ok'
