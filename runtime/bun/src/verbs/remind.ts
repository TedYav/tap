// `tap remind <seat|me> --in <dur>|--at <epoch> [--every <dur>] -f <body-file|->`,
// `tap remind list [--json]`, `tap remind cancel <id>` -- the reminder verb, native
// (the `remind` closure). The queue behind it (`../remind`: add/list/cancel/delay/
// fire/finish/off under `watch/reminders.json.lock`) was native already; this file is
// the VERB LAYER the deleted `tap-remind.sh` held -- argv, the caller's identity, the
// reset fence, the body source, the target's membership -- and it reaches the queue and
// the runner ensure (`remindersEntry`, the same call `tap watch reminders --by` makes)
// IN THIS PROCESS. Both doors reach this one body: the Bun router (`main.ts`
// NATIVE_HANDLERS.remind) and a direct `bun` run of main.ts.
//
// The incumbent's CHECK ORDER is kept exactly, because which refusal a caller gets for
// an input with two defects is part of the contract the differential certifies
// (smoke/remind-verb-closure.test.sh): the sub-command is argv[0] whatever it is;
// `list` returns before identity; identity before the fence; the fence before
// `cancel`; `me` before the target grammar; `-f` presence before the body source;
// the body source before the target's membership; membership before the queue.
//
// Identity is the VERIFIED CALLING PANE and nothing else -- no `TAP_SELF`, no
// `--by` (the incumbent's `tap_resolve_self_handle_into`): a seat that cannot
// resolve its own pane cannot schedule, and every way that resolution can fail --
// no tmux, an ambiguous tty, an unverifiable generation, an unregistered pane, an
// unanchored bus -- was one exit (`identity_unavailable`, 1, `tap in`) and stays one.
// A same-named seat in another team is not this caller's identity.
//
// `--team <X>` selects X's WHOLE context -- bus, registry, and the runner ensure --
// through the caller-team selector (CONTRACT §Caller-team selector). The incumbent's
// flag was a no-op: it rebound only the registry, every later reader rebound back to
// the caller's team, and the queue path never moved. RATIFIED deviation (the architect and the migration partner,
// 2026-09-16; leader): a flag that
// validates a team and then operates elsewhere is not behavior worth preserving, and
// a `--team` that schedules where nothing fires is worse than none.
//
// The body arrives as BYTES on both sources and is decoded the way the queue's own
// file read decodes (`readFileSync(path, "utf8")`: a leading U+FEFF is KEPT, invalid
// sequences replaced) -- rule 40: `Bun.stdin.text()` would strip the BOM the
// incumbent's `cat > tmpfile` preserved. No scratch file: the incumbent staged `-f -`
// through a mode-600 file under `$TAP_HOME/tmp` and unlinked it on exit; the row's
// `body` is what the contract promises, and that is byte-identical.
//
// File-kind checks port by OPERATOR (rule 38): `-e` -> existsSync, `-f` -> a regular
// file after following symlinks, `-r` -> access(R_OK); a fifo is refused as "not a
// regular file" and never opened.

import { accessSync, constants, existsSync, readFileSync, readSync, statSync } from "node:fs";
import { isFile } from "../watch-lease";
import { join, resolve } from "node:path";

import { callingPane, resolveContext, resolveSelf, TapError, type ResolvedContext } from "../context";
import { loadRegistry, seatMap } from "../registry";
import { requestKill } from "../remind-job";
import { addCommand, duration, addReminder, cancelReminder, currentTime, listText, parseAdd } from "../remind";
import { assertResetUnfenced } from "../reset";
import { remindersEntry } from "../watch-sidecar";
import { tapScriptsDir } from "../scripts-dir";

const TAP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HELP = "tap help remind";

function fail(code: number, klass: string, action: string, detail: string): never {
  throw new TapError(code, klass, action, detail, "tap remind");
}

/** `${2:?<message>}`: unset OR empty refuses (the incumbent's parameter-expansion error, as a usage refusal). */
function operand(argv: string[], i: number, message: string): string {
  const v = argv[i + 1];
  if (v === undefined || v === "") fail(1, "usage_error", HELP, message);
  return v;
}

/**
 * The queue's own refusals (`tap remind: <reason>`, status 1, never JSON) -- the line
 * the incumbent's child printed, without the adapter's second line
 * (`tap: slice_failed id=… slice=remind: classification failed`) that `tap_bun_call`
 * appended to every one of them (ratified: the adapter is gone).
 */
export function queueRefusalOf<T>(body: () => T): T | null {
  try { return body(); }
  catch (error) {
    process.stderr.write(`tap remind: ${error instanceof Error ? error.message : String(error)}\n`);
    return null;
  }
}
const queue = queueRefusalOf;

function scriptsDirOf(scripts?: string): string {
  return scripts ?? tapScriptsDir();
}

/** The bytes on standard input, to EOF (`cat > tmpfile`): a source that cannot be read is the incumbent's refusal. */
function readStdinBytes(): Buffer {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let n: number;
    try { n = readSync(0, buf, 0, buf.length, null); }
    catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
      if (code === "EAGAIN") { Bun.sleepSync(2); continue; }
      if (code === "EOF") break;
      throw error;
    }
    if (n <= 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks);
}

/** The queue's file decode, applied to bytes from either source (rule 40: the BOM stays). */
function decodeBody(bytes: Buffer): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

/**
 * `[ -n "$(tap_registry_agent_json "$to")" ]`: the handle is a row (any status) in the
 * selected registry -- the registry the caller's identity was just resolved against.
 * The incumbent folded EVERY failure of that read into "not registered": a registry gone
 * between identity and here (`[ -f "$reg" ] || return 1`), or one that exists and cannot
 * be read -- not JSON, a number outside the supported domain, an I/O failure (python's
 * `except Exception: sys.exit(1)`). That is an authority failure reported as a predicate
 * answer, and charter rule 19 forbids porting it ("infrastructure failure never maps to
 * predicate-false"); here it is its own refusal naming the reason. DEVIATION from the
 * incumbent, declared in the PR body under rule 18 with rule 19 as its authority
 * (CONTRACT §Agent reminders carries the sentence).
 */
export function targetRegistered(registryPath: string, to: string): boolean {
  if (!isFile(registryPath)) fail(1, "registry_unreadable", "tap doctor", `acting registry is gone: ${registryPath}`);
  let ent: unknown;
  try { ent = seatMap(loadRegistry(registryPath))[to]; }
  catch (error) {
    fail(1, "registry_unreadable", "tap doctor", `acting registry cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  return typeof ent === "object" && ent !== null && !Array.isArray(ent);
}

/**
 * The queue's admission, in the incumbent service's order -- the clock, the schedule
 * grammar, THEN the body (which `add` read from its file inside the lock) -- so an
 * input with a bad schedule AND a body that can no longer be read is refused for the
 * grammar, as it was. `readText` is the deferred body source: the already-consumed
 * stdin bytes, or the file read that follows the operator checks.
 */
export function admit(state: string, owner: string, to: string, args: string[], readText: () => string, env: NodeJS.ProcessEnv): string {
  const now = currentTime(env);
  const parsed = parseAdd([owner, to, "-", ...args]);
  return addReminder(state, parsed, readText(), now);
}

/**
 * `-f <path>`: the three operators in the incumbent's order, each its own refusal
 * (rule 38: `-e` -> existsSync, `-f` -> a regular file after following symlinks,
 * `-r` -> access(R_OK)). The READ is not here: the incumbent read the file inside the
 * queue's `add`, after the target's membership, and a read that fails past these checks
 * (the file gone or unreadable between the check and the read) was the queue's own
 * `tap remind: <reason>` line -- so the read stays behind that boundary (I3).
 */
function checkBodyFile(body: string): void {
  if (!existsSync(body)) fail(1, "not_found", HELP, `reminder body file not found: ${body}`);
  let regular = false;
  try { regular = statSync(body).isFile(); } catch { regular = false; }
  if (!regular) fail(1, "usage_error", HELP, `reminder body file is not a regular file: ${body}`);
  try { accessSync(body, constants.R_OK); } catch { fail(1, "usage_error", HELP, `reminder body file is not readable: ${body}`); }
}

export function cmdRemind(argv: string[], scripts?: string, env: NodeJS.ProcessEnv = process.env): number {
  // `sub="${1:-}"; shift`: the first word is the sub-command whatever it spells --
  // `tap remind --json` asks to schedule for a seat named `--json` and is refused as such.
  let sub = argv[0] ?? "";
  const rest = argv.slice(1);
  let team = "", body = "", json = false;
  let command = "", circle = "", fallback = "", target = "", unobservableExit = "";
  const args: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    switch (a) {
      case "--unobservable-exit": unobservableExit = operand(rest, i, "--unobservable-exit needs an exit code"); i++; break;
      case "--when-done": command = operand(rest, i, "--when-done needs a command"); i++; break;
      case "--circle-back": circle = operand(rest, i, "--circle-back needs a duration"); i++; break;
      case "--fallback": fallback = operand(rest, i, "--fallback needs a seat"); i++; break;
      case "--to": target = operand(rest, i, "--to needs a seat"); i++; break;
      case "--team": team = operand(rest, i, "--team needs a name"); i++; break;
      case "-f": case "--file": body = operand(rest, i, "-f needs a body file"); i++; break;
      case "--in": case "--at": case "--every": args.push(a, operand(rest, i, "time option needs a value")); i++; break;
      case "--json": json = true; break;   // consumed by `list`; accepted and ignored by every other form, as before
      default: args.push(a);
    }
  }

  if (["list", "cancel", "kill"].includes(sub) && (command || circle || fallback || target || unobservableExit)) {
    fail(1, "usage_error", HELP, "command options only apply when scheduling");
  }

  // One selected context for everything that follows -- the queue, the caller's
  // identity, the target's membership, the fence and the runner ensure.
  const ctx: ResolvedContext = resolveContext(process.cwd(), env, team ? { explicitTeam: team } : undefined);
  const state = join(ctx.bus.home, "watch", "reminders.json");

  if (sub === "list") {
    if (args.length) fail(1, "usage_error", HELP, "unexpected list argument");
    // `remind.ts` reads its clock before every action, the CLI door included.
    const text = queue(() => { currentTime(env); return listText(state, json, team); });
    if (text === null) return 1;
    process.stdout.write(text);
    return 0;
  }

  let owner = "";
  try {
    const pane = callingPane(env);
    if (pane?.status === "ok") owner = resolveSelf(ctx, pane, 1, env).handle;
  } catch { owner = ""; }
  if (!owner) fail(1, "identity_unavailable", "tap in", "schedule from your registered pane");
  assertResetUnfenced(ctx.bus.home, "tap remind");

  if (sub === "kill") {
    if (args.length !== 1) fail(1, "usage_error", HELP, "kill needs one reminder id");
    return queue(() => { requestKill(state, owner, args[0]!); return 0; }) ?? 1;
  }
  if (sub === "cancel") {
    if (args.length !== 1) fail(1, "usage_error", HELP, "cancel needs one reminder id");
    return queue(() => { currentTime(env); cancelReminder(state, owner, args[0]!); return 0; }) ?? 1;
  }

  if (target) sub = target;
  if (sub === "me") sub = owner;
  if (!TAP_ID_RE.test(sub)) fail(1, "usage_error", HELP, "target must be a seat or me");
  if (!body) fail(1, "usage_error", HELP, "-f requires a reminder body");
  // `-f -`: the bytes are consumed here, before the target's membership, as the
  // incumbent's `cat > tmpfile` was; a file is only CHECKED here and read behind the
  // queue's boundary below, as the incumbent's `add` read it.
  let stdinText: string | null = null;
  if (body === "-") {
    let bytes: Buffer;
    try { bytes = readStdinBytes(); }
    catch { fail(1, "usage_error", HELP, "could not read reminder body from stdin"); }
    stdinText = decodeBody(bytes);
  } else {
    checkBodyFile(body);
  }
  if (!targetRegistered(ctx.registryPath, sub)) fail(1, "unknown_recipient", "tap team", "target is not registered");

  const to = sub;
  const ident = queue(() => {
    if (command) {
      if (args.length || !circle || !fallback) throw new Error("--when-done requires --circle-back and --fallback, and excludes time triggers");
      if (!TAP_ID_RE.test(fallback) || fallback === to) throw new Error("fallback must be a different registered seat");
      if (!targetRegistered(ctx.registryPath, fallback)) throw new Error("fallback is not registered");
      if (unobservableExit && (!/^[0-9]+$/.test(unobservableExit) || Number(unobservableExit) < 1 || Number(unobservableExit) > 255)) throw new Error("--unobservable-exit must be 1..255");
      return addCommand(state, owner, to, stdinText ?? decodeBody(readFileSync(body)), command, duration(circle), fallback, process.cwd(), env, unobservableExit ? Number(unobservableExit) : undefined);
    }
    if (circle || fallback || target || unobservableExit) throw new Error("--circle-back, --fallback, --to and --unobservable-exit require --when-done");
    return admit(state, owner, to, args, () => stdinText ?? decodeBody(readFileSync(body)), env);
  });
  if (ident === null) return 1;

  // The runner ensure, in this process, with the SAME selected context: a stored row
  // is a promise only once a runner is confirmed (CONTRACT §Agent reminders).
  const confirmed = remindersEntry({
    bus: ctx.bus.home, scripts: scriptsDirOf(scripts), registry: ctx.registryPath, owner,
    noSpawn: (env.TAP_WATCH_NO_SPAWN ?? "0") === "1", now: env.TAP_WATCH_NOW || String(Math.floor(Date.now() / 1000)), env,
  });
  if (confirmed !== 0) {
    // The remedy has to work from where the caller stands: with `--team`, the list
    // selects the team and the watcher ensure -- which takes no `--team` -- binds the
    // selected bus explicitly.
    const listRemedy = team ? `tap remind list --team ${team}` : "tap remind list";
    const watchRemedy = team ? `TAP_HOME=${ctx.bus.home} tap watch reminders --by ${owner}` : `tap watch reminders --by ${owner}`;
    process.stderr.write(`tap remind: ${ident} stored; no live reminder runner confirmed; inspect with ${listRemedy}, then retry ${watchRemedy}\n`);
    return 1;
  }
  process.stdout.write(`tap remind: scheduled ${ident} for ${to}\n`);
  return 0;
}
