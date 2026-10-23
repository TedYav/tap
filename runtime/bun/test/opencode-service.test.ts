import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { parseLinuxProcess, parseOpenCodeProcesses, readOpenCodeAncestry, readOpenCodeProcesses, readOpenCodeService } from "../src/opencode-service";
import { removeScratchTree } from "./support/scratch";

const root = mkdtempSync(join(tmpdir(), "opencode-service-"));
afterAll(() => removeScratchTree(root));
const env = { ...process.env, XDG_STATE_HOME: root };
const file = join(root, "opencode/service.json");
mkdirSync(join(root, "opencode"));
const rows = new Map([[42, { pid: 42, ppid: 1, start: 1792584000000,
  command: "/usr/bin/opencode", args: "/usr/bin/opencode serve --service" }]]);

test("the real process reader preserves the executable name on macOS and Linux", () => {
  const own = readOpenCodeProcesses()?.get(process.pid);
  expect(own?.command).toBe(basename(process.execPath));
  expect(own?.ppid).toBe(process.ppid);
  expect(own?.start).toBeGreaterThan(0);
  expect(own?.start).toBeLessThanOrEqual(Date.now());
});

test("a libproc outage retains the ordinary caller ancestry through per-pid ps", () => {
  const rows = readOpenCodeAncestry(process.env, process.pid, () => null);
  expect(rows?.get(process.pid)?.ppid).toBe(process.ppid);
  expect(rows?.get(process.pid)?.start).toBeGreaterThan(0);
});
test("Linux stat parentheses and USER_HZ produce a native wall-clock birth", () => {
  const fields = ["S", "10", ...Array(17).fill("0"), "1250", "0"];
  expect(parseLinuxProcess(`20 (odd ) name) ${fields.join(" ")}`, "opencode\n", "opencode\0serve\0--service\0", 1000, 100))
    .toEqual({ pid: 20, ppid: 10, command: "opencode", args: "opencode serve --service", start: 1012000 });
  expect(parseLinuxProcess("unreadable", "", "", 1000, 100)).toBeNull();
});

test("process dates are parsed as UTC and the executable is separate from arbitrary argv", () => {
  const parsed = parseOpenCodeProcesses(" 42 1 Wed Oct 21 12:00:00 2026 /usr/bin/opencode /usr/bin/opencode serve --service\n 43 42 Wed Oct 21 12:00:01 2026 /bin/sh sh -c echo serve\n");
  expect(parsed?.get(42)).toEqual(rows.get(42));
  expect(parsed?.get(43)?.start).toBe(1792584001000);
});

test("malformed or duplicate process rows do not manufacture an ancestry", () => {
  expect(parseOpenCodeProcesses("not a process table")).toBeNull();
  expect(parseOpenCodeProcesses("42 1 Wed Oct 21 12:00:00 2026 opencode opencode serve --service\n42 1 Wed Oct 21 12:00:01 2026 opencode opencode serve --service\n")).toBeNull();
});

test("native registration is bound to the live service generation", () => {
  writeFileSync(file, JSON.stringify({ id: "instance", pid: 42, version: "2.1.2", url: "http://127.0.0.1:12345", password: "fixture-only" }), { mode: 0o600 });
  expect(readOpenCodeService(env, rows)).toMatchObject({ id: "instance", pid: 42, start: 1792584000000, file });
  expect(readOpenCodeService(env, new Map())).toBeNull();
});

test("a remote endpoint, wrong process, and malformed registration refuse", () => {
  for (const value of [
    { id: "instance", pid: 42, version: "2.1.2", url: "https://example.com" },
    { id: "instance", pid: 43, version: "2.1.2", url: "http://127.0.0.1:12345" },
    { pid: 42, version: "2.1.2", url: "http://127.0.0.1:12345" },
  ]) {
    writeFileSync(file, JSON.stringify(value));
    expect(readOpenCodeService(env, rows)).toBeNull();
  }
});
