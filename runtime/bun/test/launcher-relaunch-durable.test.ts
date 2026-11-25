import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { prepareRelaunch, relaunchOne, relaunchTarget } from "../src/launcher/relaunch-durable";
import { relaunchIdentity, replaceHarnessInPane, stampExpectedClearNonce, type ClearPlan } from "../src/launcher/replace";
import { PaneObservationTimeout } from "../src/launcher/readiness";
import { reviveTier } from "../src/launcher/resume-identity";
import { recordFromRow } from "../src/launcher/transaction";
import { fencePath } from "../src/clear-fence";
import { teamContext } from "../src/crew-lifecycle";
import { TapError } from "../src/context";
import { relaunch, parseOptions, classify, crewMember, type Member, type ClassifiedMember } from "../src/launcher/relaunch";
import { loadGlobalRegistry } from "../src/index-home";
import { createOpenCodeStore, addSession } from "./support/opencode-store";
import { removeScratchTree } from "./support/scratch";
import { inWorkdir } from "../src/tmux-spawn-cwd";

const saved = { ...process.env }, roots: string[] = [];
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  for (const root of roots.splice(0)) removeScratchTree(root);
});
const caller = { state: "outside" as const, detail: "test caller" };
// The cancel arms abort once a stub effect appears. A bounded poll of ~1 s expired on a loaded gate runner
// and aborted BEFORE the respawn ("interrupted before respawn"), so wait for the effect and fail loudly if it never comes.
async function waitForEffect(effects: () => string, needle: string, limitMs = 30_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!effects().includes(needle)) {
    if (Date.now() > deadline) throw new Error(`stub effect "${needle}" never appeared within ${limitMs} ms`);
    await Bun.sleep(10);
  }
}

function fixture(harness = "opencode", prefix = "relaunch-native-", registryRelative = ".tap/elsewhere/registry.json") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix))); roots.push(root);
  const bin = join(root, "bin"), index = join(root, "index"), busHome = join(root, ".tap/bus");
  for (const p of [bin, index, busHome, join(root, ".tap/elsewhere")]) mkdirSync(p, { recursive: true });
  spawnSync("git", ["init", "-q", root]);
  // Relocated registry: fence authority must still be root/.tap/bus.
  const registryPath = join(root, registryRelative), effect = join(root, "effects"), state = join(root, "state");
  const row = { harness, status: "active", delivery: "pane", pane_id: "%7", pane: "Demo/alice:0.0", session: "Demo/alice",
    server_epoch: "srv:1:1", server_socket: "/fixture/socket", boot_id: "boot:1", harness_session_id: "conversation", permissions: "bypass" };
  const doc = { schema: "0.20", team: { name: "Demo" }, seats: { alice: row } };
  mkdirSync(dirname(registryPath), {recursive:true});
  writeFileSync(registryPath, JSON.stringify(doc));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { Demo: { root, registry_location: registryPath }, broken: { root: "/missing", registry_location: "/missing/registry" } } }));
  writeFileSync(state, JSON.stringify({ replaced: false, drift: null }));
  writeFileSync(join(bin, "tmux"), `#!${process.execPath}
import { readFileSync, writeFileSync, appendFileSync, chmodSync } from 'node:fs';
const args = process.argv.slice(2); while (['-S','-L'].includes(args[0])) args.splice(0,2);
const statePath = ${JSON.stringify(state)}, reg = ${JSON.stringify(registryPath)};
const state = JSON.parse(readFileSync(statePath,'utf8'));
if (args[0] === 'display-message') {
  const target = args[args.indexOf('-t') + 1] ?? '';
  if (state.publicCensus && args.at(-1).includes('pane_tty') && args.at(-1).includes('socket_path')) {
    console.log(['%8','/dev/fixture-caller','Demo/caller','1:1','Demo/caller:0.0','112',${JSON.stringify(harness)},'/fixture/socket',${JSON.stringify(root)}].join('\\t')); process.exit(0);
  }
  if (state.publicCensus && args.at(-1).includes('pane_tty')) { console.log('%8\\t/dev/fixture-caller\\tDemo/caller\\t1:1'); process.exit(0); }
  if (state.oldReadTimeout) { const doc=JSON.parse(readFileSync(reg,'utf8')); doc.agents=doc.seats; delete doc.seats; writeFileSync(reg,JSON.stringify(doc)); process.exit(124); }
  if (args.at(-1).includes('pane_dead') && args.at(-1).includes('socket_path')) {
    if (target === '%8') console.log(['%8','Demo/caller','112',${JSON.stringify(harness)},'0','Demo/caller:0.0','/fixture/socket',${JSON.stringify(root)}].join('\\t'));
    else console.log(['%7','Demo/alice','111',${JSON.stringify(harness)},'0','Demo/alice:0.0','/fixture/socket',${JSON.stringify(root)}].join('\\t'));
    process.exit(0);
  }
  if (args.at(-1).includes('pane_current_command')) {
    const doc = JSON.parse(readFileSync(reg,'utf8'));
    if (doc.seats?.alice?.expected_clear_nonce && state.drift) {
      Object.assign(doc.seats.alice,state.drift); writeFileSync(reg,JSON.stringify(doc));
    }
    if (doc.seats?.alice?.expected_clear_nonce && state.duplicateAfterStamp) {
      doc.seats.bob = {...doc.seats.alice, session:'Demo/bob', pane_id:'%8'}; writeFileSync(reg,JSON.stringify(doc));
    }
    if (doc.seats?.alice?.expected_clear_nonce && state.oldBefore) { doc.agents=doc.seats; delete doc.seats; writeFileSync(reg,JSON.stringify(doc)); }
    console.log(['Demo/alice:0.0','%7',${JSON.stringify(harness)},state.epoch ?? '1:1','0',state.replaced && !state.stuck ? 222 : 111,${JSON.stringify(root)}].join('\\t'));
  } else console.log('1:1\\t/fixture/socket');
} else if (state.publicCensus && args[0] === 'list-sessions') {
  console.log('Demo/alice\\t1:1\\t1\\nDemo/caller\\t1:1\\t1');
} else if (state.publicCensus && args[0] === 'list-panes') {
  if (args.at(-1).includes('pane_tty')) console.log('%8\\t/dev/fixture-caller');
  else console.log('Demo/alice\\tDemo/alice:0.0\\t%7\\t${harness}\\t111\\t1:1\\t0\\nDemo/caller\\tDemo/caller:0.0\\t%8\\t${harness}\\t112\\t1:1\\t0');
} else if (args[0] === 'respawn-pane') {
  appendFileSync(${JSON.stringify(effect)}, JSON.stringify(args)+'\\n'); state.replaced=true; writeFileSync(statePath,JSON.stringify(state));
  if (state.fenceAfterRespawn) writeFileSync(${JSON.stringify(join(busHome, "reset.fence.json"))}, JSON.stringify({ pid: state.fenceAfterRespawn, started_at: new Date().toISOString() }));
  if (state.swapNonceAfterRespawn) { const doc=JSON.parse(readFileSync(reg,'utf8')); doc.seats.alice.expected_clear_nonce='someone-else'; writeFileSync(reg,JSON.stringify(doc)); }
  if (state.readonlyAfter) chmodSync(${JSON.stringify(dirname(registryPath))}, 0o555);
  if (state.oldAfter) { const doc=JSON.parse(readFileSync(reg,'utf8')); doc.agents=doc.seats; delete doc.seats; writeFileSync(reg,JSON.stringify(doc)); }
  if (state.blockRespawn) await Bun.sleep(60000);
  if (state.effectDelay) await Bun.sleep(state.effectDelay);
  if (state.failExit) process.exit(state.failExit);
} else if (args[0] === 'set-option') {
  appendFileSync(${JSON.stringify(effect)}, JSON.stringify(args)+'\\n');
  if (args.at(-1) === 'on') {
    state.remainOn=true; writeFileSync(statePath,JSON.stringify(state));
    if (state.armTimeout) process.exit(124);
    if (state.blockArm) await Bun.sleep(60000);
  } else if (args.at(-1) === 'off') {
    if (state.disarmFail) process.exit(1);
    if (state.blockDisarm) await Bun.sleep(60000);
    state.remainOn=false; writeFileSync(statePath,JSON.stringify(state));
  }
} else if (args[0] === 'clear-history') { throw Error('relaunch must retain scrollback'); }
else if (args[0] !== 'capture-pane') process.exit(1);
`, { mode: 0o755 });
  Object.assign(process.env, { PATH: `${bin}:${saved.PATH}`, TAP_INDEX_HOME: index, TAP_SERVER_EPOCH: "srv:1:1", TAP_BOOT_ID: "boot:1", TAP_TMUX_SOCKET_PATH: "/fixture/socket" });
  for (const key of ["TMUX", "TMUX_PANE", "TAP_HOME", "TAP_SELF"]) delete process.env[key];
  const scope = { root, registryPath, busHome };
  const member: Member = { team: "Demo", handle: "alice", root, team_doc: doc.team, row };
  const prepared = () => prepareRelaunch([member])[0]!;
  const current = () => JSON.parse(readFileSync(registryPath, "utf8"));
  const update = (patch: Record<string, unknown>) => { const d = current(); Object.assign(d.seats.alice, patch); writeFileSync(registryPath, JSON.stringify(d)); };
  const plan = (): ClearPlan => ({ target: { entry: row, warnings: [], paneId: "%7", epoch: "srv:1:1", generation: { epoch: "srv:1:1", boot: "boot:1", socket: "/fixture/socket" } },
    record: recordFromRow("alice", row, doc.team, root)!, nonce: "ours", invocation: { argv: [harness], env: {} }, command: harness, ceiling: .15 });
  const effects = () => { try { return readFileSync(effect, "utf8"); } catch { return ""; } };
  return { root, row, member, prepared, scope, current, update, plan, effects, state };
}

test("target resolution uses root bus authority and ignores unrelated corrupt teams", () => {
  const f = fixture();
  expect(relaunchTarget(f.member)).toEqual(f.scope);
});

test("identity ownership excludes self through an arbitrarily relocated acting registry", async () => {
  const f = fixture("opencode", "relaunch-native-", ".tap/custom/deep/registry.json");
  const result = await relaunchOne(f.prepared(), {json:false,dryRun:true}, caller);
  expect(result.code).toBe(0); expect(f.effects()).toBe("");
});

test("identity self exclusion uses the selected team even when the launch cwd is another repository", async () => {
  const f = fixture(), cwd = join(f.root, "launch-project");
  mkdirSync(cwd); expect(spawnSync("git", ["init", "-q", cwd]).status).toBe(0);
  Object.assign(f.row, {registered_from_worktree:cwd}); f.update(f.row);
  const result = await relaunchOne(f.prepared(), {json:false,dryRun:true}, caller);
  expect(result.code).toBe(0); expect(f.effects()).toBe("");
});

test("census root aliases resolve canonically while changed roots refuse", () => {
  const f = fixture(), alias = join(f.root, "alias");
  symlinkSync(f.root, alias);
  const member = prepareRelaunch([{ ...f.member, root: alias }])[0]!;
  expect(relaunchTarget(member)).toEqual(f.scope);
  fixture(); // The enrolled team now resolves to a different root.
  expect(() => relaunchTarget(member)).toThrow("enrollment changed");
});

test.each(["harness", "pane_id", "harness_session_id"])("real relaunch refuses census %s drift before target or effect", async field => {
  const f = fixture(), member = f.prepared(); f.update({ [field]: "changed" });
  const result = await relaunchOne(member, { json: false, dryRun: true }, caller);
  expect(result.code).toBe(2); expect(result.reason).toContain("changed since enumeration"); expect(f.effects()).toBe("");
});

test("missing conversation refuses instead of building a picker", async () => {
  const f = fixture(); delete (f.row as any).harness_session_id; f.update({ harness_session_id: null });
  const result = await relaunchOne(f.prepared(), { json: false, dryRun: true }, caller);
  expect(result.code).toBe(2); expect(result.reason).toContain("no resumable conversation id"); expect(f.effects()).toBe("");
});

test.each([true, false])("relaunch refuses a duplicate native identity before effects (dryRun=%s)", async dryRun => {
  const f = fixture(), doc = f.current();
  doc.seats.bob = { ...f.row, session: "Demo/bob", pane_id: "%8" };
  writeFileSync(f.scope.registryPath, JSON.stringify(doc));
  const before = readFileSync(f.scope.registryPath, "utf8");
  const result = await relaunchOne(f.prepared(), { json: false, dryRun }, caller);
  expect(result.code).toBe(2); expect(result.reason).toContain("already belongs to expected seat Demo/bob");
  expect(f.effects()).toBe(""); expect(readFileSync(f.scope.registryPath, "utf8")).toBe(before);
});

test.each(["transcript_path", "quarantined_harness_session_id"])("relaunch detects another seat's effective Claude identity through %s", async source => {
  const f = fixture("claude"), claude = join(f.root, "claude"), transcript = join(claude, "projects/demo/shared.jsonl");
  mkdirSync(join(claude, "projects/demo"), {recursive:true}); writeFileSync(transcript, "");
  process.env.TAP_CLAUDE_HOME = claude;
  Object.assign(f.row, {harness_session_id:"missing-alice", transcript_path:transcript}); f.update(f.row);
  const doc = f.current();
  doc.seats.bob = {...f.row, session:"Demo/bob", pane_id:"%8", harness_session_id:"missing-bob", transcript_path:null,
    [source]:source === "transcript_path" ? transcript : "shared"};
  writeFileSync(f.scope.registryPath, JSON.stringify(doc));
  const result = await relaunchOne(f.prepared(), {json:false, dryRun:true}, caller);
  expect(result.code).toBe(2); expect(result.reason).toContain("already belongs to expected seat Demo/bob");
  expect(f.effects()).toBe("");
});

test("an unrelated FIFO registry cannot block relaunch's identity scan", () => {
  const f = fixture(), fifo = join(f.root, "unrelated-registry"), index = join(f.root, "index/global-registry.json");
  expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
  const doc = JSON.parse(readFileSync(index,"utf8"));
  doc.teams.pipe = {root:join(f.root,"other"), registry_location:fifo}; writeFileSync(index,JSON.stringify(doc));
  const entry = join(f.root,"fifo-probe.ts");
  writeFileSync(entry, `import {relaunchOne} from ${JSON.stringify(resolve(import.meta.dir,"../src/launcher/relaunch-durable.ts"))};
console.log(JSON.stringify(await relaunchOne(${JSON.stringify(f.prepared())}, {json:false,dryRun:true}, ${JSON.stringify(caller)})));`);
  const result = spawnSync(process.execPath, [entry], {env:process.env,encoding:"utf8",timeout:5000,killSignal:"SIGKILL"});
  expect(result.signal).toBeNull(); expect(result.status).toBe(0); expect(JSON.parse(result.stdout).code).toBe(0);
  expect(f.effects()).toBe("");
});

test("relaunch keeps distinct native identities and harnesses independent", async () => {
  const f = fixture(), doc = f.current();
  doc.seats.bob = { ...f.row, session: "Demo/bob", pane_id: "%8", harness_session_id: "another" };
  doc.seats.carol = { ...f.row, session: "Demo/carol", pane_id: "%9", harness: "codex" };
  writeFileSync(f.scope.registryPath, JSON.stringify(doc));
  expect((await relaunchOne(f.prepared(), { json: false, dryRun: true }, caller)).code).toBe(0);
  expect(f.effects()).toBe("");
});

test("a duplicate introduced after the nonce stamp refuses before respawn", async () => {
  const f = fixture(), p = f.plan();
  writeFileSync(f.state, JSON.stringify({ replaced: false, duplicateAfterStamp: true }));
  const result = await replaceHarnessInPane(f.scope, p, { verb: "tap session relaunch", handle: "alice", instruction: null, clearHistory: false,
    relaunch: { identity: relaunchIdentity(f.row), resume: "conversation" } });
  expect(result.code).toBe(2); expect(result.errorClass).toBe("duplicate_resume_identity");
  expect(f.effects()).toBe(""); expect(f.current().seats.alice.expected_clear_nonce).toBeUndefined();
  expect(f.current().seats.bob.harness_session_id).toBe("conversation");
});

test("durable dry-run retains the conversation and overrides and exposes its nonce", async () => {
  const f = fixture(), member = f.prepared();
  const overrides = { env: ["RELAUNCH_TEST=kept"], unset_env: ["OTHER"], argv: ["--verbose"] };
  const result = await relaunchOne(member, { json: false, dryRun: true, overrides }, caller);
  expect(result.code).toBe(0); expect(result.stdout).toContain("TAP_CLEAR_ID="); expect(result.stdout).toContain("conversation");
  expect(f.effects()).toBe(""); expect(f.current().seats.alice.expected_clear_nonce).toBeUndefined();
  expect(existsSync(join(f.root, ".tap/clear-latency.jsonl"))).toBe(false);
});

test("public relaunch dry-runs share candidates and exclusions without replacement effects", () => {
  const f = fixture(), doc = f.current();
  doc.seats.caller = { ...f.row, pane_id: "%8", pane: "Demo/caller:0.0", session: "Demo/caller", harness_session_id: "caller-conversation" };
  doc.seats.offline = { ...f.row, pane_id: "%90", pane: "Demo/offline:0.0", session: "Demo/offline", harness_session_id: "offline-conversation" };
  doc.seats.suspended = { ...f.row, status: "suspended", status_reason: "session_stopped", harness_session_id: "suspended-conversation" };
  doc.seats.poll = { ...f.row, delivery: "poll", harness_session_id: "poll-conversation" };
  writeFileSync(f.scope.registryPath, JSON.stringify(doc));
  writeFileSync(f.state, JSON.stringify({ replaced: false, publicCensus: true }));
  writeFileSync(join(f.root, "bin/ps"), "#!/bin/sh\nprintf '1 fixture-caller\\n'\n", { mode: 0o755 });
  const before = readFileSync(f.scope.registryPath, "utf8");
  const env = { ...process.env, TAP_BOOT_ID: "bootuuid:00000000-0000-0000-0000-000000000001", TAP_BOOT_ID_LEGACY: "boot:1", TAP_JSON: "0" };
  const run = (json: boolean) => spawnSync(resolve(import.meta.dir, "../../../bin/tap"),
    ["session", "relaunch", "--harness", "opencode", "--team", "Demo", "--dry-run", ...(json ? ["--json"] : [])],
    { cwd: f.root, env, encoding: "utf8", timeout: 10000 });
  const human = run(false), json = run(true);
  expect(human.status, human.stdout + human.stderr).toBe(0);
  expect(json.status, json.stdout + json.stderr).toBe(0);
  const receipt = JSON.parse(json.stdout);
  expect(receipt.candidates).toBe(1);
  expect(receipt.counts.candidates).toBe(1);
  expect(receipt.results).toEqual([expect.objectContaining({ team: "Demo", handle: "alice", status: "would-resume", code: 0 })]);
  expect(human.stdout).toBe("Would relaunch 1 active opencode seats on team Demo\n● Demo/alice\n");
  expect(receipt.excluded_caller).toEqual([{ team: "Demo", handle: "caller", reason: "caller-pane" }]);
  expect(receipt.excluded_inactive.map((r: { handle: string }) => r.handle).sort()).toEqual(["offline", "poll", "suspended"]);
  expect(json.stderr).toBe("");
  expect(readFileSync(f.scope.registryPath, "utf8")).toBe(before);
  expect(f.effects()).toBe("");
  expect(existsSync(fencePath(f.scope.busHome, "alice"))).toBe(false);
  expect(existsSync(join(f.root, ".tap/clear-latency.jsonl"))).toBe(false);
});

test("public agy batch dry-run plans --conversation and --prompt-interactive without side effects", () => {
  const f = fixture("agy");
  writeFileSync(f.state, JSON.stringify({ replaced: false, publicCensus: true }));
  writeFileSync(join(f.root, "bin/ps"), "#!/bin/sh\nprintf '1 fixture-caller\\n'\n", { mode: 0o755 });
  const env = { ...process.env, TAP_BOOT_ID: "bootuuid:00000000-0000-0000-0000-000000000001", TAP_BOOT_ID_LEGACY: "boot:1", TAP_JSON: "0" };
  const res = spawnSync(resolve(import.meta.dir, "../../../bin/tap"),
    ["session", "relaunch", "--harness", "agy", "--team", "Demo", "-m", "continue the task", "--dry-run", "--json"],
    { cwd: f.root, env, encoding: "utf8", timeout: 10000 });
  expect(res.status, res.stdout + res.stderr).toBe(0);
  const receipt = JSON.parse(res.stdout);
  expect(receipt.harness).toBe("agy");
  expect(receipt.candidates).toBe(1);
  expect(receipt.results).toEqual([expect.objectContaining({ team: "Demo", handle: "alice", status: "would-resume", code: 0 })]);
  expect(receipt.results[0].stdout).toContain("--conversation conversation");
  expect(receipt.results[0].stdout).toContain("--prompt-interactive 'continue the task'");
  expect(f.effects()).toBe("");
});

test("stamp refuses identity or effective conversation drift without changing the row", async () => {
  for (const [field, value] of [["harness_session_id", "changed"], ["pane_id", "%9"], ["harness", "claude"]]) {
    const f = fixture(), p = f.plan(); f.update({ [field!]: value }); const before = f.current();
    expect((await stampExpectedClearNonce(f.scope, "alice", "ours", p.target, p.record, "tap session relaunch",
      { identity: relaunchIdentity(f.row), resume: "conversation" }))?.code).toBe(2);
    expect(f.current()).toEqual(before);
  }
});

test.each(["harness", "pane_id", "harness_session_id", "boot_id"])("registration between stamp and respawn changing %s refuses and consumes only our stamp", async field => {
  const f = fixture(), p = f.plan();
  writeFileSync(f.state, JSON.stringify({ replaced: false, drift: { [field]: field === "boot_id" ? "boot:100" : "changed" } }));
  const result = await replaceHarnessInPane(f.scope, p, { verb: "tap session relaunch", handle: "alice", instruction: null, clearHistory: false,
    relaunch: { identity: relaunchIdentity(f.row), resume: "conversation" } });
  expect(result.code).toBe(2); expect(f.effects()).toBe("");
  expect(f.current().seats.alice.expected_clear_nonce).toBeUndefined(); expect(readFileSync(fencePath(f.scope.busHome, "alice"), "utf8")).toBe("");
});

test("relaunch verifies the new harness without a registration witness and keeps scrollback", async () => {
  const f = fixture(), p = f.plan();
  const result = await replaceHarnessInPane(f.scope, p, { verb: "tap session relaunch", handle: "alice", instruction: null, clearHistory: false,
    relaunch: { identity: relaunchIdentity(f.row), resume: "conversation" } });
  expect(result.code).toBe(0); expect(f.effects().match(/respawn-pane/g)).toHaveLength(1);
  expect(f.current().seats.alice.clear_nonce).toBeUndefined(); expect(f.current().seats.alice.expected_clear_nonce).toBeUndefined();
  expect(JSON.parse(readFileSync(join(f.root, ".tap/clear-latency.jsonl"), "utf8"))).toMatchObject({
    operation: "relaunch", handle: "alice", harness: "opencode", pane_id: "%7", verified: true, timeout: p.ceiling,
    seconds: expect.any(Number), loadavg1: expect.any(Number), at: expect.any(String),
  });
});

test("unverified replacement is rc 7 after exactly one respawn; it is never retried", async () => {
  const f = fixture(), p = f.plan();
  writeFileSync(f.state, JSON.stringify({ replaced: false, stuck: true }));
  const result = await replaceHarnessInPane(f.scope, p, { verb: "tap session relaunch", handle: "alice", instruction: null, clearHistory: false,
    relaunch: { identity: relaunchIdentity(f.row), resume: "conversation" } });
  expect(result.code).toBe(7); expect(result.errorClass).toStartWith("harness_start_unverified");
  expect(f.effects().match(/respawn-pane/g)).toHaveLength(1);
  expect(f.current().seats.alice.expected_clear_nonce).toBeUndefined();
  expect(JSON.parse(readFileSync(join(f.root, ".tap/clear-latency.jsonl"), "utf8"))).toMatchObject({ operation: "relaunch", verified: false });
});

test("a transcript appearing after census cannot substitute a different effective conversation", async () => {
  const f = fixture("claude"), project = join(f.root, "claude/projects/demo");
  mkdirSync(project, { recursive: true }); process.env.TAP_CLAUDE_HOME = join(f.root, "claude");
  f.row.harness_session_id = "ghost"; (f.row as any).transcript_path = join(project, "fallback.jsonl"); f.update(f.row);
  writeFileSync(join(project, "fallback.jsonl"), "{}");
  const member = f.prepared(); expect(member.expect_resume).toBe("fallback");
  writeFileSync(join(project, "ghost.jsonl"), "{}");
  const result = await relaunchOne(member, { json: false, dryRun: true }, caller);
  expect(result.code).toBe(2); expect(result.reason).toContain("different conversation"); expect(result.stdout).toBeUndefined();
  const p = f.plan(), before = f.current();
  const stamped = await stampExpectedClearNonce(f.scope, "alice", "ours", p.target, p.record, "tap session relaunch",
    { identity: relaunchIdentity(f.row), resume: "fallback" });
  expect(stamped?.code).toBe(2); expect(f.current()).toEqual(before);
});

test("overrides are persisted by the stamp before relaunch and do not change the resume id", async () => {
  const f = fixture(), member = f.prepared();
  const result = await relaunchOne(member, { json: false, dryRun: false, overrides: { env: ["RELAUNCH_TEST=kept"], unset_env: ["OTHER"], argv: ["--verbose"] } }, caller);
  expect(result.code).toBe(0);
  const row = f.current().seats.alice;
  expect(row.harness_env).toEqual({ RELAUNCH_TEST: "kept" }); expect(row.harness_unset_env).toEqual(["OTHER"]);
  expect(row.harness_tail).toEqual(["--verbose"]); expect(row.harness_session_id).toBe("conversation");
  expect(f.effects().match(/respawn-pane/g)).toHaveLength(1);
});

test("stale recorded session refuses before building another session's invocation", async () => {
  const f = fixture(), member = f.prepared(); f.update({ session: "Demo/someone-else" });
  const result = await relaunchOne(member, { json: false, dryRun: true }, caller);
  expect(result.code).toBe(2); expect(result.reason).toContain("session"); expect(result.stdout).toBeUndefined();
  expect(f.effects()).toBe("");
});


test("revive tiers retain the characterized Python truth table", () => {
  const cases: [string | null, string | null, string][] = [
    [null, null, "-"], ["unknown", "id", "-"],
    ["claude", "id", "exact"], ["claude", null, "picker"], ["claude", "", "picker"],
    ["codex", "id", "exact"], ["codex", null, "picker"],
    ["cursor", "id", "exact"], ["cursor", null, "fresh"],
    ["opencode", "id", "exact"], ["opencode", null, "fresh"],
    ["agy", "id", "exact"], ["agy", null, "fresh"],
    ["hermes", "id", "exact"], ["hermes", null, "fresh"],
  ];
  const expected = cases.map(([, , tier]) => tier);
  expect(cases.map(([harness, id]) => reviveTier(harness, id))).toEqual(expected);

});


test("a raw tmux exit 2 retains tmux_error and one attempted effect in the member receipt", async () => {
  const f = fixture(); writeFileSync(f.state, JSON.stringify({ failExit: 2 }));
  const result = await relaunchOne(f.prepared(), { json: false, dryRun: false }, caller);
  expect(result.code).toBe(2); expect(result.error_class).toBe("tmux_error");
  expect(f.effects().match(/respawn-pane/g)).toHaveLength(1);
});

test("a raw tmux exit 7 from a failed respawn is a pre-effect tmux_error, distinguishable from a post-effect 7", async () => {
  const f = fixture(); writeFileSync(f.state, JSON.stringify({ failExit: 7 }));
  const result = await relaunchOne(f.prepared(), { json: false, dryRun: false }, caller);
  // The member result carries tmux's raw status; the class is what marks it pre-effect for the aggregate.
  expect(result.code).toBe(7); expect(result.error_class).toBe("tmux_error");
  expect(f.effects().match(/respawn-pane/g)).toHaveLength(1);
});

test.each(["oldBefore", "oldAfter"])("%s registry transition refuses without rewriting the old store", async mode => {
  const f = fixture(); writeFileSync(f.state, JSON.stringify({ [mode]: true }));
  const result = await relaunchOne(f.prepared(), { json: false, dryRun: false }, caller);
  expect(result.code).toBe(mode === "oldBefore" ? 1 : 7); expect(result.error_class).toBe("old_store");
  expect(f.effects().match(/respawn-pane/g)?.length ?? 0).toBe(mode === "oldBefore" ? 0 : 1);
  expect(f.current().seats).toBeUndefined(); expect(f.current().agents.alice.expected_clear_nonce).toBeTruthy();
  expect(readFileSync(fencePath(f.scope.busHome, "alice"), "utf8")).toBe("");
});

test("the target reset fence refuses a cross-team relaunch despite a different caller pin", async () => {
  const f = fixture(); process.env.TAP_HOME = join(f.root, "caller-bus");
  writeFileSync(join(f.scope.busHome, "reset.fence.json"), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  const result = await relaunchOne(f.prepared(), { json: false, dryRun: false }, caller);
  expect(result.code).toBe(2); expect(result.error_class).toBe("team_reset_fenced"); expect(f.effects()).toBe("");
});

test("target-scoped recovery quotes a root containing spaces and apostrophes", async () => {
  const f = fixture("opencode", "relaunch root's "); delete (f.row as any).harness_session_id; f.update({ harness_session_id: null });
  const result = await relaunchOne(f.prepared(), { json: false, dryRun: true }, caller);
  expect(result.code).toBe(2); expect(result.reason).toContain("cd '"); expect(result.reason).toContain(`root'"'"'s `);
});

test("a cross-team relaunch never gives the resumed harness the caller's TAP_HOME", async () => {
  const f = fixture(); process.env.TAP_HOME = join(f.root, "caller-bus");
  const result = await relaunchOne(f.prepared(), { json: false, dryRun: true }, caller);
  expect(result.code).toBe(0); expect(result.stdout).toContain("-u TAP_HOME");
});

for (const badRoot of ["", "other-checkout"]) test(`relaunch refuses malformed enrollment root (${badRoot || "empty"}) before replacement`, async () => {
  const f = fixture();
  const doc = f.current(); doc.team.worktree_root = f.root;
  writeFileSync(f.scope.registryPath, JSON.stringify(doc));
  const root = badRoot ? join(f.root, badRoot) : "";
  if (root) mkdirSync(root);
  const index = join(f.root, "index/global-registry.json");
  writeFileSync(index, JSON.stringify({ schema: "0.20", teams: { Demo: { root, registry_location: f.scope.registryPath } } }));
  const member = prepareRelaunch([{ ...f.member, root, team_doc: doc.team }])[0]!;
  expect(member.prepare_error).toBeUndefined();
  const result = await relaunchOne(member, { json: false, dryRun: true }, caller);
  expect(result.code).toBe(2); expect(result.error_class).toBe("team_moved");
  expect(result.reason).toContain("worktree_root"); expect(result.reason).toContain("next: tap doctor");
  expect(() => teamContext("Demo", false)).toThrow(TapError);
  expect(f.effects()).toBe("");
  expect(readFileSync(f.scope.registryPath, "utf8")).toBe(JSON.stringify(doc));
});

test("cancel after respawn reports the possible effect and releases owned replacement custody", async () => {
  const f = fixture("codex");
  const controller = new AbortController();
  const plan = { ...f.plan(), ceiling: 2 };
  const command = replaceHarnessInPane(f.scope, plan, { verb: "tap session relaunch", handle: "alice", instruction: null, clearHistory: false,
    relaunch: { identity: relaunchIdentity(f.row), resume: "conversation" }, signal: controller.signal });
  await waitForEffect(() => f.effects(), "respawn-pane");
  controller.abort(new (await import("../src/launcher/transaction")).LaunchInterrupted(130));
  const outcome = await command;
  expect(outcome.code).toBe(130);
  expect(outcome.detail).toContain("respawn was attempted");
  expect(outcome.action).toContain("tmux attach");
  expect(outcome.detail).not.toContain("remain-on-exit may be on");
  expect(JSON.parse(readFileSync(f.state, "utf8")).remainOn).toBe(false);
  expect(f.effects().split("\n").filter(row => row.includes("remain-on-exit") && row.includes("off"))).toHaveLength(1);
  expect(f.effects().split("\n").filter(row => row.includes("respawn-pane"))).toHaveLength(1);
  expect(f.current().seats.alice.expected_clear_nonce).toBeUndefined();
  expect(readFileSync(fencePath(f.scope.busHome, "alice"), "utf8")).toBe("");
});

test("OS SIGINT uses shared launch cancellation and reports a post-respawn outcome", async () => {
  const f = fixture("codex");
  const source = `import { withLaunchSignals } from ${JSON.stringify(resolve(import.meta.dir, "../src/launcher/transaction.ts"))};
import { replaceHarnessInPane } from ${JSON.stringify(resolve(import.meta.dir, "../src/launcher/replace.ts"))};
await withLaunchSignals(async signal => {
  const result = await replaceHarnessInPane(${JSON.stringify(f.scope)}, ${JSON.stringify({ ...f.plan(), ceiling: 5 })},
    { verb: "tap session relaunch", handle: "alice", instruction: null, clearHistory: false,
      relaunch: ${JSON.stringify({ identity: relaunchIdentity(f.row), resume: "conversation" })}, signal });
  console.log(JSON.stringify(result)); process.exitCode = result.code;
});`;
  const child = Bun.spawn([process.execPath, "-e", source], { env: process.env, cwd: f.root, stdout: "pipe", stderr: "pipe" });
  try {
    await waitForEffect(() => f.effects(), "respawn-pane");
    expect(f.effects()).toContain("respawn-pane");
    child.kill("SIGINT");
    expect(await child.exited).toBe(130);
    const receipt = JSON.parse(await new Response(child.stdout).text());
    expect(receipt.detail).toContain("respawn was attempted");
    expect(receipt.action).toContain("inspect before deciding");
    expect(f.effects().split("\n").filter(row => row.includes("respawn-pane"))).toHaveLength(1);
    expect(readFileSync(fencePath(f.scope.busHome, "alice"), "utf8")).toBe("");
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
});

test("cancellation interrupts a blocked generation read before any effect", async () => {
  const f = fixture();
  delete process.env.TAP_SERVER_EPOCH;
  process.env.TAP_TMUX_TIMEOUT_SECONDS = "60";
  writeFileSync(join(f.root, "bin/tmux"), "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 });
  const controller = new AbortController();
  const pending = relaunchOne(f.prepared(), { json: false, dryRun: false }, caller, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    const result = await pending;
    expect(result.code).toBe(130);
    expect(result.reason).toContain("nothing was replaced");
    expect(f.effects()).toBe("");
  } finally { clearTimeout(timer); }
});

test("an epoch observation timeout refuses instead of weakening the target identity", async () => {
  const f = fixture();
  delete process.env.TAP_SERVER_EPOCH;
  writeFileSync(join(f.root, "bin/tmux"), "#!/bin/sh\nexit 124\n", { mode: 0o755 });
  const result = await relaunchOne(f.prepared(), { json: false, dryRun: false }, caller);
  expect(result.code).not.toBe(0);
  expect(result.reason).toContain("observation timed out");
  expect(f.effects()).toBe("");
});

test("post-replacement diagnosis honors cancellation during a blocked capture", async () => {
  const f = fixture("codex");
  writeFileSync(join(f.root, "bin/tmux"), "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 });
  const controller = new AbortController();
  const { clearUnverifiedDiagnosis } = await import("../src/launcher/replace");
  const pending = clearUnverifiedDiagnosis({pane:"Demo/alice:0.0",pane_id:"%7",command:"codex",server_epoch:"srv:1:1",dead:false,pane_pid:222,path:f.root}, "codex", process.env, controller.signal);
  const timer = setTimeout(() => controller.abort(new Error("diagnosis cancelled")), 100);
  try { await expect(pending).rejects.toThrow("diagnosis cancelled"); }
  finally { clearTimeout(timer); }
});

test("cancellation runs while respawn itself is blocked", async () => {
  const f = fixture("codex"), controller = new AbortController();
  writeFileSync(f.state, JSON.stringify({ replaced: false, blockRespawn: true }));
  const pending = replaceHarnessInPane(f.scope, f.plan(), { verb: "tap session relaunch", handle: "alice", instruction: null, clearHistory: false,
    relaunch: { identity: relaunchIdentity(f.row), resume: "conversation" }, signal: controller.signal });
  try {
    await waitForEffect(() => f.effects(), "respawn-pane");
    expect(f.effects()).toContain("respawn-pane");
    controller.abort();
    const result = await pending;
    expect(result.code).toBe(130);
    expect(result.detail).toContain("respawn was attempted");
    expect(f.effects().split("\n").filter(line => line.includes("respawn-pane"))).toHaveLength(1);
  } finally { controller.abort(); await pending; }
});

test("an AMBIGUOUS respawn (cancelled or timed out before tmux returned) discloses the possible directory and records nothing", async () => {
  for (const how of ["cancelled", "timed out"]) {
    const f = fixture("codex"), dir = lane(f), controller = new AbortController();
    if (how === "timed out") process.env.TAP_TMUX_TIMEOUT_SECONDS = "1";
    writeFileSync(f.state, JSON.stringify({ replaced: false, blockRespawn: true }));
    const pending = replaceHarnessInPane(f.scope, f.plan(), { verb: "tap session relaunch", handle: "alice", instruction: null, clearHistory: false,
      relaunch: { identity: relaunchIdentity(f.row), resume: "conversation" }, launchWorkdir: dir, signal: controller.signal });
    try {
      if (how === "cancelled") {
        for (let i = 0; i < 100 && !f.effects().includes("respawn-pane"); i++) await Bun.sleep(10);
        expect(f.effects()).toContain("respawn-pane");
        controller.abort();
      }
      const result = await pending;
      expect(result.code).toBe(how === "cancelled" ? 130 : 7);
      expect(result.detail).toContain(`the harness may now run in ${dir}; launch_workdir was not updated`);
      expect(result.detail).not.toContain("recorded as");
      expect(f.current().seats.alice.launch_workdir).toBeUndefined();
      expect(f.current().seats.alice.expected_clear_nonce).toBeUndefined();
      expect(f.effects().match(/respawn-pane/g)).toHaveLength(1);
    } finally { controller.abort(); await pending; }
  }
});

test("interruption reports an expectation that could not be retired", async () => {
  const f = fixture("codex"), controller = new AbortController();
  writeFileSync(f.state, JSON.stringify({ replaced: false, blockRespawn: true }));
  const pending = replaceHarnessInPane(f.scope, f.plan(), { verb: "tap session relaunch", handle: "alice", instruction: null, clearHistory: false,
    relaunch: { identity: relaunchIdentity(f.row), resume: "conversation" }, signal: controller.signal });
  try {
    await waitForEffect(() => f.effects(), "respawn-pane");
    expect(f.effects()).toContain("respawn-pane");
    const doc = f.current(); doc.agents = doc.seats; delete doc.seats;
    writeFileSync(f.scope.registryPath, JSON.stringify(doc));
    controller.abort();
    const result = await pending;
    expect(result.code).toBe(130);
    expect(result.detail).toContain("clear expectation cleanup unverified");
    expect(f.current().agents.alice.expected_clear_nonce).toBe("ours");
  } finally { controller.abort(); await pending; }
});

test("timed-out observation reports failed nonce retirement", async () => {
  const f = fixture("codex");
  writeFileSync(f.state, JSON.stringify({ replaced: false, oldReadTimeout: true }));
  const result = await replaceHarnessInPane(f.scope, f.plan(), { verb: "tap session relaunch", handle: "alice", instruction: null, clearHistory: false,
    relaunch: { identity: relaunchIdentity(f.row), resume: "conversation" } });
  expect(result.code).toBe(2);
  expect(result.detail).toContain("clear expectation cleanup unverified");
  expect(f.current().agents.alice.expected_clear_nonce).toBe("ours");
  expect(f.effects()).not.toContain("respawn-pane");
});

test("uncertain remain-on-exit arm refuses respawn and disarms the possible option change", async () => {
  const f = fixture("codex");
  writeFileSync(f.state, JSON.stringify({ replaced: false, armTimeout: true }));
  const result = await replaceHarnessInPane(f.scope, f.plan(), { verb: "tap session relaunch", handle: "alice", instruction: null, clearHistory: false,
    relaunch: { identity: relaunchIdentity(f.row), resume: "conversation" } });
  expect(result.code).toBe(2);
  expect(result.detail).not.toContain("remain-on-exit may be on");
  expect(JSON.parse(readFileSync(f.state, "utf8")).remainOn).toBe(false);
  expect(f.effects()).not.toContain("respawn-pane");
  expect(f.current().seats.alice.expected_clear_nonce).toBeUndefined();
});

test("respawn retains the configured effect budget beyond five seconds", async () => {
  const f = fixture();
  process.env.TAP_TMUX_TIMEOUT_SECONDS = "6";
  writeFileSync(f.state, JSON.stringify({ replaced: false, effectDelay: 5100 }));
  const result = await replaceHarnessInPane(f.scope, { ...f.plan(), ceiling: 1 }, { verb: "tap session relaunch", handle: "alice", instruction: null, clearHistory: false,
    relaunch: { identity: relaunchIdentity(f.row), resume: "conversation" } });
  expect(result.code).toBe(0);
  expect(f.effects().split("\n").filter(line => line.includes("respawn-pane"))).toHaveLength(1);
}, 10000);


test("cancel during the arm still disarms without reusing the cancelled signal", async () => {
  const f = fixture("codex"), controller = new AbortController();
  writeFileSync(f.state, JSON.stringify({ replaced: false, blockArm: true }));
  const pending = replaceHarnessInPane(f.scope, f.plan(), { verb: "tap session relaunch", handle: "alice", instruction: null, clearHistory: false,
    relaunch: { identity: relaunchIdentity(f.row), resume: "conversation" }, signal: controller.signal });
  try {
    await waitForEffect(() => f.effects(), "remain-on-exit");
    expect(f.effects()).toContain("remain-on-exit");
    controller.abort();
    const result = await pending;
    expect(result.code).toBe(130);
    expect(result.detail).not.toContain("remain-on-exit may be on");
    expect(JSON.parse(readFileSync(f.state, "utf8")).remainOn).toBe(false);
    expect(f.effects()).not.toContain("respawn-pane");
    expect(readFileSync(fencePath(f.scope.busHome, "alice"), "utf8")).toBe("");
  } finally { controller.abort(); await pending; }
});

for (const failure of ["disarmFail", "blockDisarm"]) test(`failed cleanup remains visible in the relaunch receipt: ${failure}`, async () => {
  const f = fixture();
  process.env.TAP_TMUX_TIMEOUT_SECONDS = "60";
  writeFileSync(f.state, JSON.stringify({ replaced: false, [failure]: true }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  const pending = relaunchOne(f.prepared(), { json: false, dryRun: false }, caller, { signal: controller.signal });
  try {
    const result = await pending;
    expect(result.code).toBe(0); // The independent cleanup deadline precedes cancellation.
    expect(result.stderr).toContain("remain-on-exit cleanup unverified");
    expect(JSON.parse(readFileSync(f.state, "utf8")).remainOn).toBe(true);
    expect(f.effects().split("\n").filter(row => row.includes("remain-on-exit") && row.includes("off"))).toHaveLength(1);
    expect(readFileSync(fencePath(f.scope.busHome, "alice"), "utf8")).toBe("");
  } finally { clearTimeout(timer); controller.abort(); await pending; }
}, 20000);


test.each([null, "srv:1:1"])("cleanup refuses a changed server when the original generation is %s", async originalEpoch => {
  const f = fixture("codex"), controller = new AbortController(), warnings: string[] = [];
  delete process.env.TAP_SERVER_EPOCH; // Observe the fixture server instead of overriding it.
  const plan = f.plan(); plan.target.epoch = originalEpoch;
  const pending = replaceHarnessInPane(f.scope, { ...plan, ceiling: 2 }, { verb: "tap session relaunch", handle: "alice", instruction: null, clearHistory: false,
    relaunch: { identity: relaunchIdentity(f.row), resume: "conversation" }, signal: controller.signal, diagnostic: line => warnings.push(line) });
  try {
    await waitForEffect(() => f.effects(), "respawn-pane");
    expect(f.effects()).toContain("respawn-pane");
    const state = JSON.parse(readFileSync(f.state, "utf8")); state.epoch = "2:2";
    writeFileSync(f.state, JSON.stringify(state)); controller.abort();
    const result = await pending;
    expect(result.code).toBe(130);
    expect(result.detail).toContain("remain-on-exit may be on");
    expect(warnings.join("\n")).toContain("pane identity changed or is unobservable");
    expect(f.effects().split("\n").filter(row => row.includes("remain-on-exit") && row.includes("off"))).toHaveLength(0);
    expect(readFileSync(fencePath(f.scope.busHome, "alice"), "utf8")).toBe("");
  } finally { controller.abort(); await pending; }
});

test("hermes relaunch with -m refuses before any effect; without -m it proceeds (tap-boiq)", async () => {
  const f = fixture("hermes"), member = f.prepared();
  for (const dryRun of [true, false]) {
    const refused = await relaunchOne(member, { json: false, dryRun, message: "do the thing" }, caller);
    expect(refused.code).toBe(2); expect(refused.error_class).toBe("instruction_unsupported");
    expect(refused.reason).toContain("hermes has no channel for a -m instruction");
    expect(refused.reason).toContain("tap send Demo/alice -f <file>");
    expect(f.effects()).toBe(""); expect(f.current().seats.alice.expected_clear_nonce).toBeUndefined();
    expect(existsSync(join(f.root, ".tap/clear-latency.jsonl"))).toBe(false);
  }
  const control = await relaunchOne(member, { json: false, dryRun: true }, caller);
  expect(control.code).toBe(0); expect(control.stdout).toContain("TAP_CLEAR_ID=");
});

// tap-p8xog: `relaunch --workdir` repairs where a seat's harness runs, through the launcher's own worktree validator.
function lane(f: { root: string; row?: { harness: string } }, nativeDirectory: "target" | "original" = "target"): string {
  const git = (...args: string[]) => spawnSync("git", ["-C", f.root, ...args], { encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
  expect(git("commit", "-q", "--allow-empty", "-m", "init").status).toBe(0);
  const path = join(f.root, "lane");
  expect(git("worktree", "add", "-q", path, "-b", "lane").status).toBe(0);
  // Generic repair cases already have a conversation in the target directory.
  // The explicit mismatch regression keeps it in the original directory instead.
  if (f.row?.harness === "opencode") {
    process.env.XDG_DATA_HOME=join(f.root,"native-data");
    mkdirSync(join(process.env.XDG_DATA_HOME,"opencode"),{recursive:true});
    const db=createOpenCodeStore(join(process.env.XDG_DATA_HOME,"opencode/opencode.db"));
    addSession(db,"conversation",nativeDirectory === "target" ? realpathSync(path) : f.root);db.close();
  }
  return realpathSync(path);
}
test("relaunch --workdir respawns the harness there and records it on the row", async () => {
  const f = fixture(), dir = lane(f);
  const result = await relaunchOne(f.prepared(), { json: false, dryRun: false, workdir: dir }, caller);
  expect(result.code).toBe(0);
  const respawn = f.effects().split("\n").filter(Boolean).map(l => JSON.parse(l) as string[]).find(args => args[0] === "respawn-pane")!;
  // tap-p9v8: tmux starts the pane in a directory that outlives every worktree; the command enters the workdir.
  expect(respawn[respawn.indexOf("-c") + 1]).not.toBe(dir);
  expect(respawn.at(-1)!.startsWith(inWorkdir(dir, "exec "))).toBe(true);
  expect(f.current().seats.alice.launch_workdir).toBe(dir);
  expect(f.current().seats.alice.expected_clear_nonce).toBeUndefined();
});

test("relaunch --workdir dry run validates and previews without touching the row", async () => {
  const f = fixture(), dir = lane(f), before = readFileSync(f.scope.registryPath, "utf8");
  const result = await relaunchOne(f.prepared(), { json: false, dryRun: true, workdir: dir }, caller);
  expect(result.code).toBe(0); expect(result.stdout).toContain("TAP_CLEAR_ID=");
  expect(f.effects()).toBe(""); expect(readFileSync(f.scope.registryPath, "utf8")).toBe(before);
});

test.each([true, false])("an invalid relaunch --workdir is refused before any effect (dryRun=%s)", async dryRun => {
  const f = fixture(), elsewhere = join(f.root, "not-a-worktree"); mkdirSync(elsewhere);
  const before = readFileSync(f.scope.registryPath, "utf8");
  for (const bad of [join(f.root, "missing"), elsewhere, ""]) {
    const result = await relaunchOne(f.prepared(), { json: false, dryRun, workdir: bad }, caller);
    expect(result.code).toBe(2); expect(result.error_class).toBe("invalid_workdir"); expect(result.reason).toContain("--workdir must name an existing worktree");
    expect(f.effects()).toBe(""); expect(readFileSync(f.scope.registryPath, "utf8")).toBe(before);
  }
});

test("relaunch without --workdir keeps the recorded launch_workdir for the respawn and the row", async () => {
  const f = fixture(), dir = lane(f);
  Object.assign(f.row, { launch_workdir: dir }); f.update(f.row);
  const result = await relaunchOne(f.prepared(), { json: false, dryRun: false }, caller);
  expect(result.code).toBe(0);
  const respawn = f.effects().split("\n").filter(Boolean).map(l => JSON.parse(l) as string[]).find(args => args[0] === "respawn-pane")!;
  // tap-p9v8: tmux starts the pane in a directory that outlives every worktree; the command enters the workdir.
  expect(respawn[respawn.indexOf("-c") + 1]).not.toBe(dir);
  expect(respawn.at(-1)!.startsWith(inWorkdir(dir, "exec "))).toBe(true);
  expect(f.current().seats.alice.launch_workdir).toBe(dir);
});

test.each([
  ["a custody refusal", { fenceAfterRespawn: process.pid }, /team_reset_fenced|reset/i],
  ["a clear expectation that changed under us", { swapNonceAfterRespawn: true }, /row is gone or its clear expectation changed/],
] as const)("an explicit --workdir that cannot be persisted is exit 7, names the new directory, and leaves the old one (%s)", async (_label, flags, detailPattern) => {
  const f = fixture(), dir = lane(f);
  writeFileSync(f.state, JSON.stringify({ replaced: false, drift: null, ...flags }));
  const result = await relaunchOne(f.prepared(), { json: false, dryRun: false, workdir: dir }, caller);
  expect(result.code).toBe(7); expect(result.error_class).toBe("launch_workdir_unpersisted");
  expect(result.reason).toContain(`the harness now runs in ${dir}`); expect(result.reason).toContain("was NOT updated");
  expect(result.reason).toContain("tmux attach"); expect(result.reason).toMatch(detailPattern);
  expect(f.effects().match(/respawn-pane/g)).toHaveLength(1); // never retried
  expect(f.current().seats.alice.launch_workdir).toBeUndefined();
});

test("a relaunch without --workdir still treats a failed nonce cleanup as a warning, not exit 7", async () => {
  const f = fixture();
  writeFileSync(f.state, JSON.stringify({ replaced: false, drift: null, swapNonceAfterRespawn: true }));
  const result = await relaunchOne(f.prepared(), { json: false, dryRun: false }, caller);
  expect(result.code).toBe(0);
});

test("a dry run names the target workdir only when --workdir was given", async () => {
  const f = fixture(), dir = lane(f);
  const explicit = await relaunchOne(f.prepared(), { json: false, dryRun: true, workdir: dir }, caller);
  expect(explicit.code).toBe(0); expect(explicit.workdir).toBe(dir);
  expect((await relaunchOne(f.prepared(), { json: false, dryRun: true }, caller)).workdir).toBeUndefined();
});

test("an interruption after a successful respawn still records the explicit workdir", async () => {
  const f = fixture(), dir = lane(f);
  // stuck: the pid never changes, so readiness keeps waiting and the abort lands after the respawn.
  writeFileSync(f.state, JSON.stringify({ replaced: false, drift: null, stuck: true }));
  const controller = new AbortController();
  const running = relaunchOne(f.prepared(), { json: false, dryRun: false, workdir: dir }, caller, { signal: controller.signal });
  for (let i = 0; i < 200 && !f.effects().includes("respawn-pane"); i++) await Bun.sleep(25);
  expect(f.effects()).toContain("respawn-pane");
  controller.abort();
  const result = await running;
  expect(result.code).toBe(130); expect(result.error_class).toBe("relaunch_interrupted");
  expect(result.reason).toContain(`launch_workdir recorded as ${dir}`);
  expect(f.current().seats.alice.launch_workdir).toBe(dir);
  expect(f.current().seats.alice.expected_clear_nonce).toBeUndefined();
  expect(f.effects().match(/respawn-pane/g)).toHaveLength(1);
});

test("an interruption before any respawn leaves the recorded workdir alone", async () => {
  const f = fixture(), dir = lane(f), controller = new AbortController();
  controller.abort();
  const result = await relaunchOne(f.prepared(), { json: false, dryRun: false, workdir: dir }, caller, { signal: controller.signal });
  expect(result.error_class).toBe("relaunch_interrupted");
  expect(f.current().seats.alice.launch_workdir).toBeUndefined();
});

test("an old-store registry after the respawn still reports launch_workdir_unpersisted, with the old_store detail", async () => {
  const f = fixture(), dir = lane(f);
  writeFileSync(f.state, JSON.stringify({ replaced: false, drift: null, oldAfter: true }));
  const result = await relaunchOne(f.prepared(), { json: false, dryRun: false, workdir: dir }, caller);
  expect(result.code).toBe(7); expect(result.error_class).toBe("launch_workdir_unpersisted");
  expect(result.reason).toContain(`the harness now runs in ${dir}`); expect(result.reason).toContain("old_store");
  expect(f.effects().match(/respawn-pane/g)).toHaveLength(1);
});

test("a cancellation after a code-0 respawn whose workdir write FAILS is launch_workdir_unpersisted, with the interruption beside it", async () => {
  const f = fixture(), dir = lane(f), controller = new AbortController(), signal = controller.signal, registryDir = dirname(f.scope.registryPath);
  writeFileSync(f.state, JSON.stringify({ replaced: false, drift: null, readonlyAfter: true }));
  const check = signal.throwIfAborted.bind(signal);
  signal.throwIfAborted = () => { if (f.effects().includes("respawn-pane") && !signal.aborted) controller.abort(); check(); };
  try {
    const result = await relaunchOne(f.prepared(), { json: false, dryRun: false, workdir: dir }, caller, { signal });
    expect(result.code).toBe(7); expect(result.error_class).toBe("launch_workdir_unpersisted");
    expect(result.reason).toContain(`the harness now runs in ${dir}`); expect(result.reason).toContain("also relaunch_interrupted");
    expect(result.reason).toContain("do not relaunch again"); expect(result.reason).not.toContain("inspect before deciding whether to relaunch");
    expect(f.effects().match(/respawn-pane/g)).toHaveLength(1);
  } finally { chmodSync(registryDir, 0o755); }
});

test("a cancellation that races a code-0 respawn still records the explicit workdir", async () => {
  const f = fixture(), dir = lane(f), controller = new AbortController(), signal = controller.signal;
  // The first abort check after the respawn has returned fires the abort, then throws: the exact boundary
  // between respawn-pane returning 0 and the respawn being recorded.
  const check = signal.throwIfAborted.bind(signal);
  signal.throwIfAborted = () => { if (f.effects().includes("respawn-pane") && !signal.aborted) controller.abort(); check(); };
  const result = await relaunchOne(f.prepared(), { json: false, dryRun: false, workdir: dir }, caller, { signal });
  expect(result.error_class).toBe("relaunch_interrupted");
  expect(result.reason).toContain(`launch_workdir recorded as ${dir}`);
  expect(f.current().seats.alice.launch_workdir).toBe(dir);
  expect(f.effects().match(/respawn-pane/g)).toHaveLength(1);
});

test("a registry write that THROWS after the respawn is exit 7 launch_workdir_unpersisted, naming the cause", async () => {
  const f = fixture(), dir = lane(f), registryDir = dirname(f.scope.registryPath);
  // The registry directory turns read-only right after the respawn, so the row update fails with an error, not a refusal.
  writeFileSync(f.state, JSON.stringify({ replaced: false, drift: null, readonlyAfter: true }));
  try {
    const result = await relaunchOne(f.prepared(), { json: false, dryRun: false, workdir: dir }, caller);
    expect(result.code).toBe(7); expect(result.error_class).toBe("launch_workdir_unpersisted");
    expect(result.reason).toContain(`the harness now runs in ${dir}`); expect(result.reason).toContain("was NOT updated");
    expect(result.reason).toMatch(/EACCES|EPERM|permission|registry_write_failed/i);
    expect(f.effects().match(/respawn-pane/g)).toHaveLength(1);
  } finally { chmodSync(registryDir, 0o755); }
});

test("any other exception after a successful respawn is exit 7 post-effect, records the workdir, and never retries", async () => {
  const f = fixture(), dir = lane(f);
  // A throw from the progress callback lands inside the post-respawn observation, like a late spawn error would.
  const progress = (line: string) => { if (line.startsWith("respawn attempted")) throw new Error("late observation failure"); };
  const result = await relaunchOne(f.prepared(), { json: false, dryRun: false, workdir: dir }, caller, { progress });
  expect(result.code).toBe(7); expect(result.error_class).toBe("post_respawn_error");
  expect(result.reason).toContain("late observation failure"); expect(result.reason).toContain(`launch_workdir recorded as ${dir}`);
  expect(result.reason).toContain("do not relaunch again");
  expect(f.current().seats.alice.launch_workdir).toBe(dir);
  expect(f.current().seats.alice.expected_clear_nonce).toBeUndefined();
  expect(f.effects().match(/respawn-pane/g)).toHaveLength(1);
});

test("an exception AFTER the row was saved reports recorded, not NOT updated, and never consumes the nonce twice", async () => {
  const f = fixture(), dir = lane(f), p = f.plan();
  // Verified rebind, then the opencode instruction send THROWS: the nonce is already consumed and the row
  // already names the new directory, so the unwind must say recorded instead of re-consuming into a no-op.
  const sendInstruction = async () => { throw new Error("late instruction failure"); };
  const result = await replaceHarnessInPane(f.scope, p, { verb: "tap session relaunch", handle: "alice", instruction: "carry on", clearHistory: false,
    relaunch: { identity: relaunchIdentity(f.row), resume: "conversation" }, launchWorkdir: dir, sendInstruction });
  expect(result.code).toBe(7); expect(result.errorClass).toBe("post_respawn_error");
  expect(result.detail).toContain("late instruction failure"); expect(result.detail).toContain(`launch_workdir recorded as ${dir}`);
  expect(result.detail).not.toContain("NOT updated");
  expect(f.current().seats.alice.launch_workdir).toBe(dir);
  expect(f.effects().match(/respawn-pane/g)).toHaveLength(1);
});

test("a readiness timeout or another late exception plus a FAILED workdir write reports launch_workdir_unpersisted with the original error", async () => {
  for (const [label, failure, original] of [
    ["timeout", () => new PaneObservationTimeout("%7"), "pane_observation_timeout"],
    ["exception", () => new Error("late observation failure"), "post_respawn_error: late observation failure"],
  ] as const) {
    const f = fixture(), dir = lane(f), registryDir = dirname(f.scope.registryPath);
    // The registry directory turns read-only at the respawn, so the row update fails; the throw then lands in the observation.
    writeFileSync(f.state, JSON.stringify({ replaced: false, readonlyAfter: true }));
    const progress = (line: string) => { if (line.startsWith("respawn attempted")) throw failure(); };
    try {
      const result = await replaceHarnessInPane(f.scope, f.plan(), { verb: "tap session relaunch", handle: "alice", instruction: null, clearHistory: false,
        relaunch: { identity: relaunchIdentity(f.row), resume: "conversation" }, launchWorkdir: dir, progress });
      expect([label, result.code, result.errorClass]).toEqual([label, 7, "launch_workdir_unpersisted"]);
      expect(result.detail).toContain(`the harness now runs in ${dir}`); expect(result.detail).toContain("was NOT updated");
      expect(result.detail).toMatch(/EACCES|EPERM|permission|registry_write_failed/i);
      expect(result.detail).toContain(`also ${original}`);
      expect(result.action).toContain("do not relaunch again");
      expect(f.effects().match(/respawn-pane/g)).toHaveLength(1);
    } finally { chmodSync(registryDir, 0o755); }
  }
});

test("relaunch --workdir refuses before respawn when the conversation store exists only under the OLD directory", async () => {
  const f = fixture("cursor"), dir = lane(f), cursorHome = join(f.root, "cursor-home");
  process.env.TAP_CURSOR_HOME = cursorHome;
  const store = (workdir: string) => join(cursorHome, "chats", createHash("md5").update(workdir, "utf8").digest("hex"), "conversation", "store.db");
  mkdirSync(dirname(store(f.root)), { recursive: true }); writeFileSync(store(f.root), "");
  const before = readFileSync(f.scope.registryPath, "utf8");
  const refused = await relaunchOne(f.prepared(), { json: false, dryRun: false, workdir: dir }, caller);
  expect(refused.code).toBe(2); expect(refused.error_class).toBe("resume_unavailable_in_workdir");
  expect(refused.reason).toContain("nothing was replaced"); expect(refused.reason).toContain(dir);
  expect(f.effects()).not.toContain("respawn-pane");
  expect(readFileSync(f.scope.registryPath, "utf8")).toBe(before);
  // Control: the same move with the store present under the NEW directory proceeds and records it.
  mkdirSync(dirname(store(dir)), { recursive: true }); writeFileSync(store(dir), "");
  const moved = await relaunchOne(f.prepared(), { json: false, dryRun: false, workdir: dir }, caller);
  expect(moved.code).toBe(0);
  expect(f.effects().match(/respawn-pane/g)).toHaveLength(1);
  expect(f.current().seats.alice.launch_workdir).toBe(dir);
});

// tap-iuno2: `codex resume <id>` resolves the id across ~/.codex/sessions (the cwd filter belongs to the picker, `--all` lifts it),
// so a rollout recorded under the OLD or another directory is no reason to refuse the move; an id found nowhere still is, because
// the unknown id would hard-exit after the live harness was killed.
function codexStore(f: { root: string }, rollout?: { id: string; cwd: string }, name = "codex-home"): string {
  const codexHome = join(f.root, name), day = join(codexHome, "sessions", "2026", "10", "01");
  mkdirSync(day, { recursive: true });
  if (rollout) writeFileSync(join(day, `rollout-2026-10-01T00-00-00-${rollout.id}.jsonl`),
    JSON.stringify({ type: "session_meta", payload: { id: rollout.id, cwd: rollout.cwd } }) + "\n");
  return codexHome;
}

test("relaunch --workdir moves a Codex seat whose rollout is recorded only under the OLD directory", async () => {
  const f = fixture("codex"), dir = lane(f);
  process.env.TAP_CODEX_HOME = codexStore(f, { id: "conversation", cwd: f.root });
  const moved = await relaunchOne(f.prepared(), { json: false, dryRun: false, workdir: dir }, caller);
  expect(moved.error_class).toBeUndefined(); expect(moved.code).toBe(0);
  expect(f.effects().match(/respawn-pane/g)).toHaveLength(1);
  expect(f.current().seats.alice.launch_workdir).toBe(dir);
});

test("relaunch --workdir refuses a Codex seat whose id exists in no rollout, and a rollout for a different id does not count", async () => {
  const f = fixture("codex"), dir = lane(f);
  process.env.TAP_CODEX_HOME = codexStore(f, { id: "someone-else", cwd: dir });
  const before = readFileSync(f.scope.registryPath, "utf8");
  for (const dryRun of [true, false]) {
    const refused = await relaunchOne(f.prepared(), { json: false, dryRun, workdir: dir }, caller);
    expect(refused.code).toBe(2); expect(refused.error_class).toBe("resume_unavailable_in_workdir");
    expect(refused.reason).toContain("nothing was replaced");
  }
  expect(f.effects()).not.toContain("respawn-pane");
  expect(readFileSync(f.scope.registryPath, "utf8")).toBe(before);
});

// The root that counts is the one the RELAUNCHED harness reads: the seat's declared CODEX_HOME, not the caller's ambient one.
test.each([
  ["the id is only in the ambient store", true, 2],
  ["the id is only in the seat's declared store", false, 0],
] as const)("relaunch --workdir checks the seat's declared CODEX_HOME, not the ambient one: %s", async (_label, idInAmbient, code) => {
  const f = fixture("codex"), dir = lane(f);
  const ambient = codexStore(f, idInAmbient ? { id: "conversation", cwd: f.root } : undefined, "ambient-home");
  const declared = codexStore(f, idInAmbient ? undefined : { id: "conversation", cwd: f.root }, "seat-home");
  process.env.CODEX_HOME = ambient; delete process.env.TAP_CODEX_HOME;
  Object.assign(f.row, { harness_env: { CODEX_HOME: declared } }); f.update(f.row);
  const result = await relaunchOne(f.prepared(), { json: false, dryRun: false, workdir: dir }, caller);
  expect(result.code).toBe(code);
  if (code === 0) { expect(f.effects().match(/respawn-pane/g)).toHaveLength(1); expect(f.current().seats.alice.launch_workdir).toBe(dir); }
  else { expect(result.error_class).toBe("resume_unavailable_in_workdir"); expect(f.effects()).not.toContain("respawn-pane"); }
});

// tap-4tclq: a Codex resume from a directory other than the rollout's saved cwd stops at Codex's "Working directory · resume" prompt
// (observed live, codex-cli 0.159.3), so the composed relaunch command names its destination with --cd. A resume by explicit id is not
// cwd-keyed, so the same-folder case names it too and no transcript is read.
const cdFlags = (command: string | undefined) => (command ?? "").match(/--cd\b/g) ?? [];

test.each([
  ["--workdir moving the seat", "move", true],
  ["--workdir naming the directory the rollout already records", "same", true],
  ["no --workdir, the seat staying where it was", "stay", false],
] as const)("relaunch passes the destination to a Codex resume: %s", async (_label, kind, withWorkdir) => {
  const f = fixture("codex"), dir = lane(f);
  process.env.TAP_CODEX_HOME = codexStore(f, { id: "conversation", cwd: kind === "move" || kind === "stay" ? f.root : dir });
  const preview = await relaunchOne(f.prepared(), { json: false, dryRun: true, workdir: withWorkdir ? dir : undefined }, caller);
  expect(preview.code).toBe(0);
  expect(cdFlags(preview.stdout)).toHaveLength(1);
  const destination = withWorkdir ? dir : f.root;
  expect(preview.stdout).toMatch(new RegExp(`resume .*--cd '?${destination.replace(/[/.]/g, "\\$&")}'? conversation`));
});

test.each([
  ["harness_tail", ["--cd", "/stored/choice"]],
  ["passthrough", ["-C", "/stored/choice"]],
  ["harness_tail", ["-c", 'tui.resume_cwd="session"']],
] as const)("relaunch --workdir leaves a stored directory choice alone: %s %j", async (key, tokens) => {
  const f = fixture("codex"), dir = lane(f);
  process.env.TAP_CODEX_HOME = codexStore(f, { id: "conversation", cwd: f.root });
  Object.assign(f.row, { [key]: [...tokens] }); f.update(f.row);
  const preview = await relaunchOne(f.prepared(), { json: false, dryRun: true, workdir: dir }, caller);
  expect(preview.code).toBe(0);
  expect((preview.stdout ?? "").match(/--cd\b|\s-C\b/g) ?? []).toHaveLength(tokens[0] === "-c" ? 0 : 1);
  expect(preview.stdout).toContain(tokens[1]!.includes("tui.") ? "tui.resume_cwd" : "/stored/choice");
});

test("relaunch --workdir accepts a Claude seat whose resolved conversation is the quarantined fallback", async () => {
  const f = fixture("claude"), dir = lane(f), project = join(f.root, "claude/projects/demo");
  mkdirSync(project, { recursive: true }); process.env.TAP_CLAUDE_HOME = join(f.root, "claude");
  // The acting id has no transcript; the resolver selects the quarantined id, whose transcript exists.
  Object.assign(f.row, { harness_session_id: "ghost", quarantined_harness_session_id: "saved", transcript_path: null }); f.update(f.row);
  writeFileSync(join(project, "saved.jsonl"), "{}");
  const member = f.prepared(); expect(member.expect_resume).toBe("saved");
  const moved = await relaunchOne(member, { json: false, dryRun: false, workdir: dir }, caller);
  expect(moved.error_class).toBeUndefined(); expect(moved.code).toBe(0);
  expect(f.effects().match(/respawn-pane/g)).toHaveLength(1);
  expect(f.current().seats.alice.launch_workdir).toBe(dir);
});

test("relaunch --workdir accepts a Claude seat whose acting id is valid but whose transcript_path is stale", async () => {
  const f = fixture("claude"), dir = lane(f), project = join(f.root, "claude/projects/demo");
  mkdirSync(project, { recursive: true }); process.env.TAP_CLAUDE_HOME = join(f.root, "claude");
  Object.assign(f.row, { harness_session_id: "acting", transcript_path: join(project, "gone.jsonl") }); f.update(f.row);
  writeFileSync(join(project, "acting.jsonl"), "{}");
  const member = f.prepared(); expect(member.expect_resume).toBe("acting");
  const moved = await relaunchOne(member, { json: false, dryRun: false, workdir: dir }, caller);
  expect(moved.error_class).toBeUndefined(); expect(moved.code).toBe(0);
  expect(f.current().seats.alice.launch_workdir).toBe(dir);
});

test("the launch_workdir_unpersisted action points at inspection, never at a second relaunch", async () => {
  const f = fixture(), dir = lane(f);
  writeFileSync(f.state, JSON.stringify({ replaced: false, drift: null, swapNonceAfterRespawn: true }));
  const result = await relaunchOne(f.prepared(), { json: false, dryRun: false, workdir: dir }, caller);
  expect(result.error_class).toBe("launch_workdir_unpersisted");
  expect(result.reason).toContain("do not relaunch again"); expect(result.reason).toContain("tap doctor");
  expect(result.reason).not.toContain("repeat the relaunch");
});

// launch_witness lifecycle (launch-evidence.ts; leader ruling 2026-10-01): retiring
// a nonce never promotes by itself. A verified replacement promotes the nonce, an
// unverified post-effect outcome clears the token, and a pre-effect refusal keeps
// the live incarnation's token.
test("a verified replacement promotes its nonce to launch_witness", async () => {
  const f = fixture(); f.update({ launch_witness: "old" });
  const result = await replaceHarnessInPane(f.scope, f.plan(), { verb: "tap session relaunch", handle: "alice", instruction: null, clearHistory: false,
    relaunch: { identity: relaunchIdentity(f.row), resume: "conversation" } });
  expect(result.code).toBe(0);
  expect(f.current().seats.alice.launch_witness).toBe("ours");
});

test("an unverified replacement clears launch_witness instead of promoting either incarnation", async () => {
  const f = fixture(); f.update({ launch_witness: "old" });
  writeFileSync(f.state, JSON.stringify({ replaced: false, stuck: true }));
  const result = await replaceHarnessInPane(f.scope, f.plan(), { verb: "tap session relaunch", handle: "alice", instruction: null, clearHistory: false,
    relaunch: { identity: relaunchIdentity(f.row), resume: "conversation" } });
  expect(result.code).toBe(7);
  expect(f.current().seats.alice.launch_witness).toBeUndefined();
});

test("a failed respawn before any effect keeps the live incarnation's launch_witness", async () => {
  const f = fixture(); f.update({ launch_witness: "old" });
  writeFileSync(f.state, JSON.stringify({ failExit: 2 }));
  const result = await relaunchOne(f.prepared(), { json: false, dryRun: false }, caller);
  expect(result.error_class).toBe("tmux_error");
  expect(f.current().seats.alice.launch_witness).toBe("old");
  expect(f.current().seats.alice.expected_clear_nonce).toBeUndefined();
});

test("the relaunch invocation carries the team root SessionStart binds through", async () => {
  const f = fixture();
  const result = await relaunchOne(f.prepared(), { json: false, dryRun: true }, caller);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(`TAP_LAUNCH_ROOT=${f.root}`);
  expect(result.stdout).toContain("TAP_CLEAR_ID=");
});

test("OpenCode relaunch refuses a different native directory before replacing the seat", async () => {
  const f=fixture(), dir=lane(f,"original");
  const before=readFileSync(f.scope.registryPath,"utf8");
  for(const dryRun of [true,false]){
    const result=await relaunchOne(f.prepared(),{json:false,dryRun,workdir:dir},caller);
    expect(result.error_class).toBe("resume_unavailable_in_workdir");
    expect(result.reason).toContain("bound to their directory");
    expect(f.effects()).toBe("");expect(readFileSync(f.scope.registryPath,"utf8")).toBe(before);
  }
  const alias=join(f.root,"alias");symlinkSync(f.root,alias);
  const unchanged=await relaunchOne(f.prepared(),{json:false,dryRun:true,workdir:alias},caller);
  expect(unchanged.code).toBe(0);expect(f.effects()).toBe("");
});


test("auto-nudge composes exactly one native Codex resume prompt only for working seats", async () => {
  const f = fixture("codex");
  writeFileSync(f.state, JSON.stringify({replaced:false,publicCensus:true}));
  process.env.TAP_CODEX_HOME = codexStore(f, {id:"conversation",cwd:f.root});
  for (const state of ["working", "idle", "unknown"] as const) {
    const output: string[] = [];
    const deps = {
      context: () => ({team:"Demo",caller_pane:"",caller}), classify, prepare:prepareRelaunch, run:relaunchOne,
      states: (rows: ClassifiedMember[]) => new Map(rows.map(row => [row.member, {agent_state:state,agent_state_reason:`fixture_${state}`} ])),
      crew:crewMember, load:loadGlobalRegistry, write:(text:string) => {output.push(text);}, color:false,
    };
    expect(await relaunch(parseOptions(["Demo/alice", "--auto-nudge=continue after switch", "--dry-run", "--json"]), deps)).toBe(0);
    const receipt = JSON.parse(output.join(""));
    expect(receipt.results).toHaveLength(1);
    const command = receipt.results[0].stdout;
    expect(command).toContain("resume"); expect(command).toContain("conversation");
    expect(command.match(/\[\[TAP v0\.23 nudge message="[^"\n]*continue after switch"\]\]/g) ?? []).toHaveLength(state === "working" ? 1 : 0);
    expect(f.effects()).toBe("");
  }
});

// A preset-launched seat: launch bakes the preset's env and passthrough into the row, and machine policy adds its own.
function presetSeat(harness: "codex" | "claude") {
  const f = fixture(harness);
  mkdirSync(join(f.root, "xdg/tap"), { recursive: true });
  writeFileSync(join(f.root, "xdg/tap/config.toml"), `version = 3\n[harness.${harness}]\nenv.PONYTAIL_DEFAULT_MODE = "off"\nenv.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "111111"\n`, { mode: 0o600 });
  process.env.XDG_CONFIG_HOME = join(f.root, "xdg");
  if (harness === "claude") {
    mkdirSync(join(f.root, "claude/projects/demo"), { recursive: true });
    writeFileSync(join(f.root, "claude/projects/demo/conversation.jsonl"), "{}");
    process.env.TAP_CLAUDE_HOME = join(f.root, "claude");
  }
  const seat = { passthrough_from_config: true, preset: { name: "astra-fast", source_path: join(f.root, "xdg/tap/config.toml"), config_digest: "fixture" },
    passthrough: harness === "codex" ? ["-c", "model_context_window=500000", "-c", "model_auto_compact_token_limit=400000"] : [],
    harness_env: harness === "claude" ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500000", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "90", PONYTAIL_DEFAULT_MODE: "off" } : { PONYTAIL_DEFAULT_MODE: "off" } };
  Object.assign(f.row, seat); f.update(seat);
  return f;
}
const sugarDeps = (member: Member, writes: string[]) => ({ context: () => ({ team: "Demo", caller_pane: "", caller }), prepare: prepareRelaunch, run: relaunchOne, crew: crewMember,
  classify: (members: Member[]) => members.map(m => ({ member: m, status: "active", reason: "", pane: "%7", observation: {} })) as unknown as ClassifiedMember[],
  states: () => new Map(), load: loadGlobalRegistry, write: (text: string) => { writes.push(text); }, color: false });
/** The command a dry run would respawn, through the same census, expansion and composition a live run uses. */
async function dryCommand(f: ReturnType<typeof fixture>, flags: string[] = []): Promise<string> {
  const writes: string[] = [];
  // TAP's own options go first: flags may end in a `--` tail that would swallow them.
  expect(await relaunch(parseOptions(["Demo/alice", "--dry-run", "--json", ...flags]), sugarDeps(f.member, writes))).toBe(0);
  return JSON.parse(writes.join("")).results[0].stdout;
}
/** One real replacement through the stub; the stub's pid resets afterwards so a second one can verify a new process too. */
const live = async (f: ReturnType<typeof fixture>, flags: string[]) => {
  const writes: string[] = [];
  const code = await relaunch(parseOptions(["Demo/alice", "--json", ...flags]), sugarDeps(f.member, writes));
  expect(code, writes.join("")).toBe(0);
  writeFileSync(f.state, JSON.stringify({ replaced: false }));
};
// Each real replacement waits on the stub's readiness; the default 30 s budget is too tight on a loaded runner.
const SLOW = 120_000;

test("a codex dry run shows the expansion after the resume target and changes nothing", async () => {
  const f = fixture("codex"), before = readFileSync(f.scope.registryPath, "utf8");
  const command = await dryCommand(f, ["--context", "850k", "--ponytail", "lite"]);
  expect(command).toMatch(/resume .*conversation.* -c model_context_window=850000 -c model_auto_compact_token_limit=807500/);
  expect(command).toContain("PONYTAIL_DEFAULT_MODE=lite");
  expect(readFileSync(f.scope.registryPath, "utf8")).toBe(before); expect(f.effects()).toBe("");
});

test("a claude dry run shows the expansion in the child env", async () => {
  const f = presetSeat("claude");
  const command = await dryCommand(f, ["--context", "1.5M", "--ponytail", "full"]);
  expect(command).toContain("CLAUDE_CODE_AUTO_COMPACT_WINDOW=1500000");
  expect(command).toContain("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=95");
  expect(command).toContain("PONYTAIL_DEFAULT_MODE=full");
  expect(command).not.toContain("model_context_window");
});

test("a second --context replaces the first on the row instead of stacking", async () => {
  const f = fixture("codex");
  f.update({ harness_tail: ["--verbose"] });
  await live(f, ["--context", "850k"]);
  expect(f.current().seats.alice.harness_tail).toEqual(["--verbose", "-c", "model_context_window=850000", "-c", "model_auto_compact_token_limit=807500"]);
  await live(f, ["--context", "1M"]);
  expect(f.current().seats.alice.harness_tail).toEqual(["--verbose", "-c", "model_context_window=1000000", "-c", "model_auto_compact_token_limit=950000"]);
  const command = await dryCommand(f);
  expect(command.match(/model_context_window=/g)).toHaveLength(1);
}, SLOW);

test("a typed native -- keeps the generated options ahead of it on the respawn command and the row", async () => {
  const f = fixture("codex");
  const command = await dryCommand(f, ["--context", "850k", "--", "--", "continue"]);
  expect(command).toMatch(/resume .*conversation.* -c model_context_window=850000 -c model_auto_compact_token_limit=807500 -- continue/);
  await live(f, ["--context", "850k", "--", "--", "continue"]);
  expect(f.current().seats.alice.harness_tail).toEqual(["-c", "model_context_window=850000", "-c", "model_auto_compact_token_limit=807500", "--", "continue"]);
}, SLOW);

test("a stored native -- keeps a later --context ahead of it, replacing the earlier pair", async () => {
  const f = fixture("codex");
  f.update({ harness_tail: ["-cmodel_context_window=1", "--", "continue"] });
  const command = await dryCommand(f, ["--context", "1M"]);
  expect(command).toMatch(/resume .*conversation.* -c model_context_window=1000000 -c model_auto_compact_token_limit=950000 -- continue/);
  expect(command).not.toContain("model_context_window=1 ");
  await live(f, ["--context", "1M"]);
  expect(f.current().seats.alice.harness_tail).toEqual(["-c", "model_context_window=1000000", "-c", "model_auto_compact_token_limit=950000", "--", "continue"]);
}, SLOW);

test("on a preset codex seat the flag lands after passthrough and still does on a later flag-free relaunch", async () => {
  const f = presetSeat("codex");
  const last = (command: string, key: string) => command.slice(command.lastIndexOf(`${key}=`)).split(/[\s']/)[0];
  const typed = await dryCommand(f, ["--context", "850k", "--ponytail", "lite"]);
  expect(last(typed, "model_context_window")).toBe("model_context_window=850000");
  expect(last(typed, "model_auto_compact_token_limit")).toBe("model_auto_compact_token_limit=807500");
  expect(typed.indexOf("model_context_window=500000")).toBeLessThan(typed.indexOf("model_context_window=850000"));
  await live(f, ["--context", "850k", "--ponytail", "lite"]);
  const row = f.current().seats.alice;
  expect(row.harness_env).toEqual({ PONYTAIL_DEFAULT_MODE: "lite" });
  expect(row.passthrough).toEqual(["-c", "model_context_window=500000", "-c", "model_auto_compact_token_limit=400000"]);
  const later = await dryCommand(f);
  expect(last(later, "model_context_window")).toBe("model_context_window=850000");
  expect(last(later, "model_auto_compact_token_limit")).toBe("model_auto_compact_token_limit=807500");
  expect(later).toContain("PONYTAIL_DEFAULT_MODE=lite");
  expect(later).not.toContain("PONYTAIL_DEFAULT_MODE=off");
}, SLOW);

test("on a preset claude seat the flag beats preset and machine policy, then and on a later flag-free relaunch", async () => {
  const f = presetSeat("claude");
  await live(f, ["--context", "850k", "--ponytail", "lite"]);
  expect(f.current().seats.alice.harness_env).toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "850000", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "95", PONYTAIL_DEFAULT_MODE: "lite" });
  const later = await dryCommand(f);
  for (const expected of ["CLAUDE_CODE_AUTO_COMPACT_WINDOW=850000", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=95", "PONYTAIL_DEFAULT_MODE=lite"]) expect(later).toContain(expected);
  for (const beaten of ["CLAUDE_CODE_AUTO_COMPACT_WINDOW=500000", "CLAUDE_CODE_AUTO_COMPACT_WINDOW=111111", "PONYTAIL_DEFAULT_MODE=off", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=90"]) expect(later).not.toContain(beaten);
}, SLOW);

test("the router walks a dry run in text and --json, and an unsupported seat leaves the row alone", () => {
  const f = fixture("codex");
  writeFileSync(f.state, JSON.stringify({ replaced: false, publicCensus: true }));
  writeFileSync(join(f.root, "bin/ps"), "#!/bin/sh\nprintf '1 fixture-caller\\n'\n", { mode: 0o755 });
  const before = readFileSync(f.scope.registryPath, "utf8");
  const env = { ...process.env, TAP_BOOT_ID: "bootuuid:00000000-0000-0000-0000-000000000001", TAP_BOOT_ID_LEGACY: "boot:1", TAP_JSON: "0" };
  const run = (...args: string[]) => spawnSync(resolve(import.meta.dir, "../../../bin/tap"), ["session", "relaunch", ...args], { cwd: f.root, env, encoding: "utf8", timeout: 20000 });
  const text = run("--harness", "codex", "--team", "Demo", "--context", "850k", "--dry-run");
  expect(text.status, text.stdout + text.stderr).toBe(0);
  // Codex may add its receipt-folder warning line between the preview and the result dot.
  const lines = text.stdout.trimEnd().split("\n");
  expect(lines.slice(0, 2)).toEqual(["Would relaunch 1 active codex seats on team Demo", "  would apply -c model_context_window=850000 -c model_auto_compact_token_limit=807500"]);
  expect(lines.at(-1)).toBe("● Demo/alice");
  const json = run("--harness", "codex", "--team", "Demo", "--context", "850k", "--dry-run", "--json");
  expect(json.status, json.stdout + json.stderr).toBe(0);
  expect(JSON.parse(json.stdout).results[0]).toMatchObject({ handle: "alice", status: "would-resume" });
  expect(JSON.parse(json.stdout).results[0].stdout).toContain("-c model_auto_compact_token_limit=807500");
  const refused = run("--harness", "cursor", "--team", "Demo", "--ponytail", "off", "--json");
  expect(refused.status).toBe(2);
  expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, error_class: "launch_ponytail_unsupported", detail: "harness 'cursor' does not support --ponytail (supported by: claude, codex)" });
  expect(readFileSync(f.scope.registryPath, "utf8")).toBe(before); expect(f.effects()).toBe("");
});
