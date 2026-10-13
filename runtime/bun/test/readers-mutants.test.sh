#!/usr/bin/env bash
# Run only through the isolated smoke runner. Each mutant must fail its named
# end-effect assertion, not fail to load or silently exercise the Bash door.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tap-readers-mutants.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/runtime/bun" "$WORK/scripts"
cp -R "$ROOT/runtime/bun/src" "$ROOT/runtime/bun/test" "$WORK/runtime/bun/"
cp "$ROOT/runtime/bun/main.ts" "$ROOT/runtime/bun/package.json" "$WORK/runtime/bun/"
cp "$ROOT/scripts/ignored-state-tripwire.py" "$WORK/scripts/ignored-state-tripwire.py"
# Helpers are copied too: the shared-resolver mutant must never follow a
# symlink back into the author checkout.
cp -R "$ROOT/skills" "$WORK/skills"
mutant() {
  local label="$1" source="$2" test_file="$3" pattern="$4" from="$5" to="$6" rc=0
  cp "$WORK/$source" "$WORK/original"
  python3 - "$WORK/$source" "$from" "$to" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); s=p.read_text()
assert s.count(sys.argv[2]) == 1, 'mutation anchor is missing or ambiguous'
p.write_text(s.replace(sys.argv[2],sys.argv[3]))
PY
  bash "$WORK/runtime/bun/test/run.sh" "$WORK/runtime/bun/test/$test_file" --test-name-pattern "$pattern" > "$WORK/$label.log" 2>&1 || rc=$?
  cp "$WORK/original" "$WORK/$source"
  [ "$rc" -ne 0 ] || { echo "reader mutant survived: $label" >&2; exit 1; }
  grep -F "(fail) $pattern" "$WORK/$label.log" >/dev/null || { cat "$WORK/$label.log"; echo "reader mutant did not reach named assertion: $label" >&2; exit 1; }
  echo "reader mutant rejected: $label (exit $rc; $pattern)"
}
mutant note-discharge runtime/bun/src/verbs/read.ts read-native.test.ts \
  'read note discharges once via read; repeated read preserves first receipt' \
  ': firstObservation(target,fields);' \
  ': false;'
mutant ambiguity runtime/bun/src/payload-view.ts show-native.test.ts \
  'show suffix ambiguity refuses and names both logical ids even across residencies' \
  'if (result.status === "ambiguous")' 'if (false)'
mutant attempt-proof runtime/bun/src/slices/outstanding.ts outstanding-native.test.ts \
  'spool delivery uncertainty, digest state and display snapshot' \
  ' rings it again under the same id.' '.'

mutant show-write runtime/bun/src/verbs/show.ts show-native.test.ts \
  "show displays full envelope and receipt chain without settling another seat's note" \
  'process.stdout.write(renderShow' 'ctx.bus.ensureDirs(); process.stdout.write(renderShow'

mutant spool-resolution runtime/bun/src/payload-view.ts show-native.test.ts \
  "show resolves a queued pair and its metadata without changing any file" \
  'this.includeSpool = mode === "show" || mode === "read-recipient";' \
  'this.includeSpool = false;'

# tap-4b7ib preserved-property control: kill the boundary refusal and the
# read-recipient door re-opens onto raw queue bytes.
mutant spool-address-boundary runtime/bun/src/payload-view.ts payload-resolver.test.ts \
  'read refuses a direct spool address at the boundary; a canonical pointer still follows the id' \
  'basename(parent) === "spool" && this.mode === "read-recipient"' \
  'false && basename(parent) === "spool" && this.mode === "read-recipient"'
