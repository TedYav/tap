#!/usr/bin/env bash
# focused-inventory: tree (tap-z5nl6)
# arm-inventory: a smoke file must still contain the arms it says it contains.
#
# WHY THIS FILE EXISTS (ruling, 2026-08-17). Rebuilding a smoke file
# during a review — reconstructing it under a new name as its subject changed —
# silently dropped one arm, and it shipped. Nothing could catch it: the file
# still passed, still printed its ok line, and still tested real behavior. A
# rewrite that loses an arm is textually indistinguishable from one that keeps
# every arm, because what is missing leaves no trace in the file that remains.
#
# The general failure is "coverage removed by an edit that was not about
# coverage". Content assertions cannot see it. So a file may DECLARE its arms,
# and this check enforces the declaration:
#
#     # ARMS: given-name, bare-default, dotted-literal, reserved-refusal
#
# Every declared name must then appear as an arm label in that file — spelled
# `(name)` inside a fail message or an echo. Rename an arm and this reds; delete
# an arm and this reds; rebuild the file and forget one and this reds.
#
# OPT-IN BY DECLARATION, deliberately. A repo-wide arm-count manifest for 130+
# files would be churn that people learn to update mechanically, which is how a
# manifest stops meaning anything. A file opts in when its arms are worth naming
# — and this check refuses a declaration it cannot verify, so opting in cannot be
# decorative.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"

fail() { echo "arm-inventory: $*" >&2; exit 1; }

checked=0
declared_total=0
while IFS= read -r file; do
  decl="$(grep -m1 '^# ARMS:' "$file" || true)"
  [ -n "$decl" ] || continue
  checked=$((checked + 1))
  arms="${decl#\# ARMS:}"
  arms="$(printf '%s' "$arms" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"

  # VALIDATE THE RAW DECLARATION, BEFORE SPLITTING IT.
  #
  # The previous empty-entry refusal lived inside the loop and could never run:
  # `IFS=, read -ra` yields ZERO elements for an empty RHS and DROPS a trailing
  # empty field, so `# ARMS:` iterated nothing and `# ARMS: 1,` iterated only
  # `1`. The file then exited green having enforced nothing, while `checked` said
  # it had — a guard that cannot fire, reported as coverage (partner review).
  #
  # Confirmed under bash rather than assumed: "" -> 0 elements, " 1," -> 1.
  [ -n "$arms" ] \
    || fail "$(basename "$file") has an empty '# ARMS:' declaration. That is not 'no arms to declare' — it is a file claiming an inventory and supplying none, which passes while enforcing nothing. Remove the line or list the arms."
  case "$arms" in
    ,*|*,) fail "$(basename "$file") ARMS declaration has a leading or trailing comma ('$arms'); bash drops the empty field silently, so the arm it stands for would go unchecked" ;;
    *,,*)  fail "$(basename "$file") ARMS declaration has a doubled comma ('$arms'); the empty field between them is dropped silently" ;;
  esac

  # DISTINCT IDENTITIES. `# ARMS: 1, 1` iterated twice, found the SAME `(1)`
  # line twice, and reported two arms — so a file could lose a real arm and stay
  # green because a duplicate name covered the count. One witness satisfying two
  # claims is the same shape as every other hole found in this net; a declared
  # arm needs its own identity before its own witness.
  # CAPTURE WHOLE, MATCH AFTER — never `grep -v ... | grep -q` under
  # `set -o pipefail`. `grep -q` exits at its first match, the upstream `grep -v`
  # is still writing, takes SIGPIPE, and the pipeline returns 141 with pipefail
  # promoting that to a failure of THIS file. It depends on file size versus pipe
  # buffer and on the label appearing early, so it reds only sometimes — a
  # portability flake in the merge gate, which is where a flake costs most.
  # Reproduced at exit 141 before this changed (review finding).
  #
  # presets-verb.test.sh documents the same hazard for `| head -1`; the remedy is
  # the same one: hold the text in a variable, because a variable cannot signal.
  # Filtering once per FILE rather than once per arm is also strictly less work.
  executable="$(grep -v '^[[:space:]]*#' "$file" || true)"

  seen_names=()
  IFS=',' read -ra names <<<"$arms"
  [ "${#names[@]}" -gt 0 ] \
    || fail "$(basename "$file") ARMS declaration '$arms' split into no entries; the split, not the declaration, is what failed"
  for raw in "${names[@]}"; do
    name="$(printf '%s' "$raw" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    [ -n "$name" ] \
      || fail "$(basename "$file") has an empty entry in its ARMS declaration"
    # EXACT string equality over an indexed array, not substring-in-a-string.
    # A space-delimited membership test cannot represent a label containing a
    # space: `# ARMS: alpha beta, beta` false-redded, because " beta " occurs
    # inside " alpha beta ". That is the same defect one more time — a witness
    # (the substring) satisfying a claim (identity) it does not actually prove.
    for _seen in ${seen_names[@]+"${seen_names[@]}"}; do
      [ "$_seen" != "$name" ] || fail "$(basename "$file") declares arm '$name' twice. Two declarations resolving to ONE witness means the count says 2 while only 1 arm is proven — a lost arm hides behind its duplicate. Give each arm a distinct label."
    done
    seen_names+=("$name")
    declared_total=$((declared_total + 1))
    # EXECUTABLE LINES ONLY, and FIXED strings.
    #
    # A comment header (`# (4) THE DOTTED CASE`) is not an arm — deleting the
    # assertion beneath it while leaving the heading kept the inventory green,
    # so the witness has to be code (partner review). Comment lines are stripped
    # before the search.
    #
    # -F because a declared name is a literal label, not a pattern: a name
    # containing `.` matched unrelated text as a regex wildcard.
    # NO PIPELINE AT ALL. The first fix for this replaced `grep -v file | grep -q`
    # with `printf "$var" | grep -q` — which moved the hazard instead of removing
    # it: `grep -q` still exits at its first match while `printf` is still
    # writing, so `printf` takes SIGPIPE and the pipeline still returns 141 under
    # pipefail. Reproduced at exit 141 with a 200KB value (review finding).
    #
    # A bash pattern match runs no subprocess and cannot signal. The quoted
    # "($name)" is a literal substring, which is also what -F bought: a name
    # containing `.` must not match as a regex wildcard.
    case "$executable" in
      *"($name)"*) : ;;
      *) fail "$(basename "$file") declares arm '$name' but no EXECUTABLE line is labelled ($name).
  Either the arm was removed — restore it, that is the failure this check exists for — or it was renamed, in which case update the ARMS line too.
  An arm that vanishes leaves no trace in the file that remains, which is why the declaration is the only witness." ;;
    esac
  done
done < <(find "$ROOT/skills" -name '*.test.sh' -not -path '*/fixtures/*' | sort)

[ "$checked" -gt 0 ] \
  || fail "no smoke file declares '# ARMS:'; this check is enforcing nothing. Either a declaration was dropped or the scan has drifted — do not leave it green and empty."

echo "arm-inventory: $declared_total declared arm(s) across $checked file(s) all present: ok"
