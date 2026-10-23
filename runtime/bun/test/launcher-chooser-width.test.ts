// Every collision-chooser row fits a 50-column terminal, rendered exactly as
// askChoice draws it: wide and narrow, grey and colourless, enabled and
// unavailable rows alike. Enabled glosses stay within 36 characters so a
// 14-column "  [r] resume  " prefix still lands inside the budget.
import { expect, test } from "bun:test";
import { NOT_A_SEAT, promptNewCollision, promptOffRosterTmuxCollision,
  promptSessionExists, type ForkUnavailable } from "../src/launcher/collision";
import { choiceRows, type ChoiceOption } from "../src/launcher/prompt";

const TIERS = ["exact", "picker", "fresh", "stale", "unknown-tier"];
// new.ts forkUnavailable()'s reasons, pinned end to end by launcher-new-oracle's [f]
// cases; the longest fork-owned flag (harness-families.ts) bounds the conflict one.
const REASONS = [NOT_A_SEAT, "harness cannot fork", "no saved chat to fork", "uses --fork-session", "uses --session-id"];
const FORKS: ForkUnavailable[] = [null, ...REASONS];

function menus(): ChoiceOption[][] {
  const asked: ChoiceOption[][] = [];
  const choose = ((_verb: string, _question: string, options: ChoiceOption[]) => { asked.push(options); return "q"; }) as Parameters<typeof promptSessionExists>[0];
  const stderr = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    for (const fork of FORKS) {
      promptSessionExists(choose, "team/seat", "claude", null, null, fork);
      for (const tier of TIERS) {
        promptSessionExists(choose, "team/seat", "claude", "live", tier, fork);
        promptNewCollision(choose, "team/seat", "claude", "gone", tier, fork);
      }
    }
    promptOffRosterTmuxCollision(choose, "team/seat", "claude", "10:00");
  } finally { process.stderr.write = stderr; }
  return asked;
}

const strip = (row: string) => row.replace(/\x1b\[\d+m/g, "").replace(/\n$/, "");

test("every chooser row fits 50 columns in every render mode", () => {
  const rows = new Set<string>();
  for (const options of menus())
    for (const width of [80, 40])
      for (const grey of [true, false])
        for (const row of choiceRows(options, width, grey)) rows.add(strip(row));
  const over = [...rows].filter(row => row.length > 50);
  expect(over).toEqual([]);
  // The colourless unavailable rows are the tightest case; prove they were measured.
  expect([...rows].some(row => row.includes("(unavailable: Uses --fork-session)"))).toBe(true);
});

test("enabled glosses stay within 36 characters in sentence case", () => {
  const glosses = new Set(menus().flat().filter(option => !option[3]).map(option => option[2]));
  for (const gloss of glosses) {
    expect(gloss.length).toBeLessThanOrEqual(36);
    expect(gloss).toMatch(/^[A-Z]/);
    expect(gloss).not.toMatch(/[.—–]$|[—–]| - /);
  }
});

test("an unavailable fork row capitalizes its reason; the reason itself stays lowercase", () => {
  for (const reason of REASONS) {
    expect(reason).toMatch(/^[a-z]/);
    expect(reason.length).toBeLessThanOrEqual(21);
  }
  const fork = menus().flat().find(option => option[0] === "f" && option[3]);
  expect(fork?.[2]).toMatch(/^[A-Z]/);
});
