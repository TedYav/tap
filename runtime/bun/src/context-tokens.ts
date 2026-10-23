/** Last reported request input, never cumulative usage or inferred model capacity. */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { claudePromptCache, isClaudeCompactAttachment, type PromptCache } from "./prompt-cache";

export interface ObservedTuning {
  model: string;
  effort: string | null;
  observed_at: string;
  source: "claude_transcript" | "codex_transcript";
}
export interface TokenSample {
  input_tokens: number | null;
  observed_at: string | null;
  source: "codex_transcript" | "claude_transcript" | "opencode_store" | null;
  window_tokens: number | null;
  window_source: "codex_reported_window" | "claude_process_env" | "default_1m" | "opencode_model" | null;
  used_percent: number | null;
  percent_source: "footer" | "codex_reported_window" | "claude_process_env" | "default_1m" | "opencode_model" | null;
  unknown_reason: string | null;
  tuning: ObservedTuning | null;
  prompt_cache?: PromptCache | null;
}
const unknown = (reason: string): TokenSample => ({ input_tokens: null, observed_at: null, source: null,
  window_tokens: null, window_source: null, used_percent: null, percent_source: null, unknown_reason: reason, tuning: null });
const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const timestamp = (n: unknown): string | null => typeof n === "string" && Number.isFinite(Date.parse(n)) ? n : null;
const obj = (n: unknown): Record<string, any> => n !== null && typeof n === "object" && !Array.isArray(n) ? n as Record<string, any> : {};
const lines = (text: string): Record<string, any>[] => text.split("\n").flatMap(line => {
  try { return [obj(JSON.parse(line))]; } catch { return []; }
});
const TAIL_BYTES = 2 * 1024 * 1024;

export function readContextTokens(harness: string, sessionId: string, path: string): TokenSample {
  if (!/^(codex|claude)(?:-|$)/.test(harness)) return unknown("unsupported_harness");
  if (!sessionId || !isAbsolute(path)) return unknown("unbound_transcript");
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return unknown("unreadable_transcript");
    const read = (start: number, size: number) => {
      const bytes = Buffer.alloc(size);
      return bytes.subarray(0, readSync(fd!, bytes, 0, size, start)).toString("utf8");
    };
    const codex = harness.startsWith("codex");
    if (codex) {
      const meta = lines(read(0, Math.min(stat.size, 65536))).find(e => e.type === "session_meta");
      if (typeof meta?.payload?.id !== "string" || !meta.payload.id) return unknown("session_unverified");
      if (meta?.payload?.id !== sessionId) return unknown("session_mismatch");
    }
    const start = Math.max(0, stat.size - TAIL_BYTES);
    let tail = read(start, Math.min(stat.size, TAIL_BYTES));
    if (start) tail = tail.slice(tail.indexOf("\n") + 1);
    // Ignore an incomplete final JSONL record while the harness is appending.
    tail = tail.slice(0, tail.lastIndexOf("\n") + 1);
    // Two independent verdicts over one reverse pass: usage settles at the
    // FIRST of a valid record, a compact boundary or invalid usage and is
    // never revisited; tuning takes the newest qualifying record regardless,
    // because a setting outlives compaction and a Codex turn_context sits
    // before its token_count. The usage half stays byte-identical to the
    // single-verdict scan it replaces.
    let settled: TokenSample | null = null;
    let tuning: ObservedTuning | null = null;
    const events = lines(tail).reverse();
    const prompt_cache = codex ? null : claudePromptCache(events, sessionId);
    for (const event of events) {
      if (!codex && (event.sessionId !== sessionId || event.isSidechain === true)) continue;
      if (!settled) {
        if (event.type === "compacted" || (!codex && isClaudeCompactAttachment(event)) || (event.type === "system" && event.subtype === "compact_boundary") ||
            (event.type === "event_msg" && event.payload?.type === "context_compacted")) {
          settled = unknown("awaiting_usage_after_compact");
        } else {
          let count: unknown, window: unknown = null, tokenEvent = false;
          if (codex) {
            // After compaction Codex writes a token_count whose last usage is all
            // zeros: no request was measured, so the scan reaches the boundary.
            const last = obj(obj(event.payload?.info).last_token_usage);
            const placeholder = last.input_tokens === 0 && Object.entries(last).every(([key, n]) => key === "total_tokens" || n === 0);
            if (event.type === "event_msg" && event.payload?.type === "token_count" && !placeholder) {
              tokenEvent = true;
              const info = obj(event.payload.info);
              count = obj(info.last_token_usage).input_tokens;
              window = info.model_context_window;
            }
          } else if (event.type === "assistant" && event.message?.model !== "<synthetic>") {
            // Synthetic records (API errors, "No response requested.") carry
            // all-zero usage for a request that never ran; they measure nothing.
            const usage = obj(event.message?.usage);
            if (Object.keys(usage).length) {
              tokenEvent = true;
              const parts = [usage.input_tokens, usage.cache_creation_input_tokens ?? 0, usage.cache_read_input_tokens ?? 0];
              count = parts.every(integer) ? parts.reduce((sum, n) => sum + n, 0) : null;
            }
          }
          if (tokenEvent) {
            const at = timestamp(event.timestamp);
            if (!integer(count) || !at) settled = unknown("invalid_usage");
            else {
              const defaultWindow = codex && window == null;
              const size = defaultWindow ? 1_000_000 : integer(window) && window > 0 ? window : null;
              const windowSource = defaultWindow ? "default_1m" : size === null ? null : "codex_reported_window";
              settled = {input_tokens: count, observed_at: at, source: codex ? "codex_transcript" : "claude_transcript",
                window_tokens: size, window_source: windowSource,
                percent_source: windowSource,
                used_percent: size === null ? null : Math.round(count / size * 100), unknown_reason: null, tuning: null};
            }
          }
        }
      }
      if (!tuning) {
        if (codex) {
          if (event.type === "turn_context") {
            const model = event.payload?.model, effort = event.payload?.effort, at = timestamp(event.timestamp);
            if (typeof model === "string" && model && at)
              tuning = {model, effort: typeof effort === "string" && effort ? effort : null, observed_at: at, source: "codex_transcript"};
          }
        } else if (event.type === "assistant") {
          const model = event.message?.model, effort = event.effort, at = timestamp(event.timestamp);
          if (typeof model === "string" && model && model !== "<synthetic>" && at)
            tuning = {model, effort: typeof effort === "string" && effort ? effort : null, observed_at: at, source: "claude_transcript"};
        }
      }
      if (settled && tuning) break;
    }
    return {...settled ?? unknown("usage_not_in_tail"), tuning, prompt_cache};
  } catch { return unknown("unreadable_transcript"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function withClaudeWindow(sample: TokenSample, value: string | null): TokenSample {
  if (value === null) return {...sample, window_tokens: 1_000_000, window_source: "default_1m",
    percent_source: "default_1m", used_percent: sample.input_tokens === null ? null : Math.round(sample.input_tokens / 1_000_000 * 100)};
  // Noncanonical spellings and values outside the documented range remain unknown.
  if (sample.input_tokens === null || !value || !/^\d+$/.test(value)) return sample;
  const window = Number(value);
  if (!Number.isSafeInteger(window) || window < 100000 || window > 1000000) return sample;
  return {...sample, window_tokens: window, window_source: "claude_process_env", percent_source: "claude_process_env",
    used_percent: Math.round(sample.input_tokens / window * 100)};
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(2))}M`;
  return tokens < 1000 ? String(tokens) : `${Math.round(tokens / 1000)}k`;
}

export function formatContextTokens(sample?: TokenSample): string {
  const count = sample?.input_tokens == null ? "?" : formatTokens(sample.input_tokens);
  return sample?.window_tokens == null ? count : `${count}/${formatTokens(sample.window_tokens)}`;
}
