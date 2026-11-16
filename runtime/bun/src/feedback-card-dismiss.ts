import { createHash } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { receiptBytes } from "./fsatomic";
import { physicalSocketPath } from "./tmux";

/**
 * The one-shot license for dismissing one observed Claude feedback-draft card
 * with one Escape (tap-89a57). It is keyed by the tmux server socket, the pane,
 * the pane's process and the card's own bytes. It lives under the index home,
 * not a sender's bus, so senders on different buses share it: one card gets at
 * most one Escape from any sender. A card still up after that Escape holds until
 * a person acts. A different card, such as a new draft, is a new observation.
 */
export interface CardObservation { paneId: string; panePid: string; card: string }

function licensePath(observation: CardObservation, env: NodeJS.ProcessEnv): string {
  const key = createHash("sha256")
    .update(`${physicalSocketPath(env)}\0${observation.paneId}\0${observation.panePid}\0${observation.card}`).digest("hex");
  return join(env.TAP_INDEX_HOME || join(env.HOME || homedir(), ".tap"), "feedback-card-dismiss", `${key}.json`);
}

/** True when this card observation has already spent its Escape. Unreadable state counts as spent. */
export function cardDismissSpent(observation: CardObservation, env: NodeJS.ProcessEnv = process.env): boolean {
  try { lstatSync(licensePath(observation, env)); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}

/** Mint the license before the key: `created` licenses exactly one Escape; `existing` licenses none. */
export function beginCardDismiss(observation: CardObservation, fields: { pane: string; id: string },
  env: NodeJS.ProcessEnv = process.env): "created" | "existing" {
  const destination = licensePath(observation, env);
  const directory = join(destination, "..");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.dismiss.${process.pid.toString(36)}.${Math.random().toString(36).slice(2, 10)}`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, receiptBytes({ id: fields.id, effect: "possible", label: "Escape to dismiss a Claude feedback-draft card (no bytes)",
        pane: fields.pane, pane_id: observation.paneId, pane_pid: observation.panePid }));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    try { linkSync(temporary, destination); return "created"; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return "existing"; throw error; }
  } finally { try { unlinkSync(temporary); } catch { /* the link holds the license */ } }
}
