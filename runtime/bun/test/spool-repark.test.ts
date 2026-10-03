import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireObligationLock, acquirePathLock } from "../src/panelock";
import { markReparkPending, recoverStrandedReparks, reparkStranded, retryRepark } from "../src/spool-repark";
import { reapStaleSidecars } from "../src/spool-sidecar";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function stranded(id = "m") {
  const home = mkdtempSync(join(tmpdir(), "repark-")); roots.push(home);
  for (const dir of ["spool", "payloads", "receipts", "locks"]) mkdirSync(join(home, dir));
  const env = { ...process.env, TAP_HOME: home, TAP_LOCK_DIR: join(home, "locks") };
  writeFileSync(join(home, "spool", `${id}.meta.json`), JSON.stringify({ id, target: "peer" }));
  writeFileSync(join(home, "payloads", `${id}.md`), "body\n");
  expect(markReparkPending(join(home, "spool"), id, env)).toBe(true);
  const meta = () => JSON.parse(readFileSync(join(home, "spool", `${id}.meta.json`), "utf8"));
  return { home, env, meta, spoolBody: join(home, "spool", `${id}.md`), canon: join(home, "payloads", `${id}.md`) };
}

test("the recorded repark moves the body back and clears its mark", () => {
  const s = stranded();
  expect(reparkStranded(join(s.home, "spool"), "m")).toBe(true);
  expect(retryRepark(s.home, "m", s.env, 1000)).toBe("reparked");
  expect(existsSync(s.spoolBody)).toBe(true);
  expect(existsSync(s.canon)).toBe(false);
  expect(s.meta().repark_pending).toBeUndefined();
  expect(s.meta().target).toBe("peer");
  expect(reparkStranded(join(s.home, "spool"), "m")).toBe(false);
});

test("settlement holds the obligation lock: a retry during it is busy, and after it moves nothing", () => {
  const s = stranded();
  const settling = acquireObligationLock("m", 0, s.env);
  expect(settling).not.toBeNull();
  try {
    expect(retryRepark(s.home, "m", s.env, 1000)).toBe("busy");
    writeFileSync(join(s.home, "receipts", "m.done"), "{}");
  } finally { settling!.release(); }
  expect(retryRepark(s.home, "m", s.env, 1000)).toBe("settled");
  expect(existsSync(s.spoolBody)).toBe(false);
  expect(existsSync(s.canon)).toBe(true);
  expect(s.meta().repark_pending).toBeUndefined();
});

test("reset custody held is busy, and the mark and body stay for the next retry", () => {
  const s = stranded();
  const held = acquirePathLock(join(s.home, "reset.fence.json.lock"), 0)!;
  try { expect(retryRepark(s.home, "m", s.env, 1000)).toBe("busy"); } finally { held.release(); }
  expect(s.meta().repark_pending).toBeTruthy();
  expect(existsSync(s.canon)).toBe(true);
});

test("attempt evidence refuses the recorded repark: a possibly-attempted body is never moved back", () => {
  const s = stranded();
  writeFileSync(join(s.home, "receipts", "m.attempted"), "{}");
  // Still stranded: the flow must run so the mark is consumed and the verdict is
  // settled — only the MOVE is refused, which is reparkLicensed's call, not this one.
  expect(reparkStranded(join(s.home, "spool"), "m")).toBe(true);
  expect(retryRepark(s.home, "m", s.env, 1000)).not.toBe("reparked");
  expect(existsSync(s.spoolBody)).toBe(false);
  expect(existsSync(s.canon)).toBe(true);
  expect(reparkStranded(join(s.home, "spool"), "m")).toBe(false);
});

test("a stale mark on a spool-resident body is inert and consumed, never a license", () => {
  const s = stranded();
  // The move-then-clear kill window: the body is already back in spool/, mark still present.
  renameSync(s.canon, s.spoolBody);
  expect(reparkStranded(join(s.home, "spool"), "m")).toBe(false);
  expect(retryRepark(s.home, "m", s.env, 1000)).toBe("settled");
  expect(existsSync(s.spoolBody)).toBe(true);
  expect(existsSync(s.canon)).toBe(false);
  expect(s.meta().repark_pending).toBeUndefined();
});

test("the recovery driver reparks a licensed stranded entry; attempt evidence is left to the sweep", () => {
  const s = stranded();
  recoverStrandedReparks(join(s.home, "spool"), join(s.home, "payloads"), s.env);
  expect(existsSync(s.spoolBody)).toBe(true);
  expect(existsSync(s.canon)).toBe(false);
  expect(s.meta().repark_pending).toBeUndefined();
  const a = stranded();
  writeFileSync(join(a.home, "receipts", "m.attempted"), "{}");
  recoverStrandedReparks(join(a.home, "spool"), join(a.home, "payloads"), a.env);
  expect(existsSync(a.spoolBody)).toBe(false);
  expect(existsSync(a.canon)).toBe(true);
  expect(a.meta().repark_pending).toBeTruthy();
  reapStaleSidecars(join(a.home, "spool"), join(a.home, "payloads"), a.env);
  expect(JSON.parse(readFileSync(join(a.home, "receipts", "m.unconfirmed"), "utf8")).effect).toBe("possible");
  expect(existsSync(join(a.home, "spool", "m.meta.json"))).toBe(false);
});

test("recovery run twice moves the body once: a reparked entry is no longer a candidate", () => {
  const s = stranded();
  const spool = join(s.home, "spool"), payloads = join(s.home, "payloads");
  recoverStrandedReparks(spool, payloads, s.env);
  expect(existsSync(s.spoolBody)).toBe(true);
  expect(existsSync(s.canon)).toBe(false);
  expect(s.meta().repark_pending).toBeUndefined();
  writeFileSync(s.spoolBody, "sentinel\n");
  recoverStrandedReparks(spool, payloads, s.env);
  expect(readFileSync(s.spoolBody, "utf8")).toBe("sentinel\n");
  expect(existsSync(s.canon)).toBe(false);
  expect(s.meta().repark_pending).toBeUndefined();
  expect(readdirSync(join(s.home, "receipts"))).toEqual([]);
});

test("a move that cannot land keeps the mark and reports busy, never consuming the license", () => {
  const s = stranded();
  // An unlandable rename target: spool/m.md as a non-empty directory fails the
  // rename the way a denied payloads/ removal would, after the license passed.
  mkdirSync(s.spoolBody); writeFileSync(join(s.spoolBody, "obstruction"), "x");
  try {
    expect(retryRepark(s.home, "m", s.env, 1000)).toBe("busy");
    expect(s.meta().repark_pending).toBeTruthy();
    expect(existsSync(s.canon)).toBe(true);
  } finally { rmSync(s.spoolBody, { recursive: true }); }
  expect(retryRepark(s.home, "m", s.env, 1000)).toBe("reparked");
  expect(existsSync(s.spoolBody)).toBe(true);
  expect(existsSync(s.canon)).toBe(false);
  expect(s.meta().repark_pending).toBeUndefined();
});

test("a SIGKILL-residual claim does not block the recovery driver", () => {
  const s = stranded();
  // drainOnce releases its claim in a finally a SIGKILL never runs; the residual
  // with a provably dead owner (reaped child, ESRCH) is the crash shape and is
  // not ownership.
  const dead = Bun.spawnSync(["true"]).pid;
  writeFileSync(join(s.home, "spool", "m.claim"),
    `${JSON.stringify({ v: 1, id: "m", owner_pid: dead, claimed_at_epoch: Date.now() / 1000 })}\n`);
  recoverStrandedReparks(join(s.home, "spool"), join(s.home, "payloads"), s.env);
  expect(existsSync(s.spoolBody)).toBe(true);
  expect(existsSync(s.canon)).toBe(false);
  expect(s.meta().repark_pending).toBeUndefined();
});

test("a live or unreadable claim blocks the recovery driver", () => {
  const s = stranded();
  // The deadline flows claim the id and terminalize promotes the body on that
  // claim alone (no obligation lock, shared custody only): recovery must not
  // race a live holder, and a claim too broken to prove an owner stays with
  // the stale-claim reap.
  writeFileSync(join(s.home, "spool", "m.claim"),
    `${JSON.stringify({ v: 1, id: "m", owner_pid: process.pid, claimed_at_epoch: Date.now() / 1000 })}\n`);
  recoverStrandedReparks(join(s.home, "spool"), join(s.home, "payloads"), s.env);
  expect(existsSync(s.canon)).toBe(true);
  expect(existsSync(s.spoolBody)).toBe(false);
  expect(s.meta().repark_pending).toBeTruthy();
  rmSync(join(s.home, "spool", "m.claim"));
  writeFileSync(join(s.home, "spool", "m.claim"), "");
  recoverStrandedReparks(join(s.home, "spool"), join(s.home, "payloads"), s.env);
  expect(existsSync(s.canon)).toBe(true);
  expect(existsSync(s.spoolBody)).toBe(false);
  expect(s.meta().repark_pending).toBeTruthy();
});

test("recovery yields to a live drain: the obligation lock is the serialization point", () => {
  const s = stranded();
  const lock = acquireObligationLock("m", 0, s.env);
  expect(lock).not.toBeNull();
  const started = Date.now();
  recoverStrandedReparks(join(s.home, "spool"), join(s.home, "payloads"), s.env);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(existsSync(s.canon)).toBe(true);
  expect(existsSync(s.spoolBody)).toBe(false);
  expect(s.meta().repark_pending).toBeTruthy();
  lock!.release();
});

test("an unmarked entry is never moved: a refused post-submit leaves the same files", () => {
  const s = stranded();
  writeFileSync(join(s.home, "spool", "m.meta.json"), JSON.stringify({ id: "m", target: "peer" }));
  expect(reparkStranded(join(s.home, "spool"), "m")).toBe(false);
  expect(retryRepark(s.home, "m", s.env, 1000)).toBe("settled");
  expect(existsSync(s.canon)).toBe(true);
  expect(existsSync(s.spoolBody)).toBe(false);
});
