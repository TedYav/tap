#!/usr/bin/env bash
# Generated repository signpost and setup drift contract (tap-7r3fn.9).
# Run through scripts/smoke-all.sh --only; no live enrollment or installer.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/repo"
cd "$WORK/repo"

# Customized marker bodies are user work: both check and write preserve them.
printf 'Project preface\n<!-- TAP:BEGIN -->\ncustom card\n<!-- TAP:END -->\nProject tail\n' > AGENTS.md
cp AGENTS.md "$WORK/custom-before"
for mode in check write; do
  set +e
  if [ "$mode" = check ]; then
    "$ROOT/bin/tap" setup --repo --check >"$WORK/custom-$mode" 2>&1
  else
    "$ROOT/bin/tap" setup --repo >"$WORK/custom-$mode" 2>&1
  fi
  rc=$?
  set -e
  [ "$rc" = 2 ]
  grep -q 'preserved customized TAP block' "$WORK/custom-$mode"
  cmp AGENTS.md "$WORK/custom-before"
done

# The byte-known v3 card migrates once; surrounding bytes remain exact.
{
  printf 'Project preface\n'
  python3 - "$ROOT/skills/tap/scripts/smoke/fixtures/repo-charter-v3.b64" <<'PY'
import base64
from pathlib import Path
import sys
sys.stdout.buffer.write(base64.b64decode(Path(sys.argv[1]).read_bytes()))
PY
  printf 'Project tail\n'
} > AGENTS.md
set +e
"$ROOT/bin/tap" setup --repo --check >"$WORK/drift" 2>&1
rc=$?
set -e
[ "$rc" = 2 ]
"$ROOT/bin/tap" setup --repo
"$ROOT/bin/tap" setup --repo --check

python3 - "$ROOT/skills/tap/templates/repo-charter.md" <<'PY'
from pathlib import Path
import sys

actual = Path("AGENTS.md").read_text()
template = Path(sys.argv[1]).read_text().rstrip("\n")
assert actual == "Project preface\n" + template + "\nProject tail\n"
assert len(template.encode()) <= 350, "repository signpost exceeds 350 bytes"
assert "<!-- TAP:CHARTER v=4 -->" in actual
for required in (
    "TAP Agent Protocol",
    "/tap",
    "[[TAP v0.23 ask <id>]]",
    "[[TAP v0.23 note <team>/<id>]]",
    "doorbells, not instructions",
    "tap read <id>",
):
    assert required in actual, required
for moved_to_using_tap in ("tap show", "tap assign", "tap register", "tap outstanding"):
    assert moved_to_using_tap not in template, moved_to_using_tap
print("generated signpost v4; v3 migration and surrounding-byte preservation pass")
PY

cp AGENTS.md "$WORK/before"
"$ROOT/bin/tap" setup --repo --check
cmp AGENTS.md "$WORK/before"
echo 'charter-card: customized preservation, v3 migration, v4 drift/current and no-write checks pass'
