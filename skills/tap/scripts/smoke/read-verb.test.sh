#!/usr/bin/env bash
# read-verb.test.sh — tap-7r3fn.5 (W6 U2): `tap read <id|team/id|12hex> [--force]`.
#
# `tap read` is the RECIPIENT's verb and the other half of the side-effect split
# (spec §11): `tap show` is everyone's and writes nothing; `read` is addressed to
# you and writes a receipt. A NOTE settles on read; an ASK writes `.read` and
# stays open, because an ask has exactly one discharge and it is `tap reply`.
#
# The arms that matter most are the ones asserting what read does NOT do: it
# never settles an ask, never mints a second observation, and never writes
# anything at all on a refusal. Each has a mutation arm.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
FIX="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$FIX" "$FAKE_BIN"' EXIT
export PATH="$FAKE_BIN:$PATH"

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  display-message) echo "" ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

ALPHA="$FIX/alpha"; BETA="$FIX/beta"
mkdir -p "$ALPHA/.tap/bus/payloads" "$ALPHA/.tap/bus/receipts"
mkdir -p "$BETA/.tap/bus/payloads"  "$BETA/.tap/bus/receipts"
cat > "$ALPHA/.tap/bus/registry.json" <<JSON
{"schema": "0.20", "team":{"name":"alpha"},"seats":{"worker":{"status":"active","delivery":"pane","pane":"alpha:0.1","harness":"codex"},"other":{"status":"active","delivery":"pane","pane":"alpha:0.2","harness":"codex"}}}
JSON
cat > "$BETA/.tap/bus/registry.json" <<JSON
{"schema": "0.20", "team":{"name":"beta"},"seats":{"fable":{"status":"active","delivery":"poll","harness":"daemon"}}}
JSON
export TAP_INDEX_HOME="$FIX/index"; mkdir -p "$TAP_INDEX_HOME"
# Born live (F1): both teams are enrolled in the machine index.
enroll_index() { # <index-dir> <name=root>...
  python3 -B - "$@" <<'PY'
import json, os, sys
index, pairs = sys.argv[1], sys.argv[2:]
teams = {}
for pair in pairs:
    name, root = pair.split("=", 1)
    root = os.path.realpath(root)
    teams[name] = {"root": root, "registry_location": os.path.join(root, ".tap", "bus", "registry.json"), "state": "registered"}
json.dump({"schema": "0.20", "teams": teams}, open(os.path.join(index, "global-registry.json"), "w"))
PY
}
enroll_index "$TAP_INDEX_HOME" "alpha=$ALPHA" "beta=$BETA"

A_BUS="$ALPHA/.tap/bus"; B_BUS="$BETA/.tap/bus"
fail() { echo "read-verb: $*" >&2; exit 1; }

# Assert a receipt exists AND parses AND carries the fields that make it a
# receipt. `[ -f ]` alone once passed a zero-byte file for four separate arms.
receipt_ok() { # <path> <label>
  [ -f "$1" ] || fail "$2: receipt $1 does not exist"
  [ -s "$1" ] || fail "$2: receipt $1 exists but is EMPTY — a pathname is not a receipt"
  python3 -B -c '
import json, sys
r = json.load(open(sys.argv[1]))
assert r.get("id"), "no id"
assert r.get("at"), "no at"
assert r.get("by"), "no by"
' "$1" || fail "$2: receipt $1 does not parse or lacks id/at/by"
}

plant() { # <bus> <id> <to> <reply> <body>
  local bus="$1" id="$2" to="$3" reply="$4" body="$5"
  { printf '%s\n' '---' "id: $id" 'from: fable' "to: $to" 'kind: discuss' \
      "reply: $reply" "path: $bus/payloads/$id.md" '---' '' "$body"; \
  } > "$bus/payloads/$id.md"
}
# Receipt-directory fingerprint: names + bytes, so "wrote nothing" is checkable
# and a rewrite of an existing receipt with identical bytes is still visible via
# the hash of the whole set.
receipts_of() { # <bus>
  python3 -B - "$1/receipts" <<'PY'
import hashlib, os, sys
d = sys.argv[1]
out = []
for n in sorted(os.listdir(d)) if os.path.isdir(d) else []:
    p = os.path.join(d, n)
    with open(p, "rb") as fh:
        out.append("%s\t%s\t%.9f" % (n, hashlib.sha256(fh.read()).hexdigest(), os.lstat(p).st_mtime))
print("\n".join(out))
PY
}

# --- (1) a NOTE settles on read ---------------------------------------------
ID_NOTE="fable-20260903T120000Z-aaaaaaaaaaaa"
plant "$A_BUS" "$ID_NOTE" worker settle-only 'the note body'
out="$(TAP_HOME="$A_BUS" "$TAP" read "$ID_NOTE" --by worker 2>&1)" \
  || fail "(1) read of a note exited non-zero: $out"
case "$out" in *'the note body'*) ;; *) fail "(1) read printed no body" ;; esac
receipt_ok "$A_BUS/receipts/$ID_NOTE.done" "(1)"
python3 -B - "$A_BUS/receipts/$ID_NOTE.done" <<'PY' || fail "(1) note .done provenance is not via=read by the reader"
import json, sys
r = json.load(open(sys.argv[1]))
assert r["via"] == "read", r
assert r["by"] == "worker", r
PY
[ ! -f "$A_BUS/receipts/$ID_NOTE.read" ] || fail "(1) a note minted a .read as well as a .done; one receipt per discharge"
echo "read-verb: (1) a note settles on read, via=read, by the reader: ok"

# --- (2) an ASK writes .read and stays OPEN ----------------------------------
ID_ASK="fable-20260903T120001Z-bbbbbbbbbbbb"
plant "$A_BUS" "$ID_ASK" worker expected 'the ask body'
out="$(TAP_HOME="$A_BUS" "$TAP" read "$ID_ASK" --by worker 2>&1)" \
  || fail "(2) read of an ask exited non-zero: $out"
case "$out" in *'the ask body'*) ;; *) fail "(2) read printed no body for the ask" ;; esac
receipt_ok "$A_BUS/receipts/$ID_ASK.read" "(2)"
[ ! -f "$A_BUS/receipts/$ID_ASK.done" ] \
  || fail "(2) READ SETTLED AN ASK — an ask has exactly one discharge and it is tap reply"
case "$out" in *' reply'*) ;; *) fail "(2) the header did not retain the reply obligation" ;; esac
echo "read-verb: (2) an ask writes .read, stays open, and its tail names tap reply: ok"

# --- (3) .read is an observation, never a discharge --------------------------
# tap_is_done is `.done OR .cancelled` (lib.sh:1148). If .read ever counted, the
# ask would vanish from the SENDER's outstanding and the obligation would be
# silently discharged by a look.
poll_out="$(TAP_HOME="$A_BUS" "$TAP" poll worker 2>/dev/null || true)"
case "$poll_out" in *"$ID_ASK"*) ;; *) fail "(3) a READ ask disappeared from the recipient's poll — .read is counting as settlement" ;; esac
case "$poll_out" in *"$ID_NOTE"*) fail "(3) the settled note is still pending" ;; *) ;; esac
echo "read-verb: (3) a read ask stays pending; a read note does not: ok"

# --- (4) first observation wins: a second read mints nothing -----------------
before="$(receipts_of "$A_BUS")"
sleep 1                     # cross a whole second so a rewrite would be visible
TAP_HOME="$A_BUS" "$TAP" read "$ID_ASK" --by worker >/dev/null 2>&1 \
  || fail "(4) a second read of an ask exited non-zero"
after="$(receipts_of "$A_BUS")"
[ "$before" = "$after" ] || {
  echo "read-verb: (4) a second read changed the receipts; diff follows" >&2
  diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") >&2 || true
  exit 1
}
echo "read-verb: (4) first observation wins — a re-read after compaction mints nothing: ok"

# --- (5) to != me refuses, and writes NOTHING --------------------------------
ID_OTHER="fable-20260903T120002Z-cccccccccccc"
plant "$A_BUS" "$ID_OTHER" other settle-only 'not addressed to worker'
before="$(receipts_of "$A_BUS")"
set +e
ref="$(TAP_HOME="$A_BUS" "$TAP" read "$ID_OTHER" --by worker 2>&1)"; refrc=$?
set -e
[ "$refrc" -ne 0 ] || fail "(5) read by a non-recipient exited 0"
[ "$(receipts_of "$A_BUS")" = "$before" ] || fail "(5) a REFUSED read wrote something"
case "$ref" in *'tap show'*) ;; *) fail "(5) the refusal does not name tap show: $ref" ;; esac
case "$ref" in *'--force'*) ;; *) fail "(5) the refusal does not name --force: $ref" ;; esac
echo "read-verb: (5) to!=me refuses, writes nothing, and teaches both other doors: ok"

# --- (6) --force reads on their behalf and RECORDS the real reader -----------
out="$(TAP_HOME="$A_BUS" "$TAP" read "$ID_OTHER" --force --by worker 2>&1)" \
  || fail "(6) --force read exited non-zero: $out"
case "$out" in *'not addressed to worker'*) ;; *) fail "(6) --force read printed no body" ;; esac
receipt_ok "$A_BUS/receipts/$ID_OTHER.done" "(6)"
python3 -B - "$A_BUS/receipts/$ID_OTHER.done" <<'PY' || fail "(6) forced receipt does not record the real reader"
import json, sys
r = json.load(open(sys.argv[1]))
assert r.get("forced") in (True, "true"), r
# The reader is recorded as themselves. The override never lets a reader claim
# to BE the recipient (spec §11: no impersonation).
assert r["by"] == "worker", r
assert r.get("to") in (None, "other"), r
PY
grep -q 'read_forced' "$A_BUS/registry-events.log" 2>/dev/null \
  || grep -rq 'read_forced' "$A_BUS"/*events* 2>/dev/null \
  || fail "(6) a forced read left no registry event"
echo "read-verb: (6) --force records the actual reader plus a registry event: ok"

# --- (7) identity provenance: declared vs observed ---------------------------
python3 -B - "$A_BUS/receipts/$ID_NOTE.done" <<'PY' || fail "(7) a --by receipt does not mark its identity as declared"
import json, sys
r = json.load(open(sys.argv[1]))
assert r.get("identity") == "declared", r
# A declared identity has no observed pane to record, and inventing one would be
# the receipt asserting more than the resolver knew.
assert "pane" not in r or not r["pane"], r
PY
echo "read-verb: (7) a declared (--by) identity is recorded as declared, with no invented pane: ok"

# --- (8) an already-settled note is a designed case, not a refusal -----------
# Most notes on a live bus arrive pre-settled by courier auto-settle
# (§Courier deferred auto-settlement), so this is the COMMON path, not an edge.
ID_PRE="fable-20260903T120003Z-dddddddddddd"
plant "$A_BUS" "$ID_PRE" worker settle-only 'a pre-settled note'
printf '{"id":"%s","status":"done","at":"2026-09-03T12:00:04Z","by":"worker","via":"courier-auto"}\n' \
  "$ID_PRE" > "$A_BUS/receipts/$ID_PRE.done"
before="$(receipts_of "$A_BUS")"
out="$(TAP_HOME="$A_BUS" "$TAP" read "$ID_PRE" --by worker 2>&1)" \
  || fail "(8) reading a pre-settled note exited non-zero: $out"
case "$out" in *'a pre-settled note'*) ;; *) fail "(8) a pre-settled note printed no body — the body is the point of reading it" ;; esac
case "$out" in *' settled'*) ;; *) fail "(8) read did not report prior settlement: $out" ;; esac
[ "$(receipts_of "$A_BUS")" = "$before" ] || fail "(8) reading a pre-settled note rewrote its receipt"
echo "read-verb: (8) a pre-settled note prints its body, names the prior settlement, and rewrites nothing: ok"

# --- (8b) a payload with NO reply: field is an ASK, and read must not settle it
# This is the corpus's most common shape, not an edge: 34 of the 55 `tap done`
# call sites under smoke/ and regress/ target payloads whose fixture never sets
# `reply:` at all. CONTRACT §Reply expectation says an envelope with no reply
# field is v0.2 traffic and reads as EXPECTED, so defaulting the other way would
# let a LOOK settle every one of them — silently, and on the majority of the
# bus's own test corpus. Every other arm here plants an explicit `reply:`, so
# without this one the default is unexercised and a mutant flipping it survives.
ID_BARE="fable-20260903T120007Z-777777777777"
{ printf '%s\n' '---' "id: $ID_BARE" 'from: fable' 'to: worker' 'kind: discuss' \
    "path: $A_BUS/payloads/$ID_BARE.md" '---' '' 'a payload with no reply field'; \
} > "$A_BUS/payloads/$ID_BARE.md"
out="$(TAP_HOME="$A_BUS" "$TAP" read "$ID_BARE" --by worker 2>&1)" \
  || fail "(8b) reading a fieldless payload exited non-zero: $out"
[ ! -f "$A_BUS/receipts/$ID_BARE.done" ] \
  || fail "(8b) READ SETTLED A PAYLOAD WITH NO reply: FIELD — CONTRACT reads an absent field as expected, so this is an ask and a look must not discharge it"
receipt_ok "$A_BUS/receipts/$ID_BARE.read" "(8b)"
case "$out" in *'tap read: ask '*) ;; *) fail "(8b) a fieldless payload was not labelled an ask in the header: $out" ;; esac
case "$out" in *' reply'*) ;; *) fail "(8b) a fieldless payload's header lost its reply obligation" ;; esac
echo "read-verb: (8b) a payload with no reply: field reads as an ask and is not settled by reading it: ok"

# --- (9) the output is one obligation header and the full body ------------------------
ID_SHAPE="fable-20260903T120005Z-eeeeeeeeeeee"
plant "$A_BUS" "$ID_SHAPE" worker expected 'shape body'
out="$(TAP_HOME="$A_BUS" "$TAP" read "$ID_SHAPE" --by worker 2>/dev/null)"
head1="$(printf '%s\n' "$out" | head -1)"
case "$head1" in *fable*) ;; *) fail "(9) the header line does not name the sender: $head1" ;; esac
case "$head1" in *ask*) ;; *) fail "(9) the header line does not carry the obligation word: $head1" ;; esac
[ "$(printf '%s\n' "$out" | grep -c '^tap read:')" = 1 ] || fail "(9) expected one receipt header"
[ "$(printf '%s\n' "$out" | grep -c '^→' || true)" = 0 ] || fail "(9) duplicate footer remains"
# No frontmatter: `read` is the working surface, `show` is the forensic one.
case "$out" in *'recipient_instance'*|*'path: '*) fail "(9) read printed frontmatter; that is tap show's job" ;; *) ;; esac
echo "read-verb: (9) one header line, the body, and no duplicate footer/frontmatter: ok"

# --- (10) cross-worktree: the receipt lands on the SENDER's bus --------------
ID_XWT="fable-20260903T120006Z-ffffffffffff"
{ printf '%s\n' '---' "id: $ID_XWT" 'from: fable' 'to: worker' 'kind: discuss' \
    'reply: settle-only' "path: $B_BUS/payloads/$ID_XWT.md" \
    'from_team: beta' 'to_team: alpha' 'cross_worktree: true' '---' '' 'a cross-worktree note'; \
} > "$B_BUS/payloads/$ID_XWT.md"
out="$(TAP_HOME="$A_BUS" "$TAP" read "$ID_XWT" --by worker 2>&1)" \
  || fail "(10) cross-worktree read failed: $out"
case "$out" in *'a cross-worktree note'*) ;; *) fail "(10) cross-worktree read printed no body" ;; esac
receipt_ok "$B_BUS/receipts/$ID_XWT.done" "(10) sender-bus"
[ ! -f "$A_BUS/receipts/$ID_XWT.done" ] || fail "(10) the receipt wrongly landed on the reader's own bus"
echo "read-verb: (10) a cross-worktree note settles on the sender bus, resolved by bare id: ok"

# --- (11) --force overrides a STALE recipient_instance, not just to!=me ------
# This is the control the partner reviewer asked for in round 1 of the read-back,
# and the reason the boundary moved: spec §11's FIRST expected use of --force is
# the recipient's own session having restarted, where the handle matches and the
# instance does not. A --force that bypassed only the addressee check would
# refuse the exact case the flag was designed for — and without this arm that
# defect is invisible, because every other fixture here is instance-unbound.
# The v0.20 obligation gate is dormant unless a flip marker says `live`, so the
# arm stands up its own flipped team rather than assuming the ambient state.
# ISOLATED INDEX, in a subshell. This arm's flip fixture writes
# global-registry.json, which is the MARKER-SELECTED authority index — writing it
# into the shared TAP_INDEX_HOME silently de-enrolled alpha and beta for every
# later arm, so arm 13's cross-team refusal was really an unresolvable-id
# refusal and its mutants survived while the arm reported ok. An arm that
# reshapes machine-wide state gets its own copy of it, or it decides the outcome
# of every arm after it.
(
FLIP="$FIX/flip"; FBUS="$FLIP/.tap/bus"
mkdir -p "$FBUS/payloads" "$FBUS/receipts"
export TAP_INDEX_HOME="$FIX/index-flip"; mkdir -p "$TAP_INDEX_HOME"
python3 -B - "$TAP_INDEX_HOME" "$FLIP" <<'PY2'
import json, pathlib, sys
idx, team = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
reg = team / ".tap" / "team-registry.json"
reg.parent.mkdir(parents=True, exist_ok=True)
seat = {"status": "active", "delivery": "poll", "harness": "claude",
        "instance": "worker|current", "registered_at": "t"}
reg.write_text(json.dumps({"schema": "0.20", "team": {"name": "flip"},
                           "seats": {"worker": seat}}) + "\n")
(idx / "global-registry.json").write_text(json.dumps({
    "schema": "0.20",
    "teams": {"flip": {"root": str(team), "registry_location": str(reg)}}}) + "\n")
(team / ".tap" / "bus" / "registry.json").write_text(json.dumps({
    "schema": "0.20", "team": {"name": "flip", "worktree_root": str(team)},
    "seats": {"worker": {"status": "active", "delivery": "poll",
                          "harness": "claude", "instance": "worker|current"}}}) + "\n")
PY2

ID_BOUND="fable-20260903T120008Z-888888888888"
{ printf '%s\n' '---' "id: $ID_BOUND" 'from: fable' 'to: worker' 'kind: discuss' \
    'reply: settle-only' "path: $FBUS/payloads/$ID_BOUND.md" \
    'recipient_instance: worker|predecessor' '---' '' 'mail bound to a dead instance'; \
} > "$FBUS/payloads/$ID_BOUND.md"

# Same handle, new instance: reading a predecessor note retires it explicitly.
bout="$(TAP_HOME="$FBUS" "$TAP" read "$ID_BOUND" --by worker 2>&1)" || fail "(11) predecessor note did not retire: $bout"
python3 -B - "$FBUS/receipts/$ID_BOUND.done" <<'PYRETIRED'
import json,sys
r=json.load(open(sys.argv[1]));assert r["reason"]=="instance_retired" and r["by"]=="worker",r
assert not r.get("forced"),r
PYRETIRED
rm "$FBUS/receipts/$ID_BOUND.done"

# The same call WITH --force succeeds and records the reader.
fout="$(TAP_HOME="$FBUS" "$TAP" read "$ID_BOUND" --force --by worker 2>&1)" \
  || fail "(11) --force did not override a stale recipient_instance — this is §11's first expected use: $fout"
case "$fout" in *'mail bound to a dead instance'*) ;; *) fail "(11) forced instance read printed no body" ;; esac
receipt_ok "$FBUS/receipts/$ID_BOUND.done" "(11)"
python3 -B - "$FBUS/receipts/$ID_BOUND.done" <<'PY3' || fail "(11) forced instance receipt does not record the reader"
import json, sys
r = json.load(open(sys.argv[1]))
assert r.get("forced") in (True, "true"), r
assert r["by"] == "worker", r
assert r["via"] == "read", r
assert r.get("to") in (None, "worker"), r
PY3
# T3 pin (thread 1, note half): a forced NOTE settles as the reader with the
# addressee recorded, and mints EXACTLY ONE audit event — the count, not the
# presence, is the pin (arm 16 already proves presence for settled mail).
ev11="$(grep -c read_forced "$FBUS/registry-events.log" 2>/dev/null || printf 0)"
[ "$ev11" = 1 ] || fail "(11) a forced read of a predecessor-bound note minted $ev11 read_forced events (expected 1): $(cat "$FBUS/registry-events.log" 2>/dev/null)"
echo "read-verb: (11) --force overrides a stale recipient_instance and records the reader; without it, records instance_retired: ok"
)

# --- (12) a REFUSED read writes nothing ANYWHERE, from a pristine bus --------
# The committed arm 5 fingerprints receipts/ only, and its fixture pre-creates
# the bus directories — so it could not see that the preflight's tap_ensure_dirs
# wrote `.tap/.gitignore` and `.tap-bus-authority` before the refusal ever ran.
# "Writes anything" is the acceptance condition, not "writes a receipt", so the
# oracle is the whole tree and the bus starts pristine.
PRIS="$FIX/pristine"; PBUS="$PRIS/.tap/bus"
mkdir -p "$PBUS/payloads"
cat > "$PBUS/registry.json" <<JSON
{"schema": "0.20", "team":{"name":"alpha"},"seats":{"other":{"status":"active","delivery":"pane","pane":"alpha:0.9","harness":"codex"}}}
JSON
ID_PRIS="fable-20260903T120009Z-999999999999"
{ printf '%s\n' '---' "id: $ID_PRIS" 'from: fable' 'to: other' 'kind: discuss' \
    'reply: settle-only' "path: $PBUS/payloads/$ID_PRIS.md" '---' '' 'not yours'; \
} > "$PBUS/payloads/$ID_PRIS.md"
tree_of() { python3 -B - "$1" <<'PY2'
import hashlib, os, sys
root = sys.argv[1]; out = []
for dp, dns, fns in os.walk(root):
    dns.sort()
    for n in sorted(fns):
        f = os.path.join(dp, n)
        with open(f, "rb") as fh:
            out.append("%s\t%s" % (os.path.relpath(f, root), hashlib.sha256(fh.read()).hexdigest()))
    for n in sorted(dns):
        out.append("%s/\tdir" % os.path.relpath(os.path.join(dp, n), root))
print("\n".join(out))
PY2
}
pbefore="$(tree_of "$PRIS")"
set +e
TAP_HOME="$PBUS" "$TAP" read "$ID_PRIS" --by worker >/dev/null 2>&1; prc=$?
set -e
[ "$prc" -ne 0 ] || fail "(12) a to!=me read on a pristine bus exited 0"
pafter="$(tree_of "$PRIS")"
[ "$pbefore" = "$pafter" ] || {
  echo "read-verb: (12) a REFUSED read wrote to a pristine bus; diff follows" >&2
  diff <(printf '%s\n' "$pbefore") <(printf '%s\n' "$pafter") >&2 || true
  exit 1
}
echo "read-verb: (12) a refused read writes nothing anywhere, not just no receipt: ok"

# --- (13) team ownership is its own gate, and --force is not a bypass --------
# Two teams may carry the same handle. `tap reply` and `tap done` both refuse on
# the target-team predicate; read has to agree, or the same mail is settleable
# from a bus that does not own it. The committed arm 10 could not see this: its
# payload's to_team matched, so the discarded predicate never mattered.
ID_XTEAM="fable-20260903T120010Z-aaaaaaaa1111"
{ printf '%s\n' '---' "id: $ID_XTEAM" 'from: fable' 'to: worker' 'kind: discuss' \
    'reply: settle-only' "path: $B_BUS/payloads/$ID_XTEAM.md" \
    'from_team: beta' 'to_team: beta' '---' '' 'addressed to beta/worker'; \
} > "$B_BUS/payloads/$ID_XTEAM.md"
xbefore="$(receipts_of "$B_BUS")"
set +e
xout="$(TAP_HOME="$A_BUS" "$TAP" read "$ID_XTEAM" --by worker 2>&1)"; xrc=$?
set -e
[ "$xrc" -ne 0 ] || fail "(13) alpha/worker read mail addressed to beta/worker: $xout"
[ "$(receipts_of "$B_BUS")" = "$xbefore" ] || fail "(13) the cross-team refusal wrote a receipt"
# And --force must not become a third bypass: it overrides the handle and a
# stale instance, never team ownership.
set +e
xfout="$(TAP_HOME="$A_BUS" "$TAP" read "$ID_XTEAM" --force --by worker 2>&1)"; xfrc=$?
set -e
[ "$xfrc" -ne 0 ] || fail "(13) --force bypassed TEAM ownership; it may override only the handle and a stale instance: $xfout"
[ "$(receipts_of "$B_BUS")" = "$xbefore" ] || fail "(13) the forced cross-team attempt wrote a receipt"
echo "read-verb: (13) team ownership refuses with zero writes, and --force is not a third bypass: ok"

# --- (14) terminal state outranks the obligation in the tail ----------------
for term in done cancelled; do
  ID_TASK="fable-20260903T12001${term:0:1}Z-bbbbbbbb2222"
  plant "$A_BUS" "$ID_TASK" worker expected "a settled ask ($term)"
  printf '{"id":"%s","status":"%s","at":"2026-09-03T12:30:00Z","by":"worker","via":"courier-auto"}\n' \
    "$ID_TASK" "$term" > "$A_BUS/receipts/$ID_TASK.$term"
  tout="$(TAP_HOME="$A_BUS" "$TAP" read "$ID_TASK" --by worker 2>&1)" \
    || fail "(14) reading an already-$term ask exited non-zero: $tout"
  case "$tout" in *'→ tap reply'*)
    fail "(14) an already-$term ask still told the reader to tap reply — the header says settled and the tail contradicts it" ;;
  esac
  case "$tout" in *' settled'*) ;; *) fail "(14) an already-$term ask did not report its terminal state: $tout" ;; esac
done
echo "read-verb: (14) a settled ask reports its discharge instead of asking for a reply: ok"

# --- (15) first observation wins under CONCURRENCY, observably ---------------
# The previous version of this arm raced six IDENTICAL readers: same actor, same
# second-granularity timestamp, so any number of writes was observationally the
# same as one and a check-then-O_TRUNC implementation passed it. A concurrency
# claim needs a winner you can NAME. Two levels, because they fail differently:
# the MECHANISM (exactly one creator, published bytes whole) is raced natively,
# where the exclusive publication lives — the deleted primitive race and the
# source-grep/umask parity arms died with the Bash body — and the PUBLIC verb is
# raced here with distinct forced readers, where the winner is observable in
# the receipt's own `by` field.
# 15b races the PUBLIC verb on a NOTE, whose read IS its discharge — the branch
# that was still using a replacing write. Distinct forced readers make the winner
# observable in the receipt's own `by` field, which identical racers could not do.
cat > "$A_BUS/registry.json" <<JSON
{"schema": "0.20", "team":{"name":"alpha"},"seats":{"worker":{"status":"active","delivery":"pane","pane":"alpha:0.1","harness":"codex"},"other":{"status":"active","delivery":"pane","pane":"alpha:0.2","harness":"codex"},"third":{"status":"active","delivery":"pane","pane":"alpha:0.3","harness":"codex"},"fourth":{"status":"active","delivery":"pane","pane":"alpha:0.4","harness":"codex"}}}
JSON
ID_NRACE="fable-20260903T120014Z-eeeeeeee5555"
plant "$A_BUS" "$ID_NRACE" nobody settle-only 'a note two readers force at once'
for who in worker other third fourth; do
  ( TAP_HOME="$A_BUS" "$TAP" read "$ID_NRACE" --force --by "$who" >/dev/null 2>&1 ) &
done
wait
receipt_ok "$A_BUS/receipts/$ID_NRACE.done" "(15b)"
by1="$(python3 -B -c 'import json,sys; print(json.load(open(sys.argv[1]))["by"])' "$A_BUS/receipts/$ID_NRACE.done")"
case "$by1" in worker|other|third|fourth) ;; *) fail "(15b) the note receipt names no racer: $by1" ;; esac
sleep 1
TAP_HOME="$A_BUS" "$TAP" read "$ID_NRACE" --force --by fourth >/dev/null 2>&1
by2="$(python3 -B -c 'import json,sys; print(json.load(open(sys.argv[1]))["by"])' "$A_BUS/receipts/$ID_NRACE.done")"
[ "$by1" = "$by2" ] \
  || fail "(15b) a later reader OVERWROTE the note's discharge provenance: first=$by1 now=$by2 — a note's read is its discharge, so first observation wins there too"
echo "read-verb: (15b) a NOTE's discharge keeps its first reader ($by1) against three racers and a later read: ok"

# The 15b-structural arm that source-grepped the deleted Bash body for the
# first-observation helper is retired with the body. The mechanism it could
# only assert structurally is raced BEHAVIOURALLY in the native suite, where
# the publication lives: read-native.test.ts races firstObservation with
# distinct bodies and demands exactly one creator and whole published bytes —
# the discriminating check the public race above could never be.

# --- (15c) a receipt that cannot be written is never reported as a read ------
# `|| true` on the create suppressed EEXIST and every real error alike, so an
# unwritable receipts directory printed the body, printed the discharge tail,
# and exited 0 having recorded nothing. Only EEXIST is tolerable.
ID_RO="fable-20260903T120015Z-ffffffff6666"
plant "$A_BUS" "$ID_RO" worker expected 'a read that cannot be recorded'
chmod 500 "$A_BUS/receipts"
set +e
rout="$(TAP_HOME="$A_BUS" "$TAP" read "$ID_RO" --by worker 2>&1)"; rorc=$?
set -e
chmod 700 "$A_BUS/receipts"
[ "$rorc" -ne 0 ] \
  || fail "(15c) read exited 0 when it could not write the receipt — it reported a read that left no record"
[ ! -f "$A_BUS/receipts/$ID_RO.read" ] || fail "(15c) a receipt appeared in an unwritable directory"
echo "read-verb: (15c) a receipt that cannot be written refuses instead of reporting success: ok"

# --- (16) a forced read of an ALREADY-SETTLED payload is still audited -------
# The common shape on a live bus is a note the courier already auto-settled, so
# a force audit that lives inside the not-yet-settled branch misses the most
# likely override there is. The receipt is still never rewritten.
ID_FS="fable-20260903T120013Z-dddddddd4444"
plant "$A_BUS" "$ID_FS" other settle-only 'already settled, and not yours'
printf '{"id":"%s","status":"done","at":"2026-09-03T12:40:00Z","by":"other","via":"courier-auto"}\n' \
  "$ID_FS" > "$A_BUS/receipts/$ID_FS.done"
rsnap="$(receipts_of "$A_BUS")"
evbefore="$(grep -c read_forced "$A_BUS/registry-events.log" 2>/dev/null || echo 0)"
TAP_HOME="$A_BUS" "$TAP" read "$ID_FS" --force --by worker >/dev/null 2>&1 \
  || fail "(16) a forced read of a settled note exited non-zero"
[ "$(receipts_of "$A_BUS")" = "$rsnap" ] || fail "(16) the forced read rewrote a terminal receipt"
evafter="$(grep -c read_forced "$A_BUS/registry-events.log" 2>/dev/null || echo 0)"
[ "$evafter" -gt "$evbefore" ] \
  || fail "(16) forcing a read of an ALREADY-SETTLED payload left no audit event — CONTRACT promises the override is recorded, with no exception for settled mail"
echo "read-verb: (16) a forced read of settled mail is audited without rewriting the receipt: ok"

# --- (17) a forced read of a predecessor-bound ASK prints DOORS, not a loop --
# Thread 1 / ruling §4: force on an ask is OBSERVATION ONLY — it confers no
# reply authority, so a tail that says "tap reply" hands the reader a command
# that will be refused (tap-reply's instance gate), which is the livelock this
# thread filed. The tail instead names the sender's cancel, plus the actor-side
# clearing door computed by the shared remedy helper — restore only when the
# rejected instance is a tombstone under the ACTOR's own handle, and never a
# copyable `tap out` (the destructive half of opening that door).
(
FLIP2="$FIX/flip2"; FBUS2="$FLIP2/.tap/bus"
mkdir -p "$FBUS2/payloads" "$FBUS2/receipts"
export TAP_INDEX_HOME="$FIX/index-flip2"; mkdir -p "$TAP_INDEX_HOME"
python3 -B - "$TAP_INDEX_HOME" "$FLIP2" <<'PY2'
import json, pathlib, sys
idx, team = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
reg = team / ".tap" / "team-registry.json"
reg.parent.mkdir(parents=True, exist_ok=True)
seat = {"status": "active", "delivery": "poll", "harness": "claude",
        "instance": "worker|current", "registered_at": "t"}
reg.write_text(json.dumps({"schema": "0.20", "team": {"name": "flip"},
                           "seats": {"worker": seat}}) + "\n")
(idx / "global-registry.json").write_text(json.dumps({
    "schema": "0.20",
    "teams": {"flip": {"root": str(team), "registry_location": str(reg)}}}) + "\n")
(team / ".tap" / "bus" / "registry.json").write_text(json.dumps({
    "schema": "0.20", "team": {"name": "flip", "worktree_root": str(team)},
    "seats": {"worker": {"status": "active", "delivery": "poll",
                          "harness": "claude", "instance": "worker|current"}}}) + "\n")
PY2
ID_ASKF="fable-20260904T120001Z-aaaabbbbcccc"
{ printf '%s\n' '---' "id: $ID_ASKF" 'from: fable' 'to: worker' 'kind: discuss' \
    'reply: expected' "path: $FBUS2/payloads/$ID_ASKF.md" \
    'recipient_instance: worker|predecessor' '---' '' 'a predecessor-bound ask'; \
  } > "$FBUS2/payloads/$ID_ASKF.md"
qout="$(TAP_HOME="$FBUS2" "$TAP" read "$ID_ASKF" --force --by worker 2>&1)" \
  || fail "(17) forced read of a predecessor-bound ask exited non-zero: $qout"
receipt_ok "$FBUS2/receipts/$ID_ASKF.read" "(17)"
[ ! -f "$FBUS2/receipts/$ID_ASKF.done" ] \
  || fail "(17) a FORCED read settled an ask — force is observation only"
case "$qout" in *'tap cancel'*) ;; *) fail "(17) the door tail does not name the sender's cancel: $qout" ;; esac
case "$qout" in *'tap reply'*) fail "(17) the tail still says tap reply — reply will be refused; that is the loop: $qout" ;; esac
printf '%s\n' "$qout" | grep -E '^→.*tap out' >/dev/null \
  && fail "(17) a tail action line offers copyable tap out — the destructive half of the door: $qout"
# And the far side of the loop, closed: reply's refusal stops pointing back at
# `tap read --force` (that string IS thread 1's loop) and names the doors.
set +e
rout="$(TAP_HOME="$FBUS2" "$TAP" reply "$ID_ASKF" --by worker -m "no" 2>&1)"; rrc=$?
set -e
[ "$rrc" -ne 0 ] || fail "(17) reply on a predecessor-bound ask must still refuse"
case "$rout" in *'tap read'*) fail "(17) reply's remedy still names tap read — the loop's other half: $rout" ;; esac
case "$rout" in *'tap cancel'*) ;; *) fail "(17) reply's refusal does not name the sender's cancel: $rout" ;; esac

# (17b) THE DOOR THAT DOES NOT EXIST IS NOT DESCRIBED AS ONE. This fixture has
# no team-history directory, so `worker|predecessor` is a tombstone under NO
# handle — which is not a corner: locally adopted mail binds to the FORK's
# instance, and the reclaim release that adopts it writes no tombstone at all
# (`write_tombstone` is called only from tap-unregister.sh and tap-refresh.sh).
# The remedy helper answers that case by RETURNING 0 with prose in
# _REMEDY_NEXT, so a caller that printed NEXT on a zero return rendered
# "to answer as the bound instance instead: no remaining clearing path
# (CONTRACT.md Cancellation)" — offering a way to answer and naming the absence
# of one in the same sentence. The kind, not the return code, decides.
case "$qout" in
  *'to answer as the bound instance instead'*)
    fail "(17b) the tail offers an actor-side door where none exists — no tombstone for worker|predecessor under any handle: $qout" ;;
esac
case "$qout" in
  *'no actor-side clearing path'*) ;;
  *) fail "(17b) the tail neither offers a door nor says there is none: $qout" ;;
esac
# Same defect on reply's side: `next:` must stay one runnable command, never
# "tap cancel ...; or clear the binding: no remaining clearing path".
case "$rout" in
  *'or clear the binding'*)
    fail "(17b) reply appended a clearing door where none exists: $rout" ;;
esac
echo "read-verb: (17b) a nonexistent clearing door is stated, never advertised: ok"
echo "read-verb: (17) a forced ask read prints cancel-first doors, never a reply loop: ok"
)

# --- (17c) an ARCHIVED payload is terminal even with no receipt --------------
# `tap cancel` archives the canonical (tap-cancel.sh:391) and writes the
# `.cancelled` receipt afterwards (:406). Interrupted between the two, the
# resolver still returns archive/<id>.cancelled.md while no receipt exists —
# and keying "settled" on the receipt alone wrote a NEW .read over a withdrawn
# ask and printed "→ tap reply", telling the recipient to answer something the
# sender had already taken back. Residency is the older fact; it decides.
ID_ARCH="fable-20260904T120010Z-eeee00001111"
mkdir -p "$A_BUS/archive"
{ printf '%s\n' '---' "id: $ID_ARCH" 'from: fable' 'to: worker' 'kind: discuss' \
    'reply: expected' "path: $A_BUS/archive/$ID_ARCH.cancelled.md" '---' '' 'cancel was interrupted'; \
  } > "$A_BUS/archive/$ID_ARCH.cancelled.md"
asnap="$(receipts_of "$A_BUS")"
aout="$(TAP_HOME="$A_BUS" "$TAP" read "$ID_ARCH" --by worker 2>&1)" \
  || fail "(17c) read of an archived payload exited non-zero: $aout"
[ "$(receipts_of "$A_BUS")" = "$asnap" ] \
  || fail "(17c) reading an ARCHIVED payload wrote a receipt — the cancel is terminal whether or not its receipt landed: $aout"
case "$aout" in *'tap reply'*) fail "(17c) the tail told the recipient to answer a cancelled ask: $aout" ;; esac
case "$aout" in *' settled'*) ;; *) fail "(17c) an archived payload did not read as settled: $aout" ;; esac
echo "read-verb: (17c) an archived (cancelled) payload is terminal without its receipt: ok"

# --- (17d) the ask tail carries the caller context it was invoked with -------
# A pane-less seat reaches this bus with `--by worker --team <t>`; a bare
# `tap reply <id>` printed there fails with no_actor or resolves another bus.
# tap-poll.sh:194-197 already carries the flags; the read tail must agree.
ID_CTX="fable-20260904T120011Z-eeee00002222"
plant "$A_BUS" "$ID_CTX" worker expected 'an ask read by a pane-less seat'
ctxout="$(TAP_VERBOSE=1 TAP_HOME="$A_BUS" "$TAP" read "$ID_CTX" --by worker 2>&1)" \
  || fail "(17d) read exited non-zero: $ctxout"
case "$ctxout" in *"tap reply $ID_CTX --by worker"*) ;; *) fail "(17d) the tail dropped the declared --by; the printed command cannot run where it was printed: $ctxout" ;; esac
echo "read-verb: (17d) the ask tail carries the declared actor: ok"

# --- (17e) an unreachable acting registry refuses even under --force ---------
# The gate reviewer on the whole-diff: --force overrides exactly the two VERIFIED
# mismatches that name the caller (the addressee handle, a recipient_instance
# that was read and did not match). An unreachable acting registry is not a
# mismatch — it is the inability to check — and letting force past it settled a
# terminal `.done` over a damaged registry, which is exactly what making the
# marker check unconditional exists to prevent. done (:380) and reply (:145)
# both refuse here with no force branch; read must agree with its siblings.
(
UNR="$FIX/unreach"; UBUS="$UNR/.tap/bus"
mkdir -p "$UBUS/payloads" "$UBUS/receipts"
export TAP_INDEX_HOME="$FIX/index-unreach"; mkdir -p "$TAP_INDEX_HOME"
python3 -B - "$TAP_INDEX_HOME" "$UNR" <<'PY3'
import json, pathlib, sys
idx, team = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
# Flip-live, and the team's registry_location points at a file that is NOT there:
# the index resolves the team, then the registry itself is unreachable.
(idx / "global-registry.json").write_text(json.dumps({
    "schema": "0.20",
    "teams": {"unreach": {"root": str(team),
                          "registry_location": str(team / ".tap" / "gone-registry.json")}}}) + "\n")
PY3
ID_UNR="fable-20260904T120012Z-ffff00003333"
{ printf '%s\n' '---' "id: $ID_UNR" 'from: fable' 'to: worker' 'kind: discuss' \
    'reply: settle-only' "path: $UBUS/payloads/$ID_UNR.md" \
    'recipient_instance: worker|predecessor' '---' '' 'bound note on an unreachable registry'; \
  } > "$UBUS/payloads/$ID_UNR.md"
usnap="$(receipts_of "$UBUS")"
set +e
uout="$(TAP_HOME="$UBUS" "$TAP" read "$ID_UNR" --force --by worker 2>&1)"; urc=$?
set -e
[ "$urc" -ne 0 ] \
  || fail "(17e) a FORCED read settled over an unreachable acting registry — force overrides verified mismatches, never the inability to verify: $uout"
[ "$(receipts_of "$UBUS")" = "$usnap" ] \
  || fail "(17e) the refused forced read wrote a receipt anyway: $uout"
echo "read-verb: (17e) an unreachable registry refuses a forced read, as done and reply do: ok"
)

# --- (17f) read holds the exact-id lock cancel holds -------------------------
# The reviewer P1: read sampled terminality and published receipts outside the
# cross-runtime critical section `tap cancel` holds from before its first
# terminality observation through the archive move (tap-cancel.sh:59). A read
# that landed `.done` after cancel's check left two contradictory terminal
# receipts. Holding the lock is asserted by OBSERVING THE REFUSAL: with the
# lock held by another process, read must refuse rather than proceed.
(
LK="$FIX/lock"; LBUS="$LK/.tap/bus"
mkdir -p "$LBUS/payloads" "$LBUS/receipts"
export TAP_LOCK_DIR="$FIX/lockdir"; mkdir -p "$TAP_LOCK_DIR"
ID_LK="fable-20260904T120013Z-ffff00004444"
plant "$LBUS" "$ID_LK" worker settle-only 'a note whose lock is held elsewhere'
lsnap="$(receipts_of "$LBUS")"
# Hold the exact-id lock from a separate process, the way cancel does.
python3 -B - "$TAP_LOCK_DIR" "$ID_LK" "$FIX/held" <<'PY4' &
import fcntl, os, sys, time
lockdir, ident, flag = sys.argv[1], sys.argv[2], sys.argv[3]
safe = "".join(c if (c.isalnum() or c in "_.-") else "_" for c in ident)
fd = os.open(os.path.join(lockdir, "obligation-%s.lock" % safe), os.O_CREAT | os.O_RDWR, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
open(flag, "w").write("held\n")
time.sleep(12)
PY4
holder=$!
# Wait with a real yield: a bare spin can burn its whole budget before the
# child is scheduled, which fails the FIXTURE rather than the assertion.
for _ in $(seq 1 200); do [ -f "$FIX/held" ] && break; sleep 0.05; done
[ -f "$FIX/held" ] || { kill "$holder" 2>/dev/null || true; fail "(17f) fixture: the lock holder never acquired"; }
set +e
lout="$(TAP_HOME="$LBUS" "$TAP" read "$ID_LK" --by worker 2>&1)"; lrc=$?
set -e
kill "$holder" 2>/dev/null || true; wait "$holder" 2>/dev/null || true
[ "$lrc" -ne 0 ] \
  || fail "(17f) read settled while another process held the exact-id lock — it can race tap cancel into two terminal receipts: $lout"
case "$lout" in *obligation_busy*|*'another process is acting'*) ;; *) fail "(17f) the refusal does not name the contended lock: $lout" ;; esac
[ "$(receipts_of "$LBUS")" = "$lsnap" ] || fail "(17f) the lock-refused read wrote a receipt: $lout"
echo "read-verb: (17f) read refuses while the exact-id lock is held, as cancel requires: ok"
)

# --- (17g) CAUSAL: the re-resolve is what makes the lock mean something -------
# (17f) only proves the lock is CONTENDED — deleting the re-resolve leaves it
# green, so it does not arm this. The real sequence: read resolves, cancel wins
# the lock and moves the payload to archive, read then acquires and must notice.
# Without the re-observation read proceeds on a path that is gone: it writes a
# receipt beside cancel's `.cancelled` (two terminal receipts for one id) or
# prints no body while exiting 0.
(
RR="$FIX/reresolve"; RBUS="$RR/.tap/bus"
mkdir -p "$RBUS/payloads" "$RBUS/receipts" "$RBUS/archive"
export TAP_LOCK_DIR="$FIX/lockdir-rr"; mkdir -p "$TAP_LOCK_DIR"
ID_RR="fable-20260904T120014Z-ffff00005555"
plant "$RBUS" "$ID_RR" worker settle-only 'a note a cancel is about to take'
# Hold the lock, perform the move cancel performs, release. read is launched
# while the lock is held, so it blocks in acquisition and lands AFTER the move —
# which is exactly the interleaving the re-resolve exists for. The reader
# announces the post-gates/pre-lock boundary through the verb's scratch-only
# barrier (readTestBarrier, keyed by id), so the move is driven by a signal at
# the exact boundary instead of a guessed phase bridge: the mover moves and
# only then releases the reader to its contended lock acquisition. EARLIER
# drafts keyed the move on the verbose `state_paths` row plus a 50ms phase
# bridge: the bridge guessed, and the guess fired before the gates under load.
python3 -B - "$TAP_LOCK_DIR" "$ID_RR" "$RBUS" "$FIX/rr-held" "$FIX/rr-done" "$FIX/rr-bar" <<'PY7' &
import fcntl, glob, os, shutil, sys, time
lockdir, ident, bus, held, done, bar = sys.argv[1:8]
safe = "".join(c if (c.isalnum() or c in "_.-") else "_" for c in ident)
lockpath = os.path.join(lockdir, "obligation-%s.lock" % safe)
fd = os.open(lockpath, os.O_CREAT | os.O_RDWR, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
open(held, "w").write("held\n")
# WAIT FOR THE BARRIER ANNOUNCEMENT, do not guess the reader's phase. The
# .reached file exists only because the LIVE reader wrote it at the gates→lock
# boundary — a dead reader's stale line cannot produce it in this fresh
# fixture, so no liveness re-check is needed. On timeout the fixture failed:
# declare that rather than assert nothing.
deadline = time.time() + 60
while time.time() < deadline:
    if glob.glob(bar + ".gates.*.reached"):
        break
    time.sleep(0.02)
else:
    open(done + ".timeout", "w").write("reader never reached the gates->lock boundary\n")
    fcntl.flock(fd, fcntl.LOCK_UN); sys.exit(0)
# The MOVE ONLY — deliberately without the terminal receipt. Cancel writes the
# receipt after the move (tap-cancel.sh:391 then :406), so this is its real
# interrupted window; and if the receipt existed, read's archive-is-terminal
# branch would catch the stale path for a different reason and this arm would
# pass without exercising the re-resolve at all. It did, on the first draft.
shutil.move(os.path.join(bus, "payloads", ident + ".md"),
            os.path.join(bus, "archive", ident + ".cancelled.md"))
open(bar + ".gates.release", "w").write("1\n")
open(done, "w").write("moved\n")
fcntl.flock(fd, fcntl.LOCK_UN)
PY7
mover=$!
for _ in $(seq 1 200); do [ -f "$FIX/rr-held" ] && break; sleep 0.05; done
[ -f "$FIX/rr-held" ] || { kill "$mover" 2>/dev/null || true; fail "(17g) fixture: the mover never took the lock"; }
set +e
TAP_READ_TEST_BARRIER="$FIX/rr-bar" TAP_READ_TEST_ID="$ID_RR" TAP_SCRATCH_ONLY=1 \
  TAP_HOME="$RBUS" "$TAP" read "$ID_RR" --by worker >"$FIX/rr-out" 2>&1 &
reader=$!
wait "$reader"; rrrc=$?
rrout="$(cat "$FIX/rr-out")"
set -e
wait "$mover" 2>/dev/null || true
[ -f "$FIX/rr-done" ] || fail "(17g) fixture: the mover never completed its move; the interleaving under test did not happen"
[ ! -f "$FIX/rr-done.timeout" ] \
  || fail "(17g) fixture: the reader never reached the locked window, so the move did not land in the window under test — this arm proves nothing about the re-observation"
# The payload this read resolved is GONE and no receipt speaks for it yet, so
# the only thing that can notice is the re-observation after acquisition.
# Read must refuse and write nothing.
[ "$rrrc" -ne 0 ] \
  || fail "(17g) read proceeded on a path a cancel had already moved: rc=$rrrc out=$rrout"
[ ! -f "$RBUS/receipts/$ID_RR.done" ] \
  || fail "(17g) read settled an id whose payload had been archived out from under it: $rrout"
[ ! -f "$RBUS/receipts/$ID_RR.read" ] \
  || fail "(17g) read wrote a .read for a payload that had already moved: $rrout"
case "$rrout" in *'moved while this read was acquiring its lock'*|*'changed residency'*) ;;
  *) fail "(17g) the refusal does not name the move it observed after acquisition: $rrout" ;; esac
echo "read-verb: (17g) a cancel that wins the lock is observed after acquisition: ok"
)

# --- (17h) the resolved bus is fenced, not just the caller's -----------------
# The ambient guard covers the CALLER's bus (where the forced-read audit lands);
# receipts go to the RESOLVED bus, which for a cross-team read belongs to
# someone else. Caller unfenced + resolved bus fenced + a valid cross-team
# payload must refuse and leave the sender bus byte-identical.
(
XT="$FIX/xteam"; CALLER="$XT/caller/.tap/bus"; SENDER="$XT/sender/.tap/bus"
mkdir -p "$CALLER/payloads" "$CALLER/receipts" "$SENDER/payloads" "$SENDER/receipts"
export TAP_INDEX_HOME="$FIX/index-xteam"; mkdir -p "$TAP_INDEX_HOME"
printf '{"schema": "0.20", "team":{"name":"sender"},"seats":{}}' > "$SENDER/registry.json"
printf '{"schema": "0.20", "team":{"name":"caller"},"seats":{}}' > "$CALLER/registry.json"
enroll_index "$TAP_INDEX_HOME" "sender=$XT/sender" "caller=$XT/caller"
ID_XT="fable-20260904T120015Z-ffff00006666"
{ printf '%s\n' '---' "id: $ID_XT" 'from: fable' 'to: worker' 'kind: discuss' \
    'reply: settle-only' "path: $SENDER/payloads/$ID_XT.md" '---' '' 'cross-team note on a fenced sender bus'; \
  } > "$SENDER/payloads/$ID_XT.md"
# Fence the RESOLVED (sender) bus only; the caller's bus stays unfenced.
printf '{"owner":"someone-else","started_at":"2026-09-04T00:00:00Z"}\n' > "$SENDER/reset.fence.json"
xsnap="$(cd "$SENDER" && find . -type f -print0 | sort -z | xargs -0 cksum | cksum)"
set +e
xtout="$(TAP_HOME="$CALLER" "$TAP" read "sender/$ID_XT" --by worker 2>&1)"; xtrc=$?
set -e
[ "$xtrc" -ne 0 ] \
  || fail "(17h) a read wrote onto a sender bus that is mid-reset: $xtout"
case "$xtout" in *fenc*|*mid-reset*|*team_reset_fenced*) ;; *) fail "(17h) the refusal does not name the fence: $xtout" ;; esac
[ "$(cd "$SENDER" && find . -type f -print0 | sort -z | xargs -0 cksum | cksum)" = "$xsnap" ] \
  || fail "(17h) the fenced sender bus was modified by the refused read"
echo "read-verb: (17h) the resolved bus is fenced independently of the caller's: ok"
)

# --- (17i) EVERY refusal that cannot be reconsidered leaves no lock behind ----
# The immutable gates refuse on facts no concurrent verb can turn into an
# acceptance, so taking the obligation lock before them minted a lock file for
# each — a mutation on the path whose whole promise is that it changes nothing.
#
# A CENSUS, not a sample. The first draft asserted only the id-mismatch gate,
# which is why the wrong-addressee refusal — the most ORDINARY refusal this verb
# has — kept minting locks under a green arm (luna's re-review). Each case gets
# a FRESH lock root, so "0 files" is about that invocation and cannot be
# satisfied by a neighbour having cleaned up.
(
NL="$FIX/nolock"; NBUS="$NL/.tap/bus"
mkdir -p "$NBUS/payloads" "$NBUS/receipts"
mkfresh() { # <case> -> echoes a lock root used by exactly one invocation
  local d="$FIX/lockroot-$1"; rm -rf "$d"; mkdir -p "$d"; printf '%s' "$d"
}
census() { # <case> <expected-substring> <args...>
  local case_name="$1" want="$2"; shift 2
  local root; root="$(mkfresh "$case_name")"
  local out rc
  set +e
  out="$(TAP_HOME="$NBUS" TAP_LOCK_DIR="$root" "$TAP" read "$@" 2>&1)"; rc=$?
  set -e
  [ "$rc" -ne 0 ] || fail "(17i) $case_name: expected a refusal, got exit 0: $out"
  case "$out" in *"$want"*) ;; *) fail "(17i) $case_name: refused for the wrong reason (wanted '$want'): $out" ;; esac
  local n; n="$(find "$root" -type f 2>/dev/null | wc -l | tr -d ' ')"
  [ "$n" = 0 ] \
    || fail "(17i) $case_name left $n lock file(s) behind — a refused read must change nothing: $(find "$root" -type f)"
}

# 1. envelope id disagrees with the filename
ID_NL="fable-20260904T120016Z-ffff00007777"
{ printf '%s\n' '---' "id: fable-20260904T120016Z-wrongwrong01" 'from: fable' 'to: worker' \
    'kind: discuss' 'reply: settle-only' "path: $NBUS/payloads/$ID_NL.md" '---' '' 'envelope id disagrees'; \
  } > "$NBUS/payloads/$ID_NL.md"
census id-mismatch "does not name the file it lives in" "$ID_NL" --by worker

# 2. the ORDINARY one: addressed to somebody else. This is the case the first
#    draft of this arm missed entirely.
ID_OTHER2="fable-20260904T120017Z-ffff00008888"
plant "$NBUS" "$ID_OTHER2" someone-else settle-only 'not addressed to this reader'
census wrong-addressee "is addressed to 'someone-else'" "$ID_OTHER2" --by worker

# 3. an unsanctioned reply expectation
ID_UNS="fable-20260904T120018Z-ffff00009999"
{ printf '%s\n' '---' "id: $ID_UNS" 'from: fable' 'to: worker' 'kind: discuss' \
    'reply: optional' "path: $NBUS/payloads/$ID_UNS.md" '---' '' 'unsanctioned reply expectation'; \
  } > "$NBUS/payloads/$ID_UNS.md"
census unsanctioned-reply "unsanctioned reply expectation" "$ID_UNS" --by worker

# 4. an invalid envelope
ID_BAD="fable-20260904T120019Z-ffff0000aaaa"
printf 'not frontmatter at all\n' > "$NBUS/payloads/$ID_BAD.md"
census invalid-envelope "invalid envelope" "$ID_BAD" --by worker

# 5. a foreign team's mail
ID_FT="fable-20260904T120020Z-ffff0000bbbb"
{ printf '%s\n' '---' "id: $ID_FT" 'from: fable' 'to: worker' 'to_team: someone-elses-team' \
    'kind: discuss' 'reply: settle-only' "path: $NBUS/payloads/$ID_FT.md" '---' '' 'foreign team mail'; \
  } > "$NBUS/payloads/$ID_FT.md"
census foreign-team "not to a seat on" "$ID_FT" --by worker

# The OTHER side of the rule, so the census cannot be read as "no refusal ever
# locks": a gate that reads lock-protected state refuses BELOW the lock and MAY
# leave a lock file. That is not a violation — a lock file is scratch, not bus
# or registry state (architect ruling, 2026-09-04). Asserted as "the bus is
# untouched", which is what the writes-nothing promise actually covers.
# The instance gate is DORMANT without a live flip marker, so this sub-case
# stands up its own flipped team rather than inheriting the outer fixture — the
# first draft did inherit it, the gate never fired, and the arm reddened on a
# read that correctly succeeded.
LKB="$FIX/lockbound"; LKBUS="$LKB/.tap/bus"
mkdir -p "$LKBUS/payloads" "$LKBUS/receipts"
LKIDX="$FIX/index-lockbound"; mkdir -p "$LKIDX"
python3 -B - "$LKIDX" "$LKB" <<'PY8'
import json, pathlib, sys
idx, team = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
reg = team / ".tap" / "team-registry.json"
reg.parent.mkdir(parents=True, exist_ok=True)
reg.write_text(json.dumps({"schema": "0.20", "team": {"name": "lockbound"},
    "seats": {"worker": {"status": "active", "delivery": "poll", "harness": "claude",
                         "instance": "worker|current", "registered_at": "t"}}}) + "\n")
(idx / "global-registry.json").write_text(json.dumps({"schema": "0.20",
    "teams": {"lockbound": {"root": str(team), "registry_location": str(reg)}}}) + "\n")
PY8
ID_LOCKED="fable-20260904T120021Z-ffff0000cccc"
{ printf '%s\n' '---' "id: $ID_LOCKED" 'from: fable' 'to: worker' 'kind: discuss' \
    'reply: expected' "path: $LKBUS/payloads/$ID_LOCKED.md" \
    'recipient_instance: worker|predecessor' '---' '' 'instance-bound, refuses below the lock'; \
  } > "$LKBUS/payloads/$ID_LOCKED.md"
_lroot="$(mkfresh instance-bound)"
_bsnap="$(receipts_of "$LKBUS")"
set +e
_lout="$(TAP_INDEX_HOME="$LKIDX" TAP_HOME="$LKBUS" TAP_LOCK_DIR="$_lroot" \
         "$TAP" read "$ID_LOCKED" --by worker 2>&1)"; _lrc=$?
set -e
[ "$_lrc" -ne 0 ] || fail "(17i) the instance gate did not fire; this sub-case is testing nothing: $_lout"
case "$_lout" in *"bound to recipient instance"*) ;; *) fail "(17i) refused for the wrong reason: $_lout" ;; esac
[ "$(receipts_of "$LKBUS")" = "$_bsnap" ] \
  || fail "(17i) a below-the-lock refusal wrote to the BUS — that is what writes-nothing covers: $_lout"
echo "read-verb: (17i) five immutable refusals leave no lock; a lock-protected gate refuses below it and touches no bus state: ok"
)

# --- (18) a live id literally ending .cancelled keeps its own receipt name ----
# Thread 7: the unconditional `${ID%.cancelled}` strip at the resolver tail
# rewrites a LIVE payloads/ id (ticket.cancelled) into receipts/ticket.done,
# clearing an obligation that is still open and mis-chaining tap show. The
# suffix strip belongs to the ARCHIVE residency (<id>.cancelled.md) only.
ID_CAN="ticket.cancelled"
{ printf '%s\n' '---' "id: $ID_CAN" 'from: fable' 'to: worker' 'kind: discuss' \
    'reply: settle-only' "path: $A_BUS/payloads/$ID_CAN.md" '---' '' 'a live id ending in .cancelled'; \
  } > "$A_BUS/payloads/$ID_CAN.md"
cout="$(TAP_HOME="$A_BUS" "$TAP" read "$ID_CAN" --by worker 2>&1)" \
  || fail "(18) read of a live .cancelled id exited non-zero: $cout"
receipt_ok "$A_BUS/receipts/$ID_CAN.done" "(18)"
[ ! -f "$A_BUS/receipts/ticket.done" ] \
  || fail "(18) the strip wrote receipts/ticket.done — the ticket.cancelled obligation is still open"
echo "read-verb: (18) a live id ending .cancelled settles under its full name: ok"

# --- (19) an envelope id that disagrees with the filename refuses ------------
# Thread 8: tap_validate_envelope checks field shape only, so right-id.md
# claiming `id: wrong-id` settled as right-id and falsely cleared the sender's
# obligation. Read must refuse on its own account: the shipped `tap poll` is
# answered natively and only warns past a mismatch, so nothing upstream is
# guaranteed to have moved the file. Mirror done's local gate: compare envelope
# id with the resolved filename before any write.
ID_R="fable-20260904T120002Z-rightid00001"
{ printf '%s\n' '---' "id: fable-20260904T120002Z-wrongid00001" 'from: fable' 'to: worker' 'kind: discuss' \
    'reply: settle-only' "path: $A_BUS/payloads/$ID_R.md" '---' '' 'mismatched envelope'; \
  } > "$A_BUS/payloads/$ID_R.md"
mbefore="$(receipts_of "$A_BUS")"
set +e
mout="$(TAP_HOME="$A_BUS" "$TAP" read "$ID_R" --by worker 2>&1)"; mrc=$?
set -e
[ "$mrc" -ne 0 ] || fail "(19) read of an id/filename mismatch exited 0 — it cleared an obligation the envelope does not name"
[ "$(receipts_of "$A_BUS")" = "$mbefore" ] || fail "(19) the mismatch refusal wrote a receipt"
case "$mout" in *'tap show'*) ;; *) fail "(19) the mismatch refusal does not point at tap show: $mout" ;; esac
echo "read-verb: (19) an envelope/filename id mismatch refuses without writing: ok"

# --- (20) a read that creates a receipt consumes the reset generation --------
# Thread 12: done/reply mark the bus generation reused when they write
# receipts (tap_reset_generation_touch*), so a later `tap restore` cannot
# replay a checkpoint over post-reset mail. read wrote receipts with no touch,
# leaving the generation pristine — restore then ATE the read/settlement and
# reopened sender-visible work. Touch exactly when THIS call creates.
GEN_ID="fable-20260904T120003Z-gen00000001"
plant "$A_BUS" "$GEN_ID" worker settle-only 'a generation-consuming note'
printf '{"bundle_id":"b1","state":"pristine"}\n' > "$A_BUS/reset-generation.json"
TAP_HOME="$A_BUS" "$TAP" read "$GEN_ID" --by worker >/dev/null 2>&1 \
  || fail "(20) the generation arm's read exited non-zero"
python3 -B - "$A_BUS/reset-generation.json" <<'PY2' || fail "(20) a read that created a receipt left the generation pristine — restore can replay over it"
import json, sys
rec = json.load(open(sys.argv[1]))
assert rec.get("state") == "reused", rec
PY2
echo "read-verb: (20) a receipt-creating read marks the bus generation reused: ok"

# --- (21) a locally adopted note's settlement keeps adopted_from -------------
# Thread 14: reclaim adoption stamps to_adopted_from on the envelope; done's
# settlement records adopted_from (CONTRACT §reclaim-adoption) but read's .done
# dropped it, so the terminal record could not say which fork was adopted.
ID_AD="fable-20260904T120004Z-adopted00001"
{ printf '%s\n' '---' "id: $ID_AD" 'from: fable' 'to: worker' 'kind: discuss' \
    'reply: settle-only' "path: $A_BUS/payloads/$ID_AD.md" \
    'to_adopted_from: worker-old' '---' '' 'an adopted note'; \
  } > "$A_BUS/payloads/$ID_AD.md"
TAP_HOME="$A_BUS" "$TAP" read "$ID_AD" --by worker >/dev/null 2>&1 \
  || fail "(21) reading an adopted note exited non-zero"
python3 -B - "$A_BUS/receipts/$ID_AD.done" <<'PY2' || fail "(21) the settlement dropped adopted_from — the record cannot name the adopted fork"
import json, sys
r = json.load(open(sys.argv[1]))
assert r.get("adopted_from") == "worker-old", r
PY2
echo "read-verb: (21) a settlement through read keeps adopted_from: ok"

# --- (22) a REFUSED read writes nothing even when the registry is STALE ------
# Thread 10: tap.sh's dispatch ran tap_registry_invalidate_server_restart
# BEFORE the verb, so against a stale server boot the preflight cleared pane coordinates
# and suspended rows before read's own refusal — the no-write-anywhere
# contract broken by the front door, invisible to arm 12 whose registry was
# current. read joins show's reconciliation exemption: a refused read leaves
# the whole tree byte-identical.
STALE="$FIX/stale"; SBUS="$STALE/.tap/bus"
mkdir -p "$SBUS/payloads" "$SBUS/receipts"
cat > "$SBUS/registry.json" <<JSON
{"schema": "0.20", "team":{"name":"alpha"},"seats":{"other":{"status":"active","delivery":"pane","pane":"alpha:0.9","pane_id":"%97","boot_id":"boot:1","harness":"codex"}}}
JSON
ID_ST="fable-20260904T120005Z-stale0000001"
{ printf '%s\n' '---' "id: $ID_ST" 'from: fable' 'to: other' 'kind: discuss' \
    'reply: settle-only' "path: $SBUS/payloads/$ID_ST.md" '---' '' 'not yours, on a stale boot'; \
  } > "$SBUS/payloads/$ID_ST.md"
sbefore="$(tree_of "$STALE")"
set +e
TAP_BOOT_ID="boot:9999" TAP_HOME="$SBUS" "$TAP" read "$ID_ST" --by worker >/dev/null 2>&1; src_=$?
set -e
[ "$src_" -ne 0 ] || fail "(22) a to!=me read on a stale-boot bus exited 0"
[ "$(tree_of "$STALE")" = "$sbefore" ] || {
  echo "read-verb: (22) a REFUSED read mutated a stale-boot registry; diff follows" >&2
  diff <(printf '%s\n' "$sbefore") <(printf '%s\n' "$(tree_of "$STALE")") >&2 || true
  exit 1
}
echo "read-verb: (22) a refused read writes nothing even against a stale server boot: ok"

echo "read-verb: ok"
