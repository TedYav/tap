// Real OpenCode 2 TUI, private server and local model. Called only by the isolated shell runner.
import { strict as assert } from "node:assert";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { prepareOpenCodeSession } from "../../src/launcher/opencode-prepare";
import { launchCommand } from "../../src/launcher/process";
import { removeScratchTree } from "./scratch";

const repo = resolve(import.meta.dir, "../../../..");
const work = realpathSync(mkdtempSync(join(tmpdir(), "oc2-wire-")));
const socket = join(work, "tmux.sock");
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const tmux = (args: string[]) => {
  const out = Bun.spawnSync(["tmux", "-S", socket, ...args], { stdout: "pipe", stderr: "pipe" });
  assert.equal(out.exitCode, 0, out.stderr.toString()); return out.stdout.toString().trim();
};
const captures: any[] = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const body = await req.json(); captures.push(body);
  const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: "chatcmpl_wire", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return new Response(chunk({ role: "assistant", content: "WIRE_PROBE_COMPLETE" }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
} });

async function arm(withPlugin: boolean) {
  const name = withPlugin ? "ocwire" : "ocmutant", base = join(work, name), root = join(base, "project");
  const config = join(base, "config"), data = join(base, "data"), index = join(base, "index");
  const plugins = join(config, "opencode/plugins");
  for (const path of [root, join(root, ".tap"), plugins, data, index]) mkdirSync(path, { recursive: true });
  if (withPlugin) {
    for (const name of ["tap-opencode-session-start.ts", "tap-opencode-session-id"])
      copyFileSync(join(repo, "hooks", name), join(plugins, name));
    const wrappers = {
      "tap-resolve-session-root": `bun ${quote(join(repo, "runtime/bun/src/session-start.ts"))} resolve`,
      "tap-session-context": `bun ${quote(join(repo, "runtime/bun/src/session-start.ts"))}`,
      tap: quote(join(repo, "bin/tap")),
    };
    for (const [name, command] of Object.entries(wrappers)) writeFileSync(join(plugins, name), `#!/bin/sh\nexec ${command} "$@"\n`, { mode: 0o755 });
  }
  writeFileSync(join(config, "opencode/opencode.jsonc"), JSON.stringify({
    model: "capture/probe", providers: { capture: { package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "local-test" },
      models: { probe: { name: "Probe", limit: { context: 32000, output: 4096 }, variants: [
        { id: "high", body: { user: "wire-high" } }, { id: "low", body: { user: "wire-low" } },
      ] } } } }, agents: { title: { model: "capture/probe" } }, update: "disable", share: "disabled",
  }));
  const registry = join(root, ".tap/team-registry.json");
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { wire: { root, registry_location: registry, state: "registered" } } }));
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "wire" }, seats: {} }));
  const env: NodeJS.ProcessEnv & { OPENCODE_DB_PATH: string } = { ...process.env, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_STATE_HOME: join(base, "state"), XDG_CACHE_HOME: join(base, "cache"),
    TAP_INDEX_HOME: index, OPENCODE_DB_PATH: join(data, "opencode/opencode.db"), TAP_SKIP_VERSION_BRIEFING: "1", PATH: `${plugins}:${process.env.PATH}`, TERM: "xterm-256color" };
  delete env.TAP_HOME; delete env.TMUX; delete env.TMUX_PANE; delete env.TAP_STATELESS;
  const id = await prepareOpenCodeSession({ name: `wire/${name}`, harness: "opencode", base: "wire", cwd: root,
    model: "capture/probe", launch_tuning: { model: "capture/probe", effort: "high", qualifiers: {}, environment: {} } }, env);
  assert.ok(id);
  const command = "exec " + ["env", ...Object.entries(env).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`),
    "opencode", "--standalone", "--session", id, "--prompt", "Give a brief greeting."].map(quote).join(" ");
  let pane = "", start = captures.length;
  const finished = async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (captures.length > start && tmux(["capture-pane", "-p", "-t", pane]).includes("WIRE_PROBE_COMPLETE")) return;
      await Bun.sleep(100);
    }
    throw new Error(`OpenCode wire arm timed out: ${tmux(["capture-pane", "-p", "-t", pane])}`);
  };
  const mainRequest = () => captures.slice(start).find(body => body.tools?.some((tool: any) => tool.function?.name === "shell"));
  const syntheticCount = () => {
    const db = new Database(env.OPENCODE_DB_PATH, { readonly: true });
    try { return (db.query("SELECT COUNT(*) AS n FROM session_message WHERE session_id=? AND type='synthetic'").get(id) as { n: number }).n; }
    finally { db.close(); }
  };
  pane = tmux(["new-session", "-d", "-P", "-F", "#{pane_id}", "-x", "160", "-y", "48", "-s", name, "-c", root, command]);
  await finished();
  const first = mainRequest(); assert.ok(first, "no main model request; wire assertion would be vacuous");
  assert.equal(first.user, "wire-high", "prepared variant missing from first main request");
  if (withPlugin) {
    assert.ok(JSON.stringify(first.messages).includes(`TAP: registered as ${name} on team wire`));
    assert.ok(JSON.stringify(first.messages).includes("The user authorized TAP for this repository"));
    assert.equal(syntheticCount(), 1);
    const snapshots = readdirSync(join(index, "opencode-model-windows.d")).filter(file => file.endsWith(".json"));
    assert.ok(snapshots.some(file => JSON.parse(readFileSync(join(index, "opencode-model-windows.d", file), "utf8")).windows["capture/probe"] === 32000), "running plugin did not publish its resolved model limit");
    // A native model change survives a fresh TUI/server, without restacking context.
    tmux(["respawn-pane", "-k", "-t", pane, "sleep 60"]);
    const changed = await launchCommand(["opencode", "api", "--standalone", "POST", `/api/session/${id}/model`, "--data", JSON.stringify({ model: { providerID: "capture", id: "probe", variant: "low" } })], { env: { ...env, TAP_STATELESS: "1" }, cwd: root, timeoutMs: 20000 });
    assert.equal(changed.code, 0, changed.stderr);
    start = captures.length; tmux(["respawn-pane", "-k", "-t", pane, "-c", root, command]); await finished();
    assert.equal(mainRequest()?.user, "wire-low", "native resume overwrote the selected variant");
    assert.equal(syntheticCount(), 1, "unchanged identity restacked after server restart");
    // Rename this private fixture's seat, then restart: one changed identity block.
    tmux(["respawn-pane", "-k", "-t", pane, "sleep 60"]);
    tmux(["rename-session", "-t", name, "ocrenamed"]);
    const doc = JSON.parse(readFileSync(registry, "utf8"));
    assert.ok(doc.seats[name]); doc.seats.ocrenamed = { ...doc.seats[name], session: "ocrenamed", pane: "ocrenamed:0.0" }; delete doc.seats[name];
    writeFileSync(registry, JSON.stringify(doc));
    start = captures.length; tmux(["respawn-pane", "-k", "-t", pane, "-c", root, command]); await finished();
    assert.equal(syntheticCount(), 2, "changed identity did not admit exactly one block");
    assert.ok(JSON.stringify(mainRequest()?.messages).includes("TAP: registered as ocrenamed on team wire"));
  } else {
    assert.ok(!captures.slice(start).some(body => JSON.stringify(body.messages).includes("TAP: registered as")), "mutant carried TAP context without the plugin");
  }
  tmux(["kill-session", "-t", withPlugin ? "ocrenamed" : name]);
}

try {
  await arm(true); await arm(false);
  console.log("opencode-context-wire: first-request context + variant / restart dedupe / native model resume / changed identity / plugin windows / mutant clean: ok");
} finally {
  try { tmux(["kill-server"]); } catch { /* all sessions may already be gone */ }
  server.stop(true);
  // tmux's kill only signals the TUI and its private server, and both take a moment to
  // close the store. The last arm ends right here, so wait (bounded) until nothing holds
  // the scratch tree; removeScratchTree still refuses if something does. Each look is
  // bounded too: an lsof that does not answer fails the test with the tree left in
  // place, because removeScratchTree would ask it again without a bound.
  const lsof = Bun.which("lsof") ?? "/usr/sbin/lsof";
  for (const deadline = Date.now() + 15000; Date.now() < deadline; await Bun.sleep(200)) {
    const open = Bun.spawnSync([lsof, "+D", work], { stdout: "pipe", stderr: "pipe", timeout: Math.max(1, Math.min(5000, deadline - Date.now())) });
    if (open.exitedDueToTimeout) throw new Error(`lsof did not answer within its bound; scratch left in place: ${work}`);
    if (open.exitCode === 1 && open.stdout.toString().trim() === "") break;
  }
  removeScratchTree(work);
}
