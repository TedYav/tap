/**
 * A compiled TAP router runs as Bun's CLI only under BUN_BE_BUN=1: a release
 * artifact's libexec/tap/bun sets it for every TAP child, and the escalate door
 * sets it to run verbs/escalate.ts. Left in place it would reach every grandchild,
 * and a Bun-compiled harness or the router itself would start as the Bun CLI.
 *
 * Deleting it from process.env is not enough. Bun.spawn and Bun.spawnSync called
 * without an `env` option hand the child the process's ORIGINAL environment, the
 * variable included (tap-7r3fn.192, 2026-10-02 probe; node:child_process uses
 * process.env and is clean). So the scrub also points their default at
 * process.env. It does nothing when the variable is absent, so a process started
 * without it, such as the public router, keeps Bun's own spawn behavior.
 */
export function scrubBunBeBun(): void {
  if (process.env.BUN_BE_BUN === undefined) return;
  delete process.env.BUN_BE_BUN;
  const withEnv = <T extends { env?: unknown }>(options: T | undefined): T =>
    (options?.env === undefined ? { ...options, env: process.env } : options) as T;
  const spawn = Bun.spawn, spawnSync = Bun.spawnSync;
  const patched = (original: (...args: never[]) => unknown) => (...args: unknown[]) =>
    Array.isArray(args[0])
      ? (original as (...a: unknown[]) => unknown)(args[0], withEnv(args[1] as { env?: unknown } | undefined))
      : (original as (...a: unknown[]) => unknown)(withEnv(args[0] as { env?: unknown } | undefined));
  Object.assign(Bun, { spawn: patched(spawn), spawnSync: patched(spawnSync) });
}
