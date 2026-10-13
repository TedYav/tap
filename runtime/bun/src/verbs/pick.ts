// `tap pick [--pane <%id>] [--list] [--json]`
//
// The lookup behind the tmux popup (`tap keybinding`): fuzzy-pick one live seat
// across every enrolled team and give back its full `team/handle`. With
// `--pane` the name and a trailing space are TYPED into that pane (tmux
// send-keys -l) so a human writing prose can keep typing; it never presses
// Enter. Esc types nothing. With `--pane` the picker lists the current team
// (the team whose seat occupies that pane) first, and fzf breaks score ties by
// that order: the same handle on two teams resolves to the current team.
// `--list` keeps index order.
//
// Exit: 0 selected | cancelled | listed; 1 refusal; 130 interrupted.

import { TapError } from "../context";
import { ensureAscii } from "../fsatomic";
import { pick, displayText, type PickerChoice, type PickOptions, type PickResult } from "../fzf";
import { pickerModel, type PickerTeam } from "../attach-picker";
import { tmux } from "../tmux";
import { validToken } from "../ids";
import { approvalPrompt } from "../agent-state";

const HARNESSES = ["claude", "codex", "opencode", "cursor", "agy", "hermes"];

export interface LookupSeat { target: string; team: string; handle: string; harness: string; state: "live"; crew: boolean }
export interface LookupModel { seats: LookupSeat[]; skipped: { team: string; state: string; detail: string }[] }
type Choose = <T>(choices: PickerChoice<T>[], options: PickOptions) => Promise<PickResult<T>>;

/** The popup's machine-readable list: live seats only, daemons excluded by the model. */
export function lookupModel(teams: PickerTeam[]): LookupModel {
  const seats: LookupSeat[] = [], skipped: LookupModel["skipped"] = [];
  for (const team of teams) {
    if (team.state !== "ok") { if (team.state !== "historical") skipped.push({ team: team.name, state: team.state, detail: team.detail }); continue; }
    for (const seat of team.seats) {
      seats.push({ target: `${team.name}/${seat.handle}`, team: team.name, handle: seat.handle, harness: seat.harness, state: "live", crew: seat.crew });
    }
  }
  return { seats, skipped };
}

/**
 * The team the human is typing in: the one whose live seat occupies the origin pane. A pane no
 * seat occupies, or one that two teams claim, gets "" and keeps index order. There is no cwd
 * lookup on purpose: resolving a checkout runs git without a deadline, and an ordering hint
 * must never keep the popup from opening.
 */
export function currentTeam(teams: PickerTeam[], pane: string): string {
  if (!pane) return "";
  const owners = teams.filter(team => team.seats.some(seat => seat.identity?.observedPaneId === pane));
  return owners.length === 1 ? owners[0]!.name : "";
}

/**
 * A machine without the pinned fzf still gets a filter-as-you-type list: type to narrow, Enter takes
 * the top row, Esc or Ctrl-C cancels at once. The tty is restored on every exit path.
 */
export const listChoose: Choose = (choices, options) => new Promise((resolve, reject) => {
  const input = process.stdin;
  if (!input.isTTY || !process.stderr.isTTY) return reject(new TapError(1, "no_terminal", "tap pick --list", "the built-in picker needs a terminal"));
  let query = "";
  const rows = () => choices.filter(row => row.label.toLowerCase().includes(query.toLowerCase()));
  const draw = () => {
    const shown = rows().slice(0, 15);
    process.stderr.write(`\x1b[2J\x1b[H${options.prompt ?? "Select > "}${displayText(query)}\n${options.header ?? ""}\n\n${shown.map((row, i) => `${i ? "  " : "> "}${row.label}`).join("\n")}\n`);
  };
  const finish = (result: PickResult<any> | Error) => {
    input.off("data", onData); input.setRawMode(false); input.pause(); process.off("exit", restore);
    process.stderr.write("\x1b[2J\x1b[H");
    if (result instanceof Error) reject(result); else resolve(result);
  };
  const restore = () => { try { input.setRawMode(false); } catch { /* already restored */ } };
  // A data event is an arbitrary chunk (a paste, or "sol" and Enter arriving together): decode it key by key.
  const onData = (chunk: Buffer) => {
    for (const key of chunk.toString("utf8").match(/\x1b\[[0-9;]*[A-Za-z~]|\x1b|[\s\S]/gu) ?? []) {
      if (key === "\x1b" || key === "\x03") return finish(key === "\x03" ? { kind: "interrupted" } : { kind: "cancelled" });
      if (key === "\r" || key === "\n") { const top = rows()[0]; return finish(top ? { kind: "selected", values: [top.value] } : { kind: "cancelled" }); }
      if (key === "\x7f") query = query.slice(0, -1);
      else if (!key.startsWith("\x1b") && !/[\x00-\x1f]/.test(key)) query += key;
    }
    draw();
  };
  process.on("exit", restore);
  input.setRawMode(true); input.resume(); input.on("data", onData);
  draw();
});

/** The pinned fzf is the chooser; only its absence falls back to the plain list. */
const choosePreferred: Choose = async (choices, options) => {
  try { return await pick(choices, options); }
  catch (error) {
    if (error instanceof TapError && (error.errorClass === "fzf_unavailable" || error.errorClass === "fzf_platform_unsupported")) return listChoose(choices, options);
    throw error;
  }
};

/** Type one `team/handle` followed by a space into a pane; never Enter. */
export function typeIntoPane(pane: string, target: string, env = process.env): void {
  const [team, handle, ...rest] = target.split("/");
  if (rest.length || !validToken(team ?? "") || !validToken(handle ?? "")) {
    throw new TapError(1, "invalid_target", "tap pick --list", "refusing to type a value that is not team/handle");
  }
  // Default-deny (tap-rlebf.1): typed text can answer a prompt (Cursor's
  // "Run (once) (y)" takes the y of "yes/peer"). The popup does not know which
  // harness owns the pane, so any harness's prompt, or a pane it cannot read,
  // refuses before a key.
  const frame = tmux(["capture-pane", "-p", "-J", "-t", pane], env);
  if (frame.code !== 0) throw new TapError(1, "type_failed", "tap pick", `could not read pane ${pane} before typing; typed nothing`);
  if (HARNESSES.some(harness => approvalPrompt(harness, frame.stdout))) {
    throw new TapError(1, "approval_prompt", "tap pick", `pane ${pane} shows an approval prompt; typed nothing. Answer it yourself, then pick again`);
  }
  const result = tmux(["send-keys", "-t", pane, "-l", "--", `${target} `], env);
  if (result.code !== 0) {
    throw new TapError(1, "type_failed", "tap pick", `could not type into pane ${pane}: ${displayText(result.stderr.trim()) || "tmux refused"}`);
  }
}

export async function cmdPick(argv: string[], choose: Choose = choosePreferred, teams = (): PickerTeam[] => pickerModel().teams,
  current: (teams: PickerTeam[], pane: string) => string = currentTeam): Promise<number> {
  let pane = "", list = false, json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--pane") {
      pane = argv[++i] ?? "";
      if (!/^%\d+$/.test(pane)) throw new TapError(1, "usage_error", "tap help pick", "--pane needs a tmux pane id such as %7");
    }
    else if (a === "--list") list = true;
    else if (a === "--json") { json = true; process.env.TAP_JSON = "1"; }  // so refusals render as JSON too
    else if (a.startsWith("-")) throw new TapError(1, "unknown_option", "tap help pick", `unknown option '${a}'`);
    else throw new TapError(1, "usage_error", "tap help pick", `unexpected arg '${a}'`);
  }
  if (list && pane) throw new TapError(1, "usage_error", "tap help pick", "--list prints the seats; it cannot also type into a pane");
  if (json && !list) throw new TapError(1, "usage_error", "tap help pick", "--json applies to --list; the picker itself is human output");

  const roster = teams(), found = lookupModel(roster);
  if (list) {
    if (json || process.env.TAP_JSON === "1") process.stdout.write(`${ensureAscii(JSON.stringify({ seats: found.seats, skipped: found.skipped }))}\n`);
    else for (const seat of found.seats) process.stdout.write(`${displayText(seat.target)}\t${displayText(seat.harness)}\t${seat.state}\n`);
    return 0;
  }
  if (!found.seats.length) {
    // An unreadable roster is not an empty one: launching "the missing seat" could duplicate a live one.
    if (found.skipped.length) throw new TapError(1, "teams_unobservable", "tap doctor",
      `no live seat could be confirmed; could not read: ${found.skipped.map(t => `${displayText(t.team)} (${displayText(t.state)}: ${displayText(t.detail)})`).join(", ")}`);
    throw new TapError(1, "no_candidates", "tap session launch <preset|harness> <handle>", "no live seat on any enrolled team to pick");
  }
  const home = current(roster, pane);
  const seats = [...found.seats.filter(seat => seat.team === home), ...found.seats.filter(seat => seat.team !== home)];
  const header = pane ? "Type to search · Enter types the name · Esc cancels" : "Type to search · Enter select · Esc cancel";
  const result = await choose(seats.map(seat => ({ id: seat.target, value: seat.target,
    label: `${displayText(seat.target)}  ${displayText(seat.harness)}${seat.crew ? " (crew)" : ""}` })),
    { verb: "pick", prompt: "Teammate > ", tiebreak: "index", header: home ? `${displayText(home)} first · ${header}` : header });
  if (result.kind === "interrupted") return 130;
  if (result.kind === "cancelled") return 0;
  const target = result.values[0]!;
  if (pane) typeIntoPane(pane, target);
  else process.stdout.write(`${target}\n`);
  return 0;
}
