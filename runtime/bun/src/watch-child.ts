// The watch loop's tick and the tick's spool pass are sequential, owned children.
// Their private stdin pipe carries lifetime only: EOF is immediate-parent loss,
// including loss before the child installs its handlers. No PID census grants it.
export class WatchStopped extends Error {
  constructor(readonly signal: NodeJS.Signals = "SIGTERM") { super("watch invocation stopped"); }
}

export function checkWatchStop(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof WatchStopped ? signal.reason : new WatchStopped();
}

export async function withWatchLifetime(body: (signal: AbortSignal) => Promise<number>, monitorParent: boolean): Promise<number> {
  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals) => { if (!controller.signal.aborted) controller.abort(new WatchStopped(signal)); };
  const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(signal => {
    const handler = () => stop(signal); process.on(signal, handler); return [signal, handler] as const;
  });
  const piped = monitorParent && process.env.TAP_WATCH_PARENT_PIPE === "1";
  const parent = process.ppid;
  const ended = () => stop("SIGTERM");
  if (piped) { process.stdin.once("end", ended); process.stdin.once("error", ended); process.stdin.resume(); }
  const orphan = monitorParent && !piped ? setInterval(() => { if (process.ppid !== parent) ended(); }, 100) : undefined;
  try { return await body(controller.signal); }
  catch (error) { if (error instanceof WatchStopped) return 0; throw error; }
  finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    if (orphan) clearInterval(orphan);
    if (piped) { process.stdin.off("end", ended); process.stdin.off("error", ended); process.stdin.destroy(); }
  }
}

export async function watchChild(argv: string[], env: NodeJS.ProcessEnv, signal: AbortSignal | undefined, kind: "tick" | "spool"): Promise<number> {
  checkWatchStop(signal);
  const childEnv = { ...env };
  delete childEnv.TAP_WATCH_PARENT_PIPE; delete childEnv.TAP_SPOOL_PARENT_PIPE;
  childEnv[kind === "tick" ? "TAP_WATCH_PARENT_PIPE" : "TAP_SPOOL_PARENT_PIPE"] = "1";
  const child = Bun.spawn(argv, { env: childEnv, detached: true, stdin: "pipe", stdout: "inherit", stderr: "inherit" });
  const pgid = child.pid;
  if (!Number.isSafeInteger(pgid) || pgid < 2) throw new Error("watch child has no usable process-group identity");
  const group = (sig: NodeJS.Signals | 0): boolean => {
    // Negate only the positive group identity minted by this spawn, never an
    // environment value, stale registry PID, zero or the caller's own group.
    try { process.kill(-pgid, sig); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
      throw error;
    }
  };
  const awaitGroup = async (milliseconds: number) => {
    const deadline = Date.now() + milliseconds;
    while (group(0) && Date.now() < deadline) await Bun.sleep(10);
    return !group(0);
  };
  let stopping: Promise<void> | undefined, cleanupError: unknown;
  const stop = () => {
    stopping ??= (async () => {
      try { await child.stdin.end(); } catch { /* pipe already closed */ }
      // Let the child unwind its own descendants before group fallback. The
      // tick must await the spool supervisor, not die ahead of its cleanup.
      try { child.kill(signal?.reason instanceof WatchStopped ? signal.reason.signal : "SIGTERM"); } catch { /* exited */ }
      if (await awaitGroup(1500)) return;
      group("SIGTERM");
      if (await awaitGroup(500)) return;
      group("SIGKILL");
      if (!await awaitGroup(2000)) throw new Error(`watch child group ${pgid} cleanup is unconfirmed`);
    })().catch(error => { cleanupError = error; });
  };
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  try {
    const code = await child.exited;
    await stopping;
    if (cleanupError) throw cleanupError;
    checkWatchStop(signal);
    if (child.signalCode) throw new Error(`watch ${kind} child terminated by ${child.signalCode}; no completed pass`);
    if (!await awaitGroup(200)) {
      stop(); await stopping;
      if (cleanupError) throw cleanupError;
      throw new Error(`watch ${kind} child exited with foreground descendants still active`);
    }
    checkWatchStop(signal);
    return code;
  } finally {
    signal?.removeEventListener("abort", stop);
    try { await child.stdin.end(); } catch { /* child already closed its lifetime pipe */ }
  }
}

export function watchSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  checkWatchStop(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason instanceof WatchStopped ? signal.reason : new WatchStopped()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
