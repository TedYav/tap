import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { forwardingGrant, forwardingRoute } from "../src/forwarding";
import { loadRegistry, parsePreservingBigint, saveRegistry, seatMap, type RegistryDoc } from "../src/registry";
import { selectCaller } from "../src/selector";
import { reserveTransaction, rollbackOwned, type FailureEvidence, type LaunchRecord } from "../src/launcher/transaction";

const repo = resolve(import.meta.dir, "../../..");
const original = { ...process.env };
const roots: string[] = [];
const edge = { source: "a", source_instance: "a|one", destination: "b", destination_instance: "b|one",
  at: "2026-09-07T00:00:00Z", address_active: true };

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Reserve seat `a` through the shared launch transaction (kind "new"), no pane.
async function reserveSeatA(root: string): Promise<FailureEvidence> {
  const selection = selectCaller({ cwd: root, env: { ...process.env, TAP_HOME: undefined }, verbClass: "lifecycle" });
  const record: LaunchRecord = { name: "fixture/a", harness: "claude", cwd: root, base: "fixture", tag: "a", index: 1, ensure_action: "new" };
  const evidence: FailureEvidence = { selection, handle: "a", token: "", instance: null, record, vessel: null,
    backup: { status: "not-needed" }, reason: "session_replaced", output_path: "" };
  await reserveTransaction(selection, { kind: "new", record, live_sessions: [] }, evidence, process.env);
  return evidence;
}

function fixture() {
  const scratch = realpathSync(mkdtempSync("/tmp/tap-forward-register-"));
  roots.push(scratch);
  const root = join(scratch, "fixture"), index = join(scratch, "index");
  const registry = join(root, ".tap/team-registry.json");
  for (const dir of [join(root, ".tap/bus"), index, join(scratch, ".config/tap")]) mkdirSync(dir, { recursive: true });
  const git = spawnSync("git", ["init", "-q", root], { encoding: "utf8" });
  expect(git.status).toBe(0);
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture", worktree_root: root },
    seats: { b: { instance: "b|one", status: "active", delivery: "poll" } }, seat_forwardings: [edge] }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    fixture: { root, registry_location: registry, state: "registered" },
  } }));
  writeFileSync(join(scratch, ".config/tap/config.toml"), 'version = 3\n[presets.testseat]\nharness = "claude"\n');
  Object.assign(process.env, { HOME: scratch, XDG_CONFIG_HOME: join(scratch, ".config"), TAP_INDEX_HOME: index,
    TAP_HOME: join(root, ".tap/bus"), TAP_SESSION_MANIFEST: join(scratch, "sessions.json"),
    TAP_VERSION_SEEN_PATH: join(scratch, "version.json"), TAP_SKIP_VERSION_BRIEFING: "1",
    TAP_TMUX_SOCKET: `forward-register-${process.pid}` });
  for (const key of ["TMUX", "TMUX_PANE", "TAP_SELF", "TAP_HANDLE", "TAP_CLEAR_ID", "TAP_RESTORE_INSTANCE",
    "TAP_FRESH_INSTANCE", "TAP_TMUX_SOCKET_PATH", "TAP_LOCK_DIR"]) delete process.env[key];
  return { root, registry };
}

function run(root: string, command: string, args: string[]) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, encoding: "utf8", timeout: 20_000 });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: expect.any(String) });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result;
}

function assertRetiredAlias(doc: RegistryDoc) {
  expect(doc.seat_forwardings).toEqual([{ ...edge, address_active: false }]);
  expect(forwardingGrant(doc, "b", "a", "a|one")).toBe("a");
  expect(forwardingRoute(doc, "a", "a|one", true).target).toBe("b");
}

test("public poll registration permanently supersedes old address routing after ordinary out", async () => {
  const f = fixture();
  expect(forwardingRoute(loadRegistry(f.registry), "a").target).toBe("b");
  run(f.root, "bash", [join(repo, "bin/tap"), "register", "a", "--delivery", "poll", "--team", "fixture"]);
  const reused = loadRegistry(f.registry);
  expect(seatMap(reused).a!.instance).not.toBe("a|one");
  assertRetiredAlias(reused);
  expect(forwardingRoute(reused, "a").target).toBe("a");
  run(f.root, "bash", [join(repo, "bin/tap"), "out", "a"]);
  const retired = loadRegistry(f.registry);
  expect(seatMap(retired).a).toBeUndefined();
  assertRetiredAlias(retired);
  expect(forwardingRoute(retired, "a")).toMatchObject({ target: "a", instance: "", adopted_from: "" });
  const send = spawnSync("bash", [join(repo, "bin/tap"), "send", "a", "--from", "b", "-m", "new traffic", "--json"],
    { cwd: f.root, env: process.env, encoding: "utf8", timeout: 20_000 });
  expect(send.status).toBe(1);
  expect(JSON.parse(send.stdout).error_class).toBe("unknown_recipient");
}, 30_000);

test("tap-kwjba: an unrelated large integer riding inside seat_forwardings survives supersession exactly", async () => {
  const f = fixture();
  const raw = JSON.stringify({ schema: "0.20", team: { name: "fixture", worktree_root: f.root },
    seats: { b: { instance: "b|one", status: "active", delivery: "poll" } }, seat_forwardings: [{ ...edge }] });
  // 9007199254740993 exceeds Number.MAX_SAFE_INTEGER; a plain numeric literal
  // or JSON.stringify round trip would already have rounded it before this
  // string existed, so the digits are spliced in as raw text instead.
  const seeded = raw.replace('"address_active":true}', '"address_active":true,"extension_marker":9007199254740993}');
  expect(seeded).not.toBe(raw);
  writeFileSync(f.registry, seeded);
  run(f.root, "bash", [join(repo, "bin/tap"), "register", "a", "--delivery", "poll", "--team", "fixture"]);
  const after = readFileSync(f.registry, "utf8");
  expect(after).toContain("9007199254740993");
  expect(after).not.toContain("9007199254740992");
  const parsed = parsePreservingBigint(after) as RegistryDoc;
  const row = (parsed.seat_forwardings as Record<string, unknown>[])[0]!;
  expect(row.extension_marker).toBe(9007199254740993n);
  expect(row.address_active).toBe(false);
}, 30_000);

test("launch reservation and rollback cannot reactivate a reused address alias", async () => {
  const f = fixture();
  const claim = await reserveSeatA(f.root);
  expect(seatMap(loadRegistry(f.registry)).a!.status).toBe("pending");
  assertRetiredAlias(loadRegistry(f.registry));
  expect(await rollbackOwned(claim, null, process.env, false)).toBe(true);
  const retired = loadRegistry(f.registry);
  assertRetiredAlias(retired);
  expect(forwardingRoute(retired, "a").adopted_from).toBe("");
});

test("shared reservation preserves alias retirement and lossless metadata", async () => {
  const f = fixture();
  const before = readFileSync(f.registry, "utf8");
  writeFileSync(f.registry, before.replace(/^\{/, '{"future_metadata":{"large":9007199254740993,"decimal":1.25},'));
  await reserveSeatA(f.root);
  const raw = readFileSync(f.registry, "utf8");
  expect(raw).toContain('9007199254740993');
  expect(raw).toContain('1.25');
  const doc = JSON.parse(raw);
  expect(doc.seats.a.status).toBe("pending");
  assertRetiredAlias(doc);
});

test("any stored source row supersedes aliases while unrelated history is retained", async () => {
  const f = fixture();
  for (const row of [{ status: "suspended" }, { status: "pending" }, null]) {
    const doc = JSON.parse(readFileSync(f.registry, "utf8"));
    doc.seats.a = row;
    doc.seat_forwardings = [{ ...edge }, { ...edge, source: "c", source_instance: "c|one" }];
    saveRegistry(f.registry, doc);
    const saved = loadRegistry(f.registry);
    expect(saved.seat_forwardings).toEqual([{ ...edge, address_active: false },
      { ...edge, source: "c", source_instance: "c|one" }]);
  }
});
