// spool-park.ts: the park transaction `tap_spool_park_placed` ran between
// taking and releasing the entry's claim, with the incumbent's messages and
// its verdict shape at the adapter boundary (`ok` / `spool_busy` /
// `spool_publish_failed`, always exit 0; exit 1 is the runtime boundary).
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ParkRefusal, main, parkPlaced, type ParkInput } from "../src/spool-park";
import { PublishError } from "../src/spool-publication";
import { metaField } from "../src/spool-sidecar";

const NOW = new Date(1789458203000);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { try { chmodSync(join(root, "payloads"), 0o700); } catch {} rmSync(root, { recursive: true, force: true }); } });

function scratch(): string {
  const r = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "spool-park-")); roots.push(r); return r;
}
function input(work: string, over: Partial<ParkInput> = {}): ParkInput {
  const canonical = join(work, "payloads", "x.md");
  mkdirSync(join(work, "payloads"), { recursive: true });
  if (!existsSync(canonical)) writeFileSync(canonical, "---\nid: x\nfrom: a\nto: peer\nkind: discuss\nreply: expected\n---\nbody\n");
  return {
    spoolDir: join(work, "spool"), home: work, id: "x", canonical, target: "peer", acting: "t", reason: "busy",
    timeoutSeconds: "", pane: "sess:0.0", paneId: "%401", toTeam: "", targetRegistry: "", policy: "standard",
    graceSeconds: "", cueStyle: "", cueRedAt: "",
    env: { PATH: process.env.PATH, HOME: work, XDG_CONFIG_HOME: join(work, "cfg") }, now: NOW, lockTimeoutMs: 1000, ...over,
  };
}
const claimOf = (work: string) => join(work, "spool", "x.claim");

test("a fresh park publishes the pair, retires the canonical copy, releases the claim, and reports the deadline as Python printed it", () => {
  const work = scratch();
  const parked = parkPlaced(input(work));
  expect(parked).toEqual({ payload: join(work, "spool", "x.md"), meta: join(work, "spool", "x.meta.json"), deadlineEpoch: metaField(join(work, "spool"), "x", "deadline_epoch") });
  expect(parked.deadlineEpoch).toMatch(/^\d+(\.\d+)?$/);
  expect(readFileSync(parked.payload, "utf8")).toContain("reply: expected");
  expect(existsSync(join(work, "payloads", "x.md"))).toBe(false); // `rm -f "$CANON"`
  expect(existsSync(claimOf(work))).toBe(false);                    // released
});

test("a live claim is spool_busy: nothing published, canonical retained, the holder's claim untouched", () => {
  const work = scratch();
  mkdirSync(join(work, "spool"), { recursive: true });
  writeFileSync(claimOf(work), '{"v": 1, "id": "x", "owner_pid": 1, "claimed_at_epoch": 0}\n');
  let refusal: ParkRefusal | undefined;
  try { parkPlaced(input(work)); } catch (e) { refusal = e as ParkRefusal; }
  expect(refusal).toBeInstanceOf(ParkRefusal);
  expect([refusal!.klass, refusal!.message]).toEqual(["spool_busy", "spool entry is claimed; canonical payload retained"]);
  expect(existsSync(join(work, "spool", "x.md"))).toBe(false);
  expect(existsSync(join(work, "payloads", "x.md"))).toBe(true);
  expect(readFileSync(claimOf(work), "utf8")).toContain('"owner_pid": 1');
});

test("a refused publication releases the claim and keeps the canonical copy; the publication error line reaches stderr", () => {
  const work = scratch();
  const i = input(work);
  rmSync(i.canonical);
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "../src/spool-park.ts"), "park", i.spoolDir, i.home, i.id, i.canonical, i.target, i.acting, i.reason, "", i.pane, i.paneId, "", "", i.policy, "", "", ""], { env: i.env, stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toBe("spool_publish_failed\nspool publication failed; canonical payload retained\n");
  expect(r.stderr.toString()).toBe(`tap: spool_add: canonical payload not found: ${i.canonical}\n`);
  expect(existsSync(claimOf(work))).toBe(false);
});

// The faults that used to be injected at the writer's process boundary (spool-publication-binding.test.sh,
// when publication was its own process): a sidecar gone after the writer reported success, and a writer
// that fails after leaving a visible sidecar. Both must retain custody: claim released, canonical kept.
test("hook: the sidecar vanishing after publication is 'incomplete' — claim released, canonical retained", () => {
  const work = scratch();
  const i = input(work);
  expect(() => parkPlaced(i, { afterPublish: (_payload, meta) => rmSync(meta) })).toThrow("spool publication is incomplete; canonical payload retained");
  expect([existsSync(claimOf(work)), existsSync(i.canonical), existsSync(join(work, "spool", "x.md"))]).toEqual([false, true, true]);
});

test("hook: a writer failure after a visible sidecar is 'spool publication failed' — the visible file masks nothing", () => {
  const work = scratch();
  const i = input(work);
  expect(() => parkPlaced(i, { afterPublish: (_payload, meta) => { writeFileSync(meta, "{}\n"); throw new PublishError("writer exited 73"); } })).toThrow("spool publication failed; canonical payload retained");
  expect([existsSync(claimOf(work)), existsSync(i.canonical), readFileSync(join(work, "spool", "x.meta.json"), "utf8")]).toEqual([false, true, "{}\n"]);
});

test("a spool that cannot be created is spool_publish_failed before any claim", () => {
  const work = scratch();
  writeFileSync(join(work, "spool"), ""); // a FILE where the directory must go
  expect(() => parkPlaced(input(work))).toThrow("cannot create spool; canonical payload retained");
  expect(existsSync(join(work, "payloads", "x.md"))).toBe(true);
});

test("a canonical copy that cannot be removed is a refusal AFTER publication, claim released, pair kept", () => {
  const work = scratch();
  const i = input(work);
  chmodSync(join(work, "payloads"), 0o500);
  try {
    expect(() => parkPlaced(i)).toThrow("spool published but canonical cleanup failed");
  } finally { chmodSync(join(work, "payloads"), 0o700); }
  expect(existsSync(join(work, "spool", "x.md"))).toBe(true);
  expect(existsSync(join(work, "spool", "x.meta.json"))).toBe(true);
  expect(existsSync(claimOf(work))).toBe(false);
  expect(existsSync(i.canonical)).toBe(true);
});

test("a pristine reset generation is marked reused by the park, first_mutation=spool", () => {
  const work = scratch();
  writeFileSync(join(work, "reset-generation.json"), '{"state": "pristine", "generation": 3}\n');
  parkPlaced(input(work));
  const rec = JSON.parse(readFileSync(join(work, "reset-generation.json"), "utf8"));
  expect([rec.state, rec.first_mutation, rec.generation]).toEqual(["reused", "spool", 3]);
});

test("CLI: ok is four lines; the verdicts are two; a wrong shape is exit 2", () => {
  const work = scratch();
  const i = input(work);
  const argv = ["park", i.spoolDir, i.home, i.id, i.canonical, i.target, i.acting, i.reason, "", i.pane, i.paneId, "", "", i.policy, "", "", ""];
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "../src/spool-park.ts"), ...argv], { env: i.env, stdout: "pipe", stderr: "pipe" });
  expect([r.exitCode, r.stderr.toString()]).toEqual([0, ""]);
  const lines = r.stdout.toString().split("\n");
  expect(lines.slice(0, 3)).toEqual(["ok", join(work, "spool", "x.md"), join(work, "spool", "x.meta.json")]);
  expect(lines[3]).toBe(metaField(join(work, "spool"), "x", "deadline_epoch"));
  expect(lines.length).toBe(5);
  // second park of the same id: the canonical is gone → spool_add refuses → spool_publish_failed, at exit 0
  const again = Bun.spawnSync(["bun", join(import.meta.dir, "../src/spool-park.ts"), ...argv], { env: i.env, stdout: "pipe", stderr: "pipe" });
  expect([again.exitCode, again.stdout.toString()]).toEqual([0, "spool_publish_failed\nspool publication failed; canonical payload retained\n"]);
  expect(main(["park", "only-one"], i.env)).toBe(2);
});
