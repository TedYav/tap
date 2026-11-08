// One chooser for verbs that name an EXISTING seat: where the verb would refuse
// a miss or an ambiguity, a human on a terminal picks instead. Launching and
// message addressing stay exact and never come here.
import { TapError } from "./context";
import { displayText, pick, type FzfEffects } from "./fzf";

export interface SeatChoice { handle: string; label: string }
export interface SeatPickOptions { query?: string; prompt?: string; header?: string; effects?: FzfEffects; env?: NodeJS.ProcessEnv }
export type SeatPick = { kind: "selected"; handle: string } | { kind: "cancelled" } | { kind: "interrupted" } | { kind: "unavailable" };

/** Refusal classes meaning "no human chooser here": the caller keeps its own refusal unchanged. */
const UNAVAILABLE = new Set(["no_terminal", "fzf_unavailable", "fzf_platform_unsupported"]);

/** `pick` owns the terminal/JSON/TERM check, so agents (no foreground tty) and --json never see a prompt. */
export async function pickSeat(verb: string, choices: SeatChoice[], options: SeatPickOptions = {}): Promise<SeatPick> {
  if (!choices.length) return { kind: "unavailable" };
  const rows = choices.map(choice => ({ id: choice.handle, label: displayText(choice.label), value: choice.handle }));
  const pickOptions = { verb, query: options.query, prompt: options.prompt ?? "Seat > ", tiebreak: "index" as const,
    header: options.header ?? "Type to search · Enter select · Esc cancel" };
  try {
    const result = options.effects ? await pick(rows, pickOptions, options.effects, options.env ?? process.env) : await pick(rows, pickOptions);
    return result.kind === "selected" ? { kind: "selected", handle: result.values[0]! } : result;
  } catch (error) {
    if (error instanceof TapError && UNAVAILABLE.has(error.errorClass)) return { kind: "unavailable" };
    throw error;
  }
}

/** fzf's default match: every query character appears in order, case-insensitively. */
export function fuzzyMatch(query: string, text: string): boolean {
  const haystack = text.toLowerCase();
  let at = 0;
  for (const ch of query.toLowerCase()) {
    at = haystack.indexOf(ch, at);
    if (at < 0) return false;
    at += ch.length;
  }
  return true;
}
