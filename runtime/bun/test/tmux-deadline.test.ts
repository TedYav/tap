import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { submitVerifyLocked, type PaneEffects } from "../src/courier";
import { ServerUnresponsive, tmux, tmuxReadOnly } from "../src/tmux";
import { enrollScratchRoot } from "./support/enroll-scratch";
import { removeScratchTree } from "./support/scratch";

test("timeout propagates through submit without a second Enter", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-deadline."));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const calls = join(root, "calls");
  writeFileSync(join(bin, "tmux"), `#!/usr/bin/env python3
import os, sys, time
with open(os.environ['DEADLINE_CALLS'], 'a') as stream:
    stream.write(' '.join(sys.argv[1:]) + '\\n')
time.sleep(2)
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: root,
    TAP_INDEX_HOME: join(root, "index"), TAP_TMUX_SOCKET_PATH: join(mkdtempSync(join(process.env.TMUX_TMPDIR!, "s.")), "tmux"),
    TAP_TMUX_TIMEOUT_SECONDS: "0.5", DEADLINE_CALLS: calls };
  try {
    expect(() => tmuxReadOnly(["capture-pane", "-t", "%999", "-p"], env)).toThrow(ServerUnresponsive);
    writeFileSync(calls, "");
    const fx: PaneEffects = {
      observePane: () => ({ paneId: "%999", session: "fixture", serverEpoch: "1:1", panePid: "1", currentCommand: "codex" }),
      paneState: () => ({ state: "ready" }), injectText: () => true,
      inputHasId: () => true, settle: () => {},
      pressEnter: target => tmux(["send-keys", "-t", target, "Enter"], env).code === 0,
    };
    expect(() => submitVerifyLocked("%999", "id", "sentinel", undefined, fx)).toThrow(ServerUnresponsive);
    const lines = readFileSync(calls, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("send-keys -t %999 Enter");
  } finally { removeScratchTree(root); }
}, 10000);


test("fork ENXIO is a server refusal, not pane loss, and is not retried", () => {
 const root = mkdtempSync(join(tmpdir(), "tap-enxio."));
 const bin = join(root, "bin"); mkdirSync(bin);
 const calls = join(root, "calls");
 writeFileSync(join(bin, "tmux"), `#!/usr/bin/env bash
printf 'call\\n' >> "$DEADLINE_CALLS"
printf '%s\\n' "$ENXIO_ERROR" >&2
exit 1
`, {mode: 0o755});
 const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: root,
   TAP_INDEX_HOME: join(root,"index"), TAP_TMUX_SOCKET_PATH: join(mkdtempSync(join(process.env.TMUX_TMPDIR!, "s.")), "tmux"),
   DEADLINE_CALLS: calls, ENXIO_ERROR: "respawn pane failed: fork failed: Device not configured"};
 try {
   let failure: unknown;
   try { tmux(["respawn-pane", "-t", "%999"], env); } catch (error) { failure = error; }
   expect(failure).toBeInstanceOf(ServerUnresponsive);
   expect(String(failure)).toContain("fork failed: Device not configured");
   expect(String(failure)).toContain("load1m=");
   expect(readFileSync(calls,"utf8").trim().split("\n")).toHaveLength(1);
   const ordinary = tmux(["has-session", "-t", "missing"], {...env, ENXIO_ERROR: "can't find pane: missing"});
   expect(ordinary.code).toBe(1);
   expect(ordinary.stderr).toContain("can't find pane");
 } finally { removeScratchTree(root); }
});


test("launcher JSON preserves the tmux refusal class and action", () => {
 const transaction = resolve(import.meta.dir, "../src/launcher/transaction.ts");
 const launch = resolve(import.meta.dir, "../src/launcher/new.ts");
 const adapter = resolve(import.meta.dir, "../src/tmux.ts");
 const root = realpathSync(mkdtempSync(join(tmpdir(), "tap-deadline-launch-")));
 try {
  spawnSync("git", ["init", "-q", root]);
  // Launch refuses an unenrolled root before its transaction (F2a), so enroll
  // a scratch root: the mocked transaction is the refusal under test.
  const index = join(root, "index");
  enrollScratchRoot(root, index);
  // The smoke wrapper puts a slow tmux mock first on PATH; the namespace
  // snapshot before the transaction needs a tmux that answers "no server".
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "tmux"), "#!/bin/sh\necho 'no server running on /fixture/tmux' >&2\nexit 1\n", { mode: 0o755 });
  const script = `
  import {mock} from 'bun:test';
  const {ServerUnresponsive} = await import(${JSON.stringify(adapter)});
  const real = await import(${JSON.stringify(transaction)});
  mock.module(${JSON.stringify(transaction)}, () => ({ ...real,
    launchTransaction: async () => { throw new ServerUnresponsive('/private/fixture.sock','unknown','tmux fork failed: Device not configured; load1m=1.00'); },
  }));
  const {cmdSessionLaunch} = await import(${JSON.stringify(launch)});
  process.exitCode = await cmdSessionLaunch(['claude', '--dry-run', '--json']);
  `;
  const env = Object.fromEntries(Object.entries({ ...process.env, PATH: `${bin}:${process.env.PATH}`, TAP_INDEX_HOME: index, TAP_HOME: undefined, TAP_JSON: undefined }).filter(([, v]) => v !== undefined)) as Record<string, string>;
  const result = spawnSync(process.execPath, ['-e', script], {cwd: root, env, encoding:'utf8'});
  expect(result.status, result.stderr).toBe(2);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toMatchObject({ok:false,error_class:'server_unresponsive',action:'inspect the server; do not retry a possible effect'});
 } finally { removeScratchTree(root); }
});
