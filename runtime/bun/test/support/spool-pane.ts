import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Executable observations work across Bun and retained shell children. */
export function installSpoolPane(root: string, registry: string, env: NodeJS.ProcessEnv, command = "codex", processFallback = false, binding = { handle: "peer", pane: "fixture:0.0", paneId: "%401" }, submit = false) {
  if (env.TAP_INDEX_HOME && !existsSync(join(env.TAP_INDEX_HOME, "global-registry.json"))) {
    mkdirSync(env.TAP_INDEX_HOME, { recursive: true });
    writeFileSync(join(env.TAP_INDEX_HOME, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
  }
  const bin = join(root, "pane-bin"), log = join(root, "pane-calls"), frame = join(root, "pane-frame");
  mkdirSync(bin, { recursive: true }); writeFileSync(log, ""); writeFileSync(frame, readFileSync(join(import.meta.dir, "../../../../skills/tap/scripts/smoke/fixtures/submit-verify/codex-idle-empty.ansi")));
  writeFileSync(join(bin, "tmux"), `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
while [ "$1" = -S ] || [ "$1" = -L ]; do shift 2; done
cmd="$1"; shift
stage() {
  printf '› %s\\n\\n  gpt-6-astra medium · Context 99%% left\\n' "$1" > "$FAKE_FRAME"
  printf '%s\\n' "\${FAKE_SUBMIT_ID:-a}" >> "$FAKE_EFFECTS"
  if [ -n "\${SUBMIT_BARRIER:-}" ]; then : > "$SUBMIT_BARRIER.reached"; while [ ! -f "$SUBMIT_BARRIER.release" ]; do sleep 0.02; done; fi
  [ -z "\${SUBMIT_WRITES_FENCE:-}" ] || printf '{}\\n' > "$TAP_HOME/reset.fence.json"
  [ "\${SUBMIT_RC:-0}" != 5 ]
}
case "$cmd" in
  load-buffer) [ "\${FAKE_SUBMIT:-0}" = 1 ] || exit 1; cp "\${!#}" "$FAKE_FRAME.buffer" ;;
  paste-buffer)
    [ "\${FAKE_SUBMIT:-0}" = 1 ] || exit 1
    stage "$(cat "$FAKE_FRAME.buffer")" || exit 1
    ;;
  send-keys)
    [ "\${FAKE_SUBMIT:-0}" = 1 ] || exit 1
    case " $* " in
      *' -l -- '*) stage "\${!#}" || exit 1 ;;
      *) [ "\${!#}" != Enter ] || cp "$FAKE_FRAME.empty" "$FAKE_FRAME" ;;
    esac
    ;;
  delete-buffer) [ "\${FAKE_SUBMIT:-0}" = 1 ] || exit 1 ;;
  list-sessions) printf '%s\\t123:456\\t0\\n' "$FAKE_SESSION" ;;
  list-panes) printf '%s\\t%s\\t%s\\t%s\\t4242\\t123:456\\t0\\n' "$FAKE_SESSION" "$FAKE_PANE" "$FAKE_PANE_ID" "$FAKE_COMMAND" ;;
  capture-pane) [ "\${FAKE_CAPTURE_FAIL:-0}" = 0 ] || exit 1; cat "$FAKE_FRAME" ;;
  display-message)
    fmt="\${!#}"
    case "$fmt" in
      '#{pid}:#{start_time}') printf '123:456\\n' ;;
      '#{pane_current_command}') printf '%s\\n' "$FAKE_COMMAND" ;;
      '#{pane_pid}') printf '%s\\n' "\${FAKE_PID-4242}" ;;
      '#{pane_in_mode}') printf '%s\\n' "\${FAKE_MODE-0}" ;;
      '#{pane_width}') printf '120\\n' ;;
      $'#{pane_id}\\t#{session_name}\\t#{pane_pid}\\t#{pane_current_command}\\t#{pane_dead}') printf '%s\\t%s\\t4242\\t%s\\t0\\n' "$FAKE_PANE_ID" "$FAKE_SESSION" "$FAKE_COMMAND" ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac
`);
  if (processFallback) writeFileSync(join(bin, "ps"), `#!/bin/bash
printf 'ps\\n' >> "$FAKE_LOG"
[ "\${FAKE_PS_FAIL:-0}" = 0 ] || exit 1
printf '%s\\n' '4242 4242 4242 node /opt/bin/codex'
`);
  for (const name of processFallback ? ["tmux", "ps"] : ["tmux"]) chmodSync(join(bin, name), 0o755);
  const seat = { status: "active", delivery: "pane", pane: binding.pane, pane_id: binding.paneId, session: binding.pane.split(":")[0],
    server_epoch: "srv:123:456", boot_id: "boot:1", harness: command };
  let doc: any; try { doc = JSON.parse(readFileSync(registry, "utf8")); } catch { doc = { schema: "0.20", team: { name: "fixture" }, seats: {} }; }
  const writeSeat = (over: Record<string, unknown> = {}) => writeFileSync(registry,
    JSON.stringify({ ...doc, seats: { ...doc.seats, [binding.handle]: { ...seat, ...over } } }));
  writeSeat();
  Object.assign(env, { PATH: `${bin}:${env.PATH}`, TAP_BOOT_ID: "boot:1", TAP_BOOT_ID_LEGACY: "boot:1",
    TAP_SERVER_EPOCH: "srv:123:456", FAKE_COMMAND: command, FAKE_SESSION: seat.session, FAKE_PANE: binding.pane, FAKE_PANE_ID: binding.paneId, FAKE_FRAME: frame, FAKE_LOG: log });
  if (submit) {
    writeFileSync(`${frame}.empty`, readFileSync(frame));
    Object.assign(env, { FAKE_SUBMIT: "1", FAKE_EFFECTS: join(root, "effects") });
  }
  return { frame, log, seat, writeSeat };
}

// Shell regressions use the same executable observations, inside their isolated runner.
if (import.meta.main) {
  const [root, registry, handle, pane, paneId, command = "codex"] = process.argv.slice(2);
  if (!root || !registry || !handle || !pane || !paneId) throw new Error("spool fixture needs root registry handle pane id");
  const env: NodeJS.ProcessEnv = { ...process.env };
  installSpoolPane(root, registry, env, command, false, { handle, pane, paneId });
  for (const key of ["PATH", "TAP_BOOT_ID", "TAP_BOOT_ID_LEGACY", "TAP_SERVER_EPOCH", "FAKE_COMMAND", "FAKE_SESSION", "FAKE_PANE", "FAKE_PANE_ID", "FAKE_FRAME", "FAKE_LOG"])
    process.stdout.write(`export ${key}='${env[key]!.replaceAll("'", "'\\''")}'\n`);
}
