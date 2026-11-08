// `tap restore <handle>[@N] [--as <name>]` — bring a departed seat back from
// team history as a suspended row `tap session resume` can resume. The
// teardown-archive form (`--archive`, and a bare handle with no history) stays
// in verbs/teardown.ts, unchanged.
//
// The tombstone is evidence and is never deleted or rewritten: the restore is
// appended to `<handle>.restores.jsonl` beside it, so `@N` stays stable and
// `tap team history` shows the entry came back.
import { join } from "node:path";

import { TapError, requireActingRegistry, resolveContext, type ResolvedContext } from "../context";
import { renderRefusalsAsync } from "../error-line";
import { appendRegistryEventOrWarn } from "../events";
import { validToken } from "../ids";
import { reservedHandleReason } from "./register";
import { duplicateRegistrySessionOwner } from "../launcher/identity-owner";
import { LauncherError } from "../launcher/types";
import { loadRegistry, mintInstanceId, saveRegistry } from "../registry";
import { withActingRegistry } from "../registry-tx";
import { acquireResetMutationLock, markResetGenerationReused } from "../reset";
import { canonicalSessionName } from "../lifecycle-target";
import { pick, type FzfEffects } from "../fzf";
import { cmdTeardown } from "./teardown";
import { shellQuote } from "../shell-quote";
import { appendRestoreRecord, currentSeats, entryRef, formatDuration, historyDir, parseRef, readTeamHistory, type HistoryEntry } from "../team-history";

type Row = Record<string, unknown>;
const VERB = "tap restore";
const fail = (cls: string, detail: string, action = "tap help restore"): never => { throw new TapError(1, cls, action, detail, VERB); };

export interface RestoreOptions { target: string; as: string; json: boolean; archive: boolean; team?: string }

export function parseRestoreOptions(argv: string[]): RestoreOptions {
  const out: RestoreOptions = { target: "", as: "", json: process.env.TAP_JSON === "1", archive: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") out.json = true;
    else if (arg === "--archive") { out.archive = true; i++; }
    else if (arg === "--as") { const v = argv[++i]; if (!v || v.startsWith("-")) fail("usage_error", "--as needs a handle"); out.as = v!; }
    else if (arg.startsWith("--as=")) out.as = arg.slice(5);
    else if (arg === "--team") { const v = argv[++i]; if (!v || v.startsWith("-")) fail("usage_error", "--team needs a team name"); out.team = v!; }
    else if (arg.startsWith("--team=")) out.team = arg.slice(7);
    else if (arg.startsWith("-")) { if (arg !== "--yes") fail("unknown_option", `unknown option '${arg}'`); }
    else if (!out.target) out.target = arg;
    else fail("usage_error", `unexpected argument '${arg}'`);
  }
  if (out.as && out.archive) fail("usage_error", "--as restores from team history; --archive restores a teardown archive under its own handle");
  if (out.team !== undefined && out.archive) fail("usage_error", "--team selects a team's history; --archive restores this checkout's teardown archive");
  if (out.team === "") fail("usage_error", "--team needs a team name");
  if (out.as) {
    if (!validToken(out.as)) fail("invalid_handle", `invalid handle '${out.as}' for --as`);
    const reserved = reservedHandleReason(out.as);
    if (reserved) fail("reserved_handle", `'${out.as}' is ${reserved} and cannot be a seat handle`, "tap restore <handle>@<n> --as <another-handle>");
  }
  return out;
}

/** The first free `<handle>-N` (N ≥ 2) on this roster, for a ready-to-run `--as` suggestion. */
export function freeSibling(handle: string, rows: Record<string, unknown>): string {
  for (let n = 2; ; n++) if (!Object.hasOwn(rows, `${handle}-${n}`)) return `${handle}-${n}`;
}

/**
 * Re-add one departure as a suspended, relaunchable row. Refuses, changing
 * nothing, when the name is held, when the entry has no exact native id, or
 * when another seat on this team already owns that native id (one conversation,
 * one owner: the same rule `assertUniqueResume` applies at resume time).
 */
/**
 * Next-step commands for a restore into `ctx`. With `--team`, a `tap restore` hint keeps the team, and a
 * `tap session` command, which resolves its team from the cwd, runs from that team's root.
 */
function restoreHints(ctx: ResolvedContext, explicitTeam: boolean) {
  return {
    restore: (args: string) => `tap restore ${args}${explicitTeam ? ` --team ${ctx.team}` : ""}`,
    session: (args: string) => `${explicitTeam ? `cd ${shellQuote(ctx.root)} && ` : ""}tap session ${args}`,
  };
}

export function restoreHistoryEntry(ctx: ResolvedContext, entry: HistoryEntry, as = "", explicitTeam = false): { handle: string; row: Row } {
  const name = as || entry.handle;
  const hint = restoreHints(ctx, explicitTeam);
  const reserved = reservedHandleReason(name);
  if (reserved) fail("reserved_handle", `'${name}' is ${reserved} and cannot be a seat handle; history unchanged`, hint.restore(`${entryRef(entry)} --as <another-handle>`));
  if (!entry.resumable) {
    fail("not_resumable", `${entryRef(entry)} has no exact native ${entry.harness || "harness"} session to resume (thin or poll/crew row); history unchanged`,
      hint.session(`launch ${entry.harness || "<harness>"} ${name}`));
  }
  requireActingRegistry(ctx, 1);
  // Read the tombstone again as the registry codec reads rows, so restore writes exactly what was retired.
  const tomb = loadRegistry(join(historyDir(ctx.root), entry.tombstone)) as Row;
  const source = tomb.row as Row;
  const fence = acquireResetMutationLock(ctx.bus.home, VERB);
  let restored: Row = {};
  try {
    withActingRegistry(ctx, (doc, rows) => {
      if (Object.hasOwn(rows, name)) {
        const sibling = freeSibling(name, rows);
        fail("handle_live", `handle_live: '${name}' is on the team now; history unchanged. Restore under another name`,
          hint.restore(`${entryRef(entry)} --as ${sibling}`));
      }
      for (const [handle, row] of Object.entries(rows)) {
        const other = row as Row;
        if (other.harness === source.harness && other.harness_session_id === source.harness_session_id) {
          fail("session_owned", `native ${String(source.harness)} session id ${String(source.harness_session_id)} already belongs to seat '${handle}' on this team; history unchanged`,
            hint.session(`resume ${handle}`));
        }
      }
      // One conversation, one owner, machine-wide: the launcher's own owner scan over every
      // enrolled team's acting registry (launch --resume and resume refuse the same way).
      let owner: string | null;
      try {
        owner = duplicateRegistrySessionOwner({ name: canonicalSessionName(ctx.team, name), harness: String(source.harness), cwd: ctx.root,
          base: ctx.team, tag: name, index: 1, harness_session_id: String(source.harness_session_id),
          transcript_path: typeof source.transcript_path === "string" ? source.transcript_path : null },
        { root: ctx.root, registryPath: ctx.registryPath, handle: name });
      } catch (error) {
        if (error instanceof LauncherError) throw new TapError(1, error.errorClass || "registry_invalid", error.action || "tap doctor", error.detail || error.message, VERB);
        throw error;
      }
      if (owner !== null) {
        fail("session_owned", `native ${String(source.harness)} session id ${String(source.harness_session_id)} already belongs to seat ${owner}; history unchanged`,
          `tap team roster ${owner.slice(0, owner.lastIndexOf("/"))}`);
      }
      markResetGenerationReused(ctx.bus.home, "restore", 0);
      restored = { ...source, status: "suspended", status_reason: "restored_from_archive" };
      if (typeof restored.delivery !== "string" || !restored.delivery) restored.delivery = "pane";
      if (as) {
        // A new name is a new seat: its own instance, canonical session and launcher identity, the
        // conversation carried over. The launcher derives the handle from session, tag and index, so a
        // departed sibling's `index: 2` would decode as `<name>-2` and resume could not find `<name>`.
        restored.instance = mintInstanceId(name);
        restored.session = canonicalSessionName(ctx.team, name);
        restored.index = 1;
        delete restored.tag;
      }
      rows[name] = restored as never;
      saveRegistry(ctx.registryPath, doc);
    }, 0);
  } finally { fence.release(); }
  try { appendRestoreRecord(ctx.root, entry, name); }
  catch (error) { process.stderr.write(`tap restore: warning: restored '${name}' but could not record it in team history: ${String(error)}\n`); }
  appendRegistryEventOrWarn(VERB, { log: join(ctx.bus.home, "registry-events.log"), actor: name, action: "restore", handle: name, pane: "", team: ctx.team, detail: `from=${entryRef(entry)}` });
  return { handle: name, row: restored };
}

function choiceLabel(entry: HistoryEntry): string {
  return `${entryRef(entry)}  ${entry.harness || "-"}  ${entry.model || "-"}  out ${entry.retiredAt ?? "-"}  ${formatDuration(entry.lengthSeconds)}${entry.resumable ? "" : "  (not resumable)"}`;
}

export interface RestoreDeps { terminal: () => boolean; fzf?: FzfEffects }
const defaultDeps: RestoreDeps = { terminal: () => process.stdin.isTTY === true && process.stderr.isTTY === true };

/** Which departure an operand names; null means "no history: fall back to the teardown archive". */
async function chooseEntry(ctx: ResolvedContext, opts: RestoreOptions, deps: RestoreDeps): Promise<HistoryEntry | "cancelled" | null> {
  const operand = opts.target ? parseRef(opts.target) : null;
  // A named handle reads only its own tombstones; the cross-history picker reads them all.
  const departed = readTeamHistory(ctx.root, currentSeats(ctx), Date.now() / 1000, operand?.handle ?? "").entries.filter(entry => !entry.onTeam);
  const choose = async (choices: HistoryEntry[], query: string): Promise<HistoryEntry | "cancelled"> => {
    const result = await pick(choices.map(entry => ({ id: entryRef(entry), label: choiceLabel(entry), value: entry })),
      { verb: "restore", query, prompt: "Restore > ", header: "Type to search · Enter restore · Esc cancel", tiebreak: "index" }, deps.fzf);
    return result.kind === "selected" ? result.values[0]! : "cancelled";
  };
  if (!opts.target) {
    if (!deps.terminal()) fail("usage_error", "restore requires a handle (or <handle>@<n> from tap team history)");
    if (!departed.length) fail("no_candidates", `no departed seats recorded on team '${ctx.team}'`, "tap team history");
    return choose(departed, "");
  }
  const ref = operand;
  if (!ref) fail("invalid_handle", `invalid handle '${opts.target}' (expected <handle> or <handle>@<n>)`);
  const mine = departed.filter(entry => entry.handle === ref!.handle);
  if (ref!.index !== null) {
    const hit = mine.find(entry => entry.index === ref!.index);
    if (!hit) fail("history_not_found", `'${opts.target}' is not in team history (${mine.length ? `${ref!.handle} has @1..@${mine.length}` : `no departures for '${ref!.handle}'`})`, `tap team history ${ref!.handle}`);
    return hit!;
  }
  if (!mine.length) return null;
  if (mine.length === 1) return mine[0]!;
  if (deps.terminal()) return choose(mine, `${ref!.handle}@`);
  const refs = [...mine].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map(entryRef);
  return fail("ambiguous_history", `'${ref!.handle}' left the team ${mine.length} times; name one: ${refs.join(" ")}`, restoreHints(ctx, !!opts.team).restore(refs.at(-1)!));
}

export async function cmdRestore(argv: string[], deps: RestoreDeps = defaultDeps): Promise<number> {
  const json = argv.includes("--json") || process.env.TAP_JSON === "1";
  if (json) process.env.TAP_JSON = "1";
  // The archive form is the teardown restore, byte for byte.
  if (argv.includes("--archive") && !argv.some(arg => arg === "--as" || arg.startsWith("--as=") || arg === "--team" || arg.startsWith("--team="))) return cmdTeardown("restore", argv);
  return renderRefusalsAsync(VERB, async () => {
    const opts = parseRestoreOptions(argv);
    const ctx = resolveContext(process.cwd(), process.env, opts.team ? { explicitTeam: opts.team } : undefined);
    const entry = await chooseEntry(ctx, opts, deps);
    // Another team's history has no teardown-archive fallback in this checkout.
    if (entry === null && opts.team) fail("history_not_found", `'${opts.target}' has no departures on team '${ctx.team}'`, `tap team history --team ${ctx.team}`);
    if (entry === null) return cmdTeardown("restore", argv);
    if (entry === "cancelled") { if (!json) process.stdout.write("tap restore: cancelled; nothing restored\n"); return 0; }
    const { handle, row } = restoreHistoryEntry(ctx, entry, opts.as, !!opts.team);
    const next = restoreHints(ctx, !!opts.team).session(`resume ${handle}`);
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, handle, from: entryRef(entry), status: row.status, status_reason: row.status_reason,
        harness: row.harness ?? null, harness_session_id: row.harness_session_id ?? null, next })}\n`);
    } else {
      process.stdout.write(`tap restore: restored ${entryRef(entry)}${handle === entry.handle ? "" : ` as '${handle}'`} (suspended; native ${String(row.harness)} session ${String(row.harness_session_id)})\n`);
      process.stdout.write(`tap restore: next: ${next}\n`);
    }
    return 0;
  }, { ...process.env, TAP_JSON: json ? "1" : "0" });
}
