import { agentAtRest, codexHookTrust, CODEX_HOOK_TRUST_REASON, detectAgentState } from "../agent-state";
import { paneHarness } from "../pane-harness";
export { paneHarness } from "../pane-harness";
import { paneAlertState } from "../pane/reader";
import { opencodePromptReady } from "../seat-state";
import { serverEpochFromRaw } from "../tmux";
import { launchTmux } from "./process";
import { LauncherError } from "./types";
import { InvocationError } from "./invocation";
import { codexUpdateDismissed, codexUpdatePrompt, type CodexUpdatePrompt } from "../codex-update";

export class PaneObservationTimeout extends LauncherError {
  constructor(target: string) {
    const detail = `pane observation timed out for ${target}`;
    const action = `tmux attach -t ${target}   # inspect before deciding whether to relaunch`;
    super(`${detail}; next: ${action}`, "pane_observation_timeout", action, detail);
  }
}

export const PANE_FACTS_FORMAT = "#{session_name}:#{window_index}.#{pane_index}\t#{pane_id}\t#{pane_current_command}\t#{pid}:#{start_time}\t#{pane_dead}\t#{pane_pid}\t#{pane_current_path}";
export type PaneFacts = { pane: string; pane_id: string; command: string; server_epoch: string; dead: boolean; pane_pid: number; path: string };

export function parsePaneFacts(line: string, env: NodeJS.ProcessEnv = process.env): PaneFacts | null {
  const fields = line.replace(/\n+$/, "").split("\t");
  if (fields.length < 7 || !fields[0] || !fields[1] || !["0", "1"].includes(fields[4]!)) return null;
  if (!/^\d+$/.test(fields[5]!) && !(fields[4] === "1" && fields[5] === "")) return null;
  return { pane: fields[0], pane_id: fields[1], command: fields[2]!, server_epoch: serverEpochFromRaw(fields[3]!, env),
    dead: fields[4] === "1", pane_pid: Number(fields[5]), path: fields.slice(6).join("\t") };
}

export async function paneFacts(target: string, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal, nativeSocket = true, timeoutMs = 5000): Promise<PaneFacts | null> {
  try {
    const result = await launchTmux(["display-message", "-p", "-t", target, PANE_FACTS_FORMAT], env, signal, nativeSocket, timeoutMs);
    signal?.throwIfAborted();
    if (result.code === 124) throw new PaneObservationTimeout(target);
    return result.code === 0 ? parsePaneFacts(result.stdout, env) : null;
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}


const PANE_SGR = /\x1b\[[0-?]*[ -/]*[@-~]/g;
export const stripPaneSgr = (frame: string): string => frame.replace(PANE_SGR, "");

/** One startup screen capture, carrying startupBlocker's error contract:
 * code 124 raises PaneObservationTimeout, errno failures observe nothing. */
export async function captureStartupScreen(facts: PaneFacts, env: NodeJS.ProcessEnv, signal?: AbortSignal, nativeSocket = true, timeoutMs = 5000): Promise<string | null> {
  try {
    const result = await launchTmux(["capture-pane", "-p", "-J", "-t", facts.pane_id], env, signal, nativeSocket, timeoutMs);
    signal?.throwIfAborted();
    if (result.code === 124) throw new PaneObservationTimeout(facts.pane_id);
    return result.code === 0 ? stripPaneSgr(result.stdout) : null;
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code) return null;
    throw error;
  }
}

/** The startup blocker regexes over an already-captured screen. */
export function startupBlockerFromScreen(facts: PaneFacts, harness: string, screen: string | null, detectResumePicker = true): string | null {
  if (screen === null) return null;
  if (codexHookTrust(harness, screen)) return `${CODEX_HOOK_TRUST_REASON}\nPane ${facts.pane_id}:\n${screen.trimEnd()}`;
  return detectResumePicker && harness === "codex" && screen.includes("No results for your search") && /\b0\s*\/\s*0\b/.test(screen)
    ? "codex resume picker has zero results; the stored conversation id is unavailable to the active account" : null;
}

export async function startupBlocker(facts: PaneFacts, harness: string, env: NodeJS.ProcessEnv, signal?: AbortSignal, nativeSocket = true, detectResumePicker = true, timeoutMs = 5000): Promise<string | null> {
  return startupBlockerFromScreen(facts, harness, await captureStartupScreen(facts, env, signal, nativeSocket, timeoutMs), detectResumePicker);
}

/** One startup observation per observed facts object, so the startup blocker
 * and the readiness signal share a single capture (plus one title read) per
 * poll instead of capturing twice. The raw screen bytes carry the SGR
 * attributes the roster's idle classifier corroborates the placeholder
 * against; consumers that want plain text strip. The title rides the roster's
 * own classifier input — a Braille spinner title means `working`, so Codex is
 * still starting even beside a painted composer. */
export interface StartupObservation {
  screen: string | null;
  /** null when the title read itself failed: no signal may rest on a title
   * this observation could not take. */
  title: string | null;
  updateSkipFailure?: string;
}
export interface UpdateSkipEvent extends CodexUpdatePrompt {
  outcome: "intent" | "skipped" | "unverified" | "refused";
  pane: string;
}
export interface StartupUpdateSkip {
  authorize(facts: PaneFacts): Promise<boolean>;
  escape(facts: PaneFacts): Promise<boolean>;
  record(event: UpdateSkipEvent): void;
}
export function memoizedStartupObservation(env: NodeJS.ProcessEnv, signal?: AbortSignal, nativeSocket = true, timeoutMs = 5000,
  skip?: StartupUpdateSkip): (facts: PaneFacts) => Promise<StartupObservation> {
  const cache = new WeakMap<PaneFacts, Promise<StartupObservation>>();
  let skipAttempted = false;
  const capture = async (facts: PaneFacts): Promise<StartupObservation> => {
    let screen: string | null = null, title: string | null = null;
    try {
      const result = await launchTmux(["capture-pane", "-p", "-e", "-J", "-t", facts.pane_id], env, signal, nativeSocket, timeoutMs);
      signal?.throwIfAborted();
      if (result.code === 124) throw new PaneObservationTimeout(facts.pane_id);
      if (result.code === 0) screen = result.stdout;
      const titled = await launchTmux(["display-message", "-p", "-t", facts.pane_id, "#{pane_title}"], env, signal, nativeSocket, timeoutMs);
      signal?.throwIfAborted();
      if (titled.code === 124) throw new PaneObservationTimeout(facts.pane_id);
      if (titled.code === 0) title = titled.stdout.split("\n", 1)[0] ?? "";
    } catch (error) {
      signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code) return { screen: null, title: null };
      throw error;
    }
    return { screen, title };
  };
  return facts => {
    let observed = cache.get(facts);
    if (observed === undefined) {
      observed = (async () => {
        const before = await capture(facts);
        if (!skip || before.screen === null || detectAgentState("codex", before.screen).reason !== "codex-update-available") return before;
        const prompt = codexUpdatePrompt(before.screen);
        const failed = (reason: string): StartupObservation => ({ ...before, updateSkipFailure: `codex-update-skip: ${reason}; attach and inspect before continuing` });
        if (!prompt) return failed("update versions are unreadable");
        if (skipAttempted) return failed("Skip was already attempted in this launch");
        if (!await skip.authorize(facts)) { skip.record({ ...prompt, pane: facts.pane_id, outcome: "refused" }); return failed("launch ownership changed or is unobservable"); }
        signal?.throwIfAborted();
        skipAttempted = true;
        try {
          skip.record({ ...prompt, pane: facts.pane_id, outcome: "intent" });
          if (!await skip.escape(facts)) { skip.record({ ...prompt, pane: facts.pane_id, outcome: "unverified" }); return failed("Escape outcome is unverified"); }
          await Bun.sleep(100);
          signal?.throwIfAborted();
          const after = await capture(facts);
          if (!await skip.authorize(facts) || !codexUpdateDismissed(after.screen, after.title)) {
            skip.record({ ...prompt, pane: facts.pane_id, outcome: "unverified" });
            return failed("Escape sent; an empty composer on the same pane is unverified");
          }
          skip.record({ ...prompt, pane: facts.pane_id, outcome: "skipped" });
          return after;
        } catch (error) {
          skip.record({ ...prompt, pane: facts.pane_id, outcome: "unverified" });
          signal?.throwIfAborted();
          return failed(`Escape sent or possible; observation failed (${error instanceof Error ? error.message : String(error)})`);
        }
      })();
      cache.set(facts, observed);
    }
    return observed;
  };
}

/** The Codex readiness signal: the roster's idle or usable-error judgment — the same one
 * delivery licenses injection on. Selection menus reuse the › glyph as their
 * cursor, so a loose composer line-match would call dialogs ready; the
 * classifier separates an at-rest composer (dim placeholder corroboration) from
 * blocked and working screens, with the pane title as one of its inputs. Needs
 * the RAW screen, SGR bytes intact. A title this observation could not take
 * (null) suppresses the signal: a spinner-titled Codex must never pass as
 * idle on an unverified title. */
export function codexComposerIdle(screen: string | null, title: string | null = null): boolean {
  return screen !== null && title !== null && agentAtRest(detectAgentState("codex", screen, title).agentState);
}

/** A proven usable-error composer is ready even when its error is inside the
 * generic alert tail. Other frames retain the existing alert and prompt gates;
 * an approval modal is never admitted by the error exception. */
export function opencodeComposerIdle(screen: string | null): boolean {
  if (screen === null) return false;
  const stripped = stripPaneSgr(screen);
  if (detectAgentState("opencode", stripped).agentState === "error") return true;
  return paneAlertState(`${stripped}\n`) === "" && opencodePromptReady(stripped) === 0;
}

/** The OpenCode launch readiness signal: one plain physical-row capture — no
 * `-J`, because a renderer that marks rows wrapped must still show the box's
 * border row as a physical row (the roster captures OpenCode unjoined), and no
 * `-e`, because the predicate strips SGR itself — with no title read. Any
 * capture failure (non-zero exit, timeout, thrown error) is no signal, so the
 * readiness loop continues to its deadline instead of rolling back; only an
 * aborted launch rethrows, as paneTailLines does. */
export async function opencodeReadySignal(facts: PaneFacts, env: NodeJS.ProcessEnv, signal?: AbortSignal, timeoutMs = 2000): Promise<boolean> {
  try {
    const result = await launchTmux(["capture-pane", "-p", "-t", facts.pane_id], env, signal, true, timeoutMs);
    signal?.throwIfAborted();
    return result.code === 0 && opencodeComposerIdle(result.stdout);
  } catch (error) {
    signal?.throwIfAborted();
    return false;
  }
}

/** The pane's last non-empty visible lines: null when the capture failed, empty when the pane is blank. */
export async function paneTailLines(facts: PaneFacts, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal,
  maxLines = 5, timeoutMs = 2000): Promise<string[] | null> {
  try {
    const result = await launchTmux(["capture-pane", "-p", "-J", "-t", facts.pane_id], env, signal, true, timeoutMs);
    signal?.throwIfAborted();
    if (result.code !== 0) return null;
    return stripPaneSgr(result.stdout).split("\n").map(line => line.replace(/\s+$/, ""))
      .filter(line => line.trim() !== "").slice(-maxLines);
  } catch (error) {
    signal?.throwIfAborted();
    return null;
  }
}

/** After a positive readiness signal, the identity must survive this settle
 * window before readiness returns; the full timeout remains the fallback. */
export const READY_SETTLE_MS = 600;

/** How often a wait consults `awaitingStart`: a capture a second, not one per poll. */
const START_PROBE_MS = 1000;
/** A pane with nothing running yet gets this long before the watch may end the
 * wait, and text must sit unchanged this long to read as blocked. */
export const START_STALL_MS = 5000;
/** The watch's reason for a pane whose text stopped changing. */
export const START_STALLED = "login shell stalled";

/** Slow or blocked? A login shell that has not started its harness is slow while
 * its pane stays blank or keeps changing, and blocked once text has sat unchanged
 * for START_STALL_MS, the shape of a prompt waiting on an answer (tap-i2y7w). A
 * dead pane holds no further evidence, so it ends the wait at the same mark; not
 * sooner, because the pane-died rollback owns the first few seconds. So does a
 * pane that `foreign` names as running some other program: only a shell still on
 * its way to the harness earns the longer wait. A failed capture is no evidence:
 * it neither resets the stall nor advances it. */
export function startStallWatch(harness: string, tail: (facts: PaneFacts) => Promise<string[] | null>,
  foreign: (facts: PaneFacts) => Promise<string | null> = async () => null) {
  let shown = "", shownSince = 0;
  return async (facts: PaneFacts | null, elapsedMs: number): Promise<string | null> => {
    if (!facts) return null;
    if (facts.dead) return elapsedMs >= START_STALL_MS ? `${harness} exited during startup` : null;
    if (elapsedMs >= START_STALL_MS) {
      const other = await foreign(facts);
      if (other) return `the pane is running ${other}, not ${harness}`;
    }
    const lines = await tail(facts);
    if (lines === null) return null;
    const current = lines.join("\n");
    if (current !== shown) { shown = current; shownSince = elapsedMs; }
    return current !== "" && elapsedMs >= START_STALL_MS && elapsedMs - shownSince >= START_STALL_MS ? START_STALLED : null;
  };
}

/** `timeoutMs` bounds appearance and survival together unless `startCeilingMs`
 * separates them: that then bounds the wait for a first match, `timeoutMs` runs
 * from that match, and `awaitingStart` may end the wait early with a reason. */
export async function awaitStableHarness(
  read: () => Promise<PaneFacts | null>, matches: (facts: PaneFacts) => boolean,
  timeoutMs: number, options: { signal?: AbortSignal; blocker?: (facts: PaneFacts) => Promise<string | null>; confirmations?: number; observeUntilDeadline?: boolean; blockerObservationMs?: number;
    ready?: (facts: PaneFacts) => Promise<boolean>; readySettleMs?: number;
    startCeilingMs?: number; awaitingStart?: (facts: PaneFacts | null, elapsedMs: number) => Promise<string | null>;
    now?: () => number; sleep?: (ms: number) => Promise<unknown> } = {},
): Promise<{ facts: PaneFacts | null; reason: string | null }> {
  const now = options.now ?? (() => performance.now()), sleep = options.sleep ?? Bun.sleep;
  const entered = now();
  const startDeadline = entered + (options.startCeilingMs ?? timeoutMs);
  let deadline = startDeadline;
  const observing = !!(options.blocker || options.observeUntilDeadline);
  let observationDeadline = deadline;
  let previous: string | null = null, confirmed: string | null = null, observations = 0;
  let readyDeadline: number | null = null;
  let finalConfirmation = false;
  let survivalAnchored = false, nextStartProbe = entered + START_PROBE_MS;
  while (true) {
    options.signal?.throwIfAborted();
    const preceding = previous;
    const facts = await read();
    // The facts are as old as their read, not as old as whatever the blocker
    // spent time on afterwards (a Codex capture can consume seconds). Only
    // facts sampled at or after the deadline may satisfy it, so a pane that
    // died behind a slow capture is re-read — or missed — never returned as
    // running on stale evidence (both the settle and the deadline paths).
    const sampledAt = now();
    if (facts && matches(facts)) {
      if (options.startCeilingMs !== undefined && !survivalAnchored) {
        survivalAnchored = true;
        deadline = observationDeadline = sampledAt + timeoutMs;
      }
      const identity = JSON.stringify([facts.pane_id, facts.server_epoch, facts.pane_pid, facts.command]);
      if (confirmed && identity !== confirmed) return { facts: null, reason: "harness process identity changed during readiness" };
      observations = identity === previous ? observations + 1 : 1;
      previous = identity;
      if (observing && !confirmed && observations >= (options.confirmations ?? 2)) {
        confirmed = identity;
        // Stable Codex replacements need a bounded chance to reveal a startup
        // dialog, not the entire readiness ceiling. Explicit full-window callers
        // retain their deadline, including the initial-launch survival check.
        if (!options.observeUntilDeadline) observationDeadline = Math.min(deadline, now() + (options.blockerObservationMs ?? 5000));
      }
      const reason = options.blocker ? await options.blocker(facts) : null;
      if (reason) return { facts: null, reason };
      // A positive readiness signal — evaluated only once the identity is
      // confirmed, and firing once — replaces the observation deadline with a
      // shorter settle window. Survival checks above stay armed through it.
      if (options.ready && readyDeadline === null && observations >= (options.confirmations ?? 2)
        && now() < deadline && await options.ready(facts)) {
        readyDeadline = Math.min(deadline, now() + (options.readySettleMs ?? READY_SETTLE_MS));
      }
    } else {
      if (confirmed) return { facts: null, reason: "harness exited or became unobservable during readiness" };
      previous = null; observations = 0;
      // A match lost before confirmation proved nothing: the wait for a first
      // match resumes on its original deadline, so flapping cannot extend it.
      if (survivalAnchored) { survivalAnchored = false; deadline = observationDeadline = startDeadline; }
      if (options.awaitingStart && sampledAt >= nextStartProbe) {
        nextStartProbe = sampledAt + START_PROBE_MS;
        const reason = await options.awaitingStart(facts, sampledAt - entered);
        if (reason) return { facts: null, reason };
      }
    }
    if (observations >= (options.confirmations ?? 2) && (!observing || sampledAt >= (readyDeadline ?? observationDeadline))) return { facts, reason: null };
    if (now() >= deadline) {
      if (!finalConfirmation && preceding === null && observations > 0 && observations === (options.confirmations ?? 2) - 1) {
        finalConfirmation = true;
        continue;
      }
      // A confirmed harness whose last sample predates the deadline (the clock
      // moved during the ready poll or a blocker capture) gets one more read
      // rather than a null return: the deadline check above decides on the
      // fresh sample, and a pane that died in between is caught by it.
      if (facts && observations >= (options.confirmations ?? 2)) continue;
      return { facts: null, reason: null };
    }
    await sleep(50);
  }
}

export async function awaitReplacedHarness(request: { pane_id: string; harness: string; timeout: number; expected_server_epoch: string;
  previous_pane_pid: number; detect_resume_picker: boolean }, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{ ready: boolean; reason: string | null }> {
  if (!request.expected_server_epoch || !request.previous_pane_pid) throw new InvocationError("missing pre-respawn identity");
  try {
    const result = await awaitStableHarness(() => paneFacts(request.pane_id, env, signal), facts =>
      facts.pane_id === request.pane_id && facts.server_epoch === request.expected_server_epoch && !facts.dead &&
      !!facts.pane_pid && facts.pane_pid !== request.previous_pane_pid && paneHarness(facts, env) === request.harness,
    request.timeout * 1000, { signal, blocker: request.harness === "codex"
      ? facts => startupBlocker(facts, request.harness, env, signal, true, request.detect_resume_picker) : undefined });
    signal?.throwIfAborted();
    return { ready: result.facts !== null, reason: result.reason };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof PaneObservationTimeout) return { ready: false, reason: error.message };
    throw error;
  }
}
