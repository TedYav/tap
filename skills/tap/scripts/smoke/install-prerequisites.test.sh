#!/usr/bin/env bash
# D5: fixture-door — the :15 copytree overlays the working tree's src closure onto a HEAD clone; every assertion is install.sh's public prerequisite refusal/remedy behavior.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
. "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"
python3 - "$ROOT" <<'PY'
import os, pathlib, shlex, shutil, subprocess, sys, tempfile
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
    assert '/opt/homebrew/bin/brew shellenv' in result.stderr, result
    assert '/usr/local/bin/brew shellenv' in result.stderr, result
    assert '/opt/homebrew/bin/brew install git bash jq tmux oven-sh/bun/bun' in result.stderr, result
    assert '/usr/local/bin/brew install git bash jq tmux oven-sh/bun/bun' in result.stderr, result
    assert 'https://brew.sh' in result.stderr and 'command not found' not in result.stderr, result
    assert not bindir.exists(), result
    shim_path = str(missing) + os.pathsep + env['PATH']
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
    assert 'tap session launch <harness> <name>' in result.stdout, result
    assert 'install: done' not in result.stdout and (bindir / 'tap').is_symlink(), result
    remedy = next(line.split('run in this terminal: ', 1)[1] for line in result.stderr.splitlines() if 'run in this terminal:' in line)
    check = subprocess.run(['/bin/bash', '-c', remedy + '\ncommand -v tap\ntap help'], env=env, text=True, capture_output=True)
    assert check.returncode == 0 and check.stdout.splitlines()[0] == str(bindir / 'tap'), check
    result = install(dict(env, PATH=str(bindir) + os.pathsep + env['PATH']))
    assert result.returncode == 0 and 'install: done' in result.stdout, result
print('install-prerequisites: missing Python/Bun refuse before writes; shared adapter fails loud; quoted PATH remedy enables installed tap')
PY
