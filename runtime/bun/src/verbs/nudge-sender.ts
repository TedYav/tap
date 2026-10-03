// Who a `tap nudge` note is from (tap-gridx). The interrupt and fan-out forms
// send notes; both resolve their sender here, before any effect, so a refusal
// always names a recovery that works. Precedence: --from, then TAP_SELF, then
// the calling pane's own seat, then — only for a person at an interactive
// terminal who says yes — the reserved operator identity.

import { readSync } from "node:fs";

import { callingPane, observeCallingPane, observeSelfPane, resolveSelf, TapError, type ResolvedContext } from "../context";
import { USER_IDENTITY } from "../ids";
import { enrolledSeatForObservedPane, loadRegistry, seatMap } from "../registry";
import { parseTarget, SelectorError } from "../selector";
import { resolveSelection } from "../team-selection";

export const SENDER_RECOVERY = "pass --from <seat|team/seat>, or run from an interactive terminal to send as the operator";
export const OPERATOR_QUESTION = "No TAP seat in this terminal. Send this nudge as you (the operator)? [Y/n] ";

export interface NudgeSender {
  /** The handle send stamps as `from`: a seat, or the reserved operator identity. */
  handle: string;
  /** The team whose bus the note is sent from; the sender's own team. */
  team: string;
  /** The operator, not a seat. */
  user: boolean;
  /** The operator has not been asked yet (a dry run, or a deferred fan-out prompt). */
  wouldPrompt?: boolean;
}

export interface SenderInput {
  from: string;
  /** The target's team when the target was qualified: an operator note rides the target's own bus. */
  targetTeam?: string;
  dryRun?: boolean;
  /** Resolve the operator without asking yet: fan-out asks after it has shown the targets. */
  deferPrompt?: boolean;
  /** Registries the note will land on, checked for a legacy `user` seat before anyone is asked. */
  targetRegistries?: string[];
}

/** Seams for tests; production reads the process. */
export interface SenderIo {
  env: NodeJS.ProcessEnv;
  /** stdin and stderr are both terminals: a person can see the question and answer it. */
  interactive: () => boolean;
  /** Ask on stderr; the answer line, or null at EOF. */
  ask: (question: string) => string | null;
  /** The calling pane's seat on `ctx`, or "" when the pane is unregistered or there is no pane. */
  paneSeat: (ctx: ResolvedContext) => string;
  /** Resolve the sender's bus again, as nudgeContext does: the post-prompt recheck. */
  resolve: (input: SenderInput) => ResolvedContext;
}

/**
 * One answer line from fd 0, or null. Only a newline completes an answer: EOF
 * before it (Ctrl-D after a partial "y") is no answer at all, so it can never
 * be read as consent (partner review).
 */
export function readLine(readByte: (buffer: Buffer) => number = buffer => readSync(0, buffer, 0, 1, null)): string | null {
  const bytes: number[] = [];
  const one = Buffer.alloc(1);
  for (;;) {
    let n = 0;
    try { n = readByte(one); } catch { return null; }
    if (n === 0) return null;
    if (one[0] === 0x0a) return Buffer.from(bytes).toString("utf8");
    bytes.push(one[0]!);
  }
}

export const REAL_SENDER_IO: SenderIo = {
  env: process.env,
  interactive: () => process.stdin.isTTY === true && process.stderr.isTTY === true,
  ask: question => { process.stderr.write(question); return readLine(); },
  resolve: input => nudgeContext(input),
  paneSeat: ctx => {
    const seen = observeCallingPane();
    if (seen.state === "outside") return "";
    if (seen.state === "unobservable") {
      // Every unreadable observation refuses, a failed tmux inventory included
      // (partner review): without a readable inventory TAP cannot rule out
      // that this terminal is a seat, and with no tmux server there is no pane
      // to nudge anyway, so no exception would make a nudge deliverable.
      throw new TapError(1, "unregistered_sender", SENDER_RECOVERY,
        `cannot tell whether this terminal is a seat (${seen.refusal}); nothing sent`);
    }
    const pane = callingPane();
    if (!pane) throw new TapError(1, "unregistered_sender", SENDER_RECOVERY, "this pane changed while it was observed; nothing sent");
    try { return resolveSelf(ctx, pane, 1).handle; } catch (error) {
      // Only a readable registry with no row for this pane means "no seat
      // here". A stale, contested or unobservable pane identity propagates:
      // the operator prompt never stands in for a seat TAP could not verify.
      if (!(error instanceof TapError) || error.errorClass !== "unregistered") throw error;
    }
    return seatElsewhere(ctx, pane);
  },
};

/**
 * The pane is not a seat on the acting team. It may still be one on another
 * enrolled team, and then it is that seat, not the operator. Absent claims and
 * stale enrollments leave the operator path open; a claim TAP cannot read or
 * tell apart refuses rather than guess.
 */
function seatElsewhere(ctx: ResolvedContext, pane: Parameters<typeof observeSelfPane>[0]): string {
  const obs = observeSelfPane(pane);
  const found = enrolledSeatForObservedPane(obs.paneId, obs.session, obs.serverEpoch, process.env.TAP_INDEX_HOME);
  if (found.kind === "resolved") {
    throw new TapError(1, "unregistered_sender", `pass --from ${found.team}/${found.handle}`,
      `this pane is seat '${found.handle}' on team '${found.team}', not a seat on '${ctx.team}'; nothing sent`);
  }
  if (found.kind === "contested" || (found.kind === "unverified" && found.verdict === "unknown")) {
    throw new TapError(1, "unregistered_sender", SENDER_RECOVERY,
      `cannot tell whether this pane is a seat (${found.evidence}); nothing sent`);
  }
  return "";
}

/** Refuse when any registry the operator's note touches still has a seat named `user`. */
export function refuseLegacyUserSeat(registries: string[]): void {
  for (const path of new Set(registries)) {
    const doc = loadRegistry(path);
    if (!seatMap(doc)[USER_IDENTITY]) continue;
    const team = (doc.team as { name?: unknown } | undefined)?.name;
    throw legacyUserSeatRefusal(typeof team === "string" ? team : path);
  }
}

/** A seat registered as `user` before the reservation would share its mail with the operator. */
export function legacyUserSeatRefusal(team: string): TapError {
  return new TapError(1, "reserved_handle",
    `pass --from <seat|team/seat>; the seat named '${USER_IDENTITY}' must re-register under another handle`,
    `team '${team}' has a seat named '${USER_IDENTITY}', the reserved operator identity, so a nudge cannot be sent as the operator there; nothing sent`);
}

/**
 * Select the bus the nudge acts from: the cwd's (or TAP_HOME's) team, unless a
 * `team/seat` sender names its own. With no bus here, a `team/peer` target
 * anchors an operator note, so a terminal outside every enrolled checkout
 * still resolves. A TAP_HOME pin decides the bus and is honoured
 * exactly or refused: a sender on another team never redirects it.
 */
export function nudgeContext(input: SenderInput, io: SenderIo = REAL_SENDER_IO): ResolvedContext {
  const named = input.from.includes("/") || input.from.includes(":");
  const team = named ? senderAddress(input.from).team : "";
  const pin = io.env.TAP_HOME ?? "";
  let ctx: ResolvedContext;
  try {
    ctx = resolveSelection(pin, team);
  } catch (error) {
    if (!(error instanceof TapError) || error.errorClass !== "unanchored_bus" || team !== "") throw error;
    // No bus here and no named sender: a seat cannot be derived on any bus, so
    // only an operator note remains, and it rides the qualified target's bus.
    if (input.from === "" && input.targetTeam) return resolveSelection(pin, input.targetTeam);
    throw new TapError(error.code, error.errorClass, "name the team: --from <team>/<seat>, or a <team>/<peer> target", error.detail);
  }
  if (pin && named && ctx.team !== team) {
    throw new TapError(1, "usage_error", "unset TAP_HOME, or name a sender on its team",
      `TAP_HOME pins team '${ctx.team}', but the sender is on team '${team}'; nothing sent`);
  }
  return ctx;
}

function senderAddress(raw: string): { team: string; handle: string } {
  try {
    const parsed = parseTarget(raw);
    return { team: parsed.team, handle: parsed.handle };
  } catch (error) {
    if (error instanceof SelectorError) throw new TapError(1, "usage_error", "tap help nudge", `--from: ${error.detail}`);
    throw error;
  }
}

/** Resolve and validate the sender on `ctx`. Refuses before any effect. */
export function resolveNudgeSender(input: SenderInput, ctx: ResolvedContext, io: SenderIo = REAL_SENDER_IO): NudgeSender {
  let handle = "";
  if (input.from !== "") {
    handle = senderAddress(input.from).handle;
  } else {
    handle = io.env.TAP_SELF || io.paneSeat(ctx);
  }
  if (handle === "") return operator(input, ctx, io);
  if (handle === USER_IDENTITY) {
    throw new TapError(1, "reserved_handle", "omit --from and answer the prompt in your own terminal",
      `'${USER_IDENTITY}' is the reserved operator identity, not a seat; nothing sent`);
  }
  const row = seatMap(loadRegistry(ctx.registryPath))[handle] as Record<string, unknown> | undefined;
  if (!row || String(row.status ?? "active") !== "active") {
    throw new TapError(1, "unregistered_sender", SENDER_RECOVERY,
      `sender '${handle}' is not an active seat on team '${ctx.team}'; nothing sent`);
  }
  return { handle, team: ctx.team, user: false };
}

/**
 * No seat can be derived. Whoever answers yes at an interactive terminal sends
 * as the operator; there is deliberately no flag for it. This is consent, not
 * proof of a person: an agent's tool shell has no terminal and cannot answer,
 * but anything driving a terminal can.
 */
function operator(input: SenderInput, ctx: ResolvedContext, io: SenderIo): NudgeSender {
  if (!io.interactive()) {
    throw new TapError(1, "unregistered_sender", SENDER_RECOVERY,
      "this terminal is not a registered seat and is not interactive, so the sender is unknown; nothing sent");
  }
  refuseLegacyUserSeat([ctx.registryPath, ...(input.targetRegistries ?? [])]);
  const sender: NudgeSender = { handle: USER_IDENTITY, team: ctx.team, user: true };
  if (input.dryRun || input.deferPrompt) return { ...sender, wouldPrompt: true };
  confirmOperator(io);
  assertNudgeContextCurrent(input, ctx, io);
  return sender;
}

/**
 * The operator question can wait indefinitely, and the team may be reset,
 * retired or moved meanwhile (Codex). Re-resolve after the answer and refuse
 * unless the same team, registry and bus still answer, so the send never lands
 * on a bus that stopped being authoritative while the person was deciding.
 */
export function assertNudgeContextCurrent(input: SenderInput, ctx: ResolvedContext, io: SenderIo = REAL_SENDER_IO): void {
  let now: ResolvedContext;
  try { now = io.resolve(input); }
  catch (error) {
    const why = error instanceof TapError ? error.detail : String(error);
    throw new TapError(1, "team_moved", "re-run tap nudge", `team '${ctx.team}' changed while the operator was asked (${why}); nothing sent`);
  }
  if (now.team !== ctx.team || now.registryPath !== ctx.registryPath || now.bus.home !== ctx.bus.home) {
    throw new TapError(1, "team_moved", "re-run tap nudge",
      `team '${ctx.team}' changed while the operator was asked (bus ${ctx.bus.home} -> ${now.bus.home}); nothing sent`);
  }
}

/** Ask the operator question; refuses unless the answer is Enter, y or yes. */
export function confirmOperator(io: SenderIo = REAL_SENDER_IO): void {
  const answer = io.ask(OPERATOR_QUESTION);
  if (answer === null || !/^\s*(y|yes)?\s*$/i.test(answer)) {
    throw new TapError(1, "cancelled", "tap nudge ... --from <seat|team/seat>", "not sent as the operator; nothing sent");
  }
}
