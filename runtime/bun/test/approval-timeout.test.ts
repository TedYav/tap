import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  processApprovalTimeouts, readEpisodes, cancelOpenEpisodes,
  type ApprovalSeams, type Episode, type RejectResult, type SeatRow, type SiblingProof,
} from "../src/approval-timeout";
import { writePolicy, type ApprovalHarness } from "../src/approval-timeout-policy";
import { realApprovalSeams } from "../src/approval-timeout-real";

const fixtures = join(import.meta.dir, "fixtures", "agent-state");
const read = (harness: string, name: string) => readFileSync(join(fixtures, harness, name), "utf8");
const CODEX_PROMPT = read("codex", "blocked-real.txt");
const CODEX_IDLE = read("codex", "idle.ansi");
const CLAUDE_TRUST = read("claude", "trust-auto-real.txt");
const OPENCODE_PROMPT = read("opencode", "blocked-real.txt");
const REJECTED = /tell Codex what to do differently/; // stand-in marker for the fake after-frame

let bus: string;
// The pass runs only inside a full-mode tick, so every world starts armed.
const armWatch = (mode: string) => { mkdirSync(join(bus, "watch"), { recursive: true }); writeFileSync(join(bus, "watch", "arm.json"), JSON.stringify({ mode })); };
beforeEach(() => { bus = mkdtempSync(join(tmpdir(), "approval-timeout-")); armWatch("supervision"); });
afterEach(() => { rmSync(bus, { recursive: true, force: true }); });

interface World {
  seams: ApprovalSeams;
  frames: Record<string, string | null>;
  clock: { now: number };
  instances: Record<string, string | null>;
  rejects: { gate: string; sent: boolean }[];
  seat: string[];
  armer: string[];
  human: string[];
  lines: string[];
  proof: SiblingProof;
  afterReject: string | null;
  rejectStatus?: RejectResult["status"];
  live: boolean;
}

function world(overrides: Partial<World> = {}): World {
  const w: World = {
    frames: {}, clock: { now: 1000 }, instances: {}, rejects: [], seat: [], armer: [], human: [], lines: [],
    proof: "single", afterReject: "• rejected; tell Codex what to do differently\n" + CODEX_IDLE, live: true,
    ...overrides,
  } as World;
  w.seams = {
    bus,
    now: () => w.clock.now,
    capture: row => w.frames[row.handle] ?? null,
    instance: row => (row.handle in w.instances ? w.instances[row.handle]! : "inst-1"),
    siblingProof: () => w.proof,
    reject(row, _episode, gate, verify) {
      const refusal = gate();
      if (refusal) { w.rejects.push({ gate: refusal, sent: false }); return { status: "refused", summary: `refused before keys: ${refusal}` }; }
      w.rejects.push({ gate: "", sent: true });
      w.frames[row.handle] = w.afterReject;
      if (w.rejectStatus) return { status: w.rejectStatus, summary: "fake" };
      return verify() ? { status: "verified", summary: "ok", recovery: "recovery-1" } : { status: "unverified", summary: "not verified", recovery: "recovery-1" };
    },
    noticeSeat: handle => { w.seat.push(handle); return "injected"; },
    noticeArmer: (armer, e) => { w.armer.push(`${armer}:${e.outcome}:${e.reason ?? ""}`); return "injected"; },
    escalate: e => { w.human.push(`${e.outcome}:${e.reason ?? ""}`); return 0; },
    stderr: line => { w.lines.push(line); },
    live: () => w.live,
    timeout: () => 600,
    marker: () => REJECTED,
  };
  return w;
}

const row = (handle: string, harness: string): SeatRow => ({ handle, pane: `team:${handle}`, paneId: "%7", harness });
const events = () => {
  try { return readFileSync(join(bus, "approval-timeout", "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); }
  catch { return []; }
};

describe("approval-timeout pass (tap-rlebf.2)", () => {
  test("policy off: no capture and no write", () => {
    const w = world();
    let captures = 0;
    const capture = w.seams.capture;
    w.seams.capture = r => { captures++; return capture(r); };
    w.frames.c = CODEX_PROMPT;
    expect(processApprovalTimeouts([row("c", "codex")], "lead", w.seams)).toBe(0);
    expect(captures).toBe(0);
    expect(readEpisodes(bus)).toEqual({});
  });

  test("an expired Codex request gets exactly one guarded Escape, then a tombstone (AE1, AE5)", () => {
    writePolicy(bus, { enabled: true, by: "lead", at: 1 });
    const w = world();
    w.frames.c = CODEX_PROMPT;
    const seat = [row("c", "codex")];
    processApprovalTimeouts(seat, "lead", w.seams);
    const opened = readEpisodes(bus).c!;
    expect(opened.first_seen).toBe(1000);
    expect(opened.state).toBe("open");
    w.clock.now = 1300;
    processApprovalTimeouts(seat, "lead", w.seams);
    expect(readEpisodes(bus).c!.first_seen).toBe(1000);
    expect(w.rejects).toEqual([]);
    w.clock.now = 1601;
    processApprovalTimeouts(seat, "lead", w.seams);
    expect(w.rejects).toEqual([{ gate: "", sent: true }]);
    expect(w.seat).toEqual(["c"]);
    expect(w.armer).toEqual(["lead:verified:"]);
    expect(w.human).toEqual([]);
    expect(events().map(e => e.outcome)).toEqual(["verified"]);
  });

  test("an unverified rejection is never retried while the request stays (AE5)", () => {
    writePolicy(bus, { enabled: true, by: "lead", at: 1 });
    const w = world({ afterReject: CODEX_PROMPT });
    w.frames.c = CODEX_PROMPT;
    const seat = [row("c", "codex")];
    processApprovalTimeouts(seat, "lead", w.seams);
    for (const t of [1601, 1700, 2400, 3000]) { w.clock.now = t; processApprovalTimeouts(seat, "lead", w.seams); }
    expect(w.rejects.filter(r => r.sent)).toHaveLength(1);
    expect(w.seat).toEqual([]);
    expect(w.armer).toEqual(["lead:unverified:not verified"]);
    expect(readEpisodes(bus).c!.state).toBe("tombstone");
  });

  test("an after-frame without the rejection marker is unverified and the seat is not told", () => {
    writePolicy(bus, { enabled: true, by: "lead", at: 1 });
    const w = world({ afterReject: CODEX_IDLE });
    w.frames.c = CODEX_PROMPT;
    processApprovalTimeouts([row("c", "codex")], "lead", w.seams);
    w.clock.now = 1601;
    processApprovalTimeouts([row("c", "codex")], "lead", w.seams);
    expect(w.armer).toEqual(["lead:unverified:not verified"]);
    expect(w.seat).toEqual([]);
  });

  test("a row without captured evidence reports blocked and escalates once (AE4)", () => {
    writePolicy(bus, { enabled: true, by: "lead", at: 1 });
    const w = world({ live: false });
    w.frames.c = CODEX_PROMPT;
    const seat = [row("c", "codex")];
    processApprovalTimeouts(seat, "lead", w.seams);
    for (const t of [1601, 1661, 1721, 5000]) { w.clock.now = t; processApprovalTimeouts(seat, "lead", w.seams); }
    expect(w.rejects).toEqual([]);
    expect(w.armer).toEqual(["lead:no_action:mapping_unproven"]);
    expect(w.human).toEqual(["no_action:mapping_unproven"]);
    expect(events()).toHaveLength(1);
  });

  test("a changed request ends the episode and starts a new clock (AE3)", () => {
    writePolicy(bus, { enabled: true, by: "lead", at: 1 });
    const w = world();
    w.frames.c = CODEX_PROMPT;
    const seat = [row("c", "codex")];
    processApprovalTimeouts(seat, "lead", w.seams);
    w.clock.now = 1500;
    w.frames.c = CODEX_PROMPT.replaceAll("date > ~/.tap-onreq-probe.txt", "echo other");
    processApprovalTimeouts(seat, "lead", w.seams);
    expect(readEpisodes(bus).c!.first_seen).toBe(1500);
    expect(events().map(e => e.ended)).toEqual(["ended_changed"]);
  });

  test("a resolved request ends silently; a rebound seat ends its episode", () => {
    writePolicy(bus, { enabled: true, by: "lead", at: 1 });
    const w = world();
    w.frames.c = CODEX_PROMPT;
    const seat = [row("c", "codex")];
    processApprovalTimeouts(seat, "lead", w.seams);
    w.frames.c = CODEX_IDLE;
    processApprovalTimeouts(seat, "lead", w.seams);
    expect(readEpisodes(bus)).toEqual({});
    w.frames.c = CODEX_PROMPT;
    processApprovalTimeouts(seat, "lead", w.seams);
    w.instances.c = "inst-2";
    w.clock.now = 1700;
    processApprovalTimeouts(seat, "lead", w.seams);
    expect(events().map(e => e.ended)).toEqual(["ended_resolved", "ended_rebound"]);
    expect(readEpisodes(bus).c!.first_seen).toBe(1700);
    expect(w.armer).toEqual([]);
  });

  test("trust dialogs never open an episode (AE2)", () => {
    writePolicy(bus, { enabled: true, by: "lead", at: 1 });
    const w = world();
    w.frames.t = CLAUDE_TRUST;
    for (const t of [1000, 5000]) { w.clock.now = t; processApprovalTimeouts([row("t", "claude")], "lead", w.seams); }
    expect(readEpisodes(bus)).toEqual({});
    expect(w.rejects).toEqual([]);
  });

  test("an unreadable capture keeps the episode", () => {
    writePolicy(bus, { enabled: true, by: "lead", at: 1 });
    const w = world();
    w.frames.c = CODEX_PROMPT;
    processApprovalTimeouts([row("c", "codex")], "lead", w.seams);
    w.frames.c = null;
    processApprovalTimeouts([row("c", "codex")], "lead", w.seams);
    expect(readEpisodes(bus).c!.state).toBe("open");
  });

  test("a deadline passed while the watcher was down acts once on the next tick", () => {
    writePolicy(bus, { enabled: true, by: "lead", at: 1 });
    const w = world();
    w.frames.c = CODEX_PROMPT;
    processApprovalTimeouts([row("c", "codex")], "lead", w.seams);
    w.clock.now = 100_000;
    processApprovalTimeouts([row("c", "codex")], "lead", w.seams);
    processApprovalTimeouts([row("c", "codex")], "lead", w.seams);
    expect(w.rejects.filter(r => r.sent)).toHaveLength(1);
  });

  test("the policy turned off before the key sends nothing (AE6)", () => {
    writePolicy(bus, { enabled: true, by: "lead", at: 1 });
    const w = world();
    w.frames.c = CODEX_PROMPT;
    processApprovalTimeouts([row("c", "codex")], "lead", w.seams);
    w.clock.now = 1601;
    // Turned off after the claim, before the gate's last read.
    const reject = w.seams.reject;
    w.seams.reject = (r, e, gate, verify) => { writePolicy(bus, { enabled: false, by: "lead", at: 2 }); return reject(r, e, gate, verify); };
    processApprovalTimeouts([row("c", "codex")], "lead", w.seams);
    expect(w.rejects).toEqual([{ gate: "policy_off", sent: false }]);
    expect(readEpisodes(bus).c!.outcome).toBe("cancelled_policy_off");
  });

  test("a watch disarmed or switched to reminders-only before the key sends nothing (R15)", () => {
    for (const change of [() => rmSync(join(bus, "watch", "arm.json")), () => armWatch("reminders-only")]) {
      armWatch("supervision");
      writePolicy(bus, { enabled: true, by: "lead", at: 1 });
      const w = world();
      w.frames.c = CODEX_PROMPT;
      processApprovalTimeouts([row("c", "codex")], "lead", w.seams);
      w.clock.now = 1601;
      const reject = w.seams.reject;
      w.seams.reject = (r, e, gate, verify) => { change(); return reject(r, e, gate, verify); };
      processApprovalTimeouts([row("c", "codex")], "lead", w.seams);
      expect(w.rejects).toEqual([{ gate: "the watch is no longer armed in full mode", sent: false }]);
      expect(readEpisodes(bus).c!.reason).toBe("gate_refused");
      rmSync(join(bus, "approval-timeout"), { recursive: true, force: true });
    }
  });

  test("off cancels open episodes and keeps tombstones", () => {
    writePolicy(bus, { enabled: true, by: "lead", at: 1 });
    const w = world();
    w.frames.a = CODEX_PROMPT;
    w.frames.b = CODEX_PROMPT;
    processApprovalTimeouts([row("a", "codex"), { ...row("b", "codex"), paneId: "%8" }], "lead", w.seams);
    expect(cancelOpenEpisodes(bus, 1100)).toBe(2);
    const after = readEpisodes(bus);
    expect(Object.values(after).map(e => [e.state, e.outcome])).toEqual([["tombstone", "cancelled_policy_off"], ["tombstone", "cancelled_policy_off"]]);
    expect(cancelOpenEpisodes(bus, 1200)).toBe(0);
  });

  test("a gate that sees a changed request refuses before the key", () => {
    writePolicy(bus, { enabled: true, by: "lead", at: 1 });
    const w = world();
    w.frames.c = CODEX_PROMPT;
    processApprovalTimeouts([row("c", "codex")], "lead", w.seams);
    w.clock.now = 1601;
    const capture = w.seams.capture;
    let reads = 0;
    w.seams.capture = r => (++reads === 2 ? CODEX_PROMPT.replaceAll("date >", "date >>") : capture(r));
    processApprovalTimeouts([row("c", "codex")], "lead", w.seams);
    expect(w.rejects).toEqual([{ gate: "the request changed or left before the key", sent: false }]);
    expect(readEpisodes(bus).c!.reason).toBe("gate_refused");
  });

  test("a claim without an outcome is reported unverified once, never retried", () => {
    writePolicy(bus, { enabled: true, by: "lead", at: 1 });
    const w = world();
    w.frames.c = CODEX_PROMPT;
    w.seams.reject = () => { throw new Error("crashed mid-effect"); };
    processApprovalTimeouts([row("c", "codex")], "lead", w.seams);
    w.clock.now = 1601;
    processApprovalTimeouts([row("c", "codex")], "lead", w.seams);
    expect(readEpisodes(bus).c!.outcome).toBe("unverified");
    expect(w.armer).toEqual(["lead:unverified:crashed mid-effect"]);
  });

  test("OpenCode with a sibling pending escalates once and re-checks; a later single proof acts (AE7)", () => {
    writePolicy(bus, { enabled: true, by: "lead", at: 1 });
    const w = world({ proof: "pending", afterReject: read("opencode", "idle-real.txt") });
    w.seams.marker = () => /Build/;
    w.frames.o = OPENCODE_PROMPT;
    const seat = [row("o", "opencode")];
    processApprovalTimeouts(seat, "lead", w.seams);
    for (const t of [1601, 1661, 1721]) { w.clock.now = t; processApprovalTimeouts(seat, "lead", w.seams); }
    expect(w.rejects).toEqual([]);
    expect(w.armer).toEqual(["lead:no_action:sibling_pending"]);
    expect(w.human).toEqual(["no_action:sibling_pending"]);
    expect(readEpisodes(bus).o!.state).toBe("open");
    w.proof = "single";
    w.clock.now = 1781;
    processApprovalTimeouts(seat, "lead", w.seams);
    expect(w.rejects).toEqual([{ gate: "", sent: true }]);
    expect(events().map(e => `${e.outcome}:${e.reason ?? ""}`)).toEqual(["no_action:sibling_pending", "verified:"]);
  });

  test("OpenCode 2 production proof records version_unproven and sends nothing", () => {
    writePolicy(bus, { enabled: true, by: "lead", at: 1 });
    const w = world();
    w.seams.siblingProof = realApprovalSeams({bus, scripts:"", registry:join(bus,"missing.json"),env:process.env,now:()=>w.clock.now}).siblingProof;
    w.frames.o = OPENCODE_PROMPT;
    processApprovalTimeouts([row("o", "opencode")], "lead", w.seams);
    w.clock.now = 1601;
    processApprovalTimeouts([row("o", "opencode")], "lead", w.seams);
    expect(w.rejects).toEqual([]);
    expect(readEpisodes(bus).o!.reason).toBe("version_unproven");
  });

  test("a missing frame deny label sends nothing", () => {
    writePolicy(bus, { enabled: true, by: "lead", at: 1 });
    const w = world();
    w.frames.c = CODEX_PROMPT.replace("(esc)", "");
    processApprovalTimeouts([row("c", "codex")], "lead", w.seams);
    w.clock.now = 1601;
    processApprovalTimeouts([row("c", "codex")], "lead", w.seams);
    expect(w.rejects).toEqual([]);
    expect(readEpisodes(bus).c!.reason).toBe("label_missing");
  });

  test("a corrupt episode store fails the door with one line", () => {
    writePolicy(bus, { enabled: true, by: "lead", at: 1 });
    Bun.write(join(bus, "approval-timeout", "episodes.json"), "{not json");
    const w = world();
    w.frames.c = CODEX_PROMPT;
    expect(processApprovalTimeouts([row("c", "codex")], "lead", w.seams)).toBe(1);
    expect(w.lines).toHaveLength(1);
    expect(w.lines[0]).toStartWith("tap watch: approval-timeout:");
  });
});
