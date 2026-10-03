// Locating the reference implementation for the differential suite.
//
// THIS FAILS CLOSED, and it lives in its own module so that the failing behavior
// is itself testable. An earlier version hard-coded one checkout and degraded to
// `describe.skip` when it was missing, which meant losing the oracle turned all
// 43 byte-compatibility checks into a silently passing run — the
// success-shaped-signal class this whole suite exists to prevent
// (partner review, round 2).
//
// The `candidates` seam is not decoration: without it, "prove it fails when the
// reference is absent" is unprovable on a machine where the reference is
// present, and I would be asserting the fail-closed property rather than
// demonstrating it.

import { existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

/** Follow whatever `tap` is on PATH back to its own tree's scripts/tap.sh. */
export function resolveViaInstalledTap(): string | undefined {
  const which = spawnSync("sh", ["-c", "command -v tap"], { encoding: "utf8" });
  const bin = (which.stdout ?? "").trim();
  if (!bin) return undefined;
  let real: string;
  try {
    real = realpathSync(bin);
  } catch {
    return undefined;
  }
  // <tree>/bin/tap -> <tree>/scripts/tap.sh
  return join(dirname(dirname(real)), "scripts", "tap.sh");
}

// ---------------------------------------------------------------------------
// The reference BINARY, for arms that run whole CLI invocations.
//
// The first version of those arms built this path by walking four parent
// directories from the test file and appending `tap/scripts/tap.sh`. That
// exists only in ONE checkout topology — mine. In the partner reviewer's detached
// reviewer clone it resolved to nothing, bash exited 127, and the arms compared
// candidate exit codes against 127. **A test whose newest proof runs only in
// the author's directory layout is not independent review evidence**, and the
// guard that was supposed to catch it (`ref >= 0`) accepted 127 as a real
// answer under a comment claiming a spawn failure could not agree.

/** Candidate paths for the reference `tap` entry point, most explicit first. */
export function refBinCandidates(
  env: NodeJS.ProcessEnv = process.env,
  resolveInstalled: () => string | undefined = resolveViaInstalledTap,
): string[] {
  return [env.TAP_POC_REF_BIN, resolveInstalled()].filter((c): c is string => !!c);
}

export function findRefBin(
  candidates: string[] = refBinCandidates(),
  exists: (p: string) => boolean = existsSync,
): string {
  for (const c of candidates) {
    if (exists(c)) return c;
  }
  throw new Error(
    "differential CLI arms cannot run: no reference `tap` entry point was found.\n" +
    "This is a HARD FAILURE, not a skip.\n" +
    `Searched: ${candidates.length ? candidates.join(", ") : "(no candidates)"}\n` +
    "Set TAP_POC_REF_BIN=/path/to/scripts/tap.sh to point at a checkout.",
  );
}

/**
 * A shell's "I could not run that" codes. 127 is command-not-found and 126 is
 * found-but-not-executable; both are the SHELL answering, not the program. An
 * arm that accepts them compares against the absence of its own oracle.
 */
export function assertRealExit(status: number, what: string): void {
  if (status === 127 || status === 126) {
    throw new Error(`${what} exited ${status}: that is the shell reporting it could not run the command, not a result`);
  }
  if (status < 0) throw new Error(`${what} did not run at all`);
}
