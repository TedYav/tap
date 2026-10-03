#!/usr/bin/env bash
# regress-stamp-guard.test.sh — only a run that EXECUTED FILES may replace the
# REGRESS last-run stamp.
#
# tap-52ys / sol-ponytail P2, and his re-review of the first fix. The stamp
# answers one question: "did this box ever actually run regress." A pre-run
# refusal runs zero files, so stamping it answers "yes, just now" — worse than
# no stamp at all.
#
# THE TRAP THIS PINS: a pre-run refusal and an authored red can both exit 1.
# Exit codes cannot discriminate them; only a positive terminal-result marker can.
#
# Both arms are required. Arm (a) alone is satisfied by a guard that never
# stamps anything; arm (b) alone by a guard that always stamps.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "regress-stamp-guard: $*" >&2; exit 1; }

FIX="$WORK/repo"
mkdir -p "$FIX/scripts" "$FIX/.tap"
cp "$ROOT/scripts/regress-all.sh" "$FIX/scripts/regress-all.sh"
git -C "$FIX" init -q
git -C "$FIX" config user.email tap@test
git -C "$FIX" config user.name tap
git -C "$FIX" commit -q --allow-empty -m base

STAMP="$FIX/.tap/regress-last-run.json"
seed_stamp() { printf '{\n  "at": "2020-01-01T00:00:00Z",\n  "exit": 0,\n  "head": "SEEDED"\n}\n' > "$STAMP"; }

stub_runner() { # <exit-code> <line-to-print...>
  local rc="$1"; shift
  { printf '#!/usr/bin/env bash\n'
    for line in "$@"; do printf 'echo %q\n' "$line"; done
    printf 'exit %s\n' "$rc"
  } > "$FIX/scripts/smoke-all.sh"
  chmod +x "$FIX/scripts/smoke-all.sh"
}

# (a) A usage refusal EXITS 1 — same code as a red — and prints no terminal
# result. The prior stamp must survive byte-for-byte.
seed_stamp
stub_runner 1 "smoke-all: preflight refused before workers"
( cd "$FIX" && bash scripts/regress-all.sh >/dev/null 2>&1 ) || true
grep -q '"head": "SEEDED"' "$STAMP" \
  || fail "(a) a pre-run refusal (exit 1, zero files) REPLACED the stamp: $(cat "$STAMP")"
echo "regress-stamp-guard: (a) a pre-run refusal exiting 1 leaves the prior stamp untouched: ok"

# (b) An authored RED also exits 1, but prints its terminal accounting. It MUST
# stamp — a failing regress run is exactly the state the stamp should record.
seed_stamp
stub_runner 1 "regress-all: tested-tree=abc head=def worktree=clean; known-defect: 0; declared-skips=0 skip-files=0 — 2/60 FAILED, 58 passed (9s, -j 12)"
( cd "$FIX" && bash scripts/regress-all.sh >/dev/null 2>&1 ) || true
grep -q '"head": "SEEDED"' "$STAMP" \
  && fail "(b) an authored red (exit 1, terminal result printed) did NOT update the stamp"
grep -q '"exit": 1' "$STAMP" \
  || fail "(b) the stamp did not record the red's exit code: $(cat "$STAMP")"
echo "regress-stamp-guard: (b) an authored red exiting 1 DOES write the stamp: ok"

# (c) Green stamps too, and records exit 0.
seed_stamp
stub_runner 0 "regress-all: tested-tree=abc head=def worktree=clean — ok — all 60 files passed (9s, -j 12)"
( cd "$FIX" && bash scripts/regress-all.sh >/dev/null 2>&1 ) || true
grep -q '"exit": 0' "$STAMP" || fail "(c) a green run did not stamp exit 0: $(cat "$STAMP")"
echo "regress-stamp-guard: (c) a green run stamps exit 0: ok"

# (d) LEDGER MISMATCH is the third authored terminal outcome (workers ran, but
# pass+fail does not reconcile — a worker died). sol P1: the first marker
# listed only green and FAILED, so a run that LOST A WORKER left the stamp
# claiming an older, healthier run. That is a run that executed files and its
# result is exactly what a stamp should record.
seed_stamp
stub_runner 1 "regress-all: tested-tree=abc head=def worktree=clean; known-defect: 1 (tap-xk0yr); declared-skips=1 skip-files=1 — ledger mismatch — 58 passed + 1 failed != 60 files (worker died?)"
( cd "$FIX" && bash scripts/regress-all.sh >/dev/null 2>&1 ) || true
grep -q '"head": "SEEDED"' "$STAMP" \
  && fail "(d) a ledger-mismatch run (workers ran, ledger incomplete) did NOT update the stamp"
echo "regress-stamp-guard: (d) a ledger-mismatch run stamps — it executed files: ok"

# (e) tap-1f45b. A STRADDLED run executed files too — it just cannot say which
# tree they were read from. It is the fourth terminal shape, and it is the arm
# that proves this guard is an ENUMERATION rather than a pattern: every shape
# added after the alternation was written matches none of it, and a run that
# matches nothing leaves the stamp claiming the previous, healthier run. That
# is the same lie (d) exists to prevent, arriving through a new door.
#
# WHAT THIS ARM DOES NOT ASSERT: that the straddled run is citable. It is not —
# it is a refusal. The stamp answers "did this box run regress, and when",
# never "did it pass"; (b) and (d) stamp failures for the same reason.
seed_stamp
stub_runner 1 "regress-all: tested-tree=abc head=def worktree=clean — STRADDLED — the checkout moved between suite start and receipt (start-head=aaa start-tree=bbb receipt-head=ccc receipt-tree=ddd); this run read a mixture of both trees and certifies neither"
( cd "$FIX" && bash scripts/regress-all.sh >/dev/null 2>&1 ) || true
grep -q '"head": "SEEDED"' "$STAMP" \
  && fail "(e) a straddled run (workers ran, tree identity void) did NOT update the stamp"
echo "regress-stamp-guard: (e) a straddled run stamps — it executed files: ok"

# (f) tap-jnik4. A passing --only run prints a "regress-one" receipt, not a
# "regress-all" one. It must read as a finished partial run — not as "no
# terminal result" — and must leave the full-run stamp alone and keep the exit
# code. (g) a red partial run is not described as a pass. (h) an unrecognised
# shape under the partial name still fails toward silence.
partial_arm() { # <label> <rc> <receipt-line> <want-stderr-regex> <forbid-stderr-regex>
  local label="$1" rc="$2" line="$3" want="$4" forbid="$5" out got=0
  seed_stamp
  stub_runner "$rc" "$line"
  out="$(cd "$FIX" && bash scripts/regress-all.sh 2>&1 >/dev/null)" || got=$?
  [ "$got" = "$rc" ] || fail "($label) exit $got, want $rc"
  grep -q '"head": "SEEDED"' "$STAMP" || fail "($label) a partial run replaced the full-run stamp: $(cat "$STAMP")"
  grep -qE "$want" <<<"$out" || fail "($label) stderr lacks /$want/: $out"
  if [ -n "$forbid" ]; then
    ! grep -qE "$forbid" <<<"$out" || fail "($label) stderr matched /$forbid/: $out"
  fi
}
partial_arm f 0 "regress-one: tested-tree=abc head=def worktree=clean; known-defect: 0; declared-skips=0 skip-files=0 — ok — all 1 files passed (4s, -j 1)" \
  'partial run .* finished \(exit 0\).*full runs only' 'no terminal result'
echo "regress-stamp-guard: (f) a passing one-file run reads as a finished partial run, stamp untouched: ok"
partial_arm g 1 "regress-selected: tested-tree=abc head=def worktree=clean; known-defect: 0; declared-skips=0 skip-files=0 — 1/2 FAILED, 1 passed (4s, -j 2)" \
  'partial run .* finished \(exit 1\)' 'no terminal result'
echo "regress-stamp-guard: (g) a red selected run keeps its exit code, stamp untouched: ok"
partial_arm h 0 "regress-one: tested-tree=abc head=def worktree=clean — something-new — 1 files" \
  'no terminal result \(exit 0\)' 'partial run'
echo "regress-stamp-guard: (h) an unrecognised partial shape still fails toward silence: ok"

# (i) A partial-shaped receipt replayed inside a log that also carries an
# authored FULL receipt must not hide the full result: the stamp records it.
seed_stamp
stub_runner 1 "regress-one: tested-tree=abc head=def worktree=clean — ok — all 1 files passed (4s, -j 1)" \
  "regress-all: tested-tree=abc head=def worktree=clean — 1/60 FAILED, 59 passed (9s, -j 12)"
( cd "$FIX" && bash scripts/regress-all.sh >/dev/null 2>&1 ) || true
grep -q '"exit": 1' "$STAMP" && ! grep -q '"head": "SEEDED"' "$STAMP" \
  || fail "(i) a partial receipt alongside a full terminal receipt blocked the stamp: $(cat "$STAMP")"
echo "regress-stamp-guard: (i) a full terminal receipt wins over a replayed partial one: ok"

echo "regress-stamp-guard: ok"
