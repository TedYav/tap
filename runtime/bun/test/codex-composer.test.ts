import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { classifySubmitFrame, readComposerFrame, sentinelInputTail, sentinelSubmitDecision } from "../src/submit-frame";
import { classifyPane, toPaneBand } from "../src/pane-state";
import { submitVerifyLocked, type PaneEffects } from "../src/courier";
import { detectAgentState } from "../src/agent-state";
import { composerInput } from "../src/submit-frame";
import { stuckSentinelFieldsFromRegion } from "../src/stuck-sentinel";
const root = new URL("../../../", import.meta.url).pathname;
const fixture = (name: string) => readFileSync(root + `skills/tap/scripts/smoke/fixtures/submit-verify/${name}.ansi`, "utf8");
const id = "sender-20260906T220111Z-21f26672936f";
const wire = `[[TAP v0.23 note ${id}]]`;
/** The composer reader in the retired Bash door's rc/stdout shape: text 0, unknown 3, blocked 4. */
function composerRead(capture: string) {
  const v = composerInput(capture, "codex");
  return v.state === "text" ? { status: 0, stdout: v.text, stderr: "" } : { status: v.state === "unknown" ? 3 : 4, stdout: "", stderr: "" };
}
for (const width of [40, 80]) {
 test(`captured idle staged Codex ${width}: same reader for native submit and stuck recovery`, () => {
  const capture = fixture(`codex-idle-staged-${width}`);
  expect(classifySubmitFrame(capture, "codex", wire).state).toBe("staged");
  const result = composerRead(capture);
  expect(result.status).toBe(0);
  expect(readComposerFrame(capture, "codex")).toBe(result.stdout.trim());
  const recovered = stuckSentinelFieldsFromRegion(result.stdout, "codex");
  expect(recovered.ok && recovered.fields.id).toBe(id);
 });
}
for (const width of [40,80]) {
 test(`native idle Codex ${width} reaches injection and owned submit and completion Enters`, () => {
  const empty = fixture(width === 40 ? "codex-idle-empty-40" : "codex-idle-empty");
  const staged = fixture(`codex-idle-staged-${width}`);
  let capture = empty, injected = 0, enters = 0;
  const fx: PaneEffects = {
   observePane: () => ({paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "codex"} as any),
   paneState: () => toPaneBand(classifyPane(capture, "codex", false)),
   injectText: (_, text) => {expect(text).toBe(wire); injected++; capture=staged; return true;},
   inputHasId: () => (readComposerFrame(capture, "codex") ?? "").replace(/\s/g, "").includes(id),
   submitFrame: () => classifySubmitFrame(capture, "codex", wire),
   pressEnter: () => {enters++; capture=empty; return true;}, settle: () => {},
  };
  expect(submitVerifyLocked("%1", id, wire, undefined, fx).status).toBe("injected");
  expect([injected,enters]).toEqual([1,2]);
  capture=empty.replace("Ask Codex to do anything", "human draft").replace(/\x1b\[2m/g, "");
  expect(submitVerifyLocked("%1", id, wire, undefined, fx).status).toBe("band_busy");
  expect([injected,enters]).toEqual([1,2]);
  const bash = composerRead(empty);
  expect(bash.status).toBe(0); expect(bash.stdout).toBe("");
 });
}
test("existing physical footer wraps keep one composer reading", () => {
 const base = fixture("codex-status-2token");
 for(const capture of [base, base.replace(' · ', ' ·\n'), fixture('codex-status-wrapped-constructed')]) {
  expect(readComposerFrame(capture,"codex")).toBe("/compact");
  expect(composerRead(capture).stdout.trim()).toBe("/compact");
 }
});
test("pre-inject draft protection stays strict while visible wire authorizes Enter", () => {
 const staged=fixture("codex-idle-staged-80");
 for(const text of ["human draft", wire+" human draft", wire.slice(0,-2), "gpt-6-astra medium · Context 99% left…"]) {
  // Replace only the active occurrence; transcript echoes stay unchanged.
  const at=staged.lastIndexOf(wire); const capture=staged.slice(0,at)+text+staged.slice(at+wire.length);
  expect(classifySubmitFrame(capture,"codex",wire).state).toBe(text.includes(wire) ? "staged" : "changed");
  expect(classifyPane(capture,"codex",false).kind).toBe("draft");
  expect(composerRead(capture).stdout.trim()).toBe(text);
 }
 expect(readComposerFrame("no prompt\ngpt-6-astra medium · Context 99% left…","codex")).toBeNull();
 const missing = composerRead("no prompt");
 expect(missing.status).not.toBe(0);
 expect(missing.stderr).toBe("");
 for(const name of ["codex-status-invalid-effort","codex-status-1token-constructed"]) {
  expect(readComposerFrame(fixture(name),"codex")).toContain("Context");
  expect(composerRead(fixture(name)).stdout).toContain("Context");
 }
});

test("a recognized footer followed by arbitrary rows remains ambiguous", () => {
 const capture=fixture("codex-idle-staged-80")+"\n  human continuation";
 expect(readComposerFrame(capture,"codex")).toContain("human continuation");
 expect(classifySubmitFrame(capture,"codex",wire).state).toBe("staged");
 expect(composerRead(capture).stdout).toContain("human continuation");
});

test("unseparated text before footer cannot be consumed as a longer model token", () => {
 const capture = `› ${wire}\nhuman draft\ngpt-6-astra medium · Context 99% left…`;
 expect(classifySubmitFrame(capture,"codex",wire).state).toBe("staged");
 expect(readComposerFrame(capture,"codex")).toContain("human draft");
});

test("saved terminal Context-left footer permits submit and completion Enters", () => {
 const captured=fixture("codex-terminal-context");
 const terminalId="sender-20260907T013531Z-fb2af96900ca";
 const terminalWire=`[[TAP v0.23 ask ${terminalId}]]`;
 const empty=captured.replace(terminalWire, ""); // Derived empty variant; same real footer.
 expect(classifySubmitFrame(captured,"codex",terminalWire).state).toBe("staged");
 expect(composerRead(captured).stdout.trim()).toBe(terminalWire);
 expect(classifyPane(empty,"codex",false).kind).toBe("ready");
 let current=empty, injected=0, enters=0;
 const fx:PaneEffects={
  observePane:()=>({paneId:"%1",session:"fixture",serverEpoch:"srv:1:1",currentCommand:"codex"} as any),
  paneState:()=>toPaneBand(classifyPane(current,"codex",false)),
  injectText:()=>{injected++;current=captured;return true;},inputHasId:()=>current.includes(terminalId),
  submitFrame:()=>classifySubmitFrame(current,"codex",terminalWire),
  pressEnter:()=>{enters++;current=empty;return true;},settle:()=>{},
 };
 expect(submitVerifyLocked("%1",terminalId,terminalWire,undefined,fx).status).toBe("injected");
 expect([injected,enters]).toEqual([1,2]);
 expect(classifySubmitFrame(captured.replace(terminalWire,terminalWire+" human draft"),"codex",terminalWire).state).toBe("staged");
 expect(classifySubmitFrame(captured+"\nhuman continuation","codex",terminalWire).state).toBe("staged");
});

test("terminal context row may wrap into a footer separator, not human text", () => {
 const captured=fixture("codex-terminal-context");
 const expected="[[TAP v0.23 ask sender-20260907T013531Z-fb2af96900ca]]";
 const wrapped=captured.replace("Context 99% left", "Context 99% left\n · /project");
 expect(classifySubmitFrame(wrapped,"codex",expected).state).toBe("staged");
 expect(composerRead(wrapped).stdout.trim()).toBe(expected);
 expect(classifySubmitFrame(captured+"\nhuman continuation","codex",expected).state).toBe("staged");
});

// Synthetic 89-column Codex geometry; no captured transcript or workspace data.
const chevronFrame = (glyph: string, text: string) =>
 `Synthetic transcript: quoted » is punctuation.\n\n${glyph} ${text}\n\n  gpt-6-astra ultra fast · Context 66% left · /synthetic · weekly 19% left · Ma…\n`;
for (const glyph of ["»", "›", "❯"]) {
 test(`Codex ${glyph} composer preserves empty, staged, occupied and queued input`, () => {
  for (const text of ["", wire, "human draft", Array(22).fill(wire).join("")]) {
   const frame = chevronFrame(glyph, text);
   expect(readComposerFrame(frame, "codex")).toBe(text);
   expect(composerRead(frame).stdout.trim()).toBe(text);
   expect(composerRead(frame).status).toBe(0);
   expect(classifyPane(frame,"codex",false).kind).toBe(text ? "draft" : "ready");
   expect(classifySubmitFrame(frame,"codex",wire).state).toBe(text.includes(wire) ? "staged" : text ? "changed" : "empty");
  }
  expect(sentinelInputTail(chevronFrame(glyph,wire),"codex")).toContain(wire);
  expect(sentinelSubmitDecision(chevronFrame(glyph,wire),"codex",wire)).toEqual({action:"submit"});
  expect(detectAgentState("codex",chevronFrame(glyph,"\x1b[2mAsk Codex to do anything\x1b[0m"))).toEqual({agentState:"idle",reason:"prompt_idle"});
  const queued = `↳ queued human follow-up\n${glyph} \nshift + ← edit last queued message\n`;
  expect(classifyPane(queued,"codex",false).kind).toBe("queued");
  const placeholder = chevronFrame(glyph, "\x1b[2mAsk Codex to do anything\x1b[0m");
  expect(readComposerFrame(placeholder,"codex")).toBe("");
  expect(readComposerFrame(chevronFrame(glyph,"Ask Codex to do anything").replace(`${glyph} Ask`, `\x1b[2m${glyph} Ask`).replace("anything", "anything\x1b[0m"),"codex")).toBe("");
 });
}
test("quoted chevron without a prompt is not input and other harnesses do not gain it", () => {
 const quoted = 'Transcript says "» quoted text"\n  gpt-6-astra ultra fast · Context 66% left';
 expect(readComposerFrame(quoted,"codex")).toBeNull();
 expect(classifyPane(quoted,"codex",false).kind).toBe("no-band");
 expect(composerRead(quoted).status).toBe(3);
 expect(readComposerFrame(chevronFrame("»",wire),"hermes")).toBeNull();
});


for (const [name, text] of [["captured", ""], ["idle", ""], ["nofooter", ""], ["goal-paused", ""], ["typed", "Please keep this draft."]] as const) {
 test(`weekly quota footer incident: ${name} preserves native composer boundary`, () => {
  const capture = readFileSync(new URL(`./fixtures/codex-weekly-footer/${name}.ansi`, import.meta.url), "utf8");
  expect(readComposerFrame(capture, "codex")).toBe(text);
  expect(classifyPane(capture, "codex", false)).toEqual(text ? {kind: "draft", text} : {kind: "ready"});
  const bash = composerRead(capture);
  expect(bash.status).toBe(0);
  expect(bash.stdout).toBe(text);
 });
}


test("weekly footer extraction keeps draft and ambiguous-tail protections", () => {
 const status = "gpt-6-astra high · project name · weekly 7% left";
 const frame = (text: string, footer = status) => `› ${text}\n\n  ${footer}\n`;
 for (const text of [status, "human draft\n  continued text", "Ask Codex to do anything"]) {
  expect(readComposerFrame(frame(text), "codex")).toBe(text);
  expect(composerRead(frame(text)).stdout).toBe(text);
  expect(classifyPane(frame(text), "codex", false)).toEqual({kind: "draft", text});
 }
 for (const footer of [status.replace("high", "unknown"), status.replace("weekly", "unrecognized")]) {
  expect(readComposerFrame(frame("human draft", footer), "codex")).toContain(footer);
 }
 const ambiguous = frame("human draft") + "human continuation";
 expect(readComposerFrame(ambiguous, "codex")).toContain("human continuation");
 expect(composerRead(ambiguous).stdout).toContain("human continuation");
 const paused = frame("human draft", status + " Goal paused (/goal resume)");
 expect(readComposerFrame(paused, "codex")).toBe("human draft");
 expect(composerRead(paused).stdout).toBe("human draft");
 const wrapped = frame("human draft", status.replace(" · weekly", "\n · weekly"));
 expect(readComposerFrame(wrapped, "codex")).toBe("human draft");
 expect(composerRead(wrapped).stdout).toBe("human draft");
});


test("dim Codex placeholder owns an empty composer regardless of unknown footer rows", () => {
 const idle = readFileSync(new URL("./fixtures/codex-weekly-footer/idle.ansi", import.meta.url), "utf8");
 const unknown = idle + "  Future footer with an unfamiliar layout\n";
 expect(readComposerFrame(unknown, "codex")).toBe("");
 expect(classifyPane(unknown, "codex", false)).toEqual({kind: "ready"});
 expect(composerRead(unknown).stdout).toBe("");
 // Plain placeholder words are a human draft, even with unknown footer text.
 const typed = unknown.replace("\x1b[2mAsk Codex to do anything", "Ask Codex to do anything");
 expect(readComposerFrame(typed, "codex")).toContain("Ask Codex to do anything");
 expect(readComposerFrame(typed, "codex")).toContain("Future footer");
 expect(classifyPane(typed, "codex", false).kind).toBe("draft");
});

test("Codex configurable footer text cannot supply a working mode", () => {
 const frame = "› \x1b[2mAsk Codex to do anything\x1b[0m\nmy custom status: esc to interrupt";
 expect(classifySubmitFrame(frame, "codex", wire).mode).toBe("idle");
});
