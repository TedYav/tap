import { closeSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { configDirectory, debugConfigFromTable, hasUtf8Bom, readSecureBytes, refuse, type DebugConfig } from "./config-file";
import { acquireNoFollowLock } from "./digest-window";
import { collectDifferences, editTomlKey } from "./verbs/config";
import { atomicWrite } from "./fsatomic";

/** One config-lock transaction; unrelated TOML and comments survive the edit. */
export function writeDebugConfig(changes: Partial<DebugConfig>, env = process.env): DebugConfig {
  const named = join(configDirectory(env), "config.toml");
  try {
    const path = lstatSync(named, { throwIfNoEntry: false })?.isSymbolicLink() ? realpathSync(named) : named;
    mkdirSync(dirname(path), { recursive: true });
    const lock = acquireNoFollowLock(path + ".lock", 2500);
    try {
      let source = "";
      try {
        const bytes = readSecureBytes(path).bytes;
        if (hasUtf8Bom(bytes)) throw new Error("a leading UTF-8 BOM is not valid TOML");
        source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const doc = Bun.TOML.parse(source) as Record<string, unknown>;
      let imported: Record<string, unknown> = {};
      // Only the first TOML block imports the old storage caps. The old file
      // remains as evidence, but cannot override an existing [debug] table.
      if (doc.debug === undefined) {
        const legacy = join(env.TAP_INDEX_HOME || join(env.HOME || homedir(), ".tap"), "debug/config.json");
        try {
          const old = JSON.parse(readFileSync(legacy, "utf8"));
          imported = { max_mb: old.max_mb, retain_mb: old.retain_mb };
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      const current = debugConfigFromTable(doc.debug ?? imported, path);
      const config = debugConfigFromTable({ ...current, ...changes }, path);
      let edited = source;
      for (const [key, value] of Object.entries(config)) {
        if (doc.debug !== undefined && !Object.hasOwn(changes, key)) continue;
        if (JSON.stringify((doc.debug as Record<string, unknown> | undefined)?.[key]) === JSON.stringify(value)) continue;
        edited = editTomlKey(edited, ["debug", key], JSON.stringify(value));
      }
      const candidate = Bun.TOML.parse(edited) as Record<string, unknown>, differences: string[] = [];
      debugConfigFromTable(candidate.debug, path);
      collectDifferences(doc, candidate, [], differences);
      if (differences.some(key => key !== "debug" && !key.startsWith("debug."))) throw new Error("edit would change unrelated settings");
      if (edited !== source) atomicWrite(path, edited, (statSync(path, { throwIfNoEntry: false })?.mode ?? 0o600) & 0o777);
      return config;
    } finally { closeSync(lock); }
  } catch (error) {
    refuse("debug_config_invalid", `cannot update debug settings: ${error instanceof Error ? error.message : String(error)}`, `fix ${named}`);
  }
}

/** config.toml cannot be read or parsed, so off cannot confirm always_on is off. */
export class AlwaysOnUnconfirmed extends Error {}

/**
 * tap debug off's path when writeDebugConfig refuses the [debug] block (an
 * invalid sibling such as max_mb = 0): set debug.always_on = false with one
 * key edit under the same config lock, leaving every other key as written, so
 * fixing that key later cannot re-arm. Returns whether always_on was true.
 * A config.toml it cannot read or parse is never reported clear: no text
 * heuristic can rule a key out (TOML spells keys quoted, dotted or escaped),
 * so it throws AlwaysOnUnconfirmed instead.
 */
export function clearAlwaysOn(env = process.env): boolean {
  let named: string;
  // No resolvable config directory: nothing reads always_on, so nothing can arm.
  try { named = join(configDirectory(env), "config.toml"); } catch { return false; }
  const path = lstatSync(named, { throwIfNoEntry: false })?.isSymbolicLink() ? realpathSync(named) : named;
  if (!lstatSync(path, { throwIfNoEntry: false })) return false;
  const unconfirmed = (problem: string) =>
    new AlwaysOnUnconfirmed(`config.toml ${problem}, so always_on could not be confirmed off; fix ${path} and run tap debug off again`);
  const lock = acquireNoFollowLock(path + ".lock", 2500);
  try {
    let bytes: Buffer;
    try { bytes = readSecureBytes(path).bytes; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw unconfirmed(`cannot be read (${error instanceof Error ? error.message : String(error)})`);
    }
    let source: string, doc: Record<string, unknown>;
    try {
      if (hasUtf8Bom(bytes)) throw new Error("a leading UTF-8 BOM is not valid TOML");
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      doc = Bun.TOML.parse(source) as Record<string, unknown>;
    } catch { throw unconfirmed("does not parse"); }
    if ((doc.debug as Record<string, unknown> | undefined)?.always_on !== true) return false;
    const edited = editTomlKey(source, ["debug", "always_on"], "false");
    const differences: string[] = [];
    collectDifferences(doc, Bun.TOML.parse(edited), [], differences);
    if (differences.length !== 1 || differences[0] !== "debug.always_on") throw new Error("the always_on edit would change other settings");
    atomicWrite(path, edited, statSync(path).mode & 0o777);
    return true;
  } finally { closeSync(lock); }
}
