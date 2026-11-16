import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeScratchTree } from "./support/scratch";

const root = resolve(import.meta.dir, "../../..");
const cases: [string[], string][] = [
  [["debug", "on"], "usage: tap debug"],
  [["debug", "config", "--always-on"], "usage: tap debug"],
  [["debug", "recovery", "example-id"], "usage: tap debug"],
  [["out", "example-seat", "--kill"], "tap unregister"],
  [["team", "stop"], "tap team"],
  [["team", "down", "--yes"], "tap team down"],
  [["team", "shutdown", "--yes"], "tap team shutdown"],
  [["team", "out", "--kill", "--yes"], "tap team out"],
  [["crew", "shutdown", "example-crew"], "tap crew"],
  [["cancel", "example-id"], "tap cancel"],
  [["team", "refresh", "--stale", "--yes"], "tap team refresh"],
  [["session", "relaunch", "example-seat"], "tap session"],
  ...["dashboard", "ps", "refresh", "retire", "rebuild-registry", "migrate-registry", "prune"]
    .map(sub => [["admin", sub, "example-team"], "tap admin"] as [string[], string]),
  [["uninstall", "--yes"], "tap uninstall"],
  [["nudge", "--all"], "tap nudge"],
  [["resend", "example-id"], "tap resend"],
  [["send", "example-seat", "-f", "/dev/null"], "tap send"],
  [["assign", "example-seat", "-f", "/dev/null"], "tap assign"],
  [["reply", "example-id", "-f", "/dev/null"], "tap reply"],
  [["ask", "codex", "-f", "/dev/null"], "tap ask"],
];

function snapshot(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? [path + "/", ...snapshot(path)] : [path + "\0" + readFileSync(path).toString("base64")];
  }).sort();
}

test("help options on effect-bearing argv return help without dispatch or durable writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "tap-help-safety."));
  try {
    const index = join(dir, "index");
    mkdirSync(index);
    writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
    for (const child of ["tmp", "cache", "config", "bun", "locks", "tmux"]) mkdirSync(join(dir, child));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, TAP_INDEX_HOME: index, TAP_HOME: join(dir, "bus"),
      TAP_SESSION_MANIFEST: join(index, "sessions.json"), TAP_LOCK_DIR: join(dir, "locks"),
      TAP_VERSION_SEEN_PATH: join(dir, "version-seen.json"), OPENCODE_DB_PATH: join(dir, "opencode.db"),
      TMPDIR: join(dir, "tmp"), TMUX_TMPDIR: join(dir, "tmux"), TAP_TMUX_SOCKET_PATH: join(dir, "tmux/socket"),
      XDG_CACHE_HOME: join(dir, "cache"), XDG_CONFIG_HOME: join(dir, "config"),
      XDG_DATA_HOME: join(dir, "data"), XDG_STATE_HOME: join(dir, "state"), XDG_RUNTIME_DIR: join(dir, "runtime"),
      BUN_INSTALL: join(dir, "bun") };
    delete env.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
    delete env.TAP_SELF;
    delete env.TMUX;
    delete env.TMUX_PANE;
    const capture = join(dir, "capture");
    mkdirSync(capture);
    mkdirSync(join(index, "debug"));
    writeFileSync(join(index, "debug/enabled.json"), JSON.stringify({ id: "capture", directory: capture }));
    const before = snapshot(dir);
    for (const verb of ["roster", "reset"]) {
      for (const argv of [["help", verb], [verb, "help"], [verb, "-h"], [verb, "--help"]]) {
        const child = spawnSync(join(root, "bin/tap"), argv, { cwd: dir, env, encoding: "utf8", timeout: 10000 });
        expect({ argv, status: child.status, stderr: child.stderr }).toEqual({ argv, status: 0, stderr: "" });
        expect(child.stdout).toContain(`NAME\n  tap ${verb}`);
        expect(snapshot(dir)).toEqual(before);
      }
    }
    for (const verb of ["admin", "bus", "command", "completion", "config", "crew", "goalie", "init",
      "keybinding", "self", "session", "spool", "tmux-defaults", "watch", "worktree"]) {
      const child = spawnSync(join(root, "bin/tap"), [verb, "help"], { cwd: dir, env, encoding: "utf8", timeout: 10000 });
      expect({ verb, status: child.status, stderr: child.stderr }).toEqual({ verb, status: 0, stderr: "" });
      expect(child.stdout.length).toBeGreaterThan(0);
      expect(snapshot(dir)).toEqual(before);
    }
    for (const [args, name] of cases) {
      for (const flag of ["--help", "-h"]) {
        for (const position of [1, args.length]) {
          const argv = [...args.slice(0, position), flag, ...args.slice(position)];
          const child = spawnSync(join(root, "bin/tap"), argv, { cwd: dir, env, encoding: "utf8", timeout: 10000 });
          expect({ argv, status: child.status, stderr: child.stderr }).toEqual({ argv, status: 0, stderr: "" });
          expect(child.stdout).toContain(name);
          expect(snapshot(dir)).toEqual(before);
        }
      }
    }
  } finally { removeScratchTree(dir); }
}, 60000);

test("positional help resources and help flags after the separator stay data", async () => {
  const { isHelpForm } = await import("../src/help");
  for (const verb of ["send", "assign", "out", "in", "team", "teams", "doctor", "role", "restore", "nudge"]) {
    expect({ verb, help: isHelpForm([verb, "help"]) }).toEqual({ verb, help: false });
  }
  for (const argv of [["send", "example-seat", "--", "--help"], ["out", "--", "-h"]]) {
    expect(isHelpForm(argv)).toBe(false);
  }
});

test("closed-set command families retain positional help aliases", async () => {
  const { isHelpForm } = await import("../src/help");
  for (const verb of ["admin", "bus", "command", "completion", "config", "crew", "goalie", "init",
    "keybinding", "self", "session", "spool", "tmux-defaults", "watch", "worktree"]) {
    expect({ verb, help: isHelpForm([verb, "help"]) }).toEqual({ verb, help: true });
  }
});
