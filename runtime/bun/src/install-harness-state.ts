// Which harness homes the installer wires (tap-gjwtw). A home is wired only when
// its command is on PATH or its hooks file already exists (an existing file means
// someone set that harness up). A bare home with neither is "present, not wired"
// and every writer leaves it untouched: install.sh's hooks and plugins, the skill
// linker, and setup's machine-wide reconcile all ask this one module.
//
//   install-harness-state.ts <key>=<home> ...   prints "key<TAB>label<TAB>state<TAB>reason"
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export type HarnessState = "absent" | "present-not-wired" | "will-wire" | "already-wired";
export interface HarnessProbe { key: string; label: string; state: HarnessState; reason: string }

interface Harness {
  label: string;
  /** The command whose presence on PATH means the person has this harness. */
  command: string;
  /** Files, relative to the home, that exist once someone has set the harness up. */
  evidence: string[];
  /** Text TAP's own entry carries in an evidence file; empty means the file is TAP's. */
  marker: string;
}

export const HARNESSES: Record<string, Harness> = {
  claude: { label: "Claude", command: "claude", evidence: ["settings.json"], marker: "tap-advisory.sh" },
  codex: { label: "Codex", command: "codex", evidence: ["config.toml", "hooks.json"], marker: "tap-codex-session-start" },
  cursor: { label: "Cursor hooks", command: "cursor-agent", evidence: ["hooks.json"], marker: "tap-cursor-session-start" },
  opencode: { label: "OpenCode", command: "opencode", evidence: ["plugins/tap-opencode-session-start.ts"], marker: "" },
  gemini: { label: "Antigravity", command: "agy", evidence: ["config/hooks.json"], marker: "tap-shell-body-guard" },
  hermes: { label: "Hermes", command: "hermes", evidence: [], marker: "" },
  cursoragent: { label: "Cursor-agent skills", command: "cursor-agent", evidence: [], marker: "" },
};

/** The skill linker's label for each harness it links; Cursor's hooks have no skill home. */
export const SKILL_LABEL_KEYS: Record<string, string> = {
  Claude: "claude", Codex: "codex", Hermes: "hermes", OpenCode: "opencode", Antigravity: "gemini", "Cursor-agent": "cursoragent",
};

function onPath(command: string, path: string): boolean {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    try { accessSync(join(dir, command), constants.X_OK); if (statSync(join(dir, command)).isFile()) return true; } catch { /* next dir */ }
  }
  return false;
}

const fileHas = (file: string, marker: string): boolean => {
  try { return readFileSync(file, "utf8").includes(marker); } catch { return false; }
};

export function probeHarness(key: string, home: string, path = process.env.PATH ?? ""): HarnessProbe {
  const h = HARNESSES[key];
  if (!h) throw new Error(`unknown harness '${key}'`);
  const base = { key, label: h.label };
  let isDir = false;
  try { isDir = statSync(home).isDirectory(); } catch { /* absent */ }
  if (!isDir) return { ...base, state: "absent", reason: `${home} does not exist` };
  const present = h.evidence.map(rel => join(home, rel)).filter(file => existsSync(file) && statSync(file).isFile());
  if (present.some(file => !h.marker || fileHas(file, h.marker))) return { ...base, state: "already-wired", reason: "" };
  if (onPath(h.command, path)) return { ...base, state: "will-wire", reason: `${h.command} is on PATH` };
  if (present.length) return { ...base, state: "will-wire", reason: "its hooks file exists" };
  return { ...base, state: "present-not-wired", reason: `${h.command} not installed; install it, then run ./install.sh --sync` };
}

/** Whether the writers may touch this home. A missing home is left to each writer's own absent handling. */
export const wiresHome = (probe: HarnessProbe): boolean => probe.state !== "present-not-wired";

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (!args.length) throw new Error("expected <key>=<home> ...");
    for (const arg of args) {
      const at = arg.indexOf("=");
      if (at < 1) throw new Error(`expected <key>=<home>, got '${arg}'`);
      const p = probeHarness(arg.slice(0, at), arg.slice(at + 1));
      console.log([p.key, p.label, p.state, p.reason].join("\t"));
    }
  } catch (error) { console.error(`install-harness-state: ${error}`); process.exitCode = 1; }
}
