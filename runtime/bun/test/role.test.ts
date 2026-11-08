import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TapError, type ResolvedContext } from "../src/context";
import { observedRows } from "../src/roster-observation";
import { cmdRole, parseRoleArgs, roleNoticeArgs, type RoleActor, type RoleEffects } from "../src/verbs/role";
import { handleCell, leadersFirst } from "../src/verbs/team";

const root = realpathSync(mkdtempSync(join(tmpdir(), "tap-role-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
// `--json` marks the process for JSON errors, as the router does; never leak it into later files.
const jsonBefore = process.env.TAP_JSON;
afterEach(() => { if (jsonBefore === undefined) delete process.env.TAP_JSON; else process.env.TAP_JSON = jsonBefore; });

let n = 0;
function fixture(seats: Record<string, Record<string, unknown>>, actor: RoleActor = { team: "t", handle: "lead" },
  sendRc = 0) {
  const bus = join(root, `bus-${++n}`);
  mkdirSync(bus, { recursive: true });
  const registry = join(bus, "registry.json");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "t" }, seats }));
  const ctx = { team: "t", registryPath: registry, bus: { home: bus }, root, marker: "live" } as unknown as ResolvedContext;
  const out: string[] = [], events: Array<Record<string, string>> = [], notices: Array<{ to: string; reason: string; evidence: string }> = [];
  let actorCalls = 0;
  const fx: RoleEffects = {
    context: () => ctx,
    actor: () => { actorCalls++; return actor; },
    notice: () => ({ send: (to, reason, evidence) => { notices.push({ to, reason, evidence }); return { rc: sendRc, disposition: "injected" }; } }),
    event: (_ctx, fields) => { events.push(fields); },
    out: text => { out.push(text); },
  };
  const seat = (handle: string) => (JSON.parse(readFileSync(registry, "utf8")).seats[handle] ?? {}) as Record<string, unknown>;
  return { fx, out, events, notices, seat, registry, bus, actorCalls: () => actorCalls };
}

const seats = () => ({
  lead: { status: "active", harness: "claude", pane: "t/lead:0.0", instance: "lead|1", custom: "kept" },
  peer: { status: "active", harness: "codex", pane: "t/peer:0.0", instance: "peer|1" },
  gone: { status: "offline", harness: "codex", pane: "t/gone:0.0" },
  daemon: { status: "active", harness: "daemon" },
});

test("parse: seat first, one lowercase role or --unset, and refusals name the fix", () => {
  expect(parseRoleArgs(["opus", "leader"])).toMatchObject({ seat: "opus", role: "leader", unset: false });
  expect(parseRoleArgs(["opus", "--unset", "--team", "x"])).toMatchObject({ seat: "opus", unset: true, team: "x" });
  expect(parseRoleArgs([])).toMatchObject({ seat: "", role: "" });
  const refuse = (argv: string[], text: string) => {
    let error: unknown;
    try { parseRoleArgs(argv); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(TapError);
    expect((error as TapError).detail).toContain(text);
  };
  expect(parseRoleArgs(["opus", "LEADER"]).role).toBe("leader");
  refuse(["opus", "lead er"], "is not a role");
  refuse(["opus", "x".repeat(33)], "at most 32");
  refuse(["opus", "leader", "--unset"], "not both");
  refuse(["--unset"], "name the seat first");
  refuse(["opus", "leader", "extra"], "unexpected argument");
  refuse(["opus", "--dry-run"], "previews a change");
  refuse(["opus", "--bogus"], "unknown option");
});

test("set writes only the role field, is idempotent, and records one event", () => {
  const f = fixture(seats());
  expect(cmdRole(["peer", "leader"], f.fx)).toBe(0);
  expect(f.seat("peer").role).toBe("leader");
  expect(f.seat("lead").custom).toBe("kept");
  expect(f.out.join("")).toContain("peer changed: none -> leader");
  expect(f.events).toEqual([{ actor: "lead", handle: "peer", pane: "t/peer:0.0", detail: "none->leader" }]);
  expect(f.notices).toEqual([]);
  expect(cmdRole(["peer", "leader"], f.fx)).toBe(0);
  expect(f.out.at(-1)).toContain("peer unchanged: leader");
  expect(f.events).toHaveLength(1);
});

test("removing another seat's leader role notifies it; self-removal and non-leader changes do not", () => {
  const f = fixture({ ...seats(), peer: { ...seats().peer, role: "leader" }, lead: { ...seats().lead, role: "leader" } });
  expect(cmdRole(["peer", "--unset"], f.fx)).toBe(0);
  expect(f.seat("peer").role).toBeUndefined();
  expect(f.notices).toEqual([{ to: "t/peer", reason: "lead removed your leader role on team t.", evidence: "You hold no role now." }]);
  expect(f.out.at(-1)).toContain("notice to peer sent (injected)");
  expect(cmdRole(["lead", "--unset"], f.fx)).toBe(0);
  expect(f.notices).toHaveLength(1);
  expect(cmdRole(["peer", "reviewer"], f.fx)).toBe(0);
  expect(cmdRole(["peer", "driver"], f.fx)).toBe(0);
  expect(f.notices).toHaveLength(1);
});

test("replacing a leader role notifies; the operator and a same-named seat on another team are other actors", () => {
  const operator = fixture({ ...seats(), peer: { ...seats().peer, role: "leader" } }, { team: "", handle: "user" });
  expect(cmdRole(["peer", "reviewer"], operator.fx)).toBe(0);
  expect(operator.notices[0]).toEqual({ to: "t/peer", reason: "The operator removed your leader role on team t.", evidence: "Your role is now: reviewer." });
  const twin = fixture({ ...seats(), peer: { ...seats().peer, role: "leader" } }, { team: "other", handle: "peer" });
  expect(cmdRole(["peer", "--unset"], twin.fx)).toBe(0);
  expect(twin.notices[0]!.reason).toBe("other/peer removed your leader role on team t.");
  expect(twin.events[0]!.actor).toBe("other/peer");
});

test("a notice TAP cannot confirm keeps the committed role and says unconfirmed", () => {
  const f = fixture({ ...seats(), peer: { ...seats().peer, role: "leader" } }, { team: "t", handle: "lead" }, 5);
  expect(cmdRole(["peer", "--unset"], f.fx)).toBe(0);
  expect(f.seat("peer").role).toBeUndefined();
  expect(f.out.at(-1)).toContain("notice to peer delivery unconfirmed (rc 5)");
  expect(f.out.at(-1)).not.toContain("not delivered");
});

test("inactive rows take a role; unknown and daemon seats refuse with nothing written", () => {
  const f = fixture({ ...seats(), gone: { ...seats().gone, role: "leader" } });
  expect(cmdRole(["gone", "--unset"], f.fx)).toBe(0);
  expect(f.seat("gone").role).toBeUndefined();
  const before = readFileSync(f.registry, "utf8");
  expect(() => cmdRole(["ghost", "leader"], f.fx)).toThrow("no seat 'ghost'");
  expect(() => cmdRole(["daemon", "leader"], f.fx)).toThrow("takes no role");
  expect(readFileSync(f.registry, "utf8")).toBe(before);
});

test("an unobservable caller changes nothing: the actor resolves before the write", () => {
  const f = fixture(seats());
  f.fx.actor = () => { throw new TapError(1, "caller_unobservable", "x", "cannot tell who is calling"); };
  const before = readFileSync(f.registry, "utf8");
  expect(() => cmdRole(["peer", "leader"], f.fx)).toThrow("cannot tell who is calling");
  expect(readFileSync(f.registry, "utf8")).toBe(before);
});

test("dry run resolves the actor like a real run but writes, events and notifies nothing", () => {
  const f = fixture({ ...seats(), peer: { ...seats().peer, role: "leader" } });
  expect(cmdRole(["peer", "--unset", "--dry-run"], f.fx)).toBe(0);
  expect(f.seat("peer").role).toBe("leader");
  expect(f.out.at(-1)).toContain("peer would change: leader -> none");
  expect([f.events, f.notices, f.actorCalls()]).toEqual([[], [], 1]);
  f.fx.actor = () => { throw new TapError(1, "caller_unobservable", "x", "cannot tell who is calling"); };
  expect(() => cmdRole(["peer", "--unset", "--dry-run"], f.fx)).toThrow("cannot tell who is calling");
});

test("read lists leaders first, one seat's role, and JSON", () => {
  const f = fixture({ ...seats(), peer: { ...seats().peer, role: "reviewer" }, lead: { ...seats().lead, role: "leader" } });
  expect(cmdRole([], f.fx)).toBe(0);
  expect(f.out.at(-1)).toBe("lead  leader\npeer  reviewer\n");
  expect(cmdRole(["gone"], f.fx)).toBe(0);
  expect(f.out.at(-1)).toBe("gone: none\n");
  expect(cmdRole(["lead", "--json"], f.fx)).toBe(0);
  expect(JSON.parse(f.out.at(-1)!)).toEqual({ team: "t", handle: "lead", role: "leader" });
  const empty = fixture(seats());
  expect(cmdRole([], empty.fx)).toBe(0);
  expect(empty.out.at(-1)).toContain("no seat on team 't' has a role");
});

test("roster: role projects from the row, leaders sort first, and the handle carries the label", () => {
  const rows = observedRows([
    { handle: "b", status: "active", harness: "codex", role: "reviewer" },
    { handle: "a", status: "active", harness: "claude" },
    { handle: "c", status: "active", harness: "claude", role: "leader" },
    { handle: "d", status: "active", harness: "daemon", role: "leader" },
    { handle: "e", status: "active", harness: "claude", role: "Bad Role" },
  ] as never, new Map(), "", {});
  expect(rows.map(row => row.role)).toEqual(["reviewer", "", "leader", "leader", ""]);
  expect(leadersFirst(rows).map(row => row.handle)).toEqual(["c", "b", "a", "e", "d"]);
  const tty = process.stdout.isTTY;
  try {
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    expect(handleCell({ handle: "c", role: "leader" })).toBe("c (leader)");
    expect(handleCell({ handle: "a", role: "" })).toBe("a");
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    const saved = process.env.NO_COLOR, term = process.env.TERM;
    delete process.env.NO_COLOR; process.env.TERM = "xterm";
    expect(handleCell({ handle: "c", role: "leader" })).toBe("\x1b[1mc (leader)\x1b[0m");
    expect(handleCell({ handle: "b", role: "reviewer" })).toBe("b (reviewer)");
    process.env.NO_COLOR = "";
    expect(handleCell({ handle: "c", role: "leader" })).toBe("c (leader)");
    if (saved === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved;
    if (term === undefined) delete process.env.TERM; else process.env.TERM = term;
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true });
  }
});

test("the real roster read carries role from the registry file into tap team's rows and JSON", async () => {
  const { readRegistry } = await import("../src/verbs/team");
  const registry = join(root, "roster-read.json");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "t" }, seats: {
    a: { status: "active", harness: "claude" },
    b: { status: "active", harness: "codex", role: "leader" },
  } }));
  const read = readRegistry(registry, false, false);
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  const rows = observedRows(read.rows ?? [], new Map(), "", {});
  expect(rows.map(row => [row.handle, row.role])).toEqual([["a", ""], ["b", "leader"]]);
  expect(leadersFirst(rows).map(row => row.handle)).toEqual(["b", "a"]);
});

test("a role write joins reset custody: a fenced bus refuses unchanged, and a pristine generation is marked reused", () => {
  const fenced = fixture(seats());
  writeFileSync(join(fenced.bus, "reset.fence.json"), JSON.stringify({ pid: 1, boot_id: "b", owner_start: 1, token: "t", phase: "drain" }));
  const before = readFileSync(fenced.registry, "utf8");
  expect(() => cmdRole(["peer", "leader"], fenced.fx)).toThrow(/reset|fence/);
  expect(readFileSync(fenced.registry, "utf8")).toBe(before);
  const pristine = fixture(seats());
  writeFileSync(join(pristine.bus, "reset-generation.json"), JSON.stringify({ state: "pristine" }));
  expect(cmdRole(["peer", "leader"], pristine.fx)).toBe(0);
  expect(JSON.parse(readFileSync(join(pristine.bus, "reset-generation.json"), "utf8"))).toMatchObject({ state: "reused", first_mutation: "tap role" });
  const noop = fixture({ ...seats(), peer: { ...seats().peer, role: "leader" } });
  writeFileSync(join(noop.bus, "reset-generation.json"), JSON.stringify({ state: "pristine" }));
  expect(cmdRole(["peer", "leader"], noop.fx)).toBe(0);
  expect(JSON.parse(readFileSync(join(noop.bus, "reset-generation.json"), "utf8")).state).toBe("pristine");
});

test("--json selects JSON errors before parsing, so a refused argv still answers in JSON", () => {
  delete process.env.TAP_JSON;
  expect(() => cmdRole(["--json", "peer", "bad role"])).toThrow("is not a role");
  expect(String(process.env.TAP_JSON)).toBe("1");
});

test("the removal notice is pinned to the changed team's bus, not the caller's cwd", () => {
  const ctx = { team: "t", registryPath: join(root, "x.json"), bus: { home: join(root, "team-bus") }, root, marker: "live" } as unknown as ResolvedContext;
  const args = roleNoticeArgs(ctx, "t/peer", "r", "e");
  expect(args).toMatchObject({ bus: join(root, "team-bus"), to: "t/peer", template: "role-removed.md", quiet: true });
  expect(args.env?.TAP_HOME).toBe(join(root, "team-bus"));
});
