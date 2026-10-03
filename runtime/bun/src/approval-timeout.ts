// Approval-timeout pass (tap-rlebf.2): a watch-tick door that tracks each seat's
// positively classified approval request, and at its harness's deadline either
// sends that row's mapped deny control once or reports the prompt blocked.
//
// Lifecycle (one episode per seat, keyed by handle, bound to instance and pane id):
//   open       a request with this fingerprint has been seen continuously since first_seen
//   tombstone  an outcome was recorded; nothing more is sent or told while the same
//              request stays on screen, and the next tick that sees it gone removes it
// A sibling refusal (OpenCode, R14) keeps the episode open and unclaimed, told once.
//
// Every fact is a seam so the pass replays over fixtures; `realApprovalSeams` is the
// production world. Stamped in the sidecar fingerprint (the tick calls it).

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { approvalRequest, detectAgentState, type ApprovalRequest } from "./agent-state";
import {
  approvalDir, approvalHarness, DEFAULT_TIMEOUT_SECONDS, policyEnabled, REJECTION_MARKERS, rowLive, watchActivity,
  type ApprovalHarness,
} from "./approval-timeout-policy";
import { atomicWrite } from "./fsatomic";
import { acquireNoFollowLock } from "./remind-lock";

export type Outcome =
  | "verified" | "unverified" | "cancelled_policy_off"
  | "no_action";
export type NoActionReason =
  | "mapping_unproven" | "label_missing" | "version_unproven" | "gate_refused"
  | "sibling_pending" | "sibling_unproven";

export interface Episode {
  handle: string;
  instance: string;
  paneId: string;
  harness: ApprovalHarness;
  rule: string;
  fingerprint: string;
  excerpt: string;
  first_seen: number;
  deadline: number;
  state: "open" | "tombstone";
  claimed_at?: number;
  attempt?: string;
  outcome?: Outcome;
  reason?: string;
  recovery?: string;
  /** Reasons the armer has already been told for this episode (once each). */
  told?: string[];
}

export interface SeatRow { handle: string; pane: string; paneId: string; harness: string }

/** OpenCode's root-session, single-pending proof (U8). */
export type SiblingProof = "single" | "pending" | "unproven" | "version_unproven";

export interface RejectResult {
  /** `verified` only after verify(); `refused` means no key went. */
  status: "verified" | "unverified" | "refused";
  summary: string;
  recovery?: string;
}

export interface ApprovalSeams {
  bus: string;
  now(): number;
  /** The visible frame, or null when it cannot be read (no evidence the prompt left). */
  capture(row: SeatRow): string | null;
  /** The registered instance for this handle and pane, or null when the binding is unreadable or changed. */
  instance(row: SeatRow): string | null;
  siblingProof(row: SeatRow, episode: Episode): SiblingProof;
  /** One guarded Escape through the recovery door; `gate` is the last read before the key. */
  reject(row: SeatRow, episode: Episode, gate: () => string, verify: () => boolean): RejectResult;
  /** Seat route-around notice; returns the courier disposition or a failure word. */
  noticeSeat(handle: string, episode: Episode, minutes: number): string;
  /** Armer notice (human NOTIFY fallback); returns its disposition. */
  noticeArmer(armer: string, episode: Episode, minutes: number): string;
  /** Human escalation for a request left blocked; returns 0 when published. */
  escalate(episode: Episode, minutes: number): number;
  stderr(line: string): void;
  /** Row liveness and timeouts; injected in tests. */
  live?(harness: ApprovalHarness): boolean;
  timeout?(harness: ApprovalHarness): number;
  marker?(harness: ApprovalHarness): RegExp | undefined;
}

const episodesPath = (bus: string) => join(approvalDir(bus), "episodes.json");
const eventsPath = (bus: string) => join(approvalDir(bus), "events.jsonl");
const lockPath = (bus: string) => join(approvalDir(bus), "episodes.lock");

export function readEpisodes(bus: string): Record<string, Episode> {
  let text: string;
  try { text = readFileSync(episodesPath(bus), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const data = JSON.parse(text) as { episodes?: Record<string, Episode> };
  return data.episodes ?? {};
}

function writeEpisodes(bus: string, episodes: Record<string, Episode>): void {
  atomicWrite(episodesPath(bus), JSON.stringify({ v: 1, episodes }, null, 2) + "\n");
}

export function appendEvent(bus: string, record: Record<string, unknown>): void {
  mkdirSync(approvalDir(bus), { recursive: true });
  appendFileSync(eventsPath(bus), JSON.stringify(record) + "\n", { mode: 0o600 });
}

/** Run `body` holding the episodes lock; null when the lock is busy. */
export function withEpisodes<T>(bus: string, body: (episodes: Record<string, Episode>, save: () => void) => T, timeoutMs = 2000): T | null {
  mkdirSync(approvalDir(bus), { recursive: true });
  const lock = acquireNoFollowLock(lockPath(bus), timeoutMs);
  if (!lock) return null;
  try {
    const episodes = readEpisodes(bus);
    return body(episodes, () => writeEpisodes(bus, episodes));
  } finally { lock.release(); }
}

/** `tap approval-timeout off`: open episodes end as cancelled; tombstones stay until their request leaves. */
export function cancelOpenEpisodes(bus: string, now: number): number | null {
  return withEpisodes(bus, (episodes, save) => {
    let count = 0;
    for (const episode of Object.values(episodes)) {
      if (episode.state !== "open") continue;
      episode.state = "tombstone";
      episode.outcome = "cancelled_policy_off";
      appendEvent(bus, eventOf(episode, now, { notices: {} }));
      count++;
    }
    save();
    return count;
  });
}

function eventOf(episode: Episode, now: number, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    at: now, handle: episode.handle, instance: episode.instance, pane_id: episode.paneId, harness: episode.harness,
    rule: episode.rule, fingerprint: episode.fingerprint, excerpt: episode.excerpt, first_seen: episode.first_seen,
    deadline: episode.deadline, claimed_at: episode.claimed_at ?? null, outcome: episode.outcome ?? null,
    reason: episode.reason ?? null, recovery: episode.recovery ?? null, ...extra,
  };
}

const minutesOf = (episode: Episode) => Math.max(1, Math.round((episode.deadline - episode.first_seen) / 60));

/**
 * The tick door. Returns 0 when the pass ran (a failed notice included) and 1 when
 * the episode store could not be read or locked; the tick reports and goes on.
 */
export function processApprovalTimeouts(roster: SeatRow[], armer: string, s: ApprovalSeams): number {
  if (!policyEnabled(s.bus)) return 0;
  const live = s.live ?? rowLive;
  const timeout = s.timeout ?? (h => DEFAULT_TIMEOUT_SECONDS[h]);
  const marker = s.marker ?? (h => REJECTION_MARKERS[h]);
  let result: true | null;
  try {
    result = withEpisodes(s.bus, (episodes, save) => {
      const now = s.now();
      for (const row of roster) {
        const harness = approvalHarness(row.harness);
        if (!harness) continue;
        let episode = episodes[row.handle];
        const frame = s.capture(row);
        if (frame === null) continue; // unreadable is not evidence that the request left
        const request = approvalRequest(harness, frame);
        const instance = s.instance(row);
        if (episode && (instance === null || episode.instance !== instance || episode.paneId !== row.paneId)) {
          end(episode, "ended_rebound");
          episode = undefined;
        }
        if (episode && (!request || request.fingerprint !== episode.fingerprint)) {
          end(episode, request ? "ended_changed" : "ended_resolved");
          episode = undefined;
        }
        if (!request || instance === null) continue;
        if (!episode) {
          episodes[row.handle] = episode = {
            handle: row.handle, instance, paneId: row.paneId, harness, rule: request.rule,
            fingerprint: request.fingerprint, excerpt: request.excerpt,
            first_seen: now, deadline: now + timeout(harness), state: "open",
          };
          save();
          continue;
        }
        if (episode.state === "tombstone") continue;
        if (episode.claimed_at !== undefined) {
          // A claim without an outcome: a crash between claim and verdict. Never retried.
          settle(episode, "unverified", "claimed without a recorded outcome; no retry");
          continue;
        }
        if (now < episode.deadline) continue;
        expire(row, episode, request);
      }
      save();
      return true as const;

      function end(episode: Episode, how: string): void {
        if (episode.state === "open") appendEvent(s.bus, eventOf(episode, now, { ended: how }));
        delete episodes[episode.handle];
        save();
      }

      function tell(episode: Episode, key: string): Record<string, string> {
        const notices: Record<string, string> = {};
        const told = episode.told ?? (episode.told = []);
        if (told.includes(key)) return notices;
        told.push(key);
        const minutes = minutesOf(episode);
        if (episode.outcome === "verified") notices.seat = s.noticeSeat(episode.handle, episode, minutes);
        notices.armer = armer ? s.noticeArmer(armer, episode, minutes) : "no armer";
        if (episode.outcome === "no_action") notices.human = s.escalate(episode, minutes) === 0 ? "published" : "failed";
        return notices;
      }

      function settle(episode: Episode, outcome: Outcome, reason?: string): void {
        const key = `${outcome}:${reason ?? ""}`;
        const repeat = (episode.told ?? []).includes(key);
        episode.outcome = outcome;
        if (reason !== undefined) episode.reason = reason; else delete episode.reason;
        if (!(outcome === "no_action" && (reason === "sibling_pending" || reason === "sibling_unproven"))) episode.state = "tombstone";
        save();
        // A sibling refusal re-checks every tick; it is recorded and told once per reason.
        if (repeat) return;
        const notices = tell(episode, key);
        save();
        appendEvent(s.bus, eventOf(episode, now, { notices }));
      }

      function expire(row: SeatRow, episode: Episode, request: ApprovalRequest): void {
        if (!live(episode.harness)) return settle(episode, "no_action", "mapping_unproven");
        if (episode.harness === "opencode") {
          const proof = s.siblingProof(row, episode);
          if (proof === "version_unproven") return settle(episode, "no_action", "version_unproven");
          if (proof === "pending") return settle(episode, "no_action", "sibling_pending");
          if (proof === "unproven") return settle(episode, "no_action", "sibling_unproven");
        } else if (!request.denyLabel) {
          return settle(episode, "no_action", "label_missing");
        }
        episode.claimed_at = now;
        episode.attempt = randomUUID();
        delete episode.outcome; delete episode.reason;
        save();
        const gate = (): string => {
          if (!policyEnabled(s.bus)) return "policy_off";
          // Disarm or a switch to reminders-only mid-pass withdraws the authority to key (R15).
          if (!watchActivity(s.bus).active) return "the watch is no longer armed in full mode";
          const fresh = s.capture(row);
          const again = fresh === null ? null : approvalRequest(episode.harness, fresh);
          if (!again || again.fingerprint !== episode.fingerprint) return "the request changed or left before the key";
          if (episode.harness === "opencode") {
            if (s.siblingProof(row, episode) !== "single") return "the sibling proof no longer holds";
          } else if (!again.denyLabel) return "the deny label is gone";
          return "";
        };
        const verify = (): boolean => {
          const after = s.capture(row);
          if (after === null) return false;
          const again = approvalRequest(episode.harness, after);
          if (again && again.fingerprint === episode.fingerprint) return false;
          const state = detectAgentState(episode.harness, after).agentState;
          const rejected = marker(episode.harness);
          return (state === "idle" || state === "working") && rejected !== undefined && rejected.test(after);
        };
        let result: RejectResult;
        try { result = s.reject(row, episode, gate, verify); }
        catch (error) { result = { status: "unverified", summary: error instanceof Error ? error.message : String(error) }; }
        episode.recovery = result.recovery;
        if (result.status === "verified") return settle(episode, "verified");
        if (result.status === "unverified") return settle(episode, "unverified", result.summary);
        if (/policy_off/.test(result.summary)) return settle(episode, "cancelled_policy_off");
        return settle(episode, "no_action", "gate_refused");
      }
    });
  } catch (error) {
    s.stderr(`tap watch: approval-timeout: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (result === null) {
    s.stderr("tap watch: approval-timeout: the episode lock is busy; skipped this tick");
    return 1;
  }
  return 0;
}
