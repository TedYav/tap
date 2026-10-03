import { CODEX_HOOK_TRUST_REASON } from "./agent-state";
import { protectedMessageState, protectionDetail, protectionUntil } from "./input-protection";
import {harnessQueued,harnessQueueMessage} from "./harness-queue";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { unresolvedInjection } from "./submit-phase";
import { hasDeliveryReceipt, unverifiedCanonical, unverifiedCanonicalMessage } from "./delivery-custody";

export function queueExplanation(home: string, id: string, now = Date.now() / 1000, env = process.env): string {
  if (unverifiedCanonical(home, id)) return unverifiedCanonicalMessage(id);
  const injection = unresolvedInjection(home, id);
  if (injection) return injection;
  if (hasDeliveryReceipt(home, id) && !existsSync(join(home, "spool", `${id}.md`))) return "";
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(readFileSync(join(home, "spool", `${id}.meta.json`), "utf8"));
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return "Queue schedule unavailable: invalid metadata.";
  } catch { return "Queue schedule unavailable: metadata missing or unreadable."; }
  const held = typeof meta.pane_id === "string" ? protectedMessageState(home, id, meta.pane_id, env) : null;
  if (held === undefined) return "Queue: operator WAIT status unobservable; delivery remains guarded.";
  if (held && protectionUntil(held) > now * 1000) return `Queue: ${protectionDetail(held)}; submits earlier when the composer is ready.`;
  const reason = String(meta.reason || "unknown"), cls = String(meta.reason_class || "unknown");
  const words: Record<string, string> = {
    "codex-hook-trust": CODEX_HOOK_TRUST_REASON,
    "pending-input": "occupied composer (queued input or a draft)", "copy-mode": "recipient pane is in copy mode",
    "shell-mode": "OpenCode shell mode blocks chat delivery; a sender alert is published on detection",
    "feedback-draft": "Claude feedback-draft panel blocks delivery; a human or the seat's leader dismisses it (sender and supervising leader are alerted on detection)",
    "no-prompt": "recipient has no readable input prompt", "no-input-prompt": "recipient has no readable input prompt",
    clearing: "recipient context reset is in progress", polite: "polite delivery window",
    "auto-settle": "waiting to group messages into a digest", busy: "recipient is busy",
    "lock-park": "last recorded submit was refused by the pane lock",
    "rate-limit": "recipient cooldown", window: "recipient cooldown",
  };
  const holder = reason === "lock-park" && meta.lock_park && typeof meta.lock_park === "object"
    ? `Lock refusal observed at ${String((meta.lock_park as Record<string, unknown>).observed_at || "unknown time")}: ${String((meta.lock_park as Record<string, unknown>).detail || "holder attribution unavailable")}; current lock ownership has not been rechecked` : "";
  const prefix = `Queue: ${cls}/${reason} — ${words[reason] ?? (cls === "busy" ? "waiting for recipient readiness" : "waiting for the delivery window")}.${holder ? ` ${holder}.` : ""}`;
  if (existsSync(join(home, "receipts", `${id}.unconfirmed`))) return `${prefix} No further recipient attempt; delivery unconfirmed. Sender notice: ${id}-delivery-unconfirmed; inspect with tap show ${id}.`;
  const number = (value: unknown): number => value === null || value === undefined || value === "" ? NaN : Number(value);
  const stamp = (value: unknown): string => {
    try { return new Date(number(value) * 1000).toISOString(); } catch { return "unknown"; }
  };
  let probe = stamp(meta.next_probe_epoch);
  if (number(meta.next_probe_epoch) < now) probe += " (scheduled time passed; next probe not confirmed)";
  const deadline = stamp(meta.deadline_epoch);
  const end = meta.waiter_lifetime === "grace-window"
    ? `grace deadline: ${deadline}; a refused possible attempt ends automatic delivery with an .unconfirmed receipt and sender notice`
    : cls === "window" ? `delivery window opens: ${stamp(meta.hold_until_epoch)}; delivery still requires a usable composer`
    : `deadline: ${deadline}; disposition follows the delivery policy`;
  if (meta.escalated_at) return `${prefix} No further recipient attempt; disposition needs recovery. ${end}.`;
  const overdue = now - number(meta.next_probe_epoch);
  if (Number.isFinite(overdue) && overdue > 30) {
    return `${prefix} stale-park: scheduled probe is ${Math.floor(overdue)}s overdue; retry progress is not observed. Inspect with tap show ${id}. ${end}.`;
  }
  return `${prefix} next probe: ${probe}; ${end}. Probe time is not a delivery guarantee.`;
}
export function unverifiedSend(home: string, id: string, from: string, to: string, path: string, json: boolean, refusal?: { cause: "pane_dead"; detail: string }): { stdout: string; stderr: string } {
  if(harnessQueued(home,id)) return {stdout:harnessQueueMessage(home,id,json),stderr:""};
  const injection = unresolvedInjection(home, id);
  if (json) return { stdout: JSON.stringify({ status: "pending",
    error_class: "submit_unverified", action: `tap outstanding ${from}`, id, path, to,
    ...(refusal ?? {}),
    ...(injection ? { phase: "injected-enter-unconfirmed", queue_explanation: injection } : {}) }) + "\n", stderr: "" };
  return { stdout: "", stderr: `tap send: ${id} is on the bus for ${to}. Delivery not confirmed.${refusal ? ` ${refusal.cause}: ${refusal.detail}.` : ""} Inspect with tap show ${id}; tap resend ${id} requires proof that no attempt occurred.${injection ? " " + injection : ""}\n` };
}
if (import.meta.main) {
  const [home, id, mode, from = "", to = "", path = "", json = "0"] = Bun.argv.slice(2);
  if (!home || !id) { console.error("queue explanation arguments required"); process.exitCode = 1; }
  else if (mode === "send-unverified") {
    const output = unverifiedSend(home, id, from, to, path, json === "1");
    process.stdout.write(output.stdout); process.stderr.write(output.stderr);
  }
  else if (mode === "injection-phase") console.log(harnessQueued(home,id) ? "harness-queued" : "injected-enter-unconfirmed");
  else if (mode === "injection") console.log(unresolvedInjection(home, id) ?? "");
  else if (mode !== "present" || existsSync(join(home, "spool", `${id}.meta.json`)) || unverifiedCanonical(home, id) || unresolvedInjection(home, id)) console.log(queueExplanation(home, id));
}
