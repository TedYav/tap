import { afterAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  appendRegistryEvent, appendRegistryEventOrWarn, atom, eventLimit, eventTimestamp,
  registryEventLine, registryEventsPath, EVENT_LOCK_TIMEOUT_MS,
} from "../src/events";
import { KERNEL_LOCK, kernelLockArgs } from "../src/panelock";
import { removeScratchTree } from "./support/scratch";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "registry-events-")));
afterAll(() => removeScratchTree(scratch));
const MODULE = resolve(import.meta.dir, "../src/events.ts");
const AT = new Date("2026-09-15T07:31:09.874Z");

function readLines(log: string): string[] {
  return readFileSync(log, "utf8").split("\n").filter(Boolean);
}
function cli(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [MODULE, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ---- line composer: the recorded lib.sh specimen and the atom rules --------

test("line bytes match the incumbent specimen with team last and detail optional", () => {
  // redelivery-sent-receipt.test.sh:143 asserts this exact prefix on the Bash writer.
  expect(registryEventLine({ actor: "courier", action: "redelivery_delivered", handle: "bob", pane: "t/bob:0.0", team: "t", detail: "id=claude-1" }, AT))
    .toBe("ts=2026-09-15T07:31:09Z actor=courier action=redelivery_delivered handle=bob pane=t/bob:0.0 detail=id=claude-1 team=t");
  expect(registryEventLine({ actor: "alice", action: "spool_quarantined_malformed", handle: "raw", pane: "", team: "beta", detail: "" }, AT))
    .toBe("ts=2026-09-15T07:31:09Z actor=alice action=spool_quarantined_malformed handle=raw pane=- team=beta");
  // Python `if detail:` is truthiness of the RAW string: whitespace-only prints `detail=-`.
  expect(registryEventLine({ actor: "a", action: "b", handle: "c", pane: "d", team: "e", detail: "  " }, AT))
    .toBe("ts=2026-09-15T07:31:09Z actor=a action=b handle=c pane=d detail=- team=e");
  expect(eventTimestamp(new Date("2026-01-02T03:04:05.999Z"))).toBe("2026-01-02T03:04:05Z");
});

test("atom follows Python's whitespace class, not JavaScript's", () => {
  expect(atom("")).toBe("-");
  expect(atom(undefined)).toBe("-");
  expect(atom("   ")).toBe("-");
  expect(atom(" id=1  reason=x\tv ")).toBe("id=1_reason=x_v");
  expect(atom("a\nb\r\nc")).toBe("a_b_c");
  // U+001F is a separator TAP uses elsewhere; the incumbent's re.sub(r"\s+") folded it.
  expect(atom("a\x1fb")).toBe("a_b");
  expect(atom("\x1c\x1d\x1e\x1f x \x85")).toBe("x");
  expect(atom("a b c　d")).toBe("a_b_c_d");
  // U+FEFF is whitespace to JS `\s` but not to Python's str.isspace(): it survives.
  expect(atom("﻿x")).toBe("﻿x");
});

test("limit parsing matches both incumbents: non-integer → 200, floor 1", () => {
  expect(eventLimit(undefined)).toBe(200);
  expect(eventLimit("")).toBe(200);
  expect(eventLimit("abc")).toBe(200);
  expect(eventLimit("5.0")).toBe(200);
  expect(eventLimit("0")).toBe(1);
  expect(eventLimit("-7")).toBe(1);
  expect(eventLimit(" 12 ")).toBe(12);
  expect(eventLimit("+3")).toBe(3);
  // Python int() grammar, probed on this host: underscores between digits and
  // Unicode decimals parse; separators, radix prefixes and exponents do not.
  expect(eventLimit("1_0")).toBe(10);
  expect(eventLimit("٣٤")).toBe(34);
  expect(eventLimit("1__0")).toBe(200);
  // ADJACENT decimal blocks: U+1D7CE..D7 abuts U+1D7D8, so "nearest non-Nd
  // below" and "codepoint % 10" both decode the second block wrong. Found by
  // two independent reviewers.
  expect(eventLimit("\u{1d7d8}")).toBe(1);
  expect(eventLimit("\u{1d7d9}\u{1d7d8}")).toBe(10);
  expect(eventLimit("\uff11\uff10")).toBe(10);
  expect(eventLimit("\x1c12")).toBe(200);
  expect(eventLimit("0x10")).toBe(200);
  expect(eventLimit("1e2")).toBe(200);
});

// ---- the write: lock sidecar, retention, decoding, failure results ---------

test("append creates the bus dir, keeps the last N in append order, drops blank lines, keeps whitespace-only rows", () => {
  const bus = join(scratch, "bus-a", "nested");
  const log = registryEventsPath(bus);
  expect(existsSync(bus)).toBe(false);
  const fields = { actor: "x", action: "first", handle: "h", pane: "p", team: "t", detail: "" };
  expect(appendRegistryEvent({ ...fields, log, now: AT })).toEqual({ ok: true });
  expect(existsSync(`${log}.lock`)).toBe(true);
  expect(readLines(log)).toEqual(["ts=2026-09-15T07:31:09Z actor=x action=first handle=h pane=p team=t"]);

  // Seed history the way an operator or an older writer might have left it:
  // blank lines, a CRLF row, and a whitespace-only row (lib.sh kept those).
  writeFileSync(log, "one\n\n  \ntwo\r\nthree\n");
  expect(appendRegistryEvent({ ...fields, log, action: "four", limit: 3, now: AT })).toEqual({ ok: true });
  expect(readLines(log)).toEqual(["  ", "two", "three", "ts=2026-09-15T07:31:09Z actor=x action=four handle=h pane=p team=t"].slice(-3));
  expect(existsSync(`${log}.tmp`)).toBe(false);

  // Retention is by position, never by timestamp: an older-stamped tail row stays newest.
  writeFileSync(log, "ts=2030-01-01T00:00:00Z actor=late action=a handle=h pane=p team=t\n");
  expect(appendRegistryEvent({ ...fields, log, action: "later", limit: 1, now: AT })).toEqual({ ok: true });
  expect(readLines(log)).toEqual(["ts=2026-09-15T07:31:09Z actor=x action=later handle=h pane=p team=t"]);
});

test("invalid UTF-8 history is replaced, not fatal, and the limit floor is 1", () => {
  const log = join(scratch, "bus-b", "registry-events.log");
  mkdirSync(join(scratch, "bus-b"));
  writeFileSync(log, Buffer.concat([Buffer.from("bad "), Buffer.from([0xff, 0xfe]), Buffer.from(" row\n")]));
  const fields = { actor: "x", action: "a", handle: "h", pane: "p", team: "t", detail: "" };
  expect(appendRegistryEvent({ ...fields, log, limit: 0, now: AT })).toEqual({ ok: true });
  expect(readLines(log)).toEqual(["ts=2026-09-15T07:31:09Z actor=x action=a handle=h pane=p team=t"]);
  writeFileSync(log, Buffer.concat([Buffer.from("bad "), Buffer.from([0xff]), Buffer.from(" row\n")]));
  expect(appendRegistryEvent({ ...fields, log, limit: 5, now: AT })).toEqual({ ok: true });
  expect(readLines(log)[0]).toBe("bad � row");
});

test("a log path that is a directory is an io_error result, and the warn twin prints the incumbent wording", () => {
  const bus = join(scratch, "bus-c");
  const log = registryEventsPath(bus);
  mkdirSync(log, { recursive: true });
  const fields = { actor: "ua", action: "send_submit_unverified", handle: "ub", pane: "ub:0.0", team: "t", detail: "id=1", log };
  const result = appendRegistryEvent(fields);
  expect(result.ok).toBe(false);
  expect(result.ok ? "" : result.reason).toBe("io_error");
  expect(appendRegistryEvent({ ...fields, log: "" })).toMatchObject({ ok: false, reason: "io_error" });

  const original = process.stderr.write.bind(process.stderr);
  const captured: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => { captured.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    expect(appendRegistryEventOrWarn("tap send", fields)).toBe(false);
    expect(appendRegistryEventOrWarn("tap read", { ...fields, log: join(scratch, "bus-c-ok", "registry-events.log") })).toBe(true);
  } finally {
    process.stderr.write = original;
  }
  // Exactly the Bash `_or_warn` line: raw action and handle, no atomizing.
  expect(captured).toEqual(["tap send: warning: registry event log append failed action=send_submit_unverified handle=ub\n"]);
});

test("a held sidecar makes the writer report lock_timeout without touching the log", async () => {
  const bus = join(scratch, "bus-d");
  const log = registryEventsPath(bus);
  const fields = { actor: "x", action: "a", handle: "h", pane: "p", team: "t", detail: "" };
  expect(appendRegistryEvent({ ...fields, log, now: AT })).toEqual({ ok: true });
  const before = readFileSync(log, "utf8");
  // Hold the SAME sidecar the way the Python fcntl writer did — flock(2) on
  // `<log>.lock` — from a child that parks on stdin. The helper is the one the
  // writer itself uses, so this is the mixed-writer exclusion, not a mock.
  // WAIT FOR PROOF OF GRANT, NOT FOR A DURATION. A fixed sleep asserts nothing:
  // on a loaded runner the helper may not have been scheduled yet, and the
  // "contended" append below would then succeed against an unheld lock and the
  // arm would pass for the wrong reason. The helper announces its grant by
  // creating a marker and then blocking — the same handshake acquirePathLock
  // itself relies on, because acquisition is not otherwise synchronously
  // observable. Flagged in review.
  const held = join(scratch, "holder.held");
  const holder = spawn(KERNEL_LOCK, kernelLockArgs(`${log}.lock`, 5, ["sh", "-c", `: > "$0"; exec cat`, held]), { stdio: ["pipe", "ignore", "ignore"] });
  const grantDeadline = Date.now() + 10_000;
  while (!existsSync(held) && Date.now() < grantDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  expect(existsSync(held)).toBe(true);
  const started = Date.now();
  const result = appendRegistryEvent({ ...fields, log, action: "blocked", now: AT });
  const waited = Date.now() - started;
  holder.stdin!.end();
  holder.kill("SIGTERM");
  await new Promise(resolve => holder.on("close", resolve));
  expect(result).toMatchObject({ ok: false, reason: "lock_timeout" });
  expect(waited).toBeGreaterThanOrEqual(EVENT_LOCK_TIMEOUT_MS - 200);
  expect(readFileSync(log, "utf8")).toBe(before);
  // Released holder: the next append goes through.
  expect(appendRegistryEvent({ ...fields, log, action: "after", now: AT })).toEqual({ ok: true });
  expect(readLines(log)).toHaveLength(2);
}, 20_000);

// ---- the adapter door: lib.sh reaches this exact argv --------------------

test("both doors resolve TAP_REGISTRY_EVENT_LIMIT from the same place", () => {
  // The Bash adapter's environment reached the old writer because it was a
  // CHILD PROCESS. An in-process native caller has no such inheritance moment,
  // so a default baked into the signature silently discards configured history
  // on exactly the five calls this PR migrated. Both doors, one seeded log.
  const fields = { actor: "a", action: "b", handle: "c", pane: "d", team: "e", detail: "" };
  const inProcess = join(scratch, "limit-direct.log");
  const door = join(scratch, "limit-cli.log");
  writeFileSync(inProcess, "prior one\nprior two\n");
  writeFileSync(door, "prior one\nprior two\n");
  const saved = process.env.TAP_REGISTRY_EVENT_LIMIT;
  process.env.TAP_REGISTRY_EVENT_LIMIT = "1";
  try {
    expect(cli(["append", door, "a", "b", "c", "d", "e", ""]).status).toBe(0);
    expect(appendRegistryEvent({ ...fields, log: inProcess, now: AT })).toEqual({ ok: true });
    // The CLI door stamps a real clock; only `ts=` may differ between them.
    const bodies = (log: string) => readLines(log).map(line => line.replace(/^ts=\S+ /, ""));
    expect(bodies(inProcess)).toEqual(bodies(door));
    expect(readLines(inProcess)).toHaveLength(1);
    // An explicit limit still wins over the environment.
    writeFileSync(inProcess, "prior one\nprior two\n");
    expect(appendRegistryEvent({ ...fields, log: inProcess, limit: 3, now: AT })).toEqual({ ok: true });
    expect(readLines(inProcess)).toHaveLength(3);
    // An env passed explicitly is the one that governs, not the ambient one.
    writeFileSync(inProcess, "prior one\nprior two\n");
    expect(appendRegistryEvent({ ...fields, log: inProcess, now: AT, env: { TAP_REGISTRY_EVENT_LIMIT: "2" } })).toEqual({ ok: true });
    expect(readLines(inProcess)).toHaveLength(2);
  } finally {
    if (saved === undefined) delete process.env.TAP_REGISTRY_EVENT_LIMIT;
    else process.env.TAP_REGISTRY_EVENT_LIMIT = saved;
  }
});

test("a routed native read --force keeps writing its forced audit through the environment", () => {
  // THE UNIT ARM ABOVE CANNOT SEE THIS. It calls appendRegistryEvent directly,
  // so it proves the writer reads the environment; it says nothing about
  // whether a real verb REACHES the writer with that environment intact. The
  // defect this arm exists for was found end-to-end in review
  // while every unit arm was green, and this fixture is the reviewer's,
  // adopted so the specimen outlives the review.
  // The read door's history length is absolute now: the Bash twin it was once
  // contrasted against was deleted with the verb's closure, and the seeded
  // 300 lines plus the one forced audit are the whole contract.
  const root = join(scratch, "routed"), bus = join(root, ".tap/bus"), index = join(root, "index");
  for (const dir of ["payloads", "receipts", "archive", "spool/digests"]) mkdirSync(join(bus, dir), { recursive: true });
  mkdirSync(index, { recursive: true });
  const registry = join(root, ".tap/team-registry.json"), id = "sender-20260915T080000Z-aaaaaaaaaaaa";
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "spec" }, seats: { reader: { instance: "reader|new", status: "active" }, peer: { instance: "peer|new" } } }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { spec: { root, registry_location: registry, state: "registered" } } }));
  writeFileSync(join(bus, "payloads", `${id}.md`), `---\nid: ${id}\nfrom: sender\nto: peer\nkind: discuss\npath: ${join(bus, "payloads", `${id}.md`)}\nreply: expected\n---\n\nreview body\n`);
  const tree = resolve(import.meta.dir, "../../..");
  const trace = join(root, "route");
  const env = { ...process.env, TAP_HOME: bus, TAP_INDEX_HOME: index, TAP_SELF: "reader", TAP_VERBOSE: "0", TAP_REGISTRY_EVENT_LIMIT: "1000", TAP_BUN_ROUTE_TRACE: trace };
  const log = join(bus, "registry-events.log");
  const seed = Array.from({ length: 300 }, (_, i) => `history-${i}\n`).join("");

  writeFileSync(log, seed);
  const native = spawnSync(process.execPath, [join(tree, "runtime/bun/main.ts"), "read", id, "--force"], { cwd: root, env, encoding: "utf8" });
  expect(native.status).toBe(0);
  // Without this the arm can pass by silently taking the Bash fallback — the
  // very path whose behavior it is supposed to be contrasted against.
  expect(readFileSync(trace, "utf8")).toBe("native read\n");
  const nativeLines = readLines(log);

  expect(nativeLines).toHaveLength(301);
  expect(nativeLines[0]).toBe("history-0");
  expect(nativeLines.at(-1)).toContain("action=read_forced");
}, 30_000);

test("CLI door writes the same bytes as the in-process call and reads the limit from the environment", () => {
  const bus = join(scratch, "bus-e");
  const log = registryEventsPath(bus);
  const inProcess = join(scratch, "bus-e-twin", "registry-events.log");
  const fields = { actor: "courier", action: "redelivery_delivered", handle: "bob", pane: "t/bob:0.0", team: "t", detail: "id=claude-1" };
  const now = new Date();
  expect(appendRegistryEvent({ ...fields, log: inProcess, now })).toEqual({ ok: true });
  const door = cli(["append", log, fields.actor, fields.action, fields.handle, fields.pane, fields.team, fields.detail]);
  expect(door).toEqual({ status: 0, stdout: "", stderr: "" });
  const strip = (line: string) => line.replace(/^ts=\S+ /, "");
  expect(readLines(log).map(strip)).toEqual(readLines(inProcess).map(strip));
  expect(readLines(log)[0]).toMatch(/^ts=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z actor=courier /);

  // Empty detail travels as an empty argument and is omitted from the line.
  expect(cli(["append", log, "a", "b", "c", "", "e", ""]).status).toBe(0);
  expect(readLines(log)[1]).toMatch(/^ts=\S+ actor=a action=b handle=c pane=- team=e$/);

  // TAP_REGISTRY_EVENT_LIMIT is read by the door, as the Bash body read it.
  for (let i = 0; i < 4; i++) expect(cli(["append", log, "a", `n${i}`, "c", "d", "e", ""], { TAP_REGISTRY_EVENT_LIMIT: "3" }).status).toBe(0);
  expect(readLines(log).map(line => line.replace(/^ts=\S+ actor=a action=(\S+).*$/, "$1"))).toEqual(["n1", "n2", "n3"]);
  expect(cli(["append", log, "a", "z", "c", "d", "e", ""], { TAP_REGISTRY_EVENT_LIMIT: "bogus" }).status).toBe(0);
  expect(readLines(log)).toHaveLength(4);
});

test("CLI door refuses a wrong shape with status 2 and reports a failed write with status 1", () => {
  const usage = cli(["append", join(scratch, "x", "registry-events.log"), "a", "b", "c"]);
  expect(usage.status).toBe(2);
  expect(usage.stderr).toContain("expected: append <log>");
  expect(cli(["frob"]).status).toBe(2);
  const dir = join(scratch, "bus-f", "registry-events.log");
  mkdirSync(dir, { recursive: true });
  const failed = cli(["append", dir, "a", "b", "c", "d", "e", ""]);
  expect(failed.status).toBe(1);
  expect(failed.stderr).toContain("registry event append failed: io_error");
  expect(cli(["append", "", "a", "b", "c", "d", "e", ""]).status).toBe(1);
});
