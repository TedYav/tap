import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const repo = resolve(import.meta.dir, "../../..");
const guard = "EPISODIC_MEMORY_SUMMARIZER_GUARD";
const sandboxPins = join(repo, "skills/tap/scripts/smoke/sandbox-pins.sh");
const bunRunner = join(import.meta.dir, "run.sh");
const bash = Bun.which("bash") ?? "/bin/bash";
const scratch = mkdtempSync(join(tmpdir(), "tap-claude-live-guard-"));
mkdirSync(join(scratch, "tmp"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function childEnv(value: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(scratch, "home"), TMPDIR: join(scratch, "tmp") };
  mkdirSync(env.HOME!, { recursive: true });
  delete env.TAP_INDEX_HOME;
  delete env.TAP_SESSION_MANIFEST;
  delete env.OPENCODE_DB_PATH;
  delete env.TAP_VERSION_SEEN_PATH;
  delete env.TAP_SUITE_SANDBOX;
  if (value === undefined) delete env[guard];
  else env[guard] = value;
  return env;
}

test("sandbox pins set the plugin guard without changing either caller state", () => {
  for (const value of [undefined, "caller-value"]) {
    const env = childEnv(value);
    const before = env[guard];
    const result = spawnSync(bash, ["-c", `
      . "$1"
      child_value="$(/usr/bin/env | awk -F= '$1 == "${guard}" { print $2 }')"
      [ "$child_value" = 1 ]
    `, "bash", sandboxPins], { cwd: repo, env, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(env[guard]).toBe(before);
  }
});

test("Bun runner pins the plugin guard and notifier from unset, empty and set callers", () => {
  const probe = join(scratch, "guard-child.test.ts");
  writeFileSync(probe, `
    import { test, expect } from "bun:test";
    test("runner boundary", () => {
      expect(process.env.${guard}).toBe("1");
      expect(process.env.TAP_NOTIFY_USER_BIN).toBe("/nonexistent/tap-smoke-must-stub-notify-user");
      console.log("GUARD_CHILD=1");
    });
  `);

  for (const value of [undefined, "", "caller-value"]) {
    const env = childEnv(value);
    if (value === undefined) delete env.TAP_NOTIFY_USER_BIN;
    else env.TAP_NOTIFY_USER_BIN = value;
    const before = env[guard];
    env.TMUX_TMPDIR = join(scratch, value ? "tmux-set" : "tmux-unset");
    mkdirSync(env.TMUX_TMPDIR, { recursive: true });
    const result = spawnSync(bash, [bunRunner, probe], {
      cwd: repo,
      env: { ...env, TAP_SMOKE_BUN: process.execPath },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("GUARD_CHILD=1");
    expect(env[guard]).toBe(before);
    expect(env.TAP_NOTIFY_USER_BIN).toBe(value);
  }
});
