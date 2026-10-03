import { pendingReprobe, phaseRows, recordPhase } from "../src/submit-phase";
import { acquirePathLock } from "../src/panelock";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { agySurveyOverlay, classifySubmitFrame } from "../src/submit-frame";
import { classifyPane } from "../src/pane-state";
import { recoverAgySurvey, type SurveyEffects } from "../src/agy-survey";
import { submitVerifyLocked, type PaneEffects } from "../src/courier";
import { removeScratchTree } from "./support/scratch";
const survey = readFileSync(join(import.meta.dir, "fixtures/agy-survey/original.txt"), "utf8");
const composer = (text = "") => `────────────────────────────────────────────────────────────\n> ${text}\n────────────────────────────────────────────────────────────\n? for shortcuts                 Gemini 3.7 Flash · high\n`;
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) removeScratchTree(path); });

test("recognizes sanitized legacy survey tail and classifies it as blocked chrome", () => {
  expect(agySurveyOverlay(survey)).toBe(true);
  expect(classifyPane(survey, "agy", false)).toEqual({ kind: "no-band", reason: "Antigravity survey blocks the composer" });
});
for (const [label, frame] of [
  ["composer quotes", composer("How's the CLI experience so far? Help us improve:\n [1] Good  [2] Fine  [3] Bad  [0] Skip")],
  ["transcript quote", survey + composer()],
  ["normal draft", composer("do not touch this")],
  ["other modal", survey.replace("How's the CLI experience so far? Help us improve:", "Do you want to proceed?")],
  ["task card", composer() + "● [12:34:56] How's the CLI experience so far? Help us improve:\n[1] Good [2] Fine [3] Bad [0] Skip\n"],
] as const) test(`near miss: ${label} never supplies active survey authority`, () => expect(agySurveyOverlay(frame)).toBe(false));

function effects(initial = survey, restored = composer(), mode: "report-only" | "cautious" | "aggressive" = "cautious") {
  let frame = initial;
  let skips = 0;
  const fx: SurveyEffects = {
    surveyFrame: () => ({ code: 0, stdout: frame, stderr: "" }),
    skipSurvey: () => { skips++; frame = restored; return true; },
    surveyMode: () => mode,
    settle: () => {},
  };
  return { fx, skips: () => skips, change: (next: string) => { frame = next; } };
}
for (const mode of ["cautious", "aggressive"] as const) test(`${mode}: one Skip requires composer restoration`, () => {
  const f = effects(survey, composer(), mode);
  expect(recoverAgySurvey("%1", "agy", f.fx, () => null)).toEqual({ status: "restored" });
  expect(f.skips()).toBe(1);
});
test("report-only and wrong harness produce no keys", () => {
  const f = effects(survey, composer(), "report-only");
  expect(recoverAgySurvey("%1", "agy", f.fx, () => null).status).toBe("blocked");
  expect(recoverAgySurvey("%1", "codex", f.fx, () => null).status).toBe("not-survey");
  expect(f.skips()).toBe(0);
});
test("authority or frame change before effect refuses without Skip", () => {
  const f = effects();
  expect(recoverAgySurvey("%1", "agy", f.fx, () => "wrong instance").status).toBe("blocked");
  expect(recoverAgySurvey("%1", "agy", f.fx, () => { f.change(composer("draft")); return null; }).status).toBe("blocked");
  expect(f.skips()).toBe(0);
});
test("report-only, authority, and frame refusals do not admit attempt evidence", () => {
  for (const scenario of ["report", "authority", "frame"] as const) {
    const f = effects(survey, composer(), scenario === "report" ? "report-only" : "cautious");
    let admissions = 0;
    f.fx.admitAttempt = () => { admissions++; return true; };
    const authorize = () => {
      if (scenario === "authority") return "wrong instance";
      if (scenario === "frame") f.change(composer("draft"));
      return null;
    };
    expect(recoverAgySurvey("%1", "agy", f.fx, authorize).status).toBe("blocked");
    expect(admissions).toBe(0);
    expect(f.skips()).toBe(0);
  }
});
test("attempt evidence is admitted immediately before the one Skip effect", () => {
  const f = effects();
  const order: string[] = [];
  f.fx.admitAttempt = () => { order.push("attempt"); return true; };
  f.fx.skipSurvey = () => { order.push("skip"); f.change(composer()); return true; };
  expect(recoverAgySurvey("%1", "agy", f.fx, () => null).status).toBe("restored");
  expect(order).toEqual(["attempt", "skip"]);

  const refused = effects();
  refused.fx.admitAttempt = () => false;
  expect(recoverAgySurvey("%1", "agy", refused.fx, () => null).status).toBe("attempt_evidence_unwritable");
  expect(refused.skips()).toBe(0);
});

test("native submit preserves an attempt-evidence admission failure", () => {
  const f = nativeFixture();
  f.fx.admitAttempt = () => false;
  const authority = { ...f.authority, busHome: undefined };
  expect(submitVerifyLocked("%1", "mail", "[[TAP v0.23 ask mail]]", f.bound, f.fx, authority).status)
    .toBe("attempt_evidence_unwritable");
  expect(f.keys).toEqual([]);
});
for (const after of [survey, "unreadable", composer("human draft"), composer("[[TAP v0.23 ask existing]]"), composer() + "Requesting permission for:\nDo you want to proceed?\n"]) test("unsuccessful Skip never adds Enter or claims delivery", () => {
  const f = effects(survey, after);
  expect(recoverAgySurvey("%1", "agy", f.fx, () => null).status).toBe("blocked");
  expect(f.skips()).toBe(1);
});

function nativeFixture(after = composer()) {
  const root = mkdtempSync(join(tmpdir(), "tap-survey.")); roots.push(root);
  const registry = join(root, "registry.json");
  const row = { status: "active", harness: "agy", pane_id: "%1", instance: "seat|one", server_epoch: "srv:1:1" };
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture" }, seats: { seat: row } }));
  let text = "", skipped = false;
  const keys: string[] = [];
  const fx: PaneEffects = {
    ...effects().fx,
    surveyFrame: () => ({ code: 0, stdout: skipped ? after : survey, stderr: "" }),
    skipSurvey: () => { keys.push("0"); skipped = true; return true; },
    observePane: () => ({ paneId: "%1", session: "fixture/seat", serverEpoch: "srv:1:1", currentCommand: "agy", panePid: "123" }),
    harnessEvidence: () => "alive",
    copyMode: () => ({ status: "normal" }),
    paneState: () => skipped ? { state: "ready" } : { state: "unobservable", reason: "survey" },
    injectText: (_, value) => { keys.push("sentinel"); text = value; return true; },
    inputHasId: (_, __, id) => text.includes(id),
    pressEnter: () => { keys.push("Enter"); text = ""; return true; },
    submitFrame: (_, __, expected) => classifySubmitFrame(composer(text), "agy", expected),
  };
  const bound = { handle: "seat", instance: "seat|one", paneId: "%1", serverEpoch: "srv:1:1", harness: "agy" };
  const authority = { registryPath: registry, recipient: "seat", busHome: root, scriptsDir: resolve(import.meta.dir, "../../../skills/tap/scripts"), agentFamilies: new Set(["agy"]) };
  return { fx, bound, authority, keys, row, registry, root };
}
test("native submit path: Skip then restored composer then normal sentinel and Enter", () => {
  const f = nativeFixture();
  expect(submitVerifyLocked("%1", "mail", "[[TAP v0.23 ask mail]]", f.bound, f.fx, f.authority).status).toBe("injected");
  expect(f.keys).toEqual(["0", "sentinel", "Enter", "Enter"]);
});
test("native submit: no restored composer means no sentinel and no Enter", () => {
  const f = nativeFixture(survey);
  expect(submitVerifyLocked("%1", "mail", "[[TAP v0.23 ask mail]]", f.bound, f.fx, f.authority).status).toBe("band_busy");
  expect(f.keys).toEqual(["0"]);
});
for (const change of ["instance", "harness", "pane", "report", "fence"]) test(`native recovery denies ${change} before any keys`, () => {
  const f = nativeFixture();
  if (change === "report") f.fx.surveyMode = () => "report-only";
  else if (change === "fence") writeFileSync(join(f.root, "reset.fence.json"), "{}");
  else if (change === "harness") f.fx.harnessEvidence = () => "mismatch";
  else writeFileSync(f.registry, JSON.stringify({ schema: "0.20", team: { name: "fixture" }, seats: { seat: { ...f.row, [change === "instance" ? "instance" : "pane_id"]: "other" } } }));
  expect(submitVerifyLocked("%1", "mail", "[[TAP v0.23 ask mail]]", f.bound, f.fx, f.authority).status).not.toBe("injected");
  expect(f.keys).toEqual([]);
});

for (const dangling of [false, true]) test(`native survey rejects prior ${dangling ? "dangling" : "regular"} attempt marker`, () => {
  const f = nativeFixture();
  mkdirSync(join(f.root, "receipts"));
  const path = join(f.root, "receipts", "mail.attempted");
  if (dangling) symlinkSync(join(f.root, "missing"), path);
  else writeFileSync(path, '{"effect":"possible"}');
  expect(submitVerifyLocked("%1", "mail", "[[TAP v0.23 ask mail]]", f.bound, f.fx, f.authority).status).toBe("band_busy");
  expect(f.keys).toEqual([]);
});

test("current working survey is chrome; literal 0 restores the observed 92-column band", () => {
  const current = readFileSync(join(import.meta.dir, "fixtures/agy-survey/current-running.txt"), "utf8");
  const restored = readFileSync(join(import.meta.dir, "fixtures/agy-survey/current-restored.txt"), "utf8");
  expect(agySurveyOverlay(current)).toBe(true);
  expect(classifyPane(current, "agy", false)).toMatchObject({ kind: "no-band" });
  const f = effects(current, restored);
  expect(recoverAgySurvey("%1", "agy", f.fx, () => null).status).toBe("restored");
  expect(f.skips()).toBe(1);
  expect(classifyPane(restored, "agy", false)).toEqual({ kind: "ready" });
  expect(agySurveyOverlay(restored)).toBe(false);
});

for (const survey of [false, true]) test(`shared ${survey ? "survey" : "paste"} admission records every member and releases reset before the first key`, () => {
  const f = nativeFixture();
  if (!survey) {
    f.fx.surveyFrame = () => ({ code: 0, stdout: composer(), stderr: "" });
    f.fx.paneState = () => ({ state: "ready" });
  }
  const check = () => {
    for (const id of ["one", "two"]) expect(existsSync(join(f.root, "receipts", `${id}.attempted`))).toBe(true);
    const reset = acquirePathLock(join(f.root, "reset.fence.json.lock"), 0);
    try { expect(reset).not.toBeNull(); } finally { reset?.release(); }
  };
  const skip = f.fx.skipSurvey!, inject = f.fx.injectText;
  f.fx.skipSurvey = (...args) => { check(); return skip(...args); };
  f.fx.injectText = (...args) => { check(); return inject(...args); };
  const result = submitVerifyLocked("%1", "mail", "[[TAP v0.23 ask mail]]", f.bound, f.fx,
    { ...f.authority, attemptIds: ["one", "two"] });
  expect(result.status).toBe("injected");
  expect(existsSync(join(f.root, "receipts/mail.attempted"))).toBe(false);
});

test("a fence raised in the final paste authorization blocks member evidence and all keys", () => {
  const f = nativeFixture();
  f.fx.surveyFrame = () => ({ code: 0, stdout: composer(), stderr: "" });
  f.fx.paneState = () => ({ state: "ready" });
  const observe = f.fx.observePane; let reads = 0;
  f.fx.observePane = (...args) => {
    if (++reads === 3) writeFileSync(join(f.root, "reset.fence.json"), "{}");
    return observe(...args);
  };
  const result = submitVerifyLocked("%1", "mail", "[[TAP v0.23 ask mail]]", f.bound, f.fx,
    { ...f.authority, attemptIds: ["one", "two"] });
  expect(result.status).toBe("attempt_evidence_unwritable");
  expect(f.keys).toEqual([]);
  for (const id of ["one", "two"]) expect(existsSync(join(f.root, "receipts", `${id}.attempted`))).toBe(false);
});

function stagedFixture(stagedId = "mail") {
  const f = nativeFixture();
  let text = `[[TAP v0.23 ask ${stagedId}]]`;
  f.fx.surveyFrame = () => ({ code: 0, stdout: composer(text), stderr: "" });
  f.fx.paneState = () => text ? { state: "busy", text } : { state: "ready" };
  f.fx.submitFrame = (_, __, expected) => classifySubmitFrame(composer(text), "agy", expected);
  f.fx.injectText = (_, value) => { f.keys.push("inject"); text = value; return true; };
  f.fx.pressEnter = () => { f.keys.push("Enter"); text = ""; return true; };
  const run = (extra = {}) => submitVerifyLocked("%1", "mail", "[[TAP v0.23 ask mail]]", f.bound, f.fx,
    { ...f.authority, preserveDraft: false, attemptIds: ["mail"], ...extra });
  return { ...f, run, text: (value: string) => { text = value; } };
}

for (const survey of [true, false]) test(`member admission refuses an existing last member without minting a prefix (survey=${survey})`, () => {
  const f = nativeFixture();
  if (!survey) {
    f.fx.surveyFrame = () => ({ code: 0, stdout: composer(), stderr: "" });
    f.fx.paneState = () => ({ state: "ready" });
  }
  mkdirSync(join(f.root, "receipts"), { recursive: true });
  writeFileSync(join(f.root, "receipts/two.attempted"), "prior attempt\n");
  expect(submitVerifyLocked("%1", "mail", "[[TAP v0.23 ask mail]]", f.bound, f.fx,
    { ...f.authority, attemptIds: ["one", "two"] }).status).toBe("attempt_evidence_unwritable");
  expect(f.keys).toEqual([]);
  expect(existsSync(join(f.root, "receipts/one.attempted"))).toBe(false);
  expect(readFileSync(join(f.root, "receipts/two.attempted"), "utf8")).toBe("prior attempt\n");
});

test("a drain submits its staged wire without injecting it again", () => {
  const f = stagedFixture();
  expect(f.run().status).toBe("injected");
  expect(f.keys).toEqual(["Enter"]);
  expect(existsSync(join(f.root, "receipts/mail.attempted"))).toBe(true);
});

test("ordinary callers keep their default draft-preserving refusal", () => {
  const f = stagedFixture();
  expect(f.run({ preserveDraft: undefined }).status).toBe("band_busy");
  expect(f.keys).toEqual([]);
  expect(existsSync(join(f.root, "receipts/mail.attempted"))).toBe(false);
});

test("a drain submits a prior wire before injecting its own", () => {
  const f = stagedFixture("older");
  expect(f.run().status).toBe("injected");
  expect(f.keys).toEqual(["Enter", "inject", "Enter", "Enter"]);
  expect(existsSync(join(f.root, "receipts/mail.attempted"))).toBe(true);
  expect(phaseRows(f.root, "older").at(-1)?.enter_count).toBe(1);
  expect(phaseRows(f.root, "mail").at(-1)?.enter_count).toBe(2);
});

test("staged-wire binding drift in the final frame refuses before Enter and admission", () => {
  const f = stagedFixture();
  const frame = f.fx.submitFrame!;
  f.fx.submitFrame = (...args) => {
    const observed = frame(...args);
    writeFileSync(f.registry, JSON.stringify({ schema: "0.20", team: { name: "fixture" }, seats: { seat: { ...f.row, instance: "rebound" } } }));
    return observed;
  };
  expect(f.run().status).toBe("unverified");
  expect(f.keys).toEqual([]);
  expect(existsSync(join(f.root, "receipts/mail.attempted"))).toBe(false);
});

for (const changed of [false, true]) test(`zero-Enter re-probe ${changed ? "preserves altered input" : "submits its exact staged wire"}`, () => {
  const f = stagedFixture();
  mkdirSync(join(f.root, "spool")); mkdirSync(join(f.root, "receipts"));
  writeFileSync(join(f.root, "spool/mail.meta.json"), JSON.stringify({ reason: "pending-input" }));
  writeFileSync(join(f.root, "receipts/mail.attempted"), "prior possible effect");
  recordPhase(f.root, { id: "mail", attempt: "prior", phase: "injected-text-confirmed", recipient: "seat", enter_count: 0 });
  recordPhase(f.root, { id: "mail", attempt: "prior", phase: "verify-result", recipient: "seat", enter_count: 0, result: "unverified" });
  if (changed) f.text("human edit");
  expect(f.run({ reprobeOnly: true }).status).toBe(changed ? "unverified" : "injected");
  expect(f.keys).toEqual(changed ? [] : ["Enter"]);
  expect(pendingReprobe(f.root, "mail")).toBe(changed);
});
