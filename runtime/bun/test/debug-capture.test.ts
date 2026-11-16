import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Bus } from "../src/bus";
import { rememberDebugFrame, captureCourierFailure } from "../src/debug-capture";
import { decodeAttemptRows, joinAttemptRows } from "../src/courier-contract";
import { submitNotice } from "../src/notice-submit";

test("an unverified submit keeps its last observed frame; on/off changes in the same process", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-debug-native-"));
  const old = process.env.TAP_INDEX_HOME;
  process.env.TAP_INDEX_HOME = join(root, "index");
  const enabled = join(process.env.TAP_INDEX_HOME, "debug/enabled.json");
  mkdirSync(join(process.env.TAP_INDEX_HOME, "debug"), { recursive: true });
  const bus = new Bus(join(root, "bus"));
  bus.ensureDirs();
  const frame = "\x1b[32m› [[TAP v0.23 ask\n  team/message]]\x1b[0m\n";
  try {
    for (const on of [false, true, false]) {
      if (on) writeFileSync(enabled, JSON.stringify({ id: "probe", directory: root }));
      else rmSync(enabled, { force: true });
      const id = `probe-${on ? "on" : existsSync(join(bus.home, "marker")) ? "off-again" : "off"}`;
      let runs = 0;
      const result = captureCourierFailure({ id, pane: "%7", harness: "claude",
        sentinel: "[[TAP v0.23 ask team/message]]", busHome: bus.home }, () => {
        runs++;
        rememberDebugFrame(frame);
        return { status: "unverified", detail: "sentinel did not leave the input band" };
      });
      expect(result.status).toBe("unverified");
      expect(runs).toBe(1);
      const artifact = join(bus.home, "receipts", `${id}.submit-unverified.frame`);
      expect(existsSync(artifact)).toBe(on);
      if (on) expect(readFileSync(artifact, "utf8")).toBe(frame);
      writeFileSync(join(bus.home, "marker"), "");
    }
  } finally {
    if (old === undefined) delete process.env.TAP_INDEX_HOME; else process.env.TAP_INDEX_HOME = old;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a diagnostic summary is not attempt evidence: the notice wake for the same id still starts", () => {
  const root = mkdtempSync(join(tmpdir(), "debug-panel-"));
  const old = process.env.TAP_INDEX_HOME;
  process.env.TAP_INDEX_HOME = join(root, "index");
  const bus = new Bus(join(root, "bus")); bus.ensureDirs();
  mkdirSync(join(root, "index/debug"), { recursive: true });
  writeFileSync(join(root, "index/debug/enabled.json"), JSON.stringify({ id: "probe", directory: root }));
  const attempts = bus.payloadPath("pre-effect").replace(/\.md$/, ".attempts");
  try {
    const first = captureCourierFailure({ id: "pre-effect", pane: "%7", harness: "claude", sentinel: "wire", busHome: bus.home },
      () => ({ status: "band_busy", detail: "busy draft" }), true);
    expect(first.status).toBe("band_busy");
    expect(existsSync(attempts)).toBe(false);
    expect(existsSync(bus.payloadPath("pre-effect").replace(/\.md$/, ".debug.attempts"))).toBe(true);
    // The notice wake creates `.attempts` exclusively and refuses existing
    // evidence; a summary written there would end the wake before it began.
    writeFileSync(bus.payloadPath("pre-effect"),
      "---\nid: pre-effect\nfrom: courier\nto: alice\nkind: delivery-failed\nreply: settle-only\n---\nFailure notice\n");
    let submits = 0;
    const outcome = submitNotice({ bus, id: "pre-effect", pane: "sender:0.0",
      bound: { paneId: "%7", serverEpoch: "srv:1:2", harness: "claude", handle: "alice" },
      authority: { registryPath: join(root, "sender-registry.json"), scriptsDir: "/unused", agentFamilies: new Set(["claude"]) } },
      () => { submits++; return { status: "injected" }; });
    expect(outcome.status).toBe("injected");
    expect(submits).toBe(1);
    expect(joinAttemptRows(decodeAttemptRows(readFileSync(attempts, "utf8"))).paired[0]!.outcome.disposition).toBe("delivered");
  } finally {
    if (old === undefined) delete process.env.TAP_INDEX_HOME; else process.env.TAP_INDEX_HOME = old;
    rmSync(root, { recursive: true, force: true });
  }
});
