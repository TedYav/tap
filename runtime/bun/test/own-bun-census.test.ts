// Every start of TAP's own code under Bun carries TAP's own configuration and
// no env file (src/own-bun.ts). Bun's defaults are "$PWD/bunfig.toml", whose
// preload scripts run before the entry file, and "$PWD/.env"; a child inherits
// the directory the user or an agent is working in, and the flags are not
// inherited from the parent. Two checks: the flags work, and no source line
// names a Bun binary without going through the helper.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { ownBun, ownBunArgv, ownBunFlags } from "../src/own-bun";

const root = resolve(import.meta.dir, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "own-bun-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("a child started through the helper ignores the working directory's bunfig.toml preload and .env", () => {
  const project = join(scratch, "project"), tool = join(scratch, "tool"), mark = join(scratch, "preload-ran");
  mkdirSync(project); mkdirSync(tool);
  writeFileSync(join(tool, "entry.ts"), 'process.stdout.write("probe=" + (process.env.TAP_AUTOLOAD_PROBE ?? "unset"));\n');
  writeFileSync(join(project, "preload.ts"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(mark)}, "x");\n`);
  // The relative path is assembled: the publish closure scan reads a literal one as a file this test needs.
  writeFileSync(join(project, "bunfig.toml"), `preload = ["./${"preload.ts"}"]\n`);
  writeFileSync(join(project, ".env"), "TAP_AUTOLOAD_PROBE=from-project-dotenv\n");
  const env = { ...process.env };
  delete env.TAP_AUTOLOAD_PROBE;
  const run = (argv: string[]) => spawnSync(argv[0]!, [...argv.slice(1), join(tool, "entry.ts")], { cwd: project, env, encoding: "utf8", timeout: 20000 });

  // Control: a bare Bun in that directory does run the preload and take the
  // variable. Without it the absence below could never fail.
  const bare = run([process.execPath]);
  expect(bare.status, bare.stderr).toBe(0);
  expect(bare.stdout).toBe("probe=from-project-dotenv");
  expect(existsSync(mark)).toBe(true);
  rmSync(mark);

  const guarded = run(ownBunArgv(process.execPath));
  expect(guarded.status, guarded.stderr).toBe(0);
  expect(guarded.stdout).toBe("probe=unset");
  expect(existsSync(mark)).toBe(false);
});

test("the flags name the shipped config by absolute path, and an artifact's shim adds its own", () => {
  const config = join(root, "runtime/bun/tap-bunfig.toml");
  expect(existsSync(config)).toBe(true);
  expect(ownBunFlags("bun")).toEqual([`--config=${config}`, "--no-env-file"]);
  expect(ownBunArgv("/opt/bun/bin/bun")).toEqual(["/opt/bun/bin/bun", `--config=${config}`, "--no-env-file"]);
  expect(ownBunFlags("/opt/tap/libexec/tap/bun")).toEqual([]);
  expect(ownBunArgv()).toEqual([ownBun(), ...ownBunFlags(ownBun())]);
  const shipped = readFileSync(config, "utf8").split("\n").filter(line => line.trim() && !line.startsWith("#"));
  expect(shipped).toEqual(["env = false"]);
});

// A line that names a Bun binary. Each such line either goes through the helper
// or is listed below with the reason it does not start Bun there.
const NAMES_BUN = /artifactBun\(|bunBinary\(\)|process\.execPath|process\.argv0|process\.argv\[0\]|Bun\.which\("bun"|childBun\(|worker_bun|(?<![\w.])"bun"\s*[,\]]/;
const THROUGH_HELPER = /ownBun(?:Argv|Flags)?\(/;
const EXEMPT: Record<string, Record<string, string>> = {
  "runtime/bun/src/own-bun.ts": {
    "*": "the helper itself",
  },
  "runtime/bun/src/scripts-dir.ts": {
    "return existsSync(source) ? source : resolve(dirname(process.execPath)": "locates the shipped scripts beside a compiled binary; starts nothing",
    "export function artifactBun(": "the artifact shim's resolver",
    "const shim = artifactBun(root);": "locates the compiled router beside the shim; starts nothing",
  },
  "runtime/bun/src/courier-argv.ts": {
    "return artifactBun(tapRoot(scriptsDir)) ?? \"bun\";": "childBun: resolves the binary; its three callers wrap it in ownBunArgv",
    "export function bunBinary(): string {": "resolves the binary; every caller is in this census",
    "return artifactBun() ?? (import.meta.path.startsWith(\"/$bunfs/\")": "bunBinary's body",
    "function childBun(scriptsDir: string): string {": "childBun's signature",
  },
  "runtime/bun/src/watch-run.ts": {
    "return [process.execPath, [argv[0]!, `--config=${config}`, \"--no-env-file\"": "the sidecar entry's own copy of the rule: it imports only Node built-ins before it stamps its sources",
  },
  "runtime/bun/src/spool-waiter.ts": {
    "const [bun, argv] = reexecImage(import.meta.dir, [process.argv[0]!": "this process's own argv, handed to reexecImage, which names the flags again",
  },
  "runtime/bun/src/startup-trace.ts": {
    "const bun = artifactBun() ?? (scriptsDir ? env.TAP_SMOKE_BUN": "resolved here; the next line returns it with ownBunFlags",
  },
  "runtime/bun/src/self-compact.ts": {
    "const bun = artifactBun() ?? Bun.which(\"bun\");": "resolved here; spawnDetachedWorker starts it through ownBunArgv",
  },
  "runtime/bun/src/self-rebrief.ts": {
    "const bun = artifactBun() ?? Bun.which(\"bun\");": "resolved here; the worker spawn below goes through ownBunArgv",
  },
  "runtime/bun/src/spool-engine.ts": {
    "const bun = artifactBun() ?? Bun.which(\"bun\");": "resolved here; the next statement returns it through ownBunArgv",
  },
  "runtime/bun/src/verbs/watch.ts": {
    "const bun = artifactBun() ?? Bun.which(\"bun\");": "resolved here; execve below goes through ownBunArgv",
  },
  "runtime/bun/src/verbs/goalie.ts": {
    "const bun = bunBinary();": "resolved here; execve on the next line goes through ownBunArgv",
  },
  "runtime/bun/src/launcher/transaction.ts": {
    "script_dir?: string; worker_bun?: string;": "the request field's type",
    "request.worker_bun = artifactBun() ??": "resolved here; the failure callback starts it through ownBunArgv",
    "if (!request.dry_run && (!request.worker_bun ||": "presence check; starts nothing",
  },
  "runtime/bun/src/launcher/resume-all.ts": {
    "return `tmux error: ${process.execPath} ...`;": "an error message",
  },
  "runtime/bun/src/release/build.ts": {
    "run(bunBinary(), [\"build\", \"--compile\"": "`bun build`, not a start of TAP's code; it runs in a scratch directory and passes the no-autoload compile flags",
  },
  "hooks/tap-opencode-session-start.ts": {
    "test(basename(process.execPath))": "recognizes the OpenCode host process; starts nothing",
    "const NATIVE_ENTRY = join(\"runtime\", \"bun\", \"src\"": "a path segment, not a program",
    "return [\"bun\", `--config=": "the plugin's own copy of the rule (it is copied out of the checkout and cannot import the helper)",
  },
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

test("census: no source line names a Bun binary without the helper or a stated reason", () => {
  const files = [...sources(join(root, "runtime/bun/src")), join(root, "runtime/bun/main.ts"),
    ...readdirSync(join(root, "hooks")).filter(name => name.endsWith(".ts")).map(name => join(root, "hooks", name))];
  const unexplained: string[] = [], usedExemptions = new Set<string>();
  for (const file of files) {
    const rel = relative(root, file), exempt = EXEMPT[rel] ?? {};
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      const code = line.trim();
      if (!NAMES_BUN.test(code) || code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
      if (rel !== "runtime/bun/src/own-bun.ts" && THROUGH_HELPER.test(code)) return;
      const reason = Object.keys(exempt).find(key => key === "*" || code.includes(key));
      if (reason) { usedExemptions.add(`${rel}\t${reason}`); return; }
      unexplained.push(`${rel}:${index + 1}: ${code.slice(0, 160)}`);
    });
  }
  expect(unexplained).toEqual([]);
  // An exemption that matches nothing is stale: the line it excused moved or changed.
  const stale = Object.entries(EXEMPT).flatMap(([rel, keys]) => Object.keys(keys).map(key => `${rel}\t${key}`)).filter(key => !usedExemptions.has(key));
  expect(stale).toEqual([]);
});
