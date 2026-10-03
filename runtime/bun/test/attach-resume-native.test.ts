import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { removeScratchTree } from "./support/scratch";

// R11: an accepted `tap attach` resume runs the router's own `session resume`
// through Bun (verbArgv), never `bash tap.sh`. TAP_VERB_SCRIPT is verbArgv's
// recorder seam, so the child's argv and cwd are observed without a harness.
const repo = resolve(import.meta.dir, "../../..");
const PTY = resolve(import.meta.dir, "support/pty-prompt.py");
const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) removeScratchTree(path); });

test("an accepted attach resume spawns the native session resume door", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tap-attach-resume-")));
  scratch.push(dir);
  const root = join(dir, "fx"), index = join(dir, "index"), registry = join(root, ".tap", "team-registry.json");
  mkdirSync(join(root, ".tap", "bus"), { recursive: true });
  mkdirSync(index, { recursive: true });
  expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fx", worktree_root: root }, seats: {
    sleepy: { status: "offline", delivery: "pane", session: "fx/sleepy", pane: "fx/sleepy:0.0", harness: "claude", instance: "sleepy|A" },
  } }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { fx: { root, registry_location: registry, state: "registered" } } }));
  const recorder = join(dir, "recorder.sh");
  writeFileSync(recorder, `printf '%s|' "$@" > '${join(dir, "argv")}'\npwd -P > '${join(dir, "cwd")}'\nexit 7\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(dir, "home"), TAP_INDEX_HOME: index, TAP_VERB_SCRIPT: recorder, TAP_ONBOARDING_CHECKED: "1" };
  for (const key of ["TMUX", "TMUX_PANE", "TAP_HOME"]) delete env[key];
  const result = spawnSync(process.env.TAP_PYTHON ?? "python3", ["-B", PTY, JSON.stringify(["y\n"]), process.execPath, join(repo, "runtime/bun/main.ts"), "attach", "sleepy"],
    { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  expect(result.status, result.stderr).toBe(0);
  const pty = JSON.parse(result.stdout) as { exit: number | null; output: string };
  expect(pty.output).toContain("resume it first? [Y/n]");
  expect(readFileSync(join(dir, "argv"), "utf8")).toBe("session|resume|sleepy|");
  expect(readFileSync(join(dir, "cwd"), "utf8").trim()).toBe(root);
  expect(pty.exit, pty.output).toBe(7);
}, 60_000);
