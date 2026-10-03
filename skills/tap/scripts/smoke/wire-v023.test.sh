#!/usr/bin/env bash
# focused-inventory: optout constructor-grammar behavior test, not a tree scan — the sibling sweep is the scanner
# wire-v023.test.sh — the v0.23 wire grammar at its ONE constructor.
#
# Spec section 13, FINAL:
#     [[TAP <version> <ask|note> [<team>/]<id> [tag ...] [path=<abs>][: inline body]]]
#
# Three fixed positional slots, always present, always in that order: the version
# token spelled `v0.23` with NO `=`, the obligation word (`ask` or `note`, never
# omitted), and the full id. After slot 3 everything is order-free and present only
# when true: bare tags from a closed set, then `path=`.
#
# Drive the native constructor against literal grammar expectations.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

fail() { echo "wire-v023: $*" >&2; exit 1; }

# render <from> <to> <id> <kind> <reply> <urgency> <path>
render() { "${TAP_SMOKE_BUN:-bun}" "$ROOT/runtime/bun/test/support/sentinel-render-cli.ts" "$@"; }

WORKDIR_WIRE="$(mktemp -d "${TMPDIR:-/tmp}/wire-v023.XXXXXX")"
trap 'rm -rf "$WORKDIR_WIRE"' EXIT

ID="fable-leader-20260101T000000Z-0123456789ab"
P="/Users/dev/work/tap/.tap/bus/payloads/$ID.md"

want() { # <label> <expected> <actual>
  [ "$2" = "$3" ] || fail "($1) grammar drift
  want: $2
  got:  $3"
  echo "wire-v023: ($1): ok"
}

# --- (1) obligation: reply=expected is `ask`, everything else is `note` --------
# `ask|note` replaces `reply=`; section 13 calls it "the one word every reader must
# see", so it is never omitted and never abbreviated away.
want 1a "[[TAP v0.23 ask $ID]]"  "$(render a b "$ID" discuss expected    "" "$P")"
want 1b "[[TAP v0.23 note $ID]]" "$(render a b "$ID" discuss settle-only "" "$P")"

# --- (2) tags are bare words, present only when true ---------------------------
want 2a "[[TAP v0.23 ask $ID urgent]]"  "$(render a b "$ID" discuss expected urgent "$P")"

# Escalation content and explicit interrupt permission are independent.
want 2b "[[TAP v0.23 ask $ID escalate]]" "$(render a b "$ID" escalate expected "" "$P")"
want 2e "[[TAP v0.23 ask $ID escalate urgent]]" "$(render a b "$ID" escalate expected urgent "$P")"

# `digest` is a tag; every other kind leaves the wire entirely and stays in the
# envelope (section 3 keeps `kind:` at rest).
want 2c "[[TAP v0.23 note $ID digest]]"  "$(render a b "$ID" digest settle-only "" "$P")"
want 2d "[[TAP v0.23 ask $ID]]"          "$(render a b "$ID" handoff expected "" "$P")"

# --- (3) the team prefix rides the id slot, and ONLY on genuine cross-team ------
# The prefix is the SENDER's team: the canonical payload lives on the sender's bus
# (tap-send.sh:660-665 — "payloads/receipts stay owned by the sender's bus; the only
# cross-worktree write is the tmux inject"), so the prefix is a BUS LOCATOR, not a
# courtesy label naming who spoke.
# (3a) is now the UNINDEXED cross-team case — see section (6). With no machine
# index in this sandbox, the sender team does not resolve, so the pointer rides;
# what this arm still asks is that the ID SLOT carries the prefix.
want 3a "[[TAP v0.23 ask blue/$ID path=$P]]" "$(render blue/gate tap/x "$ID" discuss expected "" "$P")"
want 3b "[[TAP v0.23 ask $ID]]"        "$(render tap/a tap/b   "$ID" discuss expected "" "$P")"

# (3c) THE CASE THAT MAKES THE COMPARISON NON-TRIVIAL, and the one a raw
# `from_team != to_team` on the send-path stamps gets wrong.
# `--cross-worktree --pane <bare-handle>` sets CROSS_WORKTREE=1 and leaves
# TEAM_QUALIFIED_REMOTE=0 (tap-send.sh:1583-1588), so `from` arrives qualified and
# `to` arrives BARE — "a manual --cross-worktree --pane send never learns the
# recipient's team", says the comment there. The raw comparison then reads TRUE and
# prefixes the one case section 13 reserves for `path=`: the unindexed manual relay.
# That prefix would resolve through the machine index, which maps a team name to ONE
# registry location — not necessarily the worktree whose bus actually holds the
# payload. A reader pointed at the wrong bus is precisely what `path=` exists to
# prevent there.
#
# An unqualified recipient is same-team BY CONSTRUCTION (the team is stamped only
# when it was genuinely resolved), so it defaults to the sender's team before the
# comparison — the same defaulting tap_spool_digest_sentinel already does at
# lib.sh:2390 for its own empty to_team.
want 3c "[[TAP v0.23 ask $ID path=$P]]" "$(render tap/a b "$ID" discuss expected "" "$P")"

# (3d) The digest path can never take a prefix: it renders BOTH halves off the same
# to_team (lib.sh:2391-2393), so the two are equal by construction. Its id's handle
# field is literally `courier` (lib.sh:2587 mints off TAP_COURIER_IDENTITY) — pinned
# here because U4's id validator must not be reachable by the courier's own mint.
DIGEST_ID="courier-20260904T081502Z-0123456789ab"
want 3d "[[TAP v0.23 note $DIGEST_ID digest]]" \
  "$(render tap/courier tap/seat "$DIGEST_ID" digest settle-only "" "$P")"

# --- path=, the ONE surviving key — a deliberate tap-0z9l retirement ------------
# There are no arms here, and that is the finding rather than an omission: the rule
# is already pinned, whole, by (1a) and (2d) (a plain send has no pointer), (2c)
# and (3d) (a digest keeps it), (3c) (the unindexed manual relay keeps it) and
# (3a)/(3b) (a resolved cross-team send does not). Two arms that re-stated (1a) and
# (3a) with identical argv and identical expectations used to sit here; they read
# as two questions and behaved as one, and the mutation they claimed to catch reds
# on (1a) first because (1a) runs earlier with the same input. An over-split reads
# as rigor. Caught by the gate reviewer, who ran the mutations rather than the
# comment.
#
# The prose stays, because a reader who meets this rule needs it and no arm can
# carry it. Section 13 keeps `path=` only where the id in slot 3 does NOT resolve on
# its own: a digest (bytes at spool/digests/<id>.json, and no view verb has a digest
# branch — ruling 36) and the unindexed manual relay.
#
# Dropping it everywhere else REVERSES tap-0z9l, whose ratified fix direction was
# "restore the pointer unconditionally — fix the signal, not the reader", after the
# v0.18 pointer diet produced a P1 filed as silent transport data loss. (No bytes
# were ever lost: a 97-second-old opencode crew seat read a path-less sentinel as a
# message with no body.) That reversal is adjudicated, not swept:
# The architect ruled section 13 stands on 2026-09-04, on the grounds that
# the full id in slot 3 pastes into `tap read`/`tap show` verbatim and is what now
# carries tap-0z9l acceptance 3 — the recipient must be able to TELL. The residual
# is named in CONTRACT. sentinel-pointer.test.sh case (1), which WAS that
# regression, is retired in U2 alongside the constant flip — not in this range.

# --- (6) the cross-team pointer is a PROBE, not a claim ------------------------
# Ruled by the architect, 2026-09-04, on a contradiction the gate reviewer
# found: section 13 makes the machine index the cross-team locator, while
# CONTRACT:53 records tap-j20w in the opposite voice — "the index is routinely
# incomplete; the payload is self-contained; the path is the route", which is why
# every cross-team `tap reply` passes `--remote-registry`.
#
# The reconciliation is that tap-j20w is a 2026-07-22 PRE-v0.20 observation. Since
# the flip, `tap register` enrolls every git-worktree team (R13, tap-nvtx), so a
# team that can SEND has a registered sender and a registered sender in a git
# worktree is enrolled; what is left outside the index is non-git directories,
# which are not stable machine-wide addresses.
#
# So the rule is an OBSERVABLE rather than a claim: ask the same resolver the
# reader will use, and emit the pointer exactly where the index cannot answer.
# These two arms are the halves of that, and neither is provable without the other
# — one alone would pass for a constructor that always emits, or never does.
IDXW="$WORKDIR_WIRE/probe"; mkdir -p "$IDXW/index" "$IDXW/blue/.tap"
python3 - "$IDXW" <<'PYIDX'
import json, pathlib, sys
w = pathlib.Path(sys.argv[1])
reg = w / "blue" / ".tap" / "team-registry.json"
reg.write_text(json.dumps({"schema": "0.20", "team": {"name": "blue"}, "seats": {}}) + "\n")
(w / "index" / "global-registry.json").write_text(json.dumps({
    "schema": "0.20",
    "teams": {"blue": {"root": str(w / "blue"), "registry_location": str(reg)}},
}) + "\n")
PYIDX

# (6a) ENROLLED sender team -> NO pointer. The `<team>/` prefix IS the locator,
# which is the whole reason section 13 moved the team onto the id slot.
want 6a "[[TAP v0.23 ask blue/$ID]]" \
  "$(TAP_INDEX_HOME="$IDXW/index" render blue/gate tap/x "$ID" discuss expected "" "$P")"

# (6b) UNENROLLED sender team -> the pointer rides, and names the canonical path.
# Mutation: delete the probe branch and this arm reds while (6a) still passes.
want 6b "[[TAP v0.23 ask blue/$ID path=$P]]" \
  "$(TAP_INDEX_HOME="$IDXW/empty" render blue/gate tap/x "$ID" discuss expected "" "$P")"

# (6d) An INVALID or UNREADABLE marker REFUSES the render rather than guessing.
# This is the ruling's fourth arm and it is the one with teeth: the other three ask
# what the probe ANSWERS, this one asks what it does when it cannot answer. A
# pointer chosen by a coin flip is worse than a refusal, because it is silent —
# either choice renders a plausible sentinel and only one of them is right.
#
# A directory at the marker path is unreadable as registry JSON in both runtimes.
# Break the input itself; the native reader has no Python-import dependency.
mkdir -p "$IDXW/invalid/global-registry.json"
if ( TAP_INDEX_HOME="$IDXW/invalid" \
     render blue/gate tap/x "$ID" discuss expected "" "$P" ) >/dev/null 2>&1; then
  fail "(6d) an unreadable registry marker must refuse the render, not guess at reachability"
fi
echo "wire-v023: (6d): ok"

# (6c) SAME-TEAM never probes: no index is consulted and no pointer is emitted, so
# the ordinary path stays free of an index read it does not need.
want 6c "[[TAP v0.23 ask $ID]]" \
  "$(TAP_INDEX_HOME="$IDXW/empty" render tap/a tap/b "$ID" discuss expected "" "$P")"

# --- (5) the inline note body (section 1's eligibility rule) --------------------
# `: ` starts the body and it is LAST because it may run to end of line. The rule
# is narrow on purpose: the body rides the wire only when it is already wire-safe
# BYTE FOR BYTE, and is never transformed. An ineligible body is not an error and
# is never truncated — it takes the read path, which every message already has,
# because the payload file and receipt chain are written either way.
#
# The reason there is no escaping: a transformed body would make the wire a second,
# lossy record of the message, and two readers of the same id could then disagree
# about what was said.
B="gate green at 7f1c2d, squashing"
want 5a "[[TAP v0.23 note $ID: $B]]" "$(render a b "$ID" discuss settle-only "" "$P" "$B")"

# 5b — an ask never inlines. The obligation an `ask` names is acted on by reading
# the payload; section 1 scopes inlining to notes and section 13's example carries
# a body only on a note.
want 5b "[[TAP v0.23 ask $ID]]" "$(render a b "$ID" discuss expected "" "$P" "$B")"

# 5c — `]]` would end the sentinel early, so a body containing it takes the read
# path. This is the arm that makes "no escaping" a rule rather than an omission.
want 5c "[[TAP v0.23 note $ID]]" "$(render a b "$ID" discuss settle-only "" "$P" "see x]] then y")"

# 5d — a newline would split one line into a header the parser accepts and a tail
# it never sees.
want 5d "[[TAP v0.23 note $ID]]" "$(render a b "$ID" discuss settle-only "" "$P" "$(printf 'line one\nline two')")"

# 5e — 200 characters ride; 201 do not. Both sides of the boundary, because an
# off-by-one here is invisible in any single-sided test.
B200="$(printf 'x%.0s' $(seq 1 200))"
B201="$(printf 'x%.0s' $(seq 1 201))"
want 5e1 "[[TAP v0.23 note $ID: $B200]]" "$(render a b "$ID" discuss settle-only "" "$P" "$B200")"
want 5e2 "[[TAP v0.23 note $ID]]"        "$(render a b "$ID" discuss settle-only "" "$P" "$B201")"

# 5f — a body NEVER rides alongside `path=`, and this arm used to assert the
# opposite. `path=` and the body are the only header parts that can run to end of
# line and the grammar does not say which wins: a path holding `": "` makes
# `path=/Users/dev/my: dir/p.md: hello` parse as pointer `/Users/dev/my` with body
# `dir/p.md: hello` — a silently wrong pointer to the transport's one remaining
# locator, on the one case section 13 keeps it for. Both pointer cases already hand
# the reader an explicit path, so this costs a convenience and never a record.
want 5f "[[TAP v0.23 note $ID path=$P]]" "$(render tap/a b "$ID" discuss settle-only "" "$P" "$B")"

# 5g — the eligibility limit is 200 BYTES and is measured the same in every locale.
# `${#body}` counts characters under a UTF-8 LC_CTYPE and bytes under LC_ALL=C, and
# `tap send` runs in the operator's environment, which pins neither. The suite pins
# a UTF-8 LC_CTYPE, so a character-based rule would agree with the Bun side only
# where the locale cooperates — a fixture more generous than the world. This arm
# runs the boundary under BOTH, so the claim is measured rather than asserted.
E50="$(printf '\xf0\x9f\x98\x80%.0s' $(seq 1 50))"   # 50 emoji = 200 bytes = 50 chars
E51="$(printf '\xf0\x9f\x98\x80%.0s' $(seq 1 51))"   # 51 emoji = 204 bytes = 51 chars
want 5g1 "[[TAP v0.23 note $ID: $E50]]" "$(render a b "$ID" discuss settle-only "" "$P" "$E50")"
want 5g2 "[[TAP v0.23 note $ID]]"       "$(render a b "$ID" discuss settle-only "" "$P" "$E51")"
want 5g3 "[[TAP v0.23 note $ID: $E50]]" "$(LC_ALL=C render a b "$ID" discuss settle-only "" "$P" "$E50")"
want 5g4 "[[TAP v0.23 note $ID]]"       "$(LC_ALL=C render a b "$ID" discuss settle-only "" "$P" "$E51")"

# 5h — the impossible token shape is refused rather than rendered. A qualified
# recipient with an unqualified sender would emit no prefix AND no pointer, and the
# reader would look on its own bus for bytes that live on the sender's.
( render a tap/b "$ID" discuss expected "" "$P" ) >/dev/null 2>&1 \
  && fail "(5h) a team-qualified recipient with a bare sender must be refused, not rendered"
echo "wire-v023: (5h): ok"

echo "wire-v023: ok"
