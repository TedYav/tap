import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { removeScratchTree } from "./support/scratch";

const root = resolve(import.meta.dir, "../../..");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function fixture() {
  if (!process.env.TAP_HOME) throw new Error("ask tests require the isolated TAP runner");
  const dir = mkdtempSync(join(process.env.TAP_HOME, "ask-native-"));
  for (const part of ["bin", "home", "index", "bus", "config/tap"]) mkdirSync(join(dir, part), { recursive: true });
  symlinkSync(process.execPath, join(dir, "bin/bun"));
  const python = Bun.which("python3");
  if (python) symlinkSync(python, join(dir, "bin/python3"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(dir, "home"), TAP_INDEX_HOME: join(dir, "index"),
    TAP_HOME: join(dir, "bus"), XDG_CONFIG_HOME: join(dir, "config"),
    PATH: `${join(dir, "bin")}:/usr/bin:/bin`, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", ASK_CAPTURE: dir };
  delete env.TAP_VERBOSE;
  delete env.TAP_ASK_TIMEOUT_SECONDS;
  delete env.TAP_JSON;
  return { dir, env, close: () => removeScratchTree(dir) };
}
function running(pid: number): boolean {
  const status = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  return status.status === 0 && status.stdout.trim() !== "" && !status.stdout.trim().startsWith("Z");
}
async function waitFor(path: string) {
  const end = Date.now() + 10000;
  while (!existsSync(path)) {
    if (Date.now() > end) throw new Error(`fixture did not publish ${path}`);
    await sleep(20);
  }
}

test.each(["SIGTERM", "SIGINT", "timeout"] as const)("%s cleans a TERM-resistant descendant after its parent exits", async mode => {
  const f = fixture();
  writeFileSync(join(f.dir, "bin/claude"), `#!/bin/bash
cat >/dev/null
printf '%s' "$$" > "$ASK_CAPTURE/parent.pid"
trap 'exit 0' TERM
/bin/bash -c 'trap "" TERM; printf "%s" "$$" > "$ASK_CAPTURE/descendant.tmp"; mv "$ASK_CAPTURE/descendant.tmp" "$ASK_CAPTURE/descendant.pid"; while :; do sleep 1; done' &
wait
`, { mode: 0o755 });
  const child = Bun.spawn(["/bin/bash", join(root, "scripts/tap.sh"), "ask", "claude", "-m", "prompt"], {
    env: { ...f.env, ...(mode === "timeout" ? { TAP_ASK_TIMEOUT_SECONDS: "1" } : {}) }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let parent = 0, descendant = 0;
  try {
    await waitFor(join(f.dir, "descendant.pid"));
    parent = Number(readFileSync(join(f.dir, "parent.pid"), "utf8"));
    descendant = Number(readFileSync(join(f.dir, "descendant.pid"), "utf8"));
    if (mode !== "timeout") {
      child.kill(mode);
      await sleep(50);
      child.kill(mode); // Cleanup remains bounded and cannot be interrupted.
    }
    expect(await child.exited).toBe(mode === "timeout" ? 124 : mode === "SIGINT" ? 130 : 143);
    const deadline = Date.now() + 2000;
    while (running(descendant) && Date.now() < deadline) await sleep(20);
    expect(running(descendant)).toBe(false);
  } finally {
    child.kill("SIGKILL");
    if (parent) { try { process.kill(-parent, "SIGKILL"); } catch {} }
    if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch {} }
    await child.exited;
    f.close();
  }
}, 15000);

const doors: Record<string, string[]> = {
  bin: ["/bin/bash", join(root, "bin/tap")],
  root: ["/bin/bash", join(root, "scripts/tap.sh")],
  main: [process.execPath, join(root, "runtime/bun/main.ts")],
};
function run(f: ReturnType<typeof fixture>, args: string[], door = doors.bin!, extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(door[0]!, [...door.slice(1), ...args], { env: { ...f.env, ...extra }, cwd: f.dir, encoding: "utf8", timeout: 15000 });
}
function harnesses(f: ReturnType<typeof fixture>) {
  const script = `#!/bin/bash
printf '%s\\0' "$@" > "$ASK_CAPTURE/argv"
printf '%s' "${'${PRESET_FLAG:-absent}'}" > "$ASK_CAPTURE/env"
if [ "${'${FAKE_MODE:-}'}" = early ]; then exit 23; fi
if [ "${'${FAKE_MODE:-}'}" = pre-diagnostic-block ]; then while :; do sleep 1; done; fi
cat > "$ASK_CAPTURE/stdin"
if [ "${'${FAKE_MODE:-}'}" != silent ]; then printf 'answer\\000bytes\\n'; fi
printf 'harness diagnostic\\n' >&2
case "${'${FAKE_MODE:-}'}" in
  term) kill -TERM $$ ;;
  kill) kill -KILL $$ ;;
  block) while :; do sleep 1; done ;;
esac
exit "${'${FAKE_EXIT:-0}'}"
`;
  for (const binary of ["claude", "codex", "opencode", "cursor-agent", "hermes", "agy"]) writeFileSync(join(f.dir, "bin", binary), script, { mode: 0o755 });
}
const argvOf = (f: ReturnType<typeof fixture>) => readFileSync(join(f.dir, "argv"), "utf8").split("\0").slice(0, -1);

import { askDuration } from "../src/verbs/ask";
import { readdirSync, chmodSync, unlinkSync } from "node:fs";
import { ASK_HELP } from "../src/help";
import { INHERITED_IDENTITY_ENV } from "../src/session-store";

test("duration matches Python g rounding, exponent thresholds and ties-even", () => {
  for (const [value, expected] of [
    [900, "900"], [0.1, "0.1"], [0.0001, "0.0001"], [1234567, "1.23457e+06"],
    [1000000, "1e+06"], [999999.5, "1e+06"], [1e-5, "1e-05"], [1e-7, "1e-07"],
    [0.000123456789, "0.000123457"], [5e-324, "4.94066e-324"],
    [123456.5, "123456"], [123457.5, "123458"],
  ] as const) expect(askDuration(value)).toBe(expected);
});

test("all six adapters preserve literal prompt bytes, streams, model and argv order", () => {
  const f = fixture(); harnesses(f);
  const prompt = "\uFEFFliteral `ticks` $(false)\r\n\ud83d\ude00\n";
  const path = join(f.dir, "prompt"); writeFileSync(path, prompt);
  const expected = (harness: string, model: string[]): string[] =>
    harness === "claude" ? ["--print", "--no-session-persistence", ...model]
    : harness === "codex" ? ["exec", "--ephemeral", "--color", "never", ...model, "-"]
    : harness === "opencode" ? ["run", ...model, "--", prompt]
    : harness === "cursor" ? ["--print", "--mode", "ask", ...model, "--", prompt]
    : harness === "hermes" ? [...model, `--oneshot=${prompt}`]
    : [...model, `--print=${prompt}`];
  try {
    for (const harness of ["claude", "codex", "opencode", "cursor", "hermes", "agy"]) for (const model of [[], ["--model", "named-tier"]]) {
      const stdin = harness === "claude" || harness === "codex";
      const result = run(f, ["ask", harness, "-f", path, ...model]);
      expect(result.status).toBe(0); expect(result.stdout).toBe("answer\0bytes\n"); expect(result.stderr).toBe("harness diagnostic\n");
      expect(argvOf(f)).toEqual(expected(harness, model));
      expect(readFileSync(join(f.dir, "stdin"), "utf8")).toBe(stdin ? prompt : "");
    }
    expect(run(f, ["ask", "claude", "-m", ""]).status).toBe(0);
    expect(readFileSync(join(f.dir, "stdin"), "utf8")).toBe("");
    // Bodies are free text: the joined-argument guard reads only the preset/harness words.
    expect(run(f, ["ask", "claude", "-m", "two words"]).status).toBe(0);
    expect(readFileSync(join(f.dir, "stdin"), "utf8")).toBe("two words");
    const large = "\uFEFF" + "abcd\0é\r\n".repeat(40000); writeFileSync(path, large);
    expect(run(f, ["ask", "claude", "-f", path]).status).toBe(0);
    expect(readFileSync(join(f.dir, "stdin"), "utf8")).toBe(large);
    expect(run(f, ["ask", "claude", "-f", path], doors.bin, { FAKE_MODE: "early" }).status).toBe(23);
    unlinkSync(join(f.dir, "argv"));
    expect(run(f, ["ask", "cursor", "-f", path]).status).toBe(1);
    expect(existsSync(join(f.dir, "argv"))).toBe(false);
  } finally { f.close(); }
});

test("value-flag harnesses receive the prompt as the flag value, not a sibling argument", () => {
  const f = fixture();
  // Mimics agy's Go-style and hermes's argparse-style parsing: the named flag
  // takes the NEXT argument (or the joined = form) as its value, and a
  // flag-shaped value is swallowed as the prompt with only a stderr note and
  // empty stdout — the silent-failure shape reported in tap-igf8s/tap-jh8s7.
  const stub = `#!/bin/bash
value=""
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  case "\${args[$i]}" in
    "\${FAKE_FLAG:?}") value="\${args[$((i + 1))]:-}"; ((i++)) ;;
    "\${FAKE_FLAG}="*) value="\${args[$i]#"\${FAKE_FLAG}"=}" ;;
  esac
done
printf '%s\\0' "$@" > "$ASK_CAPTURE/argv"
if [ -z "$value" ] || [[ "$value" == --* ]]; then
  printf '%s\\n' "stub: a flag-shaped token was swallowed as the prompt" >&2
  exit 0
fi
printf '%s' "$value"
`;
  writeFileSync(join(f.dir, "bin/agy"), stub, { mode: 0o755 });
  writeFileSync(join(f.dir, "bin/hermes"), stub, { mode: 0o755 });
  writeFileSync(join(f.dir, "config/tap/config.toml"), `version = 4
[presets.tuned]
harness="hermes"
params.effort="high"
`);
  try {
    const direct = run(f, ["ask", "agy", "-m", "say hi"], doors.bin, { FAKE_FLAG: "--print" });
    expect(direct.status).toBe(0);
    expect(direct.stdout).toBe("say hi");
    expect(argvOf(f)).toEqual(["--print=say hi"]);
    const modelled = run(f, ["ask", "agy", "-m", "say hi", "--model", "named-tier"], doors.bin, { FAKE_FLAG: "--print" });
    expect(modelled.status).toBe(0);
    expect(modelled.stdout).toBe("say hi");
    expect(argvOf(f)).toEqual(["--model", "named-tier", "--print=say hi"]);
    // A preset passthrough between the flag and the prompt is the exact shape
    // that used to feed --oneshot the passthrough token instead of the prompt.
    const tuned = run(f, ["ask", "tuned", "-m", "real prompt"], doors.bin, { FAKE_FLAG: "--oneshot" });
    expect(tuned.status).toBe(0);
    expect(tuned.stdout).toBe("real prompt");
    expect(argvOf(f)).toEqual(["--effort", "high", "--oneshot=real prompt"]);
    // The joined form keeps a leading-dash prompt a prompt, not a new flag.
    const dashed = run(f, ["ask", "hermes", "-m", "-not-a-flag"], doors.bin, { FAKE_FLAG: "--oneshot" });
    expect(dashed.status).toBe(0);
    expect(dashed.stdout).toBe("-not-a-flag");
    expect(argvOf(f)).toEqual(["--oneshot=-not-a-flag"]);
  } finally { f.close(); }
});

test("positional-prompt harnesses get a -- separator, so a leading-dash prompt stays the message", () => {
  const f = fixture(); harnesses(f);
  try {
    for (const [harness, head] of [["opencode", ["run"]], ["cursor", ["--print", "--mode", "ask"]]] as const) {
      const result = run(f, ["ask", harness, "-m", "--not-a-flag"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("answer\0bytes\n");
      expect(argvOf(f)).toEqual([...head, "--", "--not-a-flag"]);
    }
  } finally { f.close(); }
});

test("exit 0 with empty stdout and a stderr complaint is refused, not reported as success", () => {
  const f = fixture(); harnesses(f);
  try {
    for (const harness of ["claude", "agy", "opencode"] as const) {
      const silent = run(f, ["ask", harness, "-m", "x"], doors.bin, { FAKE_MODE: "silent" });
      expect(silent.status).toBe(1);
      expect(silent.stdout).toBe("");
      expect(silent.stderr).toContain("harness diagnostic");
      expect(silent.stderr).toContain(`tap ask: ${harness} produced no output`);
    }
  } finally { f.close(); }
});

test("prompt refusals are before launch; symlinks and literal dash path retain their meaning", () => {
  const f = fixture(); harnesses(f);
  const invalid = join(f.dir, "invalid"), fifo = join(f.dir, "fifo");
  writeFileSync(invalid, Buffer.from([0xff]));
  expect(spawnSync("/usr/bin/mkfifo", [fifo]).status).toBe(0);
  try {
    for (const path of [join(f.dir, "missing"), f.dir, fifo, "/dev/null", invalid, "-"]) {
      const result = run(f, ["ask", "claude", "-f", path]);
      expect(result.status).toBe(1); expect(existsSync(join(f.dir, "argv"))).toBe(false);
    }
    writeFileSync(join(f.dir, "-"), "dash");
    symlinkSync(join(f.dir, "-"), join(f.dir, "link"));
    expect(run(f, ["ask", "claude", "-f", "link"]).status).toBe(0);
    expect(readFileSync(join(f.dir, "stdin"), "utf8")).toBe("dash");
  } finally { f.close(); }
});

test("parser and TAP_JSON preserve plain failures and preset refusal ordering", () => {
  const f = fixture(); harnesses(f);
  const config = join(f.dir, "config/tap/config.toml");
  try {
    for (const args of [[], ["claude"], ["claude", "-f"], ["claude", "-m"], ["claude", "--model"],
      ["claude", "-m", "x", "-m", "y"], ["claude", "-f", "a", "-f", "b"], ["claude", "--model", "a", "--model", "b"],
      ["claude", "--preset", "a", "--preset=b"], ["claude", "-m", "x", "-f", "bad"], ["claude", "--unknown"], ["claude", "other"]]) {
      const result = run(f, ["ask", ...args], doors.bin, { TAP_JSON: "1" });
      expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toStartWith("tap ask:");
    }
    for (const [args, kind] of [
      [["--preset", "missing"], "preset_config_missing"], [["missing"], "harness_or_preset_not_found"],
      [["opus name"], "arguments_joined"], [["--preset", "opus name"], "arguments_joined"],
    ] as const) {
      const result = run(f, ["ask", ...args, "-f", "also-missing"], doors.bin, { TAP_JSON: "1" });
      expect(result.status).toBe(1); expect(result.stderr).toBe(""); expect(JSON.parse(result.stdout).error_class).toBe(kind);
    }
    const joined = JSON.parse(run(f, ["ask", "opus name", "-m", "x"], doors.bin, { TAP_JSON: "1" }).stdout);
    expect(joined.detail).toBe("'opus name' looks like two arguments joined into one; zsh does not word-split unquoted variables, so pass them as separate arguments");
    expect(joined.action).toBe('tap ask <preset|harness> -f <prompt.md> | -m "..."');
    writeFileSync(config, 'version = 3\n[presets.good]\nharness="claude"\n[presets.bad]\nharness="invalid"\n');
    for (const [args, kind] of [
      [["--preset=bad"], "preset_not_usable"], [["--preset=unknown"], "preset_not_found"],
      [["unknown", "--model", "x"], "harness_or_preset_not_found"],
      [["good", "--model", "x"], "preset_not_composable"], [["codex", "--preset", "good"], "preset_harness_mismatch"],
    ] as const) {
      const result = run(f, ["ask", ...args, "-f", "also-missing"], doors.bin, { TAP_JSON: "1" });
      expect(result.status).toBe(1); expect(result.stderr).toBe(""); expect(JSON.parse(result.stdout).error_class).toBe(kind);
    }
    expect(existsSync(join(f.dir, "argv"))).toBe(false);
    writeFileSync(config, 'not [ valid');
    expect(run(f, ["ask", "claude", "-m", "x"]).status).toBe(0);
    expect(JSON.parse(run(f, ["ask", "good", "-m", "x"], doors.bin, { TAP_JSON: "1" }).stdout).error_class).toBe("preset_config_invalid");
    chmodSync(config, 0o666);
    expect(JSON.parse(run(f, ["ask", "good", "-m", "x"], doors.bin, { TAP_JSON: "1" }).stdout).error_class).toBe("preset_config_insecure");
  } finally { f.close(); }
});

test("preset keys, argv, environment and command-local notice suppression", () => {
  const f = fixture(); harnesses(f);
  writeFileSync(join(f.dir, "config/tap/config.toml"), `version = 4
[presets.rich]
harness="claude"
params.model="opus"
params.effort="high"
env.PRESET_FLAG="declared-private"
[presets.conflict]
harness="cursor"
params.mode="agent"
[presets.timeout]
harness="agy"
params.print-timeout="5s"
[presets.false]
harness="cursor"
params.mode=false
params.foo="--mode"
[harness.claude]
params.machine="must-not-apply"
env.MACHINE_FLAG="must-not-apply"
permissions="auto"
`);
  try {
    const result = run(f, ["ask", "--preset=rich", "-m", "x"], doors.bin, { PRESET_FLAG: "ambient-private" });
    expect(result.status).toBe(0);
    expect(argvOf(f)).toEqual(["--print", "--no-session-persistence", "--model", "opus", "--effort", "high"]);
    expect(readFileSync(join(f.dir, "env"), "utf8")).toBe("declared-private");
    expect(result.stderr.match(/overriding ambient ENV var PRESET_FLAG/g)?.length).toBe(1);
    expect(result.stderr).not.toContain("ambient-private"); expect(result.stderr).not.toContain("declared-private");
    const quiet = run(f, ["ask", "rich", "-m", "x"], doors.bin, { TAP_JSON: "1", PRESET_FLAG: "ambient-private" });
    expect(quiet.status).toBe(0); expect(quiet.stderr).toBe("harness diagnostic\n");
    for (const preset of ["conflict"]) {
      unlinkSync(join(f.dir, "argv"));
      const refused = run(f, ["ask", preset, "-m", "x"], doors.bin, { TAP_JSON: "1" });
      expect(JSON.parse(refused.stdout).error_class).toBe("preset_adapter_conflict");
      expect(existsSync(join(f.dir, "argv"))).toBe(false);
      writeFileSync(join(f.dir, "argv"), "");
    }
    // tap ask no longer forwards a native timeout flag for agy, so a preset's
    // own --print-timeout is legitimate passthrough ahead of the prompt, not a
    // duplicate of something tap fixes.
    expect(run(f, ["ask", "timeout", "-m", "x"]).status).toBe(0);
    expect(argvOf(f)).toEqual(["--print-timeout", "5s", "--print=x"]);
    expect(run(f, ["ask", "false", "-m", "x"]).status).toBe(0);
    expect(argvOf(f)).toEqual(["--print", "--mode", "ask", "--foo=--mode", "--", "x"]);
  } finally { f.close(); }
});

test("timeout grammar, outer deadline and independently signalled child statuses", () => {
  const f = fixture(); harnesses(f);
  try {
    for (const raw of ["", " ", "0", "-1", "inf", "nan", "0x10", "1.2tail", "\x1c7\x1f"]) {
      const r = run(f, ["ask", "agy", "-m", "x"], doors.bin, { TAP_ASK_TIMEOUT_SECONDS: raw, TAP_JSON: "1" });
      expect(r.status).toBe(1); expect(r.stdout).toBe(""); expect(r.stderr).toContain("must be positive");
    }
    for (const raw of ["1_000_000", "١٢٣", " 1e3 "]) {
      expect(run(f, ["ask", "agy", "-m", "x"], doors.bin, { TAP_ASK_TIMEOUT_SECONDS: raw }).status).toBe(0);
      expect(argvOf(f)).toEqual(["--print=x"]);
    }
    expect(run(f, ["ask", "claude", "-m", "x"], doors.bin, { TAP_ASK_TIMEOUT_SECONDS: "1e30" }).status).toBe(0);
    for (const [mode, code] of [["term", 241], ["kill", 247], ["early", 23]] as const) expect(run(f, ["ask", "claude", "-m", "x"], doors.bin, { FAKE_MODE: mode }).status).toBe(code);
    // The outer deadline includes child startup. A diagnostic that the child
    // has not reached is not promised; exercise that case without scheduler luck.
    for (const mode of ["block", "pre-diagnostic-block"]) {
      const expired = run(f, ["ask", "claude", "-m", "x"], doors.bin, { FAKE_MODE: mode, TAP_ASK_TIMEOUT_SECONDS: "0.1", TAP_JSON: "1" });
      expect(expired.status).toBe(124);
      if (mode === "pre-diagnostic-block") expect(expired.stderr).toBe("tap ask: claude timed out after 0.1s\n");
      else expect(expired.stderr).toMatch(/^(?:harness diagnostic\n)?tap ask: claude timed out after 0\.1s\n$/);
    }
    unlinkSync(join(f.dir, "bin/claude"));
    expect(run(f, ["ask", "claude", "-m", "x"]).status).toBe(127);
    writeFileSync(join(f.dir, "bin/claude"), "#!/nonexistent/interpreter\n", { mode: 0o755 });
    expect(run(f, ["ask", "claude", "-m", "x"]).status).toBe(127);
  } finally { f.close(); }
});

function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (path: string) => {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      files[file.slice(dir.length)] = entry.isDirectory() ? "directory" : readFileSync(file).toString("base64");
      if (entry.isDirectory()) walk(file);
    }
  };
  for (const part of ["home", "index", "bus", "cache"]) walk(join(dir, part));
  return files;
}

test("public, direct, and help entrances are cold-state pure without debug", () => {
  const f = fixture(); harnesses(f);
  writeFileSync(join(f.dir, "bus/evidence"), "preserve");
  // A native ask must not call Python, including catalog resolution.
  unlinkSync(join(f.dir, "bin/python3"));
  writeFileSync(join(f.dir, "bin/python3"), '#!/bin/sh\necho unexpected-python >&2\nexit 91\n', { mode: 0o755 });
  writeFileSync(join(f.dir, "config/tap/config.toml"), 'version=3\n[presets.native]\nharness="claude"\n');
  try {
    for (const [name, door] of Object.entries(doors)) {
      const env = name === "main" ? {} : { BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(f.dir, "cache") };
      const before = snapshot(f.dir);
      expect(run(f, ["ask", "native", "-m", "x"], door, env).status).toBe(0);
      for (const args of [["help", "ask"], ["-h", "ask"], ["--help", "ask"], ["ask", "help"], ["ask", "-h"], ["ask", "--help"]]) {
        const result = run(f, args, door, env);
        expect(result.status).toBe(0); expect(result.stdout).toBe(ASK_HELP);
      }
      const extra = run(f, ["help", "ask", "extra"], door, env);
      expect(extra.status).toBe(1); expect(extra.stdout).toBe(""); expect(extra.stderr).toContain("no help topic 'ask extra'");
      expect(snapshot(f.dir)).toEqual(before);
    }
    // Verbose diagnostics remain another owner's Python helper on the generic
    // extra-word help path; this check targets the pre-start cache pin.
    expect(run(f, ["-v", "help", "ask", "extra"], doors.bin, { TAP_PYTHON3: Bun.which("python3")!, BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(f.dir, "cache") }).stderr).toContain("no help topic 'ask extra'");
    expect(existsSync(join(f.dir, "cache"))).toBe(false);
    const before = snapshot(f.dir);
    const imported = run(f, ["-e", `await import(${JSON.stringify(join(root, "runtime/bun/src/verbs/ask.ts"))})`], [process.execPath]);
    expect(imported.status).toBe(0); expect(imported.stdout).toBe(""); expect(imported.stderr).toBe(""); expect(snapshot(f.dir)).toEqual(before);
    unlinkSync(join(f.dir, "bin/bun"));
    // Help has one owner (help.ts); without Bun the bash entry names the missing runtime.
    const extra = run(f, ["help", "ask", "extra"], doors.bin);
    expect(extra.status).toBe(1); expect(extra.stdout).toBe("");
    expect(extra.stderr).toBe("tap: bun and runtime/bun/main.ts are required; next: brew install oven-sh/bun/bun, then rerun ./install.sh\n");
  } finally { f.close(); }
}, 30000);

test("enabled command journal stays opted-in with no extra TAP lifecycle effects", () => {
  const f = fixture(); harnesses(f);
  const debug = join(f.dir, "index/debug"), recording = join(debug, "capture");
  mkdirSync(recording, { recursive: true });
  writeFileSync(join(debug, "enabled.json"), JSON.stringify({ id: "ask-test", directory: recording }));
  const before = snapshot(f.dir);
  try {
    expect(run(f, ["ask", "claude", "-m", "private prompt"]).status).toBe(0);
    const rows = readFileSync(join(recording, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows).toHaveLength(1); expect(rows[0].event).toBe("tap.command"); expect(rows[0].argv).toEqual(["ask", "claude", "-m", "<redacted>"]);
    const after = snapshot(f.dir); delete after["/index/debug/capture/events.jsonl"];
    expect(after).toEqual(before);
  } finally { f.close(); }
});

test("headless ask suppresses inherited startup hooks without touching the parent binding", () => {
  const f = fixture();
  try {
    const registry = join(f.dir, ".tap/team-registry.json");
    mkdirSync(join(f.dir, ".tap/bus"), {recursive:true});
    const original = JSON.stringify({schema:"0.20",team:{name:"parent",worktree_root:f.dir},seats:{parent:{harness:"codex",harness_session_id:"parent-thread",pane_id:"%1",instance:"kept"}}});
    writeFileSync(registry, original);
    writeFileSync(join(f.env.TAP_INDEX_HOME!, "global-registry.json"), JSON.stringify({schema:"0.20",teams:{parent:{root:f.dir,registry_location:registry,state:"registered"}}}));
    writeFileSync(join(f.dir, "bin/cursor-agent"), `#!${process.execPath}
import {spawnSync} from "node:child_process";
const payload=JSON.stringify({session_id:"child-review",source:"startup",cwd:process.cwd(),workspace_roots:[process.cwd()]});
const results=["claude","cursor","codex","context"].map(mode=>spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(join(root,"runtime/bun/src/session-start.ts"))},mode,process.cwd()],{input:payload,encoding:"utf8",env:{...process.env,CLAUDE_PROJECT_DIR:process.cwd()}}));
console.log(JSON.stringify({stateless:process.env.TAP_STATELESS,hooks:results.map(r=>({code:r.status,out:r.stdout,err:r.stderr}))}));
`, {mode:0o755});
    const r = run(f, ["ask","cursor","-m","review"], doors.main, {TAP_STATELESS:"0"});
    expect(r.status,r.stderr).toBe(0);
    const result=JSON.parse(r.stdout);
    expect(result.hooks).toEqual(Array(4).fill({code:0,out:"",err:""}));
    expect(result.stateless).toBe("1");
    expect(readFileSync(registry,"utf8")).toBe(original);
  } finally { f.close(); }
});

// tap-9eaa9: an ask child is a stateless one-shot. Its environment carries none of the invoker's
// harness identity or tmux pane pins, and the router refuses every verb but help and version,
// because self identity is also walked from the process tree's first tty (the invoking pane).
test("headless ask child carries none of the invoker's harness identity or tmux pins", () => {
  const f = fixture();
  try {
    const keys = [...INHERITED_IDENTITY_ENV, "TMUX", "TMUX_PANE"];
    writeFileSync(join(f.dir, "bin/claude"), `#!/bin/bash
cat >/dev/null
for key in ${keys.join(" ")} TAP_STATELESS; do printf '%s=%s\\n' "$key" "${'${!key-absent}'}"; done > "$ASK_CAPTURE/seen"
printf 'answer\\n'
`, { mode: 0o755 });
    const decoys = Object.fromEntries(keys.map(key => [key, `foreign-${key}`]));
    expect(run(f, ["ask", "claude", "-m", "prompt"], doors.main, decoys).status).toBe(0);
    expect(Object.fromEntries(readFileSync(join(f.dir, "seen"), "utf8").trim().split("\n").map(line => line.split("=") as [string, string])))
      .toEqual({ ...Object.fromEntries(keys.map(key => [key, "absent"])), TAP_STATELESS: "1" });
  } finally { f.close(); }
});

test("router refuses every verb but help in a stateless child, with no effects", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.env.TAP_INDEX_HOME!, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
    const before = snapshot(f.dir);
    const verbs = [["whoami"], ["reply", "some-message-id"], ["send", "somebody", "hi"], ["definitely-not-a-verb"], ["version"], ["--version"]];
    for (const argv of verbs) {
      const refused = run(f, argv, doors.bin, { TAP_STATELESS: "1" });
      expect(refused.status, `${argv[0]}: ${refused.stderr}`).not.toBe(0);
      expect(refused.stderr).toContain(`cannot run ${argv[0]}`);
      const json = run(f, [...argv, "--json"], doors.bin, { TAP_STATELESS: "1" });
      expect(json.status).not.toBe(0);
      expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, error_class: "stateless_child" });
    }
    expect(snapshot(f.dir)).toEqual(before);
    // help stays available, and the same verb outside a stateless child is not this refusal.
    for (const argv of [["--help"], ["help"], ["whoami", "--help"], ["-h", "ask"], ["--help", "ask"], ["help", "ask"], []]) {
      const help = run(f, argv, doors.bin, { TAP_STATELESS: "1" });
      expect(help.status, `${argv.join(" ")}: ${help.stderr}`).toBe(0);
      expect(help.stdout).not.toBe("");
    }
    expect(snapshot(f.dir)).toEqual(before);
    expect(run(f, ["whoami"], doors.bin, { TAP_STATELESS: "0" }).stderr).not.toContain("stateless");
  } finally { f.close(); }
}, 30000);

// A stateless child's other doors: bin/tap's debug routes exec their own entry points (recorder
// config, `debug off`), and help still passed through the public-command journal and its
// machine-index read. Recording is ENABLED here, so a leak is a state change, not silence.
test("stateless child reaches neither the debug recorder nor the command journal", () => {
  const f = fixture();
  try {
    const debug = join(f.env.TAP_INDEX_HOME!, "debug"), recording = join(debug, "capture");
    mkdirSync(recording, { recursive: true });
    writeFileSync(join(f.env.TAP_INDEX_HOME!, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
    writeFileSync(join(debug, "enabled.json"), JSON.stringify({ id: "ask-test", directory: recording }));
    writeFileSync(join(debug, "config.json"), JSON.stringify({ max_mb: 5 }));
    const before = snapshot(f.dir);
    const stateless = { TAP_STATELESS: "1" };
    for (const argv of [["debug", "off"], ["debug", "config", "--max-mb", "123"], ["-v", "debug", "off"], ["debug", "recovery"], ["debug", "_attempt", "x"], ["debug", "--help"]]) {
      const refused = run(f, argv, doors.bin, stateless);
      expect(refused.status, `${argv.join(" ")}: ${refused.stdout}${refused.stderr}`).not.toBe(0);
      expect(refused.stderr, argv.join(" ")).toContain("cannot run debug");
      expect(JSON.parse(run(f, [...argv, "--json"], doors.bin, stateless).stdout)).toMatchObject({ ok: false, error_class: "stateless_child" });
    }
    // `help debug` has no static page in the router (its pointer message is the incumbent answer): it
    // may print, but it must leave the recorder alone.
    run(f, ["help", "debug"], doors.bin, stateless);
    for (const argv of [["help"], ["--help"], ["whoami", "--help"], []]) {
      const help = run(f, argv, doors.bin, stateless);
      expect(help.status, `${argv.join(" ")}: ${help.stderr}`).toBe(0);
      expect(help.stdout, argv.join(" ")).not.toBe("");
    }
    expect(snapshot(f.dir)).toEqual(before);
    // Control: the same recording journals an ordinary help call, so the assertions above can fail.
    expect(run(f, ["help"], doors.bin).status).toBe(0);
    expect(existsSync(join(recording, "events.jsonl"))).toBe(true);
  } finally { f.close(); }
}, 30000);

// tap-9eaa9: the identity scrub must not hide a preset's explicit override from its notice; the
// collision is judged against the ambient value the caller had, not the scrubbed copy.
test("a preset that declares an identity key still reports overriding the ambient one", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, "config/tap/config.toml"), `version = 4
[presets.ident]
harness="claude"
env.CLAUDE_CODE_SESSION_ID="declared-id"
`);
    writeFileSync(join(f.dir, "bin/claude"), `#!/bin/bash
cat >/dev/null
printf '%s' "\${CLAUDE_CODE_SESSION_ID-absent}" > "$ASK_CAPTURE/seen-id"
printf 'answer\n'
`, { mode: 0o755 });
    const r = run(f, ["ask", "--preset=ident", "-m", "x"], doors.bin, { CLAUDE_CODE_SESSION_ID: "ambient-id" });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(f.dir, "seen-id"), "utf8")).toBe("declared-id");
    expect(r.stderr.match(/overriding ambient ENV var CLAUDE_CODE_SESSION_ID/g)?.length).toBe(1);
    expect(r.stderr).not.toContain("ambient-id"); expect(r.stderr).not.toContain("declared-id");
    // No ambient value, no notice: the scrub is not a collision.
    const quiet = run(f, ["ask", "--preset=ident", "-m", "x"], doors.bin);
    expect(quiet.stderr).not.toContain("overriding");
  } finally { f.close(); }
});
