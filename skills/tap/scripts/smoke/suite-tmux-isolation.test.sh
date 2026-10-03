#!/usr/bin/env bash
# suite-tmux-isolation.test.sh — the gate owns one ephemeral tmux namespace.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
SMOKE_ALL="$ROOT/scripts/smoke-all.sh"
LINT="$ROOT/skills/tap/scripts/smoke/smoke_hermeticity_lint.py"
FIXTURE="$ROOT/skills/tap/scripts/smoke/fixtures/smoke-hermeticity/known-bad.test.sh.txt"
PY="${TAP_PYTHON:-python3}"
WORK="$(mktemp -d)"
SUITE_ROOT="$(mktemp -d /tmp/tap-tmux-test.XXXXXX)"
trap 'rm -rf "$WORK" "$SUITE_ROOT"' EXIT
fail() { echo "suite-tmux-isolation: $*" >&2; exit 1; }

# Source only: production helpers must be testable without entering the gate.
# shellcheck source=scripts/smoke-all.sh
. "$SMOKE_ALL"

# (1) The static precheck is only a hard-refusal net. It flags operator HOME
# resets and explicit external socket names; it never classifies ordinary tmux.
EXPECTED="$WORK/expected"
"$PY" -B - "$FIXTURE" >"$EXPECTED" <<'PY'
from pathlib import Path
import sys

for index, line in enumerate(Path(sys.argv[1]).read_text().splitlines()):
    if line.startswith("# expect:"):
        print(f"{index + 2}:{line.removeprefix('# expect:')}")
PY
set +e
lint_out="$("$PY" -B "$LINT" "$FIXTURE" 2>&1)"
lint_rc=$?
set -e
[ "$lint_rc" -eq 1 ] || fail "(1) unsafe fixture must fail lint: rc=$lint_rc $lint_out"
printf '%s\n' "$lint_out" | sed "s#^$FIXTURE:##" >"$WORK/actual"
diff -u "$EXPECTED" "$WORK/actual" || fail "(1) lint set changed"
echo "suite-tmux-isolation: (1) hard-refusal lint exact set: ok"

# Known environment-reconstruction spellings are visible but not prevention.
# They must produce notes while leaving the file runnable; the post-wave state
# predicates own the effect verdict.
RECONSTRUCTION="$WORK/reconstruction.test.sh"
cat >"$RECONSTRUCTION" <<'EOF'
#!/usr/bin/env bash
env -u TMUX -u TMUX_PANE -u TMUX_TMPDIR \
  PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  tmux list-sessions
EOF
set +e
note_out="$("$PY" -B "$LINT" "$RECONSTRUCTION" 2>&1)"
note_rc=$?
set -e
[ "$note_rc" -eq 0 ] || fail "(1b) reconstruction notes blocked execution: rc=$note_rc $note_out"
printf '%s\n' "$note_out" | grep -q ':note:tmux-environment-reconstruction$' \
  || fail "(1b) TMUX_TMPDIR reconstruction note missing: $note_out"
printf '%s\n' "$note_out" | grep -q ':note:tmux-path-reconstruction$' \
  || fail "(1b) PATH reconstruction note missing: $note_out"
echo "suite-tmux-isolation: (1b) known reconstruction shapes are notes, not blockers: ok"

SAFE_ROOTS="$WORK/safe-roots.test.sh"
cat >"$SAFE_ROOTS" <<'EOF'
#!/usr/bin/env bash
TMUX_TMPDIR=/tmp2 tmux list-sessions
TMUX_TMPDIR=$TAP_SUITE_SANDBOX tmux list-sessions
EOF
set +e
safe_roots_out="$("$PY" -B "$LINT" "$SAFE_ROOTS" 2>&1)"
safe_roots_rc=$?
set -e
[ "$safe_roots_rc" -eq 0 ] \
  || fail "(1b2) non-root prefixes must stay safe: rc=$safe_roots_rc $safe_roots_out"
[ -z "$safe_roots_out" ] \
  || fail "(1b2) non-root prefixes produced findings: $safe_roots_out"
echo "suite-tmux-isolation: (1b2) /tmp2 and suite-variable roots are not literal root resets: ok"

# A before-only operator session is temporal evidence, not causal attribution:
# the operator may legitimately close it while a long gate is running.
printf '%s\n' unrelated-operator-session >"$WORK/tmux-before"
: >"$WORK/tmux-after"
: >"$WORK/tmux-attributed"
set +e
temporal_out="$(
  smoke_tmux_state_predicate \
    "$WORK/tmux-before" "$WORK/tmux-after" "$WORK/tmux-attributed" 2>&1
)"
temporal_rc=$?
set -e
[ "$temporal_rc" -eq 0 ] \
  || fail "(1c) temporal-only operator-session disappearance failed the predicate: $temporal_out"
grep -q 'temporal-only.*unrelated-operator-session' <<<"$temporal_out" \
  || fail "(1c) temporal-only disappearance note missing: $temporal_out"
echo "suite-tmux-isolation: (1c) operator-session disappearance is temporal-only: ok"

# (2) The runtime guard forwards private/default calls and refuses every shape
# whose effective real-tmux socket escapes the baked suite root.
GUARD_DIR="$WORK/guard"
MARKER="$WORK/escapes.tsv"
REAL_LOG="$WORK/real.tsv"
mkdir -p "$SUITE_ROOT" "$GUARD_DIR"
cat >"$WORK/real-tmux" <<'EOF'
#!/usr/bin/env bash
printf '%s\t%s\n' "${TMUX:-unset}|${TMUX_TMPDIR:-unset}" "$*" >>"$SMOKE_FAKE_REAL_LOG"
exit 0
EOF
chmod +x "$WORK/real-tmux"
export SMOKE_FAKE_REAL_LOG="$REAL_LOG"

SMOKE_TMUX_SOCKET_LIMIT=90
smoke_install_tmux_guard "$GUARD_DIR" "$WORK/real-tmux" "$SUITE_ROOT" "$MARKER"
[ "$(cat "$GUARD_DIR/socket-limit" 2>/dev/null || true)" = 90 ] \
  || fail "(2) runtime guard did not bake the entry socket limit"
export PATH="$GUARD_DIR:$PATH"
unset TMUX TMUX_PANE
TMUX_TMPDIR="$SUITE_ROOT" tmux list-sessions
TMUX_TMPDIR="$SUITE_ROOT" tmux -L private-name list-sessions
TMUX_TMPDIR="$SUITE_ROOT" tmux -S "$SUITE_ROOT/tmux-$(id -u)/private" list-sessions
[ "$(wc -l <"$REAL_LOG" | tr -d ' ')" -eq 3 ] || fail "(2) private calls did not reach real tmux"
TMUX_TMPDIR="$SUITE_ROOT" tmux new-session -d -s retained-name
TMUX_TMPDIR="$SUITE_ROOT" tmux kill-session -t retained-name
grep -qx 'retained-name' "$GUARD_DIR/session-names" \
  || fail "(2) guard did not retain an attributed session name across cleanup"

OUTSIDE_ROOT="$WORK/outside"
BAD_NAME="../operator"
LONG_NAME="$(printf 'x%.0s' {1..120})"
BUDGET_PREFIX="$(cd "$SUITE_ROOT" && pwd -P)/tmux-$(id -u)/"
BUDGET_NAME="$(printf 'x%.0s' $(seq 1 $((95 - ${#BUDGET_PREFIX}))))"
for shape in inherited-tmux unset-root reset-root external-s glued-external-s private-name-escape glued-name-escape overlong-name baked-limit; do
  before="$(wc -l <"$REAL_LOG" | tr -d ' ')"
  set +e
  case "$shape" in
    inherited-tmux) TMUX="$OUTSIDE_ROOT/operator,1,0" TMUX_TMPDIR="$SUITE_ROOT" tmux list-sessions ;;
    unset-root) env -u TMUX -u TMUX_TMPDIR tmux list-sessions ;;
    reset-root) TMUX_TMPDIR="$OUTSIDE_ROOT" tmux list-sessions ;;
    external-s) TMUX_TMPDIR="$SUITE_ROOT" tmux -S "$OUTSIDE_ROOT/operator" list-sessions ;;
    glued-external-s) TMUX_TMPDIR="$SUITE_ROOT" tmux -S"$OUTSIDE_ROOT/operator" list-sessions ;;
    private-name-escape) TMUX_TMPDIR="$SUITE_ROOT" tmux -L "$BAD_NAME" list-sessions ;;
    glued-name-escape) TMUX_TMPDIR="$SUITE_ROOT" tmux -L"$BAD_NAME" list-sessions ;;
    overlong-name) TMUX_TMPDIR="$SUITE_ROOT" tmux -L "$LONG_NAME" list-sessions ;;
    baked-limit) TMUX_TMPDIR="$SUITE_ROOT" tmux -L "$BUDGET_NAME" list-sessions ;;
  esac >/dev/null 2>&1
  rc=$?
  set -e
  [ "$rc" -eq 97 ] || fail "(2) $shape escape returned $rc, expected 97"
  [ "$(wc -l <"$REAL_LOG" | tr -d ' ')" -eq "$before" ] || fail "(2) $shape reached real tmux"
done
[ "$(wc -l <"$MARKER" | tr -d ' ')" -eq 9 ] || fail "(2) escape marker count changed"
echo "suite-tmux-isolation: (2) runtime effective-socket guard: ok"

# (3) Cleanup removes only the recorded root after lsof proves it unowned.
OWNED_ROOT="$(mktemp -d /tmp/tap-tmux.cleanup.XXXXXX)"
exec 9>"$OWNED_ROOT/held"
if smoke_remove_tmux_root "$OWNED_ROOT" 2>/dev/null; then
  fail "(3) cleanup removed a tmux root with a live file owner"
fi
[ -d "$OWNED_ROOT" ] || fail "(3) owned tmux root was not retained"
exec 9>&-
smoke_remove_tmux_root "$OWNED_ROOT"
[ ! -e "$OWNED_ROOT" ] || fail "(3) unowned recorded tmux root was retained"
echo "suite-tmux-isolation: (3) recorded-root cleanup waits for zero owners: ok"

# (4) Known-defect receipts remain a strict arm-level class, independent of
# tracker availability and of the retired tmux classification.
KNOWN_LOG="$WORK/known-defect.log"
tap_smoke_known_defect tap-xk0yr 2026-08-24 "drain crossing reverted silently" >"$KNOWN_LOG"
[ "$(smoke_known_defect_receipt "$KNOWN_LOG")" = "known-defect: 1 (tap-xk0yr)" ] \
  || fail "(4) known-defect receipt missing"
printf '%s\n' 'KNOWN-DEFECT not-tabbed' >"$WORK/malformed.log"
if smoke_known_defect_receipt "$WORK/malformed.log" >/dev/null 2>&1; then
  fail "(4) malformed marker was accepted"
fi
if tap_smoke_known_defect tap-xk0yr 2026-08-24 description extra >/dev/null 2>&1; then
  fail "(4) extra known-defect field was accepted"
fi
echo "suite-tmux-isolation: (4) known-defect receipt: ok"

echo "suite-tmux-isolation: ok"
