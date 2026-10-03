import { agyComposer, agyPermissionOverlay, agySurveyOverlay } from "./submit-frame";
import { recoveryPolicy, type RecoveryMode } from "./recovery-policy";
import { capturePane, tmux, type Run } from "./tmux";

export interface SurveyEffects {
  surveyFrame?: (target: string) => Run;
  /** Publish conservative delivery evidence at the final pre-Skip boundary. */
  admitAttempt?: () => boolean;
  skipSurvey?: (target: string) => boolean | "rate_limited";
  surveyMode?: () => RecoveryMode;
  settle(seconds: number): void;
}
export const SURVEY_EFFECTS = {
  surveyFrame: capturePane,
  skipSurvey(target: string): boolean | "rate_limited" {
    const result = tmux(["send-keys", "-t", target, "-l", "0"]);
    return result.rateLimited ? "rate_limited" : result.code === 0;
  },
  surveyMode: () => recoveryPolicy("cautious").mode,
};
export type SurveyRecovery =
  | { status: "not-survey" | "restored" }
  | { status: "blocked"; detail: string }
  | { status: "attempt_evidence_unwritable"; detail: string };

/** Caller holds the submit lock; authorize rechecks the complete bound target
 * and reset/clear/recovery boundaries immediately before the only key effect.
 * A Skip is never an Enter and never evidence that a sentinel was submitted.
 */
export function recoverAgySurvey(
  target: string, harness: string, fx: SurveyEffects,
  authorize: () => string | null,
): SurveyRecovery {
  if (harness !== "agy" || !fx.surveyFrame) return { status: "not-survey" };
  const before = fx.surveyFrame(target);
  if (before.code !== 0 || before.rateLimited || !agySurveyOverlay(before.stdout)) return { status: "not-survey" };
  const blocked = (detail: string): SurveyRecovery => ({ status: "blocked", detail: `Antigravity survey: ${detail}` });
  let mode: RecoveryMode;
  try { mode = (fx.surveyMode ?? SURVEY_EFFECTS.surveyMode)(); }
  catch { return blocked("recovery policy unavailable; no keys sent"); }
  if (mode === "report-only") return blocked("report-only; no keys sent");
  const denied = authorize();
  if (denied) return blocked(denied);
  // Reobserve after the authority check: a dismissed survey may already be a
  // human draft. Never type 0 based on the earlier frame alone.
  const current = fx.surveyFrame(target);
  if (current.code !== 0 || current.rateLimited || !agySurveyOverlay(current.stdout)) return blocked("frame changed before Skip; no keys sent");
  if (fx.admitAttempt && !fx.admitAttempt()) {
    return { status: "attempt_evidence_unwritable", detail: "Antigravity survey: attempt evidence unavailable; no keys sent" };
  }
  if (!fx.skipSurvey || fx.skipSurvey(target) !== true) return blocked("Skip outcome unverified; no sentinel attempted");
  fx.settle(0.15);
  const afterDenial = authorize();
  if (afterDenial) return blocked(afterDenial);
  const after = fx.surveyFrame(target);
  if (after.code !== 0 || after.rateLimited || agySurveyOverlay(after.stdout) || agyPermissionOverlay(after.stdout) || agyComposer(after.stdout) === null) {
    return blocked("Skip sent once but composer did not return; no sentinel attempted");
  }
  if (agyComposer(after.stdout)!.trim()) return blocked("composer returned with pending input; no sentinel attempted");
  return { status: "restored" };
}

/** Read-only admission to recovery; never call a report-only survey ready. */
export function surveyAdmission(frame: string): "not-survey" | "recoverable" | "blocked" {
  if (!agySurveyOverlay(frame)) return "not-survey";
  try { return SURVEY_EFFECTS.surveyMode() === "report-only" ? "blocked" : "recoverable"; }
  catch { return "blocked"; }
}
