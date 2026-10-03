import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readContextTokens, withClaudeWindow, formatContextTokens } from "../src/context-tokens";
import { removeScratchTree } from "./support/scratch";
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
  expect(formatContextTokens(withClaudeWindow(result,null))).toBe("340k / 1M");
  expect(formatContextTokens(withClaudeWindow(result,"300000"))).toBe("340k / 300k");
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
  expect(formatContextTokens(sample("codex",[header,event]))).toBe("145k / 380k");
  delete (event.payload.info as {model_context_window?:number}).model_context_window;
  expect(sample("codex",[header,event])).toMatchObject({window_tokens:1000000,window_source:"default_1m"});
  expect(formatContextTokens(sample("codex",[header,event]))).toBe("145k / 1M");
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
  expect(formatContextTokens(withClaudeWindow(sample("claude",[claude(),synthetic()]),null))).toBe("340k / 1M");
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
