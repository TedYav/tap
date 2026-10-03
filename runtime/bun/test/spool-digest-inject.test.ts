import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTOSETTLE_POLICY, digestInjectStep, initialState, releaseAll, type InjectState, type InjectStep } from "../src/spool-digest-inject";
import { digestView } from "../src/verbs/digest-view";

const roots: string[] = [];
const originalConfig = process.env.XDG_CONFIG_HOME;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfig;
});
function fixture(ids = ["a", "b"], policy = "standard", toTeam = "t") {
  const home = mkdtempSync(join(tmpdir(), "tap-digest-inject.")); roots.push(home);
  const spoolDir = join(home, "spool"), payloadsDir = join(home, "payloads"), receiptsDir = join(home, "receipts");
  for (const dir of [spoolDir, payloadsDir, receiptsDir]) mkdirSync(dir);
  process.env.XDG_CONFIG_HOME = join(home, "config");
  const targetRegistry = join(home, "registry.json");
  writeFileSync(targetRegistry, JSON.stringify({ schema: "0.20", team: { name: "t" }, seats: {} }));
  const state = initialState({ home, spoolDir, payloadsDir, receiptsDir, targetRegistry, ids,
    team: "t", toTeam, courierIdentity: "courier", handle: "peer", pane: "sess:0.0", paneId: "%401" });
  for (const id of ids) {
    writeFileSync(join(spoolDir, `${id}.md`), `---\nid: ${id}\nfrom: sender\nto: peer\nkind: discuss\nreply: expected\n---\nbody ${id}\n`);
    writeFileSync(join(spoolDir, `${id}.meta.json`), JSON.stringify({ policy }));
  }
  return { state, home, spoolDir, payloadsDir, receiptsDir,
    claims: () => readdirSync(spoolDir).filter(n => n.endsWith(".claim")).sort(),
    index: () => JSON.parse(readFileSync(state.indexPath!, "utf8")) };
}
function toSubmit(state: InjectState, readiness = "ready", answer?: (step: InjectStep) => void) {
  let step = digestInjectStep(state);
  const needs: string[] = [];
  for (let limit = 0; limit < 100 && !step.done; limit++) {
    needs.push(step.need.kind);
    answer?.(step);
    switch (step.need.kind) {
      case "readiness": step = digestInjectStep(state, { readiness }); break;
      case "matches-team": step = digestInjectStep(state, { matchesTeam: true }); break;
      case "identity": step = digestInjectStep(state, { identity: "match" }); break;
      case "harness": step = digestInjectStep(state, { harness: "codex" }); break;
      default: return { step, needs };
    }
  }
  return { step, needs };
}
// Planner tests stand in for the immediate native custody owner. Real moves,
// failures and reset races run in spool-drain-effects/reset-drain-custody tests.
function canonicalize(f: ReturnType<typeof fixture>) {
  for (const id of f.state.survivors) {
    renameSync(join(f.spoolDir, `${id}.md`), join(f.payloadsDir, `${id}.md`));
    rmSync(join(f.spoolDir, `${id}.meta.json`));
  }
  releaseAll(f.state);
}

test("claims every candidate; contention releases only its own claims", () => {
  const f = fixture();
  expect(digestInjectStep(f.state)).toEqual({ done: false, need: { kind: "readiness" } });
  expect(f.claims()).toEqual(["a.claim", "b.claim"]);
  releaseAll(f.state);
  writeFileSync(join(f.spoolDir, "b.claim"), "sibling");
  expect(digestInjectStep(initialState(f.state.prefix))).toMatchObject({ done: true, rc: 1 });
  expect(f.claims()).toEqual(["b.claim"]);
});
for (const readiness of ["busy", "ready:soon", "busy:noprompt"]) test(`readiness ${readiness} refuses with custody intact`, () => {
  const f = fixture();
  expect(toSubmit(f.state, readiness).step).toMatchObject({ done: true, rc: 1 });
  expect(f.claims()).toEqual([]);
  expect(readdirSync(f.payloadsDir)).toEqual([]);
  expect(existsSync(join(f.spoolDir, "a.md"))).toBe(true);
});
for (const missing of ["none", "absent", "directory", "done", "cancelled"] as const)
test(`revalidation spends observations only on eligible entries (${missing})`, () => {
  const f = fixture(["a", "b", "c"]);
  if (missing === "absent" || missing === "directory") rmSync(join(f.spoolDir, "c.md"));
  if (missing === "directory") mkdirSync(join(f.spoolDir, "c.md"));
  if (missing === "done" || missing === "cancelled") writeFileSync(join(f.receiptsDir, `c.${missing}`), "{}");
  const { needs } = toSubmit(f.state);
  const count = missing === "none" ? 3 : 2;
  expect(needs.filter(n => n === "matches-team")).toHaveLength(count);
  expect(needs.filter(n => n === "identity")).toHaveLength(count);
  expect(f.state.survivors).toEqual(missing === "none" ? ["a", "b", "c"] : ["a", "b"]);
});
for (const policy of ["standard", AUTOSETTLE_POLICY]) test(`one-member ${policy} digest eligibility`, () => {
  const f = fixture(["a"], policy), { step } = toSubmit(f.state);
  expect(step).toMatchObject(policy === "standard" ? { done: true, rc: 2 } : { done: false, need: { kind: "submit" } });
});
for (const team of ["t", ""]) test(`request and outcome-neutral index use the bus team when toTeam=${JSON.stringify(team)}`, () => {
  const f = fixture(["a", "b"], "standard", team), { step } = toSubmit(f.state);
  if (step.done || step.need.kind !== "submit") throw new Error("expected submit");
  expect(step.need.submit).toEqual({ attemptIds: ["a", "b"], preserveDraft: true, digestId: f.state.digestId!,
    members: " a b", sentinel: `[[TAP v0.23 note ${f.state.digestId} digest]]` });
  const index = f.index();
  expect(index.count).toBe(2);
  expect(index.from).toBe("t/courier");
  expect(index.to_team).toBe("t");
  expect(index.items.every((row: { settled?: boolean }) => !row.settled)).toBe(true);
});
for (const rc of [0, 5, 124, 7, 1]) test(`post-submit outcome ${rc} preserves notices, clock and claim ownership`, () => {
  const f = fixture(["a", "b"], AUTOSETTLE_POLICY);
  toSubmit(f.state);
  if (rc !== 1) canonicalize(f);
  let step = digestInjectStep(f.state, { submitRc: rc });
  if (rc === 5 || rc === 124) {
    expect(step).toMatchObject({ done: false, need: { kind: "notify-senders", ids: ["a", "b"] } });
    // Cleanup after yielding to notices cannot delete a successor's claim.
    writeFileSync(join(f.spoolDir, "a.claim"), "successor");
    releaseAll(f.state);
    expect(f.claims()).toEqual(["a.claim"]);
    step = digestInjectStep(f.state, { notified: true });
  }
  expect(step).toMatchObject({ done: true, rc: rc === 7 ? 0 : rc, stampClock: rc === 0 });
  expect(existsSync(f.state.indexPath!)).toBe(rc !== 1);
  if (step.done) expect(step.events.some(e => e.event === "digest_inject_failed")).toBe(rc === 1);
  for (const id of ["a", "b"]) {
    expect(existsSync(join(f.payloadsDir, `${id}.md`))).toBe(rc !== 1);
    expect(existsSync(join(f.spoolDir, `${id}.md`))).toBe(rc === 1);
    expect(existsSync(join(f.receiptsDir, `${id}.harness-queued`))).toBe(rc === 7);
  }
  // The digest id is the queued wire, so only rc 7 records it; no rc writes a premature .sent.
  expect(existsSync(join(f.receiptsDir, `${f.state.digestId}.harness-queued`))).toBe(rc === 7);
  expect(existsSync(join(f.receiptsDir, `${f.state.digestId}.sent`))).toBe(false);
});
for (const policy of ["standard", AUTOSETTLE_POLICY]) test(`rc 7 ${policy} digest: its read completes the digest id's queued delivery`, () => {
  const f = fixture(["a", "b"], policy);
  toSubmit(f.state); canonicalize(f);
  expect(digestInjectStep(f.state, { submitRc: 7 })).toMatchObject({ done: true, rc: 0 });
  const digestId = f.state.digestId!, queued = join(f.receiptsDir, `${digestId}.harness-queued`);
  expect(JSON.parse(readFileSync(queued, "utf8"))).toMatchObject({
    id: digestId, status: "queued", delivery: "harness-queue", from: "t/courier", to: "t/peer", kind: "digest" });
  expect(existsSync(join(f.receiptsDir, `${digestId}.sent`))).toBe(false);
  // Not the addressee: no observation, so nothing completes.
  expect(digestView(["read", f.state.indexPath!, "1", "", "", "--by", "impostor", "--team", "t"], () => 0)).toBe(1);
  expect(existsSync(join(f.receiptsDir, `${digestId}.sent`))).toBe(false);
  expect(digestView(["read", f.state.indexPath!, "1", "", "", "--by", "peer", "--team", "t"], () => 0)).toBe(0);
  expect(JSON.parse(readFileSync(join(f.receiptsDir, `${digestId}.sent`), "utf8"))).toMatchObject({
    id: digestId, status: "sent", via: "harness-queue-read", read_by: "peer", turn: "unconfirmed",
    from: "t/courier", to: "t/peer", kind: "digest" });
});
test("no submit result cannot claim delivery and releases only its own claims", () => {
  const f = fixture(); toSubmit(f.state);
  writeFileSync(join(f.spoolDir, "sibling.claim"), "sibling");
  expect(digestInjectStep(f.state)).toMatchObject({ done: true, rc: 1 });
  expect(f.claims()).toEqual(["sibling.claim"]);
  expect(existsSync(join(f.spoolDir, "a.md"))).toBe(true);
});
test("cancelled is not settled, and missing canonical members leave a rewritten index", () => {
  const f = fixture(["a", "b", "c"], AUTOSETTLE_POLICY); toSubmit(f.state); canonicalize(f);
  writeFileSync(join(f.receiptsDir, "a.cancelled"), "{}");
  writeFileSync(join(f.receiptsDir, "b.done"), "{}");
  writeFileSync(join(f.receiptsDir, "c.done"), "{}");
  rmSync(join(f.payloadsDir, "c.md"));
  expect(digestInjectStep(f.state, { submitRc: 0 })).toMatchObject({ done: true, rc: 0 });
  const index = f.index();
  expect(index.count).toBe(2);
  expect(index.items.map((row: { id: string }) => row.id)).toEqual(["a", "b"]);
  expect(index.items[0].settled).toBeUndefined();
  expect(index.items[1].settled).toBe(true);
  expect(index.injected_at_epoch).toBeGreaterThan(0);
});
for (const expired of [true, false]) test(`draft clobber requires every member expired (${expired})`, () => {
  const f = fixture(["a", "b"], AUTOSETTLE_POLICY);
  for (const id of ["a", "b"]) writeFileSync(join(f.spoolDir, `${id}.meta.json`), JSON.stringify({
    policy: AUTOSETTLE_POLICY, draft_deadline_epoch: id === "b" && !expired ? Date.now() / 1000 + 60 : 1,
  }));
  const { step } = toSubmit(f.state, "busy:pending");
  expect(step).toMatchObject(expired ? { done: false, need: { kind: "submit", submit: { preserveDraft: false } } } : { done: true, rc: 1 });
});
test("wait preserves expired drafts while a clean composer still proceeds", () => {
  const f = fixture(["a"], AUTOSETTLE_POLICY);
  mkdirSync(join(f.home, "config/tap"), { recursive: true });
  writeFileSync(join(f.home, "config/tap/config.toml"), '[injection]\nbehavior="wait"\n');
  writeFileSync(join(f.spoolDir, "a.meta.json"), JSON.stringify({ policy: AUTOSETTLE_POLICY, draft_deadline_epoch: 1 }));
  expect(toSubmit(f.state, "busy:pending").step).toMatchObject({ done: true, rc: 1 });
  expect(f.claims()).toEqual([]);
  expect(toSubmit(initialState(f.state.prefix)).step).toMatchObject({ done: false, need: { kind: "submit" } });
});
