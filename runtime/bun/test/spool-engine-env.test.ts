import { installSpoolPane } from "./support/spool-pane";
import { spoolContextFacts } from "../src/spool-engine-worker";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("native single submit sends every key to the selected socket, not the ambient server", () => {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "spool-ns-"));
  const realTmux = Bun.which("tmux")!, a = `b7a-${crypto.randomUUID().slice(0, 8)}`, b = `b7b-${crypto.randomUUID().slice(0, 8)}`;
  const run = (socket: string, ...args: string[]) => {
    const result = Bun.spawnSync([realTmux, "-L", socket, ...args]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  try {
    for (const socket of [a, b]) run(socket, "new-session", "-d", "-s", "fixture", "-x", "160", "-y", "30", "/bin/cat");
    const paneId = run(b, "display-message", "-p", "-t", "fixture:0.0", "#{pane_id}");
    const home = join(root, "bus"), registry = join(home, "registry.json");
    for (const folder of ["spool", "payloads", "receipts"]) mkdirSync(join(home, folder), { recursive: true });
    writeFileSync(join(home, ".tap-bus-authority"), "");
    writeFileSync(registry, '{"schema":"0.20","team":{"name":"fixture"},"seats":{}}');
    writeFileSync(join(home, "spool/a.md"), "---\nid: a\nfrom: sender\nto: peer\nkind: discuss\nreply: expected\n---\nbody\n");
    writeFileSync(join(home, "spool/a.meta.json"), JSON.stringify({ id: "a", target: "peer", target_registry: registry,
      to_team: "fixture", pane: "fixture:0.0", pane_id: paneId, policy: "standard" }));
    const env: NodeJS.ProcessEnv = { ...process.env, TAP_HOME: home, TAP_INDEX_HOME: join(root, "index"),
      TAP_TMUX_SOCKET: b, TAP_TMUX_SOCKET_PATH: undefined, TMUX: `${run(a, "display-message", "-p", "#{socket_path}")},1,0`,
      TAP_SPOOL_DISABLE_DELIVERER: "1", REAL_TMUX: realTmux };
    const pane = installSpoolPane(root, registry, env, "codex", false, { handle: "peer", pane: "fixture:0.0", paneId }, true);
    // Observations use a deterministic Codex frame; each actual key also reaches
    // the real target. Both servers expose the same pane id, so a lost socket pin
    // types into A and fails this assertion rather than merely failing to find B.
    const shim = join(root, "pane-bin/tmux");
    writeFileSync(shim, readFileSync(shim, "utf8").replace('#!/bin/bash\n', '#!/bin/bash\nraw=("$@")\n')
      .replace('cmd="$1"; shift', 'cmd="$1"; shift\nif [ "$cmd" = send-keys ]; then "$REAL_TMUX" "${raw[@]}" || exit 1; fi'));
    const beforeA = run(a, "capture-pane", "-p", "-t", "fixture:0.0");
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/spool-engine.ts"),
      join(import.meta.dir, "../../../skills/tap/scripts"), "redeliver", "a", "peer", "fixture:0.0", paneId, "fixture", registry], { env });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(run(a, "capture-pane", "-p", "-t", "fixture:0.0")).toBe(beforeA);
    expect(run(b, "capture-pane", "-p", "-t", "fixture:0.0")).toContain("[[TAP v0.23 ask a");
    expect(readFileSync(pane.log, "utf8").trim().split("\n").every(line => line.startsWith(`-L ${b} `))).toBe(true);
  } finally {
    for (const socket of [a, b]) Bun.spawnSync([realTmux, "-L", socket, "kill-server"]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("native context keeps all fourteen worker facts on the selected bus", () => {
  const root = mkdtempSync(join(tmpdir(), "spool-context-"));
  const selected = join(root, "selected"), cwd = join(root, "foreign"), home = join(selected, ".tap/bus"), index = join(root, "index");
  for (const path of [home, join(cwd, ".tap/bus"), index]) mkdirSync(path, { recursive: true });
  const registry = join(selected, ".tap/team-registry.json"), foreign = join(cwd, ".tap/team-registry.json");
  writeFileSync(registry, '{"schema":"0.20","team":{"name":"decoy"},"seats":{}}');
  writeFileSync(foreign, '{"schema":"0.20","team":{"name":"foreign"},"seats":{}}');
  const env = { ...process.env, TAP_HOME: home, TAP_INDEX_HOME: index, TAP_VERB: "tap watch tick",
    TAP_SPOOL_DRAIN_ACTIVE: "1", TAP_SPOOL_HUMAN_ALERT: "watcher", TAP_WATCH_TICK_QUEUED_PROBE_ID: "q-1", TAP_WATCH_TICK_PROBE_TIMEOUT: "77" };
  const realHome = realpathSync(home);
  const compare = (team = "", acting = "") => {
    const actual = spoolContextFacts(cwd, env);
    expect(actual).toEqual([realHome, join(realHome, "spool"), join(realHome, "payloads"), join(realHome, "receipts"),
      join(realHome, "registry-events.log"), team, acting, "tap watch tick", "courier", "1", "watcher", "q-1", "77", "env"]);
    return actual;
  };
  try {
    expect(compare().slice(5, 7)).toEqual(["", ""]);
    const global = join(index, "global-registry.json");
    writeFileSync(global, JSON.stringify({ schema: "0.20", teams: {
      selected: { root: selected, registry_location: registry }, foreign: { root: cwd, registry_location: foreign },
    } }));
    expect(compare("selected", registry).slice(5, 7)).toEqual(["selected", registry]);
    env.TAP_HOME = "../selected/.tap/bus/";
    expect(compare("selected", registry)[0]).toBe(realpathSync(home));
    writeFileSync(global, "invalid");
    expect(compare()[6]).toBe("");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
