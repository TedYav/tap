import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removeScratchTree } from "./support/scratch";

const repo = join(import.meta.dir, "../../..");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "tap-poll-native.")));
afterAll(() => removeScratchTree(scratch));
const doors = ["native", "root-shim"] as const;
type Door = typeof doors[number] | "handler";

function fixture(enrolled = true) {
  const root = mkdtempSync(join(scratch, "f.")), index = join(root, "index"), home = join(root, "home");
  const cwd = join(root, "recipient"), bus = join(cwd, ".tap/bus"), registry = join(cwd, ".tap/team-registry.json");
  const away = join(root, "sender"), foreign = join(away, ".tap/bus"), foreignRegistry = join(away, ".tap/team-registry.json");
  for (const base of [bus, foreign]) for (const dir of ["payloads", "spool", "receipts"]) mkdirSync(join(base, dir), { recursive: true });
  mkdirSync(index); mkdirSync(join(home, ".tap"), { recursive: true });
  const doc = { schema: "0.20", team: { name: "recipient", worktree_root: cwd }, seats: {
    me: { status: "active", instance: "me|new", adopted_handles: ["fork"], adopted_instances: { fork: "fork|old" } },
  }, seat_forwardings: [{ source: "old", source_instance: "old|1", destination: "me", destination_instance: "me|new", at: "now", address_active: true }] };
  writeFileSync(registry, JSON.stringify(doc));
  writeFileSync(join(bus, "registry.json"), JSON.stringify(enrolled ? { seats: { me: { instance: "me|decoy" } } } : doc));
  writeFileSync(foreignRegistry, JSON.stringify({ schema: "0.20", team: { name: "sender", worktree_root: away }, seats: { me: { instance: "me|foreign" } } }));
  // Born live (F1): an unenrolled fixture still has a live, empty machine index.
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: enrolled ? {
    recipient: { root: cwd, registry_location: registry, state: "registered" },
    sender: { root: away, registry_location: foreignRegistry, state: "registered" },
  } : {} }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TAP_HOME: bus, TAP_INDEX_HOME: index,
    TAP_SELF: undefined, TMUX: undefined, TMUX_PANE: undefined, TAP_VERBOSE: "0",
    TAP_JSON: "0", TAP_LOCK_DIR: join(root, "locks"), TAP_SPOOL_NOW: "1788603000",
    TAP_BUN_ROUTE_TRACE: undefined, TAP_SPOOL_DISABLE_DELIVERER: "1" };
  const seed = (id: string, fields: Record<string, string> = {}, parked = false, source = bus) => {
    const path = join(source, parked ? "spool" : "payloads", `${id}.md`);
    const envelope = { id, from: "sender", to: "me", to_team: "recipient", recipient_instance: "me|new", kind: "discuss", reply: "expected", path, ...fields };
    writeFileSync(path, `---\n${Object.entries(envelope).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\nbody\n`);
    if (parked) writeFileSync(join(source, "spool", `${id}.meta.json`), JSON.stringify({ target: envelope.to, reason: "pending-input", first_spooled_epoch: 1 }));
    return path;
  };
  const run = (args: string[] = ["me", "--json"], door: Door = "native", overrides: NodeJS.ProcessEnv = {}, at = cwd) => {
    const command = door === "handler"
      ? [process.execPath, "--eval", `import {cmdPoll} from ${JSON.stringify(join(repo, "runtime/bun/src/verbs/poll.ts"))}; import {runNative} from ${JSON.stringify(join(repo, "runtime/bun/main.ts"))}; process.exitCode=runNative("poll",cmdPoll,${JSON.stringify(args)});`]
      : ["bash", join(repo, door === "root-shim" ? "scripts/tap.sh" : "bin/tap"), "poll", ...args];
    const r = Bun.spawnSync(command, { cwd: at, env: { ...env, ...overrides }, stdout: "pipe", stderr: "pipe", timeout: 15000 });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  return { root, index, home, cwd, bus, registry, foreign, foreignRegistry, doc, env, seed, run };
}

for (const door of doors) test(`${door}: pending and empty both exit 0 and differ by output; quiet, JSON and usage are native terminal outcomes`, () => {
  const f = fixture();
  f.seed("pending", { reply: "settle-only", epoch: "7", from_team: "sender", reply_to: "recipient/leader" });
  for (const args of [["me"], ["me", "--quiet"], ["me", "--json"], ["me", "--quiet", "--json"]]) {
    const r = f.run(args, door);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("pending");
    if (args.includes("--json")) {
      expect(JSON.parse(r.out)).toMatchObject({ ok: true, agent: "me", team: "recipient", pending: [{ id: "pending", epoch: "7", reply_to: "recipient/leader" }] });
    } else {
      expect(r.out).toContain("next step: tap read pending --by me --epoch 7");
      expect(r.err).toContain("no courier .placed/.sent");
    }
  }
  writeFileSync(join(f.bus, "receipts/pending.done"), "{}\n");
  expect(f.run(["me", "--quiet"], door)).toMatchObject({ code: 0, out: "" });
  expect(f.run(["me"], door)).toMatchObject({ code: 0, out: "tap poll: empty\n" });
  for (const args of [["me", "--team"], ["me", "--team", ""], ["me", "--bogus"], ["me", "another"]]) {
    const r = f.run(args, door);
    expect(r.code, r.err).toBe(1);
    expect(r.out).toBe("");
  }
  expect(f.run(["--json", "me", "--team"], door).code).toBe(1);
  expect(f.run(["--help"], door).code).toBe(0);
}, 60_000);

test("canonical and parked rows share exact adoption, instance and queue authority", () => {
  const f = fixture();
  for (const parked of [false, true]) {
    const prefix = parked ? "queued-" : "local-";
    f.seed(prefix + "current", {}, parked);
    f.seed(prefix + "unbound", { recipient_instance: "" }, parked);
    f.seed(prefix + "rewritten", { to_adopted_from: "fork", recipient_instance: "fork|old" }, parked);
    f.seed(prefix + "unrevised", { to: "fork", recipient_instance: "fork|old" }, parked);
    f.seed(prefix + "wrong-adoption", { to_adopted_from: "fork", recipient_instance: "fork|other" }, parked);
    f.seed(prefix + "old-instance", { recipient_instance: "me|old" }, parked);
    f.seed(prefix + "wrong-team", { to_team: "sender" }, parked);
  }
  f.seed("drifted", {}, true);
  writeFileSync(join(f.bus, "spool/drifted.meta.json"), '{"target":"other"}');
  f.seed("missing-meta", {}, true);
  writeFileSync(join(f.bus, "spool/missing-meta.meta.json"), "null");
  f.seed("canonical-wins", {}, true); const canonical = f.seed("canonical-wins");
  const r = f.run(); expect(r.code, r.err).toBe(0);
  const rows = JSON.parse(r.out).pending;
  expect(rows.map((v: { id: string }) => v.id).sort()).toEqual(["canonical-wins", ...["local-", "queued-"].flatMap(p => ["current", "unbound", "rewritten", "unrevised"].map(n => p + n))].sort());
  expect(rows.find((v: { id: string }) => v.id === "local-rewritten").adopted_from).toBe("fork");
  expect(rows.find((v: { id: string }) => v.id === "canonical-wins").path).toBe(canonical);
  expect(readdirSync(join(f.bus, "receipts"))).toEqual([]);
});

for (const door of doors) test(`${door}: an explicit canonical bus pin grounds an empty read; cwd alone does not`, () => {
  const f = fixture(false), cwd = join(f.root, "standalone"), pinned = join(cwd, ".tap/bus");
  mkdirSync(cwd);
  const unpinned = f.run(["me", "--json"], door, { TAP_HOME: undefined }, cwd);
  expect(unpinned.code, unpinned.err || unpinned.out).toBe(4);
  expect(JSON.parse(unpinned.out).error_class).toBe("unanchored_bus");
  expect(existsSync(join(cwd, ".tap"))).toBe(false);
  const explicit = f.run(["me", "--json"], door, { TAP_HOME: pinned }, cwd);
  expect(explicit.code, explicit.err || explicit.out).toBe(0);
  expect(JSON.parse(explicit.out).pending).toEqual([]);
  expect(existsSync(join(pinned, "payloads"))).toBe(true);
  expect(existsSync(join(pinned, "registry.json"))).toBe(false);
  // Honoring the pin cannot bypass an invalid authority marker.
  writeFileSync(join(f.index, "global-registry.json"), "{");
  const refused = f.run(["me", "--json"], door, { TAP_HOME: join(f.root, "other/.tap/bus") }, cwd);
  expect(refused.code).toBe(1);
  expect(JSON.parse(refused.out).error_class).toBe("invalid_flip");
  expect(existsSync(join(f.root, "other"))).toBe(false);
});

test("foreign parked custody uses the recipient registry; source receipts and explicit team remain binding", () => {
  const f = fixture(), paths: string[] = [];
  for (const parked of [false, true]) {
    const id = parked ? "foreign-queued" : "foreign-canonical";
    paths.push(f.seed(id, { to: "old", recipient_instance: "old|1" }, parked, f.foreign));
    f.seed(id + "-unbound", { to: "old", recipient_instance: "" }, parked, f.foreign);
    f.seed(id + "-wrong-team", { to: "old", recipient_instance: "old|1", to_team: "sender" }, parked, f.foreign);
    f.seed(id + "-unqualified", { to: "old", recipient_instance: "old|1", to_team: "" }, parked, f.foreign);
    f.seed(id + "-matching-handle", { recipient_instance: "", to_team: "" }, parked, f.foreign);
    f.seed(id + "-decoy", { recipient_instance: "me|foreign" }, parked, f.foreign);
    // A receipt on the recipient bus never settles bytes on the sender bus.
    writeFileSync(join(f.bus, "receipts", id + ".done"), "{}");
  }
  const broken = join(f.foreign, "payloads/broken.md"); writeFileSync(broken, "foreign evidence");
  const before = paths.map(p => readFileSync(p, "utf8"));
  const result = f.run(); expect(result.code, result.err).toBe(0);
  expect(JSON.parse(result.out).pending.map((r: { id: string }) => r.id).sort()).toEqual(["foreign-canonical", "foreign-queued"]);
  expect(result.err).toContain("ambiguous unstamped predecessor mail");
  expect(f.run(["me"]).out).toContain(`tap read path=${paths[1]} --by me`);
  expect(paths.map(p => readFileSync(p, "utf8"))).toEqual(before);
  expect(readFileSync(broken, "utf8")).toBe("foreign evidence");
  expect(existsSync(join(f.foreign, "payloads/.quarantine"))).toBe(false);
  expect(readdirSync(join(f.foreign, "receipts"))).toEqual([]);
  writeFileSync(join(f.foreign, "receipts/foreign-canonical.done"), "{}");
  expect(JSON.parse(f.run().out).pending.map((r: { id: string }) => r.id)).toEqual(["foreign-queued"]);
  f.doc.seats.me.instance = "me|replacement"; writeFileSync(f.registry, JSON.stringify(f.doc));
  const replaced = f.run();
  expect(replaced.code, replaced.err).toBe(0);
  expect(JSON.parse(replaced.out).pending).toEqual([]);
});

test("malformed isolation preserves bytes and quiet/JSON stderr while valid siblings stay pending", () => {
  for (const args of [["me", "--quiet"], ["me", "--json"], ["me", "--quiet", "--json"]]) {
    const f = fixture(); f.seed("good"); f.seed("invalid-reply", { reply: "optional" });
    writeFileSync(join(f.bus, "payloads/broken.md"), Buffer.from([255, 0, 10]));
    f.seed("mismatch", { id: "different" });
    writeFileSync(join(f.bus, "spool/parked-broken.md"), "parked evidence");
    const result = f.run(args);
    expect(result.code).toBe(0);
    expect(result.out).toContain("good"); expect(result.out).toContain("invalid-reply");
    expect(result.out).not.toContain("quarantined");
    expect(result.err).toContain("quarantined 2 malformed payload(s)");
    expect(readFileSync(join(f.bus, "payloads/.quarantine/broken.md"))).toEqual(Buffer.from([255, 0, 10]));
    expect(readFileSync(join(f.bus, "spool/parked-broken.md"), "utf8")).toBe("parked evidence");
    expect(f.run(args).err).not.toContain("quarantined 2");
  }
});

test("direct native diagnosis refuses unobserved cwd and reset before creating directories", () => {
  const f = fixture(), elsewhere = join(f.root, "unanchored"); mkdirSync(elsewhere);
  const fake = join(f.root, "bin"); mkdirSync(fake);
  writeFileSync(join(fake, "ps"), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const result = f.run(["me", "--json"], "handler", { TAP_HOME: undefined, PATH: `${fake}:${process.env.PATH}` }, elsewhere);
  expect(result.code, result.err).toBe(4);
  expect(JSON.parse(result.out)).toMatchObject({ ok: false, error_class: "unanchored_bus" });
  expect(JSON.parse(result.out).detail).toContain("not observable");
  expect(existsSync(join(elsewhere, ".tap"))).toBe(false);
  const fenced = join(f.root, "fenced"); mkdirSync(fenced); writeFileSync(join(fenced, "reset.fence.json"), "{}");
  const refusal = f.run(["me", "--json"], "handler", { TAP_HOME: fenced });
  expect(refusal.code).toBe(1);
  expect(existsSync(join(fenced, "payloads"))).toBe(false);
});

test("native unanchored diagnosis binds remedies to observed session and generation", () => {
  for (const [kind, record, errorClass] of [
    ["observed", "%700\t/dev/ttypoll\trecipient/me\t123:456", "unanchored_bus"],
    ["missing-session", "%700\t/dev/ttypoll\t\t123:456", "pane_gone"],
    ["missing-epoch", "%700\t/dev/ttypoll\trecipient/me\t", "pane_unknown"],
    ["tty-drift", "%700\t/dev/different\trecipient/me\t123:456", "unanchored_bus"],
    ["contested", "%700\t/dev/ttypoll\trecipient/me\t123:456", "pane_contested"],
  ]) {
    const f = fixture(), elsewhere = join(f.root, "outside"), fake = join(f.root, "bin");
    mkdirSync(elsewhere); mkdirSync(fake);
    writeFileSync(join(fake, "ps"), '#!/bin/sh\nprintf "1 ttypoll\\n"\n', { mode: 0o755 });
    writeFileSync(join(fake, "tmux"), '#!/bin/sh\ncase "$*" in\n*list-panes*) printf "%s\\t%s\\n" "%700" "/dev/ttypoll" ;;\n*display-message*) printf "%s\\n" "$POLL_RECORD" ;;\n*) exit 1 ;;\nesac\n', { mode: 0o755 });
    const seat = { status: "active", pane_id: "%700", pane: "recipient/me:0.0", session: "recipient/me", server_epoch: "srv:123:456", instance: "me|new" };
    Object.assign(f.doc.seats.me, seat); writeFileSync(f.registry, JSON.stringify(f.doc));
    if (kind === "contested") writeFileSync(f.foreignRegistry, JSON.stringify({ schema: "0.20", team: { name: "sender" }, seats: { other: seat } }));
    const result = f.run(["me", "--json"], "handler", { TAP_HOME: undefined, TAP_SERVER_EPOCH: undefined,
      PATH: `${fake}:${process.env.PATH}`, POLL_RECORD: record, TAP_TMUX_SOCKET_PATH: join(f.root, "socket") }, elsewhere);
    expect(result.code, result.err || result.out).toBe(4);
    const error = JSON.parse(result.out);
    expect(error.error_class, kind).toBe(errorClass);
    if (kind === "observed") expect(error.action).toBe(`cd ${f.cwd}  OR  pass --team recipient`);
    else expect(error.action).not.toContain("--team recipient");
    expect(existsSync(join(elsewhere, ".tap"))).toBe(false);
  }
});
