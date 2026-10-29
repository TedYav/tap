import { expect, test } from "bun:test";
import { readOperatorClients } from "../src/recovery/operator-clients";
import type { Run } from "../src/tmux";

function reader(changes: Partial<Record<string, string | Run>> = {}) {
  const replies: Record<string, string | Run> = {
    'display-message -p -t %2 #{window_id}': '@4\n',
    'list-windows -a -F #{session_name}\t#{window_id}': 'target\t@4\nlinked\t@4\nelsewhere\t@8\n',
    'list-clients -F #{client_name}\t#{client_session}\t#{client_activity}\t#{client_created}':
      'first\ttarget\t100\t50\nsecond\tlinked\t110\t80\nthird\telsewhere\t200\t180\n',
    ...changes,
  };
  return (args: string[]): Run => {
    const value = replies[args.join(' ')];
    if (value === undefined) throw new Error(`unexpected tmux read ${JSON.stringify(args)}`);
    return typeof value === 'string' ? { code: 0, stdout: value, stderr: '' } : value;
  };
}
const clientsKey = 'list-clients -F #{client_name}\t#{client_session}\t#{client_activity}\t#{client_created}';

test("linked sessions are included and unrelated clients do not block target navigation", () => {
  expect(readOperatorClients('%2', reader())).toEqual([
    { id: 'first', session: 'target', activity: 100_000, created: 50_000 },
    { id: 'second', session: 'linked', activity: 110_000, created: 80_000 },
  ]);
});
test("an empty successful client census is different from a failed census", () => {
  expect(readOperatorClients('%2', reader({ [clientsKey]: '' }))).toEqual([]);
  expect(readOperatorClients('%2', reader({ [clientsKey]: { code: 1, stdout: '', stderr: 'socket gone' } }))).toBeNull();
  expect(readOperatorClients('%2', reader({ [clientsKey]: { code: 0, stdout: '', stderr: '', rateLimited: true } }))).toBeNull();
});
test("malformed timestamps, missing window membership and duplicate clients are unknown", () => {
  for (const raw of ['a\ttarget\tbad\t50\n', 'a\ttarget\t100\t\n', 'a\ttarget\t-1\t50\n',
    'a\ttarget\t100\t50\na\tlinked\t110\t50\n']) {
    expect(readOperatorClients('%2', reader({ [clientsKey]: raw }))).toBeNull();
  }
  expect(readOperatorClients('%2', reader({ 'list-windows -a -F #{session_name}\t#{window_id}': 'other\t@8\n' }))).toBeNull();
});
