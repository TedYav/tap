import { lstatSync, realpathSync, readFileSync } from "node:fs";
import { readStdinByte } from "./stdin-byte";
import { isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import { callingPane, resolveContext, TapError } from "./context";
import { enrolledTeams } from "./index-home";
import { enrolledSeatForPane, loadRegistry, seatMap } from "./registry";
import { gitToplevel, repoRoot, resolveBus } from "./bushome";
import { noTeamMessage } from "./first-run";
import { teamRegistryFileRefusal } from "./register-authority";
import { initArgv } from "./courier-argv";
import { parseRosterOptions } from "./verbs/team";
import { isSeatFilterFlag } from "./seat-filter";
import { tapScriptsDir } from "./scripts-dir";

const LOCAL_VERBS = new Set([
  "team", "poll", "outstanding", "send", "assign", "peek",
  "watch", "goalie", "remind", "recap", "refresh", "compact", "clear",
  "attach", "nudge", "draft", "digest-window", "approval-timeout", "teardown", "restore",
  "unregister", "out", "crew", "session", "register", "in",
]);
const VALUES = new Set([
  "-m", "--message", "-f", "--body-file", "--from", "--by", "--kind", "--pane",
  "--id", "--delivery", "--polite-timeout", "--stale", "--only", "--except",
  "--in", "--at", "--every", "--for", "--threshold", "--interval", "--preset",
  "--model", "--name", "--agent", "--context-threshold", "--probe-timeout", "--chain",
  "--terminal", "--context-exempt", "--evaluator", "--config", "--stale-after",
]);
const FLAGS = new Set(["--names", "--online", "--active", "--all", "--quiet", "--json", "--yes", "--force", "--hard", "--kill", "--keep-self", "--ask", "--expect-reply", "--fyi", "--note", "--no-spool", "--urgent", "--wake", "--verbose", "--rearm", "--stalled"]);
const REGISTER_VALUES = new Set(["--mode", "--include", "--digest-window", "--wake-url", "--restore"]);
const REGISTER_FLAGS = new Set(["--offline", "--crew", "--unattended", "--include-asks", "--fresh", "--accept-observed-identity"]);
const AUTHORITY = new Set(["--cwd", "--machine", "--dry-run", "--team", "--payload", "--remote-registry", "--cross-worktree", "--reply-to", "--in-reply-to"]);

/** Only local command forms: payload references and machine-wide verbs own other authority. */
export function localCommand(argv: string[]): { json: boolean; bodyStdin: boolean } | null {
  const verb = argv[0] ?? "";
  if (!LOCAL_VERBS.has(verb)) return null;
  if (verb === "team" && (argv.includes("--offline") || argv.some(isSeatFilterFlag))) {
    try {
      const options = parseRosterOptions(argv.slice(1));
      return options.team ? null : { json: options.json, bodyStdin: false };
    } catch (error) {
      if (error instanceof TapError) return null;
      throw error;
    }
  }
  const registration = verb === "register" || verb === "in";
  let json = false, bodyStdin = false;
  const positional: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (["help", "-h", "--help"].includes(arg)) return null;
    if (AUTHORITY.has(arg) || [...AUTHORITY].some(flag => arg.startsWith(`${flag}=`))) return null;
    if (VALUES.has(arg) || (registration && REGISTER_VALUES.has(arg))) {
      const value = argv[++i];
      if (value === undefined) return null;
      if ((arg === "-f" || arg === "--body-file") && value === "-") bodyStdin = true;
    } else if (arg === "--json") json = true;
    else if (!arg.startsWith("-")) positional.push(arg);
    else if (!FLAGS.has(arg) && !(registration && REGISTER_FLAGS.has(arg))) return null;
  }
  if (positional.some(arg => arg.includes("/") || arg.includes(":"))) return null;
  if (verb === "team") {
    if (positional[0] === "list" || (positional[0] === "roster" && positional.length > 1)) return null;
    if (positional.length && !["roster", "refresh", "shutdown", "down", "up", "reset", "restore", "purge", "attach", "detach", "calibration"].includes(positional[0]!)) return null;
    // An explicitly NAMED lifecycle target is another team's
    // lifecycle, not this cwd's local teardown — never claim it locally, or
    // missingLocalTeam refuses unanchored_bus/tap-init before the named
    // override can run. positional = ["shutdown"|"down"|"up", "<team>"].
    if (["shutdown", "down", "up"].includes(positional[0]!) && positional.length > 1) return null;
  }
  // fork needs an existing seat, so first-run onboarding never applies; its own door refuses an unenrolled checkout.
  if (verb === "session" && !["launch", "resume", "restart", "relaunch", "repair"].includes(positional[0] ?? "")) return null;
  if ((verb === "send" || verb === "assign") && positional.length !== 1) return null;
  return { json, bodyStdin };
}

function absent(path: string): boolean {
  try { lstatSync(path); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}

/** Absence is positive evidence, never an unreadable/corrupt enrollment. */
export function missingLocalTeam(cwd = process.cwd(), env = process.env): boolean {
  if (env.TAP_HOME) return false;
  try {
    const ctx = resolveContext(cwd, env, { paneFallback: false });
    return absent(ctx.registryPath) && absent(join(ctx.root, ".tap", "team-registry.json"));
  } catch (error) {
    if (!(error instanceof TapError) || error.errorClass !== "unanchored_bus") return false;
    const root = repoRoot(cwd);
    const bus = resolveBus(root, env);
    return bus.rule !== "old_store" && absent(join(bus.home, "registry.json")) && absent(join(root, ".tap", "team-registry.json"));
  }
}

/** Defer existing identity/actor remedies; this never selects or grants a bus. */
function hasRegisteredActor(argv: string[]): boolean {
  const actors = new Set<string>();
  if (process.env.TAP_SELF) actors.add(process.env.TAP_SELF);
  if (["poll", "outstanding", "peek"].includes(argv[0] ?? "") && argv[1] && !argv[1].startsWith("-")) actors.add(argv[1]);
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (VALUES.has(arg)) {
      const value = argv[++i];
      if ((arg === "--from" || arg === "--by") && value) actors.add(value);
    }
  }
  // An old-format registry defers to the command, whose selection refuses it as old_store.
  if (enrolledTeams().some(team => teamRegistryFileRefusal(team.registryLocation))) return true;
  if (actors.size) {
    for (const team of enrolledTeams()) {
      try {
        const seats = seatMap(loadRegistry(team.registryLocation));
        if ([...actors].some(actor => Object.hasOwn(seats, actor))) return true;
      } catch { /* Original command owns an unreadable actor's refusal. */ }
    }
  }
  const pane = callingPane();
  return !!pane?.paneId && !!enrolledSeatForPane(pane.paneId);
}

export const INIT_PROMPT = "Would you like to run tap init? [Y/n]";

const SCRIPTS = tapScriptsDir();

/** Machine-config choice for a never-init'ed project; every failure means ask. */
export function onboardingInit(env: NodeJS.ProcessEnv = process.env): "ask" | "auto" {
  try {
    const base = env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, ".config") : "");
    if (!isAbsolute(base)) return "ask";
    const doc = Bun.TOML.parse(readFileSync(join(base, "tap/config.toml"), "utf8")) as any;
    if (doc.onboarding !== undefined && (typeof doc.onboarding !== "object" || Array.isArray(doc.onboarding))) return "ask";
    return doc.onboarding?.init === "auto" ? "auto" : "ask";
  } catch { return "ask"; }
}

/** Auto enrollment only where a team root is deliberate: a git root, never $HOME. */
export function autoInitRoot(cwd = process.cwd(), env = process.env): string | undefined {
  if (!env.HOME) return undefined;
  const root = gitToplevel(cwd);
  if (!root) return undefined;
  try { if (root === realpath(env.HOME)) return undefined; } catch { return undefined; }
  return root;
}

function realpath(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/** The auto path never touches the caller's stdin or stdout: one stderr receipt,
 * init output on stderr, and init failure returns its code with no retry. */
export async function autoInitialize(root: string, argv = initArgv(SCRIPTS, ["--no-trust-folders"])): Promise<number> {
  process.stderr.write(`TAP: set up a team for ${root} automatically (onboarding.init = auto).\n`);
  return await new Promise<number>((done, fail) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", 2, "inherit"] });
    child.on("error", fail);
    child.on("close", code => done(code ?? 1));
  });
}

/** Pre-dispatch: no original command effects or body reads can precede consent. */
export async function onboarding(argv: string[], initialize: () => number | Promise<number>): Promise<number | null> {
  const form = localCommand(argv);
  if (!form || !missingLocalTeam()) return null;
  if (hasRegisteredActor(argv)) return null;
  // Auto enrollment precedes every ask/refusal branch, including non-TTY and
  // --json: the agent startup paths this knob exists for have no prompt.
  const autoRoot = onboardingInit() === "auto" ? autoInitRoot() : undefined;
  if (autoRoot !== undefined) {
    const result = await autoInitialize(autoRoot);
    return result === 0 ? null : result;
  }
  // `whoami` is not a LOCAL_VERB, so localCommand() has already returned null for it.
  const code = ["poll", "outstanding", "peek"].includes(argv[0]!) ? 4 : 1;
  const detail = noTeamMessage();
  if (form.json || process.env.TAP_JSON === "1" || form.bodyStdin || !process.stdin.isTTY || !process.stderr.isTTY) {
    // Register already owns noninteractive enrollment and its refusal codes.
    // Offer consent on its interactive path without replacing that existing API.
    if (["register", "in"].includes(argv[0]!)) return null;
    if (form.json || process.env.TAP_JSON === "1") process.stdout.write(`${JSON.stringify({ ok: false, error_class: "unanchored_bus", detail, action: "tap init" })}\n`);
    else process.stderr.write(`${detail}\n`);
    return code;
  }
  process.stderr.write(`${detail}\n${INIT_PROMPT} `);
  // Read exactly one line, without buffering input belonging to the retried command.
  const byte = Buffer.alloc(1);
  let answer = "";
  let newline = false;
  while (readStdinByte(byte) > 0) {
    if (byte[0] === 10) { newline = true; break; }
    answer += byte.toString();
  }
  if (!newline || (answer !== "" && !/^(y|yes)$/i.test(answer.trim()))) return code;
  const result = await initialize();
  return result === 0 ? null : result;
}

if (import.meta.main) {
  process.exitCode = await onboarding(process.argv.slice(2), async () => {
    const child = Bun.spawn(initArgv(SCRIPTS, ["--no-trust-folders"]), { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return await child.exited;
  }) ?? 0;
}
