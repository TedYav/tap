import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_CONVERSATION_ID, nativeConversationExists } from "./native-conversation";

const quote = (value: string) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const MAX_EVENT_BYTES = 16 * 1024 * 1024;

/** Owns only this invocation's output capture, never a TAP seat or a native conversation. */
export class AskConversation {
  readonly args: string[] = [];
  private id = "";
  private problem = "";
  private pending = "";
  private decoder = new TextDecoder();
  private scratch = "";
  private artifact = "";
  private bytes = 0;
  private structured = false;
  constructor(readonly harness: string, readonly ephemeral: boolean, private readonly emit: (bytes: Uint8Array) => void) {
    if (ephemeral) return;
    if (harness === "claude") { this.id = randomUUID(); this.args.push("--session-id", this.id); }
    else if (harness === "codex" || harness === "hermes") {
      this.scratch = mkdtempSync(join(tmpdir(), "tap-ask-"));
      this.artifact = join(this.scratch, harness === "codex" ? "answer" : "usage.json");
      this.args.push(...(harness === "codex" ? ["--json", "--output-last-message", this.artifact] : ["--usage-file", this.artifact]));
      this.structured = harness === "codex";
    } else {
      this.structured = true;
      this.args.push(...(harness === "opencode" ? ["--format", "json"] : ["--output-format", "json"]));
    }
  }
  private write(value: string | Uint8Array): void {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    this.bytes += bytes.byteLength;
    this.emit(bytes);
  }
  private capture(value: unknown): void {
    if (typeof value !== "string" || !NATIVE_CONVERSATION_ID.test(value)) { this.problem ||= "native session id is missing or invalid"; return; }
    if (this.id && this.id !== value) { this.problem ||= "native output reported conflicting session ids"; return; }
    this.id = value;
  }
  private event(line: string): void {
    if (!line.trim()) return;
    let event: unknown;
    try { event = JSON.parse(line); } catch { this.problem ||= "native structured output was malformed"; return; }
    if (!object(event)) { this.problem ||= "native structured output was malformed"; return; }
    if (this.harness === "codex") {
      if (event.type === "thread.started") this.capture(event.thread_id);
    } else if (this.harness === "opencode") {
      if (event.sessionID !== undefined) this.capture(event.sessionID);
      if (event.type === "text" && object(event.part) && typeof event.part.text === "string") this.write(event.part.text);
    } else if (this.harness === "cursor") {
      if (event.type === "result" && event.is_error === false && typeof event.result === "string") {
        this.capture(event.session_id); this.write(event.result);
      } else this.problem ||= "native output did not contain a successful result";
    } else if (this.harness === "agy") {
      if (event.status === "SUCCESS" && typeof event.response === "string") {
        this.capture(event.conversation_id); this.write(event.response);
      } else this.problem ||= "native output did not contain a successful result";
    }
  }
  feed(value: Uint8Array): void {
    if (!this.structured) { this.write(value); return; }
    this.pending += this.decoder.decode(value, { stream: true });
    let end: number;
    while ((end = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, end); this.pending = this.pending.slice(end + 1);
      if (line.length > MAX_EVENT_BYTES) this.problem ||= "native output event exceeded 16 MiB";
      else this.event(line);
    }
    if (this.pending.length > MAX_EVENT_BYTES) { this.pending = ""; this.problem ||= "native output event exceeded 16 MiB"; }
  }
  finish(): number {
    if (this.structured) {
      this.pending += this.decoder.decode();
      if (this.pending) this.event(this.pending);
      this.pending = "";
    }
    if (this.artifact) {
      try {
        if (this.harness === "codex") this.write(readFileSync(this.artifact));
        else {
          const report = JSON.parse(readFileSync(this.artifact, "utf8"));
          if (report.completed === true && report.failed !== true) this.capture(report.session_id);
          else this.problem ||= "native usage report did not confirm a completed conversation";
        }
      } catch { this.problem ||= "native capture file was unavailable"; }
    }
    return this.bytes;
  }
  receipt(cwd: string, env: NodeJS.ProcessEnv, preset?: string, model?: string | null): string {
    if (this.ephemeral) return "";
    if (!this.id || this.problem) return `tap ask: ${this.harness} session unavailable (${this.problem || "native output did not report an id"}); no crew adoption command\n`;
    if (!nativeConversationExists(this.harness, this.id, cwd, env)) return `tap ask: ${this.harness} session ${this.id}; persisted conversation could not be verified for this cwd/store; no crew adoption command\n`;
    const tuning = preset ? ` --preset ${quote(preset)}` : ` --model ${model ? quote(model) : "<model>"}`;
    return `tap ask: ${this.harness} session ${this.id}; continue it as a crew: tap crew add ${this.harness} <name>${tuning} --resume ${quote(this.id)} --cwd ${quote(cwd)}\n`;
  }
  close(): void {
    if (!this.scratch) return;
    try { unlinkSync(this.artifact); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    rmdirSync(this.scratch);
  }
}
