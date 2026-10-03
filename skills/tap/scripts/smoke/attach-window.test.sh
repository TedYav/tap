#!/usr/bin/env bash
# Real clients and panes, all on this runner's private tmux server.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
AW_TMUX="$(command -v tmux)" python3 -B - "$ROOT" <<'AW_PY'
import json, os, pathlib, pty, shlex, subprocess, sys, tempfile, time
root = pathlib.Path(sys.argv[1])
with tempfile.TemporaryDirectory() as scratch:
    work = pathlib.Path(scratch).resolve()
    socket = 'attach-window-' + str(os.getpid())
    real = os.environ['AW_TMUX']
    # The decoy default server lives under the runner-owned TMUX_TMPDIR; every
    # default-socket touch below derives this path explicitly and startup fails
    # closed when the runner root is absent, so cleanup can never fall back to
    # an unpinned kill-server against an arbitrary machine-wide default.
    tmux_tmpdir = os.environ.get('TMUX_TMPDIR')
    if not tmux_tmpdir or not os.path.isdir(tmux_tmpdir):
        raise SystemExit('attach-window: runner-owned TMUX_TMPDIR absent; refusing default-socket work')
    decoy_socket = os.path.join(tmux_tmpdir, 'tmux-%d' % os.getuid(), 'default')
    # A live machine index enrolls team demo at a scratch root; its acting bus
    # is the root's .tap/bus, which TAP_HOME names.
    demo = work/'demo'; bus = demo/'.tap/bus'
    env = dict(os.environ, TERM='xterm-256color', TAP_HOME=str(bus),
               TAP_INDEX_HOME=str(work/'index'), AW_SOCKET=socket, AW_REAL_TMUX=real)
    for key in ('TMUX', 'TMUX_PANE', 'TAP_SELF', 'TAP_HANDLE', 'TAP_SERVER_EPOCH', 'TAP_BOOT_ID'):
        env.pop(key, None)
    bindir = work/'bin'; bindir.mkdir()
    shim = bindir/'tmux'
    shim.write_text('''#!/bin/sh
if [ "${AW_REBIND:-}" = 1 ] && [ "$*" = 'display-message -p -t =demo/driver:1.1 #{pane_id}' ]; then
    "$AW_REAL_TMUX" -L "$AW_SOCKET" kill-pane -t '=demo/driver:1.1' || exit
    "$AW_REAL_TMUX" -L "$AW_SOCKET" split-window -d -t '=demo/driver:1.0' 'sleep 120' || exit
fi
exec "$AW_REAL_TMUX" -L "$AW_SOCKET" "$@"
''')
    shim.chmod(0o755)
    env['PATH'] = str(bindir) + os.pathsep + env['PATH']
    # A sleeping executable whose observed basename is an agent family.
    (bindir/'claude').symlink_to('/bin/sleep')
    check = subprocess.run([str(bindir/'claude'), '0'], env=env, capture_output=True, text=True)
    assert check.returncode == 0, (check.returncode, check.stderr)
    bus.mkdir(parents=True); (work/'index').mkdir()
    def tmux(*args):
        return subprocess.check_output([real, '-L', socket, *args], env=env, text=True, timeout=5).strip()
    child = None; terminal = None
    try:
        tmux('new-session', '-d', '-s', 'demo/driver', str(bindir/'claude')+' 120')
        tmux('new-window', '-d', '-t', '=demo/driver', '-n', 'automatically-renamed', str(bindir/'claude')+' 120')
        pane = tmux('split-window', '-d', '-t', '=demo/driver:1', '-P', '-F', '#{pane_id}', str(bindir/'claude')+' 120')
        # No machine index: a team-qualified attach refuses before any tmux
        # effect; the legacy teams.json / bus-local arm is gone (F2b).
        (bus/'registry.json').write_text(json.dumps({'schema': '0.20', 'team':{'name':'demo'},'seats':{'grok':dict(
            status='active', harness='claude', session='demo/driver', pane='demo/driver:1.1', pane_id=pane)}}))
        (work/'index/teams.json').write_text(json.dumps({'teams':{'demo':{'root':str(demo)}}}))
        absent = subprocess.run(['bash',str(root/'scripts/tap.sh'),'attach','--no-resume','demo/grok'],
                                env=env, capture_output=True, text=True, timeout=10)
        assert absent.returncode != 0, absent
        assert 'no machine index (global-registry.json)' in absent.stderr, absent.stderr
        assert 'tap init  OR  tap session launch' in absent.stderr, absent.stderr
        assert not tmux('list-clients'), 'absent machine index moved a client'
        print('attach-window: no machine index refuses a team-qualified attach: ok')
        (work/'index/global-registry.json').write_text(json.dumps({'schema': '0.20', 'teams': {'demo': {
            'root': str(demo), 'registry_location': str(bus/'registry.json'), 'state': 'registered'}}}))
        for crew in (False, True):
            row = dict(status='active', harness='claude', session='demo/driver',
                       pane='demo/driver:1.1', pane_id=pane, crew=crew)
            (bus/'registry.json').write_text(json.dumps({'schema': '0.20', 'team':{'name':'demo'},'seats':{'grok':row}}))
            tmux('select-window', '-t', '=demo/driver:0')
            tmux('select-pane', '-t', '=demo/driver:1.0')
            terminal, slave = pty.openpty()
            child = subprocess.Popen(['bash', str(root/'scripts/tap.sh'), 'attach', 'grok'],
                                     env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
            os.close(slave)
            os.set_blocking(terminal, False)
            output = b''
            clients = ''
            deadline = time.monotonic()+8
            while time.monotonic() < deadline:
                clients = tmux('list-clients', '-F', '#{session_name}:#{window_index}.#{pane_index}')
                if clients: break
                try: output += os.read(terminal, 65536)
                except (BlockingIOError, OSError): pass
                if child.poll() is not None:
                    raise AssertionError('attach exited before reaching a client: '+output.decode(errors='replace'))
                time.sleep(.05)
            assert clients == 'demo/driver:1.1', f'crew={crew}: attach landed on {clients!r}, not registered pane'
            tmux('detach-client', '-s', '=demo/driver')
            os.close(terminal); terminal = None
            child.wait(timeout=5); child = None
            print(f'attach-window: crew={crew}, renamed foreign-session window and split pane reached: ok')
        # A real terminal viewing another session exercises switch-client and
        # its caller-client identity check, not the outside attach arm.
        tmux('new-session', '-d', '-s', 'caller', '/bin/bash --noprofile --norc')
        tmux('select-window', '-t', '=demo/driver:0')
        tmux('select-pane', '-t', '=demo/driver:1.0')
        terminal, slave = pty.openpty()
        child = subprocess.Popen([real,'-L',socket,'attach-session','-t','=caller'],
                                 env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        deadline = time.monotonic()+8
        while time.monotonic() < deadline:
            if tmux('list-clients', '-F', '#{session_name}') == 'caller': break
            time.sleep(.05)
        else: raise AssertionError('fixture client never attached to caller')
        command = shlex.join(['env', 'PATH='+env['PATH'], 'TAP_HOME='+env['TAP_HOME'],
                              'TAP_INDEX_HOME='+env['TAP_INDEX_HOME'],
                              'bash', str(root/'scripts/tap.sh'), 'attach', 'grok'])
        tmux('send-keys', '-t', '=caller:0.0', '-l', command)
        tmux('send-keys', '-t', '=caller:0.0', 'Enter')
        deadline = time.monotonic()+8
        while time.monotonic() < deadline:
            clients = tmux('list-clients', '-F', '#{session_name}:#{window_index}.#{pane_index}')
            if clients == 'demo/driver:1.1': break
            time.sleep(.05)
        assert clients == 'demo/driver:1.1', (clients, tmux('capture-pane','-p','-t','=caller:0.0'))
        tmux('detach-client', '-s', '=demo/driver')
        os.close(terminal); terminal = None
        child.wait(timeout=5); child = None
        print('attach-window: inside caller switches its client to the registered split pane: ok')
        no_tty = subprocess.run(['bash',str(root/'scripts/tap.sh'),'attach','grok'],
                                env=env, capture_output=True, text=True, timeout=10)
        assert no_tty.returncode != 0, no_tty
        assert "session 'demo/driver', window/pane '1.1'" in no_tty.stderr, no_tty.stderr
        assert "tmux attach -t '=demo/driver:1.1'" in no_tty.stderr, no_tty.stderr
        print('attach-window: no-terminal fallback names the found session/window/pane: ok')
        # A stale generation must not authorize navigation through a recycled id.
        row['server_epoch'] = 'stale-generation'
        row['server_socket'] = tmux('display-message','-p','#{socket_path}')
        (bus/'registry.json').write_text(json.dumps({'schema': '0.20', 'team':{'name':'demo'},'seats':{'grok':row}}))
        stale = subprocess.run(['bash',str(root/'scripts/tap.sh'),'attach','--no-resume','grok'],
                               env=env, capture_output=True, text=True, timeout=10)
        # The reader judges the stale stamp directly; no dispatch-time rewrite
        # turns it into server_restarted first (registry-unit-1-part-08).
        assert stale.returncode != 0 and 'server_epoch_stale' in stale.stdout+stale.stderr, stale
        assert not tmux('list-clients'), 'stale row moved a client'
        print('attach-window: stale server generation refuses navigation: ok')
        del row['server_epoch']
        (bus/'registry.json').write_text(json.dumps({'schema': '0.20', 'team':{'name':'demo'},'seats':{'grok':row}}))
        tmux('select-window', '-t', '=demo/driver:0')
        rebound = subprocess.run(['bash',str(root/'scripts/tap.sh'),'attach','grok'],
                                 env=dict(env, AW_REBIND='1'), capture_output=True, text=True, timeout=10)
        assert rebound.returncode != 0 and 'pane binding changed' in rebound.stderr, rebound
        assert "session 'demo/driver', window/pane '1.1'" in rebound.stderr, rebound.stderr
        assert tmux('display-message','-p','-t','=demo/driver:1.1','#{pane_id}') != pane
        windows = tmux('list-windows','-t','=demo/driver','-F','#{window_index}:#{window_active}')
        assert '0:1' in windows.splitlines(), windows
        assert not tmux('list-clients'), 'rebound pane moved a client'
        print('attach-window: real pane replacement before point-of-use refuses navigation: ok')
        tmux('kill-session', '-t', '=demo/driver')
        gone = subprocess.run(['bash',str(root/'scripts/tap.sh'),'attach','--no-resume','grok'],
                              env=env, capture_output=True, text=True, timeout=10)
        assert gone.returncode != 0 and 'session_absent' in gone.stderr, gone
        assert 'registered location: demo/driver:1.1' in gone.stderr, gone.stderr
        assert not tmux('list-clients'), 'gone session moved a client'
        print('attach-window: gone session fallback names its registered location: ok')
        # R11 repair: effects must ride the server TAP selected (production pin),
        # so the shim stops pinning and only records; the pin now comes from
        # TAP_TMUX_SOCKET_PATH alone, as a production caller would set it.
        shim.write_text('#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$AW_EFFECT_LOG"\n'
                        'if [ "${AW_STALL_SWITCH:-0}" = 1 ]; then for a in "$@"; do [ "$a" = switch-client ] && sleep 30; done; fi\n'
                        'exec "$AW_REAL_TMUX" "$@"\n')
        (work/'effects.log').write_text('')
        env.update(TAP_TMUX_SOCKET_PATH=os.path.join(os.environ.get('TMUX_TMPDIR') or '/tmp', 'tmux-%d' % os.getuid(), socket),
                   AW_EFFECT_LOG=str(work/'effects.log'), TAP_TMUX_TIMEOUT_SECONDS='1')
        tmux('new-session','-d','-s','demo/driver',str(bindir/'claude')+' 120')
        tmux('new-window','-d','-t','=demo/driver','-n','automatically-renamed',str(bindir/'claude')+' 120')
        pane = tmux('split-window','-d','-t','=demo/driver:1','-P','-F','#{pane_id}',str(bindir/'claude')+' 120')
        row = dict(status='active', harness='claude', session='demo/driver', pane='demo/driver:1.1', pane_id=pane)
        (bus/'registry.json').write_text(json.dumps({'schema': '0.20', 'team':{'name':'demo'},'seats':{'grok':row}}))
        # A same-named decoy on the DEFAULT socket: a pin-ignoring effect lands
        # here instead of the pinned server, which is exactly the defect.
        subprocess.run([real,'new-session','-d','-s','demo/driver','sleep','120'],env=env,timeout=5)
        assert os.path.exists(decoy_socket), 'derived decoy socket is absent'
        # A window/pane mirror on the decoy makes the inherited-TMUX case below
        # prove the exact harm: a pin-ignoring effect lands on a same-named
        # session that TAP never verified.
        subprocess.run([real,'new-window','-d','-t','demo/driver','-n','automatically-renamed','sleep','120'],env=env,timeout=5)
        subprocess.run([real,'split-window','-d','-t','demo/driver:1','-P','-F','#{pane_id}','sleep','120'],env=env,timeout=5)
        terminal, slave = pty.openpty()
        child = subprocess.Popen(['bash', str(root/'scripts/tap.sh'), 'attach', '--no-resume', 'grok'],
                                 env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        deadline = time.monotonic()+8
        while time.monotonic() < deadline:
            clients = tmux('list-clients','-F','#{session_name}:#{window_index}.#{pane_index}')
            if clients: break
            time.sleep(.05)
        assert clients == 'demo/driver:1.1', f'pinned attach landed on {clients!r}, not the pinned pane'
        effects = (work/'effects.log').read_text()
        assert f'-S {env["TAP_TMUX_SOCKET_PATH"]}' in effects and 'attach-session' in effects, effects
        assert subprocess.run([real,'list-clients'],env=env,capture_output=True,text=True,timeout=5).stdout == '', 'default decoy server received the effect'
        time.sleep(1.6)
        assert tmux('list-clients','-F','#{session_name}:#{window_index}.#{pane_index}') == 'demo/driver:1.1', 'attach-session died within TAP_TMUX_TIMEOUT_SECONDS'
        print('attach-window: production socket pin reaches the effect; unbounded attach survives the deadline: ok')
        tmux('detach-client','-s','=demo/driver')
        os.close(terminal); terminal = None
        child.wait(timeout=5); child = None
        # switch-client is bounded: a stall AFTER successful observation dies at
        # the deadline, exactly once, as the attach refusal.
        terminal, slave = pty.openpty()
        child = subprocess.Popen([real,'-L',socket,'attach-session','-t','=caller'],
                                 env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        deadline = time.monotonic()+8
        while time.monotonic() < deadline:
            if tmux('list-clients','-F','#{session_name}') == 'caller': break
            time.sleep(.05)
        else: raise AssertionError('stall fixture client never attached to caller')
        (work/'stall-run.sh').write_text('#!/bin/bash\n'
            f'export PATH={shlex.quote(env["PATH"])} TAP_HOME={shlex.quote(env["TAP_HOME"])} '
            f'TAP_INDEX_HOME={shlex.quote(env["TAP_INDEX_HOME"])} TAP_TMUX_SOCKET_PATH={shlex.quote(env["TAP_TMUX_SOCKET_PATH"])} '
            f'TAP_TMUX_TIMEOUT_SECONDS=1 AW_STALL_SWITCH=1 AW_EFFECT_LOG={shlex.quote(env["AW_EFFECT_LOG"])} '
            f'AW_REAL_TMUX={shlex.quote(env["AW_REAL_TMUX"])}\n'
            f'exec bash {root}/scripts/tap.sh attach grok\n')
        tmux('send-keys','-t','=caller:0.0','-l',f'bash {work}/stall-run.sh')
        tmux('send-keys','-t','=caller:0.0','Enter')
        deadline = time.monotonic()+8
        pane = ''
        while time.monotonic() < deadline:
            pane = tmux('capture-pane','-p','-t','=caller:0.0')
            if 'could not attach' in pane: break
            time.sleep(.1)
        assert 'could not attach' in pane, pane
        switches = [line for line in (work/'effects.log').read_text().splitlines() if line.endswith('switch-client') or ' switch-client ' in line]
        assert len(switches) == 1, f'switch-client must fire once with no retry: {switches} log={(work/"effects.log").read_text()!r}'
        assert tmux('list-clients','-F','#{session_name}:#{window_index}.#{pane_index}') == 'caller:0.0', 'stalled switch moved a client'
        print('attach-window: stalled switch-client dies bounded at the deadline, once: ok')
        tmux('detach-client','-s','=caller')
        os.close(terminal); terminal = None
        child.wait(timeout=5); child = None
        # R11 round 2: an outside caller inheriting the decoy server's TMUX must
        # not drag the effect there. Reads preferred the TAP pin; the effect
        # must land on the pinned pane, and the same-named decoy pane gains no
        # client.
        terminal, slave = pty.openpty()
        child = subprocess.Popen(['bash', str(root/'scripts/tap.sh'), 'attach', '--no-resume', 'grok'],
                                 env=dict(env, TMUX=decoy_socket+',%d,0' % os.getpid()),
                                 stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        deadline = time.monotonic()+8
        clients = ''
        while time.monotonic() < deadline:
            clients = tmux('list-clients','-F','#{session_name}:#{window_index}.#{pane_index}')
            if clients: break
            try: os.read(terminal, 65536)
            except (BlockingIOError, OSError): pass
            if child.poll() is not None:
                raise AssertionError('inherited-TMUX attach exited before reaching a client: '+tmux('capture-pane','-p','-t','=caller:0.0'))
            time.sleep(.05)
        assert clients == 'demo/driver:1.1', f'inherited-TMUX attach landed on {clients!r}, not the pinned pane'
        attach_lines = [line for line in (work/'effects.log').read_text().splitlines() if 'attach-session' in line]
        assert attach_lines and env['TAP_TMUX_SOCKET_PATH'] in attach_lines[-1], attach_lines
        assert subprocess.run([real,'list-clients'],env=env,capture_output=True,text=True,timeout=5).stdout == '', 'inherited TMUX dragged the effect to the decoy server'
        print('attach-window: TAP pin outranks an inherited TMUX socket for the effect: ok')
        tmux('detach-client','-s','=demo/driver')
        os.close(terminal); terminal = None
        child.wait(timeout=5); child = None
    finally:
        subprocess.run([real,'-L',socket,'kill-server'],env=env,capture_output=True,timeout=5)
        subprocess.run([real,'-S',decoy_socket,'kill-server'],env=env,capture_output=True,timeout=5)
        if terminal is not None: os.close(terminal)
        if child is not None:
            child.kill()
            child.wait(timeout=5)
AW_PY
