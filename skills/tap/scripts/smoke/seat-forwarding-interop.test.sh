#!/usr/bin/env bash
# Bash routing and parked/foreign custody use the same pinned native grants.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
python3 -B - "$ROOT" <<'PY'
import json, os, pathlib, subprocess, sys, tempfile

root = pathlib.Path(sys.argv[1])
with tempfile.TemporaryDirectory() as tmp:
    fix = pathlib.Path(tmp); team = fix/'team'; bus = team/'.tap/bus'; index = fix/'index'
    for directory in (bus/'payloads', bus/'receipts', bus/'spool', index): directory.mkdir(parents=True)
    fake = fix/'bin'; fake.mkdir(); log = fix/'tmux.log'
    (fake/'tmux').write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$FORWARD_TMUX_LOG"\nexit 0\n')
    (fake/'tmux').chmod(0o755)
    registry = team/'.tap/team-registry.json'
    def seat(handle, instance='one'):
        return dict(status='active', delivery='poll', harness='codex', instance=handle+'|'+instance, registered_at='t')
    doc = dict(schema='0.20', team=dict(name='fixture'), seats={'next':seat('next'), 'peer':seat('peer')},
               seat_forwardings=[dict(source='old', source_instance='old|one', destination='next', destination_instance='next|one', at='2026-09-07T12:00:00Z', address_active=True)])
    def save(): registry.write_text(json.dumps(doc))
    save()
    (bus/'registry.json').write_text(json.dumps(dict(schema='0.20',team=dict(name='fixture',worktree_root=str(team)),seats=doc['seats'])))
    (index/'global-registry.json').write_text(json.dumps(dict(schema='0.20', teams={'fixture':dict(root=str(team),registry_location=str(registry))})))
    env = {**os.environ, 'TAP_HOME':str(bus), 'TAP_INDEX_HOME':str(index), 'TAP_SELF':'peer',
           'TAP_SPOOL_DISABLE_DELIVERER':'1', 'PATH':str(fake)+':'+os.environ['PATH'], 'FORWARD_TMUX_LOG':str(log)}
    def run(*args, actor='peer', extra=None):
        return subprocess.run(['bash',str(root/'bin/tap'),*args],env={**env,'TAP_SELF':actor,**(extra or {})},text=True,capture_output=True)
    def good(result):
        assert result.returncode == 0, (result.args,result.returncode,result.stdout,result.stderr)
        return result
    def fields(path):
        return dict(line.split(': ',1) for line in path.read_text().split('---')[1].splitlines() if ': ' in line)
    def sent(result):
        return pathlib.Path(json.loads(good(result).stdout)['path'])
    def seed(number, *, home=bus, to='old', recipient='old|one', sender='peer', sender_instance='peer|one', parked=False, foreign=False):
        ident = f'{sender}-20260907T120000Z-{number:012x}'
        for directory in (home/'payloads',home/'receipts',home/'spool'): directory.mkdir(parents=True,exist_ok=True)
        path = home/('spool' if parked else 'payloads')/(ident+'.md')
        rows = ['---',f'id: {ident}',f'from: {sender}',f'to: {to}','kind: discuss','reply: expected',f'path: {home}/payloads/{ident}.md',f'recipient_instance: {recipient}']
        if sender_instance: rows.append('sender_instance: '+sender_instance)
        if foreign: rows += ['from_team: remote','to_team: fixture']
        path.write_text('\n'.join(rows+['---','','original body '+ident,'']))
        if parked:
            (home/'spool'/(ident+'.meta.json')).write_text(json.dumps(dict(id=ident,target=to,target_registry=str(registry),to_team='fixture',reason='queued-input',reason_class='busy',first_spooled_epoch=1)))
        return ident,path

    future = sent(run('send','old','--ask','-m','new work','--json'))
    row = fields(future)
    assert (row['to'],row['recipient_instance'],row['to_adopted_from'],row['original_recipient_instance']) == ('next','next|one','old','old|one'),row
    future_bytes = future.read_bytes()
    good(run('read',future.stem,actor='next'))
    good(run('reply',future.stem,'-m','new forwarded work completed',actor='next'))
    future_done = json.loads((bus/'receipts'/(future.stem+'.done')).read_text())
    assert (future_done['by'],future_done['adopted_from']) == ('next','old') and future.read_bytes() == future_bytes,future_done
    poisoned,poisoned_path = seed(6,to='next',recipient='old|one')
    poisoned_path.write_text(poisoned_path.read_text().replace('recipient_instance: old|one',
        'recipient_instance: old|one\nto_adopted_from: old\noriginal_recipient_instance: old|one'))
    before = set((bus/'payloads').iterdir())
    refused = run('reply',poisoned,'-m','must not substitute predecessor instance',actor='next')
    assert refused.returncode != 0 and set((bus/'payloads').iterdir()) == before,(refused.stdout,refused.stderr)
    assert not (bus/'receipts'/(poisoned+'.done')).exists()
    parked,path = seed(1,parked=True); original = path.read_bytes()
    # Prior possible delivery is evidence, never permission to repeat it.
    attempted = bus/'receipts'/(parked+'.attempted'); attempted.write_text('{"effect":"possible"}\n')
    attempted_bytes = attempted.read_bytes()
    polled = run('poll','next','--json',actor='next')
    assert polled.returncode == 2 and parked in polled.stdout,(polled.stdout,polled.stderr)
    good(run('read',parked,actor='next'))
    assert (bus/'payloads'/(parked+'.md')).read_bytes() == original and not path.exists()
    observed = json.loads((bus/'receipts'/(parked+'.read')).read_text())
    assert observed['by'] == 'next' and observed['adopted_from'] == 'old',observed
    assert not (bus/'receipts'/(parked+'.done')).exists() and attempted.read_bytes() == attempted_bytes
    good(run('reply',parked,'-m','completed',actor='next'))
    receipt = json.loads((bus/'receipts'/(parked+'.done')).read_text())
    assert (receipt['by'],receipt['adopted_from']) == ('next','old'),receipt
    answer = fields(bus/'payloads'/(receipt['reply_id']+'.md'))
    assert (answer['from'],answer['adopted_from'],answer['in_reply_to']) == ('next','old',parked),answer
    assert (bus/'payloads'/(parked+'.md')).read_bytes() == original
    for suffix in ('placed','sent','harness-queued'): assert not (bus/'receipts'/(parked+'.'+suffix)).exists(),suffix

    # Recipient authority remains local while foreign parked bytes and receipts
    # remain on the original sender bus, including explicit path resolution.
    remote = fix/'remote/.tap/bus'
    # Leader ruling (tap-4b7ib U1b hold): production allows a direct spool
    # address only for an ENROLLED foreign bus, so the fixture must enroll
    # `remote` — root plus a readable acting registry — before the read below.
    remote_registry = fix/'remote/.tap/team-registry.json'
    remote_registry.parent.mkdir(parents=True, exist_ok=True)
    remote_registry.write_text(json.dumps(dict(schema='0.20', team=dict(name='remote'), seats={})))
    (index/'global-registry.json').write_text(json.dumps(dict(schema='0.20', teams={
        'fixture':dict(root=str(team),registry_location=str(registry)),
        'remote':dict(root=str(fix/'remote'),registry_location=str(remote_registry))})))
    foreign,foreign_path = seed(2,home=remote,parked=True,foreign=True)
    foreign_bytes = foreign_path.read_bytes()
    good(run('read','path='+str(foreign_path),actor='next'))
    assert (remote/'payloads'/(foreign+'.md')).read_bytes() == foreign_bytes
    assert json.loads((remote/'receipts'/(foreign+'.read')).read_text())['adopted_from'] == 'old'
    assert not (bus/'receipts'/(foreign+'.read')).exists()

    doc['seats']['old'] = seat('old','two'); save()
    fresh = fields(sent(run('send','old','--ask','-m','fresh name','--json')))
    assert (fresh['to'],fresh['recipient_instance']) == ('old','old|two') and 'to_adopted_from' not in fresh,fresh
    old_ask,old_path = seed(3,to='peer',recipient='peer|one',sender='old',sender_instance='old|one')
    old_bytes = old_path.read_bytes()
    good(run('reply',old_ask,'-m','answer to predecessor'))
    receipt = json.loads((bus/'receipts'/(old_ask+'.done')).read_text())
    routed = fields(bus/'payloads'/(receipt['reply_id']+'.md'))
    assert (routed['to'],routed['recipient_instance'],routed['to_adopted_from']) == ('next','next|one','old'),routed
    assert old_path.read_bytes() == old_bytes

    unstamped,_ = seed(4,to='peer',recipient='peer|one',sender='old',sender_instance='')
    before = set((bus/'payloads').iterdir())
    refused = run('reply',unstamped,'-m','must not guess')
    assert refused.returncode != 0 and 'ambiguous' in refused.stderr,(refused.stdout,refused.stderr)
    assert set((bus/'payloads').iterdir()) == before and not (bus/'receipts'/(unstamped+'.done')).exists()

    stale,stale_path = seed(5,parked=True)
    doc['seats']['next'] = seat('next','two')
    # Route race: the hook fires after native send resolves old|one -> next|one
    # and rewrites the registry directly (a lockless writer; a lock-honoring one
    # cannot run while send holds the acting-registry lock). The pre-placement
    # recheck must refuse rather than place with the replaced successor.
    hook = fix/'replace-after-route'
    hook.write_text('#!/usr/bin/env python3\nimport pathlib\npathlib.Path('+repr(str(registry))+').write_text('+repr(json.dumps(doc))+')\n')
    hook.chmod(0o755)
    before = set((bus/'payloads').iterdir())
    refused = run('send','old','--recipient-instance','old|one','--ask','-m','route race','--json',extra={'TAP_SEND_AFTER_ROUTE_HOOK':str(hook)})
    assert refused.returncode != 0 and json.loads(refused.stdout)['error_class'] == 'forwarding_changed',(refused.stdout,refused.stderr)
    assert set((bus/'payloads').iterdir()) == before
    before = set((bus/'payloads').iterdir())
    refused = run('read',stale,actor='next')
    assert refused.returncode != 0 and stale_path.exists() and not (bus/'receipts'/(stale+'.read')).exists()
    # This pin is what reply carries after its single-snapshot grant check.
    refused = run('send','peer','--fyi','--in-reply-to',stale,'--sender-instance','next|one','-m','stale actor','--json',actor='next')
    assert refused.returncode != 0 and json.loads(refused.stdout)['error_class'] == 'instance_replaced',(refused.stdout,refused.stderr)
    assert set((bus/'payloads').iterdir()) == before
    transcript = log.read_text() if log.exists() else ''
    assert 'send-keys' not in transcript and 'select-pane' not in transcript,transcript
    print('seat-forwarding-interop: routing, history, parked/foreign custody, reuse, historical ambiguity, route race and actor pin: ok')
PY
