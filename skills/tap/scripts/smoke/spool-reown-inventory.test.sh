#!/usr/bin/env bash
# focused-inventory: tree (tap-z5nl6)
# D5: source-read — :80-90: grep-reads module source for invariants; no module behavior is exec'd or asserted
# spool-reown-inventory.test.sh — tap-w4f7 Arch 1: every production path that puts
# a body back into `spool/` residency must give that entry an owner.
#
# THIS FILE IS WHY PER-ENTRY OWNERSHIP IS A COMPLETABLE INVARIANT RATHER THAN AN
# UNFALSIFIABLE ONE. The objection to Arch 1 was exactly right against memory —
# "someone will forget one, and the reason we are here is that someone did" — and
# it is false against a test. The Bash redelivery had FOUR re-park exits and none
# spawned a deliverer; the drain doing the re-park is very often the foreground
# opportunistic drain that runs at the top of every `tap send` and then exits,
# leaving an entry that looks healthy, is not escalated, carries no marker, and has
# nobody scheduled. A new re-park path added later would reintroduce that silently.
#
# THE ASSERTION IS RESIDENCY, NOT A FUNCTION NAME. What matters is "a body arrives
# in spool/", however it gets there — an `mv` into the spool payload path, or a
# future helper. Keying on a callee name would pass the moment somebody wrote the
# same move a different way, which is the rename-passes-the-test failure this repo
# has been bitten by.
#
# SCOPE: production shell under skills/. The three test buckets are excluded by
# path — `smoke/`, `regress/`, and the vendored python suite — because a fixture
# legitimately stages spool state by hand to exercise something else. A FOURTH test
# bucket must be added here or it will be read as production code.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
fail() { echo "spool-reown-inventory: $*" >&2; exit 1; }

# Every production line that moves a body INTO spool residency.
# SCAN BY DESTINATION, NOT BY SPELLING (kimi F-B). The first version keyed on the
# literal `mv -f "$canon" "$spool_payload"`, which pins one variable pairing rather
# than the act. A rename of the SOURCE variable is caught — proven — but re-park
# site #5 is far more likely to arrive spelled differently than to arrive with
# the redelivery renamed: `mv "$c" "$(tap_spool_payload_path "$id")"`, a
# `cp` plus `rm`, or a helper. Any line whose DESTINATION is spool residency is a
# re-park however it is written, so the destination is what this scans for.
# DIRECTION IS THE WHOLE POINT: only lines whose LAST path argument is spool
# residency are re-parks. `mv "$spool_payload" "$canon"` is the opposite motion —
# a delivery — and matching it would demand a re-own on the very path that is
# handing the body OUT. A destination-keyed scan that ignores direction reports
# every move in the file.
mapfile -t HITS < <(
  grep -rnE '(mv|cp)([[:space:]]+-[A-Za-z]+)*[[:space:]]+[^;|&]*[[:space:]]"?\$\{?(spool_payload)\}?"?[[:space:]]*(2>|\|\||;|$)' \
    "$ROOT/skills" --include='*.sh' 2>/dev/null \
  | grep -v '/smoke/\|/regress/\|/scripts/tests/' || true
)

missing=0
for hit in "${HITS[@]}"; do
  file="${hit%%:*}"; rest="${hit#*:}"; line="${rest%%:*}"
  # SCOPE THE CHECK TO THE HIT'S OWN STATEMENT (gemini, mutation-proven). A
  # 3-line sliding window was wrong in a way that only shows up at THIS spacing:
  # the four re-park exits sit 2 lines apart, so each site's window reached into
  # its NEIGHBOUR and a neighbour's re-own satisfied it. Driven: strip the re-own
  # from the first site alone, leave the others, and the test passed GREEN — one
  # site's compliance vouching for another's absence.
  #
  # These exits are one-line `|| { ...; }` clauses, so the statement IS the line.
  # A multi-line variant that opens a brace continues to its closing brace, so
  # extend only while the braces are unbalanced rather than by a fixed count: a
  # window measured in LINES cannot tell "my own continuation" from "the next
  # site", and that distinction is the entire finding.
  window="$(awk -v start="$line" '
    NR < start { next }
    { chunk = chunk $0 "\n"
      n = gsub(/\{/, "{"); m = gsub(/\}/, "}"); depth += n - m
      if (NR > start && depth <= 0) exit
      if (NR == start && depth <= 0) exit }
    END { printf "%s", chunk }' "$file")"
  case "$window" in
    *tap_spool_reown_after_repark*) ;;
    *)
      echo "spool-reown-inventory: $file:$line returns a body to spool/ and never re-owns it" >&2
      echo "    $(sed -n "${line}p" "$file" | sed 's/^[[:space:]]*//' | cut -c1-110)" >&2
      missing=$((missing + 1))
      ;;
  esac
done

[ "$missing" = 0 ] || fail "$missing re-park site(s) leave an entry with no scheduled actor. A body in spool/ with nobody watching it is not a slow delivery — it is a silent one, waiting for an unrelated verb to run by coincidence (tap-w4f7). Add tap_spool_reown_after_repark at each site above."

# The live native single owner moves canonical -> spool, then re-owns and
# starts the deliverer after reset custody. Assert the destination and ordering;
# deleting the re-own or spawn must make this same check red.
NATIVE="$ROOT/runtime/bun/src/spool-drain-effects.ts"
check_native() {
  local body="$1" move reown spawn
  move="$(printf '%s\n' "$body" | grep -nF 'renameSync(canon, spoolPayload)' | cut -d: -f1)" || return 1
  reown="$(printf '%s\n' "$body" | grep -nF 'const token = reownAfterRepark(ctx.spoolDir, id,' | cut -d: -f1)" || return 1
  spawn="$(printf '%s\n' "$body" | grep -nF 'if (token) spawnDeliverer(' | cut -d: -f1)" || return 1
  [ -n "$move" ] && [ -n "$reown" ] && [ -n "$spawn" ] && [ "$reown" -gt "$move" ] && [ "$spawn" -gt "$reown" ]
}
body="$(sed -n '/^  const repark = /,/^  };/p' "$NATIVE")"
check_native "$body" || fail "native repark lost its spool destination, re-own or spawned owner"
for needle in 'renameSync(canon, spoolPayload)' 'const token = reownAfterRepark' 'if (token) spawnDeliverer'; do
  mutant="$(printf '%s\n' "$body" | grep -vF "$needle")"
  if check_native "$mutant"; then fail "native deletion control did not detect missing $needle"; fi
done
printf 'spool-reown-inventory: %s direct shell sites and native repark destination/re-own/spawn controls: ok\n' "${#HITS[@]}"
