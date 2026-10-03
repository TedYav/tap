import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { removeScratchTree } from "./support/scratch";

// Ported from skills/tap/scripts/smoke/roster-hook-removed.test.sh lines
// 85-212 (tap-hx4r): Claude's retired per-turn roster hook must be REMOVED
// from settings an earlier installer wrote — additively registered, so
// stopping new installs would leave existing machines spammed forever —
// while sparing every other tool's entries and the SessionStart wiring that
// works, byte-identically to the python reference writer, idempotently, and
// without ever failing an install over an unwritable target or a malformed
// file. The trimmed shell keeps the public doors: install.sh's no-rewire
// text checks, the Codex block-builder arm, and the emitter grep.
//
// The de-wire runs as the same subprocess install.sh spawns so exit codes,
// stdout reports, stderr "could NOT remove" reports, umask filtering and
// --preload fault injection are observable exactly as production sees them.
// Mutants run against a scratch copy of the source tree, each reding the
// named arm.
//
// Scratch allocation: the fixture tree lives only beneath the runner-owned
// scratch root (runtime/bun/test/run.sh exports TMUX_TMPDIR); this file
// refuses to run without it.

const RUNNER_ROOT = process.env.TMUX_TMPDIR;
if (!RUNNER_ROOT) {
  throw new Error(
    "roster-hook-cleanup.test.ts: TMUX_TMPDIR is unset — this fixture allocates only beneath the supported runner's scratch root (runtime/bun/test/run.sh exports it); refusing to write outside it",
  );
}
const WORK = mkdtempSync(join(RUNNER_ROOT, "tap-rosterhook."));
afterAll(() => removeScratchTree(WORK));

const DEWIRE = resolve(import.meta.dir, "../src/install-roster-hook-cleanup.ts");
const MUTATED_TREE = join(WORK, "mut-src");

type Out = { status: number | null; stdout: string; stderr: string };

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const pins: Record<string, string> = {};
  for (const key of ["TMUX_TMPDIR", "TMPDIR", "TAP_NOTIFY_USER_BIN", "EPISODIC_MEMORY_SUMMARIZER_GUARD", "TAP_SESSION_MANIFEST", "OPENCODE_DB_PATH", "TAP_VERSION_SEEN_PATH"]) {
    const value = process.env[key];
    if (value !== undefined) pins[key] = value;
  }
  return { ...pins, PATH: `${process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin"}`, HOME: WORK, ...extra };
}

function runDewire(mutantDir: string | null, args: string[], extra: Record<string, string> = {}): Out {
  const helper = mutantDir ? join(mutantDir, "install-roster-hook-cleanup.ts") : DEWIRE;
  const r = spawnSync(process.execPath, [helper, ...args], { encoding: "utf8", env: childEnv(extra) });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runBash(script: string, args: string[]): Out {
  const r = spawnSync("bash", ["-c", script, "caller", ...args], { encoding: "utf8", env: childEnv() });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** The python reference writer: what the shell's cmp held the de-wire to. */
function pythonExpected(settings: string, expected: string): void {
  const script = `import json, sys
data = json.load(open(sys.argv[1]))
data['hooks']['UserPromptSubmit'].pop(1)
with open(sys.argv[2], 'w') as out:
    json.dump(data, out, indent=2)
    out.write('\\n')
`;
  const r = spawnSync("python3", ["-B", "-", settings, expected], { encoding: "utf8", input: script });
  expect(r.status, r.stderr).toBe(0);
}

function expectBytes(a: string, b: string, what: string): void {
  expect(readFileSync(a), what).toEqual(readFileSync(b));
}

/** The state checker, ported from the shell's python. Python's json.load
 *  accepts the Infinity/NaN dialect it just wrote; JSON.parse does not. */
function checkState(path: string): string | null {
  const text = readFileSync(path, "utf8").replace(/\b(-?)Infinity\b/g, "null").replace(/\bNaN\b/g, "null");
  const data = JSON.parse(text) as {
    hooks?: Record<string, unknown>;
  };
  const ups = (data.hooks?.UserPromptSubmit ?? []) as Array<{ hooks?: Array<{ command?: unknown } | null> | null }>;
  const cmds = ups.flatMap((e) => (e && typeof e === "object" && Array.isArray(e.hooks) ? e.hooks : []))
    .filter((h): h is { command?: unknown } => !!h && typeof h === "object")
    .map((h) => (typeof h.command === "string" ? h.command : ""));
  const problems: string[] = [];
  if (cmds.some((c) => c.includes("TAP_HOOK_MODE=roster"))) problems.push("the retired entry survived");
  if (!cmds.some((c) => c.includes("other-tool"))) problems.push("another tool's entry was eaten");
  const sessionStart = data.hooks?.SessionStart;
  if (!Array.isArray(sessionStart) || sessionStart.length === 0) problems.push("SessionStart was damaged — that is the Claude wiring that WORKS");
  return problems.length ? problems.join("; ") : null;
}

/** The main fixture, byte-for-byte the shell's heredoc (python JSON dialect:
 *  Infinity, exact big int, a literal `\u007f` JSON escape). */
function writeMainFixture(path: string): void {
  writeFileSync(path, `{
  "metadata": {"9": 1.0, "2": 9007199254740993123456789, "unicode": "café 🐎 \\u007f", "float": 1E-7, "negative": -0.0, "overflow": 1e400, "empty": [{}, []]},
  "hooks": {
    "SessionStart": [
      {"hooks": [{"type": "command", "command": "/somewhere/tap-advisory.sh"}]}
    ],
    "UserPromptSubmit": [
      {"hooks": [{"type": "command", "command": "some-other-tool --flag"}]},
      {"hooks": [{"type": "command", "command": "TAP_HOOK_MODE=roster bash /somewhere/tap-advisory.sh"}, {"command": "same-outer-entry"}]},
      {"hooks": [{"command": null}, {}, null, 7]},
      {"hooks": null},
      {}, null, 7
    ]
  }
}
`);
  chmodSync(path, 0o600);
}

test("the de-wire removes the retired entry byte-identically, sparing others, idempotently", () => {
  const settings = join(WORK, "settings.json");
  const expected = join(WORK, "expected.json");
  writeMainFixture(settings);
  pythonExpected(settings, expected);
  const first = runBash('umask 027; exec bun "$1" "$2" "$3"', [DEWIRE, "claude", settings]);
  expect(first.status, first.stderr).toBe(0);
  expect(first.stdout).toContain("removed the retired");
  expectBytes(expected, settings, "changed-file bytes differ from python (metadata, number/Unicode fidelity, order, or outer-entry removal)");
  expect(statSync(settings).mode & 0o777, "replacement must use 0666 filtered by umask").toBe(0o640);
  expect(checkState(settings), "after removal").toBeNull();
  // Idempotent: a second run changes nothing and says nothing.
  const unchanged = join(WORK, "unchanged.json");
  copyFileSync(settings, unchanged);
  const second = runDewire(null, ["claude", settings]);
  expect(second.status, second.stderr).toBe(0);
  expect(second.stdout, "de-wire is not idempotent — it reported work on a clean file").toBe("");
  expect(second.stderr, "idempotent run must stay silent on stderr too").toBe("");
  expectBytes(unchanged, settings, "second de-wire rewrote the file");
  expect(checkState(settings), "after second run").toBeNull();
});

test("safe on the shapes a real machine presents: empty, missing, and sole-entry files", () => {
  const empty = join(WORK, "empty.json");
  writeFileSync(empty, "");
  expect(runDewire(null, ["claude", empty]).status, "an unparseable settings.json must not fail the install").toBe(0);
  expect(runDewire(null, ["claude", join(WORK, "does-not-exist.json")]).status, "a missing settings.json must not fail the install").toBe(0);
  const solo = join(WORK, "solo.json");
  writeFileSync(solo, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "TAP_HOOK_MODE=roster bash /x.sh" }] }] } }));
  expect(runDewire(null, ["claude", solo]).status).toBe(0);
  const data = JSON.parse(readFileSync(solo, "utf8")) as { hooks: Record<string, unknown> };
  expect("UserPromptSubmit" in data.hooks, "removing the sole entry left an empty UserPromptSubmit key").toBe(false);
});

test("an unwritable target is reported, never fatal, and never partially written", () => {
  const dir = join(WORK, "ro");
  mkdirSync(dir, { recursive: true });
  const stale = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ command: "TAP_HOOK_MODE=roster bash /x.sh" }] }] } });
  writeFileSync(join(dir, "settings.json"), stale);
  writeFileSync(join(dir, "caller-settings.json"), stale);
  expect(readFileSync(join(dir, "settings.json"), "utf8")).toContain("TAP_HOOK_MODE=roster");
  const caller = join(WORK, "caller.sh");
  writeFileSync(caller, 'set -euo pipefail\nbun "$1" claude "$2"\necho reached\n');
  chmodSync(dir, 0o555);
  try {
    const direct = runDewire(null, ["claude", join(dir, "settings.json")]);
    expect(direct.status, `unwritable directory made the de-wire exit non-zero: ${direct.stderr}`).toBe(0);
    expect(direct.stderr).toContain("could NOT remove");
    const viaCaller = runBash('set -euo pipefail\nbun "$1" claude "$2"\necho reached', [DEWIRE, join(dir, "caller-settings.json")]);
    expect(viaCaller.status, "set-e caller did not survive a reported write failure").toBe(0);
    expect(viaCaller.stdout).toContain("reached");
    expect(viaCaller.stdout + viaCaller.stderr).toContain("could NOT remove");
    expect(readFileSync(join(dir, "settings.json"), "utf8"), "failed write changed original bytes").toBe(stale);
    expect(readFileSync(join(dir, "caller-settings.json"), "utf8"), "caller failure changed original bytes").toBe(stale);
  } finally {
    chmodSync(dir, 0o755);
  }
});

// Both formats reject ambiguous target shapes before deleting any valid match.
interface Case { harness: "claude" | "cursor"; event: string; wrap(command: unknown): Record<string, unknown> }
const CASES: Case[] = [
  {
    harness: "claude", event: "UserPromptSubmit",
    wrap: (command) => ({ hooks: [{ command }] }),
  },
  {
    harness: "cursor", event: "beforeSubmitPrompt",
    wrap: (command) => ({ command }),
  },
];

for (const { harness, event, wrap } of CASES) {
  const stale = wrap("TAP_HOOK_MODE=roster bash /old.sh");
  const bad: Array<Record<string, unknown>> = [wrap(0), wrap(1), wrap(false), wrap(true), wrap([]), wrap(["TAP_HOOK_MODE=roster"]), wrap({ "TAP_HOOK_MODE=roster": true })];
  if (harness === "claude") {
    bad.push(...[0, 1, false, "", "x", {}, { command: "x" }].map((value) => ({ hooks: value })));
    bad.push({ hooks: [{ command: "TAP_HOOK_MODE=roster" }, { command: 1 }] });
  }

  test(`${harness}: malformed targets preserve the whole file and survive a set-e caller`, () => {
    for (const [index, malformed] of bad.entries()) {
      const path = join(WORK, `${harness}-malformed-${index}.json`);
      const original = Buffer.from(JSON.stringify({ hooks: { [event]: [stale, malformed] } }));
      writeFileSync(path, original);
      const r = runBash('set -euo pipefail\nbun "$1" "$2" "$3"\necho survived', [DEWIRE, harness, path]);
      expect([r.status, r.stdout, r.stderr], `${harness} malformed #${index}`).toEqual([0, "survived\n", ""]);
      expect(readFileSync(path), `${harness} malformed #${index}: partial removal on malformed input`).toEqual(original);
    }
    // Defaults still honor the selected harness home; unrelated malformed events are ignored.
    const home = join(WORK, `default-${harness}`);
    mkdirSync(home, { recursive: true });
    const path = join(home, harness === "claude" ? "settings.json" : "hooks.json");
    writeFileSync(path, JSON.stringify({ hooks: { [event]: [stale, wrap(null), {}], unrelated: 1 } }));
    const r = runDewire(null, [harness], { [`TAP_${harness.toUpperCase()}_HOME`]: home });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ hooks: { [event]: [wrap(null), {}], unrelated: 1 } });
  });

  for (const operation of ["writeFileSync", "renameSync"] as const) {
    test(`${harness}: a fault after temp creation preserves the original and reaps only our temp (${operation})`, () => {
      const path = join(WORK, `${harness}-${operation}.json`);
      const original = Buffer.from(JSON.stringify({ hooks: { [event]: [stale] } }));
      writeFileSync(path, original);
      const foreign = `${path}.tap-tmp`;
      writeFileSync(foreign, "foreign bytes");
      const action = operation === "writeFileSync" ? 'writeSync(fd, "partial"); ' : "";
      const preload = join(WORK, `fail-fs-${harness}-${operation}.ts`);
      writeFileSync(preload,
        'import * as fs from "node:fs";\nimport { mock } from "bun:test";\n' +
        "const writeSync = fs.writeSync;\n" +
        `mock.module("node:fs", () => ({...fs, ${operation}(fd: number) { ${action}throw new Error("fixture failure"); }}));\n`);
      const r = spawnSync(process.execPath, ["--preload", preload, DEWIRE, harness, path], { encoding: "utf8", env: childEnv() });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout ?? "").toBe("");
      expect(r.stderr).toContain("could NOT remove");
      expect(readFileSync(path), "original changed").toEqual(original);
      expect(readFileSync(foreign, "utf8")).toBe("foreign bytes");
      const residue = readdirSync(WORK).filter((name) => name.startsWith(`${path.split("/").pop()!}.tap-`));
      expect(residue, "owned temp survived").toEqual([`${path.split("/").pop()!}.tap-tmp`]);
    });
  }
}

// --- Ported from skills/tap/scripts/smoke/cursor-beforesubmit-not-wired.test.sh
// (tap-he46 follow-up): Cursor's beforeSubmitPrompt returns continue and
// user_message ONLY — no context-injection field — so the roster line was
// discarded on every prompt while hooks.json showed it installed: cost with no
// effect. The de-wire must remove that entry byte-identically to the python
// reference writer, idempotently, sparing sessionStart and every other tool's
// entries, and never fail an install over an unwritable target.

/** The cursor fixture, byte-for-byte the shell's heredoc (python JSON dialect:
 *  Infinity, exact big int, a literal `\u007f` JSON escape, lowercase sessionStart). */
function writeCursorFixture(path: string): void {
  writeFileSync(path, `{
  "metadata": {"9": 1.0, "2": 9007199254740993123456789, "unicode": "café 🐎 \\u007f", "float": 1E-7, "negative": -0.0, "overflow": 1e400, "empty": [{}, []]},
  "version": 1,
  "hooks": {
    "sessionStart": [
      {"command": "bash /somewhere/tap-cursor-session-start.sh"}
    ],
    "beforeSubmitPrompt": [
      {"command": "\\"/Users/user/Scripts/other-tool\\" cursor context"},
      {"command": "TAP_HOOK_MODE=roster bash /somewhere/tap-cursor-session-start.sh"}
    ]
  }
}
`);
  chmodSync(path, 0o600);
}

/** The python reference writer for the cursor shape: flat entries, pop(1). */
function pythonCursorExpected(hooks: string, expected: string): void {
  const script = `import json, sys
data = json.load(open(sys.argv[1]))
data['hooks']['beforeSubmitPrompt'].pop(1)
with open(sys.argv[2], 'w') as out:
    json.dump(data, out, indent=2)
    out.write('\\n')
`;
  const r = spawnSync("python3", ["-B", "-", hooks, expected], { encoding: "utf8", input: script });
  expect(r.status, r.stderr).toBe(0);
}

/** The cursor state checker, ported from the shell's python (flat entries). */
function checkCursorState(path: string): string | null {
  const text = readFileSync(path, "utf8").replace(/\b(-?)Infinity\b/g, "null").replace(/\bNaN\b/g, "null");
  const data = JSON.parse(text) as { hooks?: Record<string, unknown> };
  const hooks = data.hooks ?? {};
  const bsp = (hooks.beforeSubmitPrompt ?? []) as unknown[];
  const cmds = bsp.filter((e): e is { command?: unknown } => !!e && typeof e === "object")
    .map((e) => (typeof e.command === "string" ? e.command : ""));
  const problems: string[] = [];
  if (cmds.some((c) => c.includes("TAP_HOOK_MODE=roster"))) problems.push("the no-op entry survived");
  if (!cmds.some((c) => c.includes("other-tool"))) problems.push("another tool's entry was eaten");
  const sessionStart = hooks.sessionStart;
  if (!Array.isArray(sessionStart) || sessionStart.length === 0) problems.push("sessionStart was damaged — that is the cursor wiring that WORKS");
  return problems.length ? problems.join("; ") : null;
}

test("cursor: the de-wire removes the no-op entry byte-identically, sparing sessionStart, idempotently", () => {
  const hooks = join(WORK, "cursor-hooks.json");
  const expected = join(WORK, "cursor-expected.json");
  writeCursorFixture(hooks);
  pythonCursorExpected(hooks, expected);
  const first = runBash('umask 027; exec bun "$1" "$2" "$3"', [DEWIRE, "cursor", hooks]);
  expect(first.status, first.stderr).toBe(0);
  expect(first.stdout).toContain("removed the no-op");
  expectBytes(expected, hooks, "changed-file bytes differ from python (metadata, number/Unicode fidelity, order, or no-op-entry removal)");
  expect(checkCursorState(hooks), "after removal").toBeNull();
  // Idempotent: a second run changes nothing and says nothing.
  const unchanged = join(WORK, "cursor-unchanged.json");
  copyFileSync(hooks, unchanged);
  const second = runDewire(null, ["cursor", hooks]);
  expect(second.status, second.stderr).toBe(0);
  expect(second.stdout, "de-wire is not idempotent — it reported work on a clean file").toBe("");
  expect(second.stderr, "idempotent run must stay silent on stderr too").toBe("");
  expectBytes(unchanged, hooks, "second de-wire rewrote the file");
  expect(checkCursorState(hooks), "after second run").toBeNull();
});

test("cursor: removing the sole entry leaves no empty beforeSubmitPrompt key", () => {
  const solo = join(WORK, "cursor-solo.json");
  writeFileSync(solo, JSON.stringify({ version: 1, hooks: { beforeSubmitPrompt: [{ command: "TAP_HOOK_MODE=roster bash /x.sh" }] } }));
  expect(runDewire(null, ["cursor", solo]).status).toBe(0);
  const data = JSON.parse(readFileSync(solo, "utf8")) as { hooks: Record<string, unknown> };
  expect("beforeSubmitPrompt" in data.hooks, "removing the sole entry left an empty beforeSubmitPrompt key").toBe(false);
});

test("cursor: an unwritable hooks.json is reported, never fatal, and a set-e caller survives", () => {
  const dir = join(WORK, "cursor-ro");
  mkdirSync(dir, { recursive: true });
  const stale = JSON.stringify({ version: 1, hooks: { beforeSubmitPrompt: [{ command: "TAP_HOOK_MODE=roster bash /x.sh" }] } });
  // ITS OWN FIXTURE per caller: sharing one file would make this depend on the
  // first write having failed — a reordered chmod and the assertion passes for
  // exactly the reason the shell's first two versions did (never reaching the
  // code under test).
  writeFileSync(join(dir, "hooks.json"), stale);
  writeFileSync(join(dir, "caller-hooks.json"), stale);
  expect(readFileSync(join(dir, "hooks.json"), "utf8")).toContain("TAP_HOOK_MODE=roster");
  chmodSync(dir, 0o555);
  try {
    const direct = runDewire(null, ["cursor", join(dir, "hooks.json")]);
    expect(direct.status, `unwritable directory made the de-wire exit non-zero: ${direct.stderr}`).toBe(0);
    expect(direct.stderr).toContain("could NOT remove");
    const viaCaller = runBash('set -euo pipefail\nbun "$1" cursor "$2"\necho reached', [DEWIRE, join(dir, "caller-hooks.json")]);
    expect(viaCaller.status, "set-e caller did not survive a reported write failure").toBe(0);
    expect(viaCaller.stdout).toContain("reached");
    expect(viaCaller.stdout + viaCaller.stderr).toContain("could NOT remove");
    expect(readFileSync(join(dir, "hooks.json"), "utf8"), "failed write changed original bytes").toBe(stale);
    expect(readFileSync(join(dir, "caller-hooks.json"), "utf8"), "caller failure changed original bytes").toBe(stale);
  } finally {
    chmodSync(dir, 0o755);
  }
});

const INSTALL_SH = resolve(import.meta.dir, "../../../install.sh");

test("install.sh never wires beforeSubmitPrompt on a code line and still calls the cursor de-wire", () => {
  const text = readFileSync(INSTALL_SH, "utf8");
  const wired = text.split("\n").map((line, no) => ({ line, no: no + 1 }))
    .filter(({ line }) => line.includes("beforeSubmitPrompt") && !/^\s*#/.test(line));
  expect(wired, "install.sh names beforeSubmitPrompt on a non-comment line — that event discards additional_context").toEqual([]);
  expect(text.includes('install-roster-hook-cleanup.ts" cursor'), "install.sh no longer calls the de-wire — machines carrying the roster entry stay broken").toBe(true);
});

// --- Mutant receipts: one wrong edit per named arm ---------------------------

function applyMutant(oldText: string, newText: string): void {
  if (!existsSync(MUTATED_TREE)) cpSync(resolve(import.meta.dir, "../src"), MUTATED_TREE, { recursive: true });
  const target = join(MUTATED_TREE, "install-roster-hook-cleanup.ts");
  copyFileSync(DEWIRE, target);
  const text = readFileSync(target, "utf8");
  const hits = text.split(oldText).length - 1;
  expect(hits, `mutant needle must occur exactly once: ${oldText.slice(0, 80)}`).toBe(1);
  writeFileSync(target, text.replace(oldText, newText));
}

function mutatedRun(oldText: string, newText: string, args: string[], extra: Record<string, string> = {}): Out {
  applyMutant(oldText, newText);
  return runDewire(MUTATED_TREE, args, extra);
}

function freshSettings(): string {
  const path = join(WORK, `mut-settings-${Math.random().toString(36).slice(2)}.json`);
  writeMainFixture(path);
  return path;
}

test("M-POP: a de-wire that never matches leaves the retired entry (red)", () => {
  const settings = freshSettings();
  const r = mutatedRun(
    'if (command.includes("TAP_HOOK_MODE=roster")) remove = true;',
    'if (false) remove = true;',
    ["claude", settings],
  );
  expect(r.status, r.stderr).toBe(0);
  expect(checkState(settings), "the retired entry survived").not.toBeNull();
});

test("M-OTHER: a de-wire that eats every commanded entry eats another tool's entry (red)", () => {
  const settings = freshSettings();
  const r = mutatedRun(
    'if (command.includes("TAP_HOOK_MODE=roster")) remove = true;',
    'if (command.includes("TAP_HOOK_MODE=roster") || true) remove = true;',
    ["claude", settings],
  );
  expect(r.status, r.stderr).toBe(0);
  const problems = checkState(settings) ?? "no problems (mutant had no effect)";
  expect(problems).toContain("another tool");
});

test("M-IDEM: a de-wire that reports work on a clean file is not idempotent (red)", () => {
  const settings = freshSettings();
  expect(runDewire(null, ["claude", settings]).status).toBe(0);
  const r = mutatedRun(
    "if (kept.length === entries.length) return;",
    "if (false) return;",
    ["claude", settings],
  );
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout, "mutant reported work where the real de-wire stays silent").not.toBe("");
});

test("M-SOLO: leaving an empty event key behind reds the sole-entry arm (red)", () => {
  const solo = join(WORK, "mut-solo.json");
  writeFileSync(solo, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "TAP_HOOK_MODE=roster bash /x.sh" }] }] } }));
  const r = mutatedRun(
    "else hooks.delete(event);",
    "else hooks.set(event, kept);",
    ["claude", solo],
  );
  expect(r.status, r.stderr).toBe(0);
  const data = JSON.parse(readFileSync(solo, "utf8")) as { hooks: Record<string, unknown> };
  expect("UserPromptSubmit" in data.hooks, "mutant left the empty key the arm refuses").toBe(true);
});

test("M-UNWRIT: reporting failure as a non-zero exit reds the unwritable arm (red)", () => {
  const dir = join(WORK, "mut-ro");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ command: "TAP_HOOK_MODE=roster bash /x.sh" }] }] } }));
  chmodSync(dir, 0o555);
  try {
    const r = mutatedRun(
      "if (owned) { try { unlinkSync(temp); } catch",
      "process.exitCode = 1; if (owned) { try { unlinkSync(temp); } catch",
      ["claude", join(dir, "settings.json")],
    );
    expect(r.status, "mutant turned a reported non-fatal write failure into an install abort").not.toBe(0);
  } finally {
    chmodSync(dir, 0o755);
  }
});

test("M-REPORT: dropping the could-NOT-remove report reds the report arm (red)", () => {
  const dir = join(WORK, "mut-ro2");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ command: "TAP_HOOK_MODE=roster bash /x.sh" }] }] } }));
  chmodSync(dir, 0o555);
  try {
    const r = mutatedRun(
      "console.error(`install: could NOT remove ${description}",
      "console.error(`install: denied ${description}",
      ["claude", join(dir, "settings.json")],
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr, "mutant lost the report the arm greps for").not.toContain("could NOT remove");
  } finally {
    chmodSync(dir, 0o755);
  }
});

test("M-MALF: skipping a non-string command instead of refusing reds the malformed arm (red)", () => {
  const path = join(WORK, "mut-malformed.json");
  const original = Buffer.from(JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ command: "TAP_HOOK_MODE=roster bash /old.sh" }] }, { hooks: [{ command: 1 }] }] } }));
  writeFileSync(path, original);
  const r = mutatedRun(
    'if (typeof command !== "string") return;',
    'if (typeof command !== "string") continue;',
    ["claude", path],
  );
  expect(r.status, r.stderr).toBe(0);
  expect(readFileSync(path), "mutant did not partially remove on malformed input").not.toEqual(original);
});

test("M-TEMP: keeping the owned temp on fault reds the temp-reaping arm (red)", () => {
  const path = join(WORK, "mut-temp.json");
  const original = Buffer.from(JSON.stringify({ hooks: { beforeSubmitPrompt: [{ command: "TAP_HOOK_MODE=roster bash /old.sh" }] } }));
  writeFileSync(path, original);
  writeFileSync(`${path}.tap-tmp`, "foreign bytes");
  const preload = join(WORK, "mut-fail-fs.ts");
  writeFileSync(preload,
    'import * as fs from "node:fs";\nimport { mock } from "bun:test";\n' +
    'mock.module("node:fs", () => ({...fs, renameSync() { throw new Error("fixture failure"); }}));\n');
  // Drop the owned-temp reap so the fault leaves residue behind.
  applyMutant(
    "if (owned) { try { unlinkSync(temp); } catch { /* Cleanup must not abort installation. */ } }",
    ";",
  );
  const r = spawnSync(
    process.execPath,
    ["--preload", preload, join(MUTATED_TREE, "install-roster-hook-cleanup.ts"), "cursor", path],
    { encoding: "utf8", env: childEnv() },
  );
  expect(r.status, r.stderr).toBe(0);
  const residue = readdirSync(WORK).filter((name) => name.startsWith(`mut-temp.json.tap-`));
  expect(residue.length, "mutant left the owned temp behind").toBeGreaterThan(1);
});

test("M-CURSOR: a cursor de-wire keyed to the wrong event leaves the no-op entry (red)", () => {
  const hooks = join(WORK, "mut-cursor.json");
  writeCursorFixture(hooks);
  const r = mutatedRun('"beforeSubmitPrompt"', '"beforeSubmitPromptX"', ["cursor", hooks]);
  expect(r.status, r.stderr).toBe(0);
  expect(checkCursorState(hooks), "the no-op entry survived").not.toBeNull();
});

// tap-8wsdb: inside a template literal `\u007f` cooks to a raw DEL byte, so the
// fixtures silently carried the raw character while their docstrings promised
// the JSON escape. Pin the intended spelling: six characters, no 0x7f byte.
test("fixtures hold the literal \\u007f escape, never a raw DEL byte", () => {
  for (const [name, write] of [["claude", writeMainFixture], ["cursor", writeCursorFixture]] as const) {
    const path = join(WORK, `${name}-escape-pin.json`);
    write(path);
    const bytes = readFileSync(path);
    expect(bytes.toString("utf8"), `${name} fixture lost the escape spelling`).toContain("\\u007f");
    expect(bytes.includes(0x7f), `${name} fixture carries a raw DEL byte`).toBe(false);
  }
});
