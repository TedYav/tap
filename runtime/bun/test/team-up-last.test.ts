import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { selectRestartCohort, restartRowMatches } from "../src/team/up-last";
import { reserveTransaction, type LaunchRecord } from "../src/launcher/transaction";
import { selectCaller } from "../src/selector";
import { removeScratchTree } from "./support/scratch";
import { namespaceSnapshot, observeGeneration, type Observation } from "../src/launcher/generation";

type Row = Record<string, unknown>;
const boot = "bootuuid:00000000-0000-0000-0000-000000000001";
const oldBoot = "bootuuid:00000000-0000-0000-0000-000000000002";
const observation = { boot, epoch: "srv:30:30", socket: "/s" };
const row = (extra: Row = {}): Row => ({ instance: "retained", delivery: "pane", status: "active", status_reason: "",
  session: "t/a", harness: "claude", server_socket: "/s", server_epoch: "srv:20:20", boot_id: oldBoot, ...extra });
const selected = (rows: Record<string, Row>, names = new Set<string>(), obs: Observation = observation) =>
  selectRestartCohort(new Map(Object.entries(rows)), names, obs, "/s", "t");

test("a live occupant excludes its seat without exposing an older generation", () => {
  expect([...selected({ newest: row(), older: row({ server_epoch: "srv:10:10", session: "t/old" }) }, new Set(["t/a"])).rows]).toEqual([]);
});

test("current-generation exits and first-observation timestamps never form a restart cohort", () => {
  expect([...selected({ current: row({ boot_id: boot, server_epoch: "srv:30:30", exited_at: "2026-10-22T08:00:00Z" }) }).rows]).toEqual([]);
});

test("no-server and a fresh replacement server select the same old cohort", () => {
  const rows = { a: row(), b: row({ session: "t/b", status: "suspended", status_reason: "pane_gone" }) };
  const noServer = selectRestartCohort(new Map(Object.entries(rows)), new Set(), { boot, epoch: null, socket: "" }, "/s", "t", true);
  expect([...noServer.rows.keys()]).toEqual(["a", "b"]);
  expect([...selected(rows).rows.keys()]).toEqual(["a", "b"]);
});

test("legacy stopped rows without delivery or pane coordinates still block an older generation", () => {
  const result = selected({ stopped: row({ delivery: null, status: "suspended", status_reason: "session_stopped" }),
    older: row({ session: "t/older", server_epoch: "srv:10:10" }) });
  expect([...result.rows.keys()]).toEqual([]);
});

test("valid legacy boot stamps use server epochs without inventing a same-server restart", () => {
  const result = selected({ old: row({ boot_id: "boot:100" }), current: row({ boot_id: "boot:100", server_epoch: "srv:30:30" }) });
  expect([...result.rows.keys()]).toEqual(["old"]);
});

test("one server epoch forms one cohort across boot-stamp formats", () => {
  for (const reverse of [false, true]) {
    const entries: Array<[string, Row]> = [["legacy", row({ boot_id: "boot:100" })], ["current", row()]];
    if (reverse) entries.reverse();
    const result = selectRestartCohort(new Map(entries), new Set(), observation, "/s", "t");
    expect([...result.rows.keys()].sort()).toEqual(["current", "legacy"]);
  }
});

test("equal server epochs with conflicting same-format boot identities remain ambiguous", () => {
  expect(() => selected({ a: row(), b: row({ boot_id: boot }) })).toThrow("same start time");
  expect(() => selected({ a: row({ boot_id: "boot:100" }), b: row({ boot_id: "boot:200" }) })).toThrow("same start time");
});

test("an empty live namespace still requires readable generation evidence", () => {
  expect(() => selected({ a: row() }, new Set(), { boot, epoch: null, socket: "" })).toThrow("unobservable");
});

test("crew, foreign sockets, unknown stamps and explicit retirement never join the cohort", () => {
  const result = selected({ a: row(), crew: row({ crew: true }), poll: row({ delivery: "poll" }),
    invalidDelivery: row({ delivery: "unknown" }), foreignTeam: row({ team: "other" }),
    foreign: row({ server_socket: "/foreign", server_epoch: "srv:40:40" }),
    unknown: row({ server_epoch: "bad" }), retired: row({ status_reason: "user_removed" }),
    pending: row({ status: "pending" }), launching: row({ status_reason: "launching" }) });
  expect([...result.rows.keys()]).toEqual(["a"]);
  expect(result.skipped).toEqual(["unknown"]);
  expect(result.crews).toBe(1);
});

test("unobservable current identity and ambiguous newest generations refuse", () => {
  expect(() => selected({ a: row() }, new Set(["t/live"]), { boot, epoch: null, socket: "" })).toThrow("unobservable");
  expect(() => selected({ a: row() }, new Set(), { ...observation, boot: "bad" })).toThrow("unobservable");
  expect(() => selected({ a: row(), b: row({ server_epoch: "srv:21:20" }) })).toThrow("same start time");
});

test("restart consent detects stop, identity and recipe changes but tolerates unrelated activity", () => {
  const expected = row({ harness_env: { A: "literal" }, index: 1 });
  for (const change of [{ status: "suspended", status_reason: "session_stopped" }, { harness_session_id: "replacement" },
    { harness_env: { A: "changed" } }, { instance: "replacement" }]) {
    expect(restartRowMatches(expected, { ...expected, ...change })).toBe(false);
  }
  expect(restartRowMatches(expected, { ...expected, last_seen: "later" })).toBe(true);
});

const scratch: string[] = [];
const saved = { ...process.env };
afterEach(() => {
  for (const path of scratch.splice(0)) removeScratchTree(path);
  for (const key of ["TAP_INDEX_HOME", "TAP_HOME", "TAP_TEAM_SELECT", "TAP_SELF", "PATH", "TAP_TMUX_SOCKET_PATH", "TAP_SERVER_EPOCH", "TAP_BOOT_ID"]) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});

test("restart namespace and generation probes use the explicit socket rather than an ambient server", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "restart-socket-"))); scratch.push(root);
  writeFileSync(join(root, "tmux"), `#!/bin/sh
if [ "$1" != -S ] || [ "$2" != /chosen ]; then echo ambient; exit 0; fi
shift 2
case "$1" in
  list-sessions) echo t/live ;;
  display-message) case "$3" in *socket_path*) printf '30:30\\t/chosen\\n' ;; *) echo 30:30 ;; esac ;;
esac
`, { mode: 0o755 });
  process.env.PATH = `${root}:${saved.PATH}`;
  process.env.TAP_TMUX_SOCKET_PATH = "/chosen";
  process.env.TAP_BOOT_ID = boot;
  delete process.env.TAP_SERVER_EPOCH;
  expect(await namespaceSnapshot(true)).toEqual(new Set(["t/live"]));
  expect(await observeGeneration(undefined, true)).toEqual({ boot, epoch: "srv:30:30", socket: "/chosen" });
});

test("retirement after preview is refused under reservation custody without rewriting the registry", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "restart-pin-"))); scratch.push(root);
  mkdirSync(join(root, ".tap"), { recursive: true }); mkdirSync(join(root, "index"));
  const registry = join(root, ".tap/team-registry.json");
  const expected = row({ session: "t/a", registered_from_worktree: root });
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "t", worktree_root: root },
    seats: { a: { ...expected, status: "suspended", status_reason: "session_stopped" } } }));
  writeFileSync(join(root, "index/global-registry.json"), JSON.stringify({ schema: "0.20", teams: { t: { root, registry_location: registry } } }));
  const env = { ...process.env, TAP_INDEX_HOME: join(root, "index"), TAP_HOME: undefined, TAP_TEAM_SELECT: undefined, TAP_SELF: undefined };
  process.env.TAP_INDEX_HOME = env.TAP_INDEX_HOME;
  for (const key of ["TAP_HOME", "TAP_TEAM_SELECT", "TAP_SELF"]) delete process.env[key];
  const selection = selectCaller({ cwd: root, env, verbClass: "lifecycle" });
  const record = { name: "t/a", base: "t", tag: "a", index: 1, harness: "claude", cwd: root } as LaunchRecord;
  const before = readFileSync(registry, "utf8");
  await expect(reserveTransaction(selection, { kind: "resume-all", record, live_sessions: [], approved_restart_row: expected },
    { selection, handle: "a", token: "", instance: null, record, vessel: null, backup: { status: "not-needed" }, reason: "", output_path: "" }, env))
    .rejects.toThrow("changed after restart preview");
  expect(readFileSync(registry, "utf8")).toBe(before);
});
