#!/usr/bin/env bash
# local-adoption-authority.test.sh — successor grants through all settle doors.
# RED baseline: read refused local adoption at the recipient_instance gate.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# shellcheck source=helpers.sh
. "$ROOT/skills/tap/scripts/smoke/helpers.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TAP_INDEX_HOME="$WORK/index"
export TAP_HOME="$WORK/team/.tap/bus"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$WORK/team/.tap/team-history" "$TAP_INDEX_HOME"
# Source lib AFTER TAP_HOME so TAP_REGISTRY tracks the fixture bus.
# shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"

fail() { echo "local-adoption-authority: $*" >&2; exit 1; }

# Flip-live; stored loc = bus registry (agents shape ok — this test is grant identity).
python3 - "$TAP_INDEX_HOME/global-registry.json" "$WORK/team" <<'PY'
import json, os, sys, time
gpath, root = sys.argv[1:3]
os.makedirs(os.path.dirname(gpath), exist_ok=True)
json.dump({
  "schema": "0.20",
  "migrated": {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "backups": {}},
  "teams": {"team": {
    "root": root,
    "registry_location": root + "/.tap/bus/registry.json",
    "state": "registered",
  }},
}, open(gpath, "w"), indent=2)
open(gpath, "a").write("\n")
PY

# Successor alice adopted fork alice-2; grant records alice-2's retired instance.
cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": { "name": "team", "worktree_root": "REPLACE" },
  "seats": {
    "alice": {
      "status": "active", "delivery": "poll", "harness": "claude",
      "instance": "alice|SUCC001",
      "adopted_handles": ["alice-2"],
      "adopted_instances": { "alice-2": "alice-2|FORK999" }
    }
  }
}
JSON
python3 -c 'import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.write_text(p.read_text().replace("REPLACE", sys.argv[2]))' \
  "$TAP_HOME/registry.json" "$WORK/team"

tap_registry_v20_live || fail "flip should be live"
# tap_adopted_into and tap_addressee_grant_check (the lib.sh adapters that used
# to pre-check grant discovery and the grant instance record directly) were
# deleted as callerless Bash functions once the native `read` door started
# calling runtime/bun/src/addressee-grant.ts in-process; that module's own
# unit rows cover both checks directly (runtime/bun/test/addressee-grant.test.ts).
# This smoke test proves the same grant end-to-end through the real
# read/reply/foreign-read/foreign-reply doors below.

# The same authority fixture drives read, reply, local done and foreign done.
python3 - "$TAP_HOME/registry.json" <<'PYREG'
import json,sys
p=sys.argv[1]; r=json.load(open(p))
r['seats']['bob']={'status':'active','delivery':'poll','instance':'bob|sender','harness':'codex'}
json.dump(r,open(p,'w'))
PYREG
printf 'answer body\n' > "$WORK/answer.md"
for shape in local remainder wrong; do
  for verb in read reply foreign-read foreign-reply; do
    id="sender-20260905T000000Z-${shape}-${verb}"
    to=alice-2; adopted=''; rinst='alice-2|FORK999'
    [ "$shape" != local ] || { to=alice; adopted='to_adopted_from: alice-2'; }
    [ "$shape" != wrong ] || rinst='alice-2|WRONG'
    bus="$TAP_HOME"
    if [[ "$verb" = foreign-* ]]; then bus="$WORK/sender/.tap/bus"; fi
    mkdir -p "$bus/payloads" "$bus/receipts"
    reply=settle-only; [[ "$verb" != *reply ]] || reply=expected
    cat > "$bus/payloads/$id.md" <<PAYLOAD
---
id: $id
from: bob
to: $to
kind: discuss
reply: $reply
recipient_instance: $rinst
$adopted
path: $bus/payloads/$id.md
---
adopted work
PAYLOAD
    rc=0
    case "$verb" in
      read) "$TAP" read "$id" --by alice >"$WORK/out" 2>&1 || rc=$? ;;
      reply) "$TAP" reply "$id" --by alice -f "$WORK/answer.md" >"$WORK/out" 2>&1 || rc=$? ;;
      foreign-read) "$TAP" read "path=$bus/payloads/$id.md" --by alice >"$WORK/out" 2>&1 || rc=$? ;;
      foreign-reply) "$TAP" reply "$id" --by alice --payload "$bus/payloads/$id.md" -f "$WORK/answer.md" >"$WORK/out" 2>&1 || rc=$? ;;
    esac
    if [ "$shape" = wrong ]; then
      [ "$rc" != 0 ] || fail "$verb accepted wrong adopted instance"
      [ ! -e "$bus/receipts/$id.done" ] || fail "$verb settled wrong instance"
      grep -q 'FORK999' "$WORK/out" || fail "$verb did not name adopted instance"
    else
      [ "$rc" = 0 ] || { cat "$WORK/out" >&2; fail "$verb refused $shape adoption"; }
      python3 - "$bus/receipts/$id.done" "$verb" <<'RECEIPT'
import json,sys
r=json.load(open(sys.argv[1])); verb=sys.argv[2]
assert r['by']=='alice' and r['adopted_from']=='alice-2',r
assert not r.get('forced'),r
assert r['via']==('reply' if verb.endswith('reply') else 'read'),r
RECEIPT
      if grep -q 'read_forced' "$TAP_HOME/registry-events.log" 2>/dev/null; then fail 'grant was forced'; fi
    fi
  done
done
echo 'local-adoption-authority: read/reply on both buses honor local/remainder grants and reject wrong instances'

# T6: a fork's old binding never invents restoration under the successor.
python3 - "$TAP_HOME/registry.json" <<'PYREG'
import json,sys
p=sys.argv[1];r=json.load(open(p));r['seats']['alice'].pop('adopted_handles');r['seats']['alice'].pop('adopted_instances');json.dump(r,open(p,'w'))
PYREG
cat > "$WORK/team/.tap/team-history/alice.old.json" <<'JSON'
{"handle":"alice","instance":"alice|old","retired_by":"tap out","retired_at":"2026-01-01T00:00:00Z"}
JSON
for rinst in 'alice-2|FORK999' 'alice|old'; do
  for verb in read reply; do
    id="sender-20260905T000000Z-remedy-$verb"
    cat > "$TAP_HOME/payloads/$id.md" <<PAYLOAD
---
id: $id
from: bob
to: alice
kind: discuss
reply: expected
to_adopted_from: alice-2
recipient_instance: $rinst
path: $TAP_HOME/payloads/$id.md
---
work without a grant
PAYLOAD
    rc=0
    if [ "$verb" = reply ]; then
      "$TAP" reply "$id" --by alice -f "$WORK/answer.md" >"$WORK/out" 2>&1 || rc=$?
    else
      "$TAP" "$verb" "$id" --by alice >"$WORK/out" 2>&1 || rc=$?
    fi
    [ "$rc" != 0 ] || fail "$verb accepted missing grant"
    grep -q "tap cancel $id --by bob" "$WORK/out" || fail "$verb omitted sender cancel"
    if [ "$rinst" = 'alice|old' ]; then
      grep -q 'tap in alice --restore alice|old' "$WORK/out" || fail "$verb omitted real actor history"
    elif grep -q -- '--restore' "$WORK/out"; then
      fail "$verb invented fork restoration under successor"
    fi
  done
done
echo 'local-adoption-authority: remedies use actor history only'
