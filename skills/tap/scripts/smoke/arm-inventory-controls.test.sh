#!/usr/bin/env bash
# focused-inventory: tree (tap-z5nl6)
# ARMS: exact-duplicate, overlap-forward, overlap-reverse, baseline-valid, delimiter-mutation
#
# arm-inventory-controls: the arm-inventory checker's own regression arms.
#
# WHY THIS FILE EXISTS (partner review, 2026-08-17). arm-inventory.test.sh had its
# duplicate-name comparison repaired from a space-delimited membership test to an
# indexed array with exact equality. The repair is correct — and nothing in the
# suite proved it. The cases it fixed lived only in a comment, so exact archived
# copies of the broken parent and the fixed head both ran green over the real
# repo, and restoring the bug would have stayed gate-green. A fix whose
# regression cases are not executable is indistinguishable from no fix.
#
# HOW THIS RUNS THE REAL CHECKER, not a stand-in. arm-inventory derives its scan
# root from its own path (`dirname $BASH_SOURCE/../../../..`), so copying it into
# a temp tree at the same relative depth points it at synthetic subject files
# with no production seam, no env hook, and no test-only branch in the checker.
# The thing under test is the shipped file, byte for byte.
#
# The synthetic `# ARMS:` lines are printf-generated from a variable rather than
# written literally: a literal `# ARMS:` at column 0 in this file would be read
# as THIS file's declaration by the real checker scanning the real repo.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
CHECKER="$ROOT/skills/tap/scripts/smoke/arm-inventory.test.sh"
H='#'

fail() { echo "arm-inventory-controls: $*" >&2; exit 1; }

[ -f "$CHECKER" ] || fail "cannot find the checker under test at $CHECKER"

TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/arm-inv-ctl.$$.XXXXXX")"
trap 'rm -rf "$TMPROOT"' EXIT
SMOKEDIR="$TMPROOT/skills/tap/scripts/smoke"

# Fresh scan root per arm: the checker walks every *.test.sh it can see, so a
# subject left behind by an earlier arm would be re-judged by a later one.
setup_root() {
  rm -rf "$TMPROOT/skills"
  mkdir -p "$SMOKEDIR"
  cp "$CHECKER" "$SMOKEDIR/arm-inventory.test.sh"
}

# write_subject <file> <declaration> [executable-label ...]
write_subject() {
  local f="$SMOKEDIR/$1" decl="$2" lbl
  shift 2
  {
    printf '%s!/usr/bin/env bash\n' "$H"
    printf '%s ARMS: %s\n' "$H" "$decl"
    for lbl in "$@"; do printf 'echo "(%s) ran"\n' "$lbl"; done
  } >"$f"
}

# run_checker [checker-path] -> prints combined output, returns its exit code
run_checker() {
  local script="${1:-$SMOKEDIR/arm-inventory.test.sh}" out rc=0
  out="$(bash "$script" 2>&1)" || rc=$?
  printf '%s' "$out"
  return "$rc"
}

# (exact-duplicate) Two declarations resolving to one witness must be refused.
# This is the case the array repair was written for that DOES red under the old
# space-delimited test too — it pins the refusal itself, not the repair.
setup_root
write_subject dup.test.sh '1, 1' '1'
rc=0; out="$(run_checker)" || rc=$?
[ "$rc" -ne 0 ] \
  || fail "(exact-duplicate) a declaration naming the same arm twice was ACCEPTED. One witness satisfying two claims means the count says 2 while 1 arm is proven, which is the hole this refusal exists to close."
case "$out" in
  *"declares arm '1' twice"*) : ;;
  *) fail "(exact-duplicate) refused, but not for the declared reason. Expected the duplicate-identity message; got: $out" ;;
esac

# (overlap-forward) A label that CONTAINS an earlier-declared label, in the order
# that broke: seen=[alpha beta], name=beta. The space-delimited test found
# " beta " inside " alpha beta " and false-redded a valid file.
setup_root
write_subject overlap.test.sh 'alpha beta, beta' 'alpha beta' 'beta'
rc=0; out="$(run_checker)" || rc=$?
[ "$rc" -eq 0 ] \
  || fail "(overlap-forward) a valid declaration with distinct multiword labels was REJECTED: $out"

# (overlap-reverse) The same two labels declared the other way round. Order must
# not change the verdict — under the old test it did, which is what made the
# defect a substring bug rather than a comparison that was merely strict.
setup_root
write_subject overlap.test.sh 'beta, alpha beta' 'alpha beta' 'beta'
rc=0; out="$(run_checker)" || rc=$?
[ "$rc" -eq 0 ] \
  || fail "(overlap-reverse) the same labels in the opposite order were REJECTED, so the verdict depends on declaration order: $out"

# (baseline-valid) An ordinary file passes, so the arms above are read against a
# checker that can still say yes. Without this, every assertion here is also
# satisfied by a checker that refuses everything.
setup_root
write_subject plain.test.sh 'solo, second' 'solo' 'second'
rc=0; out="$(run_checker)" || rc=$?
[ "$rc" -eq 0 ] \
  || fail "(baseline-valid) an ordinary valid declaration was rejected, so this file's other arms prove nothing: $out"
case "$out" in
  *"2 declared arm(s)"*) : ;;
  *) fail "(baseline-valid) passed without counting both declared arms; got: $out" ;;
esac

# (delimiter-mutation) The arms above are load-bearing only if restoring the
# defect reds them. Reintroduce substring comparison — the exact shape of the
# original bug — and require overlap-forward to red while overlap-reverse still
# passes. That asymmetry IS the bug's signature: a two-sided refusal would prove
# only that the mutation broke something, not that it broke this.
setup_root
MUT="$SMOKEDIR/arm-inventory-mutated.sh"
cp "$CHECKER" "$MUT"
python3 - "$MUT" <<'PY'
import sys
path = sys.argv[1]
with open(path) as fh:
    src = fh.read()
anchor = '[ "$_seen" != "$name" ] ||'
found = src.count(anchor)
if found != 1:
    sys.exit("mutation anchor matched %d times, expected exactly 1" % found)
mutant = '{ case "$_seen" in *"$name"*) false ;; *) true ;; esac; } ||'
with open(path, "w") as fh:
    fh.write(src.replace(anchor, mutant))
PY

write_subject overlap.test.sh 'alpha beta, beta' 'alpha beta' 'beta'
rc=0; out="$(run_checker "$MUT")" || rc=$?
[ "$rc" -ne 0 ] \
  || fail "(delimiter-mutation) restoring substring comparison did NOT red the overlap-forward case, so that arm does not actually cover the repair."
case "$out" in
  *"declares arm 'beta' twice"*) : ;;
  *) fail "(delimiter-mutation) the mutant redded for some other reason than the substring collision; got: $out" ;;
esac

write_subject overlap.test.sh 'beta, alpha beta' 'alpha beta' 'beta'
rc=0; out="$(run_checker "$MUT")" || rc=$?
[ "$rc" -eq 0 ] \
  || fail "(delimiter-mutation) the mutant redded in BOTH label orders, so the arms are not pinned to the order-dependent substring defect: $out"

echo "arm-inventory-controls: 5 arms ok (duplicate refused, both overlap orders accepted, baseline counted, mutation reds forward-only)"
