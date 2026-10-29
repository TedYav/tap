import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { shlexQuote as q } from "../src/launcher/invocation";
import { removeScratchTree } from "./support/scratch";

const REPO = resolve(import.meta.dir, "../../..");
const RUNNER_ROOT = process.env.TMUX_TMPDIR;
if (!RUNNER_ROOT) throw new Error("codex-session-start.test.ts: use runtime/bun/test/run.sh");

// Exercise the real adapter in a real private pane: a hidden worker inherits
// valid launch evidence for an already accepted parent, exactly like a new
// interactive session. Only its payload's transcript field distinguishes it.
test("Codex workers stay silent and preserve the parent; persisted starts still bind", async () => {
  const root = realpathSync(mkdtempSync(join(RUNNER_ROOT, "codex-start-")));
  const index = join(root, "index"), registry = join(root, ".tap/team-registry.json");
  const socket = join(root, "tmux.sock");
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: join(root, "home"), TAP_INDEX_HOME: index,
    TAP_HOME: join(root, ".tap/bus"), TAP_LAUNCH_ROOT: root, TAP_LAUNCH_ID: "launch-parent",
    TAP_TMUX_SOCKET_PATH: socket, TAP_SKIP_VERSION_BRIEFING: "1", TAP_SETUP_OPEN_GUIDE: "0",
  };
  for (const key of ["TMUX", "TMUX_PANE", "TAP_SELF", "TAP_STATELESS", "TAP_CLEAR_ID", "TAP_SERVER_EPOCH", "TAP_BOOT_ID", "TAP_HARNESS_SESSION_ID", "TAP_TRANSCRIPT_PATH"]) delete env[key];
  const tmux = (args: string[]) => {
    const r = spawnSync("tmux", ["-S", socket, ...args], { env, encoding: "utf8", timeout: 5000 });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };
  const invalid = [undefined, null, "", 7, true, ["rollout.jsonl"], { path: "rollout.jsonl" }];
  const sources = ["startup", "resume", "clear", "compact", "fork"];
  const cases = [
    ...invalid.map((transcript_path, i) => ({ session_id: `worker-${i}`, source: "startup", transcript_path })),
    ...sources.map(source => ({ session_id: `live-${source}`, source, transcript_path: join(root, `missing-${source}.jsonl`) })),
    { session_id: "live-relaunch", source: "clear", transcript_path: join(root, "missing-relaunch.jsonl") },
  ];
  try {
    for (const path of [env.HOME!, env.TAP_HOME!, index]) mkdirSync(path, { recursive: true });
    expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
    const script = join(root, "run.sh");
    const lines = ["#!/bin/bash", `while [ ! -e ${q(join(root, "start"))} ]; do sleep 0.02; done`];
    for (const [i, payload] of cases.entries()) {
      const relaunch = payload.session_id === "live-relaunch";
      writeFileSync(join(root, `${i}.json`), JSON.stringify({ cwd: root, hook_event_name: "SessionStart", ...payload }));
      if (relaunch) lines.push(`${q(process.execPath)} -e ${q(`import {readFileSync,writeFileSync} from 'node:fs'; const path=${JSON.stringify(registry)}; const doc=JSON.parse(readFileSync(path,'utf8')); doc.seats.agent.expected_clear_nonce='clear-relaunch'; writeFileSync(path,JSON.stringify(doc));`)}`);
      lines.push(
        `${relaunch ? "TAP_CLEAR_ID=clear-relaunch " : ""}bash ${q(join(REPO, "hooks/tap-codex-session-start.sh"))} < ${q(join(root, `${i}.json`))} > ${q(join(root, `${i}.out`))} 2> ${q(join(root, `${i}.err`))}`,
        `echo $? > ${q(join(root, `${i}.status`))}`,
        `cp ${q(registry)} ${q(join(root, `${i}.registry`))}`,
        // The first trace is created before any binding child. Checking after
        // every skipped invocation catches entry into sessionContext as well.
        `if [ -e ${q(join(index, "logs/startup.jsonl"))} ]; then touch ${q(join(root, `${i}.trace`))}; fi`,
      );
    }
    lines.push(`touch ${q(join(root, "done"))}`, "sleep 60");
    writeFileSync(script, lines.join("\n") + "\n");
    const pane = tmux(["new-session", "-d", "-s", "guard/agent", "-c", root, "-P", "-F", "#{pane_id}", `/bin/bash ${q(script)}`]);
    const [epoch, observedSocket] = tmux(["display-message", "-p", "-t", pane, "#{pid}:#{start_time}\t#{socket_path}"]).split("\t");
    writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "guard", worktree_root: root }, seats: {
      agent: { status: "active", delivery: "pane", harness: "codex", session: "guard/agent", pane: "guard/agent:0.0", pane_id: pane,
        server_epoch: `srv:${epoch}`, server_socket: observedSocket, instance: "agent|parent", launch_witness: "launch-parent",
        harness_session_id: "parent-session", transcript_path: join(root, "parent.jsonl"), identity_capture_result: { decision: "accepted" } },
    } }));
    writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
      guard: { root, registry_location: registry, state: "registered" },
    } }));
    const before = readFileSync(registry, "utf8");
    writeFileSync(join(root, "start"), "");
    const deadline = Date.now() + 45000;
    while (!existsSync(join(root, "done")) && Date.now() < deadline) await Bun.sleep(25);
    expect(existsSync(join(root, "done"))).toBe(true);
    for (const [i, payload] of cases.entries()) {
      expect(readFileSync(join(root, `${i}.status`), "utf8").trim(), payload.session_id).toBe("0");
      const out = readFileSync(join(root, `${i}.out`), "utf8");
      const saved = readFileSync(join(root, `${i}.registry`), "utf8");
      if (i < invalid.length) {
        expect(out, payload.session_id).toBe("");
        expect(readFileSync(join(root, `${i}.err`), "utf8")).toBe("");
        expect(saved, payload.session_id).toBe(before);
        expect(existsSync(join(root, `${i}.trace`))).toBe(false);
      } else {
        const context = JSON.parse(out).hookSpecificOutput.additionalContext;
        expect(context).toContain("TAP: registered as agent on team guard.");
        expect(context).toContain("TAP skills:");
        expect(JSON.parse(saved).seats.agent.harness_session_id).toBe(payload.session_id);
        expect(JSON.parse(saved).seats.agent.instance).toBe("agent|parent");
        if (payload.session_id === "live-relaunch") {
          // Registration answers the nonce; the launcher clears its expectation.
          expect(JSON.parse(saved).seats.agent.expected_clear_nonce).toBe("clear-relaunch");
          expect(JSON.parse(saved).seats.agent.clear_nonce).toBe("clear-relaunch");
        }
        expect(existsSync(payload.transcript_path as string)).toBe(false);
      }
    }
  } finally {
    spawnSync("tmux", ["-S", socket, "kill-server"], { env, stdio: "ignore" });
    removeScratchTree(root);
  }
}, 60000);
