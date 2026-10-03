import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chooseAttachSelection, pickerModel } from "../src/attach-picker";
import { TapError } from "../src/context";
import { observe } from "../src/team-observe";
const inspect: typeof observe = rows => ({ code: 0, serverEpoch: "test", rows: new Map(rows.map(row => [String(row.handle),
  row.status === "active" && (row.session === "t/a" || row.pane === "t/a:1.0")
    ? ["active", "", "t/a:1.0", "%1"] : ["suspended"]])) });
const root = realpathSync(mkdtempSync(join(tmpdir(), "picker-model-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
// A live machine marker. Each registry lives OUTSIDE its root's .tap/bus so the
// model can only find it through the live doc's registry_location.
const enroll = (index: string, teams: Record<string, Record<string, string>>) =>
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams }));
test("native model reads enrolled teams, excludes poll/inactive/dead seats, retains crew", () => {
  const index = join(root, "index"), repo = join(root, "repo"), bus = join(root, "bus"), bin = join(root, "bin");
  for (const dir of [index, repo, bus, bin]) mkdirSync(dir, { recursive: true });
  const reg = join(bus, "registry.json"), reg2 = join(bus, "daemon-registry.json");
  enroll(index, { t: { root: repo, registry_location: reg, state: "registered" }, old: { root: repo, registry_location: reg, state: "historical" },
    d: { root: repo, registry_location: reg2, state: "registered" } });
  writeFileSync(reg, JSON.stringify({ schema: "0.20", team: { name: "t" }, seats: {
    a: { status: "active", session: "t/a", harness: "claude", instance: "a|one", registered_at: "2026-09-25T00:00:00Z" },
    crew: { status: "active", pane: "t/a:1.0", crew: true },
    dead: { status: "active", session: "t/dead" },
    poll: { status: "active", session: "t/a", delivery: "poll" },
    daemon: { status: "active", session: "t/a", harness: "daemon" },
    away: { status: "offline", session: "t/a" },
  } }));
  writeFileSync(reg2, JSON.stringify({ schema: "0.20", team: { name: "d" }, seats: {
    only: { status: "active", session: "d/only", harness: "daemon" },
  } }));
  writeFileSync(join(bin, "tmux"), '#!/bin/sh\nprintf "t/a\\n"\n', { mode: 0o755 });
  const env = { ...process.env, TAP_INDEX_HOME: index, PATH: `${bin}:${process.env.PATH}` };
  const model = pickerModel(env, inspect);
  expect(model.observable).toBe(true);
  expect(model.teams.map(team => team.name)).toEqual(["d", "old", "t"]);
  expect(model.teams[0]!.state).toBe("ok");
  expect(model.teams[0]!.seats).toEqual([]);
  expect(model.teams[1]!.state).toBe("historical");
  expect(model.teams[2]!.seats.map(s => s.handle)).toEqual(["a", "crew"]);
  expect(model.teams[2]!.seats[1]!.crew).toBe(true);
  expect(model.teams[2]!.root).toBe(repo);
  expect(model.teams[2]!.registry).toBe(reg);
  expect(model.teams[2]!.seats[0]!.identity).toMatchObject({ instance: "a|one", observedPane: "t/a:1.0", observedPaneId: "%1" });
  writeFileSync(reg, "broken json");
  expect(pickerModel(env, inspect).teams[2]!.state).toBe("corrupt");
});

test("picker steps offer only live seats and only teams holding one", async () => {
  const index = join(root, "offer-index"), repo = join(root, "offer-repo"), bus = join(root, "offer-bus"), bin = join(root, "offer-bin");
  for (const dir of [index, repo, bus, bin]) mkdirSync(dir, { recursive: true });
  const reg = join(bus, "registry.json"), reg2 = join(bus, "daemon-registry.json");
  enroll(index, { t: { root: repo, registry_location: reg, state: "registered" },
    d: { root: repo, registry_location: reg2, state: "registered" } });
  writeFileSync(reg, JSON.stringify({ schema: "0.20", team: { name: "t" }, seats: {
    a: { status: "active", session: "t/a", harness: "claude", instance: "a|one", registered_at: "2026-09-25T00:00:00Z" },
    poll: { status: "active", session: "t/a", delivery: "poll" },
    daemon: { status: "active", session: "t/a", harness: "daemon" },
    away: { status: "offline", session: "t/a" },
  } }));
  writeFileSync(reg2, JSON.stringify({ schema: "0.20", team: { name: "d" }, seats: {
    only: { status: "active", session: "d/only", harness: "daemon" },
  } }));
  writeFileSync(join(bin, "tmux"), '#!/bin/sh\nprintf "t/a\\n"\n', { mode: 0o755 });
  const env = { ...process.env, TAP_INDEX_HOME: index, PATH: `${bin}:${process.env.PATH}` };
  const model = pickerModel(env, inspect);
  // Team step: the daemon-only team is not offered; only t is.
  const teamLabels: string[] = [];
  const teamOffer: ReturnType<typeof chooseAttachSelection> = chooseAttachSelection(model, async rows => {
    teamLabels.push(...rows.map(row => row.label));
    return { kind: "cancelled" };
  });
  await expect(teamOffer).resolves.toEqual({ kind: "cancelled" });
  expect(teamLabels).toEqual(["t  1 live seats"]);
  // Seat step: the live seat is offered; daemon, poll and offline rows are not.
  let seatLabels: string[] = [];
  const picked = await chooseAttachSelection(model, async (rows, options) => {
    if (options.prompt === "Team > ") return { kind: "selected", values: [rows[0]!.value] };
    seatLabels = rows.map(row => row.label);
    return { kind: "cancelled" };
  });
  expect(picked).toEqual({ kind: "cancelled" });
  expect(seatLabels.map(label => label.split("  ")[0])).toEqual(["a"]);
  // A machine whose only team holds daemon seats alone refuses: never an empty picker.
  const index2 = join(root, "fleet-index"), repo2 = join(root, "fleet-repo"), bus2 = join(root, "fleet-bus");
  for (const dir of [index2, repo2, bus2]) mkdirSync(dir, { recursive: true });
  const reg3 = join(bus2, "registry.json");
  enroll(index2, { d2: { root: repo2, registry_location: reg3, state: "registered" } });
  writeFileSync(reg3, JSON.stringify({ schema: "0.20", team: { name: "d2" }, seats: {
    only: { status: "active", session: "d2/only", harness: "daemon" } } }));
  const emptyFleet = pickerModel({ ...env, TAP_INDEX_HOME: index2 }, inspect);
  await expect(chooseAttachSelection(emptyFleet, async () => { throw new Error("picker must not open"); }))
    .rejects.toMatchObject({ errorClass: "no_candidates" });
});

test("an observation failure never offers a daemon-only team as unobservable", async () => {
  const failed: typeof observe = () => ({ code: 1, serverEpoch: "", rows: new Map() });
  const index = join(root, "unob-index"), repo = join(root, "unob-repo"), bus = join(root, "unob-bus"), bin = join(root, "unob-bin");
  for (const dir of [index, repo, bus, bin]) mkdirSync(dir, { recursive: true });
  const reg = join(bus, "registry.json"), reg2 = join(bus, "daemon-registry.json");
  enroll(index, { t: { root: repo, registry_location: reg, state: "registered" },
    d: { root: repo, registry_location: reg2, state: "registered" } });
  writeFileSync(reg, JSON.stringify({ schema: "0.20", team: { name: "t" }, seats: {
    a: { status: "active", session: "t/a", harness: "claude", instance: "a|one", registered_at: "2026-09-25T00:00:00Z" } } }));
  writeFileSync(reg2, JSON.stringify({ schema: "0.20", team: { name: "d" }, seats: {
    only: { status: "active", session: "d/only", harness: "daemon" } } }));
  writeFileSync(join(bin, "tmux"), '#!/bin/sh\nprintf "t/a\\n"\n', { mode: 0o755 });
  const env = { ...process.env, TAP_INDEX_HOME: index, PATH: `${bin}:${process.env.PATH}` };
  const model = pickerModel(env, failed);
  const d = model.teams.find(team => team.name === "d")!;
  const t = model.teams.find(team => team.name === "t")!;
  expect(d.state).toBe("ok");
  expect(d.seats).toEqual([]);
  expect(t.state).toBe("unobservable");
  const labels: string[] = [];
  await expect(chooseAttachSelection(model, async rows => {
    labels.push(...rows.map(row => row.label));
    return { kind: "cancelled" };
  })).resolves.toEqual({ kind: "cancelled" });
  expect(labels).toEqual(["t  unobservable: seat classifier could not observe this team"]);
});

test("no machine index refuses unanchored_bus; legacy teams.json is never read", () => {
  const index = join(root, "absent-index"), repo = join(root, "absent-repo");
  for (const dir of [index, join(repo, ".tap/bus")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(index, "teams.json"), JSON.stringify({ teams: { t: { root: repo } } }));
  writeFileSync(join(repo, ".tap/bus/registry.json"), JSON.stringify({ schema: "0.20", team: { name: "t" }, seats: {} }));
  let caught: unknown;
  try { pickerModel({ ...process.env, TAP_INDEX_HOME: index }); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(TapError);
  const refusal = caught as TapError;
  expect(refusal.errorClass).toBe("unanchored_bus");
  expect(refusal.action).toBe("tap init  OR  tap session launch");
  expect(refusal.detail).toBe("no machine index (global-registry.json); this machine has no enrolled team");
});

test("an invalid byte in the acting registry is unreadable, never corrupt", () => {
  const index = join(root, "u8-index"), repo = join(root, "u8-repo"), bus = join(root, "u8-bus"), bin = join(root, "u8-bin");
  for (const dir of [index, repo, bus, bin]) mkdirSync(dir, { recursive: true });
  const reg = join(bus, "registry.json");
  enroll(index, { t: { root: repo, registry_location: reg, state: "registered" } });
  writeFileSync(join(bin, "tmux"), '#!/bin/sh\nprintf "t/a\\n"\n', { mode: 0o755 });
  const env = { ...process.env, TAP_INDEX_HOME: index, PATH: `${bin}:${process.env.PATH}` };
  const withNote = (byte: Buffer) => Buffer.concat([
    Buffer.from('{"schema":"0.20","team":{"name":"t"},"note":"caf'), byte,
    Buffer.from('r","seats":{"a":{"status":"active","session":"t/a","harness":"claude"}}}'),
  ]);
  // A valid multibyte note changes nothing: the seat stays visible.
  writeFileSync(reg, withNote(Buffer.from([0xc3, 0xa9])));
  const healthy = pickerModel(env, inspect);
  expect(healthy.teams[0]!.state).toBe("ok");
  expect(healthy.teams[0]!.seats.map(s => s.handle)).toEqual(["a"]);
  // A raw invalid byte, not U+FFFD: a lax decode would admit the seat.
  writeFileSync(reg, withNote(Buffer.from([0xe9])));
  const model = pickerModel(env, inspect);
  expect(model.teams[0]!.state).toBe("unreadable");
  expect(model.teams[0]!.detail).toBe("acting registry cannot be read");
  expect(model.teams[0]!.seats).toEqual([]);
  // A leading BOM is preserved by the strict reader, so JSON.parse refuses it
  // as corrupt — the same classification the lax reader already gave.
  writeFileSync(reg, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"schema":"0.20","team":{"name":"t"},"seats":{}}')]));
  expect(pickerModel(env, inspect).teams[0]!.state).toBe("corrupt");
});
