import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, lstatSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { cmdInit, initRoot } from "../src/verbs/init";
const repo = resolve(import.meta.dir, "../../..");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(content?: string) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "init-receipt-"))); roots.push(base);
  const root = join(base, "project"), home = join(base, "home"), index = join(base, "index");
  for (const path of [root, home, index]) mkdirSync(path);
  const env: NodeJS.ProcessEnv & Record<"HOME" | "TAP_INDEX_HOME" | "CODEX_HOME" | "CLAUDE_CONFIG_DIR" | "CURSOR_DATA_DIR", string> = { ...process.env, HOME: home, TAP_INDEX_HOME: index, CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"), CURSOR_DATA_DIR: join(home, ".cursor") };
  expect(Bun.spawnSync(["git", "init", "-q", root], { env }).exitCode).toBe(0);
  if (content !== undefined) {
    writeFileSync(join(root, "AGENTS.md"), content);
    expect(Bun.spawnSync(["git", "-C", root, "add", "AGENTS.md"], { env }).exitCode).toBe(0);
  }
  const run = (...args: string[]) => Bun.spawnSync([join(repo, "bin/tap"), "init", "--no-trust-folders", ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
  const runWithTrust = (...args: string[]) => Bun.spawnSync([join(repo, "bin/tap"), "init", ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
  return { base, root, home, index, env, run, runWithTrust };
}
function snapshot(base: string): Map<string, string> {
  const result = new Map<string, string>();
  function visit(path: string) {
    for (const name of readdirSync(path).sort()) {
      if (name === ".git") continue;
      const entry = join(path, name), stat = lstatSync(entry);
      result.set(entry, stat.isDirectory() ? "directory" : readFileSync(entry).toString("base64"));
      if (stat.isDirectory()) visit(entry);
    }
  }
  visit(base); return result;
}
function changes(before: Map<string, string>, after: Map<string, string>) {
  return [...after].flatMap(([path, bytes]) => before.get(path) === bytes ? [] : [{ path, action: before.has(path) ? "modified" : "created" }]).sort((a, b) => a.path.localeCompare(b.path));
}
test("JSON init receipts enumerate exact persistent writes, including the tracked instruction append and HOME/index files", () => {
  const f = fixture("Existing project rules.\n"), before = snapshot(f.base);
  const result = f.run("--json");
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const doc = JSON.parse(result.stdout.toString());
  expect(doc.changes).toEqual(changes(before, snapshot(f.base)));
  expect(doc.changes).toContainEqual({ path: join(f.root, "AGENTS.md"), action: "modified" });
  expect(doc.undo).toContainEqual(expect.stringContaining("<!-- tap:begin -->"));
  const again = f.run("--json");
  expect(JSON.parse(again.stdout.toString()).changes).toEqual([]);
});
test("public dry-run previews the same exact targets and writes nothing", () => {
  const f = fixture("Existing project rules.\n"), before = snapshot(f.base);
  const preview = f.run("--dry-run", "--json");
  expect(preview.exitCode, preview.stderr.toString()).toBe(0);
  expect(snapshot(f.base)).toEqual(before);
  const planned = JSON.parse(preview.stdout.toString());
  expect(planned.dry_run).toBe(true);
  const applied = f.run("--json");
  expect(JSON.parse(applied.stdout.toString()).changes).toEqual(planned.changes);
});

function terminalInit(f: ReturnType<typeof fixture>, args: string[], answer: string) {
  const result = Bun.spawnSync([Bun.which("python3")!, "-c", String.raw`
import json, os, pty, select, subprocess, sys, time
master,slave=pty.openpty()
p=subprocess.Popen([sys.argv[1],'init','--no-trust-folders']+json.loads(sys.argv[2]),cwd=sys.argv[3],stdin=slave,stdout=slave,stderr=slave)
os.close(slave)
output=b''; answered=False; end=time.monotonic()+15
try:
    while time.monotonic()<end:
        if select.select([master],[],[],.05)[0]:
            try: chunk=os.read(master,65536)
            except OSError: break
            if not chunk: break
            output+=chunk
        elif p.poll() is not None: break
        if not answered and b'TAP signpost? [Y/n]' in output:
            os.write(master,sys.argv[4].encode()+b'\n'); answered=True
    if p.poll() is None: p.kill()
    code=p.wait(timeout=5)
    print(json.dumps({'code':code,'output':output.decode(errors='replace')}))
finally:
    if p.poll() is None: p.kill(); p.wait()
    os.close(master)
`, join(repo, "bin/tap"), JSON.stringify(args), f.root, answer], { env: f.env, stdout: "pipe", stderr: "pipe", timeout: 25000 });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return JSON.parse(result.stdout.toString()) as { code: number; output: string };
}
const states = ["absent", "untracked", "tracked-block", "tracked-without"] as const;
const modes = ["tty-yes", "tty-no", "no-tty", "--yes", "--dry-run", "--json"] as const;
for (const state of states) for (const mode of modes) {
  test(`init exact writes: ${state}, ${mode}`, () => {
    const block = "Existing rules.\n\n<!-- tap:begin -->\nExisting TAP block.\n<!-- tap:end -->\n";
    const f = fixture(state === "absent" ? undefined : state === "tracked-block" ? block : "Existing rules.\n");
    if (state === "untracked") expect(Bun.spawnSync(["git", "-C", f.root, "rm", "--cached", "AGENTS.md"], { env: f.env }).exitCode).toBe(0);
    const before = snapshot(f.base);
    let output: string;
    if (mode.startsWith("tty") || mode === "--yes") {
      const result = terminalInit(f, mode === "--yes" ? ["--yes"] : [], mode === "tty-no" ? "n" : "y");
      expect(result.code, result.output).toBe(0); output = result.output.replaceAll("\r", "");
      if (state !== "tracked-block" && mode !== "--yes") expect(output).toContain("TAP signpost? [Y/n]");
      else expect(output).not.toContain("TAP signpost? [Y/n]");
    } else {
      const result = f.run(...(mode === "no-tty" ? [] : [mode]));
      expect(result.exitCode, result.stderr.toString()).toBe(0); output = result.stdout.toString();
    }
    const reported = mode === "--json" ? JSON.parse(output).changes : [...output.matchAll(/^  (created|modified) (.+)$/gm)].map(match => ({ action: match[1]!, path: match[2]! })).sort((a, b) => a.path.localeCompare(b.path));
    if (mode === "--dry-run") {
      expect(snapshot(f.base)).toEqual(before);
      const applied = f.run("--json");
      expect(JSON.parse(applied.stdout.toString()).changes).toEqual(reported);
    } else {
      expect(reported).toEqual(changes(before, snapshot(f.base)));
      const path = join(f.root, "AGENTS.md");
      const shouldWrite = state !== "tracked-block" && mode !== "tty-no";
      expect(reported.some((change: { path: string }) => change.path === path)).toBe(shouldWrite);
      if (!shouldWrite) expect(snapshot(f.base).get(path)).toBe(before.get(path));
      if (shouldWrite) {
        const text = readFileSync(path, "utf8");
        expect(text.match(/<!-- tap:begin -->/gi)).toHaveLength(1);
        expect(text.match(/<!-- tap:end -->/gi)).toHaveLength(1);
        const again = f.run("--json");
        expect(JSON.parse(again.stdout.toString()).changes).toEqual([]);
        expect(readFileSync(path, "utf8")).toBe(text);
      }
    }
  }, 30000);
}
test("--no-instructions skips absent and existing instruction files in preview and apply", () => {
  for (const content of [undefined, "Keep these rules.\n"]) {
    const f = fixture(content), before = snapshot(f.base);
    const preview = f.run("--dry-run", "--json", "--no-instructions");
    expect(preview.exitCode, preview.stderr.toString()).toBe(0);
    const planned = JSON.parse(preview.stdout.toString()).changes;
    expect(planned.some((change: { path: string }) => change.path.endsWith("/AGENTS.md"))).toBe(false);
    expect(snapshot(f.base)).toEqual(before);
    const applied = f.run("--json", "--yes", "--no-instructions");
    expect(applied.exitCode, applied.stderr.toString()).toBe(0);
    expect(JSON.parse(applied.stdout.toString()).changes).toEqual(planned);
    expect(snapshot(f.base).get(join(f.root, "AGENTS.md"))).toBe(before.get(join(f.root, "AGENTS.md")));
  }
});

function harnesses(f: ReturnType<typeof fixture>) {
  const bin = join(f.base, "harnesses"); mkdirSync(bin);
  for (const command of ["codex", "claude", "agy", "cursor-agent"]) writeFileSync(join(bin, command), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  f.env.PATH = `${bin}:${f.env.PATH}`;
}

test("trust preview and apply name exact per-harness grants and persistent HOME writes", () => {
  const f = fixture(); harnesses(f);
  const before = snapshot(f.base);
  const preview = f.runWithTrust("--dry-run", "--yes", "--json");
  expect(preview.exitCode, preview.stderr.toString()).toBe(0);
  expect(snapshot(f.base)).toEqual(before);
  const planned = JSON.parse(preview.stdout.toString());
  expect(planned.folder_trust).toHaveLength(4);
  expect(planned.folder_trust.every((result: { status: string }) => result.status === "would_trust")).toBe(true);
  const applied = f.runWithTrust("--yes", "--json");
  expect(applied.exitCode, applied.stderr.toString()).toBe(0);
  const doc = JSON.parse(applied.stdout.toString());
  expect(doc.changes).toEqual(planned.changes);
  expect(doc.changes).toEqual(changes(before, snapshot(f.base)));
  const grants = new Map(doc.folder_trust_grants.map((grant: { harness: string; setting: string }) => [grant.harness, grant.setting]));
  expect(grants.get("Codex")).toBe(`projects[${JSON.stringify(f.root)}].trust_level = "trusted"`);
  expect(grants.get("Claude")).toBe(`projects[${JSON.stringify(f.root)}].hasTrustDialogAccepted = true`);
  expect(grants.get("Antigravity")).toBe(`trustedWorkspaces includes ${JSON.stringify(f.root)}`);
  expect(grants.get("Cursor")).toContain('trustMethod = "cli-flag"');
  const again = f.runWithTrust("--yes", "--json");
  expect(JSON.parse(again.stdout.toString()).changes).toEqual([]);
});

test("partial trust failure reports exact completed writes and preserves invalid config", () => {
  const f = fixture(); harnesses(f);
  mkdirSync(f.env.CODEX_HOME); writeFileSync(join(f.env.CODEX_HOME, "config.toml"), "[broken");
  const before = snapshot(f.base);
  const preview = f.runWithTrust("--dry-run", "--yes", "--json");
  expect(preview.exitCode).toBe(1);
  expect(snapshot(f.base)).toEqual(before);
  const applied = f.runWithTrust("--yes", "--json");
  expect(applied.exitCode).toBe(1);
  const doc = JSON.parse(applied.stdout.toString());
  expect(doc).toMatchObject({ ok: false, initialized: true, error_class: "folder_trust_failed" });
  expect(doc.changes).toEqual(JSON.parse(preview.stdout.toString()).changes);
  expect(doc.changes).toEqual(changes(before, snapshot(f.base)));
  expect(doc.folder_trust_grants.some((grant: { harness: string }) => grant.harness === "Codex")).toBe(false);
  expect(readFileSync(join(f.env.CODEX_HOME, "config.toml"), "utf8")).toBe("[broken");
});

test("partial instructions and symlink targets stay untouched with truthful preview", () => {
  for (const linked of [false, true]) {
    const f = fixture("<!-- TAP:BEGIN -->\nIncomplete user work.\n");
    if (linked) {
      const outside = join(f.base, "instructions"); writeFileSync(outside, "Keep this.\n");
      unlinkSync(join(f.root, "AGENTS.md")); symlinkSync(outside, join(f.root, "AGENTS.md"));
    }
    const before = snapshot(f.base), preview = f.run("--dry-run", "--json");
    expect(preview.exitCode, preview.stderr.toString()).toBe(0);
    expect(snapshot(f.base)).toEqual(before);
    const applied = f.run("--json");
    expect(applied.exitCode, applied.stderr.toString()).toBe(0);
    expect(JSON.parse(applied.stdout.toString()).changes).toEqual(JSON.parse(preview.stdout.toString()).changes);
    expect(snapshot(f.base).get(join(f.root, "AGENTS.md"))).toBe(before.get(join(f.root, "AGENTS.md")));
  }
});

test("lost enrolled registry previews only its recreation and keeps completed blocks intact", () => {
  const f = fixture(); expect(f.run("--json").exitCode).toBe(0);
  const path = join(f.root, ".tap/team-registry.json"); unlinkSync(path);
  const before = snapshot(f.base), preview = f.run("--dry-run", "--json");
  expect(preview.exitCode, preview.stderr.toString()).toBe(0);
  expect(snapshot(f.base)).toEqual(before);
  expect(JSON.parse(preview.stdout.toString())).toMatchObject({ already_initialized: false, changes: [{ path, action: "created" }] });
  const applied = f.run("--json");
  expect(applied.exitCode, applied.stderr.toString()).toBe(0);
  expect(JSON.parse(applied.stdout.toString()).changes).toEqual(changes(before, snapshot(f.base)));
  expect(JSON.parse(applied.stdout.toString()).changes).toEqual(JSON.parse(preview.stdout.toString()).changes);
});

test("terminal dry-run and terminal JSON never ask or consume an instruction answer", () => {
  for (const args of [["--dry-run", "--json"], ["--json"]]) {
    const f = fixture("Keep this.\n"), before = snapshot(f.base);
    const result = terminalInit(f, args, "");
    expect(result.code, result.output).toBe(0);
    expect(result.output).not.toContain("TAP signpost? [Y/n]");
    if (args.includes("--dry-run")) expect(snapshot(f.base)).toEqual(before);
    else expect(readFileSync(join(f.root, "AGENTS.md"), "utf8")).toContain("<!-- TAP:BEGIN -->");
  }
});

test("init owns its writes even when diagnostic recording and always-on are configured", () => {
  const f = fixture();
  const xdg = join(f.base, "config"), debug = join(f.index, "debug"), directory = join(debug, "capture");
  mkdirSync(join(xdg, "tap"), { recursive: true }); mkdirSync(directory, { recursive: true });
  f.env.XDG_CONFIG_HOME = xdg;
  writeFileSync(join(xdg, "tap/config.toml"), '[debug]\nalways_on = true\ncapture = ["tap-events"]\n');
  const run = { id: "capture", directory, socket: join(f.base, "no-server.sock"), config: { max_mb: 1024, retain_mb: 2048 }, redaction: "credentials-v1" };
  writeFileSync(join(debug, "enabled.json"), JSON.stringify(run));
  writeFileSync(join(directory, "status.json"), JSON.stringify({ recording: true, pid: process.pid, heartbeat: Date.now() / 1000, mode: "basic" }));
  writeFileSync(join(directory, "events.jsonl"), "");
  const before = snapshot(f.base), preview = f.run("--dry-run", "--json");
  expect(preview.exitCode, preview.stderr.toString()).toBe(0);
  expect(snapshot(f.base)).toEqual(before);
  const applied = f.run("--json");
  expect(applied.exitCode, applied.stderr.toString()).toBe(0);
  expect(JSON.parse(applied.stdout.toString()).changes).toEqual(changes(before, snapshot(f.base)));
  expect(readFileSync(join(directory, "events.jsonl"), "utf8")).toBe("");
});


test("unexpected bootstrap errors are init failures and report observed enrollment, never a trust failure", () => {
  for (const afterEnrollment of [false, true]) {
    const f = fixture(), before = snapshot(f.base), cwd = process.cwd(), env = process.env;
    const log = console.log, output: string[] = [];
    try {
      process.chdir(f.root); process.env = { ...f.env };
      console.log = (...values: unknown[]) => { output.push(values.join(" ")); };
      const code = cmdInit(["--json", "--no-trust-folders"], (where, opts) => {
        if (opts.dryRun) return initRoot(where, opts);
        if (afterEnrollment) initRoot(where, opts);
        throw new Error("unexpected bootstrap exception");
      });
      expect(code).toBe(1);
    } finally { process.chdir(cwd); process.env = env; console.log = log; }
    expect(output).toHaveLength(1);
    const doc = JSON.parse(output[0]!);
    expect(doc).toMatchObject({ ok: false, error_class: "init_failed", initialized: afterEnrollment, action: "tap doctor" });
    expect(doc.changes).toEqual(changes(before, snapshot(f.base)));
    expect(doc).not.toHaveProperty("folder_trust");
  }
});

test("recovery preview includes index normalization and missing enrollment defaults", () => {
  for (const compact of [true, false]) {
    const f = fixture(); expect(f.run("--json").exitCode).toBe(0);
    unlinkSync(join(f.root, ".tap/team-registry.json"));
    const path = join(f.index, "global-registry.json"), index = JSON.parse(readFileSync(path, "utf8"));
    if (!compact) { delete index.teams.project.state; delete index.teams.project.enrolled_at; }
    writeFileSync(path, JSON.stringify(index, null, compact ? undefined : 2) + "\n");
    const before = snapshot(f.base), preview = f.run("--dry-run", "--json");
    expect(preview.exitCode, preview.stderr.toString()).toBe(0);
    expect(snapshot(f.base)).toEqual(before);
    const planned = JSON.parse(preview.stdout.toString()).changes;
    expect(planned).toContainEqual({ path, action: "modified" });
    const applied = f.run("--json");
    expect(applied.exitCode, applied.stderr.toString()).toBe(0);
    expect(JSON.parse(applied.stdout.toString()).changes).toEqual(planned);
    expect(planned).toEqual(changes(before, snapshot(f.base)));
  }
});
