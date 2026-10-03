// tap-lx4z0: a band holding only blanks is ready on every harness, and a
// whitespace-only backup is never typed back after an injection.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { submitVerifyLocked, type PaneEffects } from "../src/courier";
import { clobberBand, type PaneEffects as DeliveryEffects } from "../src/deliver";
import { BLANK_DRAFT_NOTICE, INCOMPLETE_DRAFT_NOTICE, restorePlainDraft } from "../src/input-backup";
import { CLAUDE_SCROLLED_DRAFT_REASON, classifyPane, claudeComposerCap, toPaneBand, type PaneBand } from "../src/pane-state";
import { frameIo, framePairIo, pendingInputText } from "../src/pane/reader";
import { stripAnsi } from "../src/watch-detect";
import { observedBand, paneReady, pendingTextFromFrames, type ReadinessFacts } from "../src/spool-readiness";
import { removeScratchTree } from "./support/scratch";

const SMOKE = join(import.meta.dir, "../../../skills/tap/scripts/smoke/fixtures");
const read = (path: string) => readFileSync(path, "utf8");

// Each harness's real draft capture, with its typed rows swapped for `rows`.
// The geometry (borders, prompt glyph, footer, paint) stays the harness's own.
const RULE = "─".repeat(80);
const frames: Record<string, (rows: string[]) => string> = {
  claude: rows => read(join(SMOKE, "pane-state/claude/draft-box.txt"))
    .replace("❯ HUMAN-DRAFT", [`❯ ${rows[0]}`, ...rows.slice(1)].join("\n")),
  codex: rows => read(join(SMOKE, "submit-verify/codex-idle-staged-80.ansi"))
    .replace(/(\x1b\[1m›\x1b\[0m) \[\[TAP[^\n]*/, (_, glyph) => [`${glyph} ${rows[0]}`, ...rows.slice(1)].join("\n")),
  opencode: rows => read(join(import.meta.dir, "fixtures/opencode-capture/welcome-draft-124.ansi"))
    .replace("what is the tech stack here", [rows[0], ...rows.slice(1).map(row => `\n                         ┃  ${row}`)].join("")),
  agy: rows => {
    const lines = read(join(SMOKE, "agy-capture-20260903/draft-262.txt")).split("\n");
    lines.splice(8, 5, `> ${rows[0]}`, ...rows.slice(1));
    return lines.join("\n");
  },
  cursor: rows => `▄▄▄▄▄▄▄▄▄▄▄\n → ${rows[0]}\n${rows.slice(1).join("\n")}\n▀▀▀▀▀▀▀▀▀▀`,
  hermes: rows => `${RULE}\n❯ ${rows[0]}\n${rows.slice(1).join("\n")}\n${RULE}\n0s · ctx -- esc to cancel`,
};

// Blank means the one blanking rule's set (JavaScript trim), not only ASCII:
// a stray byte-order mark or no-break space is as content-free as a space.
const BLANKS: Record<string, string[]> = {
  ascii: ["   ", "", "  \t ", "    "],
  unicode: ["\ufeff", "", "\u00a0\ufeff", "\u3000"],
};
const ONE_CHAR = ["   ", "", "  x ", "    "];
// Readiness reads the prompt row for most families, so its arm puts the one
// character there; a continuation-row character is the composer readers' case.
const ONE_CHAR_PROMPT = ["  x ", "", "   ", "    "];

/**
 * The spool's readiness verdict over one frame, through the same readers the drain uses.
 * `height` is the pane's `#{pane_height}` as the drain would read it; absent, the
 * drain could not read it.
 */
function readiness(harness: string, frame: string, height?: number): string {
  const base: ReadinessFacts = {
    pane: "sess:0.0", paneId: "%1", handle: "peer", toTeam: "fixture", targetRegistry: "/bus/registry.json",
    policy: "", identity: "match", harnessCmd: harness, paneInMode: "0", blockedMap: "{}", blockedExempt: "[]",
    frame, pending: { kind: "empty" }, band: null,
  };
  if (harness === "codex") return paneReady({ ...base, band: observedBand({ frame, harness, paneWidth: "120" }) }, DEPS);
  const read = pendingInputText(frameIo(frame, "120"), "%1", harness, harness === "agy" || harness === "opencode" ? undefined : frame);
  const pending = read.status === "text" ? { kind: "text" as const, text: pendingTextFromFrames(read.text, frame, frame, harness, () => height) }
    : read.status === "blocked" ? { kind: "modal" as const }
    : read.status === "overprint" ? { kind: "overprint-hold" as const } : { kind: "no-band" as const };
  return paneReady({ ...base, pending }, DEPS);
}
const DEPS = {
  registryMatchesTeam: () => true, recoveryAllowed: () => true, clearFenceState: () => "absent" as const,
  blockedOrExempt: () => false, env: { TAP_AGENT_FAMILIES: undefined } as NodeJS.ProcessEnv,
};

for (const [harness, frame] of Object.entries(frames)) {
  test(`${harness}: the fixture's typed rows read as a draft (control)`, () => {
    expect(classifyPane(frame(["a real draft", "second row"]), harness, false).kind).toBe("draft");
    expect(readiness(harness, frame(["a real draft", "second row"]))).toBe("busy:pending");
  });
  for (const [kind, rows] of Object.entries(BLANKS)) {
    test(`${harness}: a multi-line band of only ${kind} blanks reads ready`, () => {
      expect(classifyPane(frame(rows), harness, false)).toEqual({ kind: "ready" });
      expect(readiness(harness, frame(rows))).toBe("ready");
    });
  }
  test(`${harness}: a blank-under-the-rule prompt row above real text never reads ready`, () => {
    expect(readiness(harness, frame(["\ufeff", "real text below"]))).toBe("busy:pending");
  });
  test(`${harness}: an empty prompt row above a continuation-row draft reads pending`, () => {
    expect(classifyPane(frame(["", "real text below"]), harness, false).kind).toBe("draft");
    expect(readiness(harness, frame(["", "real text below"]))).toBe("busy:pending");
  });
  test(`${harness}: captures that disagree about blankness hold the prompt row`, () => {
    // The escaped and plain captures are two observations; typing between them
    // must not let the earlier, empty one admit the later one's prompt row.
    expect(pendingTextFromFrames("\ufeff", frame(BLANKS.ascii!), frame(["\ufeff", "real human text"]), harness)).toBe("\ufeff");
    expect(pendingTextFromFrames("\ufeff", frame(BLANKS.unicode!), frame(BLANKS.ascii!), harness)).toBe("");
  });
  test(`${harness}: one real character among blanks reads pending`, () => {
    const got = classifyPane(frame(ONE_CHAR), harness, false);
    expect(got.kind).toBe("draft");
    expect(got.kind === "draft" && got.text.includes("x")).toBe(true);
    expect(readiness(harness, frame(ONE_CHAR_PROMPT))).toBe("busy:pending");
  });
}

// tap-uwp2r: the drain reads an escaped and a plain capture of the same pane. The
// plain one has lost the dim styling that marks an idle placeholder as chrome, so
// it classifies each of these idle panes as a draft; only the escaped capture may
// supply one, or an idle pane would hold forever.
const IDLE_PLACEHOLDERS: [string, string][] = [
  ["claude", "pane-state/claude/20260923-try-empty-100.ansi"],
  ["claude", "pane-state/claude/20260923-try-empty-145.ansi"],
  ["claude", "pane-state/claude/20260906-queued-placeholder.ansi"],
  ["claude", "submit-verify/claude-queue-after.ansi"],
  ["claude", "peek-harness-adapters/claude-code-idle.ansi"],
  ["claude", "peek-harness-adapters/claude-code-session-limit.ansi"],
  ["cursor", "submit-verify/cursor-red-box.ansi"],
  ["hermes", "hermes-prompt/placeholder.ansi"],
  ["hermes", "peek-harness-adapters/hermes-working.ansi"],
];
for (const [harness, path] of IDLE_PLACEHOLDERS) {
  test(`${harness}: an idle placeholder pair reads ready (${path})`, () => {
    const escaped = read(join(SMOKE, path)), plain = stripAnsi(escaped);
    expect(classifyPane(plain, harness, false).kind).toBe("draft");
    const row = pendingInputText(framePairIo(escaped, plain, "120"), "%1", harness);
    expect(row.status === "text" && pendingTextFromFrames(row.text, escaped, plain, harness)).toBe("");
  });
}

/** A composer whose read side is a real harness classifier over `frame`. */
function composer(harness: string) {
  let typed = "";
  const pasted: string[] = [];
  const rows = () => typed === "" ? [""] : typed.split("\n");
  return {
    pasted,
    get typed() { return typed; },
    fx: {
      restoreInput: (_: string, text: string) => { pasted.push(text); typed += text; return true as const; },
      paneState: (): PaneBand => toPaneBand(classifyPane(frames[harness]!(rows()), harness, false)),
      settle: () => {},
    },
  };
}

for (const harness of Object.keys(frames)) {
  for (const text of [" ", "   ", "\n", "  \n  ", "\t\n\n ", "\ufeff\n\u00a0"]) {
    test(`${harness}: whitespace-only backup ${JSON.stringify(text)} is never typed back`, () => {
      const pane = composer(harness);
      restorePlainDraft("%1", text, harness, harness, pane.fx, () => true);
      expect(pane.pasted).toEqual([]);
    });
  }
}

for (const harness of Object.keys(frames)) {
  test(`${harness}: a real draft with surrounding blanks is typed exactly`, () => {
    const pane = composer(harness);
    restorePlainDraft("%1", "  real draft  ", harness, harness, pane.fx, () => true);
    expect(pane.pasted.join("")).toBe("  real draft  ");
  });
}

/** The courier's retained-file restore after a verified submit (typed-prefix shape). */
function courierRestore(body: string, extraFields: string[] = []) {
  const root = mkdtempSync(join(process.env.TAP_HOME!, "lx4z0-courier-"));
  const backup = join(root, "backup.md");
  writeFileSync(backup, ["---", "schema_version: 1", ...extraFields, "---", "", "## Backed-up input", "", body, ""].join("\n"));
  let buffer = "pre-existing", sent = false;
  const pasted: string[] = [], stderr: string[] = [];
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%7", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "codex" } as any),
    harnessEvidence: () => "alive",
    paneState: () => buffer.trim() ? { state: "busy", text: buffer } : { state: "ready" },
    clobber: () => { buffer = ""; return { kind: "cleared", lines: 1, chip: false, backupPath: backup }; },
    restoreInput: (_target, text) => { pasted.push(text); buffer += text; return true; },
    injectText: (_target, text) => { buffer += text; return true; },
    inputHasId: () => false,
    pressEnter: () => { sent = true; buffer = ""; return true; },
    settle: () => {},
    promptInput: () => ({ status: "text", text: buffer.replace(/ $/, "") }),
    regionInput: () => ({ status: "text", text: buffer }),
    submitFrame: (_target, _cmd, expected) => ({ state: buffer === expected ? "staged" : buffer ? "changed" : "empty", mode: "idle", width: "120" }),
  };
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    const result = submitVerifyLocked("%7", "self-restore", "keep the work [[sv:self-restore]]",
      { paneId: "%7", serverEpoch: "srv:1:1", harness: "codex" }, fx,
      { registryPath: "", scriptsDir: "", agentFamilies: new Set(["codex"]), typedPrefix: "/compact ", preserveDraft: false, busHome: root });
    return { result, sent, pasted, stderr: stderr.join("") };
  } finally {
    process.stderr.write = write;
    removeScratchTree(root);
  }
}

test("courier: a real retained draft is typed back (control)", () => {
  const got = courierRestore("  real draft  ");
  expect(got.sent).toBe(true);
  expect(got.pasted.join("")).toBe("  real draft  ");
});

for (const body of ["   ", "\n  \n", "﻿ "]) {
  test(`courier: a retained backup of only blanks ${JSON.stringify(body)} is nothing to restore`, () => {
    const got = courierRestore(body);
    expect(got.sent).toBe(true);
    expect(got.pasted).toEqual([]);
    expect(got.stderr).toContain(BLANK_DRAFT_NOTICE);
    expect(got.stderr).not.toContain("tap draft");
  });
}

test("courier: an incomplete backup with blank visible rows keeps the incomplete notice", () => {
  const got = courierRestore("\n  ", ["capture_status: incomplete", "uncaptured_content: scrolled-rows"]);
  expect(got.pasted).toEqual([]);
  expect(got.stderr).toContain(INCOMPLETE_DRAFT_NOTICE);
  expect(got.stderr).not.toContain(BLANK_DRAFT_NOTICE);
});

// tap-zo67f: a Claude draft taller than the composer scrolls, and Claude 2.1.286
// draws no scroll indicator. With newlines at the end of the draft the visible rows
// are all blank; the box sitting at its height cap is the only witness. The cap
// comes from the pane's real height, never from a capture's line count.
const SCROLLED = "pane-state/claude/20261001-v2.1.286-scrolled-blank-tail-h40";
const SCROLLED_TEXT = "pane-state/claude/20261001-v2.1.286-scrolled-text-h40";
const scrolled = (ext: string) => read(join(SMOKE, `${SCROLLED}.${ext}`));

test("claude: composer height cap matches the 2.1.286 calibration", () => {
  // Measured on a live Claude Code 2.1.286 pane (tap-zo67f): pane height -> visible
  // composer rows, widths 50/60/100/200 alike. A miss after a Claude release means
  // re-measure a live pane and update this table; do not loosen the witness.
  const measured: [number, number][] = [[12, 3], [13, 3], [14, 3], [15, 3], [16, 3], [17, 3], [18, 4], [19, 4],
    [20, 5], [21, 5], [24, 7], [30, 10], [35, 12], [40, 15], [41, 15], [50, 20], [60, 25]];
  for (const [height, rows] of measured) {
    expect(`h=${height} rows=${claudeComposerCap(height)}`, "Claude 2.1.286 calibration: re-measure the live cap").toBe(`h=${height} rows=${rows}`);
  }
});

for (const ext of ["ansi", "txt"]) {
  test(`claude: a scrolled draft with a blank visible tail holds (${ext})`, () => {
    const got = classifyPane(scrolled(ext), "claude", false, 40);
    expect(got.kind).toBe("draft");
    expect(got.kind === "draft" && got.scrolled).toBe(true);
    // The snapshot is the visible rows as drawn, nothing synthesized.
    expect(got.kind === "draft" && got.rows).toEqual(Array.from({ length: 15 }, () => ""));
    expect(toPaneBand(got)).toMatchObject({ state: "busy", scrolled: true });
    expect(readiness("claude", scrolled(ext), 40)).toBe("busy:pending");
  });
}

test("claude: the scrolled witness needs the pane's real height", () => {
  const frame = scrolled("ansi");
  // No height, or a height whose cap is not this box's (40 and 41 share a cap of 15): the verdict is today's.
  for (const height of [undefined, 0, -40, 40.5, 39, 42, 60]) {
    expect(classifyPane(frame, "claude", false, height)).toEqual({ kind: "ready" });
    expect(readiness("claude", frame, height)).toBe("ready");
  }
  // Extra rows above the composer change nothing: the box's own rows and the
  // pane's real height decide, never the capture's line count.
  expect(classifyPane(`old scrollback\n${frame}`, "claude", false, 40)).toMatchObject({ kind: "draft", scrolled: true });
  expect(classifyPane(frame.split("\n").slice(10).join("\n"), "claude", false, 40)).toMatchObject({ kind: "draft", scrolled: true });
});

test("claude: a blank box below the cap still reads ready", () => {
  // Fourteen blank rows in a 40-row pane: one short of the 15-row cap.
  const lines = scrolled("txt").split("\n");
  const short = ["", ...lines.slice(0, 23), ...lines.slice(24)].join("\n");
  expect(classifyPane(short, "claude", false, 40)).toEqual({ kind: "ready" });
  expect(readiness("claude", short, 40)).toBe("ready");
});

test("claude: a scrolled draft with visible text keeps its draft verdict without the flag", () => {
  const got = classifyPane(read(join(SMOKE, `${SCROLLED_TEXT}.ansi`)), "claude", false, 40);
  expect(got.kind).toBe("draft");
  expect(got.kind === "draft" && got.text.startsWith("probe draft line 13")).toBe(true);
  expect(got.kind === "draft" && got.scrolled).toBeUndefined();
});

test("non-Claude families ignore the pane height", () => {
  for (const [harness, frame] of Object.entries(frames)) {
    if (harness === "claude") continue;
    expect(classifyPane(frame(BLANKS.ascii!), harness, false, 40)).toEqual({ kind: "ready" });
  }
});

/**
 * The probe's draft (25 lines, then 20 newlines) in the captured 100x40 geometry,
 * with Claude's measured keys: C-u empties the cursor line, BSpace on an empty
 * line joins it to the one above. Every key is counted.
 */
function scrolledComposer() {
  const lines = scrolled("txt").split("\n");
  const start = lines.findIndex(line => line.startsWith("❯"));
  const bot = lines.findIndex((line, i) => i > start && /^─{10,}/.test(line));
  const draft = [...Array.from({ length: 25 }, (_, n) => `probe draft line ${n + 1} (inert, do not act)`), ...Array(20).fill("")];
  const rows = [...draft];
  const keys: string[] = [];
  const frame = () => {
    const shown = rows.slice(-15);
    return [...lines.slice(0, start), `❯ ${shown[0]}`, ...shown.slice(1).map(row => `  ${row}`), ...lines.slice(bot)].join("\n");
  };
  return { rows, draft, keys, frame };
}

test("delivery: a scrolled blank-tail Claude draft is preserved, never cleared", () => {
  // Clearing reveals blank rows the clear chain cannot tell apart: it stops
  // collecting while the keys erase hidden lines nobody keeps (a reviewer's
  // reproduction lost lines 16-25). The band holds with no key and no backup.
  const home = mkdtempSync(join(process.env.TAP_HOME!, "zo67f-clobber-"));
  try {
    const pane = scrolledComposer();
    const fx = {
      observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "claude" }),
      paneState: (): PaneBand => toPaneBand(classifyPane(pane.frame(), "claude", false, 40)),
      clearInput: () => { pane.keys.push("C-u"); pane.rows[pane.rows.length - 1] = ""; return true; },
      backspace: () => { pane.keys.push("BSpace"); if (pane.rows.length > 1 && pane.rows.at(-1) === "") pane.rows.pop(); return true; },
      settle: () => {}, injectText: () => { pane.keys.push("inject"); return true; }, inputHasId: () => false,
      pressEnter: () => { pane.keys.push("Enter"); return true; },
    } as unknown as DeliveryEffects;
    const verdict = clobberBand("%1", "claude", { paneId: "%1", serverEpoch: "srv:1:1", harness: "claude" }, fx,
      { directory: join(home, "input-backups"), handle: "peer", payloadId: "zo67f", pane: "%1" }, "");
    expect(verdict).toEqual({ kind: "preserved", detail: CLAUDE_SCROLLED_DRAFT_REASON });
    expect(pane.keys).toEqual([]);
    expect(pane.rows).toEqual(pane.draft);
    expect(existsSync(join(home, "input-backups"))).toBe(false);
  } finally {
    removeScratchTree(home);
  }
});

test("courier: an urgent send withholds its interrupt from a scrolled blank-tail draft", () => {
  const home = mkdtempSync(join(process.env.TAP_HOME!, "zo67f-urgent-"));
  try {
    const pane = scrolledComposer();
    const record = (key: string) => () => { pane.keys.push(key); return true as const; };
    const fx = {
      observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "claude" }),
      harnessEvidence: () => "alive",
      paneState: (): PaneBand => toPaneBand(classifyPane(pane.frame(), "claude", false, 40)),
      pressKeys: (_target: string, keys: string[]) => { pane.keys.push(...keys); return true; },
      clearInput: record("C-u"), backspace: record("BSpace"), injectText: record("inject"), pressEnter: record("Enter"),
      restoreInput: record("restore"), inputHasId: () => false, settle: () => {},
    } as unknown as PaneEffects;
    const result = submitVerifyLocked("%1", "zo67f-urgent", "[[TAP v0.23 note zo67f-urgent]]",
      { paneId: "%1", serverEpoch: "srv:1:1", harness: "claude" }, fx,
      { registryPath: "", scriptsDir: "", agentFamilies: new Set(["claude"]), busHome: home, recipient: "peer", preserveDraft: false,
        deliveryFacts: { harness: "claude", urgent: true, noSpool: true, recipientBound: true } });
    expect(result.status).toBe("band_busy");
    expect("detail" in result && result.detail).toContain(CLAUDE_SCROLLED_DRAFT_REASON);
    expect(pane.keys).toEqual([]);
    expect(pane.rows).toEqual(pane.draft);
  } finally {
    removeScratchTree(home);
  }
});
