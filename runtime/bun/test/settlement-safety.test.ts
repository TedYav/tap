import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { Bus } from "../src/bus";
import { TapError, type Context } from "../src/context";
import { stampEnvelope } from "../src/envelope";
import { settle } from "../src/verbs/done";
import { removeScratchTree } from "./support/scratch";

import { KERNEL_LOCK, kernelLockArgs } from "../src/panelock";

const MAIN = join(import.meta.dir, "..", "main.ts");
let root: string;
let bus: Bus;
let registryPath: string;
let ctx: Context;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tap-settlement-safety.")));
  bus = new Bus(join(root, "team", ".tap", "bus"));
  bus.ensureDirs();
  registryPath = join(root, "team", ".tap", "team-registry.json");
  ctx = { bus, busRule: "env", team: "team", registryPath, root: join(root, "team") };
});

afterEach(() => removeScratchTree(root));

function seed(id: string, instance: string, rowInstance?: string) {
  mkdirSync(join(root, "team", ".tap"), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({
    schema: "0.20",
    team: { name: "team", worktree_root: join(root, "team") },
    seats: { rcv: { status: "active", ...(rowInstance ? { instance: rowInstance } : {}) } },
  }));
  const path = bus.payloadPath(id);
  writeFileSync(path, stampEnvelope("---\n---\nquestion\n", {
    id, from: "snd", to: "rcv", kind: "discuss", path, reply: "expected",
    recipient_instance: instance,
  }));
}

describe("recipient-instance settlement authority", () => {
  test("missing actor is refused before a missing payload is read", () => {
    const id = "snd-20260825T040000Z-000000000000";

    try {
      settle(ctx, id, "");
      throw new Error("settle unexpectedly succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(TapError);
      expect((error as TapError).errorClass).toBe("no_actor");
      expect((error as TapError).action).toBe("only the addressee settles");
    }
  });

  test("a bound obligation refuses an instance-less current row", () => {
    const id = "snd-20260825T040000Z-aaaaaaaaaaaa";
    seed(id, "rcv|predecessor");

    try {
      settle(ctx, id, "rcv");
      throw new Error("settle unexpectedly succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(TapError);
      expect((error as TapError).errorClass).toBe("instance_unresolved");
      expect((error as TapError).detail).toContain("no verified instance in selected team 'team'");
      expect((error as TapError).action).toContain("--team <registered-team>");
      expect((error as TapError).action).not.toContain("cancel");
    }
    expect(existsSync(bus.donePath(id))).toBe(false);
  });

  test("the matching current instance may settle", () => {
    const id = "snd-20260825T040000Z-bbbbbbbbbbbb";
    seed(id, "rcv|current", "rcv|current");

    settle(ctx, id, "rcv");
    expect(existsSync(bus.donePath(id))).toBe(true);
    // The receipt names the settling instance beside `by` (tap-stap): greppable against the
    // envelope's recipient_instance, which it is compared with and never copied from.
    expect(JSON.parse(readFileSync(bus.donePath(id), "utf8"))).toMatchObject({ by: "rcv", instance: "rcv|current" });
  });

  test("an unbound obligation settled by a row with no instance stamps the explicit unresolved value", () => {
    const id = "snd-20260825T040000Z-dddddddddddd";
    seed(id, "");

    settle(ctx, id, "rcv");
    expect(JSON.parse(readFileSync(bus.donePath(id), "utf8")).instance).toBe("unresolved");
  });
});

describe("settlement serialization", () => {
  test("concurrent done processes publish exactly one successful effect", async () => {
    const id = "snd-20260825T040000Z-cccccccccccc";
    seed(id, "rcv|current", "rcv|current");
    const readyDir = join(root, "done-ready");
    const release = join(root, "done-release");
    mkdirSync(readyDir);
    const busModule = join(import.meta.dir, "..", "src", "bus");
    const doneModule = join(import.meta.dir, "..", "src", "verbs", "done");
    const source = (i: number) => `
      import { Bus } from ${JSON.stringify(busModule)};
      import { settle } from ${JSON.stringify(doneModule)};
      import { existsSync, writeFileSync } from "node:fs";
      const bus = new Bus(${JSON.stringify(bus.home)});
      const ctx = {
        bus, busRule: "env", team: "team",
        registryPath: ${JSON.stringify(registryPath)}, root: ${JSON.stringify(join(root, "team"))},
      };
      writeFileSync(${JSON.stringify(join(readyDir, "ready."))} + ${JSON.stringify(String(i))}, "ready\\n");
      while (!existsSync(${JSON.stringify(release)})) Bun.sleepSync(5);
      try {
        settle(ctx, ${JSON.stringify(id)}, "rcv");
        console.log("DONE");
      } catch (error) {
        console.log(error?.errorClass || error?.message || "ERROR");
      }
    `;
    const children = Array.from({ length: 16 }, (_, i) => Bun.spawn(["bun", "-e", source(i)], {
      env: { ...process.env, TAP_LOCK_DIR: join(root, "locks") },
      stdout: "pipe", stderr: "pipe",
    }));
    const deadline = Date.now() + 15_000;
    while (true) {
      const ready = Array.from(new Bun.Glob("ready.*").scanSync(readyDir)).length;
      if (ready === children.length) break;
      if (Date.now() >= deadline) {
        throw new Error(`done contenders did not all reach the release barrier (${ready}/${children.length} ready)`);
      }
      Bun.sleepSync(10);
    }
    writeFileSync(release, "go\n");
    const criticalBase = process.env.TAP_OBLIGATION_TEST_BARRIER;
    if (criticalBase) {
      const criticalDir = dirname(criticalBase);
      const criticalPattern = `${basename(criticalBase)}.done-after-eligibility.*.reached`;
      const criticalDeadline = Date.now() + 15_000;
      while (Array.from(new Bun.Glob(criticalPattern).scanSync(criticalDir)).length !== children.length) {
        if (Date.now() >= criticalDeadline) {
          throw new Error("done contenders did not all reach the post-eligibility mutation barrier");
        }
        Bun.sleepSync(10);
      }
      writeFileSync(`${criticalBase}.done-after-eligibility.release`, "go\n");
    }
    const out = await Promise.all(children.map((child) => new Response(child.stdout).text()));
    const err = await Promise.all(children.map((child) => new Response(child.stderr).text()));

    expect(err.filter((line) => line.trim())).toEqual([]);
    expect(out.filter((line) => line.trim())).toHaveLength(16);
    expect(out.filter((line) => line.trim() === "DONE")).toHaveLength(1);
    expect(existsSync(bus.donePath(id))).toBe(true);
  }, 30_000);
});

describe("mixed-runtime cancellation ordering", () => {
  test("fallback cancel and native placement cannot leave a cancelled canonical", async () => {
    const id = "snd-20260825T090000Z-dddddddddddd";
    const payload = bus.payloadPath(id);
    const archive = join(bus.home, "archive", `${id}.cancelled.md`);
    const barrierBase = join(root, "cancel-barrier");
    const release = `${barrierBase}.cancel-after-archive.release`;
    const placeStarted = join(root, "place.started");
    const index = join(root, "index");
    const lockPath = join(index, "locks", `obligation-${id}.lock`);
    mkdirSync(index);
    writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} })); // born live (F1)
    writeFileSync(registryPath, JSON.stringify({
      schema: "0.20",
      team: { name: "team", worktree_root: ctx.root },
      seats: { snd: { status: "active" } },
    }));
    writeFileSync(payload, stampEnvelope("---\n---\nquestion\n", {
      id, from: "snd", to: "rcv", kind: "discuss", path: payload, reply: "expected",
    }));

    const childEnv = {
      ...process.env,
      TAP_HOME: bus.home,
      TAP_INDEX_HOME: index,
      TAP_LOCK_DIR: undefined,
      TMUX: undefined,
      TMUX_PANE: undefined,
      TAP_SELF: undefined,
      TAP_SCRATCH_ONLY: "1",
      TAP_OBLIGATION_TEST_BARRIER: barrierBase,
      TAP_OBLIGATION_TEST_ID: id,
      TAP_OBLIGATION_TEST_STAGE: "cancel-after-archive",
    } as NodeJS.ProcessEnv;
    const cancel = Bun.spawn(["bun", MAIN, "cancel", id, "--by", "snd"], {
      cwd: ctx.root, env: childEnv, stdout: "pipe", stderr: "pipe",
    });

    const moveDeadline = Date.now() + 15_000;
    const reachedGlob = new Bun.Glob(`${basename(barrierBase)}.cancel-after-archive.*.reached`);
    while (Array.from(reachedGlob.scanSync(root)).length === 0) {
      if (existsSync(bus.cancelPath(id)) || Date.now() >= moveDeadline) {
        const code = await cancel.exited;
        const stdout = await new Response(cancel.stdout).text();
        const stderr = await new Response(cancel.stderr).text();
        throw new Error(`fallback cancel did not reach the move-before-receipt gap: rc=${code} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
      }
      Bun.sleepSync(10);
    }

    const placementEnv = {
      ...process.env,
      TAP_INDEX_HOME: index,
      TAP_LOCK_DIR: undefined,
    } as NodeJS.ProcessEnv;
    const source = `
      import { writeFileSync } from "node:fs";
      import { Bus } from ${JSON.stringify(join(import.meta.dir, "..", "src", "bus"))};
      import { canonicalPlace } from ${JSON.stringify(join(import.meta.dir, "..", "src", "courier"))};
      const bus = new Bus(${JSON.stringify(bus.home)});
      writeFileSync(${JSON.stringify(placeStarted)}, "started\\n");
      try {
        canonicalPlace(bus, "---\\n---\\nreplacement\\n", ${JSON.stringify({
          id, from: "snd", to: "rcv", kind: "discuss", path: payload, reply: "expected",
        })});
        process.exit(0);
      } catch (error) {
        process.stderr.write(String(error?.message || error) + "\\n");
        process.exit(1);
      }
    `;
    const place = Bun.spawn(["bun", "-e", source], { env: placementEnv, stdout: "pipe", stderr: "pipe" });

    const placementDeadline = Date.now() + 15_000;
    let cancelHoldsLock = false;
    while (!existsSync(payload) && !cancelHoldsLock) {
      if (Date.now() >= placementDeadline) throw new Error("native placement neither published nor blocked on the shared lock");
      if (existsSync(placeStarted)) {
        const probe = Bun.spawnSync([KERNEL_LOCK, ...kernelLockArgs(lockPath, 0, ["true"])], { stdout: "ignore", stderr: "ignore" });
        cancelHoldsLock = probe.exitCode !== 0;
      }
      Bun.sleepSync(10);
    }
    writeFileSync(release, "go\n");

    const cancelCode = await cancel.exited;
    const placeCode = await place.exited;
    await Promise.all([
      new Response(cancel.stdout).text(), new Response(cancel.stderr).text(),
      new Response(place.stdout).text(), new Response(place.stderr).text(),
    ]);

    expect(cancelCode).toBe(0);
    expect({ payload: existsSync(payload), cancelled: existsSync(bus.cancelPath(id)) })
      .toEqual({ payload: false, cancelled: true });
    expect(placeCode).not.toBe(0);
    expect(readFileSync(archive, "utf8")).toContain("question");
  }, 30_000);
});
