// ONE owner of the launcher's seat-generation staleness decision: a stored
// boot/server stamp is stale only against a readable, same-socket observation.
// resume --all takes one snapshot for its whole cohort; single-seat live
// reattach (launcher.py) asks through the worker and observes once per call.
import { InvocationError } from "./invocation";
import { launchCommand } from "./process";
import { bootId, legacyBootId, serverEpochFromRaw } from "../tmux";
import { isDict } from "../spool-publication";

type Row = Record<string, unknown>;
export type Observation = { boot: string | null; epoch: string | null; socket: string };

async function tmuxRun(args: string[], socketPinned: boolean, timeoutMs?: number, signal?: AbortSignal) {
  const pin = socketPinned && process.env.TAP_TMUX_SOCKET_PATH ? ["-S", process.env.TAP_TMUX_SOCKET_PATH] : [];
  try {
    const result = await launchCommand(["tmux", ...pin, ...args], { env: process.env, timeoutMs, signal });
    signal?.throwIfAborted();
    return result;
  }
  catch { signal?.throwIfAborted(); return null; }
}

/** tmux_sessions_for_namespace: only tmux's recognized no-server answer is empty. */
export async function namespaceSnapshot(): Promise<Set<string>> {
  const result = await tmuxRun(["list-sessions", "-F", "#S"], false);
  if (result && result.code === 0) return new Set(result.stdout.split("\n").filter(Boolean));
  const stderr = result ? result.stderr.trim() : "";
  if (/^(?:no server running on .+|error connecting to .+ \(No such file or directory\))$/.test(stderr)) return new Set();
  throw new InvocationError("tmux session-name snapshot is unobservable; refusing to treat the session namespace as empty");
}

async function serverEpochNow(signal?: AbortSignal): Promise<string | null> {
  if (process.env.TAP_SERVER_EPOCH !== undefined) return process.env.TAP_SERVER_EPOCH || null;
  // seat_corpse.tmux_command bounds this read through tmux_deadline.py.
  const seconds = Number(process.env.TAP_TMUX_TIMEOUT_SECONDS ?? 5);
  const bound = Number.isFinite(seconds) && seconds >= 0.01 && seconds <= 60 ? seconds : 5;
  const result = await tmuxRun(["display-message", "-p", "#{pid}:#{start_time}"], true, bound * 1000, signal);
  if (!result || result.code !== 0) return null;
  const lines = result.stdout.split(/\r\n|\r|\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.length === 1 ? serverEpochFromRaw(lines[0]!) || null : null;
}

async function serverSocket(epoch: string | null, signal?: AbortSignal): Promise<string> {
  const result = await tmuxRun(["display-message", "-p", "#{pid}:#{start_time}\t#{socket_path}"], false, 2000, signal);
  if (!result || result.code !== 0) return "";
  const line = result.stdout.trim(), tab = line.indexOf("\t");
  if (tab < 0) return "";
  const raw = line.slice(0, tab), socket = line.slice(tab + 1);
  const observed = process.env.TAP_SERVER_EPOCH !== undefined ? process.env.TAP_SERVER_EPOCH || null : serverEpochFromRaw(raw) || null;
  return socket.startsWith("/") && observed === epoch ? socket : "";
}

export function currentBootId(): string | null {
  if (process.env.TAP_BOOT_ID !== undefined) return process.env.TAP_BOOT_ID || null;
  return bootId() || null;
}

/** launcher.boot_ids_match over seat_corpse.boot_ids_match (5-second legacy tolerance). */
function bootIdsMatch(stored: string, current: string): boolean {
  if (stored === current && stored) return true;
  if (process.env.TAP_BOOT_ID !== undefined && process.env.TAP_BOOT_ID_LEGACY === undefined) return false;
  const legacy = legacyBootId() || null;
  if (!stored || !current) return false;
  const match = /^boot:(\d+)$/.exec(stored), current_legacy = /^boot:(\d+)$/.exec(legacy ?? "");
  if (!match || !current_legacy) return false;
  const delta = BigInt(match[1]!) - BigInt(current_legacy[1]!);
  return (delta < 0n ? -delta : delta) <= 5n;
}

export const truthy = (value: unknown): boolean => value !== null && value !== undefined && value !== false && value !== 0 && value !== "";

/** Only a readable, same-socket observation can prove a stored stamp stale. */
export function staleSeatGeneration(entry: unknown, observation: Observation): boolean {
  if (!isDict(entry)) return false;
  const { boot, epoch, socket } = observation;
  if (!epoch || !socket || entry.server_socket !== socket) return false;
  const oldBoot = entry.boot_id, oldEpoch = entry.server_epoch;
  const bootKind = (value: unknown) => typeof value !== "string" ? null
    : /^boot:[0-9]+$/.test(value) ? "seconds"
    : /^bootuuid:[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(value) ? "uuid" : null;
  const validEpoch = (value: unknown) => typeof value === "string" && /^srv:[0-9]+:[0-9]+$/.test(value);
  if (truthy(oldBoot) && (!bootKind(oldBoot) || bootKind(oldBoot) !== bootKind(boot))) return false;
  if (truthy(oldEpoch) && (!validEpoch(oldEpoch) || !validEpoch(epoch))) return false;
  return (truthy(oldBoot) && !!boot && !bootIdsMatch(oldBoot as string, boot))
    || (truthy(oldEpoch) && !!epoch && oldEpoch !== epoch);
}


/** One generation observation: boot, server epoch, and that epoch's socket. */
export async function observeGeneration(signal?: AbortSignal): Promise<Observation> {
  const epoch = await serverEpochNow(signal);
  return { boot: currentBootId(), epoch, socket: await serverSocket(epoch, signal) };
}
