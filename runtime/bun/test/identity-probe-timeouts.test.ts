import { afterEach, expect, spyOn, test } from "bun:test";
import { libprocRow } from "../src/proc-row";
import * as childProcess from "node:child_process";
import { gitCommonDir } from "../src/context";
import { withReportingMemo } from "../src/invocation-memo";
import { parentPid, processRow } from "../src/process-ancestry";

const restores: Array<() => void> = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });

for (const probe of ["row", "parent", "reporting-row", "git"] as const)
test(`identity ${probe} bounds and kills its child and refuses timeout evidence`, () => {
  const timeout = Object.assign(new Error("probe timed out"), { code: "ETIMEDOUT" });
  const calls: Array<{ command: string; options: childProcess.SpawnSyncOptions }> = [];
  const spawn = spyOn(childProcess, "spawnSync").mockImplementation(((command: string, _args: string[], options: childProcess.SpawnSyncOptions) => {
    calls.push({ command, options });
    return { error: timeout, status: null, signal: "SIGKILL", pid: 0,
      stdout: probe === "git" ? "/tmp\n" : `${process.ppid} tty-timeout\n`, stderr: "", output: [] };
  }) as unknown as typeof childProcess.spawnSync);
  restores.push(() => spawn.mockRestore());
  // A live pid makes a mistaken kernel fallback observable, rather than looking absent.
  const result = probe === "git" ? gitCommonDir("/tmp", process.env)
    : probe === "parent" ? parentPid(process.pid)
    : probe === "reporting-row" ? withReportingMemo(() => processRow(process.pid)) : processRow(process.pid);
  const kernel = libprocRow(process.pid);
  const fields = kernel?.split(/[ \t]+/);
  const expected = probe === "git" ? null : probe === "parent" ? fields?.[0] ?? ""
    : fields ? { ppid: fields[0] ?? "", tty: fields[1] ?? "" } : undefined;
  expect(result).toEqual(expected);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.command).toBe(probe === "git" ? "git" : "ps");
  expect(calls[0]!.options.timeout).toBeGreaterThan(0);
  expect(calls[0]!.options.timeout).toBeLessThanOrEqual(5000);
  expect(calls[0]!.options.killSignal).toBe("SIGKILL");
});
