/** One row formatter for canonical and queued inbox mail. Eligibility and custody
 * remain with the readers and queue; these inputs contain only authorized rows. */
import { payloadPreview } from "../sentinel-preview";
import type { Envelope } from "../envelope";
import { replyExpectationOk } from "../envelope";
import { dirname, join } from "node:path";

export interface InboxFacts {
  envelope: Envelope["fields"];
  residency: "canonical" | "parked";
  attributed: boolean;
  unconfirmed: boolean;
  age: number | null;
  reason?: string;
  queueExplanation?: string;
  firstSpooledEpoch?: number;
}
export interface InboxRow {
  residency: InboxFacts["residency"];
  item: Record<string, unknown>;
  human: string;
  warnings: string;
}
export function inboxRows(input: { me: string; rows: InboxFacts[] }): InboxRow[] {
  const rows = [...input.rows].sort((a, b) => a.residency !== b.residency
    ? (a.residency === "canonical" ? -1 : 1)
    : a.residency === "parked" ? (a.firstSpooledEpoch ?? 0) - (b.firstSpooledEpoch ?? 0) : 0);
  const seen = new Set<string>();
  return rows.filter(row => {
    const id = row.envelope.id!;
    const key = `${row.envelope.foreign_bus || ""}/${id}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map(row => {
    const f = row.envelope, id = f.id!, address = f.address || id, from = f.from ?? "", rawReply = f.reply ?? "";
    const replyOk = replyExpectationOk(rawReply), reply = replyOk ? rawReply || "expected" : rawReply;
    const preview = payloadPreview(f.path || "");
    const parked = row.residency === "parked";
    const item: Record<string, unknown> = { id, kind: f.kind ?? "", from, reply, path: f.path,
      provenance: row.attributed ? "courier" : "unattributed",
      ...(preview ? { preview } : {}),
      ...(f.epoch ? { epoch: f.epoch } : {}), ...(f.from_team ? { from_team: f.from_team } : {}),
      ...(f.reply_to ? { reply_to: f.reply_to } : {}),
      ...(f.adopted_from ? { adopted_from: f.adopted_from } : {}),
      ...(!replyOk ? { reply_invalid: true, reply_raw: rawReply } : {}),
      ...(!row.attributed ? { unattributed: true } : {}),
      ...(parked ? { residency: "parked", reason: row.reason || "unknown", queue_explanation: row.queueExplanation || "" } : {}),
    };
    let extra = f.reply_to ? `  reply_to: ${f.reply_to}` : "";
    if (f.adopted_from) extra += `  adopted_from: ${f.adopted_from}`;
    if (!row.attributed) extra += "  provenance: unattributed";
    if (!replyOk) extra += `  reply_invalid: ${rawReply}`;
    if (parked) extra += `  queued (${row.reason || "unknown"}). ${row.queueExplanation || ""}`;
    else if (row.unconfirmed) extra += "  unconfirmed to your pane — reading it here counts";
    const obligation = !replyOk ? "invalid" : reply === "expected" ? "ask" : "note";
    let human = `${id}${preview ? `  preview=${JSON.stringify(preview)}` : ""}  ${f.from_team ? `${f.from_team}/${from}` : from}  ${obligation}  ${row.age ?? "?"}s${extra}\n`;
    let warnings = "";
    if (!row.attributed) warnings += `tap poll: warning: ${id} has no courier .placed/.sent receipt — treating as unattributed file on the bus (not silent-dropped)\n`;
    if (!replyOk) {
      warnings += `tap poll: warning: ${id} has unsanctioned reply: ${rawReply} (expected|settle-only only) — no protocol next-step\n`;
      human += `next step: tap show ${address} (fix reply: before acting)\n`;
    } else if (parked || reply === "settle-only") {
      // Locally parked mail settles through its canonical pointer — the form
      // the resolver accepts for an id parked at home; a foreign parked row
      // keeps the explicit foreign address the poll already rendered for it.
      const readAddress = parked && !f.foreign_bus
        ? "path=" + join(dirname(dirname(f.path || "")), "payloads", id + ".md")
        : address;
      human += `next step: tap read ${readAddress} --by ${input.me}${f.epoch ? ` --epoch ${f.epoch}` : ""}\n`;
    } else human += `next step: tap reply ${address} -f <file>\n`;
    return { residency: row.residency, item, human, warnings };
  });
}
