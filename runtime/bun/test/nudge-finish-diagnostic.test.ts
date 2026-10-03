import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { finishRecordedNudge } from "../src/verbs/nudge";

// `nudge-finish` runs in a `finally`, after the nudge already has its result. A
// failure there must neither replace that result nor go unseen (tap-k9emb).
const roots: string[] = [];
const saved = { index: process.env.TAP_INDEX_HOME, write: process.stderr.write.bind(process.stderr) };
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (saved.index === undefined) delete process.env.TAP_INDEX_HOME; else process.env.TAP_INDEX_HOME = saved.index;
  process.stderr.write = saved.write;
});

const ID = "recovery-913721a7-578f-4fe1-ba72-05e8e2bb31b7";
function captured(body: () => void): string {
  let out = "";
  process.stderr.write = ((chunk: string | Uint8Array) => { out += String(chunk); return true; }) as typeof process.stderr.write;
  try { body(); } finally { process.stderr.write = saved.write; }
  return out;
}
function index(): string {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "nudge-finish-")); roots.push(root);
  process.env.TAP_INDEX_HOME = root;
  return root;
}

test("a missing recovery artifact yields one diagnostic naming the id, and does not throw", () => {
  index();
  const err = captured(() => expect(() => finishRecordedNudge(ID, 0)).not.toThrow());
  expect(err.trimEnd().split("\n")).toHaveLength(1);
  expect(err).toContain("recovery release could not be confirmed (");
  expect(err).toContain(`inspect: tap debug recovery ${ID}`);
  // What is known is only that release was unconfirmed, not what state the record is in.
  expect(err).not.toContain("stays active");
});

test("an invalid recovery artifact yields the same bounded diagnostic", () => {
  const root = index();
  mkdirSync(join(root, "debug", "recovery", ID), { recursive: true });
  writeFileSync(join(root, "debug", "recovery", ID, "run.json"), "{ not json");
  const err = captured(() => finishRecordedNudge(ID, 7));
  expect(err.trimEnd().split("\n")).toHaveLength(1);
  expect(err).toContain(`tap debug recovery ${ID}`);
  expect(err).toContain("recovery release could not be confirmed (");
  expect(err.length).toBeLessThan(400);
});
