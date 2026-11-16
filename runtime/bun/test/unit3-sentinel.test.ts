// Unit 3 — the sentinel and the courier's pure decisions.
//
// The verbs themselves are exercised end-to-end by the oracle against real tmux
// panes, which is the right instrument for them. These cover the parts where a
// wrong answer is silent rather than loud: sentinel GRAMMAR (a malformed one
// still "works" until a peer tries to parse it) and the placement rules that
// decide whether a failed send leaves debris on the bus.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Bus } from "../src/bus";
import { canonicalPlace } from "../src/courier";
import { parseEnvelope } from "../src/envelope";
import { SENTINEL_VERSION, parseSentinel, assertSentinelWire, renderSentinel as renderUnchecked } from "../src/sentinel";
import { removeScratchTree } from "./support/scratch";

// Run every existing constructor case through the delivery gate.
const renderSentinel: typeof renderUnchecked = fields => {
  const wire = renderUnchecked(fields);
  assertSentinelWire(wire);
  return wire;
};

let root: string;
let bus: Bus;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tap-bun-u3."));
  bus = new Bus(join(root, "team", ".tap", "bus"));
  bus.ensureDirs();
});
afterEach(() => removeScratchTree(root));

const base = {
  from: "snd", to: "rcv", id: "snd-20260823T100000Z-aabbccddeeff",
  kind: "discuss", reply: "expected", path: "/bus/payloads/x.md",
};

describe("sentinel grammar (the wire poke — zero authority)", () => {
  // THE VERSION IS PINNED AS A LITERAL, once, on purpose. Every other assertion in
  // this file interpolates SENTINEL_VERSION, which makes them self-referential: they
  // pass at 0.22 and at 0.23 and could not detect a wrong version if the constant
  // were bumped by accident. One arm has to state the number the release actually
  // ships, in a place the constant does not feed. Its bash counterpart is
  // contract-version-lockstep, which pins the same number against CONTRACT.
  test("the constant is the version this release ships", () => {
    expect(SENTINEL_VERSION).toBe("0.23");
  });

  test("renders the three positional slots, version first", () => {
    expect(renderSentinel(base)).toBe(`[[TAP v${SENTINEL_VERSION} ask ${base.id}]]`);
  });

  test("the obligation word is slot 2 and is never omitted", () => {
    expect(renderSentinel({ ...base, reply: "settle-only" })).toBe(
      `[[TAP v${SENTINEL_VERSION} note ${base.id}]]`,
    );
  });

  test("urgency is a bare tag, present only when true", () => {
    expect(renderSentinel({ ...base, urgency: "urgent" })).toBe(
      `[[TAP v${SENTINEL_VERSION} ask ${base.id} urgent]]`,
    );
    expect(renderSentinel(base)).not.toContain("urgent");
  });

  test("agent-interrupt rides only the urgent send that may interrupt (tap-1i81h)", () => {
    expect(renderSentinel({ ...base, urgency: "urgent", interrupt: true })).toBe(
      `[[TAP v${SENTINEL_VERSION} ask ${base.id} urgent agent-interrupt]]`,
    );
    // Spool redelivery keeps the envelope's urgency but never interrupts.
    expect(renderSentinel({ ...base, urgency: "urgent" })).not.toContain("agent-interrupt");
    expect(renderSentinel({ ...base, interrupt: true })).toBe(`[[TAP v${SENTINEL_VERSION} ask ${base.id}]]`);
  });

  test("a same-id retry carries the bare retry tag after any interrupt tag", () => {
    expect(renderSentinel({ ...base, retry: true })).toBe(`[[TAP v${SENTINEL_VERSION} ask ${base.id} retry]]`);
    expect(renderSentinel({ ...base, kind: "escalate", retry: true })).toBe(`[[TAP v${SENTINEL_VERSION} ask ${base.id} escalate retry]]`);
    expect(renderSentinel(base)).not.toContain("retry");
  });

  test("path= is dropped for an ordinary same-team send", () => {
    // The tap-0z9l retirement, ruled 2026-09-04: the full id in slot 3 is what
    // replaces the pointer. See CONTRACT §Sentinel.
    expect(renderSentinel(base)).not.toContain("path=");
  });

  test("a sentinel embedded in surrounding pane text is still found", () => {
    // parseSentinel is test/diagnostic-only and still splits `key=value` pairs, of
    // which v0.23 has at most one (`path=`). What it can still say is WHERE the
    // sentinel is, which is all this arm ever asked.
    const pane = `some transcript\n\n${renderSentinel(base)}\n\n> `;
    expect(pane).toContain(renderSentinel(base));
    expect(parseSentinel(pane)).not.toBeNull();
  });

  test("text with no sentinel parses to null rather than a half-filled object", () => {
    expect(parseSentinel("ordinary prose about [[TAP but not really")).toBeNull();
  });

  test("the id survives verbatim — it is what submit-verify greps for", () => {
    expect(renderSentinel(base)).toContain(base.id);
  });
});

describe("canonical placement (failed-send atomicity)", () => {
  const routing = { ...base, path: "" };

  const place = (src: string, over: Partial<typeof routing> = {}) => {
    const r = { ...routing, ...over };
    r.path = bus.payloadPath(r.id);
    canonicalPlace(bus, src, r);
    return r;
  };

  test("places the payload and its place-time attribution together", () => {
    const r = place("---\n---\nbody\n");
    expect(existsSync(bus.payloadPath(r.id))).toBe(true);
    // `.placed` is the authority for "this is courier mail", including on the
    // exit-5 path that never writes `.sent`.
    expect(existsSync(bus.placedPath(r.id))).toBe(true);
    expect(JSON.parse(readFileSync(bus.placedPath(r.id), "utf8"))).toMatchObject({ id: r.id, via: "courier" });
  });

  test("the stamped envelope names its own canonical file", () => {
    const r = place("---\n---\nbody\n");
    const { fields } = parseEnvelope(readFileSync(bus.payloadPath(r.id), "utf8"));
    expect(fields.path).toBe(bus.payloadPath(r.id));
    expect(fields.id).toBe(r.id);
  });

  test("the body is preserved verbatim, backticks and $( ) included", () => {
    const evil = "`touch /tmp/nope` and $(touch /tmp/nope2)\n";
    const r = place(`---\n---\n${evil}`);
    expect(parseEnvelope(readFileSync(bus.payloadPath(r.id), "utf8")).body).toBe(evil);
    expect(existsSync("/tmp/nope")).toBe(false);
  });

  test("a duplicate id is REFUSED rather than overwriting a live payload", () => {
    const r = place("---\n---\na\n");
    expect(() => place("---\n---\nb\n", { id: r.id })).toThrow(/duplicate id/);
    expect(parseEnvelope(readFileSync(bus.payloadPath(r.id), "utf8")).body).toBe("a\n");
  });

  test("an id whose obligation is already SETTLED is refused", () => {
    // Otherwise a replayed send would place a payload that nothing will ever
    // surface: poll skips it, because a .done already exists.
    const id = "snd-20260823T100000Z-ffffffffffff";
    writeFileSync(bus.donePath(id), "{}\n");
    expect(() => place("---\n---\nx\n", { id })).toThrow(/already settled/);
    expect(existsSync(bus.payloadPath(id))).toBe(false);
  });

  test("an id whose obligation was CANCELLED is refused", () => {
    const id = "snd-20260823T100000Z-cccccccccccc";
    writeFileSync(bus.cancelPath(id), "{}\n");
    expect(() => place("---\n---\nx\n", { id })).toThrow(/already settled/);
    expect(existsSync(bus.payloadPath(id))).toBe(false);
    expect(existsSync(bus.placedPath(id))).toBe(false);
  });

  test("occupied non-file receipt slots still refuse canonical ID reuse", () => {
    const directory = join(root, "receipt-directory"); mkdirSync(directory);
    let n = 0;
    for (const suffix of ["done", "cancelled"] as const) for (const shape of ["directory", "symlink-directory"] as const) {
      const id = `snd-20260823T100000Z-slot${++n}`;
      const path = suffix === "done" ? bus.donePath(id) : bus.cancelPath(id);
      if (shape === "directory") mkdirSync(path); else symlinkSync(directory, path);
      expect(() => place("---\n---\nx\n", { id })).toThrow(/canonical_place: refusing duplicate id .*receipt already settled/);
      expect(existsSync(bus.payloadPath(id))).toBe(false);
      expect(existsSync(bus.placedPath(id))).toBe(false);
    }
  });

  test("a malformed source leaves NO canonical and NO staging debris", () => {
    // The atomicity rule: a caller must never see a refusal while an untracked
    // payload from that send remains on the bus.
    const id = "snd-20260823T100000Z-eeeeeeeeeeee";
    expect(() => place("no fence at all\n", { id })).toThrow();
    expect(existsSync(bus.payloadPath(id))).toBe(false);
    expect(Array.from(new Bun.Glob(".tap.*").scanSync(bus.stagingDir))).toHaveLength(0);
  });

  test("a source whose stamp would fail validation leaves nothing behind", () => {
    const id = "snd-20260823T100000Z-dddddddddddd";
    // A path token carrying whitespace cannot pass envelope validation.
    expect(() => canonicalPlace(bus, "---\n---\nx\n", { ...routing, id, path: "/bad path.md" }))
      .toThrow(/invalid after stamp/);
    expect(existsSync(bus.payloadPath(id))).toBe(false);
    expect(Array.from(new Bun.Glob(".tap.*").scanSync(bus.stagingDir))).toHaveLength(0);
  });
});

test("cross-team rendering needs affirmative index evidence to omit its pointer", () => {
  const fields = { ...base, from: "alpha/snd", to: "beta/rcv" };
  expect(renderSentinel(fields)).toContain(`path=${base.path}`);
  expect(renderSentinel({ ...fields, senderIndex: "reachable" })).not.toContain("path=");
  expect(() => renderSentinel({ ...fields, senderIndex: "refuse" })).toThrow("refusing to render");
  expect(renderSentinel({ ...base, senderIndex: "refuse" })).not.toContain("path=");
});
