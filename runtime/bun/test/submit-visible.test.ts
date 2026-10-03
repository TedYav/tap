import { test, expect } from "bun:test";
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { classifySubmitFrame, sentinelSubmitDecision, visibleSentinel, composerMatches } from "../src/submit-frame";
import { classifyPane, toPaneBand } from "../src/pane-state";
import { submitVerifyLocked, type PaneEffects } from "../src/courier";
import { phaseRows } from "../src/submit-phase";
import { stuckSentinelFieldsFromRegion } from "../src/stuck-sentinel";
const root = new URL("../../..", import.meta.url).pathname;
const fixture = (name: string) => readFileSync(new URL(`../../../skills/tap/scripts/smoke/fixtures/submit-verify/${name}.ansi`, import.meta.url), "utf8");
const wire = "[[TAP v0.23 note visible-owned]]";
const rule = "─".repeat(50);

for (const [harness, capture] of [
  ["claude", `${rule}\n❯ ${wire} extra text\nunknown bottom paint`],
  ["codex", `› ${wire} extra text\nnew status line with https://example.test/PR/failed`],
  ["cursor", `▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄\n→ ${wire} extra text\nunknown bottom paint`],
  ["agy", `> ${wire} extra text\nunknown bottom paint`],
  ["opencode", `┃ ${wire} extra text\n┃ unknown footer\nunknown bottom paint`],
] as const) {
  test(`${harness}: complete input survives unknown or missing border/footer and extra text`, () => {
    expect(sentinelSubmitDecision(capture, harness, wire)).toEqual({ action: "submit" });
    expect(visibleSentinel(capture, harness)).toBe(wire);
    expect(sentinelSubmitDecision(capture.replace(wire, wire.slice(0, -2)), harness, wire, true)).toMatchObject({ action: "withhold", reason: "not-visible" });
  });
}

test("transcript-only wire above a newer input prompt never authorizes Enter", () => {
  for (const [harness, glyph] of [["claude", "❯"], ["codex", "›"], ["cursor", "→"], ["agy", ">"]]) {
    const capture = `${glyph} ${wire}\nold transcript\n${glyph} human draft\nnew footer`;
    expect(sentinelSubmitDecision(capture, harness!, wire, true)).toMatchObject({ action: "withhold", reason: "not-visible" });
    expect(visibleSentinel(capture, harness!)).toBeNull();
  }
  expect(visibleSentinel(`› ${wire} ${wire}`, "codex")).toBeNull();
});

test("Codex startup braille overdraw remains a parseable visible sentinel", () => {
  const capture = fixture("codex-startup-braille-sentinel");
  const expected = `[[TAP v0.23 ask fable-builder-20260911T082728Z-5937c899a952 preview="Identity gate before your first work order:
  run \`tap whoami\` and reply with exactly its output plus one line naming your"]]`;
  const extracted = visibleSentinel(capture, "codex");
  expect(extracted).toBe(expected);
  expect(sentinelSubmitDecision(capture, "codex", expected)).toEqual({ action: "submit" });
  const anchorPaint = capture.replace("[[TAP ", "[[TAP⠠");
  expect(visibleSentinel(anchorPaint, "codex")).toBe(expected);
  expect(sentinelSubmitDecision(anchorPaint, "codex", expected)).toEqual({ action: "submit" });
  expect(stuckSentinelFieldsFromRegion(extracted!, "codex")).toEqual({ ok: true, fields: { id: "fable-builder-20260911T082728Z-5937c899a952", to: "", wire: "v023" } });
  const malformed = stuckSentinelFieldsFromRegion("[[TAP v0.23 ask not/an/id]]", "codex");
  expect(malformed.ok).toBe(false);
  expect(malformed.ok ? "" : malformed.reason).toContain("slot 3 is not an id (saw 'not/an/id')");

  const ambiguous = "[[TAP v0.23 ask seat⠠digest]]";
  expect(visibleSentinel(`› ${ambiguous}`, "codex")).toBe(ambiguous);
  expect(sentinelSubmitDecision(`› ${ambiguous}`, "codex", "[[TAP v0.23 ask seat digest]]")).toEqual({ action: "withhold", reason: "not-visible" });
  expect(stuckSentinelFieldsFromRegion(ambiguous, "codex").ok).toBe(false);

  const claudeCapture = capture.replace(/^›/, "❯");
  expect(visibleSentinel(claudeCapture, "claude")).not.toBe(expected);
  expect(sentinelSubmitDecision(claudeCapture, "claude", expected)).toEqual({ action: "withhold", reason: "not-visible" });

  const expectedBraille = '[[TAP v0.23 ask fable-builder-20260911T082728Z-5937c899a952 preview="spinner ⠋ done"]]';
  expect(sentinelSubmitDecision(`› ${expectedBraille.replace("⠋", "⣿")}`, "codex", expectedBraille)).toEqual({ action: "withhold", reason: "not-visible" });
});

test("AGY blockers defer to liveness; Codex approval and the Claude feedback draft stay held", () => {
  const feedback = readFileSync(new URL("../../../skills/tap/scripts/smoke/fixtures/peek-harness-adapters/claude-feedback-empty-constructed.ansi", import.meta.url), "utf8");
  const claude = feedback.replace(/([❯›])[^\n]*/, `$1 ${wire}`);
  const agy = `${rule}\n> ${wire}\n${rule}\nRequesting permission for: command\nDo you want to proceed?\nTab amend`;
  const codex = `› ${wire}\nPress enter to confirm or esc to cancel`;
  for (const [harness, capture] of [["claude", claude], ["agy", agy], ["codex", codex]]) {
    expect(sentinelSubmitDecision(capture!, harness!, wire)).toEqual({ action: "withhold", reason: "dialog" });
    expect(sentinelSubmitDecision(capture!, harness!, wire, true)).toEqual(harness === "agy" ? { action: "submit" } : { action: "withhold", reason: "dialog" });
    expect(sentinelSubmitDecision(capture!.replace(wire, "[Pasted text #1 +4 lines]"), harness!, wire, true).action).toBe("withhold");
  }
});

test("paste-only input cannot supply expected bytes and URLs in wire text are ordinary text", () => {
  expect(sentinelSubmitDecision(`❯ [Pasted text #1 +4 lines]`, "claude", wire, true)).toEqual({ action: "withhold", reason: "chip" });
  const urlWire = "[[TAP v0.23 note visible-owned: read https://example.test/a]]";
  expect(sentinelSubmitDecision(`› ${urlWire}`, "codex", urlWire)).toEqual({ action: "submit" });
  // No active composer is supplied by this URL-entry surface. Do not invent
  // URL keywords as a detector for what the existing fixtures do not establish.
  expect(sentinelSubmitDecision(`Server URL: ${wire}\nEnter to connect`, "codex", wire, true).action).toBe("withhold");
});

test("slash controls still require complete exact ownership", () => {
  const expected = "/compact keep the verification evidence [[sv:control]]";
  const capture = `${rule}\n❯ ${expected} arbitrary extra\n${rule}`;
  expect(composerMatches(capture, "claude", expected)).toBe(false);
  expect(composerMatches(capture.replace(" arbitrary extra", ""), "claude", expected)).toBe(true);
});

for (const [name, harness] of [["claude-statusline-pr-agents", "claude"], ["claude-statusline-2shells", "claude"], ["codex-no-context-footer", "codex"]]) {
  test(`${name}: native before/after effect records verified Enter and completion Enter`, () => {
    const capture = fixture(name!);
    const expected = visibleSentinel(capture, harness!)!;
    const id = expected.match(/(?:ask|note) ([^\]]+)/)![1]!;
    const home = mkdtempSync(join(tmpdir(), "visible-native-"));
    mkdirSync(join(home, "receipts"));
    let enters = 0;
    try {
      const fx: PaneEffects = {
        observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: harness === "claude" ? "2.1.257" : "codex" } as any),
        harnessEvidence: () => "alive", paneState: () => ({ state: "ready" }), injectText: () => true, inputHasId: () => true,
        pressEnter: () => { enters++; return true; }, settle: () => {},
        submitFrame: (_target, command, text, alive) => classifySubmitFrame(enters ? (harness === "codex" ? "› \n" : capture.replace(expected, "")) : capture, command, text, "50", alive),
      };
      expect(submitVerifyLocked("%1", id, expected, { paneId: "%1", harness: harness!, serverEpoch: "srv:1:1" }, fx, { busHome: home, recipient: "peer", registryPath: "", scriptsDir: join(root, "skills/tap/scripts"), agentFamilies: new Set() }).status).toBe("injected");
      expect(enters).toBe(2);
      expect(phaseRows(home, id).at(-1)).toMatchObject({ phase: "verify-result", enter_count: 2, result: "verified" });
    } finally { rmSync(home, { recursive: true }); }
  });

}

test("visible text followed by unknown post-Enter chrome records unverified, without reinjection", () => {
  let enters = 0;
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "codex" } as any),
    paneState: () => enters ? { state: "unobservable", reason: "unrecognized outcome" } : { state: "ready" }, injectText: () => true, inputHasId: () => true,
    pressEnter: () => { enters++; return true; }, settle: () => {},
    submitFrame: () => classifySubmitFrame(enters ? "unknown outcome" : `› ${wire}\nunmodelled footer`, "codex", wire),
  };
  expect(submitVerifyLocked("%1", "visible-owned", wire, undefined, fx).status).toBe("unverified");
  expect(enters).toBe(1);
});


test("OpenCode visible wire reaches native landing when the old prompt-id adapter cannot observe it", () => {
  let enters = 0;
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "opencode" } as any),
    paneState: () => ({ state: "ready" }), injectText: () => true, inputHasId: () => false,
    observeInput: () => ({ state: "unobservable", reason: "no prompt glyph" }),
    pressEnter: () => { enters++; return true; }, settle: () => {},
    submitFrame: () => classifySubmitFrame(`┃ ${enters ? "" : wire}\n┃ Build · model\n╹▀▀▀▀▀▀▀▀▀▀`, "opencode", wire),
  };
  expect(submitVerifyLocked("%1", "visible-owned", wire, undefined, fx).status).toBe("injected");
  expect(enters).toBe(2);
});


test("native Enter never answers Codex approval, including with current attestation", () => {
  for (const bound of [false, true]) {
    let enters = 0, typed = false;
    const fx: PaneEffects = {
      observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "codex" } as any),
      harnessEvidence: () => "alive", paneState: () => typed ? toPaneBand(classifyPane(`› ${wire}\nPress enter to confirm or esc to cancel`, "codex", false)) : { state: "ready" }, injectText: () => { typed = true; return true; }, inputHasId: () => true,
      pressEnter: () => { enters++; return true; }, settle: () => {},
      submitFrame: (_pane, command, text, alive) => classifySubmitFrame(enters ? "› \n" : `› ${wire}\nPress enter to confirm or esc to cancel`, command, text, "50", alive),
    };
    expect(submitVerifyLocked("%1", "visible-owned", wire, bound ? { paneId: "%1", harness: "codex", serverEpoch: "srv:1:1" } : undefined, fx).status).toBe("unverified");
    expect(enters).toBe(0);
  }
});

for (const outcome of ["working", "unknown", "still-visible"]) {
  const working = readFileSync(new URL("./fixtures/agent-state/claude/working.txt", import.meta.url), "utf8");
  const after = outcome === "unknown" ? "unrecognized outcome" : outcome === "still-visible" ? `${wire}\n${working}` : working;
  test(`native Claude working-transition witness: ${outcome}`, () => {
    let enters = 0;
    const fx: PaneEffects = {
      observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "claude" } as any),
      paneState: () => enters ? toPaneBand(classifyPane(after, "claude", false)) : { state: "ready" }, injectText: () => true, inputHasId: () => true,
      pressEnter: () => { enters++; return true; }, settle: () => {},
      submitFrame: () => classifySubmitFrame(enters ? after : `${rule}\n❯ ${wire}\n${rule}`, "claude", wire),
    };
    expect(submitVerifyLocked("%1", "visible-owned", wire, undefined, fx).status).toBe(outcome === "working" ? "injected" : "unverified");
    expect(enters).toBe(1);
  });

}

test("native frame-mode retains the established Claude and AGY terminal witnesses", () => {
  for (const harness of ["claude", "agy"]) {
    const input = readFileSync(new URL(`./fixtures/agent-state/${harness}/working.txt`, import.meta.url), "utf8");
    const native = spawnSync("bun", [join(root, "runtime/bun/src/submit-frame.ts"), "frame-mode", harness], { input, encoding: "utf8" });
    expect(native.status).toBe(0);
    expect(native.stdout.trim()).toBe("working");
  }
});
