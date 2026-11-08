import { test, expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realSeams } from "../src/watch-detectors";
import { hasUnsettled } from "../src/watch-evaluate";
import { removeScratchTree } from "./support/scratch";

test("five advisory sender/inbox questions share scans and never load settled message bodies", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "watch-mail."));
  for (const dir of ["payloads", "receipts", "spool"]) fs.mkdirSync(join(root, dir));
  const payloads = join(root, "payloads"), receipts = join(root, "receipts");
  for (let i = 0; i < 500; i++) {
    const id = `m${String(i).padStart(3, "0")}`;
    fs.writeFileSync(join(payloads, `${id}.md`), `---\nfrom: s${i % 5}\nfrom_team: fixture\nto: s${(i + 1) % 5}\nkind: discuss\n---\n${"x".repeat(8192)}`);
    fs.utimesSync(join(payloads, `${id}.md`), 1000 + i, 1000 + i);
    fs.writeFileSync(join(receipts, `${id}.done`), "");
  }
  const reads = spyOn(fs, "readFileSync"), listings = spyOn(fs, "readdirSync"), opens = spyOn(fs, "openSync");
  try {
    const world = realSeams({ bus: root, scripts: "", registry: "", team: "fixture", now: "2000" });
    for (let i = 0; i < 5; i++) {
      expect(world.latestOutbound(`s${i}`, 2000n)).toBe(`${1495 + i}\tm${495 + i}`);
      expect(world.oldestUnsettledInbound(`s${i}`, 2000n)).toBe("");
    }
    expect(hasUnsettled(payloads, receipts)).toBe(false);
    expect(reads.mock.calls.filter(c => String(c[0]).startsWith(payloads))).toHaveLength(0);
    expect(opens.mock.calls.filter(c => String(c[0]).startsWith(payloads))).toHaveLength(500);
    expect(listings.mock.calls.filter(c => c[0] === payloads)).toHaveLength(3); // outbound, inbound, evaluator
    // A new seam is a new observation, including new mail and receipt changes.
    fs.writeFileSync(join(payloads, "new.md"), "---\nfrom: s0\nto: s1\nkind: order\n---\nbody");
    fs.utimesSync(join(payloads, "new.md"), 1900, 1900);
    const next = realSeams({ bus: root, scripts: "", registry: "", team: "fixture", now: "2000" });
    expect(next.oldestUnsettledInbound("s1", 2000n)).toBe("new\t100");
    expect(next.latestOutbound("s0", 2000n)).toBe("1900\tnew");
  } finally { reads.mockRestore(); listings.mockRestore(); opens.mockRestore(); removeScratchTree(root); }
});

test("header reads preserve CRLF across chunks, UTF-8, duplicates and unterminated headers", async () => {
  const { readFrontmatter } = await import("../src/payload-fields");
  const root = fs.mkdtempSync(join(tmpdir(), "watch-header."));
  try {
    const path = join(root, "message.md");
    // The first CR lands at byte 511; its LF arrives in the next read.
    const prefix = "---\r\npad: " + "x".repeat(511 - Buffer.byteLength("---\r\npad: "));
    fs.writeFileSync(path, prefix + "\r\nfrom: first\r\nfrom: é雪\r\n---\r\nfrom: body\n" + "x".repeat(1 << 20));
    const realRead = fs.readSync;
    let bytes = 0;
    const read = spyOn(fs, "readSync").mockImplementation(((...args: any[]) => {
      const n = (realRead as any)(...args); bytes += n; return n;
    }) as any);
    try {
      expect(readFrontmatter(path).from).toBe("é雪");
      expect(bytes).toBeLessThanOrEqual(1024);
    } finally { read.mockRestore(); }
    fs.writeFileSync(path, "---\rfrom: lone-cr\rto: target");
    expect({ ...readFrontmatter(path) }).toEqual({ from: "lone-cr", to: "target" });
  } finally { removeScratchTree(root); }
});
