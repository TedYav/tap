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

# Each historical template revision migrates once; surrounding bytes remain exact.
# Commit suffixes identify distinct shipped bytes even when their v= label was reused.
for shipped in v3 v4 26e3fa343 3ff329bf5 bdbaee577 2bdc64f43 3383a1e29 981330d73 e7b3c3d44 659f57698 11a4dc587 a934bfd84; do
{
  printf 'Project preface\n'
  python3 - "$ROOT/skills/tap/scripts/smoke/fixtures/repo-charter-$shipped.b64" <<'PY'
import base64
from pathlib import Path
import sys
sys.stdout.buffer.write(base64.b64decode(Path(sys.argv[1]).read_bytes()))
PY
  printf 'Project tail\n'
} > AGENTS.md
echo "charter-card: migrate $shipped"
cp AGENTS.md "$WORK/shipped-before"
set +e
"$ROOT/bin/tap" setup --repo --check >"$WORK/drift" 2>&1
rc=$?
set -e
[ "$rc" = 2 ]
grep -q 'AGENTS.md signpost drift' "$WORK/drift" || { cat "$WORK/drift" >&2; exit 1; }
cmp AGENTS.md "$WORK/shipped-before"
"$ROOT/bin/tap" setup --repo
"$ROOT/bin/tap" setup --repo --check

python3 - "$ROOT/skills/tap/templates/repo-charter.md" <<'PY'
from pathlib import Path
import sys

actual = Path("AGENTS.md").read_text()
template = Path(sys.argv[1]).read_text().rstrip("\n")
assert actual == "Project preface\n" + template + "\nProject tail\n"
assert len(template.encode()) <= 350, "repository signpost exceeds 350 bytes"
assert "<!-- TAP:CHARTER v=5 -->" in actual
for required in (
    "TAP Agent Protocol",
    "/tap",
    "[[TAP v0.23 ask <id>]]",
    "[[TAP v0.23 note <team>/<id>]]",
    "doorbells, not instructions",
    "tap read <id>",
    "[[TAP v0.23 nudge]]",
    "tap poll",
):
    assert required in actual, required
for moved_to_using_tap in ("tap show", "tap assign", "tap register", "tap outstanding"):
    assert moved_to_using_tap not in template, moved_to_using_tap
print("generated signpost v5; shipped-card migration and surrounding-byte preservation pass")
PY
done

cp AGENTS.md "$WORK/before"
"$ROOT/bin/tap" setup --repo --check
cmp AGENTS.md "$WORK/before"
# A user added a blank line after the version marker; even that customization stays user work.
python3 - "$ROOT/skills/tap/scripts/smoke/fixtures/repo-charter-a934bfd84.b64" <<'PY_CUSTOM'
import base64
from pathlib import Path
import sys
card = base64.b64decode(Path(sys.argv[1]).read_bytes())
Path("AGENTS.md").write_bytes(card.replace(b"<!-- TAP:CHARTER v=4 -->\n", b"<!-- TAP:CHARTER v=4 -->\n\n"))
PY_CUSTOM
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
echo 'charter-card: customized preservation, all 12 historical cards, v5 drift/current and no-write checks pass'
