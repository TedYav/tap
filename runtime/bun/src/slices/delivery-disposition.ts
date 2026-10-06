import { opencodeShellMode } from "../opencode-composer";
import { claudeFeedbackOverlay } from "../pane-state";
import { hasInputText } from "../terminal-text";
/** One policy for immediate delivery, draft warning, and queued-input holds. */
export type DeliveryBand = "shell-mode" | "feedback-draft" | "bare" | "draft" | "queued" | "staged" | "busy" | "unobservable";
export interface DeliveryFacts {
  band: DeliveryBand;
  harness?: string;
  urgent: boolean;
  noSpool: boolean;
  recipientBound: boolean;
}
export interface DeliveryDisposition {
  action: "inject" | "park";
  parkReason: "shell-mode" | "feedback-draft" | "pending-input" | "queued-input" | "no-input-prompt" | "booting" | null;
  graceSeconds: number | null;
  cue: { initialStyle: "green" | "red" | null; redAtSecondsBeforeDeadline: number | null };
}
export function deliveryDisposition(input: DeliveryFacts): DeliveryDisposition {
  const result: DeliveryDisposition = {
    action: "inject", parkReason: null, graceSeconds: null,
    cue: { initialStyle: null, redAtSecondsBeforeDeadline: null },
  };
  if (input.band === "shell-mode") return { ...result, action: "park", parkReason: "shell-mode", graceSeconds: 0 };
  if (input.band === "feedback-draft") return { ...result, action: "park", parkReason: "feedback-draft", graceSeconds: 0 };
  if (!input.recipientBound || input.noSpool) return result;
  // Interrupt keeps its direct path with a missing composer. Only a
  // positively observed human draft earns a red cue.
  if (input.urgent) return input.band === "draft" ? { ...result, action: "park", parkReason: "pending-input", graceSeconds: 10,
    cue: { initialStyle: "red", redAtSecondsBeforeDeadline: 10 } } : result;
  // Hermes supplies its own safe /queue prefix without requiring a visible band.
  if (input.harness?.startsWith("hermes") && input.band === "unobservable") return result;
  // Ready arrivals may overtake parked mail; the drain retains its own order.
  if (input.band === "bare") return result;
  if (input.band === "draft") return {
    ...result, action: "park", parkReason: "pending-input", graceSeconds: 30,
    cue: { initialStyle: "green", redAtSecondsBeforeDeadline: 10 },
  };
  if (input.band === "staged") return { ...result, action: "park", parkReason: "no-input-prompt", graceSeconds: 0 };
  if (input.band === "queued") return { ...result, action: "park", parkReason: "queued-input" };
  return { ...result, action: "park", parkReason: input.harness?.startsWith("opencode") ? "booting" : "no-input-prompt" };
}

/** A footer advertises an action; only actual queued rows establish a queue. */
export function codexQueuedRows(frame: string): string[] {
  const lines = frame.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split("\n");
  let prompt = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^\s*[›❯»]/.test(lines[i]!)) { prompt = i; break; }
  if (prompt < 0 || !lines.slice(prompt + 1).some(line => /^\s*shift\s*\+\s*←\s+edit last queued message\s*$/.test(line))) return [];
  const queued: string[] = [];
  for (let i = prompt - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.trim() || /^\s*─{10,}\s*$/.test(line)) continue;
    const row = /^\s*↳\s+(.+)$/.exec(line);
    if (!row) break;
    queued.unshift(row[1]!);
  }
  return queued;
}

export function deliveryBand(composer: string | null, harness: string, frame: string): DeliveryBand {
  if (harness.startsWith("opencode") && opencodeShellMode(frame)) return "shell-mode";
  if (harness.startsWith("claude") && claudeFeedbackOverlay(frame)) return "feedback-draft";
  if (composer === null) return "unobservable";
  if (hasInputText(composer)) return composer.trim().startsWith("[[TAP") ? "staged" : "draft";
  return /^codex/.test(harness) && codexQueuedRows(frame).length ? "queued" : "bare";
}
