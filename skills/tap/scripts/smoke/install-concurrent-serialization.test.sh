#!/usr/bin/env bash
# tap-7r3fn.207: two overlapping plain installs sharing install destinations used
# to both exit 0 while one left partial-failure warnings (skipped OpenCode skill
# links on EEXIST, inert core.hooksPath). install.sh now serializes plain runs on
# a home-scoped lock ($HOME/.tap/install.lock) and refuses a contender that
# cannot acquire it in time, with the bootstrap's wait-and-retry wording.
# The :fresh copytree overlays the working tree's src closure onto a HEAD clone
# (same pattern as install-first-run-hardening); assertions are on installer
# behavior only.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
. "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"
if [ "$(id -u)" = 0 ]; then
  echo "install-concurrent-serialization: mode arms are inert as root; run as a normal user" >&2
  exit 1
fi
python3 - "$ROOT" <<'PY'
import os, pathlib, re, shutil, subprocess, sys, tempfile, time

root = pathlib.Path(sys.argv[1])
HOME_KEYS = ('TAP_CLAUDE_HOME', 'TAP_CODEX_HOME', 'TAP_HERMES_HOME', 'TAP_CURSOR_HOME',
             'TAP_OPENCODE_HOME', 'TAP_GEMINI_HOME', 'TAP_CURSOR_AGENT_HOME', 'TAP_AGENTS_HOME')
PARTIAL_FAILURE = re.compile(r"skipped OpenCode skill links|could not set core\.hooksPath|could not write")
REFUSAL = "wait for it to finish"


def fresh(w, name):
    scope = w / name
    scope.mkdir()
    subprocess.run(['git', 'clone', '--quiet', '--shared', str(root), str(scope / 'repo')], check=True)
    repo = (scope / 'repo').resolve()
    shutil.copyfile(root / 'install.sh', repo / 'install.sh')
    shutil.copytree(root / 'runtime/bun/src', repo / 'runtime/bun/src', dirs_exist_ok=True)
    shutil.copytree(root / 'vendor', repo / 'vendor', dirs_exist_ok=True)
    shutil.copytree(root / 'skills', repo / 'skills', dirs_exist_ok=True)
    for source in (repo / 'skills').glob('*/SKILL.md'):
        if not (root / 'skills' / source.parent.name / 'SKILL.md').exists():
            source.unlink()
    (scope / 'home').mkdir()
    env = dict(os.environ, HOME=str(scope / 'home'), TAP_INSTALL_BIN=str(scope / 'bin'),
               TAP_INDEX_HOME=str(scope / 'index'))
    for key in HOME_KEYS:
        env[key] = str(scope / key)
    return scope, repo, env


def run_install(env, repo, *args):
    return subprocess.run(['/bin/bash', str(repo / 'install.sh'), *args], env=env, text=True, capture_output=True)


with tempfile.TemporaryDirectory(prefix='tap-install-concurrent.') as tmp:
    w = pathlib.Path(tmp)

    # Arm 1 — two simultaneous plain installs share one home: the lock serializes
    # them, both succeed, and neither exits 0 carrying partial-failure warnings.
    scope, repo, env = fresh(w, 'serialize')
    procs = [subprocess.Popen(['/bin/bash', str(repo / 'install.sh')], env=env,
                              text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(2)]
    outs = [p.communicate() for p in procs]
    codes = [p.returncode for p in procs]
    assert codes == [0, 0], f'both installs must exit 0 under the lock: {codes}\n' + '\n'.join(
        o[1] for o in outs)
    for i, (_, err) in enumerate(outs):
        assert not PARTIAL_FAILURE.search(err), f'run {i} exited 0 with partial-failure warning:\n{err}'
    lock = scope / 'home' / '.tap' / 'install.lock'
    assert not lock.exists(), f'the home install lock must be released after both runs: {lock}'

    # Arm 2 — a contender cannot acquire the lock in time and refuses, with the
    # bootstrap's wait-and-retry wording, before mutating any destination.
    scope2, repo2, env2 = fresh(w, 'refuse')
    env2['TAP_INSTALL_LOCK_WAIT'] = '1'
    lock = scope2 / 'home' / '.tap' / 'install.lock'
    holder = subprocess.Popen(['sleep', '30'])
    try:
        lock.mkdir(parents=True)
        (lock / 'owner').write_text(f'pid={holder.pid}\nsince=0\nrepo={repo2}\n')
        done = run_install(env2, repo2)
        assert done.returncode == 1, f'contender must refuse with exit 1: {done.returncode}\n{done.stderr}'
        assert REFUSAL in done.stderr, f'refusal must carry the wait-and-retry wording:\n{done.stderr}'
        assert not (scope2 / 'bin' / 'tap').exists(), 'the refused contender must not mutate destinations'
    finally:
        holder.kill()
        holder.wait()
        shutil.rmtree(lock, ignore_errors=True)

    # Arm 3 — wait and retry, deterministically: a live holder keeps the lock
    # for a bounded moment and then releases it; the contender must announce
    # that it waited, acquire after the release, and complete successfully.
    scope3, repo3, env3 = fresh(w, 'wait-retry')
    env3['TAP_INSTALL_LOCK_WAIT'] = '60'
    lock3 = scope3 / 'home' / '.tap' / 'install.lock'
    holder_script = (
        'mkdir -p "$L" && printf "pid=%s\\nsince=0\\nrepo=%s\\n" "$$" "$R" > "$L/owner"'
        ' && sleep 12 && rm -f "$L/owner" && rmdir "$L"\n'
    )
    holder3 = subprocess.Popen(['/bin/bash', '-c', holder_script],
                               env=dict(os.environ, L=str(lock3), R=str(repo3)))
    try:
        done3 = run_install(env3, repo3)
        assert done3.returncode == 0, f'contender must acquire after the holder releases: {done3.returncode}\n{done3.stderr[-2000:]}'
        assert 'waiting up to' in done3.stderr, f'contender must have waited for the lock:\n{done3.stderr[-2000:]}'
    finally:
        holder3.kill()
        holder3.wait()
        shutil.rmtree(lock3, ignore_errors=True)

    # Arm 4 — an unremovable dead-owner lock must fail closed: the reclaim's
    # rename fails, the contender stays bounded and refuses instead of
    # retrying forever. macOS-only via chflags; skipped where unavailable.
    if shutil.which('chflags'):
        scope4, repo4, env4 = fresh(w, 'dead-unremovable')
        env4['TAP_INSTALL_LOCK_WAIT'] = '3'
        lock4 = scope4 / 'home' / '.tap' / 'install.lock'
        lock4.mkdir(parents=True)
        dead = subprocess.Popen(['sleep', '30'])
        dead.kill()
        dead.wait()
        (lock4 / 'owner').write_text(f'pid={dead.pid}\nsince=0\nrepo={repo4}\n')
        subprocess.run(['chflags', 'uchg', str(lock4)], check=True)
        try:
            done4 = run_install(env4, repo4)
            assert done4.returncode == 1, f'unremovable dead lock must refuse: {done4.returncode}\n{done4.stderr[-2000:]}'
            assert REFUSAL in done4.stderr, f'refusal must carry the wait-and-retry wording:\n{done4.stderr[-2000:]}'
        finally:
            subprocess.run(['chflags', 'nouchg', str(lock4)], check=False)
            shutil.rmtree(lock4, ignore_errors=True)

    # Arm 5 — signal in the ownerless window: a stall seam holds the state
    # between trap arming and owner publication open, and the seam's marker
    # file exists only once the release traps are armed, so a SIGTERM there
    # lands in a protected window by construction. The lock directory must be
    # released and destinations stay untouched.
    scope5, repo5, env5 = fresh(w, 'ownerless-window')
    env5['TAP_INSTALL_HOME_LOCK_STALL'] = '8'
    proc5 = subprocess.Popen(['/bin/bash', str(repo5 / 'install.sh')], env=env5,
                             text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    lock5 = scope5 / 'home' / '.tap' / 'install.lock'
    marker5 = lock5 / 'owner.pending'
    deadline = time.monotonic() + 60
    while not marker5.exists():
        assert time.monotonic() < deadline, 'installer never reached the armed ownerless window'
        if proc5.poll() is not None:
            break
    if marker5.exists():
        proc5.terminate()
    out5, err5 = proc5.communicate(timeout=60)
    assert not lock5.exists(), f'a signal in the ownerless window stranded the lock:\n{err5[-2000:]}'
    assert not (scope5 / 'bin' / 'tap').exists(), 'an interrupted install must not mutate destinations'

    # Arm 6 — truthful bounded refusal for an ownerless lock: the stranded
    # state names no pid, so "wait for it to finish" is impossible advice; the
    # refusal must point at removing the lock.
    scope6, repo6, env6 = fresh(w, 'ownerless-refusal')
    env6['TAP_INSTALL_LOCK_WAIT'] = '1'
    lock6 = scope6 / 'home' / '.tap' / 'install.lock'
    lock6.mkdir(parents=True)
    done6 = run_install(env6, repo6)
    assert done6.returncode == 1, f'ownerless lock must refuse: {done6.returncode}\n{done6.stderr}'
    assert 'an owner that has not written its record' in done6.stderr, done6.stderr
    assert 'remove' in done6.stderr and str(lock6) in done6.stderr, done6.stderr

    # Arm 7 — truthful bounded refusal with a stale reclaim guard: the next
    # step must name the guard.
    scope7, repo7, env7 = fresh(w, 'stale-guard-refusal')
    env7['TAP_INSTALL_LOCK_WAIT'] = '1'
    lock7 = scope7 / 'home' / '.tap' / 'install.lock'
    lock7.mkdir(parents=True)
    guard7 = scope7 / 'home' / '.tap' / 'install.lock.reclaim'
    guard7.mkdir()
    done7 = run_install(env7, repo7)
    assert done7.returncode == 1, f'stale-guard lock must refuse: {done7.returncode}\n{done7.stderr}'
    assert 'install.lock.reclaim' in done7.stderr and 'remove' in done7.stderr, done7.stderr

print('install-concurrent-serialization: ok')
PY
