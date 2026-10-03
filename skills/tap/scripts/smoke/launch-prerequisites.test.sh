#!/usr/bin/env bash
# Public launcher entries: missing prerequisites refuse before state publication.
# Launch, resume and restart all require the native runtime.
# The prerequisite refusals themselves (tmux, harness CLIs) are internal ordering
# — the router's first-run onboarding preempts them from an unenrolled cwd — so
# they are pinned by runtime/bun/test/launch-prerequisites.test.ts. This file
# keeps the public door's own refusal: without Bun, bin/tap refuses every
# session form before touching any state.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
. "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"
python3 - "$ROOT" <<'PY'
import os, pathlib, subprocess, sys, tempfile
root = pathlib.Path(sys.argv[1])
with tempfile.TemporaryDirectory() as tmp:
    w = pathlib.Path(tmp)
    bins = w / 'bin'; bins.mkdir()
    cwd = w / 'stranger'; cwd.mkdir()
    subprocess.run(['git', 'init', '-q', str(cwd)], check=True)
    env = dict(os.environ, PATH=str(bins), TAP_INDEX_HOME=str(w / 'index'),
               HOME=str(w / 'home'), XDG_CONFIG_HOME=str(w / 'config'))
    for key in ('TMUX', 'TMUX_PANE', 'TAP_HOME', 'TAP_TEAM', 'TAP_CLEAR_ID'):
        env.pop(key, None)
    def run(*args):
        result = subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True)
        assert result.returncode != 0, result
        assert 'Traceback' not in result.stderr, result.stderr
        assert not (cwd / '.tap').exists() and not (w / 'index').exists(), 'refusal published state'
        return result
    (bins / 'dirname').symlink_to('/usr/bin/dirname')
    # The public door refuses every session form without Bun, before any state.
    for form in ('launch', 'resume', 'restart', 'relaunch'):
        result = run('/bin/bash', str(root / 'bin/tap'), 'session', form, 'claude')
        assert 'bun and runtime/bun/main.ts are required' in result.stderr, result.stderr
print('launch-prerequisites: the public door refuses every session form without Bun, before publication')
PY
