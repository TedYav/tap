// `tap session list` revive column for Cursor rows (tap-tu714): a stored chat id
// whose conversation store never appeared reads "stale" — the word the launch
// collision chooser already uses — in the table AND in --json, from the same
// artifact probe resume consults. A persisted conversation, a live pane and
// every other harness keep the tier they always had.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { buildFixtureTree, fixtureEnv, type FixtureMap } from "./support/launcher-list/fixtures";
import { removeScratchTree } from "./support/scratch";

const module = join(resolve(import.meta.dir, "../../.."), "runtime/bun/src/launcher/list.ts");
// A socket of this file's own: nothing else may flip the live flags.
const tmuxSocket = "tapbun-list-cursor-revive";
const tmux = (args: string[]) => spawnSync("tmux", ["-L", tmuxSocket, ...args], { encoding: "utf8" });

const STALE_ID = "019a1111-2222-7333-8444-555555555551";
const PERSISTED_ID = "019a1111-2222-7333-8444-555555555552";
const LIVE_ID = "019a1111-2222-7333-8444-555555555553";
const CLAUDE_ID = "019a1111-2222-7333-8444-555555555554";
const SEAT_HOME_ID = "019a1111-2222-7333-8444-555555555555";
const UNSET_ID = "019a1111-2222-7333-8444-555555555556";
const RELATIVE_ID = "019a1111-2222-7333-8444-555555555557";
const SHELL_ID = "019a1111-2222-7333-8444-555555555558";

let fx: FixtureMap;
let cursorHome: string;
let seatHome: string;
let workdir: string;

/** <root>/chats/<md5(workdir)>/<chat-uuid>/store.db: the layout resume's probe reads. */
function writeStore(root: string, forDir: string, id: string): void {
  const store = join(root, "chats", createHash("md5").update(forDir, "utf8").digest("hex"), id, "store.db");
  mkdirSync(join(store, ".."), { recursive: true });
  writeFileSync(store, "");
}

function seat(over: Record<string, unknown>): Record<string, unknown> {
  return {
    status: "active", delivery: "pane", pane: "demo/x:0.0", pane_id: "%1", harness: "cursor",
    registered_from_worktree: fx.root, base: "demo", index: 1, last_seen: "2026-09-20T10:00:00Z", ...over,
  };
}

beforeAll(() => {
  fx = buildFixtureTree();
  cursorHome = join(fx.fg, "cursor-home");
  seatHome = join(fx.fg, "seat-cursor-home");
  workdir = join(fx.root, "wd2");
  mkdirSync(workdir, { recursive: true });
  writeStore(cursorHome, fx.root, PERSISTED_ID);
  // Only under the seat's own CURSOR_HOME, which outranks the ambient TAP_CURSOR_HOME.
  writeStore(seatHome, fx.root, SEAT_HOME_ID);
  // Under the ambient root, which the seat's explicit unset of CURSOR_HOME takes away.
  writeStore(cursorHome, fx.root, UNSET_ID);
  // A relative CURSOR_HOME resolves at the directory the seat's cursor runs in.
  writeStore(join(workdir, "rel-cursor"), workdir, RELATIVE_ID);
  const seats = {
    stale: seat({ session: "demo/cursor-stale", tag: "stale", harness_session_id: STALE_ID, last_seen: "2026-09-20T10:05:00Z" }),
    persisted: seat({ session: "demo/cursor-persisted", tag: "persisted", harness_session_id: PERSISTED_ID, last_seen: "2026-09-20T10:04:00Z" }),
    live: seat({ session: "demo/cursor-live", tag: "live", harness_session_id: LIVE_ID, last_seen: "2026-09-20T10:03:00Z" }),
    shell: seat({ session: "demo/cursor-shell", tag: "shell", harness_session_id: SHELL_ID, last_seen: "2026-09-20T10:09:00Z" }),
    idless: seat({ session: "demo/cursor-idless", tag: "idless", last_seen: "2026-09-20T10:02:00Z" }),
    seathome: seat({ session: "demo/cursor-seathome", tag: "seathome", harness_session_id: SEAT_HOME_ID, harness_env: { CURSOR_HOME: seatHome }, last_seen: "2026-09-20T10:06:00Z" }),
    unset: seat({ session: "demo/cursor-unset", tag: "unset", harness_session_id: UNSET_ID, harness_unset_env: ["CURSOR_HOME", "TAP_CURSOR_HOME"], last_seen: "2026-09-20T10:07:00Z" }),
    relative: seat({ session: "demo/cursor-relative", tag: "relative", harness_session_id: RELATIVE_ID, launch_workdir: workdir, harness_env: { CURSOR_HOME: "rel-cursor" }, last_seen: "2026-09-20T10:08:00Z" }),
    claude: seat({ session: "demo/claude-id", tag: "claude-id", harness: "claude", harness_session_id: CLAUDE_ID, last_seen: "2026-09-20T10:01:00Z" }),
  };
  const registry = join(fx.reg, "cursor-revive.json");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "demo", worktree_root: fx.root }, seats }));
  mkdirSync(join(fx.fg, "index-cursor-revive"), { recursive: true });
  writeFileSync(join(fx.fg, "index-cursor-revive", "global-registry.json"), JSON.stringify({
    schema: "0.20",
    teams: { alpha: { root: realpathSync(fx.root), registry_location: realpathSync(registry), state: "registered" } },
  }));
  // A pane whose foreground command is named for the harness: the classifier's "live".
  const harnessBin = join(fx.fg, "bin");
  mkdirSync(harnessBin, { recursive: true });
  symlinkSync("/bin/sleep", join(harnessBin, "cursor"));
  // A default shell pane is running but NOT attachable: resume falls through it to the stale refusal.
  for (const argv of [["demo/cursor-live", `${join(harnessBin, "cursor")} 600`], ["demo/cursor-shell"]]) {
    const created = tmux(["new-session", "-d", "-s", ...argv]);
    if (created.status !== 0) throw new Error(`tmux create failed: ${created.stderr}`);
  }
});

afterAll(() => {
  tmux(["kill-server"]);
  removeScratchTree(fx.fg);
});

function list(args: string[]) {
  const env = fixtureEnv(fx, {
    TAP_INDEX_HOME: join(fx.fg, "index-cursor-revive"),
    TAP_TMUX_SOCKET: tmuxSocket,
    TAP_CURSOR_HOME: cursorHome,
  });
  return spawnSync("bun", [module, ...args, "--cwd", fx.root], { cwd: "/tmp", env, encoding: "utf8" });
}

/** The revive cell of each row, keyed by session name, read from the table's columns. */
function tableRevive(): Record<string, string> {
  const result = list([]);
  expect(result.status).toBe(0);
  const [header, ...rows] = result.stdout.trimEnd().split("\n");
  const column = header!.indexOf("revive");
  return Object.fromEntries(rows.map(row => [row.split(/\s+/)[0]!, row.slice(column).split(/\s+/)[0]!]));
}

function jsonRevive(): Record<string, string> {
  const result = list(["--json"]);
  expect(result.status).toBe(0);
  const doc = JSON.parse(result.stdout) as { sessions: Array<{ name: string; revive: string }> };
  return Object.fromEntries(doc.sessions.map(row => [row.name, row.revive]));
}

const EXPECTED = {
  "demo/cursor-stale": "stale",
  "demo/cursor-persisted": "exact",
  "demo/cursor-live": "exact",
  "demo/cursor-shell": "stale",
  "demo/cursor-idless": "fresh",
  "demo/claude-id": "exact",
  "demo/cursor-seathome": "exact",
  "demo/cursor-unset": "stale",
  "demo/cursor-relative": "exact",
};

describe("revive column for a Cursor row", () => {
  test("the table names a stale Cursor id, and keeps the other tiers", () => {
    expect(tableRevive()).toEqual(EXPECTED);
  });

  test("--json carries the same word for the same rows", () => {
    expect(jsonRevive()).toEqual(EXPECTED);
  });

  test("text and JSON agree row for row", () => {
    expect(tableRevive()).toEqual(jsonRevive());
  });
});

describe("a tmux client that stalls after the snapshot", () => {
  test("the classifier read is bounded and refuses as an unobservable namespace, not a hang", () => {
    // The snapshot answers at once and names the stale row's session; every later tmux call hangs.
    const shimDir = join(fx.fg, "stall-bin");
    mkdirSync(shimDir, { recursive: true });
    const shim = join(shimDir, "tmux");
    writeFileSync(shim, `#!/bin/sh
case "$*" in
  *"list-panes -a"*) printf 'demo/cursor-stale\\t0\\n' ;;
  *) exec sleep 60 ;;
esac
`);
    chmodSync(shim, 0o755);
    const env = fixtureEnv(fx, {
      TAP_INDEX_HOME: join(fx.fg, "index-cursor-revive"),
      TAP_CURSOR_HOME: cursorHome,
      PATH: `${shimDir}:${process.env.PATH}`,
    });
    const started = Date.now();
    const result = spawnSync("bun", [module, "--cwd", fx.root], { cwd: "/tmp", env, encoding: "utf8", timeout: 30000 });
    expect(result.stderr).toContain("tmux session-name snapshot is unobservable");
    expect(result.status).toBe(2);
    expect(Date.now() - started).toBeLessThan(25000);
  });
});
