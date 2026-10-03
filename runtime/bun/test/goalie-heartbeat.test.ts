import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireFlock } from "../src/remind-lock";

const leaf = resolve(import.meta.dir, "../src/watchers/goalie-heartbeat.ts");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR!, "hb.")); roots.push(root);
  const goalie = join(root, "goalie"), log = join(root, "notify.log"), notifier = join(root, "notify");
  mkdirSync(goalie);
  writeFileSync(join(goalie, "arm.json"), '{"armed_at":1,"alarm_generation":"episode-one","tick_interval_seconds":60}');
  const alarm = join(goalie, "heartbeat-alarm.json");
  writeFileSync(notifier, `#!${process.execPath}\nimport {appendFileSync,readFileSync} from 'node:fs';\nconst state=JSON.parse(readFileSync(${JSON.stringify(alarm)},'utf8'));\nif(state.status!==2 || state.attempted_at!==Number(process.env.TAP_GOALIE_NOW)) process.exit(77);\nappendFileSync(${JSON.stringify(log)}, 'attempt\\n');\nprocess.exit(Number(process.env.NOTIFY_STATUS || 0));\n`, { mode: 0o700 });
  const run = (now = 10000, status = 0) => spawnSync(process.execPath, [leaf, "--home", root], {
    env: { ...process.env, TAP_GOALIE_NOW: String(now), TAP_NOTIFY_USER_BIN: notifier, NOTIFY_STATUS: String(status) },
    encoding: "utf8", timeout: 5000,
  });
  const count = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0;
  const healthy = (now = 10000) => writeFileSync(join(goalie, "heartbeat"), String(now));
  return { root, goalie, alarm, run, count, healthy };
}
test("records attempt before effect, suppresses next process, reminds at one hour", () => {
  const f = fixture();
  expect(f.run().status).toBe(1);
  expect(f.count()).toBe(1);
  expect(f.run(10060).stdout).toContain("notification suppressed");
  expect(f.run(13599).status).toBe(1);
  expect(f.count()).toBe(1);
  expect(f.run(13600).status).toBe(1);
  expect(f.count()).toBe(2);
});
test("healthy tick resets alarm and a later stale edge notifies", () => {
  const f = fixture(); f.run(); f.healthy();
  expect(f.run().status).toBe(0);
  expect(existsSync(f.alarm)).toBe(false);
  expect(f.run(10301).status).toBe(1);
  expect(f.count()).toBe(2);
});
test("failed notifier remains throttled with an unconfirmed status", () => {
  const f = fixture();
  expect(f.run(10000, 1).status).toBe(2);
  const next = f.run(10060);
  expect(next.status).toBe(2);
  expect(next.stdout).toContain("previous attempt unconfirmed");
  expect(f.count()).toBe(1);
});
test("same-second rearm starts a new alarm episode without a healthy observation", () => {
  const f = fixture(); f.run();
  writeFileSync(join(f.goalie, "arm.json"), '{"armed_at":1,"alarm_generation":"episode-two"}');
  expect(f.run(10060).status).toBe(1);
  expect(f.count()).toBe(2);
});
test("corrupt state and backwards clock preserve evidence without effects", () => {
  const f = fixture();
  writeFileSync(f.alarm, "{");
  expect(f.run().status).toBe(2);
  expect(f.count()).toBe(0);
  expect(readFileSync(f.alarm, "utf8")).toBe("{");
  writeFileSync(f.alarm, '{"generation":"episode-one","attempted_at":20000,"status":2}');
  expect(f.run().stdout).toContain("alarm-clock-invalid");
  expect(f.count()).toBe(0);
});
test("overlapping invocation cannot notify while another holds the alarm lock", () => {
  const f = fixture();
  const lock = acquireFlock(f.alarm + ".lock", 0, true)!;
  try {
    const r = f.run();
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("alarm-state-busy");
    expect(f.count()).toBe(0);
  } finally { lock.release(); }
  expect(f.run().status).toBe(1);
  expect(f.count()).toBe(1);
});
test("unwritable state refuses before possible notification", () => {
  const f = fixture(); mkdirSync(f.alarm);
  expect(f.run().status).toBe(2);
  expect(f.count()).toBe(0);
});
test("armed with an unusable notifier fails loud before any alarm state, even with --quiet", () => {
  const f = fixture(); f.healthy();
  for (const extra of [[], ["--quiet"]]) {
    const r = spawnSync(process.execPath, [leaf, "--home", f.root, ...extra], {
      env: { ...process.env, TAP_GOALIE_NOW: "10000", TAP_NOTIFY_USER_BIN: join(f.root, "no-such-notifier") },
      encoding: "utf8", timeout: 5000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("notifier-unavailable");
    expect(existsSync(f.alarm)).toBe(false);
    expect(existsSync(f.alarm + ".lock")).toBe(false);
    expect(f.count()).toBe(0);
  }
});
test("disarmed stays a no-op even with an unusable notifier", () => {
  const f = fixture(); rmSync(join(f.goalie, "arm.json"));
  const r = spawnSync(process.execPath, [leaf, "--home", f.root], {
    env: { ...process.env, TAP_NOTIFY_USER_BIN: join(f.root, "no-such-notifier") }, encoding: "utf8", timeout: 5000,
  });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("disarmed");
  expect(r.stderr).toBe("");
});
test("without HOME or XDG_CONFIG_HOME the notifier config root is unresolvable and an armed run refuses", () => {
  // Why the LaunchAgent plist must pin HOME: launchd supplies only PATH and TAP_HOME.
  const f = fixture(); f.healthy();
  const r = spawnSync(process.execPath, [leaf, "--home", f.root], {
    env: { PATH: process.env.PATH!, TAP_GOALIE_NOW: "10000" }, encoding: "utf8", timeout: 5000,
  });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("notifier-unavailable");
  expect(r.stderr).toMatch(/HOME|XDG_CONFIG_HOME/);
  expect(existsSync(f.alarm)).toBe(false);
});
