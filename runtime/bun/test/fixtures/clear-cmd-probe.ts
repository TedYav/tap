/**
 * Child-process probe for launcher-replace-cmd.test.ts. It mocks module seams
 * (mock.module is process-wide, so it never runs inside the shared test
 * process), runs one scenario against cmdClearNative / the locked stamp, and
 * prints one JSON result line.
 * Usage: bun clear-cmd-probe.ts <scenario> [cmdClearNative argv...]
 * Scenarios: ok | old-store | status | old-stamp; PROBE_HARNESS overrides the row's harness
 * Adapted from aspen-ponytail's review probe.
 */
import { mock } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { removeScratchTree } from "../support/scratch";

const src = (p: string) => resolve(import.meta.dir, "../../src", p);
const context = await import(src("context.ts"));
const generation = await import(src("launcher/generation.ts"));
const readiness = await import(src("launcher/readiness.ts"));
const resume = await import(src("launcher/resume.ts"));
const transaction = await import(src("launcher/transaction.ts"));
const invocation = await import(src("launcher/invocation.ts"));
const tmuxApi = await import(src("tmux.ts"));
const launchProcess = await import(src("launcher/process.ts"));
const { loadRegistry } = await import(src("registry.ts"));
const { teamRegistryRefusal } = await import(src("register-authority.ts"));
const { LauncherError } = await import(src("launcher/types.ts"));
const { fencePath } = await import(src("clear-fence.ts"));

const [mode = "ok", ...argv] = process.argv.slice(2);
const root = mkdtempSync(join(process.env.TAP_HOME!, "clear-cmd-"));
const scope = { root, registryPath: join(root, "registry.json"), busHome: join(root, "bus") };
mkdirSync(scope.busHome);
const live = { status: "active", pane_id: "%7", server_epoch: "srv:1:1", harness: "claude", session: "demo-sol" };
writeFileSync(scope.registryPath, JSON.stringify({ schema: "0.20", team: { name: "demo" }, seats: { sol: { ...live } } }));
const calls: string[][] = [];
let prompt: string | null | undefined;

mock.module(src("context.ts"), () => ({ ...context,
  resolveContext: () => ({ ...scope, bus: { home: scope.busHome } }),
  observeCallingPane: () => ({ state: "outside" }) }));
mock.module(src("launcher/generation.ts"), () => ({ ...generation,
  observeGeneration: async () => ({ boot: null, epoch: "srv:1:1", socket: "" }) }));
mock.module(src("launcher/readiness.ts"), () => ({ ...readiness,
  paneFacts: async () => ({ pane_id: "%7", pane: "demo-sol:0.0", server_epoch: "srv:1:1", command: "claude" }) }));
// The production reader's shape: an old-format registry is a LauncherError(old_store).
mock.module(src("launcher/resume.ts"), () => ({ ...resume, registryEntry: () => {
  const doc = loadRegistry(scope.registryPath);
  const old = teamRegistryRefusal(scope.registryPath, doc);
  if (old) throw new LauncherError(old.detail, "old_store", old.action, old.detail);
  return (doc.seats as Record<string, unknown>).sol;
} }));
mock.module(src("launcher/transaction.ts"), () => ({ ...transaction,
  recordFromRow: () => ({ name: "demo-sol", harness: process.env.PROBE_HARNESS ?? "claude", cwd: root, base: "demo",
    harness_env: {}, harness_unset_env: [], harness_tail: [] }),
  mintLaunchSessionId: async (r: unknown) => r }));
mock.module(src("launcher/invocation.ts"), () => ({ ...invocation,
  launchInvocation: (_action: unknown, _record: unknown, notices: { emit(m: string): void }, opts: { prompt?: string | null }) => {
    prompt = opts.prompt;
    notices.emit("fixture launch notice");
    return { argv: ["true"], env: {} };
  } }));
const fakeTmux = (args: string[]) => {
  calls.push(args);
  if (args[0] === "respawn-pane") {
    if (mode === "status") return { code: 23, stdout: "", stderr: "fixture status" };
    const doc = JSON.parse(readFileSync(scope.registryPath, "utf8"));
    if (mode === "old-store") writeFileSync(scope.registryPath, JSON.stringify({ schema: "0.19", agents: { sol: live } }));
    else { doc.seats.sol.clear_nonce = doc.seats.sol.expected_clear_nonce; writeFileSync(scope.registryPath, JSON.stringify(doc)); }
  }
  return { code: 0, stdout: "", stderr: "" };
};
mock.module(src("tmux.ts"), () => ({ ...tmuxApi, tmux: fakeTmux }));
mock.module(src("launcher/process.ts"), () => ({ ...launchProcess, launchTmux: async (args: string[]) => fakeTmux(args) }));

const { cmdClearNative, stampExpectedClearNonce } = await import(src("launcher/replace.ts"));
const result: Record<string, unknown> = {};
try {
  if (mode === "old-stamp") {
    writeFileSync(scope.registryPath, JSON.stringify({ schema: "0.19", agents: {}, seats: { sol: { ...live } } }));
    const before = readFileSync(scope.registryPath, "utf8");
    const out = await stampExpectedClearNonce(scope, "sol", "n-old",
      { paneId: "%7", epoch: "srv:1:1", generation: { boot: null, epoch: null, socket: "" } },
      { harness_env: {}, harness_unset_env: [], harness_tail: [] }, "tap clear");
    result.errorClass = out?.errorClass ?? null;
    result.unchanged = readFileSync(scope.registryPath, "utf8") === before;
  } else {
    result.rc = await cmdClearNative(argv);
    result.respawns = calls.filter(a => a[0] === "respawn-pane").length;
    result.calls = calls.length;
    result.verbs = calls.map(a => a[0]);
    try { result.latency = JSON.parse(readFileSync(join(root, ".tap/clear-latency.jsonl"), "utf8")); }
    catch { result.latency = null; }
    result.prompt = prompt ?? null;
    try { result.fenceSize = statSync(fencePath(scope.busHome, "sol")).size; } catch { result.fenceSize = null; }
    try { result.expected = JSON.parse(readFileSync(scope.registryPath, "utf8")).seats?.sol?.expected_clear_nonce ?? null; }
    catch { result.expected = null; }
  }
} catch (error) {
  result.threw = String(error);
} finally {
  removeScratchTree(root);
}
process.stdout.write(`\n${JSON.stringify(result)}\n`);
