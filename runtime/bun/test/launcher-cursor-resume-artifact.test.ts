// The cursor arm of the launch ladder's resume-artifact probe (tap-we6b):
// cursor writes no per-chat store until a chat's first turn, so a stored uuid
// with no store.db under the worktree's hash is a stale id — the probe must
// call it missing instead of promising an exact resume that would make
// cursor-agent silently start a new empty chat under the stale uuid.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { recordHasResumeArtifact } from "../src/launcher/collision";
import { describeReviveTier } from "../src/launcher/collision";
import { collisionReviveTier } from "../src/launcher/new";
import { buildHarnessInvocation } from "../src/launcher/adapters";
import { resolvedResumeIdentity } from "../src/launcher/resume-identity";
import { resumeIdentityBinding } from "../src/launcher/transaction";
import { UNBOUND_RESUME_IDENTITY } from "../src/launcher/types";
import { TransactionError } from "../src/launcher/transaction";
import type { LaunchRecord } from "../src/launcher/transaction";

const original = { ...process.env };
const roots: string[] = [];

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "tap-cursor-artifact-"));
  roots.push(root);
  process.env.TAP_CURSOR_HOME = root;
  return root;
}

/** The store path derived INDEPENDENTLY of the helper under test: the recorded
 * Cursor layout <root>/chats/<md5(worktree)>/<chat-uuid>/store.db. */
function chatStore(root: string, worktree: string, uuid: string): string {
  const hash = createHash("md5").update(worktree, "utf8").digest("hex");
  return join(root, "chats", hash, uuid, "store.db");
}

function cursorRecord(over: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    name: "fixture/cursor",
    harness: "cursor",
    cwd: "/tmp/wt",
    base: "fixture",
    harness_session_id: "019a1111-2222-7333-8444-555555555555",
    ...over,
  };
}

test("a cursor chat with a store.db under the worktree hash is resumable", () => {
  const root = sandbox();
  const record = cursorRecord();
  const store = chatStore(root, record.cwd, record.harness_session_id!);
  mkdirSync(join(store, ".."), { recursive: true });
  writeFileSync(store, "");
  expect(recordHasResumeArtifact(record)).toBe(true);
});

test("a stored cursor uuid with no store.db is a stale id, not resumable", () => {
  const root = sandbox();
  const record = cursorRecord();
  // A different chat exists in the same workspace; the stored uuid's does not.
  const other = chatStore(root, record.cwd, "019b2222-3333-7444-8555-666666666666");
  mkdirSync(join(other, ".."), { recursive: true });
  writeFileSync(other, "");
  expect(recordHasResumeArtifact(record)).toBe(false);
});

test("a cursor record with no stored session id is not resumable", () => {
  sandbox();
  expect(recordHasResumeArtifact(cursorRecord({ harness_session_id: null }))).toBe(false);
});

// ---- 2b: resolution + adapter shape (tap-we6b) ----

test("resolvedResumeIdentity returns null + a not-resumable receipt for a stale stored cursor uuid", () => {
  const root = sandbox();
  const record = cursorRecord();
  // Another chat's store exists in this workspace; the stored uuid's does not.
  const other = chatStore(root, record.cwd, "019b2222-3333-7444-8555-666666666666");
  mkdirSync(join(other, ".."), { recursive: true });
  writeFileSync(other, "");
  const lines: string[] = [];
  expect(resolvedResumeIdentity(record, process.env, l => lines.push(l))).toBe(null);
  expect(lines.join("\n")).toContain(
    `tap session: no cursor chat store for stored id ${record.harness_session_id}; the conversation never persisted and cannot be resumed`);
});

test("resolvedResumeIdentity returns the stored id when the store exists, with no receipt", () => {
  const root = sandbox();
  const record = cursorRecord();
  const store = chatStore(root, record.cwd, record.harness_session_id!);
  mkdirSync(join(store, ".."), { recursive: true });
  writeFileSync(store, "");
  const lines: string[] = [];
  expect(resolvedResumeIdentity(record, process.env, l => lines.push(l))).toBe(record.harness_session_id!);
  expect(lines).toEqual([]);
});

// Refuse, don't pick (tap-we6b rework): a stale id is not resumable, so the
// resume action builds NO picker argv — a null resolved identity emits nothing.
// A live id still resumes exactly; new keeps the record's id-first mint.
test("the cursor adapter binds the resolved identity on resume and the record id on new", () => {
  sandbox();
  const record = cursorRecord();
  const resumeArgv = (identity: string | null) => buildHarnessInvocation("resume", record, null, identity).argv;
  expect(resumeArgv(null)).not.toContain("--resume");
  expect(resumeArgv("cursor-id").slice(resumeArgv("cursor-id").indexOf("--resume"))).toEqual(["--resume", "cursor-id"]);
  const newArgv = buildHarnessInvocation("new", record, null).argv;
  expect(newArgv.slice(newArgv.indexOf("--resume"))).toEqual(["--resume", record.harness_session_id!]);
});

// ---- refuse-don't-pick: the doors, not just the argv (tap-we6b rework) ----

test("the stale tier word tells the operator [r] refuses instead of promising fresh", () => {
  expect(describeReviveTier("stale")).toContain("never persisted");
  expect(describeReviveTier("stale")).toContain("resume refuses");
  expect(describeReviveTier("fresh")).not.toContain("resume refuses");
});

test("a seat that unsets CURSOR_HOME is not probed under TAP's TAP_CURSOR_HOME alias either", () => {
  const alias = sandbox();
  const home = mkdtempSync(join(tmpdir(), "tap-cursor-default-home-"));
  roots.push(home);
  process.env.HOME = home;
  const record = cursorRecord({ harness_unset_env: ["CURSOR_HOME"] });
  // The chat exists only under the alias root; the seat's cursor uses ~/.cursor, which is empty.
  const store = chatStore(alias, record.cwd, record.harness_session_id!);
  mkdirSync(join(store, ".."), { recursive: true });
  writeFileSync(store, "");
  expect(recordHasResumeArtifact(cursorRecord())).toBe(true);
  expect(recordHasResumeArtifact(record)).toBe(false);
});

test("any attachable cursor collision keeps the reattach tier; only a stopped stale seat is refused", () => {
  const id = "019a1111-2222-7333-8444-555555555555";
  // resume's sessionAttachable reattaches busy and unknown panes too, not only live.
  for (const classification of ["live", "busy", "unknown"]) {
    expect(collisionReviveTier("cursor", id, false, true, classification)).toBe("exact");
  }
  for (const classification of ["shell", "attached-shell"]) {
    expect(collisionReviveTier("cursor", id, false, true, classification)).toBe("stale");
  }
  expect(collisionReviveTier("cursor", id, false, false, "absent")).toBe("stale");
  expect(collisionReviveTier("cursor", id, true, false, "absent")).toBe("exact");
  expect(collisionReviveTier("claude", id, false, false, "absent")).toBe("picker");
});

test("every resume-family kind binds a live cursor chat once and refuses a stale one before reserving", () => {
  const root = sandbox();
  const record = cursorRecord();
  const store = chatStore(root, record.cwd, record.harness_session_id!);
  mkdirSync(join(store, ".."), { recursive: true });
  writeFileSync(store, "");
  for (const kind of ["resume", "resume-all", "restart", "seat-up"] as const) {
    // Live chat: the stored id is bound as the identity.
    expect(resumeIdentityBinding(kind, record, process.env)).toBe(record.harness_session_id!);
    // Stale chat: the resume door's refusal class, before any reservation.
    let error: unknown;
    try { resumeIdentityBinding(kind, cursorRecord({ cwd: join(root, "never-launched-wt") }), process.env); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(TransactionError);
    expect((error as TransactionError).tapErrorClass).toBe("no_exact_resume_identity");
    expect((error as TransactionError).tapAction).toBe("tap session launch cursor cursor --fresh");
    expect(String(error)).toContain("no persisted conversation store");
  }
  // Non-cursor harnesses: seat-up keeps the raw id; the other kinds leave the
  // adapter's own resolver unbound.
  const codex = { ...cursorRecord(), harness: "codex" };
  expect(resumeIdentityBinding("seat-up", codex, process.env)).toBe(record.harness_session_id!);
  expect(resumeIdentityBinding("resume", codex, process.env)).toBe(UNBOUND_RESUME_IDENTITY);
  expect(resumeIdentityBinding("new", record, process.env)).toBe(UNBOUND_RESUME_IDENTITY);
});

test("the store root comes from the seat's launch env, not only the launcher's", () => {
  const ambient = sandbox();
  const seatHome = mkdtempSync(join(tmpdir(), "tap-cursor-seat-home-"));
  roots.push(seatHome);
  const record = cursorRecord({ harness_env: { CURSOR_HOME: seatHome } });
  const store = chatStore(seatHome, record.cwd, record.harness_session_id!);
  mkdirSync(join(store, ".."), { recursive: true });
  writeFileSync(store, "");
  // The chat lives only under the seat's own CURSOR_HOME; the ambient root is empty.
  expect(recordHasResumeArtifact(record)).toBe(true);
  expect(resumeIdentityBinding("resume", record, process.env)).toBe(record.harness_session_id!);
  // Without the seat's override the same chat is invisible, so the probe really moved.
  expect(recordHasResumeArtifact(cursorRecord())).toBe(false);
  // A seat that unsets CURSOR_HOME falls back to the default root under HOME.
  process.env.CURSOR_HOME = seatHome;
  delete process.env.TAP_CURSOR_HOME;
  process.env.HOME = ambient;
  expect(recordHasResumeArtifact(cursorRecord())).toBe(true);
  expect(recordHasResumeArtifact(cursorRecord({ harness_unset_env: ["CURSOR_HOME"] }))).toBe(false);
});

// ---- the catalog [harness.cursor.env] policy layer (tap-ex10c) ----
// A real launch composes catalog policy < the seat's harness_env < explicit unset;
// the probe must look where the relaunched cursor will, not only where the
// launcher's shell points.

/** A fresh scratch dir the runner's cleanup owns. */
function scratch(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `tap-cursor-${label}-`));
  roots.push(dir);
  return dir;
}

/** The ambient env with a sandbox config.toml whose [harness.cursor.env] says `policyEnv`.
 * TAP_CURSOR_HOME stays as sandbox() set it: the alias the policy must outrank. */
function policyEnv(policyEnv: Record<string, string>, home = scratch("home")): NodeJS.ProcessEnv {
  const xdg = scratch("xdg");
  mkdirSync(join(xdg, "tap"), { recursive: true });
  const lines = Object.entries(policyEnv).map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
  writeFileSync(join(xdg, "tap", "config.toml"), `version = 3\n\n[harness.cursor.env]\n${lines.join("\n")}\n`);
  chmodSync(join(xdg, "tap", "config.toml"), 0o600);
  return { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg };
}

function plantChat(root: string, worktree: string, uuid: string): void {
  const store = chatStore(root, worktree, uuid);
  mkdirSync(dirname(store), { recursive: true });
  writeFileSync(store, "");
}

test("a seat whose CURSOR_HOME comes from the catalog policy is probed in that store", () => {
  sandbox(); // the launcher's own TAP_CURSOR_HOME alias: empty, and outranked by the policy
  const policyRoot = scratch("policy");
  const record = cursorRecord();
  plantChat(policyRoot, record.cwd, record.harness_session_id!);
  expect(recordHasResumeArtifact(record, policyEnv({ CURSOR_HOME: policyRoot }))).toBe(true);
  // Control: with no policy the same chat is invisible, so the probe really moved.
  expect(recordHasResumeArtifact(record, { ...process.env, XDG_CONFIG_HOME: scratch("empty-xdg") })).toBe(false);
});

test("the seat's own harness_env CURSOR_HOME outranks the catalog policy", () => {
  sandbox();
  const policyRoot = scratch("policy");
  const seatRoot = scratch("seat");
  const record = cursorRecord({ harness_env: { CURSOR_HOME: seatRoot } });
  const env = policyEnv({ CURSOR_HOME: policyRoot });
  plantChat(policyRoot, record.cwd, record.harness_session_id!);
  expect(recordHasResumeArtifact(record, env)).toBe(false);
  plantChat(seatRoot, record.cwd, record.harness_session_id!);
  expect(recordHasResumeArtifact(record, env)).toBe(true);
});

test("an explicit unset of CURSOR_HOME outranks the catalog policy: the default root is probed", () => {
  sandbox();
  const policyRoot = scratch("policy");
  const home = scratch("home");
  const record = cursorRecord({ harness_unset_env: ["CURSOR_HOME"] });
  const env = policyEnv({ CURSOR_HOME: policyRoot }, home);
  plantChat(policyRoot, record.cwd, record.harness_session_id!);
  expect(recordHasResumeArtifact(record, env)).toBe(false);
  plantChat(join(home, ".cursor"), record.cwd, record.harness_session_id!);
  expect(recordHasResumeArtifact(record, env)).toBe(true);
});

test("an explicit unset outranks both the policy and the seat's own CURSOR_HOME, alias included", () => {
  const alias = sandbox(); // an ambient TAP_CURSOR_HOME the unset must also defeat
  const policyRoot = scratch("policy");
  const seatRoot = scratch("seat");
  const home = scratch("home");
  const record = cursorRecord({ harness_env: { CURSOR_HOME: seatRoot }, harness_unset_env: ["CURSOR_HOME"] });
  const env = policyEnv({ CURSOR_HOME: policyRoot }, home);
  for (const root of [policyRoot, seatRoot, alias]) plantChat(root, record.cwd, record.harness_session_id!);
  // The launch removes CURSOR_HOME last, so cursor falls back to ~/.cursor, which is empty.
  expect(recordHasResumeArtifact(record, { ...env, TAP_CURSOR_HOME: alias })).toBe(false);
  plantChat(join(home, ".cursor"), record.cwd, record.harness_session_id!);
  expect(recordHasResumeArtifact(record, { ...env, TAP_CURSOR_HOME: alias })).toBe(true);
});

test("a relative CURSOR_HOME anchors to the seat's launch workdir, not the caller's cwd", () => {
  sandbox();
  const workdir = scratch("workdir");
  const record = cursorRecord({ cwd: scratch("registered"), launch_workdir: workdir });
  plantChat(join(workdir, "rel-cursor"), workdir, record.harness_session_id!);
  // From the catalog policy, from the seat's own env, and from the ambient shell.
  expect(recordHasResumeArtifact(record, policyEnv({ CURSOR_HOME: "rel-cursor" }))).toBe(true);
  expect(recordHasResumeArtifact({ ...record, harness_env: { CURSOR_HOME: "rel-cursor" } }, { ...process.env })).toBe(true);
  delete process.env.TAP_CURSOR_HOME;
  expect(recordHasResumeArtifact(record, { ...process.env, CURSOR_HOME: "rel-cursor" })).toBe(true);
  // The same relative name under the caller's cwd is not where the seat's cursor looks.
  expect(recordHasResumeArtifact(cursorRecord({ cwd: workdir }), policyEnv({ CURSOR_HOME: "elsewhere" }))).toBe(false);
});

test("a catalog policy that cannot be read cleanly leaves the probe fail-closed, never throwing", () => {
  sandbox();
  const record = cursorRecord();
  // CURSOR_HOME is allowed; a fence-crossing key in the same table makes the policy refuse.
  const env = policyEnv({ CURSOR_HOME: scratch("policy"), CURSOR_API_KEY: "x" });
  expect(recordHasResumeArtifact(record, env)).toBe(true);
});

test("a file where a cursor store directory belongs proves the store absent (ENOTDIR)", () => {
  const root = sandbox();
  const record = cursorRecord();
  const store = chatStore(root, record.cwd, record.harness_session_id!);
  // The workspace-hash component is a regular file: statSync throws ENOTDIR.
  const hashDir = join(store, "..", "..");
  mkdirSync(join(hashDir, ".."), { recursive: true });
  writeFileSync(hashDir, "");
  expect(recordHasResumeArtifact(record)).toBe(false);
  let error: unknown;
  try { resumeIdentityBinding("resume", record, process.env); } catch (e) { error = e; }
  expect((error as TransactionError).tapErrorClass).toBe("no_exact_resume_identity");
});

test("with HOME absent the default cursor root still resolves to the user's home, not the cwd", () => {
  // The runner's HOME is private, and Bun's homedir() reads the startup HOME,
  // so the store is placed there and probed through an env without HOME.
  // Only inside the runner's private HOME: never write under the operator's
  // real home (the runner's scratch root owns cleanup).
  const home = process.env.HOME!;
  // The runner marker: its HOME is $WORK/home beside TAP_HOME=$WORK/bus. Bun's
  // userInfo() also reads the startup HOME, so it cannot tell the two apart.
  expect(process.env.TAP_HOME).toBe(join(dirname(home), "bus"));
  const record = cursorRecord();
  const store = chatStore(join(home, ".cursor"), record.cwd, record.harness_session_id!);
  mkdirSync(join(store, ".."), { recursive: true });
  writeFileSync(store, "");
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.HOME; delete env.TAP_CURSOR_HOME; delete env.CURSOR_HOME;
  expect(recordHasResumeArtifact(record, env)).toBe(true);
});

test("a cursor store that disappears after the binding cannot turn resume into a fresh start", () => {
  const root = sandbox();
  const record = cursorRecord();
  const store = chatStore(root, record.cwd, record.harness_session_id!);
  mkdirSync(join(store, ".."), { recursive: true });
  writeFileSync(store, "");
  const bound = resumeIdentityBinding("resume", record, process.env);
  rmSync(store);
  // The bound identity still targets the stored chat exactly...
  const argv = buildHarnessInvocation("resume", record, null, bound).argv;
  expect(argv.slice(argv.indexOf("--resume"))).toEqual(["--resume", record.harness_session_id!]);
  // ...where a late, unbound resolution would have dropped --resume entirely.
  expect(buildHarnessInvocation("resume", record, null).argv).not.toContain("--resume");
});
