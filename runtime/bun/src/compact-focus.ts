// The compaction focus policy and resume-ping text, one owner for both `tap self
// compact` and peer `tap compact` (tap-thgv).
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_AGENT_FAMILIES, harnessFamily } from "./observe";
import { tmuxReadOnly } from "./tmux";

// A focus SUPPLEMENTS the default summarizer. Exclusive phrasing deprioritizes
// every thread the author did not mention, and drop directives corrupt the
// summary. The list is a backstop for the doctrine in skills/self/SKILL.md, not
// exhaustive coverage; known gaps are accepted.
const NARROWING = ["focus only", "only on", "solely", "exclusively", "nothing else",
  "ignore", "discard", "forget about", "drop everything",
  "don't keep", "do not keep", "leave out", "omit"];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The first narrowing phrase in `text`, or null when it is clean. Word-boundary
 * matched on the lowercased text, never plain substring: "only once" contains
 * "only on" and "gitignore" contains "ignore", and a false positive strands a
 * legitimate focus because callers are told never to route around the gate.
 */
export function focusNarrowing(text: string): string | null {
  // Per character, one code point out, as `tr '[:upper:]' '[:lower:]'` did: İ
  // (U+0130) becomes plain i, not i + combining dot.
  const lower = Array.from(text, ch => Array.from(ch.toLowerCase())[0]!).join("");
  // [:alnum:] is letters and DECIMAL digits; ¹, Ⅰ and ₁ are boundaries, as before.
  for (const phrase of NARROWING) {
    if (new RegExp(`(^|[^\\p{L}\\p{Nd}])${escape(phrase)}($|[^\\p{L}\\p{Nd}])`, "u").test(lower)) return phrase;
  }
  return null;
}

/** Where a /compact focus can ride: on the command line, after it, or nowhere. */
export function focusMode(harness: string): "inline" | "deferred" | "unsupported" {
  const family = harnessFamily(harness, DEFAULT_AGENT_FAMILIES);
  return family === "claude" ? "inline" : family === "codex" || family === "opencode" ? "deferred" : "unsupported";
}

/** A beads database resolves from `dir`: BEADS_DIR is set, or an ancestor holds `.beads/`. */
export function beadsReachable(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.BEADS_DIR) return true;
  for (let current = dir; current && current !== "/"; ) {
    try { if (statSync(`${current}/.beads`).isDirectory()) return true; } catch { /* keep walking */ }
    const parent = dirname(current);
    // A relative path bottoms out at "." rather than "/"; its parent is itself.
    if (parent === current) break;
    current = parent;
  }
  return false;
}

/** Read the entire brief before role guidance can trigger any initialization. */
export function authoredRecovery(path: string, seat: string, notify?: string): string {
  return `Read the whole brief at ${path}, including its charter, handoff, holds, Keep scope and live scheduler ids, before taking action. Then load its named role skills as guidance, without replaying their initialization: no fresh staffing, dispatch or re-arming. If essential priming is unavailable, stop and report the missing source. Run tap whoami and tap poll ${seat}; reconcile live state and still-owned obligations. Follow the brief's Next step, including any hold or wait for orders; outstanding obligations stay recorded. After reading, report the absolute brief path, restored role and next action ${notify ? `to ${notify} through TAP` : "in your own conversation for the operator; do not message a peer"}.`;
}

/**
 * The one-line resume prompt handed to a freshly compacted agent.
 *
 * Deixis-free by construction: it lands where "this" and "what you were doing"
 * resolve to nothing, so every reference is an absolute path or a runnable
 * command, and it points only at durable state rather than asking the agent to
 * recall. Every command it names must run for its reader, so `bd ready` appears
 * only when bd is installed and a beads database resolves from the TARGET pane's
 * cwd, and the poll clause only for a named seat. The focus clause is verbatim.
 */
export function handoffPing(path: string, seat = "", pane = "", focus = "", env: NodeJS.ProcessEnv = process.env, notify?: string): string {
  if (path) return `Post-compaction resume check. ${authoredRecovery(path, seat, notify)}${focus ? ` Focus preserved before compaction: ${focus}` : ""}`;
  const poll = seat ? ` Run 'tap poll ${seat}' and settle or answer anything unsettled.` : "";
  let cwd = "";
  if (pane) {
    // Optional: the ping is often built after /compact was already submitted, so
    // an unreachable or timed-out tmux falls back to our cwd rather than throwing.
    try {
      const read = tmuxReadOnly(["display-message", "-p", "-t", pane, "#{pane_current_path}"], env);
      if (read.code === 0) cwd = read.stdout.replace(/\n+$/, "");
    } catch { /* the cwd fallback below */ }
  }
  cwd ||= process.cwd();
  const beads = Bun.which("bd", { PATH: env.PATH ?? "" }) && beadsReachable(cwd, env) ? " and 'bd ready'" : "";
  // Peer compaction without a supplied brief retains its existing resume contract.
  const lead = "No handoff file was written before this compaction, so treat your summary as lossy rather than authoritative.";
  const focusClause = focus ? ` Focus written for you BEFORE this compaction, by the agent that still had the full context: ${focus}` : "";
  return `Post-compaction resume check. ${lead}${focusClause}${poll} Check your task list${beads} for work already claimed. If work is in progress or owed, continue it without waiting to be asked. If nothing is in progress, reply 'nothing in progress' and end the turn.`;
}
