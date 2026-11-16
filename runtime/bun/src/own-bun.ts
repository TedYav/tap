// Every start of TAP's own code under Bun goes through here.
//
// Bun's default configuration path is "$PWD/bunfig.toml", whose `preload`
// scripts run before the entry file, and it loads "$PWD/.env". TAP's children
// inherit the directory the user or an agent is working in, so a child started
// as a bare `bun <entry>` would run a project's preload and take its variables.
// The flags are not inherited from the parent process: each start names TAP's
// own configuration (runtime/bun/tap-bunfig.toml) and turns the env file off.
import { existsSync } from "node:fs";
import { artifactBun, runtimeModule } from "./scripts-dir";

/** The Bun that most children run under: a release artifact's shim, else `bun` from PATH. */
export function ownBun(): string {
  return artifactBun() ?? "bun";
}

/**
 * The flags a start of `bun` needs so the working directory is not its project.
 * Empty for a release artifact's shim, which passes them itself. They do apply
 * to the compiled router's own path: a caller that hands it a module runs it
 * as the Bun command line (BUN_BE_BUN=1), which autoloads whatever it was
 * compiled with.
 */
export function ownBunFlags(bun: string = ownBun()): string[] {
  if (bun.endsWith("/libexec/tap/bun")) return [];
  const config = runtimeModule("tap-bunfig.toml");
  // Bun exits on a configuration path it cannot read; the empty device stands in for a missing file.
  return [`--config=${existsSync(config) ? config : "/dev/null"}`, "--no-env-file"];
}

/** `[bun, ...flags]`: the head of every argv that runs TAP's own code under Bun. */
export function ownBunArgv(bun: string = ownBun()): string[] {
  return [bun, ...ownBunFlags(bun)];
}
