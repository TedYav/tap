import { expect, test } from "bun:test";
import { modelCell, prettyModelName } from "../src/model-names";
import { columnWidths } from "../src/verbs/team";

test("known models read as name+version", () => {
  const table: [string, string][] = [
    ["claude-opus-5-5", "opus5.5"], ["claude-fable-5-1", "fable5.1"], ["claude-sonnet-5-5", "sonnet5.5"], ["claude-haiku-5-5", "haiku5.5"],
    ["claude-opus-4-6", "opus4.6"], ["claude-opus-4-6[1m]", "opus4.6"], ["claude-haiku-4-5-20251001", "haiku4.5"], ["claude-sonnet-4-20250514", "sonnet4"],
    ["gpt-6-astra", "astra6"], ["gpt-6-luna", "luna6"], ["gpt-6.1-sol", "sol6.1"], ["GPT-6.1-Sol", "sol6.1"],
    ["gemini-4-argon-high", "argon4"], ["gemini-3.8-flash-high", "flash3.8"], ["gemini-3.8-flash-low", "flash3.8"],
    ["glm-5.3", "glm5.3"], ["zai-coding-plan/glm-5.3", "glm5.3"], ["tokenrouter/z-ai/glm-5.2", "glm5.2"], ["zai-coding-plan/glm-5.3-flash", "glm5.3-flash"],
    ["grok-4.7-high", "grok4.7"], ["deepseek/deepseek-v4.1-flash", "deepseek4.1-flash"], ["deepseek/deepseek-v4-flash-0731", "deepseek4-flash"],
    ["synthetic/hf:moonshotai/Kimi-K3", "kimi3"],
    ["synthetic/hf:moonshotai/Kimi-K3.1-Pro", "kimi3.1pro"],
    ["gemini-4-carbon", "carbon4"],
  ];
  for (const [raw, pretty] of table) expect([raw, prettyModelName(raw)]).toEqual([raw, pretty]);
});

test("a launch alias strips [1m] and invents no version", () => {
  expect(prettyModelName("opus[1m]")).toBe("opus");
  expect(prettyModelName("opus")).toBe("opus");
  expect(prettyModelName("fable")).toBe("fable");
  expect(prettyModelName("sonnet[1M]")).toBe("sonnet");
  expect(prettyModelName("haiku")).toBe("haiku");
});

test("anything unmapped displays the full raw string", () => {
  for (const raw of ["claude-opus", "gpt-5", "gpt-5-codex", "mystery-model", "acme/mystery[1m]", "claude-3-5-sonnet-20241022", ""]) {
    expect(prettyModelName(raw)).toBe(raw);
  }
});

test("the model cell keeps the established shapes without provenance markers", () => {
  expect(modelCell({ observedModel: "claude-opus-5-5", observedEffort: "xhigh" }, false)).toBe("opus5.5@xhigh");
  expect(modelCell({ observedModel: "claude-fable-5-1", observedEffort: "low", launchModel: "fable" }, false)).toBe("fable5.1@low");
  expect(modelCell({ observedModel: "gpt-6-astra" }, false)).toBe("astra6");
  expect(modelCell({ launchModel: "opus[1m]", launchEffort: "xhigh" }, false)).toBe("opus@xhigh");
  expect(modelCell({ launchModel: "opus[1m]" }, false)).toBe("opus@?");
  expect(modelCell({ launchEffort: "high" }, false)).toBe("?@high");
  expect(modelCell({ launchModel: "mystery" }, false)).toBe("mystery@?");
  expect(modelCell({}, false)).toBe("?");
});

test("an effort the short name drops from the id stays visible", () => {
  expect(modelCell({ launchModel: "gemini-4-argon-high" }, false)).toBe("argon4@high");
  expect(modelCell({ launchModel: "grok-4.7-low", launchEffort: "max" }, false)).toBe("grok4.7@max");
});

test("color is on the effort word alone, and gated by the caller", () => {
  const paint: [string, number][] = [["low", 27], ["medium", 39], ["high", 40], ["xhigh", 208], ["max", 196]];
  for (const [effort, code] of paint) {
    expect(modelCell({ observedModel: "claude-opus-5-5", observedEffort: effort }, true)).toBe(`opus5.5@\x1b[38;5;${code}m${effort}\x1b[0m`);
    expect(modelCell({ observedModel: "claude-opus-5-5", observedEffort: effort }, false)).toBe(`opus5.5@${effort}`);
  }
  expect(modelCell({ launchModel: "opus[1m]", launchEffort: "max" }, true)).toBe("opus@\x1b[38;5;196mmax\x1b[0m");
});

test("an unknown effort stays uncolored", () => {
  for (const effort of ["minimal", "ultra", "High", "?"]) {
    expect(modelCell({ observedModel: "gpt-6-astra", observedEffort: effort }, true)).toBe(`astra6@${effort}`);
  }
  expect(modelCell({ launchModel: "opus" }, true)).toBe("opus@?");
});

test("column widths ignore the color escapes", () => {
  const plain = modelCell({ observedModel: "claude-opus-5-5", observedEffort: "xhigh" }, false);
  const colored = modelCell({ observedModel: "claude-opus-5-5", observedEffort: "xhigh" }, true);
  expect(columnWidths(["model"], [[colored]])).toEqual(columnWidths(["model"], [[plain]]));
});

test("Carbon effort suffixes stay in the effort column", () => {
  for (const effort of ["low", "medium", "high"]) {
    const model = `gemini-4-carbon-${effort}`;
    expect(prettyModelName(model)).toBe("carbon4");
    expect(modelCell({ observedModel: model }, false)).toBe(`carbon4@${effort}`);
    expect(modelCell({ observedModel: model, observedEffort: "max" }, false)).toBe("carbon4@max");
    expect(modelCell({ launchModel: model }, false)).toBe(`carbon4@${effort}`);
    expect(modelCell({ launchModel: model, launchEffort: effort }, false)).toBe(`carbon4@${effort}`);
  }
  expect(modelCell({ launchModel: "gemini-4-carbon-high", launchEffort: "low" }, false)).toBe("carbon4@low");
  expect(modelCell({ launchModel: "synthetic/hf:moonshotai/Kimi-K3.1-Pro" }, false)).toBe("kimi3.1pro@?");
});
