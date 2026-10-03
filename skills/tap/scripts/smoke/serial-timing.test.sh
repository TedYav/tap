#!/usr/bin/env bash
# serial-timing.test.sh — tap-x45ge: timing files in either partition self-scope before setup.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
RUNNER="$ROOT/scripts/smoke-all.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "serial-timing: $1" >&2; exit 1; }

# A missing early declaration causes a target to enter expensive setup instead
# of returning the unchanged-input carry. This executes each real target, not
# a grepped source line.
targets=(
  skills/tap/scripts/smoke/courier-red-fixtures.test.sh
  skills/discuss/scripts/smoke/convergence-ledger.test.sh
  skills/tap/scripts/smoke/bun-router.test.sh
)
empty_paths="$WORK/empty-paths"; : > "$empty_paths"
for rel in "${targets[@]}"; do
  target="$ROOT/$rel"
  [ -x "$target" ] || fail "missing executable scoped target: $rel"
  out="$(SMOKE_SCOPE_STATE=scoped SMOKE_SCOPE_PATHS="$empty_paths" SMOKE_SCOPE_BASE=0123456789abcdef SMOKE_SUITE_FILE="$rel" bash "$target" 2>&1)" \
    || fail "$rel did not exit zero before setup: $out"
  case "$out" in
    *"SMOKE-SKIP: $rel unchanged-input carry — merge-base 0123456789abcdef; triggers:"*) ;;
    *) fail "$rel did not retain its unchanged-input skip receipt: $out" ;;
  esac
done
echo "serial-timing: (1) all scoped targets exit before setup when unchanged: ok"

# A real runner fixture proves both sides of the scope decision. The serial
# worker can pass only by exiting through the helper; a trigger or missing base
# reaches its deliberate failure line and is therefore observable in the log.
FIXTURE="$WORK/repo"; HOME_DIR="$WORK/home"; LOCKS="$WORK/locks"
mkdir -p "$FIXTURE/scripts" "$FIXTURE/skills/tap/scripts/smoke" "$HOME_DIR" "$LOCKS"
cp "$RUNNER" "$FIXTURE/scripts/smoke-all.sh"
cp "$ROOT/scripts/ignored-state-tripwire.py" "$FIXTURE/scripts/ignored-state-tripwire.py"
cp "$ROOT/scripts/serial-trigger.sh" "$FIXTURE/scripts/serial-trigger.sh"
cp "$ROOT/scripts/suite-slot-run.py" "$FIXTURE/scripts/suite-slot-run.py"
cp "$ROOT/scripts/suite_slot.py" "$FIXTURE/scripts/suite_slot.py"
cp "$ROOT/skills/tap/scripts/smoke/smoke-preflight.sh" "$FIXTURE/skills/tap/scripts/smoke/smoke-preflight.sh"
cp "$ROOT/skills/tap/scripts/smoke/smoke_hermeticity_lint.py" "$FIXTURE/skills/tap/scripts/smoke/smoke_hermeticity_lint.py"
cat > "$FIXTURE/skills/tap/scripts/smoke/fixture-serial.test.sh" <<'WORKER'
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
. "$ROOT/scripts/serial-trigger.sh"
tap_serial_triggers "trigger/" "rename-source/"
if [ "$SMOKE_SCOPE_STATE" = scoped ]; then
  if grep -Fqx "trigger/changed" "$SMOKE_SCOPE_PATHS"; then
    :
  elif grep -Fx "rename-source/from" "$SMOKE_SCOPE_PATHS"; then
    echo "fixture rename source observed"
  else
    echo "fixture scoped worker ran without a declared changed path" >&2
    exit 20
  fi
fi
echo "fixture serial worker executed"
exit 19
WORKER
cp "$FIXTURE/skills/tap/scripts/smoke/fixture-serial.test.sh" "$FIXTURE/skills/tap/scripts/smoke/fixture.test.sh"
chmod +x "$FIXTURE/skills/tap/scripts/smoke/fixture"*.test.sh
git -C "$FIXTURE" init -q
git -C "$FIXTURE" config user.email tap@test
git -C "$FIXTURE" config user.name tap
mkdir -p "$FIXTURE/rename-source"
printf 'rename source\n' > "$FIXTURE/rename-source/from"
git -C "$FIXTURE" add . && git -C "$FIXTURE" commit -qm base
git -C "$FIXTURE" branch -M main
BASE_HEAD="$(git -C "$FIXTURE" rev-parse HEAD)"
git -C "$FIXTURE" update-ref refs/remotes/origin/main "$BASE_HEAD"
run_fixture() {
  (cd "$FIXTURE" && env -i HOME="$HOME_DIR" PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" TERM=dumb LANG=C LC_CTYPE=en_US.UTF-8 TZ=UTC TAP_PYTHON="${TAP_PYTHON:-python3}" TAP_SUITE_SLOT=bypass TAP_SUITE_LOCK_HOME="$LOCKS" TAP_RUNNER_ALLOW=1 SMOKE_ALL_MIN_FILES=1 bash scripts/smoke-all.sh -j 1 2>&1)
}
mkdir -p "$FIXTURE/unrelated"; printf 'unrelated\n' > "$FIXTURE/unrelated/changed"
git -C "$FIXTURE" add unrelated/changed && git -C "$FIXTURE" commit -qm unrelated
UNRELATED_HEAD="$(git -C "$FIXTURE" rev-parse HEAD)"
skip_out="$(run_fixture)" || fail "unchanged serial fixture did not stay green: $skip_out"
case "$skip_out" in
  *"=== DECLARED SKIP skills/tap/scripts/smoke/fixture-serial.test.sh ==="*"SMOKE-SKIP: skills/tap/scripts/smoke/fixture-serial.test.sh unchanged-input carry"*"declared-skips=2 skip-files=2 — ok — all 2 files passed"*) ;;
  *) fail "unchanged serial fixture omitted its retained green receipt: $skip_out" ;;
esac
case "$skip_out" in
  *"=== DECLARED SKIP skills/tap/scripts/smoke/fixture.test.sh ==="*"SMOKE-SKIP: skills/tap/scripts/smoke/fixture.test.sh unchanged-input carry"*) ;;
  *) fail "ordinary fixture omitted its retained skip: $skip_out" ;;
esac
echo "serial-timing: (2) both partitions retain unchanged-input receipts: ok"
mkdir -p "$FIXTURE/trigger"; printf 'triggered\n' > "$FIXTURE/trigger/changed"
git -C "$FIXTURE" add trigger/changed && git -C "$FIXTURE" commit -qm trigger
if trigger_out="$(run_fixture)"; then fail "trigger change incorrectly skipped worker: $trigger_out"; fi
case "$trigger_out" in *"fixture serial worker executed"*) ;; *) fail "trigger change did not execute worker: $trigger_out" ;; esac
echo "serial-timing: (3) trigger changes execute the serial worker: ok"
git -C "$FIXTURE" update-ref -d refs/remotes/origin/main
if unresolved_out="$(run_fixture)"; then fail "unresolved base incorrectly skipped worker: $unresolved_out"; fi
case "$unresolved_out" in *"fixture serial worker executed"*) ;; *) fail "unresolved base did not execute worker: $unresolved_out" ;; esac
echo "serial-timing: (4) unresolved merge base fails open to execution: ok"
git -C "$FIXTURE" update-ref refs/remotes/origin/main "$BASE_HEAD"
git -C "$FIXTURE" checkout -q --detach "$BASE_HEAD"
mkdir -p "$FIXTURE/renamed-out"
git -C "$FIXTURE" mv rename-source/from renamed-out/to
git -C "$FIXTURE" commit -qm rename-out-of-trigger
if rename_out="$(run_fixture)"; then fail "rename out incorrectly skipped worker: $rename_out"; fi
case "$rename_out" in
  *"rename-source/from"*"fixture rename source observed"*"fixture serial worker executed"*) ;;
  *) fail "rename out did not retain the source path and execute worker: $rename_out" ;;
esac
echo "serial-timing: (5) rename out of a declared trigger fails open to execution: ok"
git -C "$FIXTURE" update-ref refs/remotes/origin/main "$BASE_HEAD"
# The dirty arm must not inherit the trigger change: otherwise its literal
# `trigger/` declaration already selects RUN and a broken dirty check passes.
git -C "$FIXTURE" checkout -q --detach "$UNRELATED_HEAD"
: > "$FIXTURE/dirty-untracked"
if dirty_out="$(run_fixture)"; then fail "dirty tree incorrectly skipped worker: $dirty_out"; fi
case "$dirty_out" in *"fixture serial worker executed"*) ;; *) fail "dirty tree did not execute worker: $dirty_out" ;; esac
echo "serial-timing: (6) dirty worktree fails open to execution: ok"
# A trigger is canonical only if it is a non-empty, relative, whitespace-free literal with no
# `//` and no `.`/`..` segment. Anything else can never match a `git diff --name-only`
# path, so it must fail open to RUN (the helper returns) instead of emitting a skip. The
# canonical control row proves the table can't pass vacuously: it still prints SMOKE-SKIP.
trigger_control() { # <trigger> -> prints RETURNED when the helper returned, else its output
  ( . "$ROOT/scripts/serial-trigger.sh"
    SMOKE_SCOPE_STATE=scoped SMOKE_SCOPE_PATHS="$empty_paths" SMOKE_SCOPE_BASE=0123456789abcdef
    SMOKE_SUITE_FILE=skills/tap/scripts/smoke/serial-timing.control.sh
    tap_serial_triggers "$1"
    echo RETURNED ) 2>&1
}
for bad in "./skills/" "skills/./tap" "skills/../skills" "../x" "a//b" "." ".." "x/." " skills/" "skills/ " $'skills/\t'; do
  got="$(trigger_control "$bad")" || fail "non-canonical trigger '$bad' made the helper exit nonzero: $got"
  case "$got" in
    RETURNED) ;;
    *) fail "non-canonical trigger '$bad' did not fail open to RUN: $got" ;;
  esac
done
canonical="$(trigger_control "skills/tap/")" || fail "canonical trigger control exited nonzero: $canonical"
case "$canonical" in
  *"SMOKE-SKIP:"*) ;;
  *) fail "canonical trigger control did not skip, so the table above is vacuous: $canonical" ;;
esac
echo "serial-timing: (7) non-canonical triggers fail open to RUN; a canonical one still skips: ok"
echo "PASS serial-timing"
