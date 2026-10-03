import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { envelopeField, readEnvelopeHeader } from "./envelope";
import { appendRegistryEventOrWarn } from "./events";
import { validToken } from "./ids";
import { isRegularFile, resolveTeamMarkerAwareWithEvidence } from "./index-home";
import { carrierArgs, writeResult } from "./slices/result-pairs";
import { isDict, parseJsonPreserving, pyReadUtf8, pyTruthy } from "./spool-publication";
import { PYTHON_SPACE } from "./terminal-text";

type RecipientState = "match" | "registry_missing" | "team_missing" | "recipient_malformed" | "recipient_mismatch";
const strip = new RegExp(`^[${PYTHON_SPACE}]+|[${PYTHON_SPACE}]+$`, "g");
// Python fullmatch rejects a trailing newline; JavaScript's $ alone does not.
const token = (s: string) => validToken(s) && !/[\r\n]/.test(s);

export function sentinelRecipientState(registry: string, handle: string, recipient: string): RecipientState {
  let team: string;
  try {
    if (!isRegularFile(registry)) return "registry_missing";
    const doc = parseJsonPreserving(pyReadUtf8(registry));
    if (!isDict(doc)) return "registry_missing";
    const group = pyTruthy(doc.team) ? doc.team : {};
    if (!isDict(group)) return "registry_missing";
    const name = pyTruthy(group.name) ? group.name : "";
    if (typeof name !== "string") return "registry_missing";
    team = name.replace(strip, "");
  } catch { return "registry_missing"; }
  if (recipient.includes(":") && !recipient.includes("/")) recipient = recipient.replace(":", "/");
  if (recipient.includes("/")) {
    const parts = recipient.split("/");
    if (parts.length !== 2 || !parts.every(token)) return "recipient_malformed";
    if (!team) return "team_missing";
    return parts[0] === team && parts[1] === handle ? "match" : "recipient_mismatch";
  }
  return !token(recipient) ? "recipient_malformed" : recipient === handle ? "match" : "recipient_mismatch";
}

export interface ExistingSentinelInput {
  wire: "v023" | "pre023";
  id: string;
  idTeam: string;
  recipient: string;
  payloads: string;
  busHome: string;
  registry: string;
  handle: string;
  pane: string;
  actor: string;
  eventLog: string;
  eventTeam: string;
  verb: string;
}

export interface ExistingSentinelResult {
  verdict: "agrees" | "disagrees" | "unavailable";
  bus: string;
  reason?: RecipientState;
}

/**
 * The recipient a stuck sentinel names. A pre-0.23 wire carries `to=`; a v0.23
 * wire re-keys through the payload its id names, whose bus may be another
 * team's. `unavailable` when that payload is absent or names no recipient.
 */
export function sentinelPayloadRecipient(input: Pick<ExistingSentinelInput, "wire" | "id" | "idTeam" | "recipient" | "payloads" | "busHome">):
  { recipient: string; bus: string; unavailable: boolean } {
  let recipient = input.recipient, bus = input.busHome, unavailable = false;
  if (input.wire === "v023") {
    let payload = "";
    if (input.idTeam) {
      const evidence = resolveTeamMarkerAwareWithEvidence(input.idTeam);
      if (evidence.failure || evidence.resolution.status === "invalid") {
        throw new Error(evidence.failure ?? "invalid team lookup");
      }
      const { status, root } = evidence.resolution;
      if (["ok", "unreachable", "historical"].includes(status) && root) {
        payload = join(root, ".tap/bus/payloads", `${input.id}.md`);
      }
    } else payload = join(input.payloads, `${input.id}.md`);
    let regular = false;
    if (payload) {
      try { regular = statSync(payload).isFile(); }
      catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
    if (regular) {
      // The old awk field read also accepted EOF without a closing fence.
      // A terminator preserves those observed fields without changing the parser.
      const header = `${readEnvelopeHeader(payload)}\n---\n`;
      recipient = envelopeField(header, "to") ?? "";
      const team = envelopeField(header, "to_team") ?? "";
      if (team) recipient = `${team}/${recipient}`;
      unavailable = !recipient;
      bus = dirname(dirname(payload));
    } else unavailable = true;
  }
  return { recipient, bus, unavailable };
}

/** Called only after the retained courier's pane guard. Never presses keys. */
export function corroborateExistingSentinel(input: ExistingSentinelInput): ExistingSentinelResult {
  const { recipient, bus, unavailable } = sentinelPayloadRecipient(input);
  // Rowless callers keep their existing session/owner guards and no new
  // registry requirement. They still need the old sentinel's evidence bus.
  if (!input.registry) return { verdict: unavailable ? "unavailable" : "agrees", bus };
  if (unavailable) {
    process.stderr.write(`tap: stuck sentinel id=${input.id} carries no reachable payload -> submitting it uncorroborated (v0.23 wire has no to=; the bus may be unenrolled or the payload already settled)\n`);
    appendRegistryEventOrWarn(input.verb, { log: input.eventLog, actor: input.actor,
      action: "stuck_submit_uncorroborated", handle: input.handle, pane: input.pane,
      team: input.eventTeam, detail: `id=${input.id}` });
    return { verdict: "unavailable", bus };
  }
  const reason = sentinelRecipientState(input.registry, input.handle, recipient);
  if (reason !== "match") {
    process.stderr.write(`tap: stuck sentinel recipient disagrees with bound recipient (${reason})\n`);
    return { verdict: "disagrees", bus, reason };
  }
  return { verdict: "agrees", bus };
}

if (import.meta.main) {
  try {
    const args = carrierArgs(Bun.argv.slice(2), "existing-sentinel: corroborate --result <path> -- <wire> <id> <team> <recipient> <payloads> <bus> <registry> <handle> <pane> <actor> <log> <event-team> <verb>");
    if (!args || args.op !== "corroborate" || args.rest.length !== 13) throw new Error("invalid corroboration arguments");
    const [wire, id, idTeam, recipient, payloads, busHome, registry, handle, pane, actor, eventLog, eventTeam, verb] = args.rest as [string, string, string, string, string, string, string, string, string, string, string, string, string];
    if ((wire !== "v023" && wire !== "pre023") || !token(id) || (idTeam && !token(idTeam)) || !payloads || !busHome) {
      throw new Error("invalid corroboration identity or bus");
    }
    const result = corroborateExistingSentinel({ wire, id, idTeam, recipient, payloads, busHome, registry, handle, pane, actor, eventLog, eventTeam, verb });
    writeResult(args.result, { _SC_RC: result.verdict === "disagrees" ? 6 : 0, _SC_BUS: result.bus });
  } catch (error) {
    process.stderr.write(`tap: stuck sentinel corroboration failed; nothing submitted: ${error}\n`);
    process.exitCode = 1;
  }
}
