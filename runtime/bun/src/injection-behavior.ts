import { protectedMessageDeadline } from "./input-protection";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDirectory, table } from "./config-file";

/**
 * `clobber` (default): a human draft gets its grace and WAIT snooze, then is backed
 * up, cleared, and put back after delivery. `wait`: drafts are never cleared;
 * mail parks until the composer is empty. `warn` is the earlier spelling of `wait`,
 * still read so existing configs keep working.
 */
export type InjectionBehavior = "clobber" | "wait";

/** The config parsed and the injection setting is wrong; read, parse and path failures are not this. */
export class InjectionBehaviorError extends Error {
  constructor(message: string) { super(message); this.name = "InjectionBehaviorError"; }
}

export function injectionBehavior(env: NodeJS.ProcessEnv = process.env): InjectionBehavior {
  const path = join(configDirectory(env), "config.toml");
  // One O_NONBLOCK open, judged by fstat on that same descriptor: a FIFO (or one swapped in
  // after a separate stat) must refuse, not block delivery and health forever. Unlike
  // readSecureBytes this keeps no group/world-writable refusal on the delivery path.
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "clobber"; throw error; }
  let doc: Record<string, any>;
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`config.toml is not a regular file: ${path}`);
    doc = Bun.TOML.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
  if (doc.injection !== undefined && !table(doc.injection)) throw new InjectionBehaviorError("injection must be a TOML table");
  const value = doc.injection?.behavior ?? "clobber";
  if (value === "warn") return "wait";
  if (value !== "clobber" && value !== "wait") throw new InjectionBehaviorError("injection.behavior must be clobber or wait");
  return value;
}

/** The setting refusal delivery would raise for this config, or null when the setting is usable. Read and parse failures propagate. */
export function injectionBehaviorFault(env: NodeJS.ProcessEnv = process.env): string | null {
  try { injectionBehavior(env); return null; }
  catch (error) { if (error instanceof InjectionBehaviorError) return error.message; throw error; }
}

/** Existing standard grace records remain readable across the upgrade. */
export function draftClobberDue(meta: Record<string, unknown>, now: number, behavior: InjectionBehavior): boolean {
  const raw = meta.draft_deadline_epoch ?? (meta.waiter_lifetime === "grace-window" ? meta.deadline_epoch : undefined);
  const deadline = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return behavior === "clobber" && Number.isFinite(deadline) && deadline > 0 && now >= deadline;
}

export function queuedDraftClobberDue(spool: string, id: string, now = Date.now() / 1000): boolean {
  const meta = JSON.parse(readFileSync(join(spool, `${id}.meta.json`), "utf8"));
  const shared = typeof meta.pane_id === "string" ? protectedMessageDeadline(dirname(spool), id, meta.pane_id) : null;
  return shared !== undefined && draftClobberDue(shared === null ? meta : { ...meta, draft_deadline_epoch: shared }, now, injectionBehavior());
}

/** One pass over candidate rows; fresh drafts do not join older due notes. */
export function digestDraftPlan(rows: string, spool: string, now: number, cap = 32, mode = injectionBehavior(), env = process.env): string {
  if (!Number.isSafeInteger(cap)) throw new Error("TAP_DIGEST_MAX_ITEMS must be an integer");
  cap = Math.max(2, cap);
  const groups = new Map<string, {id: string; auto: boolean}[]>();
  for (const line of rows.split("\n")) {
    const f = line.split("\x1f"); if (f.length !== 9) continue;
    const id = f[6]!, ready = f[8]!;
    if (ready !== "ready") {
      if (ready !== "busy:pending") continue;
      let meta: Record<string, unknown>;
      try { meta = JSON.parse(readFileSync(join(spool, `${id}.meta.json`), "utf8")); } catch { continue; }
      const shared = typeof meta.pane_id === "string" ? protectedMessageDeadline(dirname(spool), id, meta.pane_id, env) : null;
      if (shared === undefined || !draftClobberDue(shared === null ? meta : { ...meta, draft_deadline_epoch: shared }, now, mode)) continue;
    }
    const key = f.slice(0, 5).join("\x1f");
    const group = groups.get(key) ?? []; group.push({id, auto: f[7] !== "plain"}); groups.set(key, group);
  }
  const output: string[] = [];
  for (const [key, group] of groups) {
    for (let i = 0; i < group.length; i += cap) {
      const chunk = group.slice(i, i + cap);
      if (chunk.length > 1 || chunk.some(row => row.auto)) output.push(`${key}\x1f${chunk.map(row => row.id).join(" ")}`);
    }
  }
  return output.length ? output.join("\n") + "\n" : "";
}

if (import.meta.main) {
  try {
    const [op, spool, id] = process.argv.slice(2);
    if (op === "mode") console.log(injectionBehavior());
    else if (op === "plan" && spool && id) process.stdout.write(digestDraftPlan(await Bun.stdin.text(), spool, Number(id), Number(process.env.TAP_DIGEST_MAX_ITEMS || 32)));
    else if (op === "cue" && spool && id) {
      const meta = JSON.parse(readFileSync(join(spool, `${id}.meta.json`), "utf8"));
      const shared = typeof meta.pane_id === "string" ? protectedMessageDeadline(dirname(spool), id, meta.pane_id) : null;
      if (shared === undefined) throw new Error("input protection unavailable; entry held");
      console.log(`${meta.cue_red_at ?? ""}\x1f${shared === null ? meta.draft_deadline_epoch ?? meta.deadline_epoch ?? "" : Math.floor(shared)}`);
    }
    else throw new Error("invalid injection behavior operation");
  } catch (error) { console.error(`tap injection: ${String(error)}`); process.exitCode = 1; }
}
