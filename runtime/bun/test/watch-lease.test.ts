import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireNoFollowLock } from "../src/remind-lock";
import { applyPairs, coerce, expectedHold, fieldValue, itemLines, printed, pyInt, pyStr, read, readHandleEntry, restoreHandle, snapshotLines, undoHandleMerge } from "../src/watch-lease";
import { removeScratchTree } from "./support/scratch";

const MODULE = join(import.meta.dir, "../src/watch-lease.ts");
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) removeScratchTree(path); });

function scratch(): string {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "watch-lease-unit."));
  roots.push(root);
  return root;
}

/** Run the CLI the way tap_bun_call does: `bun watch-lease.ts <arm.json> <action> ...`, with only the env the test names. */
function cli(arm: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [MODULE, arm, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
  });
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
}

function armIn(root: string): string {
  return join(root, "bus", "watch", "arm.json");
}

function readArm(arm: string): Record<string, unknown> {
  return JSON.parse(readFileSync(arm, "utf8")) as Record<string, unknown>;
}

// --- the pure coercions carried from the Python ------------------------------------

test("pyInt is Python's int(), not parseInt and not Number", () => {
  expect(pyInt("5")).toBe(5n);
  expect(pyInt(" +7 ")).toBe(7n);
  expect(pyInt("-3\n")).toBe(-3n);
  expect(pyInt("1_000")).toBe(1000n);
  // each of these raised ValueError, which the incumbent stored as 0
  expect(pyInt("1.5")).toBe(0n); // parseInt says 1
  expect(pyInt("12abc")).toBe(0n); // parseInt says 12
  expect(pyInt("")).toBe(0n);
  expect(pyInt("1__0")).toBe(0n);
  expect(pyInt("_1")).toBe(0n);
  expect(String(pyInt("-0"))).toBe("0");
  // exact past Number's precision: Number("9007199254740993") is ...992
  expect(pyInt("9007199254740993")).toBe(9007199254740993n);
  // Python's int() accepts Unicode decimal digits and its own whitespace set, and
  // refuses a BOM (partner review N1: each of these was measured against python3)
  expect(pyInt("\u0661\u0662")).toBe(12n);
  expect(pyInt("\u008512\u0085")).toBe(12n);
  expect(pyInt("\ufeff12")).toBe(0n);
});

test("coerce stores int keys, array keys, and everything else as the given string", () => {
  expect(coerce("armed_at", "1700000000")).toBe(1700000000n);
  expect(coerce("watcher_pid", "not-a-pid")).toBe(0n);
  expect(coerce("probed_seats", '["a","b"]')).toEqual(["a", "b"]);
  expect(coerce("probed_seats", '  ["a"]')).toEqual(["a"]); // strip() before the "[" test
  expect(coerce("tinted_panes", "%1,%2,,%3")).toEqual(["%1", "%2", "%3"]);
  expect(coerce("chain_overrides", "")).toEqual([]);
  expect(coerce("blocked_exempt", "[not json")).toEqual(["[not json"]); // json.loads failed -> split
  expect(coerce("blocked_map", '{"seat":{"n":1}}')).toBe('{"seat":{"n":1}}'); // opaque string, not a JSON key
  expect(coerce("mode", "supervision")).toBe("supervision");
  expect(coerce("done_when", "1.5")).toBe("1.5");
});

test("printed and pyStr reproduce Python's print()/str() for record values", () => {
  expect(printed(null)).toBe("");
  expect(printed(undefined)).toBe("");
  expect(printed(true)).toBe("True");
  expect(printed(0)).toBe("0");
  expect(printed(1700000000)).toBe("1700000000");
  expect(printed({ b: 1, a: "x" })).toBe('{"b":1,"a":"x"}');
  expect(printed(["é"])).toBe('["\\u00e9"]'); // ensure_ascii, as json.dumps did
  expect(pyStr(null)).toBe("None"); // str(None) -- the generation check compares this
  expect(pyStr(undefined)).toBe(""); // rec.get(key, "")
  expect(pyStr(42)).toBe("42");
});

test("snapshot, field and items read a record the way the shell loops expect", () => {
  const rec = { mode: "supervision", armed_at: 1700000000, none: null, probed_seats: ["a", "b"], nested: { k: "v" } };
  expect(snapshotLines(rec)).toEqual([
    "mode\tsupervision",
    "armed_at\t1700000000",
    "none\t",
    'probed_seats\t["a","b"]',
    'nested\t{"k":"v"}',
  ]);
  expect(snapshotLines(["not", "a", "dict"])).toEqual([]);
  expect(snapshotLines(null)).toEqual([]);
  expect(fieldValue(rec, "armed_at")).toBe("1700000000");
  expect(fieldValue(rec, "missing")).toBe("");
  expect(fieldValue(rec, "none")).toBe("");
  expect(fieldValue(["list"], "0")).toBe("");
  expect(itemLines({ tinted_panes: ["%1", "%2"] }, "tinted_panes")).toEqual(["%1", "%2"]);
  expect(itemLines({ tinted_panes: [] }, "tinted_panes")).toEqual([]);
  expect(itemLines({ tinted_panes: null }, "tinted_panes")).toEqual([]);
  expect(itemLines({ tinted_panes: "%12" }, "tinted_panes")).toEqual([]); // the named divergence: not ["%", "1", "2"]
  expect(itemLines({}, "tinted_panes")).toEqual([]);
});

test("a generation check runs when its variable is set, even to the empty string", () => {
  const rec = { armed_at: 1700000000, queued_probe_id: "p1" };
  expect(expectedHold(rec, {})).toBe(true);
  expect(expectedHold(rec, { TAP_WATCH_EXPECT_ARMED_AT: "1700000000" })).toBe(true); // int compared as str()
  expect(expectedHold(rec, { TAP_WATCH_EXPECT_ARMED_AT: "1" })).toBe(false);
  // set-but-empty is NOT "unset": `os.environ.get` returned "" and the check ran
  expect(expectedHold(rec, { TAP_WATCH_EXPECT_QUEUED_PROBE_ID: "" })).toBe(false);
  expect(expectedHold({ armed_at: 1 }, { TAP_WATCH_EXPECT_QUEUED_PROBE_ID: "" })).toBe(true); // absent field is ""
  expect(expectedHold({ paused_at: null }, { TAP_WATCH_EXPECT_PAUSED_AT: "None" })).toBe(true); // str(None)
  expect(expectedHold({ paused_at: null }, { TAP_WATCH_EXPECT_PAUSED_AT: "" })).toBe(false);
});

test("applyPairs merges in order and ignores a trailing key with no value", () => {
  const rec: Record<string, unknown> = { keep: "me", current_rung: 1 };
  applyPairs(rec, ["current_rung", "2", "mode", "supervision", "dangling"]);
  expect(rec).toEqual({ keep: "me", current_rung: 2n, mode: "supervision" });
});

// --- the CLI, as tap_bun_call invokes it ---------------------------------------------

test("set refuses with 3 when there is no lease, decided before any generation check", () => {
  const arm = armIn(scratch());
  const r = cli(arm, ["set", "mode", "supervision"]);
  expect(r.status).toBe(3);
  expect(existsSync(arm)).toBe(false);
  // exists-check first: the incumbent never reached the expectation loop on a missing record
  expect(cli(arm, ["set", "mode", "supervision"], { TAP_WATCH_EXPECT_ARMED_AT: "5" }).status).toBe(3);
  expect(existsSync(arm)).toBe(false);
  // TAP_WATCH_ALLOW_CREATE must be exactly "1"
  expect(cli(arm, ["set", "mode", "supervision"], { TAP_WATCH_ALLOW_CREATE: "yes" }).status).toBe(3);
  expect(existsSync(arm)).toBe(false);
});

test("the arming write creates the record under ALLOW_CREATE=1 with the incumbent's bytes", () => {
  const arm = armIn(scratch());
  const r = cli(arm, ["set", "mode", "supervision", "armed_at", "1700000000", "done_when", "café done", "probed_seats", "a,b"], { TAP_WATCH_ALLOW_CREATE: "1" });
  expect(r.status).toBe(0);
  expect(r.stderr).toBe("");
  const bytes = readFileSync(arm, "utf8");
  // compact separators, ensure_ascii escaping, insertion order
  expect(bytes).toBe('{"mode":"supervision","armed_at":1700000000,"done_when":"caf\\u00e9 done","probed_seats":["a","b"]}\n');
  expect(existsSync(`${arm}.lock`)).toBe(true);
  expect(existsSync(`${arm}.tmp`)).toBe(false);
  // a later merge keeps every field it does not name and coerces the ones it does
  expect(cli(arm, ["set", "current_rung", "3", "watcher_pid", "junk", "chain_overrides", '["x"]']).status).toBe(0);
  expect(readArm(arm)).toEqual({ mode: "supervision", armed_at: 1700000000, done_when: "café done", probed_seats: ["a", "b"], current_rung: 3, watcher_pid: 0, chain_overrides: ["x"] });
});

test("an admitted integer past Number's precision is persisted exactly and survives an unrelated set", () => {
  // `tap watch on --threshold 9007199254740993` passes the shell's positive-integer
  // check (tap-watch.sh:197-199) and reaches set; json.dump kept it exact, and a
  // Number-based port persisted ...992 (partner review P2). Both the arming write
  // and every later read-modify-write must carry it unchanged.
  const arm = armIn(scratch());
  expect(cli(arm, ["set", "mode", "supervision", "threshold_seconds", "9007199254740993", "armed_at", "100"], { TAP_WATCH_ALLOW_CREATE: "1" }).status).toBe(0);
  expect(readFileSync(arm, "utf8")).toBe('{"mode":"supervision","threshold_seconds":9007199254740993,"armed_at":100}\n');
  // an unrelated merge re-parses and republishes the record: still exact
  expect(cli(arm, ["set", "current_rung", "1"]).status).toBe(0);
  expect(readFileSync(arm, "utf8")).toBe('{"mode":"supervision","threshold_seconds":9007199254740993,"armed_at":100,"current_rung":1}\n');
  // the read side prints it exactly, and a generation check compares it exactly
  expect(cli(arm, ["field", "threshold_seconds"]).stdout).toBe("9007199254740993\n");
  expect(cli(arm, ["snapshot"]).stdout).toContain("threshold_seconds\t9007199254740993\n");
  expect(cli(arm, ["set", "current_rung", "2"], { TAP_WATCH_EXPECT_ARMED_AT: "100" }).status).toBe(0);
  // a big integer inside an array key is exact too -- on disk AND on every read
  // path (review: a revived BigInt inside an array or object
  // made plain JSON.stringify throw, taking `snapshot` and `field` down to exit 1)
  expect(cli(arm, ["set", "chain_overrides", "[9007199254740993,7]"]).status).toBe(0);
  expect(readFileSync(arm, "utf8")).toContain('"chain_overrides":[9007199254740993,7]');
  const fieldRead = cli(arm, ["field", "chain_overrides"]);
  expect([fieldRead.status, fieldRead.stderr, fieldRead.stdout]).toEqual([0, "", "[9007199254740993,7]\n"]);
  const snap = cli(arm, ["snapshot"]);
  expect([snap.status, snap.stderr]).toEqual([0, ""]);
  expect(snap.stdout).toContain("chain_overrides\t[9007199254740993,7]\n");
  expect(cli(arm, ["items", "chain_overrides"]).stdout).toBe("9007199254740993\n7\n");
  // and a nested object with integer values (the shape teardown's restore writes)
  mkdirSync(join(arm, ".."), { recursive: true });
  writeFileSync(arm, '{"armed_at":100,"blocked_map":{"peer":{"since":9007199254740993,"n":1}}}');
  expect(cli(arm, ["field", "blocked_map"]).stdout).toBe('{"peer":{"since":9007199254740993,"n":1}}\n');
  expect(cli(arm, ["snapshot"]).stdout).toBe('armed_at\t100\nblocked_map\t{"peer":{"since":9007199254740993,"n":1}}\n');
  expect(cli(arm, ["set", "current_rung", "1"], { TAP_WATCH_EXPECT_ARMED_AT: "100" }).status).toBe(0);
  expect(readFileSync(arm, "utf8")).toBe('{"armed_at":100,"blocked_map":{"peer":{"since":9007199254740993,"n":1}},"current_rung":1}\n');
});

test("set refuses with 4 on a generation mismatch and leaves the record byte-identical", () => {
  const arm = armIn(scratch());
  expect(cli(arm, ["set", "armed_at", "100", "queued_probe_id", "p1"], { TAP_WATCH_ALLOW_CREATE: "1" }).status).toBe(0);
  const before = readFileSync(arm);
  const beforeInode = statSync(arm).ino;
  expect(cli(arm, ["set", "current_rung", "9"], { TAP_WATCH_EXPECT_ARMED_AT: "101" }).status).toBe(4);
  expect(cli(arm, ["set", "current_rung", "9"], { TAP_WATCH_EXPECT_QUEUED_PROBE_ID: "" }).status).toBe(4);
  // the two refusals published nothing: same bytes AND same inode (a publish is a
  // rename, so an unchanged inode is the evidence that no rename happened)
  expect(readFileSync(arm).equals(before)).toBe(true);
  expect(statSync(arm).ino).toBe(beforeInode);
  expect(cli(arm, ["set", "current_rung", "9"], { TAP_WATCH_EXPECT_CARRIED_PROBE_AT: "" }).status).toBe(0); // absent field == ""
  expect(readArm(arm).current_rung).toBe(9);
  expect(statSync(arm).ino).not.toBe(beforeInode); // and a publish IS a new inode
  expect(cli(arm, ["set", "current_rung", "10"], { TAP_WATCH_EXPECT_ARMED_AT: "101" }).status).toBe(4);
  expect(readArm(arm).current_rung).toBe(9);
  expect(cli(arm, ["set", "current_rung", "11"], { TAP_WATCH_EXPECT_ARMED_AT: "100" }).status).toBe(0);
  expect(readArm(arm).current_rung).toBe(11);
});

test("set inherits the incumbent's corrupt-record handling and refuses a non-object", () => {
  const arm = armIn(scratch());
  mkdirSync(join(arm, ".."), { recursive: true });
  // unparseable -> {} -> rewritten with only the new pairs (inherited, named in the module header)
  writeFileSync(arm, "{not json");
  expect(cli(arm, ["set", "mode", "supervision"]).status).toBe(0);
  expect(readArm(arm)).toEqual({ mode: "supervision" });
  // a valid non-object is what `rec.get` blew up on: nonzero, and the bytes stay
  writeFileSync(arm, "[1,2,3]\n");
  const r = cli(arm, ["set", "mode", "supervision"]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("not a JSON object");
  expect(readFileSync(arm, "utf8")).toBe("[1,2,3]\n");
});

// The discriminating decode input, per tap-yv3xm: valid JSON except one raw 0xFF
// inside a string value. The strict decoder (the incumbents' `open()`/`read_text()`)
// refuses it whole; the replacement decoder repairs it to U+FFFD and parses. Arms fed
// only valid bytes, or only obviously-invalid ones, pass under both polarities and
// prove nothing -- the postcondition below is what separates them.
const BAD_BYTE_RECORD = Buffer.from('{"note":"a\xffb"}\n', "latin1");

test("set() decodes strictly: a bad-byte record takes the incumbent's {} rewrite, not a repaired merge", () => {
  const arm = armIn(scratch());
  mkdirSync(join(arm, ".."), { recursive: true });
  writeFileSync(arm, BAD_BYTE_RECORD);
  expect(cli(arm, ["set", "mode", "supervision"]).status).toBe(0);
  // incumbent parity (lib.sh at d8c3dca3e~1): the record was discarded whole, so the
  // publish carries only the new pair. Under the shipped repair this record came back
  // WITH note: "a\uFFFDb" -- the invalid byte carried into the published record.
  const rec = readArm(arm);
  expect(rec).toEqual({ mode: "supervision" });
  expect(readFileSync(arm, "utf8")).not.toContain("\uFFFD");
  // control: the same shape with valid bytes is NOT discarded -- strict did not over-refuse
  writeFileSync(arm, '{"note":"a\u00FFb"}');
  expect(cli(arm, ["set", "mode", "supervision"]).status).toBe(0);
  expect(readArm(arm)).toEqual({ mode: "supervision", note: "a\u00FFb" });
});

test("restore aborts loudly on a bad-byte slice and leaves the record unpublished", () => {
  const root = scratch();
  const arm = armIn(root);
  mkdirSync(join(arm, ".."), { recursive: true });
  writeFileSync(arm, '{"blocked_map":{"keep":1}}');
  const sliceDir = join(root, "archive", "watch");
  mkdirSync(sliceDir, { recursive: true });
  writeFileSync(join(sliceDir, "blocked_map.alice.json"), Buffer.from('{"alice":{"x":"a\xffb"}}', "latin1"));
  // incumbent parity (tap-teardown.sh at 758fa95f1~1): the bare json.load raised
  // mid-loop and the arm dump sits after it, so nothing was written. The shipped
  // repair merged the repaired slice silently -- this is the loud-against-shipped site.
  expect(() => restoreHandle(arm, "blocked_map", sliceDir)).toThrow();
  expect(readFileSync(arm, "utf8")).toBe('{"blocked_map":{"keep":1}}');
  // control: a valid slice merges, and the record is republished compact through publish
  rmSync(join(sliceDir, "blocked_map.alice.json"));
  writeFileSync(join(sliceDir, "blocked_map.bob.json"), '{"bob":{"y":2}}');
  restoreHandle(arm, "blocked_map", sliceDir);
  expect(readArm(arm).blocked_map).toEqual({ keep: 1, bob: { y: 2 } });
});

test("undoHandleMerge removes only an unchanged merge and reports a conflict when a live writer touched it since", () => {
  const root = scratch();
  const arm = armIn(root);
  mkdirSync(join(arm, ".."), { recursive: true });
  const sliceDir = join(root, "archive", "watch");
  mkdirSync(sliceDir, { recursive: true });
  writeFileSync(join(sliceDir, "blocked_map.ann.json"), '{"ann":{"reason":"busy"}}');
  restoreHandle(arm, "blocked_map", sliceDir);
  const expected = readHandleEntry(arm, "blocked_map", "ann");
  expect(expected).toEqual({ reason: "busy" });
  // A concurrent watch writer updates the same handle before the rollback runs.
  writeFileSync(arm, JSON.stringify({ blocked_map: { ann: { reason: "escalated" } } }));
  expect(undoHandleMerge(arm, "blocked_map", "ann", expected)).toBe("conflict");
  expect(readArm(arm).blocked_map).toEqual({ ann: { reason: "escalated" } }); // untouched
  // control: an unchanged merge undoes cleanly
  writeFileSync(arm, JSON.stringify({ blocked_map: { ann: expected } }));
  expect(undoHandleMerge(arm, "blocked_map", "ann", expected)).toBe("removed");
  expect(readArm(arm).blocked_map).toEqual({});
});

test("read() raises on a bad-byte record the way the incumbent's read_text() did", () => {
  const root = scratch();
  const state = join(root, "reminders.json");
  writeFileSync(state, Buffer.from('{"c":"a\xffb"}', "latin1"));
  expect(() => read<object>(state)).toThrow();
  // absent -> {} as always; the valid shape with real non-ASCII still parses
  expect(read<object>(join(root, "absent.json"))).toEqual({});
  const ok = join(root, "ok.json");
  writeFileSync(ok, '{"c":"a\u00FFb"}');
  expect(read<object>(ok)).toEqual({ c: "a\u00FFb" });
});

test("snapshot, field and items print nothing for an absent or unreadable record and exit 0", () => {
  const arm = armIn(scratch());
  for (const args of [["snapshot"], ["field", "mode"], ["items", "tinted_panes"]]) {
    const r = cli(arm, args);
    expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
  }
  mkdirSync(join(arm, ".."), { recursive: true });
  writeFileSync(arm, "{broken");
  for (const args of [["snapshot"], ["field", "mode"], ["items", "tinted_panes"]]) {
    const r = cli(arm, args);
    expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
  }
  writeFileSync(arm, '{"mode":"supervision","armed_at":7,"paused_by":null,"tinted_panes":["%1","%2"],"blocked_map":"{\\"s\\":1}"}');
  expect(cli(arm, ["snapshot"]).stdout).toBe('mode\tsupervision\narmed_at\t7\npaused_by\t\ntinted_panes\t["%1","%2"]\nblocked_map\t{"s":1}\n');
  expect(cli(arm, ["field", "armed_at"]).stdout).toBe("7\n");
  expect(cli(arm, ["field", "paused_by"]).stdout).toBe("\n"); // present record, None -> the empty line print("") wrote
  expect(cli(arm, ["field", "absent"]).stdout).toBe("\n");
  expect(cli(arm, ["items", "tinted_panes"]).stdout).toBe("%1\n%2\n");
  expect(cli(arm, ["items", "mode"]).stdout).toBe("");
});

test("disarm removes the record and a pre-upgrade .tmp, keeps the lock file, and is idempotent", () => {
  const arm = armIn(scratch());
  expect(cli(arm, ["disarm"]).status).toBe(0);
  expect(existsSync(join(arm, ".."))).toBe(false); // nothing to do: no directory minted, no lock file minted
  expect(cli(arm, ["set", "mode", "supervision"], { TAP_WATCH_ALLOW_CREATE: "1" }).status).toBe(0);
  writeFileSync(`${arm}.tmp`, "{}");
  const r = cli(arm, ["disarm"]);
  expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
  expect(existsSync(arm)).toBe(false);
  expect(existsSync(`${arm}.tmp`)).toBe(false);
  expect(existsSync(`${arm}.lock`)).toBe(true);
  expect(cli(arm, ["disarm"]).status).toBe(0);
  // .tmp alone (an interrupted incumbent write, no record) is still cleaned under the lock
  writeFileSync(`${arm}.tmp`, "{}");
  expect(cli(arm, ["disarm"]).status).toBe(0);
  expect(existsSync(`${arm}.tmp`)).toBe(false);
});

test("usage errors exit 1 with a message and touch nothing", () => {
  const arm = armIn(scratch());
  for (const args of [[], ["bogus"], ["field"], ["items"], ["snapshot", "extra"], ["disarm", "extra"]]) {
    const r = cli(arm, args);
    expect(r.status, args.join(" ")).toBe(1);
    expect(r.stderr, args.join(" ")).toStartWith("tap watch: ");
  }
  expect(existsSync(join(arm, ".."))).toBe(false);
});

// --- the lock -------------------------------------------------------------------------

/** Poll `pred` up to `ms`, returning whether it became true. */
async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await Bun.sleep(10);
  }
  return pred();
}

function spawnCli(arm: string, args: string[], env: Record<string, string> = {}) {
  return spawn(process.execPath, [MODULE, arm, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
  });
}

test("set and disarm wait for the lease lock instead of publishing under a holder", async () => {
  const arm = armIn(scratch());
  expect(cli(arm, ["set", "mode", "supervision"], { TAP_WATCH_ALLOW_CREATE: "1" }).status).toBe(0);
  // flock binds to the open file description, so a holder in THIS process excludes
  // the child's separate open (measured in W1; this is the same primitive).
  const held = acquireNoFollowLock(`${arm}.lock`, 1_000);
  expect(held).not.toBeNull();
  const setter = spawnCli(arm, ["set", "current_rung", "5"]);
  const disarmer = spawnCli(arm, ["disarm"]);
  try {
    const moved = await until(() => readArm(arm).current_rung === 5 || !existsSync(arm), 400);
    expect(moved, "a writer published while the lock was held").toBe(false);
    expect(setter.exitCode).toBeNull();
    expect(disarmer.exitCode).toBeNull();
  } finally {
    held!.release();
  }
  // released: both complete; whichever won, the end state is "no lease" and neither timed out
  expect(await until(() => !existsSync(arm), 5_000)).toBe(true);
  // and both children have exited before scratch cleanup, so neither can still hold the lock
  expect(await until(() => setter.exitCode !== null && disarmer.exitCode !== null, 5_000)).toBe(true);
  // whichever acquired first: setter-then-disarmer is 0/0; disarmer-then-setter
  // leaves the setter no lease to merge into, which is the incumbent's exit 3
  expect([0, 3]).toContain(setter.exitCode ?? -1);
  expect(disarmer.exitCode).toBe(0);
}, 20_000);

test("set is excluded by an incumbent Python fcntl.flock holder on the same lock file", async () => {
  // the transition window: an old sidecar's in-flight `tap_watch_set` (python3 +
  // fcntl.flock) and the new writer must synchronize on one inode
  const python = Bun.which("python3");
  if (!python) throw new Error("python3 is required for the flock interop control");
  const root = scratch();
  const arm = armIn(root);
  expect(cli(arm, ["set", "mode", "supervision"], { TAP_WATCH_ALLOW_CREATE: "1" }).status).toBe(0);
  const release = join(root, "release");
  const holding = join(root, "holding");
  const holder = spawn(python, ["-c", [
    "import fcntl, os, sys, time",
    "lock = open(sys.argv[1], 'w')",
    "fcntl.flock(lock, fcntl.LOCK_EX)",
    "open(sys.argv[3], 'w').close()",
    "deadline = time.monotonic() + 10",
    "while not os.path.exists(sys.argv[2]) and time.monotonic() < deadline: time.sleep(0.01)",
    "fcntl.flock(lock, fcntl.LOCK_UN)",
  ].join("\n"), `${arm}.lock`, release, holding], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    expect(await until(() => existsSync(holding), 5_000)).toBe(true);
    const setter = spawnCli(arm, ["set", "current_rung", "5"]);
    expect(await until(() => readArm(arm).current_rung === 5, 400)).toBe(false);
    expect(setter.exitCode).toBeNull();
    writeFileSync(release, "");
    expect(await until(() => existsSync(arm) && readArm(arm).current_rung === 5, 5_000)).toBe(true);
  } finally {
    writeFileSync(release, "");
    // the holder usually exits during the wait above; `once("exit")` on an
    // already-exited child would never resolve
    if (holder.exitCode === null && holder.signalCode === null) await new Promise((resolve) => holder.once("exit", resolve));
  }
}, 20_000);

test("a symlinked lock path is refused before anything is written", () => {
  const root = scratch();
  const arm = armIn(root);
  mkdirSync(join(arm, ".."), { recursive: true });
  const elsewhere = join(root, "elsewhere.lock");
  writeFileSync(elsewhere, "");
  symlinkSync(elsewhere, `${arm}.lock`);
  const r = cli(arm, ["set", "mode", "supervision"], { TAP_WATCH_ALLOW_CREATE: "1" });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("refusing a symlinked lock path");
  expect(existsSync(arm)).toBe(false);
  writeFileSync(arm, '{"mode":"supervision"}');
  const d = cli(arm, ["disarm"]);
  expect(d.status).toBe(1);
  expect(existsSync(arm)).toBe(true); // the lease is KEPT, as the Bash adapter then reports
});
