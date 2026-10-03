// The addressee grant's unit rows (D2-u1): historyDirForBus, instanceInHistory,
// instanceClearingRemedy and addresseeGrant against materialized registries,
// histories and markers. The differential against the pinned incumbent base
// program is internal-only history. This file also runs the native half of
// that differential: the 26 rows that carry an expectation, including both
// ratified refusal deviations. The malformed-registry row that has no native
// expectation stays on the base-program parity differential.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addresseeGrant, historyDirForBus, instanceClearingRemedy, instanceInHistory, NO_CLEARING_PATH } from "../src/addressee-grant";
import { addresseeScratch, deviationDetailFragment, nativeDoor, nativeExpectedRows, pick } from "./support/addressee-native-rows";
import { removeScratchTree } from "./support/scratch";

let scratchRoot = "";
const restoreModes: string[] = [];
afterAll(() => {
  for (const p of restoreModes) { try { chmodSync(p, 0o755); } catch { /* gone */ } }
  if (scratchRoot) removeScratchTree(scratchRoot);
});

function tmp(): string {
  if (!scratchRoot) scratchRoot = mkdtempSync(join(tmpdir(), "tap-grant."));
  return mkdtempSync(join(scratchRoot, "fx."));
}
describe("addressee grant — module rows", () => {
  test("historyDirForBus follows the incumbent's bus layouts", () => {
    const root = tmp();
    mkdirSync(join(root, "wt", ".tap", "bus"), { recursive: true });
    mkdirSync(join(root, "legacy", "tmp", "tap"), { recursive: true });
    mkdirSync(join(root, "odd", "bus"), { recursive: true });
    const real = (p: string) => realpathSync(p);
    expect(historyDirForBus(join(root, "wt", ".tap", "bus"))).toBe(join(real(join(root, "wt")), ".tap", "team-history"));
    expect(historyDirForBus(join(root, "legacy", "tmp", "tap"))).toBe(join(real(join(root, "legacy", "tmp")), ".tap", "team-history"));
    expect(historyDirForBus(join(root, "odd", "bus"))).toBe(join(real(join(root, "odd")), ".tap", "team-history"));
    expect(historyDirForBus("/bus")).toBe(join("/", ".tap", "team-history")); expect(historyDirForBus("/tmp/tap")).toBe(join(realpathSync("/tmp"), ".tap", "team-history")); // macOS /tmp is a symlink; pwd -P parity
    expect(historyDirForBus(join(root, "missing", "bus"))).toBe("");
  });

  test("instanceInHistory: 0 found / 1 looked and absent / 2 could not look — never collapsed", () => {
    const root = tmp();
    const hist = join(root, "team-history");
    mkdirSync(hist);
    writeFileSync(join(hist, "alice.1.json"), JSON.stringify({ handle: "alice", instance: "alice|OLD" }));
    writeFileSync(join(hist, "alice.2.lineage.json"), JSON.stringify({ handle: "alice", instance: "alice|LIN" }));
    writeFileSync(join(hist, "alice.3.json"), JSON.stringify({ handle: "bob", instance: "alice|WRONGHANDLE" }));
    writeFileSync(join(hist, "alice.4.json"), "{ not json");
    writeFileSync(join(hist, "alicia.5.json"), JSON.stringify({ handle: "alice", instance: "alice|PREFIX" }));
    expect(instanceInHistory(hist, "alice", "alice|OLD")).toBe(0);
    expect(instanceInHistory(hist, "alice", "alice|LIN")).toBe(1);          // lineage files are not tombstones
    expect(instanceInHistory(hist, "alice", "alice|WRONGHANDLE")).toBe(1);  // a tombstone must name its handle
    expect(instanceInHistory(hist, "alice", "alice|PREFIX")).toBe(1);       // `alicia.` is not `alice.`
    expect(instanceInHistory(hist, "alice", "alice|NOPE")).toBe(1);
    expect(instanceInHistory(join(root, "absent"), "alice", "alice|OLD")).toBe(1);
    expect(instanceInHistory("", "alice", "alice|OLD")).toBe(2);
    expect(instanceInHistory(hist, "", "alice|OLD")).toBe(2);
    expect(instanceInHistory(hist, "alice", "")).toBe(2);
    writeFileSync(join(root, "afile"), "x");
    expect(instanceInHistory(join(root, "afile"), "alice", "alice|OLD")).toBe(1);
    const locked = join(root, "locked"); mkdirSync(locked); chmodSync(locked, 0o000); restoreModes.push(locked);
    expect(instanceInHistory(locked, "alice", "alice|OLD")).toBe(process.getuid?.() === 0 ? 1 : 2);
    // Only regular files are tombstones (review): a writerless
    // FIFO named like one must be skipped, not opened; a directory likewise.
    const fifoHist = join(root, "fifo-history"); mkdirSync(fifoHist);
    expect(Bun.spawnSync(["mkfifo", join(fifoHist, "alice.1.json")]).exitCode).toBe(0);
    mkdirSync(join(fifoHist, "alice.2.json"));
    writeFileSync(join(fifoHist, "alice.3.json"), JSON.stringify({ handle: "alice", instance: "alice|REAL" }));
    expect(instanceInHistory(fifoHist, "alice", "alice|OLD")).toBe(1);
    expect(instanceInHistory(fifoHist, "alice", "alice|REAL")).toBe(0);
  });

  test("instanceClearingRemedy: the six doors, plus the unreadable-registry polarity the incumbent had", () => {
    const root = tmp();
    const reg = join(root, "team-registry.json");
    const hist = join(root, "team-history");
    mkdirSync(hist);
    writeFileSync(reg, JSON.stringify({ schema: "0.20", team: { name: "flip" }, seats: { alice: { instance: "alice|NEW" } } }));
    writeFileSync(join(hist, "alice.1.json"), JSON.stringify({ handle: "alice", instance: "alice|OLD" }));
    const live = { adoptionRegistryPath: reg, marker: "live" as const, historyDir: hist };
    // Question does not apply
    expect(instanceClearingRemedy(live, "alice", "")).toEqual({ kind: "unknown", next: "", detail: "" });
    expect(instanceClearingRemedy({ ...live, marker: "absent" }, "alice", "alice|OLD").kind).toBe("unknown");
    expect(instanceClearingRemedy({ ...live, adoptionRegistryPath: "" }, "alice", "alice|OLD").kind).toBe("unknown");
    expect(instanceClearingRemedy(live, "alice", "alice|NEW").kind).toBe("unknown");
    // Row present
    expect(instanceClearingRemedy(live, "alice", "alice|OLD")).toEqual({ kind: "command", next: "tap team",
      detail: "'alice|OLD' is still a tombstone in 'alice''s history, so a path exists but it is not free: it needs 'tap out alice' — which removes the seat holding that handle right now — followed by 'tap in alice --restore alice|OLD'. Look at who holds 'alice' before taking it; against a live teammate, do not" });
    expect(instanceClearingRemedy(live, "alice", "alice|GONE")).toEqual({ kind: "none", next: NO_CLEARING_PATH,
      detail: "'alice|GONE' is not in 'alice''s instance history, so there is nothing to restore and the current seat cannot cancel it" });
    expect(instanceClearingRemedy({ ...live, historyDir: "" }, "alice", "alice|OLD")).toEqual({ kind: "command", next: "tap in alice --list-history",
      detail: "'alice''s instance history could not be read, so whether 'alice|OLD' is restorable is unknown — 'tap in alice --list-history' answers it" });
    // Row absent
    expect(instanceClearingRemedy(live, "carol", "carol|OLD")).toEqual({ kind: "none", next: NO_CLEARING_PATH,
      detail: "'carol' currently holds no seat and 'carol|OLD' is not in its instance history, so there is no tombstone to restore and nothing to cancel from — a fresh registration mints a different instance and will not match" });
    writeFileSync(join(hist, "carol.1.json"), JSON.stringify({ handle: "carol", instance: "carol|OLD" }));
    expect(instanceClearingRemedy(live, "carol", "carol|OLD")).toEqual({ kind: "command", next: "tap in carol --restore carol|OLD",
      detail: "'carol' currently holds no seat and 'carol|OLD' is still a tombstone in its history, so restoring that exact instance lets a normal cancel proceed afterward" });
    expect(instanceClearingRemedy({ ...live, historyDir: "" }, "carol", "carol|OLD")).toEqual({ kind: "command", next: "tap in carol --list-history",
      detail: "'carol' currently holds no seat, but its instance history could not be read, so whether 'carol|OLD' can be restored is unknown" });
    // The incumbent's row_present="unreadable" fell into the row-PRESENT branch.
    const broken = join(root, "broken.json"); writeFileSync(broken, "{ nope");
    expect(instanceClearingRemedy({ ...live, adoptionRegistryPath: broken }, "alice", "alice|OLD").next).toBe("tap team");
  });

  test("addresseeGrant: the actor's own mail, with and without an instance binding", () => {
    const root = tmp();
    const reg = join(root, "team-registry.json");
    writeFileSync(reg, JSON.stringify({ schema: "0.20", team: { name: "flip" }, seats: { actor: { instance: "actor|CUR" } } }));
    const base = { registryPath: reg, marker: "live" as const, team: "flip", historyDir: join(root, "no-history"), id: "ID1", from: "bob", actor: "actor", to: "actor", adoptedFrom: "" };
    expect(addresseeGrant({ ...base, recipientInstance: "" })).toMatchObject({ ok: true, grant: "", actorInstance: "" });
    expect(addresseeGrant({ ...base, recipientInstance: "actor|CUR" })).toMatchObject({ ok: true, grant: "", actorInstance: "actor|CUR" });
    const mismatch = addresseeGrant({ ...base, recipientInstance: "actor|OLD" });
    expect(mismatch).toMatchObject({ ok: false, errorClass: "not_addressee", instanceMismatch: true,
      detail: "'ID1' is bound to recipient instance 'actor|OLD', not the current 'actor' instance", next: "tap cancel ID1 --by bob" });
    expect(mismatch.remedy.kind).toBe("none");
    // A marker that is absent ignores the binding entirely.
    expect(addresseeGrant({ ...base, marker: "absent", recipientInstance: "actor|OLD" })).toMatchObject({ ok: true, actorInstance: "" });
    // No registry with a binding to verify: registry_unreachable.
    expect(addresseeGrant({ ...base, registryPath: "", recipientInstance: "actor|OLD" })).toMatchObject({ ok: false, errorClass: "registry_unreachable", next: "tap doctor",
      detail: "acting registry unreachable — cannot verify recipient instance for 'ID1'" });
    // Actor without a row: the binding is unresolved.
    expect(addresseeGrant({ ...base, actor: "ghost", to: "ghost", recipientInstance: "ghost|X" })).toMatchObject({ ok: false, errorClass: "instance_unresolved" });
    expect(addresseeGrant({ ...base, from: "", recipientInstance: "actor|OLD" }).next).toBe("tap cancel ID1");
  });
});

describe("addressee grant — native differential rows", () => {
  const scratch = addresseeScratch("tap-grant-native.");
  afterAll(() => scratch.reap());

  const FLOAT_NOTE = "the incumbent's json.load accepted 0.5; loadRegistry refuses the value domain (registry.ts) — ratified 06:13Z, the refusal names the value";
  const INTEGER_NOTE = "2^53 exceeds the safe-integer range; loadRegistry refuses — ratified 06:13Z, the refusal names the value";

  test("the shipped native rows are the 26 expected outcomes, including both refusal deviations", () => {
    expect(nativeExpectedRows).toHaveLength(26);
    expect(nativeExpectedRows.every((row) => row.expect !== undefined)).toBe(true);
    expect(nativeExpectedRows.map((row) => row.label)).not.toContain("malformed registry with a binding");
    const deviations = nativeExpectedRows.filter((row) => row.deviation);
    expect(deviations.map((row) => row.label)).toEqual([
      "adoption grant beside an unrelated float field: the native value domain refuses what the incumbent granted, naming the value",
      "adoption grant beside an unsafe integer field, with a binding: the native value domain refuses what the incumbent granted, naming the value",
    ]);
    expect(deviations.map((row) => row.deviation?.note)).toEqual([FLOAT_NOTE, INTEGER_NOTE]);
  });

  for (const row of nativeExpectedRows) {
    test(row.label, () => {
      const fx = scratch.fixture(row.fx);
      const native = nativeDoor(fx, row.args);
      expect({ label: row.label, ...pick(native, row.expect) }).toEqual({ label: row.label, ...row.expect });
      if (row.deviation) {
        const value = deviationDetailFragment(row);
        expect({ label: row.label, native: native.DETAIL.includes(value) }).toEqual({ label: row.label, native: true });
        expect(row.deviation.note === FLOAT_NOTE || row.deviation.note === INTEGER_NOTE).toBe(true);
      }
    }, 60_000);
  }
});
