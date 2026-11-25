import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forwardingRoute, forwardingGrant, prepareForwarding } from "../src/forwarding";
import { envelopeField } from "../src/envelope";
import { loadRegistry, saveRegistry } from "../src/registry";
import { removeScratchTree } from "./support/scratch";

const ROOT = join(import.meta.dir, "../../..");
const initial = () => ({ schema: "0.20", team: { name: "forward" }, seats: Object.fromEntries(["a", "b", "c", "worker"].map(h => [h, { status: "active", instance: `${h}|1`, delivery: "poll" }])) });

test("pinned graph preserves predecessor custody across both source and destination name reuse", () => {
  const ordinary = initial(); ordinary.seats.a!.instance = "a|2";
  expect(forwardingRoute(ordinary, "a", "a|1", true)).toMatchObject({ target: "a", instance: "a|2", adopted_from: "" });
  const { doc } = prepareForwarding(initial(), "a", "b", "now");
  expect(forwardingRoute(doc, "a").target).toBe("b");
  expect(forwardingGrant(doc, "b", "a", "a|1")).toBe("a");
  expect(forwardingGrant(doc, "b", "a", "")).toBe("");
  expect(forwardingGrant(doc, "b", "a", "a|2")).toBe("");
  (doc.seats as any).b.status = "suspended";
  expect(forwardingGrant(doc, "b", "a", "a|1")).toBe("a");
  (doc.seats as any).b.status = "active";
  (doc.seats as any).a = { status: "active", instance: "a|2" };
  expect(forwardingRoute(doc, "a").target).toBe("a");
  expect(forwardingRoute(doc, "a", "a|1", true).target).toBe("b");
  expect(() => forwardingRoute(doc, "a", "", true)).toThrow("ambiguous");
  (doc.seats as any).b.instance = "b|2";
  expect(forwardingGrant(doc, "b", "a", "a|1")).toBe("");
  expect(() => forwardingRoute(doc, "a", "a|1", true)).toThrow("no current seat");
  expect(prepareForwarding(doc, "worker", "c", "later").record.destination).toBe("c");
});

test("repeated explicit handoff follows bounded chain; self, cycles and ambiguous repeated names refuse before retirement", () => {
  const first = prepareForwarding(initial(), "a", "b", "1");
  const second = prepareForwarding(first.doc, "b", "c", "2");
  expect(forwardingRoute(second.doc, "a").target).toBe("c");
  expect(forwardingGrant(second.doc, "c", "a", "a|1")).toBe("a");
  expect(forwardingGrant(second.doc, "b", "a", "a|1")).toBe("");
  expect(() => prepareForwarding(initial(), "a", "a", "1")).toThrow("itself");
  (second.doc.seats as any).a = { status: "active", instance: "a|2" };
  expect(() => prepareForwarding(second.doc, "c", "a", "3")).toThrow("cycle");
  expect(() => prepareForwarding(second.doc, "a", "c", "3")).toThrow("historical");
  expect((second.doc.seats as any).c.instance).toBe("c|1");
  const poisoned = structuredClone(first.doc);
  (poisoned.seat_forwardings as any[]).push({ ...(poisoned.seat_forwardings as any[])[0], destination: "c" });
  expect(() => forwardingRoute(poisoned, "a")).toThrow("ambiguous");
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tap-forward.")));
  const cwd = join(root, "forward"), home = join(cwd, ".tap/bus"), registry = join(cwd, ".tap/team-registry.json"), index = join(root, "index");
  for (const path of ["payloads", "receipts", "spool"]) mkdirSync(join(home, path), { recursive: true });
  mkdirSync(index); saveRegistry(registry, initial());
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { forward: { root: cwd, registry_location: registry, state: "registered" } } }));
  mkdirSync(join(root, "user"));
  const env = { ...process.env, HOME: join(root, "user"), TAP_HOME: home, TAP_INDEX_HOME: index, TAP_SELF: "b", TAP_LOCK_DIR: join(root, "locks"),
    TAP_SPOOL_DISABLE_DELIVERER: "1", TAP_SESSION_MANIFEST: join(root, "sessions"), TAP_VERSION_SEEN_PATH: join(root, "seen"),
    OPENCODE_DB_PATH: join(root, "opencode"), TMUX: undefined, TMUX_PANE: undefined };
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(["bun", join(ROOT, "runtime/bun/main.ts"), ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  };
  const seed = (id: string, from = "worker", to = "a", parked = false) => {
    const path = join(home, "payloads", `${id}.md`);
    const raw = `---\nid: ${id}\nfrom: ${from}\nto: ${to}\nsender_instance: ${from}|1\nrecipient_instance: ${to}|1\nkind: discuss\nreply: expected\npath: ${path}\n---\nOriginal body ${id}\n`;
    writeFileSync(parked ? join(home, "spool", `${id}.md`) : path, raw);
    if (parked) writeFileSync(join(home, "spool", `${id}.meta.json`), JSON.stringify({ id, target: to, target_registry: registry, team: "forward", reason: "pending-input", first_spooled_epoch: 1, attempts: 0, policy: "standard" }));
    return { path, raw };
  };
  return { root, cwd, home, registry, index, env, run, seed };
}

test("public out atomically retires source and exposes unchanged pending and predecessor outbound", () => {
  const f = fixture();
  try {
    const inbound = f.seed("old-custom-id"), outbound = f.seed("old-outbound", "a", "worker");
    for (const ext of ["sent", "harness-queued", "attempted"]) writeFileSync(join(f.home, "receipts", `old-custom-id.${ext}`), `original-${ext}`);
    const result = f.run("out", "a", "--forward-to", "b", "--json");
    expect(result.code, result.err).toBe(0);
    const doc = loadRegistry(f.registry);
    expect(doc.schema).toBe("0.20");
    expect((doc.seats as any).a).toBeUndefined();
    expect((doc.seat_forwardings as any[])[0].destination_instance).toBe("b|1");
    expect(readFileSync(inbound.path, "utf8")).toBe(inbound.raw);
    expect(readFileSync(outbound.path, "utf8")).toBe(outbound.raw);
    expect(existsSync(join(f.home, "receipts", "old-custom-id.done"))).toBe(false);
    for (const ext of ["sent", "harness-queued", "attempted"]) expect(readFileSync(join(f.home, "receipts", `old-custom-id.${ext}`), "utf8")).toBe(`original-${ext}`);
    expect(readdirSync(join(f.home, "payloads")).filter(n => n.endsWith(".attempts"))).toEqual([]);
    const poll = f.run("poll", "b", "--json");
    expect(poll.code, poll.err).toBe(0);
    expect(JSON.parse(poll.out).pending.find((v: any) => v.id === "old-custom-id").adopted_from).toBe("a");
    const outstanding = f.run("outstanding", "b", "--json");
    expect(JSON.parse(outstanding.out).outstanding.find((v: any) => v.id === "old-outbound")).toMatchObject({ from: "a", sender_instance: "a|1", adopted_from: "a" });
    expect(f.run("out", "b", "--forward-to", "c").code).toBe(0);
    expect(f.run("poll", "c", "--json").out).toContain("old-custom-id");
  } finally { removeScratchTree(f.root); }
});

test("a qualified destination refuses local routing and reply redirection without settling the ask", () => {
  const f = fixture();
  try {
    const { doc, record } = prepareForwarding(initial(), "a", "b", "now");
    doc.schema = "0.21";
    record.destination = "elsewhere/b";
    // Even an invalid local row with this literal key cannot stand in for the foreign seat.
    (doc.seats as Record<string, unknown>)[record.destination] = initial().seats.b;
    saveRegistry(f.registry, doc);
    expect(() => forwardingRoute(doc, "a")).toThrow("not a local seat handle");
    expect(forwardingGrant(doc, "b", "a", "a|1")).toBe("");
    const send = f.run("send", "a", "--from", "worker", "--ask", "-m", "question");
    expect(send.code).toBe(1);
    expect(send.err).toContain("not a local seat handle");
    expect(readdirSync(join(f.home, "payloads"))).toEqual([]);
    for (const redirect of ["a", "forward/a"]) {
      const ask = f.seed("redirect-question", "worker", "b");
      writeFileSync(ask.path, ask.raw.replace("reply: expected", `reply: expected\nreply_to: ${redirect}`));
      const reply = f.run("reply", "redirect-question", "--by", "b", "-m", "answer");
      expect(reply.code).toBe(1);
      expect(reply.err).toContain("not a local seat handle");
      expect(existsSync(join(f.home, "receipts/redirect-question.done"))).toBe(false);
      expect(readdirSync(join(f.home, "payloads"))).toEqual(["redirect-question.md"]);
    }
  } finally { removeScratchTree(f.root); }
});

test("public out rejects invalid retirement with identical registry and no bus side effects", () => {
  const f = fixture();
  try {
    const before = readFileSync(f.registry, "utf8");
    for (const args of [["a", "--forward-to", "a"], ["a", "--forward-to", "missing"], ["a", "--forward-to", "other/b"], ["a", "--forward-to", "b", "--kill"]]) {
      expect(f.run("out", ...args).code).toBe(1);
      expect(readFileSync(f.registry, "utf8")).toBe(before);
      expect(readdirSync(join(f.home, "payloads"))).toEqual([]);
    }
  } finally { removeScratchTree(f.root); }
});

test("fresh public sends and predecessor replies route to distinct recipient incarnations", () => {
  const f = fixture();
  try {
    f.seed("leader-question", "a", "worker");
    expect(f.run("out", "a", "--forward-to", "b").code).toBe(0);
    const future = f.run("send", "a", "--from", "worker", "--ask", "-m", "future question");
    expect(future.code, future.err).toBe(0);
    let doc = loadRegistry(f.registry);
    (doc.seats as any).a = { status: "active", delivery: "poll", instance: "a|2" };
    saveRegistry(f.registry, doc);
    expect(f.run("send", "a", "--from", "worker", "--ask", "-m", "fresh A2").code).toBe(0);
    const answer = f.run("reply", "leader-question", "--by", "worker", "-m", "original leader answer");
    expect(answer.code, answer.err).toBe(0);
    const messages = readdirSync(join(f.home, "payloads")).filter(n => n.endsWith(".md")).map(n => readFileSync(join(f.home, "payloads", n), "utf8"));
    expect(envelopeField(messages.find(s => s.endsWith("future question\n"))!, "to")).toBe("b");
    expect(envelopeField(messages.find(s => s.endsWith("fresh A2\n"))!, "recipient_instance")).toBe("a|2");
    const reply = messages.find(s => s.endsWith("original leader answer\n"))!;
    expect(envelopeField(reply, "to")).toBe("b");
    expect(envelopeField(reply, "to_adopted_from")).toBe("a");
    expect(envelopeField(reply, "original_recipient_instance")).toBe("a|1");
  } finally { removeScratchTree(f.root); }
}, 30000);

test("successor read/reply adopts unchanged canonical ask with its own authorship", () => {
  const f = fixture();
  try {
    const inbound = f.seed("pending-question");
    expect(f.run("out", "a", "--forward-to", "b").code).toBe(0);
    const read = f.run("read", "pending-question");
    expect(read.code, read.err).toBe(0);
    expect(existsSync(join(f.home, "receipts", "pending-question.done"))).toBe(false);
    const result = f.run("reply", "pending-question", "-m", "successor answer");
    expect(result.code, result.err).toBe(0);
    expect(readFileSync(inbound.path, "utf8")).toBe(inbound.raw);
    const done = JSON.parse(readFileSync(join(f.home, "receipts", "pending-question.done"), "utf8"));
    expect(done.by).toBe("b"); expect(done.adopted_from).toBe("a");
    const raw = readFileSync(join(f.home, "payloads", `${done.reply_id}.md`), "utf8");
    expect(envelopeField(raw, "from")).toBe("b");
    // Poll senders are deliberately unbound; the reply still names its author
    // and adopted predecessor, whose grant is rechecked at placement.
    expect(envelopeField(raw, "sender_instance")).toBeUndefined();
    expect(envelopeField(raw, "adopted_from")).toBe("a");
    expect(f.run("reply", "pending-question", "--by", "b", "-m", "duplicate").code).toBe(1);
  } finally { removeScratchTree(f.root); }
}, 30000);

for (const stage of ["before", "after"]) test(`interrupted publication ${stage} rename retains both halves or neither`, async () => {
  const f = fixture();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const original = f.seed("interrupted-inbound");
    const barrier = join(f.root, "publication");
    child = Bun.spawn(["bun", join(ROOT, "runtime/bun/main.ts"), "out", "a", "--forward-to", "b"], {
      cwd: f.cwd, env: { ...f.env, TAP_SCRATCH_ONLY: "1", TAP_FORWARDING_TEST_BARRIER: barrier, TAP_FORWARDING_TEST_STAGE: stage }, stdout: "pipe", stderr: "pipe",
    });
    const deadline = Date.now() + 5000;
    while (!existsSync(barrier + ".ready") && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(barrier + ".ready")).toBe(true);
    child.kill("SIGKILL"); await child.exited;
    const doc = loadRegistry(f.registry);
    expect(Boolean((doc.seats as any).a)).toBe(stage === "before");
    expect(forwardingGrant(doc, "b", "a", "a|1")).toBe(stage === "after" ? "a" : "");
    expect(readFileSync(original.path, "utf8")).toBe(original.raw);
    expect(readdirSync(join(f.home, "receipts"))).toEqual([]);
    // Kernel custody must be released after parent death; retry is safe only
    // when the snapshot proves no transition was committed.
    if (stage === "before") expect(f.run("out", "a", "--forward-to", "b").code).toBe(0);
    else expect(f.run("out", "a", "--forward-to", "b").code).toBe(1);
  } finally { child?.kill(); if (child) await child.exited; removeScratchTree(f.root); }
}, 15000);

test("successor discovers and reads parked foreign custom-id mail without replay, then replies as itself", () => {
  const f = fixture();
  try {
    const away = join(f.root, "away"), home = join(away, ".tap/bus"), registry = join(away, ".tap/team-registry.json");
    for (const dir of ["payloads", "receipts", "spool"]) mkdirSync(join(home, dir), { recursive: true });
    saveRegistry(registry, { schema: "0.20", team: { name: "away" }, seats: { remote: { status: "active", delivery: "poll", instance: "remote|1" } } });
    const index = JSON.parse(readFileSync(join(f.index, "global-registry.json"), "utf8"));
    index.teams.away = { root: away, registry_location: registry, state: "registered" };
    writeFileSync(join(f.index, "global-registry.json"), JSON.stringify(index));
    // Remote poll delivery is unsupported; the existing explicit reply_to
    // chooses a local return principal while settlement stays on the foreign bus.
    const id = "foreign-custom-id", path = join(home, "payloads", `${id}.md`), parked = join(home, "spool", `${id}.md`);
    const raw = `---\nid: ${id}\nfrom: remote\nfrom_team: away\nreply_to: forward/worker\nto: a\nto_team: forward\nsender_instance: remote|1\nrecipient_instance: a|1\nkind: discuss\nreply: expected\npath: ${path}\n---\nForeign original body\n`;
    writeFileSync(parked, raw);
    writeFileSync(join(home, "spool", `${id}.meta.json`), JSON.stringify({ id, target: "a", target_registry: f.registry, team: "away", to_team: "forward", reason: "pending-input", first_spooled_epoch: 1, attempts: 0, policy: "standard" }));
    writeFileSync(join(home, "receipts", `${id}.attempted`), "possible prior attempt");
    expect(f.run("out", "a", "--forward-to", "b").code).toBe(0);
    expect(existsSync(path)).toBe(false);
    const poll = f.run("poll", "b", "--json");
    expect(poll.code, poll.err).toBe(0);
    expect(JSON.parse(poll.out).pending.find((v: any) => v.id === id)).toMatchObject({ adopted_from: "a", path: parked, residency: "parked" });
    const invalidPath = join(home, "payloads", "foreign-invalid.md");
    writeFileSync(invalidPath, raw.replaceAll(id, "foreign-invalid").replace("reply: expected", "reply: unexpected"));
    const human = f.run("poll", "b");
    expect(human.out).toContain(`next step: tap show path=${invalidPath}`);
    expect(f.run("show", "path=" + invalidPath).code).toBe(0);
    expect(human.out).toContain(`next step: tap read path=${parked} --by b`);
    const read = f.run("read", "path=" + parked);
    expect(read.code, read.err).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(raw);
    expect(readFileSync(join(home, "receipts", `${id}.attempted`), "utf8")).toBe("possible prior attempt");
    expect(existsSync(join(home, "receipts", `${id}.sent`))).toBe(false);
    const reply = f.run("reply", "path=" + path, "--by", "b", "-m", "foreign successor answer");
    expect(reply.code, reply.err).toBe(0);
    expect(JSON.parse(readFileSync(join(home, "receipts", `${id}.done`), "utf8"))).toMatchObject({ by: "b", adopted_from: "a" });
    expect(readFileSync(path, "utf8")).toBe(raw);
  } finally { removeScratchTree(f.root); }
}, 30000);


test("source restore revokes successor authority and restores original sender cancellation", () => {
  const f = fixture();
  try {
    f.seed("restore-inbound");
    f.seed("restore-outbound", "a", "worker");
    expect(f.run("out", "a", "--forward-to", "b").code).toBe(0);
    const history = f.run("register", "a", "--list-history", "--json");
    expect(history.code, history.err).toBe(0);
    expect(history.out).toContain("a|1");
    const restore = f.run("register", "a", "--delivery", "poll", "--team", "forward", "--restore", "a|1");
    expect(restore.code, restore.err).toBe(0);
    const doc = loadRegistry(f.registry);
    expect((doc.seats as any).a.instance).toBe("a|1");
    expect((doc.seat_forwardings as any[])[0]).toMatchObject({ address_active: false, custody_revoked: true });
    expect(forwardingGrant(doc, "b", "a", "a|1")).toBe("");
    expect(f.run("reply", "restore-inbound", "--by", "b", "-m", "denied").code).toBe(1);
    // `cancel` is for sends whose addressee is gone. Plain `tap out worker` now withdraws that seat's inbound itself,
    // which would leave nothing for the restored source to cancel, so drop the row without the withdrawal.
    const gone = loadRegistry(f.registry);
    delete (gone.seats as any).worker;
    saveRegistry(f.registry, gone);
    const cancel = f.run("cancel", "restore-outbound", "--by", "a");
    expect(cancel.code, cancel.err).toBe(0);
    expect(existsSync(join(f.home, "receipts", "restore-outbound.cancelled"))).toBe(true);
  } finally { removeScratchTree(f.root); }
}, 30000);


test("suspended or replaced successors preserve stamped spool custody after source reuse", async () => {
  const { recipientRetired } = await import("../src/spool-retired");
  const f = fixture();
  try {
    const item = f.seed("retirement-custody", "worker", "a", true);
    expect(f.run("out", "a", "--forward-to", "b").code).toBe(0);
    const doc = loadRegistry(f.registry);
    (doc.seats as any).a = { status: "active", instance: "a|2", registered_at: "2026-09-07T12:00:00Z" };
    (doc.seats as any).b.status = "suspended";
    saveRegistry(f.registry, doc);
    const meta = JSON.parse(readFileSync(join(f.home, "spool/retirement-custody.meta.json"), "utf8"));
    expect(recipientRetired(meta, item.raw, doc, f.registry)).toBe(false);
    (doc.seats as any).b.instance = "b|2";
    expect(recipientRetired(meta, item.raw, doc, f.registry)).toBe(false);
  } finally { removeScratchTree(f.root); }
});


test("replies without source forwarding history retain address routing after sender replacement", () => {
  const f = fixture();
  try {
    f.seed("ordinary-old-sender", "a", "worker");
    const doc = loadRegistry(f.registry);
    (doc.seats as any).a.instance = "a|2";
    // Unrelated custody must not change this ordinary sender's reply policy.
    const updated = prepareForwarding(doc, "b", "c", "now").doc;
    saveRegistry(f.registry, updated);
    const reply = f.run("reply", "ordinary-old-sender", "--by", "worker", "-m", "ordinary answer");
    expect(reply.code, reply.err).toBe(0);
    const done = JSON.parse(readFileSync(join(f.home, "receipts/ordinary-old-sender.done"), "utf8"));
    const answer = readFileSync(join(f.home, "payloads", `${done.reply_id}.md`), "utf8");
    expect(envelopeField(answer, "recipient_instance")).toBe("a|2");
    expect(envelopeField(answer, "to_adopted_from")).toBeUndefined();
  } finally { removeScratchTree(f.root); }
}, 30000);
