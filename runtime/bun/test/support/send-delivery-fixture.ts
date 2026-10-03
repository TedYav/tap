/**
 * Shared fixture for the send-delivery-classes components (D3a: the --polite,
 * --no-spool and router/conflict rows). One supported run.sh invocation runs
 * every selected file in ONE process, so this module is imported once and its
 * state is shared across those files. Lifecycle contract: fixture() lazily
 * creates the scratch root on first use, and each component file registers
 * afterAll(releaseScratch, 40_000), which removes the tree and resets the
 * cached path, so the NEXT file's first fixture() creates a fresh root. Never
 * cache the scratch path at import time and never claim per-file module
 * re-import — that is the unit-2 lifecycle defect class.
 */
import { expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRun } from "../../src/recovery/state";
import { removeScratchTree } from "./scratch";

const REPO = join(import.meta.dir, "..", "..", "..", "..");
export const TAP = join(REPO, "bin", "tap");
let scratchRoot: string | null = null;
function ensureScratchRoot(): string {
  if (scratchRoot === null || !existsSync(scratchRoot)) {
    scratchRoot = mkdtempSync(join(tmpdir(), "tap-send-classes."));
  }
  return scratchRoot;
}
/** Remove the scratch tree and reset the cached path; the next fixture() recreates it. */
export async function releaseScratch(): Promise<void> {
  const root = scratchRoot;
  if (root !== null) removeScratchTree(root);
  scratchRoot = null;
}
const CLAUDE_MODAL = join(import.meta.dir, "..", "fixtures", "agent-state", "claude", "blocked-real.txt");

// The fake tmux: one session `ua` (%6, the sender) and one `rb` (%7, the
// recipient), both running claude. The recipient's band is a file the row
// writes; FAKE_NOPROMPT renders a frame with no prompt glyph at all until the
// first injection lands in the band (a harness mid-turn that then takes the
// input); FAKE_INMODE answers copy-mode for %7.
const FAKE_TMUX = `#!/bin/sh
# FAKE_LATE_FENCE + FAKE_FENCE_MODE: on the FIRST observation of rb's pane
# (either door's combined or bare pane-id query) — after any pre-placement
# read, before the incumbent's single post-render read — publish a live fence
# (mode live), publish an already-expired one (mode expired), or remove the
# live fence the fixture started with (mode lift). One-shot: a marker file
# records that the transition happened.
late_fence() {
  if [ -n "$FAKE_LATE_FENCE" ] && [ ! -e "$FAKE_LATE_FENCE.done" ]; then
    : > "$FAKE_LATE_FENCE.done"
    case "$FAKE_FENCE_MODE" in
      live) printf '{"nonce":"rb","pid":%s,"since_epoch":%s,"ceiling_seconds":90}\\n' "$FAKE_FENCE_PID" "$(date +%s)" > "$FAKE_LATE_FENCE" ;;
      expired) printf '{"nonce":"rb","pid":%s,"since_epoch":%s,"ceiling_seconds":90}\\n' "$FAKE_FENCE_PID" "$(( $(date +%s) - 100000 ))" > "$FAKE_LATE_FENCE" ;;
      lift) rm -f "$FAKE_LATE_FENCE" ;;
    esac
  fi
}
# FAKE_HOLD + FAKE_HOLD_AT: park the FIRST recipient paste (paste) or capture
# (capture) until $FAKE_HOLD.release exists, after writing $FAKE_HOLD.reached,
# so a test can act while a send is mid-delivery. One-shot, bounded at 30 s.
hold() {
  if [ -n "$FAKE_HOLD" ] && [ "$FAKE_HOLD_AT" = "$1" ] && [ ! -e "$FAKE_HOLD.reached" ]; then
    : > "$FAKE_HOLD.reached"
    i=0; while [ ! -e "$FAKE_HOLD.release" ] && [ "$i" -lt 600 ]; do sleep 0.05; i=$((i + 1)); done
  fi
}
case " $* " in
  *"list-sessions"*) printf 'ua\\t123:456\\n'; printf 'rb\\t123:456\\n' ;;
  *"list-panes -a -F #{pane_id}"*) printf '%%6\\n%%7\\n' ;;
  *"list-panes"*)
    case " $* " in
      *"=rb"*|*" rb:"*|*" rb "*) printf 'rb\\trb:0.0\\t%%7\\t%s\\t4242\\t123:456\\t0\\n' "$FAKE_HARNESS" ;;
      *) printf 'ua\\tua:0.0\\t%%6\\tclaude\\t4242\\t123:456\\t0\\n' ;;
    esac ;;
  *"#{pane_id}"*"#{session_name}"*)
    case " $* " in
      *" ua:"*|*"=ua"*|*" ua "*|*" %6 "*) printf '%%6\\tua\\t4242\\tclaude\\t0\\n' ;;
      *) late_fence; printf '%%7\\trb\\t4242\\t%s\\t0\\n' "$FAKE_HARNESS" ;;
    esac ;;
  *"#{session_name}"*"#{pid}:#{start_time}"*)
    case " $* " in
      *" rb:"*|*"=rb"*|*" %7 "*) printf 'rb\\t123:456\\n' ;;
      *) printf 'ua\\t123:456\\n' ;;
    esac ;;
  *"#{pid}:#{start_time}"*) printf '123:456\\n' ;;
  *"#{pane_current_command}"*) printf '%s\\n' "$FAKE_HARNESS" ;;
  *"#{pane_in_mode}"*)
    case " $* " in
      *" ua:"*|*"=ua"*|*" %6 "*) printf '0\\n' ;;
      *) if [ -e "$FAKE_INMODE" ]; then printf '1\\n'; else printf '0\\n'; fi ;;
    esac ;;
  *"#{pane_pid}"*) printf '4242\\n' ;;
  *"#{pane_dead}"*) printf '0\\n' ;;
  *"#{session_windows}"*) printf '1\\n' ;;
  *"#{pane_id}"*)
    case " $* " in
      *" ua:"*|*"=ua"*|*" %6 "*) printf '%%6\\n' ;;
      *) late_fence; printf '%%7\\n' ;;
    esac ;;
  *"capture-pane"*)
    band="$FAKE_BAND"
    case " $* " in *" ua:"*|*"=ua"*|*" %6 "*) band="$FAKE_BAND.ua" ;; esac
    if [ "$band" = "$FAKE_BAND" ]; then hold capture; fi
    if [ "$band" = "$FAKE_BAND" ] && [ "$FAKE_HARNESS" = cursor ] && [ "$FAKE_CURSOR_BUSY" = 1 ] && ! grep -q 'C-c' "$FAKE_KEYS" 2>/dev/null; then
      # A mid-turn Cursor (fixtures/agent-state/cursor/working.txt) until its C-c lands.
      # The placeholder is dim in a real capture; the band reader tells it from typed text by that style.
      printf '  Composing the response\\n'; printf ' \\033[48;2;32;32;32m \\033[2m→ \\033[0;7m\\033[48;2;32;32;32mA\\033[0;2m\\033[48;2;32;32;32mdd a follow-up\\033[0m'; printf '                                      ctrl+c to stop\\n  Grok 4.7 256K High\\n'
    elif [ "$band" = "$FAKE_BAND" ] && [ "$FAKE_HARNESS" = cursor ]; then
      # Shaped like a real idle Cursor capture (fixtures/agent-state/cursor/idle-real.txt):
      # an empty composer shows its placeholder, and the model row sits under the bottom bar.
      printf '%s\\n' '▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄'
      if [ -s "$band" ] && [ ! -e "$band.submitted" ]; then printf '  → '; cat "$band"; else printf ' \\033[48;2;32;32;32m \\033[2m→ \\033[0;7m\\033[48;2;32;32;32mA\\033[0;2m\\033[48;2;32;32;32mdd a follow-up\\033[0m'; fi
      printf '\\n%s\\n' '▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀'
      printf '  Grok 4.7 256K High\\n'
    elif [ "$band" = "$FAKE_BAND" ] && [ "$FAKE_HARNESS" = hermes ]; then
      printf '%s\\n' '──────────────────────────────────────────'
      printf '❯ '; if [ -e "$band" ] && [ ! -e "$band.submitted" ]; then cat "$band"; fi
      printf '\\n%s\\n' '──────────────────────────────────────────'
    elif [ "$band" = "$FAKE_BAND" ] && [ -e "$FAKE_MODAL" ]; then cat "$FAKE_MODAL"
    elif [ "$band" = "$FAKE_BAND" ] && [ -e "$FAKE_UNCLASSIFIED" ] && [ ! -e "$band" ]; then printf 'Working on it...\\n'; printf '%s\\n' '──────────────────────────────────────────'
    elif [ "$band" = "$FAKE_BAND" ] && [ -e "$FAKE_NOPROMPT" ] && [ ! -e "$band" ]; then printf 'Working on it...\\n'; printf '%s\\n' '──────────────────────────────────────────'; printf 'esc to interrupt\\n'
    elif [ -e "$band.submitted" ]; then printf '› \\n'; printf '%s\\n' '──────────────────────────────────────────'
    elif [ -e "$band" ]; then printf '› '; cat "$band"; printf '\\n%s\\n' '──────────────────────────────────────────'
    else printf '› \\n'; printf '%s\\n' '──────────────────────────────────────────'; fi ;;
  *"set-option"*"window-style"*) case "$*" in *" -u "*) : ;; *) printf '%s\\n' "$*" >> "$FAKE_FLASHES" ;; esac ;;
  *"list-clients"*) printf 'owner-client\\n' ;;
  *"display-message"*) printf '%s\\n' "$*" >> "$FAKE_NOTICES"; printf '%s\\n' "display-message $*" >> "$FAKE_EFFECTS" ;;
  *"send-keys"*)
    band="$FAKE_BAND"
    case " $* " in *" ua:"*|*"=ua"*|*" %6 "*) band="$FAKE_BAND.ua" ;; esac
    case " $* " in
      *" -X cancel"*) if [ "$FAKE_CANCEL_CLEARS" = "1" ]; then rm -f "$FAKE_INMODE"; fi; printf '%s\\n' "$*" >> "$FAKE_KEYS" ;;
      *" -l -- "*) if [ "$band" = "$FAKE_BAND" ]; then hold paste; fi; rm -f "$band.submitted"; for last do :; done; printf '%s' "$last" > "$band"; printf '%s\\n' "$*" >> "$FAKE_KEYS" ;;
      *" Enter "*|*" Enter") : > "$band.submitted"; printf '%s\\n' "$*" >> "$FAKE_KEYS"; printf '%s\\n' "send-keys Enter" >> "$FAKE_EFFECTS" ;;
      *" Escape "*|*" Escape") if [ "$FAKE_INTERRUPT_CLEARS" = "1" ]; then : > "$band"; fi; printf '%s\\n' "$*" >> "$FAKE_KEYS"; if [ "$FAKE_INTERRUPT_FAIL" = "1" ]; then exit 1; fi ;;
      *) printf '%s\\n' "$*" >> "$FAKE_KEYS" ;;
    esac ;;
esac
exit 0
`;

interface FixtureOpts {
  harness?: string;
  /** A Cursor recipient shows its working frame until it receives C-c. */
  cursorBusy?: boolean;
  /** The recipient's band already holds this human draft. */
  draft?: string;
  /** The recipient's frame renders no prompt glyph, but a rule still classifies it: a Claude seat mid-turn (esc to interrupt). */
  noPrompt?: boolean;
  /** The recipient's frame renders no prompt glyph and no rule classifies it: delivery holds and no key is typed. */
  unclassified?: boolean;
  /** `#{pane_in_mode}` answers 1 for the recipient. */
  copyMode?: boolean;
  /** The recipient's frame is a real Claude permission prompt (a human decision on screen). */
  modal?: boolean;
  /** A live clearing fence for the recipient on its bus. */
  clearFence?: boolean;
  /** The fence changes on the first observation of the recipient's pane, after any pre-placement read: appears live, appears already expired, or (starting live) lifts. */
  lateFence?: "live" | "expired" | "lift";
  /** A live recovery run owns the recipient (`%7`), held by the sender's pane (`%6`). */
  recoveryHold?: boolean;
}

export function fixture(opts: FixtureOpts = {}) {
  const root = mkdtempSync(join(ensureScratchRoot(), "fx."));
  const index = join(root, "index");
  const bin = join(root, "bin");
  mkdirSync(index); mkdirSync(bin);
  const wt = join(root, "alpha");
  const bus = join(wt, ".tap", "bus");
  const registry = join(wt, ".tap", "team-registry.json");
  mkdirSync(join(bus, "payloads"), { recursive: true });
  mkdirSync(join(bus, "receipts"), { recursive: true });
  const git = Bun.spawnSync(["git", "init", "-q", wt], { stdout: "pipe", stderr: "pipe" });
  expect(git.exitCode).toBe(0);
  writeFileSync(registry, `${JSON.stringify({ schema: "0.20", team: { name: "alpha", worktree_root: wt }, seats: {
    ua: { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456", instance: "ua|A", harness: "claude" },
    rb: { status: "active", pane: "rb:0.0", pane_id: "%7", server_epoch: "srv:123:456", instance: "rb|B", harness: opts.harness ?? "claude" },
  } })}\n`);
  writeFileSync(join(index, "global-registry.json"), `${JSON.stringify({
    schema: "0.20", teams: { alpha: { root: wt, registry_location: registry, state: "registered" } },
  })}\n`);
  if (opts.clearFence) {
    mkdirSync(join(bus, "clear-fence"), { recursive: true });
    writeFileSync(join(bus, "clear-fence", "rb.json"), `${JSON.stringify({ nonce: "rb", pid: process.pid, since_epoch: Math.floor(Date.now() / 1000), ceiling_seconds: 90 })}\n`);
  }
  writeFileSync(join(bin, "tmux"), FAKE_TMUX, { mode: 0o755 });
  const socketPath = join(mkdtempSync(join(process.env.TMUX_TMPDIR!, "s.")), "tmux");
  writeFileSync(socketPath, "socket\n");
  const xdgConfig = join(root, "xdg-config");
  mkdirSync(xdgConfig);
  if (opts.draft !== undefined) writeFileSync(join(root, "band"), opts.draft);
  if (opts.noPrompt) writeFileSync(join(root, "no-prompt"), "");
  if (opts.unclassified) writeFileSync(join(root, "unclassified"), "");
  if (opts.copyMode) writeFileSync(join(root, "in-mode"), "");
  if (opts.modal) writeFileSync(join(root, "modal"), readFileSync(CLAUDE_MODAL));
  if (opts.lateFence) mkdirSync(join(bus, "clear-fence"), { recursive: true });
  if (opts.lateFence === "lift" && !opts.clearFence) throw new Error("lateFence: 'lift' needs clearFence to start live");
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${bin}:${process.env.PATH}`,
    XDG_CONFIG_HOME: xdgConfig,
    TAP_INDEX_HOME: index,
    TAP_SESSION_MANIFEST: join(root, "sessions.json"),
    OPENCODE_DB_PATH: join(root, "opencode.db"),
    TAP_VERSION_SEEN_PATH: join(root, "version-seen.json"),
    TAP_LOCK_DIR: join(root, "locks"),
    TAP_TMUX_SOCKET_PATH: socketPath,
    TAP_SPOOL_DISABLE_DELIVERER: "1",
    TMUX: undefined,
    TMUX_PANE: undefined,
    FAKE_BAND: join(root, "band"),
    FAKE_HARNESS: opts.harness ?? "claude",
    FAKE_CURSOR_BUSY: opts.cursorBusy ? "1" : "",
    FAKE_KEYS: join(root, "keys"),
    FAKE_FLASHES: join(root, "flashes"),
    FAKE_NOTICES: join(root, "notices"),
    FAKE_EFFECTS: join(root, "effects"),
    FAKE_NOPROMPT: join(root, "no-prompt"),
    FAKE_UNCLASSIFIED: join(root, "unclassified"),
    FAKE_INMODE: join(root, "in-mode"),
    FAKE_MODAL: join(root, "modal"),
    FAKE_LATE_FENCE: opts.lateFence ? join(bus, "clear-fence", "rb.json") : "",
    FAKE_FENCE_MODE: opts.lateFence ?? "",
    FAKE_FENCE_PID: String(process.pid),
  } as NodeJS.ProcessEnv;
  delete env.TAP_HOME;
  delete env.TAP_DRIVER_FORCE_TMUX;
  delete env.TAP_EPOCH;
  delete env.TAP_SPOOL_NOW;
  if (opts.recoveryHold) {
    // The run's own liveness facts are stubbed at creation; native then reads
    // the hold with LIVE facts (owner pid = this runner, owner pane %6
    // answered by the fake tmux), which is what makes the hold active.
    createRun({ team: "alpha", handle: "rb", registry, pane: "rb:0.0", paneId: "%7", session: "rb", instance: "rb|B", harness: "claude" },
      "aggressive", [], "%6", process.pid, env, { now: Date.now(), processAlive: () => true, paneAlive: () => true });
  }
  return { root, wt, bus, registry, env, keys: join(root, "keys") };
}

type Fx = ReturnType<typeof fixture>;

/** The native run's observable, normalized: ids, the fixture root and epochs are masked. */
export interface View {
  code: number;
  route: string;
  receipt: Record<string, string>;
  stdout: string;
  stderr: string;
  payloads: number;
  placed: number;
  spool: Array<Record<string, unknown>>;
  keys: string[];
}

export function run(fx: Fx, args: string[], json = true): View {
  const trace = join(fx.root, `route.${Math.random().toString(36).slice(2)}.trace`);
  const r = Bun.spawnSync([TAP, ...args, ...(json ? ["--json"] : [])], {
    cwd: fx.wt,
    env: { ...fx.env, TAP_SELF: "ua", TAP_BUN_ROUTE_TRACE: trace },
    stdout: "pipe", stderr: "pipe", timeout: 60_000,
  });
  const mask = (s: string): string => s
    .split(fx.root).join("<root>")
    .replace(/ua-\d{8}T\d{6}Z-[0-9a-f]{12}/g, "<id>")
    .replace(/\b1[0-9]{9}\b/g, "<epoch>")
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<iso>")
    // The queue explanation's next-probe clause is a wall-clock judgement made at receipt time (Bash renders it on both doors).
    .replace(/ \(scheduled time passed; next probe not confirmed\)/g, "");
  const out = r.stdout.toString();
  const err = r.stderr.toString();
  let receipt: Record<string, string> = {};
  for (const line of [...out.split("\n"), ...err.split("\n")].filter(l => l.startsWith("{"))) {
    try { receipt = JSON.parse(mask(line)) as Record<string, string>; } catch { /* not JSON */ }
  }
  const spoolDir = join(fx.bus, "spool");
  const spool = existsSync(spoolDir)
    ? readdirSync(spoolDir).filter(f => f.endsWith(".meta.json")).sort().map(f => {
      const meta = JSON.parse(readFileSync(join(spoolDir, f), "utf8")) as Record<string, unknown>;
      // The pinned policy facts only: id, times and paths vary per run.
      return { reason: meta.reason ?? meta.reason_class ?? null, policy: meta.policy ?? null, timeout_seconds: meta.timeout_seconds ?? null, to: meta.to ?? meta.target ?? null };
    })
    : [];
  const receipts = join(fx.bus, "receipts");
  return {
    code: r.exitCode,
    route: existsSync(trace) ? readFileSync(trace, "utf8").trim() : "",
    receipt,
    stdout: mask(out),
    stderr: mask(err),
    payloads: readdirSync(join(fx.bus, "payloads")).filter(f => f.endsWith(".md")).length,
    placed: existsSync(receipts) ? readdirSync(receipts).filter(f => f.endsWith(".placed")).length : 0,
    spool,
    // Native targets the pane id (%7); the keys compare on the rest.
    keys: existsSync(fx.keys) ? readFileSync(fx.keys, "utf8").split("\n").filter(Boolean).map(l => mask(l.replace(/^-S \S+ /, "").replace(/-t (%7|rb:0\.0)\b/, "-t <rb>"))) : [],
  };
}

export const routeOf = (verb: string): string => `native ${verb}`;

/** The pane-effect flashes the fake tmux applied, in order: one `bg=<style>` entry each. */
export function flashes(fx: Fx): string[] {
  const file = fx.env.FAKE_FLASHES!;
  return existsSync(file)
    ? readFileSync(file, "utf8").split("\n").filter(Boolean)
      .map(l => l.match(/window-style (bg=\S+)/)?.[1]).filter((s): s is string => !!s)
    : [];
}

/** The owner-facing display-message lines the fake tmux recorded, in order. */
export function notices(fx: Fx): string[] {
  const file = fx.env.FAKE_NOTICES!;
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
}

/** Enter presses and owner notices on one ordered tape, for effect-order assertions. */
export function effects(fx: Fx): string[] {
  const file = fx.env.FAKE_EFFECTS!;
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
}

/** Run a fresh fixture natively and hand back the view, route stripped after asserting it. */
export function one(opts: FixtureOpts, args: string[], json = true): View {
  const v = run(fixture(opts), args, json);
  expect(v.route).toBe(routeOf(args[0]!));
  return { ...v, route: "" };
}
