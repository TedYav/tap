// spool-reown.ts: the `.reown` lease — the throttle on deliverer spawns after
// a re-park. Token match is the only authority; every operation runs under the
// entry's `<meta>.lock` with a bounded wait.
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquirePathLock } from "../src/panelock";
import { main, reownAfterRepark, reownClaim, reownPath, reownRefresh, reownRelease } from "../src/spool-reown";

const NOW = 1789458203;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { try { fs.chmodSync(root, 0o700); } catch {} fs.rmSync(root, { recursive: true, force: true }); } });
function spool(): string { const r = fs.mkdtempSync(join(tmpdir(), "sr-")); roots.push(r); fs.writeFileSync(join(r, "m1.md"), "x"); fs.writeFileSync(join(r, "m1.meta.json"), "{}\n"); return r; }
const env = () => ({ PATH: process.env.PATH, HOME: tmpdir() });

test("claim: mints a 16-hex token atomically; a FRESH lease refuses; a stale one is replaced; no temp remains", () => {
  const dir = spool();
  const token = reownClaim(dir, "m1", "20", NOW, env());
  expect(token).toMatch(/^[0-9a-f]{16}$/);
  expect(fs.readFileSync(reownPath(dir, "m1"), "utf8")).toBe(token!);
  expect(reownClaim(dir, "m1", "20", NOW, env())).toBeNull(); // the lease's mtime is "now": fresh
  const old = new Date((NOW - 21) * 1000); fs.utimesSync(reownPath(dir, "m1"), old, old);
  const next = reownClaim(dir, "m1", "20", NOW, env());
  expect(next).toMatch(/^[0-9a-f]{16}$/);
  expect(next).not.toBe(token);
  expect(fs.readdirSync(dir).filter(n => n.includes(".reown.tmp."))).toEqual([]);
  expect(reownClaim(dir, "m1", "soon", NOW, env())).toBeNull(); // float() raised before the lock
});

test("claim: an ABSENT payload in a readable directory is settled (null); a bounded lock refusal is null with no lease", () => {
  const dir = spool();
  fs.unlinkSync(join(dir, "m1.md"));
  expect(reownClaim(dir, "m1", "20", NOW, env())).toBeNull();
  expect(fs.existsSync(reownPath(dir, "m1"))).toBe(false);
  fs.writeFileSync(join(dir, "m1.md"), "x");
  const held = acquirePathLock(`${join(dir, "m1.meta.json")}.lock`, 5000, env());
  try {
    expect(reownClaim(dir, "m1", "20", NOW, env())).toBeNull(); // after METADATA_LOCK_TIMEOUT_MS
    expect(fs.existsSync(reownPath(dir, "m1"))).toBe(false);
  } finally { held!.release(); }
}, 15000);

// Ported from the retired-in-part smoke/courier-busy-hold.test.sh arm (21)
// row 1: a claim that had to WAIT on the meta lock must recheck the payload
// under that lock, or it mints authority for an entry terminalized while it
// waited. A helper process holds the lock, signals, and terminalizes only
// after the claimer is provably inside the flock; the claim's result and the
// outer after-repark check must both stay empty.
test("claim: an entry terminalized under the lock mints nothing; after-repark spawns nothing", async () => {
  const dir = spool();
  const lock = `${join(dir, "m1.meta.json")}.lock`;
  const held = join(dir, "held"), go = join(dir, "go"), entered = join(dir, "entered"), blocked = join(dir, "blocked-on-lock"), result = join(dir, "claimed");
  const src = join(import.meta.dir, "../src");
  const until = async (path: string) => {
    for (const deadline = Date.now() + 10_000; !fs.existsSync(path);) {
      if (Date.now() >= deadline) throw new Error(`missing handshake ${path}`);
      await Bun.sleep(10);
    }
  };
  const helper = Bun.spawn([process.execPath, "-e", `
    import { acquirePathLock } from ${JSON.stringify(join(src, "panelock.ts"))};
    import * as fs from "node:fs";
    const l = acquirePathLock(${JSON.stringify(lock)}, 10_000, {});
    fs.writeFileSync(${JSON.stringify(held)}, "1");
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(${JSON.stringify(go)}) && Date.now() < deadline) await Bun.sleep(10);
    for (const p of ["m1.md", "m1.meta.json", "m1.meta.json.reown"]) {
      try { fs.unlinkSync(${JSON.stringify(dir)} + "/" + p); } catch {}
    }
    l!.release();
  `], { stdout: "ignore", stderr: "inherit" });
  let claimer: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await until(held); // the shell arm's ordering: the holder is proven first, so the claimer must wait
    claimer = Bun.spawn([process.execPath, "-e", `
    import * as fs from "node:fs";
    import { acquirePathLock } from ${JSON.stringify(join(src, "panelock.ts"))};
    import { reownClaim } from ${JSON.stringify(join(src, "spool-reown.ts"))};
    fs.writeFileSync(${JSON.stringify(entered)}, "1");
    // Prove the claimer is AT the lock while the helper holds it: a nonblocking
    // acquisition must fail before reownClaim ever runs, so the deletion below
    // can only race a claimer that is blocked inside the flock.
    if (acquirePathLock(${JSON.stringify(lock)}, 0, {}) !== null) process.exit(9);
    fs.writeFileSync(${JSON.stringify(blocked)}, "1");
    const t = reownClaim(${JSON.stringify(dir)}, "m1", "20", ${NOW}, { PATH: process.env.PATH });
    fs.writeFileSync(${JSON.stringify(result)}, t ?? "");
  `], { stdout: "ignore", stderr: "inherit" });
    await until(entered);
    await until(blocked); // deletion waits for proof, not for a hope-sleep
    fs.writeFileSync(go, "1");
  } finally {
    await helper.exited;
    await claimer?.exited;
  }
  expect(fs.readFileSync(result, "utf8")).toBe("");
  expect(fs.existsSync(reownPath(dir, "m1"))).toBe(false);
  expect(reownAfterRepark(dir, "m1", "20", NOW, env())).toBeNull();
}, 15_000);

test("a lock name the filesystem cannot hold: claim, refresh and release refuse at once", () => {
  const dir = spool();
  const id = "y".repeat(245);
  fs.writeFileSync(join(dir, `${id}.md`), "x"); fs.writeFileSync(join(dir, `${id}.meta.json`), "{}\n");
  const t0 = Date.now();
  expect(reownClaim(dir, id, "20", NOW, env())).toBeNull();
  expect(reownRefresh(dir, id, "deadbeefdeadbeef", NOW, env())).toBe(false);
  reownRelease(dir, id, "deadbeefdeadbeef", env());
  expect(Date.now() - t0).toBeLessThan(2000);
});

test("refresh touches the lease only on token match (pyStrip'd); release unlinks only on match and never fails", () => {
  const dir = spool();
  const token = reownClaim(dir, "m1", "20", NOW, env())!;
  const old = new Date((NOW - 10) * 1000); fs.utimesSync(reownPath(dir, "m1"), old, old);
  expect(reownRefresh(dir, "m1", "deadbeefdeadbeef", NOW, env())).toBe(false);
  expect(Math.floor(fs.statSync(reownPath(dir, "m1")).mtimeMs / 1000)).toBe(NOW - 10);
  expect(reownRefresh(dir, "m1", token, NOW, env())).toBe(true);
  expect(Math.floor(fs.statSync(reownPath(dir, "m1")).mtimeMs / 1000)).toBe(NOW);
  fs.writeFileSync(reownPath(dir, "m1"), `${token}\n \t`); // a trailing newline reads as the same token
  expect(reownRefresh(dir, "m1", token, NOW, env())).toBe(true);
  expect(reownRefresh(dir, "m1", "", NOW, env())).toBe(false);
  reownRelease(dir, "m1", "deadbeefdeadbeef", env());
  expect(fs.existsSync(reownPath(dir, "m1"))).toBe(true); // a successor's authority stands
  reownRelease(dir, "m1", token, env());
  expect(fs.existsSync(reownPath(dir, "m1"))).toBe(false);
  reownRelease(dir, "m1", token, env()); // already gone: no-op
  reownRelease(dir, "absent", token, env());
});

test("afterRepark: absent payload + readable directory is nothing to spawn; unreadable directory is UNKNOWN and mints; present mints", () => {
  const dir = spool();
  expect(reownAfterRepark(dir, "m1", "20", NOW, env())).toMatch(/^[0-9a-f]{16}$/);
  fs.unlinkSync(join(dir, "m1.md")); fs.unlinkSync(reownPath(dir, "m1"));
  expect(reownAfterRepark(dir, "m1", "20", NOW, env())).toBeNull();
  const nested = join(dir, "inner"); fs.mkdirSync(nested); fs.writeFileSync(join(nested, "m1.meta.json"), "{}\n");
  fs.chmodSync(nested, 0o300); // writable+searchable, NOT readable: existsSync says no, access(R_OK) says no
  try {
    const token = reownAfterRepark(nested, "m1", "20", NOW, env());
    expect(token === null || /^[0-9a-f]{16}$/.test(token)).toBe(true);
    // root ignores the mode bits; a non-root run must mint on UNKNOWN
    if (process.getuid && process.getuid() !== 0) expect(token).toMatch(/^[0-9a-f]{16}$/);
  } finally { fs.chmodSync(nested, 0o700); }
});

test("CLI: every decided outcome is a verdict at exit 0 — a token or nothing, refreshed|superseded; TAP_SPOOL_NOW pins the clock", () => {
  const dir = spool();
  const cli = join(import.meta.dir, "../src/spool-reown.ts");
  const run = (args: string[], extra: Record<string, string> = {}) => {
    const r = Bun.spawnSync(["bun", cli, ...args], { stdout: "pipe", stderr: "pipe", env: { ...env(), ...extra } });
    return { rc: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const first = run(["claim", dir, "m1", "20"]);
  expect([first.rc, first.err]).toEqual([0, ""]);
  expect(first.out).toMatch(/^[0-9a-f]{16}$/);
  // Every decided outcome is a verdict at exit 0: nothing printed = not claimed (the adapter turns that into rc 1).
  expect(run(["claim", dir, "m1", "20"])).toEqual({ rc: 0, out: "", err: "" }); // fresh
  // The lease's mtime is the wall clock; TAP_SPOOL_NOW pins the "now" it is compared against.
  const future = String(Math.floor(Date.now() / 1000) + 21);
  const stale = run(["claim", dir, "m1", "20"], { TAP_SPOOL_NOW: future });
  expect([stale.rc, /^[0-9a-f]{16}$/.test(stale.out)]).toEqual([0, true]); // stale under the pinned clock
  expect(run(["refresh", dir, "m1", "nope"])).toEqual({ rc: 0, out: "superseded", err: "" });
  expect(run(["refresh", dir, "m1", stale.out])).toEqual({ rc: 0, out: "refreshed", err: "" });
  expect(run(["release", dir, "m1", "nope"])).toEqual({ rc: 0, out: "", err: "" });
  expect(run(["after-repark", dir, "m1", "20"])).toEqual({ rc: 0, out: "", err: "" }); // fresh lease just minted: nothing to spawn
  expect(main(["nope"], env())).toBe(1);
});
