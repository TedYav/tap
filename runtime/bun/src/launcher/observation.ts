// Launcher read-only decisions, shared with retained Python selection callers.
import { basename } from "node:path";
import { serverEpochFromRaw } from "../tmux";
import { isPaneId } from "../lifecycle-target";
import { isDict } from "../spool-publication";
import { HARNESSES } from "./catalog";
import { PaneObservationTimeout, paneFacts, paneHarness, type PaneFacts } from "./readiness";
import { launchCommand, launchTmux } from "./process";

type Row = Record<string, unknown>;
const text = (value: unknown): string => typeof value === "string" ? value : "";
export const paneSession = (pane: string): string => pane.split(":", 1)[0]!;
export const isLoginShell = (command: string): boolean => ["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "nu", "login"].includes(basename(command).replace(/^-+/, "").toLowerCase());

export async function currentEpoch(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string | null> {
  if (env.TAP_SERVER_EPOCH !== undefined) return env.TAP_SERVER_EPOCH || null;
  const run = await launchTmux(["display-message", "-p", "#{pid}:#{start_time}"], env, signal, true, 5000);
  signal?.throwIfAborted();
  if (run.code === 124) throw new PaneObservationTimeout("server");
  return run.code === 0 ? serverEpochFromRaw(run.stdout.trim(), env) || null : null;
}

export async function hasSession(name: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<boolean> {
  return (await launchTmux(["has-session", "-t", `=${name}`], env, signal)).code === 0;
}

export async function sessionPaneIds(name: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string[]> {
  try {
    const run = await launchTmux(["list-panes", "-t", `=${name}`, "-F", "#{pane_id}"], env, signal);
    return run.code === 0 ? run.stdout.split("\n").map(v => v.trim()).filter(Boolean) : [];
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function shellHasChildren(pid: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<boolean> {
  try {
    const run = await launchCommand(["pgrep", "-P", pid], { env, signal });
    return run.code === 0 ? !!run.stdout.trim() : run.code !== 1;
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

/** The seat a classification judges. Without one, any harness pane makes the session live. */
export type SessionSeat = { harness: string; crewPanes?: ReadonlySet<string> };

/**
 * live, busy, shell, attached-shell, unknown, or — for a named seat — seat-gone:
 * the session survives, but no pane runs the seat's harness while other harness
 * panes (crews; registered crew panes never count as the seat) hold it (tap-9rrat).
 */
export async function classifySession(name: string, env: NodeJS.ProcessEnv, signal?: AbortSignal, seat?: SessionSeat): Promise<string> {
  const format = "#{session_name}:#{window_index}.#{pane_index}\t#{pane_id}\t#{pane_current_command}\t#{pane_pid}\t#{session_attached}";
  const run = await launchTmux(["list-panes", "-s", "-t", `=${name}`, "-F", format], env, signal);
  if (run.code !== 0 || !run.stdout.trim()) return "unknown";
  let parsed = 0, attached = false, harness = false, seatPane = false, busy = false;
  const shells: string[] = [];
  for (const line of run.stdout.split("\n")) {
    const p = line.split("\t");
    if (p.length !== 5) continue;
    parsed++;
    attached ||= p[4] !== "" && p[4] !== "0";
    const facts: PaneFacts = { pane: p[0]!, pane_id: p[1]!, command: p[2]!, path: "", server_epoch: "", dead: false, pane_pid: Number(p[3]) };
    const family = paneHarness(facts, env);
    if (HARNESSES.includes(family)) {
      harness = true;
      seatPane ||= !!seat && family === seat.harness && !seat.crewPanes?.has(facts.pane_id);
    }
    else if (!isLoginShell(facts.command)) busy = true;
    else if (/^\d+$/.test(p[3]!)) shells.push(p[3]!);
    else busy = true;
  }
  if (!parsed) return "unknown";
  if (harness) return !seat || seatPane ? "live" : "seat-gone";
  if (busy) return "busy";
  for (const pid of shells) if (await shellHasChildren(pid, env, signal)) return "busy";
  return attached ? "attached-shell" : "shell";
}

/** The registered crew panes in one session: never the seat's own pane, whatever their harness. */
export function crewPanesIn(seats: Iterable<[string, unknown]>, session: string): Set<string> {
  const panes = new Set<string>();
  for (const [, row] of seats) {
    if (isDict(row) && (row.crew === true || row.crew === 1) && row.session === session && isPaneId(row.pane_id)) panes.add(row.pane_id as string);
  }
  return panes;
}

/** Resume's attach predicate: a present session reattaches unless it holds no seat to attach to. */
export const attachableState = (classification: string): boolean => !["shell", "attached-shell", "seat-gone"].includes(classification);

export async function verifiedSession(entry: Row, env: NodeJS.ProcessEnv, signal?: AbortSignal, strict = false): Promise<string | null> {
  const epoch = await currentEpoch(env, signal);
  const id = text(entry.pane_id);
  if (!id || (entry.server_epoch && epoch !== null && entry.server_epoch !== epoch)) return null;
  const facts = await paneFacts(id, env, signal);
  if (!facts || facts.pane_id !== id) return null;
  if (entry.server_epoch && ((facts.server_epoch && facts.server_epoch !== entry.server_epoch) || (strict && !facts.server_epoch))) return null;
  const session = paneSession(facts.pane);
  if (entry.server_epoch) return session;
  return text(entry.session) && entry.session !== session ? null : session;
}

export async function entrySession(entry: Row, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string | null> {
  if (text(entry.pane_id)) {
    const verified = await verifiedSession(entry, env, signal);
    if (verified !== null) return verified;
    return text(entry.session) || (text(entry.pane) ? paneSession(text(entry.pane)) : null);
  }
  if (text(entry.session)) return text(entry.session);
  if (text(entry.pane)) {
    const facts = await paneFacts(text(entry.pane), env, signal);
    return facts ? paneSession(facts.pane) : paneSession(text(entry.pane));
  }
  return null;
}

export async function registryResumeSelection(entries: unknown, key: unknown, env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (typeof key !== "string" || !Array.isArray(entries) || !entries.every(pair =>
    Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && isDict(pair[1]))) {
    throw new Error("invalid registry resume selection request");
  }
  // Pairs retain Python insertion order, including integer-looking handles.
  const rows = entries as [string, Row][];
  const exact = rows.find(([handle]) => handle === key);
  const ordered = exact ? [exact, ...rows.filter(([handle]) => handle !== key)] : rows;
  for (const [handle, entry] of ordered) {
    if ((Object.hasOwn(entry, "status") ? entry.status : "active") !== "active") continue;
    const name = await entrySession(entry, env, signal);
    signal?.throwIfAborted();
    if (handle !== key && name !== key) continue;
    const harness = entry.harness;
    if (!name || typeof harness !== "string" || !HARNESSES.includes(harness)) continue;
    return { name, harness, tag: handle };
  }
  return null;
}

/** Preserve the launcher's stricter mixed-frame refusals, not the team-stop approximation. */
export async function destructiveTarget(entry: Row, expected: string | null, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string | null> {
  if (!isPaneId(entry.pane_id) || !expected || entry.session !== expected || !await hasSession(expected, env, signal)) return null;
  const facts = await paneFacts(entry.pane_id, env, signal);
  if (!facts) return expected;
  if (facts.pane_id !== entry.pane_id) return null;
  const observed = facts.pane.includes(":") ? facts.pane.slice(0, facts.pane.lastIndexOf(":")) : "";
  if (observed && observed !== expected) return null;
  const members = await sessionPaneIds(expected, env, signal);
  return members.length && !members.includes(entry.pane_id) ? null : expected;
}

export async function entryObservedDead(entry: Row, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<boolean> {
  if (entry.delivery === "poll") return false;
  const backed = async () => {
    const name = await entrySession(entry, env, signal);
    return !!name && await hasSession(name, env, signal) && await classifySession(name, env, signal) !== "shell";
  };
  const id = entry.pane_id;
  if (id !== undefined && id !== null && id !== "" && !isPaneId(id)) return false;
  if (!text(id)) return !!text(entry.pane) && !await paneFacts(text(entry.pane), env, signal) && !await backed();
  const epoch = await currentEpoch(env, signal);
  if (entry.server_epoch && epoch !== null && entry.server_epoch !== epoch) return !await backed();
  const facts = await paneFacts(text(id), env, signal);
  if (!facts || facts.pane_id !== id) return !await backed();
  if (!entry.server_epoch && text(entry.session) && paneSession(facts.pane) !== entry.session) return !await backed();
  if (HARNESSES.includes(text(entry.harness)) && !HARNESSES.includes(paneHarness(facts, env))) {
    if (!isLoginShell(facts.command)) return false;
    const pid = await launchTmux(["display-message", "-p", "-t", text(id), "#{pane_pid}"], env, signal);
    return pid.code === 0 && /^\d+$/.test(pid.stdout.trim()) && !await shellHasChildren(pid.stdout.trim(), env, signal);
  }
  return false;
}
