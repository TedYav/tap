import { expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cmdTeamPurge } from "../src/team/purge";

const repo = resolve(import.meta.dir, "../../..");
type Door = "native" | "bun";
function fixture() {
  // The supported runner owns HOME and reclaims every fixture after the job.
  const work = mkdtempSync(join(process.env.HOME!, "purge-"));
  const bus = join(work, "bus"), root = join(bus, "archive/team-reset"), index = join(work, "index"), bin = join(work, "bin");
  for (const path of [root, index, bin]) mkdirSync(path, { recursive: true });
  writeFileSync(join(bus, "registry.json"), '{"schema":"0.20","team":{"name":"purge"},"seats":{}}');
  writeFileSync(join(index, "global-registry.json"), '{"schema":"0.20","teams":{}}'); // born live (F1)
  const env: NodeJS.ProcessEnv = { ...process.env, TAP_HOME: bus, TAP_REGISTRY: join(bus, "registry.json"),
    TAP_INDEX_HOME: index, TAP_SCRATCH_ONLY: work, TAP_ONBOARDING_CHECKED: "1", TAP_JSON: "0", TAP_TEAM_SELECT: "",
    TAP_BUS_RULE: "env", NO_COLOR: "1", PATH: `${bin}:${process.env.PATH}` };
  const archive = (name = "chosen") => {
    const path = join(root, name);
    mkdirSync(path); writeFileSync(join(path, "data"), "preserve these bytes\n");
    return path;
  };
  return { work, bus, root, bin, env, archive };
}
type Fixture = ReturnType<typeof fixture>;
function run(f: Fixture, argv: string[], door: Door = "native", extra: NodeJS.ProcessEnv = {}) {
  const env = { ...f.env, ...extra };
  const command = door === "bun" ? process.execPath : join(repo, "bin/tap");
  const args = [...(door === "bun" ? [join(repo, "runtime/bun/main.ts")] : []), "team", "purge", ...argv];
  return spawnSync(command, args, { env, cwd: f.work, encoding: "utf8", timeout: 15000 });
}
function refusal(f: Fixture, argv: string[], klass: string, door: Door = "native", extra: NodeJS.ProcessEnv = {}) {
  const result = run(f, argv, door, { TAP_JSON: "1", ...extra });
  expect(result.status, result.stderr).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error_class: klass });
  expect(result.stdout).not.toContain("deleted archive");
  return JSON.parse(result.stdout);
}

for (const door of ["native", "bun"] as const) {
  test(`${door}: preview and confirmation preserve bytes; exact deletion preserves sibling and link targets`, () => {
    const f = fixture(), target = f.archive(), sibling = f.archive("sibling");
    linkSync(join(target, "data"), join(target, "hard-link"));
    symlinkSync(sibling, join(target, "nested-link"));
    const bytes = readFileSync(join(target, "data"));
    const size = spawnSync("du", ["-sk", target], { encoding: "utf8" }).stdout.match(/^\s*(\d+)/)![1];
    const preview = run(f, ["chosen", "--dry-run", "--context"], door);
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toBe(`tap team purge: would delete archive 'chosen' (2 file(s), ${size} KiB)\n`);
    expect(readFileSync(join(target, "data"))).toEqual(bytes);
    const denied = refusal(f, ["chosen"], "confirmation_required", door);
    expect(denied.action).toBe("tap team purge chosen --yes");
    expect(readFileSync(join(target, "data"))).toEqual(bytes);
    const deleted = run(f, ["--yes", "chosen"], door);
    expect(deleted.status, deleted.stderr).toBe(0);
    expect(deleted.stdout).toBe(`tap team purge: deleted archive 'chosen' (2 file(s), ${size} KiB freed)\n`);
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(sibling, "data"))).toEqual(bytes);
  }, 30_000);

  test(`${door}: public scope overrides refuse before statistics or deletion`, () => {
    const f = fixture(), target = f.archive();
    const offScope = join(f.work, "different-parent");
    mkdirSync(join(offScope, "chosen"), { recursive: true });
    writeFileSync(join(offScope, "chosen", "keep"), "off-scope");
    // A marker proves even the read-only statistics process was never started.
    writeFileSync(join(f.bin, "du"), '#!/bin/sh\nprintf called > "$TAP_HOME/du-called"\nexit 7\n', { mode: 0o755 });
    for (const args of [["chosen", "--root", offScope, "--yes"], ["--verb", "other", "chosen", "--yes"]]) {
      const result = refusal(f, args, "unknown_option", door);
      expect(result.detail).toBe(`unknown option '${args.includes("--root") ? "--root" : "--verb"}'`);
      expect(existsSync(join(f.bus, "du-called"))).toBe(false);
      expect(existsSync(join(target, "data"))).toBe(true);
      expect(readFileSync(join(offScope, "chosen", "keep"), "utf8")).toBe("off-scope");
    }
  }, 30_000);
}

test("argument refusals and help keep the target intact", () => {
  const f = fixture(), target = f.archive();
  for (const args of [[], [""], ["."], [".."], ["../chosen"], ["chosen/"], [target], ["chosen", "extra"]]) refusal(f, args, "usage_error");
  for (const args of [["chosen", "--bogus"], ["chosen", "--json"], ["chosen", "--"]]) refusal(f, args, "unknown_option");
  refusal(f, ["absent", "--yes"], "not_found");
  expect(run(f, ["--help"]).status).toBe(0);
  expect(existsSync(join(target, "data"))).toBe(true);
}, 30_000);

test("scratch guard compares physical component paths, including a top-level symlink", () => {
  const f = fixture(), target = f.archive();
  const prefix = join(f.work, "bu"); mkdirSync(prefix);
  refusal(f, ["chosen", "--dry-run"], "scratch_only_refused", "native", { TAP_SCRATCH_ONLY: prefix });
  symlinkSync(f.bus, join(f.work, "bus-alias"));
  expect(run(f, ["chosen", "--dry-run"], "native", { TAP_SCRATCH_ONLY: join(f.work, "bus-alias") }).status).toBe(0);
  symlinkSync(target, join(f.root, "alias"));
  const size = spawnSync("du", ["-sk", join(f.root, "alias")], { encoding: "utf8" }).stdout.match(/^\s*(\d+)/)![1];
  refusal(f, ["alias", "--yes"], "scratch_only_refused", "native", { TAP_SCRATCH_ONLY: prefix });
  const result = run(f, ["alias", "--yes"], "native", { TAP_SCRATCH_ONLY: target });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(`tap team purge: deleted archive 'alias' (0 file(s), ${size} KiB freed)\n`);
  expect(lstatSync(join(f.root, "alias"), { throwIfNoEntry: false })).toBeUndefined();
  expect(existsSync(join(target, "data"))).toBe(true);
  expect(run(f, ["chosen", "--yes"], "native", { TAP_SCRATCH_ONLY: "" }).status).toBe(0);
}, 30_000);

test("statistics failures cannot delete or claim success", () => {
  for (const [utility, body] of [["du", "exit 7"], ["du", "printf invalid"]]) {
    const f = fixture(), target = f.archive();
    writeFileSync(join(f.bin, utility!), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    refusal(f, ["chosen", "--yes"], "archive_unreadable");
    expect(existsSync(join(target, "data"))).toBe(true);
  }
}, 30_000);

test("counting preserves pathname lines and skips links/special nodes without a buffered find listing", () => {
  const f = fixture(), name = "chosen\nline", target = f.archive(name), sibling = f.archive("sibling");
  linkSync(join(target, "data"), join(target, "hard\nlink"));
  mkdirSync(join(target, "sub\nline"));
  writeFileSync(join(target, "sub\nline", "file\nx"), "more data");
  symlinkSync(sibling, join(target, "symlink"));
  expect(spawnSync("mkfifo", [join(target, "pipe")]).status).toBe(0);
  // Model the old >64 MiB listing failure without generating a huge fixture.
  writeFileSync(join(f.bin, "find"), '#!/bin/sh\nprintf called > "$TAP_HOME/find-called"\nprintf "ENOBUFS: listing exceeds 64 MiB" >&2\nexit 1\n', { mode: 0o755 });
  const result = run(f, [name, "--yes"]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("(9 file(s), ");
  expect(existsSync(join(f.bus, "find-called"))).toBe(false);
  expect(existsSync(target)).toBe(false);
  expect(existsSync(join(sibling, "data"))).toBe(true);
}, 30_000);

test("traversal failure refuses before deletion and closes already-open directories", () => {
  const f = fixture(), target = f.archive();
  const saved = { scratch: process.env.TAP_SCRATCH_ONLY, json: process.env.TAP_JSON };
  process.env.TAP_SCRATCH_ONLY = f.work; process.env.TAP_JSON = "1";
  const observe = spyOn(fs.Dir.prototype, "readSync").mockImplementation(() => { throw new Error("injected directory read failure"); });
  const close = spyOn(fs.Dir.prototype, "closeSync");
  const output = spyOn(process.stdout, "write").mockImplementation(() => true);
  let status: number, stdout: string;
  try {
    status = cmdTeamPurge(["chosen", "--yes"], f.root);
    stdout = output.mock.calls.map(call => String(call[0])).join("");
    expect(close).toHaveBeenCalled();
  } finally {
    observe.mockRestore(); close.mockRestore(); output.mockRestore();
    if (saved.scratch === undefined) delete process.env.TAP_SCRATCH_ONLY; else process.env.TAP_SCRATCH_ONLY = saved.scratch;
    if (saved.json === undefined) delete process.env.TAP_JSON; else process.env.TAP_JSON = saved.json;
  }
  expect(status!).toBe(1);
  expect(JSON.parse(stdout!)).toMatchObject({ ok: false, error_class: "archive_unreadable" });
  expect(stdout!).not.toContain("deleted archive");
  expect(existsSync(join(target, "data"))).toBe(true);
}, 30_000);

test("failed removal cannot claim success", () => {
  const f = fixture(), target = f.archive(); f.archive("sibling");
  const saved = { scratch: process.env.TAP_SCRATCH_ONLY, json: process.env.TAP_JSON };
  process.env.TAP_SCRATCH_ONLY = f.work; process.env.TAP_JSON = "1";
  const remove = spyOn(fs, "rmSync").mockImplementation(() => { throw new Error("injected removal failure"); });
  const output = spyOn(process.stdout, "write").mockImplementation(() => true);
  let status: number, stdout: string;
  try {
    status = cmdTeamPurge(["chosen", "--yes"], f.root);
    stdout = output.mock.calls.map(call => String(call[0])).join("");
    expect(remove).toHaveBeenCalledWith(target, { recursive: true, force: true });
  } finally {
    remove.mockRestore(); output.mockRestore();
    if (saved.scratch === undefined) delete process.env.TAP_SCRATCH_ONLY; else process.env.TAP_SCRATCH_ONLY = saved.scratch;
    if (saved.json === undefined) delete process.env.TAP_JSON; else process.env.TAP_JSON = saved.json;
  }
  expect(status!).toBe(1);
  expect(JSON.parse(stdout!)).toMatchObject({ ok: false, error_class: "purge_failed" });
  expect(stdout!).not.toContain("deleted archive");
  expect(existsSync(join(target, "data"))).toBe(true);
  expect(existsSync(join(f.root, "sibling", "data"))).toBe(true);
}, 30_000);

const ttyRunner = String.raw`import os, pty, select, signal, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[2], sys.argv[2:])
output = b""
sent = False
deadline = time.monotonic() + 12
try:
    while time.monotonic() < deadline:
        if not select.select([fd], [], [], 0.1)[0]:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        output += chunk
        if not sent and b"[y/N] " in output:
            os.write(fd, sys.argv[1].encode())
            sent = True
    else:
        os.kill(pid, signal.SIGKILL)
    _, status = os.waitpid(pid, 0)
finally:
    os.close(fd)
sys.stdout.buffer.write(output)
raise SystemExit(os.waitstatus_to_exitcode(status))
`;
// A typed or default "no" is the operator's answer and exits 0 (CLI-EXIT-0); EOF obtained no answer and stays a refusal.
test("TTY defaults no, reprompts invalid answers, and preserves EOF refusal", () => {
  for (const [answer, yes, reprompt] of [["yes\n", true, false], ["\n", false, false], ["No\n", false, false], ["\x04", false, false], ["maybe\nYes\n", true, true], [" y \nyEs\nn\n", false, true]] as const) {
    const f = fixture(), target = f.archive();
    const result = spawnSync("python3", ["-B", "-c", ttyRunner, answer, join(repo, "bin/tap"), "team", "purge", "chosen"], {
      cwd: f.work, env: f.env, encoding: "utf8", timeout: 15000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(answer === "\x04" ? 1 : 0);
    expect(result.stdout).toContain("[y/N]");
    expect(result.stdout.includes("choose y or n")).toBe(reprompt);
    expect(existsSync(target)).toBe(!yes);
    if (!yes) expect(result.stdout).toContain("archive left intact");
  }
}, 30_000);
