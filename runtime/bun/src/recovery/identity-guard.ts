import { submitIdentityGuard, type IdentityGuardResult, type IdentityOutcome } from "../pane-identity";
import type { RecoveryTarget } from "./state";

/**
 * Recovery's point-of-effect identity check, in process. This file used to
 * spawn `bash -c '. lib.sh; tap_submit_identity_guard "$@"'`; the evidence
 * shape follows the guard now: its own `state` token replaces the
 * subprocess's status, signal and errno, and the old `timeout` outcome is
 * `unobservable`: `guard_deadline` for the whole budget, or the observation's
 * own `_unobservable` token for one hung tmux call.
 */
export interface IdentityGuardEvidence {
  outcome: IdentityOutcome;
  state: string;
  durationMs: number;
  stderr: string;
  stderrTruncated: boolean;
}

/** Injected in tests. */
export type Guard = (registry: string, handle: string, pane: string, paneId: string, budgetMs: number) => IdentityGuardResult;

/** The bound the deleted subprocess carried; recovery holds its pane mutex across this call. */
export const GUARD_DEADLINE_MS = 10_000;

export function checkIdentityGuard(
  target: RecoveryTarget, record?: (e: IdentityGuardEvidence) => void,
  guard: Guard = (registry, handle, pane, paneId, budgetMs) =>
    submitIdentityGuard(registry, handle, pane, paneId, "", "", { budgetMs }),
): string | null {
  const started = performance.now();
  let result: Pick<IdentityGuardResult, "outcome" | "state" | "message">;
  try {
    result = guard(target.registry, target.handle, target.pane, target.paneId, GUARD_DEADLINE_MS);
  } catch (error) {
    // The guard maps every instrument failure to a refusal itself; a throw is
    // this code broken, which an operator files rather than investigates.
    result = { outcome: "fault", state: "guard_fault", message: error instanceof Error ? error.message : String(error) };
  }
  const cleaned = (result.message ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  const evidence: IdentityGuardEvidence = {
    outcome: result.outcome, state: result.state,
    durationMs: Math.round(performance.now() - started),
    stderr: cleaned.slice(0, 1024), stderrTruncated: cleaned.length > 1024,
  };
  record?.(evidence);
  if (evidence.outcome === "authorized") return null;
  return `identity guard ${evidence.outcome}: state=${evidence.state} duration_ms=${evidence.durationMs}`
    + (evidence.stderr ? `; ${evidence.stderr.trim()}` : "");
}
