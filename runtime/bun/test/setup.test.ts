import { afterEach, expect, test } from "bun:test";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cmdSetup } from "../src/verbs/setup";
import { removeScratchTree } from "./support/scratch";

const repo = resolve(import.meta.dir, "../../.."), scratch: string[] = [];
const template = readFileSync(join(repo, "skills/tap/templates/repo-charter.md"));
const retired = '"$CLAUDE_PROJECT_DIR"/hooks/tap-advisory.sh';
afterEach(() => { for (const dir of scratch.splice(0)) removeScratchTree(dir); });

// Full setup runs tap init, which refuses an invalid team name and
// enrolls a non-git folder only on consent. Arms exercising setup's own offers
// therefore use a valid name inside a git repo; the spaced name stays for the
// repo-only arms, which never reach init.
function fixture(git = false, dir = "project with spaces") {
  const root = mkdtempSync(join(tmpdir(), "tap-setup.")); scratch.push(root);
  const cwd = join(root, dir), home = join(root, "home"), user = join(root, "user-claude");
  for (const dir of [cwd, home, user]) mkdirSync(dir);
  if (git && Bun.spawnSync(["git", "init", "-q", cwd]).exitCode !== 0) throw new Error("git init failed for setup fixture");
  const env = { ...process.env, HOME: home, TAP_HOME: undefined, TAP_INDEX_HOME: join(root, "index"), TAP_CLAUDE_HOME: user };
  return { root, cwd, home, user, env };
}
function run(f: ReturnType<typeof fixture>, args: string[], door = "native", cwd = f.cwd) {
  const command = door === "leaf" ? [process.execPath, join(repo, "runtime/bun/src/verbs/setup.ts"), "--"] : [join(repo, "bin/tap"), "setup"];
  const result = Bun.spawnSync([...command, ...args], { cwd, env: f.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

test("setup grammar refuses before writes on native and leaf doors", () => {
  const f = fixture();
  for (const door of ["native", "leaf"]) for (const [args, message] of [
    [["--check"], "--check requires --repo"], [["--wat"], "unknown option '--wat'"],
    [["--"], "unknown option '--'"], [["-x"], "unexpected arg '-x'"], [["word"], "unexpected arg 'word'"],
  ] as const) {
    expect(run(f, [...args], door)).toEqual({ code: 1, out: "", err: `tap setup: ${message}\n` });
    expect(readdirSync(f.cwd)).toEqual([]);
  }
});

test("--machine selects machine setup from any argument position", () => {
  const f = fixture();
  expect(run(f, ["--machine"])).toMatchObject({ code: 2, err: expect.stringContaining("interactive terminal") });
  expect(run(f, ["--machine", "--repo"])).toMatchObject({ code: 2, err: "Usage: tap setup --machine [--answers <file|->] [--dry-run] [--json] [--verbose]\n" });
  expect(run(f, ["--repo", "--machine"])).toMatchObject({ code: 2, err: "Usage: tap setup --machine [--answers <file|->] [--dry-run] [--json] [--verbose]\n" });
  expect(readdirSync(f.cwd)).toEqual([]);
});

test("repo-only setup uses git root, and repeats flags", () => {
  const f = fixture(), nested = join(f.cwd, "nested"); mkdirSync(nested);
  expect(Bun.spawnSync(["git", "init", "-q", f.cwd]).exitCode).toBe(0);
  const result = run(f, ["--repo", "--repo", "--yes", "-y"], "native", nested);
  expect(result.code).toBe(0);
  expect(readFileSync(join(f.cwd, "AGENTS.md"))).toEqual(template);
  expect(readdirSync(nested)).toEqual([]);
  expect(existsSync(join(f.cwd, ".tap"))).toBe(false);
  expect(existsSync(join(f.root, "index/global-registry.json"))).toBe(false);
});

test("append preserves raw bytes and separators; idempotent writes keep inode and output", () => {
  for (const prefix of [Buffer.alloc(0), Buffer.from([255, 10]), Buffer.from([255, 13])]) {
    const f = fixture(), path = join(f.cwd, "AGENTS.md"); writeFileSync(path, prefix);
    const first = run(f, ["--repo"]);
    expect(first).toEqual({ code: 0, out: "tap setup: wrote AGENTS.md TAP signpost\n", err: "" });
    expect(readFileSync(path)).toEqual(Buffer.concat([prefix, Buffer.from(!prefix.length ? "" : prefix.at(-1) === 10 ? "\n" : "\n\n"), template]));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const before = statSync(path);
    expect(run(f, ["--repo"])).toEqual(first);
    expect(statSync(path).ino).toBe(before.ino);
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
    expect(readdirSync(f.cwd)).toEqual(["AGENTS.md"]);
  }
});

test("canonical and v3 replacement retain non-UTF-8 outside bytes; ambiguous markers fail 1", () => {
  const v3 = Buffer.from(readFileSync(join(repo, "skills/tap/scripts/smoke/fixtures/repo-charter-v3.b64"), "utf8"), "base64");
  for (const card of [template, v3]) {
    const f = fixture(), path = join(f.cwd, "AGENTS.md");
    writeFileSync(path, Buffer.concat([Buffer.from([255, 13, 10]), card, Buffer.from([254, 10])]));
    expect(run(f, ["--repo"]).code).toBe(0);
    expect(readFileSync(path)).toEqual(Buffer.concat([Buffer.from([255, 13, 10]), template, Buffer.from([254, 10])]));
  }
  for (const text of ["<!-- TAP:BEGIN -->", "<!-- TAP:END -->", "<!-- TAP:END --><!-- TAP:BEGIN -->", template.toString().repeat(2)]) {
    const f = fixture(), path = join(f.cwd, "AGENTS.md"); writeFileSync(path, text);
    for (const args of [["--repo"], ["--repo", "--check"]]) {
      expect(run(f, args)).toMatchObject({ code: 1, err: expect.stringContaining("malformed or duplicate TAP markers") });
      expect(readFileSync(path, "utf8")).toBe(text);
    }
  }
});

test("check mode follows hard-linked targets and dangling links without write validation", () => {
  const f = fixture(), target = join(f.root, "instructions"), path = join(f.cwd, "AGENTS.md");
  writeFileSync(target, template); linkSync(target, target + ".alias"); symlinkSync(target, path);
  const before = lstatSync(path);
  expect(run(f, ["--repo", "--check"])).toEqual({ code: 0, out: "tap setup --repo --check: AGENTS.md signpost is current\n", err: "" });
  expect(run(f, ["--repo"])).toMatchObject({ code: 2, err: expect.stringContaining("hard link") });
  expect(lstatSync(path).ino).toBe(before.ino);
  expect(readFileSync(target)).toEqual(template);
  const g = fixture(); symlinkSync("missing", join(g.cwd, "AGENTS.md"));
  expect(run(g, ["--repo", "--check"])).toEqual({ code: 2, out: "", err: "tap setup --repo --check: AGENTS.md signpost drift\n" });
  expect(readdirSync(g.cwd)).toEqual(["AGENTS.md"]);
});

test("non-TTY setup skips both offers and --yes creates then preserves config", () => {
  const f = fixture(true, "project");
  const skipped = run(f, []);
  expect(skipped.code).toBe(0);
  expect(skipped.out).toContain("skipped AGENTS.md signpost");
  expect(skipped.out).not.toContain(".tap/config");
  expect(existsSync(join(f.cwd, "AGENTS.md"))).toBe(false);
  expect(existsSync(join(f.cwd, ".tap/config"))).toBe(false);
  const first = run(f, ["--yes"]);
  expect(first.code).toBe(0); expect(first.out).toContain("wrote .tap/config");
  const path = join(f.cwd, ".tap/config"); writeFileSync(path, "operator config\n");
  const next = run(f, ["-y"]);
  expect(next.code).toBe(0); expect(next.out).toContain("kept existing .tap/config");
  expect(readFileSync(path, "utf8")).toBe("operator config\n");
  expect(next.out).toEndWith('tap setup: ready\ntap setup: quickstart (or prefix with `bash scripts/tap.sh` if tap is not yet on PATH):\n  tap register\n  tap send <peer> -m "hello"             # a note: settle-only, held for the digest\n  tap send <peer> --ask -m "a question"  # an answer is wanted\n');
});

test("non-TTY setup outside git surfaces init's consent refusal", () => {
  const f = fixture(false, "project");
  const refused = run(f, []);
  expect(refused.code).not.toBe(0);
  expect(refused.err).toContain("is not a git repository");
  expect(refused.err).toContain("run tap init --yes in ");
  expect(refused.out).not.toContain("tap setup: ready");
  expect(readdirSync(f.cwd)).toEqual([]);
});

test("setup --yes outside git forwards consent, so init is born live", () => {
  const f = fixture(false, "project");
  const accepted = run(f, ["--yes"]);
  expect(accepted.code).toBe(0);
  expect(accepted.err).toContain("is not a git repository; initializing TAP here anyway (--yes)");
  expect(accepted.err).not.toContain("run tap init --yes");
  expect(accepted.out).toContain("tap setup: ready");
  expect(existsSync(join(f.root, "index/global-registry.json"))).toBe(true);
  expect(JSON.parse(readFileSync(join(f.cwd, ".tap/team-registry.json"), "utf8"))).toMatchObject({ schema: "0.20", seats: {} });
});

test("init child receives pending flag without leaking it and its failure stops setup", async () => {
  const f = fixture(), scripts = join(f.root, "scripts"); mkdirSync(scripts);
  writeFileSync(join(scripts, "init-stand-in.sh"), 'printf "%s:%s" "$1" "$TAP_SETUP_REPO_PENDING" > "$(dirname "$0")/receipt"\nexit 37\n');
  const cwd = process.cwd(), pending = process.env.TAP_SETUP_REPO_PENDING, standIn = process.env.TAP_VERB_SCRIPT;
  process.env.TAP_VERB_SCRIPT = join(scripts, "init-stand-in.sh");
  try {
    process.chdir(f.cwd);
    expect(await cmdSetup(["--yes"], scripts)).toBe(37);
    expect(readFileSync(join(scripts, "receipt"), "utf8")).toBe("init:1");
    expect(process.env.TAP_SETUP_REPO_PENDING).toBe(pending);
    expect(readdirSync(f.cwd)).toEqual([]);
  } finally {
    process.chdir(cwd);
    if (standIn === undefined) delete process.env.TAP_VERB_SCRIPT; else process.env.TAP_VERB_SCRIPT = standIn;
  }
});

test("user diagnostics remain read-only and malformed shapes abort before repo cleanup", () => {
  const f = fixture(true, "project"), path = join(f.user, "settings.json");
  const raw = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: "/user/tap-advisory.sh --mode" }] }], UserPromptSubmit: [{ hooks: [{ command: "TAP_HOOK_MODE=roster old" }] }] } });
  writeFileSync(path, raw);
  const result = run(f, ["--yes"]);
  expect(result.code).toBe(0); expect(result.out).toContain("user-level hook already wired"); expect(result.out).toContain("STALE prompt-time roster line still wired");
  expect(readFileSync(path, "utf8")).toBe(raw);
  writeFileSync(path, "{");
  const absent = run(f, ["--yes"]);
  expect(absent.code).toBe(0); expect(absent.out).toContain("user-level hook not wired"); expect(absent.out).toContain("prompt-time roster line correctly absent");
  mkdirSync(join(f.cwd, ".claude")); const local = join(f.cwd, ".claude/settings.json");
  const localRaw = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: retired }] }] } }); writeFileSync(local, localRaw);
  for (const malformed of ['{"hooks":{"SessionStart":[1]}}', '{"hooks":null}', '[]', Buffer.from([255])]) {
    writeFileSync(path, malformed);
    const failed = run(f, ["--yes"]);
    expect(failed.code).toBe(1); expect(failed.out).not.toContain("tap setup: ready");
    expect(readFileSync(local, "utf8")).toBe(localRaw);
  }
});

test("repo cleanup removes only the exact hook and preserves metadata and wide numbers", () => {
  const f = fixture(true, "project"); mkdirSync(join(f.cwd, ".claude")); const path = join(f.cwd, ".claude/settings.json");
  const command = JSON.stringify(retired), other = JSON.stringify(retired + " --keep");
  writeFileSync(path, `{"wide":9007199254740993,"float":1.0,"text":"é","hooks":{"SessionStart":[{"hooks":[{"command":${command}},{"command":${other}}]},{"matcher":"keep","hooks":[{"command":${command}}]},{"hooks":[{"command":${command}}]},7],"Other":[]}}`);
  const result = run(f, ["--yes"]);
  expect(result.code).toBe(0); expect(result.out).toContain("stripped retired repo-level TAP advisory");
  const expected = '{\n  "float": 1.0,\n  "hooks": {\n    "Other": [],\n    "SessionStart": [\n      {\n        "hooks": [\n          {\n            "command": "\\\"$CLAUDE_PROJECT_DIR\\\"/hooks/tap-advisory.sh --keep"\n          }\n        ]\n      },\n      {\n        "matcher": "keep"\n      },\n      7\n    ]\n  },\n  "text": "\\u00e9",\n  "wide": 9007199254740993\n}\n';
  expect(readFileSync(path, "utf8")).toBe(expected);
  const before = statSync(path).ino;
  expect(run(f, ["--yes"]).code).toBe(0); expect(statSync(path).ino).toBe(before);
  writeFileSync(path, `{"hooks":{"SessionStart":[{"hooks":[{"command":${command}}]}]}}`);
  expect(run(f, ["--yes"]).code).toBe(0); expect(readFileSync(path, "utf8")).toBe("{}\n");
  writeFileSync(path, "{ malformed");
  expect(run(f, ["--yes"])).toMatchObject({ code: 0, err: expect.stringContaining("untouched") });
  expect(readFileSync(path, "utf8")).toBe("{ malformed");
  writeFileSync(path, Buffer.from([255]));
  expect(run(f, ["--yes"]).code).toBe(1); expect(readFileSync(path)).toEqual(Buffer.from([255]));
});
