import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { submitVerifyLocked, type PaneEffects } from "../src/courier";
import { removeScratchTree } from "./support/scratch";

test("attempt marker write failure refuses before any pane effect and preserves the payload", () => {
  const home = mkdtempSync(join(tmpdir(), "courier-attempt-failure-"));
  const receipts = join(home, "receipts"), payload = join(home, "payloads", "attempt-failure.md");
  mkdirSync(join(home, "payloads"));
  writeFileSync(payload, "canonical body\n");
  // A non-directory receipt parent prevents marker creation even under UID 0.
  writeFileSync(receipts, "blocked receipt directory\n");
  const effects: string[] = [];
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%5", session: "fixture", serverEpoch: "epoch", panePid: "42", currentCommand: "codex" }),
    paneState: () => ({ state: "ready" }),
    copyMode: () => ({ status: "normal" }),
    injectText: () => { effects.push("type"); return true; },
    inputHasId: () => true,
    pressEnter: () => { effects.push("Enter"); return true; },
    pressKeys: () => { effects.push("keys"); return true; },
    settle: () => {},
  };
  try {
    const result = submitVerifyLocked("%5", "attempt-failure", "[[TAP v0.23 ask attempt-failure]]", undefined, fx,
      { busHome: home, attemptIds: ["attempt-failure"], recipient: "worker", registryPath: "", scriptsDir: "/unused", agentFamilies: new Set(["codex"]) });
    expect(result.status).toBe("attempt_evidence_unwritable");
    expect("detail" in result && result.detail).toContain("cannot record delivery attempt:");
    expect("detail" in result && result.detail).toContain("ENOTDIR");
    expect(effects).toEqual([]);
    expect(readFileSync(payload, "utf8")).toBe("canonical body\n");
    expect(existsSync(join(receipts, "attempt-failure.attempted"))).toBe(false);
    expect(readFileSync(receipts, "utf8")).toBe("blocked receipt directory\n");
  } finally {
    removeScratchTree(home);
  }
});
