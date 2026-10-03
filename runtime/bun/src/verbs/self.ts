// `tap self <compact|goal|loop|clear|rebrief>`: harness self-control for the
// calling seat. The human decides to fire it, the agent composes the argument,
// and this verb enforces the allowlist (set/strengthen only) before any pane
// effect. clear/rebrief arm the native reset observer; all supported compact harnesses
// arm the native compaction worker; goal and loop submit through
// the courier's typed-prefix arm, which types the command token ahead of the
// payload (tap-lmbs). Exit codes: 0 submitted/armed, 1
// validation, 3 pane gone, 4 deferred, 5 submit unverified, 6 unsupported,
// 8 clear/rebrief observer armed. Compact returns 0 queued/armed before input.
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { callerPaneObservation, observeCallerPaneChain, resolveContext, resolveSelf, TapError, type IdentityPaneObservation, type ResolvedContext } from "../context";
import { loadRegistry, seatMap } from "../registry";
import { atomicWrite } from "../fsatomic";
import { markResetGenerationReused } from "../reset";
import { armSelfCompact } from "../self-compact";
import { armSelfRecovery, parseOptions as parseRecovery } from "../self-rebrief";
import { focusNarrowing, handoffPing } from "../compact-focus";
import { submitVerify, type BoundRecipient, type SubmitResult } from "../courier";
import { permittedTakeBack, DARK_EFFECTS } from "../deliver";
import { draftEffects } from "../spool-drain-effects";
import { agentFamilies, harnessFamily } from "../observe";
import { paneHarnessCommand } from "../observe-gather";
import { tmuxReadOnly } from "../tmux";
import { checkHarness, checkText, commandPrefix, family, type SelfVerb } from "../self-gate";
import { tapScriptsDir } from "../scripts-dir";

const SCRIPTS = tapScriptsDir();
const say = (message: string) => process.stderr.write(`self: ${message}\n`);

export interface SelfOptions { verb: SelfVerb; text: string; pane?: string; harness?: string; interval?: string; handoff?: string }

const USAGE = "usage: tap self <compact|goal|loop> [--pane <tmux-target>] [--harness <name>] [--interval <N><s|m|h|d>] [--handoff <file>] [--] <text>\n" +
  "       tap self <clear|rebrief> [--pane <tmux-target>] [--harness <name>] [--handoff <file>] [--charter <file>] [--notify <seat>]";

export function parseSelf(argv: string[]): SelfOptions {
  const verb = argv[0];
  if (!["compact", "goal", "loop"].includes(verb ?? "")) {
    throw new TapError(1, "usage_error", "tap help self", `first argument must be a verb: compact|goal|loop|clear|rebrief\n${USAGE}`, "tap self");
  }
  const out: SelfOptions = { verb: verb as SelfVerb, text: "" };
  const flags = { "--pane": "pane", "--harness": "harness", "--interval": "interval", "--handoff": "handoff" } as const;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") { out.text = argv.slice(i + 1).join(" "); break; }
    if (arg in flags) {
      const value = argv[i + 1];
      if (value === undefined) throw new TapError(1, "usage_error", "tap help self", `${arg} requires an argument`, "tap self");
      const field = flags[arg as keyof typeof flags];
      if (out[field] !== undefined) throw new TapError(1, "usage_error", "tap help self", `${arg} may be passed once`, "tap self");
      out[field] = value; i++;
      continue;
    }
    if (arg.startsWith("--")) throw new TapError(1, "unknown_option", "tap help self", `unknown flag: ${arg}`, "tap self");
    // Positional text without `--`: everything from here on.
    out.text = argv.slice(i).join(" ");
    break;
  }
  return out;
}

/**
 * The agent-authored handoff, copied to the bus BEFORE any pane effect: after
 * the submit is too late, because /compact consumes the turn this runs in.
 */
export function writeHandoff(busHome: string, seat: string, source: string, now = new Date()): string {
  const body = readFileSync(resolve(source), "utf8");
  const safe = seat.replace(/[^A-Za-z0-9._-]/g, "-");
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const dir = join(busHome, "handoff");
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${safe}-${stamp}.md`);
  const header = `# TAP compaction handoff — ${seat}\n# written ${now.toISOString().replace(/\.\d+Z$/, "Z")}, BEFORE an explicit /compact\n#\n` +
    "# You are reading this after a compaction. Your context is a SUMMARY of\n" +
    "# the work; these bytes were written by the agent that still had all of\n" +
    "# it. Where the two disagree, this file is the record.\n\n";
  atomicWrite(dest, header + body);
  markResetGenerationReused(busHome, "handoff");
  return dest;
}

function validHandoff(path: string): string | null {
  // Regular files only: a FIFO or device could block or stream without end.
  try { if (!statSync(resolve(path)).isFile()) return `--handoff must be a regular file: ${path}`; }
  catch { return `--handoff file is missing or unreadable: ${path}`; }
  let bytes: Buffer;
  try { bytes = readFileSync(resolve(path)); } catch { return `--handoff file is missing or unreadable: ${path}`; }
  // An EMPTY handoff is worse than none: it survives the compaction and reads as
  // a positive statement that nothing was in flight.
  if (!bytes.length) return `--handoff file is empty: ${path} — refusing, because an empty handoff reads as 'nothing was in progress'`;
  return null;
}

const mintId = () => `self-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${randomBytes(4).toString("hex")}`;

const WITNESS = ["HANDLE", "INSTANCE", "PANE", "PANE_ID", "SESSION", "EPOCH", "SOCKET"] as const;

/**
 * Publish a selected row as this process's TAP_CALLER_SELECTED_* witness, as
 * lib `tap_caller_pane_observe` did for self.sh: lib pins its socket and every
 * later pane effect rechecks that owner. The witness belongs to this
 * resolution, so an inherited one is cleared first.
 */
function exportWitness(caller: IdentityPaneObservation | null): void {
  for (const key of WITNESS) delete process.env[`TAP_CALLER_SELECTED_${key}`];
  if (caller?.status !== "ok" || !caller.selectedHandle) return;
  const values: Record<(typeof WITNESS)[number], string> = { HANDLE: caller.selectedHandle, INSTANCE: caller.selectedInstance ?? "",
    PANE: caller.selectedPane ?? "", PANE_ID: caller.paneId, SESSION: caller.session, EPOCH: caller.serverEpoch, SOCKET: caller.selectedSocket ?? "" };
  for (const key of WITNESS) if (values[key]) process.env[`TAP_CALLER_SELECTED_${key}`] = values[key];
  if (caller.selectedSocket) {
    process.env.TAP_TMUX_SOCKET_PATH = caller.selectedSocket;
    delete process.env.TAP_TMUX_SOCKET;
  }
}

/**
 * The exported owner witness still names the live row: active, the same
 * instance, and (when bound to a pane) the same pane, pane id, session, server
 * epoch and socket. No witness means no background owner to recheck.
 */
export function ownerHolds(registryPath: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const instance = env.TAP_CALLER_SELECTED_INSTANCE;
  if (!instance) return true;
  let row: Record<string, unknown> | undefined;
  try { row = seatMap(loadRegistry(registryPath))[env.TAP_CALLER_SELECTED_HANDLE ?? ""] as Record<string, unknown> | undefined; }
  catch { return false; }
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  const expected: Record<string, string> = { pane: env.TAP_CALLER_SELECTED_PANE ?? "", pane_id: env.TAP_CALLER_SELECTED_PANE_ID ?? "",
    session: env.TAP_CALLER_SELECTED_SESSION ?? "", server_epoch: env.TAP_CALLER_SELECTED_EPOCH ?? "", server_socket: env.TAP_CALLER_SELECTED_SOCKET ?? "" };
  const bindingOk = !expected.pane || Object.entries(expected).every(([key, value]) => (row![key] || "") === value);
  return (row.status === undefined ? "active" : row.status) === "active" && row.instance === instance && bindingOk;
}

/** The submit result as this verb's exit contract. */
export function selfExit(result: SubmitResult): { code: number; reason?: "lock-park" | "no-prompt" } {
  switch (result.status) {
    case "injected": case "harness_queued": return { code: 0 };
    case "pane_gone": return { code: 3 };
    case "lock_busy": return { code: 4, reason: "lock-park" };
    case "band_busy": case "recovery_held": case "copy_mode": case "rate_limited": return { code: 4, reason: "no-prompt" };
    case "unverified": case "attempt_evidence_unwritable": return { code: 5 };
    case "identity_mismatch": case "team_reset_fenced": case "clearing": return { code: 1 };
  }
}

function deferReport(reason: string, pane: string, what: string): void {
  if (reason === "lock-park") say(`deferred — a concurrent submit holds the pane-submit lock on '${pane}'; ${what} was NOT submitted. Contention is transient — retry shortly.`);
  else if (reason === "no-prompt") say(`deferred — pane '${pane}' has no visible input prompt; ${what} was NOT submitted. Retry when idle.`);
  else say(`deferred — '${pane}' refused the submit and reported no reason; ${what} was NOT submitted. Check the tap: line above for which.`);
}

export function cmdSelf(argv: string[], scripts = SCRIPTS, context?: ResolvedContext): number {
  try {
    // clear and rebrief take no text; their options have one owner.
    if (argv[0] === "clear" || argv[0] === "rebrief") return armSelfRecovery(parseRecovery(argv), context);
    return runSelf(parseSelf(argv), scripts, context);
  } catch (error) {
    say(error instanceof TapError ? error.detail : error instanceof Error ? error.message : String(error));
    return error instanceof TapError ? error.code : 1;
  }
}

function runSelf(options: SelfOptions, scripts: string, context?: ResolvedContext): number {
  const { verb } = options;
  if (options.handoff && verb !== "compact") { say("--handoff only applies to the compact verb"); return 1; }
  if (options.handoff) {
    const bad = validHandoff(options.handoff);
    if (bad) { say(bad); return 1; }
  }
  const id = mintId();
  const marker = ` [[sv:${id}]]`;
  // The marker supplies one separator. Do not manufacture an unverifiable
  // space run at its wrap; control characters still go through validation.
  const text = verb === "compact" ? options.text.replace(/ +$/, "") : options.text;
  const gate = checkText(verb, text, options.interval ?? "", marker);
  if (!gate.ok) { say(gate.message); return gate.code; }
  if (verb === "compact") {
    // One owner for the narrowing phrases, shared with peer `tap compact`.
    const narrowed = focusNarrowing(text);
    if (narrowed) { say(`REJECTED — compact focus contains exclusive/destructive phrasing: '${narrowed}'. Enumerate what to PRESERVE instead`); return 1; }
  }

  // The calling seat, registered: every effect below is bound to its identity.
  const ctx = context ?? resolveContext();
  // An explicit --pane keeps any inherited owner witness and the default server.
  let caller: string | IdentityPaneObservation | null = options.pane ?? null;
  if (!caller) { caller = callerPaneObservation(observeCallerPaneChain(process.env, ctx)); exportWitness(caller); }
  if (!caller) { say("cannot resolve own pane from an attached TMUX_PANE or one registered harness session; run inside tmux or pass --pane <tmux-target>"); return 1; }
  let self: ReturnType<typeof resolveSelf>;
  // A gone pane keeps its own code (3); any other unresolvable or unregistered
  // caller is a validation refusal (1). Nothing was attempted either way.
  try { self = resolveSelf(ctx, caller, 1); }
  catch (error) { if (error instanceof TapError) { say(error.detail); return error.errorClass === "pane_gone" ? 3 : 1; } throw error; }
  const seat = seatMap(loadRegistry(ctx.registryPath))[self.handle];
  if (!seat) { say(`'${self.handle}' is not a registered seat; run 'tap in' first`); return 1; }
  const registered = String(seat.harness ?? "");
  if (options.harness && registered && family(options.harness) !== family(registered)) {
    say(`--harness '${options.harness}' differs from the registered harness '${registered}'`); return 1;
  }
  const harness = registered || options.harness || "";
  const allowed = checkHarness(verb, harness);
  if (!allowed.ok) { say(allowed.message); say("caller must surface this limitation; silent success is forbidden"); return allowed.code; }
  const fam = family(harness)!;
  const pane = self.paneId;
  // A background job's owner is rechecked at each effect boundary, as self.sh did;
  // the synchronous submit carries the same witness into the shared submitter.
  const ownerStill = () => ownerHolds(ctx.registryPath);
  const ownerChanged = "background job owner changed before the pane effect; nothing was submitted";
  // The command spelling follows the process actually in the pane, as self.sh's
  // did: a row that lags a process replacement must not pick the protocol.
  const families = agentFamilies();
  let command = "";
  try {
    const read = tmuxReadOnly(["display-message", "-p", "-t", pane, "#{pane_current_command}"]);
    if (read.code === 0) command = read.stdout.replace(/\n+$/, "");
  } catch { /* an unreadable command names no family, and the check below refuses */ }
  const live = harnessFamily(paneHarnessCommand(pane, command, families), families);
  if (family(live) !== fam) {
    say(`pane '${pane}' runs '${live || "unknown"}' but '${self.handle}' is registered as '${harness}'; nothing was submitted — re-register with tap in`); return 1;
  }

  let handoff = "";
  if (verb === "compact") {
    // Codex compaction is handoff-gated (tap-n27ug): refuse before any effect.
    if (fam === "codex" && !options.handoff) {
      say("REJECTED — Codex compaction needs a handoff written by you: run tap self compact --handoff <file> -- '<focus>'"); return 1;
    }
    if (options.handoff) {
      handoff = writeHandoff(ctx.bus.home, self.handle, options.handoff);
      say(`compaction handoff written to ${handoff}`);
    }
    // Every family has one worker-owned compact path. Claude carries its focus
    // in the typed command; the other families carry it in the resume note.
    const ping = handoffPing(handoff, self.handle, pane, fam === "claude" ? "" : text);
    if (!ownerStill()) { say(ownerChanged); return 1; }
    return armSelfCompact({ pane, handoffPath: handoff || undefined, resumePing: ping || undefined, focus: text }, ctx);
  }

  // Typed command prefix, then the pasted text and its marker. The marker is not
  // stripped after submit: the active goal or loop visibly ends with it. The
  // owner witness is checked in full here; each effect then rereads the row's
  // instance, pane id and epoch through the bound recipient.
  if (!ownerStill()) { say(ownerChanged); return 1; }
  const bound: BoundRecipient = { paneId: pane, serverEpoch: String(seat.server_epoch ?? ""), harness, handle: self.handle,
    instance: String(seat.instance ?? ""), bootId: String(seat.boot_id ?? "") };
  const effects = { ...draftEffects(DARK_EFFECTS), takeBack: permittedTakeBack(DARK_EFFECTS) };
  const result = submitVerify(pane, id, `${text}${marker}`, bound, {
    typedPrefix: commandPrefix(verb, options.interval), preserveDraft: false, registryPath: ctx.registryPath,
    recipient: self.handle, busHome: ctx.bus.home, agentFamilies: new Set(families), scriptsDir: scripts,
  }, effects);
  const exit = selfExit(result);
  if (exit.code && "detail" in result) process.stderr.write(`tap: ${result.detail}\n`);
  switch (exit.code) {
    case 0: say(`/${verb} submitted and verified in pane ${pane}`); break;
    case 3: say(`pane '${pane}' is gone`); return 3;
    case 4:
      if (result.status === "copy_mode") say(`deferred — pane '${pane}' is scrolled (tmux copy-mode); /${verb} was NOT submitted. Return to the live view and retry.`);
      else deferReport(exit.reason ?? "", pane, `/${verb}`);
      return 4;
    case 5:
      say(`submit-unverified — /${verb} input was not safely submitted or did not clear from '${pane}'; see the submit diagnostic above`); return 5;
    default: say(`the pane is not the owner this submit was bound to; /${verb} was not submitted`); return 1;
  }
  return 0;
}
