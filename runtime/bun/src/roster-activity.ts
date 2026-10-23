// Roster-only activity enrichment (tap-i5fzq): what `tap team` and `tap health`
// add on top of the shared classifier's native answer. Nothing here feeds
// delivery, submit, compact or readiness decisions: those keep reading
// `detectAgentState` directly.
//
// Two readings, each on POSITIVE evidence only (the Claude spinner's
// `working` is the shared classifier's own answer since tap-7txco):
//   - an ended turn that still owns live background work (shells, Codex
//     background terminals, a compute job it requested) is `waiting`, not idle;
//   - a running turn's own elapsed clock dates it.
// Idle and waiting rows are dated by TURN END, not by entry into the current
// state, and only by a dated turn-end record (the readiness-stall transcript
// instrument). A footer's bare `done 5:59 AM` is not one: it carries no date,
// and a later transcript write can follow yesterday's painted line.
// Missing or ambiguous evidence leaves the native answer and no date: never a guess.

import { bracketedRegion, CLAUDE_SPINNER, claudeStatusRow, type AgentState, type AgentStateResult } from "./agent-state";

export type WaitingOn = { kind: "shell" | "terminal"; count: number } | { kind: "compute"; id: string };

export type RosterAgentState = AgentState | "waiting";

export interface RosterActivity {
  result: { agentState: RosterAgentState; reason: string };
  waitingOn: WaitingOn[];
  /** Working rows: epoch seconds the running turn began, from its elapsed clock. */
  turnStartedAt: number | null;
  /** Idle and waiting rows: epoch seconds the last turn ended, from a dated record. */
  turnEndedAt: number | null;
  turnEndedSource: "transcript" | null;
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const CLAUDE_PROMPT = /^\s*❯(?:\s| |$)/u;
const DURATION_PART = /(\d+)\s*([dhms])/g;
const UNIT: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 };

/** `8m 57s`, `1h 2m`, `42s` → seconds; null when nothing parses. */
export function parseElapsed(text: string): number | null {
  let total = 0, seen = false;
  for (const [, n, unit] of text.matchAll(DURATION_PART)) { total += Number(n) * UNIT[unit!]!; seen = true; }
  return seen ? total : null;
}

// The live footer's background-shell count: `· 1 shell ·`, `· 4 shells`.
const CLAUDE_SHELLS = /(?:^|·)\s*(\d+)\s+shells?\s*(?:·|$)/u;

interface ClaudeReading { spinnerElapsed: number | null; shells: number }

/** The Claude band's neighbours: the status row above it and the live footer below it. */
export function readClaude(screen: string): ClaudeReading | null {
  const band = bracketedRegion(screen.replace(ANSI, ""), CLAUDE_PROMPT);
  if (!band) return null;
  const spinner = claudeStatusRow(screen)?.match(CLAUDE_SPINNER);
  let shells = 0;
  for (const row of band.footer.split("\n")) {
    const m = row.match(CLAUDE_SHELLS);
    if (m) { shells = Number(m[1]); break; }
  }
  return { spinnerElapsed: spinner ? parseElapsed(spinner[1]!) : null, shells };
}

// Codex: `• Working (4m 42s • esc to interrupt)` while a turn runs; once it
// ends, `Worked for 2m 47s • 6:00 AM` and, while a unified-exec terminal still
// runs, `1 background terminal running · /ps to view · /stop to close`. The
// count is live chrome only BELOW the latest `Worked for` row: the same words
// above it are transcript (a reply quoting them, an older turn's status).
const CODEX_WORKING = /^\s*[•*]\s*Working\s*\((\d+[dhms](?:\s*\d+[dhms])*)\s*•/u;
// The whole observed end row (`Worked for 2m 47s • 6:00 AM`), never a prefix of prose.
const CODEX_WORKED = /^\s*Worked for\s+\d+[dhms](?:\s*\d+[dhms])*\s*•\s*\d{1,2}:\d{2}\s*(?:AM|PM)?\s*$/iu;
const CODEX_TERMINALS = /^\s*(\d+)\s+background terminals?\s+running\s*·\s*\/ps to view(?:\s*·\s*\/stop to close)?\s*$/u;
const CODEX_COMPOSER = /^\s*[›❯»]/u;

interface CodexReading { workingElapsed: number | null; terminals: number }

/** The status rows between the last transcript item and the live composer. */
export function readCodex(screen: string): CodexReading | null {
  const rows = screen.replace(ANSI, "").split("\n");
  const composer = rows.findLastIndex(row => CODEX_COMPOSER.test(row));
  if (composer < 0) return null;
  const near = rows.slice(Math.max(0, composer - 6), composer).filter(row => row.trim());
  let workingElapsed: number | null = null;
  for (const row of near) {
    const working = row.match(CODEX_WORKING);
    if (working) workingElapsed = parseElapsed(working[1]!);
  }
  const worked = near.findLastIndex(row => CODEX_WORKED.test(row));
  let terminals = 0;
  if (worked >= 0) {
    for (const row of near.slice(worked + 1)) {
      const live = row.match(CODEX_TERMINALS);
      if (live) terminals = Number(live[1]);
    }
  }
  return { workingElapsed, terminals };
}

/** One compute queue job, as `compute --json queue` reports it. */
export interface ComputeJob {
  id?: unknown; status?: unknown; notify_done?: unknown; identity?: unknown; released_at?: unknown;
}

const COMPUTE_LIVE = new Set(["queued", "offered", "running"]);

/**
 * Live compute jobs that will WAKE this seat: submitted with `--notify done`
 * aimed at `<team>/<handle>`, from this seat's current pane. Requester alone
 * is attribution, not a wake; a job from a replaced instance (another pane)
 * or a released job wakes nobody here.
 */
export function computeFor(jobs: ComputeJob[], team: string, handle: string, paneId: string): string[] {
  if (!team || !handle || !paneId) return [];
  const target = `${team}/${handle}`;
  return jobs.filter((job) => {
    if (job.notify_done !== target || typeof job.id !== "string") return false;
    if (typeof job.status !== "string" || !COMPUTE_LIVE.has(job.status) || job.released_at != null) return false;
    let identity: unknown;
    try { identity = typeof job.identity === "string" ? JSON.parse(job.identity) : null; } catch { return false; }
    return typeof identity === "object" && identity !== null && (identity as { pane_id?: unknown }).pane_id === paneId;
  }).map(job => job.id as string);
}

/**
 * Enrich one native classification. Only `idle` may become `waiting`.
 * Working, blocked, error, booting, overprint and unknown keep their native answer.
 */
export function rosterActivity(harness: string, screen: string, native: AgentStateResult, compute: string[], now: number,
  turnEndedAt: number | null = null): RosterActivity {
  const claude = /^claude(?:-|$)/.test(harness) ? readClaude(screen) : null;
  const codex = /^codex(?:-|$)/.test(harness) ? readCodex(screen) : null;
  let result: RosterActivity["result"] = native;
  const waitingOn: WaitingOn[] = [];
  const none = { turnStartedAt: null, turnEndedAt: null, turnEndedSource: null };

  if (native.agentState === "working") {
    const elapsed = claude?.spinnerElapsed ?? codex?.workingElapsed ?? null;
    return { result, waitingOn, ...none, turnStartedAt: elapsed === null ? null : now - elapsed };
  }
  if (native.agentState !== "idle") return { result, waitingOn, ...none };

  if (claude && claude.shells > 0) waitingOn.push({ kind: "shell", count: claude.shells });
  if (codex && codex.terminals > 0) waitingOn.push({ kind: "terminal", count: codex.terminals });
  for (const id of compute) waitingOn.push({ kind: "compute", id });
  if (waitingOn.length > 0) {
    const first = waitingOn[0]!;
    const reason = first.kind === "shell" ? "background_shells" : first.kind === "terminal" ? "background_terminals" : "compute";
    result = { agentState: "waiting", reason };
  }
  return { result, waitingOn, turnStartedAt: null, turnEndedAt, turnEndedSource: turnEndedAt === null ? null : "transcript" };
}

/** `45s`, `12m`, `3h05m`, `2d` — the roster's compact age. */
export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(s / 86400)}d`;
}
