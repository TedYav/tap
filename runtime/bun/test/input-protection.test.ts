import { expect, test } from "bun:test";
import { textHasPasteCollapse } from "../src/pane/geometry";
import { advanceProtection, dueWaitCue, protectionUntil } from "../src/input-protection";
const obs = { paneId: "%1", serverEpoch: "epoch1", currentCommand: "claude" };
const busy = (text: string) => ({ state: "busy" as const, text });
test("ordinary 30s, urgent10s, multiple senders never extend the earlier deadline", () => {
  const a = advanceProtection(null, obs, busy("draft"), 1000, false, "alice")!;
  expect(protectionUntil(a)).toBe(31000);
  const b = advanceProtection(a, obs, busy("draft"), 5000, true, "bob")!;
  expect(protectionUntil(b)).toBe(15000);
  expect(advanceProtection(b, obs, busy("draft"), 14000, true, "carol")!.graceUntil).toBe(15000);
  expect(b.senders).toEqual(["alice", "bob"]);
});
test("WAIT anywhere grants one snooze, repeated WAIT/new urgent/deletion never extend it", () => {
  let a = advanceProtection(null, obs, busy("please WAIT here"), 1000)!;
  expect(protectionUntil(a)).toBe(121000);
  for (const text of ["WAIT WAIT", "deleted", "WAIT again"]) a = advanceProtection(a, obs, busy(text), 60000, true, "urgent")!;
  expect(protectionUntil(a)).toBe(121000);
  a = advanceProtection(a, obs, busy("WAIT"), 122000, true, "later")!;
  expect(protectionUntil(a)).toBe(121000);
  expect(a.consumed).toBe(true);
});
test("two stable bare samples release early; redraw is not submission; new draft earns fresh snooze", () => {
  let a = advanceProtection(null, obs, busy("WAIT"), 1000)!;
  a = advanceProtection(a, obs, { state: "ready" }, 2000)!;
  expect(a).not.toBeNull();
  a = advanceProtection(a, obs, busy("new typing between samples"), 2200)!;
  expect(a.bareSince).toBeNull();
  a = advanceProtection(a, obs, { state: "ready" }, 3000)!;
  expect(advanceProtection(a, obs, { state: "ready" }, 3250)).toBeNull();
  expect(advanceProtection(null, obs, busy("WAIT"), 4000)!.snoozeUntil).toBe(124000);
});
test("different pane generation cannot inherit a consumed snooze; wrapped WAIT is recognized", () => {
  const a = advanceProtection(null, obs, busy("WAIT"), 1000)!;
  const b = advanceProtection(a, { ...obs, serverEpoch: "epoch2" }, busy("W\nAIT"), 5000)!;
  expect(b.snoozeUntil).toBe(125000);
});

test("a later batch gets fresh grace without renewing the restored draft's consumed snooze", () => {
  const old = advanceProtection(null, obs, busy("WAIT"), 1000)!;
  const next = advanceProtection(old, obs, busy("WAIT still in same restored draft"), 200000, false, "new", true)!;
  expect(next.graceUntil).toBe(230000);
  expect(next.consumed).toBe(true); expect(next.snoozeUntil).toBe(0);
  const during = advanceProtection(old, obs, busy("WAIT"), 2000, true, "new", true)!;
  expect(during.snoozeUntil).toBe(121000);
});

test("withdrawn ordinary batch cannot hold a new send into a bare composer", () => {
  const old = advanceProtection(null, obs, busy("draft"), 1000)!;
  expect(advanceProtection(old, obs, {state: "ready"}, 2000, false, "new", true)).toBeNull();
  const snoozed = advanceProtection(old, obs, busy("WAIT"), 1500)!;
  expect(advanceProtection(snoozed, obs, {state: "ready"}, 2000, false, "new", true)?.consumed).toBe(true);
});

test("image chips require the harness marker, not ordinary bracketed text", () => {
  for (const command of ["claude", "codex", "cursor"]) {
    expect(textHasPasteCollapse(command, "[Image #1]")).toBe(true);
    for (const text of ["[image]", "[Image 1]", "[Image]"]) expect(textHasPasteCollapse(command, text)).toBe(false);
  }
  expect(textHasPasteCollapse("hermes", "[Image #1]")).toBe(false);
});

test("an urgent arrival shortens an existing grace while copy mode hides the draft", () => {
  const prior = advanceProtection(null, obs, busy("draft"), 1000, false, "alice")!;
  const next = advanceProtection(prior, obs, {state: "unobservable", reason: "copy-mode"}, 2000, true, "bob")!;
  expect(next.graceUntil).toBe(12000);
  expect(next.senders).toEqual(["alice", "bob"]);
  expect(advanceProtection(null, obs, {state: "unobservable", reason: "copy-mode"}, 2000, true, "bob")).toBeNull();
});

test("cue schedule: blue at latch, green at -30s, red at -10s, nothing at or past the deadline, never duplicated", () => {
  const a = advanceProtection(null, obs, busy("please WAIT here"), 1000)!;
  expect(a.consumed).toBe(true);
  expect(dueWaitCue(a, 1000)).toBe("blue");
  const blue = { ...a, cueEmitted: "blue" as const };
  expect(dueWaitCue(blue, 60_000)).toBeNull();
  expect(dueWaitCue(blue, 121_000 - 30_000)).toBe("green");
  const green = { ...blue, cueEmitted: "green" as const };
  expect(dueWaitCue(green, 121_000 - 20_000)).toBeNull();
  expect(dueWaitCue(green, 121_000 - 10_000)).toBe("red");
  const red = { ...green, cueEmitted: "red" as const };
  expect(dueWaitCue(red, 121_000 - 1_000)).toBeNull();
  expect(dueWaitCue(red, 121_000)).toBeNull();
  expect(dueWaitCue({ ...red, snoozeUntil: 0 }, 200_000)).toBeNull();
  // A skipped window jumps straight to red, never green after blue.
  expect(dueWaitCue(blue, 121_000 - 5_000)).toBe("red");
  // No live snooze, no cue — even with consumed still true (the newBatch leftover).
  expect(dueWaitCue({ ...blue, snoozeUntil: 0 }, 200_000)).toBeNull();
  expect(dueWaitCue({ ...a, snoozeUntil: 0 }, 200_000)).toBeNull();
  // At the deadline nothing is due, so no late blue.
  expect(dueWaitCue(a, 121_000)).toBeNull();
});

test("a second WAIT never re-arms the blue cue inside the same snooze", () => {
  const a = advanceProtection(null, obs, busy("please WAIT here"), 1000)!;
  const again = advanceProtection({ ...a, cueEmitted: "blue" }, obs, busy("WAIT once more"), 60_000)!;
  expect(again.snoozeUntil).toBe(121_000);
  expect(again.cueEmitted).toBe("blue");
  expect(dueWaitCue(again, 60_000)).toBeNull();
});

test("no cue is due before WAIT latches; a fresh record earns its own blue", () => {
  const g = advanceProtection(null, obs, busy("plain draft"), 1000)!;
  expect(g.consumed).toBe(false);
  expect(dueWaitCue(g, 1000)).toBeNull();
  expect(dueWaitCue(g, 21_000)).toBeNull();
  const fresh = advanceProtection(null, obs, busy("WAIT"), 4_000)!;
  expect(dueWaitCue(fresh, 4_000)).toBe("blue");
});
