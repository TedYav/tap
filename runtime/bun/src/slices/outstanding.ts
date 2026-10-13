import { lockRoot } from "../panelock";
import { retryRecords } from "../retry";
import { readDisplayState } from "../spool-readiness";
import { backlogThresholds, spoolBacklog } from "../spool-backlog";
import { queueExplanation } from "../queue-explanation";
import { unresolvedInjection } from "../submit-phase";
import { unverifiedCanonical } from "../delivery-custody";
import { ensureAscii } from "../fsatomic";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "../context";
import { Bus } from "../bus";
import { envelopeField, validateEnvelope } from "../envelope";
import { ageNowEpoch, idAgeSeconds } from "../ids";
import { forwardingGrant, ambiguousForwarding } from "../forwarding";
import { loadRegistry, seatMap, type RegistryDoc } from "../registry";
import { quarantinePayload } from "../quarantine";

function file(path: string): boolean { try { return statSync(path).isFile(); } catch { return false; } }
function json(path: string): Record<string, any> { try { const v = JSON.parse(readFileSync(path, "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; } }
// The incumbent's legacy cross-worktree heuristic asks Python whether the
// seat VALUE is truthy: an empty seat object is not membership evidence.
function seatPresent(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}
function text(path: string): string { try { return readFileSync(path, "utf8"); } catch { return ""; } }

/**
 * Whether a native tmux read reaches the server a caller's shell would. Bash
 * imports an exported `tmux` function (`BASH_FUNC_tmux%%`, value `() {...`) into
 * every child, lib.sh keeps an existing function rather than defining its own,
 * and `tap_tmux_router_representable` then refuses: that function may route to
 * a server a Bun child cannot name.
 */
export function tmuxRouterRepresentable(env: NodeJS.ProcessEnv = process.env): boolean {
  return !(env["BASH_FUNC_tmux%%"] ?? "").startsWith("() {");
}

/** `tap spool list`'s readiness token for one parked entry; the live pane classifier is the courier's own. */
function displayState(home: string, id: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env, TAP_LOCK_DIR: lockRoot(), TAP_HOME: home };
  const now = env.TAP_SPOOL_NOW ? Number(env.TAP_SPOOL_NOW) : Math.floor(Date.now() / 1000);
  try {
    return readDisplayState(join(home, "spool", `${id}.meta.json`), home, now, env, tmuxRouterRepresentable(env));
  } catch { return ""; }
}

// Python's time.strptime("%Y-%m-%dT%H:%M:%SZ"): case-insensitive, unpadded fields
// allowed, a space-padded day and hour, seconds through 61.
const ISO_STAMP = /^(\d{4})-(1[0-2]|0[1-9]|[1-9])-(3[01]|[12]\d|0[1-9]|[1-9]| [1-9])T(2[0-3]|[01]\d|\d| \d):([0-5]\d|\d):(6[01]|[0-5]\d|\d)Z$/i;

/**
 * Age in seconds of a receipt's own `at` stamp: how long since it was SEEN, not
 * since it was sent (the id's minted time). "" when the stamp is not a real
 * calendar instant; never negative. TAP_SPOOL_NOW pins "now" for fixtures.
 */
export function isoAgeSeconds(at: string, env: NodeJS.ProcessEnv = process.env): string {
  const m = ISO_STAMP.exec(at);
  if (!m) return "";
  const [year, month, day, hour, minute, second] = m.slice(1).map(v => Number(v.trim()));
  // setUTCFullYear, not Date.UTC: the latter reads years 0-99 as 1900-1999.
  const date = new Date(0);
  const midnight = date.setUTCFullYear(year!, month! - 1, day!);
  if (year! < 1 || date.getUTCDate() !== day) return "";
  const pinned = env.TAP_SPOOL_NOW;
  if (pinned && !/^\s*[+-]?\d+\s*$/.test(pinned)) return "";
  const now = pinned ? Number(pinned) : Date.now() / 1000;
  const age = Math.trunc(now - (midnight / 1000 + hour! * 3600 + minute! * 60 + second!));
  return String(age > 0 ? age : 0);
}

/** The shared spool reader: every parked send in a bus, sorted, as id + path.
 * `tap outstanding`'s parked scan and admin's unsettled scan share it — one
 * spool parser, two obligations lenses (tap-ktqz). */
export function spoolEntries(busHome: string): { id: string; path: string }[] {
  const spool = join(busHome, "spool");
  let parked: string[] = [];
  try { parked = readdirSync(spool).filter(n => n.endsWith(".md")).sort(); } catch { /* no spool */ }
  return parked.map(name => ({ id: name.slice(0, -3), path: join(spool, name) }));
}

/** Shared observation body. Callers own argv, bus anchoring and reset fencing.
 * Quarantine and selected-row diagnostics retain their existing effect owners. */
export function outstanding(ctx: Pick<Context, "bus" | "team" | "registryPath">,
  me: string, machine: boolean, stale: string, filterInstances = true): { stdout: string; stderr: string; code: number } {
  let stdout = "", stderr = "";
  const writeOut = (value: string) => { stdout += value; };
  const writeErr = (value: string) => { stderr += value; };
  const spool = join(ctx.bus.home, "spool");
  // One regular-file receipt snapshot; symlinks retain Bash's -f semantics.
  const receipts = new Set(readdirSync(ctx.bus.receiptsDir, { withFileTypes: true })
    .filter(entry => entry.isFile() || (entry.isSymbolicLink() && file(join(ctx.bus.receiptsDir, entry.name))))
    .map(entry => entry.name));
  const settled = (id: string) => receipts.has(`${id}.done`) || receipts.has(`${id}.cancelled`);
  let seats: Record<string, unknown> | undefined;
  let registry: RegistryDoc = {};
  try { if (file(ctx.registryPath)) { registry = loadRegistry(ctx.registryPath); seats = seatMap(registry); } } catch { /* unreadable registry is not membership evidence */ }
  const instanceValue = (seats?.[me] as { instance?: unknown } | undefined)?.instance;
  const instance = typeof instanceValue === "string" ? instanceValue : "";
  // A linked discuss note can make an answer visible without being a tap reply.
  // Observe only canonical notes acknowledged by their addressee, never transport
  // receipts or forced reads; the original obligation stays open.
  const canonicalIds = ctx.bus.canonicalIds();
  let readAnswers: Map<string, Array<{ id: string; raw: string }>> | undefined;
  const answersFor = (parent: string) => {
    if (readAnswers) return readAnswers.get(parent) ?? [];
    readAnswers = new Map();
    for (const id of canonicalIds) {
      if (!receipts.has(`${id}.done`) || receipts.has(`${id}.cancelled`)) continue;
      const raw = text(ctx.bus.payloadPath(id));
      const field = (key: string) => envelopeField(raw, key) ?? "";
      const parent = field("in_reply_to"), done = json(ctx.bus.donePath(id));
      if (!parent || !validateEnvelope(raw).ok || field("id") !== id || field("reply") !== "settle-only"
          || done.id !== id || done.status !== "done" || done.via !== "read" || done.by !== field("to")
          || ["true", "1"].includes(String(done.forced ?? "").toLowerCase()) || done.reason === "instance_retired") continue;
      const answers = readAnswers.get(parent) ?? [];
      answers.push({id, raw}); readAnswers.set(parent, answers);
    }
    return readAnswers.get(parent) ?? [];
  };
  const rows: { item: Record<string, any>; human: string; spool: boolean; held: boolean }[] = [];
  const openIds: string[] = [], nudgeTarget = new Map<string, string>(), ages: number[] = [], targets = new Set<string>();
  let quarantined = 0, degraded = 0;
  const ladder = (id: string) => `Delivery not confirmed. Inspect with tap show ${id}; if it is still unread, tap resend ${id} rings it again under the same id.`;
  const add = (id: string, path: string, parked: boolean) => {
    if (settled(id)) return;
    const raw = text(path);
    // Bash's field reader stops at a closing fence OR EOF. Preserve that
    // legacy observation shape without changing the shared envelope validator.
    const observed = raw.startsWith("---\n") && !raw.split("\n").slice(1).includes("---")
      ? `${raw}\n---\n` : raw;
    const field = (k: string) => envelopeField(observed, k) ?? "";
    const adopted = forwardingGrant(registry, me, field("from"), field("sender_instance"));
    if (field("from") !== me && !adopted) {
      if (!field("sender_instance") && ambiguousForwarding(registry, me, field("from"))) writeErr(`tap outstanding: ambiguous unstamped predecessor mail ${id} from ${field("from")}; inspect tap show ${path}. No sender authority transferred.\n`);
      return;
    }
    if (!adopted && filterInstances && field("sender_instance") && field("sender_instance") !== instance) return;
    if (!parked && (!validateEnvelope(observed).ok || field("id") !== id)) {
      const rc = quarantinePayload(path, validateEnvelope(observed).ok ? "id_mismatch" : "invalid_envelope");
      if (rc === 0) quarantined++; else if (rc !== 1) degraded++;
      return;
    }
    // Outstanding has always accepted custom ids and uses their FIRST timestamp
    // substring. The shared strict age helper still validates calendar values.
    const stamp = id.match(/[0-9]{8}T[0-9]{6}Z/)?.[0];
    const ageId = stamp ? `age-${stamp}-x` : id;
    const age = idAgeSeconds(ageId, ageNowEpoch(), message => { stderr += message.replace(ageId, id); });
    if (age === null && !parked) writeErr(`tap outstanding: warning: could not parse send timestamp from id '${id}' -- including in results\n`);
    if (stale && age !== null && age < Number(stale)) return;
    if (age !== null) ages.push(age);
    const to = field("to"), team = field("to_team"), display = team ? `${team}/${to}` : to;
    let note = team && team !== ctx.team ? " [cross-team: settles on their bus]" : "";
    if (!parked && !team && (field("cross_worktree") === "true" || (seats && !seatPresent(seats[to])))) note = " cross-worktree";
    const item: Record<string, any> = { id, to, kind: field("kind"), path,
      ...(adopted ? { from: field("from"), sender_instance: field("sender_instance"), adopted_from: adopted } : {}) };
    const unconfirmed = !parked && receipts.has(`${id}.placed`) && !receipts.has(`${id}.sent`);
    if (unconfirmed) item.ladder = ladder(id);
    if (!parked && receipts.has(`${id}.sent`)) item.turn = "unconfirmed";
    if (team) { item.to_team = team; if (note.includes("cross-team")) { item.outbound_relay = true; item.addressed_team = team; item.settles_on = "peer_bus"; } }
    else if (note.includes("cross-worktree")) item.cross_worktree = true;
    const reply = field("reply");
    let obligation = !reply || reply === "expected" ? "ask" : reply === "settle-only" ? "note" : `unsanctioned reply:${reply}`;
    let suffix = "", held = false;
    if (parked) {
      if (reply && reply !== "expected") obligation = "note";
      const meta = json(join(spool, `${id}.meta.json`));
      held = meta.policy === "autosettle";
      const reason = meta.reason || (held ? "auto-settle" : "unknown");
      item.status = held ? "spooled-for-digest" : "spooled"; item.reason = reason;
      targets.add(to);
      if (!machine) suffix = `  ${held ? "spooled for digest (auto-settle: no wake; the courier settles it when the doorbell lands)" : `spooled (reason: ${reason})`}. ${ladder(id)} [${displayState(ctx.bus.home, id)}]`;
    } else {
      openIds.push(id);
      nudgeTarget.set(id, display);
      if (receipts.has(`${id}.read`)) {
        const receipt = json(join(ctx.bus.receiptsDir, `${id}.read`));
        const forced = ["true", "1"].includes(String(receipt.forced ?? "").toLowerCase());
        const readAge = receipt.at ? isoAgeSeconds(String(receipt.at)) : "";
        suffix = forced ? `  read by ${receipt.by || "?"} (forced)` : `  read${readAge ? ` ${readAge}s` : ""}`;
        if (obligation === "ask") suffix += ", unanswered";
      }
      if (unconfirmed) suffix += `  [${ladder(id)}]`;
      if (obligation === "note") suffix += "  [recipient-settled note; tap read by the recipient settles it]";
    }
    const orphan = unverifiedCanonical(ctx.bus.home, id);
    const injection = orphan ? null : unresolvedInjection(ctx.bus.home, id);
    if (injection) {
      suffix = "";
      item.phase = "injected-enter-unconfirmed";
    }
    if (orphan) { item.status = "unverified"; item.effect = "possible"; suffix = ""; }
    if (orphan || injection || file(join(spool, `${id}.meta.json`))) {
      item.queue_explanation = injection ?? queueExplanation(ctx.bus.home, id);
      suffix += `  ${item.queue_explanation}`;
    }
    if (!parked && obligation === "ask") {
      const answers = answersFor(id).filter(answer => {
        const other = (key: string) => envelopeField(answer.raw, key) ?? "";
        const direct = other("to") === field("from")
          && (!field("sender_instance") || other("recipient_instance") === field("sender_instance"));
        const forwarded = !!adopted && other("to") === me && other("to_adopted_from") === field("from")
          && other("original_recipient_instance") === field("sender_instance")
          && !!instance && other("recipient_instance") === instance;
        return other("from") === to && (direct || forwarded)
          && (other("from_team") || ctx.team) === (team || ctx.team)
          && (other("to_team") || ctx.team) === (field("from_team") || ctx.team)
          && (!field("recipient_instance") || other("sender_instance") === field("recipient_instance"));
      }).map(answer => answer.id).sort();
      if (answers.length) {
        item.answered_by = answers;
        suffix = suffix.replace(", unanswered", "") + `  answered by ${answers.join(", ")} (unsettled)`;
      }
    }
    if (age !== null) item.age_seconds = age;
    rows.push({ item, human: `${id}  ${display}  ${obligation}  ${age ?? "?"}s${adopted ? ` [outbound from ${adopted}, delegated visibility only]` : ""}${note}${suffix}`, spool: parked, held });
  };
  for (const id of canonicalIds) add(id, ctx.bus.payloadPath(id), false);
  for (const entry of spoolEntries(ctx.bus.home)) {
    if (!file(ctx.bus.payloadPath(entry.id))) add(entry.id, entry.path, true);
  }
  if (quarantined) (machine ? writeErr : writeOut)(`tap outstanding: quarantined ${quarantined} malformed outbound payload(s) to ${ctx.bus.payloadsDir}/.quarantine (bytes preserved; inspect with tap show <id>)\n`);
  if (degraded) writeErr(`tap outstanding: WARNING: ${degraded} malformed payload(s) could not be fully quarantined (moved without a generation mark, or not moved at all) — inspect ${ctx.bus.payloadsDir}/.quarantine and run tap doctor\n`);
  const conditions: Record<string, any>[] = [], collapse = new Set<string>();
  for (const target of targets) {
    try { const c = spoolBacklog(spool, target, me, undefined, ...backlogThresholds()); if (c.condition) { conditions.push(c); collapse.add(target); } } catch { /* best effort diagnostic, as on Bash */ }
  }
  const events = text(join(ctx.bus.home, "registry-events.log"));
  for (const kind of ["redelivery_stopped", "send_unverified"]) for (const id of openIds) {
    // A same-id retry that went unverified stops the same ladder under its own action.
    // A later retry whose recorded outcome is a confirmed submission supersedes an earlier retry's unverified event.
    const retrySettled = kind === "redelivery_stopped" && latestRetryOutcomeConfirmed(ctx.bus.home, id);
    const actions = kind === "redelivery_stopped" ? ["redelivery_submit_unverified", ...(retrySettled ? [] : ["retry_submit_unverified"])] : ["send_submit_unverified"];
    // Event lines are space-separated key=value fields (atom() folds spaces inside a value to `_`),
    // so match whole fields: a substring test lets id X match a longer id XSUFFIX (tap-z63i). The one
    // composite detail the courier writes is disposeGrace's `id=<id> notice_id=<n>`, which atom() folds
    // to `id=<id>_notice_id=<n>`; `_` is legal inside ids, so no other suffix is accepted.
    const detail = `detail=id=${id}`;
    if (!events.split("\n").some(line => line.split(" ").some(f => actions.some(action => f === `action=${action}`)) && line.split(" ").some(f => f === detail || f.startsWith(`${detail}_notice_id=`)))) continue;
    const peer = nudgeTarget.get(id) ?? "<peer>";
    conditions.push({ condition: true, kind, id,
      line: kind === "redelivery_stopped"
        ? `automatic redelivery stopped for ${id} — the courier could not confirm submission and stopped retrying rather than risk a duplicate wake. The payload is canonical and the peer may already have read it: this reports the delivery LADDER giving up, and says nothing either way about whether it was received`
        : `direct send ${id} could not confirm submission — the sentinel may still be sitting unsubmitted in the recipient's input line. The payload is canonical and the peer may already have received it some other way: this reports the SUBMIT going unconfirmed, and says nothing either way about whether it was received`,
      remedy: kind === "redelivery_stopped" ? `tap poll on their side, or tap nudge ${peer}` : `tap nudge ${peer}` });
  }
  const visible = rows.filter(r => !(r.spool && !r.held && collapse.has(r.item.to)));
  if (machine) {
    const out: Record<string, any> = { ok: true, agent: me, outstanding: visible.map(r => r.item) };
    if (conditions.length) out.spool_conditions = conditions;
    writeOut(`${ensureAscii(JSON.stringify(out))}\n`);
  } else if (!rows.length) writeOut(`tap outstanding: no outstanding sends for ${me}\n`);
  else {
    writeOut(`tap outstanding: ${visible.length + conditions.length} outstanding send(s) for ${me}\n`);
    for (const c of conditions) writeOut(`CONDITION: ${c.line}; next: ${c.remedy}\n`);
    for (const r of visible) writeOut(`${r.human}\n`);
    if (openIds.some(id => receipts.has(`${id}.sent`) && json(ctx.bus.sentPath(id)).delivery !== "poll")) writeOut("tap outstanding: turn unconfirmed on injected sends — submitted to pane; recipient seat-side processing unverified. The courier verified the sentinel left the input band, not that a turn began.\n");
    if (stale || ages.some(age => age >= 3600)) writeOut("tap outstanding: a send whose addressee can never settle it (seat gone, or its team retired) is cleared from HERE: tap cancel <id>\n");
  }
  // Open sends are ordinary state, not an error: exit 0 either way (CLI-STANDARDS exit rule).
  return { stdout, stderr, code: 0 };
}

if (import.meta.main) {
  try {
    const [home, team, registryPath, me, machine, stale, filterInstances] = process.argv.slice(2);
    if (!home || team === undefined || registryPath === undefined || !me
      || !["0", "1"].includes(machine!) || stale === undefined
      || !["0", "1"].includes(filterInstances!)) throw new Error("invalid outstanding scan arguments");
    const result = outstanding({ bus: new Bus(home), team, registryPath }, me, machine === "1", stale, filterInstances === "1");
    console.log(JSON.stringify(result));
  } catch (error) { console.error(String(error)); process.exit(1); }
}

/**
 * Whether this id's LATEST requested retry itself confirmed submission (or a harness queue took
 * it). An earlier retry's success never stands in for a later one whose outcome is missing: the
 * courier logs `retry_submit_unverified` before its best-effort outcome append.
 */
function latestRetryOutcomeConfirmed(home: string, id: string): boolean {
  let rows: ReturnType<typeof retryRecords>;
  try { rows = retryRecords(home, id); } catch { return false; }
  const latest = rows.filter(row => row.event === "request").reduce<(typeof rows)[number] | undefined>(
    (best, row) => !best || row.ordinal >= best.ordinal ? row : best, undefined);
  if (!latest) return false;
  const outcome = rows.filter(row => row.retry === latest.retry && row.event === "outcome").at(-1)?.outcome;
  return outcome === "submission-confirmed" || outcome === "harness-queued";
}
