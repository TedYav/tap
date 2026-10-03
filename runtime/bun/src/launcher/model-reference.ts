import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePresetCatalog, type Catalog, type ResolvedPreset } from "./catalog-listing";
import { metadataToJson } from "./catalog-metadata";
import { paramsToArgv } from "./argv-splice";
import { launchTuning, resolveCliTuning, type LaunchTuning } from "./tuning";
import { assignments } from "./config-args";
import { shellQuote } from "../shell-quote";
import { tapRoot } from "../scripts-dir";

export type ModelVariant = {
  harness: string; model: string; tuning: LaunchTuning; recipes: string[];
  family: string | null; metadata: Record<string, unknown> | null;
  description: string | null; ambiguous: boolean; ambiguousFields: string[]; extra: Record<string, unknown>;
  command: string; launchArgs: string[];
};
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export function presetTuning(preset: ResolvedPreset, policyEnv: Record<string, string> = {}): LaunchTuning {
  return launchTuning(preset.harness, paramsToArgv(preset.params), { ...policyEnv, ...preset.env });
}

/** A projection of the existing parsed catalog. Recipes never become access evidence. */
export function modelReference(catalog: Catalog): ModelVariant[] {
  const variants = new Map<string, ModelVariant>();
  for (const preset of catalog.presets.values()) {
    if (!preset.model) continue;
    const policy = catalog.harnessPolicy[preset.harness] as { env?: Record<string, string> } | undefined;
    const tuning = presetTuning(preset, policy?.env);
    const extra = Object.fromEntries(Object.entries(preset.params).filter(([key]) => !["model", "effort", "reasoning", "config", "provider"].includes(key)));
    const otherConfig = assignments(preset.harness_passthrough).filter(({key}) => !["model_reasoning_effort","service_tier","model_context_window","model_max_output_tokens"].includes(key));
    if (otherConfig.length) extra.other_config = otherConfig.flatMap(({start,end}) => preset.harness_passthrough.slice(start,end));
    for (const [key, value] of Object.entries(preset.env)) tuning.environment[key] = value;
    const key = stable({ harness: preset.harness, tuning, extra });
    const metadata = preset.metadata ? metadataToJson(preset.metadata) : null;
    if (metadata) delete metadata.starter;
    const previous = variants.get(key);
    if (previous) {
      previous.recipes.push(preset.provenance.name);
      if (previous.description !== preset.description) { previous.description = null; previous.ambiguousFields.push("description"); }
      if (previous.family !== preset.family) { previous.family = null; previous.ambiguousFields.push("family"); }
      const common = { ...previous.metadata };
      for (const field of new Set([...Object.keys(common), ...Object.keys(metadata ?? {})])) {
        if (previous.ambiguousFields.includes(field) || stable(common[field]) !== stable(metadata?.[field])) {
          delete common[field]; previous.ambiguousFields.push(field);
        }
      }
      previous.metadata = common;
      previous.ambiguousFields = [...new Set(previous.ambiguousFields)];
      previous.ambiguous = previous.ambiguousFields.length > 0;
      continue;
    }
    const args = ["tap", "launch", preset.harness, "--model", preset.model];
    for (const [name, value] of Object.entries(tuning.environment)) args.push("--env", `${name}=${value}`);
    // Top-level effort and a native tail deliberately conflict at the accepting
    // door. Keep qualified examples legal without inventing another composer.
    if (Object.keys(tuning.qualifiers).length || Object.keys(extra).length) args.push("--", ...preset.harness_passthrough);
    else if (tuning.effort) {
      resolveCliTuning(preset.harness, null, tuning.effort, {});
      args.push("--effort", tuning.effort);
    }
    variants.set(key, { harness: preset.harness, model: preset.model, tuning, extra,
      recipes: [preset.provenance.name], family: preset.family, metadata,
      description: preset.description, ambiguous: false, ambiguousFields: [], launchArgs: args.slice(2),
      command: args.map(value => /^[\w@%+=:,./-]+$/.test(value) ? value : shellQuote(value)).join(" ") });
  }
  return [...variants.values()].sort((a,b) => stable([a.harness,a.model,a.tuning]).localeCompare(stable([b.harness,b.model,b.tuning])));
}

export function loadModelReference(notice: (line: string) => void = () => {}): ModelVariant[] {
  const path = resolve(tapRoot(), "skills/tap/config/config.v3.toml");
  return modelReference(parsePresetCatalog(readFileSync(path), path, "checked-in-reference", notice));
}

export function matchingVariant(variants: ModelVariant[], harness: string, tuning: LaunchTuning): ModelVariant | undefined {
  const matches = variants.filter(v => v.harness === harness && !Object.keys(v.extra).length &&
    stable(v.tuning) === stable(tuning));
  return matches.length === 1 ? matches[0] : undefined;
}

export function variantQualification(v: ModelVariant): string {
  return [v.tuning.effort ? `effort=${v.tuning.effort}` : "effort=default (unknown)",
    ...Object.entries(v.tuning.qualifiers).map(([k,x]) => `${k}=${x}`),
    ...Object.entries(v.tuning.environment).map(([k,x]) => `env.${k}=${x}`),
    ...Object.entries(v.extra).map(([k,x]) => `${k}=${JSON.stringify(x)}`)].join(", ");
}
