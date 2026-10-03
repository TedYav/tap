import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { aliasBody, PUBLIC_SKILLS } from "./skill-policy";

/** The plugin carries discovery metadata; canonical instructions stay beside the CLI. */
export function generateSkillPlugin(repo: string, check = true): string[] {
  const root = join(repo, "plugins/tap/skills");
  const differences: string[] = [];
  for (const name of existsSync(root) ? readdirSync(root) : []) {
    if (!PUBLIC_SKILLS.includes(name)) differences.push(`unexpected plugin skill: ${name}`);
  }
  if (differences.length && !check) throw new Error(`${differences.join("; ")}; remove retired generated entries before regenerating`);
  for (const name of PUBLIC_SKILLS) {
    const file = join(root, name, "SKILL.md");
    const links = [root, join(root, name), file].filter(path => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink());
    if (links.length) {
      if (!check) throw new Error(`refusing generated symlink: ${links[0]}`);
      differences.push(`generated symlink: ${links[0]}`); continue;
    }
    const bytes = aliasBody(name, name, readFileSync(join(repo, "skills", name, "SKILL.md"), "utf8"));
    if (existsSync(file) && readFileSync(file, "utf8") === bytes) continue;
    if (check) differences.push(`stale plugin skill: ${name}`);
    else {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(file, bytes);
    }
  }
  return differences;
}
if (import.meta.main) {
  try {
    if (process.argv.slice(2).some(arg => arg !== "--check")) throw new Error("usage: bun run skills:generate [--check]");
    const differences = generateSkillPlugin(resolve(import.meta.dir, "../../.."), process.argv.includes("--check"));
    if (differences.length) throw new Error(`${differences.join("\n")}\nRun: cd runtime/bun && bun run skills:generate`);
    console.log(`plugin skills: ${PUBLIC_SKILLS.length} ${process.argv.includes("--check") ? "checked" : "generated"}`);
  } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
