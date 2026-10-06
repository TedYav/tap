import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyLaunchEnv } from "../src/launcher/plan";

const work = mkdtempSync(join(tmpdir(), "env-tiers-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

let n = 0;
/** A machine whose `[harness.claude.env]` says exactly this. */
function machine(body: string): NodeJS.ProcessEnv {
  const dir = join(work, String(n++));
  mkdirSync(join(dir, "tap"), { recursive: true });
  const file = join(dir, "tap", "config.toml");
  writeFileSync(file, body);
  chmodSync(file, 0o600);
  return { HOME: "/nonexistent", XDG_CONFIG_HOME: dir };
}

const seat = { name: "seat", harness: "claude", cwd: "/wt", base: "team", harness_env: {} };

/**
 * THE ORDER IS THE CONTRACT, and it is easy to invert while "fixing" a real bug.
 *
 * `apply_launch_env` composes four tiers, later winning: claude cosmetics, then
 * `[harness.*.env]` machine policy, then `invocation.env`, then the seat's own
 * `record.harness_env`. A partner review correctly found that `request.ts` was
 * defeating the fresh policy read — but the arm it shipped asserted that POLICY
 * beats `invocation.env`, which is the opposite of the incumbent. Measured
 * against the pinned incumbent at `1dce16bac` with policy `EDITOR_THEME=new` and
 * `invocation.env` `EDITOR_THEME=old`, Python returns `'old'`.
 *
 * So the caller's bug was real and the remedy is at the CALLER: it must not hand
 * its own stale policy snapshot in as `invocation.env`. These arms pin both
 * halves, because satisfying the original arm would have inverted tiers 2 and 3
 * and broken every seat that overrides policy for one launch.
 */
test("tier 3 beats tier 2: invocation.env overrides harness policy", () => {
  const env = machine('version=3\n[harness.claude.env]\nEDITOR_THEME="new"\n');
  const got = applyLaunchEnv({ argv: ["claude"], env: { EDITOR_THEME: "old" } }, seat, env);
  expect(got.env.EDITOR_THEME).toBe("old");
});

test("with no invocation.env, the FRESH policy read reaches the child", () => {
  const env = machine('version=3\n[harness.claude.env]\nEDITOR_THEME="new"\n');
  const got = applyLaunchEnv({ argv: ["claude"], env: {} }, seat, env);
  expect(got.env.EDITOR_THEME).toBe("new");
});

test("tier 4 beats tier 2: the seat's own env outranks machine policy", () => {
  const env = machine('version=3\n[harness.claude.env]\nEDITOR_THEME="new"\n');
  const got = applyLaunchEnv({ argv: ["claude"], env: {} },
    { ...seat, harness_env: { EDITOR_THEME: "seat" } }, env);
  expect(got.env.EDITOR_THEME).toBe("seat");
});

test("policy overrides a tier-1 cosmetic, which is parent-honouring by default", () => {
  const env = machine('version=3\n[harness.claude.env]\nCLAUDE_CODE_SCROLL_SPEED="policy"\n');
  const got = applyLaunchEnv({ argv: ["claude"], env: {} }, seat, env);
  expect(got.env.CLAUDE_CODE_SCROLL_SPEED).toBe("policy");
});

// The tier-1 fallback VALUES, pinned natively: with no ambient env and no policy
// the claude cosmetics carry the incumbent defaults (plan.ts). This is the owner
// suite-env-hermeticity's mutation boundary observes.
test("with no env and no policy, the claude cosmetics carry the incumbent fallbacks", () => {
  const got = applyLaunchEnv({ argv: ["claude"], env: {} }, seat, machine("version=3\n"));
  expect(got.env.CLAUDE_CODE_SCROLL_SPEED).toBe("4");
  expect(got.env.CLAUDE_CODE_NO_FLICKER).toBe("1");
  expect(got.env.CLAUDE_CODE_TMUX_TRUECOLOR).toBe("1");
});

// tap-k0jwy: agent view moves a seat into a background worker and strands its
// pane. This pins only the environment the launcher composes -- not Claude's
// behavior. The runtime check (Claude Code 2.1.288 with the variable set ran
// background Bash and a background subagent while left-arrow agent view and /bg
// were unavailable) used real ~/.claude auth and is not a suite test.
test("a claude seat launches with agent view disabled by default", () => {
  const got = applyLaunchEnv({ argv: ["claude"], env: {} }, seat, machine("version=3\n"));
  expect(got.env.CLAUDE_CODE_DISABLE_AGENT_VIEW).toBe("1");
  expect(got.env).not.toHaveProperty("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS");
});

test("a non-claude seat never receives the agent-view default", () => {
  const codex = { ...seat, harness: "codex" };
  const got = applyLaunchEnv({ argv: ["codex"], env: {} }, codex, machine("version=3\n"));
  expect(got.env).not.toHaveProperty("CLAUDE_CODE_DISABLE_AGENT_VIEW");
});

test("the launching shell's explicit agent-view value overrides the default", () => {
  const env = { ...machine("version=3\n"), CLAUDE_CODE_DISABLE_AGENT_VIEW: "0" };
  const got = applyLaunchEnv({ argv: ["claude"], env: {} }, seat, env);
  expect(got.env.CLAUDE_CODE_DISABLE_AGENT_VIEW).toBe("0");
});

test("machine policy overrides the agent-view default", () => {
  const env = machine('version=3\n[harness.claude.env]\nCLAUDE_CODE_DISABLE_AGENT_VIEW="0"\n');
  const got = applyLaunchEnv({ argv: ["claude"], env: {} }, seat, env);
  expect(got.env.CLAUDE_CODE_DISABLE_AGENT_VIEW).toBe("0");
});
