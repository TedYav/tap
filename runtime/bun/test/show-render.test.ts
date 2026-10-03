// Ported from skills/tap/scripts/smoke/show-render-parity.test.sh (deleted):
// byte snapshots captured from tap_show_render.py at
// 786517b51987ab7a64238d3506e3a1d9744ac10e. renderShow is the production
// route (verbs/show.ts imports it); only the path header is normalized,
// quarantine body bytes stay exact.
import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { renderShow } from "../src/show-render";

const golden: Record<string, string> = JSON.parse(
  readFileSync(join(import.meta.dir, "show-render-parity.sha256.json"), "utf8"),
);
const MISSING = Symbol("missing");

let work = "";
function bus(name: string): string {
  const dir = join(work, name);
  mkdirSync(join(dir, "receipts"), { recursive: true });
  mkdirSync(join(dir, "spool"), { recursive: true });
  return dir;
}

function replacePathBytes(bytes: Uint8Array, path: string): Uint8Array {
  const needle = Buffer.from(path);
  const at = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).indexOf(needle);
  expect(at).toBeGreaterThanOrEqual(0);
  const head = bytes.subarray(0, at);
  const tail = bytes.subarray(at + needle.byteLength);
  const out = new Uint8Array(head.byteLength + 9 + tail.byteLength);
  out.set(head); out.set(Buffer.from("<payload>"), head.byteLength); out.set(tail, head.byteLength + 9);
  return out;
}

let cases = 0;
function check(name: string, raw: Uint8Array, opts: {
  residency?: string; team?: string; explanation?: string;
  metadata?: Uint8Array | typeof MISSING; receipts?: Record<string, Uint8Array>;
} = {}) {
  const { residency = "payloads", team = "local", explanation = "", metadata = MISSING, receipts = {} } = opts;
  const dir = bus(name);
  const input = join(dir, "input.md");
  writeFileSync(input, raw);
  const ident = "fixture";
  if (metadata !== MISSING) writeFileSync(join(dir, "spool", `${ident}.meta.json`), metadata);
  for (const [kind, value] of Object.entries(receipts)) {
    writeFileSync(join(dir, "receipts", `${ident}.${kind}`), value);
  }
  const out = renderShow(input, dir, ident, team, residency, explanation);
  const actual = createHash("sha256").update(replacePathBytes(out, input)).digest("hex");
  expect([name, actual]).toEqual([name, golden[name]!]);
  if (residency === "quarantine") {
    const tail = Buffer.concat([Buffer.from("body:\n"), Buffer.from(raw)]);
    expect(Buffer.from(out).subarray(out.byteLength - tail.byteLength)).toEqual(tail);
  }
  cases++;
}

const normal = Buffer.from("---\nfrom: sender\nto: reader\n---\n\nhello\n\n", "utf8");

test("renderShow byte snapshots match the retired renderer's captured hashes", () => {
  work = mkwork();
  check("normal", normal);
  check("empty", Buffer.alloc(0));
  check("no-final-newline", Buffer.from("---\nx: y\n---\nbody", "utf8"));
  check("crlf", Buffer.from("---\r\nx: y\r\n---\r\n\r\nbody\r\n\r\n", "utf8"));
  check("cr-only", Buffer.from("---\rx: y\r---\rbody\r", "utf8"));
  check("body-spaces", Buffer.from("---\n---\n\n  keep spaces  \n\n", "utf8"));
  check("fence-padding", Buffer.from(" \t--- \t\n x: y \n\t--- \nbody", "utf8"));
  check("unclosed-front", Buffer.from("---\nx: y\nbody", "utf8"));
  check("no-front", Buffer.from("not frontmatter\n---\nbody", "utf8"));
  check("bom-no-front", Buffer.from("\xef\xbb\xbf---\nx: y\n---\nbody", "latin1"));
  check("unicode-lines", Buffer.from("---\u2028x: y\x85---\x0bbody\x0cmore\x1ctext\x1drows\x1eend\u2029", "utf8"));
  check("replacement-decode", Buffer.from("---\nx: \xff\n---\nbody\xc3(\xed\xa0\x80", "latin1"));
  check("archive", normal, { residency: "archive", explanation: "cancelled by sender" });
  check("no-team", normal, { team: "" });

  for (const [name, raw] of [
    ["raw-invalid-utf8", "\xff\xfe\x80broken\xc3("],
    ["raw-crlf", "---\r\nbroken\r\n"],
    ["raw-no-newline", "raw bytes"],
    ["raw-empty", ""],
    ["raw-nul", "\x00\xff\r\nlast\x00"],
  ] as const) {
    check(name, Buffer.from(raw, "latin1"), { residency: "quarantine", explanation: "quarantine explanation" });
  }

  // Insertion order deliberately opposes display order. Sent is never printed.
  const json = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");
  check("receipt-order-values", normal, { receipts: {
    sent: json({ at: "SHOULD NOT APPEAR" }),
    unconfirmed: json({ at: "last", by: "seat" }),
    cancelled: json({ at: null, forced: false, reason: { why: true, nested: [null, "can't", false] } }),
    done: json({ at: 0, by: 0, via: [], identity: {}, forced: true, reason: ["a", null, 1] }),
    read: json({ at: "", by: false, via: null, identity: "", forced: 0, reason: "résumé" }),
    placed: json({ at: "2026-09-07T23:00:00Z", by: "sender", via: "tmux", identity: "seat", forced: false }),
  } });
  check("sent-only", normal, { receipts: { sent: json({ at: "hidden" }) } });
  check("malformed-receipts", normal, { receipts: { placed: Buffer.from("{", "utf8"), read: Buffer.from("\xff", "latin1"), done: Buffer.alloc(0) } });
  check("receipt-at-values", normal, { receipts: {
    placed: json({ at: false }), read: json({ at: [] }), done: json({ at: {} }),
    cancelled: json({ at: ["a", null] }), unconfirmed: json({ at: "😀" }),
  } });
  check("receipt-python-repr", normal, { receipts: { done: json({
    by: { "don't": 'a"b', escaped: "\n\t\\", emoji: "😀" },
    via: [true, false, null, { a: 1 }], reason: 1e-7,
  }) } });

  for (const [name, metadata] of [
    ["missing", MISSING], ["empty-object", Buffer.from("{}", "utf8")], ["malformed", Buffer.from("{", "utf8")],
    ["array", Buffer.from("[]", "utf8")], ["null", Buffer.from("null", "utf8")], ["string", Buffer.from('"text"', "utf8")],
    ["invalid-utf8", Buffer.from('{"reason":"\xff"}', "latin1")],
    ["values", Buffer.from(JSON.stringify({ reason: "é😀", policy: { b: true, a: [null, 1] },
      waiter_lifetime: false, deadline_epoch: null, attempts: 3 }), "utf8")],
    ["numbers", Buffer.from('{"reason":1e-7,"policy":1e20,"waiter_lifetime":1.0,"deadline_epoch":1e21,"attempts":-0.0}', "utf8")],
  ] as const) {
    check(`spool-${name}`, normal, { residency: "spool", metadata: metadata === MISSING ? MISSING : Buffer.from(metadata) });
  }
  check("canonical-with-meta", normal, { metadata: Buffer.from('{"attempts":2}', "utf8"), explanation: "metadata remains after delivery" });
  check("number-lexemes", normal, { residency: "spool", metadata: Buffer.from('{"reason":{"10":true,"2":null},"attempts":9007199254740993,"deadline_epoch":1e-4}', "utf8") });
  check("duplicate-nonfinite", normal, { residency: "spool", metadata: Buffer.from('{"attempts":1,"attempts":2,"reason":NaN,"policy":-Infinity}', "utf8") });
  expect(cases).toBe(36);
});

function mkwork(): string {
  const dir = join(tmpdir(), `tap-show-parity-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("renderShow prints one also: line per lower-ranked residency under the residency header", () => {
  work = mkwork();
  const dir = bus("also"), input = join(dir, "input.md");
  writeFileSync(input, "---\nid: fixture\n---\n\nhello\n");
  const out = Buffer.from(renderShow(input, dir, "fixture", "local", "payloads", "", [
    { residency: "archive", count: 1, example: "archive/fixture.cancelled.md" },
    { residency: "quarantine", count: 2, example: "payloads/.quarantine/fixture.md.1" },
  ])).toString().split("\n");
  expect(out.filter(line => line.startsWith("also:"))).toEqual([
    "also: archive ×1 (archive/fixture.cancelled.md)", "also: quarantine ×2 (payloads/.quarantine/fixture.md.1)",
  ]);
  expect(out.indexOf("also: archive ×1 (archive/fixture.cancelled.md)")).toBeLessThan(out.indexOf("receipts:"));
  expect(Buffer.from(renderShow(input, dir, "fixture", "local", "payloads", "")).toString()).not.toContain("also:");
});
