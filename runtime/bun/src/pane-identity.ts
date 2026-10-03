/**
 * Point-of-effect pane identity: is the pane we are about to press Enter in
 * still the pane we were authorized against?
 *
 * This is `lib.sh`'s `tap_submit_identity_guard`, natively. It exists to delete
 * a live native-to-Bash BACKCALL: `recovery/identity-guard.ts` spawned
 * `bash -c '. lib.sh; tap_submit_identity_guard "$@"'` from inside the Bun
 * courier, so the newest code on the hottest safety path reached its answer
 * through the implementation it was replacing.
 *
 * The bound arm is `observe-gather.ts`'s `boundPaneIdentityState`, the one
 * owner every native spool and nudge caller already uses. This module adds the
 * rowless arm, the whole-guard budget, and the two globals' values.
 *
 * FAIL-CLOSED is the whole design: every result other than `match` refuses. A
 * matching pane id alone is never delivery authority — ids recycle across tmux
 * server generations, and an agent pane can fall back to a shell without
 * changing its address or its id.
 */
import { agentFamilies, buildSnapshot, harnessEvidence, sessionPanesFor, US, type ObservePayload } from "./observe";
import { boundPaneIdentityState, gather } from "./observe-gather";
import { recordedPermissions } from "./delivery-permissions";
import { DeadlineExhausted, ServerUnresponsive } from "./tmux";

export interface IdentityDeps {
  env?: NodeJS.ProcessEnv;
  /**
   * A whole-guard wall-clock budget in ms, handed to every spawn and checked
   * again before any authorization. The subprocess this replaced carried a
   * 10 s `spawnSync` timeout; a per-spawn bound alone is not a total. Unset
   * means unbounded.
   */
  budgetMs?: number;
  /** False when the caller's shell routes tmux through a router native cannot represent. */
  nativeRouter?: boolean;
  /** Test seams; production takes the real bound owner and the real scoped gather. */
  bound?: typeof boundPaneIdentityState;
  /** `processTable` false: the caller reads no harness evidence, so skip ps. */
  snapshot?: (scope: string, env: NodeJS.ProcessEnv, remainingMs?: () => number, processTable?: boolean) => ObservePayload;
}

/**
 * Rowless manual relay authority. This escape hatch deliberately does NOT call a
 * seat active: the operator supplied a pane outside a recipient registry. It
 * proves only that one exact session is observable and that the designated
 * address and id are still a member of it at this effect boundary. With the
 * caller's preflight harness family it also proves the pane did not fall back
 * to a shell or another agent first.
 */
export interface UnboundPaneRecord {
  state: string;
  /** The designated pane's live id and the session's server epoch, once observed. */
  paneId: string;
  epoch: string;
}

export function unboundPaneIdentityRecord(
  session: string, pane: string,
  expected: { paneId?: string; harness?: string; families?: readonly string[] },
  env: NodeJS.ProcessEnv = process.env,
  snapshot: NonNullable<IdentityDeps["snapshot"]> = realSnapshot, remainingMs?: () => number,
): UnboundPaneRecord {
  const verdict = (state: string, paneId = "", epoch = ""): UnboundPaneRecord => ({ state, paneId, epoch });
  if (!session || !pane) return verdict("identity_incomplete");
  if (!pane.startsWith(`${session}:`)) return verdict("pane_outside_session");
  // Explicit families govern the whole observation: the gather decides from
  // them whether a shallow command needs the process table.
  const obsEnv = expected.families ? { ...env, TAP_OBS_HARNESS_FAMILIES: expected.families.join(" ") } : env;
  // A record with no expected harness never reads harness evidence, so it pays
  // for no system-wide process scan.
  const snap = buildSnapshot(snapshot(session, obsEnv, remainingMs, Boolean(expected.harness)), obsEnv);
  // A nonzero tmux exit or a mixed-epoch snapshot is never absence proof; a
  // readable snapshot that does not name the session is.
  if (snap.sessionsMode === "unobservable") return verdict("session_unobservable");
  if (snap.sessionsMode === "empty" || !snap.sessions.has(session)) return verdict("session_absent");
  const epoch = snap.sharedEpoch;
  const rows = sessionPanesFor(snap.panesBySession, snap.panesMode, session, epoch);
  // Every address in the set is session-qualified, or none of the set is trusted.
  if (!rows || rows.some(row => !row.address.includes(":"))) return verdict("pane_set_unobservable", "", epoch);
  const found = rows.find(row => row.address === pane);
  if (!found) return verdict("designated_pane_missing", "", epoch);
  if (expected.paneId && found.pane_id !== expected.paneId) return verdict("pane_recycled", found.pane_id, epoch);
  if (found.dead) return verdict("pane_dead", found.pane_id, epoch);
  if (expected.harness) {
    const { state } = harnessEvidence(
      expected.harness, found.command, found.pane_pid, snap.psRows, snap.psOk, agentFamilies(obsEnv),
    );
    if (state === "exited") return verdict("harness_exited", found.pane_id, epoch);
    if (state === "mismatch") return verdict("harness_mismatch", found.pane_id, epoch);
    if (state !== "alive") return verdict("harness_unobservable", found.pane_id, epoch);
  }
  return verdict("match", found.pane_id, epoch);
}

// No clock probes: the rowless check reads only sessions, panes and ps, and a
// wedged `sysctl` must not add seconds to every point-of-effect check.
const realSnapshot: NonNullable<IdentityDeps["snapshot"]> = (scope, env, remainingMs, processTable) => {
  const g = gather({ scope, env, remainingMs, processTable });
  const payload: ObservePayload = {
    sessions_rc: g.sessions_rc, sessions_text: g.sessions_text, panes_rc: g.panes_rc, panes_text: g.panes_text,
    ps_rc: g.ps_rc, ps_text: g.ps_text, session_scope: scope,
    now_boot: "", legacy_boot: "", now_ts: 0, tap_boot_id_set: false, tap_boot_id_legacy_set: false,
  };
  if ("TAP_SERVER_EPOCH" in env) payload.server_epoch_pin = env.TAP_SERVER_EPOCH ?? "";
  return payload;
};

/**
 * `authorized` and `refused` are the incumbent's rc 0 and rc 6. `unobservable`
 * and `fault` also refuse; they say the instrument could not look, which is a
 * different fact from a pane that drifted. `nudge-recovery-policy.test.ts`
 * reads this outcome BY VALUE out of `events.jsonl`.
 */
export type IdentityOutcome = "authorized" | "refused" | "unobservable" | "fault";

export interface IdentityGuardResult {
  outcome: IdentityOutcome;
  /** The guard's state token (`match`, `pane_drift`, `harness_exited`, …). */
  state: string;
  /** What `lib.sh` wrote to stderr, or null where it wrote nothing. */
  message: string | null;
  /** TAP_SUBMIT_HARNESS_ALIVE. */
  harnessAlive: boolean;
  /** TAP_SUBMIT_PERMISSIONS. */
  permissions: string;
}

/**
 * The identity states that say the INSTRUMENT could not look, as opposed to
 * saying the seat is gone: a guard that spent its own budget, a tmux server
 * that would not answer, and every `<thing>_unobservable` refusal the shared
 * bound arm mints (`session_unobservable`, `harness_unobservable`,
 * `boot_id_unobservable`, ...). `registry_missing` is deliberately NOT here —
 * a registry that is positively absent means nobody can be bound, which the
 * readiness walk reads as `gone`. `observe.ts:18-19` is the doctrine: an
 * unobservable probe never reads as drift or death.
 */
export function identityUnobservable(state: string): boolean {
  return state === "guard_deadline" || state === "server_unresponsive" || state.endsWith("_unobservable");
}

function outcomeFor(state: string): IdentityOutcome {
  return identityUnobservable(state) || state === "registry_missing" ? "unobservable" : "refused";
}

const DENIED = (state: string, message: string | null): IdentityGuardResult =>
  ({ outcome: outcomeFor(state), state, message, harnessAlive: false, permissions: "bypass" });

export function submitIdentityGuard(
  registry: string, handle: string, pane: string, paneId: string,
  rowlessSession = "", rowlessHarness = "", deps: IdentityDeps = {},
): IdentityGuardResult {
  const env = deps.env ?? process.env;
  const started = performance.now();
  const budget = deps.budgetMs;
  // Re-read at every spawn, floored because a fractional spawnSync timeout is a
  // RangeError, and thrown when spent so no spawn starts that it cannot bound.
  const remainingMs = budget === undefined ? undefined : () => {
    const left = Math.floor(budget - (performance.now() - started));
    if (left <= 0) throw new DeadlineExhausted();
    return left;
  };
  const deadline = () => DENIED("guard_deadline", "tap: pane identity guard exceeded its deadline before pane effect");
  // LATE AUTHORIZATION refuses too: a guard whose last spawn returned just
  // inside its own bound can still have spent the total,
  // and recovery holds its pane mutex across this answer.
  const inBudget = (result: IdentityGuardResult): IdentityGuardResult => {
    if (result.outcome !== "authorized" || !remainingMs) return result;
    try { remainingMs(); return result; } catch { return deadline(); }
  };
  try {
    return inBudget(guardBody(registry, handle, pane, paneId, rowlessSession, rowlessHarness, env, deps, remainingMs));
  } catch (error) {
    if (error instanceof DeadlineExhausted) return deadline();
    // A tmux that would not answer is an instrument failure, not a drift.
    if (error instanceof ServerUnresponsive) {
      return DENIED("server_unresponsive", `tap: pane identity unobservable before pane effect (${error.message})`);
    }
    throw error;
  }
}

function guardBody(
  registry: string, handle: string, pane: string, paneId: string,
  rowlessSession: string, rowlessHarness: string, env: NodeJS.ProcessEnv,
  deps: IdentityDeps, remainingMs?: () => number,
): IdentityGuardResult {
  if (!registry) {
    // No registry and no rowless session: no guard was asked for. The globals
    // keep their closed defaults, because nothing was proven.
    if (!rowlessSession) {
      return { outcome: "authorized", state: "unguarded", message: null, harnessAlive: false, permissions: "bypass" };
    }
    if (!paneId) return DENIED("identity_incomplete", "tap: incomplete rowless pane identity before pane effect");
    // The router refusal the bound owner applies, on the rowless arm too: an
    // observation that cannot share the caller's route says nothing about the
    // pane the keystroke reaches.
    const state = deps.nativeRouter === false ? "harness_unobservable"
      : unboundPaneIdentityRecord(rowlessSession, pane, { paneId, harness: rowlessHarness }, env, deps.snapshot ?? realSnapshot, remainingMs).state;
    if (state === "match") {
      // Observation confirms a carried harness expectation; it never mints one.
      return { outcome: "authorized", state, message: null, harnessAlive: Boolean(rowlessHarness), permissions: "bypass" };
    }
    return DENIED(state, `tap: rowless pane identity drifted before pane effect (${state})`);
  }
  if (!handle || !paneId) return DENIED("identity_incomplete", "tap: incomplete bound recipient identity before pane effect");
  const state = (deps.bound ?? boundPaneIdentityState)(registry, handle, pane, paneId, env, deps.nativeRouter ?? true, remainingMs);
  if (state !== "match") return DENIED(state, `tap: bound recipient identity drifted before pane effect (${state})`);
  const permissions = recordedPermissions(registry, handle);
  // The incumbent's one SILENT refusal, and it leaves `unknown` in the global:
  // the Bash assigns before it tests, and a `|| return 0` caller reads the
  // global after discarding the refusal.
  if (permissions === "unknown") return { ...DENIED("permissions_unknown", null), permissions };
  return { outcome: "authorized", state, message: null, harnessAlive: true, permissions };
}

if (import.meta.main) {
  // `guard <router> <registry> <handle> <pane> <pane_id> [<rowless-session> [<rowless-harness>]]`.
  // THE VERDICT IS THE TOKEN, NEVER THE EXIT STATUS: a module that fails to load
  // exits nonzero, so a computed refusal cannot share that signal. It always
  // exits 0 and prints `outcome US alive US permissions US state`.
  const [door, router = "", a = "", b = "", c = "", d = "", e = "", f = ""] = Bun.argv.slice(2);
  if (door !== "guard") {
    process.stderr.write(`pane-identity: unknown door '${door ?? ""}'\n`);
    process.exit(2);
  }
  let result: IdentityGuardResult;
  try {
    result = submitIdentityGuard(a, b, c, d, e, f, { nativeRouter: router === "0" });
  } catch (error) {
    result = {
      outcome: "fault", state: "guard_fault",
      message: `tap: pane identity guard failed before pane effect (${error instanceof Error ? error.message : String(error)})`,
      harnessAlive: false, permissions: "bypass",
    };
  }
  if (result.message) process.stderr.write(`${result.message}\n`);
  console.log([result.outcome, result.harnessAlive ? "1" : "0", result.permissions, result.state].join(US));
}
