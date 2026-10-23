/** Model windows published by running OpenCode 2 plugins. Readers never start a harness. */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type DirectoryWindows = { fetched_at: number; windows: Record<string, number> };
export type WindowMap = { version: string | null; directories: Record<string, DirectoryWindows> };
const MAX_AGE_S = 7 * 24 * 3600;
const positive = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

/** Each project has its own atomic file, so seats in different projects cannot overwrite each other. */
export function readWindowMap(env: NodeJS.ProcessEnv = process.env, now = Math.floor(Date.now() / 1000)): WindowMap | null {
  const root = join(env.TAP_INDEX_HOME || join(homedir(), ".tap"), "opencode-model-windows.d");
  let files: string[];
  try { files = readdirSync(root); } catch { return null; }
  const directories: Record<string, DirectoryWindows> = {};
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const row = JSON.parse(readFileSync(join(root, file), "utf8"));
      if (typeof row.directory !== "string" || !isAbsolute(row.directory) ||
          typeof row.version !== "string" || !/^2\./.test(row.version) ||
          !positive(row.fetched_at) || row.fetched_at > now + 5 || now - row.fetched_at > MAX_AGE_S ||
          !row.windows || typeof row.windows !== "object" || Array.isArray(row.windows)) continue;
      const windows: Record<string, number> = {};
      for (const [model, value] of Object.entries(row.windows)) if (positive(value)) windows[model] = value;
      if ((directories[row.directory]?.fetched_at ?? 0) <= row.fetched_at)
        directories[row.directory] = { fetched_at: row.fetched_at, windows };
    } catch { /* a corrupt or concurrently removed sidecar contributes no denominator */ }
  }
  return { version: "2", directories };
}

export function windowFor(map: WindowMap | null, directory: string, model: string): number | undefined {
  return map?.directories[directory]?.windows[model];
}
