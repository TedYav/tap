// tap-7r3fn.192: in a release artifact no Bun need be installed, process.execPath is the
// compiled router, and a bundled module's import.meta directory is the virtual /$bunfs.
// Children therefore get their Bun from artifactBun()/bunBinary() and their paths from
// tapRoot()/runtimeModule()/tapScriptsDir() (src/scripts-dir.ts). This guard refuses new
// code that bypasses them; compiled-artifact.test.ts proves the paths that exist work.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const BUN_ROOT = resolve(import.meta.dir, "..");

type Hit = { file: string; line: number; rule: string; text: string };

const SPAWN_RULES: { rule: string; match: RegExp; unless?: RegExp }[] = [
  { rule: "bare bun argv0", match: /(?:\bspawn|\bspawnSync|Bun\.spawn|Bun\.spawnSync)\(\s*"bun"|\[\s*"bun"\s*,/ },
  { rule: "Bun.which(\"bun\") without the artifact shim first", match: /Bun\.which\(\s*"bun"/, unless: /artifactBun\(\)\s*\?\?/ },
  { rule: "process.execPath as a module interpreter", match: /(?:\bspawn|\bspawnSync|Bun\.spawn|Bun\.spawnSync|execve!?)\(\s*process\.execPath\b|\[\s*process\.execPath\s*,/ },
];
const PATH_RULE = /import\.meta\.(?:dir|path|url|dirname|filename)\b/;

/** Files whose spawn hits are the fallbacks themselves. Each entry says why. */
const SPAWN_ALLOW: Record<string, string> = {
  "src/courier-argv.ts": "the builders' own fallbacks: bun from PATH, or process.execPath, when no artifact shim exists",
  "src/watch-run.ts": "reexecImage's source fallback; it checks the shim with Node built-ins because this entry imports nothing else before it stamps its sources",
};

/** Router-bundled files whose import.meta use is not router path math. Each entry says why. */
const PATH_ALLOW: Record<string, string> = {
  "src/scripts-dir.ts": "the resolver itself: its source branch is how tapScriptsDir() finds a checkout",
  "src/courier-argv.ts": "compile detection (import.meta.path under /$bunfs/), not a path",
  "src/watch-run.ts": "the `bun watch-run.ts run` entry block, which runs only from shipped source (import.meta.main)",
  "src/startup-trace.ts": "the scripts-dir-less writer re-runs this very module from source; the compiled router takes runtimeModule()",
};

function isComment(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/**
 * The KTD4 class: a site that runs verbs/escalate.ts on process.execPath with BUN_BE_BUN=1.
 * From the router or a shim child, process.execPath is the router, which BUN_BE_BUN turns
 * into Bun; escalate.ts deletes the variable on entry.
 */
function escalateClass(text: string, source: string): boolean {
  return /escalate/i.test(text) && source.includes('BUN_BE_BUN: "1"');
}

export function spawnHits(file: string, source: string): Hit[] {
  const hits: Hit[] = [];
  source.split("\n").forEach((text, i) => {
    if (isComment(text)) return;
    for (const { rule, match, unless } of SPAWN_RULES) {
      if (!match.test(text) || unless?.test(text)) continue;
      if (rule.startsWith("process.execPath") && escalateClass(text, source)) continue;
      hits.push({ file, line: i + 1, rule, text: text.trim() });
    }
  });
  return hits;
}

export function pathHits(file: string, source: string): Hit[] {
  const hits: Hit[] = [];
  source.split("\n").forEach((text, i) => {
    if (!isComment(text) && PATH_RULE.test(text)) hits.push({ file, line: i + 1, rule: "import.meta path in a router-bundled module", text: text.trim() });
  });
  return hits;
}

function sources(): string[] {
  const files = ["main.ts"];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(BUN_ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { if (rel !== "src/publish") walk(rel); }
      else if (entry.name.endsWith(".ts")) files.push(rel);
    }
  };
  walk("src");
  return files.sort();
}

/** The runtime/bun sources `bun build --compile main.ts` bundles into the router. */
async function routerBundled(): Promise<Set<string>> {
  const built = await Bun.build({ entrypoints: [join(BUN_ROOT, "main.ts")], target: "bun", metafile: true });
  expect(built.success, built.logs.join("\n")).toBe(true);
  const inputs = Object.keys(built.metafile?.inputs ?? {});
  return new Set(inputs.map(input => relative(BUN_ROOT, resolve(process.cwd(), input))));
}

test("the guard can refuse: each rule flags a planted bypass and passes the migrated spelling", () => {
  expect(spawnHits("x.ts", 'spawnSync("bun", [leaf])').map(h => h.rule)).toEqual(["bare bun argv0"]);
  expect(spawnHits("x.ts", 'const argv = ["bun", leaf];').map(h => h.rule)).toEqual(["bare bun argv0"]);
  expect(spawnHits("x.ts", 'const bun = Bun.which("bun");').map(h => h.rule)).toEqual(['Bun.which("bun") without the artifact shim first']);
  expect(spawnHits("x.ts", "Bun.spawn([process.execPath, entry]);").map(h => h.rule)).toEqual(["process.execPath as a module interpreter"]);
  expect(spawnHits("x.ts", "execve(process.execPath, process.argv, env);").map(h => h.rule)).toEqual(["process.execPath as a module interpreter"]);
  expect(pathHits("x.ts", 'const p = resolve(import.meta.dir, "../x");')).toHaveLength(1);
  expect(spawnHits("x.ts", 'spawnSync(artifactBun() ?? "bun", [leaf]);\nconst bun = artifactBun() ?? Bun.which("bun");\nspawn(bunBinary(), [leaf]);')).toEqual([]);
  expect(pathHits("x.ts", "// import.meta.dir in a comment")).toEqual([]);
});

test("the escalate class passes only where the file sets BUN_BE_BUN=1", () => {
  const line = 'spawnSync(process.execPath, [resolve(s, "../../../runtime/bun/src/verbs/escalate.ts")]';
  expect(spawnHits("x.ts", `${line}\nconst env = { BUN_BE_BUN: "1" };`)).toEqual([]);
  expect(spawnHits("x.ts", line)).toHaveLength(1);
  expect(spawnHits("x.ts", 'spawnSync(process.execPath, [other]);\nconst env = { BUN_BE_BUN: "1" };')).toHaveLength(1);
});

test("no runtime source spawns a child Bun outside the artifact-aware helpers", () => {
  expect(sources().length).toBeGreaterThan(200);
  const hits = sources().filter(file => !(file in SPAWN_ALLOW)).flatMap(file => spawnHits(file, readFileSync(join(BUN_ROOT, file), "utf8")));
  expect(hits).toEqual([]);
});

test("no router-bundled module builds a runtime path from import.meta", async () => {
  const bundled = await routerBundled();
  expect(bundled.has("src/courier-argv.ts")).toBe(true);
  expect(bundled.size).toBeGreaterThan(200);
  const hits = sources().filter(file => bundled.has(file) && !(file in PATH_ALLOW)).flatMap(file => pathHits(file, readFileSync(join(BUN_ROOT, file), "utf8")));
  expect(hits).toEqual([]);
}, 60000);

test("every allowlist entry is still needed and carries a reason", async () => {
  const bundled = await routerBundled();
  for (const [file, reason] of Object.entries(SPAWN_ALLOW)) {
    expect(reason.length).toBeGreaterThan(20);
    expect(spawnHits(file, readFileSync(join(BUN_ROOT, file), "utf8")).length, file).toBeGreaterThan(0);
  }
  for (const [file, reason] of Object.entries(PATH_ALLOW)) {
    expect(reason.length).toBeGreaterThan(20);
    expect(bundled.has(file), file).toBe(true);
    expect(pathHits(file, readFileSync(join(BUN_ROOT, file), "utf8")).length, file).toBeGreaterThan(0);
  }
}, 60000);
