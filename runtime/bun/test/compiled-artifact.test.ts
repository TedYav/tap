// tap-7r3fn.192: the compiled router in a release-artifact layout, with no Bun on PATH.
// Before libexec/tap/bun existed, `tap init` here failed at initArgv with
// `Executable not found in $PATH: "bun"`, and the resource verbs read the compiled
// module's virtual /$bunfs directory even with Bun installed. Each test runs the
// artifact's own router (or its shim) the way an installed `tap` would.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { compiledArtifact, compiledRouterCleanup } from "./compiled-router";

const NO_BUN_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const scratch: string[] = [];
afterAll(() => {
  compiledRouterCleanup();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function dir(prefix: string): string {
  const made = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(made);
  return made;
}

/** The caller's environment with Bun removed from PATH and BUN_BE_BUN exported, as a leaked value would be. */
function noBunEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, PATH: NO_BUN_PATH, BUN_BE_BUN: "1", ...extra };
}

function tap(args: string[], cwd: string, env: NodeJS.ProcessEnv = noBunEnv()) {
  // bin/tap unsets BUN_BE_BUN before it execs the router; this calls the router directly, so it does the same.
  const { BUN_BE_BUN: _leaked, ...clean } = env;
  return spawnSync(compiledArtifact().router, args, { cwd, env: clean, encoding: "utf8", timeout: 60000 });
}

test("the no-Bun PATH really has no bun, and the same check finds the runner's bun", () => {
  expect(spawnSync("/bin/sh", ["-c", "command -v bun"], { env: { PATH: NO_BUN_PATH } }).status).not.toBe(0);
  expect(spawnSync("/bin/sh", ["-c", "command -v bun"], { env: { PATH: process.env.PATH ?? "" } }).status).toBe(0);
});

test("tap init with no Bun on PATH starts its child through the artifact shim and creates the bus", () => {
  const project = dir("tap-artifact-init-");
  const result = tap(["init", "--yes", "--json"], project);
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(result.stdout).toContain('"ok":true');
  expect(existsSync(join(project, ".tap/bus"))).toBe(true);
}, 120000);

test("resource verbs read the artifact root, not the compiled module's virtual directory", () => {
  const cwd = dir("tap-artifact-resources-");
  const { root } = compiledArtifact();

  const completion = tap(["completion", "zsh"], cwd);
  expect(completion.status, completion.stderr).toBe(0);
  expect(completion.stdout).toContain(readFileSync(join(root, "completions/_tap"), "utf8").trim().split("\n")[0]!);

  const models = tap(["models"], cwd);
  expect(models.status, models.stderr).toBe(0);
  expect(models.stdout).toContain("opus");

  const help = tap(["help", "skill", "tap-send"], cwd);
  expect(help.status, help.stderr).toBe(0);
  expect(realpathSync(help.stdout.trim())).toBe(realpathSync(join(root, "skills/send/SKILL.md")));

  const answers = join(cwd, "answers.json");
  writeFileSync(answers, JSON.stringify({ harnesses: { claude: { presets: ["opus"], permissions: "auto" } }, write: "apply", shellIntegration: true }));
  const setup = tap(["setup", "--machine", "--answers", answers, "--dry-run", "--json"], cwd, noBunEnv({ HOME: dir("tap-artifact-home-") }));
  expect(setup.status, `${setup.stdout}\n${setup.stderr}`).toBe(0);
  expect(`${setup.stdout}${setup.stderr}`).not.toContain("$bunfs");
}, 120000);

// Each spawn form a TAP child uses, reporting whether its grandchild saw BUN_BE_BUN. Bun.spawn and
// Bun.spawnSync without an env option hand the child the process's ORIGINAL environment, so a
// process.env delete alone leaves them leaking; node:child_process reads process.env.
const SPAWN_FORMS = [
  'import { spawnSync } from "node:child_process";',
  'const leaked = (text: string) => text.split("\\n").some(line => line.startsWith("BUN_BE_BUN="));',
  "const grandchildren = {",
  '  nodeSpawnSync: leaked(spawnSync("/usr/bin/env", [], { encoding: "utf8" }).stdout),',
  '  bunSpawnSync: leaked(Bun.spawnSync(["/usr/bin/env"]).stdout.toString()),',
  '  bunSpawnSyncCmd: leaked(Bun.spawnSync({ cmd: ["/usr/bin/env"] }).stdout.toString()),',
  '  bunSpawn: leaked(await new Response(Bun.spawn(["/usr/bin/env"]).stdout).text()),',
  "};",
  "console.log(JSON.stringify({ own: process.env.BUN_BE_BUN ?? null, grandchildren, args: process.argv.slice(2) }));",
].join("\n");
const NO_LEAK = { nodeSpawnSync: false, bunSpawnSync: false, bunSpawnSyncCmd: false, bunSpawn: false };

test("the shim runs a shipped .ts as Bun and deletes BUN_BE_BUN before the child's code and every spawn form's grandchild see it", () => {
  const cwd = dir("tap-artifact-shim-");
  const probe = join(cwd, "show.ts");
  writeFileSync(probe, SPAWN_FORMS);
  const result = spawnSync(compiledArtifact().shim, [probe, "a", "b c"], { cwd, env: noBunEnv(), encoding: "utf8", timeout: 60000 });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ own: null, grandchildren: NO_LEAK, args: ["a", "b c"] });
}, 120000);

test("control: a process.env delete alone leaves Bun.spawn grandchildren holding BUN_BE_BUN", () => {
  const cwd = dir("tap-artifact-shim-control-");
  const probe = join(cwd, "show.ts"), deleteOnly = join(cwd, "delete-only.ts");
  writeFileSync(probe, SPAWN_FORMS);
  writeFileSync(deleteOnly, "delete process.env.BUN_BE_BUN;\n");
  const result = spawnSync(compiledArtifact().router, ["--preload", deleteOnly, probe], { cwd, env: noBunEnv(), encoding: "utf8", timeout: 60000 });
  expect(result.status, result.stderr).toBe(0);
  const seen = JSON.parse(result.stdout);
  expect(seen.own).toBeNull();
  expect(seen.grandchildren).toEqual({ nodeSpawnSync: false, bunSpawnSync: true, bunSpawnSyncCmd: true, bunSpawn: true });
}, 120000);
