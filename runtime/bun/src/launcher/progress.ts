// progress.ts — the phase lines `tap session launch` shows while it works.
//
// A launch spends seconds in waits the operator cannot see: tmux setup, the
// registration transaction, and the harness booting until its SessionStart
// bind lands. Each phase gets one stderr line that names what it waits on.
//
//   animate  stderr is a TTY (not TERM=dumb): a spinner frame, settling to ✓/✗
//   off      redirected stderr, TERM=dumb, --json / TAP_JSON=1, a dry run, or
//            no launch door activated progress: the output bytes are unchanged
//
// The spinner itself lives in ../progress (shared with `tap team refresh`);
// this file keeps the launch door's phase tracking and failure tagging. Like
// the shared reporter it is process-wide and only the single-seat launch door
// activates it, so concurrent launches (team up) never interleave frames.

import { PhaseProgress, progressMode, type ProgressMode } from "../progress";

export { progressMode, type ProgressMode };

let active: PhaseProgress | null = null;
/** The launch door is running, in any mode: phases are tracked for failures. */
let tracking = false;
/** The effect-bearing (transaction) phase a failure would stop in; "" otherwise. */
let effectPhase = "";

/**
 * Run one launch with phase tracking, and with phase lines when `mode` animates.
 * A throw from an effect-bearing phase is tagged `launchPhase` so the rendered
 * error names it in every mode, and its line settles ✗; config-time refusals
 * (no effects yet) keep their bytes. Success settles the last line ✓, and every
 * effect-bearing phase keeps its ✓ however quickly it finished, so the list of
 * steps does not depend on how fast the harness booted.
 */
export async function withLaunchProgress(mode: ProgressMode, work: () => Promise<number>): Promise<number> {
  if (tracking) return work();
  tracking = true;
  effectPhase = "";
  const progress = mode === "animate" ? new PhaseProgress() : null;
  active = progress;
  let ok = false;
  try {
    const code = await work();
    ok = code === 0;
    return code;
  } catch (error) {
    if (effectPhase && error instanceof Error) Object.assign(error, { launchPhase: effectPhase });
    throw error;
  } finally {
    // A config-time refusal or a quit chooser has no effects to report: its
    // own message speaks, and the line is simply erased.
    progress?.stop(ok ? "✓" : effectPhase ? "✗" : null);
    active = null;
    tracking = false;
    effectPhase = "";
  }
}

/** Begin a named phase; `effect` marks the transaction's effect-bearing phases. No-op outside the launch door. */
export function launchPhase(label: string, effect = false): void {
  if (!tracking) return;
  effectPhase = effect ? label : "";
  active?.phase(label, effect);
}

/** Settle the current phase ✓ before handing the terminal over (receipts, attach). */
export function launchPhasesDone(): void {
  active?.stop("✓");
  active = null;
  effectPhase = "";
}

/**
 * Hand the terminal to another door (the resume delegations): erase the line
 * with no mark and stop tracking, so that door's output, failures and attach
 * behave exactly as when invoked directly.
 */
export function handOffLaunchProgress(): void {
  active?.stop(null);
  active = null;
  tracking = false;
  effectPhase = "";
}

/**
 * An interactive prompt owns the terminal row while it waits: erase the spinner and
 * stop its timer, and return the call that animates it again. Every prompt helper
 * takes this itself, so a caller cannot forget (tap-tl6rh). A no-op outside an
 * animated launch.
 */
export function suspendLaunchProgress(): () => void {
  const progress = active;
  progress?.pause();
  return () => progress?.resume();
}

/**
 * An interrupt a prompt is about to re-raise: erase the spinner line and drop its signal
 * handlers first. With a handler installed, the kernel's SIGINT reaches the event loop
 * later, so the prompt's own read error would surface and exit 1 before it; with none, the
 * re-raise takes the default disposition at once. A no-op outside an animated launch.
 */
export function releaseLaunchProgressForSignal(): void {
  active?.stop(null);
  active = null;
}

/** The launch door owns this launch's progress and failure reporting, in any mode. */
export function launchTracked(): boolean {
  return tracking;
}

export function launchProgressActive(): boolean {
  return active !== null;
}
