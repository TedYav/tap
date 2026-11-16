// Shared harness recognition for delivery and command callers.
export const AGENT_FAMILIES = new Set(["claude", "codex", "opencode", "cursor", "hermes", "agy"]);
/**
 * Product and binary spellings of a supported harness. Screen classification
 * resolves them; the launcher only names the canonical word in its refusal.
 * Kept in this import-free module so naming a harness never loads the screen
 * classifier.
 */
export const HARNESS_ALIASES: Readonly<Record<string, "claude" | "codex" | "cursor" | "opencode" | "agy" | "hermes">> = {
  "claude-code": "claude",
  "cursor-agent": "cursor",
  "open-code": "opencode",
  antigravity: "agy",
  "antigravity-cli": "agy",
  "hermes-agent": "hermes",
};
/** Families whose CLI forks a stored conversation (`tap session fork`); the rest fork only in-session. */
export const FORKABLE_HARNESSES: readonly string[] = ["claude", "codex"];
/** Flags that select a conversation: inherited from the source, they would fight the fork's own. */
const FORK_OWNED: Record<string, string[]> = {
  claude: ["--session-id", "--resume", "-r", "--continue", "-c", "--fork-session"],
};
/** The fork-owned option a recipe carries, as its bare name: a stored value (an id, or
 *  arbitrary bytes) never reaches a message. */
export function forkConflictingFlag(harness: string, tokens: string[]): string | null {
  const owned = FORK_OWNED[harness] ?? [];
  return owned.find(flag => tokens.some(token => token.split("=", 1)[0] === flag)) ?? null;
}
const recipeTokens = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
/** A fork source as the collision menu offered it: the row's identity fields and its resolved
 *  conversation. `tap session fork` refuses fork_source_changed when its own differs. */
export function forkSourceFingerprint(row: Record<string, unknown>, conversation: string): string {
  return JSON.stringify(["harness", "harness_session_id", "session", "instance"].map(key => row[key] ?? null).concat(conversation));
}
/** The fork-owned flag a seat row stores in its passthrough or harness tail, which refuses `tap session fork`. */
export function storedForkConflict(harness: string, row: Record<string, unknown>): string | null {
  return forkConflictingFlag(harness, [...recipeTokens(row.passthrough), ...recipeTokens(row.harness_tail)]);
}
// How each supported family receives session-start context (identity block +
// TAP advisory; tap-sh9g). A value is either the adapter artifact that injects
// it (must exist) or a `limit:` disposition naming why the family has none.
// session-context-harness-enum.test.ts fails when a family joins AGENT_FAMILIES
// without a row, when an adapter artifact is missing, or when a row is junk —
// the gap cannot reopen silently by addition.
export const SESSION_CONTEXT: Record<string, string> = {
  claude: "hooks/tap-advisory.sh",
  codex: "hooks/tap-codex-session-start.sh",
  cursor: "hooks/tap-cursor-session-start.sh",
  opencode: "hooks/tap-opencode-session-start.ts",
  hermes: "limit: no native session-start surface; launch briefing + repo context files carry protocol",
  agy: "limit: native invocation hooks capture identity; launch briefing + repo context files carry protocol",
};
export const DENYLIST = new Set([
  "bash", "zsh", "sh", "fish", "dash", "ksh", "tcsh", "less", "more", "man",
  "vi", "vim", "view", "nvim", "nano", "emacs", "ssh", "cat", "pager", "git",
]);
