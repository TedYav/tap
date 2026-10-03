// Default-deny (tap-rlebf.1): no TAP keystroke answers an approval prompt or a
// workspace-trust dialog. For each harness, every key-sending path is driven
// against that harness's real captured prompt frames: the native courier
// (plain, urgent, forced, no-spool and queue-prefix authorities), recovery keys
// (the nudge and detective effect door), Cursor's steering Enter, and the seat
// picker's typed name. Hermes has no real prompt capture yet (tap-3oox6); its
// synthetic frame stands in.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalPrompt } from "../src/agent-state";
import { submitVerifyLocked, type PaneEffects } from "../src/courier";
import { classifyPane, toPaneBand } from "../src/pane-state";
import { classifySubmitFrame } from "../src/submit-frame";
import { createRun, type RecoveryTarget } from "../src/recovery/state";
import { recoveryEffect, type EffectIO } from "../src/recovery/effect";
import { typeIntoPane } from "../src/verbs/pick";
import { idleFrame, nativeApproval } from "./helpers/approval-native";

const fixtures = join(import.meta.dir, "fixtures/agent-state");
const frame = (harness: string, name: string) => readFileSync(join(fixtures, harness, `${name}.txt`), "utf8");
const PROMPTS: Record<string, string[]> = {
  claude: ["blocked-real", "blocked-queued-real", "trust-auto-real", "trust-auto-narrow-real"],
  codex: ["blocked-real", "hook-trust", "trust-auto-real", "trust-auto-narrow-real"],
  cursor: ["blocked-real", "blocked-auto-review-real"],
  opencode: ["blocked-real", "blocked-auto-real"],
  agy: ["blocked-real", "trust-auto-real"],
  hermes: ["blocked"],
};

function recoveryKeys(harness: string, screen: string, action: string, keys: string[]): string[][] {
  const root = mkdtempSync(join(tmpdir(), "no-approve-recovery-"));
  const env = { ...process.env, TAP_INDEX_HOME: root, TAP_LOCK_DIR: join(root, "locks") };
  const target: RecoveryTarget = { team: "test", handle: "peer", registry: join(root, "registry.json"), pane: "test/peer:0.0",
    paneId: "%701", session: "test/peer", instance: "peer-instance", harness, processPid: "101" };
  const facts = { now: 1000, processAlive: () => true, paneAlive: () => true };
  const run = createRun(target, "aggressive", [], "%700", process.pid, env, facts);
  const effects: string[][] = [];
  const io: EffectIO = {
    capture: () => screen,
    snapshot: () => ({ dead: "0", command: harness, windowCount: "2", paneId: "%701", instance: "peer-instance" }),
    authorize: () => null, settle: () => {},
    effect: args => { effects.push(args); return { code: 0, stdout: "", stderr: "" }; },
  };
  recoveryEffect(run.id, action, "no-approve regression", ["send-keys", "-t", "%701", ...keys], io, env, () => facts);
  return effects;
}

function pickTypes(screen: string): { effects: string; error: string } {
  const root = mkdtempSync(join(tmpdir(), "no-approve-pick-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(root, "frame"), screen);
  writeFileSync(join(bin, "tmux"), '#!/bin/sh\nwhile [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done\ncase "$1" in\ncapture-pane) cat "$PICK_ROOT/frame" ;;\n*) printf "%s\\n" "$*" >> "$PICK_ROOT/effects" ;;\nesac\n', { mode: 0o755 });
  let error = "";
  try { typeIntoPane("%701", "yes/peer", { ...process.env, PATH: `${bin}:${process.env.PATH}`, PICK_ROOT: root }); }
  catch (e) { error = String(e); }
  return { effects: existsSync(join(root, "effects")) ? readFileSync(join(root, "effects"), "utf8") : "", error };
}

for (const [harness, names] of Object.entries(PROMPTS)) describe(`no TAP keystroke approves: ${harness}`, () => {
  for (const name of names) {
    const screen = frame(harness, name);
    test(`${name} is a prompt to every reader`, () => {
      expect(approvalPrompt(harness, screen)).toBe(true);
    });
    // Each spawns the courier; four cover plain, urgent, the --no-spool
    // ambiguity arm (FORCE_NO_PROMPT shares it) and the queue-prefix bypass.
    for (const [urgent, authority] of [[0, ""], [1, ""], [0, "TAP_SUBMIT_NO_SPOOL"], [1, "NO_PROMPT_OK"]] as const) {
      test(`native courier ${name} urgent=${urgent} ${authority || "plain"} sends no keys`, () => {
        const result = nativeApproval(harness, screen, urgent, authority);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe("status=band_busy\n");
      });
    }
    test(`recovery ${name}: Enter, a digit, a nudge Enter and an arrow+Enter are refused; Escape alone dismisses`, () => {
      expect(recoveryKeys(harness, screen, "keys Enter", ["Enter"])).toEqual([]);
      expect(recoveryKeys(harness, screen, "keys 1", ["1"])).toEqual([]);
      expect(recoveryKeys(harness, screen, "keys Down Enter", ["Down", "Enter"])).toEqual([]);
      expect(recoveryKeys(harness, screen, `nudge ${harness}`, ["Enter"])).toEqual([]);
      expect(recoveryKeys(harness, screen, "keys Escape", ["Escape"])).toEqual([["send-keys", "-t", "%701", "Escape"]]);
    });
    test(`pick types no name into ${name}`, () => {
      const result = pickTypes(screen);
      expect(result.effects).toBe("");
      expect(result.error).toContain("approval prompt");
    });
  }
});

// On an unclassified frame no key may commit a choice or move a selection
// (leader ruling): only Escape, 0 (survey dismissal) and the
// composer-editing C-u and BSpace. A nudge Enter keeps its own staged proof.
test("recovery on an unclassified frame sends only Escape, 0, C-u or BSpace", () => {
  const unknown = "  Folder access\n  something TAP has no rule for\n› 1. Allow everything\n  2. Quit\n";
  expect(approvalPrompt("codex", unknown)).toBe(false);
  for (const keys of [["Enter"], ["1"], ["9"], ["Down"], ["Up"], ["Tab"], ["Home"], ["Right"], ["C-u", "Enter"]]) {
    expect(recoveryKeys("codex", unknown, `keys ${keys.join(" ")}`, keys)).toEqual([]);
  }
  for (const keys of [["Escape"], ["0"], ["C-u"], ["BSpace", "BSpace"]]) {
    expect(recoveryKeys("codex", unknown, `keys ${keys.join(" ")}`, keys)).toEqual([["send-keys", "-t", "%701", ...keys]]);
  }
});

// Cursor presses a second, steering Enter 250 ms after the first. If the first
// Enter raised "Run this command?", the second would run it (default-deny review,
// tap-rlebf.1 round 1). The frame is re-read before the steering Enter.
test("Cursor steering Enter is withheld when the first Enter raised an approval prompt", () => {
  const idle = frame("cursor", "idle-real").replace("Plan, search, build anything", "");
  const blocked = frame("cursor", "blocked-auto-review-real");
  const wire = "[[TAP v0.23 note review-cursor-20261001T000000Z-abcdef123456]]";
  let capture = idle, enters = 0, approvalEnters = 0;
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "cursor" } as any),
    harnessEvidence: () => "alive",
    paneState: () => toPaneBand(classifyPane(capture, "cursor", false)),
    injectText: () => { capture = frame("cursor", "idle-real").replace("Plan, search, build anything", wire); return true; },
    inputHasId: () => capture.includes(wire),
    pressEnter: () => { if (capture === blocked) approvalEnters++; enters++; capture = blocked; return true; },
    settle: () => {},
    submitFrame: (_target, command, text, alive) => classifySubmitFrame(capture, command, text, "120", alive),
  };
  const result = submitVerifyLocked("%1", "review-cursor-20261001T000000Z-abcdef123456", wire, { paneId: "%1", harness: "cursor", serverEpoch: "srv:1:1" }, fx);
  expect([enters, approvalEnters]).toEqual([1, 0]);
  expect(result.status).toBe("unverified");
});

// Delivery holds on an unclassified frame, with no exception (leader ruling,
// round 2; cases from the default-deny review): the urgent --no-spool, forced
// and Hermes queue-prefix arms send no Escape, wire or Enter, and Cursor's
// steering Enter waits when the frame after the first Enter is unclassified.
const unclassified = "Unclassified harness dialog\n";
for (const [urgent, authority] of [[1, "TAP_SUBMIT_NO_SPOOL"], [1, "TAP_SUBMIT_FORCE_NO_PROMPT"], [1, "NO_PROMPT_OK"], [0, "TAP_SUBMIT_NO_SPOOL"], [0, "NO_PROMPT_OK"]] as const) {
  test(`native courier on an unclassified frame urgent=${urgent} ${authority} sends no keys`, () => {
    const result = nativeApproval("codex", unclassified, urgent, authority);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("status=band_busy\n");
  });
}
test("Cursor steering Enter waits when the first Enter leaves an unclassified frame", () => {
  const idle = frame("cursor", "idle-real");
  const wire = "[[TAP v0.23 note review-cursor-20261001T000000Z-abcdef123456]]";
  let capture = idle.replace("Plan, search, build anything", ""), enters = 0;
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "cursor" } as any),
    harnessEvidence: () => "alive",
    paneState: () => toPaneBand(classifyPane(capture, "cursor", false)),
    injectText: () => { capture = idle.replace("Plan, search, build anything", wire); return true; },
    inputHasId: () => capture.includes(wire),
    pressEnter: () => { enters++; capture = unclassified; return true; },
    settle: () => {},
    submitFrame: (_target, command, text, alive) => classifySubmitFrame(capture, command, text, "120", alive),
    captureEscaped: () => ({ ok: true, frame: capture }),
  };
  const result = submitVerifyLocked("%1", "review-cursor-20261001T000000Z-abcdef123456", wire, { paneId: "%1", harness: "cursor", serverEpoch: "srv:1:1" }, fx);
  expect(enters).toBe(1);
  expect(result.status).toBe("unverified");
});

// The frame can turn unclassified between the courier's reads (a resize, a
// dialog opening). The last read before paste classifies the current frame,
// with no earlier verdict carried (default-deny review, round 3).
for (const [urgent, authority] of [[0, "TAP_SUBMIT_NO_SPOOL"], [0, "NO_PROMPT_OK"], [0, ""], [1, "TAP_SUBMIT_NO_SPOOL"]] as const) {
  test(`native courier: a frame that turns unclassified before paste gets no wire (urgent=${urgent} ${authority || "plain"})`, () => {
    const result = nativeApproval("codex", idleFrame("codex", ""), urgent, authority, false, unclassified);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("-l --");
    expect(result.stdout).not.toContain("Enter");
  });
}

// tap-rlebf.2: the approval timeout's one effect is a lone Escape through this same
// door. On every real prompt frame it reaches the pane exactly as that, and no
// approve-shaped key on the same path does.
describe("approval-timeout reject path", () => {
  for (const [harness, names] of Object.entries(PROMPTS)) {
    for (const name of names) {
      test(`${harness}/${name}: only a lone Escape reaches the pane`, () => {
        const screen = frame(harness, name);
        expect(recoveryKeys(harness, screen, "approval-timeout reject", ["Escape"])).toEqual([["send-keys", "-t", "%701", "Escape"]]);
        for (const keys of [["Enter"], ["1"], ["Down"], ["Tab"], ["BTab"], ["Escape", "Enter"], ["y"], ["d"]]) {
          expect([keys, recoveryKeys(harness, screen, "approval-timeout reject", keys)]).toEqual([keys, []]);
        }
      });
    }
  }
  test("the production seam names exactly one Escape and no other key", () => {
    const source = readFileSync(join(import.meta.dir, "../src/approval-timeout-real.ts"), "utf8");
    const sends = [...source.matchAll(/\["send-keys",[^\]]*\]/g)].map(m => m[0]);
    expect(sends).toEqual(['["send-keys", "-t", row.paneId, "Escape"]']);
  });
});
