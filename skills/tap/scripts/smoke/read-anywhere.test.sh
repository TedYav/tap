#!/usr/bin/env bash
set -Eeuo pipefail
trap 'echo "read-anywhere failed at line $LINENO" >&2' ERR
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
FIX="$(mktemp -d)"; trap 'rm -rf "$FIX"' EXIT
export TAP_HOME="$FIX/alpha/.tap/bus" TAP_INDEX_HOME="$FIX/index"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$TAP_HOME/spool/digests" "$FIX/beta/.tap/bus/payloads" "$TAP_INDEX_HOME"
printf '{"schema": "0.20", "team":{"name":"alpha"},"seats":{}}' > "$TAP_HOME/registry.json"
printf '{"schema": "0.20", "team":{"name":"beta"},"seats":{}}' > "$FIX/beta/.tap/bus/registry.json"
# Born live (F1): both teams are enrolled in the machine index.
F="$(cd "$FIX" && pwd -P)"
printf '{"schema":"0.20","teams":{"alpha":{"root":"%s/alpha","registry_location":"%s/alpha/.tap/bus/registry.json","state":"registered"},"beta":{"root":"%s/beta","registry_location":"%s/beta/.tap/bus/registry.json","state":"registered"}}}' "$F" "$F" "$F" "$F" > "$TAP_INDEX_HOME/global-registry.json"
plant() { printf -- '---\nid: %s\nfrom: sender\nto: worker\nkind: discuss\nreply: expected\npath: %s/payloads/%s.md\n---\nbody-%s\n' "$2" "$1" "$2" "$2" > "$1/payloads/$2.md"; }
plant "$TAP_HOME" local-item
plant "$FIX/beta/.tap/bus" remote-item
python3 - "$TAP_HOME" <<'PY'
import json,sys
b=sys.argv[1]
json.dump({'kind':'digest','digest_id':'courier-batch','to':'worker','to_team':'alpha','items':[{'id':'local-item','from':'sender','kind':'discuss','reply':'expected','settled':False,'path':b+'/payloads/local-item.md'}]},open(b+'/spool/digests/courier-batch.json','w'))
PY
run() { bash "$ROOT/scripts/tap.sh" "$@"; }
run show local-item | grep body-local-item
run show remote-item | grep body-remote-item
run show beta/remote-item | grep body-remote-item
out="$(run show courier-batch)"
[[ "$out" == *'local-item'* && "$out" == *'reply=expected'* && "$out" == *'settled=false'* ]]
out="$(run read courier-batch --by worker --item local-item 2>&1)" || { echo "$out"; exit 1; }
[[ "$out" == *body-local-item* ]]
[ -f "$TAP_HOME/receipts/local-item.read" ]
[ ! -f "$TAP_HOME/receipts/local-item.done" ]
[ ! -f "$TAP_HOME/receipts/courier-batch.done" ]
[ ! -f "$TAP_HOME/receipts/courier-batch.read" ]
run read courier-batch --by worker >/dev/null
# Repeated forced envelope views retain first observation and audit each override.
cp "$TAP_HOME/receipts/courier-batch.read" "$FIX/first-read"
run read courier-batch --by other --force >/dev/null
run read courier-batch --by other --force >/dev/null
cmp "$FIX/first-read" "$TAP_HOME/receipts/courier-batch.read"
[ "$(grep -c 'action=read_forced.*id=courier-batch' "$TAP_HOME/registry-events.log")" = 2 ]
[ ! -f "$TAP_HOME/receipts/local-item.done" ]
run read courier-batch --by worker --all | grep body-local-item
run show "path=$TAP_HOME/spool/digests/courier-batch.json" --all | grep body-local-item
if out="$(run show absent 2>&1)"; then exit 1; fi
[[ "$out" == *"$TAP_HOME/payloads/absent.md"* && "$out" == *"$TAP_HOME/spool/digests/absent.json"* && "$out" == *"$FIX/beta/.tap/bus/payloads/absent.md"* ]]
# A foreign item cannot bypass the normal addressee gate, even under --all.
plant "$TAP_HOME" foreign-item
sed -i.bak 's/to: worker/to: other/' "$TAP_HOME/payloads/foreign-item.md"
python3 - "$TAP_HOME" <<'PYDATA'
import json,sys
b=sys.argv[1]; p=b+'/spool/digests/courier-batch.json'
d=json.load(open(p));d['items'].append({'id':'foreign-item','path':b+'/payloads/foreign-item.md','reply':'expected'})
json.dump(d,open(p,'w'))
PYDATA
if out="$(run read courier-batch --by worker --all 2>&1)"; then echo 'foreign read unexpectedly accepted'; exit 1; fi
[[ "$out" == *"not 'worker'"* ]]
[ ! -f "$TAP_HOME/receipts/foreign-item.read" ]
[ -f "$TAP_HOME/receipts/courier-batch.read" ]
# Exact local addresses win; an explicit team still selects the remote address.
plant "$FIX/beta/.tap/bus" local-item
out="$(run show local-item)"; [[ "$out" == *"$TAP_HOME/payloads/local-item.md"* ]]
out="$(run show beta/local-item)"; [[ "$out" == *"$FIX/beta/.tap/bus/payloads/local-item.md"* ]]
# Unindexed sender pointers still resolve; cancellation moves keep digest items readable.
run show retired/local-item "path=$TAP_HOME/payloads/local-item.md" | grep body-local-item
plant "$TAP_HOME" archived-item
mkdir -p "$TAP_HOME/archive"
python3 - "$TAP_HOME" <<'PYDATA'
import json,sys
b=sys.argv[1]; ident='courier-20260905T000000Z-aabbccddeeff'
json.dump({'kind':'digest','digest_id':ident,'to':'worker','to_team':'alpha','items':[{'id':'archived-item','path':b+'/payloads/archived-item.md'}]},open(b+'/spool/digests/'+ident+'.json','w'))
PYDATA
mv "$TAP_HOME/payloads/archived-item.md" "$TAP_HOME/archive/archived-item.cancelled.md"
out="$(run read courier-20260905T000000Z-aabbccddeeff --by worker --all)"
[[ "$out" == *'tap read: ask archived-item from=sender already settled; nothing owed'* && "$out" == *body-archived-item* ]]
[ ! -f "$TAP_HOME/receipts/archived-item.read" ]
[ ! -f "$TAP_HOME/receipts/archived-item.done" ]
run show aabbccddeeff | grep archived-item
plant "$TAP_HOME" sender-20260905T000001Z-aabbccddeeff
if out="$(run show aabbccddeeff 2>&1)"; then echo 'digest suffix collision accepted'; exit 1; fi
[[ "$out" == *'matches more than one payload'* ]]
# `tap_digest_sentinel` is gone with the digest transaction it served; it composed exactly
# these arguments for the native sentinel constructor. The property
# under test is unchanged: a digest sentinel carries its id and no `path=`.
sentinel="$("${TAP_SMOKE_BUN:-bun}" "$ROOT/runtime/bun/test/support/sentinel-render-cli.ts" alpha/courier alpha/worker courier-batch digest settle-only "" "$TAP_HOME/spool/digests/courier-batch.json")"
[[ "$sentinel" != *'path='* && "$sentinel" == *'courier-batch'* ]]
run show courier-batch | grep local-item
echo 'read-anywhere: PASS'
