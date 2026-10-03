/**
 * Team-qualified addressing for `tap send` / `tap assign`: `<team>/<handle>` and
 * `<team>:<handle>` destinations (D2, member 2 of the `reply` stack).
 *
 * The verdicts here are the incumbent's, byte for byte — tap-send.sh:168-172 (the
 * colon form), `tap_resolve_team_target` (lib.sh) for the split and the index
 * binding, tap-send.sh:601-736 for the remote seat row — so the native door and
 * the Bash door refuse a qualified destination with the same class, action and
 * detail. Where the two doors' bytes differ by measurement, the differential in
 * runtime/bun/test/send-remote.test.ts pins the deviation and CONTRACT.md
 * ratifies it.
 *
 * Marker-live only. The pre-flip `teams.json` + worktree-scan branch of
 * `tap_resolve_team_target` is not ported: a closed verb refuses under an absent
 * marker (architect, 2026-09-16), and the router keeps routing an
 * absent marker to Bash until that closure.
 */
import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

import { busForRegistry } from "./clear-fence";
import { STALE_ENROLLMENT_NEXT, TapError, teamRootFromBus } from "./context";
import { loadGlobalRegistry, resolveTeamFromDoc, type TeamResolution } from "./index-home";
import { validToken } from "./ids";
import { loadRegistry, seatMap, type RegistryDoc } from "./registry";
import { teamRegistryFileRefusal } from "./register-authority";
import { assertActingRegistryMatches, busHomeForEnrolled, SelectorError } from "./selector";
import { busHomeForRoot } from "./bushome";

/** `$TAP_ID_RE`, spelled as Bash's refusals spell it. */
export const TOKEN_RE = "^[A-Za-z0-9][A-Za-z0-9._-]*$";

/** The manual-relay fallback every remote refusal names (tap-send.sh:608, :719-733). */
export function relayFallback(handle: string): string {
  return `tap send ${handle} <payload> --cross-worktree --pane <tmux-target>`;
}

export interface SplitTarget {
  /** The destination as the router sees it after `team:handle` normalization (Bash's `$ORIGINAL_TO`). */
  original: string;
  team: string;
  handle: string;
  qualified: boolean;
}

/**
 * tap-send.sh:168-172 then `tap_resolve_team_target`'s address validation
 * (lib.sh:7241-7273): `team:handle` normalizes to `team/handle` (a bad colon
 * form is `tap help send`'s usage line), then one slash splits team from handle
 * and each half must be a token (`tap help`'s usage lines).
 */
/**
 * tap-send.sh:168-172: `team:handle` normalizes to `team/handle` (a bad colon
 * form is `tap help send`'s usage line) — the normalization runs immediately
 * after parsing, before ANY destination consumer (the alias block included),
 * so every comparison sees the slash form. One slash then splits team from
 * handle and each half must be a token (`tap help`'s usage lines).
 */
export function normalizeSendTarget(raw: string): string {
  if (raw.includes(":") && !raw.includes("/")) {
    const team = raw.slice(0, raw.indexOf(":"));
    const handle = raw.slice(raw.indexOf(":") + 1);
    if (!validToken(team) || !validToken(handle)) {
      throw new TapError(1, "usage_error", "tap help send",
        `address '${raw}' is not a valid <team>:<handle> token (${TOKEN_RE})`);
    }
    return `${team}/${handle}`;
  }
  return raw;
}

export function splitSendTarget(raw: string): SplitTarget {
  const to = normalizeSendTarget(raw);
  if (!to.includes("/")) return { original: to, team: "", handle: to, qualified: false };
  const team = to.slice(0, to.indexOf("/"));
  const handle = to.slice(to.indexOf("/") + 1);
  if (!team || !handle || handle.includes("/")) {
    throw new TapError(1, "usage_error", "tap help", `address '${to}' must be <team>/<handle> with one slash`);
  }
  if (!validToken(team)) throw new TapError(1, "usage_error", "tap help", `team '${team}' is not a valid token (${TOKEN_RE})`);
  if (!validToken(handle)) throw new TapError(1, "usage_error", "tap help", `handle '${handle}' is not a valid token (${TOKEN_RE})`);
  return { original: to, team, handle, qualified: true };
}

export interface RemoteTeam {
  team: string;
  handle: string;
  rootReal: string;
  /** The stored `registry_location`: the acting registry every recipient fact is read from. */
  registryPath: string;
  /** The recipient's bus: its clear fence, its reset fence. Nothing is written here. */
  busHome: string;
}

/**
 * The bus beside a canonical
 * `team-registry.json`, the directory of a legacy `registry.json`, a parent that
 * is itself a bus or a `.tap`; anything else has no derivable bus.
 */
function busHomeForRegistry(registryPath: string): string | null {
  const parent = dirname(registryPath);
  const base = basename(registryPath);
  if (base === "team-registry.json") return join(parent, "bus");
  if (base === "registry.json") return parent;
  if (parent.endsWith("/bus")) return parent;
  if (parent.endsWith("/.tap")) return join(parent, "bus");
  return null;
}

/**
 * `tap_authority_context`'s answer: the derivable bus, else the enrolled root's
 * `.tap/bus` (a relocated acting store keeps its bus under the
 * root). The SENDER's `path=` question asks this; the recipient binding does not
 * (tap-send.sh:296-300 refuses before the authority context is ever consulted).
 */
function authorityBusHome(registryPath: string, root: string): string | null {
  const derived = busHomeForRegistry(registryPath);
  if (derived) return derived;
  const candidate = busHomeForRoot(root);
  return isDir(candidate) ? candidate : null;
}

function realpathOrSelf(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** Spool bindings carry no origin flag: current enrollment decides the fence bus. */
export function spoolRecipientBusHome(home: string, registryPath: string, team: string, indexHome?: string): string | null {
  if (!team) return home;
  const refuse = (kind: string): null => {
    process.stderr.write(`tap: error_class=${kind} next=cancel_or_resend — cannot resolve fence authority for '${team}' at '${registryPath}'; spool entry held\n`);
    return null;
  };
  const index = loadGlobalRegistry(indexHome);
  if (index.marker !== "live" || !index.doc) return refuse("unanchored_bus");
  const teams = (index.doc.teams ?? {}) as Record<string, unknown>;
  // A live index proves this file-pinned target is unindexed. Missing evidence cannot.
  if (!Object.hasOwn(teams, team)) return busForRegistry(registryPath);
  const row = teams[team] as Record<string, unknown> | null;
  const bound = resolveTeamFromDoc(index.doc, team);
  if (bound.status !== "ok" || typeof row?.root !== "string" || !isAbsolute(row.root) || !isDir(row.root)
    || typeof row.registry_location !== "string" || realpathOrSelf(bound.registryLocation) !== realpathOrSelf(registryPath)) {
    return refuse("fence_authority_mismatch");
  }
  const rootReal = realpathOrSelf(bound.root);
  try { assertActingRegistryMatches({ team, registryLocation: registryPath, rootReal }); }
  catch { return refuse("fence_authority_mismatch"); }
  return busHomeForEnrolled(rootReal);
}

/**
 * Bind a qualified destination's team through the machine index, marker live:
 * `tap_resolve_team_target`'s post-flip remote branch (lib.sh:7327-7360) and the
 * refusals tap-send.sh raises on its scopes (:270-295), then `tap_authority_context`
 * for the recipient bus (:627-641). The team is known to differ from the caller's.
 */
/**
 * The index through the marker-aware loader (`tap_registry_v20_state_load`'s
 * answer): a document that is unreadable, carries the wrong schema, or has a
 * non-dict `teams` is `invalid` — never `ok` for a team that happens to be
 * listed in it — and an absent marker is nobody's enrollment.
 */
function resolveThroughMarker(team: string, indexHome: string | undefined): TeamResolution & { rawLocationIsString?: boolean; rootIsUsable?: boolean } {
  const index = loadGlobalRegistry(indexHome);
  if (index.marker === "invalid") return { status: "invalid", root: "", registryLocation: "" };
  if (index.marker !== "live" || !index.doc) return { status: "missing", root: "", registryLocation: "" };
  const teams = (index.doc as Record<string, unknown>).teams as Record<string, unknown> | undefined;
  const entry = teams?.[team] as Record<string, unknown> | undefined;
  // resolveTeamFromDoc coerces with String(): a malformed location must not
  // later read as a path that is positively gone.
  return { ...resolveTeamFromDoc(index.doc as Record<string, unknown>, team),
    rawLocationIsString: typeof entry?.registry_location === "string",
    rootIsUsable: typeof entry?.root === "string" && isAbsolute(entry.root) && isDir(entry.root) };
}

/** Positively absent: an absolute stored path whose lstat fails ENOENT. Any other failure
 *  (EACCES, ENOTDIR, a malformed stored value) is unreachable, not stale. The Bash door
 *  classifies with the same ENOENT-only rule. */
function dataGone(path: string, isString: boolean | undefined): boolean {
  if (!isString || !path.startsWith("/")) return false;
  try { lstatSync(path); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}

/** A worktree removed while its team stayed enrolled (tap-xbpuc): the team's own refusal, named. */
function staleEnrollment(team: string, location: string): TapError {
  return new TapError(1, "stale_enrollment", STALE_ENROLLMENT_NEXT,
    `team '${team}' is enrolled but its acting registry file is gone (${location}); the worktree was likely removed before de-enrollment`);
}

export function bindRemoteTeam(team: string, handle: string, indexHome: string | undefined): RemoteTeam {
  const r = resolveThroughMarker(team, indexHome);
  // registry_v20.resolve_team_from_global answers `missing` for an enrolled team
  // with no stored registry_location; the native resolver folds that into
  // `unreachable`. The incumbent's verdict is the one both doors emit.
  const status = r.status === "unreachable" && !r.registryLocation ? "missing" : r.status;
  switch (status) {
    case "historical":
      throw new TapError(1, "historical_team", "tap doctor",
        `team '${team}' is historical — not delivery-addressable (team '${team}' is historical (not delivery-addressable))`);
    case "unreachable":
      if (dataGone(r.registryLocation, r.rawLocationIsString)) throw staleEnrollment(team, r.registryLocation);
      throw new TapError(1, "unreachable_team", "tap doctor",
        `team '${team}' registry_location is unreachable (registry_location unreachable for '${team}' (${r.registryLocation}); tap doctor)`);
    case "invalid":
      // lib.sh:7283-7286 → tap-send.sh:283-285: one fixed sentence, no parser quote.
      throw new TapError(1, "invalid_flip", "tap doctor",
        "registry flip marker is present but invalid — refusing legacy delivery (global-registry.json is present but unreadable or wrong schema; repair migration (tap doctor) — refusing legacy fallback)");
    case "missing":
      throw new TapError(1, "unknown_team", relayFallback(handle),
        `unknown team '${team}' (not in the machine index; known sibling worktrees: <none>). Fallback: ${relayFallback(handle)}`);
    case "ok":
      break;
  }
  if (!r.registryLocation || !isFile(r.registryLocation)) {
    if (dataGone(r.registryLocation, r.rawLocationIsString)) throw staleEnrollment(team, r.registryLocation);
    throw new TapError(1, "unreachable_team", "tap doctor",
      `team '${team}' registry_location is unreachable (stored registry_location missing or unreadable for '${team}')`);
  }
  refuseOldRemoteRegistry(r.registryLocation);
  if (!r.rootIsUsable) throw new TapError(1, "resolution_error", "tap doctor", `cannot resolve enrolled root for team '${team}'`);
  const rootReal = realpathOrSelf(r.root);
  loadRemoteRegistry(r.registryLocation, `${team}/${handle}`);
  try { assertActingRegistryMatches({ team, registryLocation: r.registryLocation, rootReal }); }
  catch (error) {
    if (error instanceof SelectorError) throw new TapError(error.code, error.errorClass, error.action, error.detail);
    throw error;
  }
  const busHome = busHomeForEnrolled(rootReal);
  return { team, handle, rootReal, registryPath: r.registryLocation, busHome };
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

/** A bound recipient registry in an old format refuses as old_store before any
 * seat row is read from it; a missing or unparseable file keeps its existing
 * downstream handling. */
function refuseOldRemoteRegistry(path: string): void {
  const refusal = teamRegistryFileRefusal(path);
  if (refusal) throw new TapError(1, refusal.errorClass, refusal.action, refusal.detail);
}

/**
 * The explicit `--remote-registry <path>` override (send-reply-r2 checkpoint A,
 * U2; tap-send.sh:671-678): the caller pins the recipient's acting registry
 * file, so no machine-index lookup names the team and no marker is sampled.
 * The pinned file must derive its own recipient bus; enrolled addressing
 * instead resolves the bus from the index row's root.
 */
export function bindExplicitRemoteRegistry(team: string, handle: string, registryPath: string): RemoteTeam {
  // The pinned file's format refuses first: an old store is the specific answer, whatever its location.
  refuseOldRemoteRegistry(registryPath);
  const busHome = busHomeForRegistry(registryPath);
  if (!busHome) {
    throw new TapError(1, "resolution_error", "tap doctor", `cannot derive recipient bus from registry '${registryPath}'`);
  }
  return { team, handle, rootReal: teamRootFromBus(busHome), registryPath, busHome };
}

export interface RemoteRow {
  seat: Record<string, unknown>;
  pane: string;
  paneId: string;
}

/** Preserve send's existing refusal for an unreadable or out-of-domain acting store. */
export function loadRemoteRegistry(registryPath: string, originalTo: string): RegistryDoc {
  try {
    return loadRegistry(registryPath);
  } catch {
    throw new TapError(1, "forwarding_unavailable", "tap team; retry with a current recipient",
      `cannot resolve pinned forwarding for '${originalTo}'; no payload was placed`);
  }
}

/**
 * The remote seat row, tap-send.sh:656-733: the verdicts its Python heredoc
 * prints (MISSING / PENDING / LAUNCHING / SUSPENDED / FOUND) and the refusals
 * the case arms raise on them, in the incumbent's order — a poll member is
 * refused before the pane is looked at, an unbound pane_id before its shape.
 */
export function remoteRecipientRow(doc: RegistryDoc, team: string, handle: string, localTeam: string): RemoteRow {
  const seats = seatMap(doc);
  const names = Object.keys(seats).length ? Object.keys(seats).sort().join(", ") : "<none>";
  const raw = Object.hasOwn(seats, handle) ? seats[handle] : undefined;
  const fallback = relayFallback(handle);
  // Python's `if not entry` — an absent, null, or empty row is MISSING.
  const seat = typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.keys(raw).length
    ? raw as Record<string, unknown> : null;
  if (!seat) {
    throw new TapError(1, "not_found", fallback,
      `unknown handle '${handle}' in team '${team}' (registered handles: ${names}). Fallback: ${fallback}`);
  }
  const status = seat.status === undefined ? "active" : String(seat.status);
  if (status === "pending") {
    throw new TapError(1, "seat_pending", `run 'tap register ${handle} --pane <new-tmux-target>' from team '${team}'`,
      `'${handle}' in team '${team}' is still launching; wait for it to register`);
  }
  if (status === "active" && String(seat.status_reason ?? "") === "launching") {
    throw new TapError(1, "seat_launching", "tap team", `'${handle}' in team '${team}' is bound but still launching`);
  }
  if (status === "suspended") {
    const reason = seat.status_reason === undefined ? "" : String(seat.status_reason);
    // The operator's own incapable mark is cleared by re-registration at the
    // mark's home team, so that — and only that — is the advertised way back.
    // The manual relay would deliver around the mark, so this reason never
    // offers it; every other suspended reason keeps the relay fallback.
    if (reason === "incapable") {
      throw new TapError(1, "suspended",
        `have '${handle}' re-register from its pane in team '${team}': 'tap in' there, or 'tap register ${handle} --pane <tmux-target>' from team '${team}'`,
        `handle '${handle}' in team '${team}' is suspended (incapable)`);
    }
    throw new TapError(1, "suspended", fallback,
      `handle '${handle}' in team '${team}' is suspended (${reason || "no reason"}). Fallback: ${fallback}`);
  }
  if (String(seat.delivery || "pane") === "poll") {
    throw new TapError(1, "poll_member_remote", `register '${handle}' as a poll member on this (${localTeam}) team instead`,
      `'${handle}' in team '${team}' is delivery:poll — cross-worktree relay delivers by injection, which a poll member never receives`);
  }
  const pane = seat.pane === undefined ? "" : String(seat.pane);
  // Python prints a non-string value as its own repr (`[]`, `{}`, `None`); the
  // Bash arm then reads a non-empty line as a malformed id. JSON's rendering
  // agrees on the container shapes; `null` is the one it spells differently.
  const paneId = seat.pane_id === undefined ? "" : typeof seat.pane_id === "string" ? seat.pane_id : JSON.stringify(seat.pane_id);
  if (!pane) {
    throw new TapError(1, "not_found", fallback, `handle '${handle}' in team '${team}' has no pane. Fallback: ${fallback}`);
  }
  if (!paneId) {
    throw new TapError(1, "identity_unverified", `run 'tap register ${handle} --pane <tmux-target>' from team '${team}', then retry`,
      `registry row for '${team}/${handle}' has no pane_id; refusing unbound delivery`);
  }
  if (!/^%[0-9]+$/.test(paneId)) {
    throw new TapError(1, "identity_unverified", `target seat '${handle}' must run 'tap in' from team '${team}'`,
      `registry row for '${team}/${handle}' has invalid pane_id '${paneId}'; refusing delivery without changing seat status`);
  }
  return { seat, pane, paneId };
}

/**
 * Whether the SENDER's team resolves through the machine index — the sentinel
 * constructor's `path=` evidence (lib.sh:822-838 asks `tap_authority_context
 * <from_team>`): a cross-team sentinel whose sender team is enrolled needs no
 * pointer, its prefix is the locator. An index that has turned invalid since
 * the caller bound its own team is the constructor's refusal, not a pointer:
 * `die`'s bytes (lib.sh:548), after placement as on the Bash door.
 * Marker-live callers only.
 */
export function senderIndexEvidence(team: string, indexHome: string | undefined): "reachable" | "unreachable" {
  const r = resolveThroughMarker(team, indexHome);
  if (r.status === "invalid") {
    throw new TapError(1, "error", "fix_command",
      `sentinel_render: registry marker is invalid_flip; refusing to render rather than guess whether team '${team}' is reachable`);
  }
  if (r.status !== "ok" || !r.registryLocation || !isFile(r.registryLocation)) return "unreachable";
  return authorityBusHome(r.registryLocation, r.root) ? "reachable" : "unreachable";
}
