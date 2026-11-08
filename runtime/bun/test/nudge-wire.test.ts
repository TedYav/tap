// tap-xe42x: the senderless nudge doorbell's grammar and its message bound.
import { expect, test } from "bun:test";
import { nudgeDoorbellText, NUDGE_CUSTOM_MAX_BYTES, NUDGE_MESSAGE_MAX_BYTES, nudgeMessageRefusal, parseNudgeWire, renderNudgeWire } from "../src/nudge-wire";
import { parseStuckSentinel } from "../src/stuck-sentinel";

test("bare and message forms render and parse back to the same context", () => {
  expect(renderNudgeWire()).toBe("[[TAP v0.23 nudge]]");
  expect(parseNudgeWire("[[TAP v0.23 nudge]]")).toEqual({ message: "" });
  for (const message of ['say "done" first', "C:\\path\\", "trailing backslash \\", "tab-free, ünïcödé ✓ 𝄞"]) {
    const wire = renderNudgeWire(message);
    expect(parseNudgeWire(wire)).toEqual({ message });
  }
  expect(renderNudgeWire('a "b" c')).toBe('[[TAP v0.23 nudge message="a \\"b\\" c"]]');
});

test("a wrapped wire still parses; malformed or truncated wires do not", () => {
  expect(parseNudgeWire('[[TAP v0.23 nudge message="check\n poll"]]')).toEqual({ message: "check poll" });
  for (const bad of ["[[TAP v0.23 nudge", '[[TAP v0.23 nudge message="x]]', "[[TAP v0.23 nudge message=x]]",
    "[[TAP v0.23 nudge]] tail", "[[TAP v0.22 nudge]]", "[[TAP v0.23 nudge id-1]]",
    "[[TAP v0.23 nudge]] [[TAP v0.23 nudge]]"]) expect(parseNudgeWire(bad)).toBeNull();
});

test("refusals: newline, control characters, sentinel brackets, picker triggers", () => {
  expect(nudgeMessageRefusal("two\nlines")).toContain("one line");
  expect(nudgeMessageRefusal("bell\x07")).toContain("one line");
  expect(nudgeMessageRefusal("see ]] here")).toContain("sentinel brackets");
  expect(nudgeMessageRefusal("nested [[TAP v0.23 note x]] wire")).toContain("sentinel brackets");
  expect(nudgeMessageRefusal("opener [[ alone")).toContain("sentinel brackets");
  expect(nudgeMessageRefusal("ask @reviewer")).toContain("@ or /");
  expect(nudgeMessageRefusal("/compact please")).toContain("@ or /");
  expect(nudgeMessageRefusal("an email a@b.c and and/or stay fine")).toBeNull();
  expect(() => renderNudgeWire("bad ]] context")).toThrow("sentinel brackets");
});

test("the bound is UTF-8 bytes of the decoded context, not JSON-escaped length", () => {
  expect(nudgeMessageRefusal("a".repeat(NUDGE_MESSAGE_MAX_BYTES))).toBeNull();
  expect(nudgeMessageRefusal("a".repeat(NUDGE_MESSAGE_MAX_BYTES + 1))).toContain(`${NUDGE_MESSAGE_MAX_BYTES + 1} bytes`);
  // é is 2 bytes; 100 of them sit exactly on the bound, 101 cross it.
  expect(nudgeMessageRefusal("é".repeat(100))).toBeNull();
  expect(nudgeMessageRefusal("é".repeat(101))).toContain("202 bytes");
  // An astral character is 4 bytes (2 UTF-16 units).
  expect(nudgeMessageRefusal("𝄞".repeat(50))).toBeNull();
  expect(nudgeMessageRefusal("𝄞".repeat(50) + "a")).toContain("201 bytes");
  // Quotes double under JSON escaping; the bound is on the context itself.
  expect(nudgeMessageRefusal('"'.repeat(NUDGE_MESSAGE_MAX_BYTES))).toBeNull();
});

test("the payload parser refuses a nudge: it names no payload id", () => {
  const verdict = parseStuckSentinel("[[TAP v0.23 nudge]]", "codex");
  expect(verdict.ok).toBe(false);
  expect(JSON.stringify(verdict)).toContain("names no payload id");
});


test("producer composition preserves human stops and bounds custom context after disclosure", () => {
  expect(nudgeDoorbellText()).toContain("unless the user or a message says stop");
  expect(parseNudgeWire(renderNudgeWire(nudgeDoorbellText()))!.message).toBe(nudgeDoorbellText());
  const wrapped = renderNudgeWire(nudgeDoorbellText()).match(/.{1,80}/g)!.join("\n");
  expect(parseNudgeWire(wrapped)?.message).toBe(nudgeDoorbellText());
  const caller = "Your harness was just relaunched for an account switch. Continue what you were working on.";
  expect(nudgeDoorbellText(caller)).toContain(caller);
  expect(nudgeDoorbellText(caller)).toContain("unless the user or this message says stop");
  expect(Buffer.byteLength(nudgeDoorbellText("x".repeat(NUDGE_CUSTOM_MAX_BYTES)))).toBe(200);
  expect(()=>nudgeDoorbellText("x".repeat(NUDGE_CUSTOM_MAX_BYTES+1))).toThrow("available after TAP");
});
