import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { liveSeat, stopExactPane, ownedCrewRows, parseSeatOptions, seatSnapshot, validateDurable } from "../src/seat-updown";
import { removeScratchTree } from "./support/scratch";

const repo = resolve(import.meta.dir, "../../..");
const roots: string[] = [];
const servers: NodeJS.ProcessEnv[] = [];
function tm(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync("tmux", ["-L", env.TAP_TMUX_SOCKET!, ...args], { env, encoding: "utf8" });
}
afterEach(() => {
  for (const env of servers.splice(0)) tm(env, "kill-server");
  for (const root of roots.splice(0)) removeScratchTree(root);
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tap-updown.")));
  roots.push(root);
  const index = join(root, "index");
  const bus = join(root, ".tap", "bus");
  const registry = join(root, ".tap", "team-registry.json");
  mkdirSync(index); mkdirSync(bus, { recursive: true });
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", migrated: {}, teams: {
    team: { root, registry_location: registry, state: "registered", enrolled_at: "2026-09-01T00:00:00Z" },
  } }));
  const env: NodeJS.ProcessEnv = { ...process.env, TAP_HOME: bus, TAP_INDEX_HOME: index,
    TAP_SESSION_MANIFEST: join(root, "sessions.json"), TAP_TMUX_SOCKET: `updown-${process.pid}-${roots.length}`,
    TAP_TMUX_SOCKET_PATH: undefined, TMUX: undefined, TMUX_PANE: undefined, TAP_SELF: undefined,
    TAP_SERVER_EPOCH: undefined, TAP_BOOT_ID: undefined,
  };
  servers.push(env);
  const put = (seats: Record<string, unknown>) => {
    const epoch = tm(env, "display-message", "-p", "#{pid}:#{start_time}").stdout.trim();
    const socket = tm(env, "display-message", "-p", "#{socket_path}").stdout.trim();
    const stamped = Object.fromEntries(Object.entries(seats).map(([handle, raw]) => {
      const value = raw as Record<string, unknown>;
      return [handle, value.delivery === "poll" ? value : { instance: `${handle}|fixture`,
        ...(/^\d+:\d+$/.test(epoch) ? { server_epoch: `srv:${epoch}`, server_socket: socket } : {}), ...value }];
    }));
    writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "team", worktree_root: root }, seats: stamped }));
  };
  const get = () => JSON.parse(readFileSync(registry, "utf8"));
  const run = (...args: string[]) => spawnSync(process.execPath, [join(repo, "runtime/bun/main.ts"), ...args], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
  put({});
  return { root, index, bus, registry, env, put, get, run };
}
const row = (pane = "%1") => ({ session: "team/seat", pane_id: pane, status: "active", harness: "codex", instance: "seat|stable", harness_session_id: "native-id", model: "stored-model", passthrough: ["-c", 'service_tier="fast"'] });
const snapshot = { epoch: "srv:1:2", panes: [{ id: "%1", session: "team/seat", sessionId: "$1", window: "@1", rawEpoch: "1:2" }] };

test("one exact target; no unknown flag or second selector widening", () => {
  expect(parseSeatOptions(["team/seat", "--json"])).toEqual({ target: "team/seat", json: true, dryRun: false });
  for (const args of [[], ["seat", "other"], ["--only", "seat"], ["seat", "--team"]]) expect(() => parseSeatOptions(args)).toThrow();
  expect(() => validateDurable(undefined, "codex", "team", "up")).toThrow("tap session launch");
  expect(() => validateDurable({ ...row(), crew: true }, "seat", "team", "down")).toThrow("ephemeral");
  expect(() => validateDurable({ ...row(), delivery: "poll" }, "seat", "team", "up")).toThrow("poll");
});

test("wrong pane, reused session and old generation cannot authorize a stop", () => {
  expect(liveSeat(row(), "team/seat", snapshot)?.id).toBe("%1");
  expect(() => liveSeat(row("%99"), "team/seat", snapshot)).toThrow("reused name");
  expect(() => liveSeat({ ...row(), server_epoch: "srv:old" }, "team/seat", snapshot)).toThrow("generation");
  expect(() => liveSeat(row(), "team/seat", { ...snapshot, panes: [
    { ...snapshot.panes[0]!, id: "%2" }, { ...snapshot.panes[0]!, session: "foreign", sessionId: "$2" },
  ] })).toThrow("pane_live_elsewhere");
});

test("failed observation is not an idempotent stopped result", () => {
  expect(() => seatSnapshot(() => ({ code: 1, stdout: "", stderr: "connection refused" }))).toThrow("cannot observe");
  expect(seatSnapshot(() => ({ code: 1, stdout: "", stderr: "no server running on /tmp/private" })).panes).toEqual([]);
  expect(() => seatSnapshot(() => ({ code: 0, stdout: "garbage", stderr: "" }))).toThrow("malformed");
});

// The two exact empty-server answers: exit 1 with `no current target` (tmux 3.7c),
// or exit 0 with no rows (older tmux). An opaque failure is neither.
const emptyAnswer = (r: { code: number; stdout: string; stderr: string }) =>
  (r.code === 1 && r.stdout === "" && r.stderr === "no current target\n") || (r.code === 0 && r.stdout.trim() === "" && r.stderr === "");
// tap-eafrp: a server kept alive by exit-empty off answers an empty namespace with
// "no current target". That is positive proof of zero sessions; near misses still refuse.
test("a recognized empty-server answer proves an empty namespace; near misses stay unobservable", () => {
  const empty = seatSnapshot(() => ({ code: 1, stdout: "", stderr: "no current target\n" }));
  expect(empty).toEqual({ panes: [], epoch: "" });
  for (const stderr of ["no current target: boom", "no current target\nno sessions", "can't find session", "no sessions", "", "lost server", "no current target."]) {
    expect(() => seatSnapshot(() => ({ code: 1, stdout: "", stderr })), JSON.stringify(stderr)).toThrow("cannot observe");
  }
  // Older tmux answers the same lingering empty server with a successful read and no rows.
  expect(seatSnapshot(() => ({ code: 0, stdout: "", stderr: "" }))).toEqual({ panes: [], epoch: "" });
  expect(seatSnapshot(() => ({ code: 0, stdout: "\n", stderr: "" }))).toEqual({ panes: [], epoch: "" });
  // A successful read with rows that do not parse is still refused.
  expect(() => seatSnapshot(() => ({ code: 0, stdout: "garbage", stderr: "" }))).toThrow("malformed");
});

test("real tmux: a live server with no sessions observes as empty, a server with sessions never says no current target", () => {
  const f = fixture();
  const call = (args: string[]) => { const r = tm(f.env, ...args); return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }; };
  tm(f.env, "new-session", "-d", "-s", "keep", "sleep 120");
  tm(f.env, "set", "-s", "exit-empty", "off");
  expect(seatSnapshot(call).panes.map(p => p.session)).toEqual(["keep"]);
  tm(f.env, "kill-session", "-t", "=keep");
  const raw = call(["list-panes", "-a", "-F", "#{pane_id}"]);
  expect(emptyAnswer(raw)).toBe(true);
  expect(seatSnapshot(call)).toEqual({ panes: [], epoch: "" });
});

test("crew cleanup follows durable ownership across vessels and excludes reused owner instances", () => {
  const parent = { instance: "parent-one", session: "team/seat" };
  expect(ownedCrewRows({ parent,
    own: { crew: true, crew_owner: "parent", crew_owner_instance: "parent-one", session: "crew-vessel" },
    foreign: { crew: true, crew_owner: "parent", crew_owner_instance: "old-instance", session: "team/seat" },
  }, "parent")).toEqual(["own"]);
});

test("real down preserves mail, instance, resume recipe; only owner crew disappear; repeat is no-op", () => {
  const f = fixture();
  const pane = tm(f.env, "new-session", "-d", "-s", "team/seat", "-P", "-F", "#{pane_id}", "sleep 120").stdout.trim();
  expect(pane).toMatch(/^%\d+$/);
  const crew = tm(f.env, "new-window", "-d", "-t", "=team/seat", "-P", "-F", "#{pane_id}", "sleep 120").stdout.trim();
  const foreign = tm(f.env, "new-session", "-d", "-s", "operator", "-P", "-F", "#{pane_id}", "sleep 120").stdout.trim();
  f.put({ seat: row(pane), crew: { crew: true, session: "team/seat", pane_id: crew }, outsider: { crew: true, session: "operator", pane_id: foreign } });
  const before = f.get().seats;
  mkdirSync(join(f.bus, "payloads")); mkdirSync(join(f.bus, "receipts"));
  writeFileSync(join(f.bus, "payloads", "pending.md"), "reply: expected\nto: seat\nbody");
  writeFileSync(join(f.bus, "receipts", "pending.sent"), "placed but unsettled");
  const result = f.run("down", "seat", "--json");
  expect(result.stderr).toContain("removing owned crew crew"); expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).outcome).toBe("stopped");
  expect(tm(f.env, "has-session", "-t", "=team/seat").status).not.toBe(0);
  expect(tm(f.env, "has-session", "-t", "=operator").status).toBe(0);
  expect(f.get().seats).toEqual({ seat: { ...before.seat, status: "suspended", status_reason: "session_stopped" }, outsider: before.outsider });
  expect(readFileSync(join(f.bus, "payloads", "pending.md"), "utf8")).toContain("reply: expected");
  expect(readFileSync(join(f.bus, "receipts", "pending.sent"), "utf8")).toBe("placed but unsettled");
  expect(JSON.parse(f.run("down", "team/seat", "--json").stdout).outcome).toBe("already_stopped");
}, 30_000);

test("real down and out --kill of the last seat on a server that stays up empty report stopped (tap-eafrp)", () => {
  for (const verb of [["down", "seat", "--json"], ["out", "seat", "--kill", "--json"]]) {
    const f = fixture();
    const pane = tm(f.env, "new-session", "-d", "-s", "team/seat", "-P", "-F", "#{pane_id}", "sleep 120").stdout.trim();
    expect(tm(f.env, "set", "-s", "exit-empty", "off").status).toBe(0);
    f.put({ seat: row(pane) });
    const result = f.run(...verb);
    expect(result.stderr, verb.join(" ")).not.toContain("unobservable");
    expect(result.status, verb.join(" ")).toBe(0);
    expect(JSON.parse(result.stdout).outcome).toBe("stopped");
    const after = tm(f.env, "list-panes", "-a");
    expect(emptyAnswer({ code: after.status ?? 1, stdout: after.stdout, stderr: after.stderr })).toBe(true);
  }
}, 40_000);

test("up live is detached no-op; unknown, crew, poll and mismatched session have no effects", () => {
  const f = fixture();
  const pane = tm(f.env, "new-session", "-d", "-s", "team/seat", "-P", "-F", "#{pane_id}", "sleep 120").stdout.trim();
  f.put({ seat: row(pane) });
  const before = readFileSync(f.registry, "utf8");
  const live = f.run("up", "seat", "--json");
  expect(live.status).toBe(0); expect(JSON.parse(live.stdout).outcome).toBe("already_live");
  expect(readFileSync(f.registry, "utf8")).toBe(before);
  expect(f.run("up", "codex").status).toBe(1);
  expect(f.run("down", "team/seat", "--team", "team").status).toBe(1);
  for (const change of [{ crew: true }, { delivery: "poll" }, { session: "operator" }, { pane_id: "%99999" }]) {
    f.put({ seat: { ...row(pane), ...change } });
    expect(f.run("down", "seat").status).toBe(1);
    expect(tm(f.env, "has-session", "-t", "=team/seat").status).toBe(0);
  }
}, 30_000);

function quote(s: string) { return "'" + s.replaceAll("'", "'\\''") + "'"; }
test("self-stop saves state and emits stop_requested before ending its own session", async () => {
  const f = fixture();
  const pane = tm(f.env, "new-session", "-d", "-s", "team/seat", "-P", "-F", "#{pane_id}", "sleep 120").stdout.trim();
  tm(f.env, "new-session", "-d", "-s", "observer", "sleep 120");
  f.put({ seat: row(pane) });
  const receipt = join(f.root, "self.json");
  const childEnv = Object.entries(f.env).filter(([k, v]) => v !== undefined && (k.startsWith("TAP_") || ["HOME", "PATH", "TMUX_TMPDIR"].includes(k))).map(([k, v]) => quote(`${k}=${v}`)).join(" ");
  const command = `cd ${quote(f.root)} && exec env ${childEnv} ${quote(process.execPath)} ${quote(join(repo, "runtime/bun/main.ts"))} down seat --json > ${quote(receipt)} 2> ${quote(receipt + ".err")}`;
  expect(tm(f.env, "respawn-pane", "-k", "-t", pane, command).status).toBe(0);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && tm(f.env, "has-session", "-t", "=team/seat").status === 0) await Bun.sleep(50);
  expect(tm(f.env, "has-session", "-t", "=team/seat").status).not.toBe(0);
  expect(f.get().seats.seat.status).toBe("suspended");
  expect(JSON.parse(readFileSync(receipt, "utf8")).outcome).toBe("stop_requested");
  expect(readFileSync(receipt + ".err", "utf8")).toBe("");
}, 10_000);

test("effect-time guard refuses a session renamed and replaced after observation", () => {
  const f = fixture();
  tm(f.env, "new-session", "-d", "-s", "team/seat", "sleep 120");
  const call = (args: string[]) => { const r = tm(f.env, ...args); return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }; };
  const old = seatSnapshot(call).panes.find(p => p.session === "team/seat")!;
  expect(tm(f.env, "rename-session", "-t", "=team/seat", "operator").status).toBe(0);
  tm(f.env, "new-session", "-d", "-s", "team/seat", "sleep 120");
  expect(stopExactPane(old, call).stdout).toContain("identity changed");
  expect(tm(f.env, "has-session", "-t", "=team/seat").status).toBe(0);
  expect(tm(f.env, "has-session", "-t", "=operator").status).toBe(0);
});

test("colliding pane ids on another caller server do not claim self-stop", () => {
  const target = fixture();
  const caller = fixture();
  const targetPane = tm(target.env, "new-session", "-d", "-s", "team/seat", "-P", "-F", "#{pane_id}", "sleep 120").stdout.trim();
  const callerPane = tm(caller.env, "new-session", "-d", "-s", "caller", "-P", "-F", "#{pane_id}", "sleep 120").stdout.trim();
  expect(targetPane).toBe(callerPane);
  target.put({ seat: row(targetPane) });
  target.env.TMUX = tm(caller.env, "display-message", "-p", "-t", callerPane, "#{socket_path},#{pid},0").stdout.trim();
  target.env.TMUX_PANE = callerPane;
  const result = target.run("down", "seat", "--json");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).outcome).toBe("stopped");
  expect(tm(caller.env, "has-session", "-t", "=caller").status).toBe(0);
}, 10_000);

test("failed kill restores the owner and crew rows while preserving the live session", () => {
  const f = fixture();
  const pane = tm(f.env, "new-session", "-d", "-s", "team/seat", "-P", "-F", "#{pane_id}", "sleep 120").stdout.trim();
  const crew = tm(f.env, "new-window", "-d", "-t", "=team/seat", "-P", "-F", "#{pane_id}", "sleep 120").stdout.trim();
  const seats = { seat: row(pane), crew: { crew: true, session: "team/seat", pane_id: crew } };
  f.put(seats);
  const before = f.get().seats;
  mkdirSync(join(f.root, "bin"));
  const shim = join(f.root, "bin/tmux");
  writeFileSync(shim, `#!/bin/bash\nfor arg in "$@"; do\n  if [ "$arg" = if-shell ]; then echo 'forced stop refusal' >&2; exit 1; fi\ndone\nexec ${quote(Bun.which("tmux")!)} "$@"\n`);
  chmodSync(shim, 0o755);
  f.env.PATH = `${f.root}/bin:${f.env.PATH}`;
  const result = f.run("down", "seat", "--json");
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout).error_class).toBe("crew_stop_unverified");
  expect(f.get().seats).toEqual(before);
  expect(tm(f.env, "has-session", "-t", "=team/seat").status).toBe(0);
  expect(tm(f.env, "display-message", "-p", "-t", crew, "#{pane_id}").stdout.trim()).toBe(crew);
}, 10_000);

test("co-tenants refuse under the current registry lock; stale poll membership does not block", () => {
  const f = fixture();
  const pane = tm(f.env, "new-session", "-d", "-s", "team/seat", "-P", "-F", "#{pane_id}", "sleep 120").stdout.trim();
  const otherPane = tm(f.env, "new-window", "-d", "-t", "=team/seat", "-P", "-F", "#{pane_id}", "sleep 120").stdout.trim();
  for (const other of [
    { session: "team/seat", pane_id: otherPane },
    { crew: true, session: "elsewhere", pane_id: otherPane },
  ]) {
    f.put({ seat: row(pane), other });
    const result = f.run("down", "seat", "--json");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error_class).toBe("shared_durable_session");
    expect(f.get().seats.seat.status).toBe("active");
    expect(tm(f.env, "has-session", "-t", "=team/seat").status).toBe(0);
  }
  const poll = { delivery: "poll", session: "team/seat", status: "active" };
  f.put({ seat: row(pane), poll });
  expect(f.run("down", "seat", "--json").status).toBe(0);
  expect(f.get().seats.poll).toEqual(poll);
}, 10_000);

test("absent-session dry-run preserves rows; explicit down retires its retained crew", () => {
  const f = fixture();
  f.put({ seat: row(), crew: { crew: true, session: "team/seat", pane_id: "%2" } });
  const generation = join(f.bus, "reset-generation.json");
  writeFileSync(generation, '{"pristine":true,"extension":"retain"}\n');
  const before = readFileSync(f.registry, "utf8"), beforeGeneration = readFileSync(generation, "utf8");
  const preview = f.run("down", "seat", "--json", "--dry-run");
  expect(preview.status).toBe(0);
  expect(JSON.parse(preview.stdout)).toMatchObject({ outcome: "would_stop", crews: ["crew"] });
  expect(readFileSync(f.registry, "utf8")).toBe(before);
  expect(readFileSync(generation, "utf8")).toBe(beforeGeneration);
  const result = f.run("down", "seat", "--json");
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(f.get().seats.crew).toBeUndefined();
  expect(f.get().seats.seat.status).toBe("suspended");
});

test("down and up refuse an old, hybrid or axis-less registry with no write or generation stamp", () => {
  const f = fixture();
  const team = { name: "team", worktree_root: f.root };
  const generation = join(f.bus, "reset-generation.json");
  writeFileSync(generation, '{"pristine":true,"extension":"retain"}\n');
  for (const [doc, errorClass] of [
    [{ schema: "0.20", team, agents: { seat: row() } }, "old_store"],
    [{ schema: "0.20", team, seats: { seat: row() }, agents: { old: row() } }, "old_store"],
    [{ schema: "0.20", team }, "old_store"],
  ] as const) {
    const bytes = JSON.stringify(doc);
    writeFileSync(f.registry, bytes);
    for (const verb of ["down", "up"]) {
      const result = f.run(verb, "seat", "--json");
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).error_class).toBe(errorClass);
      expect(readFileSync(f.registry, "utf8")).toBe(bytes);
      expect(readFileSync(generation, "utf8")).toBe('{"pristine":true,"extension":"retain"}\n');
    }
  }
});

test("human down names removed crews and discloses preserved but unassigned crew mail", () => {
  const f = fixture();
  const pane = tm(f.env, "new-session", "-d", "-s", "team/seat", "-P", "-F", "#{pane_id}", "sleep 120").stdout.trim();
  const crew = tm(f.env, "new-window", "-d", "-t", "=team/seat", "-P", "-F", "#{pane_id}", "sleep 120").stdout.trim();
  f.put({ seat: row(pane), helper: { crew: true, session: "team/seat", pane_id: crew } });
  mkdirSync(join(f.bus, "payloads"));
  const path = join(f.bus, "payloads", "crew-work.md");
  const mail = "---\nto: helper\nfrom: seat\nreply: expected\n---\nReview still owed.\n";
  writeFileSync(path, mail);
  const result = f.run("down", "seat");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("stopped (owned crew: helper)");
  expect(result.stderr).toContain("unsettled crew mail remains on the bus without a recipient");
  expect(f.get().seats.helper).toBeUndefined();
  expect(readFileSync(path, "utf8")).toBe(mail);
});

test.each(["down", "out"])("%s from a surviving crew stops that caller after its owner pane is gone", async verb => {
  const f = fixture();
  const owner = tm(f.env, "new-session", "-d", "-s", "team/seat", "-P", "-F", "#{pane_id}", "sleep 120").stdout.trim();
  const child = tm(f.env, "new-window", "-d", "-t", "=team/seat", "-P", "-F", "#{pane_id}", "sleep 120").stdout.trim();
  tm(f.env, "new-session", "-d", "-s", "observer", "sleep 120");
  f.put({ seat: row(owner), child: { crew: true, crew_owner: "seat", crew_owner_instance: "seat|stable", session: "team/seat", pane_id: child } });
  expect(tm(f.env, "kill-pane", "-t", owner).status).toBe(0);
  const receipt = join(f.root, "crew-self.json"), survived = join(f.root, "survived"), script = join(f.root, "stop-from-crew.sh");
  const childEnv = Object.entries(f.env).filter(([key, value]) => value !== undefined && (key.startsWith("TAP_") || ["HOME", "PATH", "TMUX_TMPDIR"].includes(key)))
    .map(([key, value]) => quote(`${key}=${value}`)).join(" ");
  writeFileSync(script, `#!/bin/sh\ncd ${quote(f.root)}\nenv ${childEnv} ${quote(process.execPath)} ${quote(join(repo, "runtime/bun/main.ts"))} ${verb} seat ${verb === "out" ? "--kill" : ""} --json > ${quote(receipt)} 2> ${quote(receipt + ".err")}\nprintf survived > ${quote(survived)}\nexec sleep 120\n`);
  expect(tm(f.env, "respawn-pane", "-k", "-t", child, `sh ${quote(script)}`).status).toBe(0);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && tm(f.env, "list-panes", "-a", "-F", "#{pane_id}").stdout.trim().split("\n").includes(child)) await Bun.sleep(50);
  const detail = [receipt, receipt + ".err"].map(path => existsSync(path) ? readFileSync(path, "utf8") : `missing ${path}`).join("\n");
  expect(tm(f.env, "list-panes", "-a", "-F", "#{pane_id}").stdout.trim().split("\n"), detail).not.toContain(child);
  expect(f.get().seats.child).toBeUndefined();
  expect(JSON.parse(readFileSync(receipt, "utf8")).outcome).toBe("stop_requested");
  expect(existsSync(survived)).toBe(false);
}, 10000);
