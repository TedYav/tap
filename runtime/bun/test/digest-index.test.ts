// The digest index: writer, injection stamp, retention reaper — explicit
// expected outcomes. The differential against the pinned incumbent Python
// programs is the port's evidence and lives in the PR; this file states the
// behavior once for the next reader, including the retention rule the dark
// owner used to get wrong.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { digestIndexPath, reapSettledDigests, retainSeconds, stampInjected, writeDigestIndex, writeDigestIndexDoc, type DigestIndexDoc } from "../src/digest-index";

const NOW = 1789458203;

function scratch(): { root: string; spool: string; payloads: string; receipts: string; digests: string } {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "digest-index-"));
  const spool = join(root, "spool"), payloads = join(root, "payloads"), receipts = join(root, "receipts"), digests = join(spool, "digests");
  for (const d of [spool, payloads, receipts, digests]) mkdirSync(d, { recursive: true });
  return { root, spool, payloads, receipts, digests };
}
function fm(fields: Record<string, string>): string {
  return `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\nbody\n`;
}
function age(path: string, seconds: number): void {
  const t = new Date((NOW - seconds) * 1000); utimesSync(path, t, t);
}
function write(s: ReturnType<typeof scratch>, ids: string[], presettled: string[] = []): string {
  const indexPath = digestIndexPath(s.spool, "courier-d1");
  writeDigestIndex({ indexPath, digestId: "courier-d1", toTeam: "team", handle: "peer", courier: "courier", spoolDir: s.spool, payloadsDir: s.payloads,
    members: ids.map(id => ({ id, presettled: presettled.includes(id) })) });
  return indexPath;
}

test("the index is json.dump's bytes: sorted at every depth, two-space indent, ASCII, mode 0600, newline-terminated", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.spool, "a.md"), fm({ from: "équipe", kind: "discuss", reply: "expected" }));
    writeFileSync(join(s.payloads, "b.md"), fm({ from: "bob", kind: "order", reply: "settle-only", sentinel_preview: "bring it" }));
    const indexPath = write(s, ["a", "b"]);
    const bytes = readFileSync(indexPath, "utf8");
    expect((statSync(indexPath).mode & 0o777).toString(8)).toBe("600");
    expect(bytes).toBe(
      '{\n  "count": 2,\n  "digest_id": "courier-d1",\n  "from": "team/courier",\n' +
      '  "instructions": "TAP digest: 2 spooled payload(s) delivered in ONE wake. This digest id (courier-d1) records its own read separately from its items. Use `tap read courier-d1 --all` to read its items, then obey EACH item\'s reply= \\u2014 `tap reply <id> -f <file>` for an ask, `tap read <id>` for a note. One reply never covers the batch; 1 of 2 still owe a reply.",\n' +
      '  "items": [\n    {\n      "from": "\\u00e9quipe",\n      "id": "a",\n      "kind": "discuss",\n      "ordinal": 1,\n      "path": "' + join(s.payloads, "a.md") + '",\n      "reply": "expected"\n    },\n' +
      '    {\n      "from": "bob",\n      "id": "b",\n      "kind": "order",\n      "ordinal": 2,\n      "path": "' + join(s.payloads, "b.md") + '",\n      "reply": "settle-only",\n      "sentinel_preview": "bring it"\n    }\n  ],\n' +
      '  "kind": "digest",\n  "to": "peer",\n  "to_team": "team",\n  "v": 1\n}\n');
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("a member with no payload anywhere gets the defaults, and a presettled member is settled with reply none", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.spool, "a.md"), fm({ from: "alice", reply: "expected" }));
    const doc = JSON.parse(readFileSync(write(s, ["a", "ghost"], ["a"]), "utf8"));
    expect(doc.items[0]).toEqual({ from: "alice", id: "a", kind: "discuss", ordinal: 1, path: join(s.payloads, "a.md"), reply: "none", settled: true });
    expect(doc.items[1]).toEqual({ from: "", id: "ghost", kind: "discuss", ordinal: 2, path: join(s.payloads, "ghost.md"), reply: "expected" });
    expect(doc.instructions).toContain("1 of 2 still owe a reply. 1 of 2 carry `settled: true` and `reply: none`");
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("a rewrite drops members, keeps ordinals, carries the injection stamp, and refuses a new member", () => {
  const s = scratch();
  try {
    for (const id of ["a", "b", "c"]) writeFileSync(join(s.spool, `${id}.md`), fm({ from: id }));
    const indexPath = write(s, ["a", "b"]);
    expect(stampInjected(indexPath, new Date(NOW * 1000))).toBe(true);
    write(s, ["b"]);
    const doc = JSON.parse(readFileSync(indexPath, "utf8"));
    expect(doc.items).toEqual([{ from: "b", id: "b", kind: "discuss", ordinal: 2, path: join(s.payloads, "b.md"), reply: "expected" }]);
    expect(doc.injected_at_epoch).toBe(NOW);
    expect(() => write(s, ["b", "c"])).toThrow(/cannot add a member/);
    // The caller's own stamp wins over the carried one; a carried one fills an absent one.
    writeDigestIndexDoc(indexPath, { v: 1, digest_id: "courier-d1", kind: "digest", from: "team/courier", to: "peer", to_team: "team", count: 1, instructions: "x", items: [{ id: "b", path: "p" }], injected_at_epoch: NOW + 5 });
    expect(JSON.parse(readFileSync(indexPath, "utf8")).injected_at_epoch).toBe(NOW + 5);
    writeDigestIndexDoc(indexPath, { v: 1, digest_id: "courier-d1", kind: "digest", from: "team/courier", to: "peer", to_team: "team", count: 1, instructions: "x", items: [{ id: "b", path: "p" }] });
    expect(JSON.parse(readFileSync(indexPath, "utf8")).injected_at_epoch).toBe(NOW + 5);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("the stamp is a whole UTC epoch, and a missing or unparseable index is unstamped, not an error", () => {
  const s = scratch();
  try {
    const p = join(s.digests, "x.json");
    writeFileSync(p, '{"items": [], "carried": 2.0}\n');
    expect(stampInjected(p, new Date(NOW * 1000 + 999))).toBe(true);
    expect(readFileSync(p, "utf8")).toBe(`{\n  "carried": 2.0,\n  "injected_at_epoch": ${NOW},\n  "items": []\n}\n`);
    expect(stampInjected(join(s.digests, "none.json"))).toBe(false);
    writeFileSync(p, "nope");
    expect(stampInjected(p)).toBe(false);
    expect(readFileSync(p, "utf8")).toBe("nope");
    // Q6: a document that is one scalar parses — into a PyFloat/PyInt wrapper,
    // which is a JavaScript object — and Python's `doc["injected_at_epoch"] = …`
    // on a float raised. Unstamped, bytes untouched; a stamp cannot be
    // serialized into `1.0`.
    for (const scalar of ["1.0\n", "NaN\n", "-Infinity\n", "12345678901234567890\n"]) {
      writeFileSync(p, scalar);
      expect(stampInjected(p, new Date(NOW * 1000))).toBe(false);
      expect(readFileSync(p, "utf8")).toBe(scalar);
    }
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

const INDEX = (extra = "") => `{"items": [{"id": "a"}, {"id": "b"}]${extra}}\n`;
function seed(s: ReturnType<typeof scratch>, name: string, text: string, ageSeconds?: number): string {
  const p = join(s.digests, name); writeFileSync(p, text); if (ageSeconds !== undefined) age(p, ageSeconds); return p;
}
function done(s: ReturnType<typeof scratch>, id: string, via = "read", ageSeconds?: number): void {
  const p = join(s.receipts, `${id}.done`); writeFileSync(p, `{"via": "${via}"}\n`); if (ageSeconds !== undefined) age(p, ageSeconds);
}
const reap = (s: ReturnType<typeof scratch>, env: Record<string, string> = {}) =>
  reapSettledDigests(s.digests, s.receipts, { ...process.env, TAP_SPOOL_NOW: String(NOW), ...env });

test("retention: a delivered index goes after its stamp plus the window, and not before", () => {
  const s = scratch();
  try {
    done(s, "a"); done(s, "b");
    const old = seed(s, "old.json", INDEX(`, "injected_at_epoch": ${NOW - 90000}`));
    const young = seed(s, "young.json", INDEX(`, "injected_at_epoch": ${NOW - 100}`));
    reap(s);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(young)).toBe(true);
    reap(s, { TAP_DIGEST_RETAIN_SECONDS: "50" });
    expect(existsSync(young)).toBe(false);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("retention: an UN-INJECTED all-terminal index is NOT reaped inside publication's minimum window", () => {
  // CONTRACT.md § Retention: publication time protects a possibly staged
  // pointer. The dark owner's own GC used to reap this index at once — two
  // answers to "may this digest be reaped" in one runtime. This arm reds if
  // that answer comes back.
  const s = scratch();
  try {
    done(s, "a"); done(s, "b");
    const fresh = seed(s, "fresh.json", INDEX(), 100);
    const stale = seed(s, "stale.json", INDEX(), 90000);
    reap(s);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("retention: a courier-auto receipt is the fallback witness, and settled rows with no witness stay", () => {
  const s = scratch();
  try {
    done(s, "a", "courier-auto", 90000); done(s, "b", "read", 10);
    const witnessed = seed(s, "witnessed.json", INDEX(), 10);          // young index, old auto receipt → gone
    const settled = seed(s, "settled.json", '{"items": [{"id": "c", "settled": true}]}\n', 90000);
    done(s, "c");
    reap(s);
    expect(existsSync(witnessed)).toBe(false);
    expect(existsSync(settled)).toBe(true);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("retention: one live member keeps the index; an unreadable index goes; a non-object index stays", () => {
  const s = scratch();
  try {
    done(s, "a");
    const live = seed(s, "live.json", INDEX(`, "injected_at_epoch": ${NOW - 90000}`));
    const junk = seed(s, "junk.json", "nope");
    const arr = seed(s, "arr.json", "[1]\n", 90000);
    reap(s);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(junk)).toBe(false);
    expect(existsSync(arr)).toBe(true);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("retention: a key PRESENT with null is Python's None, not the .get default — null items are kept, a null id looks for None.done", () => {
  const s = scratch();
  try {
    // `for item in None` raises inside the incumbent's try, which reads as "not
    // elapsed" — an index whose items are null is retained however old it is.
    const nullItems = seed(s, "null-items.json", '{"items": null}\n', 90000);
    // `"%s.done" % None` is `None.done`: a courier-auto witness under that name
    // ages the index out; substituting "" would look for `.done` and keep it.
    done(s, "None", "courier-auto", 90000);
    const nullId = seed(s, "null-id.json", '{"items": [{"id": null}]}\n', 10);
    reap(s);
    expect(existsSync(nullItems)).toBe(true);
    expect(existsSync(nullId)).toBe(false);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("a payload that begins with a BOM has no frontmatter: Python keeps U+FEFF and strip() does not remove it", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.spool, "a.md"), "\ufeff" + fm({ from: "bom-alice", kind: "review", reply: "settle-only" }));
    const doc = JSON.parse(readFileSync(write(s, ["a"]), "utf8"));
    expect(doc.items[0]).toMatchObject({ id: "a", from: "", kind: "discuss", reply: "expected" });
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("Q1: prior ordinals written as 1.0/2.0 rewrite with stable integer ordinals; fractional, unsafe and duplicate ordinals still refuse", () => {
  const s = scratch();
  try {
    const doc = (items: Record<string, unknown>[]): DigestIndexDoc => ({ v: 1, digest_id: "courier-d1", kind: "digest", from: "team/courier", to: "peer", to_team: "team", count: items.length, instructions: "x", items });
    const p = join(s.digests, "courier-d1.json");
    writeFileSync(p, '{"items": [{"id": "a", "path": "pa", "ordinal": 1.0}, {"id": "b", "path": "pb", "ordinal": 2.0}]}\n');
    writeDigestIndexDoc(p, doc([{ id: "b", path: "pb" }]));
    expect(readFileSync(p, "utf8")).toContain('"ordinal": 2,');
    expect(readFileSync(p, "utf8")).not.toContain("2.0");
    for (const prior of ['[{"id": "a", "path": "pa", "ordinal": 1.5}]', '[{"id": "a", "path": "pa", "ordinal": 9007199254740993}]', '[{"id": "a", "path": "pa", "ordinal": 1}, {"id": "c", "path": "pc", "ordinal": 1}]']) {
      writeFileSync(p, `{"items": ${prior}}\n`);
      expect(() => writeDigestIndexDoc(p, doc([{ id: "a", path: "pa" }]))).toThrow();
    }
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("Q3: a temp name another writer already holds is refused and left byte-identical; an own temp is still cleaned after a write failure", () => {
  const s = scratch();
  const random = Math.random;
  try {
    Math.random = () => 0.5; // the candidate name is now `.digest.<pid36>i`
    const tmp = join(s.digests, `.digest.${process.pid.toString(36)}${(0.5).toString(36).slice(2, 8)}`);
    writeFileSync(tmp, "another writer's bytes\n");
    const p = join(s.digests, "courier-d1.json");
    expect(() => writeDigestIndexDoc(p, { v: 1, digest_id: "courier-d1", kind: "digest", from: "f", to: "t", to_team: "tt", count: 0, instructions: "x", items: [] })).toThrow(/EEXIST/);
    expect(readFileSync(tmp, "utf8")).toBe("another writer's bytes\n");
    expect(existsSync(p)).toBe(false);
    rmSync(tmp);
    // Own temp: the rename target is a directory, so the rename fails after the create.
    mkdirSync(p);
    expect(() => writeDigestIndexDoc(p, { v: 1, digest_id: "courier-d1", kind: "digest", from: "f", to: "t", to_team: "tt", count: 0, instructions: "x", items: [] })).toThrow();
    expect(existsSync(tmp)).toBe(false);
  } finally { Math.random = random; rmSync(s.root, { recursive: true, force: true }); }
});

test("Q4: bytes that are not UTF-8 are not a record — a corrupt courier-auto receipt is no witness, a corrupt index is unstamped and unreadable", () => {
  const s = scratch();
  try {
    // The receipt would be an old witness; with the raw byte it is not a
    // record, so the settled row has no witness and the index stays.
    const receipt = join(s.receipts, "a.done");
    writeFileSync(receipt, Buffer.concat([Buffer.from('{"via": "courier-auto", "x": "'), Buffer.from([0xff]), Buffer.from('"}\n')]));
    age(receipt, 90000);
    const kept = seed(s, "kept.json", '{"items": [{"id": "a", "settled": true}]}\n', 10);
    // A corrupt index is unreadable: unstamped without a rewrite, and reaped.
    const corrupt = seed(s, "corrupt.json", "", 90000);
    writeFileSync(corrupt, Buffer.concat([Buffer.from('{"items": [], "x": "'), Buffer.from([0xff]), Buffer.from('"}\n')]));
    const before = readFileSync(corrupt);
    expect(stampInjected(corrupt, new Date(NOW * 1000))).toBe(false);
    expect(readFileSync(corrupt).equals(before)).toBe(true);
    reap(s);
    expect(existsSync(kept)).toBe(true);
    expect(existsSync(corrupt)).toBe(false);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("Q5: a malformed row declines the terminality proof — a live tail behind it keeps the index; an all-terminal valid list still expires", () => {
  const s = scratch();
  try {
    done(s, "a");
    // [terminal a, 5, live b]: the incumbent proved terminality over the
    // prefix {a} and unlinked b's pointer. CONTRACT: EVERY listed item.
    const liveTail = seed(s, "live-tail.json", `{"items": [{"id": "a"}, 5, {"id": "b"}], "injected_at_epoch": ${NOW - 90000}}\n`);
    writeFileSync(join(s.receipts, "b.cancelled"), "{}\n");
    const allTerminal = seed(s, "all-terminal.json", `{"items": [{"id": "a"}, {"id": "b"}], "injected_at_epoch": ${NOW - 90000}}\n`);
    reap(s);
    expect(existsSync(liveTail)).toBe(true);
    expect(existsSync(allTerminal)).toBe(false);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("Q2: the codec reads what its writer emits — Infinity/NaN spellings are records, not unreadable indexes, and an odd receipt field cannot erase a witness", () => {
  const s = scratch();
  try {
    // A strict-JSON index carrying 1e999 is stamped (rewritten as `Infinity`)
    // and must still be readable to the reaper: live members keep it.
    const carried = seed(s, "carried.json", '{"items": [{"id": "a"}, {"id": "b"}], "x": 1e999}\n');
    expect(stampInjected(carried, new Date((NOW - 90000) * 1000))).toBe(true);
    expect(readFileSync(carried, "utf8")).toContain('"x": Infinity\n');
    // A pre-existing NaN index with live members is retained, as Python retains it.
    const nan = seed(s, "nan.json", `{"items": [{"id": "a"}, {"id": "b"}], "x": NaN, "injected_at_epoch": ${NOW - 90000}}\n`, 90000);
    // A RECENT courier-auto receipt with an unrelated Infinity field is the
    // witness for an old un-stamped index: the window has not elapsed.
    const witnessed = seed(s, "witnessed.json", '{"items": [{"id": "c"}]}\n', 90000);
    writeFileSync(join(s.receipts, "c.done"), '{"via": "courier-auto", "x": Infinity}\n');
    age(join(s.receipts, "c.done"), 10);
    done(s, "a");
    reap(s);
    expect(existsSync(carried)).toBe(true);
    expect(existsSync(nan)).toBe(true);
    expect(existsSync(witnessed)).toBe(true);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("the retain knob: empty or non-numeric is the default, digits are seconds", () => {
  expect(retainSeconds({} as NodeJS.ProcessEnv)).toBe(86400);
  expect(retainSeconds({ TAP_DIGEST_RETAIN_SECONDS: "" } as NodeJS.ProcessEnv)).toBe(86400);
  expect(retainSeconds({ TAP_DIGEST_RETAIN_SECONDS: "1x" } as NodeJS.ProcessEnv)).toBe(86400);
  expect(retainSeconds({ TAP_DIGEST_RETAIN_SECONDS: "-5" } as NodeJS.ProcessEnv)).toBe(86400);
  expect(retainSeconds({ TAP_DIGEST_RETAIN_SECONDS: "0" } as NodeJS.ProcessEnv)).toBe(0);
});
