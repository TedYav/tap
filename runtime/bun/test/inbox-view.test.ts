import { expect, test } from "bun:test";
import { inboxRows, type InboxFacts } from "../src/slices/inbox-view";
const fact = (id: string, residency: InboxFacts["residency"], first = 0): InboxFacts => ({
  envelope: { id, from: "sender", kind: "discuss", reply: "expected", path: residency === "parked" ? `/bus/spool/${id}.md` : `/bus/${id}.md` },
  residency, attributed: true, unconfirmed: false, age: 12, firstSpooledEpoch: first,
  reason: "queued-input", queueExplanation: "Queue: waiting; probe time is not a delivery guarantee.",
});
test("canonical rendering is preserved; canonical wins duplicate ids and parked rows are oldest first", () => {
  const rows = inboxRows({ me: "worker", rows: [fact("later", "parked", 2), fact("same", "parked", 0), fact("same", "canonical"), fact("earlier", "parked", 1)] });
  expect(rows.map(r => r.item.id)).toEqual(["same", "earlier", "later"]);
  expect(rows[0]!.human).toBe("same  sender  ask  12s\nnext step: tap reply same -f <file>\n");
  expect(rows[1]!.human).toContain("next step: tap read path=/bus/payloads/earlier.md --by worker");
  expect(rows[1]!.item.residency).toBe("parked");
});
test("invalid reply never acquires a read/reply next step in either residency", () => {
  for (const residency of ["canonical", "parked"] as const) {
    const input = fact("invalid", residency); input.envelope.reply = "optional";
    const [row] = inboxRows({ me: "worker", rows: [input] });
    expect(row!.item.reply_invalid).toBe(true);
    expect(row!.human).toContain("next step: tap show invalid (fix reply: before acting)");
    expect(row!.human).not.toContain("next step: tap read");
    expect(row!.human).not.toContain("next step: tap reply");
  }
});
