/**
 * The persisted OpenCode model-window map: per project directory, `providerID/modelID -> limit.context`, one small JSON
 * file under the machine index home. `tap team` only READS it and never runs `opencode`; an explicit
 * `tap team --refresh-models` and a fresh OpenCode launch are the only writers. Both fetch with `--pure`, so no user
 * plugin executes.
 *
 * OpenCode resolves project and user config overrides per directory, so the same model can carry different limits in
 * two projects. Entries are therefore keyed by directory first: refreshing one project never overwrites another's
 * denominator. A launch captures from the launch directory; the roster looks up the seat's session directory.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Model = { id: string; providerID: string; limit?: { context?: number } };
export type Models = Map<string, Model>;
export type DirectoryWindows = { fetched_at: number; windows: Record<string, number> };
export type WindowMap = { version: string | null; directories: Record<string, DirectoryWindows> };

/** A directory's entry older than this is rebuilt in full by the next launch capture (seven days, in seconds). */
export const WINDOW_MAP_TTL_S = 7 * 24 * 3600;
const FILE = "opencode-model-windows.json";
const FETCH_TIMEOUT_MS = 15_000;
/** Total time `captureModelWindow` may spend after a seat is already running; its calls share this one budget. */
export const LAUNCH_CAPTURE_BUDGET_MS = 5_000;

const positive = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

export function windowMapPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.TAP_INDEX_HOME || join(homedir(), ".tap"), FILE);
}

/** The map on disk, or null when it is absent or not the expected shape. Never throws. */
export function readWindowMap(env: NodeJS.ProcessEnv = process.env): WindowMap | null {
  try {
    const doc = JSON.parse(readFileSync(windowMapPath(env), "utf8")) as Partial<WindowMap>;
    const raw = doc?.directories;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const directories: Record<string, DirectoryWindows> = {};
    for (const [directory, entry] of Object.entries(raw)) {
      if (!entry || typeof entry !== "object" || !entry.windows || typeof entry.windows !== "object" || Array.isArray(entry.windows)) continue;
      const windows: Record<string, number> = {};
      for (const [key, value] of Object.entries(entry.windows)) if (positive(value)) windows[key] = value;
      directories[directory] = { fetched_at: typeof entry.fetched_at === "number" && Number.isFinite(entry.fetched_at) ? entry.fetched_at : 0, windows };
    }
    return { version: typeof doc.version === "string" ? doc.version : null, directories };
  } catch { return null; }
}

/** The context window recorded for `provider/model` in this project directory, if any. */
export function windowFor(map: WindowMap | null, directory: string, model: string): number | undefined {
  return map?.directories[directory]?.windows[model];
}

function writeWindowMap(map: WindowMap, env: NodeJS.ProcessEnv): void {
  const path = windowMapPath(env);
  mkdirSync(dirname(path), { recursive: true });
  const scratch = `${path}.${process.pid}.tmp`;
  writeFileSync(scratch, `${JSON.stringify(map)}\n`);
  renameSync(scratch, path);
}

/** `models --verbose` emits one heading followed by a pretty-printed JSON object. */
export function parseOpenCodeModels(text: string): Models {
  const result: Models = new Map();
  for (const match of text.matchAll(/^([^\n]+)\n(\{\n[\s\S]*?^\})\s*(?=\n|$)/gm)) {
    try {
      const model = JSON.parse(match[2]!) as Model;
      if (typeof model.id === "string" && typeof model.providerID === "string" &&
          match[1] === `${model.providerID}/${model.id}`) result.set(match[1], model);
    } catch { /* malformed metadata leaves the denominator unknown */ }
  }
  return result;
}

function windowsOf(models: Models): Record<string, number> {
  const windows: Record<string, number> = {};
  for (const [key, model] of models) if (positive(model.limit?.context)) windows[key] = model.limit.context;
  return windows;
}

/** One `opencode` call, never longer than the fetch timeout or what remains before `deadline` (epoch ms). */
function opencode(args: string[], directory: string, env: NodeJS.ProcessEnv, deadline?: number): string | null {
  const timeout = deadline === undefined ? FETCH_TIMEOUT_MS : Math.min(FETCH_TIMEOUT_MS, deadline - Date.now());
  if (timeout <= 0) return null;
  const result = spawnSync("opencode", args, {
    cwd: directory, env, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0 ? result.stdout : null;
}

export function opencodeVersion(directory: string, env: NodeJS.ProcessEnv = process.env, deadline?: number): string | null {
  return opencode(["--version"], directory, env, deadline)?.trim() || null;
}

/** A directory's entry is stale when OpenCode's version changed since the map was written, or it is missing or past the TTL. */
export function windowMapStale(map: WindowMap | null, directory: string, version: string | null, now: number): boolean {
  const entry = map?.directories[directory];
  return !map || !entry || map.version !== version || now - entry.fetched_at > WINDOW_MAP_TTL_S;
}

export type RefreshResult = { directories: number; failed: string[]; models: number; written: boolean };

/**
 * `tap team --refresh-models`: one `opencode models --verbose --pure` per distinct directory, each replacing that
 * directory's entry. Other directories' entries stay, unless the OpenCode version changed, which drops them as stale.
 * When every fetch fails the old map stays.
 */
export function refreshWindowMap(directories: readonly string[], env: NodeJS.ProcessEnv = process.env, now = Math.floor(Date.now() / 1000), limits: { version?: string | null; deadline?: number } = {}): RefreshResult {
  const distinct = [...new Set(directories)];
  const failed: string[] = [];
  const fetched: Record<string, DirectoryWindows> = {};
  for (const directory of distinct) {
    const text = opencode(["models", "--verbose", "--pure"], directory, env, limits.deadline);
    if (text === null) { failed.push(directory); continue; }
    fetched[directory] = { fetched_at: now, windows: windowsOf(parseOpenCodeModels(text)) };
  }
  const refreshed = Object.keys(fetched);
  if (refreshed.length === 0) return { directories: distinct.length, failed, models: 0, written: false };
  const version = limits.version !== undefined ? limits.version : opencodeVersion(refreshed[0]!, env, limits.deadline);
  const existing = readWindowMap(env);
  const base = existing && existing.version === version ? existing.directories : {};
  writeWindowMap({ version, directories: { ...base, ...fetched } }, env);
  const models = new Set(refreshed.flatMap((d) => Object.keys(fetched[d]!.windows)));
  return { directories: distinct.length, failed, models: models.size, written: true };
}

export type CaptureResult = "updated" | "refreshed" | "unchanged" | "failed";

/**
 * Launch-time capture for an OpenCode seat started with `--model provider/model`: bring that model's window for this
 * directory into the map. A stale entry (version change, TTL, or first sight of the directory) is rebuilt from the
 * directory's full catalog; otherwise only the model's provider is listed. Best effort: a missing CLI or an unknown
 * model returns "failed" and changes nothing. The seat is already running, so every call shares one `budgetMs`
 * (the version is read once and handed to the refresh); a slow CLI costs the launch at most that long.
 */
export function captureModelWindow(model: string, directory: string, env: NodeJS.ProcessEnv = process.env, now = Math.floor(Date.now() / 1000), budgetMs = LAUNCH_CAPTURE_BUDGET_MS): CaptureResult {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return "failed";
  const deadline = Date.now() + budgetMs;
  const version = opencodeVersion(directory, env, deadline);
  if (version === null) return "failed";
  const existing = readWindowMap(env);
  if (windowMapStale(existing, directory, version, now)) {
    return refreshWindowMap([directory], env, now, { version, deadline }).written && windowFor(readWindowMap(env), directory, model) !== undefined ? "refreshed" : "failed";
  }
  const text = opencode(["models", model.slice(0, slash), "--verbose", "--pure"], directory, env, deadline);
  if (text === null) return "failed";
  const window = windowsOf(parseOpenCodeModels(text))[model];
  if (window === undefined) return "failed";
  const entry = existing!.directories[directory]!;
  if (entry.windows[model] === window) return "unchanged";
  writeWindowMap({ ...existing!, directories: { ...existing!.directories, [directory]: { ...entry, windows: { ...entry.windows, [model]: window } } } }, env);
  return "updated";
}
