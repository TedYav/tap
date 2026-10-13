#!/usr/bin/env bash
# Shared scan: irrelevant history must not start an interpreter per payload.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
python3 - "$ROOT" <<'PY'
import json, os, pathlib, shlex, shutil, signal, subprocess, sys, tempfile, time
root = pathlib.Path(sys.argv[1])
with tempfile.TemporaryDirectory(prefix='outstanding-scan-') as tmp:
    base = pathlib.Path(tmp).resolve()
    bus = base/'bus'
    for name in ('payloads', 'receipts', 'spool'):
        (bus/name).mkdir(parents=True)
    wrappers = base/'bin'; wrappers.mkdir()
    launches = base/'launches'
    for name in ('awk', 'python3', 'bun'):
        actual = shutil.which(name)
        assert actual, name
        wrapper = wrappers/name
        wrapper.write_text('#!/bin/bash\nprintf "%s\\n" '+name+' >> "$SCAN_LAUNCHES"\nexec '+shlex.quote(actual)+' "$@"\n')
        wrapper.chmod(0o755)
    env = dict(os.environ, TAP_HOME=str(bus), TAP_SELF='sender', TAP_SPOOL_NOW='1788603000',
               TAP_SPOOL_DISABLE_OPPORTUNISTIC='1', PATH=str(wrappers)+':'+os.environ['PATH'], SCAN_LAUNCHES=str(launches))
    measurements = []
    def run(label):
        launches.write_text('')
        started = time.monotonic()
        p = subprocess.Popen(['bash', str(root/'bin/tap'), 'outstanding', 'sender', '--json'],
                             env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        try:
            out, err = p.communicate(timeout=12)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL); out, err = p.communicate()
            assert 'no outstanding sends' not in out, 'interrupted scan claimed empty'
            raise AssertionError(f'{label}: scan exceeded 12s; launches={len(launches.read_text().splitlines())}')
        elapsed = time.monotonic()-started
        assert p.returncode == 0, (p.returncode, out, err)  # exit 0 either way; the exact row below proves it is listed
        expected = {'ok': True, 'agent': 'sender', 'outstanding': [{'id': 'custom-open-id', 'to': 'peer', 'kind': 'discuss', 'path': str(bus/'payloads'/'custom-open-id.md')}]}
        assert out == json.dumps(expected, separators=(',', ':'))+'\n', out
        names = launches.read_text().splitlines()
        count = len(names)
        measurements.append({'shape': label, 'seconds': elapsed, 'launches': count, 'bun_launches': names.count('bun')})
        print(f'outstanding-scan: {label}: {elapsed:.3f}s; interpreter launches={count}', flush=True)
        assert elapsed < 8, f'{label}: scan exceeded generous 8s budget'
        return count
    def payload(ident, sender):
        (bus/'payloads'/f'{ident}.md').write_text(f'---\nid: {ident}\nfrom: {sender}\nto: peer\nkind: discuss\npath: payloads/{ident}.md\n---\nbody\n')
    payload('custom-open-id', 'sender')  # No sender-prefix optimization may hide this.
    small = run('one open row')
    for n in range(5000):
        payload(f'foreign-{n:012d}', 'other')
    large = run('5k foreign open rows')
    assert large <= small+4, f'forks grow with bus: small={small}, large={large}'
    for n in range(5000):
        (bus/'receipts'/f'foreign-{n:012d}.{ "done" if n%2 else "cancelled" }').touch()
    settled = run('5k settled rows')
    assert settled <= small+4, f'settled history starts interpreters: {settled}'
    assert all(m['bun_launches'] == 1 for m in measurements), measurements
PY
