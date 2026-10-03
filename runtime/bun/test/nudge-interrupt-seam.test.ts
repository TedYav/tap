// tap_pkh9c: the recovery-interrupt seam. `tap nudge --interrupt`'s internal
// send option stamps deliveryFacts.recoveryInterrupt, which carries the urgent
// class past the auto-permission downgrade in the courier. Each bypassed guard
// here has a companion red-mutant receipt:
// reverting one bypass must fail exactly its test.
//
// The door is a PATH tmux whose pane is a mode file naming the frame to cat:
// an OpenCode composer frame set (ready / busy draft / staged wire / composer-
// less wedge). Escape flips it to idle — the harness leaving the wedge — so
// the interrupt's aftermath is observable like the real thing.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repo = join(import.meta.dir, "..", "..", "..");
const scriptsDir = join(repo, "skills", "tap", "scripts");

const composer = (text: string): string =>
  `  ┃ ${text}\n  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n  16.0K (8%)  ctrl+p commands · OpenCode 1.17.13\n`;
const SPIN = "  ⣟ Working...\n  esc to interrupt · 16.0K (8%)  ctrl+p commands · OpenCode 1.17.13\n";
const WIRE = "[[TAP v0.23 note seam-20260925T000000Z-000000000000 urgent]]";

// The wedged pane's TUI answer to Escape is its composer coming back; the
// busy arm models a seat that is already mid-turn again when the courier
// looks, and the one-shot flip models a seat that RESUMES between the
// courier's last pre-paste reads.
const DOOR_TMUX = `#!/usr/bin/env bash
set -u
T="\${TAP_HOME:?}"
while [ $# -ge 3 ] && { [ "$1" = "-L" ] || [ "$1" = "-S" ]; }; do shift 2; done
case "$1" in
  capture-pane)
    [ -f "$T/mode" ] || exit 1
    if [ -e "$T/interrupted" ]; then
      n=$(cat "$T/.captures" 2>/dev/null || printf 0); n=$((n + 1)); printf %s "$n" > "$T/.captures"
      if [ "$n" = "\${FAKE_FLIP_AFTER_INTERRUPT:-0}" ]; then printf 'frame.wedge\\n' > "$T/mode"; fi
    fi
    cat "$T/$(cat "$T/mode")" ;;
  display-message) case "\${@: -1}" in
    *pane_in_mode*) printf '0\\n' ;;
    *pane_id*session_name*) printf '%%1\\tfixture\\t4242\\t%s\\t0\\n' "$HARNESS" ;;
    *'#{pid}:#{start_time}'*) printf '4242:100\\n' ;;
    *pane_id*) printf '%%1\\n' ;;
    *pane_current_command*) printf '%s\\n' "$HARNESS" ;;
    *pane_width*) printf '120\\n' ;;
    *) printf 'fixture\\n' ;;
  esac ;;
  send-keys)
    printf '%s\\n' "$*" >> "$T/effects"
    case "\${@: -1}" in
      Escape)
        if [ "\${FAKE_INTERRUPT_FAIL:-}" = "1" ]; then exit 1; fi
        : > "$T/interrupted"
        printf 'frame.%s\\n' "\${FAKE_POST_INTERRUPT:-idle}" > "$T/mode" ;;
      Enter|C-u|BSpace) printf 'frame.idle\\n' > "$T/mode" ;;
    esac ;;
  load-buffer) printf '%s\\n' "$4" > "$T/buf.$3" ;;
  paste-buffer)
    # Bracketed paste (opencode): each chunk lands in the draft; the staged
    # frame is rebuilt from the accumulated bytes so verification reads the
    # real wire.
    printf '%s\\n' "$*" >> "$T/effects"
    printf '%s' "$(cat "$(cat "$T/buf.$3")")" >> "$T/staged.bytes"
    { while IFS= read -r line || [ -n "$line" ]; do printf '  ┃ %s\\n' "$line"; done < "$T/staged.bytes"; printf '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\\n  16.0K (8%%)  ctrl+p commands · OpenCode 1.17.13\\n'; } > "$T/frame.staged"
    printf 'frame.staged\\n' > "$T/mode" ;;
  delete-buffer) rm -f "$T/buf.$3" ;;
  resize-pane) exit 0 ;;
  *) exit 0 ;;
esac
exit 0
`;

interface ProbeEnv {
  mode: string;
  urgent: boolean;
  recovery: boolean;
  id: string;
  interruptFail?: boolean;
  postInterrupt?: string;
  flipAfterInterrupt?: number;
}

function probeEnv(e: ProbeEnv): { home: string; env: NodeJS.ProcessEnv } {
  const home = mkdtempSync("/tmp/tap-nudge-seam-");
  mkdirSync(join(home, "payloads"), { recursive: true });
  mkdirSync(join(home, "receipts"), { recursive: true });
  mkdirSync(join(home, "bin"));
  writeFileSync(join(home, "bin", "tmux"), DOOR_TMUX, { mode: 0o755 });
  writeFileSync(join(home, "registry.json"), JSON.stringify({ schema: "0.20", seats: {
    rb: { status: "active", harness: "opencode", permissions: "auto", pane: "fixture", pane_id: "%1", server_epoch: "srv:4242:100" },
  } }));
  writeFileSync(join(home, "frame.idle"), composer(""));
  writeFileSync(join(home, "frame.wedge"), composer("continue"));
  writeFileSync(join(home, "frame.spin"), SPIN);
  writeFileSync(join(home, "mode"), `frame.${e.mode}\n`);
  return { home, env: {
    ...process.env, TAP_HOME: home, TAP_INDEX_HOME: home, TAP_LOCK_DIR: join(home, "locks"),
    TAP_TMUX_SOCKET_PATH: join(home, "socket"), HARNESS: "opencode",
    PATH: `${join(home, "bin")}:${process.env.PATH}`,
    WIRE, PID: e.id, U: e.urgent ? "1" : "0", R: e.recovery ? "1" : "0",
    FAKE_INTERRUPT_FAIL: e.interruptFail ? "1" : "",
    FAKE_POST_INTERRUPT: e.postInterrupt ?? "",
    FAKE_FLIP_AFTER_INTERRUPT: String(e.flipAfterInterrupt ?? 0),
  } };
}

const PROBE = join(import.meta.dir, "support", "nudge-interrupt-seam-probe.ts");

interface ProbeResult { status: string; effects: string[]; attempted: boolean; stderr: string }

function runProbe(e: ProbeEnv): ProbeResult {
  const { home, env } = probeEnv(e);
  try {
    const r = spawnSync("bun", [PROBE], { encoding: "utf8", env: { ...env, SCRIPTS_DIR: scriptsDir }, timeout: 60_000 });
    let effects: string[] = [];
    try { effects = readFileSync(join(home, "effects"), "utf8").split("\n").filter(Boolean); } catch { /* no keys */ }    let attempted = false;
    try { attempted = existsSync(join(home, "receipts", `${e.id}.attempted`)); } catch { /* no attempt */ }
    if (r.status !== 0) throw new Error(`probe failed (${r.status}): ${r.stderr || r.stdout}`);
    return { status: (r.stdout.match(/status=(\w+)/)?.[1] ?? ""), effects, attempted, stderr: r.stderr };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// One send-keys line may carry the whole sequence ("… Escape Escape").
const escapes = (r: ProbeResult): number =>
  r.effects.reduce((n, l) => n + l.split("Escape").length - 1, 0);
const pasteIndex = (r: ProbeResult): number => r.effects.findIndex(l => l.startsWith("paste-buffer"));
const firstEscapeIndex = (r: ProbeResult): number => r.effects.findIndex(l => l.trimEnd().endsWith("Escape"));

test("ordinary urgent delivery to an auto seat keeps its downgrade: inject, no interrupt keys", () => {
  const r = runProbe({ mode: "idle", urgent: true, recovery: false, id: "seam-ordinary" });
  expect(r.status).toBe("injected");
  expect(escapes(r)).toBe(0);
  expect(pasteIndex(r)).toBeGreaterThanOrEqual(0);
}, 60_000);

test("recovery-interrupt runs the U4 double-Escape before the note on an auto seat", () => {
  const r = runProbe({ mode: "idle", urgent: true, recovery: true, id: "seam-recovery" });
  expect(r.status).toBe("injected");
  // OpenCode's interrupt is Escape, Escape — both must land BEFORE the paste.
  expect(escapes(r)).toBe(2);
  expect(firstEscapeIndex(r)).toBeGreaterThanOrEqual(0);
  expect(pasteIndex(r)).toBeGreaterThan(firstEscapeIndex(r));
  // The first interrupt key is a delivery effect: the attempt evidence exists.
  expect(r.attempted).toBe(true);
}, 60_000);

test("recovery authority without urgent fails closed: ordinary delivery, no keys of the interrupt class", () => {
  const r = runProbe({ mode: "idle", urgent: false, recovery: true, id: "seam-closed" });
  expect(r.status).toBe("injected");
  expect(escapes(r)).toBe(0);
}, 60_000);

test("the recovery interrupt passes a composer-less wedge the ordinary auto gate refuses (courier ready gate)", () => {
  const r = runProbe({ mode: "spin", urgent: true, recovery: true, id: "seam-wedge" });
  expect(r.status).toBe("injected");
  expect(escapes(r)).toBe(2);
  expect(pasteIndex(r)).toBeGreaterThan(firstEscapeIndex(r));
  // Exactly one note is submitted: one paste of the wire, nothing re-injected.
  expect(r.effects.filter(l => l.startsWith("paste-buffer")), JSON.stringify(r.effects)).toHaveLength(1);
}, 60_000);

test("the same wedge without recovery authority refuses before any key (the gate the bypass lifts)", () => {
  const r = runProbe({ mode: "spin", urgent: true, recovery: false, id: "seam-wedge-refused" });
  expect(r.status).toBe("band_busy");
  expect(r.effects).toEqual([]);
  expect(r.attempted).toBe(false);
}, 60_000);

test("a seat that resumes between the courier's reads still takes the note under recovery (pre-paste gate)", () => {
  const r = runProbe({ mode: "spin", urgent: true, recovery: true, id: "seam-resumed", flipAfterInterrupt: 2 });
  expect(r.status).toBe("injected");
  expect(escapes(r)).toBe(2);
  expect(pasteIndex(r)).toBeGreaterThan(firstEscapeIndex(r));
}, 60_000);

test("an interrupt whose key acceptance is unverified stays unverified with the attempt recorded", () => {
  const r = runProbe({ mode: "idle", urgent: true, recovery: true, id: "seam-unverified", interruptFail: true });
  expect(r.status).toBe("unverified");
  expect(r.attempted).toBe(true);
}, 60_000);

// The send door: the internal option must be the only way past the
// auto_mode_no_interrupt park, and the registry event must say so.
const SEND_PROBE = join(import.meta.dir, "support", "nudge-interrupt-send-probe.ts");

function runSendProbe(recovery: boolean, id: string, interruptFail = false): { rc: number; disposition: string; interrupt: string; home: string } {
  const wt = mkdtempSync("/tmp/tap-nudge-send-");
  const bus = join(wt, ".tap", "bus");
  mkdirSync(join(bus, "payloads"), { recursive: true });
  mkdirSync(join(bus, "receipts"), { recursive: true });
  mkdirSync(join(wt, "bin"));
  const index = join(wt, "index");
  mkdirSync(index);
  writeFileSync(join(wt, "bin", "tmux"), DOOR_TMUX, { mode: 0o755 });
  writeFileSync(join(wt, ".tap", "team-registry.json"), JSON.stringify({ schema: "0.20", team: { name: "alpha", worktree_root: wt }, seats: {
    ua: { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:4242:100", instance: "ua|A", harness: "claude" },
    rb: { status: "active", pane: "rb:0.0", pane_id: "%1", server_epoch: "srv:4242:100", instance: "rb|B", harness: "opencode", permissions: "auto" },
  } }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({
    schema: "0.20", teams: { alpha: { root: wt, registry_location: join(wt, ".tap", "team-registry.json"), state: "registered" } },
  }));
  // The door reads its state under TAP_HOME (the bus home), not the worktree.
  writeFileSync(join(bus, "frame.idle"), composer(""));
  writeFileSync(join(bus, "frame.wedge"), composer("continue"));
  writeFileSync(join(bus, "frame.spin"), SPIN);
  writeFileSync(join(bus, "mode"), "frame.spin\n");
  writeFileSync(join(wt, "socket"), "socket\n");
  const env = {
    ...process.env, HOME: wt, TAP_HOME: bus, TAP_INDEX_HOME: index, TAP_SELF: "ua", TAP_LOCK_DIR: join(wt, "locks"),
    TAP_TMUX_SOCKET_PATH: join(wt, "socket"), TAP_SPOOL_DISABLE_DELIVERER: "1", SCRIPTS_DIR: scriptsDir, HARNESS: "opencode",
    PATH: `${join(wt, "bin")}:${process.env.PATH}`,
    PID: id, R: recovery ? "1" : "0", FAKE_INTERRUPT_FAIL: interruptFail ? "1" : "",
  } as NodeJS.ProcessEnv;
  const r = spawnSync("bun", [SEND_PROBE], { encoding: "utf8", env, cwd: wt, timeout: 120_000 });
  if (r.status !== 0) throw new Error(`send probe failed (${r.status}): ${r.stderr || r.stdout}`);
  const m = r.stdout.match(/rc=(\d+) disposition=(\S+) interrupt=(\S+)/)!;
  return { rc: Number(m[1]), disposition: m[2]!, interrupt: m[3]!, home: wt };
}

test("the send door parks an ordinary urgent note for an auto seat before any pane effect", () => {
  const r = runSendProbe(false, "seam-send-ordinary");
  try {
    expect({ rc: r.rc, disposition: r.disposition, interrupt: r.interrupt }).toEqual({ rc: 0, disposition: "queued-spool", interrupt: "none" });
    const meta = JSON.parse(readFileSync(join(r.home, ".tap", "bus", "spool", "seam-send-ordinary.meta.json"), "utf8"));
    expect(meta.reason).toBe("auto_mode_no_interrupt");
    expect(existsSync(join(r.home, ".tap", "bus", "effects"))).toBe(false);
    expect(existsSync(join(r.home, ".tap", "bus", "registry-events.log"))).toBe(false);
  } finally { rmSync(r.home, { recursive: true, force: true }); }
}, 120_000);

test("the recovery opt interrupts the auto seat and stamps the registry event", () => {
  const r = runSendProbe(true, "seam-send-recovery");
  try {
    expect({ rc: r.rc, disposition: r.disposition }).toEqual({ rc: 0, disposition: "delivered" });
    const effects = readFileSync(join(r.home, ".tap", "bus", "effects"), "utf8").split("\n").filter(Boolean);
    const escapeTokens = effects.reduce((n, l) => n + l.split("Escape").length - 1, 0);
    expect(escapeTokens).toBe(2);
    expect(effects.findIndex(l => l.startsWith("paste-buffer"))).toBeGreaterThan(effects.findIndex(l => l.includes("Escape")));
    const events = readFileSync(join(r.home, ".tap", "bus", "registry-events.log"), "utf8");
    // One key=value atom per line (`ts= actor= action= … detail= team=`).
    expect(events).toContain("action=urgent_interrupt");
    expect(events, events).toContain('"recovery":true');
    expect(existsSync(join(r.home, ".tap", "bus", "spool", "seam-send-recovery.meta.json"))).toBe(false);
  } finally { rmSync(r.home, { recursive: true, force: true }); }
}, 120_000);

test("an unverified post-interrupt send still reports the interrupt fact on its rc-5 outcome", () => {
  // Escapes fired, then the key acceptance could not be confirmed: the rc-5
  // SendOutcome must carry the interrupt, or callers would print "no interrupt
  // keys sent" over a pane that was just cleared (tap-pkh9c review, material 1).
  const r = runSendProbe(true, "seam-send-unverified", true);
  expect(r.rc).toBe(5);
  expect(r.disposition).toBe("unverified");
  expect(r.interrupt).toBe("keys");
}, 120_000);
