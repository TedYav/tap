import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waiterScope } from "../src/slices/waiter-scope";
import { reownClaim } from "../src/spool-reown";

test("waiter scope preserves the stamped pair and refuses incomplete or mismatched bindings", () => {
  const bound = { target: "peer", targetRegistry: "/team space/registry.json", registryMatchesTeam: true };
  expect(waiterScope(bound)).toEqual({ ok: true, target: bound.target, targetRegistry: bound.targetRegistry });
  for (const input of [{ ...bound, target: "" }, { ...bound, targetRegistry: "" },
    { ...bound, target: "peer\nother" }, { ...bound, targetRegistry: "/team\x1fother" }]) {
    expect(waiterScope(input)).toEqual({ ok: false, refusal: "unbound" });
  }
  expect(waiterScope({ ...bound, registryMatchesTeam: false })).toEqual({ ok: false, refusal: "registry_mismatch" });
});

// --- the real-child scope rows, ported from the retired smoke/waiter-scope.test.sh ---

const repo = join(import.meta.dir, "../../..");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function bus() {
  const work = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "wscope-"));
  roots.push(work);
  const home = join(work, "bus");
  for (const name of ["spool", "payloads", "receipts", "delivery", "digests"]) mkdirSync(join(home, name), { recursive: true });
  writeFileSync(join(home, ".tap-bus-authority"), "");
  const index = join(home, "index");
  mkdirSync(index);
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
  const registry = join(home, "registry.json");
  writeFileSync(registry, JSON.stringify({
    schema: "0.20", team: { name: "fixture", worktree_root: work },
    seats: Object.fromEntries([["a", "sess:0.0", "%401"], ["alice", "sess:0.1", "%402"], ["b", "sess:0.2", "%403"]].map(([name, pane, paneId]) => [name, {
      session: "sess", pane, pane_id: paneId, harness: "codex", status: "active",
      server_epoch: "srv:4242:100", boot_id: "boot:1", registered_from_worktree: work,
    }])),
  }));
  const state = join(work, "tmux");
  mkdirSync(state);
  // The shared fake tmux, with the all-calls transcript the isolation claim
  // reads, the one-shot unobservable fault, and the native-observer adaptations.
  const dispatch = 'cmd="$1"; shift';
  const sessions = "list-sessions) printf 'sess\\t4242:100\\n' ;;";
  let tmux = readFileSync(join(repo, "skills/tap/scripts/smoke/fake-tmux-stub.sh"), "utf8")
    .replaceAll("\u276f", "\u203a");
  expect(tmux.includes(dispatch), "tmux stub dispatch anchor drifted").toBe(true);
  expect(tmux.includes(sessions), "tmux stub list-sessions anchor drifted").toBe(true);
  tmux = tmux
    .replace(dispatch, [
      'while [ "${1:-}" = "-L" ] || [ "${1:-}" = "-S" ]; do shift 2; done',
      'printf \'%s\\n\' "$*" >> "$FAKE_TMUX_STATE/all-calls.log"',
      'if [ -e "$FAKE_TMUX_STATE/unobservable-tmux" ]; then echo "fake tmux: fault injected" >&2; exit 97; fi',
      dispatch,
    ].join("\n"))
    .replace(sessions, "list-sessions) printf 'sess\\t4242:100\\t1\\n' ;;");
  const bin = join(work, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "tmux"), tmux, { mode: 0o755 });
  return { work, home, registry, state, bin };
}

function seed(b: ReturnType<typeof bus>, ident: string, target: "a" | "b", overrides: Record<string, unknown> = {}) {
  const pane = target === "a" ? "sess:0.0" : "sess:0.2", paneId = target === "a" ? "%401" : "%403";
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(join(b.home, `spool/${ident}.md`),
    `---\nid: ${ident}\nfrom: alice\nto: ${target}\nkind: ask\nreply: expected\npath: ${b.home}/payloads/${ident}.md\n---\nbody ${ident}\n`);
  writeFileSync(join(b.home, `spool/${ident}.meta.json`), JSON.stringify({
    id: ident, target, to_team: "fixture", target_registry: b.registry,
    pane, pane_id: paneId, policy: "standard", reason: "no-input-prompt", reason_class: "busy",
    first_spooled_epoch: now - 10, deadline_epoch: now - 1,
    waiter_lifetime: "readiness-gate", deadline_source: "readiness-gate", hold_until_epoch: 0, attempts: 0,
    ...overrides,
  }));
  return { ident, pane, paneId };
}

function scopeEnv(b: ReturnType<typeof bus>, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env, TAP_HOME: b.home, TAP_INDEX_HOME: join(b.home, "index"),
    PATH: `${b.bin}:${process.env.PATH}`, TMUX: "/fake/socket",
    TAP_SPOOL_DELIVERER_DELAYS: ".05", TAP_SPOOL_DISABLE_DELIVERER: "1", TAP_TUI_SETTLE_SCALE: "0.1",
    TAP_SERVER_EPOCH: "srv:4242:100", TAP_BOOT_ID: "boot:1",
    FAKE_TMUX_STATE: b.state, FAKE_WORKTREE: b.work,
    TAP_SPOOL_REOWN_TOKEN: undefined as unknown as string,
    TAP_SPOOL_DRAIN_ACTIVE: undefined as unknown as string,
    TAP_SPOOL_NOW: undefined as unknown as string,
    ...extra,
  };
}

const runWaiter = (b: ReturnType<typeof bus>, ident: string, env: NodeJS.ProcessEnv) => {
  const log = join(b.work, `${ident}.log`);
  // exec keeps the spawned PID as the waiter's own; detached lets a deadline
  // row signal the waiter's whole process group.
  return Bun.spawn(["/bin/sh", "-c", `exec '${process.execPath}' '${join(repo, "runtime/bun/src/spool-waiter.ts")}' '${ident}' >> '${log}' 2>&1`],
    { env, stdin: "ignore", detached: true });
};

const reap = async (child: ReturnType<typeof Bun.spawn>) => {
  if (child.exitCode === null) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
  }
  await child.exited;
};

const transcript = (b: ReturnType<typeof bus>) => existsSync(join(b.state, "all-calls.log")) ? readFileSync(join(b.state, "all-calls.log"), "utf8") : "";
const captureCount = (b: ReturnType<typeof bus>) => transcript(b).split("\n").filter(line => line.includes("capture-pane")).length;
// The shell ran its scope-isolation check after EVERY case, not just the one
// where the leak is easiest to see. A leak confined to the held-probe path or
// to digest assembly must still fail a row.
const expectScoped = (b: ReturnType<typeof bus>) => {
  const t = transcript(b);
  expect(t, "a waiter probed or affected B").not.toContain("sess:0.2");
  expect(t).not.toContain("%403");
  expect(existsSync(join(b.home, "spool/b1.md")), "scope work lost B's entry").toBe(true);
  expect(existsSync(join(b.home, "payloads/b1.md")), "scope delivered B's entry").toBe(false);
};
const probeEpoch = (b: ReturnType<typeof bus>, ident: string) => {
  try { return String(JSON.parse(readFileSync(join(b.home, `spool/${ident}.meta.json`), "utf8")).next_probe_epoch ?? ""); }
  catch { return ""; }
};

test("a solo waiter delivers only its own seat: the transcript never touches the sibling pane, and b delivers on its own turn", async () => {
  const b = bus();
  seed(b, "a1", "a");
  seed(b, "b1", "b");
  const a1 = runWaiter(b, "a1", scopeEnv(b));
  try {
    expect(await Promise.race([a1.exited, Bun.sleep(20_000).then(() => "hung")])).toBe(0);
    const calls = transcript(b);
    expect(calls, "a waiter probed or affected B").not.toContain("sess:0.2");
    expect(calls, "a waiter probed or affected B").not.toContain("%403");
    expect(existsSync(join(b.home, "payloads/a1.md")), "solo delivery missed").toBe(true);
    expect(existsSync(join(b.home, "spool/a1.md")), "solo delivery kept the spool body").toBe(false);
    expect(existsSync(join(b.home, "spool/b1.md")), "the sibling entry did not survive A scope").toBe(true);
    expect(existsSync(join(b.home, "payloads/b1.md")), "the sibling entry was delivered out of scope").toBe(false);
    const b1 = runWaiter(b, "b1", scopeEnv(b));
    expect(await Promise.race([b1.exited, Bun.sleep(20_000).then(() => "hung")])).toBe(0);
    expect(existsSync(join(b.home, "payloads/b1.md")), "B own waiter did not deliver").toBe(true);
    expect(existsSync(join(b.home, "spool/b1.md"))).toBe(false);
  } finally { await reap(a1); }
}, 30_000);

test("same-recipient siblings take one digest", async () => {
  const b = bus();
  seed(b, "a1", "a");
  seed(b, "a2", "a");
  seed(b, "b1", "b");
  const a1 = runWaiter(b, "a1", scopeEnv(b));
  try {
    expect(await Promise.race([a1.exited, Bun.sleep(20_000).then(() => "hung")])).toBe(0);
    expect(existsSync(join(b.home, "payloads/a1.md")), "a1 missed").toBe(true);
    expect(existsSync(join(b.home, "payloads/a2.md")), "a2 missed").toBe(true);
    const digests = readdirSync(join(b.home, "spool/digests")).filter(name => name.endsWith(".json"));
    expect(digests, "same-recipient siblings did not share one digest").toHaveLength(1);
    expectScoped(b);
    expect(existsSync(join(b.home, "spool/a2.md")), "digest assembly lost a2").toBe(false);
    const b1 = runWaiter(b, "b1", scopeEnv(b));
    expect(await Promise.race([b1.exited, Bun.sleep(20_000).then(() => "hung")])).toBe(0);
    expect(existsSync(join(b.home, "payloads/b1.md")), "B never got its own turn").toBe(true);
    await reap(b1);
  } finally { await reap(a1); }
}, 30_000);

for (const [name, overrides] of [
  ["unbound", { target_registry: "" }],
  ["mismatch", { to_team: "different-team" }],
  ["malformed-binding", { target_registry: 7 }],
] as const) test(`a malformed binding refuses before any effect and releases only its own lease (${name})`, async () => {
  const b = bus();
  const { ident } = seed(b, "a1", "a", overrides);
  seed(b, "b1", "b");
  // The same claim the production reown mints: the refusal must release THIS
  // owner's lease without leaking it.
  const token = reownClaim(join(b.home, "spool"), ident, "20", Date.now() / 1000, scopeEnv(b));
  expect(token).toBeTruthy();
  const a1 = runWaiter(b, "a1", scopeEnv(b, { TAP_SPOOL_REOWN_TOKEN: token! }));
  try {
    const code = await Promise.race([a1.exited, Bun.sleep(20_000).then(() => "hung")]);
    expect(code, "the malformed binding did not refuse").not.toBe(0);
    expect(readFileSync(join(b.work, "a1.log"), "utf8")).toContain("waiter_scope_refused");
    expect(transcript(b), "refusal touched a pane or lost the entry").toBe("");
    expect(existsSync(join(b.home, `spool/${ident}.md`)), "refusal lost the entry").toBe(true);
    expect(existsSync(join(b.home, `spool/${ident}.meta.json.reown`)), "refusal leaked the owned lease").toBe(false);
  } finally { await reap(a1); }
}, 30_000);

test("a held entry past its deadline keeps probing and stays parked", async () => {
  const b = bus();
  seed(b, "a1", "a");
  seed(b, "b1", "b");
  writeFileSync(join(b.state, "busy.sess_0_0"), "");
  const a1 = runWaiter(b, "a1", scopeEnv(b, { TAP_SPOOL_FORCE_PROBES: "1000" }));
  try {
    const seen = new Set<string>();
    for (const deadline = Date.now() + 15_000; Date.now() < deadline && seen.size < 2;) {
      if (a1.exitCode !== null) break;
      const probe = probeEpoch(b, "a1");
      if (probe) seen.add(probe);
      await Bun.sleep(25);
    }
    expect(seen.size, "the held waiter stopped scheduling probes").toBeGreaterThanOrEqual(2);
    expect(existsSync(join(b.home, "spool/a1.md")), "the deadline emptied the held entry").toBe(true);
    expect(captureCount(b), "the held waiter never observed the pane").toBeGreaterThanOrEqual(2);
    expectScoped(b);
  } finally { await reap(a1); }
}, 30_000);

test("an unobservable pane never reads as gone: the held entry survives the flip with a taken decision and no escalation", async () => {
  const b = bus();
  const now = Math.floor(Date.now() / 1000);
  seed(b, "a1", "a", { deadline_epoch: now + 60 });
  seed(b, "b1", "b");
  writeFileSync(join(b.state, "busy.sess_0_0"), "");
  const a1 = runWaiter(b, "a1", scopeEnv(b, { TAP_SPOOL_FORCE_PROBES: "1000" }));
  try {
    const preProbes = new Set<string>();
    for (const deadline = Date.now() + 15_000; Date.now() < deadline && preProbes.size < 2;) {
      const probe = probeEpoch(b, "a1");
      if (probe) preProbes.add(probe);
      await Bun.sleep(25);
    }
    expect(preProbes.size, "held waiter never scheduled pre-fault probes").toBeGreaterThanOrEqual(2);
    expect(captureCount(b), "held waiter never observed the pane pre-fault").toBeGreaterThanOrEqual(2);
    const preCalls = transcript(b).split("\n").length;
    // flip_past: the deadline passes underneath the waiter. The drain rewrites
    // the meta, so the flip is re-applied on every observation.
    const flipPast = () => {
      const path = join(b.home, "spool/a1.meta.json");
      const meta = JSON.parse(readFileSync(path, "utf8"));
      if (meta.deadline_epoch <= Math.floor(Date.now() / 1000)) return;  // shell parity: flip only a future deadline
      meta.deadline_epoch = Math.floor(Date.now() / 1000) - 1;
      const staged = `${path}.flip`;
      writeFileSync(staged, JSON.stringify(meta));
      renameSync(staged, path);
    };
    writeFileSync(join(b.state, "unobservable-tmux"), "");
    const newProbes = new Set<string>();
    let escalated = false;
    for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
      flipPast();
      if (existsSync(join(b.home, "payloads/a1.md"))) throw new Error("unobservable reads escalated the held entry as gone");
      const meta = JSON.parse(readFileSync(join(b.home, "spool/a1.meta.json"), "utf8"));
      if (meta.escalated_at) { escalated = true; break; }
      const probe = probeEpoch(b, "a1");
      if (probe && !preProbes.has(probe)) newProbes.add(probe);
      if (newProbes.size >= 2 && transcript(b).split("\n").length > preCalls) break;
      await Bun.sleep(40);
    }
    expect(escalated, "an unanswerable read escalated the held entry").toBe(false);
    expect(newProbes.size, "no scheduling decision followed the flip").toBeGreaterThanOrEqual(2);
    expect(transcript(b).split("\n").length > preCalls, "no observation followed the flip").toBe(true);
    expect(existsSync(join(b.home, "spool/a1.md")), "the held entry did not survive the fault").toBe(true);
    expect(existsSync(join(b.home, "payloads/a1.md")), "unobservable reads escalated the held entry as gone").toBe(false);
    const meta = JSON.parse(readFileSync(join(b.home, "spool/a1.meta.json"), "utf8"));
    expect(meta.deadline_epoch, "the flip did not survive the drain rewrite").toBeLessThanOrEqual(Date.now() / 1000);
    expect(meta.escalated_at, "the fault escalated the entry").toBeUndefined();
    const placed = readdirSync(join(b.home, "receipts")).filter(name => name.endsWith(".placed"));
    expect(placed, "the fault minted placed notices").toEqual([]);
    expectScoped(b);
  } finally { await reap(a1); }
}, 60_000);
