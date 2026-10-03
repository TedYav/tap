import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContext, TapError, type ResolvedContext } from "../src/context";
import { loadRegistry, saveRegistry, seatMap } from "../src/registry";
import { parseDetachOptions, runTeamDetach } from "../src/team/detach";
import { parseSelection, rosterGate, selectAny, selectFlag, selectOperand, spared } from "../src/team/selection";
import { ServerUnresponsive } from "../src/tmux";
import { moveExclusive, parseTeardownOptions, runHandleRestore, runTeardown } from "../src/verbs/teardown";
import { acquireRegistryLock, acquirePathLock } from "../src/panelock";
import { acquireResetMutationLock } from "../src/reset";
import { SelectorError } from "../src/selector";

function fixture(body: (ctx: ResolvedContext, put: (store: string, name: string, contents: string) => string) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tap-handle-"))), index = join(root, "index"), bus = join(root, ".tap/bus"), registry = join(root, ".tap/team-registry.json");
  mkdirSync(index); mkdirSync(bus, { recursive: true });
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { demo: { root, registry_location: registry, state: "registered" } } }));
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "demo", worktree_root: root }, seats: { ann: { instance: "original", status: "active", delivery: "poll" }, joanne: { instance: "neighbour", status: "suspended", delivery: "poll" } } }));
  const values = { TAP_HOME: bus, TAP_INDEX_HOME: index, TAP_INPUT_BACKUPS: join(bus, "input-backups") };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  const put = (store: string, name: string, contents: string) => {
    const path = join(bus, store, name); mkdirSync(join(bus, store), { recursive: true }); writeFileSync(path, contents); return path;
  };
  try { body(resolveContext(root, process.env, { explicitTeam: "demo", paneFallback: false }), put); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
const options = parseTeardownOptions("teardown", ["ann", "--yes", "--json"]);
function refusal(body: () => unknown, klass: string): TapError {
  let error: unknown; try { body(); } catch (caught) { error = caught; }
  // An old_store may surface from under-lock revalidation as the selector's own typed error.
  if (!(klass === "old_store" && error instanceof SelectorError)) expect(error).toBeInstanceOf(TapError);
  expect((error as TapError).errorClass).toBe(klass); return error as TapError;
}
const envelope = (from: string, to: string) => `---\nfrom: ${from}\nto: ${to}\n---\nbody mentions ann but is not authority\n`;

test("teardown matches ann exactly, carries inbound sidecars, and restores the same suspended incarnation", () => fixture((ctx, put) => {
  const inbound = "bob-20260101T000000Z-deadbeef", outbound = "ann-20260101T000000Z-abcd";
  put("payloads", `${inbound}.md`, envelope("other/bob", "demo/ann"));
  put("receipts", `${inbound}.done`, "receipt");
  put("payloads", `${outbound}.md`, envelope("ann", "bob"));
  put("payloads", "joanne-20260101T000000Z-cafe.md", envelope("joanne", "other/ann"));
  put("payloads", "foreign-ann.md", "---\nfrom: bob\nto: ann\nto_team: other\n---\nforeign destination\n");
  put("payloads", "ann-20260101T000000Z-foreign.md", "---\nfrom: ann\nfrom_team: other\nto: joanne\n---\nforeign sender\n");
  put("receipts", "ann-20260101T000000Z-foreign.done", "foreign receipt");
  // IDs may legally contain dots: a distinct, differently-owned message whose
  // name textually extends the outbound id with a dot must not be swept in
  // as one of its sidecars just because it shares that textual prefix.
  put("payloads", `${outbound}.followup.md`, envelope("bob", "joanne"));
  // An opaque (unrecognized-suffix) sidecar of that same foreign canonical
  // file textually extends BOTH the torn-down id (`${outbound}.`) and the
  // foreign id (`${outbound}.followup.`) — the longer, foreign owner must
  // win, or this sidecar of someone else's mail gets swept into ann's archive.
  put("payloads", `${outbound}.followup.extra`, "opaque sidecar of a foreign envelope");
  put("spool", "park.meta.json", JSON.stringify({ target: "ann", team: "demo" })); put("spool", "park.md", "parked");
  put("spool", "foreign.meta.json", JSON.stringify({ target: "ann", team: "other" })); put("spool", "foreign.md", "foreign");
  put("input-backups", "20260101T000000Z-ann-message.md", "draft");
  put("handoff", "ann-20260101T000000Z.md", "handoff"); put("handoff", "joanne-20260101T000000Z.md", "neighbour");
  put("seat-state", "ann.hash", "hash"); put("seat-state", "joanne.hash", "neighbour");
  // Episodes are keyed by 16 hex digits; a dotted neighbour handle (`ann.x`) and a near-miss stay put.
  put("seat-state", "ann.0123456789abcdef.stall.json", "{}"); put("seat-state", "joanne.0123456789abcdef.stall.json", "{}");
  put("seat-state", "ann.x.0123456789abcdef.stall.json", "{}"); put("seat-state", "ann.stall.json", "{}");
  put("watch", "arm.json", JSON.stringify({ blocked_map: JSON.stringify({ ann: { reason: "busy" }, joanne: { reason: "keep" } }) }));
  put("goalie", "arm.json", JSON.stringify({ seats: { ann: { floor_at: 1 }, joanne: {} } }));
  symlinkSync("/unreadable/target", join(ctx.bus.receiptsDir, `${inbound}.extra`));
  const archive = runTeardown(ctx, options);
  expect(Object.keys(seatMap(loadRegistry(ctx.registryPath)))).toEqual(["joanne"]);
  expect(existsSync(join(archive, "receipts", `${inbound}.done`))).toBe(true);
  expect(readlinkSync(join(archive, "receipts", `${inbound}.extra`))).toBe("/unreadable/target");
  expect(readdirSync(ctx.bus.payloadsDir).sort()).toEqual(["ann-20260101T000000Z-abcd.followup.extra", "ann-20260101T000000Z-abcd.followup.md", "ann-20260101T000000Z-foreign.md", "foreign-ann.md", "joanne-20260101T000000Z-cafe.md"]);
  expect(existsSync(join(ctx.bus.receiptsDir, "ann-20260101T000000Z-foreign.done"))).toBe(true);
  expect(readdirSync(join(ctx.bus.home, "spool")).sort()).toEqual(["foreign.md", "foreign.meta.json"]);
  for (const store of ["input-backups", "handoff"]) expect(readdirSync(join(archive, store))).toHaveLength(1);
  expect(readdirSync(join(archive, "seat-state")).sort()).toEqual(["ann.0123456789abcdef.stall.json", "ann.hash"]);
  expect(readdirSync(join(ctx.bus.home, "seat-state")).sort()).toEqual(["ann.stall.json", "ann.x.0123456789abcdef.stall.json", "joanne.0123456789abcdef.stall.json", "joanne.hash"]);
  const watch = () => JSON.parse(readFileSync(join(ctx.bus.home, "watch/arm.json"), "utf8"));
  expect(JSON.parse(watch().blocked_map)).toEqual({ joanne: { reason: "keep" } });
  runHandleRestore(ctx, { ...options, archive });
  expect(seatMap(loadRegistry(ctx.registryPath)).ann).toEqual({ instance: "original", status: "suspended", status_reason: "restored_teardown", delivery: "poll" });
  expect(JSON.parse(watch().blocked_map).ann).toEqual({ reason: "busy" });
  expect(existsSync(join(ctx.bus.payloadsDir, `${inbound}.md`))).toBe(true);
}));

test("mid-teardown failure retains row and recovery metadata before the first move", () => fixture((ctx, put) => {
  put("payloads", "ann-20260101T000000Z-a.md", envelope("ann", "bob"));
  put("payloads", "ann-20260101T000000Z-b.md", envelope("ann", "bob"));
  const before = readFileSync(ctx.registryPath, "utf8"); let moves = 0;
  const error = refusal(() => runTeardown(ctx, options, (source, target) => {
    const archive = join(target, "../..");
    expect(JSON.parse(readFileSync(join(archive, "meta.json"), "utf8")).handle).toBe("ann");
    expect(JSON.parse(readFileSync(join(archive, "registry-row.json"), "utf8")).agent.instance).toBe("original");
    if (++moves === 2) throw new Error("injected transfer failure");
    moveExclusive(source, target);
  }), "teardown_incomplete");
  expect(readFileSync(ctx.registryPath, "utf8")).toBe(before);
  const archive = join(ctx.bus.home, "archive/teardown", readdirSync(join(ctx.bus.home, "archive/teardown"))[0]!);
  expect(error.detail).toContain(archive);
  expect(readdirSync(join(archive, "payloads"))).toHaveLength(1);
  expect(readdirSync(ctx.bus.payloadsDir)).toHaveLength(1);
}));

test("restore refuses every occupied row before any archive consumption", () => fixture((ctx, put) => {
  put("payloads", "ann-20260101T000000Z-a.md", envelope("ann", "bob"));
  const archive = runTeardown(ctx, options), file = join(archive, "payloads/ann-20260101T000000Z-a.md");
  for (const row of [null, {}, { status: "suspended" }, { status: "offline" }, { status: "active" }]) {
    const doc = loadRegistry(ctx.registryPath); Object.assign(seatMap(doc), { ann: row }); saveRegistry(ctx.registryPath, doc);
    refusal(() => runHandleRestore(ctx, { ...options, archive }), "handle_live");
    expect(existsSync(file)).toBe(true); expect(existsSync(join(ctx.bus.payloadsDir, "ann-20260101T000000Z-a.md"))).toBe(false);
  }
}));

test("restore refuses the reserved operator identity before touching any archive (tap-gridx)", () => fixture((ctx, put) => {
  put("payloads", "ann-20260101T000000Z-a.md", envelope("ann", "bob"));
  const archive = runTeardown(ctx, options), file = join(archive, "payloads/ann-20260101T000000Z-a.md");
  const error = refusal(() => runHandleRestore(ctx, { ...options, handle: "user", archive }), "reserved_handle");
  expect(error.detail).toBe("handle 'user' is the reserved operator identity and cannot name a seat; archive unchanged");
  expect(existsSync(file)).toBe(true);
  expect(Object.hasOwn(seatMap(loadRegistry(ctx.registryPath)), "user")).toBe(false);
}));

test("restore refuses an old, hybrid or axis-less registry before any archive consumption", () => fixture((ctx, put) => {
  put("payloads", "ann-20260101T000000Z-a.md", envelope("ann", "bob"));
  const archive = runTeardown(ctx, options), file = join(archive, "payloads/ann-20260101T000000Z-a.md");
  for (const [text, klass] of [
    [JSON.stringify({ team: { name: "demo" }, agents: { joanne: {} } }), "old_store"],
    [JSON.stringify({ schema: "0.20", team: { name: "demo" }, seats: {}, agents: { joanne: {} } }), "old_store"],
    [JSON.stringify({ schema: "0.20", team: { name: "demo" } }), "old_store"],
  ] as const) {
    writeFileSync(ctx.registryPath, text);
    refusal(() => runHandleRestore(ctx, { ...options, archive }), klass);
    expect(readFileSync(ctx.registryPath, "utf8")).toBe(text);
    expect(existsSync(file)).toBe(true); expect(existsSync(join(ctx.bus.payloadsDir, "ann-20260101T000000Z-a.md"))).toBe(false);
  }
}));

test("restore validates metadata and all members before moving, and refuses live destination collisions", () => fixture((ctx, put) => {
  const name = "ann-20260101T000000Z-a.md"; put("payloads", name, envelope("ann", "bob"));
  const archive = runTeardown(ctx, options), metaPath = join(archive, "meta.json"), original = readFileSync(metaPath, "utf8");
  for (const meta of ["{broken", "[]", '{"kind":"team_reset","handle":"ann"}', '{"kind":"handle_teardown","handle":"joanne"}']) {
    writeFileSync(metaPath, meta); refusal(() => runHandleRestore(ctx, { ...options, archive }), "archive_invalid");
    expect(existsSync(join(archive, "payloads", name))).toBe(true);
  }
  writeFileSync(metaPath, original); put("payloads", name, "new occupant's bytes");
  refusal(() => runHandleRestore(ctx, { ...options, archive }), "restore_conflict");
  expect(readFileSync(join(ctx.bus.payloadsDir, name), "utf8")).toBe("new occupant's bytes");
}));

test("failed restore returns moved files to the archive and leaves the row free", () => fixture((ctx, put) => {
  for (const id of ["a", "b"]) put("payloads", `ann-20260101T000000Z-${id}.md`, envelope("ann", "bob"));
  const archive = runTeardown(ctx, options); let moves = 0;
  refusal(() => runHandleRestore(ctx, { ...options, archive }, (source, target) => { if (++moves === 2) throw new Error("injected restore failure"); moveExclusive(source, target); }), "restore_incomplete");
  expect(readdirSync(join(archive, "payloads"))).toHaveLength(2);
  expect(readdirSync(ctx.bus.payloadsDir)).toHaveLength(0);
  expect(Object.hasOwn(seatMap(loadRegistry(ctx.registryPath)), "ann")).toBe(false);
}));

test("failed restore also rolls back a merged watch lease when the later goalie merge refuses", () => fixture((ctx, put) => {
  put("watch", "arm.json", JSON.stringify({ blocked_map: JSON.stringify({ ann: { reason: "busy" }, joanne: { reason: "keep" } }) }));
  put("goalie", "arm.json", JSON.stringify({ seats: { ann: { floor_at: 1 }, joanne: {} } }));
  const archive = runTeardown(ctx, options);
  // Corrupt the live goalie bucket so its merge refuses after watch's already succeeded,
  // exercising the ordering in `leases` (watch before goalie).
  writeFileSync(join(ctx.bus.home, "goalie/arm.json"), JSON.stringify({ seats: "nope" }));
  const error = refusal(() => runHandleRestore(ctx, { ...options, archive }), "restore_incomplete");
  expect(error.detail).toContain("not an object; refusing to merge into it");
  const watch = () => JSON.parse(readFileSync(join(ctx.bus.home, "watch/arm.json"), "utf8"));
  expect(JSON.parse(watch().blocked_map)).toEqual({ joanne: { reason: "keep" } });
  expect(existsSync(join(archive, "watch", "blocked_map.ann.json"))).toBe(true);
}));

test("session-kill restore remains separate: COMPLETE, forensic-only refusal, retained identity and pane resume", () => fixture((ctx, put) => {
  const doc = loadRegistry(ctx.registryPath); delete seatMap(doc).ann; saveRegistry(ctx.registryPath, doc);
  // An explicit path outside archive/teardown is part of the existing surface.
  const archive = join(ctx.root, "session-kill"); mkdirSync(archive);
  writeFileSync(join(archive, "meta.json"), '{"kind":"session_kill_backup","handle":"ann"}');
  writeFileSync(join(archive, "registry-row.json"), '{"agent":null}');
  writeFileSync(join(archive, "launcher-session-record.json"), '{"record":null}');
  refusal(() => runHandleRestore(ctx, { ...options, archive }), "archive_incomplete");
  writeFileSync(join(archive, "COMPLETE"), "");
  refusal(() => runHandleRestore(ctx, { ...options, archive }), "archive_no_seat_state");
  writeFileSync(join(archive, "registry-row.json"), '{"agent":{"instance":"same","pane_id":"%77"}}');
  runHandleRestore(ctx, { ...options, archive });
  expect(seatMap(loadRegistry(ctx.registryPath)).ann).toEqual({ instance: "same", pane_id: "%77", status: "suspended", status_reason: "restored_from_archive", delivery: "pane" });
}));

test("detach only spares shared sessions, while handle targets the selected row's session", () => fixture(ctx => {
  const doc = loadRegistry(ctx.registryPath); doc.seats = { ann: { session: "shared" }, joanne: { session: "shared" } }; saveRegistry(ctx.registryPath, doc);
  const calls: string[][] = [], lines: string[] = [];
  const run = (args: string[]) => { calls.push(args); return { code: 0, stdout: args[0] === "list-clients" ? "/dev/tty\n" : "", stderr: "" }; };
  runTeamDetach(ctx, parseDetachOptions(["--only", "ann"]), run, line => lines.push(line));
  expect(calls).toHaveLength(0); expect(lines.at(-1)).toContain("excluded=1");
  runTeamDetach(ctx, parseDetachOptions(["--handle", "ann"]), run, () => {});
  expect(calls.at(-1)).toEqual(["detach-client", "-s", "=shared"]);
}));

test("detach rechecks late spared co-tenants under registry custody before each session action", () => fixture(ctx => {
  const doc = loadRegistry(ctx.registryPath); doc.seats = { ann: { session: "a" }, joanne: { session: "z" } }; saveRegistry(ctx.registryPath, doc);
  const detached: string[] = [], lines: string[] = [];
  runTeamDetach(ctx, parseDetachOptions(["--only", "ann,joanne"]), args => {
    if (args[0] === "has-session" && args[2] === "=a") { const fresh = loadRegistry(ctx.registryPath); seatMap(fresh).late = { session: "z" }; saveRegistry(ctx.registryPath, fresh); }
    if (args[0] === "detach-client") detached.push(args[2]!);
    return { code: 0, stdout: args[0] === "list-clients" ? "/dev/tty\n" : "", stderr: "" };
  }, line => lines.push(line));
  expect(detached).toEqual(["=a"]); expect(lines.join("\n")).toContain("late co-tenant");
}));

test("detach refuses a later session's group once the registry evaporates mid-loop", () => fixture(ctx => {
  const doc = loadRegistry(ctx.registryPath); doc.seats = { ann: { session: "a" }, joanne: { session: "z" } }; saveRegistry(ctx.registryPath, doc);
  const run = (args: string[]) => {
    if (args[0] === "has-session" && args[2] === "=a") unlinkSync(ctx.registryPath);
    return { code: 0, stdout: args[0] === "list-clients" ? "/dev/tty\n" : "", stderr: "" };
  };
  const error = refusal(() => runTeamDetach(ctx, parseDetachOptions(["--only", "ann,joanne"]), run, () => {}), "registry_invalid");
  expect(error.detail).toContain("acting registry unreadable");
}));

test("detach refuses a later session's group once the registry reread turns malformed", () => fixture(ctx => {
  const doc = loadRegistry(ctx.registryPath); doc.seats = { ann: { session: "a" }, joanne: { session: "z" } }; saveRegistry(ctx.registryPath, doc);
  const run = (args: string[]) => {
    if (args[0] === "has-session" && args[2] === "=a") writeFileSync(ctx.registryPath, "{not json");
    return { code: 0, stdout: args[0] === "list-clients" ? "/dev/tty\n" : "", stderr: "" };
  };
  const error = refusal(() => runTeamDetach(ctx, parseDetachOptions(["--only", "ann,joanne"]), run, () => {}), "registry_invalid");
  expect(error.detail).toContain("acting registry unreadable");
}));

test("detach lets a tmux server-unresponsive failure escape as itself, not a registry refusal", () => fixture(ctx => {
  const doc = loadRegistry(ctx.registryPath); doc.seats = { ann: { session: "a" } }; saveRegistry(ctx.registryPath, doc);
  const run = (args: string[]) => {
    if (args[0] === "detach-client") throw new ServerUnresponsive("/tmp/sock", "123");
    return { code: 0, stdout: args[0] === "list-clients" ? "/dev/tty\n" : "", stderr: "" };
  };
  let error: unknown;
  try { runTeamDetach(ctx, parseDetachOptions(["--only", "ann"]), run, () => {}); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(ServerUnresponsive);
}));

// Ports of the retired lib.sh-only probes: exercise the production predicate,
// roster refusal, and receipt fragments without coupling to a shell body.
test("positive selection spares late arrivals and receipts retain typed polarity", () => {
  const only = parseSelection("team down", "ann", "--only");
  rosterGate("team down", only, ["ann", "joanne"]);
  expect(only.only).toEqual(["ann"]); expect(only.except).toEqual([]);
  expect(spared("ann", only)).toBe(false); expect(spared("late", only)).toBe(true);
  const except = parseSelection("team down", "ann");
  expect(spared("late", except)).toBe(false);
  expect(`by ${selectFlag(only)}${selectOperand(only)}`).toBe("by --only ann — every other seat");
  expect(`by ${selectFlag(except)}${selectOperand(except)}`).toBe("by --except: ann");
  expect(selectAny(parseSelection("team down", "ann,joanne", "--only"))).toBe(true);
  expect(refusal(() => rosterGate("team down", only, []), "not_found").detail).toContain("roster: (none)");
  for (const value of ["", "ann,ann", "ann,,joanne", "demo/ann", "an n"]) {
    const error = refusal(() => parseSelection("team down", value, "--only"), "usage_error");
    expect(error.action + error.detail).toContain("--only"); expect(error.action + error.detail).not.toContain("--except");
  }
});

test("team detach accepts a named team and keeps omitted selectors distinct from exact lists", () => {
  expect(parseDetachOptions(["demo", "--only", "--yes"])).toMatchObject({ team: "demo", pending: "--only", yes: true });
  expect(parseDetachOptions(["demo", "--only", "ann"])).toMatchObject({ team: "demo", selection: { mode: "--only", only: ["ann"] } });
  expect(refusal(() => parseDetachOptions(["demo", "--only", "ann", "--only"]), "usage_error").detail).toContain("more than once");
});

for (const restoring of [false, true]) test(`structural EX refuses a busy ledger without waiting (restore=${restoring})`, () => fixture(ctx => {
  const archive = restoring ? runTeardown(ctx, options) : "";
  const ledger = acquireRegistryLock(ctx.registryPath, 0)!;
  try {
    const started = Date.now();
    refusal(() => restoring ? runHandleRestore(ctx, { ...options, archive }) : runTeardown(ctx, options), "launcher_registry_busy");
    expect(Date.now() - started).toBeLessThan(1000);
    const mail = acquireResetMutationLock(ctx.bus.home, "mail after refused cut", 0, "shared");
    mail.release();
  } finally { ledger.release(); }
}));

test("structural EX never waits on generation bookkeeping or leaves a used bus pristine", () => fixture(ctx => {
  const generation = join(ctx.bus.home, "reset-generation.json");
  writeFileSync(generation, JSON.stringify({state:"pristine",bundle_id:"prior"}));
  const held = acquirePathLock(join(ctx.bus.home, "locks", "reset-generation.lock"), 0)!;
  try {
    const start = Date.now();
    runTeardown(ctx, options);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(JSON.parse(readFileSync(generation, "utf8"))).toMatchObject({state:"reused",first_mutation:"teardown"});
  } finally { held.release(); }
}));
