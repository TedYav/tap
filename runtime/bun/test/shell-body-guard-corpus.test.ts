// S1 corpus replay: the Bun hook must reproduce the Python hook's frozen
// stdout bytes and exit status on every arm, byte-exact, via the pure
// process contract (hookResponse) — and through the real launch command for
// one arm per response shape and each malformed-stdin class.
// Corpus: runtime/bun/test/goldens/shell-body-guard/corpus.jsonl (captured
// once from hooks/tap-shell-body-guard.py; see corpus-meta.json).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { hookResponse } from "../src/shell-body-guard";

type Arm = {
  name: string;
  kind: string;
  harness: string;
  stdin?: string;
  stdin_b64: string;
  expected_stdout_b64: string;
  expected_exit: number;
};

const arms: Arm[] = readFileSync(
  resolve(import.meta.dir, "goldens/shell-body-guard/corpus.jsonl"),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as Arm);

const KINDS = ["allow", "tmux", "repair_inline", "repair_heredoc", "heredoc_backtick"];
const HARNESSes = ["pretool", "cursor", "antigravity"];

test("corpus shape: exact arm count and a non-empty cell for every kind x harness", () => {
  expect(arms.length).toBe(273);
  expect(new Set(arms.map((a) => a.name)).size).toBe(arms.length);
  const cells = new Map<string, number>();
  for (const arm of arms) {
    const key = `${arm.kind}|${arm.harness}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }
  for (const kind of KINDS) {
    for (const harness of HARNESSes) {
      expect(cells.get(`${kind}|${harness}`) ?? 0).toBeGreaterThan(0);
    }
  }
});

describe("frozen corpus replay (byte-exact stdout + exit)", () => {
  for (const arm of arms) {
    test(arm.name, () => {
      if (arm.stdin !== undefined) {
        expect(Buffer.from(arm.stdin, "utf8").toString("base64")).toBe(arm.stdin_b64);
      }
      const result = hookResponse(new Uint8Array(Buffer.from(arm.stdin_b64, "base64")));
      expect(Buffer.from(result.stdout, "utf8").toString("base64")).toBe(arm.expected_stdout_b64);
      expect(result.exit).toBe(arm.expected_exit);
    });
  }
});

describe("process contract through the launch command", () => {
  const hook = resolve(import.meta.dir, "../../../hooks/tap-shell-body-guard.ts");
  const wanted = [
    "matrix-tmux-pretool",
    "matrix-tmux-cursor",
    "matrix-tmux-antigravity",
    "matrix-inline-pretool",
    "matrix-allow-pretool",
    "stdin-empty",
    "stdin-bom-fail-open",
    "stdin-nan-python-denies",
    "nan-in-string-is-never-rewritten",
    "decoder-invalid-byte-in-comment-tmux",
    "stdin-invalid-utf8-surrogateescape-allow",
  ];
  for (const name of wanted) {
    const arm = arms.find((a) => a.name === name);
    expect(arm).toBeDefined();
    test(`subprocess ${name}`, () => {
      const child = spawnSync("bun", [hook], {
        input: Buffer.from(arm!.stdin_b64, "base64"),
        timeout: 15_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      if (child.status !== arm!.expected_exit || child.stderr) {
        console.error(`subprocess ${name}: status=${child.status} stderr=${child.stderr?.toString()}`);
      }
      expect(child.status).toBe(arm!.expected_exit);
      expect(child.stdout?.toString("base64")).toBe(arm!.expected_stdout_b64);
    }, 20_000);
  }
});
