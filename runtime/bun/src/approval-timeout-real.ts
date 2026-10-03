// The production world for the approval-timeout pass: pane captures, the registry
// binding, the recovery door for the one key, the OpenCode sibling proof, and the
// watcher's notice path. Stamped in the sidecar fingerprint (the tick calls it).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ApprovalSeams, Episode, SeatRow, SiblingProof } from "./approval-timeout";
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

/**
 * The TAP OpenCode plugin's pane-keyed approval state (U8, hooks/tap-opencode-session-start.ts
 * `approvalStatePath`): machine-local under the index home, bound to the pane's process below.
 */
export const opencodeStatePath = (env: NodeJS.ProcessEnv, paneId: string): string =>
  join(env.TAP_INDEX_HOME || join(homedir(), ".tap"), "approval-timeout", "opencode", `${paneId.replace(/^%/, "")}.json`);

/** Heartbeat freshness for the plugin's pending-permission record. */
export const SIBLING_HEARTBEAT_MAX_AGE_S = 60;

interface OpencodeState {
  version?: string; pid?: number; ppid?: number; at?: number; session?: string; root?: boolean;
  pending?: { id: string; summary?: string }[]; other_sessions_pending?: number;
}

/**
 * Root session, a fresh heartbeat from the seat's own OpenCode process, a 1.18.x
 * TUI, and exactly one pending request whose summary appears in the frame's excerpt.
 */
export function readSiblingProof(path: string, panePid: string, excerpt: string, now: number): SiblingProof {
  let state: OpencodeState;
  try { state = JSON.parse(readFileSync(path, "utf8")) as OpencodeState; } catch { return "unproven"; }
  if (typeof state.version !== "string" || !/^1\.18\.\d+$/.test(state.version)) return "version_unproven";
  if (typeof state.at !== "number" || now - state.at > SIBLING_HEARTBEAT_MAX_AGE_S || state.at > now + 5) return "unproven";
  // The pane runs OpenCode directly or under one wrapper shell.
  if (panePid === "" || (String(state.pid ?? "") !== panePid && String(state.ppid ?? "") !== panePid)) return "unproven";
  // A known root session, and no pending request the frame could belong to instead.
  if (state.root !== true || state.other_sessions_pending !== 0) return "unproven";
  const pending = Array.isArray(state.pending) ? state.pending : null;
  if (!pending) return "unproven";
  if (pending.length > 1) return "pending";
  if (pending.length !== 1) return "unproven";
  const summary = pending[0]!.summary ?? "";
  return summary !== "" && excerpt.includes(summary) ? "single" : "unproven";
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
    siblingProof(row: SeatRow, episode: Episode) {
      let pid = "";
      try { pid = String(targetRow(a.registry, row.handle, row.pane, row.paneId).processPid); } catch { return "unproven"; }
      return readSiblingProof(opencodeStatePath(a.env, row.paneId), pid, episode.excerpt, a.now());
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
