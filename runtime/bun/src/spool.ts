import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  decodeCourierIntent,
  decodeQueuedSpoolReceipt,
  encodeCourierIntent,
  encodeQueuedSpoolReceipt,
  type CourierIntent,
  type DeadlineDisposition,
  type DeliveryPolicy,
  type QueuedSpoolReceipt,
} from "./courier-contract";
import { atomicWrite } from "./fsatomic";
import { acquireObligationLock } from "./panelock";

// Native-intent storage and public inspection. Production delivery uses spool-park.ts
// and the shared Bash pair/drain path. No native owner or automatic conversion exists.

/**
 * Park refusal shapes. R16: an unbindable target is refused, never parked.
 * U3.3: a slot occupied by an undecodable intent refuses `malformed_intent`
 * — corrupt mail is evidence, never an overwrite target.
 */
export type ParkRefusal =
  | { ok: false; error_class: "unbound_target"; detail: string }
  | { ok: false; error_class: "spooled_id"; detail: string }
  | { ok: false; error_class: "malformed_intent"; detail: string }
  | { ok: false; error_class: "obligation_busy"; detail: string };

export type ParkResult = { ok: true; receipt: QueuedSpoolReceipt } | ParkRefusal;

export interface ParkInput {
  /** Sender bus spool dir (`$TAP_HOME/spool`). */
  spoolDir: string;
  /** Canonical payloads dir on the same bus; only read for the receipt path. */
  payloadsDir: string;
  id: string;
  from: string;
  to: string;
  toTeam: string;
  /** Registry path stamped onto the intent; not re-read here. */
  targetRegistry: string;
  pane: string;
  paneId: string;
  serverEpoch: string;
  harness: string;
  policy: DeliveryPolicy;
  reason: string;
  kind: string;
  firstParkEpoch: number;
  holdUntilEpoch: number | null;
  deadlineEpoch: number | null;
  /** Isolated lock env for tests; production uses process.env. */
  env?: NodeJS.ProcessEnv;
  /** Kernel-lock wait for the obligation lock. Tests use 0 so a holder refuses immediately. */
  lockTimeoutMs?: number;
}

/**
 * R13: the deadline disposition is MINTED at park time from policy + reason
 * through this one table and is never re-derived later. The owner applies it;
 * classification at delivery time cannot change it.
 *
 *  - `notify-and-hold` — copy-mode safety gate: the gate protects the
 *    copy-mode STATE, not the message; deliver on ready after the one-shot
 *    notice (ledger K1).
 *  - `deliver-anyway` — draft grace and the polite timeout: the deadline
 *    means the pane owes a delivery, not a notice.
 *  - `notify-and-cancel` — readiness-gate parks and the autosettle busy
 *    tail: the deadline terminates the attempt honestly.
 *
 * Unknown reasons map to `notify-and-cancel`: a deadline nobody classified
 * must not silently re-deliver into a pane that was never offered mail.
 */
const DISPOSITION_TABLE: Record<string, DeadlineDisposition> = {
  "copy-mode": "notify-and-hold",
  "pending-input": "deliver-anyway",
  "clearing-fence": "deliver-anyway",
  busy: "notify-and-cancel",
  "auto-settle": "notify-and-cancel",
  "no-prompt": "notify-and-cancel",
  // tap-7r3fn.20: a WINDOW park is a rate limit the courier itself applied to a
  // pane that was READY. Nothing failed, so it must deliver at its deadline
  // rather than tell the sender it never arrived. Without this row the `??`
  // below answers notify-and-cancel for it -- the Bash side is careful to mint
  // no `deadline_source` for exactly that reason, and the fallback would undo
  // that care on the first native verb to touch the entry.
  window: "deliver-anyway",
};

export function dispositionAtDeadline(policy: DeliveryPolicy, reason: string): DeadlineDisposition {
  // The polite timeout is a POLICY deadline, not a readiness verdict.
  if (policy === "polite") return "deliver-anyway";
  return DISPOSITION_TABLE[reason] ?? "notify-and-cancel";
}

/**
 * Queue-side R16: refuse an incomplete stamp before any file exists.
 * The flip owns authorize-before-place and exact observation; this function
 * does not re-read the registry or re-authorize the pane.
 */
function requireStampedBinding(input: ParkInput): { ok: true } | { ok: false; detail: string } {
  if (!input.toTeam) return { ok: false, detail: "stamped to_team is empty; refusing unbound_target" };
  if (!input.pane) return { ok: false, detail: "stamped pane is empty; refusing unbound_target" };
  if (!input.paneId) return { ok: false, detail: "stamped pane_id is empty; refusing unbound_target" };
  if (!input.targetRegistry) return { ok: false, detail: "stamped target_registry is empty; refusing unbound_target" };
  return { ok: true };
}

function intentPath(spoolDir: string, id: string): string {
  return join(spoolDir, `${id}.json`);
}

/**
 * Single-read primitive (pre-freeze anchor 2 of the second correction set):
 * read ONCE, decode ONCE, validate the slot against THAT decoded record.
 * A concurrent cancel or removal between two reads must not throw — any
 * read or decode failure is "not live", never an error. This seam is what
 * U3.3's quarantine reuses: the catch is where a malformed record will be
 * classified rather than dropped.
 */
function readIntentIfLive(spoolDir: string, name: string): CourierIntent | null {
  // Positive identification through the authority decoder, not a reserved-name
  // blacklist: the incumbent spool carries diagnostic records the zoo of which
  // no list enumerates (`owner.json`, legacy `<id>.meta.json` park metadata,
  // later quarantined `<id>.json.malformed`). A file is live mail IFF it
  // decodes as a closed-set intent AND its name is exactly that intent's slot
  // (`<id>.json`) — anything else is a diagnostic, a legacy shape, or a
  // misplaced record, none of which the K5 backlog denominator counts. A legal
  // id containing `.meta` is NOT rejected by name: if the bytes are a valid
  // intent and the slot matches, it IS live mail.
  if (!name.endsWith(".json")) return null;
  try {
    const intent = decodeCourierIntent(readFileSync(join(spoolDir, name), "utf8"));
    return `${intent.id}.json` === name ? intent : null;
  } catch {
    return null;
  }
}

/**
 * The live intents in a spool dir, oldest-park-first (stable readdir order is
 * not a promise this caller should lean on, and `list` output order is
 * reader-visible). Positive identification only — same rule as the backlog
 * denominator: decodes as a closed-set intent AND sits in its own
 * `<id>.json` slot. Diagnostics, legacy meta records, quarantines, and
 * misplaced intents are not live mail.
 */
export function listLiveIntents(spoolDir: string): CourierIntent[] {
  let names: string[];
  try {
    names = readdirSync(spoolDir);
  } catch {
    return [];
  }
  const intents: CourierIntent[] = [];
  for (const name of names) {
    const intent = readIntentIfLive(spoolDir, name);
    if (intent) intents.push(intent);
  }
  intents.sort((a, b) => a.first_parked_epoch - b.first_parked_epoch);
  return intents;
}

/** A malformed-mail report row: never a CourierIntent, always discriminated. */
export interface MalformedReportRow {
  id: string;
  class: "malformed_intent" | "quarantined_malformed_intent";
}

/**
 * U3.3 reporter (frozen brief v3): raw malformed candidacy is POSITIVE through
 * canonical correlation — a root `<id>.json` that fails authority decode or
 * id-slot agreement is corrupt MAIL only when its canonical
 * `payloads/<id>.md` exists; filename syntax alone never classifies, so
 * `owner.json`, legacy `<id>.meta.json`, and arbitrary diagnostics (no
 * matching canonical) are never malformed rows, and no reserved-name
 * blacklist exists. A legal id ending in `.meta` DOES report when its
 * canonical exists, except when that `.json` is the sidecar of a live
 * bash pair (`X.md` + `X.meta.json`): then `X.meta` is not a native slot.
 * Quarantined `<id>.json.malformed` evidence reports
 * INDEPENDENTLY of canonical presence, so it stays visible after any later
 * canonical movement. Report-only: this scan never renames, marks, or locks.
 */
export function listMalformedReport(spoolDir: string, payloadsDir: string): MalformedReportRow[] {
  let names: string[];
  try {
    names = readdirSync(spoolDir);
  } catch {
    return [];
  }
  const rows: MalformedReportRow[] = [];
  for (const name of names) {
    if (name.endsWith(".json.malformed")) {
      rows.push({ id: name.slice(0, -".json.malformed".length), class: "quarantined_malformed_intent" });
      continue;
    }
    if (!name.endsWith(".json")) continue;
    if (readIntentIfLive(spoolDir, name)) continue;
    const id = name.slice(0, -".json".length);
    if (isLiveBashPairSidecar(spoolDir, payloadsDir, id)) continue;
    if (existsSync(join(payloadsDir, `${id}.md`))) {
      rows.push({ id, class: "malformed_intent" });
    }
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  return rows;
}

/**
 * U3.4: the ONE unsettled-intent denominator, shared by park's queued
 * receipts and the list/status readers. A live intent that already holds a
 * durable `.done` or `.cancelled` is not backlog — including the crash-window
 * shape where the receipt outlived the intent file. `receiptsDir` is the
 * spool dir's sibling under the bus layout (CONTRACT §Bus layout: one bus
 * home owns payloads/, spool/, receipts/); an absent receipts dir (a fresh
 * fixture) simply terminalizes nothing.
 */
export function unsettledLiveIntents(spoolDir: string, receiptsDir: string): CourierIntent[] {
  return listLiveIntents(spoolDir).filter((intent) => {
    return !existsSync(join(receiptsDir, `${intent.id}.done`)) && !existsSync(join(receiptsDir, `${intent.id}.cancelled`));
  });
}

/** True when `<id>.json` occupies the exact slot but is not a live intent. */
export function isMalformedExactSlot(spoolDir: string, payloadsDir: string, id: string): boolean {
  if (isLiveBashPairSidecar(spoolDir, payloadsDir, id)) return false;
  const name = `${id}.json`;
  if (!existsSync(join(spoolDir, name))) return false;
  return readIntentIfLive(spoolDir, name) === null;
}

export function park(input: ParkInput): ParkResult {
  const binding = requireStampedBinding(input);
  if (!binding.ok) {
    return { ok: false, error_class: "unbound_target", detail: binding.detail };
  }
  const lock = acquireObligationLock(input.id, input.lockTimeoutMs ?? 5000, input.env ?? process.env);
  if (!lock) {
    return { ok: false, error_class: "obligation_busy", detail: `obligation '${input.id}' is busy; refusing to park without exclusive eligibility` };
  }
  try {
    return parkUnderLock(input);
  } finally {
    lock.release();
  }
}

function parkUnderLock(input: ParkInput): ParkResult {
  const receiptsDir = join(dirname(input.spoolDir), "receipts");
  if (existsSync(join(receiptsDir, `${input.id}.done`))) {
    return { ok: false, error_class: "spooled_id", detail: `id '${input.id}' is already settled` };
  }
  if (existsSync(join(receiptsDir, `${input.id}.cancelled`))) {
    return { ok: false, error_class: "spooled_id", detail: `id '${input.id}' is already cancelled` };
  }
  // Refuse a re-park of a live id before writing anything: the spool id is the
  // obligation's address while parked, and a second intent for one id would be
  // two deliveries behind one receipt set (the bash `spooled_id` refusal).
  // A slot that exists but is NOT a live intent is corrupt mail, not a
  // collision — the DISTINCT refusal (U3.3) names it and never mutates it:
  // evidence is preserved for the cancel-side quarantine path.
  if (existsSync(intentPath(input.spoolDir, input.id))) {
    if (isMalformedExactSlot(input.spoolDir, input.payloadsDir, input.id)) {
      return { ok: false, error_class: "malformed_intent", detail: `id '${input.id}' occupies its slot with an undecodable intent; refusing to overwrite evidence` };
    }
    return { ok: false, error_class: "spooled_id", detail: `id '${input.id}' is already parked` };
  }
  const intent: CourierIntent = {
    v: 1,
    id: input.id,
    from: input.from,
    to: input.to,
    to_team: input.toTeam,
    target_registry: input.targetRegistry,
    pane: input.pane,
    pane_id: input.paneId,
    server_epoch: input.serverEpoch,
    harness: input.harness,
    policy: input.policy,
    reason: input.reason,
    first_parked_epoch: input.firstParkEpoch,
    deadline_epoch: input.deadlineEpoch,
    hold_until_epoch: input.holdUntilEpoch,
    disposition_at_deadline: dispositionAtDeadline(input.policy, input.reason),
    busy_pending_probes: 0,
    escalated_at: null,
    excluded: false,
  };
  // Closed-set bytes through the cross-lane codec, temp+rename so a reader
  // never observes a torn intent (KTD2). The codec owns the exact byte shape
  // — including its single trailing newline — so its output is written
  // verbatim; nothing here may add or trim a byte of the authority form.
  atomicWrite(intentPath(input.spoolDir, input.id), encodeCourierIntent(intent));
  const receipt: QueuedSpoolReceipt = {
    status: "queued",
    delivery: "spool",
    action: "deliver_when_clear_or_deadline",
    id: input.id,
    from: input.from,
    to: input.to,
    pane: input.pane,
    kind: input.kind,
    turn: "unconfirmed",
    path: join(input.payloadsDir, `${input.id}.md`),
    meta: intentPath(input.spoolDir, input.id),
    reason: input.reason,
    policy: input.policy,
    deadline_epoch: input.deadlineEpoch,
    // The backlog CONDITION is an owner/doctor aggregate over live intents
    // (ledger K5) and stays false at park time until U6 maintains it; the
    // COUNT is knowable now and reported honestly.
    // The SAME unsettled denominator the readers use (U3.4): a parked
    // receipt must never count mail that is already terminal.
    // The SAME unsettled denominator the readers use (U3.4): a parked
    // receipt must never count mail that is already terminal.
    spool_backlog: unsettledLiveIntents(input.spoolDir, join(dirname(input.spoolDir), "receipts")).length,
    spool_backlog_condition: false,
  };
  // Shape-drift guard: round-trip the receipt through the contract codec so a
  // field this module forgets or mis-spells fails HERE, at the write, rather
  // than at the first reader.
  decodeQueuedSpoolReceipt(encodeQueuedSpoolReceipt(receipt));
  return { ok: true, receipt };
}

/**
 * Read-only root census of live bash parks. A pair is both `spool/<id>.md`
 * and `spool/<id>.meta.json` at the spool root — no parsing, no mutation,
 * no walk of `spool/legacy/`. Public verbs use this to notice bash parks
 * without taking custody.
 */
export function isLegacyBashPair(spoolDir: string, id: string): boolean {
  return existsSync(join(spoolDir, `${id}.md`)) && existsSync(join(spoolDir, `${id}.meta.json`));
}

/**
 * Candidate native id `X.meta` names bash-owned metadata, not a native slot,
 * when either the live pair `X.md`+`X.meta.json` is present or the claim-held
 * body-moved crossing is: `X.meta.json` + `X.claim` + canonical `payloads/X.md`.
 * Presence only — no claim freshness or reaping. Do not blacklist every
 * `.meta` id: a legal native `X.meta` still uses its own slot when bash does
 * not own X.
 */
export function isLiveBashPairSidecar(spoolDir: string, payloadsDir: string, id: string): boolean {
  if (!id.endsWith(".meta") || id === ".meta") return false;
  const owner = id.slice(0, -".meta".length);
  if (isLegacyBashPair(spoolDir, owner)) return true;
  return (
    existsSync(join(spoolDir, `${owner}.meta.json`)) &&
    existsSync(join(spoolDir, `${owner}.claim`)) &&
    existsSync(join(payloadsDir, `${owner}.md`))
  );
}

export function listLegacyBashPairIds(spoolDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(spoolDir);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".md") || name === ".md") continue;
    const id = name.slice(0, -".md".length);
    if (existsSync(join(spoolDir, `${id}.meta.json`))) ids.push(id);
  }
  return ids.sort();
}
