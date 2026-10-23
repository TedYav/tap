import { expect, test } from "bun:test";
import { attestOpenCodeCaller, OpenCodeWitnessCache, type OpenCodeProcess, type OpenCodeService, type SharedObservationIO } from "../src/opencode-shared";

// Removing PID provenance or the native-session consistency check lets alpha
// impersonate beta. Fixtures substitute only process/native API observations.
function fixture() {
  const processes = new Map<number, OpenCodeProcess>([
    [10, { pid: 10, ppid: 1, start: 100000, command: "/bin/opencode", args: "/bin/opencode serve --service" }],
    [20, { pid: 20, ppid: 10, start: 101000, command: "/bin/zsh", args: "zsh -c tap whoami" }],
    [30, { pid: 30, ppid: 20, start: 101000, command: "/bin/bun", args: "bun tap whoami" }],
  ]);
  const service: OpenCodeService = { id: "service-one", pid: 10, start: 100000, url: "http://127.0.0.1:12345", version: "2.1.2", file: "/sandbox/state/opencode/service.json" };
  const sessions: Record<string, any> = {
    ses_alpha: { id: "ses_alpha", location: { directory: "/project" } },
    ses_beta: { id: "ses_beta", location: { directory: "/project" } },
  };
  let shells: any[] = [
    { id: "sh_alpha", pid: 20, status: "running", time: { started: 101100 }, metadata: { sessionID: "ses_alpha" } },
    { id: "sh_beta", pid: 21, status: "running", time: { started: 101100 }, metadata: { sessionID: "ses_beta" } },
  ];
  const io: SharedObservationIO = {
    processes: () => processes,
    service: () => service,
    api: (_service, path) => {
      const url = new URL(path, service.url);
      if (url.pathname === "/api/shell") {
        expect(url.searchParams.get("location[directory]")).toBe("/project");
        return { location: { directory: "/project" }, data: shells };
      }
      if (url.pathname.startsWith("/api/session/")) return { data: sessions[url.pathname.slice(13)] };
      throw new Error(`unexpected API ${path}`);
    },
  };
  return { processes, service, sessions, io, get shells() { return shells; }, set shells(v) { shells = v; },
    run: (hint = "ses_alpha") => attestOpenCodeCaller({ OPENCODE_SESSION_ID: hint }, 30, io) };
}

test("one invocation reuses a native witness but rechecks live process and service evidence", () => {
  const f = fixture(), cache = new OpenCodeWitnessCache(); let calls = 0, probes = 0;
  const io = { ...f.io, processes: () => { probes++; return f.processes; }, api: (...args: Parameters<SharedObservationIO["api"]>) => { calls++; return f.io.api(...args); } };
  const env = { OPENCODE_SESSION_ID: "ses_alpha" };
  expect(cache.read(env, 30, io, 1000).kind).toBe("verified");
  const first = calls, before = probes;
  expect(cache.read(env, 30, io, 1100).kind).toBe("verified");
  expect(calls).toBe(first); expect(probes).toBeGreaterThan(before);
  cache.read(env, 30, io, 1300); expect(calls).toBeGreaterThan(first);
});
for (const mutation of ["service", "birth", "parent", "hint", "missing"] as const) test(`witness cache refuses stale ${mutation}`, () => {
  const f = fixture(), cache = new OpenCodeWitnessCache(), env = { OPENCODE_SESSION_ID: "ses_alpha" };
  expect(cache.read(env, 30, f.io, 1000).kind).toBe("verified");
  if (mutation === "service") { f.service.id = "successor"; f.shells = []; }
  if (mutation === "birth") f.processes.get(20)!.start += 10000;
  if (mutation === "parent") f.processes.get(20)!.ppid = 1;
  if (mutation === "hint") env.OPENCODE_SESSION_ID = "ses_beta";
  if (mutation === "missing") f.processes.delete(20);
  expect(cache.read(env, 30, f.io, 1100).kind).not.toBe("verified");
});

test("a native running-shell PID identifies its own root session", () => {
  expect(fixture().run()).toMatchObject({ kind: "verified", sessionId: "ses_alpha", rootSessionId: "ses_alpha", shellPid: 20, directory: "/project" });
});

test("another session's env ID cannot impersonate that seat", () => {
  expect(fixture().run("ses_beta")).toMatchObject({ kind: "refused", reason: "session_mismatch" });
});

test("exec retains the native PID witness", () => {
  const f = fixture(); f.processes.get(20)!.command = "/bin/bun"; f.processes.get(20)!.args = "bun tap whoami";
  expect(attestOpenCodeCaller({ OPENCODE_SESSION_ID: "ses_alpha" }, 20, f.io)).toMatchObject({ kind: "verified", shellPid: 20 });
});

test("MCP, plugin and background daemon children without a shell record refuse", () => {
  const f = fixture(); f.shells = [];
  expect(f.run()).toMatchObject({ kind: "refused", reason: "not_shell" });
});

test("missing hint never borrows the service starter's pane", () => {
  expect(fixture().run("")).toMatchObject({ kind: "refused", reason: "session_missing" });
});

test("unobservable process evidence cannot become permission to climb a service", () => {
  const f = fixture(); f.io.processes = () => null;
  expect(f.run("")).toMatchObject({ kind: "refused", reason: "process_unobservable" });
});

test("a missing ancestor row refuses instead of licensing the physical walk", () => {
  const f = fixture(); f.processes.delete(20);
  expect(f.run()).toMatchObject({ kind: "refused", reason: "process_unobservable" });
});

test("a cyclic ancestry refuses instead of exhausting into no server", () => {
  const f = fixture(); f.processes.get(20)!.ppid = 30;
  expect(f.run()).toMatchObject({ kind: "refused", reason: "process_unobservable" });
});

for (const args of ["/bin/opencode --log-level debug serve --service", "/Applications/Open Code/opencode serve --service"]) {
  test(`global options and spaced executable paths retain the server boundary: ${args}`, () => {
    const f = fixture(); f.processes.get(10)!.args = args;
    expect(f.run()).toMatchObject({ kind: "verified" });
  });
}

test("verified evidence never carries the service credential", () => {
  const f = fixture(); f.service.password = "fixture-secret";
  const result = f.run();
  expect(result.kind).toBe("verified");
  expect(JSON.stringify(result)).not.toContain("fixture-secret");
});

test("plain serve and unregistered shared services refuse", () => {
  const f = fixture(); f.processes.get(10)!.args = "/bin/opencode serve --port 12345";
  expect(f.run()).toMatchObject({ kind: "refused" });
  f.processes.get(10)!.args = "/bin/opencode serve --service"; f.io.service = () => null;
  expect(f.run()).toMatchObject({ kind: "refused", reason: "service_unverified" });
});

test("the proven private server shape keeps the physical pane path", () => {
  const f = fixture(); f.processes.get(10)!.args = "/bin/opencode serve --stdio --port 0";
  f.processes.get(10)!.ppid = 5;
  f.processes.set(5, { pid: 5, ppid: 1, start: 99000, command: "/bin/opencode", args: "/bin/opencode --standalone --session ses_alpha" });
  expect(f.run()).toEqual({ kind: "none" });
  f.processes.get(5)!.command = "/bin/sh"; f.processes.get(5)!.args = "sh";
  expect(f.run()).toMatchObject({ kind: "refused" });
});

for (const arm of ["duplicate", "exited", "old-pid", "future-pid", "api-failure", "wrong-service", "remote"] as const) {
  test(`refuses ${arm} native evidence`, () => {
    const f = fixture();
    if (arm === "duplicate") f.shells.push({ ...f.shells[0], id: "sh_duplicate" });
    if (arm === "exited") f.shells[0].status = "exited";
    if (arm === "old-pid") f.processes.get(20)!.start = 90000;
    if (arm === "future-pid") f.processes.get(20)!.start = 110000;
    if (arm === "api-failure") f.io.api = () => { throw new Error("unavailable"); };
    if (arm === "wrong-service") f.service.start = 90000;
    if (arm === "remote") f.service.url = "http://example.com:12345";
    expect(f.run()).toMatchObject({ kind: "refused" });
  });
}

test("child shell maps to its server-reported root, never the env's parent", () => {
  const f = fixture(); f.sessions.ses_child = { id: "ses_child", parentID: "ses_alpha", location: { directory: "/project" } };
  f.shells[0].metadata.sessionID = "ses_child";
  expect(f.run("ses_child")).toMatchObject({ kind: "verified", sessionId: "ses_child", rootSessionId: "ses_alpha" });
  f.sessions.ses_alpha.parentID = "ses_child";
  expect(f.run("ses_child")).toMatchObject({ kind: "refused", reason: "session_ancestry" });
});

test("process rebirth while the API answers invalidates the witness", () => {
  const f = fixture(), api = f.io.api;
  f.io.api = (service, path) => { const answer = api(service, path); f.processes.get(20)!.start = 105000; return answer; };
  expect(f.run()).toMatchObject({ kind: "refused" });
});

test("service instance changes while the API answers invalidate the witness", () => {
  const f = fixture(), api = f.io.api;
  f.io.api = (service, path) => { const answer = api(service, path); f.service.id = "successor"; return answer; };
  expect(f.run()).toMatchObject({ kind: "refused" });
});
