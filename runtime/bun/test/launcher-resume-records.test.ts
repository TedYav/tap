// launcher/resume.ts record selection, refusals, the adopted and create
// fallbacks, the departed-restore prompt, the adopted-shell receipt, the
// registration pane probe and the session-name parser, ported from
// test_launcher.py when cmd_resume became a door (plus the prompt, create and
// adopted paths the incumbent never tested).
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Notices } from "../src/launcher/catalog-notices";
import { allocatedIndex, parseSessionName, registerResumedSession, registryEntry, seatIsReclaimableCorpse, unexpiredSeats, type ResumeDeps } from "../src/launcher/resume";
import { registryState, SCRIPTS, withRecordDefaults } from "../src/launcher/resume-prelude";
import { PANE_FACTS_FORMAT } from "../src/launcher/readiness";
import { reviveTier } from "../src/launcher/resume-identity";
import { launchTransaction, type LaunchRecord } from "../src/launcher/transaction";
import { fixture, options, paneLine, recorder, restoreEnvironment, resume, type Event } from "./support/resume-harness";
import type { ChoiceOption } from "../src/launcher/prompt";

afterEach(restoreEnvironment);

const runs = (events: Event[]) => events.filter((event): event is ["run", string, string, LaunchRecord] => event[0] === "run");
/** The one launch transaction a resume ran. */
function onlyRun(events: Event[]): ["run", string, string, LaunchRecord] {
  const found = runs(events);
  expect(found).toHaveLength(1);
  return found[0]!;
}

/** A persisted cursor chat store for `worktree` under a fresh TAP_CURSOR_HOME
 * (tap-we6b rework): the recorded layout <home>/chats/<md5(worktree)>/<id>/store.db,
 * derived independently of the helper under test. Returns the restore fn. */
function liveCursorStore(worktree: string, id: string): () => void {
  const home = mkdtempSync(join(tmpdir(), "tap-cursor-live-"));
  const store = join(home, "chats", createHash("md5").update(worktree, "utf8").digest("hex"), id, "store.db");
  mkdirSync(join(store, ".."), { recursive: true });
  writeFileSync(store, "");
  const prev = process.env.TAP_CURSOR_HOME;
  process.env.TAP_CURSOR_HOME = home;
  return () => {
    if (prev === undefined) delete process.env.TAP_CURSOR_HOME;
    else process.env.TAP_CURSOR_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  };
}

/**
 * The real transaction in dry-run JSON mode behind the `run` seam: it prints the
 * payload (argv included) and mutates nothing, as `--dry-run --json` did.
 */
function dryRunTransaction(events: Event[]): ResumeDeps["run"] {
  return async (kind, record, extra = {}) => {
    events.push(["run", kind, record.name, structuredClone(record)]);
    const result = await launchTransaction({ kind, record: structuredClone(record), dry_run: true, json: true,
      terminal: { stderr_tty: false }, script_dir: SCRIPTS, ...extra }, process.env, undefined, new Notices());
    return { code: result.code, adopted_shell: result.adopted_shell };
  };
}
const payloadArgv = (stdout: string): string[] => JSON.parse(stdout.trim().split("\n").at(-1)!).argv;

// ---- recordless two-argument refusals (the create fallback's gate) ----

test("the create fallback never prompts or launches when the caller cannot see a question", async () => {
  // test_resume_create_fallback_never_prompts_when_stdout_is_not_a_tty (tap-7r3fn.24): the
  // both-streams predicate is callerHasTty; here it answers false.
  const world = fixture({ registry: { schema: "0.20", team: { name: "repo" }, seats: {} } });
  const { events, deps } = recorder({ hasTty: false });
  const result = await resume(world.root, options({ key: "codex", legacyName: "scout" }), deps);
  expect(result.error?.message).toBe("no codex session found for scout; create it with tap session launch codex scout");
  expect(result.err).not.toContain("starting a fresh session");
  expect(events).toEqual([]);
});

test("an unknown two-argument resume refuses creation without a terminal, and under --dry-run even with one", async () => {
  // test_unknown_two_argument_resume_refuses_noninteractive_creation.
  const world = fixture({ registry: { schema: "0.20", team: { name: "repo" }, seats: {} } });
  for (const [hasTty, dryRun] of [[false, false], [true, true]] as const) {
    const { events, deps } = recorder({ hasTty });
    const result = await resume(world.root, options({ key: "claude", legacyName: "planner", dryRun }), deps);
    expect(result.error?.message).toContain("create it with tap session launch claude planner");
    expect(events).toEqual([]);
  }
});

test("an expired launch reservation does not occupy the handle; an unobservable tmux keeps it protected", async () => {
  // test_recordless_resume_does_not_treat_expired_reservation_as_occupied.
  const registry = { schema: "0.20", team: { name: "repo" }, seats: { expired: {
    status: "active", status_reason: "launching", launch_id: "stale-token", harness: "codex",
    session: "repo/expired", registered_at: "2000-01-01T00:00:00Z" } } };
  const world = fixture({ registry, tmux: [{ match: "*list-sessions -F #S", stdout: "" }] });
  const { events, deps } = recorder({ hasTty: false });
  const result = await resume(world.root, options({ key: "codex", legacyName: "expired" }), deps);
  expect(result.error?.message).not.toContain("occupied on the roster");
  expect(result.error?.message).toContain("create it with tap session launch codex expired");
  expect(events).toEqual([]);

  // Control: with no live-session snapshot the reservation cannot be proven expired.
  const blind = fixture({ registry });
  const control = await resume(blind.root, options({ key: "codex", legacyName: "expired" }), recorder({ hasTty: false }).deps);
  expect(control.error?.message).toContain("handle 'expired' is occupied on the roster");
});

// ---- identity: the acting registry row is the only claim ----

test("resume uses the registry row's native id and never reads a retired sessions journal", async () => {
  // test_resume_uses_registry_identity_and_ignores_retired_journal.
  const staleId = "019a1111-2222-7333-8444-555555555555", registryId = "019b2222-3333-7444-8555-666666666666";
  const world = fixture();
  world.writeRegistry({ schema: "0.20", team: { name: "repo", worktree_root: world.root }, seats: { planner: {
    status: "active", delivery: "pane", session: "repo/planner", harness: "codex", harness_session_id: registryId,
    session_attribution_trust: "env", registered_from_worktree: world.root } } });
  const journal = join(world.root, "sessions.json");
  const poison = `${JSON.stringify({ sessions: [{ name: "repo/planner", harness: "codex", harness_session_id: staleId }] })}\n`;
  writeFileSync(journal, poison);
  const events: Event[] = [];
  const deps = { ...recorder().deps, run: dryRunTransaction(events) };
  const result = await resume(world.root, options({ key: "planner", dryRun: true, json: true }), deps);
  expect(result.error).toBeNull();
  expect(result.code).toBe(0);
  expect(runs(events).map(([, kind, name, record]) => [kind, name, record.harness_session_id])).toEqual([["resume", "repo/planner", registryId]]);
  const argv = payloadArgv(result.out);
  expect(argv).toContain(registryId);
  expect(argv).not.toContain(staleId);
  // Natively nothing reads a sessions journal; this pins that resume writes none into the root either.
  expect(readFileSync(journal, "utf8")).toBe(poison);
  // The transaction's resume-kind copy of the expected-seat line keeps resume wording too.
  expect(result.err).toContain("tap session: resuming repo/planner; expected seat planner\n");
  expect(result.err).not.toContain("reviv");
});

test("an id-less registry row reaches the native picker, never its derived id", async () => {
  // test_resume_idless_registry_row_ignores_derived_identity.
  const derivedId = "019c3333-4444-7555-8666-777777777777";
  const world = fixture();
  world.writeRegistry({ schema: "0.20", team: { name: "repo", worktree_root: world.root }, seats: { planner: {
    status: "active", delivery: "pane", session: "repo/planner", harness: "codex",
    derived_harness_session_id: derivedId, registered_from_worktree: world.root } } });
  const events: Event[] = [];
  const deps = { ...recorder().deps, run: dryRunTransaction(events) };
  const result = await resume(world.root, options({ key: "planner", dryRun: true, json: true }), deps);
  expect(result.code).toBe(0);
  expect(runs(events).map(([, , , record]) => record.harness_session_id)).toEqual([null]);
  const argv = payloadArgv(result.out);
  expect(argv).not.toContain(derivedId);
  expect(argv.at(-1)).toBe("resume");
});

test("a named resume recovers an operationally suspended seat; user_removed stays an occupied refusal", async () => {
  // test_named_resume_recovers_operationally_suspended_seat, in the post-flip layout it used.
  for (const reason of ["pane_gone", "session_replaced", "repair_failed", "restart_failed", "user_removed"]) {
    const world = fixture();
    const registry = join(world.root, ".tap", "team-registry.json");
    const row = { status: "suspended", status_reason: reason, delivery: "pane", session: "repo/coach", harness: "cursor",
      harness_session_id: "stored-conversation", tag: "coach", registered_from_worktree: world.root };
    mkdirSync(join(world.root, ".tap", "bus"), { recursive: true });
    writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "repo", worktree_root: world.root }, seats: { coach: row } }));
    writeFileSync(join(process.env.TAP_INDEX_HOME!, "global-registry.json"),
      JSON.stringify({ schema: "0.20", teams: { repo: { root: world.root, registry_location: registry } } }));
    const before = readFileSync(registry);
    // The stored cursor chat really persisted (tap-we6b rework): without a
    // store.db the resume door refuses before any recovery can run.
    const restoreCursor = reason === "user_removed" ? null : liveCursorStore(world.root, "stored-conversation");
    const events: Event[] = [];
    const deps = { ...recorder().deps, run: dryRunTransaction(events) };
    try {
      const result = await resume(world.root, options({ key: "coach", dryRun: true, json: true }), deps);
      if (reason === "user_removed") {
        expect(result.error?.message).toContain("resume refused — handle 'coach' is occupied on the roster but has no launcher record to resume");
        expect(events).toEqual([]);
      } else {
        expect([reason, result.error, result.code]).toEqual([reason, null, 0]);
        expect(result.err).toContain(`would resume repo/coach from suspended/${reason}`);
        expect(runs(events).map(([, kind, name]) => [kind, name])).toEqual([["resume", "repo/coach"]]);
        expect(payloadArgv(result.out)).toContain("stored-conversation");
      }
      expect(readFileSync(registry).equals(before)).toBe(true);
    } finally {
      restoreCursor?.();
    }
  }
});

test("the shared transaction refuses a stale cursor chat for every resume-family kind, doors aside", async () => {
  // tap-we6b: the door guards run early, but resume-all (tap team up) and
  // seat-up enter the transaction without them. Capture the record a live
  // resume builds, remove the store, then drive the REAL transaction directly.
  const world = fixture();
  const registry = join(world.root, ".tap", "team-registry.json");
  const row = { status: "suspended", status_reason: "pane_gone", delivery: "pane", session: "repo/coach", harness: "cursor",
    harness_session_id: "stored-conversation", tag: "coach", registered_from_worktree: world.root };
  mkdirSync(join(world.root, ".tap", "bus"), { recursive: true });
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "repo", worktree_root: world.root }, seats: { coach: row } }));
  writeFileSync(join(process.env.TAP_INDEX_HOME!, "global-registry.json"),
    JSON.stringify({ schema: "0.20", teams: { repo: { root: world.root, registry_location: registry } } }));
  const restoreCursor = liveCursorStore(world.root, "stored-conversation");
  const events: Event[] = [];
  try {
    const result = await resume(world.root, options({ key: "coach", dryRun: true, json: true }), { ...recorder().deps, run: dryRunTransaction(events) });
    expect(result.code).toBe(0);
  } finally {
    restoreCursor();
  }
  const record = events[0]![3] as LaunchRecord;
  const before = readFileSync(registry);
  for (const kind of ["resume", "resume-all", "restart", "seat-up"] as const) {
    let error: unknown;
    try {
      await launchTransaction({ kind, record: structuredClone(record), dry_run: true, json: true,
        terminal: { stderr_tty: false }, script_dir: SCRIPTS }, process.env, undefined, new Notices());
    } catch (e) { error = e; }
    expect([kind, (error as { tapErrorClass?: string })?.tapErrorClass]).toEqual([kind, "no_exact_resume_identity"]);
  }
  expect(readFileSync(registry).equals(before)).toBe(true);
});

// ---- the adopted fallback: a bare harness with zero or several records ----

test("an id-less OpenCode adopted resume says it starts fresh, never that it opens a picker", async () => {
  // test_opencode_adopted_idless_warning_names_fresh_not_picker.
  const world = fixture({ registry: { schema: "0.20", team: { name: "repo" }, seats: {} } });
  const { events, deps } = recorder();
  const result = await resume(world.root, options({ key: "opencode" }), deps);
  expect(result.code).toBe(0);
  expect(result.err).toContain("tap session: no known opencode session found; creating tmux session 'repo/opencode'; starting a fresh conversation");
  expect(result.err).not.toContain("picker");
  expect(events.map(event => event.slice(0, 3))).toEqual([["run", "adopted", "repo/opencode"], ["attach", "resume", "repo/opencode"]]);
});

test("an id-less Cursor resume discloses its fresh start under --dry-run too (tap-we6b)", async () => {
  const world = fixture({ registry: { schema: "0.20", team: { name: "repo" }, seats: {} } });
  world.writeRegistry({ schema: "0.20", team: { name: "repo", worktree_root: world.root }, seats: { planner: {
    status: "active", delivery: "pane", session: "repo/planner", harness: "cursor",
    session_attribution_trust: "env", registered_from_worktree: world.root } } });
  const events: Event[] = [];
  const result = await resume(world.root, options({ key: "planner", dryRun: true, json: true }), { ...recorder().deps, run: dryRunTransaction(events) });
  expect(result.error).toBeNull();
  expect(result.code).toBe(0);
  expect(result.err).toContain("tap session: WARNING: repo/planner has no native cursor chat id; starting a fresh conversation\n");
});

test("an id-less Cursor adopted resume says it starts fresh, never that it opens a picker (tap-we6b)", async () => {
  const world = fixture({ registry: { schema: "0.20", team: { name: "repo" }, seats: {} } });
  const { deps } = recorder();
  const result = await resume(world.root, options({ key: "cursor" }), deps);
  expect(result.err).toContain("tap session: no known cursor session found; creating tmux session 'repo/cursor'; starting a fresh conversation");
  expect(result.err).not.toContain("picker");
});

test("an adopted codex resume keyed by the harness itself persists no harness tag and passes no native query", async () => {
  // test_adopted_codex_resume_query_equal_to_harness_does_not_persist_harness_tag.
  const world = fixture({ registry: { schema: "0.20", team: { name: "repo" }, seats: {} } });
  const extras: unknown[] = [];
  const base = recorder();
  const deps: ResumeDeps = { ...base.deps, run: async (kind, record, extra) => { extras.push(extra); return base.deps.run(kind, record); } };
  const result = await resume(world.root, options({ key: "codex" }), deps);
  expect(result.code).toBe(0);
  const [, kind, name, record] = onlyRun(base.events);
  expect([kind, name, record.tag, record.index]).toEqual(["adopted", "repo/codex", null, 1]);
  expect(extras).toEqual([{ native_query: null }]);
});

test("the adopted resume states the expected seat in resume wording", async () => {
  // test_expected_resume_identity_uses_resume_wording (the resume.ts-owned copy; the
  // resume-kind copy is the transaction's expectedReceipt).
  const world = fixture({ registry: { schema: "0.20", team: { name: "repo" }, seats: {} } });
  const result = await resume(world.root, options({ key: "codex" }), recorder().deps);
  expect(result.err).toContain("tap session: resuming repo/codex; expected seat codex\n");
  expect(result.err).not.toContain("reviv");
});

test("the adopted name skips live and protected registered names; dry-run launches without attaching", async () => {
  const registry = `{"schema":"0.20","team":{"name":"repo"},"seats":{`
    + `"alpha":{"status":"active","delivery":"pane","harness":"codex","session":"repo/alpha","pane":"","pane_id":""},`
    + `"beta":{"status":"active","delivery":"pane","harness":"codex","session":"repo/beta","pane":"","pane_id":""},`
    + `"codex-2":{"status":"suspended","status_reason":"user_removed","harness":"codex","session":"repo/codex-2"}}}\n`;
  const world = fixture({ registry, tmux: [{ match: "*list-sessions -F #S", stdout: "repo/codex\n" }] });
  // Two codex records: the bare harness key is ambiguous, so it adopts.
  expect(registryState(world.root).sessions.map(record => [record.name, record.harness]))
    .toEqual([["repo/alpha", "codex"], ["repo/beta", "codex"]]);
  const { events, deps } = recorder({ hasTty: true });
  const result = await resume(world.root, options({ key: "codex" }), deps);
  expect(result.error).toBeNull();
  expect(result.code).toBe(0);
  const [, kind, name, record] = onlyRun(events);
  expect([kind, name, record.tag, record.index]).toEqual(["adopted", "repo/codex-3", null, 3]);
  expect(result.err).toBe("tap session: no known codex session found; creating tmux session 'repo/codex-3' using the native resume picker\n"
    + "tap session: resuming repo/codex-3; expected seat codex-3\n");
  expect(events.at(-1)).toEqual(["attach", "resume", "repo/codex-3"]);

  const dry = recorder({ hasTty: true });
  const preview = await resume(world.root, options({ key: "codex", dryRun: true }), dry.deps);
  expect(preview.code).toBe(0);
  expect(dry.events.map(event => event.slice(0, 3))).toEqual([["run", "adopted", "repo/codex-3"]]);
});

// ---- the interactive fallbacks ----

test("the departed-restore prompt offers r/l/q with a rendered instance gloss; each answer exits 2 with its hint", async () => {
  const hints: Record<string, string | null> = {
    r: "tap session resume: restore with:\n  tap in opus --restore 'opus|abc123def456'\n",
    l: "tap session resume: list with:\n  tap in opus --list-history --json\n",
    q: null,
  };
  for (const [choice, hint] of Object.entries(hints)) {
    const world = fixture({ registry: { schema: "0.20", team: { name: "repo" }, seats: {} } });
    world.writeHistory("opus.out-1.20260730T120000Z.json",
      { handle: "opus", instance: "opus|abc123def456", retired_at: "2026-07-30T12:00:00Z", retired_by: "out-1" });
    const asked: [string, string, ChoiceOption[], string][] = [];
    const base = recorder({ hasTty: true });
    const deps: ResumeDeps = { ...base.deps, choose: (verb, question, choices, fallback) => { asked.push([verb, question, choices, fallback]); return choice; } };
    const result = await resume(world.root, options({ key: "opus" }), deps);
    expect([choice, result.error, result.code]).toEqual([choice, null, 2]);
    const question = "no active seat named opus; found 1 departed in team-history — restore?";
    expect(asked).toEqual([["session", question, [
      ["r", "restore", "restore most recent — next: tap in opus --restore 'opus|abc123def456'"],
      ["l", "list", "list departed instances — next: tap in opus --list-history --json"],
      ["q", "quit", "leave everything unchanged"],
    ], "q"]]);
    expect(result.err).toBe(`tap session resume: ${question}\n  most recent instance: opus|abc123def456\n${hint ?? ""}`);
    expect(base.events).toEqual([]);
  }

  // --dry-run is never interactive, even on a terminal.
  const world = fixture({ registry: { schema: "0.20", team: { name: "repo" }, seats: {} } });
  world.writeHistory("opus.out-1.20260730T120000Z.json", { handle: "opus", instance: "opus|abc123def456" });
  const { events, deps } = recorder({ hasTty: true });
  const preview = await resume(world.root, options({ key: "opus", dryRun: true }), deps);
  expect(preview.error?.message).toContain("tap in opus --restore 'opus|abc123def456' (or tap in opus --fresh)");
  expect(events).toEqual([]);
});

test("the restore hints quote the instance so a pasted hint cannot run part of it as shell", async () => {
  const cases: [string, string][] = [
    ["opus|abc123def456", "'opus|abc123def456'"],
    ["opus; touch pwned", "'opus; touch pwned'"],
    ["plain-abc123", "plain-abc123"],
  ];
  for (const [instance, rendered] of cases) {
    const world = fixture({ registry: { schema: "0.20", team: { name: "repo" }, seats: {} } });
    world.writeHistory("opus.out-1.20260730T120000Z.json", { handle: "opus", instance });
    const noTty = await resume(world.root, options({ key: "opus" }), recorder({ hasTty: false }).deps);
    expect(noTty.error?.message).toContain(`tap in opus --restore ${rendered} (or tap in opus --fresh)`);
    const asked: string[] = [];
    const base = recorder({ hasTty: true });
    const deps: ResumeDeps = { ...base.deps, choose: (_verb, _question, choices) => { asked.push(choices[0]![2]); return "r"; } };
    const tty = await resume(world.root, options({ key: "opus" }), deps);
    expect(asked).toEqual([`restore most recent — next: tap in opus --restore ${rendered}`]);
    expect(tty.err).toContain(`restore with:\n  tap in opus --restore ${rendered}\n`);
  }
});

test("the interactive create fallback launches a fresh replacing seat under the name, then the launch attach tail", async () => {
  for (const harness of ["claude", "codex"]) {
    const world = fixture({ registry: { schema: "0.20", team: { name: "repo" }, seats: {} } });
    const { events, deps } = recorder({ hasTty: true });
    const result = await resume(world.root, options({ key: harness, legacyName: "scout" }), deps);
    expect([harness, result.error, result.code]).toEqual([harness, null, 0]);
    expect(result.err).toBe(`tap session: no ${harness} record for scout — starting a fresh session under this name (replaces the live session)\n`);
    expect(events.map(event => event.slice(0, 3))).toEqual([["run", "new", "repo/scout"], ["attach", "launch", "repo/scout"]]);
    const [, , , record] = onlyRun(events);
    expect({ harness: record.harness, tag: record.tag, index: record.index, replaces_session: record.replaces_session,
      kill_backup_required: record.kill_backup_required, ensure_action: record.ensure_action })
      .toEqual({ harness, tag: "scout", index: 1, replaces_session: "repo/scout", kill_backup_required: true, ensure_action: "new" });
    // Only claude mints its id up front; the others capture theirs at `tap in`.
    if (harness === "claude") expect(record.harness_session_id).toMatch(/^[0-9a-f-]{36}$/);
    else expect(record.harness_session_id).toBeNull();
  }
});

// ---- native_revive_mode's receipt context, in the adopted-shell resume receipt ----

test("an adopted-shell resume receipt names how each harness revives its conversation", async () => {
  // test_agy_revive_tier_and_mode (mode half), test_native_revive_mode_opencode_is_exact_with_id_and_fresh_without,
  // test_native_revive_mode_cursor_with_id_is_resume_not_new: the context string is resume.ts's.
  const cursorId = "550e8400-e29b-41d4-a716-446655440000";
  const cases: [string, string | null, string][] = [
    ["agy", null, "agy native latest (--continue)"],
    ["agy", "agy-id", "agy resume agy-id"],
    ["opencode", "ses_previous", "opencode resume ses_previous"],
    ["opencode", null, "no conversation to resume"],
    ["cursor", cursorId, `cursor resume ${cursorId}`],
    ["cursor", null, "no session id on record; browse past sessions with cursor-agent ls"],
    ["claude", null, "claude native picker"],
    ["codex", null, "codex native picker"],
    ["hermes", null, "no conversation to resume"],
  ];
  for (const [harness, id, context] of cases) {
    const world = fixture({ registry: { schema: "0.20", team: { name: "repo" }, seats: { scout: {
      status: "active", delivery: "pane", harness, session: "repo/scout", pane: "", pane_id: "", ...(id ? { harness_session_id: id } : {}) } } } });
    // A cursor cell with a stored id needs its chat to have persisted for the
    // receipt to exist at all (tap-we6b rework: a stale id refuses instead).
    const restoreCursor = harness === "cursor" && id ? liveCursorStore(world.root, id) : null;
    const { events, deps } = recorder({ run: () => ({ code: 0, adopted_shell: true }) });
    try {
      const result = await resume(world.root, options({ key: "scout" }), deps);
      expect([harness, id, result.error, result.code]).toEqual([harness, id, null, 0]);
      expect(result.out).toBe(`tap session: resumed repo/scout (adopted shell session, ${context}; expected seat scout)\n`);
      expect(events.map(event => event.slice(0, 3))).toEqual([["run", "resume", "repo/scout"], ["attach", "resume", "repo/scout"]]);
    } finally {
      restoreCursor?.();
    }
  }
  // The tier half of test_agy_revive_tier_and_mode (Python revive_tier is retired; its native owner remains).
  expect([reviveTier("agy", "some-id"), reviveTier("agy", null)]).toEqual(["exact", "latest"]);
  // A non-adopted resume prints no such receipt.
  const world = fixture({ registry: { schema: "0.20", team: { name: "repo" }, seats: { scout: { status: "active", delivery: "pane", harness: "agy", session: "repo/scout", pane: "", pane_id: "" } } } });
  const plain = await resume(world.root, options({ key: "scout" }), recorder().deps);
  expect(plain.out).toBe("");
});

// ---- register_resumed_session's pane probe (tmux_session_pane / tmux_session_panes) ----

/** tmux argument strings without launchTmux's private-socket prefix. */
const calls = (world: { tmuxCalls(): string[] }) => world.tmuxCalls().map(call => call.replace(/^-L \S+ /, ""));
const scout = (root: string) => withRecordDefaults({ name: "repo/scout", harness: "claude", cwd: root, base: "repo", tag: "scout", index: 1 });

async function register(record: LaunchRecord): Promise<{ ok: boolean; out: string }> {
  let out = "";
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => { out += String(chunk); return true; }) as typeof process.stdout.write;
  try { return { ok: await registerResumedSession(record), out }; }
  finally { process.stdout.write = write; }
}

test("registration probes the session's active pane, then lists the whole session; a dead session is not live", async () => {
  // test_tmux_session_pane_targets_session_active_pane + test_tmux_session_panes_lists_the_whole_session.
  const world = fixture({ registry: { schema: "0.20", team: { name: "repo" }, seats: {} } });
  const result = await register(scout(world.root));
  expect(result).toEqual({ ok: false, out: "tap session resume: session repo/scout is not live\n" });
  expect(calls(world)).toEqual([
    `display-message -p -t =repo/scout ${PANE_FACTS_FORMAT}`,
    `list-panes -s -t =repo/scout -F ${PANE_FACTS_FORMAT}`,
  ]);
});

test("registration refuses a session none of whose panes runs the seat's harness, naming the active pane", async () => {
  const world = fixture({ registry: { schema: "0.20", team: { name: "repo" }, seats: {} }, tmux: [
    { match: "*display-message -p -t =repo/scout *", stdout: paneLine("repo/scout:1.1", "%42", "zsh") },
    { match: "*list-panes -s -t =repo/scout *", stdout: paneLine("repo/scout:0.0", "%41", "vim") + paneLine("repo/scout:1.1", "%42", "zsh") },
  ] });
  const result = await register(scout(world.root));
  expect(result).toEqual({ ok: false, out: "tap session resume: session repo/scout active pane is zsh, not claude\n" });
  expect(calls(world).map(call => call.split(" ").slice(0, 4).join(" "))).toEqual([
    "display-message -p -t =repo/scout", "list-panes -s -t =repo/scout",
  ]);
});

// ---- parse_session_name / allocated_index ----

test("parseSessionName reads slash and legacy names, harness codes and index 0 as 1; allocatedIndex follows it", () => {
  const table: [string, [string, string | null, number] | null][] = [
    ["repo/codex", ["codex", null, 1]],
    ["repo/codex-2", ["codex", null, 2]],
    ["repo/codex-0", ["codex", null, 1]],
    ["repo/c", ["claude", null, 1]],
    ["repo/cx-3", ["codex", null, 3]],
    ["repo/oc", ["opencode", null, 1]],
    ["repo/cu-2", ["cursor", null, 2]],
    ["repo/he", ["hermes", null, 1]],
    ["repo/ag-4", ["agy", null, 4]],
    ["repo/scout", ["", "scout", 1]],
    ["repo/scout-2", ["", "scout-2", 1]],
    ["repo/", null],
    ["repo-codex", ["codex", null, 1]],
    ["repo-cx-2", ["codex", null, 2]],
    ["repo-c-0", ["claude", null, 1]],
    ["repo-codex-planner-3", ["codex", "planner", 3]],
    ["repo-codex-scout-0", ["codex", "scout", 1]],
    ["repo-codex-my-tag", ["codex", "my-tag", 1]],
    ["repo-zsh-1", null],
    ["other/codex", null],
    ["other-codex-2", null],
  ];
  for (const [name, parsed] of table) expect([name, parseSessionName(name, "repo")]).toEqual([name, parsed]);
  // The base is sanitized as allocation sanitizes it; an empty base parses nothing.
  expect(parseSessionName("my-repo/cx-2", "my repo")).toEqual(["codex", null, 2]);
  expect(parseSessionName("repo/codex", "")).toBeNull();

  expect(allocatedIndex("repo/codex-3", "repo", "codex")).toBe(3);
  expect(allocatedIndex("repo/codex-0", "repo", "codex")).toBe(1);
  expect(allocatedIndex("repo/codex-3", "repo", "claude")).toBe(1);
  expect(allocatedIndex("repo/scout-3", "repo", "codex")).toBe(1);
  expect(allocatedIndex("repo-codex-planner-4", "repo", "codex")).toBe(4);
});

test("C4a: an old-format acting registry refuses resume's record reads as old_store, never an empty roster", () => {
  const seat = { status: "active", delivery: "pane", harness: "codex", session: "repo/codex", pane: "", pane_id: "" };
  const world = fixture({ registry: { team: { name: "repo" }, agents: { codex: seat } } });
  const oldStoreClass = (read: () => unknown): string | null => {
    try { read(); return null; } catch (error) { return (error as { errorClass?: string }).errorClass ?? String(error); }
  };
  expect(oldStoreClass(() => registryState(world.root))).toBe("old_store");
  expect(oldStoreClass(() => registryEntry(world.root, "codex"))).toBe("old_store");
  expect(oldStoreClass(() => unexpiredSeats(world.root, null))).toBe("old_store");
  const current = fixture({ registry: { schema: "0.20", team: { name: "repo" }, seats: { codex: seat } } });
  expect(registryEntry(current.root, "codex")).toMatchObject({ harness: "codex" });
});

// The allocator's name authority (ported from test_server_epoch.py's
// ReclaimableCorpseTests when launcher.py's twin went, launch-ts row 6).
test("an absent name stamped under a prior server generation is offline, not reclaimable", () => {
  const entry = { session: "tap/sol", pane_id: "%5", pane: "tap/sol:1.1", server_epoch: "srv:111:1000", harness: "codex", status: "active" };
  expect(seatIsReclaimableCorpse(entry, new Set(), "srv:222:2000", null)).toBe(false);
  expect(seatIsReclaimableCorpse(entry, new Set(["tap/sol"]), "srv:222:2000", null)).toBe(false);
});

test("an unstamped row whose name the current snapshot omits is reclaimable, whatever its id resolves to", () => {
  const entry = { session: "tap/sol", pane_id: "%5", pane: "tap/sol:1.1", harness: "codex", status: "active" };
  expect(seatIsReclaimableCorpse(entry, new Set(), "srv:222:2000", null)).toBe(true);
  expect(seatIsReclaimableCorpse(entry, null, "srv:222:2000", null)).toBe(false);
});
