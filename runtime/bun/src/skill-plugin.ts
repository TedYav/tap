import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { aliasBody, CODEX_AGENTS_FILE, codexAgentsBody, PUBLIC_SKILLS } from "./skill-policy";

/** The plugin carries discovery metadata; canonical instructions stay beside the CLI. */
export function generateSkillPlugin(repo: string, check = true): string[] {
  const root = join(repo, "plugins/tap/skills");
  const differences: string[] = [];
  for (const name of existsSync(root) ? readdirSync(root) : []) {
    if (!PUBLIC_SKILLS.includes(name)) differences.push(`unexpected plugin skill: ${name}`);
  }
  if (differences.length && !check) throw new Error(`${differences.join("; ")}; remove retired generated entries before regenerating`);
  for (const name of PUBLIC_SKILLS) {
    const source = readFileSync(join(repo, "skills", name, "SKILL.md"), "utf8");
    // Each generated file and its expected bytes; undefined means the file must be absent.
    const files: [string, string | undefined][] = [
      ["SKILL.md", aliasBody(name, name, source)],
      [CODEX_AGENTS_FILE, codexAgentsBody(source)],
    ];
    for (const [relative, bytes] of files) {
      const file = join(root, name, relative);
      const links = [root, join(root, name), dirname(file), file].filter(path => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink());
      if (links.length) {
        if (!check) throw new Error(`refusing generated symlink: ${links[0]}`);
        differences.push(`generated symlink: ${links[0]}`); continue;
      }
      const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
      if (current === bytes) continue;
      if (check) differences.push(relative === "SKILL.md" ? `stale plugin skill: ${name}` : `stale plugin ${relative}: ${name}`);
      else if (bytes === undefined) rmSync(file);
      else {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, bytes);
      }
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
