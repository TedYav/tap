// Compact's observations and diagnostics share the native authority owners.
import { spawnSync } from "node:child_process";
import { TapError, type CallingPaneObservation } from "./context";
import type { Seat } from "./registry";
import { teamRegistryFileRefusal } from "./register-authority";
import { gatherRowsFromEnv, paneHarnessCommand } from "./observe-gather";
import { DEFAULT_AGENT_FAMILIES, harnessFamily } from "./observe";
import { bootId, tmuxReadOnly } from "./tmux";

export function compactNoActor(caller: CallingPaneObservation, registryPath?: string): never {
  let detail = "tap command must run from a registered pane";
  if (caller.state === "inside") {
    // Caller resolution already failed. Only its selected registry may supply
    // a more specific remedy; another team's seats or old store are irrelevant.
    const old = registryPath ? teamRegistryFileRefusal(registryPath) : null;
    if (old) throw new TapError(1, "old_store", old.action, `${detail} (${old.detail})`, "tap command");
  } else detail += ` (caller pane observation: ${caller.state === "outside" ? caller.detail : caller.refusal})`;
  throw new TapError(1, "no_actor", "run 'tap register' to join this team", detail, "tap command");
}

/** Fresh, session-scoped observation; no cached row can authorize pane input. */
export function compactObservedRow(row: Seat, env: NodeJS.ProcessEnv = process.env): string[] {
  const text = (key: string, fallback = "") => typeof row[key] === "string" ? row[key] as string : fallback;
  const pane = text("pane"), session = text("session") || (pane.includes(":") ? pane.split(":", 1)[0]! : "");
  const observedEnv = { ...env, TAP_OBS_SESSION_SCOPE: session, TAP_OBS_HARNESS_FAMILIES: DEFAULT_AGENT_FAMILIES.join(" ") };
  try {
    const nowBoot = bootId(env);
    if (nowBoot) Object.assign(observedEnv, { TAP_OBS_NOW_BOOT_PIN: nowBoot });
    const record = gatherRowsFromEnv([{ key: "0", status: text("status", "active"), delivery: text("delivery", "pane"),
      pane, pane_id: text("pane_id"), session, registered_at: text("registered_at"), row_epoch: text("server_epoch"),
      row_boot: text("boot_id"), harness: text("harness"), status_reason: text("status_reason") }], observedEnv)[0] ?? "";
    return record.split("\x1f").slice(1, 6);
  } catch { return ["unknown", "harness_unobservable", "", "", ""]; }
}

export function compactHarness(pane: string, env: NodeJS.ProcessEnv = process.env): string {
  let shallow = "";
  try { shallow = tmuxReadOnly(["display-message", "-p", "-t", pane, "#{pane_current_command}"], env).stdout.replace(/\n+$/, ""); }
  catch { /* The shared detector may still identify the pane's process tree. */ }
  return harnessFamily(paneHarnessCommand(pane, shallow, DEFAULT_AGENT_FAMILIES, env), DEFAULT_AGENT_FAMILIES);
}

/** style.sh's attention renderer: stderr, even in JSON mode; color only when capable. */
export function attention(verb: string, state: "attention" | "partial" | "degraded", detail: string, next?: string,
  env: NodeJS.ProcessEnv = process.env): void {
  let word: string = state;
  if (env.NO_COLOR === undefined && env.TERM && env.TERM !== "dumb"
    && ((env.CLICOLOR_FORCE !== undefined && env.CLICOLOR_FORCE !== "0") || process.stderr.isTTY)) {
    const tokens = [["setaf", "1"], ["setaf", "3"], ["bold"], ["dim"], ["sgr0"]].map(args =>
      spawnSync("tput", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    if (tokens.every(token => token.status === 0 && token.stdout)) word = `${tokens[1]!.stdout}${state}${tokens[4]!.stdout}`;
  }
  process.stderr.write(`tap ${verb}: ${word}: ${detail}${next === undefined ? "" : `; next: ${next}`}\n`);
}
