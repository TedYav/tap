// The WAIT snooze cue: BLUE once when the WAIT latches, GREEN 30s and RED 10s
// before the snooze deadline. The milestone is claimed (persisted) in the
// pane-shared input-protection record first — whichever observer (send path,
// waiter draft probe, drain) sees it due first flashes exactly once, through
// flashPaneLocked only. This module is the leaf that joins the record layer to
// the flash engine; neither dependency imports it back.
import { claimWaitCue, type WaitCue } from "./input-protection";
import { beginPaneCue, endPaneCueAfter, type FlashInput } from "./spool-park-report";

/**
 * Claim the pane's due WAIT cue and flash it best-effort. Callers hold the pane
 * submit lock (flashPaneLocked's contract); the milestone stays claimed even if
 * the cosmetic flash fails. `flash` overrides the engine for tests.
 */
export function emitWaitCue(paneId: string, o: {
  pane: string; home: string; ownerId: string; env?: NodeJS.ProcessEnv; now?: number;
  flash?: (input: FlashInput) => void;
}): WaitCue | null {
  const env = o.env ?? process.env;
  const claimed = claimWaitCue(paneId, env, o.now);
  if (!claimed) return null;
  try {
    const input = { home: o.home, pane: o.pane, paneId, ownerId: o.ownerId, style: `bg=${claimed}`, env };
    // Tint under the caller's lock; the dwell and clear come after it is released.
    if (o.flash) o.flash(input); else endPaneCueAfter(beginPaneCue(input));
  } catch { /* the cue is best effort; the milestone is already persisted */ }
  return claimed;
}
