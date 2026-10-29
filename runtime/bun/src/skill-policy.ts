import { homedir } from "node:os";
import { configDirectory, readCatalog, table } from "./config-file";
import { LauncherError } from "./config-error";
import { join } from "node:path";

/** One inventory for installation, setup, coverage and generated compatibility wrappers. */
export const CORE_SKILLS = ["tap", "in", "send", "escalate", "config-wizard", "help", "extend"];
export const OPTIONAL_SKILLS = ["lead", "drive", "conduct", "choreography", "collab", "discuss", "pair", "adapt", "self", "context", "out", "assign", "reply", "outstanding", "team", "ask", "crew", "calibrate-gc", "harness-operator"];
export const REPO_LOCAL_SKILLS = ["coach", "abandon-branch"];
/** Lookup-only explanations, never linked into a harness discovery root. */
export const TOMBSTONE_SKILLS = ["tap-double-check", "tap-coach", "tap-abandon-branch"];
export const RETIRED_SKILLS = ["execute", "lieutenant", "tap-done", "double-check", ...TOMBSTONE_SKILLS];
/** Older lookup names remain usable through `tap help skill`; never discoverable aliases. */
export const SKILL_ALIASES: Record<string, string> = {
  conductor: "conduct", "using-tap": "tap", "tap-config": "config-wizard",
};
export const PUBLIC_SKILLS = [...CORE_SKILLS, ...OPTIONAL_SKILLS];
export const flatSkillName = (name: string) => name === "tap" ? "tap" : `tap-${name}`;
export const LEGACY_SKILL_NAMES = [...new Set([...PUBLIC_SKILLS, ...PUBLIC_SKILLS.map(flatSkillName), ...Object.keys(SKILL_ALIASES)])];
export function canonicalSkillName(requested: string): string {
  const plain = requested.startsWith("tap:") ? requested.slice(4) : requested;
  const short = plain.startsWith("tap-") ? plain.slice(4) : plain;
  return SKILL_ALIASES[plain] || (PUBLIC_SKILLS.includes(short) ? short : plain);
}
export const SKILL_HOMES: Record<string, [string,string]> = {
  CLAUDE_HOME: ["Claude", ".claude"], CODEX_HOME: ["Codex", ".codex"], HERMES_HOME: ["Hermes", ".hermes"],
  OPENCODE_HOME: ["OpenCode", ".config/opencode"], GEMINI_HOME: ["Antigravity", ".gemini"],
  CURSOR_AGENT_HOME: ["Cursor-agent", ".config/agents"], AGENTS_HOME: ["shared agents", ".agents"],
};
export const skillManifestPath = () => process.env.TAP_INSTALL_MANIFEST || join(process.env.TAP_INDEX_HOME || join(homedir(), ".tap"), "install-manifest.json");
export const aliasDirectory = (manifestPath: string, name: string) => join(manifestPath, "..", "skill-aliases", name);
/** Keep discovery and invocation metadata identical to the canonical skill. */
export function aliasBody(name: string, canonical: string, source: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match || !/^name: .+$/m.test(match[1]!)) throw new Error(`missing skill frontmatter: ${canonical}`);
  const metadata = match[1]!.replace(/^name: .+$/m, `name: ${name}`);
  return `---\n${metadata}\n---\n\nRun \`tap help skill ${canonical}\`, then read the returned SKILL.md and follow it for the original task and arguments. Resolve all relative references from that canonical file's directory, never from this wrapper.\n`;
}
/** Codex has no frontmatter switch for user-only skills; its per-skill agents manifest carries one. */
export const CODEX_AGENTS_FILE = "agents/openai.yaml";
export function codexAgentsBody(source: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  return match && /^disable-model-invocation: true$/m.test(match[1]!) ? "policy:\n  allow_implicit_invocation: false\n" : undefined;
}
export function savedFullKit(config?: Record<string, any>): boolean | undefined {
  if (config === undefined) {
    try { config = readCatalog(join(configDirectory(process.env),"config.toml")).data; }
    catch (error) {
      if (error instanceof LauncherError && error.errorClass === "preset_config_missing" && error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  if (!table(config)) throw new Error("machine config must be a table");
  if (config.skills !== undefined && !table(config.skills)) throw new Error("skills must be a table");
  const value = config?.skills?.full_kit;
  if (value !== undefined && typeof value !== "boolean") throw new Error("skills.full_kit must be a boolean");
  return value;
}
if (import.meta.main) {
  if (process.argv[2] !== "classifications") throw new Error("expected classifications");
  for (const [key, values] of Object.entries({CORE_SKILLS, OPTIONAL_SKILLS, REPO_LOCAL_SKILLS, RETIRED_SKILLS, TOMBSTONE_SKILLS})) console.log(`${key}=(${values.join(" ")})`);
}
