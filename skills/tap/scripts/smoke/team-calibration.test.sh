#!/usr/bin/env bash
# team-calibration.test.sh — `tap team calibration`: the roster JOIN (tap-ypmn).
#
# tap-ypmn was TWO defects stacked, and the outer one hid the inner one:
#
#   A. the view read an ambient TAP_REGISTRY (<root>/.tap/bus/registry.json) that
#      does not exist post-v0.20-flip, so the seat map was EMPTY and every
#      calibrated teammate rendered `gone` while 23 of them were attached; and
#   B. the ledger join was by BARE handle, so every duty-suffixed seat
#      (opus-lieutenant, grok-fence, terra-docs-researcher) resolved to
#      nothing even once a registry was in hand.
#
# They are pinned SEPARATELY and by EFFECT, never by exit code. A test that only
# pinned B would have gone green against a surface that still showed no seats at
# all: under defect A the roster is empty, so "no duty-suffixed row is wrong" is
# vacuously true. So arm A asserts a seat with an EXACT catalog name (`opus`)
# appears active — that row joined fine under the old bare-handle join and fails
# only when the registry read is dead — and arm B asserts the duty-suffixed row,
# which fails only when the join is bare. Neither arm can carry the other.
set -euo pipefail
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "team-calibration: $*" >&2; exit 1; }

# --- fixture: an acting registry (v0.20), a catalog, and a ledger ------------
export TAP_INDEX_HOME="$WORK/index"
export XDG_CONFIG_HOME="$WORK/cfg"
export TAP_MODELS_LEDGER="$WORK/seat-calibration.md"
mkdir -p "$TAP_INDEX_HOME" "$XDG_CONFIG_HOME/tap" \
         "$WORK/team/.tap/bus/payloads" "$WORK/team/.tap/bus/receipts"

cat >"$TAP_INDEX_HOME/global-registry.json" <<JSON
{"migrated":"t","schema":"0.20","teams":{"demo":{"enrolled_at":"t",
 "registry_location":"$WORK/team/.tap/team-registry.json","root":"$WORK/team",
 "state":"registered"}}}
JSON

# Poll-delivery seats: no tmux server is needed to observe them, so this fixture
# is hermetic and the IDLE column honestly reads `-` (no pane, no activity).
cat >"$WORK/team/.tap/team-registry.json" <<'JSON'
{"schema":"0.20","team":{"name":"demo","created_at":"t","created_by":"t","repo_root":"/tmp"},
 "seats":{
  "opus":{"status":"active","delivery":"poll","harness":"claude","registered_at":"t","pane":"","pane_id":""},
  "opus-lieutenant":{"status":"active","delivery":"poll","harness":"claude","registered_at":"t","pane":"","pane_id":""},
  "opus-leader-2":{"status":"active","delivery":"poll","harness":"claude","registered_at":"t","pane":"","pane_id":""},
  "fable-docs":{"status":"active","delivery":"poll","harness":"claude","registered_at":"t","pane":"","pane_id":""},
  "glm53-buddy":{"status":"active","delivery":"poll","harness":"opencode","registered_at":"t","pane":"","pane_id":""},
  "glm-buddy":{"status":"active","delivery":"poll","harness":"opencode","registered_at":"t","pane":"","pane_id":""},
  "terra-writer":{"status":"active","delivery":"poll","harness":"codex","registered_at":"t","pane":"","pane_id":""},
  "sonnet-writer":{"status":"active","delivery":"poll","harness":"claude","registered_at":"t","pane":"","pane_id":""},
  "kimi-writer":{"status":"active","delivery":"poll","harness":"opencode","registered_at":"t","pane":"","pane_id":""},
  "fable-oncodex":{"status":"active","delivery":"poll","harness":"codex","registered_at":"t","pane":"","pane_id":""},
  "opus-noharness":{"status":"active","delivery":"poll","harness":"","registered_at":"t","pane":"","pane_id":""},
  "fable-subagent":{"status":"active","delivery":"poll","harness":"Agent tool","registered_at":"t","pane":"","pane_id":""},
  "qx7k-hoist":{"status":"active","delivery":"poll","harness":"claude","registered_at":"t","pane":"","pane_id":""}
 }}
JSON

cat >"$XDG_CONFIG_HOME/tap/config.toml" <<'TOML'
version = 2
[roles]
driver = "runs a lane"
reviewer = "reviews diffs"
[presets.opus]
harness = "claude"
params.model = "opus"
metadata.primary_roles = [ "driver" ]
metadata.secondary_roles = [ "reviewer" ]
[presets.fable]
harness = "claude"
params.model = "fable-5"
metadata.primary_roles = [ "driver" ]
TOML

cat >"$TAP_MODELS_LEDGER" <<'MD'
## Routing table (live state)

Routing priors + observed evidence, not law. A second sentence that must not render.

| handle | model @ harness | family | tier | speed | cost | voice | one-liner |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fable | fable-5 @ claude | anthropic | frontier | slow | expensive | | lead/driver work |
| opus | opus @ claude | anthropic | advanced | medium | included | | merge gate, workhorse |
| opus-leader | opus @ claude | anthropic | advanced | medium | included | | timed-grant leader seat |
| glm | glm @ opencode | zai | advanced | medium | cheap | additional-only | decorrelating review voice |
| terra | gpt-5.x @ codex | openai | advanced | fast | included | | mechanical build lanes |
| sonnet | sonnet @ claude | anthropic | advanced | fast | included | | implementation fan-out |
| kimi | kimi @ opencode | moonshot | advanced | fast | cheap | | review voice |
| opus-subagent | opus @ Agent tool | anthropic | advanced | medium | included | | doc reviews |
| fable-subagent | fable-5 @ Agent tool | anthropic | frontier | slow | expensive | | deep research fan-out |

### opus
- An older note (observed 2026-07-01).
- A RANGE that ends before the newest single date (observed 2026-07-02–07-04).
- The newest note, about the gate (observed 2026-08-05).
- An undated musing with no date at all.

### fable
- An en-dash RANGE whose end is newest (observed 2026-07-28–07-30).
- An intermediate single date (observed 2026-07-29).

### opus-leader
- A HYPHEN range whose end is newest (observed 2026-09-10-09-12).
- An intermediate single date (observed 2026-09-11).

### glm
- A range across the YEAR boundary (observed 2026-12-30–01-02).
- A single date late in the same year (observed 2026-12-31).

### terra
- Semicolon shape, ledger line 66 (seeded 2026-07-18; reconfirmed 2026-07-19–07-31).
- A single date falling between them (observed 2026-07-28).

### kimi
- The "and" shape, ledger line 78 (observed 2026-07-25 and 2026-07-30–07-31).
- A single date falling between them (observed 2026-07-28).

### sonnet
- Newest date FIRST on the line, range after it (observed 2026-09-20 and 2026-09-01–09-02).
- A single date before both (observed 2026-08-30).
MD

export TAP_HOME="$WORK/team/.tap/bus"
cd "$WORK/team"

out="$("$TAP" team calibration 2>&1)" || fail "tap team calibration failed: $out"
# Captured up front so the arms below can read BOTH surfaces: several properties
# (a fabricated join, a duplicated handle) are only wrong on one of them.
strong="$("$TAP" team calibration --strongest 2>&1)" || fail "--strongest failed: $strong"

# --- arm A: the registry is RESOLVED — seats actually appear -----------------
# Effect witness, not an exit code: the defect exited 0 while showing nothing.
grep -qE '^opus +opus +opus @ claude .* active' <<<"$out" \
  || fail "arm A (registry read): exact-name seat 'opus' is not rendered active; got:\n$out"
[ "$(grep -cE '^(opus|opus-lieutenant|opus-leader-2|fable-docs|glm-buddy|glm53-buddy|qx7k-hoist|terra-writer|sonnet-writer|kimi-writer|fable-oncodex|opus-noharness|fable-subagent) ' <<<"$out")" = 13 ] \
  || fail "arm A (registry read): expected all 13 seated rows; got:\n$out"
# The lie the defect told, in the words it told it in.
grep -q 'gone' <<<"$out" \
  && fail "arm A: a seat rendered 'gone' while active in the acting registry:\n$out"

# --- arm B: the JOIN is prefix-resolved -------------------------------------
grep -qE '^opus-lieutenant +opus +opus @ claude +anthropic +advanced' <<<"$out" \
  || fail "arm B (prefix join): opus-lieutenant did not join base row 'opus'; got:\n$out"
grep -q 'opus-lieutenant (via opus) — merge gate, workhorse' <<<"$out" \
  || fail "arm B: opus-lieutenant is missing its base row's route line; got:\n$out"
# Longest match, not first: opus-leader-2 must join opus-leader, never opus.
grep -qE '^opus-leader-2 +opus-leader +' <<<"$out" \
  || fail "arm B: opus-leader-2 must join the LONGEST match (opus-leader); got:\n$out"
# The separator is required — glm53 is a different model from glm, and a prefix
# join without it would silently route glm53 traffic off glm's calibration.
grep -qE '^glm53-buddy +- ' <<<"$out" \
  || fail "arm B: glm53-buddy must NOT join 'glm'; got:\n$out"

# --- unjoined-but-seated renders honestly ------------------------------------
grep -qE '^qx7k-hoist +- .* active' <<<"$out" \
  || fail "opaque handle must render seated and unjoined; got:\n$out"
grep -q 'qx7k-hoist — active, claude; add a routing entry to calibrate' <<<"$out" \
  || fail "opaque handle must be named in the unjoined block; got:\n$out"

# --- roles (capability), latest DATED observation, idle source ---------------
grep -qE '^opus-lieutenant .*driver \(reviewer\)' <<<"$out" \
  || fail "preset primary + secondary roles missing; got:\n$out"
grep -q '2026-08-05 · The newest note, about the gate' <<<"$out" \
  || fail "latest dated observation must be the NEWEST bullet; got:\n$out"
grep -q '2026-07-01' <<<"$out" \
  && fail "an older bullet outranked the newest observation:\n$out"
grep -q 'An undated musing' <<<"$out" \
  && fail "an UNDATED bullet was rendered as a dated observation:\n$out"
# Sourced from registry/tmux only — pane-less seats read '-', never a usage band
# or a context depth (those are tap-ekey's, explicitly out of scope here).
grep -qE '^opus .* -$' <<<"$out" \
  || fail "IDLE must read '-' for a pane-less seat; got:\n$out"
grep -q 'IDLE is tmux window activity — a hint' <<<"$out" \
  || fail "the IDLE hint caveat must be stated in the view; got:\n$out"

# --- --strongest names a FRONTIER seat --------------------------------------
# Deliberately not "non-empty": the defect returned opus-subagent/sonnet-subagent
# (ADVANCED) while frontier seats sat attached, so non-empty was already true and
# a non-empty assertion could not fail for the reason this test exists.
[ "$(printf '%s\n' "$strong" | sort | tr '\n' ' ')" = "fable-docs fable-subagent " ] \
  || fail "--strongest must name exactly the frontier targets, once each; got: $strong"

# --- tap models is CATALOG ONLY ---------------------------------------------
cat_out="$("$TAP" models 2>&1)" || fail "tap models failed: $cat_out"
for seat in opus-lieutenant opus-leader-2 fable-docs glm53-buddy qx7k-hoist; do
  grep -q "$seat" <<<"$cat_out" \
    && fail "tap models is catalog-only but rendered seat '$seat':\n$cat_out"
done
grep -q 'STATUS' <<<"$cat_out" \
  && fail "tap models must not carry a seat STATUS column:\n$cat_out"
grep -q 'tap team calibration' <<<"$cat_out" \
  || fail "tap models must point at the team-scoped surface:\n$cat_out"
# The native catalog's registry-independent behavior, including the Bash-selected
# door, is exercised by runtime/bun/test/routing.test.ts. Its old shell wrapper
# is deleted; a source grep against that file no longer guards this behavior.
if "$TAP" models --strongest >/dev/null 2>&1; then
  fail "--strongest moved to 'tap team calibration'; the catalog must not accept it"
fi

# --- a name-only join whose HARNESS contradicts the row is NOT inherited ----
# The silent-downgrade defect inverted into a silent UPGRADE, and worse in kind:
# `fable-oncodex` is a codex seat whose NAME resolves to fable's claude row, so an
# unchecked join renders `fable-5 @ codex` — a model/harness pair that exists nowhere
# — and then ranks it FRONTIER and promotes it to the top of --strongest. The view is
# not passing on a hint that turned out wrong; it is fabricating a target and
# recommending it. Latent rather than live on the real roster today (every joined seat
# there matches its base harness), armed here because fabrication is the one class
# this surface must never produce.
grep -qE '^fable-oncodex +- ' <<<"$out" \
  || fail "a harness-contradicting name must NOT inherit the calibration row:\n$out"
grep -q 'fable-5 @ codex' <<<"$out" \
  && fail "the view fabricated a model @ harness combination that exists nowhere:\n$out"
grep -q 'fable-oncodex — active, codex; harness codex does not match fable' <<<"$out" \
  || fail "the unjoined block must NAME the contradiction, not read as a missing ledger row:\n$out"
# ...but the refusal keys on EVIDENCE of a contradiction, never on a missing
# observation: a seat whose registry row records no harness still inherits its row.
# Refusing there would turn an unobserved field into a fabricated conflict — the same
# mistake in the opposite direction.
grep -qE '^opus-noharness +opus +opus @ claude' <<<"$out" \
  || fail "a seat with NO recorded harness must still join (absence is not a contradiction):\n$out"
# Names stay hints, never fences (R6): the seat is still listed, still seated, still
# addressable — only the inheritance is refused.
grep -qE '^fable-oncodex .* active' <<<"$out" \
  || fail "a mismatched seat must still be listed and seated — this is not a gate:\n$out"
# ...and it must not be promoted by the machine-readable path either.
grep -q 'fable-oncodex' <<<"$strong" \
  && fail "--strongest promoted a fabricated frontier target:\n$strong"

# One handle, one line: --strongest is line-oriented and both sources can name the
# same handle. The trigger is contrived — a registry row carrying harness "Agent tool"
# — and stated as such rather than dressed up; the assertion is a PROPERTY that stays
# meaningful whether or not anything triggers it today.
[ "$(printf '%s\n' "$strong" | sort | uniq -d | wc -l | tr -d ' ')" = 0 ] \
  || fail "--strongest emitted a duplicate handle into a line-oriented contract:\n$strong"

# --- an abbreviated RANGE is scored by its END, not its start ---------------
# Found in review. `max()` over full dates only saw
# 2026-07-28 in "2026-07-28–07-30", so a sibling bullet dated 2026-07-29 outranked
# evidence that ran through the 30th: the "latest observation" column showing STALE
# routing evidence while newer evidence exists. The live ledger carries at least five
# such ranges, so this is data we have, not a format imagined for a test.
#
# Inventory question asked of these arms before calling them coverage — the states
# each one does NOT enter are covered by a sibling: single date (the regression
# guard, above), en-dash range, hyphen range, year rollover, and undated (asserted
# absent, above). The date shown for a range is the EXPANDED END and so differs from
# the bullet text on purpose; asserting the end date is what makes the arm about
# scoring rather than about echoing.
# RANK by the expanded end; DISPLAY what the ledger literally says. Both halves are
# asserted together on purpose: rendering the computed date would put a date on
# screen that nobody wrote — a new lie in the same family as the one this PR removes,
# and the natural shape of the code if you expand once and use the expansion
# everywhere.
grep -q '2026-07-28–07-30 · An en-dash RANGE whose end is newest' <<<"$out" \
  || fail "en-dash range must WIN (ranked by its 07-30 end) and render AS WRITTEN:\n$out"
grep -q '2026-07-30 ·' <<<"$out" \
  && fail "the expanded endpoint reached the display; rank by it, never show it:\n$out"
grep -q '2026-07-29 · An intermediate single date' <<<"$out" \
  && fail "an intermediate single date outranked a range that ran past it:\n$out"
# Both separators. The ledger writes 21 abbreviated ranges with an en dash and zero
# with a hyphen, so a hyphen-only fix ignores every live entry and an en-dash-only
# fix silently ignores any hyphen-written one. Arming one spelling proves half a fix.
grep -q '2026-09-10-09-12 · A HYPHEN range whose end is newest' <<<"$out" \
  || fail "a HYPHEN-separated range must expand too:\n$out"
grep -q '2026-09-11 · An intermediate single date' <<<"$out" \
  && fail "hyphen range lost to an intermediate single date — the hyphen spelling is unhandled:\n$out"
# Year rollover, DRIVEN not read: an end sorting before its start is the next year.
grep -q '2026-12-30–01-02 · A range across the YEAR boundary' <<<"$out" \
  || fail "a range crossing the year boundary must rank into the following year:\n$out"
grep -q '2026-12-31 · A single date late in the same year' <<<"$out" \
  && fail "the pre-rollover single date outranked the range that ran into January:\n$out"
# A line carrying a PLAIN DATE AND A RANGE — the shape that breaks the natural fix.
# "Find the range on this line and expand its end" quietly assumes the range is the
# only date present; it handles 19 of the ledger's 21 entries and mis-ranks the two
# that are not that shape, so an arm built from a single-range fixture passes while
# the fix is wrong on real input. Both ORDERS are armed, because each catches a
# different half: when the range end is newest the range must win, and when the plain
# date is newest the range must NOT win just for being a range. Fixture text is the
# live ledger's own shape (line 78: "observed 2026-07-25 and 2026-07-30–07-31").
# Line 66 FIRST, deliberately: its wrong answers are twelve days off, so a failure
# message here says what broke. Line 78's are one day off — a subtly wrong expansion
# (off-by-one, wrong month, wrong inherited year) can land within a day of correct
# there and read as noise. Both are carried because they are two SHAPES, not two
# instances of one: 66 separates its dates with a SEMICOLON inside one parenthetical,
# 78 with the word "and", so an implementation that tokenizes on a separator instead
# of scanning for the range pattern passes one and fails the other for a structural
# reason rather than an arithmetic one.
grep -q '2026-07-19–07-31 · Semicolon shape, ledger line 66' <<<"$out" \
  || fail "line-66 shape: the range END (07-31) must rank highest and display as written:\n$out"
grep -q '2026-07-30–07-31 · The "and" shape, ledger line 78' <<<"$out" \
  || fail "line-78 shape: the range END must rank highest and display as written:\n$out"
grep -qE '2026-07-18 ·|2026-07-25 ·|2026-07-28 · A single date falling between' <<<"$out" \
  && fail "a plain date on a mixed line outranked the range that ran past it:\n$out"
# Not armed, with the reason stated rather than left as a hole: a tokenizer that keeps
# only the text after the SEMICOLON survives every fixture here, because the ledger's
# semicolon convention always puts the later date last ("seeded X; reconfirmed Y").
# Killing that mutant needs a bullet whose winner precedes the semicolon — a shape the
# ledger does not contain and would not naturally produce. An arm nobody can trigger
# from real input is worse than a named gap.
# ORDER matters here: the newest date comes FIRST and the range trails it, so a fix
# that keeps only the tail of a split (on " and ", on the last parenthetical, on any
# separator) drops the winner and promotes the range. Same shape with the newest date
# last would pass under that bug.
grep -q '2026-09-20 · Newest date FIRST on the line' <<<"$out" \
  || fail "when the PLAIN date is newest on a mixed line it must win, and render alone:\n$out"
grep -q '2026-09-01–09-02 ·' <<<"$out" \
  && fail "a range outranked a newer plain date on the same line:\n$out"

# The DISCRIMINATOR for all of the above: a range must not win merely for being a
# range. `opus` carries 2026-07-02–07-04 alongside the newest single date 2026-08-05,
# and the single must still win — a fix that always prefers ranges is a different
# wrong answer with a green test.
grep -q '2026-07-02–07-04' <<<"$out" \
  && fail "a range that ended BEFORE the newest single date was preferred anyway:\n$out"

# --- a CORRUPT registry refuses; it never reports the team as empty ---------
# The third RED, and the one the codex bot caught in review: tap team --json emits
# {"team":null,"agents":[],"error":...} and exits 1 when the acting registry will
# not parse, but team_list swallows that exit into `return 0`, so the only surviving
# evidence is the error key. Miss it and this view prints "no seats registered yet"
# over a corrupt file -- the same confidently-wrong-about-the-roster class this whole
# change exists to kill, on its own new surface. Effect witnesses, both directions:
# nonzero exit AND no roster rendered AND a remedy that works from the failure state.
cp "$WORK/team/.tap/team-registry.json" "$WORK/registry.good"
printf '%s\n' '{"schema":"0.20","seats":{"opus":' >"$WORK/team/.tap/team-registry.json"
set +e
corrupt_out="$("$TAP" team calibration 2>"$WORK/calibration-corrupt.err")"
corrupt_rc=$?
set -e
[ "$corrupt_rc" -eq 1 ] \
  || fail "corrupt registry must exit 1 (cannot do its job); got rc=$corrupt_rc and:\n$corrupt_out"
[ -z "$corrupt_out" ] || fail "corrupt registry must produce no calibration stdout: $corrupt_out"
corrupt_out="$(cat "$WORK/calibration-corrupt.err")"
[ "$corrupt_out" = 'tap team calibration: acting registry unreadable; repair or restore the acting registry file (tap doctor names it), then retry' ] \
  || fail "corrupt registry refusal changed: $corrupt_out"
grep -q 'no seats registered yet' <<<"$corrupt_out" \
  && fail "corrupt registry must NOT be reported as an empty team:\n$corrupt_out"
grep -qE '^HANDLE +BASE ' <<<"$corrupt_out" \
  && fail "corrupt registry must render no roster table at all:\n$corrupt_out"
grep -qi 'repair or restore' <<<"$corrupt_out" \
  || fail "the refusal must name a remedy runnable from the failure state:\n$corrupt_out"
# `tap register` is repair-by-registration and cannot fix a malformed file, so it
# must not be the advice here even though the empty-team path legitimately says it.
grep -q 'tap register' <<<"$corrupt_out" \
  && fail "corrupt registry must not point at tap register (wrong remedy):\n$corrupt_out"
# --strongest under the SAME corruption must fail closed too. It is the more
# dangerous of the two render paths: its subagent rows come from the LEDGER, not the
# roster, so an empty join still yields opus-subagent/sonnet-subagent at exit 0 --
# a routing consumer handed ADVANCED targets while FRONTIER seats sit attached, with
# no failure signal. That is the original defect this branch exists to kill, reached
# through a different trigger, so the guard is asserted above BOTH paths.
set +e
strong_corrupt="$("$TAP" team calibration --strongest 2>"$WORK/strongest-corrupt.err")"
strong_rc=$?
set -e
[ "$strong_rc" -eq 1 ] \
  || fail "--strongest under a corrupt registry must exit 1; got rc=$strong_rc and:\n$strong_corrupt"
[ -z "$strong_corrupt" ] || fail "corrupt registry must produce no strongest stdout: $strong_corrupt"
strong_corrupt="$(cat "$WORK/strongest-corrupt.err")"
[ "$strong_corrupt" = "$corrupt_out" ] || fail "--strongest changed the corrupt registry refusal: $strong_corrupt"
grep -qE 'subagent' <<<"$strong_corrupt" \
  && fail "--strongest must not fall back to ledger subagent rows under corruption:\n$strong_corrupt"
cp "$WORK/registry.good" "$WORK/team/.tap/team-registry.json"
# Restored: the honest empty case must still be able to say it is empty, so the
# refusal cannot be a blanket "never claim empty" (that would trade one lie for another).
printf '%s\n' '{"schema":"0.20","team":{"name":"demo"},"seats":{}}' >"$WORK/team/.tap/team-registry.json"
empty_out="$("$TAP" team calibration 2>&1)" || fail "empty team must still exit 0: $empty_out"
grep -q 'no seats registered yet' <<<"$empty_out" \
  || fail "a genuinely empty roster must still report itself empty:\n$empty_out"
# ...and its --strongest PARTNER, which is what makes arm 3 mean anything. Arm 3
# alone goes green if the verb refuses whenever `joined` is empty, never entering
# the --strongest path`s own handling and never distinguishing "refuses under
# corruption" from "refuses on any empty join". With a READABLE empty registry the
# ledger subagent rows genuinely ARE the strongest reachable thing, so printing them
# at exit 0 is the CORRECT answer and must keep working. 3 and 4 are a pair; neither
# means anything alone.
strong_empty="$("$TAP" team calibration --strongest 2>&1)" \
  || fail "--strongest on an empty-but-valid registry must exit 0: $strong_empty"
grep -q 'fable-subagent' <<<"$strong_empty" \
  || fail "--strongest must still name the reachable subagent rows when the roster is honestly empty:\n$strong_empty"
cp "$WORK/registry.good" "$WORK/team/.tap/team-registry.json"

# The retired shell-function/child failure probe no longer reaches the native
# observer. Its fail-closed contract is covered by the injected engine failure
# in team.test.ts; corrupt-roster versus readable-empty cases remain above.

# --- the naming convention is DISCOVERABLE, as convention -------------------
# `tap help team calibration` owns the convention; the family index only routes to it.
help_team="$("$TAP" help team 2>&1)" || fail "tap help team failed"
grep -q 'tap help team <operation>' <<<"$help_team" \
  || fail "tap help team must route operations to their own pages"
grep -qE '^  calibration ' <<<"$help_team" \
  || fail "tap help team must list the calibration operation"
help_cal="$("$TAP" help team calibration 2>&1)" || fail "tap help team calibration failed"
grep -qi 'convention' <<<"$help_cal" \
  || fail "tap help team calibration must state the handle convention"
# The non-authority disclaimer must say it in the same sentence as CONVENTION. A bare
# `hint` (this page says "IDLE hint" and "routing HINT" elsewhere) proves nothing (tap-fpjk).
disclaims_convention() {
  tr '\n' ' ' | tr -s ' ' \
    | grep -qiE 'convention[^.;]*not a rule[^.;]*not a permission fence'
}
disclaims_convention <<<"$help_cal" \
  || fail "tap help team calibration must state the naming convention is not a rule or permission fence (R6)"
# Executed negative control: must RED, so the assertion cannot pass vacuously.
strip_disclaimer="$(sed 's/not a rule and not a permission fence//I' <<<"$help_cal")"
[ "$strip_disclaimer" != "$help_cal" ] || fail "negative control did not change the help text"
grep -qi 'hint' <<<"$strip_disclaimer" \
  || fail "negative control lost its decoy: 'hint' must still appear elsewhere in help"
if disclaims_convention <<<"$strip_disclaimer"; then
  fail "negative control: help without the disclaimer must fail the discoverability check"
fi
help_models="$("$TAP" help models 2>&1)" || fail "tap help models failed"
grep -q 'tap team calibration' <<<"$help_models" \
  || fail "tap help models must route the roster question to team calibration"

echo "team-calibration: ok"
