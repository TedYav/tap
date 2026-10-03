#!/usr/bin/env bash
# shell-seats-axis-enum.test.sh — mechanical guard for the post-flip
# agents-vs-seats class in the SHELL layer (Tip F / tap-3eb8).
#
# Seats only (C4b): no shell or python-in-shell under skills/tap/scripts, hooks/
# or scripts/ reads or writes an "agents" map. An old-format registry is refused
# as old_store, never read through a fallback. A raw agents access is RED unless
# it is on the exemption list with a non-empty reason; `"agents" in doc` (the
# predicate's membership test) is not an access.
#
# Writer rule (shell analogue of seat_store-not-_seat_map): assigning
# reg["agents"] = … or mutating via a map obtained only from get("agents")
# is RED — that invents agents beside a seats-only document.
#
# Bidirectional: live raw sites RED; point one writer at raw agents → RED;
# both fixed → GREEN. Shape guard: exemption without reason fails.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$ROOT"

fail() { echo "shell-seats-axis-enum: $*" >&2; exit 1; }

SCAN_ONLY=0
SHAPE_OVERRIDE=0
SCAN_ROOT="$ROOT"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --scan-only) SCAN_ONLY=1 ;;
    --shape-override) SHAPE_OVERRIDE=1 ;;
    --scan-root)
      shift
      [ -n "${1:-}" ] || fail "--scan-root requires a directory"
      SCAN_ROOT="$1"
      ;;
    *) fail "unknown arg: $1" ;;
  esac
  shift
done
[ -d "$SCAN_ROOT" ] || fail "scan root is not a directory: $SCAN_ROOT"

# file:lineno|reason  OR  file:*|reason
EXEMPTIONS="$(cat <<'EOF'
skills/tap/scripts/smoke/*:*|fixture/smoke scripts — exercise the system under test
skills/tap/scripts/regress/*:*|fixture/regress scripts — exercise the system under test
scripts/smoke-all.sh:*|runner fixture-identity snapshot — reads test fixtures, which deliberately include old shapes
EOF
)"
if [ "$SHAPE_OVERRIDE" = 1 ] && [ -n "${SHELL_SEATS_ENUM_EXEMPTIONS_OVERRIDE:-}" ]; then
  EXEMPTIONS="$SHELL_SEATS_ENUM_EXEMPTIONS_OVERRIDE"
fi

while IFS= read -r line; do
  [ -n "$line" ] || continue
  case "$line" in '#'*) continue ;; esac
  case "$line" in
    *'|'*)
      reason="${line#*|}"
      [ -n "$reason" ] || fail "shape guard: exemption lacks reason: $line"
      ;;
    *) fail "shape guard: exemption must be file:lineno|reason: $line" ;;
  esac
done <<<"$EXEMPTIONS"

export SHELL_SEATS_ENUM_EXEMPTIONS="$EXEMPTIONS"
python3 -B - "$SCAN_ROOT" <<'PY'
import os
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
fail = lambda msg: (_ for _ in ()).throw(SystemExit(f"shell-seats-axis-enum: {msg}"))

exempt_files_star = set()
exempt_lines = set()  # (rel, lineno)
for line in os.environ["SHELL_SEATS_ENUM_EXEMPTIONS"].splitlines():
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    key, reason = line.split("|", 1)
    if not reason.strip():
        fail(f"shape guard: exemption lacks reason: {line}")
    if ":" not in key:
        fail(f"shape guard: exemption key must be file:lineno: {line}")
    fpath, loc = key.split(":", 1)
    if loc == "*":
        exempt_files_star.add(fpath)
    else:
        try:
            exempt_lines.add((fpath, int(loc)))
        except ValueError:
            fail(f"shape guard: lineno must be int or *: {line}")

# Raw agents access (python-in-shell and rare bash)
RE_RAW = re.compile(
    r"""(?:\[["']agents["']\]|\.get\(\s*["']agents["']|\.setdefault\(\s*["']agents["'])"""
)
# Writer that forces the agents key (always RED unless exempt)
RE_WRITE_AGENTS = re.compile(
    r"""\[["']agents["']\]\s*="""
)

unsanctioned = []
raw_writers = []


def is_exempt(rel: str, lineno: int) -> bool:
    norm = rel.replace("\\", "/")
    # tap-52ys: fixtures are exempt because they EXERCISE the system, and that
    # is true of both suite directories. Keying the exemption on "/smoke/"
    # alone made a file's sanction depend on which bucket it sits in, so
    # moving a fixture to regress/ silently un-sanctioned it.
    if "/smoke/" in norm or "/regress/" in norm:
        return True
    if (norm, lineno) in exempt_lines:
        return True
    for fp in exempt_files_star:
        if fp.endswith("/*"):
            prefix = fp[:-1]
            if norm.startswith(prefix.rstrip("*")):
                return True
        elif norm == fp:
            return True
    return False


bases = [root / "skills" / "tap" / "scripts", root / "hooks", root / "scripts"]
for path in sorted({p for base in bases if base.is_dir() for p in base.rglob("*.sh")}):
    rel = str(path.relative_to(root)).replace("\\", "/")
    if "/smoke/" in rel or "/regress/" in rel:
        continue
    text = path.read_text(encoding="utf-8")
    for lineno, raw in enumerate(text.splitlines(), 1):
        stripped = raw.strip()
        if stripped.startswith("#"):
            continue
        if not RE_RAW.search(raw):
            continue
        if is_exempt(rel, lineno):
            continue
        kind = "write" if RE_WRITE_AGENTS.search(raw) else "raw"
        entry = (rel, lineno, kind, stripped[:120])
        if kind == "write":
            raw_writers.append(entry)
        unsanctioned.append(entry)

if unsanctioned:
    print("shell-seats-axis-enum: UNSANCTIONED raw agents accesses:", file=sys.stderr)
    for rel, lineno, kind, snippet in unsanctioned:
        print(f"  {rel}:{lineno}: [{kind}] {snippet}", file=sys.stderr)

n = len(unsanctioned)
nw = len(raw_writers)
if n:
    fail(f"{n} finding(s) — raw={n} writers={nw}")

print("shell-seats-axis-enum: 0 unsanctioned; seats-only held: ok")
print("shell-seats-axis-enum: all checks passed")
PY

# Nested mutation probes use --scan-only so they do not re-enter this block.
if [ "$SCAN_ONLY" = 1 ]; then
  exit 0
fi

# --- Bidirectional negative controls (executed, not claimed) -------------------
# The team writer corpus retired with tap-team.sh; retain the exemption guard.
# 2) Empty exemption reason → shape-guard RED
set +e
shape_out="$(
  SHELL_SEATS_ENUM_EXEMPTIONS_OVERRIDE="$(cat <<'EOF'
skills/tap/scripts/smoke/runtime-helpers.sh:1|
skills/tap/scripts/smoke/*:*|fixture/smoke scripts — exercise the system under test
skills/tap/scripts/regress/*:*|fixture/regress scripts — exercise the system under test
EOF
)" bash "$ROOT/skills/tap/scripts/smoke/shell-seats-axis-enum.test.sh" --scan-only --shape-override 2>&1
)"
shape_rc=$?
set -e
grep -q 'shape guard: exemption lacks reason' <<<"$shape_out" \
  || fail "negative control: empty exemption reason must shape-guard RED; got: $shape_out"
[ "$shape_rc" -ne 0 ] || fail "negative control: empty exemption reason must exit non-zero"
echo "shell-seats-axis-enum: negative control empty-exemption-reason RED: ok"

echo "shell-seats-axis-enum: bidirectional controls held: ok"
