import { resolve } from "node:path";
import { artifactBun, artifactRouter, tapRoot } from "./scripts-dir";
import { ownBunArgv } from "./own-bun";

/**
 * argv for one out-of-process TAP verb: Bun's own entry, with no Bash shim hop
 * and no bin/tap door (bin/tap marks a PUBLIC command, so an internal spawn
 * through it would journal twice). Both halves resolve as the shim's did:
 * `bun` from PATH, because process.execPath can be the compiled TAP router,
 * and main.ts from the real scripts dir, because a compiled module's own
 * directory is virtual. TAP_VERB_SCRIPT names a stand-in (a test recorder);
 * bash runs it with the full verb argv, as `bash tap.sh <verb> …` did. In a
 * release artifact the compiled router IS main.ts, so it runs the verb itself.
 */
export function verbArgv(scriptsDir: string, argv: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const standIn = env.TAP_VERB_SCRIPT;
  if (standIn) return ["bash", standIn, ...argv];
  const router = artifactRouter(tapRoot(scriptsDir));
  return router ? [router, ...argv] : [...ownBunArgv("bun"), resolve(scriptsDir, "../../../runtime/bun/main.ts"), ...argv];
}

/**
 * argv for one out-of-process `tap send`. TAP_COURIER_SCRIPT names a stand-in
 * courier (a test recorder or failure injector); bash runs it with the send
 * arguments, without the verb.
 */
export function courierArgv(scriptsDir: string, args: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const standIn = env.TAP_COURIER_SCRIPT;
  return standIn ? ["bash", standIn, ...args] : verbArgv(scriptsDir, ["send", ...args], { ...env, TAP_VERB_SCRIPT: "" });
}

/**
 * argv for `tap init` as its own process: Bun on the init entry directly (the
 * tap-init.sh adapter is gone). Init stays a separate process because it owns
 * registry creation and prompts on the shared stdin. TAP_VERB_SCRIPT's
 * stand-in gets the verb too, as it would through the router.
 */
export function initArgv(scriptsDir: string, args: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const standIn = env.TAP_VERB_SCRIPT;
  return standIn ? ["bash", standIn, "init", ...args] : [...ownBunArgv(childBun(scriptsDir)), resolve(scriptsDir, "../../../runtime/bun/src/verbs/init.ts"), ...args];
}

/**
 * argv for peer compact's submit child (verbs/compact-peer-submit.ts), on the
 * same boundary: `bun` from PATH and the shipped module under the real
 * scripts dir, never process.execPath or a compiled module's virtual dir.
 */
export function peerSubmitArgv(scriptsDir: string): string[] {
  return [...ownBunArgv(childBun(scriptsDir)), resolve(scriptsDir, "../../../runtime/bun/src/verbs/compact-peer-submit.ts")];
}

/**
 * argv for one recovery adapter op (recovery/cli.ts) as its own process, on the
 * same boundary: `bun` from PATH and the shipped module under the real scripts
 * dir, never process.execPath or a compiled module's virtual dir.
 */
export function recoveryCliArgv(scriptsDir: string, args: string[]): string[] {
  return [...ownBunArgv(childBun(scriptsDir)), resolve(scriptsDir, "../../../runtime/bun/src/recovery/cli.ts"), ...args];
}

/** The Bun for a builder's child: the release artifact's shim, else `bun` from PATH. */
function childBun(scriptsDir: string): string {
  return artifactBun(tapRoot(scriptsDir)) ?? "bun";
}

/**
 * The Bun binary for a child that must run a .ts module (a sidecar, a custodian,
 * a re-exec). From source, process.execPath IS Bun. Under `bun build --compile`
 * it is the TAP router, which would read the module path as a verb, so the
 * child gets `bun` from PATH instead; an absolute path, because execve and a
 * tmux window command do not search PATH the way spawn does. A release
 * artifact's shim wins over both: there process.execPath is the router even
 * from source, and no Bun need be installed.
 */
export function bunBinary(): string {
  return artifactBun() ?? (import.meta.path.startsWith("/$bunfs/") ? Bun.which("bun") ?? "bun" : process.execPath);
}
