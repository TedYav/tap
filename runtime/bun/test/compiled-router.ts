// A `bun build --compile` TAP router for tests that must reach a spawn the source runner
// cannot tell apart from the real thing (tap-555z9, tap-gpk7b). Under the compiled binary
// process.execPath is the router and a module's directory is virtual, so only a compiled
// entry proves a child launches through real Bun and a real path.
//
// The binary lives in runner scratch, laid out as the installed one is: the router finds the
// shipped scripts at <binary dir>/../../skills/tap/scripts, so the scratch root links the
// checkout's skills/ and runtime/ and holds the binary at bin/tap/router. One build serves a
// test file; call compiledRouterCleanup() from its afterAll.
import { expect } from "bun:test";
import { chmodSync, copyFileSync, cpSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

let compiled: { root: string; binary: string } | null = null;

export function compiledRouter(): string {
  if (compiled) return compiled.binary;
  const root = mkdtempSync(join(tmpdir(), "tap-compiled-router-"));
  const repo = resolve(import.meta.dir, "../../..");
  symlinkSync(join(repo, "skills"), join(root, "skills")); symlinkSync(join(repo, "runtime"), join(root, "runtime"));
  mkdirSync(join(root, "bin/tap"), { recursive: true });
  const binary = join(root, "bin/tap/router");
  const build = spawnSync("bun", ["build", "--compile", resolve(import.meta.dir, "../main.ts"), "--outfile", binary], { cwd: root, encoding: "utf8" });
  compiled = { root, binary };
  expect(build.status, build.stderr).toBe(0);
  return binary;
}

/** The shipped runtime/bun/src the compiled router resolves: its own layout, not the checkout it links. */
export function compiledRouterSrc(): string {
  compiledRouter();
  return join(realpathSync(compiled!.root), "runtime/bun/src");
}

export function compiledRouterCleanup(): void {
  if (compiled) rmSync(compiled.root, { recursive: true, force: true });
  compiled = null;
  for (const built of artifacts.values()) rmSync(built.root, { recursive: true, force: true });
  artifacts.clear();
}

type Artifact = { root: string; router: string; shim: string; src: string };
const artifacts = new Map<"real" | "recording", Artifact>();

/**
 * A release-artifact-shaped root (tap-7r3fn.192): libexec/tap/tap is the compiled router and
 * libexec/tap/bun the shipped shim, which runs that router as Bun. runtime/bun is a COPY of the
 * checkout's sources: a child resolves its root from its own real path, and a link would send it
 * back to the checkout, which has no libexec/. skills/, completions/, hooks/ and vendor/ are links, since
 * only the router (whose root comes from its own path) and the copied sources read them.
 *
 * "recording" swaps the real shim for a recorder that appends its argv to $ROOT/state/shim-argv
 * (and whether BUN_BE_BUN reached it), for tests that need the argv a child was handed. It shares
 * the real artifact's router binary through a hard link, so one compile serves both.
 */
export function compiledArtifact(kind: "real" | "recording" = "real"): Artifact {
  const cached = artifacts.get(kind);
  if (cached) return cached;
  const repo = resolve(import.meta.dir, "../../..");
  const root = realpathSync(mkdtempSync(join(tmpdir(), `tap-artifact-${kind}-`)));
  const src = join(root, "runtime/bun/src"), router = join(root, "libexec/tap/tap"), shim = join(root, "libexec/tap/bun");
  mkdirSync(join(root, "libexec/tap"), { recursive: true });
  cpSync(join(repo, "runtime/bun/src"), src, { recursive: true });
  copyFileSync(join(repo, "runtime/bun/main.ts"), join(root, "runtime/bun/main.ts"));
  for (const dir of ["skills", "completions", "hooks", "vendor"]) symlinkSync(join(repo, dir), join(root, dir));
  if (kind === "real") {
    const build = spawnSync("bun", ["build", "--compile", join(root, "runtime/bun/main.ts"), "--outfile", router], { cwd: root, encoding: "utf8" });
    expect(build.status, build.stderr).toBe(0);
    copyFileSync(join(repo, "scripts/release/libexec-bun.sh"), shim);
  } else {
    linkSync(compiledArtifact("real").router, router);
    writeFileSync(shim, '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$ROOT/state/shim-argv"\nprintf \'%s\\n\' "${BUN_BE_BUN-unset}" >> "$ROOT/state/shim-be-bun"\n');
  }
  chmodSync(shim, 0o755);
  const built = { root, router, shim, src };
  artifacts.set(kind, built);
  return built;
}
