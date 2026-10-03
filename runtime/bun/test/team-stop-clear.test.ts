import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allocateRecoveryArtifact,
  clearRegistry,
  clearSelfSnap,
  emitCrewRestored,
  reapArtifact,
  restoreSelfRows,
  rollbackSelfSnap,
} from "../src/team/stop-clear";

let seq = 0;
function work(): string {
  seq += 1;
  return mkdtempSync(join(tmpdir(), `tap-stop-clear-${seq}-`));
}
const row = (over: Record<string, unknown> = {}) => ({
  handle: over.handle,
  session: over.session ?? "",
  pane: over.pane ?? "",
  pane_id: over.pane_id ?? "",
  server_epoch: over.server_epoch ?? "srv:900:100",
  delivery: over.delivery ?? "pane",
  status: over.status ?? "active",
  crew: over.crew ?? false,
  ...Object.fromEntries(Object.entries(over).filter(([k]) => !["handle", "session", "pane", "pane_id", "server_epoch", "delivery", "status", "crew"].includes(k))),
});

function seedRegistry(path: string, seats: Record<string, unknown>, envelope: Record<string, unknown> = {}, axis = "seats"): void {
  const doc: Record<string, unknown> = { schema: "0.20", team: { name: "alpha", worktree_root: "/w" }, ...envelope, [axis]: seats };
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
}
const readJson = (path: string): any => JSON.parse(readFileSync(path, "utf8"));

test("final clear retains the registry when a selected parent was replaced", () => {
  const root = work();
  try {
    const registryPath = join(root, "registry.json");
    seedRegistry(registryPath, { bob: row({ handle: "bob", instance: "replacement", session: "alpha/bob" }),
      late: row({ handle: "late", instance: "late", session: "alpha/late" }) });
    const before = readFileSync(registryPath, "utf8");
    const result = clearRegistry({ registryPath, tapHome: root, keepSet: [], recoveryOut: "",
      selection: { mode: "--only", set: ["bob"] }, selfSession: "",
      approvedInstances: new Map([["bob", "approved"]]) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("replaced before clear");
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("final clear retains the registry when an approved crew handle was replaced", () => {
  const root = work();
  try {
    const registryPath = join(root, "registry.json");
    seedRegistry(registryPath, { bob: row({ handle: "bob", instance: "parent", session: "alpha/bob" }),
      child: row({ handle: "child", instance: "new-child", crew: true, session: "alpha/bob" }) });
    const before = readFileSync(registryPath, "utf8");
    const result = clearRegistry({ registryPath, tapHome: root, keepSet: [], recoveryOut: "",
      selection: { mode: "--only", set: ["bob", "child"] }, selfSession: "",
      approvedInstances: new Map([["bob", "parent"]]), approvedCrewInstances: new Map([["child", "old-child"]]) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("'child' was replaced before clear");
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("allocateRecoveryArtifact creates a unique 0600 file under tapHome/recovery (tap-team-stop.sh L2563)", () => {
  const root = work();
  try {
    const a = allocateRecoveryArtifact(root);
    const b = allocateRecoveryArtifact(root);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
    expect(a!).toContain(join("recovery", "self-row-"));
    expect(existsSync(a!)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("empty caller handles fail closed before any clear (class 4; tap-team-stop.sh L1253-1256)", () => {
  const root = work();
  try {
    const reg = join(root, "registry.json");
    seedRegistry(reg, { bob: row({ handle: "bob", session: "alpha/bob" }) });
    const gen = join(root, "reset-generation.json");
    writeFileSync(gen, "{}");
    const result = clearRegistry({
      registryPath: reg,
      tapHome: root,
      keepSet: [],
      selfHandles: [],
      recoveryOut: "",
      selection: { mode: "", set: [] },
      selfSession: "",
    });
    expect(result).toEqual({ ok: false, cls: 4, detail: "caller handle list is empty; refusing to clear without recovery state" });
    expect(existsSync(reg)).toBe(true);
    expect(existsSync(gen)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("absent caller handles mean no caller-recovery phase — the zero-row clear stays representable (driver probe, review round 1 C1)", () => {
  const root = work();
  try {
    const reg = join(root, "registry.json");
    writeFileSync(reg, '{"schema":"0.20","seats":{},"team":{"name":"alpha"}}\n');
    const gen = join(root, "reset-generation.json");
    writeFileSync(gen, "{}");
    const result = clearRegistry({
      registryPath: reg,
      tapHome: root,
      keepSet: [],
      recoveryOut: "",
      selection: { mode: "", set: [] },
      selfSession: "",
    } as Parameters<typeof clearRegistry>[0]);
    expect(result).toEqual({ ok: true, deletedCrew: [], lateSpared: [], generationConsumed: true });
    expect(existsSync(reg)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the delete path removes the registry, consumes the reset generation, retains the .lock sidecar and returns crew values (tap-team-stop.sh L1440-1467)", () => {
  const root = work();
  try {
    const reg = join(root, "registry.json");
    seedRegistry(reg, {
      bob: row({ handle: "bob", session: "alpha/bob", pane: "p1", pane_id: "%1" }),
      w1: row({ handle: "w1", session: "alpha/bob", pane: "pw", crew: true }),
    });
    const gen = join(root, "reset-generation.json");
    writeFileSync(gen, "{}");
    const recoveryOut = allocateRecoveryArtifact(root)!;
    const result = clearRegistry({
      registryPath: reg,
      tapHome: root,
      keepSet: [],
      selfHandles: ["bob"],
      recoveryOut,
      selection: { mode: "", set: [] },
      selfSession: "alpha/bob",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.generationConsumed).toBe(true);
    expect(existsSync(reg)).toBe(false);
    expect(existsSync(`${reg}.lock`)).toBe(true);
    expect(existsSync(gen)).toBe(false);
    expect(result.deletedCrew).toEqual([{ handle: "w1", pane: "pw", parent: "bob" }]);
    // Captured before anything was consumed: the caller row is in the
    // artifact, and the widened caller set (crew w1 shares the self session,
    // non-poll) rides beside it.
    const payload = readJson(recoveryOut);
    expect("seat_key" in payload).toBe(false);
    expect(payload.team).toEqual({ name: "alpha", worktree_root: "/w" });
    expect(payload.schema).toBe("0.20");
    expect(Object.keys(payload.rows)).toEqual(["bob", "w1"]);
    expect(payload.rows.bob.pane_id).toBe("%1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the delete arm refuses when the locked fresh read turns corrupt — only ENOENT is already-absent (driver probe, review round 1 C3)", () => {
  const root = work();
  try {
    const reg = join(root, "registry.json");
    const recoveryOut = join(root, "recovery.json");
    writeFileSync(
      reg,
      '{"schema":"0.20","seats":{"bob":{"status":"active","session":"alpha/bob"}},"team":{"name":"alpha"}}\n',
    );
    writeFileSync(join(root, "reset-generation.json"), "{}");
    // Deterministic race with no production hook: the selection iterable
    // rewrites the registry to unparseable bytes between the parse-once and
    // the locked fresh read — exactly the window a concurrent writer owns.
    const selection = new Proxy(["bob"], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          return function* () {
            writeFileSync(reg, "{broken\n");
            yield "bob";
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const result = clearRegistry({
      registryPath: reg,
      tapHome: root,
      keepSet: [],
      selfHandles: ["bob"],
      recoveryOut,
      selection: { mode: "--only", set: selection },
      selfSession: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.cls).toBe(5);
    expect(existsSync(reg)).toBe(true);
    expect(readFileSync(reg, "utf8")).toBe("{broken\n");
    expect(existsSync(join(root, "reset-generation.json"))).toBe(true);
    expect(existsSync(recoveryOut)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a capture failure leaves the registry and generation intact and is class 1 (tap-team-stop.sh L1264-1312)", () => {
  const root = work();
  try {
    const reg = join(root, "registry.json");
    seedRegistry(reg, { bob: row({ handle: "bob", session: "alpha/bob" }) });
    const gen = join(root, "reset-generation.json");
    writeFileSync(gen, "{}");
    const result = clearRegistry({
      registryPath: reg,
      tapHome: root,
      keepSet: [],
      selfHandles: ["bob"],
      recoveryOut: join(root, "no-such-dir", "self-row-abc"),
      selection: { mode: "", set: [] },
      selfSession: "",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.cls).toBe(1);
    expect(existsSync(reg)).toBe(true);
    expect(existsSync(gen)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable or non-registry file is retained and classified 5, both for a bad root and a wrong-type axis (tap-team-stop.sh L1382-1412)", () => {
  const root = work();
  try {
    const bad = join(root, "bad.json");
    writeFileSync(bad, "[1]\n");
    expect(clearRegistry({
      registryPath: bad, tapHome: root, keepSet: [], selfHandles: ["bob"], recoveryOut: "",
      selection: { mode: "", set: [] }, selfSession: "",
    })).toEqual({ ok: false, cls: 5, detail: "registry present but unreadable; retained without clearing" });
    expect(readFileSync(bad, "utf8")).toBe("[1]\n");
    const axis = join(root, "axis.json");
    writeFileSync(axis, '{"schema":"0.20","seats":[]}\n');
    expect(clearRegistry({
      registryPath: axis, tapHome: root, keepSet: [], selfHandles: ["bob"], recoveryOut: "",
      selection: { mode: "", set: [] }, selfSession: "",
    })).toEqual({ ok: false, cls: 5, detail: "registry present but unreadable; retained without clearing" });
    expect(existsSync(axis)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an absent registry consumes the reset generation only when nothing is kept (tap-team-stop.sh L1355-1361)", () => {
  const root = work();
  try {
    const reg = join(root, "registry.json");
    const gen = join(root, "reset-generation.json");
    writeFileSync(gen, "{}");
    const empty = clearRegistry({
      registryPath: reg, tapHome: root, keepSet: [], selfHandles: ["bob"], recoveryOut: "",
      selection: { mode: "", set: [] }, selfSession: "",
    });
    expect(empty).toEqual({ ok: true, deletedCrew: [], lateSpared: [], generationConsumed: true });
    expect(existsSync(gen)).toBe(false);
    writeFileSync(gen, "{}");
    const kept = clearRegistry({
      registryPath: reg, tapHome: root, keepSet: ["bob"], selfHandles: ["bob"], recoveryOut: "",
      selection: { mode: "", set: [] }, selfSession: "",
    });
    expect(kept).toEqual({ ok: true, deletedCrew: [], lateSpared: [], generationConsumed: false });
    expect(existsSync(gen)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the filter path retains the keep set and captures the deleted caller rows (tap-team-stop.sh L1468-1560)", () => {
  const root = work();
  try {
    const reg = join(root, "registry.json");
    seedRegistry(reg, {
      bob: row({ handle: "bob", session: "alpha/bob" }),
      carol: row({ handle: "carol", session: "alpha/carol" }),
      late: row({ handle: "late", session: "alpha/late" }),
    });
    const recoveryOut = allocateRecoveryArtifact(root)!;
    const result = clearRegistry({
      registryPath: reg,
      tapHome: root,
      keepSet: ["bob"],
      selfHandles: ["bob"],
      recoveryOut,
      selection: { mode: "", set: [] },
      selfSession: "",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.generationConsumed).toBe(false);
    expect(result.deletedCrew).toEqual([]);
    expect(result.lateSpared).toEqual([]);
    const doc = readJson(reg);
    expect(Object.keys(doc.seats)).toEqual(["bob"]);
    const payload = readJson(recoveryOut);
    // Capture saves caller handles minus retained: bob is retained, and the
    // deleted non-caller rows (carol, late) get no recovery evidence.
    expect(Object.keys(payload.rows)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a row that registered after planning is spared by the locked clear and reported late (tap-team-stop.sh L1414-1441, L1468-1502)", () => {
  const root = work();
  try {
    const reg = join(root, "registry.json");
    seedRegistry(reg, {
      bob: row({ handle: "bob", session: "alpha/bob" }),
      late: row({ handle: "late", session: "alpha/late" }),
    });
    const recoveryOut = allocateRecoveryArtifact(root)!;
    const result = clearRegistry({
      registryPath: reg,
      tapHome: root,
      keepSet: [],
      selfHandles: ["bob"],
      recoveryOut,
      selection: { mode: "--only", set: ["bob"] },
      selfSession: "",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lateSpared).toEqual([{ handle: "late", session: "alpha/late" }]);
    // 'late' was never named by the plan: it survives the locked clear.
    expect(Object.keys(readJson(reg).seats)).toEqual(["late"]);
    const payload = readJson(recoveryOut);
    // Capture saves caller handles minus retained: bob is spared from
    // deletion by the late clear, 'late' is not a caller handle.
    expect(Object.keys(payload.rows)).toEqual(["bob"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capture widens to non-poll co-tenants of the caller session, but not poll rows (tap-team-stop.sh L1414-1438)", () => {
  const root = work();
  try {
    const reg = join(root, "registry.json");
    seedRegistry(reg, {
      bob: row({ handle: "bob", session: "alpha/bob" }),
      henry: row({ handle: "henry", session: "alpha/bob" }),
      polly: row({ handle: "polly", session: "alpha/bob", delivery: "poll" }),
    });
    const recoveryOut = allocateRecoveryArtifact(root)!;
    const result = clearRegistry({
      registryPath: reg,
      tapHome: root,
      keepSet: [],
      selfHandles: ["bob"],
      recoveryOut,
      selection: { mode: "", set: [] },
      selfSession: "alpha/bob",
    });
    expect(result.ok).toBe(true);
    const payload = readJson(recoveryOut);
    expect(Object.keys(payload.rows).sort()).toEqual(["bob", "henry"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("late-spared poll rows report an empty session; the delivery-before-stamp rule (tap-team-stop.sh L1398-1411)", () => {
  const root = work();
  try {
    const reg = join(root, "registry.json");
    seedRegistry(reg, {
      bob: row({ handle: "bob", session: "alpha/bob" }),
      polly: row({ handle: "polly", session: "stale/old", delivery: "poll" }),
    });
    const result = clearRegistry({
      registryPath: reg, tapHome: root, keepSet: ["bob"], selfHandles: ["bob"], recoveryOut: "",
      selection: { mode: "--except", set: ["bob", "polly"] }, selfSession: "",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both in-set rows are spared by the locked clear, sorted; the poll row's
    // stale session is not copied into the report.
    expect(result.lateSpared).toEqual([
      { handle: "bob", session: "alpha/bob" },
      { handle: "polly", session: "" },
    ]);
    expect(Object.keys(readJson(reg).seats).sort()).toEqual(["bob", "polly"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoreSelfRows rebuilds only an absent registry, in the current format, with the captured team (tap-team-stop.sh L1180-1191)", () => {
  const root = work();
  try {
    const reg = join(root, "registry.json");
    const rowsFile = join(root, "self-row-1");
    writeFileSync(rowsFile, `${JSON.stringify({
      team: { name: "alpha", worktree_root: "/w" },
      schema: 20,
      seat_key: "seats",
      rows: { bob: row({ handle: "bob", session: "alpha/bob", pane: "p9", pane_id: "%9", status_reason: "re-registered" }) },
    })}\n`);
    const result = restoreSelfRows({ registryPath: reg, rowsFile });
    expect(result).toEqual({ ran: true, ok: true });
    expect(existsSync(rowsFile)).toBe(false);
    const doc = readJson(reg);
    expect(doc.schema).toBe("0.20");
    expect("agents" in doc).toBe(false);
    expect(doc.team).toEqual({ name: "alpha", worktree_root: "/w" });
    expect(doc.seats.bob.pane_id).toBe("%9");
    expect(doc.seats.bob.status_reason).toBe("re-registered");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clear retains an agents-axis, hybrid or axis-less registry instead of deleting it or restoring its rows as seats", () => {
  const root = work();
  try {
    const reg = join(root, "registry.json");
    for (const old of [
      `${JSON.stringify({ team: { name: "alpha" }, agents: { bob: row({ handle: "bob", session: "alpha/bob" }) } })}\n`,
      `${JSON.stringify({ team: { name: "alpha" }, seats: {}, agents: { bob: row({ handle: "bob", session: "alpha/bob" }) } })}\n`,
      `${JSON.stringify({ schema: "0.20", team: { name: "alpha" } })}\n`,
    ]) {
    writeFileSync(reg, old);
    for (const selection of [{ mode: "", set: [] }, { mode: "--only", set: ["bob"] }] as const) {
      const result = clearRegistry({
        registryPath: reg, tapHome: root, keepSet: [], selfHandles: ["bob"],
        recoveryOut: allocateRecoveryArtifact(root)!, selection: { mode: selection.mode, set: [...selection.set] }, selfSession: "alpha/bob",
      });
      expect(result.ok).toBe(false);
      expect(readFileSync(reg, "utf8")).toBe(old);
    }
    const rowsFile = join(root, "self-row-2");
    writeFileSync(rowsFile, `${JSON.stringify({ rows: { carol: row({ handle: "carol" }) } })}\n`);
    const restored = restoreSelfRows({ registryPath: reg, rowsFile });
    expect(restored).toMatchObject({ ran: true, ok: false, rc: 3 });
    expect(readFileSync(reg, "utf8")).toBe(old);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoreSelfRows never overwrites a corrupt or non-object registry (rc 3; tap-team-stop.sh L1192-1201)", () => {
  const root = work();
  try {
    for (const bytes of ["not json at all\n", "[1]\n"]) {
      const reg = join(root, `reg-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(reg, bytes);
      const rowsFile = join(root, "self-row-2");
      writeFileSync(rowsFile, `${JSON.stringify({ seat_key: "seats", rows: { bob: row({ handle: "bob" }) } })}\n`);
      const result = restoreSelfRows({ registryPath: reg, rowsFile });
      if (!result.ran || result.ok) throw new Error(`expected a classified restore failure for ${JSON.stringify(bytes)}`);
      expect(result.rc).toBe(3);
      expect(readFileSync(reg, "utf8")).toBe(bytes);
      expect(existsSync(rowsFile)).toBe(true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a present registry with a wrong-type seat axis is refused with its bytes untouched, never rebuilt", () => {
  const root = work();
  try {
    const reg = join(root, "axis-str.json");
    const bytes = '{"schema":"0.20","seats":"not-a-map","team":{"name":"alpha"}}\n';
    writeFileSync(reg, bytes);
    const rowsFile = join(root, "self-row-3");
    writeFileSync(rowsFile, `${JSON.stringify({ seat_key: "seats", rows: { bob: row({ handle: "bob" }) } })}\n`);
    const result = restoreSelfRows({ registryPath: reg, rowsFile });
    expect(result).toEqual({ ran: true, ok: false, rc: 3, detail: "registry has no seats map; refusing to overwrite" });
    expect(readFileSync(reg, "utf8")).toBe(bytes);
    expect(existsSync(rowsFile)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoreSelfRows classifies unreadable and malformed recovery state as rc 2 (tap-team-stop.sh L1146-1168)", () => {
  const root = work();
  try {
    const reg = join(root, "registry.json");
    seedRegistry(reg, {});
    const unreadable = join(root, "rows-unreadable");
    writeFileSync(unreadable, "{not json");
    const res = restoreSelfRows({ registryPath: reg, rowsFile: unreadable });
    expect(res.ran && !res.ok && res.rc === 2 && res.detail.startsWith("recovery state unreadable (")).toBe(true);
    expect(existsSync(unreadable)).toBe(true);
    const malformed = join(root, "rows-malformed");
    writeFileSync(malformed, '{"team": {}}\n');
    expect(restoreSelfRows({ registryPath: reg, rowsFile: malformed })).toEqual({
      ran: true, ok: false, rc: 2, detail: "recovery state malformed: no rows key",
    });
    const wrongType = join(root, "rows-wrongtype");
    writeFileSync(wrongType, '{"rows": []}\n');
    expect(restoreSelfRows({ registryPath: reg, rowsFile: wrongType })).toEqual({
      ran: true, ok: false, rc: 2, detail: "recovery state malformed: rows is not an object",
    });
    expect(existsSync(reg)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoreSelfRows fills only absent rows and an explicit empty rows map succeeds (tap-team-stop.sh L1202-1210)", () => {
  const root = work();
  try {
    const reg = join(root, "registry.json");
    seedRegistry(reg, { bob: row({ handle: "bob", session: "alpha/live", pane_id: "%LIVE" }) });
    const empty = join(root, "rows-empty");
    writeFileSync(empty, '{"seat_key": "seats", "rows": {}}\n');
    expect(restoreSelfRows({ registryPath: reg, rowsFile: empty })).toEqual({ ran: true, ok: true });
    expect(existsSync(empty)).toBe(false);
    const rowsFile = join(root, "rows-mixed");
    writeFileSync(rowsFile, `${JSON.stringify({
      seat_key: "seats",
      rows: {
        bob: row({ handle: "bob", session: "alpha/captured", pane_id: "%CAPT" }),
        carol: row({ handle: "carol", session: "alpha/carol", pane_id: "%3" }),
      },
    })}\n`);
    restoreSelfRows({ registryPath: reg, rowsFile });
    const doc = readJson(reg);
    expect(doc.seats.bob.pane_id).toBe("%LIVE");
    expect(doc.seats.carol.pane_id).toBe("%3");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoreSelfRows is a no-op when the artifact or the registry path is absent (tap-team-stop.sh L1139-1142)", () => {
  const root = work();
  try {
    expect(restoreSelfRows({ registryPath: join(root, "r.json"), rowsFile: "" })).toEqual({ ran: false });
    expect(restoreSelfRows({ registryPath: join(root, "r.json"), rowsFile: join(root, "absent") })).toEqual({ ran: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollbackSelfSnap restores the exact pre-image only while the current row still equals the post-image (tap-team-stop.sh L952-978)", () => {
  const root = work();
  try {
    const reg = join(root, "registry.json");
    const pre = row({ handle: "bob", session: "alpha/bob", pane: "p1", pane_id: "%1", status: "active", status_reason: "" });
    const post = row({ handle: "bob", session: "alpha/bob", pane: "p1", pane_id: "%1", status: "suspended", status_reason: "session_stopped" });
    seedRegistry(reg, {
      bob: { ...post },
      carol: row({ handle: "carol", session: "alpha/carol", pane_id: "%2", status: "active", status_reason: "re-registered" }),
    });
    const jrn = `${reg}.self-last-journal.run1.json`;
    writeFileSync(jrn, JSON.stringify({
      pre: { bob: pre, carol: row({ handle: "carol", session: "alpha/carol", pane_id: "%2", status: "active", status_reason: "" }) },
      post: { bob: post, carol: { ...post, handle: "carol", pane_id: "%2", session: "alpha/carol" } },
    }));
    const result = rollbackSelfSnap({ registryPath: reg, runId: "run1" });
    expect(result).toEqual({ ran: true, ok: true, crewRestored: [] });
    expect(existsSync(jrn)).toBe(false);
    const doc = readJson(reg);
    expect(doc.seats.bob).toEqual(pre);
    // carol was re-registered concurrently (pane_id differs from post): it wins.
    expect(doc.seats.carol.pane_id).toBe("%2");
    expect(doc.seats.carol.status).toBe("active");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollbackSelfSnap compares wide integers exactly: an adjacent concurrent row wins (driver probe, review round 1 C2)", () => {
  const root = work();
  try {
    const reg = join(root, "registry.json");
    writeFileSync(
      reg,
      '{"schema":"0.20","seats":{"bob":{"status":"suspended","wide":9007199254740992}},"team":{"name":"alpha"}}\n',
    );
    writeFileSync(
      `${reg}.self-last-journal.wide.json`,
      '{"pre":{"bob":{"status":"active","wide":1}},"post":{"bob":{"status":"suspended","wide":9007199254740993}}}\n',
    );
    expect(rollbackSelfSnap({ registryPath: reg, runId: "wide" }).ran).toBe(true);
    const bytes = readFileSync(reg, "utf8");
    expect(bytes).toContain('"status": "suspended"');
    expect(bytes).toContain('"wide": 9007199254740992');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("equal wide ints still own the row and restore the pre-image (review round 1 C2 control)", () => {
  const root = work();
  try {
    const reg = join(root, "registry.json");
    writeFileSync(
      reg,
      '{"schema":"0.20","seats":{"bob":{"status":"suspended","wide":9007199254740993}},"team":{"name":"alpha"}}\n',
    );
    writeFileSync(
      `${reg}.self-last-journal.wide2.json`,
      '{"pre":{"bob":{"status":"active","wide":1}},"post":{"bob":{"status":"suspended","wide":9007199254740993}}}\n',
    );
    const result = rollbackSelfSnap({ registryPath: reg, runId: "wide2" });
    expect(result).toEqual({ ran: true, ok: true, crewRestored: [] });
    const bytes = readFileSync(reg, "utf8");
    expect(bytes).toContain('"status": "active"');
    expect(bytes).toContain('"wide": 1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("int vs float ownership follows python's exact int==float comparison (review round 1 C2 boundary)", () => {
  const root = work();
  try {
    const reg = join(root, "registry.json");
    // The double nearest 9007199254740993.0 IS 9007199254740992, so python
    // calls the int 9007199254740992 equal to the float 9007199254740993.0.
    writeFileSync(
      reg,
      '{"schema":"0.20","seats":{"bob":{"status":"suspended","wide":9007199254740992}},"team":{"name":"alpha"}}\n',
    );
    writeFileSync(
      `${reg}.self-last-journal.wide3.json`,
      '{"pre":{"bob":{"status":"active","wide":1}},"post":{"bob":{"status":"suspended","wide":9007199254740993.0}}}\n',
    );
    expect(rollbackSelfSnap({ registryPath: reg, runId: "wide3" }).ran).toBe(true);
    const bytes = readFileSync(reg, "utf8");
    expect(bytes).toContain('"status": "active"');
    expect(bytes).toContain('"wide": 1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollbackSelfSnap restores a deleted crew row only while absent and reports the compensating event row (tap-team-stop.sh L955-961)", () => {
  const root = work();
  try {
    const reg = join(root, "registry.json");
    const crewPre = row({ handle: "w1", session: "alpha/bob", pane: "pw", crew: true });
    seedRegistry(reg, { bob: row({ handle: "bob", session: "alpha/bob", status: "suspended", status_reason: "session_stopped" }) });
    const jrn = `${reg}.self-last-journal.run2.json`;
    writeFileSync(jrn, JSON.stringify({
      pre: { w1: crewPre },
      post: { w1: { _crew_deleted: true, parent: "bob" } },
    }));
    const result = rollbackSelfSnap({ registryPath: reg, runId: "run2" });
    expect(result).toEqual({
      ran: true, ok: true,
      crewRestored: [{ handle: "w1", pane: "pw", parent: "bob" }],
    });
    expect(existsSync(jrn)).toBe(false);
    expect(readJson(reg).seats.w1).toEqual(crewPre);
    // A crew row that came back on its own is left alone.
    const reg2 = join(root, "registry2.json");
    const alive = row({ handle: "w1", session: "alpha/bob", pane: "new-pane", crew: true });
    seedRegistry(reg2, { w1: alive });
    const jrn2 = `${reg2}.self-last-journal.run3.json`;
    writeFileSync(jrn2, JSON.stringify({ pre: { w1: crewPre }, post: { w1: { _crew_deleted: true, parent: "bob" } } }));
    expect(rollbackSelfSnap({ registryPath: reg2, runId: "run3" })).toEqual({ ran: true, ok: true, crewRestored: [] });
    expect(readJson(reg2).seats.w1).toEqual(alive);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed journal is class 3 and retained; an unusable registry or seat axis is class 4 and retained (tap-team-stop.sh L918-950)", () => {
  const root = work();
  try {
    const reg = join(root, "registry.json");
    seedRegistry(reg, { bob: row({ handle: "bob" }) });
    const bad = `${reg}.self-last-journal.bad.json`;
    writeFileSync(bad, "{not json");
    const r1 = rollbackSelfSnap({ registryPath: reg, runId: "bad" });
    expect(r1.ran && !r1.ok && r1.rc === 3 && r1.detail.startsWith("rollback journal unreadable (")).toBe(true);
    expect(existsSync(bad)).toBe(true);
    const shape = `${reg}.self-last-journal.shape.json`;
    writeFileSync(shape, '{"pre": {}, "post": 5}\n');
    const r2 = rollbackSelfSnap({ registryPath: reg, runId: "shape" });
    expect(r2.ran && !r2.ok && r2.rc === 3 && r2.detail.startsWith("rollback journal is malformed;")).toBe(true);
    expect(existsSync(shape)).toBe(true);
    const corrupt = join(root, "corrupt.json");
    writeFileSync(corrupt, "not json\n");
    const jrn3 = `${corrupt}.self-last-journal.c1.json`;
    writeFileSync(jrn3, '{"pre": {}, "post": {}}');
    const r3 = rollbackSelfSnap({ registryPath: corrupt, runId: "c1" });
    expect(r3.ran && !r3.ok && r3.rc === 4 && r3.detail.startsWith("the registry could not be read at rollback (")).toBe(true);
    expect(existsSync(jrn3)).toBe(true);
    const axis = join(root, "axis.json");
    writeFileSync(axis, '{"schema":"0.20","seats":[],"team":{}}\n');
    const jrn4 = `${axis}.self-last-journal.c2.json`;
    writeFileSync(jrn4, '{"pre": {}, "post": {}}');
    const r4 = rollbackSelfSnap({ registryPath: axis, runId: "c2" });
    expect(r4.ran && !r4.ok && r4.rc === 4).toBe(true);
    if (r4.ran && !r4.ok) expect(r4.detail).toContain("found {'seats': 'list'}");
    expect(existsSync(jrn4)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an absent journal means nothing is owed (tap-team-stop.sh L912-913)", () => {
  const root = work();
  try {
    expect(rollbackSelfSnap({ registryPath: join(root, "r.json"), runId: "never" })).toEqual({ ran: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clearSelfSnap removes only this run's journal (tap-team-stop.sh L1024-1028)", () => {
  const root = work();
  try {
    const reg = join(root, "registry.json");
    const mine = `${reg}.self-last-journal.mine.json`;
    const theirs = `${reg}.self-last-journal.theirs.json`;
    writeFileSync(mine, "{}");
    writeFileSync(theirs, "{}");
    clearSelfSnap(reg, "mine");
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(theirs)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitCrewRestored appends one crew_restored event per nonempty handle (tap-team-stop.sh L1015-1022)", () => {
  const root = work();
  try {
    const eventLog = join(root, "registry-events.log");
    emitCrewRestored({
      verb: "down",
      eventLog,
      team: "alpha",
      rows: [{ handle: "w1", pane: "pw", parent: "bob" }, { handle: "", pane: "skip", parent: "" }],
    });
    const lines = readFileSync(eventLog, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toContain("actor=team-down");
    expect(line).toContain("action=crew_restored");
    expect(line).toContain("handle=w1");
    expect(line).toContain("pane=pw");
    expect(line).toContain("detail=reason=self_kill_failed_parent=bob");
    expect(line).toContain("team=alpha");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the reaper keeps real evidence when the restore never ran, clears both files on success and drops only empty stubs on failure (tap-team-stop.sh L3197-3225)", () => {
  const root = work();
  try {
    const stub = join(root, "stub");
    writeFileSync(stub, "");
    writeFileSync(`${stub}.inflight`, "");
    reapArtifact({ path: stub, restoreRan: false, restoreRc: 0 });
    expect(existsSync(stub)).toBe(false);
    expect(existsSync(`${stub}.inflight`)).toBe(false);

    const evidence = join(root, "evidence");
    writeFileSync(evidence, '{"rows": {"bob": {}}}');
    writeFileSync(`${evidence}.inflight`, '{"rows": {"bob": {}}}');
    reapArtifact({ path: evidence, restoreRan: false, restoreRc: 0 });
    expect(existsSync(evidence)).toBe(true);
    expect(existsSync(`${evidence}.inflight`)).toBe(true);

    reapArtifact({ path: evidence, restoreRan: true, restoreRc: 0 });
    expect(existsSync(evidence)).toBe(false);
    expect(existsSync(`${evidence}.inflight`)).toBe(false);

    const failed = join(root, "failed");
    writeFileSync(failed, "");
    writeFileSync(`${failed}.inflight`, '{"rows": {"bob": {}}}');
    reapArtifact({ path: failed, restoreRan: true, restoreRc: 3 });
    expect(existsSync(failed)).toBe(false);
    expect(existsSync(`${failed}.inflight`)).toBe(true);

    reapArtifact({ path: "", restoreRan: true, restoreRc: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reset generation that exists but cannot be unlinked is class 1 on the delete path, registry retained (review r2)", () => {
  const root = work();
  try {
    const reg = join(root, "registry.json");
    seedRegistry(reg, { bob: row({ handle: "bob", session: "alpha/bob", pane: "p1", pane_id: "%1" }) });
    // A directory at the generation path makes unlink fail with EPERM/EISDIR
    // on every platform, deterministically, without needing root.
    mkdirSync(join(root, "reset-generation.json"));
    const result = clearRegistry({
      registryPath: reg, tapHome: root, keepSet: [], selfHandles: ["bob"], recoveryOut: "",
      selection: { mode: "", set: [] }, selfSession: "",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.cls).toBe(1);
    expect(result.detail).toContain("reset-generation.json");
    expect(existsSync(reg)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reset generation unlink failure is class 1 on the absent-registry path too — no raw throw from either clear path (review r2)", () => {
  const root = work();
  try {
    const reg = join(root, "registry.json");
    mkdirSync(join(root, "reset-generation.json"));
    const result = clearRegistry({
      registryPath: reg, tapHome: root, keepSet: [], selfHandles: ["bob"], recoveryOut: "",
      selection: { mode: "", set: [] }, selfSession: "",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.cls).toBe(1);
    expect(result.detail).toContain("reset-generation.json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoreSelfRows treats inherited-name handles as absent and restores them as own rows (review r2)", () => {
  const root = work();
  try {
    const reg = join(root, "registry.json");
    const rowsFile = join(root, "recovery", "self-row-aaa");
    mkdirSync(join(root, "recovery"), { recursive: true });
    const callerRow = row({ handle: "constructor", session: "alpha/boss", pane: "p1", pane_id: "%9" });
    writeFileSync(rowsFile, `${JSON.stringify({ team: { name: "alpha" }, schema: "0.20", seat_key: "seats", rows: { constructor: callerRow } }, null, 2)}\n`);
    // Registry absent: the rebuild path. "constructor" in {} is true through
    // Object.prototype, so a membership probe must not skip the row.
    const result = restoreSelfRows({ registryPath: reg, rowsFile });
    expect(result).toEqual({ ran: true, ok: true });
    const doc = readJson(reg);
    expect(Object.hasOwn(doc.seats, "constructor")).toBe(true);
    expect(doc.seats.constructor).toEqual(callerRow);
    expect(existsSync(rowsFile)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
