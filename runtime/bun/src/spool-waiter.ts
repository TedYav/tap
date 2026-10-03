// Stamp before loading the loop, as watch-run does. Refresh preserves PID, lease and cadence.
import { join } from "node:path";
import { makeRefresh, reexecImage } from "./watch-run";

// Checked against the import closure by spool-waiter.test.ts.
export const WAITER_SOURCES: readonly string[] = [
  "agent-state.ts", "agy-survey.ts", "bus-archive-index.ts", "bus-maintenance-trigger.ts", "bus.ts", "bushome.ts", "clear-fence.ts",
  "config-error.ts", "config-file.ts", "context.ts", "courier-argv.ts", "courier-contract.ts", "courier.ts",
  "debug-capture.ts", "deliver.ts", "delivery-attempt.ts", "delivery-clock.ts", "delivery-custody.ts",
  "delivery-permissions.ts", "digest-index.ts", "digest-items.ts", "digest-window.ts", "envelope.ts",
  "events.ts", "existing-sentinel.ts", "forwarding.ts", "fsatomic.ts", "git-root.ts", "harness-families.ts",
  "harness-queue.ts", "ids.ts", "index-home.ts", "index-snapshot.ts", "injection-behavior.ts", "input-backup.ts", "input-protection.ts", "invocation-memo.ts",
  "lock-attribution.ts", "lossless-json.ts", "native-error.ts", "notice-submit.ts", "notice.ts",
  "observe-gather.ts", "observe.ts", "opencode-composer.ts", "opencode-store.ts", "overprint-marker.ts", "pane-harness.ts", "pane-identity.ts", "pane-state.ts", "pane-tint.ts",
  "pane/draft.ts", "pane/geometry.ts", "pane/reader.ts", "pane/repaint.ts", "panelock.ts", "pyint.ts",
  "queue-explanation.ts", "readiness-stall.ts", "recovery-policy.ts", "recovery/state.ts", "register-authority.ts", "registry.ts",
  "remind-job.ts", "remind-lock.ts", "remind.ts", "remote-target.ts", "reset.ts", "scripts-dir.ts", "selector.ts",
  "sentinel-preview.ts", "sentinel.ts", "slices/control-payload.ts", "slices/delivery-disposition.ts",
  "slices/digest-outcome.ts", "slices/redelivery-eligibility.ts", "slices/result-pairs.ts",
  "slices/waiter-scope.ts", "spawn.ts", "spool-backlog.ts", "spool-deadline.ts", "spool-digest-inject.ts",
  "spool-drain-effects.ts", "spool-drain.ts", "spool-effect-proof.ts", "spool-engine-worker.ts", "spool-engine.ts", "spool-expiry.ts", "spool-gc.ts",
  "spool-grace.ts", "spool-park-report.ts", "spool-park.ts", "spool-publication.ts", "spool-readiness.ts",
  "spool-rebind.ts", "spool-reown.ts", "spool-repark.ts", "spool-retired.ts", "spool-sidecar.ts", "spool-state.ts",
  "sentinel-tail.ts", "spool-waiter-loop.ts", "spool-waiter.ts", "spool-watch.ts", "stuck-sentinel.ts", "submit-frame.ts",
  "submit-phase.ts", "terminal-text.ts", "tmux.ts", "unicode-decimal.ts", "verbose.ts", "wait-cues.ts", "watch-child.ts",
  "watch-detect.ts", "watch-lease.ts", "watch-loop.ts", "watch-notice.ts", "watch-registry.ts",
  "watch-run.ts", "watch-sidecar.ts", "watch-tick.ts",
];

if (import.meta.main) {
  const scriptsDir = join(import.meta.dir, "../../../skills/tap/scripts");
  let resume: string[] = [], token = process.env.TAP_SPOOL_REOWN_TOKEN || "";
  const refresh = makeRefresh([
    ...WAITER_SOURCES.map(file => join(import.meta.dir, file)),
  ], process.argv[1]!, line => process.stderr.write(`${line}\n`), () => {
    const [bun, argv] = reexecImage(import.meta.dir, [process.argv[0]!, process.argv[1]!, process.argv[2]!, ...resume]);
    process.execve!(bun, argv,
      { ...process.env, TAP_SPOOL_REOWN_TOKEN: token });
  }, undefined, import.meta.dir);
  try {
    const { runWaiter } = await import("./spool-waiter-loop");
    process.exitCode = await runWaiter({ argv: process.argv.slice(2), scriptsDir, refresh: (last, remaining, owned) => {
      resume = ["--resume-cadence", last, ...remaining]; token = owned;
      return refresh();
    } });
  } catch (error) {
    process.stderr.write(`tap spool waiter: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
