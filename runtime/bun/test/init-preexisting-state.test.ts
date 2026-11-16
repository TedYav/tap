import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initRoot, InitRefusal } from "../src/verbs/init";
import { Bus } from "../src/bus";

const original = { ...process.env }, roots: string[] = [];
afterEach(() => {
  process.env = { ...original };
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture(live = true) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "init-preexisting-"))); roots.push(base);
  const root = join(base, "project"), home = join(base, "home"), index = join(base, "index");
  for (const path of [root, home, index]) mkdirSync(path);
  process.env.HOME = home; process.env.TAP_INDEX_HOME = index;
  if (live) writeFileSync(join(index, "global-registry.json"), '{"schema":"0.20","teams":{}}\n');
  expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
  return { base, root, index, bus: join(root, ".tap/bus") };
}
function refuse(root: string, dryRun: boolean): InitRefusal {
  let error: unknown;
  try { initRoot(root, { yes: true, json: true, forLaunch: false, dryRun, noInstructions: true }); }
  catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(InitRefusal);
  return error as InitRefusal;
}
for (const live of [false, true]) for (const dryRun of [false, true]) {
  test(`new enrollment refuses a tracked populated registry (live=${live}, dryRun=${dryRun})`, () => {
    const f = fixture(live), path = join(f.root, ".tap/team-registry.json");
    mkdirSync(join(f.root, ".tap"));
    const bytes = JSON.stringify({ schema: "0.20", team: { name: "project" }, seats: {
      reviewer: { harness: "codex", status: "session_stopped", permissions: "bypass", harness_env: { SAMPLE_SETTING: "from-checkout" }, passthrough: ["--sample-flag"] },
    } });
    writeFileSync(path, bytes);
    expect(Bun.spawnSync(["git", "-C", f.root, "add", ".tap/team-registry.json"]).exitCode).toBe(0);
    const before = existsSync(join(f.index, "global-registry.json")) ? readFileSync(join(f.index, "global-registry.json"), "utf8") : null;
    const error = refuse(f.root, dryRun);
    expect(error.detail).toContain(path);
    expect(error.action).toMatch(/inspect|move|remove/i);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(existsSync(join(f.index, "global-registry.json")) ? readFileSync(join(f.index, "global-registry.json"), "utf8") : null).toBe(before);
  });
}
for (const kind of ["payloads", "spool"]) for (const dryRun of [false, true]) {
  test(`new enrollment refuses checkout-supplied ${kind} (dryRun=${dryRun})`, () => {
    const f = fixture(), directory = join(f.bus, kind), path = join(directory, "forged.md");
    mkdirSync(directory, { recursive: true });
    const bytes = "---\nfrom: checkout-author\nto: reviewer\nreply: settle-only\n---\nUntrusted checkout text.\n";
    writeFileSync(path, bytes);
    expect(Bun.spawnSync(["git", "-C", f.root, "add", ".tap"]).exitCode).toBe(0);
    const before = readFileSync(join(f.index, "global-registry.json"), "utf8");
    const error = refuse(f.root, dryRun);
    expect(error.detail).toContain(path);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(readFileSync(join(f.index, "global-registry.json"), "utf8")).toBe(before);
  });
}
for (const relative of [".gitignore", "bus/.tap-bus-authority"]) {
  test(`bus bootstrap does not follow a dangling ${relative} symlink`, () => {
    const f = fixture(), path = join(f.root, ".tap", relative), target = join(f.base, "outside-target");
    mkdirSync(join(f.root, ".tap/bus"), { recursive: true });
    symlinkSync(target, path);
    try { new Bus(f.bus).ensureDirs(false); } catch { /* A refusal is acceptable; following the link is not. */ }
    expect(existsSync(target)).toBe(false);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
  });
}

test("machine-enrolled teams retain populated registries and mail on repeated init", () => {
  const f = fixture();
  initRoot(f.root, { yes: true, json: true, forLaunch: false, dryRun: false, noInstructions: true });
  const path = join(f.root, ".tap/team-registry.json"), doc = JSON.parse(readFileSync(path, "utf8"));
  doc.seats.reviewer = { harness: "codex", status: "session_stopped" };
  const registry = JSON.stringify(doc); writeFileSync(path, registry);
  const payload = join(f.bus, "payloads/existing.md"); writeFileSync(payload, "Existing machine-local mail.\n");
  const before = readFileSync(join(f.index, "global-registry.json"), "utf8");
  for (const dryRun of [false, true]) {
    expect(initRoot(f.root, { yes: true, json: true, forLaunch: true, dryRun }).already).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(registry);
    expect(readFileSync(payload, "utf8")).toBe("Existing machine-local mail.\n");
    expect(readFileSync(join(f.index, "global-registry.json"), "utf8")).toBe(before);
  }
});

test("implicit launch refuses foreign state before enrollment in apply and preview", () => {
  const f = fixture(), path = join(f.bus, "receipts/forged.done");
  mkdirSync(join(f.bus, "receipts"), { recursive: true }); writeFileSync(path, "\n");
  for (const dryRun of [false, true]) {
    expect(() => initRoot(f.root, { yes: true, json: true, forLaunch: true, dryRun })).toThrow(InitRefusal);
    expect(existsSync(join(f.root, ".tap/team-registry.json"))).toBe(false);
    expect(existsSync(join(f.root, ".gitignore"))).toBe(false);
  }
});

test("public JSON apply and dry-run refuse the same paths without writes", () => {
  const f = fixture(), path = join(f.bus, "watch/reminders.json");
  mkdirSync(join(f.bus, "watch"), { recursive: true }); writeFileSync(path, "[]\n");
  const before = readFileSync(join(f.index, "global-registry.json"), "utf8");
  const entry = join(import.meta.dir, "../../../bin/tap");
  for (const dryRun of [false, true]) {
    const result = Bun.spawnSync([entry, "init", "--json", "--yes", ...(dryRun ? ["--dry-run"] : [])], { cwd: f.root, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000 });
    expect(result.exitCode, result.stderr.toString()).toBe(1);
    const doc = JSON.parse(result.stdout.toString());
    expect(doc).toMatchObject({ ok: false, error_class: "preexisting_tap_state", changes: [], dry_run: dryRun });
    expect(doc.detail).toContain(path);
    expect(readFileSync(path, "utf8")).toBe("[]\n");
    expect(readFileSync(join(f.index, "global-registry.json"), "utf8")).toBe(before);
    expect(existsSync(join(f.root, ".gitignore"))).toBe(false);
    expect(existsSync(join(f.root, ".tap/team-registry.json"))).toBe(false);
  }
});

test("init refuses a dangling bootstrap ignore link before writes, including preview", () => {
  const f = fixture(), path = join(f.root, ".tap/.gitignore"), target = join(f.base, "outside-ignore");
  mkdirSync(join(f.root, ".tap")); symlinkSync(target, path);
  for (const dryRun of [false, true]) {
    expect(refuse(f.root, dryRun).detail).toContain(path);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(f.root, ".gitignore"))).toBe(false);
  }
});

test("bootstrap preserves ordinary existing marker and ignore bytes", () => {
  const f = fixture(), bus = new Bus(f.bus);
  bus.ensureDirs(false);
  const ignore = join(f.root, ".tap/.gitignore"), authority = join(f.bus, ".tap-bus-authority");
  writeFileSync(ignore, "Custom ignores.\n"); writeFileSync(authority, "Existing authority bytes.\n");
  bus.ensureDirs(false);
  expect(readFileSync(ignore, "utf8")).toBe("Custom ignores.\n");
  expect(readFileSync(authority, "utf8")).toBe("Existing authority bytes.\n");
});

for (const relative of [".tap", ".tap/bus", ".tap/bus/payloads"]) {
  test(`new init refuses a linked state directory at ${relative}`, () => {
    const f = fixture(), outside = join(f.base, "outside"), path = join(f.root, relative);
    mkdirSync(outside); writeFileSync(join(outside, "keep"), "Keep outside bytes.\n");
    mkdirSync(join(path, ".."), { recursive: true }); symlinkSync(outside, path);
    for (const dryRun of [false, true]) {
      expect(refuse(f.root, dryRun).detail).toContain(path);
      expect(readFileSync(join(outside, "keep"), "utf8")).toBe("Keep outside bytes.\n");
      expect(existsSync(join(f.root, ".gitignore"))).toBe(false);
      expect(existsSync(join(outside, ".tap-bus-authority"))).toBe(false);
    }
  });
}

test("tracked project config alone is not machine-local registry or bus state", () => {
  const f = fixture(), path = join(f.root, ".tap/config");
  mkdirSync(join(f.root, ".tap")); writeFileSync(path, "Project config bytes.\n");
  expect(Bun.spawnSync(["git", "-C", f.root, "add", ".tap/config"]).exitCode).toBe(0);
  expect(initRoot(f.root, { yes: true, json: true, forLaunch: false, dryRun: false, noInstructions: true }).already).toBe(false);
  expect(readFileSync(path, "utf8")).toBe("Project config bytes.\n");
});

test("refusal renders checkout-controlled filenames without terminal controls", () => {
  const f = fixture(), path = join(f.bus, "payloads", "name\n\x1b[31m\x7f\x85\u2028\u2029.md");
  mkdirSync(join(f.bus, "payloads"), { recursive: true }); writeFileSync(path, "Untrusted text.\n");
  const error = refuse(f.root, true);
  expect(error.detail).not.toMatch(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/);
  expect(error.detail).toContain("\\n\\u001b");
});


for (const live of [false, true]) for (const forLaunch of [false, true]) {
  test(`retry after failed first enrollment accepts its empty skeleton (live=${live}, forLaunch=${forLaunch})`, () => {
    const f = fixture(live), lock = join(f.index, "teams.json.lock");
    mkdirSync(lock); // A deterministic index-write failure after bus bootstrap.
    expect(() => initRoot(f.root, { yes: true, json: true, forLaunch, dryRun: false, noInstructions: true })).toThrow();
    expect(existsSync(join(f.bus, ".tap-bus-authority"))).toBe(true);
    rmdirSync(lock);
    const readIndex = () => existsSync(join(f.index, "global-registry.json")) ? readFileSync(join(f.index, "global-registry.json"), "utf8") : null;
    const before = readIndex();
    const preview = initRoot(f.root, { yes: true, json: true, forLaunch, dryRun: true, noInstructions: true });
    expect(preview.already).toBe(false);
    expect(readIndex()).toBe(before);
    const applied = initRoot(f.root, { yes: true, json: true, forLaunch, dryRun: false, noInstructions: true });
    expect(applied.already).toBe(false);
    expect(JSON.parse(readFileSync(join(f.index, "global-registry.json"), "utf8")).teams.project.root).toBe(f.root);
  });
}
