import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripClaudeArgHint } from "../src/pane/reader";
import { PYTHON_SPACE } from "../src/terminal-text";

// Ported from skills/tap/scripts/regress/claude-arg-hint.test.sh (tap-tx3s.1
// A1/A2, helper-direct, no tmux), then PROMOTED into the Bun suite that
// nightwatch's full gate runs on purpose: the pin is deterministic,
// fixture-only, tmux-free and ~0.1s. It is NOT part of the PR smoke gate —
// smoke.yml runs only sanity, typecheck and the stamped-module pair; the full
// Bun suite rides full-gate.yml (workflow_dispatch), so this pin never blocks
// a merge by itself (the shell's REGRESS-NEVER-BLOCKS caution carried over;
// the retired gate share stays owned by typed-prefix.test.ts's reader). This file
// binds the same 18 of the 26
// claude-slash-*.ansi fixtures the shell bound (the 8 documented-unbound are
// listed in the shell header and stay unbound here: painted/unpainted pairs,
// goal/theme/idle/second/unknown/wrapped cases with their own owners), plus
// the live truecolor 53/80-column captures and the 256-colour environment
// regression, bound to the NATIVE stripClaudeArgHint by direct import — the
// shell needed a bun -e bridge; this file is on the other side of it.
//
// Polarities: P0 (live 80-col whole placeholder) / P1-bytes / hint-white /
// hint-neargray strip; N1-N7, unreadable widths, and both ellipsis conjuncts
// KEEP. The six shell mutants (M1, M2, M2b, M2c, M3, M4) each red the named
// keep arm through a mutated copy of the reader imported fresh per mutant.
// The BASE-vs-HEAD section pins the retired Bash/python helper's truecolor
// behavior at the pinned commit as a faithful TS transcription, with the
// byte-level reason assertions the shell made.
//
// Scratch allocation: the mutated source tree lives only beneath the
// runner-owned scratch root (runtime/bun/test/run.sh exports TMUX_TMPDIR);
// this file refuses to run without it.

const RUNNER_ROOT = process.env.TMUX_TMPDIR;
if (!RUNNER_ROOT) {
  throw new Error(
    "claude-arg-hint.test.ts: TMUX_TMPDIR is unset — this fixture allocates only beneath the supported runner's scratch root (runtime/bun/test/run.sh exports it); refusing to write outside it",
  );
}
const WORK = mkdtempSync(join(RUNNER_ROOT, "tap-arghint-src."));
// The mutated modules (and their resolution directories) stay open in THIS
// process — bun holds imported trees mapped — so removeScratchTree's lsof
// guard would refuse its own test's scratch. Unlinking open files and open
// directories is safe on this platform (the inode outlives the name), so this
// tree gets a plain rm; it is process-private and lives under TMUX_TMPDIR.
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

const FIXTURES = resolve(import.meta.dir, "../../../skills/tap/scripts/smoke/fixtures/submit-verify");
const READER = resolve(import.meta.dir, "../src/pane/reader.ts");

// Python's re: OSC sequences, then CSI. The loaders keep prompt-row bytes
// unmodified except OSC, so a footer hyperlink cannot steal the line match.
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
// Python str.strip() — not JavaScript trim().
const PY_STRIP = new RegExp(`^[${PYTHON_SPACE}]+|[${PYTHON_SPACE}]+$`, "g");
const pyStrip = (text: string): string => text.replace(PY_STRIP, "");

interface Prompt { typed: string; row: string }

function loadPrompt(fixture: string): Prompt {
  const raw = readFixture(fixture).replace(OSC, "");
  const plain = raw.replace(CSI, "");
  for (const line of plain.split("\n")) {
    if (line.replace(/^ +/, "").startsWith("❯") || line.replace(/^ +/, "").startsWith("›")) {
      return { typed: line.replace(/^[ \u276f\u203a\u00a0]+/, "").replace(/[\t ]+$/, ""), row: line };
    }
  }
  throw new Error(`${fixture}: no prompt row`);
}

function loadEscapedPrompt(fixture: string): string {
  const raw = readFixture(fixture).replace(OSC, "");
  for (const line of raw.split("\n")) {
    const plain = line.replace(CSI, "");
    if (plain.replace(/^ +/, "").startsWith("❯") || plain.replace(/^ +/, "").startsWith("›")) return line;
  }
  throw new Error(`${fixture}: no prompt row`);
}

function readFixture(fixture: string): string {
  const path = join(FIXTURES, fixture);
  if (!existsSync(path)) throw new Error(`missing fixture ${path}`);
  return readFileSync(path, "utf8");
}

/** Python `len(s)` — code points, not UTF-16 units. */
const codePoints = (s: string): number => [...s].length;

/** Twins `unicodedata.east_asian_width(ch) in ("F", "W")` for the UCD
 *  EastAsianWidth Wide/Fullwidth ranges; everything else counts 1. */
const WIDE = new RegExp(
  "[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF" +
  "\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60" +
  "\uFFE0-\uFFE6\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{20000}-\u{2FFFD}\u{30000}-\u{3FFFD}]",
  "u",
);
function cells(s: string): number {
  let n = 0;
  for (const ch of s) n += WIDE.test(ch) ? 2 : 1;
  return n;
}

function expectStrip(fixture: string, width: string, want: string): void {
  const { typed, row } = loadPrompt(fixture);
  expect(stripClaudeArgHint(typed, row, width), `typed='${typed}' width='${width}'`).toBe(want);
}

function expectKeep(fixture: string, width: string): void {
  const { typed, row } = loadPrompt(fixture);
  expect(stripClaudeArgHint(typed, row, width), `typed='${typed}' width='${width}'`).toBe(typed);
}

const LIVE53 = "claude-slash-hint-compact-truncated-53.ansi";
const LIVE80 = "claude-slash-hint-compact-full.ansi";
const REG256 = "claude-slash-hint-compact-full-256.ansi";

test("P0 live 80 truecolor strips; the 256-colour environment regression still strips", () => {
  expectStrip(LIVE80, "80", "/compact");
  expectStrip(REG256, "80", "/compact");
});

test("P1 live 53 exact-fill strips; N1 keeps the same bytes at width 80; unreadable widths keep", () => {
  expectStrip(LIVE53, "53", "/compact");
  expectKeep(LIVE53, "80");
  expectKeep(LIVE53, "");
  expectKeep(LIVE53, "0");
  expectKeep(LIVE53, "nope");
});

test("A2 colour is not an authority: painted, unpainted, white and neargray all strip", () => {
  expectStrip("claude-slash-hint-white.ansi", "80", "/compact");
  expectStrip("claude-slash-hint-neargray.ansi", "80", "/compact");
  expectStrip("claude-slash-hint-compact.ansi", "80", "/compact");
  expectStrip("claude-slash-hint-compact-unpainted.ansi", "80", "/compact");
  expectStrip("claude-slash-hint-goal.ansi", "80", "/goal");
  expectStrip("claude-slash-hint-loop.ansi", "80", "/loop");
  expectStrip("claude-slash-hint-clear.ansi", "80", "/clear");
});

test("N2/N3/N4 refusals keep the typed text at full-row width", () => {
  const n2 = "claude-slash-hint-compact-truncated-n2-custum.ansi";
  const n3 = "claude-slash-hint-compact-truncated-n3-empty.ansi";
  const n4 = "claude-slash-hint-compact-truncated-n4-wrong-command.ansi";
  // Pass width == row cells so the full-row check is not the reason.
  expectKeep(n2, String(cells(loadPrompt(n2).row)));
  expectKeep(n3, String(codePoints(loadPrompt(n3).row)));
  expectKeep(n4, String(codePoints(loadPrompt(n4).row)));
});

const PH = "<optional custom summarization instructions>";
const ELL = "\u2026";
const TYPED_PH = `/compact  ${PH}${ELL}`;
const ROW_PH = `❯ /compact  ${PH}${ELL}`;
const TYPED_SUB = `/compact  custom summarization instructi${ELL}`;
const ROW_SUB = `❯ /compact  custom summarization instructi${ELL}`;

test("ellipsis conjuncts KEEP: not-placeholder and startsWith both required", () => {
  expect(stripClaudeArgHint(TYPED_PH, ROW_PH, "57"), "placeholder+ellipsis @57").toBe(TYPED_PH);
  expect(stripClaudeArgHint(TYPED_SUB, ROW_SUB, "43"), "substring-not-prefix @43").toBe(TYPED_SUB);
});

test("N5 blank-count refusals: zero, one and three blanks keep", () => {
  expectKeep("claude-slash-hint-cursor-home.ansi", "80");
  expectKeep("claude-slash-hint-cursor-left.ansi", "80");
  expectKeep("claude-slash-hint-cursor-left2.ansi", "80");
  expectKeep("claude-slash-hint-three-blanks.ansi", "80");
  expectKeep("claude-slash-hint-before-cursor.ansi", "80");
});

test("N6 muted real draft is not a placeholder", () => {
  expectKeep("claude-slash-muted-real-draft.ansi", "80");
});

test("N7 remaining table and text refusals keep", () => {
  expectKeep("claude-slash-hint-wording-drift.ansi", "80");
  expectKeep("claude-slash-mismatched-command.ansi", "80");
  expectKeep("claude-slash-bare-hint-text.ansi", "80");
  expectKeep("claude-slash-typed-angle-arg.ansi", "80");
  expectKeep("claude-slash-courier-residue.ansi", "80");
});

// --- Mutants: one wrong edit per named arm, the arm must flip to strip ------

const MUTATED_SRC = join(WORK, "src");
const MUTATED_READER = join(MUTATED_SRC, "pane", "reader.ts");
let mutantSeq = 0;

/** Import stripClaudeArgHint from a freshly mutated copy. The query string
 *  busts the module cache so each mutant is its own module instance. */
async function mutatedStrip(oldText: string, newText: string): Promise<(typed: string, row: string, width: string) => string> {
  if (!existsSync(join(MUTATED_SRC, "pane"))) cpSync(resolve(import.meta.dir, "../src"), MUTATED_SRC, { recursive: true });
  cpSync(READER, MUTATED_READER);
  const text = readFileSync(MUTATED_READER, "utf8");
  const hits = text.split(oldText).length - 1;
  expect(hits, `mutant needle must occur exactly once: ${oldText.slice(0, 80)}`).toBe(1);
  writeFileSync(MUTATED_READER, text.replace(oldText, newText));
  mutantSeq += 1;
  const mod = await import(`${MUTATED_READER}?mutant=${mutantSeq}`);
  return mod.stripClaudeArgHint;
}

test("M1 dropping the full-row check reds N1: the truncated-wide row strips", async () => {
  const strip = await mutatedStrip(
    "if (Number.isFinite(width) && width > 0 && cells(row) === width)",
    "if (true)",
  );
  const { typed, row } = loadPrompt(LIVE53);
  expect(strip(typed, row, "80")).toBe("/compact");
});

test("M2 accepting any ellipsis suffix reds N2: custum… strips", async () => {
  const strip = await mutatedStrip(
    "if (prefix && prefix !== placeholder && placeholder.startsWith(prefix))",
    "if (true)",
  );
  const fixture = "claude-slash-hint-compact-truncated-n2-custum.ansi";
  const { typed, row } = loadPrompt(fixture);
  expect(strip(typed, row, String(cells(row)))).toBe("/compact");
});

test("M2b dropping prefix!==placeholder reds placeholder+ellipsis @57", async () => {
  const strip = await mutatedStrip(
    "prefix && prefix !== placeholder && placeholder.startsWith(prefix)",
    "prefix && placeholder.startsWith(prefix)",
  );
  expect(strip(TYPED_PH, ROW_PH, "57")).toBe("/compact");
});

test("M2c startswith→includes reds substring-not-prefix @43", async () => {
  const strip = await mutatedStrip(
    "placeholder.startsWith(prefix)",
    "placeholder.includes(prefix)",
  );
  expect(strip(TYPED_SUB, ROW_SUB, "43")).toBe("/compact");
});

test("M3 blanks<2 reds N5/three-blanks", async () => {
  const strip = await mutatedStrip(
    "if (blanks !== BLANKS_BEFORE_HINT)",
    "if (blanks < BLANKS_BEFORE_HINT)",
  );
  const { typed, row } = loadPrompt("claude-slash-hint-three-blanks.ansi");
  expect(strip(typed, row, "80")).toBe("/compact");
});

test("M4 deleting the table lookup reds N6: the muted real draft strips", async () => {
  const strip = await mutatedStrip(
    "let accepted = hint === placeholder;",
    "let accepted = true;",
  );
  const { typed, row } = loadPrompt("claude-slash-muted-real-draft.ansi");
  expect(strip(typed, row, "80")).toBe("/compact");
});

// --- BASE-vs-HEAD on truecolor bytes (replaces dishonest M5) -----------------
// BASE at 0cf152b00274286d0231badc0c942c43ab28a9b4 takes (typed, escaped) and
// requires muted 38;2 gray. BASE@80 strips (colour never blocked production);
// BASE@53 KEEPS because the ellipsis-suffixed placeholder misses the table —
// asserted as reason, not rc: the escaped row carries 38;2;153;153;153 AND
// U+2026. HEAD strips both. The 256-colour file is not a BASE input. This is a
// faithful transcription of the frozen python helper; byte semantics, not
// history, are under test.

function baseStrip(typed: string, escaped: string): string {
  const HINT_FG = /\u001b\[38;2;(\d{1,3});(\d{1,3});(\d{1,3})m/g;
  const HINTS: Record<string, string> = {
    "/compact": "<optional custom summarization instructions>",
    "/goal": "[<condition> | clear]",
    "/loop": "[interval] [prompt]",
    "/clear": "[name]",
  };
  const MUTED_LO = 96, MUTED_HI = 176;
  const tail = escaped.replace(/[\t\n\v\f\r ]+$/, "");
  const matches = [...tail.matchAll(HINT_FG)];
  if (matches.length === 0) return typed;
  const m = matches[matches.length - 1]!;
  const r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
  if (!(r === g && g === b && MUTED_LO <= r && r <= MUTED_HI)) return typed;
  const rest = tail.slice(m.index! + m[0].length);
  if (new RegExp(CSI.source).test(rest.replace(/(?:\u001b\[(?:0|39|49|22|27)?m)+$/, ""))) return typed;
  const hintPlain = rest.replace(new RegExp(CSI.source, "g"), "");
  if (!pyStrip(hintPlain)) return typed;
  const pre = tail.slice(0, m.index).replace(new RegExp(CSI.source, "g"), "");
  const blanks = pre.length - pre.replace(/ +$/, "").length;
  if (blanks !== 2) return typed;
  const command = pyStrip(pyStrip(pre).replace(/[\u276f\u203a]/g, ""));
  if (HINTS[command] !== pyStrip(hintPlain)) return typed;
  if (!typed.endsWith(hintPlain)) return typed;
  const remainder = typed.slice(0, typed.length - hintPlain.length).replace(/[\t\n\v\f\r ]+$/, "");
  if (remainder !== command) return typed;
  return remainder;
}

test("BASE-vs-HEAD truecolor: BASE strips @80, KEEPS @53 for a byte-asserted reason, HEAD strips both", () => {
  const esc53 = loadEscapedPrompt(LIVE53);
  expect(esc53).toContain("38;2;153;153;153");
  expect(esc53).toContain("\u2026");
  expect(esc53).not.toContain("38;5;");
  const esc80 = loadEscapedPrompt(LIVE80);
  expect(esc80).toContain("38;2;153;153;153");
  expect(esc80).not.toContain("38;5;");

  const typed80 = loadPrompt(LIVE80).typed;
  expect(baseStrip(typed80, esc80)).toBe("/compact");
  const typed53 = loadPrompt(LIVE53).typed;
  expect(baseStrip(typed53, esc53)).toBe(typed53);

  // HEAD strips both widths on the same captures.
  expectStrip(LIVE53, "53", "/compact");
  expectStrip(LIVE80, "80", "/compact");
});
