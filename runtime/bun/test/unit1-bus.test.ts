// Unit 1 — bus primitives: id discipline, envelope stamp/validate, atomic write,
// receipt shapes. Every expectation here is a fact read off the incumbent bash tap
// or CONTRACT.md, not a preference: these bytes are what the interop arms compare.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { mintId, validId, validToken, validPathToken, idAgeSeconds } from "../src/ids";
import { parseEnvelope, stampEnvelope, validateEnvelope } from "../src/envelope";
import { atomicWrite, jsonObj, stagingPath } from "../src/fsatomic";
import { Bus } from "../src/bus";
import { removeScratchTree } from "./support/scratch";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "tap-bun-u1.")); });
afterEach(() => { removeScratchTree(root); });

describe("id discipline (CONTRACT §IDs)", () => {
  test("mints <sender>-<utc-compact>-<hex>", () => {
    const id = mintId("opus-runner-A");
    expect(id).toMatch(/^opus-runner-A-\d{8}T\d{6}Z-[0-9a-f]{12}$/);
  });

  test("two mints in the same second still differ", () => {
    const a = mintId("s"), b = mintId("s");
    expect(a).not.toBe(b);
  });

  test("charset gate matches ^[A-Za-z0-9][A-Za-z0-9._-]*$", () => {
    expect(validId("a")).toBe(true);
    expect(validId("a.b_c-d")).toBe(true);
    expect(validId("")).toBe(false);
    expect(validId(".lead")).toBe(false);
    expect(validId("-lead")).toBe(false);
    expect(validId("has space")).toBe(false);
    expect(validId("has]bracket")).toBe(false);
    expect(validId("team/handle")).toBe(false);
    expect(validId("team:handle")).toBe(false);
  });

  test("validToken is the same predicate (routing fields share the id charset)", () => {
    expect(validToken("discuss")).toBe(true);
    expect(validToken("a b")).toBe(false);
    expect(validToken("fable-3")).toBe(true);
    expect(validToken("")).toBe(false);
    // Strict, always: a qualified separator is never part of a plain token (codex P1;
    // the retired Bash tap_valid_token's case table).
    expect(validToken("teamb:hermes")).toBe(false);
    expect(validToken("teamb/hermes")).toBe(false);
    expect(validToken("tap:fable-3")).toBe(false);
  });

  test("path tokens must be sentinel-safe: no whitespace, no ]", () => {
    expect(validPathToken("/a/b/c.md")).toBe(true);
    expect(validPathToken("/a b/c.md")).toBe(false);
    expect(validPathToken("/a]b/c.md")).toBe(false);
  });

  test("refuses to mint for a sender that fails the charset", () => {
    expect(() => mintId("bad handle")).toThrow();
  });

  test("age comes from the id's own UTC stamp, never file mtime", () => {
    const now = Math.floor(Date.parse("2026-08-23T10:00:00Z") / 1000);
    const w: string[] = [];
    expect(idAgeSeconds("s-20260823T095900Z-abc", now, (m) => w.push(m))).toBe(60);
    expect(idAgeSeconds("not-an-id", now, (m) => w.push(m))).toBeNull();
    expect(w).toEqual([]);   // no warning on ordinary or unparseable ids
  });

  // Assert the EFFECT, not only the number: a test that checks the return value
  // alone stays green if the warning is deleted, and a silent clamp turns a
  // broken clock into a permanently young obligation nothing ever surfaces.
  test("a future-stamped id clamps to 0 AND warns, naming the id and the clamp", () => {
    const now = Math.floor(Date.parse("2026-08-23T10:00:00Z") / 1000);
    const w: string[] = [];
    expect(idAgeSeconds("s-20260823T100100Z-abc", now, (m) => w.push(m))).toBe(0);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("payload id 's-20260823T100100Z-abc' is future-stamped");
    expect(w[0]).toContain("60s ahead of now");
    expect(w[0]).toContain("treating age as 0");
  });

  test("an impossible calendar date is refused, not normalized into a real one", () => {
    const now = Math.floor(Date.parse("2026-08-23T10:00:00Z") / 1000);
    for (const bad of ["s-20260231T100000Z-a", "s-20261301T100000Z-a", "s-20260823T250000Z-a", "s-20260229T100000Z-a"]) {
      expect(idAgeSeconds(bad, now, () => {})).toBeNull();
    }
    expect(idAgeSeconds("s-20280229T100000Z-a", now, () => {})).not.toBeNull();  // real leap day
  });

  // Date.UTC(y, ...) reads a year in 0..99 as an offset from 1900.
  test("a year below 100 is that year, not 1900 + it", () => {
    expect(idAgeSeconds("s-00010101T000000Z-abc", 0, () => {})).toBe(62135596800);
  });
});

describe("envelope parse (frontmatter is flat key: value between --- fences)", () => {
  test("reads fields and returns the body verbatim", () => {
    const p = join(root, "a.md");
    writeFileSync(p, "---\nid: x\nfrom: a\n---\nbody line\n");
    const { fields, body } = parseEnvelope(readFileSync(p, "utf8"));
    expect(fields.id).toBe("x");
    expect(fields.from).toBe("a");
    expect(body).toBe("body line\n");
  });

  test("a body containing a --- line does not terminate the frontmatter early", () => {
    const { fields, body } = parseEnvelope("---\nid: x\n---\nintro\n---\nmore\n");
    expect(fields.id).toBe("x");
    expect(body).toBe("intro\n---\nmore\n");
  });

  test("values keep their internal colons", () => {
    const { fields } = parseEnvelope("---\npane: sess:0.0\n---\n");
    expect(fields.pane).toBe("sess:0.0");
  });

  test("a source with no closing fence is a hard error, never a silent pass", () => {
    expect(() => parseEnvelope("---\nid: x\nbody\n")).toThrow();
  });
});

describe("envelope stamp (courier owns the five routing fields)", () => {
  const routing = {
    id: "s-20260823T100000Z-aabbccddeeff",
    from: "snd", to: "rcv", kind: "discuss", path: "/bus/payloads/x.md",
  };

  test("stamps the five fields just inside the closing fence", () => {
    const out = stampEnvelope("---\n---\nhello\n", routing);
    expect(out).toBe(
      `---\nid: ${routing.id}\nfrom: snd\nto: rcv\nkind: discuss\npath: ${routing.path}\n---\nhello\n`,
    );
  });

  test("drops a writer's copy of any courier-owned field rather than trusting it", () => {
    const out = stampEnvelope(
      "---\nid: forged\nfrom: forged\nto: forged\nkind: forged\npath: /forged\nre: keepme\n---\nbody\n",
      routing,
    );
    const { fields, body } = parseEnvelope(out);
    expect(fields.id).toBe(routing.id);
    expect(fields.from).toBe("snd");
    expect(fields.to).toBe("rcv");
    expect(fields.kind).toBe("discuss");
    expect(fields.path).toBe(routing.path);
    expect(fields.re).toBe("keepme");     // writer extras survive verbatim
    expect(body).toBe("body\n");
  });

  test("optional courier fields are emitted only when non-empty, in contract order", () => {
    const out = stampEnvelope("---\n---\nb\n", {
      ...routing, reply: "expected", recipient_instance: "rcv|dead", sender_instance: "snd|beef",
    });
    const lines = out.split("\n");
    expect(lines.slice(0, 9)).toEqual([
      "---",
      `id: ${routing.id}`,
      "from: snd",
      "to: rcv",
      "kind: discuss",
      `path: ${routing.path}`,
      "reply: expected",
      "recipient_instance: rcv|dead",
      "sender_instance: snd|beef",
    ]);
    expect(out).not.toContain("to_team:");
  });

  test("a source without an opening fence is refused (fail loud, never guess)", () => {
    expect(() => stampEnvelope("no fence here\n", routing)).toThrow();
  });
});

describe("envelope validate (SHAPE only — five fields, charset-locked)", () => {
  const ok = "---\nid: a-20260823T100000Z-ff\nfrom: s\nto: r\nkind: discuss\npath: /b/a.md\n---\n";

  test("accepts a well-formed envelope", () => {
    expect(validateEnvelope(ok)).toEqual({ ok: true });
  });

  test.each(["id", "from", "to", "kind", "path"])("rejects a missing %s", (f) => {
    const stripped = ok.split("\n").filter((l) => !l.startsWith(`${f}:`)).join("\n");
    expect(validateEnvelope(stripped).ok).toBe(false);
  });

  test("rejects a from/to/kind that breaks the sentinel grammar", () => {
    expect(validateEnvelope(ok.replace("to: r", "to: a b")).ok).toBe(false);
    expect(validateEnvelope(ok.replace("kind: discuss", "kind: a]b")).ok).toBe(false);
  });

  test("rejects a path carrying whitespace or a closing bracket", () => {
    expect(validateEnvelope(ok.replace("path: /b/a.md", "path: /b/a b.md")).ok).toBe(false);
    expect(validateEnvelope(ok.replace("path: /b/a.md", "path: /b/a]b.md")).ok).toBe(false);
  });

  test("an empty value is missing, not present", () => {
    expect(validateEnvelope(ok.replace("kind: discuss", "kind:")).ok).toBe(false);
  });
});

describe("atomic write", () => {
  test("writes through a temp file in the destination directory", () => {
    const dest = join(root, "r", "x.done");
    mkdirSync(join(root, "r"));
    atomicWrite(dest, "payload\n");
    expect(readFileSync(dest, "utf8")).toBe("payload\n");
  });

  test("overwrites in place and leaves no .tap.* temp behind", () => {
    const dir = join(root, "r"); mkdirSync(dir);
    const dest = join(dir, "x");
    atomicWrite(dest, "one"); atomicWrite(dest, "two");
    expect(readFileSync(dest, "utf8")).toBe("two");
    expect(Array.from(new Bun.Glob(".tap.*").scanSync(dir))).toHaveLength(0);
  });

  test("staging names round-trip their PID through smoke-all's tripwire pattern (tap-c7whh)", () => {
    // The pattern is read from the runner itself, so the two cannot drift apart.
    const runner = readFileSync(join(import.meta.dir, "../../../scripts/smoke-all.sh"), "utf8");
    const src = runner.match(/^STAGING_NAME = re\.compile\(r"(.+)"\)$/m)?.[1];
    expect(src).toBeDefined();
    const pattern = new RegExp(src!);
    for (const pid of [1, 35, 36, process.pid, 4194304, 99999]) {
      for (let i = 0; i < 200; i++) {
        const m = pattern.exec(basename(stagingPath("/d", pid)));
        expect(m).not.toBeNull();
        expect(parseInt(m![1]!, 36)).toBe(pid);
      }
    }
    expect(dirname(stagingPath("/d/e"))).toBe("/d/e");
  });
});

describe("receipt JSON (compact separators, exactly like the incumbent)", () => {
  test("emits {\"k\":\"v\"} with no spaces", () => {
    expect(jsonObj({ id: "x", status: "done" })).toBe('{"id":"x","status":"done"}');
  });

  test("escapes a value that would otherwise corrupt the receipt", () => {
    expect(jsonObj({ pane: 'a:"0.0' })).toBe('{"pane":"a:\\"0.0"}');
  });

  // Checked against the incumbent, not assumed: `tap_json_obj id x epoch "" status
  // done` prints `{"id":"x","epoch":"","status":"done"}`. An empty value is a key
  // the caller chose to pass; omission is expressed by not passing it at all.
  test("encodes an empty value rather than dropping it (incumbent parity)", () => {
    expect(jsonObj({ id: "x", epoch: "", status: "done" })).toBe('{"id":"x","epoch":"","status":"done"}');
  });

  test("omits a key whose value is undefined — that is how a caller says absent", () => {
    expect(jsonObj({ id: "x", epoch: undefined })).toBe('{"id":"x"}');
  });
});

describe("Bus layout + settlement authority (CONTRACT §Bus layout)", () => {
  const busOf = (r: string) => new Bus(join(r, "team", ".tap", "bus"));

  test("ensureDirs creates payloads/ + receipts/ and the authority marker", () => {
    const bus = busOf(root);
    bus.ensureDirs();
    expect(existsSync(bus.payloadsDir)).toBe(true);
    expect(existsSync(bus.receiptsDir)).toBe(true);
    expect(existsSync(join(bus.home, ".tap-bus-authority"))).toBe(true);
  });

  test("an unstampable bus root carries the named redelivery refusal", () => {
    const bus = busOf(root);
    mkdirSync(bus.payloadsDir, { recursive: true });
    mkdirSync(bus.receiptsDir, { recursive: true });
    writeFileSync(join(root, "team", ".tap", ".gitignore"), "bus/\n");
    chmodSync(bus.home, 0o555);
    let refusal: (Error & { tapErrorClass?: string; tapAction?: string }) | undefined;
    try {
      bus.ensureDirs();
    } catch (error) {
      refusal = error as Error & { tapErrorClass?: string; tapAction?: string };
    } finally {
      chmodSync(bus.home, 0o755);
    }

    expect(refusal?.tapErrorClass).toBe("bus_authority_unwritable");
    expect(refusal?.tapAction).toBe("fix TAP_HOME's own permissions, not just its children");
    expect(refusal?.message).toContain("will accept sends now and silently refuse to redeliver them later");
    expect(existsSync(join(bus.home, ".tap-bus-authority"))).toBe(false);
  });

  test("unprocessed = payload present with no .done", () => {
    const bus = busOf(root); bus.ensureDirs();
    writeFileSync(bus.payloadPath("i1"), "---\n---\n");
    expect(bus.isDone("i1")).toBe(false);
    atomicWrite(bus.donePath("i1"), "{}\n");
    expect(bus.isDone("i1")).toBe(true);
  });

  test("a .cancelled receipt also settles the obligation", () => {
    const bus = busOf(root); bus.ensureDirs();
    atomicWrite(join(bus.receiptsDir, "i2.cancelled"), "{}\n");
    expect(bus.isDone("i2")).toBe(true);
  });

  test("courier attribution accepts .placed or legacy .sent, and nothing else", () => {
    const bus = busOf(root); bus.ensureDirs();
    expect(bus.isCourierAttributed("i3")).toBe(false);
    atomicWrite(join(bus.receiptsDir, "i3.sent"), "{}\n");
    expect(bus.isCourierAttributed("i3")).toBe(true);
    atomicWrite(join(bus.receiptsDir, "i4.placed"), "{}\n");
    expect(bus.isCourierAttributed("i4")).toBe(true);
  });

  test("receipt authority requires a regular file while following symlinks", () => {
    const bus = busOf(root); bus.ensureDirs();
    const target = join(root, "receipt-dir");
    mkdirSync(target);
    for (const path of [bus.donePath("done"), bus.cancelPath("cancelled"), bus.placedPath("placed"), bus.sentPath("sent")]) {
      mkdirSync(path);
    }
    expect(bus.isDone("done")).toBe(false);
    expect(bus.isDone("cancelled")).toBe(false);
    expect(bus.isCourierAttributed("placed")).toBe(false);
    expect(bus.isCourierAttributed("sent")).toBe(false);
    for (const path of [bus.donePath("done"), bus.cancelPath("cancelled"), bus.placedPath("placed"), bus.sentPath("sent")]) {
      rmSync(path, { recursive: true });
      symlinkSync(target, path);
    }
    expect(bus.isDone("done")).toBe(false);
    expect(bus.isDone("cancelled")).toBe(false);
    expect(bus.isCourierAttributed("placed")).toBe(false);
    expect(bus.isCourierAttributed("sent")).toBe(false);
    for (const path of [bus.donePath("done"), bus.cancelPath("cancelled"), bus.placedPath("placed"), bus.sentPath("sent")]) {
      rmSync(path);
      writeFileSync(path, "receipt\n");
    }
    expect(bus.isDone("done")).toBe(true);
    expect(bus.isDone("cancelled")).toBe(true);
    expect(bus.isCourierAttributed("placed")).toBe(true);
    expect(bus.isCourierAttributed("sent")).toBe(true);
  });

  test("_*.md are drafts and are never listed as canonical payloads", () => {
    const bus = busOf(root); bus.ensureDirs();
    writeFileSync(bus.payloadPath("real"), "---\n---\n");
    writeFileSync(join(bus.payloadsDir, "_draft.md"), "---\n---\n");
    expect(bus.canonicalIds()).toEqual(["real"]);
  });
});
