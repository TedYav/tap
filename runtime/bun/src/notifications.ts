/** One selected notification transport, one attempt. Acceptance is not a read receipt. */
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import { TapError } from "./context";
import { configDirectory, readCatalog, table } from "./config-file";

export interface NotificationSettings {
  notifier: "system" | "command";
  source: "default" | "config" | "override";
  command?: string[];
  legacy?: string;
  seconds: number;
}
export interface Notification { title: string; body: string; urgent: boolean }
/** Existing watcher CLI overrides, already validated by its parser. */
export interface NotificationOverride { command?: string[]; seconds?: number }
const HELP = "tap help escalate";
const invalid = (detail: string): never => { throw new TapError(1, "notify_config_invalid", HELP, detail); };

export function notificationSettings(env: NodeJS.ProcessEnv): NotificationSettings {
  let settings: NotificationSettings;
  // The explicit override is also the runners' unconditional safety muzzle.
  // It bypasses machine config, including a broken config during an incident.
  if (env.TAP_NOTIFY_USER_BIN) {
    settings = { notifier: "command", source: "override", legacy: env.TAP_NOTIFY_USER_BIN, seconds: 20 };
  } else {
    let value: unknown;
    try { value = readCatalog(join(configDirectory(env), "config.toml")).data.notifications; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") invalid(`cannot read notification config: ${error instanceof Error ? error.message : error}`);
    }
    settings = notificationConfig(value);
  }
  if (env.TAP_NOTIFY_TIMEOUT_SECONDS) {
    if (!/^\d+$/.test(env.TAP_NOTIFY_TIMEOUT_SECONDS)) invalid("TAP_NOTIFY_TIMEOUT_SECONDS must be a positive integer");
    settings.seconds = Number(env.TAP_NOTIFY_TIMEOUT_SECONDS);
  }
  validateNotificationSettings(settings);
  return settings;
}

/** Parse notifier config without reading files, sending, or applying environment overrides. */
export function notificationConfig(value: unknown): NotificationSettings {
  if (value !== undefined && !table(value)) invalid("notifications must be a TOML table");
  const config = (value ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (!["notifier", "command", "timeout_seconds"].includes(key)) invalid(`unknown notifications.${key}`);
  }
  const notifier = config.notifier ?? "system";
  if (notifier !== "system" && notifier !== "command") invalid('notifications.notifier must be "system" or "command"');
  const command = config.command;
  if (command !== undefined && (!Array.isArray(command) || !command.length ||
      command.some(arg => typeof arg !== "string" || arg.includes("\0")) || !command[0])) {
    invalid("notifications.command must be a nonempty array of strings with a nonempty executable and no NUL bytes");
  }
  if (notifier === "command" && command === undefined) invalid("notifications.command is required for the command notifier");
  if (Array.isArray(command)) {
    for (const [index, arg] of command.entries()) {
      if (/[{}]/.test(arg) && (index === 0 || !["{title}", "{body}", "{urgency}"].includes(arg))) {
        invalid("notification placeholders must be whole argument tokens: {title}, {body}, {urgency}; the executable is literal");
      }
    }
  }
  return { notifier: notifier as "system" | "command", source: value === undefined ? "default" : "config",
    command: command as string[] | undefined, seconds: config.timeout_seconds === undefined ? 20 : config.timeout_seconds as number };
}

export function validateNotificationSettings(settings: NotificationSettings): void {
  if (!Number.isInteger(settings.seconds) || settings.seconds < 1 || settings.seconds > 2147483) {
    invalid("notification timeout must be an integer from 1 through 2147483 seconds");
  }
}

const APPLESCRIPT = "on run argv\n display notification (item 2 of argv) with title (item 1 of argv)\nend run";

/** This projection is shared by doctor and execution; it performs no notification. */
export function notificationCommand(settings: NotificationSettings, notice: Notification, platform: string = process.platform): string[] {
  if (settings.legacy) return [settings.legacy, "--template", "question", ...(notice.urgent ? ["--priority", "urgent"] : []), "--", notice.body];
  if (settings.notifier === "command") {
    const values: Record<string, string> = { "{title}": notice.title, "{body}": notice.body, "{urgency}": notice.urgent ? "urgent" : "routine" };
    return settings.command!.map(arg => Object.hasOwn(values, arg) ? values[arg]! : arg);
  }
  if (platform === "darwin") return ["osascript", "-e", APPLESCRIPT, "--", notice.title, notice.body];
  if (platform === "linux") return ["notify-send", "--urgency", notice.urgent ? "critical" : "normal", "--", notice.title, notice.body];
  throw new TapError(2, "notify_user_missing", HELP, `system notifications are unavailable on ${platform}; configure notifications.notifier=command`);
}

export function notificationAvailability(env: NodeJS.ProcessEnv, platform: string = process.platform) {
  const settings = notificationSettings(env);
  const requested = notificationCommand(settings, { title: "TAP escalation", body: "", urgent: false }, platform)[0]!;
  const executable = Bun.which(requested, { PATH: env.PATH });
  const limitation = settings.notifier === "system"
    ? platform === "darwin"
      ? "osascript notifications need the terminal app's notification permission; acceptance does not prove display or human receipt"
      : "notify-send needs a desktop notification service/session; acceptance does not prove display or human receipt"
    : "command exit 0 reports notifier acceptance, not human receipt";
  return { notifier: settings.notifier, source: settings.source, requested, executable, available: !!executable, limitation };
}

type NotifyResult = { kind: "exit" | "timeout" | "cancelled" | "spawn"; code: number };

/** Own the process group; a deadline or caller cancellation kills resistant descendants. */
async function runNotification(bin: string, argv: string[], env: NodeJS.ProcessEnv, milliseconds: number): Promise<NotifyResult> {
  return new Promise((done) => {
    const childEnv = { ...env };
    delete childEnv.BUN_BE_BUN;
    const child = spawn(bin, argv, { env: childEnv, detached: true, stdio: ["ignore", 2, 2] });
    let stopped: NotifyResult | undefined;
    const kill = (result: NotifyResult) => {
      stopped ??= result;
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } }
    };
    const signals = { SIGINT: () => kill({ kind: "cancelled", code: 130 }), SIGTERM: () => kill({ kind: "cancelled", code: 143 }), SIGHUP: () => kill({ kind: "cancelled", code: 129 }) };
    for (const signal of Object.keys(signals) as (keyof typeof signals)[]) process.on(signal, signals[signal]);
    const timer = setTimeout(() => kill({ kind: "timeout", code: 2 }), milliseconds);
    const finish = (result: NotifyResult) => {
      clearTimeout(timer);
      for (const signal of Object.keys(signals) as (keyof typeof signals)[]) process.off(signal, signals[signal]);
      done(stopped ?? result);
    };
    child.once("error", error => finish({ kind: "spawn", code: (error as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 126 }));
    child.once("exit", (code, signal) => finish({ kind: "exit", code: code ?? (signal ? 128 + osConstants.signals[signal] : 1) }));
  });
}

export async function sendNotification(notice: Notification, env: NodeJS.ProcessEnv, override: NotificationOverride = {}): Promise<void> {
  notice = { ...notice, title: notice.title.replaceAll("\0", "\\0"), body: notice.body.replaceAll("\0", "\\0") };
  const settings: NotificationSettings = override.command
    ? { notifier: "command", source: "override", command: override.command, seconds: 20 }
    : notificationSettings(env);
  if (override.seconds !== undefined) settings.seconds = override.seconds;
  const [requested, ...args] = notificationCommand(settings, notice);
  const bin = Bun.which(requested!, { PATH: env.PATH });
  if (!bin) throw new TapError(2, "notify_user_missing", HELP, `notifier '${requested}' not found — no notification attempted; configure notifications or install the system notifier`);
  const result = await runNotification(bin, args, env, settings.seconds * 1000);
  if (result.kind === "timeout") throw new TapError(2, "notify_timeout", HELP,
    `notifier did not return within ${settings.seconds}s — delivery is unknown; no retry attempted`);
  if (result.code !== 0) throw new TapError(result.code, "notify_failed", HELP,
    `notifier ${result.kind === "cancelled" ? "was cancelled" : result.kind === "spawn" ? "could not start" : "exited"} (${result.code}) — ${result.kind === "spawn" ? "no notification attempted" : "delivery is unconfirmed"}; no retry attempted`);
}
