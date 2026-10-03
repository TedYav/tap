import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/bus";
import { busHomeForRoot, containerRefusal, resolveBus, teamRootFromBus } from "../src/bushome";
import { busHomeForEnrolled, selectCaller } from "../src/selector";
import { bindRemoteTeam } from "../src/remote-target";
import { resolvePayloadById } from "../src/index-home";
import { resolvePayloadAddress } from "../src/payload-view";
import { removeScratchTree } from "./support/scratch";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeScratchTree(root); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tap-bus-root-")); roots.push(root);
  const legacy = join(root, "tmp", "tap"), canonical = join(root, ".tap", "bus");
  mkdirSync(legacy, { recursive: true });
  return { root, legacy, canonical };
}

for (const kind of ["current", "malformed", "dangling"]) test(`legacy ${kind} registry is a resolution state and refuses before effects`, () => {
  const f = fixture(), path = join(f.legacy, "registry.json");
  if (kind === "dangling") symlinkSync("missing", path);
  else writeFileSync(path, kind === "current" ? '{"schema":"0.20","seats":{}}' : "not json");
  expect(resolveBus(f.root, {})).toEqual({ home: f.canonical, rule: "old_store" });
  for (const effect of [() => busHomeForRoot(f.root), () => busHomeForEnrolled(f.root), () => new Bus(f.canonical).ensureDirs(), () => new Bus(f.canonical + "/").ensureDirs(), () => new Bus(f.root + "/missing/../.tap/bus").ensureDirs()]) {
    expect(effect).toThrow("old_store");
    expect(existsSync(f.canonical)).toBe(false);
  }
  if (kind !== "dangling") expect(readFileSync(path, "utf8")).toBe(kind === "current" ? '{"schema":"0.20","seats":{}}' : "not json");
});

test("canonical bus wins without reading the stale registry; scratch-only legacy directory is ignored", () => {
  const f = fixture();
  writeFileSync(join(f.legacy, "scratch.md"), "keep");
  expect(resolveBus(f.root, {})).toEqual({ home: f.canonical, rule: "default" });
  new Bus(f.canonical).ensureDirs();
  writeFileSync(join(f.legacy, "registry.json"), "not even json");
  expect(resolveBus(f.root, {})).toEqual({ home: f.canonical, rule: "dotdir" });
  expect(readFileSync(join(f.legacy, "scratch.md"), "utf8")).toBe("keep");
});

test("an explicit tmp/tap home remains an ordinary custom home", () => {
  const f = fixture();
  writeFileSync(join(f.legacy, "registry.json"), '{"schema":"0.20","seats":{}}');
  const bus = resolveBus(f.root, { TAP_HOME: f.legacy });
  expect(bus.rule).toBe("env");
  expect(containerRefusal(bus.home)).toBeNull();
  new Bus(bus.home).ensureDirs();
  expect(existsSync(join(f.legacy, "payloads"))).toBe(true);
  expect(existsSync(f.canonical)).toBe(false);
  expect(teamRootFromBus(f.legacy)).toBe(realpathSync(join(f.root, "tmp")));
});

test("enrolled local and remote selection refuse a legacy-only root with a relocated acting file", () => {
  const f = fixture(), index = join(f.root, "index"), acting = join(f.root, "acting.json");
  mkdirSync(index);
  writeFileSync(acting, JSON.stringify({ schema: "0.20", team: { name: "legacy", worktree_root: f.root }, seats: {} }));
  writeFileSync(join(f.legacy, "registry.json"), "retained evidence");
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    legacy: { root: f.root, registry_location: acting, state: "registered" },
  } }));
  expect(() => selectCaller({ cwd: f.root, explicitTeam: "legacy", env: { TAP_INDEX_HOME: index } })).toThrow("old_store");
  expect(() => bindRemoteTeam("legacy", "peer", index)).toThrow("old_store");
  expect(existsSync(f.canonical)).toBe(false);
  const env: NodeJS.ProcessEnv = { ...process.env, TAP_INDEX_HOME: index, TAP_JSON: "1", TAP_MIGRATING: "1" };
  delete env.TAP_HOME;
  const before = readFileSync(join(index, "global-registry.json"), "utf8");
  const invoke = (args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../main.ts"), ...args], {
    cwd: f.root, env, stdout: "pipe", stderr: "pipe", timeout: 30000,
  });
  for (const args of [["init", "--json"], ["register", "peer", "--delivery", "poll", "--team", "legacy", "--json"], ["admin", "retire", "legacy", "--force", "--json"], ["admin", "rebuild-registry", "--yes", "--json"], ["session", "repair", "--all", "--dry-run", "--json"], ["doctor", "--fix", "--json"]]) {
    const result = invoke(args);
    expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(1);
    expect(result.stdout.toString()).toContain('"old_store"');
    expect(existsSync(f.canonical)).toBe(false);
    expect(readFileSync(join(index, "global-registry.json"), "utf8")).toBe(before);
    expect(readFileSync(acting, "utf8")).toBe(JSON.stringify({ schema: "0.20", team: { name: "legacy", worktree_root: f.root }, seats: {} }));
  }
  for (const args of [["doctor", "--json"], ["admin", "--json"], ["admin", "--fast", "--json"]]) {
    const result = invoke(args);
    expect(result.exitCode, `${args.join(" ")}: ${result.stdout.toString()} ${result.stderr.toString()}`).toBe(1);
    expect(result.stdout.toString()).toContain('"old_store"');
    expect(existsSync(f.canonical)).toBe(false);
  }
  const hook = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/session-start.ts"), "context", f.root], {
    cwd: f.root, env, stdout: "pipe", stderr: "pipe", timeout: 30000,
  });
  expect(hook.exitCode).toBe(0);
  expect(hook.stderr.toString()).toContain("old_store");
  expect(hook.stdout.toString()).not.toContain("registered as");
  expect(existsSync(f.canonical)).toBe(false);
  writeFileSync(join(index, "global-registry.json"), "invalid index evidence");
  const invalid = invoke(["init", "--json"]);
  expect(invalid.exitCode).toBe(1);
  expect(invalid.stdout.toString()).toContain('"invalid_flip"');
  expect(readFileSync(join(index, "global-registry.json"), "utf8")).toBe("invalid index evidence");
  expect(existsSync(f.canonical)).toBe(false);
}, 60000);

test("a tmp file is absence of a legacy registry, not a resolution failure", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-bus-root-file-")); roots.push(root);
  writeFileSync(join(root, "tmp"), "ordinary file");
  expect(resolveBus(root, {}).rule).toBe("default");
});

test("machine-wide payload scans skip unrelated old stores but explicit team addresses refuse", () => {
  const old = fixture(), healthy = fixture(), local = fixture();
  const index = join(local.root, "index"), indexPath = join(index, "global-registry.json");
  mkdirSync(index);
  new Bus(healthy.canonical).ensureDirs();
  new Bus(local.canonical).ensureDirs();
  writeFileSync(join(old.legacy, "registry.json"), "retained evidence");
  const teams: Record<string, unknown> = {};
  for (const [name, f] of [["a-old", old], ["healthy", healthy]] as const) {
    const acting = join(f.root, "acting.json");
    writeFileSync(acting, JSON.stringify({ schema: "0.20", team: { name }, seats: {} }));
    teams[name] = { root: f.root, registry_location: acting, state: "registered" };
  }
  writeFileSync(indexPath, JSON.stringify({ schema: "0.20", teams }));
  const id = "sender-20260905T130000Z-012345abcdef", payload = join(healthy.canonical, "payloads", id + ".md");
  writeFileSync(payload, "healthy payload");
  expect(resolvePayloadById(id, index)).toEqual({ kind: "one", path: realpathSync(payload) });
  for (const mode of ["show", "read-recipient", "payloads"] as const) {
    expect(resolvePayloadAddress(id, healthy.canonical, indexPath, mode).status).toBe("found");
    expect(resolvePayloadAddress("missing-id", healthy.canonical, indexPath, mode).status).toBe("missing");
    expect(() => resolvePayloadAddress("a-old/" + id, healthy.canonical, indexPath, mode)).toThrow("old_store");
  }
  const parkedId = "sender-20260905T130001Z-012345abcdee", parked = join(healthy.canonical, "spool", parkedId + ".md");
  mkdirSync(join(healthy.canonical, "spool"));
  writeFileSync(parked, "healthy parked payload");
  writeFileSync(join(healthy.canonical, "spool", parkedId + ".meta.json"), JSON.stringify({ target: "reader" }));
  expect(resolvePayloadAddress("", local.canonical, indexPath, "read-recipient", parked, "reader"))
    .toEqual({ status: "found", path: realpathSync(parked), team: "healthy", residency: "spool" });
  expect(existsSync(old.canonical)).toBe(false);
  expect(readFileSync(join(old.legacy, "registry.json"), "utf8")).toBe("retained evidence");
});
