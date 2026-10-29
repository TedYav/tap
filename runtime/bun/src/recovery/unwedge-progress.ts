import { createHash } from "node:crypto";
import type { BoundTranscript } from "../readiness-stall";
import { claudeTurn, codexTurn } from "../readiness-stall";
import { parseStuckSentinel } from "../stuck-sentinel";
import type { UnwedgeAttempt, UnwedgeObservation, UnwedgePosition } from "./unwedge-policy";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function transcriptPosition(sample: BoundTranscript): UnwedgePosition {
  return { path: sample.path, offset: sample.size, fileId: sample.fileId, prefixHash: hash(sample.bytes.subarray(-4096)) };
}
const obj = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function inputText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.some(part => !["text", "input_text"].includes(obj(part).type as string) || typeof obj(part).text !== "string")) return null;
  return content.map(part => obj(part).text).join("\n");
}
function ownStimulus(prior: UnwedgeAttempt, text: string | null): boolean {
  if (text === null || !prior.stimulus) return false;
  if (createHash("sha256").update(text.trim()).digest("hex") === prior.stimulus.hash) return true;
  // The existing wire parser owns positional IDs; previews have no authority.
  if (!prior.stimulus.id || (text.match(/\[\[TAP\b/g) ?? []).length !== 1 || !text.trim().endsWith("]]")) return false;
  const parsed = parseStuckSentinel(text, prior.binding.harness);
  return parsed.ok && parsed.fields.id === prior.stimulus.id;
}

type Meaning = "neutral" | "own-input" | "started" | "stopped" | "aborted" | "productive" | "unknown";
const CLAUDE_BOOKKEEPING = new Set(["api-request-blob", "api-request-shape", "last-prompt", "custom-title", "ai-title", "agent-name",
  "mode", "permission-mode", "atis-latch", "pr-link", "file-history-snapshot", "cost-state", "tools-used"]);
const CLAUDE_CONTEXT = new Set(["hook_success", "total_tokens_reminder", "deferred_tools_record", "deferred_tools_delta", "batching_reminder_sent",
  "bash_output_audience_note", "output_style", "silent_turn_reminder", "environment", "prompt_snapshot", "skill_listing", "nested_memory", "date",
  "command_permissions", "model", "session_context", "credential_org", "instructions", "remote_session_change", "agent_listing_delta",
  "mcp_instructions_delta", "advisor_tool", "auto_mode", "compact_file_reference", "hook_system_message", "hook_additional_context", "invoked_skills"]);

/** Text tags are not provenance. Every content part must carry its native context origin. */
function codexContext(p: Record<string, unknown>): boolean {
  if (p.role !== "user" && p.role !== "developer") return false;
  const meta = obj(p.internal_chat_message_metadata_passthrough), kinds = meta.content_item_kinds, origins = meta.content_item_metadata;
  if (!Array.isArray(p.content) || !p.content.length || inputText(p.content) === null || !Array.isArray(kinds) || !Array.isArray(origins)
    || kinds.length !== p.content.length || origins.length !== p.content.length) return false;
  return kinds.every((kind, i) => {
    const source = obj(obj(origins[i]).provenance);
    if (p.role === "user") return (kind === "environments.environment_context" && source.type === "harness")
      || (kind === "agents_md.instructions" && source.type === "agents_md") || (kind === "skills.selected_skill_instructions" && source.type === "skills");
    return typeof kind === "string" && !!kind && !kind.startsWith("user.")
      && (["harness", "agents_md", "skills"].includes(source.type as string) || (source.type === "tool" && source.namespace === "collaboration"));
  });
}
function meaning(prior: UnwedgeAttempt, row: Record<string, unknown>, cause: string): Meaning {
  if (prior.binding.harness === "claude") {
    if ((row.sessionId !== undefined && row.sessionId !== prior.binding.nativeSessionId) || row.isSidechain === true) return "unknown";
    if (row.type === "user") {
      const origin = obj(row.origin).kind;
      if (origin === "task-notification" || origin === "auto-continuation") return "productive";
      if (row.isMeta === true || (origin !== undefined && origin !== "human")) return "unknown";
      return ownStimulus(prior, inputText(obj(row.message).content)) ? "own-input" : "productive";
    }
    if (row.type === "assistant") return row.isApiErrorMessage === true && cause === "api_error" && inputText(obj(row.message).content) !== null ? "stopped" : "productive";
    if (row.type === "progress") return "productive";
    // A request after the last stop may still be running; only a later terminal row closes it.
    if (row.type === "api-request") return "started";
    if (CLAUDE_BOOKKEEPING.has(row.type as string)) return "neutral";
    if (row.type === "attachment") {
      const type = obj(row.attachment).type;
      return type === "queued_command" ? "productive" : CLAUDE_CONTEXT.has(type as string) ? "neutral" : "unknown";
    }
    if (row.type === "system") return row.subtype === "scheduled_task_fire" ? "productive"
      : row.subtype === "turn_duration" || row.subtype === "stop_hook_summary" ? "neutral" : "unknown";
    return "unknown";
  }
  if (prior.binding.harness !== "codex") return "unknown";
  const p = obj(row.payload);
  if (row.type === "response_item") {
    if (p.type === "additional_tools" && p.role === "developer") return "neutral";
    if (p.type === "message") {
      if (codexContext(p)) return "neutral";
      if (p.role === "user") return ownStimulus(prior, inputText(p.content)) ? "own-input" : "productive";
    }
    return p.role === "assistant" || ["reasoning", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"].includes(p.type as string) ? "productive" : "unknown";
  }
  if (row.type === "event_msg") {
    if (p.type === "user_message") return ownStimulus(prior, typeof p.message === "string" ? p.message : null) ? "own-input" : "productive";
    if (p.type === "item_completed" || p.type === "item_started") {
      const item = obj(p.item);
      return item.type === "UserMessage" ? ownStimulus(prior, inputText(item.content)) ? "own-input" : "productive" : "productive";
    }
    if (p.type === "task_complete") return cause === "model_capacity" && obj(p.error).codex_error_info === "server_overloaded" && !p.last_agent_message ? "stopped" : "productive";
    if (p.type === "turn_aborted") return "aborted";
    if (p.type === "task_started") return "started";
    if (p.type === "agent_message" || p.type === "agent_reasoning") return "productive";
    return p.type === "token_count" || p.type === "thread_settings_applied" ? "neutral" : "unknown";
  }
  return ["world_state", "turn_context", "token_usage_record"].includes(row.type as string) ? "neutral" : "unknown";
}

/** Compare only the suffix after our recorded input boundary; unfamiliar meaning still refuses. */
export function unwedgeProgress(prior: UnwedgeAttempt, current: BoundTranscript | null, cause: string, ownInterrupt = false): UnwedgeObservation["progress"] {
  const position = prior.position;
  if (!current || !position || !prior.stimulus || position.path !== current.path || position.fileId !== current.fileId
    || !position.prefixHash || position.offset > current.size || position.offset < current.start) return "unknown";
  const prefixStart = Math.max(0, position.offset - 4096);
  if (prefixStart < current.start) return "unknown";
  if (hash(current.bytes.subarray(prefixStart - current.start, position.offset - current.start)) !== position.prefixHash) return "unknown";
  if (position.offset === current.size) return "unchanged";
  let suffix: string;
  try { suffix = new TextDecoder("utf-8", { fatal: true }).decode(current.bytes.subarray(position.offset - current.start)); }
  catch { return "unknown"; }
  if (!suffix.endsWith("\n")) return "unknown";
  const lines = suffix.split("\n").filter(line => line.trim());
  let stimulus = false, stopped = false, pending = false, meaningful = false, abortOnly = true;
  for (const line of lines) {
    let row: Record<string, unknown>;
    try { const parsed: unknown = JSON.parse(line); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "unknown"; row = obj(parsed); }
    catch { return "unknown"; }
    const kind = meaning(prior, row, cause);
    if (kind === "productive" || kind === "unknown") return kind;
    if (kind === "neutral") continue;
    meaningful = true;
    if (kind !== "aborted") abortOnly = false;
    if (kind === "own-input") stimulus = true;
    if (kind === "started" || kind === "own-input") { pending = true; stopped = false; }
    else { pending = false; stopped = true; }
  }
  if (!meaningful) return "unchanged";
  const turn = prior.binding.harness === "codex" ? codexTurn(lines) : claudeTurn(lines);
  if (cause !== prior.cause) return "productive";
  // Only while finishing this invocation's verified interrupt, never a later rung.
  if (ownInterrupt && abortOnly && turn?.ended) return "unchanged";
  return !pending && stimulus && stopped && turn?.ended ? "own-stimulus-stopped" : "unknown";
}
