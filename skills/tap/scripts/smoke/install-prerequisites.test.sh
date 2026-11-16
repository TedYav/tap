#!/usr/bin/env bash
# D5: fixture-door — the :15 copytree overlays the working tree's src closure onto a HEAD clone; every assertion is install.sh's public prerequisite refusal/remedy behavior.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
. "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"
python3 - "$ROOT" <<'PY'
import os, pathlib, platform, shlex, shutil, subprocess, sys, tempfile
root = pathlib.Path(sys.argv[1])
with tempfile.TemporaryDirectory() as tmp:
    w = pathlib.Path(tmp); repo = w / 'repo'
    subprocess.run(['git', 'clone', '--quiet', '--shared', str(root), str(repo)], check=True)
    shutil.copyfile(root / 'install.sh', repo / 'install.sh')
    # install.sh's recorder is the Bun manifest module; overlay the current
    # src closure over the clone (the clone sits at HEAD, the test at the
    # working tree).
    shutil.copytree(root / 'runtime/bun/src', repo / 'runtime/bun/src', dirs_exist_ok=True)
    home = w / 'home'; home.mkdir()
    bindir = w / "tools with ' quote"
    env = dict(os.environ, HOME=str(home), TAP_INSTALL_BIN=str(bindir), TAP_INSTALL_HOOK='0',
               TAP_INDEX_HOME=str(w / 'index'))
    for key in ('TAP_CLAUDE_HOME', 'TAP_CODEX_HOME', 'TAP_HERMES_HOME', 'TAP_CURSOR_HOME',
                'TAP_OPENCODE_HOME', 'TAP_GEMINI_HOME', 'TAP_CURSOR_AGENT_HOME', 'TAP_AGENTS_HOME'):
        env[key] = str(w / key)
    def install(test_env):
        return subprocess.run(['/bin/bash', str(repo / 'install.sh')], env=test_env, text=True, capture_output=True)
    missing = w / 'missing'; missing.mkdir()
    (missing / 'dirname').symlink_to(shutil.which('dirname'))
    result = install(dict(env, PATH=str(missing)))
    assert result.returncode == 127 and 'git was not found on PATH' in result.stderr, result
    assert 'lsof was not found on PATH' in result.stderr, result
    # The remedy names only this platform's commands. With nothing on PATH the
    # installer reads the platform from the shell itself.
    mac = sys.platform == 'darwin'
    brew = '/opt/homebrew/bin/brew' if platform.machine() in ('arm64', 'aarch64') else '/usr/local/bin/brew'
    if mac:
        assert brew + ' install git bash jq tmux oven-sh/bun/bun' in result.stderr, result
        assert 'macOS already includes lsof, tar' in result.stderr, result
        assert 'apt install' not in result.stderr and 'bun.sh/install' not in result.stderr, result
    else:
        assert 'sudo apt install git bash jq tmux tar lsof' in result.stderr, result
        assert 'curl -fsSL https://bun.sh/install | bash' in result.stderr, result
        assert 'brew' not in result.stderr, result
    assert 'Python 3.11' not in result.stderr and not bindir.exists(), 'python is not a requirement, and missing deps wrote installation targets'
    # A broken python3 does not block installation: the pin is best-effort.
    (missing / 'python3').write_text('#!/bin/sh\nexit 7\n')
    (missing / 'python3').chmod(0o755)
    result = install(dict(env, PATH=str(missing)))
    assert result.returncode == 127 and 'git was not found on PATH' in result.stderr, result
    assert 'Python 3.11 or newer' not in result.stderr and 'Traceback' not in result.stderr and not bindir.exists(), result
    (missing / 'python3').unlink()
    result = install(dict(env, PATH=str(missing)))
    assert result.returncode == 127 and 'bun was not found on PATH' in result.stderr, result
    if mac:
        assert 'eval "$(' + brew + ' shellenv)"' in result.stderr and 'https://brew.sh' in result.stderr, result
        other = '/usr/local/bin/brew' if brew.startswith('/opt') else '/opt/homebrew/bin/brew'
        assert other not in result.stderr, result
    assert 'command not found' not in result.stderr, result
    assert not bindir.exists(), result
    shim_path = str(missing) + os.pathsep + env['PATH']
    # One tool missing: the remedy names that tool and nothing else. The farm holds
    # every command on the real PATH except jq.
    farm = w / 'farm'; farm.mkdir()
    for d in env['PATH'].split(os.pathsep):
        if not os.path.isdir(d): continue
        for name in os.listdir(d):
            if name != 'jq' and not (farm / name).exists():
                try: (farm / name).symlink_to(os.path.join(d, name))
                except OSError: pass
    result = install(dict(env, PATH=str(farm)))
    assert result.returncode == 127 and 'install: jq was not found on PATH' in result.stderr, result
    remedy = result.stderr.split('install: install what is missing, then rerun ./install.sh:\n', 1)[1]
    assert 'jq' in remedy and not any(t in remedy for t in ('git', 'tmux', 'lsof', 'bun', 'bash ')), result
    assert ('brew install jq' in remedy) if mac else ('install jq' in remedy or 'pacman -S jq' in remedy), result
    assert not bindir.exists(), result
    # tmux below 3.2: the install is not refused, the report says the two tmux
    # questions are not asked, and the version is named.
    (missing / 'tmux').write_text('#!/bin/sh\necho "tmux 3.1c"\n')
    (missing / 'tmux').chmod(0o755)
    result = subprocess.run(['/bin/bash', str(repo / 'install.sh'), '--report'], env=dict(env, PATH=shim_path), text=True, capture_output=True)
    assert result.returncode == 0 and 'tmux 3.1c, git' in result.stdout, result
    assert 'install: note: tmux 3.1c is older than 3.2' in result.stdout, result
    assert 'tmux questions: not asked, because tmux 3.1c is older than 3.2; no tmux file is edited' in result.stdout, result
    assert 'tmux question 1' not in result.stdout, result
    # A version that cannot be read is not evidence of an old tmux: the installer
    # says it could not read it, never "older than", and still asks both questions.
    for body in ('#!/bin/sh\nexit 1\n', '#!/bin/sh\necho "tmux master"\n'):
        (missing / 'tmux').write_text(body)
        (missing / 'tmux').chmod(0o755)
        result = subprocess.run(['/bin/bash', str(repo / 'install.sh'), '--report'], env=dict(env, PATH=shim_path), text=True, capture_output=True)
        assert result.returncode == 0 and 'tmux (version unreadable), git' in result.stdout, result
        assert 'older than' not in result.stdout and 'not asked' not in result.stdout, result
        assert "install: note: could not read a version from 'tmux -V'" in result.stdout, result
        assert 'tmux question 1 (default yes)' in result.stdout and 'tmux question 2 (default yes)' in result.stdout, result
    (missing / 'tmux').unlink()
    result = subprocess.run(['/bin/bash', str(repo / 'install.sh'), '--report'], env=dict(env, PATH=shim_path), text=True, capture_output=True)
    assert result.returncode == 0 and 'tmux question 1 (default yes)' in result.stdout and 'older than 3.2' not in result.stdout, result
    assert 'could not read a version' not in result.stdout, result
    # The Bash requirement applies to the interpreter running the installer. An old
    # Bash with no newer one on PATH refuses and names both versions; with a newer
    # one first on PATH the run continues under it.
    old_bash = next((b for b in ('/bin/bash',) if subprocess.run([b, '-c', 'test "${BASH_VERSINFO[0]}" -lt 5']).returncode == 0), None)
    if old_bash:
        (missing / 'bash').symlink_to(old_bash)
        result = install(dict(env, PATH=shim_path))
        assert result.returncode == 127 and 'install: Bash 5 or newer is required (this run is under Bash 3.' in result.stderr, result
        assert not bindir.exists(), result
        (missing / 'bash').unlink()
        result = subprocess.run([old_bash, str(repo / 'install.sh'), '--report'], env=dict(env, PATH=shim_path), text=True, capture_output=True)
        assert result.returncode == 0 and 'install: requirements OK: bash 5.' in result.stdout, result
    (missing / 'bun').write_text('#!/bin/sh\necho 1.2.14\n')
    (missing / 'bun').chmod(0o755)
    result = install(dict(env, PATH=shim_path))
    assert result.returncode == 127 and 'Bun 1.4.0 or newer is required (found 1.2.14)' in result.stderr, result
    assert not bindir.exists(), result
    (missing / 'bun').write_text('#!/bin/sh\necho 1.4.0-canary.3\n')
    result = install(dict(env, PATH=shim_path))
    assert result.returncode == 127 and 'not a supported X.Y.Z release version' in result.stderr, result
    assert not bindir.exists(), result
    (missing / 'bun').write_text('#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.4.0; else exec ' +
        shlex.quote(shutil.which('bun')) + ' "$@"; fi\n')
    result = install(dict(env, PATH=shim_path))
    assert result.returncode == 0 and 'install: requirements OK' in result.stdout, result
    assert 'bun 1.4.0' in result.stdout, result
    assert 'Bun 1.4.0 or newer' not in result.stderr and 'not a supported X.Y.Z' not in result.stderr, result
    (missing / 'bun').unlink()
    # Existing shared adapter: missing/failed Bun names the slice, never a default.
    adapter = '. "$1"; TAP_SMOKE_BUN=bun PATH="$2"; tap_bun_call prereq-control original-id unused.ts'
    result = subprocess.run(['/bin/bash', '-c', adapter, '_', str(root/'skills/tap/scripts/smoke/runtime-helpers.sh'), str(missing)], env=env, text=True, capture_output=True)
    assert result.returncode != 0 and not result.stdout, result
    assert 'runtime_missing id=original-id slice=prereq-control' in result.stderr, result
    (missing / 'bun').write_text('#!/bin/sh\nexit 7\n')
    (missing / 'bun').chmod(0o755)
    result = subprocess.run(['/bin/bash', '-c', adapter, '_', str(root/'skills/tap/scripts/smoke/runtime-helpers.sh'), str(missing)], env=env, text=True, capture_output=True)
    assert result.returncode != 0 and not result.stdout, result
    assert 'slice_failed id=original-id slice=prereq-control' in result.stderr, result
    result = install(env)
    assert result.returncode == 0 and 'links installed; shell setup required' in result.stderr, result
    assert 'interactive machine setup skipped (no terminal)' in result.stdout, result
    assert 'tap setup --machine --answers <file>' in result.stdout and '--dry-run' in result.stdout, result
    assert 'tap launch <harness> [name]' in result.stdout, result
    assert 'install: done' not in result.stdout and (bindir / 'tap').is_symlink(), result
    remedy = next(line.split('run in this terminal: ', 1)[1] for line in result.stderr.splitlines() if 'run in this terminal:' in line)
    check = subprocess.run(['/bin/bash', '-c', remedy + '\ncommand -v tap\ntap help'], env=env, text=True, capture_output=True)
    assert check.returncode == 0 and check.stdout.splitlines()[0] == str(bindir / 'tap'), check
    result = install(dict(env, PATH=str(bindir) + os.pathsep + env['PATH']))
    assert result.returncode == 0 and 'install: done' in result.stdout, result
print('install-prerequisites: missing tools refuse before writes with a remedy for this platform and only the missing tools; old tmux skips the tmux offers; an old interpreter Bash continues under Bash 5 or refuses; python3 is not required; shared adapter fails loud; quoted PATH remedy enables installed tap')
PY
