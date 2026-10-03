#!/usr/bin/env bun
// Scheduled proof of a completed goalie tick: no model or TAP machinery.
// Bun is required; this leaf cannot diagnose its own missing interpreter.
// Installation belongs to the operator. Only the notifier is a child process.
import { readFileSync, statSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { notificationAvailability, sendNotification } from "../notifications";
import { pythonInt } from "../pyint";
import { acquireFlock } from "../remind-lock";

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function seconds(text: string, signed = false): number | null {
  if (!(signed ? /^[+-]?[0-9]+$/ : /^[0-9]+$/).test(text) || text.includes("\n")) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

function intervalSeconds(value: unknown): number {
  let interval = 60;
  if (typeof value === "number" && value) interval = Math.trunc(value);
  else if (typeof value === "string" && value) interval = Number(pythonInt(value, true) ?? NaN);
  else if (value === true) interval = 1;
  return Number.isSafeInteger(interval) && Number.isSafeInteger(interval * 3) ? interval : 60;
}

// The cron door stays import.meta.main; the named export lets the port drive
// main(argv) in-process with only the notifier left as a child process.
export async function main(argv: string[]): Promise<number> {
  let home = process.env.TAP_HOME || "", maxAgeText = "", quiet = false;
  const usageError = (message: string, status = 64) => {
    process.stderr.write(`tap-goalie-heartbeat: ${message}\n`);
    return status;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--home":
      case "--max-age": {
        const value = argv[++i];
        if (!value) return usageError(`${arg} needs ${arg === "--home" ? "a path" : "seconds"}`, 1);
        if (arg === "--home") home = value;
        else maxAgeText = value;
        break;
      }
      case "--quiet": quiet = true; break;
      case "-h":
      case "--help":
        console.log("usage: goalie-heartbeat.ts [--home <TAP_HOME>] [--max-age <seconds>] [--quiet]");
        console.log("  Ages the goalie tick stamp and wakes the human when it stops. No LLM, no bus.");
        console.log("  Exit 2 with notifier-unavailable: armed, but no usable notifier could deliver an alarm.");
        return 0;
      default: return usageError(`unexpected arg '${arg}'`);
    }
  }
  if (!home) return usageError("set TAP_HOME or pass --home");
  const say = (message: string) => { if (!quiet) console.log(`tap-goalie-heartbeat: ${message}`); };
  const armPath = join(home, "goalie/arm.json"), stampPath = join(home, "goalie/heartbeat");
  // Disarmed takes precedence over clock/limit validation and notifier discovery.
  if (!isFile(armPath)) { say("goalie is disarmed; nothing to watch"); return 0; }
  // An armed watchdog that cannot reach the human fails loud now, not at its
  // first alarm. Written unconditionally: --quiet must not hide a misconfiguration.
  let notifierProblem = "";
  try {
    const notifier = notificationAvailability(process.env);
    if (!notifier.available) notifierProblem = `notifier '${notifier.requested}' not found`;
  } catch (error) { notifierProblem = error instanceof Error ? error.message : String(error); }
  if (notifierProblem) return usageError(`notifier-unavailable: ${notifierProblem}; alarms cannot reach the human`, 2);

  const now = seconds(process.env.TAP_GOALIE_NOW || String(Math.floor(Date.now() / 1000)), true);
  if (now === null) return usageError("TAP_GOALIE_NOW must be safe integer decimal seconds");
  const override = maxAgeText ? seconds(maxAgeText, true) : undefined;
  if (override === null) return usageError("--max-age must be safe integer decimal seconds");
  let arm: Record<string, unknown> = {};
  try {
    // Keep BOM visible to JSON.parse and reject invalid UTF-8, as Python did.
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(armPath)));
    if (value && typeof value === "object" && !Array.isArray(value)) arm = value;
  } catch { /* An unreadable interval uses the incumbent's 60-second fallback. */ }
  const interval = intervalSeconds(arm.tick_interval_seconds);
  const maxAge = override ?? Math.max(300, interval * 3);
  const alarmPath = join(home, "goalie/heartbeat-alarm.json");
  // New arms carry a nonce even when two episodes share one epoch second.
  // An already-running pre-nonce arm stays one unversioned episode until rearm.
  const generation = typeof arm.alarm_generation === "string" ? arm.alarm_generation : "";
  const reminderSeconds = 3600;
  type AlarmState = { generation: string; attempted_at: number; status: 1 | 2 };
  const publish = (state: AlarmState) => {
    const temporary = `${alarmPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state) + "\n", { mode: 0o600 });
    renameSync(temporary, alarmPath);
  };
  // A kernel-held leaf lock serializes scheduler invocations and disappears on
  // process exit. It has no dependency on the detector or its delivery path.
  let lock: ReturnType<typeof acquireFlock>;
  try { lock = acquireFlock(alarmPath + ".lock", 0, true); }
  catch { say("alarm-state-unreadable: cannot lock notification state; no notification attempted"); return 2; }
  if (!lock) { say("alarm-state-busy: another watchdog invocation owns notification state"); return 2; }
  try {
    const alarm = async (detail: string): Promise<number> => {
      say(`STALE — ${detail}`);
      let prior: AlarmState | undefined;
      try {
        const raw: unknown = JSON.parse(readFileSync(alarmPath, "utf8"));
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid alarm state");
        const value = raw as Record<string, unknown>;
        if (typeof value.generation !== "string" || !Number.isSafeInteger(value.attempted_at) ||
            (value.status !== 1 && value.status !== 2)) throw new Error("invalid alarm state");
        prior = value as AlarmState;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          say("alarm-state-unreadable: preserving notification evidence; no notification attempted");
          return 2;
        }
      }
      if (prior?.generation === generation) {
        const elapsed = now - prior.attempted_at;
        if (!Number.isSafeInteger(elapsed) || elapsed < 0) {
          say("alarm-clock-invalid: last attempt is ahead of the clock; no notification attempted");
          return 2;
        }
        if (elapsed < reminderSeconds) {
          say(`notification suppressed; next reminder in ${reminderSeconds - elapsed}s; previous attempt ${prior.status === 1 ? "accepted" : "unconfirmed"}`);
          return prior.status;
        }
      }
      // Record an unconfirmed attempt BEFORE the possible external effect. A
      // crash or notifier timeout must not authorize an immediate second attempt.
      const attempted: AlarmState = { generation, attempted_at: now, status: 2 };
      try { publish(attempted); }
      catch { say("alarm-state-unwritable: no notification attempted"); return 2; }
      try {
        await sendNotification({ title: "TAP goalie heartbeat", urgent: false,
          body: `TAP goalie tick is not running: ${detail} — the board has no deadlock detector right now` }, process.env);
      } catch (error) {
        say(`notification unconfirmed: ${error instanceof Error ? error.message : error}`);
        return 2;
      }
      try { publish({ ...attempted, status: 1 }); }
      catch { say("alarm-state-unwritable: notification accepted but result could not be recorded"); return 2; }
      return 1;
    };
    if (!isFile(stampPath)) {
      const armedAt = arm.armed_at === null ? "None" : arm.armed_at === true ? "True" : arm.armed_at === false ? "False" : String(arm.armed_at ?? "");
      return await alarm(`armed since ${armedAt.replace(/\n+$/, "")} but has never completed a fire`);
    }
    let text = "";
    try { text = readFileSync(stampPath, "utf8").split("\n", 1)[0] ?? ""; } catch { /* Alarm below. */ }
    const stamp = seconds(text);
    if (stamp === null) return await alarm(`stamp file is unreadable ('${text}')`);
    const age = now - stamp;
    if (!Number.isSafeInteger(age)) return await alarm("stamp age is outside the safe integer range");
    if (age < 0) return await alarm(`stamp is in the future (clock skew: ${age}s)`);
    if (age > maxAge) return await alarm(`last fire was ${age}s ago (limit ${maxAge}s, tick interval ${interval}s)`);
    try { unlinkSync(alarmPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        say("alarm-state-unwritable: healthy tick could not reset notification state");
        return 2;
      }
    }
    say(`ok — last fire ${age}s ago (limit ${maxAge}s)`);
    return 0;
  } finally { lock.release(); }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
