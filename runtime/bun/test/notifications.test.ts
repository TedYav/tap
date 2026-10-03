import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { notificationAvailability, notificationCommand, notificationSettings } from "../src/notifications";
import { removeScratchTree } from "./support/scratch";
import { parseDocument } from "../src/launcher/catalog-listing";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) removeScratchTree(dir); });
function fixture(text?: string) {
  const dir = mkdtempSync(join(process.env.TMUX_TMPDIR!, "notifier.")); scratch.push(dir);
  mkdirSync(join(dir, "tap"));
  const config = join(dir, "tap/config.toml");
  if (text !== undefined) writeFileSync(config, text, { mode: 0o600 });
  const env = { ...process.env, XDG_CONFIG_HOME: dir, TAP_NOTIFY_USER_BIN: "", TAP_NOTIFY_TIMEOUT_SECONDS: "", PATH: dir };
  return { dir, config, env };
}

test("the launcher recognizes the additive notifications table without changing preset parsing", () => {
  const notices: string[] = [];
  const doc = parseDocument(Buffer.from('version=3\n[notifications]\nnotifier="system"\n[presets.p]\nharness="codex"\n'), "config.toml", text => notices.push(text));
  expect(doc.notifications).toEqual({ notifier: "system" });
  expect(doc.presets).toEqual({ p: { harness: "codex" } });
  expect(notices).toEqual([]);
});

test("standalone heartbeat uses configured command and escapes NUL without needing a registry", () => {
  const f = fixture(), log = join(f.dir, "argv"), command = join(f.dir, "stub");
  writeFileSync(command, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
  writeFileSync(f.config, '[notifications]\nnotifier="command"\ncommand=' + JSON.stringify([command, "{body}", "{urgency}"]) + '\n');
  const bus = join(f.dir, "bus"); mkdirSync(join(bus, "goalie"), { recursive: true });
  writeFileSync(join(bus, "goalie/arm.json"), JSON.stringify({ armed_at: "hostile\0body" }));
  const result = spawnSync(process.execPath, [join(import.meta.dir, "../src/watchers/goalie-heartbeat.ts"), "--home", bus], {
    env: { ...f.env, PATH: process.env.PATH, TAP_GOALIE_NOW: "1000000" }, encoding: "utf8", timeout: 5000,
  });
  expect(result.status, result.stderr).toBe(1);
  expect(JSON.parse(readFileSync(log, "utf8"))).toEqual(["TAP goalie tick is not running: armed since hostile\\0body but has never completed a fire — the board has no deadlock detector right now", "routine"]);
});

test("absent settings default to platform notifications; availability inspection has no effect", () => {
  const f = fixture();
  expect(notificationSettings(f.env)).toMatchObject({ notifier: "system", source: "default", seconds: 20 });
  for (const [platform, binary] of [["darwin", "osascript"], ["linux", "notify-send"]]) {
    expect(notificationAvailability(f.env, platform)).toMatchObject({ available: false, requested: binary });
    writeFileSync(join(f.dir, binary!), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
    expect(notificationAvailability(f.env, platform)).toMatchObject({ available: true, source: "default" });
  }
  expect(notificationAvailability(f.env, "darwin").limitation).toContain("terminal app's notification permission");
  expect(() => notificationAvailability(f.env, "win32")).toThrow("unavailable on win32");
});

test("both system commands keep hostile body out of code and convey urgency", () => {
  const settings = notificationSettings(fixture().env);
  const notice = { title: "TAP escalation", body: '-- $(bad) " & {title}', urgent: true };
  const mac = notificationCommand(settings, notice, "darwin");
  expect(mac[0]).toBe("osascript");
  expect(mac[2]).not.toContain(notice.body);
  expect(mac.slice(-3)).toEqual(["--", notice.title, notice.body]);
  expect(notificationCommand(settings, notice, "linux")).toEqual(["notify-send", "--urgency", "critical", "--", notice.title, notice.body]);
  expect(notificationCommand(settings, { ...notice, urgent: false }, "linux")[2]).toBe("normal");
});

test("malformed config refuses; override bypasses it and keeps the legacy argv contract", () => {
  const f = fixture("[broken");
  expect(() => notificationSettings(f.env)).toThrow("cannot read notification config");
  // The legacy override's deadline is a fixed 20s — the launchd path's hard
  // ceiling, load-bearing for the hanging-notifier arm in
  // goalie-heartbeat-cron.test.ts.
  expect(notificationSettings({ ...f.env, TAP_NOTIFY_USER_BIN: "stub" }))
    .toMatchObject({ source: "override", legacy: "stub", seconds: 20 });
  const settings = notificationSettings({ ...f.env, TAP_NOTIFY_USER_BIN: "stub", TAP_NOTIFY_TIMEOUT_SECONDS: "3" });
  expect(settings).toMatchObject({ source: "override", seconds: 3 });
  expect(notificationCommand(settings, { title: "ignored", body: "literal", urgent: false })).toEqual(["stub", "--template", "question", "--", "literal"]);
  expect(notificationCommand(settings, { title: "ignored", body: "literal", urgent: true })).toEqual(["stub", "--template", "question", "--priority", "urgent", "--", "literal"]);
});

test("invalid schemas, unsafe config permissions and invalid timeouts refuse before execution", () => {
  for (const value of ['notifier="typo"', 'command=[]', 'command=[7]', 'command=[""]', 'notifier="command"',
    'command=["{body}"]', 'command=["cmd","prefix{body}"]', 'command=["cmd","{unknown}"]',
    'command=["cmd","\\u0000"]', 'timeout_seconds=0', 'timeout_seconds=-1', 'timeout_seconds=2147484',
    'timeout_seconds="20"', 'timeout_seconds=1.5', 'typo="command"']) {
    expect(() => notificationSettings(fixture(`[notifications]\n${value}\n`).env), value).toThrow();
  }
  expect(() => notificationSettings(fixture('notifications="system"').env)).toThrow();
  const f = fixture('[notifications]\nnotifier="system"\n');
  chmodSync(f.config, 0o666);
  expect(() => notificationSettings(f.env)).toThrow("cannot read notification config");
  for (const timeout of ["0", "-1", "NaN", "2147484"]) {
    expect(() => notificationSettings({ ...f.env, TAP_NOTIFY_USER_BIN: "stub", TAP_NOTIFY_TIMEOUT_SECONDS: timeout })).toThrow();
  }
});
