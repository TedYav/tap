// `tap poll [me]` — list unprocessed payloads addressed to me.
//
// unprocessed = a payload whose envelope `to` is me and which has no `.done`.
// Exit 0 whether or not anything is listed: pending mail is ordinary state, not
// an error (CLI-STANDARDS exit rule). A caller branches on "do I owe anything"
// with --json `pending`. Non-zero means a usage error or an unreadable inbox.
//
// TWO RULES THAT LOOK LIKE EDGE CASES AND ARE NOT:
//   - a MALFORMED payload is quarantined once and never changes the
//     exit status. One bad canonical must not starve its valid siblings.
//   - an UNATTRIBUTED payload (no .placed, no legacy .sent) is LISTED and
//     labelled, never hidden. Hiding mail is the one thing a transport may not do.

import { existsSync, readFileSync, readdirSync } from "node:fs";

import { join } from "node:path";
import { spoolAuthorized } from "../payload-view";
import { addresseeGrant, historyDirForBus } from "../addressee-grant";
import { inboxRows, type InboxFacts } from "../slices/inbox-view";
import { TapError, observeCallingPane, refuseUnanchoredPane, requireActingRegistry } from "../context";
import { envelopeField, validateEnvelope } from "../envelope";
import { ageNowEpoch, idAgeSeconds } from "../ids";
import { quarantinePayload } from "../quarantine";
import { loadRegistry } from "../registry";
import { ambiguousForwarding, forwardings } from "../forwarding";
import { enrolledTeams, busHomeForRegistry } from "../index-home";
import { Bus } from "../bus";
import { queueExplanation } from "../queue-explanation";
import { applyTeamOverride } from "../team-override";
import { resolveSelection } from "../team-selection";
import { ensureAscii } from "../fsatomic";
import { assertResetUnfenced } from "../reset";
import { exchangeSelf } from "../exchange-self";

export function cmdPoll(argv: string[]): number {
  let me = process.env.TAP_SELF || "";
  let quiet = false;
  let json = false;
  let team = "";
  let positionalSeen = false;
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
      if (a === "--quiet") quiet = true;
      else if (a === "--team") {
        team = argv[++i] ?? "";
        if (!team) throw new TapError(1, "usage_error", "tap help poll", "--team needs a value");
      }
      else if (a === "--json") json = true;
      else if (a.startsWith("--")) throw new TapError(1, "unknown_option", "tap help poll", `unknown option '${a}'`);
      else {
        if (positionalSeen) {
          throw new TapError(1, "usage_error", "tap help poll", "usage: tap poll [me] [--json] [--quiet] [--team <name>]");
        }
        me = a;
        positionalSeen = true;
      }
    }

    // Caller pin > --team > cwd walk, in ONE place for both gates (rule 56:
    // the identical source edit at a second gate is not a control for it).
    // Read the pin BEFORE the override, which sets TAP_HOME itself.
    const callerPin = process.env.TAP_HOME ?? "";
    let ctx: ReturnType<typeof resolveSelection>;
    try {
      applyTeamOverride(team);
      ctx = resolveSelection(callerPin, team);
      // Canonical layout can resolve an explicit pin with a default/dotdir
      // rule. The original pin still grounds it; selector refusals came first.
      if (!callerPin && ctx.busRule !== "env") requireActingRegistry(ctx, 4);
    } catch (error) {
      if (team || !(error instanceof TapError) || error.errorClass !== "unanchored_bus") throw error;
      const seen = observeCallingPane();
      if (seen.state === "inside") {
        refuseUnanchoredPane(seen.paneId, process.cwd(), 4,
          { session: seen.session, serverEpoch: seen.serverEpoch }, process.env, seen.paneId, true);
      }
      // Only a positively identified missing stamp licenses typed recovery.
      // Other failed observations must never become a bare-pane lookup.
      if (seen.state === "unobservable" && seen.paneId && seen.missing) {
        refuseUnanchoredPane(seen.paneId, process.cwd(), 4,
          { session: seen.missing === "epoch" ? seen.session ?? "" : "", serverEpoch: "" },
          process.env, seen.paneId, true);
      }
      const reason = seen.state === "outside" ? seen.detail : seen.refusal || "observation reason unavailable";
      throw new TapError(4, "unanchored_bus", "pass --team <team>  OR  set TAP_HOME to the bus directory",
        `cwd-derived bus has no acting registry and the caller pane is not observable (${reason})`);
    }
    assertResetUnfenced(ctx.bus.home, "tap poll");
    if (!me) me = exchangeSelf(ctx, "poll");
    ctx.bus.ensureDirs();

    let quarantined = 0;
    let degraded = 0;
    const quarantine = (path: string, reason: "invalid_envelope" | "id_mismatch") => {
      const rc = quarantinePayload(path, reason);
      if (rc === 0) quarantined++;
      else if (rc !== 1) degraded++;
    };
    const nowEpoch = ageNowEpoch();
    const facts: InboxFacts[] = [];
    let found = false;
    const registry = loadRegistry(ctx.registryPath);
    const grantContext = { registryPath: ctx.registryPath, marker: ctx.marker, team: ctx.team,
      historyDir: historyDirForBus(ctx.bus.home) };
    const canonical = ctx.bus.canonicalIds();
    const spool = join(ctx.bus.home, "spool");
    let parked: string[] = [];
    try { parked = readdirSync(spool).filter(n => !n.startsWith("_") && n.endsWith(".md")).map(n => n.slice(0, -3)).sort(); } catch { /* no spool */ }
    const sources = [...canonical.map(id => ({ id, parked: false, bus: ctx.bus, foreign: false })),
      ...parked.filter(id => !existsSync(ctx.bus.payloadPath(id))).map(id => ({ id, parked: true, bus: ctx.bus, foreign: false }))];
    if (forwardings(registry).length) for (const team of enrolledTeams()) {
      if (team.team === ctx.team) continue;
      const home = busHomeForRegistry(team.registryLocation);
      if (!home || home === ctx.bus.home) continue;
      const bus = new Bus(home);
      try {
        const ids = bus.canonicalIds();
        for (const id of ids) sources.push({ id, parked: false, bus, foreign: true });
        for (const name of readdirSync(join(home, "spool"))) {
          if (!name.endsWith(".md") || name.startsWith("_")) continue;
          const id = name.slice(0, -3);
          if (!existsSync(bus.payloadPath(id))) sources.push({ id, parked: true, bus, foreign: true });
        }
      } catch { /* absent foreign directories */ }
    }
    for (const source of sources) {
      const { id } = source;
      const bus = source.bus;
      if (bus.isDone(id)) continue;
      const path = source.parked ? join(bus.home, "spool", `${id}.md`) : bus.payloadPath(id);
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch {
        process.stderr.write(`tap poll: warning: skipping unreadable payload: ${path}\n`);
        continue;
      }
      // Validate BEFORE the routing filter, so an unreadable `to` cannot make a
      // corrupt canonical disappear silently.
      if (!validateEnvelope(raw).ok) {
        if (source.parked) process.stderr.write(`tap poll: warning: skipping invalid parked envelope: ${path}\n`);
        else if (!source.foreign) quarantine(path, "invalid_envelope");
        continue;
      }
      if (envelopeField(raw, "id") !== id) {
        if (source.parked) process.stderr.write(`tap poll: warning: skipping parked id mismatch: ${path}\n`);
        else if (!source.foreign) quarantine(path, "id_mismatch");
        continue;
      }
      const target = envelopeField(raw, "to") || "";
      const bound = envelopeField(raw, "recipient_instance") || "";
      const toTeam = envelopeField(raw, "to_team");
      if (toTeam && toTeam !== ctx.team) continue;
      // Shared grants permit unqualified local mail; foreign residency still
      // requires an explicit destination team before any matching-handle grant.
      if (source.foreign && toTeam !== ctx.team) continue;
      // Custody follows the selected recipient team, including when these
      // bytes remain on an enrolled sender bus. Use read's existing grant.
      const grant = addresseeGrant({ ...grantContext, id, from: envelopeField(raw, "from") || "",
        actor: me, to: target, adoptedFrom: envelopeField(raw, "to_adopted_from") || "", recipientInstance: bound });
      if (!grant.ok) {
        if (!bound && ambiguousForwarding(registry, me, target)) process.stderr.write(`tap poll: ambiguous unstamped predecessor mail ${id} to ${target}; inspect tap show ${path}. No read/reply authority transferred.\n`);
        continue;
      }
      const adopted = grant.grant;
      let queue: { reason: string; first: string; explanation: string } | undefined;
      if (source.parked) {
        try {
          const meta = JSON.parse(readFileSync(join(bus.home, "spool", `${id}.meta.json`), "utf8"));
          if (meta.target !== target) continue;
          if (!spoolAuthorized(path, me, grantContext)) continue;
          queue = { reason: String(meta.reason || ""), first: String(meta.first_spooled_epoch || ""), explanation: queueExplanation(bus.home, id) };
        } catch { continue; }
      }
      found = true;
      const envelope: Record<string, string> = { id, path, ...(adopted ? { adopted_from: adopted } : {}), ...(source.foreign ? { foreign_bus: bus.home, address: "path=" + path } : {}) };
      for (const key of ["from", "kind", "reply", "epoch", "from_team", "reply_to"]) envelope[key] = envelopeField(raw, key) ?? "";
      facts.push({ envelope, residency: source.parked ? "parked" : "canonical",
        attributed: bus.isCourierAttributed(id),
        unconfirmed: existsSync(bus.placedPath(id)) && !existsSync(bus.sentPath(id)),
        age: idAgeSeconds(id, nowEpoch), reason: queue?.reason,
        firstSpooledEpoch: Number(queue?.first || 0), queueExplanation: queue?.explanation });
    }
    const rows = inboxRows({ me, rows: facts });
    if (!json && rows.length) {
      process.stdout.write(`tap poll: inbox for ${ctx.team}/${me} (${forwardings(registry).length ? "includes explicit delegated custody on enrolled sender buses" : "this team only; cross-team obligations live on the sender bus, see tap outstanding"}):\n`);
      for (const row of rows) { process.stdout.write(row.human); process.stderr.write(row.warnings); }
    }

    if (quarantined) {
      const notice = `tap poll: quarantined ${quarantined} malformed payload(s) to ${ctx.bus.payloadsDir}/.quarantine (bytes preserved; inspect with tap show <id>)\n`;
      (quiet || json ? process.stderr : process.stdout).write(notice);
    }
    if (degraded) process.stderr.write(`tap poll: WARNING: ${degraded} malformed payload(s) could not be fully quarantined (moved without a generation mark, or not moved at all) — inspect ${ctx.bus.payloadsDir}/.quarantine and run tap doctor\n`);
    if (json) {
      process.stdout.write(`${ensureAscii(JSON.stringify({ ok: true, agent: me, pending: rows.map(row => row.item), ...(ctx.team ? { team: ctx.team } : {}) }))}\n`);
      return 0;
    }
    if (!quiet && !found) process.stdout.write("tap poll: empty\n");
    return 0;
  } catch (error) {
    if (!json || !(error instanceof TapError)) throw error;
    process.stdout.write(`${ensureAscii(JSON.stringify({ ok: false, error_class: error.errorClass,
      action: error.action, ...(error.detail ? { detail: error.detail } : {}) }))}\n`);
    return error.code;
  }
}
