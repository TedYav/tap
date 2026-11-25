// tap-s1dqn — dead letters: unsettled canonical mail whose addressee the
// registry positively shows is gone. Health counts them apart without raising
// attention, and `tap cancel --dead-letters` withdraws them (its --dry-run
// resolving the same targets). Every case drives the public door (main.ts).
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeScratchTree } from "./support/scratch";

const MAIN = join(import.meta.dir, "../main.ts");
const scratch: string[] = [];
afterEach(() => { for (const p of scratch.splice(0)) removeScratchTree(p); }, 30000);

interface Fix { root: string; cwd: string; bus: string; registry: string; env: Record<string, string> }
function fix(): Fix {
  const root = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "tap-deadletter.")));
  scratch.push(root);
  const cwd = join(root, "team"), bus = join(cwd, ".tap", "bus"), index = join(root, "idx"), fakeBin = join(root, "bin");
  const registry = join(cwd, ".tap", "team-registry.json");
  for (const d of [join(bus, "payloads"), join(bus, "receipts"), join(bus, "spool"), index, fakeBin]) mkdirSync(d, { recursive: true });
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { t: { root: cwd, registry_location: registry, state: "registered" } } }));
  writeFileSync(join(bus, "reset-generation.json"), '{"state":"pristine"}\n');
  writeFileSync(join(fakeBin, "tmux"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const env: Record<string, string> = { ...process.env, HOME: join(root, "u"), TAP_HOME: bus, TAP_INDEX_HOME: index, TAP_LOCK_DIR: join(root, "locks"),
    TAP_TMUX_SOCKET: `deadletter-${process.pid}`, TAP_SESSION_MANIFEST: join(root, "sess.json"), TAP_VERSION_SEEN_PATH: join(root, "seen.json"),
    OPENCODE_DB_PATH: join(root, "opencode.db"), TAP_SPOOL_DISABLE_DELIVERER: "1", NO_COLOR: "1", TAP_SCRATCH_ONLY: root } as Record<string, string>;
  for (const k of ["TMUX", "TMUX_PANE", "TAP_SELF", "TAP_JSON"]) delete (env as Record<string, string | undefined>)[k];
  env.PATH = `${fakeBin}:${env.PATH}`;
  return { root, cwd, bus, registry, env };
}
// Poll seats keep health's restart census out of these cases.
const seat = (h: string, over: Record<string, unknown> = {}) => ({ delivery: "poll", status: "active", instance: `${h}|1`, ...over });
function reg(f: Fix, doc: Record<string, unknown>): void {
  writeFileSync(f.registry, `${JSON.stringify({ schema: "0.20", team: { name: "t" }, ...doc }, null, 2)}\n`);
}
/** Rewrite the machine index: team t stays enrolled; `teams` adds or overrides others. */
function enroll(f: Fix, teams: Record<string, unknown>): void {
  writeFileSync(join(f.root, "idx", "global-registry.json"), JSON.stringify({ schema: "0.20",
    teams: { t: { root: f.cwd, registry_location: f.registry, state: "registered" }, ...teams } }));
}
/** A foreign team's registry file at `<root>/<dir>/team-registry.json`; returns its path. */
function foreignRegistry(f: Fix, team: string, seats: Record<string, unknown>, dir = team, name = team): string {
  const path = join(f.root, dir, "team-registry.json");
  mkdirSync(join(f.root, dir), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ schema: "0.20", team: { name }, seats }, null, 2)}\n`);
  return path;
}
function mail(f: Fix, id: string, to: string, extra = ""): string {
  const path = join(f.bus, "payloads", `${id}.md`);
  writeFileSync(path, `---\nid: ${id}\nfrom: lead\nto: ${to}\nkind: discuss\nreply: expected\npath: ${path}\n${extra}---\nbody\n`);
  return path;
}
function run(f: Fix, args: string[], over: Record<string, string> = {}) {
  const r = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd: f.cwd, env: { ...f.env, ...over }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
function health(f: Fix) {
  const r = run(f, ["health", "--json"]);
  const report = JSON.parse(r.out) as { status: string; attention: { type: string; id?: string }[]; unsettled: { id: string }[]; dead_letters?: { count: number; action: string } };
  return { code: r.code, report, err: r.err };
}
const cancelled = (f: Fix, id: string) => join(f.bus, "receipts", `${id}.cancelled`);
function snapshot(dir: string): string {
  const parts: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else parts.push(`${p}:${statSync(p).mtimeMs}:${readFileSync(p).length}`);
    }
  };
  walk(dir);
  return parts.join("\n");
}

test("health counts mail to a gone seat apart, without attention; mail to a live seat stays attention", () => {
  const f = fix();
  reg(f, { seats: { alpha: seat("alpha") } });
  mail(f, "d-001", "ghost");
  const dead = health(f);
  expect(dead.code, dead.err).toBe(0);
  expect(dead.report.status).toBe("healthy");
  expect(dead.report.unsettled).toEqual([]);
  expect(dead.report.dead_letters).toEqual({ count: 1, action: "tap cancel --dead-letters --dry-run" });
  const human = run(f, ["health"]);
  expect(human.out).toContain("tap health: ok");
  expect(human.out).toContain("1 unsettled to retired seats (no attention); clean up: tap cancel --dead-letters --dry-run");

  mail(f, "l-002", "alpha");
  const live = health(f);
  expect(live.code).toBe(2);
  expect(live.report.unsettled.map((u) => u.id)).toEqual(["l-002"]);
  expect(live.report.attention.filter((a) => a.type === "unsettled-payload").map((a) => a.id)).toEqual(["l-002"]);
  expect(live.report.dead_letters?.count).toBe(1);
});

test("a resident payload with a .cancelled receipt is terminal for health", () => {
  const f = fix();
  reg(f, { seats: { alpha: seat("alpha") } });
  mail(f, "w-001", "alpha");
  writeFileSync(cancelled(f, "w-001"), '{"id":"w-001","status":"cancelled","via":"withdrawn"}\n');
  const h = health(f);
  expect(h.code, h.err).toBe(0);
  expect(h.report.unsettled).toEqual([]);
  expect(h.report.dead_letters).toBeUndefined();
});

// Fail closed: nothing below is positive evidence that the addressee is gone.
const uncertain: Array<[string, (f: Fix) => void, string]> = [
  ["seats null", (f) => reg(f, { seats: null }), ""],
  ["seats missing", (f) => reg(f, {}), ""],
  ["a scalar seat row", (f) => reg(f, { seats: { alpha: "broken" } }), ""],
  ["no team name", (f) => writeFileSync(f.registry, JSON.stringify({ schema: "0.20", seats: {} })), ""],
  ["a foreign team's bare enrollment (no registry_location)", (f) => { reg(f, { seats: {} }); enroll(f, { other: { root: join(f.root, "o") } }); }, "to_team: other\n"],
  ["a foreign team's relative registry_location", (f) => { reg(f, { seats: {} }); enroll(f, { other: { root: join(f.root, "o"), registry_location: "o/reg.json" } }); }, "to_team: other\n"],
  ["a directory at a foreign team's registry_location", (f) => {
    reg(f, { seats: {} }); mkdirSync(join(f.root, "o", "reg.json"), { recursive: true });
    enroll(f, { other: { root: join(f.root, "o"), registry_location: join(f.root, "o", "reg.json") } });
  }, "to_team: other\n"],
  ["a foreign registry naming another team", (f) => {
    reg(f, { seats: {} });
    enroll(f, { other: { root: join(f.root, "o"), registry_location: foreignRegistry(f, "other", {}, "o", "impostor") } });
  }, "to_team: other\n"],
  ["a foreign registry with a scalar row", (f) => {
    reg(f, { seats: {} });
    enroll(f, { other: { root: join(f.root, "o"), registry_location: foreignRegistry(f, "other", { x: "broken" }, "o") } });
  }, "to_team: other\n"],
  ["an unreadable machine index", (f) => { reg(f, { seats: {} }); writeFileSync(join(f.root, "idx", "global-registry.json"), "{ not json"); }, "to_team: other\n"],
  ["a manual relay (cross_worktree, no to_team)", (f) => reg(f, { seats: {} }), "cross_worktree: true\n"],
  ["an explicit forwarding edge", (f) => reg(f, { seats: { beta: seat("beta") }, seat_forwardings: [
    { source: "ghost", source_instance: "ghost|1", destination: "beta", destination_instance: "beta|1", at: "2026-10-01T00:00:00Z", address_active: true }] }), ""],
  ["a qualified forwarding destination after source reuse", (f) => reg(f, {
    schema: "0.21", seats: { ghost: seat("ghost", { instance: "ghost|2" }) }, seat_forwardings: [
      { source: "ghost", source_instance: "ghost|1", destination: "other/beta", destination_instance: "beta|1",
        at: "2026-10-01T00:00:00Z", address_active: false }],
  }), "recipient_instance: ghost|1\n"],
  ["an adoption grant", (f) => reg(f, { seats: { beta: seat("beta", { adopted_handles: ["ghost"] }) } }), ""],
];
for (const [label, arrange, extra] of uncertain) {
  test(`mail stays actionable, and the sweep withdraws nothing, with ${label}`, () => {
    const f = fix();
    arrange(f);
    mail(f, "u-001", "ghost", extra);
    const h = run(f, ["health", "--json"]);
    // A registry health cannot decode refuses outright; one it decodes keeps the mail live.
    if (h.code !== 1) {
      const report = JSON.parse(h.out) as { unsettled: { id: string }[]; dead_letters?: { count: number } };
      expect(report.unsettled.map((u) => u.id)).toEqual(["u-001"]);
      expect(report.dead_letters).toBeUndefined();
    }
    run(f, ["cancel", "--dead-letters"]);
    expect(existsSync(cancelled(f, "u-001"))).toBe(false);
  });
}

test("sweep --dry-run lists exactly the real run's targets and writes nothing", () => {
  const f = fix();
  reg(f, { seats: { alpha: seat("alpha") } });
  mail(f, "a-001", "ghost");
  mail(f, "b-002", "alpha");
  mail(f, "c-003", "gone2");
  mail(f, "d-004", "ghost");
  writeFileSync(join(f.bus, "receipts", "d-004.done"), "");
  const before = snapshot(f.cwd);
  const dry = run(f, ["cancel", "--dead-letters", "--dry-run", "--json"]);
  expect(dry.code, dry.err).toBe(0);
  const preview = JSON.parse(dry.out) as { dry_run: boolean; count: number; targets: { id: string; to: string }[] };
  expect(preview).toMatchObject({ dry_run: true, count: 2 });
  expect(preview.targets.map((t) => t.id)).toEqual(["a-001", "c-003"]);
  expect(snapshot(f.cwd)).toBe(before);
  const human = run(f, ["cancel", "--dead-letters", "--dry-run"]);
  expect(human.out).toContain("2 dead letters on team 't' (dry run; nothing written)");

  const real = run(f, ["cancel", "--dead-letters", "--json"]);
  expect(real.code, real.err).toBe(0);
  expect(JSON.parse(real.out)).toMatchObject({ ok: true, dry_run: false, count: 2, disposed: ["a-001", "c-003"], skipped: [] });
  for (const id of ["a-001", "c-003"]) {
    expect(existsSync(join(f.bus, "payloads", `${id}.md`))).toBe(true);
    expect(JSON.parse(readFileSync(cancelled(f, id), "utf8"))).toMatchObject({
      id, status: "cancelled", via: "cancelled", by: "tap cancel --dead-letters", reason: "seat_unresolvable", target_status: "gone", source: "payloads" });
  }
  expect(existsSync(cancelled(f, "b-002"))).toBe(false);
  expect(existsSync(cancelled(f, "d-004"))).toBe(false);
  const after = health(f);
  expect(after.report.dead_letters).toBeUndefined();
  expect(after.report.unsettled.map((u) => u.id)).toEqual(["b-002"]);
  // Idempotent: a second run finds nothing.
  expect(JSON.parse(run(f, ["cancel", "--dead-letters", "--json"]).out)).toMatchObject({ count: 0, disposed: [] });
});

test("sweep refuses without a provable roster and combines with no single-id flags", () => {
  const f = fix();
  // A scalar row passes the selector's format gate but proves nothing about absence.
  reg(f, { seats: { alpha: "broken" } });
  mail(f, "a-001", "ghost");
  const partial = run(f, ["cancel", "--dead-letters", "--dry-run"]);
  expect(partial.code).toBe(1);
  expect(partial.err + partial.out).toContain("no seat can be proven gone");
  reg(f, { seats: {} });
  const mixed = run(f, ["cancel", "--dead-letters", "a-001"]);
  expect(mixed.code).toBe(1);
  expect(existsSync(cancelled(f, "a-001"))).toBe(false);
});

test("a seat that registers after the scan keeps its mail (decision re-made under the registry lock)", async () => {
  const f = fix();
  reg(f, { seats: {} });
  mail(f, "r-001", "ghost");
  const barrier = join(f.root, "barrier");
  const proc = Bun.spawn([process.execPath, MAIN, "cancel", "--dead-letters", "--json"], {
    cwd: f.cwd, env: { ...f.env, TAP_DEAD_LETTER_TEST_BARRIER: barrier, TAP_DEAD_LETTER_TEST_ID: "r-001" }, stdout: "pipe", stderr: "pipe" });
  const deadline = Date.now() + 20000;
  while (!existsSync(`${barrier}.dead-letter-before-lock.reached`)) {
    if (Date.now() > deadline) throw new Error("barrier never reached");
    await Bun.sleep(10);
  }
  reg(f, { seats: { ghost: seat("ghost") } });
  writeFileSync(`${barrier}.dead-letter-before-lock.release`, "");
  expect(await proc.exited).toBe(0);
  // A benign skip is success in both representations: ok:true and exit 0.
  expect(JSON.parse(await new Response(proc.stdout).text())).toMatchObject({ ok: true, count: 1, disposed: [], skipped: [{ id: "r-001", reason: "recipient_not_gone" }], failed: [] });
  expect(existsSync(cancelled(f, "r-001"))).toBe(false);
});

test("a FIFO or symlink named like a payload is never a target, and discovery does not block", () => {
  const f = fix();
  reg(f, { seats: {} });
  mail(f, "a-001", "ghost");
  expect(Bun.spawnSync(["mkfifo", join(f.bus, "payloads", "p-002.md")]).exitCode).toBe(0);
  const outside = join(f.root, "s-003.md");
  writeFileSync(outside, `---\nid: s-003\nfrom: lead\nto: ghost\nkind: discuss\npath: ${outside}\n---\nbody\n`);
  symlinkSync(outside, join(f.bus, "payloads", "s-003.md"));
  const dry = Bun.spawnSync([process.execPath, MAIN, "cancel", "--dead-letters", "--dry-run", "--json"], { cwd: f.cwd, env: f.env, stdout: "pipe", stderr: "pipe", timeout: 15000 });
  expect(dry.exitCode, dry.stderr.toString()).toBe(0);
  expect((JSON.parse(dry.stdout.toString()) as { targets: { id: string }[] }).targets.map((t) => t.id)).toEqual(["a-001"]);
  const h = health(f);
  expect(h.report.dead_letters?.count).toBe(1);
  run(f, ["cancel", "--dead-letters"]);
  expect(existsSync(cancelled(f, "s-003"))).toBe(false);
  expect(existsSync(cancelled(f, "p-002"))).toBe(false);
});

test("a reset fence refuses the dry run exactly as it refuses the real sweep", () => {
  const f = fix();
  reg(f, { seats: {} });
  mail(f, "a-001", "ghost");
  writeFileSync(join(f.bus, "reset.fence.json"), "{}\n");
  for (const args of [["--dry-run", "--json"], ["--json"]]) {
    const r = run(f, ["cancel", "--dead-letters", ...args]);
    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain("team_reset_fenced");
  }
  expect(existsSync(cancelled(f, "a-001"))).toBe(false);
});

test("a registry whose embedded team name disagrees with its enrollment proves nothing", () => {
  const f = fix();
  writeFileSync(f.registry, `${JSON.stringify({ schema: "0.20", team: { name: "alpha" }, seats: {} }, null, 2)}\n`);
  mail(f, "m-001", "ghost", "to_team: alpha\n");
  const h = run(f, ["health", "--json"]);
  if (h.code !== 1) {
    const report = JSON.parse(h.out) as { unsettled: { id: string }[]; dead_letters?: unknown };
    expect(report.unsettled.map((u) => u.id)).toEqual(["m-001"]);
    expect(report.dead_letters).toBeUndefined();
  }
  run(f, ["cancel", "--dead-letters"]);
  expect(existsSync(cancelled(f, "m-001"))).toBe(false);
});

test("an unreadable payloads directory refuses the census instead of reporting zero", () => {
  const f = fix();
  reg(f, { seats: {} });
  mail(f, "a-001", "ghost");
  const payloads = join(f.bus, "payloads");
  chmodSync(payloads, 0o000);
  try {
    for (const args of [["--dry-run", "--json"], ["--json"]]) {
      const r = run(f, ["cancel", "--dead-letters", ...args]);
      expect(r.code).toBe(1);
      expect(r.out + r.err).toContain("payloads_unreadable");
    }
  } finally { chmodSync(payloads, 0o755); }
  expect(existsSync(cancelled(f, "a-001"))).toBe(false);
});

// tap-sr6da class 1: mail to another team is classified through that team's
// enrollment in the machine index, never by the handle's presence anywhere else.
type Row = { id: string; class: string; to_team?: string };
const dryRows = (f: Fix) => {
  const r = run(f, ["cancel", "--dead-letters", "--dry-run", "--json"]);
  expect(r.code, r.err).toBe(0);
  return JSON.parse(r.out) as { count: number; by_class: Record<string, number>; targets: Row[] };
};
const receipt = (f: Fix, id: string) => JSON.parse(readFileSync(cancelled(f, id), "utf8")) as Record<string, string>;

test("cross-team mail is dead when its team is not enrolled, historical, or its registry is absent at the resolved location", () => {
  const f = fix();
  reg(f, { seats: { alpha: seat("alpha") } });
  enroll(f, {
    hist: { root: join(f.root, "h"), registry_location: join(f.root, "h", "reg.json"), state: "historical" },
    vanished: { root: join(f.root, "v"), registry_location: join(f.root, "v", "team-registry.json") },
  });
  mail(f, "x-001", "alpha", "to_team: nevermore\n");
  mail(f, "x-002", "alpha", "to_team: hist\n");
  mail(f, "x-003", "alpha", "to_team: vanished\n");
  const h = health(f);
  expect(h.code, h.err).toBe(0);
  expect(h.report.unsettled).toEqual([]);
  expect(h.report.dead_letters?.count).toBe(3);
  const preview = dryRows(f);
  expect(preview.by_class).toEqual({ team_gone: 3 });
  expect(preview.targets.map((t) => [t.id, t.class, t.to_team])).toEqual([
    ["x-001", "team_gone", "nevermore"], ["x-002", "team_gone", "hist"], ["x-003", "team_gone", "vanished"]]);
  const human = run(f, ["cancel", "--dead-letters", "--dry-run"]);
  expect(human.out).toContain("by class: team_gone 3");
  expect(human.out).toContain("lead -> nevermore/alpha");

  const real = run(f, ["cancel", "--dead-letters", "--json"]);
  expect(real.code, real.err).toBe(0);
  expect(JSON.parse(real.out)).toMatchObject({ ok: true, disposed: ["x-001", "x-002", "x-003"], skipped: [] });
  expect(receipt(f, "x-001")).toMatchObject({ reason: "seat_unresolvable", target: "alpha", target_status: "gone", registry_checked: "machine_index (nevermore): not enrolled" });
  expect(receipt(f, "x-002").registry_checked).toBe("machine_index (hist): historical");
  expect(receipt(f, "x-003").registry_checked).toBe(`foreign_team_registry (vanished): absent at ${join(f.root, "v", "team-registry.json")}`);
  for (const id of ["x-001", "x-002", "x-003"]) expect(existsSync(join(f.bus, "payloads", `${id}.md`))).toBe(true);
});

test("cross-team mail is judged by the addressed team's own roster, never a same-named seat elsewhere", () => {
  const f = fix();
  // `alpha` lives HERE; team o has `beta` only.
  reg(f, { seats: { alpha: seat("alpha") } });
  enroll(f, { o: { root: join(f.root, "o"), registry_location: foreignRegistry(f, "o", { beta: seat("beta") }) } });
  mail(f, "c-001", "alpha", "to_team: o\n"); // absent from o: dead, whatever t holds
  mail(f, "c-002", "beta", "to_team: o\n");  // present in o: live
  mail(f, "c-003", "beta");                  // local, and beta is no seat of t: dead
  const preview = dryRows(f);
  expect(preview.targets.map((t) => [t.id, t.class])).toEqual([["c-001", "seat_gone"], ["c-003", "seat_gone"]]);
  const h = health(f);
  expect(h.report.unsettled.map((u) => u.id)).toEqual(["c-002"]);
  expect(run(f, ["cancel", "--dead-letters"]).code).toBe(0);
  expect(receipt(f, "c-001")).toMatchObject({ reason: "seat_unresolvable", registry_checked: "foreign_team_registry (o)" });
  expect(receipt(f, "c-003").registry_checked).toBe("bound_team_registry");
  expect(existsSync(cancelled(f, "c-002"))).toBe(false);
});

test("a team that re-enrolls between the scan and the receipt keeps its mail", async () => {
  const f = fix();
  reg(f, { seats: {} });
  mail(f, "r-001", "ghost", "to_team: o\n");
  const barrier = join(f.root, "barrier");
  const proc = Bun.spawn([process.execPath, MAIN, "cancel", "--dead-letters", "--json"], {
    cwd: f.cwd, env: { ...f.env, TAP_DEAD_LETTER_TEST_BARRIER: barrier, TAP_DEAD_LETTER_TEST_ID: "r-001" }, stdout: "pipe", stderr: "pipe" });
  await reached(barrier);
  enroll(f, { o: { root: join(f.root, "o"), registry_location: foreignRegistry(f, "o", { ghost: seat("ghost") }) } });
  writeFileSync(`${barrier}.dead-letter-before-lock.release`, "");
  expect(await proc.exited).toBe(0);
  expect(JSON.parse(await new Response(proc.stdout).text())).toMatchObject({ ok: true, disposed: [], skipped: [{ id: "r-001", reason: "recipient_not_gone" }] });
  expect(existsSync(cancelled(f, "r-001"))).toBe(false);
});

test("a team moved to a registry the sweep never locked is skipped, never judged unfenced", async () => {
  const f = fix();
  reg(f, { seats: {} });
  enroll(f, { o: { root: join(f.root, "o"), registry_location: foreignRegistry(f, "o", {}, "o1") } });
  mail(f, "m-001", "ghost", "to_team: o\n");
  const barrier = join(f.root, "barrier");
  const proc = Bun.spawn([process.execPath, MAIN, "cancel", "--dead-letters", "--json"], {
    cwd: f.cwd, env: { ...f.env, TAP_DEAD_LETTER_TEST_BARRIER: barrier, TAP_DEAD_LETTER_TEST_ID: "m-001" }, stdout: "pipe", stderr: "pipe" });
  await reached(barrier);
  // Same name, NEW location: the ghost is absent there too, but o2 was never locked.
  enroll(f, { o: { root: join(f.root, "o"), registry_location: foreignRegistry(f, "o", {}, "o2") } });
  writeFileSync(`${barrier}.dead-letter-before-lock.release`, "");
  expect(await proc.exited).toBe(0);
  expect(JSON.parse(await new Response(proc.stdout).text())).toMatchObject({ ok: true, disposed: [], skipped: [{ id: "m-001", reason: "registry_moved" }] });
  expect(existsSync(cancelled(f, "m-001"))).toBe(false);
});

test("a held index writer lock is never waited on: index_lock_busy, no receipt, exit 1", async () => {
  const f = fix();
  reg(f, { seats: {} });
  mail(f, "b-001", "ghost");
  const holder = Bun.spawn([process.execPath, "-e", `
    const { acquirePathLock } = await import(${JSON.stringify(join(import.meta.dir, "../src/panelock.ts"))});
    const lock = acquirePathLock(${JSON.stringify(join(f.root, "idx", "global-registry.json.lock"))}, 5000);
    if (!lock) process.exit(3);
    console.log("held");
    await Bun.sleep(60000);
  `], { env: f.env, stdout: "pipe", stderr: "pipe" });
  try {
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("held");
    const started = Date.now();
    const r = run(f, ["cancel", "--dead-letters", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, disposed: [], skipped: [{ id: "b-001", reason: "index_lock_busy" }] });
    expect(Date.now() - started).toBeLessThan(10000);
    expect(existsSync(cancelled(f, "b-001"))).toBe(false);
  } finally { holder.kill(); await holder.exited; }
});

// tap-sr6da class 2: only mail no successor can settle is a retired-instance dead letter.
test("an expected-reply message to a retired instance is dead; a settle-only note stays live for the successor", () => {
  const f = fix();
  reg(f, { seats: { alpha: seat("alpha", { instance: "alpha|2" }) } });
  mail(f, "i-001", "alpha", "recipient_instance: alpha|1\n");                      // ask, predecessor: dead
  const note = mail(f, "i-002", "alpha", "recipient_instance: alpha|1\n");
  writeFileSync(note, readFileSync(note, "utf8").replace("reply: expected", "reply: settle-only")); // note, predecessor: live
  mail(f, "i-003", "alpha", "recipient_instance: alpha|2\n");                      // current instance: live
  mail(f, "i-004", "alpha");                                                        // unstamped: live
  mail(f, "i-005", "alpha", "recipient_instance: alpha|1\nto_adopted_from: alpha\n"); // forwarded custody: live
  mail(f, "i-006", "alpha", "recipient_instance: alpha|1\n");                      // spool-resident: the courier's tier
  writeFileSync(join(f.bus, "spool", "i-006.meta.json"), '{"id":"i-006"}\n');
  const preview = dryRows(f);
  expect(preview.targets.map((t) => [t.id, t.class])).toEqual([["i-001", "instance_retired"]]);
  const h = health(f);
  expect(h.report.unsettled.map((u) => u.id)).toEqual(["i-002", "i-003", "i-004", "i-005", "i-006"]);
  expect(run(f, ["cancel", "--dead-letters"]).code).toBe(0);
  expect(receipt(f, "i-001")).toMatchObject({ reason: "instance_retired", target: "alpha", target_status: "replaced", registry_checked: "bound_team_registry" });
  for (const id of ["i-002", "i-003", "i-004", "i-005", "i-006"]) expect(existsSync(cancelled(f, id))).toBe(false);
  // The successor still settles the predecessor note itself.
  const read = run(f, ["read", "i-002", "--by", "alpha"]);
  expect(read.code, read.err + read.out).toBe(0);
  expect(JSON.parse(readFileSync(join(f.bus, "receipts", "i-002.done"), "utf8"))).toMatchObject({ reason: "instance_retired" });
});

test("a row or envelope without an instance proves no retirement", () => {
  const f = fix();
  reg(f, { seats: { alpha: seat("alpha", { instance: undefined }), beta: seat("beta") } });
  mail(f, "n-001", "alpha", "recipient_instance: alpha|1\n");
  mail(f, "n-002", "beta");
  expect(dryRows(f).count).toBe(0);
});

async function reached(barrier: string): Promise<void> {
  const deadline = Date.now() + 20000;
  while (!existsSync(`${barrier}.dead-letter-before-lock.reached`)) {
    if (Date.now() > deadline) throw new Error("barrier never reached");
    await Bun.sleep(10);
  }
}

// tap-bm4om: admin retire withdraws the retired team's inbound, fenced by the
// instance each row held when retire captured it under the registry lock.
test("admin retire withdraws only the retired team's inbound stamped for a captured instance", () => {
  const f = fix();
  reg(f, { seats: { alpha: seat("alpha", { instance: "alpha|1" }) } });
  const other = foreignRegistry(f, "o", { alpha: seat("alpha", { instance: "alpha|9" }) });
  enroll(f, { o: { root: join(f.root, "o"), registry_location: other } });
  mail(f, "a-001", "alpha", "recipient_instance: alpha|1\n");                       // withdrawn
  mail(f, "a-002", "alpha", "recipient_instance: alpha|0\n");                       // older instance: kept
  mail(f, "a-003", "alpha");                                                        // unstamped: kept
  mail(f, "a-004", "alpha", "to_team: o\nrecipient_instance: alpha|1\n");          // another team's alpha: kept
  mail(f, "a-005", "alpha", "cross_worktree: true\nrecipient_instance: alpha|1\n"); // manual relay: kept
  mail(f, "a-006", "alpha", "to_team: t\nrecipient_instance: alpha|1\n");          // explicitly this team: withdrawn
  const r = run(f, ["admin", "retire", "t", "--force", "--json"]);
  expect(r.code, r.err).toBe(0);
  expect(JSON.parse(r.out)).toMatchObject({ ok: true, team: "t", withdrawn_inbound: ["a-001", "a-006"] });
  expect(receipt(f, "a-001")).toMatchObject({ by: "tap admin retire", reason: "seat_unresolvable", target: "alpha", target_status: "gone",
    registry_checked: "machine_index (t): retired by tap admin retire", source: "payloads" });
  for (const id of ["a-002", "a-003", "a-004", "a-005"]) expect(existsSync(cancelled(f, id))).toBe(false);
  for (const id of ["a-001", "a-006"]) expect(existsSync(join(f.bus, "payloads", `${id}.md`))).toBe(true);
  // The other team is untouched and still enrolled.
  const index = JSON.parse(readFileSync(join(f.root, "idx", "global-registry.json"), "utf8")) as { teams: Record<string, unknown> };
  expect(Object.keys(index.teams)).toEqual(["o"]);
});

// Review round 1 (partner review): damaged authority and unsanctioned semantics prove nothing.
test("a foreign enrollment with a malformed root stays unknown, whatever its registry_location shows", () => {
  const f = fix();
  reg(f, { seats: {} });
  enroll(f, { o: { root: 17, registry_location: join(f.root, "o", "missing.json") }, q: { root: join(f.root, "q"), registry_location: 5 } });
  mail(f, "p-001", "alpha", "to_team: o\n");
  mail(f, "p-002", "alpha", "to_team: q\n");
  expect(dryRows(f).targets).toEqual([]);
});

test("an unsanctioned reply expectation is never a retired-instance dead letter", () => {
  const f = fix();
  reg(f, { seats: { alpha: seat("alpha", { instance: "alpha|2" }) } });
  const p = mail(f, "p-003", "alpha", "recipient_instance: alpha|1\n");
  writeFileSync(p, readFileSync(p, "utf8").replace("reply: expected", "reply: bogus"));
  expect(dryRows(f).targets).toEqual([]);
});

for (const [label, doc] of [
  ["names another team", { team: { name: "impostor" }, seats: { alpha: seat("alpha") } }],
  ["has a scalar row", { seats: { alpha: seat("alpha"), beta: "broken" } }],
  ["has invalid forwardings", { seats: { alpha: seat("alpha") }, seat_forwardings: [{ source: "x" }] }],
] as Array<[string, Record<string, unknown>]>) {
  test(`admin retire withdraws nothing when its registry ${label}`, () => {
    const f = fix();
    reg(f, doc);
    mail(f, "p-002", "alpha", "recipient_instance: alpha|1\n");
    const r = run(f, ["admin", "retire", "t", "--force", "--json"]);
    expect(existsSync(cancelled(f, "p-002")), r.out + r.err).toBe(false);
  });
}
