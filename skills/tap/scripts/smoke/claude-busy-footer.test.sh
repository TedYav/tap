#!/usr/bin/env bash
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# claude-busy-footer.test.sh — tap-4n5h P0: a GENERATING claude seat read as idle.
#
# `tap_seat_state` (now runtime/bun/src/seat-state.ts) step (2) BUSY-FOOTER GATES had arms for opencode and cursor
# and NONE for claude, so a claude seat mid-turn fell through to
# `idle-at-prompt`. Ten of this team's seats are claude, and the WORKING==0
# detector consumes that census — so a working board reported DEADLOCK and woke
# the feeder every 60s. The comment above that case block already named the
# hazard the code did not cover.
#
# THE CORPUS IS REAL, captured same-instant (tap_seat_state output beside the
# pane) at 2026-08-19T23:28:11Z, not synthesised here:
#   pine-gate       esc_to_interrupt=1  <- DIVERGENCE: reported idle while generating
#   pine-driver-D   esc_to_interrupt=1  <- DIVERGENCE
#   pine-driver-C   esc_to_interrupt=0  <- NEGATIVE CONTROL: genuinely idle
#
# The control is the point. A fix that reports `working` for every claude seat
# passes both divergences and FAILS the control — and that control exists by luck
# of timing (driver-C's turn ended between observations), so it is not
# manufacturable now. Build to all three.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
CORPUS="$ROOT/skills/tap/scripts/smoke/fixtures/census-false-idle-20260819"
# shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"

for f in pine-gate pine-driver-D pine-driver-C; do
  [ -f "$CORPUS/$f.pane.txt" ] || { echo "cbf: corpus missing $f.pane.txt" >&2; exit 1; }
done

# (1) The two divergences must read BUSY.
for seat in pine-gate pine-driver-D; do
  state="$(tap_bun_call claude-seat-state frame agent-state.ts claude-seat-state < "$CORPUS/$seat.pane.txt")" \
    || { echo "cbf: (1) $seat the native seat-state call failed" >&2; exit 1; }
  [ "$state" = working ] \
    || { echo "cbf: (1) $seat generating (esc to interrupt present) was NOT read as busy" >&2; exit 1; }
done
echo "cbf: (1) a generating claude pane is read as busy: ok"

# (2) THE NEGATIVE CONTROL. Its footer is the same shape minus the marker, so a
#     fix that keys on anything BUT the marker — harness name, footer presence,
#     the bypass-permissions banner — passes (1) and dies here.
state="$(tap_bun_call claude-seat-state frame agent-state.ts claude-seat-state < "$CORPUS/pine-driver-C.pane.txt")" \
  || { echo "cbf: (2) the native seat-state call failed" >&2; exit 1; }
[ "$state" != working ] \
  || { echo "cbf: (2) a genuinely idle claude pane was reported busy — 'always working' is not a fix" >&2; exit 1; }
echo "cbf: (2) a genuinely idle claude pane is NOT read as busy: ok"

# (3) POSITION MATTERS. The marker is a FOOTER element on the last rendered line.
#     Matching the whole capture would make any seat that MENTIONS the string —
#     including a seat working on this very bug — permanently "busy", which is
#     the false-BUSY direction and strictly worse than the bug being fixed.
{ printf 'we fixed it by grepping for esc to interrupt in the pane\n'
  cat "$CORPUS/pine-driver-C.pane.txt"; } > "$CORPUS/../.cbf-mention.txt"
state="$(tap_bun_call claude-seat-state frame agent-state.ts claude-seat-state < "$CORPUS/../.cbf-mention.txt")" \
  || { echo "cbf: (3) the native seat-state call failed" >&2; rm -f "$CORPUS/../.cbf-mention.txt"; exit 1; }
[ "$state" != working ] \
  || { echo "cbf: (3) a TRANSCRIPT MENTION of the marker was read as busy" >&2; rm -f "$CORPUS/../.cbf-mention.txt"; exit 1; }
rm -f "$CORPUS/../.cbf-mention.txt"
echo "cbf: (3) a transcript mention of the marker is not a busy signal: ok"

# (4) The gate must be wired for the `claude` harness token specifically — ten of
#     this team's seats carry it, and an arm that exists but is never reached is
#     the same outcome as no arm. So the whole native seat-state ladder runs over
#     the corpus for an active `claude` row with no other working evidence (no
#     window activity, no fresh transcript): only the claude busy-footer arm can
#     answer `working` for the divergence, and the control must not.
WORK4="$(mktemp -d)"
trap 'rm -rf "$WORK4"' EXIT
printf '{"schema":"0.20","team":{"name":"cbf"},"seats":{"s":{"status":"active","pane":"%%1","harness":"claude"}}}' > "$WORK4/registry.json"
ladder() { # <corpus-seat> -> the native seat state over that frame
  (cd "$ROOT/runtime/bun" && bun -e '
    import { readFileSync } from "node:fs";
    import { frameIo } from "./src/pane/reader";
    import { seatState } from "./src/seat-state";
    const [frame, work] = process.argv.slice(1);
    process.stdout.write(seatState("s", { registry: work + "/registry.json", home: work,
      env: { TAP_WATCH_NOW: "1000", TAP_SEAT_STATE_READONLY: "1" },
      deps: { io: frameIo(readFileSync(frame, "utf8"), "200"), display: (_p, f) => (f === "#{pane_id}" ? "%1" : ""),
        transcriptFresh: () => false } }));
  ' "$CORPUS/$1.pane.txt" "$WORK4")
}
state="$(ladder pine-gate)"
[ "$state" = working ] || { echo "cbf: (4) the seat-state ladder read a generating claude seat as '$state'" >&2; exit 1; }
state="$(ladder pine-driver-C)"
[ "$state" != working ] || { echo "cbf: (4) the seat-state ladder read the idle control as working" >&2; exit 1; }
echo "cbf: (4) the seat-state ladder routes a claude row through the busy-footer gate: ok"

echo "claude-busy-footer: ok"
