import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCodeServerMode } from "../src/launcher/opencode-mode";
import { pinOpenCodeSession } from "../src/launcher/invocation";
import { durableRecord, recordFromRow, storeRecipe } from "../src/launcher/transaction";
import type { SessionRecord } from "../src/launcher/types";
import { removeScratchTree } from "./support/scratch";
import { admitSharedOpenCode, type SharedLaunchIO } from "../src/launcher/opencode-shared-service";
import { prepareSharedActivation, type SharedActivationIO } from "../src/launcher/opencode-shared-activation";
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "shared-launch-")));
afterAll(() => removeScratchTree(scratch));
let count = 0;
function fixture(config?: string) {
  const root = join(scratch, String(count++)); mkdirSync(join(root, "tap"), { recursive: true });
  if (config !== undefined) writeFileSync(join(root, "tap/config.toml"), config, { mode: 0o600 });
  const record: SessionRecord = { name: "t/oc", base: "t", harness: "opencode", cwd: root };
  return { root, record, env: { ...process.env, XDG_CONFIG_HOME: root } };
}
test("private servers are the default and shared mode requires a boolean opt-in", () => {
  const missing = fixture(); expect(openCodeServerMode(missing.record, missing.env)).toBe("private");
  const enabled = fixture("[experimental]\nopencode_shared_server=true\n");
  expect(openCodeServerMode(enabled.record, enabled.env)).toBe("shared");
  expect(enabled.record.opencode_server_mode).toBe("shared");
  const invalid = fixture('[experimental]\nopencode_shared_server="true"\n');
  expect(() => openCodeServerMode(invalid.record, invalid.env)).toThrow("must be a boolean");
});
test("stored mode survives a config change, including legacy private rows", () => {
  const f = fixture("[experimental]\nopencode_shared_server=true\n");
  f.record.opencode_server_mode = "private";
  expect(openCodeServerMode(f.record, f.env)).toBe("private");
  const restored = recordFromRow("oc", { session: "t/oc", harness: "opencode" }, { name: "t" }, f.root)!;
  expect(openCodeServerMode(restored, f.env)).toBe("private");
});
test("shared invocation pins the native session and refuses explicit server selection", () => {
  expect(pinOpenCodeSession(["opencode", "--auto"], "ses_one", "shared")).toEqual(["opencode", "--auto", "--session", "ses_one"]);
  for (const flag of ["--standalone", "--server=http://127.0.0.1:1", "--no-standalone"]) {
    expect(() => pinOpenCodeSession(["opencode", flag], "ses_one", "shared")).toThrow();
  }
});
test("native service fingerprint and server mode round-trip with the launch recipe", () => {
  const f = fixture(); f.record.opencode_server_mode = "shared";
  f.record.opencode_service = { id: "service", pid: 10, start: 1000, url: "http://127.0.0.1:1234", version: "2.1.2", file: "/state/opencode/service.json" };
  const row: Record<string, unknown> = {}; storeRecipe(row, f.record);
  const restored = recordFromRow("oc", row, { name: "t" }, f.root)!;
  expect(restored.opencode_service).toEqual(f.record.opencode_service);
  expect(durableRecord(restored).opencode_server_mode).toBe("shared");
});

function serviceFixture() {
  const service = { id: "service", pid: 10, start: 1000, url: "http://127.0.0.1:1234", version: "2.1.2", file: "/state/opencode/service.json", password: "secret" };
  let exists = true, started: NodeJS.ProcessEnv | undefined;
  const plugins = ["tap.tmux-guard", "tap.session-start"].map(id => ({ id, state: { status: "active" }, features: { server: true } }));
  const io: SharedLaunchIO = { exists: () => exists, read: () => service, start: async env => { started = env; exists = true; },
    api: () => ({ location: { directory: "/project" }, data: plugins }) };
  return { service, plugins, io, set absent(v: boolean) { exists = !v; }, get started() { return started; } };
}
test("adoption requires both active server plugins in the exact location and starts nothing", async () => {
  const f = serviceFixture();
  expect((await admitSharedOpenCode("/project", {}, undefined, f.io)).id).toBe("service");
  expect(f.started).toBeUndefined();
  f.plugins[0]!.state.status = "failed";
  await expect(admitSharedOpenCode("/project", {}, undefined, f.io)).rejects.toMatchObject({ errorClass: "opencode_shared_plugins_missing" });
  f.io.api = () => ({ location: { directory: "/other" }, data: f.plugins });
  await expect(admitSharedOpenCode("/project", {}, undefined, f.io)).rejects.toThrow();
});
test("adoption waits for cold-location plugin activation before checking loaded plugins", async () => {
  const f = serviceFixture(); let activated = false;
  f.io.api = (_s, path) => {
    if (path.startsWith("/api/model?")) activated = true;
    return { location: { directory: "/project" }, data: activated ? f.plugins : [] };
  };
  expect((await admitSharedOpenCode("/project", {}, undefined, f.io)).id).toBe("service");
});
test("service start scrubs inherited identity and tmux pins but preserves configuration and index", async () => {
  const f = serviceFixture(); f.absent = true;
  await admitSharedOpenCode("/project", { TMUX: "wrong", TMUX_PANE: "%99", TAP_SELF: "wrong", TAP_HOME: "/wrong", TAP_STATELESS: "1", CLAUDE_JOB_DIR: "/wrong", TAP_INDEX_HOME: "/index", XDG_STATE_HOME: "/state", PATH: "/bin" }, undefined, f.io);
  expect(f.started).toEqual({ TAP_INDEX_HOME: "/index", XDG_STATE_HOME: "/state", PATH: "/bin" });
});
test("a stale registration refuses without starting or replacing a service", async () => {
  const f = serviceFixture(); f.io.read = () => null;
  await expect(admitSharedOpenCode("/project", {}, undefined, f.io)).rejects.toMatchObject({ errorClass: "opencode_shared_unavailable" });
  expect(f.started).toBeUndefined();
});
test("service replacement during plugin inspection refuses admission", async () => {
  const f = serviceFixture(); f.io.api = () => { f.service.id = "successor"; return { location: { directory: "/project" }, data: f.plugins }; };
  await expect(admitSharedOpenCode("/project", {}, undefined, f.io)).rejects.toMatchObject({ errorClass: "opencode_shared_unavailable" });
});

function activationFixture() {
  const f = fixture(), service = serviceFixture().service;
  Object.assign(f.record, { harness_session_id: "ses_alpha", opencode_server_mode: "shared", opencode_service: service });
  const facts = { pane: "t/oc:0.0", pane_id: "%1", command: "opencode", server_epoch: "srv:100:200", dead: false, pane_pid: 20, path: f.root };
  const processes = new Map([[20, { pid: 20, ppid: 1, start: 2000, command: "opencode", args: "opencode --session ses_alpha --auto" }]]);
  const calls: Array<{ path: string; method?: string; body?: any }> = [];
  const io: SharedActivationIO = { processes: () => processes, service: () => service, api: (_service, path, method, body) => {
    calls.push({ path, method, body }); return { data: { id: "ses_alpha", location: { directory: f.root } } };
  } };
  const binding = { root: f.root, bus: join(f.root, ".tap/bus"), socket: join(f.root, "socket") };
  const run = (overrides: NodeJS.ProcessEnv = {}) => prepareSharedActivation(f.record, facts, { ...f.env, TAP_INDEX_HOME: "/index", TMUX_PANE: "%99", TAP_SELF: "wrong", ...overrides }, binding, io);
  return { ...f, service, facts, processes, calls, io, binding, run };
}
test("activation installs the exact TUI session environment without waiting for a model prompt", () => {
  const f = activationFixture(); f.run();
  expect(f.calls.map(c => [c.method ?? "GET", c.path])).toEqual([["GET", "/api/session/ses_alpha"], ["PUT", "/api/session/ses_alpha/environment"]]);
  const variables = f.calls[1]!.body.variables;
  expect([variables.TMUX_PANE, variables.TAP_TMUX_SOCKET_PATH, variables.TAP_HOME, variables.TAP_INDEX_HOME]).toEqual(["%1", f.binding.socket, f.binding.bus, "/index"]);
  expect(variables.TAP_SELF).toBeUndefined();
});
for (const explicit of [false, true]) {
  test(`activation carries the ${explicit ? "explicit" : "index-derived"} lock root into native shell environments`, () => {
    const f = activationFixture();
    const locks = explicit ? join(f.root, "custom-locks") : "/index/locks";
    f.run({ TAP_LOCK_DIR: explicit ? locks : undefined });
    expect(f.calls[1]!.body.variables.TAP_LOCK_DIR).toBe(locks);
  });
}
test("activation refuses a wrong TUI session, a private TUI, and a replaced service", () => {
  for (const args of ["opencode --session ses_other", "opencode --standalone --session ses_alpha"]) {
    const f = activationFixture(); f.processes.get(20)!.args = args; expect(f.run).toThrow(); expect(f.calls).toEqual([]);
  }
  const f = activationFixture(); f.record.opencode_service = { ...f.service, id: "old" };
  expect(f.run).toThrow(); expect(f.calls).toEqual([]);
});
test("activation rechecks TUI birth after the environment API returns", () => {
  const f = activationFixture(), api = f.io.api;
  f.io.api = (...args) => { const value = api(...args); if (args[2] === "PUT") f.processes.get(20)!.start++; return value; };
  expect(f.run).toThrow();
});
