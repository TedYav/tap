import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { decodeCourierIntent, decodeQueuedSpoolReceipt, encodeCourierIntent } from "../src/courier-contract";
import { acquireObligationLock, acquirePathLock } from "../src/panelock";
import { dispositionAtDeadline, park, listLiveIntents, type ParkInput } from "../src/spool";
import { route } from "../main";
import { writeLiveFence } from "./support/live-fence";

/**
 * U3.1 direct arms. park() is a storage function on the sender bus: it
 * validates the binding (R16), mints the deadline disposition (R13), and
 * writes exactly one closed-set intent (KTD2). Delivery, receipts-for-delivery,
 * verbs, and the owner are later units; every arm here asserts files or
 * returned shapes, never an owner behavior.
 */

function makeBus(): { root: string; payloadsDir: string; spoolDir: string; registryDir: string } {
  const root = mkdtempSync(join(tmpdir(), "tap-spool-u3."));
  const payloadsDir = join(root, "payloads");
  const spoolDir = join(root, "spool");
  const registryDir = join(root, "registry");
  mkdirSync(payloadsDir);
  mkdirSync(spoolDir);
  mkdirSync(registryDir);
  return { root, payloadsDir, spoolDir, registryDir };
}

function makeRegistry(dir: string, teamName: string, withPane: boolean): string {
  const registry = join(dir, "team-registry.json");
  const row = withPane
    ? { pane: "sess:0.0", pane_id: "%401", harness: "codex", status: "active" }
    : { harness: "codex", status: "active" };
  writeFileSync(
    registry,
    `${JSON.stringify({ schema: "0.20", team: { name: teamName }, seats: { peer: row } }, null, 2)}\n`,
  );
  return registry;
}

function parkInput(overrides: Partial<ParkInput> = {}): ParkInput & { payloadsDir: string; spoolDir: string } {
  const { payloadsDir, spoolDir, registryDir } = makeBus();
  const registry = makeRegistry(registryDir, "beta", true);
  const lockDir = mkdtempSync(join(tmpdir(), "tap-spool-u3-park-locks."));
  return {
    spoolDir,
    payloadsDir,
    id: "seat-20260830T000000Z-aaaaaa",
    from: "alice",
    to: "peer",
    toTeam: "beta",
    targetRegistry: registry,
    pane: "sess:0.0",
    paneId: "%401",
    serverEpoch: "srv:4242:100",
    harness: "codex",
    policy: "standard",
    reason: "busy",
    kind: "discuss",
    firstParkEpoch: 1788000000,
    holdUntilEpoch: null,
    deadlineEpoch: 1788000300,
    env: { ...process.env, TAP_LOCK_DIR: lockDir },
    ...overrides,
  };
}

describe("spool park (U3.1)", () => {
  test("R16 queue-side: an empty stamped pane refuses unbound_target with zero files and never reads the registry", () => {
    const input = parkInput({ pane: "" });
    const result = park(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_class).toBe("unbound_target");
      expect(result.detail).toContain("pane");
    }
    expect(readdirSync(input.spoolDir).filter((n) => n.endsWith(".json"))).toHaveLength(0);
  });

  test("R16 queue-side: an empty stamped pane_id refuses unbound_target", () => {
    const input = parkInput({ paneId: "" });
    const result = park(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_class).toBe("unbound_target");
    expect(existsSync(join(input.spoolDir, `${input.id}.json`))).toBe(false);
  });

  test("R16 queue-side: an empty stamped to_team refuses unbound_target", () => {
    const input = parkInput({ toTeam: "" });
    const result = park(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_class).toBe("unbound_target");
    expect(existsSync(join(input.spoolDir, `${input.id}.json`))).toBe(false);
  });

  test("R16 queue-side: a stamped-complete park does not re-read the registry (mismatch still parks)", () => {
    const input = parkInput({ pane: "sess:9.9", paneId: "%999" });
    writeFileSync(
      input.targetRegistry,
      `${JSON.stringify({ schema: "0.20", team: { name: "alpha" }, seats: { peer: { pane: "sess:0.0", pane_id: "%401" } } })}\n`,
    );
    const result = park(input);
    expect(result.ok).toBe(true);
    expect(existsSync(join(input.spoolDir, `${input.id}.json`))).toBe(true);
  });

  test("park holds the per-id obligation lock: a holder blocks publication; release lets exactly one intent land", () => {
    const input = parkInput({ lockTimeoutMs: 0 });
    const held = acquireObligationLock(input.id, 200, input.env);
    expect(held).not.toBeNull();
    const blocked = park(input);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error_class).toBe("obligation_busy");
    expect(existsSync(join(input.spoolDir, `${input.id}.json`))).toBe(false);
    held!.release();
    const won = park({ ...input, lockTimeoutMs: 5000 });
    expect(won.ok).toBe(true);
    expect(readdirSync(input.spoolDir).filter((n) => n.endsWith(".json"))).toEqual([`${input.id}.json`]);
  });

  test("park writes one closed-set intent and a contract-valid receipt, touching nothing else", () => {
    const input = parkInput({ reason: "copy-mode", policy: "standard" });
    writeFileSync(join(input.payloadsDir, `${input.id}.md`), "canonical body\n");
    const result = park(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The intent is the ONLY file the park wrote, and it decodes to exactly
    // the closed field set with the minted disposition.
    const intentFiles = readdirSync(input.spoolDir).filter((n) => n.endsWith(".json"));
    expect(intentFiles).toEqual([`${input.id}.json`]);
    const intentText = readFileSync(join(input.spoolDir, `${input.id}.json`), "utf8");
    const intent = decodeCourierIntent(intentText);
    // Exact codec bytes: the file IS the authority output, not a JSON twin —
    // permissive parsing cannot hide a whitespace or newline drift.
    expect(intentText).toBe(encodeCourierIntent(intent));
    expect(intent.id).toBe(input.id);
    expect(intent.to_team).toBe("beta");
    expect(intent.disposition_at_deadline).toBe("notify-and-hold");
    expect(intent.busy_pending_probes).toBe(0);
    expect(intent.escalated_at).toBeNull();
    expect(intent.excluded).toBe(false);
    // The receipt passes the cross-lane codec, names the canonical and the
    // intent, and claims nothing about delivery (R11: queued, unconfirmed).
    const receipt = decodeQueuedSpoolReceipt(JSON.stringify(result.receipt));
    expect(receipt.status).toBe("queued");
    expect(receipt.delivery).toBe("spool");
    expect(receipt.turn).toBe("unconfirmed");
    expect(receipt.path).toBe(join(input.payloadsDir, `${input.id}.md`));
    expect(receipt.meta).toBe(join(input.spoolDir, `${input.id}.json`));
    expect(receipt.deadline_epoch).toBe(1788000300);
    expect(receipt.spool_backlog).toBe(1);
    expect(receipt.spool_backlog_condition).toBe(false);
    // KTD2/R8: the canonical stays; park wrote no placement or delivery marker.
    expect(existsSync(join(input.payloadsDir, `${input.id}.md`))).toBe(true);
    expect(existsSync(join(input.payloadsDir, "..", "receipts"))).toBe(false);
  });

  test("R13: the disposition table mints each class at park time and never guesses", () => {
    expect(dispositionAtDeadline("standard", "copy-mode")).toBe("notify-and-hold");
    expect(dispositionAtDeadline("standard", "pending-input")).toBe("deliver-anyway");
    expect(dispositionAtDeadline("standard", "clearing-fence")).toBe("deliver-anyway");
    expect(dispositionAtDeadline("autosettle", "auto-settle")).toBe("notify-and-cancel");
    expect(dispositionAtDeadline("standard", "busy")).toBe("notify-and-cancel");
    expect(dispositionAtDeadline("standard", "no-prompt")).toBe("notify-and-cancel");
    // The polite timeout is a policy deadline, whatever the reason string.
    expect(dispositionAtDeadline("polite", "copy-mode")).toBe("deliver-anyway");
    // An unclassified reason fails toward notification, never silent delivery.
    expect(dispositionAtDeadline("standard", "never-heard-of-it")).toBe("notify-and-cancel");
  });

  test("re-park of a live id refuses spooled_id and preserves the first intent", () => {
    const input = parkInput();
    const first = park(input);
    expect(first.ok).toBe(true);
    const again = park(input);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error_class).toBe("spooled_id");
    const intentFiles = readdirSync(input.spoolDir).filter((n) => n.endsWith(".json"));
    expect(intentFiles).toEqual([`${input.id}.json`]);
  });

  test("U3.4: park's queued spool_backlog uses the SAME unsettled denominator as list/status (durable .cancelled)", () => {
    const bus = verbBus();
    parkedVerbIntent(bus, "seat-20260831T000000Z-wwwwww", "alice");
    parkedVerbIntent(bus, "seat-20260831T000000Z-xxxxxx", "alice");
    // The crash-window shape: the receipt is durable, the intent removal
    // never happened. The RAW live count sees 2; the unsettled count sees 1.
    writeFileSync(join(bus.receiptsDir, "seat-20260831T000000Z-xxxxxx.cancelled"), "{}\n");
    const registry = makeRegistry(bus.registryDir, "beta", true);
    const third = parkInput({ id: "seat-20260831T000000Z-yyyyyy", spoolDir: bus.spoolDir, payloadsDir: bus.payloadsDir, targetRegistry: registry });
    const result = park(third);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const status = runSpool(["status", "--json"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir });
    expect(status.rc).toBe(0);
    const statusRow = JSON.parse(status.out.trim()) as { intents: number };
    expect(statusRow.intents).toBe(2); // third + the one uncancelled live intent
    expect(result.receipt.spool_backlog).toBe(statusRow.intents);
  });

  test("U3.4: the same equality under a durable .done", () => {
    const bus = verbBus();
    parkedVerbIntent(bus, "seat-20260831T000000Z-wwwwww", "alice");
    parkedVerbIntent(bus, "seat-20260831T000000Z-xxxxxx", "alice");
    writeFileSync(join(bus.receiptsDir, "seat-20260831T000000Z-xxxxxx.done"), "{}\n");
    const registry = makeRegistry(bus.registryDir, "beta", true);
    const third = parkInput({ id: "seat-20260831T000000Z-yyyyyy", spoolDir: bus.spoolDir, payloadsDir: bus.payloadsDir, targetRegistry: registry });
    const result = park(third);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const status = runSpool(["status", "--json"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir });
    const statusRow = JSON.parse(status.out.trim()) as { intents: number };
    expect(statusRow.intents).toBe(2);
    expect(result.receipt.spool_backlog).toBe(statusRow.intents);
  });

  test("spool_backlog counts live intents after this park, excluding every diagnostic record", () => {
    const input = parkInput();
    const other = parkInput({ ...input, id: "seat-20260830T000000Z-bbbbbb", spoolDir: input.spoolDir, payloadsDir: input.payloadsDir });
    expect(park(other).ok).toBe(true);
    const second = parkInput({ ...input, id: "seat-20260830T000000Z-cccccc", spoolDir: input.spoolDir, payloadsDir: input.payloadsDir });
    // The diagnostics a real spool dir accumulates: the U6 owner's pid record
    // and an incumbent legacy `<id>.meta.json` park record (lib.sh:1132/1634)
    // — neither decodes as a closed-set intent, so neither is live mail. A
    // valid intent filed under the WRONG slot is not that slot's mail either.
    writeFileSync(join(input.spoolDir, "owner.json"), `${JSON.stringify({ pid: 4242 })}\n`);
    writeFileSync(join(input.spoolDir, "legacy.meta.json"), `${JSON.stringify({ id: "legacy", reason: "busy", policy: "standard" })}\n`);
    const misplaced = parkInput({ ...input, id: "seat-20260830T000000Z-dddddd" });
    expect(park(misplaced).ok).toBe(true);
    renameSync(
      join(misplaced.spoolDir, "seat-20260830T000000Z-dddddd.json"),
      join(input.spoolDir, "not-the-slot.json"),
    );
    const result = park(second);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.receipt.spool_backlog).toBe(2);
  });
});

/**
 * U3.2 verb arms — SUBPROCESS fixtures (pre-freeze anchor 5): every verb
 * observation drives the production `main.ts` entry in a spawned bun process,
 * so the CLI parser, renderer, and TapError paths exercised are the real
 * ones. No stdout/stderr monkeypatching in the shared test process. The bus
 * resolves through TAP_HOME (env rule); the cwd-context negative runs with
 * TAP_HOME unset from a bare directory.
 */

const MAIN_TS = join(import.meta.dir, "..", "main.ts");

/** A born-live machine index (F1) with no enrolled team. */
function liveIndex(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
  return dir;
}

function verbBus(): { root: string; payloadsDir: string; spoolDir: string; receiptsDir: string; registryDir: string; indexDir: string; lockDir: string } {
  const { root, payloadsDir, spoolDir, registryDir } = makeBus();
  mkdirSync(join(root, "receipts"));
  // An ISOLATED born-live machine index with no enrolled team: the unenrolled
  // TAP_HOME bus is its own registry.json authority, so fixture seats resolve
  // deterministically no matter what the host machine's live index says.
  const indexDir = liveIndex("tap-spool-u3-index.");
  const lockDir = mkdtempSync(join(tmpdir(), "tap-spool-u3-locks."));
  return { root, payloadsDir, spoolDir, receiptsDir: join(root, "receipts"), registryDir, indexDir, lockDir };
}

function parkedVerbIntent(bus: ReturnType<typeof verbBus>, id: string, from: string): void {
  const shared = makeRegistry(bus.registryDir, "beta", true);
  const input = parkInput({
    id,
    from,
    spoolDir: bus.spoolDir,
    payloadsDir: bus.payloadsDir,
    targetRegistry: shared,
    env: { ...process.env, TAP_LOCK_DIR: bus.lockDir },
  });
  const result = park(input);
  if (!result.ok) throw new Error(`fixture park failed for ${id}: ${result.detail}`);
}

/** A minimal canonical envelope; eligibility reads `from`/`sender_instance`. */
function writeCanonical(bus: ReturnType<typeof verbBus>, id: string, fields: { from: string; sender_instance?: string; envelopeId?: string; to?: string; to_team?: string }): void {
  const path = join(bus.payloadsDir, `${id}.md`);
  const instance = fields.sender_instance ? `sender_instance: ${fields.sender_instance}\n` : "";
  const envelopeId = fields.envelopeId ?? id;
  const to = fields.to ?? "peer";
  const team = fields.to_team ? `to_team: ${fields.to_team}\n` : "";
  writeFileSync(path, `---\nid: ${envelopeId}\nfrom: ${fields.from}\nto: ${to}\nkind: discuss\nreply: settle-only\npath: ${path}\n${team}${instance}---\nbody\n`);
}

/** Names+bytes of every file under a dir tree, for zero-mutation controls. */
function snapshotTree(root: string): Map<string, string> {
  const snap = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else snap.set(full.slice(root.length), readFileSync(full, "utf8"));
    }
  };
  walk(root);
  return snap;
}

/**
 * Fail setup LOUDLY when a permission fixture would not actually bind: the
 * probe is a fixed write+remove of `.preflight-probe` inside the target dir —
 * the same operations the fixture is about to depend on failing.
 */
function preflightUnwritable(dir: string, label: string): void {
  const probePath = join(dir, ".preflight-probe");
  try {
    writeFileSync(probePath, "x");
    rmSync(probePath);
  } catch {
    return; // the operation genuinely fails — the fixture binds
  }
  throw new Error(`C5 preflight: '${label}' still permitted on this host; refusing a false green`);
}

/** A registry whose `alice` seat carries the given CURRENT instance stamp. */
function writeInstanceRegistry(bus: ReturnType<typeof verbBus>, instance: string | null): void {
  const row = instance ? { pane: "sess:0.0", pane_id: "%401", instance } : { pane: "sess:0.0", pane_id: "%401" };
  writeFileSync(
    join(bus.root, "registry.json"),
    `${JSON.stringify({ schema: "0.20", team: { name: "beta" }, seats: { alice: row } }, null, 2)}\n`,
  );
}

function runSpool(
  argv: string[],
  env: Record<string, string | undefined>,
): { rc: number | null; out: string; err: string } {
  const child = spawnSync(process.execPath, [MAIN_TS, "spool", ...argv], {
    encoding: "utf8",
    env: { ...process.env, TAP_INDEX_HOME: undefined, TAP_LOCK_DIR: undefined, ...env } as NodeJS.ProcessEnv,
  });
  return { rc: child.status, out: child.stdout ?? "", err: child.stderr ?? "" };
}

/**
 * A provably nonexistent pid, portable without a platform probe: candidates
 * beyond every common allocation maximum, taking the first whose signal-0
 * probe returns ESRCH — the kernel's own word for "no such process". EINVAL
 * candidates are skipped deliberately: production owner-liveness semantics
 * stay byte-identical (EPERM alive / ESRCH dead / else unobservable), so the
 * control must prove death through the same door production reads. A pid
 * outside the allocatable range cannot become live, so the choice is stable
 * for the assertion's lifetime. No deterministic ESRCH candidate is a loud
 * setup failure, never a skipped arm.
 */
function deterministicNonexistentPid(): number {
  for (const candidate of [10_000_000, 1_000_000, 100_000]) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return candidate;
    }
  }
  throw new Error("no deterministic ESRCH pid candidate found on this host");
}

describe("tap spool verbs (U3.2, dark, subprocess)", () => {
  test("list emits one JSON row per unsettled live intent, excluding settled/cancelled, honoring --from", () => {
    const bus = verbBus();
    parkedVerbIntent(bus, "seat-20260830T000000Z-aaaaaa", "alice");
    parkedVerbIntent(bus, "seat-20260830T000000Z-bbbbbb", "bob");
    parkedVerbIntent(bus, "seat-20260830T000000Z-cccccc", "alice");
    writeFileSync(join(bus.receiptsDir, "seat-20260830T000000Z-cccccc.done"), "{}\n");
    writeFileSync(join(bus.receiptsDir, "seat-20260830T000000Z-bbbbbb.cancelled"), "{}\n");
    const result = runSpool(["list", "--json"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir });
    expect(result.rc).toBe(0);
    const rows = result.out.trim().split("\n").map((line) => JSON.parse(line) as { id: string; from: string });
    expect(rows.map((r) => r.id)).toEqual(["seat-20260830T000000Z-aaaaaa"]);
    const filtered = runSpool(["list", "--json", "--from", "bob"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir });
    expect(filtered.rc).toBe(0);
    expect(filtered.out.trim()).toBe(""); // bob's only intent is cancelled
  });

  test("the shared denominator: a durable .cancelled with the intent still present reports zero everywhere", () => {
    const bus = verbBus();
    const id = "seat-20260830T000000Z-aaaaaa";
    parkedVerbIntent(bus, id, "alice");
    // The crash window: receipt written, intent removal did NOT happen.
    writeFileSync(join(bus.receiptsDir, `${id}.cancelled`), "{}\n");
    const list = runSpool(["list", "--json"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir });
    expect(list.rc).toBe(0);
    expect(list.out.trim()).toBe("");
    const status = runSpool(["status", "--json"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir });
    expect(status.rc).toBe(0);
    expect((JSON.parse(status.out.trim()) as { intents: number }).intents).toBe(0);
  });

  test("status reports the owner diagnostically, never touching owner.lock, with an available inspection action", () => {
    const bus = verbBus();
    parkedVerbIntent(bus, "seat-20260830T000000Z-aaaaaa", "alice");
    const dark = runSpool(["status", "--json"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir });
    expect(dark.rc).toBe(0);
    const darkRow = JSON.parse(dark.out.trim()) as { intents: number; owner_alive: boolean | null; owner_note: string };
    expect(darkRow.intents).toBe(1);
    expect(darkRow.owner_alive).toBeNull();
    expect(darkRow.owner_note).toContain("no record");
    writeFileSync(join(bus.spoolDir, "owner.json"), `${JSON.stringify({ pid: process.pid })}\n`);
    const live = runSpool(["status", "--json"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir });
    expect((JSON.parse(live.out.trim()) as { owner_alive: boolean | null }).owner_alive).toBe(true);
    // A dead owner, deterministically: a pid past the platform's allocatable
    // maximum cannot be a live process — no temporal child-exit/reuse window.
    const deadPid = deterministicNonexistentPid();
    writeFileSync(join(bus.spoolDir, "owner.json"), `${JSON.stringify({ pid: deadPid })}\n`);
    const dead = runSpool(["status", "--json"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir });
    const deadRow = JSON.parse(dead.out.trim()) as { owner_alive: boolean | null; owner_note: string };
    expect(deadRow.owner_alive).toBe(false);
    expect(deadRow.owner_note).toContain("owner: DEAD");
    expect(deadRow.owner_note).toContain("inspect queued payloads with tap spool list --json");
    expect(deadRow.owner_note).toContain("no public owner restart command is available");
    expect(deadRow.owner_note).not.toContain("tap spool kick");
    const inspect = runSpool(["list", "--json"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir });
    expect(inspect.rc).toBe(0);
    expect(JSON.parse(inspect.out.trim()).id).toBe("seat-20260830T000000Z-aaaaaa");
    expect(existsSync(join(bus.spoolDir, "owner.lock"))).toBe(false);
  });

  test("cancel: the sender withdraws — receipt provenance, no .done, intent dropped, list empty", () => {
    const bus = verbBus();
    const id = "seat-20260830T000000Z-aaaaaa";
    parkedVerbIntent(bus, id, "alice");
    writeCanonical(bus, id, { from: "alice", to_team: "beta" });
    writeInstanceRegistry(bus, null);
    const result = runSpool(["cancel", id], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir, TAP_SELF: "alice" });
    expect(result.rc).toBe(0);
    const receipt = JSON.parse(readFileSync(join(bus.receiptsDir, `${id}.cancelled`), "utf8")) as {
      id: string; status: string; via: string; source: string; by: string; reason: string; target: string; to_team: string;
    };
    expect(receipt.id).toBe(id);
    expect(receipt.status).toBe("cancelled");
    expect(receipt.via).toBe("cancelled");
    expect(receipt.by).toBe("alice");
    expect(receipt.reason).toBe("spooled_withdrawn");
    expect(receipt.source).toBe("spool");
    expect(receipt.target).toBe("peer");
    expect(receipt.to_team).toBe("beta");
    expect(existsSync(join(bus.receiptsDir, `${id}.done`))).toBe(false);
    expect(existsSync(join(bus.spoolDir, `${id}.json`))).toBe(false);
    expect(runSpool(["list", "--json"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir }).out.trim()).toBe("");
    // Retrying a completed withdrawal is already_cancelled; a settled id is
    // already_settled; an unknown id is not_found — three distinct refusals.
    expect(runSpool(["cancel", id], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir, TAP_SELF: "alice" }).err).toContain("already cancelled");
    parkedVerbIntent(bus, "seat-20260830T000000Z-bbbbbb", "alice");
    writeCanonical(bus, "seat-20260830T000000Z-bbbbbb", { from: "alice" });
    writeFileSync(join(bus.receiptsDir, "seat-20260830T000000Z-bbbbbb.done"), "{}\n");
    expect(runSpool(["cancel", "seat-20260830T000000Z-bbbbbb"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir, TAP_SELF: "alice" }).err).toContain("already settled");
    expect(runSpool(["cancel", "seat-20260830T000000Z-neverar"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir, TAP_SELF: "alice" }).err).toContain("no live spool intent");
  });

  test("cancel --json: exit 0, one parseable receipt object, durable .cancelled, intent gone", () => {
    const bus = verbBus();
    const id = "seat-20260830T000000Z-json01";
    parkedVerbIntent(bus, id, "alice");
    writeCanonical(bus, id, { from: "alice", to_team: "beta" });
    writeInstanceRegistry(bus, null);
    const result = runSpool(["cancel", id, "--json"], {
      TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir, TAP_SELF: "alice",
    });
    expect(result.rc).toBe(0);
    const lines = result.out.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const obj = JSON.parse(lines[0]!) as {
      id: string; status: string; via: string; source: string; by: string; reason: string; target: string; to_team: string; at: string; v: number;
    };
    expect(obj.id).toBe(id);
    expect(obj.status).toBe("cancelled");
    expect(obj.via).toBe("cancelled");
    expect(obj.source).toBe("spool");
    expect(obj.by).toBe("alice");
    expect(obj.reason).toBe("spooled_withdrawn");
    expect(obj.target).toBe("peer");
    expect(obj.to_team).toBe("beta");
    const onDisk = JSON.parse(readFileSync(join(bus.receiptsDir, `${id}.cancelled`), "utf8"));
    expect(obj).toEqual(onDisk);
    expect(existsSync(join(bus.spoolDir, `${id}.json`))).toBe(false);
    expect(existsSync(join(bus.receiptsDir, `${id}.done`))).toBe(false);
  });

  test("cancel refuses impersonation and enforces the exact sender-instance generation gate", () => {
    const bus = verbBus();
    const id = "seat-20260830T000000Z-aaaaaa";
    parkedVerbIntent(bus, id, "alice");
    writeCanonical(bus, id, { from: "alice", sender_instance: "alice|gen1" });
    // A different actor is not the sender, whatever the intent says.
    expect(runSpool(["cancel", id], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir, TAP_SELF: "bob" }).err).toContain("is not the sender");
    // A fresh seat at the SAME handle is a different instance: the registry's
    // current instance (gen2) does not equal the stamped binding (gen1).
    writeInstanceRegistry(bus, "alice|gen2");
    expect(runSpool(["cancel", id], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir, TAP_SELF: "alice" }).err).toContain("predecessor-bound");
    // The matching current instance authorizes.
    writeInstanceRegistry(bus, "alice|gen1");
    const ok = runSpool(["cancel", id], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir, TAP_SELF: "alice" });
    expect(ok.rc).toBe(0);
    // An unresolvable current instance (no registry) is an unverified seat.
    parkedVerbIntent(bus, "seat-20260830T000000Z-cccccc", "alice");
    writeCanonical(bus, "seat-20260830T000000Z-cccccc", { from: "alice", sender_instance: "alice|gen1" });
    rmSync(join(bus.root, "registry.json"));
    expect(runSpool(["cancel", "seat-20260830T000000Z-cccccc"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir, TAP_SELF: "alice" }).err).toContain("unverified seat");
  });

  test("unanchored cwd context refuses; unknown subcommands and options refuse loudly", () => {
    // Isolated bare directory, TAP_HOME unset: the cwd-derived bus has no
    // acting registry, and the verb refuses rather than touching anything.
    const nowhere = mkdtempSync(join(tmpdir(), "tap-spool-cwd."));
    const child = spawnSync(process.execPath, [MAIN_TS, "spool", "list", "--json"], {
      encoding: "utf8",
      cwd: nowhere,
      env: { ...process.env, TAP_HOME: undefined } as NodeJS.ProcessEnv,
    });
    expect(child.status).not.toBe(0);
    const bus = verbBus();
    expect(runSpool(["deliver"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir }).err).toContain("usage: tap spool list");
    expect(runSpool(["list", "--wake"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir }).err).toContain("unknown option");
  });

  test("anchor-1 discriminator: a cwd-derived bus WITH an acting registry serves list/status", () => {
    // The permanent pin the leader asked for: this arm is the one that fails
    // if the verb ever regresses to env-buses-only. A fully isolated root
    // (not a git worktree — repoRoot falls back to the cwd itself), its bus
    // carrying an acting registry, TAP_HOME unset: production list/status
    // succeed through the normal current-team path.
    const root = mkdtempSync(join(tmpdir(), "tap-spool-cwd-bus."));
    const busHome = join(root, ".tap", "bus");
    mkdirSync(join(busHome, "payloads"), { recursive: true });
    mkdirSync(join(busHome, "spool"), { recursive: true });
    mkdirSync(join(busHome, "receipts"), { recursive: true });
    const lockDir = mkdtempSync(join(tmpdir(), "tap-spool-cwd-locks."));
    const indexDir = liveIndex("tap-spool-cwd-index.");
    writeFileSync(join(busHome, "registry.json"), `${JSON.stringify({ schema: "0.20", team: { name: "beta" }, seats: {} }, null, 2)}\n`);
    const listChild = spawnSync(process.execPath, [MAIN_TS, "spool", "list", "--json"], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, TAP_HOME: undefined, TAP_INDEX_HOME: indexDir, TAP_LOCK_DIR: lockDir } as NodeJS.ProcessEnv,
    });
    expect(listChild.status).toBe(0);
    expect((listChild.stdout ?? "").trim()).toBe(""); // empty bus lists nothing, successfully
    const statusChild = spawnSync(process.execPath, [MAIN_TS, "spool", "status", "--json"], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, TAP_HOME: undefined, TAP_INDEX_HOME: indexDir, TAP_LOCK_DIR: lockDir } as NodeJS.ProcessEnv,
    });
    expect(statusChild.status).toBe(0);
    expect(statusChild.stdout ?? "").toContain("owner_alive");
  });

  test("cancel pre-effect validation: unknown options and malformed ids refuse before any lock artifact", () => {
    const bus = verbBus();
    const id = "seat-20260830T000000Z-aaaaaa";
    parkedVerbIntent(bus, id, "alice");
    writeCanonical(bus, id, { from: "alice" });
    writeInstanceRegistry(bus, null);
    const beforeLocks = readdirSync(bus.lockDir).sort();
    const badOption = runSpool(["cancel", id, "--wake"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir, TAP_SELF: "alice" });
    expect(badOption.rc).not.toBe(0);
    expect(badOption.err).toContain("unknown option");
    const badId = runSpool(["cancel", "../../escape"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir, TAP_SELF: "alice" });
    expect(badId.rc).not.toBe(0);
    expect(badId.err).toContain("not a valid payload id");
    // Pre-effect refusals must not mint a new lock artifact or touch the intent.
    // park() already left a lockf path (existence is not a hold); the set must not grow.
    expect(readdirSync(bus.lockDir).sort()).toEqual(beforeLocks);
    expect(existsSync(join(bus.spoolDir, `${id}.json`))).toBe(true);
    expect(existsSync(join(bus.receiptsDir, `${id}.cancelled`))).toBe(false);
  });

  test("cancel authority requires a valid envelope whose id IS the requested id", () => {
    const bus = verbBus();
    const id = "seat-20260830T000000Z-aaaaaa";
    parkedVerbIntent(bus, id, "alice");
    writeInstanceRegistry(bus, null);
    // A canonical minted for a DIFFERENT id cannot authorize this withdrawal.
    writeCanonical(bus, id, { from: "alice", envelopeId: "seat-20269999T999999Z-zzzzzz" });
    const mismatch = runSpool(["cancel", id], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir, TAP_SELF: "alice" });
    expect(mismatch.rc).not.toBe(0);
    expect(mismatch.err).toContain("not 'seat-20260830T000000Z-aaaaaa'");
    expect(existsSync(join(bus.receiptsDir, `${id}.cancelled`))).toBe(false);
    expect(existsSync(join(bus.spoolDir, `${id}.json`))).toBe(true);
    // A malformed envelope is not authority either.
    writeFileSync(join(bus.payloadsDir, `${id}.md`), "---\nid: seat-20260830T000000Z-aaaaaa\nnot-an-envelope\n");
    const malformed = runSpool(["cancel", id], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir, TAP_SELF: "alice" });
    expect(malformed.rc).not.toBe(0);
    expect(malformed.err).toContain("invalid envelope");
    expect(existsSync(join(bus.receiptsDir, `${id}.cancelled`))).toBe(false);
    expect(existsSync(join(bus.spoolDir, `${id}.json`))).toBe(true);
  });

  test("listLiveIntents orders oldest-park-first for reader-visible output", () => {
    const bus = verbBus();
    parkedVerbIntent(bus, "seat-20260830T000000Z-zzzzzz", "alice");
    const shared = makeRegistry(bus.registryDir, "beta", true);
    const early = parkInput({ id: "seat-20260830T000000Z-aaaaaa", firstParkEpoch: 1787000000, spoolDir: bus.spoolDir, payloadsDir: bus.payloadsDir, targetRegistry: shared });
    expect(park(early).ok).toBe(true);
    const rows = listLiveIntents(bus.spoolDir);
    expect(rows[0]!.id).toBe("seat-20260830T000000Z-aaaaaa");
  });
});

/**
 * U3.3 controls (frozen brief v3). C1 park refusal; C2 quarantine happy path
 * with the event line; C3 the diagnostic zoo under the canonical-correlation
 * reporter; C4 authorization holds; C5 partial-failure dispositions with
 * loud preflights. Every verb observation drives production main.ts in a
 * subprocess; the reporter controls pin names+bytes and an empty lock dir.
 */

describe("U3.3 quarantine half", () => {
  const RAW = "seat-20260831T000000Z-aaaaaa";
  const MALFORMED_BYTES = "{ this is not an intent\\n";

  test("REGRESSION (fix round item 1): a same-team canonical omitting to_team never erases the live intent's receipt provenance", () => {
    const bus = verbBus();
    const id = "seat-20260831T000000Z-zzzzzz";
    parkedVerbIntent(bus, id, "alice");           // intent carries to_team: beta
    writeCanonical(bus, id, { from: "alice" });    // canonical omits to_team (legal same-team shape)
    writeInstanceRegistry(bus, null);
    const result = runSpool(["cancel", id], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir, TAP_SELF: "alice" });
    expect(result.rc).toBe(0);
    const receipt = JSON.parse(readFileSync(join(bus.receiptsDir, `${id}.cancelled`), "utf8")) as { target: string; to_team: string };
    expect(receipt.target).toBe("peer");
    expect(receipt.to_team).toBe("beta");          // the INTENT's team, not the canonical's omission
  });

  test("C1: park refuses a malformed exact slot with the distinct class and never mutates it; a live slot stays spooled_id", () => {
    const input = parkInput();
    writeFileSync(join(input.spoolDir, `${input.id}.json`), MALFORMED_BYTES);
    const result = park(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_class).toBe("malformed_intent");
    expect(readFileSync(join(input.spoolDir, `${input.id}.json`), "utf8")).toBe(MALFORMED_BYTES);
    const live = parkInput({ ...input, id: "seat-20260831T000000Z-bbbbbb", spoolDir: input.spoolDir, payloadsDir: input.payloadsDir });
    expect(park(live).ok).toBe(true);
    const again = park(live);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error_class).toBe("spooled_id");
  });

  test("C2: cancel quarantines a malformed slot byte-preserving, writes the malformed receipt, one event line; destination evidence is never overwritten", () => {
    const bus = verbBus();
    writeFileSync(join(bus.spoolDir, `${RAW}.json`), MALFORMED_BYTES);
    writeCanonical(bus, RAW, { from: "alice", to_team: "beta" });
    writeInstanceRegistry(bus, null);
    const ok = runSpool(["cancel", RAW], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir, TAP_SELF: "alice" });
    expect(ok.rc).toBe(0);
    expect(readFileSync(join(bus.spoolDir, `${RAW}.json.malformed`), "utf8")).toBe(MALFORMED_BYTES);
    expect(existsSync(join(bus.spoolDir, `${RAW}.json`))).toBe(false);
    const receipt = JSON.parse(readFileSync(join(bus.receiptsDir, `${RAW}.cancelled`), "utf8")) as {
      id: string; status: string; via: string; source: string; reason: string; target: string; to_team: string;
    };
    expect(receipt.reason).toBe("malformed");
    expect(receipt.target).toBe("peer");       // canonical-derived
    expect(receipt.to_team).toBe("beta");      // canonical-derived
    expect(receipt.source).toBe("spool");
    expect(existsSync(join(bus.receiptsDir, `${RAW}.done`))).toBe(false);
    const events = readFileSync(join(bus.root, "registry-events.log"), "utf8").trim().split("\n").filter(Boolean);
    expect(events).toHaveLength(1);
    const fields = new Map(events[0]!.split(" ").map((token) => [token.split("=", 1)[0], token.slice(token.indexOf("=") + 1)]));
    expect(fields.get("actor")).toBe("alice");
    expect(fields.get("action")).toBe("spool_quarantined_malformed");
    expect(fields.get("handle")).toBe(RAW);
    expect(fields.get("pane")).toBe("-");
    // Destination-exists: evidence preserved on both sides, refusal before mutation.
    const bus2 = verbBus();
    const KEEP = "seat-20260831T000000Z-ccccc";
    writeFileSync(join(bus2.spoolDir, `${KEEP}.json`), MALFORMED_BYTES);
    writeFileSync(join(bus2.spoolDir, `${KEEP}.json.malformed`), "prior evidence\\n");
    writeCanonical(bus2, KEEP, { from: "alice" });
    writeInstanceRegistry(bus2, null);
    const refuse = runSpool(["cancel", KEEP], { TAP_HOME: bus2.root, TAP_INDEX_HOME: bus2.indexDir, TAP_LOCK_DIR: bus2.lockDir, TAP_SELF: "alice" });
    expect(refuse.rc).not.toBe(0);
    expect(refuse.err).toContain("never overwritten");
    expect(readFileSync(join(bus2.spoolDir, `${KEEP}.json.malformed`), "utf8")).toBe("prior evidence\\n");
    expect(readFileSync(join(bus2.spoolDir, `${KEEP}.json`), "utf8")).toBe(MALFORMED_BYTES);
    expect(existsSync(join(bus2.receiptsDir, `${KEEP}.cancelled`))).toBe(false);
  });

  test("C3: the diagnostic zoo reports exactly two rows locklessly; neither class enters live/backlog enumeration", () => {
    const bus = verbBus();
    // The zoo: incumbent diagnostics with no matching canonical.
    writeFileSync(join(bus.spoolDir, "owner.json"), `${JSON.stringify({ pid: 4242 })}\n`);
    writeFileSync(join(bus.spoolDir, "legacy.meta.json"), `${JSON.stringify({ id: "legacy", reason: "busy" })}\n`);
    writeFileSync(join(bus.spoolDir, "random-diagnostic.json"), `${JSON.stringify({ note: "not mail" })}\n`);
    // One canonical-backed raw malformed slot with a LEGAL `.meta`-ending id.
    const metaId = "keeper.meta.20260831T000000Z-dddddd";
    writeFileSync(join(bus.spoolDir, `${metaId}.json`), MALFORMED_BYTES);
    writeCanonical(bus, metaId, { from: "alice" });
    // One pre-planted quarantine suffix.
    const quarantined = "seat-20260831T000000Z-eeeeee";
    writeFileSync(join(bus.spoolDir, `${quarantined}.json.malformed`), MALFORMED_BYTES);
    // Warm-up: the first verb touch writes the bus-authority marker
    // (tap_ensure_dirs); snapshot AFTER it so zero-mutation pins the reads.
    expect(runSpool(["status", "--json"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir }).rc).toBe(0);
    const before = snapshotTree(bus.root);
    const list = runSpool(["list", "--json"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir });
    expect(list.rc).toBe(0);
    const rows = list.out.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { id: string; class?: string });
    expect(rows).toEqual([
      { id: metaId, class: "malformed_intent" },
      { id: quarantined, class: "quarantined_malformed_intent" },
    ]);
    const status = runSpool(["status", "--json"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir });
    expect(status.rc).toBe(0);
    const statusRow = JSON.parse(status.out.trim()) as { intents: number; malformed_count: number; malformed_intents: { id: string; class: string }[] };
    expect(statusRow.intents).toBe(0); // none of the zoo is live backlog
    expect(statusRow.malformed_count).toBe(2);
    expect(statusRow.malformed_intents).toEqual([
      { id: metaId, class: "malformed_intent" },
      { id: quarantined, class: "quarantined_malformed_intent" },
    ]);
    // Report-only proof: nothing moved, nothing locked.
    expect(snapshotTree(bus.root)).toEqual(before);
    expect(readdirSync(bus.lockDir)).toEqual([]);
  });

  test("CAUSAL: a live Bash sidecar is not malformed native id X.meta (P2 collision)", () => {
    const bus = verbBus();
    const bashId = "seat-20260831T000000Z-park01";
    const bodyPath = join(bus.spoolDir, `${bashId}.md`);
    const metaPath = join(bus.spoolDir, `${bashId}.meta.json`);
    writeFileSync(bodyPath, `---\nid: ${bashId}\nfrom: alice\nto: peer\nkind: discuss\nreply: settle-only\npath: ${bodyPath}\n---\nbash body\n`);
    writeFileSync(metaPath, `${JSON.stringify({ id: bashId, target: "peer", to_team: "beta" }, null, 2)}\n`);
    const bodyBytes = readFileSync(bodyPath);
    const metaBytes = readFileSync(metaPath);
    const nativeMeta = `${bashId}.meta`;
    writeCanonical(bus, nativeMeta, { from: "alice" });
    writeInstanceRegistry(bus, null);

    const parseList = (out: string) => out.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const list = runSpool(["list", "--json"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir });
    expect(list.rc).toBe(0);
    const listRows = parseList(list.out);
    expect(listRows.some((row) => row.id === nativeMeta || row.class === "malformed_intent")).toBe(false);
    expect(listRows).toEqual([{ class: "legacy_bash_parks", count: 1, detail: "Shared spool parks; use tap cancel --spooled" }]);

    const status = runSpool(["status", "--json"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir });
    expect(status.rc).toBe(0);
    const statusRow = JSON.parse(status.out.trim()) as { malformed_count: number; malformed_intents: { id: string }[]; legacy_bash_parks: number };
    expect(statusRow.malformed_count).toBe(0);
    expect(statusRow.malformed_intents).toEqual([]);
    expect(statusRow.legacy_bash_parks).toBe(1);

    const cancel = runSpool(["cancel", nativeMeta], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir, TAP_SELF: "alice" });
    expect(cancel.rc).not.toBe(0);
    expect(cancel.err).toMatch(/not_found|no live spool intent/);
    expect(readFileSync(bodyPath).equals(bodyBytes)).toBe(true);
    expect(readFileSync(metaPath).equals(metaBytes)).toBe(true);
    expect(existsSync(join(bus.spoolDir, `${nativeMeta}.json.malformed`))).toBe(false);
  });

  test("CAUSAL: claim-held body-moved Bash ownership is not malformed native id X.meta", () => {
    const bus = verbBus();
    const bashId = "seat-20260831T000000Z-claim1";
    const nativeMeta = `${bashId}.meta`;
    const metaPath = join(bus.spoolDir, `${bashId}.meta.json`);
    const claimPath = join(bus.spoolDir, `${bashId}.claim`);
    const canonicalPath = join(bus.payloadsDir, `${bashId}.md`);
    writeFileSync(metaPath, `${JSON.stringify({ id: bashId, target: "peer", to_team: "beta" }, null, 2)}\n`);
    writeFileSync(claimPath, `${JSON.stringify({ id: bashId })}\n`);
    writeFileSync(canonicalPath, `---\nid: ${bashId}\nfrom: alice\nto: peer\nkind: discuss\nreply: settle-only\npath: ${canonicalPath}\n---\nmoved body\n`);
    writeCanonical(bus, nativeMeta, { from: "alice" });
    writeInstanceRegistry(bus, null);
    expect(existsSync(join(bus.spoolDir, `${bashId}.md`))).toBe(false);
    const metaBytes = readFileSync(metaPath);
    const claimBytes = readFileSync(claimPath);
    const canonicalBytes = readFileSync(canonicalPath);

    const parseList = (out: string) => out.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const list = runSpool(["list", "--json"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir });
    expect(list.rc).toBe(0);
    const listRows = parseList(list.out);
    expect(listRows.some((row) => row.id === nativeMeta || row.class === "malformed_intent")).toBe(false);

    const status = runSpool(["status", "--json"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir });
    expect(status.rc).toBe(0);
    const statusRow = JSON.parse(status.out.trim()) as { malformed_count: number; malformed_intents: { id: string }[] };
    expect(statusRow.malformed_count).toBe(0);
    expect(statusRow.malformed_intents).toEqual([]);

    const cancel = runSpool(["cancel", nativeMeta], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir, TAP_SELF: "alice" });
    expect(cancel.rc).not.toBe(0);
    expect(cancel.err).toMatch(/not_found|no live spool intent/);
    expect(existsSync(join(bus.spoolDir, `${nativeMeta}.json.malformed`))).toBe(false);
    expect(readFileSync(metaPath).equals(metaBytes)).toBe(true);
    expect(readFileSync(claimPath).equals(claimBytes)).toBe(true);
    expect(readFileSync(canonicalPath).equals(canonicalBytes)).toBe(true);
  });

  test("a legal native id ending in .meta still parks, lists, and cancels when no Bash pair owns the slot", () => {
    const bus = verbBus();
    const id = "seat-20260831T000000Z-live01.meta";
    parkedVerbIntent(bus, id, "alice");
    writeCanonical(bus, id, { from: "alice", to_team: "beta" });
    writeInstanceRegistry(bus, null);
    const list = runSpool(["list", "--json"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir });
    expect(list.rc).toBe(0);
    const rows = list.out.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { id: string; class?: string });
    expect(rows.some((row) => row.id === id && row.class === undefined)).toBe(true);
    const cancel = runSpool(["cancel", id], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir, TAP_SELF: "alice" });
    expect(cancel.rc).toBe(0);
    expect(existsSync(join(bus.receiptsDir, `${id}.cancelled`))).toBe(true);
    expect(existsSync(join(bus.spoolDir, `${id}.json`))).toBe(false);
  });

  test("CAUSAL: a malformed native slot whose id ends exactly .meta reports and quarantines when no Bash pair owns it", () => {
    const bus = verbBus();
    const id = "seat-20260831T000000Z-mal01.meta";
    expect(id.endsWith(".meta")).toBe(true);
    expect(id.length).toBeGreaterThan(".meta".length);
    const owner = id.slice(0, -".meta".length);
    expect(existsSync(join(bus.spoolDir, `${owner}.md`))).toBe(false);
    expect(existsSync(join(bus.spoolDir, `${owner}.meta.json`))).toBe(false);
    writeFileSync(join(bus.spoolDir, `${id}.json`), MALFORMED_BYTES);
    writeCanonical(bus, id, { from: "alice", to_team: "beta" });
    writeInstanceRegistry(bus, null);

    const list = runSpool(["list", "--json"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir });
    expect(list.rc).toBe(0);
    const listRows = list.out.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { id: string; class?: string });
    expect(listRows).toEqual([{ id, class: "malformed_intent" }]);

    const status = runSpool(["status", "--json"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir });
    expect(status.rc).toBe(0);
    const statusRow = JSON.parse(status.out.trim()) as { malformed_count: number; malformed_intents: { id: string; class: string }[] };
    expect(statusRow.malformed_count).toBe(1);
    expect(statusRow.malformed_intents).toEqual([{ id, class: "malformed_intent" }]);

    const cancel = runSpool(["cancel", id], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir, TAP_SELF: "alice" });
    expect(cancel.rc).toBe(0);
    expect(readFileSync(join(bus.spoolDir, `${id}.json.malformed`), "utf8")).toBe(MALFORMED_BYTES);
    expect(existsSync(join(bus.spoolDir, `${id}.json`))).toBe(false);
    const receipt = JSON.parse(readFileSync(join(bus.receiptsDir, `${id}.cancelled`), "utf8")) as { reason: string; source: string };
    expect(receipt.reason).toBe("malformed");
    expect(receipt.source).toBe("spool");
    expect(existsSync(join(bus.receiptsDir, `${id}.done`))).toBe(false);
    const events = readFileSync(join(bus.root, "registry-events.log"), "utf8").trim().split("\n").filter(Boolean);
    expect(events).toHaveLength(1);
    const fields = new Map(events[0]!.split(" ").map((token) => [token.split("=", 1)[0], token.slice(token.indexOf("=") + 1)]));
    expect(fields.get("action")).toBe("spool_quarantined_malformed");
    expect(fields.get("handle")).toBe(id);
    expect(existsSync(join(bus.spoolDir, `${owner}.md`))).toBe(false);
    expect(existsSync(join(bus.spoolDir, `${owner}.meta.json`))).toBe(false);
  });

  test("CAUSAL: a fence at the cancel pre-custody crossing refuses with a pristine bus", async () => {
    const root = mkdtempSync(join(tmpdir(), "tap-spool-cancel-fence."));
    const busHome = join(root, "bus");
    mkdirSync(busHome);
    const indexDir = liveIndex("tap-spool-cancel-fence-index.");
    const lockDir = mkdtempSync(join(tmpdir(), "tap-spool-cancel-fence-locks."));
    const barrierBase = join(root, "cancel-reset-barrier");
    const id = "seat-20260831T000000Z-fence1";
    expect(existsSync(join(busHome, "payloads"))).toBe(false);
    expect(existsSync(join(busHome, "receipts"))).toBe(false);
    expect(existsSync(join(busHome, ".tap-bus-authority"))).toBe(false);

    const child = Bun.spawn([process.execPath, MAIN_TS, "spool", "cancel", id], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        TAP_HOME: busHome,
        TAP_INDEX_HOME: indexDir,
        TAP_LOCK_DIR: lockDir,
        TAP_SELF: "alice",
        TAP_SCRATCH_ONLY: "1",
        TAP_OBLIGATION_TEST_BARRIER: barrierBase,
        TAP_OBLIGATION_TEST_ID: id,
        TAP_OBLIGATION_TEST_STAGE: "cancel-pre-reset-custody",
      } as NodeJS.ProcessEnv,
    });

    const deadline = Date.now() + 10_000;
    let reached = false;
    while (Date.now() < deadline) {
      const names = readdirSync(root);
      if (names.some((name) => name.startsWith("cancel-reset-barrier.cancel-pre-reset-custody.") && name.endsWith(".reached"))) {
        reached = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(reached).toBe(true);
    expect(existsSync(join(busHome, "payloads"))).toBe(false);
    expect(existsSync(join(busHome, "receipts"))).toBe(false);
    expect(existsSync(join(busHome, ".tap-bus-authority"))).toBe(false);

    writeLiveFence(join(busHome, "reset.fence.json"));
    writeFileSync(`${barrierBase}.cancel-pre-reset-custody.release`, "go\n");
    expect(await child.exited).not.toBe(0);
    const err = await new Response(child.stderr).text();
    expect(err).toContain("mid-reset");
    expect(existsSync(join(busHome, "payloads"))).toBe(false);
    expect(existsSync(join(busHome, "receipts"))).toBe(false);
    expect(existsSync(join(busHome, ".tap-bus-authority"))).toBe(false);
    expect(existsSync(join(busHome, "receipts", `${id}.cancelled`))).toBe(false);
  }, 30_000);

  test("CAUSAL: independent cancels share admission while structural reset stays excluded", async () => {
    const bus = verbBus();
    const idA = "seat-20260831T000000Z-hold01";
    const idB = "seat-20260831T000000Z-hold02";
    parkedVerbIntent(bus, idA, "alice");
    parkedVerbIntent(bus, idB, "alice");
    writeCanonical(bus, idA, { from: "alice", to_team: "beta" });
    writeCanonical(bus, idB, { from: "alice", to_team: "beta" });
    writeInstanceRegistry(bus, null);
    const canonicalB = readFileSync(join(bus.payloadsDir, `${idB}.md`));
    const barrierBase = join(bus.lockDir, "cancel-held-window");

    const child = Bun.spawn([process.execPath, MAIN_TS, "spool", "cancel", idA], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        TAP_HOME: bus.root,
        TAP_INDEX_HOME: bus.indexDir,
        TAP_LOCK_DIR: bus.lockDir,
        TAP_SELF: "alice",
        TAP_SCRATCH_ONLY: "1",
        TAP_OBLIGATION_TEST_BARRIER: barrierBase,
        TAP_OBLIGATION_TEST_ID: idA,
        TAP_OBLIGATION_TEST_STAGE: "cancel-held-window",
      } as NodeJS.ProcessEnv,
    });

    const deadline = Date.now() + 10_000;
    let reached = false;
    while (Date.now() < deadline) {
      const names = readdirSync(bus.lockDir);
      if (names.some((name) => name.startsWith("cancel-held-window.cancel-held-window.") && name.endsWith(".reached"))) {
        reached = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(reached).toBe(true);
    expect(existsSync(join(bus.receiptsDir, `${idA}.cancelled`))).toBe(true);
    expect(existsSync(join(bus.spoolDir, `${idA}.json`))).toBe(false);

    const competitor = runSpool(["cancel", idB], {
      TAP_HOME: bus.root,
      TAP_INDEX_HOME: bus.indexDir,
      TAP_LOCK_DIR: bus.lockDir,
      TAP_SELF: "alice",
    });
    expect(competitor.rc, competitor.err).toBe(0);
    expect(existsSync(join(bus.spoolDir, `${idB}.json`))).toBe(false);
    expect(readFileSync(join(bus.payloadsDir, `${idB}.md`)).equals(canonicalB)).toBe(true);
    expect(existsSync(join(bus.receiptsDir, `${idB}.cancelled`))).toBe(true);

    // Mail takes obligation -> reset SH; a structural EX contender must still
    // refuse until the first cancel finishes its last mutation.
    const structural = acquirePathLock(join(bus.root, "reset.fence.json.lock"), 0);
    structural?.release();
    expect(structural).toBeNull();

    writeFileSync(`${barrierBase}.cancel-held-window.release`, "go\n");
    expect(await child.exited).toBe(0);
    expect(existsSync(join(bus.receiptsDir, `${idA}.cancelled`))).toBe(true);
    expect(existsSync(join(bus.spoolDir, `${idA}.json`))).toBe(false);
    expect(existsSync(join(bus.spoolDir, `${idB}.json`))).toBe(false);
    expect(existsSync(join(bus.receiptsDir, `${idB}.cancelled`))).toBe(true);
    const after = acquirePathLock(join(bus.root, "reset.fence.json.lock"), 0);
    expect(after).not.toBeNull();
    after?.release();
  }, 30_000);

  test("CAUSAL (fix round item 3): a failing append is attempted exactly once, warns once, leaves durable state", () => {
    const bus = verbBus();
    writeFileSync(join(bus.spoolDir, `${RAW}.json`), MALFORMED_BYTES);
    writeCanonical(bus, RAW, { from: "alice" });
    writeInstanceRegistry(bus, null);
    // ATTEMPT COUNTING, one layer down from where it used to sit. This arm was
    // written when the event was a `bash -c '. lib.sh; …'` child, and it counted
    // attempts with a fixture `bash` first on PATH. The append later moved
    // in-process, so that counter can no longer see anything — and a fixture
    // that counts a boundary the code no longer crosses reads 0 and passes for
    // the wrong reason.
    //
    // The PROPERTY is unchanged and is what this now counts: one attempt, one
    // warning, no rollback. `appendRegistryEventOrWarn` emits exactly one
    // warning line per call, so a wrapper-level retry (two calls) prints two —
    // the same discrimination the shell-out counter bought, against the
    // implementation that actually ships. The induced failure is a log path
    // that is a directory, which no write can succeed against.
    mkdirSync(join(bus.root, "registry-events.log"), { recursive: true });
    const result = runSpool(["cancel", RAW], {
      TAP_HOME: bus.root,
      TAP_INDEX_HOME: bus.indexDir,
      TAP_LOCK_DIR: bus.lockDir,
      TAP_SELF: "alice",
    });
    expect(result.rc).toBe(0); // no rollback: the withdrawal itself succeeded
    expect(readFileSync(join(bus.spoolDir, `${RAW}.json.malformed`), "utf8")).toBe(MALFORMED_BYTES);
    const receipt = JSON.parse(readFileSync(join(bus.receiptsDir, `${RAW}.cancelled`), "utf8")) as { reason: string };
    expect(receipt.reason).toBe("malformed");
    const warnings = result.err.split("\n").filter((line) => line.includes("spool_quarantined_malformed") && line.includes("warning"));
    expect(warnings).toHaveLength(1);
  });

  test("C4: authorization holds on the quarantine path — no gate, no mutation", () => {
    const bus = verbBus();
    writeFileSync(join(bus.spoolDir, `${RAW}.json`), MALFORMED_BYTES);
    writeCanonical(bus, RAW, { from: "alice", sender_instance: "alice|gen1" });
    writeInstanceRegistry(bus, "alice|gen2");
    expect(runSpool(["status", "--json"], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir }).rc).toBe(0);
    const before = snapshotTree(bus.root);
    const wrongActor = runSpool(["cancel", RAW], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir, TAP_SELF: "bob" });
    expect(wrongActor.err).toContain("is not the sender");
    const staleInstance = runSpool(["cancel", RAW], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir, TAP_SELF: "alice" });
    expect(staleInstance.err).toContain("predecessor-bound");
    const after = snapshotTree(bus.root);
    after.delete("/reset.fence.json.lock");
    expect(after).toEqual(before); // slot bytes untouched, no receipt; lockf leaves the reset sidecar
    expect(existsSync(join(bus.receiptsDir, `${RAW}.cancelled`))).toBe(false);
    expect(existsSync(join(bus.root, "registry-events.log"))).toBe(false);
    // Fix-round item 4: a canonical minted for a DIFFERENT id cannot authorize
    // a malformed slot's quarantine — no mutation, event, or receipt.
    const mismatchBus = verbBus();
    writeFileSync(join(mismatchBus.spoolDir, `${RAW}.json`), MALFORMED_BYTES);
    writeCanonical(mismatchBus, RAW, { from: "alice", envelopeId: "seat-20269999T999999Z-zzzzzz" });
    writeInstanceRegistry(mismatchBus, null);
    const mismatch = runSpool(["cancel", RAW], { TAP_HOME: mismatchBus.root, TAP_INDEX_HOME: mismatchBus.indexDir, TAP_LOCK_DIR: mismatchBus.lockDir, TAP_SELF: "alice" });
    expect(mismatch.rc).not.toBe(0);
    expect(mismatch.err).toContain(`not '${RAW}'`);
    expect(readFileSync(join(mismatchBus.spoolDir, `${RAW}.json`), "utf8")).toBe(MALFORMED_BYTES);
    expect(existsSync(join(mismatchBus.spoolDir, `${RAW}.json.malformed`))).toBe(false);
    expect(existsSync(join(mismatchBus.receiptsDir, `${RAW}.cancelled`))).toBe(false);
    expect(existsSync(join(mismatchBus.root, "registry-events.log"))).toBe(false);
  });

  test("C5: rename failure writes no receipt and no event; receipt failure leaves the quarantine visible and fails loud", () => {
    // Rename failure: the spool dir refuses writes. Preflight binds or fails loud.
    const bus = verbBus();
    writeFileSync(join(bus.spoolDir, `${RAW}.json`), MALFORMED_BYTES);
    writeCanonical(bus, RAW, { from: "alice" });
    writeInstanceRegistry(bus, null);
    chmodSync(bus.spoolDir, 0o500);
    try {
      preflightUnwritable(bus.spoolDir, "spool dir write");
      const result = runSpool(["cancel", RAW], { TAP_HOME: bus.root, TAP_INDEX_HOME: bus.indexDir, TAP_LOCK_DIR: bus.lockDir, TAP_SELF: "alice" });
      expect(result.rc).not.toBe(0);
      expect(existsSync(join(bus.receiptsDir, `${RAW}.cancelled`))).toBe(false);
      expect(existsSync(join(bus.root, "registry-events.log"))).toBe(false);
      chmodSync(bus.spoolDir, 0o755);
      expect(readFileSync(join(bus.spoolDir, `${RAW}.json`), "utf8")).toBe(MALFORMED_BYTES);
    } finally {
      chmodSync(bus.spoolDir, 0o755);
    }
    // Receipt failure: the receipts dir refuses writes AFTER a successful rename.
    const bus2 = verbBus();
    writeFileSync(join(bus2.spoolDir, `${RAW}.json`), MALFORMED_BYTES);
    writeCanonical(bus2, RAW, { from: "alice" });
    writeInstanceRegistry(bus2, null);
    chmodSync(bus2.receiptsDir, 0o500);
    try {
      preflightUnwritable(bus2.receiptsDir, "receipts dir write");
      const result = runSpool(["cancel", RAW], { TAP_HOME: bus2.root, TAP_INDEX_HOME: bus2.indexDir, TAP_LOCK_DIR: bus2.lockDir, TAP_SELF: "alice" });
      expect(result.rc).not.toBe(0);
      // The quarantine IS visible, byte-preserved; no event followed it.
      expect(readFileSync(join(bus2.spoolDir, `${RAW}.json.malformed`), "utf8")).toBe(MALFORMED_BYTES);
      expect(existsSync(join(bus2.spoolDir, `${RAW}.json`))).toBe(false);
      expect(existsSync(join(bus2.root, "registry-events.log"))).toBe(false);
    } finally {
      chmodSync(bus2.receiptsDir, 0o755);
    }
  });
});

function seedLiveFlipMarker(): () => void {
  const index = mkdtempSync(join(tmpdir(), "tap-spool-u3-flip."));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20" }));
  const prevHome = process.env.TAP_INDEX_HOME;
  process.env.TAP_INDEX_HOME = index;
  return () => {
    if (prevHome === undefined) delete process.env.TAP_INDEX_HOME;
    else process.env.TAP_INDEX_HOME = prevHome;
  };
}

describe("spool, send, reply, and done stay native", () => {
  test("route() keeps spool/send/reply/done native", () => {
    const restore = seedLiveFlipMarker();
    try {
      const calls: string[] = [];
      const handlers = {
        send: () => 11,
        reply: () => 11,
        done: () => 11,
        spool: () => 9,
      };
      const fallback = (argv: string[]) => {
        calls.push(argv[0] ?? "");
        return 22;
      };
      expect(route(["spool", "list"], handlers, fallback)).toBe(9);
      expect(route(["send"], handlers, fallback)).toBe(11);
      expect(route(["reply"], handlers, fallback)).toBe(11);
      expect(route(["done"], handlers, fallback)).toBe(11);
      expect(calls).toEqual([]);
    } finally {
      restore();
    }
  });

  test("tap help spool names list/status/cancel, Bash-drain ownership, and the no-drain boundary", () => {
    const tapSh = join(import.meta.dir, "..", "..", "..", "bin/tap");
    const home = mkdtempSync(join(tmpdir(), "tap-spool-help."));
    const child = spawnSync("bash", [tapSh, "help", "spool"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, TAP_HOME: join(home, "bus") },
    });
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("tap spool list");
    expect(child.stdout).toContain("status");
    expect(child.stdout).toContain("cancel");
    expect(child.stdout).toContain("tap cancel <id> --spooled");
    expect(child.stdout).toContain("It never converts a pair to an intent.");
    expect(child.stdout).toContain("never drains the spool or starts an owner");
    expect(child.stdout).not.toMatch(/dark|PR-B1|U6/);
    expect(child.stdout).not.toMatch(/first-touch migrate/i);
    expect(child.stdout).toContain("tap spool kick is not a verb");
  });
});
