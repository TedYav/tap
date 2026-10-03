#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tap-pane-state-mutants.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# One common scratch materialization. Baseline it green before any edit so a
# missing copy, bad fixture path, or runner error cannot make every mutant
# look "proven RED" (sol-detector-partner B1 reject: any-nonzero-is-RED).
BASE="$WORK/base"
mkdir -p "$BASE/runtime/bun/src" "$BASE/runtime/bun/test/support" \
  "$BASE/runtime/bun/test/fixtures/opencode-capture"
mkdir -p "$BASE/skills/tap/scripts/smoke/fixtures/pane-state"
cp -R "$ROOT/runtime/bun/src/." "$BASE/runtime/bun/src/"
# fzf-tool.ts imports ../../../vendor/fzf/manifest.json relative to the copied src.
mkdir -p "$BASE/vendor/fzf"; cp "$ROOT/vendor/fzf/manifest.json" "$BASE/vendor/fzf/manifest.json"
cp "$ROOT/runtime/bun/main.ts" "$BASE/runtime/bun/main.ts"
cp "$ROOT/runtime/bun/test/pane-state.test.ts" "$BASE/runtime/bun/test/pane-state.test.ts"
cp "$ROOT/runtime/bun/test/opencode-composer.test.ts" "$BASE/runtime/bun/test/opencode-composer.test.ts"
cp "$ROOT/runtime/bun/test/send-census-bounds.test.ts" "$BASE/runtime/bun/test/send-census-bounds.test.ts"
cp -R "$ROOT/runtime/bun/test/support/." "$BASE/runtime/bun/test/support/"
cp -R "$ROOT/runtime/bun/test/fixtures/opencode-capture/." \
  "$BASE/runtime/bun/test/fixtures/opencode-capture/"
cp -R "$ROOT/skills/tap/scripts/smoke/fixtures/pane-state/." \
  "$BASE/skills/tap/scripts/smoke/fixtures/pane-state/"
# opencode-composer.test.ts walks these three fixture directories.
for d in submit-verify peek-harness-adapters opencode-splash; do
  mkdir -p "$BASE/skills/tap/scripts/smoke/fixtures/$d"
  cp -R "$ROOT/skills/tap/scripts/smoke/fixtures/$d/." \
    "$BASE/skills/tap/scripts/smoke/fixtures/$d/"
done
cp "$ROOT/runtime/bun/test/generic-band-cursor-hermes.test.ts" \
  "$BASE/runtime/bun/test/generic-band-cursor-hermes.test.ts"
mkdir -p "$BASE/skills/tap/scripts/smoke/fixtures/hermes-prompt"
cp -R "$ROOT/skills/tap/scripts/smoke/fixtures/hermes-prompt/." \
  "$BASE/skills/tap/scripts/smoke/fixtures/hermes-prompt/"

if ! (cd "$BASE/runtime/bun" && "$ROOT/runtime/bun/test/run.sh" \
  test/pane-state.test.ts test/opencode-composer.test.ts test/generic-band-cursor-hermes.test.ts) >"$WORK/baseline.out" 2>&1; then
  echo "pane-state-mutants: unmodified scratch materialization failed (not a mutant)" >&2
  cat "$WORK/baseline.out" >&2
  exit 1
fi
echo "pane-state-mutants: scratch baseline green"

# The send mutant must pass its own selected control before mutation. The pane
# classifier baseline alone cannot detect a missing send entry point or filter.
if ! (cd "$BASE/runtime/bun" && "$ROOT/runtime/bun/test/run.sh" \
  test/send-census-bounds.test.ts -t 'copy-mode native send parks with zero injection') >"$WORK/send-baseline.out" 2>&1; then
  echo "pane-state-mutants: unmodified send control failed (not a mutant)" >&2
  cat "$WORK/send-baseline.out" >&2
  exit 1
fi
echo "pane-state-mutants: send control baseline green"

run_mutant() {
  local name="$1" before="$2" after="$3" rel="${4:-runtime/bun/src/pane-state.ts}"
  local testrel="${5:-test/pane-state.test.ts}" filter="${6:-}" rc=0
  local tree="$WORK/$name" out="$WORK/$name.out"
  mkdir -p "$tree"
  cp -R "$BASE/." "$tree/"
  BEFORE="$before" AFTER="$after" python3 -B - "$tree/$rel" <<'PY'
import os, pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
before, after = os.environ["BEFORE"], os.environ["AFTER"]
if text.count(before) != 1:
    raise SystemExit(f"mutation anchor count={text.count(before)} for {before!r}")
path.write_text(text.replace(before, after))
PY
  local extra=()
  if [ -n "$filter" ]; then extra+=(-t "$filter"); fi
  (cd "$tree/runtime/bun" && "$ROOT/runtime/bun/test/run.sh" "$testrel" "${extra[@]}") >"$out" 2>&1 || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "pane-state-mutants: $name SURVIVED" >&2
    cat "$out" >&2
    exit 1
  fi
  # Proof is the assertion excerpt itself, not the exit code: require the
  # failing-test marker AND both halves of an expectation diff. Bun prints
  # the assertion block above the (fail) line, so the printed window is
  # first error through the failing-test line.
  if ! grep -q '(fail)' "$out" || ! grep -q 'Expected' "$out" || ! grep -q 'Received' "$out"; then
    echo "pane-state-mutants: $name exited nonzero without a failing assertion excerpt (not proven RED)" >&2
    cat "$out" >&2
    exit 1
  fi
  echo "pane-state-mutants: $name failure evidence:" >&2
  sed -n '/error:/,/(fail)/p' "$out" | head -30 >&2
  echo "pane-state-mutants: $name proven RED"
}

run_mutant copy-mode-first \
  'if (copyMode) return { kind: "copy-mode" as const };' \
  'if (false) return { kind: "copy-mode" as const };'
run_mutant u2500-10-cell-floor \
  'export const CLAUDE_BORDER_CELLS = 10;' \
  'export const CLAUDE_BORDER_CELLS = 10000;'
run_mutant no-box-is-no-band \
  'if (!box) return { kind: "no-band", reason: "no recognized Claude input box" };' \
  'if (!box) return { kind: "ready" };'
run_mutant live-pane-in-mode-peek \
  'if (flag === "1") return { status: "copy-mode" };' \
  'if (flag === "never") return { status: "copy-mode" };'
run_mutant pane-in-mode-catchall-normal \
  'return { status: "unobservable", reason: `unrecognized pane_in_mode ${JSON.stringify(flag)}` };' \
  'return { status: "normal" };'
# Alias the imported binding so the mutant stays executable: observeCopyMode
# still calls tmux(), but the name is the unbudgeted seam. A missing-symbol
# swap is not causal (sol-detector-partner HOLD at e4b5418e).
run_mutant copy-mode-uses-budgeted-tmux \
  '  tmux,' \
  '  tmuxReadOnly as tmux,' \
  runtime/bun/src/pane-state.ts \
  test/pane-state.test.ts \
  'observeCopyMode uses the budgeted tmux client'
run_mutant copy-mode-fail-is-gone \
  'if (again?.state === "gone") return { status: "gone" };' \
  'if (false) return { status: "gone" };'
run_mutant copy-mode-unobservable-is-refusal \
  'if (obs?.status === "unobservable") return { status: "band_busy", bandState: "unobservable", detail: obs.reason };' \
  'if (false) return { status: "band_busy", detail: obs.reason };' \
  runtime/bun/src/courier.ts
run_mutant copy-mode-initial-pre-effect \
  'if (initialCopy) return initialCopy;' \
  'if (false) return initialCopy;' \
  runtime/bun/src/courier.ts
run_mutant copy-mode-final-pre-effect \
  'if (finalCopy) return finalCopy;' \
  'if (false) return finalCopy;' \
  runtime/bun/src/courier.ts
run_mutant copy-mode-mid-resample \
  'if (mid) return mid;' \
  'if (false) return mid;' \
  runtime/bun/src/courier.ts
run_mutant copy-mode-mid-unobservable-preserves-blocked \
  'if (obs.status === "gone") return { status: "pane_gone", detail: `pane '"'"'${pane}'"'"' does not exist` };' \
  'if (obs.status === "gone") return { status: "pane_gone", detail: `pane '"'"'${pane}'"'"' does not exist` };
  if (obs.status === "unobservable") return { status: "band_busy", detail: obs.reason };' \
  runtime/bun/src/courier.ts
run_mutant copy-mode-gone-is-pane-gone \
  'if (obs.status === "gone") return { status: "pane_gone", detail: `pane '"'"'${pane}'"'"' does not exist` };' \
  'if (false) return { status: "pane_gone", detail: `pane '"'"'${pane}'"'"' does not exist` };' \
  runtime/bun/src/courier.ts
run_mutant copy-mode-rate-limited-is-distinct \
  'if (obs.status === "rate-limited") return { status: "rate_limited", detail: obs.reason };' \
  'if (false) return { status: "rate_limited", detail: obs.reason };' \
  runtime/bun/src/courier.ts
run_mutant copy-mode-unobservable-after-live-is-gone \
  ': afterLiveNoBand(target, mode.reason);' \
  ': { kind: "no-band", reason: mode.reason };'
run_mutant claude-capture-fail-after-live-is-gone \
  'return afterLiveNoBand(target, `capture-pane failed for '"'"'${target}'"'"'`);' \
  'return { kind: "no-band", reason: `capture-pane failed for '"'"'${target}'"'"'` };'
# The Claude/Cursor/Hermes route is escaped-capture; dropping the flag feeds the
# reader plain bytes where it expects the prompt-dimming SGR markers. The
# hermes-profile arm is the discriminator, not Cursor wording.
run_mutant cursor-hermes-capture-unescaped \
  'const escaped = family === "claude" || family.startsWith("codex") || family === "opencode" || family.startsWith("cursor") || family.startsWith("hermes");' \
  'const escaped = false;' \
  runtime/bun/src/pane-state.ts \
  test/generic-band-cursor-hermes.test.ts \
  'hermes-profile rides the Hermes route'
# OpenCode's first-load placeholder differs from typed text only by paint, so an
# unescaped capture reads a fresh seat's welcome screen as a draft (tap-yqonr).
run_mutant opencode-capture-unescaped \
  'family.startsWith("codex") || family === "opencode" || family.startsWith("cursor")' \
  'family.startsWith("codex") || family.startsWith("cursor")' \
  runtime/bun/src/pane-state.ts \
  test/pane-state.test.ts \
  'a fresh OpenCode welcome screen is ready'
# tap-vctb8: the unanchored in-box scan is what catches a stderr line that
# WRAPS onto the footer or corner row, where both geometry gates bail false.
run_mutant opencode-unanchored-scan-dropped \
  'return geometryOverprint(frame) || inBoxDebrisOverprint(frame);' \
  'return geometryOverprint(frame);' \
  runtime/bun/src/opencode-composer.ts \
  test/opencode-composer.test.ts \
  'debris that wraps onto the footer row is still the overprint'
run_mutant hermes-arm-missing \
  '  const native = family === "claude" || family.startsWith("codex") ||
    family === "opencode" || family === "agy" ||
    family.startsWith("cursor") || family.startsWith("hermes");' \
  '  const native = family === "claude" || family.startsWith("codex") ||
    family === "opencode" || family === "agy" ||
    family.startsWith("cursor") || family.startsWith("never-hermes");' \
  runtime/bun/src/pane-state.ts \
  test/generic-band-cursor-hermes.test.ts \
  'hermes-profile rides the Hermes route'
run_mutant copy-mode-send-queues-not-park \
  '|| result.status === "rate_limited" || result.status === "copy_mode"' \
  '|| result.status === "rate_limited"' \
  runtime/bun/src/verbs/send.ts \
  test/send-census-bounds.test.ts \
  'copy-mode native send parks with zero injection'
# Owner callers must consume observePaneProbe, not paneState(): collapsing
# copy-mode through the frozen PaneBand path makes the typed kind disappear.
run_mutant owner-caller-consumes-typed-copy-mode \
  '  return toPaneProbe(observePaneKind(target, harness, command));' \
  '  const band = paneState(target, harness, command);
  return { kind: band.state === "unobservable" ? "no-band" : "ready" };' \
  runtime/bun/src/pane-state.ts \
  test/pane-state.test.ts \
  'observePaneProbe is the owner caller seam'
# Dim paint is what separates Claude's prompt-row chrome (the Try suggestion,
# the queued hint) from a human who typed the same sentence (tap-ybz1s);
# making the paint check vacuous must fail the undimmed-bytes control.
run_mutant claude-dim-chrome-ignores-paint \
  'return dimPlaceholder(capture.split("\n")[range.start] ?? "", typed, "claude");' \
  'return true;' \
  runtime/bun/src/pane-state.ts \
  test/pane-state.test.ts \
  'the same suggestion bytes without dim paint stay draft'

echo "pane-state-mutants: ok"
