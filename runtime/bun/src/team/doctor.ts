import { captureCompactionBoundary, compactionWitnessPath } from "../compaction-proof";
import { renderRefusals } from "../error-line";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { readOpenCodeSession } from "../opencode-context";
import { paneHarness } from "../pane-harness";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { TapError } from "../context";
import { atomicWrite } from "../fsatomic";
import { loadRegistry, pyJson, seatMap, type Seat } from "../registry";
import { acquireRegistryLock } from "../panelock";
import { oldStoreAction, oldStoreRefusalText, registryWriteRefusal } from "../register-authority";
import { acquireResetMutationLock, markResetGenerationReused } from "../reset";
import { assertSelectionCurrent, selectCaller, SelectorError } from "../selector";
import { bootId, observePaneResult, physicalSocketPath, type PaneObservation } from "../tmux";
import { defaultProc, observeProcessStore, type Attribution } from "../session-store";
import { harnessWorkdir } from "../launcher/workdir";
import { duplicateIdentityOwner } from "../session-identity-owner";
import { loads, type JsonMap } from "../watch-detect";
import { seatStateFindings } from "./seat-state";

export interface Binding { pane: PaneObservation; identity: Attribution }
export type BindingResult = { invalid: string; binding?: never; reason?: never; checked?: never; next?: never } | { binding: Binding; reason?: never; checked?: never; invalid?: never; next?: never } | { binding?: never; reason: string; checked?: never; invalid?: never; next?: string } | { binding?: never; reason?: never; checked: string; invalid?: never; next?: never };

/** No caller environment IDs, directory guesses, or newest-file heuristics. */
export function observeBinding(row: Seat): BindingResult {
  const reRegister = "re-register from inside the seat's pane (run tap in there)";
  if (!row || typeof row !== "object" || Array.isArray(row)) return { reason: "malformed registry row", next: reRegister };
  if (row.delivery === "poll" || (Object.hasOwn(row, "status") && row.status !== "active") || row.status_reason || row.launch_token)
    return { reason: "seat is not an active pane seat", next: "re-run tap team doctor when the seat is active" };
  if (!["claude", "codex", "cursor", "opencode"].includes(String(row.harness)))
    return { reason: "harness has no supported session identity source", next: "this harness has no session identity source; there is nothing to check" };
  if (!row.server_socket || row.server_socket !== physicalSocketPath() || !row.boot_id || row.boot_id !== bootId())
    return { reason: "pane namespace or boot identity is unavailable or different", next: reRegister };
  if (typeof row.pane_id !== "string" || !/^%\d+$/.test(row.pane_id)) return { reason: "pane identity is missing", next: reRegister };
  const before = observePaneResult(row.pane_id);
  if (before.status !== "ok") return { reason: "pane is unavailable", next: "re-run tap team doctor" };
  const pane = before.observation;
  if (pane.paneId !== row.pane_id || pane.session !== row.session || pane.serverEpoch !== row.server_epoch)
    return { reason: "pane generation differs from registration", next: reRegister };
  if (typeof row.registered_from_worktree !== "string" || !row.registered_from_worktree)
    return { reason: "registered worktree is unavailable", next: reRegister };
  try {
    if (row.harness === "cursor" || row.harness === "opencode") {
      if (paneHarness({command:pane.currentCommand,pane_pid:Number(pane.panePid)}) !== row.harness)
        return { reason: "pane is not running the registered harness", next: "relaunch the seat, or re-register from inside its pane" };
      if (row.harness === "opencode") {
        try { captureCompactionBoundary("opencode", row); }
        catch (error) { return { invalid: `compaction binding invalid: ${error instanceof Error ? error.message : String(error)}` }; }
      }
      if (!boundStoreMatches(row)) return row.harness === "opencode"
        ? { invalid: "registered session is absent from its native store or belongs to another worktree" }
        : { reason: "registered session is absent from its native store or belongs to another worktree", next: "relaunch the seat (tap clear) to mint and bind a fresh session" };
      const after = observePaneResult(row.pane_id);
      if (after.status !== "ok" || JSON.stringify(after.observation) !== JSON.stringify(pane)) return { reason: "pane changed during observation", next: "re-run tap team doctor" };
      // Store evidence checks an existing binding; it cannot choose a new ID.
      return { checked: `${row.harness} bound store and session match` };
    }
    const observed = observeProcessStore(defaultProc, String(row.harness), harnessWorkdir(row), homedir(), pane.panePid);
    const after = observePaneResult(row.pane_id);
    if (observed.identity && after.status === "ok" && JSON.stringify(after.observation) === JSON.stringify(pane))
      return { binding: { pane, identity: observed.identity } };
    if (observed.identity === null) {
      const [reason, next] = refusalTexts(observed.refusal);
      return next ? { reason, next } : { reason };
    }
    return { reason: "pane changed during observation", next: "re-run tap team doctor" };
  } catch { return { reason: "current session identity is unavailable", next: "re-run tap team doctor" }; }
}

/** Map a session-store refusal code to [human reason, remediation]. */
export function refusalTexts(refusal: string): [string, string] {
  switch (refusal) {
    case "owners_absent":
    case "owners_ambiguous":
      return ["harness process under the pane is absent or ambiguous",
        "re-register from inside the seat's pane (run tap in there)"];
    case "owners_ambiguous_session_files":
      return ["the pane's harness holds several session files open",
        "re-register from inside the seat's pane (run tap in there)"];
    case "fcwd_mismatch":
      // Plain re-registration preserves registered_from_worktree and never
      // rewrites the launcher-owned launch_workdir, so it cannot clear this
      // mismatch; only relaunching from the seat's workdir does.
      return ["harness process working directory does not match the seat's workdir",
        "relaunch the seat from its workdir (tap clear starts a fresh conversation), then re-run tap team doctor"];
    case "no_open_session":
      return ["no observable session identity for the pane process",
        "retry tap team doctor after the seat's next turn"];
    case "lineage_unstable":
    case "snapshot_unsettled":
    case "pane_process_gone":
      return ["session changed during observation", "re-run tap team doctor"];
    case "fcwd_unavailable":
      // Distinct from a missing lsof: the tool ran but named no working
      // directory, so the binding cannot be cross-checked.
      return ["lsof did not report the harness process's working directory", "re-run tap team doctor"];
    case "tools_unavailable":
      return ["session identity observation tools unavailable", "re-run tap team doctor"];
    default:
      return ["current session identity is ambiguous or unavailable", "re-run tap team doctor"];
  }
}

/** Validate the registered store identity without selecting a newer conversation. */
export function boundStoreMatches(row: Seat, home = homedir()): boolean {
  const id = row.harness_session_id;
  // The native store records where the harness RUNS (launch_workdir when the
  // seat has one), not the registration anchor (discuss F1).
  const worktree = harnessWorkdir(row);
  if (typeof id !== "string" || !id || typeof worktree !== "string" || !isAbsolute(worktree)) return false;
  let db: Database | undefined;
  try {
    if (!statSync(worktree).isDirectory()) return false;
    const root = normalize(worktree).replace(/\/+$/, "");
    if (row.harness === "cursor") {
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return false;
      const hash = createHash("md5").update(root).digest("hex");
      const expected = join(home, ".cursor", "chats", hash, id, "store.db");
      const recorded = row.session_store_path || row.transcript_path;
      return (!recorded || (typeof recorded === "string" && realpathSync(recorded) === realpathSync(expected))) && statSync(expected).isFile();
    }
    if (row.harness !== "opencode") return false;
    const path = compactionWitnessPath("opencode", row);
    if (typeof path !== "string" || !isAbsolute(path) || !statSync(path).isFile()) return false;
    db = new Database(path, {readonly:true});
    db.exec("PRAGMA busy_timeout = 100");
    const session = readOpenCodeSession(db, id);
    return !!session && typeof session.directory === "string" && normalize(session.directory).replace(/\/+$/, "") === root;
  } catch { return false; }
  finally { db?.close(); }
}

export function bindingDiffers(row: Seat, binding: Binding): boolean {
  return row.harness_session_id !== binding.identity.harness_session_id || row.transcript_path !== binding.identity.store_path;
}

/** Operator repair changes only session attribution, retaining seat instance and custody. */
export function applyBinding(row: Seat, binding: Binding): void {
  const identity = binding.identity;
  const previous = { harness_session_id: row.harness_session_id ?? null, transcript_path: row.transcript_path ?? null,
    identity_capture: row.identity_capture ?? null, identity_capture_result: row.identity_capture_result ?? null };
  row.harness_session_id = identity.harness_session_id;
  row.transcript_path = identity.store_path;
  row.session_store_path = identity.store_path;
  row.session_store_kind = identity.store_kind;
  row.session_attribution_trust = "process";
  row.session_attribution_detail = identity.detail;
  row.session_attribution_candidates = identity.candidates;
  row.derived_at = identity.derived_at || new Date().toISOString();
  row.identity_capture_result = { decision: "accepted", mode: "operator_rebind", observed_harness_session_id: identity.harness_session_id,
    previous, observed_at: new Date().toISOString() };
  // A repaired binding supersedes the old launch expectation, not seat ownership.
  delete row.identity_capture;
  delete row.quarantined_harness_session_id;
  delete row.quarantined_transcript_path;
  delete row.identity_quarantine_reason;
}

export function cmdTeamDoctor(argv: string[], observe: (row: Seat) => BindingResult = observeBinding): number {
  if (argv.includes("--json")) process.env.TAP_JSON = "1";
  let dryRun = true, json = false;
  let only: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--fix") dryRun = false;
    else if (arg === "--json") json = true;
    else if (arg === "--only" && only === undefined && argv[i + 1] && !argv[i + 1]!.startsWith("-")) {
      only = argv[++i]!;
      if (only !== "session-binding" && only !== "seat-state") throw new TapError(1, "usage_error", "tap help team", `unknown check '${only}'; available: session-binding, seat-state`);
    } else throw new TapError(1, "usage_error", "tap help team", `unexpected argument '${arg}'`);
  }
  let selection;
  try { selection = selectCaller({ cwd: process.cwd(), verbClass: "lifecycle" }); }
  catch (error) {
    if (error instanceof SelectorError) throw new TapError(error.code, error.errorClass, error.action, error.detail);
    throw error;
  }
  const initialDoc = loadRegistry(selection.registryLocation);
  const plainObject = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
  if ("agents" in initialDoc) {
    throw new TapError(1, "old_store", oldStoreAction("agents_axis"), oldStoreRefusalText(selection.registryLocation, "agents_axis"));
  }
  if (!plainObject(initialDoc.seats)) {
    throw new TapError(1, "registry_invalid", "repair_registry", `registry '${selection.registryLocation}' seats is missing or not an object`);
  }
  const initial = seatMap(initialDoc);
  const handles = only === "seat-state" ? [] : Object.keys(initial).sort();
  const results: { handle: string; outcome: string; detail: string; next?: string }[] = [];
  const color = !!process.stdout.isTTY && process.env.TERM !== "dumb" && !Object.hasOwn(process.env, "NO_COLOR");
  const progress = !json && !!process.stdout.isTTY && !!process.stderr.isTTY && process.env.TERM !== "dumb";
  try {
    for (const [index, handle] of handles.entries()) {
      if (progress) {
        // Fit one terminal line so clearing it cannot leave wrapped fragments.
        const label = `Scanning ${index + 1}/${handles.length}: ${handle}`.replace(/[\x00-\x1f\x7f-\x9f]/g, "?");
        process.stderr.write(`\r\x1b[2K${label.slice(0, Math.max(1, (process.stderr.columns || 80) - 1))}`);
      }
      const row = initial[handle]!;
      const observed = observe(row);
      if (observed.invalid !== undefined) { results.push({ handle, outcome: "invalid", detail: observed.invalid }); continue; }
      if (observed.checked !== undefined) { results.push({ handle, outcome: "unchanged", detail: observed.checked }); continue; }
      if (!observed.binding) { results.push({ handle, outcome: "skipped", detail: observed.reason, ...(observed.next ? { next: observed.next } : {}) }); continue; }
      if (!bindingDiffers(row, observed.binding)) { results.push({ handle, outcome: "unchanged", detail: "session and transcript match" }); continue; }
      const reset = acquireResetMutationLock(selection.busHome, "tap team doctor", undefined, "shared");
      try {
        const lock = acquireRegistryLock(selection.registryLocation);
        if (!lock) throw new TapError(1, "registry_busy", "retry tap team doctor", "registry lock unavailable");
        try {
          assertSelectionCurrent(selection, lock);
          const doc = loadRegistry(selection.registryLocation);
          const refusal = registryWriteRefusal(selection.registryLocation, doc);
          if (refusal) throw new TapError(1, refusal.errorClass, refusal.action, refusal.detail);
          const current = seatMap(doc)[handle];
          if (!current || pyJson(current, 0) !== pyJson(row, 0)) {
            results.push({ handle, outcome: "skipped", detail: "registration changed during observation" }); continue;
          }
          const fresh = observe(current);
          if (!fresh.binding || fresh.binding.identity.harness_session_id !== observed.binding.identity.harness_session_id ||
              fresh.binding.identity.store_path !== observed.binding.identity.store_path ||
              JSON.stringify(fresh.binding.pane) !== JSON.stringify(observed.binding.pane)) {
            results.push({ handle, outcome: "skipped", detail: "pane or session changed during observation" }); continue;
          }
          const owner = duplicateIdentityOwner(fresh.binding.identity.harness_session_id, handle, String(current.harness),
            selection.registryLocation, loads(readFileSync(selection.registryLocation, "utf8")) as JsonMap,
            process.env.TAP_INDEX_HOME || join(homedir(), ".tap"));
          if (owner) { results.push({ handle, outcome: "skipped", detail: `session is already owned by ${owner}` }); continue; }
          if (!dryRun) {
            applyBinding(current, fresh.binding);
            markResetGenerationReused(selection.busHome, "tap team doctor");
            atomicWrite(selection.registryLocation, `${pyJson(doc, 0)}\n`);
          }
          results.push({ handle, outcome: dryRun ? "would_repair" : "repaired", detail: `${row.harness_session_id || "?"} -> ${fresh.binding.identity.harness_session_id}` });
        } finally { lock.release(); }
      } finally { reset.release(); }
    }
  } finally {
    if (progress && handles.length) process.stderr.write("\r\x1b[2K");
  }
  // Like tap doctor, diagnostic warnings do not turn a sound bus into an error.
  const findings = results.map(result => ({
    severity: result.outcome === "would_repair" || result.outcome === "skipped" || result.outcome === "invalid" ? "warning" : "info",
    name: "session-binding",
    detail: { ...result, ...(result.outcome === "would_repair" ? { next: "tap team doctor --fix --only session-binding" } : {}) },
    // Skip remediation rides the finding level, the same single-string shape
    // the would_repair next uses (discuss F5).
    ...(result.outcome === "skipped" && result.next ? { next: result.next } : {}),
  }));
  const states = only === "session-binding" ? [] : seatStateFindings(initial, selection.team);
  if (json) process.stdout.write(`${JSON.stringify({ ok: true, bus: { home: selection.busHome, rule: selection.busRule },
    findings: [...findings, ...states], summary: { torn: 0, unattributed: 0, clean: !results.some(result => result.outcome === "invalid"),
      seat_attention: states.filter(finding => finding.detail.outcome === "attention").length } })}\n`);
  else {
    const visible = results.filter(result => result.outcome !== "unchanged");
    const visibleStates = states.filter(finding => finding.detail.outcome !== "unchanged");
    if (!visible.length && !visibleStates.length) process.stdout.write(`${color ? "\x1b[32m" : ""}✓ no issues detected${color ? "\x1b[0m" : ""}\n`);
    const unchecked = visible.filter(result => result.outcome === "skipped");
    for (const result of visible.filter(result => result.outcome !== "skipped")) {
      const finding = result.outcome === "would_repair" || result.outcome === "invalid";
      process.stdout.write(`${color && finding ? "\x1b[31m" : ""}tap team doctor: ${result.handle}: ${result.outcome} (${result.detail})${color && finding ? "\x1b[0m" : ""}\n`);
    }
    if (unchecked.length) {
      process.stdout.write(`${color ? "\x1b[33m" : ""}tap team doctor: not checked\n`);
      for (const result of unchecked) process.stdout.write(`  ${result.handle}: ${result.detail}${result.next ? `; next: ${result.next}` : ""}\n`);
      if (color) process.stdout.write("\x1b[0m");
    }
    for (const finding of visibleStates) {
      const result = finding.detail;
      const tint = result.outcome === "skipped" ? "\x1b[33m" : "\x1b[31m";
      process.stdout.write(`${color ? tint : ""}tap team doctor: ${result.handle}: ${result.detail}${finding.next ? `; next: ${finding.next}` : ""}${color ? "\x1b[0m" : ""}\n`);
    }
  }
  return 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  process.exitCode = renderRefusals("tap team doctor", () => cmdTeamDoctor(args),
    {...process.env, TAP_JSON: args.includes("--json") ? "1" : process.env.TAP_JSON});
}
