import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { attachPlan, ATTACH_REFUSED_IN_TMUX, callerInTmux, type CallerFacts } from "../src/launcher/attach-policy";
import { removeScratchTree } from "./support/scratch";

const root = realpathSync(mkdtempSync(join(tmpdir(), "tap-dead-attach.")));
const socket = "dead-attach-" + process.pid;
const savedTmux = process.env.TMUX;
const env = { ...process.env };
delete env.TMUX;
delete env.TMUX_PANE;
const T = (...args: string[]) => {
  const r = spawnSync("tmux", ["-L", socket, ...args], { env, encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
};
const facts: Record<string, CallerFacts> = {};
beforeAll(async () => {
  for (const name of ["dead", "live"]) {
    const pane = T("new-session", "-d", "-s", name, "-c", root, "-P", "-F", "#{pane_id}", "exec sleep 600");
    const tmux = T("display-message", "-p", "-t", pane, "#{socket_path},#{pid},0");
    const tty = T("display-message", "-p", "-t", pane, "#{pane_tty}");
    expect(tty).not.toBe("");
    facts[name] = { tmux, tmux_pane: pane, caller_tty: tty, owns_foreground: true, has_tty: true };
  }
  process.env.TMUX = facts.live!.tmux;
  const pane = facts.dead!.tmux_pane;
  T("set-option", "-w", "-t", pane, "remain-on-exit", "on");
  T("send-keys", "-t", pane, "C-c");
  for (let i = 0; i < 100 && T("display-message", "-p", "-t", pane, "#{pane_dead}") !== "1"; i++) await Bun.sleep(10);
  expect(T("display-message", "-p", "-t", pane, "#{pane_dead}")).toBe("1");
  expect(T("display-message", "-p", "-t", facts.live!.tmux_pane, "#{pane_dead}")).toBe("0");
  expect(T("display-message", "-p", "-t", pane, "#{pane_tty}")).toBe(facts.dead!.caller_tty);
});
afterAll(() => {
  if (savedTmux === undefined) delete process.env.TMUX; else process.env.TMUX = savedTmux;
  spawnSync("tmux", ["-L", socket, "kill-server"], { env });
  removeScratchTree(root);
});

test("a retained dead pane cannot claim the caller tty; a live matching pane still refuses nesting", async () => {
  expect(await callerInTmux(facts.dead!)).toBe("no");
  expect(await callerInTmux(facts.live!)).toBe("yes");
  expect(await attachPlan("target", facts.dead!)).toEqual({
    argv: ["tmux", "-S", facts.dead!.tmux.split(",")[0]!, "attach-session", "-t", "=target"],
    unset_env: ["TMUX", "TMUX_PANE"],
  });
  expect(await attachPlan("target", facts.live!)).toEqual({ refused: ATTACH_REFUSED_IN_TMUX });
});
