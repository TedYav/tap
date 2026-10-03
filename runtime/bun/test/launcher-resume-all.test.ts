// resume --all / team up cohort owner. Ports the deleted Python unit tests
// (test_team_only, test_launch_callers cohort cases, RebootMembershipTests,
// malformed-stamp and fresh-start pins) and adds the receipt/summary matrix.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { namespaceSnapshot, staleSeatGeneration, type Observation } from "../src/launcher/generation";
import { InvocationError } from "../src/launcher/invocation";
import { LaunchCommandError } from "../src/launcher/process";
import { duplicateRegistrySessionOwner } from "../src/launcher/identity-owner";
import { bootstrapTmux, onlyToExcepted, popHandles, rebootResumeRecords, resumeAll, type Options, type ResumeAllDeps } from "../src/launcher/resume-all";
import { LaunchInterrupted, TransactionError, type LaunchRecord } from "../src/launcher/transaction";
import { LauncherError } from "../src/launcher/types";
import { render } from "../src/launcher/resume-prelude";
import { writeLiveFence } from "./support/live-fence";

type Row = Record<string, unknown>;
const ENTRY = resolve(import.meta.dir, "../src/launcher/resume-all.ts");
const saved = { ...process.env };
afterEach(() => {
  for (const key of ["TAP_TEAM_ONLY_HANDLES", "TAP_TEAM_EXCEPT_HANDLES", "PATH", "TAP_BOOT_ID", "TAP_BOOT_ID_LEGACY", "TAP_INDEX_HOME", "TAP_HOME"]) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});

function fixture(rows: (root: string) => Record<string, Row>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "resume-all-")));
  const registry = join(root, ".tap/bus/registry.json");
  mkdirSync(join(root, ".tap/bus"), { recursive: true });
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture", worktree_root: root }, seats: rows(root) }));
  return { root, registry, index: enrollFixture(root) };
}
/** Born live (F1): the entry resolves the team through an enrolled index; afterEach restores TAP_INDEX_HOME. */
function enrollFixture(root: string): string {
  const index = realpathSync(mkdtempSync(join(tmpdir(), "resume-all-index-")));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20",
    teams: { fixture: { root, registry_location: join(root, ".tap/bus/registry.json"), state: "registered" } } }));
  process.env.TAP_INDEX_HOME = index;
  return index;
}
const seat = (root: string, tag: string, extra: Row = {}): Row => ({ status: "suspended", status_reason: "session_stopped", delivery: "pane",
  harness: "claude", session: `fixture/${tag}`, registered_from_worktree: root, base: "fixture", tag, index: 1, ...extra });
const record = (name: string, tag: string | null): LaunchRecord => ({ name, harness: "claude", cwd: "/tmp/demo", base: "demo", tag } as LaunchRecord);
const options = (over: Partial<Options> = {}): Options => ({ dryRun: false, json: false, model: null, teams: false, key: null, legacyName: null, ...over });
const unknown: Observation = { boot: null, epoch: null, socket: "" };

function deps(over: Partial<ResumeAllDeps> = {}) {
  const calls: Array<{ kind: string; record: LaunchRecord; live?: string[] }> = [];
  const value: ResumeAllDeps = {
    run: async (kind, rec, extra) => { calls.push({ kind, record: { ...rec }, live: extra?.live_sessions }); return 0; },
    bootstrap: async () => {}, namespace: async () => new Set(), observe: async () => unknown,
    hasTty: () => false, confirm: () => { throw new Error("must not prompt"); }, ...over,
  };
  return { value, calls };
}

async function captured<T>(work: () => Promise<T>): Promise<{ value: T; out: string; err: string }> {
  let out = "", err = "";
  const write = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = ((chunk: string | Uint8Array) => { out += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { err += String(chunk); return true; }) as typeof process.stderr.write;
  try { return { value: await work(), out, err }; }
  finally { process.stdout.write = write.out; process.stderr.write = write.err; }
}

// ---- only/except resolution (was test_team_only.py) ----

test("--only spares every candidate record not named, including an untagged one", () => {
  const records = [record("demo/kimi", "kimi"), record("demo/grok", "grok"), record("demo/sonnet", "sonnet")];
  expect(onlyToExcepted(records, new Set(["kimi"]))).toEqual(new Set(["grok", "sonnet"]));
  expect(onlyToExcepted(records.slice(0, 2), new Set(["kimi", "grok"]))).toEqual(new Set());
  // An untagged record has no registry row; the complement is taken over records.
  expect(onlyToExcepted([record("demo/kimi", "kimi"), record("demo/adopted", null)], new Set(["kimi"]))).toEqual(new Set(["adopted"]));
  // An unknown handle never widens the action.
  expect(onlyToExcepted(records.slice(0, 2), new Set(["typo"]))).toEqual(new Set(["kimi", "grok"]));
});

test("the team up handle blob splits, drops blanks, and is popped", () => {
  expect(popHandles("TAP_TEAM_ONLY_HANDLES")).toEqual(new Set());
  process.env.TAP_TEAM_ONLY_HANDLES = "kimi\ngrok\n\n";
  expect(popHandles("TAP_TEAM_ONLY_HANDLES")).toEqual(new Set(["kimi", "grok"]));
  expect(process.env.TAP_TEAM_ONLY_HANDLES).toBeUndefined();
});

// ---- generation (was RebootMembershipTests / test_malformed_stamps_are_not_comparable) ----

test("only a readable same-socket observation proves a stored stamp stale", () => {
  process.env.TAP_BOOT_ID = "boot:200"; delete process.env.TAP_BOOT_ID_LEGACY;
  const row = { server_socket: "/tmp/test", boot_id: "boot:100", server_epoch: "srv:1:100" };
  expect(staleSeatGeneration(row, { boot: "boot:200", epoch: "srv:2:200", socket: "/tmp/test" })).toBe(true);
  expect(staleSeatGeneration(row, { boot: "boot:100", epoch: "srv:1:100", socket: "/tmp/test" })).toBe(false);
  for (const observation of [unknown, { boot: "boot:200", epoch: null, socket: "/tmp/test" }, { boot: "boot:200", epoch: "srv:2:200", socket: "/tmp/other" }]) {
    expect(staleSeatGeneration(row, observation)).toBe(false);
  }
  expect(staleSeatGeneration({ server_socket: "/tmp/test" }, { boot: "boot:200", epoch: "srv:2:200", socket: "/tmp/test" })).toBe(false);
  for (const value of ["garbage", " ", "bootuuid:no", "srv:wrong"]) {
    for (const field of ["boot_id", "server_epoch"]) {
      expect(staleSeatGeneration({ server_socket: "/tmp/test", [field]: value }, { boot: "boot:200", epoch: "srv:2:200", socket: "/tmp/test" })).toBe(false);
    }
  }
  // A uuid stamp is not comparable with a seconds-shaped current boot.
  expect(staleSeatGeneration({ server_socket: "/tmp/test", boot_id: "bootuuid:12345678-1234-1234-1234-123456789abc" },
    { boot: "boot:200", epoch: "srv:2:200", socket: "/tmp/test" })).toBe(false);
});

test("legacy boot stamps within five seconds of the current boot are the same boot", () => {
  process.env.TAP_BOOT_ID = "bootuuid:12345678-1234-1234-1234-123456789abc"; process.env.TAP_BOOT_ID_LEGACY = "boot:1000";
  const observation = { boot: "boot:1003", epoch: "srv:1:1", socket: "/s" };
  expect(staleSeatGeneration({ server_socket: "/s", boot_id: "boot:998" }, observation)).toBe(false);
  expect(staleSeatGeneration({ server_socket: "/s", boot_id: "boot:990" }, observation)).toBe(true);
});

test("reboot recovery keeps only suspended pane seats of a proven prior generation", () => {
  process.env.TAP_BOOT_ID = "boot:200"; delete process.env.TAP_BOOT_ID_LEGACY;
  const rows = new Map<string, Row>();
  for (const [name, delta] of Object.entries({ eligible: {}, removed: { status_reason: "user_removed" }, poll: { delivery: "poll" },
    crew: { crew: true }, unstamped: { boot_id: null, server_epoch: null } } as Record<string, Row>)) {
    rows.set(name, { status: "suspended", status_reason: "pane_gone", delivery: "pane", harness: "cursor", session: `repo/${name}`, tag: name,
      harness_session_id: `id-${name}`, server_socket: "/tmp/test", boot_id: "boot:100", server_epoch: "srv:1:100", ...delta });
  }
  const before = JSON.stringify([...rows]);
  const records = rebootResumeRecords("/repo", rows, { boot: "boot:200", epoch: "srv:2:200", socket: "/tmp/test" });
  expect(records.map(r => r.tag)).toEqual(["eligible"]);
  expect(records[0]!.harness_session_id).toBe("id-eligible");
  expect(records[0]!.ensure_receipts).toEqual([]);
  expect(JSON.stringify([...rows])).toBe(before);
});

test("an unobservable tmux namespace refuses; only the recognized no-server answer is empty", async () => {
  const bin = mkdtempSync(join(tmpdir(), "fake-tmux-"));
  const tmux = join(bin, "tmux");
  process.env.PATH = `${bin}:${saved.PATH}`;
  writeFileSync(tmux, "#!/bin/sh\necho 'permission denied opening the tmux socket' >&2\nexit 1\n"); chmodSync(tmux, 0o755);
  await expect(namespaceSnapshot()).rejects.toThrow(/snapshot is unobservable; refusing/);
  writeFileSync(tmux, "#!/bin/sh\necho 'no server running on /private/tmp/tmux-501/default' >&2\nexit 1\n");
  expect(await namespaceSnapshot()).toEqual(new Set());
  writeFileSync(tmux, "#!/bin/sh\necho 'error connecting to /tmp/x (No such file or directory)' >&2\nexit 1\n");
  expect(await namespaceSnapshot()).toEqual(new Set());
});

// ---- the cohort (was test_launch_callers cohort cases) ----

const three = (root: string) => Object.fromEntries([1, 2, 3].map(n => [`seat${n}`, seat(root, `seat${n}`)]));

test.each([
  ["exit code", async (): Promise<number> => 2, "resume failed (exit 2)"],
  ["launcher refusal", async (): Promise<number> => { throw new InvocationError("fixture refusal"); }, "fixture refusal"],
  ["tmux command", async (): Promise<number> => { throw new LaunchCommandError(["tmux", "new-session"], { code: 9, stdout: "", stderr: "" }); }, "tmux error: tmux new-session"],
] as const)("the cohort keeps running after a %s failure and names it", async (_label, failure, reason) => {
  const f = fixture(three);
  const before = readFileSync(f.registry, "utf8");
  const d = deps();
  const run = d.value.run;
  d.value.run = async (kind, rec, extra) => rec.tag === "seat2" ? (await run(kind, rec, extra), failure()) : run(kind, rec, extra);
  const result = await captured(() => resumeAll(options(), f.root, d.value));
  expect(result.value).toBe(1);
  expect(d.calls.map(c => [c.kind, c.record.tag, c.live])).toEqual([1, 2, 3].map(n => ["resume-all", `seat${n}`, []]));
  expect(result.out).toContain(`  - fixture/seat2: ${reason}\n    resume manually with: tap session resume claude seat2\n`);
  expect(result.out).toContain("tap team up: 1 of 3 seat(s) failed to resume:\n");
  expect(readFileSync(f.registry, "utf8")).toBe(before);
});

test("an id-less cursor seat in the cohort discloses its fresh start; one with an id does not (tap-we6b)", async () => {
  const f = fixture(root => ({ seat1: seat(root, "seat1", { harness: "cursor" }),
    seat2: seat(root, "seat2", { harness: "cursor", harness_session_id: "019a1111-2222-7333-8444-555555555555" }) }));
  const d = deps();
  const result = await captured(() => resumeAll(options(), f.root, d.value));
  expect(result.value).toBe(0);
  expect(d.calls.map(call => call.record.harness)).toEqual(["cursor", "cursor"]);
  expect(result.err).toContain("tap session: WARNING: fixture/seat1 has no native cursor chat id; starting a fresh conversation\n");
  expect(result.err).not.toContain("fixture/seat2 has no native");
});

test("a typed cohort refusal carries its own recovery instead of 'resume manually' (tap-we6b)", async () => {
  const refuse = () => { throw new TransactionError("fixture/seat2 (cursor) has stored chat id x but no persisted conversation store", undefined,
    "no_exact_resume_identity", "tap session launch cursor seat2 --fresh"); };
  for (const json of [false, true]) {
    const f = fixture(three);
    const d = deps();
    const run = d.value.run;
    d.value.run = async (kind, rec, extra) => rec.tag === "seat2" ? refuse() : run(kind, rec, extra);
    const result = await captured(() => resumeAll(options({ json }), f.root, d.value));
    expect(result.value).toBe(1);
    if (json) {
      const failed = JSON.parse(result.out.trim().split("\n").at(-1)!).failed;
      expect(failed).toEqual([expect.objectContaining({ handle: "seat2", action: "tap session launch cursor seat2 --fresh" })]);
    } else {
      expect(result.out).toContain("    next: tap session launch cursor seat2 --fresh\n");
      expect(result.out).not.toContain("resume manually with: tap session resume claude seat2");
    }
  }
});

test.each([
  ["interrupt", new LaunchInterrupted(143)],
  ["preset refusal", new LauncherError("retired_flag: x", "retired_flag", "act", "detail")],
])("a %s stops dequeuing: in-flight seats finish, later seats never start, and the first seat's error aborts", async (_label, failure) => {
  const f = fixture(root => Object.fromEntries([1, 2, 3, 4, 5, 6].map(n => [`seat${n}`, seat(root, `seat${n}`)])));
  const d = deps();
  const started: string[] = [];
  d.value.run = async (kind, rec) => {
    started.push(rec.tag!);
    if (rec.tag === "seat1") throw failure;
    await Bun.sleep(5);
    d.calls.push({ kind, record: rec });
    return 0;
  };
  const sink = { out: "", err: "" };
  await expect(streaming(sink, () => resumeAll(options(), f.root, d.value))).rejects.toBe(failure);
  // Four workers pull their first seat in one synchronous tick, before the
  // abort is observed; seats 5 and 6 are never dequeued after it.
  expect(started).toEqual(["seat1", "seat2", "seat3", "seat4"]);
  // In-flight seats 2-4 succeeded after the abort: their receipts flush past
  // the aborted position before the rethrow, so no live seat lacks a summary.
  expect(sink.out).toContain("tap session resume --all: [2/6] resumed fixture/seat2\n");
  expect(sink.out).toContain("tap session resume --all: [3/6] resumed fixture/seat3\n");
  expect(sink.out).toContain("tap session resume --all: [4/6] resumed fixture/seat4\n");
  expect(sink.out).not.toContain("[5/6]");
  expect(sink.out).not.toContain("[6/6]");
  // The abort summary names the fatal seat and the never-attempted seats, so
  // "1 of 6 failed" cannot be read as "the other five resumed".
  expect(sink.out).toContain(`tap team up: aborted by fixture/seat1; not attempted: fixture/seat5, fixture/seat6\n`);
});

test("an abort still reports in-flight dialogs and failures in roster order, without recovery", async () => {
  const f = fixture(three);
  // hasTty true + the default throwing confirm: a stray fresh-start offer would fail the test.
  const d = deps({ hasTty: () => true });
  const interrupt = new LaunchInterrupted(143);
  d.value.run = async (kind, rec) => {
    if (rec.tag === "seat1") throw interrupt;
    await Bun.sleep(5);
    if (rec.tag === "seat2") return 7;
    throw new TransactionError("codex-hook-trust: retained", undefined, "harness_start_dialog", "tmux attach -t fixture/seat3");
  };
  const sink = { out: "", err: "" };
  await expect(streaming(sink, () => resumeAll(options(), f.root, d.value))).rejects.toBe(interrupt);
  expect(sink.out).toContain("tap team up: 1 of 3 seat(s) failed to resume:\n"
    + "  - fixture/seat2: resume failed (exit 7)\n"
    + "    resume manually with: tap session resume claude seat2\n");
  expect(sink.out).toContain("tap team up: manual_attention fixture/seat3: harness_start_dialog: codex-hook-trust: retained; next: tmux attach -t fixture/seat3\n");
  // Roster order: seat2's failure (position 2) precedes seat3's dialog (position 3).
  expect(sink.out.indexOf("failed to resume")).toBeLessThan(sink.out.indexOf("manual_attention"));
  // In JSON mode resumeAll prints nothing at all on the abort path: stdout
  // stays empty for the wrapper's render of the rethrown error, and CLI-ERR
  // keeps stderr silent.
  const json = { out: "", err: "" };
  await expect(streaming(json, () => resumeAll(options({ json: true }), f.root, d.value))).rejects.toBe(interrupt);
  expect(json.out).toBe("");
  expect(json.err).toBe("");
  // The render of a rethrown fatal refusal is exactly one JSON object on
  // stdout (an interrupt renders as a bare exit code, no object).
  const rendered = await captured(async () => render(new LauncherError("retired_flag: x", "retired_flag", "act", "detail"), true));
  expect(() => JSON.parse(rendered.out)).not.toThrow();
  expect(rendered.out.trim()).not.toContain("\n");
});

test("a lower seat's refusal plus a later interrupt rethrows the refusal but still reports the interrupt and the seat that came up", async () => {
  const f = fixture(three);
  const refusal = new LauncherError("late: x", "late", "act", "detail"), interrupt = new LaunchInterrupted(130);
  const d = deps();
  d.value.run = async (kind, rec) => {
    if (rec.tag === "seat1") throw refusal;
    if (rec.tag === "seat3") { await Bun.sleep(10); throw interrupt; }
    return 0;
  };
  const cameUp: string[] = [];
  let interrupted = 0;
  d.value.onCameUp = handle => cameUp.push(handle);
  d.value.onInterrupted = () => { interrupted++; };
  await expect(captured(() => resumeAll(options(), f.root, d.value))).rejects.toBe(refusal);
  expect(interrupted).toBe(1);
  expect(cameUp).toEqual(["seat2"]);
});

test("a cohort aborted only by a refusal never reports an interrupt", async () => {
  const f = fixture(three);
  const refusal = new LauncherError("late: x", "late", "act", "detail");
  const d = deps();
  d.value.run = async (kind, rec) => { if (rec.tag === "seat1") throw refusal; return 0; };
  let interrupted = 0;
  d.value.onInterrupted = () => { interrupted++; };
  await expect(captured(() => resumeAll(options(), f.root, d.value))).rejects.toBe(refusal);
  expect(interrupted).toBe(0);
});

test("a fatal error from a later seat rethrows the lowest roster position's error and names every fatal", async () => {
  const f = fixture(three);
  const first = new LaunchInterrupted(143), later = new LauncherError("late: x", "late", "act", "detail");
  const d = deps();
  d.value.run = async (kind, rec) => {
    if (rec.tag === "seat1") { await Bun.sleep(10); throw first; }
    if (rec.tag === "seat3") throw later;
    await Bun.sleep(5);
    return 0;
  };
  const sink = { out: "", err: "" };
  await expect(streaming(sink, () => resumeAll(options(), f.root, d.value))).rejects.toBe(first);
  // One signal landed on two in-flight seats: both are named, lowest first.
  expect(sink.out).toContain("tap team up: aborted by fixture/seat1; also aborted: fixture/seat3\n");
});

test("the pool launches at most 4 seats at once and drains the rest", async () => {
  const f = fixture(root => Object.fromEntries([1, 2, 3, 4, 5, 6].map(n => [`seat${n}`, seat(root, `seat${n}`)])));
  const d = deps();
  let inFlight = 0, maxInFlight = 0;
  const run = d.value.run;
  d.value.run = async (kind, rec, extra) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try { return await run(kind, rec, extra); } finally { inFlight--; }
  };
  await captured(() => resumeAll(options(), f.root, d.value));
  expect([maxInFlight, d.calls.length]).toEqual([4, 6]);
});

async function streaming<T>(sink: { out: string; err: string }, work: () => Promise<T>): Promise<T> {
  const write = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = ((chunk: string | Uint8Array) => { sink.out += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { sink.err += String(chunk); return true; }) as typeof process.stderr.write;
  try { return await work(); }
  finally { process.stdout.write = write.out; process.stderr.write = write.err; }
}

test("came-up seats report in roster order even when they finish in reverse", async () => {
  const f = fixture(three);
  const d = deps();
  const cameUp: string[] = [];
  d.value.onCameUp = handle => cameUp.push(handle);
  const run = d.value.run;
  d.value.run = async (kind, rec, extra) => { await Bun.sleep(rec.tag === "seat1" ? 15 : rec.tag === "seat2" ? 5 : 0); return run(kind, rec, extra); };
  await captured(() => resumeAll(options(), f.root, d.value));
  // Completion order was 3, 2, 1; the caller's preview must not shuffle.
  expect(cameUp).toEqual(["seat1", "seat2", "seat3"]);
});

test("lines stream during the run and stay in roster order when seats complete out of order", async () => {  const f = fixture(root => Object.fromEntries([1, 2, 3, 4].map(n => [`seat${n}`, seat(root, `seat${n}`)])));
  const d = deps();
  const delays: Record<string, number> = { seat1: 0, seat4: 5, seat3: 10, seat2: 15 };
  const sink = { out: "", err: "" };
  let streamedEarly = false;
  const run = d.value.run;
  d.value.run = async (kind, rec, extra) => {
    await Bun.sleep(delays[rec.tag!]!);
    // seat1 settled long ago: its line streamed then, never held for the batch.
    if (rec.tag === "seat2") streamedEarly = sink.out.includes("tap session resume --all: [1/4] resumed fixture/seat1\n") && !sink.out.includes("[4/4]");
    return run(kind, rec, extra);
  };
  await streaming(sink, () => resumeAll(options(), f.root, d.value));
  expect(streamedEarly).toBe(true);
  expect(sink.out).toContain("tap session resume --all: [1/4] resumed fixture/seat1\n"
    + "tap session resume --all: [2/4] resumed fixture/seat2\n"
    + "tap session resume --all: [3/4] resumed fixture/seat3\n"
    + "tap session resume --all: [4/4] resumed fixture/seat4\n");
});

test("a dialog and a failure leave the rest running; every summary reports once, in roster order", async () => {
  const f = fixture(root => ({ seat1: seat(root, "seat1"), seat2: seat(root, "seat2"), mislabeled: seat(root, "truth"), seat4: seat(root, "seat4") }));
  const d = deps({ hasTty: () => false });
  const delays: Record<string, number> = { seat4: 0, seat1: 5, truth: 5, seat2: 5 };
  d.value.run = async (kind, rec) => {
    await Bun.sleep(delays[rec.tag!]!);
    if (rec.tag === "seat2") throw new TransactionError("codex-hook-trust: retained", undefined, "harness_start_dialog", "tmux attach -t fixture/seat2");
    if (rec.tag === "truth") return 9;
    return 0;
  };
  const { value, out } = await captured(() => resumeAll(options(), f.root, d.value));
  expect(value).toBe(1);
  expect(out).toContain("tap team up: manual_attention fixture/seat2: harness_start_dialog: codex-hook-trust: retained; next: tmux attach -t fixture/seat2\n");
  expect(out).toContain("tap team up: 1 of 4 seat(s) failed to resume:\n  - fixture/truth: resume failed (exit 9)\n    resume manually with: tap session resume claude truth\n");
  expect(out).not.toContain("mislabeled");
  expect(out.indexOf("manual_attention")).toBeLessThan(out.indexOf("failed to resume"));
  const json = await captured(() => resumeAll(options({ json: true }), f.root, d.value));
  expect(json.out).toBe('{"ok":false,"resumed":2,"total":4,'
    + '"retained":[{"handle":"seat2","session":"fixture/seat2","reason":"harness_start_dialog: codex-hook-trust: retained","action":"tmux attach -t fixture/seat2"}],'
    + '"failed":[{"handle":"truth","session":"fixture/truth","reason":"resume failed (exit 9)"}]}\n');
});

test("dry-run streams would-resume lines and never bootstraps tmux", async () => {
  const f = fixture(root => ({ a: seat(root, "a"), b: seat(root, "b") }));
  const d = deps({ bootstrap: async () => { throw new Error("dry-run must not bootstrap"); } });
  const { value, out } = await captured(() => resumeAll(options({ dryRun: true }), f.root, d.value));
  expect(value).toBe(0);
  expect(out).toBe("tap session resume --all: [1/2] would resume fixture/a\ntap session resume --all: [2/2] would resume fixture/b\n"
    + "tap session resume --all: would resume 2 sessions\n");
});

test("live sessions are left out; nothing stopped says so in text and JSON", async () => {
  const f = fixture(root => ({ a: seat(root, "a") }));
  const live = deps({ namespace: async () => new Set(["fixture/a"]) });
  expect((await captured(() => resumeAll(options(), f.root, live.value))).out).toBe("tap session resume --all: no stopped sessions\n");
  expect((await captured(() => resumeAll(options({ json: true }), f.root, live.value))).out).toBe('{"ok":true,"sessions":[],"count":0,"scope":"cwd"}\n');
  expect(live.calls).toEqual([]);
});

test("a positional key is refused after the registry read and before any snapshot", async () => {
  const f = fixture(three);
  const d = deps({ namespace: async () => { throw new Error("must not observe"); } });
  await expect(resumeAll(options({ key: "seat1" }), f.root, d.value)).rejects.toThrow("usage: tap session resume --all [--dry-run]");
});

test("a shared native identity refuses the whole cohort before any seat launches", async () => {
  const f = fixture(root => ({ a: seat(root, "a", { harness_session_id: "same" }), b: seat(root, "b", { harness_session_id: "same" }) }));
  const d = deps();
  await expect(captured(() => resumeAll(options(), f.root, d.value))).rejects.toThrow(
    "tap session resume --all: refusing resume for expected seat a: native claude session id same already belongs to expected seat b");
  expect(d.calls).toEqual([]);
});

test("a live occupant stamped by a prior server is named and never resumed", async () => {
  process.env.TAP_BOOT_ID = "boot:200"; delete process.env.TAP_BOOT_ID_LEGACY;
  const f = fixture(root => ({ a: seat(root, "a", { status: "active", server_socket: "/s", server_epoch: "srv:1:1" }), b: seat(root, "b") }));
  const d = deps({ namespace: async () => new Set(["fixture/a"]), observe: async () => ({ boot: "boot:200", epoch: "srv:2:2", socket: "/s" }) });
  const { err } = await captured(() => resumeAll(options(), f.root, d.value));
  expect(err).toContain("tap team up: skipped unverified live occupants after restart: a; inspect those sessions before named resume\n");
  expect(d.calls.map(c => c.record.tag)).toEqual(["b"]);
});

// json.load keeps file order; JSON.parse (and JSON.stringify) hoist integer-like
// keys, so these documents are written as text with "10" ahead of "2".
const inFileOrder = (pairs: Array<[string, unknown]>) => `{${pairs.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",")}}`;
function registryText(root: string, team: Row | null, pairs: Array<[string, Row]>): void {
  mkdirSync(join(root, ".tap/bus"), { recursive: true });
  writeFileSync(join(root, ".tap/bus/registry.json"), `{"schema":"0.20",${team ? `"team":${JSON.stringify(team)},` : ""}"seats":${inFileOrder(pairs)}}`);
}

test("the cohort resumes seats in registry file order, integer-looking handles included", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "resume-all-")));
  registryText(root, { name: "fixture", worktree_root: root }, [["10", seat(root, "10")], ["alpha", seat(root, "alpha")], ["2", seat(root, "2")]]);
  enrollFixture(root);
  const d = deps();
  await captured(() => resumeAll(options(), root, d.value));
  expect(d.calls.map(c => c.record.tag)).toEqual(["10", "alpha", "2"]);
});

test("the registry owner scan walks global-registry enrollments and names the first holder in file order", () => {
  const index = realpathSync(mkdtempSync(join(tmpdir(), "resume-all-index-")));
  process.env.TAP_INDEX_HOME = index;
  const holder: Row = { harness: "claude", harness_session_id: "held" };
  const [teamA, teamB, target] = [0, 1, 2].map(() => realpathSync(mkdtempSync(join(tmpdir(), "resume-all-"))));
  registryText(teamA!, { name: "20", worktree_root: teamA! }, [["10", holder], ["2", holder]]);
  registryText(teamB!, { name: "3", worktree_root: teamB! }, [["1", holder]]);
  const enrolled = (root: string) => ({ root, registry_location: join(root, ".tap/bus/registry.json") });
  writeFileSync(join(index, "global-registry.json"), `{"schema":"0.20","teams":${inFileOrder([["20", enrolled(teamA!)], ["3", enrolled(teamB!)]])}}`);
  const probe = { name: "t/x", harness: "claude", cwd: target!, base: "t", tag: "x", index: 1, harness_session_id: "held" };
  expect(duplicateRegistrySessionOwner(probe)).toBe("20/10");
});

// ---- a malformed registry root fails closed; tmux bootstrap warnings survive ----

test.each(["1.0", "9007199254740993", "NaN", "[]", "\"text\""])("a registry root of %s refuses before the snapshot or any launch", async literal => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "resume-all-")));
  mkdirSync(join(root, ".tap/bus"), { recursive: true });
  writeFileSync(join(root, ".tap/bus/registry.json"), `${literal}\n`);
  enrollFixture(root);
  let snapshots = 0;
  const d = deps({ namespace: async () => { snapshots++; return new Set(); } });
  await expect(captured(() => resumeAll(options(), root, d.value))).rejects.toThrow("acting registry root is not an object; next: tap doctor");
  expect([snapshots, d.calls.length]).toEqual([0, 0]);
});

test("a current registry with no seats has nothing stopped", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "resume-all-")));
  mkdirSync(join(root, ".tap/bus"), { recursive: true });
  writeFileSync(join(root, ".tap/bus/registry.json"), `{"schema":"0.20","seats":{}}\n`);
  enrollFixture(root);
  const { value, out } = await captured(() => resumeAll(options(), root, deps().value));
  expect([value, out]).toEqual([0, "tap session resume --all: no stopped sessions\n"]);
});

// C4a: an old-format registry (no schema, or an agents axis) is refused, never read as "nothing stopped".
test.each(["{}", "{\"agents\":{}}", "{\"seats\":{}}"])("an old-format registry object %s refuses as old_store", async text => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "resume-all-")));
  mkdirSync(join(root, ".tap/bus"), { recursive: true });
  writeFileSync(join(root, ".tap/bus/registry.json"), `${text}\n`);
  enrollFixture(root);
  await expect(captured(() => resumeAll(options(), root, deps().value))).rejects.toMatchObject({ errorClass: "old_store" });
});

test("a successful bootstrap's warning reaches stderr once", async () => {
  const warning = "tap config: could not read /x/config.toml; defaulting tmux bootstrap to enabled";
  const result = await captured(() => bootstrapTmux(async (_env, options) => { options?.warn?.(warning); return true; }));
  expect([result.out, result.err]).toEqual(["", `${warning}\n`]);
});

test("a failed bootstrap is said once, as the typed refusal line", async () => {
  const failed = await captured(() => bootstrapTmux(async () => { throw new Error("boom"); }).catch(error => error as Error));
  expect([failed.err, (failed.value as Error).message]).toEqual(["", "tmux bootstrap failed: boom; next: tap doctor"]);
});

// ---- the reset fence: checked at entry and again after bootstrap, before any effect ----

const fenced = (root: string) => writeLiveFence(join(root, ".tap/bus/reset.fence.json"));
const midReset = (root: string) => `refusing session resume — team bus is mid-reset (fence at ${join(root, ".tap/bus/reset.fence.json")}); next: tap team reset`;

test("a live reset fence refuses at entry, before bootstrap or any launch", async () => {
  delete process.env.TAP_HOME;
  const f = fixture(three);
  fenced(f.root);
  const d = deps({ bootstrap: async () => { throw new Error("a fenced cohort must not bootstrap"); } });
  await expect(captured(() => resumeAll(options(), f.root, d.value))).rejects.toThrow(midReset(f.root));
  expect(d.calls).toEqual([]);
});

test("a fence published after the entry guard refuses before the snapshot or any launch", async () => {
  delete process.env.TAP_HOME;
  const f = fixture(three);
  const before = readFileSync(f.registry, "utf8");
  let snapshots = 0;
  // Reset acquires while the cohort is bootstrapping tmux: past the entry guard.
  const d = deps({ bootstrap: async () => fenced(f.root), namespace: async () => { snapshots++; return new Set(); } });
  await expect(captured(() => resumeAll(options(), f.root, d.value))).rejects.toThrow(midReset(f.root));
  expect([snapshots, d.calls.length]).toEqual([0, 0]);
  expect(readFileSync(f.registry, "utf8")).toBe(before);
});

// ---- receipts (was UpReceiptsTest) ----

test("--only receipts name the typed set in text and the effective set beside excluded[]", async () => {
  const f = fixture(root => ({ kimi: seat(root, "kimi"), grok: seat(root, "grok") }));
  const allLive = deps({ namespace: async () => new Set(["fixture/kimi", "fixture/grok"]) });
  process.env.TAP_TEAM_ONLY_HANDLES = "kimi\n";
  const partial = await captured(() => resumeAll(options(), f.root, allLive.value));
  expect(partial.out).toBe("tap team up: spared 1 seat(s) by --only kimi — every other seat\ntap session resume --all: no stopped sessions\n");
  process.env.TAP_TEAM_ONLY_HANDLES = "kimi\ngrok\n";
  expect((await captured(() => resumeAll(options(), f.root, allLive.value))).out).toContain("tap team up: --only grok, kimi matched every seat — none spared\n");
  const grokOnly = fixture(root => ({ grok: seat(root, "grok") }));
  process.env.TAP_TEAM_ONLY_HANDLES = "kimi\n";
  const json = await captured(() => resumeAll(options({ json: true }), grokOnly.root, deps().value));
  expect(json.out).toBe('{"ok":true,"sessions":[],"count":0,"scope":"cwd","excluded":["grok"]}\n');
  expect(json.err).toBe("tap team up: no seats matched after exclusions (excluded: grok)\n");
  process.env.TAP_TEAM_ONLY_HANDLES = "kimi\n";
  expect((await captured(() => resumeAll(options(), grokOnly.root, deps().value))).out).toBe("tap team up: no seats matched after selection (--only: kimi)\n");
});

test("--except receipts go to stdout in text and stderr beside the JSON stream", async () => {
  const f = fixture(root => ({ a: seat(root, "a"), b: seat(root, "b") }));
  process.env.TAP_TEAM_EXCEPT_HANDLES = "b\n";
  const text = await captured(() => resumeAll(options({ dryRun: true }), f.root, deps().value));
  expect(text.out.split("\n")[0]).toBe("tap team up: spared 1 seat(s) by --except: b");
  process.env.TAP_TEAM_EXCEPT_HANDLES = "b\n";
  const json = await captured(() => resumeAll(options({ dryRun: true, json: true }), f.root, deps().value));
  expect(json.err).toBe("tap team up: spared 1 seat(s) by --except: b\n");
  expect(json.out).toBe("");
});

// ---- terminal summary and fresh start ----

const failSeat2 = (d: ReturnType<typeof deps>) => {
  const run = d.value.run;
  d.value.run = async (kind, rec, extra) => { const code = await run(kind, rec, extra); return kind === "resume-all" && rec.tag === "seat2" ? 3 : code; };
};

test("the JSON summary is one terminal object and never prompts", async () => {
  const f = fixture(three);
  const d = deps({ hasTty: () => true }); failSeat2(d);
  const { value, out } = await captured(() => resumeAll(options({ json: true }), f.root, d.value));
  expect(value).toBe(1);
  expect(out).toBe('{"ok":false,"resumed":2,"total":3,"failed":[{"handle":"seat2","session":"fixture/seat2","reason":"resume failed (exit 3)"}]}\n');
});

test("dry-run says would not resume and never prompts", async () => {
  const f = fixture(three);
  const d = deps({ hasTty: () => true }); failSeat2(d);
  const { value, out } = await captured(() => resumeAll(options({ dryRun: true }), f.root, d.value));
  expect(value).toBe(1);
  expect(out).toContain("tap team up: 1 of 3 seat(s) would not resume:\n");
});

test("declining the fresh start leaves the seats and exits 1", async () => {
  const f = fixture(three);
  const d = deps({ hasTty: () => true, confirm: () => false }); failSeat2(d);
  const { value, out } = await captured(() => resumeAll(options(), f.root, d.value));
  expect(value).toBe(1);
  expect(out.endsWith("tap team up: left unresumed; use the commands above to resume manually\n")).toBe(true);
  expect(d.calls.filter(c => c.kind === "new")).toEqual([]);
});

test("accepting the fresh start relaunches each failed seat fresh, detached, with a new Claude id", async () => {
  const old = "11111111-1111-4111-8111-111111111111";
  const f = fixture(root => ({ seat1: seat(root, "seat1"), seat2: seat(root, "seat2", { harness_session_id: old, history: ["earlier"] }) }));
  const asked: string[] = [];
  const d = deps({ hasTty: () => true, confirm: (verb, question, yes) => { asked.push(`${verb}|${question}|${yes}`); return true; } });
  failSeat2(d);
  const run = d.value.run;
  d.value.run = async (kind, rec, extra) => { const code = await run(kind, rec, extra); if (kind === "new") rec.ensure_receipts = ["selected fresh"]; return code; };
  const { value, out } = await captured(() => resumeAll(options(), f.root, d.value));
  expect(value).toBe(0);
  expect(asked).toEqual(["team up|start a new session and resume manually?|true"]);
  const fresh = d.calls.find(c => c.kind === "new")!.record;
  expect(fresh.harness_session_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(fresh.harness_session_id).not.toBe(old);
  expect(fresh.history).toEqual(["earlier", old]);
  expect(fresh).toMatchObject({ transcript_path: null, replaces_session: "fixture/seat2", replaces_manifest_session: "fixture/seat2",
    kill_backup_required: true, ensure_action: "new" });
  expect(fresh.replacement_record).toMatchObject({ name: "fixture/seat2", harness_session_id: old, history: ["earlier"] });
  expect(out.endsWith("tap session: selected fresh\ntap session: fixture/seat2 is running detached (no controlling terminal); next: from a foreground terminal, run tap attach fixture/seat2\n")).toBe(true);
});

test("a failed fresh start warns per seat and the run exits a flat 1", async () => {
  const f = fixture(three);
  const d = deps({ hasTty: () => true, confirm: () => true }); failSeat2(d);
  const run = d.value.run;
  d.value.run = async (kind, rec, extra) => kind === "new" ? (await run(kind, rec, extra), 5) : run(kind, rec, extra);
  const { value, err } = await captured(() => resumeAll(options(), f.root, d.value));
  expect(value).toBe(1);
  expect(err).toContain("tap team up: warning: fresh start failed for fixture/seat2 (exit 5)\ntap team up: fresh start failed for at least one listed seat\n");
});

test("a fresh start that throws a per-seat command failure warns, exits a flat 1 and does not count the seat", async () => {
  const f = fixture(three);
  const d = deps({ hasTty: () => true, confirm: () => true }); failSeat2(d);
  const run = d.value.run;
  d.value.run = async (kind, rec, extra) => { if (kind === "new") throw new LaunchCommandError(["tmux", "new-session"], { code: 9, stdout: "", stderr: "" }); return run(kind, rec, extra); };
  const cameUp: string[] = [];
  d.value.onCameUp = handle => cameUp.push(handle);
  const { value, err } = await captured(() => resumeAll(options(), f.root, d.value));
  expect(value).toBe(1);
  expect(err).toContain("tap team up: warning: fresh start failed for fixture/seat2 (tmux error: tmux new-session)\ntap team up: fresh start failed for at least one listed seat\n");
  expect(cameUp).toEqual(["seat1", "seat3"]);
});

test("an accepted fresh start that succeeds counts its seat as came up, at its own roster position", async () => {
  const f = fixture(three);
  const d = deps({ hasTty: () => true, confirm: () => true }); failSeat2(d);
  const cameUp: string[] = [];
  d.value.onCameUp = (handle, session) => cameUp.push(`${handle}@${session}`);
  const { value } = await captured(() => resumeAll(options(), f.root, d.value));
  expect(value).toBe(0);
  expect(cameUp).toEqual(["seat1@fixture/seat1", "seat2@fixture/seat2", "seat3@fixture/seat3"]);
});

test("a failed fresh start never counts its seat as came up", async () => {
  const f = fixture(three);
  const d = deps({ hasTty: () => true, confirm: () => true }); failSeat2(d);
  const run = d.value.run;
  d.value.run = async (kind, rec, extra) => kind === "new" ? (await run(kind, rec, extra), 5) : run(kind, rec, extra);
  const cameUp: string[] = [];
  d.value.onCameUp = handle => cameUp.push(handle);
  const { value } = await captured(() => resumeAll(options(), f.root, d.value));
  expect(value).toBe(1);
  expect(cameUp).toEqual(["seat1", "seat3"]);
});

test("a fresh start that throws still reports the seats that already came up, then rethrows", async () => {
  const f = fixture(three);
  const d = deps({ hasTty: () => true, confirm: () => true }); failSeat2(d);
  const run = d.value.run;
  const interrupt = new LaunchInterrupted(130);
  d.value.run = async (kind, rec, extra) => { if (kind === "new") throw interrupt; return run(kind, rec, extra); };
  const cameUp: string[] = [];
  d.value.onCameUp = handle => cameUp.push(handle);
  await expect(captured(() => resumeAll(options(), f.root, d.value))).rejects.toBe(interrupt);
  expect(cameUp).toEqual(["seat1", "seat3"]);
});

// ---- the entry ----

test("the entry refuses retired flags first and malformed transport as usage", () => {
  const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [ENTRY, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  const model = run(["--all", "--model", "x"]);
  expect([model.status, model.stdout, model.stderr]).toEqual([2, "",
    "tap session: --model was removed from `tap session resume`; next: resume replays the seat's stored record; set the model when the seat is LAUNCHED (--model, or a preset) and every later resume replays it\n"]);
  const json = run(["--all", "--teams", "--json"]);
  expect(json.status).toBe(2);
  expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, error_class: "retired_flag" });
  const usage = run(["--bogus"], { TAP_JSON: "1" });
  expect([usage.status, JSON.parse(usage.stdout)]).toEqual([2, { ok: false, error_class: "session_error", action: "tap help session", detail: "usage: tap session resume --all [--dry-run]" }]);
});

test("one ambient collision is said once for the whole dry-run cohort", () => {
  const f = fixture(root => Object.fromEntries([1, 2, 3].map(n => [`seat${n}`, seat(root, `seat${n}`, { harness: "codex", harness_env: { FOO: "declared" } })])));
  const result = spawnSync(process.execPath, [ENTRY, "--all", "--dry-run"], { cwd: f.root, encoding: "utf8", env: { ...process.env, TAP_INDEX_HOME: f.index, FOO: "from-shell" } });
  expect(result.status, result.stderr).toBe(0);
  const collisions = result.stderr.split("\n").filter(line => line.includes("ambient ENV var"));
  expect(collisions.length, result.stderr).toBe(1);
  expect(collisions[0]).toContain("FOO");
  expect(result.stdout).toContain("tap session resume --all: would resume 3 sessions\n");
});

// ---- the consent prompt on a private PTY, through every entry shape ----

const PTY = resolve(import.meta.dir, "support/pty-prompt.py");
const DOOR = resolve(import.meta.dir, "../src/launcher/session-doors.ts");
const TEAM_UP_CHILD = `const r = require("node:child_process").spawnSync(process.execPath, [${JSON.stringify(ENTRY)}, "--all"], { stdio: "inherit" }); process.exit(r.status ?? 1);`;
const SHAPES: Record<string, string[]> = {
  "native public resume door": [process.execPath, DOOR, "resume", "--all"],
  "direct native entry": [process.execPath, ENTRY, "--all"],
  "team up child under a Bun parent": [process.execPath, "-e", TEAM_UP_CHILD],
};
function onPty(command: string[], keys: string[]) {
  // One seat whose recipe the transaction refuses before any effect, so the
  // cohort reaches its terminal summary without launching anything.
  const f = fixture(root => ({ seat: seat(root, "seat", { harness_env: { "BAD-KEY": "x" } }) }));
  const result = spawnSync(process.env.TAP_PYTHON ?? "python3", ["-B", PTY, JSON.stringify(keys), ...command], { cwd: f.root, encoding: "utf8", timeout: 90_000 });
  expect(result.status, result.stderr).toBe(0);
  const parsed = JSON.parse(result.stdout) as { before: string | null; after: string | null; exit: number | null; signal: number | null; output: string };
  expect(parsed.before, parsed.output).toBeTruthy();
  return parsed;
}

// Darwin's line discipline sets PENDIN (lflag 0x20000000, "retype pending
// input") whenever canonical mode is switched back on; it is kernel state, not
// a restored setting. The incumbent's own tty.setcbreak/tcsetattr prompt sets
// it identically (pinned by the control below), so parity masks only that bit.
const settled = (stty: string | null) => stty?.replace(/lflag=([0-9a-f]+)/, (_m, hex: string) => `lflag=${(BigInt(`0x${hex}`) & ~0x20000000n).toString(16)}`);

test("control: the incumbent Python cbreak prompt leaves the same terminal state", () => {
  const incumbent = onPty(["python3", "-c", "import os,sys,termios,tty;o=termios.tcgetattr(0);sys.stderr.write('[Y/n] ');sys.stderr.flush();tty.setcbreak(0);os.read(0,1);termios.tcsetattr(0,termios.TCSADRAIN,o)"], ["n"]);
  const native = onPty(SHAPES["direct native entry"]!, ["n"]);
  expect(settled(incumbent.after)).toEqual(settled(incumbent.before));
  expect(native.after).toEqual(incumbent.after);
}, 60_000);

test.each(Object.entries(SHAPES))("%s: one key declines, the default accepts, and termios is restored", (_shape, command) => {
  const declined = onPty(command, ["x", "n"]);
  expect(declined.output).toContain("  - fixture/seat: invalid launch recipe environment");
  expect(declined.output).toContain("tap team up: start a new session and resume manually? [Y/n] tap team up: choose y or n");
  expect(declined.output).toContain("tap team up: left unresumed; use the commands above to resume manually");
  expect([declined.exit, declined.signal]).toEqual([1, null]);
  expect(settled(declined.after)).toEqual(settled(declined.before));
  // Enter takes the Y default: the fresh arm runs (and its recipe refuses the same way).
  const accepted = onPty(command, ["\r"]);
  expect(accepted.output).toContain("tap session: invalid launch recipe environment");
  expect(accepted.output).not.toContain("left unresumed");
  expect(accepted.exit).toBe(2);
  expect(settled(accepted.after)).toEqual(settled(accepted.before));
}, 120_000);

test.each(Object.entries(SHAPES))("%s: a live fence refuses before any launch", (_shape, command) => {
  const f = fixture(three);
  fenced(f.root);
  const before = readFileSync(f.registry, "utf8");
  const env = { ...process.env };
  delete env.TAP_HOME;
  const result = spawnSync(command[0]!, command.slice(1), { cwd: f.root, encoding: "utf8", env, timeout: 60_000 });
  expect([result.status, result.stdout], result.stderr).toEqual([2, ""]);
  expect(result.stderr).toBe(`tap session: ${midReset(f.root)}\n`);
  expect(readFileSync(f.registry, "utf8")).toBe(before);
}, 60_000);

test.each(Object.entries(SHAPES))("%s: Ctrl-C at the prompt interrupts with the terminal restored", (_shape, command) => {
  const interrupted = onPty(command, ["\x03"]);
  expect(interrupted.exit, JSON.stringify(interrupted)).toBe(130);
  expect(interrupted.output).not.toContain("left unresumed");
  expect(settled(interrupted.after)).toEqual(settled(interrupted.before));
}, 60_000);

// Ctrl-\ reaches the whole foreground group, an unshielded Bun parent included:
// it dies at once and the harness reads the terminal before its orphaned child's
// trap has restored it. That is the parent's disposition, not the prompt's, so
// this shape's parent shields QUIT the way system(3) does.
const QUIT_SHAPES: Record<string, string[]> = { ...SHAPES,
  "team up child under a Bun parent": [process.execPath, "-e", `process.on("SIGQUIT", () => {}); ${TEAM_UP_CHILD.replace("r.status ?? 1", 'r.status ?? (r.signal === "SIGQUIT" ? 131 : 1)')}`] };
test.each(Object.entries(QUIT_SHAPES))("%s: Ctrl-\\ at the prompt quits with the terminal restored (tap-q4pls)", (_shape, command) => {
  const quit = onPty(command, ["\x1c"]);
  expect([quit.exit, quit.signal], JSON.stringify(quit)).toEqual([131, null]);
  expect(quit.output).not.toContain("left unresumed");
  expect(settled(quit.after)).toEqual(settled(quit.before));
}, 60_000);

test("a piped stdout never sees a question even with a terminal on stdin", () => {
  const piped = onPty(["/bin/sh", "-c", `exec "$0" "$1" --all > /dev/null`, process.execPath, ENTRY], []);
  expect(piped.output).not.toContain("[Y/n]");
  expect(piped.exit).toBe(1);
  expect(piped.after).toEqual(piped.before);
}, 60_000);


for (const json of [false, true]) test(`retained hook dialogs never enter fresh-start recovery json=${json}`, async () => {
  const f = fixture(three);
  const kinds: string[] = [];
  const d = deps({ hasTty: () => true, confirm: () => { throw new Error("retained dialog must not offer fresh-start"); },
    run: async (kind, rec) => {
      kinds.push(kind);
      if (rec.tag === "seat2") throw new TransactionError("codex-hook-trust: retained", undefined, "harness_start_dialog", "tmux attach -t fixture/seat2");
      return 0;
    } });
  const result = await captured(() => resumeAll(options({ json }), f.root, d.value));
  expect(result.value).toBe(2);
  expect(kinds).toEqual(["resume-all", "resume-all", "resume-all"]);
  expect(result.out).toContain("manual_attention");
  expect(result.out).toContain("tmux attach -t fixture/seat2");
  if (json) expect(JSON.parse(result.out).resumed).toBe(2);
});
