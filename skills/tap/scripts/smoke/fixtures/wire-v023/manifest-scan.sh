#!/usr/bin/env bash
# U0's manifest scan, committed as a runnable COMMAND rather than a bare regex.
#
# WHY a script and not just `manifest-regex.txt`: the regex names its own
# identifiers (tap_sentinel_render, SENTINEL_VERSION, ...) and this fixture lives
# UNDER one of the roots it scans, so a bare regex committed here matches itself.
# Every re-run after this commit would then return one more path than the last and
# read as drift. The exclusions below are part of the scan, not housekeeping —
# without them L6 plan step U0.5 ("re-run after each rebase; regenerate the list,
# never hand-curate it") is not mechanically re-runnable.
#
# Prints one repo-relative path per line, sorted. Run from the repo root.
#
#   bash skills/tap/scripts/smoke/fixtures/wire-v023/manifest-scan.sh
#
# The COMMITTED manifest.txt is the one produced at the branch's FINAL base; the
# PR body names that base. Re-run after each rebase (L1/L2/L3 all move it).
#
# To count a base WITHOUT checking it out, the equivalent is `git grep` — and its
# pathspec needs a trailing `/*` on the wildcard roots. A pathspec containing a
# wildcard is glob-matched against the WHOLE path, so `skills/*/scripts/smoke`
# matches no file at all (it silently returns only the runtime/bun/test hits, which
# prefix-match because that root is literal):
#
#   git grep -lE -f <regex> <rev> -- 'skills/*/scripts/smoke/*' \
#     'skills/*/scripts/regress/*' 'runtime/bun/test'
#
# That form reproduces 59 at ce6575fec / e493ac9e8, 66 at b59285d0b, 59 at 86d884778.
# It does NOT carry this script's self-exclusions, so subtract this fixture directory
# and any wire-v023*.test.sh by hand when comparing across a base that has them.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

roots=(skills/*/scripts/smoke skills/*/scripts/regress runtime/bun/test)

grep -rlE -f "${here}/manifest-regex.txt" "${roots[@]}" 2>/dev/null \
  | grep -v '/smoke/fixtures/wire-v023/' \
  | grep -v '/smoke/wire-v023[^/]*\.test\.sh$' \
  | LC_ALL=C sort
