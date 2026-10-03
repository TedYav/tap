// The production attach policy (launcher.py tmux_attach lineage, tap-fuz9 /
// tap-v0bg / tap-ya2e): refuse from inside tmux, refuse when the caller's tmux
// state or foreground ownership is unverified, else attach-session from the
// caller's own terminal. It DECIDES only. The caller measures its own terminal
// facts and spawns tmux itself, so no Bun process ever holds the caller's tty
// across an attach (a Bun child restores its startup termios at exit; see
// docs/solutions/integration-issues/a-bun-node-child-on-a-tuis-tty-restores-cooked-mode-at-exit.md).
import { launchCommand } from "./process";

// Typed refusals, outside attach-session's own 0/1 (tap-rxqb, Lane D D2).
export const ATTACH_REFUSED_IN_TMUX = 2;
export const ATTACH_REFUSED_AMBIGUOUS = 3;
export const ATTACH_REFUSED_TTY_OWNERSHIP = 4;

/** What only the caller process can observe about its own terminal. */
export interface CallerFacts {
  tmux: string;            // $TMUX as inherited
  tmux_pane: string;       // $TMUX_PANE as inherited
  caller_tty: string;      // ttyname of stderr, else stdout; "" when neither
  owns_foreground: boolean; // this process group owns stdin and stdout
  has_tty: boolean;        // stdin and stdout are both terminals
}

type InTmux = "no" | "yes" | "ambiguous";

/** Is the server that minted $TMUX POSITIVELY gone? Ambiguity never unlocks attach. */
export function tmuxServerIsGone(raw: string): boolean {
  const parts = raw.split(",");
  const pid = parts[1]?.trim() ?? "";
  if (parts.length < 2 || !/^[0-9]+$/.test(pid)) return false;
  try { process.kill(Number(pid), 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  return false;
}

/** Tty and process state from one pane query; null means unobservable. */
export type PaneTty = { tty: string; dead: boolean };
export async function tmuxPaneTty(target: string, signal?: AbortSignal): Promise<PaneTty | null> {
  let result;
  try { result = await launchCommand(["tmux", "display-message", "-p", "-t", target, "#{pane_tty}\t#{pane_dead}"], { env: process.env, signal }); }
  catch (error) {
    // A custody failure (the probe's group outlived termination) outranks the
    // interrupt that caused it: it propagates, never masked as a clean cancel.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    signal?.throwIfAborted();
    return null;
  }
  // An interrupted probe returns its killed result; the interrupt is the answer.
  signal?.throwIfAborted();
  if (result.code !== 0) return null;
  const lines = result.stdout.split(/\r\n|\r|\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 1) return null;
  const fields = lines[0]!.split("\t");
  if (fields.length !== 2 || (fields[1] !== "0" && fields[1] !== "1")) return null;
  const tty = fields[0]!.trim();
  if (!tty && fields[1] === "0") return null;
  return { tty, dead: fields[1] === "1" };
}

/** Tty IDENTITY, not variable presence, decides whether the caller is in a pane. */
export async function callerInTmux(facts: CallerFacts, signal?: AbortSignal): Promise<InTmux> {
  if (!facts.tmux) return "no";
  if (tmuxServerIsGone(facts.tmux)) return "no";
  if (!facts.caller_tty) return "ambiguous";
  if (!facts.tmux_pane) return "ambiguous";
  const paneTty = await tmuxPaneTty(facts.tmux_pane, signal);
  if (paneTty === null) return "ambiguous";
  if (paneTty.dead) return "no";
  return paneTty.tty === facts.caller_tty ? "yes" : "no";
}

export type AttachPlan =
  | { refused: number }
  | { argv: string[]; unset_env: string[] };

/** tmux_attach's decision: a typed refusal, or the attach-session the caller runs. */
export async function attachPlan(name: string, facts: CallerFacts, signal?: AbortSignal): Promise<AttachPlan> {
  const target = `=${name}`;
  const state = await callerInTmux(facts, signal);
  if (state === "yes") return { refused: ATTACH_REFUSED_IN_TMUX };
  if (state === "ambiguous") return { refused: ATTACH_REFUSED_AMBIGUOUS };
  if (!facts.owns_foreground) return { refused: ATTACH_REFUSED_TTY_OWNERSHIP };
  if (!facts.tmux) return { argv: ["tmux", "attach-session", "-t", target], unset_env: [] };
  // Positively inherited $TMUX: tmux's own nesting guard trusts it too, so the
  // strip is load-bearing, and only after observing our tty is not the pane's.
  const socket = facts.tmux.split(",")[0]!;
  if (!socket) return { refused: ATTACH_REFUSED_AMBIGUOUS };
  return { argv: ["tmux", "-S", socket, "attach-session", "-t", target], unset_env: ["TMUX", "TMUX_PANE"] };
}

export type Narration = { receipt: string | null; warning: { problem: string; next: string } | null };

/** attach_after_launch: one message per outcome, told apart by the typed rc. */
export function attachNarration(name: string, rc: number, target = name): Narration {
  if (rc === 0) return { receipt: null, warning: null };
  if (rc === ATTACH_REFUSED_TTY_OWNERSHIP) return { receipt: "caller does not own foreground tty", warning: null };
  if (rc === ATTACH_REFUSED_IN_TMUX) return { receipt: "in-tmux caller", warning: null };
  if (rc === ATTACH_REFUSED_AMBIGUOUS) return { receipt: "tmux caller state unverified", warning: null };
  return {
    receipt: "attach failed",
    warning: { problem: `could not attach to ${name} (tmux exit ${rc}); the session is running and registered`, next: `tap attach ${target}` },
  };
}

/** The receipt text every detached outcome prints. */
export const detachedReceipt = (name: string, reason: string, target = name): string =>
  `${name} is running detached (${reason}); next: ${reason === "in-tmux caller"
    ? `from your terminal, run tap attach ${target} (or detach with Ctrl-b d first)`
    : `from a foreground terminal, run tap attach ${target}`}`;

/**
 * The tail's decision before any attach: resume_attach_tail detaches a
 * TTY-less caller up front; the launch tail (attach_after_launch) was already
 * gated by the caller's resolve_attach_mode and always plans.
 */
export async function attachTail(tail: "resume" | "launch", name: string, facts: CallerFacts, signal?: AbortSignal):
  Promise<{ detached: string } | AttachPlan> {
  if (tail === "resume" && !facts.has_tty) return { detached: "no controlling terminal" };
  return attachPlan(name, facts, signal);
}
