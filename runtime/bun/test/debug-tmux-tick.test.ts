import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const script = join(import.meta.dir, "../../../scripts/tap-debug-tmux-tick.sh");
const bash = Bun.which("bash")!;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "flight-")), bin = join(root, "bin"), flight = join(root, "flight");
  mkdirSync(bin); mkdirSync(flight);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMUX_FLIGHT_DIR: flight,
    TMUX_FLIGHT_LOG_DIR: join(flight, "server-logs"), TMUX_FLIGHT_RT_TIMEOUT_S: "2", TMUX_FLIGHT_INCIDENT_GAP_S: "0" };
  const shim = (name: string, body: string) => { const path = join(bin, name); writeFileSync(path, `#!${bash}\nprintf '%s\\n' '${name}' >> '${root}/calls'\n${body}\n`); chmodSync(path, 0o755); };
  for (const name of ["awk", "jq", "ps", "lsof"]) {
    const real = Bun.which(name, { PATH: process.env.PATH });
    shim(name, real ? `exec '${real}' "$@"` : "exit 127");
  }
  const healthy = (panes = 8) => {
    shim("tmux", `printf 'S\\t123456\\t/private/fixture/default\\t3.7\\n'\nfor ((i=0;i<${panes};i++)); do printf 'P\\t$1\\t@1\\t0\\t40\\n'; done\nprintf 'C\\n'`);
  };
  healthy();
  const now = Math.floor(Date.now() / 1000);
  const state = (alive = "true", panes = "8", inventory = now, maintenance = now) => writeFileSync(join(flight, ".state"),
    ["v1", now, alive, panes, 123456, inventory, maintenance, 0, 0, 0, 0, "-L:fixture"].join("\t") + "\n");
  state();
  const run = (action = "watch-once", extra: string[] = []) => Bun.spawnSync([bash, script, action, "-L", "fixture", ...extra], { env, stdout: "pipe", stderr: "pipe", timeout: 10000 });
  const observations = () => readdirSync(flight).filter(x => x.endsWith(".jsonl")).flatMap(x => readFileSync(join(flight, x), "utf8").trim().split("\n").flatMap(x => { try { return [JSON.parse(x)]; } catch { return []; } }));
  const incidents = () => readdirSync(flight).filter(x => x.startsWith("incident-"));
  return { root, env, flight, shim, healthy, state, run, observations, incidents, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("healthy fast tick chains one tmux, one awk and one jq without process inventory", () => {
  const f = fixture();
  try {
    const r = f.run(); expect(r.stderr.toString()).toBe(""); expect(r.exitCode).toBe(0);
    const counts = readFileSync(join(f.root, "calls"), "utf8").trim().split("\n");
    expect(counts).toEqual(["tmux", "awk", "jq"]);
    expect(f.observations().at(-1)).toMatchObject({ alive: true, panes: 8, sessions: 1, windows: 1, clients: 1, rss_kb: null, pcpu: null, load: null, top_cpu: null });
    expect(f.observations().at(-1).inventory_sample_at).toBeTruthy();
  } finally { f.cleanup(); }
});

test("death and pane collapse capture before slow inventory; a steady absence does not repeat", () => {
  const f = fixture();
  try {
    f.shim("tmux", "echo 'no server running on fixture' >&2; exit 1");
    expect(f.run().exitCode).toBe(4);
    expect(f.incidents()).toHaveLength(1);
    expect(readFileSync(join(f.flight, f.incidents()[0]!, "note.txt"), "utf8")).toContain("auto-DEATH");
    f.run(); expect(f.incidents()).toHaveLength(1);
    f.state(); f.healthy(3); expect(f.run().exitCode).toBe(0);
    expect(f.incidents()).toHaveLength(2);
  } finally { f.cleanup(); }
});

test("torn state recovers yesterday's matching observation across an incomplete final JSONL line", () => {
  const f = fixture();
  try {
    f.run(); const previous = f.observations().at(-1);
    for (const file of readdirSync(f.flight).filter(x => x.endsWith(".jsonl"))) rmSync(join(f.flight, file));
    const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    writeFileSync(join(f.flight, `${day}.jsonl`), `${JSON.stringify(previous)}\n{"incomplete":`);
    writeFileSync(join(f.flight, ".state"), "torn");
    f.run(); expect(f.incidents()).toHaveLength(0);
    writeFileSync(join(f.flight, ".state"), "torn");
    f.shim("tmux", "echo 'no server running on fixture' >&2; exit 1");
    f.run(); expect(f.incidents()).toHaveLength(1);
  } finally { f.cleanup(); }
});

test("unclassified tmux failure remains unknown rather than inventing a death", () => {
  const f = fixture();
  try {
    f.shim("tmux", "echo 'permission denied' >&2; exit 1");
    expect(f.run().exitCode).toBe(5);
    expect(f.observations().at(-1).alive).toBeNull();
    expect(f.incidents()).toHaveLength(0);
  } finally { f.cleanup(); }
});

test("a live exclusion owner is never stolen and an exited owner is reclaimed", () => {
  const f = fixture(), lock = join(f.flight, ".tick-lock");
  try {
    mkdirSync(lock); writeFileSync(join(lock, "owner"), String(process.pid) + "\n");
    expect(f.run().exitCode).toBe(0); expect(f.observations()).toHaveLength(0);
    writeFileSync(join(lock, "owner"), `${Bun.spawnSync(["true"]).pid}\n`);
    // SIGKILL bypasses EXIT cleanup after the probe has opened these files.
    writeFileSync(join(lock, "out"), "partial probe"); writeFileSync(join(lock, "err"), "interrupted");
    const reclaimed = f.run();
    expect(reclaimed.exitCode).toBe(0); expect(f.observations()).toHaveLength(1);
    expect(existsSync(lock)).toBe(false);
  } finally { f.cleanup(); }
});

test("slow inventory cannot delay incident dispatch and subsequent fast fields are null", () => {
  const f = fixture();
  try {
    f.state("true", "8", 0); f.healthy(3);
    f.shim("ps", `if [[ $1 == -Ao ]]; then
      compgen -G '${f.flight}/incident-*/note.txt' > '${f.root}/incident-before-inventory'
      sleep 5
    else echo '1 0.1'; fi`);
    const r = f.run(); expect(r.exitCode).toBe(0);
    expect(readFileSync(join(f.root, "incident-before-inventory"), "utf8")).toContain("incident-");
    expect(f.observations().at(-1).inventory_sampled).toBe(true);
    f.run(); expect(f.observations().at(-1)).toMatchObject({ inventory_sampled: false, rss_kb: null, pcpu: null });
  } finally { f.cleanup(); }
}, 15000);

test("retention keeps newest five owned incidents and all unowned history; caps run between maintenance ticks", () => {
  const f = fixture();
  try {
    const old = new Date(Date.now() - 40 * 86400000);
    for (let i = 0; i < 8; i++) {
      const dir = join(f.flight, `incident-2000-0${i}`); mkdirSync(dir); writeFileSync(join(dir, "note.txt"), "evidence");
      if (i > 0) { writeFileSync(join(dir, ".tap-owned"), "tap-tmux-v1\n"); utimesSync(join(dir, ".tap-owned"), old, old); }
    }
    const log = join(f.env.TMUX_FLIGHT_LOG_DIR, `tmux-server-${process.pid}.log`);
    mkdirSync(f.env.TMUX_FLIGHT_LOG_DIR); writeFileSync(log, "12345678901234567890");
    Object.assign(f.env, { TMUX_FLIGHT_LOG_CAP_BYTES: "10", TMUX_FLIGHT_LOG_TAIL_BYTES: "5" });
    f.state("true", "8", Math.floor(Date.now()/1000), 0);
    expect(f.run().exitCode).toBe(0);
    expect(f.incidents()).toHaveLength(6); expect(existsSync(join(f.flight, "incident-2000-00"))).toBe(true);
    expect(statSync(log).size).toBe(0);
    writeFileSync(log, "12345678901234567890");
    expect(f.run().exitCode).toBe(0); expect(statSync(log).size).toBe(0);
    expect(f.incidents()).toHaveLength(6);
  } finally { f.cleanup(); }
});

test("a missing timeout refuses instead of running an unbounded tmux child", () => {
  const f = fixture();
  try {
    Object.assign(f.env, { TMUX_FLIGHT_TIMEOUT_BIN: "/nonexistent/timeout" });
    expect(f.run().exitCode).toBe(2); expect(existsSync(join(f.root, "calls"))).toBe(false);
  } finally { f.cleanup(); }
});

test("legacy JSONL observations and earlier valid records survive malformed newer state fields", () => {
  const f = fixture();
  try {
    const day = new Date().toISOString().slice(0, 10), now = Math.floor(Date.now()/1000);
    writeFileSync(join(f.flight, ".state"), "torn");
    writeFileSync(join(f.flight, `${day}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), sock: "fixture", server_pid: "123456", alive: true, panes: 8 }) + "\n" +
      JSON.stringify({ _state: { socket: "-L:fixture", time: now, alive: false, panes: 0, pid: "bad", inventory: now, maintenance: now, incident: 0, count: 0 } }) + "\n");
    f.shim("tmux", "echo 'no server running on fixture' >&2; exit 1");
    expect(f.run().exitCode).toBe(4); expect(f.incidents()).toHaveLength(1);
  } finally { f.cleanup(); }
});

test("manual numeric overrides cannot disable the deadline or overflow cadence arithmetic", () => {
  const f = fixture();
  try {
    for (const value of ["0", "0.0", "31", "1e9", "NaN"]) {
      f.env.TMUX_FLIGHT_RT_TIMEOUT_S = value;
      expect(f.run().exitCode).toBe(2);
    }
    expect(existsSync(join(f.root, "calls"))).toBe(false);
  } finally { f.cleanup(); }
});

test("a stopped private server reaches the deadline and router-free birth preserves verbosity and exit-empty", () => {
  const f = fixture(), socket = join(process.env.TMUX_TMPDIR!, `flight-${process.pid}`), tmux = Bun.which("tmux")!;
  const env = { ...f.env, PATH: process.env.PATH, TMUX_FLIGHT_RT_TIMEOUT_S: "1" };
  let selected = socket;
  const invoke = (action: string) => Bun.spawnSync([bash, script, action, "-S", selected], { env, stdout: "pipe", stderr: "pipe", timeout: 15000 });
  const client = (...args: string[]) => Bun.spawnSync([tmux, "-S", socket, ...args], { env, stdout: "pipe", stderr: "pipe", timeout: 5000 });
  let pid = 0;
  try {
    expect(invoke("start-server").exitCode).toBe(0);
    pid = Number(client("display", "-p", "#{pid}").stdout.toString().trim()); expect(pid).toBeGreaterThan(0);
    symlinkSync(process.env.TMUX_TMPDIR!, join(f.root, "alias")); selected = join(f.root, "alias", `flight-${process.pid}`);
    expect(client("show-options", "-s", "-v", "exit-empty").stdout.toString().trim()).toBe("off");
    expect(existsSync(join(f.env.TMUX_FLIGHT_LOG_DIR, `tmux-server-${pid}.log`))).toBe(true);
    expect(invoke("sample").exitCode).toBe(0);
    // launchd supplies no locale; tmux then sanitizes -F tabs to '_' unless the tick sets its own ctype.
    const bare = Object.fromEntries(Object.entries(env).filter(([key]) => key !== "LANG" && !key.startsWith("LC_")));
    expect(Bun.spawnSync([bash, script, "sample", "-S", selected], { env: bare, stdout: "pipe", stderr: "pipe", timeout: 15000 }).exitCode).toBe(0);
    expect(f.observations().at(-1)).toMatchObject({ alive: true, panes: 1, sessions: 1 });
    expect(invoke("ensure").exitCode).toBe(0);
    expect(invoke("start-server").exitCode).toBe(4);
    process.kill(pid, "SIGSTOP");
    const start = performance.now(); expect(invoke("watch-once").exitCode).toBe(3);
    expect(performance.now() - start).toBeLessThan(10000);
    const note = readFileSync(join(f.flight, f.incidents().at(-1)!, "note.txt"), "utf8");
    expect(note).toContain(`server_pid: ${pid}\n`);
    expect(note).toContain("previous socket owner verified");
    expect(note).toContain("tmux:"); expect(note).toContain("uptime:");
    expect(readFileSync(join(f.flight, f.incidents().at(-1)!, "pgrep-tmux.txt"), "utf8")).toContain("UNVERIFIED");
    expect(invoke("ensure").exitCode).toBe(4);
    expect(f.observations().at(-1)).toMatchObject({ alive: null, rt_ms: -1 });
    process.kill(pid, "SIGCONT");
    expect(invoke("sample").exitCode).toBe(0);
    expect(client("display", "-p", "#{pid}").stdout.toString().trim()).toBe(String(pid));
    const hook = invoke("print-hook").stdout.toString(); expect(hook).toContain(bash); expect(hook).toContain("ensure");
  } finally {
    if (pid) { try { process.kill(pid, "SIGCONT"); } catch {} }
    client("kill-server"); f.cleanup();
  }
}, 30000);
