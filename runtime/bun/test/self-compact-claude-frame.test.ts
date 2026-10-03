import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { classifySubmitFrame } from '../src/submit-frame';
const fixture = (name: string, ext: string): string => {
  const bytes = readFileSync(new URL(`fixtures/self-compact/${name}.${ext === 'ansi' ? 'json' : ext}`, import.meta.url), 'utf8');
  return ext === 'ansi' ? JSON.parse(bytes) : bytes;
};
for(const [name,state] of [['claude-unicode-staged','staged'],['claude-unicode-queued','queued']] as const){
 test(`real Claude 2.1.282 compact is ${state} during an active turn`,()=>{
  const frame=fixture(name,'ansi'),expected=fixture(name,'expected.txt');
  expect(classifySubmitFrame(frame,'claude',expected,'238',true).state).toBe(state);
  expect(classifySubmitFrame(frame.replaceAll('webapp-9bcf','webapp-9bcX'),'claude',expected,'238',true).state).not.toBe(state);
 });
}

test('queue chrome alone, a stale transcript, and edited bytes never authorize a control',()=>{
 const frame=fixture('claude-unicode-queued','ansi'),expected=fixture('claude-unicode-queued','expected.txt');
 for(const altered of [frame.replace('ctrl+x ctrl+s to send now','transcript note'),frame.replace('ress up to edit queued messages','human draft'),frame.replaceAll('[[sv:self-probe-active-0-unicode]]','[[sv:another-control]]')]){
  expect(classifySubmitFrame(altered,'claude',expected,'238',true).state).not.toBe('queued');
 }
});

for (const mode of ['idle', 'active']) {
 test(`real 77-column Claude ${mode} composer preserves a hard-wrapped path`, () => {
  const name = `claude-narrow-${mode}`;
  const frame = fixture(name, 'ansi'), expected = fixture(name, 'expected.txt');
  expect(classifySubmitFrame(frame, 'claude', expected, '77', true).state).toBe('staged');
  expect(classifySubmitFrame(frame.replaceAll('44Z.md', '44X.md'), 'claude', expected, '77', true).state).not.toBe('staged');
 });
}

test('a hard-wrapped control queued above the narrow composer is accepted', () => {
 const frame = fixture('claude-narrow-queued', 'ansi');
 const expected = fixture('claude-narrow-queued', 'expected.txt');
 expect(classifySubmitFrame(frame, 'claude', expected, '77', true).state).toBe('queued');
 expect(classifySubmitFrame(frame.replaceAll('44Z.md', '44X.md'), 'claude', expected, '77', true).state).not.toBe('queued');
});

test('a wrap hiding multiple separator spaces cannot prove the expected byte count', () => {
 const frame = fixture('claude-narrow-scroll-staged', 'ansi');
 const expected = fixture('claude-narrow-scroll-staged', 'expected.txt');
 expect(expected).toContain('  [[sv:');
 for (const spaces of ['  ', '   ']) {
  const ambiguous = expected.replace('  [[sv:', `${spaces}[[sv:`);
  expect(classifySubmitFrame(frame, 'claude', ambiguous, '77', true).state).not.toBe('staged');
 }
});

for (const scroll of ['copy', 'app']) {
 test(`a captured ${scroll} scroll frame does not itself prove a staged control`, () => {
  const frame = fixture(`claude-narrow-scroll-${scroll}`, 'ansi');
  const expected = fixture('claude-narrow-scroll-staged', 'expected.txt');
  expect(classifySubmitFrame(frame, 'claude', expected, '77', true).state).not.toBe('staged');
 });
}

test('hard-wrap matching still refuses short splits, edited spacing, missing markers and mixed drafts', () => {
 const frame = fixture('claude-narrow-active', 'ansi');
 const expected = fixture('claude-narrow-active', 'expected.txt');
 const variants = [
  frame.replaceAll('44Z.md before', '44Z.md\n  before'),
  frame.replaceAll('Resume the coach', 'Resume  the coach'),
  frame.replaceAll('[[sv:self-probe-77-active-420-ascii]]', '[[sv:self-probe-77-active-420-ascii'),
  frame.replaceAll('[[sv:self-probe-77-active-420-ascii]]', '[[sv:self-probe-77-active-420-ascii]] human draft'),
 ];
 for (const altered of variants) {
  expect(altered).not.toBe(frame);
  expect(classifySubmitFrame(altered, 'claude', expected, '77', true).state).not.toBe('staged');
 }
});

test('visible separator spaces still require their exact count', () => {
 const frame = fixture('claude-narrow-active', 'ansi').replaceAll('Resume the coach', 'Resume  the coach');
 const original = fixture('claude-narrow-active', 'expected.txt');
 const expected = original.replaceAll('Resume the coach', 'Resume  the coach');
 expect(classifySubmitFrame(frame, 'claude', expected, '77', true).state).toBe('staged');
 expect(classifySubmitFrame(frame, 'claude', original, '77', true).state).not.toBe('staged');
});
