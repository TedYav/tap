import { AWK_POSIX_SPACE, HERMES_PREFIX, isOpenCodeCommand, normalizeInputMatch } from "./terminal-text";
export { normalizeInputMatch } from "./terminal-text";
import { rememberDebugFrame } from "./debug-capture";
import { verbose } from "./verbose";
// The tmux courier's plumbing. Everything that touches a real pane goes through
// here, so submit-verify has exactly one place to reason about.
//
// The courier's contract is narrow and worth stating: it verifies that the minted
// id LEFT THE INPUT BAND. It never verifies that a turn began, and no code here
// may imply it did.

import { spawnSync } from "node:child_process";
import { REGISTRY_MAX_BUFFER } from "./spawn";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, rmSync } from "node:fs";
import { homedir, loadavg, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { atomicWrite } from "./fsatomic";
import { acquireNoFollowLock, type HeldLock, SymlinkedLockPath } from "./remind-lock";

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
  rateLimited?: boolean;
}

export { isOpenCodeCommand };

export class ServerUnresponsive extends Error {
  readonly tapErrorClass = "server_unresponsive";
  readonly tapAction = "inspect the server; do not retry a possible effect";
  constructor(socket: string, pid: string, reason = "tmux client deadline expired", readonly tmuxResult?: Run) {
    super(`server_unresponsive socket=${socket} server_pid=${pid}; ${reason}; outcome unknown`);
  }
}

export function tmuxTimeoutMs(args: string[], env: NodeJS.ProcessEnv): number {
  const fallback = args.some(arg => ["capture-pane", "has-session", "display-message", "list-panes", "list-sessions"].includes(arg)) ? 5 : 10;
  const value = Number(env.TAP_TMUX_TIMEOUT_SECONDS ?? fallback);
  return (Number.isFinite(value) && value >= 0.01 && value <= 60 ? value : fallback) * 1000;
}

const IDENTITY_TTL_MS = 100;
const RATE_CAPACITY = 20;
const RATE_PER_MS = 0.1;
// Leave room for the final lock handshake so the externally observed wait
// remains within one second, not one second plus process-start overhead.
const RATE_WAIT_MS = 700;

function cacheRoot(env: NodeJS.ProcessEnv): string {
  return join(env.TAP_INDEX_HOME || join(homedir(), ".tap"), "runtime-cache");
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return resolve(path);
    }
  }
}

/** The physical socket all process-local spellings collapse onto. */
export function physicalSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TAP_TMUX_SOCKET_PATH) return realOrResolved(env.TAP_TMUX_SOCKET_PATH);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  if (env.TAP_TMUX_SOCKET) {
    return realOrResolved(join(env.TMUX_TMPDIR || "/tmp", `tmux-${uid}`, env.TAP_TMUX_SOCKET));
  }
  if (env.TMUX) return realOrResolved(env.TMUX.split(",", 1)[0]!);
  return realOrResolved(join(env.TMUX_TMPDIR || "/tmp", `tmux-${uid}`, "default"));
}

function socketKey(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

export function socketFingerprint(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

export interface RateClaim {
  ok: boolean;
  retryAfterMs: number;
}

/** One cross-process token bucket per physical socket. */
export function claimTmuxStart(
  socket: string,
  nowMs = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
  waitMs = RATE_WAIT_MS,
): RateClaim {
  const root = cacheRoot(env);
  mkdirSync(root, { recursive: true });
  const statePath = join(root, `tmux-rate-${socketKey(realOrResolved(socket))}.json`);
  // Lock the sidecar with flock(2) on a descriptor this process opened, and
  // wait for it within the same budget reserveTmuxClient enforces. The spawned
  // lockf helper this replaces held the lock 26-31 ms per tmux call, which
  // capped a machine near 30 calls/s; under team-wide load (2026-09-20,
  // ~30 seats) claimers with a full bucket timed out and every send refused as
  // generation_unverifiable (tap-p0ww8). An in-process hold is a read and an
  // atomic write. flock(2) is the primitive lockf uses, so a holder from an
  // older checkout still excludes this one on the same sidecar.
  let lock: HeldLock | null;
  try {
    lock = acquireNoFollowLock(`${statePath}.lock`, waitMs);
  } catch (error) {
    if (!(error instanceof SymlinkedLockPath)) throw error;
    verbose("tmux_rate_lock_symlinked", { statePath }, env);
    return { ok: false, retryAfterMs: 10 };
  }
  if (!lock) {
    verbose("tmux_rate_lock_refused", { statePath }, env);
    return { ok: false, retryAfterMs: 10 };
  }
  try {
    let tokens = RATE_CAPACITY;
    let at = nowMs;
    try {
      const state = JSON.parse(readFileSync(statePath, "utf8")) as { tokens?: unknown; at?: unknown };
      if (typeof state.tokens === "number" && Number.isFinite(state.tokens) &&
          typeof state.at === "number" && Number.isFinite(state.at)) {
        tokens = Math.min(RATE_CAPACITY, Math.max(0, state.tokens) + Math.max(0, nowMs - state.at) * RATE_PER_MS);
        at = Math.max(state.at, nowMs);
      }
    } catch {
      // Missing/corrupt state starts full; the sidecar still serializes repair.
    }
    if (tokens < 1) {
      verbose("tmux_rate_tokens_exhausted", { tokens, at }, env);
      atomicWrite(statePath, `${JSON.stringify({ tokens, at })}\n`);
      return { ok: false, retryAfterMs: Math.max(1, Math.ceil((1 - tokens) / RATE_PER_MS)) };
    }
    atomicWrite(statePath, `${JSON.stringify({ tokens: tokens - 1, at })}\n`);
    return { ok: true, retryAfterMs: 0 };
  } finally {
    lock.release();
  }
}

function reserveTmuxClient(env: NodeJS.ProcessEnv): boolean {
  const socket = physicalSocketPath(env);
  const deadline = Date.now() + RATE_WAIT_MS;
  for (;;) {
    const now = Date.now();
    const claim = claimTmuxStart(socket, now, env, Math.max(0, deadline - now));
    if (claim.ok) return true;
    if (Date.now() + claim.retryAfterMs > deadline) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, claim.retryAfterMs);
  }
}

/**
 * THE SOCKET SEAM (tap-nlo51). Every tmux invocation in this file goes through
 * here, and here is the only place that decides which SERVER it reaches.
 *
 * Before this existed, `spawnSync("tmux", args)` issued a bare command with no
 * -L/-S and no TMUX scrub, so under $TMUX — which is every process launched
 * inside a tmux pane, i.e. every real seat — it bound the DEFAULT server. On
 * 2026-08-23 that class killed the team's server twice; the -vv log of the
 * crash shows this file's own observePane clients hitting the default server
 * because a PATH shim meant to redirect them was never on their PATH.
 *
 * Today these calls are read-only and would only MISREAD. The next write-shaped
 * verb added to this path (kill / respawn / new-session / set) repeats the
 * team-exit class, which is why the seam goes in before that verb does rather
 * than after.
 *
 * TAP_TMUX_SOCKET_PATH (-S, a socket path) or TAP_TMUX_SOCKET (-L, a socket
 * name) pins the server explicitly. TMUX and TMUX_PANE are scrubbed from the
 * child environment ONLY when such a pin exists — and the first version of this
 * header said "unconditionally", which was both the wrong rule and, for a
 * while, the shipped one. The partner reviewer reproduced the cost: inside a private
 * custom server with no override, bare tmux CORRECTLY inherits $TMUX, and
 * scrubbing it with nothing to replace it redirected the child to the DEFAULT
 * server — observePane returned null for a live pane. Removing ambient
 * authority is only safe when you supply the authority that replaces it.
 */
function socketArgv(args: string[], env: NodeJS.ProcessEnv): { argv: string[]; childEnv: NodeJS.ProcessEnv; scrub: boolean } {
  // TAP_TMUX_SOCKET_PATH is a socket PATH (-S); TAP_TMUX_SOCKET is a socket
  // NAME (-L). They are different tmux flags and conflating them sends a caller
  // who has a path to a server named after it.
  const socketPath = env.TAP_TMUX_SOCKET_PATH;
  const socketName = env.TAP_TMUX_SOCKET;

  let argv = args;
  let scrub = false;

  if (socketPath) {
    argv = ["-S", socketPath, ...args];
    scrub = true;
  } else if (socketName) {
    argv = ["-L", socketName, ...args];
    scrub = true;
  }

  const childEnv = { ...env };
  if (scrub) {
    // Scrub ONLY when we have pinned a server ourselves. An earlier version
    // deleted TMUX unconditionally, which broke the ordinary case it was
    // supposed to leave alone: inside a CUSTOM server with no override, bare
    // tmux correctly inherits $TMUX and reaches that server, and removing the
    // variable redirected the child to the DEFAULT one — so observePane
    // returned null for a live pane. Scrubbing without pinning does not remove
    // ambient authority; it replaces the caller's server with a different
    // ambient one, which is strictly worse.
    delete childEnv.TMUX;
    delete childEnv.TMUX_PANE;
  }
  return { argv, childEnv, scrub };
}

function runTmux(args: string[], env: NodeJS.ProcessEnv, maxBuffer?: number, deadlineMs?: number): Run {
  const { argv, childEnv, scrub } = socketArgv(args, env);
  verbose("command", { argv: ["tmux", ...argv], cwd: process.cwd(),
    socket: env.TAP_TMUX_SOCKET_PATH || env.TAP_TMUX_SOCKET || env.TMUX || "default",
    env_keys: Object.keys(childEnv).filter(k => k.startsWith("TAP_") || k === "TMUX" || k === "TMUX_PANE").sort() }, env);
  const r = spawnSync("tmux", argv, {
    encoding: "utf8", env: childEnv,
    // A caller's remaining budget narrows the env-derived bound.
    timeout: deadlineMs === undefined ? tmuxTimeoutMs(args, env) : Math.max(1, Math.floor(Math.min(tmuxTimeoutMs(args, env), deadlineMs))),
    killSignal: "SIGKILL",
    maxBuffer,
  });
  verbose("command_exit", { status: r.status, stderr: r.stderr, error: r.error?.message }, env);
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    // Throw through the courier before any fallback/retry; its finally releases custody.
    throw new ServerUnresponsive(physicalSocketPath(env), scrub ? "unknown" : (env.TMUX?.split(",")[1] || "unknown"),
      "tmux client deadline expired", { code: 124, stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
  }
  if (r.status !== 0 && r.stderr?.includes("fork failed: Device not configured")) {
    throw new ServerUnresponsive(physicalSocketPath(env), scrub ? "unknown" : (env.TMUX?.split(",")[1] || "unknown"),
      `tmux fork failed: Device not configured; load1m=${loadavg()[0]!.toFixed(2)}`,
      { code: r.status ?? 1, stdout: "", stderr: r.stderr ?? "" });
  }
  if (r.status === 0 && args[0] === "capture-pane") rememberDebugFrame(r.stdout ?? "");
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function tmux(args: string[], env: NodeJS.ProcessEnv = process.env): Run {
  if (!reserveTmuxClient(env)) {
    verbose("tmux_rate_limited", { argv: ["tmux", ...args] }, env);
    return { code: 1, stdout: "", stderr: "tmux client rate limited", rateLimited: true };
  }
  return runTmux(args, env);
}

/**
 * A client-moving effect (switch-client): bounded by the same deadline as every
 * other client, never retried, and outside courier submit-rate serialization.
 * A deadline still throws ServerUnresponsive; the caller reports it.
 */
export function tmuxClientEffect(args: string[], env: NodeJS.ProcessEnv = process.env): Run {
  return runTmux(args, env);
}

/**
 * An attached client (attach-session): it lives as long as the human's
 * terminal, so it runs unbounded on inherited stdio. It rides the same socket
 * seam; an explicit -S/-L in `args` survives when no TAP pin exists.
 */
export function tmuxAttachClient(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const { argv, childEnv } = socketArgv(args, env);
  verbose("command", { argv: ["tmux", ...argv], cwd: process.cwd(), interactive: true }, env);
  return spawnSync("tmux", argv, { stdio: "inherit", env: childEnv }).status ?? 1;
}

/** Read-only observation without courier submit-rate serialization. */
export function tmuxReadOnly(args: string[], env: NodeJS.ProcessEnv = process.env, maxBuffer?: number, deadlineMs?: number): Run {
  return runTmux(args, env, maxBuffer, deadlineMs);
}

/**
 * The session-name namespace `--hard` deletes parked rows against, read in
 * process — the twin of the launcher's `tmux_sessions_for_namespace()`
 * (launcher.py), whose three-way classification this preserves exactly:
 *
 *   exit 0              → the namespace: one live session per nonempty line,
 *                         an EMPTY set being a real answer.
 *   recognized no-server → positive proof of an empty namespace. Only the two
 *                         exact shapes the incumbent recognizes count —
 *                         `no server running on .+` and `error connecting to
 *                         .+ (No such file or directory)` — fullmatch on the
 *                         trimmed stderr, multi-line failing like python's
 *                         non-DOTALL fullmatch.
 *   everything else      → unobservable: a missing binary, `no sessions`,
 *                         connection failures, rate-limit text, anything
 *                         opaque. NOT deletion authority. The same verdict
 *                         covers the exceptional paths where the tmux client
 *                         itself cannot answer — a deadline-expired or
 *                         fork-failing client throws ServerUnresponsive, and
 *                         the launcher's twin turns its missing binary into
 *                         exactly such an unobservable namespace.
 *
 * That narrowness is deliberate authority, not laziness: launch.ts's
 * session-death check and seat-updown's failure set are broader, and neither
 * may leak in here — a parked row's life hangs on the difference. No retry,
 * no cache, no config: one read, classified by the incumbent's rules.
 */
export type SessionNamespace = { observable: true; names: Set<string> } | { observable: false };

export const NO_SERVER_ON = /^(?:no server running on .+|error connecting to .+ \(No such file or directory\))$/;

export function tmuxSessionNamespace(env: NodeJS.ProcessEnv = process.env): SessionNamespace {
  let r: ReturnType<typeof tmuxReadOnly>;
  try {
    // The retired namespace child ran under REGISTRY_MAX_BUFFER; a live fleet's
    // `list-sessions` answer can exceed Bun's ~1MB default, and truncation
    // would turn a real answer into an unobservable one. Same bound, new carrier.
    r = tmuxReadOnly(["list-sessions", "-F", "#S"], env, REGISTRY_MAX_BUFFER);
  } catch (error) {
    // A client that cannot produce an answer at all is the twin's missing
    // binary: LauncherError, an unobservable namespace. Only that class is
    // converted here; unrelated errors still propagate.
    if (error instanceof ServerUnresponsive) return { observable: false };
    throw error;
  }
  if (r.code === 0) {
    return { observable: true, names: new Set(r.stdout.split("\n").filter(Boolean)) };
  }
  if (NO_SERVER_ON.test(r.stderr.trim())) {
    return { observable: true, names: new Set() };
  }
  return { observable: false };
}

/**
 * `tap_exit_copy_mode`'s one pane write (lib.sh:9038): `send-keys -X cancel`.
 * The verdict is the caller's — an rc here only says the key went out (or the
 * client budget refused), never whether the pane left copy mode.
 */
export function cancelCopyMode(target: string, env: NodeJS.ProcessEnv = process.env): "ok" | "rate_limited" | "failed" {
  const r = tmux(["send-keys", "-t", target, "-X", "cancel"], env);
  if (r.rateLimited) return "rate_limited";
  return r.code === 0 ? "ok" : "failed";
}

/** Sleep without spinning the event loop — the courier is a short-lived CLI.
 * TAP_TUI_SETTLE_SCALE is honored here, the one production caller of this
 * function (`REAL_EFFECTS.settle`). Injected PaneEffects keep their own settle.
 */
let settleScaleNoted = false;
let settleScaleWarned = false;

export function settle(seconds: number): void {
  let d = seconds;
  const raw = process.env.TAP_TUI_SETTLE_SCALE;
  const s = raw === undefined || raw === "" ? "1" : raw;
  if (s !== "1" && s !== "1.0") {
    let scaled: number | null = null;
    if (s !== "." && /^[0-9.]+$/.test(s) && (s.match(/\./g) ?? []).length <= 1) {
      const n = Number(s);
      if (n >= 0.01 && n <= 10) scaled = Number((seconds * n).toFixed(3));
    }
    if (scaled !== null) {
      if (!settleScaleNoted) {
        process.stderr.write(`tap: TUI settle scale ${s} active (mock-smoke knob; production runs unset/1)\n`);
        settleScaleNoted = true;
      }
      d = scaled;
    } else if (!settleScaleWarned) {
      process.stderr.write(`tap: invalid TAP_TUI_SETTLE_SCALE='${s}' (need a decimal in [0.01, 10]) -> running unscaled\n`);
      settleScaleWarned = true;
    }
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, d * 1000);
}

export interface PaneObservation {
  paneId: string;
  session: string;
  serverEpoch: string;
  panePid: string;
  currentCommand: string;
}

export type PaneObservationResult =
  | { status: "ok" | "pane_dead"; observation: PaneObservation }
  | { status: "pane_gone" }
  | { status: "unobservable"; reason: string }
  | { status: "rate_limited" };

interface CachedIdentity {
  raw: string;
  fingerprint: string;
  observedAt: number;
}

/**
 * Seed the server-identity cache from a record that already carried
 * `pid:start_time` (the extended caller-pane identity record). The value is
 * the server's own answer, observed atomically with the pane facts, so later
 * `serverIdentity()` callers hit the cache instead of re-probing within the
 * TTL. `before` is the socket fingerprint captured BEFORE the record's
 * display-message ran: a server rebirth between probe and seed would pair the
 * old server's epoch with the new socket's fingerprint, so a mismatch skips
 * the seed and the next caller probes. A malformed raw is ignored; a contended
 * or failing seed is only a missed cache write.
 */
export function seedServerIdentity(env: NodeJS.ProcessEnv, raw: string, before: string, readOnly = false): void {
  if (readOnly) return;
  if (!/^[0-9]+:[0-9]+$/.test(raw)) return;
  const socket = physicalSocketPath(env);
  const fingerprint = socketFingerprint(socket);
  if (fingerprint !== before) return;
  const root = cacheRoot(env);
  try {
    mkdirSync(root, { recursive: true });
  } catch {
    return;
  }
  const cachePath = join(root, `tmux-identity-${socketKey(socket)}.json`);
  let lock: HeldLock | null;
  try {
    lock = acquireNoFollowLock(`${cachePath}.lock`, 0);
  } catch {
    return;
  }
  if (!lock) return;
  try {
    const identity = { raw, fingerprint, observedAt: Date.now() };
    atomicWrite(cachePath, `${JSON.stringify(identity)}\n`);
  } catch {
    // A failed seed is only a missed cache write; the next caller probes.
  } finally {
    lock.release();
  }
}

function serverIdentity(env: NodeJS.ProcessEnv): CachedIdentity | "rate_limited" | null {
  const socket = physicalSocketPath(env);
  const root = cacheRoot(env);
  mkdirSync(root, { recursive: true });
  const cachePath = join(root, `tmux-identity-${socketKey(socket)}.json`);
  // The same in-process flock as the rate sidecar: this lock is taken on every
  // pane observation, and its fd is close-on-exec, so the probe child below
  // never inherits the hold.
  let lock: HeldLock | null;
  try {
    lock = acquireNoFollowLock(`${cachePath}.lock`, RATE_WAIT_MS - 250);
  } catch (error) {
    if (!(error instanceof SymlinkedLockPath)) throw error;
    return null;
  }
  if (!lock) return "rate_limited";
  try {
    const now = Date.now();
    const fingerprint = socketFingerprint(socket);
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8")) as CachedIdentity;
      if (cached.fingerprint === fingerprint && now - cached.observedAt <= IDENTITY_TTL_MS &&
          typeof cached.raw === "string") return cached;
    } catch {
      // A miss or interrupted cache write is simply a fresh probe.
    }
    const r = tmux(["display-message", "-p", "#{pid}:#{start_time}"], env);
    if (r.rateLimited) return "rate_limited";
    const raw = r.stdout.trim();
    if (r.code !== 0 || !/^[0-9]+:[0-9]+$/.test(raw)) return null;
    const after = socketFingerprint(socket);
    if (after !== fingerprint) return null;
    const identity = { raw, fingerprint, observedAt: Date.now() };
    atomicWrite(cachePath, `${JSON.stringify(identity)}\n`);
    return identity;
  } finally {
    lock.release();
  }
}

/**
 * Exactly one record, exactly five tab fields: pane id, session, pane pid,
 * current command, and dead state. Extra fields or a second record are malformed, not a
 * prefix to keep. Separate probes would let a server rebirth land between
 * them, so a row can be stamped with one server's ids and another's
 * generation. A retained dead pane carries identity without claiming absence.
 */
export function observePaneResult(
  target: string,
  env: NodeJS.ProcessEnv = process.env,
): PaneObservationResult {
  const identity = serverIdentity(env);
  if (identity === "rate_limited") return { status: "rate_limited" };
  if (!identity) return { status: "unobservable", reason: "tmux server identity is unavailable" };
  const r = tmux(["display-message", "-p", "-t", target,
    "#{pane_id}\t#{session_name}\t#{pane_pid}\t#{pane_current_command}\t#{pane_dead}"], env);
  if (r.rateLimited) return { status: "rate_limited" };
  if (socketFingerprint(physicalSocketPath(env)) !== identity.fingerprint) {
    return { status: "unobservable", reason: "tmux socket changed during pane observation" };
  }
  // tmux can exit 0 for a gone target, so the OUTPUT decides, not the code.
  // A missing target can leave the format's four literal tab separators.
  // Accept only that exact empty expansion, never arbitrary whitespace.
  const emptyExpansion = /^(?:\t{4})?\n?$/.test(r.stdout);
  if (r.code !== 0) {
    return emptyExpansion && /^(?:can't find (?:pane|window|session)|no such pane)(?::| )/.test(r.stderr.trim())
      ? { status: "pane_gone" }
      : { status: "unobservable", reason: `pane query failed for '${target}': ${r.stderr.trim()}` };
  }
  if (emptyExpansion) return { status: "pane_gone" };
  const parsed = parsePaneDisplay(r.stdout);
  if (!parsed) return { status: "unobservable", reason: `malformed pane identity for '${target}'` };
  return {
    status: parsed.dead ? "pane_dead" : "ok",
    observation: {
      paneId: parsed.paneId,
      session: parsed.session,
      serverEpoch: serverEpochFromRaw(identity.raw, env),
      panePid: parsed.panePid,
      currentCommand: parsed.currentCommand,
    },
  };
}

/** Exactly one record, exactly five tab fields. At most one optional terminal newline. */
function parsePaneDisplay(stdout: string): { paneId: string; session: string; panePid: string; currentCommand: string; dead: boolean } | null {
  const record = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (record.includes("\n")) return null;
  const fields = record.split("\t");
  if (fields.length !== 5) return null;
  const [paneId, session, panePid, currentCommand, dead] = fields;
  if (!paneId || !/^%[0-9]+$/.test(paneId) || !session || panePid === undefined) return null;
  // tmux 3.8 omits the PID after exit; retained pane identity still owns cleanup.
  if (!/^[0-9]+$/.test(panePid) && !(dead === "1" && panePid === "")) return null;
  if (dead !== "0" && dead !== "1") return null;
  return { paneId, session, panePid, currentCommand: currentCommand ?? "", dead: dead === "1" };
}

export function observePane(target: string): PaneObservation | null {
  const result = observePaneResult(target);
  return result.status === "ok" ? result.observation : null;
}

/**
 * "<pid>:<start_time>" -> "srv:<pid>:<start>". Empty when ungrammatical: an
 * unknown generation disables the epoch guard rather than voiding anything.
 */
export function serverEpochFromRaw(raw: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.TAP_SERVER_EPOCH !== undefined) return env.TAP_SERVER_EPOCH;
  if (!raw || !/^[0-9]+:[0-9]+$/.test(raw)) return "";
  return `srv:${raw}`;
}

/**
 * The boot probes are on the point-of-effect guard's path, which holds recovery's
 * pane mutex, so they are bounded like every other observation there. An
 * unreadable boot id already fails closed — `classifyRow` answers
 * `boot_id_unobservable` — so a timeout costs a refusal, never an authorization.
 */
const BOOT_PROBE_TIMEOUT_MS = 5_000;

/**
 * One probe's bound, resolved AT THE SPAWN: a caller's remaining-time callback
 * is re-read before every probe and narrows the cap, never widens it. A spent
 * budget refuses here rather than starting a spawn it cannot bound.
 */
function bootProbeBound(timeout: number | (() => number)): number {
  const t = typeof timeout === "function" ? Math.min(BOOT_PROBE_TIMEOUT_MS, timeout()) : timeout;
  if (!(t > 0)) throw new DeadlineExhausted();
  return Math.max(1, Math.floor(t));
}

/**
 * A caller's whole-operation budget ran out before a spawn could start. Thrown
 * by a `remainingMs` callback (or a boot probe reading one) and owned by the
 * caller that set the budget: it refuses, it never authorizes.
 */
export class DeadlineExhausted extends Error {
  constructor() { super("deadline exhausted before spawn"); }
}

/** Stable boot-session identity, bounding pid reuse across reboots. */
export function bootId(
  env: NodeJS.ProcessEnv = process.env,
  procStatPath = "/proc/stat",
  sysctl = "sysctl",
  timeout: number | (() => number) = BOOT_PROBE_TIMEOUT_MS,
): string {
  if (env.TAP_BOOT_ID !== undefined) return env.TAP_BOOT_ID;
  // `env` reaches the child so a caller's environment (test PATH stubs
  // included) selects the binary, exactly as the tmux spawns do.
  const r = spawnSync(sysctl, ["-n", "kern.bootsessionuuid"], { encoding: "utf8", timeout: bootProbeBound(timeout), killSignal: "SIGKILL", env });
  const uuid = (r.stdout ?? "").trim().toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) {
    return `bootuuid:${uuid}`;
  }
  const bt = spawnSync(sysctl, ["-n", "kern.boottime"], { encoding: "utf8", timeout: bootProbeBound(timeout), killSignal: "SIGKILL", env });
  const sec = /\{ sec = (\d+)/.exec(bt.stdout ?? "")?.[1];
  if (sec) return `boot:${sec}`;
  try {
    const linux = /^btime ([0-9]+)$/m.exec(readFileSync(procStatPath, "utf8"))?.[1];
    return linux ? `boot:${linux}` : "";
  } catch {
    return "";
  }
}

/**
 * The host's LEGACY boot epoch (`boot:<sec>`), or "" when unobservable.
 *
 * Twins `tap_boot_epoch_id` (lib.sh:7068). It exists because a row stamped
 * before the uuid oracle carries `boot:<sec>` while the host now reports
 * `bootuuid:<uuid>` — two spellings of the same fact, comparable only through
 * this second reading.
 */
export function legacyBootId(env: NodeJS.ProcessEnv = process.env, procStatPath = "/proc/stat", timeout: number | (() => number) = BOOT_PROBE_TIMEOUT_MS): string {
  if (env.TAP_BOOT_ID_LEGACY !== undefined) return env.TAP_BOOT_ID_LEGACY;
  if (/^boot:[0-9]+$/.test(env.TAP_BOOT_ID ?? "")) return env.TAP_BOOT_ID!;
  const sysctl = spawnSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: bootProbeBound(timeout), killSignal: "SIGKILL", env });
  // "{ sec = 178…, usec = … }" — anchored on the brace so the "sec" inside
  // "usec" cannot match instead.
  const sec = /\{ sec = ([0-9]+)/.exec(sysctl.stdout ?? "")?.[1];
  if (sec) return `boot:${sec}`;
  try {
    const linux = /^btime ([0-9]+)$/m.exec(readFileSync(procStatPath, "utf8"))?.[1];
    return linux ? `boot:${linux}` : "";
  } catch {
    return "";
  }
}

/**
 * How does a recorded boot id RELATE to the current one — three answers, not two.
 *
 * Ported from the retired lib.sh `tap_boot_ids_match`, and the tolerance is the point:
 * exact ids stay exact, while a legacy `boot:<sec>` row is accepted when its
 * epoch is within five seconds of the host's independently observed legacy
 * epoch. A cross-scheme pair is therefore COMPARABLE where the secondary oracle
 * answers — treating it as unknowable makes a prior-boot fence unreclaimable
 * forever on a host that has since moved to uuid identity.
 *
 * WHY THREE STATES. A boolean collapsed "the boots differ" with "I could not
 * relate them", and `fenceOwnerLive` mapped both to PROVED STALE — telling an
 * operator that a retry completes the cut on a fence whose owner may be alive.
 * Every OTHER unreadable factor in that guard fails closed to LIVE (missing
 * stamp field, unreadable current boot, an unrunnable kill, an unreadable start
 * fingerprint); the boot factor was the only one that failed open, and the only
 * one reached through a helper. Found by the partner reviewer and a reviewer on
 * the whole-diff panel; the same collapse exists in the bash and reset-acquire
 * copies and is corrected with this one.
 *
 * `unknown` is returned for BOTH cross-scheme directions — a legacy row whose
 * oracle cannot answer, and a uuid row against a legacy current — because
 * neither can be related and a fix for one direction only is half a fix.
 *
 * The fixture clause is load-bearing: an explicit TAP_BOOT_ID without
 * TAP_BOOT_ID_LEGACY keeps exact comparison, so a reboot test does not quietly
 * become a tolerance test.
 */
export type BootRelation = "match" | "mismatch" | "unknown";

// DIGITS ARE NOT AN EPOCH. A digit string too long to represent is
// UNREADABLE, not a fingerprint that necessarily moved: `Number()` yields
// Infinity, bash silently overflows to a plausible finite number, and python
// carries it exactly -- three implementations, three different wrong answers,
// each a DEFINITE mismatch that authorizes reclaim. The bound is a DIGIT COUNT
// rather than a range check because bash does not report its overflow, so
// "did my arithmetic succeed" is answerable in two languages and not the third;
// string length is decided identically in all three. 15 digits keeps every
// accepted value below 2^53, exact in a JS double, a bash 64-bit int and a
// python int at once. It bounds representability, not plausible dates.
// CANONICAL OR UNREADABLE. A leading zero is not a smaller number -- it is
// a rendering no writer here emits, and each language disagrees about what it
// means. The boot factor is compared NUMERICALLY, so `boot:01785910738` reads as
// 1785910738 in JS and python and enters OCTAL arithmetic in the shell, where 8
// and 9 are not digits: bash errors, resolves to "differ", and RECLAIMS a fence
// the other two hold. That is the only direction of divergence in this predicate
// where the shell takes a fence the others protect. `0` alone stays readable --
// the string "0" has compared since the numeric row landed.
const LEGACY_STAMP = /^boot:(0|[1-9][0-9]{0,14})$/;
/** The exact-id shape `tap_boot_id` emits: lowercase hex in 8-4-4-4-12 groups. */
const EXACT_STAMP = /^bootuuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True only for a stamp in one of the two shapes this system writes. */
function stampReadable(stamp: string): boolean {
  return LEGACY_STAMP.test(stamp) || EXACT_STAMP.test(stamp);
}

export function bootIdsMatch(
  row: string,
  current: string,
  env: NodeJS.ProcessEnv = process.env,
): BootRelation {
  if (!row || !current) return "unknown";
  // SHAPE IS DECIDED FIRST, INCLUDING FOR AN EQUAL PAIR. An earlier version
  // checked equality first, reasoning that the same stamp came from the same
  // boot whatever its format. That is wrong about what MATCH costs: MATCH does
  // not resolve to LIVE, it FALLS THROUGH to the pid and fingerprint factors
  // (see reset.ts), so two equal unparseable stamps waved the boot factor
  // through and a later dead pid could then authorize a reclaim the boot
  // relation never licensed. Unknown short-circuits to LIVE; match does not.
  // (partner review found the composition; I had filed it P2 on the
  // argument that match was safe by polarity, having read the return value
  // instead of its caller.)
  if (!stampReadable(row) || !stampReadable(current)) return "unknown";
  if (row === current) return "match";
  if (env.TAP_BOOT_ID !== undefined && env.TAP_BOOT_ID_LEGACY === undefined) return "mismatch";
  const rowSec = LEGACY_STAMP.exec(row)?.[1];
  if (rowSec === undefined) {
    // The row is an exact id. Against another exact id, differing means the
    // boots differ. Against a legacy epoch there is nothing to relate.
    return LEGACY_STAMP.test(current) ? "unknown" : "mismatch";
  }
  const currentSec = LEGACY_STAMP.exec(legacyBootId(env))?.[1];
  if (currentSec === undefined) return "unknown";
  return Math.abs(Number(rowSec) - Number(currentSec)) <= 5 ? "match" : "mismatch";
}

export function paneCurrentCommand(target: string): string {
  const r = tmux(["display-message", "-p", "-t", target, "#{pane_current_command}"]);
  return r.code === 0 ? r.stdout.trim() : "";
}

export function paneCurrentPath(target: string): string {
  const r = tmux(["display-message", "-p", "-t", target, "#{pane_current_path}"]);
  return r.code === 0 ? r.stdout.trim() : "";
}

/** The pane address for a pane id — the registry `pane` field is always an address. */
export function paneAddress(paneId: string): string {
  const r = tmux(["display-message", "-p", "-t", paneId, "#{session_name}:#{window_index}.#{pane_index}"]);
  return r.code === 0 ? r.stdout.trim() : "";
}

/** Per-harness idle prompt glyph. The input band is anchored on this line. */
export function promptGlyphRe(paneCmd: string): string {
  if (paneCmd.startsWith("cursor")) return "[›❯→]";
  if (paneCmd.startsWith("codex")) return "[›❯»]";
  if (paneCmd.startsWith("agy")) return ">";
  return "[›❯]";
}

export function promptLineRe(paneCmd: string): RegExp {
  if (paneCmd.startsWith("hermes")) return new RegExp(`^[ \\t]*${HERMES_PREFIX}[›❯]`);
  return new RegExp(`^[ \\t]*${promptGlyphRe(paneCmd)}`);
}

/**
 * The same row, with the leading class **awk** implements — for the readers
 * whose oracle is the awk selector rather than a previously ported module.
 *
 * The incumbent `tap_composer_input` chose its region row with
 * `awk '$0 ~ "^[[:space:] ]*GLYPH"'`, and macOS awk's `[[:space:]]` includes
 * U+00A0: a `\u00a0❯ draft` row WAS the band and read as `draft`, where
 * `^[ \t]*` calls it absent geometry — status 3, which is the direction
 * `tap_submit_verify`'s draft-clear types over. Not the sed class either: that
 * one also accepts U+1680, U+2000-U+200A, U+202F, U+205F and U+3000, which awk
 * rejects, so widening to it would break parity the other way. The measured
 * table for all three classes is in `terminal-text.ts`.
 *
 * Deliberately NOT applied to `promptLineRe` itself. The frame readers in
 * `submit-frame.ts` reach it too, and THEIR incumbent at this base is the
 * previously ported Bun module with its ASCII class — measured: widening it
 * moved 10 of 1593 differential cases on the codex branch. `observeInputRegion`
 * is the one native region reader whose incumbent was awk, so it takes this
 * selector (tap-6zzsk); the frame readers keep `promptLineRe`.
 */
export function promptRowReAwk(paneCmd: string): RegExp {
  const S = AWK_POSIX_SPACE;
  if (paneCmd.startsWith("hermes")) return new RegExp(`^[${S}]*${HERMES_PREFIX}[›❯]`);
  return new RegExp(`^[${S}]*${promptGlyphRe(paneCmd)}`);
}

/**
 * The ACTIVE input region: the LAST prompt line and everything after it.
 *
 * The last, not the first — and this is the whole correctness of the function.
 * A pane's capture contains its transcript, which holds every EARLIER prompt and
 * every previously submitted line. Anchoring on the first match returns the
 * entire scrollback, so a sentinel that was submitted minutes ago still reads as
 * pending input: the clear-verification loop then never sees the band go quiet
 * and presses Enter again and again. Observed as five spurious blank submissions
 * per send against the reference's one.
 */
export type InputRegionObservation =
  | { status: "captured"; region: string }
  | { status: "no_prompt" }
  | { status: "unobservable"; reason: string }
  | { status: "rate_limited"; reason: string };

/**
 * Last-prompt region without collapsing capture failure or a missing glyph
 * into an empty string. Boolean inputHasId still exists for the PaneEffects
 * fake seam; production land/clear uses this typed observation.
 */
/** Single native capture owner. Joined capture preserves soft-wrapped tokens;
 * OpenCode input geometry opts out because one renderer can mark every physical
 * row wrapped and collapse the whole pane into one line. Composer-scoped id
 * matching instead removes whitespace after parsing the physical rows. */
export function capturePane(target: string, escaped = false, joined = true): Run {
  return tmux(["capture-pane", ...(joined ? ["-J"] : []), "-t", target, "-p", ...(escaped ? ["-e"] : [])]);
}

export function observeInputRegion(target: string, paneCmd: string): InputRegionObservation {
  const r = capturePane(target, false, !isOpenCodeCommand(paneCmd));
  if (r.rateLimited) {
    return { status: "rate_limited", reason: "tmux client budget exhausted before pane input could be inspected" };
  }
  if (r.code !== 0) {
    return { status: "unobservable", reason: `capture-pane failed for '${target}'` };
  }
  // `tap_inputregion` chose this row with awk's `[[:space:] ]`, so `promptRowReAwk`
  // (tap-6zzsk): NBSP/VT/FF/CR pad a row awk accepted, U+2000/U+3000 did not. Its
  // opencode and agy arms were box readers, not the awk selector, so those two keep
  // the ASCII-blank `promptLineRe` this function already used.
  const re = isOpenCodeCommand(paneCmd) || paneCmd.startsWith("agy") ? promptLineRe(paneCmd) : promptRowReAwk(paneCmd);
  const lines = r.stdout.split("\n");
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (re.test(lines[i]!)) { start = i; break; }
  }
  if (start < 0) return { status: "no_prompt" };
  return { status: "captured", region: lines.slice(start).join("\n") };
}

export function inputRegion(target: string, paneCmd: string): string {
  const observed = observeInputRegion(target, paneCmd);
  return observed.status === "captured" ? observed.region : "";
}

/** Whitespace-insensitive match: a TUI wraps and re-pads the band as it redraws. */

export function inputHasId(target: string, paneCmd: string, id: string): boolean {
  return normalizeInputMatch(inputRegion(target, paneCmd)).includes(normalizeInputMatch(id));
}

export type PasteAuthority = () => boolean | "rate_limited";

/**
 * tmux's argv parser treats a FINAL `;` on a send-keys argument as a command
 * separator: it strips the byte, exits 0 and says nothing, so the byte never
 * reaches the pane (tap-k59hc — a compact focus chunk that ended on `;` at its
 * 250-byte boundary was delivered one byte short, and the per-chunk contiguity
 * check correctly refused it). Escaping that final `;` as `\;` makes tmux
 * rewrite it back to a literal `;`; only the final `\;` is rewritten, so the
 * transform is exact for every payload, including one already ending `\;`.
 */
export function literalKeysArg(text: string): string {
  return text.endsWith(";") ? `${text.slice(0, -1)}\\;` : text;
}

/** Literal tmux keys still reach TUI shortcuts. OpenCode needs bracketed paste for data containing !. */
export function injectText(target: string, text: string, bracketed = false, beforePaste?: PasteAuthority, admitPaste?: () => boolean): boolean | "rate_limited" {
  if (bracketed) return pasteOpenCodeText(target, text, pasteText, beforePaste, admitPaste);
  const r = tmux(["send-keys", "-t", target, "-l", "--", literalKeysArg(text)]);
  return r.rateLimited ? "rate_limited" : r.code === 0;
}

/** Keep OpenCode's data visible: 1.18.31 summarizes >150 characters or >=3 lines.
 * Each bounded paste bypasses key shortcuts without hiding the wire we verify.
 * Stop at the first refused effect; the caller already owns possible-effect custody.
 */
export function pasteOpenCodeText(target: string, text: string, paste: typeof pasteText = pasteText,
  beforePaste: PasteAuthority = () => false, admitPaste?: () => boolean): boolean | "rate_limited" {
  let chunk = "", pasted = false;
  const flush = (): boolean | "rate_limited" => {
    try {
      const permission = beforePaste();
      if (permission !== true) return pasted ? false : permission;
      const result = paste(target, chunk, beforePaste, admitPaste);
      chunk = "";
      // false is a possibly partial injection to callers; rate_limited is pre-effect.
      if (result !== true) return pasted ? false : result;
      pasted = true;
      return true;
    } catch (error) {
      if (pasted) return false;
      throw error;
    }
  };
  // Keep surrogate pairs and CRLF together; OpenCode normalizes CRLF per paste.
  for (const char of text.match(/\r\n|[\s\S]/gu) ?? []) {
    if (chunk.length + char.length > 128) {
      const result = flush();
      if (result !== true) return result;
    }
    chunk += char;
    if (char.includes("\n") || char === "\r") {
      const result = flush();
      if (result !== true) return result;
    }
  }
  return chunk ? flush() : true;
}

/** Bracketed paste is data to the harness; one unique buffer is owned through cleanup. */
export function pasteText(target: string, text: string, beforePaste?: PasteAuthority, admitPaste?: () => boolean): boolean | "rate_limited" {
  const buffer = `tap-paste-${process.pid}-${randomUUID()}`, path = join(tmpdir(), buffer);
  writeFileSync(path, text, { mode: 0o600 });
  let loaded = false, consumed = false;
  try {
    const load = tmux(["load-buffer", "-b", buffer, path]);
    if (load.rateLimited) return "rate_limited";
    if (load.code !== 0) return false;
    loaded = true;
    // Reservation may wait. Finish it before the final live authorization,
    // then admit and paste without another capacity wait.
    if (!reserveTmuxClient(process.env)) return "rate_limited";
    // Loading and reservation are not pane effects.
    if (beforePaste) {
      const permission = beforePaste();
      if (permission !== true) return permission;
    }
    if (admitPaste && !admitPaste()) return false;
    const paste = runTmux(["paste-buffer", "-b", buffer, "-d", "-p", "-t", target], process.env);
    consumed = paste.code === 0 && !paste.rateLimited;
    return paste.rateLimited ? "rate_limited" : consumed;
  } finally {
    try {
      // Cleanup of our unique buffer must not compete for the exhausted paste budget.
      // It remains socket-pinned and deadline-bounded, and never sends pane input.
      if (loaded && !consumed) runTmux(["delete-buffer", "-b", buffer], process.env);
    } finally { rmSync(path, { force: true }); }
  }
}

export function pressEnter(target: string): boolean | "rate_limited" {
  const r = tmux(["send-keys", "-t", target, "Enter"]);
  return r.rateLimited ? "rate_limited" : r.code === 0;
}

export function pressEscape(target: string): boolean | "rate_limited" {
  const r = tmux(["send-keys", "-t", target, "Escape"]);
  return r.rateLimited ? "rate_limited" : r.code === 0;
}

/** The interrupt sequence: key names, never literal text. */
export function pressKeys(target: string, keys: string[]): boolean | "rate_limited" {
  if (keys.length === 0) return true;
  const r = tmux(["send-keys", "-t", target, ...keys]);
  return r.rateLimited ? "rate_limited" : r.code === 0;
}
