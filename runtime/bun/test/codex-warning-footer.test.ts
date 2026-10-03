// tap-2ajq8: three idle Codex seats held one complete staged TAP sentinel for
// 25-50 minutes. Two faults stacked. At send time the seat was mid-turn and
// Codex painted the paste progressively; the courier judged the partial frame,
// read `changed`, and stopped before `injected-text-confirmed`, so no
// staged-idle hold could follow. Once the turn ended, Codex painted a
// `⚠ 1 warning · f2 to view` row under its status footer; the composer reader
// counted it as input, so `tap nudge` refused "staged sentinel changed" and
// the idle arm's whole-composer equality could never pass. Fixtures are the
// real captures with same-length neutral text (see the fixture README).
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifySubmitFrame, composerHoldsExactly, readComposerFrame, readFrame, sentinelSubmitDecision, visibleSentinelId } from "../src/submit-frame";
import { classifyPane } from "../src/pane-state";
import { detectAgentState } from "../src/agent-state";
import { submitVerifyLocked, type PaneEffects, type SubmitAuthority } from "../src/courier";
import { recordPhase } from "../src/submit-phase";
import { DEFAULT_AGENT_FAMILIES } from "../src/observe";
import { createRun, readRun, runDirectory, writeRun, type Liveness, type RecoveryTarget } from "../src/recovery/state";
import { recoveryEffect, type EffectIO } from "../src/recovery/effect";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const scratchRoot = (prefix: string) => { const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root); return root; };

const load = (name: string) => readFileSync(new URL(`./fixtures/codex-warning-footer/${name}.ansi`, import.meta.url), "utf8");
const strip = (frame: string) => frame.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const WARNING = "⚠ 1 warning · f2 to view";

const stagedId = "neutral-sender-seat01-20261001T095226Z-32501a8f791b";
const staged = `[[TAP v0.23 note ${stagedId} preview="Neutra: lfix ture textforcodexwa. Rnin gfo oter neutr al fix turet extforcod exwarnin gfo ote rneu tra lfixtur etex"]]`;
const trailing = `[[TAP v0.23 note peer-nudge-20261001T093210Z-a9eab7a33038 preview="Neutra lf ixt urete-xtf. Orcodex war, ning foote rneu t70r220a49lf ixtur etextfo rc ode xwarning foote rneutr: alfixt"]]`;
const wrapped = `[[TAP v0.23 note neutral-sender-seat01-20261001T101607Z-111d7c2cd5a9 preview="Neutra: lfixturet ext for codex-warn ingfootern. Eutralfixtu r etex't for @ codexwa rn ingfoot ern eutr alf ix-neutral"]]`;

// A courier digest with two previews wraps over three rows: once at a word
// break (the wire has a space there) and once mid-path (it has none).
const digest = `[[TAP v0.23 note courier-20261001T102049Z-558e01215ea8 digest preview(peer-nudge-20261001T093447Z-4244778b2c05)="Neutral 2 fixtu re 1te6xt4fo: rco de-xwarni ngfootern eu tral, fix turet neutralfixtu retextf-orco dexwarningf ooterne." preview(peer-nudge-20261001T100245Z-227cfac254cc)="neu-t85ra lfixtu (rete-xtfor → cod-exwar). Nin gfootern eu /Tralf/ixture/Tex/Tforcodexwa/rning/neu/TralfIxtuRete, xt"]]`;

const idleCases = [["idle-staged", staged], ["idle-trailing-space", trailing], ["idle-wrapped", wrapped], ["idle-digest-3row", digest]] as const;

// ── The reader: the warning row is chrome only beneath a recognized status ──

for (const [name, wire] of idleCases) {
  test(`${name}: the warning row under the status footer is chrome, so every nudge and idle gate passes`, () => {
    const frame = load(name);
    expect(strip(frame)).toContain(WARNING);
    const read = readComposerFrame(frame, "codex")!;
    expect(read).not.toContain("⚠");
    expect(read).not.toContain("GPT-6.1-Sol");
    expect(composerHoldsExactly(frame, "codex", wire)).toBe(true);
    expect(sentinelSubmitDecision(frame, "codex", wire, true).action).toBe("submit");
    expect(visibleSentinelId(frame, "codex", true)).toBe(wire.match(/note (\S+)/)![1]!);
    expect(readFrame(frame, "codex", wire).mode).toBe("idle");
    expect(classifySubmitFrame(frame, "codex", wire).state).toBe("staged");
  });
}

test("the single-row idle specimen reads staged through the strict reader as well", () => {
  for (const [name, wire] of idleCases.slice(0, 2)) expect(readFrame(load(name), "codex", wire).state, name).toBe("staged");
});

test("the warning row stays input unless a recognized status row sits directly above it", () => {
  const status = "gpt-6-astra high · Context 50% left · project · weekly 7% left";
  const frame = (...rows: string[]) => `› ${rows.join("\n")}\n`;
  // No status row: the row is not footer chrome, so it is composer content.
  expect(readComposerFrame(frame(staged, "", WARNING), "codex")).toContain(WARNING);
  expect(readComposerFrame(frame(staged, WARNING), "codex")).toContain(WARNING);
  // Status present: the row is chrome, singular or plural.
  expect(readComposerFrame(frame(staged, "", `  ${status}`, `   ${WARNING}`), "codex")).toBe(staged);
  expect(readComposerFrame(frame(staged, "", `  ${status}`, "  ⚠ 2 warnings · f2 to view"), "codex")).toBe(staged);
  // A suffix byte, or text after the warning row, is not the known row.
  expect(readComposerFrame(frame(staged, "", `  ${status}`, `  ${WARNING} x`), "codex")).toContain(`${WARNING} x`);
  const after = readComposerFrame(frame(staged, "", `  ${status}`, `  ${WARNING}`, "human tail"), "codex")!;
  expect(after).toContain("human tail");
  // A human draft above the footer is still a draft, never emptied.
  expect(readComposerFrame(frame("human draft", "", `  ${status}`, `  ${WARNING}`), "codex")).toBe("human draft");
});

test("the specimen still refuses a changed composer: other id, other preview, extra text, two wires, a draft", () => {
  const frame = load("idle-staged");
  const otherId = staged.replace("32501a8f791b", "000000000000");
  const otherPreview = staged.replace("Neutra:", "Change:");
  expect(composerHoldsExactly(frame, "codex", otherId)).toBe(false);
  expect(composerHoldsExactly(frame, "codex", otherPreview)).toBe(false);
  const extra = frame.replace(`${staged}`, `${staged} human`);
  expect(composerHoldsExactly(extra, "codex", staged)).toBe(false);
  const two = frame.replace(`${staged}`, `${staged}\n  ${otherId}`);
  expect(composerHoldsExactly(two, "codex", staged)).toBe(false);
  const draft = frame.replace(`${staged}`, "please keep this draft");
  expect(composerHoldsExactly(draft, "codex", staged)).toBe(false);
  expect(classifyPane(draft, "codex", false)).toEqual({ kind: "draft", text: "please keep this draft" });
});

// ── tap nudge: the recorded recovery Enter on the saved before frame ────────

function nudgeFixture() {
  const root = scratchRoot("tap-2ajq8-nudge-");
  const env = { ...process.env, TAP_INDEX_HOME: root, TAP_LOCK_DIR: join(root, "locks") };
  const target: RecoveryTarget = { team: "test", handle: "peer", registry: join(root, "registry.json"),
    pane: "test/peer:0.0", paneId: "%701", session: "test/peer", instance: "peer-instance", harness: "codex", processPid: "101" };
  const facts: Liveness = { now: 1000, processAlive: () => true, paneAlive: () => true };
  const run = createRun(target, "aggressive", [{ home: join(root, "bus"), id: "payload-1" }], "%700", process.pid, env, facts);
  const effects: string[][] = [];
  const io: EffectIO = {
    capture: () => "",
    snapshot: () => ({ dead: "0", command: "codex", windowCount: "2", paneId: "%701", instance: "peer-instance" }),
    authorize: () => null, settle: () => {},
    effect(args) { effects.push(args); return { code: 0, stdout: "", stderr: "" }; },
  };
  return { env, facts, run, io, effects };
}

function nudge(frame: string, expected: string) {
  const f = nudgeFixture();
  const run = readRun(f.run.id, f.env); run.nudgeExpected = expected; writeRun(run, f.env);
  f.io.capture = () => frame;
  const result = recoveryEffect(run.id, "nudge Enter", "aggressive: staged sentinel", ["send-keys", "-t", "%701", "Enter"], f.io, f.env, () => f.facts);
  return { result, effects: f.effects };
}

for (const [name, wire] of idleCases) {
  test(`tap nudge sends its one Enter on the ${name} before-frame`, () => {
    const run = nudge(load(name), wire);
    expect(run.result.event.summary).not.toContain("changed");
    expect(run.effects).toEqual([["send-keys", "-t", "%701", "Enter"]]);
  });
}

test("tap nudge still refuses the specimen with a different expected wire or extra composer text", () => {
  const frame = load("idle-staged");
  for (const [frameText, expected] of [
    [frame, staged.replace("32501a8f791b", "000000000000")],
    [frame, staged.replace("Neutra:", "Change:")],
    [frame.replace(staged, `${staged} human`), staged],
  ] as const) {
    const run = nudge(frameText, expected);
    expect(run.result.event.summary).toContain("expected staged sentinel changed");
    expect(run.effects).toEqual([]);
  }
});

// ── The courier's idle staged submit on the real frame ──────────────────────

function busHome(): string {
  const home = join(scratchRoot("tap-2ajq8-idle-"), ".tap", "bus");
  for (const path of [home, join(home, "spool"), join(home, "payloads"), join(home, "receipts")]) mkdirSync(path, { recursive: true });
  return home;
}

function stageHold(home: string, id: string): void {
  writeFileSync(join(home, "spool", `${id}.meta.json`), JSON.stringify({ id, reason: "staged-idle", deadline_epoch: 4102444800 }));
  writeFileSync(join(home, "payloads", `${id}.md`), `---\nid: ${id}\nfrom: neutral-sender-seat01\nto: peer\nkind: note\n---\nneutral body\n`);
  recordPhase(home, { id, attempt: "attempt-1", phase: "injected-text-confirmed", recipient: "peer", enter_count: 0 });
  recordPhase(home, { id, attempt: "attempt-1", phase: "verify-result", recipient: "peer", enter_count: 0, result: "unverified" });
}

/** After Enter Codex repaints its dim placeholder where the wire (or its wrapped rows) stood. */
const PLACEHOLDER = "\x1b[2mAsk Codex to do anything\x1b[0m";
const emptied = (frame: string) => {
  const start = frame.lastIndexOf("[[TAP");
  const close = frame.indexOf("]]", start);
  // A partial paint has no closing brackets yet: its row ends the wire.
  const end = close >= 0 ? close + 2 : frame.indexOf("\n", start);
  if (start < 0 || end < 0) throw new Error("fixture has no staged wire row");
  return frame.slice(0, start) + PLACEHOLDER + frame.slice(end);
};

function idleArm(home: string, frame: string, wire: string, id: string) {
  // The band is what production's paneState derives from this capture, never
  // a clean stub: the warning row must reach parseStuckSentinel if it leaks.
  const classified = classifyPane(frame, "codex", false);
  let capture = frame, enters = 0, injections = 0;
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "codex" } as any),
    harnessEvidence: () => "alive", copyMode: () => ({ status: "normal" }),
    paneState: () => classified.kind === "draft" ? { state: "busy", text: classified.text } : { state: "ready" },
    injectText: () => { injections++; return true; },
    inputHasId: () => true,
    pressEnter: () => { enters++; capture = emptied(frame); return true; },
    settle: () => {},
    captureEscaped: () => ({ ok: true, frame: capture }),
    submitFrame: (_t: string, command: string, expected: string, alive?: boolean) => classifySubmitFrame(capture, command, expected, "200", alive),
    paneTitle: () => ({ ok: true, title: "codex" }),
  } as PaneEffects;
  const registry = join(home, "registry.json");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture" }, seats: {
    peer: { status: "active", delivery: "pane", pane: "tap/peer:0.0", pane_id: "%1", session: "fixture",
      server_epoch: "srv:1:1", boot_id: "", harness: "codex" } } }));
  const bound = { paneId: "%1", handle: "peer", instance: "", serverEpoch: "srv:1:1", bootId: "", harness: "codex" };
  const authority: SubmitAuthority = {
    scriptsDir: join(import.meta.dir, "../../../skills/tap/scripts"), agentFamilies: new Set(DEFAULT_AGENT_FAMILIES), busHome: home,
    recipient: "peer", registryPath: registry, attemptIds: [id],
    preserveDraft: false, draftGraceSatisfied: true, forceNoPrompt: false,
    idleStaged: true, singleEnter: true,
    eventContext: { actor: "courier", log: join(home, "registry-events.log"), team: "fixture", verb: "tap" },
  };
  const result = submitVerifyLocked("tap/peer:0.0", id, wire, bound, fx, authority);
  return { result, enters, injections };
}

test("the specimen's agent state is positively idle, so only the composer read held the arm", () => {
  expect(detectAgentState("codex", strip(load("idle-staged")), "codex", true).agentState).toBe("idle");
});

for (const [name, wire] of idleCases) {
  test(`the idle arm presses one Enter on the ${name} frame, license minted first`, () => {
    const id = wire.match(/note (\S+)/)![1]!;
    const home = busHome();
    stageHold(home, id);
    const run = idleArm(home, load(name), wire, id);
    expect(run.result.status).toBe("injected");
    expect(run.enters).toBe(1);
    expect(run.injections).toBe(0);
    expect(existsSync(join(home, "receipts", `${id}.idle-submit`))).toBe(true);
    // One Enter per staged observation: a second pass on the same entry never keys.
    const again = idleArm(home, load(name), wire, id);
    expect(again.enters).toBe(0);
    expect(again.injections).toBe(0);
  });
}

test("the idle arm refuses the specimen with a human tail under the warning row", () => {
  const home = busHome();
  stageHold(home, stagedId);
  const run = idleArm(home, load("idle-staged") + "  human tail\n", staged, stagedId);
  expect(run.result.status).toBe("unverified");
  expect(run.enters).toBe(0);
  expect(run.injections).toBe(0);
  expect(existsSync(join(home, "receipts", `${stagedId}.idle-submit`))).toBe(false);
});

// ── The send: Codex paints a mid-turn paste progressively ───────────────────

const partials = [["midturn-partial", staged, "Rnin gfo oter neutr al fix turet extforcod"],
  ["midturn-partial-midword", wrapped, "Eutralf"]] as const;

function partialRow(frame: string): string {
  return frame.split("\n").find(row => strip(row).startsWith("› [[TAP"))!;
}

/** The partial capture, then the same mid-turn frame with the whole wire painted on one row. */
function midturnWhole(frame: string, wire: string): string {
  const row = partialRow(frame);
  return frame.replace(row, row.slice(0, row.indexOf("[[TAP")) + wire);
}

function midturnSend(name: string, wire: string, partialSamples: number) {
  const partial = load(name);
  const whole = midturnWhole(partial, wire);
  const id = wire.match(/note (\S+)/)![1]!;
  const home = busHome();
  let pastes = 0, samples = 0, submitted = false;
  const effects: string[] = [];
  const frame = () => submitted ? emptied(whole) : pastes === 0 ? emptied(partial) : samples > partialSamples ? whole : partial;
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "codex" } as any),
    harnessEvidence: () => "alive", copyMode: () => ({ status: "normal" }),
    paneState: () => pastes > 0 && !submitted ? { state: "busy", text: readComposerFrame(frame(), "codex") ?? "" } : { state: "ready" },
    injectText: () => { pastes++; effects.push("paste"); return true; },
    inputHasId: () => pastes > 0 && !submitted,
    pressEnter: () => { effects.push(frame() === whole ? "Enter" : submitted ? "completion-Enter" : "Enter-on-partial"); submitted = true; return true; },
    settle: () => {},
    submitFrame: (_t: string, command: string, expected: string, alive?: boolean) => {
      if (pastes > 0 && !submitted) samples++;
      return classifySubmitFrame(frame(), command, expected, "200", alive);
    },
  } as PaneEffects;
  const bound = { paneId: "%1", harness: "codex", serverEpoch: "srv:1:1" };
  const authority = { busHome: home, attemptIds: [id] } as unknown as SubmitAuthority;
  const result = submitVerifyLocked("%1", id, wire, bound, fx, authority);
  const phasePath = join(home, "receipts", `${id}.submit-phases.jsonl`);
  const phases = existsSync(phasePath) ? readFileSync(phasePath, "utf8").trim().split("\n").map(line => JSON.parse(line).phase) : [];
  return { result, effects, phases, home, id };
}

for (const [name, wire, cut] of partials) {
  test(`${name}: the saved send-time frame shows a partial wire that never reads staged`, () => {
    const frame = load(name);
    expect(strip(partialRow(frame)).trimEnd().endsWith(cut)).toBe(true);
    expect(classifySubmitFrame(frame, "codex", wire).state).toBe("changed");
    expect(readFrame(frame, "codex", wire).mode).toBe("mid-turn");
  });

  test(`${name}: the courier waits through the progressive paint, confirms the whole wire, then presses Enter`, () => {
    // Nine partial frames is ~0.9 s of paint: past the old ten-sample id-only landing.
    const run = midturnSend(name, wire, 9);
    expect(run.result.status).toBe("injected");
    expect(run.effects[0]).toBe("paste");
    expect(run.effects.filter(effect => effect === "paste")).toHaveLength(1);
    expect(run.effects).not.toContain("Enter-on-partial");
    expect(run.effects[1]).toBe("Enter");
    expect(run.phases.indexOf("injected-text-confirmed")).toBeGreaterThanOrEqual(0);
    expect(run.phases.indexOf("injected-text-confirmed")).toBeLessThan(run.phases.indexOf("Enter-intent"));
    // An ordinary send never spends the idle arm's one-shot license.
    expect(readdirSync(join(run.home, "receipts")).some(file => file.endsWith(".idle-submit"))).toBe(false);
  });

  test(`${name}: a wire that never finishes painting ends unverified with one paste and no Enter`, () => {
    const run = midturnSend(name, wire, Number.MAX_SAFE_INTEGER);
    expect(run.result.status).toBe("unverified");
    expect("detail" in run.result ? run.result.detail : "").toContain("Codex composer on '%1' shows our sentinel id but never the full wire");
    expect(run.effects).toEqual(["paste"]);
  });
}
