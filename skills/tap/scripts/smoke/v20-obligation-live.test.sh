#!/usr/bin/env bash
# tap-zex3: ACTS v0.20 obligations must not skip on an unreadable/invalid marker.
# Soft tap_registry_v20_live treats both as "not live" (fail-open). The ACTS helper
# refuses instead. An absent marker refuses too: nothing is enrolled, so there is
# no legacy door to skip to.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# shellcheck source=helpers.sh
. "$ROOT/skills/tap/scripts/smoke/helpers.sh"
tap_smoke_runtime

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TAP_INDEX_HOME="$WORK/index"
mkdir -p "$TAP_INDEX_HOME"

fail() { echo "v20-obligation-live: $*" >&2; exit 1; }

TEAM="$WORK/team"
BUS="$TEAM/.tap/bus"
mkdir -p "$BUS/payloads" "$BUS/receipts" "$TEAM/.tap"
export TAP_HOME="$BUS"
export TAP_REGISTRY="$BUS/registry.json"

write_live_flip() {
  python3 -B - "$TAP_INDEX_HOME" "$TEAM" <<'PY'
import json, pathlib, sys
idx, team = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
reg = team / ".tap" / "team-registry.json"
reg.parent.mkdir(parents=True, exist_ok=True)
reg.write_text(json.dumps({
  "schema": "0.20",
  "team": {"name": "team"},
  "seats": {
    "alice": {
      "status": "active", "delivery": "poll", "harness": "claude",
      "instance": "alice|cur", "registered_at": "t",
    },
    "bob": {
      "status": "active", "delivery": "poll", "harness": "claude",
      "instance": "bob|b1", "registered_at": "t",
    },
  },
}) + "\n")
(idx / "global-registry.json").write_text(json.dumps({
  "schema": "0.20",
  "teams": {"team": {
    "root": str(team),
    "registry_location": str(reg),
  }},
}) + "\n")
# Legacy bus registry left present for ambient TAP_HOME fixtures.
bus = team / ".tap" / "bus"
(bus / "registry.json").write_text(json.dumps({
  "schema": "0.20", "team": {"name": "team", "worktree_root": str(team)},
  "seats": {
    "alice": {"status": "active", "delivery": "poll", "harness": "claude",
              "instance": "alice|cur"},
    "bob": {"status": "active", "delivery": "poll", "harness": "claude",
            "instance": "bob|b1"},
  },
}) + "\n")
PY
}

stage_bound_inbound() {
  # Predecessor-bound mail: stamp alice|pred, current seat is alice|cur.
  local id="$1"
  cat >"$BUS/payloads/${id}.md" <<EOF
---
id: $id
from: bob
to: alice
kind: discuss
path: $BUS/payloads/${id}.md
reply: settle-only
recipient_instance: alice|pred
---
body
EOF
}

# --- (a) RED-first: done under INVALID must refuse (was silent skip) ----------
write_live_flip
ID="bob-20260731T000000Z-zex3done0001"
stage_bound_inbound "$ID"
printf '%s\n' '{"schema":"9.99"}' >"$TAP_INDEX_HOME/global-registry.json"
set +e
out="$(TAP_JSON=1 "$TAP" read "$ID" --by alice --team team 2>"$WORK/done.err")"
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "(a) done under invalid must refuse; out=$out err=$(cat "$WORK/done.err")"
grep -Eiq 'invalid_flip' <<<"$out" \
  || fail "(a) done JSON must name invalid_flip: out=$out err=$(cat "$WORK/done.err")"
[ ! -f "$BUS/receipts/${ID}.done" ] \
  || fail "(a) done must not write receipt under invalid marker"
echo "v20-obligation-live: (a) done refuses invalid_flip (no silent settle): ok"

# --- (b) reply under INVALID must refuse --------------------------------------
write_live_flip
ID="bob-20260731T000000Z-zex3reply001"
stage_bound_inbound "$ID"
# reply=expected for reply verb
python3 -B - "$BUS/payloads/${ID}.md" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
text = p.read_text().replace("reply: settle-only", "reply: expected")
p.write_text(text)
PY
printf '%s\n' '{"schema":"9.99"}' >"$TAP_INDEX_HOME/global-registry.json"
set +e
out="$(TAP_JSON=1 "$TAP" reply "$ID" --by alice --team team -m "should not land" 2>"$WORK/reply.err")"
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "(b) reply under invalid must refuse"
grep -Eiq 'invalid_flip' <<<"$out" \
  || fail "(b) reply JSON must name invalid_flip: out=$out err=$(cat "$WORK/reply.err")"
echo "v20-obligation-live: (b) reply refuses invalid_flip: ok"

# --- (c) poll under INVALID must refuse (not show unfiltered inbox) -----------
write_live_flip
ID="bob-20260731T000000Z-zex3poll0001"
stage_bound_inbound "$ID"
printf '%s\n' '{"schema":"9.99"}' >"$TAP_INDEX_HOME/global-registry.json"
set +e
TAP_JSON=1 "$TAP" poll alice --team team 2>"$WORK/poll.err" >"$WORK/poll.out"
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "(c) poll under invalid must refuse; out=$(cat "$WORK/poll.out")"
grep -Eiq 'invalid_flip|present but invalid' "$WORK/poll.out" "$WORK/poll.err" \
  || fail "(c) poll must name invalid refuse: out=$(cat "$WORK/poll.out") err=$(cat "$WORK/poll.err")"
echo "v20-obligation-live: (c) poll refuses invalid_flip: ok"

# --- (d) outstanding under INVALID must refuse --------------------------------
write_live_flip
OID="alice-20260731T000000Z-zex3out0001"
cat >"$BUS/payloads/${OID}.md" <<EOF
---
id: $OID
from: alice
to: bob
kind: discuss
path: $BUS/payloads/${OID}.md
reply: settle-only
sender_instance: alice|pred
---
body
EOF
printf '%s\n' '{"schema":"9.99"}' >"$TAP_INDEX_HOME/global-registry.json"
set +e
TAP_JSON=1 "$TAP" outstanding alice --team team 2>"$WORK/out.err" >"$WORK/out.out"
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "(d) outstanding under invalid must refuse; out=$(cat "$WORK/out.out")"
grep -Eiq 'invalid_flip|present but invalid' "$WORK/out.out" "$WORK/out.err" \
  || fail "(d) outstanding must name invalid refuse: out=$(cat "$WORK/out.out") err=$(cat "$WORK/out.err")"
echo "v20-obligation-live: (d) outstanding refuses invalid_flip: ok"

# --- (e) an absent index refuses the native settle (born live, F1) -----------
rm -f "$TAP_INDEX_HOME/global-registry.json"
cat >"$TAP_REGISTRY" <<JSON
{
  "schema": "0.20", "team": {"name": "team", "worktree_root": "$TEAM"},
  "seats": {
    "alice": {"status": "active", "delivery": "poll", "harness": "claude"},
    "bob": {"status": "active", "delivery": "poll", "harness": "claude"}
  }
}
JSON
ID="bob-20260731T000000Z-zex3abs0001"
cat >"$BUS/payloads/${ID}.md" <<EOF
---
id: $ID
from: bob
to: alice
kind: discuss
path: $BUS/payloads/${ID}.md
reply: settle-only
---
body
EOF
rc=0
"$TAP" read "$ID" --by alice --team team >"$WORK/absent.out" 2>&1 || rc=$?
[ "$rc" -ne 0 ] || fail "(e) an absent index must refuse the settle"
grep -q 'no machine index' "$WORK/absent.out" \
  || fail "(e) the refusal must name the missing machine index: $(cat "$WORK/absent.out")"
[ ! -e "$BUS/receipts/${ID}.done" ] || fail "(e) a refused settle wrote a receipt"
echo "v20-obligation-live: (e) an absent index refuses the native settle: ok"

# --- (f) live still enforces instance mismatch --------------------------------
write_live_flip
ID="bob-20260731T000000Z-zex3live0001"
stage_bound_inbound "$ID"
# A predecessor note now retires on read; asks still exercise the instance refusal.
python3 - "$BUS/payloads/$ID.md" <<'PYASK'
from pathlib import Path
import sys
p=Path(sys.argv[1]);p.write_text(p.read_text().replace("reply: settle-only", "reply: expected"))
PYASK
set +e
"$TAP" read "$ID" --by alice --team team 2>"$WORK/live.err"
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "(f) live mismatch must refuse settle"
[ ! -e "$BUS/receipts/$ID.done" ] && [ ! -e "$BUS/receipts/$ID.read" ] || fail "(f) stale ask gained a receipt"
grep -Eiq 'not_addressee|recipient instance' "$WORK/live.err" \
  || fail "(f) live mismatch must name instance refuse: $(cat "$WORK/live.err")"
echo "v20-obligation-live: (f) live instance gate still binds: ok"

# --- (g) RED-first: read --force under INVALID must refuse (thread 13 / T1) ---
# `--force` overrides exactly the addressee handle and a stale
# recipient_instance (CONTRACT §read) — never the authority marker itself.
# tap_v20_obligation_live is not a pure predicate (it tap_fail's), and the
# incumbent read body's `[ "$FORCE" = 0 ] &&` prefix short-circuited it
# entirely, so a forced read of a NOTE settled terminal .done over a damaged
# registry while every other ACTS obligation failed closed. The reorder makes
# the marker check unconditional, as tap-reply-settle.sh's settle path already
# is and as the native read door now is. Assert the receipt is ABSENT,
# not just the rc — an absent marker returns 1 cleanly and is green either way,
# so this arm turns on present-but-wrong-schema only.
write_live_flip
ID_G="bob-20260731T000000Z-zex3gread0001"
stage_bound_inbound "$ID_G"
printf '%s\n' '{"schema":"9.99"}' >"$TAP_INDEX_HOME/global-registry.json"
gbefore="$(ls "$BUS/receipts" 2>/dev/null | sort; find "$BUS/receipts" -name '*.done' -type f -exec cat {} + | shasum)"
set +e
gout="$(TAP_JSON=1 "$TAP" read "$ID_G" --force --by alice --team team 2>"$WORK/g.err")"
grc=$?
set -e
[ "$grc" -ne 0 ] || fail "(g) forced read under invalid marker must refuse; out=$gout err=$(cat "$WORK/g.err")"
grep -Eiq 'invalid_flip|present but invalid' <<<"$gout" \
  || grep -Eiq 'invalid_flip|present but invalid' "$WORK/g.err" \
  || fail "(g) forced read must name invalid_flip: out=$gout err=$(cat "$WORK/g.err")"
[ ! -f "$BUS/receipts/${ID_G}.done" ] && [ ! -f "$BUS/receipts/${ID_G}.read" ] \
  || fail "(g) the refused forced read wrote a receipt — receipts dir: $(ls "$BUS/receipts")"
[ "$(ls "$BUS/receipts" 2>/dev/null | sort; find "$BUS/receipts" -name '*.done' -type f -exec cat {} + | shasum)" = "$gbefore" ] \
  || fail "(g) the refused forced read changed the receipts directory"
echo "v20-obligation-live: (g) read --force refuses invalid_flip and writes nothing: ok"

# --- (g2) the unreadable-marker class, through the public verb ----------------
# Same guard, second class the ruling names: the marker is UNREADABLE (not
# absent). The native reader's readIndexJson decodes global-registry.json with
# fatal UTF-8, so invalid UTF-8 bytes in the index marker deterministically
# produce the unreadable class — no permissions games, no scripts-dir hook.
write_live_flip
ID_G2="bob-20260731T000000Z-zex3gread0002"
stage_bound_inbound "$ID_G2"
printf '\xff\xfe invalid utf-8' > "$TAP_INDEX_HOME/global-registry.json"
set +e
g2out="$(TAP_JSON=1 "$TAP" read "$ID_G2" --force --by alice --team team 2>"$WORK/g2.err")"
g2rc=$?
set -e
[ "$g2rc" -ne 0 ] || fail "(g2) forced read under unreadable marker must refuse; out=$g2out err=$(cat "$WORK/g2.err")"
[ ! -f "$BUS/receipts/${ID_G2}.done" ] && [ ! -f "$BUS/receipts/${ID_G2}.read" ] \
  || fail "(g2) the refused forced read wrote a receipt"
echo "v20-obligation-live: (g2) read --force refuses an unreadable marker too: ok"

echo "v20-obligation-live: ok"
