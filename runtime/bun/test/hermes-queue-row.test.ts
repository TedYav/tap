// tap-rhajr: Hermes paints its composer as "⚕ ❯" for the whole turn. Every
// prompt-row reader wanted "[name ]❯", so a `/queue` wire typed mid-turn read
// unobservable: the courier never pressed Enter (enter_count 0) and the wire sat
// staged for 18 minutes, and the nudge that later submitted it reported rc 5
// because the post-Enter mid-turn frame was unreadable too. The fixtures are
// the live frames, trimmed to the band (see fixtures/hermes-queue-row/README.md).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { detectAgentState } from "../src/agent-state";
import { promptRowReAwk, promptRowReGrep, stripPromptRow } from "../src/pane/geometry";
import { promptLineReText, regionIsSentinel } from "../src/pane/reader";
import { classifyPane } from "../src/pane-state";
import { reportFrame } from "../src/recovery/cli";
import { classifySubmitFrame, composerHoldsExactly, readFrame, visibleSentinelId } from "../src/submit-frame";
import { promptLineRe, promptRowReAwk as tmuxPromptRowReAwk } from "../src/tmux";

const ROOT = resolve(import.meta.dir, "../../..");
const fx = (name: string) => readFileSync(join(import.meta.dir, "fixtures/hermes-queue-row", name), "utf8");
const MID_TURN_STAGED = fx("mid-turn-staged.ansi");
const IDLE_STAGED = fx("idle-staged.ansi");
// The empty working composer, escaped: `⚕ ❯ msg=interrupt · …` all italic 136.
const MID_TURN_EMPTY = readFileSync(join(ROOT, "skills/tap/scripts/smoke/fixtures/peek-harness-adapters/hermes-working.ansi"), "utf8");

const ID = "aspen-ponytail-20261001T061307Z-823e7d31b544";
const WIRE = `[[TAP v0.23 note ${ID} preview="fixturef fix fixt-fixtu fixturefix: f fixt fi-fixt fixt fix fixt fixturef fixtu fixture fixturef fixturefixt; fixturef"]]`;
const QUEUED = `/queue ${WIRE}`;

describe("the prompt-row twins read the working row and agree", () => {
  const rows = ["⚕ ❯ /queue [[TAP", "❯ /queue [[TAP", "ops-hermes ❯ /queue [[TAP", "  ⚕ ❯ /queue [[TAP"];
  const readers = (row: string) => [
    promptRowReGrep("hermes").test(row), promptRowReAwk("hermes").test(row),
    promptLineRe("hermes").test(row), tmuxPromptRowReAwk("hermes").test(row),
  ];
  // promptLineReText is POSIX text its consumers translate; regionIsSentinel is that consumer.
  test("every twin selects each prompt shape, and every strip leaves the wire", () => {
    for (const row of rows) {
      expect(readers(row)).toEqual([true, true, true, true]);
      expect(stripPromptRow(row, "hermes")).toBe("/queue [[TAP");
      expect(row.replace(promptLineRe("hermes"), "").trimStart()).toBe("/queue [[TAP");
      expect(regionIsSentinel(row.replace("/queue [[TAP", WIRE), promptLineReText("hermes"))).toBe(true);
    }
  });
  test("the ⚕ is a prefix only before the glyph: the status line and other glyphs stay text", () => {
    for (const row of [" ⚕ deepseek-v4.1-flash │ 191K/1M", "⚕❯ x", "💾 ❯ x", "a ⚕ ❯ x", "⚕ ⚕ ❯ x"]) {
      expect(readers(row)).toEqual([false, false, false, false]);
    }
  });
});

describe("mid-turn: the live frame that stalled", () => {
  test("the staged /queue wire is readable and verifies as staged across its cell wrap", () => {
    expect(classifySubmitFrame(MID_TURN_STAGED, "hermes", QUEUED, "144", true).state).toBe("staged");
    const band = classifyPane(MID_TURN_STAGED, "hermes", false);
    expect(band.kind).toBe("draft");
    expect(band.kind === "draft" && band.text.replace(/\n/g, "").trimEnd()).toBe(QUEUED);
    expect(visibleSentinelId(MID_TURN_STAGED, "hermes", true)).toBe(ID);
  });
  test("the agent reads working, from the ⚕ row alone", () => {
    expect(detectAgentState("hermes", MID_TURN_STAGED)).toEqual({ agentState: "working", reason: "working_prompt" });
  });
  test("after Enter, the empty working composer reads empty, not unobservable (the rc 5)", () => {
    expect(classifySubmitFrame(MID_TURN_EMPTY, "hermes", QUEUED, "80", true).state).toBe("empty");
    // Its italic-136 hint is chrome, not a human draft.
    expect(classifyPane(MID_TURN_EMPTY, "hermes", false)).toEqual({ kind: "ready" });
    expect(detectAgentState("hermes", MID_TURN_EMPTY).agentState).toBe("working");
  });
});

describe("idle: the same wire after the turn ended", () => {
  test("the wrapped wire above the footer bar verifies as staged and as the whole composer", () => {
    const read = readFrame(IDLE_STAGED, "hermes", QUEUED, "144");
    expect(read).toMatchObject({ state: "staged", text: QUEUED });
    expect(composerHoldsExactly(IDLE_STAGED, "hermes", QUEUED)).toBe(true);
  });
  test("without a known width no row is provably full, so the wrap is not joined", () => {
    expect(readFrame(IDLE_STAGED, "hermes", QUEUED).state).toBe("changed");
  });
  test("a short row is a real line break, never joined", () => {
    const rule = "─".repeat(60);
    const frame = `${rule}\n❯ first line\nsecond line\n${rule}\n`;
    expect(readFrame(frame, "hermes", "first linesecond line", "60").text).toBe("first line\nsecond line");
  });
  // Review finding: a user's own pane-width rule must not pass
  // for the footer bar and hide what follows it.
  test("a typed rule as wide as the bar keeps the human text after it as input", () => {
    const rule = "─".repeat(80), top = `\x1b[38;5;173m${rule}\x1b[0m`;
    const wire = "/queue [[TAP v0.23 ask probe-20261001T000000Z-aabbccddeeff]]";
    const suffix = `${top}\n\x1b[3;38;5;136m⚕ ❯ \x1b[0m${wire}\n${rule}\nhuman suffix\n${top}\n`;
    expect(readFrame(suffix, "hermes", wire, "80").text).toContain("human suffix");
    expect(classifySubmitFrame(suffix, "hermes", wire, "80", true).state).toBe("changed");
    expect(composerHoldsExactly(suffix, "hermes", wire)).toBe(false);
    const leading = `${top}\n\x1b[3;38;5;136m⚕ ❯ \x1b[0m\n${rule}\nhuman draft\n${top}\n`;
    expect(readFrame(leading, "hermes", wire, "80").state).toBe("changed");
    expect(classifyPane(leading, "hermes", false).kind).toBe("draft");
  });
  // tap-9lqa7 admits only a positive idle agent state; Hermes's idle witness is
  // an EMPTY at-rest prompt row, so a staged wire leaves the state unknown and
  // the idle staged submit refuses. Recorded, not changed here.
  test("the idle staged-submit carve-out does not fire: the agent state is unknown", () => {
    expect(detectAgentState("hermes", IDLE_STAGED).agentState).toBe("unknown");
  });
});

// The live `tap nudge --aggressiveness report-only > file` wrote these raw escapes.
describe("report-only output", () => {
  test("a terminal keeps the paint; a redirect, NO_COLOR or TERM=dumb gets plain text", () => {
    const osc = "\x1b]8;;https://example.invalid\x07link\x1b]8;;\x07\n";
    expect(reportFrame(IDLE_STAGED, true, {})).toBe(IDLE_STAGED);
    for (const [tty, env] of [[false, {}], [true, { NO_COLOR: "1" }], [true, { NO_COLOR: "" }], [true, { TERM: "dumb" }]] as const) {
      const plain = reportFrame(IDLE_STAGED + osc, tty, env);
      expect(plain).not.toContain("\x1b");
      expect(plain).toContain(`❯ ${QUEUED.slice(0, 40)}`);
      expect(plain.endsWith("link\n")).toBe(true);
    }
  });
});
