#!/usr/bin/env bash
# focused-inventory: tree (tap-z5nl6)
# tap-o4ae: fixture env must stay in this process. Refuse `source` so an
# interactive shell cannot inherit top-level exports. Must run BEFORE any
# `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# pipe-to-nonreader-inventory.test.sh — no smoke may pipe output into a command
# that does not read its stdin (tap-ioyl).
#
# THE DEFECT THIS PREVENTS. `printf '%s\n' "$out" | true` sat in
# reset-fence-mutation-barrier.test.sh for months. `true` exits immediately
# without reading, so printf and true RACE: when true reaps and closes the read
# end before printf's write lands, printf takes SIGPIPE and exits 141. Under the
# suite-standard `set -euo pipefail` that becomes the whole FILE's exit status —
# after every assertion in it has already passed. A merge gate on an unrelated
# branch goes red, and the failing file's own output says ": ok" on every line.
#
# Measured rate on an EMPTY payload (bash 3.2, macOS): 182/4000 = 4.5%.
# Payload SIZE is irrelevant — this is not the 64KiB pipe-buffer case. The write
# does not need to fill a buffer, only to arrive after the reader is gone. The
# same loop with `>/dev/null` instead of `| true`: 0/4000.
#
# WHY THIS IS A SHAPE CHECK AND NOT A BEHAVIORAL ONE. At ~4.5%, a regression that
# RUNS the offending construct passes 95% of the time — a single-run behavioral
# test would be a placebo that reports green while the defect is fully present.
# Repeating it enough times to be reliable costs seconds of suite time for a
# probabilistic verdict. Grepping for the SHAPE is deterministic, instant, and
# fails on the construct's existence rather than on its mood.
#
# WHAT COUNTS. Only a pipe INTO a non-reading command. `cmd || true` is
# unrelated and extremely common (error suppression, no pipe, no race) and must
# never be flagged — the distinction is `|` versus `||`, which is exactly the
# kind of near-miss a hand-written grep gets wrong, so the negative case is
# asserted below.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
PY="${TAP_PYTHON:-python3}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "pipe-to-nonreader-inventory: $*" >&2; exit 1; }

# Commands that exit without consuming stdin. `:` is the shell no-op, and both
# `true` and `false` are equivalent here — the race is about the reader closing,
# not about its exit status.
scan() {
  local check_root="$1"
  "$PY" -B - "$check_root" <<'PY'
from __future__ import annotations

import re
import sys
from pathlib import Path

root = Path(sys.argv[1])

# A pipe (exactly one |, not the || operator) into a non-reading builtin that
# ends the command. Leading (?<!\|) rejects `cmd || true`; the trailing group
# allows a comment or line end so `| true  # why` is still caught.
PATTERN = re.compile(r"(?<!\|)\|\s*(?:true|false|:)\s*(?:#.*)?$")

# This checker documents the hazard it detects and builds fixtures containing
# it, so a naive line scan flags its own prose and its own quoted test data.
# Skipping the file entirely would leave the checker unpoliced, so instead
# discard lines that are not executable shell: a `#` comment, or a line where
# the construct sits inside quotes (fixture data, e.g. `'echo hi | true' \`).
# Anything genuinely executable still counts, including in this file.
def is_executable_shell(line: str) -> bool:
    stripped = line.lstrip()
    if stripped.startswith("#"):
        return False
    # Quoted-data line: the match is inside a '...' or "..." literal.
    before = line[: PATTERN.search(line).start()]
    return before.count("'") % 2 == 0 and before.count('"') % 2 == 0

smokes = sorted(root.glob("skills/*/scripts/smoke/*.test.sh")) + sorted(
    root.glob("skills/*/scripts/regress/*.test.sh")
)  # tap-52ys: SIGPIPE false-reds are not a merge-gate-only defect
if not smokes:
    raise SystemExit(
        "pipe-to-nonreader-inventory: no skills/*/scripts/{smoke,regress}/*.test.sh files found"
    )

hits: list[str] = []
for smoke in smokes:
    for n, line in enumerate(
        smoke.read_text(encoding="utf-8", errors="replace").splitlines(), 1
    ):
        if PATTERN.search(line) and is_executable_shell(line):
            hits.append(f"{smoke.relative_to(root).as_posix()}:{n}: {line.strip()}")

if hits:
    print(
        "pipe-to-nonreader-inventory: piping into a command that does not read "
        "stdin races with SIGPIPE (tap-ioyl); use >/dev/null, or drop the line:",
        file=sys.stderr,
    )
    for h in hits:
        print(f"  {h}", file=sys.stderr)
    raise SystemExit(1)

print(f"pipe-to-nonreader-inventory: ok — {len(smokes)} smoke file(s) clean")
PY
}

# (1) The real suite is clean.
scan "$ROOT" || fail "(1) the live suite contains a pipe-to-non-reader"
echo "pipe-to-nonreader-inventory: (1) live suite is clean: ok"

# (2) MUTATION BAR — the check must FIRE on the exact construct that shipped.
# A checker built after the fix is tuned to pass; this proves it goes red on the
# real defect, reproduced verbatim from reset-fence-mutation-barrier.test.sh:552.
FIXTURE="$WORK/fixture"
mkdir -p "$FIXTURE/skills/tap/scripts/smoke"
# The offending construct is ASSEMBLED rather than written literally. A heredoc
# body is inert data to the shell but ordinary text to a line scanner, so a
# literal copy here would make this file its own first hit. Composing it from
# parts keeps the fixture exact while leaving this file honestly clean — the
# scanner is not special-cased, it simply has nothing to find.
_PIPE='|'
{
  printf '%s\n' 'out="something"'
  printf "%s %s true\\n" "printf '%s\\\\n' \"\$out\"" "$_PIPE"
} > "$FIXTURE/skills/tap/scripts/smoke/offender.test.sh"
grep -q "| true" "$FIXTURE/skills/tap/scripts/smoke/offender.test.sh" \
  || fail "(2) fixture assembly failed — the offending construct was not written"
mutation_out=""
if mutation_out="$(scan "$FIXTURE" 2>&1)"; then
  fail "(2) the check accepted the exact construct from tap-ioyl"
fi
case "$mutation_out" in
  *"offender.test.sh:2"*) ;;
  *) fail "(2) the check fired but did not name the offending line: $mutation_out" ;;
esac
echo "pipe-to-nonreader-inventory: (2) fires on the real tap-ioyl construct, naming file:line: ok"

# (3) Variants of the same hazard are caught, not just the one that shipped.
for variant in \
  'echo hi | true  # trailing comment' \
  'printf x | false' \
  'cat f | :' \
; do
  printf '%s\n' "$variant" > "$FIXTURE/skills/tap/scripts/smoke/offender.test.sh"
  if scan "$FIXTURE" >/dev/null 2>&1; then
    fail "(3) missed a pipe-to-non-reader variant: $variant"
  fi
done
echo "pipe-to-nonreader-inventory: (3) catches true/false/: and trailing comments: ok"

# (4) NEGATIVE CASE — `||` must never be flagged. This is the near-miss that
# makes or breaks the check: `cmd || true` appears all over the suite and is
# harmless (no pipe, no reader, no race). A checker that flags it would be
# unusable, and one that only ever ran against clean input would never notice.
cat > "$FIXTURE/skills/tap/scripts/smoke/offender.test.sh" <<'CLEAN'
rm -rf "$WORK" || true
wait "$_PID" || true
out="$(cat "$f" 2>/dev/null || true)"
printf '%s\n' "$out" >/dev/null
grep -q x "$f" || false
CLEAN
scan "$FIXTURE" >/dev/null 2>&1 \
  || fail "(4) the check flagged '|| true' / '>/dev/null' — it must not"
echo "pipe-to-nonreader-inventory: (4) '|| true' and '>/dev/null' are not flagged: ok"

echo "pipe-to-nonreader-inventory: ok"
