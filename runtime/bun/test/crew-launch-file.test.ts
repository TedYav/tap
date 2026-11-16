import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cleanupCrewLaunchFiles, prepareCrewLaunchFile } from "../src/crew-launch-file";
import { shellQuote } from "../src/shell-quote";
import { removeScratchTree } from "./support/scratch";

function isolatedHome(body: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "crew-launch-home-"));
  try { body(home); } finally { removeScratchTree(home); }
}

test("launch file exec preserves the pane process and unlinks its private payload before the harness", () => isolatedHome(home => {
  const value = "a ' literal\n$(touch injected)", file = prepareCrewLaunchFile(`/usr/bin/env EXAMPLE=${shellQuote(value)} /bin/sh -c 'printf "%s:%s" "$$" "$EXAMPLE"'`, home);
  const result = spawnSync("/bin/sh", ["-c", `printf '%s:' "$$"; ${file.command}`], { cwd: home, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  const [before, after, ...rest] = result.stdout.split(":");
  expect(before).toBe(after);
  expect(rest.join(":")).toBe(value);
  expect(readdirSync(join(home, ".tap/crew-launch"))).toEqual([]);
  expect(existsSync(join(home, "injected"))).toBe(false);
}));

test("next crew command reaps abandoned payloads, preserves live preparations, and bounds PID reuse", () => isolatedHome(home => {
  const pending = prepareCrewLaunchFile("/bin/true", home), root = join(home, ".tap/crew-launch");
  const live = join(root, readdirSync(root)[0]!);
  const exited = spawnSync("/bin/sh", ["-c", "exit 0"]);
  const abandoned = mkdtempSync(join(root, `${exited.pid}-`));
  writeFileSync(join(abandoned, "launch.sh"), "EXAMPLE=private-value");
  cleanupCrewLaunchFiles(home);
  expect(existsSync(abandoned)).toBe(true); // An exited creator can still have a queued startup.
  utimesSync(abandoned, new Date(Date.now() - 360000), new Date(Date.now() - 360000));
  cleanupCrewLaunchFiles(home);
  expect(existsSync(abandoned)).toBe(false);
  expect(existsSync(live)).toBe(true);
  utimesSync(live, new Date(0), new Date(0));
  cleanupCrewLaunchFiles(home);
  expect(existsSync(live)).toBe(false);
  pending.discard(); // Idempotent after the consumer or later cleanup won.
}));

test("private payload storage works under TAP's existing umask-002 state directory", () => isolatedHome(home => {
  mkdirSync(join(home, ".tap")); chmodSync(join(home, ".tap"), 0o775);
  const pending = prepareCrewLaunchFile("/bin/true", home);
  pending.discard();
}));

test("a symlinked launch storage root is refused without writing into its target", () => isolatedHome(home => {
  const target = join(home, "clone");
  mkdirSync(target); mkdirSync(join(home, ".tap"));
  symlinkSync(target, join(home, ".tap/crew-launch"));
  expect(() => prepareCrewLaunchFile("/bin/true", home)).toThrow("private user-owned directory");
  expect(readdirSync(target)).toEqual([]);
}));
