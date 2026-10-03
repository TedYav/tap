#!/usr/bin/env bash
# Real Bash publisher -> Bun one-shot attempt -> active submit, fake pane only.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
python3 - "$ROOT" <<'PY'
import json, os, subprocess, sys, tempfile
from pathlib import Path
root=Path(sys.argv[1])
with tempfile.TemporaryDirectory() as temp:
    work=Path(temp); bin=work/'bin'; bin.mkdir()
    tmux=bin/'tmux'
    tmux.write_text('''#!/usr/bin/env python3
import os,sys
from pathlib import Path
a=sys.argv[1:]; bus=Path(os.environ['TAP_HOME']); text=bus/'pane-text'; effects=bus/'effects'
if 'display-message' in a:
    fmt=a[-1]
    if 'pane_in_mode' in fmt: print('0')
    elif 'pane_width' in fmt: print('100')
    elif 'pane_id' in fmt: print('%402\\tsender\\t4242\\tclaude\\t0')
    else: print('1:1')
elif 'capture-pane' in a:
    if (bus/'queued').exists(): print((bus/'queued').read_text())
    print('─'*60); print('❯ '+(text.read_text() if text.exists() else '')); print('─'*60)
    if os.environ['SCENARIO']=='queued': print('esc to interrupt')
elif 'send-keys' in a:
    with effects.open('a') as f: f.write(' '.join(a)+'\\n')
    if '-l' in a: text.write_text(a[-1])
    elif a[-1]=='Enter' and os.environ['SCENARIO'] in ('success','queued'):
        if os.environ['SCENARIO']=='queued': (bus/'queued').write_text(text.read_text())
        text.write_text('')
else: sys.exit(1)
'''); tmux.chmod(0o755)
    for scenario,durable,want in [('staged',False,1),('staged',True,0),('success',False,0),('queued',False,0),('queued',True,0)]:
        bus=work/(scenario+str(durable)); bus.mkdir()
        for name in ['payloads','receipts','spool']: (bus/name).mkdir()
        registry=bus/'registry.json'
        registry.write_text(json.dumps({'schema': '0.20', 'team':{'name':'fixture'},'seats':{'alice':{'status':'active','pane':'sender:0.0','pane_id':'%402','server_epoch':'srv:1:1','harness':'claude','instance':'sender-instance'}}}))
        (bus/'recipient-registry.json').write_text(json.dumps({'schema': '0.20', 'seats':{'peer':{'status':'active','pane_id':'%401','server_epoch':'srv:1:1'}}}))
        (bus/'payloads/original.md').write_text('---\nid: original\nfrom: alice\nto: peer\nkind: discuss\nreply: expected\n---\nOriginal\n')
        env={**os.environ,'PATH':str(bin)+':'+os.environ['PATH'],'TAP_HOME':str(bus),'TAP_INDEX_HOME':str(bus/'index'),'TAP_SPOOL_DISABLE_DELIVERER':'1','SCENARIO':scenario,'DURABLE':'notice-durable' if durable else ''}
        script='''
. "$1/skills/tap/scripts/smoke/runtime-helpers.sh"
. "$1/skills/tap/scripts/smoke/native-authority-fixture.sh"
acting_registry_fixture() { printf '%s/registry.json' "$TAP_HOME"; }
spool_team_fixture() { printf fixture; }
spool_deadline() { # <id> <verb> [<args>...]: the native deadline door, argv as the drain passes it
  local id="$1" verb="$2" team acting; shift 2
  team="$(spool_team_fixture)"
  acting="$(acting_registry_fixture "$team" 2>/dev/null || true)"
  tap_bun_call spool-deadline "$id" spool-deadline.ts "$TAP_HOME" "$TAP_SPOOL" "$TAP_REGISTRY_EVENTS" "$team" "${TAP_VERB:-tap}" "$acting" "$_TAP_SCRIPT_DIR" none "" "" "$(date +%s)" 1800 "$verb" "$@"
}
[ "$(spool_deadline original notify original peer detail "$TAP_HOME/recipient-registry.json" unconfirmed "$DURABLE" "")" = woken ]
'''
        r=subprocess.run(['bash','-c',script,'_',str(root)],env=env,capture_output=True,text=True,timeout=40)
        assert r.returncode==want,(scenario,durable,r.returncode,r.stdout,r.stderr)
        notices=[p for p in (bus/'payloads').glob('*.md') if p.stem!='original']
        assert len(notices)==1,notices
        notice=notices[0]; rows=[json.loads(line) for line in notice.with_suffix('.attempts').read_text().splitlines()]
        assert len(rows)==2 and rows[0]['phase']=='begin',rows
        assert rows[1]['disposition']==('delivered' if scenario=='success' else 'harness-queued' if scenario=='queued' else 'unconfirmed'),rows
        assert (bus/'receipts'/f'{notice.stem}.sent').exists()==(scenario=='success')
        assert (bus/'pane-text').read_text()==('' if scenario in ('success','queued') else f'[[TAP v0.23 note {notice.stem}]]')
        if scenario=='queued': assert (bus/'receipts'/f'{notice.stem}.harness-queued').exists()
        if durable:
            effects=(bus/'effects').read_text()
            # Production durable publication re-entry returns without another wake.
            r=subprocess.run(['bash','-c',script,'_',str(root)],env=env,capture_output=True,text=True,timeout=10)
            assert r.returncode==0,(r.stdout,r.stderr)
            assert (bus/'effects').read_text()==effects
        print(f'PASS notice submit {scenario} durable={durable}: rc={want}, attempt evidence, sent truth')
PY
