import { afterEach, expect, test } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireObligationLock } from "../src/panelock";
import { describeResendFailure, formatResendResult, ResendReceiptError, resendRecovery } from "../src/resend-format";
import { removeScratchTree } from "./support/scratch";

const root = resolve(import.meta.dir, "../../..");
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) removeScratchTree(dir); });

function fixture(shape: string) {
  const dir = mkdtempSync(join(tmpdir(), "tap-resend-flip."));
  scratch.push(dir);
  const bus = join(dir, ".tap", "bus");
  for (const name of ["spool", "payloads", "receipts", "archive"]) mkdirSync(join(bus, name), { recursive: true });
  // Born live (F1): an unenrolled bus under an empty machine index.
  mkdirSync(join(dir, "index"), { recursive: true });
  writeFileSync(join(dir, "index", "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
  writeFileSync(join(bus, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "t", worktree_root: dir }, seats: {
    alice: { delivery: "poll", status: "active", harness: "codex" },
    peer: { delivery: "poll", status: "active", harness: "codex" },
  } }));
  const original = Buffer.from(`---\nid: original\nfrom: ${shape === "sender" ? "other" : "alice"}\nto: peer\nkind: discuss\nreply: expected\npath: ${bus}/payloads/original.md\n---\nLiteral $() \`body\`\r\n☃\nno final newline`);
  writeFileSync(join(bus, "spool/original.md"), original);
  writeFileSync(join(bus, "spool/original.meta.json"), JSON.stringify({ id: "original", attempts: 0,
    ...(shape === "legacy" ? {} : { attempt_fence: 1 }), reason: "busy" }));
  if (shape === "attempted") writeFileSync(join(bus, "receipts/original.attempted"), "{}");
  if (shape === "claim") writeFileSync(join(bus, "spool/original.claim"), "{}");
  if (shape === "intent") writeFileSync(join(bus, "spool/original.json"), "{}");
  const env = { ...process.env, HOME: dir, TAP_HOME: bus, TAP_INDEX_HOME: join(dir, "index"),
    TAP_LOCK_DIR: join(dir, "locks"), TAP_SESSION_MANIFEST: join(dir, "sessions.json"), TAP_VERSION_SEEN_PATH: join(dir, "version.json"),
    OPENCODE_DB_PATH: join(dir, "opencode.db"), TAP_TMUX_SOCKET_PATH: join(mkdtempSync(join(process.env.TMUX_TMPDIR!, "s.")), "tmux"),
    TAP_SPOOL_DISABLE_OPPORTUNISTIC: "1", TAP_SPOOL_DISABLE_DELIVERER: "1", TAP_SELF: "alice",
  };
  return { dir, bus, original, env };
}

for (const [shape, errorClass] of [
  ["attempted", "delivery_attempted"], ["claim", "delivery_busy"],
  ["intent", "effect_unknown"], ["sender", "not_sender"], ["legacy", "effect_unknown"],
]) {
  test(`resend native refusal preserves original and never prepares a successor: ${shape}`, () => {
    const fx = fixture(shape!);
    const args = ["resend", "original", "--by", "alice", "--json"];
    const run = (native: boolean) => spawnSync(native ? process.execPath : "bash",
      [native ? join(root, "runtime/bun/main.ts") : join(root, "bin/tap"), ...args],
      { cwd: fx.dir, env: { ...fx.env, TAP_BUN_ROUTE_TRACE: join(fx.dir, "route") }, encoding: "utf8", timeout: 15000 });
    const reference = run(false);
    const actual = run(true);
    expect(existsSync(join(fx.bus, "spool/original.md"))).toBe(true);
    expect({ code: actual.status, stdout: actual.stdout, stderr: actual.stderr })
      .toEqual({ code: reference.status, stdout: reference.stdout, stderr: reference.stderr });
    expect(actual.status).toBe(1);
    expect(JSON.parse(actual.stdout).error_class).toBe(errorClass);
    expect(readFileSync(join(fx.bus, "spool/original.md"))).toEqual(fx.original);
    expect(existsSync(join(fx.bus, "receipts/original.resent"))).toBe(false);
    expect(existsSync(join(fx.bus, "archive/original.cancelled.md"))).toBe(false);
    // Public-entry parity alone is false evidence while resend delegates.
    expect(readFileSync(join(fx.dir, "route"), "utf8")).toBe("native resend\nnative resend\n");
  });
}

for (const shape of ["dynamic", "static", "reply-to", "failed-successor", "native", "busy-native"]) {
  test(`resend invokes only the prepared successor once: ${shape}`, () => {
    const fx = fixture("success");
    const originalPath = join(fx.bus, "spool/original.md");
    if (shape === "static") writeFileSync(originalPath, fx.original.toString().replace("reply: expected", "reply: settle-only"));
    if (shape === "reply-to") writeFileSync(originalPath, fx.original.toString().replace("reply: expected", "reply: expected\nreply_to: peer\nin_reply_to: earlier"));
    if (shape === "failed-successor") writeFileSync(originalPath, fx.original.toString().replace("to: peer", "to: missing"));
    const original = readFileSync(originalPath);
    const bin = join(fx.dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "bash"), `#!/bin/sh\nprintf '%s\\n' "$1" >> "$RESEND_SPAWN_LOG"\nexec /bin/bash "$@"\n`, { mode: 0o755 });
    if (["native", "busy-native"].includes(shape)) {
      writeFileSync(join(fx.env.TAP_INDEX_HOME, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { t: { root: fx.dir, registry_location: join(fx.bus, "registry.json"), state: "registered" } } }));
      const registryPath = join(fx.bus, "registry.json");
      const registry = JSON.parse(readFileSync(registryPath, "utf8"));
      registry.seats.alice = { status: "active", harness: "claude", pane: "alice:0.0", pane_id: "%6", server_epoch: "srv:123:456" };
      if (shape === "busy-native") registry.seats.peer = { status: "active", harness: "claude", pane: "peer:0.0", pane_id: "%7", server_epoch: "srv:123:456" };
      writeFileSync(registryPath, JSON.stringify(registry));
      writeFileSync(join(bin, "tmux"), `#!/usr/bin/env python3
import sys
if "capture-pane" in sys.argv:
    print("› existing human draft")
    print("─" * 42)
    sys.exit(0)
peer = any("peer" in arg or arg == "%7" for arg in sys.argv)
fmt = sys.argv[-1]
values = {"pane_id": "%7" if peer else "%6", "session_name": "peer" if peer else "alice", "pane_pid": "4242", "pane_current_command": "claude", "pid": "123", "start_time": "456", "pane_in_mode": "0", "pane_dead": "0"}
if "#{" not in fmt: sys.exit(1)
for key, value in values.items(): fmt = fmt.replace("#{" + key + "}", value)
if "#{" in fmt: sys.exit(1)
print(fmt)
`, { mode: 0o755 });
    }
    const env = { ...fx.env, PATH: `${bin}:${process.env.PATH}`, RESEND_SPAWN_LOG: join(fx.dir, "spawns"), TAP_BUN_ROUTE_TRACE: join(fx.dir, "route") };
    // A permissive umask: a 0o666 open would surface as 0o666 here, where the
    // usual 022 would mask it to 0o644 and still hide a world-readable intent.
    const priorUmask = process.umask(0);
    let result: SpawnSyncReturns<string>;
    try {
      result = spawnSync(process.execPath, [join(root, "runtime/bun/main.ts"), "resend", "original", "--by", "alice", "--json"],
        { cwd: fx.dir, env, encoding: "utf8", timeout: 15000 });
    } finally { process.umask(priorUmask); }
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toMatchObject({ status: shape === "failed-successor" ? 1 : 0 });
    const consumed = JSON.parse(readFileSync(join(fx.bus, "receipts/original.resent"), "utf8"));
    // Bus files are private, as fsatomic.atomicWrite writes them (0o600).
    for (const path of [join(fx.bus, "receipts/original.resent"), consumed.prepared, join(fx.bus, "archive/original.cancelled.md")]) {
      expect({ path, mode: statSync(path).mode & 0o777 }).toEqual({ path, mode: 0o600 });
    }
    expect(readFileSync(join(fx.bus, "archive/original.cancelled.md"))).toEqual(original);
    expect(existsSync(originalPath)).toBe(false);
    expect(existsSync(join(fx.bus, "spool/original.meta.json"))).toBe(false);
    const sends = (existsSync(join(fx.dir, "spawns")) ? readFileSync(join(fx.dir, "spawns"), "utf8") : "").split("\n").filter(path => path.endsWith("/tap-send.sh"));
    expect(readFileSync(join(fx.dir, "route"), "utf8")).toBe("native resend\n");
    if (shape === "busy-native") {
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ id: consumed.resend_id, status: "queued", delivery: "spool" });
      expect(existsSync(join(fx.bus, "spool", `${consumed.resend_id}.md`))).toBe(true);
      const meta = JSON.parse(readFileSync(join(fx.bus, "spool", `${consumed.resend_id}.meta.json`), "utf8"));
      expect(meta.attempts).toBe(0);
      expect(meta.attempt_fence).toBe(1);
      const parked = readFileSync(join(fx.bus, "spool", `${consumed.resend_id}.md`), "utf8");
      expect(parked.split("---\n").slice(2).join("---\n")).toBe(original.toString().split("---\n").slice(2).join("---\n"));
      expect(existsSync(join(fx.bus, "receipts", `${consumed.resend_id}.attempted`))).toBe(false);
      expect(existsSync(join(fx.bus, "payloads", `${consumed.resend_id}.md`))).toBe(false);
    } else if (shape === "failed-successor") {
      expect(result.status).not.toBe(0);
      expect(existsSync(join(fx.bus, "payloads", `${consumed.resend_id}.md`))).toBe(false);
    } else {
      expect(existsSync(join(fx.bus, "payloads", `${consumed.resend_id}.md`))).toBe(true);
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({ id: consumed.resend_id, resend_of: "original", delivery_semantics: "at-least-once" });
      const successor = readFileSync(join(fx.bus, "payloads", `${consumed.resend_id}.md`), "utf8");
      expect(successor.split("---\n").slice(2).join("---\n")).toBe(original.toString().split("---\n").slice(2).join("---\n"));
      expect(successor).toContain("resend_of: original\n");
    }
    // Every successor argv is native; no shape reaches tap-send.sh.
    expect(sends).toHaveLength(0);
    const again = spawnSync("bash", [join(root, "bin/tap"), "resend", "original", "--by", "alice", "--json"],
      { cwd: fx.dir, env, encoding: "utf8", timeout: 15000 });
    expect(again.status).toBe(1);
    expect(JSON.parse(again.stdout).error_class).toBe("already_resent");
  });
}


test("an external obligation holder refuses both resend doors before withdrawal", () => {
  const fx = fixture("success");
  Object.assign(fx.env, { TAP_RESEND_PREPARE_ONLY: "1" });
  const lock = acquireObligationLock("original", 5000, fx.env);
  expect(lock).not.toBeNull();
  try {
    const args = ["resend", "original", "--by", "alice", "--json"];
    const run = (native: boolean) => spawnSync(native ? process.execPath : "bash",
      [native ? join(root, "runtime/bun/main.ts") : join(root, "bin/tap"), ...args],
      { cwd: fx.dir, env: fx.env, encoding: "utf8", timeout: 15000 });
    const reference = run(false);
    const actual = run(true);
    expect({ status: actual.status, stdout: actual.stdout, stderr: actual.stderr })
      .toEqual({ status: reference.status, stdout: reference.stdout, stderr: reference.stderr });
    expect(actual.status).toBe(1);
    expect(JSON.parse(actual.stdout).error_class).toBe("obligation_busy");
    expect(readFileSync(join(fx.bus, "spool/original.md"))).toEqual(fx.original);
    expect(existsSync(join(fx.bus, "receipts/original.resent"))).toBe(false);
  } finally { lock?.release(); }
}, 20000);


test("inherited prepare-only environment cannot change public Bash resend", () => {
  const results = [false, true].map(exported => {
    const fx = fixture("success");
    const env = { ...fx.env, ...(exported ? { TAP_RESEND_PREPARE_ONLY: "1" } : {}) };
    if (!exported) delete (env as NodeJS.ProcessEnv).TAP_RESEND_PREPARE_ONLY;
    const result = spawnSync("bash", [join(root, "bin/tap"), "resend", "original", "--by", "alice", "--json"],
      { cwd: fx.dir, env, encoding: "utf8", timeout: 15000 });
    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(existsSync(join(fx.bus, "payloads", `${receipt.id}.md`))).toBe(true);
    expect(receipt.resend_of).toBe("original");
    return { status: result.status, stderr: result.stderr,
      stdout: result.stdout.replaceAll(fx.dir, "<root>").replaceAll(receipt.id, "<id>") };
  });
  expect(results[1]).toEqual(results[0]);
});


test("both resend doors emit the same normalized success receipt", () => {
  const results = [false, true].map(native => {
    const fx = fixture("success");
    const result = spawnSync(native ? process.execPath : "bash",
      [native ? join(root, "runtime/bun/main.ts") : join(root, "bin/tap"),
        "resend", "original", "--by", "alice", "--json"],
      { cwd: fx.dir, env: fx.env, encoding: "utf8", timeout: 15000 });
    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(existsSync(join(fx.bus, "payloads", `${receipt.id}.md`))).toBe(true);
    return { status: result.status, stderr: result.stderr,
      stdout: result.stdout.replaceAll(fx.dir, "<root>").replaceAll(receipt.id, "<id>") };
  });
  expect(results[1]).toEqual(results[0]);
});


test("public Bash argv cannot select preparation under another obligation holder", () => {
  const fx = fixture("success");
  const lock = acquireObligationLock("original", 5000, fx.env);
  expect(lock).not.toBeNull();
  try {
    const result = spawnSync("bash", [join(root, "bin/tap"),
      "resend", "--prepare-only", "original", "alice", "1"],
      { cwd: fx.dir, env: fx.env, encoding: "utf8", timeout: 15000 });
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toMatchObject({ status: 1 });
    expect(readFileSync(join(fx.bus, "spool/original.md"))).toEqual(fx.original);
    expect(existsSync(join(fx.bus, "receipts/original.resent"))).toBe(false);
    expect(existsSync(join(fx.bus, "archive/original.cancelled.md"))).toBe(false);
  } finally { lock?.release(); }
});

// Frozen formatter oracle: compare output bytes and exit status, independently
// of the shared adapter now used by both public resend doors.
const oldFormatter = `import json, os, sys
output = sys.stdin.buffer.read()
ident, new_id, json_mode, returncode = sys.argv[1:]
returncode = int(returncode)
try:
    receipt = json.loads(output)
except ValueError:
    sys.stdout.buffer.write(output)
else:
    receipt.update(resend_of=ident, delivery_semantics="at-least-once")
    if json_mode == "1":
        print(json.dumps(receipt))
    elif returncode == 0 and os.environ.get("TAP_VERBOSE") != "1":
        status = "queued" if receipt.get("status") == "queued" else "ok"
        print(f"tap resend: {status} {new_id}")
    else:
        print(f"tap resend: RESEND {new_id} from {ident}; explicit at-least-once; {receipt.get('status', 'unconfirmed')}")
sys.exit(returncode)
`;

for (const [name, bytes, code, json, verbose] of [
  ["raw", Buffer.from([0xff, 0x00, 0x0d, 0x0a, 0x41]), 19, false, false],
  ["empty", Buffer.alloc(0), 23, true, false],
  ["queued", Buffer.from('{"status":"queued"}'), 0, false, false],
  ["success", Buffer.from('{"status":"ok"}'), 0, false, false],
  ["verbose", Buffer.from('{"status":"queued"}'), 0, false, true],
  ["error", Buffer.from('{"status":"refused","error_class":"not_found"}'), 7, false, false],
  ["unconfirmed", Buffer.from('{}'), 5, false, false],
  ["json provenance", Buffer.from(JSON.stringify({ status: "ok", id: "successor", detail: '☃😀\u007f, : "quoted"',
    resend_of: "wrong", nested: { value: [1, true, null] } })), 4, true, true],
] as const) {
  test(`resend formatter preserves incumbent output and status: ${name}`, () => {
    const env = { ...process.env, TAP_VERBOSE: verbose ? "1" : "0" };
    const args = ["original", "successor", json ? "1" : "0", String(code)];
    const reference = spawnSync("python3", ["-c", oldFormatter, ...args], { input: bytes, env });
    for (const [command, prefix] of [
      [process.execPath, [join(root, "runtime/bun/src/resend-format.ts")]],
    ] as const) {
      const actual = spawnSync(command, [...prefix, ...args], { input: bytes, env });
      expect({ code: actual.status, stdout: actual.stdout, stderr: actual.stderr })
        .toEqual({ code: reference.status, stdout: reference.stdout, stderr: reference.stderr });
    }
  });
}

test("an unanchored team-qualified successor refuses natively; no Bash send or Python formatter runs", () => {
  const fx = fixture("success");
  const scripts = join(fx.dir, "scripts");
  mkdirSync(scripts);
  // Every stub below would mark its own execution: the Bash send body is
  // retired (cut sprint E), so the successor must not reach any of them.
  writeFileSync(join(scripts, "tap-send.sh"), 'echo "unexpected Bash send"\nexit 37\n');
  writeFileSync(join(fx.bus, "spool/original.md"), fx.original.toString().replace("to: peer", "to: peer\nto_team: team"));
  writeFileSync(join(scripts, "tap-resend.sh"), 'exit 99\n');
  writeFileSync(join(scripts, "resend.py"), 'raise SystemExit("unexpected Python formatter")\n');
  const entry = join(fx.dir, "entry.ts");
  writeFileSync(entry, `import { cmdResend } from ${JSON.stringify(join(root, "runtime/bun/src/verbs/resend.ts"))};\nimport { runNative } from ${JSON.stringify(join(root, "runtime/bun/main.ts"))};\nprocess.exitCode = runNative("resend", (argv) => cmdResend(argv, ${JSON.stringify(scripts)}), ["original", "--by", "alice"]);\n`);
  const result = spawnSync(process.execPath, [entry], { cwd: fx.dir, env: fx.env, encoding: "utf8", timeout: 15000 });
  const out = result.stdout + result.stderr;
  // A failed successor is one diagnostic line through the router's own error rendering.
  expect(result.status).toBe(1);
  expect(out).toMatch(/^tap resend: .*the successor send failed \(exit 1\).*; next: /);
  expect(out).not.toContain("unexpected Bash send");
  expect(out).not.toContain("unexpected Python formatter");
}, 20000);

test("native resend formatter passes non-JSON successor bytes through untouched", () => {
  // The successor is native send now (no Bash delegation to inject bytes), so
  // the formatter's raw passthrough is pinned at its own seam.
  const raw = Buffer.from([0xff, 0x00, 0x0d, 0x0a, 0x41]);
  expect(Buffer.from(formatResendResult(raw, 37, "original", "new-id", false))).toEqual(raw);
  expect(Buffer.from(formatResendResult(raw, 37, "original", "new-id", true))).toEqual(raw);
});

// tap-7r3fn.89: a failed successor is loud about what the consumed original left behind.
for (const json of [false, true]) {
  test(`a failed successor prints one recovery line naming the original, its receipt, the prepared successor and an inspection step, keeps its exit code, and never re-sends (${json ? "--json" : "text"})`, () => {
    const fx = fixture("success");
    const originalPath = join(fx.bus, "spool/original.md");
    writeFileSync(originalPath, fx.original.toString().replace("to: peer", "to: missing"));
    const args = ["resend", "original", "--by", "alice", ...(json ? ["--json"] : [])];
    const run = () => spawnSync(process.execPath, [join(root, "runtime/bun/main.ts"), ...args],
      { cwd: fx.dir, env: { ...fx.env, TAP_BUN_ROUTE_TRACE: join(fx.dir, "route") }, encoding: "utf8", timeout: 15000 });
    const result = run();
    expect(result.status).toBe(1);
    const consumed = JSON.parse(readFileSync(join(fx.bus, "receipts/original.resent"), "utf8"));
    const preparedName = `archive/${consumed.resend_id}.resend.md`;
    // Text mode: exactly one recovery line on stderr. --json: stderr stays empty (one object on stdout).
    if (json) {
      expect(result.stderr).toBe("");
    } else {
      const recoveryLines = result.stderr.split("\n").filter((line) => line.includes("the successor send failed"));
      expect(recoveryLines).toHaveLength(1);
      expect(recoveryLines[0]).toContain("original original is already withdrawn");
      expect(recoveryLines[0]).toContain("receipts/original.resent");
      expect(recoveryLines[0]).toContain(preparedName);
      // The next step is inspection of the successor, never a send (exit 5 or a signalled child may have taken effect).
      expect(recoveryLines[0]).toContain(`tap show ${consumed.resend_id}`);
      expect(recoveryLines[0]).toMatch(/^tap resend: .*; next: /);
      expect(recoveryLines[0]).not.toContain("tap send");
    }
    if (json) {
      // The same facts ride in the JSON receipt, not as prose on stdout.
      const body = JSON.parse(result.stdout);
      expect(body.recovery).toEqual({ original: "original", receipt: "receipts/original.resent", prepared: preparedName, successor: consumed.resend_id, next: `TAP_HOME='${realpathSync(fx.bus)}' tap show ${consumed.resend_id}` });
      expect(body).toMatchObject({ ok: false, error_class: "resend_successor_failed" });
      expect(result.stdout).not.toContain("tap send");
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
    } else {
      expect(result.stdout).not.toContain("to finish by hand");
    }
    // The original stays withdrawn and the successor was prepared once, never re-sent.
    expect(existsSync(originalPath)).toBe(false);
    expect(existsSync(join(fx.bus, preparedName))).toBe(true);
    expect(readdirSync(join(fx.bus, "payloads"))).toEqual([]);
    expect(readdirSync(join(fx.bus, "archive")).filter((name) => name.endsWith(".resend.md"))).toEqual([`${consumed.resend_id}.resend.md`]);
    const again = run();
    expect(JSON.parse(again.stdout || "{}").error_class ?? again.stderr).toMatch(/already_resent/);
    expect(readFileSync(join(fx.dir, "route"), "utf8").split("\n").filter(Boolean).filter((line) => line !== "native resend")).toEqual([]);
    expect(readdirSync(join(fx.bus, "archive")).filter((name) => name.endsWith(".resend.md"))).toEqual([`${consumed.resend_id}.resend.md`]);
  }, 30000);
}

// Exit 5 means the successor may have taken effect: text and JSON both point at inspection, never a send.
for (const code of [1, 5]) {
  test(`recovery for successor exit ${code} recommends inspection only, in text and in JSON (tap-7r3fn.89)`, () => {
    const { detail, facts } = resendRecovery("original", "alice-new", code);
    expect(detail).toContain(`(exit ${code})`);
    expect(detail).toContain("original is already withdrawn (receipts/original.resent)");
    expect(detail).toContain("archive/alice-new.resend.md");
    expect(detail).not.toContain("tap send");
    expect(facts.next).toBe("tap show alice-new");
    const view = describeResendFailure(Buffer.from('{"status":"unconfirmed"}'), Buffer.alloc(0), code, "original", "alice-new");
    expect(view.body.recovery).toEqual({ original: "original", receipt: "receipts/original.resent", prepared: "archive/alice-new.resend.md", successor: "alice-new", next: "tap show alice-new" });
    expect(JSON.stringify(view.body)).not.toContain("tap send");
  });
}

test("recovery inspection is team-qualified when resend ran with --team (tap-7r3fn.89)", () => {
  expect(resendRecovery("original", "alice-new", 5, { team: "beta" }).facts.next).toBe("tap show beta/alice-new");
  expect(resendRecovery("original", "alice-new", 5).facts.next).toBe("tap show alice-new");
  // A pinned bus wins over any team, and is quoted so the advised command is shell-safe.
  expect(resendRecovery("original", "alice-new", 5, { team: "beta", pin: "/tmp/it's a bus" }).facts.next).toBe(`TAP_HOME='/tmp/it'"'"'s a bus' tap show alice-new`);
});

// Wrapper level, through the router's own error rendering: the successor exits nonzero and prints a
// JSON primitive. One diagnostic, a runnable `next:` action, and the successor's own exit status.
for (const json of [false, true]) {
  test(`a malformed receipt from a failed successor is one diagnostic that keeps exit 5 (${json ? "--json" : "text"}) (tap-7r3fn.89)`, () => {
    const fx = fixture("success");
    const entry = join(fx.dir, "malformed-entry.ts");
    writeFileSync(entry, `const cp = require("node:child_process");
const real = cp.spawnSync;
cp.spawnSync = (command, args, options) => Array.isArray(args) && String(args[0]).endsWith("resend-successor.ts")
  ? { status: 5, stdout: Buffer.from("[1,2]"), stderr: Buffer.alloc(0) }
  : real(command, args, options);
const { cmdResend } = await import(${JSON.stringify(join(root, "runtime/bun/src/verbs/resend.ts"))});
const { runNative } = await import(${JSON.stringify(join(root, "runtime/bun/main.ts"))});
process.exitCode = runNative("resend", (argv) => cmdResend(argv, ${JSON.stringify(join(fx.dir, "scripts"))}), ["original", "--by", "alice"${json ? ', "--json"' : ""}]);
`);
    const result = spawnSync(process.execPath, [entry], { cwd: fx.dir, env: fx.env, encoding: "utf8", timeout: 15000 });
    expect(result.status).toBe(5);
    const consumed = JSON.parse(readFileSync(join(fx.bus, "receipts/original.resent"), "utf8"));
    if (json) {
      expect(result.stderr).toBe("");
      const body = JSON.parse(result.stdout.trim());
      expect(body).toMatchObject({ ok: false, error_class: "resend_receipt_invalid", action: `TAP_HOME='${realpathSync(fx.bus)}' tap show ${consumed.resend_id}` });
      expect(body.detail).toContain("the successor send failed (exit 5)");
    } else {
      const lines = result.stderr.split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("JSON object receipt was expected");
      expect(lines[0]).toContain("the successor send failed (exit 5)");
      expect(lines[0]).toContain(`next: TAP_HOME='${realpathSync(fx.bus)}' tap show ${consumed.resend_id}`);
      expect(lines[0]).not.toContain("(inspect");
    }
  }, 30000);
}

// The pinned bus wins over --team, so the advised inspection names the team actually selected
// and the raw --team text (which the pin leaves unvalidated) never reaches the output.
for (const [name, status, stdout] of [["recovery line", 1, ""], ["receipt refusal", 5, "[1,2]"]] as const) {
  test(`a pinned bus with a different hostile --team: the ${name} names the selected bus, never the raw --team text (tap-7r3fn.89)`, () => {
    const fx = fixture("success");
    const hostile = "beta;$(touch pwned)";
    const entry = join(fx.dir, "pinned-entry.ts");
    writeFileSync(entry, `const cp = require("node:child_process");
const real = cp.spawnSync;
cp.spawnSync = (command, args, options) => Array.isArray(args) && String(args[0]).endsWith("resend-successor.ts")
  ? { status: ${status}, stdout: Buffer.from(${JSON.stringify(stdout)}), stderr: Buffer.alloc(0) }
  : real(command, args, options);
const { cmdResend } = await import(${JSON.stringify(join(root, "runtime/bun/src/verbs/resend.ts"))});
const { runNative } = await import(${JSON.stringify(join(root, "runtime/bun/main.ts"))});
process.exitCode = runNative("resend", (argv) => cmdResend(argv, ${JSON.stringify(join(fx.dir, "scripts"))}), ["original", "--by", "alice", "--team", ${JSON.stringify(hostile)}]);
`);
    // fx.env pins TAP_HOME to the bus of team "t"; --team names a different, hostile value.
    const result = spawnSync(process.execPath, [entry], { cwd: fx.dir, env: fx.env, encoding: "utf8", timeout: 15000 });
    expect(result.status).toBe(status);
    const consumed = JSON.parse(readFileSync(join(fx.bus, "receipts/original.resent"), "utf8"));
    const output = result.stdout + result.stderr;
    expect(output).not.toContain("beta");
    expect(output).not.toContain("touch pwned");
    expect(output).toContain(`TAP_HOME='${realpathSync(fx.bus)}' tap show ${consumed.resend_id}`);
    expect(existsSync(join(fx.dir, "pwned"))).toBe(false);
  }, 30000);
}

// A failed successor never takes the receipt formatter: describeResendFailure is the one path (tap-e0i3z).
test("describeResendFailure folds a receipt object, a scalar, and no stdout into one envelope each (tap-e0i3z)", () => {
  const none = Buffer.alloc(0);
  const refused = describeResendFailure(Buffer.from('{"status":"refused","error_class":"not_found","detail":"no such seat","ok":true,"action":"x"}'), Buffer.from("warn\n"), 1, "original", "alice-new");
  expect(refused.errorClass).toBe("resend_successor_failed");
  expect(refused.detail).toContain("not_found: no such seat: warn;");
  expect(refused.body).toMatchObject({ ok: false, error_class: "resend_successor_failed", action: "tap show alice-new", status: "refused", resend_of: "original" });
  expect(describeResendFailure(Buffer.from("3"), none, 5, "original", "alice-new").errorClass).toBe("resend_receipt_invalid");
  for (const bytes of [none, Buffer.from("segfault\n"), Buffer.from([0xff, 0x00, 0x41])]) {
    const view = describeResendFailure(bytes, none, 1, "original", "alice-new");
    expect(view.errorClass).toBe("resend_successor_failed");
    expect(view.detail).toContain("printed no JSON receipt");
    expect(view.body.recovery).toMatchObject({ successor: "alice-new" });
  }
  // The child's stderr is bounded and flattened to one line.
  expect(describeResendFailure(none, Buffer.from(`a\nb\n${"x".repeat(900)}`), 1, "original", "alice-new").detail).not.toContain("\n");
  // The formatter stays the success path: raw non-JSON bytes still pass through untouched.
  const raw = Buffer.from([0xff, 0x00, 0x41]);
  expect(Buffer.from(formatResendResult(raw, 0, "original", "alice-new", true))).toEqual(raw);
});

test("a non-object successor receipt is a labelled refusal, not a TypeError (tap-7r3fn.89)", () => {
  for (const bytes of ["[1,2]", "null", "3", '"text"']) {
    let caught: unknown;
    try { formatResendResult(Buffer.from(bytes), 0, "original", "new-id", false); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ResendReceiptError);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as ResendReceiptError).errorClass).toBe("resend_receipt_invalid");
    expect((caught as ResendReceiptError).message).toContain("JSON object receipt was expected");
  }
});

// tap-e0i3z: every failed successor leaves through ONE error path (docs/CLI-STANDARDS.md CLI-ERR-1/2/3/4).
// The real child cannot be made to crash on demand, so the entry swaps the spawn for a fake that does,
// keeping prepare, consume and the router's own error rendering real.
function failedSuccessorRun(fx: ReturnType<typeof fixture>, spawned: { status: number | null; stdout: Buffer; stderr: Buffer; signal?: string; error?: string }, args: string[], env = fx.env) {
  const entry = join(fx.dir, `failed-entry-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(entry, `const cp = require("node:child_process");
const real = cp.spawnSync;
const spawned = { status: ${JSON.stringify(spawned.status)}, signal: ${JSON.stringify(spawned.signal ?? null)}, error: ${spawned.error ? `new Error(${JSON.stringify(spawned.error)})` : "undefined"}, stdout: Buffer.from(${JSON.stringify(spawned.stdout.toString("latin1"))}, "latin1"), stderr: Buffer.from(${JSON.stringify(spawned.stderr.toString("latin1"))}, "latin1") };
cp.spawnSync = (command, args, options) => Array.isArray(args) && String(args[0]).endsWith("resend-successor.ts") ? spawned : real(command, args, options);
const { cmdResend } = await import(${JSON.stringify(join(root, "runtime/bun/src/verbs/resend.ts"))});
const { runNative } = await import(${JSON.stringify(join(root, "runtime/bun/main.ts"))});
process.exitCode = runNative("resend", (argv) => cmdResend(argv, ${JSON.stringify(join(fx.dir, "scripts"))}), ${JSON.stringify(args)});
`);
  const result = spawnSync(process.execPath, [entry], { cwd: fx.dir, env, encoding: "utf8", timeout: 15000 });
  const consumed = JSON.parse(readFileSync(join(fx.bus, "receipts/original.resent"), "utf8"));
  return { result, consumed };
}

// Refinement 1: a scalar, array or null receipt from a failed successor still carries the recovery facts.
for (const bytes of ["[1,2]", "null", "3"]) {
  test(`--json: a failed successor printing ${bytes} gets the standard envelope with the recovery facts (tap-e0i3z.1)`, () => {
    const fx = fixture("success");
    const { result, consumed } = failedSuccessorRun(fx, { status: 5, stdout: Buffer.from(bytes), stderr: Buffer.alloc(0) }, ["original", "--by", "alice", "--json"]);
    expect(result.status).toBe(5);
    expect(result.stderr).toBe("");
    const body = JSON.parse(result.stdout.trim());
    expect(body).toMatchObject({ ok: false, error_class: "resend_receipt_invalid", action: `TAP_HOME='${realpathSync(fx.bus)}' tap show ${consumed.resend_id}`, resend_of: "original" });
    expect(body.recovery).toEqual({ original: "original", receipt: "receipts/original.resent", prepared: `archive/${consumed.resend_id}.resend.md`, successor: consumed.resend_id, next: body.action });
  }, 30000);
}

// Refinement 2: a crashed successor with empty or non-JSON stdout is the same envelope, naming the crash cause.
for (const stdout of ["", "segfault\n"]) {
  test(`--json: a crashed successor with stdout ${JSON.stringify(stdout)} gets ok:false, error_class, action, the cause and recovery (tap-e0i3z.2)`, () => {
    const fx = fixture("success");
    const { result, consumed } = failedSuccessorRun(fx, { status: 1, stdout: Buffer.from(stdout), stderr: Buffer.from("boom: successor crashed\n") }, ["original", "--by", "alice", "--json"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    const body = JSON.parse(result.stdout.trim());
    expect(body).toMatchObject({ ok: false, error_class: "resend_successor_failed", action: `TAP_HOME='${realpathSync(fx.bus)}' tap show ${consumed.resend_id}`, resend_of: "original" });
    expect(body.detail).toContain("boom: successor crashed");
    expect(body.detail).toContain("exit 1");
    expect(body.recovery.successor).toBe(consumed.resend_id);
    expect(body).not.toHaveProperty("status");
    expect(result.stdout).not.toContain("tap send");
  }, 30000);
}

// Refinement 3: text mode is exactly one diagnostic line, with the child's stderr cause folded into it.
test("text: a crashed successor with multi-line stderr is one diagnostic line carrying the cause and one inspection step (tap-e0i3z.3)", () => {
  const fx = fixture("success");
  const { result, consumed } = failedSuccessorRun(fx, { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("boom: successor crashed\n  at send.ts:12\n") }, ["original", "--by", "alice"]);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  const lines = result.stderr.split("\n").filter(Boolean);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^tap resend: /);
  expect(lines[0]).toContain("boom: successor crashed");
  expect(lines[0]).toContain("at send.ts:12");
  expect(lines[0]).toContain("original original is already withdrawn");
  expect(lines[0]!.endsWith(`; next: TAP_HOME='${realpathSync(fx.bus)}' tap show ${consumed.resend_id}`)).toBe(true);
  expect(lines[0]).not.toContain("tap send");
}, 30000);

// Refinement 4: the inspection action names the bus actually selected, so it resolves once a command-scoped pin is gone.
test("a command-scoped TAP_HOME pin from an unenrolled cwd without --team: the action carries the selected bus, and it resolves unpinned (tap-e0i3z.4)", () => {
  const fx = fixture("success");
  const { result, consumed } = failedSuccessorRun(fx, { status: 5, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, ["original", "--by", "alice", "--json"]);
  const body = JSON.parse(result.stdout.trim());
  expect(body.action).toBe(`TAP_HOME='${realpathSync(fx.bus)}' tap show ${consumed.resend_id}`);
  expect(body.recovery.next).toBe(body.action);
  // Exit 5 may have taken effect: put the successor's payload on the bus, then run the advised command
  // the way an operator would, with the pin only on the command itself and the original pin gone.
  const prepared = readFileSync(join(fx.bus, body.recovery.prepared), "utf8");
  writeFileSync(join(fx.bus, "payloads", `${consumed.resend_id}.md`), prepared);
  const { TAP_HOME: _pin, ...unpinned } = fx.env;
  const elsewhere = mkdtempSync(join(tmpdir(), "tap-resend-elsewhere."));
  scratch.push(elsewhere);
  const show = (command: string) => spawnSync("sh", ["-c", command.replace(/^((?:TAP_HOME='[^']+' )?)tap /, `$1${process.execPath} ${join(root, "runtime/bun/main.ts")} `)],
    { cwd: elsewhere, env: unpinned, encoding: "utf8", timeout: 15000 });
  const advised = show(body.action);
  expect({ status: advised.status, stderr: advised.stderr }).toEqual({ status: 0, stderr: "" });
  expect(advised.stdout).toContain(`resend_of: original`);
  // Control: from a fresh unenrolled cwd the bare command (the pre-fix action) cannot resolve the standalone bus.
  expect(show(`tap show ${consumed.resend_id}`).status).not.toBe(0);
}, 30000);

// tap-e0i3z round 1: a child that died without status or stderr keeps its cause (signal or spawn error), exit status unchanged.
for (const [name, spawned, cause] of [
  ["a signal", { status: null, signal: "SIGKILL", stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, "killed by SIGKILL"],
  ["a spawn error", { status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: "spawn ENOMEM" }, "could not run: spawn ENOMEM"],
] as const) {
  for (const json of [false, true]) {
    test(`a successor that died by ${name} folds the cause into the one diagnostic and keeps exit 1 (${json ? "--json" : "text"}) (tap-e0i3z.2)`, () => {
      const fx = fixture("success");
      const { result } = failedSuccessorRun(fx, spawned, ["original", "--by", "alice", ...(json ? ["--json"] : [])]);
      expect(result.status).toBe(1);
      const text = json ? JSON.parse(result.stdout.trim()).detail : result.stderr.trim();
      expect(json ? result.stderr : result.stdout).toBe("");
      expect(text.split("\n")).toHaveLength(1);
      expect(text).toContain(cause);
      expect(text).toContain("(exit 1)");
    }, 30000);
  }
}

test("a carried receipt cause is flattened to one line in the JSON envelope (tap-e0i3z)", () => {
  const output = Buffer.from(JSON.stringify({ error_class: "not_found", detail: "line one\nline two\r\n" }));
  const view = describeResendFailure(output, Buffer.alloc(0), 1, "original", "alice-new");
  expect(view.detail).toContain("not_found: line one / line two;");
  expect(JSON.stringify(view.body)).not.toContain("\\n");
  expect(view.body.recovery).toMatchObject({ successor: "alice-new" });
});

// tap-e0i3z round 2: a SUCCESSFUL successor's stderr warnings (an ask downgraded, evidence not recorded) still reach the operator in text mode.
for (const json of [false, true]) {
  test(`a successful successor's stderr warning is forwarded in text mode and kept off stderr under --json (${json ? "--json" : "text"}) (tap-e0i3z)`, () => {
    const fx = fixture("success");
    const { result } = failedSuccessorRun(fx, { status: 0, stdout: Buffer.from('{"status":"queued"}'), stderr: Buffer.from("tap send: warning: ask downgraded to note\n") }, ["original", "--by", "alice", ...(json ? ["--json"] : [])]);
    expect(result.status).toBe(0);
    if (json) {
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout.trim())).toMatchObject({ status: "queued", resend_of: "original" });
    } else {
      expect(result.stderr).toBe("tap send: warning: ask downgraded to note\n");
      expect(result.stdout).toMatch(/^tap resend: queued \S+\n$/);
    }
  }, 30000);
}
