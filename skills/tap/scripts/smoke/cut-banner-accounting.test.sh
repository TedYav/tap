#!/usr/bin/env bash
# cut-banner-accounting.test.sh — a shrink banner is a CLAIM, checked mechanically.
#
# tap-52ys. Four separate review findings in one PR were the same bug: a comment
# saying "N of M arms removed, these are the ones kept" while the file ran a
# different set. submit-verify claimed 8 and ran ~12 (grok); poll-mode listed
# three arms as kept that were deleted AND three as deleted that were running
# (sol); delivery-urgent named an arm it had removed (sol). Each was found by a
# human reading the file against its own banner.
#
# Humans should not be the mechanism. Every file carrying an "N of M arms
# removed" banner must PRINT at least as many `…: ok` lines as the banner says
# it kept. That is a floor, not an equality: a file may legitimately print more
# (setup receipts, sub-assertions), but printing FEWER means either the banner
# overstates what survived or the arms assert silently — and a silent arm is
# one nobody can audit without reading the whole file, which is how all four
# instances got in.
#
# Deliberately cheap: it parses the banner and counts printed arms.
#
# KNOWN LIMITATION, named rather than papered over (review): this
# is a FLOOR, so it catches UNDERSTATEMENT — a banner claiming more arms than
# the file reports, which is the silent-arm shape (instances five and six). It
# does NOT catch OVERSTATEMENT: the original finding was a banner claiming 8
# arms while the file ran ~12, and printed >= kept lets extras through.
# Equality would false-positive on setup receipts and sub-assertions, so the
# cheap check is the right trade — but the class is only HALF mechanized, and
# the other half still needs a person reading the file against its banner. Do
# not read a green here as "the banner is accurate."
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
SELF="$(basename "${BASH_SOURCE[0]}")"
fail() { echo "cut-banner-accounting: $*" >&2; exit 1; }

# Parse "N of M arms removed" out of a file's banner. Echoes "kept total" or
# nothing when the file carries no such claim.
banner_claim() { # <file>
  # `|| true`: no banner is the COMMON case (most files were never shrunk), and
  # under `set -o pipefail` grep's exit 1 would otherwise propagate out of the
  # command substitution and kill the caller. Same family as the `[ x ] &&`
  # trap below — both make "not found" fatal instead of ordinary.
  { grep -oE '[0-9]+ of [0-9]+ arms removed' "$1" 2>/dev/null || true; } | head -1 \
    | awk '{ print $3 - $1, $3 }'
}

checked=0
offenders=""
for f in "$ROOT"/skills/*/scripts/smoke/*.test.sh "$ROOT"/skills/*/scripts/regress/*.test.sh; do
  [ -f "$f" ] || continue
  # NB: `[ x ] && continue` is fatal under set -e when the test is FALSE (the
  # && chain's status becomes the loop body's). Use an if.
  if [ "$(basename "$f")" = "$SELF" ]; then continue; fi
  claim="$(banner_claim "$f")"
  [ -n "$claim" ] || continue
  kept="${claim% *}"
  checked=$((checked + 1))
  # Count the arms the file ADVERTISES by printing, not the ones it runs
  # silently: `echo "...: ok"` is the repo's arm-report idiom.
  printed="$(grep -cE '^\s*echo "[^"]*: ok"' "$f" || true)"
  # The file-level "name: ok" trailer is not an arm.
  printed=$((printed - 1))
  [ "$printed" -ge "$kept" ] || offenders="$offenders
  $(basename "$f"): banner says $kept arm(s) kept, file prints $printed"
done

[ "$checked" -gt 0 ] || fail "no cut banners found — the parser or the banner wording drifted"

if [ -n "$offenders" ]; then
  echo "cut-banner-accounting: banner overstates what the file reports:$offenders" >&2
  fail "each listed file must print one ': ok' line per kept arm (or correct its banner)"
fi
echo "cut-banner-accounting: (1) $checked cut banner(s) report at least as many arms as they claim: ok"

# Bidirectional: the check must RED on a banner that overstates. Without this,
# a parser that silently matches nothing would pass forever.
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/skills/tap/scripts/smoke"
cat >"$TMP/skills/tap/scripts/smoke/liar.test.sh" <<'LIAR'
#!/usr/bin/env bash
# ── tap-52ys: 1 of 4 arms removed ───
echo "liar: (1) first: ok"
echo "liar: ok"
LIAR
probe="$(
  cd "$TMP" || exit 1
  claim="$(grep -oE '[0-9]+ of [0-9]+ arms removed' skills/tap/scripts/smoke/liar.test.sh | head -1 | awk '{ print $3 - $1 }')"
  printed="$(grep -cE '^\s*echo "[^"]*: ok"' skills/tap/scripts/smoke/liar.test.sh)"
  printed=$((printed - 1))
  [ "$printed" -ge "$claim" ] && echo "ACCEPTED" || echo "REJECTED"
)"
[ "$probe" = "REJECTED" ] || fail "negative control: a banner claiming 3 kept arms with 1 printed was ACCEPTED"
echo "cut-banner-accounting: (2) negative control — a banner claiming more arms than it prints is REJECTED: ok"

echo "cut-banner-accounting: ok"
