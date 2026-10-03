/**
 * The addressee grant — who may act on a payload addressed to `to` — is ONE
 * implementation on both doors (lane D, batch 2, unit D2-u1).
 *
 * It answers, for an actor and an inbound envelope's `to` / `to_adopted_from`
 * / `recipient_instance`: is the actor the addressee, its adopted successor,
 * or the forwarded recipient — and if not, which refusal (`not_addressee`,
 * `instance_unresolved`, `registry_unreachable`, `old_store`) with which clearing remedy.
 * The native `read` calls it in-process; the Bash door `tap-cancel.sh`
 * reaches it through the
 * `tap_addressee_grant_check` / `tap_instance_clearing_remedy` adapters in
 * lib.sh, whose bodies this module replaced (the incumbent's five Bash
 * functions and their four Python heredocs: `tap_addressee_grant_check`,
 * `tap_adoption_grant`, `tap_adopted_instance`, `tap_instance_clearing_remedy`,
 * `tap_instance_in_history`).
 *
 * The native `reply` door carries its own `assertRecipientAuthority`
 * (verbs/done.ts, shared settle primitives) with stricter replay semantics; folding native reply onto
 * this module is D2's reply unit, not this one.
 *
 * Two registries ride the input because the incumbent resolved two: the
 * instance and forwarding checks used `tap_acting_registry "$LOCAL_TEAM"`,
 * while adoption, adopted-instance and the clearing remedy used
 * `tap_acting_registry` with no team. On an enrolled bus they are the same
 * file; the adapter passes both so the port cannot silently pick one.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { forwardingGrant } from "./forwarding";
import { recipientInstance, unresolvedRecipient } from "./recipient-instance";
import { adoptedInstance, adoptionGrant, currentInstance, loadRegistry, seatMap } from "./registry";
import { teamRegistryFileRefusal } from "./register-authority";
import { carrierArgs, writeResult, type ResultPairs } from "./slices/result-pairs";

export const NO_CLEARING_PATH = "no remaining clearing path (CONTRACT.md Cancellation)";

export interface GrantInput {
  /** `tap_acting_registry "$LOCAL_TEAM"` — "" when unreachable. */
  registryPath: string;
  /** `tap_acting_registry` (no team) — "" when unreachable. Defaults to `registryPath`. */
  adoptionRegistryPath?: string;
  /** The v0.20 flip marker as the caller read it; `absent` disables instance binding. */
  marker: "live" | "absent";
  /** LOCAL_TEAM, for the unresolved-instance refusal text ("unknown" when empty). */
  team: string;
  /** `<root>/.tap/team-history`, or "" when the team dir cannot be derived from the bus. */
  historyDir: string;
  id: string;
  from: string;
  actor: string;
  to: string;
  adoptedFrom: string;
  recipientInstance: string;
}

export type RemedyKind = "unknown" | "command" | "none";

export interface Remedy {
  kind: RemedyKind;
  next: string;
  detail: string;
}

export interface GrantResult {
  ok: boolean;
  /** `_ADDRESSEE_GRANT`: the predecessor handle whose mail the actor may act on. */
  grant: string;
  /** `_ADDRESSEE_ACTOR_INSTANCE`: the actor's current instance when the check bound one. */
  actorInstance: string;
  /** `_ADDRESSEE_CLASS`; meaningful only when `ok` is false. */
  errorClass: "not_addressee" | "instance_unresolved" | "registry_unreachable" | "old_store";
  detail: string;
  next: string;
  /** `_ADDRESSEE_INST_MISMATCH`. */
  instanceMismatch: boolean;
  /** `_REMEDY_KIND` / `_REMEDY_NEXT` / `_REMEDY_DETAIL` as the incumbent left them. */
  remedy: Remedy;
}

/** `tap_team_dir_from_bus` + `tap_team_history_dir`: the worktree that owns a bus, by layout. */
export function historyDirForBus(busHome: string): string {
  const parent = resolveDir(dirname(busHome));
  if (!parent) return "";
  const base = parent.replace(/\/+$/, "") || "/";
  let root: string;
  if (base === "/") root = base;                                            // bus parent is / itself
  else if (base.endsWith("/.tap")) root = base.slice(0, -"/.tap".length) || "/";   // <root>/.tap/bus
  else root = base;
  return join(root, ".tap", "team-history");
}

function resolveDir(path: string): string {
  try {
    if (!statSync(path).isDirectory()) return "";
    return realpathSync(path);
  } catch {
    return "";
  }
}

/**
 * `tap_instance_in_history`: 0 when a tombstone for `handle` names `inst`,
 * 1 when the history is present and does not, 2 when it cannot be read (no
 * team dir, no handle/instance, or an unreadable directory). Lineage files are
 * not tombstones; a tombstone that does not name its handle is skipped.
 */
export function instanceInHistory(historyDir: string, handle: string, inst: string): 0 | 1 | 2 {
  if (!handle || !inst) return 2;
  if (!historyDir) return 2;
  let names: string[];
  try {
    if (!statSync(historyDir).isDirectory()) return 1;
    names = readdirSync(historyDir);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? 1 : 2;
  }
  const prefix = `${handle}.`;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".json") || name.includes(".lineage.")) continue;
    const path = join(historyDir, name);
    // The incumbent's load_state_doc opened only REGULAR files (os.path.isfile,
    // symlinks followed): a FIFO named like a tombstone is skipped, never
    // opened — readFileSync on a writerless FIFO blocks forever (partner review).
    try { if (!statSync(path).isFile()) continue; } catch { continue; }
    let data: unknown;
    try { data = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const row = data as Record<string, unknown>;
    if (row.handle !== handle) continue;
    if (String(row.instance ?? "") === inst) return 0;
  }
  return 1;
}

/**
 * `tap_instance_clearing_remedy`: how a payload bound to a retired instance
 * `pinst` of `handle` can be cleared. `kind: "unknown"` (the incumbent's
 * return 1) means the question did not apply — no instance, marker absent,
 * no registry, or `pinst` is the current instance.
 */
export function instanceClearingRemedy(
  input: { adoptionRegistryPath: string; marker: "live" | "absent"; historyDir: string },
  handle: string,
  pinst: string,
): Remedy {
  const unknown: Remedy = { kind: "unknown", next: "", detail: "" };
  if (!pinst) return unknown;
  if (input.marker !== "live") return unknown;
  const reg = input.adoptionRegistryPath;
  if (!reg) return unknown;
  // An old-format registry answers nothing about the seat: its remedy is the old_store one.
  const oldStore = teamRegistryFileRefusal(reg);
  if (oldStore) return { kind: "command", next: oldStore.action, detail: oldStore.detail };
  if (currentInstance(reg, handle) === pinst) return unknown;
  // The incumbent's row_present read "unreadable" on a broken registry and then
  // took the ROW-PRESENT branch (`!= "0"`); that polarity is kept, not tidied.
  // Presence is the Python `.get(handle) is not None`: an OWN key with a
  // non-null value — never an inherited one (`constructor`, `toString` are
  // valid handles) and never a JSON null row (review).
  let rowPresent = "unreadable";
  try {
    const seats = seatMap(loadRegistry(reg));
    rowPresent = Object.prototype.hasOwnProperty.call(seats, handle) && seats[handle] != null ? "1" : "0";
  } catch { /* unreadable */ }
  const hist = instanceInHistory(input.historyDir, handle, pinst);
  if (rowPresent === "0") {
    switch (hist) {
      case 0: return { kind: "command", next: `tap in ${handle} --restore ${pinst}`,
        detail: `'${handle}' currently holds no seat and '${pinst}' is still a tombstone in its history, so restoring that exact instance lets a normal cancel proceed afterward` };
      case 2: return { kind: "command", next: `tap in ${handle} --list-history`,
        detail: `'${handle}' currently holds no seat, but its instance history could not be read, so whether '${pinst}' can be restored is unknown` };
      default: return { kind: "none", next: NO_CLEARING_PATH,
        detail: `'${handle}' currently holds no seat and '${pinst}' is not in its instance history, so there is no tombstone to restore and nothing to cancel from — a fresh registration mints a different instance and will not match` };
    }
  }
  switch (hist) {
    case 0: return { kind: "command", next: "tap team",
      detail: `'${pinst}' is still a tombstone in '${handle}''s history, so a path exists but it is not free: it needs 'tap out ${handle}' — which removes the seat holding that handle right now — followed by 'tap in ${handle} --restore ${pinst}'. Look at who holds '${handle}' before taking it; against a live teammate, do not` };
    case 2: return { kind: "command", next: `tap in ${handle} --list-history`,
      detail: `'${handle}''s instance history could not be read, so whether '${pinst}' is restorable is unknown — 'tap in ${handle} --list-history' answers it` };
    default: return { kind: "none", next: NO_CLEARING_PATH,
      detail: `'${pinst}' is not in '${handle}''s instance history, so there is nothing to restore and the current seat cannot cancel it` };
  }
}

/**
 * The native registry reader refuses a document outside its value domain — a
 * float or an unsafe integer in any field (`loadRegistry`, canonical integers
 * only). The incumbent's Python `json.load` accepted such a registry and
 * granted from it; the leader ratified convergence on the native fail-closed
 * rule (2026-09-16 06:13Z) on one condition: the refusal NAMES the value, as
 * the loader does, so an operator never reads `not_addressee` on a corrupt
 * registry and reclaims a handle for nothing. Every other load failure keeps
 * the incumbent's silence (adoption ungranted; the binding unresolved).
 */
function valueDomainRefusal(registryPath: string): string {
  if (!registryPath) return "";
  try { loadRegistry(registryPath); return ""; }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /^registry: (number|integer) /.test(message) ? message : "";
  }
}

/** `tap_addressee_grant_check`, field for field. */
export function addresseeGrant(input: GrantInput): GrantResult {
  const { id, from, actor, to, adoptedFrom } = input;
  const adoptReg = input.adoptionRegistryPath ?? input.registryPath;
  const remedyInput = { adoptionRegistryPath: adoptReg, marker: input.marker, historyDir: input.historyDir };
  const r: GrantResult = {
    ok: false, grant: "", actorInstance: "", errorClass: "not_addressee",
    detail: `'${id}' is addressed to '${to}', not '${actor}'`,
    next: `tap cancel ${id}${from ? ` --by ${from}` : ""}`,
    instanceMismatch: false, remedy: { kind: "unknown", next: "", detail: "" },
  };
  for (const reg of new Set([input.registryPath, adoptReg])) {
    const refused = valueDomainRefusal(reg);
    if (refused) return { ...r, errorClass: "registry_unreachable", next: "tap doctor", detail: `cannot read the acting registry for '${id}': ${refused}` };
    // An old-format registry grants nothing, and its refusal is never an overridable not_addressee.
    const oldStore = reg ? teamRegistryFileRefusal(reg) : null;
    if (oldStore) return { ...r, errorClass: "old_store", next: oldStore.action, detail: oldStore.detail };
  }
  let rinst = input.recipientInstance;
  let reg = "";
  let binding: "match" | "mismatch" | "unresolved" = "match";
  let current = "";
  let missing = { detail: "", action: "" };
  if (input.marker === "live") {
    if (rinst) {
      reg = input.registryPath;
      if (!reg) {
        return { ...r, errorClass: "registry_unreachable", next: "tap doctor",
          detail: `acting registry unreachable — cannot verify recipient instance for '${id}'` };
      }
      const bound = recipientInstance(reg, actor, rinst);
      binding = bound.state;
      current = bound.current;
      missing = unresolvedRecipient(actor, input.team || "unknown");
    }
  } else {
    rinst = "";
  }
  let fork: string;
  if (to === actor) {
    if (!rinst || binding === "match") return { ...r, ok: true, actorInstance: current };
    fork = adoptedFrom;
  } else {
    fork = to;
  }
  if (fork && adoptionGrant(adoptReg, actor, fork, rinst) === actor) {
    return { ...r, ok: true, grant: fork };
  }
  // Explicit forwarding leaves old payloads addressed to the predecessor. A new
  // forwarded envelope already addressed to this actor must bind its instance;
  // its to_adopted_from history is not authority to substitute an older stamp.
  if (to !== actor && fork && reg && rinst) {
    const forwarded = forwardedGrant(reg, actor, fork, rinst);
    if (forwarded) return { ...r, ok: true, grant: fork, actorInstance: forwarded };
  }
  if (rinst) {
    if (binding === "unresolved") {
      return { ...r, errorClass: "instance_unresolved", detail: missing.detail, next: missing.action };
    }
    r.instanceMismatch = true;
    r.detail = `'${id}' is bound to recipient instance '${rinst}', not the current '${actor}' instance`;
    if (fork && adoptionGrant(adoptReg, actor, fork) === actor) {
      const bound = adoptedInstance(adoptReg, fork);
      r.detail = `'${id}' is bound to recipient instance '${rinst}', not the adopted '${fork}' instance '${bound}'`;
    }
    r.remedy = instanceClearingRemedy(remedyInput, actor, rinst);
    if (r.remedy.kind === "command") {
      r.next = `${r.next}; or clear the binding: ${r.remedy.next}`;
      if (r.remedy.detail) r.detail = `${r.detail}; ${r.remedy.detail}`;
    }
  }
  return r;
}

/**
 * The incumbent read forwarding.ts's `grant --json` and accepted it only when
 * `adopted_from` named the fork and `actor_instance` was a non-empty string
 * free of CR, LF and US; anything else (a registry that does not load, a
 * missing actor row) fell through to the refusal. Returns the actor instance.
 */
function forwardedGrant(registryPath: string, actor: string, fork: string, rinst: string): string {
  let doc;
  try { doc = loadRegistry(registryPath); } catch { return ""; }
  const grant = forwardingGrant(doc, actor, fork, rinst);
  if (grant !== fork) return "";
  const inst = seatMap(doc)[actor]?.instance;
  if (typeof inst !== "string" || !inst || /[\r\n\x1f]/.test(inst)) return "";
  return inst;
}

function grantPairs(g: GrantResult): ResultPairs {
  return {
    _AG_OK: g.ok,
    _ADDRESSEE_GRANT: g.grant,
    _ADDRESSEE_ACTOR_INSTANCE: g.actorInstance,
    _ADDRESSEE_CLASS: g.errorClass,
    _ADDRESSEE_DETAIL: g.detail,
    _ADDRESSEE_NEXT: g.next,
    _ADDRESSEE_INST_MISMATCH: g.instanceMismatch,
    ...remedyPairs(g.remedy),
  };
}

function remedyPairs(m: Remedy): ResultPairs {
  return { _REMEDY_KIND: m.kind, _REMEDY_NEXT: m.next, _REMEDY_DETAIL: m.detail };
}

const USAGE = "addressee-grant: usage: grant --result <path> -- <registry> <adoption-registry> <marker> <team> <history-dir> <id> <from> <actor> <to> <adopted-from> <recipient-instance>\n" +
  "                       remedy --result <path> -- <adoption-registry> <marker> <history-dir> <handle> <instance>";

function markerOf(raw: string): "live" | "absent" | null {
  return raw === "live" || raw === "absent" ? raw : null;
}

/** The Bash adapters' carrier: `<op> --result <path> -- <positional args…>`. */
export function cliMain(argv: string[]): number {
  const carrier = carrierArgs(argv, USAGE);
  if (!carrier) return 64;
  const { op, result, rest } = carrier;
  if (op === "grant") {
    if (rest.length !== 11) { process.stderr.write(`${USAGE}\n`); return 64; }
    const [registryPath, adoptionRegistryPath, marker, team, historyDir, id, from, actor, to, adoptedFrom, recipientInst] = rest as [string, string, string, string, string, string, string, string, string, string, string];
    const m = markerOf(marker);
    if (!m) { process.stderr.write(`addressee-grant: marker must be live|absent, got '${marker}'\n`); return 64; }
    writeResult(result, grantPairs(addresseeGrant({ registryPath, adoptionRegistryPath, marker: m, team, historyDir, id, from, actor, to, adoptedFrom, recipientInstance: recipientInst })));
    return 0;
  }
  if (op === "remedy") {
    if (rest.length !== 5) { process.stderr.write(`${USAGE}\n`); return 64; }
    const [adoptionRegistryPath, marker, historyDir, handle, pinst] = rest as [string, string, string, string, string];
    const m = markerOf(marker);
    if (!m) { process.stderr.write(`addressee-grant: marker must be live|absent, got '${marker}'\n`); return 64; }
    writeResult(result, remedyPairs(instanceClearingRemedy({ adoptionRegistryPath, marker: m, historyDir }, handle, pinst)));
    return 0;
  }
  process.stderr.write(`${USAGE}\n`);
  return 64;
}

if (import.meta.main) {
  process.exit(cliMain(process.argv.slice(2)));
}
