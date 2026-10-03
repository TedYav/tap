import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contextUsedPercent, contextQueueFacts, pendingInboundAsks } from "../src/context-census";
import { removeScratchTree } from "./support/scratch";
const root = mkdtempSync(join(tmpdir(), "context-census-"));
afterAll(() => removeScratchTree(root));

test("footer gauges include Claude Bar, invert Codex, and refuse absent or ambiguous readings", () => {
  expect(contextUsedPercent("codex", "Context 60% left")).toBe(40);
  expect(contextUsedPercent("claude", "40% (80K) ctx")).toBe(40);
  expect(contextUsedPercent("claude", "\x1b[32m40% (80000) ctx\x1b[0m")).toBe(40);
  expect(contextUsedPercent("opencode", "80K (40%)")).toBe(40);
  expect(contextUsedPercent("claude", "0% (0) ctx")).toBe(0);
  expect(contextUsedPercent("claude", "100% (1M) ctx")).toBe(100);
  for (const frame of ["Context 110% left", "Context 60% left\nContext 70% left", "Context 60% left\n" + "output\n".repeat(7), "no gauge"])
    expect(contextUsedPercent("codex", frame)).toBeNull();
  expect(contextUsedPercent("claude", "80K (40%)\n50% (100K) ctx")).toBeNull();
  expect(contextUsedPercent("cursor", "80K (40%)")).toBeNull();
});

test("cross-bus asks, settlement, malformed custody and outbound age keep their distinct meanings", () => {
  const local = join(root,"local/.tap/bus"), foreign = join(root,"foreign/.tap/bus"), index = join(root,"index.json");
  for (const bus of [local,foreign]) for (const dir of ["payloads","spool","receipts"]) mkdirSync(join(bus,dir),{recursive:true});
  writeFileSync(index,JSON.stringify({teams:{foreign:{root:join(root,"foreign")}}}));
  const facts = () => contextQueueFacts(local,index,"local",["peer","quiet"],200);
  expect(facts().peer).toEqual({pending_inbound_ask:false,last_outbound_age_seconds:null});
  const ask = join(foreign,"spool/ask.md");
  writeFileSync(ask,"---\nid: ask\nfrom: lead\nto: peer\nto_team: local\nreply: expected\n---\nReview");
  expect(facts().peer!.pending_inbound_ask).toBe(true);
  const outbound = join(local,"payloads/out.md");
  writeFileSync(outbound,"---\nid: out\nfrom: peer\nto: lead\nreply: settle-only\n---\nProgress"); utimesSync(outbound,180,180);
  expect(facts().peer!.last_outbound_age_seconds).toBe(20);
  expect(facts().quiet!.last_outbound_age_seconds).toBeNull();
  writeFileSync(join(foreign,"receipts/ask.done"),"");
  expect(facts().peer!.pending_inbound_ask).toBe(false);
  writeFileSync(join(local,"spool/race.meta.json"),"{}");
  expect(facts().peer!.pending_inbound_ask).toBeNull();
});

const askFile = (bus: string, folder: string, id: string, extra: string, to = "peer") =>
  writeFileSync(join(bus,folder,`${id}.md`),`---\nid: ${id}\nfrom: lead\nto: ${to}\n${extra}---\nWork`);

test("an addressee gate decides who owes each ask: true owes, false does not, null is unknown (tap-vl8cp)", () => {
  const local = join(root,"gate/.tap/bus"), index = join(root,"gate-index.json");
  for (const dir of ["payloads","spool","receipts"]) mkdirSync(join(local,dir),{recursive:true});
  askFile(local,"payloads","a1","kind: order\nreply: expected\nrecipient_instance: old\nto_adopted_from: pred\n","succ");
  const seen: unknown[] = [];
  const owed = (answer: boolean | null) => pendingInboundAsks(local,index,"local",["succ","other"],(ask, actor) => {
    seen.push([ask, actor]);
    return actor === "succ" ? answer : false;
  });
  expect(owed(true)).toEqual({succ:true,other:false});
  // The gate sees the envelope's own addressing, and is asked per candidate seat, not only the `to` seat.
  expect(seen).toContainEqual([{id:"a1",from:"lead",to:"succ",adoptedFrom:"pred",recipientInstance:"old"},"succ"]);
  expect(seen).toContainEqual([expect.objectContaining({id:"a1",to:"succ"}),"other"]);
  expect(owed(false)).toEqual({succ:false,other:false});
  expect(owed(null)).toEqual({succ:null,other:false});
  // An ask addressed to a seat that is not in `handles` can still be owed by a handle that adopted it.
  askFile(local,"payloads","a2","reply: expected\n","predecessor");
  expect(pendingInboundAsks(local,index,"local",["succ"],(ask) => ask.to === "predecessor")).toEqual({succ:true});
  // Legacy callers pass no gate: the `to` seat owes.
  expect(pendingInboundAsks(local,index,"local",["succ","other"])).toEqual({succ:true,other:false});
});

test("a positive claim needs sanctioned reply semantics; settled, note and cross-team asks owe nothing (tap-vl8cp)", () => {
  const local = join(root,"sem/local/.tap/bus"), foreign = join(root,"sem/foreign/.tap/bus"), index = join(root,"sem-index.json");
  for (const bus of [local,foreign]) for (const dir of ["payloads","spool","receipts"]) mkdirSync(join(bus,dir),{recursive:true});
  writeFileSync(index,JSON.stringify({teams:{foreign:{root:join(root,"sem/foreign")}}}));
  const owed = (gate?: () => boolean | null) => pendingInboundAsks(local,index,"local",["peer"],gate).peer;
  const yes = () => true;
  for (const gate of [undefined, yes]) {
    askFile(local,"payloads","bogus","reply: bogus\n");
    expect(owed(gate)).toBeNull();
    askFile(local,"payloads","real","reply: expected\n");
    expect(owed(gate)).toBe(true);
    writeFileSync(join(local,"receipts/real.done"),"");
    expect(owed(gate)).toBeNull();
    writeFileSync(join(local,"receipts/bogus.cancelled"),"");
    expect(owed(gate)).toBe(false);
    for (const id of ["real","bogus"]) for (const ext of ["done","cancelled"]) rmSync(join(local,`receipts/${id}.${ext}`),{force:true});
    rmSync(join(local,"payloads/bogus.md")); rmSync(join(local,"payloads/real.md"));
  }
  // A note owes nothing; a done or cancelled ask owes nothing; a foreign-team ask is nobody's here.
  askFile(local,"payloads","note","reply: settle-only\n");
  expect(owed(yes)).toBe(false);
  askFile(local,"payloads","m1","reply: expected\n");
  writeFileSync(join(local,"receipts/m1.cancelled"),"");
  expect(owed(yes)).toBe(false);
  askFile(foreign,"spool","far","reply: expected\nto_team: local\n");
  expect(owed(yes)).toBe(true);
  rmSync(join(foreign,"spool/far.md"));
  askFile(foreign,"spool","elsewhere","reply: expected\nto_team: other\n");
  expect(owed(yes)).toBe(false);
});
