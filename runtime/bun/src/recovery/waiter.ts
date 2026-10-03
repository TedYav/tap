import { existsSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseEnvelope, envelopeField } from "../envelope";
import { validId } from "../ids";
import type { ResolvedContext } from "../context";
import { readRun, runDirectory } from "./state";
import { tapCommand } from "./crew";

/** One bounded infrastructure reply wait. No silence probing, polling, or supervisory loop. */
export async function waitWorkerReply(ctx: ResolvedContext, runId: string, assignment: string, worker: string, actor: string, deadline: number): Promise<string> {
  deadline = Math.min(deadline, readRun(runId).deadline);
  const replyId = await new Promise<string>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const watchers: ReturnType<typeof watch>[] = [];
    const close = () => { for (const watcher of watchers) watcher.close(); clearTimeout(timer); };
    const fail = (error: unknown) => { if (!settled) { settled = true; close(); reject(error); } };
    const inspect = () => {
      if (settled) return;
      try {
        const path = ctx.bus.donePath(assignment);
        if (existsSync(path)) {
          const done = JSON.parse(readFileSync(path, "utf8"));
          if (done.by !== worker || done.via !== "reply" || !validId(done.reply_id || "")) throw new Error("worker settlement has no valid reply evidence");
          settled = true; close(); resolve(done.reply_id); return;
        }
        if (readRun(runId).state === "stopped") throw new Error("recovery stopped before worker completion");
      } catch (error) { fail(error); }
    };
    try {
      watchers.push(watch(ctx.bus.receiptsDir, inspect), watch(runDirectory(runId), inspect));
      timer = setTimeout(() => { inspect(); if (!settled) fail(new Error("worker exceeded the fixed recovery deadline")); }, Math.max(0, deadline - Date.now()));
      inspect();
    } catch (error) { fail(error); }
  });
  const path = [ctx.bus.payloadPath(replyId), join(ctx.bus.home, "spool", `${replyId}.md`)].find(existsSync);
  if (!path) throw new Error("worker reply evidence points to no durable payload");
  const raw = readFileSync(path, "utf8"), body = parseEnvelope(raw).body;
  const done = JSON.parse(readFileSync(ctx.bus.donePath(assignment), "utf8"));
  if (envelopeField(raw, "from") !== worker || envelopeField(raw, "in_reply_to") !== assignment ||
      createHash("sha256").update(body).digest("hex") !== done.reply_sha256) throw new Error("worker reply evidence does not match its payload");
  const read = await tapCommand(ctx, ["read", replyId, "--by", actor], { timeoutMs: Math.max(1, deadline - Date.now()) });
  if (read.code !== 0) throw new Error("worker reply could not be consumed; cleanup cannot claim it settled");
  return body.trim();
}
