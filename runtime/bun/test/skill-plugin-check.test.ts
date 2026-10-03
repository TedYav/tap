import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
