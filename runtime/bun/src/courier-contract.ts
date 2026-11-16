export type DeliveryAction = "repark" | "cancel" | "unconfirmed" | "harness-queued" | "delivered";
export type DeliveryEffect = "none" | "possible";

export type DeliveryResult =
  | { action: "repark"; effect: "none"; cause: "invalid_wire" | "config" | "draft" | "no-band" | "copy-mode" | "lock_busy" | "recovery" | "rate_limited" | "identity_unobservable" | "pane_dead" | "overprint" | "shell-mode" | "feedback-draft"; detail: string }
  | { action: "cancel"; effect: "none"; cause: "pane_gone" | "identity_mismatch"; receipt_reason: "pane_gone"; notice: "failed"; detail: string }
  | { action: "cancel"; effect: "possible"; cause: "pane_gone"; receipt_reason: "pane_gone"; notice: "failed"; detail: string }
  | { action: "unconfirmed"; effect: "possible"; cause: "identity_mismatch" | "identity_unobservable" | "pane_dead" | "rate_limited" | "submit_unverified" | "mid_pipeline_failure" | "overprint" | "shell-mode" | "feedback-draft"; notice: "unconfirmed"; detail: string }
  | { action: "harness-queued"; effect: "possible"; detail: string }
  | { action: "delivered"; effect: "possible"; detail: string };

export type DeliveryPolicy = "standard" | "polite" | "urgent" | "autosettle";
export type DeadlineDisposition = "deliver-anyway" | "notify-and-cancel" | "notify-and-hold";
export type InvalidIntentDisposition = { action: "quarantine"; notice: "failed"; terminal: true };

export interface CourierIntent {
  v: 1;
  id: string;
  from: string;
  to: string;
  to_team: string;
  target_registry: string;
  pane: string;
  pane_id: string;
  server_epoch: string;
  harness: string;
  policy: DeliveryPolicy;
  reason: string;
  first_parked_epoch: number;
  deadline_epoch: number | null;
  hold_until_epoch: number | null;
  disposition_at_deadline: DeadlineDisposition;
  busy_pending_probes: number;
  escalated_at: number | null;
  excluded: boolean;
}

interface AttemptBase {
  [field: string]: unknown;
  v: 1;
  payload_id: string;
  attempt_id: string;
  seq: number;
  rung: number;
  op: "deliver";
  driver: "tmux";
  class: string;
  detail: string;
  native_ref: string;
  ts_start: string;
}

export interface AttemptBeginRow extends AttemptBase {
  phase: "begin";
  disposition: "attempt-begin";
  effect: "possible";
  tier: "none";
  ts_end: null;
}

export interface AttemptOutcomeRow extends AttemptBase {
  phase: "outcome";
  disposition: DeliveryAction;
  effect: DeliveryEffect;
  tier: string;
  ts_end: string;
}

export type AttemptRow = AttemptBeginRow | AttemptOutcomeRow;

export interface OpaqueAttemptRow {
  phase: "opaque";
  raw: string;
  effect: "possible";
  terminated?: false;
}

export type AttemptEvidenceRow = AttemptRow | OpaqueAttemptRow;

export interface AttemptPair {
  attempt_id: string;
  begin: AttemptBeginRow;
  outcome: AttemptOutcomeRow & { effect: "possible" };
}

export interface AttemptJoinResult {
  paired: AttemptPair[];
  pre_begin: Array<AttemptOutcomeRow & { effect: "none" }>;
  unverified: { effect: "possible"; rows: AttemptEvidenceRow[] } | null;
}

export interface QueuedSpoolReceipt {
  status: "queued";
  delivery: "spool";
  action: "deliver_when_clear_or_deadline";
  id: string;
  from: string;
  to: string;
  pane: string;
  kind: string;
  turn: "unconfirmed";
  path: string;
  meta: string;
  reason: string;
  policy: DeliveryPolicy;
  deadline_epoch: number | null;
  spool_backlog: number;
  spool_backlog_condition: boolean;
}

const INTENT_FIELDS = [
  "v", "id", "from", "to", "to_team", "target_registry", "pane", "pane_id",
  "server_epoch", "harness", "policy", "reason", "first_parked_epoch",
  "deadline_epoch", "hold_until_epoch", "disposition_at_deadline",
  "busy_pending_probes", "escalated_at", "excluded",
] as const satisfies readonly (keyof CourierIntent)[];

const ATTEMPT_FIELDS = [
  "v", "payload_id", "attempt_id", "phase", "seq", "rung", "op", "driver",
  "class", "disposition", "effect", "tier", "detail", "native_ref", "ts_start", "ts_end",
] as const satisfies readonly (keyof AttemptRow)[];

const RECEIPT_FIELDS = [
  "status", "delivery", "action", "id", "from", "to", "pane", "kind", "turn",
  "path", "meta", "reason", "policy", "deadline_epoch", "spool_backlog",
  "spool_backlog_condition",
] as const satisfies readonly (keyof QueuedSpoolReceipt)[];

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

function requireFields(value: JsonRecord, fields: readonly string[], label: string): void {
  for (const field of fields) {
    if (!(field in value)) throw new TypeError(`${label} is missing ${field}`);
  }
}

function rejectUnknownFields(value: JsonRecord, fields: readonly string[], label: string): void {
  for (const field of Object.keys(value)) {
    if (!fields.includes(field)) throw new TypeError(`${label} has unknown field ${field}`);
  }
}

function nonempty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${field} must be a safe integer`);
  return value as number;
}

function nullableInteger(value: unknown, field: string): number | null {
  return value === null ? null : integer(value, field);
}

function parseObject(text: string, label: string): JsonRecord {
  return record(JSON.parse(text), label);
}

export function isActionEffectPair(action: DeliveryAction, effect: DeliveryEffect): boolean {
  if (action === "repark") return effect === "none";
  if (action === "cancel") return true;
  return effect === "possible";
}

export function decodeCourierIntent(text: string): CourierIntent {
  const value = parseObject(text, "courier intent");
  requireFields(value, INTENT_FIELDS, "courier intent");
  rejectUnknownFields(value, INTENT_FIELDS, "courier intent");
  if (value.v !== 1) throw new TypeError("courier intent v must be 1");
  for (const field of ["id", "from", "to", "to_team", "target_registry", "pane", "pane_id", "server_epoch", "harness", "reason"] as const) {
    nonempty(value[field], field);
  }
  if (!["standard", "polite", "urgent", "autosettle"].includes(value.policy as string)) throw new TypeError("invalid policy");
  if (!["deliver-anyway", "notify-and-cancel", "notify-and-hold"].includes(value.disposition_at_deadline as string)) throw new TypeError("invalid disposition_at_deadline");
  integer(value.first_parked_epoch, "first_parked_epoch");
  nullableInteger(value.deadline_epoch, "deadline_epoch");
  nullableInteger(value.hold_until_epoch, "hold_until_epoch");
  integer(value.busy_pending_probes, "busy_pending_probes");
  nullableInteger(value.escalated_at, "escalated_at");
  if (typeof value.excluded !== "boolean") throw new TypeError("excluded must be boolean");
  if (value.excluded && (value.disposition_at_deadline !== "notify-and-cancel" || value.escalated_at === null)) {
    throw new TypeError("excluded intent must be an escalated notify-and-cancel");
  }
  return value as unknown as CourierIntent;
}

export function encodeCourierIntent(intent: CourierIntent): string {
  return `${JSON.stringify(intent)}\n`;
}

function decodeAttemptRow(text: string): AttemptRow {
  const value = parseObject(text, "attempt row");
  requireFields(value, ATTEMPT_FIELDS, "attempt row");
  if (value.v !== 1 || value.op !== "deliver" || value.driver !== "tmux") throw new TypeError("invalid attempt row identity");
  for (const field of ["payload_id", "attempt_id"] as const) nonempty(value[field], field);
  for (const field of ["class", "disposition", "effect", "tier", "detail", "native_ref", "ts_start"] as const) {
    if (typeof value[field] !== "string") throw new TypeError(`${field} must be a string`);
  }
  integer(value.seq, "seq");
  integer(value.rung, "rung");
  if (value.phase === "begin") {
    if (value.disposition !== "attempt-begin" || value.effect !== "possible" || value.tier !== "none" || value.ts_end !== null) {
      throw new TypeError("invalid attempt begin row");
    }
  } else if (value.phase === "outcome") {
    if (!["repark", "cancel", "unconfirmed", "harness-queued", "delivered"].includes(value.disposition as string)
      || !["none", "possible"].includes(value.effect as string)
      || !isActionEffectPair(value.disposition as DeliveryAction, value.effect as DeliveryEffect)
      || typeof value.ts_end !== "string") {
      throw new TypeError("invalid attempt outcome row");
    }
  } else {
    throw new TypeError("attempt phase must be begin or outcome");
  }
  return value as unknown as AttemptRow;
}

export function decodeAttemptRows(text: string): AttemptEvidenceRow[] {
  const terminated = text.endsWith("\n");
  const lines = (terminated ? text.slice(0, -1) : text).split("\n");
  return lines.map((raw, index) => {
    if (!terminated && index === lines.length - 1) {
      return { phase: "opaque", raw, effect: "possible", terminated: false };
    }
    try {
      return decodeAttemptRow(raw);
    } catch {
      return { phase: "opaque", raw, effect: "possible" };
    }
  });
}

export function joinAttemptRows(rows: readonly AttemptEvidenceRow[]): AttemptJoinResult {
  const attempts = new Map<string, { begin?: AttemptBeginRow; outcome?: AttemptOutcomeRow }>();
  const unverified: AttemptEvidenceRow[] = [];
  for (const row of rows) {
    if (row.phase === "opaque") {
      unverified.push(row);
      continue;
    }
    const attempt = attempts.get(row.attempt_id) ?? {};
    if (row.phase === "begin") {
      if (attempt.begin) throw new TypeError(`duplicate attempt begin ${row.attempt_id}`);
      attempt.begin = row;
    } else {
      if (attempt.outcome) throw new TypeError(`duplicate attempt outcome ${row.attempt_id}`);
      attempt.outcome = row;
    }
    attempts.set(row.attempt_id, attempt);
  }

  const paired: AttemptPair[] = [];
  const pre_begin: Array<AttemptOutcomeRow & { effect: "none" }> = [];
  for (const [attempt_id, attempt] of attempts) {
    if (attempt.begin && attempt.outcome) {
      if (attempt.begin.payload_id !== attempt.outcome.payload_id) {
        unverified.push(attempt.begin, attempt.outcome);
        continue;
      }
      if (attempt.outcome.effect === "none") {
        throw new TypeError(`effect-none outcome ${attempt_id} cannot follow a matching begin`);
      }
      paired.push({ attempt_id, begin: attempt.begin, outcome: attempt.outcome as AttemptOutcomeRow & { effect: "possible" } });
    } else if (attempt.begin) {
      unverified.push(attempt.begin);
    } else if (attempt.outcome?.effect === "none") {
      pre_begin.push(attempt.outcome as AttemptOutcomeRow & { effect: "none" });
    } else if (attempt.outcome) {
      unverified.push(attempt.outcome);
    }
  }

  return {
    paired,
    pre_begin,
    unverified: unverified.length ? { effect: "possible", rows: unverified } : null,
  };
}

export function encodeAttemptRows(rows: readonly AttemptEvidenceRow[]): string {
  const text = rows.map((row) => row.phase === "opaque" ? row.raw : JSON.stringify(row)).join("\n");
  const last = rows[rows.length - 1];
  return last?.phase === "opaque" && last.terminated === false ? text : `${text}\n`;
}

export function decodeQueuedSpoolReceipt(text: string): QueuedSpoolReceipt {
  const value = parseObject(text, "queued spool receipt");
  requireFields(value, RECEIPT_FIELDS, "queued spool receipt");
  rejectUnknownFields(value, RECEIPT_FIELDS, "queued spool receipt");
  if (value.status !== "queued" || value.delivery !== "spool" || value.action !== "deliver_when_clear_or_deadline" || value.turn !== "unconfirmed") {
    throw new TypeError("invalid queued spool receipt disposition");
  }
  for (const field of ["id", "from", "to", "pane", "kind", "path", "meta", "reason"] as const) nonempty(value[field], field);
  if (!(value.path as string).includes("/payloads/") || !(value.meta as string).includes("/spool/")) {
    throw new TypeError("queued spool receipt must name canonical payload and intent paths");
  }
  if (!["standard", "polite", "urgent", "autosettle"].includes(value.policy as string)) throw new TypeError("invalid policy");
  nullableInteger(value.deadline_epoch, "deadline_epoch");
  integer(value.spool_backlog, "spool_backlog");
  if (typeof value.spool_backlog_condition !== "boolean") throw new TypeError("spool_backlog_condition must be boolean");
  return value as unknown as QueuedSpoolReceipt;
}

export function encodeQueuedSpoolReceipt(receipt: QueuedSpoolReceipt): string {
  return `${JSON.stringify(receipt)}\n`;
}
