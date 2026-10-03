#!/usr/bin/env bash
# A tiny fixture suite reaches the public runner without running TAP's full suite.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/repo/scripts" "$WORK/repo/skills/tap/scripts/smoke" "$WORK/home" "$WORK/locks"
cp "$ROOT/scripts/smoke-all.sh" "$ROOT/scripts/ignored-state-tripwire.py" "$ROOT/scripts/suite-slot-run.py" "$ROOT/scripts/suite_slot.py" "$WORK/repo/scripts/"
cp "$ROOT/skills/tap/scripts/smoke/smoke-preflight.sh" "$ROOT/skills/tap/scripts/smoke/smoke_hermeticity_lint.py" "$WORK/repo/skills/tap/scripts/smoke/"
cat > "$WORK/repo/skills/tap/scripts/smoke/fixture.test.sh" <<'WORKER'
#!/usr/bin/env bash
[ -z "${TAP_RUNNER_ALLOW+x}" ] || exit 88
# A worker must be able to install INT traps despite asynchronous dispatch.
bash -c 'trap "exit 0" INT; kill -INT $$; exit 89' || exit 89
exit 0
WORKER
cat > "$WORK/sync-cli.js" <<'PY'
# Fixture daemon parent: the name is diagnostic, not executable matching authority.
import json,os,pathlib,pty,signal,subprocess,sys,time
signal.signal(signal.SIGINT,signal.SIG_DFL)
work=pathlib.Path(sys.argv[1]);repo=work/'repo';runner=repo/'scripts/smoke-all.sh'
env={k:v for k,v in os.environ.items() if not k.startswith('TAP_')}
env.update(HOME=str(work/'home'),TAP_SUITE_LOCK_HOME=str(work/'locks'),SMOKE_ALL_MIN_FILES='1',TAP_SUITE_SLOT='bypass')
failures=[]
p=subprocess.run(['bash',str(runner),'-j','1'],cwd=repo,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=30)
if p.returncode==0 or 'TAP_RUNNER_ALLOW' not in p.stdout:
    failures.append('RED admission: daemon parent with no tty/allow entered the fixture suite; rc='+str(p.returncode))
    print(p.stdout[-2000:])
else:
    if 'ancestor pid='+str(os.getpid()) not in p.stdout:
        failures.append('refusal did not identify the fixture parent')
    print('admission: no-tty daemon refused with explicit allowance remedy')
invalid=env.copy();invalid['TAP_RUNNER_ALLOW']='0'
p=subprocess.run(['bash',str(runner),'-j','1'],cwd=repo,env=invalid,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=30)
if p.returncode!=78:failures.append('nonliteral allowance bypassed admission')
master,slave=pty.openpty()
try:
    p=subprocess.run(['bash',str(runner),'-j','1'],cwd=repo,env=env,stdin=slave,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=30)
    if p.returncode:failures.append('interactive caller wrongly refused: '+p.stdout[-1500:])
finally:
    os.close(slave);os.close(master)
allowed=env.copy();allowed['TAP_RUNNER_ALLOW']='1'
p=subprocess.run(['bash',str(runner),'-j','1'],cwd=repo,env=allowed,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=30)
if p.returncode:failures.append('explicit allowance did not run cleanly: '+p.stdout[-1500:])
for flags in (['--help'],['--only','skills/tap/scripts/smoke/fixture.test.sh']):
    p=subprocess.run(['bash',str(runner),*flags],cwd=repo,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=30)
    if p.returncode:failures.append('focused/help command wrongly refused: '+p.stdout[-1500:])
# Actual workers disclose their own identities. Teardown signals only a process
# captured in this fixture's ancestry census, never a command-name match.
original_runner=runner.read_text()
def run_signal(signame, phase='worker'):
    env.pop('TAP_SUITE_SLOT',None)
    runner.write_text(original_runner)
    if phase == 'wrapper':
        needle = '  s="$1"\n'
        assert original_runner.count(needle)==1
        barrier = '  printf "%s\\n" "$$" > '+str(work/'worker.pid')+'\n  sleep 300 &\n  printf "%s\\n" "$!" > '+str(work/'sleeper.pid')+'\n  wait\n'
        runner.write_text(original_runner.replace(needle,needle+barrier))
    if phase == 'dispatch-ledger':
        needle = 'pid = os.getpid()\n'
        assert original_runner.count(needle)==1
        barrier = "if os.environ.get(\"SMOKE_WAVE_PIDS\", \"\").endswith(\"/dispatch-pids\"):\n    import pathlib, time\n    pathlib.Path(%s).write_text(str(pid))\n    pathlib.Path(%s).write_text(str(pid))\n    time.sleep(300)\n" % (json.dumps(str(work/'worker.pid')), json.dumps(str(work/'sleeper.pid')))
        runner.write_text(original_runner.replace(needle,needle+barrier))
    if phase in ('entry-capture', 'dispatch-capture'):
        needle = '  entry_pid=$!\n' if phase == 'entry-capture' else '  SMOKE_DISPATCH_PID=$!\n'
        assert original_runner.count(needle)==1
        # Hold only the capture interval; builtins preserve the last child PID.
        pending='entry_signal' if phase == 'entry-capture' else '_dispatch_signal'
        barrier = '  while [ "${'+pending+':-0}" = 0 ]; do :; done\n'
        runner.write_text(original_runner.replace(needle,barrier+needle))
    for pidfile in ('worker.pid','sleeper.pid'):
        (work/pidfile).unlink(missing_ok=True)
    (repo/'skills/tap/scripts/smoke/fixture.test.sh').write_text('''#!/usr/bin/env bash
    printf '%s\\n' "$$" > %s
    sleep 300 &
    printf '%%s\\n' "$!" > %s
    wait
    ''' % ('%s',work/'worker.pid',work/'sleeper.pid'))
    env['TAP_RUNNER_ALLOW']='1'
    foreign=subprocess.Popen(['sleep','300'],start_new_session=True)
    log=(work/'term.log').open('w')
    p=subprocess.Popen(['bash',str(runner),'-j','1'],cwd=repo,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
    owned={p.pid}
    def census():
        rows={}
        for line in subprocess.check_output(['ps','-axo','pid=,ppid='],text=True).splitlines():
            try:a,b=map(int,line.split());rows[a]=b
            except ValueError:pass
        while True:
            added={pid for pid,parent in rows.items() if parent in owned}-owned
            if not added:break
            owned.update(added)
    def alive(pid):
        try:os.kill(pid,0);return True
        except ProcessLookupError:return False
    try:
        for _ in range(150):
            census()
            if (work/'sleeper.pid').exists():break
            if p.poll() is not None:break
            time.sleep(.1)
        if not (work/'sleeper.pid').exists():
            failures.append('fixture did not reach worker: '+(work/'term.log').read_text()[-1500:])
        else:
            worker=int((work/'worker.pid').read_text());sleeper=int((work/'sleeper.pid').read_text());owned.update([worker,sleeper]);census()
            p.send_signal(getattr(signal, signame))
            for _ in range(60):
                if p.poll() is not None and not alive(worker) and not alive(sleeper):break
                time.sleep(.1)
            if p.poll() is None or alive(worker) or alive(sleeper):
                failures.append('RED '+signame+' at '+phase+': runner termination left recorded fixture workers alive; '+(work/'term.log').read_text()[-2000:])
            else:
                remaining=[pid for pid in owned if alive(pid)]
                if remaining:failures.append('recorded runner ancestors survived: '+str(remaining))
                else:print(signame+' at '+phase+': public runner and all recorded descendants exited')
                expected=128+getattr(signal,signame)
                if p.returncode!=expected:failures.append('wrong signal exit: '+str(p.returncode)+' expected '+str(expected))
            if foreign.poll() is not None:failures.append('unrelated sibling process was reaped')
    finally:
        census()
        for pid in sorted(owned,reverse=True):
            try:os.kill(pid,signal.SIGTERM)
            except ProcessLookupError:pass
        try:p.wait(timeout=3)
        except subprocess.TimeoutExpired:
            for pid in sorted(owned,reverse=True):
                try:os.kill(pid,signal.SIGKILL)
                except ProcessLookupError:pass
            p.wait(timeout=3)
        foreign.terminate();foreign.wait(timeout=3)
        log.close()
run_signal('SIGTERM')
run_signal('SIGINT')
run_signal('SIGHUP')
run_signal('SIGTERM', 'wrapper')
run_signal('SIGTERM', 'dispatch-ledger')
run_signal('SIGTERM', 'entry-capture')
run_signal('SIGTERM', 'dispatch-capture')
for failure in failures:print(failure,file=sys.stderr)
raise SystemExit(bool(failures))
PY
python3 "$WORK/sync-cli.js" "$WORK"
