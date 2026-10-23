import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { acquirePaneLock, KERNEL_LOCK, kernelLockArgs } from "../src/panelock";
import { removeScratchTree } from "./support/scratch";

const root = resolve(import.meta.dir, "../../..");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function fixture() {
  if (!process.env.TAP_HOME || !process.env.TMUX_TMPDIR) throw new Error("compact tests require the isolated runner");
  const dir = mkdtempSync(join(process.env.TAP_HOME, "compact-"));
  const scripts = join(dir, "skills/tap/scripts"), bus = join(dir, ".tap/bus"), index = join(dir, "index");
  for (const path of [scripts, bus, index, join(bus, "payloads"), join(bus, "receipts"), join(dir, "bin")]) mkdirSync(path, { recursive: true });
  const seat = (pane: string) => ({ status: "active", delivery: "pane", pane: `session:${pane}.0`, pane_id: `%${pane}`, session: "session", harness: "claude", server_epoch: "srv:1:1" });
  const registry = join(bus, "registry.json");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture" }, seats: { lead: seat("0"), alias: seat("0"), a: seat("1"), b: seat("2") } }));
  // Only the cancellable child seam is a shell fixture. Production never sources it.
  writeFileSync(join(scripts, "submit-fixture.sh"), `
peer_submit_stub() {
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$5" "$3" "$8" "\${10}" "\${11}" "\${12}" >> "$FIXTURE/submits"
  if [ "\${SUBMIT_RC:-0}" != 0 ]; then return "$SUBMIT_RC"; fi
  if [ "\${BLOCK_SUBMIT:-0}" = 1 ]; then
    printf '%s' "$$" > "$FIXTURE/parent.pid"
    trap 'exit 0' TERM
    bash "$FIXTURE/locked.sh" &
    wait
  fi
  if [ "\${AUDIT_FAULT:-}" != '' ]; then
    for stage in "$TAP_HOME"/tmp/.tap-command-success.*; do
      id="\${stage##*.tap-command-success.}"
      case "$AUDIT_FAULT" in
        placed) mkdir "$TAP_HOME/receipts/$id.placed" ;;
        done) mkdir "$TAP_HOME/receipts/$id.done" ;;
      esac
    done
  fi
  return 0
}
`);
  writeFileSync(join(dir, "courier-stand-in.sh"), 'cp "$3" "$FIXTURE/focus-body"\nexit "${WAKE_RC:-0}"\n');
  writeFileSync(join(dir, "bin/tmux"), '#!/bin/sh\nprintf "%s" "${LIVE_HARNESS-claude}"\n', { mode: 0o755 });
  writeFileSync(join(dir, "entry.ts"), `import { mock } from "bun:test";
const context = await import(${JSON.stringify(join(root, "runtime/bun/src/context.ts"))});
mock.module(${JSON.stringify(join(root, "runtime/bun/src/context.ts"))}, () => ({ ...context,
  observeCallingPane: () => ({ state: "inside", paneId: "%0", session: "session", serverEpoch: "srv:1:1", selectedSocket: "", selectedHandle: "", selectedInstance: "", selectedPane: "", viaJob: false }) }));
const gather = await import(${JSON.stringify(join(root, "runtime/bun/src/observe-gather.ts"))});
mock.module(${JSON.stringify(join(root, "runtime/bun/src/observe-gather.ts"))}, () => ({ ...gather,
  gatherRowsFromEnv: (rows: any[]) => rows.map(r => [r.key, 'active', '', r.pane, r.pane_id, r.harness, '0'].join('\\x1f')) }));
const { cmdCompact } = await import(${JSON.stringify(join(root, "runtime/bun/src/verbs/compact.ts"))});
import { runNative } from ${JSON.stringify(join(root, "runtime/bun/main.ts"))};
const alias = process.argv[2] === 'alias';
// The self path is \`tap self compact\` in-process; its own behavior is covered by self-gate and self.test.sh.
// The peer submit is the courier in production; here the controlled stub runs as a cancellable child.
const peerSubmit = async (r: any, run: (command: string[]) => Promise<{ code: number }>) => {
  if (process.env.EXPECT_STORE && r.transcript !== process.env.EXPECT_STORE) throw new Error("peer request lost registered store");
  const code = (await run(["bash", "-c", '. "$1/submit-fixture.sh"; shift; peer_submit_stub "$@"',
    "tap-compact-submit", ${JSON.stringify(scripts)}, r.pane, r.family, r.text, r.id, r.target, "0", "id", "", r.target, r.paneId, r.session, r.rowHarness])).code;
  if (code) return code;
  if (process.env.SKIP_PROOF_RECEIPT) return 0;
  const { writeFileSync } = await import("node:fs");
  if (process.env.PROOF_TIMEOUT) {
    writeFileSync(r.proofReceipt, JSON.stringify({ id: r.id, state: "not-compacted", handoff: r.handoff }));
    return 1;
  }
  const wake = (await run(["bash", process.env.TAP_COURIER_SCRIPT!, r.target, "-f", r.handoff])).code;
  writeFileSync(r.proofReceipt, JSON.stringify({ id: r.id, state: wake ? "resume-miss" : "resume-sent",
    handoff: r.handoff, evidence: r.family === "opencode" ? "store-proven" : "transcript-proven", compactedAt: new Date().toISOString() }));
  return wake ? 6 : 0;
};
process.exitCode = await runNative(alias ? 'command' : 'compact', argv => cmdCompact(argv, ${JSON.stringify(scripts)}, alias, peerSubmit), process.argv.slice(3));\n`);
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { fixture: { root: dir, registry_location: registry, state: "registered" } } }));
  const env: NodeJS.ProcessEnv = { ...process.env, TAP_HOME: bus, TAP_INDEX_HOME: index, TAP_LOCK_DIR: join(index, "locks"), FIXTURE: dir, PATH: `${join(dir, "bin")}:${process.env.PATH}`, TAP_COURIER_SCRIPT: join(dir, "courier-stand-in.sh") };
  delete env.TAP_CONTEXT_ENTRY;
  const start = (args: string[], extra: NodeJS.ProcessEnv = {}, alias = false) => Bun.spawn([process.execPath, join(dir, "entry.ts"), alias ? "alias" : "current", ...args], { cwd: dir, env: { ...env, ...extra }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const run = async (args: string[], extra: NodeJS.ProcessEnv = {}, alias = false) => {
    const child = start(args, extra, alias);
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, out, err };
  };
  return { dir, scripts, bus, env, start, run, close: () => removeScratchTree(dir) };
}

test("grammar aborts before targets; JSON and alias differences survive", async () => {
  const f = fixture();
  try {
    const bad = await f.run(["a", "--badflag", "b"], { TAP_JSON: "1" });
    expect(bad.code).toBe(1); expect(bad.err).toBe("");
    expect(JSON.parse(bad.out).error_class).toBe("unknown_option");
    writeFileSync(join(f.bus, "reset.fence.json"), "{}");
    const fenced = await f.run(["a"], { FENCED: "1", TAP_JSON: "1" });
    expect(fenced.code).toBe(1); expect(JSON.parse(fenced.out).error_class).toBe("team_reset_fenced");
    expect(existsSync(join(f.dir, "submits"))).toBe(false);
    unlinkSync(join(f.bus, "reset.fence.json"));
    expect((await f.run(["a", "-m", "x", "-m", "y"])).code).toBe(1);
    expect((await f.run(["compact", "--", "a"], {}, true)).code).toBe(1);
    expect((await f.run(["--", "a", "-m", "x"])).code).toBe(0);
    expect((await f.run(["compact", "a", "--focus", "x", "--focus", "y"], {}, true)).code).toBe(0);
    expect(readFileSync(join(f.dir, "submits"), "utf8")).toContain("/compact y [[sv:");
    for (const alias of [false, true]) {
      const r = await f.run([...(alias ? ["compact"] : []), "a", alias ? "--focus" : "-m", "/ignore the rest"], {}, alias);
      expect(r.err).toContain(`${alias ? "--focus" : "-m"} is context text`);
    }
  } finally { f.close(); }
}, 15000);

test("OpenCode peer suffix stays visible and its focus stays separate; preparation fails before effects", async () => {
  const f = fixture();
  try {
    const registry = join(f.bus, "registry.json"), doc = JSON.parse(readFileSync(registry, "utf8"));
    Object.assign(doc.seats.a, { harness: "opencode", harness_session_id: "ses_bound", session_store_path: "/registered/opencode.db" });
    writeFileSync(registry, JSON.stringify(doc));
    const result = await f.run(["a", "-m", "preserve focus"], { LIVE_HARNESS: "opencode", EXPECT_STORE: "/registered/opencode.db" });
    expect(result.code).toBe(0);
    expect(readFileSync(join(f.dir, "submits"), "utf8")).toMatch(/^a\t\/compact \[\[sv:[^\]]+\]\]\t/);
    expect(readFileSync(join(f.dir, "submits"), "utf8")).not.toContain("preserve focus");
    expect(readFileSync(join(f.dir, "focus-body"), "utf8")).toContain("FOCUS: preserve focus");
  } finally { f.close(); }
  const blocked = fixture();
  try {
    writeFileSync(join(blocked.bus, "tmp"), "not a directory");
    const result = await blocked.run(["a"]);
    expect(result.code).toBe(1); expect(result.err).toContain("refusing before pane input");
    expect(existsSync(join(blocked.dir, "submits"))).toBe(false);
  } finally { blocked.close(); }
});

test("--all with no peer seats says so and exits 0 (CLI-EXIT-0)", async () => {
  const f = fixture();
  try {
    const registry = join(f.bus, "registry.json"), doc = JSON.parse(readFileSync(registry, "utf8"));
    delete doc.seats.a; delete doc.seats.b;
    writeFileSync(registry, JSON.stringify(doc));
    const result = await f.run(["--all"]);
    expect({ code: result.code, out: result.out, err: result.err }).toEqual({
      code: 0, out: "tap compact: compact --all: no active peer pane seats; nothing to compact\n", err: "" });
    expect(existsSync(join(f.dir, "submits"))).toBe(false);
  } finally { f.close(); }
});

test("--all skips Codex peers with a printed route and exits 0; naming one still refuses", async () => {
  const f = fixture();
  try {
    const all = await f.run(["--all"], { LIVE_HARNESS: "codex" });
    expect({ code: all.code, err: all.err }).toEqual({ code: 0, err: "" });
    for (const seat of ["a", "b"]) expect(all.out).toContain(`tap compact: compact ${seat}: skipped (Codex seat; it self-compacts with tap self compact --handoff FILE -- FOCUS)\n`);
    expect(existsSync(join(f.dir, "submits"))).toBe(false);
    const named = await f.run(["a"], { LIVE_HARNESS: "codex" });
    expect(named.code).toBe(1); expect(named.err).toContain("'a' is a Codex seat");
  } finally { f.close(); }
});

test("--all treats an unobservable or ambiguous harness as a failure, never a skip", async () => {
  const f = fixture();
  try {
    for (const harness of ["", "node"]) {
      const all = await f.run(["--all"], { LIVE_HARNESS: harness });
      expect(all.code).toBe(1);
      expect(all.out).not.toContain("skipped");
      expect(all.err).toContain(`unsupported harness '${harness}'`);
    }
    expect(existsSync(join(f.dir, "submits"))).toBe(false);
  } finally { f.close(); }
});

test("--all skips a positively observed non-agent pane and exits 0", async () => {
  const f = fixture();
  try {
    const all = await f.run(["--all"], { LIVE_HARNESS: "zsh" });
    expect({ code: all.code, err: all.err }).toEqual({ code: 0, err: "" });
    for (const seat of ["a", "b"]) expect(all.out).toContain(`tap compact: compact ${seat}: skipped (harness 'zsh' is not an agent)\n`);
    expect(existsSync(join(f.dir, "submits"))).toBe(false);
  } finally { f.close(); }
});

test("all excludes own aliases; audit and submit IDs differ; rowless arguments survive", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.bus, "reset-generation.json"), JSON.stringify({ state: "pristine" }));
    const result = await f.run(["--all", "-m", "preserve both"]);
    expect(JSON.parse(readFileSync(join(f.bus, "reset-generation.json"), "utf8"))).toEqual({ state: "reused", first_mutation: "command" });
    expect(existsSync(join(f.bus, ".tap-bus-authority"))).toBe(true);
    expect(result.code).toBe(0);
    const submits = readFileSync(join(f.dir, "submits"), "utf8").trim().split("\n");
    expect(submits.map(line => line.split("\t")[0])).toEqual(["a", "b"]);
    expect(submits[0]).toContain("\t\t%1\tsession\tclaude");
    const audits = readdirSync(join(f.bus, "payloads"));
    expect(audits.length).toBe(2);
    for (const audit of audits) {
      const id = audit.slice(0, -3);
      expect(submits.join()).not.toContain(`[[sv:${id}]]`);
      expect(JSON.parse(readFileSync(join(f.bus, "receipts", `${id}.placed`), "utf8")).via).toBe("command");
      expect(JSON.parse(readFileSync(join(f.bus, "receipts", `${id}.done`), "utf8")).auto).toBe(true);
    }
  } finally { f.close(); }
});

test("submit park is hard failure; live Codex beats the row; self mappings and degradation", async () => {
  const f = fixture();
  try {
    expect((await f.run(["a", "b"], { SUBMIT_RC: "4" })).code).toBe(1);
    expect(readFileSync(join(f.dir, "submits"), "utf8").trim().split("\n").length).toBe(2);
    expect(readdirSync(join(f.bus, "payloads"))).toEqual([]);
    const codex = await f.run(["a"], { LIVE_HARNESS: "codex" });
    expect(codex.code).toBe(1); expect(codex.err).toContain("self-trigger");
    expect(readFileSync(join(f.dir, "submits"), "utf8").trim().split("\n").length).toBe(2);
    for (const target of ["lead", "alias"]) {
      const self = await f.run([target, "-m", "keep work"]);
      expect(self.code).toBe(1); expect(self.err).toContain("/tap:self compact");
      expect(readFileSync(join(f.dir, "submits"), "utf8").trim().split("\n")).toHaveLength(2);
    }
    const unsupported = await f.run(["a"], { TAP_JSON: "1", LIVE_HARNESS: "cursor" });
    expect(unsupported.code).toBe(6); expect(unsupported.out).toBe(""); expect(unsupported.err).toContain("degraded");
  } finally { f.close(); }
});

test.each([["placed", "0", 0], ["done", "0", 1], ["done", "5", 6]] as const)("audit %s fault with wake rc %s returns %d", async (fault, wake, code) => {
  const f = fixture();
  try {
    const result = await f.run(["a", "-m", "preserve literal 'focus'"], { AUDIT_FAULT: fault, WAKE_RC: wake });
    expect(result.code).toBe(code);
    expect(readdirSync(join(f.bus, "payloads")).length).toBe(fault === "done" ? 0 : 1);
    expect(result.err).toContain(fault === "placed" ? "placed receipt not written" : "collided before commit");
    if (wake !== "0") expect(result.err).toContain("preserve literal 'focus'");
  } finally { f.close(); }
});

test.each(["SIGINT", "SIGTERM"] as const)("%s stops fan-out and reaps a resistant lock-holding descendant", async signal => {
  const f = fixture();
  const lock = join(f.env.TAP_LOCK_DIR!, "pane-submit-_1.lock");
  mkdirSync(f.env.TAP_LOCK_DIR!, { recursive: true });
  // This script holds the same kernel sidecar shape as the submitter. It
  // ignores TERM after its parent exits, so waiting for the parent is not enough.
  writeFileSync(join(f.dir, "resistant.sh"), 'trap "" TERM\nprintf "%s" "$$" > "$FIXTURE/descendant.pid"\nwhile :; do sleep 1; done\n');
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  writeFileSync(join(f.dir, "locked.sh"), `exec ${[KERNEL_LOCK, ...kernelLockArgs(lock, Infinity, ["bash", join(f.dir, "resistant.sh")])].map(quote).join(" ")}\n`);
  const child = f.start(["a", "b"], { BLOCK_SUBMIT: "1" });
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  let parent = 0, descendant = 0;
  try {
    const deadline = Date.now() + 10000;
    while (!existsSync(join(f.dir, "descendant.pid"))) {
      if (Date.now() > deadline) { child.kill("SIGTERM"); throw new Error("submit fixture did not become ready"); }
      if (child.exitCode !== null) throw new Error(`submit fixture failed: ${(await output).join("\n")}`);
      await sleep(20);
    }
    parent = Number(readFileSync(join(f.dir, "parent.pid"), "utf8"));
    descendant = Number(readFileSync(join(f.dir, "descendant.pid"), "utf8"));
    expect(acquirePaneLock("%1", 0, f.env)).toBe(null);
    child.kill(signal); await sleep(30); child.kill(signal);
    expect(await child.exited).toBe(signal === "SIGINT" ? 130 : 143);
    await output;
    expect(readFileSync(join(f.dir, "submits"), "utf8").trim().split("\n").map(line => line.split("\t")[0])).toEqual(["a"]);
    const acquired = acquirePaneLock("%1", 0, f.env);
    expect(acquired).not.toBe(null); acquired?.release();
    const state = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(descendant)], { encoding: "utf8" });
    expect(state.status !== 0 || !state.stdout.trim() || state.stdout.trim().startsWith("Z")).toBe(true);
  } finally {
    child.kill("SIGKILL");
    if (parent) { try { process.kill(-parent, "SIGKILL"); } catch {} }
    if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch {} }
    await child.exited; await output; f.close();
  }
}, 15000);

test.each([[[]], [["-m", "preserve focus"]]])("missing proof prevents peer success and retains follow-up %j", async flags => {
  const f = fixture();
  try {
    const result = await f.run(["a", ...flags], { PROOF_TIMEOUT: "1" });
    expect(result.code).toBe(1);
    expect(result.err).toContain("compaction unverified");
    expect(existsSync(join(f.dir, "focus-body"))).toBe(false);
    expect(readdirSync(join(f.bus, "payloads"))).toEqual([]);
    const files = readdirSync(join(f.bus, "handoff"));
    expect(files.some(name => name.endsWith(".resume.txt"))).toBe(true);
    expect(JSON.parse(readFileSync(join(f.bus, "handoff", files.find(name => name.endsWith(".receipt.json"))!), "utf8")).state).toBe("not-compacted");
  } finally { f.close(); }
});

test("a successful child exit with no positive proof receipt cannot publish success", async () => {
  const f = fixture();
  try {
    const result = await f.run(["a"], { SKIP_PROOF_RECEIPT: "1" });
    expect(result.code).toBe(1);
    expect(readdirSync(join(f.bus, "payloads"))).toEqual([]);
    expect(existsSync(join(f.dir, "focus-body"))).toBe(false);
  } finally { f.close(); }
});

test("no-focus peer resume uses the same durable note as the focus path", async () => {
  const f = fixture();
  try {
    expect((await f.run(["a"])).code).toBe(0);
    expect(readFileSync(join(f.dir, "submits"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(join(f.dir, "focus-body"), "utf8")).toContain("Post-compaction resume check.");
  } finally { f.close(); }
});
