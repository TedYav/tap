import { submitVerifyLocked, type PaneEffects } from "../src/courier";
import { classifySubmitFrame } from "../src/submit-frame";
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { phaseRows } from "../src/submit-phase";
const root = resolve(import.meta.dir, "../../..");
const id = "evidence-owned", expected = `[[TAP v0.23 note ${id}]]`;
test("native courier records four ordinary Enters and one completion Enter", () => {
  const home = mkdtempSync(join(tmpdir(), "native-phase-"));
  try {
    let text = "", enters = 0;
    const fx: PaneEffects = {
      observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "codex" } as any),
      paneState: () => ({ state: "ready" }),
      injectText: (_, input) => { text = input; return true; }, inputHasId: () => text.includes(id),
      pressEnter: () => {
        expect(phaseRows(home, id).at(-1)).toMatchObject({ phase: enters === 4 ? "completion-Enter-intent" : "Enter-intent", ordinal: enters + 1, enter_count: enters });
        enters++; return true;
      },
      settle: () => {}, submitFrame: () => classifySubmitFrame(`› ${text}\n`, "codex", expected),
    };
    expect(submitVerifyLocked("%1", id, expected, undefined, fx, { busHome: home, recipient: "peer", registryPath: "", scriptsDir: join(root, "skills/tap/scripts"), agentFamilies: new Set() }).status).toBe("unverified");
    const rows = phaseRows(home, id);
    expect(enters).toBe(5);
    expect(rows.filter(r => r.phase === "Enter-sent")).toHaveLength(5);
    expect(rows.at(-1)).toMatchObject({ phase: "verify-result", enter_count: 5, result: "unverified" });
  } finally { rmSync(home, { recursive: true }); }
});

for (const mode of ["guard-refusal", "interrupted", "post-enter-drift", "write-failure"] as const) {
  test(`native phase evidence survives ${mode}`, () => {
    const home = mkdtempSync(join(tmpdir(), "native-phase-control-"));
    const warnings: string[] = [];
    const warning = spyOn(console, "error").mockImplementation((...args) => { warnings.push(args.join(" ")); });
    try {
      if (mode === "write-failure") mkdirSync(join(home, "receipts", `${id}.submit-phases.jsonl`), { recursive: true });
      let text = "", enters = 0;
      const fx: PaneEffects = {
        observePane: () => {
          if ((mode === "guard-refusal" && phaseRows(home, id).at(-1)?.phase === "Enter-intent")
            || (mode === "post-enter-drift" && enters > 0)) return null;
          return { paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", panePid: "1", currentCommand: "codex" };
        },
        paneState: () => ({ state: "ready" }),
        injectText: (_, input) => { text = input; return true; }, inputHasId: () => text.includes(id),
        pressEnter: () => { enters++; if (mode === "interrupted") throw new Error("fixture interruption"); text = ""; return true; },
        settle: () => {}, submitFrame: () => classifySubmitFrame(`› ${text}\n`, "codex", expected),
      };
      const submit = () => submitVerifyLocked("%1", id, expected, undefined, fx,
        { busHome: home, recipient: "peer", registryPath: "", scriptsDir: join(root, "skills/tap/scripts"), agentFamilies: new Set() });
      if (mode === "interrupted") {
        expect(submit).toThrow("fixture interruption");
        expect(enters).toBe(1);
        expect(phaseRows(home, id).at(-1)?.phase).toBe("Enter-intent");
        expect(phaseRows(home, id).some(row => row.phase === "verify-result")).toBe(false);
      } else {
        const result = submit();
        if (mode === "write-failure") {
          expect(result.status).toBe("injected"); expect(enters).toBe(2);
          expect(warnings.some(line => line.includes("phase evidence unavailable"))).toBe(true);
        } else {
          expect(result.status).toBe("unverified");
          expect(enters).toBe(mode === "guard-refusal" ? 0 : 1);
          expect(phaseRows(home, id).at(-1)).toMatchObject({ phase: "verify-result", enter_count: enters, result: "unverified" });
        }
      }
    } finally { warning.mockRestore(); rmSync(home, { recursive: true }); }
  });
}
