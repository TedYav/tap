#!/usr/bin/env bash
# D5: fixture-door — :88 direct debug.ts exec under a pty is the TTY control: its stdout is discarded, and the :78-85 bin/bun fixture shim records fd flags before exec, so :90 asserts door hygiene ('1110'/'0000'), not module behavior; every asserted arm drives the public bin/tap debug door
# Run through smoke-all: the recorder, HOME and every tmux call stay private.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
python3 -B - "$ROOT" <<'PY'
import errno, json, os, pathlib, pty, select, shutil, signal, subprocess, sys, tempfile, time
root = pathlib.Path(sys.argv[1])
with tempfile.TemporaryDirectory(prefix='debug-', dir=os.environ['TMUX_TMPDIR']) as tmp:
    p = pathlib.Path(tmp)
    env = dict(os.environ, HOME=tmp, XDG_CONFIG_HOME=tmp+'/config', TAP_INDEX_HOME=tmp+'/index', BUN_RUNTIME_TRANSPILER_CACHE_PATH=tmp+'/bun-cache')
    env.pop('TMUX', None)
    env.pop('TMUX_PANE', None)
    socket = tmp+'/private.sock'
    def tmux(*args):
        return subprocess.run(['tmux','-S',socket,*args], env=env, cwd=p, capture_output=True, text=True, timeout=5)
    def tap(*args):
        return subprocess.run([str(root/'bin/tap'),'debug',*args], env=env, cwd=p, capture_output=True, text=True, timeout=15)
    def tty_command(argv):
        master, slave = pty.openpty()
        child = subprocess.Popen(argv, env=env, cwd=p, stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        output = b''
        try:
            until = time.monotonic()+15
            while time.monotonic()<until:
                if select.select([master],[],[],.05)[0]:
                    try:
                        part = os.read(master,65536)
                        if not part: break
                        output += part
                    except OSError as error:
                        if error.errno == errno.EIO: break
                        raise
                if child.poll() is not None: break
            assert child.wait(timeout=2) == 0, output
            return output.decode()
        finally:
            if child.poll() is None: child.kill(); child.wait()
            os.close(master)
    def collector_pid(run):
        # Status has already established readiness. This is only descriptor inspection.
        result = subprocess.run(['lsof','-t',str(run/'recorder.log')], capture_output=True, text=True, timeout=3)
        pids = set(result.stdout.split())
        assert result.returncode == 0 and len(pids) == 1, result
        return int(pids.pop())
    def wait_for(predicate):
        until = time.monotonic()+8
        while time.monotonic()<until:
            if predicate(): return
            time.sleep(.1)
        raise AssertionError('recorder observation deadline')
    try:
        initial = tap('status','--json')
        assert initial.returncode == 0, initial.stderr
        assert json.loads(initial.stdout)['recording'] is False
        assert not (p/'index/debug').exists(), 'status created state'
        assert not (p/'bun-cache').exists(), 'read-only status created Bun cache'
        disabled_env = dict(env)
        disabled_env.pop('TAP_HOME', None)
        for args in (['_frame','disabled','codex','%0','wire','probe'], ['_attempt']):
            disabled = subprocess.run([str(root/'bin/tap'),'debug']+args,
                input=b'', env=disabled_env, cwd=p, capture_output=True)
            assert disabled.returncode == 0 and not disabled.stderr, disabled.stderr
        assert tmux('-f','/dev/null','new-session','-d','-s','probe','sleep 90').returncode == 0
        teams = {}
        for name in ('alpha','beta'):
            bus = p/name/'.tap/bus'
            bus.mkdir(parents=True)
            (bus/'registry-events.log').write_text('')
            teams[name] = {'root':str(p/name),'registry_location':str(bus.parent/'team-registry.json'),'state':'registered'}
        (p/'index').mkdir(exist_ok=True)
        (p/'index/global-registry.json').write_text(json.dumps({'schema':'0.20','teams':teams}))
        (p/'bin').mkdir()
        env['REAL_BUN'] = shutil.which('bun')
        env['FD_RECORD'] = str(p/'fd-record')
        (p/'bin/bun').write_text('''#!/bin/bash
case " $* " in *"/debug.ts "*)
  flags=''
  for fd in 0 1 2 9; do if [ -t "$fd" ]; then flags="${flags}1"; else flags="${flags}0"; fi; done
  printf '%s\\n' "$flags" >> "$FD_RECORD"
esac
exec "$REAL_BUN" "$@"
''')
        (p/'bin/bun').chmod(0o755)
        env['PATH'] = str(p/'bin')+':'+env['PATH']
        tty_command(['bun',str(root/'runtime/bun/src/debug.ts'),'status','--json'])
        state = json.loads(tty_command(['bash','-c','exec 9>&2; export TAP_VERBOSE_FD=9; exec "$@"','_',str(root/'bin/tap'),'debug','on','--socket',socket,'--json']))
        assert (p/'fd-record').read_text().splitlines() == ['1110','0000'], 'public Bun inherited a TTY'
        assert state['recording'] and not state['tmux_logging'] and state['mode']=='basic', state
        assert state['fidelity']=='best-effort' and state['sources']['tmux']['state']=='unmanaged', state
        run = pathlib.Path(state['directory'])
        pid = collector_pid(run)
        descriptors = subprocess.run(['lsof','-a','-p',str(pid),'-Ffn'], capture_output=True, text=True, timeout=3)
        assert descriptors.returncode == 0, descriptors
        fds = {}; fd = None
        for line in descriptors.stdout.splitlines():
            if line.startswith('f'): fd = line[1:]
            elif line.startswith('n') and fd is not None: fds[fd] = line[1:]
        assert fds.get('0') == '/dev/null' and all(os.path.realpath(fds.get(fd,'')) == os.path.realpath(run/'recorder.log') for fd in ('1','2')), fds
        assert not any(value.startswith('/dev/tty') for value in fds.values()), fds
        # Internal writes must never report success when their bus is missing.
        missing_bus = dict(env)
        missing_bus.pop('TAP_HOME', None)
        debug = [str(root/'bin/tap'),'debug']
        writes = [(['_frame','missing-bus-frame','codex','%0','wire','probe'], b'frame'),
                  (['_attempt'], b'{"payload_id":"missing-bus-attempt","status":"unverified"}')]
        for missing in (missing_bus, dict(missing_bus,TAP_HOME='')):
            for args, data in writes:
                refused = subprocess.run(debug+args, input=data, env=missing, cwd=p, capture_output=True)
                assert refused.returncode != 0, ('missing bus reported success', args, refused.stderr)
                assert b'TAP_HOME' in refused.stderr, refused.stderr
        assert not list(p.rglob('missing-bus-*')), 'missing bus relocated evidence'
        invalid_bus = p/'not-a-directory'
        invalid_bus.write_text('file')
        for args, data in writes:
            refused = subprocess.run(debug+args, input=data, env=dict(env,TAP_HOME=str(invalid_bus)), cwd=p, capture_output=True)
            assert refused.returncode != 0, ('write failure reported success', args, refused.stderr)
            assert b'journal write failed' in refused.stderr, refused.stderr
        repeated = tap('on','--socket',socket,'--json')
        assert json.loads(repeated.stdout)['directory'] == str(run), repeated
        for name in teams:
            (p/name/'.tap/bus/registry-events.log').write_text('ts=2026-09-06T00:00:00Z actor=alice action=probe handle=bob pane=%0 team='+name+'\n')
        journal = run/'events.jsonl'
        def events(): return [json.loads(line) for line in journal.read_text().splitlines()]
        wait_for(lambda: {e.get('team') for e in events() if e['event']=='tap.registry'} >= set(teams))
        # Active payload streams and bursts beyond the old 200-line tail must all arrive.
        for name in teams:
            payloads = p/name/'.tap/bus/payloads'
            payloads.mkdir()
            (payloads/'courier-burst.md').write_text('')
            (payloads/'courier-burst.attempts').write_text(''.join(json.dumps(dict(payload_id='courier-burst', seq=i, detail='gate refused', members=['one','two']))+'\n' for i in range(300)))
        wait_for(lambda: sum(e['event']=='tap.attempt' for e in events()) == 600)
        attempt = p/'alpha/.tap/bus/payloads/courier-burst.attempts'
        with attempt.open('a') as out: out.write('{"payload_id":"partial"')
        time.sleep(.2)
        with attempt.open('a') as out: out.write(',"seq":301}\n')
        wait_for(lambda: any(e.get('payload_id')=='partial' for e in events()))
        # Keep frame bytes private and durable even after the bus artifact is removed.
        frame_env = dict(env, TAP_HOME=str(p/'alpha/.tap/bus'))
        specimen = b'\x1b[32m> [[TAP v0.23 ask\n  team/id]]\x1b[0m\n'
        kept = subprocess.run([str(root/'bin/tap'),'debug','_frame',
                               'frame-probe','codex','%0','[[TAP v0.23 ask team/id]]','composer-mismatch'],
                              input=specimen, env=frame_env, capture_output=True)
        assert kept.returncode==0 and not kept.stderr, kept.stderr
        wait_for(lambda: any(e['event']=='tap.failure_frame' and e.get('payload_id')=='frame-probe' for e in events()))
        proof = next(e for e in events() if e['event']=='tap.failure_frame' and e.get('payload_id')=='frame-probe')
        assert pathlib.Path(proof['artifact']).read_bytes()==specimen
        assert 'frame' not in proof and 'expected' not in proof, 'raw composer leaked into event'
        pathlib.Path(proof['source']).unlink()
        assert pathlib.Path(proof['artifact']).read_bytes()==specimen
        assert not list(run.rglob('tmux-server-*.log')), 'basic mode enabled native tracing'
        traced = tap('trace','3','--json')
        assert traced.returncode == 0, (traced.stdout,traced.stderr)
        state = json.loads(traced.stdout)
        assert state['mode']=='trace' and state['tmux_logging'] and state['trace']['uncapped'], state
        trace = pathlib.Path(state['trace']['directory'])
        # The raw log stays private while tmux writes it; the redacted copy appears once logging closes.
        assert not list(trace.glob('tmux-server-*.log')), 'raw trace was published while still open'
        assert tap('trace','3').returncode != 0, 'overlapping trace silently replaced the window'
        assert tmux('display-message','-p','debug-exact-command-proof').returncode == 0
        wait_for(lambda: json.loads(tap('status','--json').stdout)['mode']=='basic')
        wait_for(lambda: list(trace.glob('tmux-server-*.log')))
        native = next(trace.glob('tmux-server-*.log'))
        assert 'debug-exact-command-proof' in native.read_text()
        assert any(e['event']=='trace.finished' for e in events())
        assert any(e['event']=='trace.telemetry' for e in events())
        # Deadline disables owned tracing without stopping basic mode or the server.
        size = native.stat().st_size
        assert tmux('display-message','-p','after-off-private-server-still-alive').returncode == 0
        time.sleep(.1)
        assert native.stat().st_size == size, 'deadline left native logging active'
        assert json.loads(tap('status','--json').stdout)['recording'], 'trace expiry stopped basic journaling'
        traced = tap('trace','6','--json')
        assert traced.returncode == 0, traced.stderr
        traced_state = json.loads(traced.stdout)['trace']
        trace = pathlib.Path(traced_state['directory'])
        deadline = traced_state['deadline_epoch']
        # A private server's last command survives death; the trace timer still expires.
        assert tmux('kill-server').returncode == 0
        wait_for(lambda: any(e['event']=='tmux.unavailable' for e in events()))
        assert tmux('-f','/dev/null','new-session','-d','-s','replacement','sleep 90').returncode == 0
        # The dead server's log is published while the replacement takes over; the replacement's at close.
        wait_for(lambda: (lambda t: t['trace'] and len(t['trace']['files']) == 2 and t['tmux_logging'])(json.loads(tap('status','--json').stdout)))
        wait_for(lambda: len(list(trace.glob('tmux-server-*.log'))) == 1)
        native = next(trace.glob('tmux-server-*.log'))
        assert 'kill-server' in native.read_text()
        replaced = json.loads(tap('status','--json').stdout)
        assert replaced['trace']['deadline_epoch'] == deadline, 'replacement extended the trace window'
        assert replaced['trace']['active'] and replaced['tmux_logging'], replaced
        wait_for(lambda: json.loads(tap('status','--json').stdout)['mode']=='basic')
        wait_for(lambda: len(list(trace.glob('tmux-server-*.log'))) == 2)
        stopped = tap('off','--json')
        assert stopped.returncode == 0, (stopped.stdout,stopped.stderr)
        assert json.loads(stopped.stdout)['recording'] is False
        before = journal.stat().st_size
        (p/'alpha/.tap/bus/registry-events.log').write_text('ts=late action=after-off team=alpha\n')
        time.sleep(1.2)
        assert journal.stat().st_size == before, 'off kept recording'
        # TERM requests a normal owned-log shutdown, even in a long trace.
        interrupted = tap('trace','60','--socket',socket,'--json')
        assert interrupted.returncode == 0, interrupted.stderr
        active = json.loads(interrupted.stdout)
        interrupted_run = pathlib.Path(active['directory'])
        os.kill(collector_pid(interrupted_run), signal.SIGTERM)
        wait_for(lambda: json.loads(tap('status','--json').stdout)['state'] == 'off')
        terminal = json.loads((interrupted_run/'status.json').read_text())
        assert not terminal['recording'] and terminal['trace']['reason'] == 'capture_stopped', terminal
        assert tap('config','--max-mb','0').returncode != 0
        assert tap('trace','nan').returncode != 0
        print('debug: basic mode, cross-team journal, timed trace, native expiry, server death, off PASS')
    finally:
        tap('off')
        tmux('kill-server')
PY
