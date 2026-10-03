// G2 naming vs the incumbent's rows (recorded from launcher.py before its new
// arm was deleted, launch-ts row 6), plus the G1 HERMES_BIN instrument gap.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  allocateName,
  namedSessionName,
  sanitizeComponent,
  sessionNameForHandle,
} from "../src/launcher/naming";

const G2_ORACLE_IDS = [
  "sanitize:trim-dots",
  "sanitize:empty-fallback",
  "sanitize:collapse-hyphens",
  "session_name_for_handle:keeps-handle-dots",
  "named_session_name:sanitizes-handle",
  "allocate:first-unsuffixed",
  "allocate:second-gets-2",
  "allocate:skips-taken-2",
  "allocate:index-0-maps-to-1",
  "allocate:literal-handle-keeps-dots",
  "allocate:sanitized-handle-collapses-dots",
  "N1:unicode-digit-suffix",
  "N2:trailing-newline-is-taken",
  "N3:dotted-prefix-is-literal",
] as const;

const runtimeRoot = resolve(import.meta.dir, "..");
const GOLDEN = resolve(import.meta.dir, "fixtures/launcher-naming-oracle.jsonl");
const adaptersTs = resolve(import.meta.dir, "../src/launcher/adapters.ts");

type OracleRow = {
  id: string;
  fn: string;
  got: string;
};

function loadOracle(): OracleRow[] {
  const rows = readFileSync(GOLDEN, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as OracleRow);
  if (rows.length === 0) {
    throw new Error("launcher-naming-oracle.jsonl has zero rows");
  }
  return rows;
}

function bunGot(id: string): string {
  switch (id) {
    case "sanitize:trim-dots":
      return sanitizeComponent("  Foo.Bar  ");
    case "sanitize:empty-fallback":
      return sanitizeComponent("***");
    case "sanitize:collapse-hyphens":
      return sanitizeComponent("a--b__c");
    case "session_name_for_handle:keeps-handle-dots":
      return sessionNameForHandle("Tap.Repo", "sol.max");
    case "named_session_name:sanitizes-handle":
      return namedSessionName("Tap.Repo", "sol.max");
    case "allocate:first-unsuffixed":
      return allocateName("AESOP-Improvements", "claude", null, []);
    case "allocate:second-gets-2":
      return allocateName("AESOP-Improvements", "claude", null, [
        "AESOP-Improvements/claude",
      ]);
    case "allocate:skips-taken-2":
      return allocateName("AESOP-Improvements", "codex", "ponytail", [
        "AESOP-Improvements/ponytail",
        "AESOP-Improvements/ponytail-2",
      ]);
    case "allocate:index-0-maps-to-1":
      return allocateName("b", "claude", null, ["b/claude-0"]);
    case "allocate:literal-handle-keeps-dots":
      return allocateName("tap", "codex", "sol.max", [], true);
    case "allocate:sanitized-handle-collapses-dots":
      return allocateName("tap", "codex", "sol.max", []);
    case "N1:unicode-digit-suffix":
      return allocateName("b", "claude", null, ["b/claude", "b/claude-٢"]);
    case "N2:trailing-newline-is-taken":
      return allocateName("b", "claude", null, ["b/claude", "b/claude-2\n"]);
    case "N3:dotted-prefix-is-literal":
      return allocateName("b", "claude", "tap.2", ["b/tap.2", "b/tapX2-2"], true);
    default:
      throw new Error(`unmapped naming cell ${id}`);
  }
}

describe("G2 naming differential", () => {
  test("the incumbent's rows are byte-identical to the Bun namer", () => {
    const oracle = loadOracle();
    const mismatches: string[] = [];
    const ids = new Set<string>();
    for (const row of oracle) {
      ids.add(row.id);
      const bun = bunGot(row.id);
      if (bun !== row.got) {
        mismatches.push(`${row.id}: incumbent ${JSON.stringify(row.got)} bun ${JSON.stringify(bun)}`);
      }
    }
    expect(oracle.length).toBe(14);
    expect([...ids].sort()).toEqual([...G2_ORACLE_IDS].sort());
    expect(ids.has("N1:unicode-digit-suffix")).toBe(true);
    expect(ids.has("N2:trailing-newline-is-taken")).toBe(true);
    expect(ids.has("N3:dotted-prefix-is-literal")).toBe(true);
    expect(mismatches).toEqual([]);
  });

  test("N1 unicode digit reserves index 2", () => {
    expect(allocateName("b", "claude", null, ["b/claude", "b/claude-٢"])).toBe(
      "b/claude-3",
    );
  });

  test("N3 unescaped-dot wildcard is not how the port matches", () => {
    expect(
      allocateName("b", "claude", "tap.2", ["b/tap.2", "b/tapX2-2"], true),
    ).toBe("b/tap.2-2");
  });
});

describe("G2 carries G1 HERMES_BIN instrument gap", () => {
  test("hermes-bin-literal-under-foreign-HOME", () => {
    const src = readFileSync(adaptersTs, "utf8");
    expect(src).toContain(
      'export const HERMES_BIN = "hermes"',
    );
    expect(src).not.toMatch(/process\.env\.HOME/);
    expect(src).not.toMatch(/homedir\s*\(/);

    const href = pathToFileURL(adaptersTs).href;
    const r = spawnSync(
      process.execPath,
      [
        "-e",
        `const m = await import(${JSON.stringify(href)});
if (m.HERMES_BIN !== "hermes") {
  console.error(m.HERMES_BIN);
  process.exit(1);
}`,
      ],
      {
        encoding: "utf8",
        cwd: runtimeRoot,
        env: { ...process.env, HOME: "/Users/username" },
      },
    );
    expect(r.status ?? 1).toBe(0);
    expect(r.stderr).toBe("");
  });
});
