import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readContextTokens, withClaudeWindow, formatContextTokens } from "../src/context-tokens";
import { removeScratchTree } from "./support/scratch";
import { claudePromptCache, formatPromptCache } from "../src/prompt-cache";
const root = mkdtempSync(join(tmpdir(), "context-tokens-"));
afterAll(() => removeScratchTree(root));
const at = "2026-09-19T09:00:00Z";
const codex = (input = 303506) => ({type:"event_msg",timestamp:at,payload:{type:"token_count",info:{model_context_window:380000,last_token_usage:{input_tokens:input,cached_input_tokens:300000},total_token_usage:{input_tokens:9999999}}}});
const claude = (input = 90) => ({type:"assistant",sessionId:"seat",timestamp:at,message:{usage:{input_tokens:input,cache_creation_input_tokens:1218,cache_read_input_tokens:338738,output_tokens:999}}});
const claudeTuned = (model: string, effort?: string, input = 90) => ({type:"assistant",sessionId:"seat",timestamp:at,
  ...(effort === undefined ? {} : {effort}), message:{model,usage:{input_tokens:input,cache_creation_input_tokens:1218,cache_read_input_tokens:338738,output_tokens:999}}});
const turnContext = (model = "gpt-6-astra", effort?: string) => ({type:"turn_context",timestamp:at,
  payload:{model,...(effort === undefined ? {} : {effort})}});
function sample(harness: string, events: unknown[], session = "seat") {
  const path = join(root,`${harness}.jsonl`);
  writeFileSync(path, events.map(e => JSON.stringify(e)).join("\n")+"\n");
  return readContextTokens(harness, session, path);
}
test("Codex uses last input, includes cache once, and binds header identity", () => {
  const events = [{type:"session_meta",payload:{id:"seat"}},codex()];
  expect(sample("codex",events)).toMatchObject({input_tokens:303506,window_tokens:380000,used_percent:80,observed_at:at});
  expect(sample("codex",events,"other").unknown_reason).toBe("session_mismatch");
  expect(sample("codex",[...events,{type:"compacted"}]).input_tokens).toBeNull();
  expect(sample("codex",[...events,{type:"compacted"},codex(50000)]).input_tokens).toBe(50000);
});
test("Claude adds input cache buckets once and permits exceeding the compaction window", () => {
  const result = sample("claude",[claude(),claude(),{...claude(999),sessionId:"other"},{...claude(999),isSidechain:true}]);
  expect(result.input_tokens).toBe(340046);
  expect(result.window_tokens).toBeNull();
  expect(formatContextTokens(result)).toBe("340k");
  expect(formatContextTokens(withClaudeWindow(result,null))).toBe("340k/1M");
  expect(formatContextTokens(withClaudeWindow(result,"300000"))).toBe("340k/300k");
  for (const value of ["350k","NaN","0","99999999"]) expect(withClaudeWindow(result,value).window_tokens).toBeNull();
  expect(sample("claude",[claude(),{type:"system",subtype:"compact_boundary",sessionId:"seat"}]).input_tokens).toBeNull();
});
test("missing, invalid, unsupported and absent telemetry stays unknown", () => {
  expect(readContextTokens("codex","seat","relative").input_tokens).toBeNull();
  expect(sample("cursor",[claude()]).input_tokens).toBeNull();
  expect(sample("claude",[claude(-1)]).unknown_reason).toBe("invalid_usage");
  expect(sample("claude",[claude()],"other").input_tokens).toBeNull();
  expect(formatContextTokens()).toBe("?");
});

test("an unsampled Codex transcript cannot establish a mismatched session", () => {
  for (const events of [[], [codex()], [{type: "session_meta", payload: {}}], [{type: "session_meta", payload: {id: ""}}]]) {
    expect(sample("codex", events)).toMatchObject({ input_tokens: null, unknown_reason: "session_unverified" });
  }
  expect(sample("codex", [{type: "session_meta", payload: {id: "seat"}}])).toMatchObject({
    input_tokens: null, unknown_reason: "usage_not_in_tail",
  });
});

test("Codex defaults an unspecified cap to 1M but does not replace a reported or invalid cap", () => {
  const event = codex(145000);
  const header = {type:"session_meta",payload:{id:"seat"}};
  expect(formatContextTokens(sample("codex",[header,event]))).toBe("145k/380k");
  delete (event.payload.info as {model_context_window?:number}).model_context_window;
  expect(sample("codex",[header,event])).toMatchObject({window_tokens:1000000,window_source:"default_1m"});
  expect(formatContextTokens(sample("codex",[header,event]))).toBe("145k/1M");
  event.payload.info.model_context_window = 0;
  expect(sample("codex",[header,event]).window_tokens).toBeNull();
});

test("Claude tuning: the newest qualifying assistant record wins and synthetic records are skipped", () => {
  expect(sample("claude",[claudeTuned("claude-fable-5-1","high"),claudeTuned("claude-fable-5-1","xhigh")]).tuning)
    .toEqual({model:"claude-fable-5-1",effort:"xhigh",observed_at:at,source:"claude_transcript"});
  expect(sample("claude",[claudeTuned("claude-fable-5-1","high"),{type:"assistant",sessionId:"seat",timestamp:at,message:{model:"<synthetic>"}}]).tuning)
    .toEqual({model:"claude-fable-5-1",effort:"high",observed_at:at,source:"claude_transcript"});
  expect(sample("claude",[claudeTuned("claude-haiku-4")]).tuning)
    .toEqual({model:"claude-haiku-4",effort:null,observed_at:at,source:"claude_transcript"});
  expect(sample("claude",[claude()]).tuning).toBeNull();
});

test("Codex tuning: the newest turn_context wins and sits before its token_count", () => {
  const header = {type:"session_meta",payload:{id:"seat"}};
  const result = sample("codex",[header,turnContext("gpt-6-astra","high"),turnContext("gpt-6-astra","ultra"),codex()]);
  expect(result.tuning).toEqual({model:"gpt-6-astra",effort:"ultra",observed_at:at,source:"codex_transcript"});
  expect(result.input_tokens).toBe(303506);
  expect(sample("codex",[header,turnContext("gpt-6-astra"),codex()]).tuning)
    .toEqual({model:"gpt-6-astra",effort:null,observed_at:at,source:"codex_transcript"});
});

test("a compact boundary suppresses usage but not tuning", () => {
  const result = sample("claude",[claudeTuned("claude-fable-5-1","xhigh"),{type:"compacted",sessionId:"seat"}]);
  expect(result).toMatchObject({input_tokens:null,unknown_reason:"awaiting_usage_after_compact"});
  expect(result.tuning).toEqual({model:"claude-fable-5-1",effort:"xhigh",observed_at:at,source:"claude_transcript"});
});

// A record that measured no request never reads as an empty context (tap-83tfx).
const synthetic = (text = "API Error: Internal server error") => ({type:"assistant",sessionId:"seat",timestamp:"2026-09-19T09:05:00Z",
  message:{model:"<synthetic>",content:[{type:"text",text}],usage:{input_tokens:0,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:0}}});
const codexPlaceholder = () => ({type:"event_msg",timestamp:"2026-09-19T09:05:00Z",payload:{type:"token_count",info:{model_context_window:380000,
  last_token_usage:{input_tokens:0,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:0,reasoning_output_tokens:0,total_tokens:23652},
  total_token_usage:{input_tokens:9999999}}}});
test("a synthetic Claude record keeps the prior real count rather than reporting zero", () => {
  expect(sample("claude",[claude(),synthetic(),synthetic("No response requested.")])).toMatchObject({input_tokens:340046,observed_at:at,unknown_reason:null});
  expect(sample("claude",[synthetic()])).toMatchObject({input_tokens:null,unknown_reason:"usage_not_in_tail"});
  expect(sample("claude",[claude(),{type:"system",subtype:"compact_boundary",sessionId:"seat"},synthetic()]))
    .toMatchObject({input_tokens:null,unknown_reason:"awaiting_usage_after_compact"});
  expect(formatContextTokens(withClaudeWindow(sample("claude",[claude(),synthetic()]),null))).toBe("340k/1M");
});
test("Codex's zeroed post-compaction token_count awaits real usage rather than reporting zero", () => {
  const header = {type:"session_meta",payload:{id:"seat"}};
  const compacted = [header,codex(),{type:"compacted"},turnContext(),codexPlaceholder(),{type:"event_msg",payload:{type:"item_completed"}}];
  expect(sample("codex",compacted)).toMatchObject({input_tokens:null,unknown_reason:"awaiting_usage_after_compact"});
  expect(sample("codex",[...compacted,codex(1200)])).toMatchObject({input_tokens:1200,unknown_reason:null});
  // Only an explicit zero input is a placeholder; usage missing its input stays refused.
  const malformed = {...codexPlaceholder(),payload:{type:"token_count",info:{last_token_usage:{output_tokens:0}}}};
  expect(sample("codex",[header,codex(),malformed])).toMatchObject({input_tokens:null,unknown_reason:"invalid_usage"});
  const answered = {...codexPlaceholder(),payload:{type:"token_count",info:{last_token_usage:{input_tokens:0,output_tokens:10}}}};
  expect(sample("codex",[header,codex(),answered])).toMatchObject({input_tokens:0,unknown_reason:null});
});
test("a genuine small count stays measured", () => {
  const header = {type:"session_meta",payload:{id:"seat"}};
  expect(sample("codex",[header,codex(1200)])).toMatchObject({input_tokens:1200,used_percent:0,unknown_reason:null});
  const small = {type:"assistant",sessionId:"seat",timestamp:at,message:{model:"claude-x",usage:{input_tokens:3,output_tokens:1}}};
  expect(sample("claude",[small])).toMatchObject({input_tokens:3,unknown_reason:null});
});

test("Claude cache TTL follows the latest write, read-only hits refresh it, and compaction drops it", () => {
  const cached = (timestamp: string, oneHour: number, fiveMinutes: number, read = 0) => ({
    ...claude(),timestamp,message:{model:"claude-opus",usage:{input_tokens:10,
      cache_creation_input_tokens:oneHour+fiveMinutes,cache_read_input_tokens:read,
      cache_creation:{ephemeral_1h_input_tokens:oneHour,ephemeral_5m_input_tokens:fiveMinutes}}},
  });
  const events = [cached("2026-10-22T08:00:00Z",100,0),cached("2026-10-22T08:01:00Z",0,100),cached("2026-10-22T08:02:00Z",0,0,100)];
  expect(sample("claude",events).prompt_cache).toMatchObject({ttl_seconds:300,last_activity_at:"2026-10-22T08:02:00Z",expires_at:"2026-10-22T08:07:00.000Z",basis:"assistant_timestamp"});
  expect(sample("claude",[events[2]]).prompt_cache).toMatchObject({state:"unknown",unknown_reason:"ttl_not_in_tail"});
  expect(sample("claude",[...events,{type:"system",subtype:"compact_boundary",sessionId:"seat"}]).prompt_cache).toBeNull();
  expect(sample("claude",[cached("2026-10-22T08:00:00Z",100,100)]).prompt_cache?.ttl_seconds).toBe(300);
  expect(sample("codex",[{type:"session_meta",payload:{id:"seat"}},codex()]).prompt_cache).toBeNull();
});

test("cache evidence excludes synthetic, sidechain and other sessions and distinguishes none from unknown", () => {
  const write = {...claude(),message:{model:"claude-opus",id:"m1",usage:{input_tokens:1,cache_creation_input_tokens:100,
    cache_read_input_tokens:0,cache_creation:{ephemeral_1h_input_tokens:100,ephemeral_5m_input_tokens:0}}}};
  const five = {...write,timestamp:"2026-09-19T09:01:00Z",message:{...write.message,usage:{...write.message.usage,cache_creation:{ephemeral_1h_input_tokens:0,ephemeral_5m_input_tokens:100}}}};
  const result = sample("claude",[write,synthetic(),{...five,isSidechain:true},{...five,sessionId:"other"}]);
  expect(result.prompt_cache).toMatchObject({ttl_seconds:3600,last_activity_at:at});
  expect(sample("claude",[{...claude(),message:{usage:{input_tokens:1,cache_creation_input_tokens:0,cache_read_input_tokens:0}}}]).prompt_cache?.state).toBe("none");
  expect(sample("claude",[{...write,message:{...write.message,usage:{...write.message.usage,cache_creation:undefined}}}]).prompt_cache?.state).toBe("unknown");
  expect(sample("claude",[write,{...five,message:{...five.message,model:"different",usage:{input_tokens:1,cache_creation_input_tokens:0,cache_read_input_tokens:100}}}]).prompt_cache?.state).toBe("unknown");
});

test("cache display separates clock-expired, absent and unknown states", () => {
  const event = {...claude(),message:{model:"claude-opus",usage:{cache_read_input_tokens:100,cache_creation_input_tokens:100,
    cache_creation:{ephemeral_1h_input_tokens:100,ephemeral_5m_input_tokens:0}}}};
  const start = Date.parse(at)/1000;
  const warm = claudePromptCache([event],"seat",start+60);
  expect(warm?.state).toBe("warm");
  expect(formatPromptCache(warm,false,start+60)).toBe("●59m");
  const cold = claudePromptCache([event],"seat",start+3600);
  expect(cold).toMatchObject({state:"cold",remaining_seconds:0});
  expect(formatPromptCache(cold)).toBe("●");
  expect(formatPromptCache(null)).toBe("");
  expect(formatPromptCache({...warm!,state:"none"})).toBe("");
  expect(formatPromptCache({...warm!,state:"unknown"})).toBe("");
});

test("the documented native compact attachment fences cache and usage together", () => {
  for (const field of ["hookName","hookEvent"]) {
    const compact = {type:"attachment",sessionId:"seat",attachment:{[field]:"SessionStart:compact"}};
    const result = sample("claude",[claude(),compact]);
    expect(result.prompt_cache).toBeNull();
    expect(result.input_tokens).toBeNull();
  }
});


test("cache marker rounds before coloring and never guesses unknown expiry", () => {
  const base = {state:"warm",ttl_seconds:3600,last_activity_at:at,expires_at:new Date(Date.parse(at)+60000).toISOString(),
    remaining_seconds:60,source:"claude_transcript",basis:"assistant_timestamp",unknown_reason:null} as const;
  for (const [seconds, minutes, color] of [[1,1,31],[59,1,31],[240,4,31],[241,5,33],[300,5,33],[840,14,33],[841,15,94],[900,15,94]]) {
    const cache = {...base,remaining_seconds:seconds!,expires_at:new Date(Date.parse(at)+seconds!*1000).toISOString()};
    expect(formatPromptCache(cache,false,Date.parse(at)/1000)).toBe(`●${minutes}m`);
    expect(formatPromptCache(cache,true,Date.parse(at)/1000)).toBe(`\x1b[${color}m●${minutes}m\x1b[0m`);
  }
  expect(formatPromptCache({...base,state:"cold",remaining_seconds:0},true)).toBe("\x1b[38;5;88m●\x1b[0m");
  expect(formatPromptCache({...base,state:"cold",remaining_seconds:0})).toBe("●");
  for (const remaining_seconds of [null,NaN,Infinity])
    expect(formatPromptCache({...base,remaining_seconds},true,Date.parse(at)/1000)).toBe("");
  expect(formatPromptCache({...base,expires_at:null},true)).toBe("");
});


test("cache display rounds the deadline before the JSON seconds floor", () => {
  const now = Date.parse(at)/1000;
  const cache = {state:"warm",ttl_seconds:3600,last_activity_at:at,
    expires_at:new Date((now+840.5)*1000).toISOString(),remaining_seconds:840,
    source:"claude_transcript",basis:"assistant_timestamp",unknown_reason:null} as const;
  expect(formatPromptCache(cache,true,now)).toBe("\x1b[94m●15m\x1b[0m");
});
