import { expect, test } from "bun:test";
import { submitVerifyLocked, type PaneEffects, type SubmitAuthority } from "../src/courier";

const wire = "[[TAP v0.23 note dead-pane-control]]";
const live = { paneId: "%7", session: "fixture", serverEpoch: "1:2", panePid: "4242", currentCommand: "claude" };
const deadBand = { state: "unobservable", cause: "pane_dead", reason: "pane '%7' has exited; no live input is available" } as const;
const bound = { paneId: "%7", serverEpoch: "1:2", harness: "claude" };

for (const phase of ["identity", "initial-band", "final-band", "copy-mode"] as const) {
  test(`retained dead ${phase} defeats every readiness override without keys`, () => {
    const effects: string[] = [];
    let bands = 0;
    const fx: PaneEffects = {
      observePane: () => phase === "identity" ? "pane_dead" : live,
      harnessEvidence: () => "alive",
      paneState: () => (++bands >= (phase === "final-band" ? 2 : 1) && phase.includes("band")) ? deadBand : { state: "ready" },
      copyMode: () => phase === "copy-mode" ? { status: "unobservable", cause: "pane_dead", reason: deadBand.reason } : { status: "normal" },
      injectText: () => { effects.push("paste"); return true; },
      pressEnter: () => { effects.push("enter"); return true; },
      pressKeys: () => { effects.push("keys"); return true; },
      inputHasId: () => false, settle: () => {},
    };
    const authority: SubmitAuthority = { registryPath: "", scriptsDir: "", agentFamilies: new Set(["claude"]),
      forceNoPrompt: true, noPromptOk: true,
      deliveryFacts: { noSpool: true, urgent: false, recipientBound: true } };
    expect(submitVerifyLocked("%7", "dead-pane-control", wire, bound, fx, authority))
      .toMatchObject({ status: "band_busy", cause: "pane_dead" });
    expect(effects).toEqual([]);
  });
}

test("death after paste keeps the dead cause and withholds completion Enter", () => {
  let dead = false;
  const effects: string[] = [];
  const fx: PaneEffects = {
    observePane: () => dead ? "pane_dead" : live,
    harnessEvidence: () => "alive", paneState: () => dead ? deadBand : { state: "ready" },
    observeInput: () => dead ? deadBand : { state: "absent" },
    injectText: () => { effects.push("paste"); dead = true; return true; },
    pressEnter: () => { effects.push("enter"); return true; },
    inputHasId: () => false, settle: () => {},
  };
  expect(submitVerifyLocked("%7", "dead-pane-control", wire, bound, fx))
    .toMatchObject({ status: "unverified", cause: "pane_dead" });
  expect(effects).toEqual(["paste"]);
});

test("a pane exiting after a typed prefix keeps the cause and gets no payload or Enter", () => {
  let dead = false;
  const effects: string[] = [];
  const fx: PaneEffects = {
    observePane: () => dead ? "pane_dead" : live,
    harnessEvidence: () => "alive", paneState: () => ({ state: "ready" }),
    promptInput: () => ({ status: "text", text: "/goal" }),
    regionInput: () => ({ status: "text", text: "/goal " }),
    injectText: (_target, text) => { effects.push(text); dead = true; return true; },
    pressEnter: () => { effects.push("Enter"); return true; },
    inputHasId: () => false, settle: () => {},
  };
  const result = submitVerifyLocked("%7", "dead-prefix", "continue the work", bound, fx,
    { typedPrefix: "/goal ", registryPath: "", scriptsDir: "", agentFamilies: new Set(["claude"]) });
  expect(result).toMatchObject({ status: "unverified", cause: "pane_dead" });
  expect(effects).toEqual(["/goal "]);
});
