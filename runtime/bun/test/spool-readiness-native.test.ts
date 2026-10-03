import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { boundPaneIdentityState } from "../src/observe-gather";
import { paneHarnessAt, readDisplayState, readObservedBand, readPaneReady } from "../src/spool-readiness";
import { acquirePaneLock } from "../src/panelock";
import { updateInputProtection } from "../src/input-protection";
import { observePaneResult } from "../src/tmux";

import { realPaneIo } from "../src/pane/reader";
import { installSpoolPane } from "./support/spool-pane";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const scripts = join(import.meta.dir, "../../../skills/tap/scripts");

function fixture(command = "claude") {
  const root = mkdtempSync(join(tmpdir(), "readiness-native-")); roots.push(root);
  const home = join(root, "bus"); mkdirSync(join(home, "watch"), { recursive: true });
  const registry = join(home, "registry.json");
  const env: NodeJS.ProcessEnv = { ...process.env, TAP_HOME: home, TAP_INDEX_HOME: join(root, "index"),
    TAP_SPOOL_DISABLE_DELIVERER: "1", TAP_TUI_SETTLE_SCALE: "0.1", TAP_VERBOSE: "0" };
  const { frame, log, seat, writeSeat } = installSpoolPane(root, registry, env, command, true);
  writeFileSync(frame, readFileSync(join(scripts, "smoke/fixtures/pane-state/claude/idle-band.ansi")));
  const prefix = { pane: seat.pane, paneId: seat.pane_id, handle: "peer", toTeam: "fixture", targetRegistry: registry, policy: "" };
  const ready = () => readPaneReady(prefix, home, env);
  return { root, home, frame, log, registry, env, prefix, seat, writeSeat, ready };
}

test("native bound identity classifies every refusal reason and never captures a band", () => {
  const f = fixture();
  for (const [over, expected] of [
    [{}, "match"], [{ status: "suspended" }, "handle_missing_or_inactive"], [{ delivery: "poll" }, "not_pane_delivery"],
    [{ pane: "other:0.0" }, "pane_drift"], [{ pane_id: "" }, "pane_id_missing"], [{ pane_id: "%999" }, "pane_id_drift"],
    [{ session: "replacement" }, "session_absent"], [{ server_epoch: "srv:999:1" }, "server_epoch_stale"],
    [{ server_epoch: "" }, "server_epoch_missing"],
  ] as const) {
    f.writeSeat(over);
    const args = [f.registry, "peer", f.prefix.pane, f.prefix.paneId];
    const actual = boundPaneIdentityState(...args as [string, string, string, string], f.env);
    expect(actual).toBe(expected);
  }
  writeFileSync(f.registry, Buffer.from([0x7b, 0xff, 0x7d]));
  expect(boundPaneIdentityState(f.registry, "peer", f.prefix.pane, f.prefix.paneId, f.env)).toBe("handle_missing_or_inactive");
  expect(readFileSync(f.log, "utf8")).not.toContain("capture-pane");
});

test("a stale binding is classified before an unrelated pane protection hold", () => {
  const f = fixture();
  writeFileSync(f.frame, readFileSync(join(scripts, "smoke/fixtures/pane-state/claude/draft-box.txt")));
  const observed = observePaneResult(f.prefix.paneId, f.env);
  expect(observed.status).toBe("ok");
  if (observed.status !== "ok") return;
  mkdirSync(join(f.home, "payloads"), { recursive: true });
  writeFileSync(join(f.home, "payloads", "unrelated-mail.md"), "pending message");
  const lock = acquirePaneLock(f.prefix.paneId, 1000, f.env);
  expect(lock).not.toBeNull();
  try {
    updateInputProtection(observed.observation, { state: "busy", text: "operator draft" }, {
      env: f.env, now: Date.now(), message: { home: f.home, id: "unrelated-mail", sender: "alice" },
    });
  } finally { lock!.release(); }
  f.writeSeat({ pane: "replacement:0.0" });
  writeFileSync(f.log, "");
  expect(f.ready()).toBe("gone");
  expect(readFileSync(f.log, "utf8")).not.toContain("capture-pane");
});

test("readiness observations classify empty, draft, modal and unavailable bands", () => {
  const f = fixture();
  for (const [name, expected] of [
    ["pane-state/claude/idle-band.ansi", "ready"],
    ["pane-state/claude/draft-box.txt", "busy:pending"],
    ["peek-harness-adapters/claude-feedback-empty-constructed.ansi", "busy:feedback-draft"],
  ]) {
    writeFileSync(f.frame, readFileSync(join(scripts, "smoke/fixtures", name!)));
    expect(String(f.ready())).toBe(expected!);
  }
  f.env.FAKE_CAPTURE_FAIL = "1";
  expect(String(f.ready())).toBe("busy:modal");
  delete f.env.FAKE_CAPTURE_FAIL;
  f.env.FAKE_MODE = "1"; writeFileSync(f.log, "");
  expect(String(f.ready())).toBe("busy");
  expect(readFileSync(f.log, "utf8")).not.toContain("capture-pane");
});

test("failed OpenCode capture holds readiness instead of admitting an empty band", () => {
  const f = fixture("opencode");
  writeFileSync(f.frame, readFileSync(join(scripts, "smoke/fixtures/peek-harness-adapters/opencode-wide-idle.ansi")));
  expect(f.ready()).toBe("ready");
  f.env.FAKE_CAPTURE_FAIL = "1";
  expect(f.ready()).toBe("busy:booting");
});

test("native harness reuse follows the expected fallback ladder, including no process walk for known commands or missing pid", () => {
  const f = fixture();
  for (const [command, pid, psFail, expected] of [
    ["claude-code", "4242", "0", "claude"], ["zsh", "4242", "0", "zsh"],
    ["node", "4242", "0", "codex"], ["2.1.198", "4242", "0", "codex"],
    ["node", "", "0", "node"], ["node", "4242", "1", "node"],
  ]) {
    Object.assign(f.env, { FAKE_COMMAND: command, FAKE_PID: pid, FAKE_PS_FAIL: psFail });
    writeFileSync(f.log, "");
    expect(paneHarnessAt(f.prefix.pane, f.env)).toBe(expected!);
    if (command === "claude-code" || command === "zsh" || !pid) expect(readFileSync(f.log, "utf8")).not.toContain("ps\n");
  }
});

test("local blocked fields hold only the unqualified target; display keeps its captured metadata binding", () => {
  const f = fixture();
  writeFileSync(join(f.home, "watch/arm.json"), JSON.stringify({ blocked_map: { peer: { reason: "session_limit" } }, blocked_exempt: [] }));
  f.prefix.toTeam = "";
  expect(String(f.ready())).toBe("busy");
  f.prefix.toTeam = "fixture";
  expect(String(f.ready())).toBe("ready");
  const meta = join(f.home, "a.meta.json");
  writeFileSync(meta, JSON.stringify({ pane: f.prefix.pane, pane_id: f.prefix.paneId, target: "peer", to_team: "fixture",
    target_registry: f.registry, hold_until_epoch: 150, first_spooled_epoch: 50 }));
  expect(readDisplayState(meta, f.home, 100, f.env)).toBe("batch");
  expect(readDisplayState(meta, f.home, 151, f.env)).toBe("ready");
});

test("an explicit namespace overrides an ambient server for every native readiness read", () => {
  const f = fixture();
  f.env.TMUX = "/private/ambient-A,1,0";
  f.env.TAP_TMUX_SOCKET = "selected-B";
  delete f.env.TAP_TMUX_SOCKET_PATH;
  expect(String(f.ready())).toBe("ready");
  const lines = readFileSync(f.log, "utf8").trim().split("\n").filter(line => line !== "ps");
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.every(line => line.startsWith("-L selected-B ")), lines.join("\n")).toBe(true);
});

test("real private servers: an explicit socket reads B while ambient TMUX names A", async () => {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR || tmpdir(), "readiness-servers-")); roots.push(root);
  const sockets = [join(root, "a"), join(root, "b")];
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const run = (socket: string, args: string[]) => Bun.spawnSync(["tmux", "-S", socket, ...args]);
  try {
    const base = readFileSync(join(scripts, "smoke/fixtures/submit-verify/codex-idle-empty.ansi"), "utf8");
    for (const [i, socket] of sockets.entries()) {
      const at = base.lastIndexOf("›");
      expect(at).toBeGreaterThan(0);
      const frame = i === 0 ? base.slice(0, at) + "› human draft " + base.slice(at + 1) : base;
      const result = run(socket, ["-f", "/dev/null", "new-session", "-d", "-s", "fixture", "-x", "100", "-y", "50",
        `printf %s ${quote(frame)}; exec sleep 30`]);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      for (let count = 0; count < 40; count++) {
        if (run(socket, ["capture-pane", "-p", "-t", "fixture:0.0"]).stdout.toString().includes("›")) break;
        await Bun.sleep(25);
      }
    }
    const env = { ...process.env, TMUX: `${sockets[0]},1,0`, TAP_TMUX_SOCKET_PATH: sockets[1] };
    expect(readObservedBand("fixture:0.0", "codex", env)).toBe("bare");
    expect(readObservedBand("fixture:0.0", "codex", { ...env, TAP_TMUX_SOCKET_PATH: sockets[0] })).toBe("draft");
  } finally { for (const socket of sockets) run(socket, ["kill-server"]); }
});

test("a foreign shell router is refused: native readiness answers without a tmux read", () => {
  const f = fixture();
  const env = { ...f.env, TAP_TMUX_SOCKET: "native-other-server" };
  writeFileSync(f.log, "");
  // The retired Bash readiness adapter passed router=1 here; the native owner's flag is that bit.
  // pane-identity.test.ts covers boundPaneIdentityState's own nativeRouter:false ->
  // harness_unobservable branch directly; this checks the higher spool-readiness.ts entrance.
  // harness_unobservable is the instrument failing to look, so the refusal is a
  // hold (busy:decision-unavailable), never the terminal gone.
  expect(String(readPaneReady(f.prefix, f.home, env, false))).toBe("busy:decision-unavailable");
  expect(readFileSync(f.log, "utf8")).toBe("");
});

test("the default pane reader observes the current environment at call time", () => {
  const f = fixture(), previous = process.env;
  try { process.env = f.env; expect(realPaneIo.paneWidth(f.prefix.pane)).toBe("120"); }
  finally { process.env = previous; }
});


test("Codex hook trust is a modal hold, not pending input", () => {
  const f = fixture("codex");
  writeFileSync(f.frame, readFileSync(join(import.meta.dir, "fixtures/agent-state/codex/hook-trust.txt")));
  expect(f.ready()).toBe("busy:modal");
  expect(readFileSync(f.log, "utf8")).not.toContain("send-keys");
});
