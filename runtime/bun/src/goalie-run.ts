// `tap goalie run` — the goalie sidecar's entry (R6 U3 cutover; the Bash loop
// was tap-goalie.sh's `run` arm). This file does three things BEFORE the loop's
// modules load, in this order, because the incumbent did them in this order: it
// refuses a Bun below the floor the loop needs, it stamps every source the
// sidecar executes (goalie-run.ts, goalie-tick.ts, goalie-lease.ts and
// everything they import), and only then imports the tick. The stamp is the git
// blob id of each file, so the value the incumbent compared is the value this
// compares; a changed stamp re-execs this entry through `process.execve`, which
// keeps the PID the lease records and the tmux window owns. An unreadable
// source refuses another iteration (status 1, lease kept).
//
// Process identity is set at ENTRY, not after the first successful tick:
// `goalie on`'s takeover and stop-owned both treat watcher_pid 0 as absent, so
// a direct `goalie run` is invisible to them until this field is set.
// heartbeat_at stays post-tick — the tick log stamps AFTER appending the
// verdict line, so a hung first tick must not look alive.

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atLeast, makeRefresh, reexecImage, BUN_FLOOR, settledStampOf, stampOf, SIDECAR_SOURCES } from "./watch-run";

/**
 * The goalie sidecar's sources, relative to runtime/bun/src: the watch sidecar's
 * stamped closure (context, lease, registry, detectors — the loop's dynamic
 * imports pull the same tree) plus the goalie entries themselves. Over-stamping
 * is safe (an extra re-exec never under-protects); the remind.test check pins
 * that everything the loop's closure needs IS here.
 */
export const GOALIE_SIDECAR_SOURCES: readonly string[] = [
  ...new Set([...SIDECAR_SOURCES, "goalie-delivery.ts", "goalie-lease.ts", "goalie-run.ts", "goalie-tick.ts"]),
].sort();

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv[0] !== "run") {
    process.stderr.write("usage: goalie-run.ts run\n");
    process.exit(2);
  }
  const execve = process.execve;
  if (!atLeast(Bun.version, BUN_FLOOR) || typeof execve !== "function") {
    process.stderr.write(`tap goalie: the sidecar loop needs bun ${BUN_FLOOR} or newer (process.execve); this is ${Bun.version}\n`);
    process.exit(1);
  }
  const src = import.meta.dir;
  const files = GOALIE_SIDECAR_SOURCES.map(rel => join(src, rel));
  const entry = process.argv[1] ?? join(src, "goalie-run.ts");
  const stderr = (line: string) => process.stderr.write(`${line}\n`);
  const reexec = () => execve(...reexecImage(src), process.env);
  const initial = settledStampOf(files);
  if (initial === null) {
    stderr(`tap sidecar: source-unreadable; refusing another iteration: ${entry}`);
    process.exit(1);
  }
  const refresh = makeRefresh(files, entry, stderr, reexec, settledStampOf, src);
  // Loaded only after the first stamp: the bytes about to run are the bytes stamped.
  // atomicWrite belongs to this set too — a static import would resolve
  // fsatomic.ts before `initial` hashes it, so a source change landing in that
  // window ships with the OLD write implementation while the stamp already
  // claims the new closure.
  const { goalieTick, realGoalieDoors } = await import("./goalie-tick");
  const { field, set: leaseSet } = await import("./goalie-lease");
  const { isFile } = await import("./watch-lease");
  const { resolveContext, spoolTeamName } = await import("./context");
  const { atomicWrite } = await import("./fsatomic");
  let status = 0;
  try {
    const ctx = resolveContext(process.cwd(), process.env);
    const armPath = ctx.bus.home + "/goalie/arm.json";
    const scripts = join(dirname(src), "..", "..", "skills", "tap", "scripts");
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => process.exit(0));
    // Process identity at entry, not after the first successful tick.
    leaseSet(armPath, ["watcher_pid", String(process.pid)], process.env);
    // Source-refresh receipt: THIS process imported THIS closure. Only a
    // post-reexec process can write a stamp that differs from the old one.
    mkdirSync(ctx.bus.home + "/goalie", { recursive: true });
    atomicWrite(ctx.bus.home + "/goalie/source-stamp", stampOf(files) + "\n");
    for (;;) {
      const iter = refresh();
      if (iter) { status = iter.status; break; }
      if (!isFile(armPath)) break;
      // NO pre-tick heartbeat: a hung tick must not look alive. Errors are
      // swallowed inside the tick's advisory seams; a throw here ends the
      // iteration exactly like the incumbent's `tick || true`.
      try {
        const res = goalieTick({
          home: ctx.bus.home,
          registry: ctx.registryPath,
          scriptsDir: scripts,
          env: process.env,
          doors: realGoalieDoors(scripts, process.env, {
            busHome: ctx.bus.home,
            registryPath: ctx.registryPath,
            authorityTeam: spoolTeamName(ctx.bus.home, process.env.TAP_INDEX_HOME),
          }),
        });
        // The incumbent ran `tick || true`: rc ignored, bytes forwarded.
        if (res.stdout) process.stdout.write(res.stdout);
        if (res.stderr) process.stderr.write(res.stderr);
      } catch { /* the loop outlives a failed tick */ }
      if (!isFile(armPath)) break;
      let interval = Number(field(armPath, "tick_interval_seconds") ?? "");
      if (!Number.isFinite(interval) || interval <= 0) interval = 60;
      await new Promise(resolveSleep => setTimeout(resolveSleep, interval * 1000));
    }
  } catch (error) {
    process.stderr.write(`tap goalie: ${(error as Error).message}\n`);
    status = 1;
  }
  process.exit(status);
}
