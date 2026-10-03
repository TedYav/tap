import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

test('eight smoke workers own independent state and sockets; shared HOME collides', () => {
  const repo = resolve(import.meta.dir, '../../..');
  const scratch = realpathSync(mkdtempSync(join(dirname(process.env.TAP_INDEX_HOME!), 'worker-state.')));
  const fixture = join(scratch, 'repo');
  const smoke = 'skills/tap/scripts/smoke';
  mkdirSync(join(fixture, smoke), { recursive: true });
  mkdirSync(join(fixture, 'scripts'));
  for (const path of [
    'scripts/smoke-all.sh', 'scripts/ignored-state-tripwire.py', 'scripts/suite-slot-run.py', 'scripts/suite_slot.py',
    `${smoke}/smoke-preflight.sh`, `${smoke}/smoke_hermeticity_lint.py`,
  ]) copyFileSync(join(repo, path), join(fixture, path));
  const keys = ['HOME', 'TAP_INDEX_HOME', 'TAP_SESSION_MANIFEST', 'OPENCODE_DB_PATH', 'TAP_VERSION_SEEN_PATH', 'TMUX_TMPDIR', 'TMPDIR'];
  for (let i = 0; i < 8; i++) {
    writeFileSync(join(fixture, smoke, `worker-${i}.test.sh`), `#!/usr/bin/env bash
set -eu
python3 - <<'PY'
import json, os
from pathlib import Path
assert all(k not in os.environ for k in ('TAP_HOME', 'TMUX', 'TMUX_PANE'))
keys = ${JSON.stringify(keys)}
row = {k: os.environ[k] for k in keys}
paths = [Path(row['HOME']) / '.tap' / 'same-fixture', Path(row['TAP_INDEX_HOME']) / 'same-fixture',
         Path(row['TMPDIR']) / 'same-fixture']
paths += [Path(row[k]) for k in ('TAP_SESSION_MANIFEST', 'OPENCODE_DB_PATH', 'TAP_VERSION_SEEN_PATH')]
for path in paths:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x') as output:
        output.write('component ${i}\\n')
Path(${JSON.stringify(join(scratch, `worker-${i}.json`))}).write_text(json.dumps(row))
PY
# Identical names must succeed even while sibling servers are still running.
tmux new-session -d -s same-fixture
tmux display-message -p '#{socket_path}' > ${JSON.stringify(join(scratch, `socket-${i}`))}
echo 'worker-${i}: ok'
`);
  }
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', fixture, ...args], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  };
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'fixture');
  const run = () => spawnSync('bash', ['scripts/smoke-all.sh', '-j', '8'], {
    cwd: fixture, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, TAP_RUNNER_ALLOW: '1', TAP_SUITE_SLOT: 'bypass', SMOKE_ALL_MIN_FILES: '1' },
  });
  const good = run();
  expect(good.error).toBeUndefined();
  expect(good.status, good.stdout + good.stderr).toBe(0);
  expect(good.stdout).toMatch(/all 8 files passed \(\d+s, -j [1-8]\)/);
  expect(good.stdout.match(/^smoke-all: worker-roots /gm)?.length).toBe(8);
  const rows = Array.from({ length: 8 }, (_, i) => JSON.parse(readFileSync(join(scratch, `worker-${i}.json`), 'utf8')));
  for (const key of keys) expect(new Set(rows.map(row => row[key])).size, key).toBe(8);
  for (let i = 0; i < rows.length; i++) {
    const socket = readFileSync(join(scratch, `socket-${i}`), 'utf8').trim();
    expect(socket.startsWith(rows[i].TMUX_TMPDIR.replace(/^\/tmp\//, '/private/tmp/') + '/') || socket.startsWith(rows[i].TMUX_TMPDIR + '/')).toBe(true);
    expect(existsSync(socket)).toBe(false);
    expect(existsSync(rows[i].HOME)).toBe(false);
  }
  console.log(good.stdout.split('\n').filter(line => line.startsWith('smoke-all: worker-roots ') || line.includes('all 8 files passed')).join('\n'));
  const runner = join(fixture, 'scripts/smoke-all.sh');
  const source = readFileSync(runner, 'utf8');
  const needle = '"HOME=$smoke_file_root/home"';
  expect(source.split(needle).length).toBe(2);
  writeFileSync(runner, source.replace(needle, '"HOME=$HOME"'));
  const bad = run();
  expect(bad.error).toBeUndefined();
  expect(bad.status).not.toBe(0);
  expect(bad.stdout + bad.stderr).toMatch(/FileExistsError:.*same-fixture/);
}, 150000);
