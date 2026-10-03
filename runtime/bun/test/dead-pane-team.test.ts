import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chooserView, gather, gatheredPayload } from "../src/observe-gather";
import { observeRows, US, type RowInput } from "../src/observe";
import { unboundPaneIdentityRecord } from "../src/pane-identity";
import { removeScratchTree } from "./support/scratch";

const root = realpathSync(mkdtempSync(join(tmpdir(), "tap-dead-team.")));
const socket = "dead-team-" + process.pid;
const env: NodeJS.ProcessEnv = { ...process.env, TAP_TMUX_SOCKET: socket,
  TAP_INDEX_HOME: join(root, "index"), TAP_OBS_HARNESS_FAMILIES: "codex" };
for (const key of ["TMUX", "TMUX_PANE", "TAP_TMUX_SOCKET_PATH", "TAP_SERVER_EPOCH"]) delete env[key];
const T = (...args: string[]) => {
  const r = spawnSync("tmux", ["-L", socket, ...args], { env, encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
};
const panes: Record<string, string> = {};
const rows: RowInput[] = [];
beforeAll(async () => {
  mkdirSync(join(root, "index"));
  const executable = join(root, "codex");
  const source = join(root, "fixture.c");
  writeFileSync(source, "#include <unistd.h>\nint main(void) { sleep(600); return 0; }\n");
  const built = spawnSync("cc", [source, "-o", executable], { env, encoding: "utf8", timeout: 20_000 });
  expect(built.status, built.stdout + built.stderr).toBe(0);
  for (const name of ["dead", "live"]) {
    const session = "fixture/" + name;
    const pane = T("new-session", "-d", "-s", session, "-c", root, "-P", "-F", "#{pane_id}", "exec " + executable + " 600");
    panes[name] = pane;
    for (let i = 0; i < 100 && T("display-message", "-p", "-t", pane, "#{pane_current_command}") !== "codex"; i++) await Bun.sleep(10);
    expect(T("display-message", "-p", "-t", pane, "#{pane_current_command}")).toBe("codex");
    rows.push({ key: name, status: "active", pane: session + ":0.0", pane_id: pane, session, harness: "codex" });
  }
  T("set-option", "-w", "-t", panes.dead!, "remain-on-exit", "on");
  T("send-keys", "-t", panes.dead!, "C-c");
  for (let i = 0; i < 100 && T("display-message", "-p", "-t", panes.dead!, "#{pane_dead}") !== "1"; i++) await Bun.sleep(10);
  expect(T("display-message", "-p", "-t", panes.dead!, "#{pane_dead}")).toBe("1");
  expect(T("display-message", "-p", "-t", panes.live!, "#{pane_dead}")).toBe("0");
  expect(T("display-message", "-p", "-t", panes.dead!, "#{pane_current_command}")).toBe("codex");
});
afterAll(() => { spawnSync("tmux", ["-L", socket, "kill-server"], { env }); removeScratchTree(root); });

test("team gather cannot attest a retained dead pane from its cached harness command", () => {
  const records = observeRows(gatheredPayload(rows, { env, processTable: false }), env)
    .map(row => row.split(US));
  expect(records[0]?.slice(0, 5)).toEqual(["dead", "offline", "pane_dead", "fixture/dead:0.0", panes.dead!]);
  expect(records[1]?.slice(0, 5)).toEqual(["live", "active", "", "fixture/live:0.0", panes.live!]);
});

test("rowless point-of-effect guard refuses the dead record without claiming absence", () => {
  for (const harness of ["codex", undefined]) {
    expect(unboundPaneIdentityRecord("fixture/dead", "fixture/dead:0.0", { paneId: panes.dead, harness }, env))
      .toMatchObject({ state: "pane_dead", paneId: panes.dead });
    expect(unboundPaneIdentityRecord("fixture/live", "fixture/live:0.0", { paneId: panes.live, harness }, env))
      .toMatchObject({ state: "match", paneId: panes.live });
  }
});

test("chooser retains dead physical identity and recovery cannot rebind it", () => {
  const view = chooserView(gather({ env, processTable: false }), env)!;
  expect(view.paneIdOf("fixture/dead:0.0")).toBe(panes.dead!);
  expect(view.sessionOf(panes.dead!)).toBe("fixture/dead");
  expect(view.sessions?.has("fixture/dead")).toBe(true);
  const recovering = rows.map(row => ({ ...row, status: "suspended", status_reason: "server_restarted", pane: "", pane_id: "" }));
  const records = observeRows(gatheredPayload(recovering, { env, processTable: false }), env).map(row => row.split(US));
  expect(records[0]?.slice(0, 3)).toEqual(["dead", "offline", "server_restarted"]);
  expect(records[1]?.slice(0, 3)).toEqual(["live", "unbound", "server_restarted"]);
});
