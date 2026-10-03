// The watch sidecar's lifecycle: ensure exactly one loop window for a team, and
// the guarded disarm that reaps it. Migration slice W1 moves `_watch_ensure_sidecar`,
// `_watch_off_guarded` and `tap_watch_reminders` out of tap-watch.sh. The verb
// layer (verbs/watch.ts) calls these with the context already resolved; remind.ts
// calls `offGuarded` IN-PROCESS inside its queue-lock body, which is what closes
// the `bash -c '. tap-watch.sh; _watch_off_guarded'` backcall it used to spawn.
//
// Stamped in the sidecar fingerprint through remind.ts, so this module imports
// only loop-safe leaves and takes bus, scripts dir, registry path and clock as
// arguments -- never a resolved context.
//
// What is carried from the incumbent, each pinned by a control:
//   - One loop per team under race: concurrent `on`s serialize on the atomic
//     `watch/.spawn.lock` mkdir mutex (macOS ships no flock(1)); a caller that
//     cannot acquire it within ~5 s skips ITS spawn and keeps the lease, and never
//     removes a mutex it does not hold. The same path a pre-upgrade Bash `on`
//     takes, so the two serialize with each other during the mixed window.
//   - Self-heal is OWNERSHIP-GATED: a window named `watch` is reaped only when its
//     pane pid equals the recorded `watcher_pid`; a foreign window sharing the name
//     is left alone and the caller is told to run `tap health`. A confirmed-ours
//     window whose process is alive and whose heartbeat is fresh (or absent: just
//     spawned, not yet ticked) is an idempotent skip; dead or stale is respawned.
//   - The spawned command is `TAP_LOCK_DIR='<locks>' TAP_HOME='<bus>' exec '<bun>'
//     '<src>/watch-run.ts' run` (the loop is Bun; <bun> is the absolute executable whose
//     floor was checked) and the recorded `watcher_command` is `watch-run.ts run`:
//     `tap remind`'s reuse rule and `tap health` compare that string. A recorded
//     command matches itself only; the retired Bash loop's signature is no longer known.
//   - `offGuarded` is armer-owned unless `--force`; the forced path notices the
//     armer. Tints are cleared BEFORE the record (the only tint-ownership record)
//     is deleted; the locked disarm is fail-loud (lease KEPT, error surfaced,
//     nonzero); a sticky NOTIFY is cleared ONLY by an armer self-disarm; the
//     sidecar window is killed only when its pane pid still matches.

import { spawnSync } from "node:child_process";
import { mkdirSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { markResetGenerationReused } from "./reset";
import { tmux, tmuxReadOnly } from "./tmux";
import { untintPane } from "./pane-tint";
import { disarm, fieldValue, isFile, itemLines, readLoose, set as leaseSet } from "./watch-lease";
import { armPath, noticeOrNotify, notifyPath } from "./watch-notice";
import { repoRoot, teamSession } from "./watch-registry";
import { atLeast, BUN_FLOOR } from "./watch-run";
import { lockRoot } from "./panelock";
import { artifactBun, runtimeModule } from "./scripts-dir";

export const WATCHER_COMMAND = "watch-run.ts run";

/** The bound the status surface puts on its `ps` probe. */
const PS_TIMEOUT_MS = 2000;

/**
 * What a bounded `ps` says about PID alone, for the status surface (`dispatcherLiveness`), which only REPORTS: the pid is
 * definitively gone, unknowable, or live with this command line. A `ps` that could not run, timed out, or was killed is
 * "unknown" even if it printed something first -- it says nothing trustworthy about the process.
 */
function probePid(pid: string): { state: "dead" | "unknown" } | { state: "live"; out: string } {
  if (!/^[0-9]+$/.test(pid) || pid === "0") return { state: "dead" };
  // SIGKILL, not the default SIGTERM: a probe that ignores TERM would otherwise outlive its timeout and hold the status surface
  // until it chose to exit, so the bound is hard only with a force-kill.
  const r = spawnSync("ps", ["-p", pid, "-o", "command="], { encoding: "utf8", timeout: PS_TIMEOUT_MS, killSignal: "SIGKILL" });
  if (r.error || r.status === null) return { state: "unknown" };
  const out = (r.stdout ?? "").trim();
  // `ps -p <pid> -o command=` for a pid that is gone exits 1 with empty stdout AND empty
  // stderr (macOS and procps alike); that exact shape is the only "no such process".
  // Any other empty result -- another nonzero exit, stderr output, a clean exit that
  // printed nothing -- is a failed inspection: missing evidence, not a dead watcher.
  // A printed command line is positive evidence whatever exit status or stderr came with it.
  if (!out) return { state: r.status === 1 && !(r.stderr ?? "").trim() ? "dead" : "unknown" };
  return { state: "live", out };
}

/**
 * `tap_supervision_pid_alive`: a live process whose command still contains <command>. Its callers ACT on "not alive"
 * (respawn a sidecar, reap a window), so it keeps the incumbent's stdout-first yes/no: an unbounded `ps` (a slow one on a
 * loaded machine keeps waiting), and a printed matching command line is alive whatever exit status or signal ended `ps`.
 * The three-valued view belongs to the status surface (`dispatcherLiveness`) alone. A recorded command matches itself only.
 */
export function pidAlive(pid: string, command: string): boolean {
  if (!/^[0-9]+$/.test(pid) || pid === "0") return false;
  const r = spawnSync("ps", ["-p", pid, "-o", "command="], { encoding: "utf8" });
  const out = (r.stdout ?? "").trim();
  if (!out) return false;
  if (!command) return true;
  return out.includes(command);
}

/**
 * Whether the loop the lease names is actually running, from the lease's own identity:
 * `watcher_pid` + `watcher_command` (process check) and `heartbeat_at` (freshness, with
 * the same bound `remindersEntry` reuses a runner under). "unknown" is a lease or a
 * process table this cannot read -- never a stand-in for "dead". A live pid whose
 * heartbeat is older than the bound is "dead": it stopped ticking, and
 * `ensureSidecar` respawns it on the same evidence. A live pid with NO heartbeat yet is
 * alive only within the same bound measured from `armed_at`.
 */
export function dispatcherLiveness(rec: unknown, now: number): { state: "alive" | "dead" | "unknown"; detail: string; neverTicked?: true; noWatcher?: true; clockFault?: true; badCommand?: { pid: string; command: string } } {
  if (rec === undefined) return { state: "unknown", detail: "the lease cannot be read" };
  // Valid JSON of the wrong shape (a list, a scalar, null) has no fields to read, so it is no evidence that nothing runs.
  if (rec === null || typeof rec !== "object" || Array.isArray(rec)) return { state: "unknown", detail: "the lease is not a JSON object" };
  const pid = fieldValue(rec, "watcher_pid");
  // Missing, empty or 0 is "no watcher recorded" (dead, as documented); a value that IS present but is not a pid (nonnumeric,
  // negative) names an identity this cannot check, which is unknown, not a verdict that nothing runs.
  if (pid === "" || pid === "0") return { state: "dead", detail: "no watcher recorded", noWatcher: true };
  if (!/^[0-9]+$/.test(pid)) return { state: "unknown", detail: `the recorded watcher pid '${pid}' is not a valid pid` };
  // Order: a pid no process holds is dead whatever the record names (no dispatcher runs there, and `tap watch on` is the
  // recovery); a probe that cannot tell is unknown. Only a LIVE pid is then held to the signature, which exists for pid reuse:
  // an unknown or missing command is unknown WITHOUT comparing it to the process (pidAlive matches recorded text as a
  // substring, so "bogus" would read dead against the real watcher and "bash" alive against any shell), as remindersEntry
  // declines to ride a runner whose signature is not a known one; a known signature gets the substring match.
  const command = fieldValue(rec, "watcher_command");
  const probe = probePid(pid);
  if (probe.state !== "live") return probe.state === "unknown" ? { state: "unknown", detail: `cannot inspect pid ${pid}` } : { state: "dead", detail: `pid ${pid} is not running the watcher` };
  // `badCommand` lets the status surface name this cause: `tap health` passes the same command to pidAlive and reports the pid alive.
  if (command !== WATCHER_COMMAND) return { state: "unknown", detail: `pid ${pid}'s recorded watcher command ${command ? `'${command}' is not a known watcher signature` : "is missing"}`, badCommand: { pid, command } };
  if (!probe.out.includes(WATCHER_COMMAND)) return { state: "dead", detail: `pid ${pid} is not running the watcher` };
  const heartbeat = fieldValue(rec, "heartbeat_at");
  const interval = fieldValue(rec, "tick_interval_seconds");
  const limit = Math.max((/^[0-9]+$/.test(interval) ? Number(interval) : 0) * 3, 180);
  if (!heartbeat || heartbeat === "0") {
    // A just-spawned loop has not ticked yet, but a watcher that hangs or stops before its FIRST heartbeat
    // keeps a matching pid and command forever: bound the grace from the arm time, as a later silence is bound
    // from the last heartbeat.
    const armed = fieldValue(rec, "armed_at");
    if (!/^[0-9]+$/.test(armed)) return { state: "unknown", detail: `pid ${pid} has not ticked and the arm time is unreadable`, clockFault: true };
    const waited = now - Number(armed);
    if (waited < 0) return { state: "unknown", detail: `pid ${pid} has not ticked and the arm time is in the future`, clockFault: true };
    // `neverTicked` marks the one dead cause a re-run of `tap watch on` cannot cure: ensureSidecar reads an empty heartbeat
    // as a just-spawned loop and skips a live matching watcher, so the caller must name a recovery that does work.
    if (waited > limit) return { state: "dead", detail: `pid ${pid} is running but has not ticked in ${waited}s since arming`, neverTicked: true };
    return { state: "alive", detail: `pid ${pid}, no heartbeat yet` };
  }
  if (!/^[0-9]+$/.test(heartbeat)) return { state: "unknown", detail: `pid ${pid} is running but its heartbeat is unreadable`, clockFault: true };
  const age = now - Number(heartbeat);
  // A heartbeat from the future is a clock or lease fault, not health (remindersEntry requires age >= 0 as well).
  if (age < 0) return { state: "unknown", detail: `pid ${pid} is running but its heartbeat is ${-age}s in the future`, clockFault: true };
  if (age > limit) return { state: "dead", detail: `pid ${pid} is running but its last heartbeat was ${age}s ago` };
  return { state: "alive", detail: `pid ${pid}, heartbeat ${age}s ago` };
}

/** `tap_watch_clear_tints`: untint every pane the record owns; best-effort throughout. */
export function clearTints(bus: string, env: NodeJS.ProcessEnv = process.env): void {
  for (const pane of itemLines(readLoose(armPath(bus)), "tinted_panes")) {
    if (!pane) continue;
    try { untintPane(pane, env); } catch { /* best-effort */ }
  }
}

/** The team tmux session whose `watch` window already exists, else null (no session, or no such window). */
export function existingWatchWindow(registry: string, armer: string, env: NodeJS.ProcessEnv): string | null {
  const sess = teamSession(registry, armer, env);
  return sess && watchWindowPanePid(sess, env) !== null ? sess : null;
}

function watchWindowPanePid(sess: string, env: NodeJS.ProcessEnv): string | null {
  const r = tmuxReadOnly(["list-windows", "-t", sess, "-F", "#{window_name} #{pane_pid}"], env);
  if (r.code !== 0) return null;
  for (const line of r.stdout.split("\n")) {
    const [name, pid] = line.split(" ", 2);
    if (name === "watch") return pid ?? "";
  }
  return null;
}

function staleThreshold(interval: string): number {
  const iv = /^[0-9]+$/.test(interval) ? Number(interval) * 3 : 0;
  return iv >= 180 ? iv : 180;
}

export interface SidecarArgs {
  bus: string;
  scripts: string;
  registry: string;
  armer: string;
  noSpawn: boolean;
  now: string;
  env?: NodeJS.ProcessEnv;
  /** The runtime the window runs the loop under: this process's Bun (version and executable) by default; a control's seams. */
  runtimeVersion?: string;
  runtimeExecutable?: string;
}

/** One shell word for the window's command line: single-quoted, an embedded quote closed and reopened. */
export function sq(word: string): string { return `'${word.replace(/'/g, "'\\''")}'`; }

/**
 * The sidecar window's full launch command. The pane inherits the tmux
 * server's global environment plus this prefix — not the arming client's env —
 * so the derived TAP_HOME alone would leave every sidecar descendant locking
 * under `<bus>/locks` while interactive seats lock under the default root
 * (tap-a5j6t). The armer's resolved lock root rides along explicitly.
 */
export function sidecarCommand(bus: string, runtimeExecutable: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return `TAP_LOCK_DIR=${sq(lockRoot(env))} TAP_HOME=${sq(bus)} exec ${sq(runtimeExecutable ?? artifactBun() ?? process.execPath)} ${sq(runtimeModule("src/watch-run.ts"))} run`;
}

/**
 * `_watch_ensure_sidecar`. Returns 0 when a loop is confirmed (spawned, or
 * already running and fresh) and 1 when the lease stands without a confirmed
 * runner -- every 1 path has already said why on stderr.
 */
export function ensureSidecar(a: SidecarArgs): number {
  const env = a.env ?? process.env;
  if (a.noSpawn) {
    process.stdout.write("tap watch: sidecar spawn skipped because TAP_WATCH_NO_SPAWN is set\n");
    return 0;
  }
  // The loop's entry refuses a Bun below its floor (`process.execve`) -- but only AFTER
  // the window is open and its pane pid recorded, which would read as "sidecar started"
  // over a loop that ended at once. Refuse here first, before any spawn or record write,
  // with the same line.
  const runtime = a.runtimeVersion ?? Bun.version;
  if (!atLeast(runtime, BUN_FLOOR)) {
    process.stderr.write(`tap watch: the sidecar loop needs bun ${BUN_FLOOR} or newer (process.execve); this is ${runtime}; sidecar not spawned, watch remains armed\n`);
    return 1;
  }
  const sess = teamSession(a.registry, a.armer, env);
  if (!sess) {
    process.stderr.write("tap watch: no team tmux session is available; sidecar not spawned, watch remains armed\n");
    return 1;
  }
  const mutex = join(a.bus, "watch", ".spawn.lock");
  mkdirSync(join(a.bus, "watch"), { recursive: true });
  let acquired = false;
  for (let waited = 0; waited <= 100; waited++) {
    try { mkdirSync(mutex); acquired = true; break; } catch { /* held */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  // Never acquired: another `watch on` owns the spawn -- skip ours rather than
  // proceed unsynchronized, and never rmdir a lock we do not hold. The lease stands.
  if (!acquired) {
    process.stderr.write("tap watch: another watch-on call holds the spawn lock; skipping sidecar spawn and keeping the watch armed\n");
    return 1;
  }
  try {
    const arm = armPath(a.bus);
    const winPid = watchWindowPanePid(sess, env);
    if (winPid !== null) {
      // T1 self-heal, ownership-gated: the name `watch` is NOT unique (a user window,
      // or another bus's sidecar in the same session, can share it). Confirm by the
      // recorded watcher_pid before touching anything.
      const rec = readLoose(arm);
      const wpid = fieldValue(rec, "watcher_pid");
      const wcmd = fieldValue(rec, "watcher_command");
      const hb = fieldValue(rec, "heartbeat_at");
      const thresh = staleThreshold(fieldValue(rec, "tick_interval_seconds") || "60");
      if (!wpid || wpid === "0" || winPid !== wpid) {
        process.stderr.write(`tap watch: a watch window in '${sess}' belongs to another process; leaving it untouched and keeping this watch armed; next: tap health\n`);
        return 1;
      }
      // Confirmed ours. Alive AND heartbeat-fresh -> idempotent skip (an empty/zero
      // heartbeat is a just-spawned loop that has not ticked -- don't race-kill it).
      const fresh = !hb || hb === "0" || (/^[0-9]+$/.test(hb) && Number(a.now) - Number(hb) <= thresh);
      if (pidAlive(wpid, wcmd) && fresh) {
        process.stdout.write(`tap watch: sidecar already running in session '${sess}'\n`);
        return 0;
      }
      process.stderr.write(`tap watch: sidecar in '${sess}' stopped responding; respawning it\n`);
      tmux(["kill-window", "-t", `${sess}:watch`], env);
    }
    const worktree = repoRoot(a.registry);
    // The window runs the loop under THE executable the floor check above described --
    // this process's Bun by absolute path, never a bare `bun` for the window's PATH to
    // resolve to some other install.
    const spawned = tmux(["new-window", "-d", "-P", "-F", "#{pane_pid}", "-t", sess, "-n", "watch", "-c", worktree,
      sidecarCommand(a.bus, a.runtimeExecutable, env)], env);
    if (spawned.code !== 0) {
      process.stderr.write(`tap watch: sidecar spawn failed in session '${sess}'\n`);
      return 1;
    }
    const panePid = spawned.stdout.trim();
    if (!/^[0-9]+$/.test(panePid) || panePid === "0") {
      process.stderr.write(`tap watch: sidecar spawn returned no valid process in session '${sess}'\n`);
      return 1;
    }
    try {
      // heartbeat_at is stamped with the spawn time: the record's previous heartbeat (and armed_at) described the
      // loop this one replaces, and would otherwise read as this pid's own silence. The loop overwrites it on its first tick.
      if (leaseSet(arm, ["watcher_pid", panePid, "watcher_command", WATCHER_COMMAND, "heartbeat_at", a.now], env) !== 0) return 1;
    } catch {
      return 1;
    }
    process.stdout.write(`tap watch: sidecar started in session '${sess}'\n`);
    return 0;
  } finally {
    try { rmdirSync(mutex); } catch { /* already gone */ }
  }
}

export interface OffArgs {
  bus: string;
  scripts: string;
  registry: string;
  actor: string;
  force: boolean;
  now: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * `_watch_off_guarded`: called only through the reminder queue owner, which
 * holds its lock through reap. Every refusal and failure is reported on stderr
 * in `tap watch:` shape here and returned as 1; 0 means the lease is gone.
 */
export function offGuarded(a: OffArgs): number {
  const env = a.env ?? process.env;
  const arm = armPath(a.bus);
  const rec = readLoose(arm);
  const armedBy = fieldValue(rec, "armed_by");
  const sess = teamSession(a.registry, armedBy, env);
  const wpid = fieldValue(rec, "watcher_pid"); // captured BEFORE disarm deletes the record
  const actorShown = a.actor || "<unknown>";

  // tap-a4i/W-D3: disarm belongs to the armer. A non-armer (including an unknown
  // actor) must opt into the dead-armer escape with --force; the forced path keeps
  // the old loud notice behavior.
  if (armedBy && a.actor !== armedBy) {
    if (!a.force) {
      process.stderr.write(`tap watch: watch is armed by '${armedBy}'; '${actorShown}' cannot disarm it; next: ask '${armedBy}' to run tap watch off, or pass --force\n`);
      return 1;
    }
    // `set -e` in the incumbent's helper: a fallback that could not publish ended it here, lease kept
    if (noticeOrNotify({ bus: a.bus, scripts: a.scripts, to: armedBy, now: a.now, env,
      reason: `tap watch off was run by '${actorShown}' for a watch armed by '${armedBy}'.`,
      evidence: `actor=${a.actor || "unknown"}` }) !== 0) return 1;
  }

  clearTints(a.bus, env); // untint owned panes BEFORE the arm record (the only tint ownership record) is deleted
  // T9 fail-loud: no unlocked fallback. If the locked delete fails, keep the lease,
  // surface the error, return nonzero -- an armed-but-undismissed watch is visible in
  // `tap health` and recoverable by re-running `tap watch off`; a silent racy delete is neither.
  try {
    disarm(arm);
  } catch (error) {
    process.stderr.write(`tap watch: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write("tap watch: warning: locked disarm failed; lease KEPT to avoid an unlocked racy delete. See 'tap health'; retry 'tap watch off'.\n");
    return 1;
  }
  markResetGenerationReused(a.bus, "watch");
  // Sticky-NOTIFY rule (#3): a pending human escalation is cleared ONLY by `tap watch ack`
  // or an ARMER self-disarm. A non-armer / unknown-actor disarm must NOT erase it.
  if (a.actor && a.actor === armedBy) {
    try { rmSync(notifyPath(a.bus), { force: true }); } catch { /* best-effort */ }
  }
  // Best-effort reap OUR sidecar window now -- the lease deletion already guarantees
  // the loop exits on its next tick. Ownership-gated exactly like the spawn path.
  if (sess && wpid && wpid !== "0") {
    const winPid = watchWindowPanePid(sess, env);
    if (winPid === wpid) tmux(["kill-window", "-t", `${sess}:watch`], env);
  }
  process.stdout.write(`tap watch: disarmed by '${a.actor || "?"}'\n`);
  return 0;
}

export interface RemindersArgs {
  bus: string;
  scripts: string;
  registry: string;
  owner: string;
  noSpawn: boolean;
  now: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * `tap_watch_reminders --by <owner>`: the reminder queue has installed its minimal
 * lease; confirm a runner. An armed supervision loop with a live recorded command
 * and a fresh tick is reused without touching any window (its loop can be a child
 * of the pane shell, so pane-pid equality is not needed when no window will be
 * touched); otherwise ensure the sidecar. 1 when no runner is confirmed.
 */
export function remindersEntry(a: RemindersArgs): number {
  const env = a.env ?? process.env;
  const arm = armPath(a.bus);
  if (!a.owner || !isFile(arm)) return 1; // An armed lease must be a regular file.
  const rec = readLoose(arm);
  const armedAt = fieldValue(rec, "armed_at");
  const pid = fieldValue(rec, "watcher_pid");
  const command = fieldValue(rec, "watcher_command");
  const heartbeat = fieldValue(rec, "heartbeat_at");
  const interval = fieldValue(rec, "tick_interval_seconds");
  const now = Number(a.now);
  if (fieldValue(rec, "mode") === "supervision" && command === WATCHER_COMMAND
    && /^[0-9]+$/.test(heartbeat) && /^[0-9]+$/.test(interval) && Number(heartbeat) > 0 && Number(interval) > 0) {
    const age = now - Number(heartbeat);
    const limit = Math.max(Number(interval) * 3, 180);
    // The arm identity is rechecked before reporting success: `_watch_lease_current`.
    if (age >= 0 && age <= limit && pidAlive(pid, command)
      && isFile(arm) && fieldValue(readLoose(arm), "armed_at") === armedAt) {
      process.stdout.write(`tap remind: rides armed supervision watcher pid ${pid} (armed by ${fieldValue(rec, "armed_by")})\n`);
      return 0;
    }
  }
  return ensureSidecar({ bus: a.bus, scripts: a.scripts, registry: a.registry, armer: fieldValue(rec, "armed_by"), noSpawn: a.noSpawn, now: a.now, env });
}
