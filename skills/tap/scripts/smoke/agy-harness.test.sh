#!/usr/bin/env bash
# tap-o4ae: fixture env (fake tmux on PATH) must stay in this process. Refuse
# `source` so an interactive shell cannot inherit top-level exports.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# agy-harness.test.sh — tap-luae: Antigravity/Gemini (agy) harness support.
#
# agy is a hybrid: a '>' glyph prompt (like claude) whose band is a '>' row bracketed
# by two full-width '─' rules with a status footer below, and — like opencode — the
# band STAYS on screen while generating. Readiness is therefore BAND PRESENCE minus a
# recognized permission modal, never the footer's turn vocabulary (tap-92v3r): the operator
# verified by hand on a live seat that typing into the Antigravity TUI mid-generation
# QUEUES the message exactly as Claude Code and Codex do, so a visible band is
# permission to type wherever in the pane it sits — unless a modal is asking for a
# decision, which geometry alone cannot see. Fixtures
# are real geometry (fixture-realism, no fantasy tmux): the %229 captures, plus the
# 2026-09-03 live captures of a Gemini conductor seat (%243, idle) and
# a Gemini roster seat (%254, mid-tool-loop with a task card BELOW the band).
# Proves:
#   1. classification: agy is an agent family (else -> 'unsafe');
#   2. readiness: a band between the rule pair is injectable whether the footer says
#      '? for shortcuts' or 'esc to cancel', and whether or not a spinner and a task
#      card are rendered around it; a pane with NO rule-pair band defers, and so does
#      a recognized permission modal even though its band IS present;
#   3. dispatch: the native pending-text reader routes an agy pane to ready / defer(rc3) / draft,
#      reading the live band chrome-free and anchored to the live prompt-bearing rule
#      pair — a stale transcript echo and a lower task card never win.
# The band extractor itself is native (agyComposer, runtime/bun/src/submit-frame.ts,
# driven by runtime/bun/test/submit-frame.test.ts); the prompt glyph and line
# patterns are runtime/bun/src/pane/geometry.ts (agy-band-characterization.test.ts).
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
export TAP_HOME="$(mktemp -d)"
FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$TAP_HOME" "$FAKE_BIN"' EXIT
# shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"

# The native agy modal predicate (submit-frame.ts): 0 overlay, 1 none; a broken
# answer fails closed as an overlay, as the retired lib adapter did.
agy_overlay() {
  local r
  r="$(tap_bun_call agy-permission-overlay frame submit-frame.ts agy-permission-overlay)" || return 0
  [ "$r" != no ]
}

# The native pane reader through a test fixture bridge, fed the two captures the retired
# lib.sh adapter took (escaped, then plain; both joined). rc 3 no band, 4 blocked,
# 5 overprint; otherwise the pending text on stdout.
pending_text() { # <pane> <harness>
  local esc plain v
  esc="$(tmux capture-pane -J -p -e -t "$1"; printf X)"; esc="${esc%X}"
  plain="$(tmux capture-pane -J -p -t "$1"; printf X)"; plain="${plain%X}"
  v="$( { printf '%s\n%s%s' "$(printf '%s' "$esc" | wc -c | tr -d ' ')" "$esc" "$plain" \
    | bun "$ROOT/runtime/bun/test/support/pending-input-cli.ts" "$1" "$2"; printf X; } )" || return 1
  v="${v%X}"
  case "$v" in
    no-band) return 3 ;; blocked) return 4 ;; overprint) return 5 ;;
    text$'\x1f'*) printf '%s' "${v#text$'\x1f'}" ;;
    *) return 1 ;;
  esac
}

pass=0; fail=0
ok()   { echo "  ok   $1"; pass=$((pass + 1)); }
bad()  { echo "  FAIL $1" >&2; fail=$((fail + 1)); }
eq()   { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: got [$2] want [$3]"; fi; }

# Real agy band geometry: a full-width '─' rule (byte-length well over the 30-byte
# / 10-cell rule floor).
CAP="$ROOT/skills/tap/scripts/smoke/fixtures/agy-capture-20260903"
RULE="$(printf '─%.0s' $(seq 1 100))"
IDLE_FOOTER="? for shortcuts                                                          Gemini 3.6 Flash · high"
BUSY_FOOTER="esc to cancel                                                            Gemini 3.6 Flash · high"

idle_cap()  { printf '%s\n' "  Standing by idle-warm." "$RULE" "> " "$RULE" "$IDLE_FOOTER"; }
busy_cap()  { printf '%s\n' "● Read(/Users/dev/.gemini/antigravity-cli/builtin/skills/antigravity_guide/SKILL.md)" \
                            "⣷  Generating..." "$RULE" "> " "$RULE" "$BUSY_FOOTER"; }
draft_cap() { printf '%s\n' "  Some transcript line above." "$RULE" "> ping teammate about the build" "$RULE" "$IDLE_FOOTER"; }
# Anti-anchor: a stale exit banner + a transcript '>' echo ABOVE the live band — the
# bottom-anchored capture must ignore both (fable's render-position-anchor caution).
anti_cap()  { printf '%s\n' "Resume with -c: agy --conversation=7fe99dee-01b7-4e1c-b5a3-816bd12511c3" \
                            "> stale submitted message echoed into the transcript" "  ...response text..." \
                            "$RULE" "> LIVE DRAFT ONLY" "$RULE" "$IDLE_FOOTER"; }
# A running background task adds a third full-width rule below the prompt: the
# prompt's lower rule doubles as the task card's upper rule. The bottom-most rule
# pair therefore encloses task chrome, not input.
task_cap()  { printf '%s\n' "  Standing by with a background task." \
                            "$RULE" "> " "$RULE" "● [20:09:23] sleep 300 running" \
                            "$RULE" "$IDLE_FOOTER"; }
task_draft_cap() { printf '%s\n' "  Standing by with a background task." \
                                  "$RULE" "> task-aware draft" "$RULE" \
                                  "● [20:09:23] sleep 300 running" "$RULE" "$IDLE_FOOTER"; }
# tap-92v3r fixtures. TOOL_FOOTER is the real 2026-09-03 %254 footer, task-count
# suffix included; the shape is that capture line for line — spinner ABOVE the band's
# top rule, a THIRD rule below the band, and the task card between it and the footer.
# This is the pane the courier read as no-prompt for five minutes.
TOOL_FOOTER="esc to cancel                                     Gemini 3.8 Flash · high · 1 task(s) · /tasks"
tool_cap()  { printf '%s\n' "● ManageTask(status db340fb9-a08a-4027-9e8d-7d359e1386f8/task-715) (ctrl+o to expand)" \
                            "⣽  Working..." "$RULE" "> " "$RULE" \
                            "  ● [00:46:22] bun test runtime/bun/test/team.test.ts running" \
                            "$RULE" "$TOOL_FOOTER"; }
# A generating turn with NO background task — the third required shape, and now a real
# capture rather than a reconstruction. %243 mid-command, 2026-09-03: spinner above the
# band's top rule, band between the rule pair, `esc to cancel` footer, and no task card.
# Round 2 of this unit shipped this shape as a printf rebuild of the leader's quoted
# capture; the courier reviewer held it blocking, correctly — a rebuilt fixture can only
# contain the geometry its author already believed, which is the exact failure mode this
# whole change is about. Read from the file like the others.
gen_cap()   { cat "$CAP/generating-243.txt"; }
# The one shape that is genuinely uninjectable by GEOMETRY: no rule-pair band
# anywhere. A bare '>' line with no rules is not a band — the render-position anchor
# is what keeps a transcript echo from passing for one. CONSTRUCTED, and it has to
# be: every agy pane on this fleet renders the band (PROVENANCE.md records the
# survey of nine).
noband_cap() { printf '%s\n' "  A full-screen overlay with no input band." \
                             "> a transcript echo, not the live band" "  ...more text..."; }
# A permission modal that leaves the band RENDERED — the case geometry alone cannot
# refuse, and the reason the agy overlay predicate exists. Also CONSTRUCTED, and
# for a sharper reason than the one above: this fleet runs
# --dangerously-skip-permissions, so no live agy pane produces this modal at all.
# Its vocabulary is taken from the repo's existing agy permission rule
# (runtime/bun/src/agent-state.ts:180-190) and its geometry from the real %228/%254
# captures, which prove this TUI renders content BELOW the band. A real capture is
# the acceptance criterion of tap-lslrc; until then this arm pins the refusal's POLARITY,
# not the modal's exact appearance.
overlay_cap() { printf '%s\n' "  Some transcript line above." "$RULE" "> " "$RULE" \
                              "Requesting permission for: run_shell_command" \
                              "Do you want to proceed?" "Yes · No · Tab amend"; }
# THE DISCRIMINATORS, and they are what make the refusal positional rather than a
# tail scan. Round 1 of this unit shipped a tail scan plus a one-phrase fixture; the
# fixture agreed with the code and the courier reviewer refuted both with one line — a
# seat whose TRANSCRIPT discusses permission prompts carries both phrases and a live
# idle band, and the tail scan deferred ordinary delivery to it forever. That is the
# tap-4n5h false-positive class arriving through the matcher's SHAPE instead of its
# words, which is why the fix was positional and not a longer phrase list.
#
# mention_cap carries one phrase; mention_both_cap carries BOTH, above the band, which
# is the counterexample that killed the tail scan. Only the second one discriminates a
# tail scan from a positional match — keep it, and keep it above the band, or the next
# reader will "simplify" the position check back out.
mention_cap() { printf '%s\n' "  I am reading tap_agy_permission_overlay, which matches" \
                              "  Requesting permission for: <tool> in the bottom region." \
                              "$RULE" "> " "$RULE" "$IDLE_FOOTER"; }
mention_both_cap() { printf '%s\n' "  Reviewing the overlay helper. It fires only when a pane shows" \
                                   "  Requesting permission for: <tool> together with" \
                                   "  Do you want to proceed? — rendered BELOW the band." \
                                   "$RULE" "> " "$RULE" "$IDLE_FOOTER"; }

echo "agy-harness: 1/3 - classification"
eq   "classify agy = agent"        "$(tap_classify_harness agy)"     "agent"

echo "agy-harness: 2/3 - permission overlay (the refusal geometry alone cannot make)"
if overlay_cap | agy_overlay; then ok "permission overlay -> recognized, fail-closed"; else bad "permission overlay -> recognized"; fi
if idle_cap    | agy_overlay; then bad "idle must not read as a permission overlay"; else ok "idle -> no overlay"; fi
if tool_cap    | agy_overlay; then bad "tool-running must not read as a permission overlay"; else ok "tool-running -> no overlay"; fi
if mention_cap | agy_overlay; then bad "a transcript MENTION must not read as a permission overlay"; else ok "transcript mention -> no overlay (the second conjunct earns its place)"; fi
if mention_both_cap | agy_overlay; then bad "a transcript quoting BOTH phrases above a live band must not read as a permission overlay (the tail-scan defect)"; else ok "transcript quoting both phrases -> no overlay (position, not vocabulary, decides)"; fi

echo "agy-harness: 3/3 - dispatch via the native pending-text reader (fake tmux capture-pane)"
# Minimal fake tmux: capture-pane -p returns the fixture named by FIX; other verbs no-op.
cat > "$FAKE_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = capture-pane ] || exit 0
cat "${FIX:?fake tmux: FIX unset}"
EOF
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH"
FIXDIR="$(mktemp -d)"; trap 'rm -rf "$TAP_HOME" "$FAKE_BIN" "$FIXDIR"' EXIT
idle_cap > "$FIXDIR/idle"; busy_cap > "$FIXDIR/busy"; draft_cap > "$FIXDIR/draft"
task_cap > "$FIXDIR/task"; task_draft_cap > "$FIXDIR/task-draft"
gen_cap > "$FIXDIR/gen"; tool_cap > "$FIXDIR/tool"; noband_cap > "$FIXDIR/noband"
overlay_cap > "$FIXDIR/overlay"; mention_cap > "$FIXDIR/mention"
mention_both_cap > "$FIXDIR/mention-both"; anti_cap > "$FIXDIR/anti"

FIX="$FIXDIR/idle"  rc=0; out="$(FIX="$FIXDIR/idle"  pending_text %agy agy)" || rc=$?
eq   "idle -> rc0 + empty (ready)"  "$rc:$out"  "0:"
rc=0; out="$(FIX="$FIXDIR/busy"  pending_text %agy agy)" || rc=$?
eq   "generating -> rc0 + empty (inject, queues)" "$rc:$out" "0:"
rc=0; out="$(FIX="$FIXDIR/gen"  pending_text %agy agy)" || rc=$?
eq   "spinner+esc to cancel -> rc0 + empty"       "$rc:$out" "0:"
rc=0; out="$(FIX="$FIXDIR/tool" pending_text %agy agy)" || rc=$?
eq   "tool-running (%254 shape) -> rc0 + empty"   "$rc:$out" "0:"
rc=0; out="$(FIX="$FIXDIR/noband" pending_text %agy agy)" || rc=$?
eq   "no band -> rc3 (defer/spool)"               "$rc"      "3"
rc=0; out="$(FIX="$FIXDIR/overlay" pending_text %agy agy)" || rc=$?
# rc 4, NOT rc 3, since ruling 15 item 3 (tap-7r3fn.13). Both are non-zero and neither
# yields a pending string, so nothing that merely asks "is there text to protect?" changed.
# What changed is that the two answers stopped sharing one code: rc 3 means "no readable
# band here" — an absence of evidence the forced-injection bound is allowed to push
# through — and rc 4 means "a human is being asked a question", which it may never type
# over. While both were 3 the bound had nothing to exclude on, so "only a visible dialog
# holds" could not be expressed at all.
#
# The band is visible in this fixture and that is still the point of the arm: geometry
# alone says inject, and the overlay refusal is what stops it.
eq   "permission overlay -> rc4 (modal), not rc3, despite a visible band" "$rc" "4"
rc=0; out="$(FIX="$FIXDIR/mention" pending_text %agy agy)" || rc=$?
eq   "transcript mention of the modal -> rc0 (still injectable)" "$rc:$out" "0:"
rc=0; out="$(FIX="$FIXDIR/mention-both" pending_text %agy agy)" || rc=$?
eq   "transcript quoting BOTH phrases -> rc0 (still injectable)" "$rc:$out" "0:"
rc=0; out="$(FIX="$FIXDIR/draft" pending_text %agy agy)" || rc=$?
eq   "draft -> rc0 + draft (busy)"  "$rc:$out"  "0:ping teammate about the build"
rc=0; out="$(FIX="$FIXDIR/task" pending_text %agy agy)" || rc=$?
eq   "task card -> rc0 + empty (ready)" "$rc:$out" "0:"
rc=0; out="$(FIX="$FIXDIR/task-draft" pending_text %agy agy)" || rc=$?
eq   "task card + draft -> real draft" "$rc:$out" "0:task-aware draft"
rc=0; out="$(FIX="$FIXDIR/anti" pending_text %agy agy)" || rc=$?
eq   "anti-anchor: stale transcript echo above -> live band draft only" "$rc:$out" "0:LIVE DRAFT ONLY"

echo "agy-harness: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
echo "agy-harness: all checks passed"
