#!/usr/bin/env bash
# team-only-select.test.sh — `--only <handles>` as the complement of `--except`
# on the team lifecycle verbs (tap-sttl).
#
# Placement note: every pre-existing --except fixture lives in regress/, so the
# prior art for this flag is in the bucket that does NOT gate. These arms are in
# smoke/ deliberately. --only decides which seats a lifecycle verb ACTS ON, and
# the failure mode of a wrong answer is stopping a seat the operator meant to
# keep — that belongs behind the merge gate, not behind an operator-initiated
# suite. The arms below need no tmux and no live pane: every refusal here fires
# during parse/roster-gate, which runs before any observation or mutation.
#
# What each arm pins is named in its own header. The load-bearing one is (6):
# resolution must REFUSE on an unreadable roster rather than resolve to an empty
# exclusion set, because an empty exclusion set under --only means "act on every
# seat" — the exact inverse of what was asked.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"

fail() { echo "team-only-select: $*" >&2; exit 1; }

TAP_HOME="$(mktemp -d)"
trap 'rm -rf "$TAP_HOME"' EXIT
export TAP_HOME
export TAP_REGISTRY="$TAP_HOME/registry.json"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"

# A registry with three seats. The roster helper reads exactly this shape.
cat > "$TAP_HOME/registry.json" <<'JSON'
{"schema": "0.20", "team": {"name": "demo"},
 "seats": {"kimi": {"pane": "%101"}, "grok": {"pane": "%102"}, "sonnet": {"pane": "%103"}}}
JSON

# Selector behavior lives in runtime/bun/test/team-detach-teardown.test.ts.

# --- (9) the two flags refuse together, on every verb that takes them ----------
# Run through the real CLI so the refusal is pinned at the verb's own arg parser,
# not only at the helper. Exit status and message are both asserted: a verb that
# accepted both and silently preferred one would still exit 0 here.
for verb in down shutdown attach detach up; do
  out="$("$TAP" team "$verb" --only kimi --except grok </dev/null 2>&1)" \
    && fail "(9) team $verb must refuse --only with --except"
  # Assert the CONFLICT refusal specifically. An earlier version accepted any
  # message mentioning either flag, which a sandbox-misconfiguration refusal
  # ("acting registry unreachable") could also have satisfied while the verb
  # never reached this gate at all.
  case "$out" in
    *"never both"*) ;;
    *) fail "(9) team $verb must refuse for the flag CONFLICT, not another reason; got: $out" ;;
  esac
done
echo "team-only-select: (9) --only and --except refuse together on all five verbs: ok"

# --- (10) detach --handle and --only refuse together ---------------------------
# NOT the same selector at different arities — --handle targets one ROW,
# --only is session-granular. Both name seats to act on, which is why passing
# both is refused, but the mechanism differs; a comment here calling them the
# same selector was itself an instance of the class this file exists to
# guard against (review, the tap-team-detach.sh:72 sibling).
out="$("$TAP" team detach --handle kimi --only grok </dev/null 2>&1)" \
  && fail "(10) team detach must refuse --handle with --only"
case "$out" in
  *"--only"*) ;;
  *) fail "(10) refusal must name --only; got: $out" ;;
esac
# The wording, not just the refusal (review, tap-team-detach.sh:72):
# the usage hint used to call --handle "the single-seat form" of --only, which
# is the exact wrong framing arm 11c guards on help text — here it survived in
# a runtime refusal string instead. Keyed on the phrase unique to the wrong
# claim, same as 11c, not on "single-seat" alone (which the correct phrasing
# below also needs to be able to use if it ever does).
case "$out" in
  *"single-seat form"*)
    fail "(10) refusal still calls --handle the single-seat form of --only; they are not the same operation — --only is session-granular, --handle is row-targeted: $out" ;;
esac
echo "team-only-select: (10) detach --handle with --only refuses, without calling --handle the single-seat form of --only: ok"

# --- (11) --only is reachable from help on every verb that accepts it ----------
# Existence is not discoverability: a flag no help text mentions is one an
# operator cannot find.
# Each verb's own page carries the selector now; the family index only routes to them.
for _v in attach detach down shutdown up; do
  _page="$("$TAP" help team "$_v" </dev/null 2>&1 || true)"
  case "$_page" in
    *"--only"*) ;;
    *) fail "(11) tap help team $_v must document --only" ;;
  esac
done
echo "team-only-select: (11) --only appears in tap help team attach|detach|down|shutdown|up: ok"

# --- (11b) ...and says what the SHIPPED mechanism does ------------------------
# Mentioning the flag is not describing it. Three surfaces — SKILL.md, the PR
# body, and this help text — each carried the RETIRED frozen-complement story
# ("a typo would act on every seat you meant to keep"), and each was found by a
# separate reader on a separate day, because prose survives every test.
#
# An unknown handle is REFUSED (selection.ts rosterGate, not_found, exit 1), for --only
# and --except alike. This pins the polarity rather than the wording: no page may claim
# a typo ACTS on the seats you meant to keep, or that it is a silent no-op, and the
# pages that take a list must say the unknown handle refuses.
# WHITESPACE-NORMALIZED, because the help text WRAPS. Matching the raw output
# for a phrase that spans a line break is a predicate no failure can trip: the
# first version of this arm stayed green with the retired wording restored, which
# is how I know.
for _v in attach detach down shutdown; do
  help_flat="$("$TAP" help team "$_v" </dev/null 2>&1 | tr '\n' ' ' | sed 's/  */ /g')"
  case "$help_flat" in
    *"ACT on every seat you meant to keep"*|*"act on every seat you meant to keep"*|*"acts on NOBODY"*)
      fail "(11b) help team $_v still describes the retired typo outcome" ;;
  esac
  case "$help_flat" in
    *"a handle with no seat on this team refuses"*) ;;
    *) fail "(11b) help team $_v must say an unknown handle is refused; got: $help_flat" ;;
  esac
done
echo "team-only-select: (11b) help describes the shipped selection mechanism: ok"

# --- (11c) NO SURFACE MAY CALL --only A FORM OF --handle -----------------------
# The retired claim had FOUR carriers, and correcting three of them left the
# fourth — `tap help team` — asserting it for another round. That one is the
# MOST-READ of the four: an operator runs the help and never opens CONTRACT.md.
# Both sweeps that missed it (mine, then the merge gate's) inherited a FILE LIST
# from the artifact being read instead of deriving the carrier set from the
# concept, so this arm keys on the CONCEPT and reads the surfaces as shipped.
#
# It is deliberately not a repo grep: a grep proves the string is absent from
# files someone remembered to list. This renders the help a user actually sees
# and asserts the claim is not in it — the only carrier that can mislead an
# operator at the moment of use.
_h11c="$(for _v in attach detach down shutdown up; do "$TAP" help team "$_v" 2>&1; done | tr '\n' ' ' | tr -s ' ')"
case "$_h11c" in
  *"--only"*) ;;
  *) fail "(11c) precondition: the team verb pages do not mention --only at all, so this arm proves nothing" ;;
esac
case "$_h11c" in
  *"multi-seat form"*|*"multi-seat spelling"*|*"single-seat form of --only"*)
    fail "(11c) help still calls --only a form of --handle; they are not the same operation — --only is session-granular, --handle is row-targeted. Offending text: ...$(printf '%s' "$_h11c" | grep -o '.\{0,90\}multi-seat.\{0,90\}' | head -1)..." ;;
esac
# ...and the correct distinction must actually be STATED, not merely un-stated —
# removing a wrong sentence is not the same as replacing it. Keyed on the phrase
# unique to THIS distinction, not on "session-granular" alone: that term already
# appears in the --except paragraph, so asserting it was satisfied by a state
# weaker than the claim and stayed green when the distinction was deleted.
# Mutation caught that; it is the fifth instance of the family tonight.
case "$_h11c" in
  *"targets one ROW"*) ;;
  *) fail "(11c) help no longer states what --handle does differently (it targets one ROW where --only selects); removing a wrong sentence is not the same as stating the right one. The --only paragraph reads: ...$(printf '%s' "$_h11c" | grep -o '.\{0,140\}--only is a SELECTION.\{0,200\}' | head -1)..." ;;
esac
echo "team-only-select: (11c) no help surface calls --only a form of --handle: ok"

# --- (12) --only and --handle DIVERGE on a shared session, by design ----------
# CONTRACT used to call `--only` "the multi-seat spelling of `--handle`". It is
# not, and review caught the sentence rather than the code. The
# code is right: `--only` is a SELECTION and therefore session-granular like every
# other selector — an unnamed seat is spared and sparing spares its whole tmux
# session — while `--handle` targets one ROW and detaches its session regardless
# of co-tenants.
#
# This arm exists because the corrected sentence is a CLAIM, and a claim about
# behavior that nothing executes is the thing this lane keeps getting caught on.
# Both halves are asserted: making `--only a` detach a shared session would
# disconnect an unselected seat's clients (the bug the doctrine prevents), and
# making `--handle a` spare it would silently redefine an existing flag.
# Same bus the other arms use — a bare mktemp dir resolves as a bus DECOY and both
# runs refuse identically, which would have made the divergence assertion compare
# two error messages. The precondition below is what caught that.
_sh_backup="$(mktemp)"
cp "$TAP_REGISTRY" "$_sh_backup"
cat > "$TAP_REGISTRY" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "alpha": {"status": "active", "delivery": "pane", "pane": "demo/shared:0.0", "pane_id": "%201", "harness": "claude", "server_epoch": "srv:900:100", "session": "demo/shared"},
    "beta":  {"status": "active", "delivery": "pane", "pane": "demo/shared:0.1", "pane_id": "%202", "harness": "claude", "server_epoch": "srv:900:100", "session": "demo/shared"}
  }
}
JSON
_only_out="$("$TAP" team detach --only alpha </dev/null 2>&1)" || true
_handle_out="$("$TAP" team detach --handle alpha </dev/null 2>&1)" || true
cp "$_sh_backup" "$TAP_REGISTRY"; rm -f "$_sh_backup"
# PRECONDITION: both runs must have produced a real receipt naming the shared
# session, not a refusal — otherwise the comparison is between two error strings.
case "$_only_out" in
  *"registry unreachable"*|*"usage_error"*) fail "(12) --only run refused instead of planning: $_only_out" ;;
esac
case "$_handle_out" in
  *"registry unreachable"*|*"usage_error"*) fail "(12) --handle run refused instead of planning: $_handle_out" ;;
esac
case "$_only_out$_handle_out" in
  *demo/shared*) ;;
  *) fail "(12) neither receipt mentions the shared session; --only said '$_only_out' and --handle said '$_handle_out'" ;;
esac
# THE EFFECT, keyed on the counters rather than on the receipts differing. A
# text-difference assertion is satisfied by a state weaker than the claim — proven
# here rather than assumed: with `is_spared` mutated to spare nobody, the two
# receipts STILL differ (one names both rows, the other one), so `!=` passed while
# --only had started acting on the shared session. Same family this lane keeps
# hitting, caught this time in an arm written to demonstrate that lesson.
#
# --only alpha: beta is unnamed and therefore spared, and sparing is
# session-granular, so the shared session must be EXCLUDED and never acted on.
case "$_only_out" in
  *"excluded=1"*) ;;
  *) fail "(12) --only alpha did not exclude the session shared with the unselected seat 'beta': $_only_out" ;;
esac
case "$_only_out" in
  *"session_gone=1"*|*"detached=1"*)
    fail "(12) --only alpha ACTED on a session shared with 'beta', which the operator did not select — that disconnects an unselected seat's clients: $_only_out" ;;
esac
case "$_only_out" in
  *beta*) ;;
  *) fail "(12) the --only receipt does not name the co-tenant that caused the exclusion: $_only_out" ;;
esac
# --handle alpha: row-targeted, so the SAME session is acted on and nothing is
# excluded. Asserted so a fix that made --handle session-granular — silently
# redefining an existing flag — cannot pass this arm either.
case "$_handle_out" in
  *"session_gone=1"*|*"detached=1"*) ;;
  *) fail "(12) --handle alpha did not act on the shared session: $_handle_out" ;;
esac
case "$_handle_out" in
  *"excluded=1"*) fail "(12) --handle alpha excluded the shared session; --handle is row-targeted and this change does not get to redefine it: $_handle_out" ;;
esac
echo "team-only-select: (12) --only is session-granular where --handle is row-targeted: ok"

echo "team-only-select: ok"
