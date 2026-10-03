import { proofFixture } from "./fixtures/compaction-proof";
import { afterAll, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactReadiness, compactedAfter, escapeRefusal, latestTurnId, lockedCompactSubmit, parseOptions, resumeSendArgs, requestSeat, spawnRequest, runCompact, runWake, stageResumeBody, TERMINAL, type CompactEffects, type CompactReceipt, type CompactRequest, type WakeEffects, type WakeReceipt, type WakeRequest } from "../src/self-compact";
import { detectAgentState } from "../src/agent-state";
import type { SubmitResult } from "../src/courier";
import { classifySubmitFrame } from "../src/submit-frame";
import { cmdSendOutcome } from "../src/verbs/send";
import { AGENT_FAMILIES } from "../src/verbs/team";
import { removeScratchTree } from "./support/scratch";
import type { Seat } from "../src/registry";
import { isOldStoreRefusal } from "../src/register-authority";
const root = mkdtempSync(join(tmpdir(), "self-compact-"));
afterAll(() => removeScratchTree(root));
const ROLLOUT = join(root, "rollout.jsonl");
const TURN = "t-arm";
const SEAT: Seat = { pane_id: "%5", instance: "original", server_epoch: "epoch", boot_id: "boot", harness: "codex", harness_session_id: "old", transcript_path: ROLLOUT };
function request(overrides: Partial<CompactRequest> = {}): CompactRequest {
  return { id: "worker-1", registry: join(root, "registry.json"), bus: root, team: "team", handle: "worker", command: "/compact",
    bound: { paneId: "%5", instance: "original", serverEpoch: "epoch", bootId: "boot", harness: "codex", handle: "worker" },
    oldSession: "old", oldTranscript: ROLLOUT, handoff: join(root, "handoff.md"), focus: "live threads", resumePing: "Post-compaction ping: handoff at /h.md; focus live threads; Run 'tap poll worker'.", turnId: TURN, ...overrides };
}
function seedRollout(path: string, session: string, records: object[] = []): void {
  writeFileSync(path, [JSON.stringify({ type: "session_meta", payload: { id: session } }),
    ...records.map(r => JSON.stringify(r)), ""].join("\n"));
}
type Fake = { fx: CompactEffects; log: string[]; receipts: CompactReceipt[]; escapeCount(): number; submitCount(): number; unlockCount(): number; now(): number };
function fakePane(opts: { session?: string; startState?: "idle" | "working"; escapeWorks?: boolean; stuckWorking?: boolean; flipToWorkingAfterIdle?: boolean; submitStatus?: string; noRecord?: boolean; appendRecordAt?: number; rowDrift?: "none" | "start" | "preEnter" | "midProof"; ping?: string; turn?: string | null; refuseAtEnter?: "turn" | "readiness" | "hold" } = {}): Fake {
  const rollout = ROLLOUT;
  let time = 0;
  const log: string[] = [];
  const receipts: CompactReceipt[] = [];
  let escapes = 0, submits = 0, escapeAt = -1, submitAt = -1, idleReads = 0;
  let pending: { at: number; record: object } | null = null;
  const state = (): "idle" | "working" => {
    if (opts.stuckWorking) return "working";
    if (opts.startState === "idle") return "idle";
    if (escapes === 0 || time < escapeAt + 2000) return "working";
    if (opts.flipToWorkingAfterIdle) { idleReads++; return idleReads > 2 ? "working" : "idle"; }
    return "idle";
  };
  const drifted = () => ({ ...SEAT, instance: "replacement" });
  const fx: CompactEffects = {
    row: () => {
      if (opts.rowDrift === "start") return drifted();
      if (opts.rowDrift === "preEnter" && time >= 3000) return drifted();
      if (opts.rowDrift === "midProof" && time >= 5000) return drifted();
      return SEAT;
    },
    state,
    turn: () => (opts.turn !== undefined ? opts.turn : TURN),
    escape: () => { escapes++; log.push("escape"); escapeAt = time; return opts.escapeWorks === false ? false : true; },
    submit: () => {
      submits++; log.push("submit"); submitAt = time;
      if (state() === "working") return { result: { status: "unverified", detail: "disabled while a task is in progress" }, submitAt: new Date(time).toISOString(), baselineOffset: 0 };
      if (opts.refuseAtEnter) throw new Error(opts.refuseAtEnter === "turn"
        ? "turn: a new Codex turn started after staging; refusing Enter; nothing interrupted"
        : opts.refuseAtEnter === "readiness"
          ? "readiness: pane took new work after staging; refusing Enter; nothing interrupted"
          : "recovery owns pane '%5'; refusing the pane effect");
      if (opts.submitStatus) return { result: { status: opts.submitStatus as "pane_gone", detail: opts.submitStatus }, submitAt: new Date(time).toISOString(), baselineOffset: 0 };
      const text = readFileSync(rollout, "utf8");
      const baselineOffset = Buffer.byteLength(text);
      const tail = text.trimEnd().split("\n");
      const last = tail.length ? JSON.parse(tail[tail.length - 1]!) as { ordinal?: number } : {};
      const ordinal = typeof last.ordinal === "number" ? last.ordinal + 1 : undefined;
      if (opts.noRecord) { /* observation only: no record ever lands */ }
      else if (opts.appendRecordAt !== undefined) {
        pending = { at: opts.appendRecordAt, record: { timestamp: new Date(opts.appendRecordAt).toISOString(), ...(ordinal !== undefined && { ordinal }), type: "compacted", payload: { message: "compacted" } } };
      } else pending = { at: time + 2000, record: { timestamp: new Date(time + 2000).toISOString(), ...(ordinal !== undefined && { ordinal }), type: "compacted", payload: { message: "compacted" } } };
      return { result: { status: "injected" }, submitAt: new Date(time).toISOString(), baselineOffset };
    },
    send: body => { log.push(`send:worker`); expect(time).toBeGreaterThan(submitAt + 2000); expect(body).toBe(opts.ping ?? "Post-compaction ping: handoff at /h.md; focus live threads; Run 'tap poll worker'."); return { rc: 0, disposition: "queued-spool" }; },
    record: r => receipts.push(r),
    unlock: () => { log.push("unlock"); },
    settle: s => { time += s * 1000; },
    now: () => time,
    wait: async () => { time += 1000; if (pending && time >= pending.at) { const { record } = pending; writeFileSync(rollout, readFileSync(rollout, "utf8").trimEnd().replace(/\n$/, "") + "\n" + JSON.stringify(record) + "\n"); pending = null; } },
  };
  let unlocks = 0;
  const counted: CompactEffects = { ...fx, unlock: () => { unlocks++; fx.unlock?.(); } };
  return { fx: counted, log, receipts, escapeCount: () => escapes, submitCount: () => submits, unlockCount: () => unlocks, now: () => time };
}
function run(fake: Fake, timeout = 8000, ping?: string): Promise<void> {
  seedRollout(ROLLOUT, "old", [{ type: "turn_context", payload: { turn_id: TURN } }]);
  return runCompact(request(ping ? { resumePing: ping } : {}), fake.fx, timeout);
}
test("parseOptions requires a pane and a focus; the handoff is enforced per family at arm", () => {
  expect(() => parseOptions(["--pane", "%5"])).toThrow("tap self compact --handoff");
  expect(() => parseOptions(["--handoff-path", "/h"])).toThrow();
  expect(parseOptions(["--pane", "%5", "--", "focus text"])).toMatchObject({ pane: "%5", focus: "focus text" });
  expect(parseOptions(["--pane", "%5", "--handoff-path", "/h", "--", "focus text"])).toMatchObject({ pane: "%5", handoffPath: "/h", focus: "focus text" });
  expect(parseOptions(["--pane", "%5", "--handoff-path", "/h", "--resume-ping", "p", "--", "f"]).resumePing).toBe("p");
});
test("compactedAfter admits only complete records appended after the Enter offset of the bound session", () => {
  const path = join(root, "proof.jsonl");
  const sinceIso = "2026-02-01T00:00:00Z";
  seedRollout(path, "s1", [
    { timestamp: "2026-01-01T00:00:00Z", ordinal: 2, type: "compacted", payload: {} },
    { type: "turn_context", payload: { turn_id: "t1" } },
  ]);
  const offset = Buffer.byteLength(readFileSync(path, "utf8"));
  expect(compactedAfter(path, "s1", sinceIso, offset)).toBeNull();
  writeFileSync(path, readFileSync(path, "utf8").trimEnd() + "\n" +
    JSON.stringify({ timestamp: "2026-03-01T00:00:00Z", type: "compacted", payload: {} }) + "\n");
  expect(compactedAfter(path, "s1", sinceIso, offset)).toEqual({ timestamp: "2026-03-01T00:00:00Z" });
  expect("ordinal" in compactedAfter(path, "s1", sinceIso, offset)!).toBe(false);
  writeFileSync(path, readFileSync(path, "utf8").trimEnd() + "\n" +
    JSON.stringify({ timestamp: "2026-03-02T00:00:00Z", ordinal: 10, type: "event_msg", payload: { type: "context_compacted" } }) + "\n");
  expect(compactedAfter(path, "s1", "2026-03-01T00:00:00Z", offset)).toEqual({ timestamp: "2026-03-02T00:00:00Z", ordinal: 10 });
  expect(compactedAfter(path, "s1", "2026-03-02T00:00:00Z", offset)).toBeNull();
  expect(compactedAfter(path, "other", sinceIso, offset)).toBeNull();
  expect(compactedAfter(path, "s1", sinceIso, -1)).toBeNull();
  expect(compactedAfter(path, "s1", sinceIso, Buffer.byteLength(readFileSync(path, "utf8")) + 1)).toBeNull();
  writeFileSync(path, readFileSync(path, "utf8").trimEnd() + "\n" + '{"timestamp":"2026-04-01T00:');
  expect(compactedAfter(path, "s1", "2026-03-01T00:00:00Z", offset)).toEqual({ timestamp: "2026-03-02T00:00:00Z", ordinal: 10 });
  seedRollout(path, "s1", [{ timestamp: "2026-03-05T00:00:00Z", type: "compacted", payload: {} }]);
  const preOffset = Buffer.byteLength(readFileSync(path, "utf8"));
  writeFileSync(path, readFileSync(path, "utf8").trimEnd() + "\n" +
    JSON.stringify({ timestamp: "2026-03-06T00:00:00Z", type: "compacted", payload: {} }) + "\n");
  expect(compactedAfter(path, "s1", sinceIso, preOffset)).toEqual({ timestamp: "2026-03-06T00:00:00Z" });
  writeFileSync(path, readFileSync(path, "utf8").slice(0, preOffset - 4));
  expect(compactedAfter(path, "s1", sinceIso, preOffset)).toBeNull();
  const midLine = Buffer.byteLength(readFileSync(path, "utf8")) - 8;
  writeFileSync(path, readFileSync(path, "utf8") + "\n" + JSON.stringify({ timestamp: "2026-03-07T00:00:00Z", type: "compacted", payload: {} }) + "\n");
  expect(compactedAfter(path, "s1", "2026-03-06T00:00:00Z", midLine)).toEqual({ timestamp: "2026-03-07T00:00:00Z" });
});
test("latestTurnId reads turn_context and task events, latest wins, unreadable fails closed", () => {
  const path = join(root, "turns.jsonl");
  expect(latestTurnId(join(root, "absent.jsonl"))).toBeNull();
  writeFileSync(path, [
    JSON.stringify({ type: "session_meta", payload: { id: "s1" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t-old" } }),
    JSON.stringify({ type: "turn_context", payload: { turn_id: "t-new" } }),
    "",
  ].join("\n"));
  expect(latestTurnId(path)).toBe("t-new");
  writeFileSync(path, [
    JSON.stringify({ type: "session_meta", payload: { id: "s1" } }),
    JSON.stringify({ type: "turn_context", payload: { turn_id: "t-a" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "t-b" } }),
    "",
  ].join("\n"));
  expect(latestTurnId(path)).toBe("t-b");
  writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: "s1" } }) + "\n");
  expect(latestTurnId(path)).toBeNull();
  writeFileSync(path, '{"type":"turn_context",');
  expect(latestTurnId(path)).toBeNull();
});
test("latestTurnId walks backward past any tail ceiling and reconstructs split markers", () => {
  const path = join(root, "long-turns.jsonl");
  const filler = JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "x".repeat(4096) } }) + "\n";
  writeFileSync(path, JSON.stringify({ type: "turn_context", payload: { turn_id: "t-long" } }) + "\n" + filler.repeat(160));
  expect(latestTurnId(path)).toBe("t-long");
  writeFileSync(path, JSON.stringify({ type: "turn_context", payload: { turn_id: "t-long" } }) + "\n" + filler.repeat(160) +
    JSON.stringify({ type: "turn_context", payload: { turn_id: "t-later" } }) + "\n");
  expect(latestTurnId(path)).toBe("t-later");
  const marker = JSON.stringify({ type: "turn_context", payload: { turn_id: "t-span" } });
  const prefix = JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "p".repeat(4096) } });
  const spanFiller = JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "z".repeat(262051) } }) + "\n";
  writeFileSync(path, prefix + "\n" + marker + "\n" + spanFiller);
  expect(latestTurnId(path)).toBe("t-span");
  writeFileSync(path, marker + "\n" + '{"type":"turn_context","payload":{"turn_id":"t-partial');
  expect(latestTurnId(path)).toBe("t-span");
  expect(latestTurnId(root)).toBeNull();
});
test("a complete malformed record newer than the marker conceals it: null, not an older id", () => {
  const path = join(root, "concealed-turn.jsonl");
  writeFileSync(path, JSON.stringify({ type: "turn_context", payload: { turn_id: "t-old" } }) + "\n" +
    '{"type":"turn_context","payload":{"turn_id":"t-new"\n');
  expect(latestTurnId(path)).toBeNull();
});
test("a newer malformed record conceals an older marker across a chunk boundary too", () => {
  const path = join(root, "concealed-long-turn.jsonl");
  const filler = JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "x".repeat(4096) } }) + "\n";
  writeFileSync(path, filler.repeat(64) +
    JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t-old" } }) + "\n" +
    '{"type":"turn_context","payload":{"turn_id":"t-new"\n');
  expect(latestTurnId(path)).toBeNull();
});
test("a long unfinished output record spanning whole chunks is ignored, not scanned", () => {
  const path = join(root, "unfinished-output.jsonl");
  writeFileSync(path, JSON.stringify({ type: "turn_context", payload: { turn_id: "t-done" } }) + "\n" +
    '{"type":"response_item","payload":{"output":"' + "x".repeat(300000));
  expect(latestTurnId(path)).toBe("t-done");
});
test("a long parseable marker without its newline is still incomplete", () => {
  const path = join(root, "unfinished-marker.jsonl");
  writeFileSync(path, JSON.stringify({ type: "turn_context", payload: { turn_id: "t-done" } }) + "\n" +
    JSON.stringify({ type: "turn_context", payload: { turn_id: "t-unfinished", padding: "x".repeat(300000) } }));
  expect(latestTurnId(path)).toBe("t-done");
});
test("only final outcomes publish terminal pointers; compacted is a phase", () => {
  expect(TERMINAL.has("compacted")).toBe(false);
  expect(TERMINAL.has("submitted")).toBe(false);
  expect(TERMINAL.has("interrupted")).toBe(false);
  for (const state of ["resume-sent", "resume-miss", "not-compacted", "incomplete"]) expect(TERMINAL.has(state as "incomplete")).toBe(true);
});
test("interrupt, one locked submit, compacted proof, then unlock before the resume send", async () => {
  const f = fakePane();
  await run(f);
  expect(f.log).toEqual(["escape", "submit", "unlock", "send:worker"]);
  expect(f.unlockCount()).toBe(1);
  expect(f.receipts.map(r => r.state)).toEqual(["interrupted", "submitted", "compacted", "resume-sent"]);
  const compacted = f.receipts[2]!;
  expect(compacted.ordinal).toBeUndefined();
  expect(f.receipts[3]!.delivery).toBe("queued-spool");
});
test("a pane that never idles after one Escape is reported not compacted", async () => {
  const f = fakePane({ stuckWorking: true });
  await run(f, 31000);
  expect(f.escapeCount()).toBe(1);
  expect(f.log).toEqual(["escape"]);
  expect(f.submitCount()).toBe(0);
  expect(f.receipts.at(-1)).toMatchObject({ state: "not-compacted" });
  expect(f.receipts.at(-1)!.detail).toContain("interrupt-unobserved");
});
test("a pane that resumes work before Enter loses the readiness boundary without queue surgery", async () => {
  const f = fakePane({ flipToWorkingAfterIdle: true });
  await run(f, 31000);
  expect(f.escapeCount()).toBe(1);
  expect(f.log).toEqual(["escape"]);
  expect(f.submitCount()).toBe(0);
  expect(f.receipts.at(-1)).toMatchObject({ state: "incomplete" });
  expect(f.receipts.at(-1)!.detail).toContain("readiness");
});
test("no fresh compacted record before timeout: NOT COMPACTED, handoff retained, nothing sent", async () => {
  const f = fakePane({ startState: "idle", noRecord: true });
  await run(f, 4000);
  expect(f.log).toEqual(["submit"]);
  expect(f.unlockCount()).toBe(0);
  expect(f.receipts.at(-1)).toMatchObject({ state: "not-compacted", handoff: request().handoff });
  expect(f.receipts.at(-1)!.detail).toContain("no fresh compacted record");
});
test("a record landing on the deadline tick is scanned without extending the deadline", async () => {
  const f = fakePane({ startState: "idle", appendRecordAt: 5000 });
  await run(f, 5000);
  expect(f.log).toEqual(["submit", "unlock", "send:worker"]);
  expect(f.receipts.map(r => r.state)).toEqual(["submitted", "compacted", "resume-sent"]);
  expect(f.receipts[1]!.compactedAt).toBe(new Date(5000).toISOString());
});
test("a refused submit is terminal and never repeated", async () => {
  for (const submitStatus of ["pane_gone", "lock_busy"]) {
    const f = fakePane({ startState: "idle", submitStatus });
    await run(f, 4000);
    expect(f.submitCount()).toBe(1);
    expect(f.log).toEqual(["submit"]);
    expect(f.receipts.at(-1)).toMatchObject({ state: "incomplete" });
  }
});
test("identity or native-session drift stops the worker at every phase", async () => {
  const start = fakePane({ rowDrift: "start", stuckWorking: true });
  await run(start, 31000);
  expect(start.escapeCount()).toBe(0);
  expect(start.receipts.at(-1)).toMatchObject({ state: "incomplete" });
  expect(start.receipts.at(-1)!.detail).toContain("identity");
  const preEnter = fakePane({ rowDrift: "preEnter" });
  await run(preEnter);
  expect(preEnter.submitCount()).toBe(0);
  expect(preEnter.log).toEqual(["escape"]);
  expect(preEnter.receipts.at(-1)).toMatchObject({ state: "incomplete" });
  const midProof = fakePane({ rowDrift: "midProof" });
  await run(midProof);
  expect(midProof.log).toEqual(["escape", "submit"]);
  expect(midProof.receipts.at(-1)).toMatchObject({ state: "incomplete" });
  expect(midProof.receipts.at(-1)!.detail).toContain("identity");
});
test("a blocked seat is never interrupted or submitted", async () => {
  const f = fakePane({ stuckWorking: true });
  f.fx.state = () => "blocked";
  await run(f, 31000);
  expect(f.escapeCount()).toBe(0);
  expect(f.log).toEqual([]);
  expect(f.receipts.at(-1)).toMatchObject({ state: "not-compacted" });
  expect(f.receipts.at(-1)!.detail).toContain("blocked");
});
test("the resume body is the precomposed ping, verbatim, clause fidelity included", async () => {
  const withBd = fakePane({ ping: "Context compacted. Read /h.md first; focus: keep threads. Run 'tap poll worker' and 'bd ready'." });
  await run(withBd, 8000, "Context compacted. Read /h.md first; focus: keep threads. Run 'tap poll worker' and 'bd ready'.");
  expect(withBd.log).toEqual(["escape", "submit", "unlock", "send:worker"]);
  const withoutBd = fakePane({ ping: "Context compacted. Read /h.md first; focus: keep threads. Run 'tap poll worker'." });
  await run(withoutBd, 8000, "Context compacted. Read /h.md first; focus: keep threads. Run 'tap poll worker'.");
  const sent = withoutBd.log.at(-1)!;
  expect(sent).toBe("send:worker");
  expect(withoutBd.receipts.at(-1)).toMatchObject({ state: "resume-sent" });
});
test("a new Codex turn since arming refuses every effect, working or idle", async () => {
  const working = fakePane({ stuckWorking: true, turn: "t-new" });
  await run(working, 31000);
  expect(working.escapeCount()).toBe(0);
  expect(working.submitCount()).toBe(0);
  expect(working.log).toEqual([]);
  expect(working.receipts.at(-1)).toMatchObject({ state: "incomplete" });
  expect(working.receipts.at(-1)!.detail).toContain("turn");
  const idle = fakePane({ startState: "idle", turn: "t-new" });
  await run(idle);
  expect(idle.submitCount()).toBe(0);
  expect(idle.log).toEqual([]);
  expect(idle.receipts.at(-1)).toMatchObject({ state: "incomplete" });
  expect(idle.receipts.at(-1)!.detail).toContain("turn");
  const unprovable = fakePane({ startState: "idle", turn: null });
  await run(unprovable);
  expect(unprovable.receipts.at(-1)).toMatchObject({ state: "incomplete" });
  expect(unprovable.receipts.at(-1)!.detail).toContain("turn");
});
test("new work between staging and Enter refuses the Enter once, without interrupting it", async () => {
  for (const [refuseAtEnter, needle] of [["turn", "turn"], ["readiness", "readiness"], ["hold", "recovery owns pane"]] as const) {
    const f = fakePane({ startState: "idle", refuseAtEnter });
    await run(f);
    expect(f.submitCount()).toBe(1);
    expect(f.log).toEqual(["submit"]);
    expect(f.receipts.at(-1)).toMatchObject({ state: "incomplete" });
    expect(f.receipts.at(-1)!.detail).toContain(needle);
  }
});
test("custody holds refuse the Escape through the one shared seam", () => {
  const authority = { registryPath: join(root, "registry.json"), recipient: "worker", busHome: root, agentFamilies: AGENT_FAMILIES, scriptsDir: root } as Parameters<typeof escapeRefusal>[0];
  const probes = (over: Partial<{ resetFence: string | null; recovery: boolean; clear: string }> = {}) => ({
    resetFence: () => (over.resetFence === undefined ? null : over.resetFence === null ? null : { detail: over.resetFence }),
    recovery: () => over.recovery ?? false,
    clear: () => ({ state: over.clear ?? "absent" }),
  });
  expect(escapeRefusal(authority, "%5", probes({ resetFence: "team bus is mid-reset" }))).toContain("mid-reset");
  expect(escapeRefusal(authority, "%5", probes({ recovery: true }))).toContain("recovery owns pane");
  expect(escapeRefusal(authority, "%5", probes({ clear: "live" }))).toContain("mid-clear");
  expect(escapeRefusal(authority, "%5", probes())).toBeNull();
});
test("each custody hold stops the worker with zero Escape, zero submit, nothing sent", async () => {
  for (const refusal of ["team bus is mid-reset; refusing the pane effect", "recovery owns pane '%5'; refusing the pane effect", "seat 'worker' is mid-clear; refusing the pane effect"]) {
    const f = fakePane({ stuckWorking: true });
    f.fx.escape = () => { throw new Error(refusal); };
    await run(f, 31000);
    expect(f.escapeCount()).toBe(0);
    expect(f.submitCount()).toBe(0);
    expect(f.log).toEqual([]);
    expect(f.receipts.at(-1)).toMatchObject({ state: "incomplete" });
    expect(f.receipts.at(-1)!.detail).toContain(refusal);
  }
});
const compactMenu = readFileSync(new URL("fixtures/self-compact/codex-compact-menu.txt", import.meta.url), "utf8");
test("Codex compact autocomplete admits only the exact owned command", () => {
  expect(classifySubmitFrame(compactMenu, "codex", "/compact").state).toBe("staged");
  for (const changed of [compactMenu.replace("› /compact", "› /compact extra"), compactMenu + "human draft\n",
    compactMenu.replace("summarize conversation", "delete conversation"), compactMenu.replace("  /compact", "  /clear")]) {
    expect(classifySubmitFrame(changed, "codex", "/compact").state).not.toBe("staged");
  }
  expect(classifySubmitFrame(compactMenu, "codex", "/clear").state).not.toBe("staged");
});
test("compact readiness recognizes only the staged control and preserves active-work detection", () => {
  expect(detectAgentState("codex", compactMenu).agentState).toBe("unknown");
  expect(compactReadiness(compactMenu, "")).toBe("unknown");
  expect(compactReadiness(compactMenu, "", true)).toBe("idle");
  expect(compactReadiness(compactMenu, "⠋ Codex", true)).toBe("working");
  expect(compactReadiness("• Working (1s • esc to interrupt)\n" + compactMenu, "", true)).toBe("working");
  expect(compactReadiness("• Messages to be submitted after next tool call (press esc to\ninterrupt and send immediately)\n  ↳ queued follow-up\n\n" + compactMenu.slice(compactMenu.indexOf("› /compact")), "", true)).toBe("working");
  for (const screen of [compactMenu.replace("› /compact", "› /compact extra"), compactMenu + "human draft\n", "› /compact\n  tab to queue message\n",
    compactMenu + "press enter to confirm or esc to cancel\n", "unreadable", "› \x1b[2mAsk Codex to do anything\x1b[0m"]) {
    expect(compactReadiness(screen, "", true)).not.toBe("idle");
  }
});
test("the locked submit accepts Codex compact autocomplete and gates custody at the real Enter", () => {
  seedRollout(ROLLOUT, "old", [{ type: "turn_context", payload: { turn_id: TURN } }]);
  const submitRegistry = join(root, "submit-registry.json");
  writeFileSync(submitRegistry, JSON.stringify({ schema: "0.20", team: { name: "team" }, seats: { worker: SEAT } }));
  const authority = { registryPath: submitRegistry, recipient: "worker", busHome: root, agentFamilies: AGENT_FAMILIES, scriptsDir: root, expectedNativeSession: "old", singleEnter: true } as Parameters<typeof lockedCompactSubmit>[1];
  const bare = request({ bound: { paneId: "%5", instance: "original", serverEpoch: "epoch", harness: "codex", handle: "worker" } });
  const base = (sticky = false, late?: { screen?: string; title?: string }) => {
    let text = "";
    const effects: string[] = [];
    return { effects, readiness: (staged = false) => compactReadiness(text ? late?.screen ?? compactMenu : "› \x1b[2mAsk Codex to do anything\x1b[0m", late?.title ?? "", staged), fx: {
      observePane: () => ({ paneId: "%5", session: "team/worker", serverEpoch: "epoch", panePid: "42", currentCommand: "codex" }),
      harnessEvidence: () => "alive" as const,
      paneState: () => ({ state: "ready" } as const),
      copyMode: () => ({ status: "normal" } as const),
      injectText: (_target: string, input: string) => { effects.push("inject"); text = input; return true; },
      inputHasId: () => false,
      pressEnter: () => { effects.push("enter"); if (!sticky) text = ""; return true; },
      settle: () => {},
      submitFrame: () => classifySubmitFrame(text ? compactMenu : "› \n", "codex", "/compact"),
    } };
  };
  const probes = (recovery: () => boolean) => ({
    resetFence: () => null,
    recovery,
    clear: () => ({ state: "absent" as const }),
  });
  const happy = base();
  const out = lockedCompactSubmit(bare, authority, happy.readiness, happy.fx, probes(() => false));
  expect(out.result).toEqual({ status: "injected" });
  expect(happy.effects).toEqual(["inject", "enter"]);
  expect(out.baselineOffset).toBe(statSync(ROLLOUT).size);
  expect(Number.isFinite(Date.parse(out.submitAt))).toBe(true);
  for (const late of [{ title: "⠋ Codex" }, { screen: "• Working (1s • esc to interrupt)\n" + compactMenu },
    { screen: compactMenu.replace("› /compact", "› foreign input") }, { screen: "unreadable" }, { screen: "› /compact\n  tab to queue message\n" }]) {
    const changed = base(false, late);
    expect(() => lockedCompactSubmit(bare, authority, changed.readiness, changed.fx, probes(() => false))).toThrow("readiness");
    expect(changed.effects).toEqual(["inject"]);
  }
  const newTurn = base();
  expect(() => lockedCompactSubmit(bare, authority, newTurn.readiness, { ...newTurn.fx, injectText: (...args) => {
    const accepted = newTurn.fx.injectText(args[0], args[1]);
    seedRollout(ROLLOUT, "old", [{ type: "turn_context", payload: { turn_id: "new-turn" } }]);
    return accepted;
  } }, probes(() => false))).toThrow("turn");
  expect(newTurn.effects).toEqual(["inject"]);
  seedRollout(ROLLOUT, "old", [{ type: "turn_context", payload: { turn_id: TURN } }]);
  const sticky = base(true);
  const uncertain = lockedCompactSubmit(bare, authority, sticky.readiness, sticky.fx, probes(() => false));
  expect(uncertain.result.status).toBe("unverified");
  expect(sticky.effects).toEqual(["inject", "enter"]);
  expect(Number.isFinite(Date.parse(uncertain.submitAt))).toBe(true);
  const alreadyHeld = base();
  expect(() => lockedCompactSubmit(bare, authority, () => "idle", alreadyHeld.fx, probes(() => true))).toThrow("recovery owns pane");
  expect(alreadyHeld.effects).toEqual([]);
  let calls = 0;
  const lateHold = base();
  expect(() => lockedCompactSubmit(bare, authority, lateHold.readiness, lateHold.fx, probes(() => ++calls > 1))).toThrow("recovery owns pane");
  expect(lateHold.effects).toEqual(["inject"]);
});
test("the resume body stages as a private file; the send is file-sourced and survives a tiny inline cap", () => {
  const dir = join(root, "resume-stage");
  mkdirSync(dir, { recursive: true });
  const focus = "F".repeat(5000);
  const bodyPath = stageResumeBody(dir, "w1", `Context compacted. focus: ${focus}`);
  expect(statSync(bodyPath).mode & 0o777).toBe(0o600);
  expect(readFileSync(bodyPath, "utf8")).toContain(focus);
  expect(resumeSendArgs("worker", bodyPath)).toEqual(["worker", "--from", "worker", "--note", "--wake", "-f", bodyPath]);
  const scripts = new URL("../../../skills/tap/scripts", import.meta.url).pathname;
  const prev = process.env.TAP_INLINE_MAX_BYTES;
  process.env.TAP_INLINE_MAX_BYTES = "1";
  try {
    let inlineRefused = "";
    try { cmdSendOutcome(["worker", "--from", "worker", "--note", "--wake", "-m", "x".repeat(5000)], scripts, AGENT_FAMILIES); }
    catch (error) { inlineRefused = String(error); }
    expect(inlineRefused).toContain("Too big for inline");
    let fileError = "";
    try { cmdSendOutcome(resumeSendArgs("worker", bodyPath), scripts, AGENT_FAMILIES); }
    catch (error) { fileError = String(error); }
    expect(fileError).not.toContain("Too big for inline");
  } finally {
    if (prev === undefined) delete process.env.TAP_INLINE_MAX_BYTES;
    else process.env.TAP_INLINE_MAX_BYTES = prev;
  }
});
test("the production detach seam outlives a killed invoker and leaves a terminal receipt plus pointer", async () => {
  const scratch = join(root, "r10");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(scratch, { recursive: true });
  const rollout = join(scratch, "rollout.jsonl");
  seedRollout(rollout, "s1");
  const registry = join(scratch, "registry.json");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "team" }, seats: { worker: { label: "w", harness: "codex", pane: "sess:0.0", pane_id: "%999999", instance: "original", server_epoch: "epoch", harness_session_id: "s1", transcript_path: rollout, status: "active", delivery: "pane" } } }));
  const req: CompactRequest = { id: "r10-worker", registry, bus: scratch, team: "team", handle: "worker", command: "/compact",
    bound: { paneId: "%999999", instance: "original", serverEpoch: "epoch", harness: "codex", handle: "worker" },
    oldSession: "s1", oldTranscript: rollout, handoff: join(scratch, "h.md"), focus: "f", resumePing: "p", turnId: "t-arm" };
  writeFileSync(join(scratch, "h.md"), "in flight work");
  const requestPath = join(scratch, "r10-worker.compact.json");
  writeFileSync(requestPath, JSON.stringify(req) + "\n");
  const receiptPath = join(scratch, "r10-worker.compact.receipt.json");
  const helperLog = join(scratch, "self-helper.log");
  const workerScript = new URL("../src/self-compact.ts", import.meta.url).pathname;
  const detacher = join(scratch, "detacher.mjs");
  const spawned = join(scratch, "spawned.json");
  // The worker lives ~100 ms, so a pgrep poll can miss it entirely and a
  // later pid read can race its exit (tap-dikjw). The invoker records the pid
  // it spawned and stops the worker before it can finish, so killing the
  // invoker's group is decided while the worker is certainly alive.
  writeFileSync(detacher, `const { spawnDetachedWorker } = await import(process.argv[2]);
const { closeSync, existsSync, openSync, writeFileSync } = await import("node:fs");
const log = openSync(process.argv[5], "a", 0o600);
const pid = spawnDetachedWorker(process.execPath, process.argv[3], process.argv[4], log, process.env);
process.kill(pid, "SIGSTOP");
const pgid = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)]).stdout.toString().trim();
writeFileSync(process.argv[6], JSON.stringify({ pid, pgid, startedBeforeStop: existsSync(process.argv[4] + ".started") }));
closeSync(log);
await Bun.sleep(30000);
`);
  const midErr = openSync(join(scratch, "mid.err"), "a", 0o600);
  const mid = Bun.spawn([process.execPath, detacher, workerScript, workerScript, requestPath, join(scratch, "detached.log"), spawned],
    { detached: true, stdin: "ignore", stdout: "ignore", stderr: midErr, env: { ...process.env, TAP_INDEX_HOME: scratch } });
  mid.unref();
  closeSync(midErr);
  let worker: { pid: number; pgid: string; startedBeforeStop: boolean } | undefined;
  try {
    // Separate budgets: startup of two Bun processes, then the worker's own run.
    for (let i = 0; i < 300 && !worker; i++) {
      try { worker = JSON.parse(readFileSync(spawned, "utf8")); } catch { await Bun.sleep(50); }
    }
    if (!worker) throw new Error(`worker never recorded; stderr: ${readFileSync(join(scratch, "mid.err"), "utf8")}`);
    expect(worker.startedBeforeStop).toBe(false);
    expect(worker.pgid).not.toBe("");
    expect(Number(worker.pgid)).not.toBe(mid.pid);
    process.kill(-mid.pid, "SIGKILL");
    await mid.exited;
    expect(Bun.spawnSync(["kill", "-0", String(worker.pid)]).exitCode).toBe(0);
    process.kill(worker.pid, "SIGCONT");
    let terminal = "";
    for (let i = 0; i < 300; i++) {
      try { terminal = JSON.parse(readFileSync(receiptPath, "utf8")).state ?? ""; } catch { /* not yet */ }
      if (["not-compacted", "incomplete", "compacted"].includes(terminal)) break;
      await Bun.sleep(100);
    }
    expect(["not-compacted", "incomplete", "compacted"]).toContain(terminal);
    expect(existsSync(`${requestPath}.started`)).toBe(true);
    expect(readFileSync(helperLog, "utf8")).toContain("r10-worker");
  } finally {
    // Teardown must never meet a live invoker holding mid.err or a stopped worker.
    try { process.kill(-mid.pid, "SIGKILL"); } catch { /* already gone */ }
    if (worker) { try { process.kill(worker.pid, "SIGCONT"); } catch { /* already gone */ } }
    await mid.exited;
  }
}, 70000);

test("missing Enter proof preserves the courier refusal and does not observe or retry", async () => {
  const f = fakePane({ startState: "idle" });
  const refusal = "input did not land on '%5'";
  let submissions = 0;
  f.fx.submit = () => { submissions++; return { result: { status: "unverified", detail: refusal }, submitAt: "", baselineOffset: -1 }; };
  f.fx.wait = async () => { throw new Error("must not await proof without an Enter boundary"); };
  await run(f);
  expect(submissions).toBe(1);
  expect(f.receipts.at(-1)).toMatchObject({ state: "incomplete" });
  expect(f.receipts.at(-1)!.detail).toContain(refusal);
  expect(f.receipts.at(-1)!.detail).toContain("submission proof clock unavailable");
  expect(f.log).toEqual([]);
});

// --- Claude and OpenCode wake modes ----------------------------------------------

const WSEAT: Seat = { pane_id: "%7", instance: "w-inst", server_epoch: "epoch", boot_id: "boot", harness: "claude" };
function wakeRequest(mode: "claude" | "opencode", overrides: Partial<WakeRequest> = {}): WakeRequest {
  return { mode, id: "wake-1", registry: join(root, "registry.json"), bus: root, team: "team", handle: "worker",
    bound: { paneId: "%7", instance: "w-inst", serverEpoch: "epoch", bootId: "boot", harness: mode, handle: "worker" },
    session: "bound-session", transcript: "", handoff: "/bus/handoff/worker.md", focus: "live threads", resumePing: "Post-compaction resume check. Read /bus/handoff/worker.md first.", ...overrides };
}
function fakeWake(opts: { proof?: boolean; states?: string[]; submit?: SubmitResult; drift?: "start" | "resume"; sendRc?: number; sendThrows?: boolean } = {}) {
  let time = 0, tick = 0, settled = false;
  const log: string[] = [], receipts: WakeReceipt[] = [], unverified: string[] = [];
  const fixtures = { claude: proofFixture(root, "claude"), opencode: proofFixture(root, "opencode") };
  const request = (mode: "claude" | "opencode", overrides: Partial<WakeRequest> = {}) => wakeRequest(mode,
    { transcript: fixtures[mode].path, boundary: fixtures[mode].boundary, ...overrides });
  let submitted = false;
  const seat = (mode: "claude" | "opencode") => ({ ...WSEAT, ...fixtures[mode].seat });
  const fx = (mode: "claude" | "opencode"): WakeEffects => ({
    row: () => (opts.drift === "start" || (opts.drift === "resume" && settled)) ? { ...seat(mode), instance: "replacement" } : seat(mode),
    state: () => (opts.states?.[Math.min(tick, (opts.states?.length ?? 1) - 1)] ?? "idle") as "idle",
    submit: () => { log.push("submit"); submitted = true; return { result: opts.submit ?? { status: "injected" }, boundary: fixtures[mode].boundary }; },
    send: body => {
      log.push(`send:${body}`);
      expect(settled).toBe(true);
      if (opts.sendThrows) throw new Error("bus unavailable");
      return { rc: opts.sendRc ?? 0, disposition: opts.sendRc ? "unverified" : "queued-spool" };
    },
    record: r => receipts.push(r),
    unverified: reason => unverified.push(reason),
    unlock: () => log.push("unlock"),
    settle: s => { log.push(`settle:${s}`); settled = true; time += s * 1000; },
    wait: async () => {
      tick++; time += 250;
      if (opts.proof !== false && (mode === "claude" || submitted)) fixtures[mode].summary(1000 + time);
    },
    now: () => time,
  });
  return { fx, request, log, receipts, unverified };
}

test("a detached worker's request registry refuses an old format before any row is read", () => {
  const dir = join(root, "request-seat");
  mkdirSync(dir, { recursive: true });
  const current = join(dir, "current.json"), old = join(dir, "old.json");
  writeFileSync(current, JSON.stringify({ schema: "0.20", team: { name: "team" }, seats: { worker: WSEAT } }));
  writeFileSync(old, JSON.stringify({ schema: "0.20", agents: { worker: WSEAT } }));
  expect(requestSeat(current, "worker")).toMatchObject({ pane_id: "%7", instance: "w-inst" });
  let caught: unknown = null;
  try { requestSeat(old, "worker"); } catch (error) { caught = error; }
  expect(isOldStoreRefusal(caught)).toBe(true);
});

test("claude and opencode wakes: an old_store row read records incomplete and never submits or sends", async () => {
  for (const mode of ["claude", "opencode"] as const) {
    const f = fakeWake({ states: ["idle"] });
    const fx = f.fx(mode);
    fx.row = () => requestSeat(join(root, "request-seat", "old.json"), "worker");
    await runWake(f.request(mode), fx, 2000);
    expect(f.log.filter(entry => entry === "submit" || entry.startsWith("send:"))).toEqual([]);
    expect(f.receipts.at(-1)?.state).toBe("incomplete");
    expect(f.receipts.at(-1)?.detail).toContain("old_store");
  }
});


test("claude wake: observed compaction, spacing, then the resume note; no pane submit", async () => {
  const f = fakeWake({  });
  await runWake(f.request("claude"), f.fx("claude"), 5000);
  expect(f.log).toEqual(["unlock", "settle:2", "send:Post-compaction resume check. Read /bus/handoff/worker.md first."]);
  expect(f.receipts.map(r => r.state)).toEqual(["compacted", "resume-sent"]);
  expect(f.unverified).toEqual([]);
});

test("claude wake: missing proof preserves the handoff and sends no resume", async () => {
  const f = fakeWake({ proof: false });
  await runWake(f.request("claude"), f.fx("claude"), 2000);
  expect(f.receipts.map(r => r.state)).toEqual(["not-compacted"]);
  expect(f.receipts[0]!.detail).toContain("handoff preserved");
  expect(f.unverified).toEqual(["compaction-never-observable"]);
  expect(f.log.filter(l => l.startsWith("send:"))).toHaveLength(0);
});

test("claude wake: a replaced seat gets nothing; a seat replaced before resume is a resume-miss", async () => {
  const early = fakeWake({ drift: "start" });
  await runWake(early.request("claude"), early.fx("claude"), 5000);
  expect(early.receipts.map(r => r.state)).toEqual(["incomplete"]);
  expect(early.log).toEqual([]);
  const late = fakeWake({ drift: "resume" });
  await runWake(late.request("claude"), late.fx("claude"), 5000);
  expect(late.receipts.at(-1)!.state).toBe("resume-miss");
  expect(late.log.some(l => l.startsWith("send:"))).toBe(false);
});

test("wake: a refused or failed resume send is a resume-miss and is recorded unverified", async () => {
  const refused = fakeWake({ sendRc: 1 });
  await runWake(refused.request("claude"), refused.fx("claude"), 5000);
  expect(refused.receipts.at(-1)).toMatchObject({ state: "resume-miss", delivery: "unverified" });
  expect(refused.unverified).toEqual(["resume-send-failed"]);
  const thrown = fakeWake({ sendThrows: true });
  await runWake(thrown.request("claude"), thrown.fx("claude"), 5000);
  expect(thrown.receipts.at(-1)!.state).toBe("resume-miss");
});

test("opencode wake: two idle reads, one bare /compact, then the resume", async () => {
  const f = fakeWake({ states: ["working", "idle", "working", "idle", "idle"] });
  await runWake(f.request("opencode"), f.fx("opencode"), 10000);
  expect(f.log.filter(l => l === "submit")).toHaveLength(1);
  expect(f.log.indexOf("submit")).toBeLessThan(f.log.indexOf("unlock"));
  expect(f.receipts.map(r => r.state)).toEqual(["submitted", "compacted", "resume-sent"]);
});

test("opencode wake: a pane that never idles is not compacted and gets nothing", async () => {
  const f = fakeWake({ states: ["working"] });
  await runWake(f.request("opencode"), f.fx("opencode"), 3000);
  expect(f.receipts.map(r => r.state)).toEqual(["not-compacted"]);
  expect(f.log).toEqual([]);
});

test("opencode wake: one idle read followed by work is not a turn boundary and submits nothing", async () => {
  // Two consecutive idle reads are required; an `idle >= 1` gate would submit here.
  const f = fakeWake({ states: ["idle", "working"] });
  await runWake(f.request("opencode"), f.fx("opencode"), 3000);
  expect(f.receipts.map(r => r.state)).toEqual(["not-compacted"]);
  expect(f.log).toEqual([]);
});

test("opencode wake: a refused submit (occupied composer) is terminal, never retried, no resume", async () => {
  const f = fakeWake({ submit: { status: "band_busy", detail: "pending input held" } });
  await runWake(f.request("opencode"), f.fx("opencode"), 3000);
  expect(f.log).toEqual(["submit"]);
  expect(f.receipts.map(r => r.state)).toEqual(["incomplete"]);
});

test("opencode wake: an unverified submit is not repeated; fresh store proof permits the resume", async () => {
  const f = fakeWake({ submit: { status: "unverified", detail: "input did not clear" } });
  await runWake(f.request("opencode"), f.fx("opencode"), 3000);
  expect(f.log.filter(l => l === "submit")).toHaveLength(1);
  expect(f.receipts.map(r => r.state)).toEqual(["submission-unverified", "compacted", "resume-sent"]);
  expect(f.unverified).toEqual(["submission-unverified"]);
});

test("wake without a precomposed ping names the handoff and the poll", async () => {
  const f = fakeWake({  });
  await runWake(f.request("claude", { resumePing: undefined }), f.fx("claude"), 5000);
  const sent = f.log.find(l => l.startsWith("send:"))!;
  expect(sent).toContain("Read /bus/handoff/worker.md first");
  expect(sent).toContain("tap poll worker");
});

for (const mode of ["claude", "opencode"] as const) {
  test(`${mode} missing proof cannot unlock, settle or send`, async () => {
    const f = fakeWake({ proof: false, submit: { status: "unverified", detail: "possible effect" } });
    await runWake(f.request(mode), f.fx(mode), 2000);
    expect(f.receipts.at(-1)?.state).toBe("not-compacted");
    expect(f.receipts.some(r => r.state === "compacted")).toBe(false);
    expect(f.log).toEqual(mode === "claude" ? [] : ["submit"]);
  });
  test(`${mode} proof receipt survives the terminal resume receipt`, async () => {
    const f = fakeWake();
    await runWake(f.request(mode), f.fx(mode), 2000);
    expect(f.receipts.at(-1)).toMatchObject({ state: "resume-sent", evidence: mode === "claude" ? "transcript-proven" : "store-proven" });
  });
  test(`${mode} same pane with a changed native session cannot resume`, async () => {
    const f = fakeWake();
    const fx = f.fx(mode), row = fx.row;
    fx.row = () => ({ ...row(), harness_session_id: "replacement" });
    await runWake(f.request(mode), fx, 2000);
    expect(f.receipts.at(-1)?.state).toBe("incomplete");
    expect(f.log).toEqual([]);
  });
}

test("Claude refuses to guess a missing Enter boundary even when a summary exists", async () => {
  const f = fakeWake();
  await runWake(f.request("claude", { boundary: undefined }), f.fx("claude"), 2000);
  expect(f.receipts.at(-1)?.state).toBe("not-compacted");
  expect(f.log).toEqual([]);
});

test("native-session drift while awaiting proof ends without a resume", async () => {
  const f = fakeWake();
  const fx = f.fx("claude"), wait = fx.wait, row = fx.row;
  let drift = false;
  fx.wait = async () => { await wait(); drift = true; };
  fx.row = () => ({ ...row(), ...(drift ? { harness_session_id: "new" } : {}) });
  await runWake(f.request("claude"), fx, 2000);
  expect(f.receipts.at(-1)?.state).toBe("incomplete");
  expect(f.log).toEqual([]);
});

for (const at of ["start", "resume"]) test(`OpenCode store drift at ${at} blocks compaction follow-up`, async () => {
  const f = fakeWake(), fx = f.fx("opencode"), row = fx.row, settle = fx.settle;
  let changed = at === "start";
  fx.row = () => changed ? { ...row(), session_store_path: "/replacement.db" } : row();
  fx.settle = seconds => { settle(seconds); changed = true; };
  await runWake(f.request("opencode"), fx, 2000);
  expect(f.receipts.at(-1)?.state).toBe(at === "start" ? "incomplete" : "resume-miss");
  expect(f.log.some(line => line.startsWith("send:"))).toBe(false);
  if (at === "start") expect(f.log).toEqual([]);
});

// A new Claude request delegates its first pane effect to the detached worker.
// queuedAt distinguishes that authority from old proof-only requests.
for (const refusal of [
  { status: "lock_busy", detail: "lock held" },
  { status: "band_busy", detail: "human draft" },
  { status: "copy_mode", cause: "copy-mode", detail: "scrolled" },
  { status: "recovery_held", detail: "recovery owns pane" },
  { status: "rate_limited", detail: "client budget" },
] as const) test(`queued Claude waits on proven no-effect ${refusal.status}, then submits once while working`, async () => {
  const f = fakeWake(), fx = f.fx("claude"), submit = fx.submit;
  let attempts = 0;
  fx.state = () => { throw new Error("Claude busy/idle is not the composer gate"); };
  fx.submit = () => ++attempts < 3 ? { result: refusal, effectAttempted: false } : { ...submit(), effectAttempted: true };
  await runWake(f.request("claude", { queuedAt: 0, boundary: undefined }), fx, 3000);
  expect(attempts).toBe(3);
  expect(f.log.filter(x => x === "submit")).toHaveLength(1);
  expect(f.receipts.at(-1)).toMatchObject({ state: "resume-sent", queuedAt: new Date(0).toISOString(), submittedAt: new Date(500).toISOString(), evidence: "transcript-proven" });
  expect(f.receipts.map(r => r.state)).toContain("queued");
  expect(f.receipts.map(r => r.state)).toContain("submitted");
});

test("queued Claude timeout preserves the handoff and sends no resume or input", async () => {
  const f = fakeWake(), fx = f.fx("claude");
  let attempts = 0;
  fx.submit = () => { attempts++; return { result: { status: "band_busy", detail: "human draft" }, effectAttempted: false }; };
  await runWake(f.request("claude", { queuedAt: 0, boundary: undefined }), fx, 1000);
  expect(attempts).toBe(4);
  expect(f.receipts.at(-1)).toMatchObject({ state: "not-submitted", handoff: "/bus/handoff/worker.md" });
  expect(f.log).toEqual([]);
  expect(TERMINAL.has("not-submitted")).toBe(true);
});

for (const effectAttempted of [true, undefined]) test(`queued Claude never retries a refusal without no-effect proof (${effectAttempted})`, async () => {
  const f = fakeWake(), fx = f.fx("claude");
  let attempts = 0;
  fx.submit = () => { attempts++; return { result: { status: "band_busy", detail: "uncertain partial control" }, effectAttempted }; };
  await runWake(f.request("claude", { queuedAt: 0, boundary: undefined }), fx, 1000);
  expect(attempts).toBe(1);
  expect(f.log).toEqual([]);
  expect(f.receipts.at(-1)?.state).not.toBe("resume-sent");
});

test("queued Claude observes proof after an uncertain Enter but never retypes", async () => {
  const f = fakeWake({ submit: { status: "unverified", detail: "possible Enter" } }), fx = f.fx("claude"), submit = fx.submit;
  let attempts = 0;
  fx.submit = () => { attempts++; return { ...submit(), effectAttempted: true }; };
  await runWake(f.request("claude", { queuedAt: 0, boundary: undefined }), fx, 1000);
  expect(attempts).toBe(1);
  expect(f.receipts.map(r => r.state)).toContain("submission-unverified");
  expect(f.receipts.at(-1)?.state).toBe("resume-sent");
});

test("an expired queued request never attempts input", async () => {
  const f = fakeWake(), fx = f.fx("claude");
  await runWake(f.request("claude", { queuedAt: -2000, boundary: undefined }), fx, 1000);
  expect(f.receipts.at(-1)?.state).toBe("not-submitted");
  expect(f.log).toEqual([]);
});

test("queued Claude rechecks owner identity after every no-effect deferral", async () => {
  const f = fakeWake(), fx = f.fx("claude"), row = fx.row, wait = fx.wait;
  let changed = false, attempts = 0;
  fx.row = () => changed ? { ...row(), instance: "replacement" } : row();
  fx.submit = () => { attempts++; return { result: { status: "copy_mode", cause: "copy-mode", detail: "scrolled" }, effectAttempted: false }; };
  fx.wait = async () => { await wait(); changed = true; };
  await runWake(f.request("claude", { queuedAt: 0, boundary: undefined }), fx, 1000);
  expect(attempts).toBe(1);
  expect(f.receipts.at(-1)?.state).toBe("incomplete");
  expect(f.log).toEqual([]);
});


test("opaque Claude input remains explicit in the terminal receipt without claiming a submit", async () => {
  const f = fakeWake(), fx = f.fx("claude");
  let attempts = 0;
  fx.submit = () => { attempts++; return { result: { status: "unverified", detail: "opaque paste left in place" }, effectAttempted: true }; };
  await runWake(f.request("claude", { queuedAt: 0, boundary: undefined }), fx, 1000);
  expect(attempts).toBe(1);
  expect(f.log).toEqual([]);
  expect(f.receipts.at(-1)?.state).toBe("not-compacted");
  expect(f.receipts.at(-1)?.submittedAt).toBeUndefined();
  expect(f.receipts.at(-1)?.detail).toContain("input may have reached the composer");
  expect(f.receipts.at(-1)?.detail).toContain("no retry or resume sent");
  expect(f.receipts.at(-1)?.detail).not.toContain("nothing sent");
});


test("Claude spawn failure retains its queued timestamp in the terminal receipt", () => {
  const f = fakeWake();
  const request = f.request("claude", { id: "spawn-failure", queuedAt: 1234, boundary: undefined });
  expect(() => spawnRequest(join(root, "missing-bun"), root, request.id, request, { mode: "claude", handoff: request.handoff })).toThrow();
  const receipt = JSON.parse(readFileSync(join(root, "handoff", "spawn-failure.compact.receipt.json"), "utf8"));
  expect(receipt).toMatchObject({ state: "incomplete", id: request.id, queuedAt: new Date(1234).toISOString(), handoff: request.handoff });
  expect(receipt.detail).toContain("worker spawn failed; nothing submitted");
  expect(receipt.submittedAt).toBeUndefined();
});

// tap-vho8h: the worker typed, could not prove the frame, and pressed nothing.
// The terminal receipt, not only the overwritten intermediate one, must carry
// the submit detail and tell the operator the text is theirs to Enter.
test("claude wake: an unverified typed submit without an Enter boundary keeps its detail in the terminal receipt", async () => {
  const f = fakeWake({ submit: { status: "unverified", detail: "changed, idle, width 52; the typed /compact stays in the composer of 'p': press Enter there to submit it or clear it; nothing is retyped and no Enter is retried" } });
  const fx = f.fx("claude");
  fx.submit = () => { f.log.push("submit"); return { result: { status: "unverified", detail: "changed, idle, width 52; the typed /compact stays in the composer of 'p': press Enter there to submit it or clear it; nothing is retyped and no Enter is retried" }, effectAttempted: true }; };
  await runWake(f.request("claude", { boundary: undefined, queuedAt: 0 }), fx, 2000);
  expect(f.log.filter(l => l === "submit")).toHaveLength(1);
  expect(f.receipts.map(r => r.state)).toEqual(["queued", "submitting", "submission-unverified", "not-compacted"]);
  const terminal = f.receipts.at(-1)!;
  expect(terminal.detail).toContain("no Enter was pressed");
  expect(terminal.detail).toContain("changed, idle, width 52");
  expect(terminal.detail).toContain("press Enter there to submit it");
  expect(terminal.detail).toMatch(/retyp/);
  expect(terminal.detail).toContain("handoff preserved");
  expect(f.unverified).toEqual(["submission-unverified", "compaction-boundary-unavailable"]);
  expect(f.log.some(l => l.startsWith("send:"))).toBe(false);
});

// tap-vho8h (Codex review): an Enter that was attempted but not
// proven still captured a boundary, so the proof wait runs; when it times out
// the operator guidance from the submit must survive into the terminal receipt.
test("claude wake: an unverified submit with a boundary keeps its detail through the proof timeout", async () => {
  const f = fakeWake({ proof: false, submit: { status: "unverified", detail: "staged, working, width 52; the typed /compact stays in the composer of 'p': press Enter there to submit it or clear it; nothing is retyped and no Enter is retried" } });
  await runWake(f.request("claude", { boundary: undefined, queuedAt: 0 }), f.fx("claude"), 1500);
  expect(f.log.filter(l => l === "submit")).toHaveLength(1);
  const terminal = f.receipts.at(-1)!;
  expect(terminal.state).toBe("not-compacted");
  expect(terminal.detail).toContain("no fresh compaction proof after an unverified submit");
  expect(terminal.detail).toContain("staged, working, width 52");
  expect(terminal.detail).toContain("press Enter there to submit it");
  expect(f.log.some(l => l.startsWith("send:"))).toBe(false);
});
