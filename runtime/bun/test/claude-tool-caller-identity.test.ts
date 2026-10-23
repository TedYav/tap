import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { removeScratchTree } from "./support/scratch";

// Ported from skills/tap/scripts/smoke/claude-tool-caller-identity.test.sh
// (deleted in this PR): Claude Code's desktop-backed Bash tool has no TMUX
// variables, its process ancestry ends at launchd, and its controlling tty is
// not the tmux pane tty. A background daemon's validated job owner may recover
// its active Claude row even though the daemon and interactive pane have
// different session ids, but only after that row's pane and generation are
// freshly verified.
//
// The fixture drives the real installed doors (bin/tap whoami/in/self/compact
// and session-start.ts context) against the committed process mocks in
// fixtures/claude-caller/ — a ps whose ancestry ends `1 ttys003` and a tmux
// that answers only the formats the resolver, transaction probe and submit
// path use. Arms mutate one shared fixture tree in file order, exactly like
// the deleted shell case did with its write_one/write_job resets.
//
// Scratch allocation is the runner-owned TMUX_TMPDIR (see
// resolve-session-root.test.ts); this file refuses to run without it.

const REPO = realpathSync(join(import.meta.dir, "..", "..", ".."));
const BIN_TAP = join(REPO, "bin", "tap");
const SESSION_START = join(REPO, "runtime", "bun", "src", "session-start.ts");
const SRC = join(REPO, "runtime", "bun", "src");

const RUNNER_ROOT = process.env.TMUX_TMPDIR;
if (!RUNNER_ROOT) {
  throw new Error(
    "claude-tool-caller-identity.test.ts: TMUX_TMPDIR is unset — this fixture allocates only beneath the supported runner's scratch root (runtime/bun/test/run.sh exports it); refusing to write outside it",
  );
}
const WORK = mkdtempSync(join(RUNNER_ROOT, "tap-caller-id."));
afterAll(() => removeScratchTree(WORK));

const FIXTURE = join(WORK, "team");
const BUS = join(FIXTURE, ".tap", "bus");
const REG = join(BUS, "registry.json");
const BIN = join(WORK, "bin");
const JOB = join(WORK, "jobs", "bg123456");
const HISTORY = join(FIXTURE, ".tap", "team-history");
const CLAUDE_STORE = join(WORK, ".claude", "projects", FIXTURE.replaceAll("/", "-"));

mkdirSync(join(BUS, "payloads"), { recursive: true });
mkdirSync(join(BUS, "receipts"), { recursive: true });
mkdirSync(BIN, { recursive: true });
mkdirSync(JOB, { recursive: true });
mkdirSync(HISTORY, { recursive: true });
mkdirSync(CLAUDE_STORE, { recursive: true });
closeSync(openSync(join(CLAUDE_STORE, "daemon-session.jsonl"), "w"));
symlinkSync(process.execPath, join(BIN, "bun"));
for (const mock of ["ps", "tmux"]) {
  const dest = join(BIN, mock);
  symlinkSync(join(import.meta.dir, "fixtures", "claude-caller", mock), dest);
}

function seatRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "active",
    delivery: "pane",
    harness: "claude",
    harness_session_id: "interactive-session",
    instance: "fable|fixture",
    pane: "T/fable:0.0",
    pane_id: "%9",
    session: "T/fable",
    server_epoch: "srv:900:200",
    server_socket: "/fixture/tmux.sock",
    ...extra,
  };
}

/** The one healthy fixture row, plus the owner lineage record. */
function writeOne(): void {
  writeFileSync(
    REG,
    `${JSON.stringify({ schema: "0.20", team: { name: "T", worktree_root: FIXTURE }, seats: { fable: seatRow() } })}\n`,
  );
  writeFileSync(join(HISTORY, "fable.lineage.jsonl"), `${JSON.stringify({ instance: "fable|fixture", ts: "2026-09-18T00:00:00Z" })}\n`);
}

function writeJob(name: string): void {
  writeFileSync(
    join(JOB, "state.json"),
    `${JSON.stringify({ template: "bg", sessionId: "bg-session", name, cwd: FIXTURE, createdAt: "2026-09-18T00:00:01Z" })}\n`,
  );
}

function appendLineage(record: { instance: string; ts: string }): void {
  const path = join(HISTORY, "fable.lineage.jsonl");
  writeFileSync(path, readFileSync(path, "utf8") + `${JSON.stringify(record)}\n`);
}

/** Port of tap_smoke_enroll_current for the canonical bus: the acting registry
 *  moves to <root>/.tap/team-registry.json, the bus registry.json becomes a
 *  symlink to it, and the machine index gets the team marker. */
function enroll(): void {
  const acting = join(FIXTURE, ".tap", "team-registry.json");
  if (existsSync(acting)) throw new Error("enroll: acting registry already seeded");
  renameSync(REG, acting);
  symlinkSync("../team-registry.json", REG);
  const index = join(WORK, "index");
  mkdirSync(index, { recursive: true });
  const gpath = join(index, "global-registry.json");
  const doc = existsSync(gpath) ? JSON.parse(readFileSync(gpath, "utf8")) : { schema: "0.20", teams: {} };
  doc.teams["T"] = { root: realpathSync(FIXTURE), registry_location: realpathSync(acting), state: "registered" };
  writeFileSync(gpath, `${JSON.stringify(doc)}\n`);
}

type Env = Record<string, string>;

/** Runner sandbox pins the deleted shell inherited (`env -u` only dropped
 *  TMUX, TMUX_PANE and TAP_HARNESS_SESSION_ID). Seeding them keeps every
 *  child inside the runner's sandbox — without TMUX, a child that escaped
 *  the mock PATH would land on the operator's default tmux server. */
const RUNNER_PINS = [
  "TMUX_TMPDIR",
  "TAP_LOCK_DIR",
  "TAP_NOTIFY_USER_BIN",
  "EPISODIC_MEMORY_SUMMARIZER_GUARD",
  "TAP_SESSION_MANIFEST",
  "OPENCODE_DB_PATH",
  "TAP_VERSION_SEEN_PATH",
] as const;

function runnerPins(): Env {
  const pins: Env = {};
  for (const key of RUNNER_PINS) {
    const value = process.env[key];
    if (value !== undefined) pins[key] = value;
  }
  return pins;
}

function baseEnv(extra: Env = {}): Env {
  return {
    ...runnerPins(),
    PATH: `${BIN}:/usr/bin:/bin:/opt/homebrew/bin`,
    HOME: WORK,
    TAP_HOME: BUS,
    TAP_INDEX_HOME: join(WORK, "index"),
    TMUX_MOCK_REGISTRY: REG,
    TMUX_MOCK_PANE_PATH: FIXTURE,
    TMUX_MOCK_REQUIRE_TRANSACTION_SOCKET: "1",
    CLAUDE_CODE_SESSION_ID: "bg-session",
    CLAUDE_JOB_DIR: JOB,
    ...extra,
  };
}

/** The interactive-session environment: no job dir, a live session id. */
function sessionEnv(extra: Env = {}): Env {
  return {
    ...runnerPins(),
    PATH: `${BIN}:/usr/bin:/bin:/opt/homebrew/bin`,
    HOME: WORK,
    TAP_HOME: BUS,
    TAP_INDEX_HOME: join(WORK, "index"),
    CLAUDE_CODE_SESSION_ID: "session-live",
    ...extra,
  };
}

function tap(
  args: string[],
  opts: { env?: Env; cwd?: string } = {},
): { stdout: string; stderr: string; combined: string; status: number | null } {
  const r = spawnSync(BIN_TAP, args, {
    encoding: "utf8",
    cwd: opts.cwd ?? REPO,
    env: opts.env ?? baseEnv(),
    input: "",
  });
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  return { stdout, stderr, combined: stdout + stderr, status: r.status };
}

function sessionStartContext(root: string, env: Env): string {
  const r = spawnSync(process.execPath, [SESSION_START, "context", root], {
    encoding: "utf8",
    env,
    input: '{"hook_event_name":"SessionStart","source":"startup"}',
  });
  return (r.stdout ?? "") + (r.stderr ?? "");
}

function setRegistry(doc: unknown): void {
  writeFileSync(REG, `${JSON.stringify(doc)}\n`);
}

function readRegistry(): { seats: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(REG, "utf8"));
}

function mutateSeat(fn: (seat: Record<string, unknown>) => void): void {
  const doc = readRegistry();
  fn(doc.seats.fable!);
  setRegistry(doc);
}

writeOne();
writeJob("T/fable");
enroll();

test("native whoami binds a validated Claude background owner without TMUX", () => {
  const r = tap(["whoami"]);
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe("fable");
});

test("background recovery proves outside against the selected private socket when default tmux is absent", () => {
  const r = tap(["whoami"], { env: baseEnv({ TMUX_MOCK_DEFAULT_UNAVAILABLE: "1" }) });
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe("fable");
});

test("socketless legacy rows remain readable through the default tmux namespace", () => {
  // Socket provenance was added after the registry row existed. Legacy rows
  // stay readable: observe them through the incumbent default tmux namespace,
  // without inventing a socket claim to pin downstream.
  mutateSeat((seat) => delete seat.server_socket);
  const r = tap(["whoami"], { env: baseEnv({ TMUX_MOCK_REQUIRE_TRANSACTION_SOCKET: "0" }) });
  expect({ status: r.status, who: r.stdout.trim() }).toEqual({ status: 0, who: "fable" });
  writeOne();
});

test("implicit tap in re-registers the owner without scanning daemon session metadata", () => {
  const r = tap(["in"], { env: baseEnv({ TAP_VERBOSE: "1" }) });
  expect(r.status, r.combined).toBe(0);
  const hook = sessionStartContext(FIXTURE, baseEnv());
  expect(hook).toContain("TAP: registered as fable on team T.");
  // The interactive owner identity survives the re-registration untouched.
  const seat = readRegistry().seats.fable!;
  expect(seat.harness_session_id).toBe("interactive-session");
  for (const key of ["derived_harness_session_id", "session_store_path", "session_store_kind"]) {
    expect(seat).not.toHaveProperty(key);
  }
});

test("verified Claude context preserves its selected handle", () => {
  setRegistry({
    schema: "0.20",
    team: { name: "T", worktree_root: FIXTURE },
    seats: {
      // instance: undefined drops the key in JSON.stringify — the decoy row is
      // deliberately incomplete, so only a complete fable row can be selected.
      aaa: seatRow({ harness_session_id: "other-session", instance: undefined as unknown as string }),
      fable: seatRow(),
    },
  });
  const r = tap(["whoami"]);
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe("fable");
});

test("background jobs refuse after the named seat instance is replaced", () => {
  mutateSeat((seat) => {
    seat.instance = "fable|successor";
  });
  appendLineage({ instance: "fable|successor", ts: "2026-09-18T00:00:02Z" });
  const r = tap(["whoami"]);
  expect(r.status).not.toBe(0);
  expect(r.combined).toContain("caller pane is not observable");
  writeOne();
});

test("whole-second lineage refuses creation-second ordering ambiguity", () => {
  mutateSeat((seat) => {
    seat.instance = "fable|same-second-successor";
  });
  appendLineage({ instance: "fable|same-second-successor", ts: "2026-09-18T00:00:01Z" });
  const r = tap(["whoami"]);
  expect(r.status).not.toBe(0);
  expect(r.combined).toContain("caller pane is not observable");
  writeOne();
});

test("whoami rechecks the selected instance at the final registry read", () => {
  const flag = join(WORK, "replace-on-observe-who");
  rmSync(flag, { force: true });
  const r = tap(["whoami"], { env: baseEnv({ TMUX_MOCK_REPLACE_ON_OBSERVE_FILE: flag }) });
  expect(r.status).not.toBe(0);
  expect(r.combined).toMatch(/caller pane is not observable|pane %9 is not registered/);
});

test("tap in rechecks the selected instance under the registry lock", () => {
  writeOne();
  const flag = join(WORK, "replace-on-observe-in");
  rmSync(flag, { force: true });
  const r = tap(["in"], { env: baseEnv({ TMUX_MOCK_REPLACE_ON_OBSERVE_FILE: flag }) });
  expect(r.status).not.toBe(0);
  expect(r.combined).toContain("owner instance changed");
});

test("job ownership uses selector-derived acting team and root", () => {
  // A stale team name and worktree_root embedded in the registry document
  // never win: TAP_HOME/TAP_INDEX_HOME select the acting team and root.
  setRegistry({
    schema: "0.20",
    team: { name: "stale", worktree_root: join(WORK, "stale-root") },
    seats: { fable: seatRow() },
  });
  const r = tap(["whoami"]);
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe("fable");
});

test("observed-pane failures do not switch to a registry-selected pane", () => {
  // Route the observed-but-changed pane refusal (a tty mismatch between the
  // registered pane_id and what tmux reports live) through the native door; if
  // this starts failing, it is a real production question: does the native
  // resolver still refuse a changed pane, or does it fall through to the
  // job-owner arm?
  writeOne();
  const r = tap(["whoami"], { env: baseEnv({ TMUX_MOCK_CHANGED: "1" }) });
  expect(r.status).not.toBe(0);
});

test("compact actor resolution remains process-owned", () => {
  // A compact that proceeded without a verified actor would attempt pane
  // effects on the target; the refusal must happen before any of them.
  const effects = join(WORK, "compact-actor-effects.log");
  rmSync(effects, { force: true });
  const r = tap(["compact", "fable", "-m", "preserve active work"], {
    env: baseEnv({ TMUX_MOCK_EFFECT_LOG: effects }),
  });
  expect(r.status).not.toBe(0);
  expect(r.combined).toContain("tap command must run from a registered pane");
  expect(existsSync(effects) ? readFileSync(effects, "utf8") : "").toBe("");
});

test("duplicate native session ids refuse instead of choosing a row", () => {
  setRegistry({
    schema: "0.20",
    team: { name: "T", worktree_root: FIXTURE },
    seats: {
      fable: seatRow({ harness_session_id: "session-live" }),
      copy: seatRow({ pane: "T/copy:0.0", pane_id: "%10", session: "T/copy", harness_session_id: "session-live" }),
    },
  });
  const r = tap(["whoami"], { env: sessionEnv() });
  expect(r.status).not.toBe(0);
  expect(r.combined).toContain("caller pane is not observable");
});

test("incomplete registry identity cannot authorize the fallback", () => {
  setRegistry({
    schema: "0.20",
    team: { name: "T", worktree_root: FIXTURE },
    seats: {
      fable: {
        status: "active",
        delivery: "pane",
        harness: "claude",
        harness_session_id: "interactive-session",
        pane: "T/fable:0.0",
        pane_id: "%9",
        session: "T/fable",
      },
    },
  });
  const r = tap(["whoami"]);
  expect(r.status).not.toBe(0);
  expect(r.combined).toContain("caller pane is not observable");
});

test("fallback observes only the registry row's recorded tmux socket", () => {
  writeOne();
  mutateSeat((seat) => {
    seat.server_socket = "/fixture/wrong.sock";
  });
  const r = tap(["whoami"]);
  expect(r.status).not.toBe(0);
});

const SELF_GOAL = "Finish docs/plans/x.md: smoke exit 0 proves it. Stop after 5 turns.";

test("tap self resolves a background job owner and keeps its effects on the selected socket", () => {
  writeOne();
  writeJob("T/fable");
  const effects = join(WORK, "self-effects.log");
  rmSync(effects, { force: true });
  const r = tap(["self", "goal", "--", SELF_GOAL], {
    env: baseEnv({ TMUX_MOCK_EFFECT_LOG: effects }),
    cwd: FIXTURE,
  });
  expect(r.stderr).not.toContain("cannot resolve own pane");
  expect(readFileSync(effects, "utf8")).toMatch(/^1 capture-pane$/m);
  expect(readFileSync(effects, "utf8")).not.toMatch(/^0 /m);
}, 60000);

test("tap self carries the background owner witness into the submit and refuses a successor", () => {
  writeOne();
  const effects = join(WORK, "self-effects.log");
  rmSync(effects, { force: true });
  const replaced = join(WORK, "self-replaced");
  rmSync(replaced, { force: true });
  const r = tap(["self", "goal", "--", SELF_GOAL], {
    env: baseEnv({ TMUX_MOCK_EFFECT_LOG: effects, TMUX_MOCK_REPLACE_ON_CAPTURE_FILE: replaced }),
    cwd: FIXTURE,
  });
  expect(r.status).toBe(1);
  expect(readFileSync(effects, "utf8")).not.toMatch(/ send-keys$/m);
}, 60000);

test("SessionStart distinguishes caller-unobservable from unregistered", () => {
  setRegistry({
    schema: "0.20",
    team: { name: "T", worktree_root: FIXTURE },
    seats: { fable: seatRow({ harness_session_id: "bg-session" }) },
  });
  writeJob("T/missing");
  const unseen = sessionStartContext(FIXTURE, baseEnv());
  expect(unseen).toContain("caller pane is not observable");
});

test("tap in and tap self share the verified caller resolver", () => {
  // Source wiring pins: the native doors resolve the caller pane in-process
  // (context.ts observeCallerPaneChain), never through a Bash function, and
  // every consumer carries the verified witness forward.
  expect(readFileSync(join(SRC, "verbs", "register.ts"), "utf8")).toContain("observeCallerPaneChain(env, process.cwd(), true)");
  expect(readFileSync(join(SRC, "context.ts"), "utf8")).toContain("const seen = observeCallerIdentity(env);");
  // The SessionStart entry anchors the harness-session row lookup to the root
  // it already resolved, never the hook process's cwd (a cwd inside another
  // enrolled repo would reselect that repo's registry; review P1).
  expect(readFileSync(join(SRC, "session-start.ts"), "utf8")).toContain("TAP_HARNESS_SESSION_ID: sessionId }, root, false, launch?.seen);");
  expect(readFileSync(join(SRC, "context.ts"), "utf8")).toContain(
    'observeHarnessSessionPane(typeof anchor === "string" ? resolveContext(anchor, env) : anchor, env)',
  );
  const register = readFileSync(join(SRC, "verbs", "register.ts"), "utf8");
  expect(register).toContain("env.TAP_TMUX_SOCKET_PATH = chain.selectedSocket");
  expect(register).toContain(
    'const suppressCapture = env.TAP_REGISTER_SUPPRESS_IDENTITY_CAPTURE === "1" || env.TAP_CALLER_SELECTED_JOB === "1";',
  );
  expect(register).toContain('env.TAP_CALLER_SELECTED_JOB = "1"');
  expect(register).toContain('env.TAP_REGISTER_SUPPRESS_IDENTITY_CAPTURE = "1";');
  expect(readFileSync(join(SRC, "self-compact.ts"), "utf8")).toContain("process.env.TAP_CALLER_SELECTED_INSTANCE");
});
