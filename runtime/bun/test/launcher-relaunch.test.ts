import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { census, classify, cmdSessionRelaunch, parseOptions, relaunch, type Member } from "../src/launcher/relaunch";
import { prepareRelaunch, relaunchOne } from "../src/launcher/relaunch-durable";
import { loadGlobalRegistry } from "../src/index-home";
import { lookupHelp } from "../src/help";
import { removeScratchTree } from "./support/scratch";

const root = resolve(import.meta.dir, "../../..");
const scratch: string[] = [];
let savedEnv: NodeJS.ProcessEnv | undefined;
afterEach(() => {
  if (savedEnv) { for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]; Object.assign(process.env, savedEnv); savedEnv = undefined; }
  for (const dir of scratch.splice(0)) removeScratchTree(dir);
});
function fixture({ includeOpencode = false }: { includeOpencode?: boolean } = {}) {
  // A test may build two fixtures; keep the pristine env from the first so afterEach restores it, not the first fixture's pins.
  savedEnv ??= { ...process.env };
  const dir = mkdtempSync(join(tmpdir(), "tap-relaunch.")); scratch.push(dir);
  const bin = join(dir, "bin"), index = join(dir, "index"), home = join(dir, "home");
  for (const path of [bin, index, home]) mkdirSync(path);
  const extraSession = includeOpencode ? "tap/opencode\\t1:1\\t1\\nother/opencode\\t1:1\\t1\\n" : "";
  const extraPane = includeOpencode ? "tap/opencode\\ttap/opencode:0.0\\t%%9\\topencode\\t125\\t1:1\\t0\\nother/opencode\\tother/opencode:0.0\\t%%10\\topencode\\t126\\t1:1\\t0\\n" : "";
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
list-sessions) printf 'tap/alice\\t1:1\\t1\\nother/alice\\t1:1\\t1\\n'; printf '${extraSession}' ;;
list-panes) printf 'tap/alice\\ttap/alice:0.0\\t%%7\\tcodex\\t123\\t1:1\\t0\\nother/alice\\tother/alice:0.0\\t%%8\\tcodex\\t124\\t1:1\\t0\\n'; printf '${extraPane}' ;;
*) exit 1 ;;
esac
`, { mode: 0o755 });
  Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, HOME: home, TAP_INDEX_HOME: index,
    TAP_SERVER_EPOCH: "srv:1:1", TAP_BOOT_ID: "bootuuid:00000000-0000-0000-0000-000000000001",
    TAP_BOOT_ID_LEGACY: "boot:1", TAP_TMUX_SOCKET: "isolated-relaunch", TAP_WATCH_NOW: "1787790000" });
  for (const key of ["TMUX", "TMUX_PANE", "TAP_HOME", "TAP_SELF", "TAP_VERBOSE", "TAP_JSON", "NO_COLOR"]) delete process.env[key];
  const row = (team: string, pane: string) => ({ status: "active", delivery: "pane", harness: "codex", pane_id: pane,
    pane: `${team}/alice:0.0`, session: `${team}/alice`, server_epoch: "srv:1:1", harness_session_id: `${team}-conversation` });
  const seats = { alice: row("tap", "%7"), ...(includeOpencode ? { opencode: { ...row("tap", "%9"), harness: "opencode", pane: "tap/opencode:0.0", session: "tap/opencode", harness_session_id: "tap-opencode-conversation" } } : {}), offline: { ...row("tap", "%90"), session: "tap/offline", pane: "tap/offline:0.0" },
    suspended: { ...row("tap", "%7"), status: "suspended", status_reason: "session_stopped" },
    poll: { ...row("tap", "%7"), delivery: "poll" }, crew: { ...row("tap", "%7"), crew: true },
    unknown: { ...row("tap", "%7"), harness: null }, foreign: { ...row("tap", "%7"), harness: "claude" } };
  const registry = join(dir, "tap.json"), otherRegistry = join(dir, "other.json");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "tap", root: dir }, seats }));
  writeFileSync(otherRegistry, JSON.stringify({ schema: "0.20", team: { name: "other", root: dir }, seats: {
    alice: row("other", "%8"),
    // A real foreign opencode seat: a codex-only foreign roster cannot prove
    // the worker path a `--team='*'` opencode instruction must reach.
    ...(includeOpencode ? { opencode: { ...row("other", "%10"), harness: "opencode", pane: "other/opencode:0.0", session: "other/opencode", harness_session_id: "other-opencode-conversation" } } : {}),
  } }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    tap: { root: dir, registry_location: registry }, other: { root: dir, registry_location: otherRegistry }, missing: { root: dir, registry_location: join(dir, "absent.json") },
  } }));
  const acted: Member[] = [], output: string[] = [], crewActed: { member: Member; callerPane: string; dryRun: boolean }[] = [];
  let caller = "", failure = "";
  const deps = { classify, load: loadGlobalRegistry, color: false, write: (text: string) => { output.push(text); },
    crew: async (member: Member, callerPane: string, options: { dryRun: boolean }) => {
      crewActed.push({ member, callerPane, dryRun: options.dryRun });
      return member.team === failure ? { code: 1, reason: "crew pane %7 is not live; next: tap crew shutdown tap/crew" } : { code: 0 };
    },
    context: () => ({ team: "tap", caller_pane: caller, caller: { state: "outside" as const, detail: "test caller" } }),
    prepare: prepareRelaunch,
    run: async (member: Member, options: { dryRun: boolean }) => {
      // The summary must precede every possible replacement effect.
      if (!options.dryRun && output.length) expect(output[0]).toStartWith("Relaunching");
      acted.push(member);
      return { code: member.team === failure ? 7 : 0, stdout: "respawned; waiting\nresumed in place · id=conversation · 1.2s\n",
        stderr: member.team === failure ? "intended harness not observable\nlong diagnostic" : "overriding ambient ENV var FOO\n", elapsed: 1.2 };
    } };
  return { dir, registry, deps, output, acted, crewActed, caller: (v: string) => { caller = v; }, failure: (v: string) => { failure = v; } };
}

test("mixed roster uses the real team classifier and only active matching seats reach replacement", async () => {
  const f = fixture();
  expect(await relaunch(parseOptions(["--harness", "codex", "--team", "*"]), f.deps)).toBe(0);
  expect(f.output[0]).toBe("Relaunching 3 active codex seats on all teams\n");
  expect(f.output.slice(1).sort()).toEqual(["● other/alice\n", "● tap/alice\n", "● tap/crew\n"]);
  // Durable seats go to the native resume core; the live crew row never does.
  expect(f.acted.map(m => `${m.team}/${m.handle}`)).toEqual(["other/alice", "tap/alice"]);
  expect(f.crewActed.map(c => `${c.member.team}/${c.member.handle}:${c.dryRun}`)).toEqual(["tap/crew:false"]);
  expect(f.acted[1]!.expect_resume).toBe("tap-conversation");
  expect(f.acted[1]!.expect).toEqual({ pane_id: "%7", harness: "codex", harness_session_id: "tap-conversation", launch_workdir: null });
});

test("opencode batch selection reaches opencode and excludes codex by harness", async () => {
  const f = fixture({ includeOpencode: true });
  expect(await relaunch(parseOptions(["--harness", "opencode", "--team", "tap", "--dry-run", "--json"]), f.deps)).toBe(0);
  const data = JSON.parse(f.output.join(""));
  expect(data.candidates).toBe(1);
  expect(data.results).toEqual([expect.objectContaining({ team: "tap", handle: "opencode", status: "would-resume" })]);
  expect(data.excluded_inactive).toContainEqual({ team: "tap", handle: "alice", reason: "harness mismatch" });
  expect(f.acted.map(m => `${m.team}/${m.handle}`)).toEqual(["tap/opencode"]);
});

test("live opencode batch instructions reach the selected seats on their own teams", async () => {
  // tap-74h2l: the courier addresses `<team>/<handle>`, so a foreign
  // named-team scope and the machine-wide form proceed through census and
  // hand the instruction to each selected opencode seat's worker.
  const f = fixture({ includeOpencode: true });
  const runs: { member: Member; message?: string }[] = [];
  const deps = { ...f.deps, run: async (member: Member, options: ReturnType<typeof parseOptions>) => {
    runs.push({ member, message: options.message });
    return f.deps.run(member, options);
  } };
  for (const team of ["other", "*"]) {
    runs.length = 0;
    f.acted.length = 0;
    expect(await relaunch(parseOptions(["--harness", "opencode", "--team", team, "-m", "hello"]), deps)).toBe(0);
    expect(runs.map(r => `${r.member.team}/${r.member.handle}`))
      .toEqual(team === "other" ? ["other/opencode"] : ["other/opencode", "tap/opencode"]);
    expect(runs.every(r => r.message === "hello")).toBe(true);
  }
});

test("same-team opencode batch instruction still reaches the live worker", async () => {
  const f = fixture({ includeOpencode: true });
  expect(await relaunch(parseOptions(["--harness", "opencode", "--team", "tap", "-m", "hello", "--dry-run", "--json"]), f.deps)).toBe(0);
  expect(f.acted.map(m => `${m.team}/${m.handle}`)).toEqual(["tap/opencode"]);
});

test("JSON retains every exclusion, missing team, worker detail and additive counts", async () => {
  const f = fixture();
  expect(await relaunch(parseOptions(["--harness=codex", "--team=*", "--json"]), f.deps)).toBe(0);
  const data = JSON.parse(f.output.join(""));
  expect(data.candidates).toBe(3);
  expect(data.results.map((r: any) => [r.team, r.handle, r.status, r.code])).toEqual([
    ["other", "alice", "resumed", 0], ["tap", "alice", "resumed", 0], ["tap", "crew", "replaced", 0],
  ]);
  expect(data.counts).toEqual({ candidates: 3, excluded_inactive: 5, skipped_teams: 1, excluded_caller: 0 });
  expect(data.excluded_inactive.map((v: any) => v.handle).sort()).toEqual(["foreign", "offline", "poll", "suspended", "unknown"]);
  expect(data.results.find((r: any) => r.handle === "crew")).toEqual(expect.objectContaining({ team: "tap", status: "replaced", code: 0 }));
  expect(data.excluded_inactive.every((v: any) => v.reason)).toBe(true);
  expect(data.skipped_teams[0].team).toBe("missing");
  expect(data.results[0].stdout).toContain("waiting");
  expect(data.results[0].stderr).toContain("ENV");
});

test("scope defaults to current team; failed candidate is red and every candidate still runs", async () => {
  const f = fixture(); f.failure("tap"); f.deps.color = true;
  expect(await relaunch(parseOptions(["--harness", "codex", "--team", "*"]), f.deps)).toBe(1);
  expect(f.output[0]).toBe("Relaunching 3 active codex seats on all teams\n");
  // A failed crew replacement keeps its row and reports the reason; it is never a resume.
  expect(f.output.slice(1).sort()).toEqual([
    "\x1b[32m●\x1b[0m other/alice\n",
    "\x1b[31m●\x1b[0m tap/alice — intended harness not observable long diagnostic\n",
    "\x1b[31m●\x1b[0m tap/crew — crew pane %7 is not live; next: tap crew shutdown tap/crew\n",
  ].sort());
  expect(f.acted).toHaveLength(2);
  expect(f.crewActed).toHaveLength(1);
});

test("caller is excluded and inactive explicit seat is a quiet no-op", async () => {
  const f = fixture(); f.caller("%7");
  expect(await relaunch(parseOptions(["--harness", "codex"]), f.deps)).toBe(0);
  expect(f.output.join("")).toBe("No active codex seats on team tap; nothing to relaunch.\n");
  f.output.length = 0;
  expect(await relaunch(parseOptions(["tap/offline"]), f.deps)).toBe(0);
  expect(f.output.join("")).toBe("No active seats on team tap; nothing to relaunch.\n");
  expect(f.acted).toHaveLength(0);
});

test("missing registry is silent with success; empty scope never widens", async () => {
  const f = fixture();
  expect(await relaunch(parseOptions(["--harness", "codex", "--team", "missing"]), f.deps)).toBe(0);
  expect(f.output.join("")).toBe("No active codex seats on team missing; nothing to relaunch.\n");
  expect(() => parseOptions(["--harness", "codex", "--team", " "])).toThrow("empty --team");
  expect(f.acted).toHaveLength(0);
});

test("dry run never claims readiness and retains invocation in JSON", async () => {
  const f = fixture();
  expect(await relaunch(parseOptions(["tap/alice", "--dry-run"]), f.deps)).toBe(0);
  expect(f.output[0]).toBe("Would relaunch 1 active seats on team tap\n");
});

test("the native relaunch entry stays quiet and active-only on every launcher pin, even with diagnostics verbosity", () => {
  const f = fixture();
  for (const launcher of ["python", "bun"]) {
    const result = spawnSync("bun", [join(root, "runtime/bun/src/launcher/relaunch.ts"), "--harness", "codex", "--team", "missing"], {
      env: { ...process.env, TAP_LAUNCHER: launcher, TAP_VERBOSE: "1" }, encoding: "utf8", cwd: f.dir,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("No active codex seats on team missing; nothing to relaunch.\n");
    expect(result.stderr).toBe("");
  }
});



test("one resume-preparation failure does not strand healthy siblings", async () => {
  const f = fixture();
  const deps = { ...f.deps, prepare: (members: Member[]) => {
    const result = prepareRelaunch(members);
    result[0] = { ...result[0]!, prepare_error: "transcript unreadable" };
    return result;
  } };
  expect(await relaunch(parseOptions(["--harness", "codex", "--team", "*"]), deps)).toBe(1);
  expect(f.output[0]).toBe("Relaunching 3 active codex seats on all teams\n");
  expect(f.output.slice(1).sort()).toEqual(["● other/alice — transcript unreadable\n", "● tap/alice\n", "● tap/crew\n"]);
  expect(f.acted.map(m => m.team)).toEqual(["tap"]);
});


test("installed entry shows its phase before one red refusal without diagnostic chatter", () => {
  const f = fixture();
  // The census sees a live codex pane; the fake tmux refuses the worker's
  // point-of-effect observation. No real harness or operator server is touched.
  const result = spawnSync(join(root, "bin/tap"), ["session", "relaunch", "tap/alice"], {
    env: process.env, encoding: "utf8", cwd: f.dir,
  });
  expect(result.status).toBe(1);
  expect(result.stdout.split("\n")).toHaveLength(4);
  expect(result.stdout).toStartWith("Relaunching 1 active seats on team tap\n  tap/alice: checking target and resume identity\n● tap/alice — ");
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toContain("ENV");
});


test("NO_COLOR presence disables result colors, including an empty value", async () => {
  const f = fixture(); f.deps.color = true; process.env.NO_COLOR = "";
  expect(await relaunch(parseOptions(["tap/alice"]), f.deps)).toBe(0);
  expect(f.output.join("")).not.toContain("\x1b[");
  expect(f.output[1]).toBe("● tap/alice\n");
});

test("unknown exact handle refuses with roster guidance in human and JSON modes", () => {
  const f = fixture();
  for (const json of [false, true]) {
    const result = spawnSync(join(root, "bin/tap"), ["session", "relaunch", "tap/typo", ...(json ? ["--json"] : [])], {
      env: process.env, encoding: "utf8", cwd: f.dir,
    });
    expect(result.status).toBe(1);
    if (json) {
      const data = JSON.parse(result.stdout);
      expect(data.error_class).toBe("unknown_seat");
      expect(data.action).toBe("tap team roster tap");
      expect(result.stderr).toBe("");
    } else {
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("tap team roster tap");
    }
  }
  expect(f.acted).toHaveLength(0);
});

test("JSON retains excluded callers even with zero candidates", async () => {
  const f = fixture(); f.caller("%7");
  expect(await relaunch(parseOptions(["--harness", "codex", "--json"]), f.deps)).toBe(0);
  // The crew row shares the caller's pane, so it is the same caller exclusion.
  const data = JSON.parse(f.output.join(""));
  expect(data.candidates).toBe(0);
  expect(data.results).toEqual([]);
  expect(data.excluded_caller).toEqual([
    { team: "tap", handle: "alice", reason: "caller-pane" },
    { team: "tap", handle: "crew", reason: "caller-pane" },
  ]);
  expect(data.counts.excluded_caller).toBe(2);
  expect(f.crewActed).toHaveLength(0);
});


test("bare handles resolve on the current team and forward overrides to the worker", async () => {
  const f = fixture();
  const calls: ReturnType<typeof parseOptions>[] = [];
  const original = f.deps.run;
  const deps = { ...f.deps, run: async (member: Member, options: ReturnType<typeof parseOptions>) => { calls.push(options); return original(member, options); } };
  const options = parseOptions(["alice", "--unset-env", "WINDOW", "--", "-c", "model_context_window=250000"]);
  expect(await relaunch(options, deps)).toBe(0);
  expect(f.acted.map(m => `${m.team}/${m.handle}`)).toEqual(["tap/alice"]);
  expect(calls[0]?.overrides).toEqual(options.overrides);
});

test("child --json stays opaque when relaunch fails before replacement", () => {
  const f = fixture();
  for (const [own, environmentJson] of [[false, false], [true, false], [false, true]]) {
    const result = spawnSync(join(root, "bin/tap"), ["session", "relaunch", "tap/missing",
      ...(own ? ["--json"] : []), "--", "--json"], {
      cwd: f.dir, env: { ...process.env, TAP_JSON: environmentJson ? "1" : "0" }, encoding: "utf8",
    });
    expect(result.status).toBe(1);
    if (own || environmentJson) {
      expect(JSON.parse(result.stdout).error_class).toBe("unknown_seat");
      expect(result.stderr).toBe("");
    } else {
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("tap session relaunch: seat 'tap/missing' is not registered");
    }
  }
});

test("crew dry run reports would-replace, never resume, and passes the one caller pane", async () => {
  const f = fixture(); f.caller("%99");
  expect(await relaunch(parseOptions(["tap/crew", "--dry-run", "--json"]), f.deps)).toBe(0);
  const data = JSON.parse(f.output.join(""));
  expect(data.results).toEqual([expect.objectContaining({ team: "tap", handle: "crew", status: "would-replace" })]);
  expect(f.acted).toHaveLength(0);
  expect(f.crewActed).toEqual([expect.objectContaining({ callerPane: "%99", dryRun: true })]);
});

test("census validates row shape and team format before harness filtering", () => {
  const teams = { demo: { root: "/demo", registry_location: "/demo/registry" } };
  const options = parseOptions(["--harness", "codex", "--team", "demo"]);
  const current = census(options, "demo", teams, () => ({ schema: "0.20", team: { name: "demo" }, seats: {
    malformed: null, unknown: { harness: "invented" }, other: { harness: "claude" },
  } }));
  expect(current.excluded_inactive).toEqual([
    { team: "demo", handle: "malformed", reason: "invalid seat row" },
    { team: "demo", handle: "other", reason: "harness mismatch" },
    { team: "demo", handle: "unknown", reason: "unknown harness" },
  ]);
  const old = census(options, "demo", teams, () => ({ schema: "0.20", agents: { irrelevant: { harness: "claude" } } }));
  expect(old.members).toHaveLength(0); expect(old.skipped_teams[0]!.reason).toStartWith("old_store:");
});

test("census skips a registry with invalid UTF-8 or a leading BOM instead of relaunching from mangled bytes", () => {
  // `readFileSync(path, "utf8")` turns 0xE9 into U+FFFD without throwing, so this registry parsed and
  // its seats were relaunched. Salvaged from a closed review branch.
  const dir = mkdtempSync(join(tmpdir(), "tap-relaunch-bytes.")); scratch.push(dir);
  const seats = JSON.stringify({ alpha: { harness: "claude", status: "active", delivery: "pane", pane_id: "%1" } });
  const registries = {
    invalid: Buffer.concat([Buffer.from('{"schema":"0.20","team":{"name":"caf'), Buffer.from([0xe9]), Buffer.from(`"},"seats":${seats}}`)]),
    bom: Buffer.from(`﻿{"schema":"0.20","seats":${seats}}`, "utf8"),
    clean: Buffer.from(`{"schema":"0.20","seats":${seats}}`, "utf8"),
  };
  const teams: Record<string, unknown> = {};
  for (const [team, bytes] of Object.entries(registries)) {
    const file = join(dir, `${team}.json`); writeFileSync(file, bytes);
    teams[team] = { root: dir, registry_location: file, state: "active" };
  }
  const got = census(parseOptions(["--harness", "claude", "--team", "*"]), "*", teams);
  expect(got.skipped_teams.map(s => s.team)).toEqual(["bom", "invalid"]);
  for (const skip of got.skipped_teams) expect(skip.reason).toStartWith("registry unreadable:");
  // Positive control: the same seats without the bad bytes are read, so the skips are about the bytes.
  expect(got.members.map(m => `${m.team}/${m.handle}`)).toEqual(["clean/alpha"]);
});

for (const json of [false, true]) test(`completed members report before a pending sibling; JSON=${json} retains its final receipt`, async () => {
  const f = fixture();
  const options = parseOptions(["--harness", "codex", "--team", "*", ...(json ? ["--json"] : [])]);
  await relaunch(options, f.deps);
  const baseline = f.output.join("");
  f.output.length = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const command = relaunch(options, { ...f.deps, run: async (member, opts) => {
    if (member.team === "other") await pending;
    return f.deps.run(member, opts);
  } });
  try {
    await Bun.sleep(0); // Drain ready continuations; the latch keeps other/alice pending.
    if (json) expect(f.output).toEqual([]);
    else {
      expect(f.output.join("")).toContain("● tap/alice\n");
      expect(f.output.join("")).toContain("● tap/crew\n");
      expect(f.output.join("")).not.toContain("● other/alice\n");
    }
  } finally { release(); await command; }
  if (json) {
    expect(f.output).toHaveLength(1);
    expect(f.output[0]).toBe(baseline); // Same bytes and census order despite different completion order.
  } else {
    expect(f.output.at(-1)).toBe("● other/alice\n");
    expect(f.output).toHaveLength(4);
  }
});

for (const json of [false, true]) test(`in-flight replacement phases are visible without breaking JSON=${json}`, async () => {
  const f = fixture();
  const options = parseOptions(["tap/alice", ...(json ? ["--json"] : [])]);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const command = relaunch(options, { ...f.deps, run: async (member, opts, _caller, control) => {
    control?.progress?.("respawn attempted; observing startup for up to 45s");
    await pending;
    return f.deps.run(member, opts);
  } });
  try {
    await Bun.sleep(0);
    if (json) expect(f.output).toEqual([]);
    else expect(f.output.join("")).toContain("respawn attempted; observing startup for up to 45s");
  } finally { release(); await command; }
  if (json) expect(JSON.parse(f.output.join("")).ok).toBe(true);
});

test("cancellation before a member starts returns one JSON receipt without replacement", async () => {
  const f = fixture();
  const controller = new AbortController();
  const { LaunchInterrupted } = await import("../src/launcher/transaction");
  controller.abort(new LaunchInterrupted(130));
  expect(await relaunch(parseOptions(["tap/alice", "--json"]), f.deps, controller.signal)).toBe(130);
  const receipt = JSON.parse(f.output.join(""));
  expect(receipt.code).toBe(130);
  expect(receipt.results[0].reason).toContain("nothing was replaced");
  expect(f.acted).toHaveLength(0);
});

test("session relaunch passes cancellation to the crew path", async () => {
  const f = fixture(), controller = new AbortController();
  let received: AbortSignal | undefined;
  const code = await relaunch(parseOptions(["tap/crew", "--json"]), { ...f.deps,
    crew: async (_member, _caller, _options, signal) => {
      received = signal;
      controller.abort();
      return { code: 130, reason: "interrupted after respawn was attempted; replacement state unverified" };
    },
  }, controller.signal);
  expect(received).toBe(controller.signal);
  expect(code).toBe(130);
  expect(JSON.parse(f.output.join("")).results[0].status).toBe("failed");
});

test("crew progress is streamed only in human mode", async () => {
  for (const json of [false, true]) {
    const f = fixture();
    const code = await relaunch(parseOptions(["tap/crew", ...(json ? ["--json"] : [])]), { ...f.deps,
      crew: async (_member, _caller, _options, _signal, progress) => {
        progress?.("observing crew startup");
        return { code: 0 };
      },
    });
    expect(code).toBe(0);
    expect(f.output.join("").includes("observing crew startup")).toBe(!json);
    if (json) expect(JSON.parse(f.output.join("")).results).toHaveLength(1);
  }
});

for (const json of [false, true]) test(`failure receipts retain cleanup evidence beyond a short label: json=${json}`, async () => {
  const f = fixture();
  const reason = "interrupted after respawn was attempted; replacement state unverified; clear expectation cleanup unverified; remain-on-exit may be on; no retry performed";
  await relaunch(parseOptions(["tap/alice", ...(json ? ["--json"] : [])]), { ...f.deps, run: async () => ({ code: 130, reason }) });
  const output = f.output.join("");
  expect(output).toContain(reason);
  if (json) expect(JSON.parse(output).results[0].reason).toBe(reason);
});

for (const json of [false, true]) test(`successful replacement surfaces cleanup warnings: json=${json}`, async () => {
  const f = fixture(), warning = "tap session relaunch: WARNING: remain-on-exit cleanup unverified; the option may still be on";
  const code = await relaunch(parseOptions(["tap/alice", ...(json ? ["--json"] : [])]), { ...f.deps,
    run: async () => ({ code: 0, stderr: warning }) });
  expect(code).toBe(0);
  const output = f.output.join("");
  expect(output).toContain(warning);
  if (json) expect(JSON.parse(output).results[0].stderr).toBe(warning);
});

test("relaunch's receipt reaches the opt-in diagnostics log as structured verdicts only (tap-7r3fn.152.1)", async () => {
  const f = fixture();
  const xdg = join(f.dir, "xdg"), config = join(xdg, "tap"), log = join(f.dir, "index/logs/launch-debug.jsonl");
  mkdirSync(config, { recursive: true }); process.env.XDG_CONFIG_HOME = xdg;
  // A team whose registry is unreadable at a path carrying private text: the census keeps the raw reader error.
  const index = join(f.dir, "index/global-registry.json"), global = JSON.parse(readFileSync(index, "utf8"));
  global.teams.leaky = { root: f.dir, registry_location: join(f.dir, "PRIVATE-READER-TEXT.json") };
  writeFileSync(index, JSON.stringify(global));
  // The worker streams carry the dry-run invocation and a failing worker's free text; none may reach the log.
  const deps = { ...f.deps, run: async (member: Member) => member.team === "other"
    ? { code: 1, elapsed: 0.5, error_class: "session_error", reason: "bare PRIVATE-REASON-TEXT", stderr: "PRIVATE-STDERR-TEXT\n", stdout: "" }
    : { code: 0, elapsed: 0.5, stderr: "overriding ambient ENV var API_TOKEN=hunter2\n", stdout: `claude -p SECRET-PROMPT API_TOKEN=hunter2 --resume ${member.handle}\n` } };
  const argv = ["--harness", "codex", "--team", "*", "--dry-run"];
  // --json exports TAP_JSON for the rest of the process; each round starts without it.
  const round = async (json: boolean) => { f.output.length = 0; delete process.env.TAP_JSON; const code = await relaunch(parseOptions(json ? [...argv, "--json"] : argv), deps); return { code, out: f.output.join("") }; };

  const off = await round(false), offJson = await round(true);
  expect(existsSync(log)).toBe(false); // diagnostics are off by default: no log at all
  // The console and the JSON receipt stay complete: they DO carry the planted text, which proves the plants are live.
  expect(off.out).toContain("PRIVATE-REASON-TEXT"); expect(offJson.out).toContain("PRIVATE-READER-TEXT"); expect(offJson.out).toContain("PRIVATE-STDERR-TEXT");

  writeFileSync(join(config, "config.toml"), '[diagnostics]\nlevel="verbose"\n');
  expect(await round(false)).toEqual(off); // console bytes unchanged
  expect(await round(true)).toEqual(offJson); // JSON unchanged

  const text = readFileSync(log, "utf8");
  for (const planted of ["SECRET-PROMPT", "hunter2", "PRIVATE-REASON-TEXT", "PRIVATE-STDERR-TEXT", "PRIVATE-READER-TEXT"]) expect(text).not.toContain(planted);
  const all = text.trim().split("\n").map(line => JSON.parse(line));
  const of = (event: string) => all.filter(row => row.event === event);
  const rows = of("relaunch");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ team: "*", harness: "codex", dry_run: true, ok: false, code: 1 });
  const results = of("relaunch_result").slice(0, rows[0].counts.candidates);
  expect(results).toEqual(expect.arrayContaining([
    expect.objectContaining({ team: "tap", handle: "alice", status: "would-resume", code: 0 }),
    expect.objectContaining({ team: "other", handle: "alice", status: "failed", code: 1, error_class: "session_error" }),
  ]));
  for (const row of all) { expect(row.stdout).toBeUndefined(); expect(row.stderr).toBeUndefined(); expect(row.reason).toBeUndefined(); }
  expect(of("relaunch_excluded").length).toBeGreaterThan(0);
  expect(of("relaunch_skipped_team").map(row => row.team)).toEqual(expect.arrayContaining(["leaky", "missing"]));
});

test("a machine-wide relaunch logs every result, exclusion and bypassed team past the writer's 20-entry and 4096-byte bounds", async () => {
  const f = fixture();
  const xdg = join(f.dir, "xdg"), config = join(xdg, "tap"), log = join(f.dir, "index/logs/launch-debug.jsonl");
  mkdirSync(config, { recursive: true }); process.env.XDG_CONFIG_HOME = xdg;
  writeFileSync(join(config, "config.toml"), '[diagnostics]\nlevel="verbose"\n');
  const index = join(f.dir, "index/global-registry.json"), global = JSON.parse(readFileSync(index, "utf8")); global.teams = {};
  const seat = { status: "active", delivery: "pane", harness: "codex", pane_id: "%7", session: "t/alice", server_epoch: "srv:1:1", harness_session_id: "c" };
  const N = 25;
  for (let i = 0; i < N; i++) {
    const team = `t${String(i).padStart(2, "0")}`, registry = join(f.dir, `${team}.json`);
    writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: team, root: f.dir }, seats: { alice: seat, bob: { ...seat, delivery: "poll" } } }));
    global.teams[team] = { root: f.dir, registry_location: registry };
    global.teams[`gone${String(i).padStart(2, "0")}`] = { root: f.dir, registry_location: join(f.dir, `absent${i}.json`) };
  }
  writeFileSync(index, JSON.stringify(global));
  const deps = { ...f.deps,
    context: () => ({ team: "t00", caller_pane: "%caller", caller: { state: "outside" as const, detail: "test caller" } }),
    classify: (members: Member[]) => members.map(member => ({ member, status: "active", reason: "", pane: member.team === "t00" ? "%caller" : "%p" })),
    run: async (member: Member) => ({ code: 0, elapsed: 0.1, stdout: "", stderr: "", reason: "", error_class: undefined, team: member.team }) };
  expect(await relaunch(parseOptions(["--harness", "codex", "--team", "*", "--dry-run"]), deps)).toBe(0);
  const lines = readFileSync(log, "utf8").trim().split("\n");
  for (const line of lines) expect(line.length).toBeLessThan(4096);
  const rows = lines.map(line => JSON.parse(line)), of = (event: string) => rows.filter(row => row.event === event);
  expect(of("relaunch")).toHaveLength(1);
  expect(of("relaunch")[0].counts).toEqual({ candidates: N - 1, excluded_inactive: N, skipped_teams: N, excluded_caller: 1 });
  // Every entry is logged: none is lost to the writer's array cap or its per-row size bound.
  expect(of("relaunch_result")).toHaveLength(N - 1);
  expect(of("relaunch_excluded").filter(row => row.kind === "inactive")).toHaveLength(N);
  expect(of("relaunch_excluded").filter(row => row.kind === "caller")).toEqual([expect.objectContaining({ team: "t00", handle: "alice" })]);
  expect(of("relaunch_skipped_team")).toHaveLength(N);
  expect(new Set(of("relaunch_result").map(row => row.team)).size).toBe(N - 1);
});

test("parseOptions accepts --workdir for one seat and refuses it for a batch", () => {
  expect(parseOptions(["tap/alice", "--workdir", "/lane"]).workdir).toBe("/lane");
  expect(parseOptions(["tap/alice", "--workdir=/lane", "--dry-run"]).workdir).toBe("/lane");
  expect(parseOptions(["tap/alice"]).workdir).toBeUndefined();
  expect(() => parseOptions(["--harness", "codex", "--workdir", "/lane"])).toThrow("--workdir applies to a single-seat relaunch");
  expect(() => parseOptions(["tap/alice", "--workdir"])).toThrow("--workdir needs a value");
});

test("--workdir followed by another option is a usage error, never a path that swallows the option", async () => {
  expect(() => parseOptions(["tap/alice", "--workdir", "--dry-run"])).toThrow("--workdir needs a value");
  expect(() => parseOptions(["tap/alice", "--workdir", "-m", "hi"])).toThrow("--workdir needs a value");
  expect(parseOptions(["tap/alice", "--workdir=-odd", "--dry-run"])).toMatchObject({ workdir: "-odd", dryRun: true });
  // At the command: exit 2 with a usage refusal before any registry read or effect, not a live relaunch with dryRun dropped.
  const errors: string[] = [], original = console.error;
  console.error = (line: unknown) => { errors.push(String(line)); };
  try { expect(await cmdSessionRelaunch(["tap/alice", "--workdir", "--dry-run"])).toBe(2); } finally { console.error = original; }
  expect(errors.join("\n")).toContain("--workdir needs a value");
  expect(errors.join("\n")).toContain("tap help session");
});

test("a single-seat member's exit 7 is the command's exit 7, in human and JSON modes; a batch still exits 1", async () => {
  for (const json of [false, true]) {
    const f = fixture(); f.failure("tap");
    expect(spawnSync("git", ["init", "-q", f.dir]).status).toBe(0);
    f.deps.run = async () => ({ code: 7, stdout: "", stderr: "", elapsed: 0, error_class: "launch_workdir_unpersisted", reason: "x" });
    expect(await relaunch(parseOptions(["tap/alice", "--workdir", f.dir, ...(json ? ["--json"] : [])]), f.deps)).toBe(7);
    if (json) expect(JSON.parse(f.output.join("")).code).toBe(7);
  }
  // Without --workdir a single seat's member code 7 keeps the pinned exit 1 (crew-relaunch pins it).
  const noWorkdir = fixture(); noWorkdir.failure("tap");
  expect(await relaunch(parseOptions(["tap/alice"]), noWorkdir.deps)).toBe(1);
  const batch = fixture(); batch.failure("tap");
  expect(await relaunch(parseOptions(["--harness", "codex", "--team", "*"]), batch.deps)).toBe(1);
  // A failed respawn-pane hands tmux's RAW status through as tmux_error: a raw 7 failed before any effect, so it is exit 1, not "never retry".
  const rawTmux = fixture(); rawTmux.failure("tap");
  expect(spawnSync("git", ["init", "-q", rawTmux.dir]).status).toBe(0);
  rawTmux.deps.run = async () => ({ code: 7, stdout: "", stderr: "", elapsed: 0, error_class: "tmux_error", reason: "could not respawn pane" });
  expect(await relaunch(parseOptions(["tap/alice", "--workdir", rawTmux.dir]), rawTmux.deps)).toBe(1);
  // Control: a post-effect 7 of another class (registry transition after the respawn) still propagates.
  const oldStore = fixture(); oldStore.failure("tap");
  expect(spawnSync("git", ["init", "-q", oldStore.dir]).status).toBe(0);
  oldStore.deps.run = async () => ({ code: 7, stdout: "", stderr: "", elapsed: 0, error_class: "old_store", reason: "x" });
  expect(await relaunch(parseOptions(["tap/alice", "--workdir", oldStore.dir]), oldStore.deps)).toBe(7);
  // An interruption after the respawn whose required row write failed is the post-effect 7, not the signal's 130.
  const interrupted = fixture(); interrupted.failure("tap");
  expect(spawnSync("git", ["init", "-q", interrupted.dir]).status).toBe(0);
  const controller = new AbortController();
  // The signal fires while the member runs (a pre-aborted signal never starts it).
  interrupted.deps.run = async () => { controller.abort(); return { code: 7, stdout: "", stderr: "", elapsed: 0, error_class: "launch_workdir_unpersisted", reason: "x" }; };
  expect(await relaunch(parseOptions(["tap/alice", "--workdir", interrupted.dir]), interrupted.deps, controller.signal)).toBe(7);
  // Control: the same interruption without an unpersisted member keeps the signal's exit.
  const plainInterrupt = fixture(); plainInterrupt.failure("tap");
  expect(spawnSync("git", ["init", "-q", plainInterrupt.dir]).status).toBe(0);
  const controller2 = new AbortController();
  plainInterrupt.deps.run = async () => { controller2.abort(); return { code: 130, stdout: "", stderr: "", elapsed: 0, error_class: "relaunch_interrupted", reason: "x" }; };
  expect(await relaunch(parseOptions(["tap/alice", "--workdir", plainInterrupt.dir]), plainInterrupt.deps, controller2.signal)).toBe(130);
  const plain = fixture(); plain.deps.run = async () => ({ code: 3, stdout: "", stderr: "", elapsed: 0, reason: "x" });
  expect(await relaunch(parseOptions(["tap/alice"]), plain.deps)).toBe(1);
});

test("an invalid --workdir refuses before the caller or inactive exclusion can drop the seat", async () => {
  const f = fixture(); f.caller("%7");
  expect(spawnSync("git", ["init", "-q", f.dir]).status).toBe(0);
  const missing = join(f.dir, "missing");
  for (const seat of ["tap/alice", "tap/offline"]) {
    await expect(relaunch(parseOptions([seat, "--workdir", missing, "--dry-run"]), f.deps)).rejects.toMatchObject({ errorClass: "invalid_workdir" });
  }
  // Control: a valid worktree on the same excluded seats is still the quiet no-op.
  for (const seat of ["tap/alice", "tap/offline"]) {
    f.output.length = 0;
    expect(await relaunch(parseOptions([seat, "--workdir", f.dir, "--dry-run"]), f.deps)).toBe(0);
    expect(f.output.join("")).toContain("nothing to relaunch");
  }
  expect(f.acted).toHaveLength(0);
});

test("a dry run names the workdir in the human plan and the JSON receipt", async () => {
  // One fixture at a time: each pins its own TAP_INDEX_HOME.
  for (const json of [false, true]) {
    const f = fixture();
    expect(spawnSync("git", ["init", "-q", f.dir]).status).toBe(0);
    f.deps.run = async () => ({ code: 0, stdout: "cmd\n", stderr: "", elapsed: 0, workdir: f.dir });
    expect(await relaunch(parseOptions(["tap/alice", "--workdir", f.dir, "--dry-run", ...(json ? ["--json"] : [])]), f.deps)).toBe(0);
    if (json) expect(JSON.parse(f.output.join("")).results[0].workdir).toBe(f.dir);
    else expect(f.output.join("")).toContain(`would respawn in ${f.dir} and record it as launch_workdir`);
  }
});

test("an explicit --workdir refuses when the team's root cannot be proven, dry run included", async () => {
  const f = fixture();
  const index = join(f.dir, "index/global-registry.json"), global = JSON.parse(readFileSync(index, "utf8"));
  delete global.teams.tap.root; writeFileSync(index, JSON.stringify(global));
  for (const args of [["--dry-run"], []]) {
    await expect(relaunch(parseOptions(["tap/alice", "--workdir", f.dir, ...args]), f.deps)).rejects.toMatchObject({ code: 2, errorClass: "invalid_workdir" });
  }
  // Control: without --workdir the same unprovable team is the quiet empty census it always was.
  f.output.length = 0;
  expect(await relaunch(parseOptions(["tap/alice"]), f.deps)).toBe(0);
  expect(f.output.join("")).toContain("nothing to relaunch");
});

test("tap help session documents the single-seat --workdir exit 7", () => {
  const text = lookupHelp(["session", "relaunch"]).stdout ?? "";
  expect(text).toContain("7  single-seat --workdir only");
  expect(text).toContain("never retry");
});
