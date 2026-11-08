// The four pane detectors replay the frozen capture of the incumbent
// (fixtures/watch-detectors-oracle.json, captured from tap-watch.sh at the pinned base
// by the since-retired capture harness): every case's scripted WORLD is offered to
// the Bun runner through a fixture-backed Seams, and the runner's exit status,
// stdout, stderr and ordered effects (lease writes with their expected armed_at,
// notices, human notifications) must equal what the Bash function did.
//
// The fixture carries each world in BOTH calling shapes the live tick had (the W2b
// finding: the calling shape is part of the deleted program). `verb` ran the
// detector bare under `set -e`, as `tap watch tick` did; `loop` ran it inside
// `tap_watch_tick || true`, as the sidecar did, where errexit is ignored. The port
// is asserted against the LOOP capture; the rows where the two shapes disagree are
// exactly the rows where the verb died (rc 1), and on those the port's behaviour is
// stated per class by the R table below (leader ruling;
// every row keeps the incumbent's bytes in the
// fixture and asserts the port's):
//   A. a failed NOTIFY: the loop went on and wrote the sample as `fired` (alert
//      lost); the port ends the pass and writes nothing, so the next tick retries
//      until durable (TickAbort, rc 1).
//   B. a failed pane capture: the loop went on with an EMPTY frame (one row recorded
//      a sample of it); the port forgets that seat's sample and continues the pass.
//   C. a corrupt lease map (python raised inside `$( )`): the loop went on with ""
//      and wrote "" back, silently; the port announces it on one `tap watch:` line
//      with the bytes kept, reads `{}`, and writes the well-formed map it computed.
//      Five further rows survived in BOTH shapes: the incumbent read the corrupt map
//      as `{}` through a `try/except` without a word (on the list-alerts episode
//      path it left the list in place); the port announces the reset and writes
//      the well-formed map back on those too.
// Enumerated at the end so a dropped row reds.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { codexLivelock, contextFreeze, contextPressure, leaseMap, opencodeWedge, realSeams, TickAbort, utf8Prefix, type Seams } from "../src/watch-detectors";
import { addMessage, createOpenCodeStore } from "./support/opencode-store";
import { removeScratchTree } from "./support/scratch";

interface World {
  roster: string[];
  agents: Record<string, { pane: string; harness: string; harness_session_id: string } | null>;
  resolved: Record<string, string | null>;
  alive: Record<string, boolean>;
  capture: Record<string, string | null>;
  seat_state: Record<string, string[] | string>;
  clear_cmd: Record<string, string>;
  gauge: Record<string, string>;
  inbox_clear: Record<string, boolean>;
  oldest_inbound: Record<string, string>;
  latest_outbound: Record<string, string | null>;
  db_state: Record<string, string>;
  lease: Record<string, string>;
  lease_current: boolean[];
  notice_rc: number;
  notify_rc: number;
  set_rc: number;
}

interface Capture { rc: number; stdout: string; stderr: string; effects: string[][] }

interface Case {
  case: string;
  detector: "context-pressure" | "codex-livelock" | "context-freeze" | "opencode-wedge";
  argv: string[];
  env: Record<string, string>;
  world: World;
  verb: Capture;
  loop: Capture;
}

const oracle = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/watch-detectors-oracle.json"), "utf8")) as { captured_from: { head: string; shapes: string[] }; cases: Case[] };

/** The scripted world as a Seams; effects are recorded exactly as the Bash shims recorded them. */
function seamsOf(w: World, effects: string[][], stderr: string[]): Seams {
  const lease: Record<string, string> = { ...w.lease };
  const seatCalls: Record<string, number> = {};
  let leaseCalls = 0;
  const seq = <T>(list: T[] | T, n: number): T => {
    const arr = Array.isArray(list) ? list : [list];
    return arr[Math.min(n, arr.length - 1)]!;
  };
  return {
    rosterHandles: () => w.roster,
    agent: (h) => (h in w.agents ? w.agents[h] ?? null : null),
    resolvedPane: (h) => w.resolved[h] ?? null,
    paneAlive: (p) => w.alive[p] ?? false,
    capture: (p) => (p in w.capture ? w.capture[p] ?? null : null),
    seatState: (h) => {
      const n = seatCalls[h] ?? 0;
      seatCalls[h] = n + 1;
      return h in w.seat_state ? seq(w.seat_state[h]!, n) : "unknown";
    },
    clearCommand: (harness) => w.clear_cmd[harness] ?? "",
    contextUsed: (harness) => w.gauge[harness] ?? "",
    inboxClear: (h) => w.inbox_clear[h] ?? false,
    oldestUnsettledInbound: (h) => w.oldest_inbound[h] ?? "",
    latestOutbound: (h) => (h in w.latest_outbound ? w.latest_outbound[h] ?? null : null),
    opencodeDbTurnState: (sid) => w.db_state[sid] ?? "unknown",
    leaseField: (k) => lease[k] ?? "",
    leaseSet: (k, v, expect) => {
      effects.push(["set", k, v, expect ?? ""]);
      if (w.set_rc === 0) lease[k] = v;
      return w.set_rc;
    },
    leaseCurrent: () => seq(w.lease_current, leaseCalls++),
    sendNotice: (to, reason, evidence, kind, wake) => {
      effects.push(["notice", to, reason, evidence, kind, wake ? "--wake" : ""]);
      return w.notice_rc;
    },
    noticeOrNotify: (to, reason, evidence) => {
      effects.push(["notify", to, reason, evidence]);
      return w.notify_rc;
    },
    stderr: (line) => { stderr.push(`${line}\n`); },
    preserveCorrupt: (field, raw) => {
      effects.push(["preserve", field, raw]);
      return `<ARM>.corrupt-${field}-2000`;
    },
  };
}

function run(c: Case): { rc: number; stderr: string; effects: string[][] } {
  const effects: string[][] = [];
  const stderr: string[] = [];
  const s = seamsOf(c.world, effects, stderr);
  const [armedAt = "", nowText = "", a3 = "", a4 = ""] = c.argv;
  const now = BigInt(nowText);
  const env = { ...c.env };
  const opt = (i: number): string | undefined => (c.argv.length > i ? c.argv[i] : undefined); // `${N:-}`: absent and empty both read the lease; present is passed as given
  try {
    let rc: number;
    switch (c.detector) {
      case "context-pressure": rc = contextPressure(armedAt, now, a3, a4, s); break;
      case "codex-livelock": rc = codexLivelock(armedAt, now, a3, a4, opt(4), opt(5), s); break;
      case "context-freeze": rc = contextFreeze(armedAt, now, a3, opt(3), s, env); break;
      case "opencode-wedge": rc = opencodeWedge(armedAt, now, a3, opt(3), s, env); break;
    }
    return { rc, stderr: stderr.join(""), effects };
  } catch (error) {
    if (error instanceof TickAbort) return { rc: 1, stderr: stderr.join(""), effects };
    return { rc: 1, stderr: `${stderr.join("")}tap watch: ${(error as Error).message}\n`, effects };
  }
}

/**
 * The port's behaviour on the rows where the loop incumbent survived differently
 * (class A/B/C above). `rc`/`stderr`/`effects` are the port's; the incumbent's two
 * captures stay in the fixture and are asserted beside them (`verbDied`: the verb
 * shape recorded rc 1 -- the death R2 lets the port survive).
 */
interface Ruled { cls: "A" | "B" | "C"; verbDied: boolean; rc: number; stderr: string; effects: string[][] }

const PRESSURE_NOTICE = ["notice", "reviewer", "context-pressure: 41% context used (threshold 40%).",
  "If you are still idle with no unfinished review or unsettled inbound ask, preserve any standing brief, then use /clear to start fresh. If a review has arrived or work remains, defer this notice until after your verdict. After clearing, run tap whoami; run tap in only if offline. This is a notice, not a new work assignment.",
  "progress", "--wake"];
const PROGRESS_NOTICE = ["notice", "lead", "codex-progress: 'reviewer' has sent progress while inbound 'ask1' remains open", "latest_outbound=1700\tout9", "progress", ""];

const R: Record<string, Ruled> = {
  // A -- the loop wrote the sample as fired after the undurable NOTIFY; the port writes nothing and retries next tick
  "livelock-notify-fails": { cls: "A", verbDied: true, rc: 1, stderr: "", effects: [["notify", "lead", "codex-livelock: 'reviewer' has been Working for 400s while inbound 'ask1' is unsettled for 400s, with no observed pane or outbound progress for 500s", "timer_seconds=400; pending_id=ask1; pending_age_seconds=400; threshold_seconds=300; no_progress_seconds=500"]] },
  "freeze-notify-fails": { cls: "A", verbDied: true, rc: 1, stderr: "", effects: [["notify", "lead", "context-freeze: codex seat 'reviewer' Working timer advanced to 400s while context+scrollback stayed frozen for 500s (>= 300s; empty-inbox wait-stall)", "timer_seconds=400; frozen_seconds=500; window_seconds=300; body_sha=35a00d5854465a9e72b4b7c56c75b01352639d5366e755bdb44469e70ebea070"]] },
  "wedge-notify-fails-tui": { cls: "A", verbDied: true, rc: 1, stderr: "", effects: [["notify", "lead", "opencode-wedge: seat 'oc' turn active but transcript frozen for 500s (>= 120s) — suspected provider silent-timeout; MANUAL recovery (interrupt+resubmit) by goalie/operator", "frozen_seconds=500; threshold_seconds=120; body_sha=e8f9e71033c54653eea04dbc57253f7ea0858ed15909a9201ffb840478f6d94d; turn_source=tui-fallback; recovery=manual"]] },
  "wedge-notify-fails": { cls: "A", verbDied: true, rc: 1, stderr: "", effects: [["notify", "lead", "opencode-wedge: seat 'oc' turn active (db: in-turn) but transcript frozen for 500s (>= 120s) — suspected provider silent-timeout; MANUAL recovery (interrupt+resubmit) by goalie/operator", "frozen_seconds=500; threshold_seconds=120; body_sha=e8f9e71033c54653eea04dbc57253f7ea0858ed15909a9201ffb840478f6d94d; turn_source=db; session_id=ses1; recovery=manual"]] },
  // B -- an unread frame: the seat's sample is forgotten, the pass continues (the loop recorded sha256("") on the db row)
  "freeze-capture-fails": { cls: "B", verbDied: true, rc: 0, stderr: "", effects: [["set", "context_freeze", "{}", ""]] },
  "wedge-capture-fails-tui-with-prior": { cls: "B", verbDied: true, rc: 0, stderr: "", effects: [["set", "opencode_wedge", "{}", ""]] },
  "wedge-capture-fails-tui": { cls: "B", verbDied: true, rc: 0, stderr: "", effects: [] },
  "wedge-capture-fails-db": { cls: "B", verbDied: true, rc: 0, stderr: "", effects: [] },
  // C -- a corrupt lease map: announced, kept, read as {}, the computed map written back (the loop wrote "" back, silently)
  "pressure-lease-map-corrupt": { cls: "C", verbDied: true, rc: 0, stderr: "tap watch: lease field context_pressure is unparsable; reset to {} (was: \"not json\")\n",
    effects: [PRESSURE_NOTICE, ["set", "context_pressure", "{\"reviewer\": {\"pane\": \"%1\"}}", "1"], ["set", "context_pressure", "{\"reviewer\": {\"pane\": \"%1\"}}", "1"]] },
  "pressure-lease-map-list": { cls: "C", verbDied: true, rc: 0, stderr: "tap watch: lease field context_pressure is a list, not an object; reset to {} (was: \"[]\")\n",
    effects: [PRESSURE_NOTICE, ["set", "context_pressure", "{\"reviewer\": {\"pane\": \"%1\"}}", "1"], ["set", "context_pressure", "{\"reviewer\": {\"pane\": \"%1\"}}", "1"]] },
  "livelock-alerts-list-progress-path": { cls: "C", verbDied: true, rc: 0, stderr: "tap watch: lease field livelock_alerts is a list, not an object; reset to {} (was: \"[]\")\n",
    effects: [PROGRESS_NOTICE, ["set", "livelock_alerts", "{\"reviewer:ask1:progress\":2000}", ""], ["set", "livelock_samples", "{\"reviewer\":{\"at\":2000,\"hash\":\"d3224ba5971c198bd970ddd052220e990d4d573ec5cc4a853628b6302f60e8f9\",\"timer\":\"400\",\"fired\":0}}", ""]] },
  "livelock-alerts-string-progress-path": { cls: "C", verbDied: true, rc: 0, stderr: "tap watch: lease field livelock_alerts is a str, not an object; reset to {} (was: \"\\\"x\\\"\")\n",
    effects: [PROGRESS_NOTICE, ["set", "livelock_alerts", "{\"reviewer:ask1:progress\":2000}", ""], ["set", "livelock_samples", "{\"reviewer\":{\"at\":2000,\"hash\":\"d3224ba5971c198bd970ddd052220e990d4d573ec5cc4a853628b6302f60e8f9\",\"timer\":\"400\",\"fired\":0}}", ""]] },
  "livelock-alerts-corrupt-progress-path": { cls: "C", verbDied: false, rc: 0, stderr: "tap watch: lease field livelock_alerts is unparsable; reset to {} (was: \"not json\")\n",
    effects: [PROGRESS_NOTICE, ["set", "livelock_alerts", "{\"reviewer:ask1:progress\":2000}", ""], ["set", "livelock_samples", "{\"reviewer\":{\"at\":2000,\"hash\":\"d3224ba5971c198bd970ddd052220e990d4d573ec5cc4a853628b6302f60e8f9\",\"timer\":\"400\",\"fired\":0}}", ""]] },
  "livelock-samples-list": { cls: "C", verbDied: true, rc: 0, stderr: "tap watch: lease field livelock_samples is a list, not an object; reset to {} (was: \"[]\")\n",
    effects: [["set", "livelock_samples", "{\"reviewer\":{\"at\":2000,\"hash\":\"eadb47028fc86990d15fb2f2b87dbeb4c78b17d9f36d3576799cb5f546d13e81\",\"timer\":\"400\",\"fired\":0}}", ""]] },
  "freeze-samples-lease-corrupt": { cls: "C", verbDied: true, rc: 0, stderr: "tap watch: lease field context_freeze is a list, not an object; reset to {} (was: \"[1]\")\n",
    effects: [["set", "context_freeze", "{\"reviewer\":{\"at\":2000,\"hash\":\"35a00d5854465a9e72b4b7c56c75b01352639d5366e755bdb44469e70ebea070\",\"timer\":\"400\",\"fired\":0}}", ""]] },
  // C, both shapes survived -- the incumbent's `try/except` read the corrupt map as {} silently; the port says so (and writes {} back where the incumbent left a list in place)
  "livelock-alerts-list-episode-path": { cls: "C", verbDied: false, rc: 0, stderr: "tap watch: lease field livelock_alerts is a list, not an object; reset to {} (was: \"[]\")\n",
    effects: [["set", "livelock_alerts", "{}", ""]] },
  "livelock-samples-corrupt": { cls: "C", verbDied: false, rc: 0, stderr: "tap watch: lease field livelock_samples is unparsable; reset to {} (was: \"not json\")\n",
    effects: [["set", "livelock_samples", "{\"reviewer\":{\"at\":2000,\"hash\":\"eadb47028fc86990d15fb2f2b87dbeb4c78b17d9f36d3576799cb5f546d13e81\",\"timer\":\"400\",\"fired\":0}}", ""]] },
  "freeze-samples-arg-corrupt": { cls: "C", verbDied: false, rc: 0, stderr: "tap watch: lease field context_freeze is unparsable; reset to {} (was: \"not json\")\n",
    effects: [["set", "context_freeze", "{\"reviewer\":{\"at\":2000,\"hash\":\"35a00d5854465a9e72b4b7c56c75b01352639d5366e755bdb44469e70ebea070\",\"timer\":\"400\",\"fired\":0}}", ""]] },
  "wedge-samples-arg-corrupt": { cls: "C", verbDied: false, rc: 0, stderr: "tap watch: lease field opencode_wedge is unparsable; reset to {} (was: \"not json\")\n",
    effects: [["set", "opencode_wedge", "{\"oc\":{\"at\":2000,\"hash\":\"e8f9e71033c54653eea04dbc57253f7ea0858ed15909a9201ffb840478f6d94d\",\"timer\":\"\",\"fired\":0}}", ""]] },
};

const seen: string[] = [];

describe(`the pane detectors replay the incumbent at ${oracle.captured_from.head.slice(0, 9)} (loop shape)`, () => {
  test("the fixture carries both shapes", () => {
    expect(oracle.captured_from.shapes).toEqual(["verb", "loop"]);
    expect(oracle.cases.length).toBe(121);
  });
  for (const c of oracle.cases) {
    test(c.case, () => {
      const got = run(c);
      expect(c.verb.stdout, "the detectors print nothing").toBe("");
      expect(c.loop.stdout, "the detectors print nothing").toBe("");
      const ruled = R[c.case];
      if (ruled === undefined) {
        // the two shapes agree, and the port equals both
        expect(c.verb.rc, "an unruled row: the verb shape did not die").toBe(0);
        expect(c.loop, "an unruled row: the two shapes agree").toEqual(c.verb);
        expect(c.loop.stderr, "an unruled row carries no traceback").not.toContain("Traceback");
        expect(got.rc, "exit status").toBe(c.loop.rc);
        expect(got.stderr, "stderr").toBe(c.loop.stderr);
        expect(got.effects, "effects, in order").toEqual(c.loop.effects);
        return;
      }
      seen.push(c.case);
      expect(c.verb.rc, "the verb shape's death (R2 class) is on record").toBe(ruled.verbDied ? 1 : 0);
      expect(c.loop.rc, "the loop shape survived").toBe(0);
      if (ruled.cls === "A") expect(c.loop.effects.some((e) => e[0] === "set" && /"fired":1/.test(e[2] ?? "")), "the loop wrote the alert as fired").toBe(true);
      if (ruled.cls === "C" && ruled.verbDied) expect(c.loop.effects.some((e) => e[0] === "set" && e[2] === ""), "the loop wrote the empty string back").toBe(true);
      expect(got.rc, "exit status").toBe(ruled.rc);
      expect(got.stderr, "stderr").toBe(ruled.stderr);
      expect(got.effects, "effects, in order").toEqual(ruled.effects);
    });
  }
  test("the ruled rows are exactly the enumerated ones, and exactly the rows where the shapes disagree (plus the five both shapes healed silently)", () => {
    expect(seen.sort()).toEqual(Object.keys(R).sort());
    const disagree = oracle.cases.filter((c) => JSON.stringify(c.verb) !== JSON.stringify(c.loop)).map((c) => c.case).sort();
    expect(disagree).toEqual(Object.keys(R).filter((k) => R[k]!.verbDied).sort());
    expect(disagree.length).toBe(14);
    expect(Object.keys(R).filter((k) => !R[k]!.verbDied).sort()).toEqual([
      "freeze-samples-arg-corrupt", "livelock-alerts-corrupt-progress-path", "livelock-alerts-list-episode-path", "livelock-samples-corrupt", "wedge-samples-arg-corrupt",
    ]);
  });
});

describe("leaseMap: a corrupt lease field is announced, kept and reset", () => {
  const seams = (effects: string[][], stderr: string[], fail = false): Seams => ({
    ...seamsOf({ roster: [], agents: {}, resolved: {}, alive: {}, capture: {}, seat_state: {}, clear_cmd: {}, gauge: {}, inbox_clear: {},
      oldest_inbound: {}, latest_outbound: {}, db_state: {}, lease: {}, lease_current: [true], notice_rc: 0, notify_rc: 0, set_rc: 0 }, effects, stderr),
    preserveCorrupt: (field, raw) => { effects.push(["preserve", field, raw]); return fail ? "" : `<ARM>.corrupt-${field}-2000`; },
  });
  test("empty reads as {}; a well-formed object passes through untouched", () => {
    const effects: string[][] = []; const stderr: string[] = [];
    const s = seams(effects, stderr);
    expect(leaseMap(s, "context_freeze", "")).toBe("{}");
    expect(leaseMap(s, "context_freeze", '{"a": 1}')).toBe('{"a": 1}');
    expect(stderr).toEqual([]); expect(effects).toEqual([]);
  });
  test("small corrupt bytes ride the line verbatim (JSON-quoted, one line)", () => {
    const effects: string[][] = []; const stderr: string[] = [];
    const s = seams(effects, stderr);
    expect(leaseMap(s, "opencode_wedge", "[1,\n2]")).toBe("{}");
    expect(leaseMap(s, "opencode_wedge", "null")).toBe("{}");
    expect(leaseMap(s, "opencode_wedge", "12")).toBe("{}");
    expect(leaseMap(s, "opencode_wedge", "true")).toBe("{}");
    expect(leaseMap(s, "opencode_wedge", "{")).toBe("{}");
    expect(stderr).toEqual([
      'tap watch: lease field opencode_wedge is a list, not an object; reset to {} (was: "[1,\\n2]")\n',
      "tap watch: lease field opencode_wedge is a NoneType, not an object; reset to {} (was: \"null\")\n",
      "tap watch: lease field opencode_wedge is a int, not an object; reset to {} (was: \"12\")\n",
      "tap watch: lease field opencode_wedge is a bool, not an object; reset to {} (was: \"true\")\n",
      "tap watch: lease field opencode_wedge is unparsable; reset to {} (was: \"{\")\n",
    ]);
    expect(effects).toEqual([]);
  });
  test("bytes past 200 go to the sidecar beside the lease, and a failed sidecar write says so with the first 200", () => {
    const big = `[${"1,".repeat(120)}1]`; // 243 bytes
    const effects: string[][] = []; const stderr: string[] = [];
    expect(leaseMap(seams(effects, stderr), "livelock_samples", big)).toBe("{}");
    expect(effects).toEqual([["preserve", "livelock_samples", big]]);
    expect(stderr).toEqual([`tap watch: lease field livelock_samples is a list, not an object; reset to {} (243 bytes preserved at <ARM>.corrupt-livelock_samples-2000)\n`]);
    const effects2: string[][] = []; const stderr2: string[] = [];
    expect(leaseMap(seams(effects2, stderr2, true), "livelock_samples", big)).toBe("{}");
    expect(stderr2).toEqual([`tap watch: lease field livelock_samples is a list, not an object; reset to {} (243 bytes; preserving them FAILED, first 200 bytes shown: ${JSON.stringify(big.slice(0, 200))})\n`]);
    // the shown prefix is bounded in BYTES and ends on a code point: 150 `é` (302 bytes) show as 99 of them behind the quote (199 bytes), never 200 code units (401 bytes)
    const effects4: string[][] = []; const stderr4: string[] = [];
    const wide2 = `"${"é".repeat(150)}"`;
    expect(leaseMap(seams(effects4, stderr4, true), "context_freeze", wide2)).toBe("{}");
    expect(stderr4).toEqual([`tap watch: lease field context_freeze is a str, not an object; reset to {} (302 bytes; preserving them FAILED, first 199 bytes shown: ${JSON.stringify(`"${"é".repeat(99)}`)})\n`]);
    expect(utf8Prefix("aé😀b", 1)).toBe("a");
    expect(utf8Prefix("aé😀b", 2)).toBe("a");
    expect(utf8Prefix("aé😀b", 3)).toBe("aé");
    expect(utf8Prefix("aé😀b", 6)).toBe("aé");
    expect(utf8Prefix("aé😀b", 7)).toBe("aé😀");
    expect(utf8Prefix("aé😀b", 8)).toBe("aé😀b");
    // the 200-byte boundary is by UTF-8 bytes, not code units
    const effects3: string[][] = []; const stderr3: string[] = [];
    const wide = `"${"é".repeat(100)}"`; // 102 code units, 202 bytes
    expect(leaseMap(seams(effects3, stderr3), "context_freeze", wide)).toBe("{}");
    expect(effects3).toEqual([["preserve", "context_freeze", wide]]);
  });
});

describe("the production preserveCorrupt seam", () => {
  test("writes the bytes beside the lease as arm.json.corrupt-<field>-<now>, and reports a failed write as \"\"", () => {
    const scratch = mkdtempSync(join(tmpdir(), "watch-detectors-preserve."));
    try {
      const bus = join(scratch, "bus");
      mkdirSync(join(bus, "watch"), { recursive: true });
      const s = realSeams({ bus, scripts: join(scratch, "no-scripts"), registry: join(scratch, "no-registry.json"), now: "2000" });
      const raw = "[1,\n2]";
      const path = s.preserveCorrupt("livelock_samples", raw);
      expect(path).toBe(join(bus, "watch", "arm.json.corrupt-livelock_samples-2000"));
      expect(readFileSync(path, "utf8")).toBe(raw);
      // no watch/ directory: the write fails and the caller is told so, not thrown at
      const bare = realSeams({ bus: join(scratch, "absent"), scripts: join(scratch, "no-scripts"), registry: join(scratch, "no-registry.json"), now: "2000" });
      expect(bare.preserveCorrupt("context_freeze", raw)).toBe("");
      expect(existsSync(join(scratch, "absent", "watch"))).toBe(false);
    } finally {
      removeScratchTree(scratch);
    }
  });
});

// --- the production read seams (M6 U1) --------------------------------------------
//
// realSeams must answer clear-command, pane-alive and opencode turn state
// WITHOUT lib.sh: `scripts` points at a directory that has none. The pane rows
// drive a stub tmux on PATH whose argv is logged, so the production command
// shape (and the env/socket pass-through) is asserted, not assumed.
describe("the production read seams (M6 U1)", () => {
  const scratchSeams = (scratch: string, env?: NodeJS.ProcessEnv) =>
    realSeams({ bus: join(scratch, "bus"), scripts: join(scratch, "no-scripts"), registry: join(scratch, "no-registry.json"), now: "2000", env });

  test("clearCommand answers the pure table natively with no lib.sh present", () => {
    const scratch = mkdtempSync(join(tmpdir(), "watch-detectors-seams."));
    try {
      const s = scratchSeams(scratch);
      expect(s.clearCommand("codex")).toBe("/clear");
      expect(s.clearCommand("opencode")).toBe("/new");
      expect(s.clearCommand("shell")).toBe("");
    } finally { removeScratchTree(scratch); }
  });

  test("opencodeDbTurnState reads the fixture db through the native owner", () => {
    const scratch = mkdtempSync(join(tmpdir(), "watch-detectors-seams."));
    try {
      const db = join(scratch, "opencode.db");
      const store = createOpenCodeStore(db);
      addMessage(store, { type: "assistant", sessionID: "busy", time: { created: 1, completed: null }, finish: null });
      addMessage(store, { type: "assistant", sessionID: "done", time: { created: 2, completed: 5 }, finish: "stop" });
      store.close();
      const s = scratchSeams(scratch, { ...process.env, OPENCODE_DB_PATH: db });
      expect(s.opencodeDbTurnState("busy")).toBe("in-turn");
      expect(s.opencodeDbTurnState("done")).toBe("idle");
      expect(s.opencodeDbTurnState("ghost")).toBe("unknown");
      expect(s.opencodeDbTurnState("")).toBe("error");
    } finally { removeScratchTree(scratch); }
  });

  test("paneAlive reads tmux display-message #{pane_id}, never lib.sh", () => {
    const scratch = mkdtempSync(join(tmpdir(), "watch-detectors-seams."));
    try {
      const stubDir = join(scratch, "bin");
      const log = join(scratch, "tmux-argv.log");
      mkdirSync(stubDir, { recursive: true });
      writeFileSync(join(stubDir, "tmux"), `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
prev=""; target=""
for a in "$@"; do [ "$prev" = "-t" ] && target="$a"; prev="$a"; done
case "\$target" in
  %0) printf '%%0\\n' ;;
  %1) : ;;
  *) exit 7 ;;
esac
`);
      chmodSync(join(stubDir, "tmux"), 0o755);
      const env = { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, TAP_TMUX_SOCKET: "tapbun-watch-m6-u1" };
      const s = scratchSeams(scratch, env);
      expect(s.paneAlive("%0")).toBe(true);
      expect(s.paneAlive("%1")).toBe(false);  // tmux 3.6a: rc 0 with EMPTY expansion
      expect(s.paneAlive("%9")).toBe(false);  // unobservable: nonzero rc
      const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
      expect(calls).toContain(`-L tapbun-watch-m6-u1 display-message -p -t %0 #{pane_id}`);
    } finally { removeScratchTree(scratch); }
  });
});

describe("the production team/index facts (M6 U2)", () => {
  // The smoke's own fixture shapes: an open ask addressed to the seat, the seat's
  // outbound progress carrying the enrollment team, and a decoy acting registry
  // whose team.name is prose no detector may trust.
  const teamWorld = (scratch: string, opts?: { settled?: boolean; index?: "absent" | "live" | "invalid" }) => {
    mkdirSync(join(scratch, "scripts"), { recursive: true });   // NO lib.sh on purpose
    for (const dir of ["payloads", "spool", "receipts"]) mkdirSync(join(scratch, "bus", dir), { recursive: true });
    mkdirSync(join(scratch, "index"), { recursive: true });
    writeFileSync(join(scratch, "bus", "payloads", "ask.md"), "---\nid: ask\nfrom: leader\nto: seat\nreply: expected\nkind: order\n---\nWork order\n");
    writeFileSync(join(scratch, "bus", "spool", "progress.md"), "---\nid: progress\nfrom: seat\nfrom_team: enrolled\nto: leader\nreply: settle-only\nkind: discuss\n---\nPushed correction\n");
    utimesSync(join(scratch, "bus", "payloads", "ask.md"), 100, 100);
    utimesSync(join(scratch, "bus", "spool", "progress.md"), 1900, 1900);
    writeFileSync(join(scratch, "registry-decoy.json"), JSON.stringify({ team: { name: "decoy" } }));
    if (opts?.settled) writeFileSync(join(scratch, "bus", "receipts", "ask.done"), "");
    if (opts?.index === "live") writeFileSync(join(scratch, "index", "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
    if (opts?.index === "invalid") writeFileSync(join(scratch, "index", "global-registry.json"), "not json at all");
    return teamSeams(scratch);
  };
  const teamSeams = (scratch: string) => realSeams({
    bus: join(scratch, "bus"), scripts: join(scratch, "scripts"), registry: join(scratch, "registry-decoy.json"),
    env: { ...process.env, TAP_INDEX_HOME: join(scratch, "index") }, now: "2000", team: "enrolled",
  });
  const teamless = (scratch: string) =>
    realSeams({ bus: join(scratch, "bus"), scripts: join(scratch, "scripts"), registry: join(scratch, "registry-decoy.json"), env: process.env, now: "2000" });

  test("native team-scoped reads exclude supervisor progress with no lib.sh present", () => {
    const scratch = mkdtempSync(join(tmpdir(), "watch-detectors-team."));
    try {
      const s = teamWorld(scratch, { index: "live" });
      const note = join(scratch, "bus", "payloads", "note.md");
      writeFileSync(note, "---\nid: note\nfrom: watcher\nto: seat\nkind: progress\nreply: settle-only\n---\nProgress observed\n");
      utimesSync(note, 1, 1); // Older than the work ask; it must never age the seat's work.
      expect(s.latestOutbound("seat", 2000n)).toBe("1900\tprogress");
      expect(s.oldestUnsettledInbound("seat", 2000n)).toBe("ask\t1900");
      expect(s.inboxClear("seat")).toBe(false);
      writeFileSync(join(scratch, "bus", "receipts", "ask.done"), "");
      expect(teamSeams(scratch).oldestUnsettledInbound("seat", 2000n)).toBe("");
    } finally { removeScratchTree(scratch); }
  });

  test("a sender-cancelled ask is settled: no unsettled inbound, no pending ask (tap-nwbxf)", () => {
    const scratch = mkdtempSync(join(tmpdir(), "watch-detectors-team."));
    try {
      const s = teamWorld(scratch, { index: "live" });
      // Open first, so the cancelled receipt is the only thing that changes.
      expect(s.oldestUnsettledInbound("seat", 2000n)).toBe("ask\t1900");
      expect(s.inboxClear("seat")).toBe(false);
      writeFileSync(join(scratch, "bus", "receipts", "ask.cancelled"), "");
      expect(teamSeams(scratch).oldestUnsettledInbound("seat", 2000n)).toBe("");
      expect(s.inboxClear("seat")).toBe(true);
    } finally { removeScratchTree(scratch); }
  });

  test("a settled ask clears the inbox through the marker-selected index", () => {
    // Only a live marker names global-registry.json; absent (no enrolled team,
    // F2b) and invalid name no path and fail closed.
    for (const index of ["live", "absent", "invalid"] as const) {
      const scratch = mkdtempSync(join(tmpdir(), "watch-detectors-team."));
      try {
        expect(teamWorld(scratch, { settled: true, index }).inboxClear("seat")).toBe(index === "live");
      } finally { removeScratchTree(scratch); }
    }
  });

  test("an absent team fact fails closed and the decoy registry is never consulted", () => {
    const scratch = mkdtempSync(join(tmpdir(), "watch-detectors-team."));
    try {
      teamWorld(scratch);   // also proves the decoy team.name did not feed these reads
      const s = teamless(scratch);
      expect(s.latestOutbound("seat", 2000n)).toBeNull();
      // the incumbent never gated this read on the team fact: a missing fact degrades
      // the local-team match to "" (empty to_team is local), it does not hide the ask
      expect(s.oldestUnsettledInbound("seat", 2000n)).toBe("ask\t1900");
      expect(s.inboxClear("seat")).toBe(false);
    } finally { removeScratchTree(scratch); }
  });
});
