#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isatty } from "node:tty";
import { basename, join } from "node:path";

import { cmdBus } from "./src/bus-archive";
import { cmdSessionComplete } from "./src/launcher/complete";
import { cmdSessionList } from "./src/launcher/list";
import { cmdSessionRepair } from "./src/launcher/repair";
import { cmdAdminFast } from "./src/verbs/admin-fast";
import { cmdAdmin } from "./src/verbs/admin";
import { onboarding } from "./src/onboarding";
import { verbose } from "./src/verbose";
import { tapScriptsDir } from "./src/scripts-dir";
import { noMachineIndexError, resolveContext, TapError } from "./src/context";
import { isOldStoreRefusal } from "./src/register-authority";
import { errorJson, humanAction, humanLine } from "./src/native-error";
import { envelopeField, validateEnvelope } from "./src/envelope";
import { loadGlobalRegistry, resolveTeamMarkerAware } from "./src/index-home";
import { resolvePayloadAddress } from "./src/payload-view";
import { normalizeSendTarget } from "./src/remote-target";
import { parseSendArgs } from "./src/slices/message-construction";
import { validId, validToken } from "./src/ids";
import { cmdRead } from "./src/verbs/read";
import { cmdShow } from "./src/verbs/show";
import { cmdOutstanding } from "./src/verbs/outstanding";
import { cmdRecap } from "./src/verbs/recap";
import { cmdPoll } from "./src/verbs/poll";
import { cmdOut } from "./src/verbs/out";
import { cmdOutRetire } from "./src/out-retire";
import { cmdRegister } from "./src/verbs/register";
import { withInvocationMemo } from "./src/invocation-memo";
import { cmdReply } from "./src/verbs/reply";
import { cmdResend } from "./src/verbs/resend";
import { cmdSend } from "./src/verbs/send";
import { recordRefusalBeforeSend, recordSendRefusal, refusalErrorId } from "./src/send-refusal-log";
import { cmdSpool } from "./src/verbs/spool";
import { cmdTeam, AGENT_FAMILIES } from "./src/verbs/team";
import { cmdModels, teamsView, writeRoutingResult } from "./src/routing";
import { cmdTeardown } from "./src/verbs/teardown";
import { cmdHealth } from "./src/verbs/health";
import { cmdSeatRefresh } from "./src/verbs/seat-refresh";
import { cmdDetective } from "./src/verbs/detective";
import { cmdDoctor } from "./src/verbs/doctor";
import { cmdNudge } from "./src/verbs/nudge";
import { cmdWorktree } from "./src/verbs/worktree";
import { cmdSetupMachine, cmdUninstall } from "./src/verbs/machine";
import { cmdSetup } from "./src/verbs/setup";
import { cmdPresets } from "./src/verbs/presets";
import { cmdAttach } from "./src/verbs/attach";
import { cmdDraft } from "./src/verbs/draft";
import { cmdPeek } from "./src/verbs/peek";
import { cmdPick } from "./src/verbs/pick";
import { cmdKeybinding } from "./src/verbs/keybinding";
import { cmdTmuxDefaults } from "./src/verbs/tmux-defaults";
import { cmdConfig } from "./src/verbs/config";
import { cmdWhoami } from "./src/verbs/whoami";
import { cmdProvenance } from "./src/verbs/provenance";
import { cmdWatch } from "./src/verbs/watch";
import { cmdGoalie } from "./src/verbs/goalie";
import { cmdRemind } from "./src/verbs/remind";
import { cmdWithdraw } from "./src/verbs/withdraw";
import { cmdCancel } from "./src/verbs/cancel";
import { cmdCrew } from "./src/verbs/crew";
import { cmdIncapable } from "./src/verbs/incapable";
import { cmdEscalate } from "./src/verbs/escalate";
import { cmdCompact } from "./src/verbs/compact";
import { cmdSelf } from "./src/verbs/self";
import { warnOverdueInbound } from "./src/overdue";
import { cmdCompletion } from "./src/completion";

import { cmdSeatUpDown } from "./src/seat-updown";
import { cmdDigestWindow } from "./src/verbs/digest-window";
import { cmdApprovalTimeout } from "./src/verbs/approval-timeout";
import { initArgv } from "./src/courier-argv";

export type Handler = (argv: string[], env?: NodeJS.ProcessEnv, stdin?: Buffer) => number | Promise<number>;
type NativeHandler = (argv: string[]) => number | Promise<number>;

const nativeHandlers = {
  compact: argv => cmdCompact(argv, tapScriptsDir()),
  self: argv => cmdSelf(argv, tapScriptsDir()),
  command: argv => cmdCompact(argv, tapScriptsDir(), true),
  bus: cmdBus,
  session: argv => {
    // Every session door enters its native owner.
    if (argv[0] === "complete") return cmdSessionComplete(argv.slice(1));
    if (argv[0] === "repair") return cmdSessionRepair(argv.slice(1));
    // Bare `tap session`, `list`, and flag-led forms are the snapshot; a `list`
    // token was consumed as the subcommand, flag forms arrive as-is.
    if (argv.length === 0 || argv[0] === "list" || argv[0]!.startsWith("--")) {
      return cmdSessionList(argv[0] === "list" ? argv.slice(1) : argv);
    }
    if (argv[0] === "resume" || argv[0] === "restart") {
      const door = argv[0];
      return import("./src/launcher/session-doors").then(({ cmdSessionDoor }) => cmdSessionDoor(door, argv.slice(1), tapScriptsDir()));
    }
    if (argv[0] === "fork") return import("./src/launcher/fork").then(({ cmdSessionFork }) => cmdSessionFork(argv.slice(1), tapScriptsDir()));
    if (argv[0] === "relaunch") return import("./src/launcher/relaunch").then(({ cmdSessionRelaunch }) => cmdSessionRelaunch(argv.slice(1)));
    if (argv[0] !== "launch") throw new TapError(1, "unknown_subcommand", "tap help session", `unknown session subcommand '${argv[0]}'`);
    return import("./src/launcher/new").then(({ cmdSessionLaunch }) => cmdSessionLaunch(argv.slice(1), tapScriptsDir()));
  },
  admin: argv => {
    const scripts = tapScriptsDir();
    // Checkpoint C (admin-r7): every admin form is native; --fast keeps its
    // own native census.
    if (argv.includes("--fast")) return cmdAdminFast(argv, scripts);
    return cmdAdmin(argv, scripts);
  },
  detective: async argv => {
    try { return await cmdDetective(argv); }
    catch (error) {
      if (error instanceof TapError) throw error;
      throw new TapError(1, "recovery_failed", "tap debug recovery", String(error));
    }
  },
  out: (argv) => cmdOut(argv, tapScriptsDir()),
  shutdown: (argv) => cmdOutRetire(argv, "shutdown"),
  // Same cutover shape as health: the Bash body is deleted in this commit.
  nudge: (argv) => cmdNudge(argv, tapScriptsDir(), AGENT_FAMILIES),
  // Same cutover shape as health: the Bash body (tap-worktree.sh) is deleted in
  // this commit.
  worktree: cmdWorktree,
  unregister: (argv) => cmdOut(argv, tapScriptsDir()),
  // R3 checkpoint C: the register cutover — one native owner for every form
  // (in|register alias, pane, poll, offline, list-history); the Bash body is
  // deleted in the same PR. The invocation-memo scope arms the ps-table and
  // git-root memos for this verb's body only; every other consumer keeps
  // fresh reads.
  register: (argv) => withInvocationMemo(() => cmdRegister(argv)),
  in: (argv) => withInvocationMemo(() => cmdRegister(argv)),
  resend: (argv) => cmdResend(argv, tapScriptsDir()),
  roster: argv => {
    if (argv.includes("--json")) process.env.TAP_JSON = "1";
    throw new TapError(1, "renamed_verb", "tap team", "tap roster is now: tap team");
  },
  reset: argv => {
    if (argv.includes("--json")) process.env.TAP_JSON = "1";
    throw new TapError(1, "renamed_verb", "tap team reset", "tap reset moved to tap team reset (recoverable team reinitialization)");
  },
  // Native on every form and born with no Bash twin.
  withdraw: cmdWithdraw,
  cancel: (argv) => cmdCancel(argv, tapScriptsDir()),
  // R11 U-C: same in-process shape as attach/cancel — the Bash body
  // (tap-crew.sh) is deleted in this commit.
  crew: (argv) => cmdCrew(argv, tapScriptsDir()),
  // Replacement owns its validation and effects; dispatch never rewrites rows.
  clear: async argv => (await import("./src/launcher/replace")).cmdClearNative(argv),
  // send-reply-r2 checkpoint A (U1): when --reply-to names an existing message
  // id, `tap send <dest> --reply-to <id>` IS `tap reply <id>` — the alias
  // composes here at the router layer (never inside send.ts, which must not
  // import reply.ts) and the parser/resolver are the same ones reply uses.
  send: (argv) => {
    const aliasArgv = aliasOrRecordRefusal(argv);
    if (aliasArgv) return replyAliasOrRecordRefusal(aliasArgv);
    return cmdSend(argv, tapScriptsDir(), AGENT_FAMILIES);
  },
  // tap-oglkh: a work order is a VERB. `assign` is exactly `tap send
  // --expect-reply --kind order` with the internal flags AFTER the caller's,
  // because the parser is last-write-wins — the obligation and the kind are
  // invariants, not defaults. TAP_ASSIGN_VERB=1 is what the construction
  // module reads to refuse `--fyi`/`--note` with assign's own sentence and to
  // refuse an unattended sender rather than downgrade it (tap.sh:785 shape).
  assign: (argv) => {
    process.env.TAP_ASSIGN_VERB = "1";
    // The invariants go AFTER the caller's argv (tap.sh:673-674) — which also
    // puts them into any alias composition: `tap assign <dest> --reply-to <id>`
    // enters the same Bash alias block, so the composed reply carries
    // kind: order and reply: expected exactly as the plain assign does.
    const fullArgv = [...argv, "--expect-reply", "--kind", "order"];
    const aliasArgv = aliasOrRecordRefusal(fullArgv);
    if (aliasArgv) return replyAliasOrRecordRefusal(aliasArgv);
    return cmdSend(fullArgv, tapScriptsDir(), AGENT_FAMILIES);
  },
  reply: (argv) => cmdReply(argv, tapScriptsDir(), AGENT_FAMILIES),
  poll: cmdPoll,
  read: cmdRead,
  show: cmdShow,
  provenance: argv => cmdProvenance(argv, tapScriptsDir()),
  who: argv => cmdProvenance(argv, tapScriptsDir()),
  outstanding: cmdOutstanding,
  recap: cmdRecap,
  spool: (argv) => cmdSpool(argv, tapScriptsDir()),
  team: (argv) => cmdTeam(argv, tapScriptsDir()),
  models: cmdModels,
  teams: async (argv): Promise<number> => {
    if (argv[0] === "refresh") return runNative("admin", nativeHandlers.admin, argv);
    const name = argv[0], scripts = tapScriptsDir();
    if (name !== undefined && !name.startsWith("-")) {
      const selected = resolveTeamMarkerAware(name);
      if (selected.marker === "absent") throw noMachineIndexError(process.env.TAP_VERB || "tap");
      if (!selected.root || !["ok", "unreachable", "historical"].includes(selected.status)) {
        process.stderr.write(`tap teams: no enrolled team '${name}' in the machine index\n`);
        return 1;
      }
      if (!validToken(name)) throw new TapError(1, "usage_error", "tap help", `--team '${name}' fails charset ^[A-Za-z0-9][A-Za-z0-9._-]*$`, process.env.TAP_VERB || "tap");
      if (selected.status !== "ok") throw new TapError(1, "registry_unreachable", "tap doctor", `acting registry for team '${name}' is unreachable (flip marker live/invalid?)`, process.env.TAP_VERB || "tap");
      // The roster's explicit selector defeats ambient bus/registry pins without
      // mutating the environment inherited by sibling fleet observations.
      return cmdTeam(["roster", ...argv], scripts);
    }
    return writeRoutingResult(await teamsView(argv, scripts));
  },
  teardown: argv => cmdTeardown("teardown", argv),
  restore: argv => cmdTeardown("restore", argv),
  // Zero-write evidence census (tap-diagnostics-u1): the whole call — dispatcher
  // skip through census render — must never mutate a byte. Its Bash twin was
  // deleted in the same commit.
  health: (argv) => cmdHealth(argv, tapScriptsDir()),
  // Same cutover shape as health: the Bash body is deleted in this commit.
  refresh: (argv) => cmdSeatRefresh(argv, tapScriptsDir()),
  // Doctor cutover (tap-hgf07): zero-write diagnostics, so the whole call —
  // dispatcher skip through render — judges the bus as found. Its Bash twin is
  // deleted in this commit.
  doctor: (argv) => cmdDoctor(argv, tapScriptsDir()),
  // `tap done` is a tombstone: it reads no bus, registry or pane and writes no
  // receipt or audit row, so every argument shape answers the same. Settlement
  // lives in reply (an ask) and read (a note); verbs/done.ts keeps the shared
  // authority and settle primitives reply uses.
  done: argv => {
    if (argv.includes("--json")) process.env.TAP_JSON = "1";
    throw new TapError(2, "done_retired", "tap reply <id> --by <you> -f <file>   # a note settles on: tap read <id>",
      "tap done is retired and settles nothing", undefined, "none");
  },
  whoami: cmdWhoami,
  "digest-window": cmdDigestWindow,
  "approval-timeout": cmdApprovalTimeout,
  // Every arm is native since W3: `tick` runs the tick body here, `run` re-execs into
  // the loop's own entry (watch-run.ts).
  watch: (argv) => cmdWatch(argv, tapScriptsDir()),
  // R6 U3: the goalie verb is native — on/off/status/verdict/reap here, `tick`
  // through goalie-tick.ts, `run` re-execs into goalie-run.ts. The Bash body
  // (tap-goalie.sh) is deleted in the same commit, so a stale rollback row is
  // ignored via the retired list.
  goalie: (argv) => cmdGoalie(argv, tapScriptsDir()),
  // Every form is native (the `remind` closure): the verb has no Bash-owned row.
  remind: (argv) => cmdRemind(argv, tapScriptsDir()),
  up: (argv) => cmdSeatUpDown("up", argv, tapScriptsDir()),
  down: (argv) => cmdSeatUpDown("down", argv, tapScriptsDir()),
  incapable: (argv) => cmdIncapable(argv),
  escalate: cmdEscalate,
  presets: cmdPresets,
  config: cmdConfig,
  draft: cmdDraft,
  peek: argv => cmdPeek(argv, tapScriptsDir()),
  pick: argv => cmdPick(argv),
  keybinding: cmdKeybinding,
  "tmux-defaults": cmdTmuxDefaults,
  // R11 U-A: the whole public verb is native — positional, --next and the
  // -i picker arm here; the Bash body (tap-attach.sh) is deleted in this
  // commit, so a stale rollback row is ignored via the retired list.
  attach: argv => cmdAttach(argv, tapScriptsDir()),
  completion: cmdCompletion,
  setup: argv => argv.includes("--machine") ? cmdSetupMachine(argv) : cmdSetup(argv, tapScriptsDir()),
  uninstall: cmdUninstall,
} satisfies Record<string, NativeHandler>;
// Keep synchronous entry types for existing direct callers; detective is asynchronous.
export const NATIVE_HANDLERS: typeof nativeHandlers & Record<string, NativeHandler> = nativeHandlers;
const NATIVE_VERBS = new Set(Object.keys(NATIVE_HANDLERS));
const HELP = new Set(["help", "-h", "--help"]);
const RESERVED = new Set(["help", "-h", "--help", "try"]);

function trace(path: string | undefined, runtime: "native" | "bash", verb: string): void {
  if (path) appendFileSync(path, `${runtime} ${verb || "<none>"}\n`);
}

// v0.22 item 14a, ported from tap-send.sh:232-271 (send-reply-r2 checkpoint A,
// U1): `send <dest> --reply-to <message-id>` with no --in-reply-to and a valid
// id that resolves to exactly one enrolled-team payload is the target-explicit
// alias for `reply`. Values that do not resolve keep the established
// `--reply-to <handle>` routing behavior (this returns null and send proceeds).
// The refusal bytes, the allowed/forbidden option split and the original-sender
// check are the incumbent's, byte for byte. The argv scan is ONE parser — the
// shared send/assign parse (tap_bun_construct, tap-send.sh:206) — so its
// refusals (unknown option, missing operand, assign's --fyi/--note sentence)
// land in the incumbent's order, before any alias decision.
const NO_LOCAL_BUS = "/nonexistent-tap-alias-local-bus";
// The alias scan parses argv before cmdSend runs, so its refusals never reach
// cmdSend's own refusal log (tap-i83d9). A refusal here means cmdSend is never
// called, so each refused send is still counted once.
function aliasOrRecordRefusal(argv: string[]): string[] | null {
  try { return composeReplyAlias(argv); }
  catch (error) {
    const refusedAs = refusalErrorId(error);
    if (refusedAs !== null) recordSendRefusal(refusedAs, {}, "pre");
    throw error;
  }
}
// The composed reply prepares before it sends. A refusal in that preparation is
// a refused send cmdSendOutcome never saw; once cmdSendOutcome is entered it
// counts its own, and a later failure (the inbound's settle) is not a refusal.
function replyAliasOrRecordRefusal(aliasArgv: string[]): number {
  try { return cmdReply(aliasArgv, tapScriptsDir(), AGENT_FAMILIES); }
  catch (error) {
    const refusedAs = refusalErrorId(error);
    if (refusedAs !== null) recordRefusalBeforeSend(refusedAs);
    throw error;
  }
}
export function composeReplyAlias(argv: string[]): string[] | null {
  const args = parseSendArgs(argv, process.env.TAP_ASSIGN_VERB === "1", { onJson: () => { process.env.TAP_JSON = "1"; } });
  if (!args.replyToSet || args.inReplyTo !== "" || !validId(args.replyTo)) return null;
  // tap-send.sh:168-172 normalizes the colon destination form BEFORE the
  // alias block, so the original-sender comparison (and a malformed colon
  // form's usage refusal) sees the slash form exactly as Bash's does.
  const to = normalizeSendTarget(args.to);
  if (!to) return null;
  // The bus selection is send's own, and `--team` applies BEFORE payload
  // resolution (tap-send.sh:216 applies the override before the alias block):
  // a pane-less caller in another cwd anchors through the named team, and the
  // local bus the payload search starts from is the post-override bus.
  // An unanchorable caller falls through: the incumbent checks its bus anchor
  // BEFORE the alias block (tap-send.sh:222-230), and cmdSend raises the same
  // unanchored_bus — including the calling-pane re-anchor — here.
  const teamFlag = args.team && !process.env.TAP_HOME ? args.team : "";
  let localBus = "";
  if (process.env.TAP_HOME) localBus = process.env.TAP_HOME;
  else {
    try { localBus = resolveContext(process.cwd(), process.env, teamFlag ? { explicitTeam: teamFlag } : undefined).bus.home; }
    catch { return null; }
  }
  let payload = "";
  // How `payload` was found: the existsSync arm is the caller's own bus; the
  // resolver arm may name ANOTHER team's bus. reply re-resolves a bare id
  // local-first, so an id validated through a foreign bus must be pinned to
  // that exact file with --payload or a same-id local artifact could win the
  // second lookup.
  let payloadForeign = false;
  const localPath = localBus ? join(localBus, "payloads", `${args.replyTo}.md`) : "";
  if (localPath && existsSync(localPath)) {
    payload = localPath;
  } else {
    const index = loadGlobalRegistry(process.env.TAP_INDEX_HOME);
    let resolution: ReturnType<typeof resolvePayloadAddress> | null = null;
    try { resolution = resolvePayloadAddress(args.replyTo, localBus || NO_LOCAL_BUS, index.marker === "invalid" ? "" : index.path, "payloads"); }
    catch { resolution = null; }
    if (resolution === null || resolution.status === "missing" || resolution.status === "badid") return null;
    if (resolution.status === "ambiguous") {
      throw new TapError(1, "ambiguous_payload", `tap reply ${args.replyTo} --payload <abs-path> -f <body-file>`,
        `id '${args.replyTo}' resolves to more than one enrolled team bus — disambiguate with --payload <abs-path>`);
    }
    if (resolution.status === "found") { payload = resolution.path; payloadForeign = true; }
  }
  if (!payload) return null;
  if (args.bodyFile === "" || args.message !== null || args.payloadFile !== "") {
    throw new TapError(1, "usage_error", "tap help send",
      "message-id --reply-to alias requires only -f <body-file> as its body source");
  }
  if (args.fromSet || args.id !== "" || args.crossWorktree || args.fyi || args.note || args.polite || args.politeTimeoutSet || args.urgentSet || args.wake || args.noSpool || args.noAutoReplyTo || args.json || args.remoteRegistry !== "") {
    throw new TapError(1, "usage_error", "tap help send",
      "message-id --reply-to alias does not accept send-only options");
  }
  let raw: string;
  try { raw = readFileSync(payload, "utf8"); }
  catch {
    throw new TapError(1, "usage_error", "tap help reply", `inbound payload '${args.replyTo}' has an invalid envelope`);
  }
  if (!validateEnvelope(raw).ok) {
    throw new TapError(1, "usage_error", "tap help reply", `inbound payload '${args.replyTo}' has an invalid envelope`);
  }
  const from = envelopeField(raw, "from") ?? "";
  const fromTeam = envelopeField(raw, "from_team") ?? "";
  const expected = fromTeam ? `${fromTeam}/${from}` : from;
  if (to !== expected) {
    throw new TapError(1, "usage_error", "tap help send",
      `send target '${to}' does not match original sender '${expected}' for reply-to '${args.replyTo}'`);
  }
  // A pinned reply names the canonical id the resolver found: reply's explicit
  // payload check requires the reference to equal the file's id, so a 12-hex
  // suffix alias would otherwise refuse.
  // --preview rides only when the caller gave it: reply reads its presence as intent (tap-zlfg5).
  const previewArgv = args.previewSet ? ["--preview", args.preview] : [];
  const replyArgv = payloadForeign
    ? [basename(payload, ".md"), "-f", args.bodyFile, ...previewArgv, "--payload", payload]
    : [args.replyTo, "-f", args.bodyFile, ...previewArgv];
  if (args.team) replyArgv.push("--team", args.team);
  if (args.pane) replyArgv.push("--pane", args.pane);
  if (args.kindSet) replyArgv.push("--kind", args.kind);
  if (args.expectReply) replyArgv.push("--expect-reply");
  return replyArgv;
}

function reserved(argv: string[]): boolean {
  return RESERVED.has(argv[0] ?? "") || (argv.length === 2 && HELP.has(argv[1] ?? ""));
}

/**
 * A `tap ask` child is a stateless one-shot: TAP_STATELESS=1 and no seat. Self identity is
 * also walked from the process tree's first tty, which reaches the invoking seat's pane, so
 * environment scrubbing alone cannot keep the child from acting as that seat. Fail closed:
 * every verb but help refuses here, before any bus or registry resolution. `version` is not
 * exempt: it has no static leaf, so it would fall into onboarding, which can create state.
 */
function statelessRefusal(argv: string[], help: typeof import("./src/help") | undefined): number | null {
  if (process.env.TAP_STATELESS !== "1") return null;
  const verb = argv[0];
  if (verb === undefined || verb === "help") return null;
  // `tap -h ask` / `tap --help ask` are the ask-help aliases main serves before any state read.
  if (HELP.has(verb) && argv.length === 2 && argv[1] === "ask") return null;
  if (argv.some(arg => HELP.has(arg)) && help?.isHelpForm(argv)) return null;
  if (argv.includes("--json")) process.env.TAP_JSON = "1";
  return nativeError(verb, new TapError(1, "stateless_child", "tap help",
    `tap ask child: a stateless one-shot seat has no TAP identity and cannot run ${verb}`));
}

function nativeError(verb: string, error: unknown): number {
  const json = process.env.TAP_JSON === "1";
  const tagged = error as Error & { tapErrorClass?: string; tapAction?: string };
  if (tagged?.tapErrorClass) {
    if (json) process.stdout.write(errorJson(tagged.tapErrorClass, tagged.tapAction ?? "", tagged.message));
    else process.stderr.write(`tap ${verb}: ${humanLine(tagged.message)}; next: ${humanAction(tagged.tapAction ?? "")}\n`);
    return 1;
  }
  if (error instanceof TapError) {
    if (json) { process.stdout.write(errorJson(error.errorClass, error.action, error.detail, error.effect)); return error.code; }
    const label = error.verbLabel ?? `tap ${verb}`;
    process.stderr.write(`${label}: ${humanLine(error.detail)}; next: ${humanAction(error.action)}\n`);
    return error.code;
  }
  if (isOldStoreRefusal(error)) {
    // An old_store from a layer below context.ts (SelectorError, OldStoreError) is a typed refusal, never a crash.
    const carrier = error as Error & { action?: string; detail?: string };
    const detail = carrier.detail ?? carrier.message, action = carrier.action ?? "";
    if (json) process.stdout.write(errorJson("old_store", action, detail));
    else process.stderr.write(`tap ${verb}: ${humanLine(detail)}; next: ${humanAction(action)}\n`);
    return 1;
  }
  throw error;
}
export function runNative(verb: string, handler: (argv: string[]) => number, argv: string[]): number;
export function runNative(verb: string, handler: NativeHandler, argv: string[]): number | Promise<number>;
export function runNative(verb: string, handler: NativeHandler, argv: string[]): number | Promise<number> {
  try {
    const result = handler(argv);
    // `tap assign` IS tap-send.sh with TAP_VERB="tap send": its refusals are
    // labelled "tap send:" on the Bash door, and so here.
    return result instanceof Promise ? result.catch(error => nativeError(verb === "assign" ? "send" : verb, error)) : result;
  } catch (error) { return nativeError(verb === "assign" ? "send" : verb, error); }
}

export function route(
  argv: string[],
  handlers: Record<string, NativeHandler>,
  fallback: Handler,
  tracePath = process.env.TAP_BUN_ROUTE_TRACE,
): number | Promise<number> {
  const verb = argv[0] ?? "";

  if (!reserved(argv) && NATIVE_VERBS.has(verb)) {
    const handler = handlers[verb];
    if (!handler) throw new Error(`native TAP handler is not linked: ${verb}`);
    const rc = runNative(verb, handler, argv.slice(1));
    if (rc instanceof Promise) return rc.then(status => { trace(tracePath, "native", verb); return status; });
    trace(tracePath, "native", verb);
    return rc;
  }

  trace(tracePath, "bash", verb);
  return fallback(argv);
}

/** A leaf child `[...command, ...argv]` with the fallback env guard, stdin handoff and signal forwarding. */
export function createLeafFallback(command: string[], childEnv: NodeJS.ProcessEnv = {}): Handler {
  const label = command.join(" ");
  return async (argv, env = process.env, stdin?: Buffer) => {
    const fallbackEnv: NodeJS.ProcessEnv = { ...env, ...childEnv };
    let child: Bun.Subprocess;
    try {
      child = Bun.spawn([...command, ...argv], {
        env: fallbackEnv,
        // Bytes the native door already read from stdin travel to the child;
        // otherwise the child reads the same stdin the router was given.
        stdin: stdin ?? "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`tap: could not start '${label}': ${detail}\n`);
      return 1;
    }

    const forwardInt = () => child.kill("SIGINT");
    const forwardTerm = () => child.kill("SIGTERM");
    const forwardHup = () => child.kill("SIGHUP");
    process.on("SIGINT", forwardInt);
    process.on("SIGTERM", forwardTerm);
    process.on("SIGHUP", forwardHup);
    try {
      return await child.exited;
    } finally {
      process.off("SIGINT", forwardInt);
      process.off("SIGTERM", forwardTerm);
      process.off("SIGHUP", forwardHup);
    }
  };
}

/** route()'s fallback: bare `tap`, the init leaf, or the unknown-verb refusal. */
export function routerFallback(scriptsDir: string): Handler {
  return async (argv, env = process.env, stdin?: Buffer) => {
    const verb = argv[0] ?? "";
    // bin/tap owns every debug form (with or without -v) before it execs this
    // router, so only a direct caller of main.ts arrives here.
    if (verb === "debug" || (verb === "help" && argv[1] === "debug")) {
      process.stderr.write("tap: debug runs through the installed tap (bin/tap); next: tap debug --help\n");
      return 1;
    }
    if (verb === "") {
      // A bare `tap` prints the overview as an error.
      const result = (await import("./src/help")).lookupHelp([]);
      process.stderr.write(result.stdout + result.stderr);
      return 1;
    }
    // init owns registry creation and runs as its own Bun process (initArgv).
    if (verb === "init") return createLeafFallback(initArgv(scriptsDir, [], env))(argv.slice(1), env, stdin);
    process.stderr.write(`tap: unknown command '${verb}' (run \`tap help\` for the verb list)\n`);
    return 1;
  };
}

if (import.meta.main) {
  // Bun writes its startup termios back on every std-fd tty at exit, over a
  // mode the foreground owner set while this process held the tty: during a
  // Bash child (tap-uzhrp) or a native verb parked on tmux (tap-5jbnq). Once
  // the loop has drained, end without that write. A caller with no tty on
  // any std fd has no mode to clobber and exits normally.
  if ([0, 1, 2].some(fd => isatty(fd))) {
    process.once("beforeExit", async code => { await (await import("./src/launcher/prompt")).exitKeepingTerminal(code); });
  }
  const argv = process.argv.slice(2);
  // Recognize launch help before debug journaling as well as onboarding.
  const helpInput = [...argv];
  while (helpInput[0] === "-v" || helpInput[0] === "--verbose") helpInput.shift();
  let help: typeof import("./src/help") | undefined;
  const launchHelpRequested = helpInput.some(arg => HELP.has(arg))
    && (help ??= await import("./src/help")).isLaunchHelp(helpInput);

  const stateless = process.env.TAP_STATELESS === "1" ? statelessRefusal(helpInput, help ??= await import("./src/help")) : null;

  // A TAB press is an observational leaf, even with inherited verbose/debug
  // settings. It must return before public journaling and onboarding.
  if (stateless !== null) {
    process.exitCode = stateless;
  } else if (argv[0] === "completion" && !argv.slice(1).some(arg => HELP.has(arg))) {
    process.env.TAP_VERBOSE = "0";
    process.exitCode = cmdCompletion(argv.slice(1));
  } else {
  // The machine journal records every public command in-process: bin/tap
  // marks its exec so tap.sh re-entries never journal twice, and this pid is
  // the caller's. Doctor and launch help are exempt: their zero-write promise
  // covers the whole public command. A failed write is reported and the command continues.
  if (process.env.TAP_INTERNAL_PUBLIC_COMMAND === "1") {
    delete process.env.TAP_INTERNAL_PUBLIC_COMMAND;
    const verb = argv.find(arg => arg !== "-v" && arg !== "--verbose");
    // A regular file (symlinks followed), as bin/tap's `[ -f ]` gate was: a
    // FIFO or other special file there is not recording, and reading it
    // would block the command itself.
    const marker = join(process.env.TAP_INDEX_HOME || join(homedir(), ".tap"), "debug", "enabled.json");
    let recording = false;
    // A stateless child neither reads the machine index nor journals, help and version included.
    if (process.env.TAP_STATELESS !== "1") {
      try { recording = statSync(marker).isFile(); } catch { /* absent or unreadable: not recording */ }
    }
    if (!launchHelpRequested && verb !== "doctor" && verb !== "completion" && recording) {
      try { (await import("./src/debug-capture")).recordCommand(argv, process.env, process.pid); }
      catch (error) { console.error("tap debug: journal write failed: " + (error as Error).message); }
    }
  }
  while (argv[0] === "-v" || argv[0] === "--verbose") {
    process.env.TAP_VERBOSE = "1";
    argv.shift();
  }
  // A stateless child's bare `tap` is static help: it never reaches onboarding or the bus.
  if (process.env.TAP_STATELESS === "1" && argv.length === 0) argv.push("help");
  if (argv[0] === "launch" && !reserved(argv)) argv.splice(0, 1, "session", "launch");
  // Every dispatch traces under -v, help and ask included (protocol-evolution
  // part 01, Verbose diagnostics).
  verbose("dispatch", { verb: argv[0] ?? "", cwd: process.cwd() });
  // Ask never enters context/onboarding. Its Bash door also reaches this one
  // owner.
  if (argv[0] === "ask" || (argv.length === 2 && ["help", "-h", "--help"].includes(argv[0] ?? "") && argv[1] === "ask")) {
    const { cmdAsk } = await import("./src/verbs/ask");
    process.exitCode = await cmdAsk(argv[0] === "ask" ? argv.slice(1) : ["--help"]);
  } else if (argv[0] === "help" && argv[1] === "skill") {
    // Skill lookup is read-only help: no onboarding or bus initialization.
    process.exitCode = (await import("./src/skill-path")).cmdHelpSkill(argv.slice(2), tapScriptsDir());
  } else if (argv.some(arg => HELP.has(arg)) && (help ??= await import("./src/help")).isHelpForm(argv)) {
    // Help is static text: no onboarding, bus read, or rollback selector.
    const result = help.helpArgv(argv);
    trace(process.env.TAP_BUN_ROUTE_TRACE, "native", "help");
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exit;
  } else {
    // Syntax precedes enrollment and lifecycle effects. Reuse the launch
    // parser without warning output; the real door owns passthrough notices.
    const launchArgs = argv[0] === "session" && argv[1] === "launch"
      ? (await import("./src/launcher/new")).parseLaunchCommand(argv.slice(2)) : null;
    if (typeof launchArgs === "number") {
      process.exitCode = launchArgs;
    } else {
      const fallback = routerFallback(tapScriptsDir());
      const onboardingStatus = await onboarding(argv, () => fallback(["init"]));
      process.env.TAP_ONBOARDING_CHECKED = "1";
      if (onboardingStatus === null) warnOverdueInbound(argv);
      const status = onboardingStatus ?? await route(
        argv,
        NATIVE_HANDLERS,
        fallback,
        process.env.TAP_BUN_ROUTE_TRACE,
      );
      verbose("dispatch_exit", { status });
      // Let pending stdout/stderr writes drain; forced exit truncates pipe output.
      process.exitCode = status;
    }
  }
  }
}
