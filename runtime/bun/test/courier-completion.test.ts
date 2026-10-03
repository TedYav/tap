import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completionEnter, submitVerifyLocked, type PaneEffects } from "../src/courier";
import { classifySubmitFrame } from "../src/submit-frame";
import { phaseRows } from "../src/submit-phase";
import { removeScratchTree } from "./support/scratch";
import { writeLiveFence } from "./support/live-fence";

const root = mkdtempSync(join(tmpdir(), "courier-completion-"));
afterAll(() => removeScratchTree(root));
const id = "willow-sentinel-test-20260906T144128Z-d26c789b3cec";
const wire = `[[TAP v0.23 note ${id}]]`;
const frame = (name: string) => readFileSync(new URL(`../../../skills/tap/scripts/smoke/fixtures/submit-verify/claude-queue-${name}.ansi`, import.meta.url), "utf8");
const before = frame("before"), after = frame("after");

for (const missesLanding of [false, true]) {
  test(`busy Claude gets one completion Enter, zero-Enter landing miss=${missesLanding}`, () => {
    const home = join(root, String(missesLanding));
    let typed = false, enters = 0;
    const effects: string[] = [];
    const fx: PaneEffects = {
      observePane: () => ({ paneId: "%5", session: "fake-busy-claude", serverEpoch: "epoch", panePid: "42", currentCommand: "claude" }),
      paneState: () => typed && !enters ? { state: "busy", text: wire } : { state: "ready" },
      copyMode: () => ({ status: "normal" }),
      injectText: (_, text) => { expect(text).toBe(wire); effects.push("type"); typed = true; return true; },
      inputHasId: () => false,
      // Constructed observation failure, not a recovered 04:48Z incident frame.
      // The captured Claude composer holds only our wire; a separate submit read
      // fails to observe it until the first key queues it.
      submitFrame: () => missesLanding && !enters ? { state: "unobservable", mode: "working", width: "80" }
        : classifySubmitFrame(enters ? after : before, "claude", wire),
      pressEnter: () => { effects.push("Enter"); enters++; return true; },
      settle: () => {},
    };
    const result = submitVerifyLocked("%5", id, wire, undefined, fx,
      { busHome: home, recipient: "worker", registryPath: "", scriptsDir: "/unused", agentFamilies: new Set(["claude"]) });
    expect(result.status).toBe("harness_queued");
    expect(effects).toEqual(missesLanding ? ["type", "Enter"] : ["type", "Enter", "Enter"]);
    const rows = phaseRows(home, id);
    expect(rows.filter(row => row.phase === "completion-Enter-intent")).toHaveLength(1);
    expect(rows.at(-1)).toMatchObject({ phase: "verify-result", enter_count: missesLanding ? 1 : 2, result: "queued" });
  });
}

for (const guard of ["pretype-draft", "new-draft", "unknown", "copy-mode", "identity", "late-reset", "no-type", "slash-control", "missing-wire", "sticky"]) {
  test(`completion Enter respects ${guard}`, () => {
    const home = join(root, guard);
    mkdirSync(home, { recursive: true });
    let enters = 0, observations = 0;
    const fx: PaneEffects = {
      observePane: () => ({ paneId: guard === "identity" && ++observations > 1 ? "%6" : "%5", session: "fixture", serverEpoch: "epoch", panePid: "42", currentCommand: "claude" }),
      harnessEvidence: () => "alive",
      paneState: () => guard === "unknown" ? { state: "unobservable", reason: "capture failed" }
        : guard === "missing-wire" ? { state: "ready" }
        : { state: "busy", text: guard === "new-draft" ? "human draft" : wire },
      copyMode: () => {
        if (guard === "late-reset") writeLiveFence(join(home, "reset.fence.json"));
        return guard === "copy-mode" ? { status: "copy-mode" } : { status: "normal" };
      },
      injectText: () => { throw new Error("completion must never retype"); }, inputHasId: () => false,
      pressEnter: () => { enters++; return true; }, settle: () => {},
      submitFrame: () => ({ state: guard === "sticky" ? "staged" : "empty", mode: "working", width: "80" }),
    };
    const result = completionEnter("%5", guard === "slash-control" ? "/compact" : wire,
      { status: "unverified", detail: "original landing refusal" },
      { textAttempted: guard !== "no-type", pretypeDraft: guard === "pretype-draft" },
      { paneId: "%5", harness: "claude", serverEpoch: "epoch" }, fx,
      { busHome: home, recipient: "worker", registryPath: "", scriptsDir: "/unused", agentFamilies: new Set(["claude"]) },
      () => {}, () => {}, () => {});
    expect(enters).toBe(["missing-wire", "sticky"].includes(guard) ? 1 : 0);
    expect(result.status).toBe("unverified");
    if (guard === "late-reset") expect("detail" in result && result.detail).toContain("mid-reset");
  });
}

test("rejected native inject retains its original refusal without a completion key", () => {
  let gone = false, enters = 0;
  const fx: PaneEffects = {
    observePane: () => gone ? null : { paneId: "%5", session: "fixture", serverEpoch: "epoch", panePid: "42", currentCommand: "claude" },
    paneState: () => ({ state: "ready" }),
    injectText: () => { gone = true; return false; }, inputHasId: () => false,
    pressEnter: () => { enters++; return true; }, settle: () => {},
  };
  expect(submitVerifyLocked("%5", id, wire, undefined, fx)).toEqual({ status: "unverified", detail: "sentinel injection did not complete on '%5'" });
  expect(enters).toBe(0);
});

for (const accepted of [false, true]) test(`completion consumes pending zero-Enter authority (accepted=${accepted})`, () => {
  let enters = 0;
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%5", session: "fixture", serverEpoch: "epoch", panePid: "42", currentCommand: "agy" }),
    paneState: () => ({ state: "busy", text: wire }),
    copyMode: () => ({ status: "normal" }),
    injectText: () => { throw new Error("no retype"); }, inputHasId: () => false,
    pressEnter: () => { enters++; return true; }, settle: () => {},
    submitFrame: () => ({ state: accepted ? "empty" : "staged", mode: "idle", width: "80" }),
  };
  const result = completionEnter("%5", wire,
    { status: "unverified", reprobePending: true, detail: "changed before Enter" },
    { textAttempted: true, pretypeDraft: false }, undefined, fx, undefined,
    () => {}, () => {}, () => {});
  expect(enters).toBe(1);
  expect(result.status).toBe(accepted ? "injected" : "unverified");
  expect("reprobePending" in result).toBe(false);
});

// tap-cw7g1: a pre-Enter withhold of our own ordinary sentinel does not leave it
// typed. The completion Enter submits the exact wire once, so no take-back is needed.
test("a pre-Enter withhold of our exact wire gets one completion Enter, never a retype", () => {
  const home = join(root, "cw7g1-withhold");
  let typed = false, enters = 0, frames = 0;
  const effects: string[] = [];
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%5", session: "fixture", serverEpoch: "epoch", panePid: "42", currentCommand: "claude" }),
    paneState: () => typed && !enters ? { state: "busy", text: wire } : { state: "ready" },
    copyMode: () => ({ status: "normal" }),
    injectText: () => { effects.push("type"); typed = true; return true; },
    inputHasId: () => true,
    // The landing read sees our wire staged; the pre-Enter read withholds.
    submitFrame: () => enters ? { state: "empty", mode: "working", width: "80" }
      : { state: frames++ ? "changed" : "staged", mode: "idle", width: "80" },
    pressEnter: () => { effects.push("Enter"); enters++; return true; },
    settle: () => {},
  };
  const result = submitVerifyLocked("%5", id, wire, undefined, fx,
    { busHome: home, recipient: "worker", registryPath: "", scriptsDir: "/unused", agentFamilies: new Set(["claude"]) });
  expect(effects).toEqual(["type", "Enter"]);
  expect(result.status).toBe("injected");
  expect(phaseRows(home, id).filter(row => row.phase === "Enter-intent")).toHaveLength(0);
  expect(phaseRows(home, id).filter(row => row.phase === "completion-Enter-intent")).toHaveLength(1);
});
