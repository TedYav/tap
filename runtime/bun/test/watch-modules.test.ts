// The W1 modules the verb layer and the Bash tick share, at their own seams:
// the locked per-handle mutator T's teardown/restore call (tap-nlxce), the
// notice/NOTIFY path, the registry reads, and the sidecar lifecycle's `tap remind`
// reuse rule. The watch-verbs replay components cover verb-level byte parity;
// these pin what the oracle corpus cannot reach from the public door.

import { afterEach, expect, mock, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { disarm, fieldValue, isFile, itemLines, pruneHandle, publish, pyDumpSorted, readLoose, restoreHandle, set as leaseSet } from "../src/watch-lease";
import { approvalNoticeOrNotify, noticeOrNotify, notifyHuman, notifyPending, renderNotice, sendNotice, sendNoticeReceipt } from "../src/watch-notice";
import { registryPanes, repoRoot } from "../src/watch-registry";
import { remindersEntry } from "../src/watch-sidecar";
import { cmdWatch } from "../src/verbs/watch";
import { removeScratchTree } from "./support/scratch";
import { clearCourier, standInCourier } from "./support/courier";

const roots: string[] = [];
afterEach(() => { clearCourier(); for (const r of roots.splice(0)) removeScratchTree(r); });
function scratch(): string {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "watch-modules."));
  roots.push(root);
  return root;
}
const LEASE = join(import.meta.dir, "../src/watch-lease.ts");

// --- the T mutator: prune-handle / restore-handle -----------------------------------------

test("prune moves one handle's slice out of an OBJECT bucket under the lock and restore merges it back", () => {
  const root = scratch();
  const arm = join(root, "watch", "arm.json");
  const slices = join(root, "archive", "watch");
  mkdirSync(join(root, "watch"), { recursive: true });
  // written as text: a JS number literal would already be 9007199254740992 before the mutator saw it
  writeFileSync(arm, '{"armed_by":"owner","blocked_map":{"alice":{"reason":"session_limit","since":5},"bob":{"reason":"api_error","since":9007199254740993}},"tinted_panes":[]}\n');
  pruneHandle(arm, "blocked_map", "alice", slices);
  const slice = readFileSync(join(slices, "blocked_map.alice.json"), "utf8");
  // the slice keeps python's indent=2/sort_keys shape: restore and its fixture read it by name
  expect(slice).toBe('{\n  "alice": {\n    "reason": "session_limit",\n    "since": 5\n  }\n}\n');
  const after = readFileSync(arm, "utf8");
  expect(after).toBe('{"armed_by":"owner","blocked_map":{"bob":{"reason":"api_error","since":9007199254740993}},"tinted_panes":[]}\n');
  expect(existsSync(`${arm}.lock`)).toBe(true);
  restoreHandle(arm, "blocked_map", slices);
  // the exact integer survived both hops, and alice came back after bob (merge order)
  expect(readFileSync(arm, "utf8")).toBe('{"armed_by":"owner","blocked_map":{"bob":{"reason":"api_error","since":9007199254740993},"alice":{"reason":"session_limit","since":5}},"tinted_panes":[]}\n');
});

test("prune and restore accept the STRING-valued bucket every watcher-written record has, and the tick's readers see the same JSON text", () => {
  const root = scratch();
  const arm = join(root, "watch", "arm.json");
  const slices = join(root, "archive", "watch");
  mkdirSync(join(root, "watch"), { recursive: true });
  // `tap_watch_set blocked_map '{...}'` stores the object as an opaque string (CONTRACT §Watch layer)
  writeFileSync(arm, JSON.stringify({ armed_by: "owner", blocked_map: JSON.stringify({ alice: { reason: "session_limit", since: 5, reset_at: 0 }, bob: { reason: "api_error", since: 6, reset_at: 0 } }) }) + "\n");
  pruneHandle(arm, "blocked_map", "alice", slices);
  expect(JSON.parse(readFileSync(join(slices, "blocked_map.alice.json"), "utf8"))).toEqual({ alice: { reason: "session_limit", since: 5, reset_at: 0 } });
  const pruned = readLoose(arm);
  // still a string, still one object: what `tap_watch_field blocked_map` prints is what
  // `_watch_blocked_keys` json.loads -- the tick's reader contract
  const field = fieldValue(pruned, "blocked_map");
  expect(typeof (pruned as Record<string, unknown>).blocked_map).toBe("string");
  expect(JSON.parse(field)).toEqual({ bob: { reason: "api_error", since: 6, reset_at: 0 } });
  const printed = spawnSync(process.execPath, [LEASE, arm, "field", "blocked_map"], { encoding: "utf8" });
  expect(printed.stdout).toBe(field + "\n");
  restoreHandle(arm, "blocked_map", slices);
  expect(JSON.parse(fieldValue(readLoose(arm), "blocked_map"))).toEqual({ bob: { reason: "api_error", since: 6, reset_at: 0 }, alice: { reason: "session_limit", since: 5, reset_at: 0 } });
});

test("prune writes nothing for an absent record, an unreadable one, a missing bucket, or an unknown handle", () => {
  const root = scratch();
  const arm = join(root, "watch", "arm.json");
  const slices = join(root, "archive", "watch");
  pruneHandle(arm, "blocked_map", "alice", slices);
  expect(existsSync(slices)).toBe(false);
  expect(existsSync(arm)).toBe(false);
  mkdirSync(join(root, "watch"), { recursive: true });
  for (const bytes of ["{not json", JSON.stringify({ armed_by: "x" }), JSON.stringify({ blocked_map: { bob: {} } }), JSON.stringify({ blocked_map: "not an object" }), JSON.stringify({ blocked_map: [1] })]) {
    writeFileSync(arm, bytes);
    pruneHandle(arm, "blocked_map", "alice", slices);
    expect(readFileSync(arm, "utf8")).toBe(bytes);
    expect(existsSync(slices)).toBe(false);
  }
});

test("restore creates the record and the bucket when absent, as the incumbent did, and tolerates an empty slice dir", () => {
  const root = scratch();
  const arm = join(root, "watch", "arm.json");
  const slices = join(root, "archive", "watch");
  mkdirSync(slices, { recursive: true });
  writeFileSync(join(slices, "blocked_map.alice.json"), pyDumpSorted({ alice: { reason: "x" } }) + "\n");
  writeFileSync(join(slices, "seats.alice.json"), "{\"alice\":{}}\n"); // another top-key's slice: ignored
  restoreHandle(arm, "blocked_map", slices);
  expect(readFileSync(arm, "utf8")).toBe('{"blocked_map":{"alice":{"reason":"x"}}}\n');
  restoreHandle(arm, "seats", join(root, "nowhere"));
  expect(readFileSync(arm, "utf8")).toBe('{"blocked_map":{"alice":{"reason":"x"}},"seats":{}}\n');
});

test("the mutator refuses through the lock: a symlinked lease lock path prunes nothing", () => {
  const root = scratch();
  const arm = join(root, "watch", "arm.json");
  mkdirSync(join(root, "watch"), { recursive: true });
  writeFileSync(arm, JSON.stringify({ blocked_map: { alice: {} } }));
  writeFileSync(join(root, "unrelated"), "do not touch");
  spawnSync("ln", ["-s", join(root, "unrelated"), `${arm}.lock`]);
  const r = spawnSync(process.execPath, [LEASE, arm, "prune-handle", "blocked_map", "alice", join(root, "slices")], { encoding: "utf8" });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("symlinked");
  expect(readFileSync(arm, "utf8")).toBe(JSON.stringify({ blocked_map: { alice: {} } }));
  expect(existsSync(join(root, "slices"))).toBe(false);
});

test("pyDumpSorted is json.dumps(indent=2, sort_keys=True): nested keys sorted, integer-like keys in string order, ASCII escaped", () => {
  expect(pyDumpSorted({ b: [1, { z: "é", a: null }], "10": 1, "2": 2, a: {} })).toBe(
    '{\n  "10": 1,\n  "2": 2,\n  "a": {},\n  "b": [\n    1,\n    {\n      "a": null,\n      "z": "\\u00e9"\n    }\n  ]\n}');
  expect(pyDumpSorted({ n: 9007199254740993n })).toBe('{\n  "n": 9007199254740993\n}');
});

// --- watch-notice: the sticky NOTIFY -------------------------------------------------------

function busWith(root: string, files: Record<string, string>): string {
  const bus = join(root, "bus");
  mkdirSync(join(bus, "watch"), { recursive: true });
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(bus, rel), text);
  return bus;
}
function fakeEscalate(root: string): void {
  const native = join(root, "runtime/bun/src/verbs");
  mkdirSync(native, { recursive: true });
  writeFileSync(join(native, "escalate.ts"), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(root, "escalate-argv"))}, process.argv.slice(2).join('\\n')+'\\n');`);
}
function fakeScripts(root: string, sendExit: number): string {
  const scripts = join(root, "skills/tap/scripts");
  mkdirSync(join(scripts, "watch-templates"), { recursive: true });
  writeFileSync(join(scripts, "watch-templates", "notice.md"), "R={{REASON}}\nE={{EVIDENCE}}\n");
  standInCourier(scripts, `#!/bin/bash\nprintf '%s\\n' "$@" > "${join(root, "send-argv")}"; cat "$2" > "${join(root, "send-body")}"; echo "send stderr line" >&2; exit ${sendExit}\n`);
  fakeEscalate(root);
  return scripts;
}

test("notifyHuman publishes the sticky NOTIFY, stamps notified_at for an episode, escalates as the armer, and reports durability", () => {
  const root = scratch();
  const bus = busWith(root, { "watch/arm.json": JSON.stringify({ armed_by: "owner", episode_started_at: 100, notified_at: 0 }) });
  const scripts = fakeScripts(root, 1);
  const rc = notifyHuman({ bus, scripts, reason: "chain exhausted", now: "2000", env: { ...process.env, PATH: `${join(root, "no-osascript")}:/usr/bin:/bin` } });
  expect(rc).toBe(0);
  expect(readFileSync(join(bus, "watch", "notify.json"), "utf8")).toBe('{"type":"NOTIFY","at":"2000","reason":"chain exhausted","acked":"0"}\n');
  expect(fieldValue(readLoose(join(bus, "watch", "arm.json")), "notified_at")).toBe("2000");
  expect(readFileSync(join(root, "escalate-argv"), "utf8")).toBe("-m\nchain exhausted\n--from\nowner\n");
  expect(notifyPending(bus)).toBe(true);
});

test("notifyHuman merges into a pending NOTIFY (never clobbers), dedups per episode, and a spool kind ignores the episode slot", () => {
  const root = scratch();
  const scripts = fakeScripts(root, 1);
  const pending = '{"type":"NOTIFY","at":"900","reason":"first","acked":"0"}\n';
  const bus = busWith(root, { "watch/arm.json": JSON.stringify({ armed_by: "owner", episode_started_at: 100, notified_at: 0 }), "watch/notify.json": pending });
  expect(notifyHuman({ bus, scripts, reason: "second", now: "2000" })).toBe(0);
  expect(readFileSync(join(bus, "watch", "notify.json"), "utf8")).toBe(pending);
  expect(fieldValue(readLoose(join(bus, "watch", "arm.json")), "notified_at")).toBe("0");
  // acked -> not pending; but the episode already notified (notified_at >= episode_started_at) -> episode kind dedups
  writeFileSync(join(bus, "watch", "notify.json"), '{"type":"NOTIFY","at":"900","reason":"first","acked":"1"}');
  writeFileSync(join(bus, "watch", "arm.json"), JSON.stringify({ armed_by: "owner", episode_started_at: 100, notified_at: 150 }));
  expect(notifyHuman({ bus, scripts, reason: "third", now: "2000" })).toBe(0);
  expect(readFileSync(join(bus, "watch", "notify.json"), "utf8")).toContain('"first"');
  // a SPOOL escalation neither reads nor writes the episode slot (tap-t4i)
  expect(notifyHuman({ bus, scripts, reason: "spool stuck", kind: "spool", now: "2001" })).toBe(0);
  expect(readFileSync(join(bus, "watch", "notify.json"), "utf8")).toBe('{"type":"NOTIFY","at":"2001","reason":"spool stuck","acked":"0"}\n');
  expect(fieldValue(readLoose(join(bus, "watch", "arm.json")), "notified_at")).toBe("150");
});

test("notifyHuman carries a failed publish: the transports still run and the verdict is 1", () => {
  const root = scratch();
  const scripts = fakeScripts(root, 1);
  const bus = join(root, "bus");
  mkdirSync(bus, { recursive: true });
  writeFileSync(join(bus, "watch"), "a file where the directory should be");
  expect(notifyHuman({ bus, scripts, reason: "r", now: "1" })).toBe(1);
});

test("sendNotice renders the template for a notice, the bare two-part body for progress, and returns 0 for courier 0/5", () => {
  const root = scratch();
  const bus = busWith(root, {});
  const scripts = fakeScripts(root, 5);
  expect(sendNotice({ bus, scripts, to: "lead", reason: "why", evidence: "ev" })).toBe(0);
  expect(readFileSync(join(root, "send-body"), "utf8")).toBe("R=why\nE=ev\n");
  expect(readFileSync(join(root, "send-argv"), "utf8").split("\n")).toEqual(["lead", join(bus, "watch", `.notice.${process.pid}.md`), "--from", "watcher", "--kind", "notice", "--fyi", ""]);
  expect(sendNotice({ bus, scripts, to: "lead", reason: "why", evidence: "ev", kind: "progress", wake: true })).toBe(0);
  expect(readFileSync(join(root, "send-body"), "utf8")).toBe("why\n\nev\n");
  expect(readFileSync(join(root, "send-argv"), "utf8")).toContain("--wake");
  expect(sendNotice({ bus, scripts, to: "", reason: "why" })).toBe(3);
  expect(readdirSync(join(bus, "watch")).filter(n => n.startsWith(".notice."))).toEqual([]);
  expect(renderNotice(scripts, "", "")).toBe("R=-\nE=-\n");
});

test("approval notices (tap-rlebf.2): a named template, the courier's disposition, and an approval NOTIFY that leaves the episode slot alone", () => {
  const root = scratch();
  const bus = busWith(root, { "watch/arm.json": JSON.stringify({ armed_by: "owner", episode_started_at: 100, notified_at: 50 }) });
  const scripts = fakeScripts(root, 0);
  writeFileSync(join(scripts, "watch-templates", "approval-reject-seat.md"), "SEAT {{REASON}} / {{EVIDENCE}}\n");
  standInCourier(scripts, `#!/bin/bash\nprintf '%s\\n' "$@" > "${join(root, "send-argv")}"; cat "$2" > "${join(root, "send-body")}"; echo '{"status":"injected","delivery":"pane"}'; exit 0\n`);
  const excerpt = "$ rm -rf `pwd`/build $(whoami)";
  expect(sendNoticeReceipt({ bus, scripts, to: "seat", template: "approval-reject-seat.md", reason: "declined", evidence: excerpt }))
    .toEqual({ rc: 0, disposition: "injected" });
  // Bytes arrive as data: the excerpt is never shell-expanded on the way to the body file.
  expect(readFileSync(join(root, "send-body"), "utf8")).toBe(`SEAT declined / ${excerpt}\n`);
  expect(readFileSync(join(root, "send-argv"), "utf8").split("\n")).toContain("--json");
  // The plain notice path is unchanged: no --json, notice.md.
  sendNotice({ bus, scripts, to: "lead", reason: "why", evidence: "ev" });
  expect(readFileSync(join(root, "send-argv"), "utf8").split("\n")).not.toContain("--json");
  expect(readFileSync(join(root, "send-body"), "utf8")).toBe("R=why\nE=ev\n");
  // Receipt mode fails closed: exit 0 with malformed JSON is a failed notice, so the fallback fires.
  standInCourier(scripts, "#!/bin/bash\necho 'not json'; exit 0\n");
  expect(sendNoticeReceipt({ bus, scripts, to: "seat", template: "approval-reject-seat.md", reason: "r", evidence: "e" })).toEqual({ rc: 1, disposition: "failed" });
  // A failed armer notice falls back to an approval-kind NOTIFY; notified_at stays 50.
  standInCourier(scripts, "#!/bin/bash\necho 'courier down' >&2; exit 1\n");
  expect(approvalNoticeOrNotify({ bus, scripts, to: "owner", template: "approval-reject-lead.md", reason: "seat blocked", evidence: "e", now: "3000" })).toBe("notify");
  expect(readFileSync(join(bus, "watch", "notify.json"), "utf8")).toBe('{"type":"NOTIFY","at":"3000","reason":"seat blocked","acked":"0"}\n');
  expect(fieldValue(readLoose(join(bus, "watch", "arm.json")), "notified_at")).toBe("50");
});

// --- watch-registry ----------------------------------------------------------------------------

test("registryPanes prints the wanted handle first (even empty), then active panes, and nothing for an unreadable or old-format registry", () => {
  const root = scratch();
  const reg = join(root, "registry.json");
  const seats = { a: { pane: "%1" }, b: { status: "offline", pane: "%2" }, c: { pane: "%3" }, d: { pane: "" }, e: "not a seat" };
  // An agents axis beside seats is an old format: no record, never the seats half of it.
  writeFileSync(reg, JSON.stringify({ schema: "0.20", seats, agents: { z: { pane: "%9" } } }));
  expect(registryPanes(reg, "c", true)).toEqual([]);
  writeFileSync(reg, JSON.stringify({ schema: "0.20", seats }));
  expect(registryPanes(reg, "c", true)).toEqual(["%3", "%1"]);
  expect(registryPanes(reg, "c", false)).toEqual(["%3"]);
  expect(registryPanes(reg, "nobody", false)).toEqual([""]);
  expect(registryPanes(reg, "", false)).toEqual(["%1"]);
  expect(registryPanes(reg, "", true)).toEqual(["%1", "%3"]);
  writeFileSync(reg, "{broken");
  expect(registryPanes(reg, "a", true)).toEqual([]);
  expect(registryPanes(join(root, "missing.json"), "a", true)).toEqual([]);
  expect(repoRoot(reg, "/cwd")).toBe("/cwd");
  writeFileSync(reg, JSON.stringify({ schema: "0.20", team: { worktree_root: "/tree" }, seats: {} }));
  expect(repoRoot(reg, "/cwd")).toBe("/tree");
  // An old-format registry never chooses the working tree (old_store): the cwd, as for a missing file.
  writeFileSync(reg, JSON.stringify({ team: { worktree_root: "/tree" }, agents: {} }));
  expect(repoRoot(reg, "/cwd")).toBe("/cwd");
});

// --- watch-sidecar: the `tap remind` reuse rule resolves the ARM OWNER's session --------------

test("remindersEntry ensures the sidecar for the arm owner, not the scheduling seat (moved from smoke/remind.test.sh)", async () => {
  const seen: string[] = [];
  // `mock.module` is process-wide and outlives this test: the whole Bun suite runs in
  // ONE process (bun-router.test.sh on the gate), so a module left mocked here reaches
  // every file after this one -- `repoRoot: () => "/"` is exactly what made
  // watch-tick-run.test.ts's repo-clock control read `""` on the gate (tap-4aqvd). The
  // real exports are captured first and put back when the test ends.
  const real = { ...await import("../src/watch-registry") };
  mock.module("../src/watch-registry", () => ({
    teamSession: (_reg: string, armer: string) => { seen.push(armer); return ""; },
    repoRoot: () => "/",
    registryPanes: () => [],
  }));
  try {
    const { remindersEntry } = await import("../src/watch-sidecar");
    const root = scratch();
    const bus = busWith(root, { "watch/arm.json": JSON.stringify({ mode: "supervision", armed_by: "owner", armed_at: 1, watcher_pid: 1, watcher_command: "watch-run.ts run", heartbeat_at: 0, tick_interval_seconds: 60 }) });
    const rc = remindersEntry({ bus, scripts: root, registry: join(root, "registry.json"), owner: "another-seat", noSpawn: false, now: "2000" });
    expect(rc).toBe(1); // no session resolved -> lease stands without a confirmed runner
    expect(seen).toEqual(["owner"]);
    // items reader unchanged by the float-preserving reviver
    expect(itemLines({ tinted_panes: ["%1"] }, "tinted_panes")).toEqual(["%1"]);
  } finally {
    mock.module("../src/watch-registry", () => real);
  }
  // the restore is itself checked: the real reader answers again
  const { repoRoot: restored } = await import("../src/watch-registry");
  expect(restored(join(scratch(), "absent.json"), "/cwd")).toBe("/cwd");
});

// --- remindersEntry's ride rule and ensureSidecar's refusals (ported from smoke/remind.test.sh) ---

function captureStreams(fn: () => number): { rc: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { return { rc: fn(), out: out.join(""), err: err.join("") }; }
  finally { process.stdout.write = stdout; process.stderr.write = stderr; }
}

/** Shims for the two binaries the sidecar door shells out to: `ps` (liveness) and `tmux` (session/window plumbing). */
function withFakePsAndTmux<T>(root: string, tmuxCases: string, fn: () => T): T {
  const shim = join(root, "bin");
  mkdirSync(shim, { recursive: true });
  writeFileSync(join(shim, "ps"), "#!/bin/sh\nprintf 'watch-run.ts run\\n'\n");
  chmodSync(join(shim, "ps"), 0o755);
  writeFileSync(join(shim, "tmux"), `#!/bin/sh\ncase "$*" in\n${tmuxCases}\nesac\nexit 1\n`);
  chmodSync(join(shim, "tmux"), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim}:${savedPath ?? ""}`;
  try { return fn(); }
  finally { if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath; }
}

test("remindersEntry rides a live supervision watcher only while its heartbeat is fresh and its command is a watcher signature", () => {
  const root = scratch();
  const bus = busWith(root, {});
  const registry = join(root, "registry.json");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "t", worktree_root: root }, seats: {} }));
  const armBytes = (now: number, over: Record<string, unknown> = {}) => JSON.stringify({
    mode: "supervision", armed_by: "owner", armed_at: 17, watcher_pid: "424242",
    watcher_command: "watch-run.ts run", heartbeat_at: now - 30, tick_interval_seconds: 60, ...over,
  }) + "\n";
  const arm = join(bus, "watch", "arm.json");
  withFakePsAndTmux(root, "display-message) exit 1 ;;", () => {
    // Fresh heartbeat (interval 60 -> limit 180), watcher signature, live pid: the ride,
    // and the record is untouched.
    writeFileSync(arm, armBytes(1000));
    const before = readFileSync(arm);
    const rode = captureStreams(() => remindersEntry({ bus, scripts: root, registry, owner: "another-seat", noSpawn: false, now: "1000" }));
    expect(rode.rc).toBe(0);
    expect(rode.out).toBe("tap remind: rides armed supervision watcher pid 424242 (armed by owner)\n");
    expect(readFileSync(arm)).toEqual(before);
    // A stale heartbeat must NOT ride: the record falls through to the sidecar door,
    // which refuses for want of a resolvable team session.
    writeFileSync(arm, armBytes(1300, { heartbeat_at: 500 }));
    const stale = captureStreams(() => remindersEntry({ bus, scripts: root, registry, owner: "another-seat", noSpawn: false, now: "1300" }));
    expect(stale.out).not.toContain("rides");
    expect(stale.err).toContain("no team tmux session is available");
    expect(stale.rc).toBe(1);
    // A non-signature command never rides, however fresh its heartbeat.
    writeFileSync(arm, armBytes(1000, { watcher_command: "unrelated process" }));
    const foreign = captureStreams(() => remindersEntry({ bus, scripts: root, registry, owner: "another-seat", noSpawn: false, now: "1000" }));
    expect(foreign.out).not.toContain("rides");
    expect(foreign.rc).toBe(1);
  });
});

test("ensureSidecar refuses when another watch-on holds the spawn mutex, when the watch window belongs to another process, when the spawn fails, and when it yields no valid pid", () => {
  const root = scratch();
  const registry = join(root, "registry.json");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "t", worktree_root: root }, seats: { owner: { pane: "%999999", status: "active" } } }));
  const bus = busWith(root, {});
  const arm = join(bus, "watch", "arm.json");
  // These records can never ride (a non-signature command), so each case walks
  // ensureSidecar; the tmux shim resolves the armer's session, then each
  // seam refuses in turn.
  const stage = () => writeFileSync(arm, JSON.stringify({
    mode: "supervision", armed_by: "owner", armed_at: 17, watcher_pid: "424242",
    watcher_command: "unrelated process", heartbeat_at: 970, tick_interval_seconds: 60 }) + "\n");
  const entry = () => captureStreams(() => remindersEntry({ bus, scripts: root, registry, owner: "owner", noSpawn: false, now: "1000" }));
  withFakePsAndTmux(root, `*display-message*) printf 'sess\\n'; exit 0 ;;
*list-windows*) [ "$FAKE_WINDOWS" = foreign ] && { printf 'watch 999999\\n'; exit 0; } || exit 0 ;;
*new-window*) [ "$FAKE_SPAWN" = invalid ] && { printf 'not-a-pid\\n'; exit 0; } || exit 1 ;;
`, () => {
    // Another watch-on owns the spawn mutex: skip rather than proceed unsynchronized,
    // and never remove a lock we do not hold.
    stage();
    mkdirSync(join(bus, "watch", ".spawn.lock"));
    const mutex = entry();
    expect(mutex.rc).toBe(1);
    expect(mutex.err).toContain("another watch-on call holds the spawn lock");
    expect(existsSync(arm)).toBe(true);
    rmSync(join(bus, "watch", ".spawn.lock"), { recursive: true });

    // A live watch window whose pane pid is not the recorded one is foreign.
    stage();
    process.env.FAKE_WINDOWS = "foreign";
    try {
      const foreignWindow = entry();
      expect(foreignWindow.rc).toBe(1);
      expect(foreignWindow.err).toContain("belongs to another process");
    } finally { delete process.env.FAKE_WINDOWS; }

    // A window that opens but reports no numeric pane pid is no runner at all:
    // the lease must not claim a watcher that was never born.
    stage();
    process.env.FAKE_SPAWN = "invalid";
    try {
      const invalid = entry();
      expect(invalid.rc).toBe(1);
      expect(invalid.err).toContain("no valid process");
      expect(invalid.out).not.toContain("sidecar started");
    } finally { delete process.env.FAKE_SPAWN; }

    // No watch window: a respawn is attempted, and a failed spawn is the refusal
    // with the lease kept for the next attempt.
    stage();
    const failed = entry();
    expect(failed.rc).toBe(1);
    expect(failed.err).toContain("sidecar spawn failed in session 'sess'");
    expect(existsSync(arm)).toBe(true);
  });
}, 15_000);

// --- review round 1: the partner's and the second family's controls --------------------------

test("prune ignores an absent prototype-named handle and moves a present one (own keys, as python's `in`)", () => {
  const root = scratch();
  const arm = join(root, "watch", "arm.json");
  const slices = join(root, "archive", "watch");
  mkdirSync(join(root, "watch"), { recursive: true });
  for (const bucket of ['{"blocked_map":"{}"}', '{"blocked_map":{}}']) {
    writeFileSync(arm, bucket);
    for (const h of ["constructor", "toString", "__proto__", "hasOwnProperty"]) pruneHandle(arm, "blocked_map", h, slices);
    expect(readFileSync(arm, "utf8")).toBe(bucket);
    expect(existsSync(slices)).toBe(false);
  }
  writeFileSync(arm, '{"blocked_map":{"constructor":{"reason":"x"},"bob":{}}}');
  pruneHandle(arm, "blocked_map", "constructor", slices);
  expect(readFileSync(join(slices, "blocked_map.constructor.json"), "utf8")).toBe('{\n  "constructor": {\n    "reason": "x"\n  }\n}\n');
  expect(readFileSync(arm, "utf8")).toBe('{"blocked_map":{"bob":{}}}\n');
});

test("a float inside a slice keeps its numeric text through prune and restore (1.5 stays 1.5, never {rawJSON})", () => {
  const root = scratch();
  const arm = join(root, "watch", "arm.json");
  const slices = join(root, "archive", "watch");
  mkdirSync(join(root, "watch"), { recursive: true });
  writeFileSync(arm, '{"blocked_map":{"alice":{"since":1.5,"at":1.0}}}');
  pruneHandle(arm, "blocked_map", "alice", slices);
  expect(readFileSync(join(slices, "blocked_map.alice.json"), "utf8")).toBe('{\n  "alice": {\n    "at": 1.0,\n    "since": 1.5\n  }\n}\n');
  expect(readFileSync(arm, "utf8")).toBe('{"blocked_map":{}}\n');
  restoreHandle(arm, "blocked_map", slices);
  // the slice's (sorted) key order comes back, as it did from json.load of the incumbent's slice
  expect(readFileSync(arm, "utf8")).toBe('{"blocked_map":{"alice":{"at":1.0,"since":1.5}}}\n');
  expect(JSON.parse(readFileSync(arm, "utf8")).blocked_map.alice.since).toBe(1.5);
});

test("restore refuses an existing bucket it cannot merge into (null, array, non-object string) without rewriting the record", () => {
  const root = scratch();
  const arm = join(root, "watch", "arm.json");
  const slices = join(root, "archive", "watch");
  mkdirSync(join(root, "watch"), { recursive: true });
  mkdirSync(slices, { recursive: true });
  writeFileSync(join(slices, "blocked_map.alice.json"), '{"alice":{}}\n');
  for (const bytes of ['{"blocked_map":null}', '{"blocked_map":[1]}', '{"blocked_map":"nope"}', '{"blocked_map":7}']) {
    writeFileSync(arm, bytes);
    expect(() => restoreHandle(arm, "blocked_map", slices)).toThrow("is not an object");
    expect(readFileSync(arm, "utf8")).toBe(bytes);
  }
});

test("a pending NOTIFY whose acked stamp is the float 1.0 stays pending (python's str(1.0) is '1.0')", () => {
  const root = scratch();
  const bus = busWith(root, { "watch/notify.json": '{"reason":"first","acked":1.0}' });
  expect(notifyPending(bus)).toBe(true);
  writeFileSync(join(bus, "watch", "notify.json"), '{"reason":"first","acked":1}');
  expect(notifyPending(bus)).toBe(false);
  writeFileSync(join(bus, "watch", "notify.json"), '{"reason":"first","acked":"1"}');
  expect(notifyPending(bus)).toBe(false);
  writeFileSync(join(bus, "watch", "notify.json"), '{"reason":"first"}');
  expect(notifyPending(bus)).toBe(true);
});

test("a notice whose draft cannot be written, or whose template is missing, still degrades to the human fallback", () => {
  const root = scratch();
  const scripts = fakeScripts(root, 1);
  const bus = busWith(root, { "watch/arm.json": JSON.stringify({ armed_by: "owner" }) });
  // template missing: the incumbent rendered an empty body and the send went ahead
  rmSync(join(scripts, "watch-templates", "notice.md"));
  expect(renderNotice(scripts, "r", "e")).toBe("");
  expect(noticeOrNotify({ bus, scripts, to: "peer", reason: "attention", now: "2000" })).toBe(0);
  expect(readFileSync(join(root, "escalate-argv"), "utf8")).toBe("-m\nattention\n--from\nowner\n");
  rmSync(join(root, "escalate-argv"));
  // watch/ read-only: the draft cannot be written -> a failed send, the fallback runs, the
  // publish fails and that failure is RETURNED (the incumbent's callers inherited it via set -e)
  rmSync(join(bus, "watch", "notify.json"), { force: true });
  chmodSync(join(bus, "watch"), 0o500);
  try {
    expect(sendNotice({ bus, scripts, to: "peer", reason: "attention" })).toBe(1);
    expect(noticeOrNotify({ bus, scripts, to: "peer", reason: "attention", now: "2000" })).toBe(1);
    expect(readFileSync(join(root, "escalate-argv"), "utf8")).toBe("-m\nattention\n--from\nowner\n");
    expect(notifyHuman({ bus, scripts, reason: "attention", now: "2000" })).toBe(1);
  } finally {
    chmodSync(join(bus, "watch"), 0o700);
  }
});

test("a draft that cannot be removed after a failed send does not outrank the human fallback", () => {
  const root = scratch();
  const bus = busWith(root, { "watch/arm.json": JSON.stringify({ armed_by: "owner" }) });
  const scripts = join(root, "skills/tap/scripts");
  mkdirSync(join(scripts, "watch-templates"), { recursive: true });
  writeFileSync(join(scripts, "watch-templates", "notice.md"), "R={{REASON}}\n");
  fakeEscalate(root);
  // the courier makes watch/ read-only under us and fails: the draft is now unremovable
  standInCourier(scripts, `#!/bin/bash\nchmod 0500 "${join(bus, "watch")}"\nexit 1\n`);
  try {
    // the fallback ran (escalate marker) and its publish failed on the read-only dir: 1
    expect(noticeOrNotify({ bus, scripts, to: "peer", reason: "attention", now: "2000" })).toBe(1);
    expect(readFileSync(join(root, "escalate-argv"), "utf8")).toBe("-m\nattention\n--from\nowner\n");
  } finally {
    chmodSync(join(bus, "watch"), 0o700);
  }
});

test("a verb whose non-armer notice and NOTIFY publication both fail exits 1 after recording its change, as the incumbent did under set -e", () => {
  const root = scratch();
  const bus = join(root, ".tap", "bus");
  mkdirSync(join(bus, "watch"), { recursive: true });
  mkdirSync(join(root, "index"), { recursive: true });
  writeFileSync(join(root, "index", "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
  writeFileSync(join(bus, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "t", worktree_root: root }, seats: {} }));
  writeFileSync(join(bus, "watch", "arm.json"), JSON.stringify({ mode: "supervision", armed_by: "owner", armed_at: 1000, paused_until: 0, pause_reason: "" }) + "\n");
  const scripts = join(root, "skills/tap/scripts");
  mkdirSync(join(scripts, "watch-templates"), { recursive: true });
  writeFileSync(join(scripts, "watch-templates", "notice.md"), "R={{REASON}}\n");
  fakeEscalate(root);
  standInCourier(scripts, `#!/bin/bash\nchmod 0500 "${join(bus, "watch")}"\nexit 1\n`);
  const env = { ...process.env, TAP_HOME: bus, TAP_INDEX_HOME: join(root, "index"), TAP_WATCH_NOW: "2000", TAP_SELF: "" };
  const cwd = process.cwd();
  process.chdir(root);
  try {
    // `cmdWatch` exits 1 silently at the failed fallback: the pause is recorded, no success line
    expect(cmdWatch(["pause", "--by", "peer", "-m", "lunch"], scripts, env)).toBe(1);
  } finally {
    process.chdir(cwd);
    chmodSync(join(bus, "watch"), 0o700);
  }
  expect(readFileSync(join(root, "escalate-argv"), "utf8")).toBe("-m\nwatch paused by 'peer' until 16400; reason: lunch\n--from\nowner\n");
  expect(fieldValue(readLoose(join(bus, "watch", "arm.json")), "paused_by")).toBe("peer");
});

test("the loop's Bun runner passes a notice helper's typed status through untouched (no slice_failed reclassification)", () => {
  const root = scratch();
  const bus = join(root, ".tap", "bus");
  mkdirSync(join(bus, "watch"), { recursive: true });
  writeFileSync(join(bus, "watch", "arm.json"), JSON.stringify({ armed_by: "owner" }));
  const scripts = join(import.meta.dir, "../../../skills/tap/scripts");
  const shim = join(root, "shim");
  mkdirSync(shim, { recursive: true });
  // a courier that fails and leaves watch/ read-only, so the fallback cannot publish either
  const courier = standInCourier(shim, `#!/bin/bash\nchmod 0500 "${join(bus, "watch")}"\nexit 1\n`);
  const env = { ...process.env, TAP_HOME: bus, TAP_INDEX_HOME: join(root, "index"), TAP_WATCH_NOW: "2000", TAP_COURIER_SCRIPT: courier };
  try {
    // the door the tick's notices take (in-process since W2c-2): watch-notice.ts's
    // own `import.meta.main` CLI entry, the same one watch-tick-run.ts's TS import
    // reaches in-process -- the retired Bash `_watch_bun_run` bridge this test
    // used to route through, since no production caller shells out through it anymore.
    const noticeModule = join(import.meta.dir, "../src/watch-notice.ts");
    const r = spawnSync(process.execPath, [noticeModule, "notice-or-notify", bus, scripts, "peer", "attention", "ev"], { env, encoding: "utf8", cwd: root });
    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain("slice_failed");
    expect(r.stderr).toContain("tap watch: attention: attention (armed team, chain exhausted); next: tap health");
  } finally {
    chmodSync(join(bus, "watch"), 0o700);
  }
});

test("a directory or fifo where a record should be reads as absent (`[ -f ]`), and a disarm that cannot unlink keeps the lease loud", () => {
  const root = scratch();
  const bus = busWith(root, {});
  // notify.json as a fifo: the tick's pending check must not block on it
  spawnSync("mkfifo", [join(bus, "watch", "notify.json")]);
  expect(notifyPending(bus)).toBe(false);
  rmSync(join(bus, "watch", "notify.json"));
  mkdirSync(join(bus, "watch", "notify.json"));
  expect(notifyPending(bus)).toBe(false);
  // arm.json as a directory: `disarm` used to swallow EISDIR as "already gone" and the verb printed success
  const arm = join(bus, "watch", "arm.json");
  mkdirSync(arm);
  expect(isFile(arm)).toBe(false);
  expect(() => disarm(arm)).toThrow();
  expect(existsSync(arm)).toBe(true);
});

test("a stale .tmp that cannot be removed leaves the lease on disk when disarm reports it KEPT; the arm.json failure arm stays loud", () => {
  const root = scratch();
  const arm = join(root, "watch", "arm.json");
  mkdirSync(join(root, "watch"), { recursive: true });
  writeFileSync(arm, JSON.stringify({ armed_by: "owner", armed_at: 1 }));
  mkdirSync(`${arm}.tmp`); // a directory where the pre-upgrade writer's temp name lives
  expect(() => disarm(arm)).toThrow();
  expect(existsSync(arm)).toBe(true); // the failure arm never deleted the lease first
  expect(existsSync(`${arm}.tmp`)).toBe(true);
  rmSync(`${arm}.tmp`, { recursive: true });
  disarm(arm);
  expect(existsSync(arm)).toBe(false);
});

test("a fifo named arm.json is read as absent WITHOUT being opened, and the arming publish refuses it loudly instead of creating past it (F1)", () => {
  const root = scratch();
  const arm = join(root, "watch", "arm.json");
  mkdirSync(join(root, "watch"), { recursive: true });
  spawnSync("mkfifo", [arm]);
  // A writer stands ready on the fifo so that a read which DOES open it returns this
  // record instead of blocking: without the guard the assertions below red cleanly
  // (readLoose sees "ghost", set merges and publishes) rather than hanging the runner.
  // With the guard nobody opens the fifo, the writer stays in open(), and it is killed.
  const writer = spawn("sh", ["-c", 'printf %s \'{"armed_by":"ghost","armed_at":1}\' > "$0"', arm], { stdio: "ignore" });
  try {
    expect(readLoose(arm)).toBeUndefined();
    expect(fieldValue(readLoose(arm), "armed_by")).toBe("");
    expect(() => leaseSet(arm, ["armed_by", "owner"], { TAP_WATCH_ALLOW_CREATE: "1" })).toThrow(/is not a regular file; refusing to read or publish it/);
    expect(existsSync(`${arm}.lock`)).toBe(true); // refused under the lock, like every other publish decision
    expect(writer.exitCode).toBeNull(); // still blocked in open(): nothing on our side opened the fifo
  } finally {
    writer.kill();
  }
});

test("every publisher refuses a non-regular record path at the publish boundary: restore over a fifo or a directory, for the watch and the goalie record alike (G1)", () => {
  const root = scratch();
  const slices = join(root, "archive", "watch");
  mkdirSync(slices, { recursive: true });
  writeFileSync(join(slices, "blocked_map.alice.json"), '{"alice":{"reason":"session_limit"}}\n');
  const goalieSlices = join(root, "archive", "goalie");
  mkdirSync(goalieSlices, { recursive: true });
  writeFileSync(join(goalieSlices, "seats.alice.json"), '{"alice":{"state":"parked"}}\n');
  // a fifo where the watch lease lives: restore read "absent" through the guarded loose
  // read, built a fresh record and renamed over the fifo -- the writer seam the read-side
  // guard did not cover. A standing writer makes any real open() return, so a regression
  // reds instead of hanging.
  const arm = join(root, "watch", "arm.json");
  mkdirSync(join(root, "watch"), { recursive: true });
  spawnSync("mkfifo", [arm]);
  const writer = spawn("sh", ["-c", "printf %s '{}' > \"$0\"", arm], { stdio: "ignore" });
  try {
    expect(() => restoreHandle(arm, "blocked_map", slices)).toThrow(/is not a regular file; refusing to read or publish it/);
    expect(statSync(arm).isFIFO()).toBe(true);
    expect(readdirSync(join(root, "watch")).filter((n) => n.startsWith(".lease-"))).toEqual([]); // refused before a temp existed
    // prune never had a record to prune: nothing written, the fifo untouched
    pruneHandle(arm, "blocked_map", "alice", join(root, "prune-out"));
    expect(statSync(arm).isFIFO()).toBe(true);
    expect(existsSync(join(root, "prune-out"))).toBe(false);
  } finally {
    writer.kill();
  }
  // the goalie record through the same mutator, with a directory at its name
  const goalie = join(root, "goalie", "arm.json");
  mkdirSync(goalie, { recursive: true });
  expect(() => restoreHandle(goalie, "seats", goalieSlices)).toThrow(/is not a regular file; refusing to read or publish it/);
  expect(statSync(goalie).isDirectory()).toBe(true);
  expect(readdirSync(join(root, "goalie")).filter((n) => n.startsWith(".lease-"))).toEqual([]);
  // the bare publisher, the boundary every writer crosses
  expect(() => publish(goalie, { seats: {} })).toThrow(/is not a regular file/);
  // and a regular file still restores
  rmSync(goalie, { recursive: true });
  restoreHandle(goalie, "seats", goalieSlices);
  expect(readFileSync(goalie, "utf8")).toBe('{"seats":{"alice":{"state":"parked"}}}\n');
});


test("watch never runs a second system transport after escalation", () => {
  const root = scratch(), bin = join(root, "bin"), marker = join(root, "second-transport");
  mkdirSync(bin);
  for (const name of ["osascript", "notify-send"]) writeFileSync(join(bin, name), `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'unexpected');\n`, { mode: 0o700 });
  const bus = busWith(root, { "watch/arm.json": JSON.stringify({ armed_by: "owner", episode_started_at: 100, notified_at: 0 }) });
  const scripts = fakeScripts(root, 1), previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  try {
    expect(notifyHuman({ bus, scripts, reason: "attention", now: "2000" })).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(notifyPending(bus)).toBe(true);
  } finally { process.env.PATH = previous; }
});

// --- the live sidecar door on a real private server (ported from smoke/remind.test.sh) ---

test("an arm outliving a dead private server rides the fresh server: the sidecar starts, dispatches, and exits after its final occurrence", () => {
  const realTmux = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  expect(realTmux.status).toBe(0);
  const live = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "watch-live."));
  const socket = join(live, "s");
  const liveBus = join(live, "bus");
  mkdirSync(join(liveBus, "watch"), { recursive: true });
  const registry = join(liveBus, "registry.json");
  const state = join(liveBus, "watch", "reminders.json");
  const arm = join(liveBus, "watch", "arm.json");
  const body = join(live, "body");
  writeFileSync(body, "x");
  const sent = join(live, "sent");
  const courier = join(live, "courier");
  writeFileSync(courier, `#!/bin/bash\nprintf '%s\\n' "$*" >> "${sent}"\nprintf '{"status":"injected"}\\n'\n`);
  chmodSync(courier, 0o755);
  // The module's own tmux calls must reach the PRIVATE server: no ambient socket
  // pins, and a PATH shim that leads every client with -S <socket>.
  const liveEnv: NodeJS.ProcessEnv = { ...process.env, TAP_HOME: liveBus, REMIND_SENT: sent, TAP_COURIER_SCRIPT: courier };
  for (const key of ["TMUX", "TMUX_PANE", "TAP_TMUX_SOCKET_PATH", "TAP_TMUX_SOCKET", "TAP_SERVER_EPOCH", "TAP_BOOT_ID", "TAP_WATCH_NOW"]) delete liveEnv[key];
  const shim = join(live, "bin");
  mkdirSync(shim, { recursive: true });
  writeFileSync(join(shim, "tmux"), `#!/bin/bash\nexec ${JSON.stringify(spawnSync("which", ["tmux"], { encoding: "utf8" }).stdout.trim())} -S ${JSON.stringify(socket)} "$@"\n`);
  chmodSync(join(shim, "tmux"), 0o755);
  liveEnv.PATH = `${shim}:${process.env.PATH ?? ""}`;
  const mux = (args: string[]) => spawnSync("tmux", ["-S", socket, ...args], { env: liveEnv, encoding: "utf8" });
  const until = (label: string, probe: () => boolean, tries = 100) => {
    for (let i = 0; i < tries; i++) { if (probe()) return; spawnSync("sleep", ["0.05"]); }
    throw new Error(`timed out waiting for ${label}`);
  };
  try {
    // The first client starts the server with the courier environment, so the
    // sidecar window's loop inherits the same sent-file seam.
    expect(mux(["new-session", "-d", "-s", "old", "sleep 30"]).status).toBe(0);
    const added = spawnSync(process.execPath, [join(import.meta.dir, "../src/remind.ts"), state, "add", "old-owner", "peer", body, "--at", "300"], { env: liveEnv, encoding: "utf8" });
    expect(added.status).toBe(0);
    const ident = added.stdout.trim();
    expect(mux(["kill-server"]).status).toBe(0);
    // This tmux build never unlinks the socket file on server death (measured);
    // wait it out best-effort like the incumbent did, then bind the fresh server.
    for (let i = 0; i < 20 && existsSync(socket); i++) spawnSync("sleep", ["0.05"]);
    expect(mux(["new-session", "-d", "-s", "fresh", "sleep 30"]).status).toBe(0);
    writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "test", worktree_root: live }, seats: {
      "first-stale": { pane: "gone:0.0", status: "active" },
      "old-owner": { pane: "old:0.0", status: "active" },
      peer: { pane: "fresh:0.0", status: "active" } } }));
    const before = existsSync(sent) ? readFileSync(sent, "utf8").split("\n").length : 0;
    // The arm record survived the dead server; the fresh-server session is the
    // only candidate, and startup must reach dispatch through it.
    const ensured = captureStreams(() => remindersEntry({ bus: liveBus, scripts: live, registry, owner: "peer", noSpawn: false, now: "400", env: liveEnv }));
    expect(ensured.rc).toBe(0);
    expect(ensured.out).toContain("sidecar started in session 'fresh'");
    until("the reminder to be accepted", () => {
      const rows = JSON.parse(readFileSync(state, "utf8")) as Record<string, { status: string }>;
      return rows[ident] !== undefined && rows[ident].status === "accepted";
    });
    expect(readFileSync(sent, "utf8").trim().split("\n").length).toBe(before + 1);
    // Acceptance is persisted before the minimal loop finishes its final tick:
    // the sidecar window must then be gone by itself.
    until("the sidecar window to exit after its final occurrence", () => {
      const watcher = mux(["list-panes", "-t", "fresh:watch", "-F", "#{pane_pid}"]);
      return watcher.status !== 0;
    }, 120);
  } finally {
    // Guarded teardown: a wedged server or a still-live pane must not fail the
    // run here — kill twice across a settle gap, then reap best-effort and say so.
    spawnSync("tmux", ["-S", socket, "kill-server"], { env: liveEnv });
    spawnSync("sleep", ["0.2"]);
    spawnSync("tmux", ["-S", socket, "kill-server"], { env: liveEnv });
    try { rmSync(live, { recursive: true, force: true }); }
    catch (error) { console.error(`watch-live: scratch reap failed: ${String(error)}`); }
  }
}, 30_000);

test("a quiet receipt notice reports its failure only through the result, never a tap watch stderr line", () => {
  const root = scratch();
  const bus = busWith(root, {});
  const scripts = fakeScripts(root, 0);
  writeFileSync(join(scripts, "watch-templates", "role-removed.md"), "{{REASON}} {{EVIDENCE}}\n");
  standInCourier(scripts, "#!/bin/bash\necho '{\"ok\":false,\"error_class\":\"target_unavailable\"}'; exit 3\n");
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    expect(sendNoticeReceipt({ bus, scripts, to: "t/gone", template: "role-removed.md", reason: "r", evidence: "e", quiet: true }))
      .toEqual({ rc: 3, disposition: "failed" });
    expect(written.join("")).toBe("");
    sendNoticeReceipt({ bus, scripts, to: "t/gone", template: "role-removed.md", reason: "r", evidence: "e" });
    expect(written.join("")).toContain("tap watch: notice send to 't/gone' failed (rc=3)");
  } finally { process.stderr.write = write; }
});
