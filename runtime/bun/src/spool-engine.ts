// A drain may wait inside a retained synchronous lock/helper. Keep cancellation
// outside that worker's event loop, and own exactly its foreground process group.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { artifactBun } from "./scripts-dir";
import { bunBinary } from "./courier-argv";

export function spoolEngineCommand(scriptsDir: string, ...args: string[]): string[] {
  const bun = artifactBun() ?? Bun.which("bun");
  if (!bun) throw new Error("tap: runtime_missing id=- slice=spool-drain: install bun");
  return [bun, join(scriptsDir, "../../../runtime/bun/src/spool-engine.ts"), scriptsDir, ...args];
}

export async function superviseSpool(args: string[]): Promise<number> {
  const scratch = mkdtempSync(join(tmpdir(), "tap-spool-engine."));
  const result = join(scratch, "result");
  const parent = process.ppid;
  const child = Bun.spawn([bunBinary(), process.argv[1]!, "--worker", result, ...args],
    { detached: true, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const pgid = child.pid;
  if (!Number.isSafeInteger(pgid) || pgid < 2) throw new Error("spool worker has no usable process-group identity");
  const group = (signal: NodeJS.Signals | 0): boolean => {
    try { process.kill(-pgid, signal); return true; }
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
  let interrupted = 0, cleanup: Promise<void> | undefined, cleanupError: unknown;
  const stop = (signal: NodeJS.Signals, code: number) => {
    if (interrupted) return;
    interrupted = code;
    cleanup = (async () => {
      group(signal);
      if (await awaitGroup(250)) return;
      group("SIGKILL");
      if (!await awaitGroup(2000)) throw new Error(`spool worker group ${pgid} cleanup is unconfirmed`);
    })().catch(error => { cleanupError = error; });
  };
  const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(signal => {
    const handler = () => stop(signal, signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
    process.on(signal, handler); return [signal, handler] as const;
  });
  const piped = process.env.TAP_SPOOL_PARENT_PIPE === "1";
  const ended = () => stop("SIGTERM", 143);
  if (piped) { process.stdin.once("end", ended); process.stdin.once("error", ended); process.stdin.resume(); }
  const orphan = piped ? undefined : setInterval(() => { if (process.ppid !== parent) ended(); }, 100);
  try {
    const code = await child.exited;
    await cleanup;
    if (cleanupError) throw cleanupError;
    if (interrupted) return interrupted;
    if (!await awaitGroup(200)) {
      stop("SIGTERM", 1); await cleanup;
      if (cleanupError) throw cleanupError;
      throw new Error("spool worker exited with foreground descendants still active");
    }
    let receipt = "";
    try { receipt = readFileSync(result, "utf8"); } catch { /* no completed worker */ }
    if (!/^\d+$/.test(receipt) || Number(receipt) !== code || child.signalCode) {
      process.stderr.write("tap: spool engine result unavailable; no delivery verdict\n");
      return 1;
    }
    return code;
  } finally {
    if (orphan) clearInterval(orphan);
    for (const [signal, handler] of handlers) process.off(signal, handler);
    if (piped) { process.stdin.off("end", ended); process.stdin.off("error", ended); process.stdin.destroy(); }
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--worker") {
    const result = args[1]!;
    const { writeFileSync } = await import("node:fs");
    const controller = new AbortController();
    const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(signal => {
      const stop = () => controller.abort(); process.on(signal, stop); return [signal, stop] as const;
    });
    let code = 1;
    try {
      const { spoolEngineMain } = await import("./spool-engine-worker");
      code = await spoolEngineMain(args.slice(2), process.env, controller.signal);
    } catch (error) { if (!controller.signal.aborted) process.stderr.write(`tap: spool engine failed: ${String(error)}\n`); }
    for (const [signal, stop] of handlers) process.off(signal, stop);
    writeFileSync(result, String(code));
    process.exitCode = code;
  } else {
    const receipt = args[0] === "--receipt";
    if (receipt) args.shift();
    try {
      const code = await superviseSpool(args);
      if (receipt) process.stdout.write(`spool-engine\t${code}\n`);
      else process.exitCode = code;
    } catch (error) { process.stderr.write(`tap: spool engine unavailable: ${String(error)}\n`); process.exitCode = 1; }
  }
}
