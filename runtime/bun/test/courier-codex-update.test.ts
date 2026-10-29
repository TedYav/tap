import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { submitVerifyLocked, type PaneEffects, type SubmitAuthority } from "../src/courier";

const menu = readFileSync(join(import.meta.dir, "fixtures/agent-state/codex/update-available-real.txt"), "utf8");
// Reconstructed paint; a plain placeholder is intentionally refused below.
const empty = "› \x1b[2mAsk Codex to do anything\x1b[0m\n";
const id = "update-test-20261028T000000Z-abcdef123456";
const wire = `[[TAP v0.23 note fixture/${id}]]`;
const bound = { paneId: "%9", serverEpoch: "1:2", harness: "codex" };
const live = { paneId: "%9", session: "fixture", serverEpoch: "1:2", panePid: "4242", currentCommand: "codex" };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function scenario(options: { after?: string; urgent?: boolean; before?: string; keyFails?: boolean; lostAfter?: boolean;
  captureFails?: boolean; titleFails?: boolean; held?: boolean; copy?: boolean; pidBefore?: boolean; fence?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "codex-update-")); roots.push(home);
  const effects: string[] = [];
  let skipped = false, pasted = false, reads = 0;
  if (options.fence) writeFileSync(join(home, "reset.fence.json"), "{}");
  const authority: SubmitAuthority = { busHome: home, recipient: "peer", registryPath: "", scriptsDir: "",
    agentFamilies: new Set(["codex"]), deliveryFacts: { noSpool: false, urgent: !!options.urgent, recipientBound: true } };
  const fx: PaneEffects = {
    observePane: () => { reads++; return options.lostAfter && skipped ? { ...live, paneId: "%10" }
      : options.pidBefore && reads > 1 ? { ...live, panePid: "9999" } : live; },
    harnessEvidence: () => "alive",
    paneState: () => skipped && (options.after ?? empty) === empty ? { state: "ready" } : { state: "unobservable", reason: "approval prompt visible" },
    copyMode: () => options.copy ? { status: "copy-mode" } : { status: "normal" },
    captureEscaped: () => options.captureFails && skipped ? { ok: false } : { ok: true, frame: skipped ? options.after ?? empty : options.before ?? menu },
    paneTitle: () => options.titleFails ? { ok: false } : { ok: true, title: "Codex" },
    pressKeys: (_target, keys) => {
      expect(existsSync(join(home, "receipts", `${id}.attempted`))).toBe(true);
      effects.push(...keys); skipped = true; return !options.keyFails;
    },
    inputHeld: () => options.held ? { pane: "%9", epoch: "1:2", graceUntil: 0, snoozeUntil: Date.now() + 60_000,
      consumed: true, bareSince: null, senders: [] } : null,
    injectText: () => { effects.push("paste"); pasted = true; return true; },
    pressEnter: () => { effects.push("enter"); return true; },
    inputHasId: () => false,
    observeInput: () => ({ state: "present", text: id }),
    submitFrame: () => ({ state: pasted && effects.includes("enter") ? "empty" : "staged", mode: "idle", width: "80" }),
    settle: () => {},
  };
  return { home, effects, run: () => submitVerifyLocked("%9", id, wire, bound, fx, authority) };
}

test.each([false, true])("courier skips once before payload injection, urgent=%s", urgent => {
  const s = scenario({ urgent });
  expect(s.run()).toMatchObject({ status: "injected" });
  expect(s.effects[0]).toBe("Escape");
  expect(s.effects.filter(key => key === "Escape")).toHaveLength(1);
  expect(s.effects.indexOf("paste")).toBeGreaterThan(0);
});

test.each([
  { after: menu }, { after: "› human draft" }, { after: "› Ask Codex to do anything" },
  { captureFails: true }, { titleFails: true }, { keyFails: true }, { lostAfter: true },
])("uncertain update dismissal spends the attempt and never types: %j", options => {
  const s = scenario(options);
  expect(s.run()).toMatchObject({ status: "unverified" });
  expect(s.effects).toEqual(["Escape"]);
  expect(s.run().status).not.toBe("injected");
  expect(s.effects).toEqual(["Escape"]);
});

test.each([{ held: true }, { copy: true }, { pidBefore: true }, { fence: true }, { before: "unknown screen" },
  { before: readFileSync(join(import.meta.dir, "fixtures/agent-state/codex/hook-trust.txt"), "utf8") }])(
  "holds and other dialogs receive no recovery key: %j", options => {
    const s = scenario(options);
    expect(s.run().status).not.toBe("injected");
    expect(s.effects).toEqual([]);
    expect(existsSync(join(s.home, "receipts", `${id}.attempted`))).toBe(false);
  });
