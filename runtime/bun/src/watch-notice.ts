// The watch layer's two ways of reaching someone: a `notice` to a seat over the
// bus, and the sticky human NOTIFY when that cannot land. Migration slice W1 moves
// `_watch_render_notice`, `_watch_send_notice`, `_watch_notify_pending`,
// `_watch_notify_human` and `_watch_notice_or_notify` out of tap-watch.sh so the
// native verbs (pause/resume/off/on --rearm) and the still-Bash tick share ONE
// implementation; the Bash names stay as `tap_bun_call` bridges until W2.
//
// Stamped in the sidecar fingerprint (the loop calls it), so it imports only
// loop-safe leaves and takes every fact (bus, scripts dir, clock) as an argument.
//
// The send itself is one out-of-process native `tap send` (courierArgv), with the
// argv and TAP_SELF `_watch_send_notice` used. It is a spawn, not a second sender.
//
// Grammar:  watch-notice.ts send <bus> <scripts> <to> <reason> <evidence> [notice|progress] [--wake]
//           watch-notice.ts pending <bus>
//           watch-notice.ts notify-human <bus> <scripts> <reason> [episode|spool]
//           watch-notice.ts notice-or-notify <bus> <scripts> <to> <reason> <evidence>
//
// What is carried from the incumbent:
//   - `send` exits 3 for an empty recipient; 0 when the courier reported 0 or 5
//     (accepted, or pending in the spool -- both durable); the courier's own
//     status otherwise, after echoing its first stderr line. A `progress` body
//     is `<reason>\n\n<evidence>`; a `notice` body is the notice.md template with
//     `{{REASON}}`/`{{EVIDENCE}}` filled (`-` for empty). The draft lives under
//     `<bus>/watch/` and is removed after the attempt.
//   - `pending` exits 0 when notify.json exists, parses, and `str(acked) != "1"`;
//     1 otherwise (unreadable counts as not pending).
//   - `notify-human` is the degrading safety net: sticky-merge (an unacked NOTIFY
//     is left alone), episode dedup (`notified_at >= episode_started_at` -- EPISODE
//     kind only; spool escalations dedup per entry elsewhere), then the NOTIFY
//     publish, `notified_at` stamp (episode only), `verbs/escalate.ts` best-effort,
//     the macOS notification best-effort, the attention line on stderr, and LAST
//     the durability verdict as the exit status -- the transports still run when
//     the publish failed (CONTRACT §Escalation: the net degrades, never vanishes).
//   - `notice-or-notify` is `send` then, on any nonzero, `notify-human`, whose
//     durability result it returns (the incumbent's callers inherited that through
//     `set -e`). Its WATCH_NOTICE_FALLBACK variable had no reader and is gone.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { atomicWrite, receiptBytes } from "./fsatomic";
import { courierArgv } from "./courier-argv";
import { childBusEnv } from "./panelock";
import { fieldValue, isFile, parseRecord, pyStr, readLoose, set as leaseSet } from "./watch-lease";
import { courierDisposition } from "./watch-tick";
import { ownBunFlags } from "./own-bun";

/** The supervisor's reserved sender identity (lib.sh TAP_WATCH_IDENTITY). */
export const WATCH_IDENTITY = "watcher";

export type NoticeKind = "notice" | "progress";
export type NotifyKind = "episode" | "spool" | "approval";

export function armPath(bus: string): string { return join(bus, "watch", "arm.json"); }
export function notifyPath(bus: string): string { return join(bus, "watch", "notify.json"); }

/**
 * `_watch_render_notice`: the notice.md template with its two tokens filled. A
 * template that cannot be read rendered EMPTY in the incumbent (the heredoc's
 * python raised, `body="$(...)"` took the empty substitution) and the send went
 * ahead with that body; the same here, so the degrading path is still reached.
 */
export function renderNotice(scripts: string, reason: string, evidence: string, template = "notice.md"): string {
  let body: string;
  try { body = readFileSync(join(scripts, "watch-templates", template), "utf8"); } catch { return ""; }
  return body.replaceAll("{{REASON}}", reason || "-").replaceAll("{{EVIDENCE}}", evidence || "-");
}

export interface SendNoticeArgs {
  bus: string;
  scripts: string;
  to: string;
  reason: string;
  evidence?: string;
  kind?: NoticeKind;
  wake?: boolean;
  env?: NodeJS.ProcessEnv;
  /** A `watch-templates/` file for a `notice` body; default `notice.md`. */
  template?: string;
  /** The caller reports the outcome itself (e.g. `tap role`): no `tap watch:` stderr line. */
  quiet?: boolean;
}

/**
 * `_watch_send_notice`: one `tap send` attempt as the watcher, `--fyi`, kind
 * notice|progress. Returns 0 when durable (courier 0 or 5), 3 for an empty
 * recipient, else the courier's status after surfacing its first stderr line.
 */
export function sendNotice(a: SendNoticeArgs): number {
  return send(a, false).rc;
}

/**
 * `sendNotice` with the courier's own disposition (`injected`, `queued`, `pending`,
 * or `failed`): transport acceptance, never proof the recipient processed it.
 */
export function sendNoticeReceipt(a: SendNoticeArgs): { rc: number; disposition: string } {
  return send(a, true);
}

function send(a: SendNoticeArgs, receipt: boolean): { rc: number; disposition: string } {
  if (!a.to) return { rc: 3, disposition: "failed" };
  const kind = a.kind ?? "notice";
  const evidence = a.evidence ?? "";
  const body = kind === "progress" ? `${a.reason}\n\n${evidence}` : renderNotice(a.scripts, a.reason, evidence, a.template);
  const dir = join(a.bus, "watch");
  const draft = join(dir, `.notice.${process.pid}.md`);
  try {
    mkdirSync(dir, { recursive: true });
    // `body="$(...)"` stripped trailing newlines and `printf '%s\n'` put one back.
    writeFileSync(draft, body.replace(/\n+$/, "") + "\n");
  } catch (error) {
    // The incumbent's `printf > "$draft"` failed inside an `||` context and the send
    // ran without its draft and failed: a failed send, which the caller degrades from.
    process.stderr.write(`tap watch: notice send to '${a.to}' failed (rc=1): ${error instanceof Error ? error.message : String(error)}\n`);
    return { rc: 1, disposition: "failed" };
  }
  const args = [a.to, draft, "--from", WATCH_IDENTITY, "--kind", kind, "--fyi"];
  if (receipt) args.push("--json");
  if (a.wake) args.push("--wake");
  const [cmd, ...argv] = courierArgv(a.scripts, args, a.env ?? process.env);
  // autosettle-exempt: progress may be courier-settled; notice remains excluded from pre-settlement by kind.
  const result = spawnSync(cmd!, argv, {
    env: { ...(a.env ?? process.env), TAP_SELF: WATCH_IDENTITY },
    stdio: ["inherit", receipt ? "pipe" : "ignore", "pipe"],
  });
  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString() ?? "";
  const rc = result.error ? 1 : (result.status ?? 1);
  // Same stderr-leak learning: a failed notice surfaces the error line before falling
  // back to the sticky NOTIFY (so a wrong disarm is never silent AND never blind).
  if (rc !== 0 && rc !== 5 && !a.quiet) {
    process.stderr.write(`tap watch: notice send to '${a.to}' failed (rc=${rc}): ${stderr.split("\n", 1)[0] ?? ""}\n`);
  }
  // Cleanup is best-effort and must not outrank the verdict: `force` swallows a
  // missing draft, not a directory that became unwritable under us -- and a throw
  // here would skip the caller's human fallback (review).
  try { rmSync(draft, { force: true }); } catch (error) {
    process.stderr.write(`tap watch: could not remove notice draft ${draft}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  const outcome = receipt ? courierDisposition(rc, stdout, stderr) : null;
  // Receipt mode fails closed: an exit 0/5 whose JSON is malformed or unaccepted is a
  // failed notice, so the caller's human fallback still fires.
  if (outcome && !outcome.accepted) return { rc: rc === 0 || rc === 5 ? 1 : rc, disposition: "failed" };
  return { rc: rc === 0 || rc === 5 ? 0 : rc, disposition: outcome?.accepted ? outcome.status : rc === 0 || rc === 5 ? "accepted" : "failed" };
}

/**
 * `_watch_notify_pending`: an unacked sticky NOTIFY exists -- `str(acked) != "1"`
 * over the record as python loaded it, so an `acked` of `1.0` is "1.0" and still
 * pending (parseRecord keeps a float's text; a plain Number would print `1`).
 * Unreadable is "not pending".
 */
export function notifyPending(bus: string): boolean {
  const p = notifyPath(bus);
  if (!isFile(p)) return false; // `[ -f ]` before the open: a fifo must not block the tick
  try {
    const data = parseRecord(readFileSync(p, "utf8"));
    if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
    const acked = (data as Record<string, unknown>).acked;
    return pyStr(acked === undefined ? "0" : acked) !== "1";
  } catch {
    return false;
  }
}

export interface NotifyHumanArgs {
  bus: string;
  scripts: string;
  reason: string;
  kind?: NotifyKind;
  now: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * `_watch_notify_human`: chain exhausted (or another explicit supervision
 * escalation) -> the human. Returns the publish result (0 durable, 1 not), AFTER
 * the degraded transports ran. Success means the alert was published, not read.
 */
export function notifyHuman(a: NotifyHumanArgs): number {
  const kind = a.kind ?? "episode";
  const env = a.env ?? process.env;
  // (a) an unacked NOTIFY is pending -> sticky; leave it (merge), never clobber.
  // Applies to BOTH kinds: a human already alerted does not need a second ping.
  if (notifyPending(a.bus)) return 0;
  // (b) episode-scoped once-per-wedge dedup -- EPISODE kind ONLY (see tap-t4i:
  // a spool escalation must neither read nor write the episode slot).
  const arm = armPath(a.bus);
  if (kind === "episode") {
    const rec = readLoose(arm);
    const episode = fieldValue(rec, "episode_started_at");
    const notified = fieldValue(rec, "notified_at");
    if (notified && notified !== "0" && episode && /^-?\d+$/.test(notified) && /^-?\d+$/.test(episode)
      && BigInt(notified) >= BigInt(episode)) {
      return 0;
    }
  }
  // The failure is CARRIED, not returned here: the transports below still run
  // when the NOTIFY could not be published, and the caller still learns the
  // alert is not durable.
  let publishRc = 0;
  try {
    mkdirSync(join(a.bus, "watch"), { recursive: true });
  } catch {
    publishRc = 1;
  }
  if (publishRc === 0) {
    try {
      // tap_json_obj | tap_atomic_write: every value a string, compact, one trailing newline.
      atomicWrite(notifyPath(a.bus), receiptBytes({ type: "NOTIFY", at: a.now, reason: a.reason, acked: "0" }));
    } catch {
      publishRc = 1;
    }
  }
  if (kind === "episode" && publishRc === 0) {
    try { leaseSet(arm, ["notified_at", a.now], env); } catch { /* best-effort, as the incumbent's `|| true` */ }
  }
  // Escalate transport (CONTRACT §Escalation): best-effort, --from the armer.
  const armer = fieldValue(readLoose(arm), "armed_by");
  if (armer) {
    spawnSync(process.execPath, [...ownBunFlags(process.execPath), resolve(a.scripts, "../../../runtime/bun/src/verbs/escalate.ts"), "-m", a.reason, "--from", armer],
      { env: { ...childBusEnv(a.bus, env), BUN_BE_BUN: "1" }, stdio: "ignore" });
  }
  // tap_attention watch attention "<reason> (armed team, chain exhausted)" "tap health"
  process.stderr.write(`tap watch: attention: ${a.reason} (armed team, chain exhausted); next: tap health\n`);
  return publishRc;
}

/**
 * `_watch_notice_or_notify`: a notice to the seat, else the human. 0 when the
 * notice landed or the fallback published; the fallback's durability result
 * otherwise. The incumbent's `return 0` was never reached on that path: its
 * callers ran it as a plain statement under `set -e`, so a NOTIFY that could not
 * be published ended the verb with exit 1 after the degraded transports ran
 * (measured at the pinned base, partner review A2). Callers return it the same way.
 */
export function noticeOrNotify(a: { bus: string; scripts: string; to: string; reason: string; evidence?: string; now: string; env?: NodeJS.ProcessEnv }): number {
  const rc = sendNotice({ bus: a.bus, scripts: a.scripts, to: a.to, reason: a.reason, evidence: a.evidence, env: a.env });
  if (rc === 0) return 0;
  return notifyHuman({ bus: a.bus, scripts: a.scripts, reason: a.reason, now: a.now, env: a.env });
}

/**
 * The approval-timeout armer notice: a templated notice, else an `approval`-kind
 * NOTIFY that never touches the watch's silence-episode fields. Returns the
 * disposition, or `notify` / `failed` for the fallback.
 */
export function approvalNoticeOrNotify(a: { bus: string; scripts: string; to: string; reason: string; evidence: string; template: string; now: string; env?: NodeJS.ProcessEnv }): string {
  const sent = sendNoticeReceipt({ bus: a.bus, scripts: a.scripts, to: a.to, reason: a.reason, evidence: a.evidence, template: a.template, env: a.env });
  if (sent.rc === 0) return sent.disposition;
  return notifyHuman({ bus: a.bus, scripts: a.scripts, reason: a.reason, kind: "approval", now: a.now, env: a.env }) === 0 ? "notify" : "failed";
}

function currentTime(env: NodeJS.ProcessEnv): string {
  const override = env.TAP_WATCH_NOW;
  return override ? override : String(Math.floor(Date.now() / 1000));
}

export function main(argv: string[]): number {
  const [action, ...rest] = argv;
  switch (action) {
    case "send": {
      const wake = rest[rest.length - 1] === "--wake";
      const args = wake ? rest.slice(0, -1) : rest;
      const [bus, scripts, to, reason, evidence, kind] = args;
      if (!bus || !scripts || to === undefined || reason === undefined || args.length < 5 || args.length > 6) {
        throw new Error("send needs <bus> <scripts> <to> <reason> <evidence> [notice|progress] [--wake]");
      }
      if (kind !== undefined && kind !== "notice" && kind !== "progress") throw new Error("send kind must be notice|progress");
      return sendNotice({ bus, scripts, to, reason, evidence: evidence ?? "", kind: kind as NoticeKind | undefined, wake });
    }
    case "pending": {
      if (rest.length !== 1) throw new Error("pending needs <bus>");
      return notifyPending(rest[0]!) ? 0 : 1;
    }
    case "notify-human": {
      const [bus, scripts, reason, kind] = rest;
      if (!bus || !scripts || reason === undefined || rest.length < 3 || rest.length > 4) throw new Error("notify-human needs <bus> <scripts> <reason> [episode|spool]");
      if (kind !== undefined && kind !== "episode" && kind !== "spool" && kind !== "approval") throw new Error("notify-human kind must be episode|spool|approval");
      return notifyHuman({ bus, scripts, reason, kind: kind as NotifyKind | undefined, now: currentTime(process.env) });
    }
    case "notice-or-notify": {
      const [bus, scripts, to, reason, evidence] = rest;
      if (!bus || !scripts || to === undefined || reason === undefined || rest.length < 4 || rest.length > 5) throw new Error("notice-or-notify needs <bus> <scripts> <to> <reason> [<evidence>]");
      return noticeOrNotify({ bus, scripts, to, reason, evidence: evidence ?? "", now: currentTime(process.env) });
    }
    default:
      throw new Error("usage: watch-notice.ts <send|pending|notify-human|notice-or-notify> ...");
  }
}

if (import.meta.main) {
  try {
    process.exitCode = main(Bun.argv.slice(2));
  } catch (error) {
    process.stderr.write(`tap watch: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
