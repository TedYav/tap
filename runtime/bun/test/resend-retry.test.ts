// `tap resend` as the same-id retry (delivery decision-v1 L2-L6): the verb's
// refusals and no-ops. The drain side is in retry-drain.test.ts; the public
// door end to end in smoke resend-same-id.test.sh.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireObligationLock } from "../src/panelock";
import { retryRecords } from "../src/retry";
import { retryRepark } from "../src/spool-repark";
import { removeScratchTree } from "./support/scratch";

const root = resolve(import.meta.dir, "../../.."), scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) removeScratchTree(path); });

function fixture(peer: Record<string, unknown> = { delivery: "pane", status: "active", harness: "codex", pane: "t:0.0", pane_id: "%9", server_epoch: "srv:1:1" }) {
  const dir = mkdtempSync(join(tmpdir(), "tap-resend-retry.")); scratch.push(dir);
  const bus = join(dir, ".tap/bus"), index = join(dir, "index");
  for (const name of ["spool", "payloads", "receipts", "archive"]) mkdirSync(join(bus, name), { recursive: true });
  mkdirSync(index);
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
  writeFileSync(join(bus, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "t", worktree_root: dir }, seats: {
    alice: { delivery: "poll", status: "active", instance: "a", harness: "codex" }, peer,
  } }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, TAP_HOME: bus, TAP_INDEX_HOME: index, TAP_LOCK_DIR: join(dir, "locks"),
    TAP_SESSION_MANIFEST: join(dir, "sessions.json"), TAP_VERSION_SEEN_PATH: join(dir, "seen.json"), OPENCODE_DB_PATH: join(dir, "opencode.db"),
    TAP_SPOOL_DISABLE_OPPORTUNISTIC: "1", TAP_SPOOL_DISABLE_DELIVERER: "1", TAP_SELF: "", TAP_SCRATCH_ONLY: "1" };
  const message = (id: string, extra = "") => {
    writeFileSync(join(bus, "payloads", `${id}.md`), `---\nid: ${id}\nfrom: alice\nto: peer\nkind: discuss\nreply: expected\n${extra}---\nbody ${id}\n`);
    writeFileSync(join(bus, "receipts", `${id}.attempted`), `{"id":"${id}","effect":"possible"}\n`);
  };
  const run = (id: string, by = "alice") => spawnSync(process.execPath, [join(root, "runtime/bun/main.ts"), "resend", id, "--by", by, "--json"],
    { cwd: dir, env, encoding: "utf8", timeout: 20_000 });
  return { dir, bus, env, message, run };
}

for (const [state, receipt, body] of [
  ["settled", "done", { id: "m", via: "reply", by: "peer", at: "2026-10-12T10:00:00Z" }],
  ["cancelled", "cancelled", { id: "m", via: "cancelled", by: "alice" }],
] as const) test(`a ${state} message is a recorded no-op: exit 0, nothing parked`, () => {
  const f = fixture(); f.message("m");
  writeFileSync(join(f.bus, "receipts", `m.${receipt}`), JSON.stringify(body));
  const r = f.run("m");
  expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
  expect(JSON.parse(r.stdout)).toMatchObject({ status: "suppressed", id: "m", state });
  expect(existsSync(join(f.bus, "spool", "m.md"))).toBe(false);
  expect(retryRecords(f.bus, "m").map(row => [row.event, row.prior?.state])).toEqual([["suppressed", state]]);
});

test("an urgent or escalation original queues as ordinary delivery", () => {
  const f = fixture(); f.message("m", "urgency: urgent\n");
  const r = f.run("m");
  expect(r.status, r.stderr).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({ status: "queued", id: "m", ordinal: 1 });
  expect(JSON.parse(readFileSync(join(f.bus, "spool", "m.meta.json"), "utf8"))).toMatchObject({ policy: "standard", reason: "retry" });
});

test("a recipient with no pane is refused before anything is recorded", () => {
  const f = fixture({ delivery: "poll", status: "active", harness: "codex" }); f.message("m");
  const r = f.run("m");
  expect(r.status).toBe(1);
  expect(JSON.parse(r.stdout).error_class).toBe("recipient_unbound");
  expect(existsSync(join(f.bus, "receipts", "m.retries.jsonl"))).toBe(false);
  expect(existsSync(join(f.bus, "payloads", "m.md"))).toBe(true);
});

test("a busy obligation refuses without recording or parking", () => {
  const f = fixture(); f.message("m");
  const previous = process.env.TAP_LOCK_DIR;
  process.env.TAP_LOCK_DIR = f.env.TAP_LOCK_DIR;
  const lock = acquireObligationLock("m");
  try {
    expect(lock).not.toBeNull();
    const r = f.run("m");
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).error_class).toBe("obligation_busy");
  } finally {
    lock?.release();
    if (previous === undefined) delete process.env.TAP_LOCK_DIR; else process.env.TAP_LOCK_DIR = previous;
  }
  expect(existsSync(join(f.bus, "spool", "m.md"))).toBe(false);
  expect(existsSync(join(f.bus, "receipts", "m.retries.jsonl"))).toBe(false);
}, 20_000); // the refused resend waits out the 5 s obligation-lock contention first

for (const canonical of [false, true]) test(`a spent retry with its body ${canonical ? "canonical after failed hold recovery" : "parked"} retires before a fresh retry`, () => {
  const f = fixture(); f.message("m");
  const spent = "00000000-0000-4000-8000-000000000002";
  // A retry that was admitted (license minted) and then refused before any outcome: its row stays parked.
  renameSync(join(f.bus, "payloads", "m.md"), join(f.bus, "spool", "m.md"));
  writeFileSync(join(f.bus, "spool", "m.meta.json"), JSON.stringify({ id: "m", target: "peer", pane: "t:0.0", pane_id: "%9", policy: "standard",
    reason: "retry", retry: spent, retry_ordinal: 1, first_spooled_epoch: 1, deadline_epoch: 9999999999 }));
  writeFileSync(join(f.bus, "receipts", "m.retries.jsonl"),
    JSON.stringify({ v: 1, id: "m", retry: spent, ordinal: 1, event: "request", actor: "alice", trigger: "explicit", at: "2026-10-12T10:00:00.000Z" }) + "\n");
  writeFileSync(join(f.bus, "receipts", `m.retry-${spent}.attempted`), `{"id":"m","retry":"${spent}","effect":"possible"}\n`);
  if (canonical) {
    const path = join(f.bus, "spool", "m.meta.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), repark_pending: true }));
    renameSync(join(f.bus, "spool", "m.md"), join(f.bus, "payloads", "m.md"));
    expect(retryRepark(f.bus, "m", f.env)).toBe("settled");
  }
  const r = f.run("m");
  expect(r.status, r.stderr).toBe(0);
  const out = JSON.parse(r.stdout);
  expect(out).toMatchObject({ status: "queued", ordinal: 2 });
  expect(out.retry).not.toBe(spent);
  expect(retryRecords(f.bus, "m").map(row => [row.event, row.retry === spent ? "spent" : "fresh", row.outcome ?? ""])).toEqual([
    ["request", "spent", ""], ["outcome", "spent", "unknown"], ["request", "fresh", ""]]);
  expect(JSON.parse(readFileSync(join(f.bus, "spool", "m.meta.json"), "utf8"))).toMatchObject({ retry: out.retry, retry_ordinal: 2 });
});

test("a spent original park retires with its evidence and the resend queues a fresh retry", () => {
  const f = fixture(); f.message("m");
  renameSync(join(f.bus, "payloads", "m.md"), join(f.bus, "spool", "m.md"));
  writeFileSync(join(f.bus, "spool", "m.meta.json"), JSON.stringify({ id: "m", target: "peer", pane: "t:0.0", pane_id: "%9", policy: "urgent",
    reason: "no-input-prompt", first_spooled_epoch: 1, deadline_epoch: 9999999999 }));
  const attempted = readFileSync(join(f.bus, "receipts", "m.attempted"), "utf8");
  const r = f.run("m");
  expect(r.status, r.stderr).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({ status: "queued", id: "m", ordinal: 1 });
  expect(JSON.parse(readFileSync(join(f.bus, "spool", "m.meta.json"), "utf8"))).toMatchObject({ reason: "retry", policy: "standard", retry_ordinal: 1 });
  expect(readFileSync(join(f.bus, "receipts", "m.attempted"), "utf8")).toBe(attempted);
});

test("a staged-idle original hold still coalesces: its one Enter is a runnable completion", () => {
  const f = fixture(); f.message("m");
  renameSync(join(f.bus, "payloads", "m.md"), join(f.bus, "spool", "m.md"));
  writeFileSync(join(f.bus, "spool", "m.meta.json"), JSON.stringify({ id: "m", target: "peer", pane: "t:0.0", pane_id: "%9", policy: "standard",
    reason: "staged-idle", first_spooled_epoch: 1, deadline_epoch: 9999999999 }));
  const r = f.run("m");
  expect(r.status, r.stderr).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({ status: "pending" });
  expect(existsSync(join(f.bus, "receipts", "m.retries.jsonl"))).toBe(false);
});

test("a spent row whose body cannot move home is kept whole: the resend refuses and deletes nothing", () => {
  const f = fixture(); f.message("m");
  renameSync(join(f.bus, "payloads", "m.md"), join(f.bus, "spool", "m.md"));
  writeFileSync(join(f.bus, "spool", "m.meta.json"), JSON.stringify({ id: "m", target: "peer", pane: "t:0.0", pane_id: "%9", policy: "standard",
    reason: "no-input-prompt", first_spooled_epoch: 1, deadline_epoch: 9999999999 }));
  mkdirSync(join(f.bus, "payloads", "m.md")); // a conflicting non-file canonical
  const r = f.run("m");
  expect(r.status).toBe(1);
  expect(JSON.parse(r.stdout).error_class).toBe("retire_held");
  expect(readFileSync(join(f.bus, "spool", "m.md"), "utf8")).toContain("body m");
  expect(existsSync(join(f.bus, "spool", "m.meta.json"))).toBe(true);
  expect(existsSync(join(f.bus, "receipts", "m.retries.jsonl"))).toBe(false);
});

test("a recipient handle now held by a different instance is refused: the retry never reaches another seat", () => {
  const f = fixture({ delivery: "pane", status: "active", harness: "codex", pane: "t:0.0", pane_id: "%9", server_epoch: "srv:1:1", instance: "peer-new" });
  f.message("m", "recipient_instance: peer-old\n");
  const r = f.run("m");
  expect(r.status).toBe(1);
  expect(JSON.parse(r.stdout).error_class).toBe("recipient_changed");
  expect(existsSync(join(f.bus, "receipts", "m.retries.jsonl"))).toBe(false);
  expect(existsSync(join(f.bus, "spool", "m.md"))).toBe(false);
});

test("an archived message is a suppressed no-op that writes no active receipt", () => {
  const f = fixture(); f.message("m");
  const month = join(f.bus, "archive", "2026-09");
  mkdirSync(join(month, "payloads"), { recursive: true }); mkdirSync(join(month, "receipts"));
  renameSync(join(f.bus, "payloads", "m.md"), join(month, "payloads", "m.md"));
  renameSync(join(f.bus, "receipts", "m.attempted"), join(month, "receipts", "m.attempted"));
  const sha = createHash("sha256").update(readFileSync(join(month, "payloads", "m.md"))).digest("hex");
  writeFileSync(join(f.bus, "archive", "index.ndjson"), JSON.stringify({ id: "m", month: "2026-09", settled_at: "2026-09-01T00:00:00Z", payload_sha256: sha, receipts: ["m.attempted"] }) + "\n");
  const r = f.run("m");
  expect(r.status, r.stderr).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({ status: "suppressed", id: "m", state: "archived" });
  expect(readdirSync(join(f.bus, "receipts"))).toEqual([]);
  expect(readdirSync(join(f.bus, "spool"))).toEqual([]);
});

test("an id fitting the attempt filename but not the idle license is refused before anything is recorded", () => {
  const f = fixture(); const id = "m" + "x".repeat(200);
  f.message(id);
  const r = f.run(id);
  expect(r.status).toBe(1);
  expect(JSON.parse(r.stdout).error_class).toBe("id_too_long");
  expect(existsSync(join(f.bus, "receipts", `${id}.retries.jsonl`))).toBe(false);
  expect(existsSync(join(f.bus, "payloads", `${id}.md`))).toBe(true);
});

test("a park that fails after publishing its row reports the retry queued, never refused", () => {
  const f = fixture(); f.message("m");
  chmodSync(join(f.bus, "payloads"), 0o500); // the canonical cannot be cleaned up after the spool row is published
  let r;
  try { r = f.run("m"); } finally { chmodSync(join(f.bus, "payloads"), 0o700); }
  expect(r.status, r.stderr).toBe(0);
  // Queued, with the ordinary receipt (and its waiter start), and the park's report on stderr.
  expect(JSON.parse(r.stdout)).toMatchObject({ status: "queued", id: "m", ordinal: 1 });
  expect(r.stderr).toContain("its park reported");
  expect(JSON.parse(readFileSync(join(f.bus, "spool", "m.meta.json"), "utf8"))).toMatchObject({ reason: "retry", retry_ordinal: 1 });
  expect(retryRecords(f.bus, "m").map(row => row.event)).toEqual(["request"]);
});

test("a request interrupted before its park resumes under its own uuid; a spent one gets a new request", () => {
  const f = fixture(); f.message("m");
  const first = "00000000-0000-4000-8000-000000000001";
  writeFileSync(join(f.bus, "receipts", "m.retries.jsonl"),
    JSON.stringify({ v: 1, id: "m", retry: first, ordinal: 1, event: "request", actor: "alice", trigger: "explicit", at: "2026-10-12T10:00:00.000Z" }) + "\n");
  const resumed = f.run("m");
  expect(resumed.status, resumed.stderr).toBe(0);
  expect(JSON.parse(resumed.stdout)).toMatchObject({ status: "queued", retry: first, ordinal: 1 });
  expect(retryRecords(f.bus, "m").map(row => [row.event, row.retry])).toEqual([["request", first]]);

  // The same request whose license was spent (rang, no outcome) is not resumed.
  const g = fixture(); g.message("m");
  writeFileSync(join(g.bus, "receipts", "m.retries.jsonl"),
    JSON.stringify({ v: 1, id: "m", retry: first, ordinal: 1, event: "request", actor: "alice", trigger: "explicit", at: "2026-10-12T10:00:00.000Z" }) + "\n");
  writeFileSync(join(g.bus, "receipts", `m.retry-${first}.attempted`), `{"id":"m","retry":"${first}","effect":"possible"}\n`);
  const fresh = g.run("m");
  expect(fresh.status, fresh.stderr).toBe(0);
  const out = JSON.parse(fresh.stdout);
  expect(out).toMatchObject({ status: "queued", ordinal: 2 });
  expect(out.retry).not.toBe(first);
});
