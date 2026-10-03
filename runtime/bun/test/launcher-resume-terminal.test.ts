// No TAP process restores a stale terminal mode over the caller's at exit, as
// the Python launcher never did. A Bun process writes back its startup termios
// on every std-fd tty when it exits, which would undo a mode the foreground
// owner set while a background (or stdin-piped) command was still running.
// That covers resume.ts and resume-all.ts, and the Bun router that holds the
// tty while its Bash fallback runs (tap-uzhrp). Each case parks the command on
// an explicit rendezvous (a fake tmux call), switches the tty to raw from the
// foreground owner, releases it, and reads the mode after the command exits.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../../..");
const OWNER = resolve(import.meta.dir, "support/pty-foreground-owner.py");
const SHAPES = ["bg-ignored", "bg-default", "stdin-pipe", "stdout-pipe", "out-err-pipe"];
const TAP = join(REPO, "bin/tap");
// Every door that reaches the native resume entries, with and without the router.
const DOORS: Record<string, { argv: string[]; env: (home: string) => NodeJS.ProcessEnv }> = {
  "native session door": { argv: [process.execPath, join(REPO, "runtime/bun/src/launcher/session-doors.ts"), "resume"], env: () => ({}) },
  "bin/tap (router)": { argv: [TAP, "session", "resume"], env: () => ({}) },
};
// The rendezvous is a tmux call only the native process (or its child) makes.
const FORMS: Record<string, { args: string[]; park: string }> = {
  "resume <key>": { args: ["nobody"], park: "*has-session*nobody*" },
  "resume --all": { args: ["--all"], park: "*display-message*{pid}*" },
};

function underForegroundOwner(argv: string[], park: string, doorEnv: (home: string) => NodeJS.ProcessEnv, shape: string) {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "resume-tty-")));
  const bin = join(work, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\ncase "$*" in ${park}) if mkdir '${work}/once' 2>/dev/null; then `
    + `touch '${work}/reached'; while [ ! -f '${work}/release' ]; do sleep 0.02; done; fi;; esac\nexit 1\n`);
  chmodSync(join(bin, "tmux"), 0o755);
  const root = join(work, "root");
  mkdirSync(join(root, ".tap/bus"), { recursive: true });
  writeFileSync(join(root, ".tap/bus/registry.json"), `${JSON.stringify({ schema: "0.20", team: { name: "repo" }, seats: {} })}\n`);
  // Born live (F1): the entry guard refuses an unenrolled worktree before any rendezvous.
  const index = join(work, "index");
  mkdirSync(index);
  writeFileSync(join(index, "global-registry.json"), `${JSON.stringify({ schema: "0.20",
    teams: { repo: { root, registry_location: join(root, ".tap/bus/registry.json"), state: "registered" } } })}\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROBE_RESULT: join(work, "result"), TAP_INDEX_HOME: index };
  for (const key of ["TAP_HOME", "TMUX", "TMUX_PANE", "TAP_STARTUP_TRACE_CONTEXT"]) delete env[key];
  Object.assign(env, doorEnv(join(work, "home")));
  const run = spawnSync("python3", [OWNER, work, shape, ...argv], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(readFileSync(join(work, "result"), "utf8")) as Record<string, unknown>;
}

for (const form of Object.keys(FORMS)) for (const door of Object.keys(DOORS)) {
  test(`${form} through ${door}: a mode the foreground owner set mid-run survives the exit`, () => {
    for (const shape of SHAPES) {
      const result = underForegroundOwner([...DOORS[door]!.argv, ...FORMS[form]!.args], FORMS[form]!.park, DOORS[door]!.env, shape);
      // The command ran to its own refusal (exit 2), never stopped by job control.
      expect(result, shape).toMatchObject({ shape, before: true, during: false, exit: 2, after: false, settled: false });
    }
  }, 120_000);
}

// A native verb the router runs in-process holds the tty the same way
// (tap-5jbnq): `whoami` under a pane parks on its first tmux call.
test("a native verb through bin/tap: a mode the foreground owner set mid-run survives the exit", () => {
  const pane = () => ({ TMUX: "/nonexistent/tap-tty-socket,1,0", TMUX_PANE: "%9" });
  for (const shape of SHAPES) {
    const result = underForegroundOwner([TAP, "whoami"], "*", pane, shape);
    expect(result, shape).toMatchObject({ shape, before: true, during: false, after: false, settled: false });
    expect(String(result.exit), shape).not.toMatch(/^(stopped|signal|timeout)/);
  }
}, 120_000);
