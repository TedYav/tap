import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRun, releaseRun, runDirectory } from "../src/recovery/state";
import { collectArtifacts } from "../src/debug";
import { copyRedactedFile } from "../src/debug-capture";

test("malformed JSON evidence is retained through the text sanitizer", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-malformed-artifact-"));
  const source = join(root, "broken.json"), target = join(root, "safe.json");
  const raw = '{"AUTH_COOKIE":"unknown-secret", "useful":"partial evidence"';
  writeFileSync(source, raw);
  try {
    copyRedactedFile(source, target, {});
    expect(readFileSync(source, "utf8")).toBe(raw);
    expect(readFileSync(target, "utf8")).toContain("partial evidence");
    expect(readFileSync(target, "utf8")).not.toContain("unknown-secret");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("streaming artifact publication reports progress before exposing the destination", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-artifact-progress-"));
  const source = join(root, "tmux-server-123.log"), target = join(root, "safe.log");
  writeFileSync(source, "100.001 TOKEN=secret\n".repeat(10000));
  let progress = 0;
  try {
    copyRedactedFile(source, target, {}, () => { progress++; expect(existsSync(target)).toBe(false); });
    expect(progress).toBeGreaterThan(1);
    expect(readFileSync(target, "utf8")).not.toContain("secret");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tap debug finds recovery by either id and collector retains frames after release with recording off", async () => {
  const root = mkdtempSync(join(tmpdir(), "tap-recovery-artifacts-"));
  const env = { ...process.env, TAP_INDEX_HOME: root, TAP_LOCK_DIR: join(root, "locks") };
  try {
    const journal = join(root, "journal"); mkdirSync(journal);
    writeFileSync(join(journal, "session.json"), JSON.stringify({ id: "debug-session", directory: journal }));
    const run = createRun({ team: "test", handle: "peer", registry: join(root, "registry.json"), pane: "%11", paneId: "%11",
      session: "test/peer", instance: "instance", harness: "codex" }, "aggressive", [{ home: join(root, "bus"), id: "payload-123" }],
      "%12", process.pid, env, { now: Date.now(), processAlive: () => true, paneAlive: () => true });
    const directory = runDirectory(run.id, env);
    writeFileSync(join(directory, "effect.before.ansi"), "\x1b[31mSettings dialog\nSERVICE_TOKEN=artifact-secret\n", { mode: 0o600 });
    writeFileSync(join(directory, "effect.after.ansi"), "› ready\n", { mode: 0o600 });
    writeFileSync(join(directory, "events.jsonl"), JSON.stringify({ recoveryId: run.id, before: "effect.before.ansi", after: "effect.after.ansi", outcome: "unverified" }) + "\n");
    releaseRun(run.id, "staged message submitted; processing unconfirmed", env);
    expect(existsSync(join(root, "debug/enabled.json"))).toBe(false);
    const tap = resolve(import.meta.dir, "../../../bin/tap");
    const unrelated = join(root, "unrelated"); mkdirSync(unrelated);
    const installed = join(root, "installed-tap"); symlinkSync(tap, installed);
    for (const entry of [tap, installed]) for (const query of [run.id, "payload-123"]) {
      const result = spawnSync(entry, ["debug", "recovery", query, "--json"], { cwd: unrelated, env, encoding: "utf8" });
      expect(result.status).toBe(0);
      const found = JSON.parse(result.stdout);
      expect(found).toHaveLength(1); expect(found[0].id).toBe(run.id);
      expect(found[0].payloads[0].id).toBe("payload-123");
      expect(found[0].files).toContain(join(directory, "effect.before.ansi"));
      expect(readFileSync(found[0].files.find((f: string) => f.endsWith("effect.before.ansi")), "utf8")).toContain("Settings dialog");
    }
    // Every public door reaches the native owner without initializing a team.
    // A direct `bun main.ts debug` is not a public door: bin/tap owns debug,
    // so the router refuses it with a pointer.
    const direct = spawnSync(process.execPath, [resolve(import.meta.dir, "../main.ts"), "debug", "status", "--json"], { cwd: unrelated, env, encoding: "utf8" });
    expect(direct.status).toBe(1); expect(direct.stdout).toBe("");
    expect(direct.stderr).toContain("debug runs through the installed tap (bin/tap)");
    const doors = [[installed], [resolve(import.meta.dir, "../../../scripts/tap.sh")], [installed, "-v"]];
    for (const door of doors) {
      const invoke = (args: string[]) => spawnSync(door[0]!, [...door.slice(1), "debug", ...args], { cwd: unrelated, env, encoding: "utf8" });
      const status = invoke(["status", "--json"]);
      expect(status.status, status.stderr).toBe(0);
      expect(JSON.parse(status.stdout)).toEqual({ recording: false, state: "off", mode: "off", directory: null, tmux_logging: false });
      const config = invoke(["config", "--json"]);
      expect(config.status, config.stderr).toBe(0); expect(JSON.parse(config.stdout)).toEqual({ max_mb: 1024, retain_mb: 2048 });
      for (const args of [["config", "--lifetime-hours", "24", "--json"], ["--json", "config", "--lifetime-hours", "24"]]) {
        const retired = invoke(args);
        expect(retired.status).toBe(1); expect(retired.stderr).toBe("");
        expect(JSON.parse(retired.stdout)).toMatchObject({ ok: false, error_class: "renamed_verb", action: "tap debug off" });
      }
      const retiredHuman = invoke(["config", "--lifetime-hours", "24"]);
      expect(retiredHuman.status).toBe(1); expect(retiredHuman.stdout).toBe("");
      expect(retiredHuman.stderr).toContain("next: tap debug off");
      const invalid = invoke(["trace", "0"]);
      expect(invalid.status).toBe(2); expect(invalid.stderr).toContain("finite positive duration"); expect(invalid.stdout).toBe("");
      for (const args of [["trace", "--help"], ["--help"]]) {
        const help = invoke(args); expect(help.status).toBe(0); expect(help.stdout).toContain("status,on,off,config,trace"); expect(help.stdout).toContain("artifact copies rotate out"); expect(help.stderr).toBe("");
      }
    }
    const help = spawnSync(installed, ["help", "debug"], { cwd: unrelated, env, encoding: "utf8" });
    expect(help.status).toBe(0); expect(help.stdout).toContain("status,on,off,config,trace"); expect(help.stdout).toContain("artifact copies rotate out");
    expect(existsSync(join(unrelated, ".tap"))).toBe(false);
    expect(existsSync(join(root, "bus"))).toBe(false);
    expect(existsSync(join(root, "global-registry.json"))).toBe(false);
    await collectArtifacts({ id: "debug-session", directory: journal, socket: "", config: { max_mb: 1024 } }, {}, new Set(), env);
    expect(readFileSync(join(journal, "artifacts", run.id, "effect.before.ansi"), "utf8")).toContain("Settings dialog");
    expect(readFileSync(join(journal, "artifacts", run.id, "effect.before.ansi"), "utf8")).not.toContain("artifact-secret");
    expect(readFileSync(join(directory, "effect.before.ansi"), "utf8")).toContain("artifact-secret");
    const events = readFileSync(join(journal, "events.jsonl"), "utf8");
    expect(events).toContain(run.id); expect(events).toContain("payload-123");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);
