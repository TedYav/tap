import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeScratchTree } from "./support/scratch";

const ROOT = join(import.meta.dir, "../../..");
const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) removeScratchTree(path); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tap-whoami-seat."));
  scratch.push(dir);
  const team = join(dir, "team"), index = join(dir, "index"), bin = join(dir, "bin");
  const registry = join(team, ".tap", "team-registry.json");
  for (const path of [join(team, ".tap", "bus"), index, bin]) mkdirSync(path, { recursive: true });
  const seat = { pane: "team/driver:0.1", pane_id: "%7", session: "team/driver",
    server_epoch: "srv:123:456", status: "active", crew: true, instance: "crew|original" };
  const write = (seats: Record<string, unknown>) => writeFileSync(registry, JSON.stringify({
    schema: "0.20", team: { name: "team", worktree_root: team }, seats,
  }));
  write({ crew: seat });
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    team: { root: team, registry_location: registry, state: "registered" },
  } }));
  // tmux is the external observation boundary; registry selection and CLI run for real.
  writeFileSync(join(bin, "tmux"), `#!/bin/bash
printf '%s\\n' "$*" >> "$LOOKUP_TRACE"
case "$*" in
  *capture-pane*|*show-options*|*list-panes*) exit 99 ;;
esac
case "\${LOOKUP_MODE:-ok}" in
  gone) echo "can't find pane: %7" >&2; exit 1 ;;
  no-server) echo 'no server running on /fixture/socket' >&2; exit 1 ;;
  denied) echo 'error connecting to /fixture/socket (Permission denied)' >&2; exit 1 ;;
  empty) exit 0 ;;
  unknown) printf '%%7\\tteam/driver\\t:\\n'; exit 0 ;;
esac
case "$*" in
  *pane_id*session_name*pid*start_time*) printf '%%7\\tteam/driver\\t123:456\\n' ;;
  *pid*start_time*) printf '123:456\\n' ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
  const env = { ...process.env, HOME: dir, TAP_INDEX_HOME: index,
    PATH: `${bin}:${process.env.PATH}`, TAP_TMUX_SOCKET_PATH: join(dir, "socket"),
    LOOKUP_TRACE: join(dir, "trace"), TAP_SKIP_VERSION_BRIEFING: "1" };
  for (const key of ["TAP_HOME", "TMUX", "TMUX_PANE", "TAP_TMUX_SOCKET", "CLAUDE_CODE_SESSION_ID", "CLAUDE_JOB_DIR"])
    delete (env as NodeJS.ProcessEnv)[key];
  const run = (args: string[] = [], cwd = team, extra: NodeJS.ProcessEnv = {}) => {
    const r = Bun.spawnSync([join(ROOT, "bin/tap"), "whoami", "--json", "--pane", "%7", ...args], {
      cwd, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe", timeout: 15000,
    });
    expect(r.stderr.toString()).toBe("");
    return { code: r.exitCode, value: JSON.parse(r.stdout.toString()) };
  };
  return { dir, team, registry, seat, write, run, env };
}

test("explicit team lookup works outside the repo and carries crew and instance without dashboard probes", () => {
  const f = fixture();
  expect(f.run(["--team", "team"], f.dir)).toMatchObject({ code: 0, value: {
    handle: "crew", team: "team", pane_id: "%7", crew: true, instance: "crew|original",
  } });
  const calls = readFileSync(f.env.LOOKUP_TRACE, "utf8").trim().split("\n");
  expect(calls.length).toBeLessThanOrEqual(4);
  expect(calls.every(call => call.includes("display-message"))).toBe(true);
});

test.each([
  { server_epoch: "srv:old:1" }, { server_epoch: "" }, { pane_id: "" },
  { session: "another/session" },
])("unverifiable row binding is never returned: %j", patch => {
  const f = fixture();
  f.write({ stale: { ...f.seat, ...patch, pane: "%7" } });
  expect(f.run()).toMatchObject({ code: 2, value: { error_class: "unregistered" } });
});

test("corrupt registry is unknown, never confirmed unregistered", () => {
  const f = fixture();
  writeFileSync(f.registry, "{broken");
  expect(f.run().value.error_class).toBe("pane_unknown");
});

test("two current rows cannot supply an arbitrary seat", () => {
  const f = fixture();
  f.write({ a: f.seat, b: { ...f.seat, instance: "b|other" } });
  expect(f.run().value.error_class).toBe("pane_contested");
});

test("absence and unobservable generation keep distinct error classes", () => {
  const f = fixture();
  f.write({});
  expect(f.run().value.error_class).toBe("unregistered");
  expect(f.run([], f.team, { LOOKUP_MODE: "unknown" }).value.error_class).toBe("generation_unverifiable");
  expect(f.run([], f.team, { LOOKUP_MODE: "gone" }).value.error_class).toBe("pane_gone");
  expect(f.run([], f.team, { LOOKUP_MODE: "no-server" }).value.error_class).toBe("pane_gone");
});

test.each(["denied", "empty"])("a %s tmux observation never claims structural absence", mode => {
  const f = fixture();
  expect(f.run([], f.team, { LOOKUP_MODE: mode }).value.error_class).toBe("generation_unverifiable");
});

test("human unanchored lookup retains an executable cd remedy", () => {
  const f = fixture();
  const r = f.run([], f.dir);
  expect(r.value.error_class).toBe("unanchored_bus");
  expect(r.value.action).toBe(`cd ${f.team}`);
});

test("a real sibling exit never turns a positional legacy row into the surviving pane's identity", () => {
  const f = fixture();
  const socket = join(f.dir, "private-tmux.sock");
  const tmux = (args: string[]) => {
    const r = Bun.spawnSync(["tmux", "-S", socket, ...args], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  try {
    const lower = tmux(["-f", "/dev/null", "new-session", "-d", "-s", "team/driver", "-P", "-F", "#{pane_id}", "sleep 60"]);
    const upper = tmux(["split-window", "-d", "-t", lower, "-P", "-F", "#{pane_id}", "sleep 60"]);
    const epoch = `srv:${tmux(["display-message", "-p", "-t", upper, "#{pid}:#{start_time}"])}`;
    f.write({ stale: { ...f.seat, pane_id: "", pane: "team/driver:0.0", server_epoch: epoch },
      survivor: { ...f.seat, pane_id: upper, server_epoch: epoch } });
    tmux(["kill-pane", "-t", lower]);
    expect(tmux(["display-message", "-p", "-t", upper, "#{pane_index}"])).toBe("0");
    const r = f.run(["--pane", upper], f.team, { PATH: process.env.PATH, TAP_TMUX_SOCKET_PATH: socket });
    expect(r).toMatchObject({ code: 0, value: { handle: "survivor", pane_id: upper, crew: true } });
    f.write({ stale: { ...f.seat, pane_id: "", pane: "team/driver:0.0", server_epoch: epoch } });
    expect(f.run(["--pane", "team/driver:0.0"], f.team, { PATH: process.env.PATH,
      TAP_TMUX_SOCKET_PATH: socket }).value.error_class).toBe("unregistered");
  } finally { tmux(["kill-server"]); }
});
