import { expect, test } from "bun:test";
import { expandResumeShorthand, resumeCandidateNames, ResumeNamingValueError } from "../src/launcher/naming";
import golden from "./support/launcher-resume-naming/goldens.json";

function outcome(fn: () => unknown): unknown {
  try { return { value: fn() }; }
  catch (error) {
    if (!(error instanceof ResumeNamingValueError)) throw error;
    return { error: "ValueError", message: error.message };
  }
}

test("native resume names match 52 frozen incumbent cases, including exact decimal text and limits", () => {
  expect(golden.base).toBe("247a603163f8df029047320d7b022779ecafc9c2");
  expect(golden.rows).toHaveLength(52);
  for (const row of golden.rows) {
    const input = { ...row.input, int_max_str_digits: row.input.limit };
    expect(outcome(() => expandResumeShorthand(input))).toEqual(row.expanded);
    expect(outcome(() => resumeCandidateNames(input))).toEqual(row.candidates);
  }
});

test("malformed requests are refused, never read as empty candidates or a ValueError", () => {
  const changes: Record<string, unknown>[] = [{ name: [] }, { harness: null }, { base: 3 }, { default_tag: [] }, { int_max_str_digits: 1 }, { int_max_str_digits: null }];
  for (const owner of [expandResumeShorthand, resumeCandidateNames]) {
    for (const change of changes) {
      const request = { name: "2", harness: "claude", base: "meta", int_max_str_digits: 4300, ...change } as Parameters<typeof owner>[0];
      expect(() => owner(request)).toThrow("invalid resume naming request");
    }
  }
});

test("the named shorthand cases that test_launcher.py pinned before resume became native", () => {
  const request = (name: string, harness: string, default_tag?: string) => ({ name, harness, base: "meta", int_max_str_digits: 4300, ...(default_tag ? { default_tag } : {}) });
  expect(expandResumeShorthand(request("2", "codex"))).toBe("meta/codex-2");
  expect(expandResumeShorthand(request("0", "codex"))).toBe("meta/codex");
  expect(expandResumeShorthand(request("0", "claude", "fable"))).toBe("meta/fable");
  expect(expandResumeShorthand(request("planner-0", "claude"))).toBe("meta/planner");
  expect(expandResumeShorthand(request("meta-claude-planner-0", "claude"))).toBeNull();
  expect(resumeCandidateNames(request("builder", "codex"))).toEqual(["meta-codex-builder"]);
  expect(resumeCandidateNames(request("planner-0", "claude"))).toEqual(["meta/planner", "meta-claude-planner", "meta-claude-planner-0"]);
});
