import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAIN, teamFixture, flushScratch } from "./support/send-reply-flip-fixture";

afterEach(() => flushScratch(), 40_000);

function assertRetained(fx: ReturnType<typeof teamFixture>, id: string) {
  expect(existsSync(join(fx.bus, "payloads", `${id}.md`))).toBe(true);
  expect(existsSync(join(fx.bus, "receipts", `${id}.placed`))).toBe(true);
  expect(existsSync(join(fx.bus, "receipts", `${id}.cancelled`))).toBe(false);
  expect(existsSync(join(fx.bus, "receipts", `${id}.sent`))).toBe(false);
  expect(existsSync(fx.env.FAKE_BAND as string)).toBe(false);
  expect(existsSync(fx.env.FAKE_SUBMITTED as string)).toBe(false);
}

test("public send refuses an exited pane before placement without suspending its row", () => {
  const fx = teamFixture({});
  const registry = join(fx.wt, ".tap/team-registry.json");
  const before = readFileSync(registry, "utf8");
  const id = "ua-20260924T000000Z-deaddeaddead";
  writeFileSync(fx.env.FAKE_DEAD as string, "1");
  const sent = Bun.spawnSync([process.execPath, MAIN, "send", "ub", "-m", "hello", "--from", "ua", "--ask", "--id", id, "--json"],
    { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe" });
  expect(sent.exitCode).toBe(1);
  expect(sent.stdout.toString() + sent.stderr.toString()).toContain("pane_dead");
  expect(readFileSync(registry, "utf8")).toBe(before);
  expect(existsSync(join(fx.bus, "payloads", `${id}.md`))).toBe(false);
});

for (const relay of [false, true]) test(`public ${relay ? "manual relay" : "bound send"} retains mail when the pane exits after placement`, async () => {
  const fx = teamFixture({});
  const id = `ua-20260924T00010${Number(relay)}Z-deaddeaddead`;
  const barrier = join(fx.root, "death-barrier");
  writeFileSync(`${barrier}.send-pre-publication.release`, "go");
  const argv = [process.execPath, MAIN, "send", "ub", "-m", "hello", "--from", "ua", "--ask", "--id", id, "--json"];
  if (relay) argv.push("--cross-worktree", "--pane", "ua:0.0");
  const child = Bun.spawn(argv, { cwd: fx.wt,
    env: { ...fx.env, TAP_RESET_FENCE_TEST_BARRIER: barrier, TAP_SCRATCH_ONLY: "1" }, stdout: "pipe", stderr: "pipe" });
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(`${barrier}.send-post-placement.reached`) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(`${barrier}.send-post-placement.reached`)).toBe(true);
    writeFileSync(fx.env.FAKE_DEAD as string, "1");
    writeFileSync(`${barrier}.send-post-placement.release`, "go");
    expect(await child.exited).toBe(5);
    const out = JSON.parse((await new Response(child.stdout).text()).trim().split("\n").at(-1)!);
    expect(out).toMatchObject({ status: "placed", delivery: "none", reason: "pane_dead" });
    expect(out.detail).toContain("has exited");
    assertRetained(fx, id);
  } finally {
    child.kill();
    await child.exited;
  }
}, 30_000);
