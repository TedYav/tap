import { expect, test } from "bun:test";
import { controlPayloadChunks, controlTailReady } from "../src/slices/control-payload";

test("chunks preserve UTF-8 and whitespace across the byte boundary", () => {
  const text = "x".repeat(249) + "🦄é\t \n　".repeat(90) + " [[sv:end]]";
  const chunks = controlPayloadChunks(text);
  expect(chunks.join("")).toBe(text);
  expect(chunks.every(chunk => Buffer.byteLength(chunk) <= 250)).toBe(true);
  expect(chunks[0]).toBe("x".repeat(249));
});

test("visible ordered tail tolerates wrapping and Python whitespace", () => {
  const text = "evidence α🦄".repeat(30) + " [[sv:end]]";
  expect(controlTailReady("claude", "/compact " + text.replaceAll(" ", "\n\u0085\u001c"), text).ready).toBe(true);
  expect(controlTailReady("claude", text.slice(0, -1), text).ready).toBe(false);
  expect(controlTailReady("claude", text + " wrong", text).ready).toBe(false);
  expect(controlTailReady("claude", "", " \t").ready).toBe(false);
  // FEFF is JavaScript whitespace but not Python str.split() whitespace.
  expect(controlTailReady("claude", text + "\ufeff", text).ready).toBe(false);
});

test("a chip never counts as control tail evidence, even beside a visible marker", () => {
  const expected = "retain evidence [[sv:end]]";
  for (const chip of ["[Pasted text]", "[Pasted text #2 +3 lines]"]) {
    const result = controlTailReady("claude", `/compact ${chip} ${expected}`, expected);
    expect(result.ready).toBe(false);
    expect(result.expectedBytes).toBe(Buffer.byteLength(expected));
  }
});
