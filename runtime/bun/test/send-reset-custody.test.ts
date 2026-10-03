/**
 * Reset custody covers a send's bus mutations, never its pane I/O (tap-0p7hx).
 *
 * The fake tmux parks the recipient's first paste (or capture) while the test
 * acts: a registration-shaped custody request must get through, and a reset
 * fence published mid-delivery must be honored without the send mutating the
 * bus inside the reset's checkpoint.
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { acquireObligationLock } from "../src/panelock";
import { acquireResetFence, acquireResetMutationLock, releaseResetFence, withResetCustodyAsync } from "../src/reset";
import { fixture, releaseScratch, TAP } from "./support/send-delivery-fixture";

afterAll(releaseScratch, 40_000);

type Fx = ReturnType<typeof fixture>;

function start(fx: Fx, self: string, args: string[], at: "paste" | "capture") {
  const hold = join(fx.root, `hold-${Math.random().toString(36).slice(2)}`);
  const child = Bun.spawn([TAP, ...args, ...(args[0] === "reply" ? [] : ["--json"])], {
    cwd: fx.wt,
    env: { ...fx.env, TAP_SELF: self, FAKE_HOLD: hold, FAKE_HOLD_AT: at },
    stdout: "pipe", stderr: "pipe",
  });
  return { child, hold };
}

async function reached(hold: string, child: ReturnType<typeof Bun.spawn>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!existsSync(`${hold}.reached`) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
  expect(existsSync(`${hold}.reached`), "the send never reached the held pane step").toBe(true);
}

async function finish(hold: string, child: ReturnType<typeof Bun.spawn>) {
  writeFileSync(`${hold}.release`, "");
  const code = await child.exited;
  return { code, stdout: await new Response(child.stdout as ReadableStream).text(), stderr: await new Response(child.stderr as ReadableStream).text() };
}

/** Structural exclusion must still be available while delivery waits on a pane. */
function structuralCustody(fx: Fx): string {
  try {
    acquireResetMutationLock(fx.bus, "tap register", 1000).release();
    return "acquired";
  } catch (error) {
    return (error as { errorClass?: string }).errorClass ?? String(error);
  }
}

const receipts = (fx: Fx, suffix: string) => readdirSync(join(fx.bus, "receipts")).filter(f => f.endsWith(suffix));
const payloads = (fx: Fx) => readdirSync(join(fx.bus, "payloads")).filter(f => f.endsWith(".md"));

test("a native send holds no reset custody while it waits on the recipient's pane", async () => {
  const fx = fixture();
  const { child, hold } = start(fx, "ua", ["send", "rb", "-m", "hello"], "paste");
  let custody = "";
  try {
    await reached(hold, child);
    custody = structuralCustody(fx);
  } finally {
    const done = await finish(hold, child);
    expect(done.code, done.stderr).toBe(0);
    expect(JSON.parse(done.stdout.trim().split("\n").pop()!)).toMatchObject({ status: "injected" });
  }
  expect(custody).toBe("acquired");
  expect(receipts(fx, ".sent")).toHaveLength(1);
}, 60_000);

test("a native reply holds no reset custody across its outbound's pane delivery, and keeps the inbound's obligation lock", async () => {
  const fx = fixture();
  // rb asks ua, so ua holds an inbound to answer.
  const inbound = Bun.spawnSync([TAP, "send", "ua", "--ask", "-m", "question?", "--json"], {
    cwd: fx.wt, env: { ...fx.env, TAP_SELF: "rb" }, stdout: "pipe", stderr: "pipe",
  });
  expect(inbound.exitCode, inbound.stderr.toString()).toBe(0);
  const ref = (JSON.parse(inbound.stdout.toString().trim().split("\n").pop()!) as { id: string }).id;

  const { child, hold } = start(fx, "ua", ["reply", ref, "-m", "answer"], "paste");
  let custody = "", obligation = "";
  try {
    await reached(hold, child);
    custody = structuralCustody(fx);
    const lock = acquireObligationLock(ref, 200, fx.env);
    obligation = lock ? "free" : "held";
    lock?.release();
  } finally {
    const done = await finish(hold, child);
    expect(done.code, done.stderr).toBe(0);
  }
  expect({ custody, obligation }).toEqual({ custody: "acquired", obligation: "held" });
  expect(existsSync(join(fx.bus, "receipts", `${ref}.done`))).toBe(true);
}, 90_000);

test("a reset fence published after the text lands stops the Enter, keeps the canonical, and skips post-effect records", async () => {
  const fx = fixture();
  const { child, hold } = start(fx, "ua", ["send", "rb", "-m", "hello"], "paste");
  let token = "";
  try {
    await reached(hold, child);
    token = acquireResetFence(fx.bus, String(process.pid));
    const done = await finish(hold, child);
    // Text is in the composer: a possible effect, so unverified (rc 5), never a retraction.
    expect(done.code, done.stderr).toBe(5);
    expect(done.stderr).toContain("submit-unverified event not recorded (team_reset_fenced");
  } finally {
    if (child.exitCode === null) await finish(hold, child);
    if (token) releaseResetFence(fx.bus, token);
  }
  expect(payloads(fx)).toHaveLength(1);
  expect(receipts(fx, ".sent")).toHaveLength(0);
  expect(existsSync(join(fx.bus, "spool")) ? readdirSync(join(fx.bus, "spool")) : []).toEqual([]);
}, 60_000);

test("a reset fence published before the first keystroke leaves the payload placed and says it will not be delivered", async () => {
  const fx = fixture();
  const { child, hold } = start(fx, "ua", ["send", "rb", "-m", "hello"], "capture");
  let token = "";
  let done: Awaited<ReturnType<typeof finish>> | null = null;
  try {
    await reached(hold, child);
    token = acquireResetFence(fx.bus, String(process.pid));
    done = await finish(hold, child);
  } finally {
    if (child.exitCode === null) await finish(hold, child);
    if (token) releaseResetFence(fx.bus, token);
  }
  expect(done!.code, done!.stderr).toBe(5);
  const receipt = JSON.parse(done!.stdout.trim().split("\n").pop()!) as Record<string, string>;
  expect(receipt).toMatchObject({ status: "placed", delivery: "none", reason: "team_reset_fenced" });
  expect(receipt.action).toContain("will not be delivered");
  expect(payloads(fx)).toHaveLength(1);
  expect(receipts(fx, ".placed")).toHaveLength(1);
  expect(receipts(fx, ".sent")).toHaveLength(0);
}, 60_000);

// A delayed durable mail write must not serialize another recipient's send.
test("a mail mutation permits concurrent send but excludes structural reset custody", async () => {
  const fx = fixture();
  const held = await withResetCustodyAsync(fx.bus, "test delayed mail mutation", async () => {
    expect(structuralCustody(fx)).toBe("reset_custody_busy");
    const child = Bun.spawn([TAP, "send", "rb", "-m", "concurrent mail", "--json"], {
      cwd: fx.wt, env: { ...fx.env, TAP_SELF: "ua" }, stdout: "pipe", stderr: "pipe",
    });
    const output = new Response(child.stdout).text(), error = new Response(child.stderr).text();
    expect(await child.exited, await error).toBe(0);
    expect(JSON.parse((await output).trim().split("\n").pop()!)).toMatchObject({ status: "injected" });
  });
  expect(held.ok).toBe(true);
  expect(structuralCustody(fx)).toBe("acquired");
}, 60_000);


test("concurrent sends and a registration loop complete without custody refusals", async () => {
  const fx = fixture();
  const doc = JSON.parse(readFileSync(fx.registry, "utf8"));
  for (const handle of ["poll-a", "poll-b"]) doc.seats[handle] = { status: "active", delivery: "poll" };
  writeFileSync(fx.registry, JSON.stringify(doc));
  const run = async (args: string[]) => {
    const child = Bun.spawn([TAP, ...args, "--json"], { cwd: fx.wt, env: { ...fx.env, TAP_SELF: "ua" }, stdout: "pipe", stderr: "pipe" });
    const output = new Response(child.stdout).text(), error = new Response(child.stderr).text();
    const code = await child.exited;
    expect({ code, error: await error, output: await output }).toMatchObject({ code: 0 });
  };
  await Promise.all([
    (async () => { for (let n = 0; n < 4; n++) await run(["register", "loop", "--delivery", "poll"]); })(),
    ...["poll-a", "poll-b", "rb"].map(async target => {
      for (let n = 0; n < 3; n++) await run(["send", target, "-m", "concurrent mail"]);
    }),
  ]);
}, 60_000);
