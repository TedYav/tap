#!/usr/bin/env bash
# tap-o4ae: fixture env must stay in this process. Refuse `source` so an
# interactive shell cannot inherit top-level exports.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# register-recap-zero-state.test.sh — CONTRACT.md §Rebind recap, REGISTER surface.
#
# rebind-recap.test.sh drives `tap recap` THE VERB. Nothing drove the recap that
# `tap register` itself emits on a rebind, and that gap shipped two defects: the
# counts printed only when nonzero (so a clean reconnect showed "recent
# exchanges" and nothing else, which a fresh instance reads as work owed), and a
# second, older passive note fired underneath pointing at `tap poll` — a command
# that shows an EMPTY queue when the inherited traffic is settled.
#
# Two arms, both load-bearing. The CLEAN arm pins the zeros and the absence of
# the no-op pointer. The LOADED arm exists because "prints 0" is a predicate a
# hardcoded-zeros regression satisfies for free: the same line has to be caught
# counting real obligations in the same run.
#
# Pane-less on purpose: `--delivery poll` reaches the same briefing emitter as a
# pane register, so this needs no tmux stub — and the assertion is about text the
# emitter produced, not about how the seat is delivered to.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# shellcheck source=sandbox-pins.sh
. "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "register-recap-zero-state: $*" >&2; exit 1; }

# TAP_HOME ALONE DOES NOT ISOLATE THIS (tap-3ywn class): post-flip the acting
# registry resolves through the machine index, so a fixture redirecting only the
# bus writes the OPERATOR'S live seat rows. TAP_INDEX_HOME is the knob, and the
# scratch root must be a git worktree whose basename is the team name or
# registration refuses `refusing bus decoy` before reaching the code under test.
seed_arm() { # <name> ; echoes the scratch root of a team with an EXISTING peggy seat
  local name="$1"
  local root="$WORK/$name/wolp" index="$WORK/$name-index"
  mkdir -p "$root/.tap/bus/payloads" "$root/.tap/bus/receipts" "$index"
  git -C "$root" init -q
  python3 -B - "$index" "$root" <<'PY'
import json, os, sys
index, root = sys.argv[1:3]
registry = os.path.join(root, ".tap", "team-registry.json")
with open(os.path.join(index, "global-registry.json"), "w") as fh:
    json.dump({"migrated": {}, "schema": "0.20", "teams": {"wolp": {
        "enrolled_at": "2026-08-14T00:00:00Z", "registry_location": registry,
        "root": root, "state": "registered"}}}, fh)
# The seat ALREADY EXISTS — that is what makes the next register a rebind
# (prior_existing) rather than a first join, and the rebind is the only shape
# that prints a recap at all.
seat = {"base": "wolp", "delivery": "poll", "status": "active", "harness": "claude",
        "index": 1, "registered_from_worktree": root}
with open(registry, "w") as fh:
    json.dump({"schema": "0.20", "team": {"name": "wolp", "worktree_root": root},
               "seats": {"peggy": seat}}, fh)
PY
  printf '%s' "$root"
}

mkpayload() { # <root> <id> <from> <to> <kind> [settled]
  local root="$1" id="$2" from="$3" to="$4" kind="$5" settled="${6:-}"
  cat > "$root/.tap/bus/payloads/$id.md" <<EOF
---
id: $id
from: $from
to: $to
kind: $kind
---
body of $id
EOF
  [ -z "$settled" ] || : > "$root/.tap/bus/receipts/$id.done"
}

register_once() { # <root> <index> <out>
  ( cd "$1" && env -u TAP_CLEAR_ID -u TMUX -u TMUX_PANE \
      TAP_INDEX_HOME="$2" TAP_HOME="$1/.tap/bus" TAP_SKIP_VERSION_BRIEFING=1 \
      bash "$TAP" register peggy --delivery poll --team wolp >"$3" 2>&1 ) || true
}

# --- ARM 1: CLEAN REBIND — settled history only, nothing owed -----------------
CLEAN="$(seed_arm clean)"
mkpayload "$CLEAN" clean-001 peer peggy discuss settled
mkpayload "$CLEAN" clean-002 peggy peer discuss settled
mkpayload "$CLEAN" clean-003 peer peggy assign settled
OUT="$WORK/clean.out"
register_once "$CLEAN" "$WORK/clean-index" "$OUT"

grep -q "you have re-joined as wolp/peggy" "$OUT" \
  || fail "(1) clean rebind printed no recap: $(tail -5 "$OUT")"
# The zeros are the whole point. Printing only "3 recent exchanges" is what made
# a fresh instance believe it had inherited work.
grep -q "tap recap: 0 unsettled inbound, 0 of your sends awaiting a reply, 3 recent exchanges on record\." "$OUT" \
  || fail "(1) counts line missing or not zero-stated: $(grep 'tap recap:' "$OUT")"
# The no-op pointer, asserted SECOND but independently: `tap poll peggy` here
# shows an EMPTY queue — every inherited payload is settled — so naming it is
# worse than silence. Checked with its own message so a red is attributable.
if grep -q "next: tap poll" "$OUT"; then
  fail "(1) clean rebind still names tap poll, which would show an empty queue"
fi

# --- ARM 2: LOADED REBIND — real obligations, same line counting them ---------
# Without this arm, a regression that hardcoded zeros would pass arm 1.
LOADED="$(seed_arm loaded)"
mkpayload "$LOADED" load-001 peer peggy discuss           # unsettled inbound
mkpayload "$LOADED" load-002 peer peggy assign            # unsettled inbound
mkpayload "$LOADED" load-003 peggy peer discuss           # unsettled send of mine
mkpayload "$LOADED" load-004 peggy peer discuss settled   # history only
OUT2="$WORK/loaded.out"
register_once "$LOADED" "$WORK/loaded-index" "$OUT2"

# 2 recent, not 1: history admits a payload I SENT whether or not it settled
# (load-003, load-004) and drops unsettled traffic addressed TO me — INBOUND
# obligations are counted in the first bucket and deliberately not repeated here.
# Outstanding sends ARE counted twice on purpose: load-003 is the 1 in "awaiting
# a reply" and one of the 2 on record. The buckets are not disjoint, which is why
# the line says "on record" rather than presenting a third obligation count.
grep -q "tap recap: 2 unsettled inbound, 1 of your sends awaiting a reply, 2 recent exchanges on record\." "$OUT2" \
  || fail "(2) counts line did not count real obligations: $(grep 'tap recap:' "$OUT2")"
grep -q "tap recap: unsettled inbound — .*load-001" "$OUT2" \
  || fail "(2) obligations must still be handed over BY ID: $(grep 'tap recap:' "$OUT2")"
grep -q "tap recap: awaiting a reply — .*load-003" "$OUT2" \
  || fail "(2) own outstanding sends must still be handed over BY ID: $(grep 'tap recap:' "$OUT2")"

echo "register-recap-zero-state: ok"
