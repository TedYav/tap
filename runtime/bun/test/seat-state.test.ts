// Native `tap_seat_state` (seat-state.ts). The lib.sh body and its private
// helpers are gone; the cases their sourcing smokes carried live here, over the
// same fixtures, through injected tmux/harness reads. The "ladder" block pins
// the precedence order: each case sets two rungs against each other, so moving
// or dropping either rung turns it red.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { frameIo, type PaneIo } from "../src/pane/reader";
import {
  activeHarnessCount, cursorPromptReady, opencodePromptReady, seatState, transcriptFresh, wedgeHash, type SeatStateDeps,
} from "../src/seat-state";

const ROOT = resolve(import.meta.dir, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "tap-seat-state-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const claude = (name: string) => read(`runtime/bun/test/fixtures/agent-state/claude/${name}.txt`);

let n = 0;
interface World {
  row?: Record<string, unknown>;
  seats?: Record<string, unknown>;
  team?: unknown;
  frame?: string;
  io?: PaneIo;
  activity?: string;
  alive?: boolean;
  fresh?: boolean;
  env?: Record<string, string>;
  deps?: Partial<SeatStateDeps>;
  home?: string;
}
function observe(w: World): string {
  const dir = join(scratch, `w${n++}`);
  const registry = join(dir, "registry.json");
  mkdirSync(dir, { recursive: true });
  const seats = w.seats ?? { s: { status: "active", pane: "%1", harness: "claude", registered_from_worktree: "/fixture", ...w.row } };
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: w.team ?? { name: "fixture" }, seats }));
  const displays: Record<string, string> = { "#{pane_id}": w.alive === false ? "" : "%1\n", "#{window_activity}": `${w.activity ?? "0"}\n` };
  return seatState("s", {
    registry, home: w.home ?? dir,
    env: { TAP_WATCH_NOW: "1000", TAP_SEAT_STALE_AFTER: "300", TAP_SEAT_STATE_READONLY: "1", ...w.env },
    deps: {
      io: w.io ?? frameIo(w.frame ?? "", "80"),
      display: (_pane, format) => displays[format] ?? "",
      transcriptFresh: () => w.fresh ?? false,
      harnessOf: (_pane, cmd) => cmd,
      ...w.deps,
    },
  });
}

describe("registry row gates", () => {
  test("the existing alert rung reports a provider error even with fresh activity", () => {
    const frame = read("runtime/bun/test/fixtures/agent-state/errors/claude-api-overloaded.txt");
    expect(observe({ frame, fresh: true, activity: "1000" })).toBe("rate-limited-error");
  });
  test("absent, inactive, pane-gone and non-string rows are unknown", () => {
    const frame = claude("done-real");
    expect(observe({ seats: {}, frame })).toBe("unknown");
    expect(observe({ row: { status: "suspended" }, frame })).toBe("unknown");
    expect(observe({ alive: false, frame })).toBe("unknown");
    expect(observe({ row: { pane: null }, frame })).toBe("unknown");
    expect(observe({ row: { harness: 7 }, frame })).toBe("unknown");
  });
  test("an absent status reads as active", () => {
    expect(observe({ seats: { s: { pane: "%1", harness: "claude" } }, frame: claude("done-real") })).toBe("idle-at-prompt");
  });
  test("an empty recorded harness resolves through the pane command", () => {
    const displays = (_p: string, f: string) => ({ "#{pane_id}": "%1", "#{pane_current_command}": "claude\n" } as Record<string, string>)[f] ?? "";
    expect(observe({ row: { harness: "" }, frame: claude("done-real"), deps: { display: displays } })).toBe("idle-at-prompt");
  });
});

// seat-activity.test.ts's Bash-stub cases, now native.
describe("claude busy footer", () => {
  const idle = claude("done-real");
  // The live prompt row is "❯" + NBSP; a plain "❯ " first matches scrollback.
  const typed = (text: string) => idle.replace("❯\u00a0", `❯\u00a0${text}`);
  for (const draft of ["", "human draft", "explain esc to interrupt", "first line\nesc to interrupt"]) {
    test(`idle activity is independent of composer contents: ${JSON.stringify(draft)}`, () => {
      expect(observe({ frame: draft ? typed(draft) : idle, activity: "1000" })).toBe("idle-at-prompt");
    });
  }
  test("a positive busy footer outranks a draft without recent window activity", () => {
    expect(observe({ frame: typed("human draft") + "\nWorking · esc to interrupt\n", activity: "1" })).toBe("working");
  });
  test("a real wrapped busy footer is working", () => {
    expect(observe({ frame: claude("working-real"), activity: "1" })).toBe("working");
  });
  for (const [mode, fn] of [["fail", () => { throw new Error("observer failed"); }], ["malformed", () => "nonsense"]] as const) {
    test(`observer ${mode} does not turn recent activity into working`, () => {
      expect(observe({ frame: typed("human draft"), activity: "1000", deps: { claudeActivity: fn } })).toBe("unknown");
    });
  }
});

// opencode-splash-state.test.sh's seat-state arms, now native.
describe("opencode", () => {
  const splash = "skills/tap/scripts/smoke/fixtures/opencode-splash";
  const row = { harness: "opencode", pane: "fake-pane" };
  test("a splash with no input band is booting", () => {
    expect(observe({ row, frame: read(`${splash}/constructed-splash.txt`) })).toBe("booting");
  });
  test("a healthy empty band is idle-at-prompt", () => {
    expect(observe({ row, frame: read(`${splash}/healthy-idle-band.txt`) })).toBe("idle-at-prompt");
  });
  test("an all-wrapped live pane reads its physical rows, not the one joined line", () => {
    const cap = "runtime/bun/test/fixtures/opencode-capture/all-wrapped-160";
    const plain = read(`${cap}.plain.txt`), joined = read(`${cap}.joined.txt`);
    expect(joined.trimEnd().split("\n")).toHaveLength(1);
    const io: PaneIo = { capture: (_t, _e, j) => ({ code: 0, stdout: j ? joined : plain }), paneWidth: () => "160" };
    expect(observe({ row, io })).toBe("working");
  });
  test("a generating band is working", () => {
    expect(observe({ row, frame: read("runtime/bun/test/fixtures/agent-state/opencode/working.txt") })).toBe("working");
  });
  test("an alert phrase split across physical rows is normalized", () => {
    expect(observe({ row, frame: "rate limit\nreached\n" })).toBe("rate-limited-error");
  });
  test("prompt-ready scan: last border wins; esc interrupt below it is busy", () => {
    expect(opencodePromptReady("")).toBe(3);
    expect(opencodePromptReady("╹▀▀▀")).toBe(3);
    expect(opencodePromptReady("x\n╹▀▀▀")).toBe(3);
    expect(opencodePromptReady("┃ >\n╹▀▀▀\n status")).toBe(0);
    expect(opencodePromptReady("┃ >\n╹▀▀▀\n esc interrupt")).toBe(1);
    expect(opencodePromptReady("┃ a\n╹▀▀▀\n esc interrupt\n┃ b\n╹▀▀▀\n idle")).toBe(0);
    expect(opencodePromptReady(" ┃ >\n ╹▀▀▀")).toBe(0);
  });
});

// cursor-harness.test.sh section 5a, now native.
describe("hermes", () => {
  const fx = "skills/tap/scripts/smoke/fixtures/hermes-prompt";
  const row = { harness: "hermes", pane: "hermespane" };
  test("a placeholder seat is idle even with a fresh transcript", () => {
    expect(observe({ row, frame: read(`${fx}/placeholder.ansi`), fresh: true, env: { TAP_SEAT_STALE_AFTER: "1" } })).toBe("idle-at-prompt");
  });
  test("a typed seat falls through to its fresh transcript and stays working", () => {
    expect(observe({ row, frame: read(`${fx}/typed.ansi`), fresh: true, env: { TAP_SEAT_STALE_AFTER: "1" } })).toBe("working");
  });
  // tap-rhajr: the working "⚕ ❯" composer is a readable, empty prompt row; the
  // busy gate must catch it before the liveness rung calls the seat stopped.
  test("a working seat's empty ⚕ composer is working, with no transcript or activity", () => {
    const frame = read("skills/tap/scripts/smoke/fixtures/peek-harness-adapters/hermes-working.ansi");
    expect(observe({ row, frame, activity: "1" })).toBe("working");
  });
});

describe("cursor", () => {
  test("ctrl+c to stop within the last twelve non-blank rows is busy", () => {
    expect(cursorPromptReady("")).toBe(true);
    expect(cursorPromptReady("  ctrl+c to stop\n → \n\n  \n")).toBe(false);
    expect(cursorPromptReady(["ctrl+c to stop", ...Array(12).fill("row"), ""].join("\n"))).toBe(true);
    expect(cursorPromptReady(["ctrl+c to stop", ...Array(11).fill("row")].join("\n"))).toBe(false);
  });
  test("a busy cursor band is working even at an empty prompt", () => {
    expect(observe({ row: { harness: "cursor" }, frame: "  → \n  ctrl+c to stop\n" })).toBe("working");
  });
});

describe("codex busy footer", () => {
  const row = { harness: "codex" };
  const prompt = "› \x1b[2mAsk Codex to do anything\x1b[0m\n";
  test("a live busy marker outranks the empty painted composer and old activity", () => {
    expect(observe({ row, frame: `• Working (2s • esc to interrupt)\n\n${prompt}`, activity: "1" })).toBe("working");
  });
  test("a quiet painted composer outranks courier activity and a fresh transcript", () => {
    expect(observe({ row, frame: prompt, activity: "1000", fresh: true })).toBe("idle-at-prompt");
  });
  test("a stale working row outside the live footer cannot make an idle seat busy", () => {
    const frame = `• Working (2s • esc to interrupt)\n${Array(5).fill("finished output").join("\n")}\n${prompt}`;
    expect(observe({ row, frame, activity: "1000" })).toBe("idle-at-prompt");
  });
  test("a typed lookalike does not establish an empty composer", () => {
    expect(observe({ row, frame: "› Ask Codex to do anything\n", activity: "1" })).toBe("unknown");
  });
});

describe("ladder", () => {
  const idle = claude("done-real");
  test("R1 alert > R2 busy footer: a rate limit under a working footer is rate-limited", () => {
    expect(observe({ frame: claude("working-real") + "\nrate limit reached\n" })).toBe("rate-limited-error");
  });
  test("R1 alert > R3 liveness: an approval prompt at an empty prompt is blocked", () => {
    expect(observe({ row: { harness: "codex" }, frame: "approval required\n› \n" })).toBe("blocked-on-approval");
  });
  test("R2 busy footer > R3 liveness: opencode generating over an empty box is working", () => {
    expect(observe({ row: { harness: "opencode" }, frame: "┃ \n╹▀▀▀\n esc interrupt\n" })).toBe("working");
  });
  test("R3 liveness > R4 shortcuts: an empty prompt with fresh activity and transcript is idle", () => {
    expect(observe({ row: { harness: "codex" }, frame: "done\n› \n", activity: "1000", fresh: true })).toBe("idle-at-prompt");
  });
  test("tap-8nmot: Codex's dim idle placeholder reads as an empty composer, not other-text", () => {
    // The composer reads the ESCAPED capture; the stripped frame has lost the
    // dim paint that tells the placeholder from typed words.
    const frame = "done\n› \x1b[2mAsk Codex to do anything\x1b[0m\n";
    expect(observe({ row: { harness: "codex-work" }, frame, activity: "1000", fresh: true })).toBe("idle-at-prompt");
    const typed = "done\n› Ask Codex to do anything\n";
    expect(observe({ row: { harness: "codex-work" }, frame: typed, activity: "1000", fresh: true })).toBe("working");
  });
  test("tap-8nmot: a named Codex profile takes the busy gate before the composer", () => {
    // The escaped capture reads a painted placeholder as an empty composer, so
    // a generating codex-* frame must read working at the busy gate first.
    const frame = "• Working (8s • esc to interrupt)\n\n› \x1b[2mAsk Codex to do anything\x1b[0m\n";
    expect(observe({ row: { harness: "codex-work" }, frame })).toBe("working");
  });
  test("R4 transcript shortcut needs the sole seat of its harness in the worktree", () => {
    const frame = "thinking\n› draft\n";
    expect(observe({ row: { harness: "codex" }, frame, fresh: true })).toBe("working");
    const two = { s: { status: "active", pane: "%1", harness: "codex", registered_from_worktree: "/fixture" },
      t: { status: "active", pane: "%2", harness: "codex", registered_from_worktree: "/fixture" } };
    expect(observe({ seats: two, frame, fresh: true })).toBe("unknown");
  });
  test("R4 window activity: recent is working; stale, absent or malformed is not", () => {
    const frame = "thinking\n› draft\n";
    expect(observe({ row: { harness: "codex" }, frame, activity: "900" })).toBe("working");
    expect(observe({ row: { harness: "codex" }, frame, activity: "600" })).toBe("unknown");
    expect(observe({ row: { harness: "codex" }, frame, activity: "" })).toBe("unknown");
    expect(observe({ row: { harness: "codex" }, frame, activity: "12x" })).toBe("unknown");
  });
  test("R4 shortcuts > R5 wedge: an unchanged frame with recent activity is working, not wedged", () => {
    const home = join(scratch, "wedge-r4");
    const frame = "thinking\n› draft\n";
    observe({ row: { harness: "codex" }, frame, home, env: { TAP_SEAT_STATE_READONLY: "0" } });
    expect(observe({ row: { harness: "codex" }, frame, home, activity: "999", env: { TAP_SEAT_STATE_READONLY: "0" } })).toBe("working");
  });
  test("R5 wedge: the second identical observation is wedged; a resize-rewrap is still the same frame", () => {
    const home = join(scratch, "wedge-r5");
    const rw = { TAP_SEAT_STATE_READONLY: "0" };
    expect(observe({ row: { harness: "codex" }, frame: "plodding along now\n› draft\n", home, env: rw })).toBe("unknown");
    expect(observe({ row: { harness: "codex" }, frame: "plodding\nalong now\n›  draft\n", home, env: rw })).toBe("wedged");
    expect(observe({ row: { harness: "codex" }, frame: "moved on\n› draft\n", home, env: rw })).toBe("unknown");
  });
  test("readonly observes the cache without writing it", () => {
    const home = join(scratch, "wedge-ro");
    expect(observe({ row: { harness: "codex" }, frame: "x\n› d\n", home })).toBe("unknown");
    expect(existsSync(join(home, "seat-state", "s.hash"))).toBe(false);
  });
  test("an idle claude with a fresh transcript stays idle: R2's claude band precedes R4", () => {
    expect(observe({ frame: idle, activity: "1000", fresh: true })).toBe("idle-at-prompt");
  });
});

describe("helpers", () => {
  test("wedgeHash is the incumbent's python-rejoin + newline + sha256", () => {
    // `printf '%s' "plodding along" | python3 -c 'print(" ".join(sys.stdin.read().split()))' | shasum -a 256`
    expect(wedgeHash("plodding along")).toBe("71667e01ad45121575facfaa2f16ae1b5cf16004de5a9b4dd8c7eff498a3da8b");
    expect(wedgeHash("plodding \n along ")).toBe(wedgeHash("plodding along"));
  });
  test("activeHarnessCount: team root fallback; a malformed team voids the count only when consulted", () => {
    const reg = join(scratch, "count.json");
    const write = (team: unknown, seats: Record<string, unknown>) => writeFileSync(reg, JSON.stringify({ team, seats }));
    write({ worktree_root: "/w" }, { a: { harness: "codex" }, b: { harness: "codex", registered_from_worktree: "/w" },
      c: { harness: "codex", status: "suspended" }, d: { harness: "claude" } });
    expect(activeHarnessCount(reg, "codex", "/w")).toBe(2);
    write(["bad"], { a: { harness: "codex", registered_from_worktree: "/w" } });
    expect(activeHarnessCount(reg, "codex", "/w")).toBe(1);
    write(["bad"], { a: { harness: "codex" } });
    expect(activeHarnessCount(reg, "codex", "/w")).toBe(0);
    expect(activeHarnessCount(join(scratch, "absent.json"), "codex", "/w")).toBe(0);
  });
});

// tap-3oox6: the real default-mode approval frames (provenance in
// approval-delivery.test.ts) are blocked here too, not only in the courier. The
// generic alert vocabulary misses every one of them.
describe("real approval prompts are blocked-on-approval", () => {
  const real = (harness: string, name: string) => read(`runtime/bun/test/fixtures/agent-state/${harness}/${name}.txt`);
  for (const [harness, command] of [["claude", "claude"], ["codex", "codex"], ["opencode", "opencode"], ["cursor", "cursor"], ["agy", "agy"], ["hermes", "hermes"]] as const) {
    const name = harness === "hermes" ? "blocked" : "blocked-real";
    test(`${harness} ${name}`, () => {
      expect(observe({ row: { harness: command }, frame: real(harness, name), activity: "1000", fresh: true })).toBe("blocked-on-approval");
    });
  }
  for (const [harness, name] of [["cursor", "blocked-auto-review-real"], ["agy", "trust-auto-real"], ["opencode", "blocked-auto-real"], ["codex", "trust-auto-real"], ["claude", "trust-auto-real"]] as const) {
    test(`${harness} ${name}`, () => {
      expect(observe({ row: { harness }, frame: real(harness, name), activity: "1000", fresh: true })).toBe("blocked-on-approval");
    });
  }
  for (const harness of ["opencode", "cursor", "agy"]) {
    test(`${harness} idle-real stays unblocked`, () => {
      expect(observe({ row: { harness }, frame: real(harness, "idle-real") })).not.toBe("blocked-on-approval");
    });
  }
});

// Review finding: OpenCode's shell composer is blocked for delivery but is not an
// approval prompt, so seatState keeps it out of blocked-on-approval.
test("an OpenCode shell-mode frame is not blocked-on-approval", () => {
  const frame = read("runtime/bun/test/fixtures/opencode-capture/shell-mode-staged-160.ansi");
  expect(observe({ row: { harness: "opencode" }, frame })).not.toBe("blocked-on-approval");
});

// tap-isha0: the Codex freshness test must cost the recent rollouts, not the operator's whole history.
test("the fallback uses the seat's recorded transcript outside harness history", () => {
  const path = join(scratch, "recorded.jsonl");
  writeFileSync(path, JSON.stringify({ type: "assistant", sessionId: "recorded", cwd: "/fixture", message: { stop_reason: "tool_use" } }) + "\n");
  utimesSync(path, 990, 990);
  expect(observe({ row: { transcript_path: path, harness_session_id: "recorded" },
    frame: "unrecognized UI", deps: { transcriptFresh }, env: { TAP_CLAUDE_HOME: join(scratch, "no-history") } })).toBe("working");
});

describe("recorded transcript freshness", () => {
  const NOW = 2_000_000_000;
  for (const harness of ["claude", "codex"]) {
    test(`${harness}: recorded path only, stale metadata before any bounded content read`, () => {
      const path = join(scratch, `${harness}-large.jsonl`);
      const head = harness === "codex" ? { type: "session_meta", payload: { id: "bound" } }
        : { type: "assistant", sessionId: "bound", message: {} };
      writeFileSync(path, JSON.stringify(head) + "\n");
      truncateSync(path, 4 << 20);
      // A valid last record lets Claude's bounded tail bind the session.
      fs.appendFileSync(path, "\n" + JSON.stringify({ type: "assistant", sessionId: "bound", message: {} }) + "\n");
      utimesSync(path, NOW - 301, NOW - 301);
      const seat = { transcript_path: path, harness_session_id: "bound" };
      const open = spyOn(fs, "openSync"), listing = spyOn(fs, "readdirSync"), stat = spyOn(fs, "statSync");
      const realRead = fs.readSync;
      let bytes = 0;
      const read = spyOn(fs, "readSync").mockImplementation(((...args: any[]) => {
        const n = (realRead as any)(...args); bytes += n; return n;
      }) as any);
      try {
        expect(transcriptFresh(harness, seat, NOW, 300, {})).toBe(false);
        expect(open).not.toHaveBeenCalled();
        expect(stat).toHaveBeenCalledTimes(1);
        utimesSync(path, NOW - 10, NOW - 10);
        expect(transcriptFresh(harness, seat, NOW, 300, {})).toBe(true);
        expect(bytes).toBeLessThanOrEqual(320 * 1024);
        expect(listing).not.toHaveBeenCalled();
        expect(transcriptFresh(harness, { ...seat, harness_session_id: "other" }, NOW, 300, {})).toBe(false);
        expect(transcriptFresh(harness, { harness_session_id: "bound" }, NOW, 300, {})).toBe(false);
        expect(transcriptFresh(harness, { ...seat, transcript_path: "relative.jsonl" }, NOW, 300, {})).toBe(false);
        expect(transcriptFresh(harness, { ...seat, transcript_path: join(scratch, "missing") }, NOW, 300, {})).toBe(false);
      } finally { open.mockRestore(); listing.mockRestore(); stat.mockRestore(); read.mockRestore(); }
    });
  }
});
