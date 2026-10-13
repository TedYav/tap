import { afterEach, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { editFolderTrust, folderTrustTargets, trustFolder } from "../src/folder-trust";
import { removeScratchTree } from "./support/scratch";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeScratchTree(root); });
function fixture() {
  if (!process.env.TMUX_TMPDIR) throw new Error("use runtime/bun/test/run.sh");
  const home = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR, "folder-trust-"))); roots.push(home);
  const folder = join(home, 'Workspace space.雪"quote'); mkdirSync(folder);
  return { home, folder };
}

test("Codex changes exactly project trust while preserving comments, hooks and permissions", () => {
  const { folder } = fixture();
  for (const source of [
    '# keep this comment\napproval_policy = "on-request"\n[hooks.state.my_hook]\ntrusted_hash = "unchanged"\n',
    `[projects.${JSON.stringify(folder)}]\ntrust_level = "untrusted" # keep trust comment\nmodel = "keep"\n`,
    '[projects]\n# parent table\n',
  ]) {
    const before = Bun.TOML.parse(source) as any;
    const output = editFolderTrust(source, folder, "codex");
    const after = Bun.TOML.parse(output) as any;
    expect(after.projects[folder].trust_level).toBe("trusted");
    const expected = { ...before, projects: { ...before.projects, [folder]: { ...before.projects?.[folder], trust_level: "trusted" } } };
    expect(after).toEqual(expected);
    for (const comment of source.match(/#[^\n]*/g) ?? []) expect(output).toContain(comment);
    expect(editFolderTrust(output, folder, "codex")).toBe(output);
  }
});

test("Claude and Antigravity update folder records without altering hooks or tool policy", () => {
  const { folder } = fixture();
  const doc = { projects: { unrelated: { hasTrustDialogAccepted: false }, [folder]: { allowedTools: ["keep"], hasTrustDialogAccepted: false } }, trustedWorkspaces: ["/other"], hooks: { trust: false }, permissions: { mode: "ask" }, auth: { opaque: "preserve" } };
  for (const format of ["claude", "agy"] as const) {
    const original = JSON.stringify(doc);
    const edited = editFolderTrust(original, folder, format);
    const result = JSON.parse(edited);
    expect(result.hooks).toEqual(doc.hooks);
    expect(result.permissions).toEqual(doc.permissions);
    expect(result.auth).toEqual(doc.auth);
    if (format === "claude") {
      expect(result.projects[folder]).toEqual({ ...doc.projects[folder], hasTrustDialogAccepted: true });
      expect(result.projects.unrelated).toEqual(doc.projects.unrelated);
      expect(result.trustedWorkspaces).toEqual(doc.trustedWorkspaces);
    } else {
      expect(result.trustedWorkspaces).toEqual(["/other", folder]);
      expect(result.projects).toEqual(doc.projects);
    }
    expect(editFolderTrust(edited, folder, format)).toBe(edited);
  }
});

test("Cursor uses its native marker and refuses another path at the same slug", () => {
  const { home, folder } = fixture();
  const { targets } = folderTrustTargets(folder, { HOME: home, CURSOR_DATA_DIR: join(home, "cursor-data") }, command => command === "cursor-agent");
  expect(targets).toHaveLength(1);
  expect(targets[0]!.path).toBe(join(home, "cursor-data/projects", folder.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, ""), ".workspace-trusted"));
  const edited = editFolderTrust("", folder, "cursor");
  expect(JSON.parse(edited)).toMatchObject({ workspacePath: folder, trustMethod: "cli-flag" });
  expect(editFolderTrust(edited, folder, "cursor")).toBe(edited);
  expect(() => editFolderTrust(edited, folder + "other", "cursor")).toThrow("does not name");
});

test("native JSON keeps unrelated numeric tokens exact", () => {
  const { folder } = fixture();
  for (const format of ["claude", "agy"] as const) {
    const output = editFolderTrust('{"wide":9007199254740993,"precise":0.1234567890123456789,"huge":1e400}', folder, format);
    expect(output).toContain('"wide": 9007199254740993');
    expect(output).toContain('"precise": 0.1234567890123456789');
    expect(output).toContain('"huge": 1e400');
  }
  expect(() => editFolderTrust('{"projects":1}', folder, "claude")).toThrow("not an object");
});

test("native config symlinks keep their backing file and broken links refuse", () => {
  const { home, folder } = fixture();
  const path = join(home, "config-link"), backing = join(home, "backing");
  const target = { harness: "Claude", format: "claude" as const, path };
  symlinkSync(backing, path);
  expect(trustFolder(folder, [target])[0]!.status).toBe("failed");
  expect(lstatSync(path).isSymbolicLink()).toBe(true);
  writeFileSync(backing, "{}");
  expect(trustFolder(folder, [target])[0]!.status).toBe("trusted");
  expect(lstatSync(path).isSymbolicLink()).toBe(true);
  expect(JSON.parse(readFileSync(backing, "utf8")).projects[folder].hasTrustDialogAccepted).toBe(true);
});

test("target discovery honors native home overrides and does not widen into skills or hooks", () => {
  const { home, folder } = fixture();
  const env = { HOME: home, CODEX_HOME: join(home, "codex-custom"), CLAUDE_CONFIG_DIR: join(home, "claude-custom") };
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude/.config.json"), "{}");
  const { targets } = folderTrustTargets(folder, env, () => true);
  expect(targets.map(t => t.format)).toEqual(["codex", "agy", "claude", "cursor"]);
  expect(targets[0]!.path).toBe(join(env.CODEX_HOME, "config.toml"));
  expect(targets[2]!.path).toBe(join(env.CLAUDE_CONFIG_DIR, ".claude.json"));
  mkdirSync(env.CLAUDE_CONFIG_DIR);
  writeFileSync(join(env.CLAUDE_CONFIG_DIR, ".config.json"), "{}");
  expect(folderTrustTargets(folder, env, command => command === "claude").targets[0]!.path).toBe(join(env.CLAUDE_CONFIG_DIR, ".config.json"));
  expect(folderTrustTargets(folder, env, () => false)).toEqual({ targets: [], failures: [] });
  const partial = folderTrustTargets(folder, { HOME: home, CODEX_HOME: "relative" }, () => true);
  expect(partial.targets.map(target => target.harness)).toEqual(["Antigravity", "Claude", "Cursor"]);
  expect(partial.failures).toEqual([{ harness: "Codex", status: "failed", detail: "CODEX_HOME must be an absolute path" }]);
});

test("persistent writes are idempotent and malformed stores remain byte-identical", () => {
  const { home, folder } = fixture();
  const { targets } = folderTrustTargets(folder, { HOME: home }, () => true);
  expect(trustFolder(folder, targets).map(r => r.status)).toEqual(["trusted", "trusted", "trusted", "trusted"]);
  const before = targets.map(t => readFileSync(t.path));
  expect(trustFolder(folder, targets).map(r => r.status)).toEqual(["already_trusted", "already_trusted", "already_trusted", "already_trusted"]);
  expect(targets.map(t => readFileSync(t.path))).toEqual(before);
  expect(statSync(targets[0]!.path).mode & 0o777).toBe(0o600);
  for (const target of targets) {
    writeFileSync(target.path, "{bad");
    expect(trustFolder(folder, [target])[0]!.status).toBe("failed");
    expect(readFileSync(target.path, "utf8")).toBe("{bad");
  }
  for (const [format, source] of [["claude", '{"projects":[]}'], ["agy", '{"trustedWorkspaces":{}}'], ["codex", 'projects = "bad"']] as const) {
    expect(() => editFolderTrust(source, folder, format)).toThrow();
  }
});
