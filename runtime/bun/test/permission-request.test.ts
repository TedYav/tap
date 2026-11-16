import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { removeScratchTree } from "./support/scratch";
import {
  SUMMARY_MAX, findClaudeSessionFile, pendingPermissionRequest, permissionRequestFiles, permissionSummary,
  permissionToolName, readClaudeSessionState, removePermissionRequest, removePermissionRequestDir,
  writePermissionRequest, type PermissionRequestRecord,
} from "../src/permission-request";

const SESSION = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const OTHER = "59b665c7-cb5e-455b-81a4-d15671fd82ee";
const WAIT_STARTED = 1_794_598_987_299;
const RECORD_NAME = /^scout\.\d{13}-[0-9a-f]{8}\.json$/;

function scratch(): { root: string; bus: string; sessions: string; dir: string } {
  const root = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR!, "permission-request-")));
  const bus = join(root, "bus"), sessions = join(root, "claude/sessions");
  mkdirSync(bus, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  return { root, bus, sessions, dir: join(bus, "permission-requests") };
}

/** A session file as Claude Code 2.1.323 writes it, cut to what TAP reads plus two fields it ignores. */
function sessionFile(dir: string, fields: Record<string, unknown> = {}, pid = process.pid): string {
  const path = join(dir, `${pid}.json`);
  writeFileSync(path, JSON.stringify({ pid, sessionId: SESSION, cwd: "/work", kind: "interactive",
    status: "waiting", waitingFor: "permission prompt", statusUpdatedAt: WAIT_STARTED, ...fields }));
  return path;
}

function record(file: string, fields: Partial<PermissionRequestRecord> = {}): PermissionRequestRecord {
  return { v: 1, harness: "claude", at: WAIT_STARTED + 20, session: SESSION, pane_id: "%7", server_epoch: "srv:1:2",
    tool: "Bash", summary: "Create empty probe-a.txt in the current directory", permission_mode: "auto", session_file: file, ...fields };
}

/** Arbitrary bytes at a record-shaped name, as a damaged or foreign file would sit there. */
function plant(bus: string, bytes: string, handle = "scout", at = WAIT_STARTED + 20, id = "0a1b2c3d"): string {
  mkdirSync(join(bus, "permission-requests"), { recursive: true });
  const path = join(bus, "permission-requests", `${handle}.${at}-${id}.json`);
  writeFileSync(path, bytes);
  return path;
}

const files = (bus: string, handle = "scout"): string[] => permissionRequestFiles(bus, handle);
const summaries = (bus: string, handle = "scout"): string[] => files(bus, handle).map(path => JSON.parse(readFileSync(path, "utf8")).summary);
const SEAT = { sessionId: SESSION, paneId: "%7", serverEpoch: "srv:1:2" };

test("a summary never carries a command line, a file body or more than its cap", () => {
  expect(permissionSummary("Bash", { command: "curl --data private-field https://x", description: "Fetch the status page" }))
    .toBe("Fetch the status page");
  // No description: nothing, never the command.
  expect(permissionSummary("Bash", { command: "rm -rf build" })).toBe("");
  expect(permissionSummary("Write", { file_path: "/repo/notes.md", content: "SECRET BODY" })).toBe("/repo/notes.md");
  expect(permissionSummary("Edit", { file_path: "/repo/a.ts", old_string: "x", new_string: "y" })).toBe("/repo/a.ts");
  expect(permissionSummary("NotebookEdit", { notebook_path: "/repo/n.ipynb", new_source: "print(1)" })).toBe("/repo/n.ipynb");
  expect(permissionSummary("AskUserQuestion", { questions: [{ question: "Pick one", options: [{ label: "A" }] }, { question: "second" }] })).toBe("Pick one");
  // A tool TAP has no rule for contributes its name only.
  expect(permissionSummary("mcp__db__query", { sql: "select * from users" })).toBe("");
  expect(permissionSummary("Bash", "not an object")).toBe("");

  const long = permissionSummary("Bash", { description: "x".repeat(500) });
  expect(Array.from(long).length).toBe(SUMMARY_MAX);
  expect(long.endsWith("…")).toBe(true);
  // Newline, tab, bell and the two Unicode line separators all flatten to one line.
  const controls = `line one\nline two\ttabbed${String.fromCharCode(7)}bell${String.fromCharCode(0x2028)}ls${String.fromCharCode(0x2029)}ps`;
  expect(permissionSummary("Bash", { description: controls })).toBe("line one line two tabbed bell ls ps");
});

test("a tool name is a bounded identifier or nothing", () => {
  expect(permissionToolName("Bash")).toBe("Bash");
  expect(permissionToolName("mcp__server__tool-1.x")).toBe("mcp__server__tool-1.x");
  for (const bad of ["", "has space", "new\nline", "../../etc", "x".repeat(121), 7, null, undefined]) expect(permissionToolName(bad)).toBe("");
});

test("the session file reader takes what it knows and never throws on what it does not", () => {
  const { root, sessions } = scratch();
  try {
    const path = sessionFile(sessions);
    expect(readClaudeSessionState(path)).toEqual({ pid: process.pid, sessionId: SESSION, status: "waiting", waitingFor: "permission prompt", statusUpdatedAt: WAIT_STARTED });
    expect(readClaudeSessionState(join(sessions, "404.json"))).toBe("missing");

    writeFileSync(path, "{ not json");
    expect(readClaudeSessionState(path)).toBe("unreadable");
    writeFileSync(path, JSON.stringify(["an", "array"]));
    expect(readClaudeSessionState(path)).toBe("unreadable");
    writeFileSync(path, JSON.stringify({ pid: "7", sessionId: SESSION }));
    expect(readClaudeSessionState(path)).toBe("unreadable");

    // The status field renamed, removed or retyped: the file still parses and reports no status.
    for (const fields of [{ status: undefined, state: "waiting" }, { status: 3 }, { status: null }, { status: { value: "waiting" } }]) {
      sessionFile(sessions, fields);
      const state = readClaudeSessionState(path);
      expect(typeof state === "object" && state.status).toBe("");
    }
    sessionFile(sessions, { statusUpdatedAt: "soon" });
    const state = readClaudeSessionState(path);
    expect(typeof state === "object" && state.statusUpdatedAt).toBe(null);
  } finally { removeScratchTree(root); }
});

test("the hook finds only a live process's file for its own session, and only one that reports a status", () => {
  const { root, sessions } = scratch();
  try {
    const mine = sessionFile(sessions, {}, 4100);
    sessionFile(sessions, { sessionId: OTHER }, 4200);
    sessionFile(sessions, { statusUpdatedAt: WAIT_STARTED + 5000 }, 4300); // same session, dead process
    writeFileSync(join(sessions, "notes.txt"), "not a session file");
    const alive = (pid: number) => pid !== 4300;
    expect(findClaudeSessionFile(SESSION, sessions, alive)).toBe(mine);
    expect(findClaudeSessionFile("not-a-uuid", sessions, alive)).toBe("");
    expect(findClaudeSessionFile(SESSION, join(root, "absent"), alive)).toBe("");
    // An older Claude writes the file without a status: nothing can vouch, so nothing is found.
    sessionFile(sessions, { status: undefined }, 4100);
    expect(findClaudeSessionFile(SESSION, sessions, alive)).toBe("");
  } finally { removeScratchTree(root); }
});

test("a record is written private, under a name of its own, and shown while Claude's session file says that session is waiting", () => {
  const { root, bus, sessions } = scratch();
  try {
    const file = sessionFile(sessions);
    expect(writePermissionRequest(bus, "scout", record(file))).toBe(true);
    expect(files(bus)).toHaveLength(1);
    const path = files(bus)[0]!;
    expect(basename(path)).toMatch(RECORD_NAME);
    expect(basename(path).startsWith(`scout.${WAIT_STARTED + 20}-`)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8"))).sort()).toEqual(
      ["at", "harness", "pane_id", "permission_mode", "server_epoch", "session", "session_file", "summary", "tool", "v"]);
    expect(pendingPermissionRequest(bus, "scout", SEAT)).toEqual({
      tool: "Bash", summary: "Create empty probe-a.txt in the current directory",
      since: Math.floor((WAIT_STARTED + 20) / 1000), waitingFor: "permission prompt" });
    expect(files(bus)).toEqual([path]);

    sessionFile(sessions, { waitingFor: "input needed" });
    writePermissionRequest(bus, "scout", record(file, { at: WAIT_STARTED + 900, tool: "AskUserQuestion", summary: "Pick one" }));
    expect(pendingPermissionRequest(bus, "scout", SEAT)).toMatchObject({ tool: "AskUserQuestion", waitingFor: "input needed" });

    // A handle that is not a token, or a time that is not one, names no file.
    expect(writePermissionRequest(bus, "../escape", record(file))).toBe(false);
    expect(writePermissionRequest(bus, "scout", record(file, { at: Number.NaN }))).toBe(false);
    expect(writePermissionRequest("", "scout", record(file))).toBe(false);
    expect(pendingPermissionRequest(bus, "../escape", SEAT)).toBe(null);
    expect(readdirSync(join(bus, "permission-requests"))).toHaveLength(1);
  } finally { removeScratchTree(root); }
});

test("each request is a new file: the hook removes this seat's strictly older ones and replaces nothing", () => {
  const { root, bus, sessions } = scratch();
  try {
    const file = sessionFile(sessions);
    const first = record(file, { at: WAIT_STARTED + 10, summary: "first" });
    writePermissionRequest(bus, "scout", first);
    const firstPath = files(bus)[0]!;
    writePermissionRequest(bus, "scout", record(file, { at: WAIT_STARTED + 20, summary: "second" }));
    // The earlier file is gone by its own name; the later one never had that name.
    expect(existsSync(firstPath)).toBe(false);
    expect(summaries(bus)).toEqual(["second"]);

    // Two requests in the same millisecond are both kept: neither is strictly older.
    writePermissionRequest(bus, "scout", record(file, { at: WAIT_STARTED + 20, summary: "same millisecond" }));
    expect(summaries(bus).sort()).toEqual(["same millisecond", "second"]);
    // A hook that ran earlier and finishes later removes nothing newer than itself.
    writePermissionRequest(bus, "scout", record(file, { at: WAIT_STARTED + 15, summary: "late finisher" }));
    expect(summaries(bus).sort()).toEqual(["late finisher", "same millisecond", "second"]);
    // The reader shows one of the newest and removes what they supersede.
    expect(pendingPermissionRequest(bus, "scout", SEAT)?.summary).toMatch(/^(second|same millisecond)$/);
    expect(files(bus)).toHaveLength(1);
  } finally { removeScratchTree(root); }
});

test("a seat's records are matched by its whole handle, never a prefix of another's", () => {
  const { root, bus, sessions } = scratch();
  try {
    // Handles may hold dots, digits and hyphens: `opus` is a prefix of `opus.fixer` and of `opus.1794598987319-0a1b2c3d`.
    const file = sessionFile(sessions);
    const tricky = "opus.1794598987319-0a1b2c3d";
    for (const handle of ["opus.fixer", tricky]) writePermissionRequest(bus, handle, record(file, { summary: handle }));
    expect(files(bus, "opus")).toEqual([]);

    // Writing, reading and retiring `opus` leaves the other seats' records alone.
    writePermissionRequest(bus, "opus", record(file, { at: WAIT_STARTED + 5000, summary: "opus" }));
    expect(summaries(bus, "opus.fixer")).toEqual(["opus.fixer"]);
    expect(summaries(bus, tricky)).toEqual([tricky]);
    // `opus` is bound to another session, so its own record is stale and goes; the others are not judged.
    expect(pendingPermissionRequest(bus, "opus", { ...SEAT, sessionId: OTHER })).toBe(null);
    expect(files(bus, "opus")).toEqual([]);
    expect(pendingPermissionRequest(bus, "opus.fixer", SEAT)?.summary).toBe("opus.fixer");
    writePermissionRequest(bus, "opus", record(file, { at: WAIT_STARTED + 6000, summary: "opus again" }));
    removePermissionRequest(bus, "opus");
    expect(files(bus, "opus")).toEqual([]);
    expect(summaries(bus, "opus.fixer")).toEqual(["opus.fixer"]);
    expect(summaries(bus, tricky)).toEqual([tricky]);
  } finally { removeScratchTree(root); }
});

test("a record for a session not marked waiting is never shown, and the reader that notices removes it", () => {
  const { root, bus, sessions } = scratch();
  try {
    // Declined or cancelled at the terminal: no hook fires, only the session file changes.
    for (const status of ["idle", "busy", "shell"]) {
      const file = sessionFile(sessions, { status, waitingFor: undefined });
      writePermissionRequest(bus, "scout", record(file));
      expect(pendingPermissionRequest(bus, "scout", SEAT)).toBe(null);
      expect(files(bus)).toEqual([]);
    }
    // The session ended: its file is gone.
    writePermissionRequest(bus, "scout", record(join(sessions, "404.json")));
    expect(pendingPermissionRequest(bus, "scout", SEAT)).toBe(null);
    expect(files(bus)).toEqual([]);
    // The process died and left its file saying it is waiting.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writePermissionRequest(bus, "scout", record(sessionFile(sessions, {}, dead)));
    expect(pendingPermissionRequest(bus, "scout", SEAT)).toBe(null);
    expect(files(bus)).toEqual([]);
    // The process now runs another session (/clear).
    writePermissionRequest(bus, "scout", record(sessionFile(sessions, { sessionId: OTHER })));
    expect(pendingPermissionRequest(bus, "scout", SEAT)).toBe(null);
    expect(files(bus)).toEqual([]);
    // The seat's registered session or pane is not the record's.
    const file = sessionFile(sessions);
    for (const seat of [{ ...SEAT, sessionId: OTHER }, { ...SEAT, sessionId: "" }, { ...SEAT, paneId: "%8" }, { ...SEAT, serverEpoch: "srv:9:9" }]) {
      writePermissionRequest(bus, "scout", record(file));
      expect(pendingPermissionRequest(bus, "scout", seat)).toBe(null);
      expect(files(bus)).toEqual([]);
    }
    // Waiting again, on a later request whose hook wrote nothing: the old record is not that request.
    writePermissionRequest(bus, "scout", record(file, { at: WAIT_STARTED - 60_000 }));
    expect(pendingPermissionRequest(bus, "scout", SEAT)).toBe(null);
    expect(files(bus)).toEqual([]);
  } finally { removeScratchTree(root); }
});

test("a session file TAP cannot use shows nothing, errors on nothing, and leaves the record alone", () => {
  const { root, bus, sessions } = scratch();
  try {
    const file = sessionFile(sessions);
    writePermissionRequest(bus, "scout", record(file));
    const kept = files(bus);
    const variants: Array<() => void> = [
      () => writeFileSync(file, "{ truncated"),
      () => sessionFile(sessions, { status: undefined }),
      () => sessionFile(sessions, { status: undefined, state: "waiting" }),
      () => sessionFile(sessions, { status: 1 }),
      () => sessionFile(sessions, { statusUpdatedAt: undefined }),
      () => sessionFile(sessions, { statusUpdatedAt: "2026-11-13" }),
      () => writeFileSync(file, "x".repeat(70_000)),
    ];
    for (const apply of variants) {
      apply();
      expect(() => pendingPermissionRequest(bus, "scout", SEAT)).not.toThrow();
      expect(pendingPermissionRequest(bus, "scout", SEAT)).toBe(null);
      expect(files(bus)).toEqual(kept);
    }
  } finally { removeScratchTree(root); }
});

test("a record TAP did not write as version 1 is not shown; a broken one is removed, a later version is left", () => {
  const { root, bus, sessions } = scratch();
  try {
    const file = sessionFile(sessions);
    for (const broken of ["{ not json", JSON.stringify([1]), JSON.stringify({ v: 1, harness: "claude" }),
      JSON.stringify({ ...record(file), tool: "has space" }), JSON.stringify({ ...record(file), session: "nope" }), "x".repeat(5000)]) {
      const path = plant(bus, broken);
      expect(pendingPermissionRequest(bus, "scout", SEAT)).toBe(null);
      expect(existsSync(path)).toBe(false);
    }
    const later = plant(bus, JSON.stringify({ ...record(file), v: 2 }));
    expect(pendingPermissionRequest(bus, "scout", SEAT)).toBe(null);
    expect(existsSync(later)).toBe(true);
    // A file in the directory that is not record-shaped is nobody's record: not read, not removed.
    const stray = join(bus, "permission-requests", "scout.json");
    writeFileSync(stray, JSON.stringify(record(file)));
    unlinkSync(later);
    expect(pendingPermissionRequest(bus, "scout", SEAT)).toBe(null);
    removePermissionRequest(bus, "scout");
    expect(existsSync(stray)).toBe(true);
  } finally { removeScratchTree(root); }
});

test("a reader of another team's bus judges and removes nothing: stale, broken and superseded files all stay", () => {
  const { root, bus, sessions } = scratch();
  try {
    const idle = sessionFile(sessions, { status: "idle" });
    writePermissionRequest(bus, "scout", record(idle, { at: WAIT_STARTED + 30, summary: "newest, stale" }));
    const superseded = plant(bus, JSON.stringify(record(idle, { at: WAIT_STARTED + 10 })), "scout", WAIT_STARTED + 10, "0000aaaa");
    const before = files(bus);
    expect(before).toHaveLength(2);
    expect(pendingPermissionRequest(bus, "scout", SEAT, { remove: false })).toBe(null);
    expect(files(bus)).toEqual(before);
    const broken = plant(bus, "{ not json", "scout", WAIT_STARTED + 40, "0000bbbb");
    expect(pendingPermissionRequest(bus, "scout", SEAT, { remove: false })).toBe(null);
    expect(files(bus)).toEqual([superseded, before[1]!, broken]);
    // The team's own reader clears all three.
    expect(pendingPermissionRequest(bus, "scout", SEAT)).toBe(null);
    expect(pendingPermissionRequest(bus, "scout", SEAT)).toBe(null);
    expect(files(bus)).toEqual([]);
  } finally { removeScratchTree(root); }
});

test("seat removal drops that seat's records; uninstall drops the directory and nothing beside it", () => {
  const { root, bus, sessions, dir } = scratch();
  try {
    const file = sessionFile(sessions);
    writePermissionRequest(bus, "scout", record(file));
    writePermissionRequest(bus, "pilot", record(file));
    removePermissionRequest(bus, "scout");
    removePermissionRequest(bus, "scout"); // absent is success
    expect(files(bus, "scout")).toEqual([]);
    expect(files(bus, "pilot")).toHaveLength(1);
    writeFileSync(join(bus, "sibling.txt"), "kept");
    // A writer that died before its rename leaves a staging file; uninstall takes that too.
    writeFileSync(join(dir, ".tap.2s.0a1b2c3d.tmp"), "{}");
    expect(removePermissionRequestDir(bus)).toBe(dir);
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(join(bus, "sibling.txt"), "utf8")).toBe("kept");
    expect(removePermissionRequestDir(bus)).toBe(null);
    // Something that is not TAP's keeps the directory, and says so by returning null.
    writePermissionRequest(bus, "pilot", record(file));
    writeFileSync(join(dir, "README"), "someone else's");
    expect(removePermissionRequestDir(bus)).toBe(null);
    expect(existsSync(join(dir, "README"))).toBe(true);
    expect(files(bus, "pilot")).toEqual([]);
  } finally { removeScratchTree(root); }
});

test("a symlink where the directory or a record should be is never read, written or removed through", () => {
  const { root, bus, sessions, dir } = scratch();
  try {
    const file = sessionFile(sessions);
    // The whole directory is a link to somewhere else that happens to hold JSON files, one of them record-shaped.
    const outside = join(root, "outside"), shaped = `scout.${WAIT_STARTED + 20}-0a1b2c3d.json`;
    mkdirSync(outside);
    writeFileSync(join(outside, "unrelated.json"), "someone else's\n");
    writeFileSync(join(outside, shaped), `${JSON.stringify(record(file))}\n`);
    symlinkSync(outside, dir);
    const untouched = () => expect(readdirSync(outside).sort()).toEqual([shaped, "unrelated.json"]);

    expect(removePermissionRequestDir(bus)).toBe(null);
    untouched();
    expect(writePermissionRequest(bus, "scout", record(file, { at: WAIT_STARTED + 5000 }))).toBe(false);
    untouched();
    expect(files(bus)).toEqual([]);
    expect(pendingPermissionRequest(bus, "scout", SEAT)).toBe(null);
    expect(pendingPermissionRequest(bus, "scout", { ...SEAT, sessionId: OTHER })).toBe(null);
    removePermissionRequest(bus, "scout");
    untouched();
    expect(readFileSync(join(outside, "unrelated.json"), "utf8")).toBe("someone else's\n");
    expect(lstatSync(dir).isSymbolicLink()).toBe(true);

    // A real directory whose record-shaped name is a link to an outside file.
    unlinkSync(dir);
    mkdirSync(dir);
    const link = join(dir, shaped);
    symlinkSync(join(outside, shaped), link);
    expect(files(bus)).toEqual([]);
    expect(pendingPermissionRequest(bus, "scout", SEAT)).toBe(null);
    expect(pendingPermissionRequest(bus, "scout", { ...SEAT, sessionId: OTHER })).toBe(null);
    removePermissionRequest(bus, "scout");
    // A newer request neither follows the link nor removes it as an older record.
    expect(writePermissionRequest(bus, "scout", record(file, { at: WAIT_STARTED + 5000 }))).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    untouched();
    // Uninstall takes the real record, leaves the link, and so the directory, and says so by returning null.
    expect(removePermissionRequestDir(bus)).toBe(null);
    expect(readdirSync(dir)).toEqual([shaped]);
    untouched();
  } finally { removeScratchTree(root); }
});

test("a directory TAP cannot examine is not owned: cleanup paths answer quietly and never throw", () => {
  const { root, bus, sessions } = scratch();
  try {
    const file = sessionFile(sessions);
    writePermissionRequest(bus, "scout", record(file));
    const quiet = () => {
      // `tap out` and session start call the first of these outside any try of their own.
      expect(() => removePermissionRequest(bus, "scout")).not.toThrow();
      expect(() => pendingPermissionRequest(bus, "scout", SEAT)).not.toThrow();
      expect(pendingPermissionRequest(bus, "scout", SEAT)).toBe(null);
      expect(files(bus)).toEqual([]);
      expect(removePermissionRequestDir(bus)).toBe(null);
    };
    // No search permission on the bus: the directory cannot even be examined.
    chmodSync(bus, 0o000);
    try { quiet(); } finally { chmodSync(bus, 0o700); }
    expect(files(bus)).toHaveLength(1);
    // No permission on the directory itself: it is there and cannot be listed.
    chmodSync(join(bus, "permission-requests"), 0o000);
    try { quiet(); } finally { chmodSync(join(bus, "permission-requests"), 0o700); }
    expect(files(bus)).toHaveLength(1);
    // The bus path is a file, so nothing can be under it.
    const notADir = join(root, "bus-is-a-file");
    writeFileSync(notADir, "");
    expect(() => removePermissionRequest(notADir, "scout")).not.toThrow();
    expect(pendingPermissionRequest(notADir, "scout", SEAT)).toBe(null);
    expect(removePermissionRequestDir(notADir)).toBe(null);
    expect(() => writePermissionRequest(notADir, "scout", record(file))).toThrow();
  } finally { removeScratchTree(root); }
});
