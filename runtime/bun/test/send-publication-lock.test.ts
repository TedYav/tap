import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireRegistryLock, acquireRegistryLockAsync } from "../src/panelock";
import { envelopeField } from "../src/envelope";
import { fixture, releaseScratch, TAP } from "./support/send-delivery-fixture";

afterAll(releaseScratch, 40_000);

for (const handle of ["ua", "rb"]) test(`publication excludes ${handle}'s instance mint after final validation`, async () => {
  const fx = fixture(), barrier = join(fx.root, "publication");
  const doc = JSON.parse(readFileSync(fx.registry, "utf8"));
  doc.seats.rb.delivery = "poll";
  writeFileSync(fx.registry, JSON.stringify(doc));
  writeFileSync(`${barrier}.send-post-placement.release`, "");
  const child = Bun.spawn([TAP, "send", "rb", "--ask", "-m", "must remain visible", "--json"], {
    cwd: fx.wt, env: { ...fx.env, TAP_SELF: "ua", TAP_SCRATCH_ONLY: "1", TAP_RESET_FENCE_TEST_BARRIER: barrier },
    stdout: "pipe", stderr: "pipe",
  });
  const output = new Response(child.stdout).text(), error = new Response(child.stderr).text();
  let writerAcquired = false;
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(`${barrier}.send-pre-publication.reached`) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(`${barrier}.send-pre-publication.reached`)).toBe(true);
    const writer = acquireRegistryLock(fx.registry, 0, fx.env);
    writerAcquired = writer !== null;
    if (writer) try {
      // The refresh retirement transaction scans no payload, then mints in place.
      expect(readdirSync(join(fx.bus, "payloads"))).toEqual([]);
      doc.seats[handle].instance = `${handle}|successor`;
      writeFileSync(fx.registry, JSON.stringify(doc));
    } finally { writer.release(); }
  } finally {
    writeFileSync(`${barrier}.send-pre-publication.release`, "");
    await child.exited;
  }
  expect(child.exitCode, await error).toBe(0);
  const result = JSON.parse((await output).trim().split("\n").pop()!);
  const payload = readFileSync(join(fx.bus, "payloads", `${result.id}.md`), "utf8");
  expect(envelopeField(payload, handle === "ua" ? "sender_instance" : "recipient_instance"))
    .toBe(JSON.parse(readFileSync(fx.registry, "utf8")).seats[handle].instance);
  expect(writerAcquired).toBe(false);
}, 30_000);

async function run(fx: ReturnType<typeof fixture>, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const child = Bun.spawn([TAP, ...args, "--json"], { cwd: fx.wt, env: { ...fx.env, TAP_SELF: "ua", ...extra }, stdout: "pipe", stderr: "pipe" });
  const output = new Response(child.stdout).text(), error = new Response(child.stderr).text();
  const code = await child.exited;
  expect({ code, stderr: await error, stdout: await output }).toMatchObject({ code: 0 });
}

test("opposite cross-team sends and both registry writers complete concurrently", async () => {
  const a = fixture(), b = fixture();
  for (const [fx, name] of [[a, "alpha"], [b, "beta"]] as const) {
    const doc = JSON.parse(readFileSync(fx.registry, "utf8"));
    doc.team.name = name;
    writeFileSync(fx.registry, JSON.stringify(doc));
  }
  const index = a.env.TAP_INDEX_HOME!;
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    alpha: { root: a.wt, registry_location: a.registry }, beta: { root: b.wt, registry_location: b.registry },
  } }));
  await Promise.all([
    ...[[a, "beta/rb"], [b, "alpha/rb"]].map(async ([fx, target]) => {
      for (let n = 0; n < 4; n++) await run(fx as typeof a, ["send", target as string, "--ask", "-m", "crossing"], { TAP_INDEX_HOME: index });
    }),
    ...[a, b].map(async fx => {
      for (let n = 0; n < 4; n++) await run(fx, ["register", "loop", "--delivery", "poll"], { TAP_INDEX_HOME: index });
    }),
  ]);
  expect(readdirSync(join(a.bus, "payloads"))).toHaveLength(4);
  expect(readdirSync(join(b.bus, "payloads"))).toHaveLength(4);
}, 60_000);

test("publication readers share the registry while one sender is delayed", async () => {
  const fx = fixture(), barrier = join(fx.root, "slow-publication");
  const doc = JSON.parse(readFileSync(fx.registry, "utf8")); doc.seats.rb.delivery = "poll";
  writeFileSync(fx.registry, JSON.stringify(doc));
  writeFileSync(`${barrier}.send-post-placement.release`, "");
  const first = run(fx, ["send", "rb", "-m", "first"], { TAP_SCRATCH_ONLY: "1", TAP_RESET_FENCE_TEST_BARRIER: barrier });
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(`${barrier}.send-pre-publication.reached`) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(`${barrier}.send-pre-publication.reached`)).toBe(true);
    await run(fx, ["send", "rb", "-m", "second"]);
  } finally {
    writeFileSync(`${barrier}.send-pre-publication.release`, "");
    await first;
  }
  expect(readdirSync(join(fx.bus, "payloads"))).toHaveLength(2);
}, 30_000);


test("an exclusive registry writer queued behind publication completes within its deadline", async () => {
  const fx = fixture(), barrier = join(fx.root, "queued-writer");
  const doc = JSON.parse(readFileSync(fx.registry, "utf8")); doc.seats.rb.delivery = "poll";
  writeFileSync(fx.registry, JSON.stringify(doc));
  writeFileSync(`${barrier}.send-post-placement.release`, "");
  const send = run(fx, ["send", "rb", "--ask", "-m", "visible before retirement"], { TAP_SCRATCH_ONLY: "1", TAP_RESET_FENCE_TEST_BARRIER: barrier });
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(`${barrier}.send-pre-publication.reached`) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(`${barrier}.send-pre-publication.reached`)).toBe(true);
    let acquired = false;
    const pending = acquireRegistryLockAsync(fx.registry, 2000, undefined, fx.env).then(lock => { acquired = lock !== null; return lock; });
    await Bun.sleep(50); expect(acquired).toBe(false);
    writeFileSync(`${barrier}.send-pre-publication.release`, "");
    const writer = await pending;
    expect(writer).not.toBeNull();
    try { expect(readdirSync(join(fx.bus, "payloads"))).toHaveLength(1); }
    finally { await writer?.release(); }
  } finally {
    writeFileSync(`${barrier}.send-pre-publication.release`, ""); await send;
  }
}, 30_000);
