/**
 * KTD7: courier-originated sender notices. Public `send` refuses `--from courier`
 * on purpose; this minter is the only placement path. Native sendNotice requires
 * an explicit mode (R15); the shared classifier selects one for the Bash adapter
 * from observed evidence. Wire kind stays `delivery-failed`; mode is payload-body
 * semantics, never a new sentinel token (ledger K8).
 *
 * Dark engine: placement is file-side. Injection is a hook so this unit never
 * invents a delivery API (U4 owns `deliver()`).
 */

import { mkdirSync, readFileSync, statSync } from "node:fs";

/**
 * Bash `[ -f ]`, which is what the repo asks with when it asks whether a RECEIPT exists
 * (`tap_is_done`, lib.sh:1779: `[ -f done ] || [ -f cancel ]`). `existsSync` answers a
 * wider question — any entry — so a directory at `receipts/<id>.done` read as settled and
 * suppressed a delivery-failure notice for a message nobody settled (rule 38,
 * a P2-class defect). A stat that throws is this operator's FALSE, never an error.
 */
function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}
import { basename, dirname, join } from "node:path";

import type { CourierIntent } from "./courier-contract";
import { envelopeField, stampEnvelope } from "./envelope";
import { atomicWrite } from "./fsatomic";
import { mintId, validId, validToken } from "./ids";
import { renderSentinel } from "./sentinel";

export const COURIER_IDENTITY = "courier";
export const KIND_DELIVERY_FAILED = "delivery-failed";

/** Four R15 modes plus U7's unconfirmed-digest (ledger L1). */
export type NoticeMode =
  | "park-expired"
  | "shell-mode"
  | "feedback-draft"
  | "stuck-readiness"
  | "lock-park"
  | "failed"
  | "unconfirmed"
  | "unrouted"
  | "sender_gone"
  | "unconfirmed-digest";

/** Shared notice decision; a possible pane effect is never a known failure. */
export function classifyNotice(outcome: string, settled: boolean, delivered = false): NoticeMode | "skip" {
  if (settled || delivered) return "skip";
  switch (outcome) {
    case "possible": return "unconfirmed";
    case "failed": return "failed";
    case "park-expired": case "shell-mode": case "feedback-draft": case "stuck-readiness": case "unconfirmed": case "unrouted": case "lock-park": return outcome;
    default: throw new Error(`unknown notice outcome: ${outcome}`);
  }
}

/** Read receipts are written only after the read command checks addressee authority.
 * Forced inspection is observable, but does not prove the recipient got the ask.
 */
export function hasRecipientRead(receiptsDir: string, id: string): boolean {
  try {
    const read = JSON.parse(readFileSync(join(receiptsDir, `${id}.read`), "utf8"));
    return !!read && read.id === id && typeof read.by === "string" && validToken(read.by)
      && String(read.forced) !== "true" && read.reason !== "instance_retired";
  } catch { return false; }
}

export interface NoticeInjectArgs {
  id: string;
  path: string;
  sentinel: string;
  mode: NoticeMode;
}

export interface SendNoticeInput {
  payloadsDir: string;
  intent: CourierIntent;
  mode: NoticeMode;
  detail: string;
  /** Acting team name for the sentinel's `from=<team>/courier`. */
  team: string;
  now?: Date;
  /**
   * Inject the notice sentinel. Return true iff the wake was verified.
   * Omitted/false is unverified — the caller decides terminal-vs-held.
   */
  inject?: (args: NoticeInjectArgs) => boolean;
  /**
   * True when the sender is on some enrolled registry. Absent sender →
   * `sender_gone`: event line, no injection (R14).
   */
  senderPresent?: (from: string) => boolean;
  event?: (line: string) => void;
}

export interface SendNoticeResult {
  mode: NoticeMode;
  verified: boolean;
  sender_gone: boolean;
  notice_id: string | null;
  path: string | null;
}

export function lockParkBody(id: string, target: string, detail: string): string {
  return `DELIVERY QUEUED: ${id} to ${target} is waiting for the pane submit lock.\n\n` +
    `Detail: ${detail}\n\n` +
    `The lock refused this submit before pane input. The payload remains in courier custody; its existing delivery policy determines retry or disposition.\n` +
    `Inspect its current receipts with tap show ${id}; do not resend solely because of this notice.\n`;
}

/**
 * The sender-notice BODY per mode — the LIVE bytes, the ones the smoke corpus pins
 * (notice-outcome, waiter-escalated-grace, drain-sink-*), which lived in Bash's
 * `tap_spool_notify_sender_on_escalate` until the drain's deadline transaction
 * (spool-deadline.ts) took the decision and this module kept the rendering: WHICH
 * mode is the caller's; WHAT a mode says is this function's, one source for every
 * minter. `sender_gone` renders nothing (the minter returns before rendering).
 *
 * `lock-park` keeps `lockParkBody` (shared with the attempt path) plus one newline:
 * the incumbent's adapter printed that body with `console.log`, and the extra
 * newline is part of the bytes every live lock-park notice carries.
 */
/** The feedback-draft notice's first line, also its deduplication witness. */
export const FEEDBACK_DRAFT_HELD = (id: string, target: string): string =>
  `DELIVERY HELD: ${id} to ${target} is blocked by the Claude feedback-draft panel.`;

/** The stuck-readiness notice's first line, also its deduplication witness (tap-bprtg). */
export const STUCK_READINESS_HELD = (id: string, target: string): string =>
  `DELIVERY STALLED: ${id} to ${target} is held with no harness activity.`;

export function noticeBody(mode: NoticeMode, id: string, target: string, canon: string, detail: string, noticeId: string): string {
  if (mode === "sender_gone") throw new Error("sender_gone renders no notice");
  if (mode === "park-expired") return `PARK EXPIRED: ${id} to ${target} reached its retention limit.\n\n`
    + `Automatic delivery has stopped. Expiry does not attest recipient processing or rule out an earlier delivery effect.\n`
    + `The body and attempt evidence are preserved. Inspect custody and withdrawal status with tap show ${id}, including after history is archived.\n`;
  if (mode === "shell-mode") return `DELIVERY HELD: ${id} to ${target} is blocked by OpenCode shell mode.\n\n`
    + `The payload remains queued. The courier will not type, clear input, or press Enter into the shell composer.\n`
    + `Inspect the recipient's composer and exit shell mode to restore chat delivery.\n`
    + `Inspect this delivery with tap show ${id}.\n`;
  if (mode === "feedback-draft") return `${FEEDBACK_DRAFT_HELD(id, target)}\n\n`
    + `The payload remains queued. The courier will not send, review, or dismiss the draft, and types nothing into that pane.\n`
    + `A human, or ${target}'s leader, dismisses the panel (read it, then press 0 in ${target}'s pane); delivery resumes on its own.\n`
    + `Inspect this delivery with tap show ${id}.\n`;
  if (mode === "stuck-readiness") return `${STUCK_READINESS_HELD(id, target)}\n\n`
    + `${detail}\n`
    + `Its harness shows no turn in progress and no activity, so the readiness read is probably wrong (an unknown cause).\n`
    + `The payloads remain queued. The courier sends nothing extra and this alarm does not repeat for this hold.\n`
    + `Inspect ${target}'s pane; list the held mail with tap spool list, and this delivery with tap show ${id}.\n`;
  if (mode === "lock-park") return `${lockParkBody(id, target, detail)}\n`;
  let out = "";
  if (mode === "unrouted") {
    out += `NOT DELIVERED: ${id} to ${target} was never attempted.\n\n`;
  } else if (mode === "unconfirmed-digest") {
    out += `DELIVERY UNCONFIRMED: digest members to ${target} have unconfirmed delivery.\nDigest notice: ${noticeId}\n\n`;
  } else if (mode === "unconfirmed") {
    out += `DELIVERY UNCONFIRMED: ${id} to ${target} may or may not have reached them.\n\n`;
  } else {
    out += `DELIVERY FAILED: ${id} to ${target} was not delivered before its deadline.\n\n`;
  }
  out += `The payload is intact:\n  ${canon}\n\n`;
  out += `Detail: ${detail || "deadline reached while the recipient pane stayed busy"}\n\n`;
  if (mode === "unrouted") {
    out += "The courier made NO attempt: this entry left automatic delivery without\n";
    out += "ever being tried (the Detail line says why), and would otherwise have sat\n";
    out += "indefinitely. Nothing here says the recipient is unreachable —\n";
    out += `they may be perfectly fine. Run tap resend ${id} to ring it again under the same id.\n`;
  } else if (mode === "unconfirmed" || mode === "unconfirmed-digest") {
    out += "This is not a queued send still on its way — the courier stopped trying,\n";
    out += "and it cannot observe whether the wake landed. If it is still unread,\n";
    // A digest doorbell has no canonical payload of its own: its members are resent by their own ids.
    out += mode === "unconfirmed-digest"
      ? "tap resend <member-id> rings a member again under its own id; a repeat is harmless.\n"
      : `tap resend ${id} rings it again under the same id; a repeat is harmless.\n`;
  } else {
    out += "This is not a queued send still on its way — the courier stopped trying.\n";
    out += `If it is still unread, tap resend ${id} rings it again under the same id. It will not arrive on its own.\n`;
  }
  return out;
}

/**
 * Mint a courier notice for the intent's sender. Mode is a required argument.
 * Self-recursion: a canonical whose ENVELOPE kind is `delivery-failed` never
 * mints a second notice. Body prose is not a kind — a discuss payload that
 * quotes this token must still notify (the body-decoy control).
 */
export function sendNotice(input: SendNoticeInput): SendNoticeResult {
  const canon = join(input.payloadsDir, `${input.intent.id}.md`);
  // Rule 38, census F2: the incumbent asked `[ -f "$(tap_payload_path)" ]` (lib.sh:2603,
  // 2646, 3062, 4134), so the question is a regular file, not an entry. A directory here
  // already fell through — `readFileSync` raises EISDIR and the catch below absorbs it —
  // so this swap changes no observable for the census's own case, and the control beside
  // it passes on both sides. It is still the right operator: the entry that DOES differ is
  // one whose read never returns (a FIFO at the canonical path), where `existsSync` sends
  // the courier into a blocking read and `isFile` declines it.
  if (isFile(canon)) {
    try {
      const raw = readFileSync(canon, "utf8");
      if (envelopeField(raw, "kind") === KIND_DELIVERY_FAILED) {
        return { mode: input.mode, verified: false, sender_gone: false, notice_id: null, path: null };
      }
    } catch {
      /* unreadable canonical is not a recursion guard hit */
    }
  }

  if (input.mode === "sender_gone" || input.senderPresent?.(input.intent.from) === false) {
    input.event?.(`courier sender_gone id=${input.intent.id} from=${input.intent.from}`);
    return { mode: "sender_gone", verified: false, sender_gone: true, notice_id: null, path: null };
  }

  mkdirSync(input.payloadsDir, { recursive: true });
  const noticeId = mintId(COURIER_IDENTITY, input.now);
  const path = join(input.payloadsDir, `${noticeId}.md`);
  const team = input.team || "tap";
  const stamped = stampEnvelope(`---\n---\n${noticeBody(input.mode, input.intent.id, input.intent.to, canon, input.detail, noticeId)}`, {
    id: noticeId,
    from: COURIER_IDENTITY,
    to: input.intent.from,
    kind: KIND_DELIVERY_FAILED,
    path,
    reply: "settle-only",
    from_team: team,
    to_team: team,
  });
  atomicWrite(path, stamped);

  const sentinel = renderSentinel({
    from: `${team}/${COURIER_IDENTITY}`,
    to: `${team}/${input.intent.from}`,
    id: noticeId,
    kind: KIND_DELIVERY_FAILED,
    reply: "settle-only",
    path,
  });
  const verified = input.inject?.({ id: noticeId, path, sentinel, mode: input.mode }) === true;
  return { mode: input.mode, verified, sender_gone: false, notice_id: noticeId, path };
}

// All members live on one acting sender bus. Keep the envelope sender token
// intact: the existing publisher resolves that token against that bus registry.
export function digestNoticeGroups(payloadsDir: string, receiptsDir: string, ids: string[]): Array<{ sender: string; ids: string[]; detail: string }> {
  const groups = new Map<string, Array<{ id: string; path: string }>>();
  for (const id of [...ids].sort()) {
    if (!validId(id)) throw new Error("invalid digest member id");
    if (isFile(join(receiptsDir, `${id}.done`)) || isFile(join(receiptsDir, `${id}.sent`)) || hasRecipientRead(receiptsDir, id)) continue;
    const path = join(payloadsDir, `${id}.md`);
    const raw = readFileSync(path, "utf8");
    if (envelopeField(raw, "kind") === KIND_DELIVERY_FAILED) continue;
    const sender = envelopeField(raw, "from");
    if (!sender || !validToken(sender)) throw new Error(`digest member ${id} has no valid sender`);
    const members = groups.get(sender) ?? [];
    members.push({ id, path });
    groups.set(sender, members);
  }
  return [...groups.entries()].map(([sender, members]) => ({
    sender, ids: members.map(member => member.id),
    detail: "The digest doorbell carrying these payloads was submitted but could not be verified. " +
      "Automatic retry is stopped to avoid duplicate injection. The courier does not settle recipient work; inspect the current per-item receipts.\n\n" +
      members.map(member => `${member.id}\n  ${member.path}`).join("\n"),
  }));
}

// Thin Bash adapter: classify at the final notice-selection boundary. A later
// settlement race is possible; this snapshot does not claim to exclude it.
if (import.meta.main) {
  if (Bun.argv[2] === "lock-park-body") {
    const [id, target, detail] = Bun.argv.slice(3);
    if (!id || !target || !detail) throw new Error("lock notice arguments required");
    console.log(lockParkBody(id, target, detail));
    process.exit(0);
  } else if (Bun.argv[2] === "digest-groups") {
    try {
      if (!Bun.argv[3] || !Bun.argv[4]) throw new Error("payload and receipt directories required");
      const groups = digestNoticeGroups(Bun.argv[3], Bun.argv[4], Bun.argv.slice(5));
      // Header tokens plus NUL-terminated body keep paths/prose literal in Bash.
      for (const group of groups) process.stdout.write(`${group.sender} ${group.ids.join(" ")}\n${group.detail}\0`);
    } catch (error) { console.error(String(error)); process.exit(2); }
    process.exit(0);
  }
  const [outcome, ...receipts] = Bun.argv.slice(2);
  if (outcome === undefined || !receipts.length || receipts.length % 2 || receipts.some(path => !path)) process.exit(2);
  // Digest publication is suppressed only when every represented member has
  // settled, verified delivery, or an authorized read. A representative cannot hide siblings.
  const terminal = receipts.every((path, index) => index % 2 === 1 || isFile(path) || isFile(receipts[index + 1]!)
    || (path.endsWith(".done") && hasRecipientRead(dirname(path), basename(path, ".done"))));
  try { console.log(classifyNotice(outcome, terminal)); }
  catch (error) { console.error(String(error)); process.exit(2); }
}
