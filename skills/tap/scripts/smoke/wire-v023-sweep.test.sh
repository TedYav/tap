#!/usr/bin/env bash
# focused-inventory: tree (tap-z5nl6)
# wire-v023-sweep.test.sh — the two mechanical guards on the v0.23 conversion.
#
# The conversion itself is 15 files of judgment. These are the parts a human audit
# gets wrong, and this file exists because mine did: a hand-read of the manifest
# missed `regress/machine-index` and `regress/xwt-addressing`, which a reviewer
# found only after naming one instance in a third file. Two controls:
#
#   (1) COUNT/TAG — every path the scan finds carries a class and a reason, and the
#       committed manifest matches what the scan returns on this tree. A rebase that
#       adds a file adds an untagged row and reds here.
#   (2) RESIDUAL — no `[[TAP`-bearing line anywhere in the suites carries a retired
#       wire token, except in files the allowlist names WITH a reason.
#
# The residual scan covers `from=`/`to=` as well as `v=`, `reply=`, `kind=` and
# `urgency=`. The L6 plan's version omitted the route keys, and that same omission
# kept two files with live v0.22 assertions out of U0's manifest entirely — a
# control blind to half the retired grammar is not a control.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
FIX="$ROOT/skills/tap/scripts/smoke/fixtures/wire-v023"
cd "$ROOT"

fail() { echo "wire-v023-sweep: $*" >&2; exit 1; }

for f in manifest.txt manifest-scan.sh manifest-regex.txt residual-regex.txt allowlist.txt; do
  [ -f "$FIX/$f" ] || fail "fixture $f is missing — the controls cannot run without their inputs"
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/wire-sweep.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# --- (1) the manifest is current, and every row is classified -----------------
# Rows for files the export manifest denies live in manifest.private.txt, an
# overlay loaded when present that never ships: the public candidate scans a
# tree without those paths, and its committed manifest must match that tree.
LISTS=("$FIX/manifest.txt")
if [ -f "$FIX/manifest.private.txt" ]; then LISTS+=("$FIX/manifest.private.txt"); fi
bash "$FIX/manifest-scan.sh" > "$WORK/scanned.txt"
awk -F'\t' '/^[^#]/ && NF {print $1}' "${LISTS[@]}" | LC_ALL=C sort > "$WORK/listed.txt"

if ! diff -u "$WORK/listed.txt" "$WORK/scanned.txt" > "$WORK/mdiff" 2>&1; then
  echo "wire-v023-sweep: (1) the committed manifest does not match this tree." >&2
  echo "  A path only in the SCAN is untagged work: add it with a class and a reason." >&2
  echo "  A path only in the MANIFEST is usually fine — a fully converted file stops" >&2
  echo "  mentioning the old grammar and leaves the scan — but say so by removing the row." >&2
  cat "$WORK/mdiff" >&2
  exit 1
fi

# Every row carries all three columns. A row that lost its reason is the decay this
# control exists to catch: the path column regenerates, the curated columns do not.
awk -F'\t' '/^[^#]/ && NF {
  if (NF < 3 || $2 == "" || $3 == "") { print "  row without class or reason: " $0 > "/dev/stderr"; bad = 1 }
  else if ($2 != "A" && $2 != "B" && $2 != "C") { print "  row with unknown class \x27" $2 "\x27: " $1 > "/dev/stderr"; bad = 1 }
} END { exit bad ? 1 : 0 }' "${LISTS[@]}" \
  || fail "(1) the manifest has rows missing a class or a reason (above)"

echo "wire-v023-sweep: (1) manifest matches the tree and every row is classified: ok"

# --- (2) no retired wire token survives outside the allowlist -----------------
# The `[[TAP` filter is what makes this about the WIRE: `reply=expected` in ordinary
# prose is not a sentinel, and flagging it would train the reader to add exemptions.
# IT MATCHES AN ESCAPED BRACKET TOO, AND THAT IS THE WHOLE POINT OF THE PATTERN.
# A test asserting a sentinel almost always writes it as a REGEX, so on disk the
# bytes are backslash, bracket, backslash, bracket. A plain `grep` for two ADJACENT
# literal brackets is defeated by the separating backslash -- so the exact lines
# this control exists to catch were the ones it silently dropped. My own M6 mutant
# used UNESCAPED brackets and passed for the wrong reason; the wire reviewer
# re-ran it with a realistic escaped assertion and the control went green with live
# v0.22 bytes sitting in the tree. A mutation that agrees with you because it is
# unrealistic is worse than no mutation.
#
# The pattern accepts each bracket bare or backslash-escaped, so it reads both the
# literal sentinel in a captured fixture and the escaped one in an assertion.
#
#
# THIS FILE EXCLUDES ITSELF, for the same reason manifest-scan.sh does: the comments
# above quote the retired tokens in order to explain what is being swept, so a
# control that scanned itself would flag itself forever. It caught itself on its
# first run. The exclusion is the file, not the directory — a future sibling under
# smoke/ gets no free pass.
#
# The root is all of `skills/`, not just its smoke/ and regress/ suites. The spec —
# CONTRACT.md, the protocol/ pages, SKILL.md and its references — is the wire's
# definition, and a sweep that read only the test corpus let a v0.22 illustration
# survive in CONTRACT.md (tap-s0lj5).
grep -rnE -f "$FIX/residual-regex.txt" \
    skills runtime/bun/test 2>/dev/null \
  | grep -E '(\[|\\\[){2}TAP' \
  | grep -v '/smoke/fixtures/wire-v023/' \
  | grep -v '/smoke/wire-v023-sweep\.test\.sh:' \
  | awk -F: '{print $1}' | LC_ALL=C sort -u > "$WORK/residual.txt" || true

# The allowlist has the same private overlay as the manifest, for the same reason:
# exemptions for denied files cannot live in the shipped list, where the public
# candidate would read them as outliving their file.
ALLOWLISTS=("$FIX/allowlist.txt")
if [ -f "$FIX/allowlist.private.txt" ]; then ALLOWLISTS+=("$FIX/allowlist.private.txt"); fi
awk -F'\t' '/^[^#]/ && NF {print $1}' "${ALLOWLISTS[@]}" | LC_ALL=C sort > "$WORK/allowed.txt"

if ! diff -u "$WORK/allowed.txt" "$WORK/residual.txt" > "$WORK/rdiff" 2>&1; then
  echo "wire-v023-sweep: (2) the residual set does not equal the allowlist." >&2
  echo "  Only in RESIDUAL: a file grew a pre-0.23 sentinel token. Convert it, or add" >&2
  echo "  it to allowlist.txt WITH THE REASON the old bytes are the point." >&2
  echo "  Only in ALLOWLIST: an exemption outlived its file. Remove the row — a stale" >&2
  echo "  exemption is how a real one stops being read." >&2
  cat "$WORK/rdiff" >&2
  exit 1
fi

# An allowlist row without a reason is a silencer wearing a decision's clothes.
awk -F'\t' '/^[^#]/ && NF {
  if (NF < 2 || $2 == "") { print "  exemption without a reason: " $1 > "/dev/stderr"; bad = 1 }
} END { exit bad ? 1 : 0 }' "${ALLOWLISTS[@]}" \
  || fail "(2) the allowlist has exemptions with no stated reason (above)"

echo "wire-v023-sweep: (2) every surviving pre-0.23 sentinel token is allowlisted with a reason: ok"
echo "wire-v023-sweep: ok"
