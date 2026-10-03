import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { removeScratchTree } from "./support/scratch";

// Ported from skills/tap/scripts/smoke/verbose.test.sh: opt-in diagnostics that
// leave stdout, verb results and command status untouched — parity when off,
// `tap verbose:` echoes on stderr when on, the tmux client seam surfacing the
// real command and result, and VERBOSE_SECRET redaction across env values,
// --flag arguments, key:value lines, Authorization headers and JSON shapes.
//
// The retired shell drove these through a python3 driver spawning bin/tap and
// `bun -e` snippets; this port keeps the subprocess shape (verbose writes to
// the REAL process.stderr, so stream capture needs a child) with explicit
// environments seeded from the runner's sandbox pins.
//
// Scratch allocation: the fixture tree lives only beneath the runner-owned
// scratch root (runtime/bun/test/run.sh exports TMUX_TMPDIR); this file
// refuses to run without it.

const RUNNER_ROOT = process.env.TMUX_TMPDIR;
if (!RUNNER_ROOT) {
  throw new Error(
    "verbose.test.ts: TMUX_TMPDIR is unset — this fixture allocates only beneath the supported runner's scratch root (runtime/bun/test/run.sh exports it); refusing to write outside it",
  );
}
const WORK = mkdtempSync(join(RUNNER_ROOT, "tap-verbose."));
afterAll(() => removeScratchTree(WORK));

const ROOT = resolve(import.meta.dir, "../../..");
const BIN_TAP = join(ROOT, "bin", "tap");
const TMUX_TS = join(ROOT, "runtime", "bun", "src", "tmux.ts");
const VERBOSE_TS = join(ROOT, "runtime", "bun", "src", "verbose.ts");
const SHIM = join(import.meta.dir, "fixtures", "verbose", "tmux");
const HELPERS = join(ROOT, "skills", "tap", "scripts", "smoke", "runtime-helpers.sh");

type Env = Record<string, string>;

/** The runner pins, then the isolated HOME/TAP_HOME the retired shell used. */
function baseEnv(extra: Env = {}): Env {
  const pins: Env = {};
  for (const key of ["TMUX_TMPDIR", "TMPDIR", "TAP_LOCK_DIR", "TAP_NOTIFY_USER_BIN", "EPISODIC_MEMORY_SUMMARIZER_GUARD"]) {
    const value = process.env[key];
    if (value !== undefined) pins[key] = value;
  }
  const { TAP_VERBOSE: _v, TAP_VERBOSE_FD: _f, ...rest } = process.env;
  return {
    ...pins,
    PATH: rest.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin",
    HOME: WORK,
    TAP_HOME: join(WORK, "bus"),
    TAP_INDEX_HOME: join(WORK, "index"),
    ...extra,
  };
}

function run(cmd: string[], env: Env, input?: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: "utf8", env, input, cwd: ROOT });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const ARGSETS: string[][] = [
  ["help", "read"],
  ["read"],
  ["session", "--bad-verbose-test-option"],
  ["whoami", "--verbose"],
];

test(
  "public CLI: opt-in tracing changes no result, only adds stderr echoes",
  () => {
    for (const args of ARGSETS) {
      const normal = run([BIN_TAP, ...args], baseEnv());
      const disabled = run([BIN_TAP, ...args], baseEnv({ TAP_VERBOSE: "0" }));
      expect([normal.status, normal.stdout, normal.stderr], `parity for ${args.join(" ")}`)
        .toEqual([disabled.status, disabled.stdout, disabled.stderr]);
      // Off is off: neither the unset nor the explicit-0 run may echo.
      expect(normal.stderr, `silent for ${args.join(" ")}`).not.toContain("tap verbose:");
      expect(disabled.stderr, `silent for ${args.join(" ")}`).not.toContain("tap verbose:");
      for (const flag of ["-v", "--verbose"]) {
        const traced = run([BIN_TAP, flag, ...args], baseEnv());
        expect(traced.status, `${flag} ${args.join(" ")}`).toBe(normal.status);
        expect(traced.stdout, `${flag} ${args.join(" ")}`).toBe(normal.stdout);
        expect(traced.stderr, `${flag} ${args.join(" ")}`).toContain("tap verbose:");
      }
    }
  },
  // Sixteen bin/tap spawns exceed the supported runner's shortest per-test
  // budget on slow hosts; 60s bounds the parity matrix without weakening it.
  { timeout: 60_000 },
);

function seamScript(): string {
  return `import { tmuxReadOnly } from ${JSON.stringify(TMUX_TS)}; const r = tmuxReadOnly(["display-message", "-t", "%42"]); process.stdout.write(r.stdout); process.exit(r.code);`;
}

function shimOnPath(name: string, extra: Env = {}): Env {
  const shimPath = join(WORK, name);
  mkdirSync(shimPath, { recursive: true });
  symlinkSync(SHIM, join(shimPath, "tmux"));
  return baseEnv({ PATH: `${shimPath}:${baseEnv().PATH}`, ...extra });
}

test("tmuxReadOnly seam: the real command and its failure surface, only when opted in", () => {
  const env = shimOnPath("seam-bin", { TAP_VERBOSE: "1" });
  const traced = run([process.execPath, "-e", seamScript()], env);
  expect(traced.status).toBe(7);
  expect(traced.stdout).toBe("seam-out");
  expect(traced.stderr).toContain("seam-err");
  expect(traced.stderr).toContain("%42");
  const quiet = run([process.execPath, "-e", seamScript()], { ...env, TAP_VERBOSE: "0" });
  expect(quiet.status).toBe(7);
  expect(quiet.stdout).toBe("seam-out");
  expect(quiet.stderr).toBe("");
});

test("shell helpers keep calling the injected tmux function, verbose or not", () => {
  const injected = run(
    ["bash", "-c", 'tmux() { printf "injected-private"; }; source "$1"; tmux display-message -t %42', "_", HELPERS],
    shimOnPath("inject-bin", { TAP_VERBOSE: "1" }),
  );
  expect(injected.status).toBe(0);
  expect(injected.stdout).toBe("injected-private");
});

function verboseRun(scriptArgs: string, env: Env): { status: number | null; stdout: string; stderr: string } {
  const script = `import { verbose } from ${JSON.stringify(VERBOSE_TS)}; verbose(${scriptArgs});`;
  return run([process.execPath, "-e", script], env);
}

test("verbose redacts secrets in argv, env values and quoted strings", () => {
  const r = verboseRun(
    `"test", { argv: ["--token", "flag-secret", 'API_KEY="quoted secret"'], stderr: "env-secret" }`,
    baseEnv({ TAP_VERBOSE: "1", API_KEY: "env-secret" }),
  );
  expect(r.status).toBe(0);
  expect(r.stdout).toBe("");
  expect(r.stderr).toContain("<redacted>");
  for (const leak of ["flag-secret", "quoted secret", "env-secret"]) {
    expect(r.stderr, `leak: ${leak}`).not.toContain(leak);
  }
});

test("verbose redacts command_exit stderr across the secret-name shapes", () => {
  const cases = [
    "API_TOKEN: review-colon-value",
    "Authorization: Bearer review-bearer-value",
    '{"api_key": "review-json-value"}',
  ];
  for (const c of cases) {
    const script = `import { verbose } from ${JSON.stringify(VERBOSE_TS)}; verbose("command_exit", { stderr: process.argv[1] });`;
    const r = run([process.execPath, "-e", script, c], baseEnv({ TAP_VERBOSE: "1" }));
    expect(r.status, c).toBe(0);
    expect(r.stdout, c).toBe("");
    expect(r.stderr, c).toContain("<redacted>");
    expect(r.stderr, c).not.toContain("review-");
  }
});
