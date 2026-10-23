// The production world for the approval-timeout pass: pane captures, the registry
// binding, the recovery door for the one key, the OpenCode sibling proof, and the
// watcher's notice path. Stamped in the sidecar fingerprint (the tick calls it).

import type { ApprovalSeams, Episode } from "./approval-timeout";
import { approvalHarness } from "./approval-timeout-policy";
import { loadRegistry, seatMap } from "./registry";
import { recoveryEffect, REAL_RECOVERY_IO } from "./recovery/effect";
import { createRun, releaseRun } from "./recovery/state";
import { targetRow } from "./recovery/cli";
import { capturePane } from "./tmux";
import { approvalNoticeOrNotify, notifyHuman, sendNoticeReceipt } from "./watch-notice";

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

function evidence(e: Episode): string {
  return [
    `seat: ${e.handle} (${e.harness}, instance ${e.instance}, pane ${e.paneId})`,
    `request: ${e.excerpt}`,
    `first seen: ${iso(e.first_seen)}; deadline: ${iso(e.deadline)}`,
    `outcome: ${e.outcome ?? "-"}${e.reason ? ` (${e.reason})` : ""}`,
    ...(e.recovery ? [`recovery run: ${e.recovery}`] : []),
  ].join("\n");
}

export function armerReason(e: Episode, minutes: number): string {
  switch (e.outcome) {
    case "verified": return `Declined ${e.handle}'s approval request after ${minutes} min with no answer; the rejection was confirmed and the seat was told to route around it.`;
    case "unverified": return `Attempted the deny control on ${e.handle}'s approval request after ${minutes} min, but could not confirm that it was sent or that it rejected the request. No retry will follow; look at the seat.`;
    case "cancelled_policy_off": return `The approval timeout was turned off before ${e.handle}'s request was declined; no key was sent.`;
    default: return `${e.handle}'s approval request is still blocked after ${minutes} min. TAP sent no key (${e.reason ?? "no_action"}); a person needs to answer it.`;
  }
}

export interface RealApprovalArgs { bus: string; scripts: string; registry: string; env: NodeJS.ProcessEnv; now(): number }

export function realApprovalSeams(a: RealApprovalArgs): ApprovalSeams {
  const seat = (handle: string) => seatMap(loadRegistry(a.registry))[handle];
  return {
    bus: a.bus,
    now: a.now,
    capture(row) {
      const r = capturePane(row.paneId, true, approvalHarness(row.harness) !== "opencode");
      return r.code === 0 && !r.rateLimited ? r.stdout : null;
    },
    instance(row) {
      try {
        const s = seat(row.handle);
        if (!s || s.pane_id !== row.paneId || (s.status ?? "active") !== "active") return null;
        return String(s.instance ?? "");
      } catch { return null; }
    },
    siblingProof() {
      // OpenCode 1.x is retired. The 2.x Reject key and its sibling scope have
      // no live attestation yet; the timeout pass escalates without sending a key.
      return "version_unproven";
    },
    reject(row, episode, gate, verify) {
      const target = targetRow(a.registry, row.handle, row.pane, row.paneId);
      if (String(target.instance) !== episode.instance) return { status: "refused", summary: "the seat's registered instance changed" };
      // Pane-less and owned by this watcher process, as copy-park-cancel.ts records its one cancel.
      const run = createRun(target, "cautious", [], a.env.TMUX_PANE || "", process.pid, a.env, undefined, false);
      let result: ReturnType<typeof recoveryEffect>;
      try {
        result = recoveryEffect(run.id, "approval-timeout reject",
          `approval timeout: ${episode.harness} request unanswered since ${iso(episode.first_seen)}`,
          ["send-keys", "-t", row.paneId, "Escape"], REAL_RECOVERY_IO, a.env, undefined, gate, verify);
      } finally {
        try { releaseRun(run.id, "approval-timeout reject finished"); } catch { /* the fixed deadline still bounds the run */ }
      }
      if (result.event.effect === "none") return { status: "refused", summary: result.event.summary, recovery: run.id };
      if (result.code === 0 && result.event.outcome === "verified") return { status: "verified", summary: result.event.summary, recovery: run.id };
      return { status: "unverified", summary: result.event.summary, recovery: run.id };
    },
    noticeSeat(handle, episode, minutes) {
      return sendNoticeReceipt({
        bus: a.bus, scripts: a.scripts, to: handle, template: "approval-reject-seat.md", env: a.env,
        reason: `Your approval request waited ${minutes} min with no answer, so TAP declined it.`,
        evidence: episode.excerpt,
      }).disposition;
    },
    noticeArmer(armer, episode, minutes) {
      return approvalNoticeOrNotify({
        bus: a.bus, scripts: a.scripts, to: armer, template: "approval-reject-lead.md", env: a.env,
        reason: armerReason(episode, minutes), evidence: evidence(episode), now: String(a.now()),
      });
    },
    escalate(episode, minutes) {
      return notifyHuman({ bus: a.bus, scripts: a.scripts, kind: "approval", reason: armerReason(episode, minutes), now: String(a.now()), env: a.env });
    },
    stderr: line => process.stderr.write(`${line}\n`),
  };
}
