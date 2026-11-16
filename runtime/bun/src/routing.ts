// Read-only ledger and fleet views. Preset metadata and seat observation belong
// to the native roster; the Markdown ledger supplies calibration only.
import { spawn } from "node:child_process";
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isRegularFile, loadGlobalRegistry, readIndexJson, resolveTeamFromDoc } from "./index-home";
import { NO_MACHINE_INDEX } from "./selector";
import { seatMap } from "./registry";
import { teamRegistryFileRefusal } from "./register-authority";
import { PY_STRIP } from "./payload-fields";
import { pyFloatString, pyReadUtf8, pyTruthy } from "./spool-publication";
import { pyRepr, unicodeInt } from "./watch-detect";
import { loadModelReference, matchingVariant, variantQualification } from "./launcher/model-reference";
import type { LaunchTuning } from "./launcher/tuning";
import { tapScriptsDir, artifactBun } from "./scripts-dir";
import { formatContextTokens, type TokenSample } from "./context-tokens";
import { formatPromptCache, refreshPromptCache, type PromptCache } from "./prompt-cache";
import { ensureAscii } from "./fsatomic";
import { table as rosterTable, columnWidths, fitColumns, isDaemon, rosterWidth, rosterStyle, statusIndicator } from "./verbs/team";
import { helpArgv } from "./help";
import { TapError } from "./context";
import { modelCell, prettyModelName } from "./model-names";
import { displayState, emptySeatFilters, hasSeatFilters, idleSeconds, seatClock, seatMatches, takeSeatFilters, type SeatFacts } from "./seat-filter";
import { WORKING, latestActivity, recentCount, recentOrder, seatLastActive, takeCount, type LastActive } from "./team/recent";
import { transcriptActivity } from "./team/stale";
import { ownBun, ownBunFlags } from "./own-bun";

type Result = { exit: number; stdout: string; stderr: string };
type Row = Record<"handle" | "model" | "harness" | "family" | "tier" | "speed" | "cost" | "voice" | "one_liner", string>;
type ObjectRow = Record<string, unknown>;
type Ledger = { banner: string; rows: Row[]; dispositions: Map<string, string> };
const HEADING = "## Routing table";
const REQUIRED = ["handle", "model @ harness", "family", "tier"];
const DEFAULT_VOICE = "sole-eligible";
const TIERS = new Map([["s-tier", 5], ["frontier", 4], ["advanced", 3], ["medium", 2], ["basic", 1], ["dumb", 1]]);
const SPACE = "[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const DISPOSITION = new RegExp(`^###${SPACE}+(.+?)${SPACE}*$`, "u");
const DATE = new RegExp(`(20\\p{Decimal_Number}{2})-(\\p{Decimal_Number}{2})-(\\p{Decimal_Number}{2})(?:${SPACE}*[\\u2013\\u2014-]${SPACE}*(\\p{Decimal_Number}{2})-(\\p{Decimal_Number}{2}))?`, "gu");
const strip = (s: string) => s.replace(PY_STRIP, "");
const length = (s: string) => Array.from(s).length;
const object = (v: unknown): v is ObjectRow => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => typeof v === "string" ? v : "";
const success = (stdout: string): Result => ({ exit: 0, stdout, stderr: "" });
const failure = (stderr: string, exit = 1): Result => ({ exit, stdout: "", stderr });

function ledgerPath(): string {
  const raw = process.env.TAP_MODELS_LEDGER || join(homedir(), ".tap/seat-calibration.md");
  // Pathlib removes '.' and repeated separators, but never resolves '..'.
  const prefix = raw.startsWith("//") && !raw.startsWith("///") ? "//" : raw.startsWith("/") ? "/" : "";
  return prefix + raw.split("/").filter(part => part && part !== ".").join("/") || ".";
}

function readText(path: string): string {
  return pyReadUtf8(path).replace(/\r\n?/g, "\n");
}

function splitLines(s: string): string[] {
  const lines = s.split(/\r\n|[\n\v\f\r\u001c-\u001e\u0085\u2028\u2029]/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

class LedgerError extends Error {}

function ledgerAbsent(path: string): boolean {
  // A dangling link or an inaccessible existing path is not an absent ledger.
  try { lstatSync(path); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}

function referenceCalibration(roster: ObjectRow, strongest: boolean): Result {
  const notices: string[] = [], variants = loadModelReference(line => notices.push(line));
  const agents = Array.isArray(roster.agents) ? roster.agents.filter(object) : [];
  const rows = agents.map(agent => {
    const tuning = object(agent.launch_tuning) ? agent.launch_tuning as LaunchTuning : null;
    const variant = tuning ? matchingVariant(variants, text(agent.harness), tuning) : undefined;
    return { agent, tuning, variant, tier: text(variant?.metadata?.intelligence) };
  });
  if (strongest) {
    const reachable = rows.filter(row => row.agent.status === "active" && TIERS.has(row.tier));
    if (!reachable.length) return failure("tap team calibration: no reachable seat has a known exact reference variant tier; next: launch a supported model with tap launch <harness> [name] --model <id> [--effort <level>] (OpenCode 2: model and variant; Cursor: model only), or add personal calibration\n");
    const best = Math.max(...reachable.map(row => TIERS.get(row.tier)!));
    return success(reachable.filter(row => TIERS.get(row.tier) === best).map(row => `${text(row.agent.handle)}\n`).join(""));
  }
  const body = table(["HANDLE", "MODEL@EFFORT @ HARNESS (LAUNCH)", "FAMILY", "TIER", "QUALIFICATION", "STATUS"], rows.map(({agent,tuning,variant,tier}) => [
    text(agent.handle), `${prettyModelName(text(tuning?.model) || text(agent.model)) || "?"}@${text(tuning?.effort) || "?"} @ ${text(agent.harness) || "?"}`,
    variant?.family || text(agent.family) || "-", tier || "unknown", variant ? variantQualification(variant) : "unknown exact variant", text(agent.status) || "unknown",
  ]));
  return { exit: 0, stderr: notices.map(line => `${line}\n`).join(""), stdout: `tap team calibration: ${text(roster.team) || "(unnamed)"}\nReference; access unverified. Stored tuning describes launch only; unknown defaults stay unknown.\n\n${body}\nSaved recipes: tap presets. Calibration matches launch tuning; tap team shows observed model/effort.\n` };
}

function parseLedger(path: string): Ledger {
  if (!existsSync(path)) throw new LedgerError(`seat-calibration ledger not found: ${path}`);
  const lines = splitLines(readText(path));
  const start = lines.findIndex(line => strip(line).startsWith(HEADING));
  if (start < 0) throw new LedgerError(`'${HEADING}' section not found in ${path} — the ledger has no routing table to render (expected the pipe table \`tap team calibration\` reads).`);
  let banner = "";
  for (let i = start + 1; i < lines.length && !strip(lines[i]!).startsWith("|"); i++) {
    const line = strip(lines[i]!);
    if (line && !line.startsWith("#")) { banner = line.split(". ", 1)[0]!.replace(/\.+$/, "") + "."; break; }
  }
  const rows: Row[] = [];
  let headers: Map<string, number> | undefined;
  for (const raw of lines.slice(start + 1)) {
    if (raw.startsWith("## ")) break;
    const line = strip(raw);
    if (!line.startsWith("|")) continue;
    const cells = line.replace(/^\|+|\|+$/g, "").split("|").map(strip);
    if (!headers) {
      headers = new Map(cells.map((name, i) => [name.toLowerCase(), i]));
      const missing = REQUIRED.filter(name => !headers!.has(name));
      if (missing.length) throw new LedgerError(`Routing table in ${path} is missing required column(s): ${missing.join(", ")} — header row is [${cells.join(" | ")}]. A renamed/removed routing column would silently mis-route a consumer, so this fails loud rather than rendering blanks.`);
      continue;
    }
    if (/^[-: ]*$/.test(cells.join(""))) continue;
    const columns = headers;
    const col = (name: string) => cells[columns.get(name) ?? -1] ?? "";
    const handle = col("handle");
    if (!handle) continue;
    const modelHarness = col("model @ harness"), at = modelHarness.indexOf(" @ ");
    rows.push({ handle, model: at < 0 ? modelHarness : strip(modelHarness.slice(0, at)),
      harness: at < 0 ? "" : strip(modelHarness.slice(at + 3)), family: col("family"),
      tier: col("tier"), speed: col("speed"), cost: col("cost"), voice: col("voice") || DEFAULT_VOICE,
      one_liner: col("one-liner") });
  }
  if (!headers) throw new LedgerError(`'${HEADING}' section in ${path} has no pipe table — nothing to render (expected a \`| handle | model @ harness | family | tier | … |\` row).`);
  const dispositions = new Map<string, string>();
  let current: string | undefined, buffer: string[] = [];
  const flush = () => { if (current !== undefined) dispositions.set(current, strip(buffer.join("\n"))); };
  for (const line of lines) {
    const match = DISPOSITION.exec(line);
    if (match) { flush(); current = match[1]!; buffer = []; }
    else if (current !== undefined) {
      if (line.startsWith("## ")) { flush(); current = undefined; buffer = []; }
      else buffer.push(line);
    }
  }
  flush();
  return { banner, rows, dispositions };
}

// The roster table truncates its last column; these views deliberately do not.
function table(headers: string[], body: string[][]): string {
  const widths = headers.map(length);
  for (const row of body) for (let i = 0; i < row.length - 1; i++) widths[i] = Math.max(widths[i]!, length(row[i]!));
  return [headers, ...body].map(row => row.map((cell, i) => i === row.length - 1 ? cell : cell + " ".repeat(widths[i]! - length(cell)))
    .join("  ").replace(/[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/u, "") + "\n").join("");
}

export function compactAge(seconds: number): string {
  if (seconds < 90) return "just now";
  const [unit, suffix] = seconds < 90 * 60 ? [60, "m"] as const : seconds < 36 * 3600 ? [3600, "h"] as const : [86400, "d"] as const;
  const value = seconds / unit, floor = Math.floor(value);
  if (!Number.isFinite(value)) throw new Error("cannot round non-finite activity age");
  return `${value - floor === 0.5 && floor % 2 === 0 ? floor : Math.round(value)}${suffix}`;
}

/**
 * The LAST ACTIVE cell of `--recent` views: `working`, an age, or `-` when nothing dates the row.
 * `tap teams` ages like its spool warning (compactAge); `tap team` passes the roster's own formatAge
 * so the cell agrees with the age in its state column.
 */
export function lastActiveCell(active: LastActive | null, now: number, age: (seconds: number) => string = compactAge): string {
  if (!active) return "-";
  if (active.source === WORKING) return "working";
  // A date past the view's clock (skew, or activity during collection) is just now, never a negative age.
  return active.at > now ? "just now" : age(now - active.at);
}

// Team order for human views: case-insensitive, then codepoint order so `Tap` and `tap` stay stable.
function compareTeams(a: string, b: string): number {
  return compare(a.toLowerCase(), b.toLowerCase()) || compare(a, b);
}

export function compare(a: string, b: string): number {
  const aa = Array.from(a, ch => ch.codePointAt(0)!), bb = Array.from(b, ch => ch.codePointAt(0)!);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i]! - bb[i]!;
  return aa.length - bb.length;
}

export function latestObservation(disposition: string): [string, string] {
  let bestRank = "", bestShown = "", bestText = "";
  for (const raw of splitLines(disposition)) {
    const line = strip(raw);
    if (!line.startsWith("- ")) continue;
    let rank = "", shown = "";
    for (const match of line.matchAll(DATE)) {
      const [, year, month, day, endMonth, endDay] = match;
      const date = endMonth ? `${unicodeInt(year!) + (compare(endMonth + endDay, month! + day!) < 0 ? 1n : 0n)}-${endMonth}-${endDay}` : `${year}-${month}-${day}`;
      if (compare(date, rank) > 0 || (date === rank && compare(match[0], shown) > 0)) { rank = date; shown = match[0]; }
    }
    if (rank && compare(rank, bestRank) >= 0) { bestRank = rank; bestShown = shown; bestText = strip(line.slice(2)); }
  }
  return [bestShown, bestText];
}

function attachedCell(value: unknown): string {
  if (value === "" || value === null || value === undefined) return "-";
  if (value === true || value === "true" || value === "yes") return "yes";
  if (typeof value === "number" && Number.isInteger(value)) return value > 0 ? "yes" : "no";
  if (typeof value === "string" && /^\p{Decimal_Number}+$/u.test(value)) return unicodeInt(value) > 0n ? "yes" : "no";
  return "no";
}

export function calibrationView(roster: ObjectRow, activity: string, strongest: boolean, path = ledgerPath(), now?: number): Result {
  let ledger: Ledger;
  try {
    if (ledgerAbsent(path)) return referenceCalibration(roster, strongest);
    ledger = parseLedger(path);
  } catch (error) { return failure(`tap team calibration: ${(error as Error).message}${error instanceof LedgerError ? "" : `; next: inspect ${path}`}\n`); }
  const clock = now ?? (process.env.TAP_WATCH_NOW ? pyFloatString(process.env.TAP_WATCH_NOW) : Date.now() / 1000);
  if (clock === null) throw new Error(`could not convert TAP_WATCH_NOW to float: ${pyRepr(process.env.TAP_WATCH_NOW || "")}`);
  const { banner, rows, dispositions } = ledger;
  const byHandle = new Map(rows.map(row => [row.handle, row]));
  const idle = new Map<string, number>();
  for (const line of splitLines(activity)) {
    const [pane, address, stamp] = line.split("\t");
    if (!stamp || !/^\p{Decimal_Number}+$/u.test(stamp)) continue;
    for (const key of [pane, address]) if (key) idle.set(key, Number(unicodeInt(stamp)));
  }
  const agents = Array.isArray(roster.agents) ? roster.agents : [];
  const joined = agents.filter((agent): agent is ObjectRow => object(agent) && !!agent.handle).map(agent => {
    const handle = text(agent.handle), harness = text(agent.harness);
    let base = byHandle.get(handle), how = base ? "exact" : "", mismatch = "";
    if (!base) {
      for (const [name, row] of byHandle) if (handle.startsWith(`${name}-`) && (!base || length(name) > length(base.handle))) { base = row; how = "prefix"; }
    }
    if (base && harness && base.harness && harness !== base.harness) {
      mismatch = `harness ${harness} does not match ${base.handle}'s ${base.harness}`;
      base = undefined; how = "";
    }
    // The personal selector ranks the operator's routing entries, whose model
    // labels are free-form. Preserve its tier after the existing harness guard.
    const selectorTier = base?.tier || "";
    const model = object(agent.launch_tuning) ? text(agent.launch_tuning.model) : text(agent.model);
    if (base && model && base.model !== model) {
      mismatch = `ledger label differs from recorded launch identifier; model match unverified (${base.model} versus ${model})`;
      base = undefined; how = "";
    }
    const metadata = object(agent.metadata) ? agent.metadata : {};
    const roles = (key: string) => Array.isArray(metadata[key]) ? metadata[key].filter((r: unknown): r is string => typeof r === "string").join(", ") : "";
    const primary = roles("primary_roles"), secondary = roles("secondary_roles");
    const stamp = idle.get(text(agent.pane));
    return { handle, base: base?.handle || "", how, model: model || base?.model || "", shown: model ? prettyModelName(model) : base?.model || "", harness: harness || base?.harness || "",
      family: base?.family || (agent.family_source === "preset" ? text(agent.family) : ""), tier: base?.tier || "", selectorTier, voice: base?.voice || "",
      one_liner: base?.one_liner || "", roles: primary + (secondary ? `${primary ? " " : ""}(${secondary})` : ""),
      status: text(agent.status) || "unknown", attached: attachedCell(agent.attached),
      // Python max(0.0, nan) keeps its first operand, just like a future stamp.
      idle: stamp ? compactAge(clock - stamp > 0 ? clock - stamp : 0) : "-", mismatch };
  });
  if (strongest) {
    const reachable = new Map<string, string>();
    for (const row of [...joined.filter(row => row.status === "active"), ...rows.filter(row => row.harness === "Agent tool")]) {
      if (!reachable.has(row.handle)) reachable.set(row.handle, "selectorTier" in row ? row.selectorTier : row.tier);
    }
    const tier = (name: string) => TIERS.get(name) || 0;
    const best = Math.max(...[...reachable.values()].map(tier));
    return success([...reachable].filter(([, t]) => tier(t) === best).map(([handle]) => `${handle}\n`).join(""));
  }
  let out = `tap team calibration: ${text(roster.team) || "(unnamed)"}\n`;
  if (!joined.length) return success(out + "no seats registered yet — run: tap register\n");
  if (banner) out += `${banner}\n`;
  out += "\n" + table(["HANDLE", "BASE", "MODEL @ HARNESS", "FAMILY", "TIER", "VOICE", "ROLES", "STATUS", "ATTACHED", "IDLE"],
    joined.map(row => [row.handle, row.base || "-", row.shown ? `${row.shown} @ ${row.harness}` : `- @ ${row.harness || "-"}`,
      row.family || "-", row.tier || "-", row.voice || "-", row.roles || "-", row.status, row.attached, row.idle]));
  const unjoined = joined.filter(row => !row.base);
  if (unjoined.length) {
    out += "\nSeated, no calibration row (the handle joins nothing — that is a gap in the ledger, not a dead seat):\n";
    for (const row of unjoined) out += `  ${row.handle} — ${row.status}${row.harness ? `, ${row.harness}` : ""}` +
      (row.mismatch ? `; ${row.mismatch} — this calibration is NOT inherited` : "; add a routing entry to calibrate") + "\n";
  }
  const routed = joined.filter(row => row.base);
  if (routed.length) {
    out += "\nRoutes to, and the latest dated observation:\n";
    for (const row of routed) {
      out += `  ${row.handle}${row.how === "exact" ? "" : ` (via ${row.base})`} — ${row.one_liner || "no route line in the ledger"}\n`;
      const [date, observation] = latestObservation(dispositions.get(row.base) || "");
      if (date) out += `      ${date} · ${observation}\n`;
    }
  }
  return success(out + `\nIDLE is tmux window activity — a hint, not a work signal (incoming traffic bumps it). Saved recipes: tap presets. Ledger: ${path}\n`);
}

export function writeRoutingResult(result: Result): number {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.exit;
}

const TEAMS_USAGE = "usage: tap teams [-h] [--all] [--details] [--recent] [-n N]\n";
const TEAMS_HELP = TEAMS_USAGE + "\noptions:\n  -h, --help  show this help message and exit\n  --all\n  --details\n  --recent\n  -n N\n";

type TeamsArgs = { all: boolean; details: boolean; recent: boolean; count?: number };

/** argparse-compatible for the original options; teamsView lifts seat filters and `-n <n>` out first. */
function parseTeams(argv: string[]): Result | TeamsArgs {
  let all = false, details = false, recent = false, ended = false;
  const extra: string[] = [];
  const explicit = (option: string, value: string) => failure(`${TEAMS_USAGE}tap teams: error: argument ${option}: ignored explicit argument ${pyRepr(value)}\n`, 2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!ended && arg === "--") ended = true;
    if (!ended && arg.startsWith("-h")) {
      const tail = arg.replace(/^-h+/, "");
      if (tail.startsWith("=")) return explicit("-h/--help", tail.slice(1));
      if (tail.startsWith("-")) return explicit("-h/--help", tail);
      return success(TEAMS_HELP);
    }
    if (!ended && arg.startsWith("--")) {
      const equal = arg.indexOf("="), name = equal < 0 ? arg : arg.slice(0, equal);
      const matches = ["--help", "--all", "--details", "--recent"].filter(option => option.startsWith(name));
      if (matches.length > 1) return failure(`${TEAMS_USAGE}tap teams: error: ambiguous option: ${arg} could match ${matches.join(", ")}\n`, 2);
      const option = matches[0];
      if (option) {
        if (equal >= 0) return explicit(option === "--help" ? "-h/--help" : option, arg.slice(equal + 1));
        if (option === "--help") return success(TEAMS_HELP);
        if (option === "--all") all = true;
        else if (option === "--details") details = true;
        else recent = true;
        continue;
      }
    }
    extra.push(arg);
  }
  if (extra.length) return failure(`usage: tap [-h] {models,team-calibration,teams} ...\ntap: error: unrecognized arguments: ${extra.join(" ")}\n`, 2);
  return { all, details, recent };
}

/**
 * A team is as recent as its most recent seat, crews included. Stored rows carry the dated evidence;
 * the roster this view already observed says who is working now and when a turn ended. Daemons
 * (isDaemon: poll delivery or the daemon harness) are infrastructure, not "I was working with this
 * team", so they never date it; the attach team step leaves them out the same way.
 */
function teamActivity(stored: Record<string, unknown>, observed: ObjectRow[] | null, now: number): LastActive | null {
  const seen = new Map((observed ?? []).map(row => [text(row.handle), row]));
  // A working seat makes the team active now; no transcript needs reading. A daemon displays ready, never working.
  if ([...seen.values()].some(row => jsonSeatState(row) === "working")) return { at: now, source: WORKING };
  return latestActivity(Object.entries(stored).flatMap(([handle, row]) => {
    if (!object(row) || isDaemon(row)) return [];
    const ended = Date.parse(text(seen.get(handle)?.turn_ended_at)) / 1000;
    return [seatLastActive(row, { working: false, turnEndedAt: Number.isFinite(ended) ? ended : null }, transcriptActivity, now)];
  }));
}

function readObject(path: string): ObjectRow {
  try { const doc = isRegularFile(path) ? readIndexJson(path) : null; return object(doc) ? doc : {}; }
  catch { return {}; }
}

// Keep the native roster as observation authority, bounded independently for each team.
function observedRoster(team: string, scriptsDir: string): Promise<ObjectRow[] | null> {
  return new Promise(resolveResult => {
    const child = spawn(ownBun(), [...ownBunFlags(), resolve(scriptsDir, "../../../runtime/bun/src/team-roster-json.ts"), "roster", team, "--json"], {
      cwd: resolve(scriptsDir, "../../.."), env: process.env,
      stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, killSignal: "SIGKILL",
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", chunk => chunks.push(Buffer.from(chunk)));
    child.on("error", () => resolveResult(null));
    child.on("close", code => {
      if (code !== 0) { resolveResult(null); return; }
      try {
        const doc: unknown = JSON.parse(new TextDecoder("utf-8", {fatal:true, ignoreBOM:true}).decode(Buffer.concat(chunks)));
        resolveResult(object(doc) && !pyTruthy(doc.error) && Array.isArray(doc.agents) ? doc.agents.filter(object) : null);
      } catch { resolveResult(null); }
    });
  });
}

/** The state column for one roster JSON row; `tap team` reads the same rule off its own rows. */
function jsonSeatState(row: ObjectRow): string {
  return displayState({status: text(row.status), statusReason: text(row.status_reason), agentState: text(row.agent_state) || "unknown",
    agentStateReason: text(row.agent_state_reason), daemon: isDaemon(row)});
}

/** What the shared seat filters read off a roster JSON row. */
function jsonSeatFacts(row: ObjectRow, now: number): SeatFacts {
  const state = jsonSeatState(row), ended = Date.parse(text(row.turn_ended_at)) / 1000;
  return {harness: text(row.harness), daemon: isDaemon(row), models: [text(row.observed_model), text(row.model)], state, idleSeconds: idleSeconds(state, ended, now)};
}

export function teamStatus(states: string[], unobserved = false, colored = !!process.stdout.isTTY && !process.env.NO_COLOR, unobservedLabel = "unknown"): string {
  const kinds: [string, number][] = unobserved ? [[unobservedLabel, 33]] : [];
  if (!unobserved) {
    if (states.includes("blocked")) kinds.push(["blocked", 31]);
    if (states.includes("error")) kinds.push(["error", 31]);
    if (states.includes("working")) kinds.push(["working", 32]);
    // An ended turn that owns background work will wake itself (tap-i5fzq).
    if (states.includes("waiting")) kinds.push(["waiting", 93]);
    if (!kinds.length) kinds.push(["idle", 34]);
  }
  return kinds.map(([label, color]) => `${colored ? `\x1b[${color}m●\x1b[0m` : "●"} ${label}`).join(" ");
}

function spoolWarning(root: string, now: number): string {
  if (!root) return "";
  const spool = join(root, ".tap/bus/spool");
  let entries: string[];
  try { entries = readdirSync(spool).filter(name => name.endsWith(".md") && name !== ".md" && isRegularFile(join(spool, name))); }
  catch { return ""; }
  if (!entries.length) return "";
  let oldest = Infinity;
  for (const name of entries) {
    try { oldest = Math.min(oldest, statSync(join(spool, name)).mtimeMs / 1000); } catch { /* Entry disappeared. */ }
  }
  return `spool ${entries.length}${oldest === Infinity ? "" : `/${compactAge(Math.max(0, now - oldest))}`}`;
}

export async function teamsView(argv: string[], scriptsDir = tapScriptsDir()): Promise<Result> {
  const separator = argv.indexOf("--");
  const head = separator < 0 ? argv : argv.slice(0,separator), tail = separator < 0 ? [] : argv.slice(separator);
  const json = head.includes("--json"), wide = head.includes("--wide");
  const refuse = (error_class: string, detail: string, action = "tap help teams"): Result => json
    ? {exit:1,stdout:JSON.stringify({ok:false,error_class,action,detail})+"\n",stderr:""}
    : failure(`tap teams: ${detail}; next: ${action}\n`);
  let filters = emptySeatFilters(), options = head, count: number | undefined;
  // -n keeps the word typed after it through the filter lift, then comes out itself.
  try { ({filters, rest:options} = takeSeatFilters(head,"tap help teams",["-n"])); ({count, rest:options} = takeCount(options,"tap help teams")); }
  catch (error) {
    if (error instanceof TapError) return refuse(error.errorClass,error.detail,error.action);
    throw error;
  }
  // A seat filter asks about seats, so it implies the roster view.
  const filtering = hasSeatFilters(filters), seats = options.includes("--seats") || filtering;
  const viewClash = options.includes("--seats") ? "--seats and --details are alternative views" : "seat filters imply the seat view, and --details is the team view; pick one";
  if (seats && options.some(arg => arg === "--help" || arg === "-h")) return helpArgv(["teams"]);
  if (json && !seats) return refuse("usage_error", "--json requires --seats");
  if (seats && options.includes("--details")) return refuse("usage_error", viewClash);
  let args: Result | TeamsArgs;
  args = parseTeams(seats ? [...options.filter(arg => !["--seats", "--json", "--wide"].includes(arg)),...tail] : [...options,...tail]);
  if ("exit" in args) {
    if (seats && args.exit !== 0) return refuse("usage_error", args.stderr.trim().split("\n").at(-1) ?? "invalid option");
    return args;
  }
  try { args.count = recentCount(count, args.recent, "tap help teams"); }
  catch (error) {
    if (error instanceof TapError) return refuse(error.errorClass, error.detail, error.action);
    throw error;
  }
  if (seats && args.details) return refuse("usage_error", viewClash);
  // Ordering every seat on the machine is out of scope: --recent orders teams here, seats on tap team.
  if (seats && args.recent) return refuse("usage_error", "--recent orders teams, not seats; seats of one team: tap team --recent", "tap team --recent");
  const now = Date.now() / 1000, snapshot = loadGlobalRegistry(), filterClock = seatClock();
  if (seats && snapshot.marker === "invalid") return refuse("invalid_flip", "machine index is unreadable", "tap doctor");
  if (snapshot.marker === "absent") return seats ? refuse("unanchored_bus", NO_MACHINE_INDEX, "tap init  OR  tap session launch") : failure(`tap teams: ${NO_MACHINE_INDEX}; next: tap init  OR  tap session launch\n`);
  const doc = snapshot.marker === "live" ? snapshot.doc : null;
  const teams = doc && object(doc.teams) ? doc.teams : {};
  type TeamRow = { name: string; root: string; active: number; total: number; attached: number; warn: string; status: string; unobserved: boolean; lastActive?: LastActive | null };
  const rows: TeamRow[] = [], pending: {name: string; root: string; stored: ObjectRow}[] = [];
  const agents: ObjectRow[] = [];
  for (const name of Object.keys(teams).sort(compare)) {
    const meta = teams[name];
    if (!object(meta) || meta.state === "historical") continue;
    const root = text(meta.root);
    let path = "";
    if (root) {
      const acting = resolveTeamFromDoc(snapshot.doc!, name);
      if (acting.status !== "ok") {
        rows.push({name, root, active:0, total:0, attached:0, warn:"acting_unreachable", status:teamStatus([], true), unobserved:true});
        continue;
      }
      path = acting.registryLocation;
    }
    if (path && teamRegistryFileRefusal(path)) {
      rows.push({name, root, active:0, total:0, attached:0, warn:"old_store", status:teamStatus([], true, undefined, "old_store"), unobserved:true});
      continue;
    }
    pending.push({name, root, stored:seatMap(readObject(path))});
  }
  let next = 0;
  await Promise.all(Array.from({length:Math.min(8, pending.length)}, async () => {
    while (next < pending.length) {
      const {name, root, stored} = pending[next++]!;
      const observed = await observedRoster(name, scriptsDir);
      // An explicit --state replaces the default live-only scope: it names the seats it wants.
      const inScope = (row: ObjectRow) => args.all || filters.state.length > 0 || row.status === "active";
      if (seats && observed) agents.push(...observed.filter(row => inScope(row) && seatMatches(filters,jsonSeatFacts(row,filterClock))).map(row => ({...row,team:name})));
      const active = observed?.filter(row => row.status === "active") ?? [];
      const total = observed?.length ?? Object.values(stored).filter(object).length;
      const attached = active.filter(row => pyTruthy(row.attached) && !["0", "no", "false"].includes(String(row.attached))).length;
      const states = active.map(row => row.agent_state === "idle-at-prompt" ? "idle" : text(row.agent_state));
      const warn = [observed === null ? "roster_unreadable" : "", spoolWarning(root, now),
        observed !== null && total > active.length ? `${total - active.length} dormant` : ""].filter(Boolean).join(" · ") || "-";
      rows.push({name, root, active:active.length, total, attached, warn, status:teamStatus(states, observed === null), unobserved:observed === null,
        ...(args.recent ? {lastActive:teamActivity(stored, observed, filterClock)} : {})});
    }
  }));
  if (seats) {
    const collectedAt = Date.now() / 1000;
    for (const agent of agents) if (object(agent.prompt_cache)) {
      agent.prompt_cache = refreshPromptCache(agent.prompt_cache as unknown as PromptCache,collectedAt);
    }
    const missing = rows.filter(row => row.unobserved).map(row => row.name).sort(compare);
    const gap = missing.length ? `tap teams --seats: could not observe ${missing.join(", ")}; tap teams --details shows why\n` : "";
    agents.sort((a,b) => {
      const expiry = (row: ObjectRow) => object(row.prompt_cache) && row.prompt_cache.state === "warm" && typeof row.prompt_cache.expires_at === "string"
        ? Date.parse(row.prompt_cache.expires_at) : Infinity;
      return (expiry(a) - expiry(b) || compare(text(a.team),text(b.team)) || compare(text(a.handle),text(b.handle)));
    });
    if (json) return success(ensureAscii(JSON.stringify({ok:true,scope:"machine",agents,unobserved_teams:missing}))+"\n");
    if (!agents.length) return {exit:0,stdout:`tap teams --seats: ${filtering ? "no seats match these filters" : `no ${args.all ? "registered" : "active"} seats${missing.length ? " observed" : ""}`}\n`,stderr:gap};
    const colored = rosterStyle();
    // JSON retains its flat ordering. The human view groups the same seats by team.
    const expiry = (row: ObjectRow): number => object(row.prompt_cache) && row.prompt_cache.state === "warm"
      && typeof row.prompt_cache.expires_at === "string" && Number.isFinite(Date.parse(row.prompt_cache.expires_at))
      ? Date.parse(row.prompt_cache.expires_at) : Infinity;
    const cacheRank = (row: ObjectRow) => Number.isFinite(expiry(row)) ? 0
      : object(row.prompt_cache) && row.prompt_cache.state === "cold" ? 1 : 2;
    // Filters show only the teams that hold a selected seat, which may be a dormant team.
    const groups = rows.filter(row => row.unobserved || (filtering ? agents.some(agent => agent.team === row.name) : args.all || row.active)).map(team => {
      const seats = agents.filter(agent => agent.team === team.name).sort((a,b) =>
        cacheRank(a) - cacheRank(b) || expiry(a) - expiry(b) || compare(text(a.handle),text(b.handle)));
      return {team,seats};
    }).sort((a,b) => compareTeams(a.team.name,b.team.name));
    const headers = ["handle", "harness", "state", "context", "family", "model", "preset"];
    const records = groups.flatMap(group => group.seats.map(row => {
      const sample = object(row.context_tokens) ? row.context_tokens as unknown as TokenSample : undefined;
      const count = sample?.input_tokens == null ? "—" : formatContextTokens(sample);
      const usage = row.harness === "opencode" && sample?.input_tokens != null && sample.window_tokens == null ? `${count}/?` : count;
      const state = jsonSeatState(row);
      const model = modelCell({observedModel:text(row.observed_model),observedEffort:text(row.observed_effort),launchModel:text(row.model),launchEffort:text(row.effort)},colored);
      const preset = text(row.preset) ? text(row.preset) + (row.preset_inferred ? "?" : "") : "n/a";
      return [text(row.handle),text(row.harness),statusIndicator(state),
        [usage,formatPromptCache(row.prompt_cache as PromptCache | null,colored)].filter(Boolean).join(" "),
        text(row.family) || "-",model,preset];
    }));
    const terminal = rosterWidth(wide), kept = fitColumns(columnWidths(headers,records),terminal === null ? null : Math.max(1,terminal - 2));
    const hidden = headers.filter((_,i) => !kept.includes(i));
    // Fit once for every team, then insert headings without recomputing widths.
    const lines = rosterTable(kept.map(i=>headers[i]!),records.map(row=>kept.map(i=>row[i]!)),null).trimEnd().split("\n");
    let stdout = `  ${lines.shift()}\n`, offset = 0;
    for (const {team,seats} of groups) {
      if (team !== groups[0]!.team) stdout += "\n";
      const heading = colored ? `\x1b[1;36m${team.name}\x1b[0m` : team.name;
      stdout += `${heading}  ${team.unobserved ? "?/?" : `${team.active}/${team.total}`} seats active  ${team.root}\n`;
      for (const _ of seats) stdout += `  ${lines[offset++]}\n`;
    }
    return {exit:0,stdout,
      stderr:gap + (hidden.length ? `tap teams: hid ${hidden.join(", ")} to fit ${terminal} columns; tap teams --seats --wide shows every column\n` : "")};
  }
  // --recent is for after a restart, when nothing is active: it lists dormant teams too.
  const everyTeam = args.all || args.recent;
  const listed = rows.filter(row => everyTeam || row.active || row.unobserved);
  const visible = args.recent
    ? recentOrder(listed, row => row.lastActive ?? null, (a,b) => compareTeams(a.name,b.name), args.count).map(({row}) => row)
    : listed.sort((a,b) => compareTeams(a.name,b.name));
  if (!visible.length) return success(`tap teams (machine-wide): no ${everyTeam ? "enrolled" : "active"} teams\n`);
  const recency = (row: TeamRow): string[] => args.recent ? [lastActiveCell(row.lastActive ?? null, filterClock)] : [];
  const extraHeader = args.recent ? ["LAST ACTIVE"] : [];
  return success(args.details
    ? table(["TEAM", "SEATS", ...extraHeader, "ATTACHED", "WARN", "WORKDIR"], visible.map(row => [row.name, `${row.active}/${row.total}`, ...recency(row), String(row.attached), row.warn, row.root]))
    : table(["TEAM", "SEATS", ...extraHeader, "STATUS"], visible.map(row => [row.name, `${row.active}/${row.total}`, ...recency(row), row.status])));
}

// One parser and summary owner for both public teams and synchronous team list.
if (import.meta.main) process.exitCode = writeRoutingResult(await teamsView(process.argv.slice(3)));
