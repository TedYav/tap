import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { protectionUntil, updateInputProtection } from "../src/input-protection";
import { acquirePaneLock } from "../src/panelock";
import { observePaneResult } from "../src/tmux";

test("draft grace and WAIT leave the attached client's status and typing alone", async () => {
  const socket = join(process.env.TMUX_TMPDIR!, "input-notice.sock");
  const env = { ...process.env, TAP_TMUX_SOCKET_PATH: socket, TERM: "xterm-256color" };
  const t = (...args: string[]) => {
    const r = spawnSync("tmux", ["-S", socket, ...args], { env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  let output = "";
  let client: ReturnType<typeof Bun.spawn> | undefined;
  const until = async (predicate: () => boolean) => {
    const end = Date.now() + 3000;
    while (!predicate() && Date.now() < end) await Bun.sleep(20);
    expect(predicate()).toBe(true);
  };
  try {
    const pane = t("-f", "/dev/null", "new-session", "-d", "-s", "notice", "-x", "180", "-y", "30", "-P", "-F", "#{pane_id}", "cat");
    t("set-option", "-t", "notice", "status-left", "OPERATOR_STATUS");
    t("set-option", "-t", "notice", "status-left-length", "30");
    client = Bun.spawn(["tmux", "-S", socket, "attach-session", "-t", "notice"], {
      env, terminal: { cols: 180, rows: 30, data: (_term, data) => { output += Buffer.from(data).toString(); } },
    });
    await until(() => output.includes("OPERATOR_STATUS"));
    const observed = observePaneResult(pane, env);
    expect(observed.status).toBe("ok");
    if (observed.status !== "ok") return;
    const home = process.env.TAP_HOME!;
    mkdirSync(join(home, "payloads"), { recursive: true });
    writeFileSync(join(home, "payloads", "notice-regression.md"), "fixture");
    const options = { env, now: 1000, message: { home, id: "notice-regression", sender: "alice" } };
    const protect = (text: string, now: number) => {
      const lock = acquirePaneLock(pane, 1000, env);
      if (!lock) throw new Error("pane lock unavailable");
      try { return updateInputProtection(observed.observation, { state: "busy", text }, { ...options, now })!; }
      finally { lock.release(); }
    };
    const grace = protect("draft", 1000); // 30-second grace without a transient message.
    expect(protectionUntil(grace)).toBe(31000);
    // Physical client keys exercise the dismissal bug; send-keys bypasses client messages.
    client.terminal!.write("human draft");
    await until(() => t("capture-pane", "-p", "-t", pane).includes("human draft"));
    const held = protect("human draft WAIT", 2000);
    expect(protectionUntil(held)).toBe(122000);
    client.terminal!.write(" WAIT");
    await until(() => t("capture-pane", "-p", "-t", pane).includes("human draft WAIT"));
    expect(output).not.toContain("Incoming message");
    expect(output).not.toContain("Snoozed");
    expect(t("show-options", "-v", "-t", "notice", "status-left")).toBe("OPERATOR_STATUS");
  } finally {
    if (client) { client.kill(); await client.exited; client.terminal?.close(); }
    spawnSync("tmux", ["-S", socket, "kill-server"], { env });
  }
}, 15000);
