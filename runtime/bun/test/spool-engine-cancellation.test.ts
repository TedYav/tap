import { installSpoolPane } from "./support/spool-pane";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireObligationLock, acquirePathLock } from "../src/panelock";

const source = join(import.meta.dir, "../../..");
const quoted = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
async function until(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 8000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(20);
  expect(predicate(), message).toBe(true);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL"] as const) test(`caller ${signal} stops a real redelivery blocked in metadata cleanup`, async () => {
  const home = mkdtempSync(join(tmpdir(), "spool-cancel-"));
  const scripts = join(home, "skills/tap/scripts"), spool = join(home, "bus/spool"), bus = join(home, "bus");
  for (const path of [scripts, spool, join(bus, "payloads"), join(bus, "receipts"), join(home, "index")]) mkdirSync(path, { recursive: true });
  symlinkSync(join(source, "runtime"), join(home, "runtime"));
  mkdirSync(join(scripts, "smoke"), { recursive: true });
  writeFileSync(join(scripts, "smoke/runtime-helpers.sh"), [
    `. ${quoted(join(source, "skills/tap/scripts/smoke/runtime-helpers.sh"))}`,
  ].join("\n") + "\n");
  const registry = join(bus, "registry.json"), meta = join(spool, "a.meta.json");
  writeFileSync(registry, '{"schema":"0.20","team":{"name":"fixture"},"seats":{}}');
  writeFileSync(join(bus, ".tap-bus-authority"), "");
  writeFileSync(join(spool, "a.md"), "---\nid: a\nfrom: sender\nto: peer\nkind: discuss\nreply: expected\n---\nbody\n");
  writeFileSync(meta, JSON.stringify({ id: "a", target: "peer", target_registry: registry, to_team: "fixture", pane: "fixture:0.0", pane_id: "%401", policy: "standard" }));
  const barrier = join(home, "submit");
  const env = { ...process.env, TAP_HOME: bus, TAP_INDEX_HOME: join(home, "index"), TAP_SPOOL_DISABLE_DELIVERER: "1", SUBMIT_BARRIER: barrier };
  installSpoolPane(home, registry, env, "codex", false, undefined, true);
  let held: ReturnType<typeof acquirePathLock> = null;
  const caller = join(home, "caller.ts");
  writeFileSync(caller, `import {writeFileSync} from "node:fs";
const child=Bun.spawn([${JSON.stringify(process.execPath)},${JSON.stringify(join(source,"runtime/bun/src/spool-engine.ts"))},${JSON.stringify(scripts)},"redeliver","a","peer","fixture:0.0","%401","fixture",${JSON.stringify(registry)}],{detached:true,stdout:"inherit",stderr:"inherit"});
writeFileSync(${JSON.stringify(join(home,"engine-pid"))},String(child.pid));
await child.exited;`);
  const parent = Bun.spawn([process.execPath, caller], { env, detached: true, stdout: "ignore", stderr: "pipe" });
  let enginePid: number | undefined, released = false;
  try {
    await until(() => existsSync(join(home, "engine-pid")), "caller did not start the native engine");
    enginePid = Number(readFileSync(join(home, "engine-pid"), "utf8"));
    // Park in post-submit metadata cleanup: take the lock at the submit barrier,
    // after the pre-submit write-ahead mark (tap-c9vlf), which needs the same lock.
    await until(() => existsSync(`${barrier}.reached`), "redelivery never reached the pane submit");
    held = acquirePathLock(`${meta}.lock`, 0, env);
    expect(held).not.toBeNull();
    writeFileSync(`${barrier}.release`, "");
    await until(() => existsSync(join(bus, "receipts/a.sent")), "submit did not reach real metadata-lock cleanup");
    expect(existsSync(meta)).toBe(true);
    expect(existsSync(join(bus, "payloads/a.md"))).toBe(true);
    expect(acquireObligationLock("a", 0, env)).toBeNull();
    parent.kill(signal);
    await parent.exited;
    let free = false;
    await until(() => {
      const lock = acquireObligationLock("a", 0, env);
      if (lock) { lock.release(); free = true; }
      return free;
    }, "orphaned drain retained its obligation lock");
    held!.release(); released = true;
    await Bun.sleep(400);
    // If the detached cleanup child survived, releasing the lock above lets it
    // remove this file. A retained canonical alone would not expose that leak.
    expect(existsSync(meta), "a late mutator removed metadata after caller death").toBe(true);
    expect(existsSync(join(bus, "payloads/a.md"))).toBe(true);
    expect(existsSync(join(bus, "receipts/a.attempted"))).toBe(true);
  } finally {
    writeFileSync(`${barrier}.release`, "");
    if (!released) held?.release();
    if (enginePid) { try { process.kill(-enginePid, "SIGTERM"); } catch { /* exited */ } }
    if (parent.exitCode === null) parent.kill("SIGKILL");
    await parent.exited;
    await Bun.sleep(300);
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

for (const signal of ["SIGTERM", "SIGKILL"] as const) test(`caller ${signal} during digest paste retains all member attempt evidence and has no late mutator`, async () => {
  const root = mkdtempSync(join(tmpdir(), "digest-cancel-"));
  const home = join(root, "bus"), spool = join(home, "spool"), registry = join(home, "registry.json");
  for (const path of [spool, join(home, "payloads"), join(home, "receipts")]) mkdirSync(path, { recursive: true });
  writeFileSync(registry, '{"schema":"0.20","team":{"name":"fixture"},"seats":{}}');
  writeFileSync(join(home, ".tap-bus-authority"), "");
  for (const id of ["a", "b"]) {
    writeFileSync(join(spool, `${id}.md`), `---\nid: ${id}\nfrom: sender\nto: peer\nkind: discuss\nreply: expected\n---\nbody\n`);
    writeFileSync(join(spool, `${id}.meta.json`), JSON.stringify({ id, target: "peer", target_registry: registry,
      to_team: "fixture", pane: "fixture:0.0", pane_id: "%401", policy: "standard" }));
  }
  const barrier = join(root, "paste"), pidPath = join(root, "engine-pid");
  const env = { ...process.env, TAP_HOME: home, TAP_INDEX_HOME: join(root, "index"), TAP_SPOOL_DISABLE_DELIVERER: "1", SUBMIT_BARRIER: barrier };
  installSpoolPane(root, registry, env, "codex", false, undefined, true);
  const args = [process.execPath, join(source, "runtime/bun/src/spool-engine.ts"), join(source, "skills/tap/scripts"),
    "digest", registry, "fixture", "peer", "fixture:0.0", "%401", "a", "b"];
  const caller = join(root, "caller.ts");
  writeFileSync(caller, `import {writeFileSync} from "node:fs";
const child=Bun.spawn(${JSON.stringify(args)},{detached:true,stdout:"inherit",stderr:"inherit"});
writeFileSync(${JSON.stringify(pidPath)},String(child.pid)); await child.exited;`);
  const parent = Bun.spawn([process.execPath, caller], { env, detached: true, stdout: "ignore", stderr: "pipe" });
  let enginePid = 0;
  try {
    await until(() => existsSync(`${barrier}.reached`), "digest never reached real pane paste");
    enginePid = Number(readFileSync(pidPath, "utf8"));
    for (const id of ["a", "b"]) expect(existsSync(join(home, "receipts", `${id}.attempted`))).toBe(true);
    parent.kill(signal); await parent.exited;
    await until(() => { try { process.kill(enginePid, 0); return false; } catch { return true; } }, "digest supervisor survived its caller");
    const snapshot = () => ["a", "b"].map(id => [spool, join(home, "payloads")].map(dir => existsSync(join(dir, `${id}.md`))));
    const after = snapshot();
    writeFileSync(`${barrier}.release`, "");
    await Bun.sleep(400);
    expect(snapshot()).toEqual(after);
    for (const copies of after) expect(copies.some(Boolean)).toBe(true);
    const effect = readFileSync(join(root, "effects"), "utf8");
    const retry = Bun.spawn(args, { env, stdout: "ignore", stderr: "ignore" }); await retry.exited;
    expect(readFileSync(join(root, "effects"), "utf8")).toBe(effect);
    for (const id of ["a", "b"]) expect(existsSync(join(home, "receipts", `${id}.attempted`))).toBe(true);
  } finally {
    writeFileSync(`${barrier}.release`, "");
    if (enginePid) { try { process.kill(-enginePid, "SIGTERM"); } catch { /* exited */ } }
    if (parent.exitCode === null) parent.kill("SIGKILL");
    await parent.exited; await Bun.sleep(300);
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
