# serial-trigger.sh — change-scoping for smoke files in either partition (tap-x45ge).
#
# A scoped test sources this and calls `tap_serial_triggers` with the LITERAL
# repo-relative path prefixes it exercises, BEFORE any expensive setup. If none of
# them intersects the runner-computed changed-path set, the test emits one
# retained SMOKE-SKIP receipt and exits ZERO immediately.
#
# EXITING BEFORE ANY FALLIBLE WORK IS LOAD-BEARING, not tidiness. tap-fwzhg is the
# runner defect where a file that both declares a skip AND fails has its declared
# skip dropped from the accounting. It is NOT a prerequisite for this mechanism
# precisely because the skip path exits zero before anything that could fail. If a
# future edit emits the receipt and then continues into fallible work, fwzhg
# becomes a prerequisite and this design is no longer sound — do not build that
# shape.
#
# THE SKIP IS AN UNCHANGED-INPUT CARRY, not a claim that some other job covered
# this file. The receipt names the merge-base and the trigger set so a reader can
# check the carry rather than trust it.
#
# WHAT THIS DOES NOT CLAIM. Running in the serial phase means no sibling workers
# from this gate invocation. It does not mean a quiet machine, and nothing here
# waits, locks, or retries.
#
# COVERAGE-SAFE FAIL-OPEN. Every ambiguity RUNS. The runner resolves the git-side
# conditions once (missing git/origin/base, dirty tree, HEAD==base, --only) and
# reports `run`; this helper additionally runs on a malformed declaration. Literal
# prefixes only — no glob DSL — so a trigger is a plain string compared with `case`.
tap_serial_triggers() { # <literal repo-relative prefix>...
  # Malformed declaration => RUN. No triggers, or a trigger that is not canonical,
  # is a declaration this helper cannot honour, and an unhonourable declaration
  # must never silence a test. A trigger is canonical only if it is non-empty and
  # relative, has no leading or trailing whitespace and no `//`, and has no `.` or
  # `..` path segment: such a prefix can never match a `git diff --name-only` path,
  # so accepting it would emit SMOKE-SKIP where the file should RUN (tap-ils5k).
  [ "$#" -gt 0 ] || return 0
  local _t
  for _t in "$@"; do
    case "$_t" in
      ''|/*) return 0 ;;
      [[:space:]]*|*[[:space:]]) return 0 ;;
      *//*) return 0 ;;
      .|..|./*|../*|*/./*|*/../*|*/.|*/..) return 0 ;;
    esac
  done

  # The runner owns the git-side decision; anything but `scoped` runs.
  [ "${SMOKE_SCOPE_STATE:-run}" = "scoped" ] || return 0
  [ -n "${SMOKE_SCOPE_PATHS:-}" ] && [ -r "${SMOKE_SCOPE_PATHS:-}" ] || return 0

  # Implicit triggers: the runner, this helper, and the test file itself. A
  # change to any of them must run the file regardless of what it declared.
  set -- "$@" "scripts/smoke-all.sh" "scripts/serial-trigger.sh" "${SMOKE_SUITE_FILE:-}"

  local _changed
  while IFS= read -r _changed; do
    [ -n "$_changed" ] || continue
    for _t in "$@"; do
      [ -n "$_t" ] || continue
      case "$_changed" in "$_t"*) return 0 ;; esac
    done
  done < "$SMOKE_SCOPE_PATHS"

  printf 'SMOKE-SKIP: %s unchanged-input carry — merge-base %s; triggers: %s\n' \
    "${SMOKE_SUITE_FILE:-unknown}" "${SMOKE_SCOPE_BASE:-unknown}" "$*"
  exit 0
}
