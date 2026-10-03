// Checkpoint A (U1): the public send/assign argv ownership rows — the flags
// whose native semantics already exist — route native, and the explicit
// `--reply-to` port reproduces the incumbent's two failure modes (hard refusal
// for an explicit typo/dead seat, soft warn-and-omit for a stale registry
// default). The parked M8SendoptsU2 draft's four arms are re-typed here under
// RED discipline and its fifth inverts: an explicit --reply-to routes native
// and wins over --no-auto-reply-to.
//
// These bodies used to also run a Bash-door vehicle (TAP_INTERNAL_OVERDUE_CHECKED=1
// straight into the retained tap.sh/tap-send.sh adapter) as a parity
// comparison. The rollback selector that used to force that arm through
// route() is gone (5de960f46), and the Bash bodies retire in the next lanes,
// so that arm is deleted rather than kept as a placebo. Every literal below
// is native's own.
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { envelopeField } from "../src/envelope";
import { REENABLED, teamFixture, payloads, flushScratch } from "./support/send-reply-flip-fixture";

afterEach(() => flushScratch(), 40_000);

function run(fx: ReturnType<typeof teamFixture>, argv: string[]) {
  const trace = join(fx.root, "route.trace");
  const result = Bun.spawnSync(
    [process.execPath, REENABLED, "send", "ub", "-m", "hello", "--from", "ua", ...argv],
    {
      cwd: fx.wt,
      env: {
        ...fx.env,
        TAP_BUN_ROUTE_TRACE: trace,
        TAP_AUTOSETTLE_HOLD_SECONDS: "3600",
        TAP_DRIVER_FORCE_TMUX: "1",
        TAP_TUI_SETTLE_SCALE: "0.1",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30000,
      killSignal: "SIGKILL",
    },
  );
  return {
    code: result.exitCode,
    trace: existsSync(trace) ? readFileSync(trace, "utf8") : "",
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString().split(fx.root).join("<root>"),
  };
}

function stampFixture() {
  return teamFixture({
    seats: { ua: { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456", instance: "ua|A", harness: "claude", reply_to: "ub" } },
  });
}

function envelope(bus: string, id: string): string {
  return readFileSync(join(bus, "payloads", `${id}.md`), "utf8");
}

describe("send argv ownership — router rows (checkpoint A, U1)", () => {
  const id = (n: string) => `ua-20260920T010${n}00Z-aabbccddeeff`;

  test("--no-auto-reply-to routes native and suppresses only the auto-stamp", () => {
    const fx = stampFixture();
    const v = run(fx, ["--ask", "--id", id("1"), "--no-auto-reply-to"]);
    expect(v.trace).toBe("native send\n");
    expect(v.code).toBe(0);
    expect(envelopeField(envelope(fx.bus, id("1")), "reply_to")).toBeUndefined();
  }, 40_000);

  test("the registry auto-stamp stamps flip/ub by default (native)", () => {
    // Native door only: the incumbent's DEFAULT-stamp path crashes on this
    // fixture shape before stamping — lib.sh:7316 `registry: unbound variable`
    // under `set -u` (measured, both at BASE and here). The explicit-stamp
    // refusals below still compare against the incumbent by hand.
    const fx = stampFixture();
    const v = run(fx, ["--ask", "--id", id("3")]);
    expect({ code: v.code, trace: v.trace, stderr: v.stderr }).toEqual({ code: 0, trace: "native send\n", stderr: expect.stringContaining("TUI settle scale") });
    expect(envelopeField(envelope(fx.bus, id("3")), "reply_to")).toBe("flip/ub");
  }, 40_000);

  test("an explicit --reply-to routes native and wins over --no-auto-reply-to", () => {
    const fx = stampFixture();
    const v = run(fx, ["--ask", "--id", id("5"), "--reply-to", "ub", "--no-auto-reply-to"]);
    expect(v.trace).toBe("native send\n");
    expect(v.code).toBe(0);
    expect(envelopeField(envelope(fx.bus, id("5")), "reply_to")).toBe("flip/ub");
  }, 40_000);

  test("--team, --wake, --in-reply-to and the proof flags route native", () => {
    for (const [n, extra] of [
      ["6", ["--team", "flip"]],
      ["7", ["--wake"]],
      ["8", ["--in-reply-to", "ub-20260920T010000Z-aabbccddeeff"]],
      ["9", ["--recipient-instance", "ub|A"]],
      ["10", ["--sender-instance", "ua|A"]],
      ["11", ["--historical-recipient"]],
    ] as const) {
      const fx = stampFixture();
      const v = run(fx, ["--ask", "--id", id(n), ...extra]);
      expect({ n, trace: v.trace, code: v.code }).toEqual({ n, trace: "native send\n", code: 0 });
    }
  }, 120_000);

  test("an explicit --reply-to stamps the bare handle team-qualified (native)", () => {
    const fx = teamFixture({});
    const v = run(fx, ["--ask", "--id", id("12"), "--reply-to", "ub"]);
    expect(v.trace).toBe("native send\n");
    expect(v.code).toBe(0);
    expect(envelopeField(envelope(fx.bus, id("12")), "reply_to")).toBe("flip/ub");
  }, 40_000);

  test("an explicit --reply-to naming the sender refuses hard with the incumbent's bytes", () => {
    const fx = teamFixture({});
    const v = run(fx, ["--ask", "--id", id("13"), "--reply-to", "ua"]);
    expect(v.code).toBe(1);
    expect(v.stderr).toContain("--reply-to names where the recipient's tap reply lands; as sender 'ua', replies already return to you — omit --reply-to");
  }, 40_000);

  test("an explicit --reply-to to a dead seat refuses hard with not_found (native)", () => {
    const fx = teamFixture({});
    const v = run(fx, ["--ask", "--id", id("14"), "--reply-to", "ghost"]);
    expect({ code: v.code, stderr: v.stderr }).toEqual({ code: 1,
      stderr: expect.stringContaining("--reply-to handle 'ghost' is not a deliverable seat in team 'flip' right now (must be an active pane member or active poll member)") });
  }, 40_000);

  test("an explicit --reply-to to an unknown team refuses hard with unknown_team (native)", () => {
    const fx = teamFixture({});
    const v = run(fx, ["--ask", "--id", id("15"), "--reply-to", "nowhere/ghost"]);
    expect(v.code).toBe(1);
    expect(v.stderr).toContain("--reply-to team 'nowhere' is unknown (not in the machine index; known sibling worktrees: <none>)");
  }, 40_000);

  test("an explicit --reply-to to a remote deliverable seat stamps the qualified address (native)", () => {
    const fx = teamFixture({});
    // Enrol a second team whose seat `rb` is deliverable, then route the stamp there.
    const otherWt = join(fx.root, "other");
    const otherBus = join(otherWt, ".tap", "bus");
    const otherRegistry = join(otherWt, ".tap", "team-registry.json");
    mkdirSync(otherBus, { recursive: true });
    writeFileSync(otherRegistry, JSON.stringify({
      schema: "0.20",
      team: { name: "other", worktree_root: otherWt },
      seats: { rb: { status: "active", pane: "rb:0.0", pane_id: "%9", server_epoch: "srv:123:456", instance: "rb|B", harness: "claude" } },
    }));
    writeFileSync(join(fx.root, "index", "global-registry.json"), JSON.stringify({
      schema: "0.20",
      teams: {
        flip: { root: fx.wt, registry_location: join(fx.wt, ".tap", "team-registry.json"), state: "registered" },
        other: { root: otherWt, registry_location: otherRegistry, state: "registered" },
      },
    }));
    const v = run(fx, ["--ask", "--id", id("16"), "--reply-to", "other/rb"]);
    expect(v.trace).toBe("native send" + "\n");
    expect(v.code).toBe(0);
    expect(envelopeField(envelope(fx.bus, id("16")), "reply_to")).toBe("other/rb");
  }, 40_000);
});

describe("send --reply-to <message-id> — the public alias composes reply in main.ts", () => {
  const INBOUND = "ub-20260919T190000Z-aabbccddeeff";

  function aliasFixture() {
    return teamFixture({ inbound: { id: INBOUND, from: "ub", to: "ua" } });
  }

  function bodyFile(fx: ReturnType<typeof teamFixture>): string {
    const path = join(fx.root, "answer.md");
    writeFileSync(path, "answer body\n");
    return path;
  }

  function execDoor(fx: ReturnType<typeof teamFixture>, verbArgv: string[], extraEnv: Record<string, string> = {}) {
    const trace = join(fx.root, "route.trace");
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, ...verbArgv],
      {
        cwd: fx.wt,
        env: { ...fx.env, TAP_BUN_ROUTE_TRACE: trace, ...extraEnv },
        stdout: "pipe", stderr: "pipe", timeout: 30000, killSignal: "SIGKILL",
      },
    );
    return {
      code: result.exitCode,
      trace: existsSync(trace) ? readFileSync(trace, "utf8") : "",
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString().split(fx.root).join("<root>"),
    };
  }

  function runAlias(fx: ReturnType<typeof teamFixture>, argv: string[]) {
    return execDoor(fx, ["send", "ub", "--reply-to", INBOUND, "-f", bodyFile(fx), ...argv], {
      TAP_AUTOSETTLE_HOLD_SECONDS: "3600",
      TAP_DRIVER_FORCE_TMUX: "1",
      TAP_TUI_SETTLE_SCALE: "0.1",
    });
  }

  test("the alias routes native reply, settles the inbound and injects the answer", () => {
    const fx = aliasFixture();
    const v = runAlias(fx, []);
    // The router traces the verb the caller typed; the alias composes INSIDE
    // the native send handler.
    expect(v.trace).toBe("native send\n");
    expect(v.code).toBe(0);
    const out = payloads(fx.bus).filter((p) => p !== `${INBOUND}.md`);
    expect(out).toHaveLength(1);
    expect(existsSync(join(fx.bus, "receipts", `${INBOUND}.done`))).toBe(true);
  }, 60_000);

  test("the alias refuses -m with the incumbent's body-source bytes", () => {
    const fx = aliasFixture();
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "--reply-to", INBOUND, "-m", "text"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe", timeout: 30000, killSignal: "SIGKILL" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("message-id --reply-to alias requires only -f <body-file> as its body source");
  }, 40_000);

  test("the alias refuses send-only options with the incumbent's bytes", () => {
    const fx = aliasFixture();
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "--reply-to", INBOUND, "-f", bodyFile(fx), "--id", "ua-20260920T019900Z-aabbccddeeff"],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe", timeout: 30000, killSignal: "SIGKILL" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("message-id --reply-to alias does not accept send-only options");
  }, 40_000);

  test("the alias refuses a mismatched target with the incumbent's bytes", () => {
    const fx = aliasFixture();
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ua", "--reply-to", INBOUND, "-f", bodyFile(fx)],
      { cwd: fx.wt, env: fx.env, stdout: "pipe", stderr: "pipe", timeout: 30000, killSignal: "SIGKILL" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("send target 'ua' does not match original sender 'ub' for reply-to");
  }, 40_000);

  // Review round 5 (r4056301885): Bash normalizes `team:handle` to
  // `team/handle` immediately after parsing, BEFORE the alias comparison
  // (tap-send.sh:168-172). Native used to compare the raw argv destination,
  // so a valid colon destination falsely refused the original-sender check.
  test("the alias accepts a colon destination (normalized before comparison)", () => {
    const fx = teamFixture({ inbound: { id: INBOUND, from: "ub", to: "ua", extra: { from_team: "flip" } } });
    const v = execDoor(fx, ["send", "flip:ub", "--reply-to", INBOUND, "-f", bodyFile(fx)], {
      TAP_AUTOSETTLE_HOLD_SECONDS: "3600", TAP_DRIVER_FORCE_TMUX: "1", TAP_TUI_SETTLE_SCALE: "0.1",
    });
    expect({ code: v.code, trace: v.trace }).toEqual({ code: 0, trace: "native send\n" });
    expect(existsSync(join(fx.bus, "receipts", `${INBOUND}.done`))).toBe(true);
    expect(payloads(fx.bus).filter((p) => p !== `${INBOUND}.md`)).toHaveLength(1);
  }, 120_000);

  // Review round 5 (r4056301885): the colon normalization runs BEFORE the
  // alias block, so a malformed colon form dies with the target's usage
  // refusal — never with the alias's sender-mismatch sentence.
  test("the alias refuses a malformed colon destination with the target's usage bytes", () => {
    const fx = aliasFixture();
    const v = execDoor(fx, ["send", "flip:ub!", "--reply-to", INBOUND, "-f", bodyFile(fx)]);
    expect(v.code).toBe(1);
    expect(v.stderr).toContain("is not a valid <team>:<handle> token");
  }, 120_000);

  // Review round 1 (important 2): the alias scans argv through the ONE shared
  // send/assign parser, so its refusals land in the parser's order — unknown
  // option and missing operand — before any alias decision.
  test("the alias's argv scan refuses unknown options and missing operands in the parser's order", () => {
    for (const [args, bytes] of [
      [["--bogus", "-f", "x"], "unknown option '--bogus'"],
      [["--reply-to"], "--reply-to needs a value"],
    ] as const) {
      const fx = aliasFixture();
      const v = execDoor(fx, ["send", "ub", ...args]);
      expect({ args, code: v.code }).toEqual({ args, code: 1 });
      expect(v.stderr).toContain(bytes);
    }
  }, 120_000);

  // Review round 1 (important 2): the obligation spellings survive the alias —
  // --ask/--reply parse to the same expectation bit --expect-reply does, and
  // the composed reply carries reply: expected on the outbound envelope.
  test("the alias preserves an explicit reply expectation (--ask, --reply)", () => {
    for (const flag of ["--ask", "--reply"]) {
      const fx = aliasFixture();
      const v = runAlias(fx, [flag]);
      expect({ flag, trace: v.trace, code: v.code }).toEqual({ flag, trace: "native send\n", code: 0 });
      const out = payloads(fx.bus).filter((p) => p !== `${INBOUND}.md`);
      expect(out).toHaveLength(1);
      expect(envelopeField(envelope(fx.bus, out[0]!.replace(/\.md$/, "")), "reply")).toBe("expected");
    }
  }, 120_000);

  // Review round 1 (important 2): `assign <dest> --reply-to <message-id>`
  // composes a reply carrying kind: order and reply: expected and settles
  // the inbound.
  test("tap assign --reply-to <message-id> composes the alias with the order invariants", () => {
    const fx = aliasFixture();
    const v = execDoor(fx, ["assign", "ub", "--reply-to", INBOUND, "-f", bodyFile(fx)], {
      TAP_AUTOSETTLE_HOLD_SECONDS: "3600", TAP_DRIVER_FORCE_TMUX: "1", TAP_TUI_SETTLE_SCALE: "0.1",
    });
    expect({ code: v.code, trace: v.trace }).toEqual({ code: 0, trace: "native assign\n" });
    const out = payloads(fx.bus).filter((p) => p !== `${INBOUND}.md`);
    expect(out).toHaveLength(1);
    const raw = envelope(fx.bus, out[0]!.replace(/\.md$/, ""));
    expect(envelopeField(raw, "kind")).toBe("order");
    expect(envelopeField(raw, "reply")).toBe("expected");
    expect(existsSync(join(fx.bus, "receipts", `${INBOUND}.done`))).toBe(true);
  }, 120_000);

  // Review round 1 (important 2): `--team` applies BEFORE payload resolution —
  // a pane-less caller anchored nowhere resolves the named team's bus first,
  // so a duplicate id across two enrolled buses picks the named team's copy
  // (local-first) instead of refusing ambiguous or settling a stranger's.
  // Review round 2 (important 2): the run strips TAP_HOME — an env-pinned
  // home bus overrides --team, so keeping it made this arm vacuous; the flag
  // alone (via the index) must do the anchoring.
  test("--team anchors the alias from an unanchored cwd and resolves the named team's copy first", () => {
    const fx = teamFixture({ inbound: { id: INBOUND, from: "ub", to: "ua" } });
    const otherWt = join(fx.root, "other");
    const otherBus = join(otherWt, ".tap", "bus");
    const otherRegistry = join(otherWt, ".tap", "team-registry.json");
    mkdirSync(join(otherBus, "payloads"), { recursive: true });
    writeFileSync(otherRegistry, JSON.stringify({
      schema: "0.20",
      team: { name: "other", worktree_root: otherWt },
      seats: { rb: { status: "active", pane: "rb:0.0", pane_id: "%9", server_epoch: "srv:123:456", instance: "rb|B", harness: "claude" } },
    }));
    writeFileSync(join(fx.root, "index", "global-registry.json"), JSON.stringify({
      schema: "0.20",
      teams: {
        flip: { root: fx.wt, registry_location: join(fx.wt, ".tap", "team-registry.json"), state: "registered" },
        other: { root: otherWt, registry_location: otherRegistry, state: "registered" },
      },
    }));
    copyFileSync(join(fx.bus, "payloads", `${INBOUND}.md`), join(otherBus, "payloads", `${INBOUND}.md`));
    const { TAP_HOME: _noHomeOverride, ...teamEnv } = fx.env;
    const result = Bun.spawnSync(
      [process.execPath, REENABLED, "send", "ub", "--reply-to", INBOUND, "-f", bodyFile(fx), "--team", "flip"],
      { cwd: fx.root, env: teamEnv, stdout: "pipe", stderr: "pipe", timeout: 30000, killSignal: "SIGKILL" },
    );
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(fx.bus, "receipts", `${INBOUND}.done`))).toBe(true);
    expect(existsSync(join(otherBus, "receipts", `${INBOUND}.done`))).toBe(false);
  }, 60_000);
});

// Review round 1 (important 3): the deliverability predicate and the
// self-pointing test both key on RESOLVED scope, exactly as
// `tap_seat_deliverable` (lib.sh:7307-7343) judges it — a qualified address
// inside the caller's own team is local (explicit self refusals, stored self
// warns), a remote team naming the same handle is legitimate, and a
// `launching` status_reason is not deliverable on any row.
describe("review round 1 — qualified reply_to scope and launching rows", () => {
  const id = (n: string) => `ua-20260920T020${n}00Z-aabbccddeeff`;

  const UA_SEAT = { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456", instance: "ua|A", harness: "claude" };

  function twoTeamFixture(seats: Record<string, unknown>, otherSeats: Record<string, unknown>) {
    const fx = teamFixture({ seats });
    const otherWt = join(fx.root, "other");
    const otherRegistry = join(otherWt, ".tap", "team-registry.json");
    mkdirSync(join(otherWt, ".tap"), { recursive: true });
    writeFileSync(otherRegistry, JSON.stringify({
      schema: "0.20",
      team: { name: "other", worktree_root: otherWt },
      seats: otherSeats,
    }));
    writeFileSync(join(fx.root, "index", "global-registry.json"), JSON.stringify({
      schema: "0.20",
      teams: {
        flip: { root: fx.wt, registry_location: join(fx.wt, ".tap", "team-registry.json"), state: "registered" },
        other: { root: otherWt, registry_location: otherRegistry, state: "registered" },
      },
    }));
    return fx;
  }

  test("an explicit qualified --reply-to inside the caller's own team refuses as self-pointing", () => {
    const fx = teamFixture({});
    const v = run(fx, ["--ask", "--id", id("1"), "--reply-to", "flip/ua"]);
    expect(v.code).toBe(1);
    expect(v.stderr).toContain("--reply-to names where the recipient's tap reply lands; as sender 'ua', replies already return to you — omit --reply-to");
  }, 40_000);

  test("a stored qualified reply_to naming the same handle on a remote team stamps (not a self warning)", () => {
    const fx = twoTeamFixture(
      { ua: { ...UA_SEAT, reply_to: "other/ua" } },
      { ua: { status: "active", pane: "ua:0.0", pane_id: "%8", server_epoch: "srv:123:456", instance: "ua|O", harness: "claude" } },
    );
    const v = run(fx, ["--ask", "--id", id("2")]);
    expect(v.code).toBe(0);
    expect(envelopeField(envelope(fx.bus, id("2")), "reply_to")).toBe("other/ua");
    expect(v.stderr).not.toContain("points to itself");
  }, 40_000);

  test("an explicit --reply-to to a launching seat refuses as not deliverable right now", () => {
    // The launching seat is the STAMP target, not the recipient: a launching
    // recipient delegates to Bash pre-effect by design (send.ts, tap-send.sh),
    // while a launching stamp target is answered by the deliverability port.
    const fx = teamFixture({ seats: { uc: { status: "active", status_reason: "launching", pane: "uc:0.0", pane_id: "%9", server_epoch: "srv:123:456", instance: "uc|C", harness: "claude" } } });
    const v = run(fx, ["--ask", "--id", id("3"), "--reply-to", "uc"]);
    expect(v.code).toBe(1);
    expect(v.stderr).toContain("--reply-to handle 'uc' is not a deliverable seat in team 'flip' right now");
  }, 40_000);

  test("a registry default pointing at a launching seat warns and omits (native)", () => {
    // Native only: the incumbent's default-stamp path crashes on this fixture
    // shape (see the router arm above); the predicate is lib.sh:7337-7343.
    // The launching seat `uc` is the DEFAULT's target, not the recipient.
    const fx = teamFixture({
      seats: {
        ua: { ...UA_SEAT, reply_to: "uc" },
        uc: { status: "active", status_reason: "launching", pane: "uc:0.0", pane_id: "%9", server_epoch: "srv:123:456", instance: "uc|C", harness: "claude" },
      },
    });
    const v = run(fx, ["--ask", "--id", id("4")]);
    expect(v.code).toBe(0);
    expect(v.stderr).toContain("is not currently deliverable");
    expect(envelopeField(envelope(fx.bus, id("4")), "reply_to")).toBeUndefined();
  }, 40_000);
});
