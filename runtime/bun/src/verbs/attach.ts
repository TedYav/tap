// `tap attach` (R11 U-A, from the deleted tap-attach.sh): one classifier for --next and positional; picker and accepted resume stay decision-free public children.
import { spawnSync } from "node:child_process";
import { readSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { runPicker, type AttachPickerEffects, type AttachPickerQuery, type PickerIdentity, type PickerSelection } from "../attach-picker";
import { requireResolvedBus, resolveBus } from "../bushome";
import { verbArgv } from "../courier-argv";
import { noMachineIndexError, observeCallingPane, repoRoot, resolveContext, resolveSelf, spoolTeamName, TapError, type ResolvedContext } from "../context";
import { isNoMachineIndex } from "../selector";
import { flipMarkerState, readIndexJson, resolveTeamMarkerAware } from "../index-home";
import { validToken } from "../ids";
import { TOKEN_RE } from "../remote-target";
import { ServerUnresponsive, physicalSocketPath, serverEpochFromRaw, tmuxAttachClient, tmuxClientEffect, tmuxReadOnly } from "../tmux";
import { observe, readRegistry, type RegistryRow } from "./team";
import { teamRegistryFileRefusal } from "../register-authority";
import { pyReadUtf8 } from "../spool-publication";
import { callerOwnsForegroundTty } from "../launcher/prompt";
import { machineRefusal, machineVerdict, scanMachineForHandle, skipNotes } from "../attach-machine-resolve";

const str = (v: unknown): string => v === undefined || v === null ? "" : String(v);

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

function gitRoot(dir: string): string {
  return spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout?.trim() ?? "";
}

function promptYes(): boolean {
  const byte = Buffer.alloc(1);
  let answer = "";
  for (;;) {
    if (readSync(0, byte, 0, 1, null) <= 0) return false;
    if (byte[0] === 10) break;
    answer += byte.toString();
  }
  const given = answer.trim();
  if (!given || /^(y|yes)$/i.test(given)) return true;
  if (/^(n|no)$/i.test(given)) return false;
  process.stderr.write("tap attach: choose y or n\n");
  return promptYes();
}

export function cmdAttach(argv: string[], scriptsDir: string, pickerEffects?: AttachPickerEffects): number | Promise<number> {
  let target = "", noResume = false, next = false, interactive = false, tail: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-i" || arg === "--interactive") {
      if (next) throw usageExclusive();
      if (target) throw new TapError(1, "usage_error", `tap attach ${target}   (that seat)   ·   tap attach -i   (pick from a list)`, `--interactive takes no target, but '${target}' was given — name a seat or pick one, not both`);
      interactive = true;
      tail = argv.slice(i + 1);
      break;
    } else if (arg === "--next") {
      if (next) throw new TapError(1, "usage_error", "tap help attach", "duplicate --next");
      if (target) throw usageNextTarget(target);
      next = true;
    } else if (arg === "--no-resume") noResume = true;
    else if (arg.startsWith("--")) throw new TapError(1, "unknown_option", "tap help attach", `unknown option '${arg}'`);
    else if (!target) target = arg;
    else throw new TapError(1, "usage_error", "tap help attach", `unexpected arg '${arg}'`);
  }
  if (interactive) {
    for (const arg of tail) if (arg === "--next" || arg === "-i" || arg === "--interactive") throw usageExclusive();
    return runPicker(tail, scriptsDir, pickerEffects);
  }
  if (next) {
    if (target) throw usageNextTarget(target);
    if (noResume) throw new TapError(1, "usage_error", "tap attach --next   (already attach-only)   ·   tap attach --no-resume <handle>", "--next already hops with --no-resume; passing both is not a distinct meaning");
    const picked = nextPick(nextCurrent(), scriptsDir);
    return attachPositional(`${picked.team}/${picked.target}`, true, scriptsDir);
  }
  if (!target) return runPicker([], scriptsDir, pickerEffects);
  const syntax = attachTargetSyntax(target);
  let exact: TargetResolution | undefined;
  try {
    exact = resolveTeamTarget(target, process.env);
    return attachPositional(target, noResume, scriptsDir, exact);
  }
  catch (error) {
    if (error instanceof TapError && !syntax.team) {
      const elsewhere = attachElsewhere(error, syntax.handle, noResume, scriptsDir);
      if (elsewhere !== undefined) return elsewhere;
    }
    if (!(error instanceof TapError) || !humanPickerReady()) throw error;
    if (error.errorClass === "unreachable_team" && !syntax.team && !process.env.TAP_HOME && !process.env.TAP_TEAM_SELECT) {
      try { resolveContext(process.cwd(), process.env, { readOnly: true }); }
      catch (contextError) {
        if (contextError instanceof TapError && contextError.errorClass === "unanchored_bus")
          return runPicker([], scriptsDir, pickerEffects, { seatQuery: syntax.handle });
      }
    }
    if (!["not_found", "unknown_team", "unanchored_bus"].includes(error.errorClass)) throw error;
    let query: AttachPickerQuery;
    if (error.errorClass === "unknown_team" && syntax.team) query = { teamQuery: syntax.team, seatQuery: syntax.handle };
    else if (error.errorClass === "unanchored_bus") query = { teamQuery: syntax.team, seatQuery: syntax.handle };
    else if (exact) {
      // The exact resolver established a current, readable team before it
      // answered not_found. Never widen this bare/qualified seat miss.
      query = { team: exact.team, seatQuery: syntax.handle };
    } else throw error;
    return runPicker([], scriptsDir, pickerEffects, query);
  }
}

// A bare handle the current team cannot answer is looked up on every enrolled team: unique attaches
// (naming the team), several refuse. Undefined leaves the caller's own refusal or picker in force.
// An operator-named team (TAP_TEAM_SELECT) is never widened, and a registry that could not be read
// never lets a lone match count as unique.
function attachElsewhere(error: TapError, handle: string, noResume: boolean, scriptsDir: string): number | undefined {
  const missedHere = error.errorClass === "not_found" || error.errorClass === "unanchored_bus"
    || (error.errorClass === "unreachable_team" && !process.env.TAP_HOME);
  if (!missedHere || process.env.TAP_TEAM_SELECT) return undefined;
  const scan = scanMachineForHandle(handle, process.env.TAP_INDEX_HOME);
  if (!scan) return undefined;
  process.stderr.write(skipNotes(scan));
  const verdict = machineVerdict(scan);
  const refusal = machineRefusal(handle, verdict);
  if (refusal) throw refusal;
  if (verdict.kind !== "unique") return undefined;
  const target = `${verdict.hit.team}/${handle}`;
  process.stdout.write(`tap attach: '${handle}' is not on this team; resolved to ${target}\n`);
  return attachPositional(target, noResume, scriptsDir);
}

function humanPickerReady(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true && process.env.TERM !== "dumb"
    && process.env.TAP_JSON !== "1" && callerOwnsForegroundTty();
}

function attachTargetSyntax(target: string): { team?: string; handle: string } {
  if (target.includes(":") && !target.includes("/")) {
    const [team, handle, extra] = target.split(":");
    if (!team || !handle || extra !== undefined || !validToken(team) || !validToken(handle))
      throw new TapError(1, "usage_error", "tap help attach", `address '${target}' is not a valid <team>:<handle> token`);
    return { team, handle };
  }
  if (target.includes("/")) {
    const [team, handle, extra] = target.split("/");
    if (!team || !handle || extra !== undefined || !validToken(team) || !validToken(handle))
      throw new TapError(1, "usage_error", "tap help attach", `address '${target}' must be one valid <team>/<handle> token`);
    return { team, handle };
  }
  if (!validToken(target)) throw new TapError(1, "usage_error", "tap help attach", `handle '${target}' is not a valid token`);
  return { handle: target };
}

function usageExclusive(): TapError {
  return new TapError(1, "usage_error", "tap attach --next   (next unattached seat)   ·   tap attach -i   (pick from a list)", "--next and --interactive are mutually exclusive — choose one");
}

function usageNextTarget(target: string): TapError {
  return new TapError(1, "usage_error", `tap attach ${target}   (that seat)   ·   tap attach --next   (next unattached seat)`, `--next takes no target, but '${target}' was given — name a seat or use --next, not both`);
}

function nextCurrent(): string {
  const env = process.env;
  if (!env.TMUX) return "";
  const caller = observeCallingPane(env);
  if (caller.state === "outside") return "";
  if (caller.state === "unobservable") throw unobservableCaller(`(${caller.refusal})`);
  let ctx: ResolvedContext;
  // require_acting failure there is rc=2 with no refusal token: missing cursor.
  try { ctx = resolveContext(process.cwd(), env); } catch { return ""; }
  if (!isFile(ctx.registryPath)) return "";
  try {
    return resolveSelf(ctx, { status: "ok", paneId: caller.paneId, session: caller.session, serverEpoch: caller.serverEpoch }, 2, env).handle;
  } catch (error) {
    if (error instanceof TapError && error.errorClass === "generation_unverifiable") throw unobservableCaller("(reason unavailable)");
    if (error instanceof TapError) return "";
    throw error;
  }
}

function unobservableCaller(reason: string): TapError {
  return new TapError(1, "caller_identity_unobservable", "retry from a terminal whose tmux identity is observable", `refusing attach --next because the caller's tmux identity is unobservable ${reason}`);
}

// --next eligibility: not a poll row, state=active, attached "0", never the cursor; rows arrive code-point sorted (LC_ALL=C).
export function nextEligible(current: string, rows: RegistryRow[], observed: Map<string, string[]>): string[] {
  const eligible: string[] = [];
  for (const row of rows) {
    if (str(row.delivery) === "poll") continue;
    const key = str(row.handle);
    const record = observed.get(key);
    if (!record || record[0] !== "active" || record[5] !== "0" || key === current) continue;
    eligible.push(key);
  }
  return eligible;
}

function nextPick(current: string, scriptsDir: string): { team: string; target: string } {
  const unreachable = () => new TapError(1, "registry_unreachable", "tap doctor", "acting registry unreachable — refusing tap attach --next");
  let ctx: ResolvedContext;
  try { ctx = resolveContext(process.cwd(), process.env); } catch (error) { throw error instanceof TapError && isNoMachineIndex(error) ? error : unreachable(); }
  if (!isFile(ctx.registryPath)) throw unreachable();
  const team = spoolTeamName(ctx.bus.home, process.env.TAP_INDEX_HOME);
  if (!validToken(team)) throw new TapError(1, "registry_invalid", "tap doctor", "acting team name is unusable — refusing tap attach --next");
  const roster = readRegistry(ctx.registryPath, false, false);
  // isFile above established presence: unreadable bytes refuse, they never
  // read as "no unattached seat".
  if (!roster.ok) throw new TapError(1, "registry_invalid", "tap doctor", `the acting registry '${ctx.registryPath}' could not be read — run: tap doctor`);
  const rows = roster.rows ?? [];
  const eligible = nextEligible(current, rows, observe(rows, scriptsDir).rows);
  if (!eligible.length) throw new TapError(1, "not_attachable", "tap team   (who is on this team)   ·   tap attach <handle>   ·   tap attach -i   (pick from a list)", "no unattached active seat on this team to hop to");
  // Strictly after the current handle in code-point order, then wrap.
  const target = current ? eligible.find(h => compareCodePoints(h, current) > 0) : eligible[0];
  return { team, target: target ?? eligible[0]! };
}

function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a, c => c.codePointAt(0)!), right = Array.from(b, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
  return left.length - right.length;
}

type TargetResolution = {
  scope: "local" | "remote" | "historical_team" | "unreachable_team" | "invalid_flip" | "unknown_team" | "ambiguous_team" | "error", team: string, handle: string, root: string, registry: string, detail: string,
};

// tap_resolve_team_target's scopes with attach's own refusal bytes (not
// bindRemoteTeam's send-labeled actions); an absent marker refuses before any bus read.
function resolveTeamTarget(original: string, env: NodeJS.ProcessEnv): TargetResolution {
  const at = (scope: TargetResolution["scope"], rest: Partial<TargetResolution>): TargetResolution => ({ scope, team: "", handle: "", root: "", registry: "", detail: "", ...rest });
  let target = original;
  if (target.includes(":") && !target.includes("/")) {
    const team = target.slice(0, target.indexOf(":"));
    const handle = target.slice(target.indexOf(":") + 1);
    if (!validToken(team) || !validToken(handle) || handle.includes(":")) throw new TapError(1, "usage_error", "tap help", `address '${target}' is not a valid <team>:<handle> token (${TOKEN_RE})`);
    target = `${team}/${handle}`;
  }
  // No machine index: refuse before touching the ambient bus registry (F2b).
  const marker = flipMarkerState(env.TAP_INDEX_HOME);
  if (marker === "absent") throw noMachineIndexError();
  if (marker === "invalid") throw new TapError(1, "invalid_flip", "tap doctor", "global-registry.json is present but unusable");
  const busHome = requireResolvedBus(resolveBus(repoRoot(process.cwd()), env));
  const senderRoot = gitRoot(dirname(busHome)) || repoRoot(process.cwd());
  let localTeam = "";
  try {
    const teamField = (readIndexJson(join(busHome, "registry.json")) as { team?: { name?: unknown } }).team;
    localTeam = typeof teamField?.name === "string" ? teamField.name.trim() : "";
  } catch { localTeam = ""; }
  if (!localTeam) localTeam = basename(senderRoot);
  if (!validToken(localTeam)) throw new TapError(1, "usage_error", "tap help", `local team '${localTeam}' is not a valid token (${TOKEN_RE})`);
  let team = localTeam, handle = target;
  if (target.includes("/")) {
    team = target.slice(0, target.indexOf("/"));
    handle = target.slice(target.indexOf("/") + 1);
    if (!team || !handle || handle.includes("/")) throw new TapError(1, "usage_error", "tap help", `address '${target}' must be <team>/<handle> with one slash`);
    if (!validToken(team)) throw new TapError(1, "usage_error", "tap help", `team '${team}' is not a valid token (${TOKEN_RE})`);
    if (!validToken(handle)) throw new TapError(1, "usage_error", "tap help", `handle '${handle}' is not a valid token (${TOKEN_RE})`);
  }
  // One guarded snapshot: the marker verdict and the team lookup read the SAME
  // parsed document.
  const resolved = resolveTeamMarkerAware(team, env.TAP_INDEX_HOME);
  const localArm = team === localTeam;
  if (resolved.marker === "invalid") return at("invalid_flip", { team, handle, detail: "global-registry.json is present but unreadable or wrong schema; repair migration (tap doctor) — refusing legacy fallback" });
  if (resolved.marker === "live") {
    if (resolved.status === "ok") {
      if (!resolved.registryLocation || !isFile(resolved.registryLocation)) return at("unreachable_team", { team, handle, detail: `stored registry_location missing or unreadable for '${team}'` });
      return at(localArm ? "local" : "remote", { team, handle, root: resolved.root, registry: resolved.registryLocation });
    }
    if (localArm) return at("unreachable_team", { team, handle, detail: `local team '${team}' has no usable stored registry_location post-flip` });
    if (resolved.status === "unreachable") return at("unreachable_team", { team, handle, detail: `registry_location unreachable for '${team}' (${resolved.registryLocation}); tap doctor` });
    if (resolved.status === "historical") return at("historical_team", { team, handle, detail: `team '${team}' is historical (not delivery-addressable)` });
    return at("unknown_team", { team, handle, detail: "<none>" });
  }
  // Absent: no machine index, so no enrolled team to attach to (F2b).
  throw noMachineIndexError();
}

/** Picker choices use an index-bound internal path, including from an unanchored cwd. */
export function attachSelected(selection: PickerSelection, scriptsDir: string): number {
  if (!validToken(selection.team) || !validToken(selection.handle)
    || selection.target !== `${selection.team}/${selection.handle}` || !selection.root || !selection.registry
    || !selection.identity.observedPane || !selection.identity.observedPaneId
    || (!selection.identity.instance && !selection.identity.registeredAt)) {
    throw new TapError(1, "selection_unverifiable", "tap team --all", "picked seat has no provable team, row and pane generation");
  }
  if (selection.identity.serverSocket && selection.identity.serverSocket !== physicalSocketPath())
    throw new TapError(1, "socket_mismatch", "tap team --all", `picked seat '${selection.target}' belongs to another tmux socket; no client was moved`);
  assertSelectedTeamCurrent(selection);
  const resolved: TargetResolution = { scope: "remote", team: selection.team, handle: selection.handle,
    root: selection.root, registry: selection.registry, detail: "" };
  return attachPositional(selection.target, true, scriptsDir, resolved, selection);
}

function assertSelectedTeamCurrent(selection: PickerSelection): void {
  const fresh = resolveTeamMarkerAware(selection.team, process.env.TAP_INDEX_HOME);
  if (fresh.marker === "absent") throw noMachineIndexError();
  if (fresh.marker !== "live") throw new TapError(1, "invalid_flip", "tap doctor", "machine registry became invalid after selection");
  if (fresh.status !== "ok" || fresh.root !== selection.root || fresh.registryLocation !== selection.registry)
    throw new TapError(1, "selection_changed", "tap teams --all", `team '${selection.team}' changed after selection; no client was moved`);
}

function samePickerIdentity(expected: PickerIdentity, row: Record<string, unknown>): boolean {
  const pairs: Array<[keyof PickerIdentity, string]> = [
    ["instance", "instance"], ["pane", "pane"], ["paneId", "pane_id"], ["session", "session"],
    ["serverEpoch", "server_epoch"], ["serverSocket", "server_socket"], ["bootId", "boot_id"],
    ["registeredAt", "registered_at"],
  ];
  return pairs.every(([field, key]) => expected[field] === (typeof row[key] === "string" ? row[key] : ""));
}

function selectedRowCurrent(selection: PickerSelection): boolean {
  try {
    const doc: unknown = JSON.parse(pyReadUtf8(selection.registry));
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false;
    const seats = (doc as { seats?: unknown }).seats;
    if (!seats || typeof seats !== "object" || Array.isArray(seats)) return false;
    const row = (seats as Record<string, unknown>)[selection.handle];
    return !!row && typeof row === "object" && !Array.isArray(row)
      && samePickerIdentity(selection.identity, row as Record<string, unknown>);
  } catch { return false; }
}

function attachPositional(target: string, noResume: boolean, scriptsDir: string,
  bound?: TargetResolution, selection?: PickerSelection): number {
  const resolved = bound ?? resolveTeamTarget(target, process.env);
  const { team, handle, root } = resolved;
  if (resolved.scope === "historical_team") throw new TapError(1, "historical_team", "tap teams --all", `team '${team}' is historical — it has no live seats to attach to (${resolved.detail})`);
  if (resolved.scope === "unreachable_team") throw new TapError(1, "unreachable_team", "tap doctor", `team '${team}' registry_location is unreachable (${resolved.detail})`);
  if (resolved.scope === "invalid_flip") throw new TapError(1, "invalid_flip", "tap doctor", `registry flip marker is present but invalid — refusing to resolve '${target}' (${resolved.detail})`);
  if (resolved.scope === "unknown_team") throw new TapError(1, "unknown_team", "tap teams --all", `unknown team '${team}' (not in the machine index; known sibling worktrees: ${resolved.detail})`);
  if (resolved.scope === "ambiguous_team") throw new TapError(1, "ambiguous_team", `enroll the intended '${team}' worktree in the machine index`, `team '${team}' matches multiple worktree roots: ${resolved.detail}`);
  if (resolved.scope === "error") throw new TapError(1, "resolution_error", "repair the machine team index, then retry", `could not resolve '${target}' (${resolved.detail})`);
  if (resolved.scope === "remote" && !isFile(resolved.registry)) throw new TapError(1, "not_found", `register a seat from team '${team}', then retry`, `no TAP registry for team '${team}' at ${root}`);
  // The index or legacy path never passed selection: an old format refuses by name, never "no seat".
  const oldStore = teamRegistryFileRefusal(resolved.registry);
  if (oldStore) throw new TapError(1, "old_store", oldStore.action, oldStore.detail);
  const roster = readRegistry(resolved.registry, false, false);
  // Resolution refuses an absent or unusable registry_location itself
  // (unreachable_team, the local arm), so bytes reaching this guard through a
  // present local path are unreadable, not missing — the operator's fix is
  // the doctor, not a new seat. The isFile arm keeps shapes that were never
  // probed honest: a genuinely absent file answers the seat question instead
  // of refusing.
  if (!roster.ok && isFile(resolved.registry)) throw new TapError(1, "registry_invalid", "tap doctor", `the acting registry '${resolved.registry}' could not be read — run: tap doctor`);
  if (selection && !selectedRowCurrent(selection)) throw new TapError(1, "selection_changed", "tap team --all", `picked seat '${target}' changed after selection; no client was moved`);
  const row = (roster.rows ?? []).find(candidate => str(candidate.handle) === handle);
  if (!row) {
    if (resolved.scope === "remote") throw new TapError(1, "not_found", `tap teams ${team}   (roster for that team)`, `no seat '${handle}' on team '${team}'`);
    throw new TapError(1, "not_found", `tap team   (who exists)   ·   tap session launch <harness> ${handle}   (create it)`, `no seat '${handle}' on team '${team}'`);
  }
  if (str(row.delivery) === "poll") throw new TapError(1, "not_attachable", `tap team   (poll members have no pane; reach them with tap send ${target} -m "...")`, `'${target}' is a registered poll-mode member — there is no tmux session to attach to`);
  // One classifier observation, the same engine the roster prints.
  const record = observe([row], scriptsDir).rows.get(handle);
  if (!record) return 1; // set -e twin: the engine already wrote its diagnostic.
  const state = record[0] ?? "", reason = record[1] ?? "", paneAddr = record[2] ?? "", paneId = record[3] ?? "";
  if (selection && (paneAddr !== selection.identity.observedPane || paneId !== selection.identity.observedPaneId))
    throw new TapError(1, "selection_changed", "tap team --all", `picked pane for '${target}' changed after selection; no client was moved`);
  const registeredPane = str(row.pane);
  const stateDetail = `${state}${reason ? `: ${reason}` : ""}${registeredPane ? `; registered location: ${registeredPane}` : ""}`;
  const resumeAction = `tap session resume ${handle}${resolved.scope === "remote" ? `   (from ${root})` : ""}`;
  if (state !== "active") {
    if (state === "suspended" && reason === "incapable") throw new TapError(1, "seat_inactive", `re-register '${handle}' from its pane: run 'tap in' there, or 'tap register ${handle} --pane <tmux-target>'`, `'${target}' is suspended (incapable) — its pane is still live; re-register from that pane to clear the mark`);
    if (noResume) throw new TapError(1, "seat_inactive", resumeAction, `'${target}' is on the roster but not active (${stateDetail}) — --no-resume was given, so nothing was resumed`);
    if (process.stdin.isTTY) {
      process.stderr.write(`tap attach: '${target}' is on the roster but not active (${stateDetail}) — resume it first? [Y/n] `);
      if (promptYes()) {
        const [bun, ...resume] = verbArgv(scriptsDir, ["session", "resume", handle]);
        return spawnSync(bun!, resume, { cwd: resolved.scope === "remote" ? root : undefined, stdio: "inherit" }).status ?? 1;
      }
      process.stdout.write(`tap attach: left '${target}' as it was (${stateDetail}); nothing resumed\n`);
      return 0;
    }
    throw new TapError(1, "seat_inactive", resumeAction, `'${target}' is on the roster but not active (${stateDetail}) — attach never resumes a seat on its own`);
  }
  const prefix = registeredPane.includes(":") ? registeredPane.slice(0, registeredPane.indexOf(":")) : registeredPane;
  const targetSession = str(row.session) || prefix;
  if (!targetSession) throw new TapError(1, "no_session", `tap session resume ${handle}`, `'${target}' is active but its row names no tmux session to attach to`);
  const recheck = sessionObservation(targetSession);
  if (recheck === "observed_absent") throw new TapError(1, "session_gone", `tap session resume ${handle}`, `'${target}' resolved to tmux session '${targetSession}', but that name is no longer live — the seat's session ended between the roster check and the attach`);
  if (recheck !== "alive") throw new TapError(1, "session_unobservable", "tap doctor", `'${target}' resolved to tmux session '${targetSession}', but tmux became unobservable before attach — no client was moved; restore tmux visibility and retry`);
  const coords = paneAddr.startsWith(`${targetSession}:`) ? paneAddr.slice(targetSession.length + 1) : "";
  if (!/^[0-9]+\.[0-9]+$/.test(coords)) throw new TapError(1, "pane_unobservable", "tap team --all", `'${target}' resolved to session '${targetSession}' but has no usable window/pane address ('${paneAddr}')`);
  const targetPane = `=${targetSession}:${coords}`;
  let paneIdNow = "";
  try { paneIdNow = tmuxReadOnly(["display-message", "-p", "-t", targetPane, "#{pane_id}"]).stdout.trimEnd(); }
  catch (error) { if (!(error instanceof ServerUnresponsive)) throw error; } // falls through to pane_changed
  if (!paneId || paneIdNow !== paneId) throw new TapError(1, "pane_changed", "tap team --all   (refresh the seat's location before retrying)", `'${target}' was found in session '${targetSession}', window/pane '${coords}', but that pane binding changed or became unobservable before attach — no client was moved`);
  if (selection) {
    assertSelectedTeamCurrent(selection);
    if (!selectedRowCurrent(selection)) throw new TapError(1, "selection_changed", "tap team --all", `picked seat '${target}' changed before attach; no client was moved`);
  }
  return moveToSeat(target, targetSession, coords, targetPane, paneAddr);
}

// Effects ride tmux.ts's socket seam, the same server selection as the reads
// above: attach-session is an unbounded client on inherited stdio; switch-client
// is bounded and never retried, a deadline reporting as exit 124.
function switchClient(args: string[]): number {
  let r;
  try { r = tmuxClientEffect(args); }
  catch (error) {
    if (!(error instanceof ServerUnresponsive)) throw error;
    process.stderr.write(`tap: ${error.message}, do not retry a possible effect\n`);
    return 124;
  }
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  return r.code;
}

function moveToSeat(target: string, targetSession: string, coords: string, targetPane: string, paneAddr: string): number {
  const env = process.env;
  let rc = 0;
  if (env.TMUX) {
    const caller = observeCallingPane(env);
    if (caller.state === "inside") {
      const callerSession = tmuxReadOnly(["display-message", "-p", "-t", caller.paneId, "#{session_name}"]).stdout.trimEnd();
      if (!callerSession) throw new TapError(1, "no_caller_client", "run it from a terminal attached to tmux, or from outside tmux (attach-session)", "this process's observed pane has no resolvable session, so there is no client to switch — refusing rather than moving whichever client tmux would have picked");
      const clients = tmuxReadOnly(["list-clients", "-t", `=${callerSession}`, "-F", "#{client_tty}"]).stdout.split("\n").filter(Boolean);
      if (!clients.length) throw new TapError(1, "no_caller_client", `tap peek ${target}   (read it without attaching)   ·   from a terminal: tmux attach -t '${targetPane}'`, `no tmux client is viewing this caller's session '${callerSession}', so there is no terminal of yours to switch`);
      if (clients.length === 1) {
        rc = switchClient(["switch-client", "-c", clients[0]!, "-t", targetPane]);
        if (rc === 0) process.stdout.write(`tap attach: ${target} (${paneAddr}) on ${clients[0]}\n`);
      } else {
        throw new TapError(1, "ambiguous_client", `attach the one you want directly: tmux attach -t '${targetPane}'`, `${clients.length} tmux clients are viewing this caller's session '${callerSession}' (${clients.join(", ")}) — refusing to guess which terminal you meant`);
      }
    } else if (caller.state === "outside") {
      // ${TMUX%%,*} twin: with no comma the whole value IS the socket.
      const socket = env.TMUX!.split(",")[0]!;
      if (!socket) throw new TapError(1, "caller_identity_unobservable", "retry from a terminal whose tmux identity is observable", "refusing attach because inherited tmux state names no server socket");
      const childEnv: NodeJS.ProcessEnv = { ...env };
      delete childEnv.TMUX;
      delete childEnv.TMUX_PANE;
      // The reads above rode TAP's selected server; the effect must too. With a
      // TAP override set, no explicit socket flag is passed so the wrapper's
      // tmux_argv applies the same pin; the inherited -S is only the fallback
      // when neither override exists (tmux_argv preserves explicit flags).
      if (env.TAP_TMUX_SOCKET_PATH || env.TAP_TMUX_SOCKET) {
        rc = tmuxAttachClient(["attach-session", "-t", targetPane], childEnv);
      } else {
        rc = tmuxAttachClient(["-S", socket, "attach-session", "-t", targetPane], childEnv);
      }
    } else {
      throw new TapError(1, "caller_identity_unobservable", "retry from a terminal whose tmux identity is observable", `refusing attach because the caller's tmux identity is unobservable (${caller.refusal})`);
    }
  } else {
    // attach-session BLOCKS until the human detaches; it is the whole output.
    rc = tmuxAttachClient(["attach-session", "-t", targetPane]);
  }
  if (rc !== 0) {
    if (process.stdin.isTTY && process.stdout.isTTY) throw new TapError(1, "attach_failed", `tmux attach -t '${targetPane}'`, `tmux could not attach to '${target}', found in session '${targetSession}', window/pane '${coords}' (exit ${rc})`);
    throw new TapError(1, "no_terminal", `run from a terminal: tmux attach -t '${targetPane}'`, `'${target}' was found in session '${targetSession}', window/pane '${coords}', but attach needs a controlling terminal and this caller has none (tmux exit ${rc})`);
  }
  return rc;
}

function sessionObservation(wanted: string): "alive" | "observed_absent" | "unobservable" {
  // The wrapper's unresponsive signature throws here; same verdict as a non-zero exit, before any effect.
  let r;
  try { r = tmuxReadOnly(["list-sessions", "-F", "#{session_name}\t#{pid}:#{start_time}"]); }
  catch (error) { if (error instanceof ServerUnresponsive) return "unobservable"; throw error; }
  if (r.code !== 0) return "unobservable";
  let epoch = "", seen = false, found = false;
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const fields = line.split("\t");
    if (fields.length !== 2 || !fields[0] || !fields[1]) return "unobservable";
    const parsed = serverEpochFromRaw(fields[1]!);
    if (!parsed || (epoch && epoch !== parsed)) return "unobservable";
    epoch = parsed;
    seen = true;
    if (fields[0] === wanted) found = true;
  }
  if (!seen) return "observed_absent";
  return found ? "alive" : "observed_absent";
}
