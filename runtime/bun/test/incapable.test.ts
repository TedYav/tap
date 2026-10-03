import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireRegistryLock } from "../src/panelock";
import { acquireResetMutationLock } from "../src/reset";
import { removeScratchTree } from "./support/scratch";

const repo = resolve(import.meta.dir, "../../..");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeScratchTree(root);
});

// The verb is a registry-only mutation: no pane is probed, killed or resumed,
// so unlike the up/down fixture this needs no tmux server at all. Selection
// itself reads only the index and the acting registry.
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tap-incapable.")));
  roots.push(root);
  const index = join(root, "index");
  const bus = join(root, ".tap", "bus");
  const registry = join(root, ".tap", "team-registry.json");
  mkdirSync(index); mkdirSync(bus, { recursive: true });
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", migrated: {}, teams: {
    team: { root, registry_location: registry, state: "registered", enrolled_at: "2026-09-01T00:00:00Z" },
  } }));
  const env: NodeJS.ProcessEnv = { ...process.env, TAP_HOME: bus, TAP_INDEX_HOME: index,
    TAP_SESSION_MANIFEST: join(root, "sessions.json"), TAP_TMUX_SOCKET: `incapable-${process.pid}-${roots.length}`,
    TAP_TMUX_SOCKET_PATH: undefined, TMUX: undefined, TMUX_PANE: undefined, TAP_SELF: undefined,
    TAP_SERVER_EPOCH: undefined, TAP_BOOT_ID: undefined,
  };
  const put = (seats: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "team", worktree_root: root }, seats, ...extra }));
  const raw = () => readFileSync(registry, "utf8");
  const get = () => JSON.parse(raw());
  const run = (...args: string[]) => spawnSync(process.execPath, [join(repo, "runtime/bun/main.ts"), ...args], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
  put({});
  // A second enrolled team with its own registry and bus, for the
  // foreign-target arms. Same index, same selection authority as down.
  const second = () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), "tap-incapable-other.")));
    roots.push(other);
    const otherBus = join(other, ".tap", "bus");
    const otherRegistry = join(other, ".tap", "team-registry.json");
    mkdirSync(otherBus, { recursive: true });
    const indexDoc = JSON.parse(readFileSync(join(index, "global-registry.json"), "utf8"));
    indexDoc.teams.other = { root: other, registry_location: otherRegistry, state: "registered", enrolled_at: "2026-09-01T00:00:00Z" };
    writeFileSync(join(index, "global-registry.json"), JSON.stringify(indexDoc));
    const putOther = (seats: Record<string, unknown>) =>
      writeFileSync(otherRegistry, JSON.stringify({ schema: "0.20", team: { name: "other", worktree_root: other }, seats }));
    const runOther = (...args: string[]) => spawnSync(process.execPath, [join(repo, "runtime/bun/main.ts"), ...args], { cwd: other, env: { ...env, TAP_HOME: otherBus }, encoding: "utf8", timeout: 20_000 });
    putOther({});
    return { root: other, bus: otherBus, registry: otherRegistry, put: putOther, raw: () => readFileSync(otherRegistry, "utf8"), run: runOther };
  };
  return { root, bus, registry, env, put, raw, get, run, second };
}

const row = () => ({
  pane: "team/seat", pane_id: "%1", status: "active", status_reason: "",
  harness: "codex", session: "team/seat", delivery: "pane",
  registered_at: "2026-09-01T00:00:00Z", instance: "seat|stable",
});

test("a valid active seat is marked, and only its two state values change", () => {
  const f = fixture();
  f.put({ seat: row(), bystander: { ...row(), pane_id: "%2", instance: "other|inst" } }, {
    seat_forwardings: [{ source: "seat", target: "alias", source_instance: "seat|stable", address_active: true }],
    note: "unrelated section round-trips",
  });
  writeFileSync(join(f.bus, "reset-generation.json"), JSON.stringify({ state: "pristine" }));

  const result = f.run("incapable", "seat", "--json");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    ok: true, verb: "incapable", team: "team", handle: "seat", instance: "seat|stable", outcome: "marked",
  });

  const doc = f.get();
  expect(doc.seats.seat).toEqual({ ...row(), status: "suspended", status_reason: "incapable" });
  expect(doc.seats.bystander).toEqual({ ...row(), pane_id: "%2", instance: "other|inst" });
  expect(doc.seat_forwardings).toEqual([{ source: "seat", target: "alias", source_instance: "seat|stable", address_active: true }]);
  expect(doc.note).toBe("unrelated section round-trips");
  // The write is the same python-shaped atomic write every registry writer
  // uses, never the alias-superseding saveRegistry path.
  expect(f.raw().endsWith("\n")).toBe(true);
  expect(JSON.parse(readFileSync(join(f.bus, "reset-generation.json"), "utf8")))
    .toEqual({ first_mutation: "tap incapable", state: "reused" });

  // A second mark is the acknowledged no-op: nothing is written again.
  const before = f.raw();
  const again = f.run("incapable", "seat", "--json");
  expect(again.status).toBe(0);
  expect(JSON.parse(again.stdout).outcome).toBe("already_incapable");
  expect(f.raw()).toBe(before);
  expect(JSON.parse(readFileSync(join(f.bus, "reset-generation.json"), "utf8")).first_mutation).toBe("tap incapable");
});

test("text receipts name the seat, the outcome and the persisted pair", () => {
  const f = fixture();
  f.put({ seat: row() });
  expect(f.run("incapable", "seat").stdout).toBe("tap incapable: team/seat marked (suspended/incapable)\n");
  expect(f.run("incapable", "team/seat").stdout).toBe("tap incapable: team/seat already_incapable (suspended/incapable)\n");
});

// Control: a ready seat's launch_witness is not a launch in progress.
test("a ready seat carrying launch_witness can still be marked incapable", () => {
  const f = fixture();
  f.put({ seat: { ...row(), launch_witness: "w" } });
  const result = f.run("incapable", "seat", "--json");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).outcome).toBe("marked");
});

test("a legacy row with no stored status is still an active seat", () => {
  const f = fixture();
  const legacy = { ...row() } as Record<string, unknown>;
  delete legacy.status; delete legacy.status_reason;
  f.put({ seat: legacy });
  const result = f.run("incapable", "seat", "--json");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).outcome).toBe("marked");
  expect(f.get().seats.seat).toEqual({ ...legacy, status: "suspended", status_reason: "incapable" });
});

test("refusals never write: every unsupported row keeps its bytes", () => {
  const f = fixture();
  f.put({});
  // Seed a case, snapshot the bytes, refuse, and prove not one byte moved.
  const refuse = (seats: Record<string, unknown>, handle: string, errorClass: string, detailPart?: string, ...args: string[]) => {
    f.put(seats);
    const before = f.raw();
    const result = f.run("incapable", ...(args.length ? args : [handle]), "--json");
    expect(result.status).toBe(1);
    const receipt = JSON.parse(result.stdout);
    expect(receipt).toEqual({ ok: false, verb: "incapable", error_class: errorClass, detail: receipt.detail });
    if (detailPart) expect(receipt.detail).toContain(detailPart);
    expect(f.raw()).toBe(before);
  };

  refuse({}, "ghost", "not_found", "team/ghost");

  const flagged = (change: Record<string, unknown>) => ({ seat: { ...row(), ...change } });
  refuse(flagged({ crew: true }), "seat", "usage_error", "tap crew remove");
  refuse(flagged({ delivery: "poll" }), "seat", "poll_seat");
  refuse(flagged({ status: "pending" }), "seat", "launch_in_progress");
  refuse(flagged({ launch_token: "tok" }), "seat", "launch_in_progress");
  refuse(flagged({ status_reason: "launching" }), "seat", "launch_in_progress");

  // Downed or otherwise non-active rows are not marked; the detail names what
  // is stored so the operator can pick up, up, or repair the seat.
  refuse(flagged({ status: "suspended", status_reason: "session_stopped" }), "seat", "seat_not_active", "session_stopped");
  refuse(flagged({ status: "retired" }), "seat", "seat_not_active", "retired");
  // An active row carrying an operational reason is unreadable as "ready" —
  // and so is a status-less row with a reason (the legacy default is active).
  refuse(flagged({ status_reason: "repair_failed" }), "seat", "seat_not_active", "repair_failed");
  const ghosted = { pane: "team/seat", pane_id: "%1", harness: "codex", session: "team/seat", status_reason: "pane_gone" };
  refuse({ seat: ghosted }, "seat", "seat_not_active", "pane_gone");
});

test("malformed rows refuse closed with an invalid-row class", () => {
  const f = fixture();
  const refuse = (seats: Record<string, unknown>, detailPart?: string) => {
    f.put(seats);
    const before = f.raw();
    const result = f.run("incapable", "seat", "--json");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error_class).toBe("invalid_row");
    if (detailPart) expect(JSON.parse(result.stdout).detail).toContain(detailPart);
    expect(f.raw()).toBe(before);
  };

  refuse({ seat: [1, 2] });
  refuse({ seat: "active" });
  refuse({ seat: { ...row(), status: 5 } });
  refuse({ seat: { ...row(), status_reason: 7 } });
});

test("arg parsing refuses with the verb's own help door", () => {
  const f = fixture();
  f.put({ seat: row() });
  const before = f.raw();
  for (const args of [[], ["seat", "extra"], ["--dry-run", "seat"], ["seat", "--team"], ["seat", "--only"]]) {
    const result = f.run("incapable", ...args);
    expect(result.status).toBe(1);
    expect(`${result.stderr}${result.stdout}`).toContain("tap help incapable");
  }
  expect(f.raw()).toBe(before);
});

test("a non-JSON refusal explains itself on stderr", () => {
  const f = fixture();
  f.put({});
  const result = f.run("incapable", "seat");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("tap incapable:");
  expect(result.stderr).toContain("tap help incapable");
});

// --- Round-1 review (partner review pair review) ---

test("an unsupported or unreadable delivery refuses closed", () => {
  const f = fixture();
  const refuse = (delivery: unknown) => {
    f.put({ seat: { ...row(), delivery } });
    const before = f.raw();
    const result = f.run("incapable", "seat", "--json");
    expect(result.status).toBe(1);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.ok).toBe(false);
    expect(receipt.error_class).toBe("invalid_row");
    expect(receipt.detail).toContain("delivery");
    expect(f.raw()).toBe(before);
  };
  refuse("carrier-pigeon");
  refuse(42);
});

test("legacy empty and exact pane deliveries still mark", () => {
  for (const delivery of ["", "pane"]) {
    const f = fixture();
    f.put({ seat: { ...row(), delivery } });
    const result = f.run("incapable", "seat", "--json");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).outcome).toBe("marked");
    expect(f.get().seats.seat.status).toBe("suspended");
    expect(f.get().seats.seat.status_reason).toBe("incapable");
  }
});

test("a qualified foreign-team target marks the foreign registry and leaves the caller's alone", () => {
  const f = fixture();
  const other = f.second();
  other.put({ seat: row() });
  const demoBefore = f.raw();
  const result = other.run("incapable", "other/seat", "--json");
  expect(result.status).toBe(0);
  const receipt = JSON.parse(result.stdout);
  expect(receipt.ok).toBe(true);
  expect(receipt.team).toBe("other");
  expect(JSON.parse(other.raw()).seats.seat.status_reason).toBe("incapable");
  expect(f.raw()).toBe(demoBefore);
});

test("--team selects a foreign team exactly like down's authority", () => {
  const f = fixture();
  const other = f.second();
  other.put({ seat: row() });
  const result = other.run("incapable", "seat", "--team", "other", "--json");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).team).toBe("other");
  expect(JSON.parse(other.raw()).seats.seat.status).toBe("suspended");
});

test("a held registry lock refuses with registry_busy and no write", () => {
  const f = fixture();
  f.put({ seat: row() });
  const held = acquireRegistryLock(f.registry);
  if (!held) throw new Error("fixture could not hold the registry lock");
  try {
    const result = f.run("incapable", "seat", "--json");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error_class).toBe("registry_busy");
    expect(JSON.parse(f.raw()).seats.seat.status).toBe("active");
  } finally { held.release(); }
});

test("a held reset-mutation fence refuses and leaves the generation untouched", () => {
  const f = fixture();
  f.put({ seat: row() });
  writeFileSync(join(f.bus, "reset-generation.json"), JSON.stringify({ state: "pristine" }));
  const fence = acquireResetMutationLock(f.bus, "probe");
  try {
    const result = f.run("incapable", "seat", "--json");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error_class).toBe("reset_custody_busy");
    expect(JSON.parse(f.raw()).seats.seat.status).toBe("active");
    expect(JSON.parse(readFileSync(join(f.bus, "reset-generation.json"), "utf8")).state).toBe("pristine");
  } finally { fence.release(); }
});

test("a vanished enrollment refuses before any write", () => {
  const f = fixture();
  f.put({ seat: row() });
  const before = f.raw();
  const indexDoc = JSON.parse(readFileSync(join(f.root, "index", "global-registry.json"), "utf8"));
  delete indexDoc.teams.team;
  writeFileSync(join(f.root, "index", "global-registry.json"), JSON.stringify(indexDoc));
  const result = f.run("incapable", "seat", "--json");
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout).ok).toBe(false);
  expect(f.raw()).toBe(before);
});

test("an old, hybrid or axis-less registry refuses before any write or generation stamp", () => {
  const f = fixture();
  const team = { name: "team", worktree_root: f.root };
  const generation = join(f.bus, "reset-generation.json");
  writeFileSync(generation, '{"state":"pristine"}\n');
  for (const [doc, errorClass] of [
    [{ schema: "0.20", team, agents: { seat: row() } }, "old_store"],
    [{ schema: "0.20", team, seats: { seat: row() }, agents: { old: row() } }, "old_store"],
    // C4a: an axis-less store is old (the shared predicate), not merely invalid.
    [{ schema: "0.20", team }, "old_store"],
  ] as const) {
    const bytes = JSON.stringify(doc);
    writeFileSync(f.registry, bytes);
    const result = f.run("incapable", "seat", "--json");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error_class).toBe(errorClass);
    expect(f.raw()).toBe(bytes);
    expect(readFileSync(generation, "utf8")).toBe('{"state":"pristine"}\n');
  }
});

test("invalid registry bytes refuse without rewriting the file", () => {
  const f = fixture();
  writeFileSync(f.registry, "{broken");
  const result = f.run("incapable", "seat", "--json");
  expect(result.status).toBe(1);
  const receipt = JSON.parse(result.stdout);
  expect(receipt.ok).toBe(false);
  expect(receipt.verb).toBe("incapable");
  expect(f.raw()).toBe("{broken");
});

test("a legacy numeric crew flag reads as crew", () => {
  const f = fixture();
  f.put({ seat: { ...row(), crew: 1 } });
  const before = f.raw();
  const result = f.run("incapable", "seat", "--json");
  expect(result.status).toBe(1);
  const receipt = JSON.parse(result.stdout);
  expect(receipt.error_class).toBe("usage_error");
  expect(receipt.detail).toContain("tap crew remove");
  expect(f.raw()).toBe(before);
});

test("a pane seat without stored pane identity refuses, and identically twice", () => {
  const f = fixture();
  const bare = { ...row() } as Record<string, unknown>;
  delete bare.pane;
  delete bare.pane_id;
  f.put({ seat: bare });
  const before = f.raw();
  const first = f.run("incapable", "seat");
  expect(first.status).toBe(1);
  expect(first.stderr).toContain("has no stored pane identity (pane, pane_id)");
  const second = f.run("incapable", "seat");
  expect(second.stderr).toBe(first.stderr);
  expect(f.raw()).toBe(before);
});

test("a stale-generation pane seat still marks: recorded coordinates are enough", () => {
  const f = fixture();
  f.put({ seat: { ...row(), pane: "team/old:0.9", pane_id: "%old" } });
  const result = f.run("incapable", "seat", "--json");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).outcome).toBe("marked");
  expect(f.get().seats.seat.pane).toBe("team/old:0.9");
});
