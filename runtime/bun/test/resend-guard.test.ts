import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { acquireObligationLock, acquirePathLock } from "../src/panelock";
import { acquireResetFence, releaseResetFence } from "../src/reset";
import { componentTable } from "../src/team/reset-components";
import { removeScratchTree } from "./support/scratch";
import { reapStaleSidecars } from "../src/spool-sidecar";

const root = resolve(import.meta.dir, "../../.."), scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) removeScratchTree(path); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tap-resend-guard.")); scratch.push(dir);
  const bus = join(dir, ".tap/bus"), index = join(dir, "index");
  for (const name of ["spool", "payloads", "receipts", "archive"]) mkdirSync(join(bus, name), { recursive: true });
  mkdirSync(index);
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
  const registry = join(bus, "registry.json"), source = join(bus, "spool/original.md"), meta = join(bus, "spool/original.meta.json");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "t", worktree_root: dir }, seats: {
    alice: { delivery: "poll", status: "active", instance: "a", harness: "codex" },
    peer: { delivery: "poll", status: "active", instance: "p", harness: "codex" },
  } }));
  const bytes = Buffer.from("---\nid: original\nfrom: alice\nto: peer\nkind: discuss\nreply: expected\n---\nOriginal\r\nno final newline");
  writeFileSync(source, bytes);
  writeFileSync(meta, '{"id":"original","attempts":0,"attempt_fence":1}');
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, TAP_HOME: bus, TAP_INDEX_HOME: index, TAP_LOCK_DIR: join(dir, "locks"),
    TAP_SESSION_MANIFEST: join(dir, "sessions.json"), TAP_VERSION_SEEN_PATH: join(dir, "seen.json"), OPENCODE_DB_PATH: join(dir, "opencode.db"),
    TAP_SPOOL_DISABLE_OPPORTUNISTIC: "1", TAP_SPOOL_DISABLE_DELIVERER: "1", TAP_SELF: "", TAP_SCRATCH_ONLY: "1" };
  return { dir, bus, index, registry, source, meta, bytes, env };
}
type Fx = ReturnType<typeof fixture>;
function command(door: "native" | "bash" | "bin" = "native"): string[] {
  return door === "native" ? [process.execPath, join(root, "runtime/bun/main.ts")]
    : ["bash", join(root, door === "bash" ? "scripts/tap.sh" : "bin/tap")];
}
function run(fx: Fx, args = ["--json", "original", "--by", "alice"], door: "native" | "bash" | "bin" = "native") {
  const [cmd, ...prefix] = command(door);
  return spawnSync(cmd!, [...prefix, "resend", ...args], { cwd: fx.dir, env: fx.env, encoding: "utf8", timeout: 20_000 });
}
function unchangedRefusal(fx: Fx, klass: string, args?: string[]) {
  const bytes = readFileSync(fx.source), r = run(fx, args);
  expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toMatchObject({ status: 1, stderr: "" });
  expect(JSON.parse(r.stdout).error_class).toBe(klass);
  expect(readFileSync(fx.source)).toEqual(bytes);
  expect(existsSync(join(fx.bus, "receipts/original.resent"))).toBe(false);
  expect(readdirSync(join(fx.bus, "archive")).filter(x => x.endsWith(".resend.md"))).toEqual([]);
  return r;
}
for (const attempts of ["0", "62", "0.0"]) test(`orphan recovery preserves the explicit resend proof: attempts=${attempts}`, () => {
  const fx = fixture(), canon = join(fx.bus, "payloads/original.md");
  writeFileSync(fx.meta, `{"id":"original","attempts":${attempts},"attempt_fence":1}`);
  const metadata = readFileSync(fx.meta);
  renameSync(fx.source, canon);
  reapStaleSidecars(join(fx.bus, "spool"), join(fx.bus, "payloads"), fx.env);
  expect(existsSync(fx.meta)).toBe(false);
  expect(readFileSync(join(fx.bus, "archive/original.meta.json"))).toEqual(metadata);
  expect(existsSync(join(fx.bus, "spool/original.md"))).toBe(false);
  const result = run(fx);
  if (attempts === "0") expect(result.status).toBe(0);
  else {
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error_class).toBe(attempts === "62" ? "delivery_attempted" : "effect_unknown");
    expect(readFileSync(canon)).toEqual(fx.bytes);
    expect(existsSync(join(fx.bus, "receipts/original.resent"))).toBe(false);
  }
});
for (const dir of ["receipts", "payloads", "spool", "archive"]) for (const suffix of ["attempted", "attempts", "sent", "read", "done"]) {
  test(`possible-effect evidence refuses: ${dir}/${suffix}`, () => {
    const fx = fixture(); writeFileSync(join(fx.bus, dir, `original.${suffix}`), "{}");
    const r = unchangedRefusal(fx, "delivery_attempted", ["original", "--by", "alice"]);
    expect(r.stdout).toStartWith('{"status": "refused", "error_class": "delivery_attempted", "detail": "delivery evidence exists: original.');
  });
}
for (const attempts of ["0.0", "0e0", "false", '"0"', "null", "[]", "{}", "NaN", "1", "-1", "9007199254740993"]) {
  test(`attempt count retains Python numeric eligibility: ${attempts}`, () => {
    const fx = fixture(); writeFileSync(fx.meta, `{"id":"original","attempts":${attempts},"attempt_fence":1}`);
    const r = unchangedRefusal(fx, ["1", "-1", "9007199254740993"].includes(attempts) ? "delivery_attempted" : "effect_unknown");
    if (attempts === "9007199254740993") expect(r.stdout).toContain("9007199254740993 delivery attempts");
  });
}
for (const fence of ["1", "1.0", "1e0", "true"]) {
  test(`fence equality preserves incumbent acceptance: ${fence}`, () => {
    const fx = fixture(); writeFileSync(fx.meta, `{"id":"original","attempts":-0,"attempt_fence":${fence}}`);
    writeFileSync(join(fx.bus, "receipts/original.placed"), "{}");
    expect(run(fx).status).toBe(0);
  });
}
for (const [text, tail] of [["{broken", ""], ["[]", "expected an object"], ["1.0", "expected an object"], ["null", "expected an object"], ['{"attempts":0,"id":"wrong","attempt_fence":1}', "legacy zero count"], ['{"id":"original","attempts":0}', "legacy zero count"]]) {
  test(`bad metadata remains unknown: ${text}`, () => {
    const fx = fixture(); writeFileSync(fx.meta, text!);
    const r = unchangedRefusal(fx, "effect_unknown");
    if (tail === "expected an object") expect(JSON.parse(r.stdout).detail).toBe("cannot read evidence original.meta.json: expected an object");
    else if (tail) expect(r.stdout).toContain(tail);
    else expect(JSON.parse(r.stdout).detail).toStartWith("cannot read evidence original.meta.json: ");
  });
}
test("spool metadata wins over archive; double absence is effect_unknown", () => {
  for (const missing of [false, true]) {
    const fx = fixture(); unlinkSync(fx.meta);
    if (!missing) { writeFileSync(fx.meta, "{broken"); writeFileSync(join(fx.bus, "archive/original.meta.json"), '{"id":"original","attempts":0,"attempt_fence":1}'); }
    expect(JSON.parse(unchangedRefusal(fx, "effect_unknown").stdout).detail).toStartWith("cannot read evidence original.meta.json: ");
  }
});
for (const shape of ["stale-claim", "malformed-claim", "intent", "kind", "urgency", "policy", "team", "instance", "missing-seat", "id", "duplicate", "cross-worktree"]) {
  test(`guard refuses without consuming: ${shape}`, () => {
    const fx = fixture(); let klass = "not_sender";
    if (shape.endsWith("claim")) {
      const path = join(fx.bus, "spool/original.claim"); writeFileSync(path, shape === "stale-claim" ? '{"owner_pid":99999999}' : "bad");
      utimesSync(path, 1, 1); klass = "delivery_busy";
    } else if (shape === "intent") { writeFileSync(join(fx.bus, "spool/original.json"), "{}"); klass = "effect_unknown"; }
    else if (shape === "policy") { writeFileSync(fx.meta, '{"id":"original","attempts":0,"attempt_fence":1,"policy":"urgent"}'); klass = "interrupt_resend"; }
    else {
      const extra: Record<string, string> = { kind: "urgency: urgent\n", urgency: "urgency: urgent\n", team: "from_team: other\n", instance: "sender_instance: stale\n", "missing-seat": "sender_instance: a\n", duplicate: "from: alice\n", "cross-worktree": "cross_worktree: yes\n" };
      let text = fx.bytes.toString();
      if (shape === "kind") text = text.replace("kind: discuss", "kind: escalate");
      else if (shape === "id") text = text.replace("id: original", "id: wrong");
      else text = text.replace("kind: discuss\n", "kind: discuss\n" + extra[shape]);
      writeFileSync(fx.source, text);
      if (shape === "missing-seat") { const reg = JSON.parse(readFileSync(fx.registry, "utf8")); delete reg.seats.alice; writeFileSync(fx.registry, JSON.stringify(reg)); }
      if (["kind", "urgency"].includes(shape)) klass = "interrupt_resend";
      if (["id", "duplicate", "cross-worktree"].includes(shape)) klass = "invalid_payload";
    }
    unchangedRefusal(fx, klass);
    if (shape.endsWith("claim")) expect(existsSync(join(fx.bus, "spool/original.claim"))).toBe(true);
  });
}
test("resent wins over attempt evidence and existing cancellation bytes survive", () => {
  const fx = fixture(); writeFileSync(join(fx.bus, "receipts/original.resent"), "consumed"); writeFileSync(join(fx.bus, "receipts/original.sent"), "{}");
  expect(JSON.parse(run(fx).stdout).error_class).toBe("already_resent");
  const other = fixture(), receipt = '{"via":"cancelled","custom":"preserve"}\n';
  writeFileSync(join(other.bus, "receipts/original.cancelled"), receipt);
  expect(run(other).status).toBe(0);
  expect(readFileSync(join(other.bus, "receipts/original.cancelled"), "utf8")).toBe(receipt);
});
test("bound sender and legacy empty instance remain supported", () => {
  for (const instance of ["a", ""]) {
    const fx = fixture(); writeFileSync(fx.source, fx.bytes.toString().replace("kind: discuss", `from_team: t\nsender_instance: ${instance}\nkind: discuss`));
    expect(run(fx).status).toBe(0);
  }
});
test("C4a: an agents decoy beside seats makes the registry old_store; resend refuses and never reads it", () => {
  const fx = fixture(); writeFileSync(fx.source, fx.bytes.toString().replace("kind: discuss", "from_team: t\nsender_instance: a\nkind: discuss"));
  const reg = JSON.parse(readFileSync(fx.registry, "utf8")); reg.agents = { alice: { instance: "decoy" } }; writeFileSync(fx.registry, JSON.stringify(reg));
  const result = run(fx);
  expect(result.status).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toMatch(/old_store|is an old TAP registry format/);
});
function encodedJson(text: string, encoding: string): Buffer {
  if (encoding === "utf8") return Buffer.from(text);
  if (encoding === "utf8-bom") return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]);
  const width = encoding.includes("32") ? 4 : 2, little = encoding.includes("le"), bom = encoding.endsWith("bom");
  const points = width === 4 ? [...text].map(c => c.codePointAt(0)!) : Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
  if (bom) points.unshift(0xfeff);
  const out = Buffer.alloc(points.length * width);
  points.forEach((cp, i) => width === 4 ? little ? out.writeUInt32LE(cp, i * width) : out.writeUInt32BE(cp, i * width) : little ? out.writeUInt16LE(cp, i * width) : out.writeUInt16BE(cp, i * width));
  return out;
}
for (const encoding of ["utf8", "utf8-bom", "utf16le", "utf16be", "utf16le-bom", "utf16be-bom", "utf32le", "utf32be", "utf32le-bom", "utf32be-bom"]) {
  test(`JSON byte encoding stays accepted: ${encoding}`, () => {
    const fx = fixture(); writeFileSync(fx.meta, encodedJson('{"id":"original","attempts":0,"attempt_fence":1,"extra":"☃😀"}', encoding));
    expect(run(fx).status).toBe(0);
  });
}
test("binary JSON surrogatepass; raw body and ordered unusual header fields are preserved", () => {
  const fx = fixture();
  const metadata = Buffer.concat([Buffer.from('{"id":"original","attempts":0,"attempt_fence":1,"extra":"'), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from('"}')]);
  writeFileSync(fx.meta, metadata);
  const body = Buffer.from([0xff, 0, 13, 10, 0xef, 0xbb, 0xbf, 65]);
  const header = "---\nid:original\nfrom:\talice \t\nto:peer\nreply: expected\nkind: discuss\n10: first\n2: second\n__proto__: retained\nresend_of: older\n---\n";
  const original = Buffer.concat([Buffer.from(header), body]); writeFileSync(fx.source, original);
  const r = run(fx); expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
  const receipt = JSON.parse(readFileSync(join(fx.bus, "receipts/original.resent"), "utf8"));
  expect(readFileSync(join(fx.bus, "archive/original.cancelled.md"))).toEqual(original);
  const prepared = readFileSync(receipt.prepared);
  expect(prepared.subarray(prepared.indexOf("\n---\n", 3) + 5)).toEqual(body);
  expect(prepared.toString()).toContain("10: first\n2: second\n__proto__: retained\nresend_of: original\n");
  const successor = readFileSync(join(fx.bus, "payloads", `${receipt.resend_id}.md`));
  expect(successor.subarray(successor.indexOf("\n---\n", 3) + 5)).toEqual(body);
});
for (const door of ["native", "bash", "bin"] as const) {
  test(`${door} closes team and missing operand fallbacks`, () => {
    const fx = fixture();
    writeFileSync(join(fx.index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { t: { root: fx.dir, registry_location: fx.registry, state: "registered" } } }));
    delete fx.env.TAP_HOME; fx.env.TAP_BUN_ROUTE_TRACE = join(fx.dir, "route");
    const r = run(fx, ["--json", "original", "--team", "t", "--by", "alice"], door);
    expect(r.status).toBe(0); expect(readFileSync(join(fx.dir, "route"), "utf8")).toBe("native resend\n");
    for (const option of ["--by", "--team"]) for (const operand of [[], [""]]) {
      const bad = run(fx, ["--json", "original", option, ...operand], door);
      expect(bad.status).toBe(1); expect(bad.stdout).toBe(""); expect(bad.stderr).toContain(`tap resend: ${option} needs a value\n`);
    }
  });
}
test("caller bus pin wins over team and foreign cwd; pane-less implicit actor refuses", () => {
  const fx = fixture(), other = fixture();
  writeFileSync(join(fx.index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    t: { root: fx.dir, registry_location: fx.registry, state: "registered" }, other: { root: other.dir, registry_location: other.registry, state: "registered" },
  } }));
  const cmd = command();
  const r = spawnSync(cmd[0]!, [...cmd.slice(1), "resend", "original", "--by", "alice", "--team", "other", "--json"], { cwd: other.dir, env: fx.env, encoding: "utf8", timeout: 20_000 });
  expect(r.status).toBe(0); expect(existsSync(join(fx.bus, "receipts/original.resent"))).toBe(true); expect(readFileSync(other.source)).toEqual(other.bytes);
  const noActor = fixture(); const refused = unchangedRefusal(noActor, "no_actor", ["--json", "original"]);
  expect(refused.stdout).toContain("resend requires the original sender");
});
for (const [state, expected, forbidden] of [
  ["open", "tap withdraw", "--spooled"], ["done", "tap show", "tap withdraw"], ["spooled", "tap cancel original --spooled", "tap withdraw"],
  ["withdrawn", "answer 'successor' instead", "tap withdraw"], ["cancelled", "already terminal (via: cancelled)", "tap withdraw"], ["garbage", "tap show", "tap withdraw"],
]) {
  test(`public refusal advice follows terminality: ${state}`, () => {
    const fx = fixture(); if (state !== "spooled") renameSync(fx.source, join(fx.bus, "payloads/original.md"));
    writeFileSync(join(fx.bus, "receipts/original.attempted"), "{}");
    if (state === "done") writeFileSync(join(fx.bus, "receipts/original.done"), "{}");
    if (["withdrawn", "cancelled", "garbage"].includes(state!)) writeFileSync(join(fx.bus, "receipts/original.cancelled"), state === "garbage" ? "{broken" : JSON.stringify({ via: state === "withdrawn" ? "withdrawn" : "cancelled", superseded_by: "successor" }));
    const r = run(fx); expect(r.status).toBe(1); expect(JSON.parse(r.stdout).error_class).toBe("delivery_attempted"); expect(r.stdout).toContain(expected!); expect(r.stdout).not.toContain(forbidden!);
  });
}
// Mocks are process-local: no node:fs mock leaks into other runner test files.
function faultEntry(fx: Fx, fault: string): string {
  const path = join(fx.dir, "fault.ts");
  writeFileSync(path, `import {mock} from 'bun:test';
import * as fs from 'node:fs';
const real = {...fs}, opened = new Map<number,string>();
const fault = ${JSON.stringify(fault)};
mock.module('node:fs', () => ({...real,
 openSync(path, ...args) { const fd = real.openSync(path, ...args); opened.set(fd, String(path)); return fd; },
 fsyncSync(fd) { if (fault === 'fsync' && opened.get(fd)?.endsWith('original.resent')) throw new Error('forced fsync'); return real.fsyncSync(fd); },
 writeSync(fd, buf, off, len, ...rest) { if (fault === 'short' && opened.get(fd)?.endsWith('original.resent')) return real.writeSync(fd, buf, off, Math.min(3,len), ...rest); if (fault === 'zero' && opened.get(fd)?.endsWith('original.resent')) return 0; return real.writeSync(fd,buf,off,len,...rest); },
 unlinkSync(path) { if (fault === 'unlink' && String(path).endsWith('spool/original.meta.json')) throw new Error('forced unlink'); return real.unlinkSync(path); },
 renameSync(from,to) { if (fault === 'mark' && String(to).endsWith('reset-generation.json')) throw new Error('forced mark'); return real.renameSync(from,to); }
}));
const ids = await import(${JSON.stringify(join(root, "runtime/bun/src/ids.ts"))});
mock.module(${JSON.stringify(join(root, "runtime/bun/src/ids.ts"))}, () => ({...ids,mintId: () => 'successor'}));
const {cmdResend} = await import(${JSON.stringify(join(root, "runtime/bun/src/verbs/resend.ts"))});
process.exitCode = cmdResend(['original','--by','alice','--json'],${JSON.stringify(join(root, "skills/tap/scripts"))});
`);
  return path;
}
for (const fault of ["prepared-collision", "resent-collision", "archive-collision", "fsync", "zero", "mark", "unlink", "short"]) {
  test(`publication fault preserves forensic custody: ${fault}`, () => {
    const fx = fixture(), gen = join(fx.bus, "reset-generation.json");
    writeFileSync(gen, '{"state":"pristine","bundle_id":"checkpoint"}');
    if (fault === "prepared-collision") writeFileSync(join(fx.bus, "archive/successor.resend.md"), "existing prepared");
    if (fault === "resent-collision") mkdirSync(join(fx.bus, "receipts/original.resent"));
    if (fault === "archive-collision") writeFileSync(join(fx.bus, "archive/original.cancelled.md"), "existing archive");
    const r = spawnSync(process.execPath, [faultEntry(fx, fault)], { cwd: fx.dir, env: fx.env, encoding: "utf8", timeout: 20_000 });
    expect(r.status).toBe(fault === "short" ? 0 : 1);
    expect(existsSync(join(fx.bus, "payloads/successor.md"))).toBe(fault === "short");
    expect(existsSync(join(fx.bus, "spool/original.claim"))).toBe(false);
    const consumed = ["archive-collision", "fsync", "zero", "mark", "unlink", "short"].includes(fault);
    expect(existsSync(join(fx.bus, "receipts/original.resent"))).toBe(consumed || fault === "resent-collision");
    expect(JSON.parse(readFileSync(gen, "utf8")).state).toBe(["archive-collision", "unlink", "short"].includes(fault) ? "reused" : "pristine");
    if (fault === "prepared-collision") expect(readFileSync(join(fx.bus, "archive/successor.resend.md"), "utf8")).toBe("existing prepared");
    if (fault === "archive-collision") expect(readFileSync(join(fx.bus, "archive/original.cancelled.md"), "utf8")).toBe("existing archive");
    if (consumed) { const again = run(fx); expect(again.status).toBe(1); expect(JSON.parse(again.stdout).error_class).toBe("already_resent"); }
    if (fault === "short") expect(JSON.parse(readFileSync(join(fx.bus, "receipts/original.resent"), "utf8"))).toMatchObject({ id: "original", resend_id: "successor" });
  });
}
async function reached(path: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!existsSync(path)) { if (Date.now() > deadline) throw new Error(`barrier not reached: ${path}`); await Bun.sleep(10); }
}
function start(fx: Fx, stage: string) {
  const base = join(fx.dir, "barrier");
  const child = Bun.spawn([...command(), "resend", "--json", "original", "--by", "alice"], { cwd: fx.dir, env: { ...fx.env,
    TAP_OBLIGATION_TEST_BARRIER: base, TAP_OBLIGATION_TEST_ID: "original", TAP_OBLIGATION_TEST_STAGE: stage }, stdout: "pipe", stderr: "pipe" });
  return { child, base };
}
for (const stage of ["prepared", "consumed"]) {
  test(`reset cannot enter preparation at ${stage}; marker follows durable consumption`, async () => {
    const fx = fixture(), gen = join(fx.bus, "reset-generation.json"); writeFileSync(gen, '{"state":"pristine","bundle_id":"checkpoint"}');
    const { child, base } = start(fx, stage);
    try {
      await reached(`${base}.${stage}.reached`);
      expect(acquirePathLock(join(fx.bus, "reset.fence.json.lock"), 0, fx.env)).toBeNull();
      expect(acquireObligationLock("original", 0, fx.env)).toBeNull();
      expect(JSON.parse(readFileSync(gen, "utf8")).state).toBe(stage === "prepared" ? "pristine" : "reused");
      expect(existsSync(join(fx.bus, "receipts/original.resent"))).toBe(stage === "consumed");
      expect(componentTable().find(c => c.name === "archive")?.fate).toBe("preserve");
      writeFileSync(`${base}.${stage}.release`, "1"); expect(await child.exited).toBe(0);
    } finally { child.kill(); await child.exited; }
  }, 30_000);
}
test("metadata holder blocks guard and keeps reset/obligation custody until release", async () => {
  const fx = fixture(), lock = acquirePathLock(`${fx.meta}.lock`, 0, fx.env)!;
  const { child, base } = start(fx, "prepared");
  try {
    await reached(join(fx.bus, "spool/original.claim"));
    await Bun.sleep(5200); // longer than the ordinary path-lock timeout
    expect(existsSync(`${base}.prepared.reached`)).toBe(false);
    expect(acquirePathLock(join(fx.bus, "reset.fence.json.lock"), 0, fx.env)).toBeNull();
    lock.release(); await reached(`${base}.prepared.reached`);
    writeFileSync(`${base}.prepared.release`, "1"); expect(await child.exited).toBe(0);
  } finally { lock.release(); child.kill(); await child.exited; }
}, 30_000);
test("reset fence wins over obligation busy on every public resend door", () => {
  for (const door of ["native", "bash", "bin"] as const) {
    const fx = fixture(), token = acquireResetFence(fx.bus, String(process.pid));
    const lock = acquireObligationLock("original", 0, fx.env)!;
    try { const r = run(fx, undefined, door); expect(r.status).toBe(1); expect(JSON.parse(r.stdout).error_class).toBe("team_reset_fenced"); }
    finally { lock.release(); releaseResetFence(fx.bus, token); }
    expect(readFileSync(fx.source)).toEqual(fx.bytes);
    expect(existsSync(join(fx.bus, "receipts/original.resent"))).toBe(false);
  }
}, 30_000);
test("reset may acquire between preparation and child; failure cannot resend original", async () => {
  const fx = fixture(), { child, base } = start(fx, "handoff");
  let token = "";
  try {
    await reached(`${base}.handoff.reached`);
    expect(acquireObligationLock("original", 0, fx.env)).toBeNull();
    token = acquireResetFence(fx.bus, String(process.pid));
    const consumed = JSON.parse(readFileSync(join(fx.bus, "receipts/original.resent"), "utf8"));
    writeFileSync(`${base}.handoff.release`, "1");
    expect(await child.exited).toBe(1);
    const stdout = await new Response(child.stdout).text(); expect(stdout).toContain("team_reset_fenced");
    expect(existsSync(join(fx.bus, "payloads", `${consumed.resend_id}.md`))).toBe(false);
    expect(readFileSync(join(fx.bus, "archive/original.cancelled.md"))).toEqual(fx.bytes);
    releaseResetFence(fx.bus, token); token = "";
    expect(JSON.parse(run(fx).stdout).error_class).toBe("already_resent");
    expect(readdirSync(join(fx.bus, "archive")).filter(x => x.endsWith(".resend.md"))).toHaveLength(1);
  } finally { if (token) releaseResetFence(fx.bus, token); child.kill(); await child.exited; }
}, 30_000);

for (const kind of ["missing", "corrupt", "array", "bad-team", "bad-seat", "invalid-marker"]) {
  test(`uncertain registry never authorizes unbound consumption: ${kind}`, () => {
    const fx = fixture();
    if (kind === "missing") unlinkSync(fx.registry);
    if (kind === "corrupt") writeFileSync(fx.registry, "{broken");
    if (kind === "array") writeFileSync(fx.registry, "[]");
    if (kind === "bad-team") writeFileSync(fx.registry, '{"team":[],"seats":{}}');
    if (kind === "bad-seat") {
      writeFileSync(fx.source, fx.bytes.toString().replace("kind: discuss", "sender_instance: a\nkind: discuss"));
      writeFileSync(fx.registry, '{"team":{"name":"t"},"seats":{"alice":null}}');
    }
    if (kind === "invalid-marker") writeFileSync(join(fx.index, "global-registry.json"), "{broken");
    const before = readFileSync(fx.source), r = run(fx);
    expect(r.status).toBe(1); expect(readFileSync(fx.source)).toEqual(before);
    expect(existsSync(join(fx.bus, "receipts/original.resent"))).toBe(false);
    if (kind === "invalid-marker") expect(JSON.parse(r.stdout).error_class).toBe("invalid_flip");
    if (kind === "array") expect(JSON.parse(r.stdout).detail).toBe("cannot read evidence registry.json: expected an object");
  });
}
for (const mode of ["implicit", "ambient", "explicit", "wrong-team", "unobservable"]) {
  test(`actor resolution remains native: ${mode}`, () => {
    const fx = fixture(), bin = join(fx.dir, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "ps"), "#!/bin/sh\nprintf '1 ttyfixture\\n'\n", { mode: 0o755 });
    writeFileSync(join(bin, "tmux"), `#!/bin/sh
case "$*" in
 *list-panes*) printf '%%700\\t/dev/ttyfixture\\n' ;;
 *pane_tty*) printf '%%700\\t/dev/ttyfixture\\tsandbox\\t123:456\\n' ;;
 *display-message*) printf '%%700\\n' ;;
 *) exit 1 ;;
esac
`, { mode: 0o755 });
    fx.env.PATH = `${bin}:${process.env.PATH}`;
    const reg = JSON.parse(readFileSync(fx.registry, "utf8"));
    Object.assign(reg.seats.alice, { pane_id: "%700", pane: "sandbox:0.0", session: "sandbox", server_epoch: "srv:123:456" });
    if (mode === "wrong-team") {
      const other = fixture(), doc = JSON.parse(readFileSync(other.registry, "utf8")); doc.team.name = "other"; doc.seats.alice = reg.seats.alice;
      writeFileSync(other.registry, JSON.stringify(doc)); reg.seats.alice.pane_id = "%800";
      writeFileSync(join(fx.index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
        t: { root: fx.dir, registry_location: fx.registry, state: "registered" }, other: { root: other.dir, registry_location: other.registry, state: "registered" },
      } }));
    }
    writeFileSync(fx.registry, JSON.stringify(reg));
    if (mode === "unobservable") writeFileSync(join(bin, "tmux"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    if (mode === "ambient") fx.env.TAP_SELF = "alice";
    if (mode === "explicit") fx.env.TAP_SELF = "other";
    const args = ["--json", "original", ...(mode === "explicit" ? ["--by", "alice"] : [])];
    const r = run(fx, args);
    expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toMatchObject({ status: ["wrong-team", "unobservable"].includes(mode) ? 1 : 0 });
    if (["wrong-team", "unobservable"].includes(mode)) {
      expect(JSON.parse(r.stdout).error_class).toBe("no_actor"); expect(existsSync(join(fx.bus, "receipts/original.resent"))).toBe(false);
      if (mode === "wrong-team") expect(r.stdout).toContain("OR  pass --by alice");
    }
  });
}
