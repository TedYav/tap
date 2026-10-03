import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claimAcquire, claimPath } from "../src/spool-sidecar";

/**
 * tap-pu2ub.1: an interrupted `tap cancel` releases the spool claim it owns. A JavaScript `finally` does not
 * run when a termination signal's default disposition kills the process (the deleted Bash version's EXIT trap
 * did), so the orphaned `<id>.claim` refused every immediate retry until the 300 s sweep. Each arm spawns the
 * real `tap cancel`, waits at the existing scratch barrier AFTER the claim is held and eligibility passed,
 * signals only that child pid, and reads the files.
 */

const MAIN_TS = join(import.meta.dir, "..", "main.ts");
const STAGE = "cancel-after-eligibility";
const COMMITTED_STAGE = "cancel-after-archive";
const ID = "alice-20261001T000000Z-sigcl1";

type Fixture = { root: string; env: NodeJS.ProcessEnv; payload: string; claim: string; barrier: string; spoolDir: string };

function fixture(id = ID, stage = STAGE): Fixture {
  const root = mkdtempSync(join(tmpdir(), "tap-cancel-signal."));
  const bus = join(root, "bus");
  const indexDir = join(root, "index");
  const lockDir = join(root, "locks");
  for (const dir of [bus, indexDir, lockDir, join(bus, "payloads"), join(bus, "receipts")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(indexDir, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
  // The addressee `peer` is absent from the registry: provably gone, so cancel proceeds past eligibility.
  writeFileSync(join(bus, "registry.json"), `${JSON.stringify({ schema: "0.20", team: { name: "beta" }, seats: { alice: { pane: "sess:0.0", pane_id: "%401" } } }, null, 2)}\n`);
  const payload = join(bus, "payloads", `${id}.md`);
  writeFileSync(payload, `---\nid: ${id}\nfrom: alice\nto: peer\nkind: discuss\nreply: settle-only\npath: ${payload}\n---\nbody\n`);
  const barrier = join(root, "barrier");
  const spoolDir = join(bus, "spool");
  return {
    root, payload, barrier, spoolDir, claim: claimPath(spoolDir, id),
    env: {
      ...process.env,
      TAP_HOME: bus, TAP_INDEX_HOME: indexDir, TAP_LOCK_DIR: lockDir, TAP_SELF: "alice",
      TAP_SCRATCH_ONLY: "1", TAP_OBLIGATION_TEST_BARRIER: barrier, TAP_OBLIGATION_TEST_ID: id, TAP_OBLIGATION_TEST_STAGE: stage,
    } as NodeJS.ProcessEnv,
  };
}

async function waitFor(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (done()) return; await Bun.sleep(10); }
  throw new Error(`timed out waiting for ${what}`);
}

const reached = (f: Fixture, stage = STAGE) => readdirSync(f.root).some(name => name.startsWith(`barrier.${stage}.`) && name.endsWith(".reached"));
const spawnCancel = (f: Fixture, id = ID) => Bun.spawn([process.execPath, MAIN_TS, "cancel", id], { stdout: "pipe", stderr: "pipe", env: f.env });

describe("tap cancel releases its own claim on a termination signal", () => {
  for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    test(`CAUSAL: ${signal} after the claim is held releases it, exits ${status}, mutates nothing`, async () => {
      const f = fixture();
      const before = readFileSync(f.payload, "utf8");
      const child = spawnCancel(f);
      await waitFor(() => reached(f), "the cancel barrier");
      expect(existsSync(f.claim)).toBe(true);

      child.kill(signal); // the one pid this test spawned
      writeFileSync(`${f.barrier}.${STAGE}.release`, "go\n");
      expect(await child.exited).toBe(status);

      expect(existsSync(f.claim)).toBe(false);
      expect(readFileSync(f.payload, "utf8")).toBe(before);
      expect(existsSync(join(f.root, "bus", "archive", `${ID}.cancelled.md`))).toBe(false);
      expect(existsSync(join(f.root, "bus", "receipts", `${ID}.cancelled`))).toBe(false);
      // The point of the fix: an immediate retry can take the no-steal claim.
      expect(claimAcquire(f.spoolDir, ID, true).status).toBe("acquired");
    }, 30_000);
  }

  for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    test(`CAUSAL: ${signal} after the archive commits finishes the transaction, releases the claim, exits ${status}`, async () => {
      const f = fixture(ID, COMMITTED_STAGE);
      const original = readFileSync(f.payload, "utf8");
      const child = spawnCancel(f);
      await waitFor(() => reached(f, COMMITTED_STAGE), "the post-archive barrier");
      expect(existsSync(f.claim)).toBe(true);

      child.kill(signal); // the one pid this test spawned
      writeFileSync(`${f.barrier}.${COMMITTED_STAGE}.release`, "go\n");
      expect(await child.exited).toBe(status);

      // Committed work is consistent, not rolled back: archive holds the bytes, the receipt exists, the claim is ours-and-gone.
      expect(readFileSync(join(f.root, "bus", "archive", `${ID}.cancelled.md`), "utf8")).toBe(original);
      expect(existsSync(f.payload)).toBe(false);
      expect(existsSync(join(f.root, "bus", "receipts", `${ID}.cancelled`))).toBe(true);
      expect(existsSync(f.claim)).toBe(false);
    }, 30_000);
  }

  test("CONTROL: a claim now owned by another token survives the signal path", async () => {
    const f = fixture();
    const child = spawnCancel(f);
    await waitFor(() => reached(f), "the cancel barrier");
    // The holder's claim was stolen mid-flight: same path, someone else's nonce.
    const foreign = `{"v": 1, "id": "${ID}", "owner_pid": 1, "claimed_at_epoch": ${Math.floor(Date.now() / 1000)}, "nonce": "foreign-token"}\n`;
    writeFileSync(f.claim, foreign);

    child.kill("SIGTERM");
    writeFileSync(`${f.barrier}.${STAGE}.release`, "go\n");
    expect(await child.exited).toBe(143);

    expect(readFileSync(f.claim, "utf8")).toBe(foreign);
  }, 30_000);

  test("CONTROL: an unsignalled cancel still completes, releases its claim, and exits 0", async () => {
    const f = fixture();
    const child = spawnCancel(f);
    await waitFor(() => reached(f), "the cancel barrier");
    writeFileSync(`${f.barrier}.${STAGE}.release`, "go\n");
    expect(await child.exited).toBe(0);
    expect(existsSync(f.claim)).toBe(false);
    expect(existsSync(join(f.root, "bus", "receipts", `${ID}.cancelled`))).toBe(true);
  }, 30_000);
});
