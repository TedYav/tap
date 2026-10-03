import { closeSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { pyReadUtf8 } from "./spool-publication";
import { dumps, isMap, loads, type JsonValue } from "./watch-detect";

// The shared indent serializer sorts keys; installer settings retain insertion order.
function indent(value: JsonValue, depth = 0): string {
  const pad = "  ".repeat(depth + 1);
  const scalar = (v: JsonValue) => dumps(v, true).replace(/\x7f/g, "\\u007f");
  if (isMap(value)) {
    const rows = [...value].map(([key, item]) => `${pad}${scalar(key)}: ${indent(item, depth + 1)}`);
    return rows.length ? `{\n${rows.join(",\n")}\n${"  ".repeat(depth)}}` : "{}";
  }
  if (Array.isArray(value)) return value.length ? `[\n${value.map(item => `${pad}${indent(item, depth + 1)}`).join(",\n")}\n${"  ".repeat(depth)}]` : "[]";
  return scalar(value);
}

export function cleanupRosterHook(harness: "claude" | "cursor", path: string): void {
  let data: JsonValue;
  try { data = loads(pyReadUtf8(path)); } catch { return; }
  if (!isMap(data)) return;
  const hooks = data.get("hooks");
  if (!isMap(hooks)) return;
  const event = harness === "claude" ? "UserPromptSubmit" : "beforeSubmitPrompt";
  const entries = hooks.get(event);
  if (!Array.isArray(entries)) return;
  const kept: JsonValue[] = [];
  for (const entry of entries) {
    if (!isMap(entry)) { kept.push(entry); continue; }
    const nested = harness === "claude" ? entry.get("hooks") ?? [] : [entry];
    // Ambiguous target shapes preserve the entire file, including earlier matches.
    if (!Array.isArray(nested)) return;
    let remove = false;
    for (const hook of nested) {
      if (!isMap(hook)) continue;
      const command = hook.get("command");
      if (command === undefined || command === null) continue;
      if (typeof command !== "string") return;
      if (command.includes("TAP_HOOK_MODE=roster")) remove = true;
    }
    if (!remove) kept.push(entry);
  }
  if (kept.length === entries.length) return;
  if (kept.length) hooks.set(event, kept);
  else hooks.delete(event);

  const description = harness === "claude" ? "the retired Claude UserPromptSubmit" : "the no-op Cursor beforeSubmitPrompt";
  const temp = `${path}.tap-${randomUUID()}`;
  let owned = false;
  try {
    // Like Python open(..., "w"): 0666 filtered by umask, no parent creation.
    // Exclusive creation gives cleanup ownership without truncating a foreign temp.
    const fd = openSync(temp, "wx", 0o666);
    owned = true;
    try { writeFileSync(fd, indent(data) + "\n"); } finally { closeSync(fd); }
    renameSync(temp, path);
    owned = false;
  } catch (error) {
    console.error(`install: could NOT remove ${description} roster entry from ${path} (${error}); remove it by hand or re-run after fixing permissions`);
    if (owned) { try { unlinkSync(temp); } catch { /* Cleanup must not abort installation. */ } }
    return;
  }
  console.log(`install: removed ${description} roster entry from ${path}`);
}

if (import.meta.main) {
  const [harness, explicitPath, ...extra] = process.argv.slice(2);
  if ((harness !== "claude" && harness !== "cursor") || extra.length) {
    console.error("usage: install-roster-hook-cleanup.ts claude|cursor [path]");
    process.exitCode = 64;
  } else {
    const home = harness === "claude" ? process.env.TAP_CLAUDE_HOME : process.env.TAP_CURSOR_HOME;
    cleanupRosterHook(harness, explicitPath || join(home || join(homedir(), `.${harness}`), harness === "claude" ? "settings.json" : "hooks.json"));
  }
}
