import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeScratchTree } from "./support/scratch";

const repo = resolve(import.meta.dir, "../../..");
const fixtures: ReturnType<typeof fixture>[] = [];
let nextFixture = 0;
function tm(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync("tmux", ["-L", env.TAP_TMUX_SOCKET!, ...args], { env, encoding: "utf8" });
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "retire.")));
  const index = join(root, "index"), bus = join(root, ".tap", "bus"), registry = join(root, ".tap", "team-registry.json");
  mkdirSync(index); mkdirSync(bus, { recursive: true });
  writeFileSync(join(bus, "reset-generation.json"), '{"state":"pristine"}\n');
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    team: { root, registry_location: registry, state: "registered" },
  } }));
  const env: NodeJS.ProcessEnv = { ...process.env, TAP_HOME: bus, TAP_INDEX_HOME: index,
    TAP_TMUX_SOCKET: `retire-${process.pid}-${nextFixture++}`, TAP_TMUX_SOCKET_PATH: undefined,
    TMUX: undefined, TMUX_PANE: undefined, TAP_SELF: undefined, TAP_SERVER_EPOCH: undefined, TAP_BOOT_ID: undefined };
  const put = (seats: Record<string, unknown>) => writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "team" }, seats }));
  const get = () => JSON.parse(readFileSync(registry, "utf8"));
  const run = (...args: string[]) => spawnSync(process.execPath, [join(repo, "runtime/bun/main.ts"), ...args], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
  put({});
  const f = { root, bus, registry, env, put, get, run };
  return f;
}
function trackedFixture() { const f = fixture(); fixtures.push(f); return f; }
afterEach(() => {
  for (const f of fixtures.splice(0)) { tm(f.env, "kill-server"); removeScratchTree(f.root); }
});
const row = (pane: string, crew = false) => ({ session: "team/owner", pane_id: pane, pane: "team/owner:0.0", instance: `${crew ? "crew" : "owner"}|stable`, status: "active", crew, delivery: "pane" });
function session(f: ReturnType<typeof fixture>) {
  return tm(f.env, "new-session", "-d", "-s", "team/owner", "-P", "-F", "#{pane_id}", "sleep 120").stdout.trim();
}
function alive(f: ReturnType<typeof fixture>, pane: string): boolean {
  return tm(f.env, "display-message", "-p", "-t", pane, "#{pane_id}").stdout.trim() === pane;
}

function mutated(f: ReturnType<typeof fixture>, mutant: string, ...args: string[]) {
  return spawnSync(process.execPath, [join(import.meta.dir, "support/lifecycle-mutant.ts"), ...args], {
    cwd: f.root, env: { ...f.env, LIFECYCLE_MUTANT: mutant }, encoding: "utf8", timeout: 20_000,
  });
}

test("matrix crew-effect mutation changes public dispatch, not only labels", () => {
  const f = trackedFixture(), owner = session(f);
  const crew = tm(f.env, "split-window", "-d", "-t", owner, "-P", "-F", "#{pane_id}", "sleep 120").stdout.trim();
  f.put({ owner: row(owner), crew: row(crew, true) });
  const result = mutated(f, "crew-effect-none", "out", "crew");
  expect(result.status).toBe(0);
  expect(f.get().seats.crew).toBeUndefined();
  // The paired healthy public control below kills this pane. Altering the fate
  // bypasses D, so this result would fail the healthy dismissal assertion.
  expect(alive(f, crew)).toBe(true); expect(alive(f, owner)).toBe(true);
});

test("matrix hard-stop mutation suppresses the actual stop on the public shutdown route", () => {
  const f = trackedFixture(), owner = session(f);
  f.put({ owner: row(owner) });
  expect(mutated(f, "hard-effect-none", "shutdown", "owner", "--json").status).toBe(0);
  expect(f.get().seats.owner).toBeUndefined();
  expect(alive(f, owner)).toBe(true);
});

for (const flags of [[], ["--kill"]]) {
  test(`one retirement codec is load-bearing for out ${flags.join(" ")}`, () => {
    const f = trackedFixture(), pane = session(f);
    f.put({ owner: row(pane) });
    const before = readFileSync(f.registry, "utf8");
    const result = mutated(f, "codec-failure", "out", "owner", ...flags, "--json");
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("retirement codec mutant");
    expect(readFileSync(f.registry, "utf8")).toBe(before);
    expect(alive(f, pane)).toBe(true);
  });
}

test("durable out retires membership while its real private session survives", () => {
  const f = trackedFixture(), owner = session(f);
  f.put({ owner: row(owner) });
  const result = f.run("out", "team/owner", "--json");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ lifecycle_action: "out", mechanism: "seat-out", outcome: "retired" });
  expect(f.get().seats.owner).toBeUndefined();
  expect(alive(f, owner)).toBe(true);
});

for (const args of [["out", "team/crew"], ["crew", "shutdown", "team/crew"], ["shutdown", "team/crew"], ["out", "team/crew", "--hard"]]) {
  test(`${args.join(" ")}: same dismissal owner stops only the crew split and labels its action`, () => {
    const f = trackedFixture(), owner = session(f);
    const crew = tm(f.env, "split-window", "-d", "-t", owner, "-P", "-F", "#{pane_id}", "sleep 120").stdout.trim();
    f.put({ owner: row(owner), crew: row(crew, true) });
    f.env.TAP_BUN_ROUTE_TRACE = join(f.root, "route-trace");
    const result = f.run(...args, "--json");
    expect(result.status).toBe(0);
    expect(readFileSync(f.env.TAP_BUN_ROUTE_TRACE, "utf8")).toBe(`native ${args[0]}\n`);
    const action = args.includes("--hard") ? "out-hard" : args[0] === "out" ? "out" : "shutdown";
    expect(JSON.parse(result.stdout)).toMatchObject({ lifecycle_action: action, mechanism: "crew-dismiss", outcome: "dismissed", pane_id: crew });
    expect(f.get().seats.crew).toBeUndefined();
    expect(f.get().seats.owner).toBeDefined();
    expect(alive(f, owner)).toBe(true); expect(alive(f, crew)).toBe(false);
    const event = readFileSync(join(f.bus, "registry-events.log"), "utf8");
    expect(event).toContain(`action=${action === "out" ? "unregistered" : action}`);
    expect(event).toContain(`detail=lifecycle_action=${action};mechanism=crew-dismiss`);
  });
}

for (const args of [["shutdown", "team/owner"], ["out", "owner", "--team", "team", "--hard"], ["out", "team/owner", "--kill"]]) {
  test(`${args.join(" ")}: shared hard removal stops the owner and retires its crew`, () => {
    const f = trackedFixture(), owner = session(f);
    const crew = tm(f.env, "split-window", "-d", "-t", owner, "-P", "-F", "#{pane_id}", "sleep 120").stdout.trim();
    const foreign = tm(f.env, "new-session", "-d", "-s", "foreign", "-P", "-F", "#{pane_id}", "sleep 120").stdout.trim();
    f.put({ owner: row(owner), crew: row(crew, true), foreign: { ...row(foreign), session: "foreign" } });
    f.env.TAP_BUN_ROUTE_TRACE = join(f.root, "route-trace");
    const result = f.run(...args, "--json");
    expect(result.status).toBe(0);
    expect(readFileSync(f.env.TAP_BUN_ROUTE_TRACE, "utf8")).toBe(`native ${args[0]}\n`);
    const action = args[0] === "shutdown" ? "shutdown" : "out-hard";
    expect(JSON.parse(result.stdout)).toMatchObject({ lifecycle_action: action, mechanism: "hard-removal", outcome: "stopped", crews: ["crew"] });
    expect(f.get().seats.owner).toBeUndefined(); expect(f.get().seats.crew).toBeUndefined();
    expect(alive(f, owner)).toBe(false); expect(alive(f, crew)).toBe(false); expect(alive(f, foreign)).toBe(true);
    expect(readdirSync(join(f.root, ".tap/team-history"))).toHaveLength(2);
    expect(readFileSync(join(f.bus, "registry-events.log"), "utf8")).toContain(`action=${action}`);
  });
}

test("hard removal of a stopped durable row retires without claiming a stop", () => {
  const f = trackedFixture(); f.put({ owner: row("%999") });
  const result = f.run("shutdown", "owner", "--json");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "already_stopped", mechanism: "hard-removal" });
  expect(f.get().seats.owner).toBeUndefined();
});

test("hard removal refuses a reused name or mismatched crew provenance", () => {
  const f = trackedFixture(), owner = session(f);
  const crew = tm(f.env, "split-window", "-d", "-t", owner, "-P", "-F", "#{pane_id}", "sleep 120").stdout.trim();
  for (const seats of [{ owner: row("%9999") }, { owner: { ...row(owner), server_socket: "/unrelated/server" } }, { owner: row(owner), crew: { ...row(crew, true), session: "foreign" } }]) {
    f.put(seats);
    const before = readFileSync(f.registry, "utf8");
    expect(f.run("shutdown", "owner", "--json").status).toBe(1);
    expect(readFileSync(f.registry, "utf8")).toBe(before);
    expect(alive(f, owner)).toBe(true); expect(alive(f, crew)).toBe(true);
  }
});

function quote(s: string) { return "'" + s.replaceAll("'", "'\\''") + "'"; }
test("self hard removal leaves exactly one receipt, stamp, event and tombstone before stop", async () => {
  const f = trackedFixture(), owner = session(f);
  tm(f.env, "new-session", "-d", "-s", "observer", "sleep 120");
  f.put({ owner: row(owner) });
  const receipt = join(f.root, "self.json");
  const env = Object.entries(f.env).filter(([key, value]) => value !== undefined && (key.startsWith("TAP_") || ["HOME", "PATH", "TMUX_TMPDIR"].includes(key))).map(([key, value]) => quote(`${key}=${value}`)).join(" ");
  const command = `cd ${quote(f.root)} && exec env ${env} ${quote(process.execPath)} ${quote(join(repo, "runtime/bun/main.ts"))} shutdown owner --json > ${quote(receipt)} 2> ${quote(receipt + ".err")}`;
  expect(tm(f.env, "respawn-pane", "-k", "-t", owner, command).status).toBe(0);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && alive(f, owner)) await Bun.sleep(50);
  expect(alive(f, owner)).toBe(false);
  expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({ outcome: "stop_requested", lifecycle_action: "shutdown", mechanism: "hard-removal" });
  expect(readFileSync(receipt + ".err", "utf8")).toBe("");
  expect(f.get().seats.owner).toBeUndefined();
  expect(readdirSync(join(f.root, ".tap/team-history"))).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(f.bus, "reset-generation.json"), "utf8")).state).toBe("reused");
  expect(readFileSync(join(f.bus, "registry-events.log"), "utf8")).toContain("lifecycle_action=shutdown;mechanism=hard-removal;outcome=stop_requested");
}, 20000);

test("crew out keeps the last pane and explains the retained process", () => {
  const f = trackedFixture(), pane = session(f);
  f.put({ crew: row(pane, true) });
  const result = f.run("out", "crew", "--json");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ mechanism: "crew-dismiss", outcome: "retired_pane_retained" });
  expect(result.stdout).toContain("last in session");
  expect(alive(f, pane)).toBe(true); expect(f.get().seats.crew).toBeUndefined();
});

for (const failed of [false, true]) test(`owner-wide JSON is one value with each crew outcome (save failure=${failed})`, () => {
  const f = trackedFixture(), owner = session(f);
  const a = tm(f.env, "new-window", "-d", "-t", "team/owner", "-P", "-F", "#{pane_id}", "sleep 120").stdout.trim();
  const b = tm(f.env, "new-window", "-d", "-t", "team/owner", "-P", "-F", "#{pane_id}", "sleep 120").stdout.trim();
  f.put({ owner: row(owner), a: { ...row(a, true), instance: "a|stable" }, b: { ...row(b, true), instance: "b|stable" } });
  if (failed) f.env.TAP_TEST_UNREGISTER_SAVE_FAIL = "1";
  const result = f.run("crew", "shutdown", "--owner", "owner", "--json");
  expect(result.status).toBe(failed ? 1 : 0);
  const receipt = JSON.parse(result.stdout);
  expect(receipt.results).toHaveLength(2);
  expect(receipt.results.map((r: { ok: boolean }) => r.ok)).toEqual([!failed, !failed]);
  if (failed) expect(receipt.results.every((r: { error_class: string }) => r.error_class === "registry_invalid")).toBe(true);
  expect(alive(f, owner)).toBe(true);
  expect(alive(f, a)).toBe(failed); expect(alive(f, b)).toBe(failed);
  expect(result.stderr).not.toContain("at retireSelected");
});

test("selected retirement refuses a replacement instance before row or pane effects", async () => {
  const f = trackedFixture(), owner = session(f);
  const crew = tm(f.env, "split-window", "-d", "-t", owner, "-P", "-F", "#{pane_id}", "sleep 120").stdout.trim();
  f.put({ owner: row(owner), crew: row(crew, true) });
  const barrier = join(f.root, "barrier");
  const proc = Bun.spawn([process.execPath, join(repo, "runtime/bun/main.ts"), "out", "crew", "--json"], {
    cwd: f.root, env: { ...f.env, TAP_SCRATCH_ONLY: f.root, TAP_OUT_RETIRE_TEST_BARRIER: barrier, TAP_OUT_RETIRE_TEST_STAGE: "after-select" },
    stdout: "pipe", stderr: "pipe",
  });
  const deadline = Date.now() + 10000;
  while (!existsSync(barrier + ".ready") && Date.now() < deadline) await Bun.sleep(20);
  expect(existsSync(barrier + ".ready")).toBe(true);
  const replacement = { ...row(crew, true), instance: "crew|replacement" };
  f.put({ owner: row(owner), crew: replacement });
  const before = readFileSync(f.registry, "utf8");
  writeFileSync(barrier + ".continue", "");
  expect(await proc.exited).toBe(1);
  expect(JSON.parse(await new Response(proc.stdout).text())).toMatchObject({ error_class: "seat_changed" });
  expect(readFileSync(f.registry, "utf8")).toBe(before);
  expect(alive(f, crew)).toBe(true); expect(alive(f, owner)).toBe(true);
  expect(existsSync(join(f.bus, "registry-events.log"))).toBe(false);
}, 20000);
