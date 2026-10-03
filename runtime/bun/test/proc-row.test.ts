// The libproc process-row fallback used when `ps` cannot run (Codex auto sandbox; tap-21bdj).
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { libprocRow, type Libc } from "../src/proc-row";
import { observeCallingPane } from "../src/context";

const darwin = process.platform === "darwin";

test.skipIf(!darwin)("libprocRow matches `ps` for this process and its parent", () => {
  for (const pid of [process.pid, process.ppid]) {
    const ps = spawnSync("ps", ["-o", "ppid=", "-o", "tty=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim().split(/\s+/);
    expect(libprocRow(pid)).toBe(`${ps[0]} ${ps[1]}`);
  }
});

test.skipIf(!darwin)("libprocRow refuses a pid that does not exist", () => {
  expect(libprocRow(0x7ffffff0)).toBeNull();
});

test("libprocRow is null off Darwin", () => {
  if (darwin) return;
  expect(libprocRow(process.pid)).toBeNull();
});

test.skipIf(!darwin)("the caller-pane walk survives a `ps` that cannot run", () => {
  // An empty PATH makes spawning `ps` fail outright, as the sandbox's setuid-exec denial does.
  const seen = observeCallingPane({ PATH: "/nonexistent" });
  const refusal = seen.state === "unobservable" ? seen.refusal : "";
  expect(refusal).not.toContain("process observation unavailable");
});

test("a throwing or failing native call yields null, never a throw", () => {
  const throwing: Libc = { pidinfo: () => { throw new Error("ffi"); }, devname: () => { throw new Error("ffi"); } };
  expect(libprocRow(process.pid, throwing)).toBeNull();
  // pidinfo succeeds with an all-zero record (tdev 0 is a real device, not NODEV), then devname throws.
  const half: Libc = { pidinfo: () => 136, devname: () => { throw new Error("devname"); } };
  expect(libprocRow(process.pid, half)).toBeNull();
  expect(libprocRow(process.pid, { pidinfo: () => -1, devname: () => 0 })).toBeNull();
  expect(libprocRow(process.pid, null)).toBeNull();
});
