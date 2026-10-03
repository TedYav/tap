// The watch tick's evaluator rung and escalation chain (slice W2b): `_watch_evaluate`
// (the one-shot model verdict with its pre-check, budget and lease-nonce guards,
// and the disarm / notify actions) and `_watch_build_chain` (the live rung order),
// ported statement for statement from tap-watch.sh over a `Seams` object -- every
// read of the world and every effect crosses it -- so the frozen-capture oracle can
// drive one scripted world through the incumbent (shell function shims) and through
// these runners (a fixture-backed Seams) and compare outputs and effects
// (runtime/bun/test/watch-evaluator.test.ts).
//
// Outside this module, by charter: the pane READS (seat state via seat-state.ts,
// pane liveness, the `tap peek` transcript with retained capture) are lane B's; the evaluator binary is
// the operator's configured model CLI, spawned with the incumbent's argv.
//
// Grammar (reached from the tick through `_watch_bun_run`):
//   watch-evaluator.ts evaluate                       -> the rung's status (0 acted, 1 no verdict)
//   watch-evaluator.ts build-chain <overrides> <terminal>   -> the chain, one seat per line
//   watch-evaluator.ts next-unprobed <probed-json>    -> the next rung by identity (chain on stdin)
//   watch-evaluator.ts probed-append <probed-json> <seat>   -> the episode's probed list, compact
//   watch-evaluator.ts has-unsettled                  -> 0 when an unsettled non-supervision payload exists

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";

import { resolveContext } from "./context";
import { DEFAULT_AGENT_FAMILIES } from "./observe";
import { type Seat } from "./registry";
import { finish as remindFinish } from "./remind";
import { tmuxReadOnly } from "./tmux";
import { cmdSubst, isMap, loads, pyIntArg, type JsonValue } from "./watch-detect";
import { seatState } from "./seat-state";
import { peekResult } from "./verbs/peek";
import { hasUnsettled, nextUnprobed, normField, normalizeVerdict, probedAppend, probeWorthy, pyJsonTool, renderEvaluatorPrompt } from "./watch-evaluate";
import { fieldValue, isFile, readLoose, set as leaseSet } from "./watch-lease";
import { armPath, noticeOrNotify, notifyHuman } from "./watch-notice";
import { registryPanes, seatsOf, repoRoot } from "./watch-registry";
import { childBusEnv } from "./panelock";
import { tapScriptsDir } from "./scripts-dir";

// --- the world ------------------------------------------------------------------------

export interface Seams {
  /** Read a field from the current watch lease. */
  leaseField(key: string): string;
  /** `tap_watch_set <key> <value>`: the lease module's status (never CAS-qualified on this path). */
  leaseSet(key: string, value: string): number;
  /** `_watch_lease_current <armed_at>`. */
  leaseCurrent(armedAt: string): boolean;
  /** `_watch_has_unsettled` (exit 0 = an unsettled non-supervision payload exists). */
  hasUnsettled(): boolean;
  /** `_watch_now`: TAP_WATCH_NOW or the clock, as a string. */
  now(): string;
  /** `$$`: the tick's pid in the prompt / verdict file names. */
  pid(): string;
  /** `_watch_observable_state`'s text (before the caller's `$( )`). */
  observableState(): string;
  /** `_watch_transcripts`'s text (before the caller's `$( )`). */
  transcripts(): string;
  /** `watch-templates/evaluate-prompt.md`. */
  template(): string;
  /** Write the rendered prompt; `TAP_WATCH_LOGS` is created first. */
  writePrompt(path: string, text: string): void;
  /** `_watch_invoke_evaluator <bin> <prompt> <raw> <timeout>`: the model CLI's status; 127 missing, 124 timed out. */
  invokeEvaluator(bin: string, promptPath: string, rawPath: string, timeout: string): number;
  /** The raw verdict file's text, or null when it cannot be read (the normaliser's `except` -> 2). */
  readRaw(rawPath: string): string | null;
  /** The normalised verdict file (`json.dump`): 0, or the normaliser's failure status when it cannot be written. */
  writeNorm(normPath: string, text: string): number;
  /** Remove a scratch file the rung wrote; a file that is not there is fine. */
  discard(path: string): void;
  /** `_watch_notice_or_notify <to> <reason> <evidence>`. */
  noticeOrNotify(to: string, reason: string, evidence: string): number;
  /** `_watch_notify_human <reason>`. */
  notifyHuman(reason: string): number;
  /** `_watch_finish_supervision <armed_at>`: 0, or the adapter's failure status. */
  finishSupervision(armedAt: string): number;
  /** One diagnostic line on stderr (`tap watch: <line>`), where bash printed its own. */
  warn(line: string): void;
  /** Where `_watch_write_evaluator_prompt` puts the file: `$TAP_WATCH_LOGS/<name>` (the directory is created). */
  writePromptPath(name: string): string;
  // --- the chain ---
  /** `_watch_roster_handles`. */
  rosterHandles(): string[];
  /** `_watch_rung_eligible <handle>`: tick-admitted, pane-delivered, pane resolved, a known harness. */
  rungEligible(handle: string): boolean;
  /** `_watch_tick_seat_state <handle> 2>/dev/null || echo unknown`. */
  seatState(handle: string): string;
  /** `_watch_seat_recency <handle>`: window_activity epoch, "0" when unknown. */
  seatRecency(handle: string): string;
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * `[ "$x" -ge 2 ]`: bash 5's `legal_number` -- `strtoimax` in base 10 after C-locale
 * whitespace, an optional sign, decimal digits, within int64, then C-locale whitespace
 * again (bash 3.2 took only blanks on the right; the watcher runs under the bash on
 * PATH, 5.x here and in CI, and the oracle was captured with 5.3). Anything else is
 * `integer expected`: status 2, which the `&&` list reads as false, plus one
 * diagnostic line (R2 -- bash's names the script and line).
 */
export function testInt(text: string): bigint | null {
  const m = /^[ \t\n\v\f\r]*([+-]?[0-9]+)[ \t\n\v\f\r]*$/.exec(text);
  if (!m) return null;
  const v = BigInt(m[1]!);
  return v >= INT64_MIN && v <= INT64_MAX ? v : null;
}

/**
 * `$(( calls + 1 ))`: bash evaluates the field's TEXT as an arithmetic expression. The
 * port reads ONE number in every literal form bash has -- blank (an empty expression is
 * 0), a unary sign (blanks after it allowed), decimal, `0`-prefixed octal, `0x` hex,
 * `base#digits` for bases 2-64, wrapping at int64 -- and ends the rung on anything
 * else: a fatal expansion error in bash (`abc` under `set -u`, `1.5`, `1e1`, a `\r`),
 * and, as a RATIFIED deviation (R2b, by the leader), an
 * expression (`1+1`, `(1)`, `--1`) bash would have evaluated -- a hand edit the lease
 * writer never produces.
 */
export function arithPlusOne(text: string): string {
  return BigInt.asIntN(64, arithLiteral(text, "evaluator_calls") + 1n).toString();
}

/**
 * A shell variable's value as bash's arithmetic evaluator reads it inside `$(( ))`:
 * blanks trimmed, "" is 0, an optional spaced sign, decimal, `0`-octal, `0x`-hex or
 * `base#digits`; anything else -- an expression, a float, a name -- is refused
 * (bash would have evaluated the expression or died on the name under `set -u`;
 * the R2b ruling). The caller names the value for the refusal.
 */
export function arithLiteral(text: string, what: string): bigint {
  const t = text.replace(/^[ \t\n]+|[ \t\n]+$/g, "");
  if (t === "") return 0n;
  const bad = (): never => { throw new Error(`${what} is not an arithmetic literal: ${JSON.stringify(text)}`); };
  // (the base is spelled without a leading zero: bash refuses `02#1`; partner R1-B1 / astra P3)
  const m = /^([+-]?)[ \t\n]*(0[xX][0-9a-fA-F]*|0[0-7]*|[1-9][0-9]*|([1-9][0-9]*)#([0-9a-zA-Z@_]+))$/.exec(t);
  if (!m) return bad();
  const digits = m[2]!;
  let v: bigint;
  if (m[3] !== undefined) {
    // `base#n`, bases 2-64: digits 0-9, then a-z (10-35), A-Z (36-61), @ (62), _ (63); up to
    // base 36 the letters are one case; a digit at or past the base is "value too great"
    const base = BigInt(m[3]);
    if (base < 2n || base > 64n) bad();
    v = 0n;
    for (const ch of m[4]!) {
      let dgt: bigint;
      if (ch >= "0" && ch <= "9") dgt = BigInt(ch.charCodeAt(0) - 48);
      else if (ch >= "a" && ch <= "z") dgt = BigInt(ch.charCodeAt(0) - 97 + 10);
      else if (ch >= "A" && ch <= "Z") dgt = BigInt(ch.charCodeAt(0) - 65 + (base <= 36n ? 10 : 36));
      else if (ch === "@") dgt = 62n;
      else dgt = 63n;
      if (dgt >= base) bad();
      v = v * base + dgt;
    }
  } else {
    v = /^0[xX]/.test(digits) ? BigInt(digits.length > 2 ? digits : "0") : /^0./.test(digits) ? BigInt(`0o${digits.slice(1)}`) : BigInt(digits);
  }
  if (m[1] === "-") v = -v;
  return v;
}

// --- the rung ------------------------------------------------------------------------------

/**
 * `_watch_evaluate`: returns non-zero (no verdict) so the chain advances mechanically.
 * The deterministic pre-check runs BEFORE any model (AE9); the <=2/episode budget
 * (R13) is enforced here; a lease nonce captured at entry guards every side effect.
 *
 * The tick calls it as `_watch_evaluate || true`, so `set -e` is ignored throughout:
 * only the explicit returns decide the status, and a failed notice or notification
 * is a status the incumbent never looked at. (A fatal expansion error is the one
 * thing that still ends it -- see `arithPlusOne`.)
 */
export function evaluate(s: Seams, bus: string, scripts: string, env: NodeJS.ProcessEnv = process.env): number {
  // every value the rung tested or used crossed a `$( )`: trailing newlines and NULs gone
  const evaluator = cmdSubst(s.leaseField("evaluator"));
  if (evaluator === "none") return 1; // rung disabled entirely
  if (s.hasUnsettled()) return 1; // pre-check: not_done, no model (AE9)
  let calls = cmdSubst(s.leaseField("evaluator_calls"));
  if (!calls) calls = "0";
  const n = testInt(calls);
  if (n === null) s.warn(`evaluator_calls is not an integer: ${JSON.stringify(calls)}`);
  if (n !== null && n >= 2n) return 1; // budget: <=2 per wedge episode
  const entryArmedAt = cmdSubst(s.leaseField("armed_at")); // nonce: the model call is slow (T4)
  s.leaseSet("evaluator_calls", arithPlusOne(calls)); // `|| true`
  const prompt = writeEvaluatorPrompt(s, scripts);
  const raw = join(bus, "watch", `evaluator-${s.pid()}-${calls}.json`);
  const norm = join(bus, "watch", `evaluator-${s.pid()}-${calls}.normalized.json`);
  const timeout = env.TAP_WATCH_EVALUATOR_TIMEOUT ?? "30";
  // A failed invocation keeps whatever partial streams the model published (the
  // incumbent did, and the containment smoke pins it). Once the model answered, the
  // verdict files are scratch: read below, then discarded on every exit, so a
  // long-lived watch does not accumulate three files per evaluation (tap-kju).
  if (s.invokeEvaluator(evaluator, prompt, raw, timeout) !== 0) return 1;
  try {
    const rawText = s.readRaw(raw);
    // `_watch_normalize_verdict ... || return 1`: the program's own refusal (2) or its
    // uncaught exception (1, a traceback -- one line here) both end the rung
    let normalised: ReturnType<typeof normalizeVerdict>;
    try { normalised = rawText === null ? { status: 2 as const } : normalizeVerdict(rawText); } catch (error) {
      s.warn((error as Error).message);
      return 1;
    }
    if (normalised.status !== 0) return 1;
    if (s.writeNorm(norm, normalised.norm) !== 0) return 1;
    const verdict = cmdSubst(normField(normalised.norm, "verdict"));
    const action = cmdSubst(normField(normalised.norm, "action"));
    const reason = cmdSubst(normField(normalised.norm, "reason"));
    const evidence = cmdSubst(normField(normalised.norm, "evidence_text"));
    if (verdict === "done" && action === "disarm") {
      // Lease-nonce guard before the side effect: a slow evaluator must not disarm a lease that
      // a concurrent `watch on` re-armed mid-evaluation with stale "done" evidence.
      if (!s.leaseCurrent(entryArmedAt)) return 0;
      const armedBy = cmdSubst(s.leaseField("armed_by"));
      s.noticeOrNotify(armedBy, "evaluator verdict: done", evidence); // status unread
      if (s.finishSupervision(entryArmedAt) !== 0) return 1;
      return 0;
    }
    if (verdict === "blocked") {
      // Same guard before writing/notifying: a stale "blocked" verdict must not land on (and
      // NOTIFY the human about) a fresh episode.
      if (!s.leaseCurrent(entryArmedAt)) return 1;
      s.leaseSet("not_done_reason", reason || "blocked"); // `|| true`
      s.notifyHuman(`evaluator blocked: ${reason || "blocked"}`); // status unread
      return 0;
    }
    if (verdict === "not_done") {
      if (!s.leaseCurrent(entryArmedAt)) return 1;
      s.leaseSet("not_done_reason", reason || "not done");
      return 1;
    }
    return 1;
  } finally {
    for (const path of [raw, `${raw}.stderr`, norm]) s.discard(path);
  }
}

/** `_watch_write_evaluator_prompt`: render to `$TAP_WATCH_LOGS/<now>-<pid>.md`, record its path, return it. */
function writeEvaluatorPrompt(s: Seams, scripts: string): string {
  void scripts;
  const now = cmdSubst(s.now());
  const out = `${now}-${s.pid()}.md`;
  const doneWhen = cmdSubst(s.leaseField("done_when"));
  const observable = cmdSubst(s.observableState());
  const transcripts = cmdSubst(s.transcripts());
  const path = s.writePromptPath(out);
  s.writePrompt(path, renderEvaluatorPrompt(s.template(), doneWhen, observable, transcripts));
  s.leaseSet("last_evaluator_prompt", path); // `|| true`
  return path;
}

// --- the chain -------------------------------------------------------------------------------

/**
 * `_watch_build_chain <chain_overrides_json> <terminal>`: the rung order, one seat per
 * line, ending in `__human__`. With overrides the authored order is kept and only
 * PROBE-WORTHY eligible seats survive; otherwise idle eligible non-goalie seats by
 * recency (most recently active first), then the goalie, then the terminal seat if it
 * is itself a stopped eligible seat, then the human.
 */
export function buildChain(overrides: string, terminal: string, s: Seams): string {
  const out: string[] = [];
  let seats: string[] = [];
  const hasOverrides = overrides !== "" && overrides !== "[]";
  if (hasOverrides) {
    for (const handle of overrideHandles(overrides)) {
      if (!handle) continue;
      if (!s.rungEligible(handle)) continue;
      if (!probeWorthy(s.seatState(handle))) continue;
      seats.push(handle);
    }
  } else {
    const rows: Array<{ recency: string; handle: string; order: number }> = [];
    let order = 0;
    for (const handle of s.rosterHandles()) {
      if (!handle) continue;
      if (handle === "goalie") continue;
      if (!s.rungEligible(handle)) continue;
      if (s.seatState(handle) !== "idle-at-prompt") continue; // only STOPPED seats are probed
      rows.push({ recency: s.seatRecency(handle), handle, order: order++ });
    }
    // `sort -rn | cut -f2`: numeric descending on the recency; sort is stable only by
    // the whole line, so equal recencies fall to the line's own byte order (the handle)
    rows.sort((a, b) => {
      const d = compareNumericDesc(a.recency, b.recency);
      if (d !== 0) return d;
      return Buffer.compare(Buffer.from(`${b.recency}\t${b.handle}`), Buffer.from(`${a.recency}\t${a.handle}`));
    });
    seats = rows.map((r) => r.handle);
  }
  for (const handle of seats) if (handle && handle !== terminal) out.push(handle);
  if (!hasOverrides && terminal !== "goalie" && s.rungEligible("goalie") && s.seatState("goalie") === "idle-at-prompt") out.push("goalie");
  // The terminal seat is a probe rung ONLY if it is itself a STOPPED, eligible seat
  // (R7/R9): a working terminal is suppressed, a dead terminal falls through to the
  // human without wasting a probe on it.
  if (terminal && s.rungEligible(terminal) && s.seatState(terminal) === "idle-at-prompt") out.push(terminal);
  out.push("__human__");
  return out.map((l) => `${l}\n`).join("");
}

/** The override list's string members, in order (`json.load` in `try/except: []`; non-strings skipped). */
/**
 * The override branch's python: `json.load` inside `try/except: []`, then
 * `[print(h) for h in data if isinstance(h, str)]` read back line by line. A list
 * yields its strings, a dict its keys, a string its code points; a number, bool or
 * null is not iterable -- the python raised and its output was discarded. `print`
 * then `read -r` splits a handle on its own newlines.
 */
function overrideHandles(overrides: string): string[] {
  let v: JsonValue;
  try { v = loads(overrides); } catch { return []; }
  let items: string[];
  if (Array.isArray(v)) items = v.filter((h): h is string => typeof h === "string");
  else if (isMap(v)) items = [...v.keys()];
  else if (typeof v === "string") items = [...v];
  else return [];
  return items.length === 0 ? [] : items.join("\n").split("\n");
}

/** `sort -rn` on two leading numeric strings: descending by numeric value (a non-number reads as 0). */
function compareNumericDesc(a: string, b: string): number {
  const na = /^-?[0-9]+/.exec(a.trim())?.[0];
  const nb = /^-?[0-9]+/.exec(b.trim())?.[0];
  const va = na === undefined ? 0n : BigInt(na);
  const vb = nb === undefined ? 0n : BigInt(nb);
  return va === vb ? 0 : va > vb ? -1 : 1;
}

// --- production seams -------------------------------------------------------------------------

export interface RealSeamsArgs {
  bus: string;
  scripts: string;
  registry: string;
  env?: NodeJS.ProcessEnv;
}

export function realSeams(a: RealSeamsArgs): Seams {
  const env = a.env ?? process.env;
  const bus = a.bus;
  const arm = armPath(bus);
  const payloads = env.TAP_PAYLOADS ?? join(bus, "payloads");
  const receipts = env.TAP_RECEIPTS ?? join(bus, "receipts");
  const logs = env.TAP_WATCH_LOGS ?? join(bus, "watch", "evaluator-prompts");
  const tickActive = env.TAP_WATCH_TICK_ACTIVE === "1";
  const warn = (line: string): void => { process.stderr.write(`tap watch: ${line}\n`); };
  const seats = (): Record<string, Seat> | null => {
    // `[ -f registry.json ]` (rule 38, F4); an old-format registry is a said refusal, read as no record.
    return seatsOf(a.registry);
  };
  const isSeat = (v: unknown): v is Seat => typeof v === "object" && v !== null && !Array.isArray(v);
  const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
  const rosterHandles = (): string[] => {
    if (tickActive && env.TAP_WATCH_TICK_ROSTER_HANDLES !== undefined) return env.TAP_WATCH_TICK_ROSTER_HANDLES.split("\n");
    const m = seats();
    if (!m) return [];
    return Object.entries(m).filter(([, e]) => isSeat(e) && (e.status ?? "active") === "active").map(([h]) => h);
  };
  const paneAlive = (pane: string): string => {
    // M6 U1: native read. tmux 3.6a answers a dead pane with rc 0 and an EMPTY
    // `#{pane_id}` expansion, so "rc 0 + empty id" is not alive.
    const r = tmuxReadOnly(["display-message", "-p", "-t", pane, "#{pane_id}"], env);
    return r.code === 0 ? cmdSubst(r.stdout) : "";
  };
  const resolvedPane = (handle: string): string | null => {
    if (tickActive && env.TAP_WATCH_TICK_PANE_RECORDS !== undefined) {
      for (const rec of env.TAP_WATCH_TICK_PANE_RECORDS.split("\n")) {
        const [cachedHandle, cachedPane = "", cachedId = ""] = rec.split("\x1f");
        if (cachedHandle !== handle) continue;
        return cachedId !== "" && paneAlive(cachedPane) === cachedId ? cachedPane : null;
      }
      return null;
    }
    const pane = registryPanes(a.registry, handle, false)[0] ?? "";
    return pane === "" ? null : pane;
  };
  const tickSeatActive = (handle: string): boolean => {
    if (!tickActive) return true;
    return (env.TAP_WATCH_TICK_ROSTER_HANDLES ?? "").split("\n").includes(handle);
  };
  return {
    leaseField: (key) => fieldValue(readLoose(arm), key),
    leaseSet: (key, value) => {
      try { return leaseSet(arm, [key, value], env); } catch { return 1; }
    },
    leaseCurrent: (armedAt) => isFile(arm) && cmdSubst(fieldValue(readLoose(arm), "armed_at")) === armedAt, // The lease still names this arm generation.
    hasUnsettled: () => hasUnsettled(payloads, receipts),
    now: () => env.TAP_WATCH_NOW || String(Math.floor(Date.now() / 1000)),
    pid: () => String(process.ppid), // the tick's shell is the parent: its `$$` named these files
    observableState: () => {
      const root = repoRoot(a.registry);
      const parts: string[] = [];
      parts.push("git log --oneline -5:\n");
      const g = spawnSync("git", ["-C", root, "log", "--oneline", "-5"], { encoding: "utf8", env });
      parts.push(g.status === 0 ? g.stdout : "unavailable\n");
      parts.push("\nwatch state:\n");
      let armText: string | null = null;
      if (isFile(arm)) { try { armText = pyJsonTool(readFileSync(arm, "utf8")); } catch { armText = null; } }
      parts.push(armText ?? "unavailable\n");
      parts.push("\npayload ids:\n");
      parts.push(ids(payloads, ".md"));
      parts.push("\nreceipt ids:\n");
      parts.push(ids(receipts, ".done"));
      return parts.join("");
    },
    transcripts: () => {
      const parts: string[] = [];
      for (const h of rosterHandles()) {
        if (!h) continue;
        parts.push(`## ${h}\n`);
        const r = peekResult(h, a.scripts, childBusEnv(bus, env));
        parts.push(tail(r.stdout ?? "", 80));
        if (r.status !== 0) parts.push("unavailable\n"); // pipefail: the peek's status reaches `|| printf`
        parts.push("\n");
      }
      return parts.join("");
    },
    template: () => readFileSync(join(a.scripts, "watch-templates", "evaluate-prompt.md"), "utf8"),
    // `mkdir -p "$TAP_WATCH_LOGS"` and the prompt redirection ran inside `$( )` with errexit
    // unset: a failure is a diagnostic, and the rung carries on (the model then reads a
    // prompt that is not there and the invocation fails on its own)
    writePromptPath: (name) => {
      try { mkdirSync(logs, { recursive: true }); } catch (error) { warn(`mkdir: ${logs}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`); }
      return join(logs, name);
    },
    writePrompt: (path, text) => {
      try { writeFileSync(path, text); } catch (error) { warn(`${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`); }
    },
    invokeEvaluator: (bin, promptPath, rawPath, timeout) => {
      // python `int(timeout_s)` (whitespace, sign, underscores, Unicode digits) or 30 on ValueError
      let seconds: number;
      try { seconds = Number(pyIntArg(timeout)); } catch { seconds = 30; }
      // `open(prompt, errors="replace").read()` in text mode: replacement decoding, universal newlines
      let prompt: string;
      try { prompt = universalNewlines(readFileSync(promptPath, "utf8")); } catch { return 1; } // `open()` raised: the traceback's exit 1
      // subprocess.run(timeout=<=0) expires before the model answers; spawnSync's 0 would mean no limit
      if (!(seconds > 0)) return 124;
      const schema = join(a.scripts, "watch-templates", "evaluator-verdict.schema.json");
      const r = spawnSync(bin, ["exec", "--output-schema", schema, "--sandbox", "read-only", "--ask-for-approval", "never"], {
        env, input: prompt, timeout: Math.min(seconds * 1000, 2 ** 31 - 1), killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
      });
      if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") return 127;
      if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") return 124;
      if (r.error) return 1; // any other spawn failure (EACCES, ...) raised past python's except clauses: no files, exit 1
      // (a SIGKILL that is NOT the deadline's -- the model killed itself or was killed -- is an
      // ordinary signal death below: streams published, `sys.exit(-signum)`)
      // `subprocess.run(text=True)`: both streams decoded STRICTLY as UTF-8 (an invalid byte
      // in either raised past the except clauses -- exit 1, no verdict files),
      // the BOM kept, `\r\n`/`\r` read as `\n`
      let stdout: string;
      let stderr: string;
      try { stdout = universalNewlines(STRICT_UTF8.decode(r.stdout ?? Buffer.alloc(0))); stderr = universalNewlines(STRICT_UTF8.decode(r.stderr ?? Buffer.alloc(0))); } catch { return 1; }
      try {
        writeFileSync(rawPath, stdout);
        writeFileSync(`${rawPath}.stderr`, stderr);
      } catch { return 1; } // `open(..., "w")` raised: the traceback's exit 1
      if (r.status === null && r.signal) return (256 - (constants.signals[r.signal] ?? 0)) & 255; // sys.exit(-signum)
      return r.status ?? 1;
    },
    readRaw: (rawPath) => { try { return readFileSync(rawPath, "utf8"); } catch { return null; } },
    writeNorm: (normPath, text) => { try { writeFileSync(normPath, text); return 0; } catch { return 1; } }, // the normaliser's `open(out, "w")` raised
    discard: (path) => { rmSync(path, { force: true }); },
    noticeOrNotify: (to, reason, evidence) => noticeOrNotify({ bus, scripts: a.scripts, to, reason, evidence, now: env.TAP_WATCH_NOW || String(Math.floor(Date.now() / 1000)), env }),
    notifyHuman: (reason) => notifyHuman({ bus, scripts: a.scripts, reason, now: env.TAP_WATCH_NOW || String(Math.floor(Date.now() / 1000)), env }),
    finishSupervision: (armedAt) => {
      try { remindFinish(join(bus, "watch", "reminders.json"), armedAt, true); return 0; } catch (error) {
        process.stderr.write(`tap watch: ${(error as Error).message}\n`);
        return 1;
      }
    },
    warn,
    rosterHandles,
    rungEligible: (handle) => {
      if (!tickSeatActive(handle)) return false;
      const m = seats();
      const e = m?.[handle];
      const delivery = isSeat(e) && (e.delivery === "pane" || e.delivery === "poll") ? e.delivery : "pane";
      if (delivery === "poll") return false;
      if (resolvedPane(handle) === null) return false;
      const harness = isSeat(e) ? str(e.harness) : "";
      return (DEFAULT_AGENT_FAMILIES as readonly string[]).includes(harness);
    },
    seatState: (handle) => {
      const pane = resolvedPane(handle);
      if (pane === null) return "unknown";
      return seatState(handle, { registry: a.registry, home: bus, pane, env });
    },
    seatRecency: (handle) => {
      const pane = resolvedPane(handle) ?? "";
      const r = tmuxReadOnly(["display-message", "-p", "-t", pane, "#{window_activity}"], env);
      const wa = r.code === 0 ? cmdSubst(r.stdout) : "";
      return /^[0-9]+$/.test(wa) ? wa : "0";
    },
  };
}

/** `find <dir> -maxdepth 1 -type f -name '*<ext>' -exec basename {} <ext> \; | sort | tail -20` (C collation). */
function ids(dir: string, ext: string): string {
  let names: string[];
  try { names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith(ext)).map((d) => d.name.slice(0, -ext.length)); } catch { return ""; }
  names.sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
  return names.slice(-20).map((n) => `${n}\n`).join("");
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** python's text-mode read: `\r\n` and a lone `\r` become `\n`. */
function universalNewlines(text: string): string { return text.replace(/\r\n?/g, "\n"); }

/** `tail -80`: the last 80 lines, the final line's newline as it was. */
function tail(text: string, n: number): string {
  if (text === "") return "";
  const trailing = text.endsWith("\n");
  const lines = (trailing ? text.slice(0, -1) : text).split("\n");
  const kept = lines.slice(-n);
  return kept.join("\n") + (trailing ? "\n" : "");
}

// --- CLI ---------------------------------------------------------------------------------

export function main(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  const [verb, ...rest] = argv;
  // the two pure cursor steps read no world (the python read argv and stdin only)
  if (verb === "next-unprobed") {
    process.stdout.write(`${nextUnprobed(rest[0] ?? "", readFileSync(0, "utf8"))}\n`);
    return 0;
  }
  if (verb === "probed-append") {
    process.stdout.write(`${probedAppend(rest[0] ?? "", rest[1] ?? "")}\n`);
    return 0;
  }
  let bus: string;
  let registry: string;
  if (env.TAP_WATCH_DETECT_BUS !== undefined) {
    bus = env.TAP_WATCH_DETECT_BUS;
    registry = env.TAP_WATCH_DETECT_REGISTRY ?? "";
  } else {
    const ctx = resolveContext(process.cwd(), env);
    bus = ctx.bus.home;
    registry = ctx.registryPath;
  }
  const scripts = tapScriptsDir();
  const world = realSeams({ bus, scripts, registry, env });
  switch (verb) {
    case "evaluate":
      return evaluate(world, bus, scripts, env);
    case "build-chain": {
      if (rest.length < 2) throw new Error("usage: watch-evaluator.ts build-chain <overrides-json> <terminal>");
      // the tick reads this through `chain="$(...)"`, where the incumbent could not fail
      // (its last statement printed `__human__`): a broken world still yields the human
      let chain: string;
      try { chain = buildChain(rest[0]!, rest[1]!, world); } catch (error) {
        process.stderr.write(`tap watch: build-chain: ${(error as Error).message}\n`);
        chain = "__human__\n";
      }
      process.stdout.write(chain);
      return 0;
    }
    case "has-unsettled":
      return world.hasUnsettled() ? 0 : 1;
    default:
      throw new Error(`watch-evaluator.ts: unknown action ${JSON.stringify(verb ?? "")}`);
  }
}

if (import.meta.main) {
  try { process.exit(main(process.argv.slice(2))); } catch (error) {
    process.stderr.write(`tap watch: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
