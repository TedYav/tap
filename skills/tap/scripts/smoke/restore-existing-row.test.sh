#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
python3 -B - "$ROOT" "$WORK" <<'PY'
import hashlib, json, os, pathlib, subprocess, sys
root, scratch = map(pathlib.Path, sys.argv[1:])
for status in ('suspended', 'offline', 'active', 'pending', 'empty'):
 for as_json in (False, True):
  work=scratch/(status+str(as_json)); bus=work/'bus'; index=work/'index'
  archive=bus/'archive/teardown/saved-alice'
  archive.mkdir(parents=True); index.mkdir()
  row={} if status=='empty' else {'status':status,'delivery':'pane','status_reason':'session_stopped'}
  registry=work/'team-registry.json'
  registry.write_text(json.dumps({'schema':'0.20','team':{'name':'demo','worktree_root':str(work)},'seats':{'alice':row}}))
  (index/'v20-flip.json').write_text('{"version":1}')
  (index/'global-registry.json').write_text(json.dumps({'schema':'0.20','teams':{'demo':{'root':str(work),'registry_location':str(registry),'bus_home':str(bus)}}}))
  (archive/'meta.json').write_text('{"kind":"handle_teardown","handle":"alice"}')
  (archive/'registry-row.json').write_text('{"agent":{"status":"active","delivery":"pane"}}')
  for leaf in ('payloads','receipts','spool','input-backups','handoff','seat-state'):
   (archive/leaf).mkdir(); (archive/leaf/'retained').write_text('preserve '+leaf)
  for leaf,key in [('watch','blocked_map'),('goalie','seats')]:
   (archive/leaf).mkdir(); (archive/leaf/(key+'.alice.json')).write_text('{"alice":{"reason":"preserve"}}')
  def snapshot(path):
   return [(str(p.relative_to(path)),hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else 'dir') for p in sorted(path.rglob('*'))]
  before=snapshot(archive); reg_before=registry.read_bytes()
  env={**os.environ,'TAP_HOME':str(bus),'TAP_INDEX_HOME':str(index),'TAP_SESSION_MANIFEST':str(work/'sessions.json')}
  command=[str(root/'bin/tap'),'restore','alice','--archive',str(archive)]+(['--json'] if as_json else [])
  result=subprocess.run(command,cwd=work,env=env,text=True,capture_output=True)
  assert result.returncode==1,(status,as_json,result.returncode,result.stdout,result.stderr)
  assert snapshot(archive)==before,(status,'archive consumed')
  assert registry.read_bytes()==reg_before,(status,'row changed')
  assert not any((bus/leaf/'retained').exists() for leaf in ('payloads','receipts','spool','input-backups','handoff','seat-state')),(status,'restore moved an archived file')
  assert not (bus/'watch/arm.json').exists() and not (bus/'goalie/arm.json').exists(),(status,'restore merged supervision slices')
  if as_json:
   report=json.loads(result.stdout); assert report['error_class']=='handle_live'; assert 'tap teardown alice --yes' in report['action']
  else:
   assert 'handle_live' in result.stderr and 'tap teardown alice --yes' in result.stderr,result.stderr
  print('restore-existing-row:',status,'json='+str(as_json),'refuses before archive/row changes')
PY
