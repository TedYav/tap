import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

test('selected smoke list keeps isolation, executes both partitions, and refuses invalid or empty lists', () => {
  const repo = resolve(import.meta.dir, '../../..');
  const scratch = realpathSync(mkdtempSync(join(dirname(process.env.TAP_INDEX_HOME!), 'smoke-selection.')));
  const fixture = join(scratch, 'repo');
  const smoke = 'skills/tap/scripts/smoke';
  mkdirSync(join(fixture, smoke), { recursive: true });
  mkdirSync(join(fixture, 'scripts'));
  for (const path of [
    'scripts/smoke-all.sh', 'scripts/ignored-state-tripwire.py', 'scripts/suite-slot-run.py', 'scripts/suite_slot.py', 'scripts/serial-trigger.sh',
    `${smoke}/smoke-preflight.sh`, `${smoke}/smoke_hermeticity_lint.py`,
  ]) copyFileSync(join(repo, path), join(fixture, path));
  for (const name of ['a', 'z-serial']) {
    writeFileSync(join(fixture, smoke, `${name}.test.sh`), `#!/usr/bin/env bash
set -eu
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
. "$ROOT/scripts/serial-trigger.sh"
tap_serial_triggers "never-changed/"
[ "$SMOKE_SCOPE_STATE" = run ]
[ -z "\${TMUX:-}" ] && [ -z "\${TMUX_PANE:-}" ]
printf '${name}\\t%s\\t%s\\t%s\\n' "$HOME" "$TAP_INDEX_HOME" "$TMUX_TMPDIR" >> "$ROOT/observed"
`);
  }
  writeFileSync(join(fixture, smoke, 'unselected.test.sh'), '#!/usr/bin/env bash\nexit 93\n');
  writeFileSync(join(fixture, '.gitignore'), 'observed\n');
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', fixture, ...args], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
  writeFileSync(join(fixture, 'unrelated'), 'unrelated\n'); git('add', 'unrelated');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'unrelated');
  const list = join(scratch, 'selection');
  const run = (body: string, extra: string[] = []) => {
    writeFileSync(list, body);
    return spawnSync('bash', ['scripts/smoke-all.sh', '--list', list, '-j', '2', ...extra], {
      cwd: fixture, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, TAP_RUNNER_ALLOW: '1' },
    });
  };
  const good = run(`${smoke}/z-serial.test.sh\n${smoke}/a.test.sh\n`);
  expect(good.error).toBeUndefined();
  expect(good.status, good.stdout + good.stderr).toBe(0);
  expect(good.stdout).toMatch(/smoke-selected: tested-tree=.* — ok — all 2 files passed/);
  expect(good.stdout).not.toMatch(/^smoke-all: tested-tree=/m);
  const observed = readFileSync(join(fixture, 'observed'), 'utf8');
  const rows = observed.trim().split('\n').map(line => line.split('\t'));
  expect(rows.map(row => row[0])).toEqual(['a', 'z-serial']);
  expect(rows[0]![1]).not.toBe(process.env.HOME);
  expect(rows[0]![2]).not.toBe(rows[1]![2]);
  expect(rows[0]![3]).not.toBe(process.env.TMUX_TMPDIR);
  writeFileSync(join(scratch, 'outside.test.sh'), '#!/usr/bin/env bash\nexit 92\n');
  symlinkSync(join(scratch, 'outside.test.sh'), join(fixture, smoke, 'alias.test.sh'));
  mkdirSync(join(fixture, smoke, 'nested'));
  writeFileSync(join(fixture, smoke, 'nested/not-a-member.test.sh'), '#!/usr/bin/env bash\nexit 0\n');
  const nested = run(`${smoke}/nested/not-a-member.test.sh\n`);
  expect(nested.status, nested.stdout + nested.stderr).toBe(64);
  expect(nested.stderr).toContain('selected path is not a suite member');
  for (const body of ['', '../outside.test.sh\n', `${smoke}/alias.test.sh\n`, `${smoke}/a.test.sh\n${smoke}/a.test.sh\n`]) {
    const bad = run(body);
    expect(bad.error).toBeUndefined();
    expect(bad.status).not.toBe(0);
    expect(bad.stdout).not.toMatch(/ — ok — all/);
  }
  expect(run(`${smoke}/a.test.sh\n`, ['--only', `${smoke}/a.test.sh`]).status).toBe(64);
  expect(readFileSync(join(fixture, 'observed'), 'utf8')).toBe(observed);
}, 120000);
