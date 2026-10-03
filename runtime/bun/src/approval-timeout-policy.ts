// Approval-timeout team policy (tap-rlebf.2): the on/off record, the per-harness
// defaults, and which mapping rows have the captured evidence to act.
//
// Stamped in the watch sidecar's fingerprint (the tick reads it), so it imports
// only loop-safe leaves and takes the bus as an argument.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWrite } from "./fsatomic";

export type ApprovalHarness = "claude" | "codex" | "cursor" | "opencode" | "agy" | "hermes";
export const APPROVAL_HARNESSES: readonly ApprovalHarness[] = ["claude", "codex", "cursor", "opencode", "agy", "hermes"];

/**
 * One default per harness; team config is on/off only (leader ruling, revisit when
 * an operator asks for a different duration on a real team). Hermes denies on its
 * own after its 300 s `approvals.timeout`; 120 s plus two 60 s tick intervals of
 * lag still observes the expiry first.
 */
export const DEFAULT_TIMEOUT_SECONDS: Readonly<Record<ApprovalHarness, number>> = {
  claude: 600, codex: 600, cursor: 600, opencode: 600, agy: 600, hermes: 120,
};

/**
 * A row may send its deny control only after its real before/after capture and its
 * rejection marker are committed (R7). Until then an expired request is reported
 * blocked and escalated, never answered. Each marker matches the text the harness
 * prints after a denial, and is the last condition `verify()` reads.
 */
export const REJECTION_MARKERS: Readonly<Partial<Record<ApprovalHarness, RegExp>>> = {};
export const rowLive = (harness: ApprovalHarness): boolean => REJECTION_MARKERS[harness] !== undefined;

export function approvalHarness(name: string): ApprovalHarness | null {
  const base = name.split("/").pop()?.toLowerCase() ?? "";
  for (const harness of APPROVAL_HARNESSES) if (base === harness || base.startsWith(`${harness}-`)) return harness;
  const aliases: Record<string, ApprovalHarness> = {
    "claude-code": "claude", "cursor-agent": "cursor", "open-code": "opencode",
    antigravity: "agy", "antigravity-cli": "agy", "hermes-agent": "hermes",
  };
  return aliases[base] ?? null;
}

export const approvalDir = (bus: string): string => join(bus, "approval-timeout");
export const policyPath = (bus: string): string => join(approvalDir(bus), "policy.json");

export interface Policy { enabled: boolean; by: string; at: number }
export type PolicyRead = { policy: Policy; problem: null } | { policy: Policy; problem: string };

const OFF: Policy = { enabled: false, by: "", at: 0 };

/** A missing file is off. An unreadable or malformed one is also off, with the problem named. */
export function readPolicy(bus: string): PolicyRead {
  let text: string;
  try { text = readFileSync(policyPath(bus), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { policy: OFF, problem: null };
    return { policy: OFF, problem: `policy unreadable: ${(error as Error).message}` };
  }
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    if (typeof data.enabled !== "boolean") return { policy: OFF, problem: "policy.json has no boolean 'enabled'" };
    return { policy: { enabled: data.enabled, by: String(data.by ?? ""), at: Number(data.at ?? 0) || 0 }, problem: null };
  } catch (error) {
    return { policy: OFF, problem: `policy.json is not JSON: ${(error as Error).message}` };
  }
}

export function writePolicy(bus: string, policy: Policy): void {
  atomicWrite(policyPath(bus), JSON.stringify({ v: 1, ...policy }) + "\n");
}

export const policyEnabled = (bus: string): boolean => readPolicy(bus).policy.enabled;

export type Activity = { active: true } | { active: false; reason: "watch_unarmed" | "watch_reminders_only" | "watch_unreadable" };

/** Timeouts run only inside a full-mode watch tick (R15). */
export function watchActivity(bus: string): Activity {
  let text: string;
  try { text = readFileSync(join(bus, "watch", "arm.json"), "utf8"); }
  catch (error) {
    return { active: false, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "watch_unarmed" : "watch_unreadable" };
  }
  try {
    const arm = JSON.parse(text) as Record<string, unknown>;
    return arm.mode === "reminders-only" ? { active: false, reason: "watch_reminders_only" } : { active: true };
  } catch { return { active: false, reason: "watch_unreadable" }; }
}

/** The armed tick interval, or null when unarmed or unreadable. */
export function tickInterval(bus: string): number | null {
  try {
    const arm = JSON.parse(readFileSync(join(bus, "watch", "arm.json"), "utf8")) as Record<string, unknown>;
    const value = Number(arm.tick_interval_seconds ?? 60);
    return Number.isFinite(value) ? value : null;
  } catch { return null; }
}

/** Above this interval Hermes's native 300 s denial can end the prompt before TAP observes the expiry. */
export const HERMES_INTERVAL_CEILING = 90;
