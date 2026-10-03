#!/usr/bin/env bash
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
. "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"
INSTALL_SH="$ROOT/install.sh"
[ -f "$INSTALL_SH" ] || { echo "FAIL: $INSTALL_SH not found" >&2; exit 1; }

pass=0; fail=0
ok() { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }

echo "install-help-refusal-classes: every --sync refusal carries a class tag; every tag has a help clause"

refusals="$(grep -c 'REFUSED --sync' "$INSTALL_SH")"
refusals="${refusals:-0}"
if [ "$refusals" -ge 10 ]; then
  ok "refusal count is $refusals (>= 10): the tag scanner is pointed at something"
else
  bad "refusal count is '$refusals' (< 10) — not running the tag arms against an instrument that found nothing"
  echo "install-help-refusal-classes: $pass passed, $fail failed"
  exit 1
fi

code_tags="$(grep -oE 'REFUSED --sync — \[[a-z-]+\]' "$INSTALL_SH" | grep -oE '\[[a-z-]+\]' | sort -u)"

offenders="$(grep 'REFUSED --sync' "$INSTALL_SH" | grep -vE 'REFUSED --sync — \[[a-z-]+\]')"
if [ -z "$offenders" ]; then
  ok "every one of the $refusals refusal lines carries a [class] tag right after the em dash"
else
  bad "untagged --sync refusal lines — every REFUSED --sync line must match 'REFUSED --sync — [tag]':"
  printf '%s\n' "$offenders"
fi

help_out="$(bash "$INSTALL_SH" --help)"
if [ -n "$help_out" ]; then
  ok "--help prints (exits in the arg loop, before any check or write)"
else
  bad "--help printed nothing"
fi

tagged=0
while IFS= read -r tag; do
  [ -n "$tag" ] || continue
  tagged=$((tagged + 1))
  case "$help_out" in
    *"$tag"*) ok "help names $tag" ;;
    *) bad "help has no clause for code tag $tag" ;;
  esac
done <<EOF
$code_tags
EOF
if [ "$tagged" -eq 0 ]; then
  bad "code_tags is empty — no tagged refusals found (an earlier arm must already be red)"
fi

help_tags="$(printf '%s\n' "$help_out" | sed -n 's/^[[:space:]]*\[\([a-z-]\{1,\}\)\].*/\1/p')"
stale=""
while IFS= read -r t; do
  [ -n "$t" ] || continue
  printf '%s\n' "$code_tags" | grep -qxF "[$t]" || stale="$stale $t"
done <<EOF
$help_tags
EOF
if [ -z "$stale" ]; then
  ok "every [tag] clause in help names a tag that exists in code"
else
  bad "help clauses with no matching code tag (stale entries):$stale"
fi

echo "install-help-refusal-classes: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
