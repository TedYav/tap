import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreSessionPath, tmuxLiteral } from "../src/launcher/session-path";

let socket = "";
afterEach(() => {
  if (socket) spawnSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
  socket = "";
});

function server() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "session-path-")));
  const home = join(root, "home");
  mkdirSync(home);
  socket = join(root, "s");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.TMUX; delete env.TMUX_PANE;
  const tmux = (...args: string[]) => spawnSync("tmux", ["-S", socket, ...args], { cwd: root, env, encoding: "utf8" });
  expect(tmux("-f", "/dev/null", "start-server", ";", "set-option", "-s", "exit-empty", "off").status).toBe(0);
  const read = (target: string, format: string) => tmux("display-message", "-p", "-t", target, format).stdout.replace(/\n$/, "");
  const seat = (name: string) => {
    const made = tmux("new-session", "-d", "-P", "-F", "#{session_id}", "-s", name, "-x", "200", "-y", "60", "-c", home, "sleep 600");
    expect(made.status).toBe(0);
    const id = made.stdout.trim();
    expect(id).toMatch(/^\$\d+$/);
    return id;
  };
  return { root, home, env, tmux, read, seat };
}

test("tmux format syntax in a path stays literal", () => {
  expect(tmuxLiteral("/w/#{session_name}/#S/a##b")).toBe("/w/##{session_name}/##S/a####b");
  // A run of #s before [ is style syntax, which tmux copies verbatim: leave it alone.
  expect(tmuxLiteral("/w/#[x]/##[y]/###[z]")).toBe("/w/#[x]/##[y]/###[z]");
  expect(tmuxLiteral("#a#[b]#")).toBe("##a#[b]##");
});

test("a seat session created in HOME gets its workdir as default, with no attach effects", async () => {
  const s = server();
  const work = join(s.root, "work");
  mkdirSync(work);
  const log = join(s.root, "hooks");
  expect(s.tmux("set-hook", "-g", "client-attached", `run-shell 'echo attached >> ${log}'`).status).toBe(0);
  expect(s.tmux("set-option", "-g", "window-size", "latest").status).toBe(0);
  const id = s.seat("seat");
  expect(s.read(id, "#{session_path}")).toBe(s.home);

  // A caller inside some tmux pane: the inherited TMUX must not make tmux refuse a nested client.
  expect(await restoreSessionPath(socket, id, work, { ...s.env, TMUX: "/elsewhere,1,1", TMUX_PANE: "%9" })).toBe(true);
  expect(s.read(id, "#{session_path}")).toBe(work);
  expect(s.read(id, "#{session_attached} #{window_width}x#{window_height}")).toBe("0 200x60");
  Bun.sleepSync(200);
  expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("");

  // What a person's prefix-c does: a client attached to the session opens a window with no -c.
  spawnSync("tmux", ["-S", socket, "-C", "attach-session", "-t", id], { input: "new-window\n", env: s.env, encoding: "utf8" });
  const opened = s.tmux("list-windows", "-t", id, "-F", "#{pane_start_path}").stdout.trim().split("\n");
  expect(opened.at(-1)).toBe(work);
});

test("paths with spaces, quotes and tmux format syntax read back literally", async () => {
  const s = server();
  for (const name of ["a dir with spaces", "it's \"quoted\"", "#{session_name}", "#S and ##", "#[x]", "##[x]",
    "a#[b]#c#", "###[d", "e#"]) {
    const work = join(s.root, name);
    mkdirSync(work);
    const id = s.seat(`seat-${s.tmux("list-sessions").stdout.split("\n").length}`);
    expect(await restoreSessionPath(socket, id, work, s.env)).toBe(true);
    expect(s.read(id, "#{session_path}")).toBe(work);
  }
});

test("a session that is gone reports false and changes nothing", async () => {
  const s = server();
  const other = s.seat("other");
  expect(await restoreSessionPath(socket, "$999", join(s.root, "work"), s.env)).toBe(false);
  expect(s.read(other, "#{session_path}")).toBe(s.home);
});

test("a read-back that does not match puts the previous directory back", async () => {
  const s = server();
  const work = join(s.root, "#{session_name}");
  mkdirSync(work);
  const id = s.seat("seat");
  // An encoder that loses the literal: tmux expands the format, so the read-back cannot match.
  expect(await restoreSessionPath(socket, id, work, s.env, undefined, path => path)).toBe(false);
  expect(s.read(id, "#{session_path}")).toBe(s.home);
});
