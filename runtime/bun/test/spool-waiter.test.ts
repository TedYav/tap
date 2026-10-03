import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deliveryClockPath, deliveryClockRead } from "../src/delivery-clock";
import { deliveryWait, runWaiter, waiterDeadline } from "../src/spool-waiter-loop";
import { WAITER_SOURCES } from "../src/spool-waiter";
import { serverEpochFromRaw } from "../src/tmux";
import { acquirePathLock } from "../src/panelock";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(meta: Record<string, unknown> = {}, engine = "return 0") {
  const home = mkdtempSync(join(tmpdir(), "waiter-")); roots.push(home);
  const spool = join(home, "spool"), scriptsDir = join(home, "skills/tap/scripts"), src = join(home, "runtime/bun/src");
  mkdirSync(spool); mkdirSync(scriptsDir, { recursive: true }); mkdirSync(src, { recursive: true }); mkdirSync(join(home, "receipts"));
  const registry = join(home, "registry.json");
  writeFileSync(registry, JSON.stringify({ team: { name: "fixture" } }));
  const metadata = join(spool, "m.meta.json"), payload = join(spool, "m.md"), lease = `${metadata}.reown`;
  writeFileSync(payload, "body");
  writeFileSync(metadata, JSON.stringify({ id: "m", target: "peer", target_registry: registry, to_team: "fixture", waiter_lifetime: "", ...meta }));
  mkdirSync(join(scriptsDir, "smoke"), { recursive: true });
  writeFileSync(join(scriptsDir, "smoke/runtime-helpers.sh"), `tap_spool_drain_once() {\n printf '%s|%s|%s|%s\\n' "$1" "$2" "$3" "$4" >> "$TAP_HOME/calls"\n ${engine}\n}\n`);
  // Record the real native entrance's argv; the scripted body answers this
  // scheduling-only test's engine status without sharing production drain code.
  writeFileSync(join(src, "spool-engine.ts"), `import {writeFileSync} from "node:fs";
const [scripts, op, ...args] = process.argv.slice(2);
if(op!=="drain") process.exit(99);
writeFileSync(process.env.TAP_HOME+"/engine-group",String(process.pid));
const child=Bun.spawn(["bash","-c",'. "$1/smoke/runtime-helpers.sh"; shift; tap_spool_drain_once "$@"',"waiter-fixture",scripts,...args],{stdin:"inherit",stdout:"inherit",stderr:"inherit"});
process.exitCode=await child.exited;`);
  const env: NodeJS.ProcessEnv = { ...process.env, TAP_HOME: home, TAP_INDEX_HOME: join(home, "index"), TAP_SPOOL_DELIVERER_DELAYS: "0 0 0", TAP_SPOOL_REOWN_TOKEN: undefined, TAP_SPOOL_NOW: undefined };
  const run = (refresh: Parameters<typeof runWaiter>[0]["refresh"] = () => null, argv = ["m"]) => runWaiter({ argv, scriptsDir, env, refresh });
  const calls = () => existsSync(join(home, "calls")) ? readFileSync(join(home, "calls"), "utf8").trim().split("\n") : [];
  return { home, spool, scriptsDir, registry, metadata, payload, lease, env, run, calls };
}

test("named lifetime ownership and boundary-clamped cadence preserve absent versus present", () => {
  for (const waiter_lifetime of ["readiness-gate", "autosettle-hold", "grace-window", "window"]) {
    expect(waiterDeadline({ waiter_lifetime, deadline_epoch: 50 })).toBe(50);
    expect(waiterDeadline({ waiter_lifetime, deadline_epoch: null })).toBe(0);
  }
  expect(waiterDeadline({ deadline_source: "readiness-gate", deadline_epoch: 50 })).toBe(50);
  for (const waiter_lifetime of ["", "typo", true, null]) {
    expect(waiterDeadline({ waiter_lifetime, deadline_source: "readiness-gate", deadline_epoch: 50 })).toBe(0);
  }
  expect(waiterDeadline({ policy: "polite", reason_class: "busy", deadline_epoch: 50 })).toBe(0);
  expect(deliveryWait(15, { deadline_epoch: 100 }, 85)).toBe(5);
  expect(deliveryWait(15, { deadline_epoch: 100 }, 95)).toBe(5);
  expect(deliveryWait(15, { deadline_epoch: 100 }, 101)).toBe(0);
  expect(deliveryWait(15, { deadline_epoch: 1000, hold_until_epoch: 103 }, 100)).toBe(3);
  expect(deliveryWait(15, { deadline_epoch: 1000, policy: "polite", first_spooled_epoch: 50, timeout_seconds: 55 }, 100)).toBe(5);
  expect(deliveryWait(15, { deadline_epoch: "bad" }, 100)).toBe(15);
});

test("one scoped engine call per bounded cadence tick; unknown status continues; resume retains budget", async () => {
  const f = fixture({}, "return 7");
  const states: unknown[] = [];
  expect(await f.run((last, rest, token) => { states.push([last, [...rest], token]); return null; })).toBe(0);
  expect(f.calls()).toEqual(Array(3).fill(`||peer|${f.registry}`));
  expect(states).toEqual([["0", ["0", "0"], ""], ["0", ["0"], ""], ["0", [], ""]]);
  expect(JSON.parse(readFileSync(f.metadata, "utf8")).next_probe_epoch).toBeGreaterThan(0);
  const resumed = fixture();
  expect(await resumed.run(() => null, ["m", "--resume-cadence", "0", "0"])).toBe(0);
  expect(resumed.calls()).toHaveLength(2);
});

test("hard refusal stops before another tick; submit-unverified exits only after residency ends", async () => {
  const hard = fixture({}, "return 1");
  expect(await hard.run()).toBe(1); expect(hard.calls()).toHaveLength(1);
  const resident = fixture({}, "return 5");
  expect(await resident.run()).toBe(0); expect(resident.calls()).toHaveLength(3);
  const removed = fixture({}, 'mv "$TAP_HOME/spool/m.md" "$TAP_HOME/delivered"; return 5');
  expect(await removed.run()).toBe(5); expect(removed.calls()).toHaveLength(1);
  const escalated = fixture({ escalated_at: 100 });
  expect(await escalated.run()).toBe(0); expect(escalated.calls()).toHaveLength(1);
});

// Ported from the retired smoke/digest-outcome.test.sh: the drain slice runs
// the runtime its caller resolves from PATH, so a missing runtime refuses
// before any engine call and a lying-empty runtime delivers nothing while
// custody (payload, receipts, delivery clock) stays untouched. Both rows run
// the real loop in a child so PATH resolution happens in a fresh process.
const stalledClock = (f: ReturnType<typeof fixture>) => {
  const clock = deliveryClockPath(f.registry, "peer");
  mkdirSync(dirname(clock), { recursive: true });
  writeFileSync(clock, '{"last_delivered_at":1}\n');
  expect(deliveryClockRead(f.registry, "peer")).toBe("1");
};

async function runWaiterChild(f: ReturnType<typeof fixture>, path: string) {
  const entry = join(f.home, "waiter-entry.ts");
  writeFileSync(entry, `import {runWaiter} from ${JSON.stringify(join(import.meta.dir, "../src/spool-waiter-loop.ts"))};
process.exitCode = await runWaiter({argv:["m"], scriptsDir:${JSON.stringify(f.scriptsDir)}, env: process.env, refresh: () => null});
`);
  const child = Bun.spawn([process.execPath, entry], { env: { ...f.env, PATH: path }, stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stderr };
}

test("a missing bun runtime refuses the drain slice before any engine call", async () => {
  const f = fixture();
  expect(Bun.which("bun", { PATH: "/usr/bin:/bin" })).toBeNull();
  stalledClock(f);
  const { code, stderr } = await runWaiterChild(f, "/usr/bin:/bin");
  expect(stderr).toContain("runtime_missing id=- slice=spool-drain");
  expect(code).not.toBe(0);
  expect(f.calls()).toEqual([]);
  expect(readFileSync(f.payload, "utf8")).toBe("body");
  expect(existsSync(join(f.home, "receipts/m.attempted"))).toBe(false);
  expect(existsSync(f.lease)).toBe(false);
  expect(deliveryClockRead(f.registry, "peer")).toBe("1");
});

test("an empty bun runtime runs no drain: the entry stays and nothing is delivered", async () => {
  const f = fixture();
  const stub = join(f.home, "bin"); mkdirSync(stub);
  writeFileSync(join(stub, "bun"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  stalledClock(f);
  const { code } = await runWaiterChild(f, `${stub}:${process.env.PATH}`);
  expect(code).toBe(0);
  expect(f.calls()).toEqual([]);
  expect(readFileSync(f.payload, "utf8")).toBe("body");
  expect(existsSync(join(f.home, "receipts/m.attempted"))).toBe(false);
  expect(deliveryClockRead(f.registry, "peer")).toBe("1");
});

test("scope refusal and missing payload release inherited lease; takeover leaves successor untouched", async () => {
  for (const meta of [{ target: "" }, { to_team: "wrong" }, { target_registry: 3 }]) {
    const f = fixture(meta); f.env.TAP_SPOOL_REOWN_TOKEN = "owned";
    writeFileSync(f.lease, "owned");
    expect(await f.run()).toBe(1); expect(f.calls()).toHaveLength(0);
    expect(existsSync(f.lease)).toBe(false);
    expect(readFileSync(join(f.home, "registry-events.log"), "utf8")).toContain("action=waiter_scope_refused");
  }
  const gone = fixture(); gone.env.TAP_SPOOL_REOWN_TOKEN = "owned";
  writeFileSync(gone.lease, "owned"); rmSync(gone.payload);
  expect(await gone.run()).toBe(0); expect(existsSync(gone.lease)).toBe(false);
  const takeover = fixture({ waiter_lifetime: "readiness-gate", deadline_epoch: Date.now() / 1000 + 90 });
  expect(await takeover.run(() => { writeFileSync(takeover.lease, "successor"); return null; })).toBe(0);
  expect(takeover.calls()).toHaveLength(0); expect(readFileSync(takeover.lease, "utf8")).toBe("successor");
});

test("a held entry survives expiry with a cadence floor and exactly one engine call per refreshed tick", async () => {
  const f = fixture({ waiter_lifetime: "readiness-gate", deadline_epoch: 1 });
  f.env.TAP_SPOOL_DELIVERER_DELAYS = "0.1";
  const ticks: number[] = [];
  expect(await f.run(() => { ticks.push(Date.now()); return ticks.length === 3 ? { status: 0 } : null; })).toBe(0);
  expect(f.calls()).toHaveLength(2);
  expect(ticks[1]! - ticks[0]!).toBeGreaterThanOrEqual(90);
  expect(existsSync(f.lease)).toBe(false);
});

// Ported from the retired-in-part smoke/courier-busy-hold.test.sh arm (8)'s
// freshness half: a held waiter refreshes its inherited lease (the row pins
// that a refresh ran on the tick path; per-refresh-site sensitivity is not
// claimed) — the
// mtime, not the file's existence, is what re-own consults against its
// lifetime. The TAP_SPOOL_NOW pin makes the refresh observable without
// wall-clock waiting: a touched lease is utimed to exactly the pinned instant.
test("a held waiter refreshes its inherited lease to the pinned now", async () => {
  const f = fixture({ waiter_lifetime: "readiness-gate", deadline_epoch: 1 }, "return 7");
  f.env.TAP_SPOOL_REOWN_TOKEN = "owned";
  f.env.TAP_SPOOL_NOW = "3000000000";
  writeFileSync(f.lease, "owned");
  const before = lstatSync(f.lease).mtimeMs / 1000;
  // Observed at the final tick, before the run's exit release unlinks the
  // inherited lease: a held waiter has re-stamped it to the pinned now.
  let ticks = 0, heldAge = -1;
  expect(await f.run(() => {
    if (++ticks === 3) heldAge = lstatSync(f.lease).mtimeMs / 1000;
    return ticks === 3 ? { status: 0 } : null;
  })).toBe(0);
  expect(ticks).toBe(3);
  expect(f.calls()).toHaveLength(2);
  expect(heldAge).toBe(3000000000);
  expect(before).toBeLessThan(3000000000);
});

// Ported from the same smoke's arm (12): the refresh call sites are wired to
// the HELD class, not merely to owning a token. An autosettle-hold waiter is
// bounded — the loop must leave its lease untouched (stale), so a replacement
// owner can be minted when the bounded waiter exits. Mutating the held() gate
// out of the refresh call turns this row RED while the held row above stays
// green, which is the exact mutant arm 12 existed to catch.
test("a bounded autosettle-hold waiter leaves its inherited lease stale", async () => {
  const f = fixture({ waiter_lifetime: "autosettle-hold", deadline_epoch: 1 }, "return 7");
  f.env.TAP_SPOOL_REOWN_TOKEN = "owned";
  f.env.TAP_SPOOL_NOW = "3000000000";
  writeFileSync(f.lease, "owned");
  const before = lstatSync(f.lease).mtimeMs / 1000;
  // Observed at the final tick: a bounded autosettle-hold waiter owns a token
  // for three ticks yet never re-stamps the lease — the refresh call sites are
  // keyed on the held class, so this lease goes stale like any abandoned one.
  let ticks = 0, boundedAge = -1;
  expect(await f.run(() => {
    if (++ticks === 3) boundedAge = lstatSync(f.lease).mtimeMs / 1000;
    return ticks === 3 ? { status: 0 } : null;
  })).toBe(0);
  expect(ticks).toBe(3);
  expect(f.calls()).toHaveLength(2);
  expect(boundedAge).toBe(before);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) test(`${signal} stops the active engine before its late effect and releases the lease`, async () => {
  const f = fixture({ waiter_lifetime: "readiness-gate", deadline_epoch: Date.now() / 1000 + 100 },
    'printf "%s" "$$" > "$TAP_HOME/engine-pid"; sleep 10; : > "$TAP_HOME/late-effect"');
  const entry = join(f.home, "entry.ts");
  writeFileSync(entry, `import {runWaiter} from ${JSON.stringify(join(import.meta.dir, "../src/spool-waiter-loop.ts"))};
process.exitCode=await runWaiter({argv:["m"],scriptsDir:${JSON.stringify(f.scriptsDir)},refresh:()=>null});`);
  const child = Bun.spawn([process.execPath, entry], { detached: true, stdout: "ignore", stderr: "pipe", env: f.env });
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(join(f.home, "engine-pid")) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(join(f.home, "engine-pid"))).toBe(true);
    child.kill(signal);
    expect(await Promise.race([child.exited, Bun.sleep(1500).then(() => "still-running")])).toBe(0);
    expect(existsSync(join(f.home, "late-effect"))).toBe(false);
    expect(existsSync(f.lease)).toBe(false);
  } finally {
    if (child.exitCode === null) {
      // These groups belong to this fixture; the engine reports its PID before blocking.
      try { process.kill(-Number(readFileSync(join(f.home, "engine-group"), "utf8")), "SIGKILL"); } catch { /* already exited */ }
      child.kill("SIGKILL");
    }
    await child.exited;
  }
}, 10000);

test("waiter stamp covers every static and dynamic native import", () => {
  const src = join(import.meta.dir, "../src"), closure = new Set<string>(), stack = ["spool-waiter.ts", "spool-waiter-loop.ts"];
  while (stack.length) {
    const rel = stack.pop()!;
    if (closure.has(rel)) continue;
    closure.add(rel);
    for (const { path: spec } of new Bun.Transpiler({ loader: "ts" }).scanImports(readFileSync(join(src, rel), "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const path = join(dirname(join(src, rel)), spec);
      const resolved = [`${path}.ts`, join(path, "index.ts"), path].find(p => existsSync(p) && lstatSync(p).isFile());
      expect(resolved, `${rel}: ${spec}`).toBeDefined(); stack.push(resolved!.slice(src.length + 1));
    }
  }
  expect([...closure].filter(rel => rel.startsWith("launcher/"))).toEqual([]);
  expect([...WAITER_SOURCES].sort()).toEqual([...closure].sort());
});

test("a draft park wakes the scoped drain within one second of two clear samples", async () => {
  const f = fixture({ reason: "pending-input", reason_class: "busy", policy: "standard", waiter_lifetime: "grace-window", deadline_epoch: Math.floor(Date.now() / 1000) + 30 },
    'mv "$TAP_HOME/spool/m.md" "$TAP_HOME/delivered"; return 0');
  f.env.TAP_SPOOL_DELIVERER_DELAYS = "2";
  let samples = 0, clearAt = 0;
  const start = Date.now();
  const rc = await runWaiter({ argv: ["m"], scriptsDir: f.scriptsDir, env: f.env, refresh: () => null,
    draftProbe: () => {
      samples++;
      if (samples === 1) return null; // human draft still present
      if (samples === 2) clearAt = Date.now();
      return "peer|instance|%7|epoch";
    },
  });
  expect(rc).toBe(0);
  expect(samples).toBeGreaterThanOrEqual(3);
  expect(f.calls()).toHaveLength(1);
  expect(Date.now() - clearAt).toBeLessThan(1000);
  expect(Date.now() - start).toBeLessThan(1500);
});

for (const interruption of ["draft", "identity", "attempt"] as const) {
  test(`draft wake resets its clear pair on ${interruption}`, async () => {
    const f = fixture({ reason: "pending-input", reason_class: "busy", waiter_lifetime: "grace-window", deadline_epoch: Math.floor(Date.now() / 1000) + 30 },
      'mv "$TAP_HOME/spool/m.md" "$TAP_HOME/delivered"; return 0');
    f.env.TAP_SPOOL_DELIVERER_DELAYS = "2";
    let samples = 0;
    const rc = await runWaiter({ argv: ["m"], scriptsDir: f.scriptsDir, env: f.env, refresh: () => null,
      draftProbe: () => {
        samples++;
        if (interruption === "attempt") writeFileSync(join(f.home, "receipts/m.attempted"), '{"effect":"possible"}');
        if (samples === 2) return interruption === "draft" ? null : "replacement";
        return "original";
      },
    });
    expect(rc).toBe(0);
    expect(samples).toBe(interruption === "attempt" ? 1 : 4);
    expect(f.calls()).toHaveLength(interruption === "attempt" ? 0 : 1);
  });
}

for (const trigger of ["clear", "shortened deadline"] as const) test(`the default draft probe wakes for ${trigger} on a fake busy Claude pane`, async () => {
  const f = fixture({ reason: "pending-input", reason_class: "busy", waiter_lifetime: "grace-window", deadline_epoch: Math.floor(Date.now() / 1000) + 30 },
    'mv "$TAP_HOME/spool/m.md" "$TAP_HOME/delivered"; return 0');
  writeFileSync(f.registry, JSON.stringify({ schema: "0.20", team: { name: "fixture" }, seats: {
    peer: { status: "active", pane_id: "%7", harness: "claude", instance: "peer|A", server_epoch: serverEpochFromRaw("123:456", f.env) },
  } }));
  const bin = join(f.home, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "tmux"), `#!/usr/bin/env bash
for last do :; done
case "$*" in
  *display-message*) case "$last" in
    *pane_id*session_name*) printf '%%7\\tfixture\\t4242\\tclaude\\t0\\n';;
    *pid*start_time*) echo 123:456;;
    *pane_current_command*) echo claude;;
    *pane_in_mode*pane_width*) printf '0\\t80\\n';; *pane_width*) echo 80;; *) echo 0;; esac ;;
  *capture-pane*)
    if [ -f "$TAP_HOME/clear" ]; then echo bare >> "$TAP_HOME/frames"; input='';
    else echo draft >> "$TAP_HOME/frames"; input='human draft'; fi
    printf 'Working (esc to interrupt)\\n────────────────────────────────────────\\n❯ %s\\n────────────────────────────────────────\\n' "$input" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const entry = join(f.home, "entry.ts");
  writeFileSync(entry, `import {runWaiter} from ${JSON.stringify(join(import.meta.dir, "../src/spool-waiter-loop.ts"))};
process.exitCode=await runWaiter({argv:["m"],scriptsDir:${JSON.stringify(f.scriptsDir)},refresh:()=>null});`);
  const child = Bun.spawn([process.execPath, entry], { env: { ...f.env, PATH: `${bin}:${process.env.PATH}`, TAP_SPOOL_DELIVERER_DELAYS: "2" }, stdout: "pipe", stderr: "pipe" });
  try {
    const until = Date.now() + 3000;
    while (!existsSync(join(f.home, "frames")) && Date.now() < until) await Bun.sleep(10);
    expect(existsSync(join(f.home, "frames"))).toBe(true);
    expect(f.calls()).toHaveLength(0);
    const clearAt = Date.now();
    if (trigger === "clear") writeFileSync(join(f.home, "clear"), "");
    else {
      const directory = join(f.env.TAP_INDEX_HOME!, "input-protection");
      // atomicWrite stages a temp file in the same directory first: wait for the record itself.
      while (!(existsSync(directory) && readdirSync(directory).some(n => n.endsWith(".json"))) && Date.now() - clearAt < 1000) await Bun.sleep(10);
      expect(existsSync(directory), "input-protection directory not created within 1 s after trigger").toBe(true);
      const name = readdirSync(directory).find(n => n.endsWith(".json"));
      expect(name, "input-protection record not observed within 1 s after trigger").toBeDefined();
      const record = join(directory, name!);
      const state = JSON.parse(readFileSync(record, "utf8"));
      state.graceUntil = Date.now() - 1000;
      writeFileSync(record, JSON.stringify(state));
    }
    while (existsSync(f.payload) && Date.now() - clearAt < 2000) await Bun.sleep(10);
    expect(existsSync(f.payload)).toBe(false);
    expect(Date.now() - clearAt).toBeLessThan(1000);
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
    expect(readFileSync(join(f.home, "frames"), "utf8").trim().split("\n").slice(-2)).toEqual(trigger === "clear" ? ["bare", "bare"] : ["draft", "draft"]);
    expect(f.calls()).toHaveLength(1);
  } finally { if (child.exitCode === null) child.kill(); await child.exited; }
}, 6000);

// tap-conft: a landing that deletes a stamped source (e.g. deleting launcher/effects.ts)
// killed every live waiter at its next tick with "source-unreadable; refusing another
// iteration", and nothing re-armed the parked entry. The vanished source is a code
// change like any other: the waiter re-execs in place (same PID, same lease token,
// the remaining cadence) and probes on schedule.
test("a stamped source deleted mid-life re-execs the real waiter in place and it keeps probing on schedule", async () => {
  const f = fixture({ reason: "window", reason_class: "window", waiter_lifetime: "window", deadline_epoch: Math.floor(Date.now() / 1000) + 60 },
    `printf '%s %s %s\\n' "$(ps -o ppid= -p $PPID | tr -d ' ')" "$(cat "$TAP_HOME/spool/m.meta.json.reown")" "$(date +%s)" >> "$TAP_HOME/probes"
 if [ ! -f "$TAP_HOME/landed" ]; then : > "$TAP_HOME/landed"; "${process.execPath}" "$TAP_HOME/land.ts"; return 0; fi
 mv "$TAP_HOME/spool/m.md" "$TAP_HOME/delivered"; return 0`);
  const src = join(f.home, "runtime/bun/src"), fake = readFileSync(join(src, "spool-engine.ts"), "utf8");
  cpSync(join(import.meta.dir, "../src"), src, { recursive: true });
  // The real loop imports spoolEngineCommand; the drain it spawns is the fixture's scripted one.
  writeFileSync(join(f.home, "fake-drain.ts"), fake);
  writeFileSync(join(src, "spool-engine.ts"), `import {join} from "node:path";
export function spoolEngineCommand(scriptsDir: string, ...args: string[]): string[] {
  return [process.execPath, join(scriptsDir, "../../../runtime/bun/src/spool-engine.ts"), scriptsDir, ...args];
}
if (import.meta.main) await import(${JSON.stringify(join(f.home, "fake-drain.ts"))});`);
  // The pre-landing tree stamps one extra source; the landing deletes it and drops it from the list.
  const entry = join(src, "spool-waiter.ts"), shipped = readFileSync(entry, "utf8");
  writeFileSync(join(src, "vanishing.ts"), "export {};\n");
  // WAITER_SOURCES is the file's first array, so its close is the first "\n];".
  writeFileSync(entry, shipped.replace("\n];", '\n  "vanishing.ts",\n];'));
  expect(readFileSync(entry, "utf8")).toContain('"vanishing.ts"');
  writeFileSync(join(f.home, "land.ts"), `import {rmSync, writeFileSync} from "node:fs";
rmSync(${JSON.stringify(join(src, "vanishing.ts"))});
writeFileSync(${JSON.stringify(entry)}, ${JSON.stringify(shipped)});`);
  const child = Bun.spawn([process.execPath, entry, "m"], { env: { ...f.env, TAP_SPOOL_DELIVERER_DELAYS: "0.5 0.5 0.5 0.5" }, stdout: "pipe", stderr: "pipe" });
  const code = await Promise.race([child.exited, Bun.sleep(8000).then(() => "still-running" as const)]);
  if (code === "still-running") child.kill("SIGKILL");
  const stderr = await new Response(child.stderr).text();
  expect(stderr).toContain(`tap sidecar: source-unreadable; re-exec: ${realpathSync(entry)}`);
  expect(stderr).not.toContain("refusing another iteration");
  expect(code).toBe(0);
  const probes = readFileSync(join(f.home, "probes"), "utf8").trim().split("\n").map(line => line.split(" "));
  expect(probes).toHaveLength(2);
  // One waiter throughout: the re-exec keeps the PID the lease names and carries its token.
  expect(probes[1]![0]).toBe(String(child.pid));
  expect(probes[0]![0]).toBe(String(child.pid));
  expect(probes[1]![1]).toBe(probes[0]![1]!);
  // one cadence plus the two-second settle window a real deletion waits out
  expect(Number(probes[1]![2]) - Number(probes[0]![2])).toBeLessThanOrEqual(5);
  expect(existsSync(f.payload)).toBe(false);
  expect(existsSync(f.lease)).toBe(false);
}, 12000);

// tap-conft specimen 1: the drain moved the body to payloads/ for a probe, and its move
// back was refused as reset custody busy. The metadata stayed parked, the waiter's loop
// saw no spool body and ended, and the entry sat past its probe with nothing behind it.
test("a repark refused as busy is retried by the waiter until it lands, and probing resumes", async () => {
  const src = join(import.meta.dir, "../src");
  const f = fixture({ reason: "window", reason_class: "window", waiter_lifetime: "window", deadline_epoch: Math.floor(Date.now() / 1000) + 60 },
    `if [ ! -f "$TAP_HOME/stranded" ]; then
   mkdir -p "$TAP_HOME/payloads"; mv "$TAP_HOME/spool/m.md" "$TAP_HOME/payloads/m.md"
   "${process.execPath}" "$TAP_HOME/mark.ts" || return 3
   "${process.execPath}" "$TAP_HOME/hold.ts" & while [ ! -f "$TAP_HOME/holding" ]; do sleep 0.02; done
   "${process.execPath}" -e "console.log(Date.now() / 1000)" > "$TAP_HOME/stranded"; return 1; fi
 "${process.execPath}" -e "console.log(Date.now() / 1000)" > "$TAP_HOME/resumed"; mv "$TAP_HOME/spool/m.md" "$TAP_HOME/delivered"; return 0`);
  // The drain's own refusal: body out, mark on the metadata.
  writeFileSync(join(f.home, "mark.ts"), `import {markReparkPending} from ${JSON.stringify(join(src, "spool-repark.ts"))};
if (!markReparkPending(${JSON.stringify(f.spool)}, "m")) process.exit(3);`);
  // A reset-custody holder that outlasts the first retry's one-second wait, then lets go.
  writeFileSync(join(f.home, "hold.ts"), `import {writeFileSync} from "node:fs";
import {acquirePathLock} from ${JSON.stringify(join(src, "panelock.ts"))};
const held = acquirePathLock(${JSON.stringify(join(f.home, "reset.fence.json.lock"))}, 0);
if (!held) process.exit(4);
writeFileSync(${JSON.stringify(join(f.home, "holding"))}, "");
await Bun.sleep(1500); held.release();`);
  f.env.TAP_SPOOL_REPARK_DELAYS = "0.1 0.1 0.1";
  expect(await f.run()).toBe(0);
  expect(f.calls()).toHaveLength(2);
  // The second probe ran only after the holder let go: the first retry was refused.
  const stranded = Number(readFileSync(join(f.home, "stranded"), "utf8")), resumed = Number(readFileSync(join(f.home, "resumed"), "utf8"));
  expect(resumed - stranded).toBeGreaterThanOrEqual(1.1);
  expect(existsSync(join(f.home, "delivered"))).toBe(true);
  expect(existsSync(join(f.home, "payloads/m.md"))).toBe(false);
  expect(JSON.parse(readFileSync(f.metadata, "utf8")).repark_pending).toBeUndefined();
}, 10000);

test("a stranded repark stays put for a terminal receipt, and gives up loudly while custody stays busy", async () => {
  const src = join(import.meta.dir, "../src");
  for (const terminal of [true, false]) {
    const f = fixture({ reason: "window", reason_class: "window", waiter_lifetime: "window", deadline_epoch: Math.floor(Date.now() / 1000) + 60 },
      `mkdir -p "$TAP_HOME/payloads"; mv "$TAP_HOME/spool/m.md" "$TAP_HOME/payloads/m.md"
 "${process.execPath}" -e 'const {markReparkPending} = await import(process.argv[1]); if (!markReparkPending(process.argv[2], "m")) process.exit(3)' ${JSON.stringify(join(src, "spool-repark.ts"))} "$TAP_HOME/spool" || return 3
 return 1`);
    if (terminal) writeFileSync(join(f.home, "receipts/m.cancelled"), "{}");
    f.env.TAP_SPOOL_REPARK_DELAYS = "0 0";
    const held = terminal ? null : acquirePathLock(join(f.home, "reset.fence.json.lock"), 0);
    try { expect(await f.run()).toBe(0); } finally { held?.release(); }
    expect(f.calls()).toHaveLength(1);
    // Withdrawn mail is never put back in the spool; busy custody leaves it marked and says so.
    expect(existsSync(join(f.home, "payloads/m.md"))).toBe(true);
    expect(existsSync(f.payload)).toBe(false);
    const meta = JSON.parse(readFileSync(f.metadata, "utf8"));
    if (terminal) expect(meta.repark_pending).toBeUndefined();
    else {
      expect(meta.repark_pending).toBeTruthy();
      expect(readFileSync(join(f.home, "registry-events.log"), "utf8")).toContain("action=spool_repark_abandoned");
    }
  }
}, 10000);

// A scoped drain walks every parked entry for the target, so a
// sibling's drain can strand and mark this entry while its own waiter sleeps; and a
// waiter re-exec'd mid-backoff starts on an entry with no spool body. Both must
// recover the repark instead of reading "no body" as "settled".
test("an entry stranded by a sibling's drain while its waiter sleeps is recovered, then probed", async () => {
  const f = fixture({ reason: "window", reason_class: "window", waiter_lifetime: "window", deadline_epoch: Math.floor(Date.now() / 1000) + 60 },
    `if [ ! -f "$TAP_HOME/first" ]; then : > "$TAP_HOME/first"; return 0; fi
 mv "$TAP_HOME/spool/m.md" "$TAP_HOME/delivered"; return 0`);
  f.env.TAP_SPOOL_DELIVERER_DELAYS = "0 0.6 0.6";
  f.env.TAP_SPOOL_REPARK_DELAYS = "0.05";
  mkdirSync(join(f.home, "payloads"));
  const { markReparkPending } = await import("../src/spool-repark");
  const running = f.run();
  // after the first probe, during the waiter's sleep: the sibling's drain strands and marks m
  while (!existsSync(join(f.home, "first"))) await Bun.sleep(10);
  await Bun.sleep(100);
  const { renameSync } = await import("node:fs");
  renameSync(f.payload, join(f.home, "payloads/m.md"));
  expect(markReparkPending(f.spool, "m", f.env)).toBe(true);
  expect(await running).toBe(0);
  expect(f.calls()).toHaveLength(2);
  expect(existsSync(join(f.home, "delivered"))).toBe(true);
  expect(existsSync(join(f.home, "payloads/m.md"))).toBe(false);
}, 10000);

test("a waiter restarted with its lease on a stranded entry recovers the repark first", async () => {
  const f = fixture({ reason: "window", reason_class: "window", waiter_lifetime: "window", deadline_epoch: Math.floor(Date.now() / 1000) + 60 },
    'mv "$TAP_HOME/spool/m.md" "$TAP_HOME/delivered"; return 0');
  mkdirSync(join(f.home, "payloads"));
  const { renameSync } = await import("node:fs");
  const { markReparkPending } = await import("../src/spool-repark");
  renameSync(f.payload, join(f.home, "payloads/m.md"));
  expect(markReparkPending(f.spool, "m", f.env)).toBe(true);
  writeFileSync(f.lease, "owned"); f.env.TAP_SPOOL_REOWN_TOKEN = "owned";
  f.env.TAP_SPOOL_REPARK_DELAYS = "0.05";
  expect(await f.run(() => null, ["m", "--resume-cadence", "0", "0"])).toBe(0);
  expect(f.calls()).toHaveLength(1);
  expect(existsSync(join(f.home, "delivered"))).toBe(true);
}, 10000);

// Ported from the retired smoke/grace-reprobe.test.sh arc: a marker-free
// clear-fence refusal holds the real waiter without terminalizing it, a
// contender defers to the live owner, and clearing the fence delivers.
test("a clear-fence refusal holds the real waiter past grace, defers a contender, and delivers once the fence clears", async () => {
  const f = fixture({ reason: "pending-input", reason_class: "busy", policy: "standard",
    first_spooled_epoch: Math.floor(Date.now() / 1000) - 62, deadline_epoch: Math.floor(Date.now() / 1000) - 2,
    waiter_lifetime: "grace-window", pane: "sess:0.0", pane_id: "%401" });
  // The real drain slice owns the readiness gate (busy:clearing) and the
  // delivery, so the arc runs production end to end: only tmux is a stub.
  const scriptsDir = join(import.meta.dir, "../../../skills/tap/scripts");
  writeFileSync(f.payload, `---
id: m
from: alice
to: peer
kind: ask
reply: expected
path: ${join(f.home, "payloads/m.md")}
---
keep this original body
`);
  writeFileSync(f.registry, JSON.stringify({ schema: "0.20", team: { name: "fixture", worktree_root: f.home },
    seats: { peer: { session: "sess", pane: "sess:0.0", pane_id: "%401", harness: "codex", status: "active",
      server_epoch: "srv:4242:100", boot_id: "boot:1", registered_from_worktree: f.home } } }));
  const state = join(f.home, "tmux"), fakebin = join(f.home, "bin");
  mkdirSync(state); mkdirSync(fakebin);
  // The shared fake tmux (smoke/fake-tmux-stub.sh, also courier-busy-hold's): a
  // full idle-pane state machine (identity lists, capture, send-keys logging).
  // Each rewrite below must land, or the stub answers stale formats.
  const stubPath = join(import.meta.dir, "../../../skills/tap/scripts/smoke/fake-tmux-stub.sh");
  let tmuxScript = readFileSync(stubPath, "utf8").replaceAll("\u276f", "\u203a");
  // The native observer pins a per-process tmux socket (-L <sock>), which the
  // shared stub predates: strip socket flags before dispatch, and answer the
  // gather's three-field session format.
  const strip = 'cmd="$1"; shift';
  const stripped = 'while [ "${1:-}" = "-L" ] || [ "${1:-}" = "-S" ]; do shift 2; done\ncmd="$1"; shift';
  expect(tmuxScript.includes(strip), "fake-tmux-stub: dispatch anchor drifted").toBe(true);
  tmuxScript = tmuxScript.replace(strip, stripped);
  const sessions = "list-sessions) printf 'sess\\t4242:100\\n' ;;";
  const sessions3 = "list-sessions) printf 'sess\\t4242:100\\t1\\n' ;;";
  expect(tmuxScript.includes(sessions), "fake-tmux-stub: list-sessions anchor drifted").toBe(true);
  tmuxScript = tmuxScript.replace(sessions, sessions3);
  writeFileSync(join(fakebin, "tmux"), tmuxScript, { mode: 0o755 });
  // The retired smoke's hermetic-bus marker (tap-ncd4): a fixture bus is not
  // bootstrapped by any real tap verb.
  writeFileSync(join(f.home, ".tap-bus-authority"), "");
  // The drain's write-ahead custody move targets payloads/ (tap-c9vlf); an
  // absent directory would refuse every submit as unmoved.
  mkdirSync(join(f.home, "payloads"));
  // The clear-fence door resolves the recipient's bus through the global team
  // index: a live index that does not enroll "fixture" sends the resolver down
  // the file-pinned path (busForRegistry), which lands on this bus.
  mkdirSync(f.env.TAP_INDEX_HOME!, { recursive: true });
  writeFileSync(join(f.env.TAP_INDEX_HOME!, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
  const fenceDir = join(f.home, "clear-fence");
  mkdirSync(fenceDir);
  const fence = join(fenceDir, "peer.json");
  writeFileSync(fence, JSON.stringify({ since_epoch: Date.now() / 1000, ceiling_seconds: 60 }));
  f.env.TAP_SERVER_EPOCH = "srv:4242:100";
  f.env.TAP_BOOT_ID = "boot:1";
  f.env.TAP_SPOOL_DELIVERER_DELAYS = ".1";
  f.env.TAP_SPOOL_DISABLE_DELIVERER = "1";
  f.env.TAP_TUI_SETTLE_SCALE = "0.1";
  f.env.TMUX = "/fake/socket";
  f.env.FAKE_TMUX_STATE = state;
  f.env.FAKE_WORKTREE = f.home;
  f.env.PATH = `${fakebin}:${f.env.PATH}`;
  const entry = join(f.home, "entry.ts");
  writeFileSync(entry, `import {runWaiter} from ${JSON.stringify(join(import.meta.dir, "../src/spool-waiter-loop.ts"))};
process.exitCode=await runWaiter({argv:["m"],scriptsDir:${JSON.stringify(scriptsDir)},refresh:()=>null});`);
  const log = join(f.home, "waiter.log");
  const start = () => Bun.spawn(["/bin/sh", "-c", `exec '${process.execPath}' '${entry}' >> '${log}' 2>&1`],
    { env: f.env, stdin: "ignore" });
  const owner = start();
  try {
    // The refusal must hold without terminalizing: no escalated_at while the
    // grace window expires, an owner lease, and scheduled probes with a floor.
    let probes = new Set<string>();
    for (const deadline = Date.now() + 10_000; Date.now() < deadline && probes.size < 3;) {
      if (owner.exitCode !== null) break;
      const meta = JSON.parse(readFileSync(f.metadata, "utf8"));
      if (meta.escalated_at) break;
      if (meta.next_probe_epoch != null) probes.add(String(meta.next_probe_epoch));
      await Bun.sleep(30);
    }
    const meta = JSON.parse(readFileSync(f.metadata, "utf8"));
    if (owner.exitCode !== null) console.log(`WAITER LOG (exit ${owner.exitCode}):\n${readFileSync(log, "utf8")}`);
    expect(meta.escalated_at, "marker-free clear-fence refusal became terminal at grace expiry").toBeUndefined();
    expect(owner.exitCode, "the actual waiter abandoned the refused park").toBeNull();
    expect(existsSync(join(f.home, "receipts/m.attempted")), "refused park minted possible effect").toBe(false);
    const keys = existsSync(join(state, "send-keys.log")) ? readFileSync(join(state, "send-keys.log"), "utf8") : "";
    expect(keys, "fenced pane received input").toBe("");
    expect(existsSync(f.lease), "held waiter has no owner lease").toBe(true);
    expect([...probes].length, "held entry did not retain its scheduled owner").toBeGreaterThanOrEqual(3);
    expect(Math.max(...[...probes].map(Number)) - Math.min(...[...probes].map(Number)), "post-deadline loop lost cadence floor").toBeGreaterThanOrEqual(0.18);
    // While the fence stays live, several more ticks must pass with NO submit
    // attempt: this window is what a fence check deleted from the readiness
    // gate fails (the first drain would inject straight through the marker).
    await Bun.sleep(2500);
    expect(existsSync(f.metadata), "the fenced entry lost its parked metadata").toBe(true);
    expect(existsSync(join(f.home, "receipts/m.attempted")), "fenced park was attempted").toBe(false);
    const keysHeld = existsSync(join(state, "send-keys.log")) ? readFileSync(join(state, "send-keys.log"), "utf8") : "";
    expect(keysHeld, "fenced pane received input").toBe("");
    // A second waiter must defer to the live owner, not double-wait.
    const contender = start();
    try {
      expect(await Promise.race([contender.exited, Bun.sleep(5000).then(() => "hung")])).toBe(0);
      expect(owner.exitCode, "second waiter displaced the live owner").toBeNull();
    } finally { if (contender.exitCode === null) contender.kill("SIGKILL"); }
    // The fence clearing is the pane-side event: removing the marker is the
    // cleared state (an empty marker also reads as cleared). The same waiter
    // delivers.
    rmSync(fence);
    let sent = false;
    for (const deadline = Date.now() + 15_000; Date.now() < deadline && !sent;) {
      sent = existsSync(join(f.home, "receipts/m.sent"));
      if (!sent) await Bun.sleep(25);
    }
    expect(sent, "later-ready recipient was not delivered by actual waiter").toBe(true);
    expect(await Promise.race([owner.exited, Bun.sleep(8000).then(() => "hung")]),
      "the owner did not settle after delivery").toBe(0);
    expect(readFileSync(join(f.home, "payloads/m.md"), "utf8")).toContain("keep this original body");
    expect(existsSync(f.payload), "delivery retained retry custody").toBe(false);
    expect(existsSync(join(f.home, "receipts/m.unconfirmed")), "verified delivery mislabeled unconfirmed").toBe(false);
  } finally {
    if (owner.exitCode === null) { owner.kill("SIGKILL"); await owner.exited; }
  }
}, 40_000);

test("the waiter's draft probe flashes the WAIT latch blue once through the real flash engine", async () => {
  const f = fixture({ reason: "pending-input", reason_class: "busy", waiter_lifetime: "grace-window", deadline_epoch: Math.floor(Date.now() / 1000) + 30 },
    'mv "$TAP_HOME/spool/m.md" "$TAP_HOME/delivered"; return 0');
  writeFileSync(f.registry, JSON.stringify({ schema: "0.20", team: { name: "fixture" }, seats: {
    peer: { status: "active", pane_id: "%7", harness: "claude", instance: "peer|A", server_epoch: serverEpochFromRaw("123:456", f.env) },
  } }));
  const bin = join(f.home, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "tmux"), `#!/usr/bin/env bash
for last do :; done
case "$*" in
  *display-message*) case "$last" in
    *pane_id*session_name*) printf '%%7\\tfixture\\t4242\\tclaude\\t0\\n';;
    *pid*start_time*) echo 123:456;;
    *pane_current_command*) echo claude;;
    *pane_in_mode*pane_width*) printf '0\\t80\\n';; *pane_width*) echo 80;; *) echo 0;; esac ;;
  *capture-pane*)
    printf 'Working (esc to interrupt)\\n────────────────────────────────────────\\n❯ human draft WAIT\\n────────────────────────────────────────\\n' ;;
  *set-option*) case "$*" in *" -u "*) exit 0 ;; *) printf '%s\\n' "$*" >> "$TAP_HOME/flashes" ;; esac ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const entry = join(f.home, "entry.ts");
  writeFileSync(entry, `import {runWaiter} from ${JSON.stringify(join(import.meta.dir, "../src/spool-waiter-loop.ts"))};
process.exitCode=await runWaiter({argv:["m"],scriptsDir:${JSON.stringify(f.scriptsDir)},refresh:()=>null});`);
  const child = Bun.spawn([process.execPath, entry], { env: { ...f.env, PATH: `${bin}:${process.env.PATH}`, TAP_SPOOL_DELIVERER_DELAYS: "2" }, stdout: "pipe", stderr: "pipe" });
  try {
    const flashes = join(f.home, "flashes");
    const flashLines = () => readFileSync(flashes, "utf8").trim().split("\n")
      .map(l => l.match(/window-style (bg=\S+)/)?.[1]).filter(Boolean);
    const until = Date.now() + 3000;
    while ((!existsSync(flashes) || readFileSync(flashes, "utf8").trim().length === 0) && Date.now() < until) await Bun.sleep(10);
    expect(flashLines()).toEqual(["bg=blue"]);
    await Bun.sleep(600);
    expect(flashLines()).toEqual(["bg=blue"]);
  } finally { if (child.exitCode === null) child.kill(); await child.exited; }
}, 8000);
