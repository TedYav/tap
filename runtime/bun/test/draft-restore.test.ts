import { expect, test } from "bun:test";
import { restorePlainDraft } from "../src/input-backup";
import type { PaneBand } from "../src/pane-state";

for (const failure of ["", "chip", "typed", "identity"]) test(`line restoration preserves bytes and stops on ${failure || "nothing"}`, () => {
  let composer = "", reads = 0;
  const pasted: string[] = [];
  const fx = {
    restoreInput: (_: string, text: string) => { pasted.push(text); composer += text; return true as const; },
    paneState: (): PaneBand => {
      reads++;
      if (pasted.length === 1 && failure === "chip") composer = "[Pasted Content 1001 chars]";
      if (reads === 3 && failure === "typed") composer += "someone typing";
      return composer.trim() ? { state: "busy", text: composer.trimEnd() } : { state: "ready" };
    },
    settle: () => {},
  };
  const text = "first\n  second\nthird\nfourth";
  expect(restorePlainDraft("%1", text, "claude", "claude", fx, () => failure !== "identity" || pasted.length === 0)).toBe(!failure);
  expect(pasted).toEqual(failure ? ["first\n"] : ["first\n", "  second\n", "third\n", "fourth"]);
  if (!failure) expect(composer).toBe(text);
});

for (const text of ["draft  ", "draft\n"]) test(`unobservable trailing bytes are not reported restored: ${JSON.stringify(text)}`, () => {
  let composer = "";
  expect(restorePlainDraft("%1", text, "claude", "claude", {
    restoreInput: (_, part) => { composer += part; return true; },
    paneState: () => composer ? {state: "busy", text: composer.trimEnd()} : {state: "ready"},
    settle: () => {},
  }, () => true)).toBe(false);
});
