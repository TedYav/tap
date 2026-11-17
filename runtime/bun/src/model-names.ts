// Human model names: `claude-opus-5-5` reads as `opus5.5`. Every human model
// column routes through here; JSON keeps the raw strings. A model this table
// does not know displays its full raw string, so a new id is never hidden or guessed.
const VERSION = "(\\d+(?:\\.\\d+)*)";
const EFFORT_WORD = "low|medium|high|xhigh|max";
const EFFORT_SUFFIX = new RegExp(`-(${EFFORT_WORD})$`, "i");
/** 256-color ramp from cool to hot. True ANSI dark blue is close to invisible on a dark terminal, so low is a mid blue. */
const EFFORT_COLOR: Record<string, number> = { low: 27, medium: 39, high: 40, xhigh: 208, max: 196 };
/** Each rule reads the id after any `provider/` prefix and `[1m]` context suffix. */
const RULES: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^claude-(opus|fable|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i, m => `${m[1]}${m[2]}${m[3] ? `.${m[3]}` : ""}`],
  [new RegExp(`^gpt-${VERSION}-(astra|luna|sol)$`, "i"), m => `${m[2]}${m[1]}`],
  [new RegExp(`^gemini-${VERSION}-(argon|carbon|flash)(?:-(?:${EFFORT_WORD}))?$`, "i"), m => `${m[2]}${m[1]}`],
  [new RegExp(`^glm-${VERSION}(-flash)?$`, "i"), m => `glm${m[1]}${m[2] ?? ""}`],
  [new RegExp(`^grok-${VERSION}(?:-(?:${EFFORT_WORD}))?$`, "i"), m => `grok${m[1]}`],
  [new RegExp(`^deepseek-v${VERSION}(-flash|-pro)?(?:-\\d{4})?$`, "i"), m => `deepseek${m[1]}${m[2] ?? ""}`],
  [new RegExp(`^kimi-k${VERSION}(?:-(pro))?$`, "i"), m => `kimi${m[1]}${m[2] ?? ""}`],
  // A launch alias names a family, not a version; none is invented for it.
  [/^(opus|fable|sonnet|haiku)$/i, m => m[1]!],
];

/** `claude-opus-5-5` -> `opus5.5`, `opus[1m]` -> `opus`; an unmapped id stays whole. */
export function prettyModelName(raw: string): string {
  const id = raw.replace(/\[1m\]$/i, "").split("/").at(-1)!;
  for (const [pattern, name] of RULES) {
    const match = pattern.exec(id);
    if (match) return name(match).toLowerCase();
  }
  return raw;
}

/** The effort word, colored when the caller's style rule allows it; any other effort stays plain. */
function effortWord(effort: string, color: boolean): string {
  return color && Object.hasOwn(EFFORT_COLOR, effort) ? `\x1b[38;5;${EFFORT_COLOR[effort]}m${effort}\x1b[0m` : effort;
}

export interface SeatModel {
  observedModel?: string | null;
  observedEffort?: string | null;
  launchModel?: string | null;
  launchEffort?: string | null;
}

/** The human model cell: observed model@effort, else the stored launch choice. */
export function modelCell(seat: SeatModel, color: boolean): string {
  const { observedModel, observedEffort, launchModel, launchEffort } = seat;
  if (observedModel) {
    const model = prettyModelName(observedModel);
    const effort = observedEffort || (model !== observedModel ? EFFORT_SUFFIX.exec(observedModel)?.[1]?.toLowerCase() : undefined);
    return model + (effort ? `@${effortWord(effort, color)}` : "");
  }
  if (!launchModel && !launchEffort) return "?";
  // Some ids carry their effort, which the short name drops: `gemini-4-argon-high`.
  const effort = launchEffort || EFFORT_SUFFIX.exec(launchModel ?? "")?.[1]?.toLowerCase();
  return `${launchModel ? prettyModelName(launchModel) : "?"}@${effort ? effortWord(effort, color) : "?"}`;
}
