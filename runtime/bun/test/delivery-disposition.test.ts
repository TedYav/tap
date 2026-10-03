import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { codexQueuedRows, deliveryBand, deliveryDisposition, type DeliveryFacts } from "../src/slices/delivery-disposition";
import { claudeQueuedRows } from "../src/pane-state";
const facts: DeliveryFacts = { band: "bare", urgent: false, noSpool: false, recipientBound: true };
test("empty input delivers immediately and creates no cue", () => {
  expect(deliveryDisposition(facts)).toEqual({ action: "inject", parkReason: null, graceSeconds: null,
    cue: { initialStyle: null, redAtSecondsBeforeDeadline: null } });
});
test("draft has one thirty-second deadline with a warning ten seconds before it", () => {
  expect(deliveryDisposition({ ...facts, band: "draft" })).toMatchObject({ action: "park", parkReason: "pending-input",
    graceSeconds: 30, cue: { initialStyle: "green", redAtSecondsBeforeDeadline: 10 } });
  expect(deliveryDisposition({ ...facts, band: "draft", urgent: true })).toMatchObject({ action: "park",
    graceSeconds: 10, cue: { initialStyle: "red", redAtSecondsBeforeDeadline: 10 } });
});
test("queued input has neither deadline clobber nor flash", () => {
  expect(deliveryDisposition({ ...facts, band: "queued" })).toMatchObject({ action: "park", parkReason: "queued-input",
    graceSeconds: null, cue: { initialStyle: null, redAtSecondsBeforeDeadline: null } });
});
test("unbound and no-spool retain direct delivery", () => {
  expect(deliveryDisposition({ ...facts, noSpool: true, band: "draft" }).action).toBe("inject");
  expect(deliveryDisposition({ ...facts, recipientBound: false, band: "draft" }).action).toBe("inject");
});
test("a staged TAP command takes the existing recovery path without human warnings", () => {
  expect(deliveryDisposition({ ...facts, band: "staged" }).graceSeconds).toBe(0);
  expect(deliveryDisposition({ ...facts, band: "staged" }).cue.initialStyle).toBeNull();
});
test("queue chrome alone is insufficient; queued list survives turn-state changes", () => {
  expect(codexQueuedRows("› \n tab to queue message")).toEqual([]);
  expect(codexQueuedRows("↳ old\n› old prompt\n shift + ← edit last queued message\ntranscript\n› ")).toEqual([]);
  expect(codexQueuedRows("› human draft\n shift + ← edit last queued message")).toEqual([]);
  expect(codexQueuedRows("↳ first\n↳ second\n› \n shift + ← edit last queued message")).toEqual(["first", "second"]);
});

test("Claude queued rows share the active box's exact geometry", () => {
  const load = (name: string) => readFileSync(new URL(`../../../skills/tap/scripts/smoke/fixtures/submit-verify/${name}.ansi`, import.meta.url), "utf8");
  const expected = '[[TAP v0.23 note lime-conductor-20260918T085028Z-f75f1bd3af66 preview="Correction to my custody update: Astra independently verified all four SuiteSplit4 compute jobs are terminal/pass; they"]]';
  expect(claudeQueuedRows(load("claude-queued-live-draft-claudebar"))).toEqual([expected]);
});

test("Claude queued parser joins continuations and refuses transcript prompts or box-less frames", () => {
  const rule = "─".repeat(24);
  const box = (above: string[]) => [...above, rule, "❯ draft", rule].join("\n");
  expect(claudeQueuedRows(box(["  ❯ first part", "    continued tail"]))).toEqual(["first part\ncontinued tail"]);
  expect(claudeQueuedRows(box(["  ❯ first", "  ❯ second"]))).toEqual(["first", "second"]);
  expect(claudeQueuedRows(box(["❯ first"]))).toEqual([]);
  expect(claudeQueuedRows(box(["spinner line", "  ❯ first"]))).toEqual(["first"]);
  expect(claudeQueuedRows(box(["  ❯ first", "spinner line"]))).toEqual([]);
  expect(claudeQueuedRows("no active box at all")).toEqual([]);
});

test("Hermes retains its safe queue-prefix path when no composer is visible", () => {
  expect(deliveryDisposition({ ...facts, harness: "hermes-profile", band: "unobservable" }).action).toBe("inject");
  expect(deliveryDisposition({ ...facts, harness: "hermes-profile", band: "draft" }).graceSeconds).toBe(30);
});

test("interrupt bypasses unknown bands without an arrival cue", () => {
  for (const band of ["bare", "queued", "unobservable"] as const) {
    expect(deliveryDisposition({ ...facts, band, urgent: true })).toMatchObject({ action: "inject", cue: { initialStyle: null } });
  }
});

test("staged urgent or malformed TAP residue never becomes a human draft", () => {
  for (const composer of ["[[TAP v0.23 note x urgent]]", "[[TAP v0.23 note courier-x digest]]", "[[TAP unfinished"]) {
    const band = deliveryBand(composer, "codex", "");
    expect(band).toBe("staged");
    expect(deliveryDisposition({ ...facts, band }).cue.initialStyle).toBeNull();
  }
  expect(deliveryBand("human draft containing [[TAP", "codex", "")).toBe("draft");
});
