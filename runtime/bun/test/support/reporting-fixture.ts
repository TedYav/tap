import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { removeScratchTree } from "./scratch";

const checkout = resolve(import.meta.dir, "../../../..");
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** Real private pane and repository; PATH shims count only the command's probes. */
export function reportingFixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "reporting-")));
  const root = join(dir, "repo"), index = join(dir, "index"), shims = join(dir, "shims");
  const socket = join(dir, "tmux.sock"), trace = join(dir, "trace");
  for (const path of [root, index, shims, join(root, ".tap/bus/payloads"), join(root, ".tap/bus/receipts")]) mkdirSync(path, { recursive: true });
  const command = (exe: string, args: string[], cwd = root) => {
    const r = spawnSync(exe, args, { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${exe} ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  command("git", ["init", "-q"]);
  command("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture", "commit", "--allow-empty", "-qm", "fixture"]);
  const tmux = (...args: string[]) => command("tmux", ["-S", socket, ...args]);
  const pane = tmux("-f", "/dev/null", "new-session", "-d", "-s", "reporting/self", "-P", "-F", "#{pane_id}", "sleep 600");
  tmux("set-option", "-t", "reporting/self", "remain-on-exit", "on");
  const epoch = `srv:${tmux("display-message", "-p", "-t", pane, "#{pid}:#{start_time}")}`;
  const registry = join(root, ".tap/team-registry.json");
  const teams: Record<string, unknown> = { reporting: { root, registry_location: registry, state: "registered" } };
  const writeIndex = () => writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams }));
  writeIndex();
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "reporting", worktree_root: root }, seats: {
    self: { pane: "reporting/self:0.0", pane_id: pane, session: "reporting/self", server_epoch: epoch, status: "active", instance: "self|one", delivery: "pane" },
    peer: { instance: "peer|one", delivery: "poll", status: "active" },
  } }));
  const id = "self-20261104T000000Z-aaaaaaaaaaaa", payload = join(root, ".tap/bus/payloads", `${id}.md`);
  writeFileSync(payload, `---\nid: ${id}\nfrom: self\nto: peer\nkind: question\nreply: expected\npath: ${payload}\nsender_instance: self|one\nrecipient_instance: peer|one\n---\nreporting fixture body\n`);
  writeFileSync(join(root, ".tap/bus/receipts", `${id}.placed`), "{}\n");
  for (const exe of ["git", "ps", "tmux"]) {
    const real = command("/bin/sh", ["-c", `command -v ${exe}`]);
    writeFileSync(join(shims, exe), `#!/bin/sh\nprintf '%s\\0' ${quote(exe)} "$@" >> ${quote(trace)}\nprintf '\\n' >> ${quote(trace)}\nexec ${quote(real)} "$@"\n`, { mode: 0o755 });
  }
  let serial = 0;
  const run = (args: string[], entry = join(checkout, "bin/tap"), cwd = root, extra: NodeJS.ProcessEnv = {}) => {
    const out = join(dir, `out${serial}`), err = join(dir, `err${serial}`), done = join(dir, `done${serial++}`), script = join(dir, "run.sh");
    writeFileSync(trace, "");
    const env = { ...process.env, HOME: dir, TAP_INDEX_HOME: index, TAP_TMUX_SOCKET_PATH: socket, TAP_SKIP_VERSION_BRIEFING: "1", TAP_VERBOSE: "0", TAP_SPOOL_NOW: "1793786400", TAP_REPORTING_CACHE_TTL: "0", PATH: `${shims}:${process.env.PATH}`, TMUX: `${socket},0,0`, TMUX_PANE: pane };
    for (const key of ["TAP_HOME", "TAP_REGISTRY", "TAP_SELF", "TAP_TMUX_SOCKET", "TAP_SERVER_EPOCH", "CLAUDE_JOB_DIR", "CLAUDE_CODE_SESSION_ID", "OPENCODE_SESSION_ID", "XDG_CONFIG_HOME"]) delete (env as NodeJS.ProcessEnv)[key];
    Object.assign(env, extra);
    writeFileSync(script, `#!/bin/sh\ncd ${quote(cwd)}\nenv -i ${Object.entries(env).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${quote(v!)}`).join(" ")} ${quote(entry)} ${args.map(quote).join(" ")} </dev/null >${quote(out)} 2>${quote(err)}\nprintf '%s' "$?" >${quote(done)}\n`);
    tmux("respawn-pane", "-k", "-t", pane, `/bin/sh ${quote(script)}`);
    const deadline = Date.now() + 20000;
    while (!existsSync(done) && Date.now() < deadline) Bun.sleepSync(20);
    if (!existsSync(done)) throw new Error("reporting command timed out");
    return { code: Number(readFileSync(done, "utf8")), stdout: readFileSync(out, "utf8"), stderr: readFileSync(err, "utf8"),
      calls: readFileSync(trace, "utf8").split("\n").filter(Boolean).map(line => line.split("\0").filter(Boolean)) };
  };
  return { root, dir, registry, index, pane, id, run, inbound() {
    const inboundId = "peer-20261104T000000Z-bbbbbbbbbbbb", path = join(root, ".tap/bus/payloads", `${inboundId}.md`);
    writeFileSync(path, `---\nid: ${inboundId}\nfrom: peer\nto: self\nkind: question\nreply: expected\npath: ${path}\nrecipient_instance: self|one\n---\naged inbound\n`);
    writeFileSync(join(root, ".tap/bus/receipts", `${inboundId}.placed`), "{}\n");
  }, otherWorktree(enroll = true) {
    const other = join(dir, enroll ? "other" : "linked");
    command("git", ["worktree", "add", "-q", "--detach", other]);
    if (!enroll) return other;
    mkdirSync(join(other, ".tap/bus"), { recursive: true });
    const reg = join(other, ".tap/team-registry.json");
    writeFileSync(reg, JSON.stringify({ schema: "0.20", team: { name: "other", worktree_root: other }, seats: {} }));
    teams.other = { root: other, registry_location: reg, state: "registered" }; writeIndex();
    return other;
  }, close() { tmux("kill-server"); removeScratchTree(dir); } };
}
