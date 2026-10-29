import { loadRegistry, seatMap } from "../registry";
import { opencodeTerminalOverprint } from "../opencode-composer";
import { repaintPane } from "../pane/repaint";
import { recoveryPolicy } from "../recovery-policy";
import { tmux, tmuxReadOnly } from "../tmux";
import { canAct, createRun, updateRun, readRun, recoveryHold, releaseRun, type RecoveryTarget } from "./state";
import { recoveryEffect, REAL_RECOVERY_IO, recordObservation, escalateRecovery } from "./effect";

export function targetRow(registry: string, handle: string, pane: string, paneId: string): RecoveryTarget {
  const doc = loadRegistry(registry);
  const row = seatMap(doc)[handle];
  if (!row || row.pane_id !== paneId || row.pane !== pane || (row.status ?? "active") !== "active") throw new Error("nudge target binding changed before recovery recording");
  const paneProcess = tmuxReadOnly(["display-message", "-p", "-t", paneId, "#{pane_pid}"]);
  if (paneProcess.code !== 0 || !/^\d+$/.test(paneProcess.stdout.trim())) throw new Error("target process identity unavailable");
  return { processPid: paneProcess.stdout.trim(), team: String((doc.team as { name?: unknown } | undefined)?.name || ""), handle, registry, pane, paneId,
    instance: String(row.instance ?? ""), session: String(row.session ?? ""), harness: String(row.harness ?? "") };
}
/**
 * The report-only capture is the pane as painted (`capture-pane -e`). A
 * terminal renders that; a redirect or pipe would receive raw escapes, so the
 * paint is kept only for a colour terminal (cli-design: no terminal controls
 * in redirected output; NO_COLOR, even empty, and TERM=dumb opt out).
 */
export function reportFrame(frame: string, tty: boolean, env: NodeJS.ProcessEnv): string {
  if (tty && env.NO_COLOR === undefined && env.TERM !== "dumb") return frame;
  return frame.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function recoveryCli(argv: string[]): number {
  const [op, ...args] = argv;
  if (process.env.TAP_RECOVERY_RUN && readRun(process.env.TAP_RECOVERY_RUN).purpose === "operator") {
    throw new Error("operator runs accept only tap operate actions");
  }
  if (op === "guard") {
    const [paneId] = args;
    if (!paneId) throw new Error("guard requires a pane id");
    const allowed = !recoveryHold(paneId);
    console.log(allowed ? "allowed" : "park");
    return 0;
  }
  if (op === "report") {
    const [registry, handle = "", pane, label = handle] = args;
    if (!registry || !pane) throw new Error("report target required");
    const observed = tmuxReadOnly(["display-message", "-p", "-t", pane, "#{pane_id}"]);
    const paneId = observed.stdout.trim();
    if (observed.code !== 0 || !/^%\d+$/.test(paneId)) throw new Error("report pane is unavailable");
    const doc = loadRegistry(registry), row = seatMap(doc)[handle];
    const target: RecoveryTarget = { team: String((doc.team as { name?: unknown } | undefined)?.name || ""), handle,
      registry, pane, paneId, instance: String(row?.instance ?? ""), session: String(row?.session ?? ""), harness: String(row?.harness ?? "") };
    const run = createRun(target, "report-only", [], "", process.pid);
    console.log(`tap nudge: report-only for ${label} (${pane}); no pane effects. Recovery ${run.id}`);
    recordObservation(run);
    const frame = REAL_RECOVERY_IO.capture(target, false);
    if (target.harness === "opencode" && opencodeTerminalOverprint(frame)) {
      console.log("tap nudge: OpenCode terminal overprint obscures the composer");
    }
    process.stdout.write(reportFrame(frame, !!process.stdout.isTTY, process.env));
    return 0;
  }
  if (op === "repaint-probe") {
    const [registry, handle = "", pane, paneId] = args;
    if (!registry || !handle || !pane || !paneId) throw new Error("repaint-probe target required");
    const target = targetRow(registry, handle, pane, paneId);
    if (target.harness !== "opencode") throw new Error("repaint-probe is OpenCode-only");
    const repaint = repaintPane(target.paneId);
    if (!repaint.ok || repaint.after === null) throw new Error(`OpenCode repaint failed: ${repaint.reason}`);
    targetRow(registry, handle, pane, paneId);
    process.stdout.write(repaint.after);
    return 0;
  }
  if (op === "nudge-start") {
    const [mode, registry, handle, pane, paneId, payloadId, home, pid, expected] = args;
    if (!registry || !handle || !pane || !paneId || !payloadId || !home || !pid || !expected) throw new Error("nudge recording arguments required");
    const target = targetRow(registry, handle, pane, paneId);
    if (process.env.TAP_RECOVERY_RUN) {
      const run = readRun(process.env.TAP_RECOVERY_RUN);
      if (run.purpose === "operator") throw new Error("operator runs never authorize nudge or submission");
      if (run.mode !== mode || run.target.paneId !== paneId || !canAct(run)) throw new Error("parent recovery does not authorize nudge");
      // A run `tap nudge` opened for its ladder (tap-xe42x) learns the staged payload here.
      updateRun(run.id, current => {
        current.nudgeExpected = expected;
        if (!current.payloads.some(ref => ref.id === payloadId && ref.home === home)) current.payloads.push({ home, id: payloadId });
      });
      console.log(run.id); return 0;
    }
    const run = createRun(target, recoveryPolicy("aggressive", mode).mode,
      [{ home, id: payloadId }], process.env.TMUX_PANE || "", Number(pid), process.env, undefined, false);
    updateRun(run.id, current => { current.nudgeExpected = expected; });
    console.log(run.id); return 0;
  }
  if (op === "nudge-finish") {
    const [id, status] = args;
    if (!id) throw new Error("nudge finish requires recovery id");
    const run = readRun(id);
    if (run.purpose === "operator") throw new Error("operator runs never authorize nudge or submission");
    if (!run.hold) releaseRun(id, status === "0" ? "staged message submitted; processing unconfirmed" : status === "7" ? "message queued in harness; processing unconfirmed; no replay" : "nudge unresolved; inspect recorded effects");
    return 0;
  }
  if (op === "tmux") {
    const id = process.env.TAP_RECOVERY_RUN;
    if (!id) throw new Error("recorded tmux requires recovery context");
    const run = readRun(id);
    if (run.purpose === "operator") throw new Error("operator runs accept only tap operate actions");
    if (args[0] !== "send-keys") {
      const result = tmux(args);
      process.stdout.write(result.stdout); process.stderr.write(result.stderr); return result.code;
    }
    const keys = [...args];
    if (keys[1] !== "-t" || ![run.target.pane, run.target.paneId].includes(keys[2] || "")) throw new Error("recovery key target differs from the bound seat");
    keys[2] = run.target.paneId;
    const result = recoveryEffect(id, `nudge ${keys.slice(3).join(" ")}`,
      `${run.mode}: complete visible sentinel and canonical recipient authorized by nudge`, keys);
    if (result.event.incident) escalateRecovery(id, result.event.summary);
    if (result.code !== 0) console.error(`tap recovery: ${result.event.summary}; tap debug recovery ${id}`);
    // 125 is reserved here for a positively recorded pre-key refusal.
    // Actual tmux failures are mapped by recoveryEffect to possible-effect 124.
    return result.event.effect === "none" ? 125 : result.code;
  }
  throw new Error("unknown recovery adapter operation");
}
if (import.meta.main) {
  try { process.exitCode = recoveryCli(process.argv.slice(2)); }
  catch (error) { console.error(`tap recovery: ${error}`); process.exitCode = 1; }
}
