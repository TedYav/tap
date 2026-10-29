import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assignCreatedCrew, type CreatedCrew } from "../src/crew-assignment";
import { resolveContext } from "../src/context";
import { removeScratchTree } from "./support/scratch";

const saved = new Map<string, string | undefined>();
let scratch = "";
afterEach(() => {
  for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  saved.clear();
  if (scratch) removeScratchTree(scratch);
  scratch = "";
});

function fixture() {
  scratch = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR!, "crew-assign-")));
  const bus = join(scratch, ".tap/bus"), index = join(scratch, "index"), registry = join(scratch, ".tap/team-registry.json");
  mkdirSync(bus, { recursive: true }); mkdirSync(index);
  const expected: CreatedCrew = { handle: "child", instance: "child-one", pane: "%1", owner: "owner", ownerInstance: "owner-one", harness: "codex", model: "gpt-test", preset: "fixture", configDigest: "digest" };
  const document = { schema: "0.20", team: { name: "t", worktree_root: scratch }, seats: {
    owner: { status: "active", delivery: "poll", instance: "owner-one" },
    lane: { status: "active", delivery: "poll", instance: "lane-one" },
    // Poll delivery exercises the real assignment and publication path without
    // a terminal. Public crew-add smoke covers creation in an actual pane.
    child: { crew: true, status: "active", delivery: "poll", instance: "child-one", pane_id: "%1",
      crew_owner: "owner", crew_owner_instance: "owner-one", harness: "codex", model: "gpt-test",
      preset: { name: "fixture", config_digest: "digest" }, harness_session_id: "native-one",
      crew_identity_capture: { decision: "accepted", observed_harness_session_id: "native-one" } } as Record<string, unknown>,
  } };
  const save = () => writeFileSync(registry, JSON.stringify(document)); save();
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    t: { root: scratch, registry_location: registry, state: "registered" },
  } }));
  const pins = { TAP_HOME: bus, TAP_INDEX_HOME: index, TAP_LOCK_DIR: join(scratch, "locks"), TAP_SPOOL_DISABLE_DELIVERER: "1",
    TMUX: undefined, TMUX_PANE: undefined, TAP_SELF: undefined, TAP_ASSIGN_VERB: undefined };
  for (const [key, value] of Object.entries(pins)) { saved.set(key, process.env[key]); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  const ctx = resolveContext(scratch, process.env, { explicitTeam: "t" });
  const brief = join(scratch, "brief.md"); writeFileSync(brief, "Run tap whoami; report the handle with the bounded review.\n");
  const payloads = () => { try { return readdirSync(join(bus, "payloads")).filter(name => name.endsWith(".md")); } catch { return []; } };
  const assign = (replyTo = "lane") => assignCreatedCrew(ctx, expected, brief, replyTo, join(import.meta.dir, "../../../skills/tap/scripts"));
  return { document, save, expected, assign, bus, registry, payloads };
}

test("verified creation assigns a tracked order to the exact crew with a durable reply destination", () => {
  const f = fixture();
  expect(f.assign()).toBe(0);
  expect(f.payloads()).toHaveLength(1);
  const payload = readFileSync(join(f.bus, "payloads", f.payloads()[0]!), "utf8");
  expect(payload).toContain("to: child\n");
  expect(payload).toContain("recipient_instance: child-one\n");
  expect(payload).toContain("reply: expected\n");
  expect(payload).toContain("kind: order\n");
  expect(payload).toContain("reply_to: t/lane\n");
  expect(payload).toContain("Run tap whoami; report the handle with the bounded review.");
  expect(process.env.TAP_ASSIGN_VERB).toBeUndefined();
});

for (const [name, change] of Object.entries({
  instance: { instance: "replacement" }, pane: { pane_id: "%2" }, parent: { crew_owner_instance: "replacement" }, status: { status: "suspended" }, crew: { crew: false },
  harness: { harness: "claude" }, model: { model: "another" }, preset: { preset: { name: "another", config_digest: "digest" } },
  digest: { preset: { name: "fixture", config_digest: "changed" } },
  unavailable: { crew_identity_capture: { decision: "unavailable" } },
  quarantined: { crew_identity_capture: { decision: "quarantined", observed_harness_session_id: "native-one" } },
  capture: { crew_identity_capture: { decision: "accepted", observed_harness_session_id: "another" } },
})) test(`created crew ${name} mismatch refuses without assigning`, () => {
  const f = fixture(); Object.assign(f.document.seats.child, change); f.save();
  expect(f.assign).toThrow("not assigned");
  expect(f.payloads()).toEqual([]);
});

test("an assignment refusal after creation retains the crew and names the partial outcome", () => {
  const f = fixture();
  expect(() => f.assign("missing-lane")).toThrow("started t/child; assignment not confirmed");
  expect(f.payloads()).toEqual([]);
  expect(JSON.parse(readFileSync(f.registry, "utf8")).seats.child.instance).toBe("child-one");
  expect(process.env.TAP_ASSIGN_VERB).toBeUndefined();
});

for (const [args, detail] of [
  [["--reply-to", "lane"], "--reply-to requires --assign"],
  [["--assign", "/nonexistent/crew-brief.md"], "no crew started"],
  [["--assign", ""], "--assign requires a non-empty value"],
  [["--assign="], "--assign requires a non-empty value"],
  [["--reply-to", ""], "--reply-to requires a non-empty value"],
  [["--reply-to="], "--reply-to requires a non-empty value"],
] as const) test(`crew add preflights ${args[0]} before launch effects`, () => {
  const f = fixture(), before = readFileSync(f.registry, "utf8");
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../main.ts"), "crew", "add", "codex", "new-child", "--model", "gpt-test", ...args],
    { env: process.env, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain(detail);
  expect(readFileSync(f.registry, "utf8")).toBe(before);
  expect(f.payloads()).toEqual([]);
});
