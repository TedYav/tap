#!/usr/bin/env bash
# lead-doctrine-pins.test.sh — the supervision-doctrine pins that earned their place.
#
# PROVENANCE. This file is the residue of two decisions that collided. A cleanup deleted
# lead-structure.test.sh whole, as presence-theater: ~100 asserts that proved a string was
# present, none of which had ever been shown to fail when the thing it named was removed.
# A concurrent change was adding to that same file. The ruling: its doctrine prose lands, the
# old file stays deleted, and only the pins with MUTATION-RED EVIDENCE survive, here.
#
# THE ADMISSION RULE, and it is mechanical: a pin is in this file iff, during that change's review
# rounds 3-5, its sentence was removed from the source and this assertion went red naming it,
# then was restored to green. Every pin below carries that evidence in its own comment
# (letters are the mutation ids from the round reports). An assert with no such receipt is
# not weaker evidence — it is none, which is exactly what the cleanup deleted 100 of. Adding a pin
# here without running its mutation reintroduces the whole problem.
#
# WHAT THIS FILE IS NOT. It is not the /lead structure test reborn. Nothing here checks that
# a file exists, that frontmatter carries a stamp, that a word budget holds, or that a symlink
# points where it should. Those either had no failure they could catch, or are covered by a
# test that survived (skill discovery is install-skill-coverage's job).
#
# EXPECTED RED BEFORE INTEGRATION: every pin targets prose that change introduces. Against main
# alone the needles do not exist and this file reds on the first assert — correct, and the
# point: after it lands, a trim that quietly restores the earlier default reds here.
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)}"
# Read-only doc test — no tap invocation, no tmux, no network. The suite's env pins are
# sourced when present so the file also runs against an exported tree (REPO_ROOT=<dir>).
SANDBOX_PINS="$REPO_ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
[ -f "$SANDBOX_PINS" ] && . "$SANDBOX_PINS"

CHARTER="$REPO_ROOT/skills/lead/SKILL.md"
BEST_PRACTICES="$REPO_ROOT/skills/lead/references/choreography-best-practices.md"
USING_TAP="$REPO_ROOT/skills/tap/SKILL.md"

fail() { printf 'lead-doctrine-pins: FAIL: %s\n' "$*" >&2; exit 1; }

# Fence-stripping, inherited from the retired file's helper and kept for one concrete reason:
# these pins include a COMMAND STRING, and the natural way to "clean up" a recipe is to move
# it into a fenced block. Matching fenced text would let the live instruction disappear while
# the gate stayed green. Same three rules as the original: a fence closes only on its own
# marker character, a closer is at least as long as its opener, and a closer carries no info
# string. Up to three leading spaces per CommonMark; four or more is an indented code block.
live_prose() {
  awk '
    {
      s = $0; sub(/^ {0,3}/, "", s)
      c = substr(s, 1, 1); n = 0
      if (c == "`" || c == "~") { while (substr(s, n + 1, 1) == c) n++ }
      rest = substr(s, n + 1)
      if (open) {
        if (n >= 3 && c == fc && n >= fn && rest ~ /^[[:space:]]*$/) open = 0
        next
      }
      if (n >= 3) { open = 1; fc = c; fn = n; next }
      print
    }
  ' "$1"
}

# The prose is CAPTURED before matching, never piped into `grep -q`. Under `set -o pipefail` a
# -q grep closes the pipe on its first hit, awk takes SIGPIPE (141), and the pipeline reports
# failure for a needle that is present — a red naming the WRONG pin, on roughly four runs in
# five. Measured here, not theorized: the piped form misattributed 5 of 6 identical trials.
assert_pin() { # <file> <needle>
  local prose
  [ -f "$1" ] || fail "missing file: ${1#"$REPO_ROOT"/}"
  prose="$(live_prose "$1")"
  grep -Fq -- "$2" <<<"$prose" || fail "missing pin '$2' in live prose of ${1#"$REPO_ROOT"/}"
}

# --- skills/lead/SKILL.md — the three legs of the default, one pin each ----------------------
# Round 3 found the charter pinned only the LABEL "three-part hybrid": deleting push-primary
# and delegated checking left the gate green, because a label survives the removal of what it
# labels. The label pin is therefore NOT here; these are.
assert_pin "$CHARTER" 'push primary, a cheap delegated sentinel'                 # A: leg 1 removed -> red
assert_pin "$CHARTER" 'delegated sentinel carrying the investigative checking'   # B2: leg 2 removed -> red (fires alone)
assert_pin "$CHARTER" 'one infrequent leader wake'                              # C: leg 3 removed -> red

# --- skills/tap/SKILL.md — floor 6's own default ---------------------------------------
# D/D2: deleting the delegation-and-wake clause reds; the older generic coverage phrase did not.
assert_pin "$USING_TAP" 'investigative checking and keeps one infrequent LEADER wake as the'
# J: the needle runs THROUGH the polarity word. Stopping at "delivery itself" left
# "delivery itself SUCCEEDING" green — a needle short of the claim pins the subject, not the claim.
assert_pin "$USING_TAP" 'backstop for delivery itself failing'

# --- skills/lead/references/choreography-best-practices.md — the doctrine file ----------------
# E: needle carries push-primary too, so the doctrine file cannot lose that leg either.
assert_pin "$BEST_PRACTICES" '**push primary**; **`tap watch`** as the mechanical liveness leg'
assert_pin "$BEST_PRACTICES" "**A delegated sentinel**, the hybrid's checking leg"   # F: leg removed -> red
assert_pin "$BEST_PRACTICES" 'tap in cron-watch --delivery poll'                     # G: recipe removed -> red
assert_pin "$BEST_PRACTICES" 'say the liveness floor is unmet'                       # H: degraded path removed -> red
assert_pin "$BEST_PRACTICES" '`/tap:self` never cancels one'                             # I: cancellation fact removed -> red
# K/L/M/N: the scheduled command, pinned WHOLE. A pane-less send needs the body, --from for
# identity, and --team for the bus anchor; dropping any one of the three reds this pin. The
# failure it fences is the quiet one — registration succeeds, the leg reads as armed, and every
# tick refuses before publishing.
assert_pin "$BEST_PRACTICES" "tap send <leader> --from cron-watch --team <team> --wake -f <path>"

# O: added at integration (opus), fable's optional item 3, under the same admission rule
# rather than on the strength of "it looks substantive". Mutation run here: removing the
# harness-restriction clause from the /self loop bullet leaves the rest of the sentence intact
# and this pin red. The claim it fences is checkable and load-bearing — skills/self/SKILL.md's
# own matrix has `loop` at exit 6 for Codex, opencode AND hermes, so a leader who reads the
# bullet without the restriction arms a supervision leg that silently cannot run on four of
# five harnesses. That is the same quiet-failure shape as K/L/M/N below it.
assert_pin "$BEST_PRACTICES" '**Claude Code only**'

printf 'lead-doctrine-pins: ok (12 mutation-proven pins)\n'
