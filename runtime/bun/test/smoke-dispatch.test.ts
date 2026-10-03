import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// tap-ctop0: the worker body used to ride xargs -I argv, where BSD xargs
// substitutes its placeholder in every argument and refuses one over 255 bytes.
// A literal brace pair in the body then launched no worker: zero FAIL rows,
// and only the ledger-mismatch receipt said why. The body now runs from a file;
// the second test pins that receipt so an unlaunched worker stays red.
function fixtureRepo(label: string, editRunner: (runner: string) => string, args = ['--only', 'skills/tap/scripts/smoke/a.test.sh']) {
  const repo = resolve(import.meta.dir, '../../..');
  const scratch = realpathSync(mkdtempSync(join(dirname(process.env.TAP_INDEX_HOME!), `smoke-dispatch-${label}.`)));
  const fixture = join(scratch, 'repo');
  const smoke = 'skills/tap/scripts/smoke';
  mkdirSync(join(fixture, smoke), { recursive: true });
  mkdirSync(join(fixture, 'scripts'));
  for (const path of [
    'scripts/ignored-state-tripwire.py', 'scripts/suite-slot-run.py', 'scripts/suite_slot.py', 'scripts/serial-trigger.sh',
    `${smoke}/smoke-preflight.sh`, `${smoke}/smoke_hermeticity_lint.py`,
  ]) copyFileSync(join(repo, path), join(fixture, path));
  writeFileSync(join(fixture, 'scripts/smoke-all.sh'), editRunner(readFileSync(join(repo, 'scripts/smoke-all.sh'), 'utf8')));
  writeFileSync(join(fixture, smoke, 'a.test.sh'), '#!/usr/bin/env bash\nexit 0\n');
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', fixture, ...args], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  };
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'base');
  const run = spawnSync('bash', ['scripts/smoke-all.sh', ...args], {
    cwd: fixture, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, TAP_RUNNER_ALLOW: '1' },
  });
  expect(run.error).toBeUndefined();
  return run;
}

test('a literal placeholder inside the worker body no longer stops workers from launching', () => {
  const run = fixtureRepo('brace', runner => {
    const edited = runner.replace("_smoke_worker_body='\n", "_smoke_worker_body='\n  : placeholder-shaped text {} stays inert here\n");
    expect(edited).not.toBe(runner);
    return edited;
  });
  expect(run.status, run.stdout + run.stderr).toBe(0);
  expect(run.stdout).toMatch(/— ok — all 1 files passed/);
  expect(run.stdout + run.stderr).not.toContain('cannot be assembled');
}, 120000);

test('a run whose workers never reach the ledger is red and names the mismatch', () => {
  const run = fixtureRepo('unlaunched', runner => {
    const edited = runner.replace('-I {} bash "$SMOKE_DISPATCH_WORKER" {}', '-I {} true {}');
    expect(edited).not.toBe(runner);
    return edited;
  });
  expect(run.status).not.toBe(0);
  expect(run.stdout).not.toMatch(/— ok — all/);
  expect(run.stderr).toContain('ledger mismatch — 0 passed + 0 failed != 1 files (worker died?)');
}, 120000);

test('a second --only refuses by name instead of running less than asked', () => {
  const only = 'skills/tap/scripts/smoke/a.test.sh';
  const run = fixtureRepo('twice', runner => runner, ['--only', only, '--only', only]);
  expect(run.status).toBe(64);
  expect(run.stderr).toContain('--only was given more than once; it takes one file (pass several with --list <path>)');
  expect(run.stdout).not.toMatch(/— ok — all/);
}, 120000);
