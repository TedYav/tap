import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { oldStoreRefusalText } from "../src/register-authority";
import { join } from "node:path";
import { snapshotTmux, type LifecycleTmux } from "../src/lifecycle-target";
import { saveRegistry, type RegistryDoc, type Seat } from "../src/registry";
import {
  outcomeWord,
  runStopTx,
  type CrewCollected,
  type StopTxEffects,
  type StopTxSeatTuple,
} from "../src/team/stop-tx";

let seq = 0;
function work(): string {
  seq += 1;
  const dir = join(tmpdir(), `tap-stop-tx-${seq}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function seatRow(over: Record<string, unknown> = {}): Seat {
  return {
    handle: "bob",
    pane: "pane-bob",
    pane_id: "%5",
    session: "alpha/bob",
    server_epoch: "7",
    status: "active",
    status_reason: "",
    crew: false,
    delivery: "pane",
    exited_at: "",
    wake_url: "",
    pane_current_command: "",
    ...over,
  };
}

function tuple(over: Partial<StopTxSeatTuple> = {}): StopTxSeatTuple {
  return { handle: "bob", paneId: "%5", rowSession: "alpha/bob", rowEpoch: "7", expected: "alpha/bob", ...over };
}

function effects(over: Partial<StopTxEffects> = {}): StopTxEffects {
  return {
    tmux: over.tmux ?? snapshotTmux({ panes: [{ id: "%5", session: "alpha/bob" }] }),
    killSession: over.killSession ?? (() => {}),
    hasSession: over.hasSession ?? (() => false),
  };
}

function setup(dir: string, seats: Record<string, Seat>, teamName = "alpha"): string {
  const path = join(dir, "registry.json");
  const doc: RegistryDoc = { schema: "0.20", team: { name: teamName }, seats };
  saveRegistry(path, doc);
  return path;
}

function run(dir: string, path: string, over: Partial<Parameters<typeof runStopTx>[0]> = {}) {
  return runStopTx({
    session: "alpha/bob",
    mode: "full",
    policy: "suspend",
    seats: [tuple()],
    selection: { mode: "", set: [] },
    selfHandle: "",
    runId: "run1",
    selfRowsPath: "",
    registryPath: path,
    eventLog: join(dir, "events.log"),
    team: "alpha",
    verbShort: "down",
    effects: effects(),
    ...over,
  });
}

test("interactive approval rejects a same-handle replacement before stop effects", () => {
  const dir = work();
  try {
    const path = setup(dir, { bob: seatRow({ instance: "replacement" }) });
    const before = readFileSync(path, "utf8");
    let kills = 0;
    const result = run(dir, path, { approvedInstances: new Map([["bob", "approved"]]),
      effects: effects({ killSession: () => { kills++; } }) });
    expect(result.outcome).toEqual({ kind: "refused", detail: "bob was replaced after interactive selection" });
    expect(kills).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a crew replaced after consent is refused by the locked stop transaction", () => {
  const dir = work();
  try {
    const path = setup(dir, { bob: seatRow({ instance: "parent" }), child: seatRow({ handle: "child", crew: true,
      instance: "replacement", pane_id: "%6" }) });
    const before = readFileSync(path, "utf8");
    let kills = 0;
    const result = run(dir, path, { approvedCrewAtConsent: new Map([["child", { instance: "approved", session: "alpha/bob" }]]),
      effects: effects({ killSession: () => { kills++; } }) });
    expect(result.outcome).toEqual({ kind: "refused", detail: "child was replaced after interactive crew approval" });
    expect(kills).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("selected parent cannot stop an unbound crew child", () => {
  const dir = work();
  try {
    const path = setup(dir, { bob: seatRow({ instance: "parent" }), child: seatRow({ handle: "child", crew: true,
      instance: "child", pane_id: "%6" }) });
    let kills = 0;
    const result = run(dir, path, { seats: [tuple(), tuple({ handle: "child", paneId: "%6" })],
      selection: { mode: "--only", set: ["bob", "child"] }, approvedInstances: new Map([["bob", "parent"]]),
      approvedParentLifetimes: new Map([["bob", { team: "alpha", owner: "bob", instance: "parent", pane: "%5",
        session: "alpha/bob", serverSocket: "/tmp/tmux", serverEpoch: "7", process: { pid: "1", start: "1", boot: "boot" }, family: "claude" }]]),
      effects: effects({ killSession: () => { kills++; } }) });
    expect(result.outcome).toEqual({ kind: "refused", detail: "child has no approved crew lifetime binding" });
    expect(kills).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function word(dir: string, path: string, over: Partial<Parameters<typeof runStopTx>[0]> = {}): string {
  return outcomeWord(run(dir, path, over));
}

function seatEntries(path: string): Record<string, Seat> {
  return JSON.parse(readFileSync(path, "utf8")).seats as Record<string, Seat>;
}

function eventLines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l.includes("action=")) : [];
}

test("empty seat list refuses without touching the registry (tap-team-stop.sh L32, L64-66)", () => {
  const dir = work();
  const path = setup(dir, { bob: seatRow() });
  expect(word(dir, path, { seats: [] })).toBe("refused:no seat authorizes it");
  const doc = JSON.parse(readFileSync(path, "utf8")) as RegistryDoc;
  expect((doc.seats as Record<string, Seat>).bob!.status).toBe("active");
});

test("full mode stamps suspended rows, strips stale bindings, deletes crew, and reports crew_collected (L779-801, L901)", () => {
  const dir = work();
  const path = setup(dir, {
    bob: seatRow({ status_reason: "registered", wake_url: "http://x", pane_current_command: "zsh", exited_at: "yesterday" }),
    w1: seatRow({ handle: "w1", crew: true, pane: "pane-w1", pane_id: "%6" }),
  });
  const result = run(dir, path, { seats: [tuple(), tuple({ handle: "w1", paneId: "%6", expected: "alpha/bob" })], effects: effects({ tmux: snapshotTmux({ panes: [
    { id: "%5", session: "alpha/bob" },
    { id: "%6", session: "alpha/bob" },
  ] }) }) });
  expect(outcomeWord(result)).toBe("killed crew_collected=w1\x1fpane-w1\x1fbob");
  expect(result.adopted).toEqual([]);
  expect(result.retained).toEqual([]);
  expect(result.unrecorded).toEqual([]);
  const seats = seatEntries(path);
  expect(seats.bob).toEqual({
    handle: "bob",
    session: "alpha/bob",
    server_epoch: "7",
    status: "suspended",
    status_reason: "session_stopped",
    crew: false,
    delivery: "pane",
  });
  expect(seats.w1).toBeUndefined();
});

test("full mode keeps registry bytes python-formatted: indent 2, sorted keys, trailing newline (registry.pyJson)", () => {
  const dir = work();
  const path = setup(dir, { bob: seatRow({ handle: "bob", session: "alpha/bob", wake_url: "http://x", exited_at: "t0" }) });
  expect(word(dir, path)).toBe("killed");
  expect(readFileSync(path, "utf8")).toBe(
    `{\n  "schema": "0.20",\n  "seats": {\n    "bob": {\n      "crew": false,\n      "delivery": "pane",\n      "handle": "bob",\n      "server_epoch": "7",\n      "session": "alpha/bob",\n      "status": "suspended",\n      "status_reason": "session_stopped"\n    }\n  },\n  "team": {\n    "name": "alpha"\n  }\n}\n`,
  );
});

test("full mode kill failure restores the complete captured pre-image, bindings included (L880-893; astra amendment)", () => {
  const dir = work();
  const path = setup(dir, { bob: seatRow({ status_reason: "registered", wake_url: "http://x" }) });
  const before = readFileSync(path, "utf8");
  expect(word(dir, path, { effects: effects({ hasSession: () => true }) })).toBe(
    "kill-failed",
  );
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("re-authorization under the lock refuses a vanished row, a rebind, and a lost warrant (L176-215)", () => {
  const dir = work();
  const path = setup(dir, { bob: seatRow() });
  expect(word(dir, path, { seats: [tuple({ handle: "carol" })] })).toBe("refused:carol missing before kill");
  expect(word(dir, path, { seats: [tuple({ paneId: "%99" })] })).toBe("refused:bob pane identity changed before kill");
  expect(word(dir, path, { effects: effects({ tmux: snapshotTmux({ panes: [{ id: "%5", session: "other" }] }) }) })).toBe(
    "refused:bob no longer authorizes it",
  );
});

test("a sole plan-time authorizer flipping pane-less refuses; poll rows are skipped, not silent passes (L181-189, L210-215)", () => {
  const dir = work();
  const path = setup(dir, { bob: seatRow({ delivery: "poll" }) });
  expect(word(dir, path)).toBe(
    "refused:no live seat authorizes 'alpha/bob' any more (every plan-time authorizer is now pane-less)",
  );
  const path2 = setup(dir, {
    bob: seatRow({ delivery: "poll" }),
    carol: seatRow({ handle: "carol", pane_id: "%8", session: "alpha/bob" }),
  });
  expect(
    word(dir, path2, { seats: [tuple(), tuple({ handle: "carol", paneId: "%8", expected: "alpha/bob" })] }),
  ).toBe("killed");
  const seats = seatEntries(path2);
  expect(seats.bob!.delivery).toBe("poll");
  expect(seats.carol!.status).toBe("suspended");
});

test("unreadable registries refuse with the incumbent shapes (L126-150)", () => {
  const dir = work();
  const missing = join(dir, "absent.json");
  expect(word(dir, missing)).toBe("refused:registry unreadable (missing)");
  const corrupt = join(dir, "corrupt.json");
  writeFileSync(corrupt, "{not json");
  expect(word(dir, corrupt)).toContain("refused:registry unreadable (");
  const scalar = join(dir, "scalar.json");
  writeFileSync(scalar, "[1]");
  // The incumbent child crashes on a list/scalar document and the Bash caller
  // normalizes the missing word to this parent-visible refusal.
  expect(word(dir, scalar)).toBe("refused:transaction refused");
});

test("an agents-axis registry is refused untouched, never rewritten beside a seats map", () => {
  const dir = work();
  const axis = join(dir, "axis.json");
  for (const text of ['{"agents": []}', '{"seats": {"bob": {}}, "agents": {"old": {}}}']) {
    writeFileSync(axis, text);
    expect(word(dir, axis)).toBe(`refused:${oldStoreRefusalText(axis, "agents_axis")}`);
    expect(readFileSync(axis, "utf8")).toBe(text);
  }
  writeFileSync(axis, '{"team": {"name": "t"}}');
  expect(word(dir, axis)).toBe("refused:registry has no seats map; it was left untouched");
  expect(readFileSync(axis, "utf8")).toBe('{"team": {"name": "t"}}');
});

test("a late co-tenant that passes the live gate is adopted, stopped, and returned (L264-368)", () => {
  const dir = work();
  const path = setup(dir, {
    bob: seatRow(),
    henry: seatRow({ handle: "henry", pane: "pane-henry", pane_id: "%9" }),
  });
  const result = run(dir, path, { effects: effects({ tmux: snapshotTmux({ panes: [
    { id: "%5", session: "alpha/bob" },
    { id: "%9", session: "alpha/bob" },
  ] }) }) });
  expect(outcomeWord(result)).toBe("killed");
  expect(result.adopted).toEqual(["henry"]);
  expect(result.retained).toEqual(["henry"]);
  const seats = seatEntries(path);
  expect(seats.henry!.status).toBe("suspended");
  expect(seats.henry!.status_reason).toBe("session_stopped");
  expect(seats.henry!.pane_id).toBeUndefined();
});

test("a late co-tenant named by --only is spared, not killed, and blocks the session (L301-319)", () => {
  const dir = work();
  const path = setup(dir, {
    bob: seatRow(),
    carol: seatRow({ handle: "carol", pane_id: "%8" }),
  });
  expect(
    word(dir, path, {
      selection: { mode: "--only", set: ["bob"] },
      effects: effects({ tmux: snapshotTmux({ panes: [
        { id: "%5", session: "alpha/bob" },
        { id: "%8", session: "alpha/bob" },
      ] }) }),
    }),
  ).toBe(
    "spared:carol joined session 'alpha/bob' after planning and is spared by --only; killing it would stop a seat the selection excluded",
  );
  expect(seatEntries(path).carol!.status).toBe("active");
});

test("a late row whose pane moved away is not adopted (L320-341)", () => {
  const dir = work();
  const path = setup(dir, {
    bob: seatRow(),
    moved: seatRow({ handle: "moved", pane_id: "%9", session: "alpha/bob" }),
  });
  const result = run(dir, path, { effects: effects({ tmux: snapshotTmux({ panes: [
    { id: "%5", session: "alpha/bob" },
    { id: "%9", session: "elsewhere" },
  ] }) }) });
  expect(outcomeWord(result)).toBe("killed");
  expect(result.adopted).toEqual([]);
});

test("cotenant_only authorizes without re-authoring stripped rows and mutates nothing (L152-157, L453-455)", () => {
  const dir = work();
  const path = setup(dir, { bob: seatRow({ pane_id: "", pane: "", status: "suspended", status_reason: "session_stopped" }) });
  const before = readFileSync(path, "utf8");
  expect(word(dir, path, { mode: "cotenant_only", effects: effects({ tmux: snapshotTmux({ panes: [] }) }) })).toBe("authorized");
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("authorize_only runs the same gates and stops before any mutation (L740-754)", () => {
  const dir = work();
  const path = setup(dir, { bob: seatRow() });
  const before = readFileSync(path, "utf8");
  expect(word(dir, path, { mode: "authorize_only" })).toBe("authorized");
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("kill_only kills and refuses a survivor without stamping anything (L756-771)", () => {
  const dir = work();
  const path = setup(dir, { bob: seatRow() });
  const before = readFileSync(path, "utf8");
  expect(word(dir, path, { mode: "kill_only" })).toBe("killed");
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(word(dir, path, { mode: "kill_only", effects: effects({ hasSession: () => true }) })).toBe(
    "kill-failed",
  );
});

test("cotenant_kill stamps adopted and re-activated rows, then kills; clear deletes rows (L457-569)", () => {
  const dir = work();
  const path = setup(dir, {
    bob: seatRow({ status: "suspended", status_reason: "session_stopped", pane_id: "", pane: "" }),
    henry: seatRow({ handle: "henry", pane_id: "%9" }),
  });
  const result = run(dir, path, {
    mode: "cotenant_kill",
    seats: [tuple({ paneId: "" })],
    effects: effects({ tmux: snapshotTmux({ panes: [{ id: "%9", session: "alpha/bob" }] }) }),
  });
  expect(outcomeWord(result)).toBe("killed");
  expect(result.adopted).toEqual(["henry"]);
  const seats = seatEntries(path);
  expect(seats.henry!.status).toBe("suspended");
  expect(seats.bob!.status).toBe("suspended");
  const events = eventLines(join(dir, "events.log"));
  expect(events).toEqual([]);
});

test("cotenant_kill under clear with a re-activated row stamps only same-session rows and publishes the kill-requested event (L495-522)", () => {
  const dir = work();
  const path = setup(dir, {
    bob: seatRow({ status: "active" }),
    other: seatRow({ handle: "other", pane_id: "%7", session: "unrelated" }),
  });
  const result = run(dir, path, {
    mode: "cotenant_kill",
    policy: "clear",
    effects: effects({ tmux: snapshotTmux({ panes: [{ id: "%5", session: "alpha/bob" }] }) }),
  });
  expect(outcomeWord(result)).toBe("killed");
  const seats = seatEntries(path);
  expect(seats.bob).toBeUndefined();
  expect(seats.other!.status).toBe("active");
  const events = eventLines(join(dir, "events.log"));
  expect(events.length).toBe(0);
});

test("cotenant_kill writes kill-requested for a PLAN-TIME crew stamp target before mutating (L515-522)", () => {
  const dir = work();
  const path = setup(dir, {
    bob: seatRow(),
    w1: seatRow({ handle: "w1", crew: true, pane: "pane-w1", pane_id: "%6" }),
  });
  const result = run(dir, path, {
    mode: "cotenant_kill",
    seats: [tuple(), tuple({ handle: "w1", paneId: "%6", expected: "alpha/bob" })],
    effects: effects({ tmux: snapshotTmux({ panes: [
      { id: "%5", session: "alpha/bob" },
      { id: "%6", session: "alpha/bob" },
    ] }) }),
  });
  expect(outcomeWord(result)).toBe("killed");
  const seats = seatEntries(path);
  expect(seats.w1).toBeUndefined();
  const events = eventLines(join(dir, "events.log"));
  expect(events.length).toBe(1);
  expect(events[0]).toContain("action=kill-requested");
  expect(events[0]).toContain("detail=crew=w1");
});

test("an adopted late crew row is collected under cotenant_kill with the kill-requested event (L515-545)", () => {
  const dir = work();
  const path = setup(dir, {
    bob: seatRow(),
    w1: seatRow({ handle: "w1", crew: true, pane: "pane-w1", pane_id: "%6" }),
  });
  const result = run(dir, path, {
    mode: "cotenant_kill",
    effects: effects({ tmux: snapshotTmux({ panes: [
      { id: "%5", session: "alpha/bob" },
      { id: "%6", session: "alpha/bob" },
    ] }) }),
  });
  expect(outcomeWord(result)).toBe("killed");
  const seats = seatEntries(path);
  expect(seats.w1).toBeUndefined();
  expect(seats.bob!.status).toBe("suspended");
  expect(result.retained).toEqual(["w1"]);
  expect(result.adopted).toEqual([]);
  const events = eventLines(join(dir, "events.log"));
  expect(events.length).toBe(1);
  expect(events[0]).toContain("action=kill-requested");
  expect(events[0]).toContain("actor=team-down");
  expect(events[0]).toContain("detail=crew=w1");
});

test("a failed kill-requested append refuses before crew mutation (L517-522, L855-861)", () => {
  const dir = work();
  const path = setup(dir, {
    bob: seatRow(),
    w1: seatRow({ handle: "w1", crew: true, pane: "pane-w1", pane_id: "%6" }),
  });
  const blockedLog = join(dir, "events-dir");
  mkdirSync(blockedLog);
  expect(
    word(dir, path, {
      mode: "cotenant_kill",
      eventLog: blockedLog,
      effects: effects({ tmux: snapshotTmux({ panes: [
        { id: "%5", session: "alpha/bob" },
        { id: "%6", session: "alpha/bob" },
      ] }) }),
    }),
  ).toBe("refused:kill-requested append failed before crew mutation");
});

test("cotenant_kill kill failure rolls back stamped rows under the ownership checks (L628-715)", () => {
  const dir = work();
  const path = setup(dir, { bob: seatRow() });
  const result = run(dir, path, {
    mode: "cotenant_kill",
    effects: effects({ hasSession: () => true }),
  });
  expect(outcomeWord(result)).toBe("kill-failed");
  const seats = seatEntries(path);
  expect(seats.bob!.status).toBe("active");
  expect(seats.bob!.pane_id).toBe("%5");
});

test("rollback leaves a re-registered row alone (compare/no-overwrite ownership, L693-695)", () => {
  const dir = work();
  const path = setup(dir, { bob: seatRow() });
  const result = run(dir, path, {
    mode: "cotenant_kill",
    effects: effects({
      killSession: () => {
        saveRegistry(path, { schema: "0.20", team: { name: "alpha" }, seats: {
          bob: seatRow({ status: "active", pane_id: "%77", pane: "replacement", instance: "bob#2", status_reason: "re-registered" }),
        } });
      },
      hasSession: () => true,
    }),
  });
  expect(outcomeWord(result)).toBe("kill-failed");
  const row = seatEntries(path).bob!;
  expect(row.status).toBe("active");
  expect(row.pane_id).toBe("%77");
  expect(row.pane).toBe("replacement");
  expect(row.instance).toBe("bob#2");
  expect(row.status_reason).toBe("re-registered");
});

test("a NaN seat value is not a row: pyIsDict refuses it like the incumbent's isinstance check (review round 2)", () => {
  const dir = work();
  const path = join(dir, "nan-seat.json");
  const bytes = '{"schema": "0.20", "seats": {"bob": NaN}, "team": {"name": "alpha"}}';
  writeFileSync(path, bytes);
  expect(word(dir, path)).toBe("refused:bob missing before kill");
  expect(readFileSync(path, "utf8")).toBe(bytes);
});

test("rollback meets a scalar NaN registry: discloses not-applied and preserves the scalar bytes (review round 2)", () => {
  const dir = work();
  const path = setup(dir, {
    bob: seatRow(),
    henry: seatRow({ handle: "henry", pane: "pane-henry", pane_id: "%9" }),
  });
  const result = run(dir, path, {
    mode: "cotenant_kill",
    effects: effects({
      tmux: snapshotTmux({ panes: [
        { id: "%5", session: "alpha/bob" },
        { id: "%9", session: "alpha/bob" },
      ] }),
      killSession: () => writeFileSync(path, "NaN"),
      hasSession: () => true,
    }),
  });
  expect(outcomeWord(result)).toBe("kill-failed");
  const disclosure = result.warnings.join("\n");
  expect(disclosure).toContain(
    "rollback of the adopted rows was NOT applied: the registry is present but unreadable (registry is not a JSON object)",
  );
  expect(disclosure).toContain("henry");
  expect(readFileSync(path, "utf8")).toBe("NaN");
});

test("the caller's tuple array is never mutated; a later mode cannot inherit phantom plan-time warrant (review C1)", () => {
  const dir = work();
  const path = setup(dir, {
    bob: seatRow(),
    henry: seatRow({ handle: "henry", pane: "pane-henry", pane_id: "%9" }),
  });
  const callerTuples = [tuple()];
  const frozen = JSON.stringify(callerTuples);
  const r1 = run(dir, path, {
    mode: "authorize_only",
    seats: callerTuples,
    effects: effects({ tmux: snapshotTmux({ panes: [
      { id: "%5", session: "alpha/bob" },
      { id: "%9", session: "alpha/bob" },
    ] }) }),
  });
  expect(outcomeWord(r1)).toBe("authorized");
  expect(r1.adopted).toEqual(["henry"]);
  expect(JSON.stringify(callerTuples)).toBe(frozen);
  const r2 = run(dir, path, {
    mode: "cotenant_kill",
    seats: callerTuples,
    effects: effects({
      tmux: snapshotTmux({ panes: [
        { id: "%5", session: "alpha/bob" },
        { id: "%9", session: "elsewhere" },
      ] }),
      hasSession: () => true,
    }),
  });
  expect(outcomeWord(r2)).toBe("kill-failed");
  expect(r2.adopted).toEqual([]);
  const henry = seatEntries(path).henry!;
  expect(henry.status).toBe("active");
  expect(henry.session).toBe("alpha/bob");
  expect(henry.pane_id).toBe("%9");
  expect(JSON.stringify(callerTuples)).toBe(frozen);
});

test("the stop codec is lossless and never touches forwarding state (review C2)", () => {
  const dir = work();
  const path = join(dir, "registry.json");
  writeFileSync(path, `{"schema":"0.20","seats":{"bob":{"big": 9007199254740993,"crew": false,"delivery": "pane","exited_at": "t0","handle": "bob","name": "café","pane": "p","pane_id": "%5","ratio": 2.0,"session": "alpha/bob","server_epoch": "7","status": "active","weird": NaN,"zone": Infinity}},"seat_forwardings":[{"address_active": true,"source": "carol","target": "carol#1"}],"team":{"name": "alpha"}}`);
  expect(word(dir, path)).toBe("killed");
  const afterKill = readFileSync(path, "utf8");
  expect(afterKill).toContain("9007199254740993");
  expect(afterKill).toContain('"ratio": 2.0');
  expect(afterKill).toContain("NaN");
  expect(afterKill).toContain("Infinity");
  expect(afterKill).toContain("caf\\u00e9");
  expect(afterKill).toContain('"address_active": true');
  // A fresh active row, then a failed kill: the restoration must reinstate the
  // complete pre-image through the same lossless codec.
  writeFileSync(path, `{"schema":"0.20","seats":{"bob":{"big": 9007199254740993,"crew": false,"delivery": "pane","exited_at": "t0","handle": "bob","name": "café","pane": "p","pane_id": "%5","ratio": 2.0,"session": "alpha/bob","server_epoch": "7","status": "active","weird": NaN,"zone": Infinity}},"seat_forwardings":[{"address_active": true,"source": "carol","target": "carol#1"}],"team":{"name": "alpha"}}`);
  expect(word(dir, path, { effects: effects({ hasSession: () => true }) })).toBe(
    "kill-failed",
  );
  const restored = readFileSync(path, "utf8");
  expect(restored).toContain('"status": "active"');
  expect(restored).toContain('"exited_at": "t0"');
  expect(restored).toContain('"pane_id": "%5"');
  expect(restored).toContain('"big": 9007199254740993');
  expect(restored).toContain('"ratio": 2.0');
  expect(restored).toContain(": NaN");
  expect(restored).toContain(": Infinity");
  expect(restored).toContain('"name": "caf\\u00e9"');
  expect(restored).toContain('"address_active": true');
});

test("rollback restores a deleted clear-policy row when the fresh registry lacks it (L685-692)", () => {
  const dir = work();
  const path = setup(dir, { bob: seatRow() });
  const before = JSON.parse(readFileSync(path, "utf8")) as RegistryDoc;
  const result = run(dir, path, {
    mode: "cotenant_kill",
    policy: "clear",
    effects: effects({ hasSession: () => true }),
  });
  expect(outcomeWord(result)).toBe("kill-failed");
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(before);
});

test("rollback over a corrupt registry discloses and restores nothing (L646-665)", () => {
  const dir = work();
  const path = setup(dir, { bob: seatRow() });
  const result = run(dir, path, {
    mode: "cotenant_kill",
    effects: effects({
      killSession: () => writeFileSync(path, "{broken"),
      hasSession: () => true,
    }),
  });
  expect(outcomeWord(result)).toBe("kill-failed");
  expect(result.warnings.length).toBe(1);
  expect(result.warnings[0]).toContain("rollback of the adopted rows was NOT applied: the registry is present but unreadable");
  expect(result.warnings[0]).toContain("bob");
  expect(readFileSync(path, "utf8")).toBe("{broken");
});

test("the recovery artifact moves to .inflight before the kill and returns on failure (L591-621, L716-728)", () => {
  const dir = work();
  const path = setup(dir, { bob: seatRow() });
  const selfRows = join(dir, "self-rows.json");
  writeFileSync(selfRows, "{}");
  expect(word(dir, path, { mode: "cotenant_kill", selfRowsPath: selfRows, effects: effects({ hasSession: () => true }) })).toBe(
    "kill-failed",
  );
  expect(existsSync(selfRows)).toBe(true);
  expect(existsSync(`${selfRows}.inflight`)).toBe(false);

  const strandedDir = join(dir, "inflight-dir");
  mkdirSync(strandedDir);
  const strandedRows = join(strandedDir, "self-rows.json");
  writeFileSync(strandedRows, "{}");
  expect(word(dir, path, { mode: "cotenant_kill", selfRowsPath: strandedRows, effects: effects({
    killSession: () => rmSync(strandedDir, { recursive: true, force: true }),
    hasSession: () => true,
  }) })).toBe(`kill-failed-stranded:${strandedRows}.inflight`);
});

test("an unstageable recovery artifact refuses with the captured rows put back (L605-621)", () => {
  const dir = work();
  const path = setup(dir, { bob: seatRow() });
  const selfRows = join(dir, "self-rows.json");
  writeFileSync(selfRows, "{}");
  mkdirSync(`${selfRows}.inflight`);
  writeFileSync(join(`${selfRows}.inflight`, "occupied"), "x");
  const result = run(dir, path, { mode: "cotenant_kill", selfRowsPath: selfRows });
  expect(outcomeWord(result)).toContain("refused:cannot stage recovery state (");
  expect(seatEntries(path).bob!.status).toBe("active");
});

test("prepare writes the journal before the registry mutation and reports prepared (L803-876)", () => {
  const dir = work();
  const path = setup(dir, { bob: seatRow({ wake_url: "http://x" }) });
  const result = run(dir, path, { mode: "prepare" });
  expect(outcomeWord(result)).toBe("prepared");
  const journal = JSON.parse(readFileSync(`${path}.self-last-journal.run1.json`, "utf8")) as {
    pre: Record<string, Seat>;
    post: Record<string, Seat>;
  };
  expect(journal.pre.bob!.status).toBe("active");
  expect(journal.pre.bob!.wake_url).toBe("http://x");
  expect(journal.post.bob!.status).toBe("suspended");
  expect(seatEntries(path).bob!.status).toBe("suspended");
});

test("prepare without a run id refuses closed and writes nothing (L835-843)", () => {
  const dir = work();
  const path = setup(dir, { bob: seatRow() });
  const before = readFileSync(path, "utf8");
  expect(word(dir, path, { mode: "prepare", runId: "" })).toBe("refused:no run id for the rollback journal");
  expect(existsSync(`${path}.self-last-journal.run1.json`)).toBe(false);
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("prepare records the crew deletion marker with its parent in the journal post-image (L823-830)", () => {
  const dir = work();
  const path = setup(dir, {
    bob: seatRow(),
    w1: seatRow({ handle: "w1", crew: true, pane: "pane-w1", pane_id: "%6" }),
  });
  const result = run(dir, path, { mode: "prepare", selfHandle: "bob" });
  expect(outcomeWord(result)).toBe("prepared crew_collected=w1\x1fpane-w1\x1fbob");
  const journal = JSON.parse(readFileSync(`${path}.self-last-journal.run1.json`, "utf8")) as {
    post: Record<string, unknown>;
  };
  expect(journal.post.w1).toEqual({ _crew_deleted: true, parent: "bob" });
  expect(seatEntries(path).w1).toBeUndefined();
  const events = eventLines(join(dir, "events.log"));
  expect(events.length).toBe(1);
  expect(events[0]).toContain("action=kill-requested");
  expect(events[0]).toContain("detail=crew=w1");
});

test("a failed kill-requested append in prepare removes the journal it published (L855-861)", () => {
  const dir = work();
  const path = setup(dir, {
    bob: seatRow(),
    w1: seatRow({ handle: "w1", crew: true, pane: "pane-w1", pane_id: "%6" }),
  });
  const blockedLog = join(dir, "events-dir");
  mkdirSync(blockedLog);
  expect(
    word(dir, path, {
      mode: "prepare",
      eventLog: blockedLog,
      effects: effects({ tmux: snapshotTmux({ panes: [
        { id: "%5", session: "alpha/bob" },
        { id: "%6", session: "alpha/bob" },
      ] }) }),
    }),
  ).toBe("refused:kill-requested append failed before prepared crew mutation");
  expect(existsSync(`${path}.self-last-journal.run1.json`)).toBe(false);
});

test("an unpublishable journal refuses closed (L845-854)", () => {
  const dir = work();
  const path = setup(dir, { bob: seatRow() });
  const before = readFileSync(path, "utf8");
  expect(word(dir, path, { mode: "prepare", runId: "sub/dir" })).toContain("refused:cannot publish rollback journal (");
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("an unreadable registry refuses before any mode logic runs (L126-145)", () => {
  const dir = work();
  const dirAsRegistry = join(dir, "registry-dir");
  mkdirSync(dirAsRegistry);
  expect(word(dir, dirAsRegistry)).toContain("refused:registry unreadable (");
});

test("a proven kill records adopted (handle, session) facts in the bridge before the transaction returns (review: durable terminal bridge)", () => {
  const dir = work();
  const bridge = join(dir, "adopted-bridge.txt");
  const path = setup(dir, {
    bob: seatRow(),
    late: seatRow({ handle: "late", pane: "pane-late", pane_id: "%6", session: "alpha/bob" }),
  });
  const result = run(dir, path, {
    adoptedBridge: bridge,
    effects: effects({ tmux: snapshotTmux({ panes: [{ id: "%5", session: "alpha/bob" }, { id: "%6", session: "alpha/bob" }] }) }),
  });
  expect(result.outcome.kind).toBe("killed");
  expect(result.adopted).toEqual(["late"]);
  expect(result.unrecorded).toEqual([]);
  // The fact survives the transaction on disk: an interruption before the
  // caller's drain still names the stopped seat and its session.
  expect(existsSync(bridge)).toBe(true);
  expect(readFileSync(bridge, "utf8")).toBe("late\x1falpha/bob\n");
});

test("a failed durable bridge append after the kill surfaces through unrecorded, not invented success (review)", () => {
  const dir = work();
  const bridge = join(dir, "absent-dir", "bridge.txt");
  const path = setup(dir, {
    bob: seatRow(),
    late: seatRow({ handle: "late", pane: "pane-late", pane_id: "%6", session: "alpha/bob" }),
  });
  const result = run(dir, path, {
    adoptedBridge: bridge,
    effects: effects({ tmux: snapshotTmux({ panes: [{ id: "%5", session: "alpha/bob" }, { id: "%6", session: "alpha/bob" }] }) }),
  });
  // The session WAS stopped — the outcome stays truthful — but the missing
  // durable record must reach the caller's unrecorded contract (rc 1 there).
  expect(result.outcome.kind).toBe("killed");
  expect(result.unrecorded).toEqual(["late"]);
});
