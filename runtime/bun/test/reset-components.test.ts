import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { componentTable, fileCount } from "../src/team/reset-components";

test("one component authority excludes historical scratch and ignores leaked production overrides", () => {
  const table = componentTable({ TAP_RESET_COMPONENT_TABLE_OVERRIDE: "payloads|discard|bad|bus" });
  expect(table.find(c => c.name === "payloads")?.fate).toBe("checkpoint");
  expect(table.find(c => c.name === "team-registry.json")?.scope).toBe("acting");
  expect(table.find(c => c.name === "locks")?.fate).toBe("preserve");
  expect(table.some(c => c.name.startsWith("review-pr155"))).toBe(false);
  expect(componentTable({ TAP_SCRATCH_ONLY: "/scratch", TAP_RESET_COMPONENT_TABLE_OVERRIDE: "payloads|discard|test|bus" })).toEqual([
    { name: "payloads", fate: "discard", scope: "bus" },
  ]);
  for (const row of ["../escape|checkpoint||bus", "payloads|unknown||bus", "payloads|checkpoint||other", "a|checkpoint\na|discard"]) {
    expect(() => componentTable({ TAP_SCRATCH_ONLY: "/scratch", TAP_RESET_COMPONENT_TABLE_OVERRIDE: row })).toThrow("invalid component row");
  }
});

test("checkpoint inventory preserves legacy regular-file counts without following links", () => {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "components-"));
  const source = join(root, "source"), outside = join(root, "outside");
  mkdirSync(source); mkdirSync(outside);
  writeFileSync(join(source, "one"), "1"); writeFileSync(join(outside, "secret"), "2");
  symlinkSync(outside, join(source, "link"));
  symlinkSync(join(root, "absent"), join(source, "dangling"));
  // Bash's persisted find -type f inventory counted only the regular file.
  expect(fileCount(source)).toBe(1);
  expect(fileCount(join(root, "absent"))).toBe(0);
});
