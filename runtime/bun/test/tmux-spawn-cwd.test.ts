import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inWorkdir, stableSpawnCwd } from "../src/tmux-spawn-cwd";

test("tmux is asked to start panes in HOME, or / when HOME is unusable", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "spawn-cwd-home-")));
  expect(stableSpawnCwd({ HOME: home })).toBe(home);
  expect(stableSpawnCwd({ HOME: join(home, "missing") })).toBe("/");
  expect(stableSpawnCwd({ HOME: "relative/home" })).toBe("/");
  expect(stableSpawnCwd({})).toBe("/");
});

test("the pane command enters the workdir by quoted absolute path before it execs", () => {
  expect(inWorkdir("/srv/it's here", "exec zsh -l")).toBe(`cd '/srv/it'"'"'s here' && exec zsh -l`);
  expect(() => inWorkdir("trees/lane", "exec zsh")).toThrow("absolute");
});

let socket = "";
afterEach(() => {
  if (socket) spawnSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
  socket = "";
});

// tap-p9v8: once the server's own cwd is deleted, tmux 3.7/3.8 ignore -c and
// every pane inherits the deleted directory. TAP's spawn shape must still
// start the program in its workdir. (On a tmux with upstream a8523db8 both
// shapes work; the assertion holds either way.)
test("a TAP-shaped spawn starts in its workdir on a server whose cwd was deleted", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "spawn-cwd-")));
  const doomed = join(root, "doomed"), home = join(root, "home"), work = join(root, "work");
  for (const dir of [doomed, home, work]) mkdirSync(dir);
  socket = join(root, "s");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.TMUX; delete env.TMUX_PANE;
  const tmux = (...args: string[]) => spawnSync("tmux", ["-S", socket, ...args], { cwd: doomed, env, encoding: "utf8" });
  expect(tmux("start-server", ";", "set-option", "-s", "exit-empty", "off").status).toBe(0);
  rmdirSync(doomed);

  const created = spawnSync("tmux", ["-S", socket, "new-session", "-d", "-s", "seat", "-c", stableSpawnCwd(env),
    inWorkdir(work, "exec /bin/sh -c '/bin/pwd -P > started-here'")], { cwd: root, env, encoding: "utf8" });
  expect(created.status).toBe(0);
  const marker = join(work, "started-here");
  const deadline = Date.now() + 5000;
  while (!existsSync(marker) && Date.now() < deadline) Bun.sleepSync(20);
  expect(readFileSync(marker, "utf8").trim()).toBe(work);
});
