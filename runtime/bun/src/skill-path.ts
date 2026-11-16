import { PUBLIC_SKILLS, canonicalSkillName } from "./skill-policy";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const SHIPPED = `TAP skills: ${PUBLIC_SKILLS.join(", ")}`;

// Resolve one skill through explicit roots, without directory discovery.
function resolveSkill(argv: string[], skillsRoot: string): number {
  const requested = argv[0];
  const name = requested && canonicalSkillName(requested);
  if (argv.length !== 1 || !name || !/^[A-Za-z0-9]/.test(name) || /[^A-Za-z0-9_-]/.test(name)) {
    console.error(`tap help skill: expected one simple skill name; ${SHIPPED}`);
    return 2;
  }
  const home = process.env.HOME === "" ? "/" : homedir();
  const roots = [skillsRoot, resolve(skillsRoot, "../compat/skills"), join(home, ".agents/skills"), join(home, ".claude/skills"), join(home, ".codex/skills")];
  for (const root of roots) {
    const candidate = join(root, name, "SKILL.md");
    try {
      if (!statSync(candidate).isFile()) continue;
    } catch (error) {
      // Keep Python 3.11's missing-path cases. Unlike Python 3.14 is_file,
      // permission and I/O errors must not select a lower-priority skill.
      if (["ENOENT", "ENOTDIR", "EBADF", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
    console.log(realpathSync(candidate));
    return 0;
  }
  console.error(`tap help skill: no SKILL.md for ${name} in ${roots.join(", ")}; ${SHIPPED}`);
  return 1;
}

/**
 * `tap help skill <name>`: read-only help, before any bus initialization.
 * `scriptsDir` is the router's located skills/tap/scripts: a compiled router's
 * import.meta.path is its bundle, which is nowhere near the checkout's skills.
 */
export function cmdHelpSkill(argv: string[], scriptsDir: string): number {
  try {
    return resolveSkill(argv, realpathSync(resolve(scriptsDir, "../..")));
  } catch (error) {
    console.error(`tap help skill: ${error}`);
    return 1;
  }
}
