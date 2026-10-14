#!/usr/bin/env bash
# D5: fixture-door — the :37 copytree overlays the working tree's src closure onto a HEAD clone, and :120 drives install-hooks.ts codex-config — the same entry install.sh execs (install.sh:620) — only to generate fixture input; every assertion is on install.sh's installer behavior (skip-and-warn, read skips, symlinks, classification, logic-bug stops).
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
. "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"
if [ "$(id -u)" = 0 ]; then
  echo "install-first-run-hardening: mode-500 arms are inert as root; run as a normal user" >&2
  exit 1
fi
python3 - "$ROOT" <<'PY'
import os, pathlib, re, shutil, subprocess, sys, tempfile

root = pathlib.Path(sys.argv[1])
BEGIN = "# tap-managed:begin Codex SessionStart"
END = "# tap-managed:end Codex SessionStart"
LEGACY_HOOKS = '{"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "/opt/legacy/bin/tap-codex-session-start.sh"}]}]}}\n'
HOME_KEYS = ('TAP_CLAUDE_HOME', 'TAP_CODEX_HOME', 'TAP_HERMES_HOME', 'TAP_CURSOR_HOME',
             'TAP_OPENCODE_HOME', 'TAP_GEMINI_HOME', 'TAP_CURSOR_AGENT_HOME', 'TAP_AGENTS_HOME')
SKIP_PATTERN = re.compile(r"install: WARNING: skipped (.+?) — could not (?:write|read) (.+?): ")
BLANKET_CATCH = re.compile(r'except\s+(Exception|BaseException)\b')
DENOMINATOR = re.compile(
    r"install: skills: (\d+) shipped — (\d+) classified machine-wide, "
    r"(\d+) classified repo-local, (\d+) classified retired, (\d+) unclassified")


def assert_no_blanket_catch():
    for source in (root / 'install.sh',):
        for lineno, line in enumerate(source.read_text().splitlines(), 1):
            assert not BLANKET_CATCH.search(line), f'{source}:{lineno}: {line.strip()}'


def fresh(w, name):
    scope = w / name
    scope.mkdir()
    subprocess.run(['git', 'clone', '--quiet', '--shared', str(root), str(scope / 'repo')], check=True)
    repo = (scope / 'repo').resolve()
    shutil.copyfile(root / 'install.sh', repo / 'install.sh')
    shutil.copytree(root / 'runtime/bun/src', repo / 'runtime/bun/src', dirs_exist_ok=True)
    shutil.copytree(root / 'vendor', repo / 'vendor', dirs_exist_ok=True)
    # Source renames are part of the working installer, not just its Bun closure.
    shutil.copytree(root / 'skills', repo / 'skills', dirs_exist_ok=True)
    for source in (repo / 'skills').glob('*/SKILL.md'):
        if not (root / 'skills' / source.parent.name / 'SKILL.md').exists():
            source.unlink()
    (scope / 'home').mkdir()
    # The installer wires a harness home only when its command is on PATH (tap-gjwtw);
    # these arms exercise the wired path, so each harness command exists as a stub.
    stubs = scope / 'harness-bin'
    stubs.mkdir()
    for command in ('claude', 'codex', 'cursor-agent', 'agy', 'opencode', 'hermes'):
        (stubs / command).write_text('#!/bin/sh\nexit 0\n')
        (stubs / command).chmod(0o755)
    env = dict(os.environ, HOME=str(scope / 'home'), TAP_INSTALL_BIN=str(scope / 'bin'),
               TAP_INSTALL_HOOK='1', TAP_INDEX_HOME=str(scope / 'index'),
               PATH=f"{stubs}{os.pathsep}{os.environ['PATH']}")
    for key in HOME_KEYS:
        env[key] = str(scope / key)
    return scope, repo, env


def run_install(env, repo, *args):
    return subprocess.run(['/bin/bash', str(repo / 'install.sh'), *args], env=env, text=True, capture_output=True)


def skipped_whats(stderr):
    return [match.group(1) for match in map(SKIP_PATTERN.match, stderr.splitlines()) if match]


def assert_common(result, seeds):
    assert result.returncode == 0, (result.returncode, result.stderr[-2500:])
    assert 'Traceback' not in result.stderr, result.stderr[-2500:]
    assert 'links installed; shell setup required' in result.stderr, result.stderr[-2500:]
    for directory, expected in seeds.items():
        for entry in directory.iterdir():
            if entry.is_file():
                assert entry.name in expected, f'unexpected file {entry}'
                assert entry.read_bytes() == expected[entry.name], f'{entry} changed'
    for directory in seeds:
        residue = [p.name for p in directory.iterdir()
                   if '.tap-tmp' in p.name or p.name.startswith('.AGENTS.md.') or p.name.startswith('.tap-codex-')]
        assert not residue, (directory, residue)


def seed_codex_legacy(codex):
    hooks = codex / 'hooks.json'
    hooks.write_text(LEGACY_HOOKS)
    return hooks


def arm_unwritable_directories(scope, repo, env):
    claude = pathlib.Path(env['TAP_CLAUDE_HOME']); claude.mkdir(parents=True)
    codex = pathlib.Path(env['TAP_CODEX_HOME']); codex.mkdir(parents=True)
    cursor = pathlib.Path(env['TAP_CURSOR_HOME']); cursor.mkdir(parents=True)
    config = pathlib.Path(env['TAP_GEMINI_HOME']) / 'config'; config.mkdir(parents=True)
    (claude / 'settings.json').write_text('{}\n')
    (claude / 'skills').mkdir()
    (codex / 'AGENTS.md').write_text('user notes without TAP markers\n')
    (codex / 'skills').mkdir()
    codex_hooks = seed_codex_legacy(codex)
    (codex / 'config.toml').write_text(f'{BEGIN}\n{END}\n')
    (cursor / 'hooks.json').write_text('{"version": 1, "hooks": {}}\n')
    (config / 'hooks.json').write_text('{}\n')
    seeds = {
        claude: {'settings.json': (claude / 'settings.json').read_bytes()},
        codex: {'AGENTS.md': (codex / 'AGENTS.md').read_bytes(),
                'hooks.json': codex_hooks.read_bytes(),
                'config.toml': (codex / 'config.toml').read_bytes()},
        cursor: {'hooks.json': (cursor / 'hooks.json').read_bytes()},
        config: {'hooks.json': (config / 'hooks.json').read_bytes()},
    }
    locked = (claude, codex, cursor, config)
    try:
        for directory in locked:
            directory.chmod(0o500)
        result = run_install(env, repo)
    finally:
        for directory in locked:
            directory.chmod(0o700)
    assert_common(result, seeds)
    assert sorted(skipped_whats(result.stderr)) == sorted([
        'Claude hooks', 'Codex AGENTS.md TAP section', 'Codex config.toml hooks',
        'Cursor hooks', 'Antigravity tmux guard']), result.stderr[-2500:]
    cleanup = [line for line in result.stderr.splitlines()
               if 'skipped Codex legacy hooks.json cleanup — config.toml hooks were not reconciled' in line]
    assert len(cleanup) == 1, result.stderr[-2500:]


def arm_current_fence_unwritable(scope, repo, env):
    codex = pathlib.Path(env['TAP_CODEX_HOME']); codex.mkdir(parents=True)
    (codex / 'skills').mkdir()
    scratch = scope / 'scratch'; scratch.mkdir()
    scratch_config = scratch / 'config.toml'
    scratch_config.write_text(f'{BEGIN}\n{END}\n')
    generated = subprocess.run(
        ['bun', str(repo / 'runtime/bun/src/install-hooks.ts'), 'codex-config', str(scratch_config),
         str(repo / 'hooks' / 'tap-codex-session-start.sh'), str(repo / 'hooks' / 'tap-shell-body-guard.ts')],
        text=True, capture_output=True)
    assert generated.returncode == 0, (generated.returncode, generated.stderr[-1500:])
    (codex / 'config.toml').write_bytes(scratch_config.read_bytes())
    codex_hooks = seed_codex_legacy(codex)
    seeds = {codex: {'config.toml': (codex / 'config.toml').read_bytes(),
                     'hooks.json': codex_hooks.read_bytes()}}
    try:
        codex.chmod(0o500)
        result = run_install(env, repo)
    finally:
        codex.chmod(0o700)
    assert_common(result, seeds)
    assert 'install: Codex hooks already wired in config.toml' in result.stdout, result.stdout[-2000:]
    assert sorted(skipped_whats(result.stderr)) == sorted([
        'Codex AGENTS.md TAP section', 'Codex legacy hooks.json cleanup']), result.stderr[-2500:]
    cleanup = [line for line in result.stderr.splitlines()
               if 'skipped Codex legacy hooks.json cleanup — could not write' in line]
    assert len(cleanup) == 1, result.stderr[-2500:]


def arm_unreadable_cursor(scope, repo, env):
    cursor = pathlib.Path(env['TAP_CURSOR_HOME']); cursor.mkdir(parents=True)
    cursor_hooks = cursor / 'hooks.json'
    cursor_hooks.write_text('{"version": 1, "hooks": {"sessionStart": [{"command": "echo user-entry"}]}}\n')
    seeds = {cursor: {'hooks.json': cursor_hooks.read_bytes()}}
    try:
        cursor_hooks.chmod(0o000)
        result = run_install(env, repo)
    finally:
        cursor_hooks.chmod(0o600)
    assert_common(result, seeds)
    assert skipped_whats(result.stderr) == ['Cursor hooks'], result.stderr[-2500:]
    reads = [line for line in result.stderr.splitlines()
             if 'skipped Cursor hooks — could not read' in line]
    assert len(reads) == 1, result.stderr[-2500:]
    assert f'next: make {cursor_hooks} readable and rerun ./install.sh' in reads[0], reads[0]
    assert 'writable' not in reads[0], reads[0]


def arm_skill_classification(scope, repo, env):
    env = dict(env, TAP_INSTALL_HOOK='0')
    orphan = repo / 'skills' / 'orphan-probe'
    orphan.mkdir()
    (orphan / 'SKILL.md').write_text('---\nname: orphan-probe\ndescription: classification probe\n---\n')
    result = run_install(env, repo, '--verbose')
    assert result.returncode == 0, (result.returncode, result.stderr[-2500:])
    warning = [line for line in result.stderr.splitlines()
               if 'absent from install.sh skill classifications' in line]
    assert warning == [f'install: WARNING: skills/orphan-probe/SKILL.md is absent from install.sh skill classifications — add orphan-probe to skill-policy.ts classifications'], warning
    assert 'links installed; shell setup required' in result.stderr, result.stderr[-2500:]
    lines = [line for line in result.stdout.splitlines() if DENOMINATOR.match(line)]
    assert len(lines) == 1, result.stdout[-2000:]
    shipped, mw, local, retired, un = map(int, DENOMINATOR.match(lines[0]).groups())
    assert un == 1, lines[0]
    assert mw + local + retired + un == shipped, lines[0]
    shutil.rmtree(orphan)
    control = run_install(env, repo, '--verbose')
    assert control.returncode == 0, (control.returncode, control.stderr[-2500:])
    control_warnings = [line for line in control.stderr.splitlines()
                        if 'absent from install.sh skill classifications' in line]
    assert not control_warnings, control.stderr[-2500:]
    control_lines = [line for line in control.stdout.splitlines() if DENOMINATOR.match(line)]
    assert len(control_lines) == 1, control.stdout[-2000:]
    assert DENOMINATOR.match(control_lines[0]).group(5) == '0', control_lines[0]


def arm_codex_symlink_target(scope, repo, env):
    codex = pathlib.Path(env['TAP_CODEX_HOME']); codex.mkdir(parents=True)
    (codex / 'real-AGENTS.md').write_text('user notes without TAP markers\n')
    os.symlink('real-AGENTS.md', codex / 'AGENTS.md')
    result = run_install(env, repo)
    assert result.returncode == 0, (result.returncode, result.stderr[-2500:])
    assert 'Traceback' not in result.stderr, result.stderr[-2500:]
    assert os.path.islink(codex / 'AGENTS.md'), result.stdout[-2000:]
    assert os.readlink(codex / 'AGENTS.md') == 'real-AGENTS.md', os.readlink(codex / 'AGENTS.md')
    target_text = (codex / 'real-AGENTS.md').read_text()
    assert 'user notes without TAP markers' in target_text, target_text
    assert '<!-- tap:begin -->' in target_text, target_text
    assert 'install: TAP section written to' in result.stdout, result.stdout[-2000:]
    assert not list(codex.glob('.AGENTS.md.*')), list(codex.glob('.AGENTS.md.*'))


def arm_codex_cyclic_symlink(scope, repo, env):
    codex = pathlib.Path(env['TAP_CODEX_HOME']); codex.mkdir(parents=True)
    os.symlink('AGENTS.md', codex / 'AGENTS.md')
    result = run_install(env, repo)
    assert result.returncode == 0, (result.returncode, result.stderr[-2500:])
    assert 'links installed; shell setup required' in result.stderr, result.stderr[-2500:]
    assert 'Traceback' not in result.stderr, result.stderr[-2500:]
    assert 'skipped Codex AGENTS.md TAP section' in result.stderr, result.stderr[-2500:]
    assert 'could not write' in result.stderr, result.stderr[-2500:]
    assert 'resolvable target' in result.stderr, result.stderr[-2500:]
    assert os.path.islink(codex / 'AGENTS.md'), result.stderr[-2500:]
    assert os.readlink(codex / 'AGENTS.md') == 'AGENTS.md', os.readlink(codex / 'AGENTS.md')
    assert not list(codex.glob('.AGENTS.md.*')), list(codex.glob('.AGENTS.md.*'))


def arm_logic_bug_still_stops(scope, repo, env):
    claude = pathlib.Path(env['TAP_CLAUDE_HOME']); claude.mkdir(parents=True)
    (claude / 'settings.json').write_text('[]\n')
    result = run_install(env, repo)
    assert result.returncode != 0, (result.returncode, result.stdout[-1500:], result.stderr[-1500:])
    assert result.stderr.strip(), 'a type-confused settings.json must fail loudly, not silently'
    assert 'must be a JSON object' in result.stderr, result.stderr[-1500:]
    assert 'links installed; shell setup required' not in result.stderr, result.stderr[-1500:]


def arm_concise_inventory(scope, repo, env):
    # Claude and Codex take their skills from the native plugin; the loose-link
    # inventory under test is a flat host's, so Hermes joins them.
    for key in ('TAP_CLAUDE_HOME', 'TAP_CODEX_HOME', 'TAP_HERMES_HOME'):
        pathlib.Path(env[key]).mkdir()
    result = run_install(env, repo)
    assert result.returncode == 0, result.stderr
    assert re.search(r'install: \d+ skill links refreshed across 1 homes', result.stdout), result.stdout
    assert 'install: optional skill homes absent:' in result.stdout, result.stdout
    assert 'install: inventory:' in result.stdout and '--verbose' in result.stdout
    assert 'install: linked Hermes skill' not in result.stdout, result.stdout
    assert 'install: skipped OpenCode' not in result.stdout, result.stdout
    assert 'linked ingest contract' not in result.stdout, result.stdout
    assert 'open /hooks in Codex to review and trust' in result.stdout, result.stdout
    assert 'interactive machine setup skipped' in result.stdout, result.stdout
    assert 'not on PATH' in result.stderr, result.stderr
    verbose = run_install(env, repo, '--verbose')
    assert verbose.returncode == 0, verbose.stderr
    assert 'install: linked Hermes skill' in verbose.stdout, verbose.stdout
    assert 'install: skipped OpenCode' in verbose.stdout, verbose.stdout
    assert 'linked ingest contract' in verbose.stdout, verbose.stdout
    assert len(verbose.stdout.splitlines()) > len(result.stdout.splitlines()) + 8


with tempfile.TemporaryDirectory() as tmp:
    w = pathlib.Path(tmp)
    assert_no_blanket_catch()
    arm_concise_inventory(*fresh(w, 'concise-inventory'))
    arm_unwritable_directories(*fresh(w, 'unwritable-directories'))
    arm_current_fence_unwritable(*fresh(w, 'current-fence-unwritable'))
    arm_unreadable_cursor(*fresh(w, 'unreadable-cursor'))
    arm_codex_symlink_target(*fresh(w, 'codex-symlink-target'))
    arm_codex_cyclic_symlink(*fresh(w, 'codex-cyclic-symlink'))
    arm_skill_classification(*fresh(w, 'skill-classification'))
    arm_logic_bug_still_stops(*fresh(w, 'logic-bug-still-stops'))
print('install-first-run-hardening: OSError skips warn and continue; read skips never rewrite; logic bugs still stop')
PY
