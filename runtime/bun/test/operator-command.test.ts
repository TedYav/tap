import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { lookupHelp } from "../src/help";
import { completionCandidates } from "../src/completion";
import { PUBLIC_SKILLS } from "../src/skill-policy";

const repo = resolve(import.meta.dir, "../../.."), root = mkdtempSync(join(tmpdir(), "tap-operator-command-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
for (const path of ["index", ".tap/bus", "bin"]) mkdirSync(join(root, path), { recursive: true });
writeFileSync(join(root, ".tap/bus/registry.json"), JSON.stringify({ schema: "0.20", team: { name: "fixture", worktree_root: root }, seats: {} }));
writeFileSync(join(root, "index/global-registry.json"), JSON.stringify({ schema: "0.20", teams: { fixture: { root, registry_location: join(root, ".tap/bus/registry.json") } } }));
const spy = join(root, "bin/tmux");
writeFileSync(spy, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SPY_CALLS"\nexit 1\n'); chmodSync(spy, 0o700);
const env = { ...process.env, HOME: root, TAP_INDEX_HOME: join(root, "index"), TAP_HOME: join(root, ".tap/bus"),
  XDG_CONFIG_HOME: join(root, "config"), TAP_CONFIG_HOME: join(root, "config/tap"), PATH: join(root, "bin") + ":" + process.env.PATH,
  SPY_CALLS: join(root, "calls") };
const run = (...args: string[]) => spawnSync(join(repo, "bin/tap"), args, { cwd: root, env, encoding: "utf8", timeout: 30000 });

test("public help exposes opt-in authority, exact action grammar and the UI-only result", () => {
  const help = run("operate", "--help");
  expect(help.status).toBe(0); expect(help.stdout).toBe(lookupHelp(["operate"]).stdout);
  for (const phrase of ["operator_after", "off", "ask", "on", "--approve", "--reply-file", "--sample", "two minutes", "processing", "no movement", "prior state"]) expect(help.stdout).toContain(phrase);
});
test("off refuses through the native JSON door before any pane observation or launch", () => {
  const result = run("operate", "target", "--preset", "unused", "--json");
  expect(result.status).toBe(1); expect(result.stderr).toBe("");
  const object = JSON.parse(result.stdout); expect(object.error_class).toBe("operator_refused"); expect(object.detail).toContain("off");
  expect(existsSync(join(root, "calls"))).toBe(false); expect(existsSync(join(root, "index/debug/recovery"))).toBe(false);
});
test("invalid public grammar returns canonical structured failure without target effects", () => {
  const result = run("operate", "target", "--json");
  expect(result.status).toBe(1); expect(result.stderr).toBe(""); expect(JSON.parse(result.stdout).error_class).toBe("usage_error");
  expect(existsSync(join(root, "calls"))).toBe(false);
});
test("completion and native skill discovery expose the supported entrypoints", () => {
  expect(completionCandidates(["tap", "oper"], 2, env, root).map(x => x.value)).toContain("operate");
  expect(completionCandidates(["tap", "operate", "--"], 3, env, root).map(x => x.value)).toContain("--preset");
  expect(PUBLIC_SKILLS).toContain("harness-operator");
  const result = run("help", "skill", "harness-operator"); expect(result.status).toBe(0);
  const path = result.stdout.trim(); expect(path).toEndWith("skills/harness-operator/SKILL.md");
  expect(readFileSync(path, "utf8")).toContain("tap operate");
});
