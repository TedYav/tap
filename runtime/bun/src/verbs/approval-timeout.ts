// `tap approval-timeout on|off|status [--json] [--team <name>]` — the team's opt-in
// for declining an approval request no one answered (tap-rlebf.2). The pass runs in
// the watch tick; this verb only writes and reads the team policy.
import { TapError, callingPane, resolveSelf } from "../context";
import {
  APPROVAL_HARNESSES, DEFAULT_TIMEOUT_SECONDS, HERMES_INTERVAL_CEILING, readPolicy, rowLive, tickInterval,
  watchActivity, writePolicy,
} from "../approval-timeout-policy";
import { cancelOpenEpisodes, readEpisodes } from "../approval-timeout";
import { applyTeamOverride } from "../team-override";
import { resolveSelection } from "../team-selection";

const HELP = "tap help approval-timeout";
const USAGE = "usage: tap approval-timeout <on|off|status> [--json] [--team <name>]";

function usage(detail: string): never { throw new TapError(1, "usage_error", HELP, `${detail}; ${USAGE}`); }

function warnings(bus: string): string[] {
  const out: string[] = [];
  const activity = watchActivity(bus);
  if (!activity.active) {
    out.push(activity.reason === "watch_reminders_only"
      ? "the team's watch is armed for reminders only, so no timeout runs until it is armed in full (tap watch on)"
      : activity.reason === "watch_unarmed"
        ? "the team's watch is not armed, so no timeout runs until it is (tap watch on)"
        : "the team's watch record is unreadable, so no timeout runs; next: tap watch status");
  }
  const interval = tickInterval(bus);
  if (activity.active && interval !== null && interval > HERMES_INTERVAL_CEILING) {
    out.push(`the watch tick interval is ${interval}s; above ${HERMES_INTERVAL_CEILING}s Hermes's own 300s denial may end a prompt before TAP sees it expire`);
  }
  return out;
}

export function cmdApprovalTimeout(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  let op = "", team = "", json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") json = true;
    else if (a === "--team") {
      const value = argv[++i];
      if (value === undefined || value === "") usage("--team needs a name");
      team = value;
    } else if (a.startsWith("-")) usage(`unknown option '${a}'`);
    else if (op === "") op = a;
    else usage("unexpected argument");
  }
  if (op !== "on" && op !== "off" && op !== "status") usage(op === "" ? "missing subcommand" : `unknown subcommand '${op}'`);
  if (json) env.TAP_JSON = "1";

  const callerPin = process.env.TAP_HOME ?? "";
  applyTeamOverride(team, { requireExistingBus: true });
  const ctx = resolveSelection(callerPin, team);
  let by = "operator";
  const own = op === "status" ? "" : callingPane(env);
  if (own) { try { by = resolveSelf(ctx, own, 1, env).handle || by; } catch { /* an unregistered caller is the operator */ } }
  const r = approvalTimeoutOn(ctx.bus.home, ctx.team, op, json, by, Math.floor(Date.now() / 1000));
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  return r.rc;
}

/** The verb body over one resolved bus: no context, pane or clock reads. */
export function approvalTimeoutOn(bus: string, team: string, op: "on" | "off" | "status", json: boolean, by: string, now: number): { rc: number; stdout: string; stderr: string } {
  let stdout = "", stderr = "";
  const ctx = { team };
  if (op === "on" || op === "off") {
    const current = readPolicy(bus);
    const enabled = op === "on";
    if (current.problem !== null || current.policy.enabled !== enabled) writePolicy(bus, { enabled, by, at: now });
    const cancelled = enabled ? 0 : cancelOpenEpisodes(bus, now);
    if (cancelled === null) throw new TapError(1, "lock_busy", "retry tap approval-timeout off", "the policy is off, but the open-request store was busy; the next tick's gate still sends no key");
    const notes = enabled ? warnings(bus) : [];
    if (json) {
      stdout += JSON.stringify({ team: ctx.team, enabled, by, cancelled, warnings: notes }) + "\n";
    } else {
      stdout += enabled
        ? `tap approval-timeout: on for team ${ctx.team}\n`
        : `tap approval-timeout: off for team ${ctx.team}; ${cancelled} open request(s) cancelled\n`;
      for (const note of notes) stderr += `tap approval-timeout: warning: ${note}\n`;
    }
    return { rc: 0, stdout, stderr };
  }

  const read = readPolicy(bus);
  if (read.problem !== null) stderr += `tap approval-timeout: ${read.problem}; reading it as off\n`;
  let open = 0;
  try { open = Object.values(readEpisodes(bus)).filter(e => e.state === "open").length; }
  catch (error) { stderr += `tap approval-timeout: open requests unreadable: ${(error as Error).message}\n`; }
  const activity = watchActivity(bus);
  const notes = read.policy.enabled ? warnings(bus) : [];
  const harnesses = APPROVAL_HARNESSES.map(h => ({ harness: h, timeout_seconds: DEFAULT_TIMEOUT_SECONDS[h], row: rowLive(h) ? "live" : "pending_capture" }));
  if (json) {
    stdout += JSON.stringify({
      team: ctx.team, enabled: read.policy.enabled, by: read.policy.by || null,
      at: read.policy.at ? new Date(read.policy.at * 1000).toISOString() : null,
      active: read.policy.enabled && activity.active,
      inactive_reason: !read.policy.enabled ? "policy_off" : activity.active ? null : activity.reason,
      harnesses, open_requests: open, warnings: notes,
    }) + "\n";
    return { rc: 0, stdout, stderr };
  }
  const set = read.policy.at ? ` (set by ${read.policy.by || "unknown"} at ${new Date(read.policy.at * 1000).toISOString()})` : "";
  const rows = [
    `approval-timeout: ${read.policy.enabled ? "on" : "off"}${set}`,
    `team: ${ctx.team}`,
    "",
    "HARNESS   TIMEOUT  ROW",
    ...harnesses.map(h => `${h.harness.padEnd(9)} ${`${h.timeout_seconds}s`.padEnd(8)} ${h.row === "live" ? "live" : "pending capture (reports blocked, sends no key)"}`),
    "",
    `open requests: ${open}`,
  ];
  stdout += rows.join("\n") + "\n";
  for (const note of notes) stderr += `tap approval-timeout: warning: ${note}\n`;
  return { rc: 0, stdout, stderr };
}
