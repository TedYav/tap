// Retained controls for the shared payload resolver.
//
// The port's PARITY evidence was a differential against the Python incumbent,
// which this PR deletes; a receipt that can only be produced once is not a
// control. These arms assert the resolver's answers directly, and each one is a
// shape a reader-facing bug reached through: resolution ORDER (a symlink is
// followed before the `..` after it), a dangling pointer that still names a real
// address, and the late local-precedence filter — which a reviewer falsified as
// unreachable by building the fixture the original matrix lacked.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { resolvePayloadAddress, resolutionLine } from "../src/payload-view";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "tap-payload-resolver.")));
let serial = 0;
function fixture() {
  const root = join(scratch, String(serial++)), bus = join(root, ".tap/bus"), index = join(root, "index.json");
  for (const d of ["payloads", "payloads/.quarantine", "spool/digests", "archive", "receipts"]) mkdirSync(join(bus, d), { recursive: true });
  writeFileSync(index, JSON.stringify({ teams: {} }));
  return { root, bus, index };
}
const line = (f: { bus: string; index: string }, arg: string, mode: "payloads" | "show" | "read-recipient" = "show", explicit = "", actor = "") =>
  resolutionLine(resolvePayloadAddress(arg, f.bus, f.index, mode, explicit, actor));
const found = (path: string, residency: string, team = "") => ["found", path, team, residency].join("\x1f");

test("an explicit pointer follows a symlink before interpreting the `..` after it", () => {
  const f = fixture();
  const foreign = join(f.root, "foreign");
  mkdirSync(join(foreign, "child"), { recursive: true });
  const correct = join(foreign, "note.md");
  writeFileSync(correct, "correct bytes");
  // The decoy: lexically collapsing `link/..` lands here instead, exits 0, and
  // hands the reader a different payload rather than an error.
  writeFileSync(join(f.bus, "note.md"), "wrong bytes");
  symlinkSync(join(foreign, "child"), join(f.bus, "link"));
  expect(line(f, "", "show", f.bus + "/link/../note.md")).toBe(found(correct, "payloads"));
});

test("a dangling canonical pointer resolves its target's current residency", () => {
  const f = fixture(), id = "cancelled-id";
  const foreign = join(f.root, "foreign");
  mkdirSync(join(foreign, "payloads"), { recursive: true });
  mkdirSync(join(foreign, "archive"));
  const cancelled = join(foreign, "archive", id + ".cancelled.md");
  writeFileSync(cancelled, "withdrawn bytes");
  const pointer = join(f.bus, "alias.md");
  // The link's target no longer exists: cancel moved it. The link still names
  // the address, and the address still resolves.
  symlinkSync(join(foreign, "payloads", id + ".md"), pointer);
  expect(line(f, "path=" + pointer)).toBe(found(cancelled, "archive"));
});

test("local precedence still filters after realpath splits one argument into two logical ids", () => {
  const f = fixture(), id = "local-id";
  const foreign = join(f.root, "foreign/payloads");
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, "other-id.md"), "foreign bytes");
  // `payloads/local-id.md` resolves to a DIFFERENT logical id, so the residency
  // fold groups the two candidates separately and cannot choose between them.
  // The late `payloads|digest|spool`-on-the-local-bus filter is what leaves one.
  symlinkSync(join(foreign, "other-id.md"), join(f.bus, "payloads", id + ".md"));
  const digest = join(f.bus, "spool/digests", id + ".json");
  writeFileSync(digest, JSON.stringify({ kind: "digest", items: [] }));
  expect(line(f, id)).toBe(found(digest, "digest"));
});

test("residency precedence prefers a live payload over its own withdrawn and quarantined states", () => {
  const f = fixture(), id = "sender-20260905T130000Z-012345abcdef";
  writeFileSync(join(f.bus, "archive", id + ".cancelled.md"), "withdrawn");
  writeFileSync(join(f.bus, "payloads/.quarantine", id + ".md.7"), "unparseable");
  expect(line(f, id)).toBe(found(join(f.bus, "archive", id + ".cancelled.md"), "archive"));
  writeFileSync(join(f.bus, "payloads", id + ".md"), "live");
  expect(line(f, id)).toBe(found(join(f.bus, "payloads", id + ".md"), "payloads"));
});

test("the residency rank chooses between versions of one id, never between two ids", () => {
  const f = fixture(), alice = "alice-20260905T130000Z-012345abcdef", bob = "bob-20260905T130001Z-012345abcdef";
  writeFileSync(join(f.bus, "payloads", alice + ".md"), "alice is live");
  writeFileSync(join(f.bus, "payloads/.quarantine", bob + ".md"), "bob never parsed");
  // Both are reachable under the same 12-hex suffix and they are DIFFERENT
  // messages. Ranking across the pair would hand the reader alice and drop bob
  // without a word; the suffix is simply not an address here.
  expect(line(f, "012345abcdef")).toStartWith("ambiguous\x1f");
  expect(line(f, "012345abcdef")).toContain(alice + ".md");
  expect(line(f, "012345abcdef")).toContain(bob + ".md");
  // Each remains individually addressable, at its own residency.
  expect(line(f, alice)).toBe(found(join(f.bus, "payloads", alice + ".md"), "payloads"));
  expect(line(f, bob)).toBe(found(join(f.bus, "payloads/.quarantine", bob + ".md"), "quarantine"));
});

test("re-quarantined evidence resolves to its newest preserved bytes", () => {
  const f = fixture(), id = "sender-20260905T130000Z-012345abcdef";
  for (const name of [id + ".md", id + ".md.2", id + ".md.11"]) writeFileSync(join(f.bus, "payloads/.quarantine", name), name);
  expect(line(f, id)).toBe(found(join(f.bus, "payloads/.quarantine", id + ".md.11"), "quarantine"));
});

test("queued mail is invisible to reply-class lookups and refused for a foreign reader", () => {
  const f = fixture(), id = "sender-20260905T130000Z-012345abcdef";
  writeFileSync(join(f.bus, "spool", id + ".md"), "parked");
  writeFileSync(join(f.bus, "spool", id + ".meta.json"), JSON.stringify({ target: "another-seat" }));
  expect(line(f, id, "payloads")).toStartWith("missing\x1f");
  expect(line(f, id, "show")).toBe(found(join(f.bus, "spool", id + ".md"), "spool"));
  expect(line(f, id, "read-recipient", "", "another-seat")).toBe(found(join(f.bus, "spool", id + ".md"), "spool"));
  expect(line(f, id, "read-recipient", "", "")).toBe("notrecipient\x1f" + id);
  // No actor is refused BEFORE custody is compared, so malformed queue metadata
  // can never make an anonymous caller look like the addressee. With the order
  // reversed, an empty `target` matches an empty actor and hands over the bytes.
  writeFileSync(join(f.bus, "spool", id + ".meta.json"), JSON.stringify({ target: "" }));
  expect(line(f, id, "read-recipient", "", "")).toBe("notrecipient\x1f" + id);
});

test("read refuses a direct spool address at the boundary; a canonical pointer still follows the id", () => {
  const f = fixture(), id = "sender-20260905T130000Z-012345abcdef";
  const direct = join(f.bus, "spool", id + ".md");
  writeFileSync(direct, "parked");
  writeFileSync(join(f.bus, "spool", id + ".meta.json"), JSON.stringify({ target: "another-seat" }));
  // The queue is addressed by id, never by naming bytes inside it: a direct
  // spool address refuses at the normalized input boundary, independent of what
  // exists behind the name — `..` text, a symlink alias, or a ghost path.
  expect(line(f, "", "read-recipient", direct, "another-seat")).toStartWith("spool_address\x1f");
  expect(line(f, "", "read-recipient", join(f.bus, "payloads", "..", "spool", id + ".md"), "another-seat")).toStartWith("spool_address\x1f");
  symlinkSync(direct, join(f.root, "alias.md"));
  expect(line(f, "", "read-recipient", join(f.root, "alias.md"), "another-seat")).toStartWith("spool_address\x1f");
  expect(line(f, "", "read-recipient", join(f.bus, "spool", "ghost.md"), "another-seat")).toStartWith("spool_address\x1f");
  // A canonical pointer names payloads/ and is not a queue address: it follows
  // the id to the spool for the addressee. Forensics (show) and reply-class
  // lookups keep their own doors and refusals.
  expect(line(f, "", "read-recipient", join(f.bus, "payloads", id + ".md"), "another-seat")).toBe(found(direct, "spool"));
  expect(line(f, "", "show", direct, "another-seat")).toBe(found(direct, "spool"));
  expect(line(f, "", "payloads", direct, "another-seat")).toBe(found(direct, "spool"));
});

test("a direct spool address follows an enrolled foreign bus when the id is not live locally", () => {
  const f = fixture(), id = "sender-20260905T130000Z-012345abcdef";
  // Enroll a foreign team whose bus parks the id, addressed to another-seat.
  const away = join(f.root, "away");
  for (const d of ["payloads", "spool"]) mkdirSync(join(away, ".tap/bus", d), { recursive: true });
  writeFileSync(join(away, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "away" }, seats: {} }));
  writeFileSync(f.index, JSON.stringify({ teams: { away: { root: away, registry_location: join(away, "registry.json"), state: "registered" } } }));
  const parked = join(away, ".tap/bus/spool", id + ".md");
  writeFileSync(parked, "foreign parked bytes");
  writeFileSync(join(away, ".tap/bus/spool", id + ".meta.json"), JSON.stringify({ target: "another-seat" }));
  // Local evidence that is NOT live (archive/history/quarantine) must not
  // block the foreign live obligation.
  writeFileSync(join(f.bus, "archive", id + ".cancelled.md"), "old local bytes");
  // Foreign parked mail is reachable by the explicit address the poll renders;
  // the recipient gate behind the resolver stays authoritative.
  expect(line(f, "", "read-recipient", parked, "another-seat")).toBe(found(parked, "spool", "away"));
});

test("a direct spool address refuses when the id is live locally or the bus is not an enrolled foreign bus", () => {
  const f = fixture(), id = "sender-20260905T130000Z-012345abcdef";
  // Enroll a foreign team whose bus parks the id, addressed to another-seat.
  const away = join(f.root, "away");
  for (const d of ["payloads", "spool"]) mkdirSync(join(away, ".tap/bus", d), { recursive: true });
  const registry = join(away, "registry.json");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "away" }, seats: {} }));
  writeFileSync(f.index, JSON.stringify({ teams: { away: { root: away, registry_location: registry, state: "registered" } } }));
  const parked = join(away, ".tap/bus/spool", id + ".md");
  writeFileSync(parked, "foreign parked bytes");
  writeFileSync(join(away, ".tap/bus/spool", id + ".meta.json"), JSON.stringify({ target: "another-seat" }));
  // The id live on the local bus — in ANY live residency (canonical, queued
  // spool, digest) — means the local bus owns settlement: the explicit foreign
  // address refuses so the read teaches the id form. A same-id local spool
  // entry is live exactly like a canonical copy.
  writeFileSync(join(f.bus, "spool", id + ".md"), "local parked bytes");
  writeFileSync(join(f.bus, "spool", id + ".meta.json"), JSON.stringify({ target: "another-seat" }));
  expect(line(f, "", "read-recipient", parked, "another-seat")).toStartWith("spool_address\x1f");
  // A historical row is not an enrolled team, and neither is a row whose
  // acting registry cannot be read: the exception never opens.
  writeFileSync(f.index, JSON.stringify({ teams: { away: { root: away, registry_location: registry, state: "historical" } } }));
  expect(line(f, "", "read-recipient", parked, "another-seat")).toStartWith("spool_address\x1f");
  writeFileSync(f.index, JSON.stringify({ teams: { away: { root: away, registry_location: join(away, "missing.json"), state: "registered" } } }));
  expect(line(f, "", "read-recipient", parked, "another-seat")).toStartWith("spool_address\x1f");
  writeFileSync(f.index, JSON.stringify({ teams: { away: { root: away, registry_location: registry, state: "registered" } } }));
  // An arbitrary unenrolled spool path is not a foreign bus: it refuses.
  const stray = join(f.root, "stray");
  mkdirSync(join(stray, "spool"), { recursive: true });
  const strayPath = join(stray, "spool", id + ".md");
  writeFileSync(strayPath, "stray bytes");
  expect(line(f, "", "read-recipient", strayPath, "another-seat")).toStartWith("spool_address\x1f");
});

test("read and poll's shared spool authorization preserves recipient and metadata checks", () => {
  const { spoolAuthorized } = require("../src/payload-view") as typeof import("../src/payload-view");
  const f = fixture();
  const root = join(f.root, "wt"), bus = join(root, ".tap/bus");
  for (const d of ["payloads", "spool", "receipts"]) mkdirSync(join(bus, d), { recursive: true });
  mkdirSync(join(root, ".tap"), { recursive: true });
  const registry = join(root, ".tap/team-registry.json");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "spec" },
    seats: { reader: { instance: "reader|new", status: "active", adopted_handles: ["fork"], adopted_instances: { fork: "fork|old" } }, peer: { instance: "peer|new", status: "active" } } }));
  const indexDir = join(f.root, "idx");
  mkdirSync(indexDir, { recursive: true });
  writeFileSync(join(indexDir, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { spec: { root, registry_location: registry, state: "registered" } } }));
  const spool = join(bus, "spool");
  let serial = 0;
  const seed = (envelope: Record<string, string>, target: string, name = envelope.id!): string => {
    serial++;
    const payload = join(spool, `${name}.md`);
    const fields = Object.entries(envelope).map(([k, v]) => `${k}: ${v}`).join("\n");
    writeFileSync(payload, `---\n${fields}\npath: ${join(bus, "payloads", `${envelope.id}.md`)}\n---\n\nqueued body ${serial}\n`);
    writeFileSync(join(spool, `${name}.meta.json`), JSON.stringify({ id: envelope.id, target }));
    return payload;
  };
  const aimed = seed({ id: "snd-20260901T100001Z-aaaaaaaaaaaa", from: "sender", to: "reader", kind: "discuss", reply: "settle-only" }, "reader");
  const adopted = seed({ id: "snd-20260901T100002Z-bbbbbbbbbbbb", from: "sender", to: "fork", kind: "discuss", reply: "settle-only", to_adopted_from: "reader" }, "fork");
  const foreignTeam = seed({ id: "snd-20260901T100003Z-cccccccccccc", from: "sender", to: "reader", kind: "discuss", reply: "settle-only", to_team: "elsewhere" }, "reader");
  // The envelope names a different id than the file it lives in: neither
  // predicate may authorize an envelope that does not name its own file.
  const misnamed = seed({ id: "other-id", from: "sender", to: "reader", kind: "discuss", reply: "settle-only" }, "reader", "snd-20260901T100004Z-dddddddddddd");
  const drifted = seed({ id: "snd-20260901T100005Z-eeeeeeeeeeee", from: "sender", to: "reader", kind: "discuss", reply: "settle-only" }, "someone-else");

  const nativeVerdict = (payload: string, actor: string): boolean =>
    spoolAuthorized(payload, actor, { registryPath: registry, marker: "live", team: "spec", historyDir: "" });

  for (const [payload, actor, expected] of [
    [aimed, "reader", true],
    [aimed, "peer", false],
    [adopted, "reader", true],
    [foreignTeam, "reader", false],
    [misnamed, "reader", false],
    [drifted, "reader", false],
  ] as const) {
    expect(nativeVerdict(payload, actor), `native ${actor} ${payload}`).toBe(expected);
  }
});
