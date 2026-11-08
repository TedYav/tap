import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { TapError } from "../src/context";
import { productionRoster, activityVerdict, isFanoutArgv, parseFanoutArgs, recheck, runFanout, seatActivity, type FanoutEffects, type FanoutRow } from "../src/verbs/nudge-fanout";

function row(handle: string, harness: string, status = "active", delivery = "pane", statusReason = ""): FanoutRow {
  return { handle, harness, status, delivery, statusReason, agentState:"error", agentStateReason:"fixture_error", instance: `${handle}-i1`, session: "", pane: "", observedPaneId: "", observedServerEpoch: "", attached: "0" } as FanoutRow;
}

const ROSTERS: Record<string, FanoutRow[]> = {
  "/a/registry.json": [
    row("me", "codex"), row("cx1", "codex"), row("cl1", "claude"),
    row("cxpoll", "codex", "active", "poll"), row("cxoff", "codex", "offline", "pane", "server_epoch_stale"),
  ],
  "/b/registry.json": [row("cx2", "codex-mini"), row("cxsusp", "codex", "suspended", "pane", "stored_status")],
};

function effects(over: Partial<FanoutEffects> = {}) {
  const sent: string[] = [];
  const out: string[] = [];
  const fx: FanoutEffects = {
    teams: () => [{ team: "a", registryLocation: "/a/registry.json" }, { team: "b", registryLocation: "/b/registry.json" }],
    roster: loc => ({ rows: ROSTERS[loc]! }),
    // Activity is read only under --active-within; any other read is a defect.
    activity: () => { throw new Error("unexpected activity read"); },
    now: () => NOW,
    nudge: seat => { sent.push(`${seat.team}/${seat.handle}`); return 0; },
    confirm: () => { throw new Error("unexpected prompt"); },
    interactive: () => false,
    out: text => { out.push(text); },
    err: () => {},
    ...over,
  };
  return { fx, sent, out };
}

const NOW = 1_800_000_000;
const self = { team: "a", handle: "me" };
const args = (argv: string[]) => parseFanoutArgs(argv);

test("only --harness/--team select the fan-out; the single-peer form is untouched", () => {
  expect(isFanoutArgv(["peer"])).toBe(false);
  expect(isFanoutArgv(["team/peer", "--pane", "%1"])).toBe(false);
  expect(isFanoutArgv(["--harness", "codex"])).toBe(true);
  expect(isFanoutArgv(["--team", "*"])).toBe(true);
});

test("parse refuses a peer, an unknown harness, a missing --harness, --to/--pane and a bad --message", () => {
  const refusal = (argv: string[]) => { try { parseFanoutArgs(argv); return ""; } catch (e) { return (e as TapError).detail; } };
  expect(refusal(["--harness", "codex", "peer"])).toContain("takes no peer");
  expect(refusal(["--harness", "gpt"])).toContain("unknown harness 'gpt'");
  expect(refusal(["--team", "*"])).toContain("--harness is required");
  expect(refusal(["--harness", "codex", "--to", "x"])).toContain("selects its seats by family");
  expect(refusal(["--harness", "codex", "--pane", "%1"])).toContain("--pane is not available");
  expect(refusal(["--harness", "codex", "--message", "ask @luna"])).toContain("use tap send");
  expect(refusal(["--harness", "codex", "-m", "x"])).toContain("unknown option '-m'");
  expect(refusal(["--harness", "codex", "--bogus"])).toContain("unknown option '--bogus'");
});

test("--dry-run across all teams lists every matching seat with its verdict and sends nothing", () => {
  const { fx, sent, out } = effects();
  expect(runFanout(args(["--harness", "codex", "--team", "*", "--dry-run"]), self, fx)).toBe(0);
  expect(sent).toEqual([]);
  const text = out.join("");
  expect(text).toContain("2 codex seat(s) to nudge across all teams, stuck only (dry run; nothing sent)");
  expect(text).toContain("a/cx1  target");
  expect(text).toContain("b/cx2  target");
  expect(text).toContain("a/me  skip: self");
  expect(text).toContain("a/cxpoll  skip: poll-mode");
  expect(text).toContain("a/cxoff  skip: offline (server_epoch_stale)");
  expect(text).toContain("b/cxsusp  skip: suspended (stored_status)");
  expect(text).not.toContain("cl1");
});

test("--team defaults to the caller's team", () => {
  const { fx, out } = effects();
  runFanout(args(["--harness", "codex", "--dry-run"]), self, fx);
  expect(out.join("")).toContain("1 codex seat(s) to nudge across team 'a'");
  expect(out.join("")).not.toContain("b/");
});

test("an unknown team refuses before any send", () => {
  const { fx } = effects();
  expect(() => runFanout(args(["--harness", "codex", "--team", "zzz"]), self, fx)).toThrow("not enrolled");
});

test("without a TTY, a multi-seat or '*' nudge requires --yes and sends nothing", () => {
  const { fx, sent } = effects();
  let error: TapError | undefined;
  try { runFanout(args(["--harness", "codex", "--team", "*"]), self, fx); } catch (e) { error = e as TapError; }
  expect(error?.errorClass).toBe("confirmation_required");
  expect(sent).toEqual([]);
});

test("a TTY decline sends nothing and exits 0 (CLI-EXIT-0); --yes skips the prompt", () => {
  const declined = effects({ interactive: () => true, confirm: () => false });
  expect(runFanout(args(["--harness", "codex", "--team", "*"]), self, declined.fx)).toBe(0);
  expect(declined.sent).toEqual([]);
  // Declining does not hide a cannot-check team: the run still fails for it.
  const partial = effects({ interactive: () => true, confirm: () => false, roster: loc => loc.startsWith("/a") ? { error: "registry unreadable" } : { rows: ROSTERS[loc]! } });
  expect(runFanout(args(["--harness", "codex", "--team", "*"]), self, partial.fx)).toBe(1);
  expect(partial.sent).toEqual([]);
  const yes = effects();
  expect(runFanout(args(["--harness", "codex", "--team", "*", "--yes"]), self, yes.fx)).toBe(0);
  expect(yes.sent).toEqual(["a/cx1", "b/cx2"]);
});

test("the dry run names the wire each seat would get, and --no-interrupt", () => {
  const { fx, out } = effects();
  runFanout(args(["--harness", "codex", "--team", "a", "--dry-run", "--message", 'say "hi"', "--no-interrupt"]), self, fx);
  expect(out.join("")).toContain('each seat: the nudge ladder, then [[TAP v0.23 nudge message="If TAP interrupted you, it was not the user; resume unless the user or this message says stop. say \\"hi\\""]] (--no-interrupt)');
});

test("--active-within takes a duration that names its unit; a bare number refuses with a hint", () => {
  expect(args(["--harness", "codex"]).activeWithin).toBeNull();
  for (const [text, seconds] of [["90s", 90], ["30m", 1800], ["2h", 7200], ["1d", 86400]] as const) {
    expect(args(["--harness", "codex", "--active-within", text]).activeWithin).toEqual({ seconds, text });
  }
  const refusal = (argv: string[]) => { try { parseFanoutArgs(argv); return ""; } catch (e) { return (e as TapError).detail; } };
  const needs = (bad: string) => `--active-within needs a duration with a unit (s, m, h or d), e.g. 30m or 2h; got '${bad}'`;
  expect(refusal(["--harness", "codex", "--active-within", "30"])).toBe(`${needs("30")} (add a unit: 30s for seconds, 30m for minutes)`);
  for (const bad of ["0", "0m", "-5m", "1.5h", "30min", "30M", "1w", " 30m", "1e3s", "999999999999999999d"]) {
    expect(refusal(["--harness", "codex", "--active-within", bad])).toBe(needs(bad));
  }
  expect(refusal(["--harness", "codex", "--active-within"])).toContain("--active-within needs a value");
  // A valued flag consumes its value, so the value never reads as a stray peer.
  expect(isFanoutArgv(["--active-within", "--harness"])).toBe(false);
});

test("activityVerdict: inside the window is a target; older, unknown or future-dated evidence skips", () => {
  const w = { seconds: 1800, text: "30m" };
  expect(activityVerdict(NOW - 1800, NOW, w)).toEqual({ verdict: { kind: "target" }, age: 1800 });
  expect(activityVerdict(NOW - 0.4, NOW, w)).toEqual({ verdict: { kind: "target" }, age: 1 });
  expect(activityVerdict(NOW - 1801, NOW, w)).toEqual({ verdict: { kind: "skip", reason: "last active 30m ago, over --active-within 30m" }, age: 1801 });
  expect(activityVerdict(null, NOW, w).verdict).toEqual({ kind: "skip", reason: "activity unknown (this harness keeps no activity record TAP can read)" });
  expect(activityVerdict(Number.NaN, NOW, w).verdict.kind).toBe("skip");
  expect(activityVerdict(NOW + 5, NOW, w).verdict).toEqual({ kind: "skip", reason: "activity unknown (its activity record is dated in the future)" });
});

test("--active-within nudges only recently active targets, lists the rest with their age, and reads no skipped seat", () => {
  const last: Record<string, number | null> = { cx1: NOW - 240, cx2: NOW - 3 * 3600 - 300 };
  const reads: string[] = [];
  const dry = effects({ activity: row => { reads.push(row.handle); return last[row.handle] ?? null; } });
  expect(runFanout(args(["--harness", "codex", "--team", "*", "--active-within", "30m", "--dry-run"]), self, dry.fx)).toBe(0);
  const text = dry.out.join("");
  expect(text).toContain("1 codex seat(s) to nudge across all teams, active within 30m (dry run; nothing sent)");
  expect(text).toContain("a/cx1  target (last active 4m ago)");
  expect(text).toContain("b/cx2  skip: last active 3h05m ago, over --active-within 30m");
  expect(text).toContain("a/cxoff  skip: offline (server_epoch_stale)");
  // Self, poll, offline and suspended seats are skipped before any activity read.
  expect(reads).toEqual(["cx1", "cx2"]);
  const live = effects({ activity: row => last[row.handle] ?? null });
  expect(runFanout(args(["--harness", "codex", "--team", "*", "--active-within", "30m", "--yes"]), self, live.fx)).toBe(0);
  expect(live.sent).toEqual(["a/cx1"]);
});

test("--active-within skips a seat with no readable activity record instead of waking it", () => {
  const { fx, out, sent } = effects({ activity: () => null });
  expect(runFanout(args(["--harness", "codex", "--team", "*", "--active-within", "10m", "--yes"]), self, fx)).toBe(0);
  expect(sent).toEqual([]);
  expect(out.join("")).toContain("0 codex seat(s) to nudge across all teams, active within 10m");
  expect(out.join("")).toContain("a/cx1  skip: activity unknown (this harness keeps no activity record TAP can read)");
});

test("one held seat is reported and never stops the others; exit is nonzero", () => {
  const { fx, out, sent } = effects({
    nudge: seat => {
      if (seat.handle === "cx1") throw new TapError(1, "nudge_held", "tap peek a/cx1", "the composer holds a draft; nothing sent");
      sent.push(`${seat.team}/${seat.handle}`); return 0;
    },
  });
  expect(runFanout(args(["--harness", "codex", "--team", "*", "--yes"]), self, fx)).toBe(1);
  expect(out.join("")).toContain("a/cx1  held (nudge_held: the composer holds a draft; nothing sent)");
  expect(sent).toEqual(["b/cx2"]);
});

test("an unreadable team is reported and fails the run without blocking other teams", () => {
  const { fx, sent } = effects({ roster: loc => loc.startsWith("/a") ? { error: "registry unreadable" } : { rows: ROSTERS[loc]! } });
  expect(runFanout(args(["--harness", "codex", "--team", "*", "--yes"]), self, fx)).toBe(1);
  expect(sent).toEqual(["b/cx2"]);
});

test("a seat ending with a possible effect makes the run exit 5 with a do-not-re-nudge line", () => {
  const { fx, out } = effects({ nudge: seat => seat.handle === "cx2" ? 5 : 0 });
  expect(runFanout(args(["--harness", "codex", "--team", "*", "--yes"]), self, fx)).toBe(5);
  expect(out.join("")).toContain("1 seat(s) ended with a possible effect; inspect them (tap peek) before nudging again");
});

test("an unreadable team fails the dry run too, and an explicitly named one is not unknown_team", () => {
  const { fx, out } = effects({ roster: () => ({ error: "registry unreadable at /gone" }) });
  expect(runFanout(args(["--harness", "codex", "--team", "a", "--dry-run"]), self, fx)).toBe(1);
  expect(out.join("")).toContain("unreadable teams: 1");
});

test("recheck refuses a replaced, re-harnessed, poll or inactive seat at send time", () => {
  const live = { instance: "i1", harness: "codex", status: "active", delivery: "pane" };
  expect(recheck(live, "codex", "i1")).toBeNull();
  expect(recheck({ ...live, harness: "codex-mini" }, "codex", "i1")).toBeNull();
  expect(recheck(undefined, "codex", "i1")).toContain("no longer registered");
  expect(recheck({ ...live, instance: "i2" }, "codex", "i1")).toContain("replaced");
  expect(recheck({ ...live, harness: "claude" }, "codex", "i1")).toContain("harness is now 'claude'");
  expect(recheck({ ...live, delivery: "poll" }, "codex", "i1")).toContain("poll-mode");
  expect(recheck({ ...live, status: "suspended" }, "codex", "i1")).toContain("now suspended");
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("public --harness --dry-run classifies the seat, ignores TAP_SELF, and touches no pane", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-nudge-fanout-"));
  roots.push(root);
  for (const p of ["bus", "index", ".tap"]) mkdirSync(join(root, p), { recursive: true });
  symlinkSync(join(root, "bus"), join(root, ".tap/bus"));
  writeFileSync(join(root, "bus/registry.json"), JSON.stringify({ schema: "0.20", team: { name: "testteam" }, seats: {
    peer: { session: "testteam/peer", pane: "testteam/peer:0.0", pane_id: "%301", harness: "codex", status: "active" } } }));
  writeFileSync(join(root, "index/global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    testteam: { root, registry_location: join(root, "bus/registry.json") } } }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), TAP_HOME: join(root, "bus"),
    TAP_INDEX_HOME: join(root, "index"), TAP_SELF: "peer" };
  delete env.TMUX; delete env.TMUX_PANE;
  const run = spawnSync("bash", [resolve(import.meta.dir, "../../../bin/tap"), "nudge", "--harness", "codex", "--dry-run"],
    { cwd: root, env, encoding: "utf8", timeout: 25000 });
  expect({ status: run.status, stderr: run.stderr }).toMatchObject({ status: 0 });
  // TAP_SELF names the seat, but the actor comes from a bound pane only: the seat is
  // classified on its own (here unobservable, no tmux), never skipped as "self".
  expect(run.stdout).toContain("testteam/peer  skip: unknown (session_unobservable)");
  expect(run.stdout).not.toContain("skip: self");
  expect(run.stdout).toContain("dry run; nothing sent");
}, 30000);

test("the production activity reader dates real transcripts: recent wakes; stale, relative or missing records skip", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-nudge-activity-"));
  roots.push(root);
  const now = Math.trunc(Date.now() / 1000);
  const record = (path: string, line: object, mtime: number) => { writeFileSync(path, JSON.stringify(line) + "\n"); utimesSync(path, mtime, mtime); return path; };
  const codexEnd = { type: "event_msg", payload: { type: "task_complete" } };
  const seat = (handle: string, harness: string, fields: Partial<FanoutRow>): FanoutRow => ({ ...row(handle, harness), ...fields });
  const codexRows = [
    seat("fresh", "codex", { transcriptPath: record(join(root, "fresh.jsonl"), codexEnd, now - 240) }),
    seat("stale", "codex-mini", { transcriptPath: record(join(root, "stale.jsonl"), codexEnd, now - 3 * 3600) }),
    seat("relative", "codex", { transcriptPath: "fresh.jsonl" }),
    seat("missing", "codex", { transcriptPath: join(root, "absent.jsonl") }),
  ];
  // Claude seats with no registered path resolve <session>.jsonl under HOME's projects dir.
  const projects = join(root, "home", ".claude", "projects", "-repo");
  mkdirSync(projects, { recursive: true });
  record(join(projects, "sess-1.jsonl"), { type: "assistant", message: { stop_reason: "end_turn" } }, now - 60);
  const claudeRows = [seat("cl", "claude", { harnessSessionId: "sess-1" }), seat("clnone", "claude", { harnessSessionId: "sess-404" })];
  const env = { HOME: join(root, "home") };
  const run = (harness: string, rows: FanoutRow[]) => {
    const fx = effects({ teams: () => [{ team: "t", registryLocation: "/t/registry.json" }], roster: () => ({ rows }),
      activity: r => seatActivity(r, env), now: () => now });
    expect(runFanout(args(["--harness", harness, "--team", "t", "--active-within", "30m", "--yes"]), { team: "t", handle: "me" }, fx.fx)).toBe(0);
    return { sent: fx.sent, text: fx.out.join("") };
  };
  const codex = run("codex", codexRows);
  expect(codex.sent).toEqual(["t/fresh"]);
  expect(codex.text).toContain("t/fresh  target (last active 4m ago)");
  expect(codex.text).toContain("t/stale  skip: last active 3h00m ago, over --active-within 30m");
  expect(codex.text).toContain("t/relative  skip: activity unknown");
  expect(codex.text).toContain("t/missing  skip: activity unknown");
  const claude = run("claude", claudeRows);
  expect(claude.sent).toEqual(["t/cl"]);
  expect(claude.text).toContain("t/clnone  skip: activity unknown");
});

test("the single-seat form refuses --active-within before reading anything", async () => {
  const { cmdNudge } = await import("../src/verbs/nudge");
  let error: TapError | undefined;
  try { cmdNudge(["tap/peer", "--active-within", "30m"], "", new Set()); } catch (e) { error = e as TapError; }
  expect(error?.errorClass).toBe("usage_error");
  expect(error?.detail).toBe("--active-within selects seats for the --harness fan-out; tap nudge <peer> always nudges the seat it names; nothing sent");
});

test("the fan-out hands each seat's selected instance to its nudge, and a replaced seat refuses", async () => {
  const { instanceDrift } = await import("../src/verbs/nudge");
  const root = mkdtempSync(join(tmpdir(), "tap-nudge-pin-"));
  roots.push(root);
  const registry = join(root, "registry.json");
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "a" }, seats: { cx1: { instance: "cx1-i2" } } }));
  expect(() => instanceDrift(registry, "cx1", "")).not.toThrow();
  expect(() => instanceDrift(registry, "cx1", "cx1-i2")).not.toThrow();
  expect(() => instanceDrift(registry, "cx1", "cx1-i1")).toThrow("replaced after selection");
});

test("default selects stuck seats; recently-working widens by dated work; all is explicit", () => {
  const states = [
    {...row("error", "codex"),agentState:"error"}, {...row("blocked", "codex"),agentState:"blocked"},
    {...row("working", "codex"),agentState:"working"}, {...row("recent", "codex"),agentState:"idle",turnEndedAt:NOW-120},
    {...row("old", "codex"),agentState:"idle",turnEndedAt:NOW-121}, {...row("future", "codex"),agentState:"idle",turnEndedAt:NOW+1},
    {...row("unknown", "codex"),agentState:"unknown"},
  ] as FanoutRow[];
  for (const [flags, expected] of [
    [[], ["error","blocked"]], [["--recently-working"],["error","blocked","working","recent"]],
    [["--all"],["error","blocked","working","recent","old","future","unknown"]],
  ] as [string[],string[]][]) {
    const f = effects({roster:()=>({rows:states})});
    expect(runFanout(args(["--harness","codex","--yes",...flags]),self,f.fx)).toBe(0);
    expect(f.sent).toEqual(expected.map(h=>`a/${h}`));
  }
  for (const flags of [["--all","--recently-working"],["--all","--active-within","30m"],["--recently-working","--active-within","30m"]])
    expect(()=>args(["--harness","codex",...flags])).toThrow("cannot be combined");
  expect(()=>args(["--harness","codex","--recently-working=2"])).toThrow("unit");
});


test("production roster classifies a live quota-error pane before default selection", () => {
  const saved = {...process.env};
  const root = mkdtempSync(join(tmpdir(), "tap-nudge-state-")); roots.push(root);
  const bin = join(root,"bin"); mkdirSync(bin);
  const frame = join(root,"frame");
  writeFileSync(frame, readFileSync(join(import.meta.dir,"fixtures/agent-state/errors/codex-usage-limit.ansi")));
  writeFileSync(join(bin,"tmux"), `#!/bin/sh
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
list-sessions) printf 't/peer\\t1:1\\t1\\n' ;;
list-panes) printf 't/peer\\tt/peer:0.0\\t%%7\\tcodex\\t123\\t1:1\\t0\\n' ;;
capture-pane) cat '${frame}' ;;
display-message) case "$*" in *pane_title*) printf 'Codex\\n' ;; *) printf '1:1\\n' ;; esac ;;
*) exit 1 ;;
esac
`, {mode:0o755});
  const registry = join(root,"registry.json");
  writeFileSync(registry, JSON.stringify({schema:"0.20",team:{name:"t",root},seats:{peer:{
    instance:"peer-i1",status:"active",delivery:"pane",harness:"codex",pane_id:"%7",pane:"t/peer:0.0",session:"t/peer",server_epoch:"srv:1:1",
  }}}));
  try {
    Object.assign(process.env,{PATH:`${bin}:${saved.PATH}`,TAP_SERVER_EPOCH:"srv:1:1"});
    const observed = productionRoster(resolve(import.meta.dir,"../../../skills/tap/scripts"))(registry,"t");
    expect("rows" in observed).toBe(true);
    if (!("rows" in observed)) throw Error(observed.error);
    expect(observed.rows[0]).toMatchObject({agentState:"error",agentStateReason:"usage_limit"});
    expect(productionRoster(resolve(import.meta.dir,"../../../skills/tap/scripts"))(registry,"t","missing")).toEqual({rows:[]});
    const f=effects({roster:()=>observed});
    expect(runFanout(args(["--harness","codex","--yes"]),self,f.fx)).toBe(0);
    expect(f.sent).toEqual(["a/peer"]);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env,saved);
  }
});
