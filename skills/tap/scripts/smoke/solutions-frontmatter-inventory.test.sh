#!/usr/bin/env bash
# focused-inventory: tree (tap-z5nl6)
# Every docs/solutions document carries `module`, `tags` and `problem_type` in
# its frontmatter, and nothing enforced it. A review caught one document missing
# `tags` — which is the shape that argues for a sweeper rather than against one:
# a single omission is invisible by inspection, it only surfaces when a reviewer
# happens to diff frontmatter, and "it was the only one" is true right up until
# it is not.
#
# The failure this prevents is quiet: tag-based discovery silently cannot
# classify the document, so the doc exists and is unfindable. Nothing reds, no
# tool errors, and the knowledge store degrades one file at a time.
#
# Scope is deliberately those three fields. This is an inventory, not a schema
# validator: it does not police tag vocabulary, because a check that rejects an
# unfamiliar-but-reasonable tag trains authors to fight it, and a guard that
# cries wolf gets waved off.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
DOCS="$ROOT/docs/solutions"
[ -d "$DOCS" ] || { echo "solutions-frontmatter-inventory: $DOCS missing" >&2; exit 1; }

REQUIRED="module tags problem_type"
total=0; bad=0
while IFS= read -r f; do
  case "${f##*/}" in INDEX.md|README.md) continue ;; esac
  total=$((total + 1))
  for key in $REQUIRED; do
    awk -v k="$key" '
      /^---[[:space:]]*$/ { n++; next }
      n == 1 && $0 ~ "^" k ":" { found = 1 }
      n == 2 { exit }
      END { exit found ? 0 : 1 }' "$f" && continue
    echo "solutions-frontmatter-inventory: ${f#"$ROOT/"} has no '$key:' in its frontmatter" >&2
    bad=$((bad + 1))
  done
done < <(find "$DOCS" -name '*.md' | sort)

# The sweep must be able to fail: an empty or near-empty corpus would pass
# vacuously and read as coverage. docs/solutions holds 16 documents. The
# floor sits under that, at 10, so one document can come or go without a false
# red, and an empty tree still fails.
[ "$total" -ge 10 ] || {
  echo "solutions-frontmatter-inventory: only $total documents swept — the corpus moved or the" >&2
  echo "  find expression stopped matching. A vacuous pass is not coverage." >&2
  exit 1; }

[ "$bad" -eq 0 ] || { echo "solutions-frontmatter-inventory: $bad missing field(s)" >&2; exit 1; }
echo "ok solutions-frontmatter-inventory: $total documents, all carry module/tags/problem_type"
