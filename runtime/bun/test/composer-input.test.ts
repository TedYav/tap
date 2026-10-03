import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { composerInput } from "../src/submit-frame";
import { claudeBox } from "../src/pane-state";

const root = new URL("../../../", import.meta.url).pathname;
const fx = root + "skills/tap/scripts/smoke/fixtures/submit-verify/";
const WIRE = "[[TAP v0.23 ask maple-9-4-leader-20260904T081502Z-4b1a987aa918]]";

test("the three-way contract: text, unknown geometry, blocked", () => {
  // rc0 with text — possibly empty, which is a READABLE empty band.
  expect(composerInput("❯ \n", "hermes")).toEqual({ state: "text", text: "" });
  expect(composerInput(`❯ ${WIRE}\n`, "hermes")).toEqual({ state: "text", text: `${WIRE}\n` });
  // rc3: no prompt row at all. Absent geometry is never evidence of a clear band.
  expect(composerInput("just transcript\n", "hermes")).toEqual({ state: "unknown" });
  expect(composerInput("", "hermes")).toEqual({ state: "unknown" });
  // A claude frame with a prompt row but NO input box is also rc3: the claude
  // branch needs the box geometry, and a glyph alone is not it. Worth pinning
  // because the obvious reading — "there is a prompt, so there is a band" — is
  // what the generic branch does and the claude branch must not.
  expect(composerInput(`❯ ${WIRE}\n`, "claude-code")).toEqual({ state: "unknown" });
  // rc4: a modal is asking this seat's human a question. The bound may push
  // through rc3 and may never type over rc4 (CONTRACT.md, modal/startup holds).
  // A REAL captured overlay, not a hand-made one — my first version of this arm
  // invented an approval frame that the production predicate does not recognize,
  // so it asserted `blocked` against a frame no harness ever draws.
  const overlay = readFileSync(root + "skills/tap/scripts/smoke/fixtures/peek-harness-adapters/claude-feedback-empty-constructed.ansi", "utf8");
  expect(composerInput(overlay, "claude")).toEqual({ state: "blocked" });
  // The claude feedback overlay is a CLAUDE predicate: the same bytes under
  // another harness take that harness's branch and are ordinary text.
  expect(composerInput(overlay, "codex").state).toBe("text");
});

test("the claude reader returns claudeBox().raw, not .typed", () => {
  // `typed` strips per-row trailing blanks and trims the whole string; the door
  // has always emitted `raw`. The differential caught this on 12 captured
  // frames (`/compact /goal ` versus `/compact /goal`), and this reader feeds
  // the pending-input backup, where the bytes ARE the point.
  const capture = readFileSync(fx + "claude-slash-second-command.ansi", "utf8");
  const box = claudeBox(capture)!;
  expect(box.raw).not.toBe(box.typed);
  expect(composerInput(capture, "claude")).toEqual({ state: "text", text: box.raw });
});

test("the generic branch terminates every row it prints, and the adapter keeps that byte", () => {
  // The incumbent's tail was `awk { print line[i] }`. A non-empty region ends
  // in a newline; an empty one is empty. Reading the verdict through a plain
  // `$( )` lost that byte on 292 of 1395 differential cases, so the adapter
  // carries a sentinel — the arm below is what keeps it.
  expect(composerInput(`❯ first\n   indented second\n`, "hermes"))
    .toEqual({ state: "text", text: "first\n   indented second\n" });
  // Trailing blank rows go; a blank row ABOVE text stays, and so does the
  // leading padding of every row after the first.
  expect(composerInput(`❯ ${WIRE}\n\n\n`, "hermes")).toEqual({ state: "text", text: `${WIRE}\n` });
  expect(composerInput("❯ \n   second row\n", "hermes")).toEqual({ state: "text", text: "\n   second row\n" });
  // Empty region: no rows, no newline.
});

test("the LAST prompt row wins, and hermes keeps its named-profile prefix", () => {
  // The incumbent's awk reset its accumulator at every match, which is what
  // makes it the last rather than the first: a stale draft above a newer prompt
  // must never be read as the active band.
  expect(composerInput("❯ old draft\ntranscript\n❯ new draft\n", "hermes"))
    .toEqual({ state: "text", text: "new draft\n" });
  // A named Hermes profile may prefix the glyph; only `[A-Za-z0-9._-]+ ` is
  // accepted before it, so a working `⚕ ❯ …` prompt is not this shape.
  expect(composerInput(`ops-hermes ❯ ${WIRE}\n`, "hermes")).toEqual({ state: "text", text: `${WIRE}\n` });
});

test("cursor: no prompt region is unknown, unreadable box geometry is BLOCKED", () => {
  // The order matters and it is not `readFrame`'s: the region must exist before
  // the box reader is consulted, so these two cursor cases differ.
  expect(composerInput("just transcript\n", "cursor")).toEqual({ state: "unknown" });
  expect(composerInput(`→ ${WIRE}\n`, "cursor").state).toBe("blocked");
});

test("the prompt row's leading padding is awk's space class, not sed's and not ASCII", () => {
  // The incumbent spelled ONE pattern, `^[[:space:] ]*GLYPH`, and fed it to TWO
  // programs: awk chose the region row, `sed -E` stripped the first row. Those
  // two implementations of `[[:space:]]` disagree on macOS, so the port needs
  // BOTH classes — and the selector's is the narrow one. Measured against the
  // deleted program itself (a worktree at the base), not read off a man page:
  //
  //   accepted as padding   \t \v \f \r SPACE U+00A0
  //   NOT padding           U+001C-001F, U+0085, U+1680, U+2000, U+2007,
  //                         U+200A, U+2028, U+2029, U+202F, U+205F, U+3000,
  //                         U+FEFF, U+2060
  //
  // U+00A0 is the case that matters and the one the codex review bot caught:
  // `\u00a0❯ draft` read as `draft`/0 under the incumbent and 3 under my first
  // port, and 3 is the direction `tap_submit_verify`'s draft-clear types over.
  // U+2000 is the control that keeps the fix from over-widening to sed's class.
  // U+FEFF is here because `Bun.stdin.text()` STRIPS a leading BOM: the frame
  // is not a document and the Bash pipe was byte-transparent, so the CLI door
  // decodes with `ignoreBOM` and that row stays unreadable geometry.
  for (const c of ["\t", "\v", "\f", "\r", " ", "\u00a0"]) {
    const tag = `U+${c.codePointAt(0)!.toString(16).padStart(4, "0")}`;
    expect(`${tag}:${JSON.stringify(composerInput(`${c}❯ draft\n`, "hermes"))}`)
      .toBe(`${tag}:${JSON.stringify({ state: "text", text: "draft\n" })}`);
  }
  for (const c of ["\u001c", "\u001f", "\u0085", "\u1680", "\u2000", "\u2007",
                   "\u200a", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000",
                   "\ufeff", "\u2060"]) {
    const tag = `U+${c.codePointAt(0)!.toString(16).padStart(4, "0")}`;
    expect(`${tag}:${composerInput(`${c}❯ draft\n`, "hermes").state}`).toBe(`${tag}:unknown`);
  }
  // The hermes named-profile prefix rides the same class.
  expect(composerInput(`\u00a0ops-hermes ❯ draft\n`, "hermes")).toEqual({ state: "text", text: "draft\n" });
});
