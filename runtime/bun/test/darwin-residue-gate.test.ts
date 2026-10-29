// The macOS residue gate must be able to refuse: this file proves each verdict class is reachable
// (PASS on a clean candidate, FAIL on a platform-probe mutant, and the distinct INCOMPLETE exits
// for a missing interpreter and a dirty tree). It builds a throwaway git
// repository per case so the gate's own HEAD/TREE bookkeeping is exercised without depending on the
// state of the checkout running the suite. Where no Python 3.11 floor is installed (Linux CI) the
// floor-dependent arms assert the gate's INCOMPLETE contract instead, never a pass; the PASS and
// FAIL branches run on macOS, where the gate itself is the driver's pre-merge step. The suite
// runner reds any skip-shaped output, so this file never skips.
import { describe, expect, spyOn, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { resolveInterpreter, runGate, runPlatformProbes } from "../src/darwin-residue-gate";

const REPO = resolve(import.meta.dir, "../../..");
const interpreter = process.platform === "darwin" ? resolveInterpreter() : null;
if (!interpreter) console.log(`darwin-residue-gate test: no Darwin Python 3.11 floor here (platform=${process.platform}); floor-dependent arms assert the INCOMPLETE contract`);

/** Without the floor (not macOS, or no 3.11 there), every floor-dependent arm sees a distinct INCOMPLETE, never a pass. */
const NO_FLOOR = /INCOMPLETE: (not macOS \(platform=\w+\)|no Python 3\.11 interpreter)/;
function expectNoFloor(outcome: { code: number; verdict: string }): void {
  expect(outcome.code).toBe(2);
  expect(outcome.verdict).toMatch(NO_FLOOR);
  expect(outcome.verdict).not.toContain("PASS");
}

function git(root: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", "-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

/** A committed checkout holding the platform probes and one tracked filler file. */
function candidate(source: string): string {
  const root = mkdtempSync(join(tmpdir(), "tap-residue-candidate-"));
  writeFileSync(join(root, "filler.txt"), source);
  // A small committed shell surface, plus the exact platform probes and dependencies.
  for (const name of ["bin/tap", "scripts/smoke-all.sh", "scripts/darwin-platform-probes.sh", "scripts/test-secret-env.sh",
    "skills/tap/scripts/smoke/bash32-parse.test.sh", "skills/tap/scripts/smoke/sandbox-pins.sh",
    "skills/tap/scripts/smoke/health-fixture-env.sh"]) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    copyFileSync(join(REPO, name), join(root, name));
  }
  for (let i = 0; i < 150; i++) writeFileSync(join(root, `parse-${i}.sh`), ":\n");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "candidate");
  return root;
}

describe("darwin residue gate", () => {
  test("real Bash 3.2 parsing and health PATH guard fit the shared deadline", () => {
    const result = runPlatformProbes(REPO, process.env, Date.now() + 9000);
    if (process.platform !== "darwin") {
      expect(result.code).toBe(2);
      expect(result.verdict).toContain("/bin/bash is not Bash 3.2");
      return;
    }
    expect(result.code).toBe(0);
    expect(result.verdict).toContain("parse=ok syntax-negative=ok");
    expect(result.verdict).toContain("health-path-guard=ok no-server=ok");
  }, 10000);

  test("platform probe ignores an inherited tmux impostor", () => {
    const root = candidate("# unused\n");
    try {
      const bin = join(root, "poison"); mkdirSync(bin);
      const marker = join(root, "impostor-called");
      writeFileSync(join(bin, "tmux"), `#!/bin/sh\necho called > '${marker}'\nexit 1\n`, { mode: 0o755 });
      const result = runPlatformProbes(root, { ...process.env, PATH: `${bin}:${process.env.PATH}` }, Date.now() + 9000);
      expect(result.code).toBe(process.platform === "darwin" ? 0 : 2);
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("gate passes its validated Python to the platform guard", async () => {
    const root = candidate("# committed\n");
    try {
      const result = await runGate(root, { ...process.env,
        ...(interpreter ? { TAP_RESIDUE_PYTHON: interpreter.path } : {}),
        TAP_PYTHON: join(root, "unrelated-missing-python"),
      });
      if (!interpreter) return expectNoFloor(result);
      expect(result.code).toBe(0);
      expect(result.verdict).toContain("health-path-guard=ok");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("untracked shell input makes the candidate INCOMPLETE before parsing", async () => {
    const root = candidate("# committed\n");
    try {
      writeFileSync(join(root, "untracked.sh"), "case x in x) : ;;& esac\n");
      const result = await runGate(root);
      expect(result.code).toBe(2);
      expect(result.verdict).toContain("worktree dirty");
      expect(result.verdict).not.toContain("worktree=clean");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("platform probes refuse an exhausted budget before spawning", () => {
    const spawn = spyOn(Bun, "spawnSync");
    try {
      const result = runPlatformProbes(REPO, process.env, Date.now() - 1);
      expect(result.code).toBe(2);
      expect(result.verdict).toContain("timeout before platform probes");
      expect(spawn).not.toHaveBeenCalled();
    } finally { spawn.mockRestore(); }
  });

  test("a platform probe completing after its remaining budget is INCOMPLETE", () => {
    let now = 1000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const spawn = spyOn(Bun, "spawnSync").mockImplementation((_args: any, options?: any) => {
      expect(options.timeout).toBe(100);
      now = 1101;
      return { exitCode: 0, stdout: Buffer.from("late success"), stderr: Buffer.from("") } as any;
    });
    try {
      const result = runPlatformProbes(REPO, process.env, 1100);
      expect(result.code).toBe(2);
      expect(result.verdict).toContain("timeout in platform probes");
    } finally { spawn.mockRestore(); clock.mockRestore(); }
  });

  for (const mutation of ["syntax", "prepend", "outside"] as const) {
    test(`platform control rejects ${mutation} mutant`, () => {
      const root = candidate("# unused\n");
      try {
        if (mutation === "syntax") {
          writeFileSync(join(root, "parse-0.sh"), "case x in x) : ;;& esac\n");
        } else {
          const file = join(root, "skills/tap/scripts/smoke/health-fixture-env.sh");
          const before = readFileSync(file, "utf8");
          const after = mutation === "prepend"
            ? before.replace('PATH="$PATH:$(dirname "$TAP_SMOKE_BUN")"', 'PATH="$(dirname "$TAP_SMOKE_BUN"):$PATH"')
            : before.replace('$TMUX_TMPDIR/health.', '$TMPDIR/health.');
          expect(after).not.toBe(before);
          writeFileSync(file, after);
        }
        const result = runPlatformProbes(root, { ...process.env, TMPDIR: root }, Date.now() + 9000);
        if (process.platform !== "darwin") {
          expect(result.code).toBe(2);
          expect(result.verdict).toContain("/bin/bash is not Bash 3.2");
        } else {
          expect(result.code).toBe(1);
          expect(result.verdict).not.toContain("\n");
          expect(result.verdict).toContain(mutation === "syntax" ? "Bash 3.2 repository parse" : "health private no-server probe");
        }
      } finally { rmSync(root, { recursive: true, force: true }); }
    }, 10000);
  }

  test("later interpreter probes receive only the remaining shared budget", () => {
    let now = 1000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const budgets: number[] = [];
    const spawn = spyOn(Bun, "spawnSync").mockImplementation((_args: any, options?: any) => {
      budgets.push(options.timeout);
      // First candidate fails slowly; the second hangs until its timeout.
      now += budgets.length === 1 ? 8000 : options.timeout;
      return { exitCode: 1, stdout: Buffer.from(""), stderr: Buffer.from("") } as any;
    });
    try {
      expect(resolveInterpreter({}, 9000)).toBeNull();
      expect(budgets).toEqual([9000, 1000]);
      expect(now).toBe(10000);
    } finally { spawn.mockRestore(); clock.mockRestore(); }
  });

  test("PASS records head, tree, interpreter and wall (INCOMPLETE without the floor)", async () => {
    const root = candidate("# committed\n");
    try {
      const outcome = await runGate(root);
      if (!interpreter) return expectNoFloor(outcome);
      expect(outcome.verdict).toEndWith("— PASS");
      expect(outcome.code).toBe(0);
      expect(outcome.verdict).toMatch(/head=[0-9a-f]{40} tree=[0-9a-f]{40} worktree=clean/);
      expect(outcome.verdict).toContain(`interpreter=${interpreter!.path} version=${interpreter!.version}`);
      expect(outcome.verdict).toMatch(/parse=ok .*wall=\d+ms/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("INCOMPLETE, not PASS, when no Python 3.11 interpreter resolves (or off macOS)", async () => {
    const root = candidate("# unused\n");
    try {
      const outcome = await runGate(root, { ...process.env, TAP_RESIDUE_PYTHON: join(root, "no-such-python3.11") });
      expectNoFloor(outcome);
      if (process.platform === "darwin") expect(outcome.verdict).toContain("platform=darwin");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("INCOMPLETE on a dirty worktree, before any interpreter is spawned", async () => {
    const root = candidate("# committed\n");
    try {
      writeFileSync(join(root, "filler.txt"), "# edited after commit\n");
      const outcome = await runGate(root, { ...process.env, TAP_RESIDUE_PYTHON: join(root, "no-such-python3.11") });
      expect(outcome.code).toBe(2);
      expect(outcome.verdict).toContain("INCOMPLETE: worktree dirty");
      expect(outcome.verdict).not.toContain("interpreter=");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("INCOMPLETE on the deadline, with the phase named (or the missing floor, without one)", async () => {
    const root = candidate("# committed\n");
    try {
      const outcome = await runGate(root, { ...process.env, TAP_RESIDUE_DEADLINE_MS: "1" });
      expect(outcome.code).toBe(2);
      expect(outcome.verdict).not.toContain("PASS");
      // Off the floor the 1 ms budget may expire inside the interpreter probe or before it.
      expect(outcome.verdict).toMatch(interpreter ? /INCOMPLETE: timeout/ : /INCOMPLETE: (timeout|not macOS|no Python 3\.11)/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
