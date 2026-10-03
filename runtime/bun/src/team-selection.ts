// Sender-side team/bus selection for the pane-less obligation verbs.
//
// THREE claimants can name a bus and they are not a two-way choice:
//   1. a CALLER-pinned TAP_HOME,
//   2. an explicit `--team`,
//   3. the cwd enrollment walk.
//
// `applyTeamOverride` sets TAP_HOME but the selector's walk wins over TAP_HOME
// under a live marker (`selectFromWalk` consults it only as a LAST fallback), so
// passing the override alone lets the cwd win and `--team` silently does nothing
// (tap-7rkcc). Resolving through the selector's explicit-team path fixes that
// pair — but it still leaves the third case wrong: with a caller pin present we
// suppressed `--team` and then passed NO pinned selection, so the enrolled cwd
// won over the pin too (partner review, G2-F1). The conjunct prevented `--team`
// from beating the pin; it never made the pin beat the walk.
//
// Precedence implemented here, matching what the incumbent documents:
// caller pin > `--team` > cwd walk > TAP_HOME fallback.
//
// Concurrency fence: selection results are asserted current by
// `assertSelectionCurrent` (selector.ts) under the registry lock minted by
// `acquireRegistryLock` (panelock.ts), wired in at registry-tx.ts and
// forwarding-receipt.ts. Nothing here acquires that lock; U1 adds no new lock
// and no per-process memo — the worktree scan below pays a spawn per call by
// design (tap-1t0h.1).
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { readIndexJson, resolveTeamMarkerAware } from "./index-home";
import { carrierArgs, writeResult } from "./slices/result-pairs";
import { resolveContext, teamRootFromBus, TapError, type ResolvedContext } from "./context";

/**
 * Resolve the acting context for a verb that accepts `--team`.
 *
 * `callerPin` must be read BEFORE `applyTeamOverride` runs — the override sets
 * `TAP_HOME` itself, so reading it afterwards always finds one and collapses
 * every caller into the pinned branch.
 */
export function resolveSelection(
  callerPin: string,
  team: string,
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): ResolvedContext {
  if (!callerPin) {
    return resolveContext(cwd, env, team ? { explicitTeam: team } : undefined);
  }
  // A CALLER PIN DECIDES, and `--team` is never consulted beside it. Falling
  // back to the explicit-team path let `--team` win whenever the pin was not an
  // enrolled root, which is the opposite of the documented precedence.
  try {
    const pinned = resolveContext(cwd, env, { pinnedRoot: teamRootFromBus(callerPin) });
    // ROOT MATCH IS NOT BUS MATCH. `pinnedRoot` resolves a root to ITS ACTING
    // bus, so a caller pinned at a non-acting bus under that root was silently
    // redirected — and then WRITTEN to, on a bus the caller never named. The
    // selector's own TAP_HOME path owns that refusal (`bus_not_acting`); only
    // accept the pinned selection when it is the bus the caller actually pinned.
    if (sameBus(pinned.bus.home, callerPin)) return pinned;
    if (pinned.marker === "live") {
      // NOT the acting bus for its own root, and the root IS enrolled — the
      // selector resolved it to its authority-backed acting bus. Falling
      // through to the walk is what the first fix did, and from an ENROLLED
      // cwd the walk ignores TAP_HOME entirely — so the caller's pin was
      // replaced by the acting bus and then written to. Refuse instead: a
      // caller pin is honoured exactly or refused, never silently redirected.
      throw new TapError(1, "bus_not_acting",
        "unset TAP_HOME, or point it at this team's acting bus",
        `TAP_HOME='${callerPin}' is not the acting bus for its root (that is '${pinned.bus.home}') — refusing rather than acting on a bus you did not name`);
    }
    // An ABSENT marker's "acting bus" was CONSTRUCTED (`<root>/.tap/bus`
    // default), not read off an enrollment — so this mismatch does not mean
    // the pin lost to an enrolled root; it means the pin names a standalone
    // bus (the sandbox/probe pattern) in a world with no authority to
    // contradict it. The historical path below resolves from the pin's own
    // root and either honours it exactly or refuses. Under a live marker the
    // same shape never reaches this line: bindPinnedRoot throws
    // `unanchored_bus` for the unenrolled pin root and the catch above lands
    // on the same path. The marker state, not the pin, decides the door —
    // (gate red 2026-09-17: caveat-generated-surfaces arm (e), fresh-index
    // sandbox, pin `$WORK/pollbus`, refusal fired on the preserved pattern).
  } catch (error) {
    // `ambiguous_team` and `live_unreachable` are faults, not a cue to reselect.
    if (!(error instanceof TapError) || error.errorClass !== "unanchored_bus") throw error;
    // Only a pin that names no enrolled root at all reaches the historical
    // path — the sandbox/probe pattern of pinning a standalone bus. Narrowed
    // deliberately: widening this to refuse every unenrolled pin would break
    // that pattern fleet-wide and is a tap-1t0h.1 selector design change, not
    // a fix for this finding.
  }
  // A STANDALONE pin is still the caller's answer, so resolve from the PIN's OWN
  // root rather than from `cwd`. Resolving from the caller's cwd re-opened the
  // whole hole from a different direction: the walk ignores TAP_HOME whenever
  // the cwd is enrolled, so from an ENROLLED FOREIGN cwd the pin was silently
  // dropped and the cwd's bus used instead — `withdraw` returned 0 while writing
  // `.cancelled` to a bus the caller never named, and `poll`/`digest-window`
  // answered about the wrong one (review, three public
  // doors). That is the same shape as the short-write defect: a terminal effect
  // on the wrong object, reported as success.
  //
  // This does NOT refuse standalone pins — that is the `tap-1t0h.1` change
  // deferred to protect the sandbox/probe pattern, and those callers still
  // resolve exactly as before, because the pin's own root is unenrolled there
  // too and the walk's TAP_HOME fallback still answers.
  // Custom parents anchor this env-pinned walk; they never authorize new team
  // storage. An optional context anchor is the separate tap-1t0h.1 contract.
  const viaPin = resolveContext(teamRootFromBus(callerPin), env);
  if (sameBus(viaPin.bus.home, callerPin)) return viaPin;
  // Could not be honoured even from its own root: refuse rather than answer
  // about some other bus. Honoured exactly, or refused — never redirected.
  throw new TapError(1, "bus_not_acting",
    "unset TAP_HOME, or point it at the bus you mean",
    `TAP_HOME='${callerPin}' could not be honoured from its own root (that resolved to '${viaPin.bus.home}') — refusing rather than acting on a bus you did not name`);
}

function sameBus(a: string, b: string): boolean {
  if (!a || !b) return false;
  const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  return real(a) === real(b);
}

/**
 * The `worktree_root` recorded on a team's acting registry — twin of
 * `tap_team_bound_root`. Strict UTF-8 with BOM refusal via `readIndexJson`.
 * No realpath resolution.
 *
 * The state split is the registration-safety contract (u1 round-1,
 * r4045876920): `ok` means the file PARSED — root may legitimately be empty
 * (no binding recorded yet). `error` means the registry exists but could not
 * be read (bad UTF-8, BOM, JSON, shape) — the old body collapsed that into
 * empty, and the caller then treated a bound team as a fresh bus and re-derived
 * the worktree from the caller's cwd. Unreadable must be distinguishable from
 * unbound so registration can refuse.
 */
export function boundWorktreeRoot(registryPath: string): { state: "ok" | "error"; root: string } {
  try {
    const doc = readIndexJson(registryPath);
    const team = (doc as { team?: unknown }).team;
    if (typeof team !== "object" || team === null || Array.isArray(team)) return { state: "ok", root: "" };
    const root = (team as Record<string, unknown>).worktree_root;
    return { state: "ok", root: typeof root === "string" ? root : "" };
  } catch {
    return { state: "error", root: "" };
  }
}

export interface WorktreeScanResult {
  state: "found" | "ambiguous" | "missing" | "error";
  /** The worktree path, `found` only. */
  root: string;
  /** ambiguous: matching paths joined ", " · missing: sibling basenames or
   *  "<none>" · error: the git failure reason. Python-scan output parity —
   * tap_resolve_team_target put these verbatim in TAP_TT_DETAIL. */
  detail: string;
}

/**
 * The unique git worktree under `repoRoot` whose basename equals `team` —
 * twin of the pre-flip `tap_worktree_team_root` scan (lib.sh). `repoRoot` is
 * the SENDER's root, so the scan cannot cross repos.
 *
 * ERROR is its own state, never a silent miss (u1 round-1, r4045876930): a
 * git fault or a truncated (maxBuffer-exceeded) listing must not hide a
 * sibling behind `missing`, so the diagnostics carry through to
 * tap_resolve_team_target's `error` scope. maxBuffer is explicit and large —
 * the 1MiB default would kill the spawn on a many-worktree repo and old
 * Python surfaced that as ERROR, which must stay ERROR, not vanish.
 */
export function worktreeTeamRoot(team: string, repoRoot: string): WorktreeScanResult {
  const siblingList = (paths: string[]): string =>
    paths.map((p) => basename(p.replace(/[\\/]+$/, ""))).join(", ") || "<none>";
  if (!team || !repoRoot) return { state: "missing", root: "", detail: siblingList([]) };
  const proc = spawnSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (proc.error || proc.status !== 0 || proc.stdout == null) {
    const reason = proc.error?.message ?? `git exited ${proc.status}`;
    return { state: "error", root: "", detail: `git worktree list failed: ${reason}` };
  }
  const paths = proc.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  const matches = paths.filter((p) => basename(p.replace(/[\\/]+$/, "")) === team);
  if (matches.length === 1) return { state: "found", root: matches[0] ?? "", detail: "" };
  if (matches.length > 1) return { state: "ambiguous", root: "", detail: matches.join(", ") };
  return { state: "missing", root: "", detail: siblingList(paths) };
}

if (import.meta.main) {
  const usage =
    "usage: team-selection.ts <op> --result <path> -- <args…>\n" +
    "  resolve-team <team> | resolve-root <team> | bound-root <registry-path> |\n" +
    "  worktree-root <team> <repo-root>";
  const carrier = carrierArgs(process.argv.slice(2), usage);
  if (!carrier) process.exit(2);
  const { op, result, rest } = carrier;
  // EXACT arity per op — extra operands are a usage error (exit 2), not
  // silently ignored input (u1 round-1 finding 2).
  const one = (): string | null => (rest.length === 1 && rest[0] ? (rest[0] as string) : null);
  const two = (): [string, string] | null => {
    const [a, b] = rest as [string | undefined, string | undefined];
    return rest.length === 2 && a && b ? [a, b] : null;
  };
  try {
    if (op === "resolve-team") {
      const team = one();
      if (!team) throw "arity";
      const r = resolveTeamMarkerAware(team);
      writeResult(result, { _IT_STATUS: r.status, _IT_ROOT: r.root, _IT_REGISTRY_LOCATION: r.registryLocation });
    } else if (op === "resolve-root") {
      const team = one();
      if (!team) throw "arity";
      const r = resolveTeamMarkerAware(team);
      const root = (r.status === "ok" || r.status === "unreachable" || r.status === "historical") && r.root ? r.root : "";
      writeResult(result, { _IR_ROOT: root });
    } else if (op === "bound-root") {
      const registryPath = one();
      if (!registryPath) throw "arity";
      const b = boundWorktreeRoot(registryPath);
      writeResult(result, { _IB_STATE: b.state, _IB_ROOT: b.root });
    } else if (op === "worktree-root") {
      const args = two();
      if (!args) throw "arity";
      const w = worktreeTeamRoot(args[0], args[1]);
      writeResult(result, { _IW_STATE: w.state, _IW_ROOT: w.root, _IW_DETAIL: w.detail });
    } else {
      throw "arity";
    }
  } catch (e) {
    if (e === "arity") {
      process.stderr.write(`${usage}\n`);
      process.exit(2);
    }
    process.stderr.write(`team-selection: ${String(e)}\n`);
    process.exit(1);
  }
}
