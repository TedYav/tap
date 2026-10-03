import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync, symlinkSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireNoFollowLock } from "../src/remind-lock";
import { startupTrace, startupTransition, withStartupTrace, withStartupTraceScope } from "../src/startup-trace";

// "Dead" is gone (ESRCH) or a zombie: a SIGKILLed grandchild stays signalable until
// its reaper runs, and where PID 1 never reaps (some containers) that is forever. A
// zombie can run no more code; reaping it is the host's job, not this test's. EPERM
// means the process exists and stays alive.
const isZombieState = (stat: string): boolean => stat.trim().startsWith("Z");
async function waitForDeath(pid: number, budgetMs = 2000): Promise<{ dead: boolean; waitedMs: number }> {
  const start = performance.now();
  for (;;) {
    const elapsed = () => Math.round(performance.now() - start);
    try {
      process.kill(pid, 0);
      // `ps -o stat=` leads with Z for a zombie on both macOS and Linux.
      if (isZombieState(spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "")) return { dead: true, waitedMs: elapsed() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return { dead: true, waitedMs: elapsed() };
    }
    if (elapsed() >= budgetMs) return { dead: false, waitedMs: elapsed() };
    await Bun.sleep(20);
  }
}

test("native lifecycle shares bounded writer, redaction and rollback journal", () => {
  const root = mkdtempSync(join(tmpdir(), "startup-native-"));
  const old = process.env.TAP_INDEX_HOME;
  process.env.TAP_INDEX_HOME = join(root, "index");
  try {
    startupTrace("launch_start", { session: "repo/seat", prompt: "private prompt", API_TOKEN: "secret" }, true);
    const log = join(process.env.TAP_INDEX_HOME, "logs/startup.jsonl");
    expect(existsSync(log)).toBe(true);
    const text = readFileSync(log, "utf8");
    expect(text).not.toContain("private prompt");
    expect(text).not.toContain('"secret"');
    expect(JSON.parse(text).API_TOKEN).toBe("<redacted>");
    const registry = join(root, "team", "team-registry.json");
    startupTransition(registry, "seat", { status: "pending", harness_session_id: "id" }, null, false);
    const journal = readFileSync(join(root, "team", "registry-events.jsonl"), "utf8");
    expect(JSON.parse(journal).before.harness_session_id).toBe("id");
    // A blocked logs directory must not escape from the bridge.
    process.env.TAP_INDEX_HOME = join(root, "blocked");
    writeFileSync(process.env.TAP_INDEX_HOME, "file");
    expect(() => startupTrace("launch_failure")).not.toThrow();
  } finally {
    if (old === undefined) delete process.env.TAP_INDEX_HOME; else process.env.TAP_INDEX_HOME = old;
  }
});

const writer = resolve(import.meta.dir, "../src/startup-trace.ts");
function fixture() {
  const root = mkdtempSync(join(process.env.HOME!, "trace-"));
  const env = { ...process.env, TAP_INDEX_HOME: join(root, "index"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", TRACE_API_KEY: "planted-value" };
  const log = join(env.TAP_INDEX_HOME, "logs/startup.jsonl");
  const call = (op: string, args: object, context: string | null = null) => {
    const child = spawnSync(process.execPath, [writer], { env, encoding: "utf8", input: JSON.stringify({ op, args, context }), timeout: 2000 });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stderr).toBe("");
    return JSON.parse(child.stdout) as { value: unknown; context: string | null };
  };
  return { root, env, log, call };
}

test("writer rotates only at startup, holds the shared lock, and preserves private modes", () => {
  const f = fixture();
  expect(f.call("emit", { event: "first" }).value).toBe(true);
  expect(statSync(join(f.env.TAP_INDEX_HOME, "logs")).mode & 0o777).toBe(0o700);
  expect(statSync(f.log).mode & 0o777).toBe(0o600);
  expect(statSync(f.log + ".lock").mode & 0o777).toBe(0o600);
  writeFileSync(f.log, "x".repeat(300 * 1024));
  expect(f.call("emit", { event: "late" }).value).toBe(false);
  const started = f.call("begin", { verb: "resume", cwd: "/repo" });
  expect(statSync(f.log + ".1").size).toBe(300 * 1024);
  const before = readFileSync(f.log, "utf8");
  const held = acquireNoFollowLock(f.log + ".lock", 0)!;
  expect(held).not.toBeNull();
  try {
    expect(f.call("emit", { event: "contended", rotate: true }).value).toBe(false);
    expect(readFileSync(f.log, "utf8")).toBe(before);
  } finally { held.release(); }
  f.call("finish", { code: 0 }, started.context);
  expect(readFileSync(f.log, "utf8").trim().split("\n").map(line => JSON.parse(line).event)).toEqual(["launch_start", "launch_complete"]);
  const denied = fixture();
  mkdirSync(join(denied.env.TAP_INDEX_HOME, "logs"), { recursive: true });
  const target = join(denied.root, "lock-target"); writeFileSync(target, "kept"); symlinkSync(target, denied.log + ".lock");
  expect(denied.call("emit", { event: "refused" }).value).toBe(false);
  expect(existsSync(denied.log)).toBe(false);
  expect(readFileSync(target, "utf8")).toBe("kept");
});

test("strict ASCII byte cap includes newline; redaction precedes Unicode character bounds", () => {
  const f = fixture();
  const fields = { timestamp: "t", pid: 1, values: Array(25).fill("ok"), detail: "planted-value token=hidden", prompt: "private",
    nested: { authorization: "secret", passthrough: "private" }, unicode: "é".repeat(599) + "😀tail" };
  expect(f.call("emit", { event: "clean", fields }).value).toBe(true);
  const text = readFileSync(f.log, "utf8"), row = JSON.parse(text);
  expect(text).not.toMatch(/planted-value|hidden|private|"secret"|[^\x00-\x7f]/);
  expect(row.values.length).toBe(20);
  expect(row.unicode).toBe("é".repeat(599) + "😀");
  for (const length of [4095, 4096]) {
    const bounded: Record<string, unknown> = { timestamp: "t", pid: 1 };
    for (let i = 0; i < 6; i++) bounded[`part${i}`] = "a".repeat(600);
    bounded.tail = "";
    // emitted_at rides every row in the same fixed-width format as timestamp.
    const base = JSON.stringify({ schema: 1, emitted_at: new Date().toISOString().replace("Z", "000+00:00"), ...bounded, event: "bound" }).length + 1;
    bounded.tail = "x".repeat(length - base);
    const before = statSync(f.log).size;
    expect(f.call("emit", { event: "bound", fields: bounded }).value).toBe(length === 4095);
    expect(statSync(f.log).size - before).toBe(length === 4095 ? 4095 : 0);
  }
});

test("rollback journal stays uncapped when startup is full; diagnostics keep three rotations", () => {
  const f = fixture();
  f.call("emit", { event: "first" });
  writeFileSync(f.log, "x".repeat(300 * 1024));
  const registry = join(f.root, "team", "registry.json");
  mkdirSync(join(f.root, "team"));
  const journal = join(f.root, "team", "registry-events.jsonl");
  writeFileSync(journal, "x".repeat(300 * 1024) + "\n");
  const before = { harness_session_id: "retained", status: "pending", harness_env: { secret: "private" }, prompt: "private" };
  f.call("transition", { registry, handle: "seat", before, after: null, relaunchable: false });
  const text = readFileSync(journal, "utf8");
  expect(JSON.parse(text.trim().split("\n").at(-1)!)).toMatchObject({ before: { harness_session_id: "retained", status: "pending" }, after: null });
  expect(text).not.toContain("private");
  expect(JSON.parse(text.trim().split("\n").at(-1)!)).not.toHaveProperty("pid");
  expect(statSync(f.log).size).toBe(300 * 1024);
  const diagnostic = join(f.env.TAP_INDEX_HOME, "logs/launch-debug.jsonl");
  writeFileSync(diagnostic, "x".repeat(5 * 1024 * 1024));
  writeFileSync(diagnostic + ".1", "previous-one"); writeFileSync(diagnostic + ".2", "previous-two");
  expect(f.call("diagnostic", { record: { event: "detail" }, rotate: true }).value).toBe(true);
  expect(statSync(diagnostic + ".1").size).toBe(5 * 1024 * 1024);
  expect(readFileSync(diagnostic + ".2", "utf8")).toBe("previous-one");
  expect(readFileSync(diagnostic + ".3", "utf8")).toBe("previous-two");
  expect(existsSync(diagnostic + ".4")).toBe(false);
});

test("rollback transition carries caller context into the journal and the startup log", () => {
  const f = fixture();
  const registry = join(f.root, "registry.json");
  f.call("transition", { registry, handle: "seat", before: {}, after: {}, relaunchable: false,
    context: { operation_id: "operation", phase: "rollback", session: "repo/seat" } });
  const journal = JSON.parse(readFileSync(join(f.root, "registry-events.jsonl"), "utf8"));
  expect(journal).toMatchObject({ event: "launch_rollback", handle: "seat", operation_id: "operation", phase: "rollback" });
  const row = JSON.parse(readFileSync(f.log, "utf8").trim().split("\n").at(-1)!);
  expect(row).toMatchObject({ event: "launch_rollback", operation_id: "operation", phase: "rollback", session: "repo/seat" });
});

test("an operation's rows carry the caller's emission clock", async () => {
  const root = mkdtempSync(join(process.env.HOME!, "trace-"));
  const old = process.env.TAP_INDEX_HOME;
  process.env.TAP_INDEX_HOME = join(root, "index");
  try {
    await withStartupTrace(async () => {
      startupTrace("early_event");
      await new Promise(done => setTimeout(done, 150));
      startupTrace("late_event");
    });
    const rows = readFileSync(join(root, "index/logs/startup.jsonl"), "utf8").trim().split("\n")
      .map(line => JSON.parse(line)).filter((row) => row.event === "early_event" || row.event === "late_event");
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(typeof row.emitted_at).toBe("string");
    expect(Date.parse(rows[1].emitted_at) - Date.parse(rows[0].emitted_at)).toBeGreaterThanOrEqual(100);
  } finally {
    if (old === undefined) delete process.env.TAP_INDEX_HOME; else process.env.TAP_INDEX_HOME = old;
  }
});

test("one drain burst writes rows together but keeps each packet's emission clock", async () => {
  const f = fixture();
  const first = "2026-09-28T19:04:05.000000+00:00";
  const second = "2026-09-28T19:04:05.500000+00:00";
  const child = spawn(process.execPath, [writer, "--stream"], { env: f.env, stdio: ["pipe", "ignore", "ignore"] });
  child.stdin!.write(JSON.stringify({ op: "emit", args: { event: "burst_one", emitted_at: first } }) + "\n");
  child.stdin!.write(JSON.stringify({ op: "emit", args: { event: "burst_two", emitted_at: second } }) + "\n");
  child.stdin!.end();
  await new Promise<void>(done => { child.once("exit", () => done()); child.once("error", () => done()); });
  const rows = readFileSync(f.log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(rows.map(row => row.event)).toEqual(["burst_one", "burst_two"]);
  expect(rows.map(row => row.emitted_at)).toEqual([first, second]);
  // Written in one synchronous drain: write clocks stay close while the
  // preserved emission clocks sit half a second apart.
  expect(Date.parse(rows[1].timestamp) - Date.parse(rows[0].timestamp)).toBeLessThan(250);
});

test("a bare packet without a clock is stamped when the writer handles it", () => {
  const f = fixture();
  f.call("emit", { event: "bare" });
  const row = JSON.parse(readFileSync(f.log, "utf8"));
  expect(typeof row.emitted_at).toBe("string");
  expect(Math.abs(Date.parse(row.emitted_at) - Date.parse(row.timestamp))).toBeLessThanOrEqual(5);
});

test("native trace and diagnostics produce evidence without Python on PATH", () => {
  const f = fixture();
  const script = `import {startupTrace} from ${JSON.stringify(writer)}; import {lifecycleDiagnostic} from ${JSON.stringify(resolve(import.meta.dir, "../src/lifecycle-diagnostics.ts"))}; startupTrace('native'); lifecycleDiagnostic('native-detail',{});`;
  const config = join(f.root, "config/tap"); mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "config.toml"), '[diagnostics]\nlevel="verbose"\n');
  const child = spawnSync(process.execPath, ["-e", script], { env: { ...f.env, PATH: "/nonexistent", XDG_CONFIG_HOME: join(f.root, "config") }, encoding: "utf8" });
  expect(child.status).toBe(0); expect(child.stderr).toBe(""); expect(child.stdout).toBe("");
  expect(JSON.parse(readFileSync(f.log, "utf8")).event).toBe("native");
  expect(JSON.parse(readFileSync(join(f.env.TAP_INDEX_HOME, "logs/launch-debug.jsonl"), "utf8")).event).toBe("native-detail");
});

test("unavailable lock never writes unlocked; native hung writer is killed within its budget", () => {
  const f = fixture();
  const copy = join(f.root, "startup-trace.ts");
  const source = readFileSync(writer, "utf8")
    .replace('"./fsatomic"', JSON.stringify(resolve(import.meta.dir, "../src/fsatomic.ts")))
    .replace('"./remind-lock"', JSON.stringify(resolve(import.meta.dir, "../src/remind-lock.ts")))
    .replace('"./scripts-dir"', JSON.stringify(resolve(import.meta.dir, "../src/scripts-dir.ts")));
  writeFileSync(copy, source.replace(/import \{ acquireNoFollowLock \} from [^;]+;/,
    'const acquireNoFollowLock = () => { throw new Error("primitive unavailable"); };'));
  const refused = spawnSync(process.execPath, [copy], { env: f.env, encoding: "utf8", input: JSON.stringify({ op: "emit", args: { event: "unlocked" } }) });
  expect(refused.status).toBe(0); expect(refused.stderr).toBe("");
  expect(JSON.parse(refused.stdout).value).toBe(false); expect(existsSync(f.log)).toBe(false);
  const receipt = join(f.root, "writer-result.json");
  // Observe from the parent: a timed-out child need not reach its first JS line.
  writeFileSync(copy, source.replace("if (import.meta.main) {", "if (import.meta.main) { for (;;) {}")
    .replace("    spawnSync(", "    const observed = spawnSync(")
    .replace("  } catch { /* Evidence must never change the operation result. */ }",
      `    writeSync(openSync(${JSON.stringify(receipt)}, "w"), JSON.stringify({ pid: observed.pid, signal: observed.signal, error: observed.error?.code }));\n  } catch {}`));
  const script = `import { startupTrace } from ${JSON.stringify(copy)}; const start = performance.now(); startupTrace('hung'); console.log(performance.now() - start);`;
  const parent = spawnSync(process.execPath, ["-e", script], { env: f.env, encoding: "utf8", timeout: 3000 });
  expect(parent.status, parent.stderr).toBe(0); expect(parent.stderr).toBe("");
  expect(Number(parent.stdout)).toBeGreaterThanOrEqual(180); expect(Number(parent.stdout)).toBeLessThan(2000);
  const killed = JSON.parse(readFileSync(receipt, "utf8"));
  expect(killed.signal).toBe("SIGKILL"); expect(killed.error).toBe("ETIMEDOUT");
  expect(() => process.kill(killed.pid, 0)).toThrow();
  expect(existsSync(f.log)).toBe(false);
});

test("malformed writer packets fail quietly before creating evidence", () => {
  const f = fixture();
  for (const packet of [{ op: "emit", args: {} }, { op: "transition", args: { registry: join(f.root, "registry.json") } },
    { op: "diagnostic", args: {} }, { op: "emit", args: { event: "bad-context" }, context: "false" }]) {
    const child = spawnSync(process.execPath, [writer], { env: f.env, encoding: "utf8", input: JSON.stringify(packet) });
    expect(child.status).toBe(1); expect(child.stderr).toBe(""); expect(child.stdout).toBe("");
  }
  expect(existsSync(f.env.TAP_INDEX_HOME)).toBe(false);
  expect(existsSync(join(f.root, "registry-events.jsonl"))).toBe(false);
});


test("concurrent native operations keep their own identity and phase", async () => {
 const root=mkdtempSync(join(tmpdir(),"startup-context-"));const old=process.env.TAP_INDEX_HOME;process.env.TAP_INDEX_HOME=root;
 try {
  await Promise.all(["one","two"].map(session=>withStartupTrace(async()=>{
   startupTrace("launch_start",{session,boot_id:"boot-id"},true);
   await Bun.sleep(session==="one"?5:1);
   startupTrace("respawn_pane",{session});
   startupTrace("tmux_result",{exit_code:1,stderr:"failure"});
  })));
  const rows=readFileSync(join(root,"logs/startup.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
  const failures=rows.filter(r=>r.event==="tmux_result");
  expect(failures.length).toBe(2);
  expect(new Set(failures.map(r=>r.operation_id)).size).toBe(2);
  for(const row of failures){expect(row.phase).toBe("respawn_pane");expect(row.boot_id).toBe("boot-id");expect(rows.find(r=>r.event==="launch_start"&&r.session===row.session).operation_id).toBe(row.operation_id);}
 } finally {if(old===undefined)delete process.env.TAP_INDEX_HOME;else process.env.TAP_INDEX_HOME=old;}
});

test("seat scopes isolate launch fields while sharing one operation's stream", async () => {
  const root = mkdtempSync(join(tmpdir(), "startup-scope-"));
  const old = process.env.TAP_INDEX_HOME;
  process.env.TAP_INDEX_HOME = root;
  try {
    await withStartupTrace(async () => {
      await Promise.all(["one", "two"].map(session => withStartupTraceScope(async () => {
        startupTrace("launch_start", { session, harness: "claude", boot_id: "boot-id" }, true);
        await Bun.sleep(session === "one" ? 5 : 1);
        startupTrace("create_session", { session, harness: "claude" });
        startupTrace("late_event", { marker: session });
      })));
      // Cohort-level completion runs in the parent scope: no seat's fields.
      startupTrace("launch_complete", { exit_code: 0 });
    });
    const rows = readFileSync(join(root, "logs/startup.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    // One operation, one stream: every row rides the same operation_id.
    expect(new Set(rows.map(row => row.operation_id))).toHaveLength(1);
    for (const session of ["one", "two"] as const) {
      // The seat's create_session stamped phase without adopting the sibling's session...
      const create = rows.find(row => row.event === "create_session" && row.session === session);
      expect(create).toMatchObject({ harness: "claude", phase: "create_session", boot_id: "boot-id" });
      // ...and the seat's later event still carries its own session/harness.
      expect(rows.find(row => row.event === "late_event" && row.marker === session))
        .toMatchObject({ session, harness: "claude", phase: "create_session" });
    }
    const complete = rows.find(row => row.event === "launch_complete");
    expect(complete).toMatchObject({ exit_code: 0, phase: "dispatch" });
    expect(complete.session).toBeUndefined();
  } finally { if (old === undefined) delete process.env.TAP_INDEX_HOME; else process.env.TAP_INDEX_HOME = old; }
});

const scriptsDir = resolve(import.meta.dir, "../../../skills/tap/scripts");
// TAP_SMOKE_BUN is the installed-tree branch's bun; a freshly written wrapper
// script would pay macOS's first-exec check inside the drain budget.
function streamFixture() {
  const f = fixture();
  const run = (body: string) => {
    const script = `import { startupCommandResult, startupDiagnostic, startupTrace, withStartupTrace } from ${JSON.stringify(writer)};\n${body}`;
    return spawnSync(process.execPath, ["-e", script], { env: { ...f.env, TAP_SMOKE_BUN: process.execPath }, encoding: "utf8", timeout: 10_000 });
  };
  const rows = () => existsSync(f.log) ? readFileSync(f.log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { ...f, run, rows };
}

test("an operation's events share one writer child and are all written before it returns", () => {
  const f = streamFixture();
  const child = f.run(`await withStartupTrace(async () => {
    startupTrace("launch_start", { session: "repo/seat" }, true);
    for (let i = 0; i < 20; i++) startupCommandResult(["tmux", "has-session"], { code: i % 2, stderr: "e" + i }, process.env);
    startupTrace("launch_complete", { exit_code: 0 });
  }, { operation_id: "op-1", phase: "dispatch" }, ${JSON.stringify(scriptsDir)});`);
  expect(child.status, child.stderr).toBe(0);
  const rows = f.rows();
  expect(rows.map(row => row.event)).toEqual(["launch_start", ...Array(10).fill("tmux_result"), "launch_complete"]);
  expect(new Set(rows.map(row => row.operation_id))).toEqual(new Set(["op-1"]));
  // Each row carries its writer's pid: one child wrote them all.
  expect(new Set(rows.map(row => row.pid)).size).toBe(1);
});

test("a caller env's secret values are redacted by the shared writer", () => {
  const f = streamFixture();
  const child = f.run(`await withStartupTrace(async () => {
    startupCommandResult(["tmux", "new-session"], { code: 1, stderr: "denied planted-caller-value" }, { ...process.env, CALLER_TOKEN: "planted-caller-value" });
  }, undefined, ${JSON.stringify(scriptsDir)});`);
  expect(child.status, child.stderr).toBe(0);
  expect(f.rows().map(row => row.stderr)).toEqual(["denied <redacted>"]);
});

test("zombie process states count as dead and live states do not", () => {
  for (const zombie of ["Z", "Zs", "Z+", " Z+ \n", "Zl"]) expect(isZombieState(zombie), zombie).toBe(true);
  for (const live of ["R", "Rs", "S", "S+", "Ss", "U", "T", "", " \n"]) expect(isZombieState(live), JSON.stringify(live)).toBe(false);
});

test("a wedged shared writer is killed at the drain budget and never holds the operation", async () => {
  const f = streamFixture();
  const copy = join(f.root, "startup-trace.ts");
  writeFileSync(copy, readFileSync(writer, "utf8")
    .replace('"./fsatomic"', JSON.stringify(resolve(import.meta.dir, "../src/fsatomic.ts")))
    .replace('"./remind-lock"', JSON.stringify(resolve(import.meta.dir, "../src/remind-lock.ts")))
    .replace('"./scripts-dir"', JSON.stringify(resolve(import.meta.dir, "../src/scripts-dir.ts")))
    .replace("async function serveStream(): Promise<void> {", `async function serveStream(): Promise<void> {\n  require("node:fs").writeFileSync(${JSON.stringify(join(f.root, "wedged-pid"))}, String(process.pid)); for (;;) {}`));
  const script = `import { startupTrace, withStartupTrace } from ${JSON.stringify(copy)};
    const start = performance.now();
    await withStartupTrace(async () => { for (let i = 0; i < 3000; i++) startupTrace("bulk", { pad: "x".repeat(1000) }); });
    console.log(performance.now() - start);`;
  const parent = spawnSync(process.execPath, ["-e", script], { env: f.env, encoding: "utf8", timeout: 10_000 });
  expect(parent.status, parent.stderr).toBe(0);
  expect(Number(parent.stdout)).toBeLessThan(2000);
  const pid = Number(readFileSync(join(f.root, "wedged-pid"), "utf8"));
  const death = await waitForDeath(pid);
  expect(death.dead, `wedged writer pid ${pid} still alive after waiting ${death.waitedMs}ms`).toBe(true);
  expect(existsSync(f.log)).toBe(false);
});

test("evidence handed over before an abrupt exit is still written; the writer ends on EOF", () => {
  const f = streamFixture();
  const child = f.run(`withStartupTrace(() => { startupTrace("launch_failure", { exit_code: 130 }); process.exit(130); });`);
  expect(child.status).toBe(130);
  const deadline = Date.now() + 3000;
  while (f.rows().length === 0 && Date.now() < deadline) Bun.sleepSync(20);
  expect(f.rows().map(row => row.event)).toEqual(["launch_failure"]);
});

test("a synchronous operation that throws still closes its writer", () => {
  const f = streamFixture();
  const child = f.run(`try { withStartupTrace(() => { startupTrace("launch_failure", { exit_code: 1 }); throw new Error("sync"); }); } catch {}
    const deadline = Date.now() + 3000;
    // A caller that outlives the failed operation must not keep its writer.
    for (;;) {
      const text = (() => { try { return require("node:fs").readFileSync(${JSON.stringify(f.log)}, "utf8"); } catch { return ""; } })();
      if (text) { const pid = JSON.parse(text.trim()).pid; await Bun.sleep(300); try { process.kill(pid, 0); console.log("alive"); } catch { console.log("closed"); } break; }
      if (Date.now() > deadline) { console.log("no-row"); break; }
      await Bun.sleep(20);
    }`);
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout.trim()).toBe("closed");
});

test("secrets set or changed after the writer starts are still redacted", () => {
  const f = streamFixture();
  const child = f.run(`await withStartupTrace(async () => {
    startupTrace("launch_start", {}, true);
    process.env.LATE_TOKEN = "late-added-value";
    startupTrace("added", { detail: "saw late-added-value" });
    process.env.LATE_TOKEN = "late-changed-value";
    startupTrace("changed", { detail: "saw late-changed-value" });
    startupCommandResult(["tmux", "new-session"], { code: 1, stderr: "saw caller-changed-value" }, { ...process.env, LATE_TOKEN: "caller-changed-value" });
  }, undefined, ${JSON.stringify(scriptsDir)});`);
  expect(child.status, child.stderr).toBe(0);
  const text = readFileSync(f.log, "utf8");
  for (const value of ["late-added-value", "late-changed-value", "caller-changed-value"]) expect(text).not.toContain(value);
  expect(f.rows().filter(row => row.event !== "launch_start").map(row => row.detail ?? row.stderr)).toEqual(["saw <redacted>", "saw <redacted>", "saw <redacted>"]);
});

test("a caller-selected log root is honoured by the shared writer", () => {
  const f = streamFixture();
  const other = join(f.root, "other-index"), otherHome = join(f.root, "other-home");
  const child = f.run(`await withStartupTrace(async () => {
    startupTrace("launch_start", {}, true);
    startupDiagnostic("selected", {}, { ...process.env, TAP_INDEX_HOME: ${JSON.stringify(other)} });
    const fallback = { ...process.env, HOME: ${JSON.stringify(otherHome)} }; delete fallback.TAP_INDEX_HOME;
    startupDiagnostic("home-fallback", {}, fallback);
  }, undefined, ${JSON.stringify(scriptsDir)});`);
  expect(child.status, child.stderr).toBe(0);
  const read = (path: string) => readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line).event);
  expect(read(join(other, "logs/launch-debug.jsonl"))).toEqual(["selected"]);
  expect(read(join(otherHome, ".tap/logs/launch-debug.jsonl"))).toEqual(["home-fallback"]);
  expect(existsSync(join(f.env.TAP_INDEX_HOME, "logs/launch-debug.jsonl"))).toBe(false);
  expect(f.rows().map(row => row.event)).toEqual(["launch_start"]);
});
