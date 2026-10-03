import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { payloadPreview } from "../src/sentinel-preview";
import { removeScratchTree } from "./support/scratch";

const root = resolve(import.meta.dir, "../../..");
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) removeScratchTree(dir); });

// A never-attempted spooled send whose frontmatter carries `stored` (or no field), resent natively.
// `enabled` writes the machine preview toggle: the carry must not depend on it.
function resend(stored: string | undefined, enabled: boolean): { status: number | null; stdout: string; successor: string; path: string; config: string } {
  const dir = mkdtempSync(join(tmpdir(), "tap-resend-preview."));
  scratch.push(dir);
  const bus = join(dir, ".tap", "bus");
  for (const name of ["spool", "payloads", "receipts", "archive"]) mkdirSync(join(bus, name), { recursive: true });
  mkdirSync(join(dir, "index"), { recursive: true });
  writeFileSync(join(dir, "index", "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
  writeFileSync(join(bus, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "t", worktree_root: dir }, seats: {
    alice: { delivery: "poll", status: "active", harness: "codex" },
    peer: { delivery: "poll", status: "active", harness: "codex" },
  } }));
  const field = stored === undefined ? "" : `sentinel_preview: ${stored}\n`;
  writeFileSync(join(bus, "spool/original.md"),
    `---\nid: original\nfrom: alice\nto: peer\nkind: discuss\nreply: expected\n${field}path: ${bus}/payloads/original.md\n---\nFirst body line\nsecond\n`);
  writeFileSync(join(bus, "spool/original.meta.json"), JSON.stringify({ id: "original", attempts: 0, attempt_fence: 1, reason: "busy" }));
  const env = { ...process.env, HOME: dir, TAP_HOME: bus, TAP_INDEX_HOME: join(dir, "index"),
    TAP_LOCK_DIR: join(dir, "locks"), TAP_SESSION_MANIFEST: join(dir, "sessions.json"), TAP_VERSION_SEEN_PATH: join(dir, "version.json"),
    OPENCODE_DB_PATH: join(dir, "opencode.db"), TAP_TMUX_SOCKET_PATH: join(mkdtempSync(join(process.env.TMUX_TMPDIR!, "s.")), "tmux"),
    TAP_SPOOL_DISABLE_OPPORTUNISTIC: "1", TAP_SPOOL_DISABLE_DELIVERER: "1", TAP_SELF: "alice" };
  const config = join(dir, "config");
  mkdirSync(join(config, "tap"), { recursive: true });
  writeFileSync(join(config, "tap/config.toml"), `[sentinel]\npreview = ${enabled}\n`);
  Object.assign(env, { XDG_CONFIG_HOME: config });
  const result = spawnSync(process.execPath, [join(root, "runtime/bun/main.ts"), "resend", "original", "--by", "alice", "--json"],
    { cwd: dir, env, encoding: "utf8", timeout: 15000 });
  const receipt = JSON.parse(result.stdout);
  const path = join(bus, "payloads", `${receipt.id}.md`);
  return { status: result.status, stdout: result.stdout, successor: readFileSync(path, "utf8"), path, config };
}
const stamped = (payload: string) => /^sentinel_preview: (.*)$/m.exec(payload.split("\n---\n")[0]!)?.[1];

// Rendered preview as a reader sees it (payloadPreview reads the toggle from XDG_CONFIG_HOME).
function rendered(run: { path: string; config: string }, enabled: boolean): string {
  const prior = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = run.config;
  try { return payloadPreview(run.path); } finally { if (prior === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prior; }
}

for (const enabled of [true, false]) {
  const shown = (text: string) => enabled ? text : "";
  test(`resend carries an accepted explicit hint (previews ${enabled})`, () => {
    const hint = Buffer.from("Gate authorization").toString("base64");
    const run = resend(hint, enabled);
    expect(run.status).toBe(0);
    expect(stamped(run.successor)).toBe(hint);
    expect(rendered(run, enabled)).toBe(shown("Gate authorization"));
  });

  test(`resend carries a rejected hint's suppression marker (previews ${enabled})`, () => {
    const run = resend("-", enabled);
    expect(run.status).toBe(0);
    expect(stamped(run.successor)).toBe("-");
    expect(rendered(run, enabled)).toBe("");
  });

  test(`resend of a send with no hint still derives (previews ${enabled})`, () => {
    const run = resend(undefined, enabled);
    expect(run.status).toBe(0);
    expect(stamped(run.successor)).toBeUndefined();
    expect(rendered(run, enabled)).toBe(shown("First body line"));
  });
}

test("resend turns an unreadable stored hint into the suppression marker", () => {
  const run = resend("not*base64", true);
  expect(run.status).toBe(0);
  expect(stamped(run.successor)).toBe("-");
  expect(rendered(run, true)).toBe("");
});
