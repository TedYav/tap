#!/usr/bin/env bash
# D5: fixture-door — parked-mail-read.test.sh:72,155: the module references here only build or seed fixture state; every assertion is on the surrounding shell behavior, none on the module's own
# Parked mail is discoverable and recipient-readable without a pane effect.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
python3 -B - "$ROOT" <<'PY'
import json, os, pathlib, subprocess, sys, tempfile, time
root=pathlib.Path(sys.argv[1])
with tempfile.TemporaryDirectory() as tmp:
    fix=pathlib.Path(tmp)
    runtime='bun'
    team=fix/runtime; bus=team/'.tap/bus'; idx=team/'index'
    for name in ('payloads','spool','receipts'): (bus/name).mkdir(parents=True)
    idx.mkdir(); fake=team/'bin'; fake.mkdir(); log=team/'tmux.log'; trace=team/'route.log'
    (fake/'tmux').write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$PARKED_TMUX_LOG"\nexit 0\n')
    (fake/'tmux').chmod(0o755)
    reg=team/'.tap/team-registry.json'
    seats={h:{'status':'active','delivery':'poll','harness':'codex','instance':h+'|current','registered_at':'t'} for h in ('worker','other','sender')}
    reg.write_text(json.dumps({'schema':'0.20','team':{'name':'fixture'},'seats':seats}))
    (idx/'global-registry.json').write_text(json.dumps({'schema':'0.20','teams':{'fixture':{'root':str(team),'registry_location':str(reg)}}}))
    (bus/'registry.json').write_text(json.dumps({'schema': '0.20', 'team':{'name':'fixture','worktree_root':str(team)},'seats':seats}))
    env={**os.environ,'TAP_HOME':str(bus),'TAP_INDEX_HOME':str(idx),'TAP_SELF':'worker','TAP_SPOOL_DISABLE_DELIVERER':'1','PATH':str(fake)+':'+os.environ['PATH'],'PARKED_TMUX_LOG':str(log),'TAP_BUN_ROUTE_TRACE':str(trace)}
    def run(*args, actor='worker'):
        trace.unlink(missing_ok=True)
        return subprocess.run(['bash',str(root/'bin/tap'),*args],env={**env,'TAP_SELF':actor},text=True,capture_output=True)
    def seed(n, *, to='worker', instance='worker|current', target=None, to_team='', reply='settle-only', canonical=False):
        ident=f'sender-20260906T120000Z-{n:012x}'
        path=bus/('payloads' if canonical else 'spool')/(ident+'.md')
        path.write_text('\n'.join(['---',f'id: {ident}','from: sender',f'to: {to}','kind: discuss',f'path: {bus}/payloads/{ident}.md',f'reply: {reply}',f'recipient_instance: {instance}',f'to_team: {to_team}','---','','parked body '+ident,'']))
        if not canonical:
            (bus/'spool'/(ident+'.meta.json')).write_text(json.dumps({'id':ident,'target':to if target is None else target,'target_registry':str(reg),'to_team':'fixture','reason':'queued-input','reason_class':'busy','first_spooled_epoch':n,'deadline_epoch':1,'waiter_lifetime':'grace-window'}))
        return ident,path
    def fingerprint():
        return {str(p.relative_to(team)):(p.read_bytes(),p.stat().st_mtime_ns) for folder in (bus,idx/'locks') if folder.exists() for p in folder.rglob('*') if p.is_file()}
    canon,_=seed(1,canonical=True); own,path=seed(2); wrong,_=seed(3,to='other',instance='other|current'); old,_=seed(4,instance='worker|old'); foreign,_=seed(5,to_team='elsewhere')
    mismatch,_=seed(6,target='other')
    out=run('poll','worker','--json')
    assert out.returncode==2,(runtime,out.stdout,out.stderr)
    assert trace.read_text()=='native poll\n',trace.read_text()
    rows=json.loads(out.stdout)['pending']; ids=[r['id'] for r in rows]
    assert ids==[canon,own],(runtime,'parked visibility/team/instance/target gates',rows)
    parked=rows[1]; assert parked['residency']=='parked' and parked['reason']=='queued-input',parked
    human=run('poll','worker'); assert own in human.stdout and 'queued' in human.stdout and 'deliver-by' not in human.stdout,human
    # Immutable refusals preserve bus bytes and the index-owned obligation locks.
    for ident,args in ((wrong,()),(old,()),(old,('--force',)),(foreign,('--force',)),(mismatch,())):
        before=fingerprint(); refused=run('read',ident,*args)
        assert refused.returncode!=0,(runtime,'unauthorized read',ident,refused.stdout)
        assert fingerprint()==before,(runtime,'immutable refusal mutated bus',ident,refused.stderr)
    # A claim is never stolen, even if its timestamp is stale.
    claim=bus/'spool'/(own+'.claim'); claim.write_text('{"owner_pid":1}')
    os.utime(claim,(1,1)); before=fingerprint(); busy=run('read',own)
    assert busy.returncode!=0 and 'claimed' in busy.stderr,(runtime,busy.stdout,busy.stderr)
    assert path.exists() and claim.read_text()=='{"owner_pid":1}',runtime
    assert not (bus/'receipts'/(own+'.done')).exists()
    claim.unlink(); original=path.read_bytes()
    read=run('read',own); assert read.returncode==0,(runtime,read.stdout,read.stderr)
    assert trace.read_text()=='native read\n',trace.read_text()
    assert 'parked body '+own in read.stdout
    assert (bus/'payloads'/(own+'.md')).read_bytes()==original
    assert not path.exists() and not (bus/'spool'/(own+'.meta.json')).exists()
    receipt=bus/'receipts'/(own+'.done'); assert json.loads(receipt.read_text())['via']=='read'
    before=receipt.read_bytes(),receipt.stat().st_mtime_ns
    dup=run('read',own); assert dup.returncode==0 and (receipt.read_bytes(),receipt.stat().st_mtime_ns)==before
    assert trace.read_text()=='native read\n',trace.read_text()
    for suffix in ('attempted','placed','sent','read'): assert not (bus/'receipts'/(own+'.'+suffix)).exists(),suffix
    ask,askpath=seed(7,reply='expected'); answer=run('read',ask)
    assert answer.returncode==0,(runtime,answer.stderr)
    assert (bus/'receipts'/(ask+'.read')).exists() and not (bus/'receipts'/(ask+'.done')).exists()
    # A LIVE claim held by a real claimant is contention the reader waits
    # through (tap-4b7ib): the read settles exactly once after the handoff.
    w2,w2path=seed(21)
    spool_dir=str(bus/'spool'); sidecar=str(root/'runtime/bun/src/spool-sidecar.ts')
    holding=team/'claim-holding'; release2=team/'claim-release'
    holder=subprocess.Popen(['bash','-c',
        'until bun "$1" claim "$2" "$3" no-steal >/dev/null 2>&1; do sleep 0.02; done\n'
        'touch "$4"\n'
        'until [ -e "$5" ]; do sleep 0.02; done\n'
        'bun "$1" release "$2" "$3" >/dev/null 2>&1\n',
        'holder',sidecar,spool_dir,w2,str(holding),str(release2)])
    try:
        end=time.time()+8
        while not holding.exists() and holder.poll() is None and time.time()<end: time.sleep(.02)
        assert holding.exists(),(runtime,'claim holder never acquired its claim')
        reading=subprocess.Popen(['bash',str(root/'bin/tap'),'read',w2],env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        time.sleep(2)
        assert reading.poll() is None,(runtime,'read did not wait on a live claim',reading.communicate(timeout=5))
        assert not (bus/'receipts'/(w2+'.done')).exists(),(runtime,'settled while another claim held')
        release2.touch()
        out,err=reading.communicate(timeout=8)
        assert reading.returncode==0,(runtime,out,err)
        assert (bus/'receipts'/(w2+'.done')).exists() and not w2path.exists(),(runtime,'handoff custody broken')
    finally:
        release2.touch()
        if holder.poll() is None: holder.terminate(); holder.communicate(timeout=5)
    # An ASK under a live claim keeps the incumbent behavior: no bounded
    # wait, no receipt at all — the handoff belongs to settle-only notes.
    ask2,ask2path=seed(26,reply='expected')
    ask_hold=team/'ask-holding'; ask_rel=team/'ask-release'
    ask_holder=subprocess.Popen(['bash','-c',
        'until bun "$1" claim "$2" "$3" no-steal >/dev/null 2>&1; do sleep 0.02; done\n'
        'touch "$4"\n'
        'until [ -e "$5" ]; do sleep 0.02; done\n'
        'bun "$1" release "$2" "$3" >/dev/null 2>&1\n',
        'holder',sidecar,spool_dir,ask2,str(ask_hold),str(ask_rel)])
    try:
        end=time.time()+8
        while not ask_hold.exists() and ask_holder.poll() is None and time.time()<end: time.sleep(.02)
        assert ask_hold.exists(),(runtime,'ask claim holder never acquired its claim')
        before_ask=ask2path.read_bytes()
        t0=time.time(); busy3=run('read',ask2); dt=time.time()-t0
        assert busy3.returncode!=0 and 'claimed' in busy3.stderr,(runtime,'ask under live claim',busy3.stdout,busy3.stderr)
        assert dt<3,(runtime,'ask waited on a live claim',dt)
        assert ask2path.read_bytes()==before_ask,(runtime,'ask refusal mutated parked bytes')
        assert not (bus/'receipts'/(ask2+'.done')).exists() and not (bus/'receipts'/(ask2+'.read')).exists(),(runtime,'ask receipt written under claim')
    finally:
        ask_rel.touch()
        if ask_holder.poll() is None: ask_holder.terminate(); ask_holder.communicate(timeout=5)
    # Broken evidence is not contention: each refusal is immediate (no wait
    # at the ceiling) and leaves the queue bytes exactly as they were.
    def refused_fast(ident,label,path_p):
        before_payload=path_p.read_bytes()
        t0=time.time(); r=run('read',ident)
        assert r.returncode!=0 and 'claimed' in r.stderr,(runtime,label,r.stdout,r.stderr)
        assert time.time()-t0<3,(runtime,label,'waited on a broken claim')
        assert path_p.read_bytes()==before_payload,(runtime,label,'mutated parked bytes')
        assert not (bus/'receipts'/(ident+'.done')).exists(),(runtime,label,'settled a broken claim')
    m1,m1path=seed(22)
    (bus/'spool'/(m1+'.claim')).write_text('{"owner_pid": "junk", ')
    refused_fast(m1,'malformed claim bytes',m1path)
    m2,m2path=seed(23)
    (bus/'spool'/(m2+'.claim')).mkdir()
    refused_fast(m2,'non-regular claim',m2path)
    m3,m3path=seed(24)
    claim_u=bus/'spool'/(m3+'.claim')
    claim_u.write_text('{"v": 1, "id": "'+m3+'", "owner_pid": 7, "claimed_at_epoch": 9999999999}\n')
    claim_u.chmod(0)
    try: refused_fast(m3,'unreadable claim',m3path)
    finally: claim_u.chmod(0o644); claim_u.unlink()
    # A live claim that never hands off is refused at the same ceiling as the
    # obligation lock — bounded, never stolen, nothing settled.
    w4,w4path=seed(25)
    claim_k=bus/'spool'/(w4+'.claim')
    claim_k.write_text('{"v": 1, "id": "'+w4+'", "owner_pid": 7, "claimed_at_epoch": '+str(int(time.time()))+'}\n')
    t0=time.time(); busy2=run('read',w4); dt=time.time()-t0
    assert busy2.returncode!=0 and 'claimed' in busy2.stderr,(runtime,'ceiling',busy2.stdout,busy2.stderr)
    assert 4<=dt<=12,(runtime,'ceiling wait not at the lock scale',dt)
    assert w4path.exists() and claim_k.read_text().startswith('{"v": 1'),(runtime,'ceiling refusal mutated custody')
    assert not (bus/'receipts'/(w4+'.done')).exists(),(runtime,'ceiling refusal settled')
    claim_k.unlink()
    # Pause the actual waiter in its sleep, adopt, then let it observe removal.
    wait_id,wait_path=seed(9)
    meta_path=bus/'spool'/(wait_id+'.meta.json'); meta=json.loads(meta_path.read_text())
    meta.update(deadline_epoch=time.time()+60,first_spooled_epoch=time.time())
    meta_path.write_text(json.dumps(meta))
    waiter=subprocess.Popen(['bun',str(root/'runtime/bun/src/spool-waiter.ts'),wait_id],env={**env,'TAP_SPOOL_DELIVERER_DELAYS':'2'},stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    try:
        end=time.time()+8
        while 'next_probe_epoch' not in json.loads(meta_path.read_text()) and waiter.poll() is None and time.time()<end: time.sleep(.02)
        assert 'next_probe_epoch' in json.loads(meta_path.read_text()),(runtime,'waiter did not schedule delay',waiter.poll())
        read=run('read',wait_id); assert read.returncode==0,(runtime,read.stderr)
        output=waiter.communicate(timeout=8)
        assert waiter.returncode==0 and not wait_path.exists(),(runtime,output)
    finally:
        if waiter.poll() is None: waiter.terminate(); waiter.communicate(timeout=5)
    # Queue custody consumes reset restore eligibility independently of receipts.
    generation=bus/'reset-generation.json'
    repeated,repeated_path=seed(11,reply='expected')
    seen=bus/'receipts'/(repeated+'.read'); seen.write_text(json.dumps({'id':repeated,'by':'worker','at':'2026-09-06T12:00:00Z'}))
    first_seen=seen.read_bytes(),seen.stat().st_mtime_ns
    generation.write_text(json.dumps({'bundle_id':'parked-fixture','state':'pristine'}))
    read=run('read',repeated); assert read.returncode==0,(runtime,read.stderr)
    assert not repeated_path.exists() and (bus/'payloads'/(repeated+'.md')).exists()
    assert (seen.read_bytes(),seen.stat().st_mtime_ns)==first_seen
    assert json.loads(generation.read_text())['state']=='reused',(runtime,'existing read left generation pristine')
    obstructed,obstructed_path=seed(12,reply='expected')
    receipts=bus/'receipts'; saved_receipts=team/'saved-receipts'
    receipts.rename(saved_receipts); receipts.write_text('obstructed')
    generation.write_text(json.dumps({'bundle_id':'parked-fixture','state':'pristine'}))
    try:
        read=run('read',obstructed)
        assert read.returncode!=0 and 'receipts directory' in read.stderr,(runtime,read.stdout,read.stderr)
        assert not obstructed_path.exists() and (bus/'payloads'/(obstructed+'.md')).exists()
        assert json.loads(generation.read_text())['state']=='reused',(runtime,'failed receipt left generation pristine')
    finally:
        receipts.unlink(); saved_receipts.rename(receipts)
    # Exact canonical bytes win when an old spool sibling coexists.
    both,bothpath=seed(8); canonical=bus/'payloads'/(both+'.md'); canonical.write_bytes(bothpath.read_bytes().replace(b'parked body',b'canonical body'))
    saved=canonical.read_bytes(); read=run('read',both)
    assert read.returncode==0 and canonical.read_bytes()==saved and 'canonical body' in read.stdout
    # Outbound keeps its sender semantics and still exposes sender-owned parks.
    outbound=run('outstanding','sender','--json',actor='sender')
    assert wrong in outbound.stdout,(runtime,outbound.stdout,outbound.stderr)
    bad,badpath=seed(10,canonical=True)
    badpath.write_text('invalid envelope\n')
    mixed=run('poll','worker')
    assert mixed.returncode==2 and mixed.stdout.index(canon)<mixed.stdout.index('quarantined'),(runtime,mixed.stdout,mixed.stderr)
    transcript=log.read_text() if log.exists() else ''
    assert 'send-keys' not in transcript and 'select-pane' not in transcript,(runtime,transcript)
    print('parked-mail-read:',runtime,'visibility, refusal, claim handoff, broken-claim refusals, byte custody, ask/note, duplicate and zero pane effects: ok')
PY
