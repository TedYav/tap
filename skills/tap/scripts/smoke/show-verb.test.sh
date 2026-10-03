#!/usr/bin/env bash
# show-verb.test.sh — tap-7r3fn.4 (W6 U1): `tap show <id|team/id|12hex>`.
#
# `tap show` is the human-forensics surface (spec §11): anyone may run it, it is
# mechanically incapable of acking, and it prints path, full frontmatter, the
# receipt chain, and the body. The chain is placed/read/done/cancelled — `.sent`
# is deliberately absent because tap_write_sent_receipt (lib.sh:1139-1142) emits
# no `at` field, so a timestamped chain entry for it would have to invent
# protocol time from mtime, and it carries turn=unconfirmed besides (architect
# ruling the leader, spec §11 amended).
#
# The side-effect arm is a FULL manifest of every writable state root the sandbox
# pins, not a named list of directories. A selective list answers a narrower
# question than its name: it can only catch the writes its author thought of,
# and the dispatcher prologue alone reaches registry reconciliation
# (tap.sh:636), tap_ensure_dirs' mkdir (lib.sh:199), the opportunistic spool
# drain, and the reset-generation touch. The manifest catches a write nobody
# enumerated.
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
{"schema": "0.20", "team":{"name":"alpha"},"seats":{"worker":{"status":"active","delivery":"pane","pane":"alpha:0.1","harness":"codex"},"fable":{"status":"active","delivery":"poll","harness":"daemon","instance":"fable|5c2007b4cba81ca5"},"Other.Seat":{"status":"active","delivery":"poll","harness":"daemon","instance":"Other.Seat|0a1b2c3d4e5f6a7b"}}}
JSON
cat > "$BETA/.tap/bus/registry.json" <<JSON
{"schema": "0.20", "team":{"name":"beta"},"seats":{"fable":{"status":"active","delivery":"poll","harness":"daemon"}}}
JSON

# Every pinned state root belongs to THIS fixture, not to the suite.
# scripts/smoke-all.sh:1075-1078 defaults all four into the SHARED
# $TAP_SUITE_SANDBOX, and arm 4's whole claim is that `tap show` wrote nothing
# anywhere — a claim it cannot make about state its neighbours write. Two earlier
# attempts fixed one layer each (the shared parent directories, then a shared
# FILE in the same root) and both still failed under -j, because each time the
# oracle's subject was still partly the suite rather than the verb. Owning the
# pins is what makes the subject the verb. Per-test overrides win over the
# runner's defaults, which is the seam sandbox-pins.sh documents for exactly this.
export TAP_INDEX_HOME="$FIX/index"
export TAP_SESSION_MANIFEST="$FIX/state/sessions.json"
export OPENCODE_DB_PATH="$FIX/state/opencode.db"
export TAP_VERSION_SEEN_PATH="$FIX/state/version-seen.json"
export XDG_CONFIG_HOME="$FIX/xdg"
mkdir -p "$FIX/state" "$FIX/xdg"
mkdir -p "$TAP_INDEX_HOME"
ALPHA_REAL="$(cd "$ALPHA" && pwd -P)"; BETA_REAL="$(cd "$BETA" && pwd -P)"
cat > "$TAP_INDEX_HOME/global-registry.json" <<JSON
{"schema":"0.20","teams":{
  "alpha":{"root":"$ALPHA_REAL","registry_location":"$ALPHA_REAL/.tap/bus/registry.json","state":"registered"},
  "beta": {"root":"$BETA_REAL","registry_location":"$BETA_REAL/.tap/bus/registry.json","state":"registered"}
}}
JSON

# Instance stamps are planted on every fixture payload because the driver made
# an explicit, contestable choice to PRINT them (spec §7 keeps them off the wire;
# §11 says this surface prints full frontmatter). A choice defended only by a
# `from`/`reply` check is not defended: a redaction of both stamps would stay
# green. Arm 1 asserts their exact values, and a filtering mutant must red.
RINST="worker|a67ad4a277fd310c"
SINST="fable|5c2007b4cba81ca5"
plant() { # <bus> <id> <from> <to> <reply> <body>
  local bus="$1" id="$2" from="$3" to="$4" reply="$5" body="$6"
  { printf '%s\n' '---' "id: $id" "from: $from" "to: $to" 'kind: discuss' \
      "reply: $reply" "path: $bus/payloads/$id.md" \
      "recipient_instance: $RINST" "sender_instance: $SINST" '---' '' "$body"; \
  } > "$bus/payloads/$id.md"
}

A_BUS="$ALPHA/.tap/bus"; B_BUS="$BETA/.tap/bus"
ID_FULL="fable-20260903T120000Z-aaaaaaaaaaaa"
ID_BETA="fable-20260903T120002Z-cccccccccccc"
plant "$A_BUS" "$ID_FULL" fable worker settle-only 'the body of the full-chain payload'
plant "$B_BUS" "$ID_BETA" fable worker expected 'a payload living on the beta bus'

# A full receipt chain on the alpha payload: placed, read, done. `.sent` also
# exists so the arm can prove show does NOT render it.
printf '{"id":"%s","via":"courier","at":"2026-09-03T12:00:01Z"}\n' "$ID_FULL" > "$A_BUS/receipts/$ID_FULL.placed"
printf '{"id":"%s","from":"fable","to":"worker","pane":"alpha:0.1","kind":"discuss","turn":"unconfirmed","delivery":"pane"}\n' "$ID_FULL" > "$A_BUS/receipts/$ID_FULL.sent"
printf '{"id":"%s","by":"worker","at":"2026-09-03T12:00:20Z","identity":"pane"}\n' "$ID_FULL" > "$A_BUS/receipts/$ID_FULL.read"
printf '{"id":"%s","status":"done","at":"2026-09-03T12:00:30Z","by":"worker","via":"read"}\n' "$ID_FULL" > "$A_BUS/receipts/$ID_FULL.done"

# ---------------------------------------------------------------------------
# Manifest: every writable state root, as path + content hash + mtime. Any
# difference — including a file this test never thought to name — fails.
# Every root the sandbox pins, not the three this test happens to build.
# sandbox-pins.sh exports TAP_SESSION_MANIFEST, OPENCODE_DB_PATH and
# TAP_VERSION_SEEN_PATH into a root of their own and XDG_CONFIG_HOME into
# another; a manifest headed "every writable state root" that walks only
# TAP_INDEX_HOME/$ALPHA/$BETA is making a claim it does not check, and a mutant
# writing $TAP_SESSION_MANIFEST from the production leaf survived the first
# version of this file. Roots are labelled so a diff says WHICH pin moved, and
# directories are stamped too so a create-then-delete inside one is visible.
manifest_roots() {
  printf '%s\n' \
    "$TAP_INDEX_HOME" "$ALPHA" "$BETA" "$XDG_CONFIG_HOME" \
    "$TAP_SESSION_MANIFEST" "$OPENCODE_DB_PATH" "$TAP_VERSION_SEEN_PATH" \
  | awk 'NF && !seen[$0]++'
}

manifest() { # <label>
  # shellcheck disable=SC2046
  python3 -B - $(manifest_roots) <<'PY'
import hashlib, os, sys
out = []
for root in sys.argv[1:]:
    if not os.path.exists(root):
        out.append("%s\t<absent>\t-" % root)
        continue
    # The root's OWN mtime. os.walk below stats files and CHILD directories but
    # never the root, so a file created and deleted directly under a root left
    # no trace at all: the file is gone and only the root's mtime moved.
    try:
        out.append("%s\t<root>\t%.9f" % (root, os.lstat(root).st_mtime))
    except OSError:
        out.append("%s\t<root>\tunreadable" % root)
    # A pin can be a FILE (sessions.json, opencode.db, version-seen.json). Hash
    # it directly rather than walking its shared parent directory.
    if not os.path.isdir(root):
        try:
            with open(root, "rb") as fh:
                out.append("%s\t%s\tfile" % (root, hashlib.sha256(fh.read()).hexdigest()))
        except OSError as exc:
            out.append("%s\tunreadable:%s\tfile" % (root, exc.errno))
        continue
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            p = os.path.join(dirpath, name)
            try:
                st = os.lstat(p)
                if os.path.islink(p):
                    digest = "symlink:" + os.readlink(p)
                else:
                    with open(p, "rb") as fh:
                        digest = hashlib.sha256(fh.read()).hexdigest()
            except OSError as exc:
                digest = "unreadable:%s" % exc.errno
                st = None
            # st_mtime as a float: a same-second rewrite is invisible at 1s
            # resolution, which is exactly the write this arm must catch.
            mtime = "%.9f" % st.st_mtime if st else "none"
            out.append("%s::%s\t%s\t%s" % (root, os.path.relpath(p, root), digest, mtime))
        for name in sorted(dirnames):
            d = os.path.join(dirpath, name)
            try:
                dm = "%.9f" % os.lstat(d).st_mtime
            except OSError:
                dm = "none"
            out.append("%s::%s/\tdir\t%s" % (root, os.path.relpath(d, root), dm))
print("\n".join(out))
PY
}

fail() { echo "show-verb: $*" >&2; exit 1; }

# --- (4) side-effect-free, against a full state manifest --------------------
# FIRST, deliberately. Several of the writes this arm exists to catch are
# one-time and idempotent (tap_ensure_dirs stamps .tap-bus-authority and the
# dotdir .gitignore exactly once, lib.sh:199-232), so a before/after pair taken
# after any earlier `show` call brackets nothing: the write already happened and
# both snapshots agree. Ordering this arm ahead of every other invocation is
# what makes it able to fail.
before="$(manifest)"
TAP_HOME="$A_BUS" "$TAP" show "$ID_FULL" >/dev/null 2>&1 || fail "(4) show exited non-zero under the manifest arm"
after="$(manifest)"
if [ "$before" != "$after" ]; then
  echo "show-verb: (4) tap show mutated state on its FIRST invocation; diff follows" >&2
  diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") >&2 || true
  exit 1
fi
# And a bus root that does not exist yet: a creating write leaves a directory
# where the manifest of an already-materialized tree would have seen nothing.
# No `|| true` here: with one, `show` could REFUSE from a bus-less root and the
# arm would still pass, leaving "anyone may run it" untested for the case the
# driver actually hit by hand (`tap send` refuses an unanchored cwd this way).
# The forensics surface must answer from anywhere, so the arm demands rc 0 AND
# the body, then checks nothing was created.
GHOST="$FIX/ghost/.tap/bus"
ghost_out="$(TAP_HOME="$GHOST" "$TAP" show "beta/$ID_BETA" 2>&1)" \
  || fail "(4) show refused from a bus root that does not exist: $ghost_out"
case "$ghost_out" in *"a payload living on the beta bus"*) ;; *) fail "(4) show from a ghost bus printed no body" ;; esac
[ ! -e "$FIX/ghost" ] || {
  echo "show-verb: (4) show created state under a bus root that did not exist:" >&2
  find "$FIX/ghost" >&2 || true
  exit 1
}
# And the cwd-derived path, which is a different code path from the TAP_HOME
# override: a read verb that refuses an unanchored cwd cannot be the surface a
# stranger reaches for.
mkdir -p "$FIX/nobus"
nobus_out="$( cd "$FIX/nobus" && env -u TAP_HOME "$TAP" show "beta/$ID_BETA" 2>&1 )" \
  || fail "(4) show refused from a cwd with no bus: $nobus_out"
case "$nobus_out" in *"a payload living on the beta bus"*) ;; *) fail "(4) show from a bus-less cwd printed no body" ;; esac
# A file created and DELETED directly under a pinned root leaves nothing behind
# except that root's own mtime. Proving the manifest records that is the whole
# point of the <root> row; without this arm the row is decoration, and the
# reviewer's transient-write mutant passed against the previous version.
canary="$ALPHA/.transient-canary"
pre="$(manifest)"
: > "$canary"; rm -f "$canary"
post="$(manifest)"
[ "$pre" != "$post" ] || fail "(4) the manifest cannot see a create-then-delete directly under a pinned root — the <root> mtime row is not doing its job"
echo "show-verb: (4) show wrote nothing on a first invocation, created no bus root, answers from an unanchored cwd, and the oracle can see a transient root-level write: ok"

# --- (1) exact id on the local bus: path, frontmatter, chain, body ----------
out="$(TAP_HOME="$A_BUS" "$TAP" show "$ID_FULL" 2>"$FIX/show1.err")" \
  || fail "(1) tap show <exact-id> exited non-zero: $(cat "$FIX/show1.err")"
case "$out" in *"$A_BUS/payloads/$ID_FULL.md"*) ;; *) fail "(1) show did not print the payload path" ;; esac
case "$out" in *"from: fable"*) ;; *) fail "(1) show did not print frontmatter 'from'" ;; esac
case "$out" in *"reply: settle-only"*) ;; *) fail "(1) show did not print frontmatter 'reply'" ;; esac
case "$out" in *"the body of the full-chain payload"*) ;; *) fail "(1) show did not print the body" ;; esac
case "$out" in *"recipient_instance: $RINST"*) ;; *) fail "(1) show redacted recipient_instance; §11 says this surface prints FULL frontmatter and a forensics view that hides the field a reader came for is the summary field again" ;; esac
case "$out" in *"sender_instance: $SINST"*) ;; *) fail "(1) show redacted sender_instance" ;; esac
echo "show-verb: (1) exact id prints path, frontmatter (instance stamps included), and body: ok"

# --- (2) the receipt chain is placed/read/done/cancelled, never .sent -------
case "$out" in *placed*2026-09-03T12:00:01Z*) ;; *) fail "(2) chain missing placed with its timestamp" ;; esac
case "$out" in *read*2026-09-03T12:00:20Z*) ;; *) fail "(2) chain missing read with its timestamp" ;; esac
case "$out" in *done*2026-09-03T12:00:30Z*) ;; *) fail "(2) chain missing done with its timestamp" ;; esac
chain_of() { # <output> -> just the receipts block, one line per receipt
  printf '%s\n' "$1" | awk '/^receipts:$/{inblk=1;next} inblk&&/^$/{exit} inblk{print}'
}
chain="$(chain_of "$out")"
[ -n "$chain" ] || fail "(2) could not extract a receipts block from show's output"
printf '%s\n' "$chain" | grep -qE '^[[:space:]]+sent[[:space:]]' \
  && fail "(2) show rendered a 'sent' row in the receipt chain: it stores no protocol time and reports submit telemetry (turn=unconfirmed), not that the recipient acted"
for want in placed read done; do
  printf '%s\n' "$chain" | grep -qE "^[[:space:]]+$want[[:space:]]" \
    || fail "(2) receipt chain has no '$want' row"
done
[ "$(printf '%s\n' "$chain" | grep -cE '^[[:space:]]+[a-z]+[[:space:]]')" = 3 ] \
  || fail "(2) chain should hold exactly the three receipts on disk that belong to it, got: $chain"
echo "show-verb: (2) chain renders placed/read/done and excludes .sent: ok"

# --- (3) a cancelled payload shows its discharge ---------------------------
# Driven through the REAL `tap cancel`, not by planting a .cancelled receipt
# beside a live payload. That planted shape is a state the verb never produces:
# tap-cancel.sh:439-448 MOVES the canonical to archive/<id>.cancelled.md. The
# first version of this arm invented the convenient state and would have passed
# over a `show` that could not find a single genuinely cancelled payload.
# Born live, cancel honours the payload's sender-instance stamp, so alpha seats
# the stamped fable instance (SINST) that plants these payloads.
ID_CANC="fable-20260903T120003Z-dddddddddddd"
plant "$A_BUS" "$ID_CANC" fable ghostseat settle-only 'cancelled payload body'
printf '{"id":"%s","via":"courier","at":"2026-09-03T12:04:00Z"}\n' "$ID_CANC" > "$A_BUS/receipts/$ID_CANC.placed"
TAP_HOME="$A_BUS" "$TAP" cancel "$ID_CANC" --by fable >/dev/null 2>"$FIX/cancel.err" \
  || fail "(3) fixture setup: tap cancel failed: $(cat "$FIX/cancel.err")"
[ ! -f "$A_BUS/payloads/$ID_CANC.md" ] \
  || fail "(3) fixture assumption broken: cancel left the payload in payloads/ — re-check tap-cancel.sh before trusting this arm"
[ -f "$A_BUS/archive/$ID_CANC.cancelled.md" ] \
  || fail "(3) fixture assumption broken: cancel did not archive to archive/<id>.cancelled.md"

outc="$(TAP_HOME="$A_BUS" "$TAP" show "$ID_CANC" 2>&1)" \
  || fail "(3) show could not find a genuinely cancelled payload: $outc"
case "$outc" in *cancelled*) ;; *) fail "(3) chain did not render the .cancelled discharge" ;; esac
case "$outc" in *residency:*archive*) ;; *) fail "(3) show did not say the payload had been moved to archive/" ;; esac
case "$outc" in *'cancelled payload body'*) ;; *) fail "(3) show printed no body for the archived payload" ;; esac
echo "show-verb: (3) a really-cancelled payload resolves from archive/ and shows its discharge: ok"

# --- (5) 12-hex suffix resolves, and ambiguity refuses by naming candidates --
# A decoy whose HANDLE is the very hex string being searched for, while its own
# suffix is something else. Spec §13: a 12-hex input matches the id's LAST
# fixed-width field only, never a hex run earlier in the name. Without this
# payload the fixture cannot tell a right-anchored match from a substring one —
# both rules return the same single answer, and a substring implementation
# passes.
ID_DECOY="aaaaaaaaaaaa-20260903T140000Z-999999999999"
plant "$A_BUS" "$ID_DECOY" aaaaaaaaaaaa worker settle-only 'the right-anchoring decoy'

# A minted id whose HANDLE carries uppercase and a dot. The courier's id minter
# validates the sender against TAP_ID_RE and prints it verbatim, so this is an
# ordinary courier-minted id today — not a curiosity. A suffix rule written in
# §13's future lowercase handle grammar cannot see it, and the payload becomes
# unreachable by the address printed on its own sentinel.
ID_MIXED="Mixed.Case-20260903T130001Z-eeeeeeeeeeee"
plant "$A_BUS" "$ID_MIXED" Mixed.Case worker settle-only 'a minted id with an uppercase dotted handle'
mixout="$(TAP_HOME="$A_BUS" "$TAP" show eeeeeeeeeeee 2>&1)" \
  || fail "(5) suffix did not resolve a minted id whose handle is uppercase/dotted: $mixout"
case "$mixout" in *"a minted id with an uppercase dotted handle"*) ;; *) fail "(5) mixed-case minted suffix resolved to the wrong payload" ;; esac

# The same, in the ARCHIVE residency: a cancelled payload must stay reachable by
# suffix, or a cancelled message is addressable only by an id nobody kept.
ID_MIXARCH="Other.Seat-20260903T130002Z-ffffffffffff"
plant "$A_BUS" "$ID_MIXARCH" Other.Seat ghostseat settle-only 'an archived minted id with a dotted handle'
# Its sender stamp is its own seat, so the live-marker cancel binding holds.
python3 -c 'import re,sys; p=sys.argv[1]; t=open(p).read(); open(p,"w").write(re.sub(r"(?m)^sender_instance: .*$", "sender_instance: Other.Seat|0a1b2c3d4e5f6a7b", t))' "$A_BUS/payloads/$ID_MIXARCH.md"
printf '{"id":"%s","via":"courier","at":"2026-09-03T13:00:03Z"}\n' "$ID_MIXARCH" > "$A_BUS/receipts/$ID_MIXARCH.placed"
TAP_HOME="$A_BUS" "$TAP" cancel "$ID_MIXARCH" --by Other.Seat >/dev/null 2>&1 \
  || fail "(5) fixture setup: could not cancel the archived mixed-case payload"
archout="$(TAP_HOME="$A_BUS" "$TAP" show ffffffffffff 2>&1)" \
  || fail "(5) suffix did not resolve a CANCELLED minted id with a dotted handle: $archout"
case "$archout" in *"an archived minted id with a dotted handle"*) ;; *) fail "(5) archived mixed-case suffix resolved wrong" ;; esac

outs="$(TAP_HOME="$A_BUS" "$TAP" show aaaaaaaaaaaa 2>/dev/null)" || fail "(5) 12-hex suffix did not resolve"
case "$outs" in *"$ID_FULL"*) ;; *) fail "(5) suffix resolved to the wrong payload" ;; esac
case "$outs" in *"$ID_DECOY"*) fail "(5) suffix matched a hex run inside a handle; §13 anchors it to the id's last field" ;; esac
ID_DUP="worker-20260903T130000Z-aaaaaaaaaaaa"
plant "$B_BUS" "$ID_DUP" worker fable settle-only 'the ambiguous twin'
set +e
amb="$(TAP_HOME="$A_BUS" "$TAP" show aaaaaaaaaaaa 2>&1)"; ambrc=$?
set -e
[ "$ambrc" -ne 0 ] || fail "(5) ambiguous suffix exited 0 instead of refusing"
case "$amb" in *"$ID_FULL"*"$ID_DUP"*|*"$ID_DUP"*"$ID_FULL"*) ;; *) fail "(5) ambiguity refusal did not name both candidates: $amb" ;; esac
rm -f "$B_BUS/payloads/$ID_DUP.md"
echo "show-verb: (5) suffix resolves and ambiguity refuses naming candidates: ok"

# --- (6) a team-qualified id reaches the other team's bus -------------------
outb="$(TAP_HOME="$A_BUS" "$TAP" show "beta/$ID_BETA" 2>"$FIX/show6.err")" \
  || fail "(6) team-qualified show failed: $(cat "$FIX/show6.err")"
case "$outb" in *"a payload living on the beta bus"*) ;; *) fail "(6) team-qualified show did not print the beta body" ;; esac
case "$outb" in *"$B_BUS/payloads/$ID_BETA.md"*) ;; *) fail "(6) team-qualified show did not print the beta path" ;; esac
echo "show-verb: (6) team-qualified id resolves cross-team: ok"

# --- (7) anyone may run it: no actor, no registration, no refusal -----------
outn="$(TAP_HOME="$A_BUS" TAP_SELF="" "$TAP" show "$ID_FULL" 2>/dev/null)" \
  || fail "(7) show refused a caller with no actor identity"
case "$outn" in *"the body of the full-chain payload"*) ;; *) fail "(7) show without an actor printed no body" ;; esac
echo "show-verb: (7) anyone may run it, no actor required: ok"

# --- (8) an unknown id refuses rather than printing an empty shell ----------
set +e
miss="$(TAP_HOME="$A_BUS" "$TAP" show fable-20260903T999999Z-ffffffffffff 2>&1)"; missrc=$?
set -e
[ "$missrc" -ne 0 ] || fail "(8) show on an unknown id exited 0"
case "$miss" in *not*found*|*no*payload*) ;; *) fail "(8) unknown-id refusal did not say what was missing: $miss" ;; esac
echo "show-verb: (8) unknown id refuses: ok"

# --- (9) exact ids the CURRENT grammar allows, not just the minted shape -----
# TAP_ID_RE (lib.sh:498) is `^[A-Za-z0-9][A-Za-z0-9._-]*$` and `tap send --id`
# accepts any token matching it, so the live bus carries ids like
# `legacy-custom-final` that the §13 minted grammar rejects. Validating the
# exact-id door against tomorrow's minted shape made show answer "badid" for a
# file it was looking straight at — and U4 needs this door to inspect quarantined
# malformed artifacts, which are exactly these.
for legacy in legacy-custom-final Mixed.Case-ID_9; do
  { printf '%s\n' '---' "id: $legacy" 'from: legacy-sender' 'to: worker' 'kind: discuss' \
      'reply: settle-only' "path: $A_BUS/payloads/$legacy.md" '---' '' "legacy body for $legacy"; \
  } > "$A_BUS/payloads/$legacy.md"
  legout="$(TAP_HOME="$A_BUS" "$TAP" show "$legacy" 2>&1)" \
    || fail "(9) show refused the existing legacy id '$legacy': $legout"
  case "$legout" in *"legacy body for $legacy"*) ;; *) fail "(9) show printed no body for '$legacy'" ;; esac
done
# And a token the grammar genuinely rejects still refuses, so arm 9 is not just
# "accept everything".
set +e
badout="$(TAP_HOME="$A_BUS" "$TAP" show 'not a valid id' 2>&1)"; badrc=$?
set -e
[ "$badrc" -ne 0 ] || fail "(9) show accepted an id outside TAP_ID_RE: $badout"
echo "show-verb: (9) exact ids follow the bus's current grammar, and an invalid token still refuses: ok"

echo "show-verb: ok"
