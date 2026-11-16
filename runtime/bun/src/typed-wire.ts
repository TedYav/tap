import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "./fsatomic";
import { physicalSocketPath } from "./tmux";
import { normalizeInputMatch } from "./terminal-text";
import { stagedIdleWindowSeconds } from "./spool-publication";

/**
 * What the courier typed into a pane, kept as the evidence `sentinel-tail.ts`
 * needs to call opener-less composer text TAP's own. One small record per
 * pane, beside the input-protection state: the last few delivery wires, each
 * with its id, the time it was typed, the tmux server generation it was typed
 * into and the bus whose courier typed it. An entry lives until its wire's
 * submission verifies, or the staged-idle hold window, whichever comes first.
 *
 * The record is evidence and nothing else. It grants no authority, joins no
 * receipt chain, and a missing, stale, damaged or unwritable record means only
 * "not provably ours": the text in the composer is then a human draft. Writing
 * never blocks or fails a delivery.
 *
 * Evidence is bound to who typed it and where. A pane id is unique only within
 * one server generation, so a wire typed before a server restart proves
 * nothing about the pane that now carries the same id. And a courier vouches
 * only for its own bus: a wire another bus typed is unproven here.
 */
export interface TypedWire { id: string; wire: string; at: number; epoch: string; bus: string }

/** The reader's or writer's own binding: the observed server generation and its bus home. */
export interface TypedWireBinding { epoch: string; bus: string }

const KEEP = 4;
/**
 * A tail older than this is no longer vouched for; it takes the human-draft
 * path. The bound is the staged-idle hold window: a stuck wire stays provable
 * for as long as TAP would hold it for an idle Enter, so the hold, the
 * cascade and `tap nudge` agree on one number. Verified wires leave the
 * record at once, so this only limits how long a genuinely stuck wire is
 * vouched for. A window of zero turns the automatic idle Enter off; the
 * record still serves the manual recovery, so it keeps the default length.
 */
function maxAgeMs(env: NodeJS.ProcessEnv): number {
  return (stagedIdleWindowSeconds(env) || stagedIdleWindowSeconds({})) * 1000;
}

function path(pane: string, env: NodeJS.ProcessEnv): string {
  const key = createHash("sha256").update(`${physicalSocketPath(env)}\0${pane}`).digest("hex");
  return join(env.TAP_INDEX_HOME || join(env.HOME || homedir(), ".tap"), "typed-wires", `${key}.json`);
}

/** One spelling per bus, so a symlinked home compares equal to itself. */
function busKey(home: string): string {
  try { return realpathSync(home); } catch { return home; }
}

/** Every well-formed entry on disk for the pane, whatever its age; empty on any doubt. */
function readEntries(pane: string, env: NodeJS.ProcessEnv): TypedWire[] {
  try {
    // A damaged record replaced by a FIFO must not hang a reader.
    const fd = openSync(path(pane, env), constants.O_RDONLY | constants.O_NONBLOCK);
    let record: { pane?: unknown; wires?: unknown };
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 64 * 1024) return [];
      record = JSON.parse(readFileSync(fd, "utf8"));
    } finally { closeSync(fd); }
    if (record?.pane !== pane || !Array.isArray(record.wires)) return [];
    return record.wires.filter((w): w is TypedWire => !!w && typeof w.id === "string" && typeof w.wire === "string"
      && typeof w.epoch === "string" && !!w.epoch && typeof w.bus === "string" && !!w.bus && Number.isFinite(w.at));
  } catch { return []; }
}

/** The entries this process still vouches for: neither older than its window nor stamped in its future. */
function readFresh(pane: string, env: NodeJS.ProcessEnv, now: number): TypedWire[] {
  const maxAge = maxAgeMs(env);
  return readEntries(pane, env).filter(w => w.at <= now && now - w.at <= maxAge);
}

/**
 * The wires this bus's courier recorded typing into this pane in this server
 * generation that are still fresh. Empty on any doubt: an unknown generation or
 * bus proves nothing.
 */
export function typedWires(pane: string, binding: TypedWireBinding, env: NodeJS.ProcessEnv = process.env, now = Date.now()): TypedWire[] {
  if (!pane || !binding.epoch || !binding.bus) return [];
  const bus = busKey(binding.bus);
  return readFresh(pane, env, now).filter(w => w.epoch === binding.epoch && w.bus === bus);
}

/**
 * Which entries a verified submission ends: the wire with that id, and any
 * wire the submitted composer text was, whole or as its scrolled tail. An
 * empty id or text matches nothing on its own.
 */
export function submittedWire(submitted: { id?: string; text?: string }): (wire: { id: string; wire: string }) => boolean {
  const text = normalizeInputMatch(submitted.text ?? "");
  return wire => (!!submitted.id && wire.id === submitted.id) || (!!text && normalizeInputMatch(wire.wire).endsWith(text));
}

/**
 * Forget wires that have left the composer. A submitted wire's tail showing
 * up there later is not the courier's stuck paste: someone recalled or pasted
 * it, and it is theirs. Only a wire typed and not known submitted stays
 * vouched for. Every path that verifies a submission calls this, whoever
 * typed the wire: forgetting spans every bus and generation for the pane,
 * because it can only take evidence away.
 *
 * It also spans every age. The lifetime is each reader's own window, so an
 * entry that has expired for this process may still be fresh for one with a
 * longer window; a submitted wire must be gone for both. Best effort: an
 * entry that cannot be dropped ages out instead.
 */
export function forgetTypedWires(pane: string, gone: (wire: TypedWire) => boolean, env: NodeJS.ProcessEnv = process.env): void {
  if (!pane) return;
  try {
    const stored = readEntries(pane, env);
    const kept = stored.filter(w => !gone(w));
    if (kept.length !== stored.length) atomicWrite(path(pane, env), JSON.stringify({ pane, wires: kept }) + "\n");
  } catch { /* the entry ages out */ }
}

/** Record a delivery wire at the point of typing it. Best effort by contract. */
export function recordTypedWire(pane: string, binding: TypedWireBinding, id: string, wire: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): void {
  if (!pane || !binding.epoch || !binding.bus || !id || !wire) return;
  try {
    const bus = busKey(binding.bus);
    // An earlier generation's entries can never match again; other buses' entries stay theirs.
    const kept = readFresh(pane, env, now).filter(w => w.epoch === binding.epoch && !(w.bus === bus && w.wire === wire));
    kept.push({ id, wire, at: now, epoch: binding.epoch, bus });
    atomicWrite(path(pane, env), JSON.stringify({ pane, wires: kept.slice(-KEEP) }) + "\n");
  } catch { /* no record: a later tail is unproven and stays a human draft */ }
}
