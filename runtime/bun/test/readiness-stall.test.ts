// tap-bprtg's harness evidence: each instrument needs a positive turn-ended
// marker, and anything unreadable is unknown (null), which never alarms.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeTurn, codexTurn, episodePath, harnessEvidence, noteStallNotified, observeStall, opencodeEvidence, stallBoundSeconds } from "../src/readiness-stall";
import { addMessage, createOpenCodeStore } from "./support/opencode-store";
import { removeScratchTree } from "./support/scratch";

let root = "";
const claudeTurnEnded = (lines: readonly string[]) => claudeTurn(lines)?.ended ?? null;
const codexTurnEnded = (lines: readonly string[]) => codexTurn(lines)?.ended ?? null;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "readiness-stall.")); });
afterAll(() => { removeScratchTree(root); });

const j = (v: object) => JSON.stringify(v);

test("the bound is a positive integer knob with a 600s default", () => {
  expect(stallBoundSeconds({})).toBe(600);
  expect(stallBoundSeconds({ TAP_STUCK_READINESS_SECONDS: "90" })).toBe(90);
  for (const bad of ["0", "-5", "1e3", "x", ""]) expect(stallBoundSeconds({ TAP_STUCK_READINESS_SECONDS: bad })).toBe(600);
});

test("claude: only a final end_turn/stop_sequence assistant entry ends the turn", () => {
  const end = j({ type: "assistant", message: { stop_reason: "end_turn" } });
  expect(claudeTurnEnded([end, j({ type: "system", subtype: "turn_duration" }), ""])).toBe(true);
  expect(claudeTurnEnded([j({ type: "assistant", message: { stop_reason: "stop_sequence" } })])).toBe(true);
  expect(claudeTurnEnded([end, j({ type: "assistant", message: { stop_reason: "tool_use" } })])).toBe(false);
  expect(claudeTurnEnded([end, j({ type: "user", message: { content: "next" } })])).toBe(false);
  expect(claudeTurnEnded(["not json", ""])).toBeNull();
  expect(claudeTurnEnded([j({ type: "system", subtype: "turn_duration" })])).toBeNull();
});

test("codex: the last task boundary decides; a start is work", () => {
  const ev = (type: string) => j({ type: "event_msg", payload: { type } });
  expect(codexTurnEnded([ev("task_started"), ev("task_complete"), ev("token_count")])).toBe(true);
  expect(codexTurnEnded([ev("task_complete"), ev("task_started"), ev("item_completed")])).toBe(false);
  expect(codexTurnEnded([ev("task_started"), ev("turn_aborted")])).toBe(true);
  expect(codexTurnEnded([ev("token_count")])).toBeNull();
});

test("claude: falls back to <session>.jsonl in a projects dir; missing or relative paths are unknown", () => {
  const home = join(root, "claude-home"), proj = join(home, ".claude", "projects", "-x-y");
  mkdirSync(proj, { recursive: true });
  const t = join(proj, "abc-123.jsonl");
  writeFileSync(t, j({ type: "assistant", message: { stop_reason: "end_turn" } }) + "\n");
  utimesSync(t, 500, 500);
  expect(harnessEvidence("claude", { harness_session_id: "abc-123" }, { HOME: home })).toEqual({ ended: true, lastActivity: 500, at: null });
  expect(harnessEvidence("claude", { harness_session_id: "../evil" }, { HOME: home })).toBeNull();
  expect(harnessEvidence("claude", { transcript_path: "rel.jsonl" }, { HOME: home })).toBeNull();
  expect(harnessEvidence("claude", { transcript_path: join(home, "absent.jsonl") }, { HOME: home })).toBeNull();
});

test("agy, cursor and hermes have no instrument", () => {
  for (const h of ["agy", "cursor", "hermes", ""]) expect(harnessEvidence(h, { transcript_path: "/etc/hosts" }, {})).toBeNull();
});

function db(name: string, rows: object[]): string {
  const path = join(root, name);
  const store = createOpenCodeStore(path);
  for (const r of rows) addMessage(store, r);
  store.close();
  return path;
}
const msg = (role: string, created: number, completed: number | null, finish: string | null, sessionID = "s1") =>
  ({ role, sessionID, time: { created, completed }, finish });

test("opencode: the newest message of any role must be a completed assistant stop", () => {
  const ok = db("stop.db", [msg("user", 1000, null, null), msg("assistant", 2000, 3000, "stop"), msg("assistant", 9000, null, null, "other")]);
  expect(opencodeEvidence("s1", { OPENCODE_DB_PATH: ok })).toEqual({ ended: true, lastActivity: 3, at: 3 });
  // A stale completed tool-calls finish while its tool runs: work, not idle.
  const tool = db("tool.db", [msg("assistant", 2000, 3000, "tool-calls")]);
  expect(opencodeEvidence("s1", { OPENCODE_DB_PATH: tool })?.ended).toBe(false);
  // A newer user message after the stop: unprocessed work.
  const user = db("user.db", [msg("assistant", 2000, 3000, "stop"), msg("user", 4000, null, null)]);
  expect(opencodeEvidence("s1", { OPENCODE_DB_PATH: user })).toEqual({ ended: false, lastActivity: 4, at: null });
  // An open assistant message.
  const open = db("open.db", [msg("assistant", 2000, null, null)]);
  expect(opencodeEvidence("s1", { OPENCODE_DB_PATH: open })?.ended).toBe(false);
});

test("opencode: no session, no rows, a missing or junk store are unknown", () => {
  const ok = db("other.db", [msg("assistant", 2000, 3000, "stop", "other")]);
  expect(opencodeEvidence("", { OPENCODE_DB_PATH: ok })).toBeNull();
  expect(opencodeEvidence("s1", { OPENCODE_DB_PATH: ok })).toBeNull();
  expect(opencodeEvidence("s1", { OPENCODE_DB_PATH: join(root, "absent.db") })).toBeNull();
  const junk = join(root, "junk.db");
  writeFileSync(junk, "not a database");
  expect(opencodeEvidence("s1", { OPENCODE_DB_PATH: junk })).toBeNull();
});

// Fault probes from review: each failed quiet in the wrong direction before the fix.
for (const harness of ["claude", "codex"] as const) {
  test(`${harness}: a malformed newest record is unknown evidence, never an older end marker`, () => {
    const path = join(root, `${harness}-torn.jsonl`);
    const ended = harness === "claude" ? j({ type: "assistant", message: { stop_reason: "end_turn" } }) : j({ type: "event_msg", payload: { type: "task_complete" } });
    writeFileSync(path, ended + "\n" + (harness === "claude" ? '{"type":"user",' : '{"type":"event_msg","payload":{"type":"task_started",'));
    utimesSync(path, 500, 500);
    // Unknown, not ended:false: a parse failure must not alarm, and must not read as recovery either.
    expect(harnessEvidence(harness, { transcript_path: path }, {})).toBeNull();
  });
}

test("an episode that cannot be recorded never alarms", () => {
  const home = join(root, "write-fault");
  const path = episodePath({ home, registry: "/r/registry.json", handle: "peer" })!;
  mkdirSync(join(home, "seat-state"), { recursive: true });
  writeFileSync(path, j({ schema: 1, seat: "peer", registry: "/r/registry.json", pane_id: "%99", instance: "one", since: 1000, last_seen: 1030, notified: [] }));
  mkdirSync(`${path}.${process.pid}.tmp`); // the atomic write's temp path is blocked
  const obs = { home, registry: "/r/registry.json", handle: "peer", paneId: "%99", instance: "one", verdict: "busy:noprompt", evidence: { ended: true, lastActivity: 500, at: 400 }, bound: 60 };
  expect(observeStall({ ...obs, now: 1060 })).toBeNull();
});

test("unknown evidence keeps an alarmed episode; it is not recovery", () => {
  const home = join(root, "unknown-not-recovery");
  const binding = { home, registry: "/r/registry.json", handle: "peer", paneId: "%99", instance: "one" };
  const obs = { ...binding, verdict: "busy:noprompt", bound: 60 };
  const ev = { ended: true, lastActivity: 500, at: 400 };
  expect(observeStall({ ...obs, evidence: ev, now: 1000 })).toBeNull();
  expect(observeStall({ ...obs, evidence: ev, now: 1060 })).toEqual({ since: 1000, notified: [] });
  noteStallNotified(binding, ["stall-peer-1000"]);
  expect(observeStall({ ...obs, evidence: null, now: 1070 })).toBeNull();
  expect(observeStall({ ...obs, evidence: ev, now: 1080 })).toEqual({ since: 1000, notified: ["stall-peer-1000"] });
});

test("at is the ending record's own timestamp, never the file's mtime", () => {
  const ts = "2026-10-01T12:50:44.102Z", sec = Date.parse(ts) / 1000;
  expect(claudeTurn([j({ type: "assistant", timestamp: ts, message: { stop_reason: "end_turn" } }), j({ type: "system", subtype: "turn_duration", timestamp: "2026-10-01T13:00:00Z" })]))
    .toEqual({ ended: true, at: sec });
  expect(codexTurn([j({ timestamp: ts, type: "event_msg", payload: { type: "task_complete" } }), j({ timestamp: "2026-10-01T13:00:00Z", type: "event_msg", payload: { type: "token_count" } })]))
    .toEqual({ ended: true, at: sec });
  expect(claudeTurn([j({ type: "assistant", message: { stop_reason: "end_turn" } })])).toEqual({ ended: true, at: null });
  expect(claudeTurn([j({ type: "assistant", timestamp: ts, message: { stop_reason: "tool_use" } })])).toEqual({ ended: false, at: null });
  const path = join(root, "at.jsonl");
  writeFileSync(path, j({ type: "assistant", timestamp: ts, message: { stop_reason: "end_turn" } }) + "\n");
  utimesSync(path, 2_000_000_000, 2_000_000_000); // a later background append moves mtime, not at
  expect(harnessEvidence("claude", { transcript_path: path }, {})?.at).toBe(sec);
});
