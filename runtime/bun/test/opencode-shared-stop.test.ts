import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quiesceSharedSession, sharedStopHold, sharedWorktreeHold, type SharedStopIO } from "../src/opencode-shared-stop";
import { removeScratchTree } from "./support/scratch";
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "shared-stop-")));
afterAll(() => removeScratchTree(scratch));
let count = 0;
function fixture() {
  const root = join(scratch, String(count++)); mkdirSync(root);
  const service = { id: "service", pid: 10, start: 1000, version: "2.1.2", url: "http://127.0.0.1:1234", file: join(root, "state/opencode/service.json") };
  const row = { harness: "opencode", opencode_server_mode: "shared", harness_session_id: "ses_root", opencode_service: service, launch_workdir: root };
  let now = 0, wedged = false;
  const active = new Set(["ses_root", "ses_child", "ses_other"]);
  let shells = [{ id: "shell_owned", status: "running", metadata: { sessionID: "ses_child" } }, { id: "shell_other", status: "running", metadata: { sessionID: "ses_other" } }];
  const calls: Array<[string, string]> = [];
  const io: SharedStopIO = {
    process: () => ({ kind: "live", row: { pid: 10, ppid: 1, start: 1000, command: "opencode", args: "opencode serve --service" } }),
    service: () => service, now: () => now, sleep: ms => { now += Math.max(ms, 1000); },
    api: (_service, path, method = "GET") => {
      calls.push([method, path]); const url = new URL(path, service.url);
      if (path === "/api/session/ses_root") return { data: { id: "ses_root", location: { directory: root } } };
      if (url.pathname === "/api/session") return { data: url.searchParams.get("parentID") === "ses_root" ? [{ id: "ses_child", parentID: "ses_root", location: { directory: root } }] : [], cursor: {} };
      if (url.pathname.endsWith("/interrupt")) { if (!wedged) active.delete(url.pathname.split("/")[3]!); return { interrupted: true }; }
      if (path === "/api/session/active") return { data: Object.fromEntries([...active].map(id => [id, { type: "running" }])) };
      if (url.pathname === "/api/shell") return { location: { directory: root }, data: shells };
      if (method === "DELETE" && url.pathname.startsWith("/api/shell/")) { shells = shells.filter(s => s.id !== url.pathname.split("/")[3]); return null; }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return { root, row, service, active, calls, io, set wedged(v: boolean) { wedged = v; },
    run: (skip = false) => quiesceSharedSession(row, root, "alpha", { skip }, io) };
}
test("shared stop interrupts root and descendants and removes only their background shells", () => {
  const f = fixture(); expect(f.run()).toEqual({ quiesced: true });
  expect(f.active).toEqual(new Set(["ses_other"]));
  expect(f.calls.some(([method, path]) => method === "DELETE" && path.includes("shell_owned"))).toBe(true);
  expect(f.calls.some(([method, path]) => method !== "GET" && path.includes("other"))).toBe(false);
  expect(f.calls.filter(([, path]) => path.includes("interrupt")).every(([, path]) => path.endsWith("resume=false"))).toBe(true);
});
test("a wedged session refuses; explicit skip leaves a receipt and worktree hold until rechecked", () => {
  const f = fixture(); f.wedged = true;
  expect(f.run).toThrow("could not quiesce"); expect(sharedStopHold(f.root, "ses_root")).toBe("");
  expect(f.run(true)).toEqual({ quiesced: false });
  expect(sharedStopHold(f.root, "ses_root")).toContain("tap down");
  expect(sharedWorktreeHold(f.root)).toContain("ses_root");
  const receipt = JSON.parse(readFileSync(join(f.root, ".tap/opencode-unquiesced/ses_root.json"), "utf8"));
  expect(receipt).toMatchObject({ session_id: "ses_root", service: { id: "service", pid: 10, start: 1000 }, handle: "alpha" });
  f.wedged = false; expect(f.run()).toEqual({ quiesced: true }); expect(sharedStopHold(f.root, "ses_root")).toBe("");
});
test("a positively vanished old generation is quiescent without contacting its successor", () => {
  const f = fixture(); f.io.process = () => ({ kind: "gone" });
  expect(f.run()).toEqual({ quiesced: true }); expect(f.calls).toEqual([]);
});
test("unobservable is not gone and a different registration cannot interrupt the old generation", () => {
  const f = fixture(); f.io.process = () => ({ kind: "unobservable" }); expect(f.run).toThrow();
  const g = fixture(); g.io.service = () => ({ ...g.service, id: "successor" }); expect(g.run).toThrow(); expect(g.calls).toEqual([]);
});
test("private mode is untouched and cannot use the shared escape", () => {
  const f = fixture(); f.row.opencode_server_mode = "private";
  expect(f.run()).toEqual({ quiesced: true }); expect(f.calls).toEqual([]); expect(() => f.run(true)).toThrow();
});
