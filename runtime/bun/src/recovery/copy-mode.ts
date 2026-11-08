import { tmuxReadOnly } from "../tmux";
import { readRun } from "./state";
import { escalateRecovery, recoveryEffect, REAL_RECOVERY_IO } from "./effect";

/** Recorded nudge uses the same effect recorder as detective; ordinary courier retains its existing helper. */
export function recordedCopyCancel(id: string, selection?: { gate(): string; record(sent: boolean): void }): number {
  const run = readRun(id);
  const mode = () => {
    const r = tmuxReadOnly(["display-message", "-p", "-t", run.target.paneId, "#{pane_in_mode}"]);
    return r.code === 0 ? r.stdout.trim() : "";
  };
  const before = mode();
  if (!before) return 3;
  if (before === "0") return 0;
  const result = recoveryEffect(id, "copy-mode cancel", `${run.mode}: authorized staged-sentinel recovery requires ordinary input`,
    ["send-keys", "-t", run.target.paneId, "-X", "cancel"], REAL_RECOVERY_IO, process.env, undefined, selection?.gate);
  selection?.record(result.event.effect === "possible");
  if (result.event.incident) {
    try { escalateRecovery(id, result.event.summary); } catch (error) { console.error(`tap recovery incident notification: ${error}`); }
  }
  if (result.code !== 0) return result.code;
  const after = mode();
  return after === "0" ? 0 : after ? 4 : 3;
}
if (import.meta.main) {
  try { process.exitCode = recordedCopyCancel(process.argv[2] || ""); }
  catch (error) { console.error(`tap recovery copy-mode: ${error}`); process.exitCode = 1; }
}
