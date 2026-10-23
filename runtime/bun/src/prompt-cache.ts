/** Transcript estimates, not observations of server-side cache availability. */
export interface PromptCache {
  state: "warm" | "cold" | "none" | "unknown";
  ttl_seconds: number | null;
  last_activity_at: string | null;
  expires_at: string | null;
  remaining_seconds: number | null;
  source: "claude_transcript";
  basis: "assistant_timestamp";
  unknown_reason: string | null;
}

const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

export function isClaudeCompactAttachment(event: Record<string, any>): boolean {
  return event.type === "attachment" &&
    (event.attachment?.hookName === "SessionStart:compact" || event.attachment?.hookEvent === "SessionStart:compact");
}

/** A fleet read may finish after a child's estimated deadline has elapsed. */
export function refreshPromptCache(cache: PromptCache, now: number): PromptCache {
  if (cache.state !== "warm" && cache.state !== "cold" || !cache.expires_at) return cache;
  const expires = Date.parse(cache.expires_at) / 1000;
  if (!Number.isFinite(expires)) return cache;
  return {...cache,state:expires > now ? "warm" : "cold",remaining_seconds:Math.max(0,Math.floor(expires-now))};
}

/** Events are newest first, from the same bounded read as context usage. */
export function claudePromptCache(events: Record<string, any>[], session: string, now = Date.now() / 1000): PromptCache | null {
  let touch: string | null = null, model: string | undefined;
  let sawUsage = false;
  const result = (state: PromptCache["state"], reason: string | null = null, ttl: number | null = null): PromptCache => {
    const expires = touch && ttl !== null ? Date.parse(touch) / 1000 + ttl : null;
    const remaining = expires === null ? null : Math.max(0, Math.floor(expires - now));
    return {state: expires === null ? state : expires > now ? "warm" : "cold", ttl_seconds:ttl,
      last_activity_at:touch, expires_at:expires === null ? null : new Date(expires * 1000).toISOString(),
      remaining_seconds:remaining, source:"claude_transcript", basis:"assistant_timestamp", unknown_reason:reason};
  };
  for (const event of events) {
    if (event.sessionId !== session || event.isSidechain === true) continue;
    if (event.type === "compacted" || event.type === "system" && event.subtype === "compact_boundary" || isClaudeCompactAttachment(event)) {
      return touch ? result("unknown", "ttl_not_in_tail") : null;
    }
    if (event.type !== "assistant" || event.message?.model === "<synthetic>") continue;
    const usage = event.message?.usage;
    if (!usage || typeof usage !== "object" || !Object.keys(usage).length) continue;
    if (model !== undefined && event.message?.model !== model) break;
    const read = usage.cache_read_input_tokens, write = usage.cache_creation_input_tokens;
    if (!count(read) || !count(write)) return result("unknown", "invalid_cache_usage");
    sawUsage = true;
    model ??= event.message?.model;
    if (read === 0 && write === 0) continue;
    if (!touch) {
      if (typeof event.timestamp !== "string" || !Number.isFinite(Date.parse(event.timestamp)) || Date.parse(event.timestamp) / 1000 > now)
        return result("unknown", "invalid_cache_timestamp");
      touch = event.timestamp;
      model = event.message?.model;
    }
    if (write > 0) {
      const buckets = usage.cache_creation;
      const hour = buckets?.ephemeral_1h_input_tokens, five = buckets?.ephemeral_5m_input_tokens;
      if (!count(hour) || !count(five) || hour + five !== write) return result("unknown", "ttl_not_reported");
      return result("unknown", null, five > 0 ? 300 : 3600);
    }
  }
  return touch ? result("unknown", "ttl_not_in_tail") : sawUsage ? result("none") : null;
}

/** Human marker only; the JSON estimate retains its TTL, source and basis. */
export function formatPromptCache(cache?: PromptCache | null, colored = false, now = Date.now() / 1000): string {
  if (!cache || cache.ttl_seconds === null || !cache.expires_at || cache.state === "none" || cache.state === "unknown") return "";
  const remaining = Date.parse(cache.expires_at) / 1000 - now;
  if (!Number.isFinite(remaining)) return "";
  if (cache.state === "cold" || remaining <= 0) return colored ? "\x1b[38;5;88m●\x1b[0m" : "●";
  if (cache.remaining_seconds === null || !Number.isFinite(cache.remaining_seconds)) return "";
  const minutes = Math.max(1, Math.ceil(remaining / 60));
  const marker = `●${minutes}m`, color = minutes < 5 ? 31 : minutes < 15 ? 33 : 94;
  return colored ? `\x1b[${color}m${marker}\x1b[0m` : marker;
}
