import { readFileSync } from "node:fs";
import { ensureAscii } from "./fsatomic";
import { shellQuote } from "./shell-quote";

/** Labelled refusal for a successor whose stdout parsed as JSON but not as an object. */
export class ResendReceiptError extends Error {
  readonly errorClass = "resend_receipt_invalid";
}

/** Facts a failed successor leaves behind; described to the operator, never acted on. */
export interface ResendRecovery { original: string; receipt: string; prepared: string; successor: string; next: string }

/** The bus the inspection must name: a pinned bus wins over --team, and neither survives the command. */
export interface ResendAnchor { team?: string; pin?: string }

/** The command that inspects the successor, anchored to the bus actually selected (a pin is command-scoped). */
export function inspectCommand(newId: string, { team = "", pin = "" }: ResendAnchor = {}): string {
  if (pin) return `TAP_HOME=${shellQuote(pin)} tap show ${newId}`;
  return `tap show ${team ? `${team}/` : ""}${newId}`;
}

/**
 * What a nonzero successor exit leaves behind. The next step is always INSPECTION, never a
 * send: exit 5 means the successor may have taken effect, and a signalled child (status 1)
 * does not prove the successor absent, so a blind `tap send` could deliver it twice. The
 * prepared envelope also is not a body (`-f` would deliver its frontmatter as text and drop
 * resend_of). The text describes; nothing retries or re-sends.
 */
export function resendRecovery(id: string, newId: string, code: number, anchor: ResendAnchor = {}): { detail: string; facts: ResendRecovery } {
  const facts: ResendRecovery = { original: id, receipt: `receipts/${id}.resent`, prepared: `archive/${newId}.resend.md`, successor: newId, next: inspectCommand(newId, anchor) };
  const detail = `${code === 0 ? "the successor send exited 0 without a usable receipt" : `the successor send failed (exit ${code})`}; original ${id} is already withdrawn (${facts.receipt}) and will not be re-sent automatically; `
    + `the prepared successor ${facts.prepared} is kept as evidence and the successor may or may not have taken effect: inspect it before doing anything else`;
  return { detail, facts };
}

/** A failed successor as the one error: the standard envelope fields, the carried receipt fields, the recovery facts. */
export interface ResendFailureView { errorClass: string; action: string; detail: string; body: Record<string, unknown> }

const CAUSE_CAP = 400;
function flatten(text: string): string {
  const flat = text.split(/\r\n|\r|\n/).map(line => line.trim()).filter(Boolean).join(" / ");
  return flat.length > CAUSE_CAP ? `${flat.slice(0, CAUSE_CAP)}...` : flat;
}

/**
 * Fold a failed successor into one cause + one recovery. `invalid` is the receipt refusal when the
 * successor exited 0 but its stdout parsed as JSON and not as an object; `crash` is how the child
 * died when it left no receipt of its own (a signal or a spawn error). A receipt object from a failed successor keeps its
 * own fields beside the standard ones, except the four the envelope owns.
 */
export function describeResendFailure(output: Uint8Array, stderr: Uint8Array, code: number, id: string, newId: string,
  anchor: ResendAnchor = {}, invalid?: ResendReceiptError, crash = ""): ResendFailureView {
  const { detail: recoveryText, facts } = resendRecovery(id, newId, code, anchor);
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output)); } catch { parsed = undefined; }
  const object = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  const causes: string[] = [];
  if (invalid) causes.push(invalid.message);
  else if (object) {
    const named = [object.error_class, object.detail ?? object.error].filter((v): v is string => typeof v === "string" && v !== "");
    if (named.length) causes.push(flatten(named.join(": ")));
    else if (typeof object.status === "string") causes.push(`the successor reported status ${object.status}`);
  } else if (parsed !== undefined) {
    const kind = parsed === null ? "null" : Array.isArray(parsed) ? "an array" : `a ${typeof parsed}`;
    causes.push(`the successor send printed ${kind} where a JSON object receipt was expected`);
  } else causes.push("the successor send printed no JSON receipt");
  if (crash) causes.push(crash);
  const said = flatten(new TextDecoder("utf-8").decode(stderr));
  if (said) causes.push(said);
  const errorClass = invalid ? invalid.errorClass : parsed !== undefined && !object ? "resend_receipt_invalid" : "resend_successor_failed";
  const detail = `${causes.join(": ")}; ${recoveryText}`;
  const carried = { ...(object ?? {}) };
  for (const owned of ["ok", "error_class", "action", "detail"]) delete carried[owned];
  const body = { ok: false, error_class: errorClass, action: facts.next, detail, ...carried, resend_of: id, delivery_semantics: "at-least-once", recovery: facts };
  return { errorClass, action: facts.next, detail, body };
}

/** Format a SUCCESSFUL successor's receipt; a failed one goes through describeResendFailure. This never selects or retries a send. */
export function formatResendResult(output: Uint8Array, returncode: number, id: string,
  newId: string, json: boolean, verbose = process.env.TAP_VERBOSE === "1"): Uint8Array {
  let receipt: Record<string, unknown>;
  try {
    receipt = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output));
  } catch {
    return output;
  }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    const kind = receipt === null ? "null" : Array.isArray(receipt) ? "an array" : `a ${typeof receipt}`;
    throw new ResendReceiptError(`the successor send printed ${kind} where a JSON object receipt was expected`);
  }
  receipt.resend_of = id;
  receipt.delivery_semantics = "at-least-once";
  let text: string;
  if (json) {
    // Preserve json.dumps' ASCII escaping and separator spacing without changing
    // punctuation inside quoted strings (including escaped quotes).
    text = ensureAscii(JSON.stringify(receipt)).replace(/\x7f/g, "\\u007f")
      .replace(/"(?:[^"\\]|\\.)*"|[:,]/g, token => token === ":" || token === "," ? `${token} ` : token);
  } else if (returncode === 0 && !verbose) {
    text = `tap resend: ${receipt.status === "queued" ? "queued" : "ok"} ${newId}`;
  } else {
    text = `tap resend: RESEND ${newId} from ${id}; explicit at-least-once; ${receipt.status ?? "unconfirmed"}`;
  }
  return Buffer.from(`${text}\n`);
}

if (import.meta.main) {
  const [id, newId, json, code] = process.argv.slice(2);
  const returncode = Number(code);
  process.stdout.write(formatResendResult(readFileSync(0), returncode, id!, newId!, json === "1"));
  process.exitCode = returncode;
}
