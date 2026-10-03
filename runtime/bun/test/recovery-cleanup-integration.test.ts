import { expect, test, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, copyFileSync, symlinkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveContext } from "../src/context";
import { observePaneResult } from "../src/tmux";
import { cleanupIO, cleanupRecoveryCrew, tapCommand, type OwnedCrew } from "../src/recovery/crew";
import { submitVerify } from "../src/courier";
import { redeliver } from "../src/spool-drain-effects";
import type { DrainContext } from "../src/spool-drain";
import { deliver } from "../src/deliver";
import * as paneLocks from "../src/panelock";
import { waitWorkerReply } from "../src/recovery/waiter";
import { createRun, releaseRun, recoveryHold, WALL_MS, type RecoveryTarget } from "../src/recovery/state";

test("real private crew timeout cancels the unanswered canonical assignment without fabricating done", async () => {
  const original = { ...process.env };
  const realTmux = Bun.which("tmux")!;
  const root = realpathSync(mkdtempSync("/tmp/tap-recovery-cleanup-"));
  const socket = `recovery-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  const T = (...args: string[]) => spawnSync(realTmux, ["-L", socket, ...args], { env: process.env, encoding: "utf8" });
  try {
    for (const name of ["index", "bin", ".tap/bus/payloads", ".tap/bus/receipts"]) mkdirSync(join(root, name), { recursive: true });
    Object.assign(process.env, { HOME: root, TAP_INDEX_HOME: join(root, "index"), TAP_HOME: join(root, ".tap/bus"),
      TAP_TMUX_SOCKET: socket, TAP_SELF: "driver", PATH: join(root, "bin") + ":" + original.PATH });
    for (const key of ["TMUX", "TMUX_PANE", "TAP_TMUX_SOCKET_PATH", "TAP_LOCK_DIR", "TAP_SERVER_EPOCH", "TAP_BOOT_ID"]) delete process.env[key];
    writeFileSync(join(root, "bin/tmux"), `#!${process.execPath}\nimport {spawnSync} from "node:child_process"; const r=spawnSync(${JSON.stringify(realTmux)},["-L",${JSON.stringify(socket)},...process.argv.slice(2)],{stdio:"inherit"}); process.exitCode=r.status??1;\n`, { mode: 0o700 });
    if (process.platform === "linux") copyFileSync("/bin/sleep", join(root, "bin/codex"));
    else symlinkSync("/bin/sleep", join(root, "bin/codex"));
    const parent = T("new-session", "-d", "-s", "fixture/driver", "-P", "-F", "#{pane_id}", `exec ${root}/bin/codex 120`);
    expect(parent.status).toBe(0); const ownerPane = parent.stdout.trim(); process.env.TMUX_PANE = ownerPane;
    const workerResult = T("new-window", "-d", "-t", "=fixture/driver", "-P", "-F", "#{pane_id}\t#{window_id}", "sleep 120");
    expect(workerResult.status).toBe(0); const [workerPane, workerWindow] = workerResult.stdout.trim().split("\t") as [string, string];
    const obs = observePaneResult(workerPane); if (obs.status !== "ok") throw new Error("private worker not observable");
    const registry = join(root, "registry.json"), home = join(root, ".tap/bus");
    writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture", worktree_root: root }, seats: {
      driver: { status: "active", pane: ownerPane, pane_id: ownerPane, session: "fixture/driver", harness: "codex", instance: "driver-instance", server_epoch: obs.observation.serverEpoch },
      worker: { status: "active", crew: true, pane: workerPane, pane_id: workerPane, session: "fixture/driver", harness: "codex", instance: "worker-instance", server_epoch: obs.observation.serverEpoch },
    } }));
    writeFileSync(join(root, "index/global-registry.json"), JSON.stringify({ schema: "0.20", teams: { fixture: { root, registry_location: registry } } }));
    const id = "driver-20260907T000000Z-abc12345";
    writeFileSync(join(home, `payloads/${id}.md`), `---\nid: ${id}\nfrom: driver\nto: worker\nkind: order\npath: assignment.md\nreply: expected\nsender_instance: driver-instance\nrecipient_instance: worker-instance\n---\nUnanswered infrastructure job.\n`);
    const ctx = resolveContext(root);
    const target: RecoveryTarget = { team: "fixture", handle: "driver", registry, pane: ownerPane, paneId: ownerPane,
      session: "fixture/driver", instance: "driver-instance", harness: "codex" };
    const identityId = "driver-20260907T000001Z-abc12345";
    writeFileSync(join(home, `payloads/${identityId}.md`), `---\nid: ${identityId}\nfrom: driver\nto: worker\nkind: order\npath: assignment.md\nreply: expected\nsender_instance: driver-instance\nrecipient_instance: worker-instance\n---\nIdentity only.\n`);
    const identityRun = createRun(target, "aggressive", [], ownerPane, process.pid, process.env, undefined, false);
    const pollDoc = JSON.parse(readFileSync(registry, "utf8")); pollDoc.seats.driver.delivery = "poll"; writeFileSync(registry, JSON.stringify(pollDoc));
    const replyBody = join(root, "identity-reply.md"); writeFileSync(replyBody, "worker\n");
    const replied = await tapCommand(ctx, ["reply", identityId, "--by", "worker", "-f", replyBody]);
    if (replied.code !== 0) throw new Error(JSON.stringify(replied));
    expect(replied.code).toBe(0);
    expect(await waitWorkerReply(ctx, identityRun.id, identityId, "worker", "driver", identityRun.deadline)).toBe("worker");
    releaseRun(identityRun.id);
    pollDoc.seats.driver.delivery = "pane"; writeFileSync(registry, JSON.stringify(pollDoc));
    const run = createRun(target, "aggressive", [], ownerPane, process.pid, process.env,
      { now: Date.now() - WALL_MS, processAlive: () => true, paneAlive: () => true });
    const crew: OwnedCrew = { handle: "worker", paneId: workerPane, windowId: workerWindow, session: "fixture/driver",
      instance: "worker-instance", serverEpoch: obs.observation.serverEpoch, assignments: [identityId, id] };
    // A later caller deadline cannot extend the run. The unanswered canonical job really reaches the timer.
    await expect(waitWorkerReply(ctx, run.id, id, "worker", "driver", Date.now() + 3600000)).rejects.toThrow("deadline");
    // A retained dead worker still needs identity checks before its window is
    // removed. It cannot supply the physical-absence authority for cancellation.
    expect(T("set-option", "-w", "-t", workerPane, "remain-on-exit", "on").status).toBe(0);
    expect(T("respawn-pane", "-k", "-t", workerPane, "exit 0").status).toBe(0);
    for (let i = 0; i < 100 && observePaneResult(workerPane).status !== "pane_dead"; i++) await Bun.sleep(10);
    expect(observePaneResult(workerPane).status).toBe("pane_dead");
    const deadIO = cleanupIO(run, crew, ctx, "driver");
    expect(deadIO.matches()).toBe(true);
    expect(cleanupIO(run, { ...crew, serverEpoch: "srv:0:0" }, ctx, "driver").matches()).toBe(false);
    expect(() => deadIO.markGone()).toThrow("worker pane still exists");
    expect(JSON.parse(readFileSync(registry, "utf8")).seats.worker.status).toBe("active");
    const gaps = await cleanupRecoveryCrew(crew, deadIO);
    expect(gaps).toEqual([]);
    expect(existsSync(join(home, `receipts/${id}.cancelled`))).toBe(true);
    expect(existsSync(join(home, `receipts/${id}.done`))).toBe(false);
    expect(JSON.parse(readFileSync(registry, "utf8")).seats.worker).toBeUndefined();
    expect(observePaneResult(ownerPane).status).toBe("ok");
    expect(recoveryHold(ownerPane)).toBe(false);
    const alias = T("display-message", "-p", "-t", ownerPane, "#{session_name}:#{window_index}.#{pane_index}").stdout.trim();
    const doc = JSON.parse(readFileSync(registry, "utf8")); doc.seats.driver.pane = alias; writeFileSync(registry, JSON.stringify(doc));
    const leased = createRun({ ...target, pane: alias }, "aggressive", [], ownerPane, process.pid);
    expect(T("copy-mode", "-t", ownerPane).status).toBe(0);
    const scripts = resolve(import.meta.dir, "../../../skills/tap/scripts");
    const spoolDir = join(home, "spool"); mkdirSync(spoolDir, {recursive:true});
    writeFileSync(join(home, ".tap-bus-authority"), "");
    writeFileSync(join(spoolDir, "copy-probe.md"), "---\nid: copy-probe\nfrom: driver\nto: driver\nkind: note\nreply: settle-only\n---\nprobe\n");
    writeFileSync(join(spoolDir, "copy-probe.meta.json"), JSON.stringify({id:"copy-probe",attempt_fence:1,attempts:0}));
    const drain: DrainContext = {home, scriptsDir:scripts, spoolDir, payloadsDir:join(home,"payloads"),
      receiptsDir:join(home,"receipts"), eventLog:join(home,"registry-events.log"), actingRegistry:registry,
      team:"fixture", verbLabel:"tap", courierIdentity:"courier", alert:{mode:"none"}, now:Date.now()/1000,
      unroutedGrace:1800, env:{...process.env,TAP_SPOOL_DISABLE_DELIVERER:"1"}};
    const copy = () => redeliver(drain, "copy-probe", {target:"driver",targetRegistry:registry,toTeam:"fixture",pane:alias,paneId:ownerPane});
    expect(await copy()).toBe(1);
    expect(existsSync(join(home,"receipts/copy-probe.attempted"))).toBe(false);
    expect(T("display-message", "-p", "-t", ownerPane, "#{pane_in_mode}").stdout.trim()).toBe("1");
    const spy = spyOn(paneLocks, "acquirePaneLock");
    try {
      expect(submitVerify(alias, "held-probe", "wire", { paneId: ownerPane, serverEpoch: obs.observation.serverEpoch, harness: "codex" }).status).toBe("recovery_held");
      const result = deliver({ bus: ctx.bus, id: "held-dark-probe", pane: alias, sentinel: "wire", bound: { paneId: ownerPane, serverEpoch: obs.observation.serverEpoch, harness: "codex" },
        from: "driver", to: "driver", kind: "note", via: "send" });
      expect(result.action).toBe("repark");
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(spy.mock.calls.every(args => args[0] === ownerPane)).toBe(true);
      expect(existsSync(ctx.bus.sentPath("held-dark-probe"))).toBe(false);
    } finally { spy.mockRestore(); }
    releaseRun(leased.id);
    await copy();
    expect(T("display-message", "-p", "-t", ownerPane, "#{pane_in_mode}").stdout.trim()).toBe("0");
    const acquire = join(root, "acquire.ts");
    writeFileSync(acquire, `import {createRun} from ${JSON.stringify(resolve(import.meta.dir, "../src/recovery/state.ts"))};
try { createRun(JSON.parse(process.argv[2]), "aggressive", [], process.argv[3], Number(process.argv[4])); process.exitCode=1; }
catch(e) { if(!String(e).includes("in-flight")) throw e; }
`);
    // Another process holds the pane lock while the run is created.
    const holder = join(root, "hold.ts");
    writeFileSync(holder, `import {acquirePaneLock} from ${JSON.stringify(resolve(import.meta.dir, "../src/panelock.ts"))};
const held = acquirePaneLock(process.argv[2]!, 1000); if (!held) process.exit(1);
try { process.exitCode = Bun.spawnSync(["bun", ...process.argv.slice(3)], { stdout: "inherit", stderr: "inherit" }).exitCode; } finally { held.release(); }
`);
    const heldElsewhere = spawnSync("bun", [holder, ownerPane, acquire, JSON.stringify({ ...target, pane: alias }), ownerPane, String(process.pid)],
      { cwd: root, env: process.env, encoding: "utf8", timeout: 10000 });
    expect(heldElsewhere.status).toBe(0);

  } finally {
    // Explicit private socket even during failure cleanup; never the operator's server.
    T("kill-server");
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
