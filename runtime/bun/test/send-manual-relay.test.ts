// Checkpoint A (U2): addressing forms with no native twin — the manual
// `--cross-worktree --pane` unbound relay, the same-team `--pane` override,
// the id-shaped pane-drift heal, and their refusal shapes — route native and
// reproduce the incumbent's bytes (frozen below) over the flip fixture's fake
// tmux. The relay keeps the canonical on the SENDER's bus, stamps
// cross_worktree/from_team and no to_team, and requires the exact
// session-qualified pane whose identity the unbound record vouches for. The
// fixture's session-observation arm answers only session `ua`, so the relay
// arms designate `ua:0.0`. The Bash-door comparison these tests used to run
// against is retired with the adapter.
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { envelopeField } from "../src/envelope";
import { REENABLED, teamFixture, flushScratch } from "./support/send-reply-flip-fixture";

afterEach(() => flushScratch(), 40_000);

function run(fx: ReturnType<typeof teamFixture>, argv: string[], extraEnv: Record<string, string> = {}) {
  const trace = join(fx.root, "route.trace");
  const result = Bun.spawnSync(
    [process.execPath, REENABLED, ...argv],
    {
      cwd: fx.wt,
      env: {
        ...fx.env,
        TAP_BUN_ROUTE_TRACE: trace,
        TAP_AUTOSETTLE_HOLD_SECONDS: "3600",
        TAP_TUI_SETTLE_SCALE: "0.1",
        ...extraEnv,
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
    keys: existsSync(fx.env.FAKE_KEYS as string) ? readFileSync(fx.env.FAKE_KEYS as string, "utf8") : "",
  };
}

const RELAY_ID = "ua-20260920T030100Z-aabbccddeeff";

describe("manual --cross-worktree --pane unbound relay (checkpoint A, U2)", () => {
  for (const flag of ["", "--polite", "--no-spool"]) test(`manual relay copy-mode follows the delivery policy (${flag || "ordinary"})`, () => {
    const fx = teamFixture({});
    writeFileSync(fx.env.FAKE_IN_MODE!, "1");
    const registry = join(fx.wt, ".tap", "team-registry.json");
    const before = readFileSync(registry, "utf8");
    const v = run(fx, ["send", "peer", "-m", "hello", "--from", "ub", "--id", RELAY_ID,
      "--cross-worktree", "--pane", "ua:0.0", ...(flag ? [flag] : [])]);
    expect({ flag, code: v.code, copyMode: existsSync(fx.env.FAKE_IN_MODE!) })
      .toEqual({ flag, code: flag ? 1 : 0, copyMode: !!flag });
    expect(existsSync(join(fx.bus, "receipts", `${RELAY_ID}.sent`))).toBe(!flag);
    expect(existsSync(join(fx.bus, "payloads", `${RELAY_ID}.md`))).toBe(!flag);
    if (flag) expect(v.keys).toBe("");
    expect(readFileSync(registry, "utf8")).toBe(before);
  }, 120_000);

  test("an unobservable pre-effect relay removes its new placement without suspending a seat", () => {
    const fx = teamFixture({});
    const tmux = join(fx.root, "bin", "tmux");
    copyFileSync(tmux, `${tmux}.base`);
    writeFileSync(tmux, `#!/bin/sh
case " $* " in
  *" ua:0.0 "*"#{pane_id}"*"#{session_name}"*)
    if [ -f "$FAKE_RELAY_CANON" ]; then printf 'malformed\\n'; exit 0; fi ;;
esac
exec "$0.base" "$@"
`, { mode: 0o755 });
    const registry = join(fx.wt, ".tap", "team-registry.json");
    const before = readFileSync(registry, "utf8");
    const canon = join(fx.bus, "payloads", `${RELAY_ID}.md`);
    const v = run(fx, ["send", "peer", "-m", "hello", "--from", "ub", "--id", RELAY_ID,
      "--cross-worktree", "--pane", "ua:0.0", "--json"], { FAKE_RELAY_CANON: canon });
    expect(v.code).toBe(1);
    expect(JSON.parse(v.stdout).error_class).toBe("tmux_unreachable");
    expect(existsSync(canon)).toBe(false);
    for (const suffix of ["placed", "sent", "attempted"]) expect(existsSync(join(fx.bus, "receipts", `${RELAY_ID}.${suffix}`))).toBe(false);
    expect(v.keys).toBe("");
    expect(readFileSync(registry, "utf8")).toBe(before);
  }, 60_000);

  test("routes native, keeps the canonical on the sender's bus and injects the relay sentinel", () => {
    const fx = teamFixture({});
    const v = run(fx, ["send", "peer", "-m", "hello", "--from", "ua", "--id", RELAY_ID, "--cross-worktree", "--pane", "ua:0.0"]);
    expect(v.trace).toBe("native send\n");
    expect(v.code).toBe(0);
    const canonical = readFileSync(join(fx.bus, "payloads", `${RELAY_ID}.md`), "utf8");
    expect(envelopeField(canonical, "cross_worktree")).toBe("true");
    // The incumbent's relay from_team is its LOCAL_TEAM derivation
    // (tap-send.sh:307/:1000/:1682 via lib.sh:6972-6988): on this fixture
    // the bus registry.json is absent, so the bus-anchor root's basename
    // (`team`) is what both doors stamp.
    expect(envelopeField(canonical, "from_team")).toBe("team");
    expect(envelopeField(canonical, "to_team")).toBeUndefined();
    // The relay sentinel is the v0.23 wire: the full id in slot 3 and the
    // pointer riding INSIDE the brackets — `path=` present is the relay's tell.
    expect(v.keys).toContain(`-l -- [[TAP v0.23 note ${RELAY_ID}`);
    // The courier realpaths the bus (macOS /var → /private/var).
    expect(v.keys).toContain(`path=${realpathSync(join(fx.bus, "payloads", `${RELAY_ID}.md`))}]]`);
    expect(existsSync(join(fx.bus, "receipts", `${RELAY_ID}.sent`))).toBe(true);
  }, 60_000);

  test("a sender whose own pane binding drifted warns and still delivers natively (decision 4)", () => {
    const fx = teamFixture({ seats: { ub: { status: "active", pane: "ub:0.0", pane_id: "%99", server_epoch: "srv:123:456", instance: "ub|A", harness: "claude" } } });
    const v = run(fx, ["send", "peer", "-m", "hello", "--from", "ub", "--id", RELAY_ID, "--cross-worktree", "--pane", "ua:0.0"]);
    expect({ code: v.code, trace: v.trace }).toEqual({ code: 0, trace: "native send\n" });
    expect(v.stderr).toContain("tap: warning: your seat's pane binding is stale; run tap in to rebind\n");
    expect(existsSync(join(fx.bus, "receipts", `${RELAY_ID}.sent`))).toBe(true);
    expect(v.keys).toContain(`-l -- [[TAP v0.23 note ${RELAY_ID}`);
  }, 60_000);

  test("a pane-less poll sender relays natively with no binding warning", () => {
    const fx = teamFixture({ seats: { uc: { status: "active", delivery: "poll", harness: "codex" } } });
    const v = run(fx, ["send", "peer", "-m", "hello", "--from", "uc", "--id", RELAY_ID, "--cross-worktree", "--pane", "ua:0.0"]);
    expect({ code: v.code, trace: v.trace }).toEqual({ code: 0, trace: "native send\n" });
    expect(v.stderr).not.toContain("pane binding is stale");
    expect(existsSync(join(fx.bus, "receipts", `${RELAY_ID}.sent`))).toBe(true);
  }, 60_000);

  test("a sender with a current binding relays with no warning", () => {
    const fx = teamFixture({});
    const v = run(fx, ["send", "peer", "-m", "hello", "--from", "ub", "--id", RELAY_ID, "--cross-worktree", "--pane", "ua:0.0"]);
    expect(v.code).toBe(0);
    expect(v.stderr).not.toContain("pane binding is stale");
  }, 60_000);

  test("--cross-worktree without --pane refuses with the incumbent's usage bytes", () => {
    const fx = teamFixture({});
    const v = run(fx, ["send", "peer", "-m", "hello", "--from", "ua", "--cross-worktree"]);
    expect(v.code).toBe(1);
    expect(v.stderr).toContain("--cross-worktree requires --pane <tmux-target> (no implicit cross-worktree peer discovery)");
  }, 60_000);

  test("a bare --pane target refuses with the exact-session requirement", () => {
    const fx = teamFixture({});
    const v = run(fx, ["send", "peer", "-m", "hello", "--from", "ua", "--cross-worktree", "--pane", "ua"]);
    expect(v.code).toBe(1);
    expect(v.stderr).toContain("manual cross-worktree relay requires an exact session-qualified pane; bare target 'ua' has ambient tmux meaning");
  }, 60_000);

  test("a pane the session does not designate refuses as unobservable membership", () => {
    const fx = teamFixture({});
    const v = run(fx, ["send", "peer", "-m", "hello", "--from", "ua", "--cross-worktree", "--pane", "ua:1.0"]);
    expect(v.code).toBe(1);
    expect(v.stderr).toContain("manual cross-worktree pane 'ua:1.0' is not observable as designated membership (designated_pane_missing)");
  }, 60_000);

  // Review round 1 (critical 1): the incumbent's one convergence point
  // (tap-send.sh:145-157) deletes the canonical and refuses BEFORE any spool
  // write — an unbound relay can never redeliver, so a polite park (deliberate
  // wait), a readiness defer, a recovery hold and a clear fence all refuse.
  test("the unbound relay never parks: --polite deletes the canonical and refuses before any spool write", () => {
    const fx = teamFixture({});
    const id = `ua-20260920T030700Z-aabbccddeeff`;
    const v = run(fx, ["send", "peer", "-m", "hello", "--from", "ua", "--id", id, "--cross-worktree", "--pane", "ua:0.0", "--polite"]);
    expect(v.trace).toBe("native send\n");
    expect(v.code).toBe(1);
    expect(v.stderr).toContain("unbound manual relay cannot be parked for later delivery");
    expect(v.stderr).toContain("register the recipient in its TAP team, then address it as <team>/<handle>");
    expect(existsSync(join(fx.bus, "payloads", `${id}.md`))).toBe(false);
    expect(existsSync(join(fx.bus, "spool", `${id}.md`))).toBe(false);
    expect(existsSync(join(fx.bus, "spool", `${id}.meta.json`))).toBe(false);
  }, 120_000);

  // Review round 1 (critical 1): a manual relay has no authoritative target
  // registry, so it has no delivery clock to stamp (lib.sh:1911-1916, ruling
  // 43) — an empty registry is a no-op, not a fallback that writes into the
  // sender's bus.
  test("a successful manual relay writes no delivery clock on the sender's bus", () => {
    const fx = teamFixture({});
    const id = `ua-20260920T030900Z-aabbccddeeff`;
    const v = run(fx, ["send", "peer", "-m", "hello", "--from", "ua", "--id", id, "--cross-worktree", "--pane", "ua:0.0"]);
    expect(v.code).toBe(0);
    expect(existsSync(join(fx.bus, "delivery", "peer.json"))).toBe(false);
  }, 120_000);

  // Review round 1 (important 5): the hook executes directly — no timeout, no
  // hidden stdio, only its exit status ignored (tap-send.sh:816-820). This is
  // the deterministic U3 cutover handshake seam.
  test("the after-route hook executes directly with inherited stdio and an ignored status", () => {
    const fx = teamFixture({});
    const hook = join(fx.root, "after-route-hook.sh");
    writeFileSync(hook, "#!/bin/sh\ntouch \"$0.ran\"\necho hook-output-seen\nexit 3\n", { mode: 0o755 });
    const v = run(fx, ["send", "peer", "-m", "hello", "--from", "ua", "--id", "ua-20260920T031100Z-aabbccddeeff", "--cross-worktree", "--pane", "ua:0.0"],
      { TAP_SEND_AFTER_ROUTE_HOOK: hook });
    expect(v.code).toBe(0);
    expect(existsSync(`${hook}.ran`)).toBe(true);
    expect(v.stdout).toContain("hook-output-seen");
  }, 60_000);

  // Review round 2 (critical 1) + round 5 (r4056301888): a relay pane that
  // lands on a denylist family refuses TERMINAL — canonical gone, nothing
  // queued — on both doors. The incumbent's PANE_CMD resolution runs AFTER
  // the route hook (tap-send.sh:1417-1418), so its denylist gate (:1569-1575)
  // owns the flip and emits the gate's bytes, not the place guard's.
  test("a route hook that flips the relay pane to a denylist family refuses at the denylist gate on both doors", () => {
    const fx = teamFixture({ relayHookFlipFile: true });
    const id = `ua-20260920T031200Z-aabbccddeeff`;
    const hook = join(fx.root, "flip-hook.sh");
    writeFileSync(hook, `#!/bin/sh\nprintf 'bash' > "$FAKE_RELAY_FLIP_FILE"\n`, { mode: 0o755 });
    const v = run(fx, ["send", "peer", "-m", "hello", "--from", "ua", "--id", id, "--cross-worktree", "--pane", "ua:0.0"],
      { TAP_SEND_AFTER_ROUTE_HOOK: hook, TAP_DRIVER_FORCE_TMUX: "1" });
    expect(v.trace).toBe("native send\n");
    expect(v.code).toBe(1);
    expect(v.stderr).toContain("tap send: reason=denylist; pane 'ua:0.0' runs 'bash' (not an agent REPL); next: escalate");
    expect(existsSync(join(fx.bus, "payloads", `${id}.md`))).toBe(false);
    expect(existsSync(join(fx.bus, "receipts", `${id}.placed`))).toBe(false);
    expect(existsSync(join(fx.bus, "spool", `${id}.md`))).toBe(false);
    expect(existsSync(join(fx.bus, "spool", `${id}.meta.json`))).toBe(false);
    expect(v.keys).toBe("");
  }, 120_000);

  // Review round 5 (r4056301887): the incumbent resamples the global-registry
  // marker immediately before canonical placement and refuses a marker that
  // turned invalid since route (tap-send.sh:1226-1233). A route hook that
  // corrupts the marker must therefore leave ZERO artifacts on both doors —
  // the publish-then-recheck ordering native used is the defect.
  test("a route hook that invalidates the flip marker refuses the relay before placement on both doors", () => {
    const fx = teamFixture({});
    const id = `ua-20260920T033100Z-aabbccddeeff`;
    const hook = join(fx.root, "marker-hook.sh");
    writeFileSync(hook, `#!/bin/sh\nprintf 'not json at all' > "$TAP_INDEX_HOME/global-registry.json"\n`, { mode: 0o755 });
    const v = run(fx, ["send", "peer", "-m", "hello", "--from", "ua", "--id", id, "--cross-worktree", "--pane", "ua:0.0"],
      { TAP_SEND_AFTER_ROUTE_HOOK: hook, TAP_DRIVER_FORCE_TMUX: "1" });
    expect(v.trace).toBe("native send\n");
    expect(v.code).toBe(1);
    expect(v.stderr).toContain("tap send: manual cross-worktree send refused — global-registry.json became invalid before place; next: tap doctor");
    expect(existsSync(join(fx.bus, "payloads", `${id}.md`))).toBe(false);
    expect(existsSync(join(fx.bus, "receipts", `${id}.placed`))).toBe(false);
    expect(existsSync(join(fx.bus, "spool", `${id}.md`))).toBe(false);
    expect(existsSync(join(fx.bus, "spool", `${id}.meta.json`))).toBe(false);
    expect(v.keys).toBe("");
  }, 120_000);

  // Review round 5 (r4056301888): the incumbent re-runs the rowless
  // exact-session/pane-id guard INSIDE place_canonical
  // (tap_send_require_bound_identity, tap-send.sh:1217/1350-1360), so a hook
  // that recycles the pane id after route refuses BEFORE publication with the
  // record's own state in the drift line — pane_recycled, the identity the
  // gate cannot see. Measured against the Bash door (probe ee4b64c241e5).
  test("a route hook that recycles the relay pane's id refuses the relay before placement on both doors", () => {
    const fx = teamFixture({ relayHookFlipFile: true });
    const id = `ua-20260920T033700Z-aabbccddeeff`;
    const hook = join(fx.root, "flip-hook.sh");
    writeFileSync(hook, `#!/bin/sh\nprintf 'id:%%7' > "$FAKE_RELAY_FLIP_FILE"\n`, { mode: 0o755 });
    const v = run(fx, ["send", "peer", "-m", "hello", "--from", "ua", "--id", id, "--cross-worktree", "--pane", "ua:0.0"],
      { TAP_SEND_AFTER_ROUTE_HOOK: hook, TAP_DRIVER_FORCE_TMUX: "1" });
    expect(v.trace).toBe("native send\n");
    expect(v.code).toBe(1);
    expect(v.stderr).toContain("tap: rowless pane identity drifted before pane effect (pane_recycled)");
    expect(v.stderr).toContain("tap send: rowless recipient identity drifted before delivery; next: verify the exact tmux session and pane, then retry");
    expect(existsSync(join(fx.bus, "payloads", `${id}.md`))).toBe(false);
    expect(existsSync(join(fx.bus, "receipts", `${id}.placed`))).toBe(false);
    expect(existsSync(join(fx.bus, "spool", `${id}.md`))).toBe(false);
    expect(existsSync(join(fx.bus, "spool", `${id}.meta.json`))).toBe(false);
    expect(v.keys).toBe("");
  }, 120_000);

  // Review round 6 (P2): the incumbent re-checks pane liveness after the
  // route hook and BEFORE PANE_CMD classification (tap-send.sh:1413), so a
  // pane the hook killed is rc 3 pane_gone / human_relay with zero artifacts
  // — not an unsupported-harness refusal for an empty command. The relay
  // runs `--from ub` so the sender's own live observation stays outside the
  // fixture's ua-targeted gone gates.
  test("a hook that makes the relay pane disappear refuses rc 3 on both doors", () => {
    const fx = teamFixture({ relayHookFlipFile: true });
    const id = `ua-20260920T031600Z-aabbccddeeff`;
    const hook = join(fx.root, "flip-hook.sh");
    writeFileSync(hook, `#!/bin/sh\nprintf 'gone' > "$FAKE_RELAY_FLIP_FILE"\n`, { mode: 0o755 });
    const v = run(fx, ["send", "peer", "-m", "hello", "--from", "ub", "--id", id, "--cross-worktree", "--pane", "ua:0.0"],
      { TAP_SEND_AFTER_ROUTE_HOOK: hook, TAP_DRIVER_FORCE_TMUX: "1" });
    expect(v.trace).toBe("native send\n");
    expect(v.code).toBe(3);
    expect(v.stderr).toBe("tap send: pane 'ua:0.0' gone; next: human relay\n");
    expect(existsSync(join(fx.bus, "payloads", `${id}.md`))).toBe(false);
    expect(existsSync(join(fx.bus, "receipts", `${id}.placed`))).toBe(false);
    expect(existsSync(join(fx.bus, "spool", `${id}.md`))).toBe(false);
    expect(existsSync(join(fx.bus, "spool", `${id}.meta.json`))).toBe(false);
    expect(v.keys).toBe("");
  }, 120_000);

  // Review round 5 (r4056301888 + r4056301891): the incumbent's
  // tap_pane_harness_command (lib.sh:8726) resolves an unsupported shallow
  // command through the pane's process evidence — a cursor-agent-style
  // wrapper ("node" on the pane) delivers as its real agent family — and
  // refuses when the evidence names no family. The fixture's fake ps carries
  // the synthetic row (the compute runner reaps fire-and-forget children, so
  // a live impersonator cannot carry the walk); without it, both doors
  // measurably refuse the shallow name (probe ee4b64c241e5).
  test("an unsupported shallow command resolves through process evidence", () => {
    const fx1 = teamFixture({ relayPaneShallow: "node" });
    const id1 = `ua-20260920T034100Z-aabbccddeeff`;
    const v1 = run(fx1, ["send", "peer", "-m", "hello", "--from", "ua", "--id", id1, "--cross-worktree", "--pane", "ua:0.0"],
      { TAP_DRIVER_FORCE_TMUX: "1" });
    expect(v1.trace).toBe("native send\n");
    expect(v1.code).toBe(1);
    expect(v1.stderr).toContain("tap send: reason=unsupported; pane 'ua:0.0' runs unsupported harness 'node'; next: escalate");
    expect(existsSync(join(fx1.bus, "payloads", `${id1}.md`))).toBe(false);
    expect(v1.keys).toBe("");
    const fx2 = teamFixture({ relayPaneShallow: "node" });
    const id2 = `ua-20260920T034300Z-aabbccddeeff`;
    const v2 = run(fx2, ["send", "peer", "-m", "hello", "--from", "ua", "--id", id2, "--cross-worktree", "--pane", "ua:0.0"],
      { TAP_DRIVER_FORCE_TMUX: "1", FAKE_PS_ROW: `4242 1 -1 ${fx2.root}/claude ${fx2.root}/claude 120` });
    expect(v2.trace).toBe("native send\n");
    expect(v2.code).toBe(0);
    expect(existsSync(join(fx2.bus, "receipts", `${id2}.sent`))).toBe(true);
    expect(v2.keys).toContain("-l -- [[TAP v0.23 note");
  }, 120_000);

  // Review round 5 (r4056301888): the incumbent's PANE_CMD resolution runs
  // AFTER the route hook (tap-send.sh:1417-1418), so an AGENT flip is not
  // drift — the guard re-authenticates against the re-resolved family, the
  // canonical publishes, and the submit attempt on the real (untyped) pane
  // ends "Enter unconfirmed": rc 5, canonical and `.placed` stay, no `.sent`.
  // Measured byte-for-byte against the Bash door (probe ee4b64c241e5).
  test("a route hook that flips the relay pane to another agent family rebinds and delivers unverified on both doors", () => {
    const fx = teamFixture({ relayHookFlipFile: true });
    const id = `ua-20260920T033300Z-aabbccddeeff`;
    const hook = join(fx.root, "flip-hook.sh");
    writeFileSync(hook, `#!/bin/sh\nprintf 'codex' > "$FAKE_RELAY_FLIP_FILE"\n`, { mode: 0o755 });
    const v = run(fx, ["send", "peer", "-m", "hello", "--from", "ua", "--id", id, "--cross-worktree", "--pane", "ua:0.0"],
      { TAP_SEND_AFTER_ROUTE_HOOK: hook, TAP_DRIVER_FORCE_TMUX: "1" });
    expect(v.trace).toBe("native send\n");
    expect(v.code).toBe(5);
    expect(v.stderr).toContain("Delivery not confirmed");
    expect(v.stderr).toContain("Enter unconfirmed (possible effect)");
    expect(existsSync(join(fx.bus, "payloads", `${id}.md`))).toBe(true);
    expect(existsSync(join(fx.bus, "receipts", `${id}.placed`))).toBe(true);
    expect(existsSync(join(fx.bus, "receipts", `${id}.sent`))).toBe(false);
    expect(existsSync(join(fx.bus, "spool", `${id}.md`))).toBe(false);
    expect(existsSync(join(fx.bus, "spool", `${id}.meta.json`))).toBe(false);
  }, 120_000);

  // Review round 2 (critical 1): a relay pane observed gone immediately
  // before effect is terminal rc 3 — the incumbent's
  // `tap_fail 3 pane_gone human_relay "pane '$PANE' gone"` (tap-send.sh:1634),
  // byte-identical on both doors. The relay runs `--from ub` so the sender's
  // own live observation (ub:0.0) stays outside the fixture's gone gate,
  // which keys on ua-targeted reads.
  test("a relay pane gone before effect refuses terminal rc 3 on both doors", () => {
    const fx = teamFixture({ relayPaneGoneAfter: 1 });
    const id = `ua-20260920T031400Z-aabbccddeeff`;
    const v = run(fx, ["send", "peer", "-m", "hello", "--from", "ub", "--id", id, "--cross-worktree", "--pane", "ua:0.0"],
      { TAP_DRIVER_FORCE_TMUX: "1" });
    expect(v.trace).toBe("native send\n");
    expect(v.code).toBe(3);
    expect(v.stderr).toBe("tap send: pane 'ua:0.0' gone; next: human relay\n");
    expect(existsSync(join(fx.bus, "payloads", `${id}.md`))).toBe(false);
    expect(existsSync(join(fx.bus, "spool", `${id}.md`))).toBe(false);
    expect(existsSync(join(fx.bus, "spool", `${id}.meta.json`))).toBe(false);
    expect(v.keys).toBe("");
  }, 120_000);

  // Review round 3: the relay from_team is tap_resolve_team_target's
  // TAP_TT_LOCAL_TEAM derivation (lib.sh:6972-6988), never a literal — the
  // bus's own registry.json `team.name` when that file parses, else the
  // bus-anchor root's basename. Both branches pinned on a worktree NOT
  // named `team` (the round-2 short-circuit only matched the old default).
  test("the relay from_team derives from the bus registry name, else the root basename", () => {
    const fx1 = teamFixture({ teamDirBasename: "odd-root", busRegistryName: "busname" });
    const id1 = `ua-20260920T032100Z-aabbccddeeff`;
    const v1 = run(fx1, ["send", "peer", "-m", "hello", "--from", "ua", "--id", id1, "--cross-worktree", "--pane", "ua:0.0"]);
    expect(v1.code).toBe(0);
    expect(envelopeField(readFileSync(join(fx1.bus, "payloads", `${id1}.md`), "utf8"), "from_team")).toBe("busname");
    const fx2 = teamFixture({ teamDirBasename: "odd-root" });
    const id2 = `ua-20260920T032300Z-aabbccddeeff`;
    const v2 = run(fx2, ["send", "peer", "-m", "hello", "--from", "ua", "--id", id2, "--cross-worktree", "--pane", "ua:0.0"]);
    expect(v2.code).toBe(0);
    expect(envelopeField(readFileSync(join(fx2.bus, "payloads", `${id2}.md`), "utf8"), "from_team")).toBe("odd-root");
  }, 120_000);
});

describe("same-team --pane override and the pane-drift heal (checkpoint A, U2)", () => {
  test("an explicit --pane that contradicts the registered pane refuses with identity_mismatch", () => {
    const fx = teamFixture({});
    const v = run(fx, ["send", "ub", "-m", "hello", "--from", "ua", "--pane", "ua:0.0"]);
    expect(v.code).toBe(1);
    expect(v.stderr).toContain("explicit pane 'ua:0.0' does not match registered pane 'ub:0.0' for 'ub'");
  }, 60_000);

  test("a poll member refuses --pane outright, before any status check", () => {
    const seats = { ub: { status: "active", delivery: "poll", instance: "ub|P", harness: "claude" } };
    const fx = teamFixture({ seats });
    const v = run(fx, ["send", "ub", "-m", "hello", "--from", "ua", "--pane", "ub:0.0"]);
    expect(v.code).toBe(1);
    expect(v.stderr).toContain("'ub' is a poll member and has no pane; --pane cannot target it (poll entries omit pane)");
  }, 60_000);

  test("an id-shaped pane field is healed under the registry lock before delivery", () => {
    const seats = { ub: { status: "active", pane: "%7", pane_id: "%7", server_epoch: "srv:123:456", instance: "ub|A", harness: "claude" } };
    const fx = teamFixture({ seats });
    const v = run(fx, ["send", "ub", "-m", "hello", "--from", "ua", "--ask", "--id", `ua-20260920T030300Z-aabbccddeeff`]);
    expect(v.trace).toBe("native send\n");
    expect(v.code).toBe(0);
    expect(v.stderr).toContain("tap send: healed id-shaped pane field for ub → ub:0.0");
    const healed = JSON.parse(readFileSync(join(fx.wt, ".tap", "team-registry.json"), "utf8")) as { seats: Record<string, { pane: string }> };
    expect(healed.seats.ub!.pane).toBe("ub:0.0");
  }, 120_000);

  test("an epoch-stale id-shaped pane is never healed; identity checks report the staleness", () => {
    const seats = { ub: { status: "active", pane: "%7", pane_id: "%7", server_epoch: "srv:999:999", instance: "ub|A", harness: "claude" } };
    const fx = teamFixture({ seats });
    const v = run(fx, ["send", "ub", "-m", "hello", "--from", "ua", "--ask", "--id", `ua-20260920T030500Z-aabbccddeeff`]);
    expect(v.trace).toBe("native send\n");
    expect(v.code).toBe(1);
    expect(v.stderr).toContain("tap send: refusing id-shaped pane heal for ub — pane_id epoch-stale (stored srv:999:999 ≠ now srv:123:456)");
  }, 120_000);

  // Selection supplies the team root even when the acting file is relocated.
  // Healing belongs to that selected file; the stale copy stays untouched.
  test("a relocated acting registry heals without changing its stale copy", () => {
    const seats = { ub: { status: "active", pane: "%7", pane_id: "%7", server_epoch: "srv:123:456", instance: "ub|A", harness: "claude" } };
    const fx = teamFixture({ seats });
    const stalePath = join(fx.wt, ".tap", "team-registry.json");
    const stale = readFileSync(stalePath, "utf8");
    const moved = join(fx.root, "moved", "team-registry.json");
    mkdirSync(join(fx.root, "moved"));
    copyFileSync(stalePath, moved);
    const index = JSON.parse(readFileSync(join(fx.root, "index", "global-registry.json"), "utf8")) as { teams: Record<string, { registry_location: string }> };
    index.teams.flip!.registry_location = moved;
    writeFileSync(join(fx.root, "index", "global-registry.json"), JSON.stringify(index));
    const v = run(fx, ["send", "ub", "-m", "hello", "--from", "ua", "--ask", "--id", `ua-20260920T031600Z-aabbccddeeff`]);
    expect(v.trace).toBe("native send\n");
    expect(v.code).toBe(0);
    expect(readFileSync(stalePath, "utf8")).toBe(stale);
    expect(v.stderr).toContain("tap send: healed id-shaped pane field for ub → ub:0.0");
    const healed = JSON.parse(readFileSync(moved, "utf8")) as { seats: Record<string, { pane: string }> };
    expect(healed.seats.ub!.pane).toBe("ub:0.0");
  }, 120_000);
});
