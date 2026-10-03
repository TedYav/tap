import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquirePaneLock } from "../src/panelock";
import { active, createRun, MAX_EFFECTS, owns, readRun, recoveryHold, releaseRun, runDirectory, WALL_MS, writeRun,
  type Liveness, type RecoveryTarget } from "../src/recovery/state";
import { resolveCatalog } from "../src/launcher/catalog";
import { escalateRecovery, recordObservation, recoveryEffect, type EffectIO } from "../src/recovery/effect";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(harness = "codex") {
  const root = mkdtempSync(join(tmpdir(), "tap-recovery-")); roots.push(root);
  const env = { ...process.env, TAP_INDEX_HOME: root, TAP_LOCK_DIR: join(root, "locks") };
  const target: RecoveryTarget = { team: "test", handle: "peer", registry: join(root, "registry.json"),
    pane: "test/peer:0.0", paneId: "%701", session: "test/peer", instance: "peer-instance", harness, processPid: "101" };
  const facts: Liveness = { now: 1000, processAlive: () => true, paneAlive: () => true };
  const run = createRun(target, "aggressive", [{ home: join(root, "bus"), id: "payload-1" }], "%700", process.pid, env, facts);
  const effects: string[][] = []; let captures = 0;
  const io: EffectIO = {
    capture: () => `frame-${++captures}`,
    snapshot: () => ({ dead: "0", command: "codex", windowCount: "2", paneId: "%701", instance: "peer-instance" }),
    authorize: () => null, settle: () => {},
    effect(args) {
      const files = readdirSync(runDirectory(run.id, env));
      expect(files.some(f => f.endsWith(".before.ansi"))).toBe(true);
      expect(files.some(f => f.endsWith(".intent.json"))).toBe(true);
      effects.push(args); return { code: 0, stdout: "", stderr: "" };
    },
  };
  const action = () => recoveryEffect(run.id, "dismiss dialog", "aggressive: ordinary harness dialog", ["send-keys", "-t", "%701", "Escape"], io, env, () => facts);
  return { root, env, target, facts, run, io, effects, action };
}
test("exclusive hold uses existing kernel mutex; elapsed deadline permits a successor without stale-release theft", () => {
  const f = fixture();
  expect(owns(f.run, f.env, f.facts)).toBe(true);
  expect(() => createRun(f.target, "aggressive", [], "%700", process.pid, f.env, f.facts)).toThrow("already");
  f.facts.now = f.run.deadline;
  expect(recoveryHold(f.target.paneId, f.env, f.facts)).toBe(false);
  const next = createRun(f.target, "aggressive", [], "%700", process.pid, f.env, f.facts);
  releaseRun(f.run.id, "old run exits", f.env);
  expect(owns(next, f.env, f.facts)).toBe(true);
  expect(next.deadline - next.started).toBe(WALL_MS);
});
test("in-flight pane operation prevents recovery acquisition", () => {
  const f = fixture(); releaseRun(f.run.id, undefined, f.env);
  const lock = acquirePaneLock(f.target.paneId, 1000, f.env)!;
  try { expect(() => createRun(f.target, "aggressive", [], "%700", process.pid, f.env, f.facts)).toThrow("in-flight"); }
  finally { lock.release(); }
});
test("owner death or vanished owner pane releases a hold; report-only never owns one", () => {
  const f = fixture();
  expect(active(f.run, { ...f.facts, processAlive: () => false })).toBe(false);
  expect(active(f.run, { ...f.facts, paneAlive: () => false })).toBe(false);
  releaseRun(f.run.id, undefined, f.env);
  const report = createRun(f.target, "report-only", [], "", process.pid, f.env, f.facts);
  expect(owns(report, f.env, f.facts)).toBe(false);
  expect(recoveryHold(f.target.paneId, f.env, f.facts)).toBe(false);
});
test("effect stores before+decision before keys, and after frame/state plus event afterward", () => {
  const f = fixture(); const result = f.action();
  expect(result.code).toBe(0); expect(f.effects).toHaveLength(1);
  expect(readFileSync(result.event.before!, "utf8")).toBe("frame-1");
  expect(readFileSync(result.event.after!, "utf8")).toBe("frame-2");
  expect(result.event.state?.windowCount).toBe("2");
  const rows = readFileSync(join(runDirectory(f.run.id, f.env), "events.jsonl"), "utf8").trim().split("\n");
  expect(rows).toHaveLength(1);
  expect(JSON.parse(rows[0]!).reason).toContain("ordinary harness dialog");
});
test("pre-capture failure refuses keys; post-capture failure stops with possible-effect evidence", () => {
  const pre = fixture(); pre.io.capture = () => { throw new Error("disk full"); };
  expect(pre.action().event.outcome).toBe("refused"); expect(pre.effects).toHaveLength(0);
  const post = fixture(); let n = 0;
  post.io.capture = () => { if (++n > 1) throw new Error("capture lost"); return "before"; };
  const r = post.action(); expect(r.code).toBe(124); expect(r.event.outcome).toBe("unverified");
  expect(post.effects).toHaveLength(1);
  expect(post.action().event.outcome).toBe("refused"); expect(post.effects).toHaveLength(1);
});
test("harness exit after an effect is an INCIDENT and stops further keys", () => {
  const f = fixture(); let n = 0;
  f.io.snapshot = () => ({ dead: ++n > 1 ? "1" : "0", command: n > 1 ? "zsh" : "codex", windowCount: "2", paneId: "%701", instance: "peer-instance" });
  const r = f.action(); expect(r.event.incident).toBe(true); expect(r.event.outcome).toBe("harness-exited");
  expect(readRun(f.run.id, f.env).state).toBe("stopped");
  f.action(); expect(f.effects).toHaveLength(1);
});
test("deadline during before capture and six-effect ceiling cannot authorize another key", () => {
  const expired = fixture(); expired.io.capture = () => { expired.facts.now = expired.run.deadline; return "before"; };
  expect(expired.action().event.outcome).toBe("refused"); expect(expired.effects).toHaveLength(0);
  const budget = fixture(); const r = readRun(budget.run.id, budget.env); r.effects = MAX_EFFECTS; writeRun(r, budget.env);
  expect(budget.action().event.outcome).toBe("refused"); expect(budget.effects).toHaveLength(0);
});
test("no recovery action can smuggle a tmux lifecycle command or target another pane", () => {
  const f = fixture();
  const r = recoveryEffect(f.run.id, "bad command", "test", ["send-keys", "-t", "%701", "Escape", ";", "kill-server"], f.io, f.env, () => f.facts);
  expect(r.event.outcome).toBe("refused"); expect(f.effects).toHaveLength(0);
});

test("same-harness process replacement is an incident even before the registry instance updates", () => {
  const f = fixture(); let n = 0;
  f.io.snapshot = () => ({ dead: "0", command: "codex", windowCount: "2", paneId: "%701", instance: "peer-instance", pid: ++n === 1 ? "101" : "202" });
  const result = f.action();
  expect(result.event.outcome).toBe("harness-exited");
  expect(result.event.incident).toBe(true);
});

test("recorded nudge Enter refuses a changed composer under the effect mutex", () => {
  for (const frame of ["› human draft", "› [[TAP v0.23 note other-20260907T000000Z-abcdef12]]"]) {
    const f = fixture();
    const run = readRun(f.run.id, f.env); run.nudgeExpected = "[[TAP v0.23 note sender-20260907T000000Z-abcdef12]]"; writeRun(run, f.env);
    f.io.capture = () => frame;
    const result = recoveryEffect(run.id, "nudge Enter", "aggressive: verified staged sentinel", ["send-keys", "-t", "%701", "Enter"], f.io, f.env, () => f.facts);
    expect(result.event.summary).toContain("sentinel changed"); expect(f.effects).toHaveLength(0);
  }
  const f = fixture(); const run = readRun(f.run.id, f.env);
  run.nudgeExpected = "[[TAP v0.23 note sender-20260907T000000Z-abcdef12]]"; writeRun(run, f.env);
  f.io.capture = () => "› " + run.nudgeExpected;
  expect(recoveryEffect(run.id, "nudge Enter", "aggressive: staged sentinel", ["send-keys", "-t", "%701", "Enter"], f.io, f.env, () => f.facts).code).toBe(0);
  expect(f.effects).toHaveLength(1);
});

test("OpenCode nudge repaints, requires the same parsed wire id twice, and sends one Enter", () => {
  const id = "sender-20260907T000000Z-abcdef123456";
  const expected = `[[TAP v0.23 note ${id}]]`;
  const frame = (wire: string, footer: string) => `terminal output\n  ┃\n  ┃  ${wire}\n  ┃\n  ╹${"▀".repeat(30)}\n ${footer}`;
  const f = fixture("opencode");
  const run = readRun(f.run.id, f.env); run.nudgeExpected = expected; writeRun(run, f.env);
  const captures = ["stale terminal layer", frame(expected, "spinner changed"), "after Enter"];
  f.io.capture = () => captures.shift() ?? "after Enter";
  f.io.repaint = () => ({ ok: true, attempted: true, before: "stale terminal layer", after: frame(expected, "first repaint"), reason: "observed" });
  const result = recoveryEffect(run.id, "nudge Enter", "aggressive: staged sentinel", ["send-keys", "-t", "%701", "Enter"], f.io, f.env, () => f.facts);
  expect(result.code).toBe(0);
  expect(f.effects).toEqual([["send-keys", "-t", "%701", "Enter"]]);
  expect(readdirSync(runDirectory(run.id, f.env)).filter(name => name.includes("repaint-")).length).toBe(3);
});

test("OpenCode nudge reuses a classifier repaint without resizing twice", () => {
  const expected = "[[TAP v0.23 note sender-20260907T000000Z-abcdef123456]]";
  const frame = `  ┃\n  ┃  ${expected}\n  ┃\n  ╹${"▀".repeat(30)}\n footer`;
  const f = fixture("opencode");
  const run = readRun(f.run.id, f.env); run.nudgeExpected = expected; writeRun(run, f.env);
  const captures = [frame, frame, "after Enter"];
  f.io.capture = () => captures.shift() ?? "after Enter";
  f.io.repaint = () => { throw new Error("second repaint attempted"); };
  const result = recoveryEffect(run.id, "nudge Enter", "aggressive: staged sentinel", ["send-keys", "-t", "%701", "Enter"], f.io,
    { ...f.env, TAP_NUDGE_REPAINTED: "1" }, () => f.facts);
  expect(result.code).toBe(0);
  expect(f.effects).toEqual([["send-keys", "-t", "%701", "Enter"]]);
  expect(readdirSync(runDirectory(run.id, f.env)).filter(name => name.includes("repaint-")).length).toBe(2);
});

test("OpenCode nudge sends no Enter when the parsed wire id changes after repaint", () => {
  const expected = "[[TAP v0.23 note sender-20260907T000000Z-abcdef123456]]";
  const changed = "[[TAP v0.23 note other-20260907T000000Z-abcdef123456]]";
  const frame = (wire: string) => `  ┃\n  ┃  ${wire}\n  ┃\n  ╹${"▀".repeat(30)}\n footer`;
  const f = fixture("opencode");
  const run = readRun(f.run.id, f.env); run.nudgeExpected = expected; writeRun(run, f.env);
  const captures = ["stale", frame(changed), "after refusal"];
  f.io.capture = () => captures.shift() ?? "after refusal";
  f.io.repaint = () => ({ ok: true, attempted: true, before: "stale", after: frame(expected), reason: "observed" });
  const result = recoveryEffect(run.id, "nudge Enter", "aggressive: staged sentinel", ["send-keys", "-t", "%701", "Enter"], f.io, f.env, () => f.facts);
  expect(result.code).toBe(1);
  expect(result.event.effect).toBe("none");
  expect(result.event.summary).toContain("not stable across two post-repaint samples");
  expect(f.effects).toEqual([]);
});

test("OpenCode nudge reauthorizes after its second repaint sample before Enter", () => {
  const expected = "[[TAP v0.23 note sender-20260907T000000Z-abcdef123456]]";
  const frame = `  ┃\n  ┃  ${expected}\n  ┃\n  ╹${"▀".repeat(30)}\n footer`;
  const f = fixture("opencode");
  const run = readRun(f.run.id, f.env); run.nudgeExpected = expected; writeRun(run, f.env);
  let checks = 0;
  f.io.authorize = () => ++checks >= 4 ? "captured target binding changed" : null;
  const captures = ["stale", frame, "after refusal"];
  f.io.capture = () => captures.shift() ?? "after refusal";
  f.io.repaint = () => ({ ok: true, attempted: true, before: "stale", after: frame, reason: "observed" });
  const result = recoveryEffect(run.id, "nudge Enter", "aggressive: staged sentinel", ["send-keys", "-t", "%701", "Enter"], f.io, f.env, () => f.facts);
  expect(result.code).toBe(1);
  expect(result.event.effect).toBe("none");
  expect(result.event.summary).toContain("binding changed");
  expect(f.effects).toEqual([]);
});

test("shipped detective worker preset resolves through the actual launcher catalog", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-recovery-preset-")); roots.push(root);
  mkdirSync(join(root, "tap"));
  copyFileSync(resolve(import.meta.dir, "../../../skills/tap/config/config.v3.toml"), join(root, "tap/config.toml"));
  const selected = resolveCatalog("luna-xhigh", undefined, { ...process.env, XDG_CONFIG_HOME: root }, () => {});
  expect(selected.preset?.harness).toBe("codex");
  expect(selected.preset?.params).toMatchObject({ model: "gpt-6-luna", config: ["model_reasoning_effort=xhigh"] });
});

test("a positively gone harness is an incident even when initial capture fails", () => {
  const f = fixture();
  f.io.capture = () => { throw new Error("pane missing"); };
  f.io.snapshot = () => ({ dead: "", command: "", windowCount: "", paneId: "", instance: "peer-instance", present: false });
  expect(() => recordObservation(f.run, f.io, f.env, "initial")).toThrow("pane missing");
  const run = readRun(f.run.id, f.env);
  expect(run.state).toBe("stopped"); expect(run.summary).toContain("INCIDENT");
  const event = JSON.parse(readFileSync(join(runDirectory(run.id, f.env), "events.jsonl"), "utf8").trim());
  expect(event.incident).toBe(true); expect(event.outcome).toBe("harness-exited");
  expect(f.effects).toHaveLength(0);
});

test("a bounded numeric survey choice is recorded on the authorized target", () => {
  const f = fixture();
  f.io.capture = () => "Survey: press 0 to dismiss";
  const result = recoveryEffect(f.run.id, "survey choice 0", "aggressive: observed survey requests 0", ["send-keys", "-t", "%701", "0"], f.io, f.env, () => f.facts);
  expect(result.code).toBe(0); expect(f.effects).toEqual([["send-keys", "-t", "%701", "0"]]);
  expect(readFileSync(result.event.before!, "utf8")).toContain("press 0");
});

test("a failed notification stays unconfirmed and repeated finalization cannot report it delivered", () => {
  const f = fixture();
  // This isolated bus has no registered sender/notifier; the real escalation command refuses.
  const code = escalateRecovery(f.run.id, "fixture notification failure", f.env);
  expect(code).not.toBe(0);
  expect(readRun(f.run.id, f.env).escalationStatus).toBe("unconfirmed");
  expect(escalateRecovery(f.run.id, "second finalization", f.env)).toBe(code);
  expect(readRun(f.run.id, f.env).escalationStatus).toBe("unconfirmed");
});

test("target disappearance escalates through the surviving initiating actor", () => {
  const f = fixture(), home = join(f.root, "bus"); mkdirSync(home);
  writeFileSync(f.target.registry, JSON.stringify({ schema: "0.20", team: { name: "test", worktree_root: f.root }, seats: {
    owner: { status: "active", delivery: "poll", instance: "owner|fixture" },
  } }));
  writeFileSync(join(f.root, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { test: { root: f.root, registry_location: f.target.registry } } }));
  const notifier = join(f.root, "notify"), output = join(f.root, "notification");
  writeFileSync(notifier, '#!/bin/sh\nprintf "%s\\n" "$@" > "$NOTICE_OUTPUT"\n', { mode: 0o700 });
  const run = readRun(f.run.id, f.env); run.caller = { team: "test", actor: "owner", registry: f.target.registry, root: f.root, home }; writeRun(run, f.env);
  const code = escalateRecovery(run.id, "INCIDENT: target row disappeared", { ...f.env, TAP_HOME: home, TAP_NOTIFY_USER_BIN: notifier, NOTICE_OUTPUT: output });
  expect(code).toBe(0); expect(readRun(run.id, f.env).escalationStatus).toBe("delivered");
  const text = readFileSync(output, "utf8"); expect(text).toContain("test/owner"); expect(text).toContain("test/peer");
});

test("a process killed at the effect boundary leaves a possible intent, never a no-effect claim", () => {
  const f = fixture(), child = join(f.root, "crash-at-effect.ts"), marker = join(f.root, "effect-reached");
  writeFileSync(child, `import {readFileSync, writeFileSync} from "node:fs";
import {recoveryEffect} from ${JSON.stringify(resolve(import.meta.dir, "../src/recovery/effect.ts"))};
recoveryEffect(process.argv[2], "crash control", "synthetic effect boundary", ["send-keys", "-t", "%701", "Enter"], {
  // An idle composer: Enter needs a frame TAP can classify (tap-rlebf.1).
  capture: () => readFileSync(${JSON.stringify(resolve(import.meta.dir, "fixtures/agent-state/codex/idle.ansi"))}, "utf8"),
  snapshot: () => ({dead:"0",command:"codex",windowCount:"1",paneId:"%701",instance:"peer-instance"}),
  authorize: () => null, settle: () => {},
  effect: () => { writeFileSync(process.argv[3], "effect boundary reached"); process.kill(process.pid,"SIGKILL"); throw new Error("unreachable"); }
}, process.env, () => ({now:1000,processAlive:()=>true,paneAlive:()=>true}));
`);
  const result = spawnSync(process.execPath, [child, f.run.id, marker], { env: f.env, encoding: "utf8", timeout: 10000 });
  expect(result.signal).toBe("SIGKILL"); expect(readFileSync(marker, "utf8")).toBe("effect boundary reached");
  const dir = runDirectory(f.run.id, f.env), file = readdirSync(dir).find(name => name.endsWith(".intent.json"))!;
  const intent = JSON.parse(readFileSync(join(dir, file), "utf8"));
  expect(intent.outcome).toBe("unverified"); expect(intent.effect).toBe("possible");
  expect(existsSync(join(dir, "events.jsonl"))).toBe(false);
});

test("recovery's outer ten-second cap cleans up a TERM-resistant notifier and keeps delivery unconfirmed", () => {
  const f = fixture(), home = join(f.root, "bus"); mkdirSync(home);
  writeFileSync(f.target.registry, JSON.stringify({ schema: "0.20", team: { name: "test", worktree_root: f.root }, seats: { owner: { delivery: "poll" } } }));
  writeFileSync(join(f.root, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { test: { root: f.root, registry_location: f.target.registry } } }));
  const notifier = join(f.root, "notifier"), pidFile = join(f.root, "notifier-pid");
  writeFileSync(notifier, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';process.on('SIGTERM',()=>{});writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);\n`, { mode: 0o700 });
  const run = readRun(f.run.id, f.env); run.caller = { team: "test", actor: "owner", registry: f.target.registry, root: f.root, home }; writeRun(run, f.env);
  const start = Date.now();
  const code = escalateRecovery(run.id, "fixture deadline", { ...f.env, TAP_HOME: home, TAP_NOTIFY_USER_BIN: notifier, TAP_NOTIFY_TIMEOUT_SECONDS: "20" });
  expect(code).not.toBe(0); expect(Date.now() - start).toBeLessThan(14000);
  expect(readRun(run.id, f.env).escalationStatus).toBe("unconfirmed");
  expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
}, 20000);

// tap-tg9vz: Enter submits the WHOLE composer, so the nudge gate must hold "exactly one owned wire
// and nothing else"; containment also admitted the wire beside a human line or a second wire.
// Frames are the REAL painted Codex capture (braille starfield rows + status footer) with the wire
// typed into the prompt row: an unpainted hand-made frame would let a gate that never matches a
// live pane pass. Self-contained: own frames, own wire, asserts only on Enters sent.
test("recorded nudge Enter sends for a painted staged wire and refuses it beside human text or another wire", () => {
  const expected = "[[TAP v0.23 note sender-20260907T000000Z-abcdef123456]]";
  const other = "[[TAP v0.23 note other-20260907T000000Z-abcdef123456]]";
  const empty = readFileSync(join(import.meta.dir, "fixtures/codex-starfield/empty.ansi"), "utf8");
  const placeholder = "\x1b[2m\x1b[39mAsk Codex to do anything\x1b[0m";
  if (!empty.includes(placeholder)) throw new Error("codex-starfield fixture changed shape");
  const painted = (composer: string) => empty.replace(placeholder, `\x1b[39m${composer}\x1b[0m`);
  const enters = (frame: string): number => {
    const f = fixture("codex");
    const run = readRun(f.run.id, f.env); run.nudgeExpected = expected; writeRun(run, f.env);
    f.io.capture = () => frame;
    recoveryEffect(run.id, "nudge Enter", "aggressive: staged sentinel", ["send-keys", "-t", "%701", "Enter"], f.io, f.env, () => f.facts);
    return f.effects.length;
  };
  expect(enters(painted(expected)), "control: the painted wire alone is admitted").toBe(1);
  expect({
    wireThenHuman: enters(painted(`${expected} please also do the dishes`)),
    wireThenHumanRow: enters(painted(`${expected}\n  please also do the dishes`)),
    humanThenWire: enters(painted(`remember to ${expected}`)),
    twoWires: enters(painted(`${expected} ${other}`)),
  }).toEqual({ wireThenHuman: 0, wireThenHumanRow: 0, humanThenWire: 0, twoWires: 0 });
});

// tap-tg9vz: the Claude arm of the same gate. A 38-column composer shows only the wire's scrolled
// tail (tap-1ncs6), so the exact-composer comparison cannot match the full expected wire; the gate
// admits the tail as a strict suffix of it. Frames are the real-shaped narrow-pane specimen with
// the full JSON wire as `expected`: the tail alone sends one Enter; visible human text on the
// tail's row or below it, or a second wire below it, sends none.
test("recorded nudge Enter sends for a Claude wire's scrolled tail and refuses it beside human text or another wire", () => {
  const dir = join(import.meta.dir, "fixtures/claude-narrow-pane");
  const frame = readFileSync(join(dir, "specimen-a-alice-38x21.ansi"), "utf8");
  const expected = JSON.parse(readFileSync(join(dir, "specimen-a-alice-38x21.json"), "utf8")).expected as string;
  const lines = frame.split("\n");
  const prompt = lines.findIndex(line => line.startsWith("❯"));
  const border = lines.findIndex((line, i) => i > prompt && line.startsWith("──"));
  const tailRow = (lines[prompt] ?? "").slice(2).trim();
  if (prompt < 0 || border < 0 || !expected.includes(tailRow)) throw new Error("narrow-pane fixture changed shape");
  const withRows = (rows: string[], first = lines[prompt] ?? "") =>
    [...lines.slice(0, prompt), first, ...lines.slice(prompt + 1, border), ...rows.map(row => `  ${row}`), ...lines.slice(border)].join("\n");
  const enters = (shown: string): number => {
    const f = fixture("claude");
    const run = readRun(f.run.id, f.env); run.nudgeExpected = expected; writeRun(run, f.env);
    f.io.capture = () => shown;
    recoveryEffect(run.id, "nudge Enter", "aggressive: staged sentinel", ["send-keys", "-t", "%701", "Enter"], f.io, f.env, () => f.facts);
    return f.effects.length;
  };
  const other = "[[TAP v0.23 note other-20260907T000000Z-abcdef123456]]";
  // A wide composer shows the FULL wire, where containment (the first gate) admits the wire beside
  // human text or a second wire: these frames are what the exact-composer gate must refuse.
  const wide = (rows: string[]) => `✻ done\n\n${"─".repeat(150)}\n❯ ${rows[0]}\n${rows.slice(1).map(row => `  ${row}`).join("\n")}\n${"─".repeat(170)}\n  Sonnet 5 high | 18%\n`;
  expect(enters(frame), "control: the scrolled tail alone is admitted").toBe(1);
  expect(enters(wide([expected])), "control: the full wire alone is admitted").toBe(1);
  expect({
    humanBelow: enters(withRows(["please also do the dishes"])),
    humanBeforeTail: enters(withRows([], `❯ remember to ${tailRow}`)),
    secondWire: enters(withRows([other])),
    wideWireThenHumanRow: enters(wide([expected, "please also do the dishes"])),
    wideWireThenHuman: enters(wide([`${expected} please also do the dishes`])),
    wideHumanThenWire: enters(wide([`remember to ${expected}`])),
    wideTwoWires: enters(wide([expected, other])),
  }).toEqual({ humanBelow: 0, humanBeforeTail: 0, secondWire: 0, wideWireThenHumanRow: 0, wideWireThenHuman: 0, wideHumanThenWire: 0, wideTwoWires: 0 });
});

// tap-tg9vz: the exact-composer gate covers only the harnesses whose bounded read is proven (Codex,
// Claude). Hermes's full-width bottom border and Cursor's borderless composer defeat the generic
// readFrame, so an exact read there refused a composer holding ONLY the wire; those harnesses keep
// containment. Frames are the real captures with the typed text or placeholder replaced by the wire.
test("recorded nudge Enter still sends for a wire alone in a Hermes or borderless Cursor composer", () => {
  const expected = "[[TAP v0.23 note sender-20260907T000000Z-abcdef123456]]";
  const fixtures = join(import.meta.dir, "../../../skills/tap/scripts/smoke/fixtures");
  const hermes = readFileSync(join(fixtures, "hermes-prompt/typed.ansi"), "utf8");
  const cursor = readFileSync(join(fixtures, "peek-harness-adapters/cursor-midfill-idle.ansi"), "utf8");
  const typed = "TAP-HERMES-TYPED-CONTROL-7R3FN37";
  const placeholder = "\x1b[2m→ \x1b[0;7m\x1b[48;2;32;32;32mA\x1b[0;2m\x1b[48;2;32;32;32mdd a follow-up\x1b[0m";
  if (!hermes.includes(typed) || !cursor.includes(placeholder)) throw new Error("harness fixtures changed shape");
  const enters = (harness: string, shown: string): number => {
    const f = fixture(harness);
    const run = readRun(f.run.id, f.env); run.nudgeExpected = expected; writeRun(run, f.env);
    f.io.capture = () => shown;
    recoveryEffect(run.id, "nudge Enter", "aggressive: staged sentinel", ["send-keys", "-t", "%701", "Enter"], f.io, f.env, () => f.facts);
    return f.effects.length;
  };
  expect({
    hermes: enters("hermes", hermes.replace(typed, expected)),
    cursor: enters("cursor", cursor.replace(placeholder, `\x1b[2m→ \x1b[0m${expected}`)),
  }).toEqual({ hermes: 1, cursor: 1 });
});

// tap-tg9vz: AGY's prompt-pair composer read is bounded by its own rules, so it gets the exact gate.
// The frame is the real draft capture with its composer rows replaced: the wire alone sends one
// Enter (the gate must not break AGY nudge), and the wire beside a human row sends none.
test("recorded nudge Enter sends for a wire alone in an AGY composer and refuses it beside a human row", () => {
  const expected = "[[TAP v0.23 note sender-20260907T000000Z-abcdef123456]]";
  const lines = readFileSync(join(import.meta.dir, "fixtures/agent-state/agy/draft-real.txt"), "utf8").split("\n");
  const rules = lines.flatMap((line, i) => /^─{10,}$/.test(line.trim()) ? [i] : []);
  const top = rules.at(-2), bottom = rules.at(-1);
  if (top === undefined || bottom === undefined || !/^>\s*\[\[TAP/.test(lines[top + 1] ?? "")) throw new Error("agy draft fixture changed shape");
  const composer = (rows: string[]) => [...lines.slice(0, top + 1), ...rows, ...lines.slice(bottom)].join("\n");
  const enters = (shown: string): number => {
    const f = fixture("agy");
    const run = readRun(f.run.id, f.env); run.nudgeExpected = expected; writeRun(run, f.env);
    f.io.capture = () => shown;
    recoveryEffect(run.id, "nudge Enter", "aggressive: staged sentinel", ["send-keys", "-t", "%701", "Enter"], f.io, f.env, () => f.facts);
    return f.effects.length;
  };
  expect(enters(composer([`> ${expected}`])), "control: the wire alone is admitted").toBe(1);
  expect({
    humanBelow: enters(composer([`> ${expected}`, "  please also do the dishes"])),
    humanBefore: enters(composer([`> remember to ${expected}`])),
    twoWires: enters(composer([`> ${expected}`, "  [[TAP v0.23 note other-20260907T000000Z-abcdef123456]]"])),
  }).toEqual({ humanBelow: 0, humanBefore: 0, twoWires: 0 });
});
