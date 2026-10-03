#!/usr/bin/env bash
# .64: public provenance evidence and no-write controls, through both entry doors.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
python3 -B - "$ROOT" "$WORK" <<'PY'
import hashlib, json, os, pathlib, subprocess, sys, time
root, work = map(pathlib.Path, sys.argv[1:])
state = work/'state'; state.mkdir(); (state/'home').mkdir()
alpha=state/'alpha'; beta=state/'beta'; index=state/'index'; index.mkdir()
for team in (alpha,beta):
    for leaf in ('bus/payloads','bus/receipts','team-history'):
        (team/'.tap'/leaf).mkdir(parents=True,exist_ok=True)
now=int(time.time()); ident='alice-20260905T010101Z-aaaaaaaaaaaa'
row={'instance':'alice|current','harness':'codex','model':'gpt-6-astra','status':'active','delivery':'poll','registered_at':'2026-09-05T00:00:00Z'}
def dump(p,v): p.write_text(json.dumps(v))
def registry(team,entry):
    dump(team/'.tap/team-registry.json', {'team':{'name':team.name,'worktree_root':str(team)},'schema':'0.20','seats':{'alice':entry}})
registry(alpha,row); registry(beta,{**row,'instance':'alice|beta'})
dump(index/'global-registry.json',{'schema':'0.20','teams':{t.name:{'root':str(t),'registry_location':str(t/'.tap/team-registry.json')} for t in (alpha,beta)}})
# The marker-selected index, not a decoy legacy teams file, supplies authority.
dump(index/'teams.json',{'teams':{}})
marker=index/'v20-flip.json'; dump(marker,{'version':1})
env={**os.environ,'HOME':str(state/'home'),'TAP_HOME':str(alpha/'.tap/bus'),'TAP_INDEX_HOME':str(index),'TAP_FLIP_MARKER':str(marker),
'TAP_SESSION_MANIFEST':str(state/'sessions.json'),'OPENCODE_DB_PATH':str(state/'opencode.db'),
'TAP_VERSION_SEEN_PATH':str(state/'version.json'),'XDG_CONFIG_HOME':str(state/'xdg'),'PYTHONDONTWRITEBYTECODE':'1'}
env.pop('TMUX',None); env.pop('TMUX_PANE',None)
def payload(team=alpha, instance='alice|current', sender='alice', extra=''):
    p=team/'.tap/bus/payloads'/f'{ident}.md'
    p.write_text(f'---\nid: {ident}\nfrom: {sender}\nto: worker\nkind: discuss\nreply: expected\npath: {p}\n'+(f'sender_instance: {instance}\n' if instance else '')+extra+'---\n20/20 complete\n')
    return p
p=payload(); receipts=alpha/'.tap/bus/receipts'
def receipt(kind,value): dump(receipts/f'{ident}.{kind}',value)
def snapshot():
    result=[]
    for p in sorted(state.rglob('*')):
        st=p.lstat(); result.append((str(p.relative_to(state)),st.st_mtime_ns, hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else 'dir'))
    return result
LIMIT='not a security boundary'
for door in ('bun','direct'):
    entry=[str(root/'bin/tap')] if door!='direct' else ['bash',str(root/'scripts/tap.sh')]
    trace=work/('route-'+door);env['TAP_BUN_ROUTE_TRACE']=str(trace)
    def run(ref=ident,verb='provenance',ok=True,leading=(),trailing=(),fixture_rebind=False):
        before=snapshot()
        result=subprocess.run([*entry,*leading,verb,ref,'--json',*trailing],env=env,text=True,capture_output=True,timeout=40)
        after=snapshot()
        if fixture_rebind:
            # The fake timestamp observer changes exactly this fixture row to test the final recheck.
            before=[entry for entry in before if entry[0]!='alpha/.tap/team-registry.json']
            after=[entry for entry in after if entry[0]!='alpha/.tap/team-registry.json']
        assert after==before, (door,verb,'state changed',set(after)^set(before),result.stderr)
        assert result.returncode==(0 if ok else 1),(door,verb,result.returncode,result.stdout,result.stderr)
        if not ok:return
        report=json.loads(result.stdout)
        assert LIMIT in report['limits'],report
        assert not any(k in report for k in ('trusted','authentic','processed')),report
        return report
    registry(alpha,row); payload()
    for f in receipts.iterdir():f.unlink()
    receipt('placed',{'id':ident,'via':'courier','at':'2026-09-05T01:01:02Z'})
    report=run(leading=('--verbose','-v')); assert report['verdict']=='record-match',report
    assert run(verb='who')['verdict']=='record-match'
    (receipts/f'{ident}.placed').unlink()
    assert run()['verdict']=='unbound-sender'
    receipt('sent',{'id':ident,'from':'alice','to':'worker','kind':'discuss','delivery':'poll','turn':'unconfirmed'})
    report=run(); assert report['verdict']=='record-match'; assert report['receipts']['sent']['status']=='present'
    assert not report['receipts']['sent'].get('at'),report
    payload(instance='alice|old'); assert run()['verdict']!='record-match'
    dump(alpha/'.tap/team-history/alice.old.json',{'handle':'alice','instance':'alice|old','retired_at':'2026-09-05T00:00:00Z','seat':row})
    assert run()['verdict']=='retired-instance'
    registry(alpha,{**row,'instance':'alice|old'}); assert run()['verdict']=='record-match'
    registry(alpha,row); payload(instance=''); assert run()['verdict']=='unbound-sender'
    payload(sender='missing'); assert run()['verdict']=='unknown-sender'
    payload(extra='from_team: beta\n'); assert run()['verdict']!='record-match'
    receipt('placed',{'id':ident,'via':'courier','at':'2026-09-05T01:01:02Z'})
    payload(instance='alice|beta',extra='from_team: beta\n'); assert run()['verdict']=='record-match'
    payload(); registry(alpha,{**row,'status':'suspended'})
    dump(alpha/'.tap/team-history/alice.restored.json',{'handle':'alice','instance':'alice|current','retired_at':'2026-09-05T00:00:00Z','row':row})
    report=run(); assert report['sender']['current_match'] and report['verdict']!='retired-instance'
    registry(alpha,row)
    (receipts/f'{ident}.placed').unlink()
    receipt('sent',{'id':ident,'from':'alice','to':'worker','kind':'discuss','delivery':'not-a-transport','turn':'unconfirmed'})
    report=run(); assert report['receipts']['sent']['status']=='malformed' and report['verdict']!='record-match'
    receipt('sent',{'id':ident,'from':'alice','to':'worker','delivery':'poll','turn':'unconfirmed'})
    report=run(); assert report['receipts']['sent']['status']=='malformed' and report['verdict']!='record-match'
    before=snapshot()
    text_report=subprocess.run([*entry,'provenance',ident],env=env,text=True,capture_output=True)
    assert text_report.returncode==0 and LIMIT in text_report.stdout and 'malformed' in text_report.stdout
    assert snapshot()==before
    payload(); assert run('aaaaaaaaaaaa')['id']==ident
    payload(beta,instance='alice|beta'); assert run('beta/'+ident)['sender']['team']=='beta'
    assert run(trailing=('--team','beta'))['sender']['team']=='beta'
    assert run(trailing=('--team','beta'))['sender']['same_team_as_caller'] is True
    # Same suffix on distinct buses is ambiguous, even when full ids coincide.
    run('aaaaaaaaaaaa',ok=False)
    (beta/'.tap/bus/payloads'/f'{ident}.md').unlink()
    receipt('placed',{'id':'wrong','via':'courier'}); report=run(); assert report['receipts']['placed']['status']=='malformed'
    receipt('read',{'id':ident,'by':'worker','at':'2026-09-05T01:02:00Z','identity':'declared'})
    receipt('done',{'id':ident,'by':'worker','via':'courier-auto','status':'done','at':'2026-09-05T01:03:00Z'})
    receipt('cancelled',{'id':ident,'by':'alice','via':'cancelled','at':'2026-09-05T01:04:00Z'})
    report=run(); assert report['receipts']['done']['via']=='courier-auto'; assert report['receipts']['cancelled']['via']=='cancelled'
    # Closeout prose never credits either of two unreceived messages.
    for f in receipts.iterdir():f.unlink()
    report=run(); assert report['receipts']['read']['status']=='missing' and report['receipts']['done']['status']=='missing'
    second=ident.replace('aaaaaaaaaaaa','dddddddddddd')
    second_path=p.with_name(second+'.md');second_path.write_text(p.read_text().replace(ident,second))
    second_report=run(second)
    assert second_report['receipts']['read']['status']=='missing' and second_report['receipts']['done']['status']=='missing'
    second_path.unlink()
    assert report['session_age']['seconds'] is None, report
    run('no-such-id',ok=False)
    # Envelope/file mismatch is an input error, not an unknown sender report.
    p.write_text(p.read_text().replace('id: '+ident,'id: wrong'))
    run(ok=False)
    payload(); registry(alpha,row)
    # Age comes from a generation-checked pane observation, not registration time.
    fake=work/'bin';fake.mkdir(exist_ok=True)
    tmux=fake/'tmux'
    tmux.write_text("""#!/usr/bin/env bash
case "$1" in
 list-sessions) printf 'T/seat\\t4242:99\\t1\\n' ;;
 list-panes)
   pane="${FAKE_PANE_ID:-%11}"
   if [ -n "${FAKE_DRIFT_MARKER:-}" ] && [ -e "$FAKE_DRIFT_MARKER" ]; then pane=%12; fi
   printf 'T/seat\\tT/seat:0.0\\t%s\\tcodex\\t111\\t4242:99\\t0\\n' "$pane" ;;
 display-message)
   if [ -n "${FAKE_DRIFT_MARKER:-}" ]; then touch "$FAKE_DRIFT_MARKER"; fi
   if [ -n "${FAKE_REBIND_REGISTRY:-}" ]; then
     python3 -B -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["seats"]["alice"]["instance"]="alice|changed"; open(p,"w").write(json.dumps(d))' "$FAKE_REBIND_REGISTRY"
   fi
   printf '%s\\n' "$FAKE_CREATED" ;;
 *) exit 0 ;;
esac
""")
    tmux.chmod(0o755)
    env.update(PATH=str(fake)+':'+os.environ['PATH'],TAP_BOOT_ID='boot:1',TAP_SERVER_EPOCH='4242:99',FAKE_CREATED=str(int(time.time())-3600))
    pane_row={**row,'delivery':'pane','pane':'T/seat:0.0','pane_id':'%11','session':'T/seat','server_epoch':'4242:99','boot_id':'boot:1'}
    receipt('placed',{'id':ident,'via':'courier','at':'2026-09-05T01:01:02Z'})
    registry(alpha,pane_row)
    age=run()['session_age']; assert 3590<=age['seconds']<=3610,age
    registry(alpha,{**pane_row,'registered_at':'2026-09-05T09:00:00Z'})
    assert abs(run()['session_age']['seconds']-age['seconds'])<10
    env['FAKE_PANE_ID']='%12';assert run()['session_age']['seconds'] is None
    env.pop('FAKE_PANE_ID');env['FAKE_CREATED']=str(int(time.time())+3600);assert run()['session_age']['seconds'] is None
    env['FAKE_CREATED']='';assert run()['session_age']['seconds'] is None
    env['FAKE_CREATED']=str(int(time.time())-3600)
    env['FAKE_DRIFT_MARKER']=str(work/'identity-drift')
    assert run()['session_age']['seconds'] is None
    assert (work/'identity-drift').exists()
    (work/'identity-drift').unlink();env.pop('FAKE_DRIFT_MARKER')
    env['FAKE_REBIND_REGISTRY']=str(alpha/'.tap/team-registry.json')
    expected_registry=json.loads((alpha/'.tap/team-registry.json').read_text())
    expected_registry['seats']['alice']['instance']='alice|changed'
    assert run(fixture_rebind=True)['session_age']['seconds'] is None
    assert json.loads((alpha/'.tap/team-registry.json').read_text())==expected_registry
    env.pop('FAKE_REBIND_REGISTRY');registry(alpha,pane_row)
    registry(alpha,row)
    # The selected registry's adjacent history, including a relocated registry.
    relocated=state/'relocated';relocated.mkdir(exist_ok=True)
    relocated_registry=relocated/'registry.json'; relocated_history=relocated/'team-history';relocated_history.mkdir(exist_ok=True)
    relocated_registry.write_bytes((alpha/'.tap/team-registry.json').read_bytes())
    saved_index=(index/'global-registry.json').read_bytes()
    selected=json.loads(saved_index);selected['teams']['alpha']['registry_location']=str(relocated_registry)
    dump(index/'global-registry.json',selected)
    dump(relocated_history/'alice.old.json',{'handle':'alice','instance':'alice|relocated','retired_at':'2026-09-05T00:00:00Z'})
    payload(instance='alice|relocated');assert run()['verdict']=='retired-instance'
    payload(instance='alice|old');assert run()['verdict']=='conflict'
    (index/'global-registry.json').write_bytes(saved_index);payload()
    # Invalid and unreachable evidence cannot silently look like an enrolled match.
    selected=json.loads(saved_index)
    selected['teams']['alpha']['registry_location']=str(alpha/'.tap/team-registry.json/not-a-directory')
    dump(index/'global-registry.json',selected)
    report=run();assert report['bus']['authority']=='live_unreachable' and report['verdict']=='unknown-sender' and report['reasons'],report
    (index/'global-registry.json').write_bytes(saved_index)
    dump(index/'global-registry.json',{'schema':'wrong','teams':{}})
    assert run()['bus']['authority']=='invalid'
    (index/'global-registry.json').write_bytes(saved_index)
    (alpha/'.tap/team-registry.json').unlink()
    assert run()['bus']['authority']=='live_unreachable'
    registry(alpha,{'not-a-seat':True})
    report=run();assert report['verdict']=='retired-instance' and report['sender']['current_match'] is False,report
    registry(alpha,row)
    # Frontmatter uses the Python scanner's whitespace/duplicate/newline grammar.
    payload(extra='from_team:beta\n');assert run()['sender']['team']=='alpha'
    p.write_bytes(p.read_bytes().replace(b'\n',b'\r\n'));assert run()['sender']['team']=='alpha'
    payload(extra='id: wrong\n');run(ok=False);payload()
    # Explicit native grammar, independently expected; not Python-version-derived.
    stamps={True:['2026-09-05T01:01:02Z','2026-09-05T01:01:02.123Z',
        '2026-09-05T01:01:02.123456+00:00','2026-09-05 01:01:02-0700',
        '2026-09-05T01:01:02,5+23:59','2026-09-05T01:01:02.123456789-23:59',
        '2000-02-29T00:00:00Z','2024-02-29T23:59:59Z','0001-01-01T00:00:00Z','9999-12-31T23:59:59Z'],
        False:['20260905T010102Z','2026-W36-6T01:01:02+00:00','2026-09-05☃01:01:02+00:00',
        '2026-09-05T01:01:02+00:00:30.5','2026-09-05T24:00:00Z','2026-09-05T01:01:02+24:00',
        '2026-09-05T01:01:02+00:60','2026-09-05T01:01:60Z','2026-09-05T01:60:00Z',
        '2026-09-05T01:01:02','2026-09-05','2026-09-05T01:01:02Z\n',
        '2026-02-30T00:00:00Z','1900-02-29T00:00:00Z','2026-02-29T00:00:00Z',
        '2026-13-01T00:00:00Z','2026-00-01T00:00:00Z','2026-01-00T00:00:00Z',
        '0000-01-01T00:00:00Z','Sep 5, 2026','not-a-time']}
    for valid,values in stamps.items():
        for stamp in values:
            receipt('placed',{'id':ident,'via':'courier','at':stamp})
            report=run()
            assert (report['receipts']['placed']['status']=='present')==valid,(stamp,report)
            assert report['verdict']==('record-match' if valid else 'unbound-sender'),(stamp,report)
            if not valid:assert 'receipt timestamp' in report['receipts']['placed']['reason']
    receipt('sent',{'id':ident,'from':'alice','to':'worker','kind':'discuss','delivery':'poll','turn':'unconfirmed','at':'not-a-time'})
    report=run();assert report['receipts']['sent']['status']=='present' and 'at' not in report['receipts']['sent']
    (receipts/f'{ident}.sent').unlink()
    receipt('placed',{'id':ident,'via':'courier','at':'2026-09-05T01:01:02Z','epoch':9007199254740993,'reason':'café 😀'})
    assert run()['receipts']['placed']['epoch']==9007199254740993
    assert run()['receipts']['placed']['reason']=='café 😀'
    # Optional malformed authority stays reportable but cannot match.
    (alpha/'.tap/team-registry.json').write_text('{broken')
    assert run()['verdict']!='record-match'
    registry(alpha,row)
    outside=state/'unlisted';(outside/'payloads').mkdir(parents=True,exist_ok=True)
    unlisted=outside/'payloads'/f'{ident}.md';unlisted.write_text(p.read_text())
    assert run('path='+str(unlisted))['verdict']=='unenrolled-bus'
    digest_dir=alpha/'.tap/bus/spool/digests';digest_dir.mkdir(parents=True,exist_ok=True)
    digest_id='courier-20260905T010101Z-bbbbbbbbbbbb'
    dump(digest_dir/(digest_id+'.json'),{'digest_id':digest_id,'kind':'digest','from':'alpha/courier','items':[{'id':ident,'from':'alice','path':str(p)}]})
    dump(receipts/(digest_id+'.done'),{'id':digest_id,'by':'worker','via':'courier-auto','at':'2026-09-05T01:04:00Z'})
    report=run(digest_id); assert report['sender']['handle']=='courier'
    assert report['members']==[{'id':ident,'from':'alice','path':str(p)}],report
    assert run()['id']==ident and run(verb='who')['id']==ident
    assert trace.exists() and 'native provenance' in trace.read_text() and 'native who' in trace.read_text(), 'native router was not exercised'
    assert 'bash provenance' not in trace.read_text() and 'bash who' not in trace.read_text(), 'deleted command fallback was reached'
print('provenance: native and direct-shell doors preserve identity, history, receipts and state snapshots')
PY
