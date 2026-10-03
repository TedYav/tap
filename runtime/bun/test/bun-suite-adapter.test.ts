import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

test('full-suite adapter preserves discovery, reference environment, pass markers and failures', () => {
  const repo = resolve(import.meta.dir, '../../..');
  const scratch = realpathSync(mkdtempSync(join(dirname(process.env.TAP_INDEX_HOME!), 'bun-suite-adapter.')));
  const smoke = join(scratch, 'skills/tap/scripts/smoke');
  mkdirSync(smoke, { recursive: true });
  mkdirSync(join(scratch, 'scripts'));
  mkdirSync(join(scratch, 'runtime/bun/test'), { recursive: true });
  expect(spawnSync('git', ['init', '-q', scratch]).status).toBe(0);
  for (const path of ['scripts/serial-trigger.sh', 'skills/tap/scripts/smoke/sandbox-pins.sh', 'skills/tap/scripts/smoke/bun-suite.test.sh']) {
    copyFileSync(join(repo, path), join(scratch, path));
  }
  const runner = join(scratch, 'runtime/bun/test/run.sh');
  writeFileSync(runner, `#!/usr/bin/env bash
set -eu
[ "$#" = 0 ]
[ "$PWD" = "$ADAPTER_FIXTURE/runtime/bun" ]
[ "$TAP_POC_REF_BIN" = "$ADAPTER_FIXTURE/scripts/tap.sh" ]
echo '(pass) selected control'
echo '(fail) retained failure'
echo 'SMOKE-SKIP: retained reason'
exit "$ADAPTER_EXIT"
`);
  chmodSync(runner, 0o755);
  for (const code of [0, 17]) {
    const result = spawnSync('bash', [join(smoke, 'bun-suite.test.sh')], {
      cwd: scratch, encoding: 'utf8',
      env: { ...process.env, TAP_SUITE_SANDBOX: scratch, SMOKE_SCOPE_STATE: 'run', ADAPTER_FIXTURE: scratch, ADAPTER_EXIT: String(code) },
    });
    expect(result.status, result.stderr).toBe(code);
    expect(result.stdout).toBe('(pass) selected control: ok\n(fail) retained failure\nSMOKE-SKIP: retained reason\n');
  }
});
