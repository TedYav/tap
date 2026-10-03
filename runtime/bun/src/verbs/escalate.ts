// Direct machine notification. Only the first nonempty body line leaves TAP;
// no courier, obligation, bus initialization, or delivery-liveness prerequisite.
import { accessSync, closeSync, constants, existsSync, openSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { callingPane, resolveContext, resolveSelf, spoolTeamName, teamRootFromBus, TapError } from "../context";
import { Bus } from "../bus";
import { resolveSelection } from "../team-selection";
import { validToken } from "../ids";
import { loadRegistry, seatMap } from "../registry";
import { ensureAscii } from "../fsatomic";
import { errorJson, humanAction, humanLine } from "../native-error";
import { sendNotification } from "../notifications";
import { scrubBunBeBun } from "../be-bun-scrub";

const HELP = "tap help escalate";
const USAGE = 'usage: tap escalate (-m "<question>" | -f|--body-file <path>) [--from <me>] [--team <name>] [--urgent] [--json]';
const fail = (code: number, kind: string, action: string, detail: string): never => { throw new TapError(code, kind, action, detail); };

// Select with awk's default FS before Bash's whitespace trim. If that selected
// line trims empty, refuse; skipping to a later line could expose private depth.
function questionLine(line: string): string | undefined {
  line = line.replaceAll("\r", "").replaceAll("\0", "");
  if (!/[^ \t]/.test(line)) return undefined;
  // Bash command substitution drops NUL; UTF-8 POSIX space excludes NBSP/BOM.
  return line.replace(/^[\t-\r \u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]+|[\t-\r \u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]+$/g, "");
}
async function questionFromFile(path: string): Promise<string> {
  const fd = path === "-" ? 0 : openSync(path, "r");
  const chunk = Buffer.alloc(4096);
  let pending = Buffer.alloc(0);
  try {
    for (;;) {
      let n: number;
      try { n = readSync(fd, chunk, 0, chunk.length, null); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EAGAIN") { await Bun.sleep(2); continue; }
        if (code === "EOF") n = 0;
        else throw error;
      }
      pending = Buffer.concat([pending, chunk.subarray(0, n)]);
      let end: number;
      while ((end = pending.indexOf(10)) !== -1) {
        const question = questionLine(pending.subarray(0, end).toString("utf8"));
        pending = pending.subarray(end + 1);
        if (question !== undefined) return question;
      }
      if (!n) return questionLine(pending.toString("utf8")) ?? "";
    }
  } finally { if (path !== "-") closeSync(fd); }
}

export async function cmdEscalate(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let json = false;
  try {
    let message: string | undefined, file: string | undefined, from: string | undefined, team = "", urgent = false;
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!;
      const value = (label: string, empty = false) => {
        const v = argv[++i];
        if (v === undefined || (!empty && !v)) fail(1, "usage_error", HELP, `${label} needs a value`);
        return v!;
      };
      switch (arg) {
        case "--preview": value("--preview", true); break;
        case "-m": case "--message": message = value("-m"); break;
        case "-f": case "--body-file": file = value("--body-file"); break;
        case "--from": from = value("--from"); break;
        case "--team": team = value("--team"); break;
        case "--urgent": urgent = true; break;
        case "--json": json = true; break;
        default: fail(1, arg.startsWith("--") ? "unknown_option" : "usage_error", HELP,
          arg.startsWith("--") ? `unknown option '${arg}'` : `unexpected arg '${arg}'`);
      }
    }
    if ((message !== undefined ? 1 : 0) + (file !== undefined ? 1 : 0) !== 1) fail(1, "usage_error", HELP, USAGE);
    if (file !== undefined && file !== "-") {
      if (!existsSync(file)) fail(1, "not_found", "tap escalate --body-file <path>", `body file not found: ${file}`);
      if (!statSync(file).isFile()) fail(1, "usage_error", HELP, `body file is not a regular file: ${file}`);
      try { accessSync(file, constants.R_OK); } catch { fail(1, "usage_error", HELP, `body file is not readable: ${file}`); }
    }
    // This helper already owns caller pin > --team > cwd. No ambient mutation,
    // registration, reconciliation, or adoption accompanies selection.
    const pin = env.TAP_HOME ? resolve(env.TAP_HOME) : "";
    const selectedEnv = pin ? { ...env, TAP_HOME: pin } : env;
    let ctx;
    try { ctx = resolveSelection(pin, pin ? "" : team, process.cwd(), selectedEnv); }
    catch (error) {
      // A custom pinned bus is supported by the old one-way notification door.
      // Reuse the root's authoritative registry without adopting its bus path:
      // escalation never writes a payload or performs a bus-custody operation.
      if (!pin || !(error instanceof TapError) || error.errorClass !== "bus_not_acting") throw error;
      ctx = { ...resolveContext(process.cwd(), selectedEnv, { pinnedRoot: teamRootFromBus(pin) }), bus: new Bus(pin) };
    }
    let question: string;
    try { question = file === undefined ? (message!.split("\n").map(questionLine).find(q => q !== undefined) ?? "") : await questionFromFile(file); }
    catch { question = ""; }
    if (!question) fail(1, "empty_question", 'tap escalate -m "<question>" (or -f <file> whose first non-empty line is the question)',
      "the body has no non-empty line, so there is no question to notify");
    from ??= env.TAP_SELF || "";
    if (!from) {
      let generation = false;
      try {
        const pane = callingPane(env);
        if (pane?.status === "unverifiable") generation = true;
        else if (pane?.status === "ok") from = resolveSelf(ctx, pane, 1, env).handle;
      } catch (error) { generation = error instanceof TapError && error.errorClass === "generation_unverifiable"; }
      if (!from && generation) fail(1, "generation_unverifiable", "wait for tmux to answer and retry, or pass --from <name>",
        "refusing escalation because the tmux server generation is unavailable and the caller identity cannot be verified");
      if (!from) fail(1, "unregistered", "register_or_pass_from", "run 'tap register' in this pane, or pass --from <name>");
    }
    if (!validToken(from)) fail(1, "usage_error", HELP, `from '${from}' is not a sentinel-safe token (^[A-Za-z0-9][A-Za-z0-9._-]*$)`);
    let row: unknown;
    try { const seats = seatMap(loadRegistry(ctx.registryPath)); row = Object.hasOwn(seats, from) ? seats[from] : undefined; } catch { /* incumbent unregistered_from */ }
    if (!row || typeof row !== "object" || Array.isArray(row)) fail(1, "unregistered_from",
      `register '${from}' (tap in), or pass a --from that names a registered seat`, `'${from}' is not a registered seat — the notification would name a seat that does not exist`);
    const seat = row as Record<string, unknown>;
    if (seat.status === "pending" || seat.status_reason === "launching") fail(1, "reserved_from",
      `wait for '${from}' to finish registering, or pass a --from that names a live seat`, `'${from}' is a pending/launching reservation, not a seat that has ever been routable`);
    const teamName = spoolTeamName(ctx.bus.home, env.TAP_INDEX_HOME);
    const name = teamName ? `${teamName}/${from}` : from;
    const session = seat.delivery !== "poll" && typeof seat.session === "string" ? seat.session.trim() : "";
    const label = `${question} — ${name}${session && session !== name ? ` [tmux: ${session}]` : ""}`;
    await sendNotification({ title: urgent ? "🚨 TAP escalation" : "TAP escalation", body: label, urgent }, env);
    if (json) process.stdout.write(ensureAscii(JSON.stringify({ ok: true, notified: true, delivery: "accepted", human_received: null, label, from, team: teamName })) + "\n");
    else process.stdout.write(`tap escalate: notifier accepted (human receipt unconfirmed): ${label}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof TapError)) throw error;
    if (json) process.stdout.write(errorJson(error.errorClass, error.action, error.detail));
    else process.stderr.write(`tap escalate: ${humanLine(error.detail)}; next: ${humanAction(error.action)}\n`);
    return error.code;
  }
}

if (import.meta.main) {
  // Compiled TAP callers use their own executable as Bun's CLI. That internal
  // mode must not turn a compiled notifier into the Bun CLI as well.
  scrubBunBeBun();
  process.exitCode = await cmdEscalate(process.argv.slice(2));
}
