import { installSpoolPane } from "./support/spool-pane";
import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireObligationLock, acquirePathLock } from "../src/panelock";

const source = join(import.meta.dir, "../../..");
async function until(predicate: () => boolean, message: string, detail: () => string = () => "") {
  const deadline = Date.now() + 10000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(20);
  expect(predicate(), `${message}\n${detail()}`).toBe(true);
}
function processes(): Map<number, { parent: number; born: string; command: string }> {
  const p = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,lstart=,args="]);
  if (p.exitCode !== 0) throw new Error("cannot inspect fixture child exit");
  const rows = new Map<number, { parent: number; born: string; command: string }>();
  for (const line of p.stdout.toString().split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/.exec(line);
    if (match) rows.set(Number(match[1]), { parent: Number(match[2]), born: match[3]!, command: match[4]! });
  }
  return rows;
}

for (const entry of ["run", "tick"] as const) for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL"] as const)
test(`real watch ${entry} ${signal}: reap the blocked spool chain before any later policy or mutation`, async () => {
  const root = mkdtempSync(join(tmpdir(), "watch-spool-stop-"));
  const src = join(root, "runtime/bun/src"), scripts = join(root, "skills/tap/scripts"), repo = join(root, "repo");
  cpSync(join(source, "runtime/bun/src"), src, { recursive: true });
  cpSync(join(source, "skills/tap/scripts"), scripts, { recursive: true });
  const bus = join(repo, ".tap/bus"), spool = join(bus, "spool"), arm = join(bus, "watch/arm.json");
  for (const path of [spool, join(bus, "payloads"), join(bus, "receipts"), join(bus, "watch"), join(root, "index")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(root, "index", "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} })); // born live (F1)
  const registry = join(bus, "registry.json"), meta = join(spool, "a.meta.json");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture", worktree_root: repo }, seats: {} }));
  writeFileSync(join(bus, ".tap-bus-authority"), "");
  writeFileSync(arm, JSON.stringify({ mode: "supervision", armed_at: 1000, armed_by: "lead", tick_interval_seconds: 1,
    threshold_seconds: 1, queued_probe_id: "later-probe", queued_probe_seat: "peer", probe_timeout_seconds: 1,
    current_rung: 0, probed_seats: [], tinted_panes: ["retain-until-spool-completes"] }));
  writeFileSync(join(spool, "a.md"), "---\nid: a\nfrom: sender\nto: peer\nkind: discuss\nreply: expected\n---\nbody\n");
  writeFileSync(meta, JSON.stringify({ id: "a", target: "peer", target_registry: registry, to_team: "fixture", pane: "fixture:0.0",
    pane_id: "%401", policy: "standard", first_spooled_epoch: 1, deadline_epoch: 9999999999 }));
  const barrier = join(root, "submit");
  const env = { ...process.env, TAP_HOME: bus, TAP_INDEX_HOME: join(root, "index"), TAP_SPOOL_DISABLE_DELIVERER: "1", SUBMIT_BARRIER: barrier };
  installSpoolPane(root, registry, env, "codex", false, undefined, true);
  let held: ReturnType<typeof acquirePathLock> = null;
  const child = Bun.spawn([process.execPath, join(src, entry === "run" ? "watch-run.ts" : "watch-tick-run.ts"), entry],
    { env, cwd: repo, detached: true, stdout: "pipe", stderr: "pipe" });
  let out = "", err = "", released = false;
  const output = new Response(child.stdout).text().then(text => { out = text; });
  const errors = new Response(child.stderr).text().then(text => { err = text; });
  try {
    // Park in post-submit metadata cleanup: take the lock at the submit barrier,
    // after the pre-submit write-ahead mark (tap-c9vlf), which needs the same lock.
    await until(() => existsSync(`${barrier}.reached`), "watch never reached the pane submit", () => `${out}\n${err}`);
    held = acquirePathLock(`${meta}.lock`, 1000, env);
    expect(held).not.toBeNull();
    writeFileSync(`${barrier}.release`, "");
    await until(() => existsSync(join(bus, "receipts/a.sent")), "watch did not reach the real metadata wait", () => `${out}\n${err}`);
    const resetLock = acquirePathLock(join(bus, "reset.fence.json.lock"), 0, env);
    resetLock?.release();
    expect(resetLock, "native metadata cleanup must still own reset custody").toBeNull();
    await Bun.sleep(100);
    expect(existsSync(meta), "removal must still be blocked when interrupted").toBe(true);
    expect(existsSync(join(spool, "a.claim")), "Phase B owns its actual claim at the barrier").toBe(true);
    const blockedArm = readFileSync(arm);
    const all = processes(), owned = new Map<number, string>();
    let parents = new Set([child.pid]);
    while (parents.size) {
      const next = new Set<number>();
      for (const [pid, row] of all) if (parents.has(row.parent) && !owned.has(pid)) { owned.set(pid, row.born); next.add(pid); }
      parents = next;
    }
    // The native worker replaced the shell submit/removal children. Pin the
    // live ownership chain, then require every recorded descendant to exit.
    const commands = [...owned.keys()].map(pid => all.get(pid)!.command);
    expect(commands.some(cmd => cmd.includes("spool-engine.ts") && !cmd.includes(" --worker "))).toBe(true);
    expect(commands.some(cmd => cmd.includes("spool-engine.ts") && cmd.includes(" --worker "))).toBe(true);
    if (entry === "run") expect(commands.some(cmd => cmd.includes("watch-tick-run.ts"))).toBe(true);
    child.kill(signal);
    const code = await child.exited;
    await Promise.all([output, errors]);
    if (signal !== "SIGKILL") expect(code, err).toBe(0);
    // Inspection of the exact birth records is evidence only; termination uses
    // the owned child handles/pipes, never a PID recovered from this census.
    await until(() => {
      const current = processes();
      return [...owned].every(([pid, born]) => current.get(pid)?.born !== born);
    }, "a recorded foreground child/grandchild survived", () => {
      const current = processes();
      return err + [...owned].filter(([pid, born]) => current.get(pid)?.born === born)
        .map(([pid]) => `${pid}: ${current.get(pid)?.command}`).join("\n");
    });
    const obligation = acquireObligationLock("a", 0, env);
    expect(obligation, "the actual obligation lock must be released").not.toBeNull();
    obligation?.release();
    held!.release(); released = true;
    await Bun.sleep(400);
    expect(existsSync(meta), "late metadata cleanup after watcher exit").toBe(true);
    expect(readFileSync(arm)).toEqual(blockedArm);
    expect(existsSync(join(spool, "later-probe.claim"))).toBe(false);
    expect(existsSync(join(bus, "payloads/a.md"))).toBe(true);
    expect(existsSync(join(bus, "receipts/a.attempted"))).toBe(true);
  } finally {
    writeFileSync(`${barrier}.release`, "");
    if (!released) held?.release();
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
    await Promise.all([output, errors]);
    await Bun.sleep(300);
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
