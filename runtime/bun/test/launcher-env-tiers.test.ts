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
  expect(got.env.CLAUDE_CODE_SCROLL_SPEED).toBe("6");
  expect(got.env.CLAUDE_CODE_TMUX_TRUECOLOR).toBe("1");
});
