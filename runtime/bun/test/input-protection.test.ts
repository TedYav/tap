import { expect, test } from "bun:test";
import { classifyPane } from "../src/pane-state";
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

test("STOP holds through empty composers, side views, new and urgent mail without renewing", () => {
  let state = advanceProtection(null, obs, busy("  STOP  "), 1000, false, "alice")!;
  expect(protectionUntil(state)).toBe(601000);
  state = advanceProtection(state, obs, { state: "ready" }, 2000)!;
  state = advanceProtection(state, obs, { state: "ready" }, 10000)!;
  expect(protectionUntil(state)).toBe(601000);
  state = advanceProtection(state, obs, { state: "unobservable", reason: "side-view" }, 20000)!;
  state = advanceProtection(state, obs, busy("side question"), 30000, true, "bob", true)!;
  state = advanceProtection(state, obs, busy("STOP"), 40000, true, "carol")!;
  expect(protectionUntil(state)).toBe(601000);
  expect(state.senders).toEqual(["alice", "bob", "carol"]);
});

test("only exact uppercase STOP and START control the hold", () => {
  for (const text of ["STOPPED", "please STOP", "stop", "S T O P"]) {
    expect(protectionUntil(advanceProtection(null, obs, busy(text), 1000)!)).toBe(31000);
  }
  const stopped = advanceProtection(null, obs, busy("STOP"), 1000)!;
  for (const text of ["START HERE", "RESTART", "start", "S T A R T"]) {
    expect(protectionUntil(advanceProtection(stopped, obs, busy(text), 2000)!)).toBe(601000);
  }
  const released = advanceProtection(stopped, obs, busy(" START \n"), 2000)!;
  expect(protectionUntil(released)).toBeLessThanOrEqual(2000);
  expect(protectionUntil(advanceProtection(released, obs, busy("STOP"), 3000)!)).toBeLessThanOrEqual(3000);
});

test("STOP expiry cannot rearm from the same word or new mail; next draft may hold", () => {
  const stopped = advanceProtection(null, obs, busy("STOP"), 1000)!;
  const expired = advanceProtection(stopped, obs, busy("STOP"), 602000, true, "later", true)!;
  expect(expired.stopUntil).toBe(601000);
  expect(protectionUntil(expired)).toBe(612000);
  const bare = advanceProtection(expired, obs, { state: "ready" }, 603000)!;
  expect(advanceProtection(bare, obs, { state: "ready" }, 603250)).toBeNull();
  expect(protectionUntil(advanceProtection(null, obs, busy("STOP"), 604000)!)).toBe(1204000);
});

test("a Claude viewport whose visible tail is START cannot release hidden composer text", () => {
  const frame = "────────────────────────────────────────\n❯ \n  \n  START\n────────────────────────────────────────\n";
  const band = classifyPane(frame, "claude", false, 16);
  if (band.kind !== "draft") throw new Error("fixture must contain a visible draft tail");
  const stopped = advanceProtection(null, obs, busy("STOP"), 1000)!;
  const visibleTail = { ...band, state: "busy" as const };
  expect(protectionUntil(advanceProtection(stopped, obs, visibleTail, 2000)!)).toBe(601000);
});

test("a new batch after STOP expiry receives its ordinary draft grace", () => {
  const stopped = advanceProtection(null, obs, busy("STOP"), 1000)!;
  const fresh = advanceProtection(stopped, obs, busy("hello"), 602000, false, "new", true)!;
  expect(fresh.stopUntil).toBe(601000);
  expect(protectionUntil(fresh)).toBe(632000);
});

// Hermes rides `/queue ` in front of the wire the courier types, so TAP's own staged
// text opens with the prefix there. It is not a human draft: no grace, no WAIT cues.
test("TAP's own text behind the Hermes queue prefix is not a human draft", () => {
  const wire = "[[TAP v0.23 note sender-20260101T010101Z-0123456789ab]]";
  const hermes = { paneId: "%1", serverEpoch: "epoch1", currentCommand: "hermes" };
  expect(advanceProtection(null, hermes, busy(`/queue ${wire}`), 0)).toBeNull();
  expect(advanceProtection(null, hermes, busy("  /queue   [[TAP v0.23 note truncated"), 0)).toBeNull();
  // The seat's harness decides the prefix, not the pane's foreground command.
  const wrapped = { paneId: "%1", serverEpoch: "epoch1", currentCommand: "python3" };
  expect(advanceProtection(null, wrapped, busy(`/queue ${wire}`), 0, false, "", false, [], "hermes")).toBeNull();
  // A person's own queued line is still a draft, and its WAIT is still read.
  expect(advanceProtection(null, hermes, busy("/queue fix the parser first"), 0)).toMatchObject({ graceUntil: 30_000, consumed: false });
  expect(advanceProtection(null, hermes, busy("/queue WAIT fix the parser first"), 0)).toMatchObject({ consumed: true, snoozeUntil: 120_000 });
  // On a harness with no queue prefix, the same text is somebody's draft.
  expect(advanceProtection(null, obs, busy(`/queue ${wire}`), 0)).toMatchObject({ graceUntil: 30_000 });
});
