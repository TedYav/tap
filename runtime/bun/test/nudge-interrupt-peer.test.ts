// tap-pkh9c unit 3: the public single-peer form `tap nudge --interrupt
// <peer|team/peer>`. Parse/refusal guards run in-process (they throw before
// any side effect); delivery and refusal classes run through the same
// PATH-tmux door and registry fixture as the seam tests, exercising the real
// courier path.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { TapError } from "../src/context";
import { cmdNudge } from "../src/verbs/nudge";

const repo = join(import.meta.dir, "..", "..", "..");
const scriptsDir = join(repo, "skills", "tap", "scripts");

const composer = (text: string): string =>
  `  ┃ ${text}\n  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n  16.0K (8%)  ctrl+p commands · OpenCode 1.17.13\n`;
const SPIN = "  ⣟ Working...\n  esc to interrupt · 16.0K (8%)  ctrl+p commands · OpenCode 1.17.13\n";

// Same door contract as nudge-interrupt-seam.test.ts (kept local so the two
// files can evolve independently).
const DOOR_TMUX = `#!/usr/bin/env bash
set -u
T="\${DOOR_DIR:-\${TAP_HOME:?}}"
while [ $# -ge 3 ] && { [ "$1" = "-L" ] || [ "$1" = "-S" ]; }; do shift 2; done
case "$1" in
  capture-pane)
    [ -f "$T/mode" ] || exit 1
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
        if [ "\${FAKE_INTERRUPT_FAIL:-0}" = "1" ]; then : > "$T/interrupted"; exit 1; fi
        : > "$T/interrupted"; printf 'frame.idle\\n' > "$T/mode" ;;
      Enter|C-u|BSpace) printf 'frame.idle\\n' > "$T/mode" ;;
    esac ;;
  load-buffer) printf '%s\\n' "$4" > "$T/buf.$3" ;;
  paste-buffer)
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

test("the peer interrupt form parses and refuses before any resolution", () => {
  const refusal = (argv: string[]) => { try { cmdNudge(argv, scriptsDir, new Set(["opencode"])); return ""; } catch (e) { return `${(e as TapError).errorClass}: ${(e as TapError).detail}`; } };
  expect(refusal(["--interrupt"])).toContain("usage: tap nudge --interrupt <peer|team/peer>");
  expect(refusal(["--interrupt", "a/b", "--reason", "x", "-m", "y"])).toContain("--reason cannot be combined with -m/-f");
  expect(refusal(["--interrupt", "a/b", "-m", "x", "-f", "y"])).toContain("either -m or -f");
  expect(refusal(["--interrupt", "a/b", "--pane", "%1"])).toContain("--interrupt targets registered seats");
  expect(refusal(["--interrupt", "a/b", "--bogus"])).toContain("unknown option '--bogus'");
  expect(refusal(["--interrupt", "a", "b"])).toContain("unexpected arg 'b'");
  expect(refusal(["--interrupt", "a/b", "--reason"])).toContain("--reason needs a value");
  // A body that SAYS --team routes to the peer parser, not the fan-out one:
  // signals count only in flag position (tap-pkh9c review).
  expect(refusal(["--interrupt", "a/b", "-m", "--team"])).not.toContain("--harness is required");
  // tap-gridx: one target, one spelling; one sender, one spelling.
  expect(refusal(["--interrupt", "--to", "a/b", "a/c"])).toContain("unexpected arg 'a/c' (the target is already 'a/b')");
  expect(refusal(["--interrupt", "a/b", "--to", "a/c"])).toContain("the target is already 'a/b'; pass it positionally or with --to, not both");
  expect(refusal(["--interrupt", "--to", "a/b", "--from"])).toContain("--from needs a value");
  expect(refusal(["--interrupt", "--from", "x"])).toContain("usage: tap nudge --interrupt <peer|team/peer> | --to <peer|team/peer>");
  // A body that SAYS --interrupt is a body: the recovery parser gets it, not the interrupt one.
  expect(refusal(["b", "-m", "--interrupt"])).not.toContain("usage: tap nudge --interrupt");
  // Recovery sends no note, so it has no sender to name.
  expect(refusal(["b", "--from", "x"])).toContain("recovery sends no note; --from applies to --interrupt and --harness");
  expect(refusal(["--from", "x", "b"])).toContain("recovery sends no note; --from applies to --interrupt and --harness");
  expect(refusal(["--to", "b", "c"])).toContain("unexpected arg 'c' (the target is already 'b')");
  expect(refusal(["--harness", "codex", "--to", "b"])).toContain("the --harness fan-out form selects its seats by family");
});

function runPeerProbe(argv: string[], seatStatus: Record<string, Record<string, unknown>>, mode = "spin", extraEnv: Record<string, string> = {}, stdin = ""): { stdout: string; home: string } {
  const wt = mkdtempSync("/tmp/tap-nudge-peer-");
  const bus = join(wt, ".tap", "bus");
  mkdirSync(join(bus, "payloads"), { recursive: true });
  mkdirSync(join(bus, "receipts"), { recursive: true });
  mkdirSync(join(wt, "bin"));
  const index = join(wt, "index");
  mkdirSync(index);
  writeFileSync(join(wt, "bin", "tmux"), DOOR_TMUX, { mode: 0o755 });
  // Pass `ps` through, except that FAKE_PS_TTY gives the ancestry walk a controlling terminal no pane owns. Without one
  // the probe (no tty under a runner or CI) refuses "cannot tell whether this terminal is a seat" instead of "outside".
  writeFileSync(join(wt, "bin", "ps"), '#!/bin/sh\nif [ -n "${FAKE_PS_TTY:-}" ] && [ "$1" = "-o" ] && [ "$2" = "ppid=" ]; then printf "  1 %s\\n" "$FAKE_PS_TTY"; exit 0; fi\nexec /bin/ps "$@"\n', { mode: 0o755 });
  writeFileSync(join(wt, ".tap", "team-registry.json"), JSON.stringify({ schema: "0.20", team: { name: "alpha", worktree_root: wt }, seats: {
    ua: { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:4242:100", instance: "ua|A", harness: "claude" },
    rb: { status: "active", pane: "rb:0.0", pane_id: "%1", server_epoch: "srv:4242:100", instance: "rb|B", harness: "opencode", permissions: "auto", ...seatStatus.rb },
    ...seatStatus.extra,
  } }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({
    schema: "0.20", teams: { alpha: { root: wt, registry_location: join(wt, ".tap", "team-registry.json"), state: "registered" } },
  }));
  writeFileSync(join(bus, "frame.idle"), composer(""));
  writeFileSync(join(bus, "frame.wedge"), composer("continue"));
  writeFileSync(join(bus, "frame.spin"), SPIN);
  writeFileSync(join(bus, "mode"), `frame.${mode}\n`);
  writeFileSync(join(wt, "socket"), "socket\n");
  const env = {
    ...process.env, HOME: wt, TAP_HOME: bus, TAP_INDEX_HOME: index, TAP_SELF: "ua", TAP_LOCK_DIR: join(wt, "locks"),
    TAP_TMUX_SOCKET_PATH: join(wt, "socket"), TAP_SPOOL_DISABLE_DELIVERER: "1", SCRIPTS_DIR: scriptsDir, HARNESS: "opencode",
    PATH: `${join(wt, "bin")}:${process.env.PATH}`, PEER_ARGV: JSON.stringify(argv), DOOR_DIR: bus, ...extraEnv,
  } as NodeJS.ProcessEnv;
  const probe = join(import.meta.dir, "support", "nudge-interrupt-peer-probe.ts");
  const r = spawnSync("bun", [probe], { encoding: "utf8", env, cwd: wt, timeout: 120_000, input: stdin });
  if (r.status === null || (r.status !== 0 && !r.stdout.includes("taperror="))) {
    throw new Error(`peer probe failed (${r.status}): ${r.stderr || r.stdout}`);
  }
  return { stdout: r.stdout, home: wt };
}

test("the public form interrupts the selected wedge and submits the reason note", () => {
  const { stdout, home } = runPeerProbe(["--interrupt", "alpha/rb", "--reason", "stuck on CI"], {});
  try {
    expect(stdout).toContain("rc=0");
    expect(stdout).toContain("alpha/rb  interrupted (delivered)");
    const effects = readFileSync(join(home, ".tap", "bus", "effects"), "utf8").split("\n").filter(Boolean);
    const escapeTokens = effects.reduce((n, l) => n + l.split("Escape").length - 1, 0);
    expect(escapeTokens).toBe(2);
    const paste = effects.filter(l => l.startsWith("paste-buffer"));
    expect(paste).toHaveLength(1);
    // The pane receives the sentinel wire (interrupt class); the note body rides in its payload.
    // The paste log carries only the buffer name, so the id comes from the staged draft bytes.
    const staged = readFileSync(join(home, ".tap", "bus", "staged.bytes"), "utf8");
    const id = staged.match(/note (\S+) urgent agent-interrupt/)?.[1] ?? "";
    expect(id).not.toBe("");
    const payload = readFileSync(join(home, ".tap", "bus", "payloads", `${id}.md`), "utf8");
    expect(payload).toContain("Nudge: stuck on CI. Continue what you were working on.");
    const events = readFileSync(join(home, ".tap", "bus", "registry-events.log"), "utf8");
    expect(events).toContain("action=urgent_interrupt");
    expect(events).toContain('"recovery":true');
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 120_000);

test("suspended, offline, and poll members are refused as interrupt targets", () => {
  const cases: Array<[string[], string]> = [
    [["--interrupt", "alpha/rs"], "taperror=suspended"],
    [["--interrupt", "alpha/ro"], "taperror=not_a_target"],
    [["--interrupt", "alpha/rp"], "taperror=poll_mode_member"],
    [["--interrupt", "alpha/ua"], "taperror=not_a_target"],
  ];
  for (const [argv, expected] of cases) {
    const { stdout, home } = runPeerProbe(argv, { extra: {
      rs: { status: "suspended", pane: "rs:0.0", pane_id: "%7", harness: "opencode" },
      ro: { status: "offline", pane: "ro:0.0", pane_id: "%8", harness: "opencode", status_reason: "server_epoch_stale" },
      rp: { status: "active", delivery: "poll", pane: "rp:0.0", pane_id: "%9", harness: "opencode" },
    } });
    try {
      expect(stdout, argv.join(" ")).toContain(expected);
      expect(existsSync(join(home, ".tap", "bus", "effects")), argv.join(" ")).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
}, 180_000);

test("a launching or unbound target refuses before the sender is resolved, so no operator is asked about it (tap-w85su)", () => {
  // TAP_SELF names no seat: had the sender been resolved first, the refusal would be about the sender.
  const cases: Array<[string[], string]> = [
    [["--interrupt", "alpha/rl"], "taperror=seat_launching"],
    [["--interrupt", "alpha/rn"], "taperror=identity_unverified"],
  ];
  for (const [argv, expected] of cases) {
    const { stdout, home } = runPeerProbe(argv, { extra: {
      rl: { status: "active", status_reason: "launching", pane: "rl:0.0", pane_id: "%10", harness: "opencode" },
      rn: { status: "active", pane: "rn:0.0", pane_id: "", harness: "opencode" },
    } }, "idle", { TAP_SELF: "nobody-here" });
    try {
      expect(stdout, argv.join(" ")).toContain(expected);
      expect(stdout, argv.join(" ")).not.toContain("unregistered_sender");
      expect(existsSync(join(home, ".tap", "bus", "effects")), argv.join(" ")).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
}, 180_000);

test("keys fell but the note went unverified: exit 5 and the line refuses both lies", () => {
  const { stdout, home } = runPeerProbe(["--interrupt", "alpha/rb", "--reason", "x"], {}, "spin", { FAKE_INTERRUPT_FAIL: "1" });
  try {
    expect(stdout).toContain("rc=5");
    expect(stdout).toContain("alpha/rb  interrupted; note UNVERIFIED (possible effect; do not re-nudge)");
    const effects = readFileSync(join(home, ".tap", "bus", "effects"), "utf8").split("\n").filter(Boolean);
    // One Escape attempt, no retry, no paste: a possible effect is never replayed.
    expect(effects).toHaveLength(1);
    expect(effects[0]).toContain("Escape");
    expect(existsSync(join(home, ".tap", "bus", "payloads"))).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 120_000);

// tap-gridx: the sender is explicit and validated before any effect, in any argv position.
const fromOf = (home: string): string => {
  const staged = readFileSync(join(home, ".tap", "bus", "staged.bytes"), "utf8");
  const id = staged.match(/note (\S+) urgent agent-interrupt/)?.[1] ?? "";
  return readFileSync(join(home, ".tap", "bus", "payloads", `${id}.md`), "utf8").match(/^from: (.*)$/m)?.[1] ?? "";
};

test("--from names the sender in every spelling and position, and wins over TAP_SELF", () => {
  const extra = { extra: { lead: { status: "active", delivery: "poll", harness: "codex", instance: "lead|1" } } };
  const cases: Array<[string[], Record<string, string>, string]> = [
    [["--interrupt", "alpha/rb", "--from", "ua"], { TAP_SELF: "" }, "ua"],
    [["--from", "alpha/ua", "--interrupt", "alpha/rb"], { TAP_SELF: "" }, "ua"],
    [["--to", "rb", "--interrupt", "--from", "alpha/ua"], { TAP_SELF: "" }, "ua"],
    // A poll seat is an active sender: settle-only mail needs no pane to answer from.
    [["alpha/rb", "--interrupt", "--from", "lead"], { TAP_SELF: "ua" }, "lead"],
    // No --from: TAP_SELF is the sender.
    [["--interrupt", "--to", "alpha/rb"], {}, "ua"],
  ];
  for (const [argv, env, sender] of cases) {
    const { stdout, home } = runPeerProbe(argv, extra, "spin", env);
    try {
      expect(stdout, argv.join(" ")).toContain("alpha/rb  interrupted (delivered)");
      expect(fromOf(home), argv.join(" ")).toBe(sender);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
}, 300_000);

test("a sender that cannot send refuses with a recovery that works, before any key", () => {
  const extra = { extra: {
    rs: { status: "suspended", pane: "rs:0.0", pane_id: "%7", harness: "opencode" },
    ro: { status: "offline", pane: "ro:0.0", pane_id: "%8", harness: "opencode" },
  } };
  const cases: Array<[string[], Record<string, string>, string]> = [
    // The specimen: no registration, no TAP_SELF, no --from.
    [["--interrupt", "alpha/rb"], { TAP_SELF: "", FAKE_PS_TTY: "ttysFake" }, "taperror=unregistered_sender detail=this terminal is not a registered seat and is not interactive, so the sender is unknown"],
    [["--interrupt", "alpha/rb", "--from", "ghost"], {}, "sender 'ghost' is not an active seat on team 'alpha'"],
    [["--interrupt", "alpha/rb", "--from", "rs"], {}, "sender 'rs' is not an active seat"],
    [["--interrupt", "alpha/rb", "--from", "alpha/ro"], {}, "sender 'ro' is not an active seat"],
    // TAP_HOME pins alpha; a sender on another team never redirects it.
    [["--interrupt", "alpha/rb", "--from", "beta/x"], {}, "TAP_HOME pins team 'alpha', but the sender is on team 'beta'"],
    [["--interrupt", "alpha/rb", "--from", "user"], {}, "taperror=reserved_handle"],
    // The sender's own seat is not a target, whoever names it.
    [["--interrupt", "rb", "--from", "rb"], { TAP_SELF: "" }, "taperror=not_a_target detail='rb' is the sender's own seat"],
  ];
  for (const [argv, env, expected] of cases) {
    const { stdout, home } = runPeerProbe(argv, extra, "spin", env);
    try {
      expect(stdout, argv.join(" ")).toContain(expected);
      expect(existsSync(join(home, ".tap", "bus", "effects")), argv.join(" ")).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
}, 300_000);

test("the interrupt note body: -m and -f (including stdin) replace it whole", () => {
  const bodyFile = mkdtempSync("/tmp/tap-nudge-body-");
  writeFileSync(join(bodyFile, "note.md"), "resume `the build` now\n");
  const cases: Array<[string[], string, string]> = [
    [["--interrupt", "alpha/rb", "-m", "literal $(body)"], "", "literal $(body)"],
    [["--interrupt", "alpha/rb", "-f", join(bodyFile, "note.md")], "", "resume `the build` now"],
    [["--interrupt", "alpha/rb", "-f", "-"], "from stdin\n", "from stdin"],
    [["--interrupt", "alpha/rb"], "", "Nudge: continue what you were working on."],
  ];
  try {
    for (const [argv, stdin, body] of cases) {
      const { stdout, home } = runPeerProbe(argv, {}, "spin", {}, stdin);
      try {
        expect(stdout, argv.join(" ")).toContain("alpha/rb  interrupted (delivered)");
        const staged = readFileSync(join(home, ".tap", "bus", "staged.bytes"), "utf8");
        const id = staged.match(/note (\S+) urgent agent-interrupt/)?.[1] ?? "";
        expect(readFileSync(join(home, ".tap", "bus", "payloads", `${id}.md`), "utf8"), argv.join(" ")).toContain(body);
      } finally { rmSync(home, { recursive: true, force: true }); }
    }
  } finally { rmSync(bodyFile, { recursive: true, force: true }); }
}, 300_000);
