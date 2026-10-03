/** Delivery-seat observation: a ready idle seat is healthy until work is overdue. */
import * as fs from "node:fs";
import { envelopeBodyBytes, envelopeField } from "./envelope";
import { Bus } from "./bus";

type RecordValue = Record<string, unknown>;
const record = (v: unknown): v is RecordValue => v !== null && typeof v === "object" && !Array.isArray(v);
export type DeliveryHealth = { status: "healthy" } | { status: "degraded"; reason: string };
export interface DeliveryObservation {
  home: string;
  team: string;
  observer: string;
  seat: unknown;
  judgeSeats: unknown;
  now: number;
  staleSeconds: number;
  authoredAge: string | undefined;
  state(): { status: number; stdout: string };
}

export function goalieDeliveryHealth(input: DeliveryObservation): DeliveryHealth {
  const degraded = (reason: string): DeliveryHealth => ({ status: "degraded", reason });
  const { home, observer, seat, now, staleSeconds } = input;
  if (!record(seat) || (seat.status ?? "active") !== "active" || seat.delivery === "poll" ||
      seat.status_reason === "launching" || !seat.pane) return degraded("delivery seat is not active and pane-backed");
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(staleSeconds) || staleSeconds < 0) return degraded("invalid observation clock or stale window");
  let state: ReturnType<DeliveryObservation["state"]>;
  try { state = input.state(); } catch { return degraded("delivery-seat state read failed"); }
  const stateName = state.stdout.trim();
  if (state.status !== 0 || !["working", "idle-at-prompt"].includes(stateName)) {
    return degraded(`delivery-seat state=${state.status === 0 ? stateName || "unknown" : "unreadable"}`);
  }

  let overdue = "";
  // Read pending judge work BEFORE the ordinary per-seat pass can reset it.
  if (!record(input.judgeSeats)) return degraded("judge obligations unreadable");
  for (const [handle, duty] of Object.entries(input.judgeSeats)) {
    if (!record(duty)) return degraded("judge obligation unreadable");
    if (!["sending", "queued", "injected", "pending"].includes(String(duty.request_status ?? ""))) continue;
    const started = Number(duty.episode_started_at ?? 0), verdict = Number(duty.verdict_at ?? 0);
    if (!Number.isSafeInteger(started) || !Number.isSafeInteger(verdict)) return degraded("judge obligation clock unreadable");
    if (started > 0 && verdict < started && now - started >= staleSeconds) overdue = `judge=${handle}`;
  }

  let recentReply = false;
  const bus = new Bus(home);
  const seen = new Set<string>();
  try {
    // Snapshot bytes and timestamp through one descriptor. A spool publication
    // may move the pathname at any time; its canonical successor is the fallback.
    const snapshot = (dir: string, name: string): { bytes: Buffer; epoch: number } => {
      let fd: number;
      try { fd = fs.openSync(`${home}/${dir}/${name}`, "r"); }
      catch (error) {
        if (dir !== "spool" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        fd = fs.openSync(`${home}/payloads/${name}`, "r");
      }
      try { return { bytes: fs.readFileSync(fd), epoch: Math.floor(fs.fstatSync(fd).mtimeMs / 1000) }; }
      finally { fs.closeSync(fd); }
    };
    for (const dir of ["spool", "payloads"]) {
      // Bus directories are created on first use. Absence is an empty inbox;
      // permission/type failures remain failed observations.
      let names: string[];
      try { names = fs.readdirSync(`${home}/${dir}`); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (!fs.statSync(home).isDirectory()) throw error;
        names = [];
      }
      for (const name of names) {
        if (!name.endsWith(".md") || name.startsWith("_") || name.startsWith(".") || seen.has(name)) continue;
        const { bytes, epoch } = snapshot(dir, name);
        seen.add(name);
        const body = envelopeBodyBytes(bytes);
        if (body === null) throw new Error("invalid envelope");
        // TAP bodies are arbitrary bytes. Only routing headers are text; an
        // unrelated binary payload must not disable delivery observation.
        const header = bytes.subarray(0, bytes.length - body.length);
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(header);
        const field = (key: string) => envelopeField(text, key) ?? "";
        const localSender = !field("from_team") || field("from_team") === input.team;
        const localTarget = !field("to_team") || field("to_team") === input.team;
        const currentSender = typeof seat.instance === "string" && seat.instance !== "" && field("sender_instance") === seat.instance;
        const currentTarget = !seat.instance || !field("recipient_instance") || field("recipient_instance") === seat.instance;
        // Supervisor-authored wakes sent FROM the goalie are not seat progress.
        // Only an actual reply reference can supply bus-side progress evidence.
        if (field("from") === observer && localSender && currentSender && field("in_reply_to") &&
            now - epoch >= 0 && now - epoch < staleSeconds) recentReply = true;
        if (field("to") !== observer || !localTarget || !currentTarget || field("reply") !== "expected") continue;
        if (bus.isDone(name.slice(0, -3))) continue;
        if (now - epoch >= staleSeconds) overdue = `wake=${name.slice(0, -3)}`;
      }
    }
  } catch { return degraded("delivery obligations or reply evidence unreadable"); }

  if (!overdue) return { status: "healthy" };
  const age = input.authoredAge;
  const progress = age !== undefined && /^\d+$/.test(age) && Number(age) < staleSeconds;
  if (progress || recentReply) return { status: "healthy" };
  return degraded(`${overdue} overdue without self-authored progress or a reply`);
}
