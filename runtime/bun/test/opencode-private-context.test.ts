import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { shlexQuote as q } from "../src/launcher/invocation";
import { removeScratchTree } from "./support/scratch";

const ENTRY = join(import.meta.dir, "../src/session-start.ts");

for (const mode of ["delayed", "old-witness", "stale-active", "rollback", "wrong-session"] as const) {
  test(`private context waits for launcher activation (${mode})`, async () => {
    const root = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR!, "oc-private-")));
    const socket = join(root, "tmux.sock"), registry = join(root, ".tap/team-registry.json"), index = join(root, "index");
    const env: NodeJS.ProcessEnv = { ...process.env, TAP_INDEX_HOME: index, TAP_HOME: join(root, ".tap/bus"),
      TAP_TMUX_SOCKET_PATH: socket, TAP_LAUNCH_ROOT: root, TAP_LAUNCH_ID: "new-launch", TAP_SKIP_VERSION_BRIEFING: "1" };
    for (const key of ["TMUX", "TMUX_PANE", "TAP_SELF", "TAP_CLEAR_ID", "TAP_SERVER_EPOCH", "TAP_BOOT_ID", "TAP_STATELESS"]) delete env[key];
    const tmux = (...args: string[]) => {
      const result = spawnSync("tmux", ["-S", socket, ...args], { env, encoding: "utf8", timeout: 5000 });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    try {
      mkdirSync(env.TAP_HOME!, { recursive: true }); mkdirSync(index);
      const script = join(root, "run.sh"), start = join(root, "start"), output = join(root, "context"), status = join(root, "status");
      writeFileSync(script, `#!/bin/sh
while [ ! -f ${q(start)} ]; do sleep 0.02; done
${q(process.execPath)} ${q(ENTRY)} context-private ses_expected ${q(root)} > ${q(output)}
echo $? > ${q(status)}
sleep 60
`);
      const pane = tmux("new-session", "-d", "-s", "private/seat", "-c", root, "-P", "-F", "#{pane_id}", `/bin/sh ${q(script)}`);
      const rawEpoch = tmux("display-message", "-p", "-t", pane, "#{pid}:#{start_time}");
      const row: Record<string, unknown> = { status: "active", status_reason: ["old-witness", "stale-active"].includes(mode) ? "" : "launching",
        harness: "opencode", pane_id: pane, session: "private/seat", pane: "private/seat:0.0", server_epoch: `srv:${rawEpoch}`,
        harness_session_id: mode === "wrong-session" ? "ses_other" : "ses_expected", launch_id: "new-launch", launch_witness: "old-launch" };
      if (mode === "stale-active") delete row.launch_id;
      // Replace the registry atomically: the child reads it while the test rewrites it.
      const save = () => {
        writeFileSync(`${registry}.tmp`, JSON.stringify({ schema: "0.20", team: { name: "private", worktree_root: root }, seats: { seat: row } }));
        renameSync(`${registry}.tmp`, registry);
      };
      save();
      writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
        private: { root, registry_location: registry, state: "registered" },
      } }));
      const before = readFileSync(registry, "utf8");
      writeFileSync(start, "");
      await Bun.sleep(300);
      if (mode === "delayed" || mode === "wrong-session") {
        expect(existsSync(status)).toBe(false);
        row.status_reason = ""; row.launch_witness = "new-launch"; delete row.launch_id; save();
      } else if (mode === "rollback") {
        row.status = "suspended"; row.status_reason = "launch_failed"; save();
      }
      const activated = readFileSync(registry, "utf8");
      const deadline = Date.now() + 8000;
      // `echo $? > status` creates the file empty before it writes the code: wait for the content.
      const written = () => existsSync(status) && readFileSync(status, "utf8").trim() !== "";
      while (!written() && Date.now() < deadline) await Bun.sleep(50);
      expect(existsSync(status)).toBe(true);
      const text = readFileSync(output, "utf8");
      if (mode === "delayed") {
        expect(readFileSync(status, "utf8").trim()).toBe("0");
        expect(text).toContain("TAP: registered as seat on team private.");
        expect(text).not.toContain("not registered");
      } else {
        expect(readFileSync(status, "utf8").trim()).toBe("1");
        expect(text).toBe("");
      }
      expect(readFileSync(registry, "utf8")).toBe(activated);
      if (mode === "old-witness" || mode === "stale-active") expect(activated).toBe(before);
    } finally {
      spawnSync("tmux", ["-S", socket, "kill-server"], { env, stdio: "ignore" });
      removeScratchTree(root);
    }
  }, 20000);
}
