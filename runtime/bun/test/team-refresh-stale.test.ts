// `tap team refresh --stale` — the simple design (project decision, 2026-11-03): one
// observation, a color-coded list (offline by default; idle-but-running with
// --include-idle), the operator's confirmation, then plain `tap out` /
// `tap out --kill` for each seat.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { physicalSocketPath } from "../src/tmux";
import { removeScratchTree } from "./support/scratch";
import {
  canonicalPath, classifyTeam, newestDatedRecord, offlineActivity, parseStaleOptions, productionRetire, renderListing, retireArgv, runStale, transcriptActivity,
  type StaleEffects, type StaleSeat, type StaleTeam, type TeamView,
} from "../src/team/stale";
import type { FanoutRow } from "../src/verbs/nudge-fanout";
import { TapError } from "../src/context";

const MAIN = join(import.meta.dir, "../main.ts");
const SCRIPTS = join(import.meta.dir, "../../../skills/tap/scripts");
const owned: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const path of owned.splice(0)) removeScratchTree(path);
});

const NOW = Date.UTC(2026, 10, 3) / 1000;
const DAY = 86400, CUT = 7 * DAY;
const iso = (s: number) => new Date(s * 1000).toISOString();
const noTranscript = () => null;

function seen(handle: string, over: Partial<FanoutRow> = {}): FanoutRow {
  return { handle, session: `t/${handle}`, harness: "claude", pane: "", observedPaneId: "", observedServerEpoch: "", delivery: "pane",
    status: "suspended", statusReason: "stored_status", attached: "0", unattended: false, crew: false, preset: "", model: "opus",
    agentState: "unknown", agentStateReason: "", instance: `${handle}|1`, ...over } as FanoutRow;
}
const idle = (handle: string, endedAgo: number, stored: Record<string, unknown> = {}) =>
  ({ handle, stored: { harness: "claude", status: "active", instance: `${handle}|1`, session: `t/${handle}`, ...stored },
    observed: seen(handle, { status: "active", statusReason: "", agentState: "idle", turnEndedAt: NOW - endedAgo }) });
const offline = (handle: string, launchedAgo: number | null, stored: Record<string, unknown> = {}, obs: Partial<FanoutRow> = {}) =>
  ({ handle, stored: { harness: "claude", status: "suspended", instance: `${handle}|1`, session: `t/${handle}`, ...(launchedAgo === null ? {} : { last_launched: iso(NOW - launchedAgo) }), ...stored },
    observed: seen(handle, obs) });
const LOCAL_SOCKET = "/nonexistent/tmux-0/local";
function view(team: string, seats: Array<{ handle: string; stored: Record<string, unknown>; observed?: FanoutRow }>, live: string[] | null = []): TeamView {
  return { team, root: `/nonexistent/${team}`, stored: Object.fromEntries(seats.map(s => [s.handle, s.stored])),
    observed: new Map(seats.filter(s => s.observed).map(s => [s.handle, s.observed!])), liveSessions: live === null ? null : new Set(live),
    callerSocket: LOCAL_SOCKET };
}

// ---- selection ----------------------------------------------------------------

test("groups: idle longest-idle first, offline oldest first; both boundaries are inclusive at the cutoff", () => {
  const l = classifyTeam(view("t", [
    idle("i9", 9 * DAY), idle("i12", 12 * DAY), idle("iAt", CUT), idle("iShort", CUT - 1),
    offline("o10", 10 * DAY), offline("o20", 20 * DAY), offline("oAt", CUT), offline("oShort", CUT - 1),
  ]), NOW, CUT, "", noTranscript);
  expect(l.idle.map(s => s.handle)).toEqual(["i12", "i9", "iAt"]);
  expect(l.offline.map(s => s.handle)).toEqual(["o20", "o10", "oAt"]);
  expect(l.idle[0]).toMatchObject({ group: "idle", ageSeconds: 12 * DAY, source: "turn end", model: "opus" });
  expect(l.unobserved).toBe(0);
});

test("exclusions: own seat, crew rows, poll and daemon seats are left out; the leader is tagged; crew owners show a count", () => {
  const l = classifyTeam(view("t", [
    offline("me", 30 * DAY, { pane_id: "%7" }),
    offline("helper", 30 * DAY, { crew: true, crew_owner: "boss", crew_owner_instance: "boss|1" }, { crew: true }),
    offline("poller", 30 * DAY, { delivery: "poll" }),
    offline("daemon1", 30 * DAY, { harness: "daemon" }),
    offline("lead", 30 * DAY, { role: "leader" }),
    offline("boss", 30 * DAY),
  ]), NOW, CUT, "%7", noTranscript);
  expect(l.offline.map(s => s.handle).sort()).toEqual(["boss", "lead"]);
  expect(l.offline.find(s => s.handle === "lead")!.leader).toBe(true);
  expect(l.offline.find(s => s.handle === "boss")!.crews).toBe(1);
  expect(l.unobserved).toBe(0);
});

test("seats that cannot be observed or dated are counted, not listed", () => {
  const l = classifyTeam(view("t", [
    offline("unknown", 30 * DAY, {}, { status: "unknown" }),
    { handle: "missing", stored: { harness: "claude", status: "active", last_launched: iso(NOW - 30 * DAY) } },
    offline("foreign", 30 * DAY, {}, { status: "offline", statusReason: "foreign_namespace", foreignNamespace: true }),
    { ...idle("undated", 30 * DAY), observed: seen("undated", { status: "active", agentState: "idle", turnEndedAt: null }) },
    offline("nodate", null),
    { ...idle("working", 30 * DAY), observed: seen("working", { status: "active", agentState: "working" }) },
  ]), NOW, CUT, "", noTranscript);
  expect(l.idle).toEqual([]);
  expect(l.offline).toEqual([]);
  expect(l.unobserved).toBe(5);
});

test("offline age is last real activity: a stop or registration never makes a seat look fresh", () => {
  const transcriptAt = (ago: number) => () => NOW - ago;
  // Stopped a minute ago, transcript ended 8 days ago: listed at 8 days.
  const stoppedNow = offline("a", null, { exited_at: iso(NOW - 60), registered_at: iso(NOW - 60) });
  const l = classifyTeam(view("t", [stoppedNow]), NOW, CUT, "", transcriptAt(8 * DAY));
  expect(l.offline).toEqual([expect.objectContaining({ handle: "a", ageSeconds: 8 * DAY, source: "transcript" })]);
  // A fresh transcript wins over an old stop: not stale.
  const freshTalk = offline("b", null, { exited_at: iso(NOW - 8 * DAY) });
  expect(classifyTeam(view("t", [freshTalk]), NOW, CUT, "", transcriptAt(DAY)).offline).toEqual([]);
  // Fallback order: the later of transcript and last_launched; then exited_at; then registered_at.
  expect(offlineActivity({ last_launched: iso(NOW - 9 * DAY) }, transcriptAt(12 * DAY))).toEqual({ at: NOW - 9 * DAY, source: "launched" });
  expect(offlineActivity({ last_launched: iso(NOW - 9 * DAY), exited_at: iso(NOW - 60) }, noTranscript)).toEqual({ at: NOW - 9 * DAY, source: "launched" });
  expect(offlineActivity({ exited_at: iso(NOW - 9 * DAY), registered_at: iso(NOW - 20 * DAY), last_seen: iso(NOW - 60) }, noTranscript))
    .toEqual({ at: NOW - 9 * DAY, source: "exited" });
  expect(offlineActivity({ registered_at: iso(NOW - 20 * DAY) }, noTranscript)).toEqual({ at: NOW - 20 * DAY, source: "registered" });
  expect(offlineActivity({ last_seen: iso(NOW - 30 * DAY) }, noTranscript)).toBeNull();
});

test("transcript age is the newest dated record of any type: a copied or undated transcript is not fresh", () => {
  // Records from 9 and 8 days ago, in a file written (mtime) just now.
  const lines = [JSON.stringify({ type: "user", timestamp: iso(NOW - 9 * DAY) }), JSON.stringify({ type: "summary", timestamp: iso(NOW - 8 * DAY) }), "not json", ""];
  expect(newestDatedRecord(lines)).toBe(NOW - 8 * DAY);
  expect(newestDatedRecord([JSON.stringify({ type: "user" }), JSON.stringify({ type: "assistant", message: {} })])).toBeNull();
  const base = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "tap-stale-transcript.")));
  owned.push(base);
  const copied = join(base, "copied.jsonl"), undated = join(base, "undated.jsonl");
  writeFileSync(copied, [JSON.stringify({ type: "user", sessionId: "sid-1", timestamp: iso(NOW - 9 * DAY) }),
    JSON.stringify({ type: "assistant", sessionId: "sid-1", timestamp: iso(NOW - 8 * DAY) })].join("\n") + "\n");
  writeFileSync(undated, [JSON.stringify({ type: "user", sessionId: "sid-2" }), JSON.stringify({ type: "assistant", sessionId: "sid-2" })].join("\n") + "\n");
  const row = (path: string, id: string, extra: Record<string, unknown> = {}) => ({ harness: "claude", transcript_path: path, harness_session_id: id, ...extra });
  expect(transcriptActivity(row(copied, "sid-1"))).toBe(NOW - 8 * DAY);
  expect(transcriptActivity(row(undated, "sid-2"))).toBeNull();
  // No dated record falls back to last_launched, then exited_at; nothing dated is not listed.
  expect(offlineActivity(row(undated, "sid-2", { last_launched: iso(NOW - 10 * DAY) }), transcriptActivity)).toEqual({ at: NOW - 10 * DAY, source: "launched" });
  expect(offlineActivity(row(undated, "sid-2", { exited_at: iso(NOW - 11 * DAY) }), transcriptActivity)).toEqual({ at: NOW - 11 * DAY, source: "exited" });
  const l = classifyTeam(view("t", [offline("blank", null, { transcript_path: undated, harness_session_id: "sid-2" })]), NOW, CUT, "", transcriptActivity);
  expect(l.offline).toEqual([]);
  expect(l.unobserved).toBe(1);
  // A tail of only dated system/progress records from today, last_launched 30 days ago: active today, not stale.
  const today = Date.now() / 1000, systemOnly = join(base, "system-only.jsonl");
  writeFileSync(systemOnly, [JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: iso(today - 3600) }),
    JSON.stringify({ type: "progress", timestamp: iso(today - 60) })].join("\n") + "\n");
  const busy = row(systemOnly, "sid-3", { last_launched: iso(today - 30 * DAY) });
  expect(transcriptActivity(busy)).toBe(Math.floor(today - 60));
  expect(offlineActivity(busy, transcriptActivity)).toEqual({ at: Math.floor(today - 60), source: "transcript" });
  expect(classifyTeam(view("t", [offline("busy", null, busy)]), today, CUT, "", transcriptActivity).offline).toEqual([]);
});

test("a stored-offline seat whose session still runs is in neither group: counted, with a note; no listing means unobserved", () => {
  const restored = offline("back", 30 * DAY, { status_reason: "restored_from_archive" });
  const l = classifyTeam(view("t", [restored, offline("gone", 30 * DAY)], ["t/back"]), NOW, CUT, "", noTranscript);
  expect(l.offline.map(s => s.handle)).toEqual(["gone"]);
  expect(l.idle).toEqual([]);
  expect(l).toMatchObject({ unobserved: 1, stillRunning: 1 });
  expect(renderListing(l, { includeIdle: true, cutoff: "7d", showTeam: false, style: false }))
    .toContain("1 seat(s) could not be observed or dated; not listed\n1 of them restored while still running; check them with tap team\n");
  expect(classifyTeam(view("t", [restored], null), NOW, CUT, "", noTranscript)).toEqual({ idle: [], offline: [], unobserved: 1, stillRunning: 0 });
  // Only the roster's own `idle` classification puts a live seat in the idle group.
  const live = classifyTeam(view("t", [idle("calm", 9 * DAY)], ["t/calm"]), NOW, CUT, "", noTranscript);
  expect(live.idle.map(s => s.handle)).toEqual(["calm"]);
  const team = { team: "t", root: "/r", registryLocation: "" };
  expect(retireArgv(team, live.idle[0]!)).toEqual(["out", "calm", "--team", "t", "--kill", "--json"]);
  expect(retireArgv(team, l.offline[0]!)).toEqual(["out", "gone", "--team", "t", "--json"]);
});

// ---- rendering ----------------------------------------------------------------

const seat = (handle: string, group: "idle" | "offline", over: Partial<StaleSeat> = {}): StaleSeat =>
  ({ team: "t", handle, harness: "claude", model: "opus", group, ageSeconds: 9 * DAY, source: group === "idle" ? "turn end" : "transcript",
    crews: 0, leader: false, ...over });

test("a seat recorded on another tmux socket is foreign even when the roster could not name the caller's socket", () => {
  // No local server: the roster passed an empty caller socket, so `foreignNamespace` stayed false and the stored status came back.
  const away = offline("away", 30 * DAY, { server_socket: "/nonexistent/tmux-0/elsewhere", server_epoch: "srv:1" });
  const here = offline("here", 30 * DAY, { server_socket: LOCAL_SOCKET });
  const l = classifyTeam(view("t", [away, here, offline("legacy", 30 * DAY)]), NOW, CUT, "", noTranscript);
  expect(l.offline.map(s => s.handle)).toEqual(["here", "legacy"]);
  expect(l).toMatchObject({ idle: [], unobserved: 1, stillRunning: 0 });
});

test("socket paths compare through the nearest existing ancestor's realpath: a local seat recorded canonically still matches", () => {
  // macOS shape: /tmp links to /private/tmp. The caller's tmux-<uid> directory is gone, so its path stays lexical
  // (/tmp/...), while an old row recorded the canonical one (/private/tmp/...).
  const base = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "tap-stale-socket.")));
  owned.push(base);
  const real = join(base, "private-tmp"), link = join(base, "tmp");
  mkdirSync(real);
  symlinkSync(real, link);
  const caller = join(link, "tmux-501", "default");
  expect(canonicalPath(caller)).toBe(join(real, "tmux-501", "default"));
  expect(canonicalPath(join(real, "tmux-501", "default"))).toBe(join(real, "tmux-501", "default"));
  const local = offline("local", 30 * DAY, { server_socket: join(real, "tmux-501", "default") });
  const away = offline("away", 30 * DAY, { server_socket: join(real, "tmux-501", "elsewhere") });
  const l = classifyTeam({ ...view("t", [local, away]), callerSocket: caller }, NOW, CUT, "", noTranscript);
  expect(l.offline.map(s => s.handle)).toEqual(["local"]);
  expect(l.unobserved).toBe(1);
});

test("a socket path with a .. segment is not comparable: the row is foreign, never listed", () => {
  // resolve() collapses .. before symlinks: a/link/../default really names b/default, not a/default.
  const base = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "tap-stale-dotdot.")));
  owned.push(base);
  mkdirSync(join(base, "a"));
  mkdirSync(join(base, "b", "child"), { recursive: true });
  symlinkSync(join(base, "b", "child"), join(base, "a", "link"));
  const caller = join(base, "a", "default");
  const sneaky = offline("sneaky", 30 * DAY, { server_socket: `${base}/a/link/../default` });
  const plain = offline("plain", 30 * DAY, { server_socket: caller });
  const l = classifyTeam({ ...view("t", [sneaky, plain]), callerSocket: caller }, NOW, CUT, "", noTranscript);
  expect(l.offline.map(s => s.handle)).toEqual(["plain"]);
  expect(l.unobserved).toBe(1);
  // A caller path with a .. segment compares with nothing.
  const dotted = classifyTeam({ ...view("t", [plain]), callerSocket: `${base}/a/link/../default` }, NOW, CUT, "", noTranscript);
  expect(dotted).toMatchObject({ offline: [], unobserved: 1 });
});

test("the list has a heading and count per group, ages with their source, and colors only when styled", () => {
  const listing = { idle: [seat("sol", "idle", { crews: 2 })], offline: [seat("opus-2", "offline", { leader: true })], unobserved: 3, stillRunning: 0 };
  const plain = renderListing(listing, { includeIdle: true, cutoff: "7d", showTeam: false, style: false });
  expect(plain).not.toContain("\x1b");
  expect(plain).toContain("Idle, still running (1)");
  expect(plain).toContain("Offline (1)");
  expect(plain.indexOf("Idle, still running")).toBeLessThan(plain.indexOf("Offline"));
  expect(plain).toMatch(/sol\s+claude\s+opus\s+idle 9d00h \(turn end\)\s+2 crews/);
  expect(plain).toMatch(/opus-2 \[leader\]\s+claude\s+opus\s+offline 9d00h \(transcript\)/);
  expect(plain).toContain("3 seat(s) could not be observed or dated; not listed");
  const styled = renderListing(listing, { includeIdle: true, cutoff: "7d", showTeam: false, style: true });
  expect(styled).toContain("\x1b[38;5;208m  sol");
  expect(styled).toContain("\x1b[90m  opus-2");
  expect(renderListing(listing, { includeIdle: false, cutoff: "7d", showTeam: false, style: false })).not.toContain("Idle, still running");
});

// ---- the pass -----------------------------------------------------------------

function effects(over: Partial<StaleEffects> & { views?: Record<string, TeamView> } = {}) {
  const views = over.views ?? { t: view("t", [idle("sol", 9 * DAY), offline("ghost", 10 * DAY)]) };
  const retired: string[] = [], out: string[] = [], asked: string[] = [];
  const fx: StaleEffects = {
    teams: scope => (scope === "*" ? Object.keys(views) : ["t"]).map(team => ({ team, root: `/nonexistent/${team}`, registryLocation: "" })),
    callerTeam: () => "t",
    view: (team: StaleTeam) => views[team.team]!,
    transcript: noTranscript,
    retire: (_t, s) => { retired.push(`${s.team}/${s.handle}:${s.group}`); return { ok: true, detail: "" }; },
    restoreIndex: () => 3, selfPane: () => "", now: () => NOW, interactive: () => true,
    ask: async q => { asked.push(q); return "y"; }, style: () => false,
    out: t => { out.push(t); }, err: t => { out.push(t); }, ...over,
  };
  return { fx, retired, out, asked };
}

test("default scope is the offline group: idle seats are neither listed nor retired, and the prompt is retire/cancel", async () => {
  const e = effects();
  expect(await runStale(parseStaleOptions(["--stale"]), e.fx)).toBe(0);
  expect(e.asked).toEqual(["Retire the offline seats? [y] retire / [N] cancel "]);
  expect(e.retired).toEqual(["t/ghost:offline"]);
  expect(e.out.join("")).not.toContain("Idle, still running");
  expect(e.out.join("")).toContain("ghost: retired; restore: tap restore ghost@3");
});

test("--include-idle: y retires both groups, o only the offline group, anything else cancels", async () => {
  for (const [answer, expected] of [["y", ["t/sol:idle", "t/ghost:offline"]], ["o", ["t/ghost:offline"]], ["", []], ["n", []]] as const) {
    const e = effects({ ask: async q => { expect(q).toBe("Stop and retire both groups? [y] both / [o] offline only / [N] cancel "); return answer; } });
    expect(await runStale(parseStaleOptions(["--stale", "--include-idle"]), e.fx)).toBe(0);
    expect(e.retired).toEqual([...expected]);
    if (!expected.length) expect(e.out.join("")).toContain("cancelled; nothing changed");
  }
  const offlineOnly = effects({ ask: async () => "o" });
  expect(await runStale(parseStaleOptions(["--stale"]), offlineOnly.fx)).toBe(0);
  expect(offlineOnly.retired).toEqual([]);
});

test("no terminal: --yes acts on the groups in scope; without it the pass refuses and changes nothing; dry-run never asks", async () => {
  const yes = effects({ interactive: () => false });
  expect(await runStale(parseStaleOptions(["--stale", "--yes"]), yes.fx)).toBe(0);
  expect(yes.retired).toEqual(["t/ghost:offline"]);
  const both = effects({ interactive: () => false });
  expect(await runStale(parseStaleOptions(["--stale", "--include-idle", "--yes"]), both.fx)).toBe(0);
  expect(both.retired).toEqual(["t/sol:idle", "t/ghost:offline"]);
  const refused = effects({ interactive: () => false });
  const error = await runStale(parseStaleOptions(["--stale"]), refused.fx).catch(e => e);
  expect(error).toBeInstanceOf(TapError);
  expect((error as TapError).errorClass).toBe("confirmation_required");
  expect(refused.retired).toEqual([]);
  const dry = effects();
  expect(await runStale(parseStaleOptions(["--stale", "--include-idle", "--dry-run", "--json"]), dry.fx)).toBe(0);
  expect(dry.asked).toEqual([]);
  expect(dry.retired).toEqual([]);
  expect(JSON.parse(dry.out.join(""))).toMatchObject({ ok: true, outcome: "dry_run", include_idle: true,
    idle: [expect.objectContaining({ handle: "sol", age_source: "turn end" })], offline: [expect.objectContaining({ handle: "ghost", age_source: "launched" })] });
});

test("a failed stop is reported and the batch keeps going; another team's restore hint names the team", async () => {
  const views = { t: view("t", [offline("a", 20 * DAY), offline("b", 10 * DAY)]), u: view("u", [offline("c", 15 * DAY)]) };
  const e = effects({ views, interactive: () => false,
    retire: (_t, s) => (s.handle === "a" ? { ok: false, detail: "session_kill_failed: session survived" } : { ok: true, detail: "" }) });
  expect(await runStale(parseStaleOptions(["--stale", "--yes", "--team", "*"]), e.fx)).toBe(1);
  const text = e.out.join("");
  expect(text).toContain("t/a: FAILED, still on the team: session_kill_failed: session survived");
  expect(text).toContain("u/c: retired; restore: tap restore c@3 --team u");
  expect(text).toContain("t/b: retired; restore: tap restore b@3\n");
});

test("parsing: three --stale spellings with units, --hard and --include-idle without --stale refuse", () => {
  expect(parseStaleOptions(["--stale"]).stale).toEqual({ seconds: 7 * DAY, text: "7d" });
  expect(parseStaleOptions(["--stale=14d"]).stale.seconds).toBe(14 * DAY);
  expect(parseStaleOptions(["--stale", "14d", "--include-idle"])).toMatchObject({ stale: { seconds: 14 * DAY }, includeIdle: true });
  expect(() => parseStaleOptions(["--stale=30"])).toThrow(/needs a duration with a unit/);
  expect(() => parseStaleOptions(["--stale", "--hard"])).toThrow(/cannot be combined/);
});

// ---- end to end ----------------------------------------------------------------

function fixture(teams: Record<string, Record<string, unknown>>, socket = `stale-${process.pid}`) {
  const base = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "tap-stale.")));
  owned.push(base);
  const index = join(base, "index");
  mkdirSync(index);
  const entries: Record<string, unknown> = {}, roots: Record<string, string> = {};
  for (const [team, seats] of Object.entries(teams)) {
    const root = join(base, team), registry = join(root, ".tap", "team-registry.json");
    mkdirSync(join(root, ".tap", "bus"), { recursive: true });
    writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: team, worktree_root: root }, seats }, null, 2));
    entries[team] = { root, registry_location: registry, state: "registered" };
    roots[team] = root;
  }
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: entries }));
  const env: NodeJS.ProcessEnv = { ...process.env, TAP_HOME: join(roots[Object.keys(teams)[0]!]!, ".tap", "bus"), TAP_INDEX_HOME: index,
    TAP_LOCK_DIR: join(base, "locks"), TAP_SCRATCH_ONLY: base, TAP_SPOOL_DISABLE_DELIVERER: "1", TAP_TMUX_SOCKET: socket };
  delete env.TMUX; delete env.TMUX_PANE; delete env.TAP_SELF;
  const run = (team: string, ...argv: string[]) => {
    const r = Bun.spawnSync([process.execPath, MAIN, ...argv], { cwd: roots[team], env: { ...env, TAP_HOME: join(roots[team]!, ".tap", "bus") }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const seats = (team: string) => JSON.parse(readFileSync(join(roots[team]!, ".tap", "team-registry.json"), "utf8")).seats as Record<string, Record<string, unknown>>;
  const history = (team: string) => { const d = join(roots[team]!, ".tap", "team-history"); return existsSync(d) ? readdirSync(d).filter(n => n.endsWith(".json")) : []; };
  return { base, roots, env, run, seats, history };
}
const oldRow = (handle: string, team = "t", extra: Record<string, unknown> = {}) => ({ harness: "claude", harness_session_id: `${handle}-sid`,
  session: `${team}/${handle}`, delivery: "pane", status: "suspended", status_reason: "session_stopped", instance: `${handle}|1`,
  registered_at: iso(Date.now() / 1000 - 40 * DAY), last_launched: iso(Date.now() / 1000 - 30 * DAY), ...extra });

test("end to end: both groups' retirement paths leave a tombstone, and the CLI lists, refuses without consent and restores across teams", () => {
  const f = fixture({ t: { ghost: oldRow("ghost"), sleeper: oldRow("sleeper"), fresh: oldRow("fresh", "t", { last_launched: iso(Date.now() / 1000) }) },
    u: { far: oldRow("far", "u") } });
  const dry = f.run("t", "team", "refresh", "--stale", "--dry-run", "--json");
  expect(dry.code, dry.out + dry.err).toBe(0);
  expect(JSON.parse(dry.out).offline.map((s: Record<string, unknown>) => [s.handle, s.age_source])).toEqual([["ghost", "launched"], ["sleeper", "launched"]]);
  const refused = f.run("t", "team", "refresh", "--stale");
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("--yes");
  expect(Object.keys(f.seats("t")).sort()).toEqual(["fresh", "ghost", "sleeper"]);
  expect(f.run("t", "team", "refresh", "--include-idle").code).toBe(1);
  expect(f.run("t", "team", "refresh", "--stale", "--hard").code).toBe(1);

  // The two effect paths directly: plain `tap out` (offline) and `tap out --kill` (idle, still running).
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { TAP_HOME: join(f.roots.t!, ".tap", "bus"), TAP_INDEX_HOME: f.env.TAP_INDEX_HOME, TAP_LOCK_DIR: f.env.TAP_LOCK_DIR,
      TAP_SCRATCH_ONLY: f.base, TAP_TMUX_SOCKET: f.env.TAP_TMUX_SOCKET });
    delete process.env.TMUX; delete process.env.TMUX_PANE;
    const retire = productionRetire(SCRIPTS);
    const team = { team: "t", root: f.roots.t!, registryLocation: join(f.roots.t!, ".tap", "team-registry.json") };
    const make = (handle: string, group: "idle" | "offline") => ({ team: "t", handle, harness: "claude", model: "", group, ageSeconds: 30 * DAY, source: "launched", crews: 0, leader: false });
    expect(retire(team, make("ghost", "offline"))).toEqual({ ok: true, detail: "" });
    expect(retire(team, make("sleeper", "idle"))).toEqual({ ok: true, detail: "" });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  expect(Object.keys(f.seats("t"))).toEqual(["fresh"]);
  expect(f.history("t").filter(n => n.startsWith("ghost.") || n.startsWith("sleeper."))).toHaveLength(2);

  // Cross-team: retire u/far via the CLI from team t, then restore it with the printed hint.
  const all = f.run("t", "team", "refresh", "--stale", "--team", "*", "--yes", "--json");
  expect(all.code, all.out + all.err).toBe(0);
  const far = JSON.parse(all.out).results.find((r: Record<string, unknown>) => r.handle === "far");
  expect(far).toMatchObject({ team: "u", ok: true, restore: "tap restore far@1 --team u" });
  const restored = f.run("t", "restore", "far@1", "--team", "u", "--json");
  expect(restored.code, restored.out + restored.err).toBe(0);
  expect(f.seats("u").far).toMatchObject({ harness_session_id: "far-sid", status: "suspended" });
  // `tap session resume` resolves from the cwd, so the next step runs from team u's root, not this checkout.
  expect(JSON.parse(restored.out).next).toBe(`cd '${f.roots.u}' && tap session resume far`);
  // A refusal's next step keeps the selected team too.
  const again = f.run("t", "restore", "far@1", "--team", "u", "--json");
  expect(again.code).not.toBe(0);
  expect(again.out + again.err).toContain("tap restore far@1 --as far-2 --team u");
});

test("no local tmux server: a seat recorded on another socket is not listed Offline and is never retired", () => {
  const local = `stale-none-${process.pid}`, env: NodeJS.ProcessEnv = { ...process.env, TAP_TMUX_SOCKET: local };
  delete env.TMUX; delete env.TMUX_PANE; delete env.TAP_TMUX_SOCKET_PATH;
  const away = join(dirname(physicalSocketPath(env)), `stale-elsewhere-${process.pid}`);
  const f = fixture({ t: { away: oldRow("away", "t", { server_socket: away, server_epoch: "srv:1", pane_id: "%9" }),
    here: oldRow("here", "t", { server_socket: physicalSocketPath(env) }), legacy: oldRow("legacy") } }, local);
  const dry = f.run("t", "team", "refresh", "--stale", "--include-idle", "--dry-run", "--json");
  expect(dry.code, dry.out + dry.err).toBe(0);
  const listed = JSON.parse(dry.out);
  expect(listed.offline.map((s: Record<string, unknown>) => s.handle)).toEqual(["here", "legacy"]);
  expect(listed).toMatchObject({ idle: [], unobserved: 1, still_running: 0 });
  const acted = f.run("t", "team", "refresh", "--stale", "--yes", "--json");
  expect(acted.code, acted.out + acted.err).toBe(0);
  expect(Object.keys(f.seats("t"))).toEqual(["away"]);
  expect(f.history("t").filter(n => n.startsWith("away."))).toEqual([]);
});

test("a restored seat whose session still runs is listed in neither group; a live idle seat retires with --kill and its process ends", () => {
  // A private, explicitly named socket under the runner's TMUX_TMPDIR; only this test's server is ever stopped.
  const socket = `stale-run-${process.pid}`;
  const tmuxEnv: NodeJS.ProcessEnv = { ...process.env };
  delete tmuxEnv.TMUX; delete tmuxEnv.TMUX_PANE;
  const tmux = (...args: string[]) => Bun.spawnSync(["tmux", "-L", socket, ...args], { env: tmuxEnv, stdout: "pipe", stderr: "pipe" });
  cleanups.push(() => { tmux("kill-server"); });
  const started = tmux("new-session", "-d", "-s", "t/sleeper", "-x", "80", "-y", "20", "sleep 600");
  expect(started.exitCode, started.stderr.toString()).toBe(0);
  const paneId = tmux("list-panes", "-t", "=t/sleeper", "-F", "#{pane_id}").stdout.toString().trim();
  expect(paneId).toMatch(/^%\d+$/);
  // Retired, then restored while its process kept running: a suspended row with a live session.
  const f = fixture({ t: { sleeper: oldRow("sleeper", "t", { pane_id: paneId, status_reason: "restored_from_archive" }) } }, socket);
  for (const flags of [[], ["--include-idle"]]) {
    const listed = f.run("t", "team", "refresh", "--stale", ...flags, "--dry-run", "--json");
    expect(listed.code, listed.out + listed.err).toBe(0);
    expect(JSON.parse(listed.out)).toMatchObject({ idle: [], offline: [], unobserved: 1, still_running: 1 });
  }
  expect(f.run("t", "team", "refresh", "--stale", "--include-idle", "--dry-run").out).toContain("1 of them restored while still running; check them with tap team");
  // The idle group's effect path against a really running session: --kill stops it, and the seat leaves a tombstone.
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { TAP_HOME: join(f.roots.t!, ".tap", "bus"), TAP_INDEX_HOME: f.env.TAP_INDEX_HOME, TAP_LOCK_DIR: f.env.TAP_LOCK_DIR,
      TAP_SCRATCH_ONLY: f.base, TAP_TMUX_SOCKET: socket });
    delete process.env.TMUX; delete process.env.TMUX_PANE;
    const team = { team: "t", root: f.roots.t!, registryLocation: join(f.roots.t!, ".tap", "team-registry.json") };
    const seat = { team: "t", handle: "sleeper", harness: "claude", model: "", group: "idle" as const, ageSeconds: 30 * DAY, source: "turn end", crews: 0, leader: false };
    expect(productionRetire(SCRIPTS)(team, seat)).toEqual({ ok: true, detail: "" });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  expect(tmux("has-session", "-t", "=t/sleeper").exitCode).not.toBe(0);
  expect(f.seats("t")).toEqual({});
  expect(f.history("t").filter(n => n.startsWith("sleeper."))).toHaveLength(1);
});
