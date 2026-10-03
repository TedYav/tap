import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envelopeField, stampEnvelope, type Routing } from "../src/envelope";
import { spawnSync } from "node:child_process";
import { acquireRegistryLock, KERNEL_LOCK, kernelLockArgs } from "../src/panelock";
import { removeScratchTree } from "./support/scratch";

const MAIN = join(import.meta.dir, "..", "main.ts");
const SOCKET = `tap-forward-native-${Math.random().toString(36).slice(2, 8)}`;
const TEAM = "forwardnative";
let root: string, wt: string, bus: string, index: string, bindir: string, registryPath: string;
let baseline: Record<string, any>;
let jobs = 0;
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const instance = (handle: string) => baseline.seats[handle].instance as string;
function env(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${bindir}:${process.env.PATH}`, TAP_HOME: bus, TAP_INDEX_HOME: index,
    TAP_SESSION_MANIFEST: join(index, "sessions.json"), OPENCODE_DB_PATH: join(index, "opencode.db"),
    TAP_VERSION_SEEN_PATH: join(index, "version-seen.json"), TAP_LOCK_DIR: join(index, "locks"),
    TAP_TMUX_SOCKET: SOCKET, TAP_SPOOL_DISABLE_DELIVERER: "1", TAP_SELF: undefined, TAP_EPOCH: undefined,
    TMUX: undefined, TMUX_PANE: undefined } as NodeJS.ProcessEnv;
}
function tmux(...args: string[]) {
  return Bun.spawnSync(["tmux", "-L", SOCKET, ...args], { env: env(), stdout: "pipe", stderr: "pipe" });
}
function tap(...args: string[]) {
  return Bun.spawnSync(["bun", MAIN, ...args], { cwd: wt, env: env(), stdout: "pipe", stderr: "pipe" });
}
async function until(predicate: () => boolean, detail: string, seconds = 10) {
  const deadline = Date.now() + seconds * 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(detail);
    await Bun.sleep(10);
  }
}
function save(doc: Record<string, any>) { writeFileSync(registryPath, JSON.stringify(doc)); }
function edge(source: string, destination: string) {
  return { source, source_instance: `${source}|old`, destination, destination_instance: instance(destination),
    at: "2026-09-07T12:00:00Z", address_active: true };
}
function seed(suffix: string, fields: Partial<Routing> = {}) {
  const id = `peer-20260907T120000Z-${suffix}`;
  const path = join(bus, "payloads", id + ".md");
  writeFileSync(path, stampEnvelope("---\n---\noriginal native ask\n", {
    id, from: "peer", to: "old", kind: "discuss", reply: "expected", path,
    recipient_instance: "old|old", sender_instance: instance("peer"), ...fields,
  }));
  return { id, path, bytes: readFileSync(path) };
}
function startPane(...args: string[]) {
  const prefix = join(root, `job-${++jobs}`), trace = prefix + ".trace";
  const script = prefix + ".sh", result = prefix + ".result", out = prefix + ".out", err = prefix + ".err";
  const vars = Object.entries(env()).filter(([name, value]) => value !== undefined && name.startsWith("TAP_"))
    .map(([name, value]) => `${name}=${quote(value!)}`);
  // Publish the status only after its bytes exist: Number("") is success.
  writeFileSync(script, `env -u TAP_SELF -u TAP_EPOCH ${vars.join(" ")} TAP_BUN_ROUTE_TRACE=${quote(trace)} ` +
    `bun ${quote(MAIN)} ${args.map(quote).join(" ")} >${quote(out)} 2>${quote(err)}\n` +
    `printf '%s' "$?" >${quote(result + ".tmp")}\n` +
    `mv ${quote(result + ".tmp")} ${quote(result)}\n`);
  const sent = tmux("send-keys", "-t", "worker:0.0", "-l", script);
  expect(sent.exitCode, sent.stderr.toString()).toBe(0);
  expect(tmux("send-keys", "-t", "worker:0.0", "Enter").exitCode).toBe(0);
  return { result, trace, async finish() {
    await until(() => existsSync(result), `native pane command did not complete: ${args.join(" ")}`);
    return { code: Number(readFileSync(result, "utf8")), stdout: readFileSync(out, "utf8"),
      stderr: readFileSync(err, "utf8"), trace: existsSync(trace) ? readFileSync(trace, "utf8") : "" };
  } };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "tap-forward-pane.")); wt = join(root, TEAM);
  bus = join(wt, ".tap", "bus"); index = join(root, "index"); bindir = join(root, "bin");
  registryPath = join(wt, ".tap", "team-registry.json");
  for (const path of [join(bus, "payloads"), join(bus, "receipts"), index, bindir]) mkdirSync(path, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", wt]);
  const realTmux = Bun.which("tmux");
  if (!realTmux) throw new Error("native forwarding control requires tmux");
  writeFileSync(join(bindir, "tmux"), `#!/bin/sh\nexec ${quote(realTmux)} -L ${quote(SOCKET)} "$@"\n`, { mode: 0o755 });
  const bash = ["/opt/homebrew/bin/bash", "/usr/local/bin/bash", ...(process.platform === "linux" ? [Bun.which("bash") ?? ""] : [])]
    .find(p => p && existsSync(p));
  if (!bash) throw new Error("native forwarding control requires copyable bash");
  copyFileSync(bash, join(bindir, "claude"));
  Bun.spawnSync(["chmod", "+x", join(bindir, "claude")]);
  const agent = join(root, "agent.sh");
  writeFileSync(agent, "printf '\\n\\xe2\\x80\\xba '\nwhile IFS= read -r script; do [ ! -f \"$script\" ] || . \"$script\"; printf '\\n\\xe2\\x80\\xba '; done\n");
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    [TEAM]: { root: wt, registry_location: registryPath, state: "registered" },
  } }));
  save({ schema: "0.20", team: { name: TEAM, worktree_root: wt }, seats: {} });
  const created = tmux("new-session", "-d", "-s", "worker", "-c", wt, `claude ${quote(agent)}`);
  expect(created.exitCode, created.stderr.toString()).toBe(0);
  await until(() => tmux("capture-pane", "-p", "-t", "worker:0.0").stdout.toString().includes("›"), "worker prompt absent");
  const registered = tap("register", "worker", "--pane", "worker:0.0");
  expect(registered.exitCode, registered.stderr.toString()).toBe(0);
  baseline = json(registryPath);
  baseline.seats.peer = { status: "active", delivery: "poll", harness: "codex", instance: "peer|current", registered_at: "t" };
  save(baseline);
}, 30_000);
beforeEach(() => save({ ...structuredClone(baseline), seat_forwardings: [edge("old", "worker"), edge("oldpoll", "peer")] }));
afterAll(() => { tmux("kill-server"); removeScratchTree(root); });

test("pane-derived successor reply executes native and attributes its own current instance", async () => {
  const inbound = seed("100000000001");
  const answer = await startPane("reply", inbound.id, "-m", "native successor answer").finish();
  expect(answer.code, answer.stderr).toBe(0);
  expect(answer.trace).toBe("native reply\n");
  const receipt = json(join(bus, "receipts", inbound.id + ".done"));
  expect(receipt.by).toBe("worker"); expect(receipt.adopted_from).toBe("old");
  const outbound = readFileSync(join(bus, "payloads", receipt.reply_id + ".md"), "utf8");
  expect(envelopeField(outbound, "from")).toBe("worker");
  expect(envelopeField(outbound, "sender_instance")).toBe(instance("worker"));
  expect(envelopeField(outbound, "adopted_from")).toBe("old");
  expect(envelopeField(outbound, "recipient_instance")).toBe(instance("peer"));
  expect(json(join(bus, "receipts", receipt.reply_id + ".sent")).delivery).toBe("poll");
  expect(readFileSync(inbound.path)).toEqual(inbound.bytes);
});

test("native new send forwards to a poll destination with both recipient identities", async () => {
  const answer = await startPane("send", "oldpoll", "--ask", "-m", "native future work").finish();
  expect(answer.code, answer.stderr).toBe(0); expect(answer.trace).toBe("native send\n");
  const outbound = readdirSync(join(bus, "payloads")).filter(n => n.endsWith(".md"))
    .map(n => readFileSync(join(bus, "payloads", n), "utf8")).find(raw => raw.includes("native future work"))!;
  expect(envelopeField(outbound, "to")).toBe("peer");
  expect(envelopeField(outbound, "recipient_instance")).toBe(instance("peer"));
  expect(envelopeField(outbound, "to_adopted_from")).toBe("oldpoll");
  expect(envelopeField(outbound, "original_recipient_instance")).toBe("oldpoll|old");
  expect(envelopeField(outbound, "sender_instance")).toBe(instance("worker"));
});

test("new-forwarded envelope replies natively only with destination instance binding", async () => {
  const inbound = seed("100000000003", { to: "worker", recipient_instance: instance("worker"),
    to_adopted_from: "old", original_recipient_instance: "old|old" });
  const answer = await startPane("reply", inbound.id, "-m", "new forward answer").finish();
  expect(answer.code, answer.stderr).toBe(0); expect(answer.trace).toBe("native reply\n");
  const receipt = json(join(bus, "receipts", inbound.id + ".done"));
  expect(receipt.by).toBe("worker"); expect(receipt.adopted_from).toBe("old");
  const poisoned = seed("100000000004", { to: "worker", recipient_instance: "old|old",
    to_adopted_from: "old", original_recipient_instance: "old|old" });
  const before = readdirSync(join(bus, "payloads")).sort();
  const refused = await startPane("reply", poisoned.id, "-m", "must not adopt the wrong binding").finish();
  expect(refused.code).not.toBe(0); expect(refused.trace).toBe("native reply\n");
  expect(readdirSync(join(bus, "payloads")).sort()).toEqual(before);
  expect(existsSync(join(bus, "receipts", poisoned.id + ".done"))).toBe(false);
});

test("source reuse keeps old pinned custody but destination reuse cannot emit a reply", async () => {
  const doc = json(registryPath);
  doc.seats.old = { status: "active", delivery: "poll", instance: "old|replacement" }; save(doc);
  const inbound = seed("100000000005");
  const answer = await startPane("reply", inbound.id, "-m", "source reuse answer").finish();
  expect(answer.code, answer.stderr).toBe(0); expect(answer.trace).toBe("native reply\n");
  const stale = seed("100000000006");
  doc.seats.worker.instance = "worker|replacement"; save(doc);
  const before = readdirSync(join(bus, "payloads")).sort();
  const refused = await startPane("reply", stale.id, "-m", "wrong destination incarnation").finish();
  expect(refused.code).not.toBe(0); expect(refused.trace).toBe("native reply\n");
  expect(readdirSync(join(bus, "payloads")).sort()).toEqual(before);
  expect(existsSync(join(bus, "receipts", stale.id + ".done"))).toBe(false);
});

test("actor replacement after native grant and before send lock emits nothing", async () => {
  const inbound = seed("100000000007");
  const lock = acquireRegistryLock(registryPath);
  if (!lock) throw new Error("test must own registry before native reply starts");
  const before = readdirSync(join(bus, "payloads")).sort();
  const knownLocks = new Set(readdirSync(join(index, "locks")));
  const child = startPane("reply", inbound.id, "-m", "actor race must refuse");
  try {
    // A worker-authored outbound obligation lock is acquired only after the
    // original recipient grant has passed and cmdSendOutcome starts.
    // Locks are held in-process, so "acquired" is a new obligation sidecar that
    // a zero-wait kernel contender is refused on (created is not held).
    const heldObligation = () => readdirSync(join(index, "locks")).some(name => !knownLocks.has(name) && /^obligation-worker-.*\.lock$/.test(name)
      && spawnSync(KERNEL_LOCK, kernelLockArgs(join(index, "locks", name), 0, ["true"])).status !== 0);
    await until(heldObligation, "native reply did not pass authority and acquire its outbound obligation lock", 4);
    const doc = json(registryPath); doc.seats.worker.instance = "worker|replacement-after-grant"; save(doc);
  } finally { lock.release(); }
  const refused = await child.finish();
  expect(refused.code).not.toBe(0); expect(refused.trace).toBe("native reply\n");
  // Publication rechecks the grant against the replacement actor before the
  // older actor-snapshot guard: the adopted address no longer grants this row.
  expect(refused.stderr).toContain("is addressed to 'old', not 'worker'");
  expect(readdirSync(join(bus, "payloads")).sort()).toEqual(before);
  expect(existsSync(join(bus, "receipts", inbound.id + ".done"))).toBe(false);
}, 15_000);

test("a later handoff attributes the immediate adopted recipient without rewriting earlier history", async () => {
  const inbound = seed("100000000008", { to_adopted_from: "earlier", original_recipient_instance: "earlier|1" });
  const answer = await startPane("reply", inbound.id, "-m", "chain answer").finish();
  expect(answer.code, answer.stderr).toBe(0);
  const receipt = json(join(bus, "receipts", inbound.id + ".done"));
  expect(receipt.adopted_from).toBe("old");
  expect(envelopeField(readFileSync(join(bus, "payloads", receipt.reply_id + ".md"), "utf8"), "adopted_from")).toBe("old");
  expect(readFileSync(inbound.path)).toEqual(inbound.bytes);
});


test("native historical reply preserves legacy address routing without a source handoff", async () => {
  const inbound = seed("100000000009", { to: "worker", recipient_instance: instance("worker"), sender_instance: "peer|old" });
  const answer = await startPane("reply", inbound.id, "-m", "ordinary native answer").finish();
  expect(answer.code, answer.stderr).toBe(0);
  expect(answer.trace).toBe("native reply\n");
  const receipt = json(join(bus, "receipts", inbound.id + ".done"));
  const outbound = readFileSync(join(bus, "payloads", receipt.reply_id + ".md"), "utf8");
  expect(envelopeField(outbound, "recipient_instance")).toBe(instance("peer"));
  expect(envelopeField(outbound, "to_adopted_from")).toBeUndefined();
});
