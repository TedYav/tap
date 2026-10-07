import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureModelWindow, readWindowMap, refreshWindowMap, windowFor, windowMapPath, windowMapStale, WINDOW_MAP_TTL_S } from "../src/opencode-model-windows";
import { removeScratchTree } from "./support/scratch";

/**
 * The persisted window map, against a fake `opencode` on a private PATH. Every case runs under its own TAP_INDEX_HOME
 * so the operator's real map and OpenCode state are untouched. The fake logs each invocation as `cwd|args` and answers
 * `--version` and `models` from per-directory fixtures, so a directory can carry its own limit for the same model.
 */
const root = mkdtempSync(join(tmpdir(), "opencode-windows-"));
afterAll(() => removeScratchTree(root));

let n = 0, env: NodeJS.ProcessEnv = {}, log = "", versionFile = "";
const dirA = join(root, "project-a"), dirB = join(root, "project-b"), dirFail = join(root, "project-fail");
const NOW = 1_800_000_000;

const catalog = (provider: string, id: string, context: number) =>
  `${provider}/${id}\n${JSON.stringify({ id, providerID: provider, limit: { context } }, null, 2)}\n`;

beforeEach(() => {
  const home = join(root, `case-${n++}`), bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  log = join(home, "opencode.log"); versionFile = join(home, "version");
  writeFileSync(versionFile, "1.2.3");
  for (const [dir, ctx] of [[dirA, 200_000], [dirB, 900_000]] as const) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "models.txt"), catalog("zai", "glm", ctx) + catalog("other", "kimi", 131_072));
  }
  mkdirSync(dirFail, { recursive: true });
  writeFileSync(join(bin, "opencode"), `#!/bin/sh
printf '%s|%s\\n' "$(pwd -P)" "$*" >> '${log}'
[ -n "$OPENCODE_SLOW" ] && exec sleep 3
[ "$*" = "--version" ] && { cat '${versionFile}'; exit 0; }
[ -f models.txt ] || exit 1
case "$*" in
  "models --verbose --pure") cat models.txt ;;
  "models zai --verbose --pure") awk '/^[^ {}]/{p=(index($0,"zai/")==1)} p' models.txt ;;
  *) exit 1 ;;
esac
`);
  chmodSync(join(bin, "opencode"), 0o755);
  env = { PATH: `${bin}:${process.env.PATH}`, TAP_INDEX_HOME: join(home, "index") };
});

const calls = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
const real = (dir: string) => Bun.spawnSync(["/bin/sh", "-c", `cd '${dir}' && pwd -P`]).stdout.toString().trim();

test("refresh fetches once per distinct directory and keeps each project's window apart", () => {
  const result = refreshWindowMap([dirA, dirB, dirA], env, NOW);
  expect(result).toMatchObject({ directories: 2, failed: [], written: true });
  expect(calls().filter(line => line.endsWith("|models --verbose --pure"))).toEqual([
    `${real(dirA)}|models --verbose --pure`, `${real(dirB)}|models --verbose --pure`]);
  const map = readWindowMap(env);
  expect(map?.version).toBe("1.2.3");
  expect(windowFor(map, dirA, "zai/glm")).toBe(200_000);
  expect(windowFor(map, dirB, "zai/glm")).toBe(900_000);
  expect(windowFor(map, dirA, "other/kimi")).toBe(131_072);
  expect(windowFor(map, join(root, "elsewhere"), "zai/glm")).toBeUndefined();
});

test("refreshing one project leaves another project's entry and a failed fetch keeps the old map", () => {
  refreshWindowMap([dirA, dirB], env, NOW);
  writeFileSync(join(dirA, "models.txt"), catalog("zai", "glm", 300_000));
  refreshWindowMap([dirA], env, NOW + 10);
  let map = readWindowMap(env);
  expect(windowFor(map, dirA, "zai/glm")).toBe(300_000);
  expect(windowFor(map, dirB, "zai/glm")).toBe(900_000);

  const before = readFileSync(windowMapPath(env), "utf8");
  const failed = refreshWindowMap([dirFail], env, NOW + 20);
  expect(failed).toMatchObject({ written: false, failed: [dirFail] });
  expect(readFileSync(windowMapPath(env), "utf8")).toBe(before);

  const partial = refreshWindowMap([dirB, dirFail], env, NOW + 30);
  expect(partial).toMatchObject({ written: true, failed: [dirFail] });
  map = readWindowMap(env);
  expect(map?.directories[dirB]?.fetched_at).toBe(NOW + 30);
  expect(windowFor(map, dirA, "zai/glm")).toBe(300_000);
});

test("an absent or corrupt map reads as null and invalid windows are dropped", () => {
  expect(readWindowMap(env)).toBeNull();
  mkdirSync(env.TAP_INDEX_HOME!, { recursive: true });
  writeFileSync(windowMapPath(env), "{not json");
  expect(readWindowMap(env)).toBeNull();
  writeFileSync(windowMapPath(env), JSON.stringify({ version: "1", directories: { [dirA]: { fetched_at: 1, windows: { "zai/glm": 0, "zai/ok": 5, "zai/bad": "x" } } } }));
  expect(readWindowMap(env)?.directories[dirA]?.windows).toEqual({ "zai/ok": 5 });
});

test("a version change drops entries written by the older OpenCode", () => {
  refreshWindowMap([dirA, dirB], env, NOW);
  writeFileSync(versionFile, "2.0.0");
  refreshWindowMap([dirA], env, NOW + 1);
  const map = readWindowMap(env);
  expect(map?.version).toBe("2.0.0");
  expect(Object.keys(map!.directories)).toEqual([dirA]);
});

test("staleness: first sight of a directory, a version change, or an entry past the TTL", () => {
  refreshWindowMap([dirA], env, NOW);
  const map = readWindowMap(env);
  expect(windowMapStale(map, dirA, "1.2.3", NOW + 60)).toBe(false);
  expect(windowMapStale(map, dirA, "1.2.4", NOW + 60)).toBe(true);
  expect(windowMapStale(map, dirB, "1.2.3", NOW + 60)).toBe(true);
  expect(windowMapStale(map, dirA, "1.2.3", NOW + WINDOW_MAP_TTL_S + 1)).toBe(true);
  expect(windowMapStale(null, dirA, "1.2.3", NOW)).toBe(true);
});

test("launch capture: first sight refreshes the directory, then updates only the launched model", () => {
  expect(captureModelWindow("zai/glm", dirA, env, NOW)).toBe("refreshed");
  expect(windowFor(readWindowMap(env), dirA, "zai/glm")).toBe(200_000);

  expect(captureModelWindow("zai/glm", dirA, env, NOW + 5)).toBe("unchanged");
  writeFileSync(join(dirA, "models.txt"), catalog("zai", "glm", 250_000) + catalog("other", "kimi", 1));
  expect(captureModelWindow("zai/glm", dirA, env, NOW + 6)).toBe("updated");
  const map = readWindowMap(env);
  expect(windowFor(map, dirA, "zai/glm")).toBe(250_000);
  expect(windowFor(map, dirA, "other/kimi")).toBe(131_072);
  expect(calls().some(line => line.endsWith("|models zai --verbose --pure"))).toBe(true);
});

test("launch capture refetches the whole catalog after a version change or the TTL", () => {
  captureModelWindow("zai/glm", dirA, env, NOW);
  writeFileSync(join(dirA, "models.txt"), catalog("zai", "glm", 111_000) + catalog("other", "kimi", 222_000));
  writeFileSync(versionFile, "1.3.0");
  expect(captureModelWindow("zai/glm", dirA, env, NOW + 1)).toBe("refreshed");
  expect(windowFor(readWindowMap(env), dirA, "other/kimi")).toBe(222_000);

  writeFileSync(join(dirA, "models.txt"), catalog("zai", "glm", 112_000) + catalog("other", "kimi", 333_000));
  expect(captureModelWindow("zai/glm", dirA, env, NOW + WINDOW_MAP_TTL_S + 2)).toBe("refreshed");
  expect(windowFor(readWindowMap(env), dirA, "other/kimi")).toBe(333_000);
});

test("launch capture is best effort: bad model, unknown model, or no opencode changes nothing", () => {
  expect(captureModelWindow("no-provider", dirA, env, NOW)).toBe("failed");
  expect(captureModelWindow("zai/missing", dirA, env, NOW)).toBe("failed");
  expect(captureModelWindow("zai/glm", dirFail, env, NOW)).toBe("failed");
  expect(captureModelWindow("zai/glm", dirA, { ...env, PATH: "/usr/bin:/bin" }, NOW)).toBe("failed");
  expect(readWindowMap(env)?.directories[dirFail]).toBeUndefined();
});

test("launch capture reads the version once and its whole call chain stays inside one small budget", () => {
  expect(captureModelWindow("zai/glm", dirA, env, NOW)).toBe("refreshed");
  expect(calls().filter(line => line.endsWith("|--version"))).toHaveLength(1);

  const slow = { ...env, OPENCODE_SLOW: "1" };
  const started = Date.now();
  expect(captureModelWindow("zai/glm", dirB, slow, NOW + 1, 400)).toBe("failed");
  expect(Date.now() - started).toBeLessThan(2000);
  expect(windowFor(readWindowMap(env), dirB, "zai/glm")).toBeUndefined();
});
