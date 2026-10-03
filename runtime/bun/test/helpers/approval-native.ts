// The native courier over its production draft effects, driven through a
// PATH tmux whose pane is a state file. Shared by approval-delivery and the
// per-harness no-approve suite (tap-rlebf.1).
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export const wire = "[[TAP v0.23 note approval-held]]";
const repo = new URL("../../../../", import.meta.url).pathname;
// The clobber door's Bun effects spawn the LITERAL tmux binary through PATH, so
// alongside the shell function (whose display-message arms answer lib.sh's own
// registry observation) the probe installs a PATH-executable tmux whose pane is
// a state file: capture reads it, C-u/Enter clear it, a literal inject writes it.
const doorTmux = [
  "#!/usr/bin/env bash",
  "set -u",
  'T="${TAP_HOME:?}"',
  'S="$T/pane-state"',
  'while [ $# -ge 3 ] && { [ "$1" = "-L" ] || [ "$1" = "-S" ]; }; do shift 2; done',
  'case "$1" in',
  '  capture-pane) [ -f "$S" ] || exit 1; if [ -n "${APPEARS:-}" ] && [ -f "$T/captured" ]; then printf %s "$APPEARS"; else touch "$T/captured"; cat "$S"; fi ;;',
  "  display-message) case \"${@: -1}\" in",
  "    *pane_in_mode*) printf '0\\n' ;;",
  "    *pane_id*pane_current_command*) printf '%%1\\tfixture\\t4242\\t%s\\t0\\n' \"$HARNESS\" ;;",
  "    *pane_id*session_name*) printf '%%1\\tfixture\\t4242:100\\n' ;;",
  "    *pane_current_command*) printf '%s\\n' \"$HARNESS\" ;;",
  "    *pane_id*) printf '%%1\\n' ;;",
  "    *'#{pid}:#{start_time}'*) printf '4242:100\\n' ;;",
  "    *pane_width*) printf '120\\n' ;;",
  "    *) printf 'fixture\\n' ;;",
  "  esac ;;",
  "  send-keys)",
  '    printf \'%s\\n\' "$*" >> "$T/effects"',
  "    case \"${@: -1}\" in",
  "      C-u|BSpace|Enter) cat \"$T/pane-empty\" > \"$S\" ;;",
  "      *) case \" $* \" in *' -l '*) printf '%s' \"$STAGED\" > \"$S\" ;; esac ;;",
  "    esac ;;",
  "  *) exit 0 ;;",
  "esac",
].join("\n") + "\n";
// The native courier over its production draft effects: every key and read
// goes through the PATH tmux above. Returns the submit status and the keys sent.
export function nativeApproval(harness: string, capture: string, urgent: number, force: string, answered = false, appears = "", permissions = "bypass", config = "") {
  const home = mkdtempSync("/tmp/tap-approval-native-");
  mkdirSync(join(home, "receipts"));
  mkdirSync(join(home, "bin"));
  writeFileSync(join(home, "bin", "tmux"), doorTmux);
  chmodSync(join(home, "bin", "tmux"), 0o755);
  writeFileSync(join(home, "registry.json"), JSON.stringify({schema:"0.20", seats:{peer:{status:"active", harness, permissions, pane:"fixture", pane_id:"%1", server_epoch:"srv:4242:100"}}}));
  writeFileSync(join(home, "pane-state"), answered ? idleFrame(harness, "") : capture);
  writeFileSync(join(home, "pane-empty"), idleFrame(harness, ""));
  mkdirSync(join(home, "xdg", "tap"), { recursive: true });
  if (config) writeFileSync(join(home, "xdg", "tap", "config.toml"), config);
  const probe = join(home, "probe.ts");
  writeFileSync(probe, `import {submitVerifyLocked} from ${JSON.stringify(repo + "runtime/bun/src/courier.ts")};
import {DARK_EFFECTS} from ${JSON.stringify(repo + "runtime/bun/src/deliver.ts")};
import {draftEffects} from ${JSON.stringify(repo + "runtime/bun/src/spool-drain-effects.ts")};
const e = process.env, harness = e.HARNESS!, urgent = e.URGENT === "1";
const result = submitVerifyLocked("fixture", "approval-held", e.WIRE!, { paneId: "%1", serverEpoch: "srv:4242:100", harness, handle: "peer" }, { ...draftEffects(DARK_EFFECTS), inputHeld: undefined, protectInput: undefined },
  { scriptsDir: ${JSON.stringify(repo + "skills/tap/scripts")}, agentFamilies: new Set([harness]), busHome: e.TAP_HOME, recipient: "peer",
    registryPath: e.TAP_HOME + "/registry.json", preserveDraft: false, forceNoPrompt: e.FORCE === "TAP_SUBMIT_FORCE_NO_PROMPT", noPromptOk: e.FORCE === "NO_PROMPT_OK",
    deliveryFacts: { harness, urgent, noSpool: e.FORCE === "TAP_SUBMIT_NO_SPOOL", recipientBound: true } });
console.log("status=" + result.status);
`);
  try {
    const run = spawnSync("bun", [probe], { encoding: "utf8", env: { ...process.env, TAP_HOME: home, HARNESS: harness, PATH: `${home}/bin:${process.env.PATH}`, XDG_CONFIG_HOME: join(home, "xdg"),
      APPEARS: appears, FORCE: force, WIRE: wire, STAGED: idleFrame(harness, wire), URGENT: String(urgent) } });
    let effects = "";
    try { effects = readFileSync(join(home, "effects"), "utf8"); } catch { /* no keys sent */ }
    return { status: run.status, stdout: run.stdout + effects, stderr: run.stderr };
  } finally { rmSync(home, { recursive: true, force: true }); }
}
export function idleFrame(harness: string, text: string): string {
  return harness === "claude" ? `${"─".repeat(50)}\n❯ ${text}\n${"─".repeat(50)}\n` : `› ${text}\ngpt-5.6-sol xhigh · Context 100% left\n`;
}
