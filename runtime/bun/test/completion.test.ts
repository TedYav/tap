import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { completionCandidates } from "../src/completion";
import { scanEntries } from "../src/install-manifest";

const repo = resolve(import.meta.dir, "../../..");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("calibrate completes handles, options and note files without reading the calibration store", () => {
  const f = fixture();
  const env = { ...process.env, TAP_INDEX_HOME: f.index };
  expect(completionCandidates(["tap", "calibrate", "al"], 3, env, f.alpha).map(x => x.value)).toContain("alice");
  expect(completionCandidates(["tap", "calibrate", "--"], 3, env, f.alpha).map(x => x.value)).toContain("--all");
  expect(completionCandidates(["tap", "calibrate", "alice", "-f", ""], 5, env, f.alpha).map(x => x.description)).toEqual(["file position"]);
  expect(completionCandidates(["tap", "calibrate", "alice", "--ref", ""], 5, env, f.alpha)).toEqual([]);
});

function fixture() {
  const root = mkdtempSync(join(process.env.HOME!, "completion-"));
  roots.push(root);
  const index = join(root, "index");
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  mkdirSync(index); mkdirSync(alpha); mkdirSync(beta);
  const regA = join(alpha, "team-registry.json");
  const regB = join(beta, "team-registry.json");
  writeFileSync(regA, JSON.stringify({ schema: "0.20", seats: {
    alice: { status: "active", kind: "session", pane: "%1", harness_session_id: "native-1" },
    bob: { status: "stopped", status_reason: "session_stopped", kind: "session", harness_session_id: "native-2" },
    recoverable: { status: "suspended", status_reason: "session_stopped", kind: "session" },
    inactive: { status: "suspended", status_reason: "incapable", kind: "session", session: "old" },
    crew: { status: "active", crew: true, pane: "%3" },
    poller: { status: "active", delivery: "poll" },
  } }));
  writeFileSync(regB, JSON.stringify({ schema: "0.20", seats: { bea: { status: "active", kind: "session", pane: "%4" } } }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    alpha: { root: alpha, registry_location: regA, state: "registered" },
    beta: { root: beta, registry_location: regB, state: "registered" },
  } }));
  return { root, index, alpha, beta, regA, regB, env: { ...process.env, TAP_INDEX_HOME: index, TAP_HOME: undefined } };
}

const values = (rows: ReturnType<typeof completionCandidates>) => rows.map(row => row.value);

test("machine seat flags complete on both public spellings", () => {
  const f = fixture();
  for (const words of [["tap","teams","--"],["tap","team","list","--"]]) {
    expect(values(completionCandidates(words,words.length,f.env,f.alpha))).toEqual(expect.arrayContaining(["--seats","--wide"]));
  }
});

test("top-level completion omits retired models and keeps presets", () => {
  const f = fixture();
  const top = values(completionCandidates(["tap", ""], 2, f.env, f.alpha));
  expect(top).not.toContain("models");
  expect(top).toContain("presets");
});

test("native candidates follow target positions and comma selection eligibility", () => {
  const f = fixture();
  expect(values(completionCandidates(["tap", "attach", ""], 3, f.env, f.alpha))).toContain("alice");
  expect(values(completionCandidates(["tap", "attach", "beta/b"], 3, f.env, f.alpha))).toEqual(["beta/bea"]);
  expect(values(completionCandidates(["tap", "team", "down", "--only", "alice,b"], 5, f.env, f.alpha))).toEqual(["alice,bob"]);
  expect(values(completionCandidates(["tap", "team", "down", "--only", "crew"], 5, f.env, f.alpha))).toEqual([]);
  expect(values(completionCandidates(["tap", "team", "down", "--only", "alice,a"], 5, f.env, f.alpha))).toEqual([]);
  expect(values(completionCandidates(["tap", "up", ""], 3, f.env, f.alpha))).not.toContain("crew");
  expect(values(completionCandidates(["tap", "attach", "alice", ""], 4, f.env, f.alpha))).toEqual([]);
  expect(values(completionCandidates(["tap", "team", "roster", "b"], 4, f.env, f.alpha))).toEqual(["beta"]);
  expect(values(completionCandidates(["tap", "send", "--team", "b"], 4, f.env, f.alpha))).toEqual(["beta"]);
  expect(values(completionCandidates(["tap", "send", "--from", "a"], 4, f.env, f.alpha))).toContain("alice");
});

test("completion follows accepted grammar and stored eligibility without probing panes", () => {
  const f = fixture();
  const at = (...words: string[]) => values(completionCandidates(["tap", ...words], words.length + 1, f.env, f.alpha));
  expect(at("te")).toEqual(expect.arrayContaining(["team", "teams", "teardown"]));
  expect(at("a")).not.toContain("advisory");
  expect(at("team", "")).not.toContain("alpha");
  expect(at("team", "roster", "a")).toEqual(["alpha"]);
  expect(at("team", "detach", "a")).toEqual(["alpha"]);
  expect(at("team", "roster", "--team", "a")).toEqual([]);
  expect(at("team", "attach", "--j")).toEqual([]);
  expect(at("team", "attach", "--t")).toEqual(["--tabs"]);
  expect(at("team", "detach", "--d")).toEqual(["--dry-run"]);
  expect(at("team", "out", "--d")).toEqual(["--dry-run"]);
  expect(at("team", "detach", "--handle", "a")).toEqual(["alice"]);
  expect(at("poll", "--by", "a")).toEqual([]);
  expect(at("reply", "--j")).toEqual([]);
  expect(at("peek", "--team", "a")).toEqual([]);
  expect(at("peek", "--p")).toEqual(["--pane"]);
  expect(at("peek", "--pane", "a")).toEqual([]);
  expect(at("send", "-f", "")).toEqual(["\x1fFILES"]);
  expect(at("send", "alice", "-f", "")).toEqual(["\x1fFILES"]);
  expect(at("send", "--message", "")).toEqual([]);
  expect(at("peek", "beta/b")).toEqual([]);
  expect(at("session", "resume", "beta/b")).toEqual([]);
  expect(at("session", "resume", "r")).toEqual(["recoverable"]);
  expect(at("nudge", "p")).toEqual([]);
  expect(at("nudge", "i")).toEqual([]);
  expect(at("nudge", "a")).toContain("alice");
  expect(values(completionCandidates(["tap", "attach", "b"], 3, { ...f.env, TAP_HOME: join(f.beta, ".tap") }, f.alpha))).toEqual(["bob", "beta/bea"]);
});

test("team selector completion follows the explicit team and optional-value grammar", () => {
  const f = fixture();
  const at = (...words: string[]) => values(completionCandidates(["tap", ...words], words.length + 1, f.env, f.alpha));
  expect(at("team", "down", "beta", "--only", "b")).toEqual(["bea"]);
  expect(at("team", "down", "missing", "--only", "a")).toEqual([]);
  expect(at("team", "detach", "beta", "--except", "b")).toEqual(["bea"]);
  expect(at("team", "down", "beta", "--only", "--y")).toEqual(["--yes"]);
  expect(at("team", "down", "beta", "--only", "--yes", "--d")).toEqual(["--dry-run"]);
  expect(at("team", "down", "--only", "--yes", "")).toEqual([]);
  expect(at("team", "attach", "--except", "--yes", "")).toEqual([]);
  expect(at("team", "down", "--only", "alice", "b")).toEqual(["beta"]);
  for (const verb of ["attach", "detach", "up"]) expect(at("team", verb, "--y")).toEqual(["--yes"]);
});

test("candidate door is quiet and does not create debug or TAP state", () => {
  const f = fixture();
  const debug = join(f.index, "debug"); mkdirSync(debug);
  writeFileSync(join(debug, "enabled.json"), "{}");
  const before = readdirSync(f.index).sort();
  const result = Bun.spawnSync([join(repo, "bin/tap"), "completion", "candidates", "--cursor", "3", "--", "tap", "attach", "a"], {
    cwd: f.alpha,
    env: { ...f.env, TAP_VERBOSE: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(f.root, "cache") },
    stdin: "ignore",
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("alice\tstored active");
  expect(result.stderr.toString()).toBe("");
  expect(readdirSync(f.index).sort()).toEqual(before);
  expect(readdirSync(debug)).toEqual(["enabled.json"]);
  expect(existsSync(join(f.root, "cache"))).toBe(false);
  writeFileSync(f.regA, "{broken");
  const bad = Bun.spawnSync([join(repo, "bin/tap"), "completion", "candidates", "--cursor", "3", "--", "tap", "attach", "a"], {
    cwd: f.alpha, env: f.env, stdin: "ignore",
  });
  expect(bad.exitCode).toBe(0);
  expect(bad.stdout.toString()).toBe("");
  expect(bad.stderr.toString()).toBe("");
});

test("public zsh form prints a valid adapter without creating an index", () => {
  const f = fixture();
  const emptyIndex = join(f.root, "no-index");
  const result = Bun.spawnSync([join(repo, "bin/tap"), "completion", "zsh"], {
    cwd: f.alpha, env: { ...f.env, TAP_INDEX_HOME: emptyIndex, TAP_VERBOSE: "1" }, stdin: "ignore",
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(result.stdout.toString()).toContain("compdef _tap tap");
  expect(existsSync(emptyIndex)).toBe(false);
  const syntax = Bun.spawnSync(["zsh", "-n"], { stdin: result.stdout });
  expect(syntax.exitCode).toBe(0);
  const help = Bun.spawnSync([join(repo, "bin/tap"), "completion", "--help"], { cwd: f.alpha, env: f.env, stdin: "ignore" });
  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toContain("tap completion zsh");
  const unsupported = Bun.spawnSync([join(repo, "bin/tap"), "completion", "fish"], { cwd: f.alpha, env: f.env, stdin: "ignore" });
  expect(unsupported.exitCode).toBe(1);
  expect(unsupported.stderr.toString()).toContain("supported shell is zsh");
});

test("real zsh listing shows command names and body files without offering teams after bare team", () => {
  if (!Bun.which("zsh")) return;
  const f = fixture();
  writeFileSync(join(f.alpha, "completion-proof.txt"), "body\n");
  const init = join(f.root, "zinit.zsh"), driver = join(f.root, "zpty.zsh");
  writeFileSync(init, [
    `export PATH=${JSON.stringify(join(repo, "bin"))}:$PATH`,
    `export TAP_INDEX_HOME=${JSON.stringify(f.index)}`,
    `cd ${JSON.stringify(f.alpha)}`,
    `fpath=(${JSON.stringify(join(repo, "completions"))} $fpath)`,
    "export COLUMNS=250 LINES=60",
    "autoload -Uz compinit; compinit -u",
    "zstyle ':completion:*' menu no",
    "unset zle_bracketed_paste",
    "setopt nolistbeep nomenucomplete noautomenu",
    "PROMPT='RDY>'",
  ].join("\n") + "\n");
  writeFileSync(driver, [
    "emulate -L zsh",
    "zmodload zsh/zpty || exit 90",
    "zpty zt 'zsh -df -i' || exit 91",
    "zpty -w zt 'source " + init + "'",
    "sync() { local out='' c; integer deadline=$((SECONDS + 30)); while (( SECONDS < deadline )); do if zpty -r -t zt c 2>/dev/null; then out+=$c; [[ $out == *\"RDY>\"* ]] && return 0; else sleep 0.02; fi; done; return 1 }",
    "sync || exit 92",
    "candidates() {",
    "  zpty -n -w zt \"$1\"$'\\t\\t'",
    "  zpty -n -w zt '__TAP_DONE__'",
    "  local out='' c; integer deadline=$((SECONDS + 30))",
    "  while (( SECONDS < deadline )); do if zpty -r -t zt c 2>/dev/null; then out+=$c; [[ $out == *__TAP_DONE__* ]] && break; else sleep 0.02; fi; done",
    "  [[ $out == *__TAP_DONE__* ]] || return 1",
    "  print -r -- \"CASE:$2\"; print -r -- \"$out\"; print -r -- ENDCASE",
    "  zpty -n -w zt $'\\C-c'; sync",
    "}",
    "candidates 'tap te' top || exit 93",
    "candidates 'tap team ' team || exit 94",
    "candidates 'tap send alice -f ' file || exit 95",
    "zpty -d zt",
  ].join("\n") + "\n");
  const result = Bun.spawnSync(["zsh", driver], { cwd: f.alpha, env: f.env, timeout: 100_000, stdin: "ignore" });
  if (result.exitCode !== 0) throw new Error(`zpty exited ${result.exitCode}: ${result.stderr.toString()} ${result.stdout.toString()}`);
  const output = result.stdout.toString().replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replaceAll("\r", "");
  const section = (name: string) => output.split(`CASE:${name}\n`)[1]?.split("\nENDCASE")[0] ?? "";
  expect(section("top")).toMatch(/\bteam\b/);
  expect(section("top")).toMatch(/\bteams\b/);
  expect(section("top")).toMatch(/\bteardown\b/);
  expect(section("team")).not.toMatch(/\balpha\b/);
  expect(section("file")).toContain("completion-proof.txt");
});

test("owned zsh link is in the install manifest scan", () => {
  const f = fixture();
  const bin = join(f.root, "bin");
  const site = join(f.root, "share", "zsh", "site-functions");
  mkdirSync(bin); mkdirSync(site, { recursive: true });
  const link = join(site, "_tap");
  Bun.spawnSync(["ln", "-s", join(repo, "completions/_tap"), link]);
  const targets = Object.fromEntries(["BIN_DIR", "INDEX_HOME", "CLAUDE_HOME", "CODEX_HOME", "HERMES_HOME", "CURSOR_HOME", "OPENCODE_HOME", "GEMINI_HOME", "CURSOR_AGENT_HOME", "AGENTS_HOME"]
    .map(name => [name, name === "BIN_DIR" ? bin : join(f.root, name)]));
  expect(scanEntries(repo, targets, true)).toContainEqual({ kind: "symlink", path: join(bin, "../share/zsh/site-functions/_tap"), target: join(repo, "completions/_tap") });
  expect(readFileSync(join(repo, "completions/_tap"), "utf8")).toContain("#compdef tap");
});

test("session fork completes forkable seats and its own flags", () => {
  const f = fixture();
  writeFileSync(f.regA, JSON.stringify({ schema: "0.20", seats: {
    alice: { status: "active", harness: "claude", pane: "%1" }, cx: { status: "active", harness: "codex", pane: "%2" },
    ag: { status: "active", harness: "agy", pane: "%3" }, cu: { status: "active", harness: "cursor", pane: "%4" },
  } }));
  const at = (...words: string[]) => values(completionCandidates(["tap", ...words], words.length + 1, f.env, f.alpha));
  expect(at("session", "f")).toEqual(["fork"]);
  expect(at("session", "fork", "")).toEqual(["alice", "cx"]);
  expect(at("session", "fork", "--d")).toEqual(["--dry-run"]);
});
