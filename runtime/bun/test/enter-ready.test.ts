import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { enterReady } from "../src/submit-frame";

const root = new URL("../../../", import.meta.url).pathname;
const read = (p: string) => readFileSync(root + p, "utf8");

const staged = read("skills/tap/scripts/smoke/fixtures/submit-verify/codex-idle-staged-80.ansi");
const stagedId = "sender-20260906T220111Z-21f26672936f";
const stagedWire = `[[TAP v0.23 note ${stagedId}]]`;

// Two frames the composer reader refuses, one each way. `cursor` on a claude
// frame finds no closed border and answers `blocked` (rc 4 through the Bash
// reader); `claude` on a codex frame answers `unknown` (rc 3). Measured against
// the native composerInput reader, not assumed from the harness name.
const blockedFrame = read("skills/tap/scripts/smoke/fixtures/submit-verify/claude-queue-before.ansi");
const unknownFrame = read("runtime/bun/test/fixtures/agent-state/codex/idle.txt");

test("auto permissions without auto-ready refuse, and the refusal outlives a failed capture", () => {
  // The incumbent checked this gate BEFORE capturing, so a gated call issued no
  // capture at all. The gate now lives in the module, which is only reachable
  // through a capture — so the refusal has to survive the capture failing, or
  // moving it inward would have changed what a gated call answers.
  expect(enterReady(staged, staged, "codex", stagedWire, stagedId, false, false, false, "auto", false, true)).toBe("gated");
  expect(enterReady(staged, staged, "codex", stagedWire, stagedId, false, false, false, "auto", false, false)).toBe("gated");


});

test("a capture that fails is refused without claiming the composer changed", () => {
  expect(enterReady(staged, staged, "codex", stagedWire, stagedId, false, false, false, "bypass", false, false)).toBe("unread");

});

test("an unreadable composer withholds rather than reporting the input consumed", () => {
  // Without the `observable` term, `normalizeInputMatch("")` fails to contain the
  // id and an unread composer reports `consumed` — the courier's signal that the
  // harness took the text. It did not; nothing was read.
  for (const [name, frame, harness] of [
    ["blocked", blockedFrame, "cursor"],
    ["unknown", unknownFrame, "claude"],
  ] as const) {
    expect(`${name}:${enterReady(frame, frame, harness, "__absent__", "absent-id", false, true, false, "bypass", false, true)}`)
      .toBe(`${name}:withhold`);
  }
});

test("blocked and unknown reach the same Enter-readiness outcome", () => {
  // The Bash reader answers three ways, but its one caller here collapsed rc 3
  // and rc 4 into the same pair. This proves the collapse at the outcome rather
  // than inferring it from the shape of the `||` that produced it.
  for (const entered of [false, true]) {
    for (const chip of [false, true]) {
      const b = enterReady(blockedFrame, blockedFrame, "cursor", "__absent__", "absent-id", chip, entered, false, "bypass", false, true);
      const u = enterReady(unknownFrame, unknownFrame, "claude", "__absent__", "absent-id", chip, entered, false, "bypass", false, true);
      expect(`entered=${entered} chip=${chip}: ${b}`).toBe(`entered=${entered} chip=${chip}: ${u}`);
    }
  }
});

test("a readable composer that no longer holds our id reports the input consumed", () => {
  // The differential kills a consumed-to-withhold mutant on 4,836 cases, but a
  // differential is not checked in and does not run in CI. Without this arm the
  // file passes while the courier loses its one signal that the harness took the
  // text and an unverified resend would be licensed.
  expect(enterReady(staged, staged, "codex", "__absent__", "absent-id", false, true, false, "bypass", false, true))
    .toBe("consumed");
  // Not entered yet is not consumed: nothing was submitted to be taken.
  expect(enterReady(staged, staged, "codex", "__absent__", "absent-id", false, false, false, "bypass", false, true))
    .toBe("withhold");
});

test("a paste chip is not a consumed input", () => {
  // The harness matters here and my first draft got it wrong: on the claude
  // paste-collapse fixtures `composerInput` answers `unknown`, so `observable` is
  // false, the consumed branch is never reached and the chip term is never
  // evaluated. That arm passed without testing anything. Measured across the
  // corpus, exactly three fixtures reach a readable composer that IS a collapse —
  // codex and opencode, not claude.
  //
  // A collapsed paste renders as a chip, so our id is genuinely absent from the
  // composer while the text still sits there unsubmitted. Reading that as
  // consumed would report a delivery that never happened.
  // `expected` must be a well-formed wire that is simply not in this frame. A
  // bare non-wire string takes a different path in `composerMatches` and returns
  // `ready` under a chip, which hides the branch instead of testing it.
  const absentId = "absent-20260101T000000Z-000000000000";
  const absentWire = `[[TAP v0.23 note ${absentId}]]`;
  for (const [harness, name] of [
    ["codex", "codex-paste-collapse"],
    ["opencode", "opencode-paste-collapse"],
    ["opencode", "opencode-short-paste-collapse"],
  ] as const) {
    const collapsed = read(`skills/tap/scripts/smoke/fixtures/submit-verify/${name}.ansi`);
    const withChip = enterReady(collapsed, collapsed, harness, absentWire, absentId, true, true, false, "bypass", false, true);
    const noChip = enterReady(collapsed, collapsed, harness, absentWire, absentId, false, true, false, "bypass", false, true);
    // The pair is the assertion: without the chip allowance the same frame DOES
    // read consumed, which is what makes the chip term load-bearing rather than
    // decorative.
    expect(`${name} chip=1: ${withChip}`).toBe(`${name} chip=1: withhold`);
    expect(`${name} chip=0: ${noChip}`).toBe(`${name} chip=0: consumed`);
  }
});

test("a staged frame still reads ready", () => {
  expect(enterReady(staged, staged, "codex", stagedWire, stagedId, false, false, false, "bypass", false, true)).toBe("ready");

});

test("Claude's wider compact rows can queue while working without accepting changed drafts", () => {
  const fixture = "skills/tap/scripts/smoke/fixtures/submit-verify/claude-control-wrap-20260922";
  const idle = read(fixture + ".txt");
  const expected = read(fixture + "-expected.txt").trim();
  const id = "self-20260923T013308Z-df703244";
  const working = idle.replace("✻ Cogitated for 47s · done 6:33 PM", "✻ Thinking… (esc to interrupt)")
    .replace("⏵⏵ bypass permissions on", "⏵⏵ bypass permissions on · esc to interrupt");
  const verdict = (frame: string) => enterReady(frame, frame, "claude", expected, id, false, false, true, "bypass", false, true);
  for (const frame of [idle, working]) {
    expect(verdict(frame)).toBe("ready");
    for (const changed of [
      frame.replace("preserve the", "preservethe"),
      frame.replace("burn 11253", "burn 99999"),
      frame.replace(`[[sv:${id}]]`, "[[sv:other-command]]"),
      frame.replace(`[[sv:${id}]]`, `[[sv:${id}]] extra draft`),
      frame.replace("  for aspen-leader", "\n  for aspen-leader"),
      frame.replace("❯ /compact preserve", "❯ /compact\n  preserve"),
    ]) expect(verdict(changed)).toBe("withhold");
  }
});

test("a live 145-column capture whose continuation row wraps one cell early is ready (tap-arm4w)", () => {
  // Raw capture of nightwatch's refused self compact at 17:21Z on 2026-09-23.
  const fixture = "skills/tap/scripts/smoke/fixtures/submit-verify/claude-control-wrap-20260923";
  const frame = read(fixture + ".ansi");
  const expected = read(fixture + "-expected.txt");
  const id = "self-20260923T172121Z-cbe03497";
  const verdict = (f: string) => enterReady(f, f, "claude", expected, id, false, false, false, "bypass", false, true);
  expect(verdict(frame)).toBe("ready");
  // Sandboxed live probe at 100 columns: "bj" would have ended at width minus four.
  const probe = read(fixture + "-probe100.ansi");
  expect(enterReady(probe, probe, "claude", read(fixture + "-probe100-expected.txt"), "self-probe-3",
    false, false, false, "bypass", false, true)).toBe("ready");
  for (const changed of [
    frame.replace("load-flake", "load-flak"),
    frame.replace(`[[sv:${id}]]`, `[[sv:${id}]] extra`),
    frame.replace("  specimens bus-archive", "\n  specimens bus-archive"),
    frame.replace("❯ \x1b[38;2;153;204;255m/compact\x1b[39m preserve", "❯ \x1b[38;2;153;204;255m/compact\x1b[39m\n  preserve"),
  ]) expect(verdict(changed)).toBe("withhold");
});
