// tap-03rfq, end to end: park against the incumbent pane, run the real restart
// transaction on a private tmux server, then drain. The restart keeps the row's
// instance and moves it to a new pane; the park re-binds and delivers there.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { launchTransaction, type LaunchRecord } from "../src/launcher/transaction";
import { drainOnce, type DrainContext, type DrainEffects } from "../src/spool-drain";
import { boundPaneIdentityState } from "../src/observe-gather";

const original = { ...process.env }, tmux = Bun.which("tmux")!;
const sockets: string[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) spawnSync(tmux, ["-S", socket, "kill-server"], { stdio: "ignore" });
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(original.TAP_INDEX_HOME!, "restart-rebind-")));
  const registry = join(root, ".tap/team-registry.json"), socket = join(original.TMUX_TMPDIR!, `restart-rebind-${process.pid}-${sockets.length}`);
  sockets.push(socket);
  for (const d of ["index", "bin", "real", ".tap/bus/spool", ".tap/bus/payloads", ".tap/bus/receipts", "config"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture", worktree_root: root }, seats: {} }));
  writeFileSync(join(root, "index/global-registry.json"), JSON.stringify({ schema: "0.20", teams: { fixture: { root, registry_location: registry } } }));
  const bus = join(root, ".tap/bus");
  writeFileSync(join(bus, ".tap-bus-authority"), "");
  const env: NodeJS.ProcessEnv = { ...original, HOME: root, XDG_CONFIG_HOME: join(root, "config"), TAP_INDEX_HOME: join(root, "index"), TAP_HOME: bus,
    TAP_TMUX_SOCKET_PATH: socket, TAP_LAUNCH_SHELL: "/bin/bash", SHELL: "/bin/bash", PATH: `${root}/bin:${original.PATH}`,
    TAP_LOCK_DIR: join(root, "locks"), TAP_SPOOL_DRAIN_ACTIVE: "0", TAP_SPOOL_DISABLE_DELIVERER: "1" };
  for (const key of ["TMUX", "TMUX_PANE", "TAP_SELF", "TAP_TMUX_SOCKET", "TAP_SERVER_EPOCH", "TAP_BOOT_ID"]) delete env[key];
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  writeFileSync(join(root, ".bash_profile"), `export PATH='${env.PATH}'\n`);
  symlinkSync("/bin/sleep", join(root, "real", "codex"));
  writeFileSync(join(root, "bin", "codex"), `#!/bin/sh\nexec '${join(root, "real", "codex")}' 600\n`);
  chmodSync(join(root, "bin", "codex"), 0o755);
  const record: LaunchRecord = { name: "fixture/seat", harness: "codex", cwd: root, base: "fixture", tag: "seat", index: 1, ensure_action: "new",
    harness_env: {}, harness_tail: [], harness_passthrough: [], harness_unset_env: [] };
  return { root, bus, registry, socket, env, record };
}

test("a park made before tap session restart re-binds to the restarted pane and delivers there", async () => {
  const f = fixture();
  // A keeper session holds the server across the restart, as an operator's server does, so pane ids advance.
  expect(spawnSync(tmux, ["-S", f.socket, "new-session", "-d", "-s", "keeper", "/bin/sleep 600"], { env: f.env }).status).toBe(0);
  // The incumbent seat, live on the private server.
  const created = spawnSync(tmux, ["-S", f.socket, "new-session", "-d", "-s", f.record.name, "-P", "-F", "#{pane_id}\t#{pid}:#{start_time}", "/bin/sleep 600"],
    { env: f.env, encoding: "utf8" });
  expect(created.status, created.stderr).toBe(0);
  const [oldPaneId, server] = created.stdout.trim().split("\t");
  const pane = `${f.record.name}:0.0`;
  const doc = JSON.parse(readFileSync(f.registry, "utf8"));
  doc.seats.seat = { status: "active", harness: "codex", delivery: "pane", session: f.record.name, pane, pane_id: oldPaneId,
    server_epoch: `srv:${server}`, instance: "seat|original", base: "fixture", tag: "seat", index: 1, registered_from_worktree: f.root,
    registered_at: "2026-01-01T00:00:00Z" };
  writeFileSync(f.registry, JSON.stringify(doc));

  // Parked for the incumbent pane, the shape spool-park publishes.
  const now = Math.floor(Date.now() / 1000), id = "sender-20261001T000000Z-0123456789ab";
  writeFileSync(join(f.bus, "spool", `${id}.md`), `---\nid: ${id}\nfrom: sender\nto: seat\nkind: discuss\nreply: expected\npath: ${f.bus}/payloads/${id}.md\n`
    + `recipient_instance: seat|original\n---\nbody\n`);
  writeFileSync(join(f.bus, "spool", `${id}.meta.json`), JSON.stringify({ id, target: "seat", pane, pane_id: oldPaneId, to_team: "fixture",
    target_registry: f.registry, policy: "standard", first_spooled_epoch: now - 5, hold_until_epoch: now - 5, deadline_epoch: now + 300,
    reason: "booting", reason_class: "busy", deadline_source: "readiness-gate", attempts: 0, attempt_fence: 1, held_drain_visits: 0 }));

  const outcome = await launchTransaction({ kind: "restart", record: f.record, incumbent_live: true }, f.env);
  expect(outcome.code).toBe(0);
  const row = JSON.parse(readFileSync(f.registry, "utf8")).seats.seat;
  expect(row.instance).toBe("seat|original");
  expect(row.status).toBe("active");
  expect(row.pane_id).toMatch(/^%\d+$/);
  expect(row.pane_id).not.toBe(oldPaneId);

  const deliveries: string[] = [];
  const fx: DrainEffects = {
    // The production row legs of the bound identity; see the unit file for why "harness_unobservable" stands for a match.
    readiness: async b => boundPaneIdentityState(b.targetRegistry, b.target, b.pane, b.paneId, f.env, false) === "harness_unobservable" ? "ready" : "gone",
    harness: async () => "codex", flash: async () => {}, repairOrphans: async () => {},
    redeliverLocked: async (entry, b) => { deliveries.push(`${entry}@${b.paneId}`); return 1; },
    digest: async (b, ids) => { deliveries.push(...ids.map(entry => `${entry}@${b.paneId}`)); return 1; },
  };
  const ctx: DrainContext = { home: f.bus, spoolDir: join(f.bus, "spool"), payloadsDir: join(f.bus, "payloads"), receiptsDir: join(f.bus, "receipts"),
    eventLog: join(f.bus, "registry-events.log"), team: "fixture", actingRegistry: f.registry, verbLabel: "tap",
    scriptsDir: join(import.meta.dir, "../../../skills/tap/scripts"), courierIdentity: "courier", alert: { mode: "none" }, now, unroutedGrace: 1800, env: f.env };
  expect(await drainOnce(ctx, fx)).toBe(0);
  expect(deliveries).toEqual([`${id}@${row.pane_id}`]);
  expect(JSON.parse(readFileSync(join(f.bus, "spool", `${id}.meta.json`), "utf8"))).toMatchObject({ pane, pane_id: row.pane_id,
    rebound_from: { pane, pane_id: oldPaneId } });
  expect(existsSync(join(f.bus, "receipts", `${id}.cancelled`))).toBe(false);
}, 30_000);
