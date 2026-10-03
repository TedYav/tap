import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveBus } from "./bushome";
import { readIndexJson } from "./index-home";
import { latestOutbound } from "./latest-outbound";
import { frontmatterFields } from "./payload-fields";
import { isSettled } from "./watch-lease";

/** A displayed percentage, against the harness's own denominator. Never infer a token cap. */
export function contextUsedPercent(harness: string, text: string): number | null {
  if (!["codex", "claude", "opencode"].includes(harness)) return null;
  const footer = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trimEnd().split("\n").slice(-6).join("\n");
  const patterns = harness === "codex"
    ? [/\bContext\s+(\d{1,3})%\s+left\b/gi]
    : [/\b\d+(?:\.\d+)?[Kk]\s*\((\d{1,3})%\)/g, /\b(\d{1,3})%\s*\(\d+(?:\.\d+)?[KkMm]?\)\s*ctx\b/gi];
  const values = patterns.flatMap(pattern => [...footer.matchAll(pattern)].map(m => Number(m[1])));
  if (!values.length || new Set(values).size !== 1 || values[0]! > 100) return null;
  return harness === "codex" ? 100 - values[0]! : values[0]!;
}

/** An unsettled envelope's own addressing, as the poll gate reads it. */
export interface InboundAsk { id: string; from: string; to: string; adoptedFrom: string; recipientInstance: string }

/**
 * Whether `actor` is the addressee of `ask` (true), is not (false), or the registry
 * cannot say (null). The roster passes the same grant `tap poll` and `tap read` use.
 */
export type AddresseeGate = (ask: InboundAsk, actor: string) => boolean | null;

/**
 * One cross-bus scan for all requested recipients; sidecars survive residency races.
 * Without a gate the `to` seat owes the ask. With one, each requested handle is tested
 * through it, so adopted and forwarded custody and retired-instance stamps follow poll.
 * A positive claim also needs sanctioned reply semantics: any `reply` other than
 * `expected` or `settle-only` is unsanctioned custody and answers unknown, never owed.
 */
export function pendingInboundAsks(local: string, index: string, team: string, handles: string[],
  gate?: AddresseeGate): Record<string, boolean | null> {
  const result: Record<string, boolean | null> = Object.fromEntries(handles.map(h => [h, false]));
  const unknown = () => { for (const h of handles) if (result[h] === false) result[h] = null; return result; };
  try {
    const buses = new Map([[local, team]]);
    if (existsSync(index)) {
      const doc = readIndexJson(index);
      for (const [name, row] of Object.entries(doc.teams ?? {}) as [string, any][]) {
        if (row.state === "historical") continue;
        if (typeof row.root !== "string") return unknown();
        const resolution = resolveBus(row.root, {});
        if (resolution.rule === "old_store") return unknown();
        const bus = resolution.home;
        if (!buses.has(bus)) buses.set(bus, name);
      }
    }
    for (const [bus, sourceTeam] of buses) {
      const ids = new Set<string>();
      for (const folder of ["payloads", "spool"]) {
        const dir = join(bus, folder);
        if (!existsSync(dir)) continue;
        for (const name of readdirSync(dir)) {
          if (/^[_.]/.test(name)) continue;
          if (name.endsWith(".md")) ids.add(name.slice(0, -3));
          else if (folder === "spool" && name.endsWith(".meta.json")) ids.add(name.slice(0, -10));
        }
      }
      for (const id of ids) {
        if (isSettled(join(bus, "receipts"), id)) continue;
        let fields: Record<string, string> = {};
        for (const folder of ["spool", "payloads", "spool"]) {
          try { fields = frontmatterFields(readFileSync(join(bus, folder, `${id}.md`), "utf8")); } catch { fields = {}; }
          if (Object.keys(fields).length) break;
        }
        if (["id", "from", "to", "reply"].some(key => !fields[key])) return unknown();
        if ((fields.to_team || sourceTeam) !== team || fields.reply === "settle-only") continue;
        const ask: InboundAsk = { id, from: fields.from!, to: fields.to!, adoptedFrom: fields.to_adopted_from ?? "", recipientInstance: fields.recipient_instance ?? "" };
        const sanctioned = fields.reply === "expected";
        for (const handle of gate ? handles : Object.hasOwn(result, ask.to) ? [ask.to] : []) {
          const owed = gate ? gate(ask, handle) : true;
          if (owed === true && sanctioned) result[handle] = true;
          else if (owed !== false && result[handle] === false) result[handle] = null;
        }
      }
    }
    return result;
  } catch { return unknown(); }
}

export function contextQueueFacts(local: string, index: string, team: string, handles: string[], now = Math.trunc(Date.now() / 1000)) {
  const pending = pendingInboundAsks(local, index, team, handles);
  const out = latestOutbound(join(local, "payloads"), join(local, "spool"), team, now);
  return Object.fromEntries(handles.map(handle => [handle, {
    pending_inbound_ask: pending[handle] ?? null,
    last_outbound_age_seconds: out[handle]?.epoch ? Math.max(0, now - out[handle]!.epoch) : null,
  }]));
}
