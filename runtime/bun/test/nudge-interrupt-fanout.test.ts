// `tap nudge --interrupt` fan-out (tap-pkh9c): parse rules, body builder,
// dry-run preview, and the per-seat outcome lines (interrupted vs queued vs
// UNVERIFIED vs failed). The courier seam itself is covered by
// nudge-interrupt-seam.test.ts; the single-peer form by its own file.

import { expect, test } from "bun:test";

import { TapError } from "../src/context";
import { interruptBody, interruptOutcomeLine, isFanoutArgv, parseFanoutArgs, runFanout, type FanoutEffects, type FanoutRow } from "../src/verbs/nudge-fanout";
import type { SendOutcome } from "../src/verbs/send";

function row(handle: string, harness = "codex", status = "active", delivery = "pane", statusReason = ""): FanoutRow {
  return { handle, harness, status, delivery, statusReason, instance: `${handle}-i1`, session: "", pane: "", observedPaneId: "", observedServerEpoch: "", attached: "0" } as FanoutRow;
}

const ROSTERS: Record<string, FanoutRow[]> = {
  "/a/registry.json": [row("me"), row("cx1"), row("cx2")],
};

const ESCAPED = { harness: "opencode", method: "keys", keys: ["Escape", "Escape"], cancellation: "unknown", tmux_confirmed: true, pane: "fixture" } as SendOutcome["interrupt"];

function effects(over: Partial<FanoutEffects> = {}, sendRc: () => SendOutcome = () => ({ rc: 0, disposition: "delivered" })) {
  const sent: Array<{ argv: string[]; opts: unknown }> = [];
  const out: string[] = [];
  const fx: FanoutEffects = {
    teams: () => [{ team: "a", registryLocation: "/a/registry.json" }],
    roster: loc => ({ rows: ROSTERS[loc]! }),
    send: (seat, argv, opts) => {
      sent.push({ argv, opts });
      const r = sendRc();
      return r;
    },
    confirm: () => true,
    refuseOperatorConflicts: () => {},
    recheckSender: () => {},
    confirmOperator: () => { throw new Error("unexpected operator prompt"); },
    interactive: () => false,
    out: text => { out.push(text); },
    err: () => {},
    ...over,
  };
  return { fx, sent, out };
}

const self = { team: "a", handle: "me" };
const args = (argv: string[]) => parseFanoutArgs(argv);

test("routing counts signals only in flag position: a valued flag consumes the next token", () => {
  expect(isFanoutArgv(["--team", "alpha"])).toBe(true);
  expect(isFanoutArgv(["--interrupt", "a/b", "-m", "--team"])).toBe(false);
  expect(isFanoutArgv(["--interrupt", "a/b", "--reason", "--harness"])).toBe(false);
  expect(isFanoutArgv(["-f", "--team"])).toBe(false);
});

test("interruptBody: default body and the --reason form", () => {
  expect(interruptBody("")).toBe("Nudge: continue what you were working on.");
  expect(interruptBody("Internet dropout")).toBe("Nudge: Internet dropout. Continue what you were working on.");
  // A reason that already ends a sentence is not doubled.
  expect(interruptBody("tests are green.")).toBe("Nudge: tests are green. Continue what you were working on.");
});

test("parse: -m/-f stay complete-body overrides; --reason refuses -m/-f and requires --interrupt", () => {
  expect(args(["--harness", "codex", "--interrupt"]).interrupt).toBe(true);
  expect(args(["--harness", "codex", "--interrupt", "--reason", "stuck"]).reason).toBe("stuck");
  expect(args(["--harness", "codex", "--interrupt", "-m", "my own words"]).message).toBe("my own words");
  const refusal = (argv: string[]) => { try { parseFanoutArgs(argv); return ""; } catch (e) { return (e as TapError).detail; } };
  expect(refusal(["--harness", "codex", "--reason", "stuck"])).toContain("--reason belongs to --interrupt");
  expect(refusal(["--harness", "codex", "--interrupt", "--reason", "stuck", "-m", "x"])).toContain("--reason cannot be combined with -m/-f");
  expect(refusal(["--harness", "codex", "--interrupt", "--reason", "stuck", "-f", "/tmp/b.md"])).toContain("--reason cannot be combined with -m/-f");
});

test("dry-run previews the FAMILY's interrupt, not a hardcoded one, and sends nothing", () => {
  const run = (harness: string) => {
    const { fx, sent, out } = effects();
    const rc = runFanout(args(["--harness", harness, "--interrupt", "--reason", "stuck onCI", "--dry-run"]), self, fx);
    return { rc, sent, text: out.join("") };
  };
  const opencode = run("opencode");
  expect(opencode.rc).toBe(0);
  expect(opencode.sent).toEqual([]);
  expect(opencode.text).toContain("interrupt: Escape Escape clears each selected pane");
  expect(opencode.text).toContain("note: Nudge: stuck onCI. Continue what you were working on.");
  // codex interrupts with one Escape; cursor with C-c; hermes with no keys at
  // all — a preview must never promise keys the courier will not send.
  expect(run("codex").text).toContain("interrupt: Escape clears each selected pane");
  expect(run("cursor").text).toContain("interrupt: C-c clears each selected pane");
  expect(run("hermes").text).toContain("interrupt: no keys — each selected pane is interrupted by the note submission itself");
});

test("an -m override replaces the body whole while --urgent and the recovery opt still ride", () => {
  const { fx, sent, out } = effects(undefined, () => ({ rc: 0, disposition: "delivered", interrupt: ESCAPED }));
  expect(runFanout(args(["--harness", "codex", "--interrupt", "-m", "resume the lane", "--yes"]), self, fx)).toBe(0);
  for (const call of sent) {
    expect(call.argv.join(" ")).toContain("resume the lane");
    expect(call.argv.join(" ")).not.toContain("Nudge:");
    expect(call.argv).toContain("--urgent");
    expect(call.opts).toEqual({ recoveryInterrupt: true });
  }
  expect(out.join("")).toContain("interrupted (delivered)");
});

test("interrupt delivery sends --urgent with recovery authority and reports interrupted", () => {
  const { fx, sent, out } = effects(undefined, () => ({ rc: 0, disposition: "delivered", interrupt: ESCAPED }));
  expect(runFanout(args(["--harness", "codex", "--interrupt", "--yes"]), self, fx)).toBe(0);
  expect(sent).toHaveLength(2); // me is skipped as self; cx1 + cx2 targeted
  for (const call of sent) {
    expect(call.argv).toContain("--urgent");
    expect(call.argv).toContain("-m");
    expect(call.argv.join(" ")).toContain("Nudge: continue what you were working on.");
    expect(call.opts).toEqual({ recoveryInterrupt: true });
  }
  expect(out.join("")).toContain("a/cx1  interrupted (delivered)");
  expect(out.join("")).toContain("a/cx2  interrupted (delivered)");
});

test("no interrupt fact: delivered says no keys were sent, never 'no interrupt needed'", () => {
  const { fx, out } = effects(undefined, () => ({ rc: 0, disposition: "delivered" }));
  expect(runFanout(args(["--harness", "codex", "--interrupt", "--yes"]), self, fx)).toBe(0);
  expect(out.join("")).toContain("a/cx1  delivered (no interrupt keys sent)");
});

test("a parked interrupt target: keys-then-park says interrupted; note queued, a keyless park says no keys sent", () => {
  let n = 0;
  const { fx, out } = effects(undefined, () => (++n === 1
    ? { rc: 0, disposition: "queued-spool", interrupt: ESCAPED }
    : { rc: 0, disposition: "queued-spool" }));
  expect(runFanout(args(["--harness", "codex", "--interrupt", "--yes"]), self, fx)).toBe(0);
  const text = out.join("");
  expect(text).toContain("a/cx1  interrupted; note queued (queued-spool)");
  expect(text).toContain("a/cx2  queued-spool (no interrupt keys sent)");
});

test("keys fell but the note went unverified: the line refuses both lies", () => {
  const line = interruptOutcomeLine("a/cx1", { rc: 5, disposition: "unverified", interrupt: ESCAPED } as SendOutcome);
  expect(line).toBe("a/cx1  interrupted; note UNVERIFIED (possible effect; do not re-nudge)");
  const placed = interruptOutcomeLine("a/cx1", { rc: 5, disposition: "placed", interrupt: ESCAPED } as SendOutcome);
  expect(placed).toBe("a/cx1  interrupted; note PLACED (possible effect; do not re-nudge)");
});

test("unverified and failed interrupt targets keep the incumbent exits", () => {
  let n = 0;
  const { fx, out } = effects(undefined, () => (++n === 1 ? { rc: 5, disposition: "unverified", interrupt: ESCAPED } : { rc: 1, disposition: "unverified" }));
  expect(runFanout(args(["--harness", "codex", "--interrupt", "--yes"]), self, fx)).toBe(5);
  const text = out.join("");
  expect(text).toContain("a/cx1  interrupted; note UNVERIFIED (possible effect; do not re-nudge)");
  expect(text).toContain("a/cx2  failed (rc=1");
});

test("a keyless unverified target keeps the incumbent UNVERIFIED line", () => {
  const { fx, out } = effects(undefined, () => ({ rc: 5, disposition: "unverified" }));
  expect(runFanout(args(["--harness", "codex", "--interrupt", "--yes"]), self, fx)).toBe(5);
  expect(out.join("")).toContain("a/cx1  UNVERIFIED (possible effect; pending id in the send receipt above; do not re-nudge this seat)");
});

test("the ordinary fan-out argv is unchanged: no --urgent, no recovery opts", () => {
  const { fx, sent } = effects();
  expect(runFanout(args(["--harness", "codex", "--yes"]), self, fx)).toBe(0);
  for (const call of sent) {
    expect(call.argv).not.toContain("--urgent");
    expect(call.opts).toBeUndefined();
  }
});

test("dry-run with no seat at a terminal previews the operator sender and asks nothing (tap-gridx)", () => {
  const { fx, sent, out } = effects();
  const rc = runFanout(args(["--harness", "codex", "--interrupt", "--dry-run"]), { team: "a", handle: "user", wouldPrompt: true }, fx);
  expect(rc).toBe(0);
  expect(sent).toEqual([]);
  expect(out.join("")).toContain("  sender: user (operator; would prompt)\n");
  // A seat sender previews no such line.
  const seat = effects();
  runFanout(args(["--harness", "codex", "--interrupt", "--dry-run"]), self, seat.fx);
  expect(seat.out.join("")).not.toContain("sender:");
});

test("the sender's bus is rechecked before every send, after every question (astra-ponytail, Codex)", () => {
  const order: string[] = [];
  const run = effects({ confirmOperator: () => { order.push("operator"); }, confirm: () => { order.push("scope"); return true; },
    interactive: () => true, recheckSender: () => { order.push("recheck"); } },
    () => { order.push("send"); return { rc: 0, disposition: "delivered", interrupt: ESCAPED }; });
  expect(runFanout(args(["--harness", "codex", "--interrupt", "--team", "*"]), { team: "a", handle: "user", wouldPrompt: true }, run.fx)).toBe(0);
  expect(order.slice(0, 4)).toEqual(["operator", "scope", "recheck", "send"]);
  const sends = order.filter(step => step === "send").length;
  expect(sends).toBeGreaterThan(1);
  expect(order.filter(step => step === "recheck").length).toBe(sends);
  // A named sender is rechecked too: its context rides the sends just the same.
  let named = 0;
  const seat = effects({ recheckSender: () => { named++; } });
  expect(runFanout(args(["--harness", "codex", "--yes"]), self, seat.fx)).toBe(0);
  expect(named).toBe(seat.sent.length);
  // A moved bus fails each remaining seat; nothing reaches send.
  const moved = effects({ confirmOperator: () => {}, confirm: () => true, interactive: () => true,
    recheckSender: () => { throw new TapError(1, "team_moved", "", "team 'a' changed while the operator was asked; nothing sent"); } });
  expect(runFanout(args(["--harness", "codex", "--interrupt", "--team", "*"]), { team: "a", handle: "user", wouldPrompt: true }, moved.fx)).toBe(1);
  expect(moved.sent).toEqual([]);
  expect(moved.out.join("")).toContain("failed (team_moved: team 'a' changed while the operator was asked; nothing sent)");
});

test("an operator dry run refuses a target team's legacy user seat exactly as the real run does (Codex)", () => {
  const legacy = () => { throw new TapError(1, "reserved_handle", "", "team 'a' still has a seat named 'user'"); };
  for (const flags of [["--dry-run"], ["--yes"]]) {
    const run = effects({ refuseOperatorConflicts: legacy });
    expect(() => runFanout(args(["--harness", "codex", "--interrupt", ...flags]), { team: "a", handle: "user", wouldPrompt: true }, run.fx))
      .toThrow("still has a seat named 'user'");
    expect(run.sent).toEqual([]);
  }
});

test("the operator is asked after the targets are on screen, and only when there is something to send", () => {
  const order: string[] = [];
  let checked: string[] = [];
  const asked = effects({ refuseOperatorConflicts: registries => { checked = registries; order.push("checked"); },
    confirmOperator: () => { order.push("asked"); }, out: text => { order.push(text); } },
    () => ({ rc: 0, disposition: "delivered", interrupt: ESCAPED }));
  expect(runFanout(args(["--harness", "codex", "--interrupt", "--yes"]), { team: "a", handle: "user", wouldPrompt: true }, asked.fx)).toBe(0);
  const askedAt = order.indexOf("asked");
  expect(askedAt).toBeGreaterThan(order.findIndex(line => line.includes("a/cx2  target")));
  expect(order.slice(askedAt).some(line => line.includes("interrupted (delivered)"))).toBe(true);
  // The operator check sees every registry the notes will land on (legacy `user` seats refuse there).
  expect(checked.length).toBeGreaterThan(0);
  expect(order.indexOf("checked")).toBeLessThan(askedAt);
  // Declined: nothing sent.
  const declined = effects({ confirmOperator: () => { throw new TapError(1, "cancelled", "", "not sent as the operator; nothing sent"); } });
  expect(() => runFanout(args(["--harness", "codex", "--interrupt", "--yes"]), { team: "a", handle: "user", wouldPrompt: true }, declined.fx)).toThrow("not sent as the operator");
  expect(declined.sent).toEqual([]);
  // No targets: never asked.
  const none = effects({ roster: () => ({ rows: [] }) });
  expect(runFanout(args(["--harness", "codex", "--interrupt"]), { team: "a", handle: "user", wouldPrompt: true }, none.fx)).toBe(0);
});
