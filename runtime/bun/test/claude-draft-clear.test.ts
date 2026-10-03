import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clobberBand, type PaneEffects } from "../src/deliver";
import { submitVerifyLocked } from "../src/courier";
import { classifySubmitFrame } from "../src/submit-frame";
import { inputBackupBody } from "../src/input-backup";
import { removeScratchTree } from "./support/scratch";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeScratchTree(root); });

// Measured in isolated Claude 2.1.282, 118x50: C-u clears the current
// line, leaving its newline; BSpace joins the preceding line. Twelve lines
// retain their first four after eight cycles and clear on the twelfth C-u.
for (const chip of [false, true]) test(`twelve-line Claude draft clears before verified submission (chip=${chip})`, () => {
  const home = mkdtempSync(join(tmpdir(), "claude-draft-")); roots.push(home);
  mkdirSync(join(home, "receipts"));
  const draft = Array.from({ length: 12 }, (_, n) => chip && n === 1 ? "[Pasted text #1 +5 lines]" : `line${n + 1}`).join("\n");
  let text = draft, clears = 0, injections = 0, enters = 0;
  const bound = { paneId: "%1", serverEpoch: "srv:1:1", harness: "claude" };
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "claude" } as any),
    harnessEvidence: () => "alive",
    paneState: () => text ? { state: "busy", text } : { state: "ready" },
    clearInput: () => { clears++; const end = text.lastIndexOf("\n"); text = end < 0 ? "" : text.slice(0, end + 1); return true; },
    backspace: () => { text = text.slice(0, -1); return true; },
    injectText: (_target, wire) => { expect(text).toBe(""); injections++; text = wire; return true; },
    inputHasId: (_target, _command, id) => text.includes(id),
    pressEnter: () => { enters++; text = ""; return true; }, settle: () => {},
    submitFrame: (_target, command, wire, alive) => classifySubmitFrame(`────────────────────\n❯ ${text}\n────────────────────\n`, command, wire, "20", alive),
  };
  fx.clobber = (target, command, owner, backup, permit) => clobberBand(target, command, owner, {
    ...fx,
    clearInput: t => permit && !permit() ? false : fx.clearInput!(t),
    backspace: t => permit && !permit() ? false : fx.backspace!(t),
  }, backup, "");
  const result = submitVerifyLocked("%1", "draft-test", "[[TAP v0.23 note draft-test]]", bound, fx,
    { busHome: home, registryPath: "", scriptsDir: "", recipient: "peer", preserveDraft: false, agentFamilies: new Set() });
  expect(result.status).toBe("injected");
  expect(clears).toBe(12);
  expect(injections).toBe(1);
  expect(enters).toBe(1);
  const backups = readdirSync(join(home, "input-backups"));
  expect(backups).toHaveLength(1);
  const raw = readFileSync(join(home, "input-backups", backups[0]!), "utf8");
  expect(inputBackupBody(raw)).toBe(draft);
  if (chip) expect(raw).toContain("capture_status: incomplete");
});

test("an unchanging long Claude draft retains the eight-cycle no-progress bound", () => {
  const home = mkdtempSync(join(tmpdir(), "claude-stalled-")); roots.push(home);
  const text = Array.from({ length: 20 }, () => "unchanged").join("\n");
  let clears = 0;
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "claude" } as any),
    paneState: () => ({ state: "busy", text }), clearInput: () => { clears++; return true; },
    backspace: () => true, injectText: () => { throw new Error("not a submit"); },
    inputHasId: () => false, pressEnter: () => { throw new Error("not a submit"); }, settle: () => {},
  };
  const verdict = clobberBand("%1", "claude", { paneId: "%1", serverEpoch: "srv:1:1", harness: "claude" }, fx,
    { directory: join(home, "input-backups"), handle: "peer", payloadId: "stalled", pane: "%1" }, "");
  // Persistent input residue withholds the sentinel instead of injecting
  // over it; the backup is the recovery authority.
  expect(verdict.kind).toBe("possible-failure");
  expect(clears).toBe(8);
  const backups = readdirSync(join(home, "input-backups"));
  expect(backups).toHaveLength(1);
  expect(inputBackupBody(readFileSync(join(home, "input-backups", backups[0]!), "utf8"))).toBe(text);
});
