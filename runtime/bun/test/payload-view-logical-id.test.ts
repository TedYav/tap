// The native id derivation, table-pinned across name shapes: logicalId
// (payload-view.ts) answers "what id is this file a version of" for the fold
// that groups a message's versions. A table, not a sample: each row is a name
// shape the resolver can return, and the row carries the expected id, so a
// drift reds rather than passing unnoticed. Driven in-process — the derivation
// has one home and the module's CLI op is only the census door.

import { expect, test } from "bun:test";

import { logicalId } from "../src/payload-view";

const ROWS: Array<[string, string, string]> = [
  ["/b/payloads/alice-20260904T170000Z-abcd11112222.md", "payloads", "alice-20260904T170000Z-abcd11112222"],
  ["/b/archive/alice-20260904T170000Z-abcd11112222.cancelled.md", "archive", "alice-20260904T170000Z-abcd11112222"],
  ["/b/payloads/.quarantine/alice-20260904T170000Z-abcd11112222.md", "quarantine", "alice-20260904T170000Z-abcd11112222"],
  ["/b/payloads/.quarantine/alice-20260904T170000Z-abcd11112222.md.1", "quarantine", "alice-20260904T170000Z-abcd11112222"],
  ["/b/payloads/.quarantine/alice-20260904T170000Z-abcd11112222.md.12", "quarantine", "alice-20260904T170000Z-abcd11112222"],
  ["/b/payloads/ticket.1.md", "payloads", "ticket.1"],
  ["/b/payloads/.quarantine/ticket.1.md", "quarantine", "ticket.1"],
  ["/b/payloads/.quarantine/ticket.1.md.2", "quarantine", "ticket.1"],
  ["/b/payloads/ticket.cancelled.md", "payloads", "ticket.cancelled"],
  ["/b/payloads/bad id.md", "quarantine", "bad id"],
];

for (const [path, residency, want] of ROWS) {
  test(`logicalId(${JSON.stringify(path)}, ${residency}) = ${JSON.stringify(want)}`, () => {
    expect(logicalId(path, residency)).toBe(want);
  });
}
