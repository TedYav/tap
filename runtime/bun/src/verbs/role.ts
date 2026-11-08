// `tap role [<seat>] [<role> | --unset]`: a seat's role on its team.
//
// A role is a label people and agents read, never a permission: nothing gates on it, and a
// seat without one can still ask for work. Only `leader` changes presentation (leaders sort
// first in `tap team` and `tap attach`). Several seats may hold `leader`; there is no election.
// The role lives on the seat row, so `tap out` retires it with the row, and each change appends
// one registry event: that line is the whole assignment history.
//
// Removing another seat's `leader` role (unset or replace) sends that seat one watcher notice
// naming who removed it. The registry write commits first; a notice that cannot be delivered is
// reported, never rolled back.

import { TapError, callingPane, observeCallerIdentity, resolveContext, resolveSelf, type ResolvedContext } from "../context";
import { appendRegistryEventOrWarn, registryEventsPath } from "../events";
import { atomicWrite, ensureAscii } from "../fsatomic";
import { validToken } from "../ids";
import { acquireRegistryLock, childBusEnv } from "../panelock";
import { loadRegistry, pyJson, seatMap } from "../registry";
import { registryWriteRefusal } from "../register-authority";
import { acquireResetMutationLock, assertResetUnfenced, markResetGenerationReused } from "../reset";
import { assertSelectionCurrent } from "../selector";
import { tapScriptsDir } from "../scripts-dir";
import { tmuxSessionNamespace } from "../tmux";
import { sendNoticeReceipt, type SendNoticeArgs } from "../watch-notice";
import { isDaemon } from "./team";

const USAGE = "tap help role";
const json = (value: unknown): string => ensureAscii(JSON.stringify(value));
export const LEADER = "leader";
const ROLE_MAX = 32;

export interface RoleArgs { seat: string; role: string; unset: boolean; team: string; json: boolean; dryRun: boolean }

export function parseRoleArgs(argv: readonly string[]): RoleArgs {
  const out: RoleArgs = { seat: "", role: "", unset: false, team: "", json: false, dryRun: false };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--team") {
      const value = argv[++i];
      if (value === undefined || value === "") throw new TapError(1, "usage_error", USAGE, "--team needs a value");
      out.team = value;
    } else if (arg === "--unset") out.unset = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--") positionals.push(...argv.slice(i + 1)), i = argv.length;
    else if (arg.startsWith("-")) throw new TapError(1, "unknown_option", USAGE, `unknown option '${arg}'`);
    else positionals.push(arg);
  }
  if (positionals.length > 2) throw new TapError(1, "usage_error", USAGE, `unexpected argument '${positionals[2]}' (tap role <seat> <role>)`);
  [out.seat = "", out.role = ""] = positionals;
  // Roles compare exactly, so `LEADER` is stored as `leader`.
  out.role = out.role.toLowerCase();
  if (out.seat && !validToken(out.seat)) throw new TapError(1, "usage_error", USAGE, `'${out.seat}' is not a seat handle`);
  if (out.unset && out.role) throw new TapError(1, "usage_error", USAGE, "give a role or --unset, not both");
  if ((out.unset || out.role) && !out.seat) throw new TapError(1, "usage_error", USAGE, "name the seat first: tap role <seat> <role>");
  if (out.role && (!validToken(out.role) || out.role.length > ROLE_MAX)) {
    throw new TapError(1, "usage_error", USAGE, `'${out.role}' is not a role: use one word of letters, digits, '.', '_' or '-' (at most ${ROLE_MAX}), e.g. leader`);
  }
  if (out.dryRun && !out.role && !out.unset) throw new TapError(1, "usage_error", USAGE, "--dry-run previews a change: give a role or --unset");
  return out;
}

export const seatRole = (row: Record<string, unknown> | undefined): string =>
  typeof row?.role === "string" && validToken(row.role) ? row.role : "";

export interface RoleActor { team: string; handle: string }

/**
 * Who is changing the role: the calling pane's registered seat (team + handle, so a same-named
 * seat on another team is a different actor), else the operator at a terminal outside any seat.
 * An unobservable caller is refused rather than guessed, and only an `unregistered` pane counts
 * as the operator's own shell; every other identity failure propagates.
 */
export function roleActor(target: ResolvedContext): RoleActor {
  const operator = (): RoleActor => ({ team: "", handle: process.stdin.isTTY ? "user" : "unknown" });
  const pane = callingPane();
  if (pane?.status === "ok") {
    let own: ResolvedContext | null = null;
    try { own = resolveContext(); } catch { /* The caller's cwd is outside every team; try the target team. */ }
    for (const ctx of own && own.registryPath !== target.registryPath ? [own, target] : [target]) {
      try {
        const self = resolveSelf(ctx, pane, 1);
        return { team: self.team || ctx.team, handle: self.handle };
      } catch (error) {
        if (!(error instanceof TapError && error.errorClass === "unregistered")) throw error;
      }
    }
    return operator();
  }
  const seen = pane ? null : observeCallerIdentity();
  // No tmux server at all is a terminal outside tmux, not a hidden pane (team out's rule).
  if (seen?.state === "unobservable" && !seen.shared && !process.env.TMUX) {
    const namespace = tmuxSessionNamespace();
    if (namespace.observable && namespace.names.size === 0) return operator();
  }
  if (pane || seen?.state === "unobservable") {
    throw new TapError(1, "caller_unobservable", "run tap role from a registered pane or a terminal outside tmux",
      `cannot tell who is calling (${seen?.state === "unobservable" ? seen.refusal : "pane identity unverifiable"}); no role changed`);
  }
  return operator();
}

const actorLabel = (actor: RoleActor, team: string): string =>
  actor.handle === "user" && !actor.team ? "The operator"
    : actor.handle === "unknown" && !actor.team ? "An unregistered caller"
    : actor.team && actor.team !== team ? `${actor.team}/${actor.handle}` : actor.handle;

/** The notice's send: pinned to the team bus the role changed on, so a caller outside any enrolled
 * checkout (`tap role <seat> --unset --team <t>`) still reaches it. */
export function roleNoticeArgs(ctx: ResolvedContext, to: string, reason: string, evidence: string): SendNoticeArgs {
  return { bus: ctx.bus.home, scripts: tapScriptsDir(), to, reason, evidence, template: "role-removed.md", quiet: true,
    env: childBusEnv(ctx.bus.home) };
}

export interface RoleNotice { send(to: string, reason: string, evidence: string): { rc: number; disposition: string } }

export interface RoleEffects {
  context(team: string): ResolvedContext;
  actor(ctx: ResolvedContext): RoleActor;
  notice(ctx: ResolvedContext): RoleNotice;
  event(ctx: ResolvedContext, fields: { actor: string; handle: string; pane: string; detail: string }): void;
  out(text: string): void;
}

const REAL: RoleEffects = {
  context: team => resolveContext(process.cwd(), process.env, team ? { explicitTeam: team } : undefined),
  actor: roleActor,
  notice: ctx => ({ send: (to, reason, evidence) => sendNoticeReceipt(roleNoticeArgs(ctx, to, reason, evidence)) }),
  event: (ctx, f) => { appendRegistryEventOrWarn("tap role", { log: registryEventsPath(ctx.bus.home), actor: f.actor,
    action: "role", handle: f.handle, pane: f.pane, team: ctx.team, detail: f.detail }); },
  out: text => { process.stdout.write(text); },
};

export function cmdRole(argv: string[], fx: RoleEffects = REAL): number {
  // JSON error mode is chosen before the parse can fail, so a refused argv still answers in JSON.
  if (argv.includes("--json")) process.env.TAP_JSON = "1";
  const args = parseRoleArgs(argv);
  const ctx = fx.context(args.team);
  if (!args.role && !args.unset) return readRoles(ctx, args, fx);

  // Resolve the actor before any write: an unobservable caller changes nothing, and a dry run
  // refuses exactly as the real run would.
  const actor = fx.actor(ctx);
  // The registry-mutation pattern every row writer shares: shared reset custody, the selection
  // revalidated under the registry lock, old-store refusal, and the reset generation marked reused
  // before the write. The write is the role field only: no other registry side effect.
  const busHome = ctx.selection?.busHome ?? ctx.bus.home;
  let before = "", pane = "";
  const after = args.unset ? "" : args.role;
  const resetLock = acquireResetMutationLock(busHome, "tap role", undefined, "shared");
  try {
    assertResetUnfenced(busHome, "tap role");
    const lock = acquireRegistryLock(ctx.registryPath);
    if (!lock) throw new TapError(1, "registry_lock_busy", "retry in a moment", "the team registry is busy; no role changed");
    try {
      if (ctx.selection) assertSelectionCurrent(ctx.selection, lock);
      const doc = loadRegistry(ctx.registryPath);
      const refusal = registryWriteRefusal(ctx.registryPath, doc);
      if (refusal) throw new TapError(1, refusal.errorClass, refusal.action, refusal.detail);
      const row = seatMap(doc)[args.seat] as Record<string, unknown> | undefined;
      if (!row || typeof row !== "object") throw new TapError(1, "unknown_seat", "tap team", `no seat '${args.seat}' on team '${ctx.team}'; no role changed`);
      if (isDaemon(row)) throw new TapError(1, "usage_error", USAGE, `'${args.seat}' is pane-less infrastructure and takes no role`);
      before = seatRole(row);
      pane = typeof row.pane === "string" ? row.pane : "";
      if (before !== after && !args.dryRun) {
        if (after) row.role = after; else delete row.role;
        markResetGenerationReused(busHome, "tap role");
        atomicWrite(ctx.registryPath, `${pyJson(doc, 0)}\n`);
      }
    } finally { lock.release(); }
  } finally { resetLock.release(); }

  const changed = before !== after;
  let notice = "none";
  if (changed && !args.dryRun) {
    const actorName = actor.team && actor.team !== ctx.team ? `${actor.team}/${actor.handle}` : actor.handle;
    fx.event(ctx, { actor: actorName, handle: args.seat, pane, detail: `${before || "none"}->${after || "none"}` });
    const self = actor.team === ctx.team && actor.handle === args.seat;
    if (before === LEADER && after !== LEADER && !self) {
      const result = fx.notice(ctx).send(`${ctx.team}/${args.seat}`,
        `${actorLabel(actor, ctx.team)} removed your leader role on team ${ctx.team}.`,
        after ? `Your role is now: ${after}.` : "You hold no role now.");
      // A failed send may still have placed the note: say unconfirmed, never "not delivered".
      notice = result.rc === 0 ? `sent (${result.disposition})` : `delivery unconfirmed (rc ${result.rc})`;
    }
  }
  const verb = args.dryRun ? "would change" : changed ? "changed" : "unchanged";
  if (args.json) {
    fx.out(json({ team: ctx.team, handle: args.seat, before: before || null, after: after || null,
      changed, dry_run: args.dryRun, notice }) + "\n");
  } else {
    const transition = changed ? `${before || "none"} -> ${after || "none"}` : (after || "none");
    const tail = notice === "none" ? "" : `; notice to ${args.seat} ${notice}`;
    fx.out(`tap role: ${args.seat} ${verb}: ${transition}${tail}\n`);
  }
  return 0;
}

function readRoles(ctx: ResolvedContext, args: RoleArgs, fx: RoleEffects): number {
  const seats = seatMap(loadRegistry(ctx.registryPath));
  if (args.seat) {
    const row = seats[args.seat] as Record<string, unknown> | undefined;
    if (!row) throw new TapError(1, "unknown_seat", "tap team", `no seat '${args.seat}' on team '${ctx.team}'`);
    const role = seatRole(row);
    fx.out(args.json ? json({ team: ctx.team, handle: args.seat, role: role || null }) + "\n" : `${args.seat}: ${role || "none"}\n`);
    return 0;
  }
  const held = Object.keys(seats).sort().flatMap(handle => {
    const role = seatRole(seats[handle] as Record<string, unknown>);
    return role ? [{ handle, role }] : [];
  }).sort((a, b) => Number(b.role === LEADER) - Number(a.role === LEADER));
  if (args.json) fx.out(json({ team: ctx.team, roles: held }) + "\n");
  else if (!held.length) fx.out(`tap role: no seat on team '${ctx.team}' has a role (set one: tap role <seat> leader)\n`);
  else fx.out(held.map(entry => `${entry.handle}  ${entry.role}\n`).join(""));
  return 0;
}
