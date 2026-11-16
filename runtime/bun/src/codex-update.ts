import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { agentAtRest, detectAgentState } from "./agent-state";
import { composerInput } from "./submit-frame";

export interface CodexUpdatePrompt { current: string; available: string }

/** Metadata from a positively recognized menu, never a second state classifier. */
export function codexUpdatePrompt(frame: string): CodexUpdatePrompt | null {
  if (detectAgentState("codex", frame).reason !== "codex-update-available") return null;
  const plain = frame.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const version = "([0-9][0-9A-Za-z.+-]{0,63})";
  const found = plain.match(new RegExp(`Update\\s+available\\s*·\\s*${version}\\s*(?:→|->)\\s*${version}`));
  return found ? { current: found[1]!, available: found[2]! } : null;
}

/** Placeholder words without their dim paint are text, not an empty composer. */
export function codexUpdateDismissed(frame: string | null, title: string | null): boolean {
  if (frame === null || title === null || !agentAtRest(detectAgentState("codex", frame, title).agentState)) return false;
  const input = composerInput(frame, "codex");
  return input.state === "text" && input.text === "";
}

export function codexUpdateSkipReceipt(prompt: CodexUpdatePrompt): string {
  return `dismissed Codex update prompt (${prompt.current} -> ${prompt.available} available)`;
}

const dotted = (version: unknown): number[] | null =>
  typeof version === "string" && /^\d+(?:\.\d+){1,3}$/.test(version) ? version.split(".").map(Number) : null;

/**
 * The Codex home the launched process reads: its composed environment over the launcher's own, with the
 * launch's unsets applied, as the child sees it. A policy-set home lives only in the invocation, and an
 * unset inherited home falls back to Codex's default under the child's HOME.
 */
export function launchedCodexHome(invocation: { env: Record<string, string>; unset_env?: string[] }, env: NodeJS.ProcessEnv): string {
  const child: Record<string, string | undefined> = { ...env, ...invocation.env };
  for (const key of invocation.unset_env ?? []) delete child[key];
  return child.CODEX_HOME || join(child.HOME || homedir(), ".codex");
}

/**
 * One launch line naming a newer Codex, whether or not the seat's startup check is on. The running version is read
 * from the banner Codex painted and the newest release from Codex's own cache, `version.json` in its home.
 * Codex writes that cache only when it checks for itself, so this repeats what Codex last learned and is
 * silent when either side is unreadable, when the release is not newer, or when the user told Codex to
 * skip that release.
 */
export function codexUpdateNotice(screen: string | null, codexHome: string): string | null {
  const running = screen?.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").match(/OpenAI Codex\s*\(v(\d+(?:\.\d+){1,3})\)/)?.[1];
  let cache: { latest_version?: unknown; dismissed_version?: unknown };
  try { cache = JSON.parse(readFileSync(join(codexHome, "version.json"), "utf8")); } catch { return null; }
  const latest = dotted(cache?.latest_version), current = dotted(running);
  if (!latest || !current || cache.latest_version === cache.dismissed_version) return null;
  for (let i = 0; i < Math.max(latest.length, current.length); i++) {
    const delta = (latest[i] ?? 0) - (current[i] ?? 0);
    if (delta < 0) return null;
    if (delta > 0) return `Codex ${cache.latest_version} is available (this seat runs ${running}); update Codex when convenient`;
  }
  return null;
}
