// `tap watch run` -- the watch sidecar's entry (migration slice W3). This file does
// three things BEFORE the loop's modules load, in this order, because the incumbent
// did them in this order: it refuses a Bun below the floor the loop needs, it
// stamps every source the sidecar executes (the loop's own closure, the tick's, and
// the reminder door's -- watch-loop.ts, watch-tick-run.ts, remind.ts and everything
// they import, including this file), and only then imports the loop. A stamp taken
// AFTER loading would let a source that changed between the load and the stamp run
// stale for as long as nothing else changed; the incumbent's
// `_tap_sidecar_source_stamp` was computed before `. lib.sh` for the same reason
// (tap-watch.sh at f4099de37, lines 15-36). Only node built-ins are imported
// statically here.
//
// The stamp is the git blob id of each file (`git hash-object --no-filters`, computed
// in-process: sha1 over `blob <length>\0<bytes>`), so the value the incumbent compared
// is the value this compares. A source unreadable at start refuses another iteration
// (status 1, lease kept: "source-unreadable"); a changed stamp, or a source that
// vanished after a good start (a landing deleted it, tap-conft), re-execs this entry
// with its own argv through `process.execve`, which keeps the PID the lease records
// and the tmux window owns -- the re-exec with the lease carried.
//
// The stamp list is CHECKED, not asserted: runtime/bun/test/remind.test.ts reds when
// an import is added to any entry without appearing here.

import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * The Bun this loop needs: `process.execve` (the re-exec with the lease carried) is
 * what the floor names. Mirrored by `engines.bun` in runtime/bun/package.json; a
 * test asserts the two agree, since the loop never reads package.json at start.
 */
export const BUN_FLOOR = "1.4.0";

/** The sidecar's sources, relative to runtime/bun/src: the entries' whole import closure. */
export const SIDECAR_SOURCES: readonly string[] = [
  "agent-state.ts", "agy-survey.ts", "approval-timeout-policy.ts", "approval-timeout-real.ts", "approval-timeout.ts", "be-bun-scrub.ts", "bus-archive-index.ts", "bus-maintenance-trigger.ts", "bus.ts", "bushome.ts", "clear-command.ts",
  "clear-fence.ts", "codex-update.ts", "config-error.ts", "config-file.ts", "context-census.ts", "context.ts", "courier-argv.ts",
  "courier-contract.ts", "courier.ts", "debug-capture.ts", "deliver.ts", "delivery-attempt.ts",
  "delivery-clock.ts", "delivery-custody.ts", "delivery-permissions.ts", "digest-index.ts", "digest-items.ts",
  "digest-window.ts", "envelope.ts", "events.ts", "existing-sentinel.ts", "forwarding.ts", "fsatomic.ts",
  "git-root.ts",
  "harness-families.ts", "harness-queue.ts", "ids.ts", "index-home.ts", "index-snapshot.ts", "injection-behavior.ts",
  "input-backup.ts", "input-protection.ts", "invocation-memo.ts", "latest-outbound.ts", "lock-attribution.ts", "lossless-json.ts", "native-error.ts",
  "notice-submit.ts", "notice.ts", "notifications.ts", "nudge-wire.ts", "observe-gather.ts", "observe.ts",
  "opencode-composer.ts", "opencode-service.ts", "opencode-shared-seat.ts", "opencode-shared.ts", "opencode-store.ts", "opencode-turn-state.ts", "overprint-marker.ts", "pane-harness.ts", "pane-identity.ts", "pane-state.ts", "pane-tint.ts", "pane/draft.ts",
  "pane/geometry.ts", "pane/reader.ts", "pane/repaint.ts", "panelock.ts", "payload-fields.ts", "proc-row.ts", "process-ancestry.ts", "pyint.ts",
  "queue-explanation.ts", "readiness-stall.ts", "recovery-policy.ts", "recovery/cli.ts", "recovery/effect.ts", "recovery/identity-guard.ts", "recovery/operator-admission.ts", "recovery/operator-record.ts", "recovery/operator-screen.ts", "recovery/state.ts", "register-authority.ts", "registry.ts",
  "remind-job.ts", "remind-lock.ts", "remind.ts", "remote-target.ts", "reset.ts", "retry.ts", "scripts-dir.ts", "seat-state.ts",
  "selector.ts", "sentinel-preview.ts", "sentinel.ts", "slices/control-payload.ts",
  "slices/delivery-disposition.ts", "slices/digest-outcome.ts", "slices/redelivery-eligibility.ts",
  "slices/result-pairs.ts", "spawn.ts", "spool-backlog.ts", "spool-deadline.ts", "spool-digest-inject.ts",
  "spool-drain-effects.ts", "spool-drain.ts", "spool-effect-proof.ts", "spool-engine-worker.ts", "spool-engine.ts", "spool-expiry.ts", "spool-gc.ts",
  "spool-grace.ts", "spool-park-report.ts", "spool-park.ts", "spool-publication.ts", "spool-readiness.ts",
  "spool-rebind.ts", "spool-reown.ts", "spool-repark.ts", "spool-retired.ts", "spool-sidecar.ts", "spool-state.ts",
  "sentinel-tail.ts", "spool-watch.ts", "stuck-sentinel.ts", "submit-frame.ts", "submit-phase.ts", "team-observe.ts",
  "team-selection.ts", "terminal-text.ts", "tmux.ts", "unicode-decimal.ts", "verbose.ts", "verbs/escalate.ts",
  "verbs/peek.ts", "wait-cues.ts", "watch-blocked.ts", "watch-child.ts", "watch-detect.ts", "watch-detectors.ts",
  "watch-evaluate.ts", "watch-evaluator.ts", "watch-lease.ts", "watch-loop.ts", "watch-notice.ts",
  "watch-registry.ts", "watch-run.ts", "watch-sidecar.ts", "watch-tick-run.ts", "watch-tick.ts",
];

/** `git hash-object --no-filters -- <files>`: one blob id per line; null when any file cannot be read. */
export function stampOf(files: readonly string[]): string | null {
  const ids: string[] = [];
  for (const file of files) {
    let bytes: Buffer;
    try { bytes = readFileSync(file); } catch { return null; }
    ids.push(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"));
  }
  return ids.join("\n");
}

/**
 * The stamp, re-read while any source is unreadable, for at most `windowMs`. Git's
 * checkout unlinks a modified file before writing its replacement, so an install that
 * only EDITS stamped sources can still show one of them missing for a moment; a tick
 * that stamped in that gap took it for a deletion and ended (tap-conft M17, the
 * 21:58Z install). Null only when a source stays unreadable for the whole window.
 */
export function settledStampOf(files: readonly string[], windowMs = STAMP_SETTLE_MS, sleep: (ms: number) => void = Bun.sleepSync): string | null {
  // Monotonic: a wall-clock step must not stretch or skip the window.
  const until = performance.now() + windowMs;
  for (;;) {
    const stamp = stampOf(files);
    if (stamp !== null || performance.now() >= until) return stamp;
    sleep(Math.min(STAMP_SETTLE_STEP_MS, Math.max(0, until - performance.now())));
  }
}
export const STAMP_SETTLE_MS = 2000;
const STAMP_SETTLE_STEP_MS = 100;

/**
 * This entry's re-exec image: process.execPath with process.argv from source. In a
 * release artifact the entry runs under libexec/tap/bun, where process.execPath is
 * the bare compiled router (which would read the entry as a verb), so the re-exec
 * goes back through that shim. `src` is the entry's own runtime/bun/src directory.
 * Node built-ins only, per the rule above; scripts-dir.ts artifactBun() is the
 * same check for code that may import it.
 */
export function currentReleaseSource(src: string): string {
  const root = resolve(src, "../../..");
  // Only a bootstrap-installed release follows current. A clone, extracted build,
  // or missing/broken current keeps its own source-refresh behavior.
  if (basename(dirname(root)) !== "versions") return src;
  try {
    const marker = JSON.parse(readFileSync(join(root, "tap-release.json"), "utf8"));
    if (marker.schema !== 1 || marker.version !== basename(root)) return src;
    const current = realpathSync(join(root, "../../current"));
    if (dirname(current) !== realpathSync(dirname(root))) return src;
    const next = JSON.parse(readFileSync(join(current, "tap-release.json"), "utf8"));
    if (next.schema !== 1 || next.version !== basename(current)) return src;
    accessSync(join(current, "libexec/tap/bun"), constants.X_OK);
    return join(current, "runtime/bun/src");
  } catch { return src; }
}

export function reexecImage(src: string, argv = process.argv): [string, string[]] {
  const current = currentReleaseSource(src);
  const shim = join(current, "../../../libexec/tap/bun");
  try {
    accessSync(shim, constants.X_OK);
    const entry = current === src ? argv[1]! : join(current, basename(argv[1]!));
    return [shim, [shim, entry, ...argv.slice(2)]];
  } catch {
    return [process.execPath, argv];
  }
}

/**
 * Source refresh for the Bun loop (the retired Bash `tap_sidecar_source_refresh`): null while the stamp holds; on a change,
 * the line and the re-exec (which does not return on success -- a fake that returns
 * makes the loop end with 1, as a failed `exec` did). Both reads settle first
 * (`settledStampOf`). A source still unreadable at start is the refusal line and 1;
 * one still unreadable later is a change and re-execs (the incumbent refused there
 * too, which stranded every parked entry on a deletion).
 */
export function makeRefresh(files: readonly string[], entry: string, stderr: (line: string) => void, reexec: () => void,
  stamp: (files: readonly string[]) => string | null = settledStampOf, src?: string): () => { status: number } | null {
  const initial = stamp(files);
  if (initial === null) {
    stderr(`tap sidecar: source-unreadable; refusing another iteration: ${entry}`);
    return () => ({ status: 1 });
  }
  return () => {
    const upgraded = src !== undefined && currentReleaseSource(src) !== src;
    const current = stamp(files);
    if (!upgraded && current === initial) return null;
    // A source that vanished after a good start is a landing that deleted it (an earlier landing
    // removed launcher/effects.ts and ended every live waiter, tap-conft): the new
    // entry stamps its own list, and refuses at start if that is unreadable too.
    stderr(upgraded ? `tap sidecar: release-changed; re-exec: ${entry}`
      : current === null ? `tap sidecar: source-unreadable; re-exec: ${entry}` : `tap sidecar: source-changed; re-exec: ${entry}`);
    try {
      reexec();
    } catch (error) {
      stderr(`tap sidecar: re-exec failed: ${(error as Error).message}`);
    }
    return { status: 1 };
  };
}

/** A dotted version at or above the floor (numeric components, missing ones are 0). */
export function atLeast(version: string, floor: string): boolean {
  const v = version.split(".").map(Number), f = floor.split(".").map(Number);
  for (let i = 0; i < Math.max(v.length, f.length); i++) {
    const a = v[i] ?? 0, b = f[i] ?? 0;
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    if (a !== b) return a > b;
  }
  return true;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv[0] !== "run") {
    process.stderr.write("usage: watch-run.ts run\n");
    process.exit(2);
  }
  const execve = process.execve;
  if (!atLeast(Bun.version, BUN_FLOOR) || typeof execve !== "function") {
    process.stderr.write(`tap watch: the sidecar loop needs bun ${BUN_FLOOR} or newer (process.execve); this is ${Bun.version}\n`);
    process.exit(1);
  }
  const src = import.meta.dir;
  const scriptsDir = join(src, "../../../skills/tap/scripts");
  const files = SIDECAR_SOURCES.map(rel => join(src, rel));
  const entry = process.argv[1] ?? join(src, "watch-run.ts");
  const stderr = (line: string) => process.stderr.write(`${line}\n`);
  const refresh = makeRefresh(files, entry, stderr, () => execve(...reexecImage(src), process.env), settledStampOf, src);
  // The stamp is consumed BEFORE any stamped module is imported: an unreadable source at
  // start is the refusal line and 1 -- never Bun's own resolution error for a module that
  // is not there -- and a source that changed between the two
  // stamps is a re-exec, as at any later boundary. The lease is untouched either way.
  const startup = refresh();
  if (startup) process.exit(startup.status);
  // Loaded only now: the stamp above is of the bytes about to run.
  const { realLoopSeams, runLoop } = await import("./watch-loop");
  const { resolveContext } = await import("./context");
  const { withWatchLifetime } = await import("./watch-child");
  let status: number;
  try {
    // An unenrolled cwd with no TAP_HOME is `tap watch: <reason>` and 1 in the sidecar's
    // window (the tick's face), never a stack trace.
    const ctx = resolveContext(process.cwd(), process.env);
    // This persistent sidecar outlives its launcher. Signals stop its owned
    // tick first; only the tick and spool children monitor their parent lifetime.
    status = await withWatchLifetime(signal => runLoop(realLoopSeams({
      bus: ctx.bus.home,
      scripts: join(dirname(src), "..", "..", "skills", "tap", "scripts"),
      src,
      refresh,
      signal,
    }), signal), false);
  } catch (error) {
    process.stderr.write(`tap watch: ${(error as Error).message}\n`);
    status = 1;
  }
  process.exitCode = status;
}
