// The OpenCode arm of the resume-identity gate (tap-dt6kf). OpenCode 2.1.2
// starts an empty session for a `--session` id its store lacks, so a resume
// whose captured id is provably gone from a readable store refuses with
// no_exact_resume_identity. The row is never touched and no other id is
// nominated; a store that cannot answer fails open to today's launch.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { opencodeStorePath, opencodeStoredSession } from "../src/opencode-store";
import { idlessFreshWarning } from "../src/launcher/resume-identity";
import { resumeIdentityBinding, TransactionError, type LaunchRecord } from "../src/launcher/transaction";
import { UNBOUND_RESUME_IDENTITY } from "../src/launcher/types";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "tap-opencode-store-"));
  roots.push(root);
  return root;
}

const STORED = "ses_f01a79c25ffef1g3lh8VcPxzUm";
const OTHER = "ses_f01ab57bfffeGl4o5oe4vUKwbz";
const RESUME_KINDS = ["resume", "resume-all", "restart", "seat-up"] as const;

/** A WAL store shaped like OpenCode's: a `session_v2` table keyed by id. */
function plantStore(path: string, ids: string[]): string {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL)");
  for (const id of ids) db.query("INSERT INTO session_v2 (id, directory) VALUES (?, '/tmp/wt')").run(id);
  db.close();
  return path;
}

/** Bytes and mtime of the store and each journal file (null when absent). */
function snapshot(path: string): string {
  return JSON.stringify(["", "-wal", "-shm", "-journal"].map(suffix => {
    const file = path + suffix;
    if (!existsSync(file)) return null;
    return suffix === "-shm" ? { shm: true } : { bytes: readFileSync(file).toString("base64"), mtime: statSync(file).mtimeMs };
  }));
}

/** A store path in OpenCode's layout under a fresh data root. */
function storeAt(): string {
  return join(scratch(), "opencode", "opencode.db");
}

/** The env whose OpenCode child opens `path`: XDG_DATA_HOME is its data root. */
function storeEnv(path: string): NodeJS.ProcessEnv {
  return { HOME: "/nonexistent-home", XDG_DATA_HOME: dirname(dirname(path)) };
}

function record(over: Partial<LaunchRecord> = {}): LaunchRecord {
  return { name: "fixture/oc", harness: "opencode", cwd: "/tmp/wt", base: "fixture", tag: "oc", harness_session_id: STORED, ...over };
}

function refusal(kind: (typeof RESUME_KINDS)[number], rec: LaunchRecord, env: NodeJS.ProcessEnv): TransactionError | null {
  try { resumeIdentityBinding(kind, rec, env); } catch (error) { return error as TransactionError; }
  return null;
}

// ---- the shared store resolver ----

test("the store resolver honors the TAP pin, then XDG_DATA_HOME, then HOME, then the user's home", () => {
  expect(opencodeStorePath({ OPENCODE_DB_PATH: "/pin/oc.db", XDG_DATA_HOME: "/xdg", HOME: "/h" })).toBe("/pin/oc.db");
  expect(opencodeStorePath({ XDG_DATA_HOME: "/xdg", HOME: "/h" })).toBe("/xdg/opencode/opencode.db");
  expect(opencodeStorePath({ HOME: "/h" })).toBe("/h/.local/share/opencode/opencode.db");
  expect(opencodeStorePath({})).toBe(join(homedir(), ".local/share/opencode/opencode.db"));
});

// ---- the matrix: one row per cell ----

test("readable store without the stored id: every resume-family kind refuses and the row is untouched", () => {
  const path = plantStore(storeAt(), [OTHER]);
  const env = storeEnv(path);
  for (const kind of RESUME_KINDS) {
    const rec = record();
    const before = JSON.stringify(rec);
    const error = refusal(kind, rec, env);
    expect(error).toBeInstanceOf(TransactionError);
    expect(error!.tapErrorClass).toBe("no_exact_resume_identity");
    expect(error!.tapAction).toBe("tap session launch opencode oc --fresh");
    expect(error!.message).toContain(`stored session id ${STORED}`);
    expect(error!.message).toContain(path);
    // No withdrawal, quarantine or promotion of the id the store does hold.
    expect(JSON.stringify(rec)).toBe(before);
    expect(error!.message).not.toContain(OTHER);
  }
});

test("readable store with the stored id: resume proceeds with the record-owned id", () => {
  const env = storeEnv(plantStore(storeAt(), [STORED]));
  expect(resumeIdentityBinding("resume", record(), env)).toBe(UNBOUND_RESUME_IDENTITY);
  expect(resumeIdentityBinding("resume-all", record(), env)).toBe(UNBOUND_RESUME_IDENTITY);
  expect(resumeIdentityBinding("restart", record(), env)).toBe(UNBOUND_RESUME_IDENTITY);
  expect(resumeIdentityBinding("seat-up", record(), env)).toBe(STORED);
});

test("missing store file: resume proceeds and the file is never created", () => {
  const path = join(scratch(), "absent", "opencode", "opencode.db");
  for (const kind of RESUME_KINDS) expect(refusal(kind, record(), storeEnv(path))).toBeNull();
  expect(opencodeStoredSession(STORED, storeEnv(path))).toBe("unknown");
  expect(existsSync(dirname(path))).toBe(false);
});

test("a pinned store path that is missing proceeds even while the HOME store holds the id", () => {
  const home = scratch();
  plantStore(join(home, ".local/share/opencode/opencode.db"), [STORED]);
  const env = { HOME: home, OPENCODE_DB_PATH: join(scratch(), "missing.db") };
  for (const kind of RESUME_KINDS) expect(refusal(kind, record(), env)).toBeNull();
});

test("corrupt store or no session table: resume proceeds (unknown, never absent)", () => {
  const corrupt = storeAt();
  mkdirSync(dirname(corrupt), { recursive: true });
  writeFileSync(corrupt, "not a sqlite database at all, just bytes".repeat(64));
  const noTable = storeAt();
  mkdirSync(dirname(noTable), { recursive: true });
  const db = new Database(noTable, { create: true });
  db.exec("CREATE TABLE message (id TEXT)");
  db.close();
  for (const path of [corrupt, noTable]) {
    expect(opencodeStoredSession(STORED, storeEnv(path))).toBe("unknown");
    for (const kind of RESUME_KINDS) expect(refusal(kind, record(), storeEnv(path))).toBeNull();
  }
});

test("locked store: the short busy timeout yields unknown and resume proceeds", () => {
  const path = storeAt();
  mkdirSync(dirname(path), { recursive: true });
  const writer = new Database(path, { create: true });
  writer.exec("PRAGMA journal_mode = DELETE; CREATE TABLE session_v2 (id TEXT PRIMARY KEY); BEGIN EXCLUSIVE; INSERT INTO session_v2 VALUES ('x')");
  try {
    expect(opencodeStoredSession(STORED, storeEnv(path))).toBe("unknown");
    expect(refusal("resume", record(), storeEnv(path))).toBeNull();
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
});

test("id-less row: no store read refuses it and the fresh-start warning is unchanged", () => {
  const env = storeEnv(plantStore(storeAt(), [OTHER]));
  const idless = record({ harness_session_id: null });
  for (const kind of RESUME_KINDS) expect(refusal(kind, idless, env)).toBeNull();
  expect(idlessFreshWarning(idless)).toBe("tap session: WARNING: fixture/oc has no native OpenCode session id; starting a fresh conversation");
});

test("a new launch is not a resume: the gate does not read the store", () => {
  const env = storeEnv(plantStore(storeAt(), [OTHER]));
  expect(resumeIdentityBinding("new", record(), env)).toBe(UNBOUND_RESUME_IDENTITY);
});

// ---- read-only proof ----

test("the store check leaves the store and its journals byte-for-byte unchanged (present and absent arms)", () => {
  const path = plantStore(storeAt(), [STORED]);
  const before = snapshot(path);
  expect(opencodeStoredSession(STORED, storeEnv(path))).toBe("present");
  expect(opencodeStoredSession(OTHER, storeEnv(path))).toBe("absent");
  expect(snapshot(path)).toBe(before);
});

test("the unreadable arm creates no journal: a WAL store without -wal/-shm stays without them", () => {
  const path = plantStore(storeAt(), [STORED]);
  for (const suffix of ["-wal", "-shm"]) if (existsSync(path + suffix)) unlinkSync(path + suffix);
  const before = snapshot(path);
  // A read-only connection cannot build the WAL index, so the check cannot
  // answer; it reports unknown rather than creating -shm to find out.
  expect(opencodeStoredSession(STORED, storeEnv(path))).toBe("unknown");
  expect(refusal("resume", record({ harness_session_id: OTHER }), storeEnv(path))).toBeNull();
  expect(snapshot(path)).toBe(before);
  expect(existsSync(`${path}-wal`) || existsSync(`${path}-shm`)).toBe(false);
});

// ---- the seat's own environment (policy, harness_env, unsets) ----

test("the probe reads the store the seat's child will use: harness_env XDG_DATA_HOME wins over ambient", () => {
  const ambient = scratch(), seatData = scratch();
  plantStore(join(ambient, ".local/share/opencode/opencode.db"), [OTHER]);
  plantStore(join(seatData, "opencode/opencode.db"), [STORED]);
  const env = { HOME: ambient };
  // The ambient default store lacks the id, but the seat's child reads seatData.
  expect(refusal("resume", record({ harness_env: { XDG_DATA_HOME: seatData } }), env)).toBeNull();
  // And the converse: the seat's own store lacks the id while the ambient one holds it.
  const ambientHolds = scratch();
  plantStore(join(ambientHolds, ".local/share/opencode/opencode.db"), [STORED]);
  const seatLacks = scratch();
  plantStore(join(seatLacks, "opencode/opencode.db"), [OTHER]);
  const error = refusal("resume", record({ harness_env: { XDG_DATA_HOME: seatLacks } }), { HOME: ambientHolds });
  expect(error?.tapErrorClass).toBe("no_exact_resume_identity");
  expect(error?.message).toContain(join(seatLacks, "opencode/opencode.db"));
});

test("the gate ignores TAP's OPENCODE_DB_PATH pin, which OpenCode never opens", () => {
  const home = scratch();
  plantStore(join(home, ".local/share/opencode/opencode.db"), [STORED]);
  const pinnedLacks = plantStore(join(scratch(), "pinned.db"), [OTHER]);
  // A readable, unrelated pinned store lacking the id proceeds: the child opens HOME's store.
  expect(refusal("resume", record(), { HOME: home, OPENCODE_DB_PATH: pinnedLacks })).toBeNull();
  // And the child's real store still decides when it lacks the id.
  const lacks = scratch();
  plantStore(join(lacks, ".local/share/opencode/opencode.db"), [OTHER]);
  const pinnedHolds = plantStore(join(scratch(), "pinned.db"), [STORED]);
  expect(refusal("resume", record(), { HOME: lacks, OPENCODE_DB_PATH: pinnedHolds })?.tapErrorClass).toBe("no_exact_resume_identity");
  // The seat's unsets still apply last.
  const seatData = scratch();
  plantStore(join(seatData, "opencode/opencode.db"), [STORED]);
  expect(refusal("resume", record({ harness_unset_env: ["XDG_DATA_HOME"] }), { HOME: lacks, XDG_DATA_HOME: seatData })?.tapErrorClass)
    .toBe("no_exact_resume_identity");
});

test("a WAL store missing only its -shm is unknown before any open, and nothing is created", () => {
  const path = plantStore(storeAt(), [STORED]);
  if (existsSync(`${path}-shm`)) unlinkSync(`${path}-shm`);
  expect(existsSync(`${path}-wal`)).toBe(true);
  const before = snapshot(path);
  expect(opencodeStoredSession(OTHER, storeEnv(path))).toBe("unknown");
  expect(snapshot(path)).toBe(before);
  expect(existsSync(`${path}-shm`)).toBe(false);
});

test("a degraded config.toml (unreadable, malformed or insecure) proceeds: the policy cannot be verified", () => {
  const home = scratch();
  plantStore(join(home, ".local/share/opencode/opencode.db"), [OTHER]);
  // A relative XDG_CONFIG_HOME degrades the catalog read to an empty policy plus a
  // degraded notice; the gate treats that like a refused policy and proceeds.
  const degraded = { HOME: home, XDG_CONFIG_HOME: "relative-config" };
  for (const kind of RESUME_KINDS) expect(refusal(kind, record(), degraded)).toBeNull();
  // The same store under a readable (absent) config still refuses.
  expect(refusal("resume", record(), { HOME: home })?.tapErrorClass).toBe("no_exact_resume_identity");
});
