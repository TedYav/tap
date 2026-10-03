// tap-aimey: agy paints a paste progressively, so its id is visible before the
// wire is whole. The courier must wait for the full staged wire before Enter,
// and name the stranded state plainly when the bound runs out.
import { expect, test } from "bun:test";
import { submitVerifyLocked, type PaneEffects } from "../src/courier";
import type { SubmitFrame } from "../src/submit-frame";

const wire = '[[TAP v0.23 note plum-verbs-20260923T203120Z-126889b85511 preview="plum-verbs PR1 is open"]]';

function agyPane(stagedAfter: number) {
  let samples = 0, pastes = 0, submitted = false;
  const effects: string[] = [];
  const staged = () => samples > stagedAfter;
  const frame = (state: SubmitFrame["state"]): SubmitFrame => ({ state, mode: "idle", width: "237" });
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "agy" } as any),
    harnessEvidence: () => "alive",
    // The composer holds whatever has painted so far: the id first, the whole wire last.
    paneState: () => pastes > 0 && !submitted ? { state: "busy", text: staged() ? wire : wire.slice(0, 60) } : { state: "ready" },
    injectText: () => { pastes++; effects.push("paste"); return true; },
    inputHasId: () => pastes > 0 && !submitted,
    pressEnter: () => { effects.push(staged() ? "Enter" : "Enter-before-staged"); submitted = true; return true; },
    settle: () => {},
    submitFrame: () => submitted || pastes === 0 ? frame("empty") : ++samples > stagedAfter ? frame("staged") : frame("changed"),
  };
  return { fx, effects };
}
const bound = { paneId: "%1", harness: "agy", serverEpoch: "srv:1:1" };

test("agy waits through a progressive paint, then presses Enter once", () => {
  // Nine partial frames is ~0.9 s of paint: past the old ten-sample id-only landing.
  const pane = agyPane(9);
  expect(submitVerifyLocked("%1", "plum-verbs-20260923T203120Z-126889b85511", wire, bound, pane.fx).status).toBe("injected");
  // The first Enter submits the whole wire; the guarded completion Enter
  // (courier-completion.test.ts) then lands on the empty composer.
  expect(pane.effects).toEqual(["paste", "Enter", "Enter"]);
});

test("agy names a stranded wire when it never finishes painting", () => {
  const pane = agyPane(Number.MAX_SAFE_INTEGER);
  const result = submitVerifyLocked("%1", "plum-verbs-20260923T203120Z-126889b85511", wire, bound, pane.fx);
  expect(result.status).toBe("unverified");
  expect("detail" in result ? result.detail : "").toContain("shows our sentinel id but never the full wire; not submitted, and the input may be partial");
  expect(pane.effects).toEqual(["paste"]);
});
