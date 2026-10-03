// Controls for digest viewing and member dispatch.
//
// The seams this verb CONSUMES — the reset fence, the generation touch, the
// registry event log, and the harness queue — are real fixture state, not
// mocks: a stub that only returns a status cannot tell "the call was skipped"
// from "the call happened and said yes", and every gate here is exactly that
// distinction. Members dispatch through an in-process callback, the same seam
// the verbs supply.
import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestView, forwardedArgs } from "../src/verbs/digest-view";
import { writeLiveFence } from "./support/live-fence";

const scratch = mkdtempSync(join(tmpdir(), "tap-digest-view."));
let serial = 0;
let out: string[] = [];
let err: string[] = [];
const writeOut = process.stdout.write.bind(process.stdout);
const writeErr = process.stderr.write.bind(process.stderr);
beforeEach(() => {
  out = []; err = [];
  process.stdout.write = ((chunk: string) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
});
afterAll(() => { process.stdout.write = writeOut; process.stderr.write = writeErr; });

interface Fx { bus: string; scripts: string; digest: (id: string, doc: unknown) => string; member: (id: string) => string; receipts: () => string[] }
function fixture(): Fx {
  const root = join(scratch, String(serial++));
  const bus = join(root, ".tap/bus"), scripts = join(root, "scripts");
  for (const d of ["payloads", "receipts", "spool/digests"]) mkdirSync(join(bus, d), { recursive: true });
  return {
    bus, scripts,
    digest(id, doc) {
      const path = join(bus, "spool/digests", id + ".json");
      writeFileSync(path, JSON.stringify(doc));
      return path;
    },
    member(id) {
      const path = join(bus, "payloads", id + ".md");
      writeFileSync(path, `---\nid: ${id}\n---\n\nbody\n`);
      return path;
    },
    receipts: () => readdirSync(join(bus, "receipts")).sort(),
  };
}
const seedGeneration = (f: Fx) => writeFileSync(join(f.bus, "reset-generation.json"), '{"state": "pristine"}\n');
const ID = "courier-20260905T130000Z-0123456789ab";
function digestDoc(f: Fx, members: string[], extra: Record<string, unknown> = {}) {
  return { kind: "digest", digest_id: ID, to: "reader", to_team: "spec",
    items: members.map((id, index) => ({ id, path: f.member(id), ordinal: index + 1 })), ...extra };
}

test("only actor and context flags reach a member; selectors and addresses never do", () => {
  expect(forwardedArgs(["--by", "reader", "--team", "spec", "--force", "--epoch", "7"]))
    .toEqual(["--by", "reader", "--team", "spec", "--force", "--epoch", "7"]);
  expect(forwardedArgs(["--item", "2", "--by", "reader", "--digest-address", "team/id"]))
    .toEqual(["--by", "reader"]);
  // A selector's VALUE is consumed, never re-read as argv. Skipping only the
  // flag looks identical on ordinary input — an ordinal or an address matches
  // nothing and is dropped anyway — and diverges exactly where it matters: a
  // value that is spelled like a flag would be promoted to one.
  expect(forwardedArgs(["--item", "--force", "--by", "reader"])).toEqual(["--by", "reader"]);
  expect(forwardedArgs(["--digest-address", "--by", "impostor"])).toEqual([]);
  expect(forwardedArgs(["--all", "--json", "-f", "body.md", "--by", "reader"])).toEqual(["--by", "reader"]);
  // A value-taking flag at the end of argv has no value to forward.
  expect(forwardedArgs(["--by"])).toEqual([]);
});

test("a repeated flag takes its LAST value, which is the one the caller was", () => {
  // The gate and the receipt must both read the value the CLI actually used.
  // Reading the first occurrence let an addressee gate pass under one handle
  // while the effective caller was another, and then stamped the immutable
  // first observation with the handle that did not make the call.
  const f = fixture();
  const path = f.digest(ID, digestDoc(f, ["alice-20260905T130000Z-aaaaaaaaaaaa"]));
  expect(digestView(["read", path, "1", "", f.scripts, "--by", "reader", "--by", "impostor", "--team", "spec"])).toBe(1);
  expect(err.join("")).toContain("not_addressee");
  expect(f.receipts()).toEqual([]);
  expect(existsSync(join(f.bus, "registry-events.log"))).toBe(false);

  const g = fixture();
  const gpath = g.digest(ID, digestDoc(g, ["alice-20260905T130000Z-aaaaaaaaaaaa"]));
  expect(digestView(["read", gpath, "1", "", g.scripts, "--by", "impostor", "--by", "reader", "--team", "spec"], () => 0)).toBe(0);
  expect(JSON.parse(readFileSync(join(g.bus, "receipts", ID + ".read"), "utf8")).by).toBe("reader");

  const h = fixture();
  const hpath = h.digest(ID, digestDoc(h, ["alice-20260905T130000Z-aaaaaaaaaaaa"]));
  expect(digestView(["read", hpath, "1", "", h.scripts, "--by", "reader", "--team", "wrong", "--team", "spec"], () => 0)).toBe(0);
  expect(h.receipts()).toEqual([ID + ".read"]);
});

test("a regression to a raw byte-count write cannot publish a truncated first observation", () => {
  // The receipt's name is claimed once and never rewritten, so bytes that reach
  // it must be complete. An unchecked `writeSync` put invalid JSON under that
  // permanent name; a real RLIMIT_FSIZE child demonstrated it but could not be
  // used as a control, because inside the runner the limited child dies before
  // reaching the receipt and the arm then passes on correct code and on the
  // defect alike.
  //
  // What this arm MEASURES, stated exactly (review): the spy intercepts
  // direct `fs.writeSync` calls only. On correct code that is ZERO interceptions
  // — `writeFileSync` does not route through `fs.writeSync` under Bun — so the
  // injection is inert there and the assertions run untruncated. The arm is a
  // regression pin for the raw-`writeSync` class, proven by the named mutant;
  // it does NOT verify whole-receipt publication for any other writer, and the
  // witness proves the spy is live, not that it bites the production write.
  // Instrument by the partner reviewer.
  const f = fixture();
  const path = f.digest(ID, digestDoc(f, ["alice-20260905T130000Z-aaaaaaaaaaaa"]));
  const original = fs.writeSync;
  const spy = spyOn(fs, "writeSync").mockImplementation(
    ((fd: number, data: string) => original(fd, data.slice(0, 100))) as typeof fs.writeSync);
  try {
    // Non-vacuous witness: the injected writer really does store only 100 bytes.
    // Without this the arm would also pass if the spy never took effect.
    const witness = join(f.bus, "short-write-witness"), fd = fs.openSync(witness, "wx");
    try { expect(fs.writeSync(fd, "x".repeat(256))).toBe(100); } finally { fs.closeSync(fd); }
    expect(fs.readFileSync(witness).byteLength).toBe(100);

    expect(digestView(["read", path, "1", "", f.scripts, "--by", "reader", "--team", "spec"], () => 0)).toBe(0);
    const bytes = fs.readFileSync(join(f.bus, "receipts", ID + ".read"));
    expect(bytes.byteLength).toBeGreaterThan(100);
    expect(JSON.parse(bytes.toString("utf8"))).toMatchObject({ id: ID, status: "read", by: "reader", digest: true });
    expect(bytes.toString("utf8")).toEndWith("\n");
  } finally { spy.mockRestore(); }
});

test("a bare read observes the envelope once, dispatches every member, and never settles the digest", () => {
  const f = fixture();
  const path = f.digest(ID, digestDoc(f, ["alice-20260905T130000Z-aaaaaaaaaaaa", "bob-20260905T130001Z-bbbbbbbbbbbb"]));
  seedGeneration(f);
  const dispatched: string[] = [];
  expect(digestView(["read", path, "1", "", f.scripts, "--by", "reader", "--team", "spec"], (p) => { dispatched.push(p); return 0; })).toBe(0);
  expect(f.receipts()).toEqual([ID + ".read"]);
  const receipt = JSON.parse(readFileSync(join(f.bus, "receipts", ID + ".read"), "utf8"));
  expect(receipt).toMatchObject({ id: ID, status: "read", via: "read", by: "reader", digest: true, forced: false, to: "reader" });
  expect(receipt.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  // The creator flipped the generation once; a forced-style override was never recorded.
  expect(readFileSync(join(f.bus, "reset-generation.json"), "utf8")).toContain('"first_mutation": "read digest"');
  expect(dispatched).toHaveLength(2);
  // The digest carries no `.done`: each member keeps its own obligation.
  expect(existsSync(join(f.bus, "receipts", ID + ".done"))).toBe(false);
  expect(existsSync(join(f.bus, "registry-events.log"))).toBe(false);
});

test("the first observation is immutable and only the call that created it touches the generation", () => {
  const f = fixture();
  const path = f.digest(ID, digestDoc(f, ["alice-20260905T130000Z-aaaaaaaaaaaa"]));
  seedGeneration(f);
  expect(digestView(["read", path, "1", "", f.scripts, "--by", "reader", "--team", "spec"], () => 0)).toBe(0);
  const first = readFileSync(join(f.bus, "receipts", ID + ".read"), "utf8");
  const generation = readFileSync(join(f.bus, "reset-generation.json"), "utf8");
  expect(digestView(["read", path, "1", "", f.scripts, "--by", "reader", "--team", "spec"], () => 0)).toBe(0);
  expect(readFileSync(join(f.bus, "receipts", ID + ".read"), "utf8")).toBe(first);
  expect(readFileSync(join(f.bus, "reset-generation.json"), "utf8")).toBe(generation);
  // The scratch file is linked into place and removed, never left behind.
  expect(f.receipts()).toEqual([ID + ".read"]);
});

test("a forced read overrides the addressee but records every override", () => {
  const f = fixture();
  const path = f.digest(ID, digestDoc(f, ["alice-20260905T130000Z-aaaaaaaaaaaa"], { to: "someone-else" }));
  expect(digestView(["read", path, "1", "", f.scripts, "--by", "reader", "--team", "spec"], () => 0)).toBe(1);
  expect(err.join("")).toContain("not_addressee");
  expect(f.receipts()).toEqual([]);
  expect(existsSync(join(f.bus, "registry-events.log"))).toBe(false);
  seedGeneration(f);
  for (const pass of [1, 2]) {
    expect(digestView(["read", path, "1", "", f.scripts, "--by", "reader", "--team", "spec", "--force"], () => 0)).toBe(0);
    const log = readFileSync(join(f.bus, "registry-events.log"), "utf8");
    expect(log.split("read_forced").length - 1).toBe(pass);
    expect(log).toContain(`detail=id=${ID}_digest=1`);
  }
  expect(readFileSync(join(f.bus, "reset-generation.json"), "utf8")).toContain('"first_mutation": "read digest"');
  expect(JSON.parse(readFileSync(join(f.bus, "receipts", ID + ".read"), "utf8")).forced).toBe(true);
});

test("a foreign team is refused even with --force, and so is an anonymous reader", () => {
  const f = fixture();
  const path = f.digest(ID, digestDoc(f, ["alice-20260905T130000Z-aaaaaaaaaaaa"]));
  for (const argv of [["--by", "reader", "--team", "other", "--force"], ["--team", "spec"], ["--by", "", "--team", "spec", "--force"]]) {
    expect(digestView(["read", path, "1", "", f.scripts, ...argv])).toBe(1);
  }
  expect(err.join("")).toContain("not_addressee");
  expect(f.receipts()).toEqual([]);
  expect(existsSync(join(f.bus, "registry-events.log"))).toBe(false);
});

test("a digest whose identity does not match its filename is refused before any effect", () => {
  const f = fixture();
  const path = f.digest(ID, digestDoc(f, ["alice-20260905T130000Z-aaaaaaaaaaaa"], { digest_id: "other-id" }));
  expect(digestView(["read", path, "1", "", f.scripts, "--by", "reader", "--team", "spec"])).toBe(1);
  expect(err.join("")).toContain("invalid digest identity");
  expect(f.receipts()).toEqual([]);
  expect(existsSync(join(f.bus, "registry-events.log"))).toBe(false);
  const bad = f.digest(ID, digestDoc(f, ["alice-20260905T130000Z-aaaaaaaaaaaa"], { digest_id: "../escape" }));
  expect(digestView(["read", bad, "1", "", f.scripts, "--by", "reader", "--team", "spec"])).toBe(1);
  expect(f.receipts()).toEqual([]);
});

test("a refusing fence stops the read before the receipt, and its status is the verb's", () => {
  const f = fixture();
  writeLiveFence(join(f.bus, "reset.fence.json"));
  const path = f.digest(ID, digestDoc(f, ["alice-20260905T130000Z-aaaaaaaaaaaa"]));
  expect(digestView(["read", path, "1", "", f.scripts, "--by", "reader", "--team", "spec"], () => 0)).toBe(1);
  expect(err.join("")).toContain("mid-reset");
  expect(f.receipts()).toEqual([]);
});

test("a member whose filename and id disagree is skipped and its siblings still run", () => {
  const f = fixture();
  const good = "alice-20260905T130000Z-aaaaaaaaaaaa", bad = "bob-20260905T130001Z-bbbbbbbbbbbb";
  const doc = digestDoc(f, [good, bad]);
  doc.items[1]!.path = join(f.bus, "payloads", "not-the-id.md");
  const path = f.digest(ID, doc);
  const dispatched: string[] = [];
  expect(digestView(["read", path, "1", "", f.scripts, "--by", "reader", "--team", "spec"], (p) => { dispatched.push(p); return 0; })).toBe(1);
  expect(err.join("")).toContain(`item ${bad} path does not match its payload id`);
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]).toContain(good);
});

test("a failing member makes the aggregate non-zero without stopping the rest", () => {
  const f = fixture();
  const path = f.digest(ID, digestDoc(f, ["alice-20260905T130000Z-aaaaaaaaaaaa", "bob-20260905T130001Z-bbbbbbbbbbbb"]));
  const dispatched: string[] = [];
  expect(digestView(["read", path, "1", "", f.scripts, "--by", "reader", "--team", "spec"], (p) => { dispatched.push(p); return 1; })).toBe(1);
  expect(dispatched).toHaveLength(2);
});

test("show never writes, never gates on an addressee, and lists without dispatching", () => {
  const f = fixture();
  const path = f.digest(ID, digestDoc(f, ["alice-20260905T130000Z-aaaaaaaaaaaa"], { to: "someone-else" }));
  expect(digestView(["show", path, "0", "", f.scripts])).toBe(0);
  expect(f.receipts()).toEqual([]);
  expect(out.join("")).toContain("digest: " + ID);
  // A selected member goes through the ordinary show gate, still writing nothing.
  const dispatched: string[] = [];
  expect(digestView(["show", path, "0", "alice-20260905T130000Z-aaaaaaaaaaaa", f.scripts], (p) => { dispatched.push(p); return 0; })).toBe(0);
  expect(dispatched).toHaveLength(1);
  expect(f.receipts()).toEqual([]);
});

test("a single-member read observes only its member: no digest receipt, no envelope gate", () => {
  const f = fixture();
  const path = f.digest(ID, digestDoc(f, ["alice-20260905T130000Z-aaaaaaaaaaaa"], { to: "someone-else" }));
  const dispatched: string[] = [];
  expect(digestView(["read", path, "0", "alice-20260905T130000Z-aaaaaaaaaaaa", f.scripts, "--by", "reader", "--team", "spec"], (p) => { dispatched.push(p); return 0; })).toBe(0);
  expect(f.receipts()).toEqual([]);
  expect(dispatched).toHaveLength(1);
  expect(existsSync(join(f.bus, "registry-events.log"))).toBe(false);
});

test("a malformed digest document is a refusal, not a crash or a partial dispatch", () => {
  const f = fixture();
  const path = join(f.bus, "spool/digests", ID + ".json");
  // Asserted PER BODY: one `toContain` over the whole loop passes as long as any
  // single body produces the text, which lets a rejection quietly move to a
  // different layer — with a different message — for the others.
  for (const body of ["not json", "[]", "null", JSON.stringify({ kind: "note", items: [] }),
                      JSON.stringify({ kind: "digest" }), JSON.stringify({ kind: "digest", items: [{ id: 1, path: "x" }] }),
                      JSON.stringify({ kind: "digest", items: [{ id: "a", path: 2 }] })]) {
    writeFileSync(path, body);
    err = [];
    expect(digestView(["read", path, "1", "", f.scripts, "--by", "reader", "--team", "spec"])).toBe(1);
    expect(err.join("")).toStartWith(`tap read: invalid digest ${path}: `);
  }
  expect(f.receipts()).toEqual([]);
  expect(existsSync(join(f.bus, "registry-events.log"))).toBe(false);
});

test("an in-process member that throws an ordinary error renders a bounded refusal and the next sibling still runs", () => {
  const f = fixture();
  const path = f.digest(ID, digestDoc(f, ["alice-20260905T130000Z-aaaaaaaaaaaa", "bob-20260905T130001Z-bbbbbbbbbbbb"]));
  const rendered: string[] = [];
  out = []; err = [];
  const status = digestView(["show", path, "1", "", f.scripts], (memberPath, forward) => {
    if (memberPath.includes("alice")) throw new Error("boom");
    rendered.push(memberPath); expect(forward).toEqual([]);
    return 0;
  });
  expect(status).toBe(1);
  expect(rendered).toHaveLength(1);
  expect(rendered[0]).toContain("bob-20260905T130001Z-bbbbbbbbbbbb");
  expect(err.join("")).toContain("could not dispatch 'alice-20260905T130000Z-aaaaaaaaaaaa'");
  expect(err.join("")).toContain("boom");
});
