// The launch collision ladder's observations and presentation (launcher.py's
// make_new_record helpers): what the chooser says about the incumbent that holds
// a requested name, the non-interactive refusals, and the resume-artifact probe
// that decides which resume tier the [r] option may promise. Refusal strings are
// the incumbent's byte for byte; chooser glosses were shortened to fit a 50-column
// row, and the launch differential oracle maps the recorded ones explicitly.
// The probe itself lives in resume-identity.ts now; only the re-export for
// new.ts stays here.
import { spawnSync } from "node:child_process";
import { tmuxReadOnly } from "../tmux";
import { promptChoice, type ChoiceOption } from "./prompt";
import { errorLine } from "./resume-prelude";

const err = (line: string) => process.stderr.write(`${line}\n`);

// ---- styling (launcher.py styled) ----

type Role = "error" | "warning";
const ROLE_INDEX: Record<Role, number> = { error: 0, warning: 1 };

/** launcher.py styled(role, text, sys.stderr): tput colour only for a capable terminal. */
export function styledStderr(role: Role, text: string): string {
  if (process.env.NO_COLOR !== undefined || !process.env.TERM || process.env.TERM === "dumb") return text;
  const force = process.env.CLICOLOR_FORCE;
  let capable = !!force && force !== "0";
  if (!capable) { try { capable = process.stderr.isTTY === true; } catch { capable = false; } }
  if (!capable) return text;
  const tokens: string[] = [];
  for (const args of [["setaf", "1"], ["setaf", "3"], ["bold"], ["dim"], ["sgr0"]]) {
    const result = spawnSync("tput", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (result.error || result.status !== 0 || !result.stdout) return text;
    tokens.push(result.stdout);
  }
  return `${tokens[ROLE_INDEX[role]]}${text}${tokens[4]}`;
}

/** emit_error_human: one line with a single next action, else a next/or block. */
function emitErrorHuman(verb: string, problem: string, actions: string[]): void {
  const prefix = styledStderr("error", `tap ${verb}:`);
  if (actions.length === 1) { err(`${prefix} ${problem}; next: ${actions[0]}`); return; }
  err(`${prefix} ${problem}`);
  if (actions.length) {
    err("");
    actions.forEach((action, index) => err(`  ${(index === 0 ? "next" : "or").padEnd(4)}  ${action}`));
  }
}

const jsonEnv = () => process.env.TAP_JSON === "1";

// ---- non-interactive refusals ----

/** print_session_exists. */
export function printSessionExists(handle: string, harness: string, detail: string, nextHandle: string | null = null, json = jsonEnv()): void {
  const next = nextHandle || "<new-name>";
  const resume = `tap session resume ${handle}`;
  if (json) { process.stdout.write(errorLine("session_exists", resume, detail)); return; }
  emitErrorHuman("session", detail, [resume, `tap session launch ${harness} ${next}`, `tap session launch ${harness} ${handle} --fresh`]);
}

/** A retained row is not a live tmux-name collision. Keep it until explicit reseat. */
export function printStoppedSession(handle: string, harness: string, name: string, json: boolean): void {
  const action = `tap session launch ${harness} ${handle} --fresh`;
  const detail = `${name} has a retained seat record but no live tmux session; --fresh reclaims the record and launches the seat`;
  if (json) { process.stdout.write(errorLine("session_record_exists", action, detail)); return; }
  emitErrorHuman("session", detail, [action]);
}

const createdPhrase = (label: string | null) => label ? `created ${label}` : "creation time unknown";

/** print_off_roster_tmux_exists: create-intent recovery for a live off-roster tmux name. */
export function printOffRosterTmuxExists(name: string, harness: string, handle: string, nextHandle: string | null, createdLabel: string | null, json = jsonEnv()): void {
  const next = nextHandle || "<new-name>";
  const detail = `a tmux session named ${name} already exists (${createdPhrase(createdLabel)}); it is not on the team roster`;
  const created = `tap session launch ${harness} ${next}`;
  if (json) { process.stdout.write(errorLine("session_exists", created, detail)); return; }
  emitErrorHuman("session", detail, [created, `tap session launch ${harness} ${handle} --fresh`,
    `to reattach: tmux attach -t ${name}  (or: tap session resume ${handle})`]);
}

// ---- choosers ----

export type Choose = typeof promptChoice;

/** describe_revive_tier: what [r] would actually do, by resume tier (tap-u3bl). */
export function describeReviveTier(tier: string): string {
  return ({
    exact: "Resume the chat by its native ID",
    picker: "No usable ID; open the native picker",
    latest: "No usable ID; resume the latest chat",
    fresh: "Nothing to resume; start fresh",
    // tap-we6b rework: the stored id failed the resume-artifact probe; [r]
    // refuses rather than silently start a different conversation.
    stale: "Chat never persisted; resume refuses",
  } as Record<string, string>)[tier] ?? "Resume this seat";
}

/** Why [f] cannot fork this incumbent, or null when a fork can start from its stored conversation.
 *  A reason fits 21 characters: a colourless row wraps it in "(unavailable: ...)". */
export type ForkUnavailable = string | null;
export const NOT_A_SEAT = "not a TAP seat";

/** [f] is always listed so the menu keeps one shape; it is enabled only when a fork can succeed.
 *  Reasons stay lowercase for the error sentences that end with them; the row capitalizes. */
const forkOption = (unavailable: ForkUnavailable): ChoiceOption => unavailable === null
  ? ["f", "fork", "Fork a new session with this history"]
  : ["f", "fork", unavailable.charAt(0).toUpperCase() + unavailable.slice(1), true];

/** prompt_session_exists: a live or unobservable incumbent; [r] reattaches. */
export function promptSessionExists(choose: Choose, name: string, harness: string, stateDesc: string | null, reviveTierWord: string | null,
  forkUnavailable: ForkUnavailable): string {
  const question = stateDesc ? `'${name}' (${harness}): ${stateDesc}` : `'${name}' already exists (${harness})`;
  return choose("session", question, [
    ["r", "resume", reviveTierWord ? describeReviveTier(reviveTierWord) : "Reattach to the running session"],
    ["n", "new", "Start a sibling with a suffixed name"],
    forkOption(forkUnavailable),
    ["k", "kill", "Stop it and start fresh"],
    ["q", "quit", "Leave everything unchanged"],
  ], "r");
}

/** prompt_new_collision: a gone incumbent; [r] always recreates. */
export function promptNewCollision(choose: Choose, name: string, harness: string, foundState: string, reviveTierWord: string,
  forkUnavailable: ForkUnavailable): string {
  return choose("session", `'${name}' (${harness}): ${foundState}`, [
    ["r", "resume", describeReviveTier(reviveTierWord)],
    ["n", "new", "Start a sibling with a suffixed name"],
    forkOption(forkUnavailable),
    ["k", "kill", "Start fresh under this name"],
    ["q", "quit", "Leave everything unchanged"],
  ], "r");
}

/** prompt_off_roster_tmux_collision: create-intent, so no resume option; nothing to fork. */
export function promptOffRosterTmuxCollision(choose: Choose, name: string, _harness: string, createdLabel: string | null): string {
  const question = `a tmux session named ${name} already exists (${createdPhrase(createdLabel)}); it is not on the team roster`;
  err(`tap session: to reattach: tmux attach -t ${name}  (or: tap session resume <handle>)`);
  return choose("session", question, [
    ["n", "new", "Start a sibling with a suffixed name"],
    forkOption(NOT_A_SEAT),
    ["k", "kill", "Stop it; start fresh under this name"],
    ["q", "quit", "Leave everything unchanged"],
  ], "n");
}

// ---- state line ----

/** Python's round(): half to even. */
const pyRound = (value: number): number => {
  const floor = Math.floor(value), diff = value - floor;
  return diff > 0.5 || (diff === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
};

/** relative_age: a cheap human age for a stored ISO stamp, or null to omit it. */
export function relativeAge(timestamp: string | null | undefined, now = Date.now()): string | null {
  if (!timestamp) return null;
  // fromisoformat: naive stamps are UTC here; fractions beyond milliseconds are dropped.
  const iso = timestamp.replace("Z", "+00:00").replace(/(\.\d{3})\d+/, "$1");
  const zoned = /[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}+00:00`;
  const then = Date.parse(zoned);
  if (Number.isNaN(then)) return null;
  const secs = (now - then) / 1000;
  if (secs < 0) return null;
  if (secs < 90) return "just now";
  if (secs < 90 * 60) return `${pyRound(secs / 60)}m ago`;
  if (secs < 36 * 3600) return `${pyRound(secs / 3600)}h ago`;
  return `${pyRound(secs / 86400)}d ago`;
}

/** describe_session_state: nature · roster · age. */
export function describeSessionState(nature: string, seatedHandle: string | null, age: string | null): string {
  const parts = [nature, seatedHandle ? `registered as ${seatedHandle}` : "not on roster"];
  if (age) parts.push(age);
  return parts.join(" · ");
}

// ---- tmux display facts (never classification inputs) ----

// The trailing colon makes `=name` a session target: bare, tmux resolves a
// slash-named session (every seat's) to nothing and prints an empty line.
function displayField(name: string, field: string): string | null {
  const result = tmuxReadOnly(["display-message", "-p", "-t", `=${name}:`, field], process.env);
  return result.code === 0 ? result.stdout.trim() : null;
}

/** tmux_session_created_label: local HH:MM of a live session's creation, or null. */
export function tmuxSessionCreatedLabel(name: string): string | null {
  const raw = displayField(name, "#{session_created}");
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const created = new Date(Number(raw) * 1000);
  if (Number.isNaN(created.getTime())) return null;
  return `${String(created.getHours()).padStart(2, "0")}:${String(created.getMinutes()).padStart(2, "0")}`;
}

/** session_attached: whether a client is attached, or null when unknown. */
export function sessionAttached(name: string): boolean | null {
  const flag = displayField(name, "#{session_attached}");
  if (flag === null || flag === "") return null;
  return flag !== "0";
}

// ---- resume artifact (conversation_artifact_missing) ----

export { recordHasResumeArtifact } from "./resume-identity";
