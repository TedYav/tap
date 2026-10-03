// The fixture builder's failure contract, carried with it from observe.test.ts
// when payloadFromEnv left src (tap-8esm5).
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { payloadFromEnv } from "./support/observe-env-fixture";
import { removeScratchTree } from "./support/scratch";

test("F1: a snapshot path that is set but unreadable refuses, and never reads as an empty inventory", () => {
  // The distinction is the whole finding. "No snapshot was offered" and "the
  // snapshot I was told to read is gone" are different facts, and only the
  // first one may read as empty. Collapsing them turned a failed read into an
  // AFFIRMATIVE claim that no session exists — which Bash refresh admits to
  // its trim candidates, i.e. a live registration deleted on an unread file.
  const dir = mkdtempSync(join(tmpdir(), "tap-obs-f1."));
  const missing = join(dir, "sessions-that-vanished");
  try {
    const env = {
      TAP_OBS_SESSIONS_FILE: missing, TAP_OBS_SESSIONS_RC: "0",
      TAP_OBS_PANES_RC: "1", TAP_OBS_PS_RC: "1",
      TAP_OBS_NOW_TS: "1788492467", TAP_OBS_NOW_BOOT: "boot:2", TAP_OBS_BOOT_SET: "1",
    } as NodeJS.ProcessEnv;
    expect(() => payloadFromEnv([{ key: "seat", status: "active" }], env)).toThrow();
    // And the negative half: an UNSET path is still fine and still empty.
    const ok = payloadFromEnv([{ key: "seat", status: "active" }], { ...env, TAP_OBS_SESSIONS_FILE: "" });
    expect(ok.sessions_text).toBe("");
  } finally {
    removeScratchTree(dir);
  }
});
