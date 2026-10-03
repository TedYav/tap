// The watch tick's blocked-seat pass (slice W2c-1): `_watch_process_blocked` and the
// helpers only it reached -- `_watch_tick_seat_active`, `_watch_tick_seat_state`,
// `_watch_seat_recency`, `_watch_classify_blocked`, `_watch_send_continue` -- ported
// from tap-watch.sh at f6be3e855 and measured against them RUN (the frozen oracle in
// test/fixtures/watch-blocked-oracle.json) in the tick's own calling shape:
// `blocked_touched="$(_watch_process_blocked ...)"`, a command substitution, where
// bash never has errexit -- one shape, whichever way the tick itself was called.
//
// What the pass decides (tap-dst, round 2): every seat in `blocked_map` whose timer
// has fired is either cleared (activity since it blocked: the banner is gone) or
// moved to `blocked_exempt` -- with one continue nudge when it still sits at an
// idle prompt, without one when the banner still classifies. Write-through per seat
// BEFORE the nudge, so a tick killed between the write and the send never re-sends.
// The handles touched are printed for the tick's rung skip-set.
//
// Seams (the world the pass reads and writes): the lease fields and the two-field
// write, the lease nonce, the tick's roster cache, the pane classifier
// (seat-state.ts, in-process), the pane's tmux activity clock, the pane
// transcript (native peek, one spawn; shared capture retained), and the continue courier (`tap send
// --kind probe --fyi`, one spawn). The blocked-map steps, the probed-list append
// and the banner ladder are in-process (watch-detect.ts, watch-evaluate.ts,
// watch-tick.ts).

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tmuxReadOnly } from "./tmux";
import { peekResult } from "./verbs/peek";
import { blockedField, blockedKeys, blockedRemove, cmdSubst } from "./watch-detect";
import { realSeams, type RealSeamsArgs } from "./watch-detectors";
import { seatState } from "./seat-state";
import { probedAppend } from "./watch-evaluate";
import { arithLiteral, testInt } from "./watch-evaluator";
import { fieldValue, readLoose, set as leaseWrite } from "./watch-lease";
import { armPath } from "./watch-notice";
import { courierArgv } from "./courier-argv";
import { classifyBlockedTranscript } from "./watch-tick";
import { childBusEnv } from "./panelock";
import { tapScriptsDir } from "./scripts-dir";

export interface BlockedSeams {
  /** `tap_watch_field <key>`. */
  leaseField(key: string): string;
  /** `tap_watch_set k1 v1 k2 v2 ... >/dev/null 2>&1 || true`: one write, its status ignored. */
  leaseSet(pairs: readonly (readonly [string, string])[]): void;
  /** `_watch_lease_current <armed_at>`. */
  leaseCurrent(armedAt: string): boolean;
  /** `_watch_tick_seat_active <handle>`: in a tick, the roster cache; outside one, always. */
  seatActive(handle: string): boolean;
  /** `_watch_tick_seat_state <handle>`: the native seat state over the resolved pane -- its answer and whether it succeeded; no pane is `unknown`/ok. */
  seatState(handle: string): { out: string; ok: boolean };
  /** `tmux display-message -p -t <pane> '#{window_activity}'` over the resolved pane ("" when none): raw stdout, "" on failure. */
  windowActivity(handle: string): string;
  /** Native peek: the transcript ("" on failure). */
  peek(handle: string): string;
  /** `tap send <handle> <draft> --from <identity> --kind probe --fyi` (courierArgv): the courier's status and its first stderr line. */
  sendContinue(handle: string, body: string): { rc: number; err: string };
  /** `cat "$DIR/watch-templates/continue.md"`, as `$( )` read it. */
  continueTemplate(): string;
  /** Diagnostics on the tick's stderr, one line each. */
  stderr(line: string): void;
}

/** `TAP_WATCH_IDENTITY`'s default and the courier's `--from`. */
export const WATCH_IDENTITY_DEFAULT = "watcher";

// --- the pure pieces ------------------------------------------------------------------------

/** `_watch_template_replace` twice: every `{{REASON}}` then every `{{ARMER}}`, literally; `printf '%s\n'` adds the newline. */
export function continueBody(template: string, reason: string, armer: string): string {
  return `${template.split("{{REASON}}").join(reason).split("{{ARMER}}").join(armer)}\n`;
}

export const CONTINUE_REASON: Record<"session_limit" | "other", string> = {
  session_limit: "You were blocked by a session limit that has now reset.",
  other: "A retryable API error interrupted your run; retrying once.",
};

/**
 * `for handle in $(_watch_blocked_keys "$map")`: the keys, one per line, then the
 * shell's word splitting on blanks and newlines. A key holding a glob character
 * would also have been matched against the working directory -- a second engine
 * for a handle nobody registers -- and is refused (R2b class).
 */
export function blockedHandles(map: string): string[] {
  const words = blockedKeys(map).split(/[ \t\n]+/).filter((w) => w !== "");
  for (const w of words) {
    if (/[*?[]/.test(w)) throw new Error(`blocked_map key would be expanded as a pattern by the shell: ${JSON.stringify(w)}`);
  }
  return words;
}

/** `case "$wa" in ''|*[!0-9]*) wa=0 ;; esac`. */
const digitsOrZero = (text: string): string => (/^[0-9]+$/.test(text) ? text : "0");

// --- the pass ------------------------------------------------------------------------------

/**
 * `_watch_process_blocked <armed_at> <now> <armed_by> [<blocked_map> [<blocked_exempt>]]`:
 * returns the handles touched this tick, in order -- what the incumbent printed --
 * and the status its substitution carried. A bash death inside the substitution
 * (an unbound name in `$(( reset_at + grace ))`, a key the shell would split) ended
 * the subshell with the handles printed so far and status 1; the tick went on with
 * that partial list (the loop shape) or ended (the verb shape). The port returns the
 * partial list with `rc: 1` and one `tap watch:` line, the same way for both shapes.
 */
export function processBlocked(armedAt: string, now: string, armedBy: string, mapArg: string, exemptArg: string, s: BlockedSeams, env: NodeJS.ProcessEnv = process.env): { touched: string[]; rc: number } {
  const touched: string[] = [];
  let map = mapArg || s.leaseField("blocked_map") || "{}";
  let exempt = exemptArg || s.leaseField("blocked_exempt") || "[]";
  // each step the incumbent read through `$( )` was a Bun module already (W2a/W2b):
  // its raise was one `tap watch: <error>` line and "" to the caller, never an abort
  const subst = (fn: () => string): string => {
    try { return fn(); } catch (error) { s.stderr(`tap watch: ${(error as Error).message}`); return ""; }
  };
  let handles: string[];
  try { handles = blockedHandles(map); } catch (error) {
    // the refused key is a subshell death: no pass and status 1; any other raise in
    // `blocked-keys` was "" -- `for handle in ""`, no pass
    s.stderr(`tap watch: ${(error as Error).message}`);
    return { touched, rc: /expanded as a pattern/.test((error as Error).message) ? 1 : 0 };
  }
  for (const handle of handles) {
    // `reason="$(_watch_blocked_field ...)"`: the substitution dropped NULs and every trailing newline
    const reason = subst(() => cmdSubst(blockedField(map, handle, "reason")));
    const since = subst(() => cmdSubst(blockedField(map, handle, "since")));
    const resetAt = subst(() => cmdSubst(blockedField(map, handle, "reset_at")));
    let fireAt: bigint;
    try {
      // `$(( reset_at + ${TAP_WATCH_BLOCKED_GRACE:-60} ))` / `$(( since + ${TAP_WATCH_BLOCKED_BACKOFF:-120} ))`:
      // a name or an expression where a number should be ended the subshell (R2/R2b)
      fireAt = reason === "session_limit"
        ? BigInt.asIntN(64, arithLiteral(resetAt, `blocked_map[${handle}].reset_at`) + arithLiteral(env.TAP_WATCH_BLOCKED_GRACE || "60", "TAP_WATCH_BLOCKED_GRACE"))
        : BigInt.asIntN(64, arithLiteral(since, `blocked_map[${handle}].since`) + arithLiteral(env.TAP_WATCH_BLOCKED_BACKOFF || "120", "TAP_WATCH_BLOCKED_BACKOFF"));
    } catch (error) {
      s.stderr(`tap watch: ${(error as Error).message}`);
      return { touched, rc: 1 };
    }
    // `[ "$now" -ge "$fire_at" ] || continue`: a non-integer `now` is a `[` error, read as "not due"
    const nowN = testInt(now);
    if (nowN === null) { s.stderr(`tap watch: now is not an integer: ${JSON.stringify(now)}`); continue; }
    if (nowN < fireAt) continue;
    if (!s.leaseCurrent(armedAt)) return { touched, rc: 0 };
    if (!s.seatActive(handle)) continue;
    // `state="$(_watch_tick_seat_state "$handle" 2>/dev/null || echo unknown)"`: a failed
    // classifier's output gets "unknown" appended to it
    const st = s.seatState(handle);
    const state = st.ok ? st.out : `${st.out}unknown`;
    const wa = digitsOrZero(cmdSubst(s.windowActivity(handle)));
    // `[ "$state" != "idle-at-prompt" ] || { [ "$wa" -gt 0 ] && [ "$wa" -gt "$since" ]; }`:
    // a non-integer `since` fails the `[` (status 2, a line on stderr) -- "no activity"
    let active = state !== "idle-at-prompt";
    if (!active && BigInt(wa) > 0n) {
      const sinceN = testInt(since);
      if (sinceN === null) s.stderr(`tap watch: blocked_map[${handle}].since is not an integer: ${JSON.stringify(since)}`);
      else active = BigInt(wa) > sinceN;
    }
    if (active) {
      map = subst(() => blockedRemove(map, handle));
      if (classifyBlockedTranscript(cmdSubst(s.peek(handle))) !== "") exempt = subst(() => probedAppend(exempt, handle));
      s.leaseSet([["blocked_map", map], ["blocked_exempt", exempt]]);
    } else {
      const reasonText = reason === "session_limit" ? CONTINUE_REASON.session_limit : CONTINUE_REASON.other;
      map = subst(() => blockedRemove(map, handle));
      exempt = subst(() => probedAppend(exempt, handle));
      s.leaseSet([["blocked_map", map], ["blocked_exempt", exempt]]);
      const body = continueBody(s.continueTemplate(), reasonText, armedBy);
      const r = s.sendContinue(handle, body);
      if (r.rc !== 0 && r.rc !== 5) s.stderr(`tap watch: continue send to '${handle}' failed (rc=${r.rc}): ${r.err}`);
    }
    touched.push(handle);
  }
  return { touched, rc: 0 };
}

/** `_watch_classify_blocked <handle>`: the transcript through the ladder (the tick's own call site reaches it by name). */
export function classifyBlocked(handle: string, s: Pick<BlockedSeams, "peek">): string {
  return classifyBlockedTranscript(cmdSubst(s.peek(handle)));
}

// --- production seams ------------------------------------------------------------------------

/** The production world: W2a's seams for the lease, the roster cache, the resolved pane and B's classifier, plus this pass's own. */
export function realBlockedSeams(a: RealSeamsArgs): BlockedSeams {
  const env = a.env ?? process.env;
  const base = realSeams(a);
  const arm = armPath(a.bus);
  const tickActive = env.TAP_WATCH_TICK_ACTIVE === "1";
  const identity = env.TAP_WATCH_IDENTITY || WATCH_IDENTITY_DEFAULT;
  // `_watch_tick_resolved_pane`, as W2a resolves it (cache + liveness in a tick, the registry outside one)
  const resolvedPane = (handle: string): string | null => base.resolvedPane(handle);
  return {
    leaseField: (key) => base.leaseField(key),
    leaseSet: (pairs) => { try { leaseWrite(arm, pairs.flatMap(([k, v]) => [k, v]), env); } catch { /* `|| true` */ } },
    leaseCurrent: (armedAt) => base.leaseCurrent(armedAt),
    seatActive: (handle) => !tickActive || base.rosterHandles().includes(handle),
    seatState: (handle) => {
      const pane = resolvedPane(handle);
      if (pane === null) return { out: "unknown", ok: true };
      return { out: seatState(handle, { registry: a.registry, home: a.bus, pane, env }), ok: true };
    },
    windowActivity: (handle) => {
      // `pane="$(_watch_tick_resolved_pane "$1" || true)"`: an unresolved pane is the EMPTY target
      const r = tmuxReadOnly(["display-message", "-p", "-t", resolvedPane(handle) ?? "", "#{window_activity}"], env);
      return r.code === 0 ? r.stdout : "";
    },
    peek: (handle) => {
      const r = peekResult(handle, a.scripts, childBusEnv(a.bus, env));
      return r.stdout ?? "";
    },
    // `_watch_send_continue ... || true`: a draft that could not be written, a courier
    // that could not be spawned or a cleanup that failed stayed inside the send attempt
    // -- the pass reported the send and went on. Nothing here throws. The courier
    // resolves its bus from the ambient environment, as it did for the Bash caller
    // (only `TAP_SELF` was set on the call); the draft lives under the tick's bus,
    // which the sidecar loop and the `tick` verb hand in as the same `TAP_HOME`.
    sendContinue: (handle, body) => {
      const dir = join(a.bus, "watch");
      const draft = join(dir, `.continue.${process.pid}.md`);
      const errPath = join(dir, `.continue.${process.pid}.err`);
      let result: { rc: number; err: string };
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(draft, body);
        const [cmd, ...argv] = courierArgv(a.scripts, [handle, draft, "--from", identity, "--kind", "probe", "--fyi"], env);
        const r = spawnSync(cmd!, argv, { encoding: "utf8", env: { ...env, TAP_SELF: identity }, stdio: ["inherit", "ignore", "pipe"] });
        const err = (r.error ? r.error.message : (r.stderr ?? "")).split("\n")[0] ?? "";
        result = { rc: r.status ?? 1, err };
      } catch (error) {
        result = { rc: 1, err: (error as Error).message.split("\n")[0] ?? "" };
      }
      for (const p of [draft, errPath]) { try { rmSync(p, { force: true }); } catch { /* best effort, as `rm -f` was */ } }
      return result;
    },
    continueTemplate: () => {
      try { return cmdSubst(readFileSync(join(a.scripts, "watch-templates", "continue.md"), "utf8")); } catch { return ""; }
    },
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
}

/** `_watch_lease_current` over the bus, for callers that hold only the bus path. */
export function leaseCurrent(bus: string, armedAt: string): boolean {
  const arm = armPath(bus);
  try { return cmdSubst(fieldValue(readLoose(arm), "armed_at")) === armedAt; } catch { return false; }
}

// --- CLI: reached from the still-Bash tick through `_watch_tick_bun` ----------------------------
//
//   watch-blocked.ts process-blocked <armed_at> <now> <armed_by> [<blocked_map> [<blocked_exempt>]]
//   watch-blocked.ts classify <handle>
//
// process-blocked prints the touched handles one per line and exits with the status
// the incumbent's substitution carried; classify prints the ladder's line, or nothing.
// The bus and the acting registry arrive as TAP_WATCH_DETECT_BUS / _REGISTRY (the
// tick's adapter sets them), the scripts dir is this file's sibling tree.

export function main(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  const [verb, ...rest] = argv;
  const scripts = tapScriptsDir();
  const bus = env.TAP_WATCH_DETECT_BUS ?? env.TAP_HOME ?? "";
  const registry = env.TAP_WATCH_DETECT_REGISTRY ?? "";
  try {
    switch (verb) {
      case "process-blocked": {
        if (rest.length < 3) throw new Error("usage: watch-blocked.ts process-blocked <armed_at> <now> <armed_by> [<blocked_map> [<blocked_exempt>]]");
        const s = realBlockedSeams({ bus, scripts, registry, env, now: rest[1]! });
        const r = processBlocked(rest[0]!, rest[1]!, rest[2]!, rest[3] ?? "", rest[4] ?? "", s, env);
        for (const h of r.touched) process.stdout.write(`${h}\n`);
        return r.rc;
      }
      case "classify": {
        if (rest.length < 1) throw new Error("usage: watch-blocked.ts classify <handle>");
        const s = realBlockedSeams({ bus, scripts, registry, env, now: "" });
        const line = classifyBlocked(rest[0]!, s);
        if (line) process.stdout.write(`${line}\n`);
        return 0;
      }
      default:
        throw new Error(`watch-blocked.ts: unknown verb ${JSON.stringify(verb ?? "")}`);
    }
  } catch (error) {
    process.stderr.write(`tap watch: ${(error as Error).message}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
