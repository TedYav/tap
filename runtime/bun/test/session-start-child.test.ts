import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { shlexQuote as q } from "../src/launcher/invocation";
import { removeScratchTree } from "./support/scratch";
import { observeSessionStartAncestry, type PsRow } from "../src/observe";

const REPO = resolve(import.meta.dir, "../../..");
const RUNNER_ROOT = process.env.TMUX_TMPDIR;
if (!RUNNER_ROOT) throw new Error("session-start-child.test.ts: use runtime/bun/test/run.sh");

test("SessionStart ancestry distinguishes forwarding shims from nested harnesses", () => {
  const inspect = (commands: Array<[string, string]>) => {
    const table = new Map<string, PsRow>(commands.map(([comm, command], i) => [String(i + 10), ["10", "10", comm, command]]));
    return observeSessionStartAncestry(String(9 + commands.length), 10, table, pid => String(pid + 1), {}).state;
  };
  const hook: [string, string] = ["bun", "bun /repo/runtime/bun/src/session-start.ts claude"];
  expect(inspect([hook, ["sh", "sh -c hook"], ["claude", "claude"]])).toBe("seat");
  expect(inspect([hook, ["bash", "bash fixture.sh"]])).toBe("seat");
  // Codex's npm entry forwards process.argv.slice(2) unchanged to its binary:
  // openai/codex d63fe536ee2bf4ea7d18d81e0e1be17543bf5b5b, codex-cli/bin/codex.js:232.
  expect(inspect([hook, ["codex", "codex --resume S"], ["node", "node /pkg/codex/bin/codex.js --resume S"], ["zsh", "zsh"]])).toBe("seat");
  expect(inspect([hook, ["claude", "claude -p hello"], ["claude", "claude"]])).toBe("nested");
  expect(inspect([hook, ["codex", "codex exec hello"], ["claude", "claude"]])).toBe("nested");
  expect(inspect([hook, ["codex", "codex exec hello"], ["node", "node /pkg/codex/bin/codex.js"]])).toBe("nested");
  expect(inspect([hook, ["claude", "claude -p hello"], ["bash", "bash -c helper"], ["claude", "claude"]])).toBe("nested");
  expect(observeSessionStartAncestry("20", 10, null, () => "20", {}).state).toBe("unobservable");
  expect(observeSessionStartAncestry("20", 10, new Map([["10", ["10", "10", ...hook]]]), () => "1", {}).state).toBe("unobservable");
});

test("version-named Claude processes still establish a nested-harness refusal", () => {
  const root = mkdtempSync(join(RUNNER_ROOT, "version-child-"));
  try {
    const versions = join(root, ".local/share/claude/versions");
    mkdirSync(versions, { recursive: true });
    writeFileSync(join(versions, "2.1.312"), "fixture", { mode: 0o755 });
    const table = new Map<string, PsRow>([
      ["10", ["10", "10", "bun", "bun session-start.ts claude"]],
      ["11", ["10", "10", "2.1.312", `${versions}/2.1.312 -p hello`]],
      ["12", ["10", "10", "claude", "claude"]],
    ]);
    expect(observeSessionStartAncestry("12", 10, table, pid => String(pid + 1), { HOME: root })).toMatchObject({ state: "nested", family: "claude" });
  } finally { removeScratchTree(root); }
});

// Real process ancestry and a private tmux pane; only the harness conversation
// is a fixture. No authenticated harness or operator transcript is opened.
for (const mode of ["claude", "codex", "cursor", "agy"]) {
  for (const scenario of ["inherited", "unset-tmux", "private-pty", "own-unobservable"]) {
    const unsetTmux = scenario === "unset-tmux", own = scenario === "own-unobservable";
    test(`${mode} ${scenario} preserves its parent binding${own ? " and later recovers" : ""}`, async () => {
      const root = realpathSync(mkdtempSync(join(RUNNER_ROOT, "child-start-")));
      const index = join(root, "index"), registry = join(root, ".tap/team-registry.json");
      const socket = join(root, "tmux.sock");
      const env: NodeJS.ProcessEnv = {
        ...process.env, HOME: join(root, "home"), TAP_INDEX_HOME: index,
        TAP_HOME: join(root, ".tap/bus"), TAP_LAUNCH_ROOT: root, TAP_LAUNCH_ID: "parent-launch",
        TAP_TMUX_SOCKET_PATH: socket, TAP_SKIP_VERSION_BRIEFING: "1", TAP_SETUP_OPEN_GUIDE: "0",
      };
      for (const key of ["TMUX", "TMUX_PANE", "TAP_SELF", "TAP_STATELESS", "TAP_CLEAR_ID", "TAP_SERVER_EPOCH", "TAP_BOOT_ID", "TAP_HARNESS_SESSION_ID", "TAP_TRANSCRIPT_PATH"]) delete env[key];
      const tmux = (args: string[]) => {
        const r = spawnSync("tmux", ["-S", socket, ...args], { env, encoding: "utf8", timeout: 5000 });
        expect(r.status, r.stderr).toBe(0);
        return r.stdout.trim();
      };
      try {
        for (const path of [env.HOME!, env.TAP_HOME!, index]) mkdirSync(path, { recursive: true });
        expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
        const transcript = join(root, "child.jsonl");
        writeFileSync(transcript, '{"prompt":"Reply with the single word: ok"}\n');
        const childId = "90de61f1-9729-4c5c-817f-0cb18b89b010";
        if (mode === "agy") {
          const dbdir = join(root, "home/.gemini/antigravity-cli");
          mkdirSync(dbdir, { recursive: true });
          const db = new Database(join(dbdir, "conversation_summaries.db"));
          db.exec("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT NOT NULL DEFAULT '', nesting_depth INTEGER NOT NULL DEFAULT 0)");
          db.query("INSERT INTO conversation_summaries (conversation_id) VALUES (?)").run(childId);
          db.close();
          env.ANTIGRAVITY_CONVERSATION_ID = childId;
          env.TAP_GEMINI_HOME = join(root, "home/.gemini");
        }
        const payload = { cwd: root, source: "startup", session_id: childId, transcript_path: transcript,
          conversationId: childId, workspacePaths: [root], transcriptPath: transcript };
        const helper = join(root, `${mode}-helper.ts`), parent = join(root, scenario === "private-pty" ? "agy-parent.py" : `${own ? mode : "claude"}-parent.ts`);
        const faultBin = join(root, "fault-bin");
        mkdirSync(faultBin);
        writeFileSync(join(faultBin, "ps"), '#!/bin/sh\nif [ "$1" = -Ao ]; then exit 1; fi\nexec /bin/ps "$@"\n');
        chmodSync(join(faultBin, "ps"), 0o755);
        const fire = `
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
for (const recovery of ${JSON.stringify(own ? [false, true] : [false])}) {
const env = { ...process.env };
if (${unsetTmux}) { delete env.TMUX; delete env.TMUX_PANE; }
if (${own} && !recovery) env.PATH = ${JSON.stringify(faultBin)} + ':' + env.PATH;
const r = spawnSync(process.execPath, ${JSON.stringify(mode === "agy" ? [join(REPO, "runtime/bun/src/agy-identity-hook.ts")] : [join(REPO, "runtime/bun/src/session-start.ts"), mode])}, {
  input: ${JSON.stringify(JSON.stringify(payload))}, env, encoding: 'utf8', timeout: 20000,
});
writeFileSync(${JSON.stringify(root)} + (recovery ? '/recovery.json' : '/result.json'), JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr, registry: readFileSync(${JSON.stringify(registry)}, 'utf8') }));
}
`;
        writeFileSync(helper, fire);
        writeFileSync(parent, `
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
while (!existsSync(${JSON.stringify(join(root, "start"))})) await Bun.sleep(20);
${own ? `await import(${JSON.stringify(helper)}); const r = { status: 0, stderr: '' };` : `const r = spawnSync('/bin/bash', ['-c', ${JSON.stringify(`${q(process.execPath)} ${q(helper)} ${mode === "codex" ? "exec" : "-p"}; :`)}], { env: process.env, encoding: 'utf8', timeout: 25000 });`}
writeFileSync(${JSON.stringify(join(root, "done"))}, JSON.stringify({ status: r.status, stderr: r.stderr }));
await Bun.sleep(60000);
`);
        if (scenario === "private-pty") writeFileSync(parent, `
import os, pty, time
while not os.path.exists(${JSON.stringify(join(root, "start"))}): time.sleep(0.02)
pid, fd = pty.fork()
if pid == 0: os.execv(${JSON.stringify(process.execPath)}, ${JSON.stringify([process.execPath, helper, mode === "codex" ? "exec" : "-p"])})
os.waitpid(pid, 0)
os.close(fd)
open(${JSON.stringify(join(root, "done"))}, 'w').close()
time.sleep(60)
`);
        const parentRuntime = scenario === "private-pty" ? "python3" : process.execPath;
        const pane = tmux(["new-session", "-d", "-s", "guard/agent", "-c", root, "-P", "-F", "#{pane_id}", `exec ${q(parentRuntime)} ${q(parent)}`]);
        const [epoch, observedSocket] = tmux(["display-message", "-p", "-t", pane, "#{pid}:#{start_time}\t#{socket_path}"]).split("\t");
        writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "guard", worktree_root: root }, seats: {
          agent: { status: "active", delivery: "pane", harness: own ? mode : "claude", session: "guard/agent", pane: "guard/agent:0.0", pane_id: pane,
            server_epoch: `srv:${epoch}`, server_socket: observedSocket, instance: "agent|parent", launch_witness: "parent-launch",
            harness_session_id: "parent-session", transcript_path: join(root, "parent.jsonl"), identity_capture_result: { decision: "accepted" } },
        } }));
        writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
          guard: { root, registry_location: registry, state: "registered" },
        } }));
        const before = readFileSync(registry, "utf8");
        writeFileSync(join(root, "start"), "");
        const deadline = Date.now() + 30000;
        while (!existsSync(join(root, "done")) && Date.now() < deadline) await Bun.sleep(25);
        expect(existsSync(join(root, "done"))).toBe(true);
        const result: { status: number | null; stdout: string; stderr: string; registry: string } = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
        expect(result.status, result.stderr).toBe(0);
        expect(result.registry).toBe(before);
        expect(result.stdout).toBe(mode === "agy" ? "{}\n" : "");
        if (own) {
          const recovery: typeof result = JSON.parse(readFileSync(join(root, "recovery.json"), "utf8"));
          expect(recovery.status, recovery.stderr).toBe(0);
          expect(JSON.parse(recovery.registry).seats.agent.harness_session_id).toBe(childId);
          if (mode !== "agy") expect(recovery.stdout).toContain("TAP: registered as agent on team guard.");
        }
        const trace = join(index, "logs/startup.jsonl");
        const traceDeadline = Date.now() + 2000;
        while ((!existsSync(trace) || !readFileSync(trace, "utf8").includes("sessionstart_skipped")) && Date.now() < traceDeadline) await Bun.sleep(25);
        expect(readFileSync(trace, "utf8")).toContain("sessionstart_skipped");
        expect(readFileSync(trace, "utf8")).toContain(own ? "ancestry_unobservable" : "nested_harness");
      } finally {
        spawnSync("tmux", ["-S", socket, "kill-server"], { env, stdio: "ignore" });
        removeScratchTree(root);
      }
    }, 40000);
  }
}
