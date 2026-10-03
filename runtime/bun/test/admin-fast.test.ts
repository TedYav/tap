import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeScratchTree } from "./support/scratch";
import { observe } from "../src/verbs/team";
import { NO_MACHINE_INDEX } from "../src/selector";

const root = resolve(import.meta.dir, "../../..");
const scriptsDir = join(root, "skills/tap/scripts");
const realPython = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const scratch: string[] = [];
afterEach(() => { for (const p of scratch.splice(0)) removeScratchTree(p); }, 30000);
function fixture(count = 2) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "tap-admin-fast."))); scratch.push(base);
  const cwd = join(base, "outside"); const index = join(base, "index"); const bin = join(base, "bin");
  for (const p of [cwd, index, bin, join(base, "home")]) mkdirSync(p);
  const tap = join(bin, "tap"); symlinkSync(join(root, "bin/tap"), tap);
  const log = join(base, "spawns"); writeFileSync(log, "");
  const teams: Record<string, unknown> = {}; const sessions: string[] = []; const panes: string[] = [];
  function team(name: string, seats: Record<string, unknown>, corrupt = false) {
    const teamRoot = join(base, name); mkdirSync(join(teamRoot, ".tap", "bus", "payloads"), { recursive: true });
    const reg = join(teamRoot, ".tap", "team-registry.json");
    writeFileSync(reg, corrupt ? "{broken" : JSON.stringify({ schema: "0.20", team: { name, worktree_root: teamRoot }, seats }));
    teams[name] = { root: teamRoot, registry_location: reg, state: "registered" };
    writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams }));
    return reg;
  }
  function active(name: string, pane: number, overrides = {}) {
    sessions.push(`${name}\t1:1\t1`); panes.push(`${name}\t${name}:0.0\t%${pane}\tcodex\t123\t1:1\t0`);
    return { status: "active", session: name, pane: `${name}:0.0`, pane_id: `%${pane}`, harness: "codex", server_epoch: "srv:1:1", boot_id: "boot:1", ...overrides };
  }
  for (let i = 0; i < count; i++) team(`team${i}`, { sameHandle: active(`team${i}/sameHandle`, i + 1), stopped: { status: "suspended", harness: "codex" } });
  const saveSnapshot = () => { writeFileSync(join(base, "sessions"), sessions.join("\n") + "\n"); writeFileSync(join(base, "panes"), panes.join("\n") + "\n"); };
  saveSnapshot();
  // The classifier is no longer a python3 child, so FORBID_DEEP's allowance for
  // `tap_observe_seats.py` is gone with it: under FORBID_DEEP the fast path may
  // now spawn NO python3 at all, and this shim says exactly that.
  writeFileSync(join(bin, "python3"), `#!/bin/sh\nprintf 'python3\\n' >> "$PROBE_LOG"\nif [ "\${FORBID_DEEP:-}" = 1 ]; then echo unexpected-python >&2; exit 90; fi\nexec '${realPython}' "$@"\n`, { mode: 0o755 });
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
printf 'tmux %s\\n' "$*" >> "$PROBE_LOG"
case "$1" in
 list-sessions) [ "\${FAIL_SNAPSHOT:-}" != 1 ] || exit 1; cat "$SNAPSHOT_DIR/sessions" ;;
 list-panes) [ "\${PARTIAL_SNAPSHOT:-}" != 1 ] || exit 1; cat "$SNAPSHOT_DIR/panes" ;;
 capture-pane) printf 'ready\\n' ;;
 display-message) printf '1:1\\n' ;;
 *) exit 1 ;;
esac
`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: join(base, "home"), TAP_INDEX_HOME: index, TAP_HOME: "", TAP_BOOT_ID: "boot:1", TAP_BOOT_ID_LEGACY: "boot:1", TAP_SERVER_EPOCH: "srv:1:1", PROBE_LOG: log, SNAPSHOT_DIR: base, COLUMNS: "180", TAP_BUN_ROUTE_TRACE: join(base, "route") };
  delete env.TMUX; delete env.TMUX_PANE; delete env.TAP_SELF;
  const run = (args = ["admin", "dashboard", "--fast", "--json"], extras = {}) => {
    writeFileSync(log, ""); const start = performance.now();
    const result = spawnSync(tap, args, { cwd, env: { ...env, ...extras }, encoding: "utf8", timeout: 20000 });
    return { ...result, elapsed: performance.now() - start, spawns: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
  };
  return { base, cwd, index, env, team, active, saveSnapshot, run };
}

test("public fast roster is machine-wide, shares probes and retains same-named handles", () => {
  const f = fixture(3); const before = readFileSync(join(f.index, "global-registry.json"));
  const r = f.run(undefined, { FORBID_DEEP: "1" }); expect(r.status, r.stderr).toBe(0);
  const doc = JSON.parse(r.stdout); expect(doc.teams).toHaveLength(3); expect(doc.diagnostics).toEqual([]);
  for (const t of doc.teams) { expect(t.active).toBe(1); expect(t.seats.map((s: any) => s.handle)).toEqual(["sameHandle", "stopped"]); }
  expect(r.spawns.filter(s => s.startsWith("tmux list-sessions"))).toHaveLength(1);
  expect(r.spawns.filter(s => s.startsWith("tmux list-panes"))).toHaveLength(1);
  // ZERO, not one: the shared classifier moved in-process. The positive control
  // for this zero is two lines up — all three teams report `active: 1`, which
  // only a classification that actually ran can produce. A fast path that
  // skipped observation entirely would also log zero python3 spawns, and would
  // report every seat unknown.
  expect(r.spawns.filter(s => s === "python3")).toHaveLength(0);
  expect(r.spawns.some(s => /capture-pane|display-message|list-panes -s/.test(s))).toBe(false);
  expect(existsSync(join(f.cwd, ".tap"))).toBe(false); expect(readFileSync(join(f.index, "global-registry.json"))).toEqual(before);
  const text = f.run(["admin", "--fast"]); expect(text.status, text.stderr).toBe(0);
  expect(text.stdout).toContain("tap team: team0 (1 active)"); expect(text.stdout).toContain("handle"); expect(text.stdout).toContain("sameHandle");
}, 30000);

test("stopped/empty teams excluded; corrupt/unknown/poll teams diagnosed without counting as active", () => {
  const f = fixture(1);
  f.team("stopped", { parked: { status: "suspended" } }); f.team("empty", {}); f.team("corrupt", {}, true);
  f.team("unknown", { lost: { status: "active", harness: "codex" } });
  f.team("poll", { poller: { status: "active", delivery: "poll" } });
  f.team("stale", { old: f.active("stale/old", 9, { server_epoch: "srv:0:0" }) }); f.saveSnapshot();
  const r = f.run(); expect(r.status).toBe(1); const doc = JSON.parse(r.stdout);
  expect(doc.teams.map((t: any) => t.name)).toEqual(["team0"]);
  expect(doc.diagnostics.map((d: any) => d.team).sort()).toEqual(["corrupt", "poll", "unknown"]);
  expect(r.stderr).toContain("poll_liveness_unobservable");
}, 30000);

test("an incapable-only team is stopped-like: excluded, never diagnosed as a new class", () => {
  const f = fixture(1);
  f.team("incapable", { marked: { status: "suspended", status_reason: "incapable", harness: "codex", pane: "x:0.0", pane_id: "%5", server_epoch: "srv:1:1", boot_id: "boot:1", instance: "m|i" } });
  f.saveSnapshot();
  const r = f.run();
  expect(r.status, r.stderr).toBe(0);
  const doc = JSON.parse(r.stdout);
  expect(doc.teams.map((t: any) => t.name)).toEqual(["team0"]);
  expect(doc.diagnostics.map((d: any) => d.team)).toEqual([]);
}, 30000);

test("snapshot failure and partial snapshot produce diagnostics without per-session fallback", () => {
  const f = fixture(3);
  for (const env of [{ FAIL_SNAPSHOT: "1" }, { PARTIAL_SNAPSHOT: "1" }]) {
    const r = f.run(undefined, env); expect(r.status).toBe(1); const doc = JSON.parse(r.stdout);
    expect(doc.teams).toEqual([]); expect(doc.diagnostics.length).toBeGreaterThanOrEqual(3);
    expect(r.spawns.filter(s => s.startsWith("tmux list-panes"))).toHaveLength(1);
  }
}, 30000);

test("incompatible flags refuse before probes; empty/corrupt machine index stays machine-wide", () => {
  const f = fixture(0);
  for (const args of [["admin", "dashboard", "--fast", "--full", "--json"], ["admin", "refresh", "--fast", "--json"]]) {
    const r = f.run(args); expect(r.status).toBe(1); expect(JSON.parse(r.stdout).diagnostics[0].reason).toBe("usage_error"); expect(r.spawns).toEqual([]);
  }
  writeFileSync(join(f.index, "global-registry.json"), "{broken"); const bad = f.run();
  expect(bad.status).toBe(1); expect(JSON.parse(bad.stdout).ok).toBe(false); expect(bad.spawns).toEqual([]);
  expect(existsSync(join(f.cwd, ".tap"))).toBe(false);
}, 30000);

test("an absent machine index reports unanchored_bus, never a stray teams.json roster", () => {
  const f = fixture(1);
  // The stray legacy index enrolls a live team: a fallback would count it.
  const indexed = readFileSync(join(f.index, "global-registry.json"));
  rmSync(join(f.index, "global-registry.json"));
  writeFileSync(join(f.index, "teams.json"), indexed);
  const r = f.run();
  expect(r.status).toBe(1);
  expect(JSON.parse(r.stdout)).toEqual({
    ok: false,
    fast: true,
    teams: [],
    diagnostics: [{ reason: "unanchored_bus", detail: NO_MACHINE_INDEX }],
  });
  expect(r.stderr).toBe(`tap admin --fast: machine: unanchored_bus (${NO_MACHINE_INDEX})\n`);
  expect(r.spawns).toEqual([]);
  expect(readFileSync(join(f.index, "teams.json"))).toEqual(indexed);
}, 30000);

test("an invalid byte in an acting registry refuses that team, not the roster", () => {
  const f = fixture(1);
  const reg = f.team("rustled", { sameHandle: f.active("rustled/sameHandle", 5) });
  // Poison an UNRELATED field with a raw invalid byte; the team identity
  // fields stay intact, so only a strict decode can tell the file is unread.
  const raw = readFileSync(reg, "utf8");
  const poisoned = Buffer.concat([
    Buffer.from('{"note":"caf'), Buffer.from([0xe9]), Buffer.from('r","'),
    Buffer.from(raw.slice(2)),
  ]);
  writeFileSync(reg, poisoned);
  f.saveSnapshot();
  const r = f.run(undefined, { FORBID_DEEP: "1" });
  expect(r.status).toBe(1);
  const doc = JSON.parse(r.stdout);
  expect(doc.teams.map((t: any) => t.name)).toEqual(["team0"]);
  const hit = doc.diagnostics.find((d: any) => d.team === "rustled");
  expect(hit.reason).toBe("registry_unobservable");
  expect(hit.detail.length).toBeGreaterThan(0);
  expect(r.stderr).toContain("registry_unobservable");
  // A refusal is a read: the poisoned bytes must survive the run untouched.
  expect(readFileSync(reg)).toEqual(poisoned);

  // Door-local controls, same team, same unrelated field:
  // - a VALID multibyte note keeps the team fully visible;
  // - a file-leading BOM makes the whole document unparseable for this
  //   reader, so the team goes registry_unobservable while the healthy
  //   sibling still counts — decodability is the line, not content.
  const multibyte = Buffer.concat([
    Buffer.from('{"note":"caf'), Buffer.from([0xc3, 0xa9]), Buffer.from('r","'),
    Buffer.from(raw.slice(2)),
  ]);
  writeFileSync(reg, multibyte);
  const visible = f.run(undefined, { FORBID_DEEP: "1" });
  expect(visible.status, visible.stderr).toBe(0);
  expect(JSON.parse(visible.stdout).teams.map((t: any) => t.name)).toEqual(["rustled", "team0"]);

  const bommed = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(raw)]);
  writeFileSync(reg, bommed);
  const refused = f.run(undefined, { FORBID_DEEP: "1" });
  expect(refused.status).toBe(1);
  const refusedDoc = JSON.parse(refused.stdout);
  expect(refusedDoc.teams.map((t: any) => t.name)).toEqual(["team0"]);
  const bomHit = refusedDoc.diagnostics.find((d: any) => d.team === "rustled");
  expect(bomHit.reason).toBe("registry_unobservable");
  expect(bomHit.detail.length).toBeGreaterThan(0);
  expect(readFileSync(reg)).toEqual(bommed);
}, 30000);

test("controlled before/after: full dashboard versus fast roster on identical population", () => {
  const f = fixture(2);
  const before = f.run(["admin", "dashboard", "--json"]);
  const after = f.run(); expect(after.status, after.stderr).toBe(0);
  expect(after.spawns.length).toBeLessThan(before.spawns.length);
  const evidence = { teams: 2, seats: 4, full: { elapsed_ms: Math.round(before.elapsed), exit: before.status, timed_out: before.error?.message.includes("ETIMEDOUT") || false, python_tmux_spawns: before.spawns.length }, fast: { elapsed_ms: Math.round(after.elapsed), exit: after.status, python_tmux_spawns: after.spawns.length } };
  console.log(`ADMIN_FAST_MEASUREMENT ${JSON.stringify(evidence)}`);
}, 45000);


// Was "failed classifier output stays off JSON stdout", driven by a python3 on
// PATH that exited 91 with partial output. The fast roster is a native-only verb
// and its classifier is now an in-process function over a payload this code
// builds itself, so NO INPUT AND NO ENVIRONMENT can make it fail — the arm
// cannot keep its old shape without an environment fault door in production,
// which was considered and refused.
//
// What survives, and where:
//   - degrade-to-unknown-with-diagnostics end to end, through a LIVE injection:
//     the FAIL_SNAPSHOT / PARTIAL_SNAPSHOT arm above, where tmux really fails.
//   - the classifier-cannot-finish half: here, at the engine seam.
// The consequence worth naming is that `admin-fast.ts`'s `observations.code !==
// 0` branch now has no input-driven reach. It is kept as a defensive mapping,
// not because a caller can provoke it.
test("a classification that could not finish yields no rows for the fast roster to count", () => {
  const diagnostics: string[] = [];
  const rows = [{
    handle: "sameHandle", status: "active", delivery: "pane", pane: "team0/sameHandle:0.0",
    pane_id: "%1", session: "team0/sameHandle", server_epoch: "srv:1:1", harness: "codex",
  }] as unknown as Parameters<typeof observe>[0];
  const result = observe(rows, scriptsDir, true, text => { diagnostics.push(text); }, () => {
    throw new Error("classifier exploded");
  });
  expect(result.code).not.toBe(0);
  // Empty, so every seat falls to `unknown` / `observation_failed` and none can
  // be counted active on a partial answer.
  expect(result.rows.size).toBe(0);
  expect(diagnostics.join("")).toContain("classifier exploded");
}, 30000);


test("malformed maps and seat identity fields are diagnosed, never counted as live", () => {
  const f = fixture(1);
  const badMap = f.team("badMap", {}); writeFileSync(badMap, JSON.stringify({ agents: null }));
  const missing = f.team("missingMap", {}); writeFileSync(missing, "{}");
  f.team("badSeat", { peer: f.active("badSeat/peer", 7, { delivery: 42 }) }); f.saveSnapshot();
  const r = f.run(); expect(r.status).toBe(1); const doc = JSON.parse(r.stdout);
  expect(doc.teams.map((t: any) => t.name)).toEqual(["team0"]);
  expect(doc.diagnostics.map((d: any) => d.team).sort()).toEqual(["badMap", "badSeat", "missingMap"]);
}, 30000);


test("public admin ps uses one resource snapshot across teams and keeps JSON pure", () => {
  const f = fixture(2);
  writeFileSync(join(f.base, "bin", "ps"), `#!/bin/sh
printf 'ps %s\\n' "$*" >> "$PROBE_LOG"
printf '123 123 123 7.5 204800 01:23 S codex codex\\n'
`, {mode: 0o755});
  writeFileSync(join(f.base, "bin", "footprint"), `#!/bin/sh
printf 'footprint %s\\n' "$*" >> "$PROBE_LOG"
printf 'codex [123]: 64-bit    Footprint: 2147483648 B\\n'
`, {mode: 0o755});
  const r = f.run(["admin", "ps", "--json"]);
  expect(r.status, r.stderr).toBe(0); expect(r.stderr).toBe("");
  const doc = JSON.parse(r.stdout);
  expect(doc.seats).toHaveLength(2);
  expect(doc.seats[0]).toMatchObject({pid:123, cpu_percent:7.5, rss_kib:204800});
  expect(r.spawns.filter(s => s.startsWith("ps "))).toHaveLength(1);
  expect(doc.seats[0].footprint_kib).toBe(process.platform === "darwin" ? 2097152 : null);
  expect(r.spawns.filter(s => s.startsWith("footprint "))).toHaveLength(process.platform === "darwin" ? 1 : 0);
  expect(r.stdout).not.toContain("\x1b");
  const bad = f.run(["admin", "ps", "--fix", "--json"]);
  expect(bad.status).toBe(1); expect(JSON.parse(bad.stdout).error_class).toBe("usage_error");
  expect(bad.spawns).not.toContainEqual(expect.stringContaining("ps "));
}, 30000);
