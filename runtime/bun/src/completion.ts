// Native, observational candidates for shell adapters. A TAB press never enters
// context resolution, onboarding, tmux observation, or a TAP state writer.
import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { busHomeForRegistry, loadGlobalRegistry, resolveTeamFromDoc } from "./index-home";
import { loadCurrentRegistry, seatMap, type Seat } from "./registry";
import { codePointCompare } from "./team/selection";
import { HELP_COMPOSITES, HELP_TOMBSTONES, helpRows } from "./help";
import { seatIsRelaunchable } from "./launcher/complete";
import { FORKABLE_HARNESSES } from "./harness-families";
import { tapRoot } from "./scripts-dir";

type Candidate = { value: string; description: string };
type TeamRows = { name: string; root: string; registryLocation: string; seats: Record<string, Seat> };

const TOP = [...new Set(["help", "completion", ...helpRows().filter(parts => parts.length === 1 && parts[0] !== "advisory" && !(parts[0]! in HELP_TOMBSTONES)).map(parts => parts[0]!)])].sort(codePointCompare);
const TEAM = [...(HELP_COMPOSITES.team ?? [])].sort(codePointCompare);
const SESSION = [...(HELP_COMPOSITES.session ?? [])].sort(codePointCompare);
const KEYBINDING = ["install", "remove", "status"];
const FLAGS: Record<string, string[]> = {
  attach: ["--no-resume", "--next", "--interactive", "-i"],
  teams: ["--all", "--details", "--json"],
  team: ["--json", "--all", "--names", "--active", "--offline", "--context"],
  "team roster": ["--json", "--all", "--names", "--active", "--offline", "--context"],
  "team list": ["--json", "--all", "--details"],
  "team attach": ["--only", "--except", "--dry-run", "--tabs", "--all", "--yes"],
  "team detach": ["--only", "--except", "--handle", "--yes", "--dry-run"],
  "team down": ["--only", "--except", "--dry-run", "--json", "--yes"],
  "team up": ["--only", "--except", "--dry-run", "--json", "--yes"],
  "team shutdown": ["--only", "--except", "--dry-run", "--json", "--yes"],
  "team out": ["--only", "--except", "--dry-run", "--json", "--yes", "--kill", "--hard"],
  "session resume": ["--all", "--dry-run", "--json"],
  "session restart": ["--force", "--dry-run", "--json"],
  "session fork": ["--dry-run", "--json"],
  send: ["--team", "--from", "--json", "--ask", "--urgent", "-f"],
  assign: ["--team", "--from", "--json", "-f"],
  reply: ["--team", "--by", "-f"],
  out: ["--team", "--hard", "--kill", "--json"],
  shutdown: ["--team", "--json"],
  down: ["--team", "--dry-run", "--json"],
  up: ["--team", "--dry-run", "--json"],
  poll: ["--team", "--json", "--quiet"],
  outstanding: ["--team", "--json", "--stale"],
  peek: ["--pane", "--json"],
  nudge: ["--pane", "--aggressiveness"],
  pick: ["--pane", "--list", "--json"],
  "keybinding install": ["--key", "--tap", "--dry-run", "--json"],
  "keybinding remove": ["--dry-run", "--json"],
  "keybinding status": ["--json"],
  "tmux-defaults install": ["--dry-run", "--status-bar", "--no-status-bar", "--json"],
  "tmux-defaults remove": ["--dry-run", "--json"],
  "tmux-defaults status": ["--json"],
};
const TEAM_VALUE = new Set(["--team"]);
const LIST_VALUE = new Set(["--only", "--except"]);
const ACTOR_VALUE = new Set(["--from", "--by", "--handle", "--to"]);
const TAKES_VALUE = new Set([...TEAM_VALUE, ...LIST_VALUE, ...ACTOR_VALUE, "-f", "--preset", "--model", "--pane", "--message", "--stale", "--aggressiveness", "-m", "--tap", "--key"]);
const TARGET_VERBS = new Set(["attach", "out", "shutdown", "down", "up", "peek", "clear", "poll", "outstanding", "send", "assign", "nudge"]);
const QUALIFIED_TARGET_VERBS = new Set(["attach", "out", "shutdown", "down", "up", "clear", "send", "assign", "nudge"]);
const FILE_SENTINEL = "\x1fFILES";

function row(value: unknown): value is Seat { return typeof value === "object" && value !== null && !Array.isArray(value); }
function clean(text: unknown): string { return String(text ?? "").replace(/[\t\r\n\x00-\x1f\x7f]/g, " ").trim(); }
function token(text: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text); }
function state(seat: Seat): string {
  const status = clean(seat.status || "recorded");
  const reason = clean(seat.status_reason);
  return reason ? `stored ${status} (${reason})` : `stored ${status}`;
}

/** One marker snapshot; malformed or unavailable authorities yield no rows. */
function teams(env: NodeJS.ProcessEnv): TeamRows[] {
  const snap = loadGlobalRegistry(env.TAP_INDEX_HOME);
  if (snap.marker !== "live" || !snap.doc) return [];
  const entries = snap.doc.teams;
  if (!row(entries)) return [];
  const out: TeamRows[] = [];
  for (const name of Object.keys(entries).sort(codePointCompare)) {
    if (!token(name)) continue;
    const resolved = resolveTeamFromDoc(snap.doc, name);
    if (resolved.status !== "ok") continue;
    try {
      const doc = loadCurrentRegistry(resolved.registryLocation);
      if (!row(doc.seats)) continue;
      const seats = seatMap(doc);
      if (Object.entries(seats).some(([handle, seat]) => !token(handle) || !row(seat))) continue;
      out.push({ name, root: resolved.root, registryLocation: resolved.registryLocation, seats });
    } catch { /* TAB must be quiet when one authority is unavailable. */ }
  }
  return out;
}

function currentTeam(all: TeamRows[], words: string[], env: NodeJS.ProcessEnv, cwd: string, positionalTeam?: string): TeamRows | undefined {
  // An explicit team operand scopes its selector list even outside that root.
  // An unavailable explicit team must not fall back to the caller's local team.
  if (positionalTeam !== undefined) return all.find(t => t.name === positionalTeam);
  const flag = words.findLastIndex(word => word === "--team");
  if (flag >= 0 && words[flag + 1] && !words[flag + 1]!.startsWith("-")) return all.find(t => t.name === words[flag + 1]);
  // Enrollment roots are taken from the index, never inferred from basename.
  const local = all.filter(t => t.root && (resolve(cwd) === resolve(t.root) || resolve(cwd).startsWith(resolve(t.root) + sep)))
    .sort((a, b) => b.root.length - a.root.length)[0];
  if (local) return local;
  const bus = env.TAP_HOME;
  return bus ? all.find(t => busHomeForRegistry(t.registryLocation) === resolve(bus)) : undefined;
}

function seatEligible(command: string, seat: Seat, flag: string): boolean {
  if (LIST_VALUE.has(flag)) return seat.crew !== true;
  if (command === "up" || command === "session resume") return seatIsRelaunchable(seat, true);
  if (command === "session fork") return FORKABLE_HARNESSES.includes(String(seat.harness));
  if (command === "down" || command === "session restart") return seat.crew !== true && seat.delivery !== "poll";
  if (command === "attach" || command === "peek") return seat.delivery !== "poll";
  if (command === "nudge") return seat.delivery !== "poll" && seat.status === "active";
  return true;
}

/** Cursor is one-based in the argv passed by zsh, including the tap command. */
export function completionCandidates(words: string[], cursor: number, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Candidate[] {
  if (!Number.isSafeInteger(cursor) || cursor < 1 || cursor > words.length + 1) return [];
  const before = words.slice(0, cursor - 1);
  const prefix = words[cursor - 1] ?? "";
  if (before[0]?.split("/").at(-1) === "tap") before.shift();
  else if (before[0] === "tap") before.shift();
  const verb = before[0] ?? "";
  const sub = ["team", "session", "keybinding", "tmux-defaults"].includes(verb) ? before[1] ?? "" : "";
  const command = sub ? `${verb} ${sub}` : verb;
  const previous = before.at(-1) ?? "";
  if (previous === "-f" && (verb === "send" || verb === "assign" || verb === "reply")) return [{ value: FILE_SENTINEL, description: "file position" }];
  if (previous === "--tap" && verb === "keybinding") return [{ value: FILE_SENTINEL, description: "file position" }];
  const result: Candidate[] = [];
  const add = (value: string, description: string) => { if (value.startsWith(prefix)) result.push({ value, description }); };
  if (!verb) for (const name of TOP) add(name, "command");
  else if (verb === "team" && !sub && !prefix.startsWith("-")) for (const name of TEAM) add(name, "team command");
  else if (verb === "session" && !sub && !prefix.startsWith("-")) for (const name of SESSION) add(name, "session command");
  else if ((verb === "keybinding" || verb === "tmux-defaults") && before.length === 1 && !prefix.startsWith("-")) for (const name of KEYBINDING) add(name, `${verb} command`);
  const optionalSelector = LIST_VALUE.has(previous) && prefix.startsWith("-");
  const flag = !optionalSelector && (previous === "--team" || previous === "--only" || previous === "--except" || ACTOR_VALUE.has(previous)) ? previous : "";
  if (flag && !(FLAGS[command] ?? []).includes(flag)) return result;
  if (TAKES_VALUE.has(previous) && !flag && !optionalSelector) return [];
  const consumed = new Set<number>();
  for (let i = 1; i < before.length; i++) if (TAKES_VALUE.has(before[i]!)) {
    if (LIST_VALUE.has(before[i]!) && before[i + 1]?.startsWith("-")) continue;
    consumed.add(++i);
  }
  const operands = before.slice(["team", "session", "keybinding", "tmux-defaults"].includes(verb) ? 2 : 1)
    .filter((word, index) => !word.startsWith("-") && !consumed.has(index + (["team", "session", "keybinding", "tmux-defaults"].includes(verb) ? 2 : 1)));
  const targetPosition = operands.length === 0 && !before.includes("--next") && !before.includes("--interactive") && !before.includes("-i");
  const teamOperandCommand = verb === "team" && ["roster", "list", "attach", "detach", "down", "up", "shutdown", "out"].includes(sub);
  const omittedSelector = before.some((word, i) => LIST_VALUE.has(word) && (!before[i + 1] || before[i + 1]!.startsWith("-")));
  const teamPosition = targetPosition && !omittedSelector && (verb === "teams" || teamOperandCommand);
  const needsTeams = flag === "--team" || flag === "--only" || flag === "--except" || ACTOR_VALUE.has(flag) || prefix.includes("/") || (TARGET_VERBS.has(verb) && targetPosition) || (verb === "session" && ["resume", "restart", "fork"].includes(sub) && targetPosition) || teamPosition;
  const all = needsTeams ? teams(env) : [];
  if (flag === "--team") for (const team of all) add(team.name, "enrolled team");
  else if (teamPosition && !flag && !prefix.startsWith("-")) for (const team of all) add(team.name, "enrolled team");
  else if (flag === "--only" || flag === "--except" || ACTOR_VALUE.has(flag) || (TARGET_VERBS.has(verb) && targetPosition) || (verb === "session" && ["resume", "restart", "fork"].includes(sub) && targetPosition)) {
    const targetFlag = flag || command;
    const canQualify = !flag && QUALIFIED_TARGET_VERBS.has(verb);
    const qualified = canQualify && prefix.includes("/");
    if (prefix.includes("/") && !canQualify) return result;
    const slash = prefix.indexOf("/");
    const scope = qualified ? all.filter(t => t.name === prefix.slice(0, slash)) : [currentTeam(all, before, env, cwd, teamOperandCommand ? operands[0] : undefined)].filter((x): x is TeamRows => !!x);
    const list = LIST_VALUE.has(flag) && prefix.includes(",");
    const comma = list ? prefix.lastIndexOf(",") : -1;
    const retained = comma >= 0 ? prefix.slice(0, comma + 1) : "";
    const used = new Set(retained.split(",").filter(Boolean));
    for (const team of scope) for (const [handle, seat] of Object.entries(team.seats).sort(([a], [b]) => codePointCompare(a, b))) {
      if (!seatEligible(command, seat, targetFlag) || used.has(handle)) continue;
      const value = `${retained}${qualified ? `${team.name}/` : ""}${handle}`;
      if (value.startsWith(prefix)) result.push({ value, description: state(seat) });
    }
    if (canQualify && !qualified && !prefix.startsWith("-")) {
      for (const team of all) for (const [handle, seat] of Object.entries(team.seats).sort(([a], [b]) => codePointCompare(a, b))) {
        if (seatEligible(command, seat, targetFlag)) add(`${team.name}/${handle}`, `${state(seat)} on ${team.name}`);
      }
    }
  }
  if (prefix.startsWith("-") && (!TAKES_VALUE.has(previous) || optionalSelector)) for (const option of FLAGS[command] ?? []) if (!before.includes(option)) add(option, "option");
  return result.filter((candidate, i, arr) => arr.findIndex(x => x.value === candidate.value) === i);
}

export function cmdCompletion(argv: string[]): number {
  if (argv.length === 1 && argv[0] === "zsh") {
    const body = readFileSync(join(tapRoot(), "completions/_tap"), "utf8");
    process.stdout.write(`function _tap() {\n${body}\n}\ncompdef _tap tap\n`);
    return 0;
  }
  if (argv[0] !== "candidates") {
    process.stderr.write("tap completion: supported shell is zsh; next: tap help completion\n");
    return 1;
  }
  const cursorAt = argv.indexOf("--cursor");
  const split = argv.indexOf("--");
  if (cursorAt !== 1 || split !== 3) return 0;
  const cursor = Number(argv[2]);
  try {
    for (const candidate of completionCandidates(argv.slice(split + 1), cursor)) {
      process.stdout.write(`${candidate.value}\t${candidate.description}\n`);
    }
  } catch { /* A TAB press never renders an authority error under the prompt. */ }
  return 0;
}
