// Process-local native/terminal observations. The caller resolver, registry,
// selector and public verb handlers below are the production implementations.
import { mock } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [root, mode] = process.argv.slice(2) as [string, string];
const team = join(root, "team"), foreign = join(root, "foreign"), index = join(root, "index"), socket = join(root, "socket");
for (const dir of [join(team, ".tap/bus"), join(foreign, ".tap/bus"), index]) mkdirSync(dir, { recursive: true });
const service = { id: "native", pid: 10, start: 1000, url: "http://127.0.0.1:1234", version: "2.1.2", file: join(root, "service.json") };
const row = { harness: "opencode", harness_session_id: "ses_alpha", status: "active", delivery: "pane", instance: "alpha|one",
  pane: "t/alpha:0.0", pane_id: "%1", session: "t/alpha", server_epoch: "srv:100:200", server_socket: socket,
  opencode_server_mode: "shared", opencode_service: service };
const registry = join(team, ".tap/team-registry.json"), otherRegistry = join(foreign, ".tap/team-registry.json");
writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "t", worktree_root: team }, seats: {
  alpha: row, peer: { status: "active", delivery: "poll", instance: "peer|one" },
  declared: { status: "active", delivery: "poll", instance: "declared|one" },
} }));
writeFileSync(otherRegistry, JSON.stringify({ schema: "0.20", team: { name: "other", worktree_root: foreign }, seats: {} }));
writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
  t: { root: team, registry_location: registry, state: "registered" },
  other: { root: foreign, registry_location: otherRegistry, state: "registered" },
} }));
Object.assign(process.env, { TAP_INDEX_HOME: index, TAP_HOME: join(team, ".tap/bus"), TAP_TMUX_SOCKET_PATH: socket,
  TMUX: `${socket},100,0`, TMUX_PANE: "%1", TAP_SELF: mode === "match" ? "alpha" : "wrong", OPENCODE_SESSION_ID: "ses_alpha" });
delete process.env.TAP_SERVER_EPOCH;
process.chdir(team);
const native = { ...await import("../../src/opencode-service") };
mock.module("../../src/opencode-service", () => ({ ...native,
  nativeOpenCodeCaller: () => mode === "normal" ? { kind: "none" } : mode === "projection-refused" ? { kind: "refused", reason: "shell_unobservable" } : {
    kind: "verified", sessionId: mode === "child-context" ? "ses_child" : "ses_alpha", rootSessionId: "ses_alpha",
    shellPid: 20, shellStart: 2000, directory: team, service,
  },
  readOpenCodeAncestry: () => new Map([
    [process.pid, { pid: process.pid, ppid: 10, start: 2000, command: "bun", args: "bun" }],
    [10, { pid: 10, ppid: 99, start: 1000, command: "opencode", args: "opencode serve --service" }],
    [99, { pid: 99, ppid: 1, start: 500, command: "sh", args: "sh" }],
  ]),
}));
let paneProbes = 0, mutations = 0;
const terminal = { ...await import("../../src/tmux") };
const tmux = (args: string[]) => {
  paneProbes++;
  if (/^(kill-|respawn-|set-)/.test(args[0] ?? "")) mutations++;
  const format = args.at(-1) ?? "";
  const stdout = args[0] === "list-panes" ? "%1\t/dev/ttysx\n"
    : format.includes("pane_tty") ? "%1\t/dev/ttysx\tt/alpha\t100:200\n"
    : `%1\tt/alpha\t100:200${format.includes("socket_path") ? "\t" + socket : ""}\n`;
  return { code: 0, stdout, stderr: "", rateLimited: false };
};
mock.module("../../src/tmux", () => ({ ...terminal, tmux, tmuxReadOnly: tmux }));
const ancestry = { ...await import("../../src/process-ancestry") };
mock.module("../../src/process-ancestry", () => ({ ...ancestry,
  processRow: (pid: number) => ({ ppid: pid === process.pid ? "10" : pid === 10 ? "99" : "1", tty: pid === process.pid ? "?" : "ttysx" }),
}));
const context = await import("../../src/context");
const originalRegistry = readFileSync(registry, "utf8");
try {
  if (["match", "mismatch", "normal"].includes(mode)) console.log(JSON.stringify({ actor: context.inheritedActor() }));
  else if (mode === "projection-refused") console.log(JSON.stringify({ pane: context.callingPane() }));
  else if (mode === "projection") {
    const pane = context.callingPane(), ctx = context.resolveContext();
    const doc = JSON.parse(readFileSync(registry, "utf8"));
    doc.seats.alpha.instance = "alpha|successor";
    writeFileSync(registry, JSON.stringify(doc));
    let refusal = "";
    try { context.resolveSelf(ctx, pane!, 1); } catch (error) { refusal = (error as { errorClass: string }).errorClass; }
    console.log(JSON.stringify({ pane, refusal }));
  }
  else if (mode === "boundary") console.log(JSON.stringify({ observation: context.observeCallingPane(), paneProbes }));
  else if (mode === "register") {
    const before = readFileSync(registry, "utf8");
    const { cmdRegister } = await import("../../src/verbs/register");
    const code = cmdRegister([]);
    console.log(JSON.stringify({ code, unchanged: before === readFileSync(registry, "utf8") }));
  } else if (mode === "child-context") {
    process.chdir(foreign); process.env.TAP_HOME = join(foreign, ".tap/bus");
    process.env.TAP_TMUX_SOCKET_PATH = join(root, "wrong-socket"); process.env.TMUX_PANE = "%99";
    const ctx = context.resolveContext();
    console.log(JSON.stringify({ team: ctx.team, root: ctx.root, pin: process.env.TAP_HOME, socket: process.env.TAP_TMUX_SOCKET_PATH }));
  } else if (mode === "crew-owner") {
    const { cmdCrewShutdown } = await import("../../src/crew-lifecycle");
    const code = cmdCrewShutdown([], join(import.meta.dir, "../../../../skills/tap/scripts"));
    console.log(JSON.stringify({ code, unchanged: originalRegistry === readFileSync(registry, "utf8"), mutations }));
  } else if (mode === "declared") {
    const body = join(root, "message.txt"); writeFileSync(body, "bounded test message");
    const { cmdSend } = await import("../../src/verbs/send");
    const code = cmdSend(["peer", "--from", "declared", "-f", body, "--json"], join(import.meta.dir, "../../../../skills/tap/scripts"), new Set(["opencode"]));
    console.log(JSON.stringify({ code }));
  } else if (mode.startsWith("self-")) {
    const scripts = join(import.meta.dir, "../../../../skills/tap/scripts"); let code: number;
    if (mode === "self-down") {
      const { cmdSeatUpDown } = await import("../../src/seat-updown"); code = await cmdSeatUpDown("down", ["alpha", "--json"], scripts);
    } else if (mode === "self-out-kill" || mode === "self-out-hard") {
      const { cmdOut } = await import("../../src/verbs/out"); code = cmdOut(["alpha", mode.endsWith("kill") ? "--kill" : "--hard", "--json"], scripts);
    } else {
      const { cmdTeam } = await import("../../src/verbs/team");
      const verb = mode.slice(10);
      code = await cmdTeam([verb, "t", ...(verb === "out" ? ["--hard"] : []), "--only", "alpha", "--yes", "--json"], scripts);
    }
    console.log(JSON.stringify({ code, unchanged: originalRegistry === readFileSync(registry, "utf8"), mutations }));
  }
} catch (error) {
  const e = error as Error & { errorClass?: string };
  if (mode.startsWith("self-")) process.stderr.write(`${e.errorClass}: ${e.message}\n`);
  console.log(JSON.stringify({ ...(mode.startsWith("self-") ? { code: 1, mutations, error_class: e.errorClass } : {}), error: e.errorClass, message: e.message, unchanged: originalRegistry === readFileSync(registry, "utf8") }));
}
