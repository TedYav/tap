import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeScratchTree } from "./support/scratch";
import { seatIsRelaunchable } from "../src/launcher/complete";
import { recordFromRow } from "../src/launcher/transaction";
import { readTeamHistory, parseRef } from "../src/team-history";
import { cmdRestore } from "../src/verbs/history-restore";

const MAIN = join(import.meta.dir, "../main.ts");
const owned: string[] = [];
afterEach(() => { for (const path of owned.splice(0)) removeScratchTree(path); });

function fixture(seats: Record<string, unknown> = {}) {
  const base = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "tap-team-history.")));
  owned.push(base);
  const root = join(base, "team"), bus = join(root, ".tap", "bus"), index = join(base, "index");
  const registry = join(root, ".tap", "team-registry.json"), hist = join(root, ".tap", "team-history");
  mkdirSync(bus, { recursive: true });
  mkdirSync(hist, { recursive: true });
  mkdirSync(index);
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    t: { root, registry_location: registry, state: "registered" },
  } }));
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "t", worktree_root: root }, seats }, null, 2));
  const env: NodeJS.ProcessEnv = { ...process.env, TAP_HOME: bus, TAP_INDEX_HOME: index, TAP_LOCK_DIR: join(base, "locks"),
    TAP_SPOOL_DISABLE_DELIVERER: "1", TAP_SCRATCH_ONLY: base, TAP_TMUX_SOCKET: `team-history-${process.pid}` };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.TAP_SELF;
  const run = (...argv: string[]) => {
    const result = Bun.spawnSync([process.execPath, MAIN, ...argv], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  };
  const doc = () => JSON.parse(readFileSync(registry, "utf8")) as { seats: Record<string, Record<string, unknown>> };
  let n = 0;
  const tomb = (handle: string, retiredAt: string, row: Record<string, unknown>, instance = `${handle}|${++n}`) => {
    const name = `${handle}.out-${String(++n).padStart(4, "0")}.${retiredAt.replace(/[-:]/g, "")}.json`;
    writeFileSync(join(hist, name), JSON.stringify({ handle, instance, retired_by: "out-x", retired_at: retiredAt, row: { instance, ...row } }));
    return name;
  };
  return { base, root, bus, index, registry, hist, env, run, doc, tomb };
}

const fullRow = (id: string, extra: Record<string, unknown> = {}) => ({
  harness: "claude", harness_session_id: id, session: "t/opus", delivery: "pane", status: "active",
  registered_at: "2026-10-01T10:00:00Z", launch_tuning: { model: "opus" }, ...extra,
});

// ---- history ----------------------------------------------------------------

test("history indexes departures oldest first and a new retirement never moves an existing index", () => {
  const f = fixture({ sol: { harness: "codex", status: "active", registered_at: "2026-11-01T00:00:00Z", instance: "sol|1" } });
  f.tomb("opus", "2026-10-02T10:00:00Z", fullRow("aaaa1111-2222"));
  f.tomb("opus", "2026-10-05T10:00:00Z", fullRow("bbbb3333-4444"));
  const before = JSON.parse(f.run("team", "history", "--json").out);
  const ref = (body: { entries: Array<Record<string, unknown>> }, id: string) => body.entries.find(e => e.harness_session_id === id)?.ref;
  expect(ref(before, "aaaa1111-2222")).toBe("opus@1");
  expect(ref(before, "bbbb3333-4444")).toBe("opus@2");
  f.tomb("opus", "2026-10-09T10:00:00Z", fullRow("cccc5555-6666"));
  const after = JSON.parse(f.run("team", "history", "--json").out);
  expect(ref(after, "aaaa1111-2222")).toBe("opus@1");
  expect(ref(after, "bbbb3333-4444")).toBe("opus@2");
  expect(ref(after, "cccc5555-6666")).toBe("opus@3");
  // Current seats first and marked on team, then newest departure first.
  expect(after.entries.map((e: Record<string, unknown>) => e.ref)).toEqual(["sol", "opus@3", "opus@2", "opus@1"]);
  expect(after.entries[0].on_team).toBe(true);
  expect(Object.keys(after.entries[1]).sort()).toEqual(["handle", "harness", "harness_session_id", "index", "instance", "model", "on_team", "ref",
    "restored", "resumable", "retired_at", "session_created", "session_length_seconds", "tombstone"]);
  expect(after.entries[1]).toMatchObject({ index: 3, on_team: false, model: "opus", resumable: true, session_created: "2026-10-01T10:00:00Z" });
  expect(after.entries[1].session_length_seconds).toBe(8 * 86400);
  expect(after).toMatchObject({ ok: true, team: "t", hidden: 0, unreadable: 0 });
});

test("thin old tombstones render with dashes, corrupt ones are skipped and counted once on stderr", () => {
  const f = fixture();
  writeFileSync(join(f.hist, "old.out-1.20260801T000000Z.json"), JSON.stringify({ handle: "old", row: { harness: "claude", registered_at: "2026-08-01T00:00:00Z", status: "active" } }));
  writeFileSync(join(f.hist, "bad.out-2.20260802T000000Z.json"), "{not json");
  writeFileSync(join(f.hist, "old.lineage.jsonl"), "garbage\n");
  const human = f.run("team", "history");
  expect(human.code).toBe(0);
  expect(human.err).toBe(`tap team history: skipped 1 unreadable tombstone(s) under ${f.hist}\n`);
  const line = human.out.split("\n").find(l => l.startsWith("old@1"))!;
  expect(line).toContain("claude");
  expect(line).toMatch(/old@1\s+claude\s+-\s+2026-08-01 00:00\s+-\s+-\s+-\s+no/);
  const json = JSON.parse(f.run("team", "history", "--json").out);
  expect(json.entries[0]).toMatchObject({ ref: "old@1", retired_at: null, session_length_seconds: null, harness_session_id: null, resumable: false });
  expect(json.unreadable).toBe(1);
});

test("lineage gives the session start and the default limit hides older departures with a count", () => {
  const f = fixture();
  for (let i = 0; i < 52; i++) f.tomb("w", `2026-10-${String(1 + (i % 28)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:${String(i % 60).padStart(2, "0")}Z`, fullRow(`id-${i}`));
  const history = readTeamHistory(f.root, {});
  const inst = history.entries[0]!.instance;
  writeFileSync(join(f.hist, "w.lineage.jsonl"), `${JSON.stringify({ instance: inst, ts: "2026-09-30T00:00:00.123000Z" })}\n`);
  expect(readTeamHistory(f.root, {}).entries[0]!.created).toBe("2026-09-30T00:00:00Z");
  const human = f.run("team", "history");
  expect(human.out).toContain("2 older departure(s) hidden; tap team history --all shows everything");
  expect(f.run("team", "history", "--all").out).not.toContain("hidden");
  expect(parseRef("opus@2")).toEqual({ handle: "opus", index: 2 });
  expect(parseRef("op@us@x")).toBeNull();
});

// ---- restore ----------------------------------------------------------------

test("restore by index re-adds a suspended row resume accepts, keeps the native id and keeps the tombstone", () => {
  const f = fixture();
  const name = f.tomb("opus", "2026-10-02T10:00:00Z", fullRow("aaaa1111-2222"));
  f.tomb("opus", "2026-10-05T10:00:00Z", fullRow("bbbb3333-4444"));
  const result = f.run("restore", "opus@1", "--json");
  expect(result.code, result.out + result.err).toBe(0);
  expect(JSON.parse(result.out)).toMatchObject({ ok: true, handle: "opus", from: "opus@1", harness_session_id: "aaaa1111-2222", next: "tap session resume opus" });
  const row = f.doc().seats.opus!;
  expect(row).toMatchObject({ status: "suspended", status_reason: "restored_from_archive", harness_session_id: "aaaa1111-2222", delivery: "pane" });
  expect(seatIsRelaunchable(row)).toBe(true);
  expect(seatIsRelaunchable(row, true)).toBe(true);
  expect(recordFromRow("opus", row, { name: "t", worktree_root: f.root }, f.root)).toMatchObject({ name: "t/opus", harness_session_id: "aaaa1111-2222" });
  expect(existsSync(join(f.hist, name))).toBe(true);
  const history = JSON.parse(f.run("team", "history", "opus", "--json").out);
  expect(history.entries.find((e: Record<string, unknown>) => e.ref === "opus@1").restored).toEqual([expect.objectContaining({ restored_as: "opus" })]);
  // The human receipt names the next step.
  const g = fixture();
  g.tomb("opus", "2026-10-02T10:00:00Z", fullRow("x-1"));
  expect(g.run("restore", "opus").out).toContain("tap restore: next: tap session resume opus\n");
});

test("a live handle refuses handle_live with a ready --as; --as restores under a new seat with the same conversation", () => {
  const f = fixture({ opus: { harness: "codex", status: "active", instance: "opus|live" } });
  f.tomb("opus", "2026-10-02T10:00:00Z", fullRow("aaaa1111-2222"));
  const refused = f.run("restore", "opus@1", "--json");
  expect(refused.code).toBe(1);
  expect(JSON.parse(refused.out)).toMatchObject({ ok: false, error_class: "handle_live", action: "tap restore opus@1 --as opus-2" });
  expect(f.run("restore", "opus@1", "--as", "bad@name").code).toBe(1);
  const as = f.run("restore", "opus@1", "--as", "opus-2", "--json");
  expect(as.code, as.out + as.err).toBe(0);
  const row = f.doc().seats["opus-2"]!;
  expect(row).toMatchObject({ session: "t/opus-2", harness_session_id: "aaaa1111-2222", status: "suspended" });
  expect(String(row.instance)).toStartWith("opus-2|");
  expect(f.doc().seats.opus).toEqual({ harness: "codex", status: "active", instance: "opus|live" });
});

test("a native id another seat on the team owns refuses session_owned and changes nothing", () => {
  const f = fixture({ other: { harness: "claude", harness_session_id: "aaaa1111-2222", status: "active" } });
  f.tomb("opus", "2026-10-02T10:00:00Z", fullRow("aaaa1111-2222"));
  const before = readFileSync(f.registry, "utf8");
  const refused = f.run("restore", "opus@1", "--json");
  expect(JSON.parse(refused.out)).toMatchObject({ ok: false, error_class: "session_owned", action: "tap session resume other" });
  expect(readFileSync(f.registry, "utf8")).toBe(before);
});

test("bare handle: several entries refuse without a terminal listing refs; no history keeps the teardown-archive default", () => {
  const f = fixture();
  f.tomb("opus", "2026-10-02T10:00:00Z", fullRow("a-1"));
  f.tomb("opus", "2026-10-05T10:00:00Z", fullRow("b-2"));
  const refused = f.run("restore", "opus", "--json");
  expect(JSON.parse(refused.out)).toMatchObject({ ok: false, error_class: "ambiguous_history", action: "tap restore opus@2" });
  expect(JSON.parse(refused.out).detail).toContain("opus@1 opus@2");
  expect(JSON.parse(f.run("restore", "ghost", "--json").out)).toMatchObject({ error_class: "archive_not_found" });
  expect(JSON.parse(f.run("restore", "ghost", "--archive", "nope", "--json").out)).toMatchObject({ error_class: "archive_not_found" });
  expect(JSON.parse(f.run("restore", "opus@9", "--json").out)).toMatchObject({ error_class: "history_not_found" });
  expect(JSON.parse(f.run("restore", "--json").out)).toMatchObject({ error_class: "usage_error" });
  const thin = fixture();
  writeFileSync(join(thin.hist, "old.out-1.20260801T000000Z.json"), JSON.stringify({ handle: "old", retired_at: "2026-08-01T00:00:00Z", row: { harness: "claude" } }));
  expect(JSON.parse(thin.run("restore", "old@1", "--json").out)).toMatchObject({ error_class: "not_resumable" });
});

test("on a terminal, a bare handle with several entries opens the picker and restores the pick", async () => {
  const f = fixture();
  f.tomb("opus", "2026-10-02T10:00:00Z", fullRow("a-1"));
  f.tomb("opus", "2026-10-05T10:00:00Z", fullRow("b-2"));
  const saved = { ...process.env }, cwd = process.cwd();
  let offered = "";
  try {
    for (const key of ["TAP_HOME", "TAP_INDEX_HOME", "TAP_LOCK_DIR", "TAP_SCRATCH_ONLY"]) process.env[key] = f.env[key];
    delete process.env.TAP_JSON;
    process.env.TERM = "xterm-256color";
    process.chdir(f.root);
    const code = await cmdRestore(["opus"], { terminal: () => true, fzf: {
      terminal: () => true, binary: () => "fzf",
      run: async (_bin, _args, input) => { offered = input; return { code: 0, output: "\0opus@1\0" }; },
    } });
    expect(code).toBe(0);
  } finally {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  expect(offered).toContain("opus@1\t");
  expect(offered).toContain("opus@2\t");
  expect(f.doc().seats.opus!.harness_session_id).toBe("a-1");
});

// ---- review round -----------------------------------------------------

test("a native id another enrolled team owns refuses session_owned: uniqueness is machine-wide", () => {
  const f = fixture();
  f.tomb("opus", "2026-10-02T10:00:00Z", fullRow("shared-1"));
  const otherRoot = join(f.base, "other"), otherRegistry = join(otherRoot, ".tap", "team-registry.json");
  mkdirSync(join(otherRoot, ".tap"), { recursive: true });
  writeFileSync(otherRegistry, JSON.stringify({ schema: "0.20", team: { name: "u", worktree_root: otherRoot },
    seats: { keeper: { harness: "claude", harness_session_id: "shared-1", session: "u/keeper", status: "active" } } }));
  const index = JSON.parse(readFileSync(join(f.index, "global-registry.json"), "utf8"));
  index.teams.u = { root: otherRoot, registry_location: otherRegistry, state: "registered" };
  writeFileSync(join(f.index, "global-registry.json"), JSON.stringify(index));
  const before = readFileSync(f.registry, "utf8");
  const refused = JSON.parse(f.run("restore", "opus@1", "--json").out);
  expect(refused).toMatchObject({ ok: false, error_class: "session_owned", action: "tap team roster u" });
  expect(refused.detail).toContain("already belongs to seat u/keeper");
  expect(readFileSync(f.registry, "utf8")).toBe(before);
});

test("same-second departures keep write order by birth time, and a restore record names its tombstone file", () => {
  const f = fixture();
  // Same retired_at second; the later departure's random suffix sorts first by name.
  const first = "opus.out-ffff.20261002T100000Z.json", second = "opus.out-0000.20261002T100000Z.json";
  const write = (name: string, id: string) => writeFileSync(join(f.hist, name),
    JSON.stringify({ handle: "opus", instance: `opus|${id}`, retired_by: "out-x", retired_at: "2026-10-02T10:00:00Z", row: { instance: `opus|${id}`, ...fullRow(id) } }));
  write(first, "first");
  Bun.sleepSync(30);
  write(second, "second");
  const births = [statSync(join(f.hist, first)).birthtimeMs, statSync(join(f.hist, second)).birthtimeMs];
  expect(births[0]! < births[1]!, `this filesystem must record birth time (${births})`).toBe(true);
  const entries = readTeamHistory(f.root, {}).entries;
  expect(entries.find(e => e.index === 1)!.tombstone).toBe(first);
  expect(entries.find(e => e.index === 2)!.tombstone).toBe(second);
  expect(f.run("restore", "opus@2", "--json").code).toBe(0);
  const record = JSON.parse(readFileSync(join(f.hist, "opus.restores.jsonl"), "utf8").trim());
  expect(record).toMatchObject({ handle: "opus", tombstone: second, restored_as: "opus" });
  expect(record).not.toHaveProperty("index");
});

test("--as uses registration's reserved identities: courier, watcher, help and user refuse", () => {
  const f = fixture();
  f.tomb("opus", "2026-10-02T10:00:00Z", fullRow("a-1"));
  for (const name of ["courier", "watcher", "help", "user"]) {
    const refused = f.run("restore", "opus@1", "--as", name, "--json");
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.out)).toMatchObject({ ok: false, error_class: "reserved_handle" });
  }
  expect(f.doc().seats).toEqual({});
});
