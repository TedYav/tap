import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composerOnlyProof, evaluateFlow, inspectFlow, saveBaseline, type PayloadBaseline } from "../src/recovery/proof";
import { alreadyProcessed, allPendingQueued, pendingEvidence } from "../src/recovery/evidence";
import { resolveContext } from "../src/context";
import { runDirectory, type RecoveryRun } from "../src/recovery/state";
import type { RecoveryEvent } from "../src/recovery/effect";
import type { PhaseRow } from "../src/submit-phase";
const run: RecoveryRun = { v: 1, id: "recovery-00000000-0000-0000-0000-000000000000", mode: "aggressive", hold: true,
  target: { team: "test", handle: "peer", registry: "/unused", pane: "%1", paneId: "%1", session: "test/peer", instance: "instance", harness: "codex" },
  ownerPane: "%2", ownerPid: 1, started: 0, deadline: 300000, effects: 1, payloads: [{ home: "/bus", id: "sender-20260907T000000Z-abcd" }], state: "active" };
const ref = run.payloads[0]!;
const baseline: PayloadBaseline[] = [{ ...ref, attempts: ["old"], sentHash: "old-sent" }];
function phases(attempt = "new", linked = true): PhaseRow[] {
  return ["Enter-sent", "verify-result"].map(phase => ({ v: 1, id: ref.id, attempt, phase: phase as PhaseRow["phase"], at: "now",
    recipient: "peer", enter_count: 1, result: phase === "verify-result" ? "verified" : undefined, recovery_id: linked ? run.id : undefined }));
}
test("recovery settlement evidence requires a regular file", () => {
  const home = mkdtempSync(join(tmpdir(), "tap-recovery-kind."));
  const receipts = join(home, "receipts"), directory = join(home, "directory");
  mkdirSync(receipts); mkdirSync(directory);
  try {
    for (const suffix of ["read", "done", "cancelled"]) mkdirSync(join(receipts, `item.${suffix}`));
    expect(alreadyProcessed({ home, id: "item", team: "test" })).toBe(false);
    for (const suffix of ["read", "done", "cancelled"]) {
      const path = join(receipts, `item.${suffix}`);
      rmSync(path, { recursive: true }); symlinkSync(directory, path);
    }
    expect(alreadyProcessed({ home, id: "item", team: "test" })).toBe(false);
    rmSync(join(receipts, "item.read")); writeFileSync(join(receipts, "item.read"), "observed");
    expect(alreadyProcessed({ home, id: "item", team: "test" })).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test("old receipts, old phases and a worker's claimed success cannot prove recovery", () => {
  expect(evaluateFlow(run, baseline, [], [{ ref, phases: [], sentHash: "old-sent", queued: false }], true).kind).toBe("unresolved");
  expect(evaluateFlow(run, baseline, [], [{ ref, phases: phases("old"), sentHash: "new-sent", queued: false }], true).kind).toBe("unresolved");
  expect(evaluateFlow(run, baseline, [], [{ ref, phases: phases(), sentHash: "old-sent", queued: false }], true).kind).toBe("unresolved");
});
test("fresh correlated staged submission needs its real before/after record, not a new sent writer", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-recovery-proof-"));
  try {
    const before = join(root, "before.ansi"), after = join(root, "after.ansi");
    writeFileSync(before, `› [[TAP v0.23 note ${ref.id}]]\n`); writeFileSync(after, "› \n");
    const event: RecoveryEvent = { v: 1, recoveryId: run.id, seat: "test/peer", mode: "aggressive", action: "nudge Enter",
      reason: "bound sentinel", before, after, state: null, outcome: "unverified", summary: "frames", at: "now", incident: false };
    const item = { ref, phases: phases(), sentHash: null, queued: false };
    expect(evaluateFlow(run, baseline, [event], [item], true).kind).toBe("submitted");
    const read = { ref, phases: [], sentHash: "queue-read-sent", queued: false, readHash: "fresh-read", read: { id: ref.id, by: "peer" } };
    expect(evaluateFlow(run, baseline, [event], [read], true).kind).toBe("read");
    expect(evaluateFlow(run, baseline, [event], [{ ...read, read: { ...read.read, forced: true } }], true).kind).toBe("unresolved");

    expect(evaluateFlow(run, baseline, [{ ...event, incident: true }], [item], true).kind).toBe("unresolved");
    expect(evaluateFlow(run, baseline, [event], [item], false).kind).toBe("unresolved");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("ordinary courier completion consumes its fresh receipt; harness queue remains a separate no-replay outcome", () => {
  expect(evaluateFlow(run, baseline, [], [{ ref, phases: phases("new", false), sentHash: "new-sent", queued: false }], true).kind).toBe("unresolved");
  expect(evaluateFlow(run, baseline, [], [{ ref, phases: [], sentHash: null, queued: true, queuedHash: "fresh-queued" }], true).kind).toBe("queued");
});

test("UI-only repair reports an observation without inventing submission proof", () => {
  const empty = { ...run, payloads: [] };
  expect(composerOnlyProof(empty, "› \n", true, true)?.kind).toBe("observed");
  expect(composerOnlyProof(empty, "› \n", true, true)?.summary).toContain("no pending message");
  expect(composerOnlyProof(empty, "Settings dialog\n", true, true)).toBeNull();
  expect(composerOnlyProof(empty, "› \n", false, true)).toBeNull();
  expect(composerOnlyProof(empty, "› \n", true, false)).toBeNull();
  expect(composerOnlyProof(run, "› \n", true, true)).toBeNull();
  expect(composerOnlyProof({ ...empty, state: "stopped" }, "› \n", true, true)).toBeNull();
});

test("fresh note-read settlements prove observation; old, forced, unrelated and retired records cannot", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-recovery-note-"));
  const previous = process.env.TAP_INDEX_HOME; process.env.TAP_INDEX_HOME = root;
  try {
    const home = join(root, "bus"), id = ref.id; mkdirSync(join(home, "receipts"), { recursive: true });
    const current = { ...run, state: "released" as const, payloads: [{ home, id }] };
    const dir = runDirectory(current.id); mkdirSync(dir, { recursive: true });
    const before = join(dir, "initial.ansi"), after = join(dir, "final.ansi");
    writeFileSync(before, "dialog"); writeFileSync(after, "› ");
    writeFileSync(join(dir, "events.jsonl"), [
      { recoveryId: run.id, action: "inspect:initial", before, after: before, incident: false },
      { recoveryId: run.id, action: "inspect:final", before: after, after, incident: false },
    ].map(e => JSON.stringify(e)).join("\n") + "\n");
    const receipt = { id, by: "peer", via: "read", status: "done" };
    const path = join(home, "receipts", `${id}.done`); writeFileSync(path, JSON.stringify(receipt));
    const baseline = saveBaseline(current);
    expect(inspectFlow(current, baseline, () => false, true).kind).toBe("unresolved");
    for (const bad of [{ forced: "true" }, { by: "stranger" }, { reason: "instance_retired" }, { via: "reply" }]) {
      writeFileSync(path, JSON.stringify({ ...receipt, ...bad, at: "new" }));
      expect(inspectFlow(current, baseline, () => false, true).kind).toBe("unresolved");
    }
    writeFileSync(path, JSON.stringify({ ...receipt, at: "new" }));
    const proof = inspectFlow(current, baseline, () => false, true);
    expect(proof.kind).toBe("read"); expect(proof.summary).toContain("task completion unconfirmed");
  } finally {
    if (previous === undefined) delete process.env.TAP_INDEX_HOME; else process.env.TAP_INDEX_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("an old queued sibling cannot certify recovery of another stuck message", () => {
  const stuck = { home: ref.home, id: "sender-20260907T000001Z-abcd" };
  const baselines = [{ ...baseline[0]!, queuedHash: "old-queue" }, { ...stuck, attempts: [], sentHash: null, queuedHash: null }];
  const observations = [
    { ref, phases: [], sentHash: null, queued: true, queuedHash: "old-queue" },
    { ref: stuck, phases: [], sentHash: null, queued: false, queuedHash: null as string | null },
  ];
  expect(evaluateFlow({ ...run, payloads: [ref, stuck] }, baselines, [], observations, true).kind).toBe("unresolved");
  observations[1] = { ...observations[1]!, queued: true, queuedHash: "fresh-queue" };
  expect(evaluateFlow({ ...run, payloads: [ref, stuck] }, baselines, [], observations, true).payload?.id).toBe(stuck.id);
});

test("historical enumeration is bounded while the staged id is found directly", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-recovery-history-")), previous = process.env.TAP_INDEX_HOME;
  process.env.TAP_INDEX_HOME = root;
  try {
    const home = join(root, ".tap/bus"), directory = join(home, "payloads"), registry = join(root, "registry.json");
    mkdirSync(directory, { recursive: true }); mkdirSync(join(home, "receipts"));
    writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "test", worktree_root: root }, seats: {} }));
    writeFileSync(join(root, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { test: { root, registry_location: registry } } }));
    for (let i = 0; i < 4097; i++) writeFileSync(join(directory, `history-${i}.bin`), "");
    mkdirSync(join(home, "spool"));
    writeFileSync(join(home, "spool", `${ref.id}.md`), `---\nid: ${ref.id}\nfrom: sender\nto: peer\nrecipient_instance: instance\n---\nprivate body\n`);
    const result = pendingEvidence(resolveContext(root), { ...run.target, registry }, `› [[TAP v0.23 note ${ref.id}]]`);
    expect(result.payloads.some(p => p.id === ref.id)).toBe(true);
    expect(result.gaps).toContain("pending evidence scan bounded; historical enumeration incomplete");
    writeFileSync(join(home, "receipts", `${ref.id}.harness-queued`), JSON.stringify({id:ref.id,status:"queued",delivery:"harness-queue"}));
    expect(allPendingQueued(result)).toBe(false);
    expect(allPendingQueued({...result,gaps:[]})).toBe(true);
    expect(allPendingQueued({...result,gaps:["unreadable pending directory: /foreign/spool"]})).toBe(false);
    expect(allPendingQueued({payloads:[],gaps:[]})).toBe(false);
    expect(JSON.stringify(result.records)).not.toContain("private body");
  } finally {
    if (previous === undefined) delete process.env.TAP_INDEX_HOME; else process.env.TAP_INDEX_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
