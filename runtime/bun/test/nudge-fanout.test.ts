import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { TapError } from "../src/context";
import { isFanoutArgv, parseFanoutArgs, recheck, runFanout, type FanoutEffects, type FanoutRow } from "../src/verbs/nudge-fanout";

function row(handle: string, harness: string, status = "active", delivery = "pane", statusReason = ""): FanoutRow {
  return { handle, harness, status, delivery, statusReason, instance: `${handle}-i1`, session: "", pane: "", observedPaneId: "", observedServerEpoch: "", attached: "0" } as FanoutRow;
}

const ROSTERS: Record<string, FanoutRow[]> = {
  "/a/registry.json": [
    row("me", "codex"), row("cx1", "codex"), row("cl1", "claude"),
    row("cxpoll", "codex", "active", "poll"), row("cxoff", "codex", "offline", "pane", "server_epoch_stale"),
  ],
  "/b/registry.json": [row("cx2", "codex-mini"), row("cxsusp", "codex", "suspended", "pane", "stored_status")],
};

function effects(over: Partial<FanoutEffects> = {}) {
  const sent: string[][] = [];
  const out: string[] = [];
  const fx: FanoutEffects = {
    teams: () => [{ team: "a", registryLocation: "/a/registry.json" }, { team: "b", registryLocation: "/b/registry.json" }],
    roster: loc => ({ rows: ROSTERS[loc]! }),
    send: (_seat, argv) => { sent.push(argv); return { rc: 0, disposition: "delivered" }; },
    confirm: () => { throw new Error("unexpected prompt"); },
    refuseOperatorConflicts: () => {},
    recheckSender: () => {},
    confirmOperator: () => { throw new Error("unexpected operator prompt"); },
    interactive: () => false,
    out: text => { out.push(text); },
    err: () => {},
    ...over,
  };
  return { fx, sent, out };
}

const self = { team: "a", handle: "me" };
const args = (argv: string[]) => parseFanoutArgs(argv);

test("only --harness/--team select the fan-out; the single-peer form is untouched", () => {
  expect(isFanoutArgv(["peer"])).toBe(false);
  expect(isFanoutArgv(["team/peer", "--pane", "%1"])).toBe(false);
  expect(isFanoutArgv(["--harness", "codex"])).toBe(true);
  expect(isFanoutArgv(["--team", "*"])).toBe(true);
});

test("parse refuses a peer, an unknown harness, a missing --harness, and -m with -f", () => {
  const refusal = (argv: string[]) => { try { parseFanoutArgs(argv); return ""; } catch (e) { return (e as TapError).detail; } };
  expect(refusal(["--harness", "codex", "peer"])).toContain("takes no peer");
  expect(refusal(["--harness", "gpt"])).toContain("unknown harness 'gpt'");
  expect(refusal(["--team", "*"])).toContain("--harness is required");
  expect(refusal(["--harness", "codex", "-m", "x", "-f", "y"])).toContain("either -m or -f");
  expect(refusal(["--harness", "codex", "--bogus"])).toContain("unknown option '--bogus'");
});

test("--dry-run across all teams lists every matching seat with its verdict and sends nothing", () => {
  const { fx, sent, out } = effects();
  expect(runFanout(args(["--harness", "codex", "--team", "*", "--dry-run"]), self, fx)).toBe(0);
  expect(sent).toEqual([]);
  const text = out.join("");
  expect(text).toContain("2 codex seat(s) to nudge across all teams (dry run; nothing sent)");
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

test("a TTY decline sends nothing; --yes skips the prompt", () => {
  const declined = effects({ interactive: () => true, confirm: () => false });
  expect(runFanout(args(["--harness", "codex", "--team", "*"]), self, declined.fx)).toBe(1);
  expect(declined.sent).toEqual([]);
  const yes = effects();
  expect(runFanout(args(["--harness", "codex", "--team", "*", "--yes"]), self, yes.fx)).toBe(0);
  expect(yes.sent.map(argv => argv[0])).toEqual(["a/cx1", "b/cx2"]);
});

test("each seat gets one settle-only note from the caller with the default body, or -m verbatim", () => {
  const { fx, sent } = effects();
  runFanout(args(["--harness", "codex", "--team", "a"]), self, fx);
  expect(sent).toHaveLength(1);
  const [address, flag, body, ...rest] = sent[0]!;
  expect([address, flag]).toEqual(["a/cx1", "-m"]);
  expect(body).toContain("Automated nudge from me");
  expect(rest).toEqual(["--from", "me", "--fyi"]);
  const custom = effects();
  runFanout(args(["--harness", "codex", "--team", "a", "-m", "limit reset `now`"]), self, custom.fx);
  expect(custom.sent[0]!.slice(1, 3)).toEqual(["-m", "limit reset `now`"]);
  const file = effects();
  runFanout(args(["--harness", "codex", "--team", "a", "-f", "/tmp/body.md"]), self, file.fx);
  expect(file.sent[0]!.slice(1, 3)).toEqual(["-f", "/tmp/body.md"]);
});

test("one refusing seat is reported and never stops the others; exit is nonzero", () => {
  const { fx, out } = effects({
    send: (_seat, argv) => {
      if (argv[0] === "a/cx1") throw new TapError(1, "identity_mismatch", "tap doctor", "drifted");
      return { rc: 0, disposition: "queued-spool" };
    },
  });
  expect(runFanout(args(["--harness", "codex", "--team", "*", "--yes"]), self, fx)).toBe(1);
  const text = out.join("");
  expect(text).toContain("a/cx1  failed (identity_mismatch: drifted)");
  expect(text).toContain("b/cx2  queued-spool");
});

test("an unreadable team is reported and fails the run without blocking other teams", () => {
  const { fx, sent } = effects({ roster: loc => loc.startsWith("/a") ? { error: "registry unreadable" } : { rows: ROSTERS[loc]! } });
  expect(runFanout(args(["--harness", "codex", "--team", "*", "--yes"]), self, fx)).toBe(1);
  expect(sent.map(argv => argv[0])).toEqual(["b/cx2"]);
});

test("the pinned instance reaches send, and an unverified delivery exits 5 with a do-not-re-run line", () => {
  const pins: string[] = [];
  const { fx, out } = effects({
    send: (seat, argv) => { pins.push(`${argv[0]}=${seat.instance}`); return argv[0] === "b/cx2" ? { rc: 5, disposition: "unverified" } : { rc: 0, disposition: "delivered" }; },
  });
  expect(runFanout(args(["--harness", "codex", "--team", "*", "--yes"]), self, fx)).toBe(5);
  expect(pins).toEqual(["a/cx1=cx1-i1", "b/cx2=cx2-i1"]);
  const text = out.join("");
  expect(text).toContain("b/cx2  UNVERIFIED (possible effect");
  expect(text).toContain("1 unverified delivery(ies) may have landed; check tap outstanding me");
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

test("public --dry-run validates the sender like the real run and touches no target", () => {
  const root = mkdtempSync(join(tmpdir(), "tap-nudge-fanout-"));
  roots.push(root);
  for (const p of ["bus", "index", ".tap"]) mkdirSync(join(root, p), { recursive: true });
  symlinkSync(join(root, "bus"), join(root, ".tap/bus"));
  writeFileSync(join(root, "bus/registry.json"), JSON.stringify({ schema: "0.20", team: { name: "testteam" }, seats: {
    peer: { session: "testteam/peer", pane: "testteam/peer:0.0", pane_id: "%301", harness: "codex", status: "active" } } }));
  writeFileSync(join(root, "index/global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    testteam: { root, registry_location: join(root, "bus/registry.json") } } }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), TAP_HOME: join(root, "bus"),
    TAP_INDEX_HOME: join(root, "index"), TAP_SELF: "ghost" };
  delete env.TMUX; delete env.TMUX_PANE;
  const run = spawnSync("bash", [resolve(import.meta.dir, "../../../bin/tap"), "nudge", "--harness", "codex", "--dry-run"],
    { cwd: root, env, encoding: "utf8", timeout: 25000 });
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("sender 'ghost' is not an active seat");
  expect(run.stdout).not.toContain("target");
}, 30000);
