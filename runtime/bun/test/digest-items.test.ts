import { afterAll, expect, test } from "bun:test";
import { digestPlan, numberDigestItems } from "../src/digest-items";
import { writeDigestIndex } from "../src/digest-index";

const a = { id: "a", path: "/bus/payloads/a.md", reply: "expected" };
const b = { id: "b", path: "/bus/payloads/b.md", reply: "settle-only" };
const plan = (items: unknown[], ordinal?: string) => digestPlan({
  doc: { kind: "digest", digest_id: "courier-batch", items }, path: "/bus/spool/digests/courier-batch.json",
  verb: "read", all: false, selected: "", ordinal, verbose: false,
});
test("numbers identify the same member after a rewrite removes a row", () => {
  const original = numberDigestItems([a, b]);
  const rewritten = numberDigestItems([b], original);
  expect(plan(rewritten, "2").items[0]?.id).toBe("b");
  expect(() => plan(rewritten, "1")).toThrow("no item at index");
  expect(() => numberDigestItems([a, b], rewritten)).toThrow("cannot add");
  expect(plan(rewritten).lines.at(-1)).toContain("courier-batch:2");
});
test("selection is bounded and a bare listing carries concrete commands", () => {
  expect(plan([a, b], "1").items).toEqual([{ ...a, ordinal: 1 }]);
  for (const value of ["0", "-1", "3", "abc", "999999999999999999999"])
    expect(() => plan([a, b], value)).toThrow("digest has 2 item(s)");
  expect(plan([a, b]).items).toEqual([]);
  expect(plan([a, b]).lines).toContain("[1] a - ask open");
  expect(plan([a, b]).lines.at(-1)).toBe("Read: tap read courier-batch --all  |  tap read courier-batch:1");
  expect(() => plan([{ ...a, path: "/bus/payloads/b.md" }], "1")).toThrow("path does not match");
});

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stampEnvelope } from "../src/envelope";
import { removeScratchTree } from "./support/scratch";

const repository = realpathSync(join(import.meta.dir, "../../.."));
const scratch: string[] = [];
afterAll(() => { for (const path of scratch) removeScratchTree(path); });

for (const door of ["bash", "bun"] as const) test(door + " digest selectors preserve item identity and ordinary read/reply gates", () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "tap-digest-items.")));
  scratch.push(work);
  const root = join(work, "team"), bus = join(root, ".tap/bus"), index = join(work, "index"), home = join(work, "home");
  for (const path of [join(bus, "payloads"), join(bus, "receipts"), join(bus, "spool/digests"), index, home])
    mkdirSync(path, { recursive: true });
  const registry = join(root, ".tap/team-registry.json");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "alpha", worktree_root: root }, seats: {
    worker: { status: "active", delivery: "poll", harness: "daemon", instance: "worker|now" },
    sender: { status: "active", delivery: "poll", harness: "daemon", instance: "sender|now" },
  } }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20",
    teams: { alpha: { root, registry_location: registry, state: "registered" } } }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PWD: root, TAP_HOME: bus, TAP_INDEX_HOME: index,
    TAP_SELF: "worker", TAP_VERBOSE: "0", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    TAP_SESSION_MANIFEST: join(work, "sessions.json"), TAP_VERSION_SEEN_PATH: join(work, "seen.json"),
    OPENCODE_DB_PATH: join(work, "opencode.db"), TAP_SPOOL_DISABLE_DELIVERER: "1", TAP_SPOOL_DISABLE_OPPORTUNISTIC: "1" };
  delete env.TMUX; delete env.TMUX_PANE; delete env.TAP_EPOCH;
  const trace = join(work, "routes");
  function run(args: string[]) {
    writeFileSync(trace, "");
    const started = performance.now();
    const result = spawnSync(door === "bun" ? process.execPath : "bash",
      door === "bun" ? [join(repository, "runtime/bun/main.ts"), ...args] : [join(repository, "scripts/tap.sh"), ...args],
      { cwd: root, env: { ...env, TAP_BUN_ROUTE_TRACE: trace }, encoding: "utf8", timeout: 15_000 });
    if (result.error || result.status === null) throw new Error(JSON.stringify({ door, args,
      elapsedMs: Math.round(performance.now() - started), signal: result.signal,
      error: result.error?.message }));
    return { code: result.status, out: result.stdout, err: result.stderr, route: readFileSync(trace, "utf8") };
  }
  function payload(id: string, reply: "expected" | "settle-only" = "expected", to = "worker") {
    const path = join(bus, "payloads", id + ".md");
    writeFileSync(path, stampEnvelope("---\n---\npayload-body-" + id + "\n", {
      id, from: "sender", to, kind: "discuss", path, reply, recipient_instance: to + "|now",
    }));
  }
  // `tap_digest_write_index` was a thin shell over this builder and is gone with the digest
  // transaction that was its only production caller. This fixture wants the index BYTES, so
  // it calls the builder — the same bytes, one process fewer, and nothing here was ever
  // asserting the shell wrapper.
  function indexFor(id: string, members: string[]) {
    // The timing and `result.error` diagnostics on this call site were added (e4e0c9e62) to
    // debug the SUBPROCESS. A5 removes the subprocess, so there is no spawn error, no signal
    // and no timeout left to report — the flake they were chasing cannot occur on an
    // in-process call. Resolved toward A5 deliberately, and reported to that change's author
    // rather than silently dropped: deleting someone else's instrument is a decision.
    mkdirSync(join(bus, "spool/digests"), { recursive: true });
    writeDigestIndex({ indexPath: join(bus, "spool/digests", id + ".json"), digestId: id,
      toTeam: "alpha", handle: "worker", courier: "courier", spoolDir: join(bus, "spool"),
      payloadsDir: join(bus, "payloads"), members: members.map(m => ({ id: m, presettled: false })) });
  }
  const receipt = (id: string, kind: string) => join(bus, "receipts", id + "." + kind);
  payload("note", "settle-only"); payload("ask"); payload("spare"); payload("literal.1");
  indexFor("courier-batch", ["note", "ask", "spare"]);
  const listing = run(["show", "alpha/courier-batch"]);
  expect(listing.code).toBe(0);
  expect(listing.out).toContain("[1] note");
  expect(listing.out).toContain("tap read alpha/courier-batch:1");
  expect(readdirSync(join(bus, "receipts"))).toEqual([]);

  const shown = run(["show", "courier-batch:2"]);
  expect(shown.code).toBe(0); expect(shown.out).toContain("payload-body-ask");
  if (door === "bun") expect(shown.route).toBe("native show\n");
  const read = run(["read", "courier-batch:1"]);
  expect({ code: read.code, err: read.err }).toEqual({ code: 0, err: "" });
  if (door === "bun") expect(read.route).toBe("native read\n");
  expect(existsSync(receipt("note", "done"))).toBe(true);
  expect(existsSync(receipt("ask", "done"))).toBe(false);
  expect(existsSync(receipt("spare", "done"))).toBe(false);
  expect(existsSync(receipt("courier-batch", "read"))).toBe(false);

  const replied = run(["reply", "courier-batch:2", "-m", "answer"]);
  expect({ code: replied.code, err: replied.err }).toEqual({ code: 0, err: "" });
  if (door === "bun") expect(replied.route).toBe("native reply\n");
  const done = JSON.parse(readFileSync(receipt("ask", "done"), "utf8"));
  expect(done.reply_id).toBeTruthy();
  expect(readFileSync(join(bus, "payloads", done.reply_id + ".md"), "utf8")).toContain("in_reply_to: ask");
  expect(existsSync(receipt("courier-batch", "read"))).toBe(false);
  expect(existsSync(receipt("courier-batch", "done"))).toBe(false);
  const legacySelected = run(["read", "courier-batch", "--item", "spare"]);
  expect(legacySelected.code).toBe(0);
  expect(existsSync(receipt("spare", "read"))).toBe(true);
  expect(existsSync(receipt("courier-batch", "read"))).toBe(false);
  const bare = run(["read", "courier-batch"]);
  expect(bare.code).toBe(0); expect(bare.out).not.toContain("payload-body-");
  expect(existsSync(receipt("spare", "done"))).toBe(false);
  expect(run(["show", "literal.1"]).out).toContain("payload-body-literal.1");
  for (const n of ["0", "-1", "4", "abc"]) {
    const invalid = run(["show", "courier-batch:" + n]);
    expect(invalid.code).not.toBe(0); expect(invalid.err).toContain("digest has 3 item(s)");
  }
  expect(run(["read", "literal.1:1"]).code).not.toBe(0);
  const invalidReply = run(["reply", "courier-batch:0", "-m", "must not send"]);
  expect(invalidReply.code).not.toBe(0);
  expect(invalidReply.err).toContain("digest has 3 item(s)");
  if (door === "bun") expect(invalidReply.route).toBe("native reply\n");

  payload("alien", "expected", "someone-else");
  indexFor("courier-foreign-item", ["alien"]);
  expect(run(["read", "courier-foreign-item:1"]).code).not.toBe(0);
  expect(existsSync(receipt("alien", "read"))).toBe(false);
  expect(existsSync(receipt("alien", "done"))).toBe(false);
  expect(existsSync(receipt("courier-foreign-item", "read"))).toBe(false);

  for (const args of [["read", "courier-foreign-item:1", "--force"],
    ["read", "courier-foreign-item", "--item", "alien", "--force"]]) {
    expect(run(args).code).toBe(0);
    expect(existsSync(receipt("alien", "done"))).toBe(false);
    expect(existsSync(receipt("courier-foreign-item", "read"))).toBe(false);
  }

  // A qualified index retains the sender-bus read route and outbound durability guard.
  const foreignRoot = join(work, "foreign"), foreignBus = join(foreignRoot, ".tap/bus");
  for (const path of ["payloads", "receipts", "spool/digests"]) mkdirSync(join(foreignBus, path), { recursive: true });
  const foreignRegistry = join(foreignRoot, ".tap/team-registry.json");
  writeFileSync(foreignRegistry, JSON.stringify({ schema: "0.20", team: { name: "beta", worktree_root: foreignRoot },
    seats: { sender: { status: "active", delivery: "poll", harness: "daemon", instance: "sender|foreign" } } }));
  const global = JSON.parse(readFileSync(join(index, "global-registry.json"), "utf8"));
  global.teams.beta = { root: foreignRoot, registry_location: foreignRegistry, state: "registered" };
  writeFileSync(join(index, "global-registry.json"), JSON.stringify(global));
  const foreignPath = join(foreignBus, "payloads", "foreign-ask.md");
  writeFileSync(foreignPath, stampEnvelope("---\n---\nforeign-body\n", { id: "foreign-ask", from: "sender", from_team: "beta",
    to: "worker", to_team: "alpha", kind: "discuss", reply: "expected", path: foreignPath, recipient_instance: "worker|now" }));
  writeFileSync(join(foreignBus, "spool/digests/courier-foreign.json"), JSON.stringify({ kind: "digest", digest_id: "courier-foreign",
    to: "worker", to_team: "alpha", items: [{ id: "foreign-ask", path: foreignPath }] }));
  expect(run(["show", "beta/courier-foreign:1"]).out).toContain("foreign-body");
  expect(run(["read", "beta/courier-foreign:1"]).code).toBe(0);
  expect(existsSync(join(foreignBus, "receipts/foreign-ask.read"))).toBe(true);
  const foreignReply = run(["reply", "beta/courier-foreign:1", "-m", "foreign answer"]);
  // Cross-team delivery to a poll seat is unsupported by the existing relay.
  expect(foreignReply.code).toBe(1);
  expect(foreignReply.err).toContain("outbound to beta/sender");
  expect(foreignReply.err).toContain("'foreign-ask' left unsettled");
  expect(existsSync(join(foreignBus, "receipts/foreign-ask.done"))).toBe(false);
  expect(existsSync(receipt("foreign-ask", "done"))).toBe(false);
  expect(existsSync(join(foreignBus, "receipts/courier-foreign.read"))).toBe(false);

  // Drive the real writer's pruning path: a displayed number cannot target the next ask.
  payload("first"); payload("second");
  indexFor("courier-pruned", ["first", "second"]);
  expect(run(["show", "courier-pruned"]).out).toContain("[1] first");
  indexFor("courier-pruned", ["second"]);
  const before = readdirSync(join(bus, "payloads")).sort();
  expect(run(["reply", "alpha/courier-pruned:1", "-m", "must not send"]).code).not.toBe(0);
  expect(readdirSync(join(bus, "payloads")).sort()).toEqual(before);
  expect(existsSync(receipt("second", "done"))).toBe(false);
  expect(run(["show", "alpha/courier-pruned:2"]).out).toContain("payload-body-second");
}, 60_000);
