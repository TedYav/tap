#!/usr/bin/env bash
# focused-inventory: tree (tap-z5nl6)
# acting-registry-reader-enum.test.sh — mechanical guard for the
# early-return-on-legacy-TAP_REGISTRY / missing-rebind class (opus/fable wave 3).
#
# Every production .sh under skills/tap/scripts/ and hooks/ that *reads*
# $TAP_REGISTRY must either:
#   (a) call tap_require_acting_registry / tap_rebind_acting_registry /
#       tap_acting_registry in the same function before the first read, OR
#   (b) appear on the exemption list below with a non-empty reason string.
#
# Shape guard: an exemption entry without a reason fails this smoke — the
# allowlist is not an escape hatch (same polarity as session-root-gate-enum).
#
# Negative control (executed, tap-1p35): the WAVE 6.11 ambient-after-acting guard
# is a regex over source text, so the last section of this file injects the
# forbidden idiom into a scratch tree and requires the guard to go RED with the
# hit attributed as file:line. A guard whose regex quietly stopped matching
# would otherwise stay GREEN on the live tree forever.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$ROOT"

fail() { echo "acting-registry-reader-enum: $*" >&2; exit 1; }

# --scan-root/--scan-only exist for the negative control below: it re-enters this
# file against a scratch tree. The live run scans $ROOT and then runs the control.
SCAN_ONLY=0
SCAN_ROOT="$ROOT"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --scan-only) SCAN_ONLY=1 ;;
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

# file:function → reason (reason REQUIRED — empty fails shape guard)
# shellcheck disable=SC2034  # consumed by the python enumerator
EXEMPTIONS="$(cat <<'EOF'
skills/tap/scripts/smoke/*:*|fixture/smoke scripts — exercise the system under test; not production readers
skills/tap/scripts/regress/*:*|fixture/regress scripts — exercise the system under test; not production readers
EOF
)"

# Validate shape: every exemption line is path|reason with non-empty reason
while IFS= read -r line; do
  [ -n "$line" ] || continue
  case "$line" in
    '#'*) continue ;;
  esac
  case "$line" in
    *'|'*)
      reason="${line#*|}"
      [ -n "$reason" ] || fail "shape guard: exemption lacks reason: $line"
      ;;
    *) fail "shape guard: exemption must be file:func|reason: $line" ;;
  esac
done <<<"$EXEMPTIONS"

export ACTING_ENUM_EXEMPTIONS="$EXEMPTIONS"
python3 -B - "$SCAN_ROOT" <<'PY'
import os, re, sys
from pathlib import Path

root = Path(sys.argv[1])
fail = lambda msg: (_ for _ in ()).throw(SystemExit(f"acting-registry-reader-enum: {msg}"))

# Parse exemptions: file:func|reason  (func may be *)
exempt = {}  # (file, func) -> reason ; also (file, "*")
for line in os.environ["ACTING_ENUM_EXEMPTIONS"].splitlines():
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    if "|" not in line:
        fail(f"shape guard: exemption must be file:func|reason: {line}")
    key, reason = line.split("|", 1)
    if not reason.strip():
        fail(f"shape guard: exemption lacks reason: {line}")
    if ":" not in key:
        fail(f"shape guard: exemption key must be file:func: {line}")
    fpath, func = key.split(":", 1)
    exempt[(fpath, func)] = reason.strip()

RE_FUNC = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{")
RE_READ = re.compile(r"\$\{?TAP_REGISTRY\}?")
RE_ASSIGN = re.compile(r"^\s*TAP_REGISTRY=")
RE_CHOKE = re.compile(
    r"\b(tap_require_acting_registry|tap_rebind_acting_registry|tap_acting_registry)\b"
)
# Skip comment-only lines
RE_COMMENT = re.compile(r"^\s*(#|//)")

scan_roots = [
    root / "skills" / "tap" / "scripts",
    root / "hooks",
]
# Skip smoke/ and session/ python; only .sh production + hooks
files = []
for base in scan_roots:
    if not base.is_dir():
        continue
    for p in base.rglob("*.sh"):
        rel = str(p.relative_to(root))
        # tap-52ys: fixtures exercise the system in BOTH suite buckets.
        if "/smoke/" in rel.replace("\\", "/") or "/regress/" in rel.replace("\\", "/"):
            continue  # covered by smoke/* exemption; skip enumeration noise
        files.append(p)

unsanctioned = []

def is_exempt(rel: str, func: str) -> bool:
    if (rel, func) in exempt:
        return True
    if (rel, "*") in exempt:
        return True
    return False

for path in sorted(files):
    rel = str(path.relative_to(root)).replace("\\", "/")
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    # Top-level choke persists across helper-function definitions in linear
    # scripts (tap-register / tap-unregister): a rebind at line 289 still
    # covers later top-level reads after a helper function is *defined*.
    toplevel = {"name": "__toplevel__", "choke_line": None, "reads": []}
    current = toplevel
    brace_depth = 0
    in_func = False

    def flush(cur):
        if not cur["reads"]:
            cur["reads"] = []
            return
        name = cur["name"]
        if is_exempt(rel, name) or is_exempt(rel, "*"):
            cur["reads"] = []
            return
        first_read = cur["reads"][0][0]
        choke_before = cur.get("choke_line")
        # Top-level may inherit nothing; named functions must choke themselves
        # (file-level rebind does NOT cover cmd_restore — that was the bug).
        if name == "__toplevel__" and choke_before is not None and choke_before <= first_read:
            cur["reads"] = []
            return
        if name != "__toplevel__" and choke_before is not None and choke_before <= first_read:
            cur["reads"] = []
            return
        for lineno, snippet in cur["reads"]:
            unsanctioned.append((rel, name, lineno, snippet))
        cur["reads"] = []

    i = 0
    while i < len(lines):
        lineno = i + 1
        line = lines[i]
        m = RE_FUNC.match(line)
        if m and not in_func:
            flush(toplevel)
            current = {"name": m.group(1), "choke_line": None, "reads": []}
            in_func = True
            brace_depth = line.count("{") - line.count("}")
            i += 1
            # Handle one-line functions: foo() { ... }
            if in_func and brace_depth <= 0:
                if RE_CHOKE.search(line) and current["choke_line"] is None:
                    current["choke_line"] = lineno
                if RE_READ.search(line) and not RE_ASSIGN.match(line) and not RE_COMMENT.match(line):
                    current["reads"].append((lineno, line.strip()[:80]))
                flush(current)
                current = toplevel
                in_func = False
            continue
        if in_func:
            brace_depth += line.count("{") - line.count("}")
        if RE_COMMENT.match(line):
            i += 1
            if in_func and brace_depth <= 0:
                flush(current)
                current = toplevel
                in_func = False
            continue
        if RE_CHOKE.search(line):
            if current.get("choke_line") is None:
                current["choke_line"] = lineno
            # Also record top-level chokes when at top level
            if current is toplevel and toplevel["choke_line"] is None:
                toplevel["choke_line"] = lineno
        if RE_ASSIGN.match(line):
            i += 1
            if in_func and brace_depth <= 0:
                flush(current)
                current = toplevel
                in_func = False
            continue
        if RE_READ.search(line):
            current["reads"].append((lineno, line.strip()[:80]))
        if in_func and brace_depth <= 0:
            flush(current)
            current = toplevel
            in_func = False
        i += 1
    flush(toplevel if current is toplevel else current)
    if current is not toplevel:
        flush(toplevel)

if unsanctioned:
    print("acting-registry-reader-enum: UNSANCTIONED readers:", file=sys.stderr)
    for rel, name, lineno, snippet in unsanctioned:
        print(f"  {rel}:{name}:{lineno}: {snippet}", file=sys.stderr)
    fail(f"unsanctioned TAP_REGISTRY readers: {len(unsanctioned)}")

# WAVE 6.11: failed acting sample must NEVER be followed by ambient TAP_REGISTRY
# substitution (the class that let settlement authorize via a bus decoy).
# Matches:  reg="$(tap_acting_registry ... || true)" / then
#           [ -n "$reg" ] || reg="$TAP_REGISTRY"
RE_ACTING_ASSIGN = re.compile(
    r"""(?:^|\n)\s*(\w+)=\$\(\s*tap_acting_registry\b[^)]*\|\|\s*true\s*\)"""
)
RE_AMBIENT_FALLBACK = re.compile(
    r"""\[\s*-n\s+\"\$\{?(\w+)\}?\"\s*\]\s*\|\|\s*\1=\"\$TAP_REGISTRY\""""
)
ambient_hits = []
appendix_files = files
for path in appendix_files:
    if not path.is_file():
        continue
    text = path.read_text(encoding="utf-8", errors="replace")
    rel = str(path.relative_to(root)).replace("\\", "/")
    # Any line that assigns ambient after a non-empty check on a var that was
    # filled from tap_acting_registry || true in the same file.
    acting_vars = set()
    for m in RE_ACTING_ASSIGN.finditer(text):
        acting_vars.add(m.group(1))
    for i, line in enumerate(text.splitlines(), 1):
        if RE_COMMENT.match(line):
            continue
        m = RE_AMBIENT_FALLBACK.search(line)
        if m and m.group(1) in acting_vars:
            ambient_hits.append(f"{rel}:{i}: {line.strip()[:100]}")
        # Also catch the classic two-token form without capture reuse
        if re.search(r'\|\|\s*\w+=\"\$TAP_REGISTRY\"', line) and "tap_acting" not in line:
            # only flag if previous non-comment line was acting||true assign
            pass
    # Broader: any `|| <var>="$TAP_REGISTRY"` immediately after acting||true
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if "tap_acting_registry" in line and "||" in line and "true" in line:
            for j in range(i + 1, min(i + 4, len(lines))):
                nxt = lines[j]
                if RE_COMMENT.match(nxt):
                    continue
                if re.search(r'=\s*"\$TAP_REGISTRY"', nxt) and "||" in nxt:
                    ambient_hits.append(
                        f"{rel}:{j+1}: ambient fallback after acting||true — {nxt.strip()[:100]}"
                    )
                break

if ambient_hits:
    print("acting-registry-reader-enum: AMBIENT FALLBACK AFTER FAILED ACTING:", file=sys.stderr)
    for h in ambient_hits:
        print(f"  {h}", file=sys.stderr)
    fail(f"ambient TAP_REGISTRY substitution after failed acting sample: {len(ambient_hits)}")

print("acting-registry-reader-enum: 0 unsanctioned readers; exemptions shaped: ok")
print("acting-registry-reader-enum: 0 ambient-after-acting fallbacks; ok")
print("acting-registry-reader-enum: all checks passed")
PY

# The scratch re-entry stops here; only the live run executes the control.
if [ "$SCAN_ONLY" = 1 ]; then
  exit 0
fi

# --- Negative controls (executed, not claimed) --------------------------------
# The WAVE 6.11 guard has two independent detectors, and each control below is shaped
# to trip exactly one of them, so weakening either detector turns its own control
# GREEN (a failure here) instead of hiding behind the other:
#   file-wide: RE_ACTING_ASSIGN + RE_AMBIENT_FALLBACK, any distance apart in one file;
#              its hits print "file:line: <source line>".
#   nearby:    the line after an `tap_acting_registry ... || true` line reads
#              ="$TAP_REGISTRY" with `||`; its hits carry "ambient fallback after acting||true".
# Every fixture calls the acting chokepoint first, so the reader guard above is
# satisfied and only 6.11 can flag it.
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/acting-enum-control.XXXXXX")"
trap 'rm -rf "${SCRATCH:?}"' EXIT

# run_control <name> <expected-line-number> <hit-pattern-after-file:line:>; the fixture is stdin.
run_control() {
  local name="$1" want_line="$2" want_text="$3" tree="$SCRATCH/$1" out rc
  mkdir -p "$tree/skills/tap/scripts" "$tree/hooks"
  cat > "$tree/skills/tap/scripts/injected-$name.sh"
  set +e
  out="$(bash "$ROOT/skills/tap/scripts/smoke/acting-registry-reader-enum.test.sh" --scan-only --scan-root "$tree" 2>&1)"
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || fail "negative control $name: injected ambient fallback must exit non-zero; got: $out"
  grep -q 'AMBIENT FALLBACK AFTER FAILED ACTING' <<<"$out" \
    || fail "negative control $name: guard did not report the ambient fallback; got: $out"
  grep -q "skills/tap/scripts/injected-$name.sh:$want_line: $want_text" <<<"$out" \
    || fail "negative control $name: expected a hit at injected-$name.sh:$want_line matching '$want_text'; got: $out"
  echo "acting-registry-reader-enum: negative control $name RED at line $want_line: ok"
}

# file-wide only: RE_ACTING_ASSIGN needs the unquoted `reg=$(...)` form, and the intervening
# line takes the fallback out of the nearby window.
run_control filewide 5 '\[ -n "\$reg" \] || reg="\$TAP_REGISTRY"' <<'EOF'
#!/usr/bin/env bash
settle_far() {
  reg=$(tap_acting_registry || true)
  echo "sampled"
  [ -n "$reg" ] || reg="$TAP_REGISTRY"
}
EOF

# nearby only: the acting assignment is not at line start, so RE_ACTING_ASSIGN never
# collects the variable, while the next line still reads $TAP_REGISTRY after `||`.
run_control nearby 4 'ambient fallback after acting||true' <<'EOF'
#!/usr/bin/env bash
settle_near() {
  if true; then reg="$(tap_acting_registry || true)"; fi
  [ -n "${reg:-}" ] || reg="$TAP_REGISTRY"
}
EOF
