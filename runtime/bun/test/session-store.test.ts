// tap-iee8 — per-harness session-store attribution (port of
// session/tests/test_session_store.py). Every case stages a FAKE HOME so the
// suite never touches the operator's real session stores (which are live) and
// stays deterministic on any machine.
import { afterEach, expect, test } from "bun:test";import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { derive, defaultProc, observeProcessStore, HARNESSES, STORE_KINDS, TRUST_LEVELS, type ProcResult } from "../src/session-store";
import { addSession, createOpenCodeStore } from "./support/opencode-store";
import { removeScratchTree } from "./support/scratch";

const WT = "/Users/dev/work/proj";
const scratch: string[] = [];
// Per-test cleanup (suite convention): each fixture is small, so the owned
// lsof-proven removal stays fast and scoped to roots this file created.
afterEach(() => { for (const p of scratch.splice(0)) removeScratchTree(p); }, 30000);

function home(): string {
  const h = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "tap-sstore.")));
  scratch.push(h);
  return h;
}

// --- fixture builders ---------------------------------------------------------

function claude(hm: string, worktree: string, names: string[]): string {
  const d = join(hm, ".claude", "projects", worktree.replaceAll("/", "-"));
  mkdirSync(d, { recursive: true });
  names.forEach((n, i) => {
    const p = join(d, `${n}.jsonl`);
    writeFileSync(p, "{}\n");
    utimesSync(p, new Date((1000 + i) * 1000), new Date((1000 + i) * 1000));
  });
  return d;
}

function codex(hm: string, entries: Array<[string, string, string, string, string, string, number]>): void {
  for (const [y, m, dd, stamp, uid, cwd, mt] of entries) {
    const d = join(hm, ".codex", "sessions", y, m, dd);
    mkdirSync(d, { recursive: true });
    const p = join(d, `rollout-${stamp}-${uid}.jsonl`);
    writeFileSync(p, `${JSON.stringify({ timestamp: stamp, type: "session_meta", payload: { id: uid, cwd } })}\n`);
    utimesSync(p, new Date(mt * 1000), new Date(mt * 1000));
  }
}

function opencode(hm: string, rows: Array<[string, string, number]>): string {
  const d = join(hm, ".local", "share", "opencode");
  mkdirSync(d, { recursive: true });
  const db = join(d, "opencode.db");
  const c = createOpenCodeStore(db);
  for (const [i, d_, t] of rows) addSession(c, i, d_, { created: t });
  c.close();
  return db;
}

function cursor(hm: string, worktree: string, chatUuids: string[]): string {
  const ws = createHash("md5").update(worktree, "utf8").digest("hex");
  const base = join(hm, ".cursor", "chats", ws);
  chatUuids.forEach((u, i) => {
    const d = join(base, u);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "store.db"), "");
    utimesSync(d, new Date((2000 + i) * 1000), new Date((2000 + i) * 1000));
  });
  return base;
}

function rolloutFiles(hm: string): string[] {
  const day = join(hm, ".codex", "sessions", "2026", "09", "05");
  return readdirSync(day).filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl")).map((f) => join(day, f)).sort();
}

// --- claude -------------------------------------------------------------------

test("claude unique transcript derives the id", () => {
  const hm = home();
  claude(hm, WT, ["11111111-1111-1111-1111-111111111111"]);
  const r = derive("claude", WT, { home: hm, env: {} });
  expect(r.trust).toBe("derived_unique");
  expect(r.harness_session_id).toBe("11111111-1111-1111-1111-111111111111");
  expect(r.store_kind).toBe("file");
  expect(r.store_path.endsWith(".jsonl")).toBe(true);
});

test("claude ambiguous returns the container, not a candidate", () => {
  const hm = home();
  const proj = claude(hm, WT, ["aaaa", "bbbb"]);
  const r = derive("claude", WT, { home: hm, env: {} });
  expect(r.trust).toBe("derived_ambiguous");
  // The whole point: no guessed id AND no guessed file — the container.
  expect(r.harness_session_id).toBe("");
  expect(r.store_kind).toBe("dir");
  expect(r.store_path).toBe(proj);
  expect(r.store_path.endsWith(".jsonl")).toBe(false);
  expect(r.candidates).toBe(2);
});

test("claude missing project dir is trust none", () => {
  const r = derive("claude", WT, { home: home(), env: {} });
  expect(r.trust).toBe("none");
  expect(r.store_path).toBe("");
});

// --- codex --------------------------------------------------------------------

test("codex matches on rollout cwd", () => {
  const hm = home();
  codex(hm, [["2026", "07", "20", "2026-07-20T10-00-00", "uuid-other", "/other/tree", 5000],
    ["2026", "07", "21", "2026-07-21T10-00-00", "uuid-mine", WT, 6000]]);
  const r = derive("codex", WT, { home: hm, env: {} });
  expect(r.trust).toBe("derived_unique");
  expect(r.harness_session_id).toBe("uuid-mine");
  expect(r.store_kind).toBe("file");
  expect(r.store_path.endsWith(".jsonl")).toBe(true);
});

test("codex historical rollout does not make current ambiguous", () => {
  // A worktree accumulates rollouts forever; an old one is not a rival seat.
  const hm = home();
  const old = 6000 - (6 * 3600 + 600);
  codex(hm, [["2026", "07", "21", "2026-07-21T10-00-00", "uuid-new", WT, 6000],
    ["2026", "07", "21", "2026-07-21T01-00-00", "uuid-old", WT, old]]);
  const r = derive("codex", WT, { home: hm, env: {} });
  expect(r.trust).toBe("derived_unique");
  expect(r.harness_session_id).toBe("uuid-new");
});

test("codex concurrent seats in one worktree are ambiguous", () => {
  const hm = home();
  codex(hm, [["2026", "07", "21", "2026-07-21T10-00-00", "uuid-a", WT, 6000],
    ["2026", "07", "21", "2026-07-21T09-30-00", "uuid-b", WT, 5900]]);
  const r = derive("codex", WT, { home: hm, env: {} });
  expect(r.trust).toBe("derived_ambiguous");
  expect(r.harness_session_id).toBe("");
  expect(r.store_kind).toBe("dir");
});

test("codex truncated rollout is skipped, not fatal", () => {
  const hm = home();
  codex(hm, [["2026", "07", "21", "2026-07-21T10-00-00", "uuid-mine", WT, 6000]]);
  const bad = join(hm, ".codex", "sessions", "2026", "07", "21", "rollout-bad-x.jsonl");
  writeFileSync(bad, "{not json\n");
  utimesSync(bad, new Date(7000 * 1000), new Date(7000 * 1000));
  const r = derive("codex", WT, { home: hm, env: {} });
  expect(r.harness_session_id).toBe("uuid-mine");
});

// --- opencode -----------------------------------------------------------------

test("opencode directory hit stays a container: the seek cannot prove uniqueness (tap-0zip2)", () => {
  const hm = home();
  const db = opencode(hm, [["sess-1", WT, 10], ["sess-2", "/other", 99]]);
  const r = derive("opencode", WT, { home: hm, env: {} });
  expect(r.trust).toBe("derived_ambiguous");
  expect(r.harness_session_id).toBe("");
  expect(r.candidates).toBe(1);
  expect(r.store_kind).toBe("db");
  expect(r.store_path).toBe(db);
});

test("opencode ambiguous keeps the db path but no id", () => {
  const hm = home();
  const db = opencode(hm, [["sess-1", WT, 10], ["sess-2", WT, 20]]);
  const r = derive("opencode", WT, { home: hm, env: {} });
  expect(r.trust).toBe("derived_ambiguous");
  expect(r.harness_session_id).toBe("");
  // A multi-session db is still THE store, so the path stays useful.
  expect(r.store_kind).toBe("db");
  expect(r.store_path).toBe(db);
});

test("opencode corrupt db never raises", () => {
  const hm = home();
  const d = join(hm, ".local", "share", "opencode");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "opencode.db"), "this is not sqlite");
  const r = derive("opencode", WT, { home: hm, env: {} });
  expect(r.trust).toBe("none");
  expect(r.detail).toContain("unreadable");
});

test("opencode store is opened read-only", () => {
  // Invariant 1: the store is LIVE; we must never be able to write through it.
  const hm = home();
  const db = opencode(hm, [["sess-1", WT, 10]]);
  const conn = new Database(db, { readonly: true });
  expect(() => conn.run("INSERT INTO session_v2 (id, directory) VALUES ('x','y')")).toThrow();
  conn.close();
});

// --- cursor -------------------------------------------------------------------

test("cursor workspace hash is md5 of the path", () => {
  const hm = home();
  cursor(hm, WT, ["chat-uuid-1"]);
  const r = derive("cursor", WT, { home: hm, env: {} });
  expect(r.trust).toBe("derived_unique");
  expect(r.harness_session_id).toBe("chat-uuid-1");
  expect(r.store_kind).toBe("file");
  expect(r.store_path.endsWith("store.db")).toBe(true);
});

test("cursor ambiguous returns the workspace dir", () => {
  const hm = home();
  const base = cursor(hm, WT, ["chat-a", "chat-b"]);
  const r = derive("cursor", WT, { home: hm, env: {} });
  expect(r.trust).toBe("derived_ambiguous");
  expect(r.harness_session_id).toBe("");
  expect(r.store_path).toBe(base);
  expect(r.store_kind).toBe("dir");
});

// --- antigravity (agy): env-volunteered id, store keyed by the id -------------

test("agy env id is tier-1 and builds the store from the id", () => {
  const r = derive("agy", "/any/worktree", { home: home(), env: { ANTIGRAVITY_CONVERSATION_ID: "conv-abc" } });
  expect(r.trust).toBe("env"); // env-volunteered id is authoritative
  expect(r.harness_session_id).toBe("conv-abc");
  expect(r.store_kind).toBe("file");
  expect(r.store_path.endsWith(join(".gemini", "antigravity-cli", "brain", "conv-abc", ".system_generated", "logs", "transcript.jsonl"))).toBe(true);
  expect(r.harness).toBe("agy"); // echoes the caller's value, not the canon
});

test("agy without env id reports none, not a guess", () => {
  const r = derive("agy", "/any/worktree", { home: home(), env: {} });
  expect(r.trust).toBe("none");
  expect(r.harness_session_id).toBe("");
  expect(r.detail).toContain("ANTIGRAVITY_CONVERSATION_ID");
  expect(r.harness).toBe("agy");
});

test("agy generic launcher var is also honored", () => {
  // A launcher-launched agy seat may carry the generic TAP var instead of the native one.
  const r = derive("antigravity", "/wt", { home: home(), env: { TAP_HARNESS_SESSION_ID: "conv-xyz" } });
  expect(r.trust).toBe("env");
  expect(r.harness_session_id).toBe("conv-xyz");
  expect(r.store_path.endsWith(join("brain", "conv-xyz", ".system_generated", "logs", "transcript.jsonl"))).toBe(true);
});

test("env transcript wins without scanning the filesystem", () => {
  // A provided transcript IS the store path verbatim — a bogus worktree that
  // would fail any scan must not change the answer.
  const r = derive("codex", "/nonexistent/worktree", { home: home(), env: { TAP_HARNESS_SESSION_ID: "e", TAP_TRANSCRIPT_PATH: "/t/x.jsonl" } });
  expect(r.trust).toBe("env");
  expect(r.store_path).toBe("/t/x.jsonl");
  expect(r.store_kind).toBe("file");
});

// --- cross-cutting contract ---------------------------------------------------

test("env capture outranks derivation and is the only authoritative tier with it", () => {
  const hm = home();
  claude(hm, WT, ["derived-uuid"]);
  const r = derive("claude", WT, { home: hm, env: { TAP_HARNESS_SESSION_ID: "env-uuid", TAP_TRANSCRIPT_PATH: "/tmp/env.jsonl" } });
  expect(r.trust).toBe("env");
  expect(r.harness_session_id).toBe("env-uuid");
  expect(r.store_path).toBe("/tmp/env.jsonl");
});

test("env id without transcript still gets a derived store path", () => {
  const hm = home();
  claude(hm, WT, ["derived-uuid"]);
  const r = derive("claude", WT, { home: hm, env: { TAP_HARNESS_SESSION_ID: "env-uuid" } });
  expect(r.trust).toBe("env");
  expect(r.harness_session_id).toBe("env-uuid");
  expect(r.store_path.endsWith("derived-uuid.jsonl")).toBe(true);
});

for (const harness of HARNESSES) {
  test(`derived trust is never env for any harness (${harness})`, () => {
    // The ratified invariant: nothing inferred may claim tier-1 authority.
    const hm = home();
    claude(hm, WT, ["a"]);
    codex(hm, [["2026", "07", "21", "s", "u", WT, 1]]);
    opencode(hm, [["s", WT, 1]]);
    cursor(hm, WT, ["c"]);
    const r = derive(harness, WT, { home: hm, env: {} });
    expect(["derived_unique", "derived_ambiguous", "none"]).toContain(r.trust);
    expect(r.trust).not.toBe("env");
  });
}

test("unknown harness is not an error", () => {
  const r = derive("hermes", WT, { home: home(), env: {} });
  expect(r.trust).toBe("none");
  expect(r.detail).toContain("no mapped session store");
});

test("unknown harness still honors env capture", () => {
  const r = derive("hermes", WT, { home: home(), env: { TAP_HARNESS_SESSION_ID: "e" } });
  expect(r.trust).toBe("env");
  expect(r.harness_session_id).toBe("e");
});

test("every result carries the full shape and a timestamp", () => {
  const r = derive("claude", WT, { home: home(), env: {}, clock: "2026-07-22T09:00:00Z" });
  expect(Object.keys(r).sort()).toEqual(["candidates", "derived_at", "detail", "harness", "harness_session_id", "store_kind", "store_path", "trust"]);
  expect(r.derived_at).toBe("2026-07-22T09:00:00Z");
  expect(TRUST_LEVELS).toContain(r.trust);
  expect(STORE_KINDS as readonly string[]).toContain(r.store_kind);
});

test("missing worktree never raises", () => {
  for (const wt of ["", undefined]) {
    const r = derive("claude", wt, { home: home(), env: {} });
    expect(r.trust).toBe("none");
  }
});

// --- process-held tier (injected ps/lsof) --------------------------------------

for (const held of [0, 1]) {
  test(`process rollout beats ambiguous cwd (held=${held})`, () => {
    const hm = home();
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    codex(hm, ids.map((sid, i) => ["2026", "09", "05", "2026-09-05T01-00-00", sid, WT, 1000 + i] as [string, string, string, string, string, string, number]));
    const files = rolloutFiles(hm);
    const run = (argv: string[]): ProcResult => {
      if (argv[0] === "ps") {
        return { status: 0, stdout: "100 1 Fri Sep  5 01:00:00 2026 /bin/zsh\n101 100 Fri Sep  5 01:00:01 2026 /bin/codex\n", stderr: "" };
      }
      expect(argv.slice(0, 4)).toEqual(["lsof", "-a", "-p", "101"]);
      return { status: 0, stdout: `p101\nfcwd\nn${WT}\nn${files[held]!}\n`, stderr: "" };
    };
    const result = derive("codex", WT, { home: hm, env: {}, panePid: 100, run });
    expect(result.trust).toBe("process");
    expect(result.harness_session_id).toBe(ids[held]!);
    expect(result.store_path).toBe(files[held]!);
  });
}

test("process rollout ambiguity is not authority", () => {
  const hm = home();
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  codex(hm, ids.map((sid) => ["2026", "09", "05", "2026-09-05T01-00-00", sid, WT, 1000] as [string, string, string, string, string, string, number]));
  const run = (argv: string[]): ProcResult => {
    const out = argv[0] === "ps"
      ? "100 1 Fri Sep  5 01:00:00 2026 /bin/codex\n"
      : "p100\nfcwd\nn" + WT + "\n" + rolloutFiles(hm).map((p) => `n${p}\n`).join("");
    return { status: 0, stdout: out, stderr: "" };
  };
  const result = derive("codex", WT, { home: hm, env: {}, panePid: 100, run });
  expect(result.trust).not.toBe("process");
  expect(result.harness_session_id).toBe("");
});

for (const failure of ["timeout", "reused_pid", "foreign_process", "two_harnesses", "wrong_cwd"] as const) {
  test(`process observation refuses uncertainty (${failure})`, () => {
    const hm = home();
    const sid = "11111111-1111-4111-8111-111111111111";
    codex(hm, [["2026", "09", "05", "2026-09-05T01-00-00", sid, WT, 1000]]);
    const path = rolloutFiles(hm)[0]!;
    let calls = 0;
    const run = (argv: string[]): ProcResult => {
      if (failure === "timeout") throw new Error("timeout");
      if (argv[0] === "ps") {
        calls += 1;
        const command = failure === "foreign_process" ? "other" : "codex";
        const second = failure === "reused_pid" && calls === 2 ? 2 : 1;
        // two_harnesses stages SIBLINGS: two codex processes side by side under
        // the pane root both stay topmost candidates and refuse. (A nested
        // harness-named child is the resolvable case, covered below.)
        let out = failure === "two_harnesses"
          ? "100 1 Fri Sep 5 01:00:01 2026 /bin/zsh\n101 100 Fri Sep 5 01:00:00 2026 /bin/codex\n102 100 Fri Sep 5 01:00:00 2026 /bin/codex\n"
          : `100 1 Fri Sep 5 01:00:0${second} 2026 /bin/${command}\n`;
        return { status: 0, stdout: out, stderr: "" };
      }
      return { status: 0, stdout: `p100\nfcwd\nn${WT}\nn${path}\n`, stderr: "" };
    };
    const result = derive("codex", failure === "wrong_cwd" ? "/other" : WT, { home: hm, env: {}, panePid: 100, run });
    expect(result.trust).not.toBe("process");
  });
}

test("claude process-held project transcript", () => {
  const hm = home();
  const sid = "11111111-1111-4111-8111-111111111111";
  const project = claude(hm, WT, [sid, "22222222-2222-4222-8222-222222222222"]);
  const run = (argv: string[]): ProcResult => {
    const out = argv[0] === "ps"
      ? "100 1 Fri Sep 5 01:00:00 2026 /bin/claude\n"
      : `p100\nfcwd\nn${WT}\nn${join(project, `${sid}.jsonl`)}\n`;
    return { status: 0, stdout: out, stderr: "" };
  };
  const result = derive("claude", WT, { home: hm, env: {}, panePid: 100, run });
  expect(result.trust).toBe("process");
  expect(result.harness_session_id).toBe(sid);
});

test("default runner bounds a hung observation to two seconds", () => {
  const started = Date.now();
  const r = defaultProc(["sh", "-c", "sleep 5"]);
  const elapsed = Date.now() - started;
  expect(r.timedOut).toBe(true);
  expect(elapsed).toBeLessThan(4000);
});

test("a timed-out observation degrades to no authority, not a hang or crash", () => {
  const hm = home();
  const sid = "11111111-1111-4111-8111-111111111111";
  codex(hm, [["2026", "09", "05", "2026-09-05T01-00-00", sid, WT, 1000]]);
  const run = (argv: string[]): ProcResult =>
    argv[0] === "ps"
      ? { status: null, stdout: "", stderr: "", timedOut: true }
      : { status: 0, stdout: "", stderr: "" };
  const started = Date.now();
  const result = derive("codex", WT, { home: hm, env: {}, panePid: 100, run });
  expect(Date.now() - started).toBeLessThan(2000);
  // No authority from the process tier; the bounded tier-2 scan still answers.
  expect(result.trust).toBe("derived_unique");
});

// --- CLI door (the transport register consumes) --------------------------------

test("CLI door emits the JSON result and never crashes on refusal cases", async () => {
  const hm = home();
  claude(hm, WT, ["11111111-1111-1111-1111-111111111111"]);
  const entry = join(import.meta.dir, "../src/session-store.ts");
  const r = Bun.spawnSync([process.execPath, entry, "derive", "--harness", "claude", "--worktree", WT, "--home", hm],
    { env: { ...process.env, TAP_HARNESS_SESSION_ID: "", TAP_TRANSCRIPT_PATH: "" }, stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode).toBe(0);
  const parsed = JSON.parse(r.stdout.toString()) as Record<string, unknown>;
  expect(parsed).toMatchObject({ trust: "derived_unique", harness: "claude", store_kind: "file" });
  const unknown = Bun.spawnSync([process.execPath, entry, "derive", "--harness", "hermes", "--worktree", WT, "--home", hm],
    { env: { ...process.env, TAP_HARNESS_SESSION_ID: "", TAP_TRANSCRIPT_PATH: "" }, stdout: "pipe", stderr: "pipe" });
  expect(unknown.exitCode).toBe(0);
  expect((JSON.parse(unknown.stdout.toString()) as Record<string, unknown>).trust).toBe("none");
});

test("Claude idle PID record follows clear and refuses PID reuse", () => {
  const hm = home(), sid = "11111111-1111-4111-8111-111111111111";
  claude(hm, WT, [sid]);
  const dir = join(hm, ".claude", "sessions");
  mkdirSync(dir, {recursive:true});
  const record = {pid:101,sessionId:sid,cwd:WT,procStart:"Fri Sep 5 01:00:01 2026",kind:"interactive"};
  writeFileSync(join(dir,"101.json"), JSON.stringify(record));
  const run = (args: string[]): ProcResult => ({status:0,stderr:"",stdout:args[0] === "ps"
    ? "100 1 Fri Sep 5 01:00:00 2026 /bin/zsh\n101 100 Fri Sep 5 01:00:01 2026 /bin/claude\n" : ""});
  const actual = derive("claude", WT, {home:hm,env:{},panePid:100,run});
  expect(actual).toMatchObject({trust:"process",harness_session_id:sid});
  expect(actual.detail).toContain("live session record");
  writeFileSync(join(dir,"101.json"), JSON.stringify({...record,procStart:"Fri Sep 4 01:00:01 2026"}));
  expect(derive("claude", WT, {home:hm,env:{},panePid:100,run}).trust).not.toBe("process");
});

test.each(["codex", "claude"])("short-lived tool descendants do not invalidate the stable %s pane harness", harness => {
  const hm = home(), sid = "11111111-1111-4111-8111-111111111111";
  let path: string;
  if (harness === "codex") {
    codex(hm, [["2026", "09", "05", "2026-09-05T01-00-00", sid, WT, 1000]]);
    path = rolloutFiles(hm)[0]!;
  } else {
    path = join(claude(hm, WT, [sid]), `${sid}.jsonl`);
    const sessions = join(hm,".claude/sessions"); mkdirSync(sessions,{recursive:true});
    writeFileSync(join(sessions,"101.json"),JSON.stringify({pid:101,sessionId:sid,cwd:WT,procStart:"Fri Sep 5 01:00:01 2026",kind:"interactive"}));
  }
  let snapshots = 0;
  const run = (args: string[]): ProcResult => ({status:0,stderr:"",stdout:args[0] === "ps"
    ? `100 1 Fri Sep  5 01:00:00 2026 /bin/zsh\n101 100 Fri Sep  5 01:00:01 2026 /bin/${harness}\n` +
      (++snapshots === 1 ? "102 101 Fri Sep  5 01:00:02 2026 /bin/ps\n" : "")
    : `p101\nfcwd\nn${WT}\nn${path}\n`});
  expect(derive(harness, WT, {home:hm,env:{},panePid:100,run})).toMatchObject({trust:"process",harness_session_id:sid});
});

// --- discuss-2026-09-25-doctor-ambiguous: owner structure, fcwd, lazy transcript ---

test("nested harness-named tool child resolves to the topmost owner", () => {
  const hm = home();
  const sid = "11111111-1111-4111-8111-111111111111";
  codex(hm, [["2026", "09", "05", "2026-09-05T01-00-00", sid, WT, 1000]]);
  const path = rolloutFiles(hm)[0]!;
  const run = (argv: string[]): ProcResult => ({status:0,stderr:"",stdout:argv[0] === "ps"
    // 102 is a tool grandchild also named codex (a working seat spawns these);
    // its ancestry passes through 101, so 101 is the pane's harness.
    ? "100 1 Fri Sep  5 01:00:00 2026 /bin/zsh\n101 100 Fri Sep  5 01:00:01 2026 /bin/codex\n102 101 Fri Sep  5 01:00:02 2026 /usr/local/bin/codex\n"
    : `p101\nfcwd\nn${WT}\nn${path}\n`});
  expect(derive("codex", WT, {home:hm,env:{},panePid:100,run})).toMatchObject({trust:"process",harness_session_id:sid});
});

test("pane root as the harness shadows nested harness-named descendants", () => {
  const hm = home();
  const sid = "11111111-1111-4111-8111-111111111111";
  codex(hm, [["2026", "09", "05", "2026-09-05T01-00-00", sid, WT, 1000]]);
  const path = rolloutFiles(hm)[0]!;
  const run = (argv: string[]): ProcResult => ({status:0,stderr:"",stdout:argv[0] === "ps"
    // The launcher runs the harness AS the pane process: root 100 is codex and
    // 102 is a nested tool child also named codex; the root must own (B1).
    ? "100 1 Fri Sep  5 01:00:00 2026 /bin/codex\n101 100 Fri Sep  5 01:00:01 2026 node_repl\n102 101 Fri Sep  5 01:00:02 2026 /usr/local/bin/codex\n"
    : `p100\nfcwd\nn${WT}\nn${path}\n`});
  const observed = observeProcessStore(run, "codex", WT, hm, "100");
  expect(observed.identity).toMatchObject({trust:"process",harness_session_id:sid});
  expect(observed.identity?.detail).toBe("open session file held by pane process 100");
  expect(observed.refusal).toBe("");
});

test("sibling harness processes refuse with owners_ambiguous", () => {
  const hm = home(), sid = "11111111-1111-4111-8111-111111111111";
  codex(hm, [["2026", "09", "05", "2026-09-05T01-00-00", sid, WT, 1000]]);
  const path = rolloutFiles(hm)[0]!;
  const run = (argv: string[]): ProcResult => ({status:0,stderr:"",stdout:argv[0] === "ps"
    ? "100 1 Fri Sep  5 01:00:00 2026 /bin/zsh\n101 100 Fri Sep  5 01:00:01 2026 /bin/codex\n102 100 Fri Sep  5 01:00:01 2026 /bin/codex\n"
    : `p101\nfcwd\nn${WT}\nn${path}\n`});
  const observed = observeProcessStore(run, "codex", WT, hm, "100");
  expect(observed.identity).toBeNull();
  expect(observed.refusal).toBe("owners_ambiguous");
});

test("fcwd cross-check resolves a symlinked worktree", () => {
  const hm = home();
  const real = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "tap-sstore.")));
  scratch.push(real);
  const link = `${real}-alias`;
  symlinkSync(real, link);
  const sid = "12121212-1212-4121-8121-121212121212";
  codex(hm, [["2026", "09", "05", "2026-09-05T01-00-00", sid, link, 1000]]);
  const path = rolloutFiles(hm)[0]!;
  const run = (argv: string[]): ProcResult => ({status:0,stderr:"",stdout:argv[0] === "ps"
    ? "100 1 Fri Sep  5 01:00:00 2026 /bin/zsh\n101 100 Fri Sep  5 01:00:01 2026 /bin/codex\n"
    // lsof reports the RESOLVED path while the caller named the symlink.
    : `p101\nfcwd\nn${real}\nn${path}\n`});
  const observed = observeProcessStore(run, "codex", link, hm, "100");
  expect(observed.identity?.harness_session_id).toBe(sid);
  expect(observed.refusal).toBe("");
});

for (const arm of ["absent", "mismatch", "equal"] as const) {
  test(`fcwd cross-check ${arm} arm`, () => {
    const hm = home(), sid = "11111111-1111-4111-8111-111111111111";
    codex(hm, [["2026", "09", "05", "2026-09-05T01-00-00", sid, WT, 1000]]);
    const path = rolloutFiles(hm)[0]!;
    const fcwdLine = arm === "absent" ? "" : `fcwd\nn${arm === "equal" ? WT : "/somewhere/else"}\n`;
    const run = (argv: string[]): ProcResult => ({status:0,stderr:"",stdout:argv[0] === "ps"
      ? "100 1 Fri Sep  5 01:00:00 2026 /bin/zsh\n101 100 Fri Sep  5 01:00:01 2026 /bin/codex\n"
      : `p101\n${fcwdLine}n${path}\n`});
    const observed = observeProcessStore(run, "codex", WT, hm, "100");
    if (arm === "equal") {
      expect(observed.identity?.harness_session_id).toBe(sid);
      expect(observed.refusal).toBe("");
    } else {
      expect(observed.identity).toBeNull();
      expect(observed.refusal).toBe(arm === "absent" ? "fcwd_unavailable" : "fcwd_mismatch");
    }
  });
}

// Linux lsof 4.95 prints only the fields it is asked for: under `-Fn` the
// descriptor rows (`fcwd`, `frtd`, `ftxt`, `f3`...) are absent, so the cwd
// cross-check had nothing to read. macOS lsof volunteers `fcwd` under `-Fn`.
// The fake answers in each platform's shape (captured on Ubuntu 24.04 and
// macOS) for whatever field list the observer requests, so the binding must
// hold on both and must still refuse when the cwd row is missing. Under the
// requested `-Ffn` the two shapes are byte-identical; that agreement is the fix.
function lsofAs(platform: "linux" | "darwin", argv: string[], cwd: string, held: string): string {
  const fields = argv.find((a) => a.startsWith("-F"))?.slice(2) ?? "";
  const withF = fields.includes("f") || platform === "darwin";
  const rows: [string, string][] = [["cwd", cwd], ["rtd", "/"], ["txt", "/usr/bin/codex"], ["mem", "/usr/lib/libc.so.6"], ["3", held]];
  return "p101\n" + rows.map(([fd, n]) => (withF ? `f${fd}\n` : "") + `n${n}\n`).join("");
}

for (const platform of ["linux", "darwin"] as const) {
  test(`process tier binds a ${platform}-shaped lsof answer`, () => {
    const hm = home(), sid = "11111111-1111-4111-8111-111111111111";
    codex(hm, [["2026", "09", "05", "2026-09-05T01-00-00", sid, WT, 1000]]);
    const path = rolloutFiles(hm)[0]!;
    const seen: string[][] = [];
    const run = (argv: string[]): ProcResult => {
      if (argv[0] === "ps") return {status:0,stderr:"",stdout:"100 1 Fri Sep  5 01:00:00 2026 /bin/zsh\n101 100 Fri Sep  5 01:00:01 2026 /bin/codex\n"};
      seen.push(argv);
      return {status:0,stderr:"",stdout:lsofAs(platform, argv, WT, path)};
    };
    const observed = observeProcessStore(run, "codex", WT, hm, "100");
    expect(seen).toEqual([["lsof", "-a", "-p", "101", "-Ffn"]]);
    expect(observed.refusal).toBe("");
    expect(observed.identity?.harness_session_id).toBe(sid);
  });
}

test("a Linux -Fn shaped answer (no descriptor rows) still refuses as fcwd_unavailable", () => {
  const hm = home(), sid = "11111111-1111-4111-8111-111111111111";
  codex(hm, [["2026", "09", "05", "2026-09-05T01-00-00", sid, WT, 1000]]);
  const path = rolloutFiles(hm)[0]!;
  const run = (argv: string[]): ProcResult => ({status:0,stderr:"",stdout:argv[0] === "ps"
    ? "100 1 Fri Sep  5 01:00:00 2026 /bin/zsh\n101 100 Fri Sep  5 01:00:01 2026 /bin/codex\n"
    : `p101\nn${WT}\nn/\nn/usr/bin/codex\nn${path}\n`});
  const observed = observeProcessStore(run, "codex", WT, hm, "100");
  expect(observed.identity).toBeNull();
  expect(observed.refusal).toBe("fcwd_unavailable");
});

function subagentSource(parent: string) {
  return { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: "/root/x", agent_nickname: "Dalton", agent_role: null } } };
}

function codexMeta(hm: string, stamp: string, uid: string, cwd: string, source: unknown): string {
  const dir = join(hm, ".codex", "sessions", "2026", "09", "05");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-${stamp}-${uid}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ timestamp: stamp, type: "session_meta", payload: { id: uid, cwd, source } })}\n`);
  return path;
}

test("one Codex CLI rollout plus same-cwd subagent rollouts is that CLI session", () => {
  const hm = home();
  const cli = "11111111-1111-4111-8111-111111111111";
  const subA = "22222222-2222-4222-8222-222222222222";
  const subB = "33333333-3333-4333-8333-333333333333";
  const cliPath = codexMeta(hm, "2026-09-05T01-00-00", cli, WT, "cli");
  const subPathA = codexMeta(hm, "2026-09-05T01-00-01", subA, WT, subagentSource(cli));
  const subPathB = codexMeta(hm, "2026-09-05T01-00-02", subB, WT, subagentSource(cli));
  const run = (argv: string[]): ProcResult => ({ status: 0, stderr: "", stdout: argv[0] === "ps"
    ? "100 1 Fri Sep  5 01:00:00 2026 /bin/zsh\n101 100 Fri Sep  5 01:00:01 2026 /bin/codex\n"
    : `p101\nfcwd\nn${WT}\nn${cliPath}\nn${subPathA}\nn${subPathB}\n` });
  const observed = observeProcessStore(run, "codex", WT, hm, "100");
  expect(observed.identity).toMatchObject({ trust: "process", harness_session_id: cli, store_path: cliPath });
  expect(observed.refusal).toBe("");
});

test("two Codex CLI or TUI rollouts in one cwd stay ambiguous", () => {
  const hm = home();
  const cli = "11111111-1111-4111-8111-111111111111";
  const tui = "44444444-4444-4444-8444-444444444444";
  const cliPath = codexMeta(hm, "2026-09-05T01-00-00", cli, WT, "cli");
  const tuiPath = codexMeta(hm, "2026-09-05T01-00-01", tui, WT, "tui");
  const run = (argv: string[]): ProcResult => ({ status: 0, stderr: "", stdout: argv[0] === "ps"
    ? "100 1 Fri Sep  5 01:00:00 2026 /bin/zsh\n101 100 Fri Sep  5 01:00:01 2026 /bin/codex\n"
    : `p101\nfcwd\nn${WT}\nn${cliPath}\nn${tuiPath}\n` });
  const observed = observeProcessStore(run, "codex", WT, hm, "100");
  expect(observed.identity).toBeNull();
  expect(observed.refusal).toBe("owners_ambiguous_session_files");
});

test("two CLI rollouts stay ambiguous when a subagent rollout is also open", () => {
  const hm = home();
  const cliA = "11111111-1111-4111-8111-111111111111";
  const cliB = "55555555-5555-4555-8555-555555555555";
  const sub = "66666666-6666-4666-8666-666666666666";
  const pathA = codexMeta(hm, "2026-09-05T01-00-00", cliA, WT, "cli");
  const pathB = codexMeta(hm, "2026-09-05T01-00-01", cliB, WT, "cli");
  const subPath = codexMeta(hm, "2026-09-05T01-00-02", sub, WT, subagentSource(cliA));
  const run = (argv: string[]): ProcResult => ({ status: 0, stderr: "", stdout: argv[0] === "ps"
    ? "100 1 Fri Sep  5 01:00:00 2026 /bin/zsh\n101 100 Fri Sep  5 01:00:01 2026 /bin/codex\n"
    : `p101\nfcwd\nn${WT}\nn${pathA}\nn${pathB}\nn${subPath}\n` });
  const observed = observeProcessStore(run, "codex", WT, hm, "100");
  expect(observed.identity).toBeNull();
  expect(observed.refusal).toBe("owners_ambiguous_session_files");
});

test("a rollout with no source stays a candidate", () => {
  const hm = home();
  const cli = "11111111-1111-4111-8111-111111111111";
  const other = "88888888-8888-4888-8888-888888888888";
  const cliPath = codexMeta(hm, "2026-09-05T01-00-00", cli, WT, "cli");
  const otherPath = codexMeta(hm, "2026-09-05T01-00-01", other, WT, undefined);
  const run = (argv: string[]): ProcResult => ({ status: 0, stderr: "", stdout: argv[0] === "ps"
    ? "100 1 Fri Sep  5 01:00:00 2026 /bin/zsh\n101 100 Fri Sep  5 01:00:01 2026 /bin/codex\n"
    : `p101\nfcwd\nn${WT}\nn${cliPath}\nn${otherPath}\n` });
  const observed = observeProcessStore(run, "codex", WT, hm, "100");
  expect(observed.identity).toBeNull();
  expect(observed.refusal).toBe("owners_ambiguous_session_files");
});

test("a source object without a subagent key stays a candidate", () => {
  const hm = home();
  const cli = "11111111-1111-4111-8111-111111111111";
  const other = "77777777-7777-4777-8777-777777777777";
  const cliPath = codexMeta(hm, "2026-09-05T01-00-00", cli, WT, "cli");
  const otherPath = codexMeta(hm, "2026-09-05T01-00-01", other, WT, { origin: "unknown" });
  const run = (argv: string[]): ProcResult => ({ status: 0, stderr: "", stdout: argv[0] === "ps"
    ? "100 1 Fri Sep  5 01:00:00 2026 /bin/zsh\n101 100 Fri Sep  5 01:00:01 2026 /bin/codex\n"
    : `p101\nfcwd\nn${WT}\nn${cliPath}\nn${otherPath}\n` });
  const observed = observeProcessStore(run, "codex", WT, hm, "100");
  expect(observed.identity).toBeNull();
  expect(observed.refusal).toBe("owners_ambiguous_session_files");
});

test("claude live record binds without a transcript file (lazy creation)", () => {
  const hm = home(), sid = "11111111-1111-4111-8111-111111111111";
  // Project dir exists (other sessions' transcripts) but THIS session's jsonl
  // has not been created yet — the manifest is the authority, not the file.
  claude(hm, WT, ["99999999-9999-4999-8999-999999999999"]);
  const dir = join(hm, ".claude", "sessions");
  mkdirSync(dir, {recursive:true});
  writeFileSync(join(dir, "101.json"), JSON.stringify({pid:101,sessionId:sid,cwd:WT,procStart:"Fri Sep  5 01:00:01 2026",kind:"interactive"}));
  const run = (argv: string[]): ProcResult => ({status:0,stderr:"",stdout:argv[0] === "ps"
    ? "100 1 Fri Sep  5 01:00:00 2026 /bin/zsh\n101 100 Fri Sep  5 01:00:01 2026 /bin/claude\n"
    : ""});
  const observed = observeProcessStore(run, "claude", WT, hm, "100");
  expect(observed.identity).toMatchObject({trust:"process",harness_session_id:sid});
  expect(observed.identity?.store_path).toBe(join(hm, ".claude", "projects", WT.replaceAll("/", "-"), `${sid}.jsonl`));
  expect(observed.refusal).toBe("");
});

test("process-bound Codex verification can use the exact child's custom store", () => {
  const hm = home(), custom = home(), sid = "11111111-1111-4111-8111-111111111111";
  codex(custom, [["2026", "09", "05", "2026-09-05T01-00-00", sid, WT, 1000]]);
  const path = rolloutFiles(custom)[0]!;
  const run = (argv: string[]): ProcResult => ({ status: 0, stderr: "", stdout: argv[0] === "ps"
    ? "100 1 Fri Sep  5 01:00:00 2026 /bin/zsh\n101 100 Fri Sep  5 01:00:01 2026 /bin/codex\n"
    : `p101\nfcwd\nn${WT}\nn${path}\n` });
  expect(observeProcessStore(run, "codex", WT, hm, "100").identity).toBeNull();
  expect(observeProcessStore(run, "codex", WT, hm, "100", { CODEX_HOME: join(custom, ".codex") }).identity?.harness_session_id).toBe(sid);
});
