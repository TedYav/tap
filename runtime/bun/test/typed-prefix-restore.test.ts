// Second-round review finding, adopted: optional draft restoration
// after a verified typed /compact never turns the result into a failure.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { submitVerifyLocked, type PaneEffects } from "../src/courier";
import { ServerUnresponsive } from "../src/tmux";
import { removeScratchTree } from "./support/scratch";

for (const fail of [false, true]) test(`a draft-restoration read failure=${fail} keeps the verified compact`, () => {
  const root = mkdtempSync(join(process.env.TAP_HOME!, "review-1561-restore-"));
  const backup = join(root, "backup.md");
  writeFileSync(backup, "---\n---\nunfinished human draft\n");
  let buffer = "unfinished human draft", sent = false;
  const effects: string[] = [];
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%7", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "claude" } as any),
    harnessEvidence: () => "alive",
    paneState: () => {
      if (sent && fail) throw new ServerUnresponsive("/fixture", "1");
      return buffer ? { state: "busy", text: buffer } : { state: "ready" };
    },
    clobber: () => { effects.push("clobber"); buffer = ""; return { kind: "cleared", lines: 1, chip: false, backupPath: backup }; },
    restoreInput: () => false,
    injectText: (_target, text) => { buffer += text; return true; },
    inputHasId: () => false,
    pressEnter: () => { effects.push("Enter"); sent = true; buffer = ""; return true; },
    settle: () => {},
    promptInput: () => ({ status: "text", text: buffer.replace(/ $/, "") }),
    regionInput: () => ({ status: "text", text: buffer }),
    submitFrame: (_target, _cmd, expected) => ({ state: buffer === expected ? "staged" : buffer ? "changed" : "empty", mode: "idle", width: "120" }),
  };
  try {
    let result: unknown;
    try { result = submitVerifyLocked("%7", "self-restore", "keep the work [[sv:self-restore]]",
      { paneId: "%7", serverEpoch: "srv:1:1", harness: "claude" }, fx,
      { registryPath: "", scriptsDir: "", agentFamilies: new Set(["claude"]), typedPrefix: "/compact ", preserveDraft: false, busHome: root }); }
    catch (error) { result = { threw: String(error) }; }
    expect(effects).toEqual(["clobber", "Enter"]);
    expect(result).toMatchObject({ status: "injected" });
  } finally { removeScratchTree(root); }
});
