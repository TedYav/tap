import { acquireWindowRepaintLock, type PaneLock } from "../panelock";
import { capturePane, physicalSocketPath, tmux, tmuxReadOnly, type Run } from "../tmux";

export interface RepaintResult {
  ok: boolean;
  attempted: boolean;
  before: string | null;
  after: string | null;
  reason: string;
}

export interface RepaintIO {
  describe(target: string): Run;
  windowSize(windowId: string): Run;
  capture(target: string): Run;
  resize(windowId: string, width: number, height: number): Run;
  restoreWindowSize(windowId: string, value: string | null): Run;
  lock(windowId: string): PaneLock | null;
  settle(): void;
}

/**
 * A budget gate over the repaint transaction (tap-cl1es): `admit` runs after
 * the window lock is held and may refuse the repaint; `commit` records the
 * spend before the lock is released, so concurrent attempts cannot each see a
 * stale budget and double-spend. Only an attempted resize is a spend.
 */
export interface RepaintGate {
  admit(): boolean;
  commit(attempted: boolean): void;
}

export const REAL_REPAINT_IO: RepaintIO = {
  describe: target => tmuxReadOnly(["display-message", "-p", "-t", target,
    "#{pane_id}\u001f#{window_id}\u001f#{window_width}\u001f#{window_height}"]),
  windowSize: windowId => tmuxReadOnly(["show-options", "-wqv", "-t", windowId, "window-size"]),
  capture: target => capturePane(target, true, false),
  resize: (windowId, width, height) => tmux(["resize-window", "-t", windowId, "-x", String(width), "-y", String(height)]),
  restoreWindowSize: (windowId, value) => value === null
    ? tmux(["set-option", "-wqu", "-t", windowId, "window-size"])
    : tmux(["set-option", "-wq", "-t", windowId, "window-size", value]),
  lock: windowId => acquireWindowRepaintLock(physicalSocketPath(), windowId),
  settle: () => Bun.sleepSync(80),
};

function describe(target: string, io: RepaintIO): { paneId: string; windowId: string; width: number; height: number } | null {
  const observed = io.describe(target);
  if (observed.code !== 0 || observed.rateLimited) return null;
  const [paneId, windowId, widthRaw, heightRaw] = observed.stdout.trim().split("\u001f");
  const width = Number(widthRaw), height = Number(heightRaw);
  if (!/^%\d+$/.test(paneId ?? "") || !/^@\d+$/.test(windowId ?? "") ||
      !Number.isSafeInteger(width) || width < 2 || !Number.isSafeInteger(height) || height < 1) return null;
  return { paneId: paneId!, windowId: windowId!, width, height };
}

function windowSize(windowId: string, io: RepaintIO): string | null | undefined {
  const observed = io.windowSize(windowId);
  if (observed.code !== 0 || observed.rateLimited) return undefined;
  const value = observed.stdout.trim();
  if (!value) return null;
  return /^(?:latest|largest|smallest|manual)$/.test(value) ? value : undefined;
}

function failure(attempted: boolean, before: string | null, after: string | null, reason: string): RepaintResult {
  return { ok: false, attempted, before, after, reason };
}

/**
 * Force one bounded SIGWINCH-style repaint on the exact window containing the
 * target pane, then restore its original dimensions before returning.
 *
 * This never sends input. Success requires readable before/after frames, the
 * one-column resize being observed, and both the original geometry and the
 * inherited-or-explicit `window-size` option being observed after restoration.
 * The full transaction is serialized by physical server plus window id.
 */
export function repaintPane(target: string, io: RepaintIO = REAL_REPAINT_IO, gate?: RepaintGate): RepaintResult {
  let candidate;
  try {
    candidate = describe(target, io);
  } catch (error) {
    return failure(false, null, null, `target geometry failed: ${error}`);
  }
  if (!candidate || (target.startsWith("%") && candidate.paneId !== target)) {
    return failure(false, null, null, "target geometry is unavailable");
  }
  const lock = io.lock(candidate.windowId);
  if (!lock) return failure(false, null, null, "window repaint is already in progress");

  let original: typeof candidate | null = null;
  let originalOption: string | null | undefined;
  let before: string | null = null;
  let after: string | null = null;
  let attempted = false;
  let operationFailure = "";
  let restoreFailure = "";
  try {
    // The budget decision runs under the lock: a decision taken before it
    // could race a concurrent attempt's spend (tap-cl1es review C).
    if (gate && !gate.admit()) return failure(false, null, null, "repaint budget declined");
    original = describe(target, io);
    if (!original || original.paneId !== candidate.paneId || original.windowId !== candidate.windowId) {
      return failure(false, null, null, "target window changed before repaint ownership");
    }
    originalOption = windowSize(original.windowId, io);
    if (originalOption === undefined) return failure(false, null, null, "window-size option is unavailable");
    const captured = io.capture(original.paneId);
    if (captured.code !== 0 || captured.rateLimited) return failure(false, null, null, "before-repaint capture is unavailable");
    before = captured.stdout;

    const alternate = original.width > 2 ? original.width - 1 : original.width + 1;
    attempted = true; // a throwing tmux client may still have reached the server
    try {
      const changed = io.resize(original.windowId, alternate, original.height);
      if (changed.code !== 0 || changed.rateLimited) operationFailure = "window resize was unconfirmed";
    } catch (error) {
      operationFailure = `window resize was unconfirmed: ${error}`;
    }
    if (!operationFailure) {
      io.settle();
      const intermediate = describe(original.paneId, io);
      if (!intermediate || intermediate.windowId !== original.windowId || intermediate.width !== alternate || intermediate.height !== original.height) {
        operationFailure = "window resize was not observed";
      }
    }
  } catch (error) {
    operationFailure = `repaint observation failed: ${error}`;
  } finally {
    if (attempted && original && originalOption !== undefined) {
      try {
        const restored = io.resize(original.windowId, original.width, original.height);
        if (restored.code !== 0 || restored.rateLimited) restoreFailure = "original window dimensions were not restored";
      } catch (error) {
        restoreFailure = `original window dimensions were not restored: ${error}`;
      }
      try {
        const restoredOption = io.restoreWindowSize(original.windowId, originalOption);
        if (restoredOption.code !== 0 || restoredOption.rateLimited) restoreFailure ||= "original window-size option was not restored";
      } catch (error) {
        restoreFailure ||= `original window-size option was not restored: ${error}`;
      }
      try { io.settle(); } catch (error) { restoreFailure ||= `restore settle failed: ${error}`; }
      try {
        const finalGeometry = describe(original.paneId, io);
        if (!finalGeometry || finalGeometry.windowId !== original.windowId || finalGeometry.width !== original.width || finalGeometry.height !== original.height) {
          restoreFailure ||= "restored window dimensions were not observed";
        }
        if (windowSize(original.windowId, io) !== originalOption) restoreFailure ||= "restored window-size option was not observed";
        const captured = io.capture(original.paneId);
        if (captured.code === 0 && !captured.rateLimited) after = captured.stdout;
        else restoreFailure ||= "post-repaint capture is unavailable";
      } catch (error) {
        restoreFailure ||= `post-repaint verification failed: ${error}`;
      }
    }
    // Record the spend before the lock is released: the next contender's
    // admit() must see this attempt (tap-cl1es review C).
    try { gate?.commit(attempted); } catch { /* A broken budget never wedges the restore. */ }
    lock.release();
  }

  if (restoreFailure) return failure(attempted, before, after, restoreFailure);
  if (operationFailure) return failure(attempted, before, after, operationFailure);
  if (after === null) return failure(attempted, before, null, "post-repaint capture is unavailable");
  return { ok: true, attempted, before, after, reason: "resize-and-restore repaint observed" };
}
