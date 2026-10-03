#!/usr/bin/env bash
# Stranger path through installed public commands; no account or courier needed.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
. "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"
python3 - "$ROOT" <<'PY'
import json, os, pathlib, pty, select, shutil, subprocess, sys, tempfile, time
root = pathlib.Path(sys.argv[1])
with tempfile.TemporaryDirectory(prefix='installer-continuity-') as scratch:
    work = pathlib.Path(scratch).resolve(); repo = work/'clone'; home = work/'home'; home.mkdir()
    subprocess.run(['git','clone','--quiet','--no-hardlinks',str(root),str(repo)],check=True)
    head = subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip()
    assert subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip() == head
    # Exercise this checkout's current bytes before commit too, including renames.
    patch=subprocess.check_output(['git','-C',str(root),'diff','HEAD','--binary'])
    if patch:
        subprocess.run(['git','-C',str(repo),'apply','--binary'],input=patch,check=True)
    env = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(home/'.config'),
               TAP_INDEX_HOME=str(home/'.tap'), TAP_HOME='', TAP_SETUP_OPEN_GUIDE='0',
               SHELL='/bin/bash', TAP_INSTALL_HOOK='0', BUN_RUNTIME_TRANSPILER_CACHE_PATH='0')
    for key in list(env):
        if key in ('TMUX','TMUX_PANE','TAP_SELF','TAP_INSTALL_BIN','TAP_INSTALL_MANIFEST','TAP_INSTALL_REPO') or (key.startswith('TAP_') and key.endswith('_HOME') and key not in ('TAP_HOME','TAP_INDEX_HOME','TAP_SUITE_LOCK_HOME')):
            env.pop(key,None)
    # Only executable discovery is stubbed; no agent is launched or authenticated.
    tools = work/'tools'; tools.mkdir()
    (tools/'codex').write_text('#!/bin/sh\nexit 1\n'); (tools/'codex').chmod(0o755)
    env['PATH'] = str(home/'.local/bin')+os.pathsep+str(tools)+os.pathsep+env['PATH']
    def run(argv,cwd=repo,code=0):
        r=subprocess.run(argv,cwd=cwd,env=env,text=True,capture_output=True,timeout=60)
        assert r.returncode==code, (argv,r.returncode,r.stdout,r.stderr)
        return r
    def terminal(argv,answers,cwd=repo):
        master,slave=pty.openpty(); output=b''; answered=set()
        child=subprocess.Popen(argv,cwd=cwd,env=env,stdin=slave,stdout=slave,stderr=slave)
        os.close(slave); deadline=time.monotonic()+60
        try:
            while time.monotonic()<deadline:
                if select.select([master],[],[],0.1)[0]:
                    try: chunk=os.read(master,65536)
                    except OSError: break
                    if not chunk: break
                    output+=chunk
                    for question,answer in answers:
                        if question not in answered and question.encode() in output:
                            os.write(master,(answer+'\n').encode()); answered.add(question)
                if child.poll() is not None: break
            if child.poll() is None: child.kill()
            assert child.wait()==0, (argv,output.decode(errors='replace'))
            return output.decode(errors='replace')
        finally:
            if child.poll() is None: child.kill(); child.wait()
            os.close(master)
    # Select Codex starters explicitly; all other discovered harnesses keep skip.
    # The wizard opens with two questions; an empty answer keeps each default.
    answers=[('The first time TAP is used in a new project',''),('Messages that arrive while you type','')]
    answers += [(h+': keep it simple, choose myself, or skip? [skip]', 'simple' if h=='codex' else '') for h in ('claude','codex','cursor','opencode','agy','hermes')]
    answers += [('Default effort for selected Claude/Codex starter models','high')]
    answers += [(h+': Permission mode [auto]', 'bypass' if h=='codex' else 'auto') for h in ('claude','codex')]
    answers += [('Install the optional full skill kit for flat hosts? (Claude and Codex have the complete TAP plugin)','n'),('Notifier [keep existing/system default]','keep'),('Add shell aliases?','n'),('Install the TAP agent lookup keybinding','n')]
    answers += [('Install '+p+' for '+h+'?','n') for h in ('claude','codex') for p in ('ponytail','compound-engineering','superpowers')]
    output=terminal(['bash','install.sh','--setup'],answers)
    assert 'Detected executables: codex' in output, output
    assert 'This does not verify login or model access.' in output, output
    assert 'next: from your work directory, run tap launch astra' in output, output
    tap=home/'.local/bin/tap'; assert tap.is_symlink() and tap.resolve()==repo/'bin/tap', output
    assert run(['bash','-c','command -v tap']).stdout.strip()==str(tap)
    config=(home/'.config/tap/config.toml').read_text()
    assert 'bypass' in config and 'astra' in config, config
    project=work/'project'; project.mkdir(); run(['git','init','-q',str(project)])
    initialized=run(['tap','init'],project)
    assert 'successfully initialized team' in initialized.stdout, initialized
    assert (project/'.tap/bus').is_dir()
    assert '.tap/' in (project/'.gitignore').read_text()
    signpost=(project/'AGENTS.md').read_text()
    assert '<!-- TAP:CHARTER v=4 -->' in signpost
    assert '/tap' in signpost and 'tap read <id>' in signpost
    assert run(['tap','presets'],project).stdout.strip()
    run(['tap','team'],project)
    for name in ('sender','reader'):
        run(['tap','register',name,'--delivery','poll'],project)
    body=work/'note.md'; body.write_text('installer continuity round trip\n')
    run(['tap','send','reader','--from','sender','--fyi','--id','installer-continuity','-f',str(body)],project)
    read=run(['tap','read','installer-continuity','--by','reader'],project)
    assert body.read_text().strip() in read.stdout, read
    # Pane-less identity must refuse explicitly, not crash or invent a seat.
    identity=run(['tap','whoami','--json'],project,code=1)
    assert json.loads(identity.stdout)['error_class']=='not_in_tmux', identity
    assert json.loads(identity.stdout)['action']=='tap session launch <preset|harness> [name]', identity
    terminal(['tap','uninstall'],[('Remove these TAP artifacts?','yes'),('Keep, archive, or delete your TAP history?','delete')],project)
    assert not tap.exists() and not tap.is_symlink()
    # Uninstall may leave empty integration directories, but no files or symlinks.
    residual=[str(p.relative_to(home)) for p in home.rglob('*') if p.is_symlink() or p.is_file()]
    assert not residual, residual
    print('installer-continuity: clone '+head+(' with working-tree overlay' if patch else '')+' install/setup bypass, init, public round trip, pane-less identity and uninstall PASS')
PY
