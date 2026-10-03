#!/usr/bin/env bash
# regress-scheduled-locale.test.sh — REGRESS may start on a UTF-8 charmap
# that does not classify NBSP as [[:space:]]; smoke now may too.
#
# Live GHA failure after the loop change: the runner generated en_US.UTF-8 (UTF-8, but
# glibc does not class NBSP as space). smoke-all still required NBSP-as-space
# for every suite, so TAP_SUITE_DIR=regress refused before any file ran.
# This control is a runner fixture, not a YAML scan: a PATH bash shim makes
# only the NBSP [[:space:]] probe false; /usr/bin/locale still reports UTF-8.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
PY="${TAP_PYTHON:-python3}"
FIXED_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
REAL_BASH="$(command -v bash)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "regress-scheduled-locale: $*" >&2; exit 1; }

[ -n "$REAL_BASH" ] || fail "no bash on PATH"
[ -x "$REAL_BASH" ] || fail "bash is not executable: $REAL_BASH"

FIXTURE="$WORK/repo"
FIXTURE_HOME="$WORK/home"
FIXTURE_LOCKS="$WORK/locks"
FIXTURE_BIN="$WORK/bin"
mkdir -p \
  "$FIXTURE/scripts" \
  "$FIXTURE/skills/tap/scripts/smoke" \
  "$FIXTURE/skills/tap/scripts/regress" \
  "$FIXTURE_HOME" \
  "$FIXTURE_LOCKS" \
  "$FIXTURE_BIN"

# Classification shim: real bash except the NBSP [[:space:]] probe used by
# smoke-all's locale loop. Locale charmap stays the host /usr/bin/locale.
cat >"$FIXTURE_BIN/bash" <<SHIM
#!/bin/sh
if [ "\${1:-}" = "-c" ] && [ "\${2:-}" = '[[ "\$1" == [[:space:]] ]]' ]; then
  exit 1
fi
exec "$REAL_BASH" "\$@"
SHIM
chmod +x "$FIXTURE_BIN/bash"

cp "$ROOT/scripts/smoke-all.sh" "$FIXTURE/scripts/smoke-all.sh"
cp "$ROOT/scripts/ignored-state-tripwire.py" "$FIXTURE/scripts/ignored-state-tripwire.py"
cp "$ROOT/scripts/regress-all.sh" "$FIXTURE/scripts/regress-all.sh"
cp "$ROOT/scripts/suite-slot-run.py" "$FIXTURE/scripts/suite-slot-run.py"
cp "$ROOT/scripts/suite_slot.py" "$FIXTURE/scripts/suite_slot.py"
cp "$ROOT/skills/tap/scripts/smoke/smoke-preflight.sh" \
  "$FIXTURE/skills/tap/scripts/smoke/smoke-preflight.sh"
cp "$ROOT/skills/tap/scripts/smoke/smoke_hermeticity_lint.py" \
  "$FIXTURE/skills/tap/scripts/smoke/smoke_hermeticity_lint.py"

# Side-effect markers: passing worker logs are deleted, so stdout cannot prove
# the body ran. Touch a file the runner does not clean.
cat >"$FIXTURE/skills/tap/scripts/smoke/smoke-worker.test.sh" <<WORKER
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' 'SMOKE_LOCALE_MARKER' > '$FIXTURE/smoke.executed'
echo "smoke-worker: ok"
WORKER
cat >"$FIXTURE/skills/tap/scripts/regress/regress-worker.test.sh" <<WORKER
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' 'REGRESS_LOCALE_MARKER' > '$FIXTURE/regress.executed'
echo "regress-worker: ok"
WORKER
chmod +x \
  "$FIXTURE/skills/tap/scripts/smoke/smoke-worker.test.sh" \
  "$FIXTURE/skills/tap/scripts/regress/regress-worker.test.sh"

git -C "$FIXTURE" init -q
git -C "$FIXTURE" config user.email "tap@test"
git -C "$FIXTURE" config user.name "tap"
git -C "$FIXTURE" add .
git -C "$FIXTURE" commit -qm base
git -C "$FIXTURE" branch -m main
git -C "$FIXTURE" update-ref refs/remotes/origin/main "$(git -C "$FIXTURE" rev-parse HEAD)"

run_only() { # <suite-dir> <rel-path> -> writes $WORK/out, echoes rc
  rm -f "$FIXTURE/smoke.executed" "$FIXTURE/regress.executed"
  local rc=0
  (
    cd "$FIXTURE"
    env -i \
      HOME="$FIXTURE_HOME" \
      PATH="$FIXTURE_BIN:$FIXED_PATH" \
      TERM="dumb" LANG="C" LC_CTYPE="en_US.UTF-8" TZ="UTC" \
      TAP_PYTHON="$PY" \
      TAP_SUITE_SLOT="bypass" \
      TAP_SUITE_LOCK_HOME="$FIXTURE_LOCKS" \
      TAP_SUITE_DIR="$1" \
      SMOKE_ALL_MIN_FILES="1" \
      bash "$FIXTURE/scripts/smoke-all.sh" --only "$2" -j 1
  ) >"$WORK/out" 2>&1 || rc=$?
  echo "$rc"
}

# (1) Repair: TAP_SUITE_DIR=regress --only must execute the regress marker
# and finish green even though the NBSP probe is false.
reg_rc="$(run_only regress skills/tap/scripts/regress/regress-worker.test.sh)"
[ "$reg_rc" = 0 ] || fail "regress --only refused under UTF-8-without-NBSP (rc=$reg_rc): $(cat "$WORK/out")"
[ -f "$FIXTURE/regress.executed" ] \
  || fail "regress --only greened without executing its marker: $(cat "$WORK/out")"
[ ! -f "$FIXTURE/smoke.executed" ] \
  || fail "regress --only executed the smoke worker"
grep -Eq '^regress-one: .* — ok — all 1 files passed' "$WORK/out" \
  || fail "regress --only omitted its non-gate receipt: $(cat "$WORK/out")"

# (2) Smoke now owns NBSP explicitly in its input-band expressions, so a
# UTF-8 locale must execute the marker even when POSIX space excludes NBSP.
smoke_rc="$(run_only smoke skills/tap/scripts/smoke/smoke-worker.test.sh)"
[ "$smoke_rc" = 0 ] || fail "default smoke refused UTF-8 without POSIX NBSP: $(cat "$WORK/out")"
[ -f "$FIXTURE/smoke.executed" ] \
  || fail "default smoke greened without executing its marker: $(cat "$WORK/out")"
grep -Eq '^smoke-one: .* — ok — all 1 files passed' "$WORK/out" \
  || fail "default smoke omitted its non-gate receipt: $(cat "$WORK/out")"

# (3) The merged loop (always-NBSP) must refuse TAP_SUITE_DIR=regress too.
# Its SHA is private history a public checkout does not carry, so the mutant is
# synthesized from the CURRENT smoke-all.sh: the utf8_locale assignment is
# wrapped in the NBSP probe, the arg spelled as a literal NBSP byte. The
# probe-line counts prove the mutation landed where this row says it did — one
# probe line in the mutant, none in the current file (whose locale loop owes
# UTF-8 only, never POSIX NBSP classification).
MUTANT="$WORK/smoke-all-mutant.sh"
"$PY" - "$ROOT/scripts/smoke-all.sh" "$MUTANT" <<'PYEOF'
import sys
src, dst = sys.argv[1], sys.argv[2]
with open(src, encoding="utf-8") as fh:
    text = fh.read()
anchor = '        utf8_locale="$candidate"\n        break\n'
wrapped = (
    "        if LC_ALL='' LANG=C LC_CTYPE=\"$candidate\" \\\n"
    "          bash -c '[[ \"$1\" == [[:space:]] ]]' bash '\u00a0' 2>/dev/null; then\n"
    "          utf8_locale=\"$candidate\"\n"
    "          break\n"
    "        fi\n"
)
if text.count(anchor) != 1:
    sys.exit("regress-scheduled-locale: utf8_locale anchor not found exactly once in smoke-all.sh")
with open(dst, "w", encoding="utf-8") as fh:
    fh.write(text.replace(anchor, wrapped))
PYEOF
probe_pattern='bash -c .\[\[ "\$1" == \[\[:space:\]\] \]\].'
probe_count_mutant="$(grep -c "$probe_pattern" "$MUTANT" || true)"
probe_count_current="$(grep -c "$probe_pattern" "$ROOT/scripts/smoke-all.sh" || true)"
[ "$probe_count_mutant" = 1 ] \
  || fail "mutant does not carry exactly one NBSP probe line (found $probe_count_mutant)"
[ "$probe_count_current" = 0 ] \
  || fail "current smoke-all.sh carries the NBSP probe ($probe_count_current lines) — the anchor row is stale"
cp "$MUTANT" "$FIXTURE/scripts/smoke-all.sh"
merged_rc="$(run_only regress skills/tap/scripts/regress/regress-worker.test.sh)"
[ "$merged_rc" != 0 ] || fail "always-NBSP mutant accepted TAP_SUITE_DIR=regress under a failed NBSP probe: $(cat "$WORK/out")"
[ ! -f "$FIXTURE/regress.executed" ] \
  || fail "always-NBSP mutant executed the regress marker: $(cat "$WORK/out")"

echo "regress-scheduled-locale: TAP_SUITE_DIR=regress runs on UTF-8-without-NBSP; smoke also executes its marker: ok"
