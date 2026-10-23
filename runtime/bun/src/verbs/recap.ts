import { inheritedActor } from "../context";
import { readFileSync, statSync } from "node:fs";
import { callingPane, resolveSelf, TapError } from "../context";
import { ensureAscii } from "../fsatomic";
import { validToken } from "../ids";
import { frontmatterFields, PY_STRIP } from "../payload-fields";
import { currentInstance } from "../registry";
import { recapMessages } from "../recap-payloads";
import { applyTeamOverride } from "../team-override";
import { resolveSelection } from "../team-selection";

interface Row { id: string; kind: string; age_seconds: number | null; path: string }
interface History extends Row { peer: string; direction: string; first_line: string }

// Python's string order is code-point order, including non-ASCII legacy filenames.
const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const strip = (s: string) => s.replace(PY_STRIP, "");
function contents(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}
function age(path: string, now: number): number | null {
  try { return Math.max(0, now - Math.trunc(statSync(path).mtimeMs / 1000)); }
  catch { return null; }
}
function firstLine(raw: string): string {
  let fences = 0;
  for (const line of raw.split(/\r\n|\r|\n/)) {
    const text = strip(line);
    if (text === "---") { fences++; continue; }
    if (fences >= 2 && text) return [...text].slice(0, 120).join("");
  }
  return "";
}

export function cmdRecap(argv: string[]): number {
  process.env.TAP_JSON = "0";
  let handle = "", teamFlag = "", limitRaw = "5", json = false;
  const usage = (detail: string): never => { throw new TapError(1, "usage_error", "tap help recap", detail); };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") { json = true; process.env.TAP_JSON = "1"; }
    else if (a === "--team" || a === "--limit") {
      const value = argv[++i];
      if (!value) usage(`${a} needs a value`);
      if (a === "--team") teamFlag = value!;
      else limitRaw = value!;
    } else if (a.startsWith("--")) throw new TapError(1, "unknown_option", "tap help recap", `unknown option '${a}'`);
    else {
      if (handle) usage(`unexpected arg '${a}'`);
      handle = a;
    }
  }
  if (!/^[0-9]+$/.test(limitRaw)) usage("--limit must be a non-negative integer");
  // Python accepts arbitrarily large limits; Infinity still means all finite candidates.
  const limit = Number(limitRaw);
  const callerPin = process.env.TAP_HOME || "";
  applyTeamOverride(teamFlag);
  const ctx = resolveSelection(callerPin, teamFlag);
  handle ||= inheritedActor();
  if (!handle) {
    const pane = callingPane();
    let unverifiable = pane?.status === "unverifiable";
    if (pane?.status === "ok") {
      try { handle = resolveSelf(ctx, pane, 1).handle; }
      catch (error) {
        if (!(error instanceof TapError)) throw error;
        unverifiable = error.errorClass === "generation_unverifiable";
      }
    }
    if (unverifiable) throw new TapError(1, "generation_unverifiable",
      "wait for tmux to answer and retry, or pass the handle: tap recap <handle>",
      "refusing recap because the tmux server generation is unavailable and the caller identity cannot be verified");
    if (!handle) throw new TapError(1, "unregistered", "register_or_pass_handle",
      "run 'tap register' in this pane, or pass the handle: tap recap <handle>");
  }
  if (!validToken(handle)) usage(`handle '${handle}' is not a sentinel-safe token (^[A-Za-z0-9][A-Za-z0-9._-]*$)`);

  // A present stamp survives pre-flip too: unknown is not a matching instance.
  const instance = currentInstance(ctx.registryPath, handle);
  const mine = (stamp: string | undefined) => !stamp || (instance !== "" && stamp === instance);
  // JS trim removes a BOM; Python strip preserves it as part of the team qualifier.
  const addressedToLocal = (fields: Record<string, string>) => {
    const team = strip(fields.to_team ?? "");
    return fields.to === handle && (!team || team === strip(ctx.team));
  };
  const messages = recapMessages(ctx.bus);
  const now = Math.trunc(Date.now() / 1000);
  const inbox: (Row & { from: string })[] = [], outstanding: (Row & { to: string })[] = [];
  for (const { id, path } of messages.outstanding) {
    const fields = frontmatterFields(contents(path));
    if (fields.id !== undefined && fields.id !== id) continue;
    const row: Row = { id, kind: fields.kind ?? "", age_seconds: age(path, now), path };
    if (addressedToLocal(fields) && mine(fields.recipient_instance)) {
      inbox.push({ ...row, from: fields.from ?? "" });
    } else if (fields.from === handle && mine(fields.sender_instance)) {
      outstanding.push({ ...row, to: fields.to ?? "" });
    }
  }

  const candidates: { id: string; path: string; mtime: number }[] = [];
  if (limit > 0) for (const id of messages.ids) {
    const path = ctx.bus.payloadPath(id);
    try { candidates.push({ id, path, mtime: statSync(path).mtimeMs }); } catch { /* disappeared */ }
  }
  candidates.sort((a, b) => b.mtime - a.mtime || compare(b.id, a.id));
  const history: History[] = [];
  for (const { id, path } of candidates.slice(0, Math.max(20, limit * 4))) {
    const raw = contents(path), fields = frontmatterFields(raw);
    if (fields.id !== undefined && fields.id !== id) continue;
    const sender = fields.from ?? "", recipient = fields.to ?? "";
    if (sender !== handle && !addressedToLocal(fields)) continue;
    history.push({ id, peer: sender === handle ? recipient : sender,
      direction: sender === handle ? "sent" : "received", kind: fields.kind ?? "",
      age_seconds: age(path, now), first_line: firstLine(raw), path });
    if (history.length >= limit) break;
  }

  if (json) {
    process.stdout.write(ensureAscii(JSON.stringify({ ok: true, handle, team: ctx.team, inbox, outstanding, history })) + "\n");
    return 0;
  }
  const lines = [`tap recap: ${ctx.team ? ctx.team + "/" : ""}${handle}`];
  if (inbox.length) {
    lines.push(`\nunsettled inbound (${inbox.length} ${inbox.length === 1 ? "obligation" : "obligations"}) — you owe these:`);
    for (const m of inbox) lines.push(`  ${m.id}  from ${m.from || "-"}  ${m.kind || "message"}  (${m.age_seconds === null ? "unknown age" : m.age_seconds + "s"})`, `    ${m.path}`);
  } else lines.push("\nunsettled inbound: none");
  if (outstanding.length) {
    lines.push(`\nyour outstanding ${outstanding.length === 1 ? "send" : "sends"} (${outstanding.length}) — awaiting someone else's reply:`);
    for (const m of outstanding) lines.push(`  ${m.id}  to ${m.to || "-"}  ${m.kind || "message"}  (${m.age_seconds === null ? "unknown age" : m.age_seconds + "s"})`);
  } else lines.push("\nyour outstanding sends: none");
  if (history.length) {
    lines.push(`\nrecent exchanges (newest first, ${history.length}):`);
    for (const h of history) {
      lines.push(`  ${h.id}  ${h.direction === "sent" ? "->" : "<-"} ${h.peer || "-"}  (${h.age_seconds === null ? "unknown age" : h.age_seconds + "s ago"})`);
      if (h.first_line) lines.push(`    ${h.first_line}`);
      lines.push(`    ${h.path}`);
    }
  }
  lines.push("\ntap recap: this is coordination state only — obligations and traffic.",
    "tap recap: work-state rationale (what you were building and why) lives in beads and PRs, never in this output.");
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}
