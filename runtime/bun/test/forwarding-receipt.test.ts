import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { removeScratchTree } from "./support/scratch";

const root = resolve(import.meta.dir, "../../..");
const bun = process.execPath;

function fixture(direct: boolean, note = false) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "tap-forward-receipt.")));
  const cwd = join(scratch, "receiver"), home = join(cwd, ".tap/bus"), away = join(scratch, "sender");
  const foreign = join(away, ".tap/bus"), index = join(scratch, "index");
  for (const dir of [home, foreign]) for (const part of ["payloads", "receipts", "spool"]) mkdirSync(join(dir, part), { recursive: true });
  for (const dir of [index, join(scratch, "user")]) mkdirSync(dir);
  const registry = join(cwd, ".tap/team-registry.json"), wrongRegistry = join(away, ".tap/team-registry.json");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "receiver", worktree_root: cwd },
    seats: { b: { instance: "b|one", delivery: "poll", status: "active" } }, seat_forwardings: [{
      source: "a", source_instance: "a|one", destination: "b", destination_instance: "b|one", at: "now", address_active: true,
    }] }));
  writeFileSync(wrongRegistry, JSON.stringify({ schema: "0.20", team: { name: "sender", worktree_root: away },
    seats: { b: { instance: "b|wrong-team", delivery: "poll", status: "active" } } }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    receiver: { root: cwd, registry_location: registry, state: "registered" },
    sender: { root: away, registry_location: wrongRegistry, state: "registered" },
  } }));
  const payload = join(foreign, "payloads/question.md");
  writeFileSync(payload, `---\nid: question\nfrom: worker\nfrom_team: sender\nto: ${direct ? "b" : "a"}\nto_team: receiver\nrecipient_instance: ${direct ? "b|one" : "a|one"}\n${direct ? "to_adopted_from: a\noriginal_recipient_instance: a|one\n" : ""}kind: discuss\nreply: ${note ? "settle-only" : "expected"}\npath: ${payload}\n---\nPRIVATE ORIGINAL BODY\n`);
  const marker = join(scratch, "mutated");
  const env = { ...process.env, HOME: join(scratch, "user"), TAP_HOME: home, TAP_INDEX_HOME: index,
    TAP_SELF: "b", TAP_LOCK_DIR: join(scratch, "locks"), TAP_SESSION_MANIFEST: join(scratch, "sessions.json"),
    TAP_VERSION_SEEN_PATH: join(scratch, "seen.json"), OPENCODE_DB_PATH: join(scratch, "opencode.db"),
    TMUX: undefined, TMUX_PANE: undefined,
    FORWARD_REGISTRY: registry, FORWARD_MARKER: marker };
  // Read's receipt publication is native and in process, so the race is
  // injected INSIDE the read process — at the helper's registry lock, via
  // the mock.module entry — not at a subprocess boundary.
  const run = (mutation = "") => {
    const entry = mutation
      ? join(root, "runtime/bun/test/support/forwarding-injection-entry.ts")
      : join(root, "runtime/bun/main.ts");
    const result = Bun.spawnSync([bun, entry, "read", `path=${payload}`, "--by", "b"], {
      cwd, env: { ...env, FORWARD_MUTATION: mutation }, stdout: "pipe", stderr: "pipe", timeout: 20_000,
    });
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  };
  return { scratch, foreign, home, marker, run };
}

{
  const door = "Native read";
  for (const direct of [false, true]) {
    test(`${door} publishes ${direct ? "direct forwarded" : "historical delegated"} receipt on sender bus`, () => {
      const f = fixture(direct);
      try {
        const result = f.run();
        expect(result.code, result.err).toBe(0);
        const path = join(f.foreign, "receipts/question.read");
        expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ id: "question", by: "b",
          ...(!direct ? { adopted_from: "a" } : {}) });
        expect(existsSync(join(f.home, "receipts/question.read"))).toBe(false);
        const first = readFileSync(path, "utf8");
        expect(f.run().code).toBe(0);
        expect(readFileSync(path, "utf8")).toBe(first);
      } finally { removeScratchTree(f.scratch); }
    }, 30_000);
    for (const mutation of direct ? ["replace"] : ["replace", "restore"]) {
      test(`${door} refuses ${mutation} between ${direct ? "direct" : "historical"} grant and receipt`, () => {
        const f = fixture(direct);
        try {
          const result = f.run(mutation);
          expect(existsSync(f.marker)).toBe(true);
          expect(result.code, result.err).toBe(1);
          expect(result.err).toContain("no receipt written");
          expect(result.out).not.toContain("PRIVATE ORIGINAL BODY");
          expect(existsSync(join(f.foreign, "receipts/question.read"))).toBe(false);
          expect(existsSync(join(f.foreign, "receipts/question.done"))).toBe(false);
        } finally { removeScratchTree(f.scratch); }
      }, 30_000);
    }
  }
}

test("Native delegated note uses first-observation settlement without overwriting its receipt", () => {
  const f = fixture(false, true);
  try {
    const read = f.run();
    expect(read.code, read.err).toBe(0);
    const path = join(f.foreign, "receipts/question.done");
    const first = readFileSync(path, "utf8");
    expect(JSON.parse(first)).toMatchObject({ by: "b", via: "read", adopted_from: "a" });
    expect(f.run().code).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(first);
    expect(existsSync(join(f.foreign, "receipts/question.read"))).toBe(false);
  } finally { removeScratchTree(f.scratch); }
}, 30_000);
