// Port of goalie-heartbeat-cron.test.sh — who watches the watcher (tap-ulyr).
// watchers/goalie-heartbeat.ts is a standalone cron/LaunchAgent entry no
// bin/tap verb wraps, so the port enters its main(argv) door in-process, with
// only the notifier left as a child process (the configured
// TAP_NOTIFY_USER_BIN, stubbed here). The shell file's arms — including the
// source dependency guard, the legacy numeric/notifier matrix, the exact
// notifier argv, and the fixed notification deadline — move here; the
// standalone-environment arm runs the entry as a fresh child under a stripped
// env, the shape launchd runs. Cross-process persistence and edge transitions
// stay covered by goalie-heartbeat.test.ts.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/watchers/goalie-heartbeat";

const savedEnv: Array<[string, string | undefined]> = [];
const allEnv: Array<[string, string | undefined]> = [];
let work = "";
let home = "";
let fakeBin = "";
let notifyLog = "";

const goalie = () => join(home, "goalie");
const armPath = () => join(goalie(), "arm.json");
const stampPath = () => join(goalie(), "heartbeat");
const alarmPath = () => join(goalie(), "heartbeat-alarm.json");

function fixture(): void {
  if (work) return;
  for (const key of ["TAP_HOME", "TAP_GOALIE_NOW", "TAP_NOTIFY_USER_BIN", "FAKE_NOTIFY_LOG"]) {
    savedEnv.push([key, process.env[key]]);
  }
  work = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "hb-cron-"));
  home = join(work, "bus");
  fakeBin = join(work, "bin");
  mkdirSync(goalie(), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  notifyLog = join(work, "notify.log");
  writeFileSync(join(fakeBin, "notify-user"), `#!/bin/bash
printf '%s\\n' "$@" >> "${notifyLog}"
`);
  chmodSync(join(fakeBin, "notify-user"), 0o755);
  process.env.TAP_NOTIFY_USER_BIN = join(fakeBin, "notify-user");
  process.env.FAKE_NOTIFY_LOG = notifyLog;
  process.env.TAP_GOALIE_NOW = "1000000";
  process.env.TAP_HOME = home;
  writeFileSync(notifyLog, "");
}

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const NOW = "1000000";

function armLease(): void {
  writeFileSync(armPath(), `{"armed_by":"fable","armed_at":${Number(NOW) - 5000},"tick_interval_seconds":60}\n`);
}

function stamp(text: string): void {
  writeFileSync(stampPath(), `${text}\n`);
}

/** One invocation = a new alarm edge, as each cron fire is its own process. */
async function run(...args: string[]): Promise<{ rc: number; out: string }> {
  rmSync(alarmPath(), { force: true });
  truncateSync(notifyLog, 0);
  const lines: string[] = [];
  const log = process.stdout.write;
  const err = process.stderr.write;
  const say = (chunk?: string | Uint8Array): boolean => { lines.push(String(chunk)); return true; };
  process.stdout.write = say;
  process.stderr.write = say;
  const logFn = console.log;
  console.log = (...parts: unknown[]) => { say(parts.join(" ") + "\n"); };
  try {
    const rc = await main(["--home", home, ...args]);
    return { rc, out: lines.join("") };
  } finally {
    console.log = logFn;
    process.stdout.write = log;
    process.stderr.write = err;
  }
}

const notified = (): boolean => readFileSync(notifyLog, "utf8").length > 0;

async function check(expected: number, notification: "yes" | "no", ...args: string[]): Promise<string> {
  const { rc, out } = await run(...args);
  expect(rc).toBe(expected);
  expect(notified()).toBe(notification === "yes");
  return out;
}

test("(0) the watchdog does not depend on the bus it watches", () => {
  fixture();
  const source = readFileSync(join(import.meta.dir, "../src/watchers/goalie-heartbeat.ts"), "utf8")
    .split("\n").map((line) => line.replace(/\/\/.*/, "")).join("\n");
  expect(source).not.toMatch(/tap-send|tap send|tap-escalate|tap\.sh|resolveContext|registry|tmux|goalie-lease/);
});

test("(1-4) disarmed is quiet; never-stamped and stopped ticks alarm; a fresh stamp is silent", async () => {
  fixture();
  // (1) a disarmed goalie is quiet and exits clean
  rmSync(armPath(), { force: true });
  rmSync(stampPath(), { force: true });
  let { rc, out } = await run();
  expect(rc).toBe(0);
  expect(notified()).toBe(false);
  expect(out).toContain("disarmed");
  // (2) armed but never stamped alarms
  armLease();
  rmSync(stampPath(), { force: true });
  ({ rc } = await run());
  expect(rc).toBe(1);
  expect(notified()).toBe(true);
  // (3) a fresh stamp is healthy and silent
  stamp(String(Number(NOW) - 30));
  ({ rc } = await run());
  expect(rc).toBe(0);
  expect(notified()).toBe(false);
  // (4) a stopped tick alarms; the default limit tracks the lease interval
  stamp(String(Number(NOW) - 4000));
  ({ rc } = await run());
  expect(rc).toBe(1);
  expect(notified()).toBe(true);
});

test("(5) unreadable and future stamps alarm rather than pass", async () => {
  fixture();
  armLease();
  stamp("not-a-number");
  expect((await run()).rc).toBe(1);
  stamp(String(Number(NOW) + 9000));
  expect((await run()).rc).toBe(1);
});

test("(6) an unreachable human is reported, never swallowed", async () => {
  fixture();
  armLease();
  stamp(String(Number(NOW) - 4000));
  const saved = process.env.TAP_NOTIFY_USER_BIN;
  try {
    process.env.TAP_NOTIFY_USER_BIN = "/nonexistent/notify-user";
    const { rc, out } = await run();
    expect(rc).toBe(2);
    // tap-0hvq: the misconfiguration is now diagnosed before any alarm work.
    expect(out).toContain("notifier-unavailable");
    expect(existsSync(alarmPath())).toBe(false);
  } finally {
    if (saved === undefined) delete process.env.TAP_NOTIFY_USER_BIN;
    else process.env.TAP_NOTIFY_USER_BIN = saved;
  }
});

test("(7) disarmed precedence, arm symlink and invalid numeric overrides", async () => {
  fixture();
  rmSync(join(goalie(), "real-arm.json"), { force: true });
  const { renameSync, symlinkSync, mkdirSync, rmdirSync } = require("node:fs") as typeof import("node:fs");
  armLease();
  renameSync(armPath(), join(goalie(), "real-arm.json"));
  // Disarm wins over a malformed clock and a malformed limit, silently.
  process.env.TAP_GOALIE_NOW = "bad";
  let out = await check(0, "no", "--max-age", "bad", "--quiet");
  expect(out).toBe("");
  // A nonregular arm file is not an arm: still disarmed.
  mkdirSync(armPath());
  await check(0, "no", "--max-age", "bad");
  rmdirSync(armPath());
  symlinkSync(join(goalie(), "real-arm.json"), armPath());
  await check(64, "no");
  process.env.TAP_GOALIE_NOW = NOW;
  await check(64, "no", "--max-age", "bad");
  await check(64, "no", "--max-age", "9007199254740992");
  process.env.TAP_GOALIE_NOW = "9007199254740992";
  await check(64, "no");
  process.env.TAP_GOALIE_NOW = NOW;
});

test("(8) decimal timestamps, safe arithmetic, signed limits, quiet and repeated alerts", async () => {
  fixture();
  armLease();
  stamp("999700");
  await check(0, "no", "--max-age", "300");
  let out = await check(1, "yes", "--max-age", "299", "--quiet");
  expect(out).toBe("");
  await check(1, "yes", "--max-age", "299");
  stamp("1000000");
  out = await check(0, "no", "--max-age", "0", "--quiet");
  expect(out).toBe("");
  await check(1, "yes", "--max-age", "-1");
  stamp("0999970\njunk second line\n");
  out = await check(0, "no");
  expect(out).toContain("last fire 30s ago");
  stamp("03641070");
  await check(1, "yes");
  process.env.TAP_GOALIE_NOW = "01000000";
  stamp("999970");
  await check(0, "no");
  process.env.TAP_GOALIE_NOW = NOW;
  for (const bad of ["18446744073710551586", "9007199254740992", "-1", "not-a-number", "999970\r", "﻿999970"]) {
    stamp(bad);
    await check(1, "yes");
  }
  stamp("999\u0000970");
  await check(1, "yes");
  process.env.TAP_GOALIE_NOW = "-9007199254740991";
  stamp("1");
  out = await check(1, "yes");
  expect(out).toContain("safe integer range");
  process.env.TAP_GOALIE_NOW = "9007199254740991";
  stamp("9007199254740991");
  await check(0, "no");
  process.env.TAP_GOALIE_NOW = NOW;
});

test("(9) interval conversion, unsafe multiplication and strict arm decoding", async () => {
  fixture();
  armLease();
  stamp("999500");
  for (const interval of [200, 200.9, '"200"', '"2_00"', '"２００"']) {
    writeFileSync(armPath(), `{"tick_interval_seconds":${interval}}\n`);
    const out = await check(0, "no");
    expect(out).toContain("limit 600s");
  }
  for (const interval of [0, null, false, true, -1, [], {}, [200], "200.9", 18446744073709551616, 3002399751580331]) {
    writeFileSync(armPath(), `{"tick_interval_seconds":${JSON.stringify(interval)}}\n`);
    await check(1, "yes");
  }
  writeFileSync(armPath(), '{"tick_interval_seconds":true}\n');
  let out = await check(1, "yes");
  expect(out).toContain("tick interval 1s");
  writeFileSync(armPath(), '{"tick_interval_seconds":0.5}\n');
  out = await check(1, "yes");
  expect(out).toContain("tick interval 0s");
  // Malformed arms are byte-level faults: a visible BOM is not JSON, and a
  // lone 0xFF byte is invalid UTF-8 — the fatal decoder refuses both, exactly
  // as Python's json.loads did.
  const badUtf8 = new Uint8Array([
    ...Buffer.from('{"x":"', "utf8"), 0xff, ...Buffer.from('","tick_interval_seconds":200}', "utf8"),
  ]);
  for (const arm of ["\uFEFF{\"tick_interval_seconds\":200}", badUtf8, "{bad"]) {
    writeFileSync(armPath(), arm);
    out = await check(1, "yes");
    expect(out).toContain("tick interval 60s");
  }
});

test("(10) standalone environment, exact notifier argv, failing notifier, help and usage", async () => {
  fixture();
  armLease();
  stamp("996000");
  rmSync(alarmPath(), { force: true });
  truncateSync(notifyLog, 0);
  // The launchd shape: a FRESH process under a stripped environment, where a
  // module-scope read of the world sees only these pins. An in-process call
  // cannot certify this — the module and its imports already loaded under the
  // runner's full env, so an environment read at module scope would pass here
  // and crash the real cron (partner I2: that mutant survives in-process).
  const result = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "../src/watchers/goalie-heartbeat.ts"), "--home", home],
    {
      env: {
        PATH: "/usr/bin:/bin",
        TAP_HOME: home,
        TAP_GOALIE_NOW: "1000000",
        TAP_NOTIFY_USER_BIN: join(fakeBin, "notify-user"),
        FAKE_NOTIFY_LOG: notifyLog,
      },
    },
  );
  expect(result.exitCode).toBe(1);
  // The exact notifier argv is preserved through to the configured executable.
  expect(readFileSync(notifyLog, "utf8").split("\n").filter(Boolean)).toEqual([
    "--template", "question", "--",
    "TAP goalie tick is not running: last fire was 4000s ago (limit 300s, tick interval 60s) — the board has no deadlock detector right now",
  ]);
  expect((await run("--help")).rc).toBe(0);
  expect((await run("--unknown")).rc).toBe(64);
  // A watchdog that cannot reach the human must SAY so, with its own exit code.
  writeFileSync(join(fakeBin, "failing"), "#!/bin/sh\nexit 7\n");
  chmodSync(join(fakeBin, "failing"), 0o755);
  const saved = process.env.TAP_NOTIFY_USER_BIN;
  try {
    process.env.TAP_NOTIFY_USER_BIN = join(fakeBin, "failing");
    const { rc, out } = await run();
    expect(rc).toBe(2);
    expect(notified()).toBe(false);
    expect(out).toContain("delivery is unconfirmed");
  } finally {
    if (saved === undefined) delete process.env.TAP_NOTIFY_USER_BIN;
    else process.env.TAP_NOTIFY_USER_BIN = saved;
  }
});

test("(11) a hanging notifier meets the deadline wiring: one attempt, rc 2, delivery unknown", async () => {
  fixture();
  armLease();
  stamp(String(Number(NOW) - 4000));
  // TERM-resistant, as the shell arm's was: only the deadline's SIGKILL ends it.
  writeFileSync(join(fakeBin, "hanging"), `#!/bin/bash
trap '' TERM
printf 'started\\n' >> "${notifyLog}"
sleep 30
`);
  chmodSync(join(fakeBin, "hanging"), 0o755);
  const saved = process.env.TAP_NOTIFY_USER_BIN;
  const savedTimeout = process.env.TAP_NOTIFY_TIMEOUT_SECONDS;
  try {
    process.env.TAP_NOTIFY_USER_BIN = join(fakeBin, "hanging");
    // The legacy override deadline is a fixed 20s (pinned as a unit fact in
    // notifications.test.ts); the timeout override trims the wall here without
    // touching the wiring under test.
    process.env.TAP_NOTIFY_TIMEOUT_SECONDS = "1";
    const started = Date.now();
    const { rc, out } = await run();
    expect(Date.now() - started).toBeLessThan(10000);
    expect(rc).toBe(2);
    expect(out).toContain("delivery is unknown");
    // exactly one attempt was recorded
    expect(readFileSync(notifyLog, "utf8").split("\n").filter(Boolean)).toEqual(["started"]);
  } finally {
    if (saved === undefined) delete process.env.TAP_NOTIFY_USER_BIN;
    else process.env.TAP_NOTIFY_USER_BIN = saved;
    if (savedTimeout === undefined) delete process.env.TAP_NOTIFY_TIMEOUT_SECONDS;
    else process.env.TAP_NOTIFY_TIMEOUT_SECONDS = savedTimeout;
  }
});
