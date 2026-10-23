import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdSessionLaunch, type LaunchDeps } from "../src/launcher/new";

/**
 * Port of smoke/launch-prerequisites.test.sh's module-door arms: the launcher's
 * missing-prerequisite refusals are actionable and PRECEDE any enrollment or
 * reservation — the publication assertions below are what pin that ordering,
 * so they must face the state a regressed order would actually publish (the
 * git root's .tap and the whole index dir, exactly the incumbent's asserts).
 * The public door cannot reach these refusals from an unenrolled cwd (the
 * router's first-run onboarding preempts them), so the contract is pinned
 * here, in process, exactly where it lives.
 */
const work = mkdtempSync(join(tmpdir(), "launch-prereqs-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

let n = 0;

/**
 * An unenrolled scratch git root whose PATH offers git plus only the named
 * fakes. The stranger cwd IS the git root: publication lands at its .tap.
 * The index dir is never pre-created — its absence is part of the assertion.
 */
function stranger(bins: { name: string; body: string }[]): string {
  const root = join(work, String(n++));
  const binsDir = join(root, "bin");
  mkdirSync(binsDir, { recursive: true });
  symlinkSync("/usr/bin/git", join(binsDir, "git"));
  for (const bin of bins) {
    const f = join(binsDir, bin.name);
    writeFileSync(f, bin.body);
    chmodSync(f, 0o755);
  }
  const strangerDir = join(root, "stranger");
  mkdirSync(strangerDir);
  spawnSync("git", ["init", "-q", strangerDir]);
  return root;
}

const NO_TMUX_EFFECT = "#!/bin/sh\necho unexpected-tmux-effect >&2\nexit 99\n";

/** One in-process `tap session launch` equivalent; returns rc and captured stderr. */
async function captureLaunch(root: string, args: string[], overrides: Partial<LaunchDeps> = {}): Promise<{ rc: number; stderr: string; stdout: string }> {
  const lines: string[] = [], output: string[] = [];
  const saved = { cwd: process.cwd(), env: { ...process.env } };
  const originalErr = process.stderr.write, originalOut = process.stdout.write;
  process.stderr.write = ((chunk: string) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    process.chdir(join(root, "stranger"));
    delete process.env.TAP_HOME; delete process.env.TAP_JSON;
    delete process.env.TAP_TEAM; delete process.env.TAP_CLEAR_ID;
    delete process.env.TMUX; delete process.env.TMUX_PANE;
    process.env.PATH = join(root, "bin");
    process.env.HOME = join(root, "home");
    process.env.XDG_CONFIG_HOME = join(root, "config");
    process.env.TAP_INDEX_HOME = join(root, "index");
    const rc = await cmdSessionLaunch(args, undefined, overrides);
    return { rc, stderr: lines.join(""), stdout: output.join("") };
  } finally {
    process.stderr.write = originalErr; process.stdout.write = originalOut;
    process.chdir(saved.cwd);
    for (const key of Object.keys(process.env)) if (!(key in saved.env)) delete process.env[key];
    Object.assign(process.env, saved.env);
  }
}

/** The incumbent's publication asserts: nothing at the git root, no index dir. */
function assertNoPublication(root: string): void {
  expect(existsSync(join(root, "stranger", ".tap"))).toBe(false);
  expect(existsSync(join(root, "stranger", "AGENTS.md"))).toBe(false);
  expect(existsSync(join(root, "index"))).toBe(false);
}

test("a launch without tmux refuses with the remedy, before any state", async () => {
  const root = stranger([]);
  const { rc, stderr } = await captureLaunch(root, ["claude"]);
  expect(rc).not.toBe(0);
  expect(stderr).toContain("tmux was not found on PATH");
  expect(stderr).toContain("tmux -V");
  assertNoPublication(root);
});

test("an enrolled launch without tmux preserves the prerequisite class and remedy", async () => {
  const root = stranger([]), cwd = join(root, "stranger");
  const registry = join(cwd, ".tap/team-registry.json");
  mkdirSync(join(cwd, ".tap/bus"), { recursive: true });
  mkdirSync(join(root, "index"));
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "stranger", worktree_root: cwd }, seats: {} }));
  writeFileSync(join(root, "index/global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    stranger: { root: cwd, registry_location: registry },
  } }));
  const original = readFileSync(registry, "utf8");
  for (const json of [false, true]) {
    const result = await captureLaunch(root, ["claude", "scout", ...(json ? ["--json"] : [])]);
    expect(result.rc).toBe(2);
    if (json) {
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({ error_class: "missing_prerequisite", detail: "tmux was not found on PATH" });
    } else expect(result.stderr).toContain("tmux was not found on PATH");
    expect(result.stderr + result.stdout).toContain("tmux -V");
    expect(readFileSync(registry, "utf8")).toBe(original);
  }
});

test("a present-but-broken tmux is never executed; the harness refusal carries", async () => {
  const root = stranger([{ name: "tmux", body: NO_TMUX_EFFECT }]);
  for (const [harness, executable] of [["claude", "claude"], ["cursor", "cursor-agent"], ["hermes", "hermes"]] as const) {
    const { rc, stderr } = await captureLaunch(root, [harness]);
    expect(rc).not.toBe(0);
    expect(stderr).toContain(`${executable} was not found on PATH`);
    expect(stderr).toContain("authentication");
    expect(stderr).not.toContain("unexpected-tmux-effect");
    assertNoPublication(root);
  }
});


test("direct first launch completes instructions before harness startup", async () => {
  const root = stranger([
    { name: "tmux", body: "#!/bin/sh\nexit 0\n" },
    { name: "claude", body: "#!/bin/sh\nexit 99\n" },
  ]);
  assertNoPublication(root);
  let started = false;
  const result = await captureLaunch(root, ["claude", "reviewer"], {
    run: async record => {
      expect(record.name).toBe("stranger/reviewer");
      expect(readFileSync(join(root, "stranger", "AGENTS.md"), "utf8")).toContain("<!-- TAP:BEGIN -->");
      expect(existsSync(join(root, "stranger", ".tap", "team-registry.json"))).toBe(true);
      started = true;
      return 0;
    },
  });
  expect(result.rc, result.stderr).toBe(0);
  expect(started).toBe(true);
  expect(result.stderr).toContain("added project TAP signpost");
});


test("custom-session launch receipt points to the actual registered seat", async () => {
  const root = stranger([
    { name: "tmux", body: "#!/bin/sh\nexit 0\n" },
    { name: "claude", body: "#!/bin/sh\nexit 99\n" },
  ]);
  const result = await captureLaunch(root, ["claude", "--unique", "custom-session"], { run: async () => 0 });
  expect(result.rc, result.stderr).toBe(0);
  expect(result.stdout).toContain("custom-session is running detached");
  expect(result.stdout).toContain("tap attach stranger/claude");
  expect(result.stdout).not.toContain("tap attach custom-session");
});
