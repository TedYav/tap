#!/usr/bin/env bash
# D5: fixture-door — the module list at :19-21 scaffolds the installer fixture exactly as install-checkout-sync does; every assertion is on installer/git behavior.
# Real installer and Git replay over a tap-sync-regenerable export and a tap-hooks directory.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
. "$(dirname "${BASH_SOURCE[0]}")/fzf-archive-pin.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
python3 - "$ROOT" <<'TEST'
import json, os, pathlib, shutil, subprocess, sys, tempfile
root=pathlib.Path(sys.argv[1])
for mode in ['success', 'hook-warning', 'conflict', 'conflict-apply', 'abort-failure', 'foreign-rebase', 'interleaved-fetch', 'pull-refused', 'pre-existing', 'non-main']:
  with tempfile.TemporaryDirectory(prefix='install-rebase-hooks-') as temp:
    work=pathlib.Path(temp).resolve(); primary=work/'primary'; origin=work/'origin.git'; pusher=work/'pusher'; bins=work/'bin'
    primary.mkdir(); bins.mkdir()
    real_git=shutil.which('git')
    env=dict(os.environ, MODE=mode, REAL_GIT=real_git, PRIMARY=str(primary), HOOK_TRACE=str(work/'hooks.log'))
    def run(args, cwd=primary, ok=True, use_env=env):
        r=subprocess.run(args,cwd=cwd,env=use_env,text=True,capture_output=True)
        if ok: assert r.returncode==0,(args,r.returncode,r.stdout,r.stderr)
        return r
    def git(*args,cwd=primary): return run(['git',*args],cwd)
    git('init','-q','-b','main'); git('config','user.name','fixture'); git('config','user.email','fixture@example.invalid')
    for relative in ['runtime/bun/src/install-skill-links.ts','install.sh','skills/lead/references/ingest/README.md','runtime/bun/src/install-roster-hook-cleanup.ts','runtime/bun/src/watch-detect.ts','runtime/bun/src/spool-publication.ts','runtime/bun/src/fsatomic.ts','runtime/bun/src/pyint.ts','runtime/bun/src/panelock.ts','runtime/bun/src/launcher/naming.ts','runtime/bun/src/install-fzf.ts','runtime/bun/src/fzf-tool.ts']:
        dest=primary/relative; dest.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(root/relative,dest)
    shutil.copytree(root/'runtime/bun/src',primary/'runtime/bun/src',dirs_exist_ok=True)
    shutil.copytree(root/'skills',primary/'skills',dirs_exist_ok=True)
    hooks=primary/'githooks'; hooks.mkdir()
    (hooks/'.gitattributes').write_text('* tap-hooks\n')
    # Logs every call and whether a replay is in progress when it runs.
    post=hooks/'post-checkout'; post.write_text(r'''#!/usr/bin/env python3
import json,os,pathlib,sys
primary=pathlib.Path(os.environ['PRIMARY'])
rebasing=(primary/'.git/rebase-merge').exists() or (primary/'.git/rebase-apply').exists()
with open(os.environ['HOOK_TRACE'],'a') as f: f.write(json.dumps({'post-checkout':sys.argv[1:],'rebase':rebasing})+'\n')
if os.environ['MODE']=='hook-warning': print('fixture hook warning',file=sys.stderr)
'''); post.chmod(0o755)
    (primary/'gen').mkdir(); (primary/'gen/.gitattributes').write_text('export.jsonl tap-sync-regenerable\n')
    shutil.copytree(root/'vendor',primary/'vendor')  # install.sh stages the managed fzf; fzf-tool imports vendor/fzf/manifest.json
    (primary/'bin').mkdir(); (primary/'bin/tap').write_text('#!/bin/sh\necho fixture\n'); (primary/'bin/tap').chmod(0o755)
    rows=[{'id':name,'updated_at':'2026-01-01T00:00:00Z'} for name in ['base','context-1','context-2']]
    export=primary/'gen/export.jsonl'
    def write_rows(path,items): path.write_text(''.join(json.dumps(row)+'\n' for row in items))
    write_rows(export,rows)
    git('add','.'); git('commit','-qm','seed')
    run(['git','init','-q','--bare','-b','main',str(origin)],work)
    git('remote','add','origin',str(origin)); git('push','-q','-u','origin','main')
    run(['git','clone','-q',str(origin),str(pusher)],work)
    git('config','user.name','fixture',cwd=pusher); git('config','user.email','fixture@example.invalid',cwd=pusher)
    (pusher/'new-code').write_text('merged code\n')
    if mode in ['conflict','conflict-apply','abort-failure','foreign-rebase']:
        write_rows(pusher/'gen/export.jsonl',[{'id':'base','updated_at':'2026-08-01T00:00:00Z'}])
        git('add','gen/export.jsonl',cwd=pusher)
    incoming={'id':'incoming-only','updated_at':'2026-01-01T00:00:00Z'}
    if mode in ['success','hook-warning','interleaved-fetch']:
        write_rows(pusher/'gen/export.jsonl',[incoming,*rows])
        git('add','gen/export.jsonl',cwd=pusher)
    git('add','new-code',cwd=pusher); git('commit','-qm','upstream code',cwd=pusher); git('push','-q','origin','main',cwd=pusher)
    if mode=='interleaved-fetch':
        # Extra branches on origin: an explicit multi-branch fetch records several mergeable FETCH_HEAD rows.
        git('push','-q','origin','main:refs/heads/other-1','main:refs/heads/other-2',cwd=pusher)
    for number in range(3):
        if mode in ['conflict','conflict-apply','abort-failure','foreign-rebase']: rows[0]['updated_at']='2026-07-01T00:00:00Z'
        rows.append({'id':f'local-{number}','updated_at':'2026-01-01T00:00:00Z'})
        write_rows(export,rows); git('add','gen/export.jsonl'); git('commit','-qm',f'bookkeeping {number}')
    original=git('rev-parse','HEAD').stdout.strip()
    # Preserve the other Git hooks: suppression must not mean core.hooksPath=/dev/null.
    pre=primary/'githooks/pre-rebase'; pre.write_text('#!/bin/sh\necho generic-pre-rebase >> "$HOOK_TRACE"\n[ "$MODE" != pull-refused ]\n'); pre.chmod(0o755)
    # Do not make this fixture-only probe untracked dirt visible to the installer.
    with (primary/'.git/info/exclude').open('a') as f: f.write('githooks/pre-rebase\n')
    git('config','core.hooksPath',str(primary/'githooks'))
    # interleaved-fetch injects, deterministically and with no timing race, the concurrent
    # multi-branch fetch of the shared primary: right after every fetch the installer's git
    # runs. A `pull` spawns its own `git fetch` as a child that resolves `git` through its
    # exec path, so that run is wrapped by a shadow exec dir whose `git` does the same.
    interleave=r'''
interleave() {
  "$REAL_GIT" -C "$PRIMARY" fetch -q origin main other-1 other-2
  echo "interleaved-fetch" >> "$HOOK_TRACE"
}
'''
    shadow=bins/'shadow-exec'; shadow.mkdir()
    for entry in pathlib.Path(subprocess.check_output([real_git,'--exec-path'],text=True).strip()).iterdir():
        if entry.name!='git': (shadow/entry.name).symlink_to(entry)
    (shadow/'git').write_text('#!/bin/bash\n'+interleave+'GIT_EXEC_PATH="$SHADOW_EXEC" "$REAL_GIT" "$@"; rc=$?\n[ "$1" != fetch ] || interleave\nexit $rc\n'); (shadow/'git').chmod(0o755)
    env['SHADOW_EXEC']=str(shadow)
    git_proxy=bins/'git'; git_proxy.write_text(r'''#!/usr/bin/env python3
import os,subprocess,sys
args=sys.argv[1:]; mode=os.environ['MODE']
if args[-2:]==['rebase','--abort']:
    with open(os.environ['HOOK_TRACE'],'a') as f: f.write('installer-abort\n')
    if mode=='abort-failure': raise SystemExit(77)
if ('pull' in args or 'rebase' in args) and mode=='foreign-rebase':
    os.environ['GIT_REFLOG_ACTION']='foreign-replay'
if mode=='interleaved-fetch':
    if 'pull' in args: os.environ['GIT_EXEC_PATH']=os.environ['SHADOW_EXEC']
    result=subprocess.run([os.environ['REAL_GIT'],*args])
    if 'fetch' in args and result.returncode==0:
        subprocess.run([os.environ['REAL_GIT'],'-C',os.environ['PRIMARY'],'fetch','-q','origin','main','other-1','other-2'],check=True)
        with open(os.environ['HOOK_TRACE'],'a') as f: f.write('interleaved-fetch\n')
    raise SystemExit(result.returncode)
os.execv(os.environ['REAL_GIT'],[os.environ['REAL_GIT'],*args])
'''); git_proxy.chmod(0o755)
    env['PATH']=str(work/'installed-bin')+':'+str(bins)+':'+env['PATH']
    env['TAP_INSTALL_BIN']=str(work/'installed-bin'); env['TAP_INSTALL_HOOK']='0'
    for name in ['CLAUDE','CODEX','HERMES','CURSOR','OPENCODE','GEMINI','CURSOR_AGENT','AGENTS']:
        env['TAP_'+name+'_HOME']=str(work/('home-'+name.lower()))
    env['TAP_INDEX_HOME']=str(work/'index')
    if mode=='conflict-apply': git('config','rebase.backend','apply')
    if mode=='pre-existing':
        git('fetch','-q','origin','main')
        setup_env=env
        paused=run(['git','rebase','--exec','false','origin/main'],ok=False,use_env=setup_env)
        assert paused.returncode!=0 and (primary/'.git/rebase-merge').exists(),paused.stderr
        preserved_head=git('rev-parse','HEAD').stdout
        preserved_export=export.read_bytes()
        preserved_state={str(p.relative_to(primary/'.git/rebase-merge')):p.read_bytes() for p in (primary/'.git/rebase-merge').rglob('*') if p.is_file()}
        (work/'hooks.log').write_text('')
    if mode=='non-main':
        run(['git','checkout','-qb','operator'])
        (work/'hooks.log').write_text('')
    result=run(['bash',str(primary/'install.sh'),'--sync'],ok=False)
    trace=(work/'hooks.log').read_text() if (work/'hooks.log').exists() else ''
    branch=git('symbolic-ref','-q','--short','HEAD') if result.returncode==0 else run(['git','symbolic-ref','-q','--short','HEAD'],ok=False)
    print('install-rebase-hooks:',mode,'rc',result.returncode,'branch',branch.stdout.strip() or 'DETACHED','trace',trace,flush=True)
    if mode=='pre-existing':
        assert result.returncode!=0, 'installer accepted an existing paused rebase'
        assert git('rev-parse','HEAD').stdout==preserved_head
        assert export.read_bytes()==preserved_export
        assert {str(p.relative_to(primary/'.git/rebase-merge')):p.read_bytes() for p in (primary/'.git/rebase-merge').rglob('*') if p.is_file()}==preserved_state
        assert not (work/'installed-bin/tap').exists()
        print('install-rebase-hooks: existing paused rebase untouched')
        continue
    if mode in ['abort-failure','foreign-rebase']:
        assert result.returncode!=0
        assert not branch.stdout.strip(), 'unexpectedly changed detached state'
        assert (primary/'.git/rebase-merge').exists(), 'lost paused replay evidence'
        assert not (work/'installed-bin/tap').exists()
        if mode=='abort-failure':
            assert 'installer-abort' in trace and 'recovery failed' in result.stderr,result.stderr
        else: assert 'installer-abort' not in trace, 'aborted another invocation rebase'
        continue
    if mode in ['pull-refused','non-main']:
        assert result.returncode!=0
        assert git('rev-parse','HEAD').stdout.strip()==original
        assert branch.stdout.strip()==('operator' if mode=='non-main' else 'main')
        assert not (primary/'.git/rebase-merge').exists()
        assert not (work/'installed-bin/tap').exists()
        assert 'installer-abort' not in trace
        continue
    if mode in ['conflict','conflict-apply']:
        assert result.returncode!=0, 'conflicting replay claimed success'
        assert branch.stdout.strip()=='main', ('failed replay left primary detached',result.stderr)
        assert git('rev-parse','HEAD').stdout.strip()==original, 'failed replay changed original main'
        assert not (primary/'.git/rebase-merge').exists() and not (primary/'.git/rebase-apply').exists()
        assert not (work/'installed-bin/tap').exists(), 'failed replay relinked anyway'
        print('install-rebase-hooks: failed owned replay aborted to original main')
    else:
        assert result.returncode==0,('sync failed during hook export',result.stdout,result.stderr)
        assert branch.stdout.strip()=='main'
        assert run(['git','merge-base','--is-ancestor','origin/main','HEAD'],ok=False).returncode==0
    assert 'generic-pre-rebase' in trace, 'another Git hook was disabled'
    events=[json.loads(line) for line in trace.splitlines() if line.startswith('{')]
    final=git('rev-parse','HEAD').stdout.strip()
    replays=[event for event in events if event['post-checkout']==[original,final,'1']]
    if mode=='interleaved-fetch':
        # Prove the injection fired and left several mergeable heads in FETCH_HEAD, so the pass cannot be vacuous.
        assert 'interleaved-fetch' in trace,'concurrent fetch was never injected'
        assert sum(1 for line in (primary/'.git/FETCH_HEAD').read_text().splitlines() if line.split('\t')[1]=='')>1,'FETCH_HEAD holds a single mergeable head'
    if mode in ['success','hook-warning','interleaved-fetch']:
        # The installer replays post-checkout exactly once, on the final tree, outside the replay.
        assert len(replays)==1 and not replays[0]['rebase'],(events,result.stderr)
        if mode=='hook-warning': assert 'fixture hook warning' in result.stderr
        assert [json.loads(line) for line in export.read_text().splitlines()]==[incoming,*rows], 'Git records lost'
    else:
        assert not replays, ('a failed replay ran post-checkout',events)
        assert [json.loads(line) for line in export.read_text().splitlines()]==rows, 'failed replay changed the export'
    if mode=='conflict-apply': assert git('config','rebase.backend').stdout.strip()=='apply'
    print('install-rebase-hooks:',mode,'preserves hooks and commits')
TEST
