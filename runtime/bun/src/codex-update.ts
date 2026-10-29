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
