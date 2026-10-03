import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The shipped skills/tap/scripts root: the source checkout beside this module,
 * else the compiled binary's sibling layout. Keyed on the directory itself so
 * no file inside it has to exist.
 */
export function tapScriptsDir(): string {
  const source = resolve(import.meta.dir, "../../../skills/tap/scripts");
  return existsSync(source) ? source : resolve(dirname(process.execPath), "../../skills/tap/scripts");
}

/**
 * The TAP root that holds skills/ and runtime/ (and libexec/ in a release
 * artifact). Real from source and from the compiled router alike, so runtime
 * paths never come from a compiled module's virtual /$bunfs directory.
 */
export function tapRoot(scriptsDir: string = tapScriptsDir()): string {
  return resolve(scriptsDir, "../../..");
}

/** A shipped file under runtime/bun (a child entry or a resource), resolved from the real root. */
export function runtimeModule(rel: string, root: string = tapRoot()): string {
  return resolve(root, "runtime/bun", rel);
}

/**
 * A release artifact's Bun: libexec/tap/bun, the shim that runs the compiled
 * router as Bun with BUN_BE_BUN scrubbed before the child's own code runs.
 * Only the release build writes it and nothing tracks libexec/, so a checkout
 * or the compiled test fixture gets null and keeps the Bun it uses today.
 */
export function artifactBun(root: string = tapRoot()): string | null {
  const shim = join(root, "libexec/tap/bun");
  try {
    if (!statSync(shim).isFile()) return null;
    accessSync(shim, constants.X_OK);
    return shim;
  } catch {
    return null;
  }
}

/** The compiled router beside the artifact's Bun shim; null outside a release artifact. */
export function artifactRouter(root: string = tapRoot()): string | null {
  const shim = artifactBun(root);
  return shim ? join(dirname(shim), "tap") : null;
}
