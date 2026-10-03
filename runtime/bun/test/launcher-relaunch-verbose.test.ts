import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { removeScratchTree } from './support/scratch';
test('relaunch stays quiet after a positive controlling tty observation', () => {
  const dir=mkdtempSync(join(tmpdir(),'relaunch-verbose-'));
  try {
    const bin=join(dir,'bin'),index=join(dir,'index'),log=join(dir,'calls');
    mkdirSync(bin);mkdirSync(index);
    writeFileSync(join(index,'global-registry.json'),JSON.stringify({schema:'0.20',teams:{missing:{root:dir,registry_location:join(dir,'absent')}}}));
    writeFileSync(join(bin,'ps'),"#!/bin/sh\nprintf '1 /dev/fixture-tty\\n'\n",{mode:0o755});
    writeFileSync(join(bin,'tmux'),`#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 0\n`,{mode:0o755});
    const env: NodeJS.ProcessEnv={...process.env,PATH:`${bin}:${process.env.PATH}`,TAP_INDEX_HOME:index,TAP_VERBOSE:'1'};
    delete env.TMUX;delete env.TMUX_PANE;delete env.TAP_HOME;
    const result=spawnSync('bun',[resolve(import.meta.dir,'../src/launcher/relaunch.ts'),'--harness','codex','--team','missing'],{cwd:dir,env,encoding:'utf8'});
    expect(readFileSync(log,'utf8')).toContain('list-panes');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  } finally {removeScratchTree(dir);}
});
