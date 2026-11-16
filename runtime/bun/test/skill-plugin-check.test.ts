import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSkillPlugin } from "../src/skill-plugin";
import { PUBLIC_SKILLS } from "../src/skill-policy";

// `bun run skills:check` is the wiring doc's self-check; these are the cases it must detect.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "tap-skill-plugin-")); roots.push(root);
  for (const name of PUBLIC_SKILLS) {
    mkdirSync(join(root, "skills", name), { recursive: true });
    writeFileSync(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} fixture\n---\n\nBody of ${name}.\n`);
  }
  expect(generateSkillPlugin(root, false)).toEqual([]);
  return root;
}

test("a freshly generated plugin checks clean", () => {
  expect(generateSkillPlugin(repo(), true)).toEqual([]);
});

test("an entry for a skill that is not public is reported", () => {
  const root = repo();
  mkdirSync(join(root, "plugins/tap/skills/retired-skill"), { recursive: true });
  expect(generateSkillPlugin(root, true)).toEqual(["unexpected plugin skill: retired-skill"]);
  expect(() => generateSkillPlugin(root, false)).toThrow("remove retired generated entries");
});

test("an entry that no longer matches its source is reported as stale", () => {
  const root = repo(), name = PUBLIC_SKILLS[0]!;
  writeFileSync(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: changed after generation\n---\n\nBody.\n`);
  expect(generateSkillPlugin(root, true)).toEqual([`stale plugin skill: ${name}`]);
});

test("a generated symlink is reported and never written through", () => {
  const root = repo(), name = PUBLIC_SKILLS[0]!, file = join(root, "plugins/tap/skills", name, "SKILL.md");
  rmSync(file);
  symlinkSync(join(root, "skills", name, "SKILL.md"), file);
  expect(generateSkillPlugin(root, true)).toEqual([`generated symlink: ${file}`]);
  expect(() => generateSkillPlugin(root, false)).toThrow("refusing generated symlink");
});

test("a user-only skill also carries the Codex implicit-invocation policy, and losing the flag retires it", () => {
  const root = repo(), name = PUBLIC_SKILLS[0]!, source = join(root, "skills", name, "SKILL.md");
  const manifest = join(root, "plugins/tap/skills", name, "agents/openai.yaml");
  writeFileSync(source, `---\nname: ${name}\ndescription: user-only fixture\ndisable-model-invocation: true\n---\n\nBody.\n`);
  expect(generateSkillPlugin(root, true)).toEqual([`stale plugin skill: ${name}`, `stale plugin agents/openai.yaml: ${name}`]);
  expect(generateSkillPlugin(root, false)).toEqual([]);
  expect(readFileSync(manifest, "utf8")).toBe("policy:\n  allow_implicit_invocation: false\n");
  expect(readFileSync(join(root, "plugins/tap/skills", name, "SKILL.md"), "utf8")).toContain("disable-model-invocation: true");
  writeFileSync(source, `---\nname: ${name}\ndescription: model-invocable again\n---\n\nBody.\n`);
  expect(generateSkillPlugin(root, true)).toEqual([`stale plugin skill: ${name}`, `stale plugin agents/openai.yaml: ${name}`]);
  expect(generateSkillPlugin(root, false)).toEqual([]);
  expect(existsSync(manifest)).toBe(false);
});

test("a hand-written Codex manifest on a model-invocable skill is reported", () => {
  const root = repo(), name = PUBLIC_SKILLS[0]!;
  mkdirSync(join(root, "plugins/tap/skills", name, "agents"));
  writeFileSync(join(root, "plugins/tap/skills", name, "agents/openai.yaml"), "policy:\n  allow_implicit_invocation: false\n");
  expect(generateSkillPlugin(root, true)).toEqual([`stale plugin agents/openai.yaml: ${name}`]);
});

// A seat that received `/tap:self compact --model <other>` with answers and
// "then land the PR" did the work at once and never compacted: the wrapper
// let the trailing text read as a request of its own.
test("every wrapper puts the skill first and makes trailing text its input", () => {
  const repo = join(import.meta.dir, "../../..");
  for (const name of ["self", "context", "send"]) {
    const wrapper = readFileSync(join(repo, "plugins/tap/skills", name, "SKILL.md"), "utf8");
    expect(wrapper).toContain(`Before anything else, run \`tap help skill ${name}\``);
    expect(wrapper).toContain("do not act on any of it until its instructions say how and when");
  }
  const self = readFileSync(join(repo, "skills/self/SKILL.md"), "utf8");
  expect(self).toContain("## Text after compact or rebrief is for the seat that resumes");
  expect(self.indexOf("## Text after compact or rebrief")).toBeLessThan(self.indexOf("## Choose what survives"));
  // A second seat was told "model is fable for resume", then "TAP will switch
  // automatically", and ran the rebrief with no --model at all.
  expect(self).toContain("TAP switches the model only when the flag is on the");
});
