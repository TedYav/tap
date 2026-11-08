/**
 * ONE observation gather.
 *
 * `observe.ts` has been the single seat CLASSIFIER since the Python engine was
 * deleted, but the snapshot it classifies was still collected in two places:
 * `lib.sh tap_observe_roster_batch` (tmux into three temp files, then
 * `observe.ts --from-env`) and `verbs/team.ts observe()` (the same two tmux
 * spellings in TypeScript). Neither was a thin adapter — both carried the
 * coverage PARSER, the staged per-session RETRY, and the need-`ps` DECISION —
 * so "the classifier is one place" was true while the input to it was not.
 *
 * This module is that one place. The Bash body is deleted and its adapter calls
 * `observe.ts --gather-from-env`; `team.ts observe()` calls `gather()` directly.
 * The point-of-effect identity guard needs the same snapshot for ONE seat, which
 * is why `scope` is a parameter here rather than a fourth copy of the gather.
 */
import {
  spawnProcessTable, classifyHarness, harnessFamily, nativeClaudeCommand, agentFamilies, observeRows,
  observeHarnessPidFromTable, readProcessTableMemoized,
  parsePanes, parseSessions,
  type ObservePayload, type RowInput, type PaneRecord,
} from "./observe";
import { bootId, DeadlineExhausted, legacyBootId, serverEpochFromRaw, ServerUnresponsive, tmuxReadOnly } from "./tmux";
import { pyReadUtf8 } from "./spool-publication";
import { isFile } from "./watch-lease";
import { teamRegistryRefusal } from "./register-authority";
import { isMap, loads, pyStr, pyTruthy, type JsonMap, type JsonValue } from "./watch-detect";

export const SESSIONS_FORMAT = "#{session_name}\t#{pid}:#{start_time}\t#{session_attached}";
export const PANES_FORMAT =
  "#{session_name}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_id}\t#{pane_current_command}\t#{pane_pid}\t#{pid}:#{start_time}\t#{pane_dead}\t#{@tap_crew_lifetime}\t#{@tap_crew_lifetime_token}\t#{pane_title}";

export type TmuxRun = (args: string[], env: NodeJS.ProcessEnv) => { code: number; stdout: string };
export type PsRun = (env: NodeJS.ProcessEnv) => { status: number | null; stdout: string | null };

export interface GatherOptions {
  /**
   * An exact session name. Present => ONE `list-panes -s -t =<scope>` and no
   * global inventory: a point-of-effect read must not pay for `-a` (sol P1 /
   * defer-spool 7c). Absent => the roster's `-a` with its coverage fallback.
   */
  scope?: string;
  /** `tap admin --fast`: refuse an incomplete snapshot instead of re-querying. */
  fast?: boolean;
  env?: NodeJS.ProcessEnv;
  /**
   * The caller's whole-operation remaining time in ms, RE-READ before every
   * spawn (tmux, ps, and the boot probes) and min'd with that spawn's own
   * bound. A callback because the value that matters is the budget left at
   * each spawn: a number sampled once let three sequential probes hold
   * recovery's pane mutex past a 10 s guard budget.
   * It throws `DeadlineExhausted` when spent. Unset means each spawn
   * keeps its own bound. Production runners only; an injected `run`/`ps`
   * bounds itself.
   */
  remainingMs?: () => number;
  /**
   * Injected for tests ONLY. The coverage fallback and the `--fast` refusal are
   * reached by a tmux that answers incompletely, which a healthy server does not
   * do — so the payload differential against the Bash incumbent cannot exercise
   * them and something else has to.
   */
  run?: TmuxRun;
  ps?: PsRun;
  /** False when the caller will not read harness evidence: no system-wide ps. */
  processTable?: boolean;
}

export interface Gathered {
  sessions_rc: number; sessions_text: string;
  panes_rc: number; panes_text: string;
  ps_rc: number; ps_text: string;
  /** The one epoch every observed session agreed on, or "" — `team`'s receipt. */
  serverEpoch: string;
}

function sessionNames(text: string): string[] {
  return text.split("\n").filter(Boolean).map(line => line.split("\t", 1)[0]!).filter(Boolean);
}

/**
 * Every observed session must appear as the EXACT first field of a COMPLETE
 * pane record. An unanchored `session<TAB>` search falsely covers `demo/a` when
 * only `x-demo/a` is present (sol P2), and a truncated row is not coverage.
 */
function panesCoverSessions(sessions: string[], text: string): boolean {
  const covered = new Set(
    text.split("\n").filter(Boolean)
      .map(line => { const f = line.split("\t"); return (f.length === 7 || f.length >= 10) && (f[6] === "0" || f[6] === "1") ? f[0]! : ""; })
      .filter(Boolean),
  );
  return sessions.every(name => covered.has(name));
}

function snapshotServerEpoch(text: string, env: NodeJS.ProcessEnv): string {
  const epochs = new Set<string>();
  for (const line of text.split("\n").filter(Boolean)) {
    const raw = line.split("\t")[1] ?? "";
    const epoch = raw ? serverEpochFromRaw(raw, env) : "";
    if (!epoch) return "";
    epochs.add(epoch);
  }
  return epochs.size === 1 ? [...epochs][0]! : "";
}

/**
 * `ps` is skipped when every pane's SHALLOW command already classifies, because
 * `harnessEvidence` never walks the table in that case and an unconditional
 * `ps -Ao` races timing-sensitive callers (defer-spool 7c / sol P1). A missing
 * pane inventory cannot tell us, so it gathers.
 *
 * A row whose command field is EMPTY reads as unsupported and gathers. For the
 * COLLAPSE shape that matches the Bash, and the obvious reading of the Bash is
 * wrong: `while IFS=$'\t' read -r s a id cmd rest` splits with TAB as an IFS
 * WHITESPACE character, so bash COLLAPSES the empty field rather than yielding
 * it, and `cmd` receives the next field along (the pane pid) — which does not
 * classify, so the incumbent gathers too. A first version of this port read the
 * Bash as `[ -n "$cmd" ] || continue` skipping the row, and `team.test.ts`'s
 * "an empty shallow pane field triggers the same process-table fallback as
 * Bash" is what refused it.
 *
 * FOR A GENUINELY TRUNCATED ROW — three fields or fewer, nothing to collapse —
 * this is a DELIBERATE DIVERGENCE and not the incumbent.
 * There `cmd` really is empty, the incumbent's `[ -n "$cmd" ]` skips the
 * row, and `ps` may never be gathered. This port gathers. Corruption should buy
 * MORE evidence, not less, and the row is poisoned for `sessionPanesFor` either
 * way — so the choice costs one `ps` and cannot make a verdict more permissive.
 * Named rather than left inside a parity claim that covers only the other shape.
 */
function needsProcessTable(panesRc: number, panesText: string, families: readonly string[], env: NodeJS.ProcessEnv): boolean {
  if (panesRc !== 0 || !panesText) return true;
  for (const line of panesText.split("\n")) {
    if (!line) continue;
    const command = line.split("\t")[3] ?? "";
    if (families.includes("claude") && nativeClaudeCommand(command, env)) continue;
    const klass = classifyHarness(harnessFamily(command, families), families);
    if (klass !== "agent" && klass !== "denylist") return true;
  }
  return false;
}

export function gather(options: GatherOptions = {}): Gathered {
  const env = options.env ?? process.env;
  const scope = options.scope ?? "";
  const fast = options.fast ?? false;
  const remaining = options.remainingMs;
  const run: TmuxRun = options.run ?? (remaining ? (args, e) => tmuxReadOnly(args, e, undefined, remaining()) : tmuxReadOnly);

  const sessions = run(["list-sessions", "-F", SESSIONS_FORMAT], env);
  const sessionsRc = sessions.code;
  const sessionsText = sessionsRc === 0 ? sessions.stdout : "";
  const serverEpoch = sessionsRc === 0 ? snapshotServerEpoch(sessionsText, env) : "";
  const names = sessionsRc === 0 ? sessionNames(sessionsText) : [];

  let panesRc: number;
  let panesText: string;
  if (scope) {
    // Scoped: exactly one query, and its own failure is the only failure. There
    // is no coverage question — the caller named the session it cares about.
    const scoped = run(["list-panes", "-s", "-t", `=${scope}`, "-F", PANES_FORMAT], env);
    panesRc = scoped.code === 0 ? 0 : 1;
    panesText = scoped.code === 0 ? scoped.stdout : "";
  } else {
    const all = run(["list-panes", "-a", "-F", PANES_FORMAT], env);
    panesRc = all.code;
    panesText = all.code === 0 ? all.stdout : "";
    // THE TWO BRANCHES DO NOT SHARE A CONDITION, and that is the incumbents'
    // doing rather than a simplification missed here.
    //
    // The Bash roster treats an EMPTY `-a` as incomplete unconditionally
    // (`[ ! -s "$panes_file" ]` → fall back). `team.ts --fast` did not: its
    // refusal was `panes.code !== 0 || (names.length > 0 && !covered)`, with no
    // emptiness term at all, so zero observed sessions named nothing to cover
    // and an empty answer stood as *affirmatively no panes*.
    //
    // Folding the emptiness term into both — which this module did until
    // review measured it — flips exactly one real machine
    // shape: a lingering server with every session closed (`exit-empty off`)
    // answers `list-sessions` non-zero and `list-panes -a` rc 0 with no rows.
    // Under the folded condition `tap admin --fast` turned every registered
    // seat from the affirmatively-gone family into `unknown:pane_set_unobservable`,
    // which is the three-state collapse this file exists to prevent, inverted.
    const incomplete = fast
      ? panesRc !== 0 || (names.length > 0 && !panesCoverSessions(names, panesText))
      : panesRc !== 0 || !panesText
        || (sessionsRc === 0 && names.length > 0 && !panesCoverSessions(names, panesText));
    if (incomplete) {
      if (fast) {
        // `--fast` promises no second round of queries, so an incomplete
        // inventory is refused rather than repaired.
        panesRc = 1; panesText = "";
      } else {
        // Stage each session and append only on rc 0: a session that emits rows
        // and THEN fails must not be authorized as active by a later peer's
        // success (sol P2).
        const chunks: string[] = [];
        if (sessionsRc === 0) {
          for (const name of names) {
            const chunk = run(["list-panes", "-s", "-t", `=${name}`, "-F", PANES_FORMAT], env);
            if (chunk.code === 0) chunks.push(chunk.stdout);
          }
        }
        // Three states, not two. An EMPTY successful chunk set is `rc 0` with no
        // rows ("this server has no panes"); no successful chunk at all is
        // `rc 1` ("the pane set is unreadable"). Collapsing them would turn an
        // unreadable inventory into an affirmative empty one.
        panesRc = chunks.length > 0 ? 0 : 1;
        panesText = chunks.length > 0 ? chunks.join("") : "";
      }
    }
  }

  const families = agentFamilies(env);
  let psRc = 1;
  let psText = "";
  if (options.processTable !== false && needsProcessTable(panesRc, panesText, families, env)) {
    const ps = options.ps ? options.ps(env) : spawnProcessTable(env, remaining?.());
    psRc = ps.status ?? 1;
    psText = ps.stdout ?? "";
  }

  return {
    sessions_rc: sessionsRc, sessions_text: sessionsText,
    panes_rc: panesRc, panes_text: panesText,
    ps_rc: psRc, ps_text: psText,
    serverEpoch,
  };
}

export interface ClockOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * A caller-sampled boot id pins the observed VALUE. It must NOT be written
   * into `TAP_BOOT_ID`, which would invent PRESENCE and disable the five-second
   * `boot:<epoch>` migration tolerance (sol P2 / tap-lae7).
   *
   * PRESENCE IS SEPARATE FROM VALUE, and collapsing them was a live defect.
   * The deleted Bash tested `[ -n "${TAP_OBS_NOW_BOOT_PIN+x}" ]`
   * — variable PRESENCE — and then assigned whatever it held, empty included. A
   * `pin || bootId(env)` reading turns an explicitly EMPTY pin, which means "the
   * caller sampled the boot id and got nothing", into an absent one, and
   * substitutes the live host boot. With a stored `row_boot` that advances
   * classification past a check the incumbent failed as unobservable.
   */
  nowBootPin?: string;
  /** True when the caller supplied a pin AT ALL, empty string included. */
  nowBootPinSet?: boolean;
  /** `GatherOptions.remainingMs`, applied to the boot probes. */
  remainingMs?: () => number;
}

/** The snapshot's clock fields, read from the env they are configured in. */
export function clockFields(options: ClockOptions = {}): {
  now_boot: string; legacy_boot: string; now_ts: number;
  tap_boot_id_set: boolean; tap_boot_id_legacy_set: boolean;
} {
  const env = options.env ?? process.env;
  const pinned = options.nowBootPinSet ?? false;
  return {
    // An explicitly empty pin stays empty. `||` here is what lost that.
    now_boot: pinned ? (options.nowBootPin ?? "") : bootId(env, undefined, undefined, options.remainingMs),
    legacy_boot: legacyBootId(env, undefined, options.remainingMs),
    now_ts: Number(env.TAP_WATCH_NOW || Math.floor(Date.now() / 1000)),
    tap_boot_id_set: env.TAP_BOOT_ID !== undefined,
    tap_boot_id_legacy_set: env.TAP_BOOT_ID_LEGACY !== undefined,
  };
}

/**
 * The snapshot the classifier consumes, gathered here rather than handed in.
 *
 * For a caller that has ALREADY gathered, the test-support fixture
 * (`test/support/observe-env-fixture.ts`, the retired `--from-env` door's
 * env assembly) builds the same payload in-process from TAP_OBS_* knobs.
 * This is the door for a caller that has not.
 */
export function gatheredPayload(
  rows: RowInput[], options: GatherOptions & ClockOptions = {},
): ObservePayload {
  const env = options.env ?? process.env;
  const g = gather(options);
  const payload: ObservePayload = {
    rows,
    sessions_rc: g.sessions_rc, sessions_text: g.sessions_text,
    panes_rc: g.panes_rc, panes_text: g.panes_text,
    ps_rc: g.ps_rc, ps_text: g.ps_text,
    session_scope: options.scope ?? "",
    ...clockFields(options),
  };
  // Absent => parse raw epochs. Present (even "") => the pin wins. `in` is the
  // test, not truthiness, because "" is a meaningful pin.
  if ("TAP_SERVER_EPOCH" in env) payload.server_epoch_pin = env.TAP_SERVER_EPOCH ?? "";
  return payload;
}

/** `observe.ts --gather-from-env`'s body. Rows in, classified records out. */
export function gatherRowsFromEnv(rows: RowInput[], env: NodeJS.ProcessEnv = process.env,
  remainingMs?: () => number): string[] {
  return observeRows(gatheredPayload(rows, {
    env, remainingMs,
    scope: env.TAP_OBS_SESSION_SCOPE ?? "",
    // `in`, not truthiness: the incumbent read variable PRESENCE, and
    // `TAP_OBS_NOW_BOOT_PIN=` set to empty is a pin whose value is "".
    nowBootPinSet: "TAP_OBS_NOW_BOOT_PIN" in env,
    nowBootPin: env.TAP_OBS_NOW_BOOT_PIN ?? "",
  }), env);
}

/**
 * The shared bound-pane refusal vocabulary; every call takes a fresh scoped observation.
 * `remainingMs` (see `GatherOptions`) bounds every spawn by the caller's budget;
 * a spent budget throws `DeadlineExhausted` to that caller rather than reading
 * as an unobservable pane.
 */
export function boundPaneIdentityState(registry: string, handle: string, boundPane: string, boundId: string,
  env: NodeJS.ProcessEnv = process.env, nativeRouter = true, remainingMs?: () => number): string {
  if (!isFile(registry)) return "registry_missing";
  let seat: JsonMap | undefined;
  let doc: JsonValue | undefined;
  try { doc = loads(pyReadUtf8(registry)); } catch { /* A malformed registry has no usable row. */ }
  // An old-format registry binds no pane: a named state, never a row read from `agents`.
  if (teamRegistryRefusal(registry, doc)) return "old_store";
  try {
    const seats = isMap(doc) ? doc.get("seats") : undefined;
    const row = isMap(seats) ? seats.get(handle) : undefined;
    if (isMap(row)) seat = row;
  } catch { /* A malformed registry has no usable row. */ }
  const field = (key: string, fallback = "") => {
    const value = seat?.has(key) ? seat.get(key) : fallback;
    return value !== undefined && pyTruthy(value) ? pyStr(value) : "";
  };
  if (!seat || field("status", "active") !== "active") return "handle_missing_or_inactive";
  if (field("delivery", "pane") === "poll") return "not_pane_delivery";
  const pane = field("pane"), paneId = field("pane_id");
  if (!boundPane || pane !== boundPane) return "pane_drift";
  if (!boundId || !paneId) return "pane_id_missing";
  if (paneId !== boundId) return "pane_id_drift";
  // tap-zk1w: authorization needs a generation claim; roster classification
  // (classifyRow) still reports an unstamped row, but it authorizes no keys.
  if (!field("server_epoch")) return "server_epoch_missing";
  if (!nativeRouter) return "harness_unobservable";
  const session = field("session") || (pane.includes(":") ? pane.split(":", 1)[0]! : "");
  const nowBoot = bootId(env, undefined, undefined, remainingMs);
  let record: string;
  try {
    record = gatherRowsFromEnv([{ key: "0", status: "active", delivery: field("delivery", "pane"), pane,
      pane_id: paneId, session, registered_at: field("registered_at"), row_epoch: field("server_epoch"),
      row_boot: field("boot_id"), harness: field("harness"), status_reason: "" }],
    { ...env, TAP_OBS_SESSION_SCOPE: session, ...(nowBoot ? { TAP_OBS_NOW_BOOT_PIN: nowBoot } : {}) }, remainingMs)[0] ?? "";
  } catch (error) {
    if (error instanceof DeadlineExhausted) throw error;
    // The former gather child reported its failure before the shell mapped it
    // to an unobservable identity. Keep that diagnostic at this shared owner.
    process.stderr.write(`tap: pane observation failed: ${String(error)}\n`);
    return "harness_unobservable";
  }
  const [, state = "", reason = "", resolvedPane = "", resolvedId = ""] = record.split("\x1f");
  if (state !== "active") return reason || `seat_${state}`;
  if (resolvedPane !== boundPane) return "pane_drift";
  if (resolvedId !== boundId) return "pane_recycled";
  return "match";
}

// --- the register chooser's snapshot view ------------------------------------
// The chooser needs the same world the roster classifies: one capture, then
// per-seat lookups. Building the view HERE keeps observe.ts the single pane
// observer and the gather the single capture; register's own module keeps only
// pure row predicates.

export interface ChooserView {
  /** The pane id a target resolves to, "" when the snapshot OBSERVED the
   *  target absent, null when the pane world is unobservable (fail-closed:
   *  a failed probe is never an observation of absence). */
  paneIdOf(target: string): string | null;
  /** The live session name of a matched pane, "" when unknown. */
  sessionOf(paneId: string): string;
  /** Live session names; null when the session world is unobservable (an
   *  unobservable snapshot never expires a launch reservation). */
  sessions: ReadonlySet<string> | null;
}

/** The chooser view over one gather. A malformed pane row poisons the whole
 *  pane world (never judge seats on a surviving subset), and an unobservable
 *  session world yields a null set rather than an empty one. */
export function chooserView(g: Gathered, env: NodeJS.ProcessEnv = process.env): ChooserView | null {
  const pin = "TAP_SERVER_EPOCH" in env ? env.TAP_SERVER_EPOCH ?? "" : null;
  const sessions = parseSessions(g.sessions_text, g.sessions_rc, pin);
  const panes = parsePanes(g.panes_text, g.panes_rc, pin);
  let records: PaneRecord[] | null = null;
  if (panes.mode === "ok") {
    records = [];
    for (const rows of panes.bySession.values()) {
      for (const row of rows) {
        if ("_bad" in row) { records = null; break; }
        records.push(row);
      }
      if (records === null) break;
    }
  }
  // An observed EMPTY session world (mode "empty") is a successful answer, not
  // an unobservable one: it yields an empty set, so an expired launch
  // reservation is not protected forever on a proven-empty server. Only an
  // unobservable snapshot maps to null.
  const live = sessions.mode === "ok" || sessions.mode === "empty" ? new Set(sessions.sessions.keys()) : null;
  return {
    paneIdOf(target: string): string | null {
      if (records === null) return null;
      if (!target) return "";
      for (const rec of records) {
        if (rec.pane_id === target || rec.address === target) return rec.pane_id;
      }
      return "";
    },
    sessionOf(paneId: string): string {
      for (const rec of records ?? []) {
        if (rec.pane_id === paneId) return rec.session;
      }
      return "";
    },
    sessions: live,
  };
}

/**
 * `tap_pane_harness_command`: the pane's harness family. A shallow command that
 * already classifies (agent or denylist) is trusted; anything else gets the pane
 * root's process observation, because `node` or a version string names no
 * harness by itself. The shallow family is the answer only when that finds none.
 *
 * `knownPanePid`, when the caller's atomic pane record already carried the pane
 * pid, replaces the targeted read. The process-table read is the per-invocation
 * MEMO (`readProcessTableMemoized`): within one CLI invocation the pane's
 * harness family does not observably change between two classification sites
 * ~milliseconds apart, and one `ps -Ao` serves them all. Chooser snapshots
 * (`gather`) keep their own fresh in-lock read; this memo is never handed to
 * them.
 */
export function paneHarnessCommand(pane: string, shallow: string, families: readonly string[],
  env: NodeJS.ProcessEnv = process.env, knownPanePid?: string): string {
  const family = harnessFamily(shallow, families);
  const kind = classifyHarness(family, families);
  if (kind === "agent" || kind === "denylist") return family;
  // An optional refinement: a pid read that cannot run keeps the shallow
  // answer, as the Bash body's `|| true` did, rather than failing the caller.
  let panePid = knownPanePid ?? "";
  if (panePid === "") {
    try {
      const pid = tmuxReadOnly(["display-message", "-p", "-t", pane, "#{pane_pid}"], env);
      panePid = pid.code === 0 ? pid.stdout.trim() : "";
    } catch (error) {
      if (!(error instanceof ServerUnresponsive)) throw error;
    }
  }
  if (panePid === "") return family;
  const { table, ok } = readProcessTableMemoized(env);
  const [state, detected] = observeHarnessPidFromTable(panePid, table, ok, families).split("\u001f");
  return state === "observed" && detected ? detected : family;
}
