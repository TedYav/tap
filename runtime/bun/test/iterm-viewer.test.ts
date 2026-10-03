import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removeScratchTree } from "./support/scratch";
import { expect, test } from 'bun:test';
import { gridRows, itermViewerScript } from '../src/iterm-viewer';

test('balanced rows contain each seat once, with no nested spiral', () => {
 expect(gridRows(1)).toEqual([1]); expect(gridRows(3)).toEqual([2,1]);
 expect(gridRows(6)).toEqual([3,3]); expect(gridRows(7)).toEqual([3,2,2]);
 const seats=Array.from({length:6},(_,i)=>({handle:`seat-${i}`,session:`team/seat-${i}`}));
 const script=itermViewerScript(seats,'/repo','/tmp/private/socket');
 expect(script.match(/split horizontally/g)).toHaveLength(1);
 expect(script.match(/split vertically/g)).toHaveLength(4);
 expect(script.match(/set columns of p\d to \(totalColumns div 3\)/g)).toHaveLength(6);
 expect(script.match(/set rows of p\d to \(totalRows div 2\)/g)).toHaveLength(6);
 for (let i=1;i<=6;i++) expect(script).toContain(`set name of p${i} to "seat-${i-1}"`);
 expect(script.match(/write text/g)).toHaveLength(6);
 for (const line of script.split('\n').filter(line => line.includes('profile command'))) {
   expect(line).not.toContain('attach-session');
   expect(line).toContain(' -l');
 }
});

test('tabs stay tabs; commands quote cwd, exact session and the current socket', () => {
 const script=itermViewerScript([{handle:'a',session:'t/a'},{handle:'b',session:'t/b'}],"/repo's path",'/tmp/socket name',true);
 expect(script).toContain('create tab with default profile command');
 expect(script).not.toContain('split horizontally');
 expect(script).not.toContain('set columns');
 expect(script).toContain('attach-session -t');
 expect(script).toContain('/bin/sh -c');
 expect(script).toContain('unset TMUX TMUX_PANE');
 expect(script).toContain(Bun.which('tmux')!);
 expect(script).toContain('/tmp/socket name');
 expect(script).toContain('/repo');
 expect(() => gridRows(0)).toThrow();
});

test('replaying a pane startup opens a shell in team home without attaching', () => {
 const root = realpathSync(mkdtempSync(join(tmpdir(), "viewer ' shell.")));
 try {
  const script = itermViewerScript([{handle:'a',session:'must-not-attach'}], root, '/nonexistent/socket');
  const encoded = script.split('\n').find(line => line.includes('create window'))!.match(/command (.*)\)$/)![1]!;
  const startup = JSON.parse(encoded);
  const result = spawnSync('/bin/sh', ['-c', startup], {input:'pwd\nexit\n',encoding:'utf8',timeout:5000});
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(root);
  expect(result.stderr).not.toContain('connecting');
  expect(startup).not.toContain('attach-session');
 } finally { removeScratchTree(root); }
});
