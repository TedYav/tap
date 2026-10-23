import { LauncherError } from "./types";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Objects merge recursively; arrays and scalars in later layers replace earlier values. */
function merge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    // Define an own property even for JSON keys such as __proto__.
    Object.defineProperty(result, key, { value: object(result[key]) && object(value) ? merge(result[key], value) : value,
      enumerable: true, configurable: true, writable: true });
  }
  return result;
}

/** Preserve inline config while applying launcher defaults beneath operator intent. */
export function mergeEnvJson(key: string, defaults: Record<string, unknown>, layers: (string | undefined)[]): string {
  let value = defaults;
  for (const layer of layers) {
    if (layer === undefined || layer === "") continue;
    let parsed: unknown;
    try { parsed = JSON.parse(layer); } catch { /* key-only refusal below */ }
    if (!object(parsed)) throw new LauncherError(`${key} must be a JSON object`, "launch_env_json_invalid",
      `set ${key} to a valid JSON object or remove it`);
    value = merge(value, parsed);
  }
  return JSON.stringify(value);
}

/** Only publish the closed tabs-mode domain; arbitrary config content stays private. */
export function openCodeTabsMode(content: string | undefined): string | undefined {
  if (content === undefined) return undefined;
  try {
    const mode = JSON.parse(content)?.tabs?.mode;
    return ["auto", "on", "off"].includes(mode) ? mode : "native";
  } catch { return "native"; }
}
