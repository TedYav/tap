import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readStdinByte } from "../stdin-byte";
import { basename, dirname, join } from "node:path";
import { isDict, metaBytes, parseJsonPreserving, pyReadUtf8, pyTruthy } from "../spool-publication";
import { initArgv } from "../courier-argv";
import { tapScriptsDir } from "../scripts-dir";

const fail = (message: string, code = 1): number => { console.error(message); return code; };
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const unreadable = (error: unknown) => error instanceof SyntaxError || /^E(?!RR_)/.test((error as NodeJS.ErrnoException).code || "");
const object = (value: unknown): Record<string, unknown> => {
  if (!isDict(value)) throw new TypeError("settings entry is not an object");
  return value;
};

/** sha256 of each earlier shipped signpost block, markers included: v3, then v4 (before tap-xe42x's nudge line). */
const SHIPPED_CHARTERS = new Set([
  "ecb6d98a18c29a086e8537ed2237033595f285d2699c8b8b896f1ffecd032d64",
  "b387ef87615614d5b594f053a93bcfa5c313b8f3ded6c3dedebcd014d064df7a",
]);

function charter(root: string, scripts: string, check: boolean): number {
  const path = join(root, "AGENTS.md"), section = readFileSync(join(scripts, "../templates/repo-charter.md"));
  let last = section.length;
  while (last && (section[last - 1] === 10 || section[last - 1] === 13)) last--;
  const canonical = section.subarray(0, last), lines = canonical.toString("utf8").split(/\r\n|\n|\r/);
  if (lines.length < 2) return fail("tap setup: repo charter template is malformed");
  const begin = Buffer.from(lines[0]!), end = Buffer.from(lines.at(-1)!);
  let target = path;
  if (!check) {
    const raw = lstatSync(path, { throwIfNoEntry: false });
    if (raw?.isSymbolicLink()) {
      try { target = realpathSync(path); }
      catch (error) {
        return fail(missing(error)
          ? `tap setup --repo: AGENTS.md is a symlink to ${readlinkSync(path)} which does not exist; next: create that file or replace the link, then rerun tap setup --repo`
          : "tap setup --repo: AGENTS.md is a symlink that could not be resolved; next: replace it with a regular file or a resolvable link, then rerun tap setup --repo", 2);
      }
      if (raw.nlink !== 1) return fail(`tap setup --repo: AGENTS.md symlink has ${raw.nlink} hard-linked names; refusing an ambiguous linked path; next: keep one AGENTS.md symlink or replace it with a regular file, then rerun tap setup --repo`, 2);
      const targetStat = statSync(target);
      if (!targetStat.isFile()) return fail(`tap setup --repo: ${target} is not a regular file; next: replace it with a regular file, then rerun tap setup --repo`, 2);
      if (targetStat.nlink !== 1) return fail(`tap setup --repo: ${target} is a hard link (${targetStat.nlink} names); a rewrite would split it; next: replace it with a regular file, then rerun tap setup --repo`, 2);
    } else if (raw) {
      if (!raw.isFile()) return fail("tap setup --repo: AGENTS.md is not a regular file; next: replace it with a regular file, then rerun tap setup --repo", 2);
      if (raw.nlink !== 1) return fail(`tap setup --repo: AGENTS.md is a hard link (${raw.nlink} names); a rewrite would split it; next: replace it with a regular file, then rerun tap setup --repo`, 2);
    }
  }
  let current: Buffer;
  try { current = readFileSync(target); } catch (error) { if (!missing(error)) throw error; current = Buffer.alloc(0); }
  const start = current.indexOf(begin), stop = current.indexOf(end);
  if ((start < 0) !== (stop < 0) || (start >= 0 && (stop < start + begin.length || current.indexOf(begin, start + begin.length) >= 0 || current.indexOf(end, stop + end.length) >= 0))) {
    return fail(`tap setup: ${path} has malformed or duplicate TAP markers; next: edit ${path} to keep exactly one ordered ${begin} / ${end} pair, or remove the incomplete markers, then rerun tap setup --repo`);
  }
  let rendered: Buffer;
  if (start >= 0) {
    const existing = current.subarray(start, stop + end.length);
    // Only byte-known shipped cards (v3, v4) may migrate; customized cards are user work.
    if (!existing.equals(canonical) && !SHIPPED_CHARTERS.has(createHash("sha256").update(existing).digest("hex"))) {
      return fail(`tap setup --repo: preserved customized TAP block in ${path}; update it manually or restore a canonical block, then rerun`, 2);
    }
    rendered = Buffer.concat([current.subarray(0, start), canonical, current.subarray(stop + end.length)]);
  } else rendered = Buffer.concat([current, Buffer.from(!current.length ? "" : current.at(-1) === 10 ? "\n" : "\n\n"), section]);
  if (check) {
    if (!current.equals(rendered)) return fail("tap setup --repo --check: AGENTS.md signpost drift", 2);
    console.log("tap setup --repo --check: AGENTS.md signpost is current");
    return 0;
  }
  if (!current.equals(rendered)) {
    const tmp = join(dirname(target), `.${basename(target)}.${randomUUID()}`), fd = openSync(tmp, "wx", 0o600);
    try {
      try { writeFileSync(fd, rendered); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, target);
    } catch (error) { unlinkSync(tmp); throw error; }
  }
  console.log(`tap setup: wrote AGENTS.md TAP signpost${target === path ? "" : ` through symlink to ${target}`}`);
  return 0;
}

function ask(prompt: string, yes: boolean): boolean {
  if (yes) return true;
  if (!process.stdin.isTTY) return false;
  process.stderr.write(`${prompt} [Y/n] `);
  const byte = Buffer.alloc(1), answer: number[] = [];
  while (readStdinByte(byte)) {
    if (byte[0] === 10) return ["", "y", "Y", "yes", "YES", "Yes"].includes(Buffer.from(answer).toString());
    // Bash read ignores NUL and leaves whitespace intact with IFS=.
    if (byte[0] !== 0) answer.push(byte[0]!);
  }
  return false;
}

function diagnostics(): void {
  const path = join(process.env.TAP_CLAUDE_HOME || join(process.env.HOME!, ".claude"), "settings.json");
  console.log("tap setup: Claude TAP advisory is user-level (ruling tap-pkoq). Run ./install.sh from the TAP primary checkout. This command will not write a repo-level hook.");
  let settings: unknown;
  try { settings = parseJsonPreserving(pyReadUtf8(path)); }
  catch (error) { if (!unreadable(error)) throw error; settings = {}; }
  const document = object(settings), hooks = object(Object.hasOwn(document, "hooks") ? document.hooks : {});
  const contains = (event: string, needle: string) => {
    let found = false;
    const entries = pyTruthy(hooks[event]) ? hooks[event] : [];
    for (const entry of entries as unknown[]) {
      const inner = object(entry).hooks;
      for (const hook of (pyTruthy(inner) ? inner : []) as unknown[]) {
        const value = object(hook).command, command = pyTruthy(value) ? value : "";
        if (typeof command === "string" || Array.isArray(command)) found ||= command.includes(needle);
        else if (isDict(command)) found ||= Object.hasOwn(command, needle);
        else throw new TypeError("hook command is not searchable");
      }
    }
    return found;
  };
  console.log(contains("SessionStart", "tap-advisory.sh") ? "tap setup: user-level hook already wired" : "tap setup: user-level hook not wired — ./install.sh from the TAP primary checkout");
  console.log(contains("UserPromptSubmit", "TAP_HOOK_MODE=roster") ? "tap setup: STALE prompt-time roster line still wired (removed tap-hx4r) — re-run ./install.sh to clean it up" : "tap setup: prompt-time roster line correctly absent (removed tap-hx4r)");
}

function stripRetiredHook(root: string): void {
  const path = join(root, ".claude/settings.json"), retired = '"$CLAUDE_PROJECT_DIR"/hooks/tap-advisory.sh';
  let settings: Record<string, unknown>;
  let parsed: unknown;
  try { parsed = parseJsonPreserving(pyReadUtf8(path)); }
  catch (error) {
    if (missing(error)) return;
    if (!unreadable(error)) throw error;
    console.error(`tap setup: left ${path} untouched (${error instanceof Error ? error.message : error})`);
    return;
  }
  settings = object(parsed);
  const hooks = settings.hooks;
  if (!isDict(hooks) || !Array.isArray(hooks.SessionStart)) return;
  let stripped = false;
  const kept: unknown[] = [];
  for (const entry of hooks.SessionStart) {
    if (!isDict(entry) || !Array.isArray(entry.hooks)) { kept.push(entry); continue; }
    const inner = entry.hooks.filter(hook => object(hook).command !== retired);
    if (inner.length !== entry.hooks.length) stripped = true;
    if (inner.length) kept.push({ ...entry, hooks: inner });
    else if (Object.keys(entry).some(key => key !== "hooks")) {
      const { hooks: _removed, ...rest } = entry;
      kept.push(rest);
    }
  }
  if (!stripped) return;
  if (kept.length) hooks.SessionStart = kept; else delete hooks.SessionStart;
  if (!Object.keys(hooks).length) delete settings.hooks;
  writeFileSync(path + ".tap-tmp", metaBytes(settings as Parameters<typeof metaBytes>[0]));
  renameSync(path + ".tap-tmp", path);
  console.log("tap setup: stripped retired repo-level TAP advisory (tap-pkoq)");
}

export async function cmdSetup(argv: string[], scripts: string): Promise<number> {
  let yes = false, repo = false, check = false, team = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--team") {
      team = argv[++i] ?? "";
      if (!team) return fail("tap setup: --team needs a value");
    }
    else if (arg === "--yes" || arg === "-y") yes = true;
    else if (arg === "--repo") repo = true;
    else if (arg === "--check") check = true;
    else return fail(`tap setup: ${arg.startsWith("--") ? "unknown option" : "unexpected arg"} '${arg}'`);
  }
  if (check && !repo) return fail("tap setup: --check requires --repo");
  if (team && repo) return fail("tap setup: --team names the team init creates; run it without --repo");
  try {
    let root = process.cwd();
    try {
      const git = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "ignore" });
      if (git.exitCode === 0) root = git.stdout.toString().replace(/\n+$/, "");
    } catch { /* A failed git lookup falls back to cwd. */ }
    if (repo) return charter(root, scripts, check);
    // Consent given to setup is consent to its init: a user who passed --yes
    // is never told to run tap init --yes (the non-git consent case).
    const child = Bun.spawn(initArgv(scripts, [...(yes ? ["--yes"] : []), ...(team ? ["--team", team] : [])]), { env: { ...process.env, TAP_SETUP_REPO_PENDING: "1" }, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    const interrupt = () => child.kill("SIGINT"), terminate = () => child.kill("SIGTERM"), hangup = () => child.kill("SIGHUP");
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate); process.on("SIGHUP", hangup);
    let status: number;
    try { status = await child.exited; }
    finally { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); process.off("SIGHUP", hangup); }
    if (status !== 0) return status;
    if (ask("Install TAP AGENTS.md signpost?", yes)) { const status = charter(root, scripts, false); if (status) return status; }
    else console.log("tap setup: skipped AGENTS.md signpost; run tap setup --repo when ready.");
    if (ask("Write .tap/config template?", yes)) {
      mkdirSync(join(root, ".tap"), { recursive: true });
      const path = join(root, ".tap/config");
      if (statSync(path, { throwIfNoEntry: false })?.isFile()) console.log("tap setup: kept existing .tap/config");
      else {
        writeFileSync(path, "# TAP repo-local config.\n# No options are active in v0.3; this file is reserved for future team defaults.\n");
        console.log("tap setup: wrote .tap/config");
      }
    }
    diagnostics();
    stripRetiredHook(root);
    console.log('tap setup: ready\ntap setup: quickstart (or prefix with `bash scripts/tap.sh` if tap is not yet on PATH):\n  tap register\n  tap send <peer> -m "hello"             # a note: settle-only, held for the digest\n  tap send <peer> --ask -m "a question"  # an answer is wanted');
    return 0;
  } catch (error) { return fail(`tap setup: ${error instanceof Error ? error.message : error}`); }
}

if (import.meta.main) process.exitCode = await cmdSetup(process.argv.slice(2), tapScriptsDir());
