import { writeFileSync } from "node:fs";

import { procStartEpoch } from "../../src/reset";
import { bootId } from "../../src/tmux";

/**
 * A reset fence held by THIS test process: every identity factor present and
 * the owner alive, so every door reads it as a live reset in progress.
 *
 * `{}` used to stand in for "a fence exists". It names no owner, which is the
 * unreclaimable shape tap-mkiqq refuses differently — so a test that means
 * "the bus is mid-reset" writes this instead. `env` must be the environment the
 * reader runs under: a pinned TAP_BOOT_ID decides which boot counts as current.
 */
export function liveFenceBytes(env: NodeJS.ProcessEnv = process.env, extra: Record<string, unknown> = {}): string {
  const pid = String(process.pid), start = procStartEpoch(pid), boot = bootId(env);
  if (!start || !boot) throw new Error("live fence fixture: cannot observe this process's boot id or start epoch");
  return `${JSON.stringify({ op: "team-reset", pid: process.pid, token: "test-live-fence", boot_id: boot, owner_start: start, phase: "checkpointing", ...extra })}\n`;
}

export function writeLiveFence(path: string, env: NodeJS.ProcessEnv = process.env, extra: Record<string, unknown> = {}): void {
  writeFileSync(path, liveFenceBytes(env, extra));
}
