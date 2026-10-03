// `tap_seat_state`, native: one seat's activity as the watcher, goalie, admin
// dashboard and launcher restart read it. The lib.sh body is gone; its eight
// private helpers (harness count, transcript freshness, the opencode/cursor
// prompt-ready scans, the alert/input-state/escaped-line adapters, sha256) are
// folded in here or reached through their existing Bun twins.
//
// Classification PRECEDENCE LADDER — load-bearing, do not reorder: a watcher
// must bias toward SUSPICION, so
//     ALERT STATES  >  BUSY-FOOTER GATES  >  LIVENESS EVIDENCE  >  WORKING SHORTCUTS  >  WEDGED HASH.
// A blocked/rate-limited seat is still blocked even with a warm transcript; a
// seat at an empty prompt is stopped even if it just wrote; and MISSING
// evidence is never "active". Putting a working shortcut ahead of an alert or a
// liveness signal is exactly the bias that made stopped/blocked seats vanish
// from the watcher's probe chain.
//
// The acting registry and bus home are the CALLER's resolved answer (each
// caller already selected them through index authority); this module never
// re-resolves them from ambient pins.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectAgentState } from "./agent-state";
import { paneHarness } from "./pane-harness";
import { escapedInputLine, inputRegion, inputStateFromRegion, paneAlertState, promptLineReText, regionIsSentinel, type PaneIo } from "./pane/reader";
import { composerInput } from "./submit-frame";
import { promptGlyph, promptRowReGrep, stripAnsi } from "./pane/geometry";
import { AWK_POSIX_SPACE, PYTHON_SPACE } from "./terminal-text";
import { ServerUnresponsive, isOpenCodeCommand, tmuxReadOnly } from "./tmux";
import { cmdSubst, isMap, loads, pyStr, pyTruthy, type JsonValue } from "./watch-detect";
import { readRegistryText, seatMapOf } from "./watch-tick";

export type SeatState =
  | "unknown" | "rate-limited-error" | "blocked-on-approval" | "booting"
  | "working" | "idle-at-prompt" | "wedged";

/** The tmux and harness reads the ladder makes; tests inject fakes. */
export interface SeatStateDeps {
  /** Pane captures for the input-geometry readers (joined/escaped per reader). */
  io: PaneIo;
  /** `tmux display-message -p -t <pane> <format>`; "" on any failure. */
  display(pane: string, format: string): string;
  /** The claude busy-footer observer (`agent-state.ts claude-seat-state`). */
  claudeActivity(frame: string): string;
  /** `tap_pane_harness_command` for a row with no recorded harness. */
  harnessOf(pane: string, paneCmd: string, env: NodeJS.ProcessEnv): string;
  /** A fresh transcript for the sole seat of its harness in this worktree. */
  transcriptFresh(harness: string, worktree: string, now: number, staleAfter: number, env: NodeJS.ProcessEnv): boolean;
}

export interface SeatStateOptions {
  /** The acting registry the caller resolved. */
  registry: string;
  /** The bus home; the wedge cache lives under `<home>/seat-state/`. */
  home: string;
  /** An already-authorized pane that replaces the row's pane. */
  pane?: string;
  env?: NodeJS.ProcessEnv;
  deps?: Partial<SeatStateDeps>;
}

function tmuxRead(args: string[], env: NodeJS.ProcessEnv): { code: number; stdout: string } {
  try {
    const r = tmuxReadOnly(args, env);
    return { code: r.code, stdout: r.stdout };
  } catch (error) {
    if (error instanceof ServerUnresponsive) return { code: 1, stdout: "" };
    throw error;
  }
}

export function realSeatStateDeps(env: NodeJS.ProcessEnv): SeatStateDeps {
  const display = (pane: string, format: string): string => {
    const r = tmuxRead(["display-message", "-p", "-t", pane, format], env);
    return r.code === 0 ? r.stdout : "";
  };
  return {
    io: {
      capture: (target, escaped, joined) =>
        tmuxRead(["capture-pane", ...(joined ? ["-J"] : []), "-p", ...(escaped ? ["-e"] : []), "-t", target], env),
      paneWidth: (target) => cmdSubst(display(target, "#{pane_width}")),
    },
    display,
    claudeActivity: (frame) => detectAgentState("claude", frame).agentState,
    harnessOf: (pane, paneCmd, harnessEnv) => {
      const pid = cmdSubst(display(pane, "#{pane_pid}"));
      return paneHarness({
        command: paneCmd,
        // A missing pid skips the process observation (the incumbent's `[ -n "$pane_pid" ]`).
        pane_pid: /^[0-9]+$/.test(pid) ? Number(pid) : 0,
      }, harnessEnv);
    },
    transcriptFresh,
  };
}

const AWK_S = `[${AWK_POSIX_SPACE}]`;
const OPENCODE_BORDER = new RegExp(`^${AWK_S}*╹▀`);
const OPENCODE_BOX = new RegExp(`^${AWK_S}*┃`);
const AWK_BLANK = new RegExp(`^${AWK_S}*$`);

/**
 * OpenCode's prompt box, over a plain capture: 0 when the box is present and
 * its status row carries no working indicator, 1 when an `esc interrupt`
 * marker is live below the box, 3 when the box is absent. The third state tells
 * startup chrome from a generating pane: both are not ready, but only the
 * latter is demonstrably working. The LAST border row wins.
 */
export function opencodePromptReady(frame: string): 0 | 1 | 3 {
  const lines = frame.split("\n");
  let border = -1;
  lines.forEach((line, i) => { if (OPENCODE_BORDER.test(line)) border = i; });
  if (border < 1 || !OPENCODE_BOX.test(lines[border - 1]!)) return 3;
  for (let i = border + 1; i < lines.length; i++) if (lines[i]!.includes("esc interrupt")) return 1;
  return 0;
}

/**
 * Cursor's busy footer is layout-position-independent (tap-mk4b): not ready
 * when "ctrl+c to stop" appears in the last twelve rows up to the last
 * non-blank one. A blank pane is ready.
 */
export function cursorPromptReady(frame: string): boolean {
  const lines = frame.split("\n");
  let last = lines.length - 1;
  while (last >= 0 && AWK_BLANK.test(lines[last]!)) last--;
  if (last < 0) return true;
  for (let i = Math.max(0, last - 11); i <= last; i++) if (lines[i]!.includes("ctrl+c to stop")) return false;
  return true;
}

function loadDoc(registry: string): JsonValue | undefined {
  const text = readRegistryText(registry);
  if (text === null) return undefined;
  try { return loads(text); } catch { return undefined; }
}

/**
 * Active seats of `harness` rooted at `worktree` (a row's
 * `registered_from_worktree`, else the team's `worktree_root`). Any unreadable
 * or malformed document counts zero, as the incumbent's failed heredoc did.
 */
export function activeHarnessCount(registry: string, harness: string, worktree: string): number {
  const doc = loadDoc(registry);
  if (!isMap(doc)) return 0;
  const team = doc.get("team");
  let count = 0;
  for (const ent of seatMapOf(readRegistryText(registry)).values()) {
    if (!isMap(ent)) continue;
    if ((ent.has("status") ? ent.get("status") : "active") !== "active") continue;
    if (ent.get("harness") !== harness) continue;
    const own = ent.get("registered_from_worktree");
    // `(reg.get("team") or {}).get(...)` runs only for a row with no root of its
    // own, and a truthy non-object team raised there, voiding the whole count.
    if (!pyTruthy(own) && pyTruthy(team) && !isMap(team)) return 0;
    const teamRoot = isMap(team) ? team.get("worktree_root") : undefined;
    const root = pyTruthy(own) ? own : pyTruthy(teamRoot) ? teamRoot : "";
    if (root === worktree) count++;
  }
  return count;
}

/** Non-hidden `*.jsonl` files at any depth below `dir` (Python `glob('**')`). */
function jsonlBelow(dir: string, out: string[]): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    let isDir = false;
    try { isDir = statSync(path).isDirectory(); } catch { continue; }
    if (isDir) jsonlBelow(path, out);
    else if (name.endsWith(".jsonl")) out.push(path);
  }
}

/**
 * A transcript of this harness that names `worktree` was written within
 * `staleAfter` seconds of `now`. Codex reads every session under its home;
 * Claude reads the project directories whose name carries the munged worktree.
 * Other harnesses have no transcript reader and are stale.
 */
export function transcriptFresh(harness: string, worktree: string, now: number, staleAfter: number, env: NodeJS.ProcessEnv): boolean {
  const home = env.HOME || homedir();
  const paths: string[] = [];
  if (harness === "codex") {
    jsonlBelow(join(env.TAP_CODEX_HOME || env.CODEX_HOME || join(home, ".codex"), "sessions"), paths);
  } else if (harness === "claude") {
    const projects = join(env.TAP_CLAUDE_HOME || env.CLAUDE_HOME || join(home, ".claude"), "projects");
    const munged = worktree.replace(/^\/+|\/+$/g, "").replaceAll("/", "-");
    let dirs: string[] = [];
    try { dirs = readdirSync(projects); } catch { /* no projects */ }
    for (const d of dirs) {
      if (d.startsWith(".") || !d.includes(munged)) continue;
      let files: string[] = [];
      try { files = readdirSync(join(projects, d)); } catch { continue; }
      for (const f of files) if (!f.startsWith(".") && f.endsWith(".jsonl")) paths.push(join(projects, d, f));
    }
  }
  for (const path of paths) {
    let text: string, mtime: number;
    try {
      text = new TextDecoder("utf-8").decode(readFileSync(path));
      mtime = Math.floor(statSync(path).mtimeMs / 1000);
    } catch { continue; }
    if (!text.includes(worktree)) continue;
    if (mtime && now - mtime <= staleAfter) return true;
  }
  return false;
}

const PY_WS_RUN = new RegExp(`[${PYTHON_SPACE}]+`);

/**
 * The size-invariant wedge fingerprint (tap-zcbw): words rejoined across soft
 * wraps so a viewer resize cannot change it, newline-terminated as Python's
 * `print` wrote it, sha256 hex.
 */
export function wedgeHash(frame: string): string {
  const normalized = frame.split(PY_WS_RUN).filter((w) => w !== "").join(" ");
  return createHash("sha256").update(normalized + "\n", "utf8").digest("hex");
}

const INT = /^\s*-?[0-9]+\s*$/;

/** One seat's state. Never throws for a seat it cannot observe: that is "unknown". */
export function seatState(handle: string, opts: SeatStateOptions): SeatState {
  const env = opts.env ?? process.env;
  const deps: SeatStateDeps = { ...realSeatStateDeps(env), ...opts.deps };
  const ent = seatMapOf(readRegistryText(opts.registry)).get(handle);
  if (!isMap(ent)) return "unknown";
  // The incumbent joined these four in one python print; a non-string value
  // raised there and every field read back empty, so the seat was unknown.
  const fields = ([["status", "active"], ["pane", ""], ["harness", ""], ["registered_from_worktree", ""]] as const)
    .map(([key, dflt]) => (ent.has(key) ? ent.get(key) : dflt));
  if (fields.some((v) => typeof v !== "string")) return "unknown";
  const [status, rowPane, rowHarness, rowWorktree] = fields as string[];
  const pane = opts.pane || rowPane!;
  if (status !== "active") return "unknown";
  let worktree = rowWorktree!;
  if (worktree === "") {
    const doc = loadDoc(opts.registry);
    const team = isMap(doc) ? doc.get("team") : undefined;
    if (isMap(team)) worktree = cmdSubst(pyStr(team.has("worktree_root") ? team.get("worktree_root") : ""));
  }
  if (cmdSubst(deps.display(pane, "#{pane_id}")) === "") return "unknown";
  let harness = rowHarness!;
  if (harness === "") harness = deps.harnessOf(pane, cmdSubst(deps.display(pane, "#{pane_current_command}")), env);
  const nowRaw = env.TAP_WATCH_NOW || String(Math.floor(Date.now() / 1000));
  const staleRaw = env.TAP_SEAT_STALE_AFTER || "300";

  // Every Codex profile captures escaped: the composer reader below tells the
  // idle placeholder from typed words by its dim paint (tap-8nmot).
  const capture = deps.io.capture(pane, harness === "codex" || harness.startsWith("codex-"), !isOpenCodeCommand(harness));
  const full = cmdSubst(stripAnsi(capture.code === 0 ? capture.stdout : ""));

  // (1) ALERT STATES — rate-limited / blocked-on-approval outrank every other signal.
  const alert = paneAlertState(stripAnsi(full + "\n"));
  if (alert !== "") return alert;
  // Each harness's own approval dialog, the matcher the roster and courier use
  // (tap-3oox6): the generic alert vocabulary above misses OpenCode, Cursor,
  // agy and Hermes prompts. Codex reads its escaped capture, as below.
  // OpenCode's shell composer is blocked too, but it is not an approval.
  const codex = harness === "codex" || harness.startsWith("codex-");
  const family = codex ? "codex" : harness.startsWith("claude") ? "claude" : harness;
  const held = detectAgentState(family, codex && capture.code === 0 ? capture.stdout : full);
  if (held.agentState === "blocked" && held.reason !== "shell_mode") return "blocked-on-approval";

  // (2) BUSY-FOOTER GATES — a generating seat that still shows an input band must
  // not fall through to idle-at-prompt. opencode and cursor keep (empty) bands
  // mid-turn; their busy markers are the readiness signal. An active opencode
  // pane with no band at all is still starting, not generating.
  if (harness === "opencode") {
    const ready = opencodePromptReady(full);
    if (ready === 3) return "booting";
    if (ready !== 0) return "working";
  } else if (harness === "cursor") {
    if (!cursorPromptReady(full)) return "working";
  } else if (harness === "codex" || harness.startsWith("codex-")) {
    // Every Codex profile takes this gate: its escaped capture lets the
    // composer below read a painted placeholder as empty, so a generating
    // frame must be caught here first (tap-8nmot).
    // Keep the placeholder's paint so the shared observer can bound the live
    // busy footer without mistaking a typed hint or old scrollback for chrome.
    const activity = detectAgentState("codex", capture.code === 0 ? capture.stdout : "").agentState;
    if (activity === "working") return "working";
    if (activity === "idle") return "idle-at-prompt";
    if (activity === "blocked") return "blocked-on-approval";
  } else if (harness === "claude") {
    let activity: string;
    try { activity = cmdSubst(deps.claudeActivity(full)); } catch { return "unknown"; }
    if (activity === "working") return "working";
    if (activity === "idle") return "idle-at-prompt";
    if (activity === "blocked") return "blocked-on-approval";
    // No recognized band preserves the fallback observation; anything else is broken.
    if (activity !== "unknown") return "unknown";
  } else if (harness.startsWith("hermes")) {
    // The working "⚕ ❯" composer is a readable prompt row (tap-rhajr), so a
    // generating seat must be caught here before (3) reads its empty band as
    // stopped. Idle and unknown fall through to the liveness evidence as before.
    if (detectAgentState("hermes", full).agentState === "working") return "working";
  }

  // (3) LIVENESS EVIDENCE — an empty input region at a prompt is a STOPPED seat.
  // Each reader failing reads as empty output, independently, as each adapter did.
  let region = "", escaped = "", inputState = "";
  try {
    const r = inputRegion(deps.io, pane, harness);
    if (r.status !== "no-band") region = cmdSubst(r.region);
  } catch { /* no region */ }
  try { escaped = cmdSubst(escapedInputLine(deps.io, pane, harness)); } catch { /* no escaped row */ }
  try {
    // tap-8nmot: classify Codex through the ONE composer reader — the generic
    // glyph region swallows the footer and paint rows below a staged wire, and
    // a region trimmed to empty by them would falsely clear the stopped-seat
    // check. An unreadable composer falls back to the generic path, which
    // fails closed exactly as before. The composer reads the ESCAPED capture:
    // the idle placeholder is recognized by its dim SGR, which `full` has lost.
    if (harness === "codex" || harness.startsWith("codex-")) {
      const composer = composerInput(capture.code === 0 ? capture.stdout : "", harness);
      if (composer.state === "text") {
        inputState = composer.text.trim() === "" ? "empty"
          : regionIsSentinel(composer.text, promptLineReText(harness)) ? "unsubmitted-sentinel" : "other-text";
      }
    }
    if (inputState === "") {
      inputState = inputStateFromRegion(region, escaped, promptGlyph(harness), promptLineReText(harness), harness);
    }
  } catch { /* no verdict */ }
  if (inputState === "empty") {
    if (harness === "opencode") {
      // No prompt glyph on opencode: the input box on screen with no working marker.
      if (opencodePromptReady(full) === 0) return "idle-at-prompt";
    } else {
      const promptRow = promptRowReGrep(harness);
      if (full.split("\n").some((line) => promptRow.test(line))) return "idle-at-prompt";
    }
  }

  // (4) WORKING SHORTCUTS (lowest) — a fresh transcript (sole seat of its harness)
  // or a recent window_activity means actively working. Missing/invalid
  // window_activity is STALE (0), NEVER "now": absent evidence must not read as active.
  const now = INT.test(nowRaw) ? Number(nowRaw) : NaN;
  const staleAfter = INT.test(staleRaw) ? Number(staleRaw) : NaN;
  const clockOk = Number.isFinite(now) && Number.isFinite(staleAfter);
  if (clockOk && worktree !== "" && activeHarnessCount(opts.registry, harness, worktree) === 1
    && deps.transcriptFresh(harness, worktree, now, staleAfter, env)) return "working";
  const activityRaw = cmdSubst(deps.display(pane, "#{window_activity}"));
  const windowActivity = /^[0-9]+$/.test(activityRaw) ? Number(activityRaw) : 0;
  if (clockOk && windowActivity > 0 && now - windowActivity <= staleAfter) return "working";

  // (5) WEDGED — the same normalized frame as the last observation.
  const hash = wedgeHash(full);
  const cacheDir = join(opts.home, "seat-state");
  const cacheFile = join(cacheDir, `${handle}.hash`);
  let prev = "";
  try { prev = cmdSubst(readFileSync(cacheFile, "utf8")); } catch { /* no prior observation */ }
  if (env.TAP_SEAT_STATE_READONLY !== "1") {
    try { mkdirSync(cacheDir, { recursive: true }); writeFileSync(cacheFile, hash); } catch { /* best-effort cache */ }
  }
  return prev !== "" && prev === hash ? "wedged" : "unknown";
}

// `bun seat-state.ts <handle>`: the launcher's read (restart's busy check).
// The acting registry and bus resolve from the cwd exactly as every verb's do;
// an unresolvable context is a seat nobody can observe.
if (import.meta.main) {
  const { resolveContext } = await import("./context");
  let state: SeatState = "unknown";
  try {
    const ctx = resolveContext(process.cwd(), process.env, { readOnly: true });
    state = seatState(process.argv[2] ?? "", { registry: ctx.registryPath, home: ctx.bus.home });
  } catch { /* unknown */ }
  process.stdout.write(state);
}
