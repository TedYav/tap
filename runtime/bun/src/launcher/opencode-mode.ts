import type { SessionRecord } from "./types";
import { join } from "node:path";
import { configDirectory, readCatalog, table } from "../config-file";
import { LauncherError } from "../config-error";
export function openCodeServerMode(record: SessionRecord, env: NodeJS.ProcessEnv = process.env): "private" | "shared" {
  if (record.opencode_server_mode === "private" || record.opencode_server_mode === "shared") return record.opencode_server_mode;
  if (record.opencode_server_mode !== undefined) throw new LauncherError("invalid stored OpenCode server mode", "opencode_mode_invalid", "inspect the stored launch recipe");
  const path = join(configDirectory(env), "config.toml");
  let config: Record<string, unknown> = {};
  try { config = readCatalog(path).data; }
  catch (error) { if (!(error instanceof LauncherError && error.errorClass === "preset_config_missing")) throw error; }
  const experimental = config.experimental;
  const invalid = (detail: string): never => { throw new LauncherError(detail, "preset_config_invalid", `fix ${path}`, detail); };
  if (experimental !== undefined && !table(experimental)) invalid("experimental must be a table");
  const value = table(experimental) ? experimental.opencode_shared_server : undefined;
  if (value !== undefined && typeof value !== "boolean") invalid("experimental.opencode_shared_server must be a boolean");
  return record.opencode_server_mode = value === true ? "shared" : "private";
}
