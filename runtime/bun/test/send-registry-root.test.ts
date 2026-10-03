import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireRegistryLock } from "../src/panelock";
import { REENABLED, teamFixture, flushScratch } from "./support/send-reply-flip-fixture";

afterEach(() => flushScratch(), 40_000);

for (const layout of [".tap/team-registry.json", ".tap/bus/registry.json"]) {
  for (const operation of ["suspend", "heal", "remote-heal"]) test(`${operation} uses the selected team root with ${layout}`, () => {
    const fx = teamFixture({ recipientGone: operation === "suspend", ...(operation !== "suspend" ? {
      seats: { ub: { status: "active", pane: "%7", pane_id: "%7", server_epoch: "srv:123:456", instance: "ub|A", harness: "claude" } },
    } : {}) });
    const original = join(fx.wt, ".tap/team-registry.json"), selected = join(fx.wt, layout);
    const before = readFileSync(original, "utf8"), prior = JSON.parse(before);
    if (selected !== original) copyFileSync(original, selected);
    const indexPath = join(fx.root, "index/global-registry.json");
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    index.teams.flip.registry_location = selected;
    writeFileSync(indexPath, JSON.stringify(index));
    if (operation === "suspend") writeFileSync(fx.env.FAKE_UB_GONE!, "");

    const id = "ua-20260923T104500Z-aabbccddeeff";
    const result = Bun.spawnSync([process.execPath, REENABLED, "send", operation === "remote-heal" ? "flip/ub" : "ub",
      "-m", "hello", "--from", "ua", "--id", id, ...(operation === "remote-heal" ? ["--remote-registry", selected] : [])], {
      cwd: fx.wt, env: { ...fx.env, TAP_DRIVER_FORCE_TMUX: "1", TAP_TUI_SETTLE_SCALE: "0.1" },
      stdout: "pipe", stderr: "pipe", timeout: 30000,
    });
    expect(result.exitCode, result.stderr.toString()).toBe(operation === "suspend" ? 3 : 0);
    const after = JSON.parse(readFileSync(selected, "utf8"));
    expect(after.seats.ua).toEqual(prior.seats.ua);
    if (operation === "suspend") {
      expect(after.seats.ub).toEqual({ ...prior.seats.ub, status: "suspended", status_reason: "pane_gone", exited_at: expect.any(String) });
      expect(after.seats.ub.exited_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(existsSync(join(fx.bus, "payloads", `${id}.md`))).toBe(false);
      expect(existsSync(fx.env.FAKE_KEYS!)).toBe(false);
    } else {
      expect(after.seats.ub).toEqual({ ...prior.seats.ub, pane: "ub:0.0" });
      expect(result.stderr.toString()).toContain("healed id-shaped pane field for ub → ub:0.0");
      expect(existsSync(join(fx.bus, "receipts", `${id}.sent`))).toBe(true);
    }
    if (selected !== original) expect(readFileSync(original, "utf8")).toBe(before);
  }, 60000);
}

for (const race of ["busy", "changed"]) test(`suspension reports registry ${race}, not tmux failure`, async () => {
  const fx = teamFixture({ recipientGone: true }), registry = join(fx.wt, ".tap/team-registry.json");
  writeFileSync(fx.env.FAKE_UB_GONE!, "");
  const barrier = join(fx.root, "suspend"), before = readFileSync(registry, "utf8");
  const child = Bun.spawn([process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua", "--json"], {
    cwd: fx.wt, env: { ...fx.env, TAP_SCRATCH_ONLY: "1", TAP_RESET_FENCE_TEST_BARRIER: barrier }, stdout: "pipe", stderr: "pipe",
  });
  const output = new Response(child.stdout).text(), error = new Response(child.stderr).text();
  let writer: ReturnType<typeof acquireRegistryLock> = null;
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(`${barrier}.send-before-suspend.reached`) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(`${barrier}.send-before-suspend.reached`)).toBe(true);
    writer = acquireRegistryLock(registry, 0, fx.env); expect(writer).not.toBeNull();
    if (race === "changed") {
      const doc = JSON.parse(before); doc.seats.ub.instance = "ub|successor";
      writeFileSync(registry, JSON.stringify(doc)); writer!.release(); writer = null;
    }
    writeFileSync(`${barrier}.send-before-suspend.release`, "");
    expect(await child.exited, await error).toBe(1);
    expect(JSON.parse((await output).trim())).toMatchObject({ error_class: race === "busy" ? "registry_lock_busy" : "forwarding_changed", action: "retry the send" });
    expect(JSON.parse(readFileSync(registry, "utf8")).seats.ub.status).toBe("active");
  } finally {
    writer?.release(); writeFileSync(`${barrier}.send-before-suspend.release`, ""); await child.exited;
  }
}, 30_000);
