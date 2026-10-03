import { LauncherError } from "../config-error";
import { configDirectory } from "../config-file";
import { TapError } from "../context";
import { injectionBehaviorFault } from "../injection-behavior";
import { join } from "node:path";

/**
 * The injection.behavior fault for a diagnostic report, or null when the setting is usable.
 *
 * Only a wrong setting is a fault. A config.toml that cannot be resolved, opened, read or
 * parsed is not, so it refuses here as a structured TapError (exit 1, `preset_config_invalid`,
 * the class every other reader of this file uses) instead of an untagged throw that
 * `--json` cannot render. Delivery keeps calling the raw functions.
 */
export function injectionFaultOrRefuse(env: NodeJS.ProcessEnv = process.env): string | null {
  try { return injectionBehaviorFault(env); }
  catch (error) {
    if (error instanceof TapError) throw error;
    if (error instanceof LauncherError) {
      throw new TapError(1, error.errorClass ?? "preset_config_invalid", error.action ?? "fix config.toml", error.detail ?? error.message);
    }
    let path = "config.toml";
    try { path = join(configDirectory(env), "config.toml"); } catch { /* the path itself is the fault; the message names it */ }
    const cause = error instanceof Error ? error.message : String(error);
    throw new TapError(1, "preset_config_invalid", `fix ${path}`, cause.includes(path) ? `invalid preset config: ${cause}` : `invalid preset config ${path}: ${cause}`);
  }
}
