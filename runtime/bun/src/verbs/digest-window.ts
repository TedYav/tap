// `tap digest-window <seconds|off> [--include-asks] [--team <name>]` — declare
// your own note window. The native form of `tap-digest-window.sh`: validate,
// bind the acting registry, resolve the calling pane's own handle, write the
// `[delivery.overrides."team/handle"]` table through the one window writer.
import { TapError, callingPane, resolveContext, resolveSelf } from "../context";
import { LauncherError } from "../config-error";
import { DigestWindowError, driverConfigPath, updateConfig, windowSeconds } from "../digest-window";
import { applyTeamOverride } from "../team-override";
import { resolveSelection } from "../team-selection";

const USAGE = "tap help digest-window";

/** The fatal UTF-8 decoder's refusal, and nothing else: any other TypeError is a bug and must surface. */
export const isInvalidUtf8 = (error: unknown): boolean =>
  error instanceof TypeError && (error as NodeJS.ErrnoException).code === "ERR_ENCODING_INVALID_ENCODED_DATA";

export function cmdDigestWindow(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  const [window = "", ...rest] = argv;
  let includeAsks = false, team = "";
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--include-asks") includeAsks = true;
    else if (a === "--team") {
      const value = rest[++i];
      if (value === undefined || value === "") throw new TapError(1, "usage_error", USAGE, "--team needs a name");
      team = value;
    } else throw new TapError(1, "usage_error", USAGE, "unexpected argument");
  }
  // The incumbent validated before touching any registry: the digest-window script's validate mode
  // printed `tap digest-window: window must be off or …` and exited 1.
  let seconds: number | null;
  try { seconds = windowSeconds(window); }
  catch (error) { process.stderr.write(`tap digest-window: ${(error as Error).message}\n`); return 1; }

  // Caller pin > --team > cwd walk, in ONE place for both gates (rule 56:
  // the identical source edit at a second gate is not a control for it).
  // Read the pin BEFORE the override, which sets TAP_HOME itself.
  const callerPin = process.env.TAP_HOME ?? "";
  applyTeamOverride(team, { requireExistingBus: true });
  const ctx = resolveSelection(callerPin, team);
  const own = callingPane(env);
  if (!own) throw new TapError(1, "identity_unavailable", "tap in", "declare your own window from a registered pane");
  const self = resolveSelf(ctx, own, 1, env);
  if (!self.handle) throw new TapError(1, "identity_unavailable", "tap in", "declare your own window from a registered pane");

  const cfg = driverConfigPath(env);
  if (cfg === null) throw new TapError(1, "config_update_failed", "tap digest-window", "an absolute HOME or XDG_CONFIG_HOME is required");
  try { updateConfig(cfg, `${ctx.team}/${self.handle}`, seconds, includeAsks, env); }
  catch (error) {
    // The incumbent's bytes: `digest_window.py` printed `tap digest-window: <error>` and exited 1.
    if (error instanceof DigestWindowError) { process.stderr.write(`tap digest-window: ${error.message}\n`); return 1; }
    // The config read's own refusals keep their class, detail and recovery action, and the
    // router renders them (human `; next:` line, or the JSON envelope under TAP_JSON=1).
    if (error instanceof LauncherError) {
      throw new TapError(1, error.errorClass ?? "config_update_failed", error.action ?? "tap digest-window", error.detail ?? error.message);
    }
    if (isInvalidUtf8(error)) {
      throw new TapError(1, "preset_config_invalid", `fix ${cfg}`, `invalid preset config ${cfg}: ${(error as Error).message}`);
    }
    throw error;
  }
  process.stdout.write(`tap digest-window: ${ctx.team}/${self.handle} window=${window} include-asks=${includeAsks ? 1 : 0}\n`);
  return 0;
}

if (import.meta.main) {
  try { process.exit(cmdDigestWindow(process.argv.slice(2))); }
  catch (error) {
    if (error instanceof TapError) {
      process.stderr.write(`tap digest-window: ${error.detail}; next: ${error.action}\n`);
      process.exit(error.code);
    }
    throw error;
  }
}
