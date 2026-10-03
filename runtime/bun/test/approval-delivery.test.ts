import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyPane, toPaneBand } from "../src/pane-state";
import { classifySubmitFrame, sentinelSubmitDecision } from "../src/submit-frame";
import { submitVerifyLocked, type PaneEffects } from "../src/courier";

// Codex blocked-real capture, 2026-09-08, CLI 0.153.4 on-request, 120x40.
// Full captured frame; only trailing whitespace removed. Operator declined; probe wrote nothing.
// Original capture SHA256: 3ea624344505c25d43d9416776d04db88675f5141769419141a351aaa261ca22
const wire = "[[TAP v0.23 note approval-held]]";
for (const harness of ["claude", "codex"]) {
  const blocked = readFileSync(join(import.meta.dir, `fixtures/agent-state/${harness}/blocked-real.txt`), "utf8");
  const composer = (text: string) => harness === "claude" ? `${"─".repeat(50)}\n❯ ${text}\n${"─".repeat(50)}\n` : `› ${text}\ngpt-5.6-sol xhigh · Context 100% left\n`;
  test(`${harness} approval holds all pane effects; answered prompt resumes delivery`, () => {
    let capture = blocked, enters = 0, pastes = 0;
    const fx: PaneEffects = {
      observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: harness } as any),
      harnessEvidence: () => "alive",
      paneState: () => toPaneBand(classifyPane(capture, harness, false)),
      injectText: () => { pastes++; capture = composer(wire); return true; },
      inputHasId: () => capture.includes(wire),
      pressEnter: () => { enters++; capture = composer(""); return true; }, settle: () => {},
      submitFrame: (_target, command, text, alive) => classifySubmitFrame(capture, command, text, "50", alive),
    };
    const bound = { paneId: "%1", harness, serverEpoch: "srv:1:1" };
    expect(submitVerifyLocked("%1", "approval-held", wire, bound, fx).status).toBe("band_busy");
    expect([pastes, enters]).toEqual([0, 0]);
    capture = composer("");
    expect(submitVerifyLocked("%1", "approval-held", wire, bound, fx).status).toBe("injected");
    expect([pastes, enters]).toEqual([1, 2]);
  });
  test(`${harness} a visible wire never authorizes approval Enter, even with live attestation`, () => {
    const capture = blocked.replace(/([›❯]) 1\./, `$1 ${wire} 1.`);
    expect(sentinelSubmitDecision(capture, harness, wire, true)).toEqual({ action: "withhold", reason: "dialog" });
    expect(classifySubmitFrame(capture, harness, wire, "50", true).state).not.toBe("staged");
  });
}

import { idleFrame, nativeApproval } from "./helpers/approval-native";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
const repo = new URL("../../../", import.meta.url).pathname;
for (const harness of ["claude", "codex"]) for (const urgent of [0, 1]) {
  const capture = readFileSync(join(import.meta.dir, `fixtures/agent-state/${harness}/blocked-real.txt`), "utf8");
  for (const force of ["", "TAP_SUBMIT_FORCE_NO_PROMPT", "TAP_SUBMIT_NO_SPOOL"]) test(`native ${harness} urgent=${urgent} ${force} sends no approval keys`, () => {
    const result = nativeApproval(harness, capture, urgent, force);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("status=band_busy\n");
  });
  test(`native ${harness} urgent=${urgent} delivers after approval clears`, () => {
    const result = nativeApproval(harness, capture, urgent, "", true);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("status=injected\n");
    expect(result.stdout).toContain("-l -- " + wire);
    expect(result.stdout).toContain("Enter\n");
  });
}

for (const harness of ["claude", "codex"]) test(`native ${harness} approval appearing before draft clear sends no keys`, () => {
  const modal = readFileSync(join(import.meta.dir, `fixtures/agent-state/${harness}/blocked-real.txt`), "utf8");
  const result = nativeApproval(harness, idleFrame(harness, "human draft"), 0, "", false, modal);
  expect(result.status).toBe(0);
  // The draft-clear door refuses the modal and keeps the backup: no key falls.
  // (The retired Bash door answered rc 4 here; native reports the refused clear as unverified.)
  expect(result.stdout).toBe("status=unverified\n");
});

// Live Claude 2.1.257 capture from review-3, 2026-09-08 23:59:48Z, 120 columns.
// A queued wire remains below the real prompt; only trailing whitespace normalized.
for (const urgent of [0, 1]) for (const force of ["", "TAP_SUBMIT_FORCE_NO_PROMPT", "TAP_SUBMIT_NO_SPOOL"]) {
  test(`native Claude live queued-under-approval urgent=${urgent} ${force} sends no keys`, () => {
    const capture = readFileSync(join(import.meta.dir, "fixtures/agent-state/claude/blocked-queued-real.txt"), "utf8");
    const result = nativeApproval("claude", capture, urgent, force);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("status=band_busy\n");
  });
}

import { approvalPrompt, detectAgentState } from "../src/agent-state";
test("Claude queued-under-modal capture is blocked, while a later composer or output stays unblocked", () => {
  const capture = readFileSync(join(import.meta.dir, "fixtures/agent-state/claude/blocked-queued-real.txt"), "utf8");
  expect(detectAgentState("claude", capture)).toEqual({ agentState: "blocked", reason: "permission_prompt" });
  expect(approvalPrompt("claude", capture + "\n" + idleFrame("claude", ""))).toBe(false);
  expect(approvalPrompt("claude", capture + "\nordinary output after the old prompt\n")).toBe(false);
});

const queuedCapture = readFileSync(join(import.meta.dir, "fixtures/agent-state/claude/blocked-queued-real.txt"), "utf8");
const queuedPrefix = queuedCapture.trimEnd().split("\n").slice(0, -1).join("\n");
const longQueued = "  ❯ [[TAP v0.23 note tap/demo-conductor-20260908T235905Z-914016d437f6: please confirm the probe directory listing and reply with the count of entries you";
// Derived from the 120-column live capture, matching review-1's physical wrap.
const queuedVariants = {
  wrapped: queuedPrefix + "\n" + longQueued.slice(0, 120) + "\n" + longQueued.slice(120),
  two: queuedCapture.trimEnd() + "\n  ❯ [[TAP v0.23 note tap/second-20260908T235959Z-aaaaaaaaaaaa]]",
};
for (const [name, capture] of Object.entries(queuedVariants)) {
  test(`Claude ${name} queued group remains a modal`, () => expect(approvalPrompt("claude", capture)).toBe(true));
  for (const urgent of [0, 1]) test(`native Claude ${name} queued group urgent=${urgent} receives no keys`, () => {
    const result = nativeApproval("claude", capture, urgent, "");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("status=band_busy\n");
  });
}

for (const harness of ["claude", "codex"]) for (const urgent of [0, 1]) {
  for (const frame of ["unknown dialog without a recognized composer", idleFrame(harness, "human draft")]) {
    test(`auto ${harness} urgent=${urgent} never clears unknown or draft`, () => {
      const result = nativeApproval(harness, frame, urgent, "TAP_SUBMIT_FORCE_NO_PROMPT", false, "", "auto");
      expect(result.stdout).toBe("status=band_busy\n");
    });
  }
  test(`auto ${harness} urgent=${urgent} submits its own wire into a clean composer without Escape`, () => {
    const result = nativeApproval(harness, "", urgent, "", true, "", "auto");
    expect(result.stdout).toContain("status=injected\n");
    expect(result.stdout).toContain("-l -- " + wire);
    expect(result.stdout).toContain("Enter");
    expect(result.stdout).not.toContain("Escape");
  });
}
test("auto sole-content rule refuses extra text after its sentinel", () => {
  for (const harness of ["claude", "codex"]) {
    expect(classifySubmitFrame(idleFrame(harness, wire), harness, wire, "50", true, true).state).toBe("staged");
    expect(classifySubmitFrame(idleFrame(harness, wire + " extra"), harness, wire, "50", true, true).state).not.toBe("staged");
  }
});

test("bypass keeps its draft-clear attempt on unrecognized chrome", () => {
  // The door reads through the box classifier, so the draft frame
  // carries real Claude box borders; the footer row below the prompt stays a
  // row the classifier does not recognize, and the clear attempt still runs.
  const result = nativeApproval("claude", `${"─".repeat(50)}\n❯ human draft\nunrecognized footer\n${"─".repeat(50)}\n`, 0, "", false, "", "bypass");
  expect(result.stdout).toContain("C-u");
});

for (const harness of ["claude", "codex"]) for (const scenario of ["ready", "unknown", "extra"]) {
  test(`native auto ${harness} ${scenario} uses ready and sole-content proofs`, () => {
    const home = mkdtempSync("/tmp/tap-native-auto-");
    mkdirSync(join(home, "receipts"));
    const registry = join(home,"registry.json");
    writeFileSync(registry, JSON.stringify({schema:"0.20",seats:{peer:{status:"active",harness,permissions:"auto",pane_id:"%1",pane:"fixture",instance:"peer|A",server_epoch:"srv:1:1"}}}));
    let capture = scenario === "unknown" ? "unknown dialog" : idleFrame(harness, ""), pastes=0, enters=0;
    const fx: PaneEffects = {
      observePane: () => ({paneId:"%1",session:"fixture",serverEpoch:"srv:1:1",currentCommand:harness} as any),
      harnessEvidence: () => "alive",
      paneState: () => toPaneBand(classifyPane(capture,harness,false)),
      injectText: () => { pastes++;capture=idleFrame(harness,wire+(scenario==="extra"?" extra":""));return true; },
      pressEnter: () => { enters++;capture=idleFrame(harness,"");return true; },
      inputHasId: () => capture.includes(wire),settle: () => {},
      submitFrame: (_target,command,text,alive,sole) => classifySubmitFrame(capture,command,text,"50",alive,sole),
    };
    try {
      const result=submitVerifyLocked("%1","approval-held",wire,{paneId:"%1",harness,serverEpoch:"srv:1:1",handle:"peer",instance:"peer|A"},fx,
        {scriptsDir:repo+"skills/tap/scripts",agentFamilies:new Set([harness]),busHome:home,recipient:"peer",registryPath:registry});
      expect([pastes,enters]).toEqual(scenario==="ready"?[1,2]:scenario==="extra"?[1,0]:[0,0]);
      expect(result.status).toBe(scenario==="ready"?"injected":scenario==="extra"?"unverified":"band_busy");
    } finally { rmSync(home,{recursive:true,force:true}); }
  });
}

// Real default-mode approval frames beyond Claude/Codex (tap-3oox6). OpenCode
// blocked-real/idle-real: OpenCode 1.18.31, sandbox HOME, no `permission` key
// (the shipped default), openrouter/anthropic/claude-haiku-4.5, 120x40,
// 2026-09-23T19:57Z. Reading /etc/hosts raised the external-directory dialog;
// the probe pressed Escape, never a choice. Plain capture; trailing whitespace removed.
// Cursor blocked-real/idle-real/working-real: cursor-agent 2026.09.18-9a7762b
// `--trust`, sandbox HOME with `approvalMode` unset and an empty allowlist,
// 120x40, 2026-09-23T19:58Z, asked to run `echo tap-probe`; Escape, never a choice.
// agy blocked-real/idle-real/working-real: Antigravity CLI 1.2.9 (self-updated
// from 1.2.8 mid-run), no --dangerously-skip-permissions, empty allowlist,
// 120x40, 2026-09-23T20:14Z, same `echo tap-probe` ask; Escape, never a choice.
// The account email in agy's header is replaced with user@example.com.
import { composerInput } from "../src/submit-frame";
import { pendingInputText } from "../src/pane/reader";
for (const harness of ["opencode", "cursor", "agy"]) {
  const blocked = readFileSync(join(import.meta.dir, `fixtures/agent-state/${harness}/blocked-real.txt`), "utf8");
  const idle = readFileSync(join(import.meta.dir, `fixtures/agent-state/${harness}/idle-real.txt`), "utf8");
  test(`${harness} real approval prompt is an approval prompt; its real idle frame is not`, () => {
    expect(approvalPrompt(harness, blocked)).toBe(true);
    expect(approvalPrompt(harness, idle)).toBe(false);
  });
  test(`${harness} readers hold the real approval prompt`, () => {
    expect(classifyPane(blocked, harness, false)).toMatchObject({ kind: "no-band" });
    expect(composerInput(blocked, harness)).toEqual({ state: "blocked" });
    // Before tap-3oox6 this was no-band, which the drain may force after its bound.
    const io = { capture: () => ({ code: 0, stdout: blocked }) } as never;
    expect(pendingInputText(io, "%1", harness, blocked)).toEqual({ status: "blocked" });
    expect(sentinelSubmitDecision(blocked, harness, wire, true)).toEqual({ action: "withhold", reason: "dialog" });
  });
  for (const urgent of [0, 1]) for (const force of ["", "TAP_SUBMIT_FORCE_NO_PROMPT", "TAP_SUBMIT_NO_SPOOL"]) {
    test(`native ${harness} urgent=${urgent} ${force} sends no approval keys`, () => {
      const result = nativeApproval(harness, blocked, urgent, force);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("status=band_busy\n");
    });
  }
}

// Codex review: the Cursor run choice keeps `(y)` when the arrow moves;
// agy's live dialog is its key-hint footer even when a narrow pane paints the
// transcript and composer rules at the same width.
test("Cursor approval stays recognized after the selection arrow moves", () => {
  const blocked = readFileSync(join(import.meta.dir, "fixtures/agent-state/cursor/blocked-real.txt"), "utf8");
  const moved = blocked.replace("  → Run (once) (y)", "    Run (once) (y)").replace("    Skip & tell", "  → Skip & tell");
  expect(moved).not.toBe(blocked);
  expect(approvalPrompt("cursor", moved)).toBe(true);
});
test("agy approval stays recognized when every rule is the same width", () => {
  const blocked = readFileSync(join(import.meta.dir, "fixtures/agent-state/agy/blocked-real.txt"), "utf8");
  const narrow = blocked.replace(/─{61,}/g, "─".repeat(60));
  expect(narrow).not.toBe(blocked);
  expect(approvalPrompt("agy", narrow)).toBe(true);
});
test("a Hermes approval prompt is not cleared by the queue-prefix bypass", () => {
  const modal = readFileSync(join(import.meta.dir, "fixtures/agent-state/hermes/blocked.txt"), "utf8");
  let pastes = 0, enters = 0;
  const fx: PaneEffects = {
    observePane: () => ({ paneId: "%1", session: "fixture", serverEpoch: "srv:1:1", currentCommand: "hermes" } as any),
    harnessEvidence: () => "alive",
    paneState: () => toPaneBand(classifyPane(modal, "hermes", false)),
    injectText: () => { pastes++; return true; },
    inputHasId: () => false,
    pressEnter: () => { enters++; return true; }, settle: () => {},
  };
  const result = submitVerifyLocked("%1", "approval-held", wire, { paneId: "%1", harness: "hermes", serverEpoch: "srv:1:1" }, fx, { noPromptOk: true } as never);
  expect(result.status).toBe("band_busy");
  expect([pastes, enters]).toEqual([0, 0]);
});

const hookTrust = readFileSync(join(import.meta.dir, "fixtures/agent-state/codex/hook-trust.txt"), "utf8");
for (const urgent of [0, 1]) for (const force of ["", "TAP_SUBMIT_FORCE_NO_PROMPT", "TAP_SUBMIT_NO_SPOOL"]) {
  test(`Codex hook trust urgent=${urgent} ${force} never sends keys`, () => {
    const result = nativeApproval("codex", hookTrust, urgent, force);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("status=band_busy\n");
  });
}

// tap-ipex2: Escape or C-c clears a draft as surely as C-u, so wait mode parks
// before any interrupt key, whichever route reaches the urgent branch.
for (const behavior of ["wait", "clobber"]) test(`urgent native submit to a Claude draft honors injection.behavior=${behavior} before any key`, () => {
  const result = nativeApproval("claude", idleFrame("claude", "human draft that must survive"), 1, "", false, "", "bypass",
    `[injection]\nbehavior="${behavior}"\n`);
  const escaped = /send-keys .*Escape/.test(result.stdout);
  if (behavior === "wait") {
    expect(result.stdout).toContain("status=band_busy");
    expect(escaped, result.stdout).toBe(false);
    expect(result.stdout).not.toContain("C-u");
  } else expect(escaped, result.stdout + result.stderr).toBe(true);
});

// Live captures from TAP's own auto mode (tap-3oox6, 2026-10-01): each seat was
// launched by `tap launch` on a private bus with `[harness.<name>] permissions =
// "auto"`, captured on its prompt and stopped with `tap out --kill`; nothing was
// approved. Plain capture, trailing whitespace removed.
// Cursor blocked-auto-review-real: cursor-agent 2026.09.28-64d2043, argv
// `cursor-agent --auto-review --workspace <repo> --trust`, 200x60,
// 2026-10-01T16:44:05Z, asked to read the first line of /etc/hosts; the
// auto-review classifier declined and raised Run this command?.
// Original capture SHA256: 71fb35ba1eb19a289961f5d08f65a596a7833fdd14de8f006302cdff6279d231
// agy trust-auto-real: Antigravity CLI 1.2.14, argv `agy` (no bypass flag),
// 200x60, 2026-10-01T16:48:34Z. Workspace trust for the untrusted scratch repo
// appeared at startup, before any request; the seat was stopped without a send.
// This is trust evidence, not the permission modal (blocked-real, 1.2.9).
// Original capture SHA256: 9b63d98969ec29b9fd23d3566d371430017db6546e95a7eaa008062e8dae19d0
// opencode blocked-auto-real: OpenCode 1.18.33, argv `opencode`, private
// XDG config (the shipped default: no `permission` key), GLM-5.3-Flash, 200x60,
// 2026-10-01T16:56:22Z. A bash `head -1 /etc/hosts` ran unasked (bash is
// allowed by default); a second ask to use the read tool raised the
// external-directory prompt.
// Original capture SHA256: 72e817b95410bdfa7c365c07e20e4cd1838f5027232df55ab660207a3cfd1d96
// codex trust-auto-real: codex-cli 0.159.3, argv `codex --approve-for-me`,
// 200x60, 2026-10-01T16:57:28Z; folder trust at startup, before any request.
// Original capture SHA256: d90dc305d63d31144a714d8fbb13910b9114d28448ca67aaf249f4577a3d9c4c
// claude trust-auto-real: Claude Code 2.1.286, argv `claude --permission-mode
// auto ...`, private CLAUDE_CONFIG_DIR, 200x60, 2026-10-01T16:57:48Z; workspace
// trust at startup, before any request. Live tap team read all three trust
// dialogs (agy, codex, claude) as unknown before this change.
// Original capture SHA256: 8c50fb6b167832071f179d317404dc41cea6b77e8f7921cc2e753a94bb24c1d1
// codex trust-auto-narrow-real: codex-cli 0.159.3, argv `codex --approve-for-me`,
// launched at 200x60 on a private bus, then `resize-window` to 24x50 (no key)
// and re-rendered, 2026-10-01T17:35:21Z. Codex wraps the dialog itself, so the
// key hint spans two rows (`enter continue · esc` / `quit`) even when joined.
// Original capture SHA256: c5d81779dedd33994c48574fb445e9c366e07bd0062cdfae4e55208dcab18eab
// claude trust-auto-narrow-real: Claude Code 2.1.286, argv `claude
// --permission-mode auto ...`, operator CLAUDE_CONFIG_DIR (a private one opens
// on onboarding, not trust), 200x60 resized to 30x50, 2026-10-01T17:36:03Z;
// the hint wraps to `Enter to confirm · Esc to` / `cancel`. Both narrow frames
// read unknown before tap-rlebf.1; the probe sent no key and changed no config.
// Original capture SHA256: d71c3012106a38d537b901c09d60acb07c7d0cb7fe3eb18f7392c83ea975b265
const autoCaptures: Array<[string, string]> = [["cursor", "blocked-auto-review-real"], ["agy", "trust-auto-real"], ["opencode", "blocked-auto-real"], ["codex", "trust-auto-real"], ["claude", "trust-auto-real"], ["codex", "trust-auto-narrow-real"], ["claude", "trust-auto-narrow-real"]];
for (const [harness, name] of autoCaptures) {
  const blocked = readFileSync(join(import.meta.dir, `fixtures/agent-state/${harness}/${name}.txt`), "utf8");
  test(`${harness} ${name} is blocked and every reader holds it`, () => {
    expect(detectAgentState(harness, blocked).agentState).toBe("blocked");
    expect(approvalPrompt(harness, blocked)).toBe(true);
    expect(classifyPane(blocked, harness, false)).toMatchObject({ kind: "no-band" });
    expect(composerInput(blocked, harness)).toEqual({ state: "blocked" });
    const io = { capture: () => ({ code: 0, stdout: blocked }) } as never;
    expect(pendingInputText(io, "%1", harness, blocked)).toEqual({ status: "blocked" });
    expect(sentinelSubmitDecision(blocked, harness, wire, true)).toEqual({ action: "withhold", reason: "dialog" });
  });
  for (const urgent of [0, 1]) for (const force of ["", "TAP_SUBMIT_FORCE_NO_PROMPT", "TAP_SUBMIT_NO_SPOOL"]) {
    test(`native ${harness} ${name} urgent=${urgent} ${force} sends no keys`, () => {
      const result = nativeApproval(harness, blocked, urgent, force);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("status=band_busy\n");
    });
  }
}

// Controls for the agy trust matcher: the dialog's words in scrollback above a
// live composer, or typed into it, are not a dialog; either selected row is.
test("agy trust words above a live composer or typed into it are not a dialog", () => {
  const trust = readFileSync(join(import.meta.dir, "fixtures/agent-state/agy/trust-auto-real.txt"), "utf8");
  const idle = readFileSync(join(import.meta.dir, "fixtures/agent-state/agy/idle-real.txt"), "utf8");
  const words = "Do you trust the contents of this project?\n> Yes, I trust this folder\n  No, exit\n  ↑/↓ Navigate · enter Confirm";
  expect(approvalPrompt("agy", trust.replace(/\s+Gemini 3\.8 Flash · medium$/, "") + "\n" + idle)).toBe(false);
  expect(approvalPrompt("agy", idle.replace(/^>$/m, `> ${words.split("\n").join(" ")}`))).toBe(false);
  expect(approvalPrompt("agy", idle.replace(/^>$/m, "> Do you trust the contents of this project? Yes, I trust this folder"))).toBe(false);
  const no = trust.replace("> Yes, I trust this folder", "  Yes, I trust this folder").replace("  No, exit", "> No, exit");
  expect(no).not.toBe(trust);
  expect(approvalPrompt("agy", no)).toBe(true);
  expect(approvalPrompt("agy", trust.replace(/\s+Gemini 3\.8 Flash · medium$/, ""))).toBe(true);
});

// Controls for the Claude and Codex trust matchers: the dialog left in
// scrollback above a live composer, or its words typed into one, are not a dialog.
for (const harness of ["claude", "codex"]) {
  test(`${harness} trust words above a live composer or typed into it are not a dialog`, () => {
    const trust = readFileSync(join(import.meta.dir, `fixtures/agent-state/${harness}/trust-auto-real.txt`), "utf8");
    const words = trust.split("\n").map(line => line.trim()).filter(Boolean).slice(-6).join(" ");
    expect(approvalPrompt(harness, trust)).toBe(true);
    expect(approvalPrompt(harness, trust + "\n" + idleFrame(harness, ""))).toBe(false);
    expect(approvalPrompt(harness, idleFrame(harness, words))).toBe(false);
    const swapped = harness === "claude"
      ? trust.replace(" ❯ No, exit", "   No, exit").replace("   Yes, I trust this folder", " ❯ Yes, I trust this folder")
      : trust.replace("› 1. Trust and continue", "  1. Trust and continue").replace("  2. Quit", "› 2. Quit");
    expect(swapped).not.toBe(trust);
    expect(approvalPrompt(harness, swapped)).toBe(true);
  });
}

// Review round 1: quoted dialog words in a human draft are not a
// dialog, even with no status footer below the composer or with the draft's
// last row quoting the key hint above a live composer border.
test("a Codex draft quoting the trust footer with no status row is not a dialog", () => {
  const draft = "› Please explain: Trust this folder? Trust and continue; enter continue · esc quit\n";
  expect(approvalPrompt("codex", draft)).toBe(false);
  const rows = "› Trust this folder?\n  1. Trust and continue\n  2. Quit\n  enter continue · esc quit\n";
  expect(approvalPrompt("codex", rows)).toBe(false);
});
test("a Claude draft quoting the trust footer is not a dialog", () => {
  const draft = "❯ Quick safety check: Yes, I trust this folder. Enter to confirm · Esc to cancel\n";
  expect(approvalPrompt("claude", draft)).toBe(false);
});
test("an agy multiline draft whose last row quotes a key hint is not a dialog", () => {
  const idle = readFileSync(join(import.meta.dir, "fixtures/agent-state/agy/idle-real.txt"), "utf8");
  for (const hint of ["↑/↓ Navigate · enter Confirm", "↑/↓ Navigate · tab Amend · ctrl+g edit/expand command"]) {
    const draft = idle.replace(/^>$/m, `> Do you trust the contents of this project?\n  Yes, I trust this folder\n  No, exit\n  ${hint}`);
    expect(draft).not.toBe(idle);
    expect(approvalPrompt("agy", draft)).toBe(false);
  }
});

// tap-rlebf.1: the wide trust captures re-wrapped at the narrow widths the
// live probe found unknown, plus Codex's hook-trust dialog. Both harnesses
// wrap at word boundaries and keep a row's indent (see the narrow-real
// captures), so this wraps the same way; splitting mid-word, as an early
// sketch did, is a shape neither harness paints. A key hint may break
// across rows; a draft quoting the wrapped hint still is not a dialog.
const wrapAt = (frame: string, width: number) => frame.split("\n").flatMap(row => {
  const indent = /^\s*(?:[›❯]\s)?/u.exec(row)![0].replace(/[›❯]/u, " ");
  const out: string[] = [];
  let line = "";
  for (const word of row.slice(indent.length).split(" ")) {
    const next = line ? `${line} ${word}` : `${out.length ? indent : row.slice(0, indent.length)}${word}`;
    if (line && next.length > width) { out.push(line); line = `${indent}${word}`; } else line = next;
  }
  out.push(line);
  return out;
}).join("\n");
for (const [harness, name, width] of [["claude", "trust-auto-real", 30], ["codex", "trust-auto-real", 24], ["codex", "hook-trust", 24]] as const) {
  test(`${harness} ${name} wrapped at ${width} columns is still a dialog`, () => {
    const frame = wrapAt(readFileSync(join(import.meta.dir, `fixtures/agent-state/${harness}/${name}.txt`), "utf8").replace(/[ \t]+$/gm, ""), width);
    expect(approvalPrompt(harness, frame)).toBe(true);
    expect(sentinelSubmitDecision(frame, harness, wire, true)).toEqual({ action: "withhold", reason: "dialog" });
  });
}
test("a draft quoting a wrapped trust hint is not a dialog", () => {
  expect(approvalPrompt("codex", "› Trust this folder?\n  1. Trust and continue\n  2. Quit\n  enter continue · esc\n  quit\n")).toBe(false);
  expect(approvalPrompt("claude", "❯ Quick safety check\n  No, exit\n  Yes, I trust this folder\n  Enter to confirm · Esc to\n  cancel\n")).toBe(false);
  for (const harness of ["claude", "codex"]) {
    const narrow = readFileSync(join(import.meta.dir, `fixtures/agent-state/${harness}/trust-auto-narrow-real.txt`), "utf8");
    expect(approvalPrompt(harness, narrow + "\n" + idleFrame(harness, ""))).toBe(false);
  }
});
