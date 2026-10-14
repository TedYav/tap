import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The commands install-harness-state.ts looks for; a skill home is linked only when its command is on PATH. */
export const HARNESS_COMMANDS = ["claude", "codex", "cursor-agent", "agy", "opencode", "hermes"];

/**
 * Put inert executables for the harness commands into `directory` so a fixture that seeds harness
 * homes does not depend on which harness CLIs the machine running it has installed. A command that
 * already exists there (a recording codex, a native-plugin fake) is kept.
 */
export function stubHarnessCommands(directory: string, commands = HARNESS_COMMANDS): string {
  mkdirSync(directory, { recursive: true });
  for (const command of commands) {
    const file = join(directory, command);
    if (!existsSync(file)) writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  return directory;
}
