import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { sessionCreatedArgv } from "../src/verbs/provenance";

const tmux = Bun.which("tmux");
const socket = `prov-target-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
const run = (args: string[]) => spawnSync(tmux!, ["-L", socket, ...args], { encoding: "utf8", timeout: 10_000 });

afterAll(() => {
  if (tmux) run(["kill-server"]);
});

test("the session-created read targets the exact session with a trailing colon", () => {
  // Every seat session is `<team>/<handle>`; the argv is what tmux receives.
  expect(sessionCreatedArgv("alpha/boss")).toEqual(["display-message", "-p", "-t", "=alpha/boss:", "#{session_created}"]);
  expect(sessionCreatedArgv("plain")).toEqual(["display-message", "-p", "-t", "=plain:", "#{session_created}"]);
});

test.skipIf(!tmux)("the argv reads a non-empty creation time for a slash-named session; the bare form reads nothing", () => {
  expect(run(["new-session", "-d", "-s", "alpha/boss", "exec /bin/sleep 60"]).status).toBe(0);
  const exact = run(sessionCreatedArgv("alpha/boss"));
  expect({ status: exact.status, seconds: /^\d+$/.test(exact.stdout.trim()) }).toEqual({ status: 0, seconds: true });
  // Control for the bug this pins: the bare `=session` target exits 0 and prints nothing.
  const bare = run(["display-message", "-p", "-t", "=alpha/boss", "#{session_created}"]);
  expect(bare.stdout.trim()).toBe("");
});
