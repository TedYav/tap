// The /tap:self allowlist: set/strengthen only. Pure text and harness checks, run
// before any pane effect. A false positive strands a legitimate text, because
// callers are told never to route around the gate, so phrase matching is
// word-bounded rather than substring ("only once" is not "only on",
// "gitignore" is not "ignore", "registry to" is not "try to").

export type SelfVerb = "compact" | "goal" | "loop";
export type Family = "claude" | "codex" | "opencode";
export type GateResult = { ok: true } | { ok: false; code: 1 | 6; message: string };

const reject = (message: string): GateResult => ({ ok: false, code: 1, message: `REJECTED — ${message}` });
const degraded = (message: string): GateResult => ({ ok: false, code: 6, message: `DEGRADED — ${message}` });
const chars = (text: string) => [...text].length;

export function matchPhrase(lowered: string, phrase: string): boolean {
  // Escape regex syntax only: unicode-mode patterns reject identity escapes such as \'.
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\/]/g, ch => `\\${ch}`);
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(lowered);
}

/** The typed command prefix; only the text and its marker are pasted (tap-lmbs). */
export function commandPrefix(verb: SelfVerb, interval = ""): string {
  if (verb === "loop") return interval ? `/loop ${interval} ` : "/loop ";
  return `/${verb} `;
}

const GOAL_CONTROL = ["clear", "reset", "remove", "delete", "unset", "stop", "off", "none", "cancel", "pause", "resume"];
const LOOP_CONTROL = ["cancel", "stop", "clear", "reset"];
const DEIXIS = ["this plan", "the above", "the current task", "the mentioned", "the above plan", "current plan", "this task",
  "the task above", "the plan above", "the mentioned plan", "the feature above", "as described above"];
const WEAKENING = ["if possible", "when convenient", "or similar", "approximately", "maybe", "try to", "attempt to",
  "it's ok to stop", "feel free to stop", "stop whenever", "stop if tired"];
const EVIDENCE = ["exit 0", "exit code", "artifact", "artifacts", "sealed", "green", "verified", "passed", "pr url",
  "pr is open", "terminal.json", "complete", "prove it", "evidence"];
const STOP = ["stop only", "stop condition", "stop on", "stop when", "stop if", "stop after", "halt on", "named stop", "done when"];
const PATHISH = ["docs/", "tmp/", "plans/", "scripts/", ".md", ".sh", ".ts", ".json"];
export const GOAL_CAP = 4000;
/** Compact focus cap in characters, excluding the typed prefix and marker
 * (tap-vho8h). The typed control travels as 250-byte keystroke chunks and is
 * proven back row by row; the focus supplements the summarizer, it is not the
 * handoff. Detail belongs in the handoff file the resume note names. */
export const COMPACT_FOCUS_CAP = 2000;

/**
 * Text checks for compact, goal and loop. `marker` is the ` [[sv:<id>]]` suffix
 * the submit appends: the goal cap counts the line the harness actually sees,
 * prefix + text + marker. The compact narrowing phrases are judged separately by
 * the shared lib.sh owner, so peer and self compaction answer the same way.
 */
export function checkText(verb: SelfVerb, text: string, interval: string, marker: string): GateResult {
  if (!text) return reject(`${verb} text is required (the composed argument is the point of /tap:self)`);
  if (interval && verb !== "loop") return reject("--interval only applies to the loop verb");
  if (interval && !/^[0-9]+[smhd]$/.test(interval)) return reject(`--interval must be <N><s|m|h|d> (e.g. 5m, 2h); got '${interval}'`);
  // One input line only: a newline could smuggle a second command into the pane.
  if ([...text].some(ch => ch.codePointAt(0)! < 32 || ch.codePointAt(0) === 127)) {
    return reject("text must be a single line with no control characters");
  }
  const goalWord = /^\/goal (clear|reset|remove|delete|unset|stop|off|none|cancel|pause|resume)/.exec(text);
  if (goalWord) return reject("goal clearing/pausing is not allowed (set/strengthen only)");
  if (/^\/loop (cancel|stop|clear|reset)/.test(text)) return reject("loop canceling is not allowed");
  const first = text.split(" ", 1)[0]!;
  if (first.startsWith("/") && !first.slice(1).includes("/")) {
    return reject(`slash-command injection is not allowed (text is an argument for /${verb}, not a command)`);
  }
  // A control word first becomes a control command once the verb is prepended:
  // "clear the backlog…" is parsed as "/goal clear".
  const firstLower = first.toLowerCase();
  if (verb === "goal" && GOAL_CONTROL.includes(firstLower)) {
    return reject(`goal text cannot start with control word '${firstLower}' (the harness would parse '/goal ${firstLower}' as clearing/pausing); reword the objective`);
  }
  if (verb === "loop" && LOOP_CONTROL.includes(firstLower)) {
    return reject(`loop prompt cannot start with control word '${firstLower}' (the harness would parse '/loop ${firstLower}' as canceling); reword the prompt`);
  }
  const lowered = text.toLowerCase();
  const deixis = () => {
    const hit = DEIXIS.find(phrase => matchPhrase(lowered, phrase));
    return hit ? reject(`${verb} text contains deixis '${hit}'; it must be self-contained (explicit paths, named objectives)`) : null;
  };
  if (verb === "loop") return deixis() ?? { ok: true };
  if (verb === "compact" && chars(text) > COMPACT_FOCUS_CAP) {
    return reject(`compact focus is ${chars(text)} chars; the cap is ${COMPACT_FOCUS_CAP}. Name the handoff path and a few anchors here and keep the detail in the handoff file`);
  }
  if (verb === "goal") {
    const prefix = commandPrefix("goal");
    if (chars(prefix) + chars(text) + chars(marker) > GOAL_CAP) {
      return reject(`goal text is ${chars(text)} chars; the evaluator cap is ${GOAL_CAP} including the ${chars(prefix)}-char '/goal ' prefix and the ${chars(marker)}-char verification marker (max ${GOAL_CAP - chars(prefix) - chars(marker)})`);
    }
    const weak = WEAKENING.find(phrase => matchPhrase(lowered, phrase));
    if (weak) return reject(`goal contains weakening language: '${weak}'`);
    const refused = deixis();
    if (refused) return refused;
    const hasPath = PATHISH.some(p => text.includes(p)) || /".*"/.test(text) || ["objective:", "goal:", "target:"].some(p => text.includes(p));
    if (!hasPath) return reject("goal must name an explicit plan path, artifact, or quoted objective (found no path-like reference)");
    if (!EVIDENCE.some(phrase => matchPhrase(lowered, phrase))) return reject("goal must state completion evidence (exit codes, artifact paths, predicate outputs)");
    if (!STOP.some(phrase => matchPhrase(lowered, phrase))) return reject("goal must name stop conditions or a turn/time bound (e.g. 'or stop after 20 turns')");
  }
  return { ok: true };
}

export function family(harness: string): Family | null {
  if (["claude", "Claude", "claude-code", "Claude Code"].includes(harness)) return "claude";
  if (harness.startsWith("codex")) return "codex";
  if (harness === "opencode") return "opencode";
  return null;
}

/** Which harness ships which verb. Keep in step with the SKILL.md table and `focusMode` (compact-focus.ts). */
export function checkHarness(verb: SelfVerb, harness: string): GateResult {
  const fam = family(harness);
  if (!fam) return degraded(`harness '${harness || "unknown"}' is not in the /${verb} allowlist`);
  if (fam === "codex" && verb === "loop") return degraded("Codex CLI has no /loop; use /goal goal-based persistence or an external scheduler");
  if (fam === "opencode" && verb !== "compact") return degraded(`opencode /${verb} needs a plugin that is not installed; use an in-conversation persistence mechanism`);
  return { ok: true };
}
