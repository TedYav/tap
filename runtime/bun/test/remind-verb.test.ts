// The `remind` verb layer (verbs/remind.ts), in-process: the parser's refusals in
// the incumbent's ORDER, the body sources (rule 40: the BOM stays, on both), the
// file-kind operators (rule 38), and the queue helpers the verb calls. The public
// routes -- `bin/tap remind` and `tap.sh remind` against the pinned incumbent -- are
// smoke/remind-verb-closure.test.sh; this file is the unit under the doors.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TapError } from "../src/context";
import { clearCourier, standInCourier } from "./support/courier";
import { addReminder, cancelReminder, currentTime, delay, delayFor, fire, listText, parseAdd, readRows, type Rows } from "../src/remind";
import { admit, cmdRemind, queueRefusalOf, targetRegistered } from "../src/verbs/remind";

function scratch(): string { return mkdtempSync(join(tmpdir(), "remind-verb.")); }

/** `cmdRemind` from an UNREGISTERED process (no tmux): every form past `list` is `identity_unavailable`. */
function refusal(argv: string[], env: NodeJS.ProcessEnv): TapError {
  try { cmdRemind(argv, undefined, env); }
  catch (error) { if (error instanceof TapError) return error; throw error; }
  throw new Error("did not refuse");
}

describe("the verb layer", () => {
  test("human list preserves the explicit team in the full-result command", () => {
    const work = scratch();
    try {
      const root = join(work, "X"), bus = join(root, ".tap", "bus"), index = join(work, "index");
      mkdirSync(join(bus, "watch"), { recursive: true }); mkdirSync(index);
      const registry = join(root, ".tap", "team-registry.json");
      writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "X", worktree_root: root }, seats: {} }));
      writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
        X: { root, registry_location: registry, state: "registered" },
      } }));
      const state = join(bus, "watch", "reminders.json");
      const rows = { failed: { owner: "me", to: "peer", body: "check", due_at: 100, every_seconds: 0,
        status: "unresolved", exit_code: 1, result: "refused" } };
      writeFileSync(state, JSON.stringify(rows));
      const env = { ...process.env, TAP_HOME: join(work, "default-bus"), TAP_INDEX_HOME: index };
      const listed = spawnSync(process.execPath, [join(import.meta.dir, "../main.ts"), "remind", "list", "--team", "X"], { env, encoding: "utf8", cwd: work });
      expect(listed.status).toBe(0);
      const command = listed.stdout.trim().split("full result: ")[1];
      expect(command).toBe("tap remind list --team X --json");
      const full = spawnSync(process.execPath, [join(import.meta.dir, "../main.ts"), ...command!.split(" ").slice(1)], { env, encoding: "utf8", cwd: work });
      expect(full.status).toBe(0);
      expect(JSON.parse(full.stdout)).toEqual([{ id: "failed", ...rows.failed }]);
      expect(readFileSync(state, "utf8")).toBe(JSON.stringify(rows));
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

  test("the sub-command is argv[0] whatever it spells, and identity precedes every refusal past `list`", () => {
    const work = scratch();
    try {
      const bus = join(work, ".tap", "bus"); mkdirSync(join(bus, "watch"), { recursive: true });
      writeFileSync(join(bus, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: "T", worktree_root: work }, seats: { me: { status: "active" } } }));
      mkdirSync(join(work, "index"));
      writeFileSync(join(work, "index", "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} })); // born live (F1)
      const env = { ...process.env, TAP_HOME: bus, TAP_INDEX_HOME: join(work, "index"), TMUX: undefined, TMUX_PANE: undefined };
      // `--json list`: argv[0] is `--json`, the sub-command; it is not `list`, so the
      // caller's identity is resolved first -- and this process has none
      const e = refusal(["--json", "list"], env);
      expect([e.errorClass, e.code, e.action, e.detail]).toEqual(["identity_unavailable", 1, "tap in", "schedule from your registered pane"]);
      // no sub-command at all: the same door, the same refusal
      expect(refusal([], env).errorClass).toBe("identity_unavailable");
      // `list` needs no identity and refuses its own arity before anything else
      const l = refusal(["list", "extra"], env);
      expect([l.errorClass, l.detail]).toEqual(["usage_error", "unexpected list argument"]);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

  test("`${2:?…}` operands: unset OR empty refuses with the incumbent's requirement, before any context is resolved", () => {
    const env = { ...process.env, TAP_HOME: "/nonexistent/bus" };
    for (const [argv, want] of [
      [["me", "--in", "", "-f", "x"], "time option needs a value"],
      [["me", "-f", "x", "--at"], "time option needs a value"],
      [["me", "--in", "8m", "-f", ""], "-f needs a body file"],
      [["me", "--in", "8m", "--file"], "-f needs a body file"],
      [["me", "--in", "8m", "-f", "x", "--team", ""], "--team needs a name"],
      [["list", "--team"], "--team needs a name"],
    ] as Array<[string[], string]>) {
      const e = refusal(argv, env);
      expect([e.errorClass, e.action, e.detail], argv.join(" ")).toEqual(["usage_error", "tap help remind", want]);
    }
  });
});

describe("the queue helpers the verb calls", () => {
  test("add stores the body's text exactly -- a leading BOM included -- and mints the minimal lease; list renders both forms; cancel is owner-scoped", () => {
    const work = scratch();
    try {
      const state = join(work, "watch", "reminders.json");
      const bom = "﻿BOM body\n";
      const id = addReminder(state, parseAdd(["me", "peer", "-", "--in", "8m"]), bom, 1000);
      expect(id).toMatch(/^remind-[0-9a-f]{16}$/);
      const rows = JSON.parse(readFileSync(state, "utf8")) as Rows;
      expect(rows[id]).toEqual({ owner: "me", to: "peer", body: bom, due_at: 1480, every_seconds: 0, status: "scheduled" });
      expect(JSON.parse(readFileSync(join(work, "watch", "arm.json"), "utf8")).mode).toBe("reminders-only");
      expect(listText(state, false)).toBe(`${id}  me->peer  scheduled  due=1480  every=0s  message=-\n`);
      expect(JSON.parse(listText(state, true))).toEqual([{ id, ...rows[id] }]);
      expect(() => cancelReminder(state, "other", id)).toThrow("only the scheduling seat can cancel this reminder");
      expect(() => cancelReminder(state, "me", "remind-0000000000000000")).toThrow("unknown reminder");
      cancelReminder(state, "me", id);
      expect(listText(state, true)).toBe("[]\n");
      expect(listText(state, false)).toBe("");
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

  test("the body refusals and the schedule grammar are the queue's, in its order: grammar first, then the empty body (a BOM-only body is empty)", () => {
    const work = scratch();
    try {
      const state = join(work, "watch", "reminders.json");
      expect(() => parseAdd(["me", "peer", "-", "--in", "abc"])).toThrow("duration must be a positive integer followed by s, m, h, or d");
      expect(() => parseAdd(["me", "peer", "-", "--in", "8m", "--at", "5"])).toThrow("add needs exactly one of --in or --at");
      expect(() => parseAdd(["me", "peer", "-"])).toThrow("add needs exactly one of --in or --at");
      expect(() => parseAdd(["me", "peer", "-", "extra", "--in", "8m"])).toThrow("add needs <owner> <to> <body-path>");
      expect(() => parseAdd(["me", "peer", "-", "--in", "8m", "--bogus"])).toThrow("unrecognized argument --bogus");
      expect(() => parseAdd(["me", "peer", "-", "--every", "0s", "--in", "8m"])).toThrow("duration is out of range");
      expect(() => parseAdd(["me", "peer", "-", "--in", "9007199254740993s"])).toThrow("duration is out of range");
      expect(() => parseAdd(["me", "peer", "-", "--at", "1.5"])).toThrow("--at must be an integer");
      for (const empty of ["", "﻿", "   \n\t\n"]) {
        expect(() => addReminder(state, parseAdd(["me", "peer", "-", "--in", "8m"]), empty, 1000)).toThrow("reminder body must not be empty");
      }
      expect(() => addReminder(state, parseAdd(["me", "peer", "-", "--at", "253402300800"]), "x", 1000)).toThrow("epoch is out of range");
      // nothing above published a row: the queue file was never created
      expect(existsSync(state)).toBe(false);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

  test("the clock is read before the action on every door: a non-integer TAP_WATCH_NOW refuses `list` and `cancel` too", () => {
    expect(() => currentTime({ TAP_WATCH_NOW: "abc" })).toThrow("TAP_WATCH_NOW must be an integer");
    expect(currentTime({ TAP_WATCH_NOW: " 42 " })).toBe(42);
    expect(currentTime({})).toBeGreaterThan(1_700_000_000);
  });

  test("a row whose due_at is not an integer (a hand edit) neither shortens the sleep nor fires -- announced, never a NaN sleep or a dispatch", () => {
    const work = scratch();
    try {
      const state = join(work, "watch", "reminders.json"); mkdirSync(join(work, "watch"));
      const rows: Rows = {
        "remind-aaaaaaaaaaaaaaaa": { owner: "me", to: "peer", body: "x", due_at: "soon" as unknown as number, every_seconds: 0, status: "scheduled" },
        "remind-bbbbbbbbbbbbbbbb": { owner: "me", to: "peer", body: "y", due_at: 1007, every_seconds: 0, status: "scheduled" },
      };
      // the sleep: the readable row's deadline, never NaN
      expect(delay(rows, 60, 1000)).toBe(7);
      expect(delay({ "remind-aaaaaaaaaaaaaaaa": rows["remind-aaaaaaaaaaaaaaaa"]! }, 60, 1000)).toBe(60);
      // the dispatch: the hand-edited row is skipped, its claim untouched; the good row is claimed
      writeFileSync(state, JSON.stringify(rows));
      writeFileSync(join(work, "watch", "arm.json"), JSON.stringify({ armed_at: 5 }));
      const scripts = join(work, "scripts"); mkdirSync(scripts);
      standInCourier(scripts, "#!/bin/bash\nprintf '{\"status\":\"injected\"}\\n'\n");
      const err: string[] = [];
      const orig = process.stderr.write.bind(process.stderr);
      (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { err.push(s); return true; };
      try { fire(state, scripts, "5", 2000); } finally { (process.stderr as unknown as { write: typeof orig }).write = orig; clearCourier(); }
      const after = JSON.parse(readFileSync(state, "utf8")) as Rows;
      expect(after["remind-aaaaaaaaaaaaaaaa"]!.status).toBe("scheduled");
      expect(after["remind-bbbbbbbbbbbbbbbb"]!.status).toBe("accepted");
      expect(err).toEqual(["tap watch: reminders: remind-aaaaaaaaaaaaaaaa: due_at is not an integer (\"soon\"); not dispatched\n"]);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
});

describe("the typed boundaries (rule 19)", () => {
  test("a registry that is gone, or exists and cannot be read, is its own refusal -- never 'target is not registered'", () => {
    const work = scratch();
    try {
      const reg = join(work, "registry.json");
      // gone between identity and membership: the authority failed, the target is not "absent"
      let gone: TapError | null = null;
      try { targetRegistered(reg, "peer"); } catch (error) { gone = error as TapError; }
      expect([gone?.errorClass, gone?.action, gone?.detail]).toEqual(["registry_unreadable", "tap doctor", `acting registry is gone: ${reg}`]);
      writeFileSync(reg, JSON.stringify({ schema: "0.20", seats: { peer: { status: "active" }, gone: "not a row" } }));
      expect(targetRegistered(reg, "peer")).toBe(true);
      expect(targetRegistered(reg, "gone")).toBe(false);                    // a non-object value is not a row (python's isinstance(ent, dict))
      expect(targetRegistered(reg, "nosuch")).toBe(false);
      for (const bad of ["{not json", '{"schema": "0.20", "seats": {"peer": {"n": 1.5}}}', '{"schema": "0.20", "seats": {"peer": {"n": 9007199254740993}}}']) {
        writeFileSync(reg, bad);
        let e: TapError | null = null;
        try { targetRegistered(reg, "peer"); } catch (error) { e = error as TapError; }
        expect(e?.errorClass, bad).toBe("registry_unreadable");
        expect(e?.action).toBe("tap doctor");
        expect(e?.detail.startsWith("acting registry cannot be read: ")).toBe(true);
      }
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
  test("admission order is the incumbent service's: the clock, then the schedule grammar, then the body -- a bad schedule with a body that can no longer be read is the grammar refusal", () => {
    const work = scratch();
    try {
      const state = join(work, "watch", "reminders.json");
      let reads = 0;
      const vanished = () => { reads++; throw Object.assign(new Error("ENOENT: no such file or directory, open 'gone'"), { code: "ENOENT" }); };
      // two defects: the grammar wins, and the body is never read for a refused schedule
      expect(() => admit(state, "me", "peer", ["--in", "abc"], vanished, {})).toThrow("duration must be a positive integer followed by s, m, h, or d");
      expect(reads).toBe(0);
      // the clock before the grammar (the CLI door read it first too)
      expect(() => admit(state, "me", "peer", ["--in", "abc"], vanished, { TAP_WATCH_NOW: "x" })).toThrow("TAP_WATCH_NOW must be an integer");
      expect(reads).toBe(0);
      // a good schedule with the body gone: the read's own error, and nothing published
      expect(() => admit(state, "me", "peer", ["--in", "8m"], vanished, { TAP_WATCH_NOW: "1000" })).toThrow("ENOENT");
      expect(reads).toBe(1);
      expect(existsSync(state)).toBe(false);
      // and the happy path through the same door
      const id = admit(state, "me", "peer", ["--in", "8m"], () => "body\n", { TAP_WATCH_NOW: "1000" });
      expect((JSON.parse(readFileSync(state, "utf8")) as Rows)[id]!.due_at).toBe(1480);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
  test("a body file that passes its checks and then cannot be read is the queue's own line, never a stack trace", () => {
    // The verb reads the file INSIDE its queue boundary (`queueRefusalOf`), after the
    // target's membership, as the incumbent's `add` did -- so a read that fails past
    // `-e/-f/-r` (the file gone or unreadable between the check and the read) renders
    // as `tap remind: <reason>`, status 1, exactly as the incumbent's child printed it.
    // The harness cannot pause the verb between the check and the read, so the boundary
    // is driven with the read it wraps: the same `readFileSync` over a path that is gone.
    const work = scratch();
    try {
      const gone = join(work, "gone");
      let rendered = "";
      const orig = process.stderr.write.bind(process.stderr);
      (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { rendered += s; return true; };
      let result: unknown = "unset";
      try { result = queueRefusalOf(() => readFileSync(gone)); }
      finally { (process.stderr as unknown as { write: typeof orig }).write = orig; }
      expect(result).toBeNull();
      expect(rendered).toMatch(/^tap remind: ENOENT: no such file or directory, open '.*gone'\n$/);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
});

describe("the R1<->R2 seam: one reason for one malformed queue", () => {
  test("a queue whose root is not an object -- null, an array, a number -- is refused with ONE stable reason by list, by the loop's delay door and by fire", () => {
    const work = scratch();
    try {
      const state = join(work, "watch", "reminders.json"); mkdirSync(join(work, "watch"));
      for (const root of ["null", "[]", "42", '"queue"']) {
        writeFileSync(state, root);
        const want = `reminders queue is not an object: ${state}`;
        let list = "", delayReason = "", fireReason = "";
        try { listText(state, false); } catch (e) { list = (e as Error).message; }
        try { delayFor(state, 60, 1000); } catch (e) { delayReason = (e as Error).message; }
        try { fire(state, work, "1", 1000); } catch (e) { fireReason = (e as Error).message; }
        expect([list, delayReason, fireReason], root).toEqual([want, want, want]);
        expect(() => readRows(state)).toThrow(want);
      }
      // the absent file and the empty object are the empty queue, not a malformed one
      rmSync(state); expect(readRows(state)).toEqual({});
      writeFileSync(state, "{}"); expect(readRows(state)).toEqual({});
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
});

describe("the body decode (rule 40) and the file-kind operators (rule 38)", () => {
  // The verb checks the body AFTER identity, and this process has no registered pane,
  // so the doors themselves are exercised at the smoke's public route
  // (remind-verb-closure.test.sh: the three markers through stdin and the file, the
  // dir / symlink / dangling / fifo / unreadable rows). What this file asserts is the
  // contract those doors rest on: the queue's file read and the verb's byte decode
  // agree on the three markers, and the operators answer as `[ -f ]` did.
  test("readFileSync(path, 'utf8') and the verb's TextDecoder(ignoreBOM) agree on the three markers and on invalid bytes", () => {
    const work = scratch();
    try {
      for (const [name, bytes] of [["bom8", "\xef\xbb\xbfhi\n"], ["bom16le", "\xff\xfeh\x00i\x00"], ["bom16be", "\xfe\xff\x00h\x00i"], ["bad", "a\xffb\n"]] as Array<[string, string]>) {
        const p = join(work, name); writeFileSync(p, Buffer.from(bytes, "latin1"));
        const viaFile = readFileSync(p, "utf8");
        const viaBytes = new TextDecoder("utf-8", { ignoreBOM: true }).decode(readFileSync(p));
        expect(viaBytes, name).toBe(viaFile);
        if (name === "bom8") expect(viaFile.charCodeAt(0)).toBe(0xfeff);
        // and the door the verb must NOT use strips it
        if (name === "bom8") expect(new TextDecoder().decode(readFileSync(p)).charCodeAt(0)).not.toBe(0xfeff);
      }
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
  test("a symlink to a directory and a fifo are 'not a regular file' by the operator, never opened (a fifo opened would block)", () => {
    const work = scratch();
    try {
      mkdirSync(join(work, "dir")); symlinkSync(join(work, "dir"), join(work, "link"));
      spawnSync("mkfifo", [join(work, "fifo")]);
      // the operator the verb applies is statSync().isFile() after following symlinks
      expect(statSync(join(work, "link")).isFile()).toBe(false);
      expect(statSync(join(work, "fifo")).isFile()).toBe(false);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
});
