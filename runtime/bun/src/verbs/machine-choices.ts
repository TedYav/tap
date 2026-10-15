import { collectDifferences, editTomlKey } from "./config";
import { TapError } from "../context";
import { HARNESSES } from "../launcher/catalog";
import { PERMISSION_HARNESSES } from "../launcher/permissions";
import { notificationConfig, validateNotificationSettings } from "../notifications";
import { catalogFromDocument } from "../launcher/catalog-listing";
import { loadModelReference, matchingVariant, modelReference, presetTuning } from "../launcher/model-reference";

export const EFFORTS = ["low", "medium", "high", "xhigh"];
/** `default` pins no effort: the harness chooses, as it does for a bare launch. */
export const DEFAULT_EFFORT = "default";
export const STARTER_EFFORTS = [DEFAULT_EFFORT, ...EFFORTS];
const PRESET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Starter annotations that describe the model at the catalog's pinned effort, not at another one. */
const EFFORT_BOUND_METADATA = ["intelligence", "cost_level", "speed"];
export const PLUGINS: Record<string, {market: string; source: string}> = {
  ponytail: {market: "ponytail", source: "DietrichGebert/ponytail"},
  "compound-engineering": {market: "compound-engineering-plugin", source: "EveryInc/compound-engineering-plugin"},
  superpowers: {market: "superpowers-marketplace", source: "obra/superpowers-marketplace"},
};
type HarnessChoice = {presets?: "skip" | "simple" | string[]; permissions?: "auto" | "bypass"};
export type SetupChoices = {
  harnesses?: Record<string, HarnessChoice>;
  starterEffort?: string;
  write?: "apply" | "candidate";
  replaceCandidate?: boolean;
  shellIntegration?: boolean;
  fullKit?: boolean;
  plugins?: Record<string, string[]>;
  notifications?: {notifier?: "system" | "command"; command?: string[]};
  onboarding?: {init?: "ask" | "auto"};
  injection?: {behavior?: "clobber" | "wait"};
};
/** The config spelling written for the `wait` choice. The courier accepts
 * `wait` directly and keeps `warn` as a legacy alias for the same semantics. */
export const WAIT_CONFIG_VALUE = "wait";
export type SetupSnapshot = {config: string; existed: boolean; source: string; previous: Record<string, any>};
export type SetupCatalog = {presets: Record<string, any>};
export const choiceError = (field: string, detail: string): never => { throw new TapError(field === "config" ? 2 : 1,"setup_refused","tap help setup",`${field}: ${detail}`); };
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
function keys(value: unknown, allowed: string[], field: string): asserts value is Record<string, any> {
  if (!object(value)) return choiceError(field, "expected an object");
  for (const key of Object.keys(value)) if (!allowed.includes(key)) choiceError(`${field}.${key}`, "unknown field");
}
function strings(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== "string")) choiceError(field, "expected an array of names");
}

/** One input contract for both explicit terminal answers and a JSON patch. */
export function parseSetupChoices(value: unknown): SetupChoices {
  keys(value, ["harnesses", "starterEffort", "write", "replaceCandidate", "shellIntegration", "fullKit", "plugins", "notifications", "onboarding", "injection"], "answers");
  if (value.harnesses !== undefined) {
    keys(value.harnesses, HARNESSES, "harnesses");
    for (const [h, entry] of Object.entries(value.harnesses)) {
      const field = `harnesses.${h}`;
      keys(entry, ["presets", "permissions"], field);
      if (entry.presets !== undefined && entry.presets !== "skip" && entry.presets !== "simple") strings(entry.presets, `${field}.presets`);
      if (entry.permissions !== undefined) {
        if (!PERMISSION_HARNESSES.includes(h)) choiceError(`${field}.permissions`, "TAP supports auto/bypass only for Claude, Codex, Cursor and AGY");
        if (!["auto", "bypass"].includes(entry.permissions)) choiceError(`${field}.permissions`, "expected auto or bypass");
      }
    }
  }
  if (value.starterEffort !== undefined && !STARTER_EFFORTS.includes(value.starterEffort)) choiceError("starterEffort", `expected ${STARTER_EFFORTS.join(", ")}`);
  if (value.write !== undefined && !["apply", "candidate"].includes(value.write)) choiceError("write", "expected apply or candidate");
  for (const field of ["replaceCandidate", "shellIntegration", "fullKit"]) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") choiceError(field, "expected a boolean");
  }
  if (value.plugins !== undefined) {
    keys(value.plugins, ["claude", "codex"], "plugins");
    for (const [h, names] of Object.entries(value.plugins)) {
      strings(names, `plugins.${h}`);
      for (const name of names) if (!Object.hasOwn(PLUGINS, name)) choiceError(`plugins.${h}`, `unknown plugin '${name}'`);
    }
  }
  if (value.notifications !== undefined) {
    keys(value.notifications, ["notifier", "command"], "notifications");
    if (value.notifications.notifier !== undefined && !["system", "command"].includes(value.notifications.notifier)) choiceError("notifications.notifier", "expected system or command");
    if (value.notifications.command !== undefined) strings(value.notifications.command, "notifications.command");
  }
  if (value.onboarding !== undefined) {
    keys(value.onboarding, ["init"], "onboarding");
    if (value.onboarding.init !== undefined && !["ask", "auto"].includes(value.onboarding.init)) choiceError("onboarding.init", "expected ask or auto");
  }
  if (value.injection !== undefined) {
    keys(value.injection, ["behavior"], "injection");
    if (value.injection.behavior !== undefined && !["clobber", "wait"].includes(value.injection.behavior)) choiceError("injection.behavior", "expected clobber or wait");
  }
  return value as SetupChoices;
}

export function applyEffort(preset: any, effort: string, source?: SetupCatalog): any {
  const result = structuredClone(preset);
  if (effort === DEFAULT_EFFORT) return unpinEffort(result);
  if (result.harness === "claude") result.params.effort = effort;
  if (result.harness === "codex") {
    const values = Array.isArray(result.params.config) ? result.params.config : [result.params.config].filter(Boolean);
    result.params.config = [...values.filter((v: string) => !/^\s*model_reasoning_effort\s*=/.test(v)), `model_reasoning_effort=${effort}`];
  }
  if (["claude", "codex"].includes(result.harness)) result.description = `${result.params.model} at ${effort}`;
  if ((source || result.metadata) && ["claude", "codex"].includes(result.harness)) {
    const parsed = catalogFromDocument(source ?? {}, { tuned: result }, "setup catalog", "", () => {});
    const tuned = parsed.presets.get("tuned");
    const reference = source ? modelReference(catalogFromDocument(source, source.presets, "setup catalog", "", () => {})) : loadModelReference();
    const policy = parsed.harnessPolicy[result.harness] as {env?: Record<string,string>} | undefined;
    const match = tuned && matchingVariant(reference, result.harness, presetTuning(tuned, policy?.env));
    if (match?.metadata) {
      result.metadata = Object.fromEntries(Object.entries(match.metadata).filter(([,value]) => value !== null));
      result.metadata.starter = preset.metadata?.starter === true;
    } else if (result.metadata) {
      // Keep the annotation as history, but it must not rank the changed tuning.
      result.metadata = { starter: preset.metadata.starter === true,
        summary: `Unadjusted starter prior for different tuning: ${preset.metadata.summary || preset.description || "no summary"}`,
        unadjusted_starter_prior: true };
    }
  }
  return result;
}

/**
 * A starter with no effort pinned. Roles and the written summary stay as a
 * labelled prior; the fields that rated the catalog's pinned effort do not, so
 * nothing ranks tuning the catalog never described.
 */
function unpinEffort(result: any): any {
  if (!["claude", "codex"].includes(result.harness)) return result;
  const pinned = result.description;
  if (result.harness === "claude") delete result.params.effort;
  else {
    const values = (Array.isArray(result.params.config) ? result.params.config : [result.params.config].filter(Boolean))
      .filter((v: string) => !/^\s*model_reasoning_effort\s*=/.test(v));
    if (values.length) result.params.config = values; else delete result.params.config;
  }
  result.description = `${result.params.model} at the harness default effort`;
  if (result.metadata) {
    for (const field of EFFORT_BOUND_METADATA) delete result.metadata[field];
    result.metadata.starter = result.metadata.starter === true;
    result.metadata.summary = `Starter prior written for ${pinned}; this preset pins no effort: ${result.metadata.summary || "no summary"}`;
    result.metadata.unadjusted_starter_prior = true;
  }
  return result;
}

export function selectSetupPresets(choices: SetupChoices, previous: Record<string, any>, catalog: SetupCatalog) {
  const chosen: Record<string, any> = {};
  const tuned: string[] = [];
  // Every validated selection, already saved or new: the names a shell alias may launch.
  const selected: string[] = [];
  for (const h of Object.keys(choices.harnesses ?? {}).sort()) {
    const selection = choices.harnesses![h]!.presets;
    if (selection === undefined || selection === "skip") continue;
    const names = selection === "simple"
      ? Object.keys(catalog.presets).filter(n => catalog.presets[n].harness === h && catalog.presets[n].metadata?.starter === true)
      : selection;
    for (const name of [...new Set(names)].sort()) {
      const saved = Object.hasOwn(previous.presets ?? {}, name) ? previous.presets[name] : undefined;
      // A preset named explicitly may be one the person saved themselves (every OpenCode preset is):
      // it is selected for aliases and never rewritten. Its name reaches a shell file, so it is checked.
      if (saved !== undefined && selection === "simple") {
        // A starter name the person already uses stays theirs: aliased only when it is this harness's preset.
        if (saved?.harness === h) selected.push(name);
        continue;
      }
      if (saved !== undefined) {
        if (saved?.harness !== h) choiceError(`harnesses.${h}.presets`, `saved preset '${name}' is not a ${h} preset`);
        // tap launch reads a harness name as the bare harness, so an alias for it would never reach the preset.
        if (HARNESSES.includes(name)) choiceError(`harnesses.${h}.presets`, `saved preset '${name}' has a harness name, which launches the bare harness; rename the preset first`);
        if (!PRESET_NAME.test(name)) choiceError(`harnesses.${h}.presets`, `saved preset '${name}' has a name setup cannot alias; use letters, digits, dot, underscore or hyphen`);
      } else if (!Object.hasOwn(catalog.presets, name) || catalog.presets[name].harness !== h) {
        choiceError(`harnesses.${h}.presets`, `unknown preset '${name}' for ${h}: neither saved in this config nor in the shipped catalog`);
      }
      selected.push(name);
      if (saved !== undefined) continue;
      chosen[name] = structuredClone(catalog.presets[name]);
      // A starter named explicitly takes a supplied effort too; any other named variant keeps catalog tuning.
      const namedStarter = choices.starterEffort !== undefined && catalog.presets[name].metadata?.starter === true;
      if ((selection === "simple" || namedStarter) && ["claude", "codex"].includes(h)) tuned.push(name);
    }
  }
  return {chosen, tuned, selected};
}

/** Boolean params that spelled a harness's bypass before the launcher owned it. */
const LEGACY_BYPASS_PARAMS: Record<string, string[]> = {cursor: ["yolo", "force"], agy: ["dangerously-skip-permissions"]};

/** Prepare bytes only. Every refusal precedes config, shell, and plugin effects. */
export function prepareSetup(snapshot: SetupSnapshot, input: unknown, catalog: SetupCatalog) {
  const choices = parseSetupChoices(input);
  const {previous, source, existed} = snapshot;
  const {chosen, tuned, selected} = selectSetupPresets(choices, previous, catalog);
  if (tuned.length && choices.starterEffort === undefined) choiceError("starterEffort", "required when adding simple Claude/Codex starters");
  for (const name of tuned) chosen[name] = applyEffort(chosen[name], choices.starterEffort!, catalog);
  const permissions: Record<string, string> = {};
  for (const h of Object.keys(choices.harnesses ?? {}).sort()) {
    if (!PERMISSION_HARNESSES.includes(h)) continue;
    const mode = choices.harnesses![h]!.permissions ?? previous.harness?.[h]?.permissions;
    // Cursor and AGY joined the policy later: an answers file that omits them keeps a saved choice
    // (the fallback above) and otherwise writes no key, so the launcher's unsaved default (auto) applies.
    if (mode === undefined && !["claude", "codex"].includes(h)) continue;
    if (!["auto", "bypass"].includes(mode)) choiceError(`harnesses.${h}.permissions`, "required: auto or bypass (no saved valid choice)");
    permissions[h] = mode;
  }
  if (choices.shellIntegration && choices.write === "candidate") choiceError("shellIntegration", "candidate config is inactive; apply it before adding shell integration");
  let edited = source;
  const expected = structuredClone(previous);
  const changes: {path:string[]; before:unknown; after:unknown}[] = [];
  const set = (path: string[], value: unknown) => {
    let parent = expected;
    for (const key of path.slice(0, -1)) {
      if (parent[key] === undefined) parent[key] = {};
      if (!object(parent[key])) choiceError(path.join("."), "existing config parent is not a table");
      parent = parent[key];
    }
    const key = path.at(-1)!;
    if (JSON.stringify(parent[key]) === JSON.stringify(value)) return;
    changes.push({path,before:parent[key],after:value});
    parent[key] = value;
    edited = editTomlKey(edited, path, JSON.stringify(value));
  };
  const add = (value: Record<string, any>, path: string[]) => {
    for (const [key, v] of Object.entries(value)) {
      if (object(v)) add(v, [...path, key]);
      else set([...path, key], v);
    }
  };
  for (const name of Object.keys(chosen).sort()) add(chosen[name], ["presets", name]);
  for (const [h, mode] of Object.entries(permissions)) {
    set(["harness", h, "permissions"], mode);
    // Before tap-6c1me, Cursor/AGY bypass was spelled as a param; under auto it would refuse every launch.
    const params = previous.harness?.[h]?.params;
    if (mode === "auto" && object(params)) for (const key of LEGACY_BYPASS_PARAMS[h] ?? []) {
      if (params[key] === true) set(["harness", h, "params", key], false);
    }
  }
  if (!existed && choices.harnesses?.codex) set(["harness", "codex", "env", "PONYTAIL_DEFAULT_MODE"], "off");
  if (choices.fullKit !== undefined) set(["skills", "full_kit"], choices.fullKit);
  if (choices.onboarding?.init !== undefined) set(["onboarding", "init"], choices.onboarding.init);
  if (choices.injection?.behavior !== undefined) set(["injection", "behavior"], choices.injection.behavior === "wait" ? WAIT_CONFIG_VALUE : "clobber");
  if (choices.notifications && Object.keys(choices.notifications).length) {
    if (previous.notifications !== undefined && !object(previous.notifications)) choiceError("notifications", "existing config is not a table");
    const merged = {...previous.notifications, ...choices.notifications};
    validateNotificationSettings(notificationConfig(merged));
    if (choices.notifications.notifier !== undefined) set(["notifications", "notifier"], choices.notifications.notifier);
    if (choices.notifications.command !== undefined) set(["notifications", "command"], choices.notifications.command);
  }
  try {
    const differences: string[] = [];
    collectDifferences(expected, Bun.TOML.parse(edited), [], differences);
    if (differences.length) throw new Error(differences.join(", "));
  } catch { choiceError("config", "cannot safely edit this TOML shape in place; nothing written"); }
  const changed = edited !== source;
  if (changed && choices.write === undefined) choiceError("write", "required when config bytes change: apply or candidate");
  return {choices, chosen, selected, permissions, edited, changed, changes};
}
