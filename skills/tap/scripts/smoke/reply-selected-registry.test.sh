#!/usr/bin/env bash
# tap-mxf95: a globally located ask does not prove its actor is in the cwd team.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/runtime/bun/main.ts"
tap_cmd() { bun "$TAP" "$@"; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TAP_INDEX_HOME="$WORK/index" TAP_SPOOL_DISABLE_DELIVERER=1
unset TAP_HOME TAP_SELF TMUX TMUX_PANE
mkdir -p "$WORK/ancestor/trees/lane" "$WORK/index"
python3 - "$WORK" <<'PY'
import json,pathlib,sys
w=pathlib.Path(sys.argv[1]); teams={}
for name,root,seats in [('ancestor',w/'ancestor',{}),('primary',w/'primary',{
 'driver':{'status':'active','delivery':'poll','instance':'driver|launcher'},
 'leader':{'status':'active','delivery':'poll','instance':'leader|original'}})]:
 bus=root/'.tap/bus'; (bus/'payloads').mkdir(parents=True); (bus/'receipts').mkdir()
 reg=root/'.tap/team-registry.json'
 reg.write_text(json.dumps({'schema':'0.20','team':{'name':name,'worktree_root':str(root)},'seats':seats}))
 teams[name]={'root':str(root),'registry_location':str(reg),'state':'registered'}
(w/'index/global-registry.json').write_text(json.dumps({'schema':'0.20','teams':teams}))
p=w/'primary/.tap/bus/payloads/leader-20260907T000000Z-123456789abc.md'
p.write_text(f'---\nid: {p.stem}\nfrom: leader\nto: driver\nreply: expected\nkind: order\nrecipient_instance: driver|launcher\nsender_instance: leader|original\npath: {p}\n---\nwork\n')
(w/'answer.md').write_text('completed work\n')
PY
ID=leader-20260907T000000Z-123456789abc
cd "$WORK/ancestor/trees/lane"
rc=0
tap_cmd reply "$ID" --by driver -f "$WORK/answer.md" >"$WORK/wrong.out" 2>&1 || rc=$?
[ "$rc" != 0 ] || { echo 'wrong-team reply unexpectedly succeeded'; exit 1; }
[ ! -f "$WORK/primary/.tap/bus/receipts/$ID.done" ] || exit 1
cat "$WORK/wrong.out"
# Both public read routes refuse --force when the actor identity is unresolved.
for route in native bash; do
 rc=0
 if [ "$route" = native ]; then
  TAP_SELF=driver tap_cmd read "$ID" --force >"$WORK/force.out" 2>&1 || rc=$?
 else
  TAP_HOME="$WORK/ancestor/.tap/bus" bash "$ROOT/scripts/tap.sh" read "$ID" --by driver --force >"$WORK/force.out" 2>&1 || rc=$?
 fi
 [ "$rc" != 0 ] || { cat "$WORK/force.out"; echo "$route force accepted unresolved identity"; exit 1; }
 rg -q 'has no verified instance in selected team' "$WORK/force.out" || { cat "$WORK/force.out"; exit 1; }
 [ ! -e "$WORK/primary/.tap/bus/receipts/$ID.read" ] && [ ! -e "$WORK/primary/.tap/bus/receipts/$ID.done" ] || exit 1
done
python3 - "$WORK" "$ID" <<'NO_EFFECT'
import pathlib,sys
w=pathlib.Path(sys.argv[1]); ident=sys.argv[2]
assert list((w/'ancestor/.tap/bus/payloads').glob('*.md')) == []
assert [p.stem for p in (w/'primary/.tap/bus/payloads').glob('*.md')] == [ident]
NO_EFFECT
# Recovery must reach the actual reply/settlement effect with the unchanged instance.
tap_cmd reply "$ID" --team primary --by driver -f "$WORK/answer.md" >"$WORK/recovered.out" 2>&1 || { cat "$WORK/recovered.out"; exit 1; }
[ -f "$WORK/primary/.tap/bus/receipts/$ID.done" ] || { cat "$WORK/recovered.out"; exit 1; }
python3 - "$WORK" "$ID" <<'PY'
import json,pathlib,sys
w=pathlib.Path(sys.argv[1]); ident=sys.argv[2]
r=json.loads((w/'primary/.tap/team-registry.json').read_text())
assert r['seats']['driver']['instance']=='driver|launcher',r
receipt=json.loads((w/f'primary/.tap/bus/receipts/{ident}.done').read_text())
assert receipt['by']=='driver' and receipt['via']=='reply',receipt
PY
# A missing actor is unresolved identity, never proof of a replaced instance.
if ! rg -q 'has no verified instance in selected team' "$WORK/wrong.out"; then
 echo 'RED: missing selected-team actor mislabeled as an instance mismatch'; exit 1
fi
if rg -q 'next: tap cancel' "$WORK/wrong.out"; then
 echo 'RED: impossible sender cancel offered for wrong-cwd recipient'; exit 1
fi
# Same selected team, genuinely different current instance: keep the old refusal.
python3 - "$WORK" "$ID" <<'PY2'
import json,pathlib,sys
w=pathlib.Path(sys.argv[1]); ident=sys.argv[2]
bus=w/'primary/.tap/bus'
(bus/f'receipts/{ident}.done').unlink()
p=w/'primary/.tap/team-registry.json'
r=json.loads(p.read_text());r['seats']['driver']['instance']='driver|replacement'
p.write_text(json.dumps(r))
PY2
rc=0
tap_cmd reply "$ID" --team primary --by driver -f "$WORK/answer.md" >"$WORK/replaced.out" 2>&1 || rc=$?
[ "$rc" != 0 ] && [ ! -f "$WORK/primary/.tap/bus/receipts/$ID.done" ] || exit 1
rg -q "not the current 'driver' instance" "$WORK/replaced.out"
rg -q "tap cancel $ID --by leader" "$WORK/replaced.out"
echo 'reply-selected-registry: wrong-team refusal, explicit-team recovery, real mismatch refusal verified' 
