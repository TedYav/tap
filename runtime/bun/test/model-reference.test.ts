import { expect, test } from "bun:test";
import { parsePresetCatalog } from "../src/launcher/catalog-listing";
import { loadModelReference, matchingVariant, modelReference } from "../src/launcher/model-reference";
import { launchTuning } from "../src/launcher/tuning";
import { applyEffort } from "../src/verbs/machine-choices";

test("checked-in models retain effort, service and wrapper variants and provider-qualified IDs", () => {
  const refs = loadModelReference();
  const fable = refs.filter(v => v.model === "fable");
  expect(fable.find(v => v.tuning.effort === "medium")?.metadata?.intelligence).toBe("frontier");
  expect(fable.find(v => v.tuning.effort === "high")?.metadata?.intelligence).toBe("s-tier");
  const astra = refs.filter(v => v.model === "gpt-6-astra" && v.tuning.effort === "medium");
  expect(astra.map(v => v.tuning.qualifiers.service_tier).sort()).toEqual(["default", "fast"]);
  const xhigh = refs.filter(v => v.model === "gpt-6-astra" && v.tuning.effort === "xhigh");
  expect(xhigh.map(v => v.tuning.environment.PONYTAIL_DEFAULT_MODE).sort()).toEqual(["full", "off"]);
  expect(refs.some(v => v.model === "synthetic/hf:moonshotai/Kimi-K3")).toBe(true);
  for (const v of refs) expect(v.command).toContain("--model");
  expect(refs.find(v => v.recipes.includes("grok"))?.command).not.toContain("--effort");
});

test("same tuning with conflicting priors cannot rank or union roles; malformed metadata degrades", () => {
  const notices: string[] = [];
  const parsed = parsePresetCatalog(Buffer.from(`version=3
[roles]
leader="Leads"
reviewer="Reviews"
[intelligences]
frontier="Strong"
advanced="Good"
[presets.a]
harness="claude"
params.model="m"
params.effort="high"
metadata.intelligence="frontier"
metadata.primary_roles=["leader"]
[presets.b]
harness="claude"
params.model="m"
params.effort="high"
metadata.intelligence="advanced"
metadata.primary_roles=["reviewer"]
[presets.bad]
harness="opencode"
params.model="provider/model"
metadata.speed=7
`), "reference", "", x => notices.push(x));
  const variants = modelReference(parsed), conflict = variants.find(v => v.model === "m")!;
  expect(conflict.recipes).toEqual(["a", "b"]);
  expect(conflict.ambiguous).toBe(true);
  expect(conflict.metadata?.intelligence).toBeUndefined();
  expect(conflict.metadata?.primary_roles).toBeUndefined();
  expect(matchingVariant(variants, "claude", conflict.tuning)?.metadata?.intelligence).toBeUndefined();
  expect(notices.some(n => n.includes("metadata.speed"))).toBe(true);
});

test("snapshot takes winning tuning only, excludes arbitrary config and secrets, and leaves defaults unknown", () => {
  expect(launchTuning("codex", ["--model", "m", "-c", 'model_reasoning_effort="medium"', "--model=tail", "--config=service_tier=fast", "-c", "model_reasoning_effort=high", "-c", 'api_key="secret"'], { PONYTAIL_DEFAULT_MODE: "off", SECRET: "secret" })).toEqual({
    model: "tail", effort: "high", qualifiers: { service_tier: "fast" }, environment: { PONYTAIL_DEFAULT_MODE: "off" },
  });
  expect(launchTuning("opencode", ["--model", "provider/model"])).toEqual({ model: "provider/model", effort: null, qualifiers: {}, environment: {} });
  expect(launchTuning("claude", [])).toEqual({ model: null, effort: null, qualifiers: {}, environment: {} });
});

test("setup effort takes exact qualified metadata or labels an unadjusted prior without ranking evidence", () => {
  const source = { presets: {
    base: { harness: "claude", params: { model: "m", effort: "medium" }, metadata: { starter:true, intelligence:"frontier", summary:"medium prior" } },
    high: { harness: "claude", params: { model: "m", effort: "high" }, metadata: { intelligence:"s-tier", summary:"high prior" } },
  } };
  expect(applyEffort(source.presets.base, "high", source).metadata).toMatchObject({intelligence:"s-tier",summary:"high prior",starter:true});
  const unknown = applyEffort(source.presets.base, "low", source);
  expect(unknown.metadata.summary).toContain("Unadjusted starter prior");
  expect(unknown.metadata.intelligence).toBeUndefined();
  expect(source.presets.base.params.effort).toBe("medium");
});
