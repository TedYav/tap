import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordPhase, phaseRows, pendingReprobe, unresolvedInjection, interruptNotice } from "./submit-phase";
import { queueExplanation, unverifiedSend } from "./queue-explanation";

test("interrupt intent survives a crash and never authorizes a zero-Enter re-probe", () => {
  const home = mkdtempSync(join(tmpdir(), "interrupt-phase-"));
  try {
    const row = { id: "msg", attempt: "a", recipient: "peer", enter_count: 0 };
    expect(interruptNotice(home, "msg")).toBeNull();
    recordPhase(home, { ...row, phase: "interrupt-intent", interrupt: {
      pane: "%1", harness: "codex", method: "keys", keys: ["Escape"], cancellation: "unknown", tmux_confirmed: false,
    } });
    expect(interruptNotice(home, "msg")).toContain("input acceptance unconfirmed");
    expect(interruptNotice(home, "msg")).toContain("marked urgent, so it may have interrupted you; that was TAP, not the user");
    expect(interruptNotice(home, "msg")).toContain("continue your previous work unless it says otherwise");
    recordPhase(home, { ...row, phase: "injected-text-confirmed" });
    recordPhase(home, { ...row, phase: "verify-result", result: "unverified" });
    mkdirSync(join(home, "spool"));
    writeFileSync(join(home, "spool", "msg.meta.json"), '{"reason":"pending-input"}');
    expect(pendingReprobe(home, "msg")).toBe(false);
    recordPhase(home, { ...row, phase: "interrupt-sent" });
    expect(interruptNotice(home, "msg")).toContain("Interrupt input sent");
    writeFileSync(join(home, "receipts", "msg.done"), '{"id":"msg"}');
    expect(interruptNotice(home, "msg")).not.toBeNull();
  } finally { rmSync(home, { recursive: true }); }
});

test("positive injection replaces schedule; intent is not Enter acceptance", () => {
  const home = mkdtempSync(join(tmpdir(), "phase-"));
  try {
    mkdirSync(join(home, "spool")); mkdirSync(join(home, "receipts"));
    writeFileSync(join(home, "spool", "msg.meta.json"), JSON.stringify({ reason: "window", reason_class: "window", next_probe_epoch: 1 }));
    writeFileSync(join(home, "receipts", "msg.attempted"), '{"effect":"possible"}');
    expect(queueExplanation(home, "msg")).toContain("recipient cooldown");
    const row = { id: "msg", attempt: "a", recipient: "peer", enter_count: 0 };
    recordPhase(home, { ...row, phase: "injected-text-confirmed" });
    recordPhase(home, { ...row, phase: "Enter-intent" });
    const explanation = queueExplanation(home, "msg");
    expect(explanation).toContain("injected; Enter unconfirmed (possible effect)");
    expect(explanation).toContain("tap nudge peer");
    expect(explanation).not.toMatch(/window|cooldown|next probe/);
    const direct = unverifiedSend(home, "msg", "sender", "peer", "canonical.md", true);
    expect(JSON.parse(direct.stdout)).toMatchObject({ status: "pending", phase: "injected-enter-unconfirmed", queue_explanation: explanation });
    expect(unverifiedSend(home, "msg", "sender", "peer", "canonical.md", false).stderr).toContain(explanation);
    expect(phaseRows(home, "msg").map(r => r.phase)).toEqual(["injected-text-confirmed", "Enter-intent"]);
    recordPhase(home, { ...row, phase: "Enter-sent" });
    expect(unresolvedInjection(home, "msg")).toBe(explanation);
    recordPhase(home, { ...row, phase: "verify-result", result: "unverified" });
    expect(unresolvedInjection(home, "msg")).toBe(explanation);
    recordPhase(home, { ...row, phase: "verify-result", result: "verified" });
    expect(unresolvedInjection(home, "msg")).toBeNull();
    recordPhase(home, { ...row, attempt: "b", phase: "injected-text-confirmed" });
    recordPhase(home, { ...row, phase: "verify-result", result: "verified" });
    expect(unresolvedInjection(home, "msg")).toBe(explanation);
  } finally { rmSync(home, { recursive: true }); }
});
test("zero-Enter transition evidence names only the courier-owned re-probe", () => {
  const home = mkdtempSync(join(tmpdir(), "phase-reprobe-"));
  try {
    mkdirSync(join(home, "spool"));
    recordPhase(home, { id: "msg", attempt: "a", recipient: "peer", enter_count: 0, phase: "injected-text-confirmed" });
    recordPhase(home, { id: "msg", attempt: "a", recipient: "peer", enter_count: 0, phase: "verify-result", result: "unverified" });
    writeFileSync(join(home, "spool", "msg.meta.json"), JSON.stringify({ id: "msg", reason: "pending-input" }));
    expect(pendingReprobe(home, "msg")).toBe(true);
    expect(unresolvedInjection(home, "msg")).toBe("injected; Enter pending re-probe.");
    recordPhase(home, { id: "msg", attempt: "a", recipient: "peer", enter_count: 0, phase: "Enter-intent" });
    expect(pendingReprobe(home, "msg")).toBe(false);
    expect(unresolvedInjection(home, "msg")).toContain("Enter unconfirmed (possible effect)");
  } finally { rmSync(home, { recursive: true }); }
});
test("torn rows do not invent proof; later receipt supersedes unfinished evidence", () => {
  const home = mkdtempSync(join(tmpdir(), "phase-"));
  try {
    recordPhase(home, { id: "msg", attempt: "a", recipient: "peer", enter_count: 0, phase: "injected-text-confirmed" });
    appendFileSync(join(home, "receipts", "msg.submit-phases.jsonl"), '{"phase":"verify-result","result":"verified"');
    expect(phaseRows(home, "msg")).toHaveLength(1);
    expect(unresolvedInjection(home, "msg")).not.toBeNull();
    writeFileSync(join(home, "receipts", "msg.read"), '{"id":"msg","by":"peer"}');
    expect(unresolvedInjection(home, "msg")).toBeNull();
    expect(unresolvedInjection(home, "missing")).toBeNull();
  } finally { rmSync(home, { recursive: true }); }
});

test('forced reads cannot erase positive queued phase evidence',()=>{
 const home=mkdtempSync(join(tmpdir(),'queued-phase-'));
 try {
  const row={id:'msg',attempt:'q',recipient:'peer',enter_count:1};
  recordPhase(home,{...row,phase:'injected-text-confirmed'});
  recordPhase(home,{...row,phase:'verify-result',result:'queued'});
  writeFileSync(join(home,'receipts','msg.read'),JSON.stringify({id:'msg',by:'observer',forced:true}));
  expect(unresolvedInjection(home,'msg')).toBe('queued in harness; recipient processing unconfirmed');
  writeFileSync(join(home,'receipts','msg.cancelled'),JSON.stringify({id:'msg',status:'cancelled'}));
  expect(unresolvedInjection(home,'msg')).toBeNull();
 } finally {rmSync(home,{recursive:true,force:true});}
});
