import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readBoundTranscript } from "../src/readiness-stall";
import { transcriptPosition, unwedgeProgress } from "../src/recovery/unwedge-progress";
import type { UnwedgeAttempt } from "../src/recovery/unwedge-policy";

const wire = '[[TAP v0.23 note actor-20261028T000000Z-abcdef123456 preview="Recovery check"]]';
const id = "actor-20261028T000000Z-abcdef123456";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const event = (type: string, extra = {}) => ({ type: "event_msg", payload: { type, ...extra } });
function fixture(harness: "codex" | "claude" = "codex") {
  const path = join(mkdtempSync(join(tmpdir(), "unwedge-progress-")), "transcript.jsonl");
  const seed = harness === "codex" ? [{ type: "session_meta", payload: { id: "native-1" } }, event("turn_aborted")]
    : [{ type: "assistant", sessionId: "native-1", message: { content: [], stop_reason: "end_turn" } }];
  writeFileSync(path, seed.map(r => JSON.stringify(r)).join("\n") + "\n");
  const seat = { harness_session_id: "native-1", transcript_path: path };
  const read = () => readBoundTranscript(harness, seat, process.env);
  const sample = read()!;
  expect(sample).not.toBeNull();
  const attempt = { binding: { harness, nativeSessionId: "native-1" }, cause: harness === "codex" ? "model_capacity" : "api_error",
    position: transcriptPosition(sample), stimulus: { id, hash: hash(wire) } } as UnwedgeAttempt;
  const append = (...rows: object[]) => appendFileSync(path, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  return { path, seat, attempt, read, append };
}

test("an unchanged session-bound transcript is unchanged; another session is not evidence", () => {
  const f = fixture();
  expect(unwedgeProgress(f.attempt, f.read(), "model_capacity")).toBe("unchanged");
  expect(readBoundTranscript("codex", { ...f.seat, harness_session_id: "someone-else" }, process.env)).toBeNull();
  expect(unwedgeProgress(f.attempt, null, "model_capacity")).toBe("unknown");
});

test("message stimulus followed by the same capacity stop permits the next rung", () => {
  const f = fixture();
  const capacity = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/agent-state/errors/codex-capacity-turn.jsonl"), "utf8"));
  f.append(event("user_message", { message: wire }), event("item_completed", { item: { type: "UserMessage", content: [{ type: "text", text: wire }] } }), event("task_started"), capacity);
  expect(unwedgeProgress(f.attempt, f.read(), "model_capacity")).toBe("own-stimulus-stopped");
  expect(unwedgeProgress(f.attempt, f.read(), "prompt_idle")).toBe("productive");
});

test("normal assistant output or another user's input ends the incident", () => {
  const reply = fixture();
  reply.append(event("user_message", { message: wire }), event("agent_message", { message: "I ran the pending checks." }), event("task_complete"));
  expect(unwedgeProgress(reply.attempt, reply.read(), "model_capacity")).toBe("productive");
  const other = fixture();
  other.append(event("user_message", { message: "Do something else" }), event("turn_aborted"));
  expect(unwedgeProgress(other.attempt, other.read(), "model_capacity")).toBe("productive");
});

test("a Continue's exact nudge wire can be correlated without a payload ID", () => {
  const f = fixture();
  const continued = '[[TAP v0.23 nudge message="Your last turn stopped at model capacity. Continue your existing task."]]';
  f.attempt.stimulus = { hash: hash(continued) };
  f.append({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: continued }] } },
    event("task_started"), event("turn_aborted"));
  expect(unwedgeProgress(f.attempt, f.read(), "model_capacity")).toBe("own-stimulus-stopped");
});

test("tool calls and assistant reasoning are productive even when the same error returns", () => {
  for (const payload of [{ type: "function_call", name: "exec_command", arguments: "{}" },
    { type: "reasoning", summary: [{ text: "Working on it" }] }]) {
    const f = fixture();
    f.append(event("user_message", { message: wire }), { type: "response_item", payload }, event("turn_aborted"));
    expect(unwedgeProgress(f.attempt, f.read(), "model_capacity")).toBe("productive");
  }
});

test("Claude's own stimulus followed only by its API error is distinct from useful output", () => {
  const f = fixture("claude");
  f.append({ type: "user", sessionId: "native-1", message: { content: wire } },
    { type: "assistant", sessionId: "native-1", isApiErrorMessage: true,
      message: { content: [{ type: "text", text: "API Error: transient server failure" }], stop_reason: "end_turn" } });
  expect(unwedgeProgress(f.attempt, f.read(), "api_error")).toBe("own-stimulus-stopped");
  f.append({ type: "assistant", sessionId: "native-1", message: { content: [{ type: "text", text: "I fixed the failing check." }], stop_reason: "end_turn" } });
  expect(unwedgeProgress(f.attempt, f.read(), "api_error")).toBe("productive");
});

test("unmatched, torn, rewritten or oversized suffixes cannot prove a failed recovery", () => {
  const unknown = fixture(); unknown.append(event("new_unrecognized_event"), event("turn_aborted"));
  expect(unwedgeProgress(unknown.attempt, unknown.read(), "model_capacity")).toBe("unknown");
  const torn = fixture(); appendFileSync(torn.path, '{"type":');
  expect(unwedgeProgress(torn.attempt, torn.read(), "model_capacity")).toBe("unknown");
  const overwritten = fixture();
  writeFileSync(overwritten.path, JSON.stringify({ type: "session_meta", payload: { id: "native-1" } }) + "\n");
  expect(unwedgeProgress(overwritten.attempt, overwritten.read(), "model_capacity")).toBe("unknown");
  const huge = fixture(); huge.append(event("user_message", { message: "a".repeat(300000) }), event("turn_aborted"));
  expect(unwedgeProgress(huge.attempt, huge.read(), "model_capacity")).toBe("unknown");
});

test("a record containing the right sentinel plus other input is not our stimulus", () => {
  const f = fixture();
  f.append(event("user_message", { message: `${wire}\nAlso delete this branch` }), event("turn_aborted"));
  expect(unwedgeProgress(f.attempt, f.read(), "model_capacity")).toBe("productive");
});

test("Claude progress and unknown system records cannot be ignored as a repeated failure", () => {
  for (const [row, expected] of [[{ type: "progress", data: { type: "tool_progress" } }, "productive"],
    [{ type: "system", subtype: "new_unrecognized_state" }, "unknown"]] as const) {
    const f = fixture("claude");
    f.append({ type: "user", sessionId: "native-1", message: { content: wire } },
      { type: "assistant", sessionId: "native-1", isApiErrorMessage: true, message: { content: [], stop_reason: "end_turn" } }, row);
    expect(unwedgeProgress(f.attempt, f.read(), "api_error")).toBe(expected);
  }
});

test("same-inode, same-size rewriting before the recorded boundary invalidates the incident", () => {
  const f = fixture();
  const before = f.read()!;
  writeFileSync(f.path, readFileSync(f.path, "utf8").replace('"turn_aborted"', '"task_started"'));
  const after = f.read()!;
  expect(after.fileId).toBe(before.fileId);
  expect(after.size).toBe(before.size);
  expect(unwedgeProgress(f.attempt, after, "model_capacity")).toBe("unknown");
});

test("only this invocation's verified interrupt may account for an abort-only suffix", () => {
  const f = fixture(); f.append(event("turn_aborted"));
  expect(unwedgeProgress(f.attempt, f.read(), "model_capacity")).toBe("unknown");
  expect(unwedgeProgress(f.attempt, f.read(), "model_capacity", true)).toBe("unchanged");
  f.append(event("task_started"));
  expect(unwedgeProgress(f.attempt, f.read(), "model_capacity", true)).toBe("unknown");
});

const metadataRows = (harness: string): Record<string, any>[] => readFileSync(join(import.meta.dir, `fixtures/unwedge-transcripts/${harness}-metadata-stop.jsonl`), "utf8").trim().split("\n").map(line => JSON.parse(line));
for (const harness of ["codex", "claude"] as const) {
  test(`${harness} captured metadata shapes preserve own-stimulus failure and never hide real output`, () => {
    const f = fixture(harness), rows = metadataRows(harness); f.append(...rows);
    expect(unwedgeProgress(f.attempt, f.read(), f.attempt.cause)).toBe("own-stimulus-stopped");
    const output = harness === "codex" ? { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Useful work." }] } }
      : { type: "assistant", sessionId: "native-1", message: { content: [{ type: "tool_use", name: "example", input: {} }], stop_reason: "tool_use" } };
    const productive = fixture(harness); productive.append(...rows.slice(0, -1), output, rows.at(-1)!);
    expect(unwedgeProgress(productive.attempt, productive.read(), productive.attempt.cause)).toBe("productive");
  });
}

test("Codex context is neutral only with per-content provenance; user markup is other input", () => {
  const rows = metadataRows("codex");
  const context = rows.find(r => r.payload?.role === "user" && r.payload.internal_chat_message_metadata_passthrough?.content_item_kinds.includes("environments.environment_context"))!;
  const neutral = fixture(); neutral.append(context);
  expect(unwedgeProgress(neutral.attempt, neutral.read(), "model_capacity")).toBe("unchanged");
  for (const variant of ["missing", "user", "mixed"] as const) {
    const copy = structuredClone(context), p = copy.payload;
    if (variant === "missing") delete p.internal_chat_message_metadata_passthrough;
    if (variant === "user") p.internal_chat_message_metadata_passthrough = { content_item_kinds: p.content.map(() => "user.text"), content_item_metadata: p.content.map(() => ({ provenance: { type: "user" } })) };
    if (variant === "mixed") p.content.push({ type: "input_text", text: "Another real instruction." });
    const f = fixture(); f.append(copy, ...rows);
    expect(unwedgeProgress(f.attempt, f.read(), "model_capacity")).not.toBe("own-stimulus-stopped");
  }
});

test("Claude bookkeeping does not hide queued input, task notifications, file changes or an unfinished request", () => {
  const rows = metadataRows("claude");
  for (const [row, expected] of [
    [{ type: "attachment", attachment: { type: "hook_success" } }, "own-stimulus-stopped"],
    [{ type: "attachment", attachment: { type: "queued_command", prompt: "More work" } }, "productive"],
    [{ type: "user", sessionId: "native-1", origin: { kind: "task-notification" }, message: { content: wire } }, "productive"],
    [{ type: "attachment", attachment: { type: "edited_text_file" } }, "unknown"],
    [{ type: "queue-operation", operation: "enqueue" }, "unknown"],
    [{ type: "system", subtype: "scheduled_task_fire" }, "productive"],
    [{ type: "api-request" }, "unknown"],
  ] as const) {
    const f = fixture("claude"); f.append(...rows, row);
    expect(unwedgeProgress(f.attempt, f.read(), "api_error")).toBe(expected);
  }
});

test("only neutral bookkeeping can accompany this invocation's interrupt marker", () => {
  const f = fixture(); f.append({ type: "token_usage_record", payload: {} }, event("turn_aborted"), event("token_count"));
  expect(unwedgeProgress(f.attempt, f.read(), "model_capacity", true)).toBe("unchanged");
  expect(unwedgeProgress(f.attempt, f.read(), "model_capacity")).toBe("unknown");
});
