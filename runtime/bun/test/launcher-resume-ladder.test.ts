// launcher/resume.ts's lookup ladder: record-key precedence, harness-hinted
// candidate expansion, live reattach and its guards (membership, suspended
// rows, prior-generation rows), ported from test_launcher.py when cmd_resume
// became a door. In TS the acting registry IS the record store: each
// relaunchable row becomes a record, so Python's manifest and helper mocks are
// replaced here by registry rows and scripted tmux answers.
//
// Not ported (no TS seam): the bridge-transport arms. record-key-selection,
// resume-name-candidates and registry-resume-selection run in-process now, so
// the worker `failed` / `invalid` / `interrupted` / `transport` arms and the
// missing-bun naming arm have no subprocess to fail.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ResumeNamingValueError } from "../src/launcher/naming";
import type { LaunchRecord } from "../src/launcher/transaction";
import { fixture, options, paneLine, recorder, restoreEnvironment, resume } from "./support/resume-harness";

afterEach(restoreEnvironment);

const registryBytes = (root: string) => readFileSync(join(root, ".tap", "bus", "registry.json"));
/** An empty acting registry: present, so membership is gated (Python's save_registry_state with no sessions). */
const emptyRegistry = (team: string) => ({ schema: "0.20", team: { name: team }, seats: {} });
/** A pane pid no real process holds, so paneHarness's ps fallback observes nothing. */
const NO_PID = 99999999;

// ---- test_record_key_lookup_callers_preserve_precedence_and_refuse_worker_failure (resume arm) ----

test("record-key lookup: an exact session name beats an earlier row whose handle matches the key", async () => {
  const world = fixture({
    registry: { schema: "0.20", team: { name: "scope" }, seats: {
      seat: { status: "active", delivery: "pane", harness: "claude", session: "scope/vessel", tag: "seat" },
      codex: { status: "active", delivery: "pane", harness: "codex", session: "seat", tag: null },
    } },
    tmux: [{ match: "*has-session -t =*" }],
  });
  const { events, deps } = recorder({ hasTty: true });
  const result = await resume(world.root, options({ key: "seat" }), deps);
  expect(result.error).toBeNull();
  expect(result.code).toBe(0);
  expect(events).toEqual([["register", "seat", "codex"], ["attach", "resume", "seat"]]);
});

test("record-key lookup: with no exact session name, the handle match is selected", async () => {
  const world = fixture({
    registry: { schema: "0.20", team: { name: "scope" }, seats: {
      seat: { status: "active", delivery: "pane", harness: "claude", session: "scope/vessel", tag: "seat" },
    } },
    tmux: [{ match: "*has-session -t =*" }],
  });
  const { events, deps } = recorder({ hasTty: true });
  const result = await resume(world.root, options({ key: "seat" }), deps);
  expect(result.error).toBeNull();
  expect(events).toEqual([["register", "scope/vessel", "claude"], ["attach", "resume", "scope/vessel"]]);
});

// ---- test_resume_candidate_order_stops_at_match_and_keeps_earlier_lookup_and_membership ----

const CANDIDATES = ["meta/planner", "meta-claude-planner", "meta-claude-planner-0"];
const seatRow = (session: string, tag: string, extra: object = {}) =>
  ({ status: "active", delivery: "pane", harness: "claude", session, tag, index: 1, ...extra });
const ranNames = (events: ReturnType<typeof recorder>["events"]) =>
  events.filter(event => event[0] === "run").map(event => [event[1], event[2]]);

for (const [selectedIndex, selected] of CANDIDATES.entries()) {
  for (const refused of [false, true]) {
    test(`candidate expansion of claude planner-0 launches the first matching candidate ${selected}${refused ? " (membership refuses)" : ""}`, async () => {
      // Rows for the selected candidate and every later one, in reverse file
      // order, plus a codex decoy at the preceding candidate: the loop walks
      // candidate order, filters by harness, and stops at the first match.
      const agents: Record<string, object> = {};
      for (let j = CANDIDATES.length - 1; j > selectedIndex; j--) agents[`later${j}`] = seatRow(CANDIDATES[j]!, `later${j}`);
      if (selectedIndex > 0) agents.decoy = { ...seatRow(CANDIDATES[selectedIndex - 1]!, "decoy"), harness: "codex" };
      // A refused row keeps its record but its tag names no relaunchable row.
      agents[refused ? "stray" : "chosen"] = seatRow(selected, "chosen");
      const world = fixture({ registry: { schema: "0.20", team: { name: "meta" }, seats: agents } });
      const { events, deps } = recorder();
      const result = await resume(world.root, options({ key: "claude", legacyName: "planner-0", dryRun: true }), deps);
      if (refused) {
        expect(result.error?.message).toContain("'chosen' is not a relaunchable current seat");
        expect(events).toEqual([]);
      } else {
        expect(result.error).toBeNull();
        expect(result.code).toBe(0);
        expect(ranNames(events)).toEqual([["resume", selected]]);
      }
    });
  }
}

test("candidate expansion: the raw harness-hinted name lookup runs before any expanded candidate", async () => {
  // find_record(records, harness, name) is unscoped while the key lookup is
  // scoped to this root, so a record outside the root is found only by it.
  const world = fixture({ registry: { schema: "0.20", team: { name: "meta" }, seats: {
    first: seatRow("meta/planner", "first"),
    raw: seatRow("planner-0", "raw", { registered_from_worktree: "/elsewhere" }),
  } } });
  const { events, deps } = recorder();
  const result = await resume(world.root, options({ key: "claude", legacyName: "planner-0", dryRun: true }), deps);
  expect(result.error).toBeNull();
  expect(ranNames(events)).toEqual([["resume", "planner-0"]]);
});

for (const selected of CANDIDATES) {
  for (const refused of [false, true]) {
    test(`an exact record-key hit skips candidate expansion (${selected})${refused ? " and membership still refuses" : ""}`, async () => {
      // Decoys at every other candidate: expansion, had it run, would pick the first.
      const agents: Record<string, object> = {};
      for (const [j, other] of CANDIDATES.entries()) if (other !== selected) agents[`decoy${j}`] = seatRow(other, `decoy${j}`);
      agents[refused ? "stray" : "planner-0"] = seatRow(selected, "planner-0");
      const world = fixture({ registry: { schema: "0.20", team: { name: "meta" }, seats: agents } });
      const { events, deps } = recorder();
      const result = await resume(world.root, options({ key: "claude", legacyName: "planner-0", dryRun: true }), deps);
      if (refused) {
        expect(result.error?.message).toContain("'planner-0' is not a relaunchable current seat");
        expect(events).toEqual([]);
      } else {
        expect(result.error).toBeNull();
        expect(ranNames(events)).toEqual([["resume", selected]]);
      }
    });

    test(`a single-record harness family resolves without expansion (${selected})${refused ? " and membership still refuses" : ""}`, async () => {
      const world = fixture({ registry: { schema: "0.20", team: { name: "meta" }, seats: {
        other: { ...seatRow("meta/other", "other"), harness: "codex" },
        [refused ? "stray" : "only"]: seatRow(selected, "only"),
      } } });
      const { events, deps } = recorder();
      const result = await resume(world.root, options({ key: "claude", dryRun: true }), deps);
      if (refused) {
        expect(result.error?.message).toContain("'only' is not a relaunchable current seat");
        expect(events).toEqual([]);
      } else {
        expect(result.error).toBeNull();
        expect(ranNames(events)).toEqual([["resume", selected]]);
      }
    });
  }
}

// ---- test_resume_naming_failure_never_attaches_or_launches ----

test("a resume name past the integer-digit limit fails in naming, before any attach, membership or launch", async () => {
  const world = fixture({ registry: emptyRegistry("meta"), env: { PYTHONINTMAXSTRDIGITS: "640" } });
  const { events, deps } = recorder({ hasTty: true });
  const result = await resume(world.root, options({ key: "claude", legacyName: "9".repeat(641) }), deps);
  expect(result.error).toBeInstanceOf(ResumeNamingValueError);
  expect(result.error?.message).toContain("Exceeds the limit (640 digits)");
  expect(events).toEqual([]);
  expect(world.tmuxCalls().every(call => call.includes("has-session"))).toBe(true);
});

// ---- test_named_resume_reattaches_live_registry_session_before_native_resume ----

test("a named resume of a live session name reattaches (register, attach) and never builds a native resume", async () => {
  const world = fixture({
    registry: { schema: "0.20", team: { name: "repo" }, seats: {
      scout: { status: "active", delivery: "pane", session: "repo/scout", harness: "claude", tag: "scout", index: 1,
        pane: "repo/scout:9.9", pane_id: "%201", harness_session_id: "11111111-1111-4111-8111-111111111111" },
    } },
    tmux: [{ match: "*has-session -t =repo/scout" }],
  });
  const { events, deps } = recorder({ hasTty: true });
  const result = await resume(world.root, options({ key: "repo/scout" }), deps);
  expect(result.error).toBeNull();
  expect(result.code).toBe(0);
  expect(events).toEqual([["register", "repo/scout", "claude"], ["attach", "resume", "repo/scout"]]);
});

// ---- test_named_resume_refuses_untracked_live_agent_session ----

test("a live agent session with no registry row is refused by membership, never registered or attached", async () => {
  const world = fixture({
    registry: emptyRegistry("repo"),
    tmux: [
      { match: "*has-session -t =repo/fable" },
      { match: "*display-message -p -t =repo/fable *", stdout: paneLine("repo/fable:0.0", "%42", "claude") },
    ],
  });
  const { events, deps } = recorder({ hasTty: true });
  const result = await resume(world.root, options({ key: "repo/fable" }), deps);
  expect(result.error?.message).toContain("'fable' is not a relaunchable current seat");
  expect(events).toEqual([]);
});

// ---- test_named_resume_refuses_untracked_live_non_agent_session ----

test("a live non-agent session with no registry row has no seat to reattach and is refused", async () => {
  const world = fixture({
    registry: emptyRegistry("repo"),
    tmux: [
      { match: "*has-session -t =repo/mystery" },
      { match: "*display-message -p -t =repo/mystery *", stdout: paneLine("repo/mystery:0.0", "%42", "zsh", NO_PID) },
    ],
  });
  const { events, deps } = recorder({ hasTty: true });
  const result = await resume(world.root, options({ key: "repo/mystery" }), deps);
  expect(result.error?.message).toContain("no relaunchable acting-registry seat");
  expect(result.error?.message).toContain("repo/mystery");
  expect(events).toEqual([]);
});

// ---- test_two_argument_resume_refuses_untracked_live_session ----

test("a two-argument resume expands to a live untracked session and is refused by membership", async () => {
  const world = fixture({
    registry: emptyRegistry("repo"),
    tmux: [
      { match: "*has-session -t =repo-claude-ghost" },
      { match: "*display-message -p -t =repo-claude-ghost *", stdout: paneLine("repo-claude-ghost:0.0", "%42", "claude") },
    ],
  });
  const { events, deps } = recorder({ hasTty: true });
  const result = await resume(world.root, options({ key: "claude", legacyName: "ghost" }), deps);
  expect(result.error?.message).toContain("'ghost' is not a relaunchable current seat");
  expect(events).toEqual([]);
  // The bare name is probed first, then its expansion.
  const probes = world.tmuxCalls().filter(call => call.includes("has-session")).map(call => call.slice(call.indexOf("-t =") + 4));
  expect(probes.slice(0, 2)).toEqual(["ghost", "repo-claude-ghost"]);
});

// ---- test_expanded_resume_registry_selection_obeys_membership_before_attach ----

const TARGET = "repo-claude-ghost";
function tagRecorder() {
  const made = recorder({ hasTty: true });
  const tags: (string | null | undefined)[] = [];
  const register = made.deps.register;
  made.deps.register = async (record: LaunchRecord) => { tags.push(record.tag); return register(record); };
  return { ...made, tags };
}
const liveRecordProbe = (world: ReturnType<typeof fixture>) => world.tmuxCalls().some(call => call.includes(`display-message -p -t =${TARGET} `));

for (const [label, row] of [
  ["a session row", { session: TARGET }],
  ["a pane-only row (the registry selection path)", { pane: `${TARGET}:0.0` }],
] as const) {
  test(`an expanded live name selects its registry owner (${label}), passes membership, then reattaches`, async () => {
    const world = fixture({ tmux: [{ match: `*has-session -t =${TARGET}` }] });
    world.writeRegistry({ schema: "0.20", team: { name: "repo" }, seats: { owner: { status: "active", delivery: "pane", harness: "claude",
      registered_from_worktree: world.root, ...row } } });
    const { events, deps, tags } = tagRecorder();
    const result = await resume(world.root, options({ key: "claude", legacyName: "ghost" }), deps);
    expect(result.error).toBeNull();
    expect(result.code).toBe(0);
    expect(events).toEqual([["register", TARGET, "claude"], ["attach", "resume", TARGET]]);
    expect(tags).toEqual(["owner"]);
    expect(liveRecordProbe(world)).toBe(false);
  });
}

test("an expanded live name whose registry owner is not relaunchable is refused by membership before any attach", async () => {
  const world = fixture({ tmux: [{ match: `*has-session -t =${TARGET}` }] });
  world.writeRegistry({ schema: "0.20", team: { name: "repo" }, seats: { owner: { status: "active", delivery: "poll", harness: "claude",
    session: TARGET, registered_from_worktree: world.root } } });
  const { events, deps } = recorder({ hasTty: true });
  const result = await resume(world.root, options({ key: "claude", legacyName: "ghost" }), deps);
  expect(result.error?.message).toContain("'owner' is not a relaunchable current seat");
  expect(events).toEqual([]);
  // The registry selection answered; the live-pane record was never consulted.
  expect(liveRecordProbe(world)).toBe(false);
});

// ---- test_harness_resume_does_not_adopt_create_from_failed_iterator_member ----

test("a harness-family resume ignores failed rows: one live member reattaches, no adopted third seat", async () => {
  const cursor = (handle: string, extra: object) => ({ delivery: "pane", harness: "cursor", session: `repo/${handle}`, tag: handle,
    harness_session_id: `id-${handle}`, ...extra });
  const world = fixture({ tmux: [{ match: "*has-session -t =repo/live" }] });
  world.writeRegistry({ schema: "0.20", team: { name: "repo", worktree_root: world.root }, seats: {
    live: cursor("live", { status: "active", registered_from_worktree: world.root }),
    gone: cursor("gone", { status: "suspended", status_reason: "pane_gone", registered_from_worktree: world.root }),
  } });
  const { events, deps } = recorder({ hasTty: true });
  const result = await resume(world.root, options({ key: "cursor" }), deps);
  expect(result.error).toBeNull();
  expect(result.code).toBe(0);
  expect(events).toEqual([["register", "repo/live", "cursor"], ["attach", "resume", "repo/live"]]);
});

// ---- test_failed_row_with_live_name_cannot_rebind_occupant ----

test("a failed (suspended/session_replaced) row whose name is live refuses to rebind the occupant", async () => {
  const world = fixture({
    registry: { schema: "0.20", team: { name: "repo" }, seats: {
      coach: { status: "suspended", status_reason: "session_replaced", delivery: "pane", harness: "cursor", session: "repo/coach",
        tag: "coach", harness_session_id: "id-coach" },
    } },
    tmux: [{ match: "*has-session -t =*" }],
  });
  const before = registryBytes(world.root);
  const { events, deps } = recorder({ hasTty: true });
  const result = await resume(world.root, options({ key: "coach" }), deps);
  expect(result.error?.message).toContain("repo/coach is live while its retained row is suspended/session_replaced");
  expect(result.error?.message).toContain("no registration changed");
  expect(events).toEqual([]);
  expect(registryBytes(world.root).equals(before)).toBe(true);
});

// ---- test_prior_boot_live_occupant_refuses_before_registration ----

for (const stale of [true, false]) {
  test(`a live occupant whose row stamps ${stale ? "a prior" : "the current"} server ${stale ? "refuses before registration" : "reattaches"}`, async () => {
    const world = fixture({
      registry: { schema: "0.20", team: { name: "repo" }, seats: {
        coach: { status: "suspended", status_reason: "server_restarted", delivery: "pane", harness: "cursor", session: "repo/coach",
          tag: "coach", server_socket: "/tmp/fixture-sock", server_epoch: stale ? "srv:9:9" : "srv:1:1" },
      } },
      tmux: [
        { match: "*has-session -t =repo/coach" },
        // generation.ts's socket observation (TAP_SERVER_EPOCH pins the epoch to srv:1:1).
        { match: "*display-message -p *socket_path*", stdout: "1:1\t/tmp/fixture-sock\n" },
      ],
    });
    const before = registryBytes(world.root);
    const { events, deps } = recorder({ hasTty: true });
    const result = await resume(world.root, options({ key: "coach" }), deps);
    if (stale) {
      expect(result.error?.message).toContain("repo/coach is live but the retained row belongs to a prior boot/server");
      expect(events).toEqual([]);
      expect(registryBytes(world.root).equals(before)).toBe(true);
    } else {
      expect(result.error).toBeNull();
      expect(events).toEqual([["register", "repo/coach", "cursor"], ["attach", "resume", "repo/coach"]]);
    }
  });
}
