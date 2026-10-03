// tap_serial_triggers "bin/" "runtime/bun/main.ts" "runtime/bun/src/verbs/send.ts" "runtime/bun/src/send-refusal-log.ts" "runtime/bun/test/support/send-delivery-fixture.ts"
// A send that places its canonical and then takes it back off the bus, and
// fails, is a refused send the delivery census cannot see (tap-4dcii): the
// canonical is gone and the `.placed` receipt is gone or says nothing about
// the refusal. Each such send appends one line to the machine refusal log, with
// a sixth field `withdrawn`; a refusal before placement carries `pre`. Every
// claim runs through the real `tap send` entry point over the delivery
// fixture's fake tmux, in a sandbox whose index home is the fixture's.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { acquirePaneLock } from "../src/panelock";
import { acquireResetFence, releaseResetFence } from "../src/reset";
import { fixture, releaseScratch, run, TAP } from "./support/send-delivery-fixture";

afterAll(releaseScratch, 40_000);

type Fx = ReturnType<typeof fixture>;
const logPath = (fx: Fx) => join(fx.env.TAP_INDEX_HOME as string, "send-refusals.log");
const rows = (fx: Fx) => (existsSync(logPath(fx)) ? readFileSync(logPath(fx), "utf8").split("\n").filter(Boolean).map(row => row.split("\t")) : []);
const receipts = (fx: Fx, suffix: string) => readdirSync(join(fx.bus, "receipts")).filter(name => name.endsWith(suffix));
const payloads = (fx: Fx) => readdirSync(join(fx.bus, "payloads")).filter(name => name.endsWith(".md"));

/** Time dropped: the fields a reader counts by. */
const counted = (fx: Fx) => rows(fx).map(row => ({ from: row[1], to: row[2], team: row[3], id: row[4], phase: row[5], extra: row.length - 6 }));

test("a --no-spool send that places and then withdraws on a held pane lock is counted as withdrawn", () => {
  const fx = fixture();
  const lock = acquirePaneLock("%7", 5000, fx.env);
  expect(lock).not.toBeNull();
  try {
    const v = run(fx, ["send", "rb", "-m", "SECRET-BODY-MARKER", "--no-spool"]);
    expect(v.code).toBe(1);
    expect(v.receipt.error_class).toBe("delivery_refused");
    expect({ payloads: v.payloads, placed: v.placed }).toEqual({ payloads: 0, placed: 0 });
  } finally { lock!.release(); }
  expect(counted(fx)).toEqual([{ from: "ua", to: "rb", team: "alpha", id: "delivery_refused", phase: "withdrawn", extra: 0 }]);
  expect(readFileSync(logPath(fx), "utf8")).not.toContain("SECRET");
}, 120_000);

test("an unbound manual relay refused at the park convergence is counted as withdrawn", () => {
  const fx = fixture();
  const v = run(fx, ["send", "rb", "-m", "hi", "--cross-worktree", "--pane", "rb:0.0", "--polite"]);
  expect(v.code).toBe(1);
  expect(v.receipt.error_class).toBe("identity_unverified");
  expect(v.stderr + JSON.stringify(v.receipt)).toContain("cannot be parked");
  expect({ payloads: v.payloads, placed: v.placed }).toEqual({ payloads: 0, placed: 0 });
  expect(counted(fx)).toEqual([{ from: "ua", to: "rb", team: "alpha", id: "identity_unverified", phase: "withdrawn", extra: 0 }]);
}, 120_000);

test("an urgent send into a live clear fence withdraws its canonical and is counted once, though its .placed stays", () => {
  const fx = fixture({ clearFence: true });
  const v = run(fx, ["send", "rb", "-m", "hi", "--urgent"]);
  expect(v.code).toBe(1);
  expect(v.receipt.error_class).toBe("recipient_clearing");
  expect({ payloads: v.payloads, placed: v.placed }).toEqual({ payloads: 0, placed: 1 });
  expect(counted(fx)).toEqual([{ from: "ua", to: "rb", team: "alpha", id: "recipient_clearing", phase: "withdrawn", extra: 0 }]);
}, 120_000);

test("a send that cannot write its attempt evidence withdraws its canonical and is counted as withdrawn", () => {
  const fx = fixture();
  mkdirSync(join(fx.bus, "receipts", "no-evidence.submit-phases.jsonl"));
  const v = run(fx, ["send", "rb", "-m", "hi", "--id", "no-evidence", "--urgent"]);
  expect(v.code).toBe(1);
  expect(v.receipt.error_class).toBe("attempt_evidence_unwritable");
  expect(v.payloads).toBe(0);
  expect(counted(fx)).toEqual([{ from: "ua", to: "rb", team: "alpha", id: "attempt_evidence_unwritable", phase: "withdrawn", extra: 0 }]);
}, 120_000);

test("a --no-spool refusal before placement (copy-mode) is counted once, as pre", () => {
  const fx = fixture({ copyMode: true });
  const v = run(fx, ["send", "rb", "-m", "hi", "--no-spool"]);
  expect(v.code).toBe(1);
  expect(v.receipt.error_class).toBe("delivery_refused");
  expect({ payloads: v.payloads, placed: v.placed }).toEqual({ payloads: 0, placed: 0 });
  expect(counted(fx)).toEqual([{ from: "ua", to: "rb", team: "alpha", id: "delivery_refused", phase: "pre", extra: 0 }]);
}, 120_000);

test("a delivered send appends nothing", () => {
  const fx = fixture();
  const v = run(fx, ["send", "rb", "-m", "hi"]);
  expect(v.code, v.stderr).toBe(0);
  expect(existsSync(logPath(fx))).toBe(false);
}, 120_000);

test("a send whose withdrawal custody refuses keeps its payload, exits placed, and appends nothing", async () => {
  const fx = fixture();
  const hold = join(fx.root, "hold");
  const child = Bun.spawn([TAP, "send", "rb", "-m", "hello", "--json"], {
    cwd: fx.wt, env: { ...fx.env, TAP_SELF: "ua", FAKE_HOLD: hold, FAKE_HOLD_AT: "capture" }, stdout: "pipe", stderr: "pipe",
  });
  let token = "";
  try {
    const deadline = Date.now() + 30_000;
    while (!existsSync(`${hold}.reached`) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(`${hold}.reached`)).toBe(true);
    token = acquireResetFence(fx.bus, String(process.pid));
  } finally {
    await Bun.write(`${hold}.release`, "");
    if (token) { await child.exited; releaseResetFence(fx.bus, token); }
  }
  expect(await child.exited).toBe(5);
  expect(payloads(fx)).toHaveLength(1);
  expect(receipts(fx, ".placed")).toHaveLength(1);
  expect(existsSync(logPath(fx))).toBe(false);
}, 120_000);

test("an unwritable log leaves a withdrawn send's exit, stdout and stderr unchanged", () => {
  const plain = run(fixture({ clearFence: true }), ["send", "rb", "-m", "hi", "--urgent"]);
  const fx = fixture({ clearFence: true });
  mkdirSync(logPath(fx));
  const squatted = run(fx, ["send", "rb", "-m", "hi", "--urgent"]);
  expect(plain.code).toBe(1);
  expect({ code: squatted.code, stdout: squatted.stdout, stderr: squatted.stderr }).toEqual({ code: plain.code, stdout: plain.stdout, stderr: plain.stderr });
}, 120_000);
