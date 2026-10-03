import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkHarness, checkText, commandPrefix, COMPACT_FOCUS_CAP, GOAL_CAP, matchPhrase } from "../src/self-gate";
import { parseSelf, writeHandoff } from "../src/verbs/self";
import { removeScratchTree } from "./support/scratch";

const MARKER = " [[sv:self-20260923T000000Z-deadbeef]]";
const GOAL = "The /tap-self skill for runtime/bun/src/verbs/self.ts is complete: smoke test green (exit 0) and the PR is open. Prove it with smoke output and the PR URL. Stop on a named blocker or after 30 turns.";
const LOOP = "check whether PR 42 in Example-Org/tap has new review comments and address them on branch SelfSkill";
const COMPACT = "preserve the /tap-self skill build in skills/self/: verb gates and the open codex-glyph question";
const gate = (verb: "compact" | "goal" | "loop", text: string, interval = "") => checkText(verb, text, interval, MARKER);
const rejected = (verb: "compact" | "goal" | "loop", text: string, interval = "") => {
  const result = gate(verb, text, interval);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.message;
};

test("control prefixes, slash injection and control characters are refused", () => {
  expect(rejected("goal", "/goal clear")).toContain("not allowed");
  expect(rejected("goal", "/goal pause")).toContain("not allowed");
  expect(rejected("loop", "/loop cancel")).toContain("not allowed");
  expect(rejected("compact", "/dr --full")).toContain("slash-command injection");
  expect(rejected("compact", "preserve docs/plans/x.md work\n/loop cancel")).toContain("single line");
  expect(rejected("compact", "preserve\u007fwork")).toContain("single line");
  expect(rejected("compact", "")).toContain("required");
});

test("a leading absolute path is not a slash command", () => {
  expect(gate("goal", "/tmp/self-plan.md is complete: smoke exit 0 proves it. Stop after 10 turns.").ok).toBe(true);
});

test("a control word first would become a control command; a derived word would not", () => {
  expect(rejected("goal", "Clear the review backlog in docs/plans/x.md: exit 0 proves it. Stop after 9 turns.")).toContain("control word 'clear'");
  expect(rejected("loop", "cancel stale runs for branch SelfSkill in Example-Org/tap")).toContain("control word 'cancel'");
  expect(gate("goal", "Clearing docs/plans/x.md checkboxes is complete when smoke exit 0 proves it. Stop after 9 turns.").ok).toBe(true);
});

test("interval applies to loop only and is one <N><unit>", () => {
  expect(rejected("loop", LOOP, "5x")).toContain("--interval must be");
  expect(rejected("loop", LOOP, "5s5m")).toContain("--interval must be");
  expect(rejected("goal", GOAL, "5m")).toContain("only applies to the loop verb");
  expect(gate("loop", LOOP, "5m").ok).toBe(true);
  expect(gate("loop", LOOP).ok).toBe(true);
});

test("goal needs path, evidence and stop, without weakening or deixis", () => {
  expect(gate("goal", GOAL).ok).toBe(true);
  expect(rejected("goal", "Finish docs/plans/x.md if possible, prove exit 0. Stop on blockers.")).toContain("weakening language: 'if possible'");
  expect(rejected("goal", "Finish this plan in docs/x.md: exit 0. Stop after 3 turns.")).toContain("deixis 'this plan'");
  expect(rejected("goal", "Finish the refactor: exit 0. Stop after 3 turns.")).toContain("path-like");
  expect(rejected("goal", "Finish docs/x.md. Stop after 3 turns.")).toContain("completion evidence");
  expect(rejected("goal", "Finish docs/x.md: exit 0 proves it.")).toContain("stop conditions");
  expect(rejected("loop", "re-check the task above for new comments")).toContain("deixis 'the task above'");
});

test("phrases match on word boundaries, not substrings", () => {
  expect(gate("goal", "Update the registry to mark docs/plans/x.md done: smoke exit 0 proves it. Stop after 10 turns.").ok).toBe(true);
  expect(matchPhrase("the registry to x", "try to")).toBe(false);
  expect(matchPhrase("please try to finish", "try to")).toBe(true);
  expect(matchPhrase("it's ok to stop now", "it's ok to stop")).toBe(true);
  // Every listed phrase compiles as a unicode-mode pattern, punctuation included.
  for (const phrase of ["it's ok to stop", "pr url", "terminal.json", "a-b", "docs/", "c++ (x)"]) expect(() => matchPhrase("", phrase)).not.toThrow();
  expect(rejected("goal", "Finish docs/x.md: exit 0. It's ok to stop after 3 turns.")).toContain("it's ok to stop");
  expect(gate("compact", "preserve the .gitignore cleanup and the flaky test that failed only once in skills/self/").ok).toBe(true);
});

test("the goal cap counts the typed prefix and the marker the harness sees", () => {
  const base = "docs/x.md: exit 0. Stop after 3 turns. ";
  const room = GOAL_CAP - commandPrefix("goal").length - MARKER.length;
  const fits = base + "x".repeat(room - base.length);
  expect(gate("goal", fits).ok).toBe(true);
  expect(rejected("goal", fits + "x")).toContain(`max ${room}`);
  // Characters, not UTF-16 units or bytes.
  expect(gate("goal", base + "é".repeat(room - base.length)).ok).toBe(true);
});

test("typed prefixes per verb", () => {
  expect(commandPrefix("compact")).toBe("/compact ");
  expect(commandPrefix("goal")).toBe("/goal ");
  expect(commandPrefix("loop")).toBe("/loop ");
  expect(commandPrefix("loop", "5m")).toBe("/loop 5m ");
});

test("harness matrix degrades with exit 6, never silently", () => {
  for (const verb of ["compact", "goal", "loop"] as const) expect(checkHarness(verb, "claude").ok).toBe(true);
  expect(checkHarness("compact", "codex").ok).toBe(true);
  expect(checkHarness("goal", "codex-cli").ok).toBe(true);
  expect(checkHarness("compact", "opencode").ok).toBe(true);
  for (const [verb, harness] of [["loop", "codex"], ["goal", "opencode"], ["loop", "opencode"], ["compact", "cursor-agent"], ["goal", ""]] as const) {
    const result = checkHarness(verb, harness);
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.code).toBe(6); expect(result.message).toStartWith("DEGRADED"); }
  }
});

test("parse accepts positional text or --, rejects unknown verbs and repeated flags", () => {
  expect(parseSelf(["goal", "--pane", "%1", "--", "--literal", "text"])).toEqual({ verb: "goal", text: "--literal text", pane: "%1" });
  expect(parseSelf(["loop", "--interval", "5m", "check", "the", "PR"])).toEqual({ verb: "loop", text: "check the PR", interval: "5m" });
  expect(() => parseSelf(["nuke", "anything"])).toThrow("first argument must be a verb");
  expect(() => parseSelf(["goal", "--pane", "a", "--pane", "b", "x"])).toThrow("may be passed once");
  expect(() => parseSelf(["goal", "--bogus", "x"])).toThrow("unknown flag");
  expect(() => parseSelf(["goal", "--pane"])).toThrow("requires an argument");
});

test("the handoff is copied to the bus with the post-compaction header", () => {
  if (!process.env.TAP_HOME) throw new Error("self-gate tests require the isolated runner");
  const dir = mkdtempSync(join(process.env.TAP_HOME, "self-handoff-"));
  try {
    const source = join(dir, "source.md");
    writeFileSync(source, "in-flight: B3 PR B\n");
    const dest = writeHandoff(join(dir, "bus"), "self/native", source, new Date("2026-09-23T13:00:00.123Z"));
    expect(dest).toBe(join(dir, "bus", "handoff", "self-native-20260923T130000Z.md"));
    const bytes = readFileSync(dest, "utf8");
    expect(bytes).toStartWith("# TAP compaction handoff — self/native\n# written 2026-09-23T13:00:00Z, BEFORE an explicit /compact\n#\n");
    expect(bytes).toContain("Where the two disagree, this file is the record.\n\nin-flight: B3 PR B\n");
    expect(readdirSync(join(dir, "bus", "handoff"))).toEqual(["self-native-20260923T130000Z.md"]);
  } finally { removeScratchTree(dir); }
});

// tap-vho8h: the focus is typed as keystroke chunks and proven back row by
// row; detail belongs in the handoff. The cap refuses in the parent, before
// any pane effect, so exit 1 never leaves text in a composer.
test("the compact focus cap refuses before arming and names the handoff as the place for detail", () => {
  const fits = "preserve docs/plans/x.md and " + "y".repeat(COMPACT_FOCUS_CAP - "preserve docs/plans/x.md and ".length);
  expect([...fits].length).toBe(COMPACT_FOCUS_CAP);
  expect(gate("compact", fits).ok).toBe(true);
  const over = rejected("compact", fits + "y");
  expect(over).toContain(`${COMPACT_FOCUS_CAP + 1} chars`);
  expect(over).toContain("handoff");
  // Characters, not UTF-16 units or bytes; goal and loop are untouched by this cap.
  expect(gate("compact", "preserve docs/plans/x.md and " + "é".repeat(COMPACT_FOCUS_CAP - "preserve docs/plans/x.md and ".length)).ok).toBe(true);
  expect(gate("loop", "read docs/plans/x.md and report".padEnd(COMPACT_FOCUS_CAP + 10, " z")).ok).toBe(true);
});
