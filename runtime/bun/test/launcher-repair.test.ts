import { shlexQuote } from "../src/launcher/invocation";
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseRepairPane, repairRecord, PANE_FACTS_FORMAT, type RepairStatus } from "../src/launcher/repair";
import { payloadRecords, sessionHandle, type SessionRecord } from "../src/launcher/records";
import { isMap, loads } from "../src/watch-detect";
import { removeScratchTree } from "./support/scratch";
import { writeLiveFence } from "./support/live-fence";

const repo = resolve(import.meta.dir, "../../..");
const door = join(repo, "runtime/bun/src/launcher/repair.ts");
const arena = realpathSync(mkdtempSync(join(tmpdir(), "tap-repair-")));
afterAll(() => removeScratchTree(arena));

const fakeTmux = String.raw`#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
let args = process.argv.slice(2);
if (["-S", "-L"].includes(args[0])) args = args.slice(2);
const path = process.env.REPAIR_TMUX_STATE;
let state = JSON.parse(readFileSync(path, "utf8"));
const reply = (data) => {
  if (data && typeof data === "object") {
    if (data.delay) Bun.sleepSync(data.delay);
    process.stdout.write(data.stdout || "");
    process.stderr.write(data.stderr || "");
    process.exit(data.code || 0);
  }
  process.stdout.write(String(data) + "\n");
  process.exit(0);
};
const target = (args[args.indexOf("-t") + 1] || "").replace(/^=/, "");
if (args[0] === "list-sessions") {
  if (state.gate) {
    writeFileSync(state.gate + ".ready", "");
    while (!existsSync(state.gate + ".release")) Bun.sleepSync(10);
  }
  if (state.removeRow) {
    const [registry, handle] = state.removeRow;
    const doc = JSON.parse(readFileSync(registry, "utf8"));
    delete doc.seats[handle];
    writeFileSync(registry, JSON.stringify(doc));
  }
  reply(state.namespace ?? "repo/scout");
}
if (args[0] === "has-session") process.exit((state.live || ["repo/scout"]).includes(target) ? 0 : 1);
if (args[0] === "display-message") {
  const format = args[args.length - 1];
  if (format === "#{pid}:#{start_time}") reply(state.epoch || "900:100");
  if (format === "#{pid}:#{start_time}\t#{socket_path}") reply((state.epoch || "900:100") + "\t" + (state.socket || "/tmp/repair-fixture.sock"));
  const pane = state.panes[target];
  if (!pane) reply({code: 1, stderr: "can't find pane: " + target});
  if (state.afterPaneEpoch) {
    state.epoch = state.afterPaneEpoch;
    delete state.afterPaneEpoch;
    writeFileSync(path, JSON.stringify(state));
  }
  if (format === "#{pane_pid}") reply(typeof pane === "string" ? pane.split("\t")[5] : pane);
  reply(pane);
}
if (args[0] === "list-panes") reply(state.candidates ?? Object.values(state.panes).filter(p => typeof p === "string").join("\n"));
process.stderr.write("unexpected tmux operation: " + JSON.stringify(args));
process.exit(97);
`;

function facts(pane = "repo/scout:0.0", id = "%7", command = "claude", epoch = "900:100", path = "/unused"): string {
  return [pane, id, command, epoch, "0", "777", path].join("\t");
}

function fixture() {
  const base = mkdtempSync(join(arena, "case-"));
  const root = join(base, "repo"), registry = join(base, "authority", "registry.json"), statePath = join(base, "tmux.json");
  for (const path of [root, join(base, "authority"), join(base, "bin"), join(base, "home"), join(base, "index"), join(root, ".tap", "bus")]) mkdirSync(path, { recursive: true });
  expect(spawnSync("git", ["init", "--quiet", root]).status).toBe(0);
  const row: Record<string, any> = {
    session: "repo/scout", harness: "claude", base: "repo", tag: "scout", index: 1,
    status: "active", status_reason: "", delivery: "pane", pane: "repo/scout:0.0", pane_id: "%7",
    pane_current_command: "claude", server_epoch: "srv:900:100", server_socket: "/tmp/repair-fixture.sock",
    boot_id: "boot:100", registered_from_worktree: root, registered_at: "old", instance: "scout|same",
    harness_session_id: "conversation", transcript_path: "/keep/transcript", model: "keep-model", passthrough: ["--keep"],
  };
  const doc: Record<string, any> = { schema: "0.20", team: { name: "repo", worktree_root: root }, seats: { scout: row }, unknown: { nested: "keep" } };
  const state: Record<string, any> = { panes: { "%7": facts(), "repo/scout:0.0": facts(), "repo/scout": facts() } };
  writeFileSync(join(base, "bin", "tmux"), fakeTmux, { mode: 0o755 });
  writeFileSync(join(base, "index", "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { repo: { root, registry_location: registry } } }));
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: join(base, "bin") + ":" + process.env.PATH, HOME: join(base, "home"),
    TAP_INDEX_HOME: join(base, "index"), TAP_HOME: join(root, ".tap", "bus"),
    TAP_BOOT_ID: "boot:100", TAP_WATCH_NOW: "1700000000", REPAIR_TMUX_STATE: statePath,
    TAP_JSON: "0", TAP_VERBOSE: "0", TAP_ONBOARDING_CHECKED: "1", TAP_INTERNAL_OVERDUE_CHECKED: "1",
    TAP_LAUNCHER: "", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  };
  delete env.TAP_SERVER_EPOCH;
  delete env.TAP_SELF;
  const save = () => { writeFileSync(registry, JSON.stringify(doc)); writeFileSync(statePath, JSON.stringify(state)); };
  save();
  const record = () => payloadRecords(loads(readFileSync(registry, "utf8")) as Map<string, unknown>, root)[0]!;
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}, command = ["bun", door]) =>
    spawnSync(command[0]!, [...command.slice(1), ...args], { cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 20000 });
  const worker = (selected = record(), dry = false) => withEnv(env, () => repairRecord(selected, dry));
  return { base, root, registry, statePath, row, doc, state, env, save, record, run, worker };
}
function withEnv<T>(env: NodeJS.ProcessEnv, work: () => T): T {
  // Restore the same object, not a copy: modules that bound `const env =
  // process.env` at load (resume.ts, new.ts) would otherwise keep reading the
  // orphaned original for every later test file in the process.
  const prior = process.env;
  try { process.env = { ...env }; return work(); }
  finally { process.env = prior; }
}
const registryBytes = (fx: ReturnType<typeof fixture>) => readFileSync(fx.registry, "utf8");
const savedRow = (fx: ReturnType<typeof fixture>) => JSON.parse(registryBytes(fx)).seats.scout;
const jsonResult = (fx: ReturnType<typeof fixture>, args = ["scout", "--json"]) => {
  const run = fx.run(args);
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  return JSON.parse(run.stdout);
};

test("seven-field observation carries its own epoch and preserves tabs in path", () => {
  expect(parseRepairPane(facts(undefined, undefined, undefined, "800:90", "/with\ttab"))).toMatchObject({ epoch: "srv:800:90", path: "/with\ttab", pid: "777", dead: false });
  for (const bad of ["", "%7\trepo/scout\t777\tclaude", facts().replace("\t0\t777\t", "\t?\t777\t"), facts() + "\n" + facts()]) expect(parseRepairPane(bad)).toBeNull();
  expect(() => parseRepairPane(facts(undefined, "%bad"))).toThrow("identity_unverified");
  expect(parseRepairPane(facts().replace("\t0\t777\t", "\t1\t\t"))).toMatchObject({ paneId: "%7", dead: true, pid: "" });
  expect(parseRepairPane(facts().replace("\t0\t777\t", "\t0\t\t"))).toBeNull();
  expect(parseRepairPane(facts().replace("\t0\t777\t", "\t1\tbad\t"))).toBeNull();
});

test("shared record projection keeps caller-specific integer lexemes and ordered Maps", () => {
  const source = '{"schema":"0.20","team":{"name":"repo"},"seats":{"10":{"session":"repo/old","harness":"claude","delivery":"pane","tag":"wide","index":9007199254740993},"2":{"session":"repo/float","harness":"claude","delivery":"pane","tag":"float","index":2.0},"3":{"session":"repo/bool","harness":"claude","delivery":"pane","tag":"bool","index":true}}}';
  const exact = payloadRecords(loads(source) as Map<string, unknown>, "/root");
  expect(exact.map(sessionHandle)).toEqual(["wide-9007199254740993", "float", "bool"]);
  expect(payloadRecords(JSON.parse(source), "/root").map(sessionHandle)).toEqual(["float-2", "bool", "wide-9007199254740992"]);
});

describe("row reconciliation and reporting", () => {
  test.each(["777", ""])("repair refuses retained dead panes without writing (pid=%s)", pid => {
    for (const target of ["%7", "repo/scout:0.0", "repo/scout", "listed"]) {
      for (const dry of [false, true]) {
        const fx = fixture();
        const dead = facts().replace("\t0\t777\t", `\t1\t${pid}\t`);
        fx.row.boot_id = "boot:old";
        fx.state.panes = target === "listed" ? {} : { [target]: dead };
        fx.state.candidates = dead;
        fx.save();
        const before = registryBytes(fx);
        expect(fx.worker(undefined, dry).status, `${target}, dry=${dry}`).toBe("not_live");
        expect(registryBytes(fx)).toBe(before);
      }
    }
  });

  test("repair skips a retained dead active pane and listed candidate when recovering a live pane", () => {
    const fx = fixture();
    const dead = facts().replace("\t0\t777\t", "\t1\t\t");
    fx.state.panes = { "repo/scout": dead };
    fx.state.candidates = dead + "\n" + facts("repo/scout:1.0", "%8");
    fx.save();
    expect(fx.worker().status).toBe("repaired");
    expect(savedRow(fx).pane_id).toBe("%8");
  });

  test("current rows write nothing; dry-run stops before publication and instance minting", () => {
    const fx = fixture(), before = registryBytes(fx), mtime = statSync(fx.registry).mtimeMs;
    expect(jsonResult(fx).repaired[0].status).toBe("already_current");
    expect(registryBytes(fx)).toBe(before);
    expect(statSync(fx.registry).mtimeMs).toBe(mtime);
    delete fx.row.instance;
    delete fx.row.registered_from_worktree;
    fx.save();
    const dryBefore = registryBytes(fx);
    expect(jsonResult(fx, ["scout", "--dry-run", "--json"]).repaired[0].status).toBe("would_repair");
    expect(registryBytes(fx)).toBe(dryBefore);
    expect(jsonResult(fx).repaired[0].status).toBe("repaired");
    expect(savedRow(fx).instance).toMatch(/^scout\|[a-f0-9]{16}$/);
    expect(savedRow(fx).registered_from_worktree).toBe(fx.root);
  });

  test("refresh preserves row identity, fixed binding, lossless metadata and supersedes aliases", () => {
    const fx = fixture();
    fx.row.pane = "repo/scout:3.4";
    fx.row.boot_id = "boot:old";
    fx.row.launch_id = "old-token";
    fx.row.wake_url = "old";
    fx.row.unattended = true;
    fx.doc.seat_forwardings = [{ source: "scout", source_instance: "scout|same", destination: "other", destination_instance: "other|old", address_active: true }];
    fx.save();
    writeFileSync(fx.registry, registryBytes(fx).replace('"unknown":{"nested":"keep"}', '"unknown":{"wide":9007199254740993,"float":2.0,"__proto__":{"safe":true}}'));
    expect(jsonResult(fx).repaired[0].status).toBe("repaired");
    const saved = savedRow(fx);
    expect(saved).toMatchObject({ instance: "scout|same", registered_from_worktree: fx.root, harness_session_id: "conversation", transcript_path: "/keep/transcript", model: "keep-model", passthrough: ["--keep"], pane: "repo/scout:0.0", boot_id: "boot:100", registered_at: "2023-11-14T22:13:20Z" });
    for (const field of ["wake_url", "unattended", "launch_id"]) expect(saved).not.toHaveProperty(field);
    expect(registryBytes(fx)).toContain("9007199254740993");
    expect(registryBytes(fx)).toContain('"float": 2.0');
    expect(JSON.parse(registryBytes(fx)).seat_forwardings[0]).toMatchObject({ address_active: false, custody_revoked: true });
  });

  test("stale epoch voids recycled ids before probing; current owners refuse, stale owners do not", () => {
    const fx = fixture();
    fx.row.server_epoch = "srv:old:epoch";
    fx.state.panes["%7"] = facts("stranger:0.0", "%7");
    fx.state.panes["repo/scout"] = facts("repo/scout:0.1", "%9");
    fx.doc.seats.other = { status: "active", pane_id: "%9", server_epoch: "srv:old:epoch" };
    fx.save();
    expect(jsonResult(fx).repaired[0].status).toBe("repaired");
    expect(savedRow(fx)).toMatchObject({ pane_id: "%9", server_epoch: "srv:900:100" });
    const claimed = fixture();
    claimed.doc.seats.other = { status: "active", pane_id: "%7", server_epoch: "srv:900:100" };
    claimed.save();
    const before = registryBytes(claimed);
    expect(claimed.worker().status).toBe("pane_owned");
    expect(registryBytes(claimed)).toBe(before);
  });

  test("stored id precedes address; dead id can use address; invalid id can use exact session", () => {
    const fx = fixture();
    fx.state.panes["repo/scout:0.0"] = facts("stranger:0.0", "%8");
    fx.save();
    expect(fx.worker().status).toBe("already_current");
    delete fx.state.panes["%7"];
    fx.save();
    expect(fx.worker().status).toBe("pane_mismatch");
    fx.row.pane_id = "%damaged";
    fx.row.pane = "gone:0.0";
    fx.save();
    expect(jsonResult(fx).repaired[0].status).toBe("repaired");
    expect(savedRow(fx).pane_id).toBe("%7");
  });

  test("matching falls through active non-agent to first matching pane without changing decided binding", () => {
    const fx = fixture();
    fx.row.pane_id = "%gone";
    fx.row.pane = "gone:0.0";
    fx.state.panes["repo/scout"] = facts(undefined, "%8", "zsh");
    fx.state.candidates = facts("repo/scout:0.1", "%9", "claude") + "\n" + facts("repo/scout:0.2", "%10", "claude");
    fx.save();
    expect(jsonResult(fx).repaired[0].status).toBe("repaired");
    expect(savedRow(fx)).toMatchObject({ pane_id: "%9", registered_from_worktree: fx.root });
    fx.state.candidates = facts(undefined, "%8", "zsh");
    fx.save();
    expect(fx.worker().status).toBe("non_agent_pane");
  });

  test("shallow unsupported process wrappers use the existing foreground process classifier", () => {
    const fx = fixture();
    const wrapper = facts(undefined, undefined, "node");
    fx.state.panes = { "%7": wrapper, "repo/scout": wrapper };
    writeFileSync(join(fx.base, "bin", "ps"), "#!/bin/sh\nprintf '%s\\n' '777 777 777 node /usr/bin/node /opt/claude-code/cli.js'\n", { mode: 0o755 });
    fx.save();
    expect(fx.worker().status).toBe("repaired");
    expect(savedRow(fx).pane_current_command).toBe("node");
    writeFileSync(join(fx.base, "bin", "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(fx.worker().status).toBe("non_agent_pane");
  });

  test("all ten worker statuses retain the named/batch success polarity", () => {
    const fx = fixture(), selected = fx.record();
    const cases: [RepairStatus, () => void][] = [
      ["not_registered", () => { delete fx.doc.seats.scout; }],
      ["pending_mismatch", () => { fx.row.status = "pending"; fx.row.session = "repo/new"; }],
      ["user_removed", () => { fx.row.status = "suspended"; fx.row.status_reason = "user_removed"; }],
      ["non_agent_pane", () => { fx.state.panes["%7"] = facts(undefined, undefined, "zsh"); }],
      ["pane_mismatch", () => { fx.state.panes["%7"] = facts("wrong:0.0"); }],
      ["not_live", () => { fx.row.pane_id = "%gone"; fx.row.pane = "gone:0.0"; fx.state.panes = {}; fx.state.candidates = ""; }],
    ];
    for (const [status, change] of cases) {
      const originalDoc = JSON.stringify(fx.doc), originalState = JSON.stringify(fx.state);
      change(); fx.save();
      const before = registryBytes(fx);
      expect(fx.worker(selected).status).toBe(status);
      expect(registryBytes(fx)).toBe(before);
      Object.assign(fx.doc, JSON.parse(originalDoc));
      Object.assign(fx.state, JSON.parse(originalState));
      Object.assign(fx.row, fx.doc.seats.scout);
      fx.doc.seats.scout = fx.row;
    }
    const failed = fixture();
    failed.state.panes["%7"] = facts(undefined, undefined, "zsh"); failed.save();
    for (const args of [["scout", "--json"], ["--all", "--json"]]) {
      const run = failed.run(args);
      expect(run.status).toBe(2);
      expect(run.stderr).toBe("");
      expect(JSON.parse(run.stdout)).toMatchObject({ ok: true, failures: [{ name: "repo/scout", status: "non_agent_pane" }] });
    }
  });

  test("cohort stays exact; status drift preserves incapable and user removal without public broadening", () => {
    const fx = fixture(), selected = fx.record();
    fx.row.status = "suspended"; fx.row.status_reason = "incapable"; fx.row.boot_id = "old"; fx.save();
    expect(fx.worker(selected).status).toBe("repaired");
    expect(savedRow(fx)).toMatchObject({ status: "suspended", status_reason: "incapable", instance: "scout|same" });
    expect(JSON.parse(fx.run(["--all", "--json"]).stdout).repaired).toEqual([]);
    for (const patch of [{ crew: true }, { delivery: "poll" }, { status: "suspended", status_reason: "user_removed" }]) {
      const other = fixture(); Object.assign(other.row, patch); other.save();
      expect(JSON.parse(other.run(["--all", "--json"]).stdout).repaired).toEqual([]);
    }
  });

  test("exact session wins before handle; bare harness does not pick even a sole candidate", () => {
    const fx = fixture();
    const ambiguous = fx.run(["claude", "--json"]);
    expect(ambiguous.status).toBe(2);
    expect(ambiguous.stdout).toBe("");
    expect(ambiguous.stderr).toContain("claude matches: repo/scout");
    const structured = fx.run(["claude"], { TAP_JSON: "1" });
    expect(JSON.parse(structured.stdout).error_class).toBe("session_ambiguous");
    fx.row.session = "legacy/vessel";
    fx.state.namespace = "legacy/vessel";
    fx.state.panes = { "%7": facts("legacy/vessel:0.0") };
    fx.save();
    expect(jsonResult(fx, ["scout", "--json"]).repaired[0]).toMatchObject({ name: "legacy/vessel", handle: "scout", status: "repaired" });
    expect(fx.run(["missing"]).stderr).toContain("repair key not found: missing");
    expect(fx.run(["scout", "--all"]).status).toBe(2);
  });
});

test("R1: unavailable or malformed live evidence refuses with zero registry mutation", () => {
  for (const fault of [
    { code: 1, stderr: "permission denied" },
    { code: 1, stderr: "tmux client rate limited" },
    { code: 0, stdout: "malformed\n" },
    facts(undefined, "%bad"),
  ]) {
    const fx = fixture();
    fx.state.panes["%7"] = fault;
    fx.save();
    const before = registryBytes(fx), mtime = statSync(fx.registry).mtimeMs;
    for (const dry of [[], ["--dry-run"]]) {
      const run = fx.run(["scout", "--json", ...dry], { TAP_JSON: "1" });
      expect(run.status).toBe(2);
      expect(JSON.parse(run.stdout).error_class).toBe("session_error");
      expect(run.stdout).toContain("identity_unverified");
      expect(registryBytes(fx)).toBe(before);
      expect(statSync(fx.registry).mtimeMs).toBe(mtime);
    }
  }
});

test("namespace unobservable is not empty; positive no-server is empty; hard errors use a JSON envelope", () => {
  const fx = fixture();
  fx.state.namespace = { code: 1, stderr: "no sessions" }; fx.save();
  const failed = fx.run(["--all", "--json"]);
  expect(failed.status).toBe(2);
  expect(JSON.parse(failed.stdout)).toMatchObject({ ok: false, error_class: "session_error", detail: expect.stringContaining("snapshot is unobservable") });
  expect(failed.stderr).toBe("");
  fx.state.namespace = { code: 1, stderr: "no server running on /tmp/test" }; fx.save();
  expect(jsonResult(fx, ["--all", "--json"]).repaired).toEqual([]);
});

test("generation moves refuse real writes; dry-run returns before that recheck; an unknown generation refuses (tap-zk1w)", () => {
  const fx = fixture();
  fx.row.pane = "old:0.0"; fx.state.afterPaneEpoch = "901:101"; fx.save();
  const before = registryBytes(fx);
  const failed = fx.run(["scout"]);
  expect(failed.status).toBe(2);
  expect(failed.stderr).toContain("generation moved");
  expect(registryBytes(fx)).toBe(before);
  fx.state.epoch = "900:100"; fx.state.afterPaneEpoch = "901:101"; fx.save();
  expect(jsonResult(fx, ["scout", "--dry-run", "--json"]).repaired[0].status).toBe("would_repair");
  const unknown = fixture();
  unknown.row.pane = "old:0.0";
  unknown.state.panes["%7"] = facts(undefined, undefined, undefined, "unknown"); unknown.save();
  const unknownBefore = registryBytes(unknown);
  // The real write, its dry-run preview, and an otherwise-current unstamped row
  // all refuse with the documented envelope; nothing is written.
  for (const args of [["scout", "--json"], ["scout", "--dry-run", "--json"]]) {
    const run = unknown.run(args, { TAP_BOOT_ID: "" });
    expect(run.status, run.stdout + run.stderr).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject({ ok: false, error_class: "generation_unverifiable", action: "wait for tmux to answer, then retry" });
    expect(registryBytes(unknown)).toBe(unknownBefore);
  }
  const current = fixture();
  delete current.row.server_epoch;
  current.state.panes["%7"] = facts(undefined, undefined, undefined, "unknown"); current.save();
  const currentBefore = registryBytes(current);
  const noop = current.run(["scout", "--json"], { TAP_BOOT_ID: "" });
  expect(noop.status, noop.stdout + noop.stderr).toBe(1);
  expect(JSON.parse(noop.stdout).error_class).toBe("generation_unverifiable");
  expect(registryBytes(current)).toBe(currentBefore);
});

test("R2: each selected witness field fences replacement, including instance absent-to-present", () => {
  for (const field of ["instance", "session", "harness"]) {
    const fx = fixture(), selected = fx.record();
    fx.row[field] = "replacement"; fx.save();
    const before = registryBytes(fx);
    expect(() => fx.worker(selected)).toThrow("repair target changed while waiting for registry lock");
    expect(registryBytes(fx)).toBe(before);
  }
  const fx = fixture(); delete fx.row.instance; fx.save();
  const selected = fx.record();
  fx.row.instance = "newly|attested"; fx.save();
  expect(() => fx.worker(selected)).toThrow("reselect and retry");
});

test("literal sidecar waits beyond five seconds and rereads the changed witness under that hold", async () => {
  const fx = fixture(), gate = join(fx.base, "gate");
  fx.state.gate = gate; fx.save();
  const holder = Bun.spawn(["python3", "-c", "import fcntl,sys; f=open(sys.argv[1],'w'); fcntl.flock(f,fcntl.LOCK_EX); print('held',flush=True); sys.stdin.readline()", fx.registry + ".lock"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = holder.stdout.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("held");
  const child = Bun.spawn(["bun", door, "scout", "--json"], { cwd: fx.root, env: { ...fx.env, TAP_JSON: "1" }, stdout: "pipe", stderr: "pipe" });
  try {
    const deadline = Date.now() + 10000;
    while (!existsSync(gate + ".ready") && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(gate + ".ready")).toBe(true);
    writeFileSync(gate + ".release", "");
    await Bun.sleep(5300);
    expect(child.exitCode).toBeNull();
    fx.row.harness = "codex"; fx.row.unrelated_update = "preserved"; fx.save();
    holder.stdin.write("\n"); holder.stdin.end();
    expect(await holder.exited).toBe(0);
    expect(await child.exited).toBe(2);
    expect(await new Response(child.stdout).text()).toContain("reselect and retry");
    expect(savedRow(fx)).toMatchObject({ harness: "codex", unrelated_update: "preserved" });
  } finally {
    holder.stdin.end();
    holder.kill();
    child.kill();
    await Promise.all([holder.exited, child.exited]);
  }
}, 20000);

test("every public/shim/launcher-pin door runs the same repair owner", () => {
  const fx = fixture();
  const realPython = Bun.which("python3")!;
  fx.env.REPAIR_REAL_PYTHON = realPython;
  writeFileSync(join(fx.base, "bin", "python3"), "#!/bin/sh\ncase \"$*\" in *'/session/launcher.py repair'*) echo 'unexpected Python repair route' >&2; exit 98 ;; esac\nexec \"$REPAIR_REAL_PYTHON\" \"$@\"\n", { mode: 0o755 });
  const expected = jsonResult(fx);
  for (const command of [["bash", join(repo, "bin/tap"), "session", "repair"], ["bash", join(repo, "scripts/tap.sh"), "session", "repair"]]) {
    for (const pin of ["", "python", "bun"]) {
      const run = fx.run(["scout", "--json"], { TAP_LAUNCHER: pin }, command);
      expect([command, pin, run.stderr, run.status]).toEqual([command, pin, "", 0]);
      expect(JSON.parse(run.stdout)).toEqual(expected);
    }
  }
  expect(fx.run(["--help"]).status).toBe(0);
  expect(fx.run(["--unknown"]).status).toBe(2);
  expect(JSON.parse(fx.run(["scout", "--d", "--j"]).stdout).dry_run).toBe(true);
});

test("acting registry authority ignores bus decoys; malformed documents and fences refuse", () => {
  const fx = fixture();
  writeFileSync(join(fx.env.TAP_HOME!, "registry.json"), '{"seats":{"decoy":{"session":"repo/scout","harness":"claude","delivery":"pane"}}}');
  expect(jsonResult(fx).repaired[0].handle).toBe("scout");
  // Malformed documents keep their launcher refusal; an old format refuses old_store (exit 1).
  for (const [bytes, status] of [["[]", 2], ["{", 2], ["\ufeff{}", 2], ["{}", 1], ['{"seats":[]}', 1]] as const) {
    writeFileSync(fx.registry, bytes);
    const run = fx.run(["scout"]);
    expect([bytes, run.status]).toEqual([bytes, status]);
    if (status === 1) expect(run.stderr).toContain("old TAP registry format");
    expect(registryBytes(fx)).toBe(bytes);
  }
  fx.save();
  writeLiveFence(join(fx.env.TAP_HOME!, "reset.fence.json"));
  expect(fx.run(["--all", "--dry-run"]).stderr).toContain("mid-reset");
});

test("R1: a timed-out stored-pane read refuses without falling through to a healthy session pane", () => {
  const fx = fixture();
  fx.state.panes["%7"] = { delay: 60000, stdout: facts() + "\n" }; fx.save();
  // One wall-clock budget orders every tmux read in this run:
  // shim latency < budget < pane delay. The namespace shim and the epoch
  // reply must answer well inside the budget however loaded the machine is,
  // and the stored-pane read must overshoot it (runTmux SIGKILLs at the
  // budget, so the delay only has to exceed it). A 0.5s budget flaked under
  // full-suite load when the shim's fork+exec alone overshot it, refusing at
  // the namespace instead of the pane read (tap-ti6kf).
  const stub = join(fx.base, "bin", "tmux"), worker = stub + ".bun";
  renameSync(stub, worker);
  writeFileSync(stub, "#!/bin/sh\ncase \" $* \" in\n" +
    "  *\" list-sessions \"*) printf 'repo/scout\\n' ;;\n" +
    "  *) exec " + shlexQuote(process.execPath) + " " + shlexQuote(worker) + " \"$@\" ;;\n" +
    "esac\n", { mode: 0o755 });
  const before = registryBytes(fx);
  const run = fx.run(["scout"], { TAP_TMUX_TIMEOUT_SECONDS: "3" });
  expect(run.status).toBe(2);
  expect(run.stderr).toContain("pane observation is unobservable");
  expect(registryBytes(fx)).toBe(before);
  // The budget burn is intentional (~3s); non-Darwin runners default this
  // file's per-test deadline to 5s, which fixture setup plus Bun startup
  // would crowd it out of on a loaded host.
}, 20000);

test("both repair arms preserve a worktree binding that differs from the selected record cwd", () => {
  for (const repoint of [false, true]) {
    const fx = fixture(), selected = fx.record(), elsewhere = join(fx.base, "elsewhere");
    mkdirSync(elsewhere);
    fx.row.registered_from_worktree = elsewhere;
    fx.row.boot_id = "old";
    if (repoint) { fx.row.pane_id = "%missing"; fx.row.pane = "missing:0.0"; }
    fx.save();
    expect(fx.worker(selected).status).toBe("repaired");
    expect(savedRow(fx).registered_from_worktree).toBe(elsewhere);
  }
});

test("native repair converges launching, then the launch transaction accepts that exact binding", async () => {
  // repair.ts owns its own registry write (readRegistry/publish below); it does
  // NOT call bindTransaction. Deleting the Python launcher.mark_launch_ready
  // that used to simulate a second, independent writer re-binding the row repair
  // just converged -- but the real scenario it modeled is still live: repair
  // converges a launching row on its own path, and the shared launch transaction
  // (bindTransaction, transaction.ts) may later observe and accept that exact
  // binding through its idempotent `already` check rather than re-validating or
  // clobbering it. This replaces the deleted Python call with a direct native
  // bindTransaction call carrying the identical session/pane/pane_id/instance,
  // preserving the original acceptance scenario and its positive post-state.
  const fx = fixture();
  fx.row.status_reason = "launching"; fx.row.launch_id = "orphaned-token"; fx.save();
  expect(jsonResult(fx).repaired[0].status).toBe("repaired");
  const repaired = savedRow(fx);
  expect(repaired).toMatchObject({ status: "active", status_reason: "", instance: "scout|same" });
  expect(repaired).not.toHaveProperty("launch_id");

  const { selectCaller } = await import("../src/selector");
  const { bindTransaction } = await import("../src/launcher/transaction");
  const selection = selectCaller({ cwd: fx.root, env: fx.env, verbClass: "lifecycle" });
  // fx.record()'s SessionRecord.index is number|bigint (loads() preserves big
  // indices); FailureEvidence.record wants LaunchRecord's number|PyInt|null. The
  // fixture's index is small, so a plain Number() coercion is exact, not lossy.
  const { index: rawIndex, ...rawRecord } = fx.record();
  const record = { ...rawRecord, index: Number(rawIndex) };
  const facts = { pane: "repo/scout:0.0", pane_id: "%7", command: "claude", server_epoch: "srv:900:100", dead: false, pane_pid: 777, path: fx.root };
  const evidence = { selection, handle: "scout", token: "", instance: "scout|same", record, vessel: null, backup: { status: "not-needed" as const }, reason: "repair_failed", output_path: "" };

  // bindTransaction re-derives caller identity from process.env (assertLaunchAuthority
  // takes no env parameter), unlike repairRecord above which is called under withEnv
  // synchronously; swap process.env around these awaits instead.
  const prior = process.env;
  process.env = fx.env;
  try {
    // Same identity, same binding: accepted as a no-op (the `already` branch), not
    // re-validated against the now-absent "launching" status_reason.
    await expect(bindTransaction(evidence, facts, true, fx.env)).resolves.toBeUndefined();
    expect(savedRow(fx)).toEqual(repaired);

    // Changed-binding control: a different pane_id is NOT unconditionally accepted --
    // it falls through to the ordinary validation, which refuses because status_reason
    // is no longer "launching".
    await expect(bindTransaction(evidence, { ...facts, pane_id: "%99" }, true, fx.env)).rejects.toThrow("bound launch lost");
    expect(savedRow(fx)).toEqual(repaired);
  } finally {
    process.env = prior;
  }
});

test("real private tmux: follow send's invalid-pane remedy through native repair", async () => {
  const fx = fixture(), socket = "tap-repair-" + process.pid + "-" + Date.now();
  const env: NodeJS.ProcessEnv = { ...fx.env, PATH: process.env.PATH, TAP_TMUX_SOCKET: socket };
  delete env.TAP_TMUX_SOCKET_PATH;
  const tmux = (args: string[]) => spawnSync("tmux", ["-L", socket, ...args], { env, encoding: "utf8" });
  const session = "repo/repair-acceptance";
  const made = tmux(["new-session", "-d", "-s", session, "-c", fx.root, "-P", "-F", "#{pane_id}"]);
  expect([made.status, made.stderr]).toEqual([0, ""]);
  const pane = made.stdout.trim();
  try {
    const retained = tmux(["set-option", "-p", "-t", pane, "remain-on-exit", "on"]);
    expect([retained.status, retained.stderr]).toEqual([0, ""]);
    // Keep the platform-signed sleep binary in place; argv[0] is the harmless
    // harness fixture that the shared process classifier observes.
    expect(tmux(["respawn-pane", "-k", "-t", pane, "/bin/bash", "-c", "exec -a claude /bin/sleep 90"]).status).toBe(0);
    let observation = "", observationError = "";
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const read = tmux(["display-message", "-p", "-t", pane, PANE_FACTS_FORMAT]);
      observation = read.stdout;
      observationError = read.stderr;
      if (["claude", "sleep"].includes(observation.split("\t")[2]!) || observation.split("\t")[4] === "1") break;
      await Bun.sleep(25);
    }
    const actual = parseRepairPane(observation)!;
    expect({ observation, observationError, capture: tmux(["capture-pane", "-p", "-t", pane]).stdout, actual }).toMatchObject({ actual: { dead: false } });
    expect(["claude", "sleep"]).toContain(actual.command);
    fx.row.session = session;
    fx.row.pane_id = "%invalid";
    fx.row.pane = "missing:0.0";
    fx.row.server_epoch = actual.epoch;
    fx.doc.seats.probe = { status: "active", delivery: "poll", harness: "probe", instance: "probe|same", registered_from_worktree: fx.root };
    fx.save();
    const send = spawnSync("bun", [join(repo, "runtime/bun/main.ts"), "send", "scout", "--from", "probe", "-m", "must refuse before placement"], { cwd: fx.root, env, encoding: "utf8" });
    expect(send.status).toBe(1);
    expect(send.stderr).toContain("run 'tap session repair scout' to re-bind session");
    const before = registryBytes(fx);
    const dry = spawnSync("bash", [join(repo, "bin/tap"), "session", "repair", "scout", "--dry-run", "--json"], { cwd: fx.root, env, encoding: "utf8" });
    expect([dry.status, dry.stderr]).toEqual([0, ""]);
    expect(JSON.parse(dry.stdout).repaired[0].status).toBe("would_repair");
    expect(registryBytes(fx)).toBe(before);
    const repaired = spawnSync("bash", [join(repo, "bin/tap"), "session", "repair", "scout", "--json"], { cwd: fx.root, env, encoding: "utf8" });
    expect([repaired.status, repaired.stderr]).toEqual([0, ""]);
    expect(JSON.parse(repaired.stdout).repaired[0].status).toBe("repaired");
    expect(savedRow(fx)).toMatchObject({ pane_id: actual.paneId, pane: actual.pane, server_epoch: actual.epoch, instance: "scout|same" });
    expect(tmux(["has-session", "-t", "=" + session]).status).toBe(0);
  } finally {
    tmux(["kill-server"]);
  }
}, 20000);

test("falsy malformed epoch stamps do not void a stored identity or evade its mismatch", () => {
  for (const stamp of [0, null, false, [], ""]) {
    const fx = fixture();
    fx.row.server_epoch = stamp;
    fx.state.panes["%7"] = facts("stranger:0.0");
    fx.save();
    const before = registryBytes(fx);
    expect(fx.worker().status).toBe("pane_mismatch");
    expect(registryBytes(fx)).toBe(before);
  }
});

test("disappeared rows fail named repair but are nonfailures in the batch envelope", () => {
  for (const key of ["scout", "--all"]) {
    const fx = fixture();
    fx.state.removeRow = [fx.registry, "scout"]; fx.save();
    const run = fx.run([key, "--json"]);
    expect(run.status).toBe(key === "--all" ? 0 : 2);
    expect(run.stderr).toBe("");
    const body = JSON.parse(run.stdout);
    expect(body.repaired[0].status).toBe("not_registered");
    expect(body.failures.length).toBe(key === "--all" ? 0 : 1);
  }
});

test("batch hard error leaves earlier commits and returns one failure envelope", () => {
  const fx = fixture();
  fx.row.boot_id = "old";
  fx.doc.seats.other = { ...fx.row, session: "repo/other", tag: "other", pane: "repo/other:0.0", pane_id: "%9", instance: "other|same" };
  fx.state.namespace = "repo/scout\nrepo/other";
  fx.state.panes["%9"] = { code: 1, stderr: "permission denied" }; fx.save();
  const run = fx.run(["--all", "--json"]);
  expect(run.status).toBe(2);
  expect(JSON.parse(run.stdout)).toMatchObject({ ok: false, error_class: "session_error", detail: expect.stringContaining("unobservable") });
  expect(run.stderr).toBe("");
  expect(savedRow(fx).boot_id).toBe("boot:100");
  expect(JSON.parse(registryBytes(fx)).seats.other.boot_id).toBe("old");
});

test("an absent machine index refuses repair before any registry read or write", () => {
  const fx = fixture();
  fx.env.TAP_INDEX_HOME = join(fx.base, "absent-index");
  const before = registryBytes(fx);
  let message = "";
  try { fx.worker(); } catch (error) { message = (error as Error).message; }
  expect(message).toStartWith("no machine index (global-registry.json)");
  const run = fx.run(["scout"]);
  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain("no machine index (global-registry.json)");
  // Structured callers get the typed class and its recovery, not session_error.
  const json = fx.run(["scout"], { TAP_JSON: "1" });
  expect(json.status).not.toBe(0);
  expect(JSON.parse(json.stdout.trim())).toMatchObject({ error_class: "unanchored_bus", action: "tap init  OR  tap session launch" });
  expect(registryBytes(fx)).toBe(before);
});

test("an agents-axis registry has no rows for repair to touch", () => {
  const fx = fixture();
  fx.doc.agents = fx.doc.seats; delete fx.doc.seats;
  fx.save();
  const old = registryBytes(fx);
  expect(fx.run(["scout", "--json"]).status).not.toBe(0);
  expect(registryBytes(fx)).toBe(old);
});

test("exact session name precedes an earlier row's matching handle", () => {
  const fx = fixture();
  fx.doc.seats.exact = { ...fx.row, tag: "exact", session: "scout", pane: "scout:0.0", pane_id: "%9", instance: "exact|same" };
  fx.state.namespace = "repo/scout\nscout";
  fx.state.panes["%9"] = facts("scout:0.0", "%9"); fx.save();
  expect(jsonResult(fx).repaired[0]).toMatchObject({ name: "scout", handle: "exact" });
});

test.each([false, true])("repair refuses a foreign active pane claim before row changes (dryRun=%s)", dry => {
  const fx = fixture();
  const other = join(fx.base, "other-registry.json");
  const claimed = { schema: "0.20", team: { name: "other" }, seats: { incumbent: {
    ...fx.row, instance: "incumbent|kept",
  } } };
  writeFileSync(other, JSON.stringify(claimed));
  const index = join(fx.base, "index", "global-registry.json");
  const machine = JSON.parse(readFileSync(index, "utf8"));
  // A team whose root is gone is skipped, not a claim: keep the foreign root live.
  mkdirSync(join(fx.base, "other"));
  machine.teams.other = { root: join(fx.base, "other"), registry_location: other, state: "registered" };
  writeFileSync(index, JSON.stringify(machine));
  fx.row.pane_current_command = "stale";
  fx.save();
  const before = [registryBytes(fx), readFileSync(other, "utf8")];
  expect(() => fx.worker(fx.record(), dry)).toThrow("pane_enrolled_elsewhere");
  const run = fx.run(["scout", "--json", ...(dry ? ["--dry-run"] : [])]);
  expect(run.status).toBe(2);
  expect(JSON.parse(run.stdout)).toMatchObject({ error_class: "pane_enrolled_elsewhere",
    action: "keep the existing enrollment, or remove the wrong row with tap out other/incumbent" });
  expect([registryBytes(fx), readFileSync(other, "utf8")]).toEqual(before);
});
