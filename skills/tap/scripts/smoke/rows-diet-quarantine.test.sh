#!/usr/bin/env bash
# D5: source-read — :134-140 digest-instruction single-home greps (one builder home: digest-index.ts, reached through spool-digest-inject.ts's import); every executable arm is ported (quarantine rc contract -> runtime/bun/test/quarantine.test.ts, logicalId table -> runtime/bun/test/payload-view-logical-id.test.ts); the remaining arms drive the public door (bin/tap poll/outstanding/show/read)
# rows-diet-quarantine.test.sh — tap-7r3fn.7 (W6 U4): row/receipt diet, the
# malformed-payload quarantine, and the CLI's own mouth.
#
# Poll and outstanding rows show id, counterpart, obligation, and age.
# Both poll entry points quarantine malformed bytes once; invalid reply remains
# visible. Native-router controls separately pin routing and execute the hint.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
FIX="$(mktemp -d)"; trap 'rm -rf "$FIX"' EXIT
BUS="$FIX/team/.tap/bus"; mkdir -p "$BUS/payloads" "$BUS/receipts"
cat > "$BUS/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"team"},"seats":{"worker":{"status":"active","delivery":"pane","pane":"t:0.1","harness":"codex"},"peer":{"status":"active","delivery":"pane","pane":"t:0.2","harness":"codex"}}}
JSON
export TAP_INDEX_HOME="$FIX/index"; mkdir -p "$TAP_INDEX_HOME"
# Born live (F1): the team is enrolled in the machine index.
printf '{"schema":"0.20","teams":{"team":{"root":"%s","registry_location":"%s","state":"registered"}}}\n' \
  "$(cd "$FIX/team" && pwd -P)" "$(cd "$BUS" && pwd -P)/registry.json" > "$TAP_INDEX_HOME/global-registry.json"
export TAP_HOME="$BUS"
fail() { echo "rows-diet: $*" >&2; exit 1; }

plant() { # <id> <from> <to> <reply> <body>
  { printf '%s\n' '---' "id: $1" "from: $2" "to: $3" 'kind: discuss' \
      "reply: $4" "path: $BUS/payloads/$1.md" '---' '' "$5"; } > "$BUS/payloads/$1.md"
}

# --- (1), (2): Bash poll rows and executable note hints ---------------------
IN_ASK="peer-20260903T120000Z-aaaaaaaaaaaa"
IN_NOTE="peer-20260903T120001Z-bbbbbbbbbbbb"
plant "$IN_ASK" peer worker expected 'an inbound ask'
plant "$IN_NOTE" peer worker settle-only 'an inbound note'

set +e; pout="$("$TAP" poll worker 2>/dev/null)"; prc=$?; set -e
[ "$prc" = 2 ] || fail "(1) pending poll rc=$prc"
case "$pout" in *"$BUS/payloads/"*) fail "(1) poll still prints paths" ;; esac
printf '%s\n' "$pout" | grep -qE "$IN_ASK  peer  ask  [0-9]+s" || fail "(1) missing ask row"
printf '%s\n' "$pout" | grep -qE "$IN_NOTE  peer  note  [0-9]+s" || fail "(1) missing note row"
printf '%s\n' "$pout" | grep -q "next step: tap read $IN_NOTE --by worker" || fail "(2) missing read hint"
echo "rows-diet: (1), (2) poll rows and note hint: ok"

# --- (3) outstanding rows name the RECIPIENT, not the constant sender --------
OUT_ASK="worker-20260903T120002Z-cccccccccccc"
{ printf '%s\n' '---' "id: $OUT_ASK" 'from: worker' 'to: peer' 'kind: discuss' \
    'reply: expected' "path: $BUS/payloads/$OUT_ASK.md" '---' '' 'my outbound ask'; \
} > "$BUS/payloads/$OUT_ASK.md"
set +e; oout="$("$TAP" outstanding worker 2>/dev/null)"; set -e
case "$oout" in *"$BUS/payloads/"*) fail "(3) an outstanding row still prints the payload path" ;; esac
printf '%s\n' "$oout" | grep -qE "$OUT_ASK.*peer" || fail "(3) the outstanding row does not name the RECIPIENT: $oout"
printf '%s\n' "$oout" | grep -qE "$OUT_ASK.*ask" || fail "(3) the outstanding row carries no obligation word"
echo "rows-diet: (3) outstanding rows are id/to/ask|note/age, naming the recipient: ok"

# --- (4) outstanding renders the .read observation ---------------------------
# `.read` says the message was SEEN; it never says the ask was answered. The
# sender needs both facts distinguishable or the receipt is decoration.
printf '{"id":"%s","at":"2026-09-03T12:00:10Z","by":"peer","identity":"pane"}\n' \
  "$OUT_ASK" > "$BUS/receipts/$OUT_ASK.read"
set +e; oout="$("$TAP" outstanding worker 2>/dev/null)"; set -e
printf '%s\n' "$oout" | grep -qE "$OUT_ASK.*read" || fail "(4) outstanding does not render the .read observation: $oout"
printf '%s\n' "$oout" | grep -qE "$OUT_ASK.*unanswered" || fail "(4) a read ask is not marked unanswered — read is an observation, not a discharge"
echo "rows-diet: (4) a read-but-unanswered ask renders as read AND unanswered: ok"

# --- (5) a FORCED read names the other reader --------------------------------
printf '{"id":"%s","at":"2026-09-03T12:00:11Z","by":"someone_else","identity":"pane","forced":"true","to":"peer"}\n' \
  "$OUT_ASK" > "$BUS/receipts/$OUT_ASK.read"
set +e; oout="$("$TAP" outstanding worker 2>/dev/null)"; set -e
printf '%s\n' "$oout" | grep -qE "$OUT_ASK.*someone_else" \
  || fail "(5) a forced read does not name who actually read it: $oout"
printf '%s\n' "$oout" | grep -qE "$OUT_ASK.*forced" || fail "(5) a forced read is not marked forced"
echo "rows-diet: (5) a forced read names the actual reader and says it was forced: ok"
rm -f "$BUS/receipts/$OUT_ASK.read"

# --- (6) a malformed payload is quarantined ONCE and never re-warned ---------
# The BASE behaviour: one warning per malformed file per poll, forever. Tonight's
# live bus carries five such files, so every poll pays five warnings for state
# nobody will ever act on.
for n in 1 2 3 4 5; do
  printf 'this is not a payload %s\n' "$n" > "$BUS/payloads/stale-case-$n.md"
done
set +e; "$TAP" poll worker >"$FIX/p1.out" 2>"$FIX/p1.err"; set -e
warn1="$(grep -c 'malformed' "$FIX/p1.err" || true)"
[ -d "$BUS/payloads/.quarantine" ] || fail "(6) no quarantine directory was created"
for n in 1 2 3 4 5; do
  [ ! -f "$BUS/payloads/stale-case-$n.md" ] || fail "(6) stale-case-$n.md was not moved out of payloads/"
  [ -f "$BUS/payloads/.quarantine/stale-case-$n.md" ] || fail "(6) stale-case-$n.md is not in the quarantine"
  grep -q "this is not a payload $n" "$BUS/payloads/.quarantine/stale-case-$n.md" \
    || fail "(6) quarantined bytes were not preserved for file $n"
done
[ "$(grep -cE 'quarantin' "$FIX/p1.out")" = 1 ] \
  || fail "(6) expected exactly ONE quarantine pointer line on stdout, got $(grep -cE 'quarantin' "$FIX/p1.out")"
set +e; "$TAP" poll worker >"$FIX/p2.out" 2>"$FIX/p2.err"; set -e
warn2="$(grep -c 'malformed' "$FIX/p2.err" || true)"
[ "$warn2" = 0 ] \
  || fail "(6) the second poll re-warned about quarantined files ($warn2 warnings) — a quarantine that keeps shouting is a warning with extra steps"
echo "rows-diet: (6) five malformed files quarantine once, bytes intact, one pointer, no re-warning (was $warn1 warnings, now $warn2): ok"

# --- (7) quarantine never overwrites evidence --------------------------------
printf 'ORIGINAL EVIDENCE\n' > "$BUS/payloads/.quarantine/collide.md"
printf 'not a payload either\n' > "$BUS/payloads/collide.md"
set +e; "$TAP" poll worker >/dev/null 2>&1; set -e
grep -q 'ORIGINAL EVIDENCE' "$BUS/payloads/.quarantine/collide.md" \
  || fail "(7) a name collision CLOBBERED preserved evidence in the quarantine"
grep -q 'not a payload either' "$BUS/payloads/.quarantine/collide.md.1" \
  || fail "(7) collision did not preserve the new bytes under a distinct name"
# The forensic body is byte-preserving, including invalid UTF-8 and CRLF.
python3 - "$BUS/payloads/.quarantine/raw-evidence.md" <<'PYRAW'
import pathlib,sys
pathlib.Path(sys.argv[1]).write_bytes(b"invalid:\xff\r\n\r\n")
PYRAW
"$TAP" show 'path='"$BUS/payloads/.quarantine/raw-evidence.md" > "$FIX/raw-show.out"
python3 - "$FIX/raw-show.out" "$BUS/payloads/.quarantine/raw-evidence.md" <<'PYRAW'
import pathlib,sys
assert pathlib.Path(sys.argv[1]).read_bytes().split(b'body:\n',1)[1] == pathlib.Path(sys.argv[2]).read_bytes()
PYRAW
echo "rows-diet: (7) a quarantine name collision preserves the earlier evidence: ok"

# --- (8) tap show still inspects a quarantined artifact ----------------------
sout="$("$TAP" show stale-case-1 2>&1)" \
  || fail "(8) tap show cannot reach a quarantined payload: $sout"
case "$sout" in *'this is not a payload 1'*) ;; *) fail "(8) show did not print the quarantined bytes" ;; esac
case "$sout" in *quarantin*) ;; *) fail "(8) show did not say the artifact is quarantined" ;; esac
echo "rows-diet: (8) tap show inspects a quarantined artifact and labels it: ok"

# --- (9) retired: it grepped tap-cancel.sh and tap-send.sh for a live 'tap done'
# next step. Both named scripts are deleted (cancel went native; tap-send.sh was
# deleted in B7c R10), so the check could only pass vacuously.

# --- (10) the live courier uses the shared digest instruction builder --------
# The dormant native owner was retired. Keep the surviving courier's single-home check.
for f in skills/tap/scripts/smoke/runtime-helpers.sh runtime/bun/src/spool-digest-inject.ts; do
  hits="$(grep -n 'records its own read separately' "$ROOT/$f" || true)"
  [ -z "$hits" ] || fail "(10) $f duplicates the digest instruction builder: $hits"
done
grep -q 'records its own read separately from its items' "$ROOT/runtime/bun/src/digest-index.ts" \
  || fail "(10) digest-index.ts no longer carries the digest instruction sentence"
grep -qE 'writeDigestIndex[^;]*from "\./digest-index"' "$ROOT/runtime/bun/src/spool-digest-inject.ts" \
  || fail "(10) spool-digest-inject.ts no longer imports writeDigestIndex from ./digest-index"
echo "rows-diet: (10) live courier reaches the shared digest instruction builder: ok"

# --- (11) public native route, rows, quarantine and runnable hints ----------
# runtime/bun/test/native-router.test.ts exercises bin/tap with a live marker,
# asserts native poll in the route trace, compares quarantine effects against
# Bash, and executes the read hint. The Bun smoke runner owns that control.

# --- (12) --json discloses the move without contaminating stdout -------------
# The JSON branch exits before the human pointer, so the first version relocated
# files and reported it NOWHERE under --json. Keeping the JSON shape
# byte-identical and disclosing the mutation are not in tension: stderr does both.
printf 'not a payload\n' > "$BUS/payloads/json-malformed.md"
set +e
"$TAP" poll worker --json >"$FIX/j.out" 2>"$FIX/j.err"
set -e
python3 -B -c 'import json,sys; json.load(open(sys.argv[1]))' "$FIX/j.out" \
  || fail "(12) --json stdout is not valid JSON after a quarantine"
grep -qE 'quarantin' "$FIX/j.out" && fail "(12) the quarantine pointer contaminated JSON stdout"
grep -qE 'quarantin' "$FIX/j.err" || fail "(12) --json quarantined a file and disclosed it nowhere: $(cat "$FIX/j.err")"
[ -f "$BUS/payloads/.quarantine/json-malformed.md" ] || fail "(12) --json did not actually quarantine the file"
echo "rows-diet: (12) --json discloses the quarantine on stderr and leaves stdout byte-identical JSON: ok"

# --- (13) spooled outstanding rows take the same diet, and their ages count ---
# The spool branches kept the retired shape, and their ages never reached the
# cancel-legend gate — so an AGED SPOOLED send, precisely the shape that legend
# exists for, could not trigger it.
mkdir -p "$BUS/spool"
OLD_SPOOL="worker-20200101T000000Z-dddddddddddd"
{ printf '%s\n' '---' "id: $OLD_SPOOL" 'from: worker' 'to: peer' 'kind: discuss' \
    'reply: expected' "path: $BUS/spool/$OLD_SPOOL.md" '---' '' 'an aged spooled send'; \
} > "$BUS/spool/$OLD_SPOOL.md"
printf '{"id":"%s","target":"peer","team":"team","first_spooled_epoch":1577836800,"reason":"band_busy"}\n' \
  "$OLD_SPOOL" > "$BUS/spool/$OLD_SPOOL.meta.json"
set +e; sout="$("$TAP" outstanding worker 2>/dev/null)"; set -e
case "$sout" in *"$BUS/spool/"*) fail "(13) a spooled row still prints a path" ;; esac
printf '%s\n' "$sout" | grep -qE "$OLD_SPOOL.*peer.*ask" \
  || fail "(13) the spooled row is not dieted to id/to/ask|note/age: $sout"
printf '%s\n' "$sout" | grep -qE "$OLD_SPOOL.*spooled" \
  || fail "(13) the spooled row lost its spooled state, which nothing else carries"
printf '%s\n' "$sout" | grep -q 'tap cancel' \
  || fail "(13) an AGED SPOOLED send did not reach the cancel-discoverability legend — its age never became data"
echo "rows-diet: (13) spooled rows are dieted, keep their state, and their ages reach the cancel legend: ok"
rm -f "$BUS/spool/$OLD_SPOOL.md" "$BUS/spool/$OLD_SPOOL.meta.json"

# --- (14) a quarantined artifact is reachable by SUFFIX, with its chain -------
# The suffix door skipped .quarantine, and show derived the bus with two dirnames
# — right for payloads/ and archive/, wrong for the extra level under
# payloads/.quarantine/, so the receipt chain rendered empty.
QID="peer-20260903T140000Z-1234567890ab"
printf 'quarantined bytes here\n' > "$BUS/payloads/$QID.md"
printf '{"id":"%s","via":"courier","at":"2026-09-03T14:00:01Z"}\n' "$QID" > "$BUS/receipts/$QID.placed"
set +e; "$TAP" poll worker >/dev/null 2>&1; set -e
[ -f "$BUS/payloads/.quarantine/$QID.md" ] || fail "(14) fixture: the payload was not quarantined"
qs="$("$TAP" show 1234567890ab 2>&1)" || fail "(14) a quarantined artifact is not reachable by 12-hex suffix: $qs"
case "$qs" in *'quarantined bytes here'*) ;; *) fail "(14) suffix resolution found it but printed no bytes" ;; esac
case "$qs" in *placed*2026-09-03T14:00:01Z*) ;; *) fail "(14) the receipt chain is empty — the bus was derived from the wrong depth: $qs" ;; esac
echo "rows-diet: (14) a quarantined artifact resolves by suffix and renders its real receipt chain: ok"

# --- (15) a requarantined name keeps its NEWEST evidence reachable ------------
# Thread 2 (bot): a second malformed file of the same name quarantines to
# `<id>.md.1`, but the resolver checks only `.quarantine/<id>.md` (and its
# suffix scan requires names ending `<hex>.md`), so `tap show <id>` kept
# opening the OLDER artifact and no supported argument could inspect the newly
# preserved evidence — while the quarantine pointer directs users to tap show.
printf 'first incident\n' > "$BUS/payloads/twice-stale.md"
set +e; "$TAP" poll worker >/dev/null 2>&1; set -e
[ -f "$BUS/payloads/.quarantine/twice-stale.md" ] || fail "(15) fixture: first quarantine did not land"
printf 'second incident\n' > "$BUS/payloads/twice-stale.md"
set +e; "$TAP" poll worker >/dev/null 2>&1; set -e
[ -f "$BUS/payloads/.quarantine/twice-stale.md.1" ] \
  || fail "(15) fixture: the collision rename to .md.1 did not land — name-preserving collision is arm 7's job, this arm needs the sibling"
tsout="$("$TAP" show twice-stale 2>&1)" \
  || fail "(15) tap show cannot reach a requarantined name: $tsout"
case "$tsout" in *'second incident'*) ;; *) fail "(15) show opened the OLDER evidence — the .1 sibling is unreachable by any argument: $tsout" ;; esac
case "$tsout" in *quarantin*) ;; *) fail "(15) show did not label the artifact quarantined" ;; esac
echo "rows-diet: (15) a requarantined name shows its newest preserved evidence: ok"

# --- (16) --quiet keeps the pending-signal channel empty ----------------------
# Thread 5 (bot): the quarantine notice printed on STDOUT in quiet mode, and
# poll-mode daemon wrappers use quiet stdout as the work signal — a notice is
# not mail, but it wakes or parses as if it were. Diagnostics ride stderr.
printf 'quiet mode malformed\n' > "$BUS/payloads/quiet-malformed.md"
set +e
"$TAP" poll worker --quiet >"$FIX/qq.out" 2>"$FIX/qq.err"
qqrc=$?
set -e
[ "$qqrc" -eq 0 ] || fail "(16) --quiet must exit 0 whether or not there is mail, got $qqrc"
# Rows ARE the quiet work-signal and stay; a DIAGNOSTIC is not mail — the
# notice must not ride the signal channel.
grep -qE 'quarantin' "$FIX/qq.out" \
  && fail "(16) the quarantine notice rode --quiet stdout — the work-signal channel carried: $(grep quarantin "$FIX/qq.out")"
grep -qE 'quarantin' "$FIX/qq.err" \
  || fail "(16) the quarantine happened and --quiet disclosed it nowhere: $(cat "$FIX/qq.err")"
echo "rows-diet: (16) --quiet keeps diagnostics off the signal channel (stderr) : ok"

# --- (17) the 12-hex door reaches the NEWEST collision sibling ---------------
# The hex branch scans filenames for `-<hex>.md`; its sibling arm matched the
# bare SUFFIX against the whole filename, which a minted name never equals, so
# `tap show <hex>` kept opening the older unsuffixed artifact while arm (15)
# stayed green on the exact-id door. Two doors, one of them silently stale —
# the reason this arm addresses by hex and (15) addresses by id.
HEXID="alice-20260904T131500Z-abcdef123456"
printf 'first hex incident\n' > "$BUS/payloads/$HEXID.md"
set +e; "$TAP" poll worker >/dev/null 2>&1; set -e
[ -f "$BUS/payloads/.quarantine/$HEXID.md" ] || fail "(17) fixture: first hex quarantine did not land"
printf 'second hex incident\n' > "$BUS/payloads/$HEXID.md"
set +e; "$TAP" poll worker >/dev/null 2>&1; set -e
[ -f "$BUS/payloads/.quarantine/$HEXID.md.1" ] \
  || fail "(17) fixture: the hex collision rename to .md.1 did not land"
hxout="$("$TAP" show abcdef123456 2>&1)" \
  || fail "(17) tap show <12hex> cannot reach a requarantined name: $hxout"
case "$hxout" in *'second hex incident'*) ;; *) fail "(17) the hex door opened the OLDER evidence — the sibling arm matched the bare suffix, never the filename: $hxout" ;; esac
echo "rows-diet: (17) the 12-hex door reaches the newest collision sibling: ok"

# --- (18) a collision sibling renders the ORIGINAL id's receipt chain --------
# `basename <id>.md.N .md` strips nothing, so the id kept a `.md.N` tail and the
# renderer looked under receipts/<id>.md.N.* — an empty chain for exactly the
# case siblings were made inspectable for. read and show now share one
# derivation helper so they cannot disagree about what an id IS.
printf '{"id":"%s","at":"2026-09-04T13:10:00Z","by":"courier"}\n' "$HEXID" \
  > "$BUS/receipts/$HEXID.placed"
chout="$("$TAP" show "$HEXID" 2>&1)" || fail "(18) show of the collided id failed: $chout"
case "$chout" in *placed*) ;; *) fail "(18) the receipt chain is empty for a collision sibling — the id kept its .md.N tail: $chout" ;; esac
echo "rows-diet: (18) a collision sibling renders the original id's receipt chain: ok"

# --- (19) quarantining consumes the reset generation too ---------------------
# Same rule the settle paths and the receipt-creating read follow: the move and
# the .log append ARE first mutations of the bus, so a generation left
# `pristine` still admits `tap team restore`, which replaces the bus and
# discards exactly the evidence quarantine exists to preserve. The verb that
# quarantines does not matter — the helper that MOVES owns the touch.
printf '{"bundle_id":"b-quar","state":"pristine"}\n' > "$BUS/reset-generation.json"
printf 'generation malformed\n' > "$BUS/payloads/gen-malformed.md"
set +e; "$TAP" poll worker >/dev/null 2>&1; set -e
[ -f "$BUS/payloads/.quarantine/gen-malformed.md" ] \
  || fail "(19) fixture: the quarantine move did not land"
python3 -B - "$BUS/reset-generation.json" <<'PY3' \
  || fail "(19) a bus whose payload was quarantined left the generation pristine — restore can replace the bus and discard the preserved evidence"
import json, sys
rec = json.load(open(sys.argv[1]))
assert rec.get("state") == "reused", rec
PY3
echo "rows-diet: (19) quarantining a payload marks the bus generation reused: ok"

# --- (20) a quarantined file whose FILENAME is not a live id is reachable ------
# The quarantine notice prescribes `tap show <id>`, and malformed payloads are
# exactly where arbitrary filenames occur — a canonical literally named
# `bad id.md` quarantines fine, and applying the live-id grammar before the
# quarantine search made the prescribed recovery unable to reach the bytes it
# points at. A quarantined name is evidence, not an address.
printf 'malformed with a bad name\n' > "$BUS/payloads/bad id.md"
set +e; "$TAP" poll worker >/dev/null 2>&1; set -e
[ -f "$BUS/payloads/.quarantine/bad id.md" ] || fail "(20) fixture: the badly-named payload did not quarantine"
bnout="$("$TAP" show 'bad id' 2>&1)" \
  || fail "(20) the quarantine notice says 'inspect with tap show <id>' and tap show cannot open it: $bnout"
case "$bnout" in *'malformed with a bad name'*) ;; *) fail "(20) show reached the artifact but not its bytes: $bnout" ;; esac
# The widening is in what may be NAMED, never in where the resolver looks: an
# exact basename in .quarantine only, so a traversal argument still refuses.
set +e; trav="$("$TAP" show '../registry' 2>&1)"; travrc=$?; set -e
[ "$travrc" != 0 ] || fail "(20) a path-traversal argument resolved instead of refusing: $trav"
echo "rows-diet: (20) a quarantined artifact is reachable by its own name, and traversal still refuses: ok"

# --- (21) a corrected retry outranks the quarantined artifact it collides with -
# A sender whose malformed payload was quarantined may retry the SAME id with a
# valid one; canonical placement allows it (nothing live, no terminal receipt).
# Refusing the pair as ambiguous left the recipient unable to read OR settle a
# perfectly valid obligation — the resolver serves `tap read`, so an unresolvable
# id is a stuck message, not merely an unhelpful `tap show`.
RID="alice-20260904T140000Z-bbbbccccdddd"
printf 'malformed first attempt\n' > "$BUS/payloads/$RID.md"
set +e; "$TAP" poll worker >/dev/null 2>&1; set -e
[ -f "$BUS/payloads/.quarantine/$RID.md" ] || fail "(21) fixture: the first attempt did not quarantine"
{ printf '%s\n' '---' "id: $RID" 'from: alice' 'to: worker' 'kind: discuss' \
    'reply: settle-only' "path: $BUS/payloads/$RID.md" '---' '' 'the corrected payload'; \
  } > "$BUS/payloads/$RID.md"
rtout="$("$TAP" show "$RID" 2>&1)" \
  || fail "(21) a corrected retry is unresolvable while its quarantined predecessor exists: $rtout"
case "$rtout" in *'the corrected payload'*) ;; *) fail "(21) show opened the QUARANTINED artifact over the live payload: $rtout" ;; esac
"$TAP" read "$RID" --by worker >/dev/null 2>&1 \
  || fail "(21) the recipient cannot READ a live obligation whose id was once quarantined"
[ -f "$BUS/receipts/$RID.done" ] \
  || fail "(21) the note was read but never settled — the obligation is stuck"
echo "rows-diet: (21) a live payload outranks a quarantined artifact of the same name: ok"

# --- (22) the fold is over the residency SET, not one pair --------------------
# grok on the panel: archive collides exactly as quarantine does —
# `archive/<id>.cancelled.md` and `payloads/<id>.md` are different names, so a
# re-send at a cancelled id coexists with its tombstone. Probed before fixing:
# `tap show` AND `tap read` both refused `ambiguous`, `.done` absent. Fixing
# only the quarantine pair would have left this half stuck, which is why the
# precedence is payloads > archive > quarantine over the whole set.
AID="alice-20260904T150000Z-cccc11112222"
mkdir -p "$BUS/archive"
{ printf '%s\n' '---' "id: $AID" 'from: alice' 'to: worker' 'kind: discuss' 'reply: settle-only' \
    "path: $BUS/archive/$AID.cancelled.md" '---' '' 'the CANCELLED older payload'; \
  } > "$BUS/archive/$AID.cancelled.md"
{ printf '%s\n' '---' "id: $AID" 'from: alice' 'to: worker' 'kind: discuss' 'reply: settle-only' \
    "path: $BUS/payloads/$AID.md" '---' '' 'a LIVE re-send at the same id'; \
  } > "$BUS/payloads/$AID.md"
afout="$("$TAP" show "$AID" 2>&1)" \
  || fail "(22) a live re-send is unresolvable while its archive tombstone exists: $afout"
case "$afout" in *'a LIVE re-send at the same id'*) ;; *) fail "(22) show opened the ARCHIVED payload over the live one: $afout" ;; esac
"$TAP" read "$AID" --by worker >/dev/null 2>&1 \
  || fail "(22) the recipient cannot READ a live re-send at a cancelled id"
[ -f "$BUS/receipts/$AID.done" ] || fail "(22) the live re-send was read but never settled"
echo "rows-diet: (22) payloads outranks archive as well as quarantine: ok"


# --- (24) residency precedence is PER BUS, never across them ------------------
# Gate review F2 and partner review, independently: `hits` spans every
# reachable bus, so a global fold let one bus suppress another — a caller whose
# OWN bus held quarantined evidence was silently handed another team's live
# payload with nothing said about the local artifact. The controls are what make
# this a finding rather than a preference: same-residency collisions across
# buses still refuse, so the defect was the RANK crossing a boundary its own
# justification (what a reader owes ON A BUS) does not reach.
TEAMB="$FIX/teamb"; BBUS="$TEAMB/.tap/bus"
mkdir -p "$BBUS/payloads/.quarantine" "$BBUS/receipts"
printf '{"schema": "0.20", "team":{"name":"teamb"},"seats":{}}' > "$BBUS/registry.json"
python3 -B - "$TAP_INDEX_HOME/global-registry.json" "$TEAMB" <<'PY6'
import json, os, pathlib, sys
p = pathlib.Path(sys.argv[1])
doc = json.loads(p.read_text())
root = os.path.realpath(sys.argv[2])
doc["teams"]["teamb"] = {"root": root, "registry_location": os.path.join(root, ".tap", "bus", "registry.json"), "state": "registered"}
p.write_text(json.dumps(doc) + "\n")
PY6
XID="alice-20260904T160000Z-abcd11112222"
xshow() { "$TAP" show "$XID" 2>&1; }
xclean() { rm -f "$BUS/payloads/$XID.md" "$BUS/payloads/.quarantine/$XID.md" \
                 "$BBUS/payloads/$XID.md" "$BBUS/payloads/.quarantine/$XID.md"; }

# THE CASE: local quarantine + another bus's live payload must NOT silently
# resolve to the foreign payload — the local evidence exists and is suppressed.
xclean
printf 'local quarantined evidence\n' > "$BUS/payloads/.quarantine/$XID.md"
printf 'teamB live payload\n' > "$BBUS/payloads/$XID.md"
set +e; xc="$(xshow)"; xrc=$?; set -e
[ "$xrc" != 0 ] \
  || fail "(24) a foreign bus's live payload suppressed the caller's own quarantined evidence: $xc"
case "$xc" in *ambiguous*|*'more than one'*) ;; *) fail "(24) the cross-bus collision was resolved rather than reported: $xc" ;; esac

# CONTROL 1: exact local live addresses take precedence (tap-7r3fn.3.3);
# suffix ambiguity remains independent of residency precedence.
xclean
printf 'local live\n' > "$BUS/payloads/$XID.md"
printf 'teamB live\n' > "$BBUS/payloads/$XID.md"
set +e; xd="$(xshow)"; xdrc=$?; set -e
[ "$xdrc" = 0 ] || fail "(24) control: exact local live address did not resolve: $xd"
case "$xd" in *'local live'*) ;; *) fail "(24) control: exact address selected the foreign payload: $xd" ;; esac

# CONTROL 2: the fold still works WITHIN one bus — this is the behavior arms
# 21/22 pin, re-asserted here so a fix to (24) cannot silently disable it.
xclean
printf 'stale quarantined\n' > "$BUS/payloads/.quarantine/$XID.md"
printf 'the live one on this bus\n' > "$BUS/payloads/$XID.md"
xw="$(xshow)" || fail "(24) control: the same-bus fold stopped working: $xw"
case "$xw" in *'the live one on this bus'*) ;; *) fail "(24) control: same-bus fold picked the wrong residency: $xw" ;; esac
xclean
echo "rows-diet: (24) residency folds per bus; exact local live addresses win: ok"

# --- (25) the invalid-basename door collapses .md.N siblings too --------------
# luna's partner review: re-quarantine collides to `<name>.md.N` whether or not
# the name passes the live-id grammar. The base-only lookup returned the OLDEST
# evidence when a sibling existed, and NOTHING once the base was cleaned away —
# the same defect arm (17) fixed on the id door, one door over.
rm -f "$BUS/payloads/.quarantine/bad sib.md" "$BUS/payloads/.quarantine/bad sib.md.1"
printf 'sibling FIRST\n' > "$BUS/payloads/.quarantine/bad sib.md"
printf 'sibling SECOND newest\n' > "$BUS/payloads/.quarantine/bad sib.md.1"
sbout="$("$TAP" show 'bad sib' 2>&1)" || fail "(25) a badly-named quarantine sibling is unreachable: $sbout"
case "$sbout" in *'sibling SECOND newest'*) ;; *) fail "(25) the invalid-basename door opened the OLDER evidence: $sbout" ;; esac
rm -f "$BUS/payloads/.quarantine/bad sib.md"
sbout2="$("$TAP" show 'bad sib' 2>&1)" \
  || fail "(25) once the base name is gone the sibling is unreachable by any argument: $sbout2"
case "$sbout2" in *'sibling SECOND newest'*) ;; *) fail "(25) base-gone lookup found the wrong bytes: $sbout2" ;; esac
echo "rows-diet: (25) the invalid-basename door collapses collision siblings: ok"

# --- (26) an option-shaped quarantined name is addressable --------------------
# A malformed canonical may be named `--broken.md`; the resolver could always
# reach it, but both CLIs refused the argument as an unknown option before the
# resolver ran, so it was unaddressable in practice. `--` ends options.
rm -f "$BUS/payloads/.quarantine/--broken.md"
printf 'option-shaped evidence\n' > "$BUS/payloads/.quarantine/--broken.md"
set +e; obad="$("$TAP" show -- '--broken' 2>&1)"; obrc=$?; set -e
[ "$obrc" = 0 ] || fail "(26) an option-shaped quarantined name has no public door: $obad"
case "$obad" in *'option-shaped evidence'*) ;; *) fail "(26) the end-of-options door reached the wrong object: $obad" ;; esac
# And the door does not swallow a real unknown option BEFORE the separator.
set +e; obneg="$("$TAP" show --nonsense 2>&1)"; obnrc=$?; set -e
[ "$obnrc" != 0 ] || fail "(26) an unknown option before -- must still refuse: $obneg"

# BOTH CLIs, because the fix edited both parsers and a claim about `tap read`
# that only exercised `tap show` is a claim the arm does not support (luna's
# re-review). read's own `--` branch is pinned here through a REFUSAL that
# proves the parser accepted the argument: an option-shaped name reaches
# resolution, so read gets past parsing and fails on the quarantined residency
# instead of on `unknown option`. Without the door it never resolves at all.
# FLAGS BEFORE THE TERMINATOR. `--` ends option parsing, so `-- '--broken' --by
# worker` makes `--by` a second POSITIONAL and read refuses `unexpected arg`
# before identity or resolution — a wrong refusal that the first draft accepted
# because it only excluded the string "unknown option" (partner review).
# Asserting the SPECIFIC downstream refusal is what proves the name reached
# resolution; "not this one error" proves nothing about where it got to.
set +e; rdopt="$("$TAP" read --by worker -- '--broken' 2>&1)"; rdrc=$?; set -e
[ "$rdrc" != 0 ] || fail "(26) reading a quarantined artifact should not succeed; the arm is testing the wrong thing: $rdopt"
case "$rdopt" in
  *"unknown option"*)  fail "(26) tap read's parser still refuses an option-shaped name before resolution: $rdopt" ;;
  *"unexpected arg"*)  fail "(26) the invocation puts a flag after the terminator, so it refuses in the PARSER and never reaches resolution: $rdopt" ;;
esac
# The name resolved: read reached the quarantined artifact and refused on its
# CONTENT (an artifact in .quarantine is malformed by construction), naming the
# argument back. That is downstream of the parser, which is the claim.
case "$rdopt" in
  *"'--broken'"*) ;;
  *) fail "(26) the refusal does not name the resolved argument, so resolution was not reached: $rdopt" ;;
esac
# And read, like show, still refuses an unknown option that precedes the separator.
set +e; rdneg="$("$TAP" read --nonsense 2>&1)"; rdnrc=$?; set -e
[ "$rdnrc" != 0 ] || fail "(26) tap read must still refuse an unknown option before --: $rdneg"
case "$rdneg" in *"unknown option"*) ;; *) fail "(26) tap read's unknown-option refusal changed shape: $rdneg" ;; esac
echo "rows-diet: (26) -- makes an option-shaped quarantined name addressable in BOTH CLIs: ok"


# --- (28) poll's ENVELOPE-ID mismatch path reports a degraded quarantine too --
# grok on the panel: the invalid-envelope branch was routed through the degraded
# case and the id_mismatch branch one block below still `&&`-counted, so a
# generation-failed id_mismatch quarantine was silent on poll. Same defect, one
# branch over — the reason to grep the class after fixing an instance.
PMB="$FIX/pollmismatch/.tap/bus"; mkdir -p "$PMB/payloads/.quarantine" "$PMB/receipts"
{ printf '%s\n' '---' 'id: some-other-id' 'from: alice' 'to: worker' 'kind: discuss' \
    'reply: settle-only' "path: $PMB/payloads/pm-victim.md" '---' '' 'envelope id disagrees'; \
  } > "$PMB/payloads/pm-victim.md"
printf '{"bundle_id":"b","state":"pristine"}\n' > "$PMB/reset-generation.json"
# Let poll finish its own bootstrap (the bus-authority stamp) BEFORE the root
# goes read-only, or the arm fails on setup instead of on the branch under test.
set +e; TAP_HOME="$PMB" "$TAP" poll worker >/dev/null 2>&1; set -e
{ printf '%s\n' '---' 'id: some-other-id' 'from: alice' 'to: worker' 'kind: discuss' \
    'reply: settle-only' "path: $PMB/payloads/pm-victim.md" '---' '' 'envelope id disagrees'; \
  } > "$PMB/payloads/pm-victim.md"
printf '{"bundle_id":"b","state":"pristine"}\n' > "$PMB/reset-generation.json"
chmod a-w "$PMB"
set +e; pmout="$(TAP_HOME="$PMB" "$TAP" poll worker 2>&1)"; set -e
chmod u+w "$PMB"
case "$pmout" in
  *'could not be fully quarantined'*) ;;
  *) fail "(28) poll's id_mismatch quarantine failed its generation mark and reported nothing: $pmout" ;;
esac
echo "rows-diet: (28) poll reports a degraded id_mismatch quarantine, not only an envelope one: ok"

# --- (29) two ids sharing a suffix are two ADDRESSES, and refuse ---------------
# The rank folds VERSIONS of one logical id; it must never choose between ids.
# Keying the fold on bus alone did exactly that: a live `alice-...-<hex>`
# silently displaced a quarantined `bob-...-<hex>` — two different messages, one
# dropped without a word — while every earlier arm stayed green, because they
# all used ONE logical id. Architect ruling 2026-09-04: "a short name is an
# address only while it is unique; two ids that share a 12-hex suffix are two
# addresses, and they refuse."
COLHEX="abcd11112222"
CID_LIVE="alice-20260904T170000Z-$COLHEX"
CID_QUAR="bob-20260904T180000Z-$COLHEX"
rm -f "$BUS/payloads/$CID_LIVE.md" "$BUS/payloads/.quarantine/$CID_QUAR.md" \
      "$BUS/payloads/.quarantine/$CID_LIVE.md"
printf 'ALICE live message\n' > "$BUS/payloads/$CID_LIVE.md"
printf 'BOB quarantined, a DIFFERENT message\n' > "$BUS/payloads/.quarantine/$CID_QUAR.md"
set +e; colout="$("$TAP" show "$COLHEX" 2>&1)"; colrc=$?; set -e
[ "$colrc" != 0 ] \
  || fail "(29) two DIFFERENT logical ids sharing a suffix resolved to one — the rank chose between messages, not between states: $colout"
case "$colout" in *ambiguous*|*'more than one'*) ;; *) fail "(29) the suffix collision was not reported as ambiguous: $colout" ;; esac
case "$colout" in *"$CID_QUAR"*) ;; *) fail "(29) the ambiguity report omits the quarantined id that was being displaced: $colout" ;; esac
# CONTROL: the fold still applies to two STATES of ONE id on the same bus, so
# fixing the collision cannot be achieved by disabling the fold.
rm -f "$BUS/payloads/.quarantine/$CID_QUAR.md"
printf 'the stale quarantined version\n' > "$BUS/payloads/.quarantine/$CID_LIVE.md"
folded="$("$TAP" show "$COLHEX" 2>&1)" \
  || fail "(29) control: two states of ONE id must still fold: $folded"
case "$folded" in *'ALICE live message'*) ;; *) fail "(29) control: the fold picked the wrong state: $folded" ;; esac

# COMPOSITIONAL CONTROL: live + a NUMBERED quarantine sibling, base absent.
# The control above uses only the base `<id>.md`, so `_logical_id`'s `.md.N`
# normalization is a survivor there — deleting it leaves that row green while
# THIS shape flips found->ambiguous, because the two states become two logical
# ids and refuse (partner review). Both are states of one address and must
# fold to live.
rm -f "$BUS/payloads/.quarantine/$CID_LIVE.md"
printf 'the newest quarantined sibling\n' > "$BUS/payloads/.quarantine/$CID_LIVE.md.2"
sibfold="$("$TAP" show "$COLHEX" 2>&1)" \
  || fail "(29) a live payload and its NUMBERED quarantine sibling are two states of one address and must fold, not refuse: $sibfold"
case "$sibfold" in *'ALICE live message'*) ;; *) fail "(29) the fold over a numbered sibling picked the wrong state: $sibfold" ;; esac
rm -f "$BUS/payloads/$CID_LIVE.md" "$BUS/payloads/.quarantine/$CID_LIVE.md" \
      "$BUS/payloads/.quarantine/$CID_LIVE.md.2"
echo "rows-diet: (29) a suffix shared by two ids refuses; two states of one id still fold: ok"


echo "rows-diet: ok"

# The claim-race and missing-destination arms exec'd lib.sh's embedded quarantine
# program, which is retired. The native owner (quarantine.ts) retries EEXIST
# with a numbered sibling (arm 7 above, end to end) and its ENOENT split is
# pinned in runtime/bun/test/quarantine.test.ts.

# Refresh reporter quoting is covered by native team.test.ts and team-refresh-parity.test.sh.
