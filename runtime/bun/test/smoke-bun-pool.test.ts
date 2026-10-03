import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

test('one pool discovers shell and Bun once, isolates same-name state, and retains Bun failures', () => {
  const repo = resolve(import.meta.dir, '../../..');
  const scratch = realpathSync(mkdtempSync(join(dirname(process.env.TAP_INDEX_HOME!), 'bun-pool.')));
  const fixture = join(scratch, 'repo');
  const smoke = 'skills/tap/scripts/smoke';
  for (const dir of [smoke, 'scripts', 'runtime/bun/test', 'runtime/bun/src', 'runtime/bun/node_modules', 'runtime/bun/.hidden']) {
    mkdirSync(join(fixture, dir), { recursive: true });
  }
  for (const path of [
    'scripts/smoke-all.sh', 'scripts/ignored-state-tripwire.py', 'scripts/suite-slot-run.py', 'scripts/suite_slot.py',
    'runtime/bun/test/run.sh', `${smoke}/smoke-preflight.sh`, `${smoke}/smoke_hermeticity_lint.py`,
  ]) copyFileSync(join(repo, path), join(fixture, path));
  const keys = ['HOME', 'TAP_INDEX_HOME', 'TAP_SESSION_MANIFEST', 'OPENCODE_DB_PATH', 'TAP_VERSION_SEEN_PATH', 'TMUX_TMPDIR', 'TMPDIR'];
  for (let i = 0; i < 6; i++) {
    writeFileSync(join(fixture, smoke, `worker-${i}.test.sh`), `#!/usr/bin/env bash
set -eu
python3 - <<'PY'
import json, os
from pathlib import Path
row = {key: os.environ[key] for key in ${JSON.stringify(keys)}}
path = Path(row['HOME']) / 'same-name'
with path.open('x') as output: output.write('shell')
Path(${JSON.stringify(join(scratch, `worker-${i}.json`))}).write_text(json.dumps(row))
PY
echo 'worker-${i}: ok'
`);
  }
  const bunPaths = ['runtime/bun/src/colocated.test.ts', 'runtime/bun/test/component_spec.js'];
  for (let i = 0; i < bunPaths.length; i++) {
    writeFileSync(join(fixture, bunPaths[i]!), `import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
test('skipped wording in a passing title is not a skip', () => {
  expect(process.cwd()).toBe(${JSON.stringify(join(fixture, 'runtime/bun'))});
  expect(process.env.TAP_POC_REF_BIN).toBe(${JSON.stringify(join(fixture, 'scripts/tap.sh'))});
  expect(process.env.TAP_NOTIFY_USER_BIN).toBe('/nonexistent/tap-smoke-must-stub-notify-user');
  expect(process.env.TMUX).toBeUndefined();
  expect(process.env.TMUX_PANE).toBeUndefined();
  writeFileSync(join(process.env.HOME, 'same-name'), 'bun', { flag: 'wx' });
  const row = Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, process.env[key]]));
  writeFileSync(${JSON.stringify(join(scratch, `worker-${i + 6}.json`))}, JSON.stringify(row));
});
`);
  }
  // The old carrier must not duplicate the newly discovered children.
  writeFileSync(join(fixture, smoke, 'bun-suite.test.sh'), '#!/usr/bin/env bash\nexit 91\n');
  for (const dir of ['node_modules', '.hidden']) {
    writeFileSync(join(fixture, 'runtime/bun', dir, 'excluded.test.ts'), 'throw new Error("excluded file executed");\n');
  }
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', fixture, ...args], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  };
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'fixture');
  const run = (args: string[]) => spawnSync('bash', ['scripts/smoke-all.sh', '-j', '8', ...args], {
    cwd: fixture, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, TAP_RUNNER_ALLOW: '1', TAP_SUITE_SLOT: 'bypass', SMOKE_ALL_MIN_FILES: '1' },
  });
  const good = run([]);
  expect(good.error).toBeUndefined();
  expect(good.status, good.stdout + good.stderr).toBe(0);
  // Adaptive load controls may lower -j; retain the actual number in the receipt.
  expect(good.stdout).toMatch(/all 8 files passed \(\d+s, -j [1-8]\)/);
  expect(good.stdout.match(/^smoke-all: worker-roots /gm)?.length).toBe(8);
  const rows = Array.from({ length: 8 }, (_, i) => JSON.parse(readFileSync(join(scratch, `worker-${i}.json`), 'utf8')));
  for (const key of keys) expect(new Set(rows.map(row => row[key])).size, key).toBe(8);
  for (const row of rows) expect(existsSync(row.HOME)).toBe(false);
  console.log(good.stdout.split('\n').filter(line => line.startsWith('smoke-all: worker-roots ') || line.includes('all 8 files passed')).join('\n'));

  const list = join(scratch, 'selected');
  writeFileSync(list, `${smoke}/worker-0.test.sh\n${bunPaths[1]}\n`);
  const selected = run(['--list', list]);
  expect(selected.status, selected.stdout + selected.stderr).toBe(0);
  expect(selected.stdout).toMatch(/smoke-selected: tested-tree=.*all 2 files passed/);
  writeFileSync(list, `${bunPaths[0]}\n${bunPaths[0]}\n`);
  expect(run(['--list', list]).status).toBe(64);

  writeFileSync(join(fixture, bunPaths[0]!), 'import { test, expect } from "bun:test";\ntest("retained failure", () => expect(1).toBe(2));\n');
  const bad = run(['--only', bunPaths[0]!]);
  expect(bad.error).toBeUndefined();
  expect(bad.status).toBe(1);
  expect(bad.stdout).toContain(`=== FAIL ${bunPaths[0]} (exit 1) ===`);
  expect(bad.stdout).toMatch(/^\(fail\) retained failure/m);
  expect(bad.stdout).not.toMatch(/^\(fail\).*: ok$/m);
  symlinkSync(join(fixture, bunPaths[0]!), join(fixture, 'runtime/bun/test/alias.test.ts'));
  const alias = run(['--only', 'runtime/bun/test/alias.test.ts']);
  expect(alias.status).toBe(64);
  expect(alias.stderr).toContain('Bun test must be an ordinary file');
}, 150000);
