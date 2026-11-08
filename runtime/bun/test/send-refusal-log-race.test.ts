// Run as its own entry: the statSync spy must precede the rotator's first import.
//
// tap-atnqw: two senders that both saw the full log could both rotate. The
// second one's size re-check read the full file, a first rotator renamed it
// and created a fresh active file with its line, and the second rename then
// took that fresh file as a near-empty generation, which a prune could delete
// with its lines. This test forces that interleaving instead of hoping a
// loaded runner produces it: a second sender runs inside the first rotator's
// window between its re-check and its rename.
import { afterAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realStat = fs.statSync;
let insideWindow: ((path: string) => void) | null = null;
const spy = spyOn(fs, "statSync").mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
  // The rotator's re-check reads first; a second sender then runs before it can rename.
  const result = (realStat as (...args: unknown[]) => unknown)(path, ...rest);
  const hook = insideWindow;
  if (hook && String(path).endsWith("/send-refusals.log")) { insideWindow = null; hook(String(path)); }
  return result;
}) as typeof fs.statSync);
const { GENERATIONS_KEPT, recordSendRefusal, SEND_REFUSAL_LOG_CAP_BYTES } = await import("../src/send-refusal-log");
const MODULE = join(import.meta.dir, "..", "src", "send-refusal-log.ts");
const roots: string[] = [];
afterAll(() => { spy.mockRestore(); for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

const generationsOf = (root: string) => fs.readdirSync(root).filter(name => /^send-refusals\.log\.\d{8}T\d{6}Z-/.test(name)).sort();
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

test("a sender inside another rotator's re-check window cannot make it rename the fresh log", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "refusal-race-")); roots.push(root);
  const path = join(root, "send-refusals.log");
  const filler = "y".repeat(SEND_REFUSAL_LOG_CAP_BYTES);
  fs.writeFileSync(path, filler);
  let second: ReturnType<typeof Bun.spawn> | undefined;
  insideWindow = active => {
    second = Bun.spawn([process.execPath, "-e",
      `import { recordSendRefusal } from ${JSON.stringify(MODULE)}; recordSendRefusal("unknown_recipient", { from: "second" }, "pre");`],
      { env: { ...process.env, TAP_INDEX_HOME: root }, stdout: "ignore", stderr: "pipe" });
    // Without serialization the second sender rotates and writes its line to a fresh
    // log right away; wait for that. With it, the second sender waits for this
    // rotator, so give it a bounded moment and go on: either way the outcome is exact.
    for (let waited = 0; waited < 2000; waited += 20) {
      if (fs.existsSync(active) && fs.readFileSync(active, "utf8").includes("\tsecond\t")) break;
      pause(20);
    }
  };
  recordSendRefusal("unknown_recipient", { from: "first" }, "pre", { TAP_INDEX_HOME: root });
  expect(insideWindow).toBeNull(); // the window was entered
  expect(second).toBeDefined();
  expect({ code: await second!.exited, stderr: await new Response(second!.stderr as ReadableStream).text() }).toEqual({ code: 0, stderr: "" });

  const gens = generationsOf(root);
  const active = fs.readFileSync(path, "utf8");
  // Exactly one rotation happened: the filler became the only generation, and both
  // lines sit in the fresh active log. No near-empty generation exists to be pruned.
  expect({
    generations: gens.length,
    fillerGeneration: gens.length === 1 && fs.readFileSync(join(root, gens[0]!), "utf8") === filler,
    activeSenders: active.split("\n").filter(Boolean).map(row => row.split("\t")[1]).sort(),
    kept: gens.length <= GENERATIONS_KEPT,
  }).toEqual({ generations: 1, fillerGeneration: true, activeSenders: ["first", "second"], kept: true });
}, 30_000);
