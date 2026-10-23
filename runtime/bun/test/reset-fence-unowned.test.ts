import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launcherFenceRefusal, resetFenceRefusal } from "../src/reset";
import { writeLiveFence } from "./support/live-fence";

// tap-mkiqq: a fence record that names no owner is refused as unreclaimable,
// never as "mid-reset" with a wait that cannot end. The live-owner case is the
// control that proves the new text discriminates rather than firing on every fence.
const root = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "reset-unowned-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function bus(fence: string | null): string {
  const home = join(root, `bus${n++}`);
  mkdirSync(home);
  if (fence === null) writeLiveFence(join(home, "reset.fence.json"));
  else writeFileSync(join(home, "reset.fence.json"), fence);
  return home;
}

test.each([
  ["not JSON", "not json at all", "is unreadable"],
  ["a JSON array", "[]\n", "is unreadable"],
  ["an empty object", "{}\n", "names no owner (pid, boot_id or owner_start missing)"],
  ["no owner_start", '{"pid":123,"boot_id":"boot:1"}\n', "names no owner"],
  ["a fractional pid", '{"pid":1.5,"boot_id":"boot:1","owner_start":"1"}\n', "names no owner"],
])("%s names itself, says nothing will reclaim it, and offers a runnable rm", (_label, bytes, state) => {
  const home = bus(bytes), path = join(home, "reset.fence.json");
  const refusal = resetFenceRefusal(home, "tap poll")!;
  expect(refusal.detail).toContain(`the reset fence record at ${path} ${state}`);
  expect(refusal.detail).toContain("nothing will clear it automatically");
  expect(refusal.detail).not.toContain("mid-reset");
  expect(refusal.action).toBe(`inspect ${path} and, once you are sure no reset is running, remove it: rm ${path}`);
  expect(launcherFenceRefusal(path, "session resume")).toBe(`${refusal.detail.replace("tap poll", "session resume")}; next: ${refusal.action}`);
});

test("a live owner still reads as mid-reset at both kinds of door", () => {
  const home = bus(null), path = join(home, "reset.fence.json");
  const refusal = resetFenceRefusal(home, "tap poll")!;
  expect(refusal.detail).toBe(`refusing tap poll — team bus is mid-reset (fence at ${path})`);
  expect(refusal.action).toBe("wait for the reset owner (or until identity is readable)");
  expect(launcherFenceRefusal(path, "session resume")).toBe(`refusing session resume — team bus is mid-reset (fence at ${path}); next: wait for the reset owner (or until identity is readable)`);
});

// A stale checkpoint fence needs manual recovery after the checkpoint verbs
// retire. Sending the operator back to team reset would only hit the same fence.
test("a proved-dead owner gets a manual remedy instead of the retired reset/restore loop", () => {
  const home = bus(`{"op":"team-reset","pid":${process.pid},"token":"t","boot_id":"boot:1","owner_start":"12345","phase":"checkpointing"}\n`);
  const path = join(home, "reset.fence.json");
  const savedId = process.env.TAP_BOOT_ID, savedLegacy = process.env.TAP_BOOT_ID_LEGACY;
  // Pin the current boot so `boot:1` resolves to a positively observed prior
  // boot (mismatch), not an unrelatable stamp that would fail closed to LIVE.
  process.env.TAP_BOOT_ID = "boot:424242";
  delete process.env.TAP_BOOT_ID_LEGACY;
  try {
    const refusal = resetFenceRefusal(home, "tap poll")!;
    expect(refusal.detail).toBe(`refusing tap poll — team bus is mid-reset (fence at ${path})`);
    expect(refusal.action).toContain(`remove the stale fence: rm ${path}`);
    expect(refusal.action).not.toContain("tap team reset");
    expect(refusal.action).not.toContain("restore");
    expect(launcherFenceRefusal(path, "session resume")).toBe(
      `refusing session resume — team bus is mid-reset (fence at ${path}); next: ${refusal.action}`);
  } finally {
    if (savedId === undefined) delete process.env.TAP_BOOT_ID; else process.env.TAP_BOOT_ID = savedId;
    if (savedLegacy === undefined) delete process.env.TAP_BOOT_ID_LEGACY; else process.env.TAP_BOOT_ID_LEGACY = savedLegacy;
  }
});

test("the removal remedy quotes a path the shell would split", () => {
  const home = join(root, "it's a bus");
  mkdirSync(home);
  writeFileSync(join(home, "reset.fence.json"), "{}\n");
  expect(resetFenceRefusal(home, "tap poll")!.action).toEndWith(`rm '${root}/it'\\''s a bus/reset.fence.json'`);
});
