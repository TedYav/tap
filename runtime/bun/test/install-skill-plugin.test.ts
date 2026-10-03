import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { installSkillPlugin, removeSkillPlugin, RETAINED_LISTING, TAP_MARKETPLACE, TAP_PLUGIN, type PluginCommand, type PluginHost } from "../src/install-skill-plugin";
import { aliasBody, PUBLIC_SKILLS } from "../src/skill-policy";
import { installSkillLinks } from "../src/install-skill-links";
import { generateSkillPlugin } from "../src/skill-plugin";
import { fakePluginClis } from "./support/native-plugins";
const original = { ...process.env }, roots: string[] = [];
afterEach(() => { process.env = { ...original }; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const repo = resolve(import.meta.dir, "../../..");

function fixture(host: PluginHost) {
  const root = realpathSync(mkdtempSync(join(process.env.TAP_INDEX_HOME!, "plugin-"))); roots.push(root);
  const home = join(root, "home"); mkdirSync(home);
  const manifest = join(root, "manifest.json"); process.env.TAP_INSTALL_MANIFEST = manifest;
  const calls: string[][] = [];
  const data = { source: undefined as string | undefined, cachedSource: undefined as string | undefined, installed: false, enabled: true, foreign: false, failInstall: false, failMarketAdd: false, undeclared: false, listedElsewhere: false, failRemove: false };
  const run: PluginCommand = (actualHost, actualHome, args) => {
    expect(actualHost).toBe(host); expect(actualHome).toBe(home); calls.push(args);
    if (args.join(" ") === "marketplace list") {
      const rows = data.source ? [{ name: TAP_MARKETPLACE, source: "directory", path: data.source, marketplaceSource: { sourceType: "local", source: data.source } }] : [];
      return host === "claude" ? rows : { marketplaces: rows };
    }
    if (args[0] === "list") {
      const rows = data.installed && (host === "claude" || data.source) ? [{ id: TAP_PLUGIN, pluginId: TAP_PLUGIN, scope: "user", enabled: data.enabled }] : [];
      if (data.foreign) rows.push({ id: `other@${TAP_MARKETPLACE}`, pluginId: `other@${TAP_MARKETPLACE}`, scope: "user", enabled: true });
      return host === "claude" ? rows : { installed: rows };
    }
    if (args[0] === "marketplace" && args[1] === "add") {
      if (data.failMarketAdd) throw new Error("fixture marketplace add failure");
      const target = host === "codex" ? realpathSync(args[2]!) : args[2];
      if (data.source && data.source !== target) throw new Error("already added from a different source");
      data.source = target;
    }
    else if (args[0] === "marketplace" && args[1] === "remove") {
      if (data.failRemove) throw new Error("fixture remove failure");
      // Claude's --scope user consumes the user-scope declaration and then refuses; the listing is Claude's.
      if (data.undeclared) throw new Error("claude plugin marketplace remove failed: ✘ Marketplace 'tap-marketplace' is not declared in user settings. Omit --scope to remove it from all scopes.");
      if (host === "claude") data.undeclared = true;
      if (!data.listedElsewhere) data.source = undefined;
    }
    else if (["add", "install", "update"].includes(args[0]!)) {
      if (data.failInstall) throw new Error("fixture install failure");
      data.installed = true; data.cachedSource = data.source;
      if (args[0] !== "update") data.enabled = true;
    }
    else if (["remove", "uninstall"].includes(args[0]!)) data.installed = false;
    else throw new Error(`unexpected command ${args}`);
    return {};
  };
  const entries = () => JSON.parse(readFileSync(manifest, "utf8")).entries;
  const install = (source = repo) => installSkillPlugin(source, host, home, () => {}, run);
  return { root, data, calls, run, entries, install, home, manifest };
}

test("plugin contains exactly the public inventory with unchanged discovery metadata", () => {
  expect(generateSkillPlugin(repo), "Run cd runtime/bun && bun run skills:generate").toEqual([]);
  expect(readdirSync(join(repo, "plugins/tap/skills")).sort()).toEqual([...PUBLIC_SKILLS].sort());
  for (const name of PUBLIC_SKILLS) {
    expect(readFileSync(join(repo, "plugins/tap/skills", name, "SKILL.md"), "utf8"))
      .toBe(aliasBody(name, name, readFileSync(join(repo, "skills", name, "SKILL.md"), "utf8")));
    expect(existsSync(join(repo, ".claude/skills", name === "tap" ? name : `tap-${name}`))).toBe(false);
  }
  expect(existsSync(join(repo, "plugins/tap/hooks"))).toBe(false);
  expect(existsSync(join(repo, "plugins/tap/bin"))).toBe(false);
  const market = JSON.parse(readFileSync(join(repo, ".claude-plugin/marketplace.json"), "utf8"));
  expect(market.plugins).toHaveLength(1); expect(market.plugins[0].source).toBe("./plugins/tap");
});

test("a failed native migration repairs only owned old entrypoints, then retires them after success", () => {
  const f = fixture("claude"), bin = join(f.root, "bin"), skills = join(f.home, "skills");
  fakePluginClis(bin); process.env.PATH = bin + ":" + process.env.PATH; mkdirSync(skills);
  const entries = ["lead", "tap-lead"].map(name => ({ kind: "symlink", path: join(skills, name), target: join(repo, "skills", `tap-lead`) }));
  for (const entry of entries) symlinkSync(entry.target, entry.path);
  symlinkSync("/personal/drive", join(skills, "drive"));
  writeFileSync(f.manifest, JSON.stringify({ version: 1, entries }));
  const registry = join(f.home, ".native-plugin-fixture.json");
  writeFileSync(registry, JSON.stringify({ markets: { [TAP_MARKETPLACE]: "/foreign" }, plugins: {} }));
  expect(installSkillLinks(repo, "Claude", f.home, true, () => {})).toMatchObject({ ok: false, code: "PLUGIN" });
  expect(readdirSync(skills).sort()).toEqual(["drive", "lead", "tap-lead"]);
  for (const entry of entries) expect(readFileSync(join(entry.path, "SKILL.md"), "utf8")).toContain("tap help skill lead");
  // The user resolves the marketplace conflict. Native registration now replaces the repaired names.
  rmSync(registry);
  expect(installSkillLinks(repo, "Claude", f.home, true, () => {})).toEqual({ ok: true });
  for (const entry of entries) expect(lstatSync(entry.path, { throwIfNoEntry: false })).toBeUndefined();
  expect(lstatSync(join(skills, "drive")).isSymbolicLink()).toBe(true);
  expect(f.entries().filter((e: any) => e.kind === "native-plugin")).toHaveLength(1);
});

test("claude: a user-scope declaration already consumed counts as removed; other failures are preserved", () => {
  const f = fixture("claude"); f.install(); const market = f.entries().find((e: any) => e.kind === "native-marketplace");
  f.data.installed = false; f.data.undeclared = true; f.data.listedElsewhere = true;
  expect(removeSkillPlugin(market, false, f.run)).toStartWith("removed TAP's user-scope registration");
  f.data.undeclared = false; f.data.failRemove = true;
  expect(removeSkillPlugin(market, false, f.run)).toBe("preserved plugin registration (fixture remove failure)");
});

for (const host of ["claude", "codex"] as const) {
  test(`${host}: registration is recorded, repeat is idempotent, removal checks ownership`, () => {
    const f = fixture(host); f.install(); f.install();
    expect(f.entries()).toHaveLength(2);
    const plugin = f.entries().find((e: any) => e.kind === "native-plugin"), market = f.entries().find((e: any) => e.kind === "native-marketplace");
    expect(removeSkillPlugin(plugin, true, f.run)).toBe("removed"); expect(f.data.installed).toBe(true);
    expect(removeSkillPlugin(market, true, f.run, new Set([plugin.path]))).toBe("removed");
    expect(removeSkillPlugin(plugin, false, f.run)).toBe("removed"); expect(f.data.installed).toBe(false);
    expect(removeSkillPlugin(market, false, f.run)).toBe("removed"); expect(f.data.source).toBeUndefined();
  });
  test(`${host}: foreign marketplace is refused before any write`, () => {
    const f = fixture(host); f.data.source = "/foreign";
    expect(f.install).toThrow("another source"); expect(existsSync(f.manifest)).toBe(false);
    expect(f.calls).toEqual([["marketplace", "list"], ["list"]]);
  });
  test(`${host}: existing registration is not adopted and disabled state is preserved`, () => {
    const f = fixture(host); f.data.source = repo; f.data.installed = true; f.data.enabled = false;
    f.install(); expect(existsSync(f.manifest)).toBe(false); expect(f.data.enabled).toBe(false);
    expect(f.calls.every(args => args.includes("list"))).toBe(true);
  });
  test(`${host}: failure retains the journal for partial native effects`, () => {
    const f = fixture(host); f.data.failInstall = true;
    expect(f.install).toThrow("fixture install failure"); expect(f.entries()).toHaveLength(2);
    expect(f.data.source).toBe(repo); expect(f.data.installed).toBe(false);
    f.data.failInstall = false; f.install(); expect(f.entries()).toHaveLength(2);
  });
  test(`${host}: uninstall preserves a changed source and unrelated plugins`, () => {
    const f = fixture(host); f.install(); const entries = f.entries();
    f.data.source = "/foreign";
    for (const entry of entries) expect(removeSkillPlugin(entry, false, f.run)).toBe("preserved changed plugin source");
    f.data.source = repo; f.data.installed = false; f.data.foreign = true;
    expect(removeSkillPlugin(entries.find((e: any) => e.kind === "native-marketplace"), false, f.run)).toBe("preserved marketplace with installed plugins");
  });
  test(`${host}: marketplace removal is scoped to the user, and an unconfirmed removal is still preserved`, () => {
    const f = fixture(host); f.install(); const market = f.entries().find((e: any) => e.kind === "native-marketplace");
    f.data.installed = false; f.data.listedElsewhere = true;
    expect(removeSkillPlugin(market, false, f.run)).toBe(host === "claude"
      ? RETAINED_LISTING : "preserved unconfirmed plugin removal");
    expect(f.calls.filter(a => a[0] === "marketplace" && a[1] === "remove")).toEqual([["marketplace", "remove", TAP_MARKETPLACE, ...(host === "claude" ? ["--scope", "user"] : [])]]);
    expect(f.data.source).toBe(repo);
  });
  test(`${host}: a cached plugin with no marketplace retains its ownership record`, () => {
    const f = fixture(host); f.install(); f.data.source = undefined;
    const before = readFileSync(f.manifest, "utf8");
    expect(removeSkillPlugin(f.entries().find((e: any) => e.kind === "native-plugin"), false, f.run)).toBe("preserved plugin with missing marketplace source");
    if (host === "claude") {
      expect(f.install).toThrow("has no marketplace source"); expect(readFileSync(f.manifest, "utf8")).toBe(before);
    } else {
      f.data.enabled = false;
      f.install(); expect(f.data).toMatchObject({ source: repo, enabled: false });
    }
    expect(f.data.installed).toBe(true);
  });
}

for (const enabled of [true, false]) test(`Codex release upgrade relocates an owned source; enabled=${enabled}`, () => {
  const f = fixture("codex"), v1 = join(f.root, "v1"), v2 = join(f.root, "v2"), current = join(f.root, "current");
  mkdirSync(v1); mkdirSync(v2); symlinkSync(v1, current);
  f.install(current); f.data.enabled = enabled;
  expect(f.data.source).toBe(v1); expect(f.data.cachedSource).toBe(v1);
  unlinkSync(current); symlinkSync(v2, current);
  f.install(current);
  expect(f.data.source).toBe(v2); expect(f.data.enabled).toBe(enabled);
  expect(f.data.cachedSource).toBe(enabled ? v2 : v1);
  for (const entry of f.entries()) { expect(entry.source).toBe(current); expect(entry.nativeSource).toBe(v2); expect(entry.pendingSource).toBeUndefined(); }
  expect(removeSkillPlugin(f.entries().find((e: any) => e.kind === "native-plugin"), false, f.run)).toBe("removed");
});

test("Codex retries interrupted relocation without re-enabling a hidden disabled plugin", () => {
  const f = fixture("codex"), v1 = join(f.root, "v1"), v2 = join(f.root, "v2"), current = join(f.root, "current");
  mkdirSync(v1); mkdirSync(v2); symlinkSync(v1, current); f.install(current); f.data.enabled = false;
  unlinkSync(current); symlinkSync(v2, current); f.data.failMarketAdd = true;
  expect(() => f.install(current)).toThrow("fixture marketplace add failure");
  expect(f.data.source).toBeUndefined(); expect(f.entries().every((e: any) => e.nativeSource === v1 && e.pendingSource === v2)).toBe(true);
  f.data.failMarketAdd = false; f.install(current);
  expect(f.data.source).toBe(v2); expect(f.data.enabled).toBe(false); expect(f.data.cachedSource).toBe(v1);
});

test("a release path and a stale journal never authorize relocating a foreign source", () => {
  const f = fixture("codex"), v1 = join(f.root, "v1"), v2 = join(f.root, "v2"), foreign = join(f.root, "foreign"), current = join(f.root, "current");
  for (const path of [v1, v2, foreign]) mkdirSync(path);
  symlinkSync(v1, current); f.install(current); unlinkSync(current); symlinkSync(v2, current);
  f.data.source = foreign; const before = readFileSync(f.manifest, "utf8");
  expect(() => f.install(current)).toThrow("another source"); expect(f.data.source).toBe(foreign);
  expect(readFileSync(f.manifest, "utf8")).toBe(before);
});
