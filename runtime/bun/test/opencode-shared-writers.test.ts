import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as native from "../src/opencode-service";
import * as launch from "../src/launcher/process";
import * as readiness from "../src/launcher/readiness";
import * as context from "../src/context";
import * as stop from "../src/seat-stop";
import { cmdSeatUpDown } from "../src/seat-updown";
import { assertSharedStopCleared, sharedWorktreeHold } from "../src/opencode-shared-stop";
import { selectCaller } from "../src/selector";
import { bindTransaction, rollbackOwned, type FailureEvidence, type LaunchRecord } from "../src/launcher/transaction";
import { consumeClearNonce, replaceHarnessInPane } from "../src/launcher/replace";
import { removeScratchTree } from "./support/scratch";
const original = { ...process.env }, roots: string[] = [], spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0).reverse()) spy.mockRestore();
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  for (const root of roots.splice(0)) removeScratchTree(root);
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "shared-writer-"))); roots.push(root);
  const registry = join(root, ".tap/team-registry.json"), socket = join(root, "socket"), bus = join(root, ".tap/bus");
  for (const path of [bus, join(root, "index")]) mkdirSync(path, { recursive: true });
  Object.assign(process.env, { TAP_INDEX_HOME: join(root, "index"), TAP_HOME: bus, TAP_TMUX_SOCKET_PATH: socket });
  for (const key of ["TMUX", "TMUX_PANE", "TAP_SELF", "TAP_SERVER_EPOCH", "TAP_TMUX_SOCKET"]) delete process.env[key];
  const service = { id: "native", pid: 10, start: 1000, url: "http://127.0.0.1:1234", version: "2.1.2", file: join(root, "opencode/service.json") };
  const row = { instance: "seat|one", status: "active", status_reason: "launching", harness: "opencode", session: "t/seat",
    pane: "t/seat:0.0", pane_id: "%1", server_epoch: "srv:100:200", server_socket: socket, delivery: "pane",
    harness_session_id: "ses_alpha", opencode_server_mode: "shared", opencode_service: service, launch_id: "token", expected_clear_nonce: "nonce" };
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "t", worktree_root: root }, seats: { seat: row } }));
  writeFileSync(join(root, "index/global-registry.json"), JSON.stringify({ schema: "0.20", teams: { t: { root, registry_location: registry, state: "registered" } } }));
  const processRow = { pid: 20, ppid: 1, start: 2000, command: "opencode", args: "opencode --session ses_alpha" };
  const current = { ...service, password: "secret" };
  const puts: unknown[] = [];
  const pane = { status: "ok" as const, paneId: "%1", session: "t/seat", serverEpoch: "srv:100:200", paneTty: "/dev/ttysprobe" };
  spies.push(spyOn(context, "observeIdentityPane").mockImplementation(() => pane), spyOn(native, "readOpenCodeService").mockImplementation(() => current),
    spyOn(native, "readOpenCodeProcesses").mockImplementation(() => new Map([[processRow.pid, processRow]])),
    spyOn(native, "openCodeAPI").mockImplementation((_s, _path, method, body) => {
      if (method === "PUT") puts.push(body);
      return { data: { id: "ses_alpha", location: { directory: root } } };
    }), spyOn(launch, "launchTmux").mockImplementation(async args => ({ code: 0, stderr: "", stdout: args.at(-1)?.includes("socket_path") ? `100:200\t${socket}\n` : "100:200\n" })));
  const record: LaunchRecord = { name: "t/seat", base: "t", harness: "opencode", cwd: root,
    harness_session_id: "ses_alpha", opencode_server_mode: "shared", opencode_service: service };
  const facts = { pane: "t/seat:0.0", pane_id: "%1", command: "opencode", server_epoch: "srv:100:200", dead: false, pane_pid: 20, path: root };
  const evidence: FailureEvidence = { selection: selectCaller({ cwd: root, env: process.env, verbClass: "lifecycle" }), handle: "seat", instance: row.instance,
    token: "token", record, vessel: null, backup: { status: "not-needed" }, reason: "repair_failed", output_path: "" };
  const run = (writer: string) => writer === "bind" ? bindTransaction(evidence, facts, true, process.env)
    : consumeClearNonce({ root, registryPath: registry, busHome: bus }, "seat", "nonce", "tap clear", undefined, undefined, "promote",
      { record, facts, expected: row, env: process.env });
  return { root, registry, row, current, processRow, puts, pane, facts, record, evidence, run };
}
for (const binding of ["fresh-session", "new-service"]) for (const failure of ["none", "readiness", "activation-write", "exception", "respawn-result"]) {
  test(`replacement retains ${binding} after ${failure}; down stops that binding`, async () => {
    const f = fixture(); let respawned = false, recovered = false, stopped = false, newReads = 0;
    const interrupts: Array<{ id: string; service: string }> = [];
    delete (f.row as Record<string, unknown>).launch_id; f.row.status_reason = "";
    writeFileSync(f.registry, JSON.stringify({ schema: "0.20", team: { name: "t", worktree_root: f.root }, seats: { seat: f.row } }));
    if (binding === "fresh-session") f.record.harness_session_id = "ses_replacement";
    else { Object.assign(f.current, { id: "successor", pid: 11, start: 3000 }); f.record.opencode_service = { ...f.current }; }
    const replacementId = f.record.harness_session_id!;
    spies.push(spyOn(native, "nativeOpenCodeCaller").mockImplementation(() => ({ kind: "none" })),
      spyOn(native, "readOpenCodeAncestry").mockImplementation(() => new Map([
        [10, { pid: 10, ppid: 1, start: binding === "new-service" ? 9999 : 1000, command: "opencode", args: "opencode serve --service" }],
        [11, { pid: 11, ppid: 1, start: 3000, command: "opencode", args: "opencode serve --service" }],
      ])),
      spyOn(readiness, "paneFacts").mockImplementation(async () => ({ ...f.facts, pane_pid: respawned ? 21 : 20 })),
      spyOn(launch, "launchTmux").mockImplementation(async args => {
        if (args[0] === "respawn-pane") {
          respawned = true; Object.assign(f.processRow, { pid: 21, start: 2500, args: `opencode --session ${replacementId}` });
          if (failure === "respawn-result") return { code: 1, stdout: "", stderr: "injected uncertain respawn" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }),
      spyOn(native, "openCodeAPI").mockImplementation((service, path) => {
        if (path.endsWith("/interrupt?resume=false")) { interrupts.push({ id: path.split("/")[3]!, service: service.id }); return { interrupted: true }; }
        if (path.startsWith("/api/session?")) return { data: [], cursor: {} };
        if (path.startsWith("/api/shell?")) return { data: [], location: { directory: f.root } };
        if (path === "/api/session/active") return { data: {} };
        if (failure !== "none" && respawned && !recovered && path === `/api/session/${replacementId}`) {
          newReads++;
          if (failure === "exception") throw new Error("injected observation failure");
          if (failure !== "activation-write" || newReads > 1) return null;
        }
        return { data: { id: respawned ? replacementId : "ses_alpha", location: { directory: f.root } } };
      }));
    const scope = { root: f.root, registryPath: f.registry, busHome: join(f.root, ".tap/bus") };
    const outcome = await replaceHarnessInPane(scope, { target: { paneId: "%1", epoch: f.facts.server_epoch,
      generation: { boot: null, epoch: f.facts.server_epoch, socket: String(f.row.server_socket) }, entry: f.row, warnings: [] },
      record: f.record, nonce: "nonce", invocation: { argv: ["opencode"], env: {} }, command: "opencode", ceiling: 0 },
      { verb: "tap clear", handle: "seat", instruction: null, clearHistory: false });
    expect(outcome.code).toBe(failure === "none" ? 0 : 7);
    const parked = JSON.parse(readFileSync(f.registry, "utf8")).seats.seat;
    expect(parked).toMatchObject({ status: failure === "none" ? "active" : "suspended", status_reason: failure === "none" ? "" : "unquiesced", harness_session_id: replacementId,
      opencode_service: { id: f.current.id, pid: f.current.pid, start: f.current.start } });
    expect(parked.opencode_service.password).toBeUndefined(); expect(parked.expected_clear_nonce).toBeUndefined();
    if (failure === "none") expect(sharedWorktreeHold(f.root)).toBe("");
    else expect(sharedWorktreeHold(f.root)).toContain(replacementId);
    const priorInterrupts = interrupts.length; recovered = true;
    spies.push(spyOn(stop, "seatSnapshot").mockImplementation(() => ({ epoch: "srv:100:200", panes: stopped ? [] : [
      { id: "%1", session: "t/seat", sessionId: "$1", window: "@1", rawEpoch: "100:200" },
    ] })), spyOn(stop, "stopExactPane").mockImplementation(() => {
      stopped = true; return { code: 0, stdout: "", stderr: "", rateLimited: false };
    }));
    expect(await cmdSeatUpDown("down", ["t/seat", "--json"], "")).toBe(0);
    expect(interrupts.slice(priorInterrupts)).toEqual([{ id: replacementId, service: f.current.id }]);
    expect(stopped).toBe(true); expect(sharedWorktreeHold(f.root)).toBe("");
  });
}
test("failed shared activation parks recoverable unquiesced work without killing its vessel", async () => {
  const f = fixture(); let kills = 0;
  spies.push(spyOn(native, "nativeOpenCodeCaller").mockImplementation(() => ({ kind: "none" })),
    spyOn(native, "readOpenCodeAncestry").mockImplementation(() => new Map([[10, { pid: 10, ppid: 1, start: 1000, command: "opencode", args: "opencode serve --service" }]])),
    spyOn(native, "openCodeAPI").mockImplementation(() => { throw new Error("wedged API"); }),
    spyOn(launch, "launchCommand").mockImplementation(async () => { kills++; return { code: 0, stdout: "", stderr: "" }; }));
  // Activation fails in the production writer; its recovery retains the same owned row.
  await expect(f.run("bind")).rejects.toThrow("wedged API");
  f.evidence.vessel = { server: "100:200", session: "$1", window: "@1", pane: "%1", socket: String(f.row.server_socket) };
  expect(await rollbackOwned(f.evidence, "repair_failed", process.env, true)).toBe(false);
  const parked = JSON.parse(readFileSync(f.registry, "utf8")).seats.seat;
  expect(parked).toMatchObject({ status: "suspended", status_reason: "unquiesced", pane_id: "%1", harness_session_id: "ses_alpha" });
  expect(parked.launch_id).toBeUndefined(); expect(parked.opencode_service.password).toBeUndefined(); expect(kills).toBe(0);
  expect(sharedWorktreeHold(f.root)).toContain("ses_alpha");
  let paneStopped = false;
  spies.push(spyOn(stop, "seatSnapshot").mockImplementation(() => ({ epoch: "srv:100:200", panes: paneStopped ? [] : [
    { id: "%1", session: "t/seat", sessionId: "$1", window: "@1", rawEpoch: "100:200" },
  ] })), spyOn(stop, "stopExactPane").mockImplementation(() => {
    paneStopped = true; return { code: 0, stdout: "", stderr: "", rateLimited: false };
  }));
  expect(await cmdSeatUpDown("down", ["t/seat", "--json"], "")).toBe(1); expect(paneStopped).toBe(false);
  expect(await cmdSeatUpDown("down", ["t/seat", "--skip-quiesce", "--json"], "")).toBe(0); expect(paneStopped).toBe(true);
  expect(sharedWorktreeHold(f.root)).toContain("ses_alpha");
});
test("rollback before native preparation completes ordinary cleanup", async () => {
  const f = fixture(); let kills = 0;
  delete f.record.opencode_service; f.record.harness_session_id = null;
  f.evidence.vessel = { server: "100:200", session: "$1", window: "@1", pane: "%1", socket: String(f.row.server_socket) };
  spies.push(spyOn(launch, "launchCommand").mockImplementation(async () => { kills++; return { code: 0, stdout: "", stderr: "" }; }));
  expect(await rollbackOwned(f.evidence, "repair_failed", process.env, true)).toBe(true);
  expect(JSON.parse(readFileSync(f.registry, "utf8")).seats).toEqual({}); expect(kills).toBe(1);
  expect(sharedWorktreeHold(f.root)).toBe("");
});
test("public down refuses wedged work; skip records a hold before killing and a later down clears it", async () => {
  const f = fixture(); let stopped = false, kills = 0, recovered = false;
  const receipt = join(f.root, ".tap/opencode-unquiesced/ses_alpha.json");
  spies.push(spyOn(native, "nativeOpenCodeCaller").mockImplementation(() => ({ kind: "none" })),
    spyOn(native, "readOpenCodeAncestry").mockImplementation(() => new Map([[10, { pid: 10, ppid: 1, start: 1000, command: "opencode", args: "opencode serve --service" }]])),
    spyOn(stop, "seatSnapshot").mockImplementation(() => ({ epoch: "srv:100:200", panes: stopped ? [] : [
      { id: "%1", session: "t/seat", sessionId: "$1", window: "@1", rawEpoch: "100:200" },
    ] })),
    spyOn(stop, "stopExactPane").mockImplementation(() => {
      expect(JSON.parse(readFileSync(receipt, "utf8")).session_id).toBe("ses_alpha");
      expect(JSON.parse(readFileSync(f.registry, "utf8")).seats.seat.status_reason).toBe("unquiesced");
      stopped = true; kills++; return { code: 0, stdout: "", stderr: "", rateLimited: false };
    }));
  // Replace the API fixture from activation with an unavailable/idle service.
  spies.push(spyOn(native, "openCodeAPI").mockImplementation((_service, path) => {
    if (!recovered) throw new Error("native service unavailable");
    if (path === "/api/session/ses_alpha") return { data: { id: "ses_alpha", location: { directory: f.root } } };
    if (path.startsWith("/api/session?")) return { data: [], cursor: {} };
    if (path.startsWith("/api/shell?")) return { data: [], location: { directory: f.root } };
    if (path === "/api/session/active") return { data: {} };
    return { interrupted: true };
  }));
  const before = readFileSync(f.registry, "utf8");
  expect(await cmdSeatUpDown("down", ["t/seat", "--json"], "")).toBe(1);
  expect(readFileSync(f.registry, "utf8")).toBe(before); expect(kills).toBe(0);
  expect(await cmdSeatUpDown("down", ["t/seat", "--skip-quiesce", "--json"], "")).toBe(0);
  expect(kills).toBe(1); expect(sharedWorktreeHold(f.root)).toContain("ses_alpha");
  expect(() => assertSharedStopCleared(f.root, f.row)).toThrow();
  recovered = true;
  expect(await cmdSeatUpDown("down", ["t/seat", "--json"], "")).toBe(0);
  expect(kills).toBe(1); expect(sharedWorktreeHold(f.root)).toBe("");
  expect(() => assertSharedStopCleared(f.root, f.row)).not.toThrow();
});
for (const writer of ["bind", "replacement"]) {
  test(`${writer} writer activates only after native proof and stores no credential`, async () => {
    const f = fixture(); await f.run(writer);
    const row = JSON.parse(readFileSync(f.registry, "utf8")).seats.seat;
    expect(row.status_reason).toBe(""); expect(row.opencode_service.password).toBeUndefined(); expect(f.puts).toHaveLength(1);
  });
  for (const failure of ["wrong-session", "service-generation"]) {
    test(`${writer} writer refuses ${failure} without changing registry bytes`, async () => {
      const f = fixture(), before = readFileSync(f.registry, "utf8");
      if (failure === "wrong-session") f.processRow.args = "opencode --session ses_other";
      else f.current.id = "successor";
      await expect(f.run(writer)).rejects.toMatchObject({ errorClass: "opencode_shared_activation_failed" });
      expect(readFileSync(f.registry, "utf8")).toBe(before); expect(f.puts).toEqual([]);
    });
  }
  test(`${writer} writer rechecks the physical pane after native environment installation`, async () => {
    const f = fixture(), before = readFileSync(f.registry, "utf8"); f.pane.serverEpoch = "srv:999:888";
    await expect(f.run(writer)).rejects.toMatchObject({ errorClass: "opencode_shared_activation_failed" });
    expect(readFileSync(f.registry, "utf8")).toBe(before); expect(f.puts).toHaveLength(1);
  });
}
